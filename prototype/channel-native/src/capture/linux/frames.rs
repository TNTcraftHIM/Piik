//! One source clock and immutable latest frame, outside PipeWire's buffer pool.
use anyhow::{anyhow, Context as _, Result};
use gst::prelude::*;
use std::time::{Duration, Instant};
use tokio::sync::watch;

#[derive(Clone)]
pub struct Clock {
    clock: gst::Clock,
    epoch: gst::ClockTime,
    instant: Instant,
}
impl Clock {
    pub fn new() -> Self {
        let clock = gst::SystemClock::obtain();
        let epoch = clock.time();
        Self {
            clock,
            epoch,
            instant: Instant::now(),
        }
    }
    pub fn pipeline(&self, pipeline: &gst::Pipeline) {
        // Audio, capture and each encoder use one system-time domain, even
        // when started later. Segment running time removes encoder PTS offsets.
        pipeline.use_clock(Some(&self.clock));
        pipeline.set_start_time(gst::ClockTime::NONE);
        pipeline.set_base_time(gst::ClockTime::ZERO);
    }
    pub fn project(&self, time: gst::ClockTime) -> Result<Instant> {
        let delta = Duration::from_nanos(time.nseconds().abs_diff(self.epoch.nseconds()));
        if time >= self.epoch {
            self.instant.checked_add(delta)
        } else {
            self.instant.checked_sub(delta)
        }
        .context("capture time outside the monotonic clock")
    }
    pub fn timestamp(&self, time: Instant) -> Result<gst::ClockTime> {
        let nanos = if time >= self.instant {
            self.epoch
                .nseconds()
                .checked_add(time.duration_since(self.instant).as_nanos().try_into()?)
        } else {
            self.epoch
                .nseconds()
                .checked_sub(self.instant.duration_since(time).as_nanos().try_into()?)
        }
        .context("capture time outside the GStreamer clock")?;
        Ok(gst::ClockTime::from_nseconds(nanos))
    }
    pub fn now(&self) -> Result<Instant> {
        self.project(self.clock.time())
    }
    pub fn sample_time(&self, sample: &gst::Sample) -> Result<Instant> {
        let pts = sample
            .buffer()
            .and_then(|buffer| buffer.pts())
            .context("missing capture PTS")?;
        let segment = sample
            .segment()
            .and_then(|s| s.downcast_ref::<gst::ClockTime>())
            .context("missing capture time segment")?;
        self.project(
            segment
                .to_running_time(pts)
                .context("capture PTS outside its segment")?,
        )
    }
}

#[derive(Clone)]
pub struct RawFrame {
    pub buffer: gst::Buffer,
    pub info: gst_video::VideoInfo,
    pub time: Instant,
}
#[derive(Clone)]
enum State {
    Live(Option<RawFrame>),
    Stopped(Option<String>),
}
#[derive(Clone)]
pub(super) struct Control(watch::Sender<State>);
impl Control {
    pub fn stop(&self) {
        self.finish(None);
    }
    pub fn is_stopped(&self) -> bool {
        matches!(*self.0.borrow(), State::Stopped(_))
    }
    pub async fn stopped(&self) {
        let mut state = self.0.subscribe();
        let _ = state.wait_for(|s| matches!(s, State::Stopped(_))).await;
    }
    fn finish(&self, error: Option<String>) {
        self.0.send_if_modified(|state| {
            if matches!(state, State::Stopped(_)) {
                return false;
            }
            *state = State::Stopped(error);
            true
        });
    }
}

