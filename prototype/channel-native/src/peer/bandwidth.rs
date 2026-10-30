//! Protect selected media when a physical connection also carries route trials.
use super::*;

#[derive(Default)]
pub(super) struct BandwidthPlan {
    pub waiting: HashSet<Uuid>,
    pub rejected: HashSet<Uuid>,
    video: HashMap<Uuid, u32>,
}

impl Driver {
    pub(super) fn bandwidth_plans(&self, now: Instant) -> HashMap<Uuid, BandwidthPlan> {
        let rates: HashMap<_, _> = self
            .sources
            .keys()
            .map(|id| (*id, self.relay.bitrate(*id, now)))
            .collect();
        self.pairs
            .iter()
            .map(|(id, pair)| {
                let requests = pair
                    .plan
                    .outgoing
                    .iter()
                    .filter(|flow| {
                        flow.selected || !pair.rejected_outputs.keys().any(|key| key.0 == flow.id)
                    })
                    .map(|flow| {
                        let sources: Vec<_> = self
                            .sources
                            .values()
                            .filter(|source| source.matches(flow, source.kind))
                            .collect();
                        let primary = match self.publications[&flow.publication_id].kind {
                            piik_channel_core::wire::Kind::Voice => RtpCodecKind::Audio,
                            piik_channel_core::wire::Kind::Screen => RtpCodecKind::Video,
                        };
                        let mut measured = sources.iter().any(|s| s.kind == primary);
                        let mut opaque_bps = 0;
                        let mut video = None;
                        for source in &sources {
                            if let Some(cap_bps) = self.video_cap(source) {
                                video = Some(VideoRequest {
                                    cap_bps,
                                    stable: pair.outputs.get(&(flow.id, source.kind)).is_some_and(
                                        |out| {
                                            out.source == source.id
                                                && pair
                                                    .stable_outputs
                                                    .as_ref()
                                                    .is_some_and(|ids| ids.contains(&out.id))
                                        },
                                    ),
                                });
                            } else {
                                let rate = rates[&source.id];
                                #[cfg(any(target_os = "windows", target_os = "macos"))]
                                let rate =
                                    if self.captures.values().any(|p| p.audio == Some(source.id)) {
                                        Some(
                                            rate.unwrap_or(0)
                                                .max(u64::from(crate::media::local::AUDIO_BITRATE)),
                                        )
                                    } else {
                                        rate
                                    };
                                opaque_bps += rate.unwrap_or(0);
                                measured &= rate.is_some();
                            }
                        }
                        Request {
                            id: flow.id,
                            selected: flow.selected,
                            present: !sources.is_empty(),
                            started: pair.outputs.keys().any(|key| key.0 == flow.id),
                            opaque_bps,
                            measured,
                            video,
                        }
                    })
                    .collect::<Vec<_>>();
                (*id, allocate(*pair.bandwidth.borrow() as u64, &requests))
            })
            .collect()
    }

    fn video_cap(&self, source: &Source) -> Option<u32> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        return self
            .captures
            .get(&source.publication_id)
            .filter(|producer| producer.video == source.id)
            .map(|producer| producer.settings.bitrate);
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = source;
            None
        }
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    pub(super) fn reconcile_encodings(&mut self) {
        use crate::media::local;
        let plans = self.bandwidth_plans(Instant::now());
        let mut demands: HashMap<Uuid, Vec<local::VideoDemand>> = HashMap::new();
        for (id, pair) in &self.pairs {
            for (key, output) in &pair.outputs {
                let Some(bitrate) = plans[id].video.get(&key.0) else {
                    continue;
                };
                if let Some((publication, _)) = self
                    .captures
                    .iter()
                    .find(|(_, producer)| producer.video == output.source)
                {
                    if let Some(input) = output.video_input() {
                        demands
                            .entry(*publication)
                            .or_default()
                            .push(local::VideoDemand {
                                output: output.id,
                                input,
                                bitrate: *bitrate,
                            });
                    }
                }
            }
        }
        for (publication, producer) in &self.captures {
            let mut current = demands.remove(publication).unwrap_or_default();
            current.sort_unstable_by_key(|demand| demand.output);
            producer.set_demands(current);
        }
    }
}

struct Request {
    id: Uuid,
    selected: bool,
    present: bool,
    started: bool,
    opaque_bps: u64,
    measured: bool,
    video: Option<VideoRequest>,
}
struct VideoRequest {
    cap_bps: u32,
    stable: bool,
}

