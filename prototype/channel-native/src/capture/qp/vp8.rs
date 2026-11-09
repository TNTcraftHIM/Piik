/*
 * Copyright (c) 2015 The WebRTC project authors. All Rights Reserved.
 * Rust semantic port of modules/video_coding/utility/vp8_header_parser.cc,
 * commit 3710345e71ad3a7c1f4ed4efef152fd4fc24869a.
 * BSD-3-Clause, with PATENTS grant; source and attribution are retained in
 * native/third_party/webrtc-vp8-qp/. This reads base QP only, not slice data.
 */

struct BoolReader<'a> {
    bytes: &'a [u8],
    at: usize,
    value: u32,
    range: u32,
    bits: u32,
}

impl<'a> BoolReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        let mut reader = Self {
            bytes,
            at: 0,
            value: 0,
            range: 255,
            bits: 0,
        };
        for _ in 0..2 {
            reader.value <<= 8;
            if let Some(byte) = reader.bytes.get(reader.at) {
                reader.value |= u32::from(*byte);
                reader.at += 1;
            }
        }
        reader
    }

    fn bit(&mut self) -> u32 {
        let split = 1 + (((self.range - 1) * 128) >> 8);
        let bit = u32::from(self.value >= split << 8);
        if bit != 0 {
            self.range -= split;
            self.value -= split << 8;
        } else {
            self.range = split;
        }
        while self.range < 128 {
            self.value = self.value.wrapping_shl(1);
            self.range <<= 1;
            self.bits += 1;
            if self.bits == 8 {
                self.bits = 0;
                if let Some(byte) = self.bytes.get(self.at) {
                    self.value |= u32::from(*byte);
                    self.at += 1;
                }
            }
        }
        bit
    }

    fn value(&mut self, bits: u32) -> u32 {
        let mut value = 0;
        for _ in 0..bits {
            value = (value << 1) | self.bit();
        }
        value
    }

    fn signed_value(&mut self, bits: u32) {
        // The values are skipped, but their magnitude and sign bits are read.
        self.value(bits);
        self.bit();
    }
}

/// VP8 base quantizer 0..127, the scale used by WebRTC's VP8 QualityScaler.
pub(crate) fn parse(bytes: &[u8]) -> Option<i32> {
    let tag = bytes.get(..3)?;
    let tag = u32::from(tag[0]) | u32::from(tag[1]) << 8 | u32::from(tag[2]) << 16;
    let keyframe = tag & 1 == 0;
    let header = if keyframe { 10 } else { 3 };
    let mut reader = BoolReader::new(bytes.get(header..header + (tag >> 5) as usize)?);
    if keyframe {
        reader.value(2); // Color space and pixel type.
    }
    if reader.bit() != 0 {
        // Segmentation header.
        let update_map = reader.bit();
        if reader.bit() != 0 {
            reader.bit(); // Segment feature mode.
            for _ in 0..4 {
                if reader.bit() != 0 {
                    reader.signed_value(7);
                }
            }
            for _ in 0..4 {
                if reader.bit() != 0 {
                    reader.signed_value(6);
                }
            }
        }
        if update_map != 0 {
            for _ in 0..3 {
                if reader.bit() != 0 {
                    reader.value(8);
                }
            }
        }
    }
    reader.value(1); // Filter type.
    reader.value(6); // Loop filter level.
    reader.value(3); // Sharpness level.
    if reader.bit() != 0 && reader.bit() != 0 {
        for _ in 0..8 {
            // Four reference and four mode loop-filter deltas.
            if reader.bit() != 0 {
                reader.signed_value(6);
            }
        }
    }
    reader.value(2); // log2_nbr_of_dct_partitions.
    let qp = reader.value(7);
    (reader.at != reader.bytes.len()).then_some(qp as i32)
}
