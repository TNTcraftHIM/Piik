use anyhow::Context;
#[path = "domain_backup.rs"]
mod backup;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
pub(crate) use backup::RestoreDomain;
use futures_util::{stream::FuturesUnordered, FutureExt, Sink, SinkExt, StreamExt};
use piik_channel_core::{
    backup::DomainMetadata,
    host::RoomSummary,
    storage,
    wire::{Event, HostingMode, Request, RoomCreationPolicy},
    Authority, Effects, RoomState,
};
use std::{
    collections::BTreeMap,
    future::Future,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch, Semaphore};
use uuid::Uuid;

pub(crate) const HEALTH_MARKER: &str = "piik-channel-prototype";

#[derive(Clone)]
struct Client {
    events: mpsc::Sender<Event>,
    close: watch::Sender<bool>,
}

struct Hub {
    authority: Authority,
    launch_tickets: BTreeMap<String, Instant>,
    clients: BTreeMap<Uuid, Client>,
    storage: storage::DomainStorage,
    // A background room operation can retain the Hub after the listener closes.
    _directory_owner: Option<std::fs::File>,
    invitation_origin: Option<String>,
    room_commands: Option<mpsc::Sender<piik_channel_native::session::HostCommand>>,
}

impl Hub {
    fn redeem_launch(&mut self, request: &mut Request) {
        if let piik_channel_core::wire::Command::Join { owner_key: Some(key), .. } = &mut request.command {
            if self.launch_tickets.remove(key).is_some_and(|expiry| Instant::now() < expiry) {
                *key = self.authority.owner_admission_key().to_owned();
            }
        }
    }

    fn request(&mut self, connection: Uuid, request: Request) {
        self.handle_request(connection, request, false);
    }

    fn handle_request(
        &mut self,
        connection: Uuid,
        request: Request,
        defer_room_result: bool,
    ) -> Option<Event> {
        if !self
            .clients
            .get(&connection)
            .is_some_and(|client| !*client.close.borrow())
        {
            return None;
        }
        let metadata = self.authority.changes_metadata(connection, &request);
        // A host has already committed its room policy. The domain's directory
        // is a projection of that authority, not a second writer that may undo it.
        let room_projection = matches!(&request.command,
            piik_channel_core::wire::Command::HostOutput { output, .. }
            if !output.reply.as_ref().is_some_and(|reply| matches!(reply.result,
                piik_channel_core::host::RoomResult::Deleted { .. })));
        let deleted = match &request.command {
            piik_channel_core::wire::Command::HostOutput { room_id, output }
                if output.reply.as_ref().is_some_and(|reply| {
                    matches!(
                        reply.result,
                        piik_channel_core::host::RoomResult::Deleted { data_removed: true }
                    )
                }) =>
            {
                Some((
                    room_id.clone(),
                    output.reply.as_ref().unwrap().context.clone(),
                ))
            }
            _ => None,
        };
        let (failure_target, request_id) = match &request.command {
            piik_channel_core::wire::Command::HostOutput { output, .. } => output
                .reply
                .as_ref()
                .map(|reply| (reply.context.connection, reply.context.request_id.clone()))
                .unwrap_or((connection, request.request_id.clone())),
            _ => (connection, request.request_id.clone()),
        };
        let user_change = matches!(
            request.command,
            piik_channel_core::wire::Command::Join { .. }
                | piik_channel_core::wire::Command::SetProfile { .. }
        );
        let before = (metadata && !room_projection).then(|| self.authority.clone());
        let mut effects = self.authority.handle(connection, request, now());
        let failed = effects
            .events
            .iter()
            .any(|(target, event)| *target == connection && matches!(event, Event::Error { .. }));
        if metadata && !failed {
            let saved = if user_change {
                self.storage.save_user(&self.authority, connection)
            } else {
                self.storage.save_header(&self.authority)
            };
            if saved.is_err() {
                if room_projection {
                    self.apply(effects);
                    self.send(
                        connection,
                        Event::Error {
                            code: "directory_storage_failed".into(),
                            request_id: None,
                        },
                    );
                    return None;
                }
                self.authority = before.expect("metadata request checkpoint");
                if let Some((room, context)) = deleted {
                    let effects = self.authority.failed_room_delete(&room, &context);
                    self.apply(effects);
                }
                self.send(
                    failure_target,
                    Event::Error {
                        code: "storage_failed".into(),
                        request_id,
                    },
                );
                return None;
            }
        }
        let deferred = if defer_room_result {
            effects
                .events
                .iter()
                .position(|(target, event)| {
                    *target == connection
                        && matches!(
                            event,
                            Event::RoomCreated { .. }
                                | Event::RoomReply {
                                    result: piik_channel_core::host::RoomResult::Deleted { .. },
                                    ..
                                }
                        )
                })
                .map(|index| effects.events.remove(index).1)
        } else {
            None
        };
        self.apply(effects);
        deferred
    }

