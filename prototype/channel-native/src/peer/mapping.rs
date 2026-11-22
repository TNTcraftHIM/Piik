//! Optional default-gateway mapping for one connection's actual IPv4 socket.
use super::{transport::Transport, MAX_ICE_CANDIDATES};
use crate::diagnostics::{rtc_pair, RtcPairEvent};
use netwatch::interfaces::HomeRouter;
use portmapper::Client;
use std::{
    net::{IpAddr, SocketAddrV4},
    num::NonZeroU16,
};
use str0m::{net::Protocol, Candidate, CandidateKind};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

pub(super) struct Mapping {
    client: Client,
    candidates: mpsc::Sender<Candidate>,
    watcher: JoinHandle<()>,
}

impl Mapping {
    pub(super) fn start(candidate: &Candidate, transport: Transport) -> Option<Self> {
        let base = eligible(candidate)?;
        Some(Self::with_lookup(
            base,
            transport,
            tokio::task::spawn_blocking(HomeRouter::new),
        ))
    }

    pub(super) fn observe(&self, candidate: &Candidate) {
        if let Some(candidate) = eligible(candidate) {
            // Optional discovery cannot backpressure host-candidate signaling.
            let _ = self.candidates.try_send(candidate);
        }
    }

    fn with_lookup(
        base: Candidate,
        transport: Transport,
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
            let port =
                NonZeroU16::new(base.addr().port()).expect("eligible host candidate has a port");
            let addresses = worker.watch_external_address();
            if let Ok(Ok(probe)) = worker.probe().await {
                rtc_pair(
                    transport.pair,
                    RtcPairEvent::GatewayProbe {
                        upnp: probe.upnp,
                        pcp: probe.pcp,
                        nat_pmp: probe.nat_pmp,
                    },
                );
            }
            worker.update_local_port(port);
            forward(base, addresses, transport).await;
        });
        Self {
            client,
            candidates,
            watcher,
        }
    }

    pub(super) fn cancel(&self) {
        self.watcher.abort();
    }

    pub(super) async fn close(&mut self) {
        self.cancel();
        let _ = (&mut self.watcher).await;
        // The published client exposes best-effort deactivation, not a release ack.
        self.client.deactivate();
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn eligible(candidate: &Candidate) -> Option<Candidate> {
    if candidate.proto() != Protocol::Udp
        || candidate.kind() != CandidateKind::Host
        || !candidate.addr().is_ipv4()
    {
        return None;
    }
    NonZeroU16::new(candidate.addr().port())?;
    Some(candidate.clone())
}

async fn select_base(
    lookup: JoinHandle<Option<HomeRouter>>,
    mut candidates: mpsc::Receiver<Candidate>,
) -> Option<Candidate> {
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
        if candidate.addr().ip() == IpAddr::V4(local) {
            return Some(candidate);
        }
    }
    None
}

