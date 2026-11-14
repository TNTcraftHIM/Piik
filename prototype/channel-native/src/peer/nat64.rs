//! Pair-scoped RFC 7050 discovery values and RFC 6052 address layout.
use std::net::{Ipv4Addr, Ipv6Addr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Prefix {
    address: Ipv6Addr,
    length: u8,
}
const LENGTHS: [u8; 6] = [32, 40, 48, 56, 64, 96];
const KNOWN: [Ipv4Addr; 2] = [Ipv4Addr::new(192, 0, 0, 170), Ipv4Addr::new(192, 0, 0, 171)];
impl Prefix {
    fn new(address: Ipv6Addr, length: u8) -> Self {
        let mut bytes = address.octets();
        bytes[usize::from(length / 8)..].fill(0);
        Self {
            address: bytes.into(),
            length,
        }
    }
    pub(super) fn synthesize(self, address: Ipv4Addr) -> Ipv6Addr {
        let mut bytes = self.address.octets();
        let start = usize::from(self.length / 8);
        for (offset, value) in address.octets().into_iter().enumerate() {
            let position = start + offset;
            bytes[position + usize::from(self.length != 96 && position >= 8)] = value;
        }
        bytes.into()
    }
    fn permits(self, address: Ipv4Addr) -> bool {
        self.address != Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0)
            || self.length != 96
            || global_unicast(address)
    }
}

// RFC 6052 section 3.1; IANA IPv4 Special-Purpose registry (2025-10-09).
// Scoped to WKP media destinations, not NSP or the discovery WKA parser.
fn global_unicast(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    !(a == 0
        || ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_documentation()
        || a >= 224
        || (a == 100 && b & 0xc0 == 64)
        || (a == 198 && b & 0xfe == 18)
        || (a == 192 && b == 0 && c == 0 && d != 9 && d != 10)
        || (a == 192 && b == 88 && c == 99))
}

use std::{collections::HashSet, net::SocketAddr};
use str0m::{net::Protocol, Candidate};
use tokio::task::JoinHandle;

pub(super) const PREFIX_LIMIT: usize = 8;
const LIMIT: usize = super::super::MAX_ICE_CANDIDATES;

