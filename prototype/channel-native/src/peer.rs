//! Native transport for authorized adjacent pairs. The domain supplies all leases.
use crate::{
    data::{self, DataLink, Lane},
    file::Files,
    media::{
        supported, MediaFeedback, Output, Relay, ReportProjection, SenderReports, Source, TrackKey,
        VIDEO_PACKETS,
    },
};
use anyhow::{anyhow, Result};
use piik_channel_prototype::conversation::{ControlFrame, SignedPacket};
use piik_channel_prototype::file_room::FilePlan;
use piik_channel_prototype::wire::Snapshot;
use piik_channel_prototype::wire::{
    Candidate, Command, Description, FlowState, LinkState, PairInfo, PublicationInfo, Signal,
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
    rtcp::{
        payload_feedbacks::picture_loss_indication::PictureLossIndication,
        sender_report::SenderReport,
    },
    rtp,
    rtp_transceiver::rtp_sender::{RTCRtpCodec, RTCRtpCodecParameters, RtpCodecKind},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
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
    links: Arc<Mutex<HashMap<Uuid, (Uuid, data::Senders)>>>,
}
pub enum NativeEvent {
    Command(Command),
    Conversation {
        peer: Uuid,
        pair: Uuid,
        token: Uuid,
        packet: SignedPacket,
    },
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
pub(crate) enum Event {
    Negotiate(Uuid),
    Candidate(Uuid, Candidate),
    State(Uuid, RTCPeerConnectionState),
    Track(Uuid, Arc<dyn TrackRemote>),
    Channel(Uuid, Arc<dyn DataChannel>),
    Dc(Uuid, Uuid, bool),
    Bulk(Uuid, Uuid),
    OutputFailed {
        pair: Uuid,
        key: TrackKey,
        source: Uuid,
        output: Uuid,
    },
    SourceEnded {
        pair: Uuid,
        key: TrackKey,
        source: Uuid,
    },
    DataWriteFailed {
        pair: Uuid,
        lane: Lane,
        token: Uuid,
        temporary: bool,
    },
}
struct FirstPacket {
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
    pending_offer: Option<PendingOffer>,
    stable_outputs: Option<HashSet<Uuid>>,
    failed_offer: Option<OfferWork>,
    answer: Option<Signal>,
    negotiate: bool,
    ignore_offer: bool,
    candidates: Vec<Candidate>,
    remote: HashMap<String, Uuid>,
    latest: HashMap<TrackKey, Uuid>,
    outputs: HashMap<TrackKey, Output>,
    rejected_outputs: HashMap<TrackKey, Uuid>,
    reports: SenderReports,
    tasks: HashMap<Uuid, Reader>,
    dc: Option<(Uuid, Arc<dyn DataChannel>, JoinHandle<()>)>,
    bulk: Option<(Uuid, Arc<dyn DataChannel>, JoinHandle<()>)>,
    data: DataLink,
    state: Arc<AtomicU8>,
    dc_open: bool,
    base_failed: bool,
    reported: HashSet<String>,
    deadline: Option<Instant>,
    overflow: Arc<AtomicBool>,
}
struct Reader {
    key: TrackKey,
    track: String,
    task: JoinHandle<()>,
}

#[derive(Clone)]
struct PendingOffer {
    signal: Signal,
    outputs: HashSet<Uuid>,
}

#[derive(PartialEq, Eq)]
struct OfferWork {
    outputs: HashSet<Uuid>,
    flows: HashSet<Uuid>,
    rooms: Vec<String>,
    control: Option<Uuid>,
    bulk: Option<Uuid>,
}

impl Pair {
    fn connected(&self) -> bool {
        self.state.load(Ordering::Acquire) == RTCPeerConnectionState::Connected as u8
    }

    fn output_ids(&self) -> HashSet<Uuid> {
        self.outputs.values().map(|output| output.id).collect()
    }

    fn offer_work(&self) -> OfferWork {
        OfferWork {
            outputs: self.output_ids(),
            flows: self
                .plan
                .outgoing
                .iter()
                .chain(&self.plan.incoming)
                .map(|flow| flow.id)
                .collect(),
            rooms: self.plan.rooms.clone(),
            control: self.dc.as_ref().map(|(token, _, _)| *token),
            bulk: self.bulk.as_ref().map(|(token, _, _)| *token),
        }
    }

