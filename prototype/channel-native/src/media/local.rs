//! One capture owns its encoders and source clocks, independently of its Outputs.
use super::{
    clock::SourceTime, packetizer::Packetizer, video::Video, H264Sps, Relay, Source, SourceFeed,
    SourceOrigin,
};
use crate::{
    capture::{
        AudioCapture, AudioControl as CaptureAudioControl, Capture, Control as VideoControl,
        Settings, Target,
    },
    peer::{Event, InitialMedia, SourceReady},
};
use anyhow::{anyhow, Result};
use rtc::{
    rtp_transceiver::rtp_sender::{RTCRtpCodec, RtpCodecKind},
    shared::time::SystemInstant,
};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

mod encodings;

pub(crate) const AUDIO_BITRATE: u32 = 128_000;

pub(crate) use super::encodings::VideoDemand;

/// The page's one lease stops both workers without waiting for the signaling actor.
#[derive(Clone)]
pub(crate) struct Control {
    video: VideoControl,
    audio: Arc<Mutex<Option<AudioLeaseControl>>>,
}

#[derive(Clone)]
pub(crate) struct AudioLeaseControl {
    capture: Option<CaptureAudioControl>,
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
struct AudioLease {
    control: AudioLeaseControl,
    task: JoinHandle<()>,
}
impl AudioLease {
    async fn close(&mut self) {
        self.control.stop();
        if let Err(error) = (&mut self.task).await {
            eprintln!("Native audio task failed: {error}");
        }
    }
}
impl Control {
    #[cfg(target_os = "linux")]
    pub(crate) async fn authorize(
        &self,
        source: crate::input::Source,
        request: futures_util::future::AbortHandle,
    ) -> Result<()> {
        self.video.authorize(source, request).await
    }

    pub fn stop(&self) {
        self.video.stop();
        if let Some(audio) = self.audio.lock().unwrap().as_ref() {
            audio.stop();
        }
    }
    pub fn is_stopped(&self) -> bool {
        self.video.is_stopped()
    }
}

pub(crate) struct Producer {
    pub video: Uuid,
    pub audio: Option<Uuid>,
    pub control: Control,
    task: Option<JoinHandle<Option<String>>>,
    pub settings: Settings,
    demands: watch::Sender<Vec<VideoDemand>>,
    audio_lease: Option<AudioLease>,
    epoch: Instant,
    clock: SystemInstant,
}
impl Producer {
    pub fn set_demands(&self, next: Vec<VideoDemand>) {
        self.demands.send_if_modified(|current| {
            if *current == next {
                return false;
            }
            *current = next;
            true
        });
    }
    pub fn start(
        publication_id: Uuid,
        target: Target,
        settings: Settings,
        audio: bool,
        exclude_audio: Option<Target>,
        ready_sources: mpsc::Sender<SourceReady>,
        events: mpsc::Sender<Event>,
        relay: Relay,
        cancelled: watch::Receiver<bool>,
    ) -> Result<(
        Self,
        oneshot::Receiver<Result<()>>,
        Option<oneshot::Receiver<String>>,
        Option<oneshot::Receiver<Result<()>>>,
    )> {
        // Both source reports project original capture PTS through this one pair.
        let now = Instant::now();
        let clock = SystemInstant::now(now);
        let capture = Capture::start(target.clone(), settings.fps, audio)?;
        let encoding = capture.encode(settings)?;
        let video_control = capture.control();
        let (audio_ready, required_audio) = if exclude_audio.is_some() {
            let (ready, started) = oneshot::channel();
            (Some(ready), Some(started))
        } else {
            (None, None)
        };
        let (audio_error, warning) = if audio {
            let (error, warning) = oneshot::channel();
            (Some(error), Some(warning))
        } else {
            (None, None)
        };
        let audio = if let Some(error) = audio_error {
            #[cfg(target_os = "windows")]
            let input = AudioCapture::start_with_exclusion(target, exclude_audio);
            #[cfg(not(target_os = "windows"))]
            let input = if exclude_audio.is_some() {
                Err(anyhow!("audio exclusion unavailable"))
            } else {
                capture.audio(target)
            };
            match input {
                Ok(capture) => {
                    let id = Uuid::new_v4();
                    let (retire, retired) = watch::channel(false);
                    let control = AudioLeaseControl {
                        capture: Some(capture.control()),
                        cancelled: retire,
                    };
                    let task = tokio::spawn(audio_source(
                        capture,
                        id,
                        publication_id,
                        now,
                        clock,
                        ready_sources.clone(),
                        events.clone(),
                        relay.clone(),
                        video_control.clone(),
                        cancelled.clone(),
                        error,
                        retired,
                        audio_ready,
                    ));
                    Some((id, AudioLease { control, task }))
                }
                Err(failure) => {
                    let error_text = format!("{failure:#}");
                    if let Some(ready) = audio_ready {
                        let _ = ready.send(Err(anyhow!(error_text.clone())));
                    }
                    eprintln!("Native source audio failed: {error_text}");
                    let _ = error.send(error_text);
                    None
                }
            }
        } else {
            None
        };
        let audio_id = audio.as_ref().map(|(id, _)| *id);
        let control = Control {
            video: video_control,
            audio: Arc::new(Mutex::new(
                audio.as_ref().map(|(_, lease)| lease.control.clone()),
            )),
        };
        let video = Uuid::new_v4();
        let (ready, started) = oneshot::channel();
        let (demands, requests) = watch::channel(Vec::new());
        let task = tokio::spawn(encodings::run(
            capture,
            encoding,
            settings,
            publication_id,
            video,
            SourceTime::local(now, clock),
            control.clone(),
            ready,
            ready_sources,
            events,
            cancelled,
            requests,
        ));
        Ok((
            Self {
                video,
                audio: audio_id,
                control,
                task: Some(task),
                settings,
                demands,
                audio_lease: audio.map(|(_, lease)| lease),
                epoch: now,
                clock,
            },
            started,
            warning,
            required_audio,
        ))
    }

