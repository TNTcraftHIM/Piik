//! Finite pair-scoped STUN work. The runtime remains the sole socket reader.
use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};
use rtc::{
    ice::url::{ProtoType, SchemeType, Url},
    sansio::Protocol as _,
    shared::{TaggedBytesMut, TransportContext, TransportProtocol},
    stun::{
        agent::StunEvent,
        client::{ClientBuilder, TaggedMessage},
        message::{
            is_stun_message, Getter, Message, TransactionId, BINDING_REQUEST, BINDING_SUCCESS,
        },
        xoraddr::XorMappedAddress,
    },
};

#[derive(Clone)]
pub(super) struct Base {
    pub socket: Arc<UdpIo>,
    pub local: SocketAddr,
    pub candidate: RTCIceCandidate,
}
pub(super) struct Config {
    bases: Vec<Base>,
    urls: Vec<Url>,
}
impl Config {
    pub fn new(bases: Vec<Base>, urls: &[Url]) -> Self {
        Self {
            bases,
            urls: urls
                .iter()
                .filter(|url| url.scheme == SchemeType::Stun && url.proto == ProtoType::Udp)
                .cloned()
                .collect(),
        }
    }
}
pub(super) fn urls(servers: &[RTCIceServer]) -> Vec<Url> {
    servers
        .iter()
        .flat_map(|server| server.urls.iter().map(move |raw| (server, raw)))
        .take(super::super::MAX_ICE_CANDIDATES)
        .filter_map(|(server, raw)| {
            // rtc's mature parser rejects STUN query strings; retain the
            // existing common explicit-UDP spelling before passing it on.
            let normalized = if raw.starts_with("stun:") {
                raw.strip_suffix("?transport=udp").unwrap_or(raw)
            } else {
                raw
            };
            match Url::parse_url(normalized) {
                Ok(mut url)
                    if matches!(url.scheme, SchemeType::Stun | SchemeType::Turn)
                        && url.proto == ProtoType::Udp =>
                {
                    url.username = server.username.clone();
                    url.password = server.credential.clone();
                    Some(url)
                }
                Ok(_) => {
                    eprintln!("Native transport: secure/TCP ICE URLs are unsupported");
                    None
                }
                Err(error) => {
                    eprintln!("Native STUN URL rejected: {error}");
                    None
                }
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
    let host = base.candidate;
    handle
        .call(move |e| {
            e.discovery_routes.remove(&transaction);
            if let Some(mapped) = mapped {
                let signal = super::super::mapping::candidate(&host, mapped)?;
                if e.rtc
                    .add_local_candidate(Candidate::server_reflexive(mapped, local, "udp")?)
                    .is_some()
                {
                    e.emit(Event::Candidate(e.handle.pair, signal));
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
