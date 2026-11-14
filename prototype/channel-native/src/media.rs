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
pub(crate) mod h264;
pub(crate) mod incoming;
#[cfg(feature = "capture")]
pub(crate) mod local;
mod output;
pub(crate) mod packetizer;
pub(crate) mod video;
pub(crate) mod vp8;
use anyhow::Result;
pub(crate) use output::Output;
use rtc_rtp as rtp;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
pub(crate) use str0m::media::MediaKind;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub(crate) struct RtpCodec {
    pub mime_type: String,
    pub clock_rate: u32,
    pub channels: u16,
    pub sdp_fmtp_line: String,
}
impl RtpCodec {
    pub fn h264(profile: [u8; 3]) -> Self {
        Self {
            mime_type: "video/H264".into(),
            clock_rate: 90_000,
            sdp_fmtp_line: format!(
                "packetization-mode=1;profile-level-id={:02x}{:02x}{:02x}",
                profile[0], profile[1], profile[2]
            ),
            ..Default::default()
        }
    }
}

pub(crate) fn derived_codec(codec: &RtpCodec) -> Option<crate::capture::VideoCodec> {
    use crate::capture::VideoCodec;
    if cfg!(all(
        feature = "capture",
        any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        )
    )) && codec.mime_type.eq_ignore_ascii_case("video/H264")
    {
        Some(VideoCodec::H264)
    } else if cfg!(all(feature = "capture", target_os = "windows"))
        && codec.mime_type.eq_ignore_ascii_case("video/VP8")
    {
        Some(VideoCodec::Vp8)
    } else {
        None
    }
}

/// The existing encoder adapters produce one format for each supported family.
pub(crate) fn encoding_codec(codec: &RtpCodec) -> Option<RtpCodec> {
    if codec.mime_type.eq_ignore_ascii_case("video/H264") {
        Some(RtpCodec::h264([0x42, 0xe0, 0x1f]))
    } else if codec.mime_type.eq_ignore_ascii_case("video/VP8") {
        Some(codec.clone())
    } else {
        None
    }
}

#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub(crate) struct RtpCodecParameters {
    pub rtp_codec: RtpCodec,
    pub payload_type: u8,
}

#[derive(Debug)]
pub struct EncodedFrame {
    /// One complete encoded video frame; its Video owns the encoded format.
    pub bytes: Vec<u8>,
    /// Source presentation time, independent of encoding/delivery delay.
    pub presentation_time: std::time::Instant,
    pub keyframe: bool,
    /// Received VP8 descriptor facts; absent when the producer has none.
    pub vp8: Option<vp8::Vp8FrameMetadata>,
}

pub(crate) const RTP_PACKETS: usize = 256;
// One directed flow owns each kind; a publication can have several hop flows.
pub(crate) type TrackKey = (Uuid, MediaKind);
#[derive(Clone, Debug)]
pub(crate) struct SourceClockReport {
    pub ssrc: u32,
    /// Source NTP timestamp in 32.32 fixed-point format.
    pub ntp_time: u64,
    pub rtp_time: u32,
}
pub(crate) type SourceReport = Arc<Mutex<Option<(SourceClockReport, Instant)>>>;

#[derive(Clone, Default)]
pub(crate) struct OutputStreams(Arc<Mutex<HashMap<u32, OutputStream>>>);

pub(crate) struct OutputStream {
    report: SourceReport,
    clock: Option<clock::SourceTime>,
}

