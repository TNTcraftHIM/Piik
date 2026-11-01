//! Complete video access units. Each output encoding selects a feed and recovers
//! independently when its finite queue cannot keep up.
use super::{clock::SourceTime, Rate};
use crate::EncodedFrame;
use anyhow::{ensure, Result};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Notify};

mod temporal;
use temporal::{Decision, Rates, Temporal};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EncodingDemand {
    Original,
    Limited(u32),
    Paused,
}

/// Received representations of one source. The reader owns their SSRCs and
/// assembly; outputs select these complete-frame feeds without decoding them.
#[derive(Clone)]
pub(crate) struct Layers(Arc<Mutex<Vec<(String, Option<Video>)>>>);
impl Layers {
    /// Piik producers declare encodings from low to high; the SDK preserves
    /// their SDP order. RID spelling and observed bitrate do not rank quality.
    pub fn new(rids: Vec<String>) -> Self {
        Self(Arc::new(Mutex::new(
            rids.into_iter().map(|rid| (rid, None)).collect(),
        )))
    }
    pub fn insert(&self, rid: String, video: Video) {
        if let Some((_, current)) = self.0.lock().unwrap().iter_mut().find(|(id, _)| *id == rid) {
            *current = Some(video);
        }
    }
    pub fn remove(&self, rid: &str) {
        if let Some((_, current)) = self.0.lock().unwrap().iter_mut().find(|(id, _)| id == rid) {
            *current = None;
        }
    }
    #[cfg(feature = "capture")]
    pub fn retire(&self, video: &Video) -> bool {
        let mut layers = self.0.lock().unwrap();
        let Some((_, current)) = layers
            .iter_mut()
            .find(|(_, current)| current.as_ref().is_some_and(|current| current.same(video)))
        else {
            return false;
        };
        *current = None;
        true
    }
    pub fn snapshot(&self) -> Vec<(String, Option<Video>)> {
        self.0.lock().unwrap().clone()
    }
    #[cfg(any(feature = "capture", test))]
    pub fn has_feed(&self) -> bool {
        self.0
            .lock()
            .unwrap()
            .iter()
            .any(|(_, video)| video.is_some())
    }
    /// Highest active representation and the cost of retaining the whole supply.
    pub fn rates(&self, now: Instant) -> (Option<u64>, Option<u64>) {
        let layers = self.0.lock().unwrap();
        let mut highest = None;
        let mut aggregate = Some(0);
        let mut present = false;
        for video in layers.iter().filter_map(|(_, video)| video.as_ref()) {
            present = true;
            let rate = video.bitrate(now);
            aggregate = aggregate.zip(rate).map(|(sum, bps)| sum + bps);
            if let Some(bps) = rate {
                if bps > 0 || highest.is_none() {
                    highest = Some(bps);
                }
            }
        }
        (highest, present.then_some(aggregate).flatten())
    }
    pub fn supply(
        &self,
        inputs: &[(String, Arc<Input>)],
        demand: EncodingDemand,
        now: Instant,
    ) -> Result<()> {
        let layers = self.snapshot();
        let rates: Vec<_> = layers
            .iter()
            .map(|(_, video)| {
                video
                    .as_ref()
                    .map(|video| video.rates(now))
                    .unwrap_or_default()
            })
            .collect();
        let active = rates
            .iter()
            .any(|rate| rate.full.is_some_and(|bps| bps > 0));
        let mut remaining = match demand {
            EncodingDemand::Original => u64::MAX,
            EncodingDemand::Limited(bps) => u64::from(bps),
            EncodingDemand::Paused => 0,
        };
        for ((rid, video), rate) in layers.iter().zip(rates) {
            let Some((_, input)) = inputs.iter().find(|(id, _)| id == rid) else {
                continue;
            };
            let Some(video) = video else {
                input.set_active(false);
                continue;
            };
            let selection = rate.fit(remaining);
            let temporal = if demand == EncodingDemand::Original {
                None
            } else if let Some(selection) = selection {
                selection.temporal
            } else {
                input.temporal_target(video)
            };
            // Bind late/replaced feeds even while their rate is unknown or idle.
            input.select_temporal(video, true, temporal)?;
            let idle_recovery = rate.full == Some(0) && {
                let state = input.state.lock().unwrap();
                !state.active || state.waiting_keyframe
            };
            if demand == EncodingDemand::Original {
                input.set_active(true);
            } else if matches!(demand, EncodingDemand::Paused | EncodingDemand::Limited(0)) {
                input.set_active(false);
            } else if rate.full.is_none() || idle_recovery {
                // A confirmed grant must let the reader-driven producer expose
                // a fresh picture/cost. Retain that grant while awaiting its IDR,
                // rather than starting another unknown RID on the next reconcile.
                input.set_active(remaining > 0);
                remaining = 0;
            } else if active {
                // A static representation consumes no new budget. Keep its
                // current selection without blocking a flowing sibling.
                if rate.full == Some(0) {
                    if remaining == 0 {
                        input.set_active(false);
                    }
                    continue;
                }
                if let Some(selection) = selection {
                    input.set_active(true);
                    remaining -= selection.bps;
                } else {
                    input.set_active(false);
                    remaining = 0;
                }
            }
        }
        Ok(())
    }
    pub fn select(&self, input: &Arc<Input>, demand: EncodingDemand, now: Instant) -> Result<()> {
        let layers = self.0.lock().unwrap();
        input.select_available(
            layers.iter().rev().filter_map(|(_, video)| video.as_ref()),
            demand,
            now,
        )
    }
}

