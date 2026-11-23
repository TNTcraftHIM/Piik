mod vp8;

use super::{
    clock::SourceTime, video::Video, vp8::Vp8FrameMetadata, EncodedFrame, SourceClockReport,
    SourceReport,
};
use crate::media::RtpCodec;
use anyhow::{ensure, Result};
use bytes::Bytes;
use rtc_rtp::{
    packetizer::{new_packetizer, Packetizer as RtpPacketizer},
    sequence::new_random_sequencer,
    Packet,
};
use std::{sync::Arc, time::Instant};

struct SharedFrame(Arc<EncodedFrame>);

impl AsRef<[u8]> for SharedFrame {
    fn as_ref(&self) -> &[u8] {
        &self.0.bytes
    }
}

/// A stable sender's RTP timeline and its original capture-time correlation.
pub(crate) struct Packetizer {
    inner: Box<dyn RtpPacketizer>,
    vp8: Option<vp8::Descriptor>,
    ssrc: u32,
    clock_rate: u32,
    time: SourceTime,
    previous_ticks: i128,
    source: Option<Video>,
    offset: i128,
    report: SourceReport,
}
impl Packetizer {
    pub fn new(
        codec: &RtpCodec,
        payload_type: u8,
        ssrc: u32,
        time: SourceTime,
        report: SourceReport,
    ) -> Result<Self> {
        let vp8 = codec.mime_type.eq_ignore_ascii_case("video/VP8");
        let payloader: Box<dyn rtc_rtp::packetizer::Payloader> = if vp8 {
            let mut payloader = rtc_rtp::codec::vp8::Vp8Payloader::default();
            payloader.enable_picture_id = true;
            Box::new(payloader)
        } else if codec.mime_type.eq_ignore_ascii_case("video/H264") {
            Box::<rtc_rtp::codec::h264::H264Payloader>::default()
        } else if codec.mime_type.eq_ignore_ascii_case("audio/opus") {
            Box::<rtc_rtp::codec::opus::OpusPayloader>::default()
        } else {
            return Err(rtc_shared::error::Error::ErrNoPayloaderForCodec.into());
        };
        Ok(Self {
            inner: Box::new(new_packetizer(
                time.epoch,
                // The rewritten VP8 descriptor can add TL0 and T/K bytes.
                1200 - if vp8 { vp8::DESCRIPTOR_GROWTH } else { 0 },
                payload_type,
                ssrc,
                payloader,
                Box::new(new_random_sequencer()),
                codec.clock_rate,
            )),
            vp8: vp8.then(vp8::Descriptor::default),
            ssrc,
            clock_rate: codec.clock_rate,
            time,
            previous_ticks: 0,
            source: None,
            offset: 0,
            report,
        })
    }

    fn source_ticks(&self, presentation_time: Instant) -> i128 {
        super::clock::signed_nanos(presentation_time, self.time.epoch) * i128::from(self.clock_rate)
            / 1_000_000_000
    }

    pub fn packetize_source(
        &mut self,
        video: &Video,
        frame: &Arc<EncodedFrame>,
    ) -> Result<Vec<Packet>> {
        if self
            .source
            .as_ref()
            .is_none_or(|current| !current.same(video))
        {
            self.offset = if self.source.is_some() {
                (self.previous_ticks + 1 - self.source_ticks(frame.presentation_time)).max(0)
            } else {
                0
            };
            self.source = Some(video.clone());
        }
        // H264 can retain NAL slices in packets and in its parameter-set cache.
        let bytes = Bytes::from_owner(SharedFrame(Arc::clone(frame)));
        self.packetize(bytes, frame.presentation_time, frame.vp8)
    }

    pub fn packetize(
        &mut self,
        bytes: impl Into<Bytes>,
        presentation_time: Instant,
        metadata: Option<Vp8FrameMetadata>,
    ) -> Result<Vec<Packet>> {
        // Only the hop RTP timeline is translated on a source switch. Retain
        // the offset for this feed, preserving its subsequent frame intervals.
        let ticks = self.source_ticks(presentation_time) + self.offset;
        let bytes = bytes.into();
        ensure!(
            bytes.len() <= super::MAX_AU,
            "encoded video frame exceeds source limit"
        );
        self.packetize_ticks(&bytes, presentation_time, metadata, ticks)
    }

