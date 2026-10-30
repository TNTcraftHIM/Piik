//! Each encoding owns its pipeline, bus and bounded complete-AU output.
use super::{message_error, Clock, Frames, Pipeline, RawFrame};
use crate::capture::{EncodedFrame, Settings};
use anyhow::{anyhow, bail, ensure, Context as _, Result};
use futures_util::{SinkExt, StreamExt};
use gst::{glib, prelude::*};
use std::{
    sync::{Arc, Mutex},
    thread,
    time::Instant,
};
use tokio::sync::Notify;

#[derive(Default)]
struct State {
    stop: bool,
    started: bool,
    done: bool,
    error: Option<String>,
    force: bool,
    bitrate: Option<u32>,
}
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Notify,
    available: Notify,
}
impl Shared {
    fn stop(&self) {
        self.state.lock().unwrap().stop = true;
        self.changed.notify_waiters();
    }
    fn finish(&self, result: &Result<()>) {
        let mut state = self.state.lock().unwrap();
        state.stop = true;
        state.done = true;
        if state.error.is_none() {
            state.error = result.as_ref().err().map(|error| format!("{error:#}"));
        }
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
    samples: gst_app::app_sink::AppSinkStream,
    clock: Clock,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Encoding {
    pub fn start(frames: Frames, settings: Settings) -> Result<Self> {
        Self::start_inner(frames, settings, None)
    }
    /// Software encoders are an explicit test input, never a capture fallback.
    #[cfg(test)]
    pub(super) fn start_with_encoder(
        frames: Frames,
        settings: Settings,
        encoder: gst::Element,
    ) -> Result<Self> {
        Self::start_inner(frames, settings, Some(encoder))
    }
    fn start_inner(
        frames: Frames,
        settings: Settings,
        encoder: Option<gst::Element>,
    ) -> Result<Self> {
        settings.validate()?;
        ensure!(settings.fps <= i32::MAX as u32, "invalid encoder FPS");
        gst::init()?;
        let runtime = tokio::runtime::Handle::try_current()?;
        let clock = frames.clock();
        // This is the only encoded queue. A full sink blocks this encoding's
        // streaming thread; appsrc's async sink remains cancellable by its owner.
        let sink = gst_app::AppSink::builder()
            .caps(&h264_caps())
            .max_buffers(2)
            .drop(false)
            .sync(false)
            .async_(false)
            .wait_on_eos(false)
            .build();
        let samples = sink.stream();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                force: true,
                ..State::default()
            }),
            ..Shared::default()
        });
        let worker = shared.clone();
        let thread = thread::Builder::new()
            .name("piik-linux-encoding".into())
            .spawn(move || {
                let result = runtime.block_on(run(&worker, frames, settings, sink, encoder));
                worker.finish(&result);
                result
            })?;
        Ok(Self {
            shared,
            samples,
            clock,
            thread: Some(thread),
        })
    }
    pub fn control(&self) -> EncodingControl {
        EncodingControl(self.shared.clone())
    }
    pub async fn recv(&mut self) -> Option<Result<EncodedFrame>> {
        loop {
            let available = self.shared.available.notified();
            tokio::pin!(available);
            available.as_mut().enable();
            let waiting = {
                let mut state = self.shared.state.lock().unwrap();
                if state.done {
                    return state.error.take().map(|error| Err(anyhow!(error)));
                }
                state.stop || !state.started
            };
            if waiting {
                available.await;
                continue;
            }
            tokio::select! {
                sample = self.samples.next() => match sample {
                    Some(sample) => return Some(access_unit(&sample, &self.clock)),
                    None => available.await,
                },
                _ = &mut available => {},
            }
        }
    }
    /// Blocking owner joins outside media/input locks and signaling turns.
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
                eprintln!("Linux encoding cleanup: {error:#}");
            }
        }
    }
}