#[derive(Clone)]
pub(crate) struct Video(Arc<Encoding>);
struct Encoding {
    time: SourceTime,
    requests: watch::Sender<u64>,
    outputs: Mutex<Vec<Weak<Input>>>,
    changed: Arc<Notify>,
    rate: Mutex<Rate<5>>,
}

impl Video {
    pub fn new(time: SourceTime, changed: Arc<Notify>) -> Self {
        Self(Arc::new(Encoding {
            time,
            requests: watch::channel(0).0,
            outputs: Mutex::new(Vec::new()),
            changed,
            rate: Mutex::new(Rate::default()),
        }))
    }
    pub fn bitrate(&self, now: Instant) -> Option<u64> {
        self.rates(now).full
    }
    fn rates(&self, now: Instant) -> Rates {
        Rates::new(self.0.rate.lock().unwrap().sample_bins(now))
    }
    pub fn changed(&self) -> Arc<Notify> {
        self.0.changed.clone()
    }
    pub fn time(&self) -> SourceTime {
        self.0.time.clone()
    }
    pub fn requests(&self) -> watch::Receiver<u64> {
        self.0.requests.subscribe()
    }
    pub fn request_keyframe(&self) {
        self.0.requests.send_modify(|n| *n = n.wrapping_add(1));
        self.0.changed.notify_one();
    }
    pub fn request_pending_keyframe(&self) {
        if self.inputs().iter().any(|input| {
            let state = input.state.lock().unwrap();
            state.active
                && !state.closed
                && (state.pending.is_some() || state.waiting_keyframe)
                && state.selected().is_some_and(|video| video.same(self))
        }) {
            self.request_keyframe();
        }
    }
    fn inputs(&self) -> Vec<Arc<Input>> {
        // Never hold a feed lock while entering an Output's selection/queue lock.
        let mut outputs = self.0.outputs.lock().unwrap();
        outputs.retain(|output| output.strong_count() > 0);
        outputs.iter().filter_map(Weak::upgrade).collect()
    }
    pub fn needed(&self) -> bool {
        self.inputs().iter().any(|input| input.needs(self))
    }
    pub fn write(&self, frame: EncodedFrame) {
        self.0.rate.lock().unwrap().observe_bin(
            Instant::now(),
            frame
                .vp8
                .and_then(|metadata| metadata.temporal_id)
                .map_or(4, usize::from),
            frame.bytes.len() + frame.bytes.len().div_ceil(1200) * 12,
        );
        let frame = Arc::new(frame);
        for output in self.inputs() {
            output.write(self, frame.clone());
        }
    }
    pub fn subscribe(&self) -> Arc<Input> {
        let input = Input::new(self.time(), self.0.changed.clone());
        input.state.lock().unwrap().pending = Some(Pending {
            video: self.clone(),
            required: true,
            temporal: None,
        });
        self.0.outputs.lock().unwrap().push(Arc::downgrade(&input));
        input
    }
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Input {
    /// An already-declared RID can await its first feed without borrowing another RID.
    pub fn new(time: SourceTime, changed: Arc<Notify>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                current: None,
                temporal: Temporal::default(),
                pending: None,
                queue: VecDeque::new(),
                waiting_keyframe: true,
                active: true,
                last: None,
                closed: false,
            }),
            available: Notify::new(),
            time,
            changed,
        })
    }
}

