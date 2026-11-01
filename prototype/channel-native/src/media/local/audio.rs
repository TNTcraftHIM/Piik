//! The publication's two PCM inputs share one optional Opus source and capture clock.
use super::{encode_audio, RtpSource};
use crate::{
    capture::{AudioCapture, AudioControl as CaptureControl, AudioFrame},
    media::{MediaKind, Relay},
    peer::{Event, InitialMedia, SourceAudioSettings, SourceMicrophoneSettings, SourceReady},
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
pub(super) struct Control {
    requests: mpsc::Sender<Request>,
    stopped: watch::Sender<bool>,
    pub source: watch::Receiver<Option<Uuid>>,
    pub microphone: watch::Receiver<SourceMicrophoneSettings>,
    pub settings: watch::Sender<SourceAudioSettings>,
}
#[derive(Clone)]
pub(crate) struct AudioLeaseControl {
    capture: Option<CaptureControl>,
    cancelled: watch::Sender<bool>,
    settings: watch::Sender<SourceAudioSettings>,
}
impl AudioLeaseControl {
    pub fn set_audio_settings(&self, settings: SourceAudioSettings) {
        self.settings.send_replace(settings);
    }
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
    System(Option<Input>, oneshot::Sender<Result<()>>),
    StopSystem(oneshot::Sender<()>),
    Microphone(SourceMicrophoneSettings, oneshot::Sender<Result<()>>),
    CancelMicrophone(oneshot::Sender<()>),
}
struct Preparing {
    control: CaptureControl,
    ready: BoxFuture<'static, (Input, Result<()>)>,
    microphone: Option<SourceMicrophoneSettings>,
    reply: oneshot::Sender<Result<()>>,
}
impl Preparing {
    fn new(
        mut input: Input,
        microphone: Option<SourceMicrophoneSettings>,
        reply: oneshot::Sender<Result<()>>,
    ) -> Self {
        Self {
            control: input.capture.control(),
            microphone,
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
    pub fn stop(&self) {
        self.stopped.send_replace(true);
    }
    pub async fn stop_system(&self) -> Result<()> {
        let (done, wait) = oneshot::channel();
        self.requests
            .send(Request::StopSystem(done))
            .await
            .map_err(|_| anyhow!("capture_unavailable"))?;
        wait.await.map_err(|_| anyhow!("capture_unavailable"))
    }
    pub async fn system(
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
            settings: self.settings.clone(),
        };
        let present = capture.is_some();
        if let Err(error) = self
            .requests
            .send(Request::System(
                capture.map(|capture| Input {
                    capture,
                    system: Some((cancelled, warning)),
                }),
                ready,
            ))
            .await
        {
            if let Request::System(Some(input), _) = error.0 {
                close(input).await;
            }
            return Err(anyhow!("capture_unavailable"));
        }
        Ok((control, wait, present.then_some(failed)))
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
        wait.await.map_err(|_| anyhow!("capture_unavailable"))
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
) -> (Control, JoinHandle<()>) {
    run(
        publication,
        epoch,
        clock,
        ready_sources,
        events,
        relay,
        cancelled,
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
    open_microphone: impl Fn(String) -> Result<AudioCapture> + Send + Sync + 'static,
) -> (Control, JoinHandle<()>) {
    let (requests, mut received) = mpsc::channel(1);
    let (stopped, mut stop) = watch::channel(false);
    let (source, source_state) = watch::channel(None);
    let (microphone, mic_state) = watch::channel(SourceMicrophoneSettings::default());
    let (settings, audio_settings) = watch::channel(SourceAudioSettings::default());
    let control = Control {
        requests,
        stopped,
        source: source_state,
        microphone: mic_state,
        settings,
    };
    let task = tokio::spawn(async move {
        let mut system: Option<Input> = None;
        let mut mic: Option<Input> = None;
        let mut pending: Option<Preparing> = None;
        let mut output: Option<(rusty_opus::OpusEncoder, RtpSource, bool)> = None;
        let mut mix = Mix::default();
        let mut encoded = [0u8; 1500];
        let work: Result<()> = async {
            'work: loop {
                tokio::select! {
                    biased;
                    _ = wait_stopped(&mut stop) => break,
                    _ = wait_stopped(&mut cancelled) => break,
                    request = received.recv() => match request {
                        None => break,
                        Some(Request::StopSystem(done)) => {
                            if pending.as_ref().is_some_and(|p| p.microphone.is_none()) { pending.take().unwrap().close().await; }
                            if let Some(input) = system.take() { close(input).await; }
                            mix.clear(0);
                            let _ = done.send(());
                        }
                        Some(Request::CancelMicrophone(done)) => {
                            if pending.as_ref().is_some_and(|p| p.microphone.is_some()) { pending.take().unwrap().close().await; }
                            let _ = done.send(());
                        }
                        Some(Request::System(input, reply)) => {
                            if pending.is_some() { let _ = reply.send(Err(anyhow!("capture_pending"))); if let Some(input) = input { close(input).await; } }
                            else if let Some(input) = input { pending = Some(Preparing::new(input, None, reply)); }
                            else { let _ = reply.send(Ok(())); }
                        }
                        Some(Request::Microphone(next, reply)) => {
                            if pending.is_some() { let _ = reply.send(Err(anyhow!("capture_pending"))); }
                            else if !next.enabled {
                                if let Some(input) = mic.take() { close(input).await; }
                                mix.clear(1);
                                microphone.send_replace(next);
                                let _ = reply.send(Ok(()));
                            } else if mic.is_some() && microphone.borrow().device_id == next.device_id {
                                microphone.send_replace(next);
                                let _ = reply.send(Ok(()));
                            } else {
                                match open_microphone(next.device_id.clone()) {
                                    Ok(capture) => pending = Some(Preparing::new(Input { capture, system: None }, Some(next), reply)),
                                    Err(error) => { let _ = reply.send(Err(error)); }
                                }
                            }
                        }
                    },
                    (input, result) = async { pending.as_mut().unwrap().ready.as_mut().await }, if pending.is_some() => {
                        let prepared = pending.take().unwrap();
                        if let Err(error) = result {
                            let text = format!("{error:#}");
                            failed(input, &text).await;
                            let _ = prepared.reply.send(Err(error));
                        } else if prepared.control.is_stopped() || (prepared.microphone.is_some() && prepared.reply.is_closed()) {
                            close(input).await;
                        } else if let Some(next) = prepared.microphone {
                            if let Some(old) = mic.replace(input) { close(old).await; }
                            mix.clear(1);
                            microphone.send_replace(next);
                            let _ = prepared.reply.send(Ok(()));
                        } else {
                            if let Some(old) = system.replace(input) { close(old).await; }
                            mix.clear(0);
                            let _ = prepared.reply.send(Ok(()));
                        }
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
                            microphone.send_modify(|state| state.enabled = false);
                        }
                    },
                }
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
                let mic_gain = microphone.borrow().volume;
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
                    let packets = rtp.packetize(encoded[..length].to_vec(), frame.presentation_time)?;
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
        if let Some(pending) = pending {
            pending.close().await;
        }
        if let Some(input) = system {
            close(input).await;
        }
        if let Some(input) = mic {
            close(input).await;
        }
        microphone.send_modify(|state| state.enabled = false);
        if let Err(error) = work {
            eprintln!("Native audio source failed: {error:#}");
        }
        // The Driver removes a stopped producer's last source after joining it.
        // Keep that identity until either its end event is queued or that join.
        let last = *source.borrow();
        if let Some(id) = last.filter(|_| !*stop.borrow() && !*cancelled.borrow()) {
            tokio::select! {
                _ = events.send(Event::CaptureAudioEnded { publication_id: publication, source: id }) => { source.send_replace(None); },
                _ = wait_stopped(&mut cancelled) => {},
                _ = wait_stopped(&mut stop) => {},
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
    eprintln!("Native audio input ended: {error}");
    close(input).await;
}

/// One PCM frame of lookahead aligns native capture timestamps. Queues remain
/// bounded by the same two-frame raw-input budget; no silence timer or drift loop.
#[derive(Default)]
struct Mix {
    inputs: [VecDeque<AudioFrame>; 2],
    next: Option<Instant>,
}
impl Mix {
    fn clear(&mut self, index: usize) {
        self.inputs[index].clear();
    }
    fn push(&mut self, index: usize, frame: AudioFrame) {
        let frames = &mut self.inputs[index];
        if frames.len() == 2 {
            frames.pop_front();
        }
        frames.push_back(frame);
    }
    fn pop(&mut self, two: bool, gain: f32) -> Option<AudioFrame> {
        let duration = Duration::from_millis(20);
        if let Some(next) = self.next {
            for queue in &mut self.inputs {
                while queue
                    .front()
                    .is_some_and(|frame| frame.presentation_time + duration <= next)
                {
                    queue.pop_front();
                }
            }
        }
        let earliest = self
            .inputs
            .iter()
            .filter_map(|q| q.front().map(|f| f.presentation_time))
            .min()?;
        let start = self.next.map_or(earliest, |next| next.max(earliest));
        let end = start + duration;
        let latest = self
            .inputs
            .iter()
            .filter_map(|q| q.back().map(|f| f.presentation_time))
            .max()?;
        if two && latest < end {
            return None;
        }
        let mut samples = vec![0.0; 1920];
        for (index, queue) in self.inputs.iter_mut().enumerate() {
            for frame in queue.iter() {
                let offset = if frame.presentation_time >= start {
                    (frame.presentation_time.duration_since(start).as_secs_f64() * 48_000.0).round()
                        as i64
                } else {
                    -(start.duration_since(frame.presentation_time).as_secs_f64() * 48_000.0)
                        .round() as i64
                };
                for (at, pair) in frame.samples.chunks_exact(2).enumerate() {
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
                .is_some_and(|frame| frame.presentation_time + duration <= end)
            {
                queue.pop_front();
            }
        }
        self.next = Some(end);
        Some(AudioFrame {
            samples,
            presentation_time: start,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(at: Instant, values: [f32; 2]) -> AudioFrame {
        AudioFrame {
            samples: values.repeat(960),
            presentation_time: at,
        }
    }

    #[test]
    fn captured_pcm_alignment_preserves_stereo_gain_gaps_and_input_retirement() {
        let at = Instant::now();
        let mut mix = Mix::default();
        mix.push(0, frame(at, [0.2, 0.4]));
        mix.push(1, frame(at + Duration::from_millis(10), [0.6, 0.8]));
        assert!(mix.pop(true, 0.5).is_none());
        mix.push(0, frame(at + Duration::from_millis(20), [0.2, 0.4]));
        let first = mix.pop(true, 0.5).unwrap();
        assert_eq!(first.presentation_time, at);
        assert_eq!(&first.samples[..2], &[0.2, 0.4]);
        assert_eq!(&first.samples[960..962], &[0.5, 0.8]);
        // Retire only the system sound: the microphone's remaining half frame
        // retains its position on the same output clock.
        mix.clear(0);
        mix.push(1, frame(at + Duration::from_millis(30), [0.6, 0.8]));
        let next = mix.pop(false, 0.5).unwrap();
        assert_eq!(next.presentation_time, at + Duration::from_millis(20));
        assert!(next.samples.chunks_exact(2).all(|pair| pair == [0.3, 0.4]));
        mix.clear(1);
        mix.push(1, frame(at + Duration::from_millis(100), [0.6, 0.8]));
        let gap = mix.pop(false, 0.0).unwrap();
        assert_eq!(gap.presentation_time, at + Duration::from_millis(100));
        assert!(gap.samples.iter().all(|sample| *sample == 0.0));
        assert!(mix.pop(false, 1.0).is_none());
        mix.push(0, frame(at + Duration::from_millis(20), [0.2, 0.4]));
        assert!(mix.pop(false, 1.0).is_none());
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn independent_inputs_retain_one_opus_source_and_join_on_cancel() -> Result<()> {
        use std::sync::Mutex;
        tokio::time::timeout(Duration::from_secs(3), async {
            let epoch = Instant::now();
            let clock = SystemInstant::now(epoch);
            let publication = Uuid::new_v4();
            let (sources, mut ready) = mpsc::channel(4);
            let (events, mut ended) = mpsc::channel(4);
            let relay = Relay::default();
            let (_cancel, cancelled) = watch::channel(false);
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
            let (control, task) = run(
                publication,
                epoch,
                clock,
                sources,
                events,
                relay.clone(),
                cancelled,
                move |device| {
                    if device == "missing" {
                        anyhow::bail!("device unavailable");
                    }
                    let (expected, input, opening) = inputs.lock().unwrap().pop_front().unwrap();
                    assert_eq!(device, expected);
                    if let Some(opening) = opening {
                        let _ = opening.send(());
                    }
                    Ok(input)
                },
            );
            assert!(control.source.borrow().is_none());
            let (system, system_pcm, system_joined) = AudioCapture::fixture(true)?;
            let (_, started, _) = control.system(Some(system)).await?;
            started.await??;
            system_pcm.send(frame(epoch, [0.1, 0.2])).await?;
            let first = ready.recv().await.unwrap();
            let id = first.source.id;
            let InitialMedia::Rtp(first_packets) = first.media else {
                panic!("audio RTP");
            };
            let first_timestamp = first_packets[0].header.timestamp;
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
                    .send(frame(epoch + Duration::from_millis(millis), [0.2, 0.4]))
                    .await?;
                system_pcm
                    .send(frame(epoch + Duration::from_millis(millis), [0.1, 0.2]))
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
            assert_eq!(control.microphone.borrow().device_id, "mic");
            assert!(!mic_control.is_stopped());
            control.stop_system().await?;
            system_joined.await?;
            assert!(!mic_control.is_stopped());
            mic_pcm
                .send(frame(epoch + Duration::from_millis(80), [0.2, 0.4]))
                .await?;
            loop {
                let packet = received.recv().await.unwrap();
                if packet.header.timestamp.wrapping_sub(first_timestamp) == 3840 {
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
            assert_eq!(control.microphone.borrow().volume, 1.5);
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
            assert!(!control.microphone.borrow().enabled);
            control
                .configure_microphone(SourceMicrophoneSettings {
                    enabled: true,
                    device_id: "again".into(),
                    volume: 1.0,
                })
                .await?;
            again_pcm
                .send(frame(epoch + Duration::from_millis(200), [0.2, 0.4]))
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
            assert!(control.microphone.borrow().enabled);
            assert_eq!(control.microphone.borrow().device_id, "again");
            assert_eq!(*control.source.borrow(), Some(resumed.source.id));
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
            candidate_joined.await?;
            assert!(changing.await?.is_err());
            assert_eq!(*control.source.borrow(), Some(resumed.source.id));
            assert!(!control.microphone.borrow().enabled);
            assert!(ended.try_recv().is_err()); // whole-producer stop owns its source cleanup
            Ok::<_, anyhow::Error>(())
        })
        .await?
    }
}
