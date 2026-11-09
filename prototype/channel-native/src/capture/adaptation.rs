/*
 * Copyright (c) 2011, 2014, 2018, 2019, 2020 The WebRTC project authors.
 * All Rights Reserved.
 *
 * Rust semantic port of QualityScaler, VideoStreamAdapter and the default
 * BalancedDegradationSettings at 3710345e71ad3a7c1f4ed4efef152fd4fc24869a.
 * Sources, scope and BSD licensing: native/third_party/webrtc-adaptation/.
 */
use super::{DegradationPreference as Mode, Settings, VideoCodec as Codec};

const MIN_PIXELS: u32 = 320 * 180;
const SAMPLE_WINDOW: usize = 150;
const MIN_SAMPLES: usize = 60;
const SAMPLE_PERIOD_MS: u64 = 2_000;
const DROP_PERCENT_THRESHOLD: u32 = 60;
const UNLIMITED: u32 = i32::MAX as u32;

// Exact BalancedDegradationSettings::DefaultConfigs, not Piik quality tiers.
// Codec-specific QP/FPS and bitrate overrides are unset in those defaults.
const BALANCED: [(u32, u32, Option<i32>); 3] = [
    (320 * 240, 7, None),
    (480 * 360, 10, Some(1)),
    (640 * 480, 15, Some(1)),
];

fn balanced_min_fps(pixels: u32) -> u32 {
    BALANCED
        .iter()
        .find(|row| pixels <= row.0)
        .map_or(UNLIMITED, |row| row.1)
}

fn balanced_max_fps(pixels: u32) -> u32 {
    BALANCED
        .windows(2)
        .find(|rows| pixels <= rows[0].0)
        .map_or(UNLIMITED, |rows| rows[1].1)
}

