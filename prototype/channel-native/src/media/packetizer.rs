use super::SourceReport;
use anyhow::{anyhow, Result};
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
        let timestamp = packets
            .first()
            .ok_or_else(|| anyhow!("capture produced an empty access unit"))?
            .header
            .timestamp;
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
