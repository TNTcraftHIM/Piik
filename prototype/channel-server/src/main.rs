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
use futures_util::{Sink, SinkExt, StreamExt};
use piik_channel_core::{
    storage,
    wire::{Event, Request},
    Authority, Effects,
};
use piik_channel_native::session::{self as native, Config, RoomFile};
use std::{
    collections::BTreeMap,
    future::{Future, IntoFuture},
    path::{Path, PathBuf},
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

    fn send(&self, connection: Uuid, event: Event) {
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
struct AppState {
    hub: Arc<Mutex<Hub>>,
    sockets: Arc<Semaphore>,
    origin: String,
}

async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    if headers.get("origin").and_then(|value| value.to_str().ok()) != Some(state.origin.as_str()) {
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

async fn session(mut socket: WebSocket, state: AppState) {
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

fn open_state(
    directory: &Path,
    owner: &str,
    invite: &str,
    origin: String,
    ice_servers: Vec<serde_json::Value>,
) -> anyhow::Result<AppState> {
    anyhow::ensure!(
        directory != Path::new(":memory:"),
        "PIIK_CHANNEL_DATA_DIR must be a real directory"
    );
    std::fs::create_dir_all(directory.join("rooms"))?;
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
    Ok(AppState {
        hub: Arc::new(Mutex::new(Hub {
            authority,
            clients: BTreeMap::new(),
            storage: Arc::new(Mutex::new(storage)),
        })),
        sockets: Arc::new(Semaphore::new(40)),
        origin,
    })
}

async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    directory: PathBuf,
    owner: String,
    stop: impl Future<Output = ()>,
) -> anyhow::Result<()> {
    let config = Config {
        url: format!("ws://{}/prototype/channel", listener.local_addr()?),
        origin: state.origin.clone(),
        name: state
            .hub
            .lock()
            .unwrap()
            .authority
            .owner_name()
            .unwrap_or("Piik Server")
            .into(),
        key: Some(owner),
        credential: None,
    };
    let rooms = [
        ("living", "Living room"),
        ("studio", "Studio"),
        ("quiet", "Quiet corner"),
    ]
    .into_iter()
    .map(|(id, name)| RoomFile {
        path: directory.join("rooms").join(format!("{id}.sqlite")),
        id: id.into(),
        name: name.into(),
    })
    .collect();
    let app = Router::new()
        .route("/healthz", get(|| async { "piik-channel-prototype" }))
        .route("/prototype/channel", get(upgrade))
        .route(
            "/prototype/channel/limits",
            get(|| async { axum::Json(piik_channel_core::ATTACHMENT_LIMITS) }),
        )
        .with_state(state.clone());
    let (stop_native, mut native_stopped) = watch::channel(false);
    let (stop_http, mut http_stopped) = watch::channel(false);
    let hosting = native::run(config, rooms, async {
        let _ = native_stopped.changed().await;
    });
    let mut http = tokio::spawn(
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = http_stopped.changed().await;
            })
            .into_future(),
    );
    let expiry = async {
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        loop {
            timer.tick().await;
            state.hub.lock().unwrap().expire();
        }
    };
    tokio::pin!(hosting, stop, expiry);
    let (result, finished_http) = tokio::select! {
        _ = &mut stop => {
            let _ = stop_native.send(true);
            (hosting.await, None)
        }
        result = &mut hosting => (result.and_then(|()| Err(anyhow::anyhow!("Native hosting stopped unexpectedly"))), None),
        result = &mut http => {
            let _ = stop_native.send(true);
            let closed = hosting.await;
            (closed.and_then(|()| Err(anyhow::anyhow!("HTTP service stopped unexpectedly"))), Some(result))
        }
        _ = &mut expiry => unreachable!(),
    };
    // Native departure is acknowledged while its WebSocket service is live.
    // Only then close the remaining clients and drain the HTTP service.
    let _ = stop_http.send(true);
    for client in state.hub.lock().unwrap().clients.values() {
        let _ = client.close.send(true);
    }
    let http_result = match finished_http {
        Some(result) => result,
        None => http.await,
    };
    http_result??;
    result
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port = std::env::var("PIIK_CHANNEL_PORT")
        .unwrap_or_else(|_| "8791".into())
        .parse::<u16>()
        .expect("PIIK_CHANNEL_PORT must be a port");
    let origin =
        std::env::var("PIIK_CHANNEL_WEB_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:8790".into());
    let owner = std::env::var("PIIK_CHANNEL_OWNER_KEY")
        .expect("Set PIIK_CHANNEL_OWNER_KEY to a private stable startup key");
    let invite = std::env::var("PIIK_CHANNEL_INVITE_KEY")
        .expect("Set PIIK_CHANNEL_INVITE_KEY to a separate stable invitation key");
    let ice_servers = std::env::var("PIIK_CHANNEL_ICE_SERVERS")
        .map(|value| {
            serde_json::from_str::<Vec<serde_json::Value>>(&value)
                .expect("PIIK_CHANNEL_ICE_SERVERS must be a JSON array")
        })
        .unwrap_or_default();
    let directory = std::env::var("PIIK_CHANNEL_DATA_DIR")
        .unwrap_or_else(|_| "build/channel-prototype-data".into());
    let directory = PathBuf::from(directory);
    let state = open_state(&directory, &owner, &invite, origin.clone(), ice_servers)?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("Piik Rust channel prototype: http://127.0.0.1:{port}");
    println!(
        "Web interface: {origin}/__channel-preview (use your configured owner or invitation key)"
    );
    serve(listener, state, directory, owner, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}

#[cfg(test)]
mod runtime_tests;
