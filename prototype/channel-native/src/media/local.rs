//! One capture owns its encoders and source clocks, independently of its Outputs.
use super::{
    clock::SourceTime, packetizer::Packetizer, video::Video, H264Sps, Relay, Source, SourceFeed,
    SourceOrigin,
};
#[cfg(target_os = "windows")]
use crate::capture::AudioCapture;
use crate::media::MediaKind;
use crate::media::RtpCodec;
use crate::{
    capture::{Capture, Control as VideoControl, Settings, Target, VideoCodec, VideoCodecMode},
    peer::{Event, InitialMedia, SourceReady},
};
use anyhow::{anyhow, Result};
use rtc_shared::time::SystemInstant;
use std::{
    sync::{Arc, OnceLock},
    time::Instant,
};
use tokio::{
    sync::{mpsc, oneshot, watch, Notify},
    task::JoinHandle,
};
use uuid::Uuid;

mod audio;
mod encodings;
pub(crate) use audio::{AudioLeaseControl, Control as AudioControl};

pub(crate) use super::encodings::VideoDemand;

/// A picture worker owns only its capture and encoders.
#[derive(Clone)]
pub(crate) struct Control {
    video: VideoControl,
    pub(crate) codec: Arc<OnceLock<VideoCodec>>,
    video_settings: watch::Sender<Settings>,
    video_requests: mpsc::Sender<VideoSettingsRequest>,
}
struct VideoSettingsRequest {
    settings: Settings,
    result: oneshot::Sender<Result<()>>,
}

impl Control {
    pub fn settings(&self) -> Settings {
        *self.video_settings.borrow()
    }
    pub async fn configure_video(&self, settings: Settings) -> Result<()> {
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        let (result, applied) = oneshot::channel();
        self.video_requests
            .try_send(VideoSettingsRequest { settings, result })
            .map_err(|_| anyhow!("capture_unavailable"))?;
        applied.await.map_err(|_| anyhow!("capture_unavailable"))?
    }
    pub async fn configure_published_video(
        &self,
        settings: Settings,
        published: impl std::future::Future<Output = Result<()>>,
    ) -> Result<()> {
        let previous = self.settings();
        self.configure_video(settings).await?;
        if let Err(error) = published.await {
            if !self.is_stopped() {
                if let Err(rollback) = self.configure_video(previous).await {
                    return Err(
                        error.context(format!("capture quality rollback failed: {rollback:#}"))
                    );
                }
            }
            return Err(error);
        }
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        Ok(())
    }
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
    }
    pub fn is_stopped(&self) -> bool {
        self.video.is_stopped()
    }
}

/// One publication retains its mixer, microphone and RTP clock across pictures.
pub(crate) struct AudioProducer {
    pub control: AudioControl,
    task: JoinHandle<()>,
    joining: oneshot::Sender<()>,
}
impl AudioProducer {
    pub fn start(
        publication: Uuid,
        ready_sources: mpsc::Sender<SourceReady>,
        events: mpsc::Sender<Event>,
        relay: Relay,
        cancelled: watch::Receiver<bool>,
    ) -> Self {
        let epoch = Instant::now();
        let (joining, joined) = oneshot::channel();
        let (control, task) = audio::start(
            publication,
            epoch,
            SystemInstant::now(epoch),
            ready_sources,
            events,
            relay,
            cancelled,
            joined,
        );
        Self {
            control,
            task,
            joining,
        }
    }
    pub fn source(&self) -> Option<Uuid> {
        *self.control.source.borrow()
    }
    pub async fn close(self) {
        let _ = self.joining.send(());
        self.control.stop();
        let _ = self.task.await;
    }
}

