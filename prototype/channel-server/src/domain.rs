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
    routing::{get, put},
    Json, Router,
};
pub(crate) use backup::RestoreDomain;
use futures_util::{stream::FuturesUnordered, FutureExt, Sink, SinkExt, StreamExt};
use piik_channel_core::{
    backup::DomainMetadata,
    storage,
    wire::{Event, Request},
    Authority, Effects,
};
use std::{
    collections::BTreeMap,
    future::{Future, IntoFuture},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch, Semaphore};
use uuid::Uuid;

#[derive(Clone)]
struct Client {
    events: mpsc::Sender<Event>,
    close: watch::Sender<bool>,
}

struct Hub {
    authority: Authority,
    clients: BTreeMap<Uuid, Client>,
    storage: Arc<Mutex<storage::Storage>>,
    invitation_origin: Option<String>,
    room_commands: Option<mpsc::Sender<piik_channel_native::session::HostCommand>>,
}

impl Hub {
    fn request(&mut self, connection: Uuid, request: Request) {
        if !self
            .clients
            .get(&connection)
            .is_some_and(|client| !*client.close.borrow())
        {
            return;
        }
        let metadata = self.authority.changes_metadata(&request);
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
        let before = (metadata && !room_projection).then(|| self.authority.clone());
        let effects = self.authority.handle(connection, request, now());
        let failed = effects
            .events
            .iter()
            .any(|(target, event)| *target == connection && matches!(event, Event::Error { .. }));
        if metadata && !failed {
            let checkpoint =
                serde_json::to_value(self.authority.export_backup()).expect("typed metadata");
            if self.storage.lock().unwrap().save(&checkpoint).is_err() {
                if room_projection {
                    self.apply(effects);
                    self.send(
                        connection,
                        Event::Error {
                            code: "directory_storage_failed".into(),
                            request_id: None,
                        },
                    );
                    return;
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
                return;
            }
        }
        self.apply(effects);
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
    socket
        .max_message_size(piik_channel_core::wire::CHANNEL_MESSAGE_BYTES)
        .max_frame_size(piik_channel_core::wire::CHANNEL_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, state).await;
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
) -> bool {
    let text = serde_json::to_string(event).expect("typed channel event");
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

async fn dispatch_request(state: &Domain, connection: Uuid, request: Request) {
    let (events, close) = {
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
        let effects = hub.authority.handle(connection, request, now());
        let events = effects
            .events
            .into_iter()
            .filter_map(|(connection, event)| {
                hub.clients
                    .get(&connection)
                    .cloned()
                    .map(|client| (client, event))
            })
            .collect::<Vec<_>>();
        (events, effects.close)
    };
    // A history page produces more frames than the socket's 64-event queue.
    // Backpressure belongs to this reader turn, never the shared authority lock.
    for (client, event) in events {
        let mut closing = client.close.subscribe();
        if *closing.borrow() {
            continue;
        }
        let sent = tokio::select! {
            _ = closing.changed() => continue,
            sent = tokio::time::timeout(Duration::from_secs(5), client.events.send(event)) => sent,
        };
        if !matches!(sent, Ok(Ok(()))) {
            let _ = client.close.send(true);
        }
    }
    state.hub.lock().unwrap().apply(Effects {
        events: Vec::new(),
        close,
    });
}

async fn session(mut socket: WebSocket, state: Domain) {
    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv()).await;
    let text = match first {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => return,
    };
    let request = match Request::parse(&text) {
        Ok(request) => request,
        Err((request_id, code)) => {
            send(
                &mut socket,
                &Event::Error {
                    code: code.into(),
                    request_id,
                },
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
                                if !send(&mut writer, &item).await { break; }
                            }
                        }).await;
                        break;
                    }
                    item = queue.recv() => {
                        let Some(item) = item else { break; };
                        if !send(&mut writer, &item).await { break; }
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
        let mut storage = storage::Storage::open(&directory.join("channel.sqlite"))
            .map_err(anyhow::Error::from_boxed)?;
        let checkpoint = storage.load().map_err(anyhow::Error::from_boxed)?;
        let created = checkpoint.is_none();
        let authority = match checkpoint {
            Some(checkpoint) => serde_json::from_value::<DomainMetadata>(checkpoint)
                .context("unsupported_domain_checkpoint: preserve the existing data and use a supported backup or a fresh directory")?
                .into_authority(ice_servers.clone())
                .map_err(anyhow::Error::msg)?,
            None => Authority::new(owner_seed.into(), ice_servers.clone())
                .map_err(anyhow::Error::msg)
                .context("A new site requires its local owner bootstrap key")?,
        };
        storage
            .save(&serde_json::to_value(authority.export_backup())?)
            .map_err(anyhow::Error::from_boxed)?;
        Ok(Domain {
            hub: Arc::new(Mutex::new(Hub {
                authority,
                clients: BTreeMap::new(),
                storage: Arc::new(Mutex::new(storage)),
                invitation_origin,
                room_commands: None,
            })),
            sockets: Arc::new(Semaphore::new(40)),
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
        let checkpoint = serde_json::to_value(metadata)?;
        let mut hub = self.hub.lock().unwrap();
        anyhow::ensure!(hub.authority.is_owner_credential(credential), "forbidden");
        hub.storage
            .lock()
            .unwrap()
            .save(&checkpoint)
            .map_err(anyhow::Error::from_boxed)?;
        hub.authority = authority;
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
            .route("/healthz", get(|| async { "piik-channel-prototype" }))
            .route("/prototype/channel", get(upgrade))
            .route("/prototype/channel/identity", get(identify))
            .route(
                "/prototype/channel/backup",
                get(backup::export_domain).put(backup::restore_domain),
            )
            .route(
                "/prototype/channel/rooms/{room}/backup",
                get(backup::export),
            )
            .route("/prototype/channel/rooms/backup", put(backup::restore))
            .route("/prototype/channel/hosting", get(backup::describe))
            .route(
                "/prototype/channel/limits",
                get(|| async { axum::Json(piik_channel_core::ATTACHMENT_LIMITS) }),
            )
            .with_state(self.clone())
            .merge(routes);
        let (stop_http, mut http_stopped) = watch::channel(false);
        let http = axum::serve(crate::web::http_listener(listener), app.clone())
            .with_graceful_shutdown(async move {
                let _ = http_stopped.changed().await;
            })
            .into_future();
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
        stop_https.graceful_shutdown(None);
        while let Some(closed) = servers.next().await {
            if result.is_ok() {
                result = closed;
            }
        }
        Ok(result?)
    }

    fn close_clients(&self) {
        for client in self.hub.lock().unwrap().clients.values() {
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
    fn failed_deleted_room_checkpoint_keeps_only_an_offline_retry_entry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("domain.sqlite");
        let authority = Authority::new("owner".into(), vec![]).unwrap();
        let mut storage = storage::Storage::open(&path).unwrap();
        storage
            .save(&serde_json::to_value(authority.export_backup()).unwrap())
            .unwrap();
        let connection = Uuid::new_v4();
        let (events, mut receiver) = mpsc::channel(64);
        let mut hub = Hub {
            authority,
            clients: [(
                connection,
                Client {
                    events,
                    close: watch::channel(false).0,
                },
            )]
            .into(),
            storage: Arc::new(Mutex::new(storage)),
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
                json!({"type":"join","name":"Owner","ownerKey":"owner","signingKey":vec![0;32]}),
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
        let saved = hub.storage.lock().unwrap().load().unwrap().unwrap();
        assert!(saved["state"]["hostedRooms"]
            .as_object()
            .unwrap()
            .is_empty());
    }
}
