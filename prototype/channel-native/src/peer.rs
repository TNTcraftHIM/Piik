//! Native transport for authorized adjacent pairs. The domain supplies all leases.
use crate::{
    file::{FileLink, Files, Lane},
    media::{Output, Relay, Source},
};
use anyhow::{anyhow, Result};
use piik_channel_prototype::file_room::FilePlan;
use piik_channel_prototype::wire::{
    Candidate, Command, Description, LinkState, PairInfo, PublicationInfo, Signal,
    Track as WireTrack,
};
use rtc::{
    interceptor::{Gcc, PacerBuilder, Registry, Slot},
    peer_connection::{
        configuration::{
            interceptor_registry::{
                configure_congestion_control, register_default_interceptors, CongestionFeedback,
            },
            media_engine::{MediaEngine, MIME_TYPE_OPUS},
            setting_engine::{SctpMaxMessageSize, SettingEngineBuilder},
        },
        sdp::RTCSessionDescription,
    },
    rtp,
    rtp_transceiver::rtp_sender::{RTCRtpCodec, RTCRtpCodecParameters, RtpCodecKind},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent},
    media_stream::track_remote::{TrackRemote, TrackRemoteEvent},
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
        RTCIceServer, RTCPeerConnectionIceEvent, RTCPeerConnectionState,
    },
};

