//! Optional encoder quality feedback, local to one codec instance.
#[path = "qp/vp8.rs"]
#[cfg(any(target_os = "android", test))]
mod vp8;
use h264_reader::{
    nal::{pps::PicParameterSet, slice::SliceHeader, sps::SeqParameterSet, Nal, RefNal, UnitType},
    Context,
};
#[cfg(any(target_os = "android", test))]
pub(super) use vp8::parse as vp8;

/// Parameter sets follow the encoder instance; QP always belongs to this AU.
#[derive(Default)]
pub(super) struct H264(Context);

impl H264 {
    /// WebRTC's last-slice header QP, not average block QP. Unsupported or
    /// malformed output makes this optional metric unavailable, not media fatal.
    pub fn parse(&mut self, bytes: &[u8]) -> Option<i32> {
        let mut qp = None;
        for bytes in crate::media::h264::nals(bytes).ok()? {
            let nal = RefNal::new(bytes, &[], true);
            let header = nal.header().ok()?;
            match header.nal_unit_type() {
                UnitType::SeqParameterSet => {
                    let sps = SeqParameterSet::from_bits(nal.rbsp_bits()).ok()?;
                    self.0.put_seq_param_set(sps);
                }
                UnitType::PicParameterSet => {
                    let pps = PicParameterSet::from_bits(&self.0, nal.rbsp_bits()).ok()?;
                    self.0.put_pic_param_set(pps);
                }
                UnitType::SliceLayerWithoutPartitioningNonIdr
                | UnitType::SliceLayerWithoutPartitioningIdr => {
                    let (slice, _, pps) =
                        SliceHeader::from_bits(&self.0, &mut nal.rbsp_bits(), header, None).ok()?;
                    let value = 26 + pps.pic_init_qp_minus26 + slice.slice_qp_delta;
                    if !(0..=51).contains(&value) {
                        return None;
                    }
                    qp = Some(value);
                }
                UnitType::SEI
                | UnitType::AccessUnitDelimiter
                | UnitType::FillerData
                | UnitType::EndOfSeq
                | UnitType::EndOfStream
                | UnitType::PrefixNALUnit => {}
                _ => return None,
            }
        }
        qp
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Copyright (c) 2021 The WebRTC project authors. BSD-3-Clause/PATENTS.
    // Original encoded vectors: native/third_party/webrtc-vp8-qp/qp_parser_unittest.cc.
    const H264_QP38: &[u8] = &[
        0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x1e, 0x84, 0x00, 0x00, 0x03, 0x00,
        0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x48, 0x99, 0x20, 0x00, 0x00, 0x00, 0x01, 0x68,
        0xcb, 0x80, 0xc4, 0xb2, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0xf1, 0x18, 0xa0, 0x00, 0x20,
        0x5b, 0x1c, 0x00, 0x04, 0x07, 0xe3, 0x80, 0x00, 0x80, 0xfe,
    ];
    const H264_P: &[u8] = &[0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x39, 0xea];

    #[test]
    fn h264_keeps_parameter_sets_but_never_reuses_another_aus_qp() {
        let mut reader = H264::default();
        assert_eq!(reader.parse(H264_P), None);
        assert_eq!(reader.parse(H264_QP38), Some(38));
        assert_eq!(reader.parse(&[]), None);
        assert_eq!(reader.parse(&[0, 0, 1, 9, 0xf0]), None);
        assert_eq!(reader.parse(H264_P), Some(38));
        assert_eq!(reader.parse(&[0x65]), None);
        assert_eq!(H264::default().parse(H264_P), None);
    }

    #[test]
    fn vp8_reads_upstream_known_qp_without_decoding() {
        let frame = [
            0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00, 0x02, 0x47, 0x08, 0x85,
            0x85, 0x88, 0x85, 0x84, 0x88, 0x0c, 0x82, 0x00, 0x0c, 0x0d, 0x60, 0x00, 0xfe, 0xfc,
            0x5c, 0xd0,
        ];
        assert_eq!(vp8(&frame), Some(25));
        assert_eq!(vp8(&frame[..20]), None);
        assert_eq!(vp8(&[]), None);
    }
}
