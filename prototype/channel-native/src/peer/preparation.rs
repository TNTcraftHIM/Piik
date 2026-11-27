//! Pair-scoped preparation only. ICE/DTLS/media remain owned by the existing PC.
use super::NativeEvent;
use crate::diagnostics::{rtc_pair, MappingKind, PreparationStep, RtcPairEvent};
use anyhow::{bail, ensure, Result};
use futures_util::{stream::FuturesUnordered, StreamExt};
use piik_channel_core::wire::UdpObservation as Observation;
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
    collections::VecDeque,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::{Duration, Instant},
};
use tokio::{
    net::UdpSocket,
    sync::{mpsc, Semaphore},
    task::JoinHandle,
    time::{sleep_until, timeout_at},
};
use uuid::Uuid;

const CHECK_PACKET_BUDGET: usize = 64;
const RANDOM_PORTS: usize = 256;
// The searching side spends its requests on distinct ports: a repeated target
// adds no coverage, and coverage is what the hit probability depends on.
const RANDOM_TARGETS: usize = RANDOM_PORTS * 4;
const RANDOM_REQUEST_BUDGET: usize = RANDOM_TARGETS + 8;
const RANDOM_REPLY_BUDGET: usize = 16;
// The mean spacing of a schedule, not a sleep per packet: a timer that wakes on a
// coarser tick (15.6 ms on Windows) sends what is due and the rate holds.
const RANDOM_PACKET_INTERVAL: Duration = Duration::from_millis(2);
// Shared across every site and Driver in this process. Busy peers fall back;
// they do not queue another pool behind the current pair's deadline.
static RANDOM_PREPARATIONS: Semaphore = Semaphore::const_new(2);

pub(super) async fn local_ipv4() -> Option<Ipv4Addr> {
    // Preparation binds the OS-selected source address. Portmapper looks up the gateway.
    let address = tokio::task::spawn_blocking(netdev::net::ip::get_local_ipaddr)
        .await
        .ok()??;
    match address {
        std::net::IpAddr::V4(ip) => Some(ip),
        _ => None,
    }
}

pub(super) struct Pending {
    pub pair: Uuid,
    pub instance: Uuid,
    input: mpsc::Sender<UdpSignal>,
    pub refused: bool,
    pub task: JoinHandle<Result<Prepared>>,
}

impl Pending {
    pub fn start(
        local: Uuid,
        plan: &PairInfo,
        instance: Uuid,
        servers: Vec<StunServer>,
        commands: mpsc::Sender<NativeEvent>,
    ) -> Self {
        let (input, incoming) = mpsc::channel(4);
        let pair = plan.id;
        let initiator = local < plan.peer_id;
        rtc_pair(pair, RtcPairEvent::PreparationStarted { initiator });
        let deadline = Instant::now() + Duration::from_secs(5);
        let task = tokio::spawn(async move {
            let result = timeout_at(
                deadline.into(),
                negotiate(
                    pair,
                    initiator,
                    servers,
                    commands.clone(),
                    incoming,
                    deadline,
                ),
            )
            .await
            .map_err(anyhow::Error::from)
            .and_then(|result| result);
            if result.is_err() {
                // Failure notification must not extend the preparation deadline.
                let _ = commands.try_send(signal(pair, UdpSignal::Unavailable {}));
            }
            result
        });
        Self {
            pair,
            instance,
            input,
            refused: false,
            task,
        }
    }