fn fmtp<'a>(codec: &'a RtpCodec, name: &str) -> Option<&'a str> {
    codec.sdp_fmtp_line.split(';').find_map(|field| {
        let (key, value) = field.trim().split_once('=')?;
        key.eq_ignore_ascii_case(name).then_some(value.trim())
    })
}
pub(crate) fn supported(codec: &RtpCodec, kind: MediaKind) -> bool {
    match kind {
        MediaKind::Audio => {
            codec.mime_type.eq_ignore_ascii_case("audio/opus") && codec.clock_rate == 48000
        }
        MediaKind::Video if codec.clock_rate == 90000 => {
            codec.mime_type.eq_ignore_ascii_case("video/VP8")
                || (codec.mime_type.eq_ignore_ascii_case("video/H264")
                    && fmtp(codec, "packetization-mode") == Some("1")
                    && h264_level(codec).is_some())
        }
        _ => false,
    }
}
pub(crate) fn h264_codecs() -> &'static str0m::format::CodecConfig {
    use str0m::format::CodecConfig;
    static CODECS: OnceLock<CodecConfig> = OnceLock::new();
    CODECS.get_or_init(|| {
        let mut defaults = CodecConfig::empty();
        defaults.enable_h264(true);
        // The existing AU packetizer uses non-interleaved mode. Keep the SDK's
        // profile definitions and matching, without advertising single-NAL mode.
        let mut codecs = CodecConfig::new_from_payload_params(
            defaults
                .params()
                .iter()
                .filter(|params| params.spec().format.packetization_mode == Some(1))
                .cloned()
                .collect(),
        );
        // Browser capabilities can expose Constrained High independently of High.
        codecs.add_h264(112.into(), Some(113.into()), true, 0x640c1f);
        codecs
    })
}
fn h264_format(codec: &RtpCodec) -> Option<(u32, u32)> {
    use str0m::{
        format::{Codec, CodecSpec, FormatParams, PayloadParams},
        media::Frequency,
    };
    if fmtp(codec, "packetization-mode") != Some("1") {
        return None;
    }
    let value = fmtp(codec, "profile-level-id").unwrap_or("42e01f");
    if value.len() != 6 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(value, 16).ok()?;
    if !matches!(value as u8, 10..=13 | 20..=22 | 30..=32 | 40..=42 | 50..=52 | 60..=62) {
        return None;
    }
    let params = PayloadParams::new(
        0.into(),
        None,
        CodecSpec {
            codec: Codec::H264,
            clock_rate: Frequency::NINETY_KHZ,
            channels: None,
            format: FormatParams {
                packetization_mode: Some(1),
                // Match the profile independently of the advertised level. The
                // SDK's level enum stops at 5.2; a stronger advertisement is not
                // an invalid profile. Actual SPS admission keeps the real level.
                profile_level_id: Some((value & 0xffff00) | 0x1f),
                ..Default::default()
            },
        },
    );
    let profile = h264_codecs()
        .match_params(params)?
        .spec()
        .format
        .profile_level_id?;
    Some((value, profile))
}
fn h264_level(codec: &RtpCodec) -> Option<u8> {
    h264_format(codec).map(|(value, _)| value as u8)
}
pub(crate) fn compatible(source: &RtpCodec, negotiated: &RtpCodec) -> bool {
    if !source.mime_type.eq_ignore_ascii_case(&negotiated.mime_type)
        || source.clock_rate != negotiated.clock_rate
    {
        return false;
    }
    if source.mime_type.eq_ignore_ascii_case("video/H264") {
        return source.clock_rate == 90_000
            && h264_format(source)
                .zip(h264_format(negotiated))
                .is_some_and(|((_, source), (_, negotiated))| source == negotiated);
    }
    true
}

#[derive(Debug)]
pub(crate) struct UnsupportedH264Format(pub [u8; 3]);
impl std::fmt::Display for UnsupportedH264Format {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let [profile, constraints, level] = self.0;
        write!(
            formatter,
            "unsupported H264 SPS profile/level {profile:02x}{constraints:02x}{level:02x}"
        )
    }
}
impl std::error::Error for UnsupportedH264Format {}

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
        if !h264_level(&RtpCodec::h264(bytes)).is_some_and(|level| level <= 52) {
            return Err(UnsupportedH264Format(bytes).into());
        }
        self.last = Some(bytes);
        Ok(())
    }
    pub fn codec(&self) -> Option<RtpCodec> {
        self.last.map(RtpCodec::h264)
    }
}

