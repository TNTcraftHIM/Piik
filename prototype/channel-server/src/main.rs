mod channel;
mod identity;
mod routes;
mod wire;

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
use channel::Channel;
use identity::Admission;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch, Semaphore};
use uuid::Uuid;
use wire::{Command, Event, Request};

struct Client {
    connection: Uuid,
    events: mpsc::Sender<Event>,
    close: watch::Sender<bool>,
}
struct Hub {
    channel: Channel,
    clients: BTreeMap<Uuid, Client>,
}

impl Hub {
    fn send(&self, endpoint: Uuid, event: Event) {
        if let Some(client) = self.clients.get(&endpoint) {
            if client.events.try_send(event).is_err() {
                let _ = client.close.send(true);
            }
        }
    }

    fn broadcast(&self, except: Option<Uuid>) {
        for endpoint in self
            .clients
            .keys()
            .filter(|endpoint| Some(**endpoint) != except)
        {
            self.send(
                *endpoint,
                Event::State {
                    state: self.channel.snapshot(*endpoint),
                },
            );
        }
    }

    fn disconnect(&mut self, endpoint: Uuid, connection: Uuid) {
        if !self.channel.identity.current(endpoint, connection) {
            return;
        }
        self.clients.remove(&endpoint);
        self.channel
            .identity
            .disconnect(endpoint, connection, now());
        self.broadcast(None);
    }

    fn expire(&mut self) {
        let expired = self.channel.identity.expired(now());
        if expired.is_empty() {
            return;
        }
        for endpoint in expired {
            self.clients.remove(&endpoint);
            self.channel.remove_session(endpoint);
        }
        self.broadcast(None);
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
        .max_message_size(256 * 1024)
        .max_frame_size(256 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, state).await;
        })
}

async fn send(socket: &mut WebSocket, event: &Event) -> bool {
    let text = serde_json::to_string(event).expect("typed channel event");
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(text.into()))
        )
        .await,
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
    let Command::Join {
        name,
        credential,
        key,
        session_id,
    } = request.command
    else {
        send(
            &mut socket,
            &Event::Error {
                code: "join_required".into(),
                request_id: request.request_id,
            },
        )
        .await;
        return;
    };
    let connection = Uuid::new_v4();
    let join_request_id = request.request_id.clone();
    let (events, mut queue) = mpsc::channel(64);
    let (close, mut closing) = watch::channel(false);
    let admitted = {
        let mut hub = state.hub.lock().unwrap();
        hub.expire();
        hub.channel
            .join(
                Admission {
                    name: &name,
                    credential: credential.as_deref(),
                    key: key.as_deref(),
                    resume: session_id.as_deref(),
                },
                connection,
                now(),
            )
            .map(|admitted| {
                if let Some(old) = hub.clients.insert(
                    admitted.session_id,
                    Client {
                        connection,
                        events,
                        close,
                    },
                ) {
                    let _ = old.close.send(true);
                }
                let owner = hub.channel.identity.users[&admitted.user_id].owner;
                hub.send(
                    admitted.session_id,
                    Event::Welcome {
                        credential: admitted.credential,
                        session_id: admitted.session_id,
                        state: hub.channel.snapshot(admitted.session_id),
                        invite_key: owner.then(|| hub.channel.identity.invite_key.clone()),
                    },
                );
                if let Some(request_id) = request.request_id {
                    hub.send(admitted.session_id, Event::Ack { request_id });
                }
                hub.broadcast(Some(admitted.session_id));
                admitted.session_id
            })
    };
    let endpoint = match admitted {
        Ok(endpoint) => endpoint,
        Err(code) => {
            send(
                &mut socket,
                &Event::Error {
                    code: code.into(),
                    request_id: join_request_id,
                },
            )
            .await;
            return;
        }
    };
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let mut last_seen = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _ = closing.changed() => break,
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
                        let leave = {
                            let mut hub = state.hub.lock().unwrap();
                            if !hub.channel.identity.current(endpoint, connection) { break; }
                            match hub.channel.handle(endpoint, request.command, now()) {
                                Ok(outcome) => {
                                    for (recipient, event) in outcome.events { hub.send(recipient, event); }
                                    if outcome.broadcast { hub.broadcast(None); }
                                    if let Some(request_id) = request.request_id { hub.send(endpoint, Event::Ack { request_id }); }
                                    outcome.leave
                                }
                                Err(code) => { hub.send(endpoint, Event::Error { code: code.into(), request_id: request.request_id }); false }
                            }
                        };
                        if leave {
                            // Finish the explicit leave acknowledgement before retiring the socket.
                            while let Ok(event) = queue.try_recv() { if !send(&mut socket, &event).await { break; } }
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => { if socket.send(Message::Pong(bytes)).await.is_err() { break; } }
                    Some(Ok(Message::Pong(_))) => {},
                    _ => break,
                }
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() >= Duration::from_secs(20) { break; }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
        }
    }
    {
        let mut hub = state.hub.lock().unwrap();
        if !hub.channel.identity.sessions.contains_key(&endpoint) {
            if hub
                .clients
                .get(&endpoint)
                .is_some_and(|client| client.connection == connection)
            {
                hub.clients.remove(&endpoint);
            }
        } else {
            hub.disconnect(endpoint, connection);
        }
    }
    let _ = socket.send(Message::Close(None)).await;
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
    let owner =
        std::env::var("PIIK_CHANNEL_OWNER_KEY").unwrap_or_else(|_| Uuid::new_v4().to_string());
    let invite =
        std::env::var("PIIK_CHANNEL_INVITE_KEY").unwrap_or_else(|_| Uuid::new_v4().to_string());
    assert!(
        wire::valid_id(&owner) && wire::valid_id(&invite) && owner != invite,
        "Owner and invite keys must be different nonempty values up to 128 bytes"
    );
    let ice_servers = std::env::var("PIIK_CHANNEL_ICE_SERVERS")
        .map(|value| {
            serde_json::from_str::<Vec<serde_json::Value>>(&value)
                .expect("PIIK_CHANNEL_ICE_SERVERS must be a JSON array")
        })
        .unwrap_or_default();
    let state = AppState {
        hub: Arc::new(Mutex::new(Hub {
            channel: Channel::new(owner.clone(), invite.clone(), ice_servers),
            clients: BTreeMap::new(),
        })),
        sockets: Arc::new(Semaphore::new(40)),
        origin: origin.clone(),
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
        .with_state(state);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .expect("prototype listener");
    println!("Piik Rust channel prototype: http://127.0.0.1:{port}");
    println!("Owner: {origin}/__channel-preview#owner={owner}");
    println!("Invite: {origin}/__channel-preview#invite={invite}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
