//! Pair-owned UDP TURN endpoints; rtc owns authentication, framing and timers.
use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};
use rtc::{
    ice::url::{SchemeType, Url},
    sansio::Protocol as _,
    shared::{error::Error, TaggedBytesMut, TransportContext, TransportProtocol},
    stun::message::TransactionId,
    turn::client::{Client, ClientConfig, Event as ClientEvent},
};
use std::collections::VecDeque;

const LIMIT: usize = super::super::MAX_ICE_CANDIDATES;
pub(super) struct Setup {
    pub urls: Vec<Url>,
    pub ready: mpsc::Sender<Endpoint>,
}
pub(super) async fn setup(handle: Transport, config: Setup) {
    let mut distinct = HashSet::new();
    let mut jobs: FuturesUnordered<_> = config
        .urls
        .into_iter()
        .filter(|url| url.scheme == SchemeType::Turn)
        .filter(|url| {
            distinct.insert((
                url.host.clone(),
                url.port,
                url.username.clone(),
                url.password.clone(),
            ))
        })
        .take(LIMIT)
        .map(|url| async move {
            let addresses = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::lookup_host((url.host.as_str(), url.port)),
            )
            .await??;
            let mut families = HashSet::new();
            let addresses = addresses
                .filter(|address| families.insert(address.is_ipv4()))
                .take(2)
                .collect::<Vec<_>>();
            Ok::<_, anyhow::Error>((url, addresses))
        })
        .collect();
    let mut installed = 0;
    while let Some(result) = jobs.next().await {
        let (url, addresses) = match result {
            Ok(value) => value,
            Err(error) => {
                eprintln!("Native TURN resolution: {error}");
                continue;
            }
        };
        for server in addresses {
            if installed >= LIMIT {
                return;
            }
            match Endpoint::setup(url.clone(), server).await {
                Ok(endpoint) => {
                    if config.ready.send(endpoint).await.is_err() {
                        return;
                    }
                    installed += 1;
                    if handle
                        .tx
                        .send(Command::TurnReady(handle.pair, handle.instance))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => eprintln!("Native TURN endpoint setup: {error}"),
            }
        }
    }
}

