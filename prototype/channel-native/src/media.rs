//! One output RTP clock belongs to one received or captured source. A replacement
//! creates a new sender/SSRC; clocks from different sources are never spliced.
#[cfg(target_os = "windows")]
pub(crate) mod local;

use anyhow::Result;
use rtc::{
    interceptor::{Attribute, Interceptor, Packet, StreamInfo, TaggedPacket},
    media_stream::MediaStreamTrack,
    rtcp::payload_feedbacks::{
        full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
    },
    rtcp::sender_report::SenderReport,
    rtp,
    rtp_transceiver::h264::H264ProfileLevelId,
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
pub(crate) const H264_RELAY_PROFILE: &str = "42e034";
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
                    && h264_profile(codec).is_some_and(|profile| profile.is_constrained_baseline()))
        }
        _ => false,
    }
}
fn h264_profile(codec: &RTCRtpCodec) -> Option<H264ProfileLevelId> {
    H264ProfileLevelId::parse(fmtp(codec, "profile-level-id").unwrap_or("42e01f"))
}
fn compatible(source: &RTCRtpCodec, negotiated: &RTCRtpCodec) -> bool {
    if !source.mime_type.eq_ignore_ascii_case(&negotiated.mime_type)
        || source.clock_rate != negotiated.clock_rate
    {
        return false;
    }
    if source.mime_type.eq_ignore_ascii_case("video/H264") {
        return supported(negotiated, RtpCodecKind::Video)
            && h264_profile(source)
                .zip(h264_profile(negotiated))
                .is_some_and(|(source, negotiated)| source.is_same_profile(negotiated));
    }
    true
}

// Only SPS carries the encoded profile/level. SDP describes the negotiated
// format, and common browser receive levels are not measured decoder limits.
// Keep three SPS octets, never an access unit or a history of parameter sets.
#[derive(Default)]
pub(crate) struct H264Sps {
    last: Option<[u8; 3]>,
    fragment: Option<(u32, u16, Vec<u8>)>,
}
impl H264Sps {
    fn check(&mut self, bytes: &[u8]) -> Result<()> {
        let bytes: [u8; 3] = bytes
            .get(..3)
            .ok_or_else(|| anyhow::anyhow!("truncated H264 SPS"))?
            .try_into()?;
        if self.last == Some(bytes) {
            return Ok(());
        }
        let profile =
            H264ProfileLevelId::parse(&format!("{:02x}{:02x}{:02x}", bytes[0], bytes[1], bytes[2]))
                .ok_or_else(|| anyhow::anyhow!("invalid H264 SPS profile/level"))?;
        anyhow::ensure!(
            profile.is_constrained_baseline()
                && profile.is_level_at_most(H264ProfileLevelId::parse(H264_RELAY_PROFILE).unwrap()),
            "unsupported H264 SPS profile/level {profile}"
        );
        self.last = Some(bytes);
        Ok(())
    }