    fn send(&self, connection: Uuid, mut event: Event) {
        if let Some(origin) = &self.invitation_origin {
            if let Event::Welcome {
                invitation_origin, ..
            } = &mut event
            {
                *invitation_origin = Some(origin.clone());
            }
        }
        if let Some(client) = self.clients.get(&connection) {
            if client.events.try_send(event).is_err() {
                let _ = client.close.send(true);
            }
        }
    }

    fn apply(&mut self, effects: Effects) {
        for (connection, event) in effects.events {
            self.send(connection, event);
        }
        for connection in effects.close {
            if let Some(client) = self.clients.remove(&connection) {
                let _ = client.close.send(true);
            }
        }
    }

    fn expire(&mut self) {
        let effects = self.authority.expire(now());
        self.apply(effects);
    }
}

#[derive(Clone)]
pub struct Domain {
    hub: Arc<Mutex<Hub>>,
    sockets: Arc<Semaphore>,
    room_restore: Arc<Semaphore>,
    closing: watch::Sender<bool>,
    origin: String,
    restores: Option<mpsc::Sender<RestoreDomain>>,
    ice_servers: Vec<serde_json::Value>,
    created: bool,
}

async fn upgrade(
    State(state): State<Domain>,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    let origin = headers.get("origin").and_then(|value| value.to_str().ok());
    let allowed = origin.is_some_and(|origin| state.allows_origin(origin));
    if !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = state.sockets.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let local_entry = origin == Some(state.origin());
    socket
        .max_message_size(piik_channel_core::wire::CHANNEL_MESSAGE_BYTES)
        .max_frame_size(piik_channel_core::wire::CHANNEL_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, state, local_entry).await;
        })
}

async fn identify(State(domain): State<Domain>, headers: HeaderMap) -> crate::backup::ApiResult {
    let forbidden = || crate::backup::error(StatusCode::FORBIDDEN, "forbidden");
    if headers.get(header::ORIGIN).is_some_and(|value| {
        value
            .to_str()
            .ok()
            .is_none_or(|origin| !domain.allows_origin(origin))
    }) {
        return Err(forbidden());
    }
    let credential = crate::backup::bearer(&headers).ok_or_else(forbidden)?;
    let hub = domain.hub.lock().unwrap();
    let user = hub
        .authority
        .user_for_credential(credential)
        .ok_or_else(forbidden)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"domainId": hub.authority.identity().0, "user": user})),
    )
        .into_response())
}

async fn send(
    socket: &mut (impl Sink<Message, Error = axum::Error> + Unpin),
    event: &Event,
    images: &mut piik_channel_core::wire_images::StateImageEncoder,
) -> bool {
    let text = images.encode(event).expect("typed channel event");
    send_frame(socket, Message::Text(text.into())).await
}

async fn send_frame(
    socket: &mut (impl Sink<Message, Error = axum::Error> + Unpin),
    frame: Message,
) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(5), socket.send(frame)).await,
        Ok(Ok(()))
    )
}

