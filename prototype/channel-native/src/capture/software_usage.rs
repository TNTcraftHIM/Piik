//! Synchronous software worker bridge. No independent scheduler or clock.
use super::{
    adaptation::{Input, QualityPolicy},
    encode_usage::{EncodeUsage, CHECK_INTERVAL_US, FIRST_CHECK_US},
};

pub(super) struct SoftwareUsage {
    detector: EncodeUsage,
    next_check_us: i64,
    next_id: u32,
}
impl SoftwareUsage {
    pub fn new(target_fps: u32, now_us: i64) -> Self {
        Self {
            detector: EncodeUsage::new(target_fps),
            next_check_us: now_us + FIRST_CHECK_US,
            next_id: 0,
        }
    }
    pub fn target_frame_rate(&mut self, fps: u32) {
        self.detector.target_frame_rate(fps);
    }
    fn check_due(&mut self, input: Input, now_us: i64, policy: &mut QualityPolicy) {
        if now_us >= self.next_check_us {
            // One delayed worker check, no synthetic catch-up while output waits.
            self.next_check_us = now_us + CHECK_INTERVAL_US;
            if let Some(signal) = self.detector.check(now_us) {
                policy.report_processing(signal, input);
            }
        }
    }
    pub fn started(&mut self, input: Input, now_us: i64, policy: &mut QualityPolicy) -> u32 {
        self.check_due(input, now_us, policy);
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.detector.started(id, input.pixels, now_us);
        id
    }
    pub fn completed(&mut self, id: u32, input: Input, now_us: i64, policy: &mut QualityPolicy) {
        self.check_due(input, now_us, policy);
        self.detector.completed(id, now_us);
    }
}
