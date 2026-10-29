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
use tokio::sync::{oneshot, watch, Notify};

#[derive(Clone)]
pub(crate) struct Video(Arc<Encoding>);
struct Encoding {
    time: CaptureTime,
    requests: watch::Sender<u64>,
    outputs: Mutex<Vec<Weak<Input>>>,
}

impl Video {
    pub fn new(time: CaptureTime) -> Self {
        Self(Arc::new(Encoding {
            time,
            requests: watch::channel(0).0,
            outputs: Mutex::new(Vec::new()),
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
    pub fn write(&self, frame: EncodedFrame) {
        let frame = Arc::new(frame);
        // Never hold a feed lock while entering an Output's selection/queue lock.
        let outputs: Vec<_> = {
            let mut outputs = self.0.outputs.lock().unwrap();
            outputs.retain(|output| output.strong_count() > 0);
            outputs.iter().filter_map(Weak::upgrade).collect()
        };
        for output in outputs {
            output.write(self, frame.clone());
        }
    }
    pub fn subscribe(&self) -> Arc<Input> {
        let input = Arc::new(Input {
            state: Mutex::new(State {
                current: self.clone(),
                pending: None,
                queue: VecDeque::new(),
                waiting_keyframe: true,
                active: true,
                last: None,
                closed: false,
            }),
            available: Notify::new(),
        });
        self.0.outputs.lock().unwrap().push(Arc::downgrade(&input));
        input
    }
    fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

struct State {
    current: Video,
    pending: Option<Pending>,
    queue: VecDeque<Arc<EncodedFrame>>,
    waiting_keyframe: bool,
    active: bool,
    last: Option<Instant>,
    closed: bool,
}
struct Pending {
    video: Video,
    adopted: oneshot::Sender<()>,
}
pub(crate) struct Input {
    state: Mutex<State>,
    available: Notify,
}
impl Input {
    pub fn select(self: &Arc<Self>, video: &Video) -> Result<oneshot::Receiver<()>> {
        let mut state = self.state.lock().unwrap();
        ensure!(!state.closed, "video input closed");
        ensure!(
            state.current.time().epoch == video.time().epoch,
            "encoding belongs to another capture"
        );
        let (adopted, receipt) = oneshot::channel();
        if state.current.same(video) {
            state.pending = None;
            let _ = adopted.send(());
            return Ok(receipt);
        }
        if let Some(pending) = state.pending.as_mut().filter(|p| p.video.same(video)) {
            // The latest selection owns the sole adoption receipt.
            pending.adopted = adopted;
            return Ok(receipt);
        }
        state.pending = Some(Pending {
            video: video.clone(),
            adopted,
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
        if active {
            video.request_keyframe();
        }
        Ok(receipt)
    }
    pub fn set_active(&self, active: bool) {
        let mut state = self.state.lock().unwrap();
        if state.closed || state.active == active {
            return;
        }
        state.active = active;
        state.queue.clear();
        state.waiting_keyframe = true;
        let selected = state
            .pending
            .as_ref()
            .map_or(&state.current, |pending| &pending.video)
            .clone();
        drop(state);
        if active {
            selected.request_keyframe();
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
        let mut adopted = None;
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
            state.current = video.clone();
            adopted = state.pending.take().map(|pending| pending.adopted);
            state.queue.clear();
            state.waiting_keyframe = false;
        } else if !state.current.same(video) {
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
        if let Some(adopted) = adopted {
            let _ = adopted.send(());
        }
        drop(state);
        self.available.notify_waiters();
    }
    pub fn request_keyframe(&self) {
        let state = self.state.lock().unwrap();
        if state.active && !state.closed {
            state
                .pending
                .as_ref()
                .map_or(&state.current, |pending| &pending.video)
                .request_keyframe();
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
                (state.active && state.waiting_keyframe).then(|| {
                    state
                        .pending
                        .as_ref()
                        .map_or(&state.current, |pending| &pending.video)
                        .clone()
                })
            };
            // Recovery belongs to an active consumer. A not-yet-negotiated
            // sender cannot make a shared encoder repeatedly emit idle IDRs.
            if let Some(video) = request {
                video.request_keyframe();
            }
            notified.await;
        }
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.queue.clear();
        state.pending = None;
        drop(state);
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
        let high = Video::new(time);
        let low = Video::new(time);
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
        let superseded = input.select(&low)?;
        let mut adopted = input.select(&low)?;
        assert!(superseded.await.is_err());
        assert_eq!(*low_requests.borrow(), before);
        input.set_active(true);
        assert!(
            *low_requests.borrow() > before,
            "resume requests the pending encoding"
        );
        low.write(frame(4, true)); // A static image older than the sender clock.
        low.write(frame(6, false));
        assert!(matches!(
            adopted.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        high.write(frame(7, true));
        assert_eq!(input.recv().await.unwrap().bytes, vec![7]);
        low.write(frame(8, true));
        adopted.await?;
        assert_eq!(input.recv().await.unwrap().bytes, vec![8]);
        input.select(&low)?.await?;

        let cancelled = input.select(&high)?;
        input.select(&low)?.await?;
        assert!(cancelled.await.is_err());
        let closed = input.select(&high)?;
        input.close();
        assert!(closed.await.is_err());
        assert!(input.recv().await.is_none());
        Ok(())
    }
}
