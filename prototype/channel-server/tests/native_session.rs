use futures_util::{SinkExt, StreamExt};
use piik_channel_core::{
    wire::{Command, Event, Request},
    Authority, Effects, StoredRoomHost,
};
use piik_channel_native::session::{run, Config, RoomFile};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
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
    commands: Vec<Command>,
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
            commands: Vec::new(),
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
            self.commands.push(request.command.clone());
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

async fn app_http(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    origin: Option<&str>,
    body: Option<Value>,
) -> (u16, Value) {
    let mut socket = TcpStream::connect(address).await.unwrap();
    let body = body.map(|value| value.to_string()).unwrap_or_default();
    let origin = origin
        .map(|value| format!("Origin: {value}\r\n"))
        .unwrap_or_default();
    let request = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\n{origin}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    let response = String::from_utf8(response).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
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
            server_udp: None,
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
                server_udp: None,
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

    let image: piik_channel_core::wire::IdentityIcon = serde_json::from_value(json!(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
    )).unwrap();
    domain
        .command(
            domain.connection,
            json!({"type":"update_room", "roomId":"one", "name":"one",
        "icon":image, "access":"public", "hidden":false}),
        )
        .await;
    domain.until(|_, event| matches!(event, Event::State { state } if state.channel.rooms.iter().any(|room| room.id == "one" && room.icon == image))).await;

    // A real socket loss resumes the same admitted session and live RoomHost.
    domain.events.clear();
    domain.socket.close(None).await.unwrap();
    let effects = domain.authority.disconnect(domain.connection, domain.now);
    domain.events.extend(effects.events);
    // A second real process cannot steal the database during the first process's
    // recovery window, even though the domain could admit its new endpoint.
    let contender_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let executable = std::env::var_os("CHANNEL_NATIVE_EXECUTABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../channel-native/target/debug")
                .join(format!(
                    "piik-channel-native{}",
                    std::env::consts::EXE_SUFFIX
                ))
        });
    let contender = std::process::Command::new(executable)
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
    assert_eq!(
        StoredRoomHost::open(&folder.join("one.sqlite"))
            .unwrap()
            .policy()
            .icon,
        image
    );
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

