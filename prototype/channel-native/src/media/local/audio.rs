//! The publication's two PCM inputs share one optional Opus source and capture clock.
use super::{encode_audio, RtpSource};
use crate::{
    capture::{AudioCapture, AudioControl as CaptureControl, AudioFrame},
    media::{MediaKind, Relay},
    peer::{
        Event, InitialMedia, SourceAudioSettings, SourceAudioState, SourceMicrophoneSettings,
        SourceReady,
    },
};
use anyhow::{anyhow, Result};
use futures_util::future::BoxFuture;
use rtc_shared::time::SystemInstant;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct Control {
    requests: mpsc::Sender<Request>,
    stopped: watch::Sender<bool>,
    pub source: watch::Receiver<Option<Uuid>>,
    pub state: watch::Receiver<SourceAudioState>,
    pub settings: watch::Sender<SourceAudioSettings>,
}
#[derive(Clone)]
pub(crate) struct AudioLeaseControl {
    capture: Option<CaptureControl>,
    cancelled: watch::Sender<bool>,
}
impl AudioLeaseControl {
    pub fn stop(&self) {
        self.cancelled.send_replace(true);
        if let Some(capture) = &self.capture {
            capture.stop();
        }
    }
    pub fn is_stopped(&self) -> bool {
        *self.cancelled.borrow()
    }
}
struct Input {
    capture: AudioCapture,
    system: Option<(watch::Receiver<bool>, oneshot::Sender<String>)>,
}
enum Request {
    PrepareSystem(
        Option<Input>,
        watch::Receiver<bool>,
        oneshot::Sender<Result<()>>,
    ),
    CommitSystem(watch::Receiver<bool>, oneshot::Sender<Result<()>>),
    StopSystem(oneshot::Sender<Result<()>>),
    Microphone(SourceMicrophoneSettings, oneshot::Sender<Result<()>>),
    CancelMicrophone(oneshot::Sender<Result<()>>),
}
struct Preparing {
    control: CaptureControl,
    ready: BoxFuture<'static, (Input, Result<()>)>,
    kind: PreparingKind,
    reply: oneshot::Sender<Result<()>>,
}
enum PreparingKind {
    System {
        cancelled: watch::Receiver<bool>,
        committed: bool,
    },
    Microphone(SourceMicrophoneSettings),
}
struct PreparedSystem {
    input: Option<Input>,
    cancelled: watch::Receiver<bool>,
}
impl Preparing {
    fn new(mut input: Input, kind: PreparingKind, reply: oneshot::Sender<Result<()>>) -> Self {
        Self {
            control: input.capture.control(),
            kind,
            reply,
            ready: Box::pin(async move {
                let result = input.capture.ready().await;
                (input, result)
            }),
        }
    }
    async fn close(self) {
        self.control.stop();
        let (input, _) = self.ready.await;
        close(input).await;
        let _ = self.reply.send(Err(anyhow!("capture_cancelled")));
    }
}
impl Control {
    #[cfg(test)]
    pub fn fixture() -> (Self, AudioLeaseControl) {
        let (requests, _) = mpsc::channel(1);
        let (settings, _) = watch::channel(SourceAudioSettings::default());
        (
            Self {
                requests,
                stopped: watch::channel(false).0,
                source: watch::channel(None).1,
                state: watch::channel(SourceAudioState::default()).1,
                settings: settings.clone(),
            },
            AudioLeaseControl {
                capture: None,
                cancelled: watch::channel(false).0,
            },
        )
    }
    pub fn same(&self, other: &watch::Receiver<bool>) -> bool {
        self.stopped.subscribe().same_channel(other)
    }
    pub fn is_stopped(&self) -> bool {
        *self.stopped.borrow() || self.requests.is_closed()
    }
    pub fn stop(&self) {
        self.stopped.send_replace(true);
    }
    pub async fn stop_system(&self) -> Result<()> {
        let (done, wait) = oneshot::channel();
        self.requests
            .send(Request::StopSystem(done))
            .await
            .map_err(|_| anyhow!("capture_unavailable"))?;
        wait.await.map_err(|_| anyhow!("capture_unavailable"))?
    }
    pub async fn prepare_system(
        &self,
        capture: Option<AudioCapture>,
    ) -> Result<(
        AudioLeaseControl,
        oneshot::Receiver<Result<()>>,
        Option<oneshot::Receiver<String>>,
    )> {
        let (cancel, cancelled) = watch::channel(false);
        let (warning, failed) = oneshot::channel();
        let (ready, wait) = oneshot::channel();
        let control = AudioLeaseControl {
            capture: capture.as_ref().map(AudioCapture::control),
            cancelled: cancel,
        };
        let present = capture.is_some();
        if let Err(error) = self
            .requests
            .send(Request::PrepareSystem(
                capture.map(|capture| Input {
                    capture,
                    system: Some((cancelled.clone(), warning)),
                }),
                cancelled,
                ready,
            ))
            .await
        {
            if let Request::PrepareSystem(Some(input), _, _) = error.0 {
                close(input).await;
            }
            return Err(anyhow!("capture_unavailable"));
        }
        Ok((control, wait, present.then_some(failed)))
    }
    pub async fn commit_system(&self, input: &AudioLeaseControl) -> Result<()> {
        let (done, wait) = oneshot::channel();
        self.requests
            .send(Request::CommitSystem(input.cancelled.subscribe(), done))
            .await
            .map_err(|_| anyhow!("capture_unavailable"))?;
        wait.await.map_err(|_| anyhow!("capture_unavailable"))?
    }
    pub async fn configure_microphone(&self, settings: SourceMicrophoneSettings) -> Result<()> {
        let (done, wait) = oneshot::channel();
        self.requests
            .send(Request::Microphone(settings, done))
            .await
            .map_err(|_| anyhow!("capture_unavailable"))?;
        wait.await.map_err(|_| anyhow!("capture_unavailable"))?
    }
    pub async fn cancel_microphone(&self) -> Result<()> {
        let (done, wait) = oneshot::channel();
        self.requests
            .send(Request::CancelMicrophone(done))
            .await
            .map_err(|_| anyhow!("capture_unavailable"))?;
        wait.await.map_err(|_| anyhow!("capture_unavailable"))?
    }
}