fn balanced_min_fps_diff(pixels: u32) -> Option<i32> {
    BALANCED
        .iter()
        .find(|row| pixels <= row.0)
        .and_then(|row| row.2)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QpUsage {
    InsufficientSamples,
    Normal,
    High,
    Low,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdaptationStatus {
    Valid,
    LimitReached,
    AwaitingPreviousAdaptation,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Input {
    /// Actual per-encoding input dimensions after applying the source restriction.
    pub pixels: u32,
    /// Actual input cadence after source adaptation, before media-optimization drops.
    /// Zero represents initially unknown cadence. Never substitute a decoder hint.
    pub fps: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Restrictions {
    pub max_pixels: Option<u32>,
    pub target_pixels: Option<u32>,
    pub max_fps: Option<u32>,
}

impl Restrictions {
    /// Source format FPS is a nominal hint; only an explicit request is a cap.
    pub fn frame_rate_limit(self, requested_max: Option<u32>) -> Option<u32> {
        match (requested_max, self.max_fps) {
            (Some(requested), Some(limit)) => Some(requested.min(limit)),
            (requested, limit) => requested.or(limit),
        }
    }

    /// `settings` already fits the natural source and requested spatial ceiling.
    pub fn apply(self, settings: Settings, requested_max: Option<u32>) -> Settings {
        let pixels = u64::from(settings.width) * u64::from(settings.height);
        let wanted = self
            .target_pixels
            .or(self.max_pixels)
            .map(u64::from)
            .unwrap_or(pixels);
        let scale = (wanted as f64 / pixels as f64).sqrt().min(1.0);
        Settings {
            width: ((settings.width as f64 * scale) as u32 & !1).max(2),
            height: ((settings.height as f64 * scale) as u32 & !1).max(2),
            // This remains the codec's nominal rate. Source admission uses
            // frame_rate_limit separately, including caps above this hint.
            fps: self
                .frame_rate_limit(requested_max)
                .map_or(settings.fps, |cap| settings.fps.min(cap)),
            ..settings
        }
    }
}

#[cfg(test)]
#[path = "adaptation_tests.rs"]
mod tests;

struct QpSmoother {
    alpha: f32,
    last_sample_ms: u64,
    filtered: Option<f32>,
}

impl QpSmoother {
    fn new(alpha: f32) -> Self {
        Self {
            alpha,
            last_sample_ms: 0,
            filtered: None,
        }
    }

    fn add(&mut self, qp: i32, time_sent_us: u64) {
        let now_ms = time_sent_us / 1_000;
        let sample = qp as f32;
        self.filtered = Some(match self.filtered {
            None => sample,
            Some(filtered) => {
                let exponent = (now_ms - self.last_sample_ms) as f32;
                let alpha = if exponent == 1.0 {
                    self.alpha
                } else {
                    self.alpha.powf(exponent)
                };
                alpha * filtered + (1.0 - alpha) * sample
            }
        });
        self.last_sample_ms = now_ms;
    }

    fn average(&self) -> Option<i32> {
        self.filtered.map(|value| value as i32)
    }

    fn reset(&mut self) {
        self.filtered = None;
    }
}

struct DropWindow {
    samples: [u8; SAMPLE_WINDOW],
    count: usize,
    cursor: usize,
    sum: u32,
}

impl DropWindow {
    fn new() -> Self {
        Self {
            samples: [0; SAMPLE_WINDOW],
            count: 0,
            cursor: 0,
            sum: 0,
        }
    }

    fn add(&mut self, sample: u8) {
        self.sum -= u32::from(self.samples[self.cursor]);
        self.samples[self.cursor] = sample;
        self.sum += u32::from(sample);
        self.cursor = (self.cursor + 1) % SAMPLE_WINDOW;
        self.count = (self.count + 1).min(SAMPLE_WINDOW);
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

#[derive(Clone, Copy, Default)]
struct Adaptation {
    restrictions: Restrictions,
    resolution_adaptations: u32,
    fps_adaptations: u32,
}

/// One policy belongs to one encoding with trusted codec QP when present.
/// MaintainResolution disables this quality resource, as in the upstream manager;
/// detail keeps its existing FrameDropper. Retire the policy with its worker.
/// Calls are serialized by the worker; all timestamps share a monotonic epoch.
pub(super) struct QualityPolicy {
    codec: Codec,
    mode: Mode,
    qp_high: QpSmoother,
    qp_low: QpSmoother,
    drops: DropWindow,
    fast_rampup: bool,
    next_check_ms: u64,
    adaptation: Adaptation,
    // Like upstream, the wait is directional: reversing an adaptation is allowed.
    awaiting_size: Option<(bool, u32)>,
}

impl QualityPolicy {
    pub fn new(codec: Codec, mode: Mode, start_ms: u64) -> Self {
        Self {
            codec,
            mode,
            qp_high: QpSmoother::new(0.9995),
            qp_low: QpSmoother::new(0.9999),
            drops: DropWindow::new(),
            fast_rampup: true,
            next_check_ms: start_ms + SAMPLE_PERIOD_MS,
            adaptation: Adaptation::default(),
            awaiting_size: None,
        }
    }

    /// Matches QualityScalerResource::OnEncodeCompleted: unavailable QP does
    /// not create a sample or reuse the preceding frame's QP. VP8 uses its
    /// internal 0..127 quantizer; H264 uses the 0..51 slice-QP scale.
    pub fn report_encoded(&mut self, qp: Option<i32>, time_sent_us: u64) {
        let Some(qp) = qp.filter(|qp| *qp >= 0) else {
            return;
        };
        if self.mode == Mode::MaintainResolution {
            return;
        }
        self.drops.add(0);
        self.qp_high.add(qp, time_sent_us);
        self.qp_low.add(qp, time_sent_us);
    }

    pub fn report_drop(&mut self) {
        if self.mode == Mode::MaintainResolution {
            return;
        }
        // The pinned non-iOS default sets use_all_drop_reasons=true.
        self.drops.add(100);
    }

    pub fn restrictions(&self) -> Restrictions {
        self.adaptation.restrictions
    }

    /// Perform one due check, then schedule relative to this call's time, as a
    /// delayed TaskQueue callback would. No catch-up checks are synthesized.
    /// The worker applies the resulting restriction before its next input; pass the
    /// actual applied input size on later ticks, not the requested target size.
    pub fn tick(&mut self, now_ms: u64, input: Input) {
        if self.mode == Mode::MaintainResolution || now_ms < self.next_check_ms {
            return;
        }
        let usage = self.check_qp();
        match usage {
            QpUsage::High | QpUsage::Low => {
                if usage == QpUsage::High {
                    self.fast_rampup = false;
                }
                self.adapt(usage, input);
                // Upstream clears after reporting usage even if adaptation is blocked.
                self.drops.reset();
                self.qp_high.reset();
                self.qp_low.reset();
            }
            _ => {}
        };
        let delay = if self.fast_rampup {
            SAMPLE_PERIOD_MS
        } else if usage == QpUsage::InsufficientSamples {
            SAMPLE_PERIOD_MS / 2
        } else {
            SAMPLE_PERIOD_MS * 5 / 2
        };
        self.next_check_ms = now_ms + delay;
    }

    fn check_qp(&self) -> QpUsage {
        if self.drops.count < MIN_SAMPLES {
            return QpUsage::InsufficientSamples;
        }
        if self.drops.sum / self.drops.count as u32 >= DROP_PERCENT_THRESHOLD {
            return QpUsage::High;
        }
        if let (Some(high), Some(low)) = (self.qp_high.average(), self.qp_low.average()) {
            let (low_threshold, high_threshold) = match self.codec {
                Codec::Vp8 => (29, 95),
                Codec::H264 => (24, 37),
            };
            if high > high_threshold {
                return QpUsage::High;
            }
            if low <= low_threshold {
                return QpUsage::Low;
            }
        }
        QpUsage::Normal
    }

    fn adapt(&mut self, usage: QpUsage, input: Input) -> AdaptationStatus {
        let increasing = usage == QpUsage::Low;
        if let Some((awaiting_increase, previous_pixels)) = self
            .awaiting_size
            .filter(|_| self.mode == Mode::MaintainFramerate)
        {
            if increasing == awaiting_increase
                && if increasing {
                    input.pixels <= previous_pixels
                } else {
                    input.pixels >= previous_pixels
                }
            {
                return AdaptationStatus::AwaitingPreviousAdaptation;
            }
        }

        let step = if increasing {
            self.up(input, self.adaptation)
        } else {
            self.down(input, self.adaptation).and_then(|next| {
                // AdaptIfFpsDiffInsufficient retries once from the proposed state.
                // If the second step fails, upstream discards the first proposal.
                if self.mode == Mode::Balanced
                    && next.fps_adaptations > self.adaptation.fps_adaptations
                    && input.fps > 0
                    && balanced_min_fps_diff(input.pixels).is_some_and(|minimum| {
                        i64::from(input.fps) - i64::from(next.restrictions.max_fps.unwrap())
                            < i64::from(minimum)
                    })
                {
                    self.down(input, next)
                } else {
                    Ok(next)
                }
            })
        };
        let next = match step {
            Ok(next) => next,
            Err(status) => return status,
        };
        let old_pixels = self.adaptation.restrictions.max_pixels.unwrap_or(UNLIMITED);
        let new_pixels = next.restrictions.max_pixels.unwrap_or(UNLIMITED);
        self.awaiting_size = match new_pixels.cmp(&old_pixels) {
            std::cmp::Ordering::Greater => Some((true, input.pixels)),
            std::cmp::Ordering::Less => Some((false, input.pixels)),
            std::cmp::Ordering::Equal => None,
        };
        self.adaptation = next;
        AdaptationStatus::Valid
    }

    fn down(&self, input: Input, mut state: Adaptation) -> Result<Adaptation, AdaptationStatus> {
        if self.mode == Mode::Balanced {
            let wanted = balanced_min_fps(input.pixels);
            if wanted < state.restrictions.max_fps.unwrap_or(UNLIMITED) {
                state.restrictions.max_fps = Some(wanted.max(2));
                state.fps_adaptations += 1;
                return Ok(state);
            }
        }
        let target = input.pixels * 3 / 5;
        if target >= state.restrictions.max_pixels.unwrap_or(UNLIMITED) || target < MIN_PIXELS {
            return Err(AdaptationStatus::LimitReached);
        }
        state.restrictions.max_pixels = Some(target);
        state.restrictions.target_pixels = None;
        state.resolution_adaptations += 1;
        Ok(state)
    }

    fn up(&self, input: Input, mut state: Adaptation) -> Result<Adaptation, AdaptationStatus> {
        if self.mode == Mode::Balanced {
            let mut wanted = balanced_max_fps(input.pixels);
            // Upstream preserves one up step per prior down step when the next
            // FPS setting is unlimited but several FPS adaptations remain.
            if wanted == UNLIMITED && state.fps_adaptations > 1 {
                wanted -= state.fps_adaptations;
            }
            if wanted > state.restrictions.max_fps.unwrap_or(UNLIMITED) {
                if state.fps_adaptations == 1 {
                    wanted = UNLIMITED;
                }
                state.restrictions.max_fps = (wanted != UNLIMITED).then_some(wanted);
                state.fps_adaptations -= 1;
                return Ok(state);
            }
        }
        let (max_pixels, target_pixels) = if state.resolution_adaptations == 1 {
            (None, None)
        } else {
            let target = input.pixels * 5 / 3;
            (Some(target * 12 / 5), Some(target))
        };
        if max_pixels.unwrap_or(UNLIMITED) <= state.restrictions.max_pixels.unwrap_or(UNLIMITED) {
            return Err(AdaptationStatus::LimitReached);
        }
        state.restrictions.max_pixels = max_pixels;
        state.restrictions.target_pixels = target_pixels;
        state.resolution_adaptations -= 1;
        Ok(state)
    }
}