async fn create_room(state: &Domain, connection: Uuid, mut request: Request) {
    use piik_channel_core::wire::Command;
    use piik_channel_native::session::{HostCommand, OpenRoom};

    let (room, session, request_id, commands, password, picture, allow_service_relay) = {
        let mut hub = state.hub.lock().unwrap();
        if hub.authority.hosting_mode() == HostingMode::Lightweight {
            hub.request(connection, request);
            return;
        }
        let Command::CreateRoom {
            room,
            password,
            picture,
            allow_service_relay,
        } = &mut request.command
        else {
            unreachable!()
        };
        room.has_password = password.is_some();
        let password = password.take();
        let picture = picture.take();
        let allow_service_relay = *allow_service_relay;
        let Some(Event::RoomCreated { room, request_id }) =
            hub.handle_request(connection, request, true)
        else {
            return;
        };
        (
            room,
            hub.authority.session_for_connection(connection).expect("room creator session"),
            request_id,
            hub.room_commands.clone(),
            password,
            picture,
            allow_service_relay,
        )
    };
    let id = room.id.clone();
    let result = async {
        let commands = commands.ok_or_else(|| "hosting_unavailable".to_owned())?;
        let policy = tokio::task::spawn_blocking(move || {
            hosted_room_policy(room, password, picture, allow_service_relay)
        })
        .await
        .map_err(|_| "hosting_unavailable")??;
        let (result, response) = tokio::sync::oneshot::channel();
        commands
            .try_send(HostCommand::Open(OpenRoom { policy, result }))
            .map_err(|_| "hosting_unavailable")?;
        response.await.unwrap_or_else(|_| Err("room_creation_unconfirmed".into()))
    }
    .await;
    let mut hub = state.hub.lock().unwrap();
    match result {
        Ok(room) => hub.send(connection, Event::RoomCreated { room, request_id }),
        Err(code) => {
            if !matches!(code.as_str(), "room_creation_unconfirmed" | "room_created_connection_failed") {
                let mut effects = Effects::default();
                hub.authority.cancel_reservation(session, &id, &mut effects);
                hub.apply(effects);
            }
            hub.send(connection, Event::Error { code, request_id });
        }
    }
}

fn hosted_room_policy(
    room: RoomSummary,
    password: Option<String>,
    picture: Option<String>,
    allow_service_relay: Option<bool>,
) -> Result<RoomState, &'static str> {
    let mut policy = RoomState::new(
        room.id,
        room.name,
        room.icon,
        room.creator_id,
        room.access,
        room.hidden,
        password,
    )?;
    policy.appearance.picture = picture;
    policy.voice_bitrate = room.voice_bitrate;
    policy.relay_capacity = room.relay_capacity;
    if let Some(allowed) = allow_service_relay {
        policy.allow_service_relay = allowed;
    }
    policy.validate()?;
    Ok(policy)
}

async fn delete_room(state: &Domain, connection: Uuid, request: Request, id: String) {
    use piik_channel_native::session::HostCommand;
    let (reply, creator, commands) = {
        let mut hub = state.hub.lock().unwrap();
        let Some(creator) = hub.authority.offline_hosted_creator(&id) else {
            hub.request(connection, request);
            return;
        };
        // Only the durable, authorized directory removal may retire this room's data.
        let Some(reply) = hub.handle_request(connection, request, true) else {
            return;
        };
        (reply, creator, hub.room_commands.clone())
    };
    let Event::RoomReply {
        room_id,
        request_id,
        ..
    } = reply
    else {
        return;
    };
    let removed = if let Some(commands) = commands {
        let (result, response) = tokio::sync::oneshot::channel();
        commands
            .send(HostCommand::DeleteRetired {
                id: id.clone(),
                creator,
                result,
            })
            .await
            .is_ok()
            && response.await.unwrap_or(false)
    } else {
        false
    };
    let mut hub = state.hub.lock().unwrap();
    if removed {
        let before = hub.authority.clone();
        let effects = hub.authority.finish_hosted_deletion(&id);
        let saved = hub.storage.save_header(&hub.authority).is_ok();
        if saved {
            hub.apply(effects);
            hub.send(
                connection,
                Event::RoomReply {
                    room_id,
                    request_id,
                    result: piik_channel_core::host::RoomResult::Deleted { data_removed: true },
                },
            );
            return;
        }
        hub.authority = before;
    }
    hub.send(
        connection,
        Event::Error {
            request_id,
            code: "storage_failed".into(),
        },
    );
}

