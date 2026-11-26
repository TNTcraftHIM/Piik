//! NAL boundaries in one complete H264 Annex B access unit.
use anyhow::{ensure, Context, Result};
use h264_reader::{
    nal::{
        pps::PicParamSetId,
        sps::{ChromaFormat, ChromaInfo, SeqParamSetId},
        Nal, RefNal,
    },
    rbsp::BitRead,
};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct ParameterSets {
    pub(super) external_input: bool,
    sequences: BTreeMap<u8, Vec<u8>>,
    pictures: BTreeMap<u8, (u8, Vec<u8>)>,
    emitted_pps: Option<u8>,
}

pub(crate) fn is_8bit_420(chroma: &ChromaInfo) -> bool {
    chroma.chroma_format == ChromaFormat::YUV420
        && chroma.bit_depth_luma_minus8 == 0
        && chroma.bit_depth_chroma_minus8 == 0
}

pub(super) enum Picture {
    Configuration,
    Dependent,
    MissingParameters,
    Independent(super::RtpCodec),
}

fn slice_pps(nal: &[u8]) -> Option<u8> {
    let mut bits = RefNal::new(nal, &[], true).rbsp_bits();
    bits.read_ue("first_mb_in_slice").ok()?;
    bits.read_ue("slice_type").ok()?;
    pps_id(&mut bits)
}

fn pps_id(bits: &mut impl BitRead) -> Option<u8> {
    PicParamSetId::from_u32(bits.read_ue("pic_parameter_set_id").ok()?)
        .ok()
        .map(PicParamSetId::id)
}

fn sps_id(bits: &mut impl BitRead) -> Option<u8> {
    SeqParamSetId::from_u32(bits.read_ue("seq_parameter_set_id").ok()?)
        .ok()
        .map(SeqParamSetId::id)
}

impl ParameterSets {
    /// An IDR activates its referenced PPS/SPS. Other IDs can arrive in advance.
    pub fn picture(&mut self, bytes: &mut Vec<u8>, sps: &mut super::H264Sps) -> Result<Picture> {
        let mut units = nals(bytes)?;
        let mut inline_sps = None;
        let mut inline_pps = None;
        let first = loop {
            let Some(nal) = units.next() else {
                return Ok(Picture::Configuration);
            };
            let mut bits = RefNal::new(nal, &[], true).rbsp_bits();
            match nal[0] & 31 {
                7 => {
                    sps.check(&nal[1..])?;
                    bits.skip(24, "profile_constraints_level")
                        .ok()
                        .context("truncated H264 SPS header")?;
                    let id = sps_id(&mut bits).context("invalid H264 SPS ID")?;
                    if self.external_input {
                        let chroma =
                            ChromaInfo::read(&mut bits, nal[1].into()).map_err(|error| {
                                anyhow::anyhow!("invalid external H264 SPS: {error:?}")
                            })?;
                        if !is_8bit_420(&chroma) {
                            return Err(
                                super::UnsupportedH264Format([nal[1], nal[2], nal[3]]).into()
                            );
                        }
                    }
                    self.sequences.insert(id, nal.to_vec());
                    inline_sps = Some(id);
                    inline_pps = None;
                }
                8 => {
                    let id = pps_id(&mut bits).context("invalid H264 PPS ID")?;
                    let seq = sps_id(&mut bits).context("invalid H264 PPS sequence ID")?;
                    self.pictures.insert(id, (seq, nal.to_vec()));
                    inline_pps = Some(id);
                }
                1 | 5 => break nal,
                2..=4 => return Ok(Picture::MissingParameters),
                _ => continue,
            }
            self.emitted_pps = None;
            let size = self.sequences.values().map(Vec::len).sum::<usize>()
                + self
                    .pictures
                    .values()
                    .map(|(_, bytes)| bytes.len())
                    .sum::<usize>();
            ensure!(
                size <= super::MAX_AU,
                "H264 parameter sets exceed Native media limit"
            );
        };
        let Some(id) = slice_pps(first) else {
            return Ok(Picture::MissingParameters);
        };
        let kind = first[0] & 31;
        if units.any(|nal| match nal[0] & 31 {
            1..=5 => nal[0] & 31 != kind || slice_pps(nal) != Some(id),
            _ => false,
        }) {
            return Ok(Picture::MissingParameters);
        }
        drop(units);
        let Some((seq, pps)) = self.pictures.get(&id) else {
            return Ok(Picture::MissingParameters);
        };
        let Some(sequence) = self.sequences.get(seq) else {
            return Ok(Picture::MissingParameters);
        };
        let independent = kind == 5;
        if (independent || self.emitted_pps != Some(id))
            && (inline_sps != Some(*seq) || inline_pps != Some(id))
        {
            // Immediately before the slice so the RTP payloader's pending pair
            // also belongs to this picture when future IDs were sent in-band.
            let at = first.as_ptr() as usize - bytes.as_ptr() as usize;
            let extra = sequence.len() + pps.len() + 8;
            ensure!(
                bytes.len() + extra <= super::MAX_AU,
                "H264 access unit exceeds Native media limit"
            );
            let mut framed = Vec::with_capacity(bytes.len() + extra);
            framed.extend_from_slice(&bytes[..at]);
            framed.extend_from_slice(sequence);
            framed.extend_from_slice(&[0, 0, 0, 1]);
            framed.extend_from_slice(pps);
            framed.extend_from_slice(&[0, 0, 0, 1]);
            framed.extend_from_slice(&bytes[at..]);
            *bytes = framed;
        }
        self.emitted_pps = Some(id);
        if independent {
            sps.check(&sequence[1..])?;
            return Ok(Picture::Independent(sps.codec().expect("checked SPS")));
        }
        Ok(Picture::Dependent)
    }
}

