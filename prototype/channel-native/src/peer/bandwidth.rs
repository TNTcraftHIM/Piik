//! Protect selected media when a physical connection also carries route trials.
use super::*;
use crate::media::video::EncodingDemand;

#[derive(Default)]
pub(super) struct BandwidthPlan {
    pub waiting: HashSet<Uuid>,
    pub rejected: HashSet<Uuid>,
    video: HashMap<Uuid, EncodingDemand>,
}

impl Driver {
    #[cfg(feature = "capture")]
    fn has_video_producer(&self, source: Uuid) -> bool {
        if self.captures.values().any(|capture| {
            capture.selected
                && !capture.producer.control.is_stopped()
                && capture.producer.video == source
        }) {
            return true;
        }
        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
        if self.derived.contains_key(&source) {
            return true;
        }
        false
    }
    pub(super) fn bandwidth_plans(&self, now: Instant) -> HashMap<Uuid, BandwidthPlan> {
        let rates: HashMap<_, _> = self
            .sources
            .values()
            .map(|source| {
                let rates = match &source.layers {
                    Some(layers) => layers.rates(now),
                    None => {
                        let rate = match &source.feed {
                            SourceFeed::Rtp { .. } => self.relay.bitrate(source.id, now),
                            SourceFeed::Video(video) => video.bitrate(now),
                        };
                        (rate, rate)
                    }
                };
                (source.id, rates)
            })
            .collect();
        self.pairs
            .iter()
            .map(|(id, pair)| {
                let mut maximum = Some(0u64);
                let requests = pair
                    .plan
                    .outgoing
                    .iter()
                    .filter(|flow| {
                        !self.publications[&flow.publication_id].paused
                            && (flow.selected
                                || !pair.rejected_outputs.keys().any(|key| key.0 == flow.id))
                    })
                    .map(|flow| {
                        let sources: Vec<_> = self
                            .sources
                            .values()
                            .filter(|source| source.matches(flow, source.kind))
                            .collect();
                        let primary = match self.publications[&flow.publication_id].kind {
                            piik_channel_core::wire::Kind::Voice => MediaKind::Audio,
                            piik_channel_core::wire::Kind::Screen => MediaKind::Video,
                        };
                        let mut measured = sources.iter().any(|s| s.kind == primary);
                        if !measured {
                            maximum = None;
                        }
                        let mut opaque_bps = 0;
                        let mut video = None;
                        for source in &sources {
                            let (highest, aggregate) = rates[&source.id];
                            let rate = if pair.plan.can_receive_video_layers {
                                aggregate
                            } else {
                                highest
                            };
                            let configured =
                                self.configured_bitrate(source, pair.plan.can_receive_video_layers);
                            maximum = maximum
                                .zip(configured)
                                .map(|(total, bps)| total + u64::from(bps));
                            if let Some(full_bps) = self.video_cap(source, configured, rate) {
                                measured &= full_bps.is_some();
                                video = Some(VideoRequest {
                                    full_bps,
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
                                let rate = configured
                                    .map(|bps| rate.unwrap_or(0).max(u64::from(bps)))
                                    .or(rate);
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
                // Application demand is configured capacity, not recent usage or
                // the current grant. Keep unknown distinct from no output demand;
                // the transport maps that distinction to its SDK ceiling.
                pair.demand.send_if_modified(|current| {
                    if *current == maximum {
                        return false;
                    }
                    *current = maximum;
                    true
                });
                let mut plan = allocate(
                    pair.bandwidth.borrow().feedback().map(|bps| bps as u64),
                    &requests,
                );
                for flow in &pair.plan.outgoing {
                    if self.publications[&flow.publication_id].paused {
                        plan.video.insert(flow.id, EncodingDemand::Paused);
                    }
                }
                (*id, plan)
            })
            .collect()
    }

    fn configured_bitrate(&self, source: &Source, preserve_layers: bool) -> Option<u32> {
        #[cfg(feature = "capture")]
        {
            let capture = self.captures.values().find(|capture| {
                capture.selected
                    && !capture.producer.control.is_stopped()
                    && (capture.producer.video == source.id
                        || capture.producer.audio() == Some(source.id))
            })?;
            let producer = &capture.producer;
            if producer.video == source.id {
                Some(
                    if let Some(layers) = source.layers.as_ref().filter(|_| preserve_layers) {
                        layers
                            .snapshot()
                            .iter()
                            .filter(|(_, video)| video.is_some())
                            .fold(0u32, |sum, (rid, _)| {
                                sum.saturating_add(if rid == "q" {
                                    producer.settings().lower_layer().bitrate
                                } else {
                                    producer.settings().bitrate
                                })
                            })
                    } else {
                        producer.settings().bitrate
                    },
                )
            } else if producer.audio() == Some(source.id) {
                Some(producer.control.audio_bitrate())
            } else {
                None
            }
        }
        #[cfg(not(feature = "capture"))]
        {
            let _ = (source, preserve_layers);
            None
        }
    }

    // Outer None means opaque media; inner None means an adaptive source
    // whose original feed has not supplied a complete rate observation yet.
    fn video_cap(
        &self,
        source: &Source,
        configured: Option<u32>,
        rate: Option<u64>,
    ) -> Option<Option<u32>> {
        if source.kind != MediaKind::Video {
            return None;
        }
        if let Some(bps) = configured {
            return Some(Some(bps));
        }
        source
            .video()
            .map(|_| rate.map(|bps| bps.min(u64::from(u32::MAX)) as u32))
    }

    pub(super) async fn reconcile_encodings(&mut self) {
        let plans = self.bandwidth_plans(Instant::now());
        let mut failed = Vec::new();
        for (id, pair) in &self.pairs {
            for (key, output) in &pair.outputs {
                #[cfg(feature = "capture")]
                if self.has_video_producer(output.source) {
                    continue;
                }
                let Some(source) = self.sources.get(&output.source) else {
                    continue;
                };
                let Some(demand) = plans[id].video.get(&key.0) else {
                    continue;
                };
                let selected = if let Some(layers) = &source.layers {
                    output.select_layers(layers, *demand, Instant::now())
                } else if let Some(video) = source.video() {
                    let Some(input) = output.video_input().and_then(|input| input.upgrade()) else {
                        continue;
                    };
                    input.select_available(std::iter::once(video), *demand, Instant::now())
                } else {
                    continue;
                };
                if let Err(error) = selected {
                    eprintln!("Native video layer selection failed: {error}");
                    failed.push(Event::OutputFailed {
                        pair: *id,
                        key: *key,
                        source: output.source,
                        output: output.id,
                    });
                }
            }
        }
        for failure in failed {
            if let Err(error) = self.event(failure).await {
                eprintln!("Native failed output retirement failed: {error}");
            }
        }
        #[cfg(feature = "capture")]
        self.reconcile_producers(&plans).await;
    }

    #[cfg(feature = "capture")]
    async fn reconcile_producers(&mut self, plans: &HashMap<Uuid, BandwidthPlan>) {
        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
        {
            let retired: Vec<_> = self
                .derived
                .keys()
                .filter(|id| !self.sources.contains_key(id))
                .copied()
                .collect();
            for id in retired {
                self.derived.remove(&id).unwrap().stop().await;
            }
        }
        use crate::media::encodings::{self, VideoDemand};
        let mut demands: HashMap<Uuid, Vec<VideoDemand>> = HashMap::new();
        for (id, pair) in &self.pairs {
            for (key, output) in &pair.outputs {
                let Some(encoding) = plans[id].video.get(&key.0) else {
                    continue;
                };
                if !self.has_video_producer(output.source) {
                    continue;
                }
                demands
                    .entry(output.source)
                    .or_default()
                    .extend(encodings::demands(
                        &self.sources[&output.source],
                        output.id,
                        output.video_inputs(),
                        *encoding,
                        Instant::now(),
                    ));
            }
        }
        for capture in self.captures.values() {
            let producer = &capture.producer;
            let mut next = if capture.selected && !producer.control.is_stopped() {
                demands.remove(&producer.video).unwrap_or_default()
            } else {
                Vec::new()
            };
            next.sort_unstable_by(|a, b| (&a.output, &a.rid).cmp(&(&b.output, &b.rid)));
            producer.set_demands(next);
        }
        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
        for (source, producer) in &self.derived {
            let mut next = demands.remove(source).unwrap_or_default();
            next.sort_unstable_by(|a, b| (&a.output, &a.rid).cmp(&(&b.output, &b.rid)));
            producer.set_demands(next);
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
    full_bps: Option<u32>,
    stable: bool,
}

fn allocate(target: Option<u64>, requests: &[Request]) -> BandwidthPlan {
    let mut plan = BandwidthPlan::default();
    let protected = requests
        .iter()
        .any(|r| r.selected && (r.present || r.started));
    let Some(target) = target else {
        // An existing source rate is not the capacity of a newly connected viewer.
        // Let its first media establish feedback; protect selected flows from trials.
        for request in requests {
            if protected && !request.selected {
                plan.waiting.insert(request.id);
                if request.video.as_ref().is_some_and(|video| video.stable) {
                    plan.video.insert(request.id, EncodingDemand::Paused);
                }
            } else if request.video.as_ref().is_some_and(|video| video.stable) {
                plan.video.insert(request.id, EncodingDemand::Original);
            }
        }
        return plan;
    };
    let selected_opaque = requests
        .iter()
        .filter(|r| r.selected)
        .map(|r| r.opaque_bps)
        .sum::<u64>();
    let selected_cap = requests
        .iter()
        .filter(|r| r.selected)
        .filter_map(|r| r.video.as_ref())
        .map(|v| u64::from(v.full_bps.unwrap_or(0)))
        .sum::<u64>();
    share_video_budget(
        target.saturating_sub(selected_opaque),
        requests.iter().filter(|r| r.selected),
        &mut plan,
    );
    if !protected {
        // With no selected incumbent to protect, optional flows may start
        // using the current feedback-derived budget.
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
            if request.video.as_ref().is_some_and(|video| video.stable) {
                plan.video.insert(request.id, EncodingDemand::Paused);
            }
            continue;
        }
        let opaque = request.opaque_bps;
        let budget = remaining.saturating_sub(opaque);
        if opaque > remaining
            || request
                .video
                .as_ref()
                .is_some_and(|v| v.full_bps.is_some_and(|bps| bps > 0))
                && budget == 0
        {
            if request.started {
                plan.rejected.insert(request.id);
            } else {
                plan.waiting.insert(request.id);
            }
            continue;
        }
        remaining = budget;
        if let Some(video) = &request.video {
            let bitrate = remaining.min(u64::from(video.full_bps.unwrap_or(0))) as u32;
            remaining -= u64::from(bitrate);
            if video.stable {
                plan.video.insert(
                    request.id,
                    if budget == 0 {
                        EncodingDemand::Paused
                    } else {
                        encoding_demand(video.full_bps, bitrate)
                    },
                );
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
                .map(|video| (r.id, video.full_bps))
        })
        .collect();
    let total: u128 = videos
        .iter()
        .map(|(_, cap)| u128::from(cap.unwrap_or(0)))
        .sum();
    let allocated = u128::from(budget).min(total);
    for (id, cap) in videos {
        let grant = if total == 0 {
            0
        } else {
            (allocated * u128::from(cap.unwrap_or(0)) / total) as u32
        };
        plan.video.insert(
            id,
            if budget == 0 {
                EncodingDemand::Paused
            } else {
                encoding_demand(cap, grant)
            },
        );
    }
}

fn encoding_demand(full_bps: Option<u32>, grant: u32) -> EncodingDemand {
    match full_bps {
        Some(full) if full > 0 && grant == 0 => EncodingDemand::Paused,
        Some(full) if grant > 0 && grant < full => EncodingDemand::Limited(grant),
        _ => EncodingDemand::Original,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn late_viewer_bootstraps_known_layers_before_feedback_then_obeys_budget() -> Result<()> {
        use crate::media::{
            clock::SourceTime,
            video::{Layers, Video},
        };
        use rtc_shared::time::SystemInstant;
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let low = Video::new(time.clone(), Arc::new(Notify::new()));
        let high = Video::new(time, Arc::new(Notify::new()));
        let frame = |bytes, millis| crate::EncodedFrame {
            vp8: None,
            bytes: vec![1; bytes],
            presentation_time: epoch + Duration::from_millis(millis),
            keyframe: true,
        };
        low.write(frame(128_000, 0));
        high.write(frame(512_000, 0));
        let now = epoch + Duration::from_secs(2);
        assert!(low.bitrate(now).unwrap() > 300_000);
        let full = high.bitrate(now).unwrap() as u32;
        let layers = Layers::new(vec!["q".into(), "h".into()]);
        layers.insert("q".into(), low.clone());
        layers.insert("h".into(), high.clone());
        let requests = [request(1, true, Some(0), Some((full, true)))];
        let input = low.subscribe();
        let key = Uuid::from_u128(1);

        // The old numeric startup path pauses a late viewer with these actual rates.
        let startup_number = allocate(Some(300_000), &requests);
        layers.select(&input, startup_number.video[&key], now)?;
        assert!(!low.needed() && !high.needed());

        let startup = allocate(None, &requests);
        layers.select(&input, startup.video[&key], now)?;
        high.write(frame(64, 2100));
        let received = tokio::time::timeout(Duration::from_millis(100), input.recv()).await?;
        assert_eq!(
            received.unwrap().presentation_time,
            epoch + Duration::from_millis(2100)
        );

        // Real feedback can constrain this same Output after bootstrap.
        let constrained = allocate(Some(100_000), &requests);
        layers.select(&input, constrained.video[&key], now)?;
        assert!(!low.needed() && !high.needed());
        let restored = allocate(Some(u64::from(full)), &requests);
        layers.select(&input, restored.video[&key], now)?;
        high.write(frame(64, 2200));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), input.recv())
                .await?
                .is_some()
        );
        Ok(())
    }
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
            video: video.map(|(cap_bps, stable)| VideoRequest {
                full_bps: Some(cap_bps),
                stable,
            }),
        }
    }
    #[test]
    fn unknown_and_idle_video_respect_connection_grants_and_trial_admission() {
        let selected = Uuid::from_u128(1);
        let optional = Uuid::from_u128(2);
        for full_bps in [None, Some(0)] {
            let mut requests = vec![
                request(1, true, Some(0), Some((0, true))),
                request(2, false, Some(0), Some((0, true))),
            ];
            for request in &mut requests {
                request.video.as_mut().unwrap().full_bps = full_bps;
                request.measured = full_bps.is_some();
            }
            requests[1].started = true;
            let plan = allocate(Some(0), &requests);
            assert_eq!(plan.video[&selected], EncodingDemand::Paused);
            assert_eq!(plan.video[&optional], EncodingDemand::Paused);
            assert!(plan.rejected.is_empty());
            let unprotected = allocate(Some(0), &requests[1..]);
            assert_eq!(unprotected.video[&optional], EncodingDemand::Paused);

            let plan = allocate(Some(300_000), &requests);
            assert_eq!(plan.video[&selected], EncodingDemand::Original);
            assert_eq!(
                plan.video[&optional],
                if full_bps.is_none() {
                    EncodingDemand::Paused
                } else {
                    EncodingDemand::Original
                }
            );
            let startup = allocate(None, &requests);
            assert_eq!(startup.video[&selected], EncodingDemand::Original);
            assert_eq!(startup.video[&optional], EncodingDemand::Paused);

            // A silent or unmeasured picture cannot spend the budget reserved
            // for source sound or voice. A positive remainder still wakes it.
            requests[0].opaque_bps = 100_000;
            let plan = allocate(Some(100_000), &requests[..1]);
            assert_eq!(plan.video[&selected], EncodingDemand::Paused);
            let plan = allocate(Some(200_000), &requests[..1]);
            assert_eq!(plan.video[&selected], EncodingDemand::Original);
        }

        let mut requests = vec![
            request(1, true, Some(0), Some((600_000, true))),
            request(2, false, Some(0), Some((300_000, true))),
        ];
        requests[1].started = true;
        let plan = allocate(Some(900_000), &requests);
        assert_eq!(plan.video[&selected], EncodingDemand::Original);
        assert_eq!(plan.video[&optional], EncodingDemand::Original);
        let plan = allocate(Some(300_000), &requests);
        assert_eq!(plan.video[&selected], EncodingDemand::Limited(300_000));
        assert!(plan.rejected.contains(&optional));
        let plan = allocate(Some(0), &requests[..1]);
        assert_eq!(plan.video[&selected], EncodingDemand::Paused);

        requests[0].measured = false;
        let plan = allocate(Some(900_000), &requests);
        assert!(plan.waiting.contains(&optional));
        assert_eq!(plan.video[&optional], EncodingDemand::Paused);
    }

    #[test]
    fn selected_media_precedes_whole_optional_flows_without_blocking_bootstrap() {
        let mut requests = vec![
            request(1, true, Some(100_000), Some((1_200_000, true))),
            request(2, true, Some(0), Some((600_000, false))),
            request(3, false, Some(200_000), Some((600_000, true))),
            request(4, false, Some(400_000), None),
        ];
        let plan = allocate(Some(1_700_000), &requests);
        assert_eq!(plan.video[&requests[0].id], EncodingDemand::Original);
        assert_eq!(plan.waiting.len(), 2);
        requests[1].video.as_mut().unwrap().stable = true;
        let plan = allocate(Some(1_000_000), &requests);
        assert_eq!(
            plan.video[&requests[0].id],
            EncodingDemand::Limited(600_000)
        );
        assert_eq!(
            plan.video[&requests[1].id],
            EncodingDemand::Limited(300_000)
        );
        let plan = allocate(Some(2_500_000), &requests);
        assert_eq!(
            plan.video[&requests[2].id],
            EncodingDemand::Limited(400_000)
        );
        assert!(plan.waiting.contains(&requests[3].id));
        requests[2].started = true;
        let plan = allocate(Some(2_000_000), &requests);
        assert!(plan.rejected.contains(&requests[2].id));
        requests[0].measured = false;
        let plan = allocate(Some(2_500_000), &requests);
        assert!(!plan.rejected.contains(&requests[2].id));
        assert!(plan.waiting.contains(&requests[3].id));
        let plan = allocate(Some(300_000), &requests[3..]);
        assert!(plan.waiting.is_empty() && plan.rejected.is_empty());

        let mut independent = vec![
            request(5, true, Some(100_000), None),
            request(6, false, None, None),
            request(7, false, Some(400_000), None),
        ];
        let plan = allocate(Some(2_000_000), &independent);
        assert!(plan.waiting.contains(&independent[1].id));
        assert!(!plan.waiting.contains(&independent[2].id));
        independent[1].started = true;
        let plan = allocate(Some(2_000_000), &independent);
        assert!(plan.waiting.contains(&independent[2].id));

        // A new audio kind must not erase the screen's already measured cost.
        independent[0].measured = false;
        independent.push(request(8, true, Some(0), Some((2_000_000, true))));
        let plan = allocate(Some(1_000_000), &independent);
        assert_eq!(
            plan.video[&independent[3].id],
            EncodingDemand::Limited(900_000)
        );
    }
}
