//! Independent source sound; audio failure never retires the video source.
use super::{checked, source::audio_filter, Clock};
use crate::capture::{AudioCapabilities, AudioFrame, Target};
use anyhow::{anyhow, ensure, Context as _, Result};
use cidre::sc::stream::{Delegate as _, Output as _};
use cidre::{cat, cm, define_obj_type, dispatch, ns, objc, sc};
use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, Notify};

pub fn audio_capabilities() -> AudioCapabilities {
    AudioCapabilities {
        process_audio: true,
        system_audio: true,
    }
}

#[derive(Default)]
struct State {
    stop: bool,
    error: Option<String>,
}
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Notify,
}
impl Shared {
    fn finish(&self, error: Option<String>) {
        let mut state = self.state.lock().unwrap();
        state.stop = true;
        if state.error.is_none() {
            state.error = error;
        }
        drop(state);
        self.changed.notify_waiters();
    }
}
#[derive(Clone)]
pub struct AudioControl(Arc<Shared>);
impl AudioControl {
    pub fn stop(&self) {
        self.0.finish(None);
    }
    pub fn is_stopped(&self) -> bool {
        self.0.state.lock().unwrap().stop
    }
    async fn stopped(&self) {
        loop {
            let changed = self.0.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.is_stopped() {
                return;
            }
            changed.await;
        }
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
    pub fn start(target: Target) -> Result<Self> {
        let runtime = tokio::runtime::Handle::try_current()?;
        let control = AudioControl(Arc::new(Shared::default()));
        let worker = control.clone();
        let (frames, receiver) = mpsc::channel(2);
        let (ready, started) = oneshot::channel();
        let (complete, completion) = oneshot::channel();
        let thread = thread::Builder::new()
            .name("piik-mac-audio".into())
            .spawn(move || {
                let mut ready = Some(ready);
                let mut result = Ok(());
                objc::ar_pool(|| {
                    result = runtime.block_on(run(target, &worker, frames, &mut ready));
                });
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
    /// Confirms SC start, including silence; does not await the first PCM.
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
            .and_then(|result| result);
        self.completion = None;
        result.err().map(Err)
    }
    /// Blocking owner joins outside media/input locks and async signaling turns.
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
    fn push(&mut self, sample: [f32; 2], time: Instant) -> Option<AudioFrame> {
        if self.samples.is_empty() {
            self.first = Some(time);
        }
        self.samples.extend_from_slice(&sample);
        (self.samples.len() == 1920).then(|| AudioFrame {
            samples: std::mem::replace(&mut self.samples, Vec::with_capacity(1920)),
            presentation_time: self.first.take().unwrap(),
        })
    }
}
struct OutputState {
    control: AudioControl,
    clock: Clock,
    pcm: Pcm,
    frames: mpsc::Sender<AudioFrame>,
}
define_obj_type!(
    Output + sc::stream::OutputImpl,
    OutputState,
    PIIK_CIDRE_AUDIO_OUTPUT
);
impl sc::stream::Output for Output {}
#[objc::add_methods]
impl sc::stream::OutputImpl for Output {
    extern "C" fn impl_stream_did_output_sample_buf(
        &mut self,
        _cmd: Option<&objc::Sel>,
        stream: &sc::Stream,
        sample: &mut cm::SampleBuf,
        kind: sc::OutputType,
    ) {
        if kind != sc::OutputType::Audio || self.inner().control.is_stopped() {
            return;
        }
        if let Err(error) = self.inner_mut().receive(stream, sample) {
            self.inner().control.0.finish(Some(format!("{error:#}")));
        }
    }
}
define_obj_type!(
    Delegate + sc::stream::DelegateImpl,
    AudioControl,
    PIIK_CIDRE_AUDIO_DELEGATE
);
impl sc::stream::Delegate for Delegate {}
#[objc::add_methods]
impl sc::stream::DelegateImpl for Delegate {
    extern "C" fn impl_stream_did_stop_with_err(
        &mut self,
        _cmd: Option<&objc::Sel>,
        _stream: &sc::Stream,
        error: &ns::Error,
    ) {
        self.inner().0.finish(Some(format!("{error:?}")));
    }
}
impl OutputState {
    fn receive(&mut self, stream: &sc::Stream, sample: &cm::SampleBuf) -> Result<()> {
        let format = sample
            .format_desc()
            .and_then(|format| format.stream_basic_desc())
            .context("audio format missing")?;
        ensure!(
            format.format == cat::audio::Format::LINEAR_PCM
                && format.sample_rate == 48_000.0
                && format.channels_per_frame == 2
                && format.bits_per_channel == 32
                && format
                    .format_flags
                    .contains(cat::audio::FormatFlags::IS_FLOAT)
                && format.is_native_endian(),
            "expected 48k stereo Float32 PCM"
        );
        let count = usize::try_from(sample.num_samples())?;
        if count == 0 {
            return Ok(());
        }
        let retained = checked(sample.audio_buf_list::<2>())?;
        let buffers = retained.list();
        let planar = buffers.number_buffers == 2;
        let buffers = match buffers.number_buffers {
            1 => &buffers.buffers[..1],
            2 => &buffers.buffers[..2],
            _ => return Err(anyhow!("invalid stereo buffer count")),
        };
        ensure!(
            buffers.iter().all(|buffer| {
                buffer.number_channels == if planar { 1 } else { 2 }
                    && buffer.data_bytes_size as usize == count * if planar { 4 } else { 8 }
                    && !buffer.data.is_null()
            }),
            "invalid stereo buffer layout"
        );
        let clock = stream
            .synchronization_clock()
            .context("missing SC synchronization clock")?;
        let pts = clock.convert_time_to(sample.pts(), cm::Clock::host_time_clock());
        let time = self.clock.project(pts)?;
        let bytes = |channel: usize| {
            let buffer = &buffers[if planar { channel } else { 0 }];
            // CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer retains
            // these contiguous buffers in `retained` for this callback. The
            // validated lengths above bound every read; no sample pointer escapes.
            unsafe { std::slice::from_raw_parts(buffer.data, buffer.data_bytes_size as usize) }
        };
        for index in 0..count {
            let value = |channel| {
                let offset = (if planar { index } else { index * 2 + channel }) * 4;
                f32::from_ne_bytes(bytes(channel)[offset..offset + 4].try_into().unwrap())
            };
            if let Some(frame) = self.pcm.push(
                [value(0), value(1)],
                time + Duration::from_nanos(index as u64 * 1_000_000_000 / 48_000),
            ) {
                match self.frames.try_send(frame) {
                    Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        return Err(anyhow!("audio consumer closed"));
                    }
                }
            }
        }
        Ok(())
    }
}

async fn run(
    target: Target,
    control: &AudioControl,
    frames: mpsc::Sender<AudioFrame>,
    ready: &mut Option<oneshot::Sender<Result<()>>>,
) -> Result<()> {
    let filter = tokio::select! {
        _ = control.stopped() => return Ok(()),
        filter = audio_filter(&target) => filter?,
    };
    let mut cfg = sc::StreamCfg::new();
    cfg.set_captures_audio(true);
    cfg.set_excludes_current_process_audio(true);
    cfg.set_sample_rate(48_000);
    cfg.set_channel_count(2);
    let output = Output::with(OutputState {
        control: control.clone(),
        clock: Clock::new(),
        pcm: Pcm::default(),
        frames,
    });
    let delegate = Delegate::with(control.clone());
    let queue = dispatch::Queue::serial_with_ar_pool();
    let stream = sc::Stream::with_delegate(&filter, &cfg, delegate.as_ref());
    checked(stream.add_stream_output(output.as_ref(), sc::OutputType::Audio, Some(&queue)))?;
    let result: Result<()> = async {
        checked(stream.start().await)?;
        if let Some(ready) = ready.take() {
            let _ = ready.send(Ok(()));
        }
        control.stopped().await;
        Ok(())
    }
    .await;
    let stopped = checked(stream.stop().await);
    queue.sync(|| {});
    let removed = checked(stream.remove_stream_output(output.as_ref(), sc::OutputType::Audio));
    result?;
    if let Some(error) = &control.0.state.lock().unwrap().error {
        return Err(anyhow!(error.clone()));
    }
    stopped.and(removed)
}
