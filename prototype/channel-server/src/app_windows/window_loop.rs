//! Opt-in timing of posted events owned by the Windows App loop.
use super::ServiceEvent;
use piik_channel_native::diagnostics;
use std::{
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    time::{Duration, Instant},
};
use tao::event_loop::EventLoopProxy;

const SAMPLE_INTERVAL: Duration = Duration::from_millis(16);
const REPORT_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Default, Debug, PartialEq)]
pub(super) struct Samples {
    window_started: Option<Instant>,
    count: u32,
    max_ms: u128,
    at_least_16_ms: u32,
    at_least_50_ms: u32,
    at_least_100_ms: u32,
}

impl Samples {
    pub(super) fn received(&mut self, posted: Instant, now: Instant) {
        let started = *self.window_started.get_or_insert(posted);
        self.record(now.duration_since(posted));
        let window = now.duration_since(started);
        if window >= REPORT_INTERVAL {
            diagnostics::window_loop_lateness(
                window.as_millis(),
                self.count,
                self.max_ms,
                self.at_least_16_ms,
                self.at_least_50_ms,
                self.at_least_100_ms,
            );
            *self = Self { window_started: Some(now), ..Self::default() };
        }
    }

    fn record(&mut self, delay: Duration) {
        let millis = delay.as_millis();
        self.count += 1;
        self.max_ms = self.max_ms.max(millis);
        self.at_least_16_ms += u32::from(millis >= 16);
        self.at_least_50_ms += u32::from(millis >= 50);
        self.at_least_100_ms += u32::from(millis >= 100);
    }
}

pub(super) async fn sample(events: &EventLoopProxy<ServiceEvent>) {
    while !diagnostics::enabled() {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let pending = Arc::new(AtomicBool::new(false));
    loop {
        tokio::time::sleep(SAMPLE_INTERVAL).await;
        // Only this task posts probes. The window thread clears the flag when it handles one.
        if pending.swap(true, Ordering::Relaxed) {
            continue;
        }
        if events
            .send_event(ServiceEvent::WindowLoopProbe(Instant::now(), pending.clone()))
            .is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_loop_lateness_counts_thresholds_and_maximum() {
        let mut samples = Samples::default();
        for millis in [0, 15, 16, 49, 50, 99, 100, 505] {
            samples.record(Duration::from_millis(millis));
        }
        assert_eq!(
            samples,
            Samples {
                window_started: None,
                count: 8,
                max_ms: 505,
                at_least_16_ms: 6,
                at_least_50_ms: 4,
                at_least_100_ms: 2,
            }
        );
    }
}
