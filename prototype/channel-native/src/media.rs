//! Received RTP keeps its upstream clock. Local video access units feed stable
//! output clocks, independently of the encoding selected for each output.
pub(crate) mod clock;
#[cfg(all(
    feature = "capture",
    any(target_os = "windows", target_os = "linux", target_os = "macos")
))]
pub(crate) mod derived;
#[cfg(feature = "capture")]
pub(crate) mod encodings;
pub(crate) mod incoming;
#[cfg(feature = "capture")]
pub(crate) mod local;
mod output;
pub(crate) mod packetizer;
pub(crate) mod video;
pub(crate) mod vp8;
use anyhow::Result;
pub(crate) use output::Output;
use rtc::{
    rtcp::sender_report::SenderReport,
    rtp,
    rtp_transceiver::rtp_sender::{RTCRtpCodec, RtpCodecKind},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

#[derive(Debug)]
pub struct EncodedFrame {
    /// One complete encoded video frame; its Source owns the codec.
    pub bytes: Vec<u8>,
    /// Source presentation time, independent of encoding/delivery delay.
    pub presentation_time: std::time::Instant,
    pub keyframe: bool,
    /// Received VP8 descriptor facts; absent when the producer has none.
    pub vp8: Option<vp8::Vp8FrameMetadata>,
}

pub(crate) const RTP_PACKETS: usize = 256;
// One directed flow owns each kind; a publication can have several hop flows.
pub(crate) type TrackKey = (Uuid, RtpCodecKind);
pub(crate) type SourceReport = Arc<Mutex<Option<(SenderReport, std::time::Instant)>>>;

#[derive(Clone, Default)]
pub(crate) struct OutputStreams(Arc<Mutex<HashMap<u32, OutputStream>>>);

pub(crate) struct OutputStream {
    report: SourceReport,
    clock: Option<clock::SourceTime>,
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
                    && h264_level(codec).is_some())
        }
        _ => false,
    }
}
fn h264_level(codec: &RTCRtpCodec) -> Option<u8> {
    let value = fmtp(codec, "profile-level-id").unwrap_or("42e01f");
    if value.len() != 6 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(value, 16).ok()?;
    constrained_baseline_level([(value >> 16) as u8, (value >> 8) as u8, value as u8])
}

fn constrained_baseline_level([profile, constraints, level]: [u8; 3]) -> Option<u8> {
    // RFC 6184 section 8.1, Table 5: three encodings of the same sub-profile.
    let baseline = match profile {
        0x42 => constraints & 0x4f == 0x40,
        0x4d => constraints & 0x8f == 0x80,
        0x58 => constraints & 0xcf == 0xc0,
        _ => false,
    };
    (baseline && matches!(level, 10..=13 | 20..=22 | 30..=32 | 40..=42 | 50..=52 | 60..=62))
        .then_some(level)
}
pub(crate) fn compatible(source: &RTCRtpCodec, negotiated: &RTCRtpCodec) -> bool {
    if !source.mime_type.eq_ignore_ascii_case(&negotiated.mime_type)
        || source.clock_rate != negotiated.clock_rate
    {
        return false;
    }
    if source.mime_type.eq_ignore_ascii_case("video/H264") {
        return supported(negotiated, RtpCodecKind::Video) && h264_level(source).is_some();
    }
    true
}

// Only SPS carries the encoded profile/level. SDP describes the negotiated
// format, and common browser receive levels are not measured decoder limits.
// Keep three SPS octets, never an access unit or a history of parameter sets.
#[derive(Default)]
pub(crate) struct H264Sps {
    last: Option<[u8; 3]>,
}
impl H264Sps {
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
        anyhow::ensure!(
            constrained_baseline_level(bytes).is_some_and(|level| level <= 52),
            "unsupported H264 SPS profile/level {:02x}{:02x}{:02x}",
            bytes[0],
            bytes[1],
            bytes[2]
        );
        self.last = Some(bytes);
        Ok(())
    }
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
    pub layers: Option<video::Layers>,
}
impl Source {
    pub fn video(&self) -> Option<&video::Video> {
        match &self.feed {
            SourceFeed::Video(video) => Some(video),
            _ => None,
        }
    }
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
struct Rate<const N: usize = 1> {
    start: Option<Instant>,
    bytes: [Option<u64>; N],
    bps: Option<[Option<u64>; N]>,
}
impl<const N: usize> Default for Rate<N> {
    fn default() -> Self {
        Self {
            start: None,
            bytes: [None; N],
            bps: None,
        }
    }
}
impl<const N: usize> Rate<N> {
    fn observe_bin(&mut self, now: Instant, bin: usize, bytes: usize) {
        if self
            .bps
            .is_some_and(|bins| bins.into_iter().flatten().all(|bps| bps == 0))
        {
            self.start = Some(now);
            self.bps = None;
        }
        self.start.get_or_insert(now);
        *self.bytes[bin].get_or_insert(0) += bytes as u64;
    }
    fn sample_bins(&mut self, now: Instant) -> Option<[Option<u64>; N]> {
        let elapsed = now.duration_since(self.start?);
        if elapsed >= Duration::from_secs(1) {
            self.bps = Some(self.bytes.map(|bytes| {
                bytes.map(|bytes| (bytes as f64 * 8.0 / elapsed.as_secs_f64()) as u64)
            }));
            self.start = Some(now);
            self.bytes = self.bytes.map(|bytes| bytes.map(|_| 0));
        }
        self.bps
    }
}
impl Rate {
    fn observe(&mut self, now: Instant, bytes: usize) {
        self.observe_bin(now, 0, bytes);
    }
    fn sample(&mut self, now: Instant) -> Option<u64> {
        self.sample_bins(now)?[0]
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
        for profile in ["42E01F", "4d801f", "58c01f"] {
            assert!(supported(&codec(profile), RtpCodecKind::Video));
            assert!(compatible(&codec(profile), &codec("42e01f")));
        }
        let default = RTCRtpCodec {
            sdp_fmtp_line: "packetization-mode=1".into(),
            ..codec("42e01f")
        };
        assert!(compatible(&default, &codec("58c01f")));
        for profile in ["42e01", "42e01ff", "42e0zz", "42e009", "42e00e"] {
            assert!(!supported(&codec(profile), RtpCodecKind::Video));
        }
        let mut sps = H264Sps::default();
        // A lower-level SPS replaces the previous source fact. RTP depacketization
        // belongs to the incoming AU owner, not this SPS check.
        sps.access_unit(&[0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28])?;
        sps.access_unit(&[0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f])?;
        assert_eq!(sps.last, Some([0x42, 0xc0, 0x1f]));
        sps.access_unit(&[0, 0, 1, 0x67, 0x42, 0xc0, 0x34])?;
        for level in [60, 61, 62] {
            assert!(compatible(
                &codec(&format!("42e0{level:02x}")),
                &codec("4d801f")
            ));
            assert!(sps
                .access_unit(&[0, 0, 1, 0x67, 0x42, 0xc0, level])
                .is_err());
        }
        assert!(sps.access_unit(&[0, 0, 1, 0x67, 0x64, 0, 0x28]).is_err());
        Ok(())
    }
}
