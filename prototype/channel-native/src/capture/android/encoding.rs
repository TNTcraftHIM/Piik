//! One MediaCodec/GL owner per encoding; one submitted image and two complete AUs.
use super::{
    frames::{Clock, Frames, RawFrame},
    graphics::Graphics,
};
use crate::{capture::Settings, EncodedFrame};
use anyhow::{anyhow, ensure, Result};
use ndk::media::{
    media_codec::{DequeuedOutputBufferInfoResult, MediaCodec, MediaCodecDirection},
    media_format::MediaFormat,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Default)]
struct State {
    stop: bool,
    done: bool,
    error: Option<String>,
    force: bool,
    bitrate: Option<u32>,
    output: VecDeque<EncodedFrame>,
}
struct Shared {
    state: Mutex<State>,
    changed: Notify,
    available: Notify,
}
impl Shared {
    fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.stop = true;
        state.output.clear();
        drop(state);
        self.changed.notify_waiters();
        self.available.notify_waiters();
    }
    fn finish(&self, result: &Result<()>) {
        let mut state = self.state.lock().unwrap();
        state.stop = true;
        state.done = true;
        state.error = result.as_ref().err().map(|error| format!("{error:#}"));
        state.output.clear();
        drop(state);
        self.changed.notify_waiters();
        self.available.notify_waiters();
    }
}
#[derive(Clone)]
pub struct EncodingControl(Arc<Shared>);
impl EncodingControl {
    pub fn stop(&self) {
        self.0.stop();
    }
    pub fn is_stopped(&self) -> bool {
        self.0.state.lock().unwrap().stop
    }
    pub fn force_keyframe(&self) -> Result<()> {
        let mut state = self.0.state.lock().unwrap();
        ensure!(!state.stop, "encoding stopped");
        state.force = true;
        drop(state);
        self.0.changed.notify_waiters();
        Ok(())
    }
    pub fn set_bitrate(&self, bitrate: u32) -> Result<()> {
        ensure!(bitrate > 0, "invalid bitrate");
        let mut state = self.0.state.lock().unwrap();
        ensure!(!state.stop, "encoding stopped");
        state.bitrate = Some(bitrate);
        drop(state);
        self.0.changed.notify_waiters();
        Ok(())
    }
}
pub struct Encoding {
    shared: Arc<Shared>,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Encoding {
    pub(super) fn start(frames: Frames, settings: Settings) -> Result<Self> {
        settings.validate()?;
        ensure!(settings.fps <= i32::MAX as u32, "invalid encoder FPS");
        ensure!(
            settings.bitrate <= i32::MAX as u32,
            "invalid encoder bitrate"
        );
        let runtime = tokio::runtime::Handle::try_current()?;
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                force: true,
                ..State::default()
            }),
            changed: Notify::new(),
            available: Notify::new(),
        });
        let worker = shared.clone();
        let thread = thread::Builder::new()
            .name("piik-android-encoding".into())
            .spawn(move || {
                let result = run(&worker, frames, settings, &runtime);
                worker.finish(&result);
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
            let ready = self.shared.available.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            {
                let mut state = self.shared.state.lock().unwrap();
                if let Some(frame) = state.output.pop_front() {
                    self.shared.changed.notify_waiters();
                    return Some(Ok(frame));
                }
                if state.done {
                    return state.error.take().map(|error| Err(anyhow!(error)));
                }
            }
            ready.await;
        }
    }
    /// Call from a blocking owner, outside media/input locks.
    pub fn stop(mut self) -> Result<()> {
        self.shared.stop();
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow!("encoding worker panicked"))?
    }
}

