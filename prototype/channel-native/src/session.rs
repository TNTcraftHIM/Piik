//! One explicit hosting session owns its signaling connection and native peers.
//! Room policy and route decisions remain in the shared core.
use crate::{
    backup::RoomSnapshot,
    capture::{Settings, Target},
    hosted_room::{storage_error, HostedRoom},
    peer::{
        CaptureInput, CaptureLease, CaptureScope, InputAuthority, NativeConnectionMetrics,
        NativeEvent, NativePeers, PreparedExternal,
    },
};
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use piik_channel_core::{
    backup::OwnCredential,
    conversation::{self, ConversationReply, SessionSigner, SignedPacket},
};
use piik_channel_core::{
    host::{RoomResult, RoomSummary},
    wire::{
        Command, Event, Kind, PublicationInput, Room, RoomAccess, RoomDelivery, Snapshot,
        VideoSettings,
    },
    RoomState, RECOVERY_MS,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    path::PathBuf,
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot, watch},
    time::{self, Instant},
};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use uuid::Uuid;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Writer<'a> = dyn futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
    + Send
    + Unpin
    + 'a;

// Raw backlog policy: admits one maximum wire frame; decoded state is not queued.
const SIGNALING_QUEUE_BYTES: usize = 4 * 1024 * 1024;

struct Incoming {
    text: tokio_tungstenite::tungstenite::Utf8Bytes,
    _budget: tokio::sync::OwnedSemaphorePermit,
}

async fn read_messages(
    reader: &mut (impl futures_util::Stream<
        Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>,
    > + Unpin),
    messages: mpsc::Sender<Incoming>,
) -> Result<()> {
    // Pending frames and the active raw permit share this connection's byte budget.
    let budget = Arc::new(tokio::sync::Semaphore::new(
        SIGNALING_QUEUE_BYTES + std::mem::size_of::<Incoming>(),
    ));
    loop {
        let message = time::timeout(SIGNALING_IDLE_TIMEOUT, reader.next()).await?;
        match message {
            Some(Ok(Message::Text(text))) => {
                let charge = text.len() + std::mem::size_of::<Incoming>();
                let permit = budget
                    .clone()
                    .try_acquire_many_owned(charge.try_into()?)
                    .map_err(|_| anyhow!("native_signaling_backpressure"))?;
                messages
                    .try_send(Incoming {
                        text,
                        _budget: permit,
                    })
                    .map_err(|_| anyhow!("native_signaling_backpressure"))?;
            }
            // tungstenite queues Pong itself; the next read flushes it.
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Err(error)) => return Err(error.into()),
            _ => return Ok(()),
        }
    }
}

const SIGNALING_IDLE_TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(test)]
mod composition_tests;
#[cfg(test)]
mod connection_tests;
#[cfg(test)]
mod hosting_ready_tests;
#[cfg(all(test, feature = "capture"))]
mod tests;

fn new_signer() -> Result<SessionSigner> {
    let mut seed = [0; 32];
    getrandom::fill(&mut seed)
        .map_err(|error| anyhow!("session key generation failed: {error}"))?;
    Ok(SessionSigner::from_seed(seed))
}

struct RoomTurns {
    local: Uuid,
    rooms: BTreeMap<String, HostedRoom>,
    signer: Arc<SessionSigner>,
    snapshot: watch::Sender<Option<Snapshot>>,
}
impl RoomTurns {
    fn receive(&mut self, packet: SignedPacket) -> Result<Vec<Command>> {
        let current = self.snapshot.borrow();
        let snapshot = current
            .as_ref()
            .ok_or_else(|| anyhow!("room_unavailable"))?;
        // The writer can serve a private room without receiving a personal directory view.
        let sender = snapshot
            .sessions
            .iter()
            .find(|session| session.id == packet.sender)
            .ok_or_else(|| anyhow!("session_expired"))?;
        let address = conversation::verify_address(&packet, sender.signing_key)
            .map_err(anyhow::Error::msg)?;
        if address.recipient != self.local {
            bail!("invalid_conversation_scope");
        }
        drop(current);
        let hosted = self
            .rooms
            .get_mut(&address.room_id)
            .filter(|host| host.binding() == Some(address.binding_id))
            .ok_or_else(|| anyhow!("room_host_offline"))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut outcome = hosted
            .dispatch_peer(&packet, now)
            .map_err(anyhow::Error::msg)?;
        let address = outcome.address.reply();
        let mut commands = Vec::new();
        if let Some(output) = outcome.projection_update.take() {
            commands.push(Command::HostOutput {
                room_id: address.room_id.clone(),
                output,
            });
        }
        let mut replies = outcome.replies().map_err(anyhow::Error::msg)?;
        if let Some(record) = replies.iter().find_map(|reply| reply.record.broadcast()) {
            for reader in hosted.current_readers() {
                if reader != address.recipient {
                    replies.push(ConversationReply {
                        address: conversation::ConversationAddress {
                            recipient: reader,
                            ..address.clone()
                        },
                        record: record.clone(),
                    });
                }
            }
        }
        for reply in replies {
            if reply.address.recipient == self.local && address.recipient != self.local {
                continue;
            }
            let packet = self
                .signer
                .sign(self.local, &reply)
                .map_err(anyhow::Error::msg)?;
            commands.push(Command::Conversation { packet });
        }
        Ok(commands)
    }
    fn disconnected(&mut self) {
        self.snapshot.send_replace(None);
    }
}

