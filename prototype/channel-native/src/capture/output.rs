//! One encoder worker and its ordered access units, independent of other outputs.
use super::{mf::Encoder, windows::RawFrame, CaptureClock, EncodedFrame, Settings};
use anyhow::{anyhow, ensure, Result};
use std::{
    collections::VecDeque,
    sync::{Arc, Condvar, Mutex},
    thread,
};
use tokio::sync::Notify;

#[derive(Default)]
pub(super) struct State {
    pub stop: bool,
    done: bool,
    failure: Option<String>,
    pub latest: Option<RawFrame>,
    pub event: Option<windows::core::Result<u32>>,
    pub force_keyframe: bool,
    pub bitrate: Option<u32>,
    output: VecDeque<EncodedFrame>,
}
#[derive(Default)]
pub(super) struct Shared {
    pub state: Mutex<State>,
    pub changed: Condvar,
    available: Notify,
}
impl Shared {
    pub fn wake(&self) {
        self.changed.notify_all();
    }
    pub fn input(&self, frame: RawFrame) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.stop {
            return false;
        }
        state.latest = Some(frame);
        drop(state);
        self.wake();
        true
    }
    pub fn stop(&self, failure: Option<&str>) {
        let mut state = self.state.lock().unwrap();
        if let Some(failure) = failure {
            state.failure = Some(failure.to_owned());
        }
        state.stop = true;
        state.output.clear();
        state.latest = None;
        drop(state);
        self.wake();
        self.available.notify_one();
    }
    pub fn output(&self, frame: EncodedFrame) -> bool {
        let mut state = self.state.lock().unwrap();
        // Only the raw slot is replaceable. Preserve the encoded dependency chain.
        while state.output.len() == 2 && !state.stop {
            state = self.changed.wait(state).unwrap();
        }
        if state.stop {
            return false;
        }
        state.output.push_back(frame);
        drop(state);
        self.available.notify_one();
        true
    }
}

#[derive(Clone)]
pub struct EncodingControl(Arc<Shared>);
impl EncodingControl {
    pub fn is_stopped(&self) -> bool {
        self.0.state.lock().unwrap().stop
    }
    /// Request cancellation; the Encoding owner joins the worker with stop().
    pub fn stop(&self) {
        self.0.stop(None);
    }
    pub fn force_keyframe(&self) -> Result<()> {
        let mut state = self.0.state.lock().unwrap();
        ensure!(!state.stop, "encoding stopped");
        state.force_keyframe = true;
        drop(state);
        self.0.wake();
        Ok(())
    }
    pub fn set_bitrate(&self, bitrate: u32) -> Result<()> {
        ensure!(bitrate > 0, "bitrate must be positive");
        let mut state = self.0.state.lock().unwrap();
        ensure!(!state.stop, "encoding stopped");
        state.bitrate = Some(bitrate);
        drop(state);
        self.0.wake();
        Ok(())
    }
}

pub struct Encoding {
    pub(super) shared: Arc<Shared>,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Encoding {
    pub(super) fn start(
        settings: Settings,
        clock: CaptureClock,
        latest: Option<RawFrame>,
    ) -> Result<Self> {
        let shared = Arc::new(Shared::default());
        shared.state.lock().unwrap().latest = latest;
        let worker = shared.clone();
        let thread = thread::Builder::new()
            .name("piik-encoder".into())
            .spawn(move || {
                let result = Encoder::run(&worker, settings, clock);
                let mut state = worker.state.lock().unwrap();
                if let Err(error) = &result {
                    state.failure = Some(format!("{error:#}"));
                }
                state.stop = true;
                state.done = true;
                state.latest = None;
                state.event = None;
                drop(state);
                worker.wake();
                worker.available.notify_one();
                result
            })?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }
    pub fn control(&self) -> EncodingControl {
        EncodingControl(self.shared.clone())
    }
    pub async fn recv(&mut self) -> Option<Result<EncodedFrame>> {
        loop {
            let notified = self.shared.available.notified();
            {
                let mut state = self.shared.state.lock().unwrap();
                if let Some(frame) = state.output.pop_front() {
                    self.shared.wake();
                    return Some(Ok(frame));
                }
                if state.done {
                    return state.failure.take().map(|error| Err(anyhow!(error)));
                }
            }
            notified.await;
        }
    }
    /// Call from a blocking owner. Drop requests stop; this also joins the MFT worker.
    pub fn stop(mut self) -> Result<()> {
        self.shared.stop(None);
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow!("encoder worker panicked"))?
    }
}
impl Drop for Encoding {
    fn drop(&mut self) {
        self.shared.stop(None);
    }
}
