use futures_util::{SinkExt, StreamExt};
use piik_channel_core::{
    wire::{Command, Event, Request},
    Authority, Effects, StoredRoomHost,
};
use piik_channel_native::session::{run, Config, RoomFile};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};
use uuid::Uuid;

// The socket boundary delivers production Authority effects without mirroring
// room permissions, persistence, sequence allocation or routing in the fixture.
struct Domain {
    authority: Authority,
    socket: WebSocketStream<TcpStream>,
    connection: Uuid,
    events: Vec<(Uuid, Event)>,
    now: u64,
}
impl Domain {
    async fn accept(listener: &TcpListener) -> Self {
        let (stream, _) = listener.accept().await.unwrap();
        Self {
            authority: Authority::new(
                "owner".into(),
                "invite".into(),
                vec![json!({"urls":"stun:127.0.0.1:9"})],
            )
            .unwrap(),
            socket: accept_async(stream).await.unwrap(),
            connection: Uuid::new_v4(),
            events: Vec::new(),
            now: 100,
        }
    }
    async fn apply(&mut self, effects: Effects) {
        for (connection, event) in effects.events {
            if connection == self.connection {
                self.socket
                    .send(Message::Text(serde_json::to_string(&event).unwrap().into()))
                    .await
                    .unwrap();
            }
            self.events.push((connection, event));
        }
        if effects.close.contains(&self.connection) {
            self.socket.close(None).await.unwrap();
        }
    }
    async fn command(&mut self, connection: Uuid, command: Value) {
        let effects = self.authority.handle(
            connection,
            Request::parse(&command.to_string()).unwrap(),
            self.now,
        );
        self.apply(effects).await;
    }
    async fn step(&mut self) -> Option<String> {
        let message = self.socket.next().await.unwrap().unwrap();
        if let Message::Text(text) = message {
            let request = Request::parse(&text).unwrap();
            let room = match &request.command {
                Command::HostOutput { room_id, .. } => Some(room_id.clone()),
                _ => None,
            };
            let effects = self.authority.handle(self.connection, request, self.now);
            self.apply(effects).await;
            room
        } else {
            None
        }
    }
    async fn room_turn(&mut self, id: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.step().await.as_deref() != Some(id) {}
        })
        .await
        .unwrap();
    }
    async fn until(&mut self, predicate: impl Fn(Uuid, &Event) -> bool) -> Event {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(index) = self
                    .events
                    .iter()
                    .position(|(connection, event)| predicate(*connection, event))
                {
                    return self.events.remove(index).1;
                }
                self.step().await;
            }
        })
        .await
        .expect("native endpoint did not complete its real room turn")
    }
    async fn bound(&mut self, id: &str) -> Uuid {
        match self
            .until(|_, event| matches!(event, Event::HostBound { room_id, .. } if room_id == id))
            .await
        {
            Event::HostBound { binding_id, .. } => binding_id,
            _ => unreachable!(),
        }
    }
}

#[tokio::test]
async fn rejected_identity_never_creates_room_storage() {
    let folder = std::env::temp_dir().join(format!("piik-native-rejected-{}", Uuid::new_v4()));
    std::fs::create_dir(&folder).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let native = tokio::spawn(run(
        Config {
            url: format!("ws://{}/prototype/channel", listener.local_addr().unwrap()),
            origin: "http://localhost".into(),
            name: "Rejected".into(),
            key: Some("not-an-invite".into()),
            credential: None,
        },
        vec![RoomFile {
            path: folder.join("one.sqlite"),
            id: "one".into(),
            name: "one".into(),
        }],
        std::future::pending(),
    ));
    let mut domain = Domain::accept(&listener).await;
    domain
        .until(|_, event| matches!(event, Event::Error { .. }))
        .await;
    let result = tokio::time::timeout(Duration::from_secs(5), native)
        .await
        .unwrap()
        .unwrap();
    assert!(result
        .unwrap_err()
        .to_string()
        .starts_with("admission failed:"));
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);
    std::fs::remove_dir(folder).unwrap();
}

fn start(
    url: String,
    folder: PathBuf,
) -> (
    oneshot::Sender<()>,
    tokio::task::JoinHandle<anyhow::Result<()>>,
) {
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        let result = run(
            Config {
                url,
                origin: "http://localhost".into(),
                name: "Native".into(),
                key: Some("owner".into()),
                credential: None,
            },
            ["one", "two"]
                .into_iter()
                .map(|id| RoomFile {
                    path: folder.join(format!("{id}.sqlite")),
                    id: id.into(),
                    name: id.into(),
                })
                .collect(),
            async {
                let _ = stopped.await;
            },
        )
        .await;
        if let Err(error) = &result {
            eprintln!("Native session failed: {error}");
        }
        result
    });
    (stop, task)
}

