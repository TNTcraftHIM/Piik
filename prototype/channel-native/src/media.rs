//! Received RTP keeps its upstream clock. Local video access units feed stable
//! output clocks, independently of the encoding selected for each output.
#[cfg(feature = "capture")]
pub(crate) mod local;
mod output;
#[cfg(any(feature = "capture", test))]
pub(crate) mod packetizer;
#[cfg(any(feature = "capture", test))]
pub(crate) mod video;
pub(crate) use output::Output;

use anyhow::Result;
use rtc::{
    interceptor::{Attribute, Interceptor, Packet, StreamInfo, TaggedPacket},
    rtcp::payload_feedbacks::{
        full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
    },
    rtcp::sender_report::SenderReport,
    rtp,
    rtp_transceiver::h264::H264ProfileLevelId,
    rtp_transceiver::rtp_sender::{RTCRtpCodec, RtpCodecKind},
    sansio::Protocol,
    shared::replay_detector::{ReplayDetector, WrappedSlidingWindowDetector},
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch, Notify};
use uuid::Uuid;

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
    #[cfg(feature = "capture")]
    pub fn access_unit(&mut self, bytes: &[u8]) -> Result<()> {
        // Annex B escapes start codes inside NAL payloads. Both three- and
        // four-byte delimiters contain this suffix; only the SPS prefix is needed.
        for prefix in bytes.windows(7) {
            if prefix[..3] == [0, 0, 1] && prefix[3] & 0x1f == 7 {
                self.check(&prefix[4..7])?;
            }
        }
        Ok(())
    }
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

/// One received track's media boundary, after the SDK has restored RTX identity.
pub(crate) struct RtpIngress {
    received: WrappedSlidingWindowDetector,
    h264: Option<H264Sps>,
}
impl RtpIngress {
    pub fn new(codec: &RTCRtpCodec) -> Self {
        Self {
            // Half the RTP sequence space: retain late repairs independently of
            // output queue size, without a second sequence/rollover algorithm.
            received: WrappedSlidingWindowDetector::new(1 << 15, u16::MAX as u64),
            h264: codec
                .mime_type
                .eq_ignore_ascii_case("video/H264")
                .then(H264Sps::default),
        }
    }

    pub fn accept(&mut self, packet: &rtp::Packet) -> Result<bool> {
        if !self.received.check(packet.header.sequence_number.into()) {
            return Ok(false);
        }
        if let Some(h264) = &mut self.h264 {
            h264.observe(packet)?;
        }
        self.received.accept();
        Ok(true)
    }
}