fn h264_caps() -> gst::Caps {
    gst::Caps::builder("video/x-h264")
        .field("profile", "constrained-baseline")
        .field("stream-format", "byte-stream")
        .field("alignment", "au")
        .build()
}
fn access_unit(sample: &gst::Sample, clock: &Clock) -> Result<EncodedFrame> {
    let buffer = sample.buffer().context("missing encoded AU")?;
    let bytes = buffer.map_readable()?;
    ensure!(!bytes.is_empty(), "empty encoded AU");
    Ok(EncodedFrame {
        bytes: bytes.as_slice().to_vec(),
        presentation_time: clock.sample_time(sample)?,
        keyframe: !buffer.flags().contains(gst::BufferFlags::DELTA_UNIT),
    })
}

/// The hardware plugin owns its numeric property types and legal range.
fn numeric(element: &gst::Element, name: &str, value: u64) -> Result<bool> {
    let Some(property) = element.find_property(name) else {
        return Ok(false);
    };
    ensure!(
        property.flags().contains(glib::ParamFlags::WRITABLE),
        "{name} is read-only"
    );
    let setting = if let Some(p) = property.downcast_ref::<glib::ParamSpecUInt>() {
        ensure!(
            value >= u64::from(p.minimum()) && value <= u64::from(p.maximum()),
            "{name} out of range"
        );
        (value as u32).to_value()
    } else if let Some(p) = property.downcast_ref::<glib::ParamSpecInt>() {
        ensure!(
            i128::from(value) >= i128::from(p.minimum())
                && i128::from(value) <= i128::from(p.maximum()),
            "{name} out of range"
        );
        (value as i32).to_value()
    } else if let Some(p) = property.downcast_ref::<glib::ParamSpecUInt64>() {
        ensure!(
            value >= p.minimum() && value <= p.maximum(),
            "{name} out of range"
        );
        value.to_value()
    } else if let Some(p) = property.downcast_ref::<glib::ParamSpecInt64>() {
        ensure!(
            i128::from(value) >= i128::from(p.minimum())
                && i128::from(value) <= i128::from(p.maximum()),
            "{name} out of range"
        );
        (value as i64).to_value()
    } else {
        bail!("unsupported numeric property {name}");
    };
    element.set_property_from_value(name, &setting);
    Ok(true)
}
fn boolean(element: &gst::Element, name: &str, value: bool) {
    if element.find_property(name).is_some_and(|p| {
        p.value_type() == bool::static_type() && p.flags().contains(glib::ParamFlags::WRITABLE)
    }) {
        element.set_property(name, value);
    }
}
fn enum_nick(element: &gst::Element, name: &str, nick: &str) {
    let Some(property) = element.find_property(name) else {
        return;
    };
    if !property.flags().contains(glib::ParamFlags::WRITABLE) {
        return;
    }
    if let Some(value) = glib::EnumClass::with_type(property.value_type())
        .and_then(|class| class.to_value_by_nick(nick))
    {
        element.set_property_from_value(name, &value);
    }
}
/// These H264 plugin families explicitly define bitrate in kbit/s:
/// https://gstreamer.freedesktop.org/documentation/va/vah264enc.html#vah264enc:bitrate
/// https://gstreamer.freedesktop.org/documentation/nvcodec/nvh264enc.html#nvh264enc:bitrate
/// https://gstreamer.freedesktop.org/documentation/msdk/msdkh264enc.html#msdkh264enc:bitrate
/// https://gstreamer.freedesktop.org/documentation/qsv/qsvh264enc.html#qsvh264enc:bitrate
/// https://github.com/GStreamer/gstreamer-vaapi/blob/c3ddb29cb2860374f9efbed495af7b0eead08312/gst-libs/gst/vaapi/gstvaapiencoder.c
fn supports_live_kbps(encoder: &gst::Element) -> bool {
    let Some(factory) = encoder.factory() else {
        return false;
    };
    let supported = matches!(
        factory.plugin_name().as_deref(),
        Some("va" | "nvcodec" | "msdk" | "qsv" | "vaapi")
    );
    // The software reference is reachable only through explicit test injection;
    // the production candidate list still requires Hardware classification.
    #[cfg(test)]
    let supported = supported || factory.name() == "x264enc";
    supported
        && encoder.find_property("bitrate").is_some_and(|property| {
            property
                .flags()
                .contains(glib::ParamFlags::WRITABLE | gst::PARAM_FLAG_MUTABLE_PLAYING)
                && [
                    u32::static_type(),
                    i32::static_type(),
                    u64::static_type(),
                    i64::static_type(),
                ]
                .contains(&property.value_type())
        })
}
fn hardware_factories() -> Vec<gst::ElementFactory> {
    let required = gst::Caps::builder("video/x-h264")
        .field("profile", "constrained-baseline")
        .build();
    gst::ElementFactory::factories_with_type(
        gst::ElementFactoryType::VIDEO_ENCODER,
        gst::Rank::NONE,
    )
    .into_iter()
    .filter(|factory| {
        factory
            .metadata("klass")
            .is_some_and(|class| class.split('/').any(|part| part == "Hardware"))
            && factory.static_pad_templates().iter().any(|pad| {
                pad.direction() == gst::PadDirection::Src && pad.caps().can_intersect(&required)
            })
    })
    .collect()
}

