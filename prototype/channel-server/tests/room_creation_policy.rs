use futures_util::{SinkExt, StreamExt};
use piik_channel_core::{conversation::SessionSigner, wire::CHANNEL_PROTOCOL};
use piik_channel_prototype::domain::Domain;
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpStream,
    process::{Child, Command},
    time::timeout,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};
use uuid::Uuid;

const OWNER_KEY: &str = "local-test-owner";
const POLICY_ENV: &str = "PIIK_CHANNEL_ROOM_CREATION_POLICY";
const MODE_ENV: &str = "PIIK_CHANNEL_HOSTING_MODE";
const DEADLINE: Duration = Duration::from_secs(10);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn server(data: &Path, frontend: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_piik-channel-prototype"));
    command
        .kill_on_drop(true)
        .env("PIIK_CHANNEL_BIND_ADDRESS", "127.0.0.1")
        .env("PIIK_CHANNEL_PORT", "0")
        .env("PIIK_CHANNEL_UDP_BIND_ADDRESS", "127.0.0.1")
        .env("PIIK_CHANNEL_ICE_SERVERS", "[]")
        .env("PIIK_CHANNEL_OWNER_KEY", OWNER_KEY)
        .env("PIIK_CHANNEL_SERVICE_TRANSIT", "false")
        .env("PIIK_CHANNEL_DATA_DIR", data)
        .env("PIIK_CHANNEL_WEB_DIR", frontend)
        .env_remove("PIIK_CHANNEL_UDP_PORT")
        .env_remove("PIIK_CHANNEL_UDP_PUBLIC_ADDRESS")
        .env_remove("PIIK_CHANNEL_INVITATION_ORIGIN")
        .env_remove("PIIK_CHANNEL_WEB_ORIGIN")
        .env_remove(POLICY_ENV)
        .env_remove(MODE_ENV)
        .stdout(Stdio::piped());
    command
}

async fn launch(mut command: Command) -> (Child, String) {
    let mut process = command.spawn().unwrap();
    let mut lines = BufReader::new(process.stdout.take().unwrap()).lines();
    let line = timeout(DEADLINE, async {
        let line = lines
            .next_line()
            .await
            .unwrap()
            .expect("Server exited before binding");
        assert!(lines.next_line().await.unwrap().is_some());
        line
    })
    .await
    .expect("Server startup timed out");
    let origin = line.strip_prefix("Piik Server: ").unwrap().to_string();
    (process, origin)
}

async fn next_event(socket: &mut Socket, expected: impl Fn(&Value) -> bool) -> Value {
    timeout(DEADLINE, async {
        loop {
            let message = socket
                .next()
                .await
                .expect("Server closed the socket")
                .unwrap();
            if let Message::Text(text) = message {
                let event: Value = serde_json::from_str(text.as_str()).unwrap();
                if expected(&event) {
                    return event;
                }
            }
        }
    })
    .await
    .expect("Server did not reply")
}

async fn join(origin: &str, owner: bool) -> (Socket, Value) {
    let address = origin.strip_prefix("http://").unwrap();
    let mut request = format!("ws://{address}/prototype/channel")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", origin.parse().unwrap());
    let (mut socket, _) = timeout(DEADLINE, connect_async(request))
        .await
        .expect("WebSocket upgrade timed out")
        .unwrap();
    let mut join = json!({
        "type": "join",
        "protocol": CHANNEL_PROTOCOL,
        "name": "Room policy check",
        "signingKey": SessionSigner::from_seed([if owner { 1 } else { 2 }; 32]).signing_key()
    });
    if owner {
        join["ownerKey"] = json!(OWNER_KEY);
    }
    socket
        .send(Message::Text(join.to_string().into()))
        .await
        .unwrap();
    let welcome = next_event(&mut socket, |event| {
        matches!(event["type"].as_str(), Some("welcome" | "error"))
    })
    .await;
    assert_eq!(welcome["type"], "welcome", "{welcome}");
    (socket, welcome)
}

async fn request(socket: &mut Socket, mut command: Value) -> Value {
    let id = Uuid::new_v4().to_string();
    command["requestId"] = json!(id);
    socket
        .send(Message::Text(command.to_string().into()))
        .await
        .unwrap();
    next_event(socket, |event| event["requestId"] == id).await
}

