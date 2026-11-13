//! One owned sans-I/O pump. Room/flow policy and bounded producers remain outside it.
use super::metrics::StreamCounters;
use super::{server_udp::ServerUdp, Event};
use crate::media::{MediaKind, RtpCodec, RtpCodecParameters, SourceClockReport};
use crate::peer::{IceServer, PeerState};
use anyhow::{anyhow, ensure, Context, Result};
use rtc_rtp as rtp;
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use str0m::{
    bwe::{Bitrate, BweKind},
    change::{SdpAnswer, SdpOffer, SdpPendingOffer},
    channel::{ChannelConfig, ChannelId, Reliability},
    format::{Codec, FormatParams, PayloadParams},
    media::{Direction, Frequency, Mid, Rid, Rids},
    net::{Protocol, Receive},
    rtp::{RtpWrite, SeqNo},
    stats::{MediaEgressStats, MediaIngressStats, PeerStats},
    Candidate, Event as RtcEvent, Input, Output, Rtc,
};
use tokio::{
    net::UdpSocket,
    sync::{mpsc, oneshot, watch, Notify, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Estimate {
    Startup(f64),
    Feedback(f64),
}
impl Estimate {
    pub fn feedback(self) -> Option<f64> {
        if let Self::Feedback(v) = self {
            Some(v)
        } else {
            None
        }
    }
}

// Finite SDK probing target when source demand is unknown, not a media limit.
// An explicitly idle connection requests zero instead.
const UNKNOWN_DEMAND_PROBE_BPS: u64 = 100_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BandwidthDemand {
    pub minimum_bps: u64,
    pub desired_bps: Option<u64>,
}

fn desired_bps(ceiling: Option<u64>) -> u64 {
    ceiling.unwrap_or(UNKNOWN_DEMAND_PROBE_BPS)
}

fn host_candidates(
    local: SocketAddr,
    interfaces: impl Iterator<Item = std::net::IpAddr>,
) -> Result<Vec<Candidate>> {
    if !local.ip().is_unspecified() {
        return Ok(vec![Candidate::host(local, "udp")?]);
    }
    // Interface discovery includes addresses the ICE SDK cannot advertise.
    // One such address must not discard the socket's other usable candidates.
    Ok(interfaces
        .filter(|ip| {
            ip.is_ipv4() == local.is_ipv4()
                && !ip.is_unspecified()
                && !ip.is_loopback()
                && !matches!(ip, std::net::IpAddr::V6(ip) if ip.is_unicast_link_local())
        })
        .filter_map(|ip| Candidate::host(SocketAddr::new(ip, local.port()), "udp").ok())
        .collect())
}

#[path = "discovery.rs"]
mod discovery;
#[cfg(test)]
#[path = "tests/transport.rs"]
mod tests;
#[path = "turn.rs"]
mod turn;

type Action = Box<dyn FnOnce(&mut Engine) + Send>;
enum Command {
    Add(
        Uuid,
        Box<Engine>,
        Option<(discovery::Config, turn::Setup)>,
        oneshot::Sender<()>,
    ),
    TurnReady(Uuid, Uuid),
    Run(Uuid, Uuid, Action),
    Remove(Uuid, Uuid, oneshot::Sender<()>),
    Stop,
}
struct Datagram {
    socket: usize,
    owner: Option<(Uuid, Uuid)>,
    source: SocketAddr,
    destination: SocketAddr,
    at: Instant,
    bytes: Vec<u8>,
}
struct Socket {
    socket: Arc<UdpIo>,
    owner: Option<(Uuid, Uuid)>,
    task: JoinHandle<()>,
}
pub(super) struct UdpIo {
    socket: UdpSocket,
    state: noq_udp::UdpSocketState,
}
impl UdpIo {
    pub(super) fn new(socket: UdpSocket) -> std::io::Result<Self> {
        let state = noq_udp::UdpSocketState::new((&socket).into())?;
        if state.recv_buffer_size((&socket).into()).unwrap_or(0) < 2 * 1024 * 1024 {
            let _ = state.set_recv_buffer_size((&socket).into(), 2 * 1024 * 1024);
        }
        Ok(Self { socket, state })
    }
    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.socket.local_addr()
    }
}
pub(crate) struct Runtime {
    tx: mpsc::Sender<Command>,
    task: JoinHandle<()>,
    fixed: Option<Arc<ServerUdp>>,
}
#[derive(Clone)]
pub(crate) struct Transport {
    pair: Uuid,
    instance: Uuid,
    tx: mpsc::Sender<Command>,
}
pub(crate) struct AcceptedInput {
    pub answer: String,
    pub transport: Transport,
    pub tracks: mpsc::Receiver<Track>,
    pub ended: watch::Receiver<Option<Result<(), String>>>,
}
enum EventTarget {
    Peer(mpsc::Sender<Event>),
    Local {
        tracks: mpsc::Sender<Track>,
        ended: watch::Sender<Option<Result<(), String>>>,
    },
}
impl EventTarget {
    fn local(&self) -> bool {
        matches!(self, Self::Local { .. })
    }
}
fn validate_local_offer(offer: &SdpOffer) -> Result<()> {
    ensure!(
        (1..=2).contains(&offer.media_lines.len()),
        "local input requires one video and optional audio track"
    );
    let mut video = 0;
    let mut audio = 0;
    for line in &offer.media_lines {
        ensure!(
            line.direction() == Direction::SendOnly,
            "local input must be send-only"
        );
        ensure!(
            line.simulcast().is_none(),
            "local input does not accept layered tracks"
        );
        let (kind, expected) = match line.typ.to_string().as_str() {
            "video" => {
                video += 1;
                (MediaKind::Video, Codec::H264)
            }
            "audio" => {
                audio += 1;
                (MediaKind::Audio, Codec::Opus)
            }
            _ => anyhow::bail!("unsupported local input media"),
        };
        ensure!(
            line.rtp_params()
                .iter()
                .any(|params| params.spec().codec == expected
                    && crate::media::supported(&codec(params).rtp_codec, kind)),
            "unsupported local input codec"
        );
    }
    ensure!(
        video == 1 && audio <= 1,
        "local input requires one video and optional audio track"
    );
    Ok(())
}
struct Outgoing {
    since: Instant,
    codec: RtpCodec,
    kind: MediaKind,
    stream: String,
    rids: Vec<String>,
    mid: Option<Mid>,
    retired: bool,
    reusable: bool,
    feedback: mpsc::Sender<String>,
    seq: HashMap<String, SeqNo>,
    writable: Arc<Notify>,
    waiting: HashSet<String>,
}
// One peer owns a bounded receive handoff shared by its reliable channels.
const RECEIVE_MEMORY: usize = 10 * 1024 * 1024;
// Conservative per-item admission charge for the event envelope and queue links;
// this does not claim exact allocator RSS. Empty messages still consume memory.
const RECEIVE_EVENT_MEMORY: usize =
    std::mem::size_of::<QueuedChannelEvent>() + 2 * std::mem::size_of::<usize>();

struct QueuedChannelEvent {
    event: ChannelEvent,
    _memory: Option<OwnedSemaphorePermit>,
}
struct ChannelState {
    id: Option<ChannelId>,
    config: ChannelConfig,
    tx: mpsc::UnboundedSender<QueuedChannelEvent>,
    low: Arc<Notify>,
    closed: Arc<AtomicBool>,
}
impl ChannelState {
    fn push(&self, event: ChannelEvent, memory: &Arc<Semaphore>) -> Result<(), ()> {
        let permit = if let ChannelEvent::Message(bytes) = &event {
            let charge = bytes
                .capacity()
                .checked_add(RECEIVE_EVENT_MEMORY)
                .ok_or(())?;
            let charge = u32::try_from(charge).map_err(|_| ())?;
            Some(
                memory
                    .clone()
                    .try_acquire_many_owned(charge)
                    .map_err(|_| ())?,
            )
        } else {
            // The SDK's fixed Open/Close lifecycle events retain their allowance
            // independently of data admission, in this same ordered FIFO.
            None
        };
        self.tx
            .send(QueuedChannelEvent {
                event,
                _memory: permit,
            })
            .map_err(|_| ())
    }
}
#[derive(Clone)]
pub(crate) struct Channel {
    transport: Transport,
    token: Uuid,
    pub label: String,
    pub config: ChannelConfig,
    rx: Arc<tokio::sync::Mutex<mpsc::UnboundedReceiver<QueuedChannelEvent>>>,
    pub low: Arc<Notify>,
    closed: Arc<AtomicBool>,
}
pub(crate) enum ChannelEvent {
    Open,
    Message(Vec<u8>),
    Close,
}
#[derive(Clone)]
pub(crate) struct Track {
    transport: Transport,
    pub mid: Mid,
    pub stream: String,
    pub id: String,
    pub kind: MediaKind,
    pub rids: Vec<String>,
    pub first_ssrc: u32,
    pub first_codec: RtpCodecParameters,
    packets: Arc<tokio::sync::Mutex<mpsc::Receiver<TrackEvent>>>,
    encodings: Arc<Mutex<HashMap<u32, (String, RtpCodecParameters)>>>,
    reports: Arc<Mutex<HashMap<u32, (SourceClockReport, Instant)>>>,
}
pub(crate) enum TrackEvent {
    Rtp(rtp::Packet, u64, u64, RtpCodec),
    Report(Vec<(SourceClockReport, Instant)>),
    End,
}
struct TrackState {
    since: Instant,
    track: Track,
    tx: mpsc::Sender<TrackEvent>,
}
pub(super) struct TransportStreamMetric {
    pub stream: String,
    pub outgoing: bool,
    pub media: MediaKind,
    pub counters: StreamCounters,
}
pub(super) struct TransportMetrics {
    pub connection_id: Uuid,
    pub sample_timestamp_ms: Option<f64>,
    pub age_ms: Option<f64>,
    pub rtt_ms: Option<f64>,
    pub bwe_bps: Option<f64>,
    pub streams: Vec<TransportStreamMetric>,
}
pub(crate) struct Engine {
    stats_origin: Instant,
    peer_stats: Option<PeerStats>,
    ingress_stats: HashMap<(Mid, Option<Rid>), MediaIngressStats>,
    egress_stats: HashMap<(Mid, Option<Rid>), MediaEgressStats>,
    rtc: Rtc,
    handle: Transport,
    sockets: Vec<Arc<UdpIo>>,
    discovery: Option<JoinHandle<()>>,
    discovery_routes: HashMap<rtc_stun::message::TransactionId, discovery::Route>,
    turn: HashMap<usize, turn::Endpoint>,
    turn_setup: mpsc::Receiver<turn::Endpoint>,
    turn_setup_task: Option<JoinHandle<()>>,
    retired_turn: Vec<usize>,
    events: EventTarget,
    overflow: Arc<AtomicBool>,
    state: Arc<AtomicU8>,
    channels: HashMap<Uuid, ChannelState>,
    receive_memory: Arc<Semaphore>,
    tracks: HashMap<Mid, TrackState>,
    clocks: HashMap<String, Arc<Mutex<Option<(SystemTime, Instant)>>>>,
    sender_reports: HashMap<u32, (Mid, SourceClockReport, Instant)>,
    outputs: HashMap<Uuid, Outgoing>,
    pending: Option<SdpPendingOffer>,
    local: Option<(String, String)>,
    remote: bool,
    remote_media: HashMap<Mid, (String, String)>,
    negotiated: bool,
    bandwidth: watch::Sender<Estimate>,
    demand: watch::Receiver<BandwidthDemand>,
    bandwidth_changed: Arc<Notify>,
    reported: bool,
    estimate: f64,
    deadline: Instant,
}

impl Runtime {
    pub fn new(fixed: Option<Arc<ServerUdp>>) -> Self {
        let (tx, mut commands) = mpsc::channel::<Command>(64);
        let fixed_run = fixed.clone();
        let task = tokio::spawn(async move {
            let (network, mut incoming) = mpsc::channel::<Datagram>(256);
            let mut sockets: Vec<Socket> = vec![];
            let mut engines: HashMap<Uuid, Box<Engine>> = HashMap::new();
            if let Some(fixed) = &fixed_run {
                if fixed.leased.swap(true, Ordering::AcqRel) {
                    return;
                }
                for socket in &fixed.sockets {
                    add_reader(&mut sockets, socket.clone(), None, network.clone());
                }
            }
            loop {
                let retired: HashSet<_> = engines
                    .values_mut()
                    .flat_map(|e| std::mem::take(&mut e.retired_turn))
                    .collect();
                for socket in &mut sockets {
                    if retired.contains(&(Arc::as_ptr(&socket.socket) as usize)) {
                        socket.task.abort();
                        let _ = (&mut socket.task).await;
                    }
                }
                sockets.retain(|s| !retired.contains(&(Arc::as_ptr(&s.socket) as usize)));
                let next = engines
                    .values()
                    .map(|e| e.deadline)
                    .min()
                    .unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
                tokio::select! {
                    command=commands.recv()=> match command {
                        Some(Command::Add(id,mut engine,connectivity,done))=> {
                            for socket in &engine.sockets {
                                if !sockets.iter().any(|s|Arc::ptr_eq(&s.socket,socket)) { add_reader(&mut sockets,socket.clone(),Some((id,engine.handle.instance)),network.clone()); }
                            }
                            engine.drain(); engines.insert(id,engine);
                            let engine=engines.get_mut(&id).unwrap();
                            if let Some((config,turn))=connectivity {
                                engine.discovery=Some(tokio::spawn(discovery::gather(engine.handle.clone(),config)));
                                engine.turn_setup_task=Some(tokio::spawn(turn::setup(engine.handle.clone(),turn)));
                            }
                            let _=done.send(());
                        }
                        Some(Command::TurnReady(id,instance))=>if let Some(engine)=engines.get_mut(&id).filter(|e|e.handle.instance==instance) {
                            while let Ok(mut endpoint)=engine.turn_setup.try_recv() {
                                if let Err(error)=endpoint.allocate(){eprintln!("Native TURN allocation: {error}");continue;}
                                let key=Arc::as_ptr(&endpoint.socket) as usize;
                                add_reader(&mut sockets,endpoint.socket.clone(),Some((id,instance)),network.clone());
                                engine.turn.insert(key,endpoint);
                            }
                            engine.drain();
                        },
                        Some(Command::Run(id,instance,action))=>if let Some(engine)=engines.get_mut(&id).filter(|e|e.handle.instance==instance) { action(engine);engine.drain(); },
                        Some(Command::Remove(id,instance,done))=> {
                            if engines.get(&id).is_some_and(|e|e.handle.instance==instance){if let Some(mut engine)=engines.remove(&id){
                                engine.close().await;
                            }}
                            for socket in &mut sockets {if socket.owner==Some((id,instance)) {socket.task.abort();let _=(&mut socket.task).await;}}
                            sockets.retain(|s|s.owner!=Some((id,instance)));let _=done.send(());
                        }
                        Some(Command::Stop)|None=>break,
                    },
                    Some(packet)=incoming.recv()=> {
                        let mut relayed=false;
                        if let Some((id,instance))=packet.owner {
                            if let Some(engine)=engines.get_mut(&id).filter(|e|e.handle.instance==instance) {
                                if let Some(endpoint)=engine.turn.get_mut(&packet.socket){endpoint.read(&packet);engine.drain();relayed=true;}
                            }
                        }
                        if relayed {continue;}
                        if discovery::route(&mut engines,&packet){continue;}
                        let owner=packet.owner;
                        for (id,engine) in &mut engines {
                            if (owner.is_none()||owner==Some((*id,engine.handle.instance))) && engine.receive(packet.at,packet.source,packet.destination,&packet.bytes) {
                                engine.drain();break;
                            }
                        }
                    },
                    _=async {
                        // A freshly expired Sleep can still wait for Tokio's next millisecond tick.
                        if next > Instant::now() { tokio::time::sleep_until(next.into()).await; }
                    }=> {
                        let now=Instant::now();
                        for engine in engines.values_mut().filter(|e|e.deadline<=now) {
                            for endpoint in engine.turn.values_mut(){endpoint.timeout(now);}
                            let _=engine.rtc.handle_input(Input::Timeout(now));engine.drain();
                        }
                    }
                }
            }
            for engine in engines.values_mut() {
                engine.close().await;
            }
            engines.clear();
            for mut socket in sockets {
                socket.task.abort();
                let _ = (&mut socket.task).await;
            }
            if let Some(fixed) = fixed_run {
                fixed.leased.store(false, Ordering::Release);
            }
        });
        Self { tx, task, fixed }
    }
    pub async fn add(
        &self,
        pair: Uuid,
        prepared: Option<std::net::UdpSocket>,
        events: mpsc::Sender<Event>,
        overflow: Arc<AtomicBool>,
        state: Arc<AtomicU8>,
        demand: watch::Receiver<BandwidthDemand>,
        changed: Arc<Notify>,
        ice: &[IceServer],
    ) -> Result<(Transport, watch::Receiver<Estimate>)> {
        self.add_engine(
            pair,
            prepared,
            EventTarget::Peer(events),
            overflow,
            state,
            demand,
            changed,
            ice,
        )
        .await
    }
    pub async fn accept_local_input(&self, offer: &str) -> Result<AcceptedInput> {
        ensure!(
            offer.len() <= 150_000,
            "local input SDP exceeds media limit"
        );
        let parsed = SdpOffer::from_sdp_string(offer)?;
        validate_local_offer(&parsed)?;
        let (tracks, received) = mpsc::channel(2);
        let (ended, end) = watch::channel(None);
        let (_, demand) = watch::channel(BandwidthDemand {
            minimum_bps: 0,
            desired_bps: Some(0),
        });
        let (transport, _) = self
            .add_engine(
                Uuid::new_v4(),
                None,
                EventTarget::Local { tracks, ended },
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicU8::new(PeerState::New as u8)),
                demand,
                Arc::new(Notify::new()),
                &[],
            )
            .await?;
        let result = async {
            transport.accept("offer".into(), offer.to_owned()).await?;
            let (_, answer) = transport.local_description().await?;
            let parsed = SdpAnswer::from_sdp_string(&answer)?;
            let mids = parsed
                .media_lines
                .iter()
                .map(|line| line.mid())
                .collect::<Vec<_>>();
            transport
                .call(move |engine| {
                    ensure!(
                        mids.iter().all(|mid| engine
                            .rtc
                            .media(*mid)
                            .is_some_and(|media| !media.disabled()
                                && media.direction() == Direction::RecvOnly
                                && !media.remote_pts().is_empty())),
                        "local input tracks were not negotiated"
                    );
                    Ok(())
                })
                .await?;
            Ok(answer)
        }
        .await;
        match result {
            Ok(answer) => Ok(AcceptedInput {
                answer,
                transport,
                tracks: received,
                ended: end,
            }),
            Err(error) => {
                transport.close().await?;
                Err(error)
            }
        }
    }
    async fn add_engine(
        &self,
        pair: Uuid,
        prepared: Option<std::net::UdpSocket>,
        events: EventTarget,
        overflow: Arc<AtomicBool>,
        state: Arc<AtomicU8>,
        mut demand: watch::Receiver<BandwidthDemand>,
        changed: Arc<Notify>,
        ice: &[IceServer],
    ) -> Result<(Transport, watch::Receiver<Estimate>)> {
        let local_input = events.local();
        let handle = Transport {
            pair,
            instance: Uuid::new_v4(),
            tx: self.tx.clone(),
        };
        let mut sockets = vec![];
        if local_input {
            sockets.push(Arc::new(UdpIo::new(UdpSocket::bind("127.0.0.1:0").await?)?));
        } else if let Some(fixed) = &self.fixed {
            ensure!(
                prepared.is_none(),
                "fixed UDP cannot consume prepared socket"
            );
            sockets = fixed.sockets.clone();
        } else if let Some(socket) = prepared {
            socket.set_nonblocking(true)?;
            sockets.push(Arc::new(UdpIo::new(UdpSocket::from_std(socket)?)?));
        }
        if !local_input && self.fixed.is_none() {
            for bind in ["0.0.0.0:0", "[::]:0"] {
                if sockets.iter().any(|s| {
                    s.local_addr()
                        .is_ok_and(|a| a.is_ipv4() == bind.starts_with('0'))
                }) {
                    continue;
                }
                if let Ok(socket) = UdpSocket::bind(bind).await {
                    sockets.push(Arc::new(UdpIo::new(socket)?));
                }
            }
        }
        ensure!(!sockets.is_empty(), "no UDP socket");
        let mut config = Rtc::builder()
            .clear_codecs()
            .enable_vp8(!local_input)
            .set_rtp_mode(true)
            .enable_bwe(Some(Bitrate::bps(300_000)))
            // Forwarding awaits a source clock; use video's report cadence for audio too.
            .set_rtcp_report_interval_audio(Duration::from_secs(1))
            .set_stats_interval(Some(Duration::from_millis(500)))
            .set_sctp_max_buffered_amount(2 * 1024 * 1024);
        // Advertise the same H264 subset admitted by media::supported.
        config
            .codec_config()
            .add_h264(108.into(), Some(109.into()), true, 0x42e01f);
        config.codec_config().add_config(
            111.into(),
            None,
            Codec::Opus,
            Frequency::FORTY_EIGHT_KHZ,
            Some(2),
            FormatParams {
                min_p_time: Some(10),
                use_inband_fec: Some(true),
                stereo: Some(true),
                ..Default::default()
            },
        );
        let stats_origin = Instant::now();
        let mut rtc = config.build(stats_origin);
        let requested = *demand.borrow_and_update();
        rtc.bwe().set_bitrate(
            Bitrate::bps(requested.minimum_bps),
            Bitrate::bps(desired_bps(requested.desired_bps)),
        );
        let interfaces = if local_input {
            None
        } else {
            Some(netwatch::interfaces::State::new().await)
        };
        let mut bases = Vec::new();
        for socket in &sockets {
            let local = socket.local_addr()?;
            let candidates = host_candidates(
                local,
                interfaces
                    .iter()
                    .flat_map(|state| state.interfaces.values())
                    .filter(|i| i.is_up())
                    .flat_map(|i| i.addrs())
                    .map(|a| a.addr()),
            )?;
            for candidate in candidates {
                let address = candidate.addr();
                let Some(candidate) = rtc.add_local_candidate(candidate).cloned() else {
                    continue;
                };
                if bases.len() < super::MAX_ICE_CANDIDATES {
                    bases.push(discovery::Base {
                        socket: socket.clone(),
                        local: address,
                    });
                }
                if let EventTarget::Peer(events) = &events {
                    let _ = events.try_send(Event::Candidate(pair, candidate));
                }
            }
        }
        let (bandwidth, rx) = watch::channel(Estimate::Startup(300_000.0));
        let urls = discovery::urls(ice);
        let (turn_ready, turn_setup) = mpsc::channel(super::MAX_ICE_CANDIDATES);
        let engine = Engine {
            stats_origin,
            peer_stats: None,
            ingress_stats: HashMap::new(),
            egress_stats: HashMap::new(),
            rtc,
            handle: handle.clone(),
            sockets,
            discovery: None,
            discovery_routes: HashMap::new(),
            turn: HashMap::new(),
            turn_setup,
            turn_setup_task: None,
            retired_turn: Vec::new(),
            events,
            overflow,
            state,
            channels: HashMap::new(),
            receive_memory: Arc::new(Semaphore::new(RECEIVE_MEMORY)),
            tracks: HashMap::new(),
            clocks: HashMap::new(),
            sender_reports: HashMap::new(),
            outputs: HashMap::new(),
            pending: None,
            local: None,
            remote: false,
            remote_media: HashMap::new(),
            negotiated: false,
            bandwidth,
            demand,
            bandwidth_changed: changed,
            reported: false,
            estimate: 300_000.0,
            deadline: Instant::now(),
        };
        let (done, ready) = oneshot::channel();
        self.tx
            .send(Command::Add(
                pair,
                Box::new(engine),
                (!local_input).then(|| {
                    (
                        discovery::Config::new(bases, &urls),
                        turn::Setup {
                            urls,
                            ready: turn_ready,
                        },
                    )
                }),
                done,
            ))
            .await
            .map_err(|_| anyhow!("transport closed"))?;
        ready.await?;
        Ok((handle, rx))
    }
    pub async fn close(self) {
        let _ = self.tx.send(Command::Stop).await;
        let _ = self.task.await;
    }
}
fn add_reader(
    sockets: &mut Vec<Socket>,
    socket: Arc<UdpIo>,
    owner: Option<(Uuid, Uuid)>,
    network: mpsc::Sender<Datagram>,
) {
    let reader = socket.clone();
    let task = tokio::spawn(async move {
        let mut buffer = vec![0; 65536];
        loop {
            if reader.socket.readable().await.is_err() {
                break;
            }
            let mut meta = [noq_udp::RecvMeta::default()];
            let mut bufs = [std::io::IoSliceMut::new(&mut buffer)];
            match reader.socket.try_io(tokio::io::Interest::READABLE, || {
                reader
                    .state
                    .recv((&reader.socket).into(), &mut bufs, &mut meta)
            }) {
                Ok(_) => {
                    let Ok(local) = reader.local_addr() else {
                        break;
                    };
                    let Some(ip) = meta[0]
                        .dst_ip
                        .or_else(|| (!local.ip().is_unspecified()).then_some(local.ip()))
                    else {
                        continue;
                    };
                    for bytes in buffer[..meta[0].len].chunks(meta[0].stride.max(1)) {
                        let packet = Datagram {
                            socket: Arc::as_ptr(&reader) as usize,
                            owner,
                            source: meta[0].addr,
                            destination: SocketAddr::new(ip, local.port()),
                            at: Instant::now(),
                            bytes: bytes.to_vec(),
                        };
                        if network.send(packet).await.is_err() {
                            return;
                        }
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::Interrupted
                            | std::io::ErrorKind::ConnectionRefused
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(_) => break,
            }
        }
    });
    sockets.push(Socket {
        socket,
        owner,
        task,
    });
}

impl Transport {
    pub(super) async fn connection_metrics(&self) -> Result<TransportMetrics> {
        self.call(|engine| Ok(engine.connection_metrics())).await
    }
    async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Engine) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (done, reply) = oneshot::channel();
        self.tx
            .send(Command::Run(
                self.pair,
                self.instance,
                Box::new(move |e| {
                    let _ = done.send(f(e));
                }),
            ))
            .await
            .map_err(|_| anyhow!("transport closed"))?;
        reply.await.context("transport retired")?
    }
    pub async fn stable(&self) -> bool {
        self.call(|e| Ok(e.negotiated && e.pending.is_none()))
            .await
            .unwrap_or(false)
    }
    pub async fn local_description(&self) -> Result<(String, String)> {
        self.call(|e| e.local.clone().context("no local description"))
            .await
    }
    pub async fn offer(&self) -> Result<bool> {
        self.call(|e| {
            ensure!(!e.events.local(), "local input is receive-only");
            ensure!(e.pending.is_none(), "pending transport offer");
            // Browser addTrack can send on one of our offered media sections.
            // Output retirement/reuse owns only that section's sending half.
            let receiving: HashSet<_> = e
                .outputs
                .values()
                .filter_map(|out| out.mid)
                .filter(|mid| {
                    e.rtc
                        .media(*mid)
                        .is_some_and(|m| m.direction().is_receiving())
                })
                .collect();
            let mut changes = e.rtc.sdp_api();
            for channel in e.channels.values_mut().filter(|c| c.id.is_none()) {
                channel.id = Some(changes.add_channel_with_config(channel.config.clone()));
            }
            for output in e.outputs.values_mut() {
                if let Some(mid) = output.mid {
                    let direction = match (output.retired, receiving.contains(&mid)) {
                        (true, true) => Direction::RecvOnly,
                        (true, false) => Direction::Inactive,
                        (false, true) => Direction::SendRecv,
                        (false, false) => Direction::SendOnly,
                    };
                    changes.set_direction(mid, direction);
                } else if !output.retired {
                    let mut simulcast = str0m::media::Simulcast::new();
                    for rid in &output.rids {
                        if !rid.is_empty() {
                            simulcast.add_send_layer(str0m::media::SimulcastLayer::new(rid));
                        }
                    }
                    output.mid = Some(changes.add_media(
                        output.kind,
                        Direction::SendOnly,
                        Some(output.stream.clone()),
                        None,
                        (!simulcast.send.is_empty()).then_some(simulcast),
                    ));
                    output.since = Instant::now();
                }
            }
            let Some((offer, pending)) = changes.apply() else {
                return Ok(false);
            };
            e.local = Some(("offer".into(), offer.to_sdp_string()));
            e.pending = Some(pending);
            Ok(true)
        })
        .await
    }
    pub async fn accept(&self, kind: String, sdp: String) -> Result<()> {
        self.call(move |e| {
            let parsed = SdpOffer::from_sdp_string(&sdp)?;
            if e.events.local() {
                ensure!(
                    !e.remote && kind == "offer",
                    "local input does not renegotiate"
                );
            }
            let remote_media = parsed
                .media_lines
                .iter()
                .filter(|line| line.direction().is_sending())
                .filter_map(|line| {
                    if e.events.local() {
                        return Some((line.mid(), ("local-input".into(), line.mid().to_string())));
                    }
                    line.msid()
                        .map(|msid| (line.mid(), (msid.stream_id, msid.track_id)))
                })
                .collect::<HashMap<_, _>>();
            if kind == "offer" {
                e.pending = None;
                let answer = e.rtc.sdp_api().accept_offer(parsed)?;
                e.local = Some(("answer".into(), answer.to_sdp_string()));
            } else {
                let pending = e.pending.take().context("answer without pending offer")?;
                e.rtc
                    .sdp_api()
                    .accept_answer(pending, SdpAnswer::from_sdp_string(&sdp)?)?;
            }
            let replaced = e
                .tracks
                .iter()
                .filter(|(mid, t)| {
                    remote_media
                        .get(mid)
                        .is_none_or(|(stream, id)| *stream != t.track.stream || *id != t.track.id)
                })
                .map(|(mid, _)| *mid)
                .collect::<Vec<_>>();
            for mid in replaced {
                if let Some(track) = e.tracks.remove(&mid) {
                    let _ = track.tx.try_send(TrackEvent::End);
                }
                e.sender_reports.retain(|_, (m, _, _)| *m != mid);
            }
            e.clocks
                .retain(|stream, _| remote_media.values().any(|(current, _)| current == stream));
            e.remote_media = remote_media;
            e.prune_stats();
            e.remote = true;
            e.negotiated = true;
            e.outputs.retain(|_, out| {
                !out.retired
                    || out
                        .mid
                        .is_some_and(|mid| e.rtc.media(mid).is_some_and(|m| !m.stopped()))
            });
            for out in e.outputs.values_mut().filter(|out| out.retired) {
                // Direction changes mutate the SDK before the answer arrives.
                // Reuse only after an exchange acknowledges our sender's withdrawal.
                out.reusable = out.mid.is_some_and(|mid| {
                    e.rtc
                        .media(mid)
                        .is_some_and(|media| !media.disabled() && !media.direction().is_sending())
                });
            }
            if e.outputs.values().any(|o| !o.retired && o.mid.is_none())
                || e.channels.values().any(|c| c.id.is_none())
            {
                e.emit(Event::Negotiate(e.handle.pair));
            }
            Ok(())
        })
        .await
    }
    pub async fn rollback(&self) -> Result<()> {
        self.call(|e| {
            e.pending = None;
            for out in e.outputs.values_mut() {
                if out.mid.is_some_and(|mid| e.rtc.media(mid).is_none()) {
                    out.mid = None;
                }
            }
            e.prune_stats();
            Ok(())
        })
        .await
    }
    pub async fn remote_description(&self) -> bool {
        self.call(|e| Ok(e.remote)).await.unwrap_or(false)
    }
    pub(super) async fn add_local_candidate(&self, candidate: Candidate) -> Result<()> {
        self.call(move |e| {
            if let Some(candidate) = e.rtc.add_local_candidate(candidate).cloned() {
                e.emit(Event::Candidate(e.handle.pair, candidate));
            }
            Ok(())
        })
        .await
    }
    pub async fn add_candidate(&self, candidate: String) -> Result<()> {
        self.call(move |e| {
            ensure!(!e.events.local(), "local input does not trickle ICE");
            e.rtc
                .add_remote_candidate(Candidate::from_sdp_string(&candidate)?);
            Ok(())
        })
        .await
    }
    pub async fn create_channel(&self, label: &str) -> Result<Arc<Channel>> {
        let token = Uuid::new_v4();
        let config = ChannelConfig {
            label: label.into(),
            ..Default::default()
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let low = Arc::new(Notify::new());
        let closed = Arc::new(AtomicBool::new(false));
        let channel = Arc::new(Channel {
            transport: self.clone(),
            token,
            label: label.into(),
            config: config.clone(),
            rx: Arc::new(tokio::sync::Mutex::new(rx)),
            low: low.clone(),
            closed: closed.clone(),
        });
        self.call(move |e| {
            ensure!(!e.events.local(), "local input does not use data channels");
            e.channels.insert(
                token,
                ChannelState {
                    id: None,
                    config,
                    tx,
                    low,
                    closed,
                },
            );
            e.emit(Event::Negotiate(e.handle.pair));
            Ok(())
        })
        .await?;
        Ok(channel)
    }
    pub async fn add_output(
        &self,
        id: Uuid,
        codec: RtpCodec,
        kind: MediaKind,
        stream: String,
        rids: Vec<String>,
    ) -> Result<(mpsc::Receiver<String>, Arc<Notify>, String)> {
        self.call(move |e| {
            ensure!(!e.events.local(), "local input is receive-only");
            let (tx, rx) = mpsc::channel(8);
            let writable = Arc::new(Notify::new());
            let companion = e
                .outputs
                .values()
                .any(|out| !out.retired && out.stream == stream);
            // A new flow takes an idle group; its other kind joins the returned
            // stream. MID/MSID/RIDs stay with the negotiated carrier.
            let idle = e.outputs.iter().find_map(|(id, out)| {
                (out.reusable
                    && out.kind == kind
                    && out.rids == rids
                    && (out.stream == stream
                        || !companion
                            && e.outputs
                                .values()
                                .filter(|other| other.stream == out.stream)
                                .all(|other| other.reusable)))
                .then_some(*id)
            });
            let (mid, stream) = if let Some(id) = idle {
                let previous = e.outputs.remove(&id).unwrap();
                (previous.mid, previous.stream)
            } else {
                (None, stream)
            };
            e.outputs.insert(
                id,
                Outgoing {
                    since: Instant::now(),
                    codec,
                    kind,
                    stream: stream.clone(),
                    rids,
                    mid,
                    retired: false,
                    reusable: false,
                    feedback: tx,
                    seq: HashMap::new(),
                    writable: writable.clone(),
                    waiting: HashSet::new(),
                },
            );
            e.emit(Event::Negotiate(e.handle.pair));
            Ok((rx, writable, stream))
        })
        .await
    }
    pub async fn confirm(&self, id: Uuid) -> Result<Option<Option<RtpCodecParameters>>> {
        self.call(move |e| {
            let out = e.outputs.get(&id).context("output retired")?;
            let Some(mid) = out.mid else { return Ok(None) };
            let Some(media) = e.rtc.media(mid) else {
                return Ok(None);
            };
            if !media.direction().is_sending() || media.disabled() {
                return Ok(Some(None));
            }
            Ok(Some(
                e.rtc
                    .codec_config()
                    .params()
                    .iter()
                    .filter(|p| media.remote_pts().contains(&p.pt()))
                    .map(codec)
                    .find(|c| crate::media::compatible(&out.codec, &c.rtp_codec)),
            ))
        })
        .await
    }
    pub async fn retire_output(&self, id: Uuid) -> Result<()> {
        self.call(move |e| {
            if e.outputs.get(&id).is_some_and(|out| out.mid.is_none()) {
                e.outputs.remove(&id);
            } else if let Some(out) = e.outputs.get_mut(&id) {
                out.retired = true;
                if let Some(mid) = out.mid {
                    let mut direct = e.rtc.direct_api();
                    let rids = std::iter::once(None).chain(
                        out.rids
                            .iter()
                            .filter(|rid| !rid.is_empty())
                            .map(|rid| Some(Rid::from(rid.as_str()))),
                    );
                    let streams: Vec<_> = rids
                        .filter_map(|rid| {
                            direct
                                .stream_tx_by_mid(mid, rid)
                                .map(|stream| *stream.ssrc())
                        })
                        .collect();
                    for ssrc in streams {
                        direct.remove_stream_tx(ssrc.into());
                    }
                }
            }
            e.prune_stats();
            e.emit(Event::Negotiate(e.handle.pair));
            Ok(())
        })
        .await
    }
    pub async fn ended_receivers(&self) -> Result<Vec<String>> {
        self.call(|e| {
            Ok(e.tracks
                .values()
                .filter(|t| {
                    e.rtc
                        .media(t.track.mid)
                        .is_none_or(|m| !m.direction().is_receiving() || m.disabled())
                })
                .map(|t| t.track.id.clone())
                .collect())
        })
        .await
    }
    /// One complete access unit is admitted atomically against a freshly drained pacer snapshot.
    pub async fn write_au(
        &self,
        id: Uuid,
        rid: String,
        packets: Vec<rtp::Packet>,
        wallclock: Instant,
    ) -> Result<Option<Vec<rtp::Packet>>> {
        self.call(move |e| {
            e.drain();
            e.rtc.handle_input(Input::Timeout(Instant::now()))?;
            e.drain();
            let connected = e.rtc.is_connected();
            let out = e.outputs.get_mut(&id).context("output retired")?;
            ensure!(!out.retired, "output retired");
            let mid = out.mid.context("output not negotiated")?;
            let media = e.rtc.media(mid).context("missing media")?;
            let pt = e
                .rtc
                .codec_config()
                .params()
                .iter()
                .filter(|p| media.remote_pts().contains(&p.pt()))
                .find(|p| crate::media::compatible(&out.codec, &codec(p).rtp_codec))
                .context("no compatible negotiated codec")?
                .pt();
            let mut direct = e.rtc.direct_api();
            let stream = direct
                .stream_tx_by_mid(mid, (!rid.is_empty()).then(|| Rid::from(rid.as_str())))
                .context("missing RTP writer")?;
            let size: usize = packets.iter().map(|p| p.payload.len() + 64).sum();
            ensure!(
                packets.len() <= 4096 && size <= 4 * 1024 * 1024,
                "access unit exceeds output limit"
            );
            // The representation limit above is not a paced backlog budget.
            // Keep at most one whole AU in this stream's unsent queue.
            if !connected || stream.queue_info().is_none_or(|q| q.packet_count() != 0) {
                out.waiting.insert(rid);
                return Ok(Some(packets));
            }
            for packet in packets {
                let seq = out
                    .seq
                    .entry(rid.clone())
                    .or_insert_with(|| u64::from(packet.header.sequence_number).into());
                let current = *seq;
                *seq = (**seq + 1).into();
                stream.write_rtp(
                    RtpWrite::new(
                        pt,
                        current,
                        packet.header.timestamp,
                        wallclock,
                        packet.payload.to_vec(),
                    )
                    .marker(packet.header.marker)
                    .nackable(out.kind == MediaKind::Video),
                );
            }
            Ok(None)
        })
        .await
    }
    pub async fn close(&self) -> Result<()> {
        let (done, reply) = oneshot::channel();
        self.tx
            .send(Command::Remove(self.pair, self.instance, done))
            .await
            .map_err(|_| anyhow!("pump closed"))?;
        reply.await?;
        Ok(())
    }
}

impl Channel {
    pub async fn poll(&self) -> Option<ChannelEvent> {
        self.rx.lock().await.recv().await.map(|queued| queued.event)
    }
    pub async fn write(
        &self,
        binary: bool,
        bytes: Vec<u8>,
        scope: crate::data::MessageScope,
        input: bool,
    ) -> Result<bool> {
        let token = self.token;
        self.transport
            .call(move |e| {
                if !scope.allowed() {
                    return Ok(true);
                }
                let state = e.channels.get(&token).context("channel retired")?;
                ensure!(!state.closed.load(Ordering::Acquire), "channel closed");
                let mut channel = e
                    .rtc
                    .channel(state.id.context("channel not negotiated")?)
                    .context("channel not open")?;
                if input {
                    ensure!(
                        channel.buffered_amount() + bytes.len() <= 8192,
                        "input_channel_busy"
                    );
                }
                Ok(channel.write(binary, &bytes)?)
            })
            .await
    }
    pub async fn close(&self) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        let token = self.token;
        let result = self
            .transport
            .call(move |e| {
                if let Some(c) = e.channels.remove(&token) {
                    if let Some(id) = c.id {
                        e.rtc.direct_api().close_data_channel(id);
                    }
                }
                Ok(())
            })
            .await;
        // Sender removal wakes poll(), which may hold this mutex while waiting.
        // Closed DataLink bindings can retain this handle, so explicitly reclaim
        // the queued vectors/permits even when the transport has already retired.
        let mut receiver = self.rx.lock().await;
        receiver.close();
        while receiver.try_recv().is_ok() {}
        result
    }
}
impl Track {
    pub async fn poll(&self) -> Option<TrackEvent> {
        self.packets.lock().await.recv().await
    }
    pub fn rid(&self, ssrc: u32) -> Option<String> {
        self.encodings
            .lock()
            .unwrap()
            .get(&ssrc)
            .map(|(rid, _)| rid.clone())
    }
    pub fn report(&self, ssrc: u32) -> crate::media::SourceReport {
        Arc::new(Mutex::new(self.reports.lock().unwrap().get(&ssrc).cloned()))
    }
    pub fn presentation(&self, timestamp: u32, ssrc: u32) -> Option<Instant> {
        let reports = self.reports.lock().unwrap();
        let (sr, at) = reports.get(&ssrc)?;
        Some(advance(
            *at,
            timestamp.wrapping_sub(sr.rtp_time) as i32 as i64,
            self.first_codec.rtp_codec.clock_rate,
        ))
    }
    pub async fn request_keyframe(&self, ssrc: u32) -> Result<()> {
        self.transport
            .call(move |e| {
                e.rtc.direct_api().send_pli_feedback(0.into(), ssrc.into());
                Ok(())
            })
            .await
    }
}
fn advance(at: Instant, ticks: i64, rate: u32) -> Instant {
    let d = Duration::from_nanos(ticks.unsigned_abs() * 1_000_000_000 / u64::from(rate));
    if ticks >= 0 {
        at + d
    } else {
        at - d
    }
}
fn ntp(time: SystemTime) -> u64 {
    let d =
        time.duration_since(UNIX_EPOCH).unwrap_or_default() + Duration::from_secs(2_208_988_800);
    (d.as_secs() << 32) | ((u64::from(d.subsec_nanos()) << 32) / 1_000_000_000)
}
fn codec(params: &PayloadParams) -> RtpCodecParameters {
    let spec = params.spec();
    let mime = match spec.codec {
        Codec::Opus => "audio/opus",
        Codec::Vp8 => "video/VP8",
        Codec::H264 => "video/H264",
        _ => "unsupported",
    };
    let fmtp = if spec.codec == Codec::H264 {
        format!(
            "level-asymmetry-allowed=1;packetization-mode={};profile-level-id={:06x}",
            spec.format.packetization_mode.unwrap_or(0),
            spec.format.profile_level_id.unwrap_or(0)
        )
    } else {
        String::new()
    };
    RtpCodecParameters {
        rtp_codec: RtpCodec {
            mime_type: mime.into(),
            clock_rate: if spec.codec == Codec::Opus {
                48000
            } else {
                90000
            },
            channels: spec.channels.unwrap_or(0) as u16,
            sdp_fmtp_line: fmtp,
        },
        payload_type: *params.pt(),
    }
}

