//! One source anchor and latest immutable image, independent of encoder settings.
use anyhow::{anyhow, ensure, Result};
use cidre::{arc, cm, cv};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Notify;

#[derive(Clone, Copy)]
pub struct Clock {
    host: cm::Time,
    instant: Instant,
}
impl Clock {
    pub fn new() -> Self {
        Self {
            host: cm::Clock::host_time_clock().time(),
            instant: Instant::now(),
        }
    }
    pub fn project(self, pts: cm::Time) -> Result<Instant> {
        ensure!(
            pts.is_numeric() && pts.epoch == self.host.epoch,
            "invalid source PTS"
        );
        let delta = nanos(pts) - nanos(self.host);
        let duration = Duration::from_nanos(delta.unsigned_abs().try_into()?);
        Ok(if delta >= 0 {
            self.instant + duration
        } else {
            self.instant - duration
        })
    }
    pub fn timestamp(self, time: Instant) -> cm::Time {
        let delta = if time >= self.instant {
            time.duration_since(self.instant).as_nanos() as i128
        } else {
            -(self.instant.duration_since(time).as_nanos() as i128)
        };
        cm::Time::new((nanos(self.host) + delta) as i64, 1_000_000_000)
    }
}
fn nanos(time: cm::Time) -> i128 {
    i128::from(time.value) * 1_000_000_000 / i128::from(time.scale)
}

/// Source-owned copy; neither SC's pool buffer nor a mutable pixel view escapes.
#[derive(Clone)]
pub struct Image {
    pixels: arc::R<cv::PixelBuf>,
    size: (f64, f64),
}
// SAFETY: the only constructor receives a completed independent pixel copy.
// Attachments and pixels are finalized before publishing; no mutation API is
// exposed. Each clone retains the CF image. Apple documents immutable CF
// query/retain/release as thread-safe; CVPixelBuffer retain/release are those CF
// operations. This applies to this image only, never SC/sample/codec objects.
unsafe impl Send for Image {}
unsafe impl Sync for Image {}
impl Image {
    pub(crate) fn copied(pixels: arc::R<cv::PixelBuf>, size: (f64, f64)) -> Self {
        Self { pixels, size }
    }
    pub fn size(&self) -> (f64, f64) {
        self.size
    }
    pub fn pixel_size(&self) -> (usize, usize) {
        (self.pixels.width(), self.pixels.height())
    }
    pub(crate) fn pixels(&self) -> &cv::PixelBuf {
        &self.pixels
    }
}
#[derive(Clone)]
pub struct RawFrame {
    pub image: Image,
    pub time: Instant,
}
#[derive(Default)]
pub(crate) struct State {
    pub stop: bool,
    pub error: Option<String>,
    latest: Option<RawFrame>,
    pub resize: Option<(usize, usize)>,
}
#[derive(Default)]
pub(crate) struct Shared {
    pub state: Mutex<State>,
    pub changed: Notify,
}
impl Shared {
    pub fn finish(&self, error: Option<String>) {
        let mut state = self.state.lock().unwrap();
        if state.error.is_none() {
            state.error = error;
        }
        state.stop = true;
        state.latest = None;
        state.resize = None;
        drop(state);
        self.changed.notify_waiters();
    }
    pub fn resize(&self, size: (usize, usize)) {
        let mut state = self.state.lock().unwrap();
        if state.stop || state.resize == Some(size) {
            return;
        }
        state.resize = Some(size);
        drop(state);
        self.changed.notify_waiters();
    }
}
#[derive(Clone)]
pub struct Control(pub(crate) Arc<Shared>);
impl Control {
    pub fn stop(&self) {
        self.0.finish(None);
    }
    pub fn is_stopped(&self) -> bool {
        self.0.state.lock().unwrap().stop
    }
    pub async fn stopped(&self) {
        loop {
            let ready = self.0.changed.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if self.is_stopped() {
                return;
            }
            ready.await;
        }
    }
}
#[derive(Clone)]
pub struct Frames {
    pub(crate) shared: Arc<Shared>,
    clock: Clock,
}
impl Frames {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared::default()),
            clock: Clock::new(),
        }
    }
    pub fn clock(&self) -> Clock {
        self.clock
    }
    pub fn control(&self) -> Control {
        Control(self.shared.clone())
    }
    pub fn finish(&self, error: Option<String>) {
        self.shared.finish(error);
    }
    pub(crate) fn publish(&self, image: Image, time: Instant) {
        let mut state = self.shared.state.lock().unwrap();
        if state.stop {
            return;
        }
        state.latest = Some(RawFrame { image, time });
        drop(state);
        self.shared.changed.notify_waiters();
    }
    /// Source-only handoff for this slice. Encoders later subscribe to the same
    /// latest image owner; this is not an additional media queue.
    pub async fn recv_after(&self, previous: Option<Instant>) -> Result<Option<RawFrame>> {
        loop {
            let ready = self.shared.changed.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            {
                let state = self.shared.state.lock().unwrap();
                if state.stop {
                    return state
                        .error
                        .as_ref()
                        .map_or(Ok(None), |e| Err(anyhow!(e.clone())));
                }
                if let Some(raw) = state
                    .latest
                    .as_ref()
                    .filter(|raw| previous.is_none_or(|previous| raw.time > previous))
                {
                    return Ok(Some(raw.clone()));
                }
            }
            ready.await;
        }
    }
}
