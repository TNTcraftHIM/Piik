/*
 * Copyright (c) 2020 The WebRTC project authors. All Rights Reserved.
 * BSD-3-Clause; provenance, LICENSE, PATENTS and AUTHORS are owned by
 * native/third_party/webrtc-adaptation/.
 * Semantic port of the default SendProcessingUsage1 and OveruseFrameDetector
 * at 3710345e71ad3a7c1f4ed4efef152fd4fc24869a. No field-trial estimator2,
 * task queue, codec, resource manager or source restriction implementation.
 */
use std::collections::VecDeque;

const HIGH_USAGE: i32 = 85;
const LOW_USAGE: i32 = (HIGH_USAGE - 1) / 2;
const MIN_SAMPLES: u64 = 120;
const FRAME_TIMEOUT_US: i64 = 1_500_000;
const INITIAL_CHECKS: u64 = 3;
const HIGH_CHECKS: u32 = 2;
const STANDARD_RAMPUP_MS: i64 = 40_000;
const QUICK_RAMPUP_MS: i64 = 10_000;
const MAX_RAMPUP_MS: i64 = 240_000;

/// The owner supplies due checks; these are the unchanged upstream deadlines.
pub const FIRST_CHECK_US: i64 = 100_000;
pub const CHECK_INTERVAL_US: i64 = 5_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UsageSignal {
    Overuse,
    Underuse,
}

struct Filter {
    alpha: f32,
    value: f32,
}
impl Filter {
    fn apply(&mut self, exponent: f32, sample: f32) {
        // ExpFilter uses the original alpha directly for an exponent of one.
        let alpha = if exponent == 1.0 {
            self.alpha
        } else {
            self.alpha.powf(exponent)
        };
        self.value = alpha * self.value + (1.0 - alpha) * sample;
    }
}

struct FrameTiming {
    id: u32,
    started_us: i64,
    completed_us: Option<i64>,
}

struct ProcessingUsage {
    pending: VecDeque<FrameTiming>,
    count: u64,
    last_processed_start_us: Option<i64>,
    max_sample_diff_ms: f32,
    processing_ms: Filter,
    frame_diff_ms: Filter,
}
impl ProcessingUsage {
    fn new() -> Self {
        let initial_usage = (LOW_USAGE + HIGH_USAGE) as f32 / 2.0;
        Self {
            pending: VecDeque::new(),
            count: 0,
            last_processed_start_us: None,
            max_sample_diff_ms: (1000.0 / 30.0) * 1.35,
            processing_ms: Filter {
                alpha: 0.995,
                value: initial_usage * 40.0 / 100.0,
            },
            frame_diff_ms: Filter {
                alpha: 0.998,
                value: 40.0,
            },
        }
    }
    fn started(&mut self, id: u32, now_us: i64, previous_start_us: Option<i64>) {
        if let Some(previous) = previous_start_us {
            let sample_ms = (1e-3_f64 * (now_us - previous) as f64) as f32;
            let exponent = (sample_ms / (1000.0_f32 / 30.0)).min(7.0);
            self.frame_diff_ms.apply(exponent, sample_ms);
        }
        self.pending.push_back(FrameTiming {
            id,
            started_us: now_us,
            completed_us: None,
        });
    }
    fn completed(&mut self, id: u32, now_us: i64) -> Option<i32> {
        if let Some(frame) = self.pending.iter_mut().find(|frame| frame.id == id) {
            frame.completed_us = Some(now_us);
        }
        let mut duration = None;
        // Match the one-second asynchronous/layer observation window. Missing
        // completions expire without inventing a duration or a healthy sample.
        while self
            .pending
            .front()
            .is_some_and(|frame| now_us - frame.started_us >= 1_000_000)
        {
            let frame = self.pending.pop_front().unwrap();
            if let Some(completed) = frame.completed_us {
                let duration_us = (completed - frame.started_us) as i32;
                duration = Some(duration_us);
                if let Some(previous) = self.last_processed_start_us {
                    self.count += 1;
                    // C++ AddSample takes int64 milliseconds, truncating the
                    // double conversion before calculating the filter exponent.
                    let delta_ms = (1e-3_f64 * (frame.started_us - previous) as f64) as i64;
                    let exponent = (delta_ms as f32 / (1000.0_f32 / 30.0)).min(7.0);
                    let processing_ms = (1e-3_f64 * f64::from(duration_us)) as f32;
                    self.processing_ms.apply(exponent, processing_ms);
                }
                self.last_processed_start_us = Some(frame.started_us);
            }
        }
        duration
    }
    fn percent(&self) -> i32 {
        if self.count < MIN_SAMPLES {
            return (((LOW_USAGE + HIGH_USAGE) as f32 / 2.0) + 0.5) as i32;
        }
        let frame_diff = self
            .frame_diff_ms
            .value
            .max(1.0)
            .min(self.max_sample_diff_ms);
        (100.0 * self.processing_ms.value / frame_diff + 0.5) as i32
    }
}

