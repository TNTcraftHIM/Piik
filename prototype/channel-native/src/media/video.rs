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
    pending: Option<Video>,
    queue: VecDeque<Arc<EncodedFrame>>,
    waiting_keyframe: bool,
    last: Option<Instant>,
    closed: bool,
}
pub(crate) struct Input {
    state: Mutex<State>,
    available: Notify,
}
impl Input {
    pub fn select(self: &Arc<Self>, video: &Video) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        ensure!(
            state.current.time().epoch == video.time().epoch,
            "encoding belongs to another capture"
        );
        if state.current.same(video) {
            state.pending = None;
            return Ok(());
        }
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.same(video))
        {
            return Ok(());
        }
        state.pending = Some(video.clone());
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
        video.request_keyframe();
        Ok(())
    }
    fn write(&self, video: &Video, frame: Arc<EncodedFrame>) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        let pending = state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.same(video));
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
            state.pending = None;
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
        drop(state);
        self.available.notify_waiters();
    }
    pub fn request_keyframe(&self) {
        self.state.lock().unwrap().current.request_keyframe();
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
                state.waiting_keyframe.then(|| state.current.clone())
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
