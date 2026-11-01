// Copyright 2023 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Complete-AU adaptation of LiveKit's VP8 temporal selector:
//! https://github.com/livekit/livekit/blob/master/pkg/sfu/videolayerselector/temporallayerselector/vp8.go
use crate::EncodedFrame;

#[derive(Clone, Copy)]
pub(super) struct Selection {
    pub temporal: Option<u8>,
    pub bps: u64,
}

#[derive(Default)]
pub(super) struct Rates {
    pub full: Option<u64>,
    pub temporal: [Option<u64>; 4],
}
impl Rates {
    pub fn new(bins: Option<[Option<u64>; 5]>) -> Self {
        let Some(bins) = bins else {
            return Self::default();
        };
        let full = Some(bins.into_iter().flatten().sum());
        let mut temporal = [None; 4];
        // Unclassified bytes belong to the full feed. They cannot be assigned
        // to T0 or omitted from a partial-feed budget.
        if bins[4].is_none_or(|bps| bps == 0) {
            let mut sum = 0;
            for (index, rate) in bins[..4].iter().enumerate() {
                let Some(rate) = rate else { break };
                sum += rate;
                temporal[index] = Some(sum);
            }
        }
        Self { full, temporal }
    }
    pub fn fit(&self, budget: u64) -> Option<Selection> {
        let full = self.full?;
        if full > 0 && full <= budget {
            return Some(Selection {
                temporal: None,
                bps: full,
            });
        }
        self.temporal
            .iter()
            .enumerate()
            .rev()
            .find_map(|(tid, bps)| {
                let bps = (*bps)?;
                (bps > 0 && bps <= budget).then_some(Selection {
                    temporal: Some(tid as u8),
                    bps,
                })
            })
    }
}

#[derive(Clone, Copy, Default)]
pub(super) struct Temporal {
    pub current: Option<u8>,
    pub target: Option<u8>,
}
pub(super) enum Decision {
    Forward,
    Drop,
    Recover,
}
impl Temporal {
    pub fn select(&mut self, frame: &EncodedFrame) -> Decision {
        let metadata = frame.vp8;
        let tid = metadata.and_then(|metadata| metadata.temporal_id);
        let current = self.current.unwrap_or(3);
        let target = self.target.unwrap_or(3);
        if (frame.keyframe && tid.is_none_or(|tid| tid <= target)) || current > target {
            // This call is already at an AU boundary, unlike the packet-level
            // selector which defers a down-switch until the marker packet.
            self.current = self.target;
        } else if current < target
            && tid == Some(current + 1)
            && metadata.is_some_and(|metadata| metadata.layer_sync)
        {
            self.current = tid;
        }
        match (self.current.unwrap_or(3), tid) {
            (3, _) => Decision::Forward,
            (_, None) => Decision::Recover,
            (current, Some(tid)) if tid > current => Decision::Drop,
            _ => Decision::Forward,
        }
    }
}