#[tokio::test]
async fn app_host_outlives_its_page_and_restores_rooms_only_after_real_admission() {
    use piik_channel_core::{conversation::SessionSigner, wire::RoomAccess, RoomState};
    use piik_channel_native::hosted_room::HostedRoom;
    use piik_channel_prototype::app;
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

    let folder = std::env::temp_dir().join(format!("piik-app-hosting-{}", Uuid::new_v4()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut authority = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
    let (channel, user) = authority.identity();
    let browser = Uuid::new_v4();
    let admitted = authority.handle(browser, Request::parse(&json!({"type":"join","key":"owner","name":"Owner", "signingKey":SessionSigner::from_seed([1;32]).signing_key()}).to_string()).unwrap(), 100);
    let (credential, browser_session) = admitted
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome {
                credential,
                session_id,
                ..
            } => Some((credential, session_id)),
            _ => None,
        })
        .unwrap();
    let guest = authority.handle(Uuid::new_v4(), Request::parse(&json!({"type":"join","key":"invite","name":"Guest", "signingKey":SessionSigner::from_seed([2;32]).signing_key()}).to_string()).unwrap(), 100);
    let guest_credential = guest
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { credential, .. } => Some(credential),
            _ => None,
        })
        .unwrap();
    let assets = folder.join("web");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(
        assets.join("index.html"),
        "<!doctype html><title>App</title>",
    )
    .unwrap();
    let config = || app::Config {
        data_root: folder.clone(),
        assets: assets.clone(),
        open_browser: false,
        cloudflared: "cloudflared".into(),
        ice_servers: vec![],
    };
    let app_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = app_listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let service = tokio::spawn(app::serve(
        app_listener,
        config(),
        async {
            let _ = stopped.await;
        },
        None,
    ));
    let local_origin = format!("http://{address}");
    let (status, discovery) = app_http(address, "GET", "/connect-discovery", None, None).await;
    assert_eq!(status, 200);
    assert_eq!(discovery["service"], "piik-channel-app");
    assert!(
        discovery.get("token").is_none(),
        "discovery grants no authority"
    );
    assert_eq!(
        app_http(address, "GET", "/health", Some(&origin), None)
            .await
            .0,
        403
    );
    assert_eq!(
        app_http(
            address,
            "POST",
            "/api/client-launcher/site",
            Some(&origin),
            Some(json!({"site":origin,"allowed":true}))
        )
        .await
        .0,
        403,
        "a remote site cannot approve itself"
    );
    assert_eq!(
        app_http(
            address,
            "POST",
            "/api/client-launcher/site",
            Some(&local_origin),
            Some(json!({"site":origin,"allowed":true}))
        )
        .await
        .0,
        200
    );
    let (status, health) = app_http(address, "GET", "/health", Some(&origin), None).await;
    assert_eq!(status, 200);
    let token = health["token"].as_str().unwrap();
    let upgrade = |address, token: &str| {
        let mut request = format!("ws://{address}/rooms")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
        request.headers_mut().insert(
            "sec-websocket-protocol",
            format!("piik-channel-rooms.{token}").parse().unwrap(),
        );
        request
    };
    let mut unapproved = upgrade(address, token);
    unapproved
        .headers_mut()
        .insert("Origin", "https://unapproved.example".parse().unwrap());
    assert!(
        matches!(connect_async(unapproved).await,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == 403),
        "a valid instance token does not authorize another Origin"
    );
    let (mut page, _) = connect_async(upgrade(address, token)).await.unwrap();
    let hello = |credential: &str| json!({"id":"hello","type":"hello","channelId":channel,"userId":user,"credential":credential,"name":"Owner"});
    page.send(Message::Text(hello(&guest_credential).to_string().into()))
        .await
        .unwrap();
    let mut domain = Domain::accept(&listener).await;
    domain.authority = authority;
    domain
        .until(|_, event| matches!(event, Event::Ack {request_id} if request_id == "native-leave"))
        .await;
    let rejected: Value =
        serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(rejected["error"], "owner_mismatch");
    assert!(
        !folder.join("rooms").exists(),
        "approval and public IDs cannot open room data before the claimed user's actual admission"
    );

    page.send(Message::Text(hello(&credential).to_string().into()))
        .await
        .unwrap();
    let (stream, _) = listener.accept().await.unwrap();
    domain.socket = accept_async(stream).await.unwrap();
    domain.connection = Uuid::new_v4();
    domain.events.clear();
    let welcome = domain
        .until(|_, event| matches!(event, Event::Welcome { .. }))
        .await;
    let Event::Welcome {
        session_id: native, ..
    } = welcome
    else {
        unreachable!()
    };
    assert_ne!(native, browser_session);
    let ready: Value =
        serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(ready.get("result").is_some());
    let room = Uuid::new_v4().to_string();
    let policy = RoomState::new(
        room.clone(),
        "Saved private".into(),
        Default::default(),
        user,
        RoomAccess::Private,
        true,
        Some("room-secret".into()),
    )
    .unwrap();
    let policy = serde_json::to_string(&policy).unwrap();
    let open = json!({"id":"open","type":"open","policy":policy});
    page.send(Message::Text(open.to_string().into()))
        .await
        .unwrap();
    let binding = domain.bound(&room).await;
    let opened: Value =
        serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(opened["result"]["name"], "Saved private");
    assert_eq!(opened["result"]["access"], "private");
    assert_eq!(opened["result"]["hasPassword"], true);
    let sites: Vec<_> = std::fs::read_dir(folder.join("rooms"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(sites.len(), 1);
    Uuid::parse_str(sites[0].file_name().unwrap().to_str().unwrap()).unwrap();
    let room_directory = sites[0].join(channel.to_string()).join(user.to_string());
    for (suffix, method) in [("hosting", "GET"), ("backup", "PUT")] {
        for allowed in [true, false] {
            let site = if allowed {
                origin.clone()
            } else {
                "https://unapproved.example".into()
            };
            let url = format!("http://{address}/rooms/{channel}/{user}/{suffix}");
            let (status, headers) = tokio::task::spawn_blocking(move || {
                let agent = ureq::Agent::config_builder()
                    .http_status_as_error(false)
                    .timeout_global(Some(Duration::from_secs(5)))
                    .build()
                    .new_agent();
                let request = ureq::http::Request::builder()
                    .method("OPTIONS")
                    .uri(url)
                    .header("Origin", site)
                    .header("Access-Control-Request-Method", method)
                    .header(
                        "Access-Control-Request-Headers",
                        "authorization,content-type,x-piik-credential",
                    )
                    .body(Vec::<u8>::new())
                    .unwrap();
                let response = agent.run(request).unwrap();
                (response.status().as_u16(), response.headers().clone())
            })
            .await
            .unwrap();
            assert_eq!(status, if allowed { 204 } else { 403 });
            if allowed {
                assert_eq!(headers["access-control-allow-origin"], origin);
                assert!(headers["access-control-allow-methods"]
                    .to_str()
                    .unwrap()
                    .contains(method));
                let names = headers["access-control-allow-headers"]
                    .to_str()
                    .unwrap()
                    .to_ascii_lowercase();
                for name in ["authorization", "content-type", "x-piik-credential"] {
                    assert!(names.contains(name));
                }
            } else {
                assert!(!headers.contains_key("access-control-allow-origin"));
            }
        }
    }
    for (request_origin, current_credential, expected) in [
        (origin.clone(), credential.clone(), 200),
        (origin.clone(), guest_credential.clone(), 403),
        ("https://unapproved.example".into(), credential.clone(), 403),
    ] {
        let token = token.to_owned();
        let url = format!("http://{address}/rooms/{channel}/{user}/{room}/backup");
        let description_url = format!("http://{address}/rooms/{channel}/{user}/hosting");
        let (status, bytes, description) = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let agent = ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(5)))
                .build()
                .new_agent();
            let mut response = agent
                .get(url)
                .header("Origin", &request_origin)
                .header("Authorization", format!("Bearer {token}"))
                .header("X-Piik-Credential", &current_credential)
                .call()
                .unwrap();
            let status = response.status().as_u16();
            let mut bytes = vec![];
            response
                .body_mut()
                .as_reader()
                .read_to_end(&mut bytes)
                .unwrap();
            let description: Option<Value> = if status == 200 {
                let mut response = agent
                    .get(description_url)
                    .header("Origin", request_origin)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("X-Piik-Credential", current_credential)
                    .call()
                    .unwrap();
                assert_eq!(response.status().as_u16(), 200);
                Some(serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap())
            } else {
                None
            };
            (status, bytes, description)
        })
        .await
        .unwrap();
        assert_eq!(status, expected);
        if status == 200 {
            let description = description.unwrap();
            assert_eq!(description["sessionId"], native.to_string());
            assert_eq!(description["roomIds"], json!([room]));
            let directory = tempfile::tempdir().unwrap();
            let piik_channel_native::backup::StagedBackup::Room { snapshot, .. } =
                piik_channel_native::backup::stage(std::io::Cursor::new(bytes), directory.path())
                    .unwrap()
            else {
                panic!("room backup");
            };
            assert_eq!(snapshot.metadata().policy.id, room);
            assert_eq!(
                snapshot
                    .metadata()
                    .own_credential
                    .as_ref()
                    .unwrap()
                    .credential,
                credential
            );
        }
    }
    let duplicate = TcpListener::bind("127.0.0.1:0").await.unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_secs(5),
            app::serve(duplicate, config(), std::future::pending(), None)
        )
        .await
        .unwrap()
        .is_err(),
        "a second App cannot own the same approval data directory"
    );
    domain.room_turn(&room).await;
    // Stopping an already-ended or foreign page's ID only consults this socket's
    // lease map, so an absent lease is an idempotent no-op.
    page.send(Message::Text(
        json!({"id":"stopped-capture","type":"stop_capture","publicationId":Uuid::new_v4()})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let stopped: Value =
        serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(stopped, json!({"id":"stopped-capture","result":null}));
    #[cfg(all(feature = "capture", target_os = "windows"))]
    {
        let target = json!({"kind":"window","sourceId":"0","title":"Unopened test target","pid":0});
        let settings = json!({"width":1280,"height":720,"fps":24,"bitrate":2_000_000});
        page.send(Message::Text(
            json!({"id":"missing-capture-room","type":"prepare_capture","publicationId":Uuid::new_v4(),
                "roomId":"missing-capture-room","target":target,"settings":settings}).to_string().into(),
        )).await.unwrap();
        let denied: Value =
            serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap())
                .unwrap();
        assert_eq!(denied["error"], "room_unavailable");

        let publication = Uuid::new_v4();
        page.send(Message::Text(
            json!({"id":"failed-prepare","type":"prepare_capture",
            "publicationId":publication,"roomId":room,"target":target,"settings":settings})
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let failed: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(10), page.next())
                .await
                .expect("invalid capture preparation finishes without publishing")
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap(),
        )
        .unwrap();
        assert!(failed.get("error").is_some());
        let _ = tokio::time::timeout(Duration::from_millis(50), async {
            loop {
                domain.step().await;
            }
        })
        .await;
        assert!(
            !domain.commands.iter().any(|command| matches!(command,
            Command::Publish { publication: p } if p.id == publication)),
            "preparation never changes room publications"
        );

        for (name, command) in [
            (
                "cancel-candidate",
                json!({"type":"cancel_capture","publicationId":publication}),
            ),
            (
                "commit-missing",
                json!({"type":"commit_capture","publicationId":publication,"captureId":Uuid::new_v4()}),
            ),
            (
                "transfer-foreign",
                json!({"type":"transfer_source","publicationId":publication,"captureId":Uuid::new_v4(),"toSessionId":Uuid::new_v4()}),
            ),
        ] {
            let mut command = command;
            command["id"] = json!(name);
            page.send(Message::Text(command.to_string().into()))
                .await
                .unwrap();
            let reply: Value =
                serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            if name == "cancel-candidate" {
                assert_eq!(reply["result"], Value::Null);
            } else {
                assert_eq!(reply["error"], "capture_unavailable");
            }
        }
        assert!(
            HostedRoom::open(&room_directory.join(format!("{room}.sqlite")), &room, user).is_err(),
            "failed or cancelled capture retains the existing Native room runtime lock"
        );
    }
    let mut wrong_policy: Value = serde_json::from_str(&policy).unwrap();
    wrong_policy["creatorId"] = json!(Uuid::new_v4());
    page.send(Message::Text(
        json!({"id":"wrong-owner","type":"open","policy":wrong_policy.to_string()})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let refused: Value =
        serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(refused["error"], "owner_mismatch");
    for index in 0..31 {
        domain
            .command(
                browser,
                json!({"type":"host_register","room":{
                    "id":format!("reserved-{index}"),"name":format!("Reserved {index}"),"icon":"couch",
                    "creatorId":user,"access":"public","hidden":false,"hasPassword":false,
                }}),
            )
            .await;
    }
    let refused_room = Uuid::new_v4().to_string();
    let refused_policy = RoomState::new(
        refused_room.clone(),
        "Retained refused room".into(),
        Default::default(),
        user,
        RoomAccess::Public,
        false,
        None,
    )
    .unwrap();
    page.send(Message::Text(json!({"id":"room-limit","type":"open","policy":serde_json::to_string(&refused_policy).unwrap()}).to_string().into())).await.unwrap();
    let native_connection = domain.connection;
    domain
        .until(|connection, event| {
            connection == native_connection
                && matches!(event, Event::Error {code,request_id:Some(_)} if code == "room_limit")
        })
        .await;
    let refused: Value =
        serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(refused["error"], "room_limit");
    let refused_path = room_directory.join(format!("{refused_room}.sqlite"));
    assert!(
        refused_path.exists(),
        "registration refusal preserves already committed data"
    );
    drop(HostedRoom::open(&refused_path, &refused_room, user).unwrap());
    let path = room_directory.join(format!("{room}.sqlite"));
    page.close(None).await.unwrap();
    while page.next().await.is_some() {}
    assert!(
        HostedRoom::open(&path, &room, user).is_err(),
        "the Native host retains the actual SQLite runtime lock after page close"
    );
    domain.command(browser, json!({"type":"leave"})).await;
    domain.room_turn(&room).await;
    domain.until(|_, event| matches!(event, Event::State {state} if state.channel.rooms.iter().any(|value| value.id == room && value.available))).await;

    // Reopening the control page uses the already admitted host and binding.
    let (mut page, _) = connect_async(upgrade(address, token)).await.unwrap();
    page.send(Message::Text(hello(&credential).to_string().into()))
        .await
        .unwrap();
    let _: Value =
        serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    page.send(Message::Text(open.to_string().into()))
        .await
        .unwrap();
    let reopened: Value =
        serde_json::from_str(&page.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(reopened["result"], opened["result"]);
    assert!(HostedRoom::open(&path, &room, user).is_err());
    stop.send(()).unwrap();
    domain
        .until(|_, event| matches!(event, Event::Ack {request_id} if request_id == "native-leave"))
        .await;
    tokio::time::timeout(Duration::from_secs(5), service)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(HostedRoom::open(&path, &room, user).unwrap());

    // A new process/session restores the same committed policy without activities.
    let app_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = app_listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let service = tokio::spawn(app::serve(
        app_listener,
        config(),
        async {
            let _ = stopped.await;
        },
        None,
    ));
    let (status, health) = app_http(address, "GET", "/health", Some(&origin), None).await;
    assert_eq!(
        status, 200,
        "the site's local approval survives App restart"
    );
    let (mut page, _) = connect_async(upgrade(address, health["token"].as_str().unwrap()))
        .await
        .unwrap();
    page.send(Message::Text(hello(&credential).to_string().into()))
        .await
        .unwrap();
    let (stream, _) = listener.accept().await.unwrap();
    domain.socket = accept_async(stream).await.unwrap();
    domain.connection = Uuid::new_v4();
    domain.events.clear();
    domain.until(|_, event| matches!(event, Event::Error {code,request_id:Some(id)} if code == "room_limit" && id == &refused_room)).await;
    let next_binding = domain.bound(&room).await;
    assert_ne!(next_binding, binding);
    let ready: Value = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tokio::select! {
                message = page.next() => break serde_json::from_str(&message.unwrap().unwrap().into_text().unwrap()).unwrap(),
                _ = domain.step() => {},
            }
        }
    }).await.unwrap();
    assert!(ready.get("result").is_some());
    domain.until(|_, event| matches!(event, Event::State {state} if state.channel.rooms.iter().any(|value| value.id == room && value.available) && state.voice.is_empty() && state.publications.is_empty())).await;
    drop(HostedRoom::open(&refused_path, &refused_room, user).unwrap());
    assert!(
        HostedRoom::open(&path, &room, user).is_err(),
        "a refused restore must not release another room's runtime"
    );
    let saved = StoredRoomHost::open(&path).unwrap();
    assert!(saved.policy().hidden);
    saved
        .policy()
        .clone()
        .enter(Uuid::new_v4(), false, Some("room-secret"), None)
        .unwrap();
    drop(saved);
    stop.send(()).unwrap();
    domain
        .until(|_, event| matches!(event, Event::Ack {request_id} if request_id == "native-leave"))
        .await;
    tokio::time::timeout(Duration::from_secs(5), service)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    std::fs::remove_dir_all(folder).unwrap();
}