#[derive(Clone)]
pub(crate) enum SourceOrigin {
    Incoming {
        pair: Uuid,
        flow_id: Uuid,
        stream: String,
        reader: Uuid,
    },
    #[cfg(any(feature = "capture", test))]
    Local,
}
#[derive(Clone)]
pub(crate) enum SourceFeed {
    Rtp {
        codec: RtpCodec,
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
    pub kind: MediaKind,
    pub feed: SourceFeed,
    pub layers: Option<video::Layers>,
}
impl Source {
    pub fn codec(&self) -> &RtpCodec {
        match &self.feed {
            SourceFeed::Rtp { codec, .. } => codec,
            SourceFeed::Video(video) => video
                .codec()
                .expect("source admitted without a video format"),
        }
    }
    pub fn video(&self) -> Option<&video::Video> {
        match &self.feed {
            SourceFeed::Video(video) => Some(video),
            _ => None,
        }
    }
    pub fn matches(&self, flow: &piik_channel_core::wire::FlowBinding, kind: MediaKind) -> bool {
        self.publication_id == flow.publication_id
            && self.kind == kind
            && match &self.origin {
                SourceOrigin::Incoming { flow_id, .. } => flow.input_flow_id == Some(*flow_id),
                #[cfg(any(feature = "capture", test))]
                SourceOrigin::Local => flow.input_flow_id.is_none(),
            }
    }
    pub fn request_keyframe(&self) {
        if self.kind == MediaKind::Video {
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
    fn observing(&mut self, active: bool, now: Instant) {
        if active {
            self.start.get_or_insert(now);
        } else {
            // Keep the ordinary observation window: a partial IDR burst is
            // not a sustainable rate. Preserve the last complete sample.
            self.sample_bins(now);
            self.start = None;
            self.bytes = self.bytes.map(|bytes| bytes.map(|_| 0));
        }
    }
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
        let Some(start) = self.start else {
            return self.bps;
        };
        let elapsed = now.duration_since(start);
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
    fn sleeping_rate_keeps_complete_cost_without_inflating_a_partial_idr() {
        let start = Instant::now();
        let mut rate = Rate::default();
        rate.observe(start, 1000);
        assert_eq!(rate.sample(start + Duration::from_secs(1)), Some(8000));
        rate.observe(start + Duration::from_millis(1001), 125_000);
        rate.observing(false, start + Duration::from_millis(1005));
        assert_eq!(rate.sample(start + Duration::from_secs(60)), Some(8000));
        rate.observing(true, start + Duration::from_secs(60));
        rate.observe(start + Duration::from_secs(60), 2000);
        assert_eq!(rate.sample(start + Duration::from_secs(61)), Some(16_000));
        assert_eq!(rate.sample(start + Duration::from_secs(62)), Some(0));
        let mut unknown = Rate::default();
        unknown.observe(start, 125_000);
        unknown.observing(false, start + Duration::from_millis(5));
        assert_eq!(unknown.sample(start + Duration::from_secs(60)), None);
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
    fn h264_checks_actual_sps_without_retaining_a_historical_level_ceiling() -> Result<()> {
        let codec = |profile: &str| RtpCodec {
            mime_type: "video/H264".into(),
            clock_rate: 90000,
            sdp_fmtp_line: format!("packetization-mode=1;profile-level-id={profile}"),
            ..Default::default()
        };
        assert!(compatible(&codec("42c028"), &codec("42e01f")));
        assert!(compatible(&codec("42f00b"), &codec("42c01f")));
        assert!(!compatible(&codec("42c028"), &codec("42001f")));
        for profile in ["42E01F", "4d801f", "58c01f"] {
            assert!(supported(&codec(profile), MediaKind::Video));
            assert!(compatible(&codec(profile), &codec("42e01f")));
        }
        let default = RtpCodec {
            sdp_fmtp_line: "packetization-mode=1".into(),
            ..codec("42e01f")
        };
        assert!(compatible(&default, &codec("58c01f")));
        for profile in ["42e01", "42e01ff", "42e0zz", "42e009", "42e00e"] {
            assert!(!supported(&codec(profile), MediaKind::Video));
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
        for profile in [[0x4d, 0, 0x1f], [0x64, 0, 0x28], [0x64, 0x0c, 0x28]] {
            sps.access_unit(&[0, 0, 1, 0x67, profile[0], profile[1], profile[2]])?;
            let actual = RtpCodec::h264(profile);
            assert!(supported(&actual, MediaKind::Video));
            assert!(compatible(&actual, &actual));
            assert!(!compatible(&actual, &codec("42e01f")));
        }
        assert!(sps.access_unit(&[0, 0, 1, 0x67, 0x6e, 0, 0x28]).is_err());
        assert!(sps.access_unit(&[0, 0, 1, 0x67, 0x42, 0xe0, 0]).is_err());
        Ok(())
    }
}