pub(crate) struct Producer {
    pub video: Uuid,
    pub control: Control,
    task: Option<JoinHandle<Option<String>>>,
    demands: watch::Sender<Vec<VideoDemand>>,
    system_audio: Option<AudioLeaseControl>,
}
impl Producer {
    pub fn settings(&self) -> Settings {
        self.control.settings()
    }
    pub fn set_demands(&self, next: Vec<VideoDemand>) {
        self.demands.send_if_modified(|current| {
            if *current == next {
                return false;
            }
            *current = next;
            true
        });
    }
    pub async fn start(
        publication_id: Uuid,
        target: Target,
        settings: Settings,
        mode: VideoCodecMode,
        audio_control: AudioControl,
        audio: bool,
        exclude_audio: Option<Target>,
        show_capture_border: bool,
        ready_sources: mpsc::Sender<SourceReady>,
        events: mpsc::Sender<Event>,
        cancelled: watch::Receiver<bool>,
        bandwidth_changed: Arc<Notify>,
    ) -> Result<(
        Self,
        oneshot::Receiver<Result<()>>,
        Option<oneshot::Receiver<String>>,
        oneshot::Receiver<Result<()>>,
    )> {
        // The picture and the retained audio clock both project capture PTS to NTP.
        let now = Instant::now();
        let clock = SystemInstant::now(now);
        anyhow::ensure!(mode.initial().supported(), "capture_codec_unsupported");
        #[cfg(target_os = "windows")]
        let capture = Capture::start(target.clone(), settings.fps, audio, show_capture_border);
        #[cfg(not(target_os = "windows"))]
        let capture = {
            let _ = show_capture_border;
            Capture::start(target.clone(), settings.fps, audio)
        };
        let capture = capture.inspect_err(|error| {
            log::warn!(target: "piik.capture", "Capture startup failed: {error:#}");
        })?;
        let video_control = capture.control();
        let input = if audio {
            #[cfg(target_os = "windows")]
            let input = AudioCapture::start_with_exclusion(target, exclude_audio.clone());
            #[cfg(not(target_os = "windows"))]
            let input = if exclude_audio.is_some() {
                Err(anyhow!("audio exclusion unavailable"))
            } else {
                capture.audio(target)
            };
            input.map(Some)
        } else {
            Ok(None)
        };
        let (input, failure) = match input {
            Ok(input) => (input, None),
            Err(error) => (None, Some(format!("{error:#}"))),
        };
        let (system_audio, mut audio_ready, mut warning) =
            audio_control.prepare_system(input).await?;
        if let Some(error) = failure {
            let (failed, received) = oneshot::channel();
            let _ = failed.send(error.clone());
            warning = Some(received);
            if exclude_audio.is_some() {
                let (failed, received) = oneshot::channel();
                let _ = failed.send(Err(anyhow!(error)));
                audio_ready = received;
            }
        }
        let (video_settings, _) = watch::channel(settings);
        let (video_requests, changes) = mpsc::channel(1);
        let control = Control {
            video: video_control,
            codec: Arc::new(OnceLock::new()),
            video_settings,
            video_requests,
        };
        let video = Uuid::new_v4();
        let (ready, started) = oneshot::channel();
        let (demands, requests) = watch::channel(Vec::new());
        let task = tokio::spawn(encodings::run(
            capture,
            settings,
            mode,
            publication_id,
            video,
            SourceTime::local(now, clock),
            control.clone(),
            ready,
            ready_sources,
            events,
            cancelled,
            requests,
            changes,
            bandwidth_changed,
        ));
        Ok((
            Self {
                video,
                control,
                task: Some(task),
                demands,
                system_audio: Some(system_audio),
            },
            started,
            warning,
            audio_ready,
        ))
    }

    pub fn system_audio(&self) -> &AudioLeaseControl {
        self.system_audio.as_ref().unwrap()
    }
    pub fn replace_system_audio(&mut self, next: AudioLeaseControl) {
        if let Some(old) = self.system_audio.replace(next) {
            old.stop();
        }
    }

    pub async fn stop_system_audio(&mut self) {
        if let Some(control) = self.system_audio.take() {
            control.stop();
        }
    }

    pub async fn close(&mut self) -> Option<String> {
        self.control.stop();
        self.stop_system_audio().await;
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
        error
    }