pub struct NativePeers {
    cancel: watch::Sender<bool>,
    input: mpsc::Sender<Input>,
    task: JoinHandle<()>,
}
enum Input {
    Update(
        Vec<PairInfo>,
        Vec<PublicationInfo>,
        Vec<FilePlan>,
        oneshot::Sender<Result<()>>,
    ),
    Signal(Uuid, Signal, oneshot::Sender<Result<()>>),
    Resync(oneshot::Sender<Result<()>>),
}
enum Event {
    Negotiate(Uuid),
    Candidate(Uuid, Candidate),
    State(Uuid, RTCPeerConnectionState),
    Track(Uuid, Arc<dyn TrackRemote>),
    Channel(Uuid, Arc<dyn DataChannel>),
    Dc(Uuid, Uuid, bool),
    Bulk(Uuid, Uuid),
}
struct Audio {
    publication: Uuid,
    source: Source,
    packet: rtp::Packet,
}
struct Handler {
    pair: Uuid,
    events: mpsc::Sender<Event>,
    overflow: Arc<AtomicBool>,
    state: Arc<AtomicU8>,
}
impl Handler {
    fn emit(&self, event: Event) {
        if self.events.try_send(event).is_err() {
            self.overflow.store(true, Ordering::Release);
        }
    }
}
#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_negotiation_needed(&self) {
        self.emit(Event::Negotiate(self.pair));
    }
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(c) = event.candidate.to_json() {
            self.emit(Event::Candidate(
                self.pair,
                Candidate {
                    candidate: Some(c.candidate),
                    sdp_mid: c.sdp_mid,
                    sdp_m_line_index: c.sdp_mline_index,
                    username_fragment: c.username_fragment,
                },
            ));
        }
    }
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        self.state.store(state as u8, Ordering::Release);
        self.emit(Event::State(self.pair, state));
    }
    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        self.emit(Event::Track(self.pair, track));
    }
    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        self.emit(Event::Channel(self.pair, dc));
    }
}
struct Pair {
    plan: PairInfo,
    pc: Arc<dyn PeerConnection>,
    polite: bool,
    pending_offer: Option<Signal>,
    answer: Option<Signal>,
    negotiate: bool,
    ignore_offer: bool,
    candidates: Vec<Candidate>,
    remote: HashMap<String, Uuid>,
    latest: HashMap<Uuid, Uuid>,
    outputs: HashMap<Uuid, Output>,
    tasks: HashMap<Uuid, JoinHandle<()>>,
    dc: Option<(Uuid, Arc<dyn DataChannel>, JoinHandle<()>)>,
    bulk: Option<(Uuid, Arc<dyn DataChannel>, JoinHandle<()>)>,
    files: FileLink,
    state: Arc<AtomicU8>,
    dc_open: bool,
    base_failed: bool,
    reported: HashSet<String>,
    deadline: Option<Instant>,
    overflow: Arc<AtomicBool>,
}
impl Pair {
    fn connected(&self) -> bool {
        self.state.load(Ordering::Acquire) == RTCPeerConnectionState::Connected as u8
    }
}
struct Driver {
    session: Uuid,
    ice: Vec<RTCIceServer>,
    commands: mpsc::Sender<Command>,
    cancel: watch::Receiver<bool>,
    events: mpsc::Sender<Event>,
    audio: mpsc::Sender<Audio>,
    pairs: HashMap<Uuid, Pair>,
    publications: HashSet<Uuid>,
    sources: HashMap<Uuid, Source>,
    relay: Relay,
    files: Files,
}
impl NativePeers {
    pub fn new(
        session_id: Uuid,
        ice_servers: Vec<RTCIceServer>,
        commands: mpsc::Sender<Command>,
    ) -> Self {
        // Callback events are control-only. They must never await the PC driver that
        // invokes them. RTP has a separate bounded queue and separate poll tasks.
        let (cancel, mut cancelled) = watch::channel(false);
        let (input, mut inputs) = mpsc::channel(64);
        let (events, mut event_rx) = mpsc::channel(1024);
        let (audio, mut audio_rx) = mpsc::channel(256);
        let task = tokio::spawn(async move {
            let mut d = Driver {
                session: session_id,
                ice: ice_servers,
                commands,
                cancel: cancelled.clone(),
                events,
                audio,
                pairs: HashMap::new(),
                publications: HashSet::new(),
                sources: HashMap::new(),
                relay: Relay::default(),
                files: Files::new(session_id),
            };
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            enum Turn {
                Input(Input),
                Event(Event),
                FirstPacket(Audio),
                Tick,
            }
            loop {
                let turn = tokio::select! {
                    _=cancelled.changed()=>break,
                    request=inputs.recv()=>match request {Some(request)=>Turn::Input(request),None=>break},
                    Some(event)=event_rx.recv()=>Turn::Event(event),
                    Some(packet)=audio_rx.recv()=>Turn::FirstPacket(packet),
                    _=tick.tick()=>Turn::Tick,
                };
                let work = async {
                    match turn {
                        Turn::Input(Input::Update(plans, info, files, done)) => {
                            let result = d.update(plans, info, files).await;
                            let _ = done.send(result);
                        }
                        Turn::Input(Input::Resync(done)) => {
                            d.resync().await;
                            let _ = done.send(Ok(()));
                        }
                        Turn::Input(Input::Signal(id, signal, done)) => {
                            if let Err(error) = d.signal(id, signal).await {
                                eprintln!("Native pair signaling failed: {error}");
                                d.fail(id).await;
                            }
                            let _ = done.send(Ok(()));
                        }
                        Turn::Event(event) => {
                            let id = match &event {
                                Event::Negotiate(id)
                                | Event::Candidate(id, _)
                                | Event::State(id, _)
                                | Event::Track(id, _)
                                | Event::Channel(id, _)
                                | Event::Dc(id, _, _)
                                | Event::Bulk(id, _) => *id,
                            };
                            if let Err(error) = d.event(event).await {
                                eprintln!("Native pair event failed: {error}");
                                d.fail(id).await;
                            }
                        }
                        Turn::FirstPacket(packet) => {
                            if let Err(error) = d.packet(packet).await {
                                eprintln!("Native audio attach failed: {error}");
                            }
                        }
                        Turn::Tick => d.deadlines().await,
                    }
                };
                tokio::select! {_=cancelled.changed()=>break,_=work=>{}}
            }
            for (_, pair) in d.pairs.drain() {
                close_pair(pair).await;
            }
            d.files.close().await;
        });
        Self {
            cancel,
            input,
            task,
        }
    }
    pub async fn update(
        &self,
        pairs: Vec<PairInfo>,
        publications: Vec<PublicationInfo>,
        files: Vec<FilePlan>,
    ) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.input
            .send(Input::Update(pairs, publications, files, tx))
            .await?;
        rx.await?
    }
    pub async fn signal(&self, pair_id: Uuid, payload: Signal) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.input.send(Input::Signal(pair_id, payload, tx)).await?;
        rx.await?
    }
    pub async fn resync(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.input.send(Input::Resync(tx)).await?;
        rx.await?
    }
    pub async fn close(self) -> Result<()> {
        let _ = self.cancel.send(true);
        self.task.await?;
        Ok(())
    }
}
fn codec() -> RTCRtpCodec {
    RTCRtpCodec {
        mime_type: MIME_TYPE_OPUS.into(),
        clock_rate: 48000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
        rtcp_feedback: vec![],
    }
}
fn builder(polite: bool) -> Result<PeerConnectionBuilder<String>> {
    let mut media = MediaEngine::default();
    media.register_codec(
        RTCRtpCodecParameters {
            rtp_codec: codec(),
            payload_type: 111,
            ..Default::default()
        },
        RtpCodecKind::Audio,
    )?;
    let registry = register_default_interceptors(Registry::new(), &mut media)?;
    let registry = configure_congestion_control(
        registry,
        Gcc::new(300_000.0, 100_000.0, 100_000_000.0),
        CongestionFeedback::Twcc,
        &mut media,
    )?
    .with(
        Slot::Pacer,
        PacerBuilder::new()
            .with_target_bitrate(300_000.0)
            .with_queue_limit(256)
            .build(),
    );
    Ok(PeerConnectionBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_data_channel_send_buffer_limit(2 * 1024 * 1024)
        .with_setting_engine(
            SettingEngineBuilder::new()
                // Keep the role established by the initial DC offer/answer.
                .with_answering_dtls_role(if polite {
                    rtc::peer_connection::transport::RTCDtlsRole::Client
                } else {
                    rtc::peer_connection::transport::RTCDtlsRole::Server
                })
                .with_sctp_max_message_size(SctpMaxMessageSize::Bounded(
                    piik_channel_prototype::file_delivery::FILE_FRAME_BYTES as u32,
                ))
                .build(),
        ))
}
impl Driver {
    async fn send(&self, command: Command) {
        if *self.cancel.borrow() {
            return;
        }
        let mut cancel = self.cancel.clone();
        tokio::select! { _=cancel.changed()=>{}, _=self.commands.send(command)=>{} }
    }
    async fn update(
        &mut self,
        plans: Vec<PairInfo>,
        publications: Vec<PublicationInfo>,
        files: Vec<FilePlan>,
    ) -> Result<()> {
        self.files.update(files, &plans).await;
        self.publications = publications
            .into_iter()
            .filter(|p| p.kind == piik_channel_prototype::wire::Kind::Voice)
            .map(|p| p.id)
            .collect();
        let needed: HashSet<_> = plans
            .iter()
            .flat_map(|plan| plan.incoming.iter().copied())
            .collect();
        self.sources
            .retain(|id, _| self.publications.contains(id) && needed.contains(id));
        self.relay.retain(&self.sources.keys().copied().collect());
        let retained: HashSet<_> = plans.iter().map(|p| p.id).collect();
        let removed: Vec<_> = self
            .pairs
            .keys()
            .filter(|id| !retained.contains(id))
            .copied()
            .collect();
        for id in removed {
            if let Some(pair) = self.pairs.remove(&id) {
                self.files.detach(pair.plan.peer_id).await;
                close_pair(pair).await;
            }
        }
        for plan in plans {
            let id = plan.id;
            let result = async {
                if !self.pairs.contains_key(&plan.id) {
                    let overflow = Arc::new(AtomicBool::new(false));
                    let state = Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8));
                    let pc: Arc<dyn PeerConnection> = Arc::new(
                        builder(self.session > plan.peer_id)?
                            .with_handler(Arc::new(Handler {
                                pair: plan.id,
                                events: self.events.clone(),
                                overflow: overflow.clone(),
                                state: state.clone(),
                            }))
                            .with_configuration(
                                RTCConfigurationBuilder::new()
                                    .with_ice_servers(self.ice.clone())
                                    .build(),
                            )
                            .with_udp_addrs(vec!["0.0.0.0:0".into()])
                            .build()
                            .await?,
                    );
                    self.pairs.insert(
                        plan.id,
                        Pair {
                            polite: self.session > plan.peer_id,
                            plan: plan.clone(),
                            pc,
                            pending_offer: None,
                            answer: None,
                            negotiate: false,
                            ignore_offer: false,
                            candidates: vec![],
                            remote: HashMap::new(),
                            latest: HashMap::new(),
                            outputs: HashMap::new(),
                            tasks: HashMap::new(),
                            dc: None,
                            bulk: None,
                            files: FileLink::new(plan.peer_id, state.clone(), &self.files).await,
                            state,
                            dc_open: false,
                            base_failed: false,
                            reported: HashSet::new(),
                            deadline: Some(Instant::now() + Duration::from_secs(20)),
                            overflow,
                        },
                    );
                }
                let id = plan.id;
                let p = self.pairs.get_mut(&id).unwrap();
                if plan.rooms.iter().any(|r| !p.plan.rooms.contains(r)) {
                    p.base_failed = false;
                }
                p.reported.retain(|r| plan.rooms.contains(r));
                p.plan = plan;
                p.latest.retain(|pub_id, _| {
                    self.publications.contains(pub_id) && p.plan.incoming.contains(pub_id)
                });
                let keep: HashSet<_> = p
                    .latest
                    .values()
                    .copied()
                    .chain(self.sources.values().filter(|s| s.pair == id).map(|s| s.id))
                    .collect();
                let retired: Vec<_> = p
                    .tasks
                    .iter()
                    .filter(|(id, task)| !keep.contains(id) || task.is_finished())
                    .map(|(id, _)| *id)
                    .collect();
                for id in retired {
                    let task = p.tasks.remove(&id).unwrap();
                    task.abort();
                    let _ = task.await;
                }
                let remove: Vec<_> = p
                    .outputs
                    .keys()
                    .filter(|pub_id| {
                        !p.plan.outgoing.contains(pub_id) || !self.publications.contains(pub_id)
                    })
                    .copied()
                    .collect();
                for pub_id in remove {
                    p.outputs.remove(&pub_id).unwrap().close(&*p.pc).await;
                }
                if p.plan.rooms.is_empty() {
                    for (_, dc, task) in [p.dc.take(), p.bulk.take()].into_iter().flatten() {
                        task.abort();
                        let _ = task.await;
                        let _ = dc.close().await;
                    }
                    p.files.unbind(Lane::Control);
                    p.files.unbind(Lane::Bulk);
                    p.dc_open = false;
                } else if !p.polite && !p.base_failed && p.dc.is_none() {
                    let dc = p.pc.create_data_channel("piik-room", None).await?;
                    self.install_dc(id, dc).await?;
                }
                let p = self.pairs.get(&id).unwrap();
                if !p.plan.rooms.is_empty() && !p.polite && !p.base_failed && p.bulk.is_none() {
                    let dc = p.pc.create_data_channel("piik-file", None).await?;
                    self.install_dc(id, dc).await?;
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                eprintln!("Native pair update failed: {error}");
                self.fail(id).await;
            }
        }
        self.refresh_media().await?;
        for id in self.pairs.keys().copied().collect::<Vec<_>>() {
            self.base_ready(id).await;
        }
        Ok(())
    }
    async fn local_signal(&self, id: Uuid, exchange: Uuid) -> Result<Signal> {
        let p = &self.pairs[&id];
        let description =
            p.pc.local_description()
                .await
                .ok_or_else(|| anyhow!("missing local description"))?;
        Ok(Signal {
            description: Some(Description {
                kind: description.sdp_type.to_string(),
                sdp: Some(description.sdp),
            }),
            candidate: None,
            tracks: Some(
                p.outputs
                    .iter()
                    .map(|(publication_id, out)| WireTrack {
                        publication_id: *publication_id,
                        stream_id: out.stream.clone(),
                    })
                    .collect(),
            ),
            resync: None,
            exchange_id: Some(exchange),
        })
    }
    async fn send_signal(&self, id: Uuid, mut payload: Signal) {
        // SDP/exchange are immutable protocol state. Publication bindings are a
        // projection of today's leases, so a replay can only remove old mappings.
        if let (Some(pair), Some(tracks)) = (self.pairs.get(&id), payload.tracks.as_mut()) {
            tracks.retain(|track| {
                pair.plan.outgoing.contains(&track.publication_id)
                    && pair
                        .outputs
                        .get(&track.publication_id)
                        .is_some_and(|out| out.stream == track.stream_id)
            });
        }
        self.send(Command::Signal {
            pair_id: id,
            payload,
        })
        .await;
    }
    async fn resync(&self) {
        for id in self.pairs.keys().copied() {
            self.send_signal(
                id,
                Signal {
                    description: None,
                    candidate: None,
                    tracks: None,
                    resync: Some(true),
                    exchange_id: None,
                },
            )
            .await;
            self.replay_pending(id).await;
        }
    }
    async fn replay_pending(&self, id: Uuid) {
        if let Some(offer) = self
            .pairs
            .get(&id)
            .and_then(|pair| pair.pending_offer.clone())
        {
            self.send_signal(id, offer).await;
        }
    }
    async fn offer(&mut self, id: Uuid) -> Result<()> {
        let Some(p) = self.pairs.get_mut(&id) else {
            return Ok(());
        };
        if p.pending_offer.is_some() {
            p.negotiate = true;
            return Ok(());
        }
        p.negotiate = false;
        p.pc.set_local_description(p.pc.create_offer(None).await?)
            .await?;
        let offer = self.local_signal(id, Uuid::new_v4()).await?;
        self.pairs.get_mut(&id).unwrap().pending_offer = Some(offer.clone());
        self.send_signal(id, offer).await;
        Ok(())
    }
    async fn signal(&mut self, id: Uuid, signal: Signal) -> Result<()> {
        let Some(p) = self.pairs.get_mut(&id) else {
            return Ok(());
        };
        if signal.resync == Some(true) {
            self.replay_pending(id).await;
            return Ok(());
        }
        if let Some(description) = signal.description {
            let exchange = signal
                .exchange_id
                .ok_or_else(|| anyhow!("missing SDP exchange"))?;
            if description.kind == "answer"
                && p.pending_offer.as_ref().and_then(|offer| offer.exchange_id) != Some(exchange)
            {
                return Ok(());
            }
            if description.kind == "offer"
                && p.answer
                    .as_ref()
                    .is_some_and(|answer| answer.exchange_id == Some(exchange))
            {
                let answer = p.answer.clone().unwrap();
                self.send_signal(id, answer).await;
                return Ok(());
            }
            let offer = description.kind == "offer";
            let collision = offer && p.pending_offer.is_some();
            p.ignore_offer = collision && !p.polite;
            if p.ignore_offer {
                return Ok(());
            }
            if collision {
                p.pc.set_local_description(serde_json::from_value(
                    serde_json::json!({"type":"rollback","sdp":""}),
                )?)
                .await?;
                p.pending_offer = None;
            }
            p.remote = signal
                .tracks
                .unwrap_or_default()
                .into_iter()
                .filter(|t| p.plan.incoming.contains(&t.publication_id))
                .map(|t| (t.stream_id, t.publication_id))
                .collect();
            let desc: RTCSessionDescription = serde_json::from_value(
                serde_json::json!({"type":description.kind,"sdp":description.sdp.clone().unwrap_or_default()}),
            )?;
            p.pc.set_remote_description(desc).await?;
            for c in p.candidates.drain(..) {
                p.pc.add_ice_candidate(ice_candidate(c)).await?;
            }
            if offer {
                p.pc.set_local_description(p.pc.create_answer(None).await?)
                    .await?;
                let answer = self.local_signal(id, exchange).await?;
                self.pairs.get_mut(&id).unwrap().answer = Some(answer.clone());
                self.send_signal(id, answer).await;
            } else {
                p.pending_offer = None;
                p.answer = None;
                if p.negotiate {
                    self.offer(id).await?;
                }
            }
        } else if let Some(c) = signal.candidate {
            if !p.ignore_offer {
                if p.pc.remote_description().await.is_some() {
                    p.pc.add_ice_candidate(ice_candidate(c)).await?;
                } else if p.candidates.len() < 128 {
                    p.candidates.push(c);
                } else {
                    return Err(anyhow!("too many early ICE candidates"));
                }
            }
        }
        Ok(())
    }
    async fn install_dc(&mut self, id: Uuid, dc: Arc<dyn DataChannel>) -> Result<()> {
        let p = self.pairs.get_mut(&id).unwrap();
        let label = match dc.label().await {
            Ok(label) => label,
            Err(_) => return Ok(()),
        };
        let lane = match label.as_str() {
            "piik-room" => Lane::Control,
            "piik-file" => Lane::Bulk,
            _ => {
                dc.close().await?;
                return Ok(());
            }
        };
        if p.plan.rooms.is_empty()
            || (lane == Lane::Control && p.dc.is_some())
            || (lane == Lane::Bulk && p.bulk.is_some())
        {
            dc.close().await?;
            return Ok(());
        }
        if !dc.ordered().await?
            || dc.max_retransmits().await?.is_some()
            || dc.max_packet_life_time().await?.is_some()
        {
            dc.close().await?;
            if lane == Lane::Control {
                return Err(anyhow!("base DC must be reliable ordered"));
            }
            return Ok(());
        }
        let token = Uuid::new_v4();
        let ready = p.files.bind(lane, token, dc.clone());
        let events = self.events.clone();
        let files = self.files.receiver();
        let peer = p.plan.peer_id;
        let state = p.state.clone();
        let channel = dc.clone();
        let task = tokio::spawn(async move {
            while let Some(event) = channel.poll().await {
                match event {
                    DataChannelEvent::OnOpen => {
                        if ready.set(true) && lane == Lane::Control {
                            let _ = events.send(Event::Dc(id, token, true)).await;
                        }
                    }
                    DataChannelEvent::OnMessage(message) => {
                        files
                            .message(peer, lane, token, message.data.as_ref())
                            .await
                    }
                    DataChannelEvent::OnClose | DataChannelEvent::OnError => {
                        if ready.set(false) {
                            files
                                .closed(
                                    peer,
                                    lane,
                                    token,
                                    lane == Lane::Control || crate::file::terminal(&state),
                                )
                                .await;
                            let event = if lane == Lane::Control {
                                Event::Dc(id, token, false)
                            } else {
                                Event::Bulk(id, token)
                            };
                            let _ = events.send(event).await;
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });
        let value = Some((token, dc, task));
        if lane == Lane::Control {
            p.dc = value;
        } else {
            p.bulk = value;
        }
        Ok(())
    }
    async fn base_ready(&mut self, id: Uuid) {
        let Some(p) = self.pairs.get_mut(&id) else {
            return;
        };
        if p.connected() && p.dc_open && !p.base_failed {
            let rooms: Vec<_> = p
                .plan
                .rooms
                .iter()
                .filter(|r| !p.reported.contains(*r))
                .cloned()
                .collect();
            p.reported.extend(rooms.clone());
            p.deadline = None;
            for room_id in rooms {
                self.send(Command::BaseState {
                    room_id,
                    pair_id: id,
                    ready: true,
                })
                .await;
            }
        } else if p.connected() && (p.plan.rooms.is_empty() || p.base_failed) {
            p.deadline = None;
        } else if p.connected() && p.deadline.is_none() {
            p.deadline = Some(Instant::now() + Duration::from_secs(20));
        }
    }
    async fn fail_base(&mut self, id: Uuid) {
        let Some(p) = self.pairs.get_mut(&id) else {
            return;
        };
        if p.base_failed || p.plan.rooms.is_empty() {
            return;
        }
        p.base_failed = true;
        p.dc_open = false;
        p.reported.clear();
        let rooms = p.plan.rooms.clone();
        self.files.unavailable(p.plan.peer_id).await;
        p.files.unbind(Lane::Control);
        p.files.unbind(Lane::Bulk);
        for (_, dc, task) in [p.dc.take(), p.bulk.take()].into_iter().flatten() {
            task.abort();
            let _ = task.await;
            let _ = dc.close().await;
        }
        for room_id in rooms {
            self.send(Command::BaseState {
                room_id,
                pair_id: id,
                ready: false,
            })
            .await;
        }
    }
    async fn fail(&mut self, id: Uuid) {
        self.fail_base(id).await;
        self.send(Command::LinkState {
            pair_id: id,
            state: LinkState::Failed,
        })
        .await;
    }
    async fn deadlines(&mut self) {
        let expired: Vec<_> = self
            .pairs
            .iter()
            .filter(|(_, p)| {
                p.overflow.swap(false, Ordering::AcqRel)
                    || p.deadline.is_some_and(|d| Instant::now() >= d)
            })
            .map(|(id, p)| (*id, p.connected()))
            .collect();
        for (id, connected) in expired {
            self.pairs.get_mut(&id).unwrap().deadline = None;
            if connected {
                self.fail_base(id).await;
            } else {
                self.fail(id).await;
            }
        }
    }
    async fn event(&mut self, event: Event) -> Result<()> {
        match event {
            Event::Negotiate(id) => {
                if self.pairs.contains_key(&id) {
                    self.offer(id).await?;
                }
            }
            Event::Candidate(id, candidate) => {
                if self.pairs.contains_key(&id) {
                    self.send(Command::Signal {
                        pair_id: id,
                        payload: Signal {
                            candidate: Some(candidate),
                            description: None,
                            tracks: None,
                            resync: None,
                            exchange_id: None,
                        },
                    })
                    .await;
                }
            }
            Event::State(id, state) => {
                if let Some(p) = self.pairs.get_mut(&id) {
                    if p.connected() {
                        self.send(Command::LinkState {
                            pair_id: id,
                            state: LinkState::Connected,
                        })
                        .await;
                        self.base_ready(id).await;
                    } else if state == RTCPeerConnectionState::Failed {
                        self.fail(id).await;
                    }
                }
            }
            Event::Channel(id, dc) => {
                if self.pairs.contains_key(&id) {
                    self.install_dc(id, dc).await?;
                } else {
                    let _ = dc.close().await;
                }
            }
            Event::Dc(id, token, open) => {
                if let Some(p) = self.pairs.get_mut(&id) {
                    if p.dc.as_ref().is_some_and(|(t, _, _)| *t == token) {
                        p.dc_open = open;
                        if open {
                            self.base_ready(id).await;
                        } else {
                            self.fail_base(id).await;
                        }
                    }
                }
            }
            Event::Bulk(id, token) => {
                if let Some(p) = self.pairs.get_mut(&id) {
                    if p.bulk
                        .as_ref()
                        .is_some_and(|(current, _, _)| *current == token)
                    {
                        p.files.unbind(Lane::Bulk);
                        if let Some((_, dc, task)) = p.bulk.take() {
                            task.abort();
                            let _ = task.await;
                            let _ = dc.close().await;
                        }
                    }
                }
            }
            Event::Track(id, track) => {
                self.track(id, track).await?;
            }
        }
        Ok(())
    }
    async fn track(&mut self, id: Uuid, track: Arc<dyn TrackRemote>) -> Result<()> {
        let Some(p) = self.pairs.get_mut(&id) else {
            return Ok(());
        };
        let stream = track.stream_id().await;
        let Some(publication) = p.remote.get(&stream).copied() else {
            return Ok(());
        };
        if !p.plan.incoming.contains(&publication)
            || !self.publications.contains(&publication)
            || track.kind().await != RtpCodecKind::Audio
        {
            return Ok(());
        }
        let Some(ssrc) = track.ssrcs().await.first().copied() else {
            return Ok(());
        };
        let Some(codec) = track.codec(ssrc).await else {
            return Ok(());
        };
        if !codec.mime_type.eq_ignore_ascii_case(MIME_TYPE_OPUS) || codec.clock_rate != 48000 {
            return Ok(());
        }
        let source = Source {
            id: Uuid::new_v4(),
            pair: id,
            stream,
            codec,
            ssrc,
        };
        if let Some(previous) = p.latest.insert(publication, source.id) {
            if self.sources.get(&publication).map(|s| s.id) != Some(previous) {
                if let Some(task) = p.tasks.remove(&previous) {
                    task.abort();
                    let _ = task.await;
                }
            }
        }
        let audio = self.audio.clone();
        let relay = self.relay.clone();
        let source_id = source.id;
        p.tasks.retain(|_, task| !task.is_finished());
        p.tasks.insert(
            source_id,
            tokio::spawn(async move {
                let mut first = true;
                while let Some(event) = track.poll().await {
                    match event {
                        TrackRemoteEvent::OnRtpPacket(packet)
                            if packet.header.ssrc == source.ssrc && !packet.payload.is_empty() =>
                        {
                            if first {
                                first = false;
                                if audio
                                    .send(Audio {
                                        publication,
                                        source: source.clone(),
                                        packet: packet.clone(),
                                    })
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            relay.write(publication, source.id, packet);
                        }
                        TrackRemoteEvent::OnEnded => break,
                        _ => {}
                    }
                }
            }),
        );
        Ok(())
    }
    async fn packet(&mut self, audio: Audio) -> Result<()> {
        let Audio {
            publication,
            source,
            packet,
        } = audio;
        if !self.publications.contains(&publication) {
            return Ok(());
        }
        let desired = self.pairs.get(&source.pair).is_some_and(|p| {
            p.plan.incoming.contains(&publication)
                && p.remote.get(&source.stream) == Some(&publication)
                && p.latest.get(&publication) == Some(&source.id)
        });
        if !desired {
            return Ok(());
        }
        // The control-plane lease alone never tears down an audible source.
        // Only a validated packet from its replacement commits the handoff.
        if let Some(old) = self.sources.get(&publication) {
            if let Some(pair) = self.pairs.get_mut(&old.pair) {
                if let Some(task) = pair.tasks.remove(&old.id) {
                    task.abort();
                    let _ = task.await;
                }
            }
        }
        self.sources.insert(publication, source.clone());
        self.refresh_media().await?;
        self.relay.write(publication, source.id, packet);
        self.send(Command::FlowState {
            publication_id: publication,
            pair_id: source.pair,
            ready: true,
        })
        .await;
        Ok(())
    }
    async fn refresh_media(&mut self) -> Result<()> {
        let mut failed = Vec::new();
        for (publication, source) in &self.sources {
            let mut targets = Vec::new();
            for (id, p) in &mut self.pairs {
                if *id == source.pair || !p.plan.outgoing.contains(publication) {
                    continue;
                }
                if p.outputs
                    .get(publication)
                    .is_none_or(|o| o.source != source.id)
                {
                    let next = match Output::new(&*p.pc, source).await {
                        Ok(next) => next,
                        Err(error) => {
                            eprintln!("Native Opus attach failed: {error}");
                            failed.push(*id);
                            continue;
                        }
                    };
                    if let Some(old) = p.outputs.insert(*publication, next) {
                        old.close(&*p.pc).await;
                    }
                }
                targets.push(p.outputs[publication].sink());
            }
            self.relay.set(*publication, source.id, targets);
        }
        for id in failed {
            self.fail(id).await;
        }
        Ok(())
    }
}
fn ice_candidate(c: Candidate) -> rtc::peer_connection::transport::RTCIceCandidateInit {
    rtc::peer_connection::transport::RTCIceCandidateInit {
        candidate: c.candidate.unwrap_or_default(),
        sdp_mid: c.sdp_mid,
        sdp_mline_index: c.sdp_m_line_index,
        username_fragment: c.username_fragment,
        url: None,
    }
}
async fn close_pair(mut pair: Pair) {
    pair.state
        .store(RTCPeerConnectionState::Closed as u8, Ordering::Release);
    let _ = pair.pc.close().await;
    for (_, _, task) in [pair.dc.take(), pair.bulk.take()].into_iter().flatten() {
        task.abort();
        let _ = task.await;
    }
    pair.files.close().await;
    for (_, task) in pair.tasks {
        task.abort();
        let _ = task.await;
    }
    for (_, output) in pair.outputs {
        output.close(&*pair.pc).await;
    }
}