/// One synchronous software encoding owner, dropped with its worker. All inputs use the same monotonic
/// wall-clock microseconds; source PTS is not processing time. No work is spawned.
/// Starts/finishes correspond only to work actually admitted to the encoder.
pub(super) struct EncodeUsage {
    usage: ProcessingUsage,
    percent: Option<i32>,
    process_count: u64,
    last_started_us: Option<i64>,
    pixels: u32,
    target_fps: u32,
    last_overuse_ms: i64,
    checks_above_threshold: u32,
    overuse_detections: u32,
    last_rampup_ms: i64,
    quick_rampup: bool,
    rampup_delay_ms: i64,
}
impl EncodeUsage {
    pub fn new(target_fps: u32) -> Self {
        let mut result = Self {
            usage: ProcessingUsage::new(),
            percent: None,
            process_count: 0,
            last_started_us: None,
            pixels: 0,
            target_fps: 30,
            last_overuse_ms: -1,
            checks_above_threshold: 0,
            overuse_detections: 0,
            last_rampup_ms: -1,
            quick_rampup: false,
            rampup_delay_ms: STANDARD_RAMPUP_MS,
        };
        result.target_frame_rate(target_fps);
        result
    }
    pub fn target_frame_rate(&mut self, fps: u32) {
        self.target_fps = fps.min(30);
        // Upstream intentionally divides integers here (30fps gives33ms).
        self.usage.max_sample_diff_ms = (1000 / self.target_fps.max(7)) as f32 * 1.35;
    }
    pub fn started(&mut self, id: u32, pixels: u32, now_us: i64) {
        if pixels != self.pixels
            || self
                .last_started_us
                .is_some_and(|last| now_us - last > FRAME_TIMEOUT_US)
        {
            self.pixels = pixels;
            self.usage = ProcessingUsage::new();
            self.last_started_us = None;
            self.process_count = 0;
            self.percent = None;
            // Geometry/gap resets samples and initial checks, but preserves
            // target cadence and resource ramp-up history, exactly as ResetAll.
            self.target_frame_rate(self.target_fps);
        }
        self.usage.started(id, now_us, self.last_started_us);
        self.last_started_us = Some(now_us);
    }
    /// Default Usage1 ignores explicit duration and capture timestamp. Pairing
    /// the real admission/completion is essential; those extra arguments are
    /// omitted here rather than pretending they can correct delayed observations.
    pub fn completed(&mut self, id: u32, now_us: i64) {
        if self.usage.completed(id, now_us).is_some() {
            self.percent = Some(self.usage.percent());
        }
    }

    /// Called on a due check by the existing owner. This is the algorithm body,
    /// not a second timer. Replaying checks preserves their actual event order.
    pub fn check(&mut self, now_us: i64) -> Option<UsageSignal> {
        self.process_count += 1;
        if self.process_count <= INITIAL_CHECKS {
            return None;
        }
        let usage = self.percent?;
        let now_ms = now_us / 1000;
        if usage >= HIGH_USAGE {
            self.checks_above_threshold += 1;
        } else {
            self.checks_above_threshold = 0;
        }
        if self.checks_above_threshold >= HIGH_CHECKS {
            if self.last_rampup_ms > self.last_overuse_ms {
                if now_ms - self.last_rampup_ms < STANDARD_RAMPUP_MS || self.overuse_detections > 4
                {
                    self.rampup_delay_ms = (self.rampup_delay_ms * 2).min(MAX_RAMPUP_MS);
                } else {
                    self.rampup_delay_ms = STANDARD_RAMPUP_MS;
                }
            }
            self.last_overuse_ms = now_ms;
            self.quick_rampup = false;
            self.checks_above_threshold = 0;
            self.overuse_detections += 1;
            Some(UsageSignal::Overuse)
        } else {
            let delay = if self.quick_rampup {
                QUICK_RAMPUP_MS
            } else {
                self.rampup_delay_ms
            };
            if now_ms < self.last_rampup_ms + delay || usage >= LOW_USAGE {
                return None;
            }
            self.last_rampup_ms = now_ms;
            self.quick_rampup = true;
            Some(UsageSignal::Underuse)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_successes_match_the_upstream_overuse_and_recovery_trace() {
        // Fixed actual-SDK reference at this file's pin: 100ms work/33ms input,
        // followed by 5ms work at60s. Overlap is intentional; source PTS unused.
        let mut events = Vec::new();
        for id in 0..2_800u32 {
            let start = i64::from(id) * 33_000;
            let finish = start + if start < 60_000_000 { 100_000 } else { 5_000 };
            events.push((start, 0, id));
            events.push((finish, 1, id));
        }
        for check in 0..19 {
            events.push((100_000 + check * 5_000_000, 2, 0));
        }
        events.sort_unstable();
        let mut detector = EncodeUsage::new(30);
        let mut signals = Vec::new();
        for (at, event, id) in events {
            let now = 1_000_000 + at;
            match event {
                0 => detector.started(id, 230_400, now),
                1 => detector.completed(id, now),
                _ => {
                    if let Some(signal) = detector.check(now) {
                        signals.push((at, signal));
                    }
                }
            }
        }
        assert_eq!(signals.first(), Some(&(20_100_000, UsageSignal::Overuse)));
        assert_eq!(
            signals
                .iter()
                .find(|(_, signal)| *signal == UsageSignal::Underuse),
            Some(&(80_100_000, UsageSignal::Underuse))
        );
    }

    #[test]
    fn incomplete_work_is_not_a_success_and_reset_discards_pending_samples() {
        let mut detector = EncodeUsage::new(30);
        detector.started(1, 230_400, 1_000_000);
        detector.completed(999, 2_100_000);
        assert_eq!(detector.percent, None);
        assert!(detector.usage.pending.is_empty());
        detector.started(2, 230_400, 2_200_000);
        detector.started(3, 57_600, 2_300_000);
        detector.completed(2, 2_400_000);
        assert_eq!(detector.percent, None);
        assert_eq!(detector.usage.pending.len(), 1);
        assert_eq!(detector.usage.pending.front().unwrap().id, 3);
        // No spawned work or borrowed callbacks: normal Rust Drop owns retirement.
    }
}