pub(super) fn start(
    publication: Uuid,
    epoch: Instant,
    clock: SystemInstant,
    ready_sources: mpsc::Sender<SourceReady>,
    events: mpsc::Sender<Event>,
    relay: Relay,
    cancelled: watch::Receiver<bool>,
    joining: oneshot::Receiver<()>,
) -> (Control, JoinHandle<()>) {
    run(
        publication,
        epoch,
        clock,
        ready_sources,
        events,
        relay,
        cancelled,
        joining,
        AudioCapture::microphone,
    )
}

fn run(
    publication: Uuid,
    epoch: Instant,
    clock: SystemInstant,
    ready_sources: mpsc::Sender<SourceReady>,
    events: mpsc::Sender<Event>,
    relay: Relay,
    mut cancelled: watch::Receiver<bool>,
    mut joining: oneshot::Receiver<()>,
    open_microphone: impl Fn(String) -> Result<AudioCapture> + Send + Sync + 'static,
) -> (Control, JoinHandle<()>) {
    let (requests, mut received) = mpsc::channel(1);
    let (stopped, mut stop) = watch::channel(false);
    let (source, source_state) = watch::channel(None);
    let (state, audio_state) = watch::channel(SourceAudioState::default());
    let (settings, audio_settings) = watch::channel(SourceAudioSettings::default());
    let control = Control {
        requests,
        stopped,
        source: source_state,
        state: audio_state,
        settings,
    };
    let completion = stop.clone();
    let task = tokio::spawn(async move {
        let mut system: Option<Input> = None;
        let mut mic: Option<Input> = None;
        let mut microphone = SourceMicrophoneSettings::default();
        let publish_state = |system: &Option<Input>, microphone: &SourceMicrophoneSettings| {
            let next = SourceAudioState {
                source_audio: system.is_some(),
                microphone: microphone.clone(),
            };
            state.send_if_modified(|current| {
                if *current == next {
                    return false;
                }
                *current = next;
                true
            });
        };
        let mut pending: Option<Preparing> = None;
        let mut prepared: Option<PreparedSystem> = None;
        let mut output: Option<(rusty_opus::OpusEncoder, RtpSource, bool)> = None;
        let mut mix = Mix::default();
        let mut encoded = [0u8; 1500];
        let work: Result<()> = async {
            'work: loop {
                let mut response = None;
                tokio::select! {
                    biased;
                    _ = wait_stopped(&mut stop) => break,
                    _ = wait_stopped(&mut cancelled) => break,
                    request = received.recv() => {
                        if pending.as_ref().is_some_and(|p| matches!(&p.kind, PreparingKind::System { cancelled, .. } if *cancelled.borrow())) { pending.take().unwrap().close().await; }
                        if prepared.as_ref().is_some_and(|p| *p.cancelled.borrow()) { if let Some(input) = prepared.take().unwrap().input { close(input).await; } }
                        match request {
                        None => break,
                        Some(Request::StopSystem(done)) => {
                            if pending.as_ref().is_some_and(|p| matches!(p.kind, PreparingKind::System { .. })) { pending.take().unwrap().close().await; }
                            if let Some(input) = prepared.take().and_then(|p| p.input) { close(input).await; }
                            if let Some(input) = system.take() { close(input).await; }
                            mix.clear(0);
                            response = Some((done, Ok(())));
                        }
                        Some(Request::CancelMicrophone(done)) => {
                            if pending.as_ref().is_some_and(|p| matches!(p.kind, PreparingKind::Microphone(_))) { pending.take().unwrap().close().await; }
                            response = Some((done, Ok(())));
                        }
                        Some(Request::PrepareSystem(input, cancelled, reply)) => {
                            if pending.is_some() || prepared.is_some() { response = Some((reply, Err(anyhow!("capture_pending")))); if let Some(input) = input { close(input).await; } }
                            else if let Some(input) = input { pending = Some(Preparing::new(input, PreparingKind::System { cancelled, committed: false }, reply)); }
                            else { prepared = Some(PreparedSystem { input: None, cancelled }); response = Some((reply, Ok(()))); }
                        }
                        Some(Request::CommitSystem(cancelled, reply)) => {
                            if !*cancelled.borrow() && pending.as_ref().is_some_and(|p| matches!(&p.kind, PreparingKind::System { cancelled: current, .. } if current.same_channel(&cancelled))) {
                                if let PreparingKind::System { committed, .. } = &mut pending.as_mut().unwrap().kind { *committed = true; }
                                if let Some(old) = system.take() { close(old).await; }
                                mix.clear(0);
                                response = Some((reply, Ok(())));
                            } else if *cancelled.borrow() || !prepared.as_ref().is_some_and(|p| p.cancelled.same_channel(&cancelled)) {
                                response = Some((reply, Err(anyhow!("capture_unavailable"))));
                            } else {
                                let next = prepared.take().unwrap().input;
                                if let Some(old) = std::mem::replace(&mut system, next) { close(old).await; }
                                mix.clear(0);
                                response = Some((reply, Ok(())));
                            }
                        }
                        Some(Request::Microphone(next, reply)) => {
                            if !next.enabled {
                                let old = mic.take();
                                let preparing = pending.take_if(|p| matches!(p.kind, PreparingKind::Microphone(_)));
                                if let Some(input) = &old { input.capture.control().stop(); }
                                if let Some(preparing) = &preparing { preparing.control.stop(); }
                                mix.clear(1);
                                microphone = next;
                                publish_state(&system, &microphone);
                                if let Some(input) = old { close(input).await; }
                                if let Some(preparing) = preparing { preparing.close().await; }
                                response = Some((reply, Ok(())));
                            } else if pending.is_some() || prepared.is_some() { response = Some((reply, Err(anyhow!("capture_pending")))); }
                            else if mic.is_some() && microphone.device_id == next.device_id {
                                microphone = next;
                                response = Some((reply, Ok(())));
                            } else {
                                match open_microphone(next.device_id.clone()) {
                                    Ok(capture) => pending = Some(Preparing::new(Input { capture, system: None }, PreparingKind::Microphone(next), reply)),
                                    Err(error) => { response = Some((reply, Err(error))); }
                                }
                            }
                        }
                        }
                    },
                    (input, result) = async { pending.as_mut().unwrap().ready.as_mut().await }, if pending.is_some() => {
                        let ready = pending.take().unwrap();
                        match ready.kind {
                            PreparingKind::System { cancelled, committed } => {
                                if *cancelled.borrow() {
                                    close(input).await;
                                    response = Some((ready.reply, Err(anyhow!("capture_cancelled"))));
                                } else {
                                    let input = if let Err(error) = &result { failed(input, &format!("{error:#}")).await; None } else { Some(input) };
                                    if committed {
                                        if let Some(old) = std::mem::replace(&mut system, input) { close(old).await; }
                                        mix.clear(0);
                                    } else { prepared = Some(PreparedSystem { input, cancelled }); }
                                    response = Some((ready.reply, result));
                                }
                            }
                            PreparingKind::Microphone(next) => {
                                if let Err(error) = result {
                                    failed(input, &format!("{error:#}")).await;
                                    response = Some((ready.reply, Err(error)));
                                } else if ready.control.is_stopped() || ready.reply.is_closed() {
                                    close(input).await;
                                } else {
                                    if let Some(old) = mic.replace(input) { close(old).await; }
                                    mix.clear(1);
                                    microphone = next;
                                    response = Some((ready.reply, Ok(())));
                                }
                            }
                        }
                    },
                    _ = async { prepared.as_mut().unwrap().cancelled.wait_for(|v| *v).await.ok(); }, if prepared.is_some() => {
                        if let Some(input) = prepared.take().and_then(|p| p.input) { close(input).await; }
                    },
                    frame = async { system.as_mut().unwrap().capture.recv().await }, if system.is_some() => match frame {
                        Some(Ok(frame)) => mix.push(0, frame),
                        end => { failed(system.take().unwrap(), &ended(end)).await; mix.clear(0); }
                    },
                    frame = async { mic.as_mut().unwrap().capture.recv().await }, if mic.is_some() => match frame {
                        Some(Ok(frame)) => mix.push(1, frame),
                        end => {
                            failed(mic.take().unwrap(), &ended(end)).await;
                            mix.clear(1);
                            microphone.enabled = false;
                        }
                    },
                }
                publish_state(&system, &microphone);
                if let Some((reply, result)) = response { let _ = reply.send(result); }
                if system.is_none() && mic.is_none() {
                    if let Some((_, old, _)) = output.take() {
                        tokio::select! {
                            result = events.send(Event::CaptureAudioEnded { publication_id: publication, source: old.source.id }) => { result?; }
                            _ = wait_stopped(&mut stop) => break 'work,
                            _ = wait_stopped(&mut cancelled) => break 'work,
                        }
                        source.send_replace(None);
                    }
                    mix = Mix::default();
                }
                let mic_gain = microphone.volume;
                while let Some(mut frame) = mix.pop(system.is_some() && mic.is_some(), mic_gain) {
                    if output.is_none() {
                        let mut encoder = rusty_opus::OpusEncoder::new(48_000, 2, rusty_opus::Application::Audio)?;
                        encoder.complexity = 10;
                        encoder.use_cbr = true;
                        let id = Uuid::new_v4();
                        output = Some((encoder, RtpSource::new(id, publication, MediaKind::Audio, crate::peer::codec(), 111, epoch, clock)?, true));
                        source.send_replace(Some(id));
                    }
                    let (encoder, rtp, first) = output.as_mut().unwrap();
                    let length = encode_audio(encoder, &mut frame.samples, *audio_settings.borrow(), &mut encoded)?;
                    let packets = rtp.packetize_audio(encoded[..length].to_vec(), frame.presentation_time, frame.sample_position)?;
                    if *first {
                        tokio::select! {
                            result = ready_sources.send(SourceReady { source: rtp.source.clone(), media: InitialMedia::Rtp(packets) }) => { result?; }
                            _ = wait_stopped(&mut stop) => break 'work,
                            _ = wait_stopped(&mut cancelled) => break 'work,
                        }
                        *first = false;
                    } else { for packet in packets { relay.write(rtp.source.id, packet); } }
                }
            }
            Ok(())
        }.await;
        received.close();
        while let Some(request) = received.recv().await {
            if let Request::PrepareSystem(Some(input), _, _) = request {
                close(input).await;
            }
        }
        if let Some(pending) = pending {
            pending.close().await;
        }
        if let Some(input) = prepared.and_then(|p| p.input) {
            close(input).await;
        }
        if let Some(input) = system.take() {
            close(input).await;
        }
        if let Some(input) = mic.take() {
            close(input).await;
        }
        microphone.enabled = false;
        publish_state(&system, &microphone);
        if let Err(error) = work {
            log::warn!(target: "piik.capture", "Native audio source failed: {error:#}");
        }
        // The Driver removes this mixer's last source after joining it.
        // Keep that identity until either its end event is queued or that join.
        let last = *source.borrow();
        if let Some(id) = last.filter(|_| !*stop.borrow() && !*cancelled.borrow()) {
            tokio::select! {
                _ = events.send(Event::CaptureAudioEnded { publication_id: publication, source: id }) => { source.send_replace(None); },
                _ = wait_stopped(&mut cancelled) => {},
                _ = wait_stopped(&mut stop) => {},
            }
        }
        if !*cancelled.borrow() {
            tokio::select! {
                _ = events.send(Event::CaptureAudioStopped { publication_id: publication, owner: completion }) => {},
                _ = wait_stopped(&mut cancelled) => {},
                _ = &mut joining => {},
            }
        }
    });
    (control, task)
}

