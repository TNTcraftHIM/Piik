/*
 * Copyright (c) 2011 The WebRTC project authors. All Rights Reserved.
 *
 * Rust semantic port of modules/video_coding/utility/frame_dropper.{h,cc}
 * and rtc_base/numerics/exp_filter.{h,cc}, upstream commit
 * 6f37672d358475cd17544121a12494da454d85fb.
 * Sources and licensing: native/third_party/webrtc-frame-dropper/.
 * The always-enabled adapter omits unused reset/enable entry points.
 */

struct ExpFilter {
    alpha: f32,
    filtered: f32,
    max: f32,
}
impl ExpFilter {
    fn new(alpha: f32, max: f32) -> Self {
        Self {
            alpha,
            filtered: -1.0,
            max,
        }
    }
    fn apply(&mut self, exp: f32, sample: f32) -> f32 {
        if self.filtered == -1.0 {
            self.filtered = sample;
        } else if exp == 1.0 {
            self.filtered = self.alpha * self.filtered + (1.0 - self.alpha) * sample;
        } else {
            let alpha = self.alpha.powf(exp);
            self.filtered = alpha * self.filtered + (1.0 - alpha) * sample;
        }
        if self.max != -1.0 && self.filtered > self.max {
            self.filtered = self.max;
        }
        self.filtered
    }
    fn update_base(&mut self, alpha: f32) {
        self.alpha = alpha;
    }
}

