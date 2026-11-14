//! Bounded UDP failure summaries on the existing SDK observation cadence.
use super::*;

#[derive(Clone, Copy, Debug, Default)]
struct FailureCount {
    count: u64,
    last_os_error: Option<i32>,
}

#[derive(Debug, Default)]
pub(super) struct UdpSendFailures {
    // Each family has selected / other / unknown buckets, never addresses or route IDs.
    ipv4: [FailureCount; 3],
    ipv6: [FailureCount; 3],
    selected_snapshot_max_age_ms: Option<u64>,
}
impl UdpSendFailures {
    pub fn record(
        &mut self,
        source: SocketAddr,
        destination: SocketAddr,
        error: &std::io::Error,
        stats: Option<&PeerStats>,
    ) {
        let bucket = match stats.and_then(|stats| stats.selected_candidate_pair.as_ref()) {
            Some(pair) if pair.local.addr == source && pair.remote.addr == destination => 0,
            Some(_) => 1,
            None => 2,
        };
        let family = if source.is_ipv4() {
            &mut self.ipv4
        } else {
            &mut self.ipv6
        };
        family[bucket].count += 1;
        family[bucket].last_os_error = error.raw_os_error();
        if let Some(stats) = stats {
            let age = stats.timestamp.elapsed().as_millis() as u64;
            self.selected_snapshot_max_age_ms =
                Some(self.selected_snapshot_max_age_ms.unwrap_or(0).max(age));
        }
    }
    pub fn flush(&mut self) {
        if let Some(window) = self.take() {
            log::warn!(target: "piik.rtc", "UDP send failures: match_order=[selected,other,unknown] ipv4={:?} ipv6={:?} selected_snapshot_max_age_ms={:?}", window.ipv4, window.ipv6, window.selected_snapshot_max_age_ms);
        }
    }
    fn take(&mut self) -> Option<Self> {
        self.ipv4
            .iter()
            .chain(&self.ipv6)
            .any(|failure| failure.count != 0)
            .then(|| std::mem::take(self))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_distinguish_full_tuple_and_reset_without_addresses() {
        let source: SocketAddr = "192.0.2.11:31001".parse().unwrap();
        let destination: SocketAddr = "192.0.2.12:31002".parse().unwrap();
        let stats = PeerStats {
            peer_bytes_rx: 0,
            peer_bytes_tx: 0,
            bytes_rx: 0,
            bytes_tx: 0,
            timestamp: Instant::now(),
            bwe_tx: None,
            egress_loss_fraction: None,
            ingress_loss_fraction: None,
            rtt: None,
            selected_candidate_pair: Some(str0m::stats::CandidatePairStats {
                protocol: Protocol::Udp,
                local: str0m::stats::CandidateStats { addr: source },
                remote: str0m::stats::CandidateStats { addr: destination },
                current_round_trip_time: None,
                total_round_trip_time: Duration::ZERO,
                responses_received: 0,
            }),
        };
        let error = std::io::Error::from_raw_os_error(10051);
        let mut failures = UdpSendFailures::default();
        for _ in 0..2000 {
            failures.record(source, destination, &error, Some(&stats));
        }
        // A probe can share the selected local socket while targeting another candidate.
        failures.record(
            source,
            "192.0.2.13:31003".parse().unwrap(),
            &error,
            Some(&stats),
        );
        failures.record(
            "[2001:db8::11]:31001".parse().unwrap(),
            "[2001:db8::12]:31002".parse().unwrap(),
            &error,
            None,
        );
        let window = failures.take().unwrap();
        assert_eq!(window.ipv4[0].count, 2000);
        assert_eq!(window.ipv4[1].count, 1);
        assert_eq!(window.ipv4[2].count, 0);
        assert_eq!(window.ipv6[2].count, 1);
        assert_eq!(window.ipv4[0].last_os_error, Some(10051));
        assert!(window.selected_snapshot_max_age_ms.is_some());
        assert!(failures.take().is_none());
        let text = format!("{window:?}");
        assert!(!text.contains("192.0.2") && !text.contains("2001:db8") && !text.contains("31001"));
    }
}