    #[cfg(target_os = "windows")]
    pub async fn prepare_audio(
        &mut self,
        target: Target,
        enabled: bool,
        exclude: Option<Target>,
        mixer: &AudioControl,
    ) -> Result<(
        AudioLeaseControl,
        oneshot::Receiver<Result<()>>,
        Option<oneshot::Receiver<String>>,
    )> {
        if exclude.is_some() {
            mixer.stop_system().await?;
        }
        anyhow::ensure!(!self.control.is_stopped(), "capture_unavailable");
        let capture = enabled
            .then(|| AudioCapture::start_with_exclusion(target, exclude))
            .transpose()?;
        mixer.prepare_system(capture).await
    }
}

fn encode_audio(
    encoder: &mut rusty_opus::OpusEncoder,
    samples: &mut [f32],
    settings: crate::peer::SourceAudioSettings,
    encoded: &mut [u8],
) -> Result<usize> {
    encoder.bitrate_bps = settings.bitrate as i32;
    for sample in samples.iter_mut() {
        *sample = (*sample * settings.gain).clamp(-1.0, 1.0);
    }
    Ok(encoder.encode(samples, 960, encoded)?)
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
        kind: MediaKind,
        codec: RtpCodec,
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
    ) -> Result<Vec<rtc_rtp::Packet>> {
        self.packetizer.packetize(bytes, presentation_time, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn video_settings_wait_for_publication_and_rollback_only_the_live_producer() -> Result<()>
    {
        tokio::time::timeout(Duration::from_secs(3), async {
            let frames = crate::capture::Frames::new(crate::capture::FrameTiming::Source)?;
            let epoch = Instant::now();
            let (sources, _ready) = mpsc::channel(1);
            let (events, _events) = mpsc::channel(1);
            let (_cancel, cancelled) = watch::channel(false);
            let (_joining, joined) = oneshot::channel();
            let (audio, audio_task) = audio::start(Uuid::new_v4(), epoch, SystemInstant::now(epoch),
                sources, events, Relay::default(), cancelled, joined);
            let previous = Settings { width: 640, height: 360, fps: 30, bitrate: 1_000_000 };
            let next = Settings { width: 1280, height: 720, bitrate: 3_000_000, ..previous };
            let (video_settings, _) = watch::channel(previous);
            let (video_requests, mut requests) = mpsc::channel(1);
            let control = Control { video: frames.control(), codec: Arc::new(OnceLock::new()),
                video_settings, video_requests };

            // The existing encoder acknowledgement is separate from room authority.
            let (accepted, reply) = oneshot::channel();
            let (publishing, mut started) = oneshot::channel();
            let update = control.configure_published_video(next, async {
                publishing.send(()).unwrap();
                reply.await?
            });
            tokio::pin!(update);
            let request = tokio::select! {
                request = requests.recv() => request.unwrap(),
                result = &mut update => panic!("configuration completed before encoder: {result:?}"),
            };
            assert!(matches!(started.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
            assert_eq!(request.settings, next);
            control.video_settings.send_replace(request.settings);
            request.result.send(Ok(())).unwrap();
            tokio::select! {
                result = started => result.unwrap(),
                result = &mut update => panic!("configuration completed before room reply: {result:?}"),
            }
            accepted.send(Ok(())).unwrap();
            update.await?;
            assert_eq!(control.settings(), next);

            let rejected = control.configure_published_video(previous, async { Err(anyhow!("room_rejected")) });
            tokio::pin!(rejected);
            let request = tokio::select! {
                request = requests.recv() => request.unwrap(),
                result = &mut rejected => panic!("missing local apply: {result:?}"),
            };
            control.video_settings.send_replace(request.settings);
            request.result.send(Ok(())).unwrap();
            let rollback = tokio::select! {
                request = requests.recv() => request.unwrap(),
                result = &mut rejected => panic!("room rejection escaped before rollback: {result:?}"),
            };
            assert_eq!(rollback.settings, next);
            control.video_settings.send_replace(rollback.settings);
            rollback.result.send(Ok(())).unwrap();
            assert_eq!(rejected.await.unwrap_err().to_string(), "room_rejected");
            assert_eq!(control.settings(), next);

            let (accepted, reply) = oneshot::channel();
            let retired = control.configure_published_video(previous, async { reply.await? });
            tokio::pin!(retired);
            let request = tokio::select! {
                request = requests.recv() => request.unwrap(),
                result = &mut retired => panic!("missing last apply: {result:?}"),
            };
            control.video_settings.send_replace(request.settings);
            request.result.send(Ok(())).unwrap();
            control.stop(); // Stop and replacement retire this exact Control.
            assert!(!audio.is_stopped(), "picture retirement must retain the share mixer");
            accepted.send(Ok(())).unwrap();
            assert_eq!(retired.await.unwrap_err().to_string(), "capture_unavailable");
            assert!(matches!(requests.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
            audio.stop();
            audio_task.await?;
            Ok::<_, anyhow::Error>(())
        }).await??;
        Ok(())
    }

    #[test]
    fn source_audio_settings_update_the_same_stereo_opus_encoder() -> Result<()> {
        use crate::peer::SourceAudioSettings;
        let mut encoder = rusty_opus::OpusEncoder::new(48_000, 2, rusty_opus::Application::Audio)?;
        encoder.use_cbr = true;
        let mut decoder = rusty_opus::OpusDecoder::new(48_000, 2)?;
        let mut encoded = [0u8; 1500];
        let mut decoded = [0.0f32; 1920];
        let mut energy = Vec::new();
        let mut frame_index = 0usize;
        for (bitrate, gain) in [
            (64_000, 1.0),
            (192_000, 0.5),
            (128_000, 0.0),
            (128_000, 2.0),
        ] {
            let settings = SourceAudioSettings { bitrate, gain };
            settings.validate()?;
            let mut sum = [0.0f64; 2];
            for frame in 0..12 {
                let mut pcm = [0.0; 1920];
                for (index, pair) in pcm.chunks_exact_mut(2).enumerate() {
                    let at = (frame_index * 960 + index) as f32 / 48_000.0;
                    pair[0] = (at * 440.0 * std::f32::consts::TAU).sin() * 0.1;
                    pair[1] = (at * 880.0 * std::f32::consts::TAU).sin() * 0.2;
                }
                let length = encode_audio(&mut encoder, &mut pcm, settings, &mut encoded)?;
                assert_eq!(length, bitrate as usize / 400);
                assert_eq!(decoder.decode(&encoded[..length], 960, &mut decoded)?, 960);
                if frame >= 4 {
                    for pair in decoded.chunks_exact(2) {
                        sum[0] += (pair[0] as f64).powi(2);
                        sum[1] += (pair[1] as f64).powi(2);
                    }
                }
                frame_index += 1;
            }
            energy.push(sum);
        }
        for channel in 0..2 {
            assert!((0.15..0.4).contains(&(energy[1][channel] / energy[0][channel])));
            assert!(energy[2][channel] < energy[0][channel] * 0.0001);
            assert!((3.0..5.0).contains(&(energy[3][channel] / energy[0][channel])));
        }
        assert!(energy[0][1] > energy[0][0] * 2.0);
        for settings in [
            SourceAudioSettings {
                bitrate: 5_999,
                gain: 1.0,
            },
            SourceAudioSettings {
                bitrate: 320_001,
                gain: 1.0,
            },
            SourceAudioSettings {
                bitrate: 128_000,
                gain: f32::NAN,
            },
            SourceAudioSettings {
                bitrate: 128_000,
                gain: 2.01,
            },
        ] {
            assert!(settings.validate().is_err());
        }
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
            MediaKind::Audio,
            crate::peer::codec(),
            111,
            epoch,
            clock,
        )?;
        let mut video = RtpSource::new(
            Uuid::from_u128(2 << 96),
            publication,
            MediaKind::Video,
            RtpCodec {
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