#[tokio::test]
async fn server_seeds_demo_policy_and_restores_later_admin_choice() {
    let temp = tempfile::tempdir().unwrap();
    let frontend = temp.path().join("web");
    std::fs::create_dir(&frontend).unwrap();
    std::fs::write(frontend.join("index.html"), "Room policy check").unwrap();

    let default_data = temp.path().join("default");
    let (mut process, origin) = launch(server(&default_data, &frontend)).await;
    let (_, welcome) = join(&origin, false).await;
    assert_eq!(
        welcome["state"]["channel"]["roomCreationPolicy"],
        "ordinary"
    );
    assert_eq!(welcome["state"]["channel"]["hostingMode"], "lightweight");
    process.kill().await.unwrap();

    let invalid_data = temp.path().join("invalid");
    for key in [POLICY_ENV, MODE_ENV, "PIIK_CHANNEL_SERVICE_TRANSIT"] {
        let output = timeout(
            DEADLINE,
            server(&invalid_data, &frontend).env(key, "public").output(),
        )
        .await
        .expect("Invalid configuration should exit")
        .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(key));
        assert!(!invalid_data.exists());
    }

    let demo_config = include_str!("../../../deploy/systemd/piik-demo.conf.example");
    let demo_settings = demo_config
        .lines()
        .filter_map(|line| line.strip_prefix("Environment="))
        .map(|setting| setting.split_once('=').unwrap());
    let demo_data = invalid_data;
    let mut command = server(&demo_data, &frontend);
    command.envs(demo_settings.clone());
    let (mut process, origin) = launch(command).await;
    let (mut guest, welcome) = join(&origin, false).await;
    assert_eq!(
        welcome["state"]["channel"]["roomCreationPolicy"],
        "invite_only"
    );
    assert_eq!(welcome["state"]["channel"]["hostingMode"], "lightweight");
    let mut room = json!({
        "id": Uuid::new_v4(),
        "name": "Guest room",
        "icon": "couch",
        "creatorId": welcome["selfProfile"]["id"],
        "access": "public",
        "hidden": false,
        "hasPassword": false
    });
    let rejected = request(&mut guest, json!({"type": "create_room", "room": room})).await;
    assert_eq!(rejected["code"], "room_creation_restricted", "{rejected}");
    room["access"] = json!("private");
    room["hidden"] = json!(true);
    let created = request(&mut guest, json!({"type": "create_room", "room": room})).await;
    assert_eq!(created["type"], "room_created", "{created}");
    let (mut owner, welcome) = join(&origin, true).await;
    let seeded = |event: &Value| {
        event["state"]["channel"]["rooms"]
            .as_array()
            .is_some_and(|rooms| {
                ["Living room", "Studio", "Quiet corner"]
                    .iter()
                    .all(|name| {
                        rooms
                            .iter()
                            .any(|room| room["name"] == *name && room["available"] == true)
                    })
            })
    };
    if !seeded(&welcome) {
        next_event(&mut owner, seeded).await;
    }
    let changed = request(
        &mut owner,
        json!({
            "type": "set_room_creation_policy",
            "policy": "owner_only"
        }),
    )
    .await;
    assert_eq!(changed["type"], "ack", "{changed}");
    process.kill().await.unwrap();

    let mut command = server(&demo_data, &frontend);
    command.envs(demo_settings).env(MODE_ENV, "hosted");
    let (mut process, origin) = launch(command).await;
    let (_, welcome) = join(&origin, false).await;
    assert_eq!(
        welcome["state"]["channel"]["roomCreationPolicy"],
        "owner_only"
    );
    assert_eq!(welcome["state"]["channel"]["hostingMode"], "lightweight");
    process.kill().await.unwrap();

    let hosted_data = temp.path().join("hosted");
    let mut command = server(&hosted_data, &frontend);
    command.env(MODE_ENV, "hosted");
    let (mut process, origin) = launch(command).await;
    let (_, welcome) = join(&origin, false).await;
    assert_eq!(welcome["state"]["channel"]["hostingMode"], "hosted");
    let (mut owner, welcome) = join(&origin, true).await;
    let picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    let created = request(&mut owner, json!({
        "type": "create_room",
        "room": {"id": Uuid::new_v4(), "name": "Hosted picture", "icon": "couch", "access": "public", "hidden": false,
            "creatorId": welcome["selfProfile"]["id"], "hasPassword": false},
        "picture": picture
    })).await;
    assert_eq!(created["type"], "room_created", "{created}");
    assert_eq!(created["room"]["icon"], "couch");
    assert!(!created.to_string().contains(picture));
    let id = created["room"]["id"].as_str().unwrap();
    owner
        .send(Message::Text(
            json!({"type":"browse","roomId":id,"active":true})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    next_event(&mut owner, |event| {
        event["state"]["channel"]["rooms"]
            .as_array()
            .is_some_and(|rooms| {
                rooms.iter().any(|room| {
                    room["id"] == id && room["reading"] == true && room["picture"] == picture
                })
            })
    })
    .await;
    owner
        .send(Message::Text(
            json!({
                "type":"update_room","roomId":id,"name":"Hosted picture cleared",
                "icon":"couch","access":"public","hidden":false,"picture":null
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    next_event(&mut owner, |event| {
        event["state"]["channel"]["rooms"]
            .as_array()
            .is_some_and(|rooms| {
                rooms.iter().any(|room| {
                    room["id"] == id
                        && room["name"] == "Hosted picture cleared"
                        && room["reading"] == true
                        && room["icon"] == "couch"
                        && room.get("picture").is_some_and(Value::is_null)
                })
            })
    })
    .await;
    process.kill().await.unwrap();
    let app_open = Domain::open(&hosted_data, OWNER_KEY, origin, None, vec![]);
    assert_eq!(
        app_open.err().unwrap().to_string(),
        "hosted_channel_requires_server"
    );
}
