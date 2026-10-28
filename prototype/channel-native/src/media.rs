//! One output RTP clock belongs to one received source track. A source replacement
//! creates a new sender/SSRC; clocks from different sources are never spliced.
use anyhow::Result;
use rtc::{
    interceptor::{Attribute, Interceptor, Packet, StreamInfo, TaggedPacket},
    media_stream::MediaStreamTrack,
    rtcp::payload_feedbacks::{
        full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
    },
    rtcp::sender_report::SenderReport,
    rtp,
    rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
        RTCRtpRtxParameters, RtpCodecKind,
    },
    sansio::Protocol,
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
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

pub(crate) const VIDEO_PACKETS: usize = 256;
// One directed flow owns each kind; a publication can have several hop flows.
pub(crate) type TrackKey = (Uuid, RtpCodecKind);
pub(crate) type SourceReport = Arc<Mutex<Option<(SenderReport, std::time::Instant)>>>;

#[derive(Clone, Default)]
pub(crate) struct SenderReports(Arc<Mutex<HashMap<u32, (u32, SourceReport)>>>);
pub(crate) struct ReportProjection {
    reports: SenderReports,
    read: VecDeque<TaggedPacket>,
    write: VecDeque<TaggedPacket>,
}
impl ReportProjection {
    pub fn new(reports: SenderReports) -> Self {
        Self {
            reports,
            read: VecDeque::new(),
            write: VecDeque::new(),
        }
    }
}
impl Protocol<TaggedPacket, TaggedPacket, ()> for ReportProjection {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = rtc::shared::error::Error;
    type Time = std::time::Instant;
    fn handle_read(&mut self, msg: TaggedPacket) -> std::result::Result<(), Self::Error> {
        self.read.push_back(msg);
        Ok(())
    }
    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read.pop_front()
    }
    fn handle_write(&mut self, mut msg: TaggedPacket) -> std::result::Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &mut msg.message.packet {
            let sources = self.reports.0.lock().unwrap();
            packets.retain_mut(|packet| {
                let Some(report) = packet.as_any().downcast_ref::<SenderReport>() else {
                    return true;
                };
                let Some((rate, source)) = sources.get(&report.ssrc) else {
                    return true;
                };
                let source = source.lock().unwrap();
                let Some((original, received)) = source.as_ref() else {
                    return false;
                };
                let elapsed = msg.now.saturating_duration_since(*received);
                let mut next = report.clone();
                // Advance the source's paired clocks by the same duration. Never
                // anchor either media clock to this hop's independent packet arrival.
                next.ntp_time = original.ntp_time.wrapping_add(
                    (elapsed.as_secs() << 32)
                        .wrapping_add(((elapsed.subsec_nanos() as u64) << 32) / 1_000_000_000),
                );
                next.rtp_time = original
                    .rtp_time
                    .wrapping_add((elapsed.as_nanos() * *rate as u128 / 1_000_000_000) as u32);
                *packet = Box::new(next);
                true
            });
            if packets.is_empty() {
                return Ok(());
            }
        }
        self.write.push_back(msg);
        Ok(())
    }
    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write.pop_front()
    }
}
impl Interceptor for ReportProjection {
    fn bind_local_stream(&mut self, _: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _: &StreamInfo) {}
}

fn fmtp<'a>(codec: &'a RTCRtpCodec, name: &str) -> Option<&'a str> {
    codec.sdp_fmtp_line.split(';').find_map(|field| {
        let (key, value) = field.trim().split_once('=')?;
        key.eq_ignore_ascii_case(name).then_some(value.trim())
    })
}
pub(crate) fn supported(codec: &RTCRtpCodec, kind: RtpCodecKind) -> bool {
    match kind {
        RtpCodecKind::Audio => {
            codec.mime_type.eq_ignore_ascii_case("audio/opus") && codec.clock_rate == 48000
        }
        RtpCodecKind::Video if codec.clock_rate == 90000 => {
            codec.mime_type.eq_ignore_ascii_case("video/VP8")
                || (codec.mime_type.eq_ignore_ascii_case("video/H264")
                    && fmtp(codec, "packetization-mode") == Some("1")
                    && fmtp(codec, "profile-level-id").is_some_and(|profile| {
                        profile.len() == 6
                            && u32::from_str_radix(profile, 16).is_ok()
                            && profile[..4].eq_ignore_ascii_case("42e0")
                    }))
        }
        _ => false,
    }
}
fn compatible(source: &RTCRtpCodec, negotiated: &RTCRtpCodec) -> bool {
    if !source.mime_type.eq_ignore_ascii_case(&negotiated.mime_type)
        || source.clock_rate != negotiated.clock_rate
    {
        return false;
    }
    if source.mime_type.eq_ignore_ascii_case("video/H264") {
        return supported(negotiated, RtpCodecKind::Video)
            && fmtp(source, "profile-level-id").and_then(|s| u32::from_str_radix(s, 16).ok())
                <= fmtp(negotiated, "profile-level-id")
                    .and_then(|s| u32::from_str_radix(s, 16).ok());
    }
    true
}

