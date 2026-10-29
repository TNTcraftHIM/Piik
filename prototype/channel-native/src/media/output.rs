//! One admitted output keeps its sender and RTP clock across local encodings.
use super::{
    compatible, packetizer::Packetizer, video, SenderReports, Source, SourceFeed, TrackKey,
    VIDEO_PACKETS,
};
use anyhow::Result;
use rtc::{
    media_stream::MediaStreamTrack,
    rtcp::payload_feedbacks::{
        full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
    },
    rtp,
    rtp::codec::h264::H264Payloader,
    rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
        RTCRtpRtxParameters, RtpCodecKind,
    },
};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use uuid::Uuid;
use webrtc::{
    media_stream::track_local::{static_rtp::TrackLocalStaticRTP, TrackLocal, TrackLocalEvent},
    peer_connection::PeerConnection,
    rtp_transceiver::RtpSender,
};

#[derive(Clone)]
enum Input {
    Rtp(mpsc::Sender<rtp::Packet>),
    Video(Arc<video::Input>),
}
enum Reader {
    Rtp(mpsc::Receiver<rtp::Packet>),
    Video(Arc<video::Input>, Packetizer),
}
impl Reader {
    async fn recv(&mut self) -> Option<Result<Vec<rtp::Packet>>> {
        match self {
            Self::Rtp(rx) => rx.recv().await.map(|packet| Ok(vec![packet])),
            Self::Video(input, packetizer) => input
                .recv()
                .await
                .map(|frame| packetizer.packetize(frame.bytes.clone(), frame.presentation_time)),
        }
    }
}