async fn process_peer(
    event: NativeEvent,
    pairs: &BTreeSet<Uuid>,
    room: &mut RoomTurns,
    peers: &NativePeers,
    socket: &mut Writer<'_>,
) -> Result<()> {
    match event {
        NativeEvent::Command(command) if current(pairs, &command) => {
            write(socket, &command, None).await?
        }
        NativeEvent::CaptureEnded {
            publication_id,
            error,
            ..
        } => {
            if let Some(error) = error {
                eprintln!("Native capture ended: {error}");
            }
            let owned = room.snapshot.borrow().as_ref().is_some_and(|state| {
                state
                    .publications
                    .iter()
                    .any(|p| p.id == publication_id && p.session_id == room.local)
            });
            if owned
                && !peers
                    .capture_publications()
                    .await?
                    .contains(&publication_id)
            {
                write(socket, &Command::Unpublish { publication_id }, None).await?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub struct Config {
    pub url: String,
    pub origin: String,
    pub name: String,
    pub owner_key: Option<String>,
    pub credential: Option<String>,
    pub server_udp: Option<Arc<crate::peer::server_udp::ServerUdp>>,
}

/// Trusted paths supplied by the explicit hosting caller. Existing files restore
/// their policy; a missing file creates a public room for the admitted identity.
pub struct RoomFile {
    pub path: PathBuf,
    pub id: String,
    // Creation defaults for explicitly configured files; discoveries leave this
    // empty so a missing saved database is never recreated without its history.
    pub name: String,
    pub bootstrap: bool,
}

struct Live {
    forwarding_budget: piik_channel_core::forwarding::ForwardingBudget,
    session: Uuid,
    room: RoomTurns,
    peers: NativePeers,
    commands: mpsc::Receiver<NativeEvent>,
    pairs: BTreeSet<Uuid>,
}

struct Session {
    forwarding_limit: Option<u8>,
    snapshot_job: Option<SnapshotJob>,
    config: Config,
    service_admission: Option<mpsc::Sender<ServiceAdmission>>,
    files: Vec<RoomFile>,
    live: Option<Live>,
    recovery: Option<Instant>,
    signer: Arc<SessionSigner>,
    hosting: Option<Hosting>,
    opening: BTreeMap<String, OpeningRoom>,
    pending_captures: BTreeMap<String, PendingCapture>,
}

pub struct OpenRoom {
    pub policy: RoomState,
    pub result: oneshot::Sender<Result<RoomSummary, String>>,
}

pub type ServiceAdmission = (
    piik_channel_core::host::ServiceEndpoint,
    oneshot::Sender<()>,
);

struct OpeningRoom {
    request_id: String,
    work: OpeningWork,
}
enum OpeningWork {
    Register {
        previous_binding: Option<Uuid>,
        replies: Vec<OpeningReply>,
        unpublished_copy: bool,
    },
    AdmitRestore(RestoreRoom),
    Create(RoomFile),
}
struct OpeningReply {
    result: oneshot::Sender<Result<RoomSummary, String>>,
    committed_error: Option<&'static str>,
}
impl OpeningReply {
    fn finish(self, result: Result<RoomSummary, String>) {
        let result = result.map_err(|code| self.committed_error.map(str::to_owned).unwrap_or(code));
        let _ = self.result.send(result);
    }
}
impl OpeningRoom {
    fn fail(self, code: &str) {
        match self.work {
            OpeningWork::Register { replies, .. } => {
                for reply in replies {
                    reply.finish(Err(code.into()));
                }
            }
            OpeningWork::AdmitRestore(request) => {
                let _ = request.result.send(Err(code.into()));
            }
            OpeningWork::Create(_) => eprintln!("Native room creation failed: {code}"),
        }
    }
}

pub struct SnapshotRoom {
    pub room_id: String,
    pub creator: Option<Uuid>,
    pub own_credential: Option<OwnCredential>,
    pub result: oneshot::Sender<Result<RoomSnapshot, String>>,
}

struct SnapshotJob {
    cancel: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}
impl SnapshotJob {
    async fn join(&mut self) {
        if let Err(error) = (&mut self.task).await {
            eprintln!("Snapshot worker failed: {error}");
        }
    }
}
impl Drop for SnapshotJob {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

/// The authenticated room target owns the scratch slot through staging and installation.
pub struct ExistingRoomRestore {
    pub room_id: String,
    pub creator: Uuid,
    pub scratch: tokio::sync::OwnedSemaphorePermit,
}

pub struct RestoreRoom {
    pub snapshot: RoomSnapshot,
    pub existing: Option<ExistingRoomRestore>,
    pub result: oneshot::Sender<Result<RoomSummary, String>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostingDescription {
    pub session_id: Uuid,
    pub room_ids: Vec<String>,
}

pub struct PrepareCapture {
    pub publication_id: Uuid,
    pub room_id: String,
    pub target: Target,
    pub settings: Settings,
    pub codec_mode: crate::capture::VideoCodecMode,
    pub encoding_execution: crate::capture::EncodingExecution,
    pub audio: bool,
    pub show_capture_border: bool,
    pub exclude_audio: Option<Target>,
    pub replaces: Option<Uuid>,
    pub result: oneshot::Sender<Result<CaptureLease, String>>,
}

pub struct CommitCapture {
    pub scope: CaptureScope,
    pub capture_id: Uuid,
    pub replacing: bool,
    pub retaining: bool,
    pub video_settings: Option<VideoSettings>,
    pub result: oneshot::Sender<Result<CaptureInput, String>>,
}
pub struct PrepareExternal {
    pub publication_id: Uuid,
    pub room_id: String,
    pub offer: String,
    pub replaces: Option<Uuid>,
    pub result: oneshot::Sender<Result<PreparedExternal, String>>,
}
pub struct TransferSource {
    pub scope: CaptureScope,
    pub capture_id: Uuid,
    pub to_session_id: Uuid,
    pub result: oneshot::Sender<Result<(), String>>,
}
pub struct PauseCapture {
    pub scope: CaptureScope,
    pub capture_id: Uuid,
    pub paused: bool,
    pub result: oneshot::Sender<Result<(), String>>,
}
pub enum CaptureEdit {
    Title(Option<String>),
    DirectLimit(Option<u8>),
}
pub struct EditCapture {
    pub scope: CaptureScope,
    pub capture_id: Uuid,
    pub edit: CaptureEdit,
    pub result: oneshot::Sender<Result<(), String>>,
}
pub struct PublishCaptureSettings {
    pub scope: CaptureScope,
    pub capture_id: Uuid,
    pub settings: VideoSettings,
    pub result: oneshot::Sender<Result<(), String>>,
}
enum PendingCapture {
    Prepare(PrepareCapture),
    External(PrepareExternal),
    Authorize {
        publication_id: Uuid,
        room_id: String,
        result: oneshot::Sender<Result<InputAuthority, String>>,
    },
    Commit(CommitCapture),
    Transfer(TransferSource),
    Pause(PauseCapture),
    Edit(EditCapture),
    Settings(PublishCaptureSettings),
}
impl PendingCapture {
    fn scope(&self) -> Option<&CaptureScope> {
        match self {
            Self::Prepare(_) | Self::External(_) | Self::Authorize { .. } => None,
            Self::Commit(r) => Some(&r.scope),
            Self::Transfer(r) => Some(&r.scope),
            Self::Edit(r) => Some(&r.scope),
            Self::Pause(r) => Some(&r.scope),
            Self::Settings(r) => Some(&r.scope),
        }
    }
    fn room_id(&self) -> &str {
        match self {
            Self::Prepare(request) => &request.room_id,
            Self::External(request) => &request.room_id,
            Self::Authorize { room_id, .. } => room_id,
            _ => &self.scope().unwrap().room_id,
        }
    }
    fn publication_id(&self) -> Uuid {
        match self {
            Self::Prepare(request) => request.publication_id,
            Self::External(request) => request.publication_id,
            Self::Authorize { publication_id, .. } => *publication_id,
            _ => self.scope().unwrap().publication_id,
        }
    }
    fn closed(&self) -> bool {
        match self {
            Self::Prepare(request) => request.result.is_closed(),
            Self::External(request) => request.result.is_closed(),
            Self::Authorize { result, .. } => result.is_closed(),
            Self::Commit(r) => r.result.is_closed(),
            Self::Transfer(r) => r.result.is_closed(),
            Self::Edit(r) => r.result.is_closed(),
            Self::Pause(r) => r.result.is_closed(),
            Self::Settings(r) => r.result.is_closed(),
        }
    }
    fn fail(self, code: String) {
        match self {
            Self::Prepare(request) => {
                let _ = request.result.send(Err(code));
            }
            Self::External(request) => {
                let _ = request.result.send(Err(code));
            }
            Self::Authorize { result, .. } => {
                let _ = result.send(Err(code));
            }
            Self::Commit(r) => {
                let _ = r.result.send(Err(code));
            }
            Self::Transfer(r) => {
                let _ = r.result.send(Err(code));
            }
            Self::Edit(r) => {
                let _ = r.result.send(Err(code));
            }
            Self::Pause(r) => {
                let _ = r.result.send(Err(code));
            }
            Self::Settings(r) => {
                let _ = r.result.send(Err(code));
            }
        }
    }
}

// Current operations require availability; retained CaptureScope authority does not.
fn available_room<'a>(state: &'a Snapshot, room_id: &str) -> Option<(&'a Room, &'a RoomDelivery)> {
    let room = state
        .channel
        .rooms
        .iter()
        .find(|room| room.id == room_id && room.authorized && room.available)?;
    Some((room, room.delivery.as_ref()?))
}

fn capture_binding(state: &Snapshot, room_id: &str) -> Option<Uuid> {
    available_room(state, room_id).map(|(_, delivery)| delivery.binding_id)
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RelayCapacityRequest {
    Read {},
    Set {
        session_id: Uuid,
        capacity: Option<u8>,
    },
}
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayCapacityState {
    pub session_id: Uuid,
    pub relay_override: Option<u8>,
}
#[derive(Debug)]
pub struct WatchReaderRegistration {
    pub session_id: Uuid,
    pub retired: watch::Receiver<bool>,
}

pub enum HostCommand {
    RelayCapacity {
        request: RelayCapacityRequest,
        result: oneshot::Sender<Result<RelayCapacityState, String>>,
    },
    RegisterWatchReader {
        resource_id: Uuid,
        reader: Arc<dyn crate::watch::Reader>,
        result: oneshot::Sender<Result<WatchReaderRegistration, String>>,
    },
    RevokeWatchReader {
        resource_id: Uuid,
    },
    /// Exact current or recovery-retained identity, not hosting admission.
    LocalEndpoint(oneshot::Sender<Option<Uuid>>),
    Describe(oneshot::Sender<Result<HostingDescription, String>>),
    ConnectionMetrics {
        room_id: String,
        publication_id: Option<Uuid>,
        result: oneshot::Sender<Result<NativeConnectionMetrics, String>>,
    },
    Open(OpenRoom),
    CreateCopy {
        snapshot: RoomSnapshot,
        scratch: tokio::sync::OwnedSemaphorePermit,
        result: oneshot::Sender<Result<RoomSummary, String>>,
    },
    DeleteRetired {
        id: String,
        creator: Uuid,
        result: oneshot::Sender<bool>,
    },
    Snapshot(SnapshotRoom),
    Restore(RestoreRoom),
    PrepareCapture(PrepareCapture),
    PrepareExternal(PrepareExternal),
    AuthorizeInput {
        publication_id: Uuid,
        room_id: String,
        result: oneshot::Sender<Result<InputAuthority, String>>,
    },
    CommitCapture(CommitCapture),
    TransferSource(TransferSource),
    PauseCapture(PauseCapture),
    EditCapture(EditCapture),
    PublishCaptureSettings(PublishCaptureSettings),
}
impl HostCommand {
    fn unavailable(self, local_endpoint: Option<Uuid>) {
        match self {
            Self::LocalEndpoint(result) => {
                let _ = result.send(local_endpoint);
            }
            Self::RelayCapacity { result, .. } => {
                let _ = result.send(Err("hosting_unavailable".into()));
            }
            Self::RegisterWatchReader { result, .. } => {
                let _ = result.send(Err("hosting_unavailable".into()));
            }
            Self::RevokeWatchReader { .. } => {}
            Self::Describe(result) => {
                let _ = result.send(Err("hosting_unavailable".into()));
            }
            Self::ConnectionMetrics { result, .. } => {
                let _ = result.send(Err("hosting_unavailable".into()));
            }
            Self::DeleteRetired { result, .. } => {
                let _ = result.send(false);
            }
            Self::CreateCopy { result, .. } => {
                let _ = result.send(Err("hosting_unavailable".into()));
            }
            Self::Open(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
            Self::Snapshot(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
            Self::Restore(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
            Self::PrepareCapture(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
            Self::PrepareExternal(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
            Self::AuthorizeInput { result, .. } => {
                let _ = result.send(Err("hosting_unavailable".into()));
            }
            Self::CommitCapture(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
            Self::TransferSource(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
            Self::EditCapture(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
            Self::PauseCapture(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
            Self::PublishCaptureSettings(request) => {
                let _ = request.result.send(Err("hosting_unavailable".into()));
            }
        }
    }
}

pub struct Hosting {
    pub directory: PathBuf,
    pub identity: (Uuid, Uuid),
    pub commands: mpsc::Receiver<HostCommand>,
    pub ready: watch::Sender<Option<Result<(), String>>>,
    pub desktop: Option<crate::input::Desktop>,
}

impl Hosting {
    fn forwarding_limit(&self) -> Result<Option<u8>> {
        match std::fs::File::open(self.directory.join("forwarding-limit.json")) {
            Ok(file) => {
                let value: Option<u8> = serde_json::from_reader(file)?;
                anyhow::ensure!(
                    value.is_none_or(|n| n <= piik_channel_core::MAX_RELAY_CAPACITY),
                    "invalid_relay_capacity"
                );
                Ok(value)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}

/// The calling App or Server owns this hosting future independently of its pages.
pub async fn run(
    config: Config,
    files: Vec<RoomFile>,
    stop: impl Future<Output = ()> + Send,
) -> Result<()> {
    run_host(config, files, None, None, stop).await
}

pub async fn run_host(
    config: Config,
    files: Vec<RoomFile>,
    hosting: Option<Hosting>,
    service_admission: Option<mpsc::Sender<ServiceAdmission>>,
    stop: impl Future<Output = ()> + Send,
) -> Result<()> {
    let mut session = Session {
        forwarding_limit: None,
        config,
        service_admission,
        files,
        live: None,
        recovery: None,
        signer: Arc::new(new_signer()?),
        hosting,
        opening: BTreeMap::new(),
        pending_captures: BTreeMap::new(),

        snapshot_job: None,
    };
    let mut stop = std::pin::pin!(stop);
    let result = session.drive(&mut stop).await;
    session.fail_pending_requests("hosting_stopped");
    let closed = session.release().await;
    let error = result
        .as_ref()
        .err()
        .map(ToString::to_string)
        .unwrap_or_else(|| "hosting_stopped".into());
    if let Some(hosting) = &session.hosting {
        hosting.ready.send_replace(Some(Err(error.clone())));
    }
    for opening in session.opening.into_values() {
        opening.fail(&error);
    }
    result.and(closed)
}

impl Session {
    fn hosting_unready(&self) {
        if let Some(hosting) = &self.hosting {
            hosting.ready.send_replace(None);
        }
    }

    fn fail_pending_requests(&mut self, code: &str) {
        for request in std::mem::take(&mut self.pending_captures).into_values() {
            request.fail(code.into());
        }
    }

    async fn release(&mut self) -> Result<()> {
        self.hosting_unready();
        if let Some(snapshot) = &self.snapshot_job {
            snapshot.cancel.store(true, Ordering::Release);
        }
        self.fail_pending_requests("hosting_unavailable");
        let restoring: Vec<_> = self
            .opening
            .iter()
            .filter_map(|(id, opening)| {
                (!matches!(opening.work, OpeningWork::Register { .. })).then(|| id.clone())
            })
            .collect();
        for id in restoring {
            self.opening
                .remove(&id)
                .unwrap()
                .fail("hosting_unavailable");
        }
        // A canceled connection turn must leave the Driver's join owned here.
        let closed = if let Some(live) = self.live.as_mut() {
            live.room.disconnected();
            live.peers.close().await
        } else {
            Ok(())
        };
        self.live = None;
        self.recovery = None;
        if let Some(snapshot) = &mut self.snapshot_job {
            snapshot.join().await;
        }
        self.snapshot_job = None;
        closed
    }

    async fn drive(
        &mut self,
        stop: &mut (impl Future<Output = ()> + Unpin),
    ) -> Result<()> {
        loop {
            self.hosting_unready();
            let mut request = self.config.url.as_str().into_client_request()?;
            request
                .headers_mut()
                .insert("Origin", self.config.origin.parse()?);
            let limits = WebSocketConfig::default()
                .max_message_size(Some(piik_channel_core::wire::CHANNEL_MESSAGE_BYTES))
                .max_frame_size(Some(piik_channel_core::wire::CHANNEL_MESSAGE_BYTES));
            #[cfg(target_os = "android")]
            let connector = {
                use rustls_platform_verifier::BuilderVerifierExt;
                let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()?
                .with_platform_verifier()?
                .with_no_client_auth();
                Some(tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(
                    config,
                )))
            };
            #[cfg(not(target_os = "android"))]
            let connector = None;
            let connecting = time::timeout(
                Duration::from_secs(5),
                connect_async_tls_with_config(request, Some(limits), true, connector),
            );
            tokio::pin!(connecting);
            let connection = loop {
                tokio::select! {
                    _ = &mut *stop => return Ok(()),
                    _ = recovery_deadline(self.recovery) => { self.release().await?; },
                    command = next_host_command(&mut self.hosting) => {
                        command.ok_or_else(|| anyhow!("hosting_control_closed"))?
                            .unavailable(self.live.as_ref().map(|live| live.session));
                    },
                    result = &mut connecting => break result,
                }
            };
            if let Ok(Ok((mut socket, _))) = connection {
                let join = Command::Join {
                    protocol: piik_channel_core::wire::CHANNEL_PROTOCOL,
                    can_prepare_udp: self.config.server_udp.is_none(),
                    can_receive_video_layers: true,
                    name: self.config.name.clone(),
                    credential: self.config.credential.clone(),
                    owner_key: self.config.owner_key.clone(),
                    session_id: self.live.as_ref().map(|live| live.session.to_string()),
                    signing_key: self.signer.signing_key(),
                };
                let result = self.connected(&mut socket, join, stop).await;
                for opening in self.opening.values_mut() {
                    if let OpeningWork::Register {
                        unpublished_copy, ..
                    } = &mut opening.work
                    {
                        // The authority may have accepted registration before the link closed.
                        *unpublished_copy = false;
                    }
                }
                self.hosting_unready();
                self.fail_pending_requests("disconnected");
                if let Some(live) = &mut self.live {
                    live.room.disconnected();
                }
                let result = if matches!(result, Ok(false))
                    && self
                        .opening
                        .values()
                        .any(|opening| matches!(opening.work, OpeningWork::Create(_)))
                {
                    Err(anyhow!("room_creation_interrupted: the domain did not confirm this creation; restart explicitly to try again"))
                } else {
                    result
                };
                if !matches!(result, Ok(false)) {
                    let released = self.release().await;
                    leave(&mut socket).await;
                    return result.map(|_| ()).and(released);
                }
            }
            if self.live.is_some() && self.recovery.is_none() {
                self.recovery = Some(Instant::now() + Duration::from_millis(RECOVERY_MS));
            }
            let delay = time::sleep(Duration::from_secs(1));
            tokio::pin!(delay);
            loop {
                tokio::select! {
                    _ = &mut *stop => return Ok(()),
                    _ = recovery_deadline(self.recovery) => self.release().await?,
                    command = next_host_command(&mut self.hosting) => {
                        command.ok_or_else(|| anyhow!("hosting_control_closed"))?
                            .unavailable(self.live.as_ref().map(|live| live.session));
                    },
                    _ = &mut delay => break,
                }
            }
        }
    }

    /// true: caller stopped; false: connection lost, attempt the existing resume.
    async fn connected<S>(
        &mut self,
        socket: &mut WebSocketStream<S>,
        join: Command,
        stop: &mut (impl Future<Output = ()> + Unpin),
    ) -> Result<bool>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    {
        // Preserve the original initial-command ordering before a split reader
        // can consume a server rejection followed immediately by Close.
        tokio::select! {
            _ = &mut *stop => return Ok(true),
            _ = recovery_deadline(self.recovery) => {
                self.release().await?;
                return Ok(false);
            },
            result = write(socket, &join, None) => if let Err(error) = result {
                return if error.downcast_ref::<tokio_tungstenite::tungstenite::Error>().is_some() {
                    Ok(false)
                } else { Err(error) };
            },
        }
        let (mut writer, mut reader) = socket.split();
        let capacity = SIGNALING_QUEUE_BYTES / std::mem::size_of::<Incoming>() + 1;
        let (messages, mut incoming) = mpsc::channel(capacity);
        let (ended, end) = watch::channel(None);
        let reading = async {
            let result = read_messages(&mut reader, messages).await;
            ended.send_replace(Some(Instant::now()));
            if let Err(error) = result {
                // Tungstenite's UTF-8 error can contain bytes from the private message.
                if matches!(
                    error.downcast_ref::<tokio_tungstenite::tungstenite::Error>(),
                    Some(tokio_tungstenite::tungstenite::Error::Utf8(_))
                ) {
                    eprintln!("Native signaling reader stopped: invalid UTF-8 message");
                } else {
                    eprintln!("Native signaling reader stopped: {error}");
                }
            }
            // Sender closure is ordered behind accepted application frames. Keep
            // the reader outcome alive until the business owner retires this turn.
            std::future::pending::<()>().await;
        };
        tokio::select! {
            _ = reading => unreachable!(),
            result = self.connected_messages(&mut writer, &mut incoming, end, stop) => result,
        }
    }

    async fn connected_messages(
        &mut self,
        socket: &mut Writer<'_>,
        incoming: &mut mpsc::Receiver<Incoming>,
        carrier_end: watch::Receiver<Option<Instant>>,
        stop: &mut (impl Future<Output = ()> + Unpin),
    ) -> Result<bool> {
        enum Step {
            Stop,
            Expired,
            Work(Result<bool>),
        }
        let mut pending = None;
        let mut admitted = false;
        let mut images = piik_channel_core::wire_images::StateImageDecoder::default();
        loop {
            let recovery = self.recovery;
            // Stop and authority expiry still cover pending business work.
            // The concurrent reader owns carrier liveness. Welcome ends recovery
            // before its projection starts a peer turn.
            let step = {
                let work = async {
                    if let Some((event, _budget)) = pending.take() {
                        self.event(event, socket).await?;
                        return Ok(true);
                    }
                    tokio::select! {
                        request = next_host_command(&mut self.hosting) => {
                            let request = request.ok_or_else(|| anyhow!("hosting_control_closed"))?;
                            if !admitted { request.unavailable(self.live.as_ref().map(|live| live.session)); }
                            else { match request {
                                HostCommand::LocalEndpoint(result) => {
                                    let _ = result.send(self.live.as_ref().map(|live| live.session));
                                },
                                HostCommand::RelayCapacity { request, result } => self.relay_capacity(request, result, socket).await?,
                                HostCommand::RegisterWatchReader { resource_id, reader, result } => {
                                    let registered = if let Some(live) = &mut self.live {
                                        await_peer(live.peers.register_watch_reader(resource_id, reader), &mut live.commands, &live.pairs, &mut live.room, &live.peers, socket).await.map(|retired| WatchReaderRegistration { session_id: live.session, retired }).map_err(|error| error.to_string())
                                    } else { Err("hosting_unavailable".into()) };
                                    let _ = result.send(registered);
                                },
                                HostCommand::RevokeWatchReader { resource_id } => {
                                    if let Some(live) = &self.live { live.peers.revoke_watch_reader(resource_id).await?; }
                                },
                                HostCommand::Describe(result) => {
                                    let _ = result.send(self.hosting_description());
                                },
                                HostCommand::ConnectionMetrics { room_id, publication_id, result } => {
                                    let measured = self.connection_metrics(&room_id, publication_id, socket).await.map_err(|error| error.to_string());
                                    let _ = result.send(measured);
                                },
                                HostCommand::DeleteRetired { id, creator, result } => {
                                    let removed = self.delete_retired_room(&id, creator).is_ok();
                                    let _ = result.send(removed);
                                }
                                HostCommand::Open(request) => self.open_room(request, None, socket).await?,
                                HostCommand::CreateCopy { snapshot, scratch: _scratch, result } => {
                                    let request = OpenRoom { policy: snapshot.room.metadata().policy.clone(), result };
                                    self.open_room(request, Some(snapshot), socket).await?;
                                }
                                HostCommand::Snapshot(request) => self.snapshot_room(request).await,
                                HostCommand::Restore(request) => self.restore_room(request, socket).await?,
                                HostCommand::PrepareCapture(request) => self.prepare_capture(request, socket).await?,
                                HostCommand::PrepareExternal(request) => self.prepare_external(request, socket).await?,
                                HostCommand::AuthorizeInput { publication_id, room_id, result } => self.authorize_input(publication_id, room_id, result, socket).await?,
                                HostCommand::CommitCapture(request) => self.commit_capture(request, socket).await?,
                                HostCommand::TransferSource(request) => self.transfer_source(request, socket).await?,
                                HostCommand::EditCapture(request) => self.edit_capture(request, socket).await?,
                                HostCommand::PauseCapture(request) => self.pause_capture(request, socket).await?,
                                HostCommand::PublishCaptureSettings(request) => self.publish_capture_settings(request, socket).await?,
                            } }
                        },
                        command = next_command(&mut self.live), if admitted => {
                            let command = command.ok_or_else(|| anyhow!("native_peer_stopped"))?;
                            if let Some(live) = &mut self.live {
                                process_peer(command, &live.pairs, &mut live.room, &live.peers, socket).await?;
                            }
                        },
                        message = incoming.recv() => {
                            match message {
                                Some(Incoming { text, _budget }) => {
                                    let event = images.decode(&text).map_err(anyhow::Error::msg)?;
                                    if matches!(event, Event::Welcome { .. }) {
                                        admitted = true;
                                        self.recovery = None;
                                    }
                                    if let Event::Error { code, .. } = &event {
                                        if !admitted { bail!("admission failed: {code}"); }
                                    }
                                    pending = Some((event, _budget));
                                },
                                _ => return Ok(false),
                            }
                        },
                    }
                    Ok(true)
                };
                tokio::select! {
                    biased;
                    _ = &mut *stop => Step::Stop,
                    _ = carrier_recovery_deadline(recovery, carrier_end.clone()) => Step::Expired,
                    result = work => Step::Work(result),
                }
            };
            if let Some(ended) = *carrier_end.borrow() {
                if self.live.is_some() {
                    let expires = ended + Duration::from_millis(RECOVERY_MS);
                    self.recovery = Some(self.recovery.map_or(expires, |at| at.min(expires)));
                }
            }
            match step {
                Step::Stop => return Ok(true),
                Step::Expired => {
                    self.release().await?;
                    return Ok(false);
                }
                Step::Work(Ok(false)) => return Ok(false),
                Step::Work(Err(error)) => {
                    if error
                        .downcast_ref::<tokio_tungstenite::tungstenite::Error>()
                        .is_some()
                    {
                        return Ok(false);
                    }
                    return Err(error);
                }
                Step::Work(Ok(true)) => {}
            }
        }
    }

    async fn relay_capacity(
        &mut self,
        request: RelayCapacityRequest,
        result: oneshot::Sender<Result<RelayCapacityState, String>>,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if result.is_closed() {
            return Ok(());
        }
        let response = async {
            let live = self
                .live
                .as_ref()
                .ok_or_else(|| anyhow!("hosting_unavailable"))?;
            let session_id = live.session;
            if let RelayCapacityRequest::Set {
                session_id: expected,
                capacity,
            } = request
            {
                anyhow::ensure!(expected == session_id, "app_context_changed");
                anyhow::ensure!(
                    capacity.is_none_or(|n| n <= piik_channel_core::MAX_RELAY_CAPACITY),
                    "invalid_relay_capacity"
                );
                let hosting = self
                    .hosting
                    .as_ref()
                    .ok_or_else(|| anyhow!("hosting_unavailable"))?;
                let file = tempfile::NamedTempFile::new_in(&hosting.directory)?;
                serde_json::to_writer(file.as_file(), &capacity)?;
                file.persist(hosting.directory.join("forwarding-limit.json"))?;
                self.set_forwarding_limit(capacity, socket).await?;
            }
            Ok::<_, anyhow::Error>(RelayCapacityState {
                session_id,
                relay_override: self.forwarding_limit,
            })
        }
        .await;
        let _ = result.send(response.map_err(|e| e.to_string()));
        Ok(())
    }
    async fn connection_metrics(
        &mut self,
        room_id: &str,
        publication_id: Option<Uuid>,
        socket: &mut Writer<'_>,
    ) -> Result<NativeConnectionMetrics> {
        let live = self
            .live
            .as_mut()
            .ok_or_else(|| anyhow!("hosting_unavailable"))?;
        let binding = |state: &Snapshot| -> Result<Uuid> {
            let binding =
                capture_binding(state, room_id).ok_or_else(|| anyhow!("room_unavailable"))?;
            if publication_id.is_some_and(|id| {
                !state.publications.iter().any(|publication| {
                    publication.id == id
                        && publication.room_id == room_id
                        && publication.kind == Kind::Screen
                })
            }) {
                bail!("publication_unavailable");
            }
            Ok(binding)
        };
        let binding_id = binding(
            live.room
                .snapshot
                .borrow()
                .as_ref()
                .ok_or_else(|| anyhow!("hosting_unavailable"))?,
        )?;
        let mut connections = await_peer(
            live.peers
                .connection_metrics(room_id.into(), publication_id),
            &mut live.commands,
            &live.pairs,
            &mut live.room,
            &live.peers,
            socket,
        )
        .await?;
        let snapshot = live.room.snapshot.borrow();
        let state = snapshot
            .as_ref()
            .ok_or_else(|| anyhow!("hosting_unavailable"))?;
        if binding(state)? != binding_id {
            bail!("room_context_changed");
        }
        connections.retain_mut(|connection| {
            let Some(pair) = state
                .pairs
                .iter()
                .find(|pair| pair.id == connection.pair_id && pair.peer_id == connection.peer_id)
            else {
                return false;
            };
            connection.streams.retain(|stream| {
                let flows = if stream.direction == "send" {
                    &pair.outgoing
                } else {
                    &pair.incoming
                };
                flows.iter().any(|flow| {
                    flow.id == stream.flow_id
                        && flow.publication_id == stream.publication_id
                        && flow.selected == stream.selected
                }) && state.publications.iter().any(|publication| {
                    publication.id == stream.publication_id && publication.room_id == room_id
                })
            });
            !connection.streams.is_empty()
                || (publication_id.is_none() && pair.rooms.iter().any(|id| id == room_id))
        });
        Ok(NativeConnectionMetrics {
            session_id: live.session,
            binding_id,
            connections,
        })
    }
    async fn event(&mut self, event: Event, socket: &mut Writer<'_>) -> Result<()> {
        match event {
            Event::Welcome {
                credential,
                session_id,
                connection_id,
                state,
                ..
            } => {
                let user = state
                    .sessions
                    .iter()
                    .find(|session| session.id == session_id)
                    .ok_or_else(|| anyhow!("welcome omitted current session"))?
                    .user_id;
                if let Some(hosting) = &self.hosting {
                    if hosting.identity != (state.channel.id, user) {
                        bail!("owner_mismatch");
                    }
                    // No local room is opened until the actual domain admission agrees.
                    std::fs::create_dir_all(&hosting.directory)?;
                    self.forwarding_limit = hosting.forwarding_limit()?;
                    for file in stored_rooms(&hosting.directory)? {
                        if !self.files.iter().any(|known| known.path == file.path) {
                            self.files.push(file);
                        }
                    }
                }
                self.config.credential = Some(credential);
                let resumed = self
                    .live
                    .as_ref()
                    .is_some_and(|live| live.session == session_id);
                let mut new_rooms = BTreeSet::new();
                let mut creating = Vec::new();
                if !resumed {
                    self.release().await?;
                    let mut rooms = BTreeMap::new();
                    for mut file in std::mem::take(&mut self.files) {
                        let host = match std::fs::metadata(&file.path) {
                            Ok(_) => {
                                let policy = match stored_room_policy(&file.path) {
                                    Ok(Some(policy)) => policy,
                                    Ok(None) => continue,
                                    Err(error) if room_data_unavailable(&file.path, &error) => {
                                        continue
                                    }
                                    Err(error) => return Err(error),
                                };
                                file.id = policy.id;
                                if !state.channel.rooms.iter().any(|room| room.id == file.id)
                                    && !(self.service_admission.is_some()
                                        && state.channel.managed_room_ids.contains(&file.id))
                                {
                                    if file.bootstrap {
                                        new_rooms.insert(file.id.clone());
                                    } else {
                                        self.files.push(file);
                                        continue;
                                    }
                                }
                                let creator = if self.service_admission.is_some()
                                    && state.channel.hosting_mode
                                        == piik_channel_core::wire::HostingMode::Hosted
                                {
                                    policy.creator_id
                                } else {
                                    user
                                };
                                HostedRoom::open(&file.path, &file.id, creator)
                            }
                            Err(error)
                                if error.kind() == std::io::ErrorKind::NotFound
                                    && !file.name.is_empty() =>
                            {
                                let policy = RoomState::new(
                                    file.id.clone(),
                                    file.name.clone(),
                                    Default::default(),
                                    user,
                                    RoomAccess::Public,
                                    false,
                                    None,
                                )
                                .map_err(anyhow::Error::msg)?;
                                if !file.bootstrap {
                                    let request_id = Uuid::new_v4().to_string();
                                    creating.push((
                                        request_id.clone(),
                                        RoomSummary::from_policy(&policy),
                                    ));
                                    self.opening.insert(
                                        file.id.clone(),
                                        OpeningRoom {
                                            request_id,
                                            work: OpeningWork::Create(file),
                                        },
                                    );
                                    continue;
                                }
                                new_rooms.insert(file.id.clone());
                                HostedRoom::create(&file.path, policy)
                            }
                            Err(error) => Err(error.into()),
                        };
                        let host = match host {
                            Ok(host) => host,
                            Err(error) if error.to_string() == "room_not_found" => continue,
                            Err(error) if room_data_unavailable(&file.path, &error) => continue,
                            Err(error) => return Err(error),
                        };
                        if rooms.insert(file.id.clone(), host).is_some() {
                            bail!("duplicate room id");
                        }
                        self.files.push(file);
                    }
                    // Only reopened rooms will receive a registration reply on this session.
                    for (_, opening) in self.opening.extract_if(.., |id, opening| {
                        matches!(opening.work, OpeningWork::Register { .. })
                            && !rooms.contains_key(id)
                    }) {
                        opening.fail("room_unavailable");
                    }
                    let ice = state
                        .ice_servers
                        .iter()
                        .cloned()
                        .map(ice_server)
                        .collect::<Result<Vec<_>, _>>()?;
                    let (commands, receiver) = mpsc::channel(64);
                    let snapshot = watch::channel(None).0;
                    let peers = NativePeers::with_input(
                        session_id,
                        ice,
                        commands,
                        snapshot.subscribe(),
                        self.hosting
                            .as_ref()
                            .and_then(|hosting| hosting.desktop.clone()),
                        self.config.server_udp.clone(),
                    );
                    self.live = Some(Live {
                        forwarding_budget: Default::default(),
                        session: session_id,
                        room: RoomTurns {
                            rooms,
                            local: session_id,
                            signer: self.signer.clone(),
                            snapshot,
                        },
                        peers,
                        commands: receiver,
                        pairs: BTreeSet::new(),
                    });
                }
                self.recovery = None;
                self.state(state, socket).await?;
                if let Some(admission) = &self.service_admission {
                    let (ack, registered) = oneshot::channel();
                    admission
                        .send((
                            piik_channel_core::host::ServiceEndpoint {
                                session_id,
                                connection_id,
                            },
                            ack,
                        ))
                        .await
                        .map_err(|_| anyhow!("service_registration_closed"))?;
                    registered
                        .await
                        .map_err(|_| anyhow!("service_registration_closed"))?;
                }
                if resumed {
                    let live = self.live.as_mut().unwrap();
                    await_peer(
                        live.peers.resync(),
                        &mut live.commands,
                        &live.pairs,
                        &mut live.room,
                        &live.peers,
                        socket,
                    )
                    .await?;
                }
                for (id, hosted) in &mut self.live.as_mut().unwrap().room.rooms {
                    if new_rooms.contains(id) {
                        write(
                            socket,
                            &Command::AdmitRoom {
                                room: hosted.summary(),
                            },
                            None,
                        )
                        .await?;
                    }
                    write(
                        socket,
                        &Command::HostRegister {
                            room: hosted.summary(),
                            resume_binding: hosted.binding(),
                        },
                        Some(
                            self.opening
                                .get(id)
                                .map_or(id.as_str(), |opening| opening.request_id.as_str()),
                        ),
                    )
                    .await?;
                }
                for (request_id, room) in creating {
                    write(
                        socket,
                        &Command::CreateRoom {
                            room,
                            picture: None,
                            password: None,
                            allow_service_relay: false,
                        },
                        Some(&request_id),
                    )
                    .await?;
                }
                let restoring: Vec<_> = self
                    .opening
                    .values()
                    .filter_map(|opening| match &opening.work {
                        OpeningWork::AdmitRestore(request) => Some((
                            opening.request_id.clone(),
                            RoomSummary::from_policy(&request.snapshot.room.metadata().policy),
                        )),
                        _ => None,
                    })
                    .collect();
                for (request_id, room) in restoring {
                    write(socket, &Command::AdmitRoom { room }, Some(&request_id)).await?;
                }
                self.hosting_ready();
                eprintln!(
                    "Native session admitted ({})",
                    if resumed { "resumed" } else { "new" }
                );
            }
            Event::State { state } => self.state(state, socket).await?,
            Event::InputState { registrations } => {
                if let Some(live) = &mut self.live {
                    await_peer(
                        live.peers.input_registrations(registrations),
                        &mut live.commands,
                        &live.pairs,
                        &mut live.room,
                        &live.peers,
                        socket,
                    )
                    .await?;
                }
            }
            Event::HostBound {
                room_id,
                binding_id,
            } => {
                if self
                    .opening
                    .get(&room_id)
                    .is_some_and(|opening| matches!(opening.work, OpeningWork::Register { previous_binding: Some(previous), .. } if previous == binding_id))
                {
                    return Ok(());
                }
                if let Some(hosted) = self
                    .live
                    .as_mut()
                    .and_then(|live| live.room.rooms.get_mut(&room_id))
                {
                    if let Some(OpeningRoom {
                        work:
                            OpeningWork::Register {
                                unpublished_copy, ..
                            },
                        ..
                    }) = self.opening.get_mut(&room_id)
                    {
                        *unpublished_copy = false;
                    }
                    hosted.bind(binding_id)?;
                    eprintln!("Native room bound: {room_id}");
                }
                self.hosting_ready();
            }
            Event::RoomCreated {
                room,
                request_id: Some(request_id),
            } => {
                let pending = self.opening.iter().find_map(|(id, opening)| {
                    (opening.request_id == request_id
                        && matches!(opening.work, OpeningWork::Create(_)))
                    .then(|| id.clone())
                });
                if let Some(pending) = pending {
                    let OpeningWork::Create(mut file) = self.opening.remove(&pending).unwrap().work
                    else {
                        unreachable!()
                    };
                    let mut policy = RoomState::new(
                        room.id.clone(),
                        room.name.clone(),
                        room.icon.clone(),
                        room.creator_id,
                        room.access,
                        room.hidden,
                        None,
                    )
                    .map_err(anyhow::Error::msg)?;
                    policy.relay_capacity = room.relay_capacity;
                    let host = HostedRoom::create(&file.path, policy)?;
                    file.id = room.id.clone();
                    self.files.push(file);
                    if let Some(live) = &mut self.live {
                        live.room.rooms.insert(room.id.clone(), host);
                    }
                    write(
                        socket,
                        &Command::HostRegister {
                            room: room.clone(),
                            resume_binding: None,
                        },
                        Some(&room.id),
                    )
                    .await?;
                }
            }
            Event::Ack { request_id: id } => {
                let room_id = self
                    .opening
                    .iter()
                    .find_map(|(room, opening)| (opening.request_id == id).then(|| room.clone()));
                if let Some(room_id) = room_id {
                    let opening = self.opening.remove(&room_id).unwrap();
                    let replies = match opening.work {
                        OpeningWork::AdmitRestore(request) => {
                            self.install_room_backup(request, socket).await?;
                            return Ok(());
                        }
                        OpeningWork::Register { replies, .. } => replies,
                        OpeningWork::Create(_) => return Ok(()),
                    };
                    let summary = self
                        .live
                        .as_ref()
                        .and_then(|live| live.room.rooms.get(&room_id))
                        .filter(|host| host.binding().is_some())
                        .map(HostedRoom::summary);
                    for reply in replies {
                        reply.finish(summary.clone().ok_or_else(|| "room_unavailable".into()));
                    }
                }
            }
            Event::Conversation { packet } => {
                if let Some(live) = &mut self.live {
                    match live.room.receive(packet) {
                        Ok(commands) => {
                            for command in commands {
                                write(socket, &command, None).await?;
                            }
                        }
                        Err(error) => eprintln!("Native conversation unavailable: {error}"),
                    }
                }
            }
            Event::HostInput { room_id, input } => {
                if let Some(live) = &mut self.live {
                    if let Some(hosted) = live.room.rooms.get_mut(&room_id) {
                        if hosted.binding() == Some(input.binding_id)
                            && live.session == input.host_session_id
                        {
                            let output = hosted.dispatch(input).map_err(anyhow::Error::msg)?;
                            if output.reply.as_ref().is_some_and(|reply| {
                                matches!(reply.result, RoomResult::Deleted { data_removed: true })
                            }) {
                                live.room.rooms.remove(&room_id);
                                self.files.retain(|file| file.id != room_id);
                            }
                            write(socket, &Command::HostOutput { room_id, output }, None).await?;
                        }
                    }
                }
            }
            Event::Signal {
                pair_id, payload, ..
            } => {
                if let Some(live) = &mut self.live {
                    if live.pairs.contains(&pair_id) {
                        await_peer(
                            live.peers.signal(pair_id, payload),
                            &mut live.commands,
                            &live.pairs,
                            &mut live.room,
                            &live.peers,
                            socket,
                        )
                        .await?;
                    }
                }
            }
            Event::RoomReply {
                room_id,
                request_id: Some(id),
                result,
            } => {
                if self
                    .pending_captures
                    .get(&id)
                    .is_some_and(|pending| pending.room_id() == room_id)
                {
                    let request = self.pending_captures.remove(&id).unwrap();
                    match (request, result) {
                        (PendingCapture::Prepare(request), RoomResult::Done) => {
                            self.prepare_source(request, socket).await?
                        }
                        (PendingCapture::External(request), RoomResult::Done) => {
                            self.prepare_external_source(request, socket).await?
                        }
                        (
                            PendingCapture::Authorize {
                                publication_id,
                                room_id,
                                result,
                            },
                            RoomResult::Done,
                        ) => {
                            let authority =
                                self.live
                                    .as_ref()
                                    .and_then(|live| {
                                        let binding_id =
                                            live.room.snapshot.borrow().as_ref().and_then(
                                                |state| capture_binding(state, &room_id),
                                            )?;
                                        Some(InputAuthority {
                                            scope: CaptureScope {
                                                publication_id,
                                                room_id,
                                                binding_id,
                                            },
                                            snapshot: live.room.snapshot.subscribe(),
                                        })
                                    })
                                    .ok_or_else(|| "room_unavailable".to_string());
                            let _ = result.send(authority);
                        }
                        (PendingCapture::Commit(request), RoomResult::Done) => {
                            self.finish_capture(request, socket).await?
                        }
                        (PendingCapture::Transfer(request), RoomResult::Done) => {
                            let _ = request.result.send(Ok(()));
                        }
                        (PendingCapture::Edit(request), RoomResult::Done) => {
                            let _ = request.result.send(Ok(()));
                        }
                        (PendingCapture::Pause(request), RoomResult::Done) => {
                            let _ = request.result.send(Ok(()));
                        }
                        (PendingCapture::Settings(request), RoomResult::Done) => {
                            let _ = request.result.send(Ok(()));
                        }
                        (request, RoomResult::Error { code }) => request.fail(code),
                        (request, _) => request.fail("invalid_capture_reply".into()),
                    }
                }
            }
            Event::Error { code, request_id } => {
                let opening_id = self.opening.iter().find_map(|(room, opening)| {
                    (request_id.as_ref() == Some(&opening.request_id)).then(|| room.clone())
                });
                if let Some(id) = &opening_id {
                    match &self.opening[id].work {
                        OpeningWork::Register {
                            unpublished_copy: true,
                            ..
                        } => {
                            self.live
                                .as_mut()
                                .unwrap()
                                .room
                                .rooms
                                .remove(id)
                                .unwrap()
                                .discard_unpublished()?;
                            self.files.retain(|file| &file.id != id);
                            if let OpeningWork::Register { replies, .. } =
                                self.opening.remove(id).unwrap().work
                            {
                                for reply in replies {
                                    let _ = reply.result.send(Err(code.clone()));
                                }
                            }
                            self.hosting_ready();
                            return Ok(());
                        }
                        OpeningWork::Register { .. } => {}
                        _ => {
                            self.opening.remove(id).unwrap().fail(&code);
                            return Ok(());
                        }
                    }
                }
                if let Some(request) = request_id
                    .as_ref()
                    .and_then(|id| self.pending_captures.remove(id))
                {
                    request.fail(code);
                    return Ok(());
                }
                let request_id = opening_id.or(request_id);
                if request_id.as_ref().is_some_and(|id| {
                    self.live
                        .as_ref()
                        .is_some_and(|live| live.room.rooms.contains_key(id))
                }) {
                    if self.hosting.is_none() && code != "room_not_in_domain" {
                        bail!("room registration failed: {code}");
                    }
                    let id = request_id.as_ref().unwrap();
                    self.live.as_mut().unwrap().room.rooms.remove(id);
                    self.files.retain(|file| &file.id != id);
                    if let Some(opening) = self.opening.remove(id) {
                        opening.fail(&code);
                    }
                    self.hosting_ready();
                    return Ok(());
                }
                eprintln!("Channel error: {code}");
            }
            _ => {}
        }
        Ok(())
    }

    async fn prepare_capture(
        &mut self,
        request: PrepareCapture,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        if let Err(error) = request.encoding_execution.validate() {
            let _ = request.result.send(Err(error.to_string()));
            return Ok(());
        }
        if !cfg!(feature = "capture") {
            let _ = request.result.send(Err("capture_unavailable".into()));
            return Ok(());
        }
        if self.live.is_none() {
            let _ = request.result.send(Err("room_unavailable".into()));
            return Ok(());
        }
        let command = Command::EnterRoom {
            room_id: request.room_id.clone(),
            password: None,
            invite_key: None,
        };
        let id = Uuid::new_v4().to_string();
        self.pending_captures
            .insert(id.clone(), PendingCapture::Prepare(request));
        // The room host confirms access and projects this endpoint before replying.
        write(socket, &command, Some(&id)).await
    }

    async fn authorize_input(
        &mut self,
        publication_id: Uuid,
        room_id: String,
        result: oneshot::Sender<Result<InputAuthority, String>>,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if result.is_closed() {
            return Ok(());
        }
        if !crate::peer::supports_external_input() || self.live.is_none() {
            let _ = result.send(Err("external_input_unavailable".into()));
            return Ok(());
        }
        let command = Command::EnterRoom {
            room_id: room_id.clone(),
            password: None,
            invite_key: None,
        };
        let id = Uuid::new_v4().to_string();
        self.pending_captures.insert(
            id.clone(),
            PendingCapture::Authorize {
                publication_id,
                room_id,
                result,
            },
        );
        write(socket, &command, Some(&id)).await
    }

    async fn prepare_external(
        &mut self,
        request: PrepareExternal,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        if !crate::peer::supports_external_input() || self.live.is_none() {
            let _ = request
                .result
                .send(Err("external_input_unavailable".into()));
            return Ok(());
        }
        let command = Command::EnterRoom {
            room_id: request.room_id.clone(),
            password: None,
            invite_key: None,
        };
        let id = Uuid::new_v4().to_string();
        self.pending_captures
            .insert(id.clone(), PendingCapture::External(request));
        write(socket, &command, Some(&id)).await
    }

    async fn prepare_external_source(
        &mut self,
        request: PrepareExternal,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        let binding_id = self.live.as_ref().and_then(|live| {
            live.room
                .snapshot
                .borrow()
                .as_ref()
                .and_then(|state| capture_binding(state, &request.room_id))
        });
        let Some(binding_id) = binding_id else {
            let _ = request.result.send(Err("room_unavailable".into()));
            return Ok(());
        };
        let live = self.live.as_mut().unwrap();
        let result = await_peer(
            live.peers.prepare_external(
                CaptureScope {
                    publication_id: request.publication_id,
                    room_id: request.room_id,
                    binding_id,
                },
                request.replaces,
                request.offer,
            ),
            &mut live.commands,
            &live.pairs,
            &mut live.room,
            &live.peers,
            socket,
        )
        .await
        .map_err(|error| error.to_string());
        let _ = request.result.send(result);
        Ok(())
    }

    async fn prepare_source(
        &mut self,
        request: PrepareCapture,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        let binding_id = self.live.as_ref().and_then(|live| {
            live.room
                .snapshot
                .borrow()
                .as_ref()
                .and_then(|state| capture_binding(state, &request.room_id))
        });
        let Some(binding_id) = binding_id else {
            let _ = request.result.send(Err("room_unavailable".into()));
            return Ok(());
        };
        let live = self.live.as_mut().unwrap();
        let result = await_peer(
            live.peers.prepare_capture(
                CaptureScope {
                    publication_id: request.publication_id,
                    room_id: request.room_id,
                    binding_id,
                },
                request.replaces,
                request.target,
                request.settings,
                request.codec_mode,
                request.encoding_execution,
                request.audio,
                request.exclude_audio,
                request.show_capture_border,
            ),
            &mut live.commands,
            &live.pairs,
            &mut live.room,
            &live.peers,
            socket,
        )
        .await
        .map_err(|e| e.to_string());
        let _ = request.result.send(result);
        Ok(())
    }

    async fn commit_capture(
        &mut self,
        request: CommitCapture,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        let Some(live) = self.live.as_mut() else {
            let _ = request.result.send(Err("hosting_unavailable".into()));
            return Ok(());
        };
        if live
            .room
            .snapshot
            .borrow()
            .as_ref()
            .and_then(|s| capture_binding(s, &request.scope.room_id))
            != Some(request.scope.binding_id)
        {
            let _ = request.result.send(Err("room_unavailable".into()));
            return Ok(());
        }
        let current = await_peer(
            live.peers.capture_current(request.capture_id, false),
            &mut live.commands,
            &live.pairs,
            &mut live.room,
            &live.peers,
            socket,
        )
        .await?;
        if !current {
            let _ = request.result.send(Err("capture_unavailable".into()));
            return Ok(());
        }
        if request.retaining {
            return self.finish_capture(request, socket).await;
        }
        // The room acknowledgement orders the local commit after authority, even
        // when Browser transfer and App control arrive over different sockets.
        let command = if request.replacing {
            Command::TransferSource {
                publication_id: request.scope.publication_id,
                to_session_id: live.session,
            }
        } else {
            Command::Publish {
                publication: PublicationInput {
                    source: Some(Default::default()),
                    id: request.scope.publication_id,
                    room_id: request.scope.room_id.clone(),
                    kind: Kind::Screen,
                    video_settings: request.video_settings,
                },
            }
        };
        let id = Uuid::new_v4().to_string();
        self.pending_captures
            .insert(id.clone(), PendingCapture::Commit(request));
        write(socket, &command, Some(&id)).await
    }

    async fn transfer_source(
        &mut self,
        request: TransferSource,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        let Some(live) = self.live.as_mut() else {
            let _ = request.result.send(Err("hosting_unavailable".into()));
            return Ok(());
        };
        let current = await_peer(
            live.peers.capture_current(request.capture_id, true),
            &mut live.commands,
            &live.pairs,
            &mut live.room,
            &live.peers,
            socket,
        )
        .await?;
        if !current {
            let _ = request.result.send(Err("capture_unavailable".into()));
            return Ok(());
        }
        let command = Command::TransferSource {
            publication_id: request.scope.publication_id,
            to_session_id: request.to_session_id,
        };
        let id = Uuid::new_v4().to_string();
        self.pending_captures
            .insert(id.clone(), PendingCapture::Transfer(request));
        write(socket, &command, Some(&id)).await
    }

    async fn pause_capture(
        &mut self,
        request: PauseCapture,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        let Some(live) = self.live.as_mut() else {
            let _ = request.result.send(Err("hosting_unavailable".into()));
            return Ok(());
        };
        let current = await_peer(
            live.peers.capture_current(request.capture_id, true),
            &mut live.commands,
            &live.pairs,
            &mut live.room,
            &live.peers,
            socket,
        )
        .await?;
        if !current
            || live
                .room
                .snapshot
                .borrow()
                .as_ref()
                .and_then(|state| capture_binding(state, &request.scope.room_id))
                != Some(request.scope.binding_id)
        {
            let _ = request.result.send(Err("capture_unavailable".into()));
            return Ok(());
        }
        let command = Command::SetPaused {
            publication_id: request.scope.publication_id,
            paused: request.paused,
        };
        let id = Uuid::new_v4().to_string();
        self.pending_captures
            .insert(id.clone(), PendingCapture::Pause(request));
        write(socket, &command, Some(&id)).await
    }

    async fn edit_capture(&mut self, request: EditCapture, socket: &mut Writer<'_>) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        let Some(live) = self.live.as_mut() else {
            let _ = request.result.send(Err("hosting_unavailable".into()));
            return Ok(());
        };
        let current = await_peer(
            live.peers.capture_current(request.capture_id, true),
            &mut live.commands,
            &live.pairs,
            &mut live.room,
            &live.peers,
            socket,
        )
        .await?;
        if !current
            || live
                .room
                .snapshot
                .borrow()
                .as_ref()
                .and_then(|state| capture_binding(state, &request.scope.room_id))
                != Some(request.scope.binding_id)
        {
            let _ = request.result.send(Err("capture_unavailable".into()));
            return Ok(());
        }
        let publication_id = request.scope.publication_id;
        let command = match &request.edit {
            CaptureEdit::Title(title) => Command::SetTitle {
                publication_id,
                title: title.clone(),
            },
            CaptureEdit::DirectLimit(limit) => Command::SetScreenDirectLimit {
                publication_id,
                limit: *limit,
            },
        };
        let id = Uuid::new_v4().to_string();
        self.pending_captures
            .insert(id.clone(), PendingCapture::Edit(request));
        write(socket, &command, Some(&id)).await
    }

    async fn publish_capture_settings(
        &mut self,
        request: PublishCaptureSettings,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        let Some(live) = self.live.as_mut() else {
            let _ = request.result.send(Err("hosting_unavailable".into()));
            return Ok(());
        };
        let publication = live.room.snapshot.borrow().as_ref().and_then(|state| {
            (capture_binding(state, &request.scope.room_id) == Some(request.scope.binding_id))
                .then(|| {
                    state
                        .publications
                        .iter()
                        .find(|publication| {
                            publication.id == request.scope.publication_id
                                && publication.room_id == request.scope.room_id
                                && publication.session_id == live.session
                                && publication.kind == Kind::Screen
                        })
                        .cloned()
                })
                .flatten()
        });
        let Some(publication) = publication else {
            let _ = request.result.send(Err("publication_unavailable".into()));
            return Ok(());
        };
        let current = await_peer(
            live.peers.capture_current(request.capture_id, true),
            &mut live.commands,
            &live.pairs,
            &mut live.room,
            &live.peers,
            socket,
        )
        .await?;
        if !current {
            let _ = request.result.send(Err("capture_unavailable".into()));
            return Ok(());
        }
        if publication.video_settings == Some(request.settings) {
            let _ = request.result.send(Ok(()));
            return Ok(());
        }
        let command = Command::Publish {
            publication: PublicationInput {
                source: None,
                id: request.scope.publication_id,
                room_id: request.scope.room_id.clone(),
                kind: Kind::Screen,
                video_settings: Some(request.settings),
            },
        };
        let id = Uuid::new_v4().to_string();
        self.pending_captures
            .insert(id.clone(), PendingCapture::Settings(request));
        write(socket, &command, Some(&id)).await
    }

    async fn finish_capture(
        &mut self,
        request: CommitCapture,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        let publication_id = request.scope.publication_id;
        let live = self
            .live
            .as_mut()
            .ok_or_else(|| anyhow!("hosting_unavailable"))?;
        let publication = live.room.snapshot.borrow().as_ref().and_then(|state| {
            state
                .publications
                .iter()
                .find(|publication| {
                    publication.id == publication_id
                        && publication.room_id == request.scope.room_id
                        && publication.session_id == live.session
                        && matches!(publication.kind, Kind::Screen)
                })
                .cloned()
        });
        let Some(publication) = publication.filter(|_| !request.result.is_closed()) else {
            let _ = request.result.send(Err("publication_unavailable".into()));
            return Ok(());
        };
        // Transfer preserves the incumbent source settings. Only a genuinely different
        // prepared configuration needs the existing Publish upsert before commit.
        if !request.retaining && request.video_settings != publication.video_settings {
            let command = Command::Publish {
                publication: PublicationInput {
                    source: None,
                    id: publication_id,
                    room_id: request.scope.room_id.clone(),
                    kind: Kind::Screen,
                    video_settings: request.video_settings,
                },
            };
            let id = Uuid::new_v4().to_string();
            self.pending_captures
                .insert(id.clone(), PendingCapture::Commit(request));
            return write(socket, &command, Some(&id)).await;
        }
        let result = await_peer(
            live.peers.commit_capture(request.capture_id),
            &mut live.commands,
            &live.pairs,
            &mut live.room,
            &live.peers,
            socket,
        )
        .await;
        let source = result.as_ref().ok().and_then(|input| input.source.clone());
        let _ = request.result.send(result.map_err(|e| e.to_string()));
        // The producer is committed. Metadata follows the normal room projection;
        // reporting failure must never roll back or cancel that producer.
        if let Some(source) = source {
            write(
                socket,
                &Command::Publish {
                    publication: PublicationInput {
                        id: publication_id,
                        room_id: request.scope.room_id,
                        kind: Kind::Screen,
                        video_settings: publication.video_settings,
                        source: Some(source),
                    },
                },
                None,
            )
            .await?;
        }
        Ok(())
    }

    fn hosting_ready(&self) {
        if let Some(hosting) = &self.hosting {
            if hosting.ready.borrow().is_none()
                && self.live.as_ref().is_some_and(|live| {
                    live.room
                        .rooms
                        .values()
                        .all(|host| host.binding().is_some())
                })
            {
                hosting.ready.send_replace(Some(Ok(())));
            }
        }
    }

    fn delete_retired_room(&mut self, id: &str, creator: Uuid) -> Result<()> {
        let hosting = self
            .hosting
            .as_ref()
            .ok_or_else(|| anyhow!("hosting_unavailable"))?;
        if self.service_admission.is_none() {
            bail!("forbidden");
        }
        let live = self
            .live
            .as_mut()
            .ok_or_else(|| anyhow!("hosting_unavailable"))?;
        if let Some(room) = live.room.rooms.get_mut(id) {
            if room.summary().creator_id != creator {
                bail!("owner_mismatch");
            }
            room.delete_data()?;
            live.room.rooms.remove(id);
        } else {
            // A committed SQLite deletion leaves an empty store. Verify the
            // directory before acknowledging a retried deletion as complete.
            let mut unreadable = None;
            for entry in std::fs::read_dir(&hosting.directory)? {
                let path = entry?.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("sqlite") {
                    continue;
                }
                match stored_room_policy(&path) {
                    Ok(Some(policy)) if policy.id == id => {
                        HostedRoom::open(&path, id, creator)?.delete_data()?;
                        unreadable = None;
                        break;
                    }
                    Err(error) => unreadable = Some(error),
                    _ => {}
                }
            }
            if let Some(error) = unreadable {
                return Err(error);
            }
        }
        self.files.retain(|file| file.id != id);
        Ok(())
    }

    async fn open_room(
        &mut self,
        request: OpenRoom,
        copy: Option<RoomSnapshot>,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        let id = request.policy.id.clone();
        let copied = copy.is_some();
        let installed = (|| -> Result<RoomSummary> {
            let hosting = self
                .hosting
                .as_ref()
                .ok_or_else(|| anyhow!("hosting_control_closed"))?;
            if self.service_admission.is_none() && request.policy.creator_id != hosting.identity.1 {
                bail!("owner_mismatch");
            }
            let live = self
                .live
                .as_mut()
                .ok_or_else(|| anyhow!("hosting_unavailable"))?;
            if copied
                && (live.room.rooms.contains_key(&id)
                    || self.opening.contains_key(&id)
                    || self.files.iter().any(|file| file.id == id))
            {
                bail!("room_already_exists");
            }
            if !live.room.rooms.contains_key(&id) {
                if Uuid::parse_str(&id)?.to_string() != id {
                    bail!("invalid_room_id");
                }
                let path = hosting.directory.join(format!("{id}.sqlite"));
                let host = if let Some(snapshot) = copy {
                    if path.try_exists()? {
                        bail!("room_already_exists");
                    }
                    let metadata = snapshot.room.metadata();
                    if metadata.own_credential.is_some() || !metadata.retained_files.is_empty() {
                        bail!("backup_room_mismatch");
                    }
                    HostedRoom::from_backup(
                        &path,
                        &snapshot.room,
                        (hosting.identity.0, request.policy.creator_id),
                    )?
                } else if path.try_exists()? {
                    HostedRoom::open(&path, &id, request.policy.creator_id)?
                } else {
                    HostedRoom::create(&path, request.policy)?
                };
                self.files.push(RoomFile {
                    path,
                    id: id.clone(),
                    name: host.summary().name,
                    bootstrap: false,
                });
                live.room.rooms.insert(id.clone(), host);
            }
            Ok(live.room.rooms[&id].summary())
        })();
        let summary = match installed {
            Ok(summary) => summary,
            Err(error) => {
                let _ = request.result.send(Err(error.to_string()));
                return Ok(());
            }
        };
        if self.live.as_ref().unwrap().room.rooms[&id]
            .binding()
            .is_some()
        {
            let _ = request.result.send(Ok(summary));
            return Ok(());
        }
        self.register_room(
            summary,
            None,
            copied,
            OpeningReply {
                result: request.result,
                committed_error: copied.then_some("room_created_connection_failed"),
            },
            socket,
        )
        .await
    }

    fn hosting_description(&self) -> Result<HostingDescription, String> {
        let (live, hosting) = self
            .live
            .as_ref()
            .zip(self.hosting.as_ref())
            .ok_or("hosting_unavailable")?;
        Ok(HostingDescription {
            session_id: live.session,
            room_ids: live
                .room
                .rooms
                .iter()
                .filter(|(_, host)| host.creator_id() == hosting.identity.1)
                .map(|(id, _)| id.clone())
                .collect(),
        })
    }

    async fn snapshot_room(&mut self, request: SnapshotRoom) {
        if request.result.is_closed() {
            return;
        }
        if let Some(snapshot) = &mut self.snapshot_job {
            if !snapshot.task.is_finished() {
                let _ = request.result.send(Err("room_busy".into()));
                return;
            }
            snapshot.join().await;
            self.snapshot_job = None;
        }
        let source = (|| -> Result<_> {
            let hosting = self
                .hosting
                .as_ref()
                .ok_or_else(|| anyhow!("hosting_unavailable"))?;
            let live = self
                .live
                .as_ref()
                .ok_or_else(|| anyhow!("room_unavailable"))?;
            let host = live
                .room
                .rooms
                .get(&request.room_id)
                .filter(|host| host.creator_id() == request.creator.unwrap_or(hosting.identity.1))
                .ok_or_else(|| anyhow!("room_unavailable"))?;
            if request.creator.is_some() && host.binding().is_none() {
                bail!("room_unavailable");
            }
            Ok((host.snapshot_source(), hosting.identity.0))
        })();
        let ((source, room, creator), domain) = match source {
            Ok(value) => value,
            Err(error) => {
                let _ = request.result.send(Err(error.to_string()));
                return;
            }
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let stopped = cancel.clone();
        let task = tokio::task::spawn_blocking(move || {
            if stopped.load(Ordering::Acquire) || request.result.is_closed() {
                return;
            }
            let work = (|| -> Result<RoomSnapshot> {
                let directory = tempfile::Builder::new().prefix("piik-backup-").tempdir()?;
                let room = piik_channel_core::RoomBackup::snapshot_readonly(
                    &source,
                    &directory.path().join("room.sqlite"),
                    domain,
                    &room,
                    creator,
                    request.own_credential,
                    || stopped.load(Ordering::Acquire) || request.result.is_closed(),
                )
                .map_err(anyhow::Error::from_boxed)?;
                Ok(RoomSnapshot { room, directory })
            })();
            if !stopped.load(Ordering::Acquire) && !request.result.is_closed() {
                let _ = request.result.send(work.map_err(|error| error.to_string()));
            }
        });
        self.snapshot_job = Some(SnapshotJob { cancel, task });
    }

    async fn restore_room(&mut self, request: RestoreRoom, socket: &mut Writer<'_>) -> Result<()> {
        if request.result.is_closed() {
            return Ok(());
        }
        if request.existing.is_some() {
            return self.install_room_backup(request, socket).await;
        }
        let id = request.snapshot.room.metadata().policy.id.clone();
        let admission = (|| -> Result<()> {
            let hosting = self
                .hosting
                .as_ref()
                .ok_or_else(|| anyhow!("hosting_unavailable"))?;
            crate::hosted_room::backup_identity(&request.snapshot.room, hosting.identity)?;
            if self.opening.contains_key(&id) {
                bail!("room_busy");
            }
            let live = self
                .live
                .as_ref()
                .ok_or_else(|| anyhow!("hosting_unavailable"))?;
            if live.room.snapshot.borrow().is_none() {
                bail!("hosting_unavailable");
            }
            Ok(())
        })();
        if let Err(error) = admission {
            let _ = request.result.send(Err(error.to_string()));
            return Ok(());
        }
        let request_id = Uuid::new_v4().to_string();
        let room = RoomSummary::from_policy(&request.snapshot.room.metadata().policy);
        self.opening.insert(
            id,
            OpeningRoom {
                request_id: request_id.clone(),
                work: OpeningWork::AdmitRestore(request),
            },
        );
        write(socket, &Command::AdmitRoom { room }, Some(&request_id)).await
    }

    async fn install_room_backup(
        &mut self,
        request: RestoreRoom,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        let id = request.snapshot.room.metadata().policy.id.clone();
        if request.result.is_closed() {
            return Ok(());
        }
        let restored = (|| -> Result<(RoomSummary, Option<Uuid>)> {
            let hosting = self
                .hosting
                .as_ref()
                .ok_or_else(|| anyhow!("hosting_unavailable"))?;
            if self.opening.contains_key(&id) {
                bail!("room_busy");
            }
            let live = self
                .live
                .as_mut()
                .ok_or_else(|| anyhow!("hosting_unavailable"))?;
            if let Some(target) = &request.existing {
                if target.room_id != id {
                    bail!("backup_room_mismatch");
                }
                let state = live.room.snapshot.borrow();
                let channel = &state
                    .as_ref()
                    .ok_or_else(|| anyhow!("hosting_unavailable"))?
                    .channel;
                let summary = RoomSummary::from_policy(&request.snapshot.room.metadata().policy);
                let host = live
                    .room
                    .rooms
                    .get_mut(&id)
                    .filter(|host| host.creator_id() == target.creator)
                    .ok_or_else(|| anyhow!("room_unavailable"))?;
                let previous = host.binding().ok_or_else(|| anyhow!("room_unavailable"))?;
                if !channel
                    .room_creation_policy
                    .permits(channel.owner_id, &summary)
                {
                    bail!("room_creation_restricted");
                }
                host.replace(&request.snapshot.room, (hosting.identity.0, target.creator))?;
                return Ok((host.summary(), Some(previous)));
            }
            if !live.room.snapshot.borrow().as_ref().is_some_and(|state| {
                state
                    .channel
                    .rooms
                    .iter()
                    .any(|room| room.id == id && room.creator_id == hosting.identity.1)
            }) {
                bail!("room_not_in_domain");
            }
            let previous = if let Some(host) = live.room.rooms.get_mut(&id) {
                let previous = host.binding().ok_or_else(|| anyhow!("room_unavailable"))?;
                host.replace(&request.snapshot.room, hosting.identity)?;
                Some(previous)
            } else {
                let existing = stored_rooms(&hosting.directory)?
                    .into_iter()
                    .find(|file| file.id == id);
                let (path, host) = if let Some(file) = existing {
                    let mut host = HostedRoom::open(&file.path, &id, hosting.identity.1)?;
                    host.replace(&request.snapshot.room, hosting.identity)?;
                    (file.path, host)
                } else {
                    let path = hosting.directory.join(format!("{}.sqlite", Uuid::new_v4()));
                    let host =
                        HostedRoom::from_backup(&path, &request.snapshot.room, hosting.identity)?;
                    (path, host)
                };
                if !self.files.iter().any(|file| file.path == path) {
                    self.files.push(RoomFile {
                        path,
                        id: id.clone(),
                        name: String::new(),
                        bootstrap: false,
                    });
                }
                live.room.rooms.insert(id.clone(), host);
                None
            };
            Ok((live.room.rooms[&id].summary(), previous))
        })();
        // RoomSnapshot closes its SQLite handle before deleting staging files.
        drop(request.snapshot);
        match restored {
            Ok((summary, previous)) => {
                self.register_room(
                    summary,
                    previous,
                    false,
                    OpeningReply {
                        result: request.result,
                        committed_error: Some("room_restored_connection_failed"),
                    },
                    socket,
                )
                .await
            }
            Err(error) => {
                let _ = request.result.send(Err(error.to_string()));
                Ok(())
            }
        }
    }

    async fn register_room(
        &mut self,
        summary: RoomSummary,
        previous_binding: Option<Uuid>,
        unpublished_copy: bool,
        reply: OpeningReply,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        let id = summary.id.clone();
        let opening = self
            .opening
            .entry(id.clone())
            .or_insert_with(|| OpeningRoom {
                request_id: Uuid::new_v4().to_string(),
                work: OpeningWork::Register {
                    previous_binding,
                    replies: vec![],
                    unpublished_copy,
                },
            });
        let OpeningWork::Register { replies, .. } = &mut opening.work else {
            reply.finish(Err("room_busy".into()));
            return Ok(());
        };
        replies.push(reply);
        if replies.len() == 1 {
            write(
                socket,
                &Command::HostRegister {
                    room: summary,
                    resume_binding: None,
                },
                Some(&opening.request_id),
            )
            .await?;
        }
        Ok(())
    }

    async fn set_forwarding_limit(
        &mut self,
        limit: Option<u8>,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        self.forwarding_limit = limit;
        let state = self
            .live
            .as_ref()
            .and_then(|live| live.room.snapshot.borrow().clone());
        if let Some(state) = state {
            self.state(state, socket).await?;
        }
        Ok(())
    }

    async fn state(&mut self, mut state: Snapshot, socket: &mut Writer<'_>) -> Result<()> {
        if let Some(live) = &mut self.live {
            live.room.rooms.retain(|id, room| {
                room.binding().is_none()
                    || state.channel.rooms.iter().any(|summary| &summary.id == id)
                    || (self.service_admission.is_some()
                        && state.channel.managed_room_ids.contains(id))
            });
        }
        self.retire_missing_hosts(&state, socket).await?;
        let retired: Vec<_> = self
            .pending_captures
            .iter()
            .filter_map(|(id, pending)| {
                (pending.closed()
                    || pending.scope().is_some_and(|scope| {
                        capture_binding(&state, &scope.room_id) != Some(scope.binding_id)
                    }))
                .then_some(id.clone())
            })
            .collect();
        for id in retired {
            self.pending_captures
                .remove(&id)
                .unwrap()
                .fail("room_unavailable".into());
        }
        if let Some(live) = &mut self.live {
            if let Some(user) = state
                .sessions
                .iter()
                .find(|session| session.id == live.session)
                .and_then(|session| state.users.iter().find(|user| user.id == session.user_id))
            {
                self.config.name.clone_from(&user.name);
            }
            live.room.snapshot.send_replace(Some(state.clone()));
            let user_id = state
                .sessions
                .iter()
                .find(|session| session.id == live.session)
                .ok_or_else(|| anyhow!("session_expired"))?
                .user_id;
            let refusals = live
                .forwarding_budget
                .apply(self.forwarding_limit, user_id, &mut state);
            live.pairs = state.pairs.iter().map(|pair| pair.id).collect();
            let captures = await_peer(
                live.peers.capture_publications(),
                &mut live.commands,
                &live.pairs,
                &mut live.room,
                &live.peers,
                socket,
            )
            .await?;
            // A room can recover a committed Publish after its caller has retired.
            // Only a real producer or its current startup request owns that activity.
            for publication in &state.publications {
                if publication.session_id == live.session
                    && matches!(publication.kind, Kind::Screen)
                    && !captures.contains(&publication.id)
                    && !self
                        .pending_captures
                        .values()
                        .any(|pending| pending.publication_id() == publication.id)
                {
                    write(
                        socket,
                        &Command::Unpublish {
                            publication_id: publication.id,
                        },
                        None,
                    )
                    .await?;
                }
            }
            await_peer(
                live.peers.update_watch(state.watch_bytes, &state.pairs),
                &mut live.commands,
                &live.pairs,
                &mut live.room,
                &live.peers,
                socket,
            )
            .await?;
            await_peer(
                live.peers
                    .update(state.pairs, state.publications, state.files),
                &mut live.commands,
                &live.pairs,
                &mut live.room,
                &live.peers,
                socket,
            )
            .await?;
            for refusal in refusals {
                write(socket, &refusal, None).await?;
            }
        }
        Ok(())
    }

    async fn retire_missing_hosts(
        &mut self,
        state: &Snapshot,
        socket: &mut Writer<'_>,
    ) -> Result<()> {
        let Some(live) = self.live.as_ref() else {
            return Ok(());
        };
        let missing: Vec<_> = state
            .channel
            .rooms
            .iter()
            .filter_map(|room| {
                room.delivery
                    .as_ref()
                    .filter(|delivery| {
                        delivery.host_session_id == live.session
                            && !live.room.rooms.contains_key(&room.id)
                    })
                    .map(|delivery| (room.id.clone(), delivery.binding_id))
            })
            .collect();
        for (room_id, binding_id) in missing {
            write(
                socket,
                &Command::HostStop {
                    room_id,
                    binding_id,
                },
                None,
            )
            .await?;
        }
        Ok(())
    }
}

/// Physical names are local storage, not room identities. Imported named rooms
/// use random filenames; the durable policy remains their one identity owner.
fn stored_rooms(directory: &std::path::Path) -> Result<Vec<RoomFile>> {
    let mut paths = std::fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    paths.sort();
    let mut files = vec![];
    for path in paths {
        if path.extension().and_then(|value| value.to_str()) != Some("sqlite") {
            continue;
        }
        let policy = match stored_room_policy(&path) {
            Ok(Some(policy)) => policy,
            Ok(None) => continue,
            Err(error) if room_data_unavailable(&path, &error) => continue,
            Err(error) => return Err(error),
        };
        files.push(RoomFile {
            path,
            id: policy.id,
            name: String::new(),
            bootstrap: false,
        });
    }
    Ok(files)
}

fn stored_room_policy(path: &std::path::Path) -> Result<Option<RoomState>> {
    let read = || -> piik_channel_core::storage::StoreResult<Option<RoomState>> {
        std::fs::metadata(path)?;
        let store = piik_channel_core::storage::Storage::open_existing(path)?;
        let Some(policy) = store.load()? else {
            return Ok(None);
        };
        let policy: RoomState = serde_json::from_value(policy)
            .map_err(|error| piik_channel_core::storage::StorageDataError(error.into()))?;
        policy
            .validate()
            .map_err(|error| piik_channel_core::storage::StorageDataError(error.into()))?;
        Ok(Some(policy))
    };
    read().map_err(storage_error)
}

fn room_data_unavailable(path: &std::path::Path, error: &anyhow::Error) -> bool {
    if !error.is::<piik_channel_core::storage::StorageDataError>() {
        return false;
    }
    eprintln!("Native room data unavailable: {}: {error}", path.display());
    true
}

async fn next_host_command(hosting: &mut Option<Hosting>) -> Option<HostCommand> {
    match hosting {
        Some(hosting) => hosting.commands.recv().await,
        None => std::future::pending().await,
    }
}

// Normalize the browser RTCIceServer shape into Native's typed configuration.
fn ice_server(mut value: serde_json::Value) -> Result<crate::peer::IceServer> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("invalid_ice_server"))?;
    if let Some(serde_json::Value::String(url)) = object.get("urls") {
        object.insert("urls".into(), serde_json::json!([url]));
    }
    object.entry("username").or_insert_with(|| "".into());
    object.entry("credential").or_insert_with(|| "".into());
    serde_json::from_value(value).map_err(|_| anyhow!("invalid_ice_server"))
}

fn current(pairs: &BTreeSet<Uuid>, command: &Command) -> bool {
    let pair = match command {
        Command::Signal { pair_id, .. }
        | Command::LinkState { pair_id, .. }
        | Command::FlowState { pair_id, .. }
        | Command::RoomDataState { pair_id, .. } => pair_id,
        _ => return false,
    };
    pairs.contains(pair)
}

// A peer turn may emit signaling before completing. Drain the same bounded output
// while awaiting it so neither owner waits for the other's full queue.
async fn await_peer<T>(
    turn: impl Future<Output = Result<T>>,
    commands: &mut mpsc::Receiver<NativeEvent>,
    pairs: &BTreeSet<Uuid>,
    room: &mut RoomTurns,
    peers: &NativePeers,
    socket: &mut Writer<'_>,
) -> Result<T> {
    let mut turn = std::pin::pin!(turn);
    loop {
        tokio::select! {
            result = &mut turn => return result,
            command = commands.recv() => {
                let command = command.ok_or_else(|| anyhow!("native_peer_stopped"))?;
                process_peer(command, pairs, room, peers, socket).await?;
            },
        }
    }
}

async fn next_command(live: &mut Option<Live>) -> Option<NativeEvent> {
    match live {
        Some(live) => live.commands.recv().await,
        None => std::future::pending().await,
    }
}

// The reader reports one physical-carrier end. It cannot grant authority or
// reset its retained-session deadline; queued Welcome processing cannot either.
async fn carrier_recovery_deadline(
    mut deadline: Option<Instant>,
    mut carrier_end: watch::Receiver<Option<Instant>>,
) {
    loop {
        if let Some(ended) = *carrier_end.borrow_and_update() {
            let expires = ended + Duration::from_millis(RECOVERY_MS);
            deadline = Some(deadline.map_or(expires, |at| at.min(expires)));
        }
        if deadline.is_some_and(|at| Instant::now() >= at) {
            return;
        }
        tokio::select! {
            _ = recovery_deadline(deadline) => return,
            changed = carrier_end.changed() => {
                if changed.is_err() { recovery_deadline(deadline).await; return; }
            },
        }
    }
}

async fn recovery_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

async fn write(socket: &mut Writer<'_>, command: &Command, request_id: Option<&str>) -> Result<()> {
    let mut value = serde_json::to_value(command)?;
    if let Some(id) = request_id {
        value
            .as_object_mut()
            .unwrap()
            .insert("requestId".into(), id.into());
    }
    write_frame(socket, Message::Text(value.to_string().into())).await
}

async fn write_frame(socket: &mut Writer<'_>, frame: Message) -> Result<()> {
    time::timeout(Duration::from_secs(5), socket.send(frame))
        .await
        .map_err(|_| {
            tokio_tungstenite::tungstenite::Error::Io(std::io::ErrorKind::TimedOut.into())
        })??;
    Ok(())
}

// The acknowledged Leave retires domain resources before dropping a socket that
// may still contain unread state. Otherwise a TCP reset can overtake that command.
async fn leave(socket: &mut Socket) {
    let _ = time::timeout(Duration::from_secs(5), async {
        write(socket, &Command::Leave, Some("native-leave")).await?;
        while let Some(message) = socket.next().await {
            match message? {
                Message::Text(text) => {
                    if matches!(serde_json::from_str::<Event>(&text), Ok(Event::Ack { request_id }) if request_id == "native-leave") { break; }
                },
                Message::Ping(bytes) => write_frame(socket, Message::Pong(bytes)).await?,
                Message::Close(_) => break,
                _ => {},
            }
        }
        socket.close(None).await?;
        Ok::<_, anyhow::Error>(())
    }).await;
}
