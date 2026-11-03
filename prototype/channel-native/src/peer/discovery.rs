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

#[derive(Clone)]
pub(super) struct Base {
    pub socket: Arc<UdpIo>,
    pub local: SocketAddr,
}
#[derive(Clone)]
pub(super) struct IceServerUrl {
    pub host: String,
    pub port: u16,
    pub is_turn: bool,
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
        let udp = if is_turn {
            let transport = query.next();
            ensure!(query.next().is_none(), "invalid ICE URL query");
            match transport {
                None => !secure,
                Some((key, value)) => {
                    ensure!(key == "transport", "invalid ICE URL query");
                    match value.as_ref() {
                        "udp" => true,
                        "tcp" => false,
                        _ => anyhow::bail!("invalid ICE URL transport"),
                    }
                }
            }
        } else {
            ensure!(query.next().is_none(), "STUN URL must not contain a query");
            !secure
        };
        if secure || !udp {
            return Ok(None);
        }
        Ok(Some(Self {
            host: host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_owned(),
            port: url.port().unwrap_or(3478),
            is_turn,
            username: server.username.clone(),
            password: server.credential.clone(),
        }))
    }
}
pub(super) struct Config {
    bases: Vec<Base>,
    urls: Vec<IceServerUrl>,
}
impl Config {
    pub fn new(bases: Vec<Base>, urls: &[IceServerUrl]) -> Self {
        Self {
            bases,
            urls: urls.iter().filter(|url| !url.is_turn).cloned().collect(),
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
                eprintln!("Native transport: secure/TCP ICE URLs are unsupported");
                None
            }
            Err(error) => {
                eprintln!("Native STUN URL rejected: {error}");
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
        if route.socket != packet.socket
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
                        probes.push(binding(handle.clone(),base.clone(),server));
                    }
                }
            }
            Some(result)=probes.next(),if !probes.is_empty()=> {
                if let Err(error)=result { eprintln!("Native STUN discovery: {error}"); }
            }
        }
    }
}

async fn binding(handle: Transport, base: Base, server: SocketAddr) -> Result<()> {
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
    let result = observe(&base, server, request, incoming).await;
    let mapped = result.as_ref().ok().copied();
    handle
        .call(move |e| {
            e.discovery_routes.remove(&transaction);
            if let Some(mapped) = mapped {
                if let Some(candidate) = e
                    .rtc
                    .add_local_candidate(Candidate::server_reflexive(mapped, local, "udp")?)
                    .cloned()
                {
                    e.emit(Event::Candidate(e.handle.pair, candidate));
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
) -> Result<SocketAddr> {
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

    #[test]
    fn udp_ice_urls_keep_endpoints_and_configured_credentials() -> Result<()> {
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
        let stun = Config::new(Vec::new(), &parsed);
        assert_eq!(stun.urls.len(), 9);
        assert!(stun.urls.iter().all(|url| !url.is_turn));
        Ok(())
    }

    #[test]
    fn unsupported_and_invalid_ice_urls_leave_other_configured_servers_usable() -> Result<()> {
        for (raw, unsupported) in [
            ("stuns:localhost", true),
            ("turns:localhost?transport=udp", true),
            ("turn:localhost?transport=tcp", true),
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
