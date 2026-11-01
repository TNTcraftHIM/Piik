//! Optional default-gateway mapping for one connection's actual IPv4 socket.
use super::{Event, MAX_ICE_CANDIDATES};
use netwatch::interfaces::HomeRouter;
use portmapper::Client;
use rtc::peer_connection::transport::{CandidateConfig, CandidateServerReflexiveConfig};
use rtc::peer_connection::transport::{RTCIceCandidate, RTCIceCandidateType, RTCIceProtocol};
use std::{
    net::{IpAddr, SocketAddr, SocketAddrV4},
    num::NonZeroU16,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use uuid::Uuid;

pub(super) struct Mapping {
    client: Client,
    candidates: mpsc::Sender<RTCIceCandidate>,
    watcher: JoinHandle<()>,
}

impl Mapping {
    pub(super) fn start(
        pair: Uuid,
        candidate: &RTCIceCandidate,
        events: mpsc::Sender<Event>,
    ) -> Option<Self> {
        let base = eligible(candidate)?;
        Some(Self::with_lookup(
            pair,
            base,
            events,
            tokio::task::spawn_blocking(HomeRouter::new),
        ))
    }

    pub(super) fn observe(&self, candidate: &RTCIceCandidate) {
        if let Some(candidate) = eligible(candidate) {
            // Optional discovery cannot backpressure host-candidate signaling.
            let _ = self.candidates.try_send(candidate);
        }
    }

    fn with_lookup(
        pair: Uuid,
        base: RTCIceCandidate,
        events: mpsc::Sender<Event>,
        lookup: JoinHandle<Option<HomeRouter>>,
    ) -> Self {
        let (candidates, pending) = mpsc::channel(MAX_ICE_CANDIDATES);
        candidates
            .try_send(base)
            .expect("new mapping candidate queue is empty");
        let client = Client::default();
        let worker = client.clone();
        let watcher = tokio::spawn(async move {
            let Some(base) = select_base(lookup, pending).await else {
                return;
            };
            let port = NonZeroU16::new(base.port).expect("eligible host candidate has a port");
            let addresses = worker.watch_external_address();
            let _ = worker.probe().await;
            worker.update_local_port(port);
            forward(pair, base, addresses, events).await;
        });
        Self {
            client,
            candidates,
            watcher,
        }
    }

    pub(super) async fn close(&mut self) {
        self.watcher.abort();
        let _ = (&mut self.watcher).await;
        // The published client exposes best-effort deactivation, not a release ack.
        self.client.deactivate();
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}

fn eligible(candidate: &RTCIceCandidate) -> Option<RTCIceCandidate> {
    if candidate.component != 1
        || candidate.protocol != RTCIceProtocol::Udp
        || candidate.typ != RTCIceCandidateType::Host
    {
        return None;
    }
    candidate.address.parse::<std::net::Ipv4Addr>().ok()?;
    NonZeroU16::new(candidate.port)?;
    Some(candidate.clone())
}

async fn select_base(
    lookup: JoinHandle<Option<HomeRouter>>,
    mut candidates: mpsc::Receiver<RTCIceCandidate>,
) -> Option<RTCIceCandidate> {
    // The blocking closure owns only OS lookup data. Cancellation drops this
    // continuation, so its eventual result cannot start or publish peer work.
    let HomeRouter {
        gateway: IpAddr::V4(_),
        my_ip: Some(IpAddr::V4(local)),
    } = lookup.await.ok()??
    else {
        return None;
    };
    while let Some(candidate) = candidates.recv().await {
        if candidate.address.parse::<std::net::Ipv4Addr>().ok() == Some(local) {
            return Some(candidate);
        }
    }
    None
}

pub(super) fn candidate(
    base: &RTCIceCandidate,
    mapped: SocketAddr,
) -> anyhow::Result<RTCIceCandidate> {
    Ok(RTCIceCandidate::from(
        &CandidateServerReflexiveConfig {
            base_config: CandidateConfig {
                network: "udp".into(),
                address: mapped.ip().to_string(),
                port: mapped.port(),
                component: base.component,
                ..Default::default()
            },
            rel_addr: base.address.clone(),
            rel_port: base.port,
            ..Default::default()
        }
        .new_candidate_server_reflexive()?,
    ))
}

// Only publish successful address updates; absence does not revoke ICE paths.
async fn forward(
    pair: Uuid,
    base: RTCIceCandidate,
    mut addresses: watch::Receiver<Option<SocketAddrV4>>,
    events: mpsc::Sender<Event>,
) {
    while addresses.changed().await.is_ok() {
        let mapped = *addresses.borrow_and_update();
        let Some(mapped) = mapped else { continue };
        let Ok(candidate) = candidate(&base, mapped.into()) else {
            continue;
        };
        if events
            .send(Event::Candidate(pair, candidate))
            .await
            .is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{anyhow, ensure, Context, Result};
    use std::time::Duration;
    use tokio::sync::oneshot;
    #[tokio::test]
    async fn gateway_lookup_yields_accepts_later_candidates_and_retires() -> Result<()> {
        fn host(address: &str, port: u16) -> Result<RTCIceCandidate> {
            Ok(RTCIceCandidate::from(
                &rtc::peer_connection::transport::CandidateHostConfig {
                    base_config: CandidateConfig {
                        network: "udp".into(),
                        address: address.into(),
                        port,
                        component: 1,
                        ..Default::default()
                    },
                    ..Default::default()
                }
                .new_candidate_host()?,
            ))
        }
        let wrong = host("192.0.2.1", 41001)?;
        let expected = host("127.0.0.1", 41002)?;
        let (candidates, pending) = mpsc::channel(MAX_ICE_CANDIDATES);
        candidates.send(wrong.clone()).await?;
        let (release, blocked) = std::sync::mpsc::channel();
        let (started, waiting) = oneshot::channel();
        let lookup = tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            blocked.recv().unwrap();
            Some(HomeRouter {
                gateway: IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                my_ip: Some(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)),
            })
        });
        let selected = tokio::spawn(select_base(lookup, pending));
        waiting.await?;
        for index in 2..11 {
            candidates.try_send(host(&format!("192.0.2.{index}"), 41000 + index as u16)?)?;
        }
        candidates.try_send(expected.clone())?;
        let timer = std::time::Instant::now();
        tokio::time::sleep(Duration::from_millis(100)).await;
        ensure!(
            timer.elapsed() < Duration::from_millis(500),
            "gateway lookup blocked the reactor"
        );
        eprintln!(
            "gateway lookup pending: 100ms timer completed in {}ms",
            timer.elapsed().as_millis()
        );
        ensure!(!selected.is_finished());
        release.send(())?;
        let base = selected
            .await?
            .ok_or_else(|| anyhow!("later gateway candidate was lost"))?;
        ensure!(base.address == expected.address && base.port == expected.port);

        let (release, blocked) = std::sync::mpsc::channel();
        let (started, waiting) = oneshot::channel();
        let (finished, complete) = oneshot::channel();
        // This closure contains only lookup data, with no peer, client or socket.
        let lookup = tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            blocked.recv().unwrap();
            let _ = finished.send(());
            Some(HomeRouter {
                gateway: IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                my_ip: Some(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)),
            })
        });
        let (events, mut results) = mpsc::channel(1);
        let mut mapping = Mapping::with_lookup(Uuid::new_v4(), wrong, events, lookup);
        mapping.observe(&expected);
        waiting.await?;
        mapping.close().await;
        ensure!(mapping.watcher.is_finished() && mapping.candidates.is_closed());
        ensure!(
            results.recv().await.is_none(),
            "retired lookup retained its publisher"
        );
        release.send(())?;
        complete.await?;
        ensure!(
            results.recv().await.is_none(),
            "late lookup published after retirement"
        );
        Ok(())
    }

    #[tokio::test]
    async fn mapped_updates_keep_the_bound_base_and_cancel_the_publisher() -> Result<()> {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await?;
        let local = socket.local_addr()?;
        let base = RTCIceCandidate::from(
            &rtc::peer_connection::transport::CandidateHostConfig {
                base_config: CandidateConfig {
                    network: "udp".into(),
                    address: local.ip().to_string(),
                    port: local.port(),
                    component: 1,
                    ..Default::default()
                },
                ..Default::default()
            }
            .new_candidate_host()?,
        );
        let (updates, addresses) = watch::channel(None);
        let (events, mut received) = mpsc::channel(8);
        let pair = Uuid::new_v4();
        let worker = tokio::spawn(forward(pair, base.clone(), addresses, events));
        for port in [41000, 41001] {
            updates.send(Some(SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, port)))?;
            let Event::Candidate(id, candidate) =
                received.recv().await.context("mapping publisher ended")?
            else {
                anyhow::bail!("unexpected mapping event")
            };
            ensure!(
                id == pair
                    && candidate.port == port
                    && candidate.related_port == local.port()
                    && candidate.related_address == local.ip().to_string(),
                "mapping replaced its socket base"
            );
            ensure!(
                socket.local_addr()? == local,
                "mapping changed socket ownership"
            );
        }
        worker.abort();
        let _ = worker.await;
        ensure!(
            received.recv().await.is_none(),
            "retired publisher kept event sender"
        );
        drop(socket);
        std::net::UdpSocket::bind(local)?;
        Ok(())
    }
}