    /// Audio sample positions own RTP spacing; capture time still owns the SR.
    pub fn packetize_audio(
        &mut self,
        bytes: Vec<u8>,
        presentation_time: Instant,
        sample_position: u64,
    ) -> Result<Vec<Packet>> {
        self.packetize_ticks(
            &bytes.into(),
            presentation_time,
            None,
            i128::from(sample_position),
        )
    }

    fn packetize_ticks(
        &mut self,
        bytes: &Bytes,
        presentation_time: Instant,
        metadata: Option<Vp8FrameMetadata>,
        ticks: i128,
    ) -> Result<Vec<Packet>> {
        ensure!(!bytes.is_empty(), "source produced an empty encoded frame");
        let keyframe = bytes[0] & 1 == 0;
        // Advance before packetizing: irregular capture intervals and dropped raw
        // frames must not move the RTP clock onto the encoder's delivery cadence.
        self.inner
            .skip_samples((ticks - self.previous_ticks) as u32);
        self.previous_ticks = ticks;
        let mut packets = self.inner.packetize(Instant::now(), bytes, 0)?;
        if let Some(vp8) = &mut self.vp8 {
            vp8.rewrite(&mut packets, metadata, keyframe)?;
        }
        // The payloader may cache parameter sets or omit non-picture NALs.
        // No RTP was sent, so retain the last sender report correlation.
        let Some(first) = packets.first() else {
            return Ok(packets);
        };
        let timestamp = first.header.timestamp;
        *self.report.lock().unwrap() = Some((
            SourceClockReport {
                ssrc: self.ssrc,
                ntp_time: self.time.ntp(presentation_time).unwrap_or(0),
                rtp_time: timestamp,
            },
            presentation_time,
        ));
        Ok(packets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rtc_shared::time::SystemInstant;
    use std::time::Duration;

    #[test]
    fn early_layer_switch_preserves_frames_before_the_reference_epoch() -> Result<()> {
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let reference = Video::new(time.clone(), Default::default());
        let early = Video::new(time.clone(), Default::default());
        let mut sender = Packetizer::new(
            &RtpCodec::h264([0x42, 0xe0, 0x1f]),
            96,
            42,
            time,
            Default::default(),
        )?;
        let mut previous = None;
        let mut intervals = Vec::new();
        for (video, at) in [
            (&reference, epoch),
            (&early, epoch - Duration::from_micros(33_334)),
            (&early, epoch - Duration::from_micros(16_667)),
            (&early, epoch),
            (&early, epoch + Duration::from_millis(100)),
            // Resume on the same feed after a full 32-bit RTP clock cycle.
            (&early, epoch + Duration::from_millis(50_000_100)),
            (&early, epoch + Duration::from_millis(50_000_120)),
        ] {
            let frame = Arc::new(EncodedFrame {
                bytes: vec![0x65, 42, 0x80],
                presentation_time: at,
                keyframe: true,
                vp8: None,
            });
            let timestamp = sender.packetize_source(video, &frame)?[0].header.timestamp;
            if let Some(last) = previous {
                intervals.push(timestamp.wrapping_sub(last));
            }
            previous = Some(timestamp);
        }
        assert_eq!(
            intervals,
            [1, 1500, 1500, 9000, 4_500_000_000u64 as u32, 1800]
        );
        Ok(())
    }

    #[test]
    fn h264_packets_and_cached_parameter_sets_share_the_encoded_frame() -> Result<()> {
        let epoch = Instant::now();
        let time = SourceTime::local(epoch, SystemInstant::now(epoch));
        let video = Video::new(time.clone(), Default::default());
        let mut packetizer = Packetizer::new(
            &RtpCodec::h264([0x42, 0xc0, 0x1e]),
            96,
            42,
            time,
            Default::default(),
        )?;
        let frame = Arc::new(EncodedFrame {
            // An IDR followed by SPS/PPS cached until the next picture.
            bytes: vec![
                0, 0, 1, 0x65, 42, 0x80, 0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x68, 0xce,
            ],
            presentation_time: epoch,
            keyframe: true,
            vp8: None,
        });
        let source_frame = Arc::downgrade(&frame);
        let packets = packetizer.packetize_source(&video, &frame)?;
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].payload.as_ptr(), frame.bytes[3..].as_ptr());
        drop(frame);
        assert_eq!(&packets[0].payload[..], &[0x65, 42, 0x80]);
        drop(packets);
        assert!(source_frame.upgrade().is_some());

        let next = packetizer.packetize(
            vec![0x65, 24, 0x80],
            epoch + Duration::from_millis(16),
            None,
        )?;
        assert_eq!(
            &next[0].payload[..],
            &[0x78, 0, 2, 0x67, 0x42, 0, 2, 0x68, 0xce]
        );
        assert!(source_frame.upgrade().is_none());
        Ok(())
    }

