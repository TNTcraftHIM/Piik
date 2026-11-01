//! One source anchor and latest immutable image, independent of encoder settings.
use super::checked;
use crate::capture::{FrameTiming, Settings};
use anyhow::{anyhow, ensure, Result};
use cidre::{arc, cf, cm, cv, vt};
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

/// The SC callback and VT decoder each own one serial pixel-copy session.
#[derive(Default)]
pub(crate) struct ImageCopy(Option<arc::R<vt::PixelTransferSession>>);
impl ImageCopy {
    pub fn copy(
        &mut self,
        source: &cv::PixelBuf,
        pixels: (usize, usize),
        natural: (f64, f64),
    ) -> Result<Image> {
        let attrs = cf::Dictionary::with_keys_values(
            &[cv::pixel_buffer_keys::io_surf_props()],
            &[&*cf::Dictionary::new()],
        )
        .ok_or_else(|| anyhow!("image attributes failed"))?;
        let owned = checked(cv::PixelBuf::new(
            pixels.0,
            pixels.1,
            cv::PixelFormat::_32_BGRA,
            Some(&attrs),
        ))?;
        if self.0.is_none() {
            let mut transfer = checked(vt::PixelTransferSession::new())?;
            checked(transfer.set_scaling_crop_src_to_clean_aperture())?;
            self.0 = Some(transfer);
        }
        checked(self.0.as_ref().unwrap().transfer(source, &owned))?;
        Ok(Image::copied(owned, natural))
    }
    pub fn clear(&mut self) {
        if let Some(mut transfer) = self.0.take() {
            transfer.invalidate();
        }
    }
}
impl Drop for ImageCopy {
    fn drop(&mut self) {
        self.clear();
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
    timing: FrameTiming,
}
impl Frames {
    pub(crate) fn new(timing: FrameTiming) -> Result<Self> {
        Ok(Self {
            shared: Arc::new(Shared::default()),
            clock: Clock::new(),
            timing,
        })
    }
    pub(crate) fn timing(&self) -> FrameTiming {
        self.timing
    }
    pub(crate) fn encode(
        &self,
        settings: Settings,
        codec: crate::capture::VideoCodec,
    ) -> Result<super::Encoding> {
        anyhow::ensure!(codec.supported(), "capture_codec_unsupported");
        super::Encoding::start(self.clone(), settings)
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
    /// Each encoder consumes the same source-owned latest image independently.
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
