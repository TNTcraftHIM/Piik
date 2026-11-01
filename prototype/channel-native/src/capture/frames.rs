//! One source clock and latest GPU frame shared by WGC or a decoder.
use super::{
    process::{self, Encoding},
    CaptureClock, FrameTiming, Settings,
};
use anyhow::{ensure, Result};
use std::{
    sync::{Arc, Condvar, Mutex, Weak},
    time::Instant,
};
use tokio::sync::Notify;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

#[derive(Clone)]
pub(super) struct RawFrame {
    pub texture: ID3D11Texture2D,
    pub qpc: i64,
}
#[derive(Default)]
pub(super) struct State {
    pub stop: bool,
    pub failure: Option<String>,
    latest: Option<RawFrame>,
    encodings: Vec<Weak<process::Shared>>,
}
#[derive(Default)]
pub(super) struct Shared {
    pub state: Mutex<State>,
    pub changed: Condvar,
    stopped: Notify,
}
impl Shared {
    pub fn stop(&self, failure: Option<String>) {
        let mut state = self.state.lock().unwrap();
        if failure.is_some() {
            state.failure = failure;
        }
        state.stop = true;
        state.latest = None;
        let failure = state.failure.clone();
        for encoding in state.encodings.drain(..).filter_map(|weak| weak.upgrade()) {
            encoding.stop(failure.as_deref());
        }
        drop(state);
        self.changed.notify_all();
        self.stopped.notify_waiters();
    }
    pub fn publish(&self, frame: RawFrame) {
        let mut state = self.state.lock().unwrap();
        if state.stop {
            return;
        }
        state.latest = Some(frame.clone());
        state.encodings.retain(|weak| {
            weak.upgrade()
                .is_some_and(|encoding| encoding.input(frame.clone()))
        });
    }
}
#[derive(Clone)]
pub struct Control(pub(super) Arc<Shared>);
impl Control {
    pub fn is_stopped(&self) -> bool {
        self.0.state.lock().unwrap().stop
    }
    /// Stop WGC and wake every encoding, including workers blocked on AU output.
    /// Their respective Capture/Encoding owners still join the workers.
    pub fn stop(&self) {
        self.0.stop(None);
    }
    pub async fn stopped(&self) {
        loop {
            let stopped = self.0.stopped.notified();
            tokio::pin!(stopped);
            stopped.as_mut().enable();
            if self.is_stopped() {
                return;
            }
            stopped.await;
        }
    }
}

#[derive(Clone)]
pub(crate) struct Frames {
    pub(super) shared: Arc<Shared>,
    clock: CaptureClock,
    timing: FrameTiming,
}
impl Frames {
    pub fn new(timing: FrameTiming) -> Result<Self> {
        Ok(Self {
            shared: Arc::new(Shared::default()),
            clock: CaptureClock::new()?,
            timing,
        })
    }
    pub fn control(&self) -> Control {
        Control(self.shared.clone())
    }
    pub fn publish(&self, texture: ID3D11Texture2D, time: Instant) {
        self.shared.publish(RawFrame {
            texture,
            qpc: self.clock.presentation_qpc(time),
        });
    }
    pub fn finish(&self, error: Option<String>) {
        self.shared.stop(error);
    }
    /// Allocate one independent encoder. Initialization failures arrive through recv().
    pub fn encode(&self, settings: Settings) -> Result<Encoding> {
        settings.validate()?;
        let mut state = self.shared.state.lock().unwrap();
        ensure!(!state.stop, "capture stopped");
        state
            .encodings
            .retain(|weak| weak.upgrade().is_some_and(|encoding| !encoding.stopped()));
        let encoding = Encoding::start(settings, self.clock, self.timing, state.latest.clone())?;
        state.encodings.push(Arc::downgrade(&encoding.shared));
        Ok(encoding)
    }
}
