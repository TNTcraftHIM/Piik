use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{stream::FuturesUnordered, FutureExt, Sink, SinkExt, StreamExt};
use piik_channel_core::{
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

struct Client {
    events: mpsc::Sender<Event>,
    close: watch::Sender<bool>,
}

struct Hub {
    authority: Authority,
    clients: BTreeMap<Uuid, Client>,
    storage: Arc<Mutex<storage::Storage>>,
    invitation_origin: Option<String>,
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
        // Completing an invited identity still belongs to the domain transaction.
        let room_projection = matches!(&request.command,
            piik_channel_core::wire::Command::HostOutput { output, .. }
            if !output.reply.as_ref().is_some_and(|reply| matches!(reply.result,
                piik_channel_core::host::RoomResult::Invited)));
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
                serde_json::to_value(self.authority.export_state()).expect("typed metadata");
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
}

async fn upgrade(
    State(state): State<Domain>,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    let origin = headers.get("origin").and_then(|value| value.to_str().ok());
    let allowed = origin.is_some_and(|origin| {
        origin == state.origin.as_str()
            || state.hub.lock().unwrap().invitation_origin.as_deref() == Some(origin)
    });
    if !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = state.sockets.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    socket
        .max_message_size(2 * 1024 * 1024)
        .max_frame_size(2 * 1024 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, state).await;
        })
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
                        Ok(request) => state.hub.lock().unwrap().request(connection, request),
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
        owner: &str,
        invite: &str,
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
        let mut authority =
            Authority::new(owner.into(), invite.into(), ice_servers).map_err(anyhow::Error::msg)?;
        if let Some(checkpoint) = storage.load().map_err(anyhow::Error::from_boxed)? {
            authority
                .import_state(serde_json::from_value(checkpoint)?)
                .map_err(anyhow::Error::msg)?;
        }
        storage
            .save(&serde_json::to_value(authority.export_state())?)
            .map_err(anyhow::Error::from_boxed)?;
        Ok(Domain {
            hub: Arc::new(Mutex::new(Hub {
                authority,
                clients: BTreeMap::new(),
                storage: Arc::new(Mutex::new(storage)),
                invitation_origin,
            })),
            sockets: Arc::new(Semaphore::new(40)),
            origin,
        })
    }

    /// The channel and its owner's user ID; neither carries admission secrets.
    pub fn identity(&self) -> (Uuid, Uuid) {
        self.hub.lock().unwrap().authority.identity()
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn owner_name(&self) -> Option<String> {
        self.hub
            .lock()
            .unwrap()
            .authority
            .owner_name()
            .map(str::to_owned)
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
            .route(
                "/prototype/channel/limits",
                get(|| async { axum::Json(piik_channel_core::ATTACHMENT_LIMITS) }),
            )
            .with_state(self.clone())
            .merge(routes);
        let (stop_http, mut http_stopped) = watch::channel(false);
        let http = axum::serve(listener, app.clone())
            .with_graceful_shutdown(async move {
                let _ = http_stopped.changed().await;
            })
            .into_future();
        let mut servers = FuturesUnordered::new();
        servers.push(http.boxed());
        let stop_https = axum_server::Handle::new();
        if let Some(https) = https {
            let server = axum_server::from_tcp_rustls(https.listener.into_std()?, https.config)?
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