// Only publish successful address updates; absence does not revoke ICE paths.
async fn forward(
    base: Candidate,
    mut addresses: watch::Receiver<Option<SocketAddrV4>>,
    transport: Transport,
) {
    while addresses.changed().await.is_ok() {
        let mapped = *addresses.borrow_and_update();
        let Some(mapped) = mapped else { continue };
        let Ok(candidate) = Candidate::server_reflexive(mapped.into(), base.addr(), "udp") else {
            continue;
        };
        if transport.add_gateway_candidate(candidate).await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peer::{tests::support::endpoint, transport::Runtime, Event};
    use anyhow::{anyhow, ensure, Result};
    use std::{net::SocketAddr, time::Duration};
    use tokio::sync::oneshot;
    use uuid::Uuid;

    #[tokio::test]
    async fn blocked_file_detach_retires_only_its_gateway_publisher() -> Result<()> {
        let (mut driver, mut events, _commands, _stop) = crate::peer::tests::driver();
        let id = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        for pair in [id, sibling] {
            let plan = piik_channel_core::wire::PairInfo {
                id: pair,
                peer_id: Uuid::new_v4(),
                rooms: vec![],
                incoming: vec![],
                outgoing: vec![],
                udp_preparation: None,
                can_receive_video_layers: false,
            };
            let socket = std::net::UdpSocket::bind("127.0.0.1:0")?;
            driver
                .create_pair(&plan, Some((socket, "127.0.0.1:41001".parse()?)))
                .await?;
        }
        let retired = driver.pairs[&id].pc.clone();
        let healthy = driver.pairs[&sibling].pc.clone();
        let file_channel = retired.create_channel("piik-file").await?;
        driver.install_dc(id, file_channel).await?;
        let bulk_reader = driver.pairs[&id].bulk.as_ref().unwrap().2.abort_handle();
        let (updates, addresses) = watch::channel(None);
        let (candidates, _pending) = mpsc::channel(1);
        let base = Candidate::host("127.0.0.1:41002".parse()?, "udp")?;
        driver.pairs.get_mut(&id).unwrap().mapping = Some(Mapping {
            client: Client::default(),
            candidates,
            watcher: tokio::spawn(forward(base, addresses, retired.clone())),
        });
        let held = driver.files.hold_queue_capacity().await;
        let mut retirement = Box::pin(driver.retire_pair(id));
        tokio::select! {
            result = &mut retirement => panic!("file detach unexpectedly completed: {result}"),
            result = tokio::time::timeout(Duration::from_secs(2), updates.closed()) => result?,
        }
        ensure!(updates.send(Some("203.0.113.5:41003".parse()?)).is_err());
        tokio::time::timeout(Duration::from_secs(2), async {
            while retired.connection_metrics().await.is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        healthy.connection_metrics().await?;
        ensure!(bulk_reader.is_finished());
        while let Ok(event) = events.try_recv() {
            ensure!(
                !matches!(event, Event::Candidate(pair, candidate, _) if pair == id && candidate.addr().port() == 41003)
            );
        }
        drop(held);
        tokio::time::timeout(Duration::from_secs(2), retirement).await?;
        driver.retire_pair(sibling).await;
        driver.files.close().await;
        driver.watches.close().await;
        driver.transport.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn gateway_lookup_yields_accepts_later_candidates_and_retires() -> Result<()> {
        fn host(address: &str, port: u16) -> Result<Candidate> {
            Ok(Candidate::host(
                SocketAddr::new(address.parse()?, port),
                "udp",
            )?)
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
        ensure!(base.addr() == expected.addr());

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
        let runtime = Runtime::new(None);
        let (transport, mut results) = endpoint(&runtime, Uuid::new_v4(), None).await?;
        while results.try_recv().is_ok() {}
        let mut mapping = Mapping::with_lookup(wrong, transport.clone(), lookup);
        mapping.observe(&expected);
        waiting.await?;
        mapping.close().await;
        ensure!(mapping.watcher.is_finished() && mapping.candidates.is_closed());
        transport.close().await?;
        runtime.close().await;
        while results.try_recv().is_ok() {}
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
        let socket = std::net::UdpSocket::bind("127.0.0.1:0")?;
        let local = socket.local_addr()?;
        let base = Candidate::host(local, "udp")?;
        let runtime = Runtime::new(None);
        let pair = Uuid::new_v4();
        let (transport, mut received) = endpoint(&runtime, pair, Some(socket)).await?;
        while received.try_recv().is_ok() {}
        let (updates, addresses) = watch::channel(None);
        let worker = tokio::spawn(forward(base, addresses, transport.clone()));
        let mut signaled = Vec::new();
        for port in [41000, 41001] {
            updates.send(Some(SocketAddrV4::new("203.0.113.5".parse()?, port)))?;
            let candidate = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Some(Event::Candidate(id, candidate, None)) = received.recv().await {
                        if candidate.kind() == CandidateKind::ServerReflexive {
                            ensure!(id == pair);
                            return Ok::<_, anyhow::Error>(candidate);
                        }
                    }
                }
            })
            .await??;
            ensure!(candidate.addr().port() == port && candidate.local() == local);
            ensure!(
                candidate.ufrag().is_some(),
                "mapping bypassed RTC admission"
            );
            signaled.push(candidate.to_sdp_string());
        }
        transport.create_channel("mapping-check").await?;
        transport.offer().await?;
        let (_, description) = transport.local_description().await?;
        for candidate in signaled {
            ensure!(
                description.contains(&candidate),
                "canonical mapped candidate missing from SDK SDP"
            );
        }
        worker.abort();
        let _ = worker.await;
        ensure!(updates
            .send(Some(SocketAddrV4::new("203.0.113.5".parse()?, 41002)))
            .is_err());
        transport.close().await?;
        runtime.close().await;
        while received.try_recv().is_ok() {}
        ensure!(
            received.recv().await.is_none(),
            "retired publisher retained events"
        );
        std::net::UdpSocket::bind(local)?;
        Ok(())
    }
}
