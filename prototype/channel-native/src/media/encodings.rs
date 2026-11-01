//! The actual encoder instances and Input selections for one video source.
use super::{
    clock::SourceTime,
    video::{EncodingDemand, Input, Video},
    H264Sps, Source,
};
use crate::capture::{Encoding, EncodingControl};
use anyhow::Result;
use futures_util::{stream::FuturesUnordered, StreamExt};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Weak},
    time::Instant,
};
use tokio::sync::{watch, Notify};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct VideoDemand {
    pub output: Uuid,
    pub rid: String,
    pub input: Weak<Input>,
    pub encoding: EncodingDemand,
    pub source: Option<Video>,
}
impl VideoDemand {
    fn key(&self) -> (Uuid, String) {
        (self.output, self.rid.clone())
    }
}
impl PartialEq for VideoDemand {
    fn eq(&self, other: &Self) -> bool {
        self.output == other.output
            && self.rid == other.rid
            && self.input.ptr_eq(&other.input)
            && self.encoding == other.encoding
            && match (&self.source, &other.source) {
                (Some(a), Some(b)) => a.same(b),
                (None, None) => true,
                _ => false,
            }
    }
}
/// Resolve a single output grant without changing its readers. This producer's
/// Encodings remains the sole writer for both direct and derived selections.
pub(crate) fn demands(
    source: &Source,
    output: Uuid,
    inputs: Vec<(String, Weak<Input>)>,
    grant: EncodingDemand,
    now: Instant,
) -> Vec<VideoDemand> {
    let layers = source
        .layers
        .as_ref()
        .map(|layers| layers.snapshot())
        .unwrap_or_else(|| vec![(String::new(), source.video().cloned())]);
    let feeds: Vec<_> = layers
        .iter()
        .filter_map(|(rid, video)| video.as_ref().map(|video| (rid, video, video.bitrate(now))))
        .collect();
    let highest = feeds
        .iter()
        .rev()
        .find(|(_, _, rate)| rate.is_some_and(|bps| bps > 0))
        .or_else(|| feeds.last())
        .map(|(_, video, _)| *video);
    let mut remaining = match grant {
        EncodingDemand::Original => u64::MAX,
        EncodingDemand::Limited(bps) => u64::from(bps),
        EncodingDemand::Paused => 0,
    };
    inputs
        .into_iter()
        .filter(|(_, input)| input.upgrade().is_some_and(|input| !input.is_closed()))
        .map(|(rid, input)| {
            let terminal = rid.is_empty();
            let feed = if terminal {
                feeds
                    .iter()
                    .rev()
                    .find(|(_, _, rate)| rate.is_some_and(|bps| bps > 0 && bps <= remaining))
                    .map(|(_, video, _)| *video)
                    .or(highest)
            } else {
                feeds
                    .iter()
                    .find(|(id, _, _)| **id == rid)
                    .map(|(_, video, _)| *video)
            };
            let mut selected = feed.cloned();
            let encoding = match feed {
                None => EncodingDemand::Paused,
                Some(_) if remaining == 0 => EncodingDemand::Paused,
                Some(_) if grant == EncodingDemand::Original => EncodingDemand::Original,
                Some(video) => {
                    let cost = feeds
                        .iter()
                        .find(|(_, candidate, _)| candidate.same(video))
                        .unwrap()
                        .2;
                    match cost {
                        Some(cost) if cost > 0 && cost <= remaining => {
                            remaining -= cost;
                            EncodingDemand::Original
                        }
                        Some(cost) if cost > 0 => {
                            selected = highest.cloned();
                            let budget = remaining as u32;
                            remaining = 0;
                            EncodingDemand::Limited(budget)
                        }
                        _ => {
                            // Unknown/idle first delivery uses the existing positive
                            // grant bootstrap, once for this cumulative RID supply.
                            if cost.is_none()
                                || input.upgrade().is_some_and(|input| input.needs_picture())
                            {
                                remaining = 0;
                            }
                            EncodingDemand::Original
                        }
                    }
                }
            };
            VideoDemand {
                output,
                rid,
                input,
                encoding,
                source: selected,
            }
        })
        .collect()
}

