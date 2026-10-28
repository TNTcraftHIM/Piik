use super::*;
use crate::serve_server as serve;
use serde_json::{json, Value};

struct Endpoint {
    id: Uuid,
    user: Uuid,
    session: Uuid,
    events: mpsc::Receiver<Event>,
}

impl Endpoint {
    fn connect(hub: &mut Hub) -> Self {
        let id = Uuid::new_v4();
        let (events, queue) = mpsc::channel(64);
        let (close, _) = watch::channel(false);
        hub.clients.insert(id, Client { events, close });
        Self {
            id,
            user: Uuid::nil(),
            session: Uuid::nil(),
            events: queue,
        }
    }

    fn join(hub: &mut Hub, key: &str) -> Self {
        let mut endpoint = Self::connect(hub);
        endpoint.request(hub, json!({"type":"join", "key":key, "name":"Friend"}));
        let welcome = endpoint
            .drain()
            .into_iter()
            .find(|event| event["type"] == "welcome")
            .unwrap();
        endpoint.user = Uuid::parse_str(
            welcome["state"]["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|session| session["id"] == welcome["sessionId"])
                .unwrap()["userId"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        endpoint.session = Uuid::parse_str(welcome["sessionId"].as_str().unwrap()).unwrap();
        endpoint
    }

    fn request(&self, hub: &mut Hub, mut command: Value) {
        if command["type"] == "join" {
            command["signingKey"] = json!(
                piik_channel_core::conversation::SessionSigner::from_seed([1; 32]).signing_key()
            );
        }
        hub.request(self.id, Request::parse(&command.to_string()).unwrap());
    }

    fn drain(&mut self) -> Vec<Value> {
        std::iter::from_fn(|| self.events.try_recv().ok())
            .map(|event| serde_json::to_value(event).unwrap())
            .collect()
    }
}

#[test]
fn retired_or_closing_connections_cannot_execute_queued_requests() {
    let mut hub = Hub {
        authority: Authority::new("owner".into(), "invite".into(), vec![]).unwrap(),
        clients: BTreeMap::new(),
        storage: Arc::new(Mutex::new(
            storage::Storage::open(Path::new(":memory:")).unwrap(),
        )),
    };
    let mut active = Endpoint::join(&mut hub, "owner");
    let mut retired = Endpoint::join(&mut hub, "invite");
    retired.request(&mut hub, json!({"type":"leave","requestId":"leaving"}));
    assert!(!hub.clients.contains_key(&retired.id));
    assert!(retired
        .drain()
        .iter()
        .any(|event| event["type"] == "ack" && event["requestId"] == "leaving"));
    let saved = serde_json::to_value(hub.authority.export_state()).unwrap();
    retired.request(
        &mut hub,
        json!({"type":"join","key":"invite","name":"Late join"}),
    );
    assert_eq!(
        serde_json::to_value(hub.authority.export_state()).unwrap(),
        saved
    );
    active.drain();
    active.request(&mut hub, json!({"type":"set_name","name":"Active"}));
    let state = active
        .drain()
        .into_iter()
        .find(|event| event["type"] == "state")
        .unwrap();
    assert_eq!(
        state["state"]["sessions"].as_array().unwrap().len(),
        1,
        "a queued Join must not revive the departed connection"
    );

    let mut closing = Endpoint::join(&mut hub, "invite");
    // Keep the receiver alive, as the real writer does while flushing its queue.
    let close = hub.clients[&closing.id].close.subscribe();
    hub.clients[&closing.id].close.send(true).unwrap();
    assert!(*close.borrow());
    let saved = serde_json::to_value(hub.authority.export_state()).unwrap();
    closing.request(
        &mut hub,
        json!({"type":"set_name","name":"Closing command"}),
    );
    assert_eq!(
        serde_json::to_value(hub.authority.export_state()).unwrap(),
        saved
    );
    assert!(closing.drain().is_empty());
    active.drain();
    active.request(
        &mut hub,
        json!({"type":"set_name","name":"Still active","requestId":"active"}),
    );
    assert!(active
        .drain()
        .iter()
        .any(|event| event["type"] == "ack" && event["requestId"] == "active"));
}

fn complete_host_turn(
    hub: &mut Hub,
    endpoint: &mut Endpoint,
    host: &mut piik_channel_core::host::RoomHost,
    room_store: &mut storage::Storage,
) {
    let input = std::iter::from_fn(|| endpoint.events.try_recv().ok())
        .find_map(|event| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let work = host.dispatch(input).unwrap();
    if let Some(policy) = work.policy {
        room_store
            .save(&serde_json::to_value(policy).unwrap())
            .unwrap();
    }
    let history = work
        .history
        .as_ref()
        .map(|request| room_store.history(request).unwrap());
    let output = host.finish(history).unwrap();
    endpoint.request(
        hub,
        json!({"type":"host_output", "roomId":host.policy().id, "output":output}),
    );
}

#[test]
fn directory_save_failure_cannot_restore_a_room_hosts_revoked_flows() {
    use piik_channel_core::{host::RoomHost, wire::RoomAccess, RoomState};
    let directory_path =
        std::env::temp_dir().join(format!("piik-directory-failure-{}.sqlite", Uuid::new_v4()));
    let room_path =
        std::env::temp_dir().join(format!("piik-host-policy-{}.sqlite", Uuid::new_v4()));
    let directory_store = storage::Storage::open(&directory_path).unwrap();
    let mut room_store = storage::Storage::open(&room_path).unwrap();
    let mut hub = Hub {
        authority: Authority::new("owner".into(), "invite".into(), vec![]).unwrap(),
        clients: BTreeMap::new(),
        storage: Arc::new(Mutex::new(directory_store)),
    };
    let mut operator = Endpoint::join(&mut hub, "invite");
    let mut viewer = Endpoint::join(&mut hub, "invite");
    let mut host = RoomHost::new(
        RoomState::new(
            "hosted".into(),
            "Hosted".into(),
            operator.user,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap(),
    );
    room_store
        .save(&serde_json::to_value(host.policy()).unwrap())
        .unwrap();
    operator.request(
        &mut hub,
        json!({"type":"host_register", "room":host.summary()}),
    );
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    let publication = Uuid::new_v4();
    operator.request(&mut hub, json!({"type":"publish", "publication":{"id":publication,"roomId":"hosted","kind":"screen","muted":false}}));
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    viewer.request(
        &mut hub,
        json!({"type":"subscribe", "publicationId":publication, "enabled":true}),
    );
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    let state = viewer
        .drain()
        .into_iter()
        .filter(|event| event["type"] == "state")
        .last()
        .unwrap();
    let pair = state["state"]["pairs"][0]["id"].clone();
    assert!(pair.is_string());
    operator.drain();
    let database = rusqlite::Connection::open(&directory_path).unwrap();
    database.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'metadata unavailable'); END;").unwrap();
    operator.request(&mut hub, json!({"type":"update_room","roomId":"hosted","name":"Private","access":"private","hidden":false,"requestId":"make-private"}));
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    assert_eq!(
        room_store.load().unwrap().unwrap()["access"],
        "private",
        "the real room store committed first"
    );
    assert_eq!(
        hub.storage.lock().unwrap().load().unwrap().unwrap()["hostedRooms"]["hosted"]["access"],
        "public",
        "the directory checkpoint really failed"
    );
    let updates = viewer.drain();
    viewer.request(
        &mut hub,
        json!({"type":"signal", "pairId":pair,"payload":{},"requestId":"retired-path"}),
    );
    assert!(
        viewer
            .drain()
            .iter()
            .any(|event| event["type"] == "error" && event["code"] == "unassigned_pair"),
        "directory rollback restored signaling on the room host's revoked flow"
    );
    let private = updates
        .iter()
        .find(|event| event["type"] == "state")
        .expect("committed room revocation must reach clients despite directory failure");
    assert!(private["state"]["pairs"].as_array().unwrap().is_empty());
    assert!(!private["state"]["channel"]["rooms"]
        .as_array()
        .unwrap()
        .iter()
        .find(|room| room["id"] == "hosted")
        .unwrap()["authorized"]
        .as_bool()
        .unwrap());
    let result = operator.drain();
    assert!(result.iter().any(|event| event["type"] == "room_reply"
        && event["requestId"] == "make-private"
        && event["result"]["type"] == "done"));
    assert!(result.iter().any(|event| event["type"] == "error"
        && event["code"] == "directory_storage_failed"
        && event.get("requestId").is_none()));

    // The same failed domain store must still withhold an invited identity,
    // even after its separate room host has committed the room grant.
    operator.request(
        &mut hub,
        json!({"type":"room_invite","roomId":"hosted","requestId":"invite"}),
    );
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    let invitation = operator
        .drain()
        .into_iter()
        .find(|event| event["type"] == "room_invite")
        .unwrap()["key"]
        .clone();
    let mut invited = Endpoint::connect(&mut hub);
    database
        .execute_batch("DROP TRIGGER reject_checkpoint;")
        .unwrap();
    invited.request(&mut hub, json!({"type":"join","name":"Invited","roomId":"hosted","key":invitation,"requestId":"admission"}));
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store); // verify invitation
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store); // current endpoints
    database.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'metadata unavailable'); END;").unwrap();
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store); // durable grant, domain identity commit fails
    assert_eq!(
        invited.drain(),
        vec![json!({"type":"error","code":"storage_failed","requestId":"admission"})]
    );
    assert!(
        room_store.load().unwrap().unwrap()["grants"]
            .as_array()
            .unwrap()
            .len()
            > 0
    );
    assert_eq!(
        serde_json::to_value(hub.authority.export_state()).unwrap()["users"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "an unconfirmed domain identity must not be checkpointed"
    );
    drop(database);
    drop(room_store);
    drop(hub);
    std::fs::remove_file(directory_path).unwrap();
    std::fs::remove_file(room_path).unwrap();
}

fn stored_turn(
    hub: &mut Hub,
    endpoint: &mut Endpoint,
    host: &mut piik_channel_core::StoredRoomHost,
) -> Uuid {
    let input = std::iter::from_fn(|| endpoint.events.try_recv().ok())
        .find_map(|event| {
            if let Event::HostInput { input, .. } = event {
                Some(input)
            } else {
                None
            }
        })
        .unwrap();
    let output = host.dispatch(input).unwrap();
    let binding = output.binding_id;
    endpoint.request(
        hub,
        json!({"type":"host_output", "roomId":host.policy().id, "output":output}),
    );
    binding
}

#[test]
fn room_peer_commit_owns_confirmation_retry_without_domain_checkpoint() {
    use piik_channel_core::{
        conversation::{
            ConversationAddress, ConversationCommand, ConversationRequest, SessionSigner,
        },
        history::HistoryResult,
        wire::RoomAccess,
        RoomState, StoredRoomHost,
    };
    let folder = std::env::temp_dir().join(format!("piik-room-commit-{}", Uuid::new_v4()));
    let state = Domain::open(
        &folder,
        "owner",
        "invite",
        "http://localhost".into(),
        vec![],
    )
    .unwrap();
    std::fs::create_dir_all(folder.join("rooms")).unwrap();
    let mut hub = state.hub.lock().unwrap();
    let mut sender = Endpoint::join(&mut hub, "owner");
    let reader = Endpoint::join(&mut hub, "invite");
    let mut rooms: Vec<_> = ["living", "quiet"]
        .into_iter()
        .map(|id| {
            let mut host = StoredRoomHost::create(
                &folder.join("rooms").join(format!("{id}.sqlite")),
                RoomState::new(
                    id.into(),
                    id.into(),
                    sender.user,
                    RoomAccess::Public,
                    false,
                    None,
                )
                .unwrap(),
            )
            .unwrap();
            sender.request(
                &mut hub,
                json!({"type":"host_register", "room":host.summary()}),
            );
            let binding = stored_turn(&mut hub, &mut sender, &mut host);
            (host, binding)
        })
        .collect();
    reader.request(
        &mut hub,
        json!({"type":"browse", "roomId":"living", "active":true}),
    );
    stored_turn(&mut hub, &mut sender, &mut rooms[0].0);
    let signer = SessionSigner::from_seed([1; 32]);
    let sender_session = sender.session;
    let reader_session = reader.session;
    let peer = |host: &mut StoredRoomHost, binding, command| {
        let request = ConversationRequest {
            address: ConversationAddress {
                room_id: host.policy().id.clone(),
                binding_id: binding,
                sender: reader_session,
                recipient: sender_session,
                request_id: Uuid::new_v4().to_string(),
            },
            command,
        };
        host.dispatch_peer(&signer.sign(reader_session, &request).unwrap(), now())
            .unwrap()
            .result
    };
    let chat = |text: &str| ConversationCommand::Chat {
        text: text.into(),
        nonce: "same-send".into(),
        attachments: vec![],
    };
    let room_db = rusqlite::Connection::open(folder.join("rooms/living.sqlite")).unwrap();
    room_db.execute_batch("CREATE TRIGGER reject_message BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
    let binding = rooms[0].1;
    assert!(matches!(
        peer(&mut rooms[0].0, binding, chat("Hello")),
        Err("storage_failed")
    ));
    room_db
        .execute_batch("DROP TRIGGER reject_message;")
        .unwrap();
    let binding = rooms[0].1;
    let HistoryResult::Sent(original) = peer(&mut rooms[0].0, binding, chat("Hello")).unwrap()
    else {
        panic!("room confirmation")
    };
    assert!(original.inserted);
    assert_eq!(original.message.seq, 1);
    assert_eq!(rooms[0].0.current_readers(), vec![reader.session]);
    let domain_db = rusqlite::Connection::open(folder.join("channel.sqlite")).unwrap();
    domain_db.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'metadata unavailable'); END;").unwrap();
    let HistoryResult::Sent(retry) = peer(&mut rooms[0].0, binding, chat("Changed retry")).unwrap()
    else {
        panic!("room retry")
    };
    assert!(
        !retry.inserted,
        "a retry must not rebroadcast the saved message"
    );
    assert_eq!(
        serde_json::to_value(retry.message).unwrap(),
        serde_json::to_value(&original.message).unwrap()
    );
    let binding = rooms[1].1;
    let HistoryResult::Sent(other) = peer(&mut rooms[1].0, binding, chat("Other room")).unwrap()
    else {
        panic!("other room")
    };
    assert_eq!(other.message.seq, 1);
    assert_ne!(other.message.id, original.message.id);
    let binding = rooms[0].1;
    assert!(
        matches!(peer(&mut rooms[0].0, binding, ConversationCommand::History { before: None }).unwrap(),
        HistoryResult::Page { messages, .. } if messages.len() == 1 && messages[0].id == original.message.id)
    );
    assert_eq!(
        domain_db
            .query_row("SELECT count(*) FROM message", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    let (old, _) = rooms.remove(0);
    drop(old);
    let mut reopened = StoredRoomHost::open(&folder.join("rooms/living.sqlite")).unwrap();
    sender.request(
        &mut hub,
        json!({"type":"host_register", "room":reopened.summary()}),
    );
    let binding = stored_turn(&mut hub, &mut sender, &mut reopened);
    let HistoryResult::Sent(retry) =
        peer(&mut reopened, binding, chat("Retry after restart")).unwrap()
    else {
        panic!("retained room confirmation")
    };
    assert!(!retry.inserted);
    assert_eq!(
        serde_json::to_value(retry.message).unwrap(),
        serde_json::to_value(&original.message).unwrap()
    );
    assert!(
        matches!(peer(&mut reopened, binding, ConversationCommand::History { before: None }).unwrap(),
        HistoryResult::Page { messages, .. } if messages.len() == 1 && messages[0].id == original.message.id)
    );
    drop(reopened);
    drop(domain_db);
    drop(room_db);
    drop(rooms);
    drop(hub);
    drop(state);
    std::fs::remove_dir_all(folder).unwrap();
}

use futures_util::{SinkExt, StreamExt};
use piik_channel_core::wire::Snapshot;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn event(socket: &mut Socket) -> Event {
    loop {
        match socket.next().await.unwrap().unwrap() {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
            other => panic!("unexpected socket event: {other:?}"),
        }
    }
}
async fn state_when(socket: &mut Socket, predicate: impl Fn(&Snapshot) -> bool) -> Snapshot {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match event(socket).await {
                Event::Welcome { state, .. } | Event::State { state } if predicate(&state) => {
                    return state
                }
                Event::Error { code, .. } => panic!("server command failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .expect("server room state")
}
async fn send_request(socket: &mut Socket, mut value: Value) {
    value["requestId"] = json!(Uuid::new_v4().to_string());
    if value["type"] == "join" {
        value["signingKey"] =
            json!(piik_channel_core::conversation::SessionSigner::from_seed([1; 32]).signing_key());
    }
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn connect(address: std::net::SocketAddr, key: &str, name: &str) -> (Socket, Uuid, Snapshot) {
    let mut request = format!("ws://{address}/prototype/channel")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "http://localhost".parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    send_request(&mut socket, json!({"type":"join", "key":key, "name":name})).await;
    let Event::Welcome {
        session_id, state, ..
    } = event(&mut socket).await
    else {
        panic!("authenticated welcome")
    };
    (socket, session_id, state)
}
async fn start_server(
    folder: &Path,
) -> (
    std::net::SocketAddr,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<anyhow::Result<()>>,
    Arc<Mutex<Hub>>,
) {
    let state = Domain::open(folder, "owner", "invite", "http://localhost".into(), vec![]).unwrap();
    let hub = state.hub.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let folder = folder.to_owned();
    let task = tokio::spawn(serve(listener, state, folder, "owner".into(), async {
        let _ = stopped.await;
    }));
    (address, stop, task, hub)
}

#[tokio::test]
async fn service_hosts_three_rooms_as_one_native_endpoint_and_releases_them_on_restart() {
    use piik_channel_core::{wire::RoomAccess, StoredRoomHost};
    let folder = std::env::temp_dir().join(format!("piik-server-hosting-{}", Uuid::new_v4()));
    let (address, stop, task, hub) = start_server(&folder).await;
    let (mut admin, admin_session, initial) = connect(address, "owner", "Owner renamed").await;
    let ready = |state: &Snapshot| {
        state.channel.rooms.len() == 3 && state.channel.rooms.iter().all(|room| room.available)
    };
    let initial = if ready(&initial) {
        initial
    } else {
        state_when(&mut admin, ready).await
    };
    let native = initial.channel.rooms[0]
        .delivery
        .as_ref()
        .unwrap()
        .host_session_id;
    assert_ne!(
        native, admin_session,
        "the administrator page is not the Native endpoint"
    );
    assert!(initial.channel.rooms.iter().all(|room| room
        .delivery
        .as_ref()
        .unwrap()
        .host_session_id
        == native));
    let owner = initial
        .sessions
        .iter()
        .find(|session| session.id == native)
        .unwrap()
        .user_id;
    assert!(initial
        .channel
        .rooms
        .iter()
        .all(|room| room.creator_id == owner && room.capabilities.attachments));
    send_request(
        &mut admin,
        json!({"type":"set_name", "name":"Owner renamed"}),
    )
    .await;
    send_request(&mut admin, json!({"type":"update_room", "roomId":"living", "name":"Saved living", "access":"private", "hidden":false, "password":"room-password"})).await;
    state_when(&mut admin, |state| {
        state.channel.rooms.iter().any(|room| {
            room.id == "living" && room.name == "Saved living" && room.access == RoomAccess::Private
        })
    })
    .await;
    let (mut guest, guest_session, _) = connect(address, "invite", "Guest").await;
    send_request(
        &mut guest,
        json!({"type":"enter_room", "roomId":"living", "password":"room-password"}),
    )
    .await;
    let admitted = state_when(&mut guest, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|room| room.id == "living" && room.authorized)
    })
    .await;
    let guest_user = admitted
        .sessions
        .iter()
        .find(|session| session.id == guest_session)
        .unwrap()
        .user_id;
    for room in ["living", "studio"] {
        send_request(
            &mut admin,
            json!({"type":"browse", "roomId":room, "active":true}),
        )
        .await;
    }
    let both = state_when(&mut admin, |state| {
        state
            .channel
            .rooms
            .iter()
            .filter(|room| room.reading)
            .count()
            == 2
    })
    .await;
    let pair = both
        .pairs
        .iter()
        .find(|pair| {
            pair.peer_id == native
                && pair.rooms.iter().any(|id| id == "living")
                && pair.rooms.iter().any(|id| id == "studio")
        })
        .unwrap()
        .id;
    send_request(
        &mut admin,
        json!({"type":"browse", "roomId":"living", "active":false}),
    )
    .await;
    let remaining = state_when(&mut admin, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|room| room.id == "living" && !room.reading)
            && state
                .pairs
                .iter()
                .any(|current| current.id == pair && current.rooms == ["studio"])
    })
    .await;
    assert!(remaining
        .channel
        .rooms
        .iter()
        .any(|room| room.id == "studio" && room.reading));
    stop.send(()).unwrap();
    state_when(&mut admin, |state| {
        !state.sessions.iter().any(|session| session.id == native)
            && state.channel.rooms.iter().all(|room| !room.available)
    })
    .await;
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    // Probe the still-owned authority immediately, before its 20-second expiry:
    // Native must have completed Leave rather than merely losing its socket.
    {
        let mut hub = hub.lock().unwrap();
        let mut probe = Endpoint::connect(&mut hub);
        probe.request(
            &mut hub,
            json!({"type":"join", "key":"owner", "name":"Owner renamed"}),
        );
        let welcome = probe
            .drain()
            .into_iter()
            .find(|event| event["type"] == "welcome")
            .unwrap();
        assert!(
            !welcome["state"]["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|session| session["id"] == native.to_string()),
            "Native Leave must retire its session before HTTP closes"
        );
    }
    drop(hub);
    drop(admin);
    drop(guest);
    for id in ["living", "studio", "quiet"] {
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(folder.join("rooms").join(format!("{id}.sqlite.lock")))
            .unwrap();
        lock.try_lock()
            .expect("stopped service releases the runtime lock");
    }
    let saved = StoredRoomHost::open(&folder.join("rooms/living.sqlite")).unwrap();
    assert_eq!(saved.policy().name, "Saved living");
    assert!(saved.policy().access == RoomAccess::Private);
    assert!(saved.policy().grants.contains(&guest_user));
    drop(saved);
    let restored = Domain::open(
        &folder,
        "owner",
        "invite",
        "http://localhost".into(),
        vec![],
    )
    .unwrap();
    assert_eq!(
        restored.hub.lock().unwrap().authority.owner_name(),
        Some("Owner renamed")
    );
    drop(restored);
    let (address, stop, task, hub) = start_server(&folder).await;
    let (mut admin, _, initial) = connect(address, "owner", "Owner renamed").await;
    let initial = if ready(&initial) {
        initial
    } else {
        state_when(&mut admin, ready).await
    };
    let reopened = initial
        .channel
        .rooms
        .iter()
        .find(|room| room.id == "living")
        .unwrap();
    assert_eq!(reopened.creator_id, owner);
    assert_eq!(reopened.name, "Saved living");
    assert_ne!(reopened.delivery.as_ref().unwrap().host_session_id, native);
    assert!(initial.publications.is_empty() && initial.voice.is_empty());
    assert!(initial.channel.rooms.iter().all(|room| !room.reading));
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(admin);
    drop(hub);
    std::fs::remove_dir_all(folder).unwrap();
}

#[tokio::test]
async fn native_hosting_failure_stops_the_http_service() {
    let folder = std::env::temp_dir().join(format!("piik-server-failure-{}", Uuid::new_v4()));
    std::fs::create_dir_all(folder.join("rooms")).unwrap();
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(folder.join("rooms/living.sqlite.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    let (address, _stop, task, hub) = start_server(&folder).await;
    let error = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("room_storage_in_use"));
    let listener = TcpListener::bind(address)
        .await
        .expect("a failed Native host cannot leave a healthy HTTP shell");
    drop(listener);
    drop(lock);
    drop(hub);
    std::fs::remove_dir_all(folder).unwrap();
}
