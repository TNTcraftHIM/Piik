//! Complete local access units. Each Output selects one encoding and recovers
//! independently when its finite queue cannot keep up.
use super::packetizer::CaptureTime;
use crate::capture::EncodedFrame;
use anyhow::{ensure, Result};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak},
    time::Instant,
};
use tokio::sync::{watch, Notify};

#[derive(Clone)]
pub(crate) struct Video(Arc<Encoding>);
struct Encoding {
    time: CaptureTime,
    requests: watch::Sender<u64>,
    outputs: Mutex<Vec<Weak<Input>>>,
    changed: Arc<Notify>,
}

impl Video {
    pub fn new(time: CaptureTime, changed: Arc<Notify>) -> Self {
        Self(Arc::new(Encoding {
            time,
            requests: watch::channel(0).0,
            outputs: Mutex::new(Vec::new()),
            changed,
        }))
    }
    pub fn time(&self) -> CaptureTime {
        self.0.time
    }
    pub fn requests(&self) -> watch::Receiver<u64> {
        self.0.requests.subscribe()
    }
    pub fn request_keyframe(&self) {
        self.0.requests.send_modify(|n| *n = n.wrapping_add(1));
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
        let frame = Arc::new(frame);
        for output in self.inputs() {
            output.write(self, frame.clone());
        }
    }
    pub fn subscribe(&self) -> Arc<Input> {
        let input = Arc::new(Input {
            state: Mutex::new(State {
                current: None,
                pending: Some(Pending {
                    video: self.clone(),
                    required: true,
                }),
                queue: VecDeque::new(),
                waiting_keyframe: true,
                active: true,
                last: None,
                closed: false,
            }),
            available: Notify::new(),
            time: self.time(),
            changed: self.0.changed.clone(),
        });
        self.0.outputs.lock().unwrap().push(Arc::downgrade(&input));
        input
    }
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

struct State {
    current: Option<Video>,
    pending: Option<Pending>,
    queue: VecDeque<Arc<EncodedFrame>>,
    waiting_keyframe: bool,
    active: bool,
    last: Option<Instant>,
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
}
pub(crate) struct Input {
    state: Mutex<State>,
    available: Notify,
    time: CaptureTime,
    changed: Arc<Notify>,
}
impl Input {
    pub fn select(self: &Arc<Self>, video: &Video, required: bool) -> Result<()> {
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
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.video.same(video) && pending.required == required)
        {
            return Ok(());
        }
        if required {
            // The incumbent cannot serve this allocation. Keep the last sent
            // PTS fixed so a delayed replacement IDR can catch up without retiming.
            state.current = None;
            state.queue.clear();
            state.waiting_keyframe = true;
        }
        state.pending = Some(Pending {
            video: video.clone(),
            required,
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
                state.pending.get_or_insert(Pending {
                    video,
                    required: true,
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
            // A newly started encoder can return an old static capture image.
            // Keep the incumbent and request a current-time IDR, never wrap RTP time.
            if state
                .last
                .is_some_and(|last| frame.presentation_time <= last)
            {
                drop(state);
                video.request_keyframe();
                return;
            }
            state.current = Some(video.clone());
            state.pending = None;
            state.queue.clear();
            state.waiting_keyframe = false;
        } else if !state
            .current
            .as_ref()
            .is_some_and(|current| current.same(video))
        {
            return;
        }
        if state
            .last
            .is_some_and(|last| frame.presentation_time <= last)
        {
            return;
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
    pub async fn recv(&self) -> Option<Arc<EncodedFrame>> {
        loop {
            let notified = self.available.notified();
            let request = {
                let mut state = self.state.lock().unwrap();
                if let Some(frame) = state.queue.pop_front() {
                    state.last = Some(frame.presentation_time);
                    return Some(frame);
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use rtc::shared::time::SystemInstant;
    use std::time::Duration;

    #[tokio::test]
    async fn paused_input_preserves_selection_and_adopts_only_a_fresh_idr() -> Result<()> {
        let epoch = Instant::now();
        let time = CaptureTime {
            epoch,
            clock: SystemInstant::now(epoch),
        };
        let changed = Arc::new(Notify::new());
        let high = Video::new(time, changed.clone());
        let low = Video::new(time, changed);
        let input = high.subscribe();
        let frame = |n, keyframe| EncodedFrame {
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
        let time = CaptureTime {
            epoch,
            clock: SystemInstant::now(epoch),
        };
        let changed = Arc::new(Notify::new());
        let original = Video::new(time, changed.clone());
        let limited = Video::new(time, changed);
        let input = original.subscribe();
        let healthy = original.subscribe();
        let frame = |n, keyframe| EncodedFrame {
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
        original.write(frame(20, true));
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
        let time = CaptureTime {
            epoch,
            clock: SystemInstant::now(epoch),
        };
        let changed = Arc::new(Notify::new());
        let low = Video::new(time, changed.clone());
        let high = Video::new(time, changed.clone());
        let input = low.subscribe();
        let frame = |n| EncodedFrame {
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
        let replacement = Video::new(time, changed.clone());
        input.select(&replacement, false)?;
        replacement.write(frame(3));
        assert!(
            !input.failed(&low),
            "an old failure queued before adoption cannot close the replacement"
        );
        assert!(!input.failed(&high));
        assert_eq!(input.recv().await.unwrap().bytes, [3]);

        let required = Video::new(time, changed);
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