// The stock chain consumes network feedback. This final application hook exposes
// source sender reports and PLI/FIR, following upstream rtcp-processing.
#[derive(Default)]
pub(crate) struct MediaFeedback {
    read: VecDeque<TaggedPacket>,
    write: VecDeque<TaggedPacket>,
    target: Option<(watch::Sender<f64>, Arc<Notify>)>,
}
impl MediaFeedback {
    pub fn observe_target(target: watch::Sender<f64>, changed: Arc<Notify>) -> Self {
        Self {
            target: Some((target, changed)),
            ..Self::default()
        }
    }
}
impl Protocol<TaggedPacket, TaggedPacket, ()> for MediaFeedback {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = rtc::shared::error::Error;
    type Time = std::time::Instant;
    fn handle_read(&mut self, mut msg: TaggedPacket) -> std::result::Result<(), Self::Error> {
        if let Some((target, changed)) = &self.target {
            for attribute in &msg.message.attributes {
                if let Attribute::TargetBitrateChanged { bits_per_second } = attribute {
                    target.send_replace(*bits_per_second);
                    changed.notify_one();
                }
            }
        }
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
    #[cfg(any(feature = "capture", test))]
    Local,
}
#[derive(Clone)]
pub(crate) enum SourceFeed {
    Rtp {
        keyframes: watch::Sender<u64>,
        report: SourceReport,
    },
    #[cfg(any(feature = "capture", test))]
    Video(video::Video),
}
#[derive(Clone)]
pub(crate) struct Source {
    pub id: Uuid,
    pub publication_id: Uuid,
    pub origin: SourceOrigin,
    // SDK format identity: received-track SDP or the local encoder's initial SPS.
    // Producers validate actual SPS separately from each Output's negotiation.
    pub codec: RTCRtpCodec,
    pub kind: RtpCodecKind,
    pub feed: SourceFeed,
}
impl Source {
    pub fn matches(&self, flow: &piik_channel_core::wire::FlowBinding, kind: RtpCodecKind) -> bool {
        self.publication_id == flow.publication_id
            && self.kind == kind
            && match &self.origin {
                SourceOrigin::Incoming { flow_id, .. } => flow.input_flow_id == Some(*flow_id),
                #[cfg(any(feature = "capture", test))]
                SourceOrigin::Local => flow.input_flow_id.is_none(),
            }
    }
    pub fn request_keyframe(&self) {
        if self.kind == RtpCodecKind::Video {
            match &self.feed {
                SourceFeed::Rtp { keyframes, .. } => {
                    keyframes.send_modify(|n| *n = n.wrapping_add(1));
                }
                #[cfg(any(feature = "capture", test))]
                SourceFeed::Video(video) => video.request_keyframe(),
            }
        }
    }
}

// A transport projection, not a route planner. The control owner installs its
// current source identity and writer handles; readers hold this lock only long
// enough to enqueue one packet. No SDP, SQLite, or signaling await is on this path.
#[derive(Clone, Default)]
pub(crate) struct Relay(Arc<Mutex<HashMap<Uuid, RelaySource>>>);
#[derive(Default)]
struct RelaySource {
    targets: Vec<mpsc::Sender<rtp::Packet>>,
    rate: Rate,
}
#[derive(Default)]
struct Rate {
    start: Option<Instant>,
    bytes: u64,
    bps: Option<u64>,
}
impl Rate {
    fn observe(&mut self, now: Instant, bytes: usize) {
        if self.bps == Some(0) {
            self.start = Some(now);
            self.bps = None;
        }
        self.start.get_or_insert(now);
        self.bytes += bytes as u64;
    }
    fn sample(&mut self, now: Instant) -> Option<u64> {
        let elapsed = now.duration_since(self.start?);
        if elapsed >= Duration::from_secs(1) {
            self.bps = Some((self.bytes as f64 * 8.0 / elapsed.as_secs_f64()) as u64);
            self.start = Some(now);
            self.bytes = 0;
        }
        self.bps
    }
}
impl Relay {
    pub fn remove(&self, source: Uuid) {
        self.0.lock().unwrap().remove(&source);
    }
    pub fn set(&self, source: Uuid, targets: Vec<mpsc::Sender<rtp::Packet>>) {
        self.0.lock().unwrap().entry(source).or_default().targets = targets;
    }
    pub fn retain(&self, sources: &std::collections::HashSet<Uuid>) {
        self.0.lock().unwrap().retain(|id, _| sources.contains(id));
    }
    pub fn write(&self, source: Uuid, packet: rtp::Packet) {
        let mut routes = self.0.lock().unwrap();
        if let Some(source) = routes.get_mut(&source) {
            source
                .rate
                .observe(Instant::now(), packet.payload.len() + 12);
            for target in &source.targets {
                let _ = target.try_send(packet.clone());
            }
        }
    }
    pub fn bitrate(&self, source: Uuid, now: Instant) -> Option<u64> {
        self.0.lock().unwrap().get_mut(&source)?.rate.sample(now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingress_counts_and_forwards_repaired_media_once_across_rollover() -> Result<()> {
        let codec = RTCRtpCodec {
            mime_type: "video/VP8".into(),
            ..Default::default()
        };
        let mut ingress = RtpIngress::new(&codec);
        let relay = Relay::default();
        let source = Uuid::new_v4();
        let (target, mut received) = mpsc::channel(8);
        relay.set(source, vec![target]);
        // RTX has already regained its original primary sequence. The missing
        // packet arrives after rollover, then its late original arrives too.
        for sequence in [65534, 65534, 0, 0, 65535, 65535, 1] {
            let packet = rtp::Packet {
                header: rtp::header::Header {
                    sequence_number: sequence,
                    ..Default::default()
                },
                payload: vec![0; 88].into(),
            };
            if ingress.accept(&packet)? {
                relay.write(source, packet);
            }
        }
        let mut sequences = Vec::new();
        while let Ok(packet) = received.try_recv() {
            sequences.push(packet.header.sequence_number);
        }
        assert_eq!(sequences, [65534, 0, 65535, 1]);
        let start = relay.0.lock().unwrap()[&source].rate.start.unwrap();
        assert_eq!(
            relay.bitrate(source, start + Duration::from_secs(1)),
            Some(3200)
        );
        let mut replacement = RtpIngress::new(&codec);
        assert!(replacement.accept(&rtp::Packet::default())?);
        Ok(())
    }

    #[test]
    fn relay_measures_ingress_once_and_keeps_rate_with_its_source() {
        let relay = Relay::default();
        let source = Uuid::new_v4();
        let packet = rtp::Packet {
            payload: vec![0; 88].into(),
            ..Default::default()
        };
        let (first, mut first_rx) = mpsc::channel(4);
        let (second, mut second_rx) = mpsc::channel(4);
        relay.write(source, packet.clone());
        relay.set(source, vec![first, second]);
        assert_eq!(relay.bitrate(source, Instant::now()), None);
        relay.write(source, packet.clone());
        assert_eq!(first_rx.try_recv().unwrap(), packet);
        assert_eq!(second_rx.try_recv().unwrap(), packet);
        relay.set(source, vec![]);
        relay.write(source, packet.clone());
        assert!(first_rx.try_recv().is_err());
        assert!(second_rx.try_recv().is_err());
        let start = relay.0.lock().unwrap()[&source].rate.start.unwrap();
        assert_eq!(
            relay.bitrate(source, start + Duration::from_secs(1)),
            Some(1600)
        );
        relay.set(source, vec![]);
        assert_eq!(
            relay.bitrate(source, start + Duration::from_secs(2)),
            Some(0)
        );

        let resumed = start + Duration::from_secs(3);
        relay
            .0
            .lock()
            .unwrap()
            .get_mut(&source)
            .unwrap()
            .rate
            .observe(resumed, 100);
        assert_eq!(relay.bitrate(source, resumed), None);
        // One static packet has a real cost even without a second arrival.
        assert_eq!(
            relay.bitrate(source, resumed + Duration::from_secs(1)),
            Some(800)
        );
        assert_eq!(
            relay.bitrate(source, resumed + Duration::from_secs(2)),
            Some(0)
        );
        relay.remove(source);
        relay.set(source, vec![]);
        assert_eq!(
            relay.bitrate(source, resumed + Duration::from_secs(3)),
            None
        );
        relay.retain(&Default::default());
        assert!(!relay.0.lock().unwrap().contains_key(&source));
    }

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
        let (target_tx, mut target_rx) = watch::channel(300_000.0);
        let mut feedback = MediaFeedback::observe_target(target_tx, Arc::new(Notify::new()));
        let mut report = packet(vec![Box::new(ReceiverReport::default())]);
        report.message.add(target.clone());
        feedback.handle_read(report)?;
        assert_eq!(*target_rx.borrow_and_update(), 750_000.0);
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