struct Pending {
    transaction: TransactionId,
    packets: VecDeque<Vec<u8>>,
}
pub(super) enum Change {
    Ready(SocketAddr, RTCIceCandidate),
    Receive(SocketAddr, SocketAddr, Vec<u8>, Instant),
    Failed,
}
pub(super) struct Endpoint {
    pub socket: Arc<UdpIo>,
    local: SocketAddr,
    server: SocketAddr,
    url: String,
    client: Client,
    pub relay: Option<SocketAddr>,
    pending: HashMap<SocketAddr, Pending>,
    peers: HashSet<SocketAddr>,
    received_at: Instant,
}
impl Endpoint {
    async fn setup(url: Url, server: SocketAddr) -> Result<Self> {
        let source_url = url.to_string();
        ensure!(
            !url.username.is_empty() && !url.password.is_empty(),
            "TURN credentials missing"
        );
        let socket = UdpSocket::bind(if server.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        })
        .await?;
        socket.connect(server).await?;
        let local = socket.local_addr()?;
        ensure!(!local.ip().is_unspecified(), "no concrete TURN route");
        // DNS has completed asynchronously. The public constructor only sees a
        // numeric server here, and cannot block the pump on hostname lookup.
        let client = Client::new(
            ClientConfig {
                turn_serv_addr: server.to_string(),
                local_addr: local,
                transport_protocol: TransportProtocol::UDP,
                username: url.username,
                password: url.password,
                ..Default::default()
            },
            rtc::crypto::default_provider()?,
        )?;
        Ok(Self {
            socket: Arc::new(UdpIo::new(socket)?),
            local,
            server,
            url: source_url,
            client,
            relay: None,
            pending: HashMap::new(),
            peers: HashSet::new(),
            received_at: Instant::now(),
        })
    }
    pub fn allocate(&mut self) -> Result<()> {
        self.client.allocate(Instant::now())?;
        Ok(())
    }
    pub fn read(&mut self, packet: &Datagram) {
        if packet.source != self.server || packet.destination != self.local {
            return;
        }
        self.received_at = packet.at;
        if let Err(error) = self.client.handle_read(TaggedBytesMut {
            now: packet.at,
            transport: TransportContext {
                local_addr: self.local,
                peer_addr: self.server,
                ecn: None,
                transport_protocol: TransportProtocol::UDP,
            },
            message: packet.bytes.as_slice().into(),
        }) {
            eprintln!("Native TURN input: {error}");
        }
    }
    pub fn timeout(&mut self, now: Instant) {
        let _ = self.client.handle_timeout(now);
    }
    pub fn deadline(&mut self) -> Option<Instant> {
        self.client.poll_timeout()
    }
    pub fn pending_units(&self) -> usize {
        self.pending.len()
            + self
                .pending
                .values()
                .map(|p| p.packets.len())
                .sum::<usize>()
    }
    pub fn send(&mut self, peer: SocketAddr, bytes: Vec<u8>, available: usize) -> Result<()> {
        let relay = self.relay.context("TURN allocation not ready")?;
        match self
            .client
            .relay(relay)?
            .send_to(Instant::now(), &bytes, peer)
        {
            Ok(()) => return Ok(()),
            Err(Error::ErrNoPermission) => {}
            Err(error) => return Err(error.into()),
        }
        // Pending permission traffic is finite UDP work; it cannot become a
        // second unbounded media queue or block another physical peer's pump.
        if if self.pending.contains_key(&peer) {
            1
        } else {
            2
        } > available
        {
            return Ok(());
        }
        if !self.peers.contains(&peer) && self.peers.len() >= LIMIT {
            return Ok(());
        }
        if let Some(pending) = self.pending.get_mut(&peer) {
            pending.packets.push_back(bytes);
            return Ok(());
        }
        if let Some(transaction) = self
            .client
            .relay(relay)?
            .create_permission(Instant::now(), peer)?
        {
            self.peers.insert(peer);
            self.pending.insert(
                peer,
                Pending {
                    transaction,
                    packets: VecDeque::from([bytes]),
                },
            );
        }
        Ok(())
    }
    pub fn poll(&mut self) -> Option<Change> {
        while let Some(event) = self.client.poll_event() {
            match event {
                ClientEvent::AllocateResponse(_, relay) => {
                    self.relay = Some(relay);
                    let signal = rtc::peer_connection::transport::CandidateRelayConfig {
                        base_config: rtc::peer_connection::transport::CandidateConfig {
                            network: "udp".into(),
                            address: relay.ip().to_string(),
                            port: relay.port(),
                            component: 1,
                            ..Default::default()
                        },
                        rel_addr: self.local.ip().to_string(),
                        rel_port: self.local.port(),
                        url: Some(self.url.clone()),
                        ..Default::default()
                    }
                    .new_candidate_relay()
                    .map(|c| RTCIceCandidate::from(&c));
                    return Some(match signal {
                        Ok(signal) => Change::Ready(relay, signal),
                        Err(_) => Change::Failed,
                    });
                }
                ClientEvent::AllocateError(_, error) => {
                    eprintln!("Native TURN allocation failed: {error}");
                    return Some(Change::Failed);
                }
                ClientEvent::TransactionTimeout(transaction) => {
                    // allocate() returns the authenticated ID; its initial
                    // challenge can fail with a different transaction ID.
                    if self.relay.is_none() {
                        return Some(Change::Failed);
                    }
                    self.pending.retain(|_, p| p.transaction != transaction);
                }
                ClientEvent::CreatePermissionError(transaction, _) => {
                    self.pending.retain(|_, p| p.transaction != transaction);
                }
                ClientEvent::CreatePermissionResponse(transaction, peer) => {
                    if self
                        .pending
                        .get(&peer)
                        .is_some_and(|p| p.transaction == transaction)
                    {
                        let pending = self.pending.remove(&peer).unwrap();
                        for bytes in pending.packets {
                            let _ = self
                                .client
                                .relay(self.relay.unwrap())
                                .and_then(|mut r| r.send_to(Instant::now(), &bytes, peer));
                        }
                    }
                }
                ClientEvent::DataIndicationOrChannelData(_, peer, bytes) => {
                    if let Some(relay) = self.relay {
                        return Some(Change::Receive(
                            peer,
                            relay,
                            bytes.to_vec(),
                            self.received_at,
                        ));
                    }
                }
                _ => {}
            }
        }
        None
    }
    pub fn flush(&mut self) -> Result<()> {
        while let Some(packet) = self.client.poll_write() {
            if let Err(error) = self.socket.state.try_send(
                (&self.socket.socket).into(),
                &noq_udp::Transmit {
                    destination: self.server,
                    ecn: None,
                    contents: &packet.message,
                    segment_size: None,
                    src_ip: Some(self.local.ip()),
                },
            ) {
                if !matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) {
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }
    pub fn close(&mut self) {
        self.pending.clear();
        while self.client.poll_write().is_some() {}
        let _ = self.client.close();
        if let Some(relay) = self.relay {
            let _ = self
                .client
                .relay(relay)
                .and_then(|mut relay| relay.close(Instant::now()));
            let _ = self.flush();
        }
        let _ = self.client.close();
    }
    pub fn local(&self) -> SocketAddr {
        self.local
    }
}
