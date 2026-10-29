//! One capture owns its encoders and source clocks, independently of its Outputs.
use super::{
    packetizer::{CaptureTime, Packetizer},
    video::Video,
    H264Sps, Relay, Source, SourceFeed, SourceOrigin,
};
use crate::{
    capture::{AudioCapture, AudioControl, Capture, Control as VideoControl, Settings, Target},
    peer::{Event, InitialMedia, SourceReady},
};
use anyhow::{anyhow, Result};
use rtc::{
    rtp::{codec::opus::OpusPayloader, packetizer::Payloader},
    rtp_transceiver::rtp_sender::{RTCRtpCodec, RtpCodecKind},
    shared::time::SystemInstant,
};
use std::time::Instant;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

/// The page's one lease stops both workers without waiting for the signaling actor.
#[derive(Clone)]
pub(crate) struct Control {
    video: VideoControl,
    audio: Option<AudioControl>,
}
impl Control {
    pub fn stop(&self) {
        self.video.stop();
        if let Some(audio) = &self.audio {
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
    pub task: JoinHandle<Option<String>>,
}
impl Producer {
    pub fn start(
        publication_id: Uuid,
        target: Target,
        settings: Settings,
        audio: bool,
        ready_sources: mpsc::Sender<SourceReady>,
        events: mpsc::Sender<Event>,
        relay: Relay,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<(
        Self,
        oneshot::Receiver<Result<()>>,
        Option<oneshot::Receiver<String>>,
    )> {
        // Both source reports project original capture PTS through this one pair.
        let now = Instant::now();
        let clock = SystemInstant::now(now);
        let capture = Capture::start(target.clone(), settings.fps)?;
        let mut encoding = capture.encode(settings)?;
        let video_control = capture.control();
        let encoder_control = encoding.control();
        let (audio_error, warning) = if audio {
            let (error, warning) = oneshot::channel();
            (Some(error), Some(warning))
        } else {
            (None, None)
        };
        let audio = if let Some(error) = audio_error {
            match AudioCapture::start(target) {
                Ok(capture) => {
                    let id = Uuid::new_v4();
                    let control = capture.control();
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
                    ));
                    Some((id, control, task))
                }
                Err(failure) => {
                    let error_text = format!("{failure:#}");
                    eprintln!("Native source audio failed: {error_text}");
                    let _ = error.send(error_text);
                    None
                }
            }
        } else {
            None
        };
        let audio_id = audio.as_ref().map(|(id, _, _)| *id);
        let control = Control {
            video: video_control,
            audio: audio.as_ref().map(|(_, control, _)| control.clone()),
        };
        let worker_control = control.clone();
        let video = Uuid::new_v4();
        let (ready, started) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut ready = Some(ready);
            let frames = Video::new(CaptureTime { epoch: now, clock });
            let mut requests = frames.requests();
            let mut source = Source {
                id: video,
                publication_id,
                origin: SourceOrigin::Local,
                kind: RtpCodecKind::Video,
                codec: RTCRtpCodec {
                    mime_type: "video/H264".into(),
                    clock_rate: 90_000,
                    ..Default::default()
                },
                feed: SourceFeed::Video(frames.clone()),
            };
            let mut sps = H264Sps::default();
            let mut first = true;
            let result = async {
                loop {
                    let frame = tokio::select! {
                        frame = encoding.recv() => match frame { Some(frame) => frame?, None => break },
                        changed = requests.changed() => {
                            if changed.is_err() || encoder_control.force_keyframe().is_err() { break; }
                            continue;
                        }
                        _ = cancelled.changed() => break,
                    };
                    sps.access_unit(&frame.bytes)?;
                    if first {
                        let profile = sps.last.ok_or_else(|| anyhow!("capture first access unit has no SPS"))?;
                        source.codec.sdp_fmtp_line = format!("packetization-mode=1;profile-level-id={:02x}{:02x}{:02x}", profile[0], profile[1], profile[2]);
                        tokio::select! {
                            result = ready_sources.send(SourceReady { source: source.clone(), media: InitialMedia::Video(frame) }) => { result?; }
                            _ = cancelled.changed() => break,
                        }
                        first = false;
                        if let Some(ready) = ready.take() { let _ = ready.send(Ok(())); }
                    } else {
                        frames.write(frame);
                    }
                }
                Ok::<_, anyhow::Error>(())
            }.await;
            worker_control.stop();
            let joined = tokio::task::spawn_blocking(move || {
                let encoded = encoding.stop();
                let captured = capture.stop();
                encoded.and(captured)
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(|result| result);
            if let Some((_, _, audio)) = audio {
                if let Err(error) = audio.await {
                    eprintln!("Native audio task failed: {error}");
                }
            }
            let error = result.and(joined).err().map(|error| format!("{error:#}"));
            if let Some(ready) = ready {
                let _ = ready.send(Err(anyhow!(error
                    .clone()
                    .unwrap_or_else(|| "capture ended before its first frame".into()))));
            }
            if !*cancelled.borrow() {
                tokio::select! {
                    _ = events.send(Event::CaptureEnded { publication_id, source: video }) => {},
                    _ = cancelled.changed() => {},
                }
            }
            error
        });
        Ok((
            Self {
                video,
                audio: audio_id,
                control,
                task,
            },
            started,
            warning,
        ))
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
) {
    let result = async {
        capture.ready().await?;
        let mut encoder = rusty_opus::OpusEncoder::new(48_000, 2, rusty_opus::Application::Audio)?;
        encoder.bitrate_bps = 128_000;
        encoder.complexity = 10;
        encoder.use_cbr = true;
        let mut encoded = [0u8; 1500];
        let mut source = RtpSource::new(
            id, publication_id, RtpCodecKind::Audio, crate::peer::codec(),
            Box::<OpusPayloader>::default(), 111, now, clock,
        );
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
            let packets = source.packetize(encoded[..length].to_vec(), frame.presentation_time)?;
            if first {
                tokio::select! {
                    result = ready_sources.send(SourceReady { source: source.source.clone(), media: InitialMedia::Rtp(packets) }) => { result?; }
                    _ = cancelled.changed() => break,
                }
                first = false;
            } else {
                for packet in packets { relay.write(id, packet); }
            }
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    let joined = tokio::task::spawn_blocking(move || capture.stop())
        .await
        .map_err(anyhow::Error::from)
        .and_then(|result| result);
    if !video.is_stopped() && !*cancelled.borrow() {
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
        payloader: Box<dyn Payloader>,
        payload_type: u8,
        epoch: Instant,
        clock: SystemInstant,
    ) -> Self {
        let ssrc = u32::from_be_bytes(id.as_bytes()[..4].try_into().unwrap());
        let report: super::SourceReport = Default::default();
        let packetizer = Packetizer::new(
            &codec,
            payloader,
            payload_type,
            ssrc,
            CaptureTime { epoch, clock },
            report.clone(),
        );
        Self {
            source: Source {
                id,
                publication_id,
                origin: SourceOrigin::Local,
                codec,
                kind,
                feed: SourceFeed::Rtp {
                    keyframes: watch::channel(0).0,
                    report,
                },
            },
            packetizer,
        }
    }
    fn packetize(
        &mut self,
        bytes: Vec<u8>,
        presentation_time: Instant,
    ) -> Result<Vec<rtc::rtp::Packet>> {
        self.packetizer.packetize(bytes, presentation_time)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rtc::rtp::codec::h264::H264Payloader;
    use std::time::Duration;

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
            Box::<OpusPayloader>::default(),
            111,
            epoch,
            clock,
        );
        let mut video = RtpSource::new(
            Uuid::from_u128(2 << 96),
            publication,
            RtpCodecKind::Video,
            RTCRtpCodec {
                mime_type: "video/H264".into(),
                clock_rate: 90_000,
                ..Default::default()
            },
            Box::<H264Payloader>::default(),
            102,
            epoch,
            clock,
        );
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
