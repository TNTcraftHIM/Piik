mod attachments;
mod storage;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use piik_channel_prototype::{
    wire::{Command, Event, Request},
    Authority, Effects,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
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
        let durable = request.changes_durable_state();
        let request_id = request.request_id.clone();
        if let Command::Chat {
            room_id,
            attachments,
            ..
        } = &request.command
        {
            if !attachments.is_empty() {
                let valid = self
                    .authority
                    .authorize_connection(
                        connection,
                        room_id,
                        piik_channel_prototype::RoomPermission::Write,
                    )
                    .map_err(|_| ())
                    .and_then(|user| {
                        self.storage
                            .lock()
                            .unwrap()
                            .validate(room_id, user, attachments)
                            .map_err(|_| ())
                    });
                if valid.is_err() {
                    self.send(
                        connection,
                        Event::Error {
                            code: "attachment_unavailable".into(),
                            request_id,
                        },
                    );
                    return;
                }
            }
        }
        let before = durable.then(|| self.authority.clone());
        let effects = self.authority.handle(connection, request, now());
        let failed = effects
            .events
            .iter()
            .any(|(target, event)| *target == connection && matches!(event, Event::Error { .. }));
        if durable && !failed {
            let checkpoint =
                serde_json::to_value(self.authority.export_state()).expect("typed durable state");
            let references = self.authority.referenced_attachments();
            if self
                .storage
                .lock()
                .unwrap()
                .save(&checkpoint, &references, now())
                .is_err()
            {
                self.authority = before.expect("durable request checkpoint");
                self.send(
                    connection,
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
    storage: Arc<Mutex<storage::Storage>>,
    transfers: Arc<Semaphore>,
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
        .max_message_size(256 * 1024)
        .max_frame_size(256 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, state).await;
        })
}

async fn send(socket: &mut WebSocket, event: &Event) -> bool {
    let text = serde_json::to_string(event).expect("typed channel event");
    send_frame(socket, Message::Text(text.into())).await
}

async fn send_frame(socket: &mut WebSocket, frame: Message) -> bool {
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
    {
        let mut hub = state.hub.lock().unwrap();
        hub.clients.insert(connection, Client { events, close });
        hub.request(connection, request);
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let mut last_seen = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _ = closing.changed() => {
                // Leave/error responses may be queued before close. Give the
                // whole flush one write budget, not one budget per queued event.
                let _ = tokio::time::timeout(Duration::from_secs(5), async {
                    while let Ok(event) = queue.try_recv() { if !send(&mut socket, &event).await { break; } }
                }).await;
                break;
            },
            event = queue.recv() => {
                let Some(event) = event else { break; };
                if !send(&mut socket, &event).await { break; }
            }
            incoming = socket.recv() => {
                last_seen = tokio::time::Instant::now();
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let request = match Request::parse(&text) {
                            Ok(request) => request,
                            Err((request_id, code)) => {
                                if !send(&mut socket, &Event::Error { code: code.into(), request_id }).await { break; }
                                continue;
                            }
                        };
                        let mut hub = state.hub.lock().unwrap();
                        hub.request(connection, request);
                    }
                    Some(Ok(Message::Ping(bytes))) => { if !send_frame(&mut socket, Message::Pong(bytes)).await { break; } }
                    Some(Ok(Message::Pong(_))) => {},
                    _ => break,
                }
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() >= Duration::from_secs(20) { break; }
                if !send_frame(&mut socket, Message::Ping(Vec::new().into())).await { break; }
            }
        }
    }
    {
        let mut hub = state.hub.lock().unwrap();
        hub.clients.remove(&connection);
        let effects = hub.authority.disconnect(connection, now());
        hub.apply(effects);
    }
    send_frame(&mut socket, Message::Close(None)).await;
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tokio::main]
async fn main() {
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
    let database = if directory == ":memory:" {
        PathBuf::from(":memory:")
    } else {
        let directory = PathBuf::from(directory);
        std::fs::create_dir_all(&directory).expect("channel data directory");
        directory.join("channel.sqlite")
    };
    let mut limits = storage::Limits::default();
    if let Ok(value) = std::env::var("PIIK_CHANNEL_FILE_LIMIT") {
        limits.max_file_bytes = value
            .parse()
            .expect("PIIK_CHANNEL_FILE_LIMIT must be bytes");
    }
    if let Ok(value) = std::env::var("PIIK_CHANNEL_ATTACHMENT_BUDGET") {
        limits.total_bytes = value
            .parse()
            .expect("PIIK_CHANNEL_ATTACHMENT_BUDGET must be bytes");
    }
    let mut storage = storage::Storage::open(&database, limits).expect("open channel storage");
    let mut authority =
        Authority::new(owner, invite, ice_servers).expect("valid channel admission keys");
    if let Some(checkpoint) = storage.load().expect("read channel checkpoint") {
        authority
            .import_state(serde_json::from_value(checkpoint).expect("valid channel checkpoint"))
            .expect("restore channel authority");
    }
    storage
        .save(
            &serde_json::to_value(authority.export_state()).expect("typed durable state"),
            &authority.referenced_attachments(),
            now(),
        )
        .expect("initialize channel checkpoint");
    let storage = Arc::new(Mutex::new(storage));
    let state = AppState {
        hub: Arc::new(Mutex::new(Hub {
            authority,
            clients: BTreeMap::new(),
            storage: storage.clone(),
        })),
        sockets: Arc::new(Semaphore::new(40)),
        origin: origin.clone(),
        storage,
        transfers: Arc::new(Semaphore::new(2)),
    };
    let timer_state = state.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        loop {
            timer.tick().await;
            timer_state.hub.lock().unwrap().expire();
        }
    });
    let app = Router::new()
        .route("/healthz", get(|| async { "piik-channel-prototype" }))
        .route("/prototype/channel", get(upgrade))
        .route("/prototype/channel/limits", get(attachments::limits))
        .route(
            "/prototype/channel/rooms/{room}/attachments",
            post(attachments::upload),
        )
        .route(
            "/prototype/channel/attachments/{id}",
            get(attachments::metadata).delete(attachments::delete),
        )
        .route(
            "/prototype/channel/attachments/{id}/content",
            get(attachments::download),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .expect("prototype listener");
    println!("Piik Rust channel prototype: http://127.0.0.1:{port}");
    println!(
        "Web interface: {origin}/__channel-preview (use your configured owner or invitation key)"
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
