//! Bounded complete access units, shared by every child of an incoming source.
#[cfg(test)]
use super::SourceReport;
use super::{
    clock::SourceTime,
    video::Video,
    vp8::{Vp8Frame, Vp8FrameMetadata},
    H264Sps,
};
use crate::EncodedFrame;
use anyhow::{ensure, Result};
use rtc::{
    media::io::h26x_reader::{H264NalUnitType, H26xNAL, H26xReader},
    rtp::{codec::h264::H264Packet, packetizer::Depacketizer, Packet},
};
#[cfg(test)]
use std::time::Instant;
use std::{collections::BTreeMap, marker::PhantomData, sync::Arc};
use tokio::sync::Notify;

// Bound assembled AU bytes independently from the packet reordering window.
const MAX_AU: usize = 4 * 1024 * 1024;
const PACKET_WINDOW: u64 = 4096;
const MEDIA_WINDOW: u64 = 90_000;
// VP8 descriptors use at most six bytes per packet; H264 overhead is smaller.
const MAX_PACKET_DESCRIPTOR: usize = 6;

struct Fragment {
    time: u64,
    packet: Packet,
}
struct AccessUnit<D> {
    packets: BTreeMap<u64, Fragment>,
    next: Option<(u64, u64)>,
    latest_time: u64,
    discontinuity: bool,
    codec: PhantomData<D>,
}
struct Complete {
    data: Vec<u8>,
    timestamp: u32,
    metadata: Option<Vp8FrameMetadata>,
    discontinuity: bool,
}
trait AuCodec: Depacketizer + Default {
    fn metadata(&self) -> Option<Vp8FrameMetadata> {
        None
    }
}
impl AuCodec for H264Packet {}
impl AuCodec for Vp8Frame {
    fn metadata(&self) -> Option<Vp8FrameMetadata> {
        Some(Vp8Frame::metadata(self))
    }
}
impl<D: AuCodec> AccessUnit<D> {
    fn new() -> Self {
        Self {
            packets: BTreeMap::new(),
            next: None,
            latest_time: 0,
            discontinuity: false,
            codec: PhantomData,
        }
    }
    fn push(&mut self, sequence: u64, time: u64, packet: Packet) {
        if self.next.is_some_and(|(next, _)| sequence < next) {
            return;
        }
        if !packet.payload.is_empty() {
            self.latest_time = self.latest_time.max(time);
        }
        self.packets
            .entry(sequence)
            .or_insert(Fragment { time, packet });
    }
    fn expired(&self, sequence: u64, time: u64) -> bool {
        self.packets.last_key_value().is_some_and(|(&last, _)| {
            last.saturating_sub(sequence) >= PACKET_WINDOW
                || self.latest_time.saturating_sub(time) >= MEDIA_WINDOW
        })
    }
    fn pop(&mut self) -> Result<Option<Complete>> {
        loop {
            let Some((&first, initial)) = self
                .packets
                .iter()
                .find(|(_, f)| !f.packet.payload.is_empty())
            else {
                // After a committed AU, known padding advances continuity without advancing media time.
                if let Some((mut next, time)) = self.next {
                    for (&sequence, _) in self.packets.range(next..) {
                        if sequence != next {
                            break;
                        }
                        next += 1;
                    }
                    self.next = Some((next, time));
                    self.packets = self.packets.split_off(&next);
                }
                // Before the first head, padding cannot establish a rejection floor.
                if let Some((&last, _)) = self.packets.last_key_value() {
                    self.packets = self
                        .packets
                        .split_off(&last.saturating_sub(PACKET_WINDOW - 1));
                }
                return Ok(None);
            };
            let (start, age) = self.next.unwrap_or((first, initial.time));
            let mut expected = start;
            let mut head = None;
            let mut end = None;
            let mut payload_bytes = 0;
            let mut media_packets = 0;
            for (&sequence, fragment) in self.packets.range(start..) {
                if sequence != expected || sequence.saturating_sub(start) >= PACKET_WINDOW {
                    break;
                }
                expected += 1;
                if fragment.packet.payload.is_empty() {
                    continue;
                }
                if let Some((_, time)) = head {
                    if fragment.time != time {
                        break;
                    }
                } else {
                    if !D::default().is_partition_head(&fragment.packet.payload) {
                        break;
                    }
                    head = Some((sequence, fragment.time));
                }
                media_packets += 1;
                payload_bytes += fragment.packet.payload.len();
                ensure!(
                    payload_bytes <= MAX_AU + media_packets * MAX_PACKET_DESCRIPTOR,
                    "access unit exceeds Native media limit"
                );
                if fragment.packet.header.marker {
                    end = Some(sequence);
                    break;
                }
            }
            if let (Some((head_sequence, time)), Some(end)) = (head, end) {
                let timestamp = self.packets[&head_sequence].packet.header.timestamp;
                let mut decoder = D::default();
                let mut metadata = None;
                let mut malformed = false;
                let mut data = Vec::new();
                for (&sequence, fragment) in self.packets.range(head_sequence..=end) {
                    if fragment.packet.payload.is_empty() {
                        continue;
                    }
                    let Ok(bytes) = decoder.depacketize(&fragment.packet.payload) else {
                        malformed = true;
                        break;
                    };
                    ensure!(
                        bytes.len() <= MAX_AU - data.len(),
                        "access unit exceeds Native media limit"
                    );
                    data.extend_from_slice(&bytes);
                    if sequence == head_sequence {
                        metadata = decoder.metadata();
                    }
                }
                self.packets = self.packets.split_off(&(end + 1));
                self.next = Some((end + 1, time));
                if malformed {
                    self.discontinuity = true;
                    continue;
                }
                return Ok(Some(Complete {
                    data,
                    timestamp,
                    metadata,
                    discontinuity: std::mem::take(&mut self.discontinuity),
                }));
            }
            let time = head.map_or(age, |(_, time)| time);
            if !self.expired(start, time) {
                return Ok(None);
            }
            // Retire only the blocked AU/prefix. A later complete AU remains in this same drain.
            let successor = self
                .packets
                .range((start + 1)..)
                .find(|(_, f)| {
                    !f.packet.payload.is_empty()
                        && f.time != time
                        && D::default().is_partition_head(&f.packet.payload)
                })
                .map(|(&sequence, _)| sequence);
            let cutoff = successor.unwrap_or_else(|| {
                if let Some((&future, _)) =
                    self.packets.range((start + 1)..).find(|(&sequence, f)| {
                        !f.packet.payload.is_empty()
                            && f.time != time
                            && !self.expired(sequence, f.time)
                    })
                {
                    // The future AU has no head yet. Retire the old prefix while
                    // leaving its preceding gap available for that head's repair.
                    let after_old = self
                        .packets
                        .range(start..future)
                        .rev()
                        .find(|(_, f)| !f.packet.payload.is_empty() && f.time == time)
                        .map_or(start, |(&sequence, _)| sequence + 1);
                    let span_floor = self
                        .packets
                        .last_key_value()
                        .unwrap()
                        .0
                        .saturating_sub(PACKET_WINDOW - 1);
                    after_old.max(span_floor)
                } else {
                    self.packets.last_key_value().unwrap().0 + 1
                }
            });
            let remaining = self.packets.split_off(&cutoff);
            self.discontinuity |=
                first > start || self.packets.values().any(|f| !f.packet.payload.is_empty());
            self.packets = remaining;
            self.next = Some((
                cutoff,
                self.packets
                    .values()
                    .find(|f| !f.packet.payload.is_empty())
                    .map_or(self.latest_time, |f| f.time),
            ));
        }
    }
}

