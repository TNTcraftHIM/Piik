//! One explicit hosting session owns its signaling connection and native peers.
//! Room policy and route decisions remain in the shared core.
use crate::{
    hosted_room::HostedRoom,
    peer::{NativeEvent, NativePeers},
};
use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use piik_channel_core::{
    conversation::{self, ConversationRecord, ConversationReply, SessionSigner, SignedPacket},
    history::HistoryResult,
};
use piik_channel_core::{
    host::RoomSummary,
    wire::{Command, Event, RoomAccess, Snapshot},
    RoomState, RECOVERY_MS,
};
use std::sync::Arc;
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
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use uuid::Uuid;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

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
    fn replies(&self, peers: &NativePeers, replies: &[ConversationReply]) -> Result<()> {
        let snapshot = self.snapshot.borrow();
        let snapshot = snapshot
            .as_ref()
            .ok_or_else(|| anyhow!("room_unavailable"))?;
        let mut next = None;
        let mut packets = Vec::with_capacity(replies.len());
        for reply in replies {
            let original = self
                .signer
                .sign(self.local, reply)
                .map_err(anyhow::Error::msg)?;
            let mut packet = original.clone();
            let route = conversation::route(&mut packet, self.local, snapshot, None)
                .map_err(anyhow::Error::msg)?;
            let peer = route
                .next_hop
                .ok_or_else(|| anyhow!("room_path_unavailable"))?;
            if next.is_some_and(|previous| previous != peer) {
                return Err(anyhow!("room_path_changed"));
            }
            next = Some(peer);
            packets.push((packet, original));
        }
        if let Some(peer) = next {
            peers.conversations(peer, packets, self.snapshot.subscribe(), self.local, None)?;
        }
        Ok(())
    }
    fn reply(&self, peers: &NativePeers, reply: &ConversationReply) {
        let result = self.replies(peers, std::slice::from_ref(reply));
        if let Err(error) = result {
            eprintln!("Native conversation response unavailable: {error}");
        }
    }
    fn receive(&mut self, peers: &NativePeers, peer: Uuid, mut packet: SignedPacket) {
        let original = packet.clone();
        let routed = {
            let snapshot = self.snapshot.borrow();
            let Some(snapshot) = snapshot.as_ref() else {
                return;
            };
            conversation::route(&mut packet, self.local, snapshot, Some(peer))
        };
        let Ok(route) = routed else {
            return;
        };
        if let Some(next) = route.next_hop {
            let _ = peers.conversation(
                next,
                packet,
                original,
                self.snapshot.subscribe(),
                self.local,
                Some(peer),
            );
            return;
        }
        let Some(hosted) = self.rooms.get_mut(&route.address.room_id) else {
            return;
        };
        if hosted.binding() != Some(route.address.binding_id) {
            return;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let Ok(outcome) = hosted.dispatch_peer(&packet, now) else {
            return;
        };
        let broadcast = match &outcome.result {
            Ok(HistoryResult::Sent(confirmation)) if confirmation.inserted => {
                Some((confirmation.message.clone(), hosted.current_readers()))
            }
            _ => None,
        };
        let address = outcome.address.reply();
        if let Ok(replies) = outcome.replies() {
            if let Err(error) = self.replies(peers, &replies) {
                eprintln!("Native conversation response unavailable: {error}");
                self.reply(
                    peers,
                    &ConversationReply {
                        address: address.clone(),
                        record: ConversationRecord::Error {
                            code: error.to_string(),
                        },
                    },
                );
            }
        }
        if let Some((message, readers)) = broadcast {
            for reader in readers {
                if reader == address.recipient || reader == self.local {
                    continue;
                }
                self.reply(
                    peers,
                    &ConversationReply {
                        address: conversation::ConversationAddress {
                            recipient: reader,
                            ..address.clone()
                        },
                        record: ConversationRecord::LiveMessage {
                            message: message.clone(),
                        },
                    },
                );
            }
        }
    }
}

async fn process_peer(
    event: NativeEvent,
    pairs: &BTreeSet<Uuid>,
    room: &mut RoomTurns,
    peers: &NativePeers,
    socket: &mut Socket,
) -> Result<()> {
    match event {
        NativeEvent::Command(command) if current(pairs, &command) => {
            write(socket, &command, None).await?
        }
        NativeEvent::Conversation {
            peer,
            pair,
            token,
            packet,
        } if peers.control_current(peer, pair, token) => room.receive(peers, peer, packet),
        _ => {}
    }
    Ok(())
}

pub struct Config {
    pub url: String,
    pub origin: String,
    pub name: String,
    pub key: Option<String>,
    pub credential: Option<String>,
}

