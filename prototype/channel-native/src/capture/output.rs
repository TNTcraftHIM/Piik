//! One encoder worker and its ordered access units, independent of other outputs.
use super::{
    frames::RawFrame, mf, software, CaptureClock, EncodingExecution, FrameTiming, Settings,
    VideoCodec,
};
use crate::EncodedFrame;
use anyhow::{anyhow, ensure, Result};
use std::{
    collections::VecDeque,
    sync::{Arc, Condvar, Mutex},
    thread,
};
use tokio::sync::Notify;

#[derive(Debug)]
pub(super) struct EncodingStopped;
impl std::fmt::Display for EncodingStopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("encoding stopped")
    }
}
impl std::error::Error for EncodingStopped {}

#[derive(Default)]
pub(super) struct State {
    pub stop: bool,
    done: bool,
    failure: Option<String>,
    encoder_failed: bool,
    pub latest: Option<RawFrame>,
    pub event: Option<windows::core::Result<u32>>,
    pub force_keyframe: bool,
    pub bitrate: Option<u32>,
    raw_requested: bool,
    output: VecDeque<EncodedFrame>,
}
pub(super) struct Shared {
    pub state: Mutex<State>,
    pub changed: Condvar,
    available: Notify,
    requests: tokio::sync::mpsc::Sender<Option<i64>>,
}
impl Shared {
    pub fn wake(&self) {
        self.changed.notify_all();
    }
    pub fn input(&self, frame: Option<RawFrame>, keyframe: bool) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.stop {
            return Err(EncodingStopped.into());
        }
        ensure!(state.raw_requested, "unsolicited encoding input");
        if let Some(frame) = frame {
            state.latest = Some(frame);
        } else {
            ensure!(keyframe && state.latest.is_some(), "no frame to refresh");
        }
        state.force_keyframe |= keyframe;
        state.raw_requested = false;
        drop(state);
        self.wake();
        Ok(())
    }
    pub fn request_frame(&self, state: &mut State) {
        if !state.raw_requested {
            let after = state.latest.as_ref().map(|raw| raw.qpc);
            if self.requests.try_send(after).is_ok() {
                state.raw_requested = true;
            }
        }
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

/// Tracks submitted pixels and their presentation time independently of raw admission.
#[derive(Default)]
pub(super) struct Presentation {
    last: Option<(i64, i64)>,
}
impl Presentation {
    pub fn last_qpc(&self) -> Option<i64> {
        self.last.map(|(_, qpc)| qpc)
    }

    pub fn next_qpc(&self, clock: CaptureClock, timing: FrameTiming, capture: i64) -> Result<i64> {
        if timing == FrameTiming::Source {
            return Ok(capture);
        }
        let Some((last_capture, last_qpc)) = self.last else {
            return Ok(capture);
        };
        // A static refresh advances to the current clock. WGC may publish a real
        // update captured before that refresh. Keep its pixels and advance the
        // presentation clock by at least one 90 kHz RTP tick (in 100 ns units).
        let qpc = if capture == last_capture {
            clock.now()?
        } else {
            capture
        };
        const RTP_TICK: i64 = (10_000_000 + 90_000 - 1) / 90_000;
        Ok(qpc.max(last_qpc + RTP_TICK))
    }

    pub fn submitted(&mut self, capture: i64, qpc: i64) {
        self.last = Some((capture, qpc));
    }
}

#[derive(Clone)]
pub struct EncodingControl(Arc<Shared>);
impl EncodingControl {
    /// Request cancellation; the Encoding owner joins the worker with stop().
    pub fn stop(&self) {
        self.0.stop(None);
    }
    pub fn set_bitrate(&self, bitrate: u32) -> Result<()> {
        ensure!(bitrate > 0, "bitrate must be positive");
        let mut state = self.0.state.lock().unwrap();
        if state.stop {
            return Err(EncodingStopped.into());
        }
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
        codec: VideoCodec,
        execution: EncodingExecution,
        clock: CaptureClock,
        timing: FrameTiming,
        requests: tokio::sync::mpsc::Sender<Option<i64>>,
    ) -> Result<Self> {
        let shared = Arc::new(Shared {
            requests,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            available: Notify::new(),
        });
        let worker = shared.clone();
        let thread = thread::Builder::new()
            .name("piik-encoder".into())
            .spawn(move || {
                let result = match (codec, execution) {
                    (VideoCodec::H264, EncodingExecution::Auto) => {
                        mf::Encoder::run(&worker, settings, clock, timing)
                    }
                    _ => software::run(&worker, settings, codec, clock, timing),
                };
                let mut state = worker.state.lock().unwrap();
                if let Err(error) = &result {
                    state.failure = Some(format!("{error:#}"));
                    state.encoder_failed = error.is::<super::mf_common::HardwareEncoderFailed>();
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
                    return state.failure.take().map(|error| {
                        Err(if state.encoder_failed {
                            anyhow!(error).context(super::mf_common::HardwareEncoderFailed)
                        } else {
                            anyhow!(error)
                        })
                    });
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