    #[test]
    fn h264_metadata_preserves_sender_and_source_clock() -> Result<()> {
        let epoch = Instant::now();
        let report: SourceReport = Default::default();
        let mut packetizer = Packetizer::new(
            &RtpCodec {
                mime_type: "video/H264".into(),
                clock_rate: 90_000,
                ..Default::default()
            },
            96,
            42,
            SourceTime::local(epoch, SystemInstant::now(epoch)),
            report.clone(),
        )?;
        let picture = vec![0, 0, 0, 1, 0x65, 42, 0x80];
        let first = packetizer.packetize(picture.clone(), epoch, None)?;
        let last = first.last().unwrap();
        // Parameter sets from the controlled hardware capture fixture.
        let parameters = vec![
            0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 0x95, 0xa0, 0x28, 0x0b, 0xfe, 0x5c, 5, 0xa8, 8, 8,
            0x0a, 0, 0, 7, 0xd0, 0, 1, 0xd4, 0xc0, 0x1e, 0x38, 0x4d, 0x40, 0, 0, 0, 1, 0x68, 0xce,
            0x3c, 0x80,
        ];
        for (ms, bytes) in [
            (10, parameters),
            (20, vec![0, 0, 0, 1, 9, 0xf0]),
            (30, vec![0, 0, 0, 1, 12, 0xff, 0x80]),
        ] {
            assert!(packetizer
                .packetize(bytes, epoch + Duration::from_millis(ms), None)?
                .is_empty());
            let current = report.lock().unwrap();
            let (current, at) = current.as_ref().unwrap();
            assert_eq!(current.rtp_time, last.header.timestamp);
            assert_eq!(*at, epoch);
        }
        let next = packetizer.packetize(picture, epoch + Duration::from_millis(50), None)?;
        assert_eq!(
            next[0].header.sequence_number,
            last.header.sequence_number.wrapping_add(1)
        );
        assert_eq!(
            next[0].header.timestamp.wrapping_sub(last.header.timestamp),
            4500
        );
        assert_eq!(next[0].payload[0] & 0x1f, 24); // Cached SPS/PPS precede the slice.
        assert!(packetizer
            .packetize(vec![], epoch + Duration::from_millis(60), None)
            .is_err());
        assert!(packetizer
            .packetize(
                vec![0; crate::media::MAX_AU + 1],
                epoch + Duration::from_millis(60),
                None
            )
            .is_err());
        Ok(())
    }
}

#[cfg(test)]
mod vp8_tests {
    use super::*;
    use rtc_rtp::codec::vp8::Vp8Packet;
    use rtc_rtp::packetizer::Depacketizer;
    use rtc_shared::time::SystemInstant;
    use std::time::Duration;

    #[test]
    fn vp8_output_keeps_picture_id_across_complete_frames() -> Result<()> {
        let now = Instant::now();
        let mut output = Packetizer::new(
            &RtpCodec {
                mime_type: "video/VP8".into(),
                clock_rate: 90_000,
                ..Default::default()
            },
            96,
            42,
            SourceTime::local(now, SystemInstant::now(now)),
            Default::default(),
        )?;
        let mut previous = None;
        for index in 0..3 {
            let bytes = [vec![if index == 0 { 0 } else { 1 }], vec![0x55; 3000]].concat();
            let packets =
                output.packetize(bytes.clone(), now + Duration::from_millis(index * 50), None)?;
            assert!(packets.len() > 1);
            let mut assembled = Vec::new();
            let mut picture = None;
            for (part, p) in packets.iter().enumerate() {
                let mut descriptor = Vp8Packet::default();
                assembled.extend_from_slice(&descriptor.depacketize(&p.payload)?);
                assert_eq!(descriptor.i, 1);
                assert_eq!(descriptor.s, if part == 0 { 1 } else { 0 });
                assert_eq!(p.header.marker, part == packets.len() - 1);
                assert_eq!(
                    descriptor.picture_id,
                    *picture.get_or_insert(descriptor.picture_id)
                );
            }
            assert_eq!(assembled, bytes);
            if let Some(last) = previous {
                assert_eq!(picture.unwrap(), (last + 1) & 0x7fff);
            }
            previous = picture;
        }
        Ok(())
    }
}