pub(crate) struct H264 {
    pub video: Video,
    builder: AccessUnit<H264Packet>,
    sps: H264Sps,
    parameters: [Vec<u8>; 2],
    waiting: bool,
}
impl H264 {
    #[cfg(test)]
    pub fn new(now: Instant, timestamp: u32, report: SourceReport) -> Self {
        Self::with_time(
            SourceTime::incoming(now, timestamp, report),
            Arc::new(Notify::new()),
        )
    }
    fn with_time(time: SourceTime, changed: Arc<Notify>) -> Self {
        Self {
            video: Video::new(time, changed),
            builder: AccessUnit::new(),
            sps: H264Sps::default(),
            parameters: Default::default(),
            waiting: true,
        }
    }
    pub fn push(&mut self, sequence: u64, time: u64, packet: Packet) {
        self.builder.push(sequence, time, packet);
    }
    pub fn pop(&mut self) -> Result<Option<EncodedFrame>> {
        while let Some(sample) = self.builder.pop()? {
            ensure!(
                sample.data.len() <= MAX_AU,
                "H264 access unit exceeds Native media limit"
            );
            self.sps.access_unit(&sample.data)?;
            let mut reader = H26xReader::new(&sample.data[..], 4096, false);
            let mut idr = false;
            while let Ok(H26xNAL::H264(nal)) = reader.next_nal() {
                match nal.unit_type {
                    H264NalUnitType::SPS => self.parameters[0] = nal.data.to_vec(),
                    H264NalUnitType::PPS => self.parameters[1] = nal.data.to_vec(),
                    H264NalUnitType::CodedSliceIdr => idr = true,
                    _ => {}
                }
            }
            let keyframe = idr && self.parameters.iter().all(|p| !p.is_empty());
            if sample.discontinuity && !keyframe {
                self.waiting = true;
                self.video.request_keyframe();
            }
            if self.waiting && !keyframe {
                continue;
            }
            self.waiting = false;
            let mut bytes = Vec::new();
            // A Browser may send parameter sets before its IDR. Every independent
            // handoff/decoder start needs the current sets with the same IDR.
            if keyframe {
                for p in &self.parameters {
                    bytes.extend_from_slice(&[0, 0, 0, 1]);
                    bytes.extend_from_slice(p);
                }
            }
            bytes.extend_from_slice(&sample.data);
            ensure!(
                bytes.len() <= MAX_AU,
                "H264 access unit exceeds Native media limit"
            );
            return Ok(Some(EncodedFrame {
                bytes,
                presentation_time: self.video.time().presentation(sample.timestamp),
                keyframe,
                vp8: None,
            }));
        }
        Ok(None)
    }
}