async fn dispatch_request(state: &Domain, connection: Uuid, request: Request) {
    if let piik_channel_core::wire::Command::DeleteRoom { room_id, .. } = &request.command {
        let id = room_id.clone();
        return delete_room(state, connection, request, id).await;
    }
    if matches!(
        &request.command,
        piik_channel_core::wire::Command::CreateRoom { .. }
    ) {
        return create_room(state, connection, request).await;
    }
    let (client, event) = {
        let mut hub = state.hub.lock().unwrap();
        if !matches!(
            request.command,
            piik_channel_core::wire::Command::Conversation { .. }
        ) {
            hub.request(connection, request);
            return;
        }
        if !hub
            .clients
            .get(&connection)
            .is_some_and(|client| !*client.close.borrow())
        {
            return;
        }
        let mut effects = hub.authority.handle(connection, request, now());
        // Queue authority snapshots in the turn that produced them. Otherwise a
        // later turn can reach healthy readers while this one waits for a peer.
        let ([(_, Event::Conversation { .. })], []) =
            (effects.events.as_slice(), effects.close.as_slice())
        else {
            hub.apply(effects);
            return;
        };
        let (target, event) = effects.events.pop().unwrap();
        let Some(client) = hub.clients.get(&target).cloned() else {
            return;
        };
        (client, event)
    };
    // History pages span more than one socket queue. Wait for the sole recipient.
    let mut closing = client.close.subscribe();
    if *closing.borrow() {
        return;
    }
    let sent = tokio::select! {
        _ = closing.changed() => return,
        sent = tokio::time::timeout(Duration::from_secs(5), client.events.send(event)) => sent,
    };
    if !matches!(sent, Ok(Ok(()))) {
        let _ = client.close.send(true);
    }
}