#[tokio::test]
async fn real_session_resumes_bindings_and_restarts_from_committed_room_files() {
    let folder = std::env::temp_dir().join(format!("piik-native-{}", Uuid::new_v4()));
    std::fs::create_dir(&folder).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/prototype/channel", listener.local_addr().unwrap());
    let (stop, native) = start(url.clone(), folder.clone());
    let mut domain = Domain::accept(&listener).await;
    let initial = match domain
        .until(|_, event| matches!(event, Event::Welcome { .. }))
        .await
    {
        Event::Welcome { session_id, .. } => session_id,
        _ => unreachable!(),
    };
    let binding = domain.bound("one").await;
    domain.bound("two").await;
    // An admitted observer receives the paused directory after the host leaves.
    let guest = Uuid::new_v4();
    let signer = piik_channel_core::conversation::SessionSigner::from_seed([9; 32]);
    domain.command(guest, json!({
        "type": "join", "name": "Observer", "key": "invite", "signingKey": signer.signing_key()
    })).await;
    domain
        .command(
            domain.connection,
            json!({"type":"browse","roomId":"one","active":true}),
        )
        .await;
    domain.until(|_, event| matches!(event, Event::State { state } if state.channel.rooms.iter().any(|room| room.id == "one" && room.reading))).await;

    domain
        .command(
            domain.connection,
            json!({"type":"set_name", "name":"Owner renamed"}),
        )
        .await;
    domain.until(|_, event| matches!(event, Event::State { state } if state.users.iter().any(|user| user.name == "Owner renamed"))).await;

    // A real socket loss resumes the same admitted session and live RoomHost.
    domain.events.clear();
    domain.socket.close(None).await.unwrap();
    let effects = domain.authority.disconnect(domain.connection, domain.now);
    domain.events.extend(effects.events);
    // A second real process cannot steal the database during the first process's
    // recovery window, even though the domain could admit its new endpoint.
    let contender_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let contender = std::process::Command::new(env!("CARGO_BIN_EXE_piik-channel-native"))
        .args([
            "--room",
            folder.join("one.sqlite").to_str().unwrap(),
            "one",
            "stolen",
        ])
        .env(
            "CHANNEL_WS_URL",
            format!(
                "ws://{}/prototype/channel",
                contender_listener.local_addr().unwrap()
            ),
        )
        .env("CHANNEL_UI_ORIGIN", "http://localhost")
        .env("PIIK_CHANNEL_NATIVE_KEY", "owner")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut contender_domain = Domain::accept(&contender_listener).await;
    contender_domain.authority = domain.authority.clone();
    contender_domain
        .until(
            |_, event| matches!(event, Event::Ack { request_id } if request_id == "native-leave"),
        )
        .await;
    let output = contender.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("room_storage_in_use"));
    assert_eq!(
        StoredRoomHost::open(&folder.join("one.sqlite"))
            .unwrap()
            .policy()
            .name,
        "one"
    );
    let (stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    domain.socket = accept_async(stream).await.unwrap();
    domain.connection = Uuid::new_v4();
    domain.now += 1_000;
    let resumed = domain
        .until(|_, event| matches!(event, Event::Welcome { .. }))
        .await;
    assert!(matches!(resumed, Event::Welcome { session_id, .. } if session_id == initial));
    assert!(
        matches!(resumed, Event::Welcome { state, .. } if state.users.iter().any(|user| user.name == "Owner renamed"))
    );
    assert_eq!(domain.bound("one").await, binding);
    domain.bound("two").await;
    domain.room_turn("one").await;
    domain.room_turn("two").await;
    domain.until(|_, event| matches!(event, Event::State { state } if state.channel.rooms.iter().any(|room| room.id == "one" && room.reading))).await;

    // Explicit session end retires its room activities immediately.
    stop.send(()).unwrap();
    domain.events.clear();
    domain.until(|_, event| matches!(event, Event::State { state } if state.channel.rooms.iter().any(|room| room.id == "one" && !room.available && !room.reading))).await;
    tokio::time::timeout(Duration::from_secs(5), native)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    let (stop, native) = start(url, folder.clone());
    let (stream, _) = listener.accept().await.unwrap();
    domain.socket = accept_async(stream).await.unwrap();
    domain.connection = Uuid::new_v4();
    domain.events.clear();
    let reopened = domain
        .until(|_, event| matches!(event, Event::Welcome { .. }))
        .await;
    assert!(matches!(reopened, Event::Welcome { session_id, .. } if session_id != initial));
    assert_ne!(domain.bound("one").await, binding);
    domain.bound("two").await;
    domain.until(|_, event| matches!(event, Event::State { state } if state.channel.rooms.iter().any(|room| room.id == "one" && room.available && !room.reading))).await;
    for id in ["one", "two"] {
        assert_eq!(
            StoredRoomHost::open(&folder.join(format!("{id}.sqlite")))
                .unwrap()
                .policy()
                .id,
            id
        );
    }
    stop.send(()).unwrap();
    domain.events.clear();
    domain.until(|_, event| matches!(event, Event::State { state } if state.channel.rooms.iter().any(|room| room.id == "one" && !room.available))).await;
    tokio::time::timeout(Duration::from_secs(5), native)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    std::fs::remove_dir_all(folder).unwrap();
}