pub(crate) fn nals(bytes: &[u8]) -> Result<impl Iterator<Item = &[u8]>> {
    let mut remaining = if bytes.is_empty() {
        bytes
    } else {
        let (start, end) =
            delimiter(bytes).ok_or_else(|| anyhow::anyhow!("missing H264 Annex B delimiter"))?;
        ensure!(start == 0, "data precedes H264 Annex B delimiter");
        &bytes[end..]
    };
    Ok(std::iter::from_fn(move || {
        while !remaining.is_empty() {
            let (end, next) = delimiter(remaining).unwrap_or((remaining.len(), remaining.len()));
            let nal = &remaining[..end];
            remaining = &remaining[next..];
            // Annex B trailing_zero_8bits are outside the NAL unit.
            let end = nal
                .iter()
                .rposition(|byte| *byte != 0)
                .map_or(0, |at| at + 1);
            if end > 0 {
                return Some(&nal[..end]);
            }
        }
        None
    }))
}

fn delimiter(bytes: &[u8]) -> Option<(usize, usize)> {
    let at = bytes.windows(3).position(|prefix| prefix == [0, 0, 1])?;
    let mut start = at;
    while start > 0 && bytes[start - 1] == 0 {
        start -= 1;
    }
    Some((start, at + 3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_sps_replacement_rechecks_chroma_with_the_same_profile_level_and_id() -> Result<()> {
        // libx264, 16x16 black IDRs, 8-bit High 3.1, SPS and PPS ID 0.
        let mut color = vec![
            0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x5e, 0xc0, 0x44, 0x00,
            0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0x08, 0x3c, 0x60, 0xc6, 0x58, 0x00,
            0x00, 0x00, 0x01, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0, 0x00, 0x00, 0x01, 0x65, 0x88,
            0x84, 0x00, 0x15, 0xff, 0xfe, 0xf7, 0xc9, 0xef, 0xc0, 0xa6, 0xeb, 0xdb, 0xdf, 0x81,
        ];
        let mut mono = vec![
            0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f, 0xf3, 0x65, 0x7b, 0x01, 0x6c, 0x80,
            0x00, 0x00, 0x03, 0x00, 0x80, 0x00, 0x00, 0x03, 0x01, 0x07, 0x8c, 0x18, 0xcb, 0x00,
            0x00, 0x00, 0x01, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0, 0x00, 0x00, 0x01, 0x65, 0x88,
            0x84, 0x00, 0x15, 0xff, 0xfe, 0xf7, 0xad, 0xfe, 0x65, 0x97, 0x61, 0x0f, 0x0d,
        ];
        let mut sets = ParameterSets {
            external_input: true,
            ..Default::default()
        };
        let mut sps = super::super::H264Sps::default();
        assert!(matches!(
            sets.picture(&mut color, &mut sps)?,
            Picture::Independent(_)
        ));
        let result = sets.picture(&mut mono, &mut sps);
        let error = result.err().context("monochrome source accepted")?;
        assert_eq!(
            error
                .downcast_ref::<super::super::UnsupportedH264Format>()
                .unwrap()
                .0,
            [100, 0, 31]
        );
        Ok(())
    }

    #[test]
    fn idr_selects_its_parameter_sets_after_another_pair_is_announced() -> Result<()> {
        let first = [0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xd9, 0, 0, 1, 0x68, 0xcb];
        let future = [0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x56, 0, 0, 1, 0x68, 0x48];
        let idr = [0, 0, 1, 0x65, 0x88, 0x84];
        let mut sets = ParameterSets::default();
        let mut sps = super::super::H264Sps::default();
        let mut au = [future.as_slice(), &idr].concat();
        assert!(matches!(
            sets.picture(&mut au, &mut sps)?,
            Picture::MissingParameters
        ));
        sets.picture(&mut first.to_vec(), &mut sps)?;
        assert!(matches!(
            sets.picture(&mut au, &mut sps)?,
            Picture::Independent(_)
        ));
        let output: Vec<_> = nals(&au)?.collect();
        let expected: Vec<_> = nals(&first)?.collect();
        assert_eq!(&output[output.len() - 3..output.len() - 1], expected);
        Ok(())
    }

    #[test]
    fn complete_au_keeps_sei_and_escaped_payload_between_borrowed_nals() -> Result<()> {
        let bytes = [
            0, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x06, 0x05, 0, 0, 3, 1, 0, 0, 0, 1,
            0x65, 0x80, 0, 0,
        ];
        assert_eq!(
            nals(&bytes)?.collect::<Vec<_>>(),
            [
                &[0x67, 0x42, 0xe0, 0x1f][..],
                &[0x06, 0x05, 0, 0, 3, 1][..],
                &[0x65, 0x80][..],
            ]
        );
        Ok(())
    }

    #[test]
    fn empty_units_are_skipped_but_unframed_data_is_rejected() -> Result<()> {
        for bytes in [&[][..], &[0, 0, 1][..], &[0, 0, 0, 1][..]] {
            assert!(nals(bytes)?.next().is_none());
        }
        assert_eq!(
            nals(&[0, 0, 1, 0, 0, 0, 1, 0x68, 0x80, 0, 0, 1])?.collect::<Vec<_>>(),
            [&[0x68, 0x80][..]]
        );
        for bytes in [&[0x65, 0x80][..], &[9, 0, 0, 1, 0x65][..], &[0, 0, 0][..]] {
            assert!(nals(bytes).is_err());
        }
        Ok(())
    }
}