async fn session(mut socket: WebSocket, state: Domain, local_entry: bool) {
    let mut domain_closing = state.closing.subscribe();
    if *domain_closing.borrow() {
        return;
    }
    let mut images = piik_channel_core::wire_images::StateImageEncoder::default();
    let first = tokio::select! {
        _ = domain_closing.changed() => return,
        first = tokio::time::timeout(Duration::from_secs(10), socket.recv()) => first,
    };
    let text = match first {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => return,
    };
    let mut request = match Request::parse(&text) {
        Ok(request) => request,
        Err((request_id, code)) => {
            send(
                &mut socket,
                &Event::Error {
                    code: code.into(),
                    request_id,
                },
                &mut images,
            )
            .await;
            return;
        }
    };
    let connection = Uuid::new_v4();
    let (events, mut queue) = mpsc::channel(64);
    let (close, mut closing) = watch::channel(false);
    let close_writer = close.clone();
    {
        let mut hub = state.hub.lock().unwrap();
        if *domain_closing.borrow() {
            return;
        }
        if local_entry {
            hub.redeem_launch(&mut request);
        }
        hub.clients.insert(connection, Client { events, close });
        hub.request(connection, request);
    }
    let (mut writer, mut reader) = socket.split();
    {
        // A blocked write must not stop reading HostOutput: the room host may
        // itself be waiting for us to drain its large response before reading.
        let writing = async {
            let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
            loop {
                tokio::select! {
                    _ = closing.changed() => {
                        let _ = tokio::time::timeout(Duration::from_secs(5), async {
                            while let Ok(item) = queue.try_recv() {
                                if !send(&mut writer, &item, &mut images).await { break; }
                            }
                        }).await;
                        break;
                    }
                    item = queue.recv() => {
                        let Some(item) = item else { break; };
                        if !send(&mut writer, &item, &mut images).await { break; }
                    }
                    _ = heartbeat.tick() => {
                        if !send_frame(&mut writer, Message::Ping(Vec::new().into())).await { break; }
                    }
                }
            }
            send_frame(&mut writer, Message::Close(None)).await;
        };
        let reading = async {
            let mut last_seen = tokio::time::Instant::now();
            loop {
                let incoming = tokio::select! {
                    _ = tokio::time::sleep_until(last_seen + Duration::from_secs(20)) => break,
                    incoming = reader.next() => incoming,
                };
                last_seen = tokio::time::Instant::now();
                match incoming {
                    Some(Ok(Message::Text(text))) => match Request::parse(&text) {
                        Ok(value) => dispatch_request(&state, connection, value).await,
                        Err((request_id, code)) => state.hub.lock().unwrap().send(
                            connection,
                            Event::Error {
                                code: code.into(),
                                request_id,
                            },
                        ),
                    },
                    // Axum replies to Ping automatically.
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => break,
                }
            }
        };
        tokio::pin!(writing, reading);
        tokio::select! {
            _ = &mut writing => {},
            _ = &mut reading => {
                let _ = close_writer.send(true);
                writing.await;
            }
        }
    }
    {
        let mut hub = state.hub.lock().unwrap();
        hub.clients.remove(&connection);
        let effects = hub.authority.disconnect(connection, now());
        hub.apply(effects);
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Domain {
    pub fn open(
        directory: &Path,
        owner_seed: &str,
        origin: String,
        invitation_origin: Option<String>,
        ice_servers: Vec<serde_json::Value>,
    ) -> anyhow::Result<Self> {
        Self::open_with_options(
            directory,
            owner_seed,
            origin,
            invitation_origin,
            ice_servers,
            RoomCreationPolicy::Ordinary,
            None,
        )
    }

    /// Seed channel settings on first startup. Without a Server mode, only
    /// lightweight channels supported by App can be opened.
    pub fn open_with_options(
        directory: &Path,
        owner_seed: &str,
        origin: String,
        invitation_origin: Option<String>,
        ice_servers: Vec<serde_json::Value>,
        initial_policy: RoomCreationPolicy,
        server_mode: Option<HostingMode>,
    ) -> anyhow::Result<Self> {
        let origin = crate::web::origin(&origin)?;
        let invitation_origin = invitation_origin
            .as_deref()
            .map(crate::web::origin)
            .transpose()?;
        anyhow::ensure!(
            directory != Path::new(":memory:"),
            "PIIK_CHANNEL_DATA_DIR must be a real directory"
        );
        std::fs::create_dir_all(directory)?;
        let directory_owner = std::fs::File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("channel.lock"))?;
        piik_channel_native::hosted_room::try_lock_file(&directory_owner).map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                anyhow::anyhow!("This channel data directory is already in use")
            } else {
                error.into()
            }
        })?;
        let storage = storage::DomainStorage::open(&directory.join("channel.sqlite"))
            .map_err(anyhow::Error::from_boxed)?;
        let checkpoint = storage.load().map_err(anyhow::Error::from_boxed)?;
        let created = checkpoint.is_none();
        let authority = match checkpoint {
            Some(metadata) => {
                anyhow::ensure!(
                    server_mode.is_some()
                        || metadata.state.hosting_mode() == HostingMode::Lightweight,
                    "hosted_channel_requires_server",
                );
                metadata
                    .into_authority(ice_servers.clone())
                    .map_err(anyhow::Error::msg)?
            }
            None => {
                let mut authority = Authority::new(owner_seed.into(), ice_servers.clone())
                    .map_err(anyhow::Error::msg)
                    .context("A new site requires its local owner bootstrap key")?;
                authority.set_room_creation_policy(initial_policy);
                authority.set_hosting_mode(server_mode.unwrap_or(HostingMode::Lightweight));
                authority
            }
        };
        if created {
            storage.save_header(&authority).map_err(anyhow::Error::from_boxed)?;
        }
        Ok(Domain {
            hub: Arc::new(Mutex::new(Hub {
                authority,
                launch_tickets: BTreeMap::new(),
                clients: BTreeMap::new(),
                storage,
                _directory_owner: Some(directory_owner),
                invitation_origin,
                room_commands: None,
            })),
            sockets: Arc::new(Semaphore::new(2 * piik_channel_core::MAX_SESSIONS)),
            room_restore: Arc::new(Semaphore::new(1)),
            closing: watch::channel(false).0,
            origin,
            restores: None,
            ice_servers,
            created,
        })
    }

    /// The channel and its owner's user ID; neither carries admission secrets.
    pub fn identity(&self) -> (Uuid, Uuid) {
        self.hub.lock().unwrap().authority.identity()
    }

    pub(crate) fn register_service(
        &self,
        endpoint: piik_channel_core::host::ServiceEndpoint,
        transit: Option<piik_channel_core::host::TransitKinds>,
    ) -> bool {
        let mut hub = self.hub.lock().unwrap();
        if hub.authority.set_room_writer(endpoint).is_err() {
            return false;
        }
        if let Some(kinds) = transit {
            let service = piik_channel_core::host::ServiceTransit { endpoint, kinds };
            if let Ok(effects) = hub.authority.set_service_endpoint(Some(service)) {
                hub.apply(effects);
            }
        }
        true
    }

    pub(crate) fn set_room_commands(
        &self,
        commands: Option<mpsc::Sender<piik_channel_native::session::HostCommand>>,
    ) {
        self.hub.lock().unwrap().room_commands = commands;
    }

    pub(crate) fn with_restores(mut self, restores: mpsc::Sender<RestoreDomain>) -> Self {
        self.restores = Some(restores);
        self
    }

    pub(crate) fn was_created(&self) -> bool {
        self.created
    }

    pub(crate) fn is_owner_credential(&self, credential: &str) -> bool {
        self.hub
            .lock()
            .unwrap()
            .authority
            .is_owner_credential(credential)
    }

    /// Called by the service after joining its Native operators. The checkpoint
    /// and authority change in one Hub turn; old sockets cannot write afterward.
    pub(crate) fn restore(
        &self,
        metadata: DomainMetadata,
        credential: &str,
    ) -> anyhow::Result<Uuid> {
        let authority = metadata
            .clone()
            .into_authority(self.ice_servers.clone())
            .map_err(anyhow::Error::msg)?;
        let mut hub = self.hub.lock().unwrap();
        anyhow::ensure!(hub.authority.is_owner_credential(credential), "forbidden");
        hub.storage
            .replace(metadata)
            .map_err(anyhow::Error::from_boxed)?;
        hub.authority = authority;
        hub.launch_tickets.clear();
        for client in std::mem::take(&mut hub.clients).into_values() {
            client.close.send_replace(true);
        }
        Ok(hub.authority.identity().0)
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub(crate) fn allows_origin(&self, origin: &str) -> bool {
        origin == self.origin
            || self.hub.lock().unwrap().invitation_origin.as_deref() == Some(origin)
    }

    pub fn owner_name(&self) -> Option<String> {
        self.hub
            .lock()
            .unwrap()
            .authority
            .owner_name()
            .map(str::to_owned)
    }

    /// Only an explicit App launcher navigation issues a bearer for the first Join.
    pub(crate) fn launch_ticket(&self) -> anyhow::Result<String> {
        // Allow time for an external browser to start and load the site.
        const LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
        let mut hub = self.hub.lock().unwrap();
        let now = Instant::now();
        hub.launch_tickets.retain(|_, expiry| *expiry > now);
        anyhow::ensure!(hub.launch_tickets.len() < piik_channel_core::MAX_SESSIONS, "Too many pending site launches");
        let ticket = Uuid::new_v4().to_string();
        hub.launch_tickets.insert(ticket.clone(), now + LAUNCH_TIMEOUT);
        Ok(ticket)
    }

    /// Private local bootstrap only; this value never enters client state.
    pub fn owner_key(&self) -> String {
        self.hub
            .lock()
            .unwrap()
            .authority
            .owner_admission_key()
            .to_owned()
    }

    pub async fn serve(
        self,
        listener: tokio::net::TcpListener,
        routes: Router,
        stop: impl Future<Output = ()>,
    ) -> anyhow::Result<()> {
        self.serve_with_https(listener, None, routes, stop).await
    }

    /// One domain, clock and shutdown owner serve both pre-bound entries.
    pub async fn serve_with_https(
        self,
        listener: tokio::net::TcpListener,
        https: Option<crate::web::LanHttps>,
        routes: Router,
        stop: impl Future<Output = ()>,
    ) -> anyhow::Result<()> {
        let app = Router::new()
            .route("/healthz", get(|| async { HEALTH_MARKER }))
            .route("/prototype/channel", get(upgrade))
            .route("/prototype/channel/identity", get(identify))
            .route(
                "/prototype/channel/backup",
                get(backup::export_domain).put(backup::restore_domain),
            )
            .route(
                "/prototype/channel/rooms/{room}/backup",
                get(backup::export).put(backup::restore_existing),
            )
            .route("/prototype/channel/rooms/backup", put(backup::restore))
            .route("/prototype/channel/rooms/copy", post(backup::create_copy))
            .route("/prototype/channel/hosting", get(backup::describe))
            .with_state(self.clone())
            .merge(routes);
        let (stop_http, mut http_stopped) = watch::channel(false);
        let http = crate::web::serve_http(listener, app.clone(), async move {
            let _ = http_stopped.changed().await;
        });
        let mut servers = FuturesUnordered::new();
        servers.push(http.boxed());
        let stop_https = axum_server::Handle::new();
        if let Some(https) = https {
            let server = axum_server::from_tcp_rustls(https.listener.into_std()?, https.config)?
                .map(|acceptor| acceptor.acceptor(axum_server::accept::NoDelayAcceptor::new()))
                .handle(stop_https.clone())
                .serve(app.into_make_service());
            servers.push(server.boxed());
        }
        let expiry = async {
            let mut timer = tokio::time::interval(Duration::from_secs(1));
            loop {
                timer.tick().await;
                self.hub.lock().unwrap().expire();
            }
        };
        tokio::pin!(expiry, stop);
        let mut result = tokio::select! {
            _ = &mut stop => Ok(()),
            result = servers.next() => result.expect("HTTP entry is present"),
            _ = &mut expiry => unreachable!(),
        };
        // A failed listener must retire its WebSocket owners as well.
        self.close_clients();
        let _ = stop_http.send(true);
        stop_https.graceful_shutdown(Some(crate::web::HTTP_DRAIN_TIMEOUT));
        while let Some(closed) = servers.next().await {
            if result.is_ok() {
                result = closed;
            }
        }
        Ok(result?)
    }

    fn close_clients(&self) {
        let hub = self.hub.lock().unwrap();
        self.closing.send_replace(true);
        for client in hub.clients.values() {
            let _ = client.close.send(true);
        }
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod runtime_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use piik_channel_core::{
        host::{HostInput, RoomSummary},
        RoomState, StoredRoomHost,
    };
    use serde_json::json;

    #[test]
    fn owner_launch_tickets_are_independent_single_use_and_end_on_restore() {
        let directory = tempfile::tempdir().unwrap();
        let domain = Domain::open(directory.path(), "seed", "http://127.0.0.1:8787".into(), None, vec![]).unwrap();
        let redeem = |ticket: &str| {
            let mut join = Request::parse(&json!({"type":"join","name":"Operator","ownerKey":ticket,
                "protocol":piik_channel_core::wire::CHANNEL_PROTOCOL,"signingKey":vec![0;32]}).to_string()).unwrap();
            let mut hub = domain.hub.lock().unwrap();
            hub.redeem_launch(&mut join);
            let piik_channel_core::wire::Command::Join { owner_key, .. } = join.command else { unreachable!() };
            owner_key.unwrap()
        };
        let first = domain.launch_ticket().unwrap();
        let second = domain.launch_ticket().unwrap();
        assert_ne!(first, second);
        assert_eq!(redeem(&first), "seed");
        assert_eq!(redeem(&first), first);
        assert_eq!(redeem(&second), "seed");

        let expired = domain.launch_ticket().unwrap();
        domain.hub.lock().unwrap().launch_tickets.insert(expired.clone(), Instant::now());
        assert_eq!(redeem(&expired), expired);

        let pending = domain.launch_ticket().unwrap();
        let (credential, backup) = {
            let mut hub = domain.hub.lock().unwrap();
            let join = Request::parse(&json!({"type":"join","name":"Operator","ownerKey":"seed",
                "protocol":piik_channel_core::wire::CHANNEL_PROTOCOL,"signingKey":vec![0;32]}).to_string()).unwrap();
            let effects = hub.authority.handle(Uuid::new_v4(), join, 0);
            let credential = effects.events.into_iter().find_map(|(_, event)| match event {
                Event::Welcome { credential, .. } => Some(credential), _ => None,
            }).unwrap();
            (credential, hub.authority.export_backup())
        };
        domain.restore(backup, &credential).unwrap();
        assert_eq!(redeem(&pending), pending);
    }

    #[test]
    fn failed_deleted_room_checkpoint_keeps_only_an_offline_retry_entry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("domain.sqlite");
        let authority = Authority::new("owner".into(), vec![]).unwrap();
        let storage = storage::DomainStorage::open(&path).unwrap();
        storage
            .save_header(&authority)
            .unwrap();
        let connection = Uuid::new_v4();
        let (events, mut receiver) = mpsc::channel(64);
        let mut hub = Hub {
            _directory_owner: None,
            authority,
            launch_tickets: BTreeMap::new(),
            clients: [(
                connection,
                Client {
                    events,
                    close: watch::channel(false).0,
                },
            )]
            .into(),
            storage,
            invitation_origin: None,
            room_commands: None,
        };
        let request = |mut value: serde_json::Value| {
            if value["type"] == "join" {
                value["protocol"] = serde_json::json!(piik_channel_core::wire::CHANNEL_PROTOCOL);
            }
            Request::parse(&value.to_string()).unwrap()
        };
        let drain = |receiver: &mut mpsc::Receiver<Event>| {
            let mut events = Vec::new();
            while let Ok(event) = receiver.try_recv() {
                events.push(event);
            }
            events
        };
        hub.request(
            connection,
            request(
                json!({"type":"join","canUsePeerTransport":false,"name":"Owner","ownerKey":"owner","signingKey":vec![0;32]}),
            ),
        );
        drain(&mut receiver);
        let owner = hub.authority.identity().1;
        let mut policy = RoomState::new(
            "unused".into(),
            "Delete".into(),
            Default::default(),
            owner,
            piik_channel_core::wire::RoomAccess::Public,
            false,
            None,
        )
        .unwrap();
        hub.request(connection, request(json!({"type":"create_room","room":RoomSummary::from_policy(&policy),"requestId":"create"})));
        policy.id = drain(&mut receiver)
            .into_iter()
            .find_map(|event| match event {
                Event::RoomCreated { room, .. } => Some(room.id),
                _ => None,
            })
            .unwrap();
        let id = policy.id.clone();
        let mut host = StoredRoomHost::create(Path::new(":memory:"), policy).unwrap();
        hub.request(
            connection,
            request(json!({"type":"host_register","room":host.summary()})),
        );
        let input: HostInput = drain(&mut receiver)
            .into_iter()
            .find_map(|event| match event {
                Event::HostInput { input, .. } => Some(input),
                _ => None,
            })
            .unwrap();
        let output = host.dispatch(input).unwrap();
        hub.request(
            connection,
            request(json!({"type":"host_output","roomId":id,"output":output})),
        );
        drain(&mut receiver);
        hub.request(
            connection,
            request(
                json!({"type":"delete_room","deleteData":true,"roomId":id,"requestId":"delete"}),
            ),
        );
        let input = drain(&mut receiver)
            .into_iter()
            .find_map(|event| match event {
                Event::HostInput { input, .. } => Some(input),
                _ => None,
            })
            .unwrap();
        let output = host.dispatch(input).unwrap();
        let failure = rusqlite::Connection::open(&path).unwrap();
        failure.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'held'); END;").unwrap();
        hub.request(
            connection,
            request(json!({"type":"host_output","roomId":id,"output":output})),
        );
        let failed = drain(&mut receiver);
        assert!(failed.iter().any(|event| matches!(event, Event::Error { code, request_id: Some(request) } if code == "storage_failed" && request == "delete")));
        assert!(failed.iter().any(|event| matches!(event, Event::State { state } if state.channel.rooms.iter().any(|room| room.id == id && !room.available))));
        assert!(!failed.iter().any(|event| matches!(
            event,
            Event::RoomReply {
                result: piik_channel_core::host::RoomResult::Deleted { .. },
                ..
            }
        )));
        failure
            .execute_batch("DROP TRIGGER reject_checkpoint")
            .unwrap();
        hub.request(
            connection,
            request(
                json!({"type":"delete_room","deleteData":true,"roomId":id,"requestId":"retry"}),
            ),
        );
        assert!(drain(&mut receiver).iter().any(|event| matches!(
            event,
            Event::RoomReply {
                result: piik_channel_core::host::RoomResult::Deleted {
                    data_removed: false
                },
                ..
            }
        )));
        let saved = serde_json::to_value(hub.storage.load().unwrap().unwrap()).unwrap();
        assert!(saved["state"]["hostedRooms"]
            .as_object()
            .unwrap()
            .is_empty());
    }
}