    pub fn observe(&mut self, packet: &rtp::Packet) -> Result<()> {
        let payload = &packet.payload;
        match payload.first().map(|b| b & 0x1f) {
            Some(7) => self.check(&payload[1..])?,
            Some(24) => {
                let mut units = &payload[1..];
                while !units.is_empty() {
                    anyhow::ensure!(units.len() >= 2, "truncated H264 STAP-A");
                    let length = u16::from_be_bytes([units[0], units[1]]) as usize;
                    let nal = units
                        .get(2..2 + length)
                        .ok_or_else(|| anyhow::anyhow!("truncated H264 STAP-A NAL"))?;
                    if nal.first().is_some_and(|b| b & 0x1f == 7) {
                        self.check(&nal[1..])?;
                    }
                    units = &units[2 + length..];
                }
            }
            Some(28) if payload.len() >= 2 && payload[1] & 0x1f == 7 => {
                if payload[1] & 0x80 != 0 {
                    self.fragment = Some((
                        packet.header.timestamp,
                        packet.header.sequence_number,
                        Vec::with_capacity(3),
                    ));
                }
                if let Some((timestamp, sequence, prefix)) = &mut self.fragment {
                    if *timestamp != packet.header.timestamp
                        || *sequence != packet.header.sequence_number
                    {
                        self.fragment = None;
                        return Ok(());
                    }
                    prefix.extend(payload[2..].iter().take(3 - prefix.len()));
                    *sequence = sequence.wrapping_add(1);
                    if prefix.len() == 3 {
                        let (_, _, prefix) = self.fragment.take().unwrap();
                        self.check(&prefix)?;
                    } else if payload[1] & 0x40 != 0 {
                        anyhow::bail!("truncated H264 SPS");
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
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
            if !packets.is_empty() {
                msg.message.add(Attribute::DeliverToApplication);
            } else if msg.message.attributes.is_empty() {
                return Ok(());
            }
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
pub(crate) enum SourceOrigin {
    Incoming {
        pair: Uuid,
        flow_id: Uuid,
        stream: String,
    },
    Local,
}
#[derive(Clone)]
pub(crate) struct Source {
    pub id: Uuid,
    pub publication_id: Uuid,
    pub origin: SourceOrigin,
    // SDK format identity: received-track SDP or the local encoder's initial SPS.
    // Producers validate actual SPS separately from each Output's negotiation.
    pub codec: RTCRtpCodec,
    pub ssrc: u32,
    pub kind: RtpCodecKind,
    pub keyframes: watch::Sender<u64>,
    pub report: SourceReport,
}
impl Source {
    pub fn matches(&self, flow: &piik_channel_core::wire::FlowBinding, kind: RtpCodecKind) -> bool {
        self.publication_id == flow.publication_id
            && self.kind == kind
            && match &self.origin {
                SourceOrigin::Incoming { flow_id, .. } => flow.input_flow_id == Some(*flow_id),
                SourceOrigin::Local => flow.input_flow_id.is_none(),
            }
    }
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
    source_codec: RTCRtpCodec,
    negotiated: watch::Sender<Option<RTCRtpCodecParameters>>,
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
        let (negotiated, mut format) = watch::channel(None::<RTCRtpCodecParameters>);
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
                loop {
                    let packet = tokio::select! {
                        changed = format.changed() => {
                            if changed.is_err() { break; }
                            anyhow::ensure!(format.borrow().is_some(), "encoded codec no longer negotiated");
                            continue;
                        }
                        packet = rx.recv(), if format.borrow().is_some() => {
                            match packet { Some(packet) => packet, None => break }
                        }
                    };
                    let payload_type = format.borrow().as_ref()
                        .ok_or_else(|| anyhow::anyhow!("encoded codec no longer negotiated"))?.payload_type;
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
                    track.write_rtp(packet).await
                        .map_err(|_| anyhow::anyhow!("encoded RTP writer unavailable"))?;
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
    pub fn confirm(&self, codecs: &[RTCRtpCodecParameters]) {
        self.negotiated.send_replace(
            codecs
                .iter()
                .find(|codec| compatible(&self.source_codec, &codec.rtp_codec))
                .cloned(),
        );
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
pub(crate) struct Relay(Arc<Mutex<HashMap<Uuid, Vec<mpsc::Sender<rtp::Packet>>>>>);
impl Relay {
    pub fn remove(&self, source: Uuid) {
        self.0.lock().unwrap().remove(&source);
    }
    pub fn set(&self, source: Uuid, targets: Vec<mpsc::Sender<rtp::Packet>>) {
        self.0.lock().unwrap().insert(source, targets);
    }
    pub fn retain(&self, sources: &std::collections::HashSet<Uuid>) {
        self.0.lock().unwrap().retain(|id, _| sources.contains(id));
    }
    pub fn write(&self, source: Uuid, packet: rtp::Packet) {
        let routes = self.0.lock().unwrap();
        if let Some(targets) = routes.get(&source) {
            for target in targets {
                let _ = target.try_send(packet.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_feedback_preserves_sdk_metadata_without_exposing_consumed_rtcp() -> Result<()> {
        use rtc::{interceptor::AttributedPacket, rtcp::receiver_report::ReceiverReport};

        let packet = |packets| TaggedPacket {
            now: std::time::Instant::now(),
            transport: Default::default(),
            message: AttributedPacket::new(Packet::Rtcp(packets)),
        };
        let target = Attribute::TargetBitrateChanged {
            bits_per_second: 750_000.0,
        };
        let mut feedback = MediaFeedback::default();
        let mut report = packet(vec![Box::new(ReceiverReport::default())]);
        report.message.add(target.clone());
        feedback.handle_read(report)?;
        let carrier = feedback
            .poll_read()
            .expect("SDK target must survive filtering");
        assert!(matches!(&carrier.message.packet, Packet::Rtcp(packets) if packets.is_empty()));
        assert!(matches!(carrier.message.get(&target),
            Some(Attribute::TargetBitrateChanged { bits_per_second }) if *bits_per_second == 750_000.0));
        assert!(!carrier.message.has(&Attribute::DeliverToApplication));

        feedback.handle_read(packet(vec![Box::new(ReceiverReport::default())]))?;
        assert!(feedback.poll_read().is_none());
        feedback.handle_read(packet(vec![Box::new(PictureLossIndication::default())]))?;
        let picture_feedback = feedback.poll_read().expect("PLI reaches its source owner");
        assert!(picture_feedback
            .message
            .has(&Attribute::DeliverToApplication));
        assert!(
            matches!(&picture_feedback.message.packet, Packet::Rtcp(packets)
            if packets.len() == 1 && packets[0].as_any().is::<PictureLossIndication>())
        );
        Ok(())
    }

    #[test]
    fn h264_checks_actual_sps_without_retaining_a_historical_level_ceiling() -> Result<()> {
        let codec = |profile: &str| RTCRtpCodec {
            mime_type: "video/H264".into(),
            clock_rate: 90000,
            sdp_fmtp_line: format!("packetization-mode=1;profile-level-id={profile}"),
            ..Default::default()
        };
        assert!(compatible(&codec("42c028"), &codec("42e01f")));
        assert!(compatible(&codec("42f00b"), &codec("42c01f")));
        assert!(!compatible(&codec("42c028"), &codec("42001f")));
        let packet = |sequence_number, payload: Vec<u8>| rtp::Packet {
            header: rtp::header::Header {
                sequence_number,
                ..Default::default()
            },
            payload: payload.into(),
        };
        let mut sps = H264Sps::default();
        // A single-NAL 1080p SPS followed by a lower-level replacement is valid.
        sps.observe(&packet(1, vec![0x67, 0x42, 0xc0, 0x28, 0x95]))?;
        sps.observe(&packet(2, vec![0x67, 0x42, 0xc0, 0x1f, 0x95]))?;
        assert_eq!(sps.last, Some([0x42, 0xc0, 0x1f]));
        // An aggregated SPS/PPS and a fragmented SPS use the same profile parser.
        sps.observe(&packet(
            3,
            vec![0x78, 0, 4, 0x67, 0x42, 0xc0, 0x34, 0, 2, 0x68, 0xce],
        ))?;
        sps.observe(&packet(4, vec![0x7c, 0x87, 0x42]))?;
        sps.observe(&packet(5, vec![0x7c, 0x47, 0xc0, 0x28]))?;
        assert_eq!(sps.last, Some([0x42, 0xc0, 0x28]));
        // This is the actual relay format boundary, independent of remote SDP.
        assert!(sps
            .observe(&packet(6, vec![0x67, 0x42, 0xc0, 0x3c]))
            .is_err());
        assert!(sps.observe(&packet(7, vec![0x67, 0x64, 0, 0x28])).is_err());
        Ok(())
    }
}