    async fn stable(&self) -> bool {
        let state = self.state.load(Ordering::Acquire);
        state != RTCPeerConnectionState::Failed as u8
            && state != RTCPeerConnectionState::Closed as u8
            && self.pc.current_local_description().await.is_some()
            && self.pc.current_remote_description().await.is_some()
            && self.pc.pending_local_description().await.is_none()
            && self.pc.pending_remote_description().await.is_none()
    }

    async fn confirm_outputs(&mut self, offered: HashSet<Uuid>) -> Result<()> {
        let mut stable = HashSet::new();
        for transceiver in self.pc.get_transceivers().await {
            if matches!(
                transceiver.current_direction().await?,
                rtc::rtp_transceiver::RTCRtpTransceiverDirection::Sendonly
                    | rtc::rtp_transceiver::RTCRtpTransceiverDirection::Sendrecv
            ) {
                if let Some(sender) = transceiver.sender().await? {
                    stable.extend(
                        self.outputs
                            .values()
                            .filter(|output| {
                                offered.contains(&output.id) && output.sender.id() == sender.id()
                            })
                            .map(|output| output.id),
                    );
                }
            }
        }
        self.stable_outputs = Some(stable);
        Ok(())
    }
}
struct Driver {
    session: Uuid,
    ice: Vec<RTCIceServer>,
    commands: mpsc::Sender<NativeEvent>,
    links: Arc<Mutex<HashMap<Uuid, (Uuid, data::Senders)>>>,
    cancel: watch::Receiver<bool>,
    events: mpsc::Sender<Event>,
    first_packets: mpsc::Sender<FirstPacket>,
    pairs: HashMap<Uuid, Pair>,
    publications: HashMap<Uuid, piik_channel_prototype::wire::Kind>,
    sources: HashMap<TrackKey, Source>,
    relay: Relay,
    files: Files,
}
impl NativePeers {
    pub fn new(
        session_id: Uuid,
        ice_servers: Vec<RTCIceServer>,
        commands: mpsc::Sender<NativeEvent>,
    ) -> Self {
        // Callback events are control-only. They must never await the PC driver that
        // invokes them. RTP has a separate bounded queue and separate poll tasks.
        let (cancel, mut cancelled) = watch::channel(false);
        let (input, mut inputs) = mpsc::channel(64);
        let (events, mut event_rx) = mpsc::channel(1024);
        let (first_packets, mut first_rx) = mpsc::channel(256);
        let links = Arc::new(Mutex::new(HashMap::new()));
        let driver_links = links.clone();
        let task = tokio::spawn(async move {
            let mut d = Driver {
                session: session_id,
                ice: ice_servers,
                commands,
                links: driver_links,
                cancel: cancelled.clone(),
                events,
                first_packets,
                pairs: HashMap::new(),
                publications: HashMap::new(),
                sources: HashMap::new(),
                relay: Relay::default(),
                files: Files::new(session_id),
            };
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            enum Turn {
                Input(Input),
                Event(Event),
                FirstPacket(FirstPacket),
                Tick,
            }
            loop {
                let turn = tokio::select! {
                    _=cancelled.changed()=>break,
                    request=inputs.recv()=>match request {Some(request)=>Turn::Input(request),None=>break},
                    Some(event)=event_rx.recv()=>Turn::Event(event),
                    Some(packet)=first_rx.recv()=>Turn::FirstPacket(packet),
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
                                Event::OutputFailed { pair, .. } => *pair,
                                Event::SourceEnded { pair, .. } => *pair,
                                Event::DataWriteFailed { pair, .. } => *pair,
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
                                eprintln!("Native encoded track attach failed: {error}");
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
            links,
        }
    }
    pub(crate) fn control_current(&self, peer: Uuid, pair: Uuid, token: Uuid) -> bool {
        self.links
            .lock()
            .unwrap()
            .get(&peer)
            .is_some_and(|(current, senders)| {
                *current == pair && senders.current(Lane::Control, token, true)
            })
    }
    /// Queue directly on the existing pair writer; no peer control turn is needed.
    pub(crate) fn conversation(
        &self,
        peer: Uuid,
        packet: SignedPacket,
        original: SignedPacket,
        snapshot: watch::Receiver<Option<Snapshot>>,
        local: Uuid,
        from: Option<Uuid>,
    ) -> Result<()> {
        self.conversations(peer, vec![(packet, original)], snapshot, local, from)
    }
    pub(crate) fn conversations(
        &self,
        peer: Uuid,
        packets: Vec<(SignedPacket, SignedPacket)>,
        snapshot: watch::Receiver<Option<Snapshot>>,
        local: Uuid,
        from: Option<Uuid>,
    ) -> Result<()> {
        let messages = packets
            .into_iter()
            .map(|(packet, original)| {
                let bytes = piik_channel_prototype::conversation::encode_control(
                    &ControlFrame::Conversation(packet),
                )?;
                Ok(data::Message {
                    bytes,
                    scope: data::MessageScope::Conversation {
                        snapshot: snapshot.clone(),
                        local,
                        peer,
                        from,
                        packet: original,
                    },
                    report_failure: true,
                })
            })
            .collect::<Result<Vec<_>, &'static str>>()
            .map_err(anyhow::Error::msg)?;
        let links = self.links.lock().unwrap();
        let (_, link) = links
            .get(&peer)
            .ok_or_else(|| anyhow!("room_path_unavailable"))?;
        data::queue_controls(&link.control, messages).map_err(anyhow::Error::msg)
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
fn builder(polite: bool, reports: SenderReports) -> Result<PeerConnectionBuilder<String>> {
    let mut media = MediaEngine::default();
    media.register_codec(
        RTCRtpCodecParameters {
            rtp_codec: codec(),
            payload_type: 111,
            ..Default::default()
        },
        RtpCodecKind::Audio,
    )?;
    for (payload_type, mime_type, fmtp) in [
        (96, "video/VP8", ""),
        (
            102,
            "video/H264",
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ),
    ] {
        media.register_codec(
            RTCRtpCodecParameters {
                rtp_codec: RTCRtpCodec {
                    mime_type: mime_type.into(),
                    clock_rate: 90000,
                    sdp_fmtp_line: fmtp.into(),
                    ..Default::default()
                },
                payload_type,
                ..Default::default()
            },
            RtpCodecKind::Video,
        )?;
        media.register_codec(
            RTCRtpCodecParameters {
                rtp_codec: RTCRtpCodec {
                    mime_type: "video/rtx".into(),
                    clock_rate: 90000,
                    sdp_fmtp_line: format!("apt={payload_type}"),
                    ..Default::default()
                },
                payload_type: payload_type + 1,
                ..Default::default()
            },
            RtpCodecKind::Video,
        )?;
    }
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
            .with_queue_limit(VIDEO_PACKETS)
            .build(),
    )
    .with(Slot::Custom(20_000), MediaFeedback::default())
    .with(Slot::Custom(500), ReportProjection::new(reports));
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
                    piik_channel_prototype::conversation::CONTROL_FRAME_BYTES as u32,
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
        tokio::select! { _=cancel.changed()=>{}, _=self.commands.send(NativeEvent::Command(command))=>{} }
    }
    async fn update(
        &mut self,
        plans: Vec<PairInfo>,
        publications: Vec<PublicationInfo>,
        files: Vec<FilePlan>,
    ) -> Result<()> {
        self.files.update(files, &plans).await;
        self.publications = publications.into_iter().map(|p| (p.id, p.kind)).collect();
        let needed: HashSet<_> = plans
            .iter()
            .flat_map(|plan| plan.incoming.iter().map(|flow| flow.id))
            .collect();
        self.sources.retain(|_, source| {
            self.publications.contains_key(&source.publication_id)
                && needed.contains(&source.flow_id)
        });
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
                self.links.lock().unwrap().remove(&pair.plan.peer_id);
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
                    let reports = SenderReports::default();
                    let pc: Arc<dyn PeerConnection> = Arc::new(
                        builder(self.session > plan.peer_id, reports.clone())?
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
                    let data = DataLink::new(plan.id, state.clone(), self.events.clone());
                    self.links
                        .lock()
                        .unwrap()
                        .insert(plan.peer_id, (plan.id, data.senders()));
                    self.files.attach(plan.peer_id, data.senders()).await;
                    self.pairs.insert(
                        plan.id,
                        Pair {
                            polite: self.session > plan.peer_id,
                            plan: plan.clone(),
                            pc,
                            pending_offer: None,
                            stable_outputs: None,
                            failed_offer: None,
                            answer: None,
                            negotiate: false,
                            ignore_offer: false,
                            candidates: vec![],
                            remote: HashMap::new(),
                            latest: HashMap::new(),
                            outputs: HashMap::new(),
                            rejected_outputs: HashMap::new(),
                            reports,
                            tasks: HashMap::new(),
                            dc: None,
                            bulk: None,
                            data,
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
                p.latest.retain(|(flow_id, _), _| {
                    p.plan.incoming.iter().any(|flow| {
                        flow.id == *flow_id && self.publications.contains_key(&flow.publication_id)
                    })
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
                    .filter(|(id, reader)| !keep.contains(id) || reader.task.is_finished())
                    .map(|(id, _)| *id)
                    .collect();
                for id in retired {
                    let task = p.tasks.remove(&id).unwrap();
                    task.task.abort();
                    let _ = task.task.await;
                }
                if p.plan.rooms.is_empty() {
                    for (_, dc, task) in [p.dc.take(), p.bulk.take()].into_iter().flatten() {
                        task.abort();
                        let _ = task.await;
                        let _ = dc.close().await;
                    }
                    p.data.unbind(Lane::Control);
                    p.data.unbind(Lane::Bulk);
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
                    .map(|((flow_id, _), out)| (*flow_id, out.stream.clone()))
                    .collect::<HashMap<_, _>>()
                    .into_iter()
                    .map(|(flow_id, stream_id)| WireTrack { flow_id, stream_id })
                    .collect(),
            ),
            resync: None,
            exchange_id: Some(exchange),
        })
    }
    async fn send_signal(&self, id: Uuid, mut payload: Signal) {
        // SDP/exchange are immutable protocol state. Flow bindings are a
        // projection of today's leases, so a replay can only remove old mappings.
        if let (Some(pair), Some(tracks)) = (self.pairs.get(&id), payload.tracks.as_mut()) {
            tracks.retain(|track| {
                pair.plan
                    .outgoing
                    .iter()
                    .any(|flow| flow.id == track.flow_id)
                    && pair.outputs.iter().any(|((flow, _), out)| {
                        *flow == track.flow_id && out.stream == track.stream_id
                    })
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
        if let Some(offer) = self.pairs.get(&id).and_then(|pair| {
            pair.pending_offer
                .as_ref()
                .map(|offer| offer.signal.clone())
        }) {
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
        let outputs = p.output_ids();
        if p.failed_offer.as_ref() == Some(&p.offer_work()) {
            return Ok(());
        }
        p.negotiate = false;
        let stable = p.stable_outputs.is_some() && p.stable().await;
        let result = async {
            p.pc.set_local_description(p.pc.create_offer(None).await?)
                .await?;
            Ok(())
        }
        .await;
        self.finish_offer(id, stable, outputs, result).await
    }

    async fn finish_offer(
        &mut self,
        id: Uuid,
        was_stable: bool,
        outputs: HashSet<Uuid>,
        result: Result<()>,
    ) -> Result<()> {
        if let Err(error) = result {
            let p = self.pairs.get_mut(&id).unwrap();
            if !was_stable || p.pending_offer.is_some() || !p.stable().await {
                return Err(error);
            }
            let stable = p.stable_outputs.as_ref().unwrap();
            let added: Vec<_> = p
                .outputs
                .iter()
                .filter_map(|(key, output)| {
                    (outputs.contains(&output.id) && !stable.contains(&output.id)).then_some(*key)
                })
                .collect();
            let mut affected = HashSet::new();
            for key in added {
                let output = p.outputs.remove(&key).unwrap();
                p.rejected_outputs.insert(key, output.source);
                affected.insert(key.0);
                output.close(&*p.pc).await;
            }
            let failed: Vec<_> = affected
                .into_iter()
                .filter(|flow| {
                    let binding = p
                        .plan
                        .outgoing
                        .iter()
                        .find(|binding| binding.id == *flow)
                        .expect("an allocated output owns a current flow");
                    let primary = if self.publications[&binding.publication_id]
                        == piik_channel_prototype::wire::Kind::Screen
                    {
                        RtpCodecKind::Video
                    } else {
                        RtpCodecKind::Audio
                    };
                    !p.outputs.contains_key(&(*flow, primary))
                })
                .collect();
            p.failed_offer = Some(p.offer_work());
            eprintln!("Native local offer failed before signaling: {error}");
            for flow_id in failed {
                self.send(Command::FlowState {
                    flow_id,
                    pair_id: id,
                    state: FlowState::Failed,
                })
                .await;
            }
            return Ok(());
        }
        let offer = self.local_signal(id, Uuid::new_v4()).await?;
        let p = self.pairs.get_mut(&id).unwrap();
        p.failed_offer = None;
        p.pending_offer = Some(PendingOffer {
            signal: offer.clone(),
            outputs,
        });
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
                && p.pending_offer
                    .as_ref()
                    .and_then(|offer| offer.signal.exchange_id)
                    != Some(exchange)
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
                .filter(|t| p.plan.incoming.iter().any(|flow| flow.id == t.flow_id))
                .map(|t| (t.stream_id, t.flow_id))
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
                let p = self.pairs.get_mut(&id).unwrap();
                p.confirm_outputs(p.output_ids()).await?;
                p.answer = Some(answer.clone());
                self.send_signal(id, answer).await;
            } else {
                let offered = p.pending_offer.take().unwrap().outputs;
                p.answer = None;
                p.confirm_outputs(offered).await?;
                if p.negotiate {
                    self.offer(id).await?;
                }
            }
            self.reconcile_receivers(id).await?;
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
        let ready = p.data.bind(lane, token, dc.clone());
        let events = self.events.clone();
        let files = self.files.receiver();
        let peer = p.plan.peer_id;
        let commands = self.commands.clone();
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
                    DataChannelEvent::OnMessage(message) => match lane {
                        Lane::Control => {
                            if !ready.open() {
                                continue;
                            }
                            match data::control(message.data.as_ref()) {
                                Some(ControlFrame::File(control)) => {
                                    files.control(peer, token, control).await
                                }
                                Some(ControlFrame::Conversation(packet)) => {
                                    if commands
                                        .send(NativeEvent::Conversation {
                                            peer,
                                            pair: id,
                                            token,
                                            packet,
                                        })
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                }
                                None => {}
                            }
                        }
                        Lane::Bulk => files.chunk(peer, token, message.data.as_ref()).await,
                    },
                    DataChannelEvent::OnClose | DataChannelEvent::OnError => {
                        if ready.set(false) {
                            files
                                .closed(
                                    peer,
                                    lane,
                                    token,
                                    lane == Lane::Control || data::terminal(&state),
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
        p.data.unbind(Lane::Control);
        p.data.unbind(Lane::Bulk);
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
    async fn reconcile_receivers(&mut self, pair: Uuid) -> Result<()> {
        let Some(p) = self.pairs.get(&pair) else {
            return Ok(());
        };
        let mut ended = HashSet::new();
        for transceiver in p.pc.get_transceivers().await {
            if !matches!(
                transceiver.current_direction().await?,
                rtc::rtp_transceiver::RTCRtpTransceiverDirection::Recvonly
                    | rtc::rtp_transceiver::RTCRtpTransceiverDirection::Sendrecv
            ) {
                if let Some(receiver) = transceiver.receiver().await? {
                    ended.insert(receiver.track().track_id().await);
                }
            }
        }
        let retired: Vec<_> = p
            .tasks
            .iter()
            .filter(|(_, reader)| ended.contains(&reader.track))
            .map(|(source, reader)| (*source, reader.key))
            .collect();
        for (source, key) in retired {
            self.source_ended(pair, key, source).await;
        }
        Ok(())
    }
    async fn source_ended(&mut self, pair: Uuid, key: TrackKey, source: Uuid) {
        // An old active source may end while its replacement is awaiting a first
        // packet. Only the latest reader can invalidate the current incoming lease.
        let assigned_latest = self.pairs.get(&pair).and_then(|p| {
            p.plan
                .incoming
                .iter()
                .find(|flow| flow.id == key.0 && p.latest.get(&key) == Some(&source))
                .copied()
        });
        if let Some(p) = self.pairs.get_mut(&pair) {
            if p.latest.get(&key) == Some(&source) {
                p.latest.remove(&key);
            }
            if let Some(reader) = p.tasks.remove(&source) {
                reader.task.abort();
                let _ = reader.task.await;
            }
        }
        if self
            .sources
            .get(&key)
            .is_some_and(|current| current.id == source && current.pair == pair)
        {
            let publication = self.sources.remove(&key).unwrap().publication_id;
            self.relay.remove(key);
            for p in self.pairs.values_mut() {
                let retired: Vec<_> = p
                    .outputs
                    .iter()
                    .filter(|(_, output)| output.source == source)
                    .map(|(key, _)| *key)
                    .collect();
                for key in retired {
                    p.outputs.remove(&key).unwrap().close(&*p.pc).await;
                }
            }
            if assigned_latest.is_some_and(|flow| {
                !flow.selected
                    || key.1 == RtpCodecKind::Video
                    || self.publications.get(&publication)
                        == Some(&piik_channel_prototype::wire::Kind::Voice)
            }) {
                self.send(Command::FlowState {
                    flow_id: key.0,
                    pair_id: pair,
                    state: FlowState::Failed,
                })
                .await;
            }
        }
    }
    async fn event(&mut self, event: Event) -> Result<()> {
        match event {
            Event::DataWriteFailed {
                pair,
                lane,
                token,
                temporary,
            } => {
                if let Some(p) = self.pairs.get(&pair) {
                    self.files
                        .receiver()
                        .closed(p.plan.peer_id, lane, token, temporary)
                        .await;
                }
            }
            Event::SourceEnded { pair, key, source } => self.source_ended(pair, key, source).await,
            Event::OutputFailed {
                pair,
                key,
                source,
                output,
            } => {
                if let Some(p) = self.pairs.get_mut(&pair) {
                    if p.outputs
                        .get(&key)
                        .is_some_and(|current| current.source == source && current.id == output)
                    {
                        let binding = p
                            .plan
                            .outgoing
                            .iter()
                            .find(|flow| flow.id == key.0)
                            .copied();
                        p.outputs.remove(&key).unwrap().close(&*p.pc).await;
                        if binding.is_some_and(|flow| {
                            !flow.selected
                                || key.1 == RtpCodecKind::Video
                                || self.publications.get(&flow.publication_id)
                                    == Some(&piik_channel_prototype::wire::Kind::Voice)
                        }) {
                            self.send(Command::FlowState {
                                flow_id: key.0,
                                pair_id: pair,
                                state: FlowState::Failed,
                            })
                            .await;
                        }
                    }
                }
            }
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
                        p.data.unbind(Lane::Bulk);
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
        let Some(flow_id) = p.remote.get(&stream).copied() else {
            return Ok(());
        };
        let Some(binding) = p.plan.incoming.iter().find(|flow| flow.id == flow_id) else {
            return Ok(());
        };
        let publication = binding.publication_id;
        if !self.publications.contains_key(&publication) {
            return Ok(());
        }
        let Some(ssrc) = track.ssrcs().await.first().copied() else {
            return Ok(());
        };
        let Some(codec) = track.codec(ssrc).await else {
            return Ok(());
        };
        let kind = track.kind().await;
        if !supported(&codec, kind)
            || (kind == RtpCodecKind::Video
                && self.publications[&publication] != piik_channel_prototype::wire::Kind::Screen)
        {
            if !binding.selected
                || (kind == RtpCodecKind::Video
                    && self.publications[&publication]
                        == piik_channel_prototype::wire::Kind::Screen)
            {
                self.send(Command::FlowState {
                    flow_id,
                    pair_id: id,
                    state: FlowState::Failed,
                })
                .await;
            }
            return Ok(());
        }
        let key = (flow_id, kind);
        let (keyframes, mut requests) = watch::channel(0u64);
        let source = Source {
            id: Uuid::new_v4(),
            flow_id,
            publication_id: publication,
            pair: id,
            stream,
            codec,
            ssrc,
            kind,
            keyframes,
            report: Default::default(),
        };
        if let Some(previous) = p.latest.insert(key, source.id) {
            if self.sources.get(&key).map(|s| s.id) != Some(previous) {
                if let Some(task) = p.tasks.remove(&previous) {
                    task.task.abort();
                    let _ = task.task.await;
                }
            }
        }
        let first_packets = self.first_packets.clone();
        let relay = self.relay.clone();
        let source_id = source.id;
        let events = self.events.clone();
        let track_id = track.track_id().await;
        p.tasks.retain(|_, reader| !reader.task.is_finished());
        let task = tokio::spawn(async move {
            let mut first = true;
            loop {
                let event = tokio::select! {
                    event = track.poll() => match event {
                        Some(event) => event,
                        None => break,
                    },
                    result = requests.changed(), if kind == RtpCodecKind::Video => {
                        if result.is_err() {
                            break;
                        }
                        let _ = track.write_rtcp(vec![Box::new(PictureLossIndication {
                            sender_ssrc: 0,
                            media_ssrc: source.ssrc,
                        })]).await;
                        continue;
                    }
                };
                match event {
                    TrackRemoteEvent::OnRtpPacket(packet)
                        if packet.header.ssrc == source.ssrc && !packet.payload.is_empty() =>
                    {
                        if first {
                            first = false;
                            if first_packets
                                .send(FirstPacket {
                                    source: source.clone(),
                                    packet: packet.clone(),
                                })
                                .await
                                .is_err()
                            {
                                break;
                            }
                        } else {
                            relay.write(key, source.id, packet);
                        }
                    }
                    TrackRemoteEvent::OnEnded => break,
                    TrackRemoteEvent::OnRtcpPacket(packets) => {
                        for packet in packets {
                            if let Some(report) = packet.as_any().downcast_ref::<SenderReport>() {
                                if report.ssrc == source.ssrc {
                                    *source.report.lock().unwrap() =
                                        Some((report.clone(), Instant::now()));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            let _ = events
                .send(Event::SourceEnded {
                    pair: id,
                    key,
                    source: source_id,
                })
                .await;
        });
        p.tasks.insert(
            source_id,
            Reader {
                key,
                track: track_id,
                task,
            },
        );
        Ok(())
    }
    async fn packet(&mut self, first_packet: FirstPacket) -> Result<()> {
        let FirstPacket { source, packet } = first_packet;
        let publication = source.publication_id;
        if !self.publications.contains_key(&publication) {
            return Ok(());
        }
        let key = (source.flow_id, source.kind);
        let desired = self.pairs.get(&source.pair).is_some_and(|p| {
            p.plan
                .incoming
                .iter()
                .any(|flow| flow.id == source.flow_id && flow.publication_id == publication)
                && p.remote.get(&source.stream) == Some(&source.flow_id)
                && p.latest.get(&key) == Some(&source.id)
        });
        if !desired {
            return Ok(());
        }
        // Within one live flow, keep its track until the successor delivers a packet.
        if let Some(old) = self.sources.get(&key) {
            if let Some(pair) = self.pairs.get_mut(&old.pair) {
                if let Some(task) = pair.tasks.remove(&old.id) {
                    task.task.abort();
                    let _ = task.task.await;
                }
            }
        }
        self.sources.insert(key, source.clone());
        self.refresh_media().await?;
        self.relay.write(key, source.id, packet);
        // A screen's audio alone does not establish its picture transport.
        if source.kind == RtpCodecKind::Video
            || self.publications[&publication] == piik_channel_prototype::wire::Kind::Voice
        {
            self.send(Command::FlowState {
                flow_id: source.flow_id,
                pair_id: source.pair,
                state: FlowState::Forwardable,
            })
            .await;
        }
        Ok(())
    }
    async fn refresh_media(&mut self) -> Result<()> {
        self.refresh_outputs().await?;
        let retry: Vec<_> = self
            .pairs
            .iter()
            .filter_map(|(id, pair)| {
                pair.failed_offer
                    .as_ref()
                    .filter(|previous| **previous != pair.offer_work())
                    .map(|_| *id)
            })
            .collect();
        let mut partial = false;
        for id in &retry {
            let pair = self.pairs.get_mut(id).unwrap();
            let before = pair.rejected_outputs.len();
            // A later real mutation may retry rejected companion audio while
            // preserving the screen's established video and flow identity.
            pair.rejected_outputs.retain(|(flow, kind), _| {
                *kind != RtpCodecKind::Audio
                    || !pair.outputs.contains_key(&(*flow, RtpCodecKind::Video))
            });
            partial |= pair.rejected_outputs.len() != before;
        }
        if partial {
            self.refresh_outputs().await?;
        }
        for id in retry {
            if let Err(error) = self.offer(id).await {
                eprintln!("Native pair negotiation failed: {error}");
                self.fail(id).await;
            }
        }
        Ok(())
    }

    async fn refresh_outputs(&mut self) -> Result<()> {
        // Forward the exact admitted input, including shadow branches. Selection
        // belongs to local playback and cannot recreate a prewarmed sender.
        for pair in self.pairs.values_mut() {
            pair.rejected_outputs.retain(|key, rejected| {
                pair.plan.outgoing.iter().any(|flow| {
                    flow.id == key.0
                        && flow
                            .input_flow_id
                            .and_then(|input| self.sources.get(&(input, key.1)))
                            .is_some_and(|source| source.id == *rejected)
                })
            });
            let retired: Vec<_> = pair
                .outputs
                .iter()
                .filter_map(|(key, output)| {
                    let source = pair
                        .plan
                        .outgoing
                        .iter()
                        .find(|flow| flow.id == key.0)
                        .and_then(|flow| {
                            self.sources
                                .get(&(flow.input_flow_id?, key.1))
                                .filter(|source| source.publication_id == flow.publication_id)
                        });
                    (!source.is_some_and(|source| source.id == output.source)).then_some(*key)
                })
                .collect();
            for key in retired {
                pair.outputs.remove(&key).unwrap().close(&*pair.pc).await;
            }
        }
        let mut failed = Vec::new();
        for (key, source) in &self.sources {
            let publication = &source.publication_id;
            let mut targets = Vec::new();
            for (id, p) in &mut self.pairs {
                if *id == source.pair {
                    continue;
                }
                for binding in p.plan.outgoing.iter().filter(|flow| {
                    flow.publication_id == *publication
                        && flow.input_flow_id == Some(source.flow_id)
                }) {
                    let output_key = (binding.id, source.kind);
                    if p.rejected_outputs.get(&output_key) == Some(&source.id) {
                        continue;
                    }
                    if !p.outputs.contains_key(&output_key) {
                        let stream = p
                            .outputs
                            .iter()
                            .find(|((flow, _), _)| *flow == binding.id)
                            .map(|(_, out)| out.stream.clone())
                            .unwrap_or_else(|| Uuid::new_v4().to_string());
                        let next = match Output::new(
                            &*p.pc,
                            source,
                            stream,
                            *id,
                            output_key,
                            self.events.clone(),
                            p.reports.clone(),
                        )
                        .await
                        {
                            Ok(next) => next,
                            Err(error) => {
                                eprintln!("Native encoded track attach failed: {error}");
                                if !binding.selected
                                    || source.kind == RtpCodecKind::Video
                                    || self.publications[publication]
                                        == piik_channel_prototype::wire::Kind::Voice
                                {
                                    failed.push((binding.id, *id));
                                }
                                continue;
                            }
                        };
                        p.outputs.insert(output_key, next);
                        source.request_keyframe();
                    }
                    targets.push(p.outputs[&output_key].sink());
                }
            }
            self.relay.set(*key, source.id, targets);
        }
        for (flow_id, pair_id) in failed {
            self.send(Command::FlowState {
                flow_id,
                pair_id,
                state: FlowState::Failed,
            })
            .await;
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
    pair.data.close().await;
    for (_, task) in pair.tasks {
        task.task.abort();
        let _ = task.task.await;
    }
    for (_, output) in pair.outputs {
        output.close(&*pair.pc).await;
    }
}

#[cfg(test)]
mod tests;
