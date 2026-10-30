//! System-output sound, independent of Portal selection and video failure.
use super::{message_error, Clock, Pipeline};
use crate::capture::{AudioCapabilities, AudioFrame, Target};
use anyhow::{anyhow, ensure, Context as _, Result};
use futures_util::StreamExt;
use gst::prelude::*;
use std::{
    thread,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, watch};

pub fn audio_capabilities() -> AudioCapabilities {
    AudioCapabilities {
        process_audio: false,
        system_audio: gst::init().is_ok() && gst::ElementFactory::find("pulsesrc").is_some(),
    }
}

#[derive(Clone)]
pub struct AudioControl(watch::Sender<bool>);
impl AudioControl {
    pub fn stop(&self) {
        self.0.send_replace(true);
    }
    pub fn is_stopped(&self) -> bool {
        *self.0.borrow()
    }
    async fn stopped(&self) {
        let mut stopped = self.0.subscribe();
        let _ = stopped.wait_for(|stopped| *stopped).await;
    }
}
pub struct AudioCapture {
    control: AudioControl,
    ready: Option<oneshot::Receiver<Result<()>>>,
    frames: mpsc::Receiver<AudioFrame>,
    completion: Option<oneshot::Receiver<Result<()>>>,
    thread: Option<thread::JoinHandle<()>>,
}
impl AudioCapture {
    pub fn start(_target: Target) -> Result<Self> {
        gst::init()?;
        let runtime = tokio::runtime::Handle::try_current()?;
        let control = AudioControl(watch::channel(false).0);
        let worker = control.clone();
        let (frames, receiver) = mpsc::channel(2);
        let (ready, started) = oneshot::channel();
        let (complete, completion) = oneshot::channel();
        let thread = thread::Builder::new()
            .name("piik-linux-audio".into())
            .spawn(move || {
                let mut ready = Some(ready);
                let result = runtime.block_on(run(&worker, frames, &mut ready));
                if let Some(ready) = ready {
                    let error = result
                        .as_ref()
                        .err()
                        .map(|e| format!("{e:#}"))
                        .unwrap_or_else(|| "audio stopped before startup".into());
                    let _ = ready.send(Err(anyhow!(error)));
                }
                worker.stop();
                let _ = complete.send(result);
            })?;
        Ok(Self {
            control,
            ready: Some(started),
            frames: receiver,
            completion: Some(completion),
            thread: Some(thread),
        })
    }
    pub async fn ready(&mut self) -> Result<()> {
        self.ready
            .take()
            .context("audio startup already observed")?
            .await
            .context("audio ended before startup")?
    }
    pub fn control(&self) -> AudioControl {
        self.control.clone()
    }
    pub async fn recv(&mut self) -> Option<Result<AudioFrame>> {
        if let Some(frame) = self.frames.recv().await {
            return Some(Ok(frame));
        }
        let result = self
            .completion
            .as_mut()?
            .await
            .context("audio ended without completion")
            .and_then(|r| r);
        self.completion = None;
        result.err().map(Err)
    }
    pub fn stop(mut self) -> Result<()> {
        self.control.stop();
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| anyhow!("audio worker panicked"))?;
        }
        if let Some(completion) = self.completion.take() {
            completion
                .blocking_recv()
                .context("audio ended without completion")??;
        }
        Ok(())
    }
}
impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.control.stop();
    }
}