struct Codec {
    // Destroy the window EGL surface before releasing the codec's native window.
    graphics: Graphics,
    _window: ndk::native_window::NativeWindow,
    codec: MediaCodec,
    size: (u32, u32),
    config: Vec<u8>,
}
impl Codec {
    fn new(frames: &Frames, settings: Settings) -> Result<Self> {
        let codec = MediaCodec::from_encoder_type("video/avc")
            .ok_or_else(|| anyhow!("H264 encoder unavailable"))?;
        let mut format = MediaFormat::new();
        format.set_str("mime", "video/avc");
        for (key, value) in [
            ("width", settings.width as i32),
            ("height", settings.height as i32),
            ("frame-rate", settings.fps as i32),
            ("bitrate", settings.bitrate as i32),
            ("color-format", 0x7F000789),
            ("i-frame-interval", 2),
            ("bitrate-mode", 2),
            ("max-bframes", 0),
            ("priority", 0),
        ] {
            format.set_i32(key, value);
        }
        codec.configure(&format, None, MediaCodecDirection::Encoder)?;
        let window = codec.create_input_surface()?;
        let graphics = Graphics::new(frames.display.clone(), Some(&window), false)?;
        codec.start()?;
        Ok(Self {
            graphics,
            _window: window,
            codec,
            size: (settings.width, settings.height),
            config: Vec::new(),
        })
    }
    fn bitrate(&self, value: u32) -> Result<()> {
        let mut params = MediaFormat::new();
        params.set_i32("video-bitrate", value.try_into()?);
        self.codec.set_parameters(params)?;
        Ok(())
    }
    fn encode(
        &mut self,
        shared: &Shared,
        frames: &Frames,
        raw: &RawFrame,
        nanos: i64,
        force: bool,
    ) -> Result<Option<EncodedFrame>> {
        if force {
            let mut params = MediaFormat::new();
            params.set_i32("request-sync", 0);
            self.codec.set_parameters(params)?;
        }
        self.graphics.submit(&raw.image, self.size, nanos)?;
        let mut bytes = Vec::new();
        let mut keyframe = false;
        loop {
            if shared.state.lock().unwrap().stop || frames.is_stopped() {
                return Ok(None);
            }
            match self
                .codec
                .dequeue_output_buffer(Duration::from_millis(10))?
            {
                DequeuedOutputBufferInfoResult::OutputFormatChanged => {
                    let format = self.codec.output_format();
                    self.config.clear();
                    for key in ["csd-0", "csd-1"] {
                        if let Some(data) = format.buffer(key) {
                            self.config.extend_from_slice(data);
                        }
                    }
                }
                DequeuedOutputBufferInfoResult::Buffer(buffer) => {
                    let info = buffer.info();
                    let offset: usize = info.offset().try_into()?;
                    let length: usize = info.size().try_into()?;
                    let flags = info.flags();
                    let pts = info.presentation_time_us();
                    let data = buffer
                        .buffer()
                        .get(offset..offset + length)
                        .ok_or_else(|| anyhow!("invalid codec buffer range"))?;
                    if flags & 2 != 0 {
                        self.config = data.to_vec();
                    } else {
                        bytes.extend_from_slice(data);
                        keyframe |= flags & 1 != 0;
                    }
                    self.codec.release_output_buffer(buffer, false)?;
                    ensure!(
                        bytes.len() + if keyframe { self.config.len() } else { 0 }
                            <= 4 * 1024 * 1024,
                        "H264 access unit exceeds source limit"
                    );
                    if flags & 2 != 0 || flags & 8 != 0 {
                        continue;
                    }
                    ensure!(flags & 4 == 0, "unexpected encoder end of stream");
                    if bytes.is_empty() {
                        return Ok(None);
                    }
                    ensure!(
                        bytes.starts_with(&[0, 0, 1]) || bytes.starts_with(&[0, 0, 0, 1]),
                        "encoder did not produce Annex B H264"
                    );
                    if keyframe && !self.config.is_empty() {
                        let mut complete = self.config.clone();
                        complete.extend(bytes);
                        bytes = complete;
                    }
                    return Ok(Some(EncodedFrame {
                        vp8: None,
                        bytes,
                        keyframe,
                        presentation_time: frames.clock.project(pts * 1000),
                    }));
                }
                _ => {}
            }
        }
    }
}
impl Drop for Codec {
    fn drop(&mut self) {
        let _ = self.codec.stop();
    }
}