fn allocate(target: u64, requests: &[Request]) -> BandwidthPlan {
    let mut plan = BandwidthPlan::default();
    let protected = requests
        .iter()
        .any(|r| r.selected && (r.present || r.started));
    let selected_opaque = requests
        .iter()
        .filter(|r| r.selected)
        .map(|r| r.opaque_bps)
        .sum::<u64>();
    let selected_cap = requests
        .iter()
        .filter(|r| r.selected)
        .filter_map(|r| r.video.as_ref())
        .map(|v| u64::from(v.cap_bps))
        .sum::<u64>();
    share_video_budget(
        target.saturating_sub(selected_opaque),
        requests.iter().filter(|r| r.selected),
        &mut plan,
    );
    if !protected {
        // The SDK's startup estimate is not measured capacity. Do not block
        // an empty connection's first RTP and its bandwidth feedback.
        let opaque = requests.iter().map(|r| r.opaque_bps).sum::<u64>();
        share_video_budget(
            target.saturating_sub(opaque),
            requests.iter().filter(|r| !r.selected),
            &mut plan,
        );
        return plan;
    }
    let mut remaining = target
        .saturating_sub(selected_opaque)
        .saturating_sub(selected_cap);
    let mut known = requests.iter().filter(|r| r.selected).all(|r| r.measured);
    let mut optional: Vec<_> = requests.iter().filter(|r| !r.selected).collect();
    optional.sort_by_key(|r| !r.started);
    for request in optional {
        if !known || !request.measured {
            plan.waiting.insert(request.id);
            // Retain a trial until its observation completes, without admitting
            // more trials against the same unknown cost.
            if request.started {
                known = false;
            }
            if request.video.as_ref().is_some_and(|v| v.stable) {
                plan.video.insert(request.id, 0);
            }
            continue;
        }
        let opaque = request.opaque_bps;
        let budget = remaining.saturating_sub(opaque);
        if opaque > remaining || request.video.is_some() && budget == 0 {
            if request.started {
                plan.rejected.insert(request.id);
            } else {
                plan.waiting.insert(request.id);
            }
            continue;
        }
        remaining = budget;
        if let Some(video) = &request.video {
            let bitrate = remaining.min(u64::from(video.cap_bps)) as u32;
            remaining -= u64::from(bitrate);
            if video.stable {
                plan.video.insert(request.id, bitrate);
            }
        }
    }
    plan
}

// Configured ceilings weight negotiated encoders, as in libwebrtc's relative
// allocation. Pending selected video encoders reserve optional capacity but cannot
// reduce an incumbent encoder before their negotiation completes.
// https://webrtc.googlesource.com/src/+/main/call/bitrate_allocator.cc
fn share_video_budget<'a>(
    budget: u64,
    requests: impl Iterator<Item = &'a Request>,
    plan: &mut BandwidthPlan,
) {
    let videos: Vec<_> = requests
        .filter_map(|r| {
            r.video
                .as_ref()
                .filter(|video| video.stable)
                .map(|video| (r.id, video.cap_bps))
        })
        .collect();
    let total: u128 = videos.iter().map(|(_, cap)| u128::from(*cap)).sum();
    if total == 0 {
        return;
    }
    let budget = u128::from(budget).min(total);
    for (id, cap) in videos {
        plan.video
            .insert(id, (budget * u128::from(cap) / total) as u32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(
        id: u128,
        selected: bool,
        opaque: Option<u64>,
        video: Option<(u32, bool)>,
    ) -> Request {
        Request {
            id: Uuid::from_u128(id),
            selected,
            present: true,
            started: false,
            opaque_bps: opaque.unwrap_or(0),
            measured: opaque.is_some(),
            video: video.map(|(cap_bps, stable)| VideoRequest { cap_bps, stable }),
        }
    }
    #[test]
    fn selected_media_precedes_whole_optional_flows_without_blocking_bootstrap() {
        let mut requests = vec![
            request(1, true, Some(100_000), Some((1_200_000, true))),
            request(2, true, Some(0), Some((600_000, false))),
            request(3, false, Some(200_000), Some((600_000, true))),
            request(4, false, Some(400_000), None),
        ];
        let plan = allocate(1_700_000, &requests);
        assert_eq!(plan.video[&requests[0].id], 1_200_000);
        assert_eq!(plan.waiting.len(), 2);
        requests[1].video.as_mut().unwrap().stable = true;
        let plan = allocate(1_000_000, &requests);
        assert_eq!(plan.video[&requests[0].id], 600_000);
        assert_eq!(plan.video[&requests[1].id], 300_000);
        let plan = allocate(2_500_000, &requests);
        assert_eq!(plan.video[&requests[2].id], 400_000);
        assert!(plan.waiting.contains(&requests[3].id));
        requests[2].started = true;
        let plan = allocate(2_000_000, &requests);
        assert!(plan.rejected.contains(&requests[2].id));
        requests[0].measured = false;
        let plan = allocate(2_500_000, &requests);
        assert!(!plan.rejected.contains(&requests[2].id));
        assert!(plan.waiting.contains(&requests[3].id));
        let plan = allocate(300_000, &requests[3..]);
        assert!(plan.waiting.is_empty() && plan.rejected.is_empty());

        let mut independent = vec![
            request(5, true, Some(100_000), None),
            request(6, false, None, None),
            request(7, false, Some(400_000), None),
        ];
        let plan = allocate(2_000_000, &independent);
        assert!(plan.waiting.contains(&independent[1].id));
        assert!(!plan.waiting.contains(&independent[2].id));
        independent[1].started = true;
        let plan = allocate(2_000_000, &independent);
        assert!(plan.waiting.contains(&independent[2].id));

        // A new audio kind must not erase the screen's already measured cost.
        independent[0].measured = false;
        independent.push(request(8, true, Some(0), Some((2_000_000, true))));
        let plan = allocate(1_000_000, &independent);
        assert_eq!(plan.video[&independent[3].id], 900_000);
    }
}