#[derive(Default)]
struct Pcm {
    samples: Vec<f32>,
    first: Option<Instant>,
}
impl Pcm {
    fn push(
        &mut self,
        sample: &gst::Sample,
        clock: &Clock,
        output: &mpsc::Sender<AudioFrame>,
    ) -> Result<()> {
        let buffer = sample.buffer().context("missing PCM buffer")?;
        if buffer.flags().contains(gst::BufferFlags::DISCONT) {
            self.samples.clear();
            self.first = None;
        }
        let time = clock.sample_time(sample)?;
        // appsink may discard a raw buffer without marking its successor
        // DISCONT. Never combine samples from opposite sides of that gap.
        if let Some(first) = self.first {
            let expected = first
                + Duration::from_nanos(self.samples.len() as u64 / 2 * 1_000_000_000 / 48_000);
            let distance = if time >= expected {
                time.duration_since(expected)
            } else {
                expected.duration_since(time)
            };
            if distance > Duration::from_nanos(1_000_000_000 / 48_000 + 1) {
                self.samples.clear();
                self.first = None;
            }
        }
        let bytes = buffer.map_readable()?;
        ensure!(bytes.len() % 8 == 0, "invalid stereo Float32 PCM length");
        for (index, stereo) in bytes.chunks_exact(8).enumerate() {
            if self.samples.is_empty() {
                self.first =
                    Some(time + Duration::from_nanos(index as u64 * 1_000_000_000 / 48_000));
            }
            self.samples.extend(
                stereo
                    .chunks_exact(4)
                    .map(|s| f32::from_le_bytes(s.try_into().unwrap())),
            );
            if self.samples.len() == 1920 {
                let frame = AudioFrame {
                    samples: std::mem::replace(&mut self.samples, Vec::with_capacity(1920)),
                    presentation_time: self.first.take().unwrap(),
                };
                match output.try_send(frame) {
                    Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        return Err(anyhow!("audio consumer closed"))
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_queue_loss_does_not_join_pcm_across_a_timestamp_gap() -> Result<()> {
        gst::init()?;
        let clock = Clock::new();
        let start = clock.now()?;
        let (output, mut receiver) = mpsc::channel(2);
        let mut pcm = Pcm::default();
        let sample = |millis: u64, value: f32| -> Result<gst::Sample> {
            let mut buffer = gst::Buffer::from_mut_slice(value.to_le_bytes().repeat(960));
            buffer
                .get_mut()
                .unwrap()
                .set_pts(clock.timestamp(start + Duration::from_millis(millis))?);
            let segment = gst::FormattedSegment::<gst::ClockTime>::new();
            Ok(gst::Sample::builder()
                .buffer(&buffer)
                .segment(&segment)
                .build())
        };
        pcm.push(&sample(0, 0.1)?, &clock, &output)?;
        // The 10 ms sample was dropped by appsink, with no DISCONT flag.
        pcm.push(&sample(20, 0.2)?, &clock, &output)?;
        assert!(receiver.try_recv().is_err());
        pcm.push(&sample(30, 0.3)?, &clock, &output)?;
        let frame = receiver.try_recv()?;
        assert_eq!(frame.presentation_time, start + Duration::from_millis(20));
        assert_eq!(frame.samples.len(), 1920);
        assert!(frame.samples[..960].iter().all(|s| *s == 0.2));
        assert!(frame.samples[960..].iter().all(|s| *s == 0.3));
        Ok(())
    }
}

async fn run(
    control: &AudioControl,
    frames: mpsc::Sender<AudioFrame>,
    ready: &mut Option<oneshot::Sender<Result<()>>>,
) -> Result<()> {
    let pipeline = Pipeline(gst::Pipeline::new());
    let clock = Clock::new();
    clock.pipeline(&pipeline.0);
    let source = gst::ElementFactory::make("pulsesrc")
        .property("device", "@DEFAULT_MONITOR@")
        .build()?;
    let convert = gst::ElementFactory::make("audioconvert").build()?;
    let resample = gst::ElementFactory::make("audioresample").build()?;
    let caps = gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("channels", 2i32)
        .field("rate", 48_000i32)
        .build();
    let sink = gst_app::AppSink::builder()
        .caps(&caps)
        .sync(false)
        .async_(false)
        .enable_last_sample(false)
        .max_buffers(2)
        .drop(true)
        .wait_on_eos(false)
        .build();
    pipeline
        .0
        .add_many([&source, &convert, &resample, sink.upcast_ref()])?;
    gst::Element::link_many([&source, &convert, &resample, sink.upcast_ref()])?;
    let bus = pipeline.0.bus().context("missing audio bus")?;
    let mut messages = bus.stream();
    let mut samples = sink.stream();
    let mut pcm = Pcm::default();
    pipeline.0.set_state(gst::State::Playing)?;
    loop {
        tokio::select! {
            biased;
            _ = control.stopped() => return Ok(()),
            message = messages.next() => {
                let message = message.context("audio bus closed")?;
                if let Some(error) = message_error(&message) { return Err(error); }
                if let gst::MessageView::StateChanged(state) = message.view() {
                    if state.src() == Some(pipeline.0.upcast_ref()) && state.current() == gst::State::Playing {
                        if let Some(ready) = ready.take() { let _ = ready.send(Ok(())); }
                    }
                }
            },
            sample = samples.next() => pcm.push(&sample.context("audio stream ended")?, &clock, &frames)?,
        }
    }
}