/// Trusted paths supplied by the explicit hosting caller. Existing files restore
/// their policy; a missing file creates a public room for the admitted identity.
pub struct RoomFile {
    pub path: PathBuf,
    pub id: String,
    pub name: String,
}

struct Live {
    session: Uuid,
    room: RoomTurns,
    peers: NativePeers,
    commands: mpsc::Receiver<NativeEvent>,
    pairs: BTreeSet<Uuid>,
}

struct Session {
    config: Config,
    files: Vec<RoomFile>,
    live: Option<Live>,
    recovery: Option<Instant>,
    signer: Arc<SessionSigner>,
    hosting: Option<Hosting>,
    opening: BTreeMap<String, Vec<oneshot::Sender<Result<RoomSummary, String>>>>,
}

pub struct OpenRoom {
    pub policy: RoomState,
    pub result: oneshot::Sender<Result<RoomSummary, String>>,
}

pub struct Hosting {
    pub directory: PathBuf,
    pub identity: (Uuid, Uuid),
    pub commands: mpsc::Receiver<OpenRoom>,
    pub ready: watch::Sender<Option<Result<(), String>>>,
}

/// The calling App or Server owns this hosting future independently of its pages.
pub async fn run(
    config: Config,
    files: Vec<RoomFile>,
    stop: impl Future<Output = ()> + Send,
) -> Result<()> {
    run_host(config, files, None, stop).await
}

pub async fn run_host(
    config: Config,
    files: Vec<RoomFile>,
    hosting: Option<Hosting>,
    stop: impl Future<Output = ()> + Send,
) -> Result<()> {
    let mut session = Session {
        config,
        files,
        live: None,
        recovery: None,
        signer: Arc::new(new_signer()?),
        hosting,
        opening: BTreeMap::new(),
    };
    let mut stop = std::pin::pin!(stop);
    let result = session.drive(&mut stop).await;
    let closed = session.release().await;
    let error = result
        .as_ref()
        .err()
        .map(ToString::to_string)
        .unwrap_or_else(|| "hosting_stopped".into());
    if let Some(hosting) = &session.hosting {
        if hosting.ready.borrow().is_none() {
            hosting.ready.send_replace(Some(Err(error.clone())));
        }
    }
    for replies in session.opening.into_values() {
        for reply in replies {
            let _ = reply.send(Err(error.clone()));
        }
    }
    result.and(closed)
}

impl Session {
    async fn release(&mut self) -> Result<()> {
        if let Some(live) = self.live.take() {
            live.room.snapshot.send_replace(None);
            live.peers.close().await?;
        }
        self.recovery = None;
        Ok(())
    }

    async fn drive(&mut self, stop: &mut (impl Future<Output = ()> + Unpin)) -> Result<()> {
        loop {
            let mut request = self.config.url.as_str().into_client_request()?;
            request
                .headers_mut()
                .insert("Origin", self.config.origin.parse()?);
            let limits = WebSocketConfig::default()
                .max_message_size(Some(2 * 1024 * 1024))
                .max_frame_size(Some(2 * 1024 * 1024));
            let connection = tokio::select! {
                _ = &mut *stop => return Ok(()),
                _ = recovery_deadline(self.recovery) => { self.release().await?; continue; },
                result = time::timeout(Duration::from_secs(5), connect_async_with_config(request, Some(limits), false)) => result,
            };
            if let Ok(Ok((mut socket, _))) = connection {
                let join = Command::Join {
                    name: self.config.name.clone(),
                    credential: self.config.credential.clone(),
                    key: self.config.key.clone(),
                    session_id: self.live.as_ref().map(|live| live.session.to_string()),
                    room_id: None,
                    signing_key: self.signer.signing_key(),
                };
                let result = self.connected(&mut socket, join, stop).await;
                if let Some(live) = &self.live {
                    live.room.snapshot.send_replace(None);
                }
                if !matches!(result, Ok(false)) {
                    let released = self.release().await;
                    leave(&mut socket).await;
                    return result.map(|_| ()).and(released);
                }
            }
            if self.live.is_some() && self.recovery.is_none() {
                self.recovery = Some(Instant::now() + Duration::from_millis(RECOVERY_MS));
            }
            tokio::select! {
                _ = &mut *stop => return Ok(()),
                _ = recovery_deadline(self.recovery) => self.release().await?,
                _ = time::sleep(Duration::from_secs(1)) => {},
            }
        }
    }

