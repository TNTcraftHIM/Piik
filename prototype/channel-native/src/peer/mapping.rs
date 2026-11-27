//! Optional default-gateway mapping for an actual IPv4 socket.
use super::{transport::Transport, MAX_ICE_CANDIDATES};
use crate::diagnostics::{rtc_pair, RtcPairEvent};
use netwatch::interfaces::HomeRouter;
use portmapper::Client;
use std::{
    net::{IpAddr, SocketAddrV4},
    num::NonZeroU16,
    sync::{Arc, OnceLock},
};
use str0m::{net::Protocol, Candidate, CandidateKind};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

pub(super) struct Mapping {
    client: Arc<OnceLock<Client>>,
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

    pub(super) fn finished(&self) -> bool { self.watcher.is_finished() }

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
        let client = Arc::new(OnceLock::new());
        let worker = Arc::clone(&client);
        let watcher = tokio::spawn(async move {
            let Some(base) = select_base(lookup, pending).await else {
                return;
            };
            let port =
                NonZeroU16::new(base.addr().port()).expect("eligible host candidate has a port");
            let worker = worker.get_or_init(Client::default);
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
        if let Some(client) = self.client.get() {
            // The SDK deactivates the mapping on a best-effort basis.
            client.deactivate();
        }
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
        let Some(mapped) = mapped else {
            transport.clear_gateway_observation().await;
            continue;
        };
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

    #[cfg(not(target_os = "android"))]
    #[tokio::test]
    async fn available_refresh_admits_one_gateway_mapping_for_two_pairs() -> Result<()> {
        use netwatch::interfaces::State;
        use piik_channel_core::wire::{PairInfo, UdpPreparation};

        let (leases, mut starts) = mpsc::unbounded_channel();
        let mut runtime = Runtime::with_mapping(None, move |host, transport| {
            let (updates, addresses) = watch::channel(None);
            let (candidates, observations) = mpsc::channel(4);
            leases.send((host.addr(), observations, updates)).unwrap();
            Some(Mapping {
                client: Arc::new(OnceLock::new()),
                candidates,
                watcher: tokio::spawn(forward(host.clone(), addresses, transport)),
            })
        });
        let late = State::fake();
        let mut initial = late.clone();
        initial.interfaces.clear();
        runtime.test_interfaces = Some(n0_watcher::Watchable::new(initial));
        let (mut driver, mut events, _signals, _stop) = crate::peer::tests::driver();
        std::mem::replace(&mut driver.transport, runtime).close().await;
        let mut pairs = std::collections::HashSet::new();
        for _ in 0..2 {
            let id = Uuid::new_v4();
            driver.create_pair(&PairInfo {
                id, peer_id: Uuid::new_v4(), rooms: vec![], incoming: vec![], outgoing: vec![],
                udp_preparation: Some(UdpPreparation::Available), can_receive_video_layers: false,
            }).await?;
            pairs.insert(id);
        }
        assert!(starts.try_recv().is_err());
        driver.transport.test_interfaces.as_ref().unwrap().set(late).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            let (base, mut observations, updates) = starts.recv().await.unwrap();
            let observed = observations.recv().await.unwrap();
            assert_eq!(observed.addr(), base);
            let mapped = SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, base.port());
            updates.send(Some(mapped)).unwrap();
            while !pairs.is_empty() {
                if let Event::Candidate(pair, c, _) = events.recv().await.unwrap() {
                    if c.kind() == CandidateKind::ServerReflexive && c.addr() == SocketAddr::V4(mapped) {
                        assert_eq!(c.local(), base);
                        assert!(pairs.remove(&pair));
                    }
                }
            }
            assert!(starts.try_recv().is_err());
        }).await?;
        driver.transport.close().await;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn available_ipv4_shares_a_base_and_retires_the_last_gateway_publisher() -> Result<()> {
        use crate::peer::server_udp::ServerUdp;
        use crate::peer::tests::support::{exchange, open};
        use piik_channel_core::wire::{PairInfo, UdpPreparation};

        let (leases, mut started) = mpsc::unbounded_channel();
        let previous: std::sync::Mutex<Option<watch::Sender<Option<SocketAddrV4>>>> = Default::default();
        let runtime = Runtime::with_mapping(None, move |host, transport| {
            let (updates, addresses) = watch::channel(None);
            if let Some(previous) = previous.lock().unwrap().replace(updates.clone()) {
                assert!(previous.is_closed(), "successor started before prior publisher retired");
            }
            let (candidates, _) = mpsc::channel(1);
            leases.send((host.addr(), updates)).unwrap();
            Some(Mapping {
                client: Arc::new(OnceLock::new()),
                candidates,
                watcher: tokio::spawn(forward(host.clone(), addresses, transport)),
            })
        });
        let (mut driver, mut events, _signals, _stop) = crate::peer::tests::driver();
        std::mem::replace(&mut driver.transport, runtime)
            .close()
            .await;
        let plan = || PairInfo {
            id: Uuid::new_v4(),
            peer_id: Uuid::new_v4(),
            rooms: vec![],
            incoming: vec![],
            outgoing: vec![],
            udp_preparation: Some(UdpPreparation::Available),
            can_receive_video_layers: false,
        };
        let first = plan();
        let second = plan();
        driver.create_pair(&first).await?;
        let (local, updates) = started.try_recv()?;
        let published = SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, local.port());
        updates.send(Some(published))?;
        async fn mapped(
            events: &mut mpsc::Receiver<Event>,
            pair: Uuid,
            addr: SocketAddrV4,
        ) -> Result<Candidate> {
            tokio::time::timeout(Duration::from_secs(3), async {
                while let Some(event) = events.recv().await {
                    if let Event::Candidate(id, c, _) = event {
                        if id == pair
                            && c.addr() == SocketAddr::V4(addr)
                            && c.kind() == CandidateKind::ServerReflexive
                        {
                            return Ok(c);
                        }
                    }
                }
                Err(anyhow!("candidate publisher closed"))
            })
            .await?
        }
        let mapped1 = mapped(&mut events, first.id, published).await?;
        driver.create_pair(&second).await?;
        let mapped2 = mapped(&mut events, second.id, published).await?;
        ensure!(
            mapped1.local() == local
                && mapped2.local() == local
                && mapped1.ufrag() != mapped2.ufrag()
        );
        ensure!(started.try_recv().is_err());
        let a = driver.pairs[&first.id].pc.clone();
        let b = driver.pairs[&second.id].pc.clone();
        let remote = || -> Result<Runtime> {
            Ok(Runtime::new(Some(ServerUdp::bind(&[(
                SocketAddr::new(local.ip(), 0),
                None,
            )])?)))
        };
        let peer1 = remote()?;
        let peer2 = remote()?;
        let (r1, mut rx1) = endpoint(&peer1, first.id).await?;
        let (r2, mut rx2) = endpoint(&peer2, second.id).await?;
        let ((tx1, dc1), (tx2, dc2)) =
            tokio::try_join!(open(&a, &r1, &mut rx1), open(&b, &r2, &mut rx2))?;
        tokio::try_join!(exchange(&tx1, &dc1, "one"), exchange(&tx2, &dc2, "two"))?;
        tokio::try_join!(
            exchange(&dc1, &tx1, "one-return"),
            exchange(&dc2, &tx2, "two-return")
        )?;
        let wildcard = SocketAddrV4::new(std::net::Ipv4Addr::UNSPECIFIED, local.port());
        ensure!(std::net::UdpSocket::bind(wildcard).is_err());
        driver
            .retire_pair(
                first.id,
                crate::diagnostics::RetirementReason::ProjectionRemoved,
            )
            .await;
        ensure!(updates.receiver_count() == 1 && a.connection_metrics().await.is_err());
        ensure!(std::net::UdpSocket::bind(wildcard).is_err());
        exchange(&tx2, &dc2, "survivor").await?;
        exchange(&dc2, &tx2, "survivor-return").await?;
        let changed = SocketAddrV4::new(std::net::Ipv4Addr::new(127, 0, 0, 2), local.port());
        updates.send(Some(changed))?;
        ensure!(mapped(&mut events, second.id, changed).await?.local() == local);
        let mut successor = second.clone();
        successor.id = Uuid::new_v4();
        // The normal plan update joins the removed RTC before adding its successor.
        driver.update(vec![successor.clone()], vec![], vec![]).await;
        let (new_local, next_updates) = started.try_recv()?;
        ensure!(updates.is_closed() && b.connection_metrics().await.is_err());
        if new_local.port() != local.port() {
            std::net::UdpSocket::bind(wildcard)?;
        }
        driver.update(vec![], vec![], vec![]).await;
        ensure!(next_updates.is_closed() && started.try_recv().is_err());
        std::net::UdpSocket::bind(SocketAddrV4::new(
            std::net::Ipv4Addr::UNSPECIFIED,
            new_local.port(),
        ))?;
        std::net::UdpSocket::bind(wildcard)?;
        r1.close().await?;
        r2.close().await?;
        peer1.close().await;
        peer2.close().await;
        driver.transport.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn unavailable_gateway_does_not_keep_a_mapping_service() -> Result<()> {
        let (runtime, local) = Runtime::fixed_loopback()?;
        let base = Candidate::host(local, "udp")?;
        let (transport, _events) = endpoint(&runtime, Uuid::new_v4()).await?;
        let tasks = tokio::runtime::Handle::current().metrics();
        let before = tasks.num_alive_tasks();
        let mut mapping =
            Mapping::with_lookup(base, transport.clone(), tokio::spawn(async { None }));
        (&mut mapping.watcher).await?;
        ensure!(mapping.candidates.is_closed());
        ensure!(tasks.num_alive_tasks() == before);
        drop(mapping);
        transport.close().await?;
        runtime.close().await;
        Ok(())
    }

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
            driver.create_pair(&plan).await?;
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
            client: Arc::new(OnceLock::from(Client::default())),
            candidates,
            watcher: tokio::spawn(forward(base, addresses, retired.clone())),
        });
        let held = driver.files.hold_queue_capacity().await;
        let mut retirement = Box::pin(
            driver.retire_pair(id, crate::diagnostics::RetirementReason::ProjectionRemoved),
        );
        tokio::select! {
            _ = &mut retirement => panic!("file detach unexpectedly completed"),
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
        driver
            .retire_pair(
                sibling,
                crate::diagnostics::RetirementReason::ProjectionRemoved,
            )
            .await;
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
        let (transport, mut results) = endpoint(&runtime, Uuid::new_v4()).await?;
        while results.try_recv().is_ok() {}
        let mut mapping = Mapping::with_lookup(wrong, transport.clone(), lookup);
        mapping.observe(&expected);
        waiting.await?;
        mapping.close().await;
        ensure!(mapping.watcher.is_finished() && mapping.candidates.is_closed());
        ensure!(mapping.client.get().is_none());
        transport.close().await?;
        runtime.close().await;
        while results.try_recv().is_ok() {}
        ensure!(
            results.recv().await.is_none(),
            "retired lookup retained its publisher"
        );
        release.send(())?;
        complete.await?;
        ensure!(mapping.client.get().is_none());
        ensure!(
            results.recv().await.is_none(),
            "late lookup published after retirement"
        );
        Ok(())
    }

    #[tokio::test]
    async fn mapped_updates_keep_the_bound_base_and_cancel_the_publisher() -> Result<()> {
        let (runtime, local) = Runtime::fixed_loopback()?;
        let base = Candidate::host(local, "udp")?;
        let pair = Uuid::new_v4();
        let (transport, mut received) = endpoint(&runtime, pair).await?;
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
        let description = transport.offer()
            .await?
            .and_then(|offer| offer.sdp)
            .ok_or_else(|| anyhow!("missing local offer"))?;
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
