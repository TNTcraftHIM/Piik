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
use piik_channel_core::conversation::ControlFrame;
use piik_channel_core::file_room::FilePlan;
use piik_channel_core::wire::Snapshot;
use piik_channel_core::wire::{
    Candidate, Command, Description, FlowState, LinkState, PairInfo, PublicationInfo, Signal,
    Track as WireTrack, UdpPreparation,
};
use rtc_rtp as rtp;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use str0m::Candidate as IceCandidate;
use tokio::{
    sync::{mpsc, oneshot, watch, Notify},
    task::JoinHandle,
};
use transport::{BandwidthDemand, Channel, ChannelEvent, Track, TrackEvent, Transport};
use uuid::Uuid;
#[path = "peer/metrics.rs"]
mod metrics;
use metrics::NativeStreamMetric;
pub use metrics::{NativeConnectionMetrics, PeerConnectionMetrics};
#[cfg(feature = "capture")]
#[path = "peer/external.rs"]
mod external;

pub struct PreparedExternal {
    pub answer: String,
    pub lease: ExternalLease,
}

/// One actual external stream. Its page owns cancellation; the Driver joins it.
pub struct ExternalLease {
    pub id: Uuid,
    pub session_id: Uuid,
    pub scope: CaptureScope,
    ready: oneshot::Receiver<Result<()>>,
    pub ended: Option<oneshot::Receiver<Result<(), String>>>,
    control: ExternalControl,
}
#[derive(Clone)]
pub struct ExternalControl(watch::Sender<Option<&'static str>>);
impl ExternalControl {
    pub fn stop(&self) {
        self.0.send_if_modified(|reason| {
            if reason.is_some() {
                false
            } else {
                *reason = Some("cancelled");
                true
            }
        });
    }
    pub fn is_stopped(&self) -> bool {
        self.0.borrow().is_some()
    }
    fn retire(&self) {
        self.0.send_replace(Some("room_unavailable"));
    }
}
impl ExternalLease {
    pub async fn ready(&mut self) -> Result<()> {
        (&mut self.ready)
            .await
            .context("external input stopped before its first frame")?
    }
    pub fn control(&self) -> ExternalControl {
        self.control.clone()
    }
    pub fn stop(&self) {
        self.control.stop();
    }
    pub fn is_stopped(&self) -> bool {
        self.control.is_stopped()
    }
}
impl Drop for ExternalLease {
    fn drop(&mut self) {
        self.stop();
    }
}

const MAX_ICE_CANDIDATES: usize = 128;

/// Local H264 ingest requires the same received-video adaptation as room relays.
pub fn supports_external_input() -> bool {
    crate::media::derived_codec(&RtpCodec {
        mime_type: "video/H264".into(),
        ..Default::default()
    })
    .is_some()
}

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

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAudioState {
    pub source_audio: bool,
    pub microphone: SourceMicrophoneSettings,
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
}
pub enum NativeEvent {
    Command(Command),
    CaptureEnded {
        publication_id: Uuid,
        error: Option<String>,
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
    pub audio: Option<CaptureAudio>,
    pub audio_error: Option<oneshot::Receiver<String>>,
    pub ended: Option<oneshot::Receiver<Result<(), String>>>,
    pub remote: Option<crate::input::Source>,
    pub input_state: Option<watch::Receiver<crate::input::SourceView>>,
    #[cfg(feature = "capture")]
    control: Option<crate::media::local::Control>,
    #[cfg(feature = "capture")]
    system_audio: crate::media::local::AudioLeaseControl,
    #[cfg(feature = "capture")]
    mixer: crate::media::local::AudioControl,
    producer: Uuid,
}
/// The page's publication owner retains this across active and pending pictures.
pub struct CaptureAudio {
    #[cfg(feature = "capture")]
    control: crate::media::local::AudioControl,
}
impl CaptureAudio {
    pub fn is_stopped(&self) -> bool {
        #[cfg(feature = "capture")]
        return self.control.is_stopped();
        #[cfg(not(feature = "capture"))]
        true
    }
    pub fn configure(&self, settings: SourceAudioSettings) -> Result<()> {
        settings.validate()?;
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        #[cfg(feature = "capture")]
        self.control.settings.send_replace(settings);
        Ok(())
    }
    pub fn audio_state(&self) -> Option<watch::Receiver<SourceAudioState>> {
        #[cfg(feature = "capture")]
        return Some(self.control.state.clone());
        #[cfg(not(feature = "capture"))]
        None
    }
}
impl Drop for CaptureAudio {
    fn drop(&mut self) {
        #[cfg(feature = "capture")]
        self.control.stop();
    }
}
#[derive(Clone)]
pub struct CaptureScope {
    pub publication_id: Uuid,
    pub room_id: String,
    pub binding_id: Uuid,
}
impl CaptureScope {
    fn is_current(&self, state: &Snapshot) -> bool {
        state.channel.rooms.iter().any(|room| {
            room.id == self.room_id
                && room.authorized
                && room
                    .delivery
                    .as_ref()
                    .is_some_and(|delivery| delivery.binding_id == self.binding_id)
        })
    }
}
/// The existing Native snapshot supplies authority while a page awaits input.
#[derive(Clone)]
pub struct InputAuthority {
    pub scope: CaptureScope,
    pub snapshot: watch::Receiver<Option<Snapshot>>,
}
impl InputAuthority {
    pub fn is_current(&self) -> bool {
        self.snapshot.has_changed().is_ok()
            && self
                .snapshot
                .borrow()
                .as_ref()
                .is_some_and(|state| self.scope.is_current(state))
    }
    pub async fn retired(&mut self) {
        while self.is_current() {
            if self.snapshot.changed().await.is_err() {
                break;
            }
        }
    }
}
pub struct CaptureInput {
    pub source: Option<piik_channel_core::wire::ScreenSource>,
    pub remote: Option<crate::input::Source>,
    pub state: Option<watch::Receiver<crate::input::SourceView>>,
}
#[cfg(feature = "capture")]
// Keyed by producer.video: stopped predecessors stay owned until their worker
// reports completion, without sharing the successor's publication cleanup.
struct PreparedSource {
    scope: CaptureScope,
    selected: bool,
    prepared: Vec<SourceReady>,
    ended: oneshot::Sender<Result<(), String>>,
    producer: LocalProducer,
}
#[cfg(feature = "capture")]
enum LocalProducer {
    Capture(CaptureProducer),
    External(external::Producer),
}
#[cfg(feature = "capture")]
struct CaptureProducer {
    target: crate::capture::Target,
    #[cfg(target_os = "windows")]
    show_capture_border: bool,
    producer: crate::media::local::Producer,
    pending_audio: Option<(Uuid, crate::media::local::AudioLeaseControl)>,
}
#[cfg(feature = "capture")]
impl LocalProducer {
    fn capture(&self) -> Option<&CaptureProducer> {
        match self {
            Self::Capture(value) => Some(value),
            Self::External(_) => None,
        }
    }
    fn capture_mut(&mut self) -> Option<&mut CaptureProducer> {
        match self {
            Self::Capture(value) => Some(value),
            Self::External(_) => None,
        }
    }
    fn is_stopped(&self) -> bool {
        match self {
            Self::Capture(value) => value.producer.control.is_stopped(),
            Self::External(value) => value.is_stopped(),
        }
    }
    fn stop(&self) {
        match self {
            Self::Capture(value) => value.producer.control.stop(),
            Self::External(value) => value.stop(),
        }
    }
    fn retire(&self) {
        match self {
            Self::Capture(value) => value.producer.control.stop(),
            Self::External(value) => value.control.retire(),
        }
    }
    async fn close(&mut self) -> Option<String> {
        match self {
            Self::Capture(value) => value.producer.close().await,
            Self::External(value) => value.close().await,
        }
    }
    async fn stop_system_audio(&mut self) {
        if let Self::Capture(value) = self {
            value.producer.stop_system_audio().await;
        }
    }
    fn owns(&self, id: Uuid, kind: MediaKind) -> bool {
        match self {
            Self::Capture(value) => kind == MediaKind::Video && value.producer.video == id,
            Self::External(value) => value.owns(id, kind),
        }
    }
}
impl CaptureLease {
    pub fn video_codec(&self) -> Result<crate::capture::VideoCodec> {
        self.codec
            .get()
            .copied()
            .context("capture has no admitted video codec")
    }
    pub fn audio_state(&self) -> Option<watch::Receiver<SourceAudioState>> {
        #[cfg(feature = "capture")]
        return Some(self.mixer.state.clone());
        #[cfg(not(feature = "capture"))]
        None
    }
    pub fn configure_microphone(
        &self,
        settings: SourceMicrophoneSettings,
    ) -> Result<impl std::future::Future<Output = Result<()>> + Send + 'static> {
        settings.validate()?;
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        #[cfg(feature = "capture")]
        let control = self.mixer.clone();
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
        let control = self.mixer.clone();
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
        published: impl std::future::Future<Output = Result<()>> + Send + 'static,
    ) -> Result<impl std::future::Future<Output = Result<()>> + Send + 'static> {
        settings.validate()?;
        anyhow::ensure!(!self.is_stopped(), "capture_unavailable");
        #[cfg(feature = "capture")]
        let control = match self.control.as_ref() {
            Some(control) => control.clone(),
            _ => anyhow::bail!("capture_unavailable"),
        };
        Ok(async move {
            #[cfg(feature = "capture")]
            return control.configure_published_video(settings, published).await;
            #[cfg(not(feature = "capture"))]
            {
                let _ = published;
                anyhow::bail!("capture_unavailable")
            }
        })
    }
    pub fn video_settings(&self) -> Option<piik_channel_core::wire::VideoSettings> {
        #[cfg(feature = "capture")]
        if let Some(control) = &self.control {
            return Some(control.settings().into());
        }
        None
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
                Some(control) => control.clone(),
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
                .context("source audio stopped before startup")??;
        }
        Ok(())
    }
    pub fn is_stopped(&self) -> bool {
        #[cfg(feature = "capture")]
        {
            match self.control.as_ref() {
                Some(control) => control.is_stopped(),
                None => self.system_audio.is_stopped(),
            }
        }
        #[cfg(not(feature = "capture"))]
        {
            true
        }
    }
    pub fn stop(&self) {
        if let Some(source) = &self.remote {
            source.retire_capture();
        }
        #[cfg(feature = "capture")]
        {
            if let Some(control) = &self.control {
                control.stop();
            }
            self.system_audio.stop();
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
            self.ended = previous.ended.take();
        }
    }
    pub fn retains_video(&self) -> bool {
        #[cfg(feature = "capture")]
        {
            self.control.is_none()
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
    ConnectionMetrics(
        String,
        Option<Uuid>,
        oneshot::Sender<Result<Vec<PeerConnectionMetrics>>>,
    ),
    #[cfg(feature = "capture")]
    PrepareCapture(
        CaptureScope,
        Option<Uuid>,
        crate::capture::Target,
        crate::capture::Settings,
        crate::capture::VideoCodecMode,
        bool,
        Option<crate::capture::Target>,
        bool,
        oneshot::Sender<Result<CaptureLease>>,
    ),
    #[cfg(feature = "capture")]
    PrepareExternal(
        CaptureScope,
        Option<Uuid>,
        String,
        oneshot::Sender<Result<PreparedExternal>>,
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
        reader: Uuid,
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
    CaptureAudioStopped {
        publication_id: Uuid,
        owner: watch::Receiver<bool>,
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
    // Receiving tasks outlive encoded-format generations on the same track.
    latest: HashMap<TrackKey, Uuid>,
    outputs: HashMap<TrackKey, Output>,
    rejected_outputs: HashMap<TrackKey, Uuid>,
    reports: OutputStreams,
    bandwidth: watch::Receiver<transport::Estimate>,
    demand: watch::Sender<BandwidthDemand>,
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
    cancel: watch::Receiver<bool>,
    events: mpsc::Sender<Event>,
    ready_sources: mpsc::Sender<SourceReady>,
    bandwidth_changed: Arc<Notify>,
    admitted: HashSet<Uuid>,
    pairs: HashMap<Uuid, Pair>,
    preparings: HashMap<Uuid, preparation::Pending>,
    publications: HashMap<Uuid, PublicationInfo>,
    sources: HashMap<Uuid, Source>,
    #[cfg(feature = "capture")]
    local_producers: HashMap<Uuid, PreparedSource>,
    #[cfg(feature = "capture")]
    capture_audio: HashMap<Uuid, (CaptureScope, crate::media::local::AudioProducer)>,
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
        let bandwidth_changed = Arc::new(Notify::new());
        let task = tokio::spawn(async move {
            let transport = transport::Runtime::new(server_udp.clone());
            let mut d = Driver {
                transport,
                session: session_id,
                ice: ice_servers,
                server_udp,
                commands,
                cancel: cancelled.clone(),
                events,
                ready_sources,
                bandwidth_changed: bandwidth_changed.clone(),
                admitted: HashSet::new(),
                pairs: HashMap::new(),
                preparings: HashMap::new(),
                publications: HashMap::new(),
                sources: HashMap::new(),
                #[cfg(feature = "capture")]
                local_producers: HashMap::new(),
                #[cfg(feature = "capture")]
                capture_audio: HashMap::new(),
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
                    for capture in d.local_producers.values() {
                        // Input authority ends with capture, before its workers
                        // finish joining and before this turn can execute input.
                        if capture.selected && capture.producer.is_stopped() {
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
                        Turn::Input(Input::ConnectionMetrics(room, publication, done)) => {
                            let _ = done.send(d.connection_metrics(&room, publication).await);
                        }
                        Turn::Input(Input::Resync(done)) => {
                            d.resync().await;
                            let _ = done.send(Ok(()));
                        }
                        Turn::Input(Input::Captures(done)) => {
                            #[cfg(feature = "capture")]
                            let publications = d
                                .local_producers
                                .iter()
                                .filter(|(_, c)| !c.producer.is_stopped())
                                .map(|(_, c)| c.scope.publication_id)
                                .chain(
                                    d.capture_audio
                                        .iter()
                                        .filter(|(_, (_, audio))| !audio.control.is_stopped())
                                        .map(|(publication, _)| *publication),
                                )
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
                            show_capture_border,
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
                                    show_capture_border,
                                )
                                .await,
                            );
                        }
                        Turn::Input(Input::CommitCapture(id, done)) => {
                            let _ = done.send(d.commit_capture(id).await);
                        }
                        #[cfg(feature = "capture")]
                        Turn::Input(Input::PrepareExternal(scope, replaces, offer, done)) => {
                            let _ = done.send(d.prepare_external(scope, replaces, offer).await);
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
                                | Event::CaptureAudioStopped { .. }
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
                for capture in d.local_producers.values() {
                    capture.producer.stop();
                }
                for (_, mut capture) in d.local_producers.drain() {
                    capture.producer.close().await;
                }
                for (_, (_, audio)) in d.capture_audio.drain() {
                    audio.close().await;
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
        show_capture_border: bool,
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
                    show_capture_border,
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
                show_capture_border,
            );
            anyhow::bail!("capture_unavailable")
        }
    }
    pub async fn commit_capture(&self, id: Uuid) -> Result<CaptureInput> {
        let (tx, rx) = oneshot::channel();
        self.input.send(Input::CommitCapture(id, tx)).await?;
        rx.await?
    }
    pub async fn prepare_external(
        &self,
        scope: CaptureScope,
        replaces: Option<Uuid>,
        offer: String,
    ) -> Result<PreparedExternal> {
        anyhow::ensure!(supports_external_input(), "external_input_unavailable");
        #[cfg(feature = "capture")]
        {
            let (tx, rx) = oneshot::channel();
            self.input
                .send(Input::PrepareExternal(scope, replaces, offer, tx))
                .await?;
            rx.await?
        }
        #[cfg(not(feature = "capture"))]
        {
            let _ = (scope, replaces, offer);
            anyhow::bail!("external_input_unavailable")
        }
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
    pub async fn connection_metrics(
        &self,
        room: String,
        publication: Option<Uuid>,
    ) -> Result<Vec<PeerConnectionMetrics>> {
        let (done, reply) = oneshot::channel();
        self.input
            .send(Input::ConnectionMetrics(room, publication, done))
            .await?;
        reply.await?
    }
    pub async fn close(&mut self) -> Result<()> {
        let _ = self.cancel.send(true);
        (&mut self.task).await?;
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
    async fn connection_metrics(
        &self,
        room: &str,
        publication: Option<Uuid>,
    ) -> Result<Vec<PeerConnectionMetrics>> {
        let scoped = |id: Uuid| {
            self.publications.get(&id).is_some_and(|info| {
                info.room_id == room
                    && publication.is_none_or(|selected| {
                        selected == id || info.kind == piik_channel_core::wire::Kind::Voice
                    })
            })
        };
        let mut connections = Vec::new();
        for (id, pair) in &self.pairs {
            let has_flow = pair
                .plan
                .incoming
                .iter()
                .chain(&pair.plan.outgoing)
                .any(|flow| scoped(flow.publication_id));
            if !has_flow && (publication.is_some() || !pair.plan.rooms.iter().any(|id| id == room))
            {
                continue;
            }
            let measured = pair.pc.connection_metrics().await?;
            let mut streams = Vec::new();
            for stream in measured.streams {
                let flow_id = if stream.outgoing {
                    pair.outputs
                        .iter()
                        .find(|((_, kind), output)| {
                            *kind == stream.media && output.stream == stream.stream
                        })
                        .map(|((flow, _), _)| *flow)
                } else {
                    pair.remote.get(&stream.stream).copied()
                };
                let plan = if stream.outgoing {
                    &pair.plan.outgoing
                } else {
                    &pair.plan.incoming
                };
                let Some(flow) = plan
                    .iter()
                    .find(|flow| Some(flow.id) == flow_id && scoped(flow.publication_id))
                else {
                    continue;
                };
                streams.push(NativeStreamMetric {
                    flow_id: flow.id,
                    publication_id: flow.publication_id,
                    selected: flow.selected,
                    direction: if stream.outgoing { "send" } else { "receive" },
                    media: if stream.media == MediaKind::Video {
                        "video"
                    } else {
                        "audio"
                    },
                    counters: stream.counters,
                });
            }
            connections.push(PeerConnectionMetrics {
                pair_id: *id,
                connection_id: measured.connection_id,
                peer_id: pair.plan.peer_id,
                sample_timestamp_ms: measured.sample_timestamp_ms,
                age_ms: measured.age_ms,
                rtt_ms: measured.rtt_ms,
                bwe_bps: measured.bwe_bps,
                streams,
            });
        }
        Ok(connections)
    }
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
    fn check_local_preparation(&self, scope: &CaptureScope, replaces: Option<Uuid>) -> Result<()> {
        let publication = scope.publication_id;
        anyhow::ensure!(
            !self
                .local_producers
                .values()
                .any(|capture| capture.scope.room_id == scope.room_id
                    && capture.scope.publication_id != publication
                    && !capture.producer.is_stopped()),
            "source_already_published"
        );
        let existing = self
            .local_producers
            .iter()
            .find(|(_, c)| {
                c.scope.publication_id == publication && c.selected && !c.producer.is_stopped()
            })
            .map(|(id, _)| *id);
        anyhow::ensure!(existing == replaces, "capture_not_owned");
        anyhow::ensure!(
            !self
                .local_producers
                .values()
                .any(|c| c.scope.publication_id == publication
                    && (!c.selected
                        || c.producer
                            .capture()
                            .is_some_and(|c| c.pending_audio.is_some()))
                    && !c.producer.is_stopped()),
            "capture_pending"
        );
        Ok(())
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
        show_capture_border: bool,
    ) -> Result<CaptureLease> {
        let publication = scope.publication_id;
        self.cancelled_audio().await;
        self.check_local_preparation(&scope, replaces)?;
        anyhow::ensure!(
            exclude_audio
                .as_ref()
                .is_none_or(|excluded| cfg!(target_os = "windows")
                    && audio
                    && target.kind == crate::capture::TargetKind::Display
                    && excluded.kind == crate::capture::TargetKind::Window),
            "audio exclusion unavailable"
        );
        if self
            .capture_audio
            .get(&publication)
            .is_some_and(|(_, audio)| audio.control.is_stopped())
        {
            self.retire_capture_audio(publication).await?;
        }
        let audio_owner = if self.capture_audio.contains_key(&publication) {
            None
        } else {
            let audio = crate::media::local::AudioProducer::start(
                publication,
                self.ready_sources.clone(),
                self.events.clone(),
                self.relay.clone(),
                self.cancel.clone(),
            );
            let owner = CaptureAudio {
                control: audio.control.clone(),
            };
            self.capture_audio
                .insert(publication, (scope.clone(), audio));
            Some(owner)
        };
        let mixer = self.capture_audio[&publication].1.control.clone();
        #[cfg(target_os = "windows")]
        if let Some(video) = self
            .local_producers
            .iter()
            .find(|(_, capture)| {
                let Some(details) = capture.producer.capture() else {
                    return false;
                };
                capture.scope.publication_id == publication
                    && capture.selected
                    && details.target.same_source(&target)
                    && details.show_capture_border == show_capture_border
                    && details.producer.settings() == settings
                    && details.producer.control.codec.get().is_some_and(|codec| {
                        mode == crate::capture::VideoCodecMode::Auto || *codec == mode.initial()
                    })
            })
            .map(|(id, _)| *id)
        {
            let capture = self
                .local_producers
                .get_mut(&video)
                .unwrap()
                .producer
                .capture_mut()
                .unwrap();
            let (control, ready, audio_error) = capture
                .producer
                .prepare_audio(target, audio, exclude_audio, &mixer)
                .await?;
            let id = Uuid::new_v4();
            capture.pending_audio = Some((id, control.clone()));
            return Ok(CaptureLease {
                id,
                session_id: self.session,
                scope,
                ready,
                codec: capture.producer.control.codec.clone(),
                required_audio: None,
                audio: audio_owner,
                audio_error,
                ended: None,
                remote: None,
                input_state: None,
                producer: video,
                control: None,
                system_audio: control,
                mixer,
            });
        }
        if exclude_audio.is_some() {
            mixer.stop_system().await?;
        }
        let audio_required = exclude_audio.is_some();
        let (producer, ready, audio_error, required_audio) = crate::media::local::Producer::start(
            publication,
            target.clone(),
            settings,
            mode,
            mixer.clone(),
            audio,
            exclude_audio,
            show_capture_border,
            self.ready_sources.clone(),
            self.events.clone(),
            self.cancel.clone(),
            self.bandwidth_changed.clone(),
        )
        .await?;
        let id = producer.video;
        let (ended, completion) = oneshot::channel();
        let lease = CaptureLease {
            id,
            session_id: self.session,
            scope: scope.clone(),
            ready,
            codec: producer.control.codec.clone(),
            required_audio: audio_required.then_some(required_audio),
            audio: audio_owner,
            audio_error,
            ended: Some(completion),
            remote: None,
            input_state: None,
            control: Some(producer.control.clone()),
            system_audio: producer.system_audio().clone(),
            mixer,
            producer: id,
        };
        self.local_producers.insert(
            id,
            PreparedSource {
                scope,
                producer: LocalProducer::Capture(CaptureProducer {
                    target,
                    #[cfg(target_os = "windows")]
                    show_capture_border,
                    producer,
                    pending_audio: None,
                }),
                selected: false,
                prepared: Vec::new(),
                ended,
            },
        );
        Ok(lease)
    }

    fn capture_current(&self, id: Uuid, selected: bool) -> bool {
        #[cfg(feature = "capture")]
        return self.local_producers.iter().any(|(video, c)| {
            !c.producer.is_stopped()
                && ((*video == id && c.selected == selected)
                    || (!selected
                        && c.producer
                            .capture()
                            .and_then(|c| c.pending_audio.as_ref())
                            .is_some_and(|(pending, control)| {
                                *pending == id && !control.is_stopped()
                            })))
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
                .local_producers
                .iter()
                .find(|(_, capture)| {
                    capture
                        .producer
                        .capture()
                        .and_then(|c| c.pending_audio.as_ref())
                        .is_some_and(|(pending, _)| *pending == id)
                })
                .map(|(video, _)| *video)
            {
                let capture = self.local_producers.get_mut(&video).unwrap();
                let details = capture.producer.capture_mut().unwrap();
                let (_, input) = details.pending_audio.take().unwrap();
                self.capture_audio[&capture.scope.publication_id]
                    .1
                    .control
                    .commit_system(&input)
                    .await?;
                anyhow::ensure!(
                    !details.producer.control.is_stopped() && !input.is_stopped(),
                    "capture_unavailable"
                );
                details.producer.replace_system_audio(input);
                let prepared = std::mem::take(&mut capture.prepared);
                for source in prepared {
                    self.source_ready(source).await?;
                }
                return Ok(CaptureInput {
                    source: None,
                    remote: None,
                    state: None,
                });
            }
            let capture = &self.local_producers[&id];
            let publication = capture.scope.publication_id;
            anyhow::ensure!(
                self.publications
                    .get(&publication)
                    .is_some_and(|p| p.session_id == self.session),
                "publication_not_owned"
            );
            let (source, input) = if let Some(details) = capture.producer.capture() {
                let target = details.target.clone();
                self.capture_audio[&publication]
                    .1
                    .control
                    .commit_system(details.producer.system_audio())
                    .await?;
                let input = self
                    .inputs
                    .source(publication, id, target.clone())
                    .unwrap_or_else(|error| {
                        eprintln!("Native input unavailable: {error}");
                        None
                    });
                (target.screen_source(), input)
            } else {
                self.inputs.end_source(publication);
                if self.capture_audio.contains_key(&publication) {
                    self.retire_capture_audio(publication).await?;
                }
                (
                    piik_channel_core::wire::ScreenSource {
                        name: Some("OBS".into()),
                        ..Default::default()
                    },
                    None,
                )
            };
            anyhow::ensure!(self.capture_current(id, false), "capture_unavailable");
            for (old, capture) in &mut self.local_producers {
                if *old != id && capture.scope.publication_id == publication && capture.selected {
                    capture.selected = false;
                    capture.producer.stop();
                    capture.producer.stop_system_audio().await;
                    self.sources
                        .retain(|source, value| !capture.producer.owns(*source, value.kind));
                }
            }
            self.relay.retain(&self.sources.keys().copied().collect());
            let capture = self.local_producers.get_mut(&id).unwrap();
            capture.selected = true;
            let prepared = std::mem::take(&mut capture.prepared);
            for source in prepared {
                if let Err(error) = self.source_ready(source).await {
                    eprintln!("Native replacement media unavailable: {error}");
                }
            }
            Ok(match input {
                Some((remote, state)) => CaptureInput {
                    source: Some(source),
                    remote: Some(remote),
                    state: Some(state),
                },
                None => CaptureInput {
                    source: Some(source),
                    remote: None,
                    state: None,
                },
            })
        }
    }

    #[cfg(feature = "capture")]
    async fn capture_ended(&mut self, publication: Uuid, source_id: Uuid) -> Result<()> {
        let Some(capture) = self.local_producers.get_mut(&source_id) else {
            return Ok(());
        };
        if capture.selected {
            self.inputs.end_source(publication);
        }
        let error = capture.producer.close().await;
        let capture = self.local_producers.remove(&source_id).unwrap();
        let _ = capture.ended.send(error.clone().map_or(Ok(()), Err));
        self.sources
            .retain(|id, source| !capture.producer.owns(*id, source.kind));
        self.relay.retain(&self.sources.keys().copied().collect());
        self.refresh_media(false).await?;
        // Android can stop the incumbent when a new projection is authorized.
        // Its prepared replacement still owns the publication until commit/cancel.
        if self
            .local_producers
            .values()
            .any(|c| c.scope.publication_id == publication && !c.producer.is_stopped())
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
            .local_producers
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
    async fn capture_audio_stopped(
        &mut self,
        publication: Uuid,
        owner: watch::Receiver<bool>,
    ) -> Result<()> {
        if !self
            .capture_audio
            .get(&publication)
            .is_some_and(|(_, audio)| audio.control.same(&owner))
        {
            return Ok(());
        }
        self.retire_capture_audio(publication).await?;
        if !self
            .local_producers
            .values()
            .any(|c| c.scope.publication_id == publication && !c.producer.is_stopped())
        {
            let mut cancelled = self.cancel.clone();
            tokio::select! {
                _ = cancelled.changed() => {},
                _ = self.commands.send(NativeEvent::CaptureEnded { publication_id: publication, error: None }) => {},
            }
        }
        Ok(())
    }

    #[cfg(feature = "capture")]
    async fn retire_capture_audio(&mut self, publication: Uuid) -> Result<()> {
        let (_, audio) = self.capture_audio.remove(&publication).unwrap();
        let state = audio.control.source.clone();
        let source = *state.borrow();
        audio.close().await;
        // Joining settles a first/final source report already in flight.
        for source in source.into_iter().chain(*state.borrow()) {
            self.sources.remove(&source);
            self.relay.remove(source);
        }
        self.refresh_media(false).await
    }

    #[cfg(feature = "capture")]
    async fn cancelled_audio(&mut self) {
        for capture in self.local_producers.values_mut() {
            let Some(capture) = capture.producer.capture_mut() else {
                continue;
            };
            if capture
                .pending_audio
                .as_ref()
                .is_some_and(|(_, control)| control.is_stopped())
            {
                capture.pending_audio = None;
            }
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
        #[cfg(feature = "capture")]
        let withdrawn: HashSet<_> = self
            .publications
            .values()
            .filter(|p| {
                p.session_id == self.session
                    && !publications
                        .iter()
                        .any(|next| next.id == p.id && next.session_id == self.session)
            })
            .map(|p| p.id)
            .collect();
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
        for (publication, (scope, audio)) in &self.capture_audio {
            if withdrawn.contains(publication)
                || self
                    .snapshot
                    .borrow()
                    .as_ref()
                    .is_none_or(|state| !scope.is_current(state))
            {
                audio.control.stop();
            }
        }
        #[cfg(feature = "capture")]
        for capture in self.local_producers.values() {
            let authority = self.snapshot.borrow();
            let admitted = authority
                .as_ref()
                .is_some_and(|state| capture.scope.is_current(state));
            if !admitted
                || (capture.selected
                    && !self
                        .publications
                        .get(&capture.scope.publication_id)
                        .is_some_and(|p| p.session_id == self.session))
            {
                capture.producer.retire();
            }
        }
        self.relay.retain(&self.sources.keys().copied().collect());
        let retained: HashSet<_> = plans.iter().map(|p| p.id).collect();
        self.admitted.retain(|id| retained.contains(id));
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
            // One acquisition per admitted lease, including failure before a
            // runtime exists. Only authority withdrawal permits another lease.
            if !self.admitted.insert(id)
                && !self.pairs.contains_key(&id)
                && !self.preparings.contains_key(&id)
            {
                continue;
            }
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
        let (demand, requested) = watch::channel(BandwidthDemand {
            minimum_bps: 0,
            desired_bps: Some(0),
        });
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
        let retired_base = !p.plan.rooms.is_empty() && plan.rooms.is_empty();
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
            .chain(self.sources.values().filter_map(|s| match s.origin {
                SourceOrigin::Incoming { pair, reader, .. } if pair == id => Some(reader),
                _ => None,
            }))
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
        if retired_base {
            for (_, dc, task) in [p.dc.take(), p.bulk.take()].into_iter().flatten() {
                task.abort();
                let _ = task.await;
                let _ = dc.close().await;
            }
            p.data.unbind(Lane::Control);
            p.data.unbind(Lane::Bulk);
            p.dc_open = false;
        } else if !p.plan.rooms.is_empty() && !p.polite && !p.base_failed && p.dc.is_none() {
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
        for id in self.admitted.iter().copied() {
            let Some(pair) = self.pairs.get(&id) else {
                if !self.preparings.contains_key(&id) {
                    self.send(Command::LinkState {
                        pair_id: id,
                        state: LinkState::Failed,
                    })
                    .await;
                }
                continue;
            };
            if pair.connected() {
                self.send(Command::LinkState {
                    pair_id: id,
                    state: LinkState::Connected,
                })
                .await;
            }
            if pair.base_failed || (pair.connected() && pair.dc_open) {
                for room_id in &pair.plan.rooms {
                    self.send(Command::BaseState {
                        room_id: room_id.clone(),
                        pair_id: id,
                        ready: !pair.base_failed,
                    })
                    .await;
                }
            }
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
        for source in self.sources.values() {
            let Some((pair_id, flow_id)) = self.incoming_source_flow(source) else {
                continue;
            };
            if self.pairs[&pair_id].connected()
                && self
                    .publications
                    .get(&source.publication_id)
                    .is_some_and(|publication| {
                        source.kind == MediaKind::Video
                            || publication.kind == piik_channel_core::wire::Kind::Voice
                    })
            {
                self.send(Command::FlowState {
                    flow_id,
                    pair_id,
                    state: FlowState::Forwardable,
                })
                .await;
            }
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
        // DCEP can precede this endpoint's room projection on an existing media
        // pair. Physical slots do not grant file access; Files owns those leases.
        if data::terminal(&p.state)
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
    async fn source_ended(&mut self, pair: Uuid, key: TrackKey, reader: Uuid) {
        // An old active source may end while its replacement is awaiting a first
        // packet. Only the latest, still-declared reader can invalidate its lease.
        let source = self
            .sources
            .values()
            .find_map(|source| match &source.origin {
                SourceOrigin::Incoming {
                    reader: current,
                    stream,
                    ..
                } if *current == reader => Some((source.id, stream)),
                _ => None,
            });
        let assigned_latest = self.pairs.get(&pair).and_then(|p| {
            p.plan
                .incoming
                .iter()
                .find(|flow| {
                    flow.id == key.0
                        && p.latest.get(&key) == Some(&reader)
                        && source.is_some_and(|(_, stream)| p.remote.get(stream) == Some(&flow.id))
                })
                .copied()
        });
        let source = source.map(|(id, _)| id);
        if let Some(p) = self.pairs.get_mut(&pair) {
            if p.latest.get(&key) == Some(&reader) {
                p.latest.remove(&key);
            }
            if let Some(reader) = p.tasks.remove(&reader) {
                reader.task.abort();
                let _ = reader.task.await;
            }
        }
        if let Some(source) = source {
            let current = self.sources.remove(&source).unwrap();
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
            Event::SourceEnded { pair, key, reader } => self.source_ended(pair, key, reader).await,
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
            Event::CaptureAudioStopped {
                publication_id,
                owner,
            } => self.capture_audio_stopped(publication_id, owner).await?,
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
                            p.mapping = mapping::Mapping::start(&candidate, p.pc.clone());
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
                        } else {
                            let terminal = data::terminal(&p.state);
                            p.data.unbind(Lane::Control);
                            let (_, dc, task) = p.dc.take().unwrap();
                            task.abort();
                            let _ = task.await;
                            let _ = dc.close().await;
                            if terminal {
                                self.fail(id).await;
                            } else {
                                self.fail_base(id).await;
                            }
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
        let reader = Uuid::new_v4();
        let (keyframes, mut requests) = watch::channel(0u64);
        let report: crate::media::SourceReport = track.report(ssrc);
        let mut source = Source {
            id: Uuid::new_v4(),
            publication_id: publication,
            origin: SourceOrigin::Incoming {
                pair: id,
                flow_id,
                stream,
                reader,
            },
            codec,
            kind,
            feed: SourceFeed::Rtp {
                keyframes,
                report: report.clone(),
            },
            layers: layered.then(|| crate::media::video::Layers::new(rids.clone())),
        };
        if let Some(previous) = p.latest.insert(key, reader) {
            if !self.sources.values().any(
                |s| matches!(s.origin, SourceOrigin::Incoming { reader, .. } if reader == previous),
            ) {
                if let Some(task) = p.tasks.remove(&previous) {
                    task.task.abort();
                    let _ = task.task.await;
                }
            }
        }
        let ready_sources = self.ready_sources.clone();
        let relay = self.relay.clone();
        let events = self.events.clone();
        p.tasks.retain(|_, reader| !reader.task.is_finished());
        let task = tokio::spawn(async move {
            let mut first = true;
            let framed = crate::media::incoming::Incoming::supports(&source.codec.mime_type);
            struct Layer {
                rid: String,
                codec: RtpCodec,
                sequence: u64,
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
                    TrackEvent::Rtp(packet, sequence, media_time, codec) => {
                        if framed {
                            let packet_ssrc = packet.header.ssrc;
                            if !layered && packet_ssrc != ssrc {
                                continue;
                            }
                            let mut format_changed = false;
                            if !layers.contains_key(&packet_ssrc) {
                                if packet.payload.is_empty() {
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
                                        codec: codec.clone(),
                                        sequence,
                                        report: track.report(packet_ssrc),
                                        input: None,
                                    },
                                );
                                format_changed = true;
                            } else if !packet.payload.is_empty() {
                                let layer = layers.get_mut(&packet_ssrc).unwrap();
                                if !crate::media::compatible(&layer.codec, &codec) {
                                    // A reordered packet from the previous format
                                    // cannot roll this SSRC back after its successor.
                                    if sequence <= layer.sequence {
                                        continue;
                                    }
                                    layer.codec = codec.clone();
                                    format_changed = true;
                                }
                                layer.sequence = layer.sequence.max(sequence);
                            }
                            if format_changed && !crate::media::compatible(&source.codec, &codec) {
                                if !supported(&codec, kind) {
                                    break 'reading;
                                }
                                source.id = Uuid::new_v4();
                                source.codec = codec;
                                source.layers =
                                    layered.then(|| crate::media::video::Layers::new(rids.clone()));
                                first = true;
                                // Keep each RID's actual format and RTP ordering.
                                // A lagging old-codec RID cannot flip the source back.
                                for layer in layers.values_mut() {
                                    layer.input = None;
                                }
                            }
                            let layer = layers.get_mut(&packet_ssrc).unwrap();
                            if !crate::media::compatible(&source.codec, &layer.codec) {
                                continue;
                            }
                            if layer.input.is_none() {
                                if packet.payload.is_empty() {
                                    continue;
                                }
                                let next_time = match &time {
                                    Some(root) => {
                                        let report = layer
                                            .report
                                            .lock()
                                            .unwrap()
                                            .as_ref()
                                            .map(|(sr, _)| sr.clone());
                                        report.as_ref().and_then(|sr| {
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
                    reader,
                })
                .await;
        });
        p.tasks.insert(
            reader,
            Reader {
                key,
                track: track_id,
                task,
            },
        );
        Ok(())
    }
    fn incoming_source_flow(&self, source: &Source) -> Option<(Uuid, Uuid)> {
        match &source.origin {
            SourceOrigin::Incoming {
                pair,
                flow_id,
                stream,
                reader,
            } => self
                .pairs
                .get(pair)
                .filter(|p| {
                    p.plan.incoming.iter().any(|flow| {
                        flow.id == *flow_id && flow.publication_id == source.publication_id
                    }) && p.remote.get(stream) == Some(flow_id)
                        && p.latest.get(&(*flow_id, source.kind)) == Some(reader)
                })
                .map(|_| (*pair, *flow_id)),
            #[cfg(any(feature = "capture", test))]
            SourceOrigin::Local => None,
        }
    }

    async fn source_ready(&mut self, ready: SourceReady) -> Result<()> {
        #[cfg(feature = "capture")]
        if matches!(ready.source.origin, SourceOrigin::Local) {
            let captured_audio = ready.source.kind == MediaKind::Audio
                && self
                    .capture_audio
                    .get(&ready.source.publication_id)
                    .is_some_and(|(_, audio)| {
                        !audio.control.is_stopped() && audio.source() == Some(ready.source.id)
                    });
            if !captured_audio {
                let Some(capture) = self.local_producers.values_mut().find(|capture| {
                    capture.scope.publication_id == ready.source.publication_id
                        && capture.producer.owns(ready.source.id, ready.source.kind)
                }) else {
                    return Ok(());
                };
                if capture.producer.is_stopped() {
                    return Ok(());
                }
                if !capture.selected {
                    capture.prepared.push(ready);
                    return Ok(());
                }
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
                reader,
                ..
            } => {
                if self.incoming_source_flow(&source).is_none() {
                    return Ok(());
                }
                // A received successor replaces only its flow's encoded format.
                let old = self.sources.values().find_map(|old| match &old.origin {
                    SourceOrigin::Incoming {
                        pair: old_pair,
                        flow_id: old_flow,
                        reader,
                        ..
                    } if old.kind == source.kind && old_pair == pair && old_flow == flow_id => {
                        Some((old.id, *reader))
                    }
                    _ => None,
                });
                if let Some((old, old_reader)) = old {
                    self.sources.remove(&old);
                    self.relay.remove(old);
                    if old_reader != *reader {
                        if let Some(reader) =
                            self.pairs.get_mut(pair).unwrap().tasks.remove(&old_reader)
                        {
                            reader.task.abort();
                            let _ = reader.task.await;
                        }
                    }
                }
                Some((*pair, *flow_id))
            }
            #[cfg(any(feature = "capture", test))]
            SourceOrigin::Local => {
                #[cfg(feature = "capture")]
                let active = (source.kind == MediaKind::Audio && {
                    self.capture_audio
                        .get(&publication)
                        .is_some_and(|(_, audio)| {
                            !audio.control.is_stopped() && audio.source() == Some(source.id)
                        })
                }) || self.local_producers.values().any(|c| {
                    c.scope.publication_id == publication
                        && c.producer.owns(source.id, source.kind)
                        && c.selected
                        && !c.producer.is_stopped()
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
        if let Some(codec) = (incoming.is_some()
            || self.local_producers.values().any(|producer| {
                producer.producer.capture().is_none()
                    && producer.producer.owns(source.id, source.kind)
            }))
        .then(|| crate::media::derived_codec(&source.codec))
        .flatten()
        {
            if let SourceFeed::Video(video) = &source.feed {
                self.derived.insert(
                    source.id,
                    crate::media::derived::Producer::start(
                        publication,
                        source.id,
                        video.clone(),
                        codec,
                        self.publications[&publication].video_settings.map_or(
                            piik_channel_core::wire::DegradationPreference::Balanced,
                            |settings| settings.degradation_preference,
                        ),
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
        candidate: Some(c.to_sdp_string()),
        sdp_mid: Some(String::new()),
        sdp_m_line_index: Some(0),
        username_fragment: None,
    }
}
fn prepared_candidate(remote: std::net::SocketAddrV4) -> Result<Candidate> {
    let candidate = IceCandidate::host(remote.into(), "udp")?;
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