    pub async fn stop_audio(&mut self) {
        if let Some(control) = self.control.audio.lock().unwrap().take() {
            control.stop();
        }
        if let Some(audio) = self.audio_lease.as_mut() {
            audio.close().await;
        }
        self.audio_lease = None;
        self.audio = None;
    }

    pub fn audio_is_stopped(&self) -> bool {
        self.control
            .audio
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|audio| audio.is_stopped())
    }

    pub async fn close(&mut self) -> Option<String> {
        self.control.stop();
        let error = if let Some(task) = self.task.as_mut() {
            let result = (&mut *task).await;
            self.task = None;
            match result {
                Ok(error) => error,
                Err(error) => Some(error.to_string()),
            }
        } else {
            None
        };
        self.stop_audio().await;
        error
    }

    #[cfg(target_os = "windows")]
    pub async fn prepare_audio(
        &mut self,
        publication_id: Uuid,
        target: Target,
        enabled: bool,
        exclude: Option<Target>,
        ready_sources: mpsc::Sender<SourceReady>,
        events: mpsc::Sender<Event>,
        relay: Relay,
        cancelled: watch::Receiver<bool>,
    ) -> Result<(
        AudioLeaseControl,
        oneshot::Receiver<Result<()>>,
        Option<oneshot::Receiver<String>>,
    )> {
        self.stop_audio().await;
        anyhow::ensure!(!self.control.is_stopped(), "capture_unavailable");
        let (retire, retired) = watch::channel(false);
        let (ready, started) = oneshot::channel();
        let (warning, failed) = oneshot::channel();
        let capture = if enabled {
            Some(AudioCapture::start_with_exclusion(target, exclude)?)
        } else {
            None
        };
        let control = AudioLeaseControl {
            capture: capture.as_ref().map(|c| c.control()),
            cancelled: retire,
        };
        *self.control.audio.lock().unwrap() = Some(control.clone());
        if let Some(capture) = capture {
            let id = Uuid::new_v4();
            self.audio = Some(id);
            let task = tokio::spawn(audio_source(
                capture,
                id,
                publication_id,
                self.epoch,
                self.clock,
                ready_sources,
                events,
                relay,
                self.control.video.clone(),
                cancelled,
                warning,
                retired,
                Some(ready),
            ));
            self.audio_lease = Some(AudioLease {
                control: control.clone(),
                task,
            });
            if self.control.is_stopped() {
                self.stop_audio().await;
                anyhow::bail!("capture_unavailable");
            }
            Ok((control, started, Some(failed)))
        } else {
            if self.control.is_stopped() {
                self.stop_audio().await;
                anyhow::bail!("capture_unavailable");
            }
            let _ = ready.send(Ok(()));
            Ok((control, started, None))
        }
    }
}