async fn wait_stopped(signal: &mut watch::Receiver<bool>) {
    let _ = signal.wait_for(|v| *v).await;
}

fn ended(end: Option<Result<AudioFrame>>) -> String {
    end.and_then(Result::err)
        .map(|error| format!("{error:#}"))
        .unwrap_or_else(|| "audio input ended".into())
}
async fn close(input: Input) {
    let _ = tokio::task::spawn_blocking(move || input.capture.stop()).await;
}
async fn failed(mut input: Input, error: &str) {
    if let Some((cancel, warning)) = input.system.take() {
        if !*cancel.borrow() {
            let _ = warning.send(error.into());
        }
    }
    log::warn!(target: "piik.capture", "Native audio input ended: {error}");
    close(input).await;
}

struct AlignedFrame {
    frame: AudioFrame,
    at: Instant,
}
struct InputAnchor {
    segment: u64,
    sample_position: u64,
    at: Instant,
}
struct MixCursor {
    alignment_end: Instant,
    capture_end: Instant,
    sample_position: u64,
}

/// Continuous PCM follows sample positions, not jitter in capture timestamps.
/// One frame of lookahead aligns two inputs within the existing bounded queues.
#[derive(Default)]
struct Mix {
    inputs: [VecDeque<AlignedFrame>; 2],
    anchors: [Option<InputAnchor>; 2],
    cursor: Option<MixCursor>,
}
impl Mix {
    fn clear(&mut self, index: usize) {
        self.inputs[index].clear();
        self.anchors[index] = None;
    }
    fn push(&mut self, index: usize, frame: AudioFrame) {
        let at = match &self.anchors[index] {
            Some(anchor) if anchor.segment == frame.segment => {
                if frame.sample_position >= anchor.sample_position {
                    anchor.at + sample_duration(frame.sample_position - anchor.sample_position)
                } else {
                    anchor.at - sample_duration(anchor.sample_position - frame.sample_position)
                }
            }
            _ => {
                let at = self
                    .cursor
                    .as_ref()
                    .map_or(frame.presentation_time, |cursor| {
                        if frame.presentation_time >= cursor.capture_end {
                            cursor.alignment_end
                                + frame.presentation_time.duration_since(cursor.capture_end)
                        } else {
                            cursor.alignment_end
                                - cursor.capture_end.duration_since(frame.presentation_time)
                        }
                    });
                self.anchors[index] = Some(InputAnchor {
                    segment: frame.segment,
                    sample_position: frame.sample_position,
                    at,
                });
                at
            }
        };
        let frames = &mut self.inputs[index];
        if frames.len() == 2 {
            frames.pop_front();
        }
        frames.push_back(AlignedFrame { frame, at });
    }
    fn pop(&mut self, two: bool, gain: f32) -> Option<AudioFrame> {
        let duration = Duration::from_millis(20);
        if let Some(cursor) = &self.cursor {
            for queue in &mut self.inputs {
                while queue
                    .front()
                    .is_some_and(|frame| frame.at + duration <= cursor.alignment_end)
                {
                    queue.pop_front();
                }
            }
        }
        let earliest = self
            .inputs
            .iter()
            .filter_map(|q| q.front().map(|f| f.at))
            .min()?;
        let start = self
            .cursor
            .as_ref()
            .map_or(earliest, |cursor| cursor.alignment_end.max(earliest));
        let end = start + duration;
        let latest = self
            .inputs
            .iter()
            .filter_map(|q| q.back().map(|f| f.at))
            .max()?;
        if (two && latest < end) || (!two && latest + duration < end) {
            return None;
        }
        if !two && self.inputs.iter().filter(|queue| !queue.is_empty()).count() == 1 {
            let index = usize::from(self.inputs[0].is_empty());
            if self.inputs[index].front().unwrap().at == start {
                let mut frame = self.inputs[index].pop_front().unwrap().frame;
                if index == 1 {
                    for sample in &mut frame.samples {
                        *sample *= gain;
                    }
                }
                return Some(self.finish(frame, start));
            }
        }
        let presentation_time = self
            .inputs
            .iter()
            .flatten()
            .find(|frame| frame.at <= start && frame.at + duration > start)
            .map(|frame| {
                frame.frame.presentation_time
                    + sample_duration(duration_samples(start.duration_since(frame.at)))
            })?;
        let mut samples = vec![0.0; 1920];
        for (index, queue) in self.inputs.iter_mut().enumerate() {
            for frame in queue.iter() {
                let offset = if frame.at >= start {
                    duration_samples(frame.at.duration_since(start)) as i64
                } else {
                    -(duration_samples(start.duration_since(frame.at)) as i64)
                };
                for (at, pair) in frame.frame.samples.chunks_exact(2).enumerate() {
                    let at = at as i64 + offset;
                    if (0..960).contains(&at) {
                        for channel in 0..2 {
                            samples[at as usize * 2 + channel] +=
                                pair[channel] * if index == 1 { gain } else { 1.0 };
                        }
                    }
                }
            }
            while queue
                .front()
                .is_some_and(|frame| frame.at + duration <= end)
            {
                queue.pop_front();
            }
        }
        Some(self.finish(
            AudioFrame {
                samples,
                presentation_time,
                segment: 0,
                sample_position: 0,
            },
            start,
        ))
    }
    fn finish(&mut self, mut frame: AudioFrame, start: Instant) -> AudioFrame {
        let duration = Duration::from_millis(20);
        frame.segment = 0;
        frame.sample_position = self.cursor.as_ref().map_or(0, |cursor| {
            cursor.sample_position + duration_samples(start.duration_since(cursor.alignment_end))
        });
        self.cursor = Some(MixCursor {
            alignment_end: start + duration,
            capture_end: frame.presentation_time + duration,
            sample_position: frame.sample_position + 960,
        });
        frame
    }
}

