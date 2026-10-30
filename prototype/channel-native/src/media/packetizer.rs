use super::SourceReport;
use anyhow::{ensure, Result};
use rtc::{
    rtcp::sender_report::SenderReport,
    rtp::{
        packetizer::{new_packetizer, Packetizer as RtpPacketizer, Payloader},
        sequence::new_random_sequencer,
        Packet,
    },
    rtp_transceiver::rtp_sender::RTCRtpCodec,
    shared::time::SystemInstant,
};
use std::time::Instant;

#[derive(Clone, Copy)]
pub(crate) struct CaptureTime {
    pub epoch: Instant,
    pub clock: SystemInstant,
}

/// A stable sender's RTP timeline, mapped from original capture time.
pub(crate) struct Packetizer {
    inner: Box<dyn RtpPacketizer>,
    ssrc: u32,
    clock_rate: u32,
    time: CaptureTime,
    previous_ticks: u32,
    report: SourceReport,
}
impl Packetizer {
    pub fn new(
        codec: &RTCRtpCodec,
        payloader: Box<dyn Payloader>,
        payload_type: u8,
        ssrc: u32,
        time: CaptureTime,
        report: SourceReport,
    ) -> Self {
        Self {
            inner: Box::new(new_packetizer(
                time.epoch,
                1200,
                payload_type,
                ssrc,
                payloader,
                Box::new(new_random_sequencer()),
                codec.clock_rate,
            )),
            ssrc,
            clock_rate: codec.clock_rate,
            time,
            previous_ticks: 0,
            report,
        }
    }

    pub fn packetize(&mut self, bytes: Vec<u8>, presentation_time: Instant) -> Result<Vec<Packet>> {
        ensure!(!bytes.is_empty(), "capture produced an empty access unit");
        let ticks = (presentation_time
            .saturating_duration_since(self.time.epoch)
            .as_nanos()
            * self.clock_rate as u128
            / 1_000_000_000) as u32;
        // Advance before packetizing: irregular capture intervals and dropped raw
        // frames must not move the RTP clock onto the encoder's delivery cadence.
        self.inner
            .skip_samples(ticks.wrapping_sub(self.previous_ticks));
        self.previous_ticks = ticks;
        let packets = self.inner.packetize(Instant::now(), &bytes.into(), 0)?;
        // The payloader may cache parameter sets or omit non-picture NALs.
        // No RTP was sent, so retain the last sender report correlation.
        let Some(first) = packets.first() else {
            return Ok(packets);
        };
        let timestamp = first.header.timestamp;
        *self.report.lock().unwrap() = Some((
            SenderReport {
                ssrc: self.ssrc,
                ntp_time: self.time.clock.ntp(presentation_time),
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
    use rtc::rtp::codec::h264::H264Payloader;
    use std::time::Duration;

    #[test]
    fn h264_metadata_preserves_sender_and_source_clock() -> Result<()> {
        let epoch = Instant::now();
        let report: SourceReport = Default::default();
        let mut packetizer = Packetizer::new(
            &RTCRtpCodec {
                mime_type: "video/H264".into(),
                clock_rate: 90_000,
                ..Default::default()
            },
            Box::<H264Payloader>::default(),
            96,
            42,
            CaptureTime {
                epoch,
                clock: SystemInstant::now(epoch),
            },
            report.clone(),
        );
        let picture = vec![0, 0, 0, 1, 0x65, 42, 0x80];
        let first = packetizer.packetize(picture.clone(), epoch)?;
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
                .packetize(bytes, epoch + Duration::from_millis(ms))?
                .is_empty());
            let current = report.lock().unwrap();
            let (current, at) = current.as_ref().unwrap();
            assert_eq!(current.rtp_time, last.header.timestamp);
            assert_eq!(*at, epoch);
        }
        let next = packetizer.packetize(picture, epoch + Duration::from_millis(50))?;
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
            .packetize(vec![], epoch + Duration::from_millis(60))
            .is_err());
        Ok(())
    }
}