async fn audio_source(
    mut capture: AudioCapture,
    id: Uuid,
    publication_id: Uuid,
    now: Instant,
    clock: SystemInstant,
    ready_sources: mpsc::Sender<SourceReady>,
    events: mpsc::Sender<Event>,
    relay: Relay,
    video: VideoControl,
    mut cancelled: watch::Receiver<bool>,
    warning: oneshot::Sender<String>,
    mut retired: watch::Receiver<bool>,
    mut ready: Option<oneshot::Sender<Result<()>>>,
) {
    let result = {
        let work = async {
            capture.ready().await?;
            let mut encoder =
                rusty_opus::OpusEncoder::new(48_000, 2, rusty_opus::Application::Audio)?;
            encoder.bitrate_bps = AUDIO_BITRATE as i32;
            encoder.complexity = 10;
            encoder.use_cbr = true;
            let mut encoded = [0u8; 1500];
            let mut source = RtpSource::new(
                id,
                publication_id,
                RtpCodecKind::Audio,
                crate::peer::codec(),
                111,
                now,
                clock,
            )?;
            if let Some(ready) = ready.take() {
                let _ = ready.send(Ok(()));
            }
            let mut first = true;
            loop {
                let frame = tokio::select! {
                    frame = capture.recv() => match frame {
                        Some(frame) => frame?,
                        None => break,
                    },
                    _ = cancelled.changed() => break,
                };
                let length = encoder.encode(&frame.samples, 960, &mut encoded)?;
                let packets =
                    source.packetize(encoded[..length].to_vec(), frame.presentation_time)?;
                if first {
                    tokio::select! {
                        result = ready_sources.send(SourceReady { source: source.source.clone(), media: InitialMedia::Rtp(packets) }) => { result?; }
                        _ = cancelled.changed() => break,
                    }
                    first = false;
                } else {
                    for packet in packets {
                        relay.write(id, packet);
                    }
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => result,
            _ = retired.changed() => Ok(()),
        }
    };
    if let Some(ready) = ready.take() {
        let error = result
            .as_ref()
            .err()
            .map(|error| format!("{error:#}"))
            .unwrap_or_else(|| "audio preparation cancelled".into());
        let _ = ready.send(Err(anyhow!(error)));
    }
    let joined = tokio::task::spawn_blocking(move || capture.stop())
        .await
        .map_err(anyhow::Error::from)
        .and_then(|result| result);
    if !video.is_stopped() && !*cancelled.borrow() && !*retired.borrow() {
        let error = result
            .and(joined)
            .err()
            .map(|error| format!("{error:#}"))
            .unwrap_or_else(|| "source audio ended".into());
        eprintln!("Native source audio failed: {error}");
        let _ = warning.send(error);
        tokio::select! {
            _ = events.send(Event::CaptureAudioEnded { publication_id, source: id }) => {},
            _ = cancelled.changed() => {},
            _ = retired.changed() => {},
        }
    }
}

/// Packet timestamps and reports share capture time, never encode/arrival time.
struct RtpSource {
    source: Source,
    packetizer: Packetizer,
}
impl RtpSource {
    fn new(
        id: Uuid,
        publication_id: Uuid,
        kind: RtpCodecKind,
        codec: RTCRtpCodec,
        payload_type: u8,
        epoch: Instant,
        clock: SystemInstant,
    ) -> Result<Self> {
        let ssrc = u32::from_be_bytes(id.as_bytes()[..4].try_into().unwrap());
        let report: super::SourceReport = Default::default();
        let packetizer = Packetizer::new(
            &codec,
            payload_type,
            ssrc,
            SourceTime::local(epoch, clock),
            report.clone(),
        )?;
        Ok(Self {
            source: Source {
                id,
                publication_id,
                origin: SourceOrigin::Local,
                codec,
                kind,
                layers: None,
                feed: SourceFeed::Rtp {
                    keyframes: watch::channel(0).0,
                    report,
                },
            },
            packetizer,
        })
    }
    fn packetize(
        &mut self,
        bytes: Vec<u8>,
        presentation_time: Instant,
    ) -> Result<Vec<rtc::rtp::Packet>> {
        self.packetizer.packetize(bytes, presentation_time, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn audio_replacement_joins_its_lease_and_keeps_the_video_clock() -> Result<()> {
        let frames = crate::capture::Frames::new(crate::capture::FrameTiming::Capture)?;
        let video = Uuid::new_v4();
        let epoch = Instant::now();
        let clock = SystemInstant::now(epoch);
        let (retire, mut retired) = watch::channel(false);
        let previous = AudioLeaseControl {
            capture: None,
            cancelled: retire,
        };
        let (joined, finished) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = retired.changed().await;
            let _ = joined.send(());
        });
        let settings = Settings {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate: 2_000_000,
        };
        let mut producer = Producer {
            video,
            audio: Some(Uuid::new_v4()),
            settings,
            epoch,
            clock,
            control: Control {
                video: frames.control(),
                audio: Arc::new(Mutex::new(Some(previous.clone()))),
            },
            task: Some(tokio::spawn(async { None })),
            demands: watch::channel(vec![]).0,
            audio_lease: Some(AudioLease {
                control: previous.clone(),
                task,
            }),
        };
        let target = Target {
            kind: crate::capture::TargetKind::Display,
            source_id: "1".into(),
            title: "Fixture display".into(),
            pid: 0,
            creation_time: None,
        };
        let (sources, _) = mpsc::channel(1);
        let (events, _) = mpsc::channel(1);
        let relay = Relay::default();
        let cancel = watch::channel(false).1;
        let (pending, ready, _) = producer
            .prepare_audio(
                Uuid::new_v4(),
                target.clone(),
                false,
                None,
                sources.clone(),
                events.clone(),
                relay.clone(),
                cancel.clone(),
            )
            .await?;
        ready.await??;
        finished.await?;
        assert!(previous.is_stopped());
        assert!(!producer.control.is_stopped());
        assert_eq!(
            (producer.video, producer.epoch, producer.clock),
            (video, epoch, clock)
        );
        // An exclusion activation rejection must leave this same video alive
        // with the previous source audio retired, rather than restore that mix.
        assert!(producer
            .prepare_audio(
                Uuid::new_v4(),
                target.clone(),
                true,
                Some(target),
                sources,
                events,
                relay,
                cancel
            )
            .await
            .is_err());
        assert!(pending.is_stopped());
        assert!(producer.audio.is_none());
        assert!(!producer.control.is_stopped());
        producer.control.stop();
        producer.stop_audio().await;
        producer.close().await;
        Ok(())
    }

    #[test]
    fn audio_packets_and_reports_keep_the_shared_capture_clock_across_pcm_gaps() -> Result<()> {
        let epoch = Instant::now();
        let clock = SystemInstant::now(epoch);
        let publication = Uuid::new_v4();
        let mut audio = RtpSource::new(
            Uuid::from_u128(1 << 96),
            publication,
            RtpCodecKind::Audio,
            crate::peer::codec(),
            111,
            epoch,
            clock,
        )?;
        let mut video = RtpSource::new(
            Uuid::from_u128(2 << 96),
            publication,
            RtpCodecKind::Video,
            RTCRtpCodec {
                mime_type: "video/H264".into(),
                clock_rate: 90_000,
                ..Default::default()
            },
            102,
            epoch,
            clock,
        )?;
        let mut encoder = rusty_opus::OpusEncoder::new(48_000, 2, rusty_opus::Application::Audio)?;
        encoder.bitrate_bps = 128_000;
        encoder.use_cbr = true;
        let mut pcm = [0.0; 1920];
        for (index, frame) in pcm.chunks_exact_mut(2).enumerate() {
            frame[0] = (index as f32 * 0.1).sin() * 0.2;
            frame[1] = (index as f32 * 0.07).sin() * 0.2;
        }
        let mut encoded = [0u8; 1500];
        let length = encoder.encode(&pcm, 960, &mut encoded)?;
        assert_eq!(length, 320);
        let at = |millis| epoch + Duration::from_millis(millis);
        let first_audio = audio.packetize(encoded[..length].to_vec(), at(100))?;
        let second_audio = audio.packetize(encoded[..length].to_vec(), at(120))?;
        let after_gap = audio.packetize(encoded[..length].to_vec(), at(180))?;
        assert_eq!(
            second_audio[0]
                .header
                .timestamp
                .wrapping_sub(first_audio[0].header.timestamp),
            960
        );
        assert_eq!(
            after_gap[0]
                .header
                .timestamp
                .wrapping_sub(second_audio[0].header.timestamp),
            2880
        );
        let first_video = video.packetize(vec![0x65, 1, 2, 3], at(100))?;
        let last_video = video.packetize(vec![0x65, 4, 5, 6], at(180))?;
        assert_eq!(
            last_video[0]
                .header
                .timestamp
                .wrapping_sub(first_video[0].header.timestamp),
            7200
        );
        let SourceFeed::Rtp {
            report: audio_report,
            ..
        } = &audio.source.feed
        else {
            unreachable!()
        };
        let SourceFeed::Rtp {
            report: video_report,
            ..
        } = &video.source.feed
        else {
            unreachable!()
        };
        let audio_report = audio_report.lock().unwrap().clone().unwrap();
        let video_report = video_report.lock().unwrap().clone().unwrap();
        assert_eq!(audio_report.0.ntp_time, video_report.0.ntp_time);
        assert_eq!(audio_report.1, at(180));
        assert_eq!(audio_report.0.rtp_time, after_gap[0].header.timestamp);
        assert_ne!(audio.source.id, video.source.id);
        let mut decoder = rusty_opus::OpusDecoder::new(48_000, 2)?;
        assert_eq!(decoder.decode(&first_audio[0].payload, 960, &mut pcm)?, 960);
        assert!(pcm.iter().all(|sample| sample.is_finite()));
        Ok(())
    }
}
