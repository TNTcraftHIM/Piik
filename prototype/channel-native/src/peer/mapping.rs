//! Optional default-gateway mapping for one connection's actual IPv4 socket.
use super::{Event, MAX_ICE_CANDIDATES};
use netwatch::interfaces::HomeRouter;
use portmapper::Client;
use rtc::peer_connection::transport::{CandidateConfig, CandidateServerReflexiveConfig};
use std::{
    net::{IpAddr, SocketAddrV4},
    num::NonZeroU16,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use uuid::Uuid;
use webrtc::peer_connection::{RTCIceCandidate, RTCIceCandidateType, RTCIceProtocol};

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
        Some(Self::with_lookup(pair, base, events, tokio::task::spawn_blocking(HomeRouter::new)))
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
        candidates.try_send(base).expect("new mapping candidate queue is empty");
        let client = Client::default();
        let worker = client.clone();
        let watcher = tokio::spawn(async move {
            let Some(base) = select_base(lookup, pending).await else { return };
            let port = NonZeroU16::new(base.port).expect("eligible host candidate has a port");
            let addresses = worker.watch_external_address();
            let _ = worker.probe().await;
            worker.update_local_port(port);
            forward(pair, base, addresses, events).await;
        });
        Self { client, candidates, watcher }
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
    let HomeRouter { gateway: IpAddr::V4(_), my_ip: Some(IpAddr::V4(local)) } =
        lookup.await.ok()?? else { return None };
    while let Some(candidate) = candidates.recv().await {
        if candidate.address.parse::<std::net::Ipv4Addr>().ok() == Some(local) {
            return Some(candidate);
        }
    }
    None
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
        let Ok(candidate) = (CandidateServerReflexiveConfig {
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
        })
        .new_candidate_server_reflexive() else {
            continue;
        };
        if events
            .send(Event::Candidate(pair, RTCIceCandidate::from(&candidate)))
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
    use crate::peer::Handler;
    use anyhow::{anyhow, ensure, Result};
    use std::{
        net::UdpSocket,
        sync::{
            atomic::{AtomicBool, AtomicU8},
            Arc,
        },
        time::Duration,
    };
    use tokio::sync::oneshot;
    use webrtc::{
        data_channel::{DataChannel, DataChannelEvent},
        peer_connection::{PeerConnection, PeerConnectionBuilder, RTCPeerConnectionState},
    };

    async fn receive(channel: &dyn DataChannel, expected: &str) -> Result<()> {
        while let Some(event) = channel.poll().await {
            if let DataChannelEvent::OnMessage(message) = event {
                ensure!(
                    message.data.as_ref() == expected.as_bytes(),
                    "wrong DC message"
                );
                return Ok(());
            }
        }
        Err(anyhow!("channel ended before delivery"))
    }

    #[tokio::test]
    async fn gateway_lookup_yields_accepts_later_candidates_and_retires() -> Result<()> {
        fn host(address: &str, port: u16) -> Result<RTCIceCandidate> {
            Ok(RTCIceCandidate::from(&rtc::peer_connection::transport::CandidateHostConfig {
                base_config: CandidateConfig {
                    network: "udp".into(), address: address.into(), port, component: 1,
                    ..Default::default()
                },
                ..Default::default()
            }.new_candidate_host()?))
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
        ensure!(timer.elapsed() < Duration::from_millis(500), "gateway lookup blocked the reactor");
        eprintln!("gateway lookup pending: 100ms timer completed in {}ms", timer.elapsed().as_millis());
        ensure!(!selected.is_finished());
        release.send(())?;
        let base = selected.await?.ok_or_else(|| anyhow!("later gateway candidate was lost"))?;
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
        ensure!(results.recv().await.is_none(), "retired lookup retained its publisher");
        release.send(())?;
        complete.await?;
        ensure!(results.recv().await.is_none(), "late lookup published after retirement");
        Ok(())
    }

    #[tokio::test]
    async fn mapped_candidates_use_the_bound_socket_and_retire_the_watcher() -> Result<()> {
        let pair = Uuid::new_v4();
        let remote = Uuid::new_v4();
        let (events, mut incoming) = mpsc::channel(64);
        let handler = |pair| {
            Arc::new(Handler {
                pair,
                events: events.clone(),
                overflow: Arc::new(AtomicBool::new(false)),
                state: Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8)),
            })
        };
        let local = PeerConnectionBuilder::new()
            .with_udp_addrs(vec!["127.0.0.1:0".to_owned()])
            .with_handler(handler(pair))
            .build()
            .await?;
        let peer = PeerConnectionBuilder::new()
            .with_udp_addrs(vec!["127.0.0.1:0".to_owned()])
            .with_handler(handler(remote))
            .build()
            .await?;
        let mut mapping = None;
        let mut stop = None;
        let mut proxy_task = None;
        let mut bound_ports = None;

        let result = tokio::time::timeout(Duration::from_secs(10), async {
            let sent = local.create_data_channel("gateway mapping", None).await?;
            // Original SDP has no gathered candidates. Never signal either host
            // candidate; the one remote srflx below must establish this path.
            let offer = local.create_offer(None).await?;
            ensure!(!offer.sdp.contains("a=candidate:"));
            local.set_local_description(offer.clone()).await?;
            peer.set_remote_description(offer).await?;
            let answer = peer.create_answer(None).await?;
            ensure!(!answer.sdp.contains("a=candidate:"));
            peer.set_local_description(answer.clone()).await?;
            local.set_remote_description(answer).await?;
            let base = loop {
                if let Event::Candidate(id, candidate) = incoming.recv().await.unwrap() {
                    if id == pair && candidate.typ == RTCIceCandidateType::Host {
                        break candidate;
                    }
                }
            };
            let inside = (base.address.parse::<std::net::Ipv4Addr>()?, base.port).into();
            let proxy = tokio::net::UdpSocket::bind("127.0.0.1:0").await?;
            let IpAddr::V4(ip) = proxy.local_addr()?.ip() else { unreachable!() };
            let outside = SocketAddrV4::new(ip, proxy.local_addr()?.port());
            bound_ports = Some((inside, outside));
            let (stopping, mut stopped) = oneshot::channel();
            stop = Some(stopping);
            proxy_task = Some(tokio::spawn(async move {
                let mut remote = None;
                let mut bytes = [0u64; 2];
                let mut buffer = vec![0u8; 65535];
                loop {
                    tokio::select! {
                        _ = &mut stopped => break,
                        packet = proxy.recv_from(&mut buffer) => {
                            let (n, source) = packet?;
                            let target = if source == inside {
                                bytes[0] += n as u64;
                                remote.ok_or_else(|| anyhow!("local sent before mapped path opened"))?
                            } else {
                                ensure!(remote.is_none_or(|known| known == source));
                                remote = Some(source);
                                bytes[1] += n as u64;
                                inside
                            };
                            proxy.send_to(&buffer[..n], target).await?;
                        }
                    }
                }
                Ok::<_, anyhow::Error>(bytes)
            }));

            let (addresses, updates) = watch::channel(None);
            let (mapped, mut candidates) = mpsc::channel(1);
            // A real idle client is never probed in this protocol fixture.
            let (candidate_input, _) = mpsc::channel(MAX_ICE_CANDIDATES);
            mapping = Some(Mapping {
                candidates: candidate_input,
                client: Client::default(),
                watcher: tokio::spawn(forward(pair, base.clone(), updates, mapped)),
            });
            addresses.send(Some(outside))?;
            let Some(Event::Candidate(id, candidate)) = candidates.recv().await else {
                return Err(anyhow!("mapping worker stopped"));
            };
            ensure!(id == pair && candidate.typ == RTCIceCandidateType::Srflx);
            ensure!(candidate.address == outside.ip().to_string() && candidate.port == outside.port());
            ensure!(candidate.related_address == base.address && candidate.related_port == base.port);
            ensure!(candidate.priority > 0 && candidate.priority < base.priority && !candidate.foundation.is_empty());
            peer.add_ice_candidate(candidate.to_json()?).await?;
            let received = loop {
                if let Event::Channel(id, channel) = incoming.recv().await.unwrap() {
                    if id == remote { break channel; }
                }
            };
            while let Some(event) = sent.poll().await {
                if matches!(event, DataChannelEvent::OnOpen) { break; }
            }
            sent.send_text("through mapped port").await?;
            receive(&*received, "through mapped port").await?;
            received.send_text("return through mapping").await?;
            receive(&*sent, "return through mapping").await?;
            for pc in [&local, &peer] {
                let ice = pc.sctp().await.unwrap().transport().ice_transport();
                let selected = ice.get_selected_candidate_pair().await?.unwrap();
                ensure!(selected.remote().port == outside.port(), "ICE bypassed proxy");
            }
            let locals = local.sctp().await.unwrap().transport().ice_transport().get_local_candidates().await?;
            ensure!(locals.len() == 1 && locals[0].typ == RTCIceCandidateType::Host);
            ensure!(locals[0].port == base.port);
            ensure!(UdpSocket::bind(inside).is_err());

            addresses.send(None)?;
            ensure!(tokio::time::timeout(Duration::from_millis(25), candidates.recv()).await.is_err());
            // Renewal changes the published external endpoint, not its socket base.
            let renewed = UdpSocket::bind("127.0.0.1:0")?;
            let std::net::SocketAddr::V4(renewed_address) = renewed.local_addr()? else { unreachable!() };
            addresses.send(Some(renewed_address))?;
            let Some(Event::Candidate(id, candidate)) = candidates.recv().await else {
                return Err(anyhow!("renewal worker stopped"));
            };
            ensure!(id == pair && candidate.port == renewed_address.port());
            ensure!(candidate.related_port == base.port && candidate.related_address == base.address);
            mapping.as_mut().unwrap().close().await;
            ensure!(mapping.as_ref().unwrap().watcher.is_finished());
            ensure!(addresses.send(Some(outside)).is_err());
            ensure!(candidates.recv().await.is_none());
            // Retiring discovery does not close this established mapped path.
            sent.send_text("after watcher retirement").await?;
            receive(&*received, "after watcher retirement").await?;
            Ok::<_, anyhow::Error>(())
        }).await;

        if let Some(mut mapping) = mapping {
            // The successful path already joined it; do not await a JoinHandle twice.
            if !mapping.watcher.is_finished() {
                mapping.close().await;
            }
        }
        let local_closed = local.close().await;
        let peer_closed = peer.close().await;
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
        let proxy_result = if let Some(task) = proxy_task {
            Some(task.await?)
        } else {
            None
        };
        result??;
        local_closed?;
        peer_closed?;
        let bytes = proxy_result.unwrap()?;
        ensure!(
            bytes[0] > 0 && bytes[1] > 0,
            "proxy did not carry both directions"
        );
        let (inside, outside) = bound_ports.unwrap();
        UdpSocket::bind(inside)?;
        UdpSocket::bind(outside)?;
        eprintln!(
            "mapped PC bytes: local-to-peer={}, peer-to-local={}",
            bytes[0], bytes[1]
        );
        Ok(())
    }
}
