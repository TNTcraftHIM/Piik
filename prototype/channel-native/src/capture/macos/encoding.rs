//! One codec thread per encoding; one VT frame in flight and two ordered AUs.
use super::{checked, Clock, Frames, Image, RawFrame};
use crate::capture::{FrameTiming, Settings};
use crate::EncodedFrame;
use anyhow::{anyhow, ensure, Result};
use cidre::{arc, cf, cm, cv, objc, vt};
use std::{
    collections::VecDeque,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Instant,
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
    pub fn start(frames: Frames, settings: Settings) -> Result<Self> {
        settings.validate()?;
        ensure!(settings.fps <= i32::MAX as u32, "invalid encoder FPS");
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
            .name("piik-mac-encoding".into())
            .spawn(move || {
                let mut result = Ok(());
                objc::ar_pool(|| result = run(&worker, frames, settings, &runtime));
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
impl Drop for Encoding {
    fn drop(&mut self) {
        self.shared.stop();
        if let Some(thread) = self.thread.take() {
            if let Err(error) = thread
                .join()
                .map_err(|_| anyhow!("encoding worker panicked"))
                .and_then(|result| result)
            {
                eprintln!("Mac encoding cleanup: {error:#}");
            }
        }
    }
}

enum Work {
    Bitrate(u32),
    Frame(RawFrame, bool),
}
async fn next(shared: &Shared, frames: &Frames, previous: Option<Instant>) -> Result<Option<Work>> {
    let source = frames.control();
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
                raw = frames.recv_after(if force && frames.timing() == FrameTiming::Capture { None } else { previous }) => {
                    let Some(raw) = raw? else { return Ok(None); };
                    let mut state = shared.state.lock().unwrap();
                    if state.stop { return Ok(None); }
                    return Ok(Some(Work::Frame(raw, std::mem::take(&mut state.force))));
                },
                _ = &mut changed => {},
            }
        } else {
            tokio::select! {
                _ = source.stopped() => {
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

struct Codec {
    session: arc::R<vt::CompressionSession>,
    transfer: arc::R<vt::PixelTransferSession>,
    size: (u32, u32),
}
impl Codec {
    fn new(settings: Settings) -> Result<Self> {
        use vt::compression::{encoder_spec_keys as spec, keys, profile_level};
        let attrs = cf::Dictionary::with_keys_values(
            &[
                cv::pixel_buffer_keys::pixel_format(),
                cv::pixel_buffer_keys::io_surf_props(),
            ],
            &[
                cv::PixelFormat::_32_BGRA.to_cf_number(),
                &*cf::Dictionary::new(),
            ],
        )
        .ok_or_else(|| anyhow!("image attributes allocation failed"))?;
        let transfer = checked(vt::PixelTransferSession::new())?;
        let hardware = cf::Dictionary::with_keys_values(
            &[spec::require_hw_accelerated_video_encoder()],
            &[cf::Boolean::value_true()],
        )
        .ok_or_else(|| anyhow!("hardware specification allocation failed"))?;
        let session = checked(vt::CompressionSession::new::<()>(
            settings.width,
            settings.height,
            cm::VideoCodec::H264,
            Some(&hardware),
            Some(&attrs),
            None,
            None,
            std::ptr::null_mut(),
        ))?;
        // Construct the complete owner before property/prepare calls so every
        // partial initialization error still invalidates both sessions.
        let mut codec = Self {
            session,
            transfer,
            size: (settings.width, settings.height),
        };
        checked(codec.transfer.set_scaling_normal())?;
        checked(
            codec
                .session
                .set_prop(keys::real_time(), Some(cf::Boolean::value_true())),
        )?;
        checked(codec.session.set_prop(
            keys::allow_frame_reordering(),
            Some(cf::Boolean::value_false()),
        ))?;
        checked(codec.session.set_prop(
            keys::profile_lvl(),
            Some(profile_level::h264::constrained_baseline_auto_lvl()),
        ))?;
        checked(codec.session.set_prop(
            keys::expected_frame_rate(),
            Some(&cf::Number::from_i32(settings.fps as i32)),
        ))?;
        codec.bitrate(settings.bitrate)?;
        checked(codec.session.prepare())?;
        Ok(codec)
    }
    fn fits(&self, settings: Settings) -> bool {
        self.size == (settings.width, settings.height)
    }
    fn bitrate(&mut self, bitrate: u32) -> Result<()> {
        checked(self.session.set_prop(
            vt::compression::keys::avarage_bit_rate(),
            Some(&cf::Number::from_i64(i64::from(bitrate))),
        ))
    }
    fn encode(
        &mut self,
        image: &Image,
        time: Instant,
        force: bool,
        clock: Clock,
    ) -> Result<Option<EncodedFrame>> {
        // VT may retain an input after its AU callback. Its pool alone decides
        // when that pixel buffer can be reused; never overwrite a submitted image.
        let pool = self
            .session
            .pixel_buf_pool()
            .ok_or_else(|| anyhow!("missing VT input pool"))?;
        let destination = checked(pool.pixel_buf())?;
        checked(self.transfer.transfer(image.pixels(), &destination))?;
        let props = if force {
            Some(
                cf::Dictionary::with_keys_values(
                    &[vt::compression_props::frame_keys::force_key_frame()],
                    &[cf::Boolean::value_true()],
                )
                .ok_or_else(|| anyhow!("frame properties allocation failed"))?,
            )
        } else {
            None
        };
        let pts = clock.timestamp(time);
        let (reply, result) = mpsc::sync_channel(1);
        checked(self.session.enc_frame_with_output_handler(
            &destination,
            pts,
            cm::Time::invalid(),
            props.as_deref(),
            std::ptr::null_mut(),
            move |status, flags, sample| {
                let output = checked(status.result()).and_then(|_| {
                    if flags.contains(vt::EncodeInfoFlags::FRAME_DROPPED) {
                        return Ok(None);
                    }
                    sample.map(|sample| access_unit(sample, clock)).transpose()
                });
                let _ = reply.send(output);
            },
        ))?;
        drop(destination);
        match result.try_recv() {
            Ok(frame) => frame,
            Err(mpsc::TryRecvError::Disconnected) => {
                Err(anyhow!("VT callback closed before output"))
            }
            Err(mpsc::TryRecvError::Empty) => {
                // Same public completion pattern used by the prior mature VT
                // wrapper: force only this accepted frame out if still pending.
                checked(self.session.complete_frames(pts))?;
                result
                    .recv()
                    .map_err(|_| anyhow!("VT callback closed before output"))?
            }
        }
    }
}
impl Drop for Codec {
    fn drop(&mut self) {
        self.session.invalidate();
        self.transfer.invalidate();
    }
}
fn access_unit(sample: &cm::SampleBuf, clock: Clock) -> Result<EncodedFrame> {
    let keyframe = sample.is_key_frame();
    let format = sample
        .format_desc()
        .ok_or_else(|| anyhow!("missing H264 format"))?;
    let (count, header) = checked(format.h264_params_count_and_header_len())?;
    ensure!((1..=4).contains(&header), "invalid H264 length header");
    let mut bytes = Vec::new();
    if keyframe {
        for index in 0..count {
            bytes.extend_from_slice(&[0, 0, 0, 1]);
            bytes.extend_from_slice(checked(format.h264_param_set_at(index))?);
        }
    }
    let block = sample
        .data_buf()
        .ok_or_else(|| anyhow!("missing H264 data"))?;
    let data = checked(Vec::<u8>::try_from(block))?;
    ensure!(!data.is_empty(), "empty H264 output");
    let mut data = data.as_slice();
    while !data.is_empty() {
        let header = header as usize;
        ensure!(data.len() >= header, "truncated H264 length");
        let length = data[..header]
            .iter()
            .fold(0usize, |size, byte| (size << 8) | usize::from(*byte));
        data = &data[header..];
        ensure!(length > 0 && length <= data.len(), "truncated H264 NAL");
        bytes.extend_from_slice(&[0, 0, 0, 1]);
        bytes.extend_from_slice(&data[..length]);
        data = &data[length..];
    }
    Ok(EncodedFrame {
        vp8: None,
        bytes,
        keyframe,
        presentation_time: clock.project(sample.pts())?,
    })
}

fn run(
    shared: &Shared,
    frames: Frames,
    settings: Settings,
    runtime: &tokio::runtime::Handle,
) -> Result<()> {
    let clock = frames.clock();
    let mut cadence = crate::capture::cadence::Cadence::new(settings.fps);
    let mut codec: Option<Codec> = None;
    let mut bitrate = settings.bitrate;
    let mut last = None;
    let mut pending_keyframe = false;
    let result = (|| {
        while let Some(work) = runtime.block_on(next(shared, &frames, last))? {
            let (raw, explicit_force) = match work {
                Work::Bitrate(next) => {
                    bitrate = next;
                    if let Some(codec) = &mut codec {
                        codec.bitrate(bitrate)?;
                    }
                    continue;
                }
                Work::Frame(raw, force) => (raw, force),
            };
            // Capture-only: an explicit request may refresh this current static
            // snapshot once at current host time. This is not Source/derived
            // timing. Natural source frames always retain their original PTS.
            let time = if frames.timing() == FrameTiming::Capture
                && explicit_force
                && last.is_some_and(|last| raw.time <= last)
            {
                clock.project(cm::Clock::host_time_clock().time())?
            } else {
                raw.time
            };
            last = Some(time);
            let mut force = explicit_force || pending_keyframe;
            if frames.timing() == FrameTiming::Capture
                && !force
                && !cadence.accept(clock.timestamp(time).value / 100)
            {
                continue;
            }
            let (width, height) = raw.image.size();
            let fitted = Settings {
                bitrate,
                ..settings.fitted(width, height)
            };
            if codec.as_ref().is_none_or(|codec| !codec.fits(fitted)) {
                // Each encode returns only after its one callback; no old AU is
                // in flight when this session is invalidated on a size change.
                drop(codec.take());
                codec = Some(Codec::new(fitted)?);
                force = true;
            }
            let frame = codec
                .as_mut()
                .unwrap()
                .encode(&raw.image, time, force, clock)?;
            let Some(frame) = frame else {
                pending_keyframe = force;
                continue;
            };
            pending_keyframe = force && !frame.keyframe;
            let mut state = shared.state.lock().unwrap();
            if state.stop {
                break;
            }
            state.output.push_back(frame);
            drop(state);
            shared.available.notify_waiters();
        }
        Ok(())
    })();
    // The sole codec owner completes and invalidates on this thread before joining.
    // A failure retires only this encoding; Frames/source/audio remain untouched.
    let completed = codec
        .as_ref()
        .map_or(Ok(()), |codec| checked(codec.session.complete_all()));
    drop(codec);
    result.and(completed)
}