struct State {
    current: Option<Video>,
    temporal: Temporal,
    pending: Option<Pending>,
    queue: VecDeque<Arc<EncodedFrame>>,
    waiting_keyframe: bool,
    active: bool,
    last: Option<(Video, Instant)>,
    closed: bool,
}
impl State {
    fn selected(&self) -> Option<&Video> {
        self.pending
            .as_ref()
            .map(|pending| &pending.video)
            .or(self.current.as_ref())
    }
    fn close(&mut self) {
        self.closed = true;
        self.queue.clear();
        self.pending = None;
        self.current = None;
    }
}
struct Pending {
    video: Video,
    /// This allocation cannot be served by the incumbent encoding.
    required: bool,
    temporal: Option<u8>,
}
pub(crate) struct Input {
    state: Mutex<State>,
    available: Notify,
    time: SourceTime,
    changed: Arc<Notify>,
}
impl Input {
    #[cfg(feature = "capture")]
    pub fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }
    #[cfg(feature = "capture")]
    pub fn needs_picture(&self) -> bool {
        let state = self.state.lock().unwrap();
        !state.active || state.waiting_keyframe
    }
    pub fn select(self: &Arc<Self>, video: &Video, required: bool) -> Result<()> {
        self.select_temporal(video, required, None)
    }
    pub fn select_available<'a>(
        self: &Arc<Self>,
        mut videos: impl Iterator<Item = &'a Video>,
        demand: EncodingDemand,
        now: Instant,
    ) -> Result<()> {
        if matches!(demand, EncodingDemand::Paused | EncodingDemand::Limited(0)) {
            self.set_active(false);
            return Ok(());
        }
        let budget = match demand {
            EncodingDemand::Limited(budget) => u64::from(budget),
            _ => u64::MAX,
        };
        let (current, pending) = {
            let state = self.state.lock().unwrap();
            (
                state.current.clone(),
                state
                    .pending
                    .as_ref()
                    .map(|p| (p.video.clone(), p.required)),
            )
        };
        let mut first = None;
        let mut incumbent = None;
        let mut pending_feed = None;
        let mut active = false;
        let selected = videos.find_map(|video| {
            first.get_or_insert(video);
            if current.as_ref().is_some_and(|current| current.same(video)) {
                incumbent = Some((video, false));
            }
            if let Some((_, required)) = pending.as_ref().filter(|(p, _)| p.same(video)) {
                pending_feed = Some((video, *required));
            }
            let rates = video.rates(now);
            active |= rates.full.is_some_and(|bps| bps > 0);
            rates.fit(budget).map(|selection| (video, selection))
        });
        if !active {
            // Keep an available selection while its cost is unknown or idle.
            // A positive grant must wake its reader to request a fresh IDR.
            let Some((video, required)) = pending_feed
                .or(incumbent)
                .or_else(|| first.map(|video| (video, true)))
            else {
                self.set_active(false);
                return Ok(());
            };
            let temporal = if demand == EncodingDemand::Original {
                None
            } else {
                self.temporal_target(video)
            };
            self.select_temporal(video, required, temporal)?;
            self.set_active(true);
            return Ok(());
        }
        let Some((video, selection)) = selected else {
            self.set_active(false);
            return Ok(());
        };
        let required = if matches!(demand, EncodingDemand::Limited(_)) {
            let mut state = self.state.lock().unwrap();
            let incumbent = state
                .current
                .as_ref()
                .and_then(|current| current.rates(now).fit(budget));
            if let Some(incumbent) = incumbent {
                // An optional spatial upgrade must not leave the incumbent
                // consuming its former, larger temporal allocation while waiting.
                state.temporal.target = incumbent.temporal;
                false
            } else {
                true
            }
        } else {
            false
        };
        self.select_temporal(video, required, selection.temporal)?;
        self.set_active(true);
        Ok(())
    }
    fn temporal_target(&self, video: &Video) -> Option<u8> {
        let state = self.state.lock().unwrap();
        if let Some(pending) = state.pending.as_ref().filter(|p| p.video.same(video)) {
            pending.temporal
        } else if state
            .current
            .as_ref()
            .is_some_and(|current| current.same(video))
        {
            state.temporal.target
        } else {
            None
        }
    }
    fn select_temporal(
        self: &Arc<Self>,
        video: &Video,
        required: bool,
        temporal: Option<u8>,
    ) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        ensure!(!state.closed, "video input closed");
        ensure!(
            self.time.epoch == video.time().epoch,
            "encoding belongs to another capture"
        );
        if state
            .current
            .as_ref()
            .is_some_and(|current| current.same(video))
        {
            state.temporal.target = temporal;
            let cancelled = state.pending.take().is_some();
            let request = state.active && state.waiting_keyframe;
            drop(state);
            if cancelled {
                self.changed.notify_one();
                self.available.notify_waiters();
                if request {
                    video.request_keyframe();
                }
            }
            return Ok(());
        }
        if let Some(pending) = state
            .pending
            .as_mut()
            .filter(|pending| pending.video.same(video) && pending.required == required)
        {
            pending.temporal = temporal;
            return Ok(());
        }
        if required {
            // The incumbent cannot serve this allocation. Keep the last sent
            // PTS fixed so a delayed derived IDR can catch up without retiming.
            state.current = None;
            state.queue.clear();
            state.waiting_keyframe = true;
        }
        state.pending = Some(Pending {
            video: video.clone(),
            required,
            temporal,
        });
        let active = state.active;
        drop(state);
        let mut outputs = video.0.outputs.lock().unwrap();
        outputs.retain(|output| output.strong_count() > 0);
        if !outputs
            .iter()
            .any(|output| output.ptr_eq(&Arc::downgrade(self)))
        {
            outputs.push(Arc::downgrade(self));
        }
        drop(outputs);
        self.changed.notify_one();
        if active {
            video.request_keyframe();
        }
        Ok(())
    }
    pub fn set_active(&self, active: bool) {
        let mut state = self.state.lock().unwrap();
        if state.closed || state.active == active {
            return;
        }
        state.active = active;
        state.queue.clear();
        state.waiting_keyframe = true;
        if !active {
            // Unused encoders may retire while paused. Keep only the selection
            // for fresh-IDR resumption, not an incumbent to fall back to.
            if let Some(video) = state.current.take() {
                let temporal = state.temporal.target;
                state.pending.get_or_insert(Pending {
                    video,
                    required: true,
                    temporal,
                });
            }
        }
        let selected = state.selected().cloned();
        drop(state);
        self.changed.notify_one();
        if active {
            if let Some(selected) = selected {
                selected.request_keyframe();
            }
            self.available.notify_waiters();
        }
    }
    fn write(&self, video: &Video, frame: Arc<EncodedFrame>) {
        let mut state = self.state.lock().unwrap();
        if state.closed || !state.active {
            return;
        }
        let pending = state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.video.same(video));
        if pending {
            if !frame.keyframe {
                return;
            }
            // Same-source encodings can finish slightly out of order. Like
            // LiveKit's source switch, accept an IDR at most 50ms behind a live
            // incumbent; the output packetizer owns RTP timestamp continuity.
            // Paused/required handoffs still need a fresh source frame.
            if state.last.as_ref().is_some_and(|(previous, last)| {
                frame.presentation_time <= *last
                    && (previous.same(video)
                        || state.current.is_none()
                        || last.duration_since(frame.presentation_time) > Duration::from_millis(50))
            }) {
                drop(state);
                video.request_keyframe();
                return;
            }
        } else if !state
            .current
            .as_ref()
            .is_some_and(|current| current.same(video))
        {
            return;
        }
        if state.last.as_ref().is_some_and(|(previous, last)| {
            previous.same(video) && frame.presentation_time <= *last
        }) {
            return;
        }
        if !pending && state.waiting_keyframe && !frame.keyframe {
            return;
        }
        let mut temporal = if pending {
            Temporal {
                current: None,
                target: state.pending.as_ref().unwrap().temporal,
            }
        } else {
            state.temporal
        };
        match temporal.select(&frame) {
            Decision::Forward => {}
            Decision::Drop => {
                // A down-switch has discarded dependencies even when this AU
                // is filtered. A pending source still owns no incumbent state.
                if !pending {
                    state.temporal = temporal;
                }
                return;
            }
            Decision::Recover => {
                if !pending {
                    state.queue.clear();
                    state.waiting_keyframe = true;
                    drop(state);
                    self.available.notify_waiters();
                }
                return;
            }
        }
        state.temporal = temporal;
        if pending {
            state.current = Some(video.clone());
            state.pending = None;
            state.queue.clear();
            state.waiting_keyframe = false;
        }
        if state.queue.len() == 2 {
            state.queue.clear();
            state.waiting_keyframe = true;
        }
        if state.waiting_keyframe && !frame.keyframe {
            return;
        }
        state.waiting_keyframe = false;
        state.queue.push_back(frame);
        drop(state);
        if pending {
            self.changed.notify_one();
        }
        self.available.notify_waiters();
    }
    pub fn request_keyframe(&self) {
        let state = self.state.lock().unwrap();
        if state.active && !state.closed {
            if let Some(selected) = state.selected() {
                selected.request_keyframe();
            }
        }
    }
    #[cfg(any(feature = "capture", test))]
    pub async fn recv(&self) -> Option<Arc<EncodedFrame>> {
        self.recv_with_source().await.map(|(_, frame)| frame)
    }
    /// Return the selected feed with its original source timestamp. A queued
    /// handoff must remain identifiable even if consumer backpressure drops IDRs.
    pub async fn recv_with_source(&self) -> Option<(Video, Arc<EncodedFrame>)> {
        loop {
            let notified = self.available.notified();
            let request = {
                let mut state = self.state.lock().unwrap();
                if let Some(frame) = state.queue.pop_front() {
                    let video = state.current.as_ref().unwrap().clone();
                    state.last = Some((video.clone(), frame.presentation_time));
                    return Some((video, frame));
                }
                if state.closed {
                    return None;
                }
                if state.active && state.waiting_keyframe {
                    state.selected().cloned()
                } else {
                    None
                }
            };
            // Recovery belongs to an active consumer. A not-yet-negotiated
            // sender cannot make a shared encoder repeatedly emit idle IDRs.
            if let Some(video) = request {
                video.request_keyframe();
            }
            notified.await;
        }
    }
    fn needs(&self, video: &Video) -> bool {
        let state = self.state.lock().unwrap();
        state.active
            && !state.closed
            && (state.current.as_ref().is_some_and(|v| v.same(video))
                || state.pending.as_ref().is_some_and(|v| v.video.same(video)))
    }
    /// Apply a failed encoding at the same lock that commits an IDR handoff.
    /// Optional upgrades keep their incumbent; required allocations cannot.
    pub fn failed(&self, video: &Video) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return false;
        }
        let pending = state.pending.as_ref().is_some_and(|v| v.video.same(video));
        let required = pending && state.pending.as_ref().unwrap().required;
        if pending {
            state.pending = None;
        }
        let close = state.active
            && (state.current.as_ref().is_some_and(|v| v.same(video))
                || (pending && (required || state.current.is_none())));
        if close {
            state.close();
        }
        let incumbent = if pending && state.active && !close {
            state.current.clone()
        } else {
            None
        };
        drop(state);
        if pending || close {
            self.changed.notify_one();
            self.available.notify_waiters();
        }
        if let Some(incumbent) = incumbent {
            incumbent.request_keyframe();
        }
        close
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.close();
        drop(state);
        self.changed.notify_one();
        self.available.notify_waiters();
    }
    /// A supplied RID cannot rebuild its retired feed through per-output demand.
    #[cfg(feature = "capture")]
    pub fn retire(&self, video: &Video) {
        let mut state = self.state.lock().unwrap();
        if !state.current.as_ref().is_some_and(|v| v.same(video))
            && !state.pending.as_ref().is_some_and(|v| v.video.same(video))
        {
            return;
        }
        state.close();
        drop(state);
        self.changed.notify_one();
        self.available.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::vp8::Vp8FrameMetadata;
    use rtc::shared::time::SystemInstant;
    use std::time::Duration;

    fn temporal_frame(
        epoch: Instant,
        n: u64,
        tid: Option<u8>,
        sync: bool,
        keyframe: bool,
        bytes: usize,
    ) -> EncodedFrame {
        EncodedFrame {
            bytes: vec![n as u8; bytes],
            presentation_time: epoch + Duration::from_millis(n),
            keyframe,
            vp8: Some(Vp8FrameMetadata {
                temporal_id: tid,
                layer_sync: sync,
                ..Default::default()
            }),
        }
    }

    #[tokio::test]
    async fn temporal_handoff_uses_sync_frames_and_keeps_siblings_independent() -> Result<()> {
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let video = Video::new(time.clone(), Arc::new(Notify::new()));
        let selected = video.subscribe();
        let healthy = video.subscribe();
        let slow = video.subscribe();
        selected.select_temporal(&video, true, Some(0))?;
        video.write(temporal_frame(epoch, 1, Some(0), false, true, 20));
        for input in [&selected, &healthy, &slow] {
            assert_eq!(input.recv().await.unwrap().bytes[0], 1);
        }
        selected.select_temporal(&video, false, Some(3))?;
        // A non-adjacent Y cannot restore the missing intermediate dependency.
        for (n, tid, sync, delivered) in [
            (2, 2, true, false),
            (3, 1, false, false),
            (4, 1, true, true),
            (5, 2, false, false),
            (6, 2, true, true),
            (7, 3, true, true),
        ] {
            video.write(temporal_frame(epoch, n, Some(tid), sync, false, 20));
            assert_eq!(healthy.recv().await.unwrap().bytes[0], n as u8);
            if delivered {
                assert_eq!(selected.recv().await.unwrap().bytes[0], n as u8);
            } else {
                assert!(selected.state.lock().unwrap().queue.is_empty());
            }
        }
        assert!(slow.state.lock().unwrap().waiting_keyframe);
        let mut unclassified = temporal_frame(epoch, 7, None, false, false, 20);
        unclassified.presentation_time += Duration::from_micros(500);
        video.write(unclassified);
        assert_eq!(
            selected.recv().await.unwrap().bytes[0],
            7,
            "T3 is the full RFC temporal range, even after adjacent Y upgrades"
        );
        healthy.recv().await.unwrap();
        selected.select_temporal(&video, false, Some(0))?;
        video.write(temporal_frame(epoch, 8, Some(2), false, false, 20));
        assert!(selected.state.lock().unwrap().queue.is_empty());
        healthy.recv().await.unwrap();
        video.write(temporal_frame(epoch, 9, Some(0), false, false, 20));
        assert_eq!(selected.recv().await.unwrap().bytes[0], 9);
        healthy.recv().await.unwrap();
        selected.select_temporal(&video, false, Some(2))?;
        video.write(temporal_frame(epoch, 10, Some(0), false, true, 20));
        for input in [&selected, &healthy, &slow] {
            assert_eq!(input.recv().await.unwrap().bytes[0], 10);
        }
        assert_eq!(selected.state.lock().unwrap().temporal.current, Some(2));

        let replacement = Video::new(time, Arc::new(Notify::new()));
        selected.select_temporal(&replacement, false, Some(0))?;
        let requests = replacement.requests();
        let before = *requests.borrow();
        selected.select_temporal(&replacement, false, Some(1))?;
        selected.select_temporal(&replacement, false, Some(0))?;
        assert_eq!(
            *requests.borrow(),
            before,
            "a changed temporal budget does not re-request the same pending IDR"
        );
        video.write(temporal_frame(epoch, 11, Some(2), false, false, 20));
        assert_eq!(
            selected.recv().await.unwrap().bytes[0],
            11,
            "pending feed target does not filter the incumbent"
        );
        replacement.write(temporal_frame(epoch, 12, Some(0), false, false, 20));
        assert!(selected.state.lock().unwrap().queue.is_empty());
        replacement.write(temporal_frame(epoch, 13, Some(0), false, true, 20));
        assert_eq!(selected.recv().await.unwrap().bytes[0], 13);
        replacement.write(temporal_frame(epoch, 14, Some(1), true, false, 20));
        assert!(selected.state.lock().unwrap().queue.is_empty());
        selected.close();
        healthy.close();
        slow.close();
        assert!(!video.needed() && !replacement.needed());
        Ok(())
    }

    #[tokio::test]
    async fn temporal_dropped_downswitch_survives_a_target_increase() -> Result<()> {
        let epoch = Instant::now();
        let video = Video::new(
            SourceTime::local(epoch, SystemInstant::now(epoch)),
            Arc::new(Notify::new()),
        );
        let input = video.subscribe();
        video.write(temporal_frame(epoch, 1, Some(0), false, true, 20));
        input.recv().await.unwrap();
        input.select_temporal(&video, false, Some(0))?;
        video.write(temporal_frame(epoch, 2, Some(2), false, false, 20));
        video.write(temporal_frame(epoch, 3, Some(1), false, false, 20));
        assert!(input.state.lock().unwrap().queue.is_empty());
        // The budget rises before the next T0. Already discarded dependencies
        // cannot be restored by raising the target; T1 still needs a sync AU.
        input.select_temporal(&video, false, Some(1))?;
        video.write(temporal_frame(epoch, 4, Some(1), false, false, 20));
        assert!(input.state.lock().unwrap().queue.is_empty());
        video.write(temporal_frame(epoch, 5, Some(1), true, false, 20));
        assert_eq!(input.recv().await.unwrap().bytes[0], 5);
        input.close();
        Ok(())
    }

    #[tokio::test]
    async fn inactive_idle_selection_resumes_on_a_positive_grant() -> Result<()> {
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let selected = Video::new(time.clone(), Arc::new(Notify::new()));
        let other = Video::new(time, Arc::new(Notify::new()));
        let input = selected.subscribe();
        selected.write(temporal_frame(epoch, 1, Some(0), false, true, 20));
        input.recv().await.unwrap();
        let start = selected.0.rate.lock().unwrap().start.unwrap();
        selected.rates(start + Duration::from_secs(1));
        let idle = start + Duration::from_secs(2);
        assert_eq!(selected.rates(idle).full, Some(0));
        let inventory = [&other, &selected];
        input.select_available(inventory.into_iter(), EncodingDemand::Paused, idle)?;
        let requests = selected.requests();
        let before = *requests.borrow();
        input.select_available(inventory.into_iter(), EncodingDemand::Limited(0), idle)?;
        assert!(!input.state.lock().unwrap().active);
        input.select_available(inventory.into_iter(), EncodingDemand::Limited(1000), idle)?;
        assert!(input.state.lock().unwrap().active);
        assert!(input
            .state
            .lock()
            .unwrap()
            .selected()
            .unwrap()
            .same(&selected));
        assert!(*requests.borrow() > before);
        let resumed = *requests.borrow();
        input.select_available(inventory.into_iter(), EncodingDemand::Original, idle)?;
        assert_eq!(
            *requests.borrow(),
            resumed,
            "an active static feed needs no repeated PLI"
        );
        selected.write(temporal_frame(epoch, 2, Some(0), false, true, 20));
        assert_eq!(input.recv().await.unwrap().bytes[0], 2);
        let unknown = selected.0.rate.lock().unwrap().start.unwrap();
        assert_eq!(selected.rates(unknown).full, None);
        input.select_available(inventory.into_iter(), EncodingDemand::Paused, unknown)?;
        input.select_available(inventory.into_iter(), EncodingDemand::Original, unknown)?;
        assert!(input.state.lock().unwrap().active);
        input.select_available(std::iter::empty(), EncodingDemand::Original, unknown)?;
        assert!(
            !input.state.lock().unwrap().active,
            "no inventory means no available feed"
        );
        input.close();
        Ok(())
    }

    #[tokio::test]
    async fn temporal_unknown_metadata_keeps_full_cost_and_requires_independent_recovery(
    ) -> Result<()> {
        let epoch = Instant::now();
        let video = Video::new(
            SourceTime::local(epoch, SystemInstant::now(epoch)),
            Arc::new(Notify::new()),
        );
        let input = video.subscribe();
        input.select_temporal(&video, true, Some(0))?;
        video.write(temporal_frame(epoch, 1, Some(0), false, true, 1000));
        input.recv().await.unwrap();
        video.write(temporal_frame(epoch, 2, None, false, false, 1000));
        video.write(temporal_frame(epoch, 3, Some(0), false, false, 1000));
        assert!(input.state.lock().unwrap().queue.is_empty());
        assert!(input.state.lock().unwrap().waiting_keyframe);
        let start = video.0.rate.lock().unwrap().start.unwrap();
        let rates = video.rates(start + Duration::from_secs(1));
        assert_eq!(rates.full, Some(3 * 1012 * 8));
        assert!(rates.temporal.iter().all(Option::is_none));
        assert!(rates.fit(2 * 1012 * 8).is_none());
        input.select(&video, false)?;
        video.write(temporal_frame(epoch, 4, None, false, true, 1000));
        assert_eq!(input.recv().await.unwrap().bytes[0], 4);
        let mut plain = temporal_frame(epoch, 5, None, false, false, 1000);
        plain.vp8 = None;
        video.write(plain);
        assert_eq!(input.recv().await.unwrap().bytes[0], 5);
        input.close();
        Ok(())
    }

    #[tokio::test]
    async fn temporal_costs_use_one_window_and_bound_terminal_and_transit_grants() -> Result<()> {
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let q = Video::new(time.clone(), Arc::new(Notify::new()));
        let h = Video::new(time, Arc::new(Notify::new()));
        // Exact bins use the same packet-overhead accounting as full feed cost.
        for (tid, bytes) in [(0, 1000), (1, 2000), (2, 3000), (3, 4000)] {
            q.write(temporal_frame(
                epoch,
                u64::from(tid),
                Some(tid),
                false,
                tid == 0,
                bytes,
            ));
            h.write(temporal_frame(
                epoch,
                u64::from(tid),
                Some(tid),
                false,
                tid == 0,
                bytes * 10,
            ));
        }
        // Align only the controlled observation boundary, not frame timestamps.
        q.0.rate.lock().unwrap().start = Some(epoch);
        h.0.rate.lock().unwrap().start = Some(epoch);
        let now = epoch + Duration::from_secs(1);
        let qr = q.rates(now);
        assert_eq!(
            qr.temporal,
            [Some(8096), Some(24288), Some(48576), Some(80960)]
        );
        assert_eq!(qr.full, Some(80960));
        assert_eq!(qr.fit(25_000).unwrap().temporal, Some(1));
        let layers = Layers::new(vec!["q".into(), "h".into()]);
        layers.insert("q".into(), q.clone());
        layers.insert("h".into(), h.clone());
        let terminal = h.subscribe();
        layers.select(&terminal, EncodingDemand::Limited(25_000), now)?;
        q.write(temporal_frame(epoch, 10, Some(0), false, true, 10));
        assert_eq!(terminal.recv().await.unwrap().bytes[0], 10);
        assert_eq!(terminal.state.lock().unwrap().temporal.target, Some(1));
        q.write(temporal_frame(epoch, 11, Some(2), false, false, 10));
        assert!(terminal.state.lock().unwrap().queue.is_empty());
        let qi = q.subscribe();
        let hi = h.subscribe();
        let inputs = vec![("q".into(), qi.clone()), ("h".into(), hi.clone())];
        layers.supply(&inputs, EncodingDemand::Limited(25_000), now)?;
        assert_eq!(
            qi.state.lock().unwrap().pending.as_ref().unwrap().temporal,
            Some(1)
        );
        assert!(!hi.state.lock().unwrap().active);
        layers.supply(&inputs, EncodingDemand::Limited(170_000), now)?;
        // Full q leaves 89,040; only h T0 (80,864) fits that remainder.
        assert_eq!(
            qi.state.lock().unwrap().pending.as_ref().unwrap().temporal,
            None
        );
        assert_eq!(
            hi.state.lock().unwrap().pending.as_ref().unwrap().temporal,
            Some(0)
        );
        assert!(qi.state.lock().unwrap().active && hi.state.lock().unwrap().active);
        layers.supply(&inputs, EncodingDemand::Limited(1), now)?;
        assert!(!qi.state.lock().unwrap().active && !hi.state.lock().unwrap().active);
        // Idle samples preserve selection; resumption reopens the shared window.
        let idle = now + Duration::from_secs(2);
        q.rates(idle);
        h.rates(idle);
        let idle = idle + Duration::from_secs(2);
        assert_eq!(q.rates(idle).full, Some(0));
        assert_eq!(h.rates(idle).full, Some(0));
        layers.supply(&inputs, EncodingDemand::Limited(25_000), idle)?;
        assert!(
            qi.state.lock().unwrap().active && !hi.state.lock().unwrap().active,
            "an unread static feed gets one bootstrap grant, not every RID at once"
        );
        let late = Video::new(h.time(), Arc::new(Notify::new()));
        layers.insert("h".into(), late.clone());
        layers.supply(&inputs, EncodingDemand::Limited(25_000), idle)?;
        assert!(hi
            .state
            .lock()
            .unwrap()
            .pending
            .as_ref()
            .unwrap()
            .video
            .same(&late));
        qi.close();
        hi.close();
        terminal.close();
        Ok(())
    }

    #[test]
    fn original_video_rate_uses_arrival_and_preserves_unknown_idle_resume() {
        let epoch = Instant::now();
        let video = Video::new(
            SourceTime::local(epoch, SystemInstant::now(epoch)),
            Arc::new(Notify::new()),
        );
        assert_eq!(video.bitrate(epoch), None);
        video.write(EncodedFrame {
            vp8: None,
            bytes: vec![1],
            presentation_time: epoch + Duration::from_secs(9377),
            keyframe: true,
        });
        let arrived = video.0.rate.lock().unwrap().start.unwrap();
        assert_eq!(video.bitrate(arrived), None);
        assert_eq!(video.bitrate(arrived + Duration::from_secs(1)), Some(104));
        assert_eq!(video.bitrate(arrived + Duration::from_secs(2)), Some(0));
        video.write(EncodedFrame {
            vp8: None,
            bytes: vec![1],
            presentation_time: epoch + Duration::from_secs(9378),
            keyframe: true,
        });
        let resumed = video.0.rate.lock().unwrap().start.unwrap();
        assert_eq!(video.bitrate(resumed), None);
        assert_eq!(video.bitrate(resumed + Duration::from_secs(1)), Some(104));
    }

    #[tokio::test]
    async fn paused_input_preserves_selection_and_adopts_only_a_fresh_idr() -> Result<()> {
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let changed = Arc::new(Notify::new());
        let high = Video::new(time.clone(), changed.clone());
        let low = Video::new(time.clone(), changed);
        let input = high.subscribe();
        let frame = |n, keyframe| EncodedFrame {
            vp8: None,
            bytes: vec![n as u8],
            presentation_time: epoch + Duration::from_millis(n),
            keyframe,
        };
        high.write(frame(1, true));
        assert_eq!(input.recv().await.unwrap().bytes, vec![1]);
        high.write(frame(2, false));
        input.set_active(false);
        assert!(!high.needed());
        let requests = high.requests();
        let before = *requests.borrow();
        input.request_keyframe();
        high.write(frame(3, true));
        {
            let recv = input.recv();
            tokio::pin!(recv);
            assert!(futures_util::poll!(recv).is_pending());
        }
        assert_eq!(*requests.borrow(), before, "paused input emits no PLI");
        input.set_active(true);
        assert!(*requests.borrow() > before);
        high.write(frame(4, false));
        {
            let recv = input.recv();
            tokio::pin!(recv);
            assert!(futures_util::poll!(recv).is_pending());
        }
        high.write(frame(5, true));
        assert_eq!(input.recv().await.unwrap().bytes, vec![5]);

        input.set_active(false);
        let low_requests = low.requests();
        let before = *low_requests.borrow();
        input.select(&low, true)?;
        input.select(&low, true)?;
        assert_eq!(*low_requests.borrow(), before);
        input.set_active(true);
        assert!(
            *low_requests.borrow() > before,
            "resume requests the pending encoding"
        );
        low.write(frame(4, true)); // A static image older than the sender clock.
        low.write(frame(6, false));
        high.write(frame(7, true));
        {
            let recv = input.recv();
            tokio::pin!(recv);
            assert!(futures_util::poll!(recv).is_pending());
        }
        low.write(frame(8, true));
        assert_eq!(input.recv().await.unwrap().bytes, vec![8]);
        assert!(!high.needed());
        input.select(&low, true)?;

        input.select(&high, false)?;
        input.select(&low, true)?;
        assert!(input.state.lock().unwrap().pending.is_none());
        input.select(&high, false)?;
        input.close();
        assert!(!high.needed() && !low.needed());
        assert!(input.recv().await.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn required_handoff_keeps_its_last_output_boundary_and_optional_upgrade_keeps_playing(
    ) -> Result<()> {
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let changed = Arc::new(Notify::new());
        let original = Video::new(time.clone(), changed.clone());
        let limited = Video::new(time, changed);
        let input = original.subscribe();
        let healthy = original.subscribe();
        let frame = |n, keyframe| EncodedFrame {
            vp8: None,
            bytes: vec![n],
            presentation_time: epoch + Duration::from_millis(u64::from(n)),
            keyframe,
        };
        original.write(frame(10, true));
        input.recv().await.unwrap();
        healthy.recv().await.unwrap();
        original.write(frame(20, false));
        input.select(&limited, true)?;
        assert!(!input.needs(&original));
        assert!(
            original.needed(),
            "the healthy consumer still owns its original feed"
        );
        original.write(frame(50, false));
        limited.write(frame(30, true));
        let adopted = input.recv().await.unwrap();
        assert_eq!(adopted.bytes, [30]);
        assert_eq!(adopted.presentation_time, epoch + Duration::from_millis(30));
        assert_eq!(healthy.recv().await.unwrap().bytes, [20]);
        assert_eq!(healthy.recv().await.unwrap().bytes, [50]);

        input.select(&original, false)?;
        let mut stale = frame(20, true);
        stale.presentation_time = epoch - Duration::from_millis(30); // 60ms behind.
        original.write(stale);
        limited.write(frame(40, false));
        assert_eq!(input.recv().await.unwrap().bytes, [40]);
        original.write(frame(60, true));
        assert_eq!(input.recv().await.unwrap().bytes, [60]);
        assert!(!limited.needed());

        input.select(&limited, true)?;
        input.select(&original, false)?;
        original.write(frame(70, false));
        {
            let recv = input.recv();
            tokio::pin!(recv);
            assert!(
                futures_util::poll!(recv).is_pending(),
                "cancelled handoff needs a new IDR"
            );
        }
        original.write(frame(80, true));
        assert_eq!(input.recv().await.unwrap().bytes, [80]);
        input.close();
        healthy.close();
        Ok(())
    }

    #[tokio::test]
    async fn encoding_failure_follows_actual_adoption_and_required_pending() -> Result<()> {
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let changed = Arc::new(Notify::new());
        let low = Video::new(time.clone(), changed.clone());
        let high = Video::new(time.clone(), changed.clone());
        let input = low.subscribe();
        let frame = |n| EncodedFrame {
            vp8: None,
            bytes: vec![n],
            presentation_time: epoch + Duration::from_millis(u64::from(n)),
            keyframe: true,
        };
        low.write(frame(1));
        input.recv().await.unwrap();
        input.select(&high, false)?;
        let mut low_requests = low.requests();
        assert!(
            !input.failed(&high),
            "a failed upgrade preserves the live limited encoder"
        );
        assert!(input.state.lock().unwrap().pending.is_none());
        assert!(low_requests.has_changed()?, "PLI returns to the incumbent");
        low_requests.borrow_and_update();
        low.write(frame(2));
        assert_eq!(input.recv().await.unwrap().bytes, [2]);

        // The replacement MFT owns a different Video, even for the same settings.
        let replacement = Video::new(time.clone(), changed.clone());
        input.select(&replacement, false)?;
        replacement.write(frame(3));
        assert!(
            !input.failed(&low),
            "an old failure queued before adoption cannot close the replacement"
        );
        assert!(!input.failed(&high));
        assert_eq!(input.recv().await.unwrap().bytes, [3]);

        let required = Video::new(time.clone(), changed);
        input.select(&required, true)?;
        assert!(
            input.failed(&required),
            "a failed required lower-rate encoding retires only its Output"
        );
        assert!(input.recv().await.is_none());
        assert!(!replacement.needed());

        let paused = low.subscribe();
        low.write(frame(4));
        paused.recv().await.unwrap();
        paused.set_active(false);
        assert!(!low.needed()); // The producer retires this unused limited encoder.
        paused.select(&high, false)?;
        paused.set_active(true);
        assert!(
            paused.failed(&high),
            "resumption has no live incumbent to preserve after its encoder was retired"
        );
        assert!(paused.recv().await.is_none());
        Ok(())
    }
}