pub(crate) enum Incoming {
    H264(H264),
    Vp8(Vp8),
}
impl Incoming {
    pub fn supports(mime: &str) -> bool {
        mime.eq_ignore_ascii_case("video/H264") || mime.eq_ignore_ascii_case("video/VP8")
    }
    pub fn with_time(mime: &str, time: SourceTime, changed: Arc<Notify>) -> Self {
        if mime.eq_ignore_ascii_case("video/VP8") {
            Self::Vp8(Vp8::with_time(time, changed))
        } else {
            Self::H264(H264::with_time(time, changed))
        }
    }
    pub fn video(&self) -> &Video {
        match self {
            Self::H264(input) => &input.video,
            Self::Vp8(input) => &input.video,
        }
    }
    pub fn push(&mut self, sequence: u64, time: u64, packet: Packet) {
        match self {
            Self::H264(input) => input.push(sequence, time, packet),
            Self::Vp8(input) => input.push(sequence, time, packet),
        }
    }
    pub fn pop(&mut self) -> Result<Option<EncodedFrame>> {
        match self {
            Self::H264(input) => input.pop(),
            Self::Vp8(input) => input.pop(),
        }
    }
}

pub(crate) struct Vp8 {
    video: Video,
    builder: AccessUnit<Vp8Frame>,
    waiting: bool,
}
impl Vp8 {
    #[cfg(test)]
    fn new(now: Instant, timestamp: u32, report: SourceReport) -> Self {
        Self::with_time(
            SourceTime::incoming(now, timestamp, report),
            Arc::new(Notify::new()),
        )
    }
    fn with_time(time: SourceTime, changed: Arc<Notify>) -> Self {
        Self {
            video: Video::new(time, changed),
            builder: AccessUnit::new(),
            waiting: true,
        }
    }
    fn push(&mut self, sequence: u64, time: u64, packet: Packet) {
        self.builder.push(sequence, time, packet);
    }
    fn pop(&mut self) -> Result<Option<EncodedFrame>> {
        while let Some(sample) = self.builder.pop()? {
            ensure!(
                sample.data.len() <= MAX_AU,
                "VP8 frame exceeds Native media limit"
            );
            let Some(first) = sample.data.first() else {
                continue;
            };
            let keyframe = first & 1 == 0;
            if sample.discontinuity && !keyframe {
                self.waiting = true;
                self.video.request_keyframe();
            }
            if self.waiting && !keyframe {
                continue;
            }
            self.waiting = false;
            return Ok(Some(EncodedFrame {
                bytes: sample.data,
                presentation_time: self.video.time().presentation(sample.timestamp),
                keyframe,
                vp8: sample.metadata,
            }));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rtc::rtp::{codec::h264::H264Payloader, packetizer::Payloader, Header};
    use std::{sync::Mutex, time::Duration};

    #[test]
    fn completed_idr_after_loss_does_not_request_another_keyframe() -> Result<()> {
        for independent in [true, false] {
            let now = Instant::now();
            let mut input = H264::new(now, 0, Arc::new(Mutex::new(None)));
            let requests = input.video.requests();
            let mut payloader = H264Payloader::default();
            let mut sequence = 1;
            let key = [
                vec![
                    0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 0x11, 0, 0, 0, 1, 0x68, 0x22, 0x33, 0, 0,
                    0, 1, 0x65,
                ],
                vec![0x44; 700],
            ]
            .concat();
            for (timestamp, bytes, missing_tail) in [
                (0, key.clone(), false),
                (
                    3_000,
                    [vec![0, 0, 0, 1, 0x61], vec![0x55; 700]].concat(),
                    true,
                ),
                (
                    93_001,
                    if independent {
                        key.clone()
                    } else {
                        [vec![0, 0, 0, 1, 0x61], vec![0x66; 700]].concat()
                    },
                    false,
                ),
            ] {
                let payloads = payloader.payload(200, &bytes.into())?;
                assert!(
                    payloads.len() > 2,
                    "fixture must use actual FU fragmentation"
                );
                let last = payloads.len() - 1;
                for (index, payload) in payloads.into_iter().enumerate() {
                    let packet = Packet {
                        header: Header {
                            sequence_number: sequence,
                            timestamp,
                            marker: index == last,
                            ..Default::default()
                        },
                        payload,
                    };
                    sequence += 1;
                    if missing_tail && index == last {
                        continue;
                    }
                    input.push(
                        packet.header.sequence_number.into(),
                        timestamp.into(),
                        packet,
                    );
                }
                let frame = input.pop()?;
                match timestamp {
                    0 => {
                        assert!(frame.is_some_and(|frame| frame.keyframe));
                    }
                    3_000 => {
                        assert!(frame.is_none());
                    }
                    _ => {
                        if independent {
                            let frame = frame.expect("independent successor recovers immediately");
                            assert!(frame.keyframe);
                            assert_eq!(
                                frame.presentation_time,
                                now + Duration::from_nanos(93_001 * 1_000_000_000 / 90_000)
                            );
                            assert_eq!(
                                *requests.borrow(),
                                0,
                                "the recovered IDR needs no redundant PLI"
                            );
                        } else {
                            assert!(
                                frame.is_none(),
                                "dependent successor must wait for recovery"
                            );
                            assert!(input.waiting);
                            assert_eq!(
                                *requests.borrow(),
                                1,
                                "loss still requests independent recovery"
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod vp8_tests {
    use super::*;
    use rtc::rtp::{codec::vp8::Vp8Payloader, packetizer::Payloader, Header};

    #[test]
    fn complete_frames_keep_partitions_and_recover_after_missing_head_or_tail() -> Result<()> {
        for missing_head in [true, false] {
            let now = Instant::now();
            let mut input = Vp8::new(now, 0, Default::default());
            let requests = input.video.requests();
            let mut payloader = Vp8Payloader::default();
            let mut sequence = 0;
            for (timestamp, keyframe, loss) in [
                (0, true, false),
                (3000, false, true),
                (93001, false, false),
                (96001, true, false),
            ] {
                let bytes = [vec![if keyframe { 0 } else { 1 }], vec![0x55; 700]].concat();
                let payloads = payloader.payload(200, &bytes.clone().into())?;
                let last = payloads.len() - 1;
                for (index, payload) in payloads.into_iter().enumerate() {
                    let mut descriptor = payload.to_vec();
                    if index == 1 {
                        descriptor[0] |= 0x11;
                    } // S=1, PID=1 is not a frame head.
                    let packet = Packet {
                        header: Header {
                            sequence_number: sequence,
                            timestamp,
                            marker: index == last,
                            ..Default::default()
                        },
                        payload: descriptor.into(),
                    };
                    sequence += 1;
                    if loss && index == if missing_head { 0 } else { last } {
                        continue;
                    }
                    input.push(
                        packet.header.sequence_number.into(),
                        timestamp.into(),
                        packet,
                    );
                }
                let frame = input.pop()?;
                match timestamp {
                    0 | 96001 => {
                        let frame = frame.expect("complete keyframe recovers");
                        assert!(frame.keyframe);
                        assert_eq!(frame.bytes, bytes);
                    }
                    _ => assert!(
                        frame.is_none(),
                        "incomplete/dependent frame cannot escape recovery"
                    ),
                }
            }
            assert!(*requests.borrow() > 0, "loss requests an independent frame");
        }
        Ok(())
    }
}

#[cfg(test)]
mod partition_head_test {
    use super::*;
    use rtc::rtp::Header;

    #[test]
    fn partition_one_cannot_start_an_independent_frame() -> Result<()> {
        let now = Instant::now();
        let mut input = Vp8::new(now, 0, Default::default());
        // The payload happens to begin with an intra-frame tag. Without PID=0
        // this is still only the tail of an unknown frame, not a keyframe.
        input.push(
            1,
            0,
            Packet {
                header: Header {
                    sequence_number: 1,
                    marker: true,
                    ..Default::default()
                },
                payload: vec![0x11, 0, 0x55, 0x55].into(),
            },
        );
        assert!(input.pop()?.is_none());
        input.push(
            2,
            93_001,
            Packet {
                header: Header {
                    sequence_number: 2,
                    timestamp: 93_001,
                    marker: true,
                    ..Default::default()
                },
                payload: vec![0x10, 0, 0x66, 0x66].into(),
            },
        );
        let frame = input
            .pop()?
            .expect("partition-zero keyframe recovers after the reorder window");
        assert!(frame.keyframe);
        assert_eq!(frame.bytes, vec![0, 0x66, 0x66]);
        Ok(())
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;
    use rtc::rtp::Header;

    fn packet(sequence: u64, timestamp: u32, marker: bool, payload: &[u8]) -> Packet {
        Packet {
            header: Header {
                sequence_number: sequence as u16,
                timestamp,
                marker,
                padding: payload.is_empty(),
                ..Default::default()
            },
            payload: payload.to_vec().into(),
        }
    }
    #[test]
    fn reordered_final_frame_and_padding_keep_the_media_head() -> Result<()> {
        let mut window = AccessUnit::<Vp8Frame>::new();
        // Padding and marker tail arrive before the head, across raw sequence rollover.
        window.push(65_536, u64::MAX, packet(65_536, u32::MAX, true, &[]));
        window.push(
            65_537,
            1 << 32,
            packet(65_537, 0, true, &[0, 0x55, 0x55, 0x55]),
        );
        assert!(window.pop()?.is_none());
        window.push(
            65_535,
            1 << 32,
            packet(65_535, 0, false, &[0x30, 0, 0x44, 0x44]),
        );
        let frame = window
            .pop()?
            .expect("head repair completes the final AU without a successor");
        assert_eq!(frame.data, [0, 0x44, 0x44, 0x55, 0x55, 0x55]);
        assert!(frame.metadata.unwrap().non_reference);
        assert!(!frame.discontinuity);
        assert_eq!(frame.timestamp, 0);
        assert!(window.pop()?.is_none());
        Ok(())
    }
    #[test]
    fn missing_sequence_waits_for_span_or_advancing_media_not_padding_time() -> Result<()> {
        for by_time in [false, true] {
            let mut window = AccessUnit::<Vp8Frame>::new();
            window.push(10, 0, packet(10, 0, true, &[0x10, 0, 1, 1]));
            assert!(window.pop()?.is_some());
            window.push(12, 1, packet(12, 1, true, &[0x10, 0, 2, 2]));
            window.push(13, u64::MAX, packet(13, u32::MAX, true, &[]));
            assert!(
                window.pop()?.is_none(),
                "padding cannot age a missing sequence"
            );
            if by_time {
                window.push(
                    14,
                    MEDIA_WINDOW,
                    packet(14, MEDIA_WINDOW as u32, true, &[0x10, 0, 3, 3]),
                );
            } else {
                window.push(
                    11 + PACKET_WINDOW,
                    u64::MAX,
                    packet(11 + PACKET_WINDOW, u32::MAX, true, &[]),
                );
            }
            let ready = window
                .pop()?
                .expect("expiry drains the retained complete successor");
            assert_eq!(ready.data, [0, 2, 2]);
            assert!(ready.discontinuity);
        }
        Ok(())
    }
    #[test]
    fn expired_h264_prefix_does_not_restart_at_another_nal_in_that_au() -> Result<()> {
        let mut window = AccessUnit::<H264Packet>::new();
        window.push(1, 0, packet(1, 0, false, &[0x61, 1]));
        window.push(3, 0, packet(3, 0, true, &[0x61, 2]));
        assert!(window.pop()?.is_none());
        window.push(
            4,
            MEDIA_WINDOW,
            packet(4, MEDIA_WINDOW as u32, true, &[0x65, 3, 4]),
        );
        let ready = window
            .pop()?
            .expect("new AU survives retired incomplete prefix");
        assert_eq!(ready.timestamp, MEDIA_WINDOW as u32);
        assert_eq!(ready.data, [0, 0, 0, 1, 0x65, 3, 4]);
        assert!(ready.discontinuity);
        Ok(())
    }
    #[test]
    fn malformed_au_is_retired_without_ending_the_source() -> Result<()> {
        let mut window = AccessUnit::<H264Packet>::new();
        // STAP-A has a complete NAL followed by a truncated two-byte length.
        window.push(1, 0, packet(1, 0, true, &[0x78, 0, 2, 0x61, 1, 0]));
        window.push(2, 3_000, packet(2, 3_000, true, &[0x65, 2, 3]));
        let ready = window
            .pop()?
            .expect("a malformed AU does not terminate the reader");
        assert_eq!(ready.timestamp, 3_000);
        assert!(ready.discontinuity);
        Ok(())
    }
    #[test]
    fn padding_cannot_poison_expiry_when_retiring_a_headless_prefix() -> Result<()> {
        let mut window = AccessUnit::<Vp8Frame>::new();
        window.push(1, 0, packet(1, 0, true, &[0, 1, 1, 1]));
        window.push(2, u64::MAX, packet(2, u32::MAX, true, &[]));
        window.push(
            3,
            MEDIA_WINDOW,
            packet(3, MEDIA_WINDOW as u32, true, &[0, 2, 2, 2]),
        );
        assert!(window.pop()?.is_none());
        window.push(
            4,
            MEDIA_WINDOW * 2,
            packet(4, (MEDIA_WINDOW * 2) as u32, true, &[0x10, 0, 3, 3]),
        );
        let ready = window
            .pop()?
            .expect("media time still expires the headless prefix");
        assert_eq!(ready.timestamp, (MEDIA_WINDOW * 2) as u32);
        assert!(ready.discontinuity);
        Ok(())
    }
    #[test]
    fn retiring_old_prefix_leaves_the_future_aus_head_repairable() -> Result<()> {
        let mut window = AccessUnit::<Vp8Frame>::new();
        window.push(1, 0, packet(1, 0, true, &[0, 1, 1, 1]));
        window.push(
            3,
            MEDIA_WINDOW,
            packet(3, MEDIA_WINDOW as u32, true, &[0, 2, 2, 2]),
        );
        assert!(window.pop()?.is_none());
        window.push(
            2,
            MEDIA_WINDOW,
            packet(2, MEDIA_WINDOW as u32, false, &[0x10, 0, 3, 3]),
        );
        let ready = window
            .pop()?
            .expect("future head is still admitted after old-prefix expiry");
        assert_eq!(ready.data, [0, 3, 3, 2, 2, 2]);
        assert!(ready.discontinuity);
        Ok(())
    }
    #[test]
    fn contiguous_padding_after_committed_media_does_not_invent_loss() -> Result<()> {
        let mut window = AccessUnit::<Vp8Frame>::new();
        window.push(1, 0, packet(1, 0, true, &[0x10, 0, 1, 1]));
        assert!(window.pop()?.is_some());
        for sequence in 2..=PACKET_WINDOW + 2 {
            window.push(sequence, u64::MAX, packet(sequence, u32::MAX, true, &[]));
            assert!(window.pop()?.is_none());
        }
        let sequence = PACKET_WINDOW + 3;
        window.push(
            sequence,
            3_000,
            packet(sequence, 3_000, true, &[0x10, 1, 2, 2]),
        );
        let ready = window
            .pop()?
            .expect("known padding bridges to the next dependent AU");
        assert!(!ready.discontinuity);
        assert_eq!(ready.data, [1, 2, 2]);
        Ok(())
    }
    #[test]
    fn access_unit_size_is_checked_before_depacketization_growth() {
        let mut window = AccessUnit::<Vp8Frame>::new();
        let mut head = vec![0; MAX_AU / 2 + 1];
        head[0] = 0x10;
        let tail = vec![0; MAX_AU / 2 + 1];
        window.push(1, 0, packet(1, 0, false, &head));
        window.push(2, 0, packet(2, 0, true, &tail));
        assert_eq!(window.pop().unwrap().unwrap().data.len(), MAX_AU);
        let mut window = AccessUnit::<Vp8Frame>::new();
        let mut oversized = vec![0; MAX_AU + 2];
        oversized[0] = 0x10;
        window.push(1, 0, packet(1, 0, true, &oversized));
        assert!(window.pop().is_err());
    }
}
