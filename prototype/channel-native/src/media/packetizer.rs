mod vp8;

use super::{clock::SourceTime, video::Video, vp8::Vp8FrameMetadata, EncodedFrame, SourceReport};
use crate::media::RtpCodec;
use anyhow::{ensure, Result};
use rtc_rtcp::sender_report::SenderReport;
use rtc_rtp::{
    packetizer::{new_packetizer, Packetizer as RtpPacketizer},
    sequence::new_random_sequencer,
    Packet,
};
use std::time::Instant;

/// A stable sender's RTP timeline, mapped from original capture time.
pub(crate) struct Packetizer {
    inner: Box<dyn RtpPacketizer>,
    vp8: Option<vp8::Descriptor>,
    ssrc: u32,
    clock_rate: u32,
    time: SourceTime,
    previous_ticks: u64,
    source: Option<Video>,
    offset: u64,
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

    fn source_ticks(&self, presentation_time: Instant) -> u64 {
        (presentation_time
            .saturating_duration_since(self.time.epoch)
            .as_nanos()
            * self.clock_rate as u128
            / 1_000_000_000) as u64
    }

    pub fn packetize_source(&mut self, video: &Video, frame: &EncodedFrame) -> Result<Vec<Packet>> {
        if self
            .source
            .as_ref()
            .is_none_or(|current| !current.same(video))
        {
            self.offset = if self.source.is_some() {
                (self.previous_ticks + 1).saturating_sub(self.source_ticks(frame.presentation_time))
            } else {
                0
            };
            self.source = Some(video.clone());
        }
        self.packetize(frame.bytes.clone(), frame.presentation_time, frame.vp8)
    }

    pub fn packetize(
        &mut self,
        bytes: Vec<u8>,
        presentation_time: Instant,
        metadata: Option<Vp8FrameMetadata>,
    ) -> Result<Vec<Packet>> {
        ensure!(!bytes.is_empty(), "video produced an empty encoded frame");
        let keyframe = bytes[0] & 1 == 0;
        // Only the hop RTP timeline is translated on a source switch. Retain
        // the offset for this feed, preserving its subsequent frame intervals.
        let ticks = self.source_ticks(presentation_time) + self.offset;
        // Advance before packetizing: irregular capture intervals and dropped raw
        // frames must not move the RTP clock onto the encoder's delivery cadence.
        self.inner
            .skip_samples(ticks.wrapping_sub(self.previous_ticks) as u32);
        self.previous_ticks = ticks;
        let mut packets = self.inner.packetize(Instant::now(), &bytes.into(), 0)?;
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
            SenderReport {
                ssrc: self.ssrc,
                ntp_time: self.time.ntp(presentation_time).unwrap_or(0),
                rtp_time: timestamp,
                ..Default::default()
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