    /// true: caller stopped; false: connection lost, attempt the existing resume.
    async fn connected(
        &mut self,
        socket: &mut Socket,
        join: Command,
        stop: &mut (impl Future<Output = ()> + Unpin),
    ) -> Result<bool> {
        enum Step {
            Stop,
            Expired,
            Work(Result<bool>),
        }
        let mut join = Some(join);
        let mut pending = None;
        let mut admitted = false;
        let mut last_seen = Instant::now();
        loop {
            let recovery = self.recovery;
            let idle = last_seen + Duration::from_millis(RECOVERY_MS);
            // Stop and connection deadlines cover the whole operation, including
            // peer negotiation and socket writes. Welcome ends the recovery window
            // before its projection starts a peer turn.
            let step = {
                let work = async {
                    if let Some(join) = join.take() {
                        write(socket, &join, None).await?;
                        return Ok(true);
                    }
                    if let Some(event) = pending.take() {
                        self.event(event, socket).await?;
                        return Ok(true);
                    }
                    tokio::select! {
                        request = next_host_command(&mut self.hosting), if admitted => {
                            let request = request.ok_or_else(|| anyhow!("hosting_control_closed"))?;
                            self.open_room(request, socket).await?;
                        },
                        command = next_command(&mut self.live), if admitted => {
                            let command = command.ok_or_else(|| anyhow!("native_peer_stopped"))?;
                            if let Some(live) = &mut self.live {
                                process_peer(command, &live.pairs, &mut live.room, &live.peers, socket).await?;
                            }
                        },
                        message = socket.next() => {
                            last_seen = Instant::now();
                            match message {
                                Some(Ok(Message::Text(text))) => {
                                    let event: Event = serde_json::from_str(&text).context("invalid channel event")?;
                                    if matches!(event, Event::Welcome { .. }) {
                                        admitted = true;
                                        self.recovery = None;
                                    }
                                    if let Event::Error { code, .. } = &event {
                                        if !admitted { bail!("admission failed: {code}"); }
                                    }
                                    pending = Some(event);
                                },
                                Some(Ok(Message::Ping(bytes))) => write_frame(socket, Message::Pong(bytes)).await?,
                                Some(Ok(Message::Pong(_))) => {},
                                _ => return Ok(false),
                            }
                        },
                    }
                    Ok(true)
                };
                tokio::select! {
                    _ = &mut *stop => Step::Stop,
                    _ = recovery_deadline(recovery) => Step::Expired,
                    _ = time::sleep_until(idle) => Step::Work(Ok(false)),
                    result = work => Step::Work(result),
                }
            };
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

    async fn event(&mut self, event: Event, socket: &mut Socket) -> Result<()> {
        match event {
            Event::Welcome {
                credential,
                session_id,
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
                    if self.files.is_empty() {
                        let mut paths = std::fs::read_dir(&hosting.directory)?
                            .map(|entry| entry.map(|entry| entry.path()))
                            .collect::<std::io::Result<Vec<_>>>()?;
                        paths.sort();
                        for path in paths {
                            if path.extension().and_then(|value| value.to_str()) != Some("sqlite") {
                                continue;
                            }
                            let Some(id) = path
                                .file_stem()
                                .and_then(|value| value.to_str())
                                .and_then(|value| Uuid::parse_str(value).ok())
                            else {
                                continue;
                            };
                            self.files.push(RoomFile {
                                path,
                                id: id.to_string(),
                                name: String::new(),
                            });
                        }
                    }
                }
                self.config.credential = Some(credential);
                let resumed = self
                    .live
                    .as_ref()
                    .is_some_and(|live| live.session == session_id);
                if !resumed {
                    self.release().await?;
                    let mut rooms = BTreeMap::new();
                    for file in &self.files {
                        let host = match std::fs::metadata(&file.path) {
                            Ok(_) => HostedRoom::open(&file.path, &file.id, user),
                            Err(error)
                                if error.kind() == std::io::ErrorKind::NotFound
                                    && self.hosting.is_none() =>
                            {
                                let policy = RoomState::new(
                                    file.id.clone(),
                                    file.name.clone(),
                                    user,
                                    RoomAccess::Public,
                                    false,
                                    None,
                                )
                                .map_err(anyhow::Error::msg)?;
                                HostedRoom::create(&file.path, policy)
                            }
                            Err(error) => Err(error.into()),
                        }?;
                        if rooms.insert(file.id.clone(), host).is_some() {
                            bail!("duplicate room id");
                        }
                    }
                    let ice = state
                        .ice_servers
                        .iter()
                        .cloned()
                        .map(ice_server)
                        .collect::<Result<Vec<_>, _>>()?;
                    let (commands, receiver) = mpsc::channel(64);
                    self.live = Some(Live {
                        session: session_id,
                        room: RoomTurns {
                            rooms,
                            local: session_id,
                            signer: self.signer.clone(),
                            snapshot: watch::channel(None).0,
                        },
                        peers: NativePeers::new(session_id, ice, commands),
                        commands: receiver,
                        pairs: BTreeSet::new(),
                    });
                }
                self.recovery = None;
                self.state(state, socket).await?;
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
                    write(
                        socket,
                        &Command::HostRegister {
                            room: hosted.summary(),
                            resume_binding: hosted.binding(),
                        },
                        Some(id),
                    )
                    .await?;
                }
                self.hosting_ready();
                eprintln!(
                    "Native session admitted ({})",
                    if resumed { "resumed" } else { "new" }
                );
            }
            Event::State { state } => self.state(state, socket).await?,
            Event::HostBound {
                room_id,
                binding_id,
            } => {
                if let Some(hosted) = self
                    .live
                    .as_mut()
                    .and_then(|live| live.room.rooms.get_mut(&room_id))
                {
                    hosted.bind(binding_id)?;
                    if let Some(replies) = self.opening.remove(&room_id) {
                        for reply in replies {
                            let _ = reply.send(Ok(hosted.summary()));
                        }
                    }
                    eprintln!("Native room bound: {room_id}");
                }
                self.hosting_ready();
            }
            Event::HostInput { room_id, input } => {
                if let Some(live) = &mut self.live {
                    if let Some(hosted) = live.room.rooms.get_mut(&room_id) {
                        if hosted.binding() == Some(input.binding_id)
                            && live.session == input.host_session_id
                        {
                            let output = hosted.dispatch(input).map_err(anyhow::Error::msg)?;
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
            Event::Error { code, request_id } => {
                if request_id.as_ref().is_some_and(|id| {
                    self.live
                        .as_ref()
                        .is_some_and(|live| live.room.rooms.contains_key(id))
                }) {
                    if self.hosting.is_none() {
                        bail!("room registration failed: {code}");
                    }
                    let id = request_id.as_ref().unwrap();
                    self.live.as_mut().unwrap().room.rooms.remove(id);
                    self.files.retain(|file| &file.id != id);
                    if let Some(replies) = self.opening.remove(id) {
                        for reply in replies {
                            let _ = reply.send(Err(code.clone()));
                        }
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

    async fn open_room(&mut self, request: OpenRoom, socket: &mut Socket) -> Result<()> {
        let id = request.policy.id.clone();
        let installed = (|| -> Result<RoomSummary> {
            let hosting = self
                .hosting
                .as_ref()
                .ok_or_else(|| anyhow!("hosting_control_closed"))?;
            if request.policy.creator_id != hosting.identity.1 {
                bail!("owner_mismatch");
            }
            if Uuid::parse_str(&id)?.to_string() != id {
                bail!("invalid_room_id");
            }
            let live = self
                .live
                .as_mut()
                .ok_or_else(|| anyhow!("hosting_unavailable"))?;
            if !live.room.rooms.contains_key(&id) {
                let path = hosting.directory.join(format!("{id}.sqlite"));
                let host = if path.try_exists()? {
                    HostedRoom::open(&path, &id, hosting.identity.1)?
                } else {
                    HostedRoom::create(&path, request.policy)?
                };
                self.files.push(RoomFile {
                    path,
                    id: id.clone(),
                    name: host.summary().name,
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
        let replies = self.opening.entry(id.clone()).or_default();
        replies.push(request.result);
        if replies.len() == 1 {
            write(
                socket,
                &Command::HostRegister {
                    room: summary,
                    resume_binding: None,
                },
                Some(&id),
            )
            .await?;
        }
        Ok(())
    }

    async fn state(&mut self, state: Snapshot, socket: &mut Socket) -> Result<()> {
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
            live.pairs = state.pairs.iter().map(|pair| pair.id).collect();
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
        }
        Ok(())
    }
}

async fn next_host_command(hosting: &mut Option<Hosting>) -> Option<OpenRoom> {
    match hosting {
        Some(hosting) => hosting.commands.recv().await,
        None => std::future::pending().await,
    }
}

// The wire uses the browser RTCIceServer shape; the native library requires an
// array and explicit credential strings even for an unauthenticated STUN server.
fn ice_server(mut value: serde_json::Value) -> Result<webrtc::peer_connection::RTCIceServer> {
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
        | Command::BaseState { pair_id, .. } => pair_id,
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
    socket: &mut Socket,
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

async fn recovery_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

async fn write(socket: &mut Socket, command: &Command, request_id: Option<&str>) -> Result<()> {
    let mut value = serde_json::to_value(command)?;
    if let Some(id) = request_id {
        value
            .as_object_mut()
            .unwrap()
            .insert("requestId".into(), id.into());
    }
    write_frame(socket, Message::Text(value.to_string().into())).await
}

async fn write_frame(socket: &mut Socket, frame: Message) -> Result<()> {
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