impl Engine {
    async fn close(&mut self) {
        if let Some(task) = self.discovery.take() {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = self.turn_setup_task.take() {
            task.abort();
            let _ = task.await;
        }
        self.turn_setup.close();
        while self.turn_setup.try_recv().is_ok() {}
        self.close_turn();
        self.discovery_routes.clear();
        self.rtc.disconnect();
        self.drain();
        self.tracks.clear();
        if let EventTarget::Local { ended, .. } = &self.events {
            let unfinished = ended.borrow().is_none();
            if unfinished {
                ended.send_replace(Some(Ok(())));
            }
        }
    }

    fn receive(
        &mut self,
        at: Instant,
        source: SocketAddr,
        destination: SocketAddr,
        bytes: &[u8],
    ) -> bool {
        if self.events.local()
            && (source.ip() != std::net::Ipv4Addr::LOCALHOST
                || destination.ip() != std::net::Ipv4Addr::LOCALHOST)
        {
            return false;
        }
        let Ok(contents) = bytes.try_into() else {
            return false;
        };
        let input = Input::Receive(
            at,
            Receive {
                proto: Protocol::Udp,
                source,
                destination,
                contents,
            },
        );
        if !self.rtc.accepts(&input) {
            return false;
        }
        if let Err(error) = self.rtc.handle_input(input) {
            eprintln!("Native str0m input: {error}");
        }
        true
    }
    fn close_turn(&mut self) {
        for endpoint in self.turn.values_mut() {
            endpoint.close();
        }
        self.turn.clear();
    }
    fn drain_turn(&mut self) {
        let keys: Vec<_> = self.turn.keys().copied().collect();
        for key in keys {
            let mut failed = false;
            while let Some(change) = self.turn.get_mut(&key).and_then(|endpoint| endpoint.poll()) {
                match change {
                    turn::Change::Ready(candidate) => {
                        if let Some(candidate) = self.rtc.add_local_candidate(candidate).cloned() {
                            self.emit(Event::Candidate(self.handle.pair, candidate));
                        }
                    }
                    turn::Change::Receive(source, destination, bytes, at) => {
                        self.receive(at, source, destination, &bytes);
                    }
                    turn::Change::Failed => {
                        failed = true;
                        break;
                    }
                }
            }
            if !failed {
                failed = self
                    .turn
                    .get_mut(&key)
                    .is_some_and(|endpoint| endpoint.flush().is_err());
            }
            if failed {
                if let Some(mut endpoint) = self.turn.remove(&key) {
                    if let Some(relay) = endpoint.relay {
                        if let Ok(candidate) = Candidate::relayed(relay, endpoint.local(), "udp") {
                            self.rtc.direct_api().invalidate_candidate(&candidate);
                        }
                    }
                    endpoint.close();
                }
                self.retired_turn.push(key);
            }
        }
    }
    fn emit(&self, event: Event) {
        match &self.events {
            EventTarget::Peer(events) => {
                if events.try_send(event).is_err() {
                    self.overflow.store(true, Ordering::Release);
                }
            }
            EventTarget::Local { tracks, ended } => match event {
                Event::Track(_, track) => {
                    if tracks.try_send(track).is_err() {
                        ended.send_replace(Some(Err("local_input_track_unavailable".into())));
                    }
                }
                Event::State(_, PeerState::Failed) => {
                    ended.send_replace(Some(Err("local_input_failed".into())));
                }
                Event::State(_, PeerState::Closed) => {
                    let unfinished = ended.borrow().is_none();
                    if unfinished {
                        ended.send_replace(Some(Ok(())));
                    }
                }
                _ => {}
            },
        }
    }
    fn drain(&mut self) {
        self.drain_turn();
        if self.demand.has_changed().unwrap_or(false) {
            let demand = *self.demand.borrow_and_update();
            self.rtc.bwe().set_bitrate(
                Bitrate::bps(demand.minimum_bps),
                Bitrate::bps(desired_bps(demand.desired_bps)),
            );
        }
        loop {
            match self.rtc.poll_output() {
                Ok(Output::Timeout(at)) => {
                    self.deadline = at;
                    self.drain_turn();
                    for endpoint in self.turn.values_mut() {
                        if let Some(at) = endpoint.deadline() {
                            self.deadline = self.deadline.min(at);
                        }
                    }
                    let connected = self.rtc.is_connected();
                    for out in self.outputs.values_mut() {
                        let before = out.waiting.len();
                        out.waiting.retain(|rid| {
                            out.mid.is_some_and(|mid| {
                                self.rtc
                                    .direct_api()
                                    .stream_tx_by_mid(
                                        mid,
                                        (!rid.is_empty()).then(|| Rid::from(rid.as_str())),
                                    )
                                    .is_some_and(|stream| {
                                        !connected
                                            || stream
                                                .queue_info()
                                                .is_none_or(|queue| queue.packet_count() != 0)
                                    })
                            })
                        });
                        if out.waiting.len() != before {
                            out.writable.notify_waiters();
                        }
                    }
                    break;
                }
                Ok(Output::Transmit(packet)) => {
                    if self.events.local()
                        && packet.destination.ip() != std::net::Ipv4Addr::LOCALHOST
                    {
                        continue;
                    }
                    let available = super::MAX_ICE_CANDIDATES.saturating_sub(
                        self.turn
                            .values()
                            .map(|endpoint| endpoint.pending_units())
                            .sum(),
                    );
                    if let Some(endpoint) = self
                        .turn
                        .values_mut()
                        .find(|endpoint| endpoint.relay == Some(packet.source))
                    {
                        if let Err(error) =
                            endpoint.send(packet.destination, packet.contents.to_vec(), available)
                        {
                            eprintln!("Native TURN output: {error}");
                        }
                        continue;
                    }
                    if let Some(socket) = self.sockets.iter().find(|s| {
                        s.local_addr().is_ok_and(|a| {
                            a.port() == packet.source.port()
                                && a.is_ipv4() == packet.source.is_ipv4()
                        })
                    }) {
                        if let Err(error) = socket.state.try_send(
                            (&socket.socket).into(),
                            &noq_udp::Transmit {
                                destination: packet.destination,
                                ecn: None,
                                contents: &packet.contents,
                                segment_size: None,
                                src_ip: Some(packet.source.ip()),
                            },
                        ) {
                            if error.kind() != std::io::ErrorKind::WouldBlock {
                                eprintln!("Native str0m UDP send: {error}");
                            }
                        }
                    }
                }
                Ok(Output::Event(event)) => self.event(event),
                Err(error) => {
                    eprintln!("Native str0m output: {error}");
                    self.state.store(PeerState::Failed as u8, Ordering::Release);
                    self.emit(Event::State(self.handle.pair, PeerState::Failed));
                    self.deadline = Instant::now() + Duration::from_secs(3600);
                    break;
                }
            }
        }
    }
    fn event(&mut self, event: RtcEvent) {
        match event {
            RtcEvent::IceConnectionStateChange(state) => {
                if state.is_disconnected() {
                    // str0m has exhausted its current candidate pairs and has no
                    // later Failed state. Reuse the owned pair replacement.
                    self.state.store(PeerState::Failed as u8, Ordering::Release);
                    self.emit(Event::State(self.handle.pair, PeerState::Failed));
                } else if state.is_connected() && self.rtc.is_connected() {
                    self.state
                        .store(PeerState::Connected as u8, Ordering::Release);
                    self.emit(Event::State(self.handle.pair, PeerState::Connected));
                }
            }
            RtcEvent::Connected => {
                self.state
                    .store(PeerState::Connected as u8, Ordering::Release);
                self.emit(Event::State(self.handle.pair, PeerState::Connected));
            }
            RtcEvent::Closed => {
                self.state.store(PeerState::Closed as u8, Ordering::Release);
                self.emit(Event::State(self.handle.pair, PeerState::Closed));
            }
            RtcEvent::ChannelOpen(id, label) => {
                let config = self
                    .rtc
                    .channel(id)
                    .and_then(|c| c.config().cloned())
                    .unwrap_or_default();
                if !config.ordered || config.reliability != Reliability::Reliable {
                    self.rtc.direct_api().close_data_channel(id);
                    return;
                }
                if let Some(channel) = self.channels.values().find(|c| c.id == Some(id)) {
                    let _ = channel.push(ChannelEvent::Open, &self.receive_memory);
                } else {
                    let token = Uuid::new_v4();
                    let (tx, rx) = mpsc::unbounded_channel();
                    let low = Arc::new(Notify::new());
                    let closed = Arc::new(AtomicBool::new(false));
                    let state = ChannelState {
                        id: Some(id),
                        config: config.clone(),
                        tx,
                        low: low.clone(),
                        closed: closed.clone(),
                    };
                    let _ = state.push(ChannelEvent::Open, &self.receive_memory);
                    self.channels.insert(token, state);
                    self.emit(Event::Channel(
                        self.handle.pair,
                        Arc::new(Channel {
                            transport: self.handle.clone(),
                            token,
                            label,
                            config,
                            rx: Arc::new(tokio::sync::Mutex::new(rx)),
                            low,
                            closed,
                        }),
                    ));
                }
                if let Some(mut channel) = self.rtc.channel(id) {
                    channel.set_buffered_amount_low_threshold(0);
                }
            }
            RtcEvent::ChannelData(data) => {
                if let Some(channel) = self.channels.values().find(|c| c.id == Some(data.id)) {
                    if channel
                        .push(ChannelEvent::Message(data.data), &self.receive_memory)
                        .is_err()
                    {
                        self.overflow.store(true, Ordering::Release);
                    }
                }
            }
            RtcEvent::ChannelClose(id) => {
                if let Some(c) = self.channels.values().find(|c| c.id == Some(id)) {
                    c.closed.store(true, Ordering::Release);
                    c.low.notify_waiters();
                    let _ = c.push(ChannelEvent::Close, &self.receive_memory);
                }
            }
            RtcEvent::ChannelBufferedAmountLow(_) => {
                for c in self.channels.values() {
                    c.low.notify_waiters();
                }
            }
            RtcEvent::PeerStats(stats) => {
                self.peer_stats = Some(stats.clone());
                if stats.egress_loss_fraction.is_some() {
                    self.reported = true;
                }
                if let Some(bps) = stats.bwe_tx {
                    self.estimate = bps.as_f64();
                }
                self.publish_estimate();
            }
            RtcEvent::MediaIngressStats(stats) => {
                if self.active_ingress(&stats) {
                    self.ingress_stats.insert((stats.mid, stats.rid), stats);
                }
            }
            RtcEvent::MediaEgressStats(stats) => {
                if self.active_egress(&stats) {
                    self.egress_stats.insert((stats.mid, stats.rid), stats);
                }
            }
            RtcEvent::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                self.estimate = estimate.as_f64();
                self.publish_estimate();
            }
            RtcEvent::KeyframeRequest(request) => {
                // None identifies the ordinary, unnamed encoding, not all RIDs.
                let rid = request.rid.map(|rid| rid.to_string()).unwrap_or_default();
                for out in self.outputs.values().filter(|out| {
                    !out.retired && out.mid == Some(request.mid) && out.rids.contains(&rid)
                }) {
                    let _ = out.feedback.try_send(rid.clone());
                }
            }
            RtcEvent::SenderFeedback(feedback) => {
                let info = feedback.sender_info;
                let ssrc = *info.ssrc;
                // A pre-media SR has no RTP/capture correlation yet. Treating its
                // zero RTP origin as the source clock can put the first AU far
                // in the future. A later counter wrap retains its existing SR.
                if info.sender_packet_count == 0 && !self.sender_reports.contains_key(&ssrc) {
                    return;
                }
                let Some((stream, _)) = self.remote_media.get(&feedback.mid) else {
                    return;
                };
                let stream = stream.clone();
                let shared = self.clocks.entry(stream.clone()).or_default().clone();
                let mut anchor = shared.lock().unwrap();
                let (remote, local) = *anchor.get_or_insert((info.ntp_time, feedback.received_at));
                let at = match info.ntp_time.duration_since(remote) {
                    Ok(delta) => local + delta,
                    Err(error) => local - error.duration(),
                };
                drop(anchor);
                let sr = SourceClockReport {
                    ssrc,
                    ntp_time: ntp(info.ntp_time),
                    rtp_time: info.rtp_time.numer() as u32,
                };
                self.sender_reports
                    .insert(ssrc, (feedback.mid, sr.clone(), at));
                if let Some(track) = self.tracks.get(&feedback.mid) {
                    track
                        .track
                        .reports
                        .lock()
                        .unwrap()
                        .insert(ssrc, (sr.clone(), at));
                    let _ = track.tx.try_send(TrackEvent::Report(vec![(sr, at)]));
                }
            }
            RtcEvent::RtpPacket(packet) => {
                let ssrc = packet.header.ssrc;
                let Some((mid, rid)) = self
                    .rtc
                    .direct_api()
                    .stream_rx(&ssrc)
                    .map(|s| (s.mid(), s.rid()))
                else {
                    return;
                };
                let Some(media) = self.rtc.media(mid) else {
                    return;
                };
                let Some((stream, track_id)) = self.remote_media.get(&mid).cloned() else {
                    return;
                };
                let kind = media.kind();
                let rids = match media.rids_rx() {
                    Rids::Specific(rids) => rids.iter().map(ToString::to_string).collect(),
                    _ => vec![],
                };
                let Some(params) = self
                    .rtc
                    .codec_config()
                    .params()
                    .iter()
                    .find(|p| p.pt() == packet.header.payload_type)
                else {
                    return;
                };
                let params = codec(params);
                let ssrc = *ssrc;
                let rid = rid.map(|r| r.to_string()).unwrap_or_default();
                if !self.tracks.contains_key(&mid) {
                    // Padding can precede the first encoded frame under another
                    // negotiated PT. It does not establish a track's media format.
                    if packet.payload.is_empty() {
                        return;
                    }
                    let (tx, rx) = mpsc::channel(4096);
                    self.clocks.entry(stream.clone()).or_default();
                    let track = Track {
                        transport: self.handle.clone(),
                        mid,
                        stream,
                        id: track_id,
                        kind,
                        rids,
                        first_ssrc: ssrc,
                        first_codec: params.clone(),
                        packets: Arc::new(tokio::sync::Mutex::new(rx)),
                        encodings: Default::default(),
                        reports: Arc::new(Mutex::new(
                            self.sender_reports
                                .iter()
                                .filter(|(_, (m, _, _))| *m == mid)
                                .map(|(ssrc, (_, sr, at))| (*ssrc, (sr.clone(), *at)))
                                .collect(),
                        )),
                    };
                    self.tracks.insert(
                        mid,
                        TrackState {
                            since: Instant::now(),
                            track: track.clone(),
                            tx,
                        },
                    );
                    self.emit(Event::Track(self.handle.pair, track));
                }
                let track = self.tracks.get(&mid).unwrap();
                if self.events.local() && track.track.first_ssrc != ssrc {
                    return;
                }
                if !packet.payload.is_empty() {
                    track
                        .track
                        .encodings
                        .lock()
                        .unwrap()
                        .insert(ssrc, (rid, params.clone()));
                }
                let sequence = *packet.seq_no;
                let time = packet.time.numer();
                let packet = rtp::Packet {
                    header: rtp::header::Header {
                        version: 2,
                        padding: packet.header.has_padding,
                        marker: packet.header.marker,
                        payload_type: *packet.header.payload_type,
                        sequence_number: packet.header.sequence_number,
                        timestamp: packet.header.timestamp,
                        ssrc,
                        ..Default::default()
                    },
                    payload: packet.payload.to_vec().into(),
                };
                let _ =
                    track
                        .tx
                        .try_send(TrackEvent::Rtp(packet, sequence, time, params.rtp_codec));
            }
            RtcEvent::MediaChanged(change) => {
                if !change.direction.is_receiving() {
                    if let Some(track) = self.tracks.remove(&change.mid) {
                        let _ = track.tx.try_send(TrackEvent::End);
                    }
                    self.sender_reports
                        .retain(|_, (mid, _, _)| *mid != change.mid);
                }
                self.prune_stats();
            }
            _ => {}
        }
    }
    fn active_ingress(&self, stats: &MediaIngressStats) -> bool {
        self.tracks.get(&stats.mid).is_some_and(|owner| {
            stats.timestamp >= owner.since
                && match stats.rid {
                    None => owner.track.rids.is_empty(),
                    Some(rid) => {
                        owner.track.rids.contains(&rid.to_string())
                            || owner
                                .track
                                .encodings
                                .lock()
                                .unwrap()
                                .values()
                                .any(|(known, _)| *known == rid.to_string())
                    }
                }
        })
    }
    fn active_egress(&self, stats: &MediaEgressStats) -> bool {
        self.outputs.values().any(|owner| {
            !owner.retired
                && owner.mid == Some(stats.mid)
                && stats.timestamp >= owner.since
                && match stats.rid {
                    None => owner.rids.iter().all(String::is_empty),
                    Some(rid) => owner.rids.contains(&rid.to_string()),
                }
        })
    }
    fn prune_stats(&mut self) {
        let ingress: Vec<_> = self
            .ingress_stats
            .iter()
            .filter_map(|(key, stats)| (!self.active_ingress(stats)).then_some(*key))
            .collect();
        let egress: Vec<_> = self
            .egress_stats
            .iter()
            .filter_map(|(key, stats)| (!self.active_egress(stats)).then_some(*key))
            .collect();
        for key in ingress {
            self.ingress_stats.remove(&key);
        }
        for key in egress {
            self.egress_stats.remove(&key);
        }
    }
    fn connection_metrics(&self) -> TransportMetrics {
        let now = Instant::now();
        let time = |at: Instant| {
            at.saturating_duration_since(self.stats_origin)
                .as_secs_f64()
                * 1000.0
        };
        let age = |at: Instant| now.saturating_duration_since(at).as_secs_f64() * 1000.0;
        let mut streams = Vec::new();
        for stats in self
            .ingress_stats
            .values()
            .filter(|stats| self.active_ingress(stats))
        {
            let track = &self.tracks[&stats.mid].track;
            let codec = track
                .encodings
                .lock()
                .unwrap()
                .values()
                .find(|(rid, _)| *rid == stats.rid.map(|rid| rid.to_string()).unwrap_or_default())
                .map(|(_, params)| params.rtp_codec.clone());
            streams.push(TransportStreamMetric {
                stream: track.stream.clone(),
                outgoing: false,
                media: track.kind,
                counters: StreamCounters {
                    output_id: None,
                    mid: stats.mid.to_string(),
                    rid: stats.rid.map(|rid| rid.to_string()),
                    codec: codec.as_ref().map(|codec| codec.mime_type.clone()),
                    sample_timestamp_ms: time(stats.timestamp),
                    age_ms: age(stats.timestamp),
                    bytes: stats.bytes,
                    packets: stats.packets,
                    rtt_ms: stats.rtt.map(|rtt| rtt.as_secs_f64() * 1000.0),
                    loss_fraction: stats.loss,
                    jitter_ms: codec.filter(|codec| codec.clock_rate > 0).map(|codec| {
                        f64::from(stats.jitter) * 1000.0 / f64::from(codec.clock_rate)
                    }),
                },
            });
        }
        for stats in self
            .egress_stats
            .values()
            .filter(|stats| self.active_egress(stats))
        {
            let (id, output) = self
                .outputs
                .iter()
                .find(|(_, output)| !output.retired && output.mid == Some(stats.mid))
                .unwrap();
            streams.push(TransportStreamMetric {
                stream: output.stream.clone(),
                outgoing: true,
                media: output.kind,
                counters: StreamCounters {
                    output_id: Some(*id),
                    mid: stats.mid.to_string(),
                    rid: stats.rid.map(|rid| rid.to_string()),
                    codec: Some(output.codec.mime_type.clone()),
                    sample_timestamp_ms: time(stats.timestamp),
                    age_ms: age(stats.timestamp),
                    bytes: stats.bytes,
                    packets: stats.packets,
                    rtt_ms: stats.rtt.map(|rtt| rtt.as_secs_f64() * 1000.0),
                    loss_fraction: stats.loss,
                    jitter_ms: stats
                        .remote
                        .as_ref()
                        .filter(|_| output.codec.clock_rate > 0)
                        .map(|remote| {
                            f64::from(remote.jitter) * 1000.0 / f64::from(output.codec.clock_rate)
                        }),
                },
            });
        }
        TransportMetrics {
            connection_id: self.handle.instance,
            sample_timestamp_ms: self.peer_stats.as_ref().map(|stats| time(stats.timestamp)),
            age_ms: self.peer_stats.as_ref().map(|stats| age(stats.timestamp)),
            rtt_ms: self
                .peer_stats
                .as_ref()
                .and_then(|stats| stats.rtt)
                .map(|rtt| rtt.as_secs_f64() * 1000.0),
            bwe_bps: self.bandwidth.borrow().feedback(),
            streams,
        }
    }
    fn publish_estimate(&mut self) {
        let estimate = if self.reported {
            Estimate::Feedback(self.estimate)
        } else {
            Estimate::Startup(self.estimate)
        };
        if self.bandwidth.send_if_modified(|v| {
            if *v == estimate {
                false
            } else {
                *v = estimate;
                true
            }
        }) {
            self.bandwidth_changed.notify_one();
        }
    }
}