fn run(
    shared: &Shared,
    frames: Frames,
    settings: Settings,
    runtime: &tokio::runtime::Handle,
) -> Result<()> {
    let mut codec: Option<Codec> = None;
    let mut last = None;
    let mut bitrate = settings.bitrate;
    let mut pending_keyframe = true;
    let mut cadence = crate::capture::cadence::Cadence::new(settings.fps);
    let mut rate = crate::capture::cadence::AdmissionRate::default();
    let mut dropper = crate::capture::frame_dropper::FrameDropper::new();
    dropper.set_rates(bitrate as f32 / 1000., settings.fps as f32);
    while let Some(work) = runtime.block_on(next(shared, &frames, last))? {
        let (raw, explicit) = match work {
            Work::Bitrate(value) => {
                bitrate = value;
                dropper.set_rates(
                    value as f32 / 1000.,
                    rate.fps.unwrap_or(settings.fps as f32),
                );
                if let Some(codec) = &codec {
                    codec.bitrate(value)?;
                }
                continue;
            }
            Work::Frame(raw, force) => (raw, force),
        };
        let fresh = last.is_none_or(|last| raw.nanos > last);
        // Explicit local-capture PLI may present the current static image once.
        let nanos = if explicit && !fresh {
            Clock::now()?
        } else {
            raw.nanos
        };
        last = Some(nanos);
        let mut force = explicit || pending_keyframe;
        if !force && !cadence.accept(nanos / 100) {
            continue;
        }
        if fresh {
            if let Some(fps) = rate.observe(nanos / 100) {
                dropper.set_rates(bitrate as f32 / 1000., fps);
            }
            dropper.leak(rate.fps.unwrap_or(settings.fps as f32).round().max(1.) as u32);
        }
        if !force && dropper.drop_frame() {
            continue;
        }
        let (w, h) = raw.image.size();
        let fitted = Settings {
            bitrate,
            ..settings.fitted(w as f64, h as f64)
        };
        if codec
            .as_ref()
            .is_none_or(|codec| codec.size != (fitted.width, fitted.height))
        {
            drop(codec.take());
            codec = Some(Codec::new(&frames, fitted)?);
            force = true;
        }
        if let Some(frame) = codec
            .as_mut()
            .unwrap()
            .encode(shared, &frames, &raw, nanos, force)?
        {
            pending_keyframe = force && !frame.keyframe;
            dropper.fill(frame.bytes.len(), !frame.keyframe);
            let mut state = shared.state.lock().unwrap();
            if state.stop {
                break;
            }
            state.output.push_back(frame);
            drop(state);
            shared.available.notify_waiters();
        } else {
            pending_keyframe = force;
        }
    }
    Ok(())
}
impl Drop for Encoding {
    fn drop(&mut self) {
        self.shared.stop();
        if let Some(thread) = self.thread.take() {
            if let Err(error) = thread
                .join()
                .map_err(|_| anyhow!("encoding worker panicked"))
                .and_then(|result| result)
            {
                eprintln!("Android encoding cleanup: {error:#}");
            }
        }
    }
}

enum Work {
    Bitrate(u32),
    Frame(RawFrame, bool),
}
async fn next(shared: &Shared, frames: &Frames, previous: Option<i64>) -> Result<Option<Work>> {
    loop {
        let changed = shared.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let (force, has_room) = {
            let mut state = shared.state.lock().unwrap();
            if state.stop {
                return Ok(None);
            }
            if let Some(bitrate) = state.bitrate.take() {
                return Ok(Some(Work::Bitrate(bitrate)));
            }
            (state.force, state.output.len() < 2)
        };
        if has_room {
            tokio::select! {
                raw = frames.recv_after(if force { None } else { previous }) => {
                    let Some(raw) = raw? else { return Ok(None); };
                    let mut state = shared.state.lock().unwrap();
                    if state.stop { return Ok(None); }
                    return Ok(Some(Work::Frame(raw, std::mem::take(&mut state.force))));
                },
                _ = &mut changed => {},
            }
        } else {
            tokio::select! {
                _ = frames.stopped() => {
                    // Preserve the source's existing terminal error without a
                    // second error/watch owner, even while AU output is full.
                    frames.recv_after(None).await?;
                    return Ok(None);
                },
                _ = &mut changed => {},
            }
        }
    }
}
