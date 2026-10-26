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
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, Semaphore};
use uuid::Uuid;

const CHANNELS: [&str; 3] = ["living", "studio", "quiet"];
const HISTORY_LIMIT: usize = 100;

#[derive(Clone)]
struct AppState {
    conversation: Arc<Mutex<Conversation>>,
    connections: Arc<Semaphore>,
}

struct Conversation {
    history: HashMap<String, VecDeque<ChatMessage>>,
    events: broadcast::Sender<Event>,
}

#[derive(Clone, Serialize)]
struct ChatMessage {
    id: Uuid,
    sender: Uuid,
    text: String,
    time: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event {
    Welcome {
        identity: Uuid,
        history: HashMap<String, VecDeque<ChatMessage>>,
    },
    Message {
        channel: String,
        message: ChatMessage,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendMessage {
    channel: String,
    text: String,
}

impl Conversation {
    fn new() -> Self {
        Self {
            history: CHANNELS
                .into_iter()
                .map(|id| (id.to_owned(), VecDeque::new()))
                .collect(),
            events: broadcast::channel(128).0,
        }
    }

    fn send(&mut self, sender: Uuid, input: SendMessage) -> Result<(), &'static str> {
        let text = input.text.trim();
        if text.is_empty() || text.chars().count() > 2000 {
            return Err("invalid message length");
        }
        let history = self
            .history
            .get_mut(&input.channel)
            .ok_or("unknown channel")?;
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let message = ChatMessage {
            id: Uuid::new_v4(),
            sender,
            text: text.to_owned(),
            time: format!("{:02}:{:02} UTC", seconds / 3600 % 24, seconds / 60 % 60),
        };
        history.push_back(message.clone());
        if history.len() > HISTORY_LIMIT {
            history.pop_front();
        }
        let _ = self.events.send(Event::Message {
            channel: input.channel,
            message,
        });
        Ok(())
    }
}

async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // This isolated prototype has no production identity/admission integration.
    // Keep it loopback-only and accept only its local development UI origin.
    if headers.get("origin").and_then(|value| value.to_str().ok()) != Some("http://127.0.0.1:8790")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = state.connections.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ws.max_message_size(16 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, state).await;
        })
}

async fn session(mut socket: WebSocket, state: AppState) {
    let identity = Uuid::new_v4();
    let (welcome, mut events) = {
        let room = state.conversation.lock().unwrap();
        (
            Event::Welcome {
                identity,
                history: room.history.clone(),
            },
            room.events.subscribe(),
        )
    };
    if socket
        .send(Message::Text(
            serde_json::to_string(&welcome).unwrap().into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let Ok(input) = serde_json::from_str::<SendMessage>(&text) else { break; };
                    if state.conversation.lock().unwrap().send(identity, input).is_err() { break; }
                }
                Some(Ok(Message::Ping(bytes))) => {
                    if socket.send(Message::Pong(bytes)).await.is_err() { break; }
                }
                Some(Ok(Message::Pong(_))) => {},
                _ => break,
            },
            event = events.recv() => {
                // A slow consumer reconnects for a coherent bounded snapshot.
                let Ok(event) = event else { break; };
                if socket.send(Message::Text(serde_json::to_string(&event).unwrap().into())).await.is_err() { break; }
            }
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}

#[tokio::main]
async fn main() {
    let state = AppState {
        conversation: Arc::new(Mutex::new(Conversation::new())),
        connections: Arc::new(Semaphore::new(20)),
    };
    let app = Router::new()
        .route("/healthz", get(|| async { "piik-channel-prototype" }))
        .route("/channels", get(upgrade))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8791")
        .await
        .expect("prototype port 8791");
    println!("Piik Rust channel prototype listening on http://127.0.0.1:8791");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_history_is_isolated_bounded_and_server_identified() {
        let mut room = Conversation::new();
        let sender = Uuid::new_v4();
        for index in 0..105 {
            room.send(
                sender,
                SendMessage {
                    channel: "living".into(),
                    text: index.to_string(),
                },
            )
            .unwrap();
        }
        assert_eq!(room.history["living"].len(), 100);
        assert_eq!(room.history["living"][0].text, "5");
        assert_eq!(room.history["living"][0].sender, sender);
        assert!(room.history["studio"].is_empty());
        assert!(room
            .send(
                sender,
                SendMessage {
                    channel: "missing".into(),
                    text: "hello".into()
                }
            )
            .is_err());
        assert!(room
            .send(
                sender,
                SendMessage {
                    channel: "living".into(),
                    text: " ".into()
                }
            )
            .is_err());
        assert!(room
            .send(
                sender,
                SendMessage {
                    channel: "living".into(),
                    text: "a".repeat(2001)
                }
            )
            .is_err());
    }
}