#[tokio::test]
async fn app_launch_retries_owns_one_domain_and_restores_it_after_port_change() {
    use piik_channel_core::conversation::SessionSigner;
    use piik_channel_core::{backup::DomainMetadata, storage::Storage};
    use piik_channel_prototype::{app, web};
    use rtc_stun::{
        fingerprint::FINGERPRINT,
        message::{
            Getter, Message as StunMessage, TransactionId, BINDING_REQUEST, BINDING_SUCCESS,
        },
        xoraddr::XorMappedAddress,
    };
    use tokio::net::UdpSocket;
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

    let folder = std::env::temp_dir().join(format!("piik-app-launch-{}", Uuid::new_v4()));
    let assets = folder.join("web");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(
        assets.join("index.html"),
        "<!doctype html><title>App</title>",
    )
    .unwrap();
    let config = || app::Config {
        data_root: folder.clone(),
        assets: assets.clone(),
        open_browser: false,
        cloudflared: folder.join("missing-cloudflared"),
        ice_servers: vec![json!({"urls": ["stun:public-discovery.invalid:3478"]})],
    };
    let saved_identity = || -> Value {
        let db = rusqlite::Connection::open(folder.join("app.sqlite")).unwrap();
        let saved: String = db
            .query_row(
                "SELECT value FROM app_setting WHERE key='domain'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&saved).unwrap()
    };
    let lan = web::lan_addresses().unwrap().into_iter().next();
    let mut first = None;
    let mut retired_listeners = Vec::new();
    let mut retired_stun = Vec::new();
    for attempt in 0..2 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let local = format!("http://{address}");
        let (stop, stopped) = oneshot::channel();
        let service = tokio::spawn(app::serve(
            listener,
            config(),
            async {
                let _ = stopped.await;
            },
            None,
        ));
        if attempt == 0 {
            let (status, failure) = app_http(
                address,
                "POST",
                "/api/client-launcher/launch",
                Some(&local),
                Some(json!({"mode":"local","lanAddress":"not-an-interface"})),
            )
            .await;
            assert_eq!(status, 503);
            assert_eq!(failure["reason"], "local-network");
            let (status, failure) = app_http(
                address,
                "POST",
                "/api/client-launcher/launch",
                Some(&local),
                Some(json!({"mode":"link"})),
            )
            .await;
            assert_eq!(status, 503);
            assert_eq!(
                failure["reason"], "tunnel-unavailable",
                "the failed Local attempt must be retired before a different retry"
            );
        }
        let Some(lan) = &lan else {
            // A machine without an eligible adapter cannot offer Local mode.
            // The failure/retry and App shutdown assertions still run there.
            stop.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(5), service)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            retired_listeners.push(TcpListener::bind(address).await.unwrap());
            continue;
        };
        let request = json!({"mode":"local","lanAddress":lan.address});
        let ((status, launched), (again_status, again)) = tokio::join!(
            app_http(
                address,
                "POST",
                "/api/client-launcher/launch",
                Some(&local),
                Some(request.clone())
            ),
            app_http(
                address,
                "POST",
                "/api/client-launcher/launch",
                Some(&local),
                Some(request)
            ),
        );
        assert_eq!(status, 200);
        assert_eq!(again_status, 200);
        assert_eq!(
            launched, again,
            "concurrent launches share the App-owned startup"
        );
        let target = url::Url::parse(launched["target"].as_str().unwrap()).unwrap();
        assert_eq!(target.scheme(), "http");
        assert_eq!(target.host_str(), Some("127.0.0.1"));
        let identity = saved_identity();
        let metadata: DomainMetadata = serde_json::from_value(
            Storage::open(&folder.join("domain/channel.sqlite"))
                .unwrap()
                .load()
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let owner = metadata.owner_key.as_str();
        if attempt == 1 {
            assert_ne!(
                identity["owner"], owner,
                "the original seed is no longer active"
            );
        }
        assert!(
            url::form_urlencoded::parse(target.fragment().unwrap().as_bytes())
                .any(|(key, value)| key == "owner" && value == owner)
        );
        let domain_address =
            std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), target.port().unwrap());
        let lan_address =
            std::net::SocketAddr::new(lan.address.parse().unwrap(), domain_address.port());
        let invitation = format!("https://{lan_address}");
        assert!(
            TcpListener::bind(lan_address).await.is_err(),
            "the TLS entry is actually bound"
        );
        assert_eq!(
            app_http(
                address,
                "GET",
                "/health",
                Some(target.origin().ascii_serialization().as_str()),
                None
            )
            .await
            .0,
            200,
            "only the local owner entry is automatically authorized"
        );
        assert_eq!(
            app_http(address, "GET", "/health", Some(&invitation), None)
                .await
                .0,
            403
        );
        assert_eq!(
            app_http(
                address,
                "POST",
                "/api/client-launcher/launch",
                Some(&invitation),
                Some(json!({"mode":"link"}))
            )
            .await
            .0,
            403,
            "LAN guests cannot control App startup"
        );
        // HTTP and HTTPS use the same Domain router, which has no App API or
        // bootstrap endpoint. The TLS adapter's real handshake is tested there.
        assert_eq!(
            app_http(domain_address, "GET", "/api/client-launcher", None, None)
                .await
                .0,
            404
        );
        let mut upgrade = format!("ws://{domain_address}/prototype/channel")
            .into_client_request()
            .unwrap();
        upgrade
            .headers_mut()
            .insert("Origin", invitation.parse().unwrap());
        let (mut guest, _) = connect_async(upgrade).await.unwrap();
        guest
            .send(Message::Text(
                json!({"type":"join","name":"LAN guest", "key":metadata.invite_key,
            "signingKey":SessionSigner::from_seed([31;32]).signing_key()})
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let welcome = tokio::time::timeout(Duration::from_secs(5), guest.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let text = welcome.into_text().unwrap();
        assert!(
            !text.contains(owner),
            "the public Welcome cannot contain the owner bootstrap"
        );
        let welcome: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(welcome["type"], "welcome");
        assert_eq!(welcome["invitationOrigin"], invitation);
        let stun_url = welcome["state"]["iceServers"][0]["urls"][0]
            .as_str()
            .unwrap();
        let stun_address: std::net::SocketAddr =
            stun_url.strip_prefix("stun:").unwrap().parse().unwrap();
        assert_eq!(stun_address.ip(), lan_address.ip());
        assert_ne!(stun_address.port(), 0);
        assert_eq!(
            welcome["state"]["iceServers"],
            json!([{"urls": [stun_url]}]),
            "the Domain supplies only selected-LAN discovery to its participants"
        );
        let client = UdpSocket::bind((lan_address.ip(), 0)).await.unwrap();
        client.send_to(&[0; 4096], stun_address).await.unwrap();
        let mut ignored = StunMessage::new();
        ignored
            .build(&[Box::new(TransactionId::new()), Box::new(BINDING_SUCCESS)])
            .unwrap();
        client.send_to(&ignored.raw, stun_address).await.unwrap();
        let mut request = StunMessage::new();
        request
            .build(&[
                Box::new(TransactionId::new()),
                Box::new(BINDING_REQUEST),
                Box::new(FINGERPRINT),
            ])
            .unwrap();
        client.send_to(&request.raw, stun_address).await.unwrap();
        let mut bytes = [0; 2048];
        let (length, source) =
            tokio::time::timeout(Duration::from_secs(5), client.recv_from(&mut bytes))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(source, stun_address);
        let mut response = StunMessage::new();
        response.unmarshal_binary(&bytes[..length]).unwrap();
        assert_eq!(response.typ, BINDING_SUCCESS);
        assert_eq!(response.transaction_id, request.transaction_id);
        FINGERPRINT.check(&response).unwrap();
        let mut mapped = XorMappedAddress::default();
        mapped.get_from(&response).unwrap();
        assert_eq!(
            (mapped.ip, mapped.port),
            (
                client.local_addr().unwrap().ip(),
                client.local_addr().unwrap().port()
            )
        );
        let domain = welcome["state"]["channel"]["id"].clone();
        if let Some((old_port, old_domain, old_identity)) = &first {
            assert_ne!(
                domain_address.port(),
                *old_port,
                "the old port remains held by the test"
            );
            assert_eq!(&domain, old_domain);
            assert_eq!(
                &identity, old_identity,
                "port changes cannot select another local data namespace"
            );
        } else {
            first = Some((domain_address.port(), domain, identity));
        }
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), service)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(frame) = guest.next().await {
                if matches!(frame.unwrap(), Message::Close(_)) {
                    break;
                }
            }
        })
        .await
        .expect("App stop retires the local Domain's actual socket");
        retired_listeners.push(TcpListener::bind(domain_address).await.unwrap());
        retired_listeners.push(TcpListener::bind(lan_address).await.unwrap());
        retired_listeners.push(TcpListener::bind(address).await.unwrap());
        retired_stun.push(UdpSocket::bind(stun_address).await.unwrap());
        if attempt == 0 {
            // Emulate replacement of the stopped Domain's hosting record. The
            // next launcher URL and real guest admission must use these keys,
            // while App namespace and original creation seeds remain unchanged.
            let mut restored = metadata;
            restored.owner_key = Uuid::new_v4().to_string();
            restored.invite_key = Uuid::new_v4().to_string();
            Storage::open(&folder.join("domain/channel.sqlite"))
                .unwrap()
                .save(&serde_json::to_value(restored).unwrap())
                .unwrap();
        }
    }
    drop(retired_listeners);
    drop(retired_stun);
    std::fs::remove_dir_all(folder).unwrap();
}