#[derive(Clone)]
pub struct Frames {
    control: Control,
    clock: Clock,
}
impl Frames {
    pub fn new() -> Self {
        Self {
            control: Control(watch::channel(State::Live(None)).0),
            clock: Clock::new(),
        }
    }
    pub fn clock(&self) -> Clock {
        self.clock.clone()
    }
    pub(super) fn control(&self) -> Control {
        self.control.clone()
    }
    pub fn finish(&self, error: Option<String>) {
        self.control.finish(error);
    }
    pub fn publish(&self, sample: &gst::Sample) -> Result<()> {
        self.publish_frame(self.frame(sample)?);
        Ok(())
    }
    pub(super) fn frame(&self, sample: &gst::Sample) -> Result<RawFrame> {
        let info = gst_video::VideoInfo::from_caps(sample.caps().context("missing source caps")?)?;
        let time = self.clock.sample_time(sample)?;
        // A slow encoder must not retain one of the compositor's finite buffers.
        // Copy once here; every encoding shares this immutable owned copy.
        let buffer = sample
            .buffer()
            .context("missing source image")?
            .copy_deep()?;
        Ok(RawFrame { buffer, info, time })
    }
    pub(super) fn publish_frame(&self, raw: RawFrame) {
        self.control.0.send_if_modified(|state| {
            let State::Live(latest) = state else {
                return false;
            };
            *latest = Some(raw);
            true
        });
    }
    pub(super) fn present_now(&self, mut raw: RawFrame) -> Result<RawFrame> {
        // A user-selected local source is presented once at the handoff time.
        raw.time = self.clock.now()?;
        raw.buffer.make_mut().set_flags(gst::BufferFlags::DISCONT);
        Ok(raw)
    }
    pub async fn recv_after(&self, previous: Option<Instant>) -> Result<Option<RawFrame>> {
        let mut state = self.control.0.subscribe();
        loop {
            match &*state.borrow_and_update() {
                State::Stopped(error) => {
                    return error.as_ref().map_or(Ok(None), |e| Err(anyhow!(e.clone())))
                }
                State::Live(Some(raw)) if previous.is_none_or(|last| raw.time > last) => {
                    return Ok(Some(raw.clone()))
                }
                State::Live(_) => {}
            }
            state.changed().await?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{linux::Encoding, Settings};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn static_source_handoff_reuses_encoding_and_presents_once() -> Result<()> {
        gst::init()?;
        let frames = Frames::new();
        let info = gst_video::VideoInfo::builder(gst_video::VideoFormat::Bgra, 64, 48).build()?;
        let sample = |time: Instant, color: u8| -> Result<gst::Sample> {
            let mut buffer = gst::Buffer::from_mut_slice(vec![color; info.size()]);
            buffer.make_mut().set_pts(frames.clock().timestamp(time)?);
            Ok(gst::Sample::builder()
                .buffer(&buffer)
                .caps(&info.to_caps()?)
                .segment(&gst::FormattedSegment::<gst::ClockTime>::new())
                .build())
        };
        let encoder = gst::ElementFactory::make("x264enc")
            .property_from_str("tune", "zerolatency")
            .property_from_str("speed-preset", "ultrafast")
            .build()?;
        let mut encoding = Encoding::start_with_encoder(
            frames.clone(),
            Settings {
                width: 64,
                height: 48,
                fps: 1,
                bitrate: 200_000,
            },
            encoder,
        )?;
        let first_time = frames.clock().now()?;
        frames.publish(&sample(first_time, 32)?)?;
        let first = tokio::time::timeout(Duration::from_secs(3), encoding.recv())
            .await
            .context("initial frame deadline")?
            .context("missing initial AU")??;
        assert_eq!(first.presentation_time, first_time);

        // The next source is static, and its one cached sample predates the
        // incumbent's latest picture. No subsequent raw frame will rescue it.
        let cached = frames.frame(&sample(first_time - Duration::from_secs(1), 200)?)?;
        let presented = frames.present_now(cached)?;
        let presented_time = presented.time;
        anyhow::ensure!(
            presented_time.duration_since(first_time) < Duration::from_secs(1),
            "fixture missed the one-FPS cadence window"
        );
        frames.publish_frame(presented);
        let next = tokio::time::timeout(Duration::from_secs(3), encoding.recv())
            .await
            .context("static source handoff deadline")?
            .context("static source handoff produced no AU")??;
        assert_eq!(next.presentation_time, presented_time);
        assert!(next.keyframe && next.presentation_time > first.presentation_time);
        assert_ne!(next.bytes, first.bytes);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), encoding.recv())
                .await
                .is_err()
        );
        frames.finish(None);
        tokio::task::spawn_blocking(move || encoding.stop()).await??;
        Ok(())
    }
}
