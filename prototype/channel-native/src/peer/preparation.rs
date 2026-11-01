//! Pair-scoped preparation only. ICE/DTLS/media remain owned by the existing PC.
use super::NativeEvent;
use anyhow::{bail, ensure, Result};
use futures_util::{stream::FuturesUnordered, StreamExt};
use piik_channel_core::wire::UdpPrediction as Prediction;
use piik_channel_core::{
    udp::StunServer,
    wire::{Command, PairInfo, Signal, UdpSignal},
};
use rtc_shared::{TaggedBytesMut, TransportContext, TransportProtocol};
use rtc_stun::{
    agent::StunEvent,
    client::{ClientBuilder, TaggedMessage},
    fingerprint::FINGERPRINT,
    integrity::MessageIntegrity,
    message::{Getter, Message, Setter, TransactionId, BINDING_REQUEST, BINDING_SUCCESS},
    xoraddr::XorMappedAddress,
};
use sansio::Protocol;
use std::{
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::{Duration, Instant},
};
use tokio::{
    net::UdpSocket,
    sync::mpsc,
    task::JoinHandle,
    time::{sleep_until, timeout_at},
};
use uuid::Uuid;

const CHECK_PACKET_BUDGET: usize = 64;

pub(super) async fn local_ipv4() -> Option<Ipv4Addr> {
    let router = tokio::task::spawn_blocking(netwatch::interfaces::HomeRouter::new)
        .await
        .ok()
        .flatten()?;
    match router.my_ip {
        Some(std::net::IpAddr::V4(ip)) => Some(ip),
        _ => None,
    }
}

pub(super) struct Pending {
    pub plan: PairInfo,
    pub signals: Vec<Signal>,
    input: mpsc::Sender<UdpSignal>,
    pub task: JoinHandle<Result<Prepared>>,
}

impl Pending {
    pub fn start(
        local: Uuid,
        plan: PairInfo,
        servers: Vec<StunServer>,
        commands: mpsc::Sender<NativeEvent>,
    ) -> Self {
        let (input, incoming) = mpsc::channel(4);
        let pair = plan.id;
        let initiator = local < plan.peer_id;
        let deadline = Instant::now() + Duration::from_secs(5);
        let task = tokio::spawn(async move {
            timeout_at(
                deadline.into(),
                negotiate(pair, initiator, servers, commands, incoming, deadline),
            )
            .await?
        });
        Self {
            plan,
            signals: vec![],
            input,
            task,
        }
    }

    pub fn signal(&mut self, signal: Signal) -> Result<()> {
        if let Some(message) = signal.udp {
            self.input.try_send(message)?;
        } else {
            // The peer may finish preparation first and immediately start ICE.
            ensure!(self.signals.len() < 128, "preparation signaling queue full");
            self.signals.push(signal);
        }
        Ok(())
    }

