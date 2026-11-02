//! Native transport for authorized adjacent pairs. The domain supplies all leases.
use crate::{
    data::{self, DataLink, Lane},
    file::Files,
    media::{
        supported, MediaKind, Output, OutputStreams, Relay, RtpCodec, Source, SourceFeed,
        SourceOrigin, TrackKey,
    },
};
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use piik_channel_core::conversation::{ControlFrame, SignedPacket};
use piik_channel_core::file_room::FilePlan;
use piik_channel_core::wire::Snapshot;
use piik_channel_core::wire::{
    Candidate, Command, Description, FlowState, LinkState, PairInfo, PublicationInfo, Signal,
    Track as WireTrack, UdpPreparation,
};
use rtc_ice::candidate::Candidate as IceCandidate;
use rtc_rtp as rtp;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, oneshot, watch, Notify},
    task::JoinHandle,
};
use transport::{Channel, ChannelEvent, Track, TrackEvent, Transport};
use uuid::Uuid;

const MAX_ICE_CANDIDATES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceAudioSettings {
    pub bitrate: u32,
    pub gain: f32,
}
impl Default for SourceAudioSettings {
    fn default() -> Self {
        Self {
            bitrate: 128_000,
            gain: 1.0,
        }
    }
}
impl SourceAudioSettings {
    pub fn validate(self) -> Result<()> {
        anyhow::ensure!(
            (6_000..=320_000).contains(&self.bitrate)
                && self.gain.is_finite()
                && (0.0..=2.0).contains(&self.gain),
            "invalid_audio_settings"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceMicrophoneSettings {
    pub enabled: bool,
    pub device_id: String,
    pub volume: f32,
}
impl Default for SourceMicrophoneSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            device_id: String::new(),
            volume: 1.0,
        }
    }
}
impl SourceMicrophoneSettings {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.volume.is_finite() && (0.0..=2.0).contains(&self.volume),
            "invalid_microphone_settings"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PeerState {
    New,
    Connected,
    Failed,
    Closed,
}

pub struct NativePeers {
    cancel: watch::Sender<bool>,
    input: mpsc::Sender<Input>,
    task: JoinHandle<()>,
    links: Arc<Mutex<HashMap<Uuid, (Uuid, data::Senders)>>>,
}
pub enum NativeEvent {
    Command(Command),
    CaptureEnded {
        publication_id: Uuid,
        error: Option<String>,
    },
    Conversation {
        peer: Uuid,
        pair: Uuid,
        token: Uuid,
        packet: SignedPacket,
    },
}
/// The controlling page owns cancellation; the Driver owns and joins the worker.
pub struct CaptureLease {
    pub id: Uuid,
    pub session_id: Uuid,
    pub scope: CaptureScope,
    ready: oneshot::Receiver<Result<()>>,
    codec: Arc<std::sync::OnceLock<crate::capture::VideoCodec>>,
    required_audio: Option<oneshot::Receiver<Result<()>>>,
    pub audio_error: Option<oneshot::Receiver<String>>,
    pub remote: Option<crate::input::Source>,
    pub input_state: Option<watch::Receiver<crate::input::SourceView>>,
    #[cfg(feature = "capture")]
    control: Option<CaptureLeaseControl>,
    producer: Uuid,
}
#[cfg(feature = "capture")]
enum CaptureLeaseControl {
    Capture(crate::media::local::Control),
    Audio(crate::media::local::AudioLeaseControl),
}
#[derive(Clone)]
pub struct CaptureScope {
    pub publication_id: Uuid,
    pub room_id: String,
    pub binding_id: Uuid,
}
pub struct CaptureInput {
    pub remote: Option<crate::input::Source>,
    pub state: Option<watch::Receiver<crate::input::SourceView>>,
}
#[cfg(feature = "capture")]
// Keyed by producer.video: stopped predecessors stay owned until their worker
// reports completion, without sharing the successor's publication cleanup.
struct Capture {
    scope: CaptureScope,
    target: crate::capture::Target,
    producer: crate::media::local::Producer,
    selected: bool,
    prepared: Vec<SourceReady>,
    pending_audio: Option<Uuid>,
}
impl CaptureLease {
    pub fn video_codec(&self) -> Result<crate::capture::VideoCodec> {
        self.codec
            .get()
            .copied()
            .context("capture has no admitted video codec")
    }
    pub fn microphone_state(&self) -> Option<watch::Receiver<SourceMicrophoneSettings>> {
        #[cfg(feature = "capture")]
        if let Some(CaptureLeaseControl::Capture(control)) = &self.control {
            return Some(control.microphone_state());
        }
        None
    }
    pub fn configure_microphone(
        &self,
        settings: SourceMicrophoneSettings,
    ) -> Result<impl std::future::Future<Output = Result<()>> + Send + 'static> {
        settings.validate()?;
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        #[cfg(feature = "capture")]
        let control = match self.control.as_ref() {
            Some(CaptureLeaseControl::Capture(control)) => control.clone(),
            _ => anyhow::bail!("capture_unavailable"),
        };
        Ok(async move {
            #[cfg(feature = "capture")]
            return control.configure_microphone(settings).await;
            #[cfg(not(feature = "capture"))]
            anyhow::bail!("capture_unavailable")
        })
    }
    pub fn cancel_microphone(
        &self,
    ) -> Result<impl std::future::Future<Output = Result<()>> + Send + 'static> {
        #[cfg(feature = "capture")]
        let control = match self.control.as_ref() {
            Some(CaptureLeaseControl::Capture(control)) => control.clone(),
            _ => anyhow::bail!("capture_unavailable"),
        };
        Ok(async move {
            #[cfg(feature = "capture")]
            return control.cancel_microphone().await;
            #[cfg(not(feature = "capture"))]
            anyhow::bail!("capture_unavailable")
        })
    }
    pub fn configure_video(
        &self,
        settings: crate::capture::Settings,
    ) -> Result<impl std::future::Future<Output = Result<()>> + Send + 'static> {
        settings.validate()?;
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        #[cfg(feature = "capture")]
        let control = match self.control.as_ref() {
            Some(CaptureLeaseControl::Capture(control)) => control.clone(),
            _ => anyhow::bail!("capture_unavailable"),
        };
        Ok(async move {
            #[cfg(feature = "capture")]
            return control.configure_video(settings).await;
            #[cfg(not(feature = "capture"))]
            anyhow::bail!("capture_unavailable")
        })
    }
    pub fn configure_audio(&self, settings: SourceAudioSettings) -> Result<()> {
        settings.validate()?;
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        #[cfg(feature = "capture")]
        match self.control.as_ref() {
            Some(CaptureLeaseControl::Capture(control)) => control.set_audio_settings(settings),
            Some(CaptureLeaseControl::Audio(control)) => control.set_audio_settings(settings),
            None => anyhow::bail!("capture_unavailable"),
        }
        #[cfg(not(feature = "capture"))]
        anyhow::bail!("capture_unavailable");
        #[cfg(feature = "capture")]
        Ok(())
    }

    pub fn producer_id(&self) -> Uuid {
        self.producer
    }
    pub fn set_input_policy(
        &self,
        mode: crate::input::Mode,
        password: Option<String>,
        simultaneous: Option<bool>,
    ) -> Result<impl std::future::Future<Output = Result<()>> + Send + 'static> {
        let source = self.remote.as_ref().context("input_source_unavailable")?;
        #[cfg(all(feature = "capture", target_os = "linux"))]
        let (control, selected) = (
            match self.control.as_ref() {
                Some(CaptureLeaseControl::Capture(control)) => control.clone(),
                _ => anyhow::bail!("input_source_unavailable"),
            },
            source.clone(),
        );
        source.configure(mode, password, simultaneous, move |request| async move {
            #[cfg(all(feature = "capture", target_os = "linux"))]
            return control.authorize(selected, request).await;
            #[cfg(not(all(feature = "capture", target_os = "linux")))]
            {
                let _ = request;
                Ok(())
            }
        })
    }

    /// First encoded access unit, independent of any viewer's connection.
    pub async fn ready(&mut self) -> Result<()> {
        (&mut self.ready)
            .await
            .context("capture stopped before its first frame")??;
        if let Some(audio) = self.required_audio.take() {
            audio
                .await
                .context("excluded audio stopped before startup")??;
        }
        Ok(())
    }
    pub fn is_stopped(&self) -> bool {
        #[cfg(feature = "capture")]
        {
            match self.control.as_ref() {
                Some(CaptureLeaseControl::Capture(control)) => control.is_stopped(),
                Some(CaptureLeaseControl::Audio(control)) => control.is_stopped(),
                None => true,
            }
        }
        #[cfg(not(feature = "capture"))]
        {
            true
        }
    }
    pub fn stop(&self) {
        if let Some(source) = &self.remote {
            source.close();
        }
        #[cfg(feature = "capture")]
        match self.control.as_ref() {
            Some(CaptureLeaseControl::Capture(control)) => control.stop(),
            Some(CaptureLeaseControl::Audio(control)) => control.stop(),
            None => {}
        }
    }
    /// Transfer the retained producer's lifetime; dropping the old page lease
    /// must not stop its video or revoke its unchanged input source.
    pub fn adopt_previous(&mut self, previous: &mut Self) {
        if self.producer == previous.producer {
            #[cfg(feature = "capture")]
            {
                self.control = previous.control.take();
            }
            self.remote = previous.remote.take();
            self.input_state = previous.input_state.take();
        }
    }
    pub fn retains_video(&self) -> bool {
        #[cfg(feature = "capture")]
        {
            matches!(self.control, Some(CaptureLeaseControl::Audio(_)))
        }
        #[cfg(not(feature = "capture"))]
        {
            false
        }
    }
}
impl Drop for CaptureLease {
    fn drop(&mut self) {
        self.stop();
    }
}
enum Input {
    Registrations(Vec<piik_channel_core::input::InputRegistration>),
    Update(
        Vec<PairInfo>,
        Vec<PublicationInfo>,
        Vec<FilePlan>,
        oneshot::Sender<Result<()>>,
    ),
    Signal(Uuid, Signal, oneshot::Sender<Result<()>>),
    Resync(oneshot::Sender<Result<()>>),
    Captures(oneshot::Sender<Vec<Uuid>>),
    #[cfg(feature = "capture")]
    PrepareCapture(
        CaptureScope,
        Option<Uuid>,
        crate::capture::Target,
        crate::capture::Settings,
        crate::capture::VideoCodecMode,
        bool,
        Option<crate::capture::Target>,
        oneshot::Sender<Result<CaptureLease>>,
    ),
    CommitCapture(Uuid, oneshot::Sender<Result<CaptureInput>>),
    CaptureCurrent(Uuid, bool, oneshot::Sender<bool>),
}
pub(crate) enum Event {
    InputMessage(Uuid, Uuid, piik_channel_core::input::InputFrame),
    InputClosed(Uuid, Uuid),
    Negotiate(Uuid),
    Candidate(Uuid, IceCandidate),
    State(Uuid, PeerState),
    Track(Uuid, Track),
    Channel(Uuid, Arc<Channel>),
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
    #[cfg(feature = "capture")]
    CaptureEnded {
        publication_id: Uuid,
        source: Uuid,
    },
    #[cfg(feature = "capture")]
    CaptureAudioEnded {
        publication_id: Uuid,
        source: Uuid,
    },
    #[cfg(feature = "capture")]
    EncodingFailed {
        publication_id: Uuid,
        source: Uuid,
        video: crate::media::video::Video,
        retired_supply: Option<crate::media::video::Layers>,
    },
    DataWriteFailed {
        pair: Uuid,
        lane: Lane,
        token: Uuid,
        temporary: bool,
    },
}
pub(crate) struct SourceReady {
    pub source: Source,
    pub media: InitialMedia,
}
pub(crate) enum InitialMedia {
    Rtp(Vec<rtp::Packet>),
    Video(crate::EncodedFrame),
}
struct Pair {
    plan: PairInfo,
    pc: Transport,
    mapping: Option<mapping::Mapping>,
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
    reports: OutputStreams,
    bandwidth: watch::Receiver<transport::Estimate>,
    demand: watch::Sender<Option<u64>>,
    tasks: HashMap<Uuid, Reader>,
    dc: Option<(Uuid, Arc<Channel>, JoinHandle<()>)>,
    bulk: Option<(Uuid, Arc<Channel>, JoinHandle<()>)>,
    input: Option<(Uuid, Arc<Channel>, JoinHandle<()>)>,
    data: DataLink,
    state: Arc<AtomicU8>,
    dc_open: bool,
    base_failed: bool,
    reported: HashSet<String>,
    deadline: Option<Deadline>,
    overflow: Arc<AtomicBool>,
}
#[derive(Clone, Copy)]
enum Deadline {
    Connecting(Instant),
    Control(Instant),
}
impl Deadline {
    fn expires(self) -> Instant {
        match self {
            Self::Connecting(at) | Self::Control(at) => at,
        }
    }
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
    input: Option<Uuid>,
}

