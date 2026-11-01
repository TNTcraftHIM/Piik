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
    capture::{Capture, Control as VideoControl, Settings, Target},
    peer::{Event, InitialMedia, SourceReady},
};
use anyhow::{anyhow, Result};
use rtc_shared::time::SystemInstant;
use std::{sync::Arc, time::Instant};
use tokio::{
    sync::{mpsc, oneshot, watch, Notify},
    task::JoinHandle,
};
use uuid::Uuid;

mod audio;
mod encodings;
pub(crate) use audio::AudioLeaseControl;

pub(crate) use super::encodings::VideoDemand;

/// The page's one lease stops both workers without waiting for the signaling actor.
#[derive(Clone)]
pub(crate) struct Control {
    video: VideoControl,
    video_settings: watch::Sender<Settings>,
    video_requests: mpsc::Sender<VideoSettingsRequest>,
    audio: audio::Control,
}
struct VideoSettingsRequest {
    settings: Settings,
    result: oneshot::Sender<Result<()>>,
}

impl Control {
    pub fn microphone_state(&self) -> watch::Receiver<crate::peer::SourceMicrophoneSettings> {
        self.audio.microphone.clone()
    }
    pub async fn configure_microphone(
        &self,
        settings: crate::peer::SourceMicrophoneSettings,
    ) -> Result<()> {
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        self.audio.configure_microphone(settings).await
    }
    pub async fn cancel_microphone(&self) -> Result<()> {
        self.audio.cancel_microphone().await
    }
    pub async fn configure_video(&self, settings: Settings) -> Result<()> {
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        let (result, applied) = oneshot::channel();
        self.video_requests
            .try_send(VideoSettingsRequest { settings, result })
            .map_err(|_| anyhow!("capture_unavailable"))?;
        applied.await.map_err(|_| anyhow!("capture_unavailable"))?
    }
    pub fn set_audio_settings(&self, settings: crate::peer::SourceAudioSettings) {
        self.audio.settings.send_replace(settings);
    }

    pub fn audio_bitrate(&self) -> u32 {
        self.audio.settings.borrow().bitrate
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
        self.audio.stop();
    }
    pub fn is_stopped(&self) -> bool {
        self.video.is_stopped()
    }
}

pub(crate) struct Producer {
    pub video: Uuid,
    pub control: Control,
    task: Option<JoinHandle<Option<String>>>,
    demands: watch::Sender<Vec<VideoDemand>>,
    audio_task: Option<JoinHandle<()>>,
    system_audio: Option<AudioLeaseControl>,
}
impl Producer {
    pub fn settings(&self) -> Settings {
        *self.control.video_settings.borrow()
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
        audio: bool,
        exclude_audio: Option<Target>,
        ready_sources: mpsc::Sender<SourceReady>,
        events: mpsc::Sender<Event>,
        relay: Relay,
        cancelled: watch::Receiver<bool>,
        bandwidth_changed: Arc<Notify>,
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
        let (audio_control, audio_task) = audio::start(
            publication_id,
            now,
            clock,
            ready_sources.clone(),
            events.clone(),
            relay,
            cancelled.clone(),
        );
        let mut system_audio = None;
        let mut required_audio = None;
        let mut warning = None;
        if audio {
            #[cfg(target_os = "windows")]
            let input = AudioCapture::start_with_exclusion(target, exclude_audio.clone());
            #[cfg(not(target_os = "windows"))]
            let input = if exclude_audio.is_some() {
                Err(anyhow!("audio exclusion unavailable"))
            } else {
                capture.audio(target)
            };
            let prepared = match input {
                Ok(input) => audio_control.system(Some(input)).await,
                Err(error) => Err(error),
            };
            match prepared {
                Ok((control, ready, failed)) => {
                    system_audio = Some(control);
                    warning = failed;
                    if exclude_audio.is_some() {
                        required_audio = Some(ready);
                    }
                }
                Err(failure) => {
                    let error_text = format!("{failure:#}");
                    let (error, failed) = oneshot::channel();
                    let _ = error.send(error_text.clone());
                    warning = Some(failed);
                    if exclude_audio.is_some() {
                        let (ready, started) = oneshot::channel();
                        let _ = ready.send(Err(anyhow!(error_text)));
                        required_audio = Some(started);
                    }
                }
            }
        }
        let (video_settings, _) = watch::channel(settings);
        let (video_requests, changes) = mpsc::channel(1);
        let control = Control {
            video: video_control,
            video_settings,
            video_requests,
            audio: audio_control,
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
            changes,
            bandwidth_changed,
        ));
        Ok((
            Self {
                video,
                control,
                task: Some(task),
                demands,
                audio_task: Some(audio_task),
                system_audio,
            },
            started,
            warning,
            required_audio,
        ))
    }

    pub fn audio(&self) -> Option<Uuid> {
        *self.control.audio.source.borrow()
    }

    pub async fn stop_system_audio(&mut self) {
        if let Some(control) = self.system_audio.take() {
            control.stop();
        }
        let _ = self.control.audio.stop_system().await;
    }

    pub fn audio_is_stopped(&self) -> bool {
        self.system_audio
            .as_ref()
            .is_some_and(AudioLeaseControl::is_stopped)
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
        if let Some(task) = self.audio_task.take() {
            let _ = task.await;
        }
        error
    }

    #[cfg(target_os = "windows")]
    pub async fn prepare_audio(
        &mut self,
        target: Target,
        enabled: bool,
        exclude: Option<Target>,
    ) -> Result<(
        AudioLeaseControl,
        oneshot::Receiver<Result<()>>,
        Option<oneshot::Receiver<String>>,
    )> {
        self.stop_system_audio().await;
        anyhow::ensure!(!self.control.is_stopped(), "capture_unavailable");
        let capture = enabled
            .then(|| AudioCapture::start_with_exclusion(target, exclude))
            .transpose()?;
        let (control, ready, warning) = self.control.audio.system(capture).await?;
        self.system_audio = Some(control.clone());
        Ok((control, ready, warning))
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