struct Codec {
    pipeline: Pipeline,
    input: gst_app::AppSrc,
    fitted: gst::Element,
    encoder: gst::Element,
}
impl Codec {
    fn new(
        clock: &Clock,
        settings: Settings,
        sink: gst_app::AppSink,
        encoder: Option<gst::Element>,
    ) -> Result<Self> {
        if let Some(encoder) = encoder {
            return Self::attempt(clock, settings, &sink, encoder);
        }
        let mut error = anyhow!("no hardware H264 encoder with live bitrate control");
        for factory in hardware_factories() {
            let attempt = factory
                .create()
                .build()
                .map_err(anyhow::Error::from)
                .and_then(|encoder| Self::attempt(clock, settings, &sink, encoder));
            match attempt {
                Ok(codec) => return Ok(codec),
                Err(failure) => {
                    error = failure.context(format!("{} initialization failed", factory.name()))
                }
            }
        }
        Err(error)
    }
    fn attempt(
        clock: &Clock,
        settings: Settings,
        sink: &gst_app::AppSink,
        encoder: gst::Element,
    ) -> Result<Self> {
        let result = Self::with_encoder(clock, settings, sink, encoder);
        if result.is_err() {
            // with_encoder's Pipeline RAII has already moved the failed
            // pipeline to NULL. Remove its sink before the next device attempt.
            if let Some(parent) = sink
                .parent()
                .and_then(|parent| parent.downcast::<gst::Bin>().ok())
            {
                if let Err(error) = parent.remove(sink) {
                    eprintln!("Linux encoder sink cleanup: {error}");
                }
            }
        }
        result
    }
    fn with_encoder(
        clock: &Clock,
        settings: Settings,
        sink: &gst_app::AppSink,
        encoder: gst::Element,
    ) -> Result<Self> {
        ensure!(
            supports_live_kbps(&encoder),
            "encoder has no supported live kbps contract"
        );
        let pipeline = Pipeline(gst::Pipeline::new());
        clock.pipeline(&pipeline.0);
        let input = gst_app::AppSrc::builder()
            .is_live(true)
            .format(gst::Format::Time)
            .block(false)
            .max_bytes(1)
            .build();
        let convert = gst::ElementFactory::make("videoconvert").build()?;
        let scale = gst::ElementFactory::make("videoscale").build()?;
        let fitted = gst::ElementFactory::make("capsfilter").build()?;
        let profile = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-h264")
                    .field("profile", "constrained-baseline")
                    .build(),
            )
            .build()?;
        let parser = gst::ElementFactory::make("h264parse")
            .property("config-interval", -1i32)
            .build()?;
        let elements: [&gst::Element; 8] = [
            input.upcast_ref(),
            &convert,
            &scale,
            &fitted,
            &encoder,
            &profile,
            &parser,
            sink.upcast_ref(),
        ];
        pipeline.0.add_many(elements)?;
        gst::Element::link_many(elements)?;
        let codec = Self {
            pipeline,
            input,
            fitted,
            encoder,
        };
        codec.bitrate(settings.bitrate)?;
        for property in ["key-int-max", "gop-size"] {
            numeric(&codec.encoder, property, u64::from(settings.fps) * 2)?;
        }
        for property in ["b-frames", "bframes"] {
            numeric(&codec.encoder, property, 0)?;
        }
        boolean(&codec.encoder, "cabac", false);
        boolean(&codec.encoder, "aud", true);
        boolean(&codec.encoder, "zerolatency", true);
        enum_nick(&codec.encoder, "rate-control", "cbr");
        enum_nick(&codec.encoder, "rc-mode", "cbr");
        // Hardware factories can exist without a usable device. READY opens
        // that actual encoder; retain this same pipeline when initialization wins.
        codec.pipeline.0.set_state(gst::State::Ready)?;
        codec.pipeline.0.set_state(gst::State::Playing)?;
        Ok(codec)
    }
    fn bitrate(&self, bitrate: u32) -> Result<()> {
        numeric(&self.encoder, "bitrate", u64::from(bitrate).div_ceil(1_000))?;
        Ok(())
    }
    fn sample(
        &self,
        mut raw: RawFrame,
        time: Instant,
        settings: Settings,
        clock: &Clock,
        force: bool,
    ) -> Result<gst::Sample> {
        let fitted = settings.fitted(f64::from(raw.info.width()), f64::from(raw.info.height()));
        let fitted_caps = gst::Caps::builder("video/x-raw")
            .field("width", fitted.width as i32)
            .field("height", fitted.height as i32)
            .field("pixel-aspect-ratio", gst::Fraction::new(1, 1))
            .build();
        if self.fitted.property::<Option<gst::Caps>>("caps").as_ref() != Some(&fitted_caps) {
            self.fitted.set_property("caps", &fitted_caps);
        }
        let mut caps = raw.info.to_caps()?;
        caps.make_mut()
            .structure_mut(0)
            .unwrap()
            .set("framerate", gst::Fraction::new(settings.fps as i32, 1));
        self.input.set_max_bytes(raw.info.size() as u64);
        let pts = clock.timestamp(time)?;
        let buffer = raw.buffer.make_mut();
        buffer.set_pts(pts);
        buffer.set_dts(gst::ClockTime::NONE);
        buffer.set_duration(gst::ClockTime::from_nseconds(
            1_000_000_000 / u64::from(settings.fps),
        ));
        if force {
            ensure!(
                self.encoder.send_event(
                    gst_video::UpstreamForceKeyUnitEvent::builder()
                        .running_time(pts)
                        .all_headers(true)
                        .build()
                ),
                "encoder rejected keyframe request"
            );
        }
        Ok(gst::Sample::builder()
            .buffer(&raw.buffer)
            .caps(&caps)
            .build())
    }
}