    pub fn signal(&mut self, message: UdpSignal) -> Result<()> {
        if matches!(message, UdpSignal::Unavailable {}) {
            self.refused = true;
            self.task.abort();
        } else if matches!(self.input.try_send(message), Err(mpsc::error::TrySendError::Full(_))) {
            bail!("preparation signal queue full");
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
    rtc_pair(
        pair,
        RtcPairEvent::Preparation {
            step: PreparationStep::LocalAddress,
        },
    );
    let local = local_ipv4()
        .await
        .ok_or_else(|| anyhow::anyhow!("no default IPv4 interface for UDP preparation"))?;
    rtc_pair(
        pair,
        RtcPairEvent::Preparation {
            step: PreparationStep::StunResolution,
        },
    );
    let servers = resolve_servers(servers, |server| async move {
        tokio::net::lookup_host((server.host, server.port)).await
    })
    .await?;
    let (survey, remote) = exchange_observations(pair, initiator, local, servers, &commands, &mut incoming, deadline).await?;
    survey.check(remote, &commands, &mut incoming).await
}

async fn exchange_observations(
    pair: Uuid, initiator: bool, local: Ipv4Addr, servers: [SocketAddrV4; 3],
    commands: &mpsc::Sender<NativeEvent>, incoming: &mut mpsc::Receiver<UdpSignal>, deadline: Instant,
) -> Result<(Survey, Observation)> {
    let (observation, retained) = observe(pair, local, servers, deadline).await?;
    let (secret, remote) = if initiator {
        let mut secret = [0; 32];
        getrandom::fill(&mut secret)
            .map_err(|error| anyhow::anyhow!("preparation secret: {error}"))?;
        send(
            &commands,
            pair,
            UdpSignal::Offer {
                secret,
                observation,
            },
        )
        .await?;
        rtc_pair(
            pair,
            RtcPairEvent::Preparation {
                step: PreparationStep::PeerObservation,
            },
        );
        let Some(UdpSignal::Answer { observation }) = incoming.recv().await else {
            bail!("expected UDP preparation answer");
        };
        (secret, observation)
    } else {
        rtc_pair(
            pair,
            RtcPairEvent::Preparation {
                step: PreparationStep::PeerObservation,
            },
        );
        let Some(UdpSignal::Offer {
            secret,
            observation: remote,
        }) = incoming.recv().await
        else {
            bail!("expected UDP preparation offer");
        };
        send(
            &commands,
            pair,
            UdpSignal::Answer {
                observation,
            },
        )
        .await?;
        (secret, remote)
    };
    Ok((Survey { preparation: Preparation::new(pair,secret,local,deadline)?, observation,retained },remote))
}

async fn send(commands: &mpsc::Sender<NativeEvent>, pair: Uuid, udp: UdpSignal) -> Result<()> {
    commands
        .send(signal(pair, udp))
        .await
        .map_err(anyhow::Error::from)
}

pub(super) fn signal(pair: Uuid, udp: UdpSignal) -> NativeEvent {
    NativeEvent::Command(Command::Signal {
        pair_id: pair,
        payload: Signal {
            udp: Some(udp),
            description: None,
            exchange_id: None,
            candidate: None,
            tracks: None,
            resync: None,
        },
    })
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

/// This task prepares one extra candidate on an authorized, live pair.
/// Dropping its future releases the outstanding checks and sockets.
pub struct Preparation {
    pair: Uuid,
    secret: [u8; 32],
    local: Ipv4Addr,
    expires: Instant,
}
pub struct Survey {
    preparation: Preparation,
    pub observation: Observation,
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
}
async fn observe(pair:Uuid, local:Ipv4Addr, servers:[SocketAddrV4;3], expires:Instant) -> Result<(Observation,Option<UdpSocket>)> {
        rtc_pair(
            pair,
            RtcPairEvent::Preparation {
                step: PreparationStep::Survey,
            },
        );
        ensure!(
            servers[0] != servers[1] && servers[1] != servers[2] && servers[0] != servers[2],
            "three distinct STUN destinations required"
        );
        let deadline = expires
            .min(Instant::now() + Duration::from_millis(1500));
        timeout_at(deadline.into(), async move {
            let socket = UdpSocket::bind((local, 0)).await?;
            let mut observations = Vec::with_capacity(3);
            for server in servers {
                observations.push(binding(&socket, server.into()).await?);
            }
            let [a, b, c] = observations.as_slice() else {
                unreachable!()
            };
            let step = i32::from(c.port()) - i32::from(b.port());
            ensure!(
                a.ip() == b.ip() && b.ip() == c.ip(),
                "mapping addresses differ"
            );
            let observation = if a == b && b == c {
                Observation::Stable {
                    address: *c.ip(),
                    port: c.port(),
                }
            } else if step != 0
                && (-16..=16).contains(&step)
                && i32::from(b.port()) - i32::from(a.port()) == step
            {
                Observation::Sequential {
                    address: *c.ip(),
                    port: c.port(),
                    step: step as i16,
                }
            } else {
                Observation::Irregular { address: *c.ip() }
            };
            // The public peer target is checked when supplied by signaling.
            Ok((observation, matches!(observation, Observation::Stable { .. }).then_some(socket)))
        })
        .await?
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum RandomRole {
    Pool,
    Search,
}

struct ProbePlan {
    targets: Vec<SocketAddrV4>,
    random: Option<RandomRole>,
}
impl ProbePlan {
    fn new(local: Observation, remote: Observation) -> Result<Self> {
        ensure!(remote.valid(), "unsupported peer mapping address");
        match (local, remote) {
            (Observation::Stable { .. }, Observation::Irregular { address }) => Ok(Self {
                targets: search_targets(address)?,
                random: Some(RandomRole::Search),
            }),
            (Observation::Irregular { .. }, Observation::Stable { .. }) => Ok(Self {
                targets: vec![remote.target().unwrap()],
                random: Some(RandomRole::Pool),
            }),
            (Observation::Irregular { .. }, _) | (_, Observation::Irregular { .. }) => {
                bail!("unsupported mapping observations")
            }
            _ => {
                let target = remote
                    .target()
                    .ok_or_else(|| anyhow::anyhow!("invalid prediction"))?;
                let alternate =
                    if let (Observation::Stable { .. }, Observation::Sequential { step, .. }) =
                        (local, remote)
                    {
                        u16::try_from(i32::from(target.port()) + 4 * i32::from(step))
                            .ok()
                            .filter(|port| *port >= 1024)
                            .map(|port| SocketAddrV4::new(*target.ip(), port))
                    } else {
                        None
                    };
                Ok(Self {
                    targets: std::iter::once(target).chain(alternate).collect(),
                    random: None,
                })
            }
        }
    }
}

fn search_targets(address: Ipv4Addr) -> Result<Vec<SocketAddrV4>> {
    let fill = |bytes: &mut [u8]| {
        getrandom::fill(bytes).map_err(|error| anyhow::anyhow!("preparation ports: {error}"))
    };
    let mut bytes = [0; (RANDOM_TARGETS + 1) * 2];
    fill(&mut bytes)?;
    let mut draws = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
    let start = draws.next().unwrap();
    stratified_targets(address, start, || {
        if let Some(value) = draws.next() { return Ok(value); }
        let mut extra = [0; 2];
        fill(&mut extra)?;
        Ok(u16::from_le_bytes(extra))
    })
}

fn stratified_targets(
    address: Ipv4Addr,
    start: u16,
    mut draw: impl FnMut() -> Result<u16>,
) -> Result<Vec<SocketAddrV4>> {
    const FIRST_PORT: usize = 1024;
    const PORT_COUNT: usize = u16::MAX as usize + 1 - FIRST_PORT;
    const _: () = assert!(RANDOM_TARGETS.is_power_of_two() && RANDOM_TARGETS <= PORT_COUNT);
    let shift = usize::BITS - RANDOM_TARGETS.ilog2();
    (0..RANDOM_TARGETS).map(|index| {
        // Spread strata first; independent offsets avoid locking guesses to a port residue.
        let stratum = ((index.reverse_bits() >> shift) + usize::from(start)) % RANDOM_TARGETS;
        let lower = FIRST_PORT + PORT_COUNT * stratum / RANDOM_TARGETS;
        let width = PORT_COUNT * (stratum + 1) / RANDOM_TARGETS - (lower - FIRST_PORT);
        let limit = (usize::from(u16::MAX) + 1) / width * width;
        let offset = loop {
            let value = usize::from(draw()?);
            if value < limit { break value % width; }
        };
        Ok(SocketAddrV4::new(address, (lower + offset) as u16))
    }).collect()
}

impl Survey {
    pub async fn check(
        self,
        remote: Observation,
        commands: &mpsc::Sender<NativeEvent>,
        incoming: &mut mpsc::Receiver<UdpSignal>,
    ) -> Result<Prepared> {
        let kind = |observation| match observation {
            Observation::Stable { .. } => MappingKind::Stable,
            Observation::Sequential { .. } => MappingKind::Sequential,
            Observation::Irregular { .. } => MappingKind::Irregular,
        };
        rtc_pair(
            self.preparation.pair,
            RtcPairEvent::Mappings {
                local: kind(self.observation),
                remote: kind(remote),
            },
        );
        let plan = ProbePlan::new(self.observation, remote)?;
        rtc_pair(
            self.preparation.pair,
            RtcPairEvent::Hypotheses {
                count: plan.targets.len(),
                random: plan.random.is_some(),
            },
        );
        self.check_plan(plan, commands, incoming).await
    }

    #[cfg(test)]
    async fn check_target(
        self,
        remote: SocketAddrV4,
        commands: &mpsc::Sender<NativeEvent>,
        incoming: &mut mpsc::Receiver<UdpSignal>,
    ) -> Result<Prepared> {
        self.check_targets(remote, None, commands, incoming).await
    }
    #[cfg(test)]
    async fn check_targets(
        self,
        remote: SocketAddrV4,
        alternate: Option<SocketAddrV4>,
        commands: &mpsc::Sender<NativeEvent>,
        incoming: &mut mpsc::Receiver<UdpSignal>,
    ) -> Result<Prepared> {
        self.check_plan(
            ProbePlan {
                targets: std::iter::once(remote).chain(alternate).collect(),
                random: None,
            },
            commands,
            incoming,
        )
        .await
    }

    async fn check_plan(
        self,
        plan: ProbePlan,
        commands: &mpsc::Sender<NativeEvent>,
        incoming: &mut mpsc::Receiver<UdpSignal>,
    ) -> Result<Prepared> {
        let Survey {
            preparation,
            retained,
            ..
        } = self;
        let deadline = preparation.expires;
        rtc_pair(
            preparation.pair,
            RtcPairEvent::Preparation {
                step: PreparationStep::Checks,
            },
        );
        timeout_at(deadline.into(), async move {
            // Declared before sockets/readers: release capacity only after their
            // retirement, including cancellation of this entire future.
            let _permit = plan.random.map(|_| RANDOM_PREPARATIONS.try_acquire()).transpose()
                .map_err(|_| anyhow::anyhow!("random preparation busy"))?;
            let random = plan.random.is_some();
            let mut selected = (plan.targets.len() == 1).then_some(plan.targets[0]);
            let mut sockets = Vec::new();
            if let Some(socket) = retained { sockets.push(socket); }
            else { for _ in 0..if random { RANDOM_PORTS } else { 8 } { sockets.push(UdpSocket::bind((preparation.local, 0)).await?); } }
            let provider = rtc_crypto::default_provider()?;
            let key: String = preparation.secret.iter().map(|byte| format!("{byte:02x}")).collect();
            let integrity = MessageIntegrity::new_short_term_integrity_with_provider(key.clone(), provider.crypto());
            let mut requests = Vec::new();
            for _ in &sockets {
                let mut request = Message::new();
                request.build(&[Box::new(BINDING_REQUEST), Box::new(TransactionId::new())])?;
                integrity.add_to(&mut request)?; FINGERPRINT.add_to(&mut request)?;
                requests.push(request);
            }
            let mut requests_left = if random { RANDOM_REQUEST_BUDGET } else { CHECK_PACKET_BUDGET };
            let mut next_send = Instant::now();
            if plan.random == Some(RandomRole::Pool) {
                // M mappings share one stable remote tuple before its N guesses.
                for (socket, request) in sockets.iter().zip(&requests) {
                    sleep_until(next_send.into()).await;
                    socket.send_to(&request.raw, plan.targets[0]).await?;
                    requests_left -= 1;
                    next_send += RANDOM_PACKET_INTERVAL;
                }
                send(commands, preparation.pair, UdpSignal::Ready {}).await?;
            } else if plan.random == Some(RandomRole::Search) {
                ensure!(matches!(incoming.recv().await, Some(UdpSignal::Ready {})), "expected peer pool readiness");
            }
            let mut reads: FuturesUnordered<_> = sockets.iter().enumerate().map(|(i,s)| receive(i,s)).collect();
            let start = Instant::now();
            // The wait for Ready is not time a schedule may catch up on.
            next_send = start;
            let mut round = 0;
            let mut probe = 0;
            let probe_limit = if plan.random == Some(RandomRole::Search) { plan.targets.len() } else { RANDOM_PORTS };
            let mut replies_left = if random { RANDOM_REPLY_BUDGET } else { CHECK_PACKET_BUDGET };
            let mut triggered_left = if random { 8 } else { CHECK_PACKET_BUDGET };
            let mut outgoing: VecDeque<(usize, SocketAddrV4, Vec<u8>)> = VecDeque::new();
            let mut winner = None;
            let mut peer_complete = false;
            let index = loop {
                if peer_complete { if let Some(index) = winner { break index; } }
                let random_probe = random && winner.is_none() && probe < probe_limit && requests_left > 0
                    && (plan.random == Some(RandomRole::Pool) || selected.is_none());
                tokio::select! {
                    _ = sleep_until((start + Duration::from_millis(round * 100)).into()), if !random && round < 7 && requests_left > 0 => {
                        let target = selected.unwrap_or(plan.targets[round as usize % plan.targets.len()]);
                        for (index, request) in requests.iter().enumerate().take(requests_left) {
                            outgoing.push_back((index, target, request.raw.clone()));
                            requests_left -= 1;
                        }
                        round += 1;
                    },
                    _ = sleep_until(next_send.into()), if !outgoing.is_empty() || random_probe => {
                        let (index, target, bytes) = if let Some(packet) = outgoing.pop_front() { packet }
                        else {
                            let index = if plan.random == Some(RandomRole::Pool) { probe } else { 0 };
                            let target = plan.targets[probe % plan.targets.len()];
                            probe += 1; requests_left -= 1;
                            (index, target, requests[index].raw.clone())
                        };
                        sockets[index].send_to(&bytes, target).await?;
                        next_send += if random { RANDOM_PACKET_INTERVAL } else { Duration::ZERO };
                    },
                    message = incoming.recv(), if !peer_complete => {
                        ensure!(matches!(message, Some(UdpSignal::Complete)), "expected peer preparation completion");
                        peer_complete = true;
                    },
                    Some(received) = reads.next() => {
                        let (index, bytes, peer) = received?;
                        reads.push(receive(index, &sockets[index]));
                        let SocketAddr::V4(peer) = peer else { continue; };
                        if selected.map_or_else(|| !plan.targets.contains(&peer), |target| peer != target) { continue; }
                        let mut message = Message { raw: bytes, ..Default::default() };
                        if message.decode().is_err() || MessageIntegrity::check(&mut message, key.as_bytes(), provider.crypto()).is_err() { continue; }
                        let valid_response = message.typ == BINDING_SUCCESS && message.transaction_id == requests[index].transaction_id;
                        if selected.is_none() && (message.typ == BINDING_REQUEST || valid_response) {
                            selected = Some(peer);
                            outgoing.retain(|(_, target, _)| *target == peer);
                        }
                        if selected.is_none() { continue; }
                        if message.typ == BINDING_REQUEST && replies_left > 0 {
                            replies_left -= 1;
                            let mut response = Message::new();
                            response.build(&[Box::new(BINDING_SUCCESS), Box::new(message.transaction_id),
                                Box::new(XorMappedAddress { ip: (*peer.ip()).into(), port: peer.port() })])?;
                            integrity.add_to(&mut response)?; FINGERPRINT.add_to(&mut response)?;
                            outgoing.push_back((index, peer, response.raw));
                            if winner.is_none() && requests_left > 0 && triggered_left > 0 {
                                requests_left -= 1; triggered_left -= 1;
                                outgoing.push_back((index, peer, requests[index].raw.clone()));
                            }
                        } else if valid_response && winner.is_none() {
                            winner = Some(index);
                            send(commands, preparation.pair, UdpSignal::Complete).await?;
                        }
                    }
                }
            };
            drop(reads);
            let socket = sockets.swap_remove(index);
            drop(sockets);
            Ok(Prepared { pair: preparation.pair, expires: preparation.expires, socket, remote: selected.unwrap() })
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
    use anyhow::Context;
    use std::collections::HashSet;

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
            observation: Observation::Stable {
                address: Ipv4Addr::LOCALHOST,
                port: local.port(),
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
    async fn late_neighbor_rejects_unproved_tuples_and_uses_triggered_mutual_completion(
    ) -> Result<()> {
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
                observation: Observation::Stable {
                    address: Ipv4Addr::LOCALHOST,
                    port: socket.local_addr()?.port(),
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
        let primary = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let SocketAddr::V4(primary_address) = primary.local_addr()? else {
            unreachable!()
        };
        let outsider = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let provider = rtc_crypto::default_provider()?;
        let key: String = [51; 32].iter().map(|byte| format!("{byte:02x}")).collect();
        let integrity =
            MessageIntegrity::new_short_term_integrity_with_provider(key, provider.crypto());
        let mut unmatched = Message::new();
        unmatched.build(&[Box::new(BINDING_SUCCESS), Box::new(TransactionId::new())])?;
        integrity.add_to(&mut unmatched)?;
        primary.send_to(&unmatched.raw, first_address).await?;
        let mut request = Message::new();
        request.build(&[Box::new(BINDING_REQUEST), Box::new(TransactionId::new())])?;
        integrity.add_to(&mut request)?;
        outsider.send_to(&request.raw, first_address).await?;
        let wrong = MessageIntegrity::new_short_term_integrity_with_provider(
            "wrong".into(),
            provider.crypto(),
        );
        let mut wrong_request = Message::new();
        wrong_request.build(&[Box::new(BINDING_REQUEST), Box::new(TransactionId::new())])?;
        wrong.add_to(&mut wrong_request)?;
        primary.send_to(&wrong_request.raw, first_address).await?;
        let first_survey = survey(first)?;
        let first_check = first_survey.check_targets(
            primary_address,
            Some(second_address),
            &first_commands,
            &mut first_input,
        );
        let second_check = async {
            // The first peer's complete initial fanout reaches a closed UDP port.
            tokio::time::sleep(Duration::from_millis(1200)).await;
            let second = UdpSocket::bind(second_address).await?;
            survey(second)?
                .check_target(first_address, &second_commands, &mut second_input)
                .await
        };
        let exchange = async {
            forward_complete(first_events, to_second).await?;
            // A second eligible socket authenticates after the first tuple won.
            // Keep mutual completion pending while its request is processed.
            primary.send_to(&request.raw, first_address).await?;
            tokio::time::sleep(Duration::from_millis(50)).await;
            forward_complete(second_events, to_first).await?;
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
        let mut bytes = [0; 1024];
        assert!(
            matches!(outsider.try_recv_from(&mut bytes), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
        );
        let mut sent = 0;
        while let Ok((n, _)) = primary.try_recv_from(&mut bytes) {
            let mut message = Message {
                raw: bytes[..n].to_vec(),
                ..Default::default()
            };
            message.decode()?;
            assert_eq!(
                message.typ, BINDING_REQUEST,
                "unproved primary received success"
            );
            sent += 1;
        }
        assert!(
            sent > 0 && sent <= 7,
            "ordinary rounds exceeded their bound"
        );
        // Preparation readers retire before the unchanged winning sockets transfer.
        first.set_nonblocking(true)?;
        second.set_nonblocking(true)?;
        let first = UdpSocket::from_std(first)?;
        let second = UdpSocket::from_std(second)?;
        first.send_to(b"after-preparation", second_address).await?;
        let (n, from) =
            tokio::time::timeout(Duration::from_secs(1), second.recv_from(&mut bytes)).await??;
        assert_eq!(&bytes[..n], b"after-preparation");
        assert_eq!(from, first_address.into());
        drop((first, second));
        UdpSocket::bind(first_address).await?;
        UdpSocket::bind(second_address).await?;
        Ok(())
    }

    #[tokio::test]
    async fn cancelling_neighbor_preparation_releases_its_socket_without_completion() -> Result<()>
    {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let local = socket.local_addr()?;
        let first = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let second = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let (SocketAddr::V4(first_address), SocketAddr::V4(second_address)) =
            (first.local_addr()?, second.local_addr()?)
        else {
            unreachable!()
        };
        let (commands, mut events) = mpsc::channel(4);
        let (_complete, mut incoming) = mpsc::channel(4);
        let survey = Survey {
            preparation: Preparation::new(
                Uuid::new_v4(),
                [64; 32],
                Ipv4Addr::LOCALHOST,
                Instant::now() + Duration::from_secs(5),
            )?,
            observation: Observation::Stable {
                address: Ipv4Addr::LOCALHOST,
                port: local.port(),
            },
            retained: Some(socket),
        };
        let mut check = Box::pin(survey.check_targets(
            first_address,
            Some(second_address),
            &commands,
            &mut incoming,
        ));
        let mut bytes = [0; 1024];
        tokio::select! {
            result = &mut check => panic!("silent candidate unexpectedly completed: {}", result.is_ok()),
            result = first.recv_from(&mut bytes) => { result?; }
        }
        drop(check);
        assert!(
            events.try_recv().is_err(),
            "cancelled preparation announced completion"
        );
        UdpSocket::bind(local).await?;
        Ok(())
    }

    #[tokio::test]
    async fn failed_preparation_preserves_the_live_pair_when_a_late_offer_arrives() -> Result<()> {
        use super::super::*;
        let (mut driver, _events, mut commands, _stop) = tests::driver();
        driver.session = Uuid::from_u128(u128::MAX);
        let pair = Uuid::new_v4();
        let plan = PairInfo {
            id: pair,
            peer_id: Uuid::new_v4(),
            udp_preparation: Some(piik_channel_core::wire::UdpPreparation::Available),
            can_receive_video_layers: false,
            rooms: vec!["prep-failure".into()],
            incoming: vec![],
            outgoing: vec![],
        };
        let sibling = PairInfo {
            id: Uuid::new_v4(),
            peer_id: Uuid::new_v4(),
            udp_preparation: None,
            rooms: vec![],
            ..plan.clone()
        };
        driver.create_pair(&sibling).await?;
        driver.create_pair(&plan).await?;
        let sibling_instance = driver.pairs[&sibling.id]
            .pc
            .connection_metrics()
            .await?
            .connection_id;
        let (preparation_commands, mut notifications) = mpsc::channel(4);
        let (input, incoming) = mpsc::channel(4);
        driver.preparings.insert(
            pair,
            Pending {
                pair,
                instance: driver.pairs[&pair].pc.instance,
                input,
                refused: false,
                task: tokio::spawn(async move {
                    // Start at failed completion, without unrelated OS interface discovery.
                    drop(incoming);
                    let _ = preparation_commands.try_send(signal(pair, UdpSignal::Unavailable {}));
                    Err(anyhow::anyhow!("owned preparation failure"))
                }),
            },
        );
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(3), notifications.recv()).await?,
            Some(NativeEvent::Command(Command::Signal {
                payload: Signal {
                    udp: Some(UdpSignal::Unavailable {}),
                    ..
                },
                ..
            }))
        ));
        assert!(driver.preparings[&pair].task.is_finished());
        assert!(
            notifications.try_recv().is_err(),
            "failure notification repeated"
        );
        // The responder can fail before the peer's already-sent Offer arrives.
        // Input and completed preparation are independent Driver select branches.
        let NativeEvent::Command(Command::Signal { payload, .. }) = signal(
            pair,
            UdpSignal::Offer {
                secret: [73; 32],
                observation: Observation::Stable {
                    address: "203.0.113.1".parse()?,
                    port: 42000,
                },
            },
        ) else {
            unreachable!()
        };
        if driver.signal(pair, payload).await.is_err() {
            driver
                .fail(pair, crate::diagnostics::RetirementReason::PeerFailed)
                .await;
        }
        ensure!(
            driver.preparings.contains_key(&pair),
            "late offer retired the completed preparation"
        );
        let (finished, result) = next(&mut driver.preparings).await.unwrap();
        assert_eq!(finished, pair);
        let pending = driver.preparings.remove(&pair).unwrap();
        driver.prepared(pending, result).await;
        anyhow::ensure!(
            driver.preparings.is_empty() && driver.pairs.contains_key(&pair),
            "survey failure retired the live pair"
        );
        anyhow::ensure!(
            driver.pairs[&pair].plan.udp_preparation == plan.udp_preparation,
            "survey failure changed the pair grant"
        );
        assert_eq!(
            driver.pairs[&sibling.id]
                .pc
                .connection_metrics()
                .await?
                .connection_id,
            sibling_instance,
            "preparation completion replaced an unrelated pair"
        );
        while let Ok(event) = commands.try_recv() {
            ensure!(
                !matches!(
                    event,
                    NativeEvent::Command(Command::LinkState {
                        state: LinkState::Failed,
                        ..
                    })
                ),
                "late preparation signal reported a physical pair failure"
            );
        }
        driver
            .retire_pair(
                pair,
                crate::diagnostics::RetirementReason::ProjectionRemoved,
            )
            .await;
        driver
            .retire_pair(
                sibling.id,
                crate::diagnostics::RetirementReason::ProjectionRemoved,
            )
            .await;
        driver.files.close().await;
        driver.watches.close().await;
        driver.transport.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn full_udp_signal_queue_preserves_ordinary_ice() -> Result<()> {
        let (mut driver, _events, _commands, _stop) = super::super::tests::driver();
        let id = Uuid::new_v4();
        let plan = PairInfo {
            id, peer_id: Uuid::new_v4(), udp_preparation: None, rooms: vec![],
            outgoing: vec![], incoming: vec![], can_receive_video_layers: false,
        };
        driver.create_pair(&plan).await?;
        let instance = driver.pairs[&id].pc.instance;
        let deadline = driver.pairs[&id].deadline.unwrap().expires();
        let (input, _incoming) = mpsc::channel(1);
        input.try_send(UdpSignal::Ready {})?;
        driver.preparings.insert(id, Pending {
            pair: id, instance, input, refused: false,
            task: tokio::spawn(std::future::pending()),
        });
        let NativeEvent::Command(Command::Signal { payload, .. }) = signal(id, UdpSignal::Complete)
            else { unreachable!() };
        driver.signal(id, payload).await?;
        assert!(!driver.preparings.contains_key(&id));
        assert_eq!(driver.pairs[&id].pc.instance, instance);
        assert_eq!(driver.pairs[&id].deadline.unwrap().expires(), deadline);
        driver.pairs[&id].pc.connection_metrics().await?;
        driver.update(vec![], vec![], vec![]).await;
        driver.files.close().await;
        driver.watches.close().await;
        driver.transport.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn peer_refusal_after_completion_releases_the_winner_and_preserves_the_pair(
    ) -> Result<()> {
        use super::super::*;
        let (mut driver, _events, _commands, _stop) = tests::driver();
        driver.session = Uuid::from_u128(u128::MAX);
        let pair = Uuid::new_v4();
        let first = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let second = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let SocketAddr::V4(first_address) = first.local_addr()? else {
            unreachable!()
        };
        let SocketAddr::V4(second_address) = second.local_addr()? else {
            unreachable!()
        };
        let (first_commands, mut first_events) = mpsc::channel(4);
        let (second_commands, mut second_events) = mpsc::channel(4);
        let (input, mut first_incoming) = mpsc::channel(4);
        let (_second_input, mut second_incoming) = mpsc::channel(4);
        let make = |socket, local: SocketAddrV4, expires| -> Result<Survey> {
            Ok(Survey {
                preparation: Preparation::new(pair, [94; 32], Ipv4Addr::LOCALHOST, expires)?,
                observation: Observation::Stable {
                    address: *local.ip(),
                    port: local.port(),
                },
                retained: Some(socket),
            })
        };
        let first = make(
            first,
            first_address,
            Instant::now() + Duration::from_secs(5),
        )?;
        let second = make(
            second,
            second_address,
            Instant::now() + Duration::from_millis(500),
        )?;
        let task = tokio::spawn(async move {
            first
                .check_target(second_address, &first_commands, &mut first_incoming)
                .await
        });
        let second = tokio::spawn(async move {
            let result = second
                .check_target(first_address, &second_commands, &mut second_incoming)
                .await;
            // Pending::start sends this same refusal after a failed negotiate.
            if result.is_err() {
                let _ = second_commands.try_send(signal(pair, UdpSignal::Unavailable {}));
            }
            result
        });
        let complete = tokio::time::timeout(Duration::from_secs(3), second_events.recv())
            .await?
            .context("peer Complete missing")?;
        let NativeEvent::Command(Command::Signal { pair_id, payload }) = complete else {
            unreachable!()
        };
        ensure!(
            pair_id == pair && matches!(payload.udp, Some(UdpSignal::Complete)) && payload.valid()
        );
        input.send(UdpSignal::Complete).await?;
        // Delay the first side's already-produced Complete in signaling. Both
        // sides' authenticated UDP checks are real and the second keeps waiting.
        let local_complete = tokio::time::timeout(Duration::from_secs(3), first_events.recv())
            .await?
            .context("local Complete missing")?;
        ensure!(
            matches!(local_complete, NativeEvent::Command(Command::Signal { pair_id, payload: Signal { udp: Some(UdpSignal::Complete), .. } }) if pair_id == pair)
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        let refusal = tokio::time::timeout(Duration::from_secs(3), second_events.recv())
            .await?
            .context("peer refusal missing")?;
        let NativeEvent::Command(Command::Signal { pair_id, payload }) = refusal else {
            unreachable!()
        };
        ensure!(
            pair_id == pair
                && matches!(payload.udp, Some(UdpSignal::Unavailable {}))
                && payload.valid()
        );
        ensure!(
            second.await?.is_err(),
            "peer unexpectedly completed without local Complete"
        );
        let plan = PairInfo {
                    id: pair,
                    peer_id: Uuid::new_v4(),
                    udp_preparation: Some(piik_channel_core::wire::UdpPreparation::Available),
                    can_receive_video_layers: false,
                    rooms: vec![],
                    incoming: vec![],
                    outgoing: vec![],
                };
        driver.create_pair(&plan).await?;
        driver.preparings.insert(
            pair,
            Pending {
                pair,
                instance: driver.pairs[&pair].pc.instance,
                input,
                refused: false,
                task,
            },
        );
        driver.signal(pair, payload).await?;
        let (id, result) = next(&mut driver.preparings).await.unwrap();
        let pending = driver.preparings.remove(&id).unwrap();
        driver.prepared(pending, result).await;
        driver.pairs.get(&pair).context("refusal retired the live pair")?
            .pc.connection_metrics().await?;
        let rebound = UdpSocket::bind(first_address)
            .await
            .context("refused prepared socket retained")?;
        drop(rebound);
        driver
            .retire_pair(
                pair,
                crate::diagnostics::RetirementReason::ProjectionRemoved,
            )
            .await;
        driver.files.close().await;
        driver.watches.close().await;
        driver.transport.close().await;
        Ok(())
    }

    #[test]
    fn search_reaches_regular_mapping_pools_without_a_fixed_residue() -> Result<()> {
        use sha2::Digest;
        let mut counter = 0u64;
        let targets = stratified_targets(Ipv4Addr::LOCALHOST, 1, || {
            let digest = sha2::Sha256::digest(counter.to_le_bytes());
            counter += 1;
            Ok(u16::from_le_bytes([digest[0], digest[1]]))
        })?;
        for stride in [2, 4, 8, 16, 32, 63, 64] {
            let pool: HashSet<_> = (0..RANDOM_PORTS).map(|index| 30000 + stride * index).collect();
            assert!(targets.iter().any(|target| pool.contains(&usize::from(target.port()))), "stride {stride}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn random_pool_shares_capacity_adopts_one_socket_and_retires_on_peer_refusal(
    ) -> Result<()> {
        let stable = Observation::Stable {
            address: "203.0.113.1".parse()?,
            port: 42000,
        };
        let irregular = Observation::Irregular {
            address: "203.0.113.2".parse()?,
        };
        let generated = ProbePlan::new(stable, irregular)?;
        // Every request of the search reaches a different port.
        assert_eq!(generated.targets.len(), RANDOM_TARGETS);
        assert_eq!(
            generated.targets.iter().collect::<HashSet<_>>().len(),
            RANDOM_TARGETS
        );
        assert!(generated
            .targets
            .iter()
            .all(|target| *target.ip() == irregular.address() && target.port() >= 1024));
        // A half-budget prefix cannot leave a contiguous pool-sized gap.
        let mut prefix: Vec<_> = generated.targets[..RANDOM_TARGETS / 2]
            .iter()
            .map(|target| usize::from(target.port()))
            .collect();
        prefix.sort_unstable();
        let wrap_gap = usize::from(u16::MAX) + 1 - prefix.last().unwrap() + prefix[0] - 1024;
        assert!(wrap_gap < RANDOM_PORTS);
        assert!(prefix
            .windows(2)
            .all(|ports| ports[1] - ports[0] < RANDOM_PORTS));
        assert!(
            ProbePlan::new(irregular, irregular).is_err(),
            "two irregular mappings cannot select birthday search"
        );
        let pair = Uuid::new_v4();
        let expires = Instant::now() + Duration::from_secs(5);
        let easy_socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let SocketAddr::V4(easy_address) = easy_socket.local_addr()? else {
            unreachable!()
        };
        let (hard_commands, mut hard_events) = mpsc::channel(4);
        let (to_hard, mut hard_input) = mpsc::channel(4);
        let occupied = RANDOM_PREPARATIONS.try_acquire()?;
        let primed = Instant::now();
        let hard = tokio::spawn(async move {
            Survey {
                preparation: Preparation::new(pair, [73; 32], Ipv4Addr::LOCALHOST, expires)?,
                observation: Observation::Irregular {
                    address: Ipv4Addr::LOCALHOST,
                },
                retained: None,
            }
            .check_plan(
                ProbePlan {
                    targets: vec![easy_address],
                    random: Some(RandomRole::Pool),
                },
                &hard_commands,
                &mut hard_input,
            )
            .await
        });
        // Ready ends priming. Use the observed UDP sources for a forced
        // intersection even if some of the pool's datagrams were dropped.
        let mut sources = HashSet::new();
        let mut bytes = [0; 1024];
        let ready = loop {
            tokio::select! {
                event = hard_events.recv() => {
                    if event.is_none() {
                        hard.await?.context("pool stopped before Ready")?;
                        bail!("pool finished before Ready");
                    }
                    break event;
                }
                received = easy_socket.recv_from(&mut bytes) => {
                    let (_, SocketAddr::V4(peer)) = received? else { unreachable!() };
                    sources.insert(peer);
                }
            }
        };
        ensure!(
            matches!(
                ready,
                Some(NativeEvent::Command(Command::Signal {
                    payload: Signal {
                        udp: Some(UdpSignal::Ready {}),
                        ..
                    },
                    ..
                }))
            ),
            "pool readiness missing"
        );
        // A sleep per packet takes about four seconds here on a 15.6 ms timer and
        // leaves the search none of the preparation's five.
        ensure!(
            primed.elapsed() < RANDOM_PACKET_INTERVAL * RANDOM_PORTS as u32 * 3,
            "pool priming lost its packet rate: {:?}",
            primed.elapsed()
        );
        ensure!(
            (2..=RANDOM_PORTS).contains(&sources.len()),
            "expected distinct pool sockets within the configured bound, saw {}",
            sources.len()
        );
        assert_eq!(RANDOM_PREPARATIONS.available_permits(), 0);
        let (_to_busy, mut busy_input) = mpsc::channel(4);
        let (busy_commands, _busy_events) = mpsc::channel(4);
        let busy = Survey {
            preparation: Preparation::new(Uuid::new_v4(), [74; 32], Ipv4Addr::LOCALHOST, expires)?,
            observation: Observation::Irregular {
                address: Ipv4Addr::LOCALHOST,
            },
            retained: None,
        }
        .check_plan(
            ProbePlan {
                targets: vec![easy_address],
                random: Some(RandomRole::Pool),
            },
            &busy_commands,
            &mut busy_input,
        )
        .await;
        assert!(busy.is_err(), "a third process-wide pool queued or started");
        drop(occupied);
        let (easy_commands, mut easy_events) = mpsc::channel(4);
        let (to_easy, mut easy_input) = mpsc::channel(4);
        to_easy.send(UdpSignal::Ready {}).await?;
        let targets: Vec<_> = sources.iter().copied().collect();
        let easy = tokio::spawn(async move {
            Survey {
                preparation: Preparation::new(pair, [73; 32], Ipv4Addr::LOCALHOST, expires)?,
                observation: Observation::Stable {
                    address: Ipv4Addr::LOCALHOST,
                    port: easy_address.port(),
                },
                retained: Some(easy_socket),
            }
            .check_plan(
                ProbePlan {
                    targets,
                    random: Some(RandomRole::Search),
                },
                &easy_commands,
                &mut easy_input,
            )
            .await
        });
        for (events, peer) in [(&mut easy_events, &to_hard), (&mut hard_events, &to_easy)] {
            let Some(NativeEvent::Command(Command::Signal {
                payload:
                    Signal {
                        udp: Some(UdpSignal::Complete),
                        ..
                    },
                ..
            })) = events.recv().await
            else {
                bail!("authenticated tuple proof missing");
            };
            peer.send(UdpSignal::Complete).await?;
        }
        let (easy, _) = easy.await??.commit(pair)?;
        let (hard, target) = hard.await??.commit(pair)?;
        assert_eq!(target, easy_address);
        assert_eq!(easy.local_addr()?, SocketAddr::V4(easy_address));
        let hard_address = hard.local_addr()?;
        assert!(sources.contains(&match hard_address {
            SocketAddr::V4(v) => v,
            _ => unreachable!(),
        }));
        for address in sources {
            if SocketAddr::V4(address) != hard_address {
                UdpSocket::bind(address).await?;
            }
        }
        assert_eq!(RANDOM_PREPARATIONS.available_permits(), 2);
        drop((easy, hard));
        UdpSocket::bind(easy_address).await?;
        UdpSocket::bind(hard_address).await?;

        // A peer refusal cancels even a Search blocked before Ready, joining the
        // same Pending task and releasing its socket and global permit.
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let address = socket.local_addr()?;
        let (commands, mut events) = mpsc::channel(4);
        let (input, mut incoming) = mpsc::channel(4);
        let started = std::sync::Arc::new(tokio::sync::Notify::new());
        let notify = started.clone();
        let task = tokio::spawn(async move {
            let mut check = Box::pin(
                Survey {
                    preparation: Preparation::new(
                        pair,
                        [75; 32],
                        Ipv4Addr::LOCALHOST,
                        Instant::now() + Duration::from_secs(5),
                    )?,
                    observation: Observation::Stable {
                        address: Ipv4Addr::LOCALHOST,
                        port: address.port(),
                    },
                    retained: Some(socket),
                }
                .check_plan(
                    ProbePlan {
                        targets: vec![easy_address; RANDOM_PORTS],
                        random: Some(RandomRole::Search),
                    },
                    &commands,
                    &mut incoming,
                ),
            );
            assert!(futures_util::poll!(check.as_mut()).is_pending());
            notify.notify_one();
            check.await
        });
        started.notified().await;
        let mut pending = Pending {
            pair,
            instance: Uuid::new_v4(),
            input,
            refused: false,
            task,
        };
        let NativeEvent::Command(Command::Signal { payload, .. }) =
            signal(pair, UdpSignal::Unavailable {})
        else {
            unreachable!()
        };
        pending.signal(payload.udp.unwrap())?;
        assert!(matches!((&mut pending.task).await, Err(error) if error.is_cancelled()));
        assert_eq!(RANDOM_PREPARATIONS.available_permits(), 2);
        UdpSocket::bind(address).await?;
        assert!(
            events.try_recv().is_err(),
            "peer refusal echoed a refusal or completed"
        );
        Ok(())
    }
    #[tokio::test]
    async fn mapping_surveys_keep_stable_sequential_and_irregular_observations_distinct(
    ) -> Result<()> {
        for (name, ports) in [
            ("increasing", [42000u16, 42002, 42004]),
            ("decreasing", [42004, 42002, 42000]),
            ("irregular", [42000, 42003, 42004]),
            ("stable", [42000, 42000, 42000]),
        ] {
            let mut addresses = Vec::new();
            let mut tasks = Vec::new();
            for port in ports {
                let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
                let SocketAddr::V4(address) = socket.local_addr()? else {
                    unreachable!()
                };
                addresses.push(address);
                tasks.push(tokio::spawn(async move {
                    let mut bytes = vec![0; 2048];
                    let (n, peer) = socket.recv_from(&mut bytes).await?;
                    let mut request = Message::new();
                    request.raw = bytes[..n].to_vec();
                    request.decode()?;
                    let mut response = Message::new();
                    response.build(&[
                        Box::new(BINDING_SUCCESS),
                        Box::new(request.transaction_id),
                        Box::new(XorMappedAddress {
                            ip: Ipv4Addr::new(203, 0, 113, 5).into(),
                            port,
                        }),
                    ])?;
                    socket.send_to(&response.raw, peer).await?;
                    Ok::<_, anyhow::Error>(())
                }));
            }
            let (observation,retained)=observe(Uuid::new_v4(),Ipv4Addr::LOCALHOST,addresses.try_into().unwrap(),Instant::now()+Duration::from_secs(3)).await?;
            match (name, observation) {
                ("increasing", Observation::Sequential { step: 2, .. })
                | ("decreasing", Observation::Sequential { step: -2, .. })
                | ("stable", Observation::Stable { .. })
                | ("irregular", Observation::Irregular { .. }) => {}
                _ => panic!("observation changed meaning"),
            }
            assert_eq!(retained.is_some(), name == "stable");
            for task in tasks {
                task.await??;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(super) async fn loopback_winners(pair: Uuid) -> Result<[(Prepared, SocketAddr); 2]> {
    async fn survey(pair: Uuid) -> Result<(Survey, SocketAddrV4)> {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let SocketAddr::V4(address) = socket.local_addr()? else { unreachable!() };
        Ok((Survey {
            preparation: Preparation::new(pair, [29; 32], Ipv4Addr::LOCALHOST, Instant::now() + Duration::from_secs(5))?,
            observation: Observation::Stable { address: *address.ip(), port: address.port() },
            retained: Some(socket),
        }, address))
    }
    async fn signal_complete(pair: Uuid, mut events: mpsc::Receiver<NativeEvent>, input: mpsc::Sender<UdpSignal>) -> Result<()> {
        let Some(NativeEvent::Command(Command::Signal {pair_id, payload})) = events.recv().await else { bail!("missing signal") };
        ensure!(pair_id == pair && matches!(payload.udp, Some(UdpSignal::Complete)));
        input.send(UdpSignal::Complete).await?;
        Ok(())
    }
    let (a, a_addr) = survey(pair).await?;
    let (b, b_addr) = survey(pair).await?;
    let (a_tx, a_rx) = mpsc::channel(4);
    let (b_tx, b_rx) = mpsc::channel(4);
    let (a_in, mut a_msgs) = mpsc::channel(4);
    let (b_in, mut b_msgs) = mpsc::channel(4);
    let (a, b, (), ()) = tokio::try_join!(a.check_target(b_addr, &a_tx, &mut a_msgs),
        b.check_target(a_addr, &b_tx, &mut b_msgs), signal_complete(pair, a_rx, b_in), signal_complete(pair, b_rx, a_in))?;
    Ok([(a, a_addr.into()), (b, b_addr.into())])
}