pub(crate) struct Output {
    pub id: Uuid,
    pub source: Uuid,
    pub stream: String,
    pub sender: Arc<dyn RtpSender>,
    source_codec: RTCRtpCodec,
    negotiated: watch::Sender<Option<RTCRtpCodecParameters>>,
    input: Input,
    task: JoinHandle<()>,
    feedback: JoinHandle<()>,
    reports: SenderReports,
    ssrc: u32,
    submitted_bytes: Arc<AtomicU64>,
    measured: (Instant, u64),
    bitrate: u64,
}
impl Output {
    pub async fn new(
        pc: &dyn PeerConnection,
        source: &Source,
        stream: String,
        pair: Uuid,
        key: TrackKey,
        events: mpsc::Sender<crate::peer::Event>,
        reports: SenderReports,
    ) -> Result<Self> {
        let id = Uuid::new_v4();
        let ssrc = u32::from_be_bytes(id.as_bytes()[..4].try_into().unwrap());
        let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
            stream.clone(),
            Uuid::new_v4().to_string(),
            "Encoded relay".into(),
            source.kind,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    rtx: (source.kind == RtpCodecKind::Video).then_some(RTCRtpRtxParameters {
                        ssrc: ssrc.wrapping_add(1),
                    }),
                    ..Default::default()
                },
                // The SDK uses this format identity to bind its SR/feedback
                // interceptors. Actual source level still comes only from SPS.
                codec: source.codec.clone(),
                ..Default::default()
            }],
        )));
        let sender = pc.add_track(track.clone()).await?;
        let configure = async {
            if source.kind == RtpCodecKind::Video {
                for transceiver in pc.get_transceivers().await {
                    if transceiver
                        .sender()
                        .await?
                        .is_some_and(|candidate| candidate.id() == sender.id())
                    {
                        let capabilities = sender
                            .get_capabilities(source.kind)
                            .await?
                            .ok_or_else(|| anyhow::anyhow!("missing local video capabilities"))?;
                        let primary: Vec<RTCRtpCodecParameters> = capabilities
                            .codecs
                            .into_iter()
                            .filter(|codec| compatible(&source.codec, codec))
                            .map(|rtp_codec| RTCRtpCodecParameters {
                                rtp_codec,
                                ..Default::default()
                            })
                            .collect();
                        anyhow::ensure!(!primary.is_empty(), "no compatible encoded video codec");
                        // set_codec_preferences retains only repair codecs associated with the primary.
                        transceiver.set_codec_preferences(primary).await?;
                        break;
                    }
                }
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = configure {
            let _ = pc.remove_track(&sender).await;
            return Err(error);
        }
        let (input, mut reader, report) = match &source.feed {
            SourceFeed::Rtp { report, .. } => {
                let (packets, rx) = mpsc::channel(if source.kind == RtpCodecKind::Video {
                    VIDEO_PACKETS
                } else {
                    1
                });
                (Input::Rtp(packets), Reader::Rtp(rx), report.clone())
            }
            SourceFeed::Video(video) => {
                let report: super::SourceReport = Default::default();
                let packetizer = Packetizer::new(
                    &source.codec,
                    Box::<H264Payloader>::default(),
                    0, // The writer applies this sender's negotiated payload type.
                    ssrc,
                    video.time(),
                    report.clone(),
                );
                let input = video.subscribe();
                // Confirmed transport demand activates the first encoding.
                input.set_active(false);
                (
                    Input::Video(input.clone()),
                    Reader::Video(input, packetizer),
                    report,
                )
            }
        };
        reports
            .0
            .lock()
            .unwrap()
            .insert(ssrc, (source.codec.clock_rate, report));
        let (negotiated, mut format) = watch::channel(None::<RTCRtpCodecParameters>);
        let source_id = source.id;
        let submitted_bytes = Arc::new(AtomicU64::new(0));
        let submitted = submitted_bytes.clone();
        let feedback_track = track.clone();
        let upstream = source.clone();
        let feedback_input = input.clone();
        let feedback = tokio::spawn(async move {
            while let Some(TrackLocalEvent::OnRtcpPacket(packets)) = feedback_track.poll().await {
                if packets.iter().any(|packet| {
                    packet.as_any().is::<PictureLossIndication>()
                        || packet.as_any().is::<FullIntraRequest>()
                }) {
                    match &feedback_input {
                        Input::Rtp(_) => upstream.request_keyframe(),
                        Input::Video(input) => input.request_keyframe(),
                    }
                }
            }
        });
        let task = tokio::spawn(async move {
            let result = async {
                loop {
                    let packets = tokio::select! {
                        changed = format.changed() => {
                            if changed.is_err() { break; }
                            anyhow::ensure!(format.borrow().is_some(), "encoded codec no longer negotiated");
                            continue;
                        }
                        packets = reader.recv(), if format.borrow().is_some() => {
                            match packets { Some(packets) => packets?, None => break }
                        }
                    };
                    let payload_type = format.borrow().as_ref()
                        .ok_or_else(|| anyhow::anyhow!("encoded codec no longer negotiated"))?.payload_type;
                    for packet in packets {
                      // The sender owns negotiated PT (e.g. a remote offer may use 109).
                      // Construct a hop-local header: no upstream TWCC/abs-send-time/CSRC.
                      let packet = rtp::Packet {
                        header: rtp::header::Header {
                            version: 2,
                            marker: packet.header.marker,
                            payload_type,
                            sequence_number: packet.header.sequence_number,
                            timestamp: packet.header.timestamp,
                            ssrc,
                            ..Default::default()
                        },
                        payload: packet.payload,
                      };
                      // SDK send errors contain the rejected media packet.
                      let bytes = packet.payload.len() + 12;
                      track.write_rtp(packet).await
                        .map_err(|_| anyhow::anyhow!("encoded RTP writer unavailable"))?;
                      submitted.fetch_add(bytes as u64, Ordering::Relaxed);
                    }
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                eprintln!("Native encoded output failed: {error}");
                let _ = events
                    .send(crate::peer::Event::OutputFailed {
                        pair,
                        key,
                        source: source_id,
                        output: id,
                    })
                    .await;
            }
        });
        Ok(Self {
            id,
            source: source.id,
            stream,
            sender,
            source_codec: source.codec.clone(),
            negotiated,
            input,
            task,
            feedback,
            reports,
            ssrc,
            submitted_bytes,
            measured: (Instant::now(), 0),
            bitrate: 0,
        })
    }
    pub fn rtp_sink(&self) -> Option<mpsc::Sender<rtp::Packet>> {
        match &self.input {
            Input::Rtp(packets) => Some(packets.clone()),
            Input::Video(_) => None,
        }
    }
    /// RTP submitted to transport, before pacing reduces departures on a weak path.
    pub fn bitrate(&mut self, now: Instant) -> u64 {
        let elapsed = now.duration_since(self.measured.0);
        if elapsed >= Duration::from_secs(1) {
            let bytes = self.submitted_bytes.load(Ordering::Relaxed);
            self.bitrate = ((bytes - self.measured.1) as f64 * 8.0 / elapsed.as_secs_f64()) as u64;
            self.measured = (now, bytes);
        }
        self.bitrate
    }
    pub fn video_input(&self) -> Option<Weak<video::Input>> {
        match &self.input {
            Input::Video(input) => Some(Arc::downgrade(input)),
            Input::Rtp(_) => None,
        }
    }
    #[cfg(target_os = "windows")]
    pub fn encoding_failed(&self, video: &video::Video) -> bool {
        match &self.input {
            Input::Video(input) => input.failed(video),
            Input::Rtp(_) => false,
        }
    }
    pub fn confirm(&self, codecs: &[RTCRtpCodecParameters]) {
        self.negotiated.send_replace(
            codecs
                .iter()
                .find(|codec| compatible(&self.source_codec, &codec.rtp_codec))
                .cloned(),
        );
    }
    pub async fn close(self, pc: &dyn PeerConnection) {
        if let Input::Video(input) = &self.input {
            input.close();
        }
        self.reports.0.lock().unwrap().remove(&self.ssrc);
        self.task.abort();
        self.feedback.abort();
        let _ = self.task.await;
        let _ = self.feedback.await;
        let _ = pc.remove_track(&self.sender).await;
    }
}