async fn run(
    shared: &Shared,
    frames: Frames,
    settings: Settings,
    sink: gst_app::AppSink,
    encoder: Option<gst::Element>,
) -> Result<()> {
    let clock = frames.clock();
    let source = frames.control();
    let codec = Codec::new(&clock, settings, sink, encoder)?;
    shared.state.lock().unwrap().started = true;
    shared.available.notify_waiters();
    let mut input = codec.input.sink();
    let mut messages = codec
        .pipeline
        .0
        .bus()
        .context("encoder bus missing")?
        .stream_filtered(&[gst::MessageType::Error, gst::MessageType::Eos]);
    let mut cadence = crate::capture::cadence::Cadence::new(settings.fps);
    let mut previous = None;
    let mut presentation = None;
    loop {
        let changed = shared.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let force = {
            let mut state = shared.state.lock().unwrap();
            if state.stop {
                return Ok(());
            }
            if let Some(bitrate) = state.bitrate.take() {
                codec.bitrate(bitrate)?;
            }
            state.force
        };
        let raw = tokio::select! {
            biased;
            _ = source.stopped() => {
                frames.recv_after(None).await?;
                return Ok(());
            },
            message = messages.next() => {
                return Err(message.as_deref().and_then(message_error)
                    .unwrap_or_else(|| anyhow!("encoder bus closed")));
            },
            _ = &mut changed => continue,
            raw = frames.recv_after(if force { None } else { previous }) => match raw? {
                Some(raw) => raw,
                None => return Ok(()),
            },
        };
        let force = shared.state.lock().unwrap().force;
        previous = Some(raw.time);
        let time = if force && presentation.is_some_and(|last| raw.time <= last) {
            clock.now()?
        } else {
            raw.time
        };
        if presentation.is_some_and(|last| time <= last) {
            continue;
        }
        let admitted = cadence.accept((clock.timestamp(time)?.nseconds() / 100).try_into()?);
        if !force && !admitted {
            continue;
        }
        let force = std::mem::take(&mut shared.state.lock().unwrap().force);
        let sample = codec.sample(raw, time, settings, &clock, force)?;
        loop {
            let changed = shared.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let mut state = shared.state.lock().unwrap();
                if state.stop {
                    return Ok(());
                }
                if let Some(bitrate) = state.bitrate.take() {
                    codec.bitrate(bitrate)?;
                }
            }
            tokio::select! {
                biased;
                _ = source.stopped() => {
                    frames.recv_after(None).await?;
                    return Ok(());
                },
                message = messages.next() => {
                    return Err(message.as_deref().and_then(message_error)
                        .unwrap_or_else(|| anyhow!("encoder bus closed")));
                },
                _ = &mut changed => {},
                sent = input.send(sample.clone()) => {
                    sent?;
                    break;
                },
            }
        }
        presentation = Some(time);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn software_encoder() -> Result<gst::Element> {
        Ok(gst::ElementFactory::make("x264enc")
            .property_from_str("tune", "zerolatency")
            .property_from_str("speed-preset", "ultrafast")
            .build()?)
    }
    fn publish(frames: &Frames, width: u32, height: u32, index: u8) -> Result<Instant> {
        let info = gst_video::VideoInfo::builder(gst_video::VideoFormat::Bgra, width, height)
            .fps(gst::Fraction::new(30, 1))
            .build()?;
        let mut pixels = vec![0u8; info.size()];
        for (offset, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            pixel.copy_from_slice(&[offset as u8, index, (offset >> 8) as u8, 255]);
        }
        let time = frames.clock().now()?;
        let mut buffer = gst::Buffer::from_mut_slice(pixels);
        buffer.make_mut().set_pts(frames.clock().timestamp(time)?);
        let caps = info.to_caps()?;
        let segment = gst::FormattedSegment::<gst::ClockTime>::new();
        frames.publish(
            &gst::Sample::builder()
                .buffer(&buffer)
                .caps(&caps)
                .segment(&segment)
                .build(),
        )?;
        Ok(time)
    }
    async fn next(encoding: &mut Encoding) -> Result<EncodedFrame> {
        tokio::time::timeout(Duration::from_secs(3), encoding.recv())
            .await?
            .context("encoding ended before its frame")?
    }
    async fn stop(encoding: Encoding) -> Result<()> {
        tokio::time::timeout(
            Duration::from_secs(3),
            tokio::task::spawn_blocking(move || encoding.stop()),
        )
        .await???;
        Ok(())
    }
    // Parse the actual emitted SPS using GStreamer, rather than duplicate H264
    // dimension arithmetic in the test or trust the requested raw caps.
    fn dimensions(frame: &EncodedFrame) -> Result<(i32, i32)> {
        let pipeline = Pipeline(gst::Pipeline::new());
        let input = gst_app::AppSrc::builder().caps(&h264_caps()).build();
        let parser = gst::ElementFactory::make("h264parse").build()?;
        let output = gst_app::AppSink::builder()
            .sync(false)
            .async_(false)
            .max_buffers(1)
            .build();
        let elements: [&gst::Element; 3] = [input.upcast_ref(), &parser, output.upcast_ref()];
        pipeline.0.add_many(elements)?;
        gst::Element::link_many(elements)?;
        pipeline.0.set_state(gst::State::Playing)?;
        input.push_buffer(gst::Buffer::from_mut_slice(frame.bytes.clone()))?;
        input.end_of_stream()?;
        let sample = output
            .try_pull_sample(gst::ClockTime::from_seconds(2))
            .context("H264 parser returned no AU")?;
        let info = sample
            .caps()
            .and_then(|caps| caps.structure(0))
            .context("missing encoded caps")?;
        Ok((info.get("width")?, info.get("height")?))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn independent_encodings_keep_pts_resize_and_stop_under_backpressure() -> Result<()> {
        gst::init()?;
        let frames = Frames::new();
        let settings = Settings {
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate: 1_000_000,
        };
        let mut slow = Encoding::start_with_encoder(frames.clone(), settings, software_encoder()?)?;
        let mut healthy =
            Encoding::start_with_encoder(frames.clone(), settings, software_encoder()?)?;
        let first_time = publish(&frames, 640, 360, 0)?;
        let first = next(&mut healthy).await.context("initial healthy AU")?;
        ensure!(
            first.keyframe && first.presentation_time == first_time,
            "first AU lost its capture clock"
        );
        ensure!(
            dimensions(&first)? == (640, 360),
            "small source was enlarged"
        );
        next(&mut slow).await.context("initial slow AU")?;
        let mut last = first.presentation_time;
        // Leave the other appsink unread until both its AU slots and input
        // backpressure are occupied. The healthy encoder must keep delivering.
        for index in 1..=16 {
            tokio::time::sleep(Duration::from_millis(40)).await;
            publish(&frames, 640, 360, index)?;
            let frame = next(&mut healthy)
                .await
                .context("healthy AU while sibling is unread")?;
            ensure!(
                frame.presentation_time > last,
                "healthy PTS did not advance"
            );
            last = frame.presentation_time;
        }
        slow.control().stop();
        ensure!(
            tokio::time::timeout(Duration::from_secs(3), slow.recv())
                .await?
                .is_none(),
            "stopped encoding still emitted an AU"
        );
        stop(slow).await?;

        let control = healthy.control();
        tokio::time::sleep(Duration::from_millis(40)).await;
        let resized_time = publish(&frames, 360, 640, 17)?;
        let resized = next(&mut healthy).await.context("resized AU")?;
        ensure!(
            resized.presentation_time == resized_time && resized.presentation_time > last,
            "resize changed source PTS"
        );
        ensure!(
            resized.keyframe && dimensions(&resized)? == (360, 640),
            "resize did not renegotiate an IDR at native size"
        );

        control.set_bitrate(400_000)?;
        control.force_keyframe()?;
        let repeated = next(&mut healthy)
            .await
            .context("static PLI after bitrate change")?;
        ensure!(
            repeated.keyframe && repeated.presentation_time > resized.presentation_time,
            "static PLI did not produce a fresh IDR"
        );
        ensure!(
            dimensions(&repeated)? == (360, 640),
            "static PLI changed dimensions"
        );
        ensure!(
            tokio::time::timeout(Duration::from_millis(100), healthy.recv())
                .await
                .is_err(),
            "static PLI caused repeated encoding"
        );

        frames.finish(None);
        ensure!(
            tokio::time::timeout(Duration::from_secs(3), healthy.recv())
                .await?
                .is_none(),
            "source stop did not finish its encoding"
        );
        stop(healthy).await?;
        Ok(())
    }
}
