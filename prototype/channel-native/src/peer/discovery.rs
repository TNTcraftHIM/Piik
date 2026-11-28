//! Finite pair-scoped STUN work. The runtime remains the sole socket reader.
use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};
use rtc_shared::{TaggedBytesMut, TransportContext, TransportProtocol};
use rtc_stun::{
    agent::StunEvent,
    client::{ClientBuilder, TaggedMessage},
    message::{is_stun_message, Getter, Message, TransactionId, BINDING_REQUEST, BINDING_SUCCESS},
    xoraddr::XorMappedAddress,
};
use sansio::Protocol as _;

#[path = "linear.rs"]
mod linear;

#[derive(Clone)]
pub(super) struct Base {
    pub socket: Arc<UdpIo>,
    pub local: SocketAddr,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum IceTransport {
    Udp,
    Tcp,
    Tls,
}
#[derive(Clone)]
pub(super) struct IceServerUrl {
    pub host: String,
    pub port: u16,
    pub is_turn: bool,
    pub transport: IceTransport,
    pub username: String,
    pub password: String,
}
impl IceServerUrl {
    fn parse(raw: &str, server: &IceServer) -> Result<Option<Self>> {
        ensure!(!raw.contains("//"), "invalid ICE URL");
        // Preserve the existing explicit-UDP STUN spelling before URL parsing.
        let raw = if raw.starts_with("stun:") {
            raw.strip_suffix("?transport=udp").unwrap_or(raw)
        } else {
            raw
        };
        // STUN/TURN URIs omit `//`; url owns authority, IPv6, port and query parsing.
        let url = url::Url::parse(&raw.replacen(':', "://", 1))?;
        let host = url.host_str().context("ICE URL has no host")?;
        let secure = matches!(url.scheme(), "stuns" | "turns");
        let is_turn = match url.scheme() {
            "stun" | "stuns" => false,
            "turn" | "turns" => true,
            _ => anyhow::bail!("unknown ICE URL scheme"),
        };
        let mut query = url.query_pairs();
        let transport = if is_turn {
            let transport = query.next();
            ensure!(query.next().is_none(), "invalid ICE URL query");
            match transport {
                None if secure => IceTransport::Tls,
                None => IceTransport::Udp,
                Some((key, value)) => {
                    ensure!(key == "transport", "invalid ICE URL query");
                    match value.as_ref() {
                        "udp" if secure => return Ok(None),
                        "udp" => IceTransport::Udp,
                        "tcp" if secure => IceTransport::Tls,
                        "tcp" => IceTransport::Tcp,
                        _ => anyhow::bail!("invalid ICE URL transport"),
                    }
                }
            }
        } else {
            ensure!(query.next().is_none(), "STUN URL must not contain a query");
            if secure {
                return Ok(None);
            }
            IceTransport::Udp
        };
        Ok(Some(Self {
            host: host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_owned(),
            port: url.port().unwrap_or(if secure { 5349 } else { 3478 }),
            transport,
            is_turn,
            username: server.username.clone(),
            password: server.credential.clone(),
        }))
    }
}
pub(super) struct Config {
    pub(super) bases: Vec<Base>,
    urls: Vec<IceServerUrl>,
    linear: Option<Arc<Mutex<linear::Linear>>>,
}
impl Config {
    pub fn new(bases: Vec<Base>, urls: &[IceServerUrl], linear: Option<Candidate>) -> Self {
        Self {
            bases,
            urls: urls.iter().filter(|url| !url.is_turn).cloned().collect(),
            linear: linear.map(|base| Arc::new(Mutex::new(linear::Linear::new(base)))),
        }
    }
}
pub(super) fn urls(servers: &[IceServer]) -> Vec<IceServerUrl> {
    servers
        .iter()
        .flat_map(|server| server.urls.iter().map(move |raw| (server, raw)))
        .take(super::super::MAX_ICE_CANDIDATES)
        .filter_map(|(server, raw)| match IceServerUrl::parse(raw, server) {
            Ok(Some(url)) => Some(url),
            Ok(None) => {
                eprintln!("Native transport: unsupported ICE server transport");
                None
            }
            Err(error) => {
                eprintln!("Native ICE URL rejected: {error}");
                None
            }
        })
        .collect()
}

pub(super) struct Route {
    socket: usize,
    local: SocketAddr,
    server: SocketAddr,
    replies: mpsc::Sender<TaggedBytesMut>,
}

pub(super) fn route(engines: &mut HashMap<Uuid, Box<Engine>>, packet: &Datagram) -> bool {
    if !is_stun_message(&packet.bytes) {
        return false;
    }
    let mut message = Message::new();
    if message.unmarshal_binary(&packet.bytes).is_err() {
        return false;
    }
    for (id, engine) in engines {
        if packet
            .owner
            .is_some_and(|owner| owner != (*id, engine.handle.instance))
        {
            continue;
        }
        let Some(route) = engine.discovery_routes.get(&message.transaction_id) else {
            continue;
        };
        if route.socket != packet.socket.as_ptr() as usize
            || route.server != packet.source
            || route.local != packet.destination
        {
            continue;
        }
        let _ = route.replies.try_send(TaggedBytesMut {
            now: packet.at,
            transport: TransportContext {
                local_addr: packet.destination,
                peer_addr: packet.source,
                ecn: None,
                transport_protocol: TransportProtocol::UDP,
            },
            message: packet.bytes.as_slice().into(),
        });
        return true;
    }
    false
}

pub(super) async fn gather(handle: Transport, config: Config) {
    let mut dns: FuturesUnordered<_> = config
        .urls
        .into_iter()
        .map(|url| async move {
            // Reuse the existing finite preparation lookup window. DNS waits do
            // not hold the pump or serialize other configured fallback servers.
            tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::lookup_host((url.host.as_str(), url.port)),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .map(|addresses| {
                let mut families = HashSet::new();
                addresses
                    .filter(|address| families.insert(address.is_ipv4()))
                    .take(2)
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let mut probes = FuturesUnordered::new();
    let mut attempted = HashSet::new();
    while !dns.is_empty() || !probes.is_empty() {
        tokio::select! {
            Some(addresses)=dns.next(),if !dns.is_empty()=> {
                for server in addresses.into_iter().flatten() {
                    for base in &config.bases {
                        if attempted.len() >= super::super::MAX_ICE_CANDIDATES { break; }
                        if base.local.is_ipv4() != server.is_ipv4() || !attempted.insert((base.local,server)) { continue; }
                        let linear = config.linear.as_ref().filter(|state| state.lock().unwrap().local() == base.local);
                        probes.push(binding(handle.clone(),base.clone(),server,linear));
                    }
                }
            }
            Some(result)=probes.next(),if !probes.is_empty()=> {
                if let Err(error)=result { eprintln!("Native STUN discovery: {error}"); }
            }
        }
    }
}

/// One system-resolver lookup on demand, scoped to the pair's initial ICE.
pub(super) async fn nat64(handle: Transport) {
    let prefixes = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host(("ipv4only.arpa.", 0)),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .map(|addresses| {
        super::nat64::discover(
            addresses
                .filter_map(|address| match address.ip() {
                    std::net::IpAddr::V6(ip) => Some(ip),
                    _ => None,
                })
                .take(super::nat64::PREFIX_LIMIT * 2),
            super::nat64::PREFIX_LIMIT,
        )
    })
    .unwrap_or_default();
    let _ = deliver_nat64(&handle, prefixes).await;
}

pub(super) async fn deliver_nat64(
    handle: &Transport,
    prefixes: Vec<super::nat64::Prefix>,
) -> Result<()> {
    handle
        .call(move |engine| {
            if let Some(bootstrap) = &mut engine.nat64 {
                for alias in bootstrap.resolved(prefixes) {
                    engine.rtc.add_remote_candidate(alias);
                }
            }
            Ok(())
        })
        .await
}

async fn binding(
    handle: Transport,
    base: Base,
    server: SocketAddr,
    linear: Option<&Arc<Mutex<linear::Linear>>>,
) -> Result<()> {
    let local = base.local;
    let mut request = Message::new();
    request.build(&[Box::new(BINDING_REQUEST), Box::new(TransactionId::new())])?;
    let transaction = request.transaction_id;
    let (replies, incoming) = mpsc::channel(8);
    let route = Route {
        socket: Arc::as_ptr(&base.socket) as usize,
        local,
        server,
        replies,
    };
    handle
        .call(move |e| {
            ensure!(
                e.discovery_routes.len() < super::super::MAX_ICE_CANDIDATES,
                "STUN discovery route limit"
            );
            e.discovery_routes.insert(transaction, route);
            Ok(())
        })
        .await?;
    let mut slot = None;
    let result = observe(&base, server, request, incoming, || {
        slot = linear.and_then(|state| state.lock().unwrap().sent(server));
    })
    .await;
    let mapped = result.as_ref().ok().copied();
    let linear = linear.cloned();
    handle
        .call(move |e| {
            e.discovery_routes.remove(&transaction);
            let registered = match mapped {
                Some(mapped) => e
                    .rtc
                    .add_local_candidate(Candidate::server_reflexive(mapped, local, "udp")?)
                    .cloned(),
                None => None,
            };
            if let Some(candidate) = &registered {
                e.emit(Event::Candidate(e.handle.pair, candidate.clone(), None));
            }
            if let Some(linear) = linear {
                let mut state = linear.lock().unwrap();
                if e.linear_current(state.ufrag()) {
                    for candidate in state.candidates(slot, mapped, registered)? {
                        e.emit(Event::Candidate(
                            e.handle.pair,
                            candidate,
                            Some(piik_channel_core::wire::CandidateOrigin::Linear),
                        ));
                    }
                }
            }
            Ok(())
        })
        .await?;
    result.map(|_| ())
}

async fn observe(
    base: &Base,
    server: SocketAddr,
    request: Message,
    mut incoming: mpsc::Receiver<TaggedBytesMut>,
    first_send: impl FnOnce(),
) -> Result<SocketAddr> {
    let mut first_send = Some(first_send);
    let local = base.local;
    let mut client =
        ClientBuilder::new().build(Instant::now(), local, server, TransportProtocol::UDP)?;
    client.handle_write(TaggedMessage {
        now: Instant::now(),
        message: request,
    })?;
    loop {
        if let Some(event) = client.poll_event() {
            let StunEvent::Message(message) = event else {
                anyhow::bail!("binding transaction ended");
            };
            ensure!(message.typ == BINDING_SUCCESS, "binding rejected");
            let mut mapped = XorMappedAddress::default();
            mapped.get_from(&message)?;
            ensure!(
                mapped.ip.is_ipv4() == local.is_ipv4()
                    && !mapped.ip.is_unspecified()
                    && !mapped.ip.is_multicast()
                    && mapped.port != 0,
                "unusable mapped address"
            );
            return Ok(SocketAddr::new(mapped.ip, mapped.port));
        }
        while let Some(packet) = client.poll_write() {
            if let Err(error) = base.socket.state.try_send(
                (&base.socket.socket).into(),
                &noq_udp::Transmit {
                    destination: server,
                    ecn: None,
                    contents: &packet.message,
                    segment_size: None,
                    src_ip: Some(local.ip()),
                },
            ) {
                // A full UDP send queue loses this request; the mature client
                // retains the transaction deadline/retransmission schedule.
                if error.kind() != std::io::ErrorKind::WouldBlock {
                    return Err(error.into());
                }
            } else if let Some(sent) = first_send.take() {
                sent();
            }
        }
        let deadline = client.poll_timeout().context("binding transaction ended")?;
        tokio::select! {
            _=tokio::time::sleep_until(deadline.into())=>client.handle_timeout(Instant::now())?,
            reply=incoming.recv()=>{let reply=reply.context("binding route retired")?;let _=client.handle_read(reply);}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ordinary_transactions_emit_one_linear_batch_without_registering_fake_local_mappings(
    ) -> Result<()> {
        use crate::peer::{server_udp::ServerUdp, tests::support::endpoint};
        // An explicitly bound loopback socket exercises the same pump and
        // transaction routes without involving any external STUN destination.
        let fixed = ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
        let runtime = Runtime::new(Some(fixed));
        let (peer, mut events) = endpoint(&runtime, Uuid::new_v4()).await?;
        let Some(Event::Candidate(_, seed, None)) = events.recv().await else {
            anyhow::bail!("ordinary base missing")
        };
        let base = peer
            .call(|engine| {
                // Production selects only exclusive ordinary bases. This fixture
                // supplies loopback explicitly and enables only that eligibility.
                engine.linear_enabled = true;
                let socket = engine.sockets[0].clone();
                Ok(Base {
                    local: socket.local_addr()?,
                    socket,
                })
            })
            .await?;
        let local = base.local;
        let generation = seed.ufrag().unwrap().to_owned();
        let linear = Arc::new(Mutex::new(linear::Linear::new(seed)));
        let mut servers = Vec::new();
        for _ in 0..4 {
            servers.push(UdpSocket::bind("127.0.0.1:0").await?);
        }
        let mut bindings = Vec::new();
        let mut requests = Vec::new();
        for server in &servers {
            let mut binding = Box::pin(binding(
                peer.clone(),
                base.clone(),
                server.local_addr()?,
                Some(&linear),
            ));
            let mut bytes = [0; 1024];
            let (n, from) = tokio::select! {
                result = &mut binding => anyhow::bail!("binding ended before its response: {}",result.is_ok()),
                received = server.recv_from(&mut bytes) => received?,
            };
            let mut request = Message {
                raw: bytes[..n].to_vec(),
                ..Default::default()
            };
            request.decode()?;
            requests.push((request.transaction_id, from));
            bindings.push(binding);
        }
        // Deliberately reverse completion; only original sends define the order.
        // The fourth server shares the first mapping and replies before that sample.
        for index in (0..4).rev() {
            let (transaction, from) = requests[index];
            let mut response = Message::new();
            response.build(&[
                Box::new(BINDING_SUCCESS),
                Box::new(transaction),
                Box::new(XorMappedAddress {
                    ip: "203.0.113.1".parse()?,
                    port: 40000 + (index % 3) as u16,
                }),
            ])?;
            servers[index].send_to(&response.raw, from).await?;
            bindings.pop().unwrap().await?;
        }
        let emitted: Vec<_> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                Event::Candidate(_, candidate, origin) => Some((candidate, origin)),
                _ => None,
            })
            .collect();
        assert_eq!(
            emitted
                .iter()
                .filter(|(_, origin)| origin.is_none())
                .count(),
            3
        );
        assert_eq!(
            emitted
                .iter()
                .filter(|(_, origin)| origin.is_some())
                .count(),
            16
        );
        assert!(emitted
            .iter()
            .all(|(candidate, _)| candidate.ufrag() == Some(generation.as_str())));
        for (candidate, origin) in emitted.iter().filter(|(_, origin)| origin.is_some()) {
            let signaled = crate::peer::signal_candidate(candidate.clone(), *origin);
            assert!(signaled.sdp_mid.is_none());
            assert_eq!(signaled.sdp_m_line_index, Some(0));
            assert_eq!(
                signaled.username_fragment.as_deref(),
                Some(generation.as_str())
            );
        }
        assert!(peer.can_signal_linear(generation.clone()).await);
        assert!(!peer.can_signal_linear("stale".into()).await);
        peer.create_channel("ordinary-owner").await?;
        let sdp = peer.offer()
            .await?
            .and_then(|offer| offer.sdp)
            .ok_or_else(|| anyhow!("missing local offer"))?;
        let mappings: Vec<_> = sdp
            .lines()
            .filter_map(|line| line.strip_prefix("a=candidate:"))
            .map(|line| Candidate::from_sdp_string(&format!("candidate:{line}")))
            .collect::<std::result::Result<_, _>>()?;
        let ports: HashSet<_> = mappings
            .iter()
            .filter(|candidate| candidate.kind() == str0m::CandidateKind::ServerReflexive)
            .map(|candidate| candidate.addr().port())
            .collect();
        assert_eq!(ports, HashSet::from([40000, 40001, 40002]));
        peer.call(|engine| {
            engine.stats_origin = Instant::now() - Duration::from_secs(5);
            Ok(())
        })
        .await?;
        assert!(!peer.can_signal_linear(generation).await);
        peer.close().await?;
        runtime.close().await;
        drop(base);
        UdpSocket::bind(local).await?;
        Ok(())
    }

    #[tokio::test]
    async fn first_ice_connection_retires_linear_signaling_before_dtls() -> Result<()> {
        use crate::peer::{server_udp::ServerUdp, tests::support::endpoint};
        let fixed = ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
        let runtime = Runtime::new(Some(fixed));
        let (peer, _events) = endpoint(&runtime, Uuid::new_v4()).await?;
        let generation = peer.call(|engine| {
            engine.linear_enabled = true;
            Ok(engine.rtc.direct_api().local_ice_credentials().ufrag)
        }).await?;
        assert!(peer.can_signal_linear(generation.clone()).await);
        peer.call(|engine| {
            engine.event(RtcEvent::IceConnectionStateChange(str0m::IceConnectionState::Connected));
            assert!(!engine.rtc.is_connected());
            Ok(())
        }).await?;
        assert!(!peer.can_signal_linear(generation).await);
        peer.close().await?;
        runtime.close().await;
        Ok(())
    }

    #[test]
    fn ice_urls_keep_endpoints_and_configured_credentials() -> Result<()> {
        let mut parsed = Vec::new();
        for (raw, is_turn, host, port) in [
            ("stun:localhost", false, "localhost", 3478),
            ("STUN:localhost:1234", false, "localhost", 1234),
            ("stun:127.0.0.1:0", false, "127.0.0.1", 0),
            ("stun:[::1]", false, "::1", 3478),
            ("stun:[2001:db8::1]:1234", false, "2001:db8::1", 1234),
            ("stun:localhost?transport=udp", false, "localhost", 3478),
            ("stun:localhost/path", false, "localhost", 3478),
            (
                "stun:fixture:dummy@localhost:1234",
                false,
                "localhost",
                1234,
            ),
            ("stun:localhost#fragment", false, "localhost", 3478),
            ("turn:localhost", true, "localhost", 3478),
            ("turn:localhost?transport=tcp", true, "localhost", 3478),
            ("turns:localhost", true, "localhost", 5349),
            ("turns:localhost:443?transport=tcp", true, "localhost", 443),
            (
                "turn:localhost:65535?transport=udp",
                true,
                "localhost",
                65535,
            ),
            ("turn:[::1]?transport=udp", true, "::1", 3478),
            (
                "turn:fixture:dummy@[::1]:1234/path#fragment",
                true,
                "::1",
                1234,
            ),
        ] {
            let server = IceServer {
                urls: vec![raw.into()],
                username: "configured-user".into(),
                credential: "configured-password".into(),
            };
            let result = urls(&[server]);
            assert_eq!(result.len(), 1, "{raw}");
            let result = &result[0];
            assert_eq!(
                (result.is_turn, result.host.as_str(), result.port),
                (is_turn, host, port),
                "{raw}"
            );
            assert_eq!(result.username, "configured-user");
            assert_eq!(result.password, "configured-password");
            parsed.push(result.clone());
        }
        let stun = Config::new(Vec::new(), &parsed, None);
        assert_eq!(stun.urls.len(), 9);
        assert!(stun.urls.iter().all(|url| !url.is_turn));
        Ok(())
    }

    #[test]
    fn unsupported_and_invalid_ice_urls_leave_other_configured_servers_usable() -> Result<()> {
        for (raw, unsupported) in [
            ("stuns:localhost", true),
            ("turns:localhost?transport=udp", true),
            ("", false),
            ("stun:", false),
            ("stun://localhost", false),
            ("stun:localhost:abc", false),
            ("stun:localhost:65536", false),
            ("stun:[::1]:123:", false),
            ("stun:localhost?transport=tcp", false),
            ("turn:localhost?trans=udp", false),
            ("turn:localhost?transport=ip", false),
            ("turn:localhost?transport=udp&another=1", false),
        ] {
            let server = IceServer {
                urls: vec![raw.into(), "stun:localhost".into()],
                ..Default::default()
            };
            let result = IceServerUrl::parse(raw, &server);
            if unsupported {
                assert!(result?.is_none(), "{raw}");
            } else {
                assert!(result.is_err(), "{raw}");
            }
            let retained = urls(&[server]);
            assert_eq!(retained.len(), 1, "{raw}");
            assert_eq!(retained[0].host, "localhost");
        }
        Ok(())
    }
}