fn sample_duration(samples: u64) -> Duration {
    Duration::from_secs(samples / 48_000)
        + Duration::from_nanos(samples % 48_000 * 1_000_000_000 / 48_000)
}
fn duration_samples(duration: Duration) -> u64 {
    ((duration.as_nanos() * 48_000 + 500_000_000) / 1_000_000_000) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(epoch: Instant, millis: u64, values: [f32; 2]) -> AudioFrame {
        AudioFrame {
            samples: values.repeat(960),
            presentation_time: epoch + Duration::from_millis(millis),
            segment: 0,
            sample_position: millis * 48,
        }
    }

    #[test]
    fn captured_pcm_alignment_preserves_stereo_gain_gaps_and_input_retirement() {
        let at = Instant::now();
        let mut mix = Mix::default();
        mix.push(0, frame(at, 0, [0.2, 0.4]));
        mix.push(1, frame(at, 10, [0.6, 0.8]));
        assert!(mix.pop(true, 0.5).is_none());
        mix.push(0, frame(at, 20, [0.2, 0.4]));
        let first = mix.pop(true, 0.5).unwrap();
        assert_eq!(first.presentation_time, at);
        assert_eq!(first.sample_position, 0);
        assert_eq!(&first.samples[..2], &[0.2, 0.4]);
        assert_eq!(&first.samples[960..962], &[0.5, 0.8]);
        // Retire only the system sound: the microphone's remaining half frame
        // retains its position on the same output clock.
        mix.clear(0);
        assert!(mix.pop(false, 0.5).is_none());
        mix.push(1, frame(at, 30, [0.6, 0.8]));
        let next = mix.pop(false, 0.5).unwrap();
        assert_eq!(next.presentation_time, at + Duration::from_millis(20));
        assert_eq!(next.sample_position, 960);
        assert!(next.samples.chunks_exact(2).all(|pair| pair == [0.3, 0.4]));
        mix.clear(1);
        mix.push(1, frame(at, 100, [0.6, 0.8]));
        let gap = mix.pop(false, 0.0).unwrap();
        assert_eq!(gap.presentation_time, at + Duration::from_millis(100));
        assert_eq!(gap.sample_position, 4800);
        assert!(gap.samples.iter().all(|sample| *sample == 0.0));
        assert!(mix.pop(false, 1.0).is_none());
        mix.push(0, frame(at, 20, [0.2, 0.4]));
        assert!(mix.pop(false, 1.0).is_none());
    }

    #[test]
    fn captured_pcm_keeps_hardware_sample_order_through_opus_rtp_and_sender_reports() -> Result<()>
    {
        // Three seconds of WASAPI timestamp metadata; no captured audio is retained.
        let ticks: Vec<u64> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/audio-capture-timestamps.json"
        ))?;
        assert!(ticks.windows(2).any(|pair| pair[1] - pair[0] != 200_000));
        let epoch = Instant::now();
        let clock = SystemInstant::now(epoch);
        let mut position = crate::capture::AudioPosition::default();
        let mut mix = Mix::default();
        let mut source = RtpSource::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            MediaKind::Audio,
            crate::peer::codec(),
            111,
            epoch,
            clock,
        )?;
        let encoder = || -> Result<_> {
            let mut encoder =
                rusty_opus::OpusEncoder::new(48_000, 2, rusty_opus::Application::Audio)?;
            encoder.bitrate_bps = 128_000;
            encoder.complexity = 10;
            encoder.use_cbr = true;
            Ok(encoder)
        };
        let mut actual = encoder()?;
        let mut reference = encoder()?;
        let mut decoder = rusty_opus::OpusDecoder::new(48_000, 2)?;
        let mut reference_decoder = rusty_opus::OpusDecoder::new(48_000, 2)?;
        let mut encoded = [0; 1500];
        let mut reference_packet = [0; 1500];
        let mut decoded = [0.0; 1920];
        let mut reference_pcm = [0.0; 1920];
        let mut previous = None;
        for (index, tick) in ticks.into_iter().enumerate() {
            let samples: Vec<_> = (0..960)
                .flat_map(|sample| {
                    let time = (index * 960 + sample) as f64 / 48_000.0;
                    [
                        (time * 997.0 * std::f64::consts::TAU).sin() as f32 * 0.25,
                        (time * 697.0 * std::f64::consts::TAU).sin() as f32 * 0.20,
                    ]
                })
                .collect();
            let captured = epoch + Duration::from_nanos(tick * 100);
            mix.push(0, position.frame(samples.clone(), captured));
            let mut frame = mix.pop(false, 1.0).unwrap();
            assert_eq!(frame.samples, samples);
            assert_eq!(frame.presentation_time, captured);
            assert_eq!(frame.sample_position, index as u64 * 960);
            let length = encode_audio(
                &mut actual,
                &mut frame.samples,
                SourceAudioSettings {
                    bitrate: 128_000,
                    gain: 1.0,
                },
                &mut encoded,
            )?;
            let expected = reference.encode(&samples, 960, &mut reference_packet)?;
            assert_eq!(&encoded[..length], &reference_packet[..expected]);
            let packets = source.packetize_audio(
                encoded[..length].to_vec(),
                captured,
                frame.sample_position,
            )?;
            assert_eq!(packets.len(), 1);
            let packet = &packets[0];
            if let Some(previous) = previous {
                assert_eq!(packet.header.timestamp.wrapping_sub(previous), 960);
            }
            previous = Some(packet.header.timestamp);
            assert_eq!(decoder.decode(&packet.payload, 960, &mut decoded)?, 960);
            reference_decoder.decode(&reference_packet[..expected], 960, &mut reference_pcm)?;
            assert_eq!(decoded, reference_pcm);
            assert!(decoded.iter().all(|sample| sample.is_finite()));
            let crate::media::SourceFeed::Rtp { report, .. } = &source.source.feed else {
                unreachable!()
            };
            let report = report.lock().unwrap().clone().unwrap();
            assert_eq!(report.0.rtp_time, packet.header.timestamp);
            assert_eq!(report.0.ntp_time, clock.ntp(captured));
            assert_eq!(report.1, captured);
        }
        Ok(())
    }

    #[test]
    fn captured_pcm_drops_keep_exact_sample_gaps_despite_timestamp_jitter() -> Result<()> {
        let epoch = Instant::now();
        let mut position = crate::capture::AudioPosition::default();
        let (send, mut receive) = mpsc::channel(2);
        for index in 0..3 {
            let frame = position.frame(vec![0.2; 1920], epoch + Duration::from_millis(index * 20));
            let result = send.try_send(frame);
            assert_eq!(result.is_ok(), index < 2);
        }
        let mut mix = Mix::default();
        for index in 0..2 {
            mix.push(0, receive.try_recv()?);
            assert_eq!(mix.pop(false, 1.0).unwrap().sample_position, index * 960);
        }
        let captured = epoch + Duration::from_micros(60_138);
        send.try_send(position.frame(vec![0.4; 1920], captured))?;
        mix.push(0, receive.try_recv()?);
        let frame = mix.pop(false, 1.0).unwrap();
        assert_eq!(frame.samples, vec![0.4; 1920]);
        assert_eq!(frame.presentation_time, captured);
        assert_eq!(frame.sample_position, 2880);
        Ok(())
    }

    #[test]
    fn captured_pcm_new_segments_use_the_current_capture_clock_when_inputs_change() {
        let epoch = Instant::now();
        let mut mix = Mix::default();
        mix.push(0, frame(epoch, 0, [0.2, 0.4]));
        mix.pop(false, 1.0).unwrap();
        let mut later = frame(epoch, 20, [0.2, 0.4]);
        later.presentation_time += Duration::from_millis(60);
        mix.push(0, later);
        assert_eq!(mix.pop(false, 1.0).unwrap().sample_position, 960);
        // Joining at the actual next capture time adds no fictional drift gap.
        mix.push(1, frame(epoch, 100, [0.6, 0.8]));
        let mut system = frame(epoch, 40, [0.2, 0.4]);
        system.presentation_time += Duration::from_millis(60);
        mix.push(0, system);
        let mut ahead = frame(epoch, 60, [0.2, 0.4]);
        ahead.presentation_time += Duration::from_millis(60);
        mix.push(0, ahead);
        let mixed = mix.pop(true, 0.5).unwrap();
        assert_eq!(mixed.sample_position, 1920);
        assert_eq!(mixed.presentation_time, epoch + Duration::from_millis(100));
        assert!(mixed.samples.chunks_exact(2).all(|pair| pair == [0.5, 0.8]));
        mix.clear(1);
        let system = mix.pop(false, 1.0).unwrap();
        assert_eq!(system.sample_position, 2880);
        assert_eq!(system.samples[..2], [0.2, 0.4]);
        // A discontinuous replacement starts from its capture time, not the old segment's position.
        let mut replacement = frame(epoch, 200, [0.7, 0.9]);
        replacement.segment = 1;
        replacement.sample_position = 0;
        mix.push(0, replacement);
        let replacement = mix.pop(false, 1.0).unwrap();
        assert_eq!(replacement.sample_position, 6720);
        assert_eq!(
            replacement.presentation_time,
            epoch + Duration::from_millis(200)
        );
        assert_eq!(replacement.samples[..2], [0.7, 0.9]);
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn microphone_off_retires_its_active_and_pending_input_without_canceling_system_preparation(
    ) -> Result<()> {
        use std::sync::Mutex;
        tokio::time::timeout(Duration::from_secs(3), async {
            for preparing_microphone in [true, false] {
                let epoch = Instant::now();
                let (sources, _ready) = mpsc::channel(4);
                let (events, _ended) = mpsc::channel(4);
                let (_cancel, cancelled) = watch::channel(false);
                let (_joining, joined) = oneshot::channel();
                let (mic, _pcm, mic_joined) = AudioCapture::fixture(true)?;
                let mic_control = mic.control();
                let (candidate, _candidate_pcm, candidate_joined) = AudioCapture::fixture(false)?;
                let candidate_control = candidate.control();
                let (opening, opened) = oneshot::channel();
                let inputs = Mutex::new(VecDeque::from([(mic, None), (candidate, Some(opening))]));
                let (control, task) = run(
                    Uuid::new_v4(),
                    epoch,
                    SystemInstant::now(epoch),
                    sources,
                    events,
                    Relay::default(),
                    cancelled,
                    joined,
                    move |_| {
                        let (input, opening) = inputs.lock().unwrap().pop_front().unwrap();
                        if let Some(opening) = opening {
                            let _ = opening.send(());
                        }
                        Ok(input)
                    },
                );
                control
                    .configure_microphone(SourceMicrophoneSettings {
                        enabled: true,
                        device_id: "active".into(),
                        volume: 1.0,
                    })
                    .await?;
                let (system, _system_pcm, system_joined) = AudioCapture::fixture(false)?;
                let system_control = system.control();
                let changing;
                let system_started;
                if preparing_microphone {
                    let selected = control.clone();
                    changing = Some(tokio::spawn(async move {
                        selected
                            .configure_microphone(SourceMicrophoneSettings {
                                enabled: true,
                                device_id: "pending".into(),
                                volume: 1.0,
                            })
                            .await
                    }));
                    opened.await?;
                    system_started = None;
                } else {
                    let (_lease, started, _) = control.prepare_system(Some(system)).await?;
                    // Barrier on the real actor, preserving its pending system input.
                    control.cancel_microphone().await?;
                    system_started = Some(started);
                    changing = None;
                }
                let off = control
                    .configure_microphone(SourceMicrophoneSettings {
                        enabled: false,
                        device_id: "active".into(),
                        volume: 1.0,
                    })
                    .await;
                let stopped = mic_control.is_stopped();
                let state = control.state.borrow().clone();
                let pending_mic_stopped = candidate_control.is_stopped();
                let pending_system_stopped = system_control.is_stopped();
                if preparing_microphone {
                    system_control.stop();
                }
                control.stop();
                task.await?;
                mic_joined.await?;
                candidate_joined.await?;
                system_joined.await?;
                if let Some(changing) = changing {
                    assert_eq!(
                        changing.await?.unwrap_err().to_string(),
                        "capture_cancelled"
                    );
                }
                if let Some(started) = system_started {
                    assert!(started.await?.is_err());
                }
                off?;
                assert!(stopped && !state.microphone.enabled);
                if preparing_microphone {
                    assert!(pending_mic_stopped);
                } else {
                    assert!(
                        !pending_system_stopped,
                        "microphone off cannot cancel system preparation"
                    );
                }
            }
            Ok::<_, anyhow::Error>(())
        })
        .await?
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn independent_inputs_retain_one_opus_source_and_join_on_cancel() -> Result<()> {
        crate::diagnostics::enable()?;
        use futures_util::FutureExt;
        use std::sync::Mutex;
        tokio::time::timeout(Duration::from_secs(3), async {
            let epoch = Instant::now();
            let clock = SystemInstant::now(epoch);
            let publication = Uuid::new_v4();
            let (sources, mut ready) = mpsc::channel(4);
            let (events, mut ended) = mpsc::channel(4);
            let relay = Relay::default();
            let (_cancel, cancelled) = watch::channel(false);
            let (_joining, joined) = oneshot::channel();
            let (mic, mic_pcm, mic_joined) = AudioCapture::fixture(true)?;
            let mic_control = mic.control();
            let (again, again_pcm, again_joined) = AudioCapture::fixture(true)?;
            let again_control = again.control();
            let (cancelled_candidate, _cancelled_pcm, cancelled_joined) =
                AudioCapture::fixture(false)?;
            let (cancel_opening, cancel_opened) = oneshot::channel();
            let (candidate, _candidate_pcm, candidate_joined) = AudioCapture::fixture(false)?;
            let (opening, opened) = oneshot::channel();
            let inputs = Mutex::new(VecDeque::from([
                ("mic", mic, None),
                ("again", again, None),
                ("cancelled", cancelled_candidate, Some(cancel_opening)),
                ("pending", candidate, Some(opening)),
            ]));
            let microphone_opens = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let opened_microphones = microphone_opens.clone();
            let (control, task) = run(
                publication,
                epoch,
                clock,
                sources,
                events,
                relay.clone(),
                cancelled,
                joined,
                move |device| {
                    if device == "missing" {
                        anyhow::bail!("device unavailable");
                    }
                    opened_microphones.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let (expected, input, opening) = inputs.lock().unwrap().pop_front().unwrap();
                    assert_eq!(device, expected);
                    if let Some(opening) = opening {
                        let _ = opening.send(());
                    }
                    Ok(input)
                },
            );
            assert!(control.source.borrow().is_none());
            assert_eq!(*control.state.borrow(), SourceAudioState::default());
            let (system, system_pcm, system_joined) = AudioCapture::fixture(true)?;
            let system_control = system.control();
            control.settings.send_replace(SourceAudioSettings {
                bitrate: 96_000,
                gain: 0.75,
            });
            let (system_lease, started, _) = control.prepare_system(Some(system)).await?;
            started.await??;
            assert!(!control.state.borrow().source_audio);
            control.commit_system(&system_lease).await?;
            // A started but silent input exists before its first PCM/RTP packet.
            assert!(control.state.borrow().source_audio);
            assert!(control.source.borrow().is_none());
            system_pcm.send(frame(epoch, 0, [0.1, 0.2])).await?;
            let first = ready.recv().await.unwrap();
            let id = first.source.id;
            let InitialMedia::Rtp(first_packets) = first.media else {
                panic!("audio RTP");
            };
            let first_timestamp = first_packets[0].header.timestamp;
            let first_ssrc = first_packets[0].header.ssrc;
            let (packets, mut received) = mpsc::channel(8);
            relay.set(id, vec![packets]);
            control
                .configure_microphone(SourceMicrophoneSettings {
                    enabled: true,
                    device_id: "mic".into(),
                    volume: 0.5,
                })
                .await?;
            for millis in [20, 40] {
                mic_pcm
                    .send(frame(epoch, millis, [0.2, 0.4]))
                    .await?;
                system_pcm
                    .send(frame(epoch, millis, [0.1, 0.2]))
                    .await?;
            }
            let mixed = received.recv().await.unwrap();
            assert_eq!(mixed.header.timestamp.wrapping_sub(first_timestamp), 960);
            assert_eq!(control.source.borrow().as_ref(), Some(&id));
            assert!(control
                .configure_microphone(SourceMicrophoneSettings {
                    enabled: true,
                    device_id: "missing".into(),
                    volume: 1.0
                })
                .await
                .is_err());
            assert_eq!(control.state.borrow().microphone.device_id, "mic");
            assert!(!mic_control.is_stopped());

            // Preparing and cancelling a picture's system input cannot retire
            // the active system sound, commentary or their shared Opus clock.
            let (cancelled_system, _cancelled_pcm, cancelled_system_joined) =
                AudioCapture::fixture(true)?;
            let (cancelled_lease, ready_system, _) = control.prepare_system(Some(cancelled_system)).await?;
            ready_system.await??;
            assert!(control.state.borrow().source_audio);
            for millis in [60, 80] {
                mic_pcm
                    .send(frame(epoch, millis, [0.2, 0.4]))
                    .await?;
                system_pcm
                    .send(frame(epoch, millis, [0.1, 0.2]))
                    .await?;
            }
            while received
                .recv()
                .await
                .unwrap()
                .header
                .timestamp
                .wrapping_sub(first_timestamp)
                != 2_880
            {}
            assert!(!system_control.is_stopped());
            assert!(!mic_control.is_stopped());
            cancelled_lease.stop();
            let (unready_system, _unready_pcm, unready_joined) = AudioCapture::fixture(false)?;
            let (unready_lease, unready, _) = control.prepare_system(Some(unready_system)).await?;
            cancelled_system_joined.await?; // No wait before the caller's next prepare.
            assert!(control.state.borrow().source_audio);
            control.commit_system(&unready_lease).await?; // Optional sound cannot block the picture.
            assert!(!control.state.borrow().source_audio);
            assert!(control.state.borrow().microphone.enabled);
            system_joined.await?;
            for millis in [100, 120] {
                mic_pcm
                    .send(frame(epoch, millis, [0.2, 0.4]))
                    .await?;
            }
            while received
                .recv()
                .await
                .unwrap()
                .header
                .timestamp
                .wrapping_sub(first_timestamp)
                != 5_760
            {}
            assert!(!mic_control.is_stopped());

            unready_lease.stop();
            let (replacement_system, replacement_pcm, replacement_joined) =
                AudioCapture::fixture(true)?;
            let replacement_control = replacement_system.control();
            let (replacement_lease, ready_system, replacement_warning) =
                control.prepare_system(Some(replacement_system)).await?;
            unready_joined.await?;
            assert!(unready.await?.is_err());
            ready_system.await??;
            control.commit_system(&replacement_lease).await?;
            assert!(control.state.borrow().source_audio);
            system_lease.stop(); // Late retirement belongs only to the old picture's input.
            for millis in [140, 160] {
                mic_pcm
                    .send(frame(epoch, millis, [0.2, 0.4]))
                    .await?;
                replacement_pcm
                    .send(frame(epoch, millis, [0.3, 0.1]))
                    .await?;
            }
            let after_commit = loop {
                let packet = received.recv().await.unwrap();
                assert_eq!(packet.header.ssrc, first_ssrc);
                if packet.header.timestamp.wrapping_sub(first_timestamp) == 6_720 {
                    break packet;
                }
            };
            let mut decoded = [0.0; 1_920];
            assert_eq!(
                rusty_opus::OpusDecoder::new(48_000, 2)?.decode(
                    &after_commit.payload,
                    960,
                    &mut decoded
                )?,
                960
            );
            assert_eq!(*control.source.borrow(), Some(id));
            assert!(ready.try_recv().is_err());
            assert_eq!(
                microphone_opens.load(std::sync::atomic::Ordering::Relaxed),
                1
            );
            assert!(control.state.borrow().microphone.enabled);
            assert_eq!(control.state.borrow().microphone.device_id, "mic");
            assert_eq!(control.state.borrow().microphone.volume, 0.5);
            assert_eq!(control.settings.borrow().bitrate, 96_000);
            assert_eq!(control.settings.borrow().gain, 0.75);
            assert!(!mic_control.is_stopped());
            assert!(!replacement_control.is_stopped());
            // Unexpected input completion reports absent system sound without
            // retiring commentary or the shared output's source clock.
            replacement_control.stop();
            drop(replacement_pcm);
            replacement_joined.await?;
            assert_eq!(replacement_warning.unwrap().await?, "audio input ended");
            let mut state = control.state.clone();
            state.wait_for(|state| !state.source_audio).await?;
            let mut report = Vec::new();
            crate::diagnostics::snapshot().unwrap().write_archive(&mut report, "test", "revision", "fixture")?;
            let mut report = zip::ZipArchive::new(std::io::Cursor::new(report))?;
            let mut recorded = String::new();
            std::io::Read::read_to_string(&mut report.by_name("events.ndjson")?, &mut recorded)?;
            assert!(recorded.contains("Native audio input ended: audio input ended"));
            assert!(control.state.borrow().microphone.enabled);
            assert!(!mic_control.is_stopped());
            let (quiet, _quiet_pcm, quiet_joined) = AudioCapture::fixture(true)?;
            let (quiet_lease, ready_system, _) = control.prepare_system(Some(quiet)).await?;
            ready_system.await??;
            control.commit_system(&quiet_lease).await?;
            assert!(control.state.borrow().source_audio);
            control.stop_system().await?; // Exclusion retires old sound before preparing its replacement.
            quiet_joined.await?;
            assert!(!control.state.borrow().source_audio);
            assert!(control.state.borrow().microphone.enabled);
            mic_pcm
                .send(frame(epoch, 200, [0.2, 0.4]))
                .await?;
            loop {
                let packet = received.recv().await.unwrap();
                if packet.header.timestamp.wrapping_sub(first_timestamp) == 9600 {
                    break;
                }
            }
            assert_eq!(*control.source.borrow(), Some(id));
            assert!(ready.try_recv().is_err());
            control
                .configure_microphone(SourceMicrophoneSettings {
                    enabled: true,
                    device_id: "mic".into(),
                    volume: 1.5,
                })
                .await?;
            assert_eq!(control.state.borrow().microphone.volume, 1.5);
            control
                .configure_microphone(SourceMicrophoneSettings {
                    enabled: false,
                    device_id: "mic".into(),
                    volume: 1.5,
                })
                .await?;
            mic_joined.await?;
            let Event::CaptureAudioEnded { source, .. } = ended.recv().await.unwrap() else {
                panic!("source retired");
            };
            assert_eq!(source, id);
            let mut current = control.source.clone();
            current.wait_for(Option::is_none).await?;
            assert!(!control.state.borrow().microphone.enabled);
            control
                .configure_microphone(SourceMicrophoneSettings {
                    enabled: true,
                    device_id: "again".into(),
                    volume: 1.0,
                })
                .await?;
            again_pcm
                .send(frame(epoch, 320, [0.2, 0.4]))
                .await?;
            let resumed = ready.recv().await.unwrap();
            assert_ne!(resumed.source.id, id);
            let changing = {
                let control = control.clone();
                tokio::spawn(async move {
                    control
                        .configure_microphone(SourceMicrophoneSettings {
                            enabled: true,
                            device_id: "cancelled".into(),
                            volume: 1.0,
                        })
                        .await
                })
            };
            cancel_opened.await?;
            control.cancel_microphone().await?;
            cancelled_joined.await?;
            assert_eq!(
                changing.await?.unwrap_err().to_string(),
                "capture_cancelled"
            );
            assert!(!again_control.is_stopped());
            assert!(control.state.borrow().microphone.enabled);
            assert_eq!(control.state.borrow().microphone.device_id, "again");
            assert_eq!(*control.source.borrow(), Some(resumed.source.id));
            let (last_system, _last_pcm, last_joined) = AudioCapture::fixture(true)?;
            let (last_lease, ready_system, _) = control.prepare_system(Some(last_system)).await?;
            ready_system.await??;
            control.commit_system(&last_lease).await?;
            assert!(control.state.borrow().source_audio);
            let changing = {
                let control = control.clone();
                tokio::spawn(async move {
                    control
                        .configure_microphone(SourceMicrophoneSettings {
                            enabled: true,
                            device_id: "pending".into(),
                            volume: 1.0,
                        })
                        .await
                })
            };
            opened.await?;
            control.stop();
            task.await?;
            again_joined.await?;
            last_joined.await?;
            candidate_joined.await?;
            assert!(changing.await?.is_err());
            assert_eq!(*control.source.borrow(), Some(resumed.source.id));
            assert!(!control.state.borrow().microphone.enabled);
            assert!(!control.state.borrow().source_audio);
            let Event::CaptureAudioStopped {
                publication_id,
                owner,
            } = ended.recv().await.unwrap()
            else {
                panic!("publication audio completion");
            };
            assert_eq!(publication_id, publication);
            assert!(owner.same_channel(&control.stopped.subscribe()));
            assert!(*owner.borrow());
            assert!(ended.try_recv().is_err()); // No separate ended event races the owner's cleanup.

            // The Driver joins this resource while it cannot drain its events.
            // Exercise the real owner's close, rather than aborting its worker.
            let (sources, mut ready) = mpsc::channel(1);
            let (events, mut queued) = mpsc::channel(1);
            let occupied = Uuid::new_v4();
            assert!(events.try_send(Event::CaptureAudioEnded { publication_id: publication, source: occupied }).is_ok());
            let (_cancel, cancelled) = watch::channel(false);
            let producer = super::super::AudioProducer::start(publication, sources, events, Relay::default(), cancelled);
            let (system, pcm, system_joined) = AudioCapture::fixture(true)?;
            let (lease, started, _) = producer.control.prepare_system(Some(system)).await?;
            started.await??;
            producer.control.commit_system(&lease).await?;
            pcm.send(frame(Instant::now(), 0, [0.1, 0.2])).await?;
            ready.recv().await.unwrap();
            producer.close().await;
            system_joined.await?;
            assert!(matches!(queued.recv().await, Some(Event::CaptureAudioEnded { source, .. }) if source == occupied));
            assert!(queued.try_recv().is_err());

            // An accepted request owns its input even before the worker takes it.
            let (sources, _ready) = mpsc::channel(1);
            let (events, _ended) = mpsc::channel(1);
            let (_cancel, cancelled) = watch::channel(false);
            let producer = super::super::AudioProducer::start(publication, sources, events, Relay::default(), cancelled);
            let (stopping, stopped) = oneshot::channel();
            let (finish, finishing) = oneshot::channel();
            let (system, _pcm, system_joined) = AudioCapture::fixture_with_teardown(false, move || {
                let _ = stopping.send(());
                // Dropping the sender also releases the thread if the test fails.
                let _ = finishing.blocking_recv();
            })?;
            let (_lease, started, _) = producer.control.prepare_system(Some(system)).await?;
            let closing = producer.close();
            tokio::pin!(closing);
            tokio::select! {
                _ = &mut closing => panic!("audio owner closed before its queued input joined"),
                result = stopped => result?,
            }
            assert!((&mut closing).now_or_never().is_none(), "audio owner closed before its queued input joined");
            let _ = finish.send(());
            closing.await;
            system_joined.await?;
            assert!(started.await.is_err());
            Ok::<_, anyhow::Error>(())
        })
        .await?
    }
}