type Pump = Pin<Box<dyn Future<Output = (Video, Result<()>)> + Send>>;
struct Entry {
    video: Video,
    control: EncodingControl,
    encoding: EncodingDemand,
}
impl Entry {
    fn retire(self) {
        self.control.stop();
        self.video.request_keyframe();
    }
}
pub(crate) struct Encodings {
    baseline: Option<Entry>,
    supplied: Option<Entry>,
    limited: HashMap<(Uuid, String), Entry>,
    inputs: HashMap<(Uuid, String), Weak<Input>>,
    pub pumps: FuturesUnordered<Pump>,
    time: SourceTime,
    pub changed: Arc<Notify>,
}
impl Encodings {
    pub fn new(time: SourceTime, changed: Arc<Notify>) -> Self {
        Self {
            baseline: None,
            supplied: None,
            limited: HashMap::new(),
            inputs: HashMap::new(),
            pumps: FuturesUnordered::new(),
            time,
            changed,
        }
    }
    fn entry(
        &mut self,
        encoding: Encoding,
        video: Video,
        kind: EncodingDemand,
        requests: watch::Receiver<u64>,
        external: Option<Arc<Input>>,
    ) -> Entry {
        let control = encoding.control();
        self.pumps
            .push(pump(encoding, video.clone(), requests, external));
        Entry {
            video,
            control,
            encoding: kind,
        }
    }
    pub fn baseline(&mut self, encoding: Encoding, video: Video, requests: watch::Receiver<u64>) {
        self.baseline = Some(self.entry(encoding, video, EncodingDemand::Original, requests, None));
    }
    /// A source-supplied representation shares the baseline's reader-driven pump
    /// and warm, bounded queue; it does not allocate per downstream output.
    pub fn supplied(&mut self, encoding: Encoding, video: Video) {
        let requests = video.requests();
        self.supplied = Some(self.entry(encoding, video, EncodingDemand::Original, requests, None));
    }
    /// `external` is the decoder's selected upstream Input. Original demands
    /// select their supplied feed; only Limited demands allocate an encoder.
    /// Only real demand changes call this method. Adoption merely retires unused
    /// entries, so an allocation failure cannot spin into automatic retries.
    pub fn reconcile(
        &mut self,
        next: &[VideoDemand],
        external: Option<&Arc<Input>>,
        mut encode: impl FnMut(u32) -> Result<Encoding>,
    ) -> Vec<Video> {
        self.inputs.retain(|id, input| {
            let keep = next.iter().any(|d| d.key() == *id && d.input.ptr_eq(input));
            if !keep {
                if let Some(input) = input.upgrade() {
                    input.set_active(false);
                }
            }
            keep
        });
        for d in next {
            self.inputs.insert(d.key(), d.input.clone());
        }
        let mut failed = Vec::new();
        for demand in next
            .iter()
            .filter(|d| d.encoding == EncodingDemand::Original)
        {
            if let Some(video) = &demand.source {
                select(demand, video, false);
            }
        }
        for demand in next {
            let bitrate = match demand.encoding {
                EncodingDemand::Original => continue,
                EncodingDemand::Paused => {
                    if let Some(input) = demand.input.upgrade() {
                        input.set_active(false);
                    }
                    continue;
                }
                EncodingDemand::Limited(bitrate) => bitrate,
            };
            if let Some(entry) = self.limited.get_mut(&demand.key()) {
                if select(demand, &entry.video, true) && entry.encoding != demand.encoding {
                    if let Err(error) = entry.control.set_bitrate(bitrate) {
                        eprintln!("Native output encoding failed: {error:#}");
                        let entry = self.limited.remove(&demand.key()).unwrap();
                        failed.push(entry.video.clone());
                        entry.retire();
                    } else {
                        entry.encoding = demand.encoding;
                    }
                }
            } else {
                let video = Video::new(self.time.clone(), self.changed.clone());
                let requests = video.requests();
                if !select(demand, &video, true) {
                    continue;
                }
                match encode(bitrate) {
                    Ok(encoding) => {
                        let entry = self.entry(
                            encoding,
                            video,
                            demand.encoding,
                            requests,
                            external.cloned(),
                        );
                        self.limited.insert(demand.key(), entry);
                    }
                    Err(error) => {
                        eprintln!("Native output encoding failed: {error:#}");
                        failed.push(video);
                    }
                }
            }
        }
        self.retire_unused();
        failed
    }
    pub fn retired_or_failed(&mut self, video: &Video, result: Result<()>) -> bool {
        let owned = if self.supplied.as_ref().is_some_and(|e| e.video.same(video)) {
            self.supplied.take();
            true
        } else if self.baseline.as_ref().is_some_and(|e| e.video.same(video)) {
            self.baseline.take();
            true
        } else {
            let id = self
                .limited
                .iter()
                .find(|(_, e)| e.video.same(video))
                .map(|(id, _)| id.clone());
            id.is_some_and(|id| self.limited.remove(&id).is_some())
        };
        if let Err(error) = result {
            eprintln!(
                "Native {} encoding ended: {error:#}",
                if owned { "active" } else { "retired" }
            );
        }
        owned
    }
    pub fn retire_unused(&mut self) {
        let retired: Vec<_> = self
            .limited
            .iter()
            .filter(|(_, e)| !e.video.needed())
            .map(|(id, _)| id.clone())
            .collect();
        for id in retired {
            self.limited.remove(&id).unwrap().retire();
        }
    }
    pub fn has_limited(&self) -> bool {
        !self.limited.is_empty()
    }
    pub fn take_failed(&mut self) -> Vec<Video> {
        self.limited
            .drain()
            .map(|(_, entry)| {
                let video = entry.video.clone();
                entry.retire();
                video
            })
            .collect()
    }
    pub async fn stop(mut self) {
        if let Some(entry) = self.supplied.take() {
            entry.retire();
        }
        if let Some(entry) = self.baseline.take() {
            entry.retire();
        }
        for (_, entry) in self.limited.drain() {
            entry.retire();
        }
        while self.pumps.next().await.is_some() {}
    }
}
pub(crate) fn select(demand: &VideoDemand, video: &Video, required: bool) -> bool {
    let Some(input) = demand.input.upgrade() else {
        return false;
    };
    if input.select(video, required).is_err() {
        return false;
    }
    input.set_active(true);
    true
}
pub(crate) async fn stop(encoding: Encoding) -> Result<()> {
    encoding.control().stop();
    tokio::task::spawn_blocking(move || encoding.stop()).await?
}
fn pump(
    mut encoding: Encoding,
    video: Video,
    mut requests: watch::Receiver<u64>,
    external: Option<Arc<Input>>,
) -> Pump {
    Box::pin(async move {
        let control = encoding.control();
        let mut sps = H264Sps::default();
        let result = async {
            while !control.is_stopped() {
                tokio::select! {
                    frame = encoding.recv(), if video.needed() => match frame {
                        Some(frame) => { let frame = frame?; sps.access_unit(&frame.bytes)?; video.write(frame); }
                        None => break,
                    },
                    changed = requests.changed() => {
                        changed?;
                        if video.needed() && !control.is_stopped() {
                            control.force_keyframe()?;
                            if let Some(external) = &external {
                                external.request_keyframe();
                            }
                        }
                    }
                }
            }
            Ok(())
        }.await;
        (video, result.and(stop(encoding).await))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EncodedFrame;
    use rtc::shared::time::SystemInstant;
    use std::time::Duration;

    #[tokio::test]
    async fn layered_h264_demands_forward_or_derive_per_reader_with_one_grant() -> Result<()> {
        use crate::media::{video::Layers, SourceFeed, SourceOrigin};
        use rtc::rtp_transceiver::rtp_sender::{RTCRtpCodec, RtpCodecKind};
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let changed = Arc::new(Notify::new());
        let q = Video::new(time.clone(), changed.clone());
        let h = Video::new(time.clone(), changed.clone());
        let frame = |bytes| EncodedFrame {
            bytes: vec![1; bytes],
            vp8: None,
            keyframe: true,
            presentation_time: Instant::now(),
        };
        q.write(frame(125_000));
        h.write(frame(500_000));
        let now = Instant::now() + Duration::from_secs(1);
        let q_cost = q.bitrate(now).unwrap() as u32;
        let layers = Layers::new(vec!["small".into(), "large".into()]);
        layers.insert("small".into(), q.clone());
        layers.insert("large".into(), h.clone());
        let source = Source {
            id: Uuid::new_v4(),
            publication_id: Uuid::new_v4(),
            origin: SourceOrigin::Incoming {
                pair: Uuid::new_v4(),
                flow_id: Uuid::new_v4(),
                stream: "one".into(),
            },
            kind: RtpCodecKind::Video,
            codec: RTCRtpCodec {
                mime_type: "video/H264".into(),
                clock_rate: 90_000,
                ..Default::default()
            },
            // q arrived first: it is an anchor, not the permanent decoding source.
            feed: SourceFeed::Video(q.clone()),
            layers: Some(layers.clone()),
        };
        let a = Input::new(time.clone(), changed.clone());
        let b = Input::new(time.clone(), changed.clone());
        let healthy = Input::new(time.clone(), changed.clone());
        let resolve = |input: &Arc<Input>, budget| {
            demands(
                &source,
                Uuid::nil(),
                vec![(String::new(), Arc::downgrade(input))],
                budget,
                now,
            )
        };
        let da = resolve(&a, EncodingDemand::Limited(200_000));
        let db = resolve(&b, EncodingDemand::Limited(400_000));
        assert_eq!(da[0].encoding, EncodingDemand::Limited(200_000));
        assert_eq!(db[0].encoding, EncodingDemand::Limited(400_000));
        assert!(da[0].source.as_ref().unwrap().same(&h));
        assert!(db[0].source.as_ref().unwrap().same(&h));
        let full = resolve(&healthy, EncodingDemand::Original);
        select(&full[0], full[0].source.as_ref().unwrap(), false);
        h.write(frame(20));
        assert!(healthy.recv().await.is_some());
        let fitting = resolve(&a, EncodingDemand::Limited(q_cost + 1));
        assert_eq!(fitting[0].encoding, EncodingDemand::Original);
        assert!(fitting[0].source.as_ref().unwrap().same(&q));

        let qi = Input::new(time.clone(), changed.clone());
        let hi = Input::new(time.clone(), changed.clone());
        let readers = || {
            vec![
                ("small".into(), Arc::downgrade(&qi)),
                ("large".into(), Arc::downgrade(&hi)),
            ]
        };
        let supply = demands(
            &source,
            Uuid::nil(),
            readers(),
            EncodingDemand::Limited(q_cost + 300_000),
            now,
        );
        assert_eq!(supply[0].encoding, EncodingDemand::Original);
        assert_eq!(supply[1].encoding, EncodingDemand::Limited(300_000));
        assert_ne!(supply[0].rid, supply[1].rid);
        let limited = demands(
            &source,
            Uuid::nil(),
            readers(),
            EncodingDemand::Limited(200_000),
            now,
        );
        assert_eq!(limited[0].encoding, EncodingDemand::Limited(200_000));
        assert_eq!(limited[1].encoding, EncodingDemand::Paused);
        assert!(
            demands(&source, Uuid::nil(), readers(), EncodingDemand::Paused, now)
                .iter()
                .all(|d| d.encoding == EncodingDemand::Paused)
        );

        // A cost change with an unchanged grant must change the resolved demand.
        q.write(frame(20_000));
        let cheaper = demands(
            &source,
            Uuid::nil(),
            vec![(String::new(), Arc::downgrade(&a))],
            EncodingDemand::Limited(200_000),
            now + Duration::from_secs(1),
        );
        assert_eq!(cheaper[0].encoding, EncodingDemand::Original);
        assert!(da != cheaper);
        // Replacing an SSRC keeps the source clock but changes the real feed identity.
        let successor = Video::new(time, changed);
        successor.write(frame(500_000));
        layers.insert("large".into(), successor.clone());
        let replaced = demands(
            &source,
            Uuid::nil(),
            vec![(String::new(), Arc::downgrade(&a))],
            EncodingDemand::Original,
            now + Duration::from_secs(1),
        );
        assert!(replaced[0].source.as_ref().unwrap().same(&successor));
        // The same inventory/grant contract applies at the local capture owner,
        // not just after receiving the source over a PC.
        let local = Source {
            origin: SourceOrigin::Local,
            ..source
        };
        let local_low = demands(
            &local,
            Uuid::nil(),
            readers(),
            EncodingDemand::Limited(1),
            now,
        );
        assert_eq!(local_low[0].encoding, EncodingDemand::Limited(1));
        assert_eq!(local_low[1].encoding, EncodingDemand::Paused);
        assert!(local_low[0].source.as_ref().unwrap().same(&successor));
        // Failure of a per-output encoding is not loss of a supplied RID.
        let private = Video::new(successor.time(), successor.changed());
        assert!(!layers.retire(&private));
        assert!(layers.snapshot().iter().all(|(_, video)| video.is_some()));
        // A queued SourceReady holds the same inventory before Driver admission.
        assert!(layers.retire(&q));
        assert!(local.layers.as_ref().unwrap().snapshot()[0].1.is_none());
        assert!(!layers.retire(&q));
        Ok(())
    }
}
