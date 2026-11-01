//! A local monotonic coordinate for one source, paired with its own NTP clock.
use super::SourceReport;
use rtc::rtcp::sender_report::SenderReport;
use rtc::shared::time::SystemInstant;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub(crate) struct SourceTime {
    pub epoch: Instant,
    clock: Arc<Clock>,
}
enum Clock {
    Local(SystemInstant),
    Incoming {
        anchor: Mutex<(u32, Instant)>,
        report: SourceReport,
    },
    Layer {
        anchor: Mutex<(u32, Instant)>,
        source: SourceTime,
    },
}
impl SourceTime {
    pub fn local(epoch: Instant, clock: SystemInstant) -> Self {
        Self {
            epoch,
            clock: Arc::new(Clock::Local(clock)),
        }
    }
    pub fn incoming(epoch: Instant, timestamp: u32, report: SourceReport) -> Self {
        Self {
            epoch,
            clock: Arc::new(Clock::Incoming {
                anchor: Mutex::new((timestamp, epoch)),
                report,
            }),
        }
    }
    /// Correlate another SSRC of the same source through its sender report.
    /// Until the reference SSRC has a report, its arrival-based origin cannot
    /// establish a relationship with another independently randomized RTP clock.
    pub fn incoming_layer(&self, timestamp: u32, report: &SenderReport) -> Option<Self> {
        let origin = self.ntp(self.epoch)?;
        let delta = report.ntp_time.wrapping_sub(origin) as i64;
        let elapsed =
            Duration::from_nanos(((u128::from(delta.unsigned_abs()) * 1_000_000_000) >> 32) as u64);
        let reported = if delta >= 0 {
            self.epoch + elapsed
        } else {
            self.epoch - elapsed
        };
        let at = advance(
            reported,
            timestamp.wrapping_sub(report.rtp_time) as i32 as i64,
            90_000,
        );
        Some(Self {
            epoch: self.epoch,
            clock: Arc::new(Clock::Layer {
                anchor: Mutex::new((timestamp, at)),
                source: self.clone(),
            }),
        })
    }
    /// Arrival only chooses an arbitrary local origin. All subsequent PTS comes
    /// from the source's RTP intervals, including wrap, never packet arrival.
    pub fn presentation(&self, timestamp: u32) -> Instant {
        let anchor = match &*self.clock {
            Clock::Incoming { anchor, .. } | Clock::Layer { anchor, .. } => anchor,
            Clock::Local(_) => unreachable!(),
        };
        let mut anchor = anchor.lock().unwrap();
        let delta = timestamp.wrapping_sub(anchor.0) as i32 as i64;
        let at = advance(anchor.1, delta, 90_000);
        if delta >= 0 {
            *anchor = (timestamp, at);
        }
        at
    }
    pub fn ntp(&self, at: Instant) -> Option<u64> {
        self.projected(at).map(|(_, ntp)| ntp)
    }
    /// Keep encoded PTS fixed while applying the source's latest shared SR
    /// correlation at transport admission, just as the raw audio path does.
    pub fn projected(&self, at: Instant) -> Option<(Instant, u64)> {
        match &*self.clock {
            Clock::Local(clock) => Some((at, clock.ntp(at))),
            Clock::Layer { source, .. } => source.projected(at),
            Clock::Incoming { anchor, report } => {
                let (timestamp, anchored) = *anchor.lock().unwrap();
                let report = report.lock().unwrap();
                let (sr, projected) = report.as_ref()?;
                let ticks = signed_nanos(at, anchored) * 90_000 / 1_000_000_000;
                let rtp = timestamp.wrapping_add(ticks as u32);
                let delta = rtp.wrapping_sub(sr.rtp_time) as i32 as i64;
                Some((
                    advance(*projected, delta, 90_000),
                    sr.ntp_time
                        .wrapping_add(((i128::from(delta) << 32) / 90_000) as u64),
                ))
            }
        }
    }
}
fn signed_nanos(at: Instant, anchor: Instant) -> i128 {
    if at >= anchor {
        at.duration_since(anchor).as_nanos() as i128
    } else {
        -(anchor.duration_since(at).as_nanos() as i128)
    }
}
fn advance(at: Instant, ticks: i64, rate: u64) -> Instant {
    let elapsed = Duration::from_nanos(ticks.unsigned_abs() * 1_000_000_000 / rate);
    if ticks >= 0 {
        at + elapsed
    } else {
        at - elapsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rtc::rtcp::sender_report::SenderReport;
    #[test]
    fn remote_clock_keeps_source_ntp_across_wrap_and_static_idr_without_wall_sync() {
        let epoch = Instant::now();
        let report: SourceReport = Default::default();
        let rtp = u32::MAX - 8_999;
        let source = SourceTime::incoming(epoch, rtp, report.clone());
        let second = source.presentation(rtp.wrapping_add(9_000));
        assert_eq!(second - epoch, Duration::from_millis(100));
        assert_eq!(source.ntp(second), None);
        // Deliberately unrelated to this machine's wall clock; arriving late
        // does not move the source's frame coordinate.
        let ntp = 1_000_000u64 << 32;
        *report.lock().unwrap() = Some((
            SenderReport {
                ntp_time: ntp,
                rtp_time: rtp,
                ..Default::default()
            },
            epoch + Duration::from_secs(12),
        ));
        assert_eq!(source.ntp(second), Some(ntp + (1u64 << 32) / 10));
        assert_eq!(
            source.ntp(epoch + Duration::from_secs(2)),
            Some(ntp + (2u64 << 32))
        );
    }

    #[test]
    fn simulcast_layers_share_source_time_despite_independent_rtp_origins() {
        let epoch = Instant::now();
        let report: SourceReport = Default::default();
        let source = SourceTime::incoming(epoch, 900_000, report.clone());
        let ntp = 1_000_000u64 << 32;
        let layer_rtp = u32::MAX - 8_999;
        let layer_report = SenderReport {
            ntp_time: ntp + (1u64 << 31),
            rtp_time: layer_rtp,
            ..Default::default()
        };
        assert!(source.incoming_layer(layer_rtp, &layer_report).is_none());
        *report.lock().unwrap() = Some((
            SenderReport {
                ntp_time: ntp,
                rtp_time: 900_000,
                ..Default::default()
            },
            epoch + Duration::from_secs(12),
        ));
        let layer = source.incoming_layer(layer_rtp, &layer_report).unwrap();
        assert_eq!(layer.epoch, source.epoch);
        let at = layer.presentation(layer_rtp.wrapping_add(18_000));
        assert_eq!(at, source.presentation(963_000));
        assert_eq!(at, epoch + Duration::from_millis(700));
        assert_eq!(layer.ntp(at), source.ntp(at));
        // A late packet keeps its source position without moving the live anchor.
        assert_eq!(
            layer.presentation(layer_rtp.wrapping_add(9_000)),
            epoch + Duration::from_millis(600)
        );
        assert_eq!(
            layer.presentation(layer_rtp.wrapping_add(27_000)),
            epoch + Duration::from_millis(800)
        );
        // Both outputs retain the same source NTP projection after an SR update.
        report.lock().unwrap().as_mut().unwrap().0.ntp_time += 1u64 << 30;
        assert_eq!(layer.ntp(at), source.ntp(at));
    }
}
