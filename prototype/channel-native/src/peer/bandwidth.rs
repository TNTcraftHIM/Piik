//! Protect selected media when a physical connection also carries route trials.
use super::*;
use crate::media::video::{EncodingDemand, VideoAllocation};

const PAUSED: VideoAllocation = VideoAllocation {
    forwarding: EncodingDemand::Paused,
    encoder_bps: 0,
};

#[derive(Default)]
pub(super) struct BandwidthPlan {
    pub waiting: HashSet<Uuid>,
    pub rejected: HashSet<Uuid>,
    video: HashMap<Uuid, VideoAllocation>,
}
impl BandwidthPlan {
    /// An optional flow that does not fit ends its trial or waits to start one.
    fn decline(&mut self, request: &Request) {
        if request.started {
            self.rejected.insert(request.id);
        } else {
            self.waiting.insert(request.id);
        }
    }
}

fn desired_bitrate(
    configured: Option<u32>,
    intent: Option<u64>,
    original: Option<u64>,
    requires_conversion: bool,
) -> Option<u64> {
    // Original bytes cannot establish the cost of a different representation.
    configured
        .map(u64::from)
        .or_else(|| intent.max(original.filter(|_| !requires_conversion)))
}

impl Driver {
    #[cfg(feature = "capture")]
    fn has_video_producer(&self, source: Uuid) -> bool {
        if self.local_producers.values().any(|capture| {
            capture.selected
                && !capture.producer.is_stopped()
                && capture
                    .producer
                    .capture()
                    .is_some_and(|capture| capture.producer.video == source)
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
        self.pairs
            .iter()
            .map(|(id, pair)| {
                let mut minimum = 0;
                let mut desired = Some(0u64);
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
                        let publication = &self.publications[&flow.publication_id];
                        let video_intent = publication
                            .video_settings
                            .map(|settings| u64::from(settings.ceiling.max_bitrate));
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
                            desired = desired.zip(video_intent).map(|(total, bps)| total + bps);
                        }
                        let mut opaque_bps = 0;
                        let mut video = None;
                        for source in &sources {
                            let output = pair
                                .outputs
                                .get(&(flow.id, source.kind))
                                .filter(|output| output.source == source.id);
                            let accepts = |codec: &crate::media::RtpCodec| {
                                output.map_or_else(
                                    || crate::media::compatible(codec, source.codec()),
                                    |out| out.can_forward(codec),
                                )
                            };
                            #[cfg(feature = "capture")]
                            let producer = self.has_video_producer(source.id);
                            #[cfg(not(feature = "capture"))]
                            let producer = false;
                            let requires_conversion = producer && !accepts(source.codec());
                            let encodable = producer
                                && crate::media::encoding_codec(source.codec())
                                    .is_some_and(|codec| accepts(&codec));
                            let (rate, floor) = if source.video().is_some() {
                                let supply =
                                    source.video_supply(|codec| encodable || accepts(codec));
                                let (highest, aggregate) = supply.rates(now);
                                let rate = if pair.plan.can_receive_video_layers {
                                    aggregate
                                } else {
                                    highest
                                };
                                (
                                    rate,
                                    if encodable {
                                        Some(0)
                                    } else {
                                        supply.floor(now)
                                    },
                                )
                            } else {
                                (self.relay.bitrate(source.id, now), None)
                            };
                            if flow.selected && !requires_conversion {
                                // Original bytes are not this output's transmit demand
                                // when negotiation requires another representation.
                                minimum += rate.unwrap_or(0);
                            }
                            let configured =
                                self.configured_bitrate(source, pair.plan.can_receive_video_layers);
                            let intent = (source.kind == MediaKind::Video)
                                .then_some(video_intent)
                                .flatten();
                            let source_desired =
                                desired_bitrate(configured, intent, rate, requires_conversion);
                            desired = desired.zip(source_desired).map(|(total, bps)| total + bps);
                            if let Some(full_bps) = self.video_cap(source, configured, rate) {
                                measured &= full_bps.is_some();
                                video = Some(VideoRequest {
                                    full_bps,
                                    floor_bps: floor.map(|bps| bps.min(u64::from(u32::MAX)) as u32),
                                    requires_conversion,
                                    ceiling_bps: configured.or_else(|| {
                                        self.publications[&flow.publication_id]
                                            .video_settings
                                            .map(|settings| settings.ceiling.max_bitrate)
                                    }),
                                    stable: output.is_some_and(|out| {
                                        out.source == source.id
                                            && pair
                                                .stable_outputs
                                                .as_ref()
                                                .is_some_and(|ids| ids.contains(&out.id))
                                    }),
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
                // Sustain selected original supply with estimate-capped SDK padding.
                // Preferred original supply and source intent remain independent of
                // this output's current allocation and restricted transmit rate.
                let requested = BandwidthDemand {
                    minimum_bps: minimum,
                    desired_bps: desired,
                };
                pair.demand.send_if_modified(|current| {
                    if *current == requested {
                        return false;
                    }
                    *current = requested;
                    true
                });
                let mut plan = allocate(*pair.bandwidth.borrow(), &requests);
                for flow in &pair.plan.outgoing {
                    if self.publications[&flow.publication_id].paused {
                        plan.video.insert(flow.id, PAUSED);
                    }
                }
                (*id, plan)
            })
            .collect()
    }

    fn configured_bitrate(&self, source: &Source, preserve_layers: bool) -> Option<u32> {
        #[cfg(feature = "capture")]
        {
            if source.kind == MediaKind::Audio {
                let (_, audio) = self.capture_audio.get(&source.publication_id)?;
                return (audio.source() == Some(source.id) && !audio.control.is_stopped())
                    .then(|| audio.control.settings.borrow().bitrate);
            }
            let capture = self.local_producers.values().find(|capture| {
                capture.selected
                    && !capture.producer.is_stopped()
                    && capture
                        .producer
                        .capture()
                        .is_some_and(|capture| capture.producer.video == source.id)
            })?;
            let producer = &capture.producer.capture()?.producer;
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
                    output.select_layers(layers, demand.forwarding, Instant::now())
                } else if let Some(video) = source.video() {
                    let Some(input) = output.video_input().and_then(|input| input.upgrade()) else {
                        continue;
                    };
                    input.select_available(
                        std::iter::once(video),
                        demand.forwarding,
                        Instant::now(),
                    )
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
                self.derived.get_mut(&id).unwrap().stop().await;
                self.derived.remove(&id);
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
                        &output.codecs(),
                        Instant::now(),
                    ));
            }
        }
        for capture in self.local_producers.values() {
            let Some(details) = capture.producer.capture() else {
                continue;
            };
            let producer = &details.producer;
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
            let Some(preference) = self
                .sources
                .get(source)
                .and_then(|source| self.publications.get(&source.publication_id))
                .map(|publication| {
                    publication.video_settings.map_or(
                        piik_channel_core::wire::DegradationPreference::Balanced,
                        |settings| settings.degradation_preference,
                    )
                })
            else {
                continue;
            };
            let mut next = demands.remove(source).unwrap_or_default();
            next.sort_unstable_by(|a, b| (&a.output, &a.rid).cmp(&(&b.output, &b.rid)));
            producer.set_demands(next, preference);
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
    /// Cheapest representation this output can deliver: unknown before a
    /// complete observation, zero while idle or when an encoder serves any grant.
    floor_bps: Option<u32>,
    requires_conversion: bool,
    ceiling_bps: Option<u32>,
    stable: bool,
}
impl VideoRequest {
    fn minimum_grant(&self) -> u32 {
        let active = self.requires_conversion || self.full_bps.is_some_and(|bps| bps > 0);
        self.floor_bps.unwrap_or(0).max(u32::from(active))
    }
    fn capacity(&self) -> Option<u32> {
        if self.requires_conversion {
            self.ceiling_bps
        } else {
            Some(self.full_bps.unwrap_or(0))
        }
    }

    fn allocation(&self, budget: u64, grant: u32) -> VideoAllocation {
        VideoAllocation {
            forwarding: if budget == 0 || self.requires_conversion && grant == 0 {
                EncodingDemand::Paused
            } else {
                encoding_demand(self.full_bps, grant)
            },
            encoder_bps: grant,
        }
    }
}

fn allocate(estimate: transport::Estimate, requests: &[Request]) -> BandwidthPlan {
    let mut plan = BandwidthPlan::default();
    let protected = requests
        .iter()
        .any(|r| r.selected && (r.present || r.started));
    let target = estimate.value() as u64;
    if estimate.feedback().is_none() {
        // Original supply still bootstraps without treating the SDK's initial
        // estimate as measured capacity. Required encoders need its finite seed.
        let opaque = requests
            .iter()
            .filter(|r| r.selected || !protected)
            .map(|r| r.opaque_bps)
            .sum::<u64>();
        share_video_budget(
            target.saturating_sub(opaque),
            requests
                .iter()
                .filter(|r| r.selected || !protected)
                .map(|r| (r, 0)),
            &mut plan,
        );
        for request in requests {
            if protected && !request.selected {
                plan.waiting.insert(request.id);
                if request.video.as_ref().is_some_and(|video| video.stable) {
                    plan.video.insert(request.id, PAUSED);
                }
            } else if let Some(video) = request.video.as_ref().filter(|v| v.stable) {
                let allocation = plan.video.get_mut(&request.id).unwrap();
                allocation.forwarding = if video.requires_conversion && allocation.encoder_bps == 0
                {
                    EncodingDemand::Paused
                } else {
                    EncodingDemand::Original
                };
            }
        }
        return plan;
    }
    let selected_opaque = requests
        .iter()
        .filter(|r| r.selected)
        .map(|r| r.opaque_bps)
        .sum::<u64>();
    share_video_budget(
        target.saturating_sub(selected_opaque),
        requests.iter().filter(|r| r.selected).map(|r| (r, 0)),
        &mut plan,
    );
    // Like libwebrtc's enforced minimum, established selected video keeps the
    // cheapest representation it can deliver; the SDK paces any excess.
    for request in requests.iter().filter(|r| r.selected) {
        let (Some(video), Some(allocation)) = (&request.video, plan.video.get_mut(&request.id))
        else {
            continue;
        };
        if let Some(floor) = video.floor_bps.filter(|bps| *bps > allocation.encoder_bps) {
            *allocation = video.allocation(u64::from(floor), floor);
        }
    }
    if !protected {
        // Standalone opaque flows already run without admission. Reserve their
        // cost before admitting optional videos and each video's bundled audio.
        let opaque = requests
            .iter()
            .filter(|r| r.video.is_none())
            .map(|r| r.opaque_bps)
            .sum();
        let mut remaining = target.saturating_sub(opaque);
        let mut videos: Vec<_> = requests
            .iter()
            .filter_map(|r| r.video.as_ref().map(|v| (r, v)))
            .collect();
        videos.sort_by_key(|(request, _)| !request.started);
        let mut admitted = Vec::new();
        for (request, video) in videos {
            let floor = video.minimum_grant();
            let cost = request.opaque_bps + u64::from(floor);
            if cost > remaining {
                plan.decline(request);
                continue;
            }
            remaining -= cost;
            admitted.push((request, floor));
        }
        share_video_budget(remaining, admitted.into_iter(), &mut plan);
        return plan;
    }
    // Original supply, or a conversion's grant, already covers each selected
    // floor. Floors beyond the estimate leave nothing for optional flows.
    let selected_cap = requests
        .iter()
        .filter(|r| r.selected)
        .filter_map(|r| r.video.as_ref().map(|video| (r.id, video)))
        .map(|(id, video)| {
            u64::from(if video.requires_conversion && video.stable {
                plan.video[&id].encoder_bps
            } else {
                video.full_bps.unwrap_or(0)
            })
        })
        .sum::<u64>();
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
                plan.video.insert(request.id, PAUSED);
            }
            continue;
        }
        let opaque = request.opaque_bps;
        let budget = remaining.saturating_sub(opaque);
        if opaque > remaining
            || request
                .video
                .as_ref()
                .is_some_and(|v| u64::from(v.minimum_grant()) > budget)
        {
            plan.decline(request);
            continue;
        }
        remaining = budget;
        if let Some(video) = &request.video {
            let bitrate = video
                .capacity()
                .map_or(remaining, |cap| remaining.min(u64::from(cap)))
                .min(u64::from(u32::MAX)) as u32;
            remaining -= u64::from(bitrate);
            if video.stable {
                plan.video
                    .insert(request.id, video.allocation(budget, bitrate));
            }
        }
    }
    plan
}

// Allocate by relative demand, redistributing capacity unused by capped outputs.
// Original supply uses its full demand as weight and capacity. Required conversion
// keeps that weight but only an explicit ceiling caps its encoded representation.
// Capped relative redistribution follows libwebrtc's bitrate allocator.
// https://webrtc.googlesource.com/src/+/c8e422dde9fd36e50fd8ca3e4267cf05a2b49852/call/bitrate_allocator.cc
fn share_video_budget<'a>(
    budget: u64,
    requests: impl Iterator<Item = (&'a Request, u32)>,
    plan: &mut BandwidthPlan,
) {
    let videos: Vec<_> = requests
        .filter_map(|(r, floor)| {
            r.video
                .as_ref()
                .filter(|video| video.stable)
                .map(|video| (r.id, video, floor))
        })
        .collect();
    let start_share = (budget / videos.len().max(1) as u64)
        .max(1)
        .min(u64::from(u32::MAX)) as u32;
    let mut weighted = Vec::new();
    for (id, video, floor) in videos {
        let available = budget + u64::from(floor);
        plan.video.insert(id, video.allocation(available, floor));
        let weight = video.full_bps.filter(|bps| *bps > 0).unwrap_or_else(|| {
            if video.requires_conversion {
                start_share
            } else {
                0
            }
        });
        if weight > 0 {
            let capacity = video.capacity().map(|cap| cap.saturating_sub(floor));
            weighted.push((id, video, u128::from(weight), capacity, floor));
        }
    }
    weighted.sort_by(|a, b| match (a.3, b.3) {
        (Some(a_cap), Some(b_cap)) => (u128::from(a_cap) * b.2).cmp(&(u128::from(b_cap) * a.2)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    let mut remaining = u128::from(budget);
    let mut total: u128 = weighted.iter().map(|(_, _, weight, _, _)| weight).sum();
    let mut next = 0;
    while let Some((id, video, weight, Some(cap), floor)) = weighted.get(next) {
        if u128::from(*cap) * total > remaining * weight {
            break;
        }
        plan.video.insert(
            *id,
            video.allocation(budget + u64::from(*floor), floor.saturating_add(*cap)),
        );
        remaining -= u128::from(*cap);
        total -= weight;
        next += 1;
    }
    for (id, video, weight, _, floor) in weighted.into_iter().skip(next) {
        let grant = (remaining * weight / total).min(u128::from(u32::MAX)) as u32;
        plan.video.insert(
            id,
            video.allocation(budget + u64::from(floor), floor.saturating_add(grant)),
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
    #[cfg(all(
        feature = "capture",
        any(target_os = "windows", target_os = "linux", target_os = "macos")
    ))]
    #[tokio::test]
    async fn cancelled_derived_retirement_keeps_the_worker_join_owned() -> anyhow::Result<()> {
        use tokio::sync::oneshot;
        let (mut driver, _events, _commands, _stop) = crate::peer::tests::driver();
        let id = uuid::Uuid::new_v4();
        let (started, stopping) = oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let (finished, mut completed) = oneshot::channel();
        driver.derived.insert(
            id,
            crate::media::derived::tests::controlled_retirement(started, blocked, finished),
        );
        {
            let retiring = driver.reconcile_encodings();
            tokio::pin!(retiring);
            tokio::select! {
                _ = stopping => {},
                _ = &mut retiring => anyhow::bail!("retirement returned before its worker"),
            }
            // Same work-future cancellation as the Driver's outer stop select.
        }
        let retained = driver.derived.contains_key(&id);
        let worker_pending = matches!(
            completed.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        let waited = {
            let closing = async {
                for (_, mut producer) in driver.derived.drain() {
                    producer.stop().await;
                }
            };
            tokio::pin!(closing);
            let waited = futures_util::poll!(&mut closing).is_pending();
            release.send(())?;
            if waited {
                closing.await;
            }
            waited
        };
        completed.await?;
        driver.files.close().await;
        driver.watches.close().await;
        driver.transport.close().await;
        anyhow::ensure!(
            retained && worker_pending && waited,
            "cancelled derived retirement lost its pending worker join"
        );
        Ok(())
    }

    use super::*;
    use crate::media::{
        clock::SourceTime,
        video::{Layers, Video},
    };
    use rtc_shared::time::SystemInstant;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn optional_known_picture_and_sound_wait_then_admit_without_replacing_selected() -> Result<()> {
        use anyhow::ensure;
        use crate::peer::tests::support::{Fixture, vp8};

        let mut f = Fixture::new(vp8()).await?;
        let result = async {
            let sink = f.sink;
            f.publication.video_settings = None;
            let mut optional = f.publication.clone();
            optional.id = Uuid::new_v4();
            optional.session_id = Uuid::new_v4();
            optional.user_id = Uuid::new_v4();
            let input = f.plans[1].incoming[0].id;
            f.plans[1].incoming[0].publication_id = optional.id;
            let plan = f.plans.iter_mut().find(|pair| pair.id == sink).unwrap();
            let selected = plan.outgoing[0].id;
            let mut trial = plan.outgoing.remove(1);
            trial.id = Uuid::new_v4();
            trial.publication_id = optional.id;
            trial.input_flow_id = Some(input);
            let trial_id = trial.id;
            let publications = vec![f.publication.clone(), optional.clone()];
            f.driver.update(f.plans.clone(), publications.clone(), vec![]).await;
            // This is the existing allocator feedback seam. Actual RTCs retain their
            // own estimators; these observations are not measured physical link rates.
            let (feedback, observation) = watch::channel(transport::Estimate::Feedback(180_000.0));
            f.driver.pairs.get_mut(&sink).unwrap().bandwidth = observation;
            f.until(|f| f.frame >= 120 && [MediaKind::Video, MediaKind::Audio].iter().all(|kind| {
                f.driver.pairs[&sink].outputs.get(&(selected, *kind))
                    .is_some_and(|output| f.observed(&output.stream, *kind).is_some())
            })).await?;
            let selected_video = f.output(selected, MediaKind::Video);
            let selected_audio = f.output(selected, MediaKind::Audio);
            let before_video = f.observed(&selected_video.1, MediaKind::Video).unwrap();
            let before_audio = f.observed(&selected_audio.1, MediaKind::Audio).unwrap();
            f.driver.bandwidth_plans(Instant::now());
            let before_demand = *f.driver.pairs[&sink].demand.borrow();
            ensure!(before_demand.minimum_bps > 80_000 && before_demand.minimum_bps < 180_000,
                "fixture selected original cost is outside the controlled range: {before_demand:?}");

            let arrival = Instant::now();
            f.plans.iter_mut().find(|pair| pair.id == sink).unwrap().outgoing.push(trial);
            f.driver.update(f.plans.clone(), publications.clone(), vec![]).await;
            let start = f.frame;
            f.until(|f| f.frame >= start + 30).await?;
            let budgets = f.driver.bandwidth_plans(Instant::now());
            let waiting = &budgets[&sink];
            ensure!(waiting.waiting.contains(&trial_id) && !waiting.rejected.contains(&trial_id),
                "unstarted optional flow must wait for capacity");
            ensure!([MediaKind::Video, MediaKind::Audio].iter().all(|kind|
                !f.driver.pairs[&sink].outputs.contains_key(&(trial_id, *kind))),
                "optional picture and audio must not start separately");
            ensure!(f.output(selected, MediaKind::Video) == selected_video && f.output(selected, MediaKind::Audio) == selected_audio);
            let waiting_video = f.observed(&selected_video.1, MediaKind::Video).unwrap();
            let waiting_audio = f.observed(&selected_audio.1, MediaKind::Audio).unwrap();
            ensure!(waiting_video.0 == before_video.0 && waiting_video.1 == before_video.1
                && waiting_video.2.wrapping_sub(before_video.2) > 0);
            ensure!(waiting_audio.0 == before_audio.0 && waiting_audio.1 == before_audio.1
                && waiting_audio.2.wrapping_sub(before_audio.2) > 0);
            let waiting_demand = *f.driver.pairs[&sink].demand.borrow();
            ensure!(waiting_demand.desired_bps.is_some_and(|bps| bps > 180_000 && bps < 400_000),
                "known optional cost must reach SDK desired: {waiting_demand:?}");
            ensure!(waiting_demand.minimum_bps < 180_000,
                "unselected optional flow must not become the selected minimum");
            let raised = Instant::now();
            feedback.send(transport::Estimate::Feedback(400_000.0))?;
            f.driver.refresh_outputs().await;
            f.until(|f| [MediaKind::Video, MediaKind::Audio].iter().all(|kind| {
                f.driver.pairs[&sink].outputs.get(&(trial_id, *kind))
                    .is_some_and(|output| f.observed(&output.stream, *kind).is_some())
            })).await?;
            let admitted = Instant::now();
            let trial_video = f.output(trial_id, MediaKind::Video);
            let trial_audio = f.output(trial_id, MediaKind::Audio);
            ensure!(trial_video.1 == trial_audio.1, "optional companions must retain one flow stream");
            let progress_start = f.frame;
            let admitted_video = f.observed(&trial_video.1, MediaKind::Video).unwrap();
            let admitted_audio = f.observed(&trial_audio.1, MediaKind::Audio).unwrap();
            f.until(|f| f.frame >= progress_start + 30).await?;
            ensure!(f.output(selected, MediaKind::Video) == selected_video && f.output(selected, MediaKind::Audio) == selected_audio);
            let active_video = f.observed(&selected_video.1, MediaKind::Video).unwrap();
            let active_audio = f.observed(&selected_audio.1, MediaKind::Audio).unwrap();
            ensure!(active_video.2.wrapping_sub(waiting_video.2) > 0 && active_audio.2.wrapping_sub(waiting_audio.2) > 0);
            ensure!(f.observed(&trial_video.1, MediaKind::Video).unwrap().2.wrapping_sub(admitted_video.2) > 0);
            ensure!(f.observed(&trial_audio.1, MediaKind::Audio).unwrap().2.wrapping_sub(admitted_audio.2) > 0);
            let admitted_demand = *f.driver.pairs[&sink].demand.borrow();

            f.plans.iter_mut().find(|pair| pair.id == sink).unwrap().outgoing.retain(|flow| flow.id != trial_id);
            f.driver.update(f.plans.clone(), publications, vec![]).await;
            let release_start = f.frame;
            f.until(|f| f.frame >= release_start + 20).await?;
            ensure!([MediaKind::Video, MediaKind::Audio].iter().all(|kind|
                !f.driver.pairs[&sink].outputs.contains_key(&(trial_id, *kind))));
            ensure!(f.output(selected, MediaKind::Video) == selected_video && f.output(selected, MediaKind::Audio) == selected_audio);
            ensure!(f.observed(&selected_video.1, MediaKind::Video).unwrap().2.wrapping_sub(active_video.2) > 0);
            ensure!(f.observed(&selected_audio.1, MediaKind::Audio).unwrap().2.wrapping_sub(active_audio.2) > 0);
            f.driver.bandwidth_plans(Instant::now());
            let retired_demand = *f.driver.pairs[&sink].demand.borrow();
            ensure!(retired_demand.desired_bps.is_some_and(|bps| bps < 180_000));
            ensure!(!f.reported.iter().any(|command| matches!(command,
                Command::FlowState { flow_id, state: FlowState::Failed, .. } if *flow_id == selected)),
                "optional admission retired selected media");
            println!("NATIVE_ADMISSION before={before_demand:?} waiting={waiting_demand:?} admitted={admitted_demand:?} retired={retired_demand:?} wait_ms={} admitted_after_raise_ms={} selected_output_ids_retained=true picture_audio_progress=true trial_output_removed=true",
                raised.duration_since(arrival).as_millis(), admitted.duration_since(raised).as_millis());
            Ok::<_,anyhow::Error>(())
        }.await;
        f.close().await;
        result
    }

    #[tokio::test]
    async fn late_viewer_bootstraps_known_layers_before_feedback_then_keeps_its_floor() -> Result<()>
    {
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
        let floor = low.bitrate(now).unwrap() as u32;
        assert!(floor > 300_000);
        let full = high.bitrate(now).unwrap() as u32;
        let layers = Layers::new(vec!["q".into(), "h".into()]);
        layers.insert("q".into(), low.clone());
        layers.insert("h".into(), high.clone());
        let layers = crate::media::video::Supply(layers.snapshot());
        assert_eq!(layers.floor(now), Some(u64::from(floor)));
        let mut requests = [request(1, true, Some(0), Some((full, true)))];
        requests[0].video.as_mut().unwrap().floor_bps = Some(floor);
        let input = low.subscribe();
        let key = Uuid::from_u128(1);

        // Feedback below every layer keeps the cheapest one rather than pausing.
        let startup_number = allocate(Some(300_000), &requests);
        assert_eq!(
            startup_number.video[&key].forwarding,
            EncodingDemand::Limited(floor)
        );
        layers.select(&input, startup_number.video[&key].forwarding, now)?;
        assert!(low.needed() && !high.needed());

        let startup = allocate(None, &requests);
        layers.select(&input, startup.video[&key].forwarding, now)?;
        high.write(frame(64, 2100));
        let received = tokio::time::timeout(Duration::from_millis(100), input.recv()).await?;
        assert_eq!(
            received.unwrap().presentation_time,
            epoch + Duration::from_millis(2100)
        );

        // Real feedback constrains this same Output to its floor after bootstrap.
        let constrained = allocate(Some(100_000), &requests);
        layers.select(&input, constrained.video[&key].forwarding, now)?;
        assert!(low.needed() && !high.needed());
        let restored = allocate(Some(u64::from(full)), &requests);
        layers.select(&input, restored.video[&key].forwarding, now)?;
        high.write(frame(64, 2200));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), input.recv())
                .await?
                .is_some()
        );

        Ok(())
    }

    #[tokio::test]
    async fn sdk_minimum_tracks_selected_original_supply_and_its_lifecycle() -> Result<()> {
        // The actual Driver advertises original supply, independently of the
        // grant it gives this selected output. Unknown desired capacity must
        // not become a fabricated minimum.
        let mut f =
            crate::peer::tests::support::Fixture::new(crate::peer::tests::support::vp8()).await?;
        f.driver
            .publications
            .get_mut(&f.publication.id)
            .unwrap()
            .video_settings = None;
        let pair = f.driver.pairs.get_mut(&f.sink).unwrap();
        pair.plan.outgoing.retain(|flow| flow.selected);
        let flow = &mut pair.plan.outgoing[0];
        flow.input_flow_id = None;
        let flow_id = flow.id;
        pair.bandwidth = watch::channel(transport::Estimate::Feedback(100_000.0)).1;
        let epoch = Instant::now();
        let original = Video::new(
            SourceTime::local(epoch, SystemInstant::now(epoch)),
            Arc::new(Notify::new()),
        );
        original.set_codec(crate::peer::tests::support::vp8())?;
        let source_id = Uuid::new_v4();
        f.driver.sources.insert(
            source_id,
            Source {
                id: source_id,
                publication_id: f.publication.id,
                origin: crate::media::SourceOrigin::Local,
                kind: MediaKind::Video,
                feed: SourceFeed::Video(original.clone()),
                layers: None,
            },
        );
        let pair = f.driver.pairs.get_mut(&f.sink).unwrap();
        let output = crate::media::Output::new(
            &pair.pc,
            &f.driver.sources[&source_id],
            "selected-demand".into(),
            f.sink,
            (flow_id, MediaKind::Video),
            f.driver.events.clone(),
            pair.reports.clone(),
            false,
            false,
        )
        .await?;
        // This boundary starts with an already installed, stable output.
        pair.stable_outputs = Some(HashSet::from([output.id]));
        pair.outputs.insert((flow_id, MediaKind::Video), output);
        f.driver.bandwidth_plans(epoch);
        assert_eq!(
            *f.driver.pairs[&f.sink].demand.borrow(),
            BandwidthDemand {
                minimum_bps: 0,
                desired_bps: None,
            }
        );
        original.write(crate::EncodedFrame {
            bytes: vec![1; 512_000],
            presentation_time: epoch,
            keyframe: true,
            vp8: None,
        });
        let measured = epoch + Duration::from_secs(2);
        let original_bps = original.bitrate(measured).unwrap();
        assert!(original_bps > 100_000);
        let plan = f.driver.bandwidth_plans(measured);
        // Its only representation exceeds the estimate, so the grant keeps it.
        assert_eq!(
            plan[&f.sink].video[&flow_id].forwarding,
            EncodingDemand::Original
        );
        assert_eq!(
            *f.driver.pairs[&f.sink].demand.borrow(),
            BandwidthDemand {
                minimum_bps: original_bps,
                desired_bps: Some(original_bps),
            }
        );
        f.driver
            .publications
            .get_mut(&f.publication.id)
            .unwrap()
            .paused = true;
        f.driver.bandwidth_plans(measured);
        assert_eq!(
            *f.driver.pairs[&f.sink].demand.borrow(),
            BandwidthDemand {
                minimum_bps: 0,
                desired_bps: Some(0),
            }
        );
        f.driver
            .publications
            .get_mut(&f.publication.id)
            .unwrap()
            .paused = false;
        f.driver.bandwidth_plans(measured + Duration::from_secs(2));
        assert_eq!(f.driver.pairs[&f.sink].demand.borrow().minimum_bps, 0);
        f.driver.sources.remove(&source_id);
        f.driver.bandwidth_plans(measured + Duration::from_secs(2));
        assert_eq!(
            *f.driver.pairs[&f.sink].demand.borrow(),
            BandwidthDemand {
                minimum_bps: 0,
                desired_bps: None,
            }
        );
        f.driver
            .pairs
            .get_mut(&f.sink)
            .unwrap()
            .plan
            .outgoing
            .clear();
        f.driver.bandwidth_plans(measured + Duration::from_secs(2));
        assert_eq!(
            *f.driver.pairs[&f.sink].demand.borrow(),
            BandwidthDemand {
                minimum_bps: 0,
                desired_bps: Some(0),
            }
        );
        f.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn sdk_desired_retains_intent_and_preferred_supply_across_sibling_lifecycles(
    ) -> Result<()> {
        let mut f =
            crate::peer::tests::support::Fixture::new(crate::peer::tests::support::vp8()).await?;
        let pair = f.driver.pairs.get_mut(&f.sink).unwrap();
        pair.plan.outgoing.retain(|flow| flow.selected);
        pair.plan.outgoing[0].input_flow_id = None;
        // This restricted allocation must not become the desired-capacity input.
        pair.bandwidth = watch::channel(transport::Estimate::Feedback(100_000.0)).1;
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let low = Video::new(time.clone(), Arc::new(Notify::new()));
        let high = Video::new(time, Arc::new(Notify::new()));
        high.set_codec(crate::peer::tests::support::vp8())?;
        let layers = Layers::new(vec!["q".into(), "h".into()]);
        layers.insert("q".into(), low.clone());
        layers.insert("h".into(), high.clone());
        let video = Source {
            id: Uuid::new_v4(),
            publication_id: f.publication.id,
            origin: crate::media::SourceOrigin::Local,
            kind: MediaKind::Video,
            feed: SourceFeed::Video(high.clone()),
            layers: Some(layers),
        };
        let audio = Source {
            id: Uuid::new_v4(),
            publication_id: f.publication.id,
            origin: crate::media::SourceOrigin::Local,
            kind: MediaKind::Audio,
            feed: SourceFeed::Rtp {
                codec: crate::media::RtpCodec {
                    mime_type: "audio/opus".into(),
                    clock_rate: 48_000,
                    channels: 2,
                    ..Default::default()
                },
                keyframes: watch::channel(0).0,
                report: Default::default(),
            },
            layers: None,
        };
        let audio_id = audio.id;
        f.driver.sources.insert(video.id, video);
        f.driver.sources.insert(audio.id, audio);
        f.driver.bandwidth_plans(epoch);
        assert_eq!(f.driver.pairs[&f.sink].demand.borrow().desired_bps, None);

        for (video, bytes) in [(&low, 128_000), (&high, 512_000)] {
            video.write(crate::EncodedFrame {
                bytes: vec![1; bytes],
                presentation_time: epoch,
                keyframe: true,
                vp8: None,
            });
        }
        let measured = epoch + Duration::from_secs(2);
        let high_bps = high.bitrate(measured).unwrap();
        let aggregate_bps = high_bps + low.bitrate(measured).unwrap();
        assert!(aggregate_bps < 5_000_000 && high_bps > 100_000);
        f.driver.bandwidth_plans(measured);
        // Known video intent/supply does not resolve an unmeasured sibling.
        assert_eq!(f.driver.pairs[&f.sink].demand.borrow().desired_bps, None);
        f.driver.relay.set(audio_id, vec![]);
        f.driver.relay.write(
            audio_id,
            rtp::Packet {
                payload: vec![0; 16_000].into(),
                ..Default::default()
            },
        );
        let audio_bps = f.driver.relay.bitrate(audio_id, measured).unwrap();
        assert!(audio_bps > 0);
        f.driver.bandwidth_plans(measured);
        assert_eq!(
            f.driver.pairs[&f.sink].demand.borrow().desired_bps,
            Some(5_000_000 + audio_bps)
        );

        // OBS-style absent settings use preferred original supply, not the grant.
        f.driver
            .publications
            .get_mut(&f.publication.id)
            .unwrap()
            .video_settings = None;
        f.driver.bandwidth_plans(measured);
        assert_eq!(
            f.driver.pairs[&f.sink].demand.borrow().desired_bps,
            Some(high_bps + audio_bps)
        );
        f.driver
            .pairs
            .get_mut(&f.sink)
            .unwrap()
            .plan
            .can_receive_video_layers = true;
        f.driver.bandwidth_plans(measured);
        assert_eq!(
            f.driver.pairs[&f.sink].demand.borrow().desired_bps,
            Some(aggregate_bps + audio_bps)
        );

        // A second publication retains its announced intent before source arrival.
        let mut second = f.publication.clone();
        second.id = Uuid::new_v4();
        second.video_settings.as_mut().unwrap().ceiling.max_bitrate = 2_000_000;
        f.driver.publications.insert(second.id, second.clone());
        let pair = f.driver.pairs.get_mut(&f.sink).unwrap();
        let mut flow = pair.plan.outgoing[0].clone();
        flow.id = Uuid::new_v4();
        flow.publication_id = second.id;
        pair.plan.outgoing.push(flow);
        f.driver.bandwidth_plans(measured);
        assert_eq!(
            f.driver.pairs[&f.sink].demand.borrow().desired_bps,
            Some(aggregate_bps + audio_bps + 2_000_000)
        );
        f.driver.publications.get_mut(&second.id).unwrap().paused = true;
        f.driver.bandwidth_plans(measured);
        assert_eq!(
            f.driver.pairs[&f.sink].demand.borrow().desired_bps,
            Some(aggregate_bps + audio_bps)
        );

        let idle = measured + Duration::from_secs(2);
        f.driver.bandwidth_plans(idle);
        // Complete zero observations are idle, not unknown source ceilings.
        assert_eq!(f.driver.pairs[&f.sink].demand.borrow().desired_bps, Some(0));
        f.driver
            .publications
            .get_mut(&f.publication.id)
            .unwrap()
            .video_settings = f.publication.video_settings;
        f.driver.bandwidth_plans(idle);
        assert_eq!(
            f.driver.pairs[&f.sink].demand.borrow().desired_bps,
            Some(5_000_000)
        );
        f.driver
            .publications
            .get_mut(&f.publication.id)
            .unwrap()
            .paused = true;
        f.driver.bandwidth_plans(idle);
        assert_eq!(f.driver.pairs[&f.sink].demand.borrow().desired_bps, Some(0));
        f.close().await;
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
                floor_bps: None,
                requires_conversion: false,
                ceiling_bps: None,
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
            assert_eq!(plan.video[&selected].forwarding, EncodingDemand::Paused);
            assert_eq!(plan.video[&optional].forwarding, EncodingDemand::Paused);
            assert!(plan.rejected.is_empty());
            let unprotected = allocate(Some(0), &requests[1..]);
            assert_eq!(
                unprotected.video[&optional].forwarding,
                EncodingDemand::Paused
            );

            let plan = allocate(Some(300_000), &requests);
            assert_eq!(plan.video[&selected].forwarding, EncodingDemand::Original);
            assert_eq!(
                plan.video[&optional].forwarding,
                if full_bps.is_none() {
                    EncodingDemand::Paused
                } else {
                    EncodingDemand::Original
                }
            );
            let startup = allocate(None, &requests);
            assert_eq!(
                startup.video[&selected].forwarding,
                EncodingDemand::Original
            );
            assert_eq!(startup.video[&optional].forwarding, EncodingDemand::Paused);

            // A silent or unmeasured picture cannot spend the budget reserved
            // for source sound or voice. A positive remainder still wakes it.
            requests[0].opaque_bps = 100_000;
            let plan = allocate(Some(100_000), &requests[..1]);
            assert_eq!(plan.video[&selected].forwarding, EncodingDemand::Paused);
            let plan = allocate(Some(200_000), &requests[..1]);
            assert_eq!(plan.video[&selected].forwarding, EncodingDemand::Original);
        }

        let mut requests = vec![
            request(1, true, Some(0), Some((600_000, true))),
            request(2, false, Some(0), Some((300_000, true))),
        ];
        requests[1].started = true;
        let plan = allocate(Some(900_000), &requests);
        assert_eq!(plan.video[&selected].forwarding, EncodingDemand::Original);
        assert_eq!(plan.video[&optional].forwarding, EncodingDemand::Original);
        let plan = allocate(Some(300_000), &requests);
        assert_eq!(
            plan.video[&selected].forwarding,
            EncodingDemand::Limited(300_000)
        );
        assert!(plan.rejected.contains(&optional));
        let plan = allocate(Some(0), &requests[..1]);
        assert_eq!(plan.video[&selected].forwarding, EncodingDemand::Paused);

        requests[0].measured = false;
        let plan = allocate(Some(900_000), &requests);
        assert!(plan.waiting.contains(&optional));
        assert_eq!(plan.video[&optional].forwarding, EncodingDemand::Paused);
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
        assert_eq!(
            plan.video[&requests[0].id].forwarding,
            EncodingDemand::Original
        );
        assert_eq!(plan.waiting.len(), 2);
        requests[1].video.as_mut().unwrap().stable = true;
        let plan = allocate(Some(1_000_000), &requests);
        assert_eq!(
            plan.video[&requests[0].id].forwarding,
            EncodingDemand::Limited(600_000)
        );
        assert_eq!(
            plan.video[&requests[1].id].forwarding,
            EncodingDemand::Limited(300_000)
        );
        let plan = allocate(Some(2_500_000), &requests);
        assert_eq!(
            plan.video[&requests[2].id].forwarding,
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
            plan.video[&independent[3].id].forwarding,
            EncodingDemand::Limited(900_000)
        );
    }
    fn allocate(target: Option<u64>, requests: &[Request]) -> BandwidthPlan {
        super::allocate(
            target.map_or(transport::Estimate::Startup(300_000.0), |bps| {
                transport::Estimate::Feedback(bps as f64)
            }),
            requests,
        )
    }

    #[test]
    fn conversion_uses_spare_capacity_without_changing_ordinary_weights() {
        let mut requests = vec![
            request(1, true, Some(0), Some((750_000, true))),
            request(2, true, Some(0), Some((1_500_000, true))),
            request(3, false, Some(0), Some((300_000, true))),
        ];
        requests[0].video.as_mut().unwrap().requires_conversion = true;
        let converted = requests[0].id;
        let ordinary = requests[1].id;
        let optional = requests[2].id;

        let full = allocate(Some(4_000_000), &requests);
        assert_eq!(full.video[&converted].encoder_bps, 2_500_000);
        assert_eq!(full.video[&converted].forwarding, EncodingDemand::Original);
        assert_eq!(full.video[&ordinary].encoder_bps, 1_500_000);
        assert_eq!(full.video[&ordinary].forwarding, EncodingDemand::Original);
        assert!(full.waiting.contains(&optional));

        // Existing 1:2 weights also apply under constrained feedback.
        let constrained = allocate(Some(900_000), &requests[..2]);
        assert_eq!(constrained.video[&converted].encoder_bps, 300_000);
        assert_eq!(constrained.video[&ordinary].encoder_bps, 600_000);
        assert_eq!(
            constrained.video[&ordinary].forwarding,
            EncodingDemand::Limited(600_000)
        );

        // A real configured ceiling can leave capacity for ordinary trials.
        requests[0].video.as_mut().unwrap().ceiling_bps = Some(1_000_000);
        let capped = allocate(Some(4_000_000), &requests);
        assert_eq!(capped.video[&converted].encoder_bps, 1_000_000);
        assert_eq!(capped.video[&ordinary].encoder_bps, 1_500_000);
        assert_eq!(capped.video[&optional].forwarding, EncodingDemand::Original);
        assert!(capped.waiting.is_empty());

        // Optional conversion must not reintroduce its ingress cost as a cap.
        requests[0].video.as_mut().unwrap().requires_conversion = false;
        requests[2].video.as_mut().unwrap().requires_conversion = true;
        let optional_conversion = allocate(Some(4_000_000), &requests);
        assert_eq!(optional_conversion.video[&optional].encoder_bps, 1_750_000);
    }

    #[test]
    fn conversion_bootstraps_unknown_and_static_sources_without_changing_forwarding() {
        // Input bitrate is not the cost of the required compatible encoding.
        // Neither a known original nor the startup allocation invents its target.
        for original in [None, Some(0), Some(8_000_000)] {
            assert_eq!(desired_bitrate(None, None, original, true), None);
            assert_eq!(
                desired_bitrate(None, Some(5_000_000), original, true),
                Some(5_000_000)
            );
            assert_eq!(
                desired_bitrate(Some(3_000_000), Some(5_000_000), original, true),
                Some(3_000_000)
            );
        }
        for full_bps in [None, Some(0)] {
            let mut source = request(1, true, Some(0), Some((0, true)));
            let video = source.video.as_mut().unwrap();
            video.full_bps = full_bps;
            video.requires_conversion = true;
            let id = source.id;
            let startup = allocate(None, std::slice::from_ref(&source));
            assert_eq!(startup.video[&id].encoder_bps, 300_000);
            assert_eq!(startup.video[&id].forwarding, EncodingDemand::Original);
            let feedback = allocate(Some(1_000_000), std::slice::from_ref(&source));
            assert_eq!(feedback.video[&id].encoder_bps, 1_000_000);
            let stopped = allocate(Some(0), std::slice::from_ref(&source));
            assert_eq!(stopped.video[&id], PAUSED);

            source.video.as_mut().unwrap().requires_conversion = false;
            let ordinary = allocate(None, std::slice::from_ref(&source));
            assert_eq!(ordinary.video[&id].forwarding, EncodingDemand::Original);
        }

        let mut requests = [
            request(1, true, Some(100_000), Some((0, true))),
            request(2, true, Some(0), Some((0, true))),
        ];
        for request in &mut requests {
            request.video.as_mut().unwrap().requires_conversion = true;
        }
        let startup = allocate(None, &requests);
        assert_eq!(startup.video[&requests[0].id].encoder_bps, 100_000);
        assert_eq!(startup.video[&requests[1].id].encoder_bps, 100_000);
    }

    #[test]
    fn optional_trials_start_only_when_their_floor_fits() {
        // Observed: a selected feed and a started trial of the same single
        // 121,722 bps representation, each with audio, on 187,043 bps feedback.
        let estimate = Some(187_043);
        let incumbent = Uuid::from_u128(1);
        let trial = Uuid::from_u128(2);
        let requests = |floor| {
            let mut requests = [
                request(1, true, Some(5_975), Some((121_722, true))),
                request(2, false, Some(5_976), Some((121_722, true))),
            ];
            requests[0].video.as_mut().unwrap().floor_bps = Some(121_722);
            requests[1].video.as_mut().unwrap().floor_bps = floor;
            requests[1].started = true;
            requests
        };
        // An unknown floor keeps today's grant: the remainder after the incumbent.
        let plan = allocate(estimate, &requests(None));
        assert_eq!(plan.video[&incumbent].forwarding, EncodingDemand::Original);
        assert_eq!(
            plan.video[&trial].forwarding,
            EncodingDemand::Limited(53_370)
        );

        let plan = allocate(estimate, &requests(Some(121_722)));
        assert_eq!(plan.video[&incumbent].forwarding, EncodingDemand::Original);
        assert!(plan.rejected.contains(&trial) && !plan.video.contains_key(&trial));

        // A cheaper representation fits exactly; an encoder serves any grant.
        for floor in [53_370, 0] {
            let plan = allocate(estimate, &requests(Some(floor)));
            assert!(plan.rejected.is_empty() && plan.waiting.is_empty());
            assert_eq!(
                plan.video[&trial].forwarding,
                EncodingDemand::Limited(53_370)
            );
        }
        let mut below = requests(Some(53_371));
        assert!(allocate(estimate, &below).rejected.contains(&trial));
        below[1].started = false;
        below[1].video.as_mut().unwrap().stable = false;
        let plan = allocate(estimate, &below);
        assert!(plan.waiting.contains(&trial) && plan.rejected.is_empty());

        // A static source costs nothing, so a positive remainder wakes it.
        let mut idle = requests(Some(0));
        idle[1].video.as_mut().unwrap().full_bps = Some(0);
        let plan = allocate(estimate, &idle);
        assert!(plan.rejected.is_empty() && plan.waiting.is_empty());
        assert_eq!(plan.video[&trial].forwarding, EncodingDemand::Original);

        // An unmeasured trial and the no-feedback startup wait as before.
        let mut unknown = requests(None);
        unknown[1].measured = false;
        unknown[1].video.as_mut().unwrap().full_bps = None;
        let plan = allocate(estimate, &unknown);
        assert!(plan.waiting.contains(&trial) && plan.video[&trial] == PAUSED);
        let plan = allocate(None, &requests(Some(121_722)));
        assert_eq!(plan.video[&incumbent].forwarding, EncodingDemand::Original);
        assert!(plan.waiting.contains(&trial) && plan.video[&trial] == PAUSED);
    }

    #[test]
    fn trials_without_an_incumbent_start_only_when_their_floor_fits() {
        let trial = Uuid::from_u128(2);
        let mut requests = [request(2, false, Some(5_976), Some((121_722, true)))];
        requests[0].started = true;
        requests[0].video.as_mut().unwrap().floor_bps = Some(121_722);
        let plan = allocate(Some(59_346), &requests);
        assert!(plan.rejected.contains(&trial) && !plan.video.contains_key(&trial));
        let plan = allocate(Some(121_722 + 5_976), &requests);
        assert!(plan.rejected.is_empty());
        assert_eq!(plan.video[&trial].forwarding, EncodingDemand::Original);
        // The startup estimate still bootstraps the trial.
        let plan = allocate(None, &requests);
        assert!(plan.rejected.is_empty());
        assert_eq!(plan.video[&trial].forwarding, EncodingDemand::Original);
        requests[0].started = false;
        requests[0].video.as_mut().unwrap().stable = false;
        let plan = allocate(Some(59_346), &requests);
        assert!(plan.waiting.contains(&trial) && plan.rejected.is_empty());
    }

    #[test]
    fn selected_video_keeps_its_floor_before_optional_work() {
        let selected = Uuid::from_u128(1);
        let optional = Uuid::from_u128(2);
        let mut requests = [
            request(1, true, Some(0), Some((600_000, true))),
            request(2, false, Some(0), Some((50_000, true))),
        ];
        requests[0].video.as_mut().unwrap().floor_bps = Some(200_000);
        requests[1].video.as_mut().unwrap().floor_bps = Some(10_000);
        requests[1].started = true;
        // Above its temporal base layer, the selected grant follows the estimate.
        let plan = allocate(Some(300_000), &requests);
        assert_eq!(
            plan.video[&selected].forwarding,
            EncodingDemand::Limited(300_000)
        );
        // Below it, the floor is kept and charged before any optional work.
        let plan = allocate(Some(150_000), &requests);
        assert_eq!(
            plan.video[&selected],
            VideoAllocation {
                forwarding: EncodingDemand::Limited(200_000),
                encoder_bps: 200_000,
            }
        );
        assert!(plan.rejected.contains(&optional) && !plan.video.contains_key(&optional));
        // A single representation stays whole rather than pausing.
        requests[0].video.as_mut().unwrap().floor_bps = Some(600_000);
        let plan = allocate(Some(150_000), &requests[..1]);
        assert_eq!(plan.video[&selected].forwarding, EncodingDemand::Original);
    }

    #[test]
    fn simultaneous_optional_floors_leave_a_usable_route() {
        let mut requests = [
            request(1, false, Some(0), Some((150_000, true))),
            request(2, false, Some(0), Some((100_000, true))),
            request(3, false, Some(50_000), None),
        ];
        for r in &mut requests[..2] {
            r.started = true;
            r.video.as_mut().unwrap().floor_bps = Some(100_000);
        }
        let plan = allocate(Some(150_000), &requests);
        assert_eq!(plan.rejected.len(), 1);
        assert_eq!(plan.video.len(), 1);
        assert_eq!(plan.video[&requests[0].id].encoder_bps, 100_000);
        assert!(!plan.waiting.contains(&requests[2].id));
        let plan = allocate(Some(255_000), &requests);
        assert!(plan.rejected.is_empty());
        assert_eq!(plan.video[&requests[0].id].encoder_bps, 105_000);
        assert_eq!(plan.video[&requests[1].id].encoder_bps, 100_000);
    }

    #[test]
    fn an_active_encodable_trial_requires_a_positive_grant() {
        let mut request = request(1, false, Some(6_000), Some((120_000, true)));
        request.video.as_mut().unwrap().floor_bps = Some(0);
        request.started = true;
        let plan = allocate(Some(6_000), &[request]);
        assert_eq!(plan.rejected.len(), 1);
    }
}
