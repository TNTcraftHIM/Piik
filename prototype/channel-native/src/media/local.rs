//! One capture owns its encoder, source RTP clock and packetizer, independently
//! of how many currently admitted Outputs consume it.
use super::{H264Sps, Relay, Source, SourceOrigin};
use crate::{
    capture::{Capture, Control, Settings, Target},
    peer::{Event, SourceReady},
};
use anyhow::Result;
use rtc::{
    rtcp::sender_report::SenderReport,
    rtp::{
        codec::h264::H264Payloader,
        packetizer::{new_packetizer, Packetizer},
        sequence::new_random_sequencer,
    },
    rtp_transceiver::rtp_sender::{RTCRtpCodec, RtpCodecKind},
    shared::time::SystemInstant,
};
use std::time::Instant;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

pub(crate) struct Producer {
    pub publication_id: Uuid,
    pub control: Control,
    pub task: JoinHandle<Option<String>>,
}
impl Producer {
    pub fn start(
        source_id: Uuid,
        publication_id: Uuid,
        target: Target,
        settings: Settings,
        ready_sources: mpsc::Sender<SourceReady>,
        events: mpsc::Sender<Event>,
        relay: Relay,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<(Self, oneshot::Receiver<Result<()>>)> {
        // Take the wall/monotonic pair before capture can produce its first PTS.
        let now = Instant::now();
        let clock = SystemInstant::now(now);
        let mut capture = Capture::start(target, settings)?;
        let control = capture.control();
        let worker_control = control.clone();
        let (ready, started) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut ready = Some(ready);
            let (keyframes, mut requests) = watch::channel(0);
            let ssrc = u32::from_be_bytes(source_id.as_bytes()[..4].try_into().unwrap());
            let mut source = Source {
                id: source_id,
                publication_id,
                origin: SourceOrigin::Local,
                codec: RTCRtpCodec {
                    mime_type: "video/H264".into(),
                    clock_rate: 90_000,
                    ..Default::default()
                },
                ssrc,
                kind: RtpCodecKind::Video,
                keyframes,
                report: Default::default(),
            };
            let mut packetizer = new_packetizer(
                now,
                1200,
                102,
                ssrc,
                Box::<H264Payloader>::default(),
                Box::new(new_random_sequencer()),
                90_000,
            );
            let mut sps = H264Sps::default();
            let mut first_pts = None;
            let mut previous_ticks = 0u32;
            let result = async {
                loop {
                    let frame = tokio::select! {
                        frame = capture.recv() => match frame { Some(frame) => frame?, None => break },
                        changed = requests.changed() => {
                            if changed.is_err() || worker_control.force_keyframe().is_err() { break; }
                            continue;
                        }
                        _ = cancelled.changed() => break,
                    };
                    let first = first_pts.is_none();
                    let start = *first_pts.get_or_insert(frame.presentation_time);
                    let ticks = (frame.presentation_time.saturating_duration_since(start).as_nanos() * 90_000 / 1_000_000_000) as u32;
                    // Packetizer advances *after* packetize. Advance from actual
                    // capture PTS first; neither frame rate nor AU arrival is a clock.
                    packetizer.skip_samples(ticks.wrapping_sub(previous_ticks));
                    previous_ticks = ticks;
                    let packets = packetizer.packetize(Instant::now(), &frame.bytes.into(), 0)?;
                    for packet in &packets { sps.observe(packet)?; }
                    let timestamp = packets.first().ok_or_else(|| anyhow::anyhow!("capture produced an empty access unit"))?.header.timestamp;
                    *source.report.lock().unwrap() = Some((SenderReport {
                        ssrc, ntp_time: clock.ntp(frame.presentation_time), rtp_time: timestamp,
                        ..Default::default()
                    }, frame.presentation_time));
                    if first {
                        let profile = sps.last.ok_or_else(|| anyhow::anyhow!("capture first access unit has no SPS"))?;
                        source.codec.sdp_fmtp_line = format!("packetization-mode=1;profile-level-id={:02x}{:02x}{:02x}", profile[0], profile[1], profile[2]);
                        tokio::select! {
                            result = ready_sources.send(SourceReady { source: source.clone(), packets }) => { result?; }
                            _ = cancelled.changed() => break,
                        }
                        if let Some(ready) = ready.take() { let _ = ready.send(Ok(())); }
                    } else {
                        for packet in packets { relay.write(source_id, packet); }
                    }
                }
                Ok::<_, anyhow::Error>(())
            }.await;
            // Capture::stop joins both the MF worker and WGC. Never abandon it
            // when the controlling lease stops or a selected window disappears.
            let joined = tokio::task::spawn_blocking(move || capture.stop())
                .await
                .map_err(anyhow::Error::from)
                .and_then(|result| result);
            let error = result.and(joined).err().map(|error| format!("{error:#}"));
            if let Some(ready) = ready {
                let _ = ready.send(Err(anyhow::anyhow!(error
                    .clone()
                    .unwrap_or_else(|| "capture ended before its first frame".into()))));
            }
            if !*cancelled.borrow() {
                tokio::select! {
                    _ = events.send(Event::CaptureEnded { source: source_id }) => {},
                    _ = cancelled.changed() => {},
                }
            }
            error
        });
        Ok((
            Self {
                publication_id,
                control,
                task,
            },
            started,
        ))
    }
}