    pub async fn close(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

pub(super) async fn next(
    pending: &mut std::collections::HashMap<Uuid, Pending>,
) -> Option<(Uuid, Result<Result<Prepared>, tokio::task::JoinError>)> {
    pending
        .iter_mut()
        .map(|(id, entry)| async move { (*id, (&mut entry.task).await) })
        .collect::<FuturesUnordered<_>>()
        .next()
        .await
}

async fn negotiate(
    pair: Uuid,
    initiator: bool,
    servers: Vec<StunServer>,
    commands: mpsc::Sender<NativeEvent>,
    mut incoming: mpsc::Receiver<UdpSignal>,
    deadline: Instant,
) -> Result<Prepared> {
    let local = local_ipv4()
        .await
        .ok_or_else(|| anyhow::anyhow!("no default IPv4 interface for UDP preparation"))?;
    let servers = resolve_servers(servers, |server| async move {
        tokio::net::lookup_host((server.host, server.port)).await
    })
    .await?;
    let (survey, remote) = if initiator {
        let mut secret = [0; 32];
        getrandom::fill(&mut secret)
            .map_err(|error| anyhow::anyhow!("preparation secret: {error}"))?;
        let survey = Preparation::new(pair, secret, local, deadline)?
            .survey(servers)
            .await?;
        send(
            &commands,
            pair,
            UdpSignal::Offer {
                secret,
                prediction: survey.prediction,
            },
        )
        .await?;
        let Some(UdpSignal::Answer { prediction }) = incoming.recv().await else {
            bail!("expected UDP preparation answer");
        };
        (survey, prediction)
    } else {
        let Some(UdpSignal::Offer { secret, prediction }) = incoming.recv().await else {
            bail!("expected UDP preparation offer");
        };
        let survey = Preparation::new(pair, secret, local, deadline)?
            .survey(servers)
            .await?;
        send(
            &commands,
            pair,
            UdpSignal::Answer {
                prediction: survey.prediction,
            },
        )
        .await?;
        (survey, prediction)
    };
    survey.check(remote, &commands, &mut incoming).await
}

async fn send(commands: &mpsc::Sender<NativeEvent>, pair: Uuid, udp: UdpSignal) -> Result<()> {
    commands
        .send(NativeEvent::Command(Command::Signal {
            pair_id: pair,
            payload: Signal {
                udp: Some(udp),
                description: None,
                exchange_id: None,
                candidate: None,
                tracks: None,
                resync: None,
            },
        }))
        .await
        .map_err(anyhow::Error::from)
}

async fn resolve_servers<F, A>(
    servers: Vec<StunServer>,
    lookup: impl Fn(StunServer) -> F,
) -> Result<[SocketAddrV4; 3]>
where
    F: std::future::Future<Output = std::io::Result<A>>,
    A: IntoIterator<Item = SocketAddr>,
{
    let mut queries: FuturesUnordered<_> = servers
        .into_iter()
        .take(super::MAX_ICE_CANDIDATES)
        .map(lookup)
        .collect();
    let mut selected = Vec::with_capacity(3);
    while let Some(result) = queries.next().await {
        let Ok(addresses) = result else { continue };
        // Each authority contributes one distinct IPv4 destination, as before.
        if let Some(address) = addresses.into_iter().find_map(|address| match address {
            SocketAddr::V4(address)
                if !address.ip().is_unspecified()
                    && !address.ip().is_multicast()
                    && !address.ip().is_broadcast()
                    && !selected.contains(&address) =>
            {
                Some(address)
            }
            _ => None,
        }) {
            selected.push(address);
            if selected.len() == 3 {
                return Ok(selected.try_into().unwrap());
            }
        }
    }
    bail!("three distinct IPv4 STUN destinations unavailable")
}

/// Owned by one authorized pair attempt. Dropping its future drops all work:
/// no detached readers, workers, or deadlines survive socket transfer.
pub struct Preparation {
    pair: Uuid,
    secret: [u8; 32],
    local: Ipv4Addr,
    expires: Instant,
}
pub struct Survey {
    preparation: Preparation,
    pub prediction: Prediction,
    retained: Option<UdpSocket>,
}
pub struct Prepared {
    pair: Uuid,
    expires: Instant,
    socket: UdpSocket,
    remote: SocketAddrV4,
}
impl Preparation {
    pub fn new(pair: Uuid, secret: [u8; 32], local: Ipv4Addr, expires: Instant) -> Result<Self> {
        ensure!(
            !local.is_unspecified() && !local.is_multicast(),
            "concrete local address required"
        );
        Ok(Self {
            pair,
            secret,
            local,
            expires,
        })
    }
    pub async fn survey(self, servers: [SocketAddrV4; 3]) -> Result<Survey> {
        ensure!(
            servers[0] != servers[1] && servers[1] != servers[2] && servers[0] != servers[2],
            "three distinct STUN destinations required"
        );
        let deadline = self
            .expires
            .min(Instant::now() + Duration::from_millis(1500));
        timeout_at(deadline.into(), async move {
            let socket = UdpSocket::bind((self.local, 0)).await?;
            let mut observations = Vec::with_capacity(3);
            for server in servers {
                observations.push(binding(&socket, server.into()).await?);
            }
            let [a, b, c] = observations.as_slice() else {
                unreachable!()
            };
            let step = i32::from(c.port()) - i32::from(b.port());
            ensure!(
                a.ip() == b.ip()
                    && b.ip() == c.ip()
                    && (0..=16).contains(&step)
                    && i32::from(b.port()) - i32::from(a.port()) == step,
                "no usable ordered mapping observation"
            );
            let prediction = Prediction {
                address: *c.ip(),
                port: c.port(),
                step: step as u16,
            };
            // The public peer target is checked when supplied by signaling.
            Ok(Survey {
                preparation: self,
                prediction,
                retained: (step == 0).then_some(socket),
            })
        })
        .await?
    }
}
impl Survey {
    pub async fn check(
        self,
        remote: Prediction,
        commands: &mpsc::Sender<NativeEvent>,
        incoming: &mut mpsc::Receiver<UdpSignal>,
    ) -> Result<Prepared> {
        self.check_target(
            remote
                .target()
                .ok_or_else(|| anyhow::anyhow!("unsupported peer mapping address"))?,
            commands,
            incoming,
        )
        .await
    }
    async fn check_target(
        self,
        remote: SocketAddrV4,
        commands: &mpsc::Sender<NativeEvent>,
        incoming: &mut mpsc::Receiver<UdpSignal>,
    ) -> Result<Prepared> {
        let Survey {
            preparation,
            retained,
            ..
        } = self;
        let deadline = preparation.expires;
        timeout_at(deadline.into(), async move {
            let mut sockets = Vec::new();
            if let Some(socket) = retained {
                sockets.push(socket);
            } else {
                for _ in 0..8 { sockets.push(UdpSocket::bind((preparation.local, 0)).await?); }
            }
            let provider = rtc_crypto::default_provider()?;
            // Preserve 2.x short-term STUN integrity: lowercase hex of the pair secret.
            let key: String = preparation.secret.iter().map(|byte| format!("{byte:02x}")).collect();
            let integrity = MessageIntegrity::new_short_term_integrity_with_provider(
                key.clone(), provider.crypto());
            let mut requests = Vec::new();
            for _ in &sockets {
                let mut request = Message::new();
                request.build(&[Box::new(BINDING_REQUEST), Box::new(TransactionId::new())])?;
                integrity.add_to(&mut request)?;
                FINGERPRINT.add_to(&mut request)?;
                requests.push(request);
            }
            let mut reads: FuturesUnordered<_> = sockets.iter().enumerate().map(|(i,s)| receive(i,s)).collect();
            let start = Instant::now();
            let mut round = 0;
            let mut replies = 0;
            let mut winner = None;
            let mut peer_complete = false;
            // Initial fanout and authenticated triggered retries share one budget.
            let mut requests_left = CHECK_PACKET_BUDGET;
            let index = loop {
                if peer_complete {
                    if let Some(index) = winner { break index; }
                }
                tokio::select! {
                    _ = sleep_until((start + Duration::from_millis(round * 100)).into()), if round < 7 && requests_left > 0 => {
                        for (socket, request) in sockets.iter().zip(&requests).take(requests_left) {
                            socket.send_to(&request.raw, remote).await?;
                            requests_left -= 1;
                        }
                        round += 1;
                    },
                    message = incoming.recv(), if !peer_complete => {
                        ensure!(matches!(message, Some(UdpSignal::Complete)), "expected peer preparation completion");
                        peer_complete = true;
                    },
                    Some(received) = reads.next() => {
                        let (index, bytes, peer) = received?;
                        reads.push(receive(index, &sockets[index]));
                        if peer != SocketAddr::V4(remote) { continue; }
                        let mut message = Message { raw: bytes, ..Default::default() };
                        if message.decode().is_err() || MessageIntegrity::check(&mut message, key.as_bytes(), provider.crypto()).is_err() { continue; }
                        if message.typ == BINDING_REQUEST && replies < CHECK_PACKET_BUDGET {
                            replies += 1;
                            let mut response = Message::new();
                            response.build(&[Box::new(BINDING_SUCCESS), Box::new(message.transaction_id),
                                Box::new(XorMappedAddress { ip: remote.ip().to_owned().into(), port: remote.port() })])?;
                            integrity.add_to(&mut response)?;
                            FINGERPRINT.add_to(&mut response)?;
                            sockets[index].send_to(&response.raw, remote).await?;
                            if winner.is_none() && requests_left > 0 {
                                sockets[index].send_to(&requests[index].raw, remote).await?;
                                requests_left -= 1;
                            }
                        } else if message.typ == BINDING_SUCCESS && message.transaction_id == requests[index].transaction_id {
                            if winner.is_none() {
                                winner = Some(index);
                                send(commands, preparation.pair, UdpSignal::Complete).await?;
                            }
                        }
                    }
                }
            };
            // The same owner answers until both peers have proved their tuple.
            // Every preparation reader retires before the socket moves to ICE.
            drop(reads);
            let socket = sockets.swap_remove(index);
            Ok(Prepared { pair: preparation.pair, expires: preparation.expires, socket, remote })
        }).await?
    }
}
impl Prepared {
    /// Call only after mutual success on this still-current authorized pair.
    /// The consuming socket goes to the existing PC; the tuple becomes a remote ICE candidate.
    pub fn commit(self, current_pair: Uuid) -> Result<(std::net::UdpSocket, SocketAddrV4)> {
        ensure!(
            self.pair == current_pair && Instant::now() < self.expires,
            "pair preparation retired"
        );
        Ok((self.socket.into_std()?, self.remote))
    }
}
async fn receive(
    index: usize,
    socket: &UdpSocket,
) -> std::io::Result<(usize, Vec<u8>, SocketAddr)> {
    let mut bytes = vec![0; 1024];
    let (n, peer) = loop {
        match socket.recv_from(&mut bytes).await {
            // An earlier probe can reach the peer before its mapping exists.
            // ICMP rejects that datagram, not this socket or the finite check.
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                continue
            }
            result => break result?,
        }
    };
    bytes.truncate(n);
    Ok((index, bytes, peer))
}
async fn binding(socket: &UdpSocket, remote: SocketAddr) -> Result<SocketAddrV4> {
    let local = socket.local_addr()?;
    let mut client =
        ClientBuilder::new().build(Instant::now(), local, remote, TransportProtocol::UDP)?;
    let mut request = Message::new();
    request.build(&[Box::new(BINDING_REQUEST), Box::new(TransactionId::new())])?;
    client.handle_write(TaggedMessage {
        now: Instant::now(),
        message: request,
    })?;
    loop {
        if let Some(event) = client.poll_event() {
            let StunEvent::Message(message) = event else {
                bail!("STUN survey transaction failed")
            };
            ensure!(message.typ == BINDING_SUCCESS, "STUN binding rejected");
            let mut address = XorMappedAddress::default();
            address.get_from(&message)?;
            let std::net::IpAddr::V4(ip) = address.ip else {
                bail!("IPv4 observation required")
            };
            return Ok(SocketAddrV4::new(ip, address.port));
        }
        while let Some(packet) = client.poll_write() {
            socket
                .send_to(&packet.message, packet.transport.peer_addr)
                .await?;
        }
        let deadline = client
            .poll_timeout()
            .ok_or_else(|| anyhow::anyhow!("STUN transaction ended"))?;
        let mut buffer = [0; 1024];
        tokio::select! {
            _ = sleep_until(deadline.into()) => client.handle_timeout(Instant::now())?,
            result = socket.recv_from(&mut buffer) => {
                let (n, peer) = result?;
                if peer == remote {
                    let _ = client.handle_read(TaggedBytesMut { now: Instant::now(),
                        transport: TransportContext { local_addr: local, peer_addr: peer, ecn: None, transport_protocol: TransportProtocol::UDP },
                        message: buffer[..n].into() });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn preparation_dns_fallback_does_not_wait_for_failed_or_stalled_authorities() -> Result<()>
    {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        struct PendingLookup(Arc<AtomicUsize>);
        impl Drop for PendingLookup {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let servers = |names: &[&str]| {
            names
                .iter()
                .map(|name| StunServer {
                    host: name.to_string(),
                    port: 3478,
                })
                .collect()
        };
        let cancelled = Arc::new(AtomicUsize::new(0));
        let selected = tokio::time::timeout(
            Duration::from_secs(5),
            resolve_servers(
                servers(&["failed", "stalled", "one", "alias", "two", "three"]),
                |server| {
                    let cancelled = cancelled.clone();
                    async move {
                        match server.host.as_str() {
                            "failed" => Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
                            "stalled" => {
                                let _pending = PendingLookup(cancelled);
                                std::future::pending::<std::io::Result<Vec<SocketAddr>>>().await
                            }
                            name => Ok(vec![SocketAddr::from((
                                match name {
                                    "one" | "alias" => [192, 0, 2, 1],
                                    "two" => [192, 0, 2, 2],
                                    _ => [192, 0, 2, 3],
                                },
                                server.port,
                            ))]),
                        }
                    }
                },
            ),
        )
        .await??;
        assert_eq!(
            selected.map(|address| *address.ip()),
            [
                Ipv4Addr::new(192, 0, 2, 1),
                Ipv4Addr::new(192, 0, 2, 2),
                Ipv4Addr::new(192, 0, 2, 3),
            ]
        );
        assert_eq!(
            cancelled.load(Ordering::SeqCst),
            1,
            "unused lookup survived selection"
        );

        let mut resolving = Box::pin(resolve_servers(servers(&["one", "two", "three"]), |_| {
            let cancelled = cancelled.clone();
            async move {
                let _pending = PendingLookup(cancelled);
                std::future::pending::<std::io::Result<Vec<SocketAddr>>>().await
            }
        }));
        assert!(futures_util::poll!(resolving.as_mut()).is_pending());
        drop(resolving);
        assert_eq!(
            cancelled.load(Ordering::SeqCst),
            4,
            "cancelled pair retained lookups"
        );
        Ok(())
    }

    #[tokio::test]
    async fn local_interface_lookup_keeps_the_reactor_running() -> Result<()> {
        let lookup = tokio::spawn(local_ipv4());
        let timer = Instant::now();
        tokio::time::sleep(Duration::from_millis(100)).await;
        ensure!(
            timer.elapsed() < Duration::from_millis(500),
            "interface lookup blocked the reactor"
        );
        eprintln!(
            "preparation interface lookup: 100ms timer={}ms pending={}",
            timer.elapsed().as_millis(),
            !lookup.is_finished()
        );
        let _ = lookup.await?;
        Ok(())
    }

    #[tokio::test]
    async fn peer_binding_after_first_probe_survives_udp_icmp() -> Result<()> {
        let (commands, mut events) = mpsc::channel(4);
        let (complete, mut incoming) = mpsc::channel(4);
        let reserved = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let SocketAddr::V4(remote) = reserved.local_addr()? else {
            unreachable!()
        };
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let local = socket.local_addr()?;
        drop(reserved);
        let peer = tokio::spawn(async move {
            // The first probes reach a real closed kernel UDP port, generating
            // Windows ICMP/WSAECONNRESET before the peer creates its mapping.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let socket = UdpSocket::bind(remote).await?;
            let provider = rtc_crypto::default_provider()?;
            let key: String = [39; 32].iter().map(|byte| format!("{byte:02x}")).collect();
            let integrity = MessageIntegrity::new_short_term_integrity_with_provider(
                key.clone(),
                provider.crypto(),
            );
            let mut complete = Some(complete);
            loop {
                let (_, bytes, from) = receive(0, &socket).await?;
                let mut request = Message {
                    raw: bytes,
                    ..Default::default()
                };
                request.decode()?;
                MessageIntegrity::check(&mut request, key.as_bytes(), provider.crypto())?;
                let mut response = Message::new();
                response.build(&[Box::new(BINDING_SUCCESS), Box::new(request.transaction_id)])?;
                integrity.add_to(&mut response)?;
                socket.send_to(&response.raw, from).await?;
                if let Some(complete) = complete.take() {
                    complete.send(UdpSignal::Complete).await?;
                }
            }
            #[allow(unreachable_code)]
            Ok::<_, anyhow::Error>(())
        });
        let pair = Uuid::new_v4();
        let survey = Survey {
            preparation: Preparation::new(
                pair,
                [39; 32],
                Ipv4Addr::LOCALHOST,
                Instant::now() + Duration::from_secs(5),
            )?,
            prediction: Prediction {
                address: Ipv4Addr::LOCALHOST,
                port: local.port(),
                step: 0,
            },
            retained: Some(socket),
        };
        // The fixture alone bypasses the public peer-IP gate for loopback.
        let result = survey.check_target(remote, &commands, &mut incoming).await;
        peer.abort();
        let _ = peer.await;
        let prepared = result?;
        assert!(matches!(
            events.try_recv()?,
            NativeEvent::Command(Command::Signal {
                payload: Signal {
                    udp: Some(UdpSignal::Complete),
                    ..
                },
                ..
            })
        ));
        let (socket, target) = prepared.commit(pair)?;
        assert_eq!(target, remote);
        assert_eq!(socket.local_addr()?, local);
        drop(socket);
        std::net::UdpSocket::bind(local)?;
        Ok(())
    }

    #[tokio::test]
    async fn late_peer_uses_triggered_check_and_mutual_completion() -> Result<()> {
        let pair = Uuid::new_v4();
        let first = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let second = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let SocketAddr::V4(first_address) = first.local_addr()? else {
            unreachable!()
        };
        let SocketAddr::V4(second_address) = second.local_addr()? else {
            unreachable!()
        };
        drop(second);
        let expires = Instant::now() + Duration::from_secs(5);
        let survey = |socket: UdpSocket| -> Result<Survey> {
            Ok(Survey {
                preparation: Preparation::new(pair, [51; 32], Ipv4Addr::LOCALHOST, expires)?,
                prediction: Prediction {
                    address: Ipv4Addr::LOCALHOST,
                    port: socket.local_addr()?.port(),
                    step: 0,
                },
                retained: Some(socket),
            })
        };
        let (first_commands, first_events) = mpsc::channel(4);
        let (second_commands, second_events) = mpsc::channel(4);
        let (to_first, mut first_input) = mpsc::channel(4);
        let (to_second, mut second_input) = mpsc::channel(4);
        async fn forward_complete(
            mut events: mpsc::Receiver<NativeEvent>,
            to: mpsc::Sender<UdpSignal>,
        ) -> Result<()> {
            let Some(NativeEvent::Command(Command::Signal {
                payload:
                    Signal {
                        udp: Some(UdpSignal::Complete),
                        ..
                    },
                ..
            })) = events.recv().await
            else {
                bail!("missing local tuple proof")
            };
            to.send(UdpSignal::Complete).await?;
            Ok(())
        }
        let first_survey = survey(first)?;
        let first_check =
            first_survey.check_target(second_address, &first_commands, &mut first_input);
        let second_check = async {
            // The first peer's complete initial fanout reaches a closed UDP port.
            tokio::time::sleep(Duration::from_millis(1200)).await;
            let second = UdpSocket::bind(second_address).await?;
            survey(second)?
                .check_target(first_address, &second_commands, &mut second_input)
                .await
        };
        let exchange = async {
            tokio::try_join!(
                forward_complete(first_events, to_second),
                forward_complete(second_events, to_first)
            )?;
            Ok::<_, anyhow::Error>(())
        };
        let (first, second, ()) = tokio::try_join!(first_check, second_check, exchange)?;
        let (first, first_peer) = first.commit(pair)?;
        let (second, second_peer) = second.commit(pair)?;
        assert_eq!(
            (first.local_addr()?, first_peer),
            (first_address.into(), second_address)
        );
        assert_eq!(
            (second.local_addr()?, second_peer),
            (second_address.into(), first_address)
        );
        drop((first, second));
        UdpSocket::bind(first_address).await?;
        UdpSocket::bind(second_address).await?;
        Ok(())
    }

    #[tokio::test]
    async fn failed_survey_enters_ordinary_transport_and_retires_the_owned_socket() -> Result<()> {
        use super::super::*;
        let (mut driver, _events, _commands, _stop) = tests::driver();
        let pair = Uuid::new_v4();
        let plan = PairInfo {
            id: pair,
            peer_id: Uuid::new_v4(),
            udp_preparation: Some(UdpPreparation::Required),
            can_receive_video_layers: false,
            rooms: vec!["prep-fallback".into()],
            incoming: vec![],
            outgoing: vec![],
        };
        let (input, _) = mpsc::channel(4);
        driver.preparings.insert(
            pair,
            Pending {
                plan: plan.clone(),
                signals: vec![],
                input,
                task: tokio::spawn(async { Err(anyhow::anyhow!("owned fixture survey failed")) }),
            },
        );
        let mut pending = driver.preparings.remove(&pair).unwrap();
        let result = (&mut pending.task).await;
        driver.prepared(pending, result).await;
        anyhow::ensure!(
            driver.preparings.is_empty() && driver.pairs.contains_key(&pair),
            "survey failure lost ordinary pair fallback"
        );
        anyhow::ensure!(
            driver.pairs[&pair].plan.udp_preparation == plan.udp_preparation,
            "fallback changed its authorized pair lease"
        );
        driver.retire_pair(pair).await;
        driver.files.close().await;
        driver.transport.close().await;
        Ok(())
    }
}