/// Initial ICE only. Pending inputs and emitted endpoints share LIMIT slots;
/// prefixes have their own PREFIX_LIMIT. Originals always remain SDK-owned.
#[derive(Default)]
pub(super) struct Bootstrap {
    pub task: Option<JoinHandle<()>>,
    pending: Vec<Candidate>,
    prefixes: Option<Vec<Prefix>>,
    emitted: HashSet<SocketAddr>,
}
impl Drop for Bootstrap {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
impl Bootstrap {
    pub fn candidate(&mut self, candidate: Candidate) -> (bool, Vec<Candidate>) {
        if candidate.proto() != Protocol::Udp || !candidate.addr().is_ipv4() {
            return (false, Vec::new());
        }
        if self.prefixes.is_some() {
            return (false, self.aliases(&candidate));
        }
        if self.pending.len() < LIMIT && !self.pending.iter().any(|c| c.addr() == candidate.addr())
        {
            self.pending.push(candidate);
        }
        (self.task.is_none() && !self.pending.is_empty(), Vec::new())
    }
    pub fn resolved(&mut self, prefixes: Vec<Prefix>) -> Vec<Candidate> {
        self.prefixes = Some(prefixes.into_iter().take(PREFIX_LIMIT).collect());
        let mut aliases = Vec::new();
        // Release each pending slot before deriving to preserve the shared bound.
        while !self.pending.is_empty() {
            let candidate = self.pending.remove(0);
            aliases.extend(self.aliases(&candidate));
        }
        aliases
    }
    fn aliases(&mut self, candidate: &Candidate) -> Vec<Candidate> {
        let SocketAddr::V4(address) = candidate.addr() else {
            return Vec::new();
        };
        let mut aliases = Vec::new();
        for prefix in self.prefixes.iter().flatten() {
            if self.pending.len() + self.emitted.len() >= LIMIT {
                break;
            }
            if !prefix.permits(*address.ip()) {
                continue;
            }
            let endpoint = SocketAddr::new(prefix.synthesize(*address.ip()).into(), address.port());
            if self.emitted.contains(&endpoint) {
                continue;
            }
            let text = candidate.to_sdp_string();
            let ip = endpoint.ip().to_string();
            let mut fields: Vec<_> = text.split_whitespace().collect();
            let Some(field) = fields.get_mut(4) else {
                continue;
            };
            *field = &ip;
            if let Ok(alias) = Candidate::from_sdp_string(&fields.join(" ")) {
                self.emitted.insert(endpoint);
                aliases.push(alias);
            }
        }
        aliases
    }
}
// Each response must identify one standard layout unambiguously. A different
// WKA response can still identify a prefix if one response was ambiguous.
pub(super) fn discover(addresses: impl IntoIterator<Item = Ipv6Addr>, limit: usize) -> Vec<Prefix> {
    let mut prefixes = Vec::new();
    for address in addresses {
        let bytes = address.octets();
        let mut matches = Vec::new();
        for length in LENGTHS {
            if length != 96 && bytes[8] != 0 {
                continue;
            }
            let start = usize::from(length / 8);
            let embedded = Ipv4Addr::from(std::array::from_fn::<_, 4, _>(|offset| {
                let position = start + offset;
                bytes[position + usize::from(length != 96 && position >= 8)]
            }));
            if !KNOWN.contains(&embedded) {
                continue;
            }
            // RFC 7050 requires the WKA to occur only once on octet boundaries.
            let contiguous = bytes
                .windows(4)
                .filter(|window| *window == embedded.octets())
                .count();
            let split = matches!(length, 40 | 48 | 56);
            if contiguous > usize::from(!split) {
                continue;
            }
            matches.push(Prefix::new(address, length));
        }
        if matches.len() == 1 && prefixes.len() < limit && !prefixes.contains(&matches[0]) {
            prefixes.push(matches[0]);
        }
    }
    prefixes
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wkp_limits_media_but_nsp_keeps_private_destinations() {
        let wkp = Prefix::new("64:ff9b::".parse().unwrap(), 96);
        let nsp = Prefix::new("2001:db8:64::".parse().unwrap(), 64);
        for address in [
            "0.1.2.3",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.1.1",
            "192.0.0.170",
            "192.0.2.1",
            "192.88.99.2",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!wkp.permits(address.parse().unwrap()), "{address}");
        }
        for address in ["8.8.8.8", "192.0.0.9", "192.0.0.10", "192.31.196.1"] {
            assert!(wkp.permits(address.parse().unwrap()), "{address}");
        }
        assert!(nsp.permits("192.168.1.1".parse().unwrap()));
    }
    #[test]
    fn late_discovery_deduplicates_and_bounds_derived_work() {
        let mut bootstrap = Bootstrap::default();
        for port in 1..=LIMIT as u16 + 1 {
            let original =
                Candidate::host(SocketAddr::from(([192, 168, 1, 1], port)), "udp").unwrap();
            assert!(bootstrap.candidate(original.clone()).1.is_empty());
            bootstrap.candidate(original);
        }
        assert_eq!(bootstrap.pending.len(), LIMIT);
        let aliases = bootstrap.resolved(vec![
            Prefix::new("2001:db8:1::".parse().unwrap(), 96),
            Prefix::new("2001:db8:2::".parse().unwrap(), 64),
        ]);
        assert_eq!(aliases.len(), LIMIT);
        assert!(bootstrap.pending.is_empty());
        assert_eq!(bootstrap.emitted.len(), LIMIT);
        assert!(bootstrap
            .candidate(Candidate::host("192.168.1.1:1".parse().unwrap(), "udp").unwrap())
            .1
            .is_empty());
        let mut failed = Bootstrap::default();
        let original = Candidate::host("8.8.8.8:1234".parse().unwrap(), "udp").unwrap();
        assert!(failed.candidate(original.clone()).0);
        assert!(failed.resolved(Vec::new()).is_empty());
        assert!(!failed.candidate(original).0);
    }
    #[tokio::test]
    async fn loopback_ipv6_does_not_start_discovery() -> anyhow::Result<()> {
        use super::super::Runtime;
        use crate::peer::{server_udp::ServerUdp, tests::support::endpoint};
        let runtime = Runtime::new(Some(ServerUdp::bind(&[("[::1]:0".parse()?, None)])?));
        let (peer, _) = endpoint(&runtime, uuid::Uuid::new_v4(), None).await?;
        peer.add_candidate(Candidate::host("8.8.8.8:1234".parse()?, "udp")?.to_sdp_string())
            .await?;
        assert!(peer.call(|engine| Ok(engine.nat64.is_none())).await?);
        peer.close().await?;
        runtime.close().await;
        Ok(())
    }
    #[tokio::test]
    async fn ordinary_ice_survives_failed_discovery_and_exhausted_aliases() -> anyhow::Result<()> {
        use super::super::Runtime;
        use crate::peer::{
            server_udp::ServerUdp,
            tests::support::{endpoint, exchange, open},
        };
        use uuid::Uuid;
        let left_runtime = Runtime::new(Some(ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?));
        let right_runtime = Runtime::new(Some(ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?));
        let (left, _) = endpoint(&left_runtime, Uuid::new_v4(), None).await?;
        let (right, mut events) = endpoint(&right_runtime, Uuid::new_v4(), None).await?;
        left.call(|engine| {
            let mut bootstrap = Bootstrap::default();
            bootstrap.resolved(Vec::new());
            engine.nat64 = Some(bootstrap);
            Ok(())
        })
        .await?;
        right
            .call(|engine| {
                engine.nat64 = Some(Bootstrap {
                    prefixes: Some(vec![Prefix::new("2001:db8:64::".parse().unwrap(), 64)]),
                    emitted: (1..=LIMIT as u16)
                        .map(|port| SocketAddr::new(Ipv6Addr::LOCALHOST.into(), port))
                        .collect(),
                    task: None,
                    pending: Vec::new(),
                });
                Ok(())
            })
            .await?;
        let (send, receive) = open(&left, &right, &mut events).await?;
        exchange(&send, &receive, "ordinary with NAT64 exhausted").await?;
        assert!(left.call(|engine| Ok(engine.nat64.is_none())).await?);
        assert!(right.call(|engine| Ok(engine.nat64.is_none())).await?);
        left.close().await?;
        right.close().await?;
        left_runtime.close().await;
        right_runtime.close().await;
        Ok(())
    }
    #[tokio::test]
    async fn retirement_cancels_the_owned_lookup() {
        let task = tokio::spawn(std::future::pending::<()>());
        let cancellation = task.abort_handle();
        let bootstrap = Bootstrap {
            task: Some(task),
            pending: Vec::new(),
            prefixes: None,
            emitted: HashSet::new(),
        };
        drop(bootstrap);
        tokio::task::yield_now().await;
        assert!(cancellation.is_finished());
    }
    // RFC 6052 Tables 1 and 2, independently written literal expectations.
    const VECTORS: [(&str, u8, &str); 7] = [
        ("2001:db8::", 32, "2001:db8:c000:221::"),
        ("2001:db8:100::", 40, "2001:db8:1c0:2:21::"),
        ("2001:db8:122::", 48, "2001:db8:122:c000:2:2100::"),
        ("2001:db8:122:300::", 56, "2001:db8:122:3c0:0:221::"),
        ("2001:db8:122:344::", 64, "2001:db8:122:344:c0:2:2100::"),
        ("2001:db8:122:344::", 96, "2001:db8:122:344::c000:221"),
        ("64:ff9b::", 96, "64:ff9b::c000:221"),
    ];
    #[test]
    fn rfc6052_vectors() {
        for (prefix, length, expected) in VECTORS {
            let p = Prefix::new(prefix.parse().unwrap(), length);
            assert_eq!(
                p.synthesize(Ipv4Addr::new(192, 0, 2, 33)),
                expected.parse::<Ipv6Addr>().unwrap()
            );
        }
    }
    #[test]
    fn discovers_all_six_layouts_both_wka_and_deduplicates() {
        for (prefix, length, _) in VECTORS {
            let p = Prefix::new(prefix.parse().unwrap(), length);
            assert_eq!(discover(KNOWN.map(|ip| p.synthesize(ip)), 128), vec![p]);
        }
    }
    #[test]
    fn invalid_u_unrelated_and_ambiguous_answers_do_not_create_prefixes() {
        assert!(discover(["2001:db8::1234".parse().unwrap()], 128).is_empty());
        assert!(discover(["2001:db8:64:0:1c0:0:aa00:0".parse().unwrap()], 128).is_empty());
        assert!(discover(["c000:aa:0:0:0:0:c000:aa".parse().unwrap()], 128).is_empty());
    }
    #[test]
    fn multiple_prefixes_keep_response_order_and_limit() {
        let a = Prefix::new("2001:db8:1::".parse().unwrap(), 96);
        let b = Prefix::new("2001:db8:2::".parse().unwrap(), 64);
        let answers = [
            a.synthesize(KNOWN[0]),
            b.synthesize(KNOWN[1]),
            a.synthesize(KNOWN[1]),
        ];
        assert_eq!(discover(answers, 128), vec![a, b]);
        assert_eq!(discover(answers, 1), vec![a]);
    }
}