pub(super) struct FrameDropper {
    key_frame_ratio: ExpFilter,
    delta_frame_size_avg_kbits: ExpFilter,
    drop_ratio: ExpFilter,
    large_frame_accumulation_spread: f32,
    large_frame_accumulation_count: i32,
    large_frame_accumulation_chunk_size: f32,
    accumulator: f32,
    accumulator_max: f32,
    target_bitrate: f32,
    drop_next: bool,
    drop_count: i32,
    incoming_frame_rate: f32,
    was_below_max: bool,
}
impl FrameDropper {
    pub fn new() -> Self {
        let mut key_frame_ratio = ExpFilter::new(0.99, -1.0);
        key_frame_ratio.apply(1.0, 1.0 / 300.0);
        let mut drop_ratio = ExpFilter::new(0.9, 0.96);
        drop_ratio.apply(0.0, 0.0);
        Self {
            key_frame_ratio,
            delta_frame_size_avg_kbits: ExpFilter::new(0.9, -1.0),
            drop_ratio,
            large_frame_accumulation_spread: 0.5 * 30.0,
            large_frame_accumulation_count: 0,
            large_frame_accumulation_chunk_size: 0.0,
            accumulator: 0.0,
            accumulator_max: 300.0 / 2.0,
            target_bitrate: 300.0,
            drop_next: false,
            drop_count: 0,
            incoming_frame_rate: 30.0,
            was_below_max: true,
        }
    }
    pub fn fill(&mut self, framesize_bytes: usize, delta_frame: bool) {
        let mut framesize_kbits = 8.0 * framesize_bytes as f32 / 1000.0;
        if !delta_frame {
            self.key_frame_ratio.apply(1.0, 1.0);
            // Spread large key frames over subsequent inputs, exactly as upstream.
            if self.large_frame_accumulation_count == 0 {
                self.large_frame_accumulation_count = if self.key_frame_ratio.filtered > 1e-5
                    && 1.0 / self.key_frame_ratio.filtered < self.large_frame_accumulation_spread
                {
                    (1.0 / self.key_frame_ratio.filtered + 0.5) as i32
                } else {
                    (self.large_frame_accumulation_spread + 0.5) as i32
                };
                self.large_frame_accumulation_chunk_size =
                    framesize_kbits / self.large_frame_accumulation_count as f32;
                framesize_kbits = 0.0;
            }
        } else {
            if self.delta_frame_size_avg_kbits.filtered != -1.0
                && framesize_kbits > 3.0 * self.delta_frame_size_avg_kbits.filtered
                && self.large_frame_accumulation_count == 0
            {
                self.large_frame_accumulation_count =
                    (self.large_frame_accumulation_spread + 0.5) as i32;
                self.large_frame_accumulation_chunk_size =
                    framesize_kbits / self.large_frame_accumulation_count as f32;
                framesize_kbits = 0.0;
            } else {
                self.delta_frame_size_avg_kbits.apply(1.0, framesize_kbits);
            }
            self.key_frame_ratio.apply(1.0, 0.0);
        }
        self.accumulator += framesize_kbits;
        self.cap_accumulator();
    }
    pub fn leak(&mut self, input_framerate: u32) {
        if input_framerate < 1 || self.target_bitrate < 0.0 {
            return;
        }
        self.large_frame_accumulation_spread = (0.5 * input_framerate as f32).max(5.0);
        let mut expected_bits_per_frame = self.target_bitrate / input_framerate as f32;
        if self.large_frame_accumulation_count > 0 {
            expected_bits_per_frame -= self.large_frame_accumulation_chunk_size;
            self.large_frame_accumulation_count -= 1;
        }
        self.accumulator -= expected_bits_per_frame;
        if self.accumulator < 0.0 {
            self.accumulator = 0.0;
        }
        self.update_ratio();
    }
    fn update_ratio(&mut self) {
        self.drop_ratio
            .update_base(if self.accumulator > 1.3 * self.accumulator_max {
                0.8
            } else {
                0.9
            });
        if self.accumulator > self.accumulator_max {
            if self.was_below_max {
                self.drop_next = true;
            }
            self.drop_ratio.apply(1.0, 1.0);
            self.drop_ratio.update_base(0.9);
        } else {
            self.drop_ratio.apply(1.0, 0.0);
        }
        self.was_below_max = self.accumulator < self.accumulator_max;
    }
    pub fn drop_frame(&mut self) -> bool {
        if self.drop_next {
            self.drop_next = false;
            self.drop_count = 0;
        }
        if self.drop_ratio.filtered >= 0.5 {
            let denom = (1.0 - self.drop_ratio.filtered).max(1e-5);
            let mut limit = (1.0 / denom - 1.0 + 0.5) as i32;
            let max_limit = (self.incoming_frame_rate * 4.0) as i32;
            if limit > max_limit {
                limit = max_limit;
            }
            if self.drop_count < 0 {
                self.drop_count = -self.drop_count;
            }
            if self.drop_count < limit {
                self.drop_count += 1;
                return true;
            } else {
                self.drop_count = 0;
                return false;
            }
        } else if self.drop_ratio.filtered > 0.0 && self.drop_ratio.filtered < 0.5 {
            let denom = self.drop_ratio.filtered.max(1e-5);
            let limit = -((1.0 / denom - 1.0 + 0.5) as i32);
            if self.drop_count > 0 {
                self.drop_count = -self.drop_count;
            }
            if self.drop_count > limit {
                if self.drop_count == 0 {
                    self.drop_count -= 1;
                    return true;
                } else {
                    self.drop_count -= 1;
                    return false;
                }
            } else {
                self.drop_count = 0;
                return false;
            }
        }
        self.drop_count = 0;
        false
    }
    // Upstream API takes kbps, not bits/sec.
    pub fn set_rates(&mut self, bitrate: f32, incoming_frame_rate: f32) {
        self.accumulator_max = bitrate * 0.5;
        if self.target_bitrate > 0.0
            && bitrate < self.target_bitrate
            && self.accumulator > self.accumulator_max
        {
            self.accumulator = bitrate / self.target_bitrate * self.accumulator;
        }
        self.target_bitrate = bitrate;
        self.cap_accumulator();
        self.incoming_frame_rate = incoming_frame_rate;
    }
    fn cap_accumulator(&mut self) {
        let max_accumulator = self.target_bitrate * 3.0;
        if self.accumulator > max_accumulator {
            self.accumulator = max_accumulator;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Port of upstream TrafficVolumeAboveAvailableBandwidth, with one recovery
    // phase to check that input admission does not remain suppressed afterward.
    #[test]
    fn upstream_drop_and_recovery_at_actual_input_rate() {
        let mut dropper = FrameDropper::new();
        dropper.set_rates(300.0, 30.0);
        let mut bytes = 0usize;
        let delta = ((1000.0 / 8.0 * 700.0 - 25000.0) / 29.0) as usize;
        for _ in 0..1000 {
            for frame in 0..30 {
                if !dropper.drop_frame() {
                    let size = if frame == 0 { 25000 } else { delta };
                    dropper.fill(size, frame != 0);
                    bytes += size;
                }
                dropper.leak(30);
            }
        }
        let bps = bytes as f64 * 8.0 / 1000.0;
        assert!(((bps / 300000.0 - 1.0) * 100.0).abs() <= 0.1, "{bps}");
        dropper.set_rates(1500.0, 30.0);
        let mut dropped = 0;
        for frame in 0..300 {
            dropper.leak(30);
            if dropper.drop_frame() {
                if frame >= 150 {
                    dropped += 1;
                }
            } else {
                dropper.fill(1250, true);
            }
        }
        assert_eq!(dropped, 0, "recovers after the target exceeds source rate");
    }
}
