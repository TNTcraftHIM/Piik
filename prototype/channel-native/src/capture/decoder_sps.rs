//! SPS storage admission for one desktop decoder lifetime.
use anyhow::{anyhow, ensure, Result};
use h264_reader::nal::{
    sps::{FrameMbsFlags, Level, SeqParameterSet},
    Nal, RefNal,
};

const MAX_CODED_AXIS_PIXELS: u64 = 8192;
const MAX_DPB_FRAMES: u32 = 16;

#[derive(Default)]
pub(super) struct DecoderSps {
    last_accepted: Option<Vec<u8>>,
}

impl DecoderSps {
    pub(super) fn admit(&mut self, bytes: &[u8]) -> Result<()> {
        for nal in crate::media::h264::nals(bytes)? {
            if nal[0] & 31 != 7 || self.last_accepted.as_deref() == Some(nal) {
                continue;
            }
            let sps = SeqParameterSet::from_bits(RefNal::new(nal, &[], true).rbsp_bits())
                .map_err(|e| anyhow!("invalid decoder H264 SPS: {e:?}"))?;
            ensure!(
                crate::media::h264::is_8bit_420(&sps.chroma_info),
                "H264 decoder requires 8-bit 4:2:0"
            );
            let width = u64::from(sps.pic_width_in_mbs());
            let fields = if matches!(sps.frame_mbs_flags, FrameMbsFlags::Frames) {
                1
            } else {
                2
            };
            let height = u64::from(sps.pic_height_in_map_units()) * fields;
            let limits = Level::L5_2.limits().unwrap();
            ensure!(
                width.max(height) * 16 <= MAX_CODED_AXIS_PIXELS
                    && width * height <= u64::from(limits.max_fs),
                "H264 coded picture exceeds decoder storage limit"
            );
            let (visible_width, visible_height) = sps
                .pixel_dimensions()
                .map_err(|e| anyhow!("invalid H264 decoder crop: {e:?}"))?;
            ensure!(
                visible_width > 0 && visible_height > 0,
                "empty H264 decoder crop"
            );
            let buffered = sps
                .vui_parameters
                .as_ref()
                .and_then(|vui| vui.bitstream_restrictions.as_ref())
                .map_or(0, |limits| limits.max_dec_frame_buffering)
                .max(sps.max_num_ref_frames)
                .max(1);
            // h264-reader also checks VUI reorder <= max_dec_frame_buffering.
            ensure!(
                buffered <= MAX_DPB_FRAMES
                    && width * height * u64::from(buffered) <= u64::from(limits.max_dpb_mbs),
                "H264 reference pictures exceed decoder storage limit"
            );
            self.last_accepted = Some(nal.to_vec());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_padded_picture_and_rechecks_replaced_sps_before_submission() -> Result<()> {
        // Maintenance-line conformance fixtures. Exercise only the parser.
        let padded = [
            0, 0, 1, 0x67, 0x42, 0xc0, 0x33, 0xda, 0x01, 0xe0, 0x08, 0x9f, 0x95,
        ];
        let four_k = [
            0, 0, 1, 0x67, 0x42, 0xc0, 0x33, 0xf3, 0x00, 0x78, 0x00, 0x87, 0xc8,
        ];
        let mut decoder = DecoderSps::default();
        decoder.admit(&padded)?;
        decoder.admit(&four_k)?;
        decoder.admit(&four_k)?;
        let mut over_budget = four_k;
        over_budget[8] = 0x80;
        let picture = [0, 0, 1, 0x65, 0x88, 0x84];
        let au = [four_k.as_slice(), &picture, &over_budget].concat();
        assert!(decoder
            .admit(&au)
            .unwrap_err()
            .to_string()
            .contains("reference pictures"));
        assert_eq!(decoder.last_accepted.as_deref(), Some(&four_k[3..]));
        Ok(())
    }

    #[test]
    fn rejects_out_of_bounds_coded_picture_and_crop() {
        let cropped_storage = [
            0, 0, 1, 0x67, 0x42, 0xc0, 0x34, 0xda, 0, 0xf0, 1, 0xe1, 0xf8, 3, 0x49, 0x40,
        ];
        let invalid_crop = [
            0, 0, 1, 0x67, 0x42, 0xc0, 0x33, 0xda, 0x0a, 0x37, 0xe0, 0, 0, 3, 0, 0x10, 0, 0, 3, 0,
            4,
        ];
        for sps in [cropped_storage.as_slice(), &invalid_crop] {
            assert!(DecoderSps::default().admit(sps).is_err());
        }
    }
}
