//! One source clock and latest GPU frame shared by WGC or a decoder.
use super::{
    process::{self, Encoding},
    CaptureClock, FrameTiming, Settings, VideoCodec,
};
use anyhow::{ensure, Result};
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::{Arc, Mutex, Weak},
    time::Instant,
};
use tokio::sync::Notify;
use windows::Win32::{
    Foundation::{HANDLE, WAIT_FAILED},
    Graphics::{Direct3D11::ID3D11Texture2D, Dxgi::Common::DXGI_COLOR_SPACE_TYPE},
    System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE},
};

#[derive(Clone)]
pub(super) struct RawFrame {
    pub texture: ID3D11Texture2D,
    pub color_space: DXGI_COLOR_SPACE_TYPE,
    pub qpc: i64,
}
#[derive(Default)]
pub(super) struct State {
    pub stop: bool,
    pub failure: Option<String>,
    latest: Option<RawFrame>,
    encodings: Vec<Weak<process::Shared>>,
}
pub(super) struct Shared {
    pub state: Mutex<State>,
    stop_event: OwnedHandle,
    stopped: Notify,
}
impl Shared {
    fn new() -> Result<Self> {
        let event = unsafe { CreateEventW(None, true, false, None)? };
        Ok(Self {
            state: Mutex::new(State::default()),
            stop_event: unsafe { OwnedHandle::from_raw_handle(event.0) },
            stopped: Notify::new(),
        })
    }
    pub fn wait_for_stop_or(&self, completion: &[HANDLE]) -> Result<()> {
        let mut handles = Vec::with_capacity(completion.len() + 1);
        handles.push(HANDLE(self.stop_event.as_raw_handle()));
        handles.extend_from_slice(completion);
        if unsafe { WaitForMultipleObjects(&handles, false, INFINITE) } == WAIT_FAILED {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(())
    }
    pub fn device_lost(&self, reason: windows::core::HRESULT) {
        let mut state = self.state.lock().unwrap();
        state.latest = None;
        state.encodings.retain(|weak| {
            weak.upgrade().is_some_and(|encoding| {
                encoding.device_lost(reason);
                !encoding.stopped()
            })
        });
    }
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
        let _ = unsafe { SetEvent(HANDLE(self.stop_event.as_raw_handle())) };
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
            shared: Arc::new(Shared::new()?),
            clock: CaptureClock::new()?,
            timing,
        })
    }
    pub fn control(&self) -> Control {
        Control(self.shared.clone())
    }
    pub fn publish(
        &self,
        (texture, color_space): (ID3D11Texture2D, DXGI_COLOR_SPACE_TYPE),
        time: Instant,
    ) {
        self.shared.publish(RawFrame {
            texture,
            color_space,
            qpc: self.clock.presentation_qpc(time),
        });
    }
    pub fn finish(&self, error: Option<String>) {
        self.shared.stop(error);
    }
    /// Allocate one independent encoder. Initialization failures arrive through recv().
    pub fn encode(&self, settings: Settings, codec: VideoCodec) -> Result<Encoding> {
        settings.validate()?;
        let mut state = self.shared.state.lock().unwrap();
        ensure!(!state.stop, "capture stopped");
        state
            .encodings
            .retain(|weak| weak.upgrade().is_some_and(|encoding| !encoding.stopped()));
        let encoding = Encoding::start(
            settings,
            codec,
            self.clock,
            self.timing,
            state.latest.clone(),
        )?;
        state.encodings.push(Arc::downgrade(&encoding.shared));
        Ok(encoding)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread};
    use windows_capture::capture::GraphicsCaptureApiError;

    #[test]
    fn capture_completion_and_stop_both_wake_the_owner() {
        let shared = Shared::new().unwrap();
        let thread = thread::spawn(|| {
            Err::<(), _>(GraphicsCaptureApiError::FrameHandlerError(
                "timestamp failed",
            ))
        });
        shared
            .wait_for_stop_or(&[HANDLE(thread.as_raw_handle())])
            .unwrap();
        assert!(!shared.state.lock().unwrap().stop);
        assert!(matches!(
            thread.join().unwrap(),
            Err(GraphicsCaptureApiError::FrameHandlerError(
                "timestamp failed"
            ))
        ));

        let (release, receiver) = mpsc::channel();
        let thread = thread::spawn(move || receiver.recv().unwrap());
        shared.stop(None);
        shared
            .wait_for_stop_or(&[HANDLE(thread.as_raw_handle())])
            .unwrap();
        assert!(!thread.is_finished());
        release.send(()).unwrap();
        thread.join().unwrap();
    }
}