impl Pair {
    fn connected(&self) -> bool {
        self.state.load(Ordering::Acquire) == PeerState::Connected as u8
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
            input: self.input.as_ref().map(|(token, _, _)| *token),
        }
    }

    async fn stable(&self) -> bool {
        self.pc.stable().await
    }
    async fn confirm_outputs(&mut self, offered: HashSet<Uuid>) -> Result<()> {
        let mut stable = HashSet::new();
        for output in self
            .outputs
            .values()
            .filter(|out| offered.contains(&out.id))
        {
            let Some(codec) = self.pc.confirm(output.id).await? else {
                continue;
            };
            if codec.is_some() {
                stable.insert(output.id);
            }
            output.confirm(codec)?;
        }
        self.stable_outputs = Some(stable);
        Ok(())
    }
}
struct Driver {
    transport: transport::Runtime,
    session: Uuid,
    ice: Vec<IceServer>,
    server_udp: Option<Arc<server_udp::ServerUdp>>,
    commands: mpsc::Sender<NativeEvent>,
    links: Arc<Mutex<HashMap<Uuid, (Uuid, data::Senders)>>>,
    cancel: watch::Receiver<bool>,
    events: mpsc::Sender<Event>,
    ready_sources: mpsc::Sender<SourceReady>,
    bandwidth_changed: Arc<Notify>,
    pairs: HashMap<Uuid, Pair>,
    preparings: HashMap<Uuid, preparation::Pending>,
    publications: HashMap<Uuid, PublicationInfo>,
    sources: HashMap<Uuid, Source>,
    #[cfg(feature = "capture")]
    captures: HashMap<Uuid, Capture>,
    #[cfg(feature = "capture")]
    snapshot: watch::Receiver<Option<Snapshot>>,
    #[cfg(all(
        feature = "capture",
        any(target_os = "windows", target_os = "linux", target_os = "macos")
    ))]
    derived: HashMap<Uuid, crate::media::derived::Producer>,
    relay: Relay,
    files: Files,
    inputs: input::Inputs,
}
pub(crate) async fn can_prepare_udp() -> bool {
    preparation::local_ipv4().await.is_some()
}
impl NativePeers {
    pub fn new(
        session_id: Uuid,
        ice_servers: Vec<IceServer>,
        commands: mpsc::Sender<NativeEvent>,
    ) -> Self {
        Self::with_input(
            session_id,
            ice_servers,
            commands,
            watch::channel(None).1,
            None,
            None,
        )
    }
    pub fn with_input(
        session_id: Uuid,
        ice_servers: Vec<IceServer>,
        commands: mpsc::Sender<NativeEvent>,
        snapshot: watch::Receiver<Option<Snapshot>>,
        desktop: Option<crate::input::Desktop>,
        server_udp: Option<Arc<server_udp::ServerUdp>>,
    ) -> Self {
        // Callback events are control-only. They must never await the PC driver that
        // invokes them. RTP has a separate bounded queue and separate poll tasks.
        let (cancel, mut cancelled) = watch::channel(false);
        let (input, mut inputs) = mpsc::channel(64);
        let (events, mut event_rx) = mpsc::channel(1024);
        let (ready_sources, mut ready_rx) = mpsc::channel(256);
        let links = Arc::new(Mutex::new(HashMap::new()));
        let driver_links = links.clone();
        let bandwidth_changed = Arc::new(Notify::new());
        let task = tokio::spawn(async move {
            let transport = transport::Runtime::new(server_udp.clone());
            let mut d = Driver {
                transport,
                session: session_id,
                ice: ice_servers,
                server_udp,
                commands,
                links: driver_links,
                cancel: cancelled.clone(),
                events,
                ready_sources,
                bandwidth_changed: bandwidth_changed.clone(),
                pairs: HashMap::new(),
                preparings: HashMap::new(),
                publications: HashMap::new(),
                sources: HashMap::new(),
                #[cfg(feature = "capture")]
                captures: HashMap::new(),
                #[cfg(all(
                    feature = "capture",
                    any(target_os = "windows", target_os = "linux", target_os = "macos")
                ))]
                derived: HashMap::new(),
                #[cfg(feature = "capture")]
                snapshot: snapshot.clone(),
                relay: Relay::default(),
                files: Files::new(session_id),
                inputs: input::Inputs::new(session_id, snapshot, desktop),
            };
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            enum Turn {
                Input(Input),
                Reply(Uuid, crate::input::Reply),
                Event(Event),
                SourceReady(SourceReady),
                Prepared(
                    Option<preparation::Pending>,
                    std::result::Result<Result<preparation::Prepared>, tokio::task::JoinError>,
                ),
                Bandwidth,
                Tick,
            }
            loop {
                let turn = tokio::select! {
                    _=cancelled.changed()=>break,
                    request=inputs.recv()=>match request {Some(request)=>Turn::Input(request),None=>break},
                    Some(event)=event_rx.recv()=>Turn::Event(event),
                    Some(source)=ready_rx.recv()=>Turn::SourceReady(source),
                    Some((id, result))=preparation::next(&mut d.preparings)=>Turn::Prepared(d.preparings.remove(&id), result),
                    Some((video,reply))=d.inputs.replies.next()=>Turn::Reply(video,reply),
                    _=bandwidth_changed.notified()=>Turn::Bandwidth,
                    _=tick.tick()=>Turn::Tick,
                };
                let refresh_keyframes = matches!(turn, Turn::Tick);
                let work = async {
                    #[cfg(feature = "capture")]
                    for capture in d.captures.values() {
                        // Input authority ends with capture, before its workers
                        // finish joining and before this turn can execute input.
                        if capture.selected && capture.producer.control.is_stopped() {
                            d.inputs.end_source(capture.scope.publication_id);
                        }
                    }
                    match turn {
                        Turn::Reply(video, reply) => {
                            if let Some(outgoing) = d.inputs.reply(video, reply) {
                                d.send_input(outgoing).await;
                            }
                        }
                        Turn::Input(Input::Registrations(registrations)) => {
                            for outgoing in d.inputs.registrations(registrations) {
                                d.send_input(outgoing).await;
                            }
                        }
                        Turn::Input(Input::Update(plans, info, files, done)) => {
                            let result = d.update(plans, info, files).await;
                            let _ = done.send(result);
                        }
                        Turn::Input(Input::Resync(done)) => {
                            d.resync().await;
                            let _ = done.send(Ok(()));
                        }
                        Turn::Input(Input::Captures(done)) => {
                            #[cfg(feature = "capture")]
                            let publications = d
                                .captures
                                .iter()
                                .filter(|(_, c)| !c.producer.control.is_stopped())
                                .map(|(_, c)| c.scope.publication_id)
                                .collect();
                            #[cfg(not(feature = "capture"))]
                            let publications = vec![];
                            let _ = done.send(publications);
                        }
                        #[cfg(feature = "capture")]
                        Turn::Input(Input::PrepareCapture(
                            scope,
                            replaces,
                            target,
                            settings,
                            mode,
                            audio,
                            exclude_audio,
                            done,
                        )) => {
                            let _ = done.send(
                                d.prepare_capture(
                                    scope,
                                    replaces,
                                    target,
                                    settings,
                                    mode,
                                    audio,
                                    exclude_audio,
                                )
                                .await,
                            );
                        }
                        Turn::Input(Input::CommitCapture(id, done)) => {
                            let _ = done.send(d.commit_capture(id).await);
                        }
                        Turn::Input(Input::CaptureCurrent(id, selected, done)) => {
                            let _ = done.send(d.capture_current(id, selected));
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
                                Event::InputMessage(..)
                                | Event::InputClosed(..)
                                | Event::DataWriteFailed {
                                    lane: Lane::Input, ..
                                } => None,
                                #[cfg(feature = "capture")]
                                Event::CaptureEnded { .. }
                                | Event::CaptureAudioEnded { .. }
                                | Event::EncodingFailed { .. } => None,
                                Event::OutputFailed { pair, .. } => Some(*pair),
                                Event::SourceEnded { pair, .. } => Some(*pair),
                                Event::DataWriteFailed { pair, .. } => Some(*pair),
                                Event::Negotiate(id)
                                | Event::Candidate(id, _)
                                | Event::State(id, _)
                                | Event::Track(id, _)
                                | Event::Channel(id, _)
                                | Event::Dc(id, _, _)
                                | Event::Bulk(id, _) => Some(*id),
                            };
                            if let Err(error) = d.event(event).await {
                                eprintln!("Native pair event failed: {error}");
                                if let Some(id) = id.filter(|id| d.pairs.contains_key(id)) {
                                    d.fail(id).await;
                                }
                            }
                        }
                        Turn::Prepared(pending, result) => {
                            if let Some(pending) = pending {
                                d.prepared(pending, result).await;
                            }
                        }
                        Turn::SourceReady(source) => {
                            if let Err(error) = d.source_ready(source).await {
                                eprintln!("Native encoded track attach failed: {error}");
                            }
                        }
                        Turn::Tick | Turn::Bandwidth => {
                            d.deadlines().await;
                            if let Err(error) = d.refresh_media(false).await {
                                eprintln!("Native media admission failed: {error}");
                            }
                        }
                    }
                    d.reconcile_encodings().await;
                    #[cfg(feature = "capture")]
                    d.cancelled_audio().await;
                    if refresh_keyframes {
                        d.request_pending_keyframes();
                    }
                };
                tokio::select! {_=cancelled.changed()=>break,_=work=>{}}
            }
            d.inputs.close();
            for (_, pending) in d.preparings.drain() {
                pending.close().await;
            }
            #[cfg(feature = "capture")]
            {
                #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
                for (_, producer) in d.derived.drain() {
                    producer.stop().await;
                }
                for capture in d.captures.values() {
                    capture.producer.control.stop();
                }
                for (_, mut capture) in d.captures.drain() {
                    capture.producer.close().await;
                }
            }
            for (_, pair) in d.pairs.drain() {
                close_pair(pair).await;
            }
            d.files.close().await;
            d.transport.close().await;
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
                let bytes = piik_channel_core::conversation::encode_control(
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
    pub async fn input_registrations(
        &self,
        registrations: Vec<piik_channel_core::input::InputRegistration>,
    ) -> Result<()> {
        self.input.send(Input::Registrations(registrations)).await?;
        Ok(())
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
    pub async fn prepare_capture(
        &self,
        scope: CaptureScope,
        replaces: Option<Uuid>,
        target: crate::capture::Target,
        settings: crate::capture::Settings,
        mode: crate::capture::VideoCodecMode,
        audio: bool,
        exclude_audio: Option<crate::capture::Target>,
    ) -> Result<CaptureLease> {
        #[cfg(feature = "capture")]
        {
            let (tx, rx) = oneshot::channel();
            self.input
                .send(Input::PrepareCapture(
                    scope,
                    replaces,
                    target,
                    settings,
                    mode,
                    audio,
                    exclude_audio,
                    tx,
                ))
                .await?;
            rx.await?
        }
        #[cfg(not(feature = "capture"))]
        {
            let _ = (
                scope,
                replaces,
                target,
                settings,
                mode,
                audio,
                exclude_audio,
            );
            anyhow::bail!("capture_unavailable")
        }
    }
    pub async fn commit_capture(&self, id: Uuid) -> Result<CaptureInput> {
        let (tx, rx) = oneshot::channel();
        self.input.send(Input::CommitCapture(id, tx)).await?;
        rx.await?
    }
    pub async fn capture_current(&self, id: Uuid, selected: bool) -> Result<bool> {
        let (tx, rx) = oneshot::channel();
        self.input
            .send(Input::CaptureCurrent(id, selected, tx))
            .await?;
        Ok(rx.await?)
    }
    pub async fn capture_publications(&self) -> Result<Vec<Uuid>> {
        let (tx, rx) = oneshot::channel();
        self.input.send(Input::Captures(tx)).await?;
        Ok(rx.await?)
    }
    pub async fn close(self) -> Result<()> {
        let _ = self.cancel.send(true);
        self.task.await?;
        Ok(())
    }
}
pub(crate) fn codec() -> RtpCodec {
    RtpCodec {
        mime_type: "audio/opus".into(),
        clock_rate: 48000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=510000".into(),
    }
}

impl Driver {
    fn request_pending_keyframes(&self) {
        // A PLI is best effort. Keep the existing request watch live while an
        // active consumer still awaits refresh; adoption/cancellation ends it.
        for source in self.sources.values() {
            if !matches!(source.origin, SourceOrigin::Incoming { .. }) {
                continue;
            }
            if let Some(layers) = &source.layers {
                for (_, video) in layers.snapshot() {
                    if let Some(video) = video {
                        video.request_pending_keyframe();
                    }
                }
            } else if let Some(video) = source.video() {
                video.request_pending_keyframe();
            }
        }
    }
    async fn send_input(&mut self, outgoing: input::Outgoing) {
        let mut pending = std::collections::VecDeque::from([outgoing]);
        while let Some(outgoing) = pending.pop_front() {
            let Some(pair) = self
                .pairs
                .get(&outgoing.pair)
                .filter(|p| p.plan.peer_id == outgoing.peer && p.connected())
            else {
                continue;
            };
            let Some((token, _, _)) = &pair.input else {
                continue;
            };
            let token = *token;
            let senders = pair.data.senders();
            if senders.current(Lane::Input, token, true)
                && senders.input.try_send(outgoing.message).is_err()
            {
                pending.extend(self.close_input(outgoing.pair, token).await);
            }
        }
    }

    async fn close_input(&mut self, id: Uuid, token: Uuid) -> Vec<input::Outgoing> {
        let Some(pair) = self.pairs.get_mut(&id) else {
            return vec![];
        };
        if !pair
            .input
            .as_ref()
            .is_some_and(|(current, _, _)| *current == token)
        {
            return vec![];
        }
        let messages = self.inputs.disconnected(id);
        pair.data.unbind(Lane::Input);
        if let Some((_, channel, task)) = pair.input.take() {
            task.abort();
            let _ = task.await;
            let _ = channel.close().await;
        }
        messages
    }

    async fn output_failed(&mut self, pair: Uuid, key: TrackKey, source: Uuid, output: Uuid) {
        let Some(p) = self.pairs.get_mut(&pair) else {
            return;
        };
        if !p
            .outputs
            .get(&key)
            .is_some_and(|current| current.source == source && current.id == output)
        {
            return;
        }
        let binding = p
            .plan
            .outgoing
            .iter()
            .find(|flow| flow.id == key.0)
            .copied();
        p.rejected_outputs.insert(key, source);
        p.outputs.remove(&key).unwrap().close(&p.pc).await;
        if binding.is_some_and(|flow| {
            !flow.selected
                || key.1 == MediaKind::Video
                || self
                    .publications
                    .get(&flow.publication_id)
                    .is_some_and(|p| p.kind == piik_channel_core::wire::Kind::Voice)
        }) {
            self.fail_flow(pair, key.0).await;
        }
    }

    async fn fail_flow(&mut self, pair: Uuid, flow: Uuid) {
        let p = self.pairs.get_mut(&pair).unwrap();
        if p.plan
            .outgoing
            .iter()
            .any(|binding| binding.id == flow && !binding.selected)
        {
            let keys: Vec<_> = p
                .outputs
                .keys()
                .filter(|key| key.0 == flow)
                .copied()
                .collect();
            for key in keys {
                let output = p.outputs.remove(&key).unwrap();
                p.rejected_outputs.insert(key, output.source);
                output.close(&p.pc).await;
            }
        }
        self.send(Command::FlowState {
            flow_id: flow,
            pair_id: pair,
            state: FlowState::Failed,
        })
        .await;
    }

    #[cfg(feature = "capture")]
    async fn prepare_capture(
        &mut self,
        scope: CaptureScope,
        replaces: Option<Uuid>,
        target: crate::capture::Target,
        settings: crate::capture::Settings,
        mode: crate::capture::VideoCodecMode,
        audio: bool,
        exclude_audio: Option<crate::capture::Target>,
    ) -> Result<CaptureLease> {
        let publication = scope.publication_id;
        self.cancelled_audio().await;
        anyhow::ensure!(
            !self
                .captures
                .values()
                .any(|capture| capture.scope.room_id == scope.room_id
                    && capture.scope.publication_id != publication
                    && !capture.producer.control.is_stopped()),
            "source_already_published"
        );
        let existing = self
            .captures
            .iter()
            .find(|(_, c)| {
                c.scope.publication_id == publication
                    && c.selected
                    && !c.producer.control.is_stopped()
            })
            .map(|(id, _)| *id);
        anyhow::ensure!(existing == replaces, "capture_not_owned");
        anyhow::ensure!(
            exclude_audio
                .as_ref()
                .is_none_or(|excluded| cfg!(target_os = "windows")
                    && audio
                    && target.kind == crate::capture::TargetKind::Display
                    && excluded.kind == crate::capture::TargetKind::Window),
            "audio exclusion unavailable"
        );
        anyhow::ensure!(
            !self
                .captures
                .values()
                .any(|c| c.scope.publication_id == publication
                    && (!c.selected || c.pending_audio.is_some())
                    && !c.producer.control.is_stopped()),
            "capture_pending"
        );
        #[cfg(target_os = "windows")]
        if let Some(video) = self
            .captures
            .iter()
            .find(|(_, capture)| {
                capture.scope.publication_id == publication
                    && capture.selected
                    && capture.target.same_source(&target)
                    && capture.producer.settings() == settings
                    && capture.producer.control.codec.get().is_some_and(|codec| {
                        mode == crate::capture::VideoCodecMode::Auto || *codec == mode.initial()
                    })
            })
            .map(|(id, _)| *id)
        {
            let capture = self.captures.get_mut(&video).unwrap();
            let (control, ready, audio_error) = capture
                .producer
                .prepare_audio(target, audio, exclude_audio)
                .await?;
            let id = Uuid::new_v4();
            capture.pending_audio = Some(id);
            return Ok(CaptureLease {
                id,
                session_id: self.session,
                scope,
                ready,
                codec: capture.producer.control.codec.clone(),
                required_audio: None,
                audio_error,
                remote: None,
                input_state: None,
                producer: video,
                control: Some(CaptureLeaseControl::Audio(control)),
            });
        }
        if exclude_audio.is_some() {
            for capture in self
                .captures
                .values_mut()
                .filter(|capture| capture.selected && capture.scope.publication_id == publication)
            {
                capture.producer.stop_system_audio().await;
            }
            self.refresh_media(false).await?;
        }
        let (producer, ready, audio_error, required_audio) = crate::media::local::Producer::start(
            publication,
            target.clone(),
            settings,
            mode,
            audio,
            exclude_audio,
            self.ready_sources.clone(),
            self.events.clone(),
            self.relay.clone(),
            self.cancel.clone(),
            self.bandwidth_changed.clone(),
        )
        .await?;
        let id = producer.video;
        let lease = CaptureLease {
            id,
            session_id: self.session,
            scope: scope.clone(),
            ready,
            codec: producer.control.codec.clone(),
            required_audio,
            audio_error,
            remote: None,
            input_state: None,
            control: Some(CaptureLeaseControl::Capture(producer.control.clone())),
            producer: id,
        };
        self.captures.insert(
            id,
            Capture {
                scope,
                target,
                producer,
                selected: false,
                prepared: Vec::new(),
                pending_audio: None,
            },
        );
        Ok(lease)
    }

    fn capture_current(&self, id: Uuid, selected: bool) -> bool {
        #[cfg(feature = "capture")]
        return self.captures.iter().any(|(video, c)| {
            !c.producer.control.is_stopped()
                && ((*video == id && c.selected == selected)
                    || (!selected && c.pending_audio == Some(id) && !c.producer.audio_is_stopped()))
        });
        #[cfg(not(feature = "capture"))]
        {
            let _ = (id, selected);
            false
        }
    }

    async fn commit_capture(&mut self, id: Uuid) -> Result<CaptureInput> {
        #[cfg(not(feature = "capture"))]
        {
            let _ = id;
            anyhow::bail!("capture_unavailable");
        }
        #[cfg(feature = "capture")]
        {
            anyhow::ensure!(self.capture_current(id, false), "capture_unavailable");
            if let Some(video) = self
                .captures
                .iter()
                .find(|(_, capture)| capture.pending_audio == Some(id))
                .map(|(video, _)| *video)
            {
                let capture = self.captures.get_mut(&video).unwrap();
                capture.pending_audio = None;
                let prepared = std::mem::take(&mut capture.prepared);
                for source in prepared {
                    self.source_ready(source).await?;
                }
                return Ok(CaptureInput {
                    remote: None,
                    state: None,
                });
            }
            let capture = &self.captures[&id];
            let publication = capture.scope.publication_id;
            anyhow::ensure!(
                self.publications
                    .get(&publication)
                    .is_some_and(|p| p.session_id == self.session),
                "publication_not_owned"
            );
            let target = capture.target.clone();
            self.inputs.end_source(publication);
            for (old, capture) in &mut self.captures {
                if *old != id && capture.scope.publication_id == publication && capture.selected {
                    capture.selected = false;
                    capture.producer.control.stop();
                    self.sources.remove(old);
                    self.relay.remove(*old);
                    if let Some(audio) = capture.producer.audio() {
                        self.sources.remove(&audio);
                        self.relay.remove(audio);
                    }
                }
            }
            let capture = self.captures.get_mut(&id).unwrap();
            capture.selected = true;
            let prepared = std::mem::take(&mut capture.prepared);
            let input = self
                .inputs
                .source(publication, id, target)
                .unwrap_or_else(|error| {
                    eprintln!("Native input unavailable: {error}");
                    None
                });
            for source in prepared {
                if let Err(error) = self.source_ready(source).await {
                    eprintln!("Native replacement media unavailable: {error}");
                }
            }
            Ok(match input {
                Some((remote, state)) => CaptureInput {
                    remote: Some(remote),
                    state: Some(state),
                },
                None => CaptureInput {
                    remote: None,
                    state: None,
                },
            })
        }
    }

    #[cfg(feature = "capture")]
    async fn capture_ended(&mut self, publication: Uuid, source_id: Uuid) -> Result<()> {
        let Some(capture) = self.captures.get_mut(&source_id) else {
            return Ok(());
        };
        if capture.selected {
            self.inputs.end_source(publication);
        }
        let audio = capture.producer.audio();
        let error = capture.producer.close().await;
        self.captures.remove(&source_id);
        self.sources.remove(&source_id);
        self.relay.remove(source_id);
        if let Some(audio) = audio {
            self.sources.remove(&audio);
            self.relay.remove(audio);
        }
        self.refresh_media(false).await?;
        // Android can stop the incumbent when a new projection is authorized.
        // Its prepared replacement still owns the publication until commit/cancel.
        if self
            .captures
            .values()
            .any(|c| c.scope.publication_id == publication && !c.producer.control.is_stopped())
        {
            return Ok(());
        }
        let event = NativeEvent::CaptureEnded {
            publication_id: publication,
            error,
        };
        let mut cancelled = self.cancel.clone();
        tokio::select! { _ = cancelled.changed() => {}, _ = self.commands.send(event) => {} }
        Ok(())
    }

    #[cfg(feature = "capture")]
    async fn capture_audio_ended(&mut self, publication: Uuid, source: Uuid) -> Result<()> {
        for capture in self
            .captures
            .values_mut()
            .filter(|c| c.scope.publication_id == publication)
        {
            capture.prepared.retain(|ready| ready.source.id != source);
        }
        self.sources.remove(&source);
        self.relay.remove(source);
        self.refresh_media(false).await
    }

    #[cfg(feature = "capture")]
    async fn cancelled_audio(&mut self) {
        for capture in self
            .captures
            .values_mut()
            .filter(|capture| capture.producer.audio_is_stopped())
        {
            capture.pending_audio = None;
            capture.producer.stop_system_audio().await;
        }
    }

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
        self.inputs.reconcile();
        self.files.update(files, &plans).await;
        self.publications = publications.into_iter().map(|p| (p.id, p)).collect();
        let needed: HashSet<_> = plans
            .iter()
            .flat_map(|plan| plan.incoming.iter().map(|flow| flow.id))
            .collect();
        self.sources.retain(|_, source| {
            self.publications.contains_key(&source.publication_id)
                && match source.origin {
                    SourceOrigin::Incoming { flow_id, .. } => needed.contains(&flow_id),
                    #[cfg(any(feature = "capture", test))]
                    SourceOrigin::Local => {
                        self.publications[&source.publication_id].session_id == self.session
                    }
                }
        });
        #[cfg(feature = "capture")]
        for capture in self.captures.values() {
            let authority = self.snapshot.borrow();
            let admitted = authority.as_ref().is_some_and(|state| {
                state.channel.rooms.iter().any(|room| {
                    room.id == capture.scope.room_id
                        && room.authorized
                        && room.available
                        && room
                            .delivery
                            .as_ref()
                            .is_some_and(|delivery| delivery.binding_id == capture.scope.binding_id)
                })
            });
            if !admitted
                || (capture.selected
                    && !self
                        .publications
                        .get(&capture.scope.publication_id)
                        .is_some_and(|p| p.session_id == self.session))
            {
                capture.producer.control.stop();
            }
        }
        self.relay.retain(&self.sources.keys().copied().collect());
        let retained: HashSet<_> = plans.iter().map(|p| p.id).collect();
        let removed: Vec<_> = self
            .pairs
            .keys()
            .chain(self.preparings.keys())
            .filter(|id| !retained.contains(id))
            .copied()
            .collect();
        let mut released = false;
        for id in removed {
            released |= self.retire_pair(id).await;
        }
        for plan in plans {
            let id = plan.id;
            let result = async {
                if !self.pairs.contains_key(&id)
                    && plan.udp_preparation == Some(UdpPreparation::Required)
                {
                    if let Some(pending) = self.preparings.get_mut(&id) {
                        pending.plan = plan;
                    } else {
                        let ice = self
                            .ice
                            .iter()
                            .map(|server| serde_json::json!({"urls": server.urls}))
                            .collect::<Vec<_>>();
                        let servers = piik_channel_core::udp::stun_servers(&ice)
                            .ok_or_else(|| anyhow!("UDP preparation destinations unavailable"))?;
                        self.preparings.insert(
                            id,
                            preparation::Pending::start(
                                self.session,
                                plan,
                                servers,
                                self.commands.clone(),
                            ),
                        );
                    }
                    return Ok(());
                }
                if let Some(pending) = self.preparings.remove(&id) {
                    pending.close().await;
                }
                if !self.pairs.contains_key(&id) {
                    self.create_pair(&plan, None).await?;
                }
                self.apply_pair(plan).await
            }
            .await;
            if let Err(error) = result {
                eprintln!("Native pair update failed: {error}");
                self.fail(id).await;
            }
        }
        self.refresh_media(released).await?;
        for id in self.pairs.keys().copied().collect::<Vec<_>>() {
            self.base_ready(id).await;
        }
        Ok(())
    }
    async fn create_pair(
        &mut self,
        plan: &PairInfo,
        prepared: Option<(std::net::UdpSocket, std::net::SocketAddrV4)>,
    ) -> Result<()> {
        let overflow = Arc::new(AtomicBool::new(false));
        let state = Arc::new(AtomicU8::new(PeerState::New as u8));
        let reports = OutputStreams::default();
        let (demand, requested) = watch::channel(Some(0));
        let candidates = prepared
            .as_ref()
            .map(|(_, remote)| prepared_candidate(*remote))
            .transpose()?
            .into_iter()
            .collect();
        let (pc, bandwidth) = Box::pin(self.transport.add(
            plan.id,
            prepared.map(|(socket, _)| socket),
            self.events.clone(),
            overflow.clone(),
            state.clone(),
            requested,
            self.bandwidth_changed.clone(),
            &self.ice,
        ))
        .await?;
        let data = DataLink::new(plan.id, state.clone(), self.events.clone());
        self.links
            .lock()
            .unwrap()
            .insert(plan.peer_id, (plan.id, data.senders()));
        self.pairs.insert(
            plan.id,
            Pair {
                polite: self.session > plan.peer_id,
                plan: plan.clone(),
                pc,
                mapping: None,
                pending_offer: None,
                stable_outputs: None,
                failed_offer: None,
                answer: None,
                negotiate: false,
                ignore_offer: false,
                candidates,
                remote: HashMap::new(),
                latest: HashMap::new(),
                outputs: HashMap::new(),
                rejected_outputs: HashMap::new(),
                reports,
                bandwidth,
                demand,
                tasks: HashMap::new(),
                dc: None,
                bulk: None,
                input: None,
                data,
                state,
                dc_open: false,
                base_failed: false,
                reported: HashSet::new(),
                deadline: Some(Deadline::Connecting(
                    Instant::now()
                        + Duration::from_secs(
                            if plan.udp_preparation == Some(UdpPreparation::Available) {
                                5
                            } else {
                                20
                            },
                        ),
                )),
                overflow,
            },
        );
        self.files
            .attach(plan.peer_id, self.pairs[&plan.id].data.senders())
            .await;
        Ok(())
    }
    async fn apply_pair(&mut self, plan: PairInfo) -> Result<()> {
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
            .chain(
                self.sources
                    .values()
                    .filter(
                        |s| matches!(s.origin, SourceOrigin::Incoming { pair, .. } if pair == id),
                    )
                    .map(|s| s.id),
            )
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
            let dc = p.pc.create_channel("piik-room").await?;
            self.install_dc(id, dc).await?;
        }
        let p = self.pairs.get(&id).unwrap();
        if !p.plan.rooms.is_empty() && !p.polite && !p.base_failed && p.bulk.is_none() {
            let dc = p.pc.create_channel("piik-file").await?;
            self.install_dc(id, dc).await?;
        }
        let p = self.pairs.get(&id).unwrap();
        if !p.polite && p.input.is_none() {
            let dc = p.pc.create_channel("piik-input").await?;
            self.install_dc(id, dc).await?;
        }
        Ok(())
    }
    async fn prepared(
        &mut self,
        pending: preparation::Pending,
        result: std::result::Result<Result<preparation::Prepared>, tokio::task::JoinError>,
    ) {
        let id = pending.plan.id;
        // next() consumed the completed JoinHandle; only unconsumed tasks are joined on retirement.
        let prepared = match result
            .context("UDP preparation task failed")
            .and_then(|result| result)
            .and_then(|prepared| prepared.commit(id))
        {
            Ok(prepared) => Some(prepared),
            Err(error) => {
                eprintln!("Native UDP preparation unavailable; continuing ordinary ICE: {error}");
                None
            }
        };
        let result = async {
            self.create_pair(&pending.plan, prepared).await?;
            self.apply_pair(pending.plan).await?;
            for signal in pending.signals {
                self.signal(id, signal).await?;
            }
            self.refresh_media(false).await?;
            self.base_ready(id).await;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("Native UDP preparation failed: {error}");
            self.fail(id).await;
        }
    }

    async fn local_signal(&self, id: Uuid, exchange: Uuid) -> Result<Signal> {
        let p = &self.pairs[&id];
        let (kind, sdp) = p.pc.local_description().await?;
        Ok(Signal {
            udp: None,
            description: Some(Description {
                kind,
                sdp: Some(sdp),
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
                    udp: None,
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
        let result = async { p.pc.offer().await }.await;
        if matches!(result, Ok(false)) {
            return Ok(());
        }
        self.finish_offer(id, stable, outputs, result.map(|_| ()))
            .await
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
                output.close(&p.pc).await;
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
                    let primary = if self.publications[&binding.publication_id].kind
                        == piik_channel_core::wire::Kind::Screen
                    {
                        MediaKind::Video
                    } else {
                        MediaKind::Audio
                    };
                    !binding.selected || !p.outputs.contains_key(&(*flow, primary))
                })
                .collect();
            p.failed_offer = Some(p.offer_work());
            eprintln!("Native local offer failed before signaling: {error}");
            for flow_id in failed {
                self.fail_flow(id, flow_id).await;
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
        if let Some(pending) = self.preparings.get_mut(&id) {
            return pending.signal(signal);
        }
        if signal.udp.is_some() {
            return Ok(());
        }
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
                p.pc.rollback().await?;
                p.pending_offer = None;
            }
            p.remote = signal
                .tracks
                .unwrap_or_default()
                .into_iter()
                .filter(|t| p.plan.incoming.iter().any(|flow| flow.id == t.flow_id))
                .map(|t| (t.stream_id, t.flow_id))
                .collect();
            p.pc.accept(description.kind, description.sdp.unwrap_or_default())
                .await?;
            for c in p.candidates.drain(..) {
                let _ = p.pc.add_candidate(c.candidate.unwrap_or_default()).await;
            }
            if offer {
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
            self.refresh_media(false).await?;
        } else if let Some(c) = signal.candidate {
            if !p.ignore_offer {
                if p.pc.remote_description().await {
                    let _ = p.pc.add_candidate(c.candidate.unwrap_or_default()).await;
                } else if p.candidates.len() < MAX_ICE_CANDIDATES {
                    p.candidates.push(c);
                }
            }
        }
        Ok(())
    }
    async fn install_dc(&mut self, id: Uuid, dc: Arc<Channel>) -> Result<()> {
        let p = self.pairs.get_mut(&id).unwrap();
        let label = dc.label.clone();
        let Some(lane) = Lane::from_label(&label) else {
            dc.close().await?;
            return Ok(());
        };
        if (lane != Lane::Input && p.plan.rooms.is_empty())
            || (lane == Lane::Control && p.dc.is_some())
            || (lane == Lane::Bulk && p.bulk.is_some())
            || (lane == Lane::Input && p.input.is_some())
        {
            dc.close().await?;
            return Ok(());
        }
        if !dc.config.ordered || dc.config.reliability != str0m::channel::Reliability::Reliable {
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
                    ChannelEvent::Open => {
                        if ready.set(true) && lane == Lane::Control {
                            let _ = events.send(Event::Dc(id, token, true)).await;
                        }
                    }
                    ChannelEvent::Message(message) => match lane {
                        Lane::Control => {
                            if !ready.open() {
                                continue;
                            }
                            match data::control(message.as_slice()) {
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
                        Lane::Bulk => files.chunk(peer, token, message.as_slice()).await,
                        Lane::Input => {
                            if !ready.open() || message.len() > 8192 {
                                continue;
                            }
                            if let Ok(frame) = serde_json::from_slice(message.as_slice()) {
                                if events
                                    .send(Event::InputMessage(id, token, frame))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    },
                    ChannelEvent::Close => {
                        if ready.set(false) {
                            if lane != Lane::Input {
                                files
                                    .closed(
                                        peer,
                                        lane,
                                        token,
                                        lane == Lane::Control || data::terminal(&state),
                                    )
                                    .await;
                            }
                            let event = if lane == Lane::Control {
                                Event::Dc(id, token, false)
                            } else if lane == Lane::Bulk {
                                Event::Bulk(id, token)
                            } else {
                                Event::InputClosed(id, token)
                            };
                            let _ = events.send(event).await;
                        }
                        break;
                    }
                }
            }
        });
        let value = Some((token, dc, task));
        if lane == Lane::Control {
            p.dc = value;
        } else if lane == Lane::Bulk {
            p.bulk = value;
        } else {
            p.input = value;
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
        } else if p.connected() && !matches!(p.deadline, Some(Deadline::Control(_))) {
            p.deadline = Some(Deadline::Control(Instant::now() + Duration::from_secs(20)));
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
    async fn retire_pair(&mut self, id: Uuid) -> bool {
        if let Some(pending) = self.preparings.remove(&id) {
            pending.close().await;
        }
        let Some(pair) = self.pairs.remove(&id) else {
            return false;
        };
        for message in self.inputs.disconnected(id) {
            self.send_input(message).await;
        }
        self.sources.retain(
            |_, source| !matches!(source.origin, SourceOrigin::Incoming { pair, .. } if pair == id),
        );
        self.relay.retain(&self.sources.keys().copied().collect());
        let released = !pair.outputs.is_empty();
        self.links.lock().unwrap().remove(&pair.plan.peer_id);
        self.files.detach(pair.plan.peer_id).await;
        close_pair(pair).await;
        released
    }
    async fn fail(&mut self, id: Uuid) {
        self.retire_pair(id).await;
        if let Err(error) = self.refresh_outputs().await {
            eprintln!("Native media retirement failed: {error}");
        }
        self.send(Command::LinkState {
            pair_id: id,
            state: LinkState::Failed,
        })
        .await;
    }
    async fn deadlines(&mut self) {
        // The callback's atomic connection fact can precede the queued State event.
        for id in self.pairs.keys().copied().collect::<Vec<_>>() {
            self.base_ready(id).await;
        }
        let expired: Vec<_> = self
            .pairs
            .iter()
            .filter(|(_, p)| {
                p.overflow.swap(false, Ordering::AcqRel)
                    || p.deadline.is_some_and(|d| Instant::now() >= d.expires())
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
        ended.extend(p.pc.ended_receivers().await?);
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
        if let Some(current) = self.sources.remove(&source) {
            let publication = current.publication_id;
            self.relay.remove(source);
            for p in self.pairs.values_mut() {
                let retired: Vec<_> = p
                    .outputs
                    .iter()
                    .filter(|(_, output)| output.source == source)
                    .map(|(key, _)| *key)
                    .collect();
                for key in retired {
                    p.outputs.remove(&key).unwrap().close(&p.pc).await;
                }
            }
            if assigned_latest.is_some_and(|flow| {
                !flow.selected
                    || key.1 == MediaKind::Video
                    || self
                        .publications
                        .get(&publication)
                        .is_some_and(|p| p.kind == piik_channel_core::wire::Kind::Voice)
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
            Event::InputMessage(id, token, frame) => {
                if let Some(p) = self
                    .pairs
                    .get(&id)
                    .filter(|p| p.connected() && p.data.senders().current(Lane::Input, token, true))
                {
                    if let Some(outgoing) = self.inputs.receive(p.plan.peer_id, frame) {
                        self.send_input(outgoing).await;
                    }
                }
            }
            Event::InputClosed(id, token) => {
                for message in self.close_input(id, token).await {
                    self.send_input(message).await;
                }
            }
            Event::DataWriteFailed {
                pair,
                lane,
                token,
                temporary,
            } => {
                if lane == Lane::Input {
                    for message in self.close_input(pair, token).await {
                        self.send_input(message).await;
                    }
                    return Ok(());
                }
                if let Some(p) = self.pairs.get(&pair) {
                    self.files
                        .receiver()
                        .closed(p.plan.peer_id, lane, token, temporary)
                        .await;
                }
            }
            Event::SourceEnded { pair, key, source } => self.source_ended(pair, key, source).await,
            #[cfg(feature = "capture")]
            Event::CaptureEnded {
                publication_id,
                source,
            } => self.capture_ended(publication_id, source).await?,
            #[cfg(feature = "capture")]
            Event::CaptureAudioEnded {
                publication_id,
                source,
            } => self.capture_audio_ended(publication_id, source).await?,
            #[cfg(feature = "capture")]
            Event::EncodingFailed {
                publication_id,
                source,
                video,
                retired_supply,
            } => {
                if self
                    .sources
                    .get(&source)
                    .filter(|current| current.publication_id == publication_id)
                    .is_some()
                {
                    let failed: Vec<_> = self
                        .pairs
                        .iter()
                        .flat_map(|(pair, p)| {
                            p.outputs.iter().filter_map(|(key, current)| {
                                (current.source == source
                                    && current.encoding_failed(&video, retired_supply.as_ref()))
                                .then_some((*pair, *key, current.id))
                            })
                        })
                        .collect();
                    for (pair, key, output) in failed {
                        self.output_failed(pair, key, source, output).await;
                    }
                }
            }
            Event::OutputFailed {
                pair,
                key,
                source,
                output,
            } => self.output_failed(pair, key, source, output).await,
            Event::Negotiate(id) => {
                if self.pairs.contains_key(&id) {
                    self.offer(id).await?;
                }
            }
            Event::Candidate(id, candidate) => {
                if let Some(p) = self.pairs.get_mut(&id) {
                    let mapped = if let Some(udp) = &self.server_udp {
                        udp.mapped_candidate(&candidate)?
                    } else {
                        None
                    };
                    if self.server_udp.is_none() {
                        if let Some(mapping) = &p.mapping {
                            mapping.observe(&candidate);
                        } else {
                            p.mapping =
                                mapping::Mapping::start(id, &candidate, self.events.clone());
                        }
                    }
                    for candidate in std::iter::once(candidate).chain(mapped) {
                        let candidate = signal_candidate(candidate);
                        self.send(Command::Signal {
                            pair_id: id,
                            payload: Signal {
                                udp: None,
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
            }
            Event::State(id, state) => {
                if state != PeerState::Connected {
                    for message in self.inputs.disconnected(id) {
                        self.send_input(message).await;
                    }
                }
                if self.pairs.contains_key(&id) {
                    if state == PeerState::Connected {
                        self.send(Command::LinkState {
                            pair_id: id,
                            state: LinkState::Connected,
                        })
                        .await;
                        self.base_ready(id).await;
                    } else if matches!(state, PeerState::Failed | PeerState::Closed) {
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
                        } else if data::terminal(&p.state) {
                            self.fail(id).await;
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
    async fn track(&mut self, id: Uuid, track: Track) -> Result<()> {
        let Some(p) = self.pairs.get_mut(&id) else {
            return Ok(());
        };
        let stream = track.stream.clone();
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
        let ssrc = track.first_ssrc;
        let codec = track.first_codec.rtp_codec.clone();
        let kind = track.kind;
        let track_id = track.id.clone();
        let rids = track.rids.clone();
        let layered = kind == MediaKind::Video && !rids.is_empty();
        if !supported(&codec, kind)
            || (kind == MediaKind::Video
                && self.publications[&publication].kind != piik_channel_core::wire::Kind::Screen)
        {
            if !binding.selected
                || (kind == MediaKind::Video
                    && self.publications[&publication].kind
                        == piik_channel_core::wire::Kind::Screen)
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
        let report: crate::media::SourceReport = track.report(ssrc);
        let mut source = Source {
            id: Uuid::new_v4(),
            publication_id: publication,
            origin: SourceOrigin::Incoming {
                pair: id,
                flow_id,
                stream,
            },
            codec,
            kind,
            feed: SourceFeed::Rtp {
                keyframes,
                report: report.clone(),
            },
            layers: layered.then(|| crate::media::video::Layers::new(rids)),
        };
        if let Some(previous) = p.latest.insert(key, source.id) {
            if !self.sources.contains_key(&previous) {
                if let Some(task) = p.tasks.remove(&previous) {
                    task.task.abort();
                    let _ = task.task.await;
                }
            }
        }
        let ready_sources = self.ready_sources.clone();
        let relay = self.relay.clone();
        let source_id = source.id;
        let events = self.events.clone();
        p.tasks.retain(|_, reader| !reader.task.is_finished());
        let task = tokio::spawn(async move {
            let mut first = true;
            let framed = crate::media::incoming::Incoming::supports(&source.codec.mime_type);
            struct Layer {
                rid: String,
                report: crate::media::SourceReport,
                input: Option<(crate::media::incoming::Incoming, watch::Receiver<u64>)>,
            }
            let mut layers: HashMap<u32, Layer> = HashMap::new();
            let mut time: Option<crate::media::clock::SourceTime> = None;
            let changed = Arc::new(Notify::new());
            'reading: loop {
                let event = tokio::select! {
                    event = track.poll() => match event {
                        Some(event) => event,
                        None => break,
                    },
                    result = requests.changed(), if kind == MediaKind::Video && !framed => {
                        if result.is_err() {
                            break;
                        }
                        let _ = track.request_keyframe(ssrc).await;
                        continue;
                    }
                    ssrc = async {
                        // Requests have their own durable watch version. The Video
                        // Notify belongs to encoder selection, not upstream RTCP.
                        let mut waiting: futures_util::stream::FuturesUnordered<_> = layers
                            .iter_mut()
                            .filter_map(|(ssrc, layer)| {
                                layer.input.as_mut().map(|(_, requests)| async move {
                                    requests.changed().await.ok().map(|_| *ssrc)
                                })
                            })
                            .collect();
                        while let Some(ssrc) = waiting.next().await {
                            if let Some(ssrc) = ssrc { return ssrc; }
                        }
                        std::future::pending::<u32>().await
                    }, if framed => {
                        let _ = track.request_keyframe(ssrc).await;
                        continue;
                    }
                };
                match event {
                    TrackEvent::Rtp(packet, sequence, media_time) => {
                        if framed {
                            let packet_ssrc = packet.header.ssrc;
                            if !layered && packet_ssrc != ssrc {
                                continue;
                            }
                            if !layers.contains_key(&packet_ssrc) {
                                let Some(codec) = track.codec(packet_ssrc) else {
                                    continue;
                                };
                                if !crate::media::compatible(&source.codec, &codec.rtp_codec) {
                                    continue;
                                }
                                let rid = track.rid(packet_ssrc).unwrap_or_default();
                                if layered && rid.is_empty() {
                                    continue;
                                }
                                // An SSRC successor replaces only its RID, not the source.
                                layers.retain(|_, layer| layer.rid != rid);
                                if let Some(group) = &source.layers {
                                    group.remove(&rid);
                                }
                                layers.insert(
                                    packet_ssrc,
                                    Layer {
                                        rid,
                                        report: track.report(packet_ssrc),
                                        input: None,
                                    },
                                );
                            }
                            let layer = layers.get_mut(&packet_ssrc).unwrap();
                            if layer.input.is_none() {
                                if packet.payload.is_empty() {
                                    continue;
                                }
                                let next_time = match &time {
                                    Some(root) => {
                                        let report = layer.report.lock().unwrap();
                                        report.as_ref().and_then(|(sr, _)| {
                                            root.incoming_layer(packet.header.timestamp, sr)
                                        })
                                    }
                                    None => track
                                        .presentation(packet.header.timestamp, packet_ssrc)
                                        .map(|at| {
                                            crate::media::clock::SourceTime::incoming(
                                                at,
                                                packet.header.timestamp,
                                                layer.report.clone(),
                                            )
                                        }),
                                };
                                let Some(next_time) = next_time else {
                                    continue;
                                };
                                let input = crate::media::incoming::Incoming::with_time(
                                    &source.codec.mime_type,
                                    next_time.clone(),
                                    changed.clone(),
                                );
                                let requests = input.video().requests();
                                if time.is_none() {
                                    time = Some(next_time);
                                }
                                input.video().request_keyframe();
                                layer.input = Some((input, requests));
                            }
                            let (input, _) = layer.input.as_mut().unwrap();
                            input.push(sequence, media_time, packet);
                            loop {
                                match input.pop() {
                                    Ok(Some(frame)) => {
                                        if frame.keyframe {
                                            if let Some(group) = &source.layers {
                                                group.insert(
                                                    layer.rid.clone(),
                                                    input.video().clone(),
                                                );
                                            }
                                        }
                                        if first {
                                            first = false;
                                            source.feed = SourceFeed::Video(input.video().clone());
                                            if ready_sources
                                                .send(SourceReady {
                                                    source: source.clone(),
                                                    media: InitialMedia::Video(frame),
                                                })
                                                .await
                                                .is_err()
                                            {
                                                break 'reading;
                                            }
                                        } else {
                                            input.video().write(frame);
                                        }
                                    }
                                    Ok(None) => break,
                                    Err(error) => {
                                        eprintln!("Native encoded input failed: {error}");
                                        break 'reading;
                                    }
                                }
                            }
                            continue;
                        }
                        if track.presentation(packet.header.timestamp, ssrc).is_none() {
                            continue;
                        }
                        if packet.header.ssrc != ssrc {
                            continue;
                        }
                        // Padding occupies the same sequence space, but cannot announce a source.
                        if packet.payload.is_empty() && (first || !packet.header.padding) {
                            continue;
                        }
                        if first {
                            first = false;
                            if ready_sources
                                .send(SourceReady {
                                    source: source.clone(),
                                    media: InitialMedia::Rtp(vec![packet]),
                                })
                                .await
                                .is_err()
                            {
                                break;
                            }
                        } else {
                            relay.write(source.id, packet);
                        }
                    }
                    TrackEvent::End => break,
                    TrackEvent::Report(packets) => {
                        for (received, at) in packets {
                            {
                                if framed {
                                    if let Some(layer) = layers.get(&received.ssrc) {
                                        *layer.report.lock().unwrap() =
                                            Some((received.clone(), at));
                                    }
                                } else if received.ssrc == ssrc {
                                    *report.lock().unwrap() = Some((received.clone(), at));
                                }
                            }
                        }
                        // A layer may miss its first keyframe while waiting for SRs
                        // or after a lost PLI. Retry until it can emit an independent frame.
                        if framed {
                            for (ssrc, layer) in &layers {
                                if layer
                                    .input
                                    .as_ref()
                                    .is_none_or(|(input, _)| input.waiting_for_keyframe())
                                    && layer.report.lock().unwrap().is_some()
                                {
                                    let _ = track.request_keyframe(*ssrc).await;
                                }
                            }
                        }
                    }
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
    async fn source_ready(&mut self, ready: SourceReady) -> Result<()> {
        #[cfg(feature = "capture")]
        if matches!(ready.source.origin, SourceOrigin::Local) {
            let Some(capture) = self.captures.values_mut().find(|c| {
                c.producer.video == ready.source.id || c.producer.audio() == Some(ready.source.id)
            }) else {
                return Ok(());
            };
            if capture.producer.control.is_stopped() {
                return Ok(());
            }
            if !capture.selected
                || (capture.pending_audio.is_some()
                    && capture.producer.audio() == Some(ready.source.id))
            {
                capture.prepared.push(ready);
                return Ok(());
            }
        }
        let SourceReady { source, media } = ready;
        let publication = source.publication_id;
        if !self.publications.contains_key(&publication) {
            return Ok(());
        }
        let incoming = match &source.origin {
            SourceOrigin::Incoming {
                pair,
                flow_id,
                stream,
            } => {
                let key = (*flow_id, source.kind);
                let desired = self.pairs.get(pair).is_some_and(|p| {
                    p.plan
                        .incoming
                        .iter()
                        .any(|flow| flow.id == *flow_id && flow.publication_id == publication)
                        && p.remote.get(stream) == Some(flow_id)
                        && p.latest.get(&key) == Some(&source.id)
                });
                if !desired {
                    return Ok(());
                }
                // A received successor replaces only its own flow's old track.
                let old = self.sources.values().find(|old| old.kind == source.kind
                    && matches!(old.origin, SourceOrigin::Incoming { pair: old_pair, flow_id: old_flow, .. } if old_pair == *pair && old_flow == *flow_id))
                    .map(|old| old.id);
                if let Some(old) = old {
                    self.sources.remove(&old);
                    self.relay.remove(old);
                    if let Some(reader) = self.pairs.get_mut(pair).unwrap().tasks.remove(&old) {
                        reader.task.abort();
                        let _ = reader.task.await;
                    }
                }
                Some((*pair, *flow_id))
            }
            #[cfg(any(feature = "capture", test))]
            SourceOrigin::Local => {
                #[cfg(feature = "capture")]
                let active = self.captures.values().any(|c| {
                    c.selected
                        && !c.producer.control.is_stopped()
                        && (c.producer.video == source.id || c.producer.audio() == Some(source.id))
                });
                #[cfg(not(feature = "capture"))]
                let active = false;
                if !active || self.publications[&publication].session_id != self.session {
                    return Ok(());
                }
                None
            }
        };
        #[cfg(all(
            feature = "capture",
            any(target_os = "windows", target_os = "linux", target_os = "macos")
        ))]
        if let Some(codec) = incoming.and_then(|_| crate::media::derived_codec(&source.codec)) {
            if let SourceFeed::Video(video) = &source.feed {
                self.derived.insert(
                    source.id,
                    crate::media::derived::Producer::start(
                        publication,
                        source.id,
                        video.clone(),
                        codec,
                        self.events.clone(),
                    ),
                );
            }
        }
        self.sources.insert(source.id, source.clone());
        self.refresh_media(false).await?;
        match media {
            InitialMedia::Rtp(packets) => {
                for packet in packets {
                    self.relay.write(source.id, packet);
                }
            }
            InitialMedia::Video(frame) => {
                if let SourceFeed::Video(video) = &source.feed {
                    video.write(frame);
                }
            }
        }
        // A screen's audio alone does not establish its picture transport.
        if let Some((pair_id, flow_id)) = incoming {
            if source.kind == MediaKind::Video
                || self.publications[&publication].kind == piik_channel_core::wire::Kind::Voice
            {
                self.send(Command::FlowState {
                    flow_id,
                    pair_id,
                    state: FlowState::Forwardable,
                })
                .await;
            }
        }
        Ok(())
    }
    async fn refresh_media(&mut self, released: bool) -> Result<()> {
        let released = self.refresh_outputs().await? || released;
        let mut retry = Vec::new();
        let mut partial = false;
        for (id, pair) in &mut self.pairs {
            let changed = pair
                .failed_offer
                .as_ref()
                .is_some_and(|previous| *previous != pair.offer_work());
            if !released && !changed {
                continue;
            }
            let before = pair.rejected_outputs.len();
            // Normal retirement on any pair permits one companion-audio retry.
            // Failed primary/candidate flows still belong to the route owner.
            pair.rejected_outputs.retain(|(flow, kind), _| {
                *kind != MediaKind::Audio
                    || !pair.outputs.contains_key(&(*flow, MediaKind::Video))
                    || !pair
                        .plan
                        .outgoing
                        .iter()
                        .any(|binding| binding.id == *flow && binding.selected)
            });
            let retry_audio = pair.rejected_outputs.len() != before;
            partial |= retry_audio;
            if changed || retry_audio {
                retry.push(*id);
            }
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

    async fn refresh_outputs(&mut self) -> Result<bool> {
        // Forward the exact admitted input, including shadow branches. Selection
        // belongs to local playback and cannot recreate a prewarmed sender.
        let mut released = false;
        for pair in self.pairs.values_mut() {
            pair.rejected_outputs.retain(|key, rejected| {
                pair.plan.outgoing.iter().any(|flow| {
                    flow.id == key.0
                        && self
                            .sources
                            .values()
                            .find(|source| source.matches(flow, key.1))
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
                                .values()
                                .find(|source| source.matches(flow, key.1))
                        });
                    (!source.is_some_and(|source| source.id == output.source)).then_some(*key)
                })
                .collect();
            for key in retired {
                pair.outputs.remove(&key).unwrap().close(&pair.pc).await;
                released = true;
            }
        }
        let budgets = self.bandwidth_plans(Instant::now());
        for (id, budget) in &budgets {
            for flow in &budget.rejected {
                self.fail_flow(*id, *flow).await;
            }
        }
        let mut failed = HashSet::new();
        for source in self.sources.values() {
            let publication = &source.publication_id;
            let mut targets = Vec::new();
            for (id, p) in &mut self.pairs {
                if matches!(source.origin, SourceOrigin::Incoming { pair, .. } if *id == pair) {
                    continue;
                }
                for binding in p
                    .plan
                    .outgoing
                    .iter()
                    .filter(|flow| source.matches(flow, source.kind))
                {
                    let output_key = (binding.id, source.kind);
                    if budgets[id].rejected.contains(&binding.id)
                        || failed.contains(&(binding.id, *id))
                        || !binding.selected
                            && p.rejected_outputs.keys().any(|key| key.0 == binding.id)
                    {
                        continue;
                    }
                    if p.rejected_outputs.get(&output_key) == Some(&source.id) {
                        continue;
                    }
                    if !p.outputs.contains_key(&output_key) {
                        if budgets[id].waiting.contains(&binding.id) {
                            continue;
                        }
                        let stream = p
                            .outputs
                            .iter()
                            .find(|((flow, _), _)| *flow == binding.id)
                            .map(|(_, out)| out.stream.clone())
                            .unwrap_or_else(|| Uuid::new_v4().to_string());
                        let next = match Output::new(
                            &p.pc,
                            source,
                            stream,
                            *id,
                            output_key,
                            self.events.clone(),
                            p.reports.clone(),
                            p.plan.can_receive_video_layers,
                            self.publications[publication].paused,
                        )
                        .await
                        {
                            Ok(next) => next,
                            Err(error) => {
                                eprintln!("Native encoded track attach failed: {error}");
                                p.rejected_outputs.insert(output_key, source.id);
                                if !binding.selected
                                    || source.kind == MediaKind::Video
                                    || self.publications[publication].kind
                                        == piik_channel_core::wire::Kind::Voice
                                {
                                    failed.insert((binding.id, *id));
                                }
                                continue;
                            }
                        };
                        p.outputs.insert(output_key, next);
                        if matches!(source.feed, SourceFeed::Rtp { .. }) {
                            source.request_keyframe();
                        }
                    }
                    p.outputs[&output_key].set_paused(self.publications[publication].paused);
                    targets.extend(p.outputs[&output_key].rtp_sink());
                }
            }
            self.relay.set(source.id, targets);
        }
        for (flow_id, pair_id) in failed {
            self.fail_flow(pair_id, flow_id).await;
        }
        Ok(released)
    }
}
fn signal_candidate(c: IceCandidate) -> Candidate {
    Candidate {
        candidate: Some(format!("candidate:{}", c.marshal())),
        sdp_mid: Some(String::new()),
        sdp_m_line_index: Some(0),
        username_fragment: None,
    }
}
fn prepared_candidate(remote: std::net::SocketAddrV4) -> Result<Candidate> {
    let candidate = rtc_ice::candidate::candidate_host::CandidateHostConfig {
        base_config: rtc_ice::candidate::CandidateConfig {
            network: "udp".into(),
            address: remote.ip().to_string(),
            port: remote.port(),
            component: 1,
            ..Default::default()
        },
        ..Default::default()
    }
    .new_candidate_host()?;
    Ok(signal_candidate(candidate))
}
async fn close_pair(mut pair: Pair) {
    pair.state.store(PeerState::Closed as u8, Ordering::Release);
    if let Some(mapping) = pair.mapping.as_mut() {
        mapping.close().await;
    }
    let _ = pair.pc.close().await;
    for (_, _, task) in [pair.dc.take(), pair.bulk.take(), pair.input.take()]
        .into_iter()
        .flatten()
    {
        task.abort();
        let _ = task.await;
    }
    pair.data.close().await;
    for (_, task) in pair.tasks {
        task.task.abort();
        let _ = task.task.await;
    }
    for (_, output) in pair.outputs {
        output.close(&pair.pc).await;
    }
}

mod bandwidth;
mod input;
mod mapping;
mod preparation;
pub mod server_udp;
pub(crate) mod transport;

#[cfg(test)]
mod tests;