// The stock chain consumes network feedback. This final application hook exposes
// source sender reports and PLI/FIR, following upstream rtcp-processing.
#[derive(Default)]
pub(crate) struct MediaFeedback {
    read: VecDeque<TaggedPacket>,
    write: VecDeque<TaggedPacket>,
}
impl Protocol<TaggedPacket, TaggedPacket, ()> for MediaFeedback {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = rtc::shared::error::Error;
    type Time = std::time::Instant;
    fn handle_read(&mut self, mut msg: TaggedPacket) -> std::result::Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &mut msg.message.packet {
            packets.retain(|packet| {
                packet.as_any().is::<SenderReport>()
                    || packet.as_any().is::<PictureLossIndication>()
                    || packet.as_any().is::<FullIntraRequest>()
            });
            if packets.is_empty() {
                return Ok(());
            }
            msg.message.add(Attribute::DeliverToApplication);
        }
        self.read.push_back(msg);
        Ok(())
    }
    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read.pop_front()
    }
    fn handle_write(&mut self, msg: TaggedPacket) -> std::result::Result<(), Self::Error> {
        self.write.push_back(msg);
        Ok(())
    }
    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write.pop_front()
    }
}
impl Interceptor for MediaFeedback {
    fn bind_local_stream(&mut self, _: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _: &StreamInfo) {}
}

#[derive(Clone)]
pub(crate) struct Source {
    pub id: Uuid,
    pub flow_id: Uuid,
    pub publication_id: Uuid,
    pub pair: Uuid,
    pub stream: String,
    pub codec: RTCRtpCodec,
    pub ssrc: u32,
    pub kind: RtpCodecKind,
    pub keyframes: watch::Sender<u64>,
    pub report: SourceReport,
}
impl Source {
    pub fn request_keyframe(&self) {
        if self.kind == RtpCodecKind::Video {
            self.keyframes.send_modify(|n| *n = n.wrapping_add(1));
        }
    }
}

pub(crate) struct Output {
    pub id: Uuid,
    pub source: Uuid,
    pub stream: String,
    pub sender: Arc<dyn RtpSender>,
    packets: mpsc::Sender<rtp::Packet>,
    task: JoinHandle<()>,
    feedback: JoinHandle<()>,
    reports: SenderReports,
    ssrc: u32,
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
                        let parameters = sender.get_parameters().await?;
                        let primary: Vec<RTCRtpCodecParameters> = parameters
                            .rtp_parameters
                            .codecs
                            .into_iter()
                            .filter(|codec| compatible(&source.codec, &codec.rtp_codec))
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
        reports
            .0
            .lock()
            .unwrap()
            .insert(ssrc, (source.codec.clock_rate, source.report.clone()));
        // Independent media writers prevent a slow child from holding another child
        // or the PC control actor. Overflow drops real-time media, never reliable DC.
        let (packets, mut rx) =
            mpsc::channel::<rtp::Packet>(if source.kind == RtpCodecKind::Video {
                VIDEO_PACKETS
            } else {
                1
            });
        let negotiated = sender.clone();
        let source_codec = source.codec.clone();
        let source_id = source.id;
        let feedback_track = track.clone();
        let upstream = source.clone();
        let feedback = tokio::spawn(async move {
            while let Some(TrackLocalEvent::OnRtcpPacket(packets)) = feedback_track.poll().await {
                if packets.iter().any(|packet| {
                    packet.as_any().is::<PictureLossIndication>()
                        || packet.as_any().is::<FullIntraRequest>()
                }) {
                    upstream.request_keyframe();
                }
            }
        });
        let task = tokio::spawn(async move {
            let result = async {
                while let Some(packet) = rx.recv().await {
                    let parameters = negotiated.get_parameters().await?;
                    let codec = parameters
                        .rtp_parameters
                        .codecs
                        .iter()
                        .find(|codec| compatible(&source_codec, &codec.rtp_codec))
                        .ok_or_else(|| anyhow::anyhow!("encoded codec no longer negotiated"))?;
                    // The sender owns negotiated PT (e.g. a remote offer may use 109).
                    // Construct a hop-local header: no upstream TWCC/abs-send-time/CSRC.
                    let packet = rtp::Packet {
                        header: rtp::header::Header {
                            version: 2,
                            marker: packet.header.marker,
                            payload_type: codec.payload_type,
                            sequence_number: packet.header.sequence_number,
                            timestamp: packet.header.timestamp,
                            ssrc,
                            ..Default::default()
                        },
                        payload: packet.payload,
                    };
                    track.write_rtp(packet).await?;
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
            packets,
            task,
            feedback,
            reports,
            ssrc,
        })
    }
    pub fn sink(&self) -> mpsc::Sender<rtp::Packet> {
        self.packets.clone()
    }
    pub async fn close(self, pc: &dyn PeerConnection) {
        self.reports.0.lock().unwrap().remove(&self.ssrc);
        self.task.abort();
        self.feedback.abort();
        let _ = self.task.await;
        let _ = self.feedback.await;
        let _ = pc.remove_track(&self.sender).await;
    }
}

// A transport projection, not a route planner. The control owner installs its
// current source identity and writer handles; readers hold this lock only long
// enough to enqueue one packet. No SDP, SQLite, or signaling await is on this path.
#[derive(Clone, Default)]
pub(crate) struct Relay(Arc<Mutex<HashMap<TrackKey, (Uuid, Vec<mpsc::Sender<rtp::Packet>>)>>>);
impl Relay {
    pub fn remove(&self, key: TrackKey) {
        self.0.lock().unwrap().remove(&key);
    }
    pub fn set(&self, key: TrackKey, source: Uuid, targets: Vec<mpsc::Sender<rtp::Packet>>) {
        self.0.lock().unwrap().insert(key, (source, targets));
    }
    pub fn retain(&self, flows: &std::collections::HashSet<TrackKey>) {
        self.0.lock().unwrap().retain(|id, _| flows.contains(id));
    }
    pub fn write(&self, key: TrackKey, source: Uuid, packet: rtp::Packet) {
        let routes = self.0.lock().unwrap();
        if let Some((active, targets)) = routes.get(&key) {
            if *active == source {
                for target in targets {
                    let _ = target.try_send(packet.clone());
                }
            }
        }
    }
}
