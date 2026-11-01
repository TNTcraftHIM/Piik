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
fn domain_keys_belong_to_its_data_and_old_checkpoints_remain_untouched() {
    let folder = std::env::temp_dir().join(format!("piik-domain-keys-{}", Uuid::new_v4()));
    let open = |owner, invite| {
        Domain::open(
            &folder,
            owner,
            invite,
            "http://localhost".into(),
            None,
            vec![],
        )
    };
    let domain = open("saved-owner", "saved-invite").unwrap();
    let identity = domain.identity();
    let old_checkpoint;
    {
        let mut hub = domain.hub.lock().unwrap();
        let owner = Endpoint::join(&mut hub, "saved-owner");
        assert_eq!(owner.user, identity.1);
        old_checkpoint = serde_json::to_value(hub.authority.export_state()).unwrap();
    }
    drop(domain);
    for (owner_seed, invite_seed) in [("different-owner", "different-invite"), ("", "")] {
        let reopened = open(owner_seed, invite_seed).unwrap();
        assert_eq!(reopened.identity(), identity);
        assert_eq!(reopened.owner_key(), "saved-owner");
        let mut hub = reopened.hub.lock().unwrap();
        let owner = Endpoint::join(&mut hub, "saved-owner");
        assert_eq!(owner.user, identity.1);
        let mut rejected = Endpoint::connect(&mut hub);
        rejected.request(
            &mut hub,
            json!({"type":"join", "name":"Wrong seed", "key":"different-owner"}),
        );
        assert!(rejected
            .drain()
            .iter()
            .any(|event| event["type"] == "error"));
    }
    let mut store = storage::Storage::open(&folder.join("channel.sqlite")).unwrap();
    store.save(&old_checkpoint).unwrap();
    drop(store);
    assert!(open("saved-owner", "saved-invite")
        .err()
        .unwrap()
        .to_string()
        .contains("unsupported_domain_checkpoint"));
    let store = storage::Storage::open(&folder.join("channel.sqlite")).unwrap();
    assert_eq!(store.load().unwrap().unwrap(), old_checkpoint);
    drop(store);
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn domain_metadata_requires_owner_and_commits_before_broadcast_then_reopens() {
    let path = std::env::temp_dir().join(format!("piik-domain-metadata-{}.sqlite", Uuid::new_v4()));
    let mut hub = Hub {
        authority: Authority::new("owner".into(), "invite".into(), vec![]).unwrap(),
        clients: BTreeMap::new(),
        invitation_origin: None,
        storage: Arc::new(Mutex::new(storage::Storage::open(&path).unwrap())),
    };
    let mut owner = Endpoint::join(&mut hub, "owner");
    let mut guest = Endpoint::join(&mut hub, "invite");
    owner.drain();
    let original = serde_json::to_value(hub.authority.export_state()).unwrap();
    let icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    let update =
        json!({"type":"update_domain","name":"  Friends  ","icon":icon,"requestId":"metadata"});
    guest.request(&mut hub, update.clone());
    assert!(guest
        .drain()
        .iter()
        .any(|event| event["code"] == "forbidden"));
    assert_eq!(
        serde_json::to_value(hub.authority.export_state()).unwrap(),
        original
    );
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("CREATE TRIGGER reject_metadata BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
    owner.request(&mut hub, update.clone());
    assert!(owner
        .drain()
        .iter()
        .any(|event| event["code"] == "storage_failed"));
    assert!(
        guest.drain().is_empty(),
        "failed metadata must not broadcast"
    );
    assert_eq!(
        serde_json::to_value(hub.authority.export_state()).unwrap(),
        original
    );
    assert_eq!(
        hub.storage.lock().unwrap().load().unwrap().unwrap()["state"],
        original
    );
    database
        .execute_batch("DROP TRIGGER reject_metadata;")
        .unwrap();
    owner.request(&mut hub, update);
    let state = guest
        .drain()
        .into_iter()
        .find(|event| event["type"] == "state")
        .unwrap();
    assert_eq!(state["state"]["channel"]["name"], "Friends");
    assert_eq!(state["state"]["channel"]["icon"], icon);
    let _: piik_channel_core::wire::Snapshot =
        serde_json::from_value(state["state"].clone()).unwrap();
    drop(hub);
    let store = storage::Storage::open(&path).unwrap();
    let restored = serde_json::from_value::<DomainMetadata>(store.load().unwrap().unwrap())
        .unwrap()
        .into_authority(vec![])
        .unwrap();
    let saved = serde_json::to_value(restored.export_state()).unwrap();
    assert_eq!(saved["name"], "Friends");
    assert_eq!(saved["icon"], icon);
    drop(store);
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn retired_or_closing_connections_cannot_execute_queued_requests() {
    let mut hub = Hub {
        authority: Authority::new("owner".into(), "invite".into(), vec![]).unwrap(),
        clients: BTreeMap::new(),
        invitation_origin: None,
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
        invitation_origin: None,
    };
    let mut operator = Endpoint::join(&mut hub, "invite");
    let mut viewer = Endpoint::join(&mut hub, "invite");
    let mut host = RoomHost::new(
        RoomState::new(
            "hosted".into(),
            "Hosted".into(),
            Default::default(),
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
    operator.request(&mut hub, json!({"type":"update_room","icon":"couch","roomId":"hosted","name":"Private","access":"private","hidden":false,"requestId":"make-private"}));
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    assert_eq!(
        room_store.load().unwrap().unwrap()["access"],
        "private",
        "the real room store committed first"
    );
    assert_eq!(
        hub.storage.lock().unwrap().load().unwrap().unwrap()["state"]["hostedRooms"]["hosted"]
            ["access"],
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
        None,
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
                    Default::default(),
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
            .map(|result| match result {
                piik_channel_core::conversation::ConversationResult::History(history) => history,
                _ => panic!("history result expected"),
            })
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
    assert_eq!(original.message.message.seq, 1);
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
    assert_eq!(other.message.message.seq, 1);
    assert_ne!(other.message.message.id, original.message.message.id);
    let binding = rooms[0].1;
    assert!(
        matches!(peer(&mut rooms[0].0, binding, ConversationCommand::History { before: None }).unwrap(),
        HistoryResult::Page { messages, .. } if messages.len() == 1 && messages[0].message.id == original.message.message.id)
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
        HistoryResult::Page { messages, .. } if messages.len() == 1 && messages[0].message.id == original.message.message.id)
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
    let (socket, session, state, _) = connect_with_credential(address, key, name).await;
    (socket, session, state)
}
async fn connect_with_credential(
    address: std::net::SocketAddr,
    key: &str,
    name: &str,
) -> (Socket, Uuid, Snapshot, String) {
    let mut request = format!("ws://{address}/prototype/channel")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "http://localhost".parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    send_request(&mut socket, json!({"type":"join", "key":key, "name":name})).await;
    let Event::Welcome {
        session_id,
        state,
        credential,
        ..
    } = event(&mut socket).await
    else {
        panic!("authenticated welcome")
    };
    (socket, session_id, state, credential)
}

async fn room_backup_http(
    address: std::net::SocketAddr,
    path: &str,
    credential: &str,
    upload: Option<Vec<u8>>,
) -> (u16, Vec<u8>) {
    let (path, credential) = (path.to_owned(), credential.to_owned());
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(10)))
            .build()
            .new_agent();
        let request = ureq::http::Request::builder()
            .method(if upload.is_some() { "PUT" } else { "GET" })
            .uri(format!("http://{address}{path}"))
            .header("Authorization", format!("Bearer {credential}"))
            .header("Content-Type", "application/zip")
            .body(upload.unwrap_or_default())
            .unwrap();
        let mut response = agent.run(request).unwrap();
        let status = response.status().as_u16();
        let mut bytes = vec![];
        response
            .body_mut()
            .as_reader()
            .read_to_end(&mut bytes)
            .unwrap();
        (status, bytes)
    })
    .await
    .unwrap()
}
async fn start_server(
    folder: &Path,
) -> (
    std::net::SocketAddr,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<anyhow::Result<()>>,
    Arc<Mutex<Hub>>,
) {
    let state = Domain::open(
        folder,
        "owner",
        "invite",
        "http://localhost".into(),
        None,
        vec![],
    )
    .unwrap();
    let hub = state.hub.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let folder = folder.to_owned();
    let udp = piik_channel_native::peer::server_udp::ServerUdp::bind(&[(address, None)]).unwrap();
    let task = tokio::spawn(serve(listener, state, folder, Router::new(), udp, async {
        let _ = stopped.await;
    }));
    (address, stop, task, hub)
}

#[tokio::test]
async fn http_and_https_share_a_domain_and_release_both_listeners_on_stop() {
    use crate::web::LanHttps;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let folder = std::env::temp_dir().join(format!("piik-domain-https-{}", Uuid::new_v4()));
    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_address = http.local_addr().unwrap();
    assert!(LanHttps::bind(http_address.ip(), http_address.port())
        .await
        .is_err());
    let https = LanHttps::bind(http_address.ip(), 0).await.unwrap();
    let https_address = https.listener.local_addr().unwrap();
    let invitation = https.origin().to_owned();
    let fingerprint = https.fingerprint();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(https.certificate.clone()).unwrap();
    let tls = Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    );
    let state = Domain::open(
        &folder,
        "owner",
        "invite",
        "http://localhost".into(),
        Some(invitation.clone()),
        vec![],
    )
    .unwrap();
    let identity = state.identity().0;
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(
        state.serve_with_https(http, Some(https), Router::new(), async {
            let _ = stopped.await;
        }),
    );
    let (mut owner, _, initial) = connect(http_address, "owner", "Owner").await;
    assert_eq!(initial.channel.id, identity);
    let mut request = format!("wss://{https_address}/prototype/channel")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", invitation.parse().unwrap());
    let (mut guest, _) = tokio_tungstenite::connect_async_tls_with_config(
        request,
        None,
        false,
        Some(tokio_tungstenite::Connector::Rustls(tls.clone())),
    )
    .await
    .unwrap();
    send_request(
        &mut guest,
        json!({"type":"join", "key":"invite", "name":"LAN guest"}),
    )
    .await;
    let Event::Welcome {
        state,
        invitation_origin,
        ..
    } = event(&mut guest).await
    else {
        panic!("authenticated HTTPS welcome")
    };
    assert_eq!(state.channel.id, identity);
    assert_eq!(state.sessions.len(), 2);
    assert_eq!(invitation_origin, Some(invitation));
    state_when(&mut owner, |state| state.sessions.len() == 2).await;

    // Trust only this runtime's exact certificate; verify its IP SAN and the
    // advertised fingerprint without changing system trust or skipping TLS.
    let mut stream = tokio_rustls::TlsConnector::from(tls)
        .connect(
            https_address.ip().into(),
            TcpStream::connect(https_address).await.unwrap(),
        )
        .await
        .unwrap();
    let served = &stream.get_ref().1.peer_certificates().unwrap()[0];
    let actual: String = ring::digest::digest(&ring::digest::SHA256, served.as_ref())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    assert_eq!(actual, fingerprint);
    stream
        .write_all(
            b"GET /api/client-launcher HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "LAN entry cannot expose local approval routes"
    );
    drop(stream);

    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    for socket in [&mut owner, &mut guest] {
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(frame) = socket.next().await {
                if matches!(frame.unwrap(), Message::Close(_)) {
                    return;
                }
            }
        })
        .await
        .expect("both entries retire their actual WebSocket owners");
    }
    let _http = TcpListener::bind(http_address).await.unwrap();
    let _https = TcpListener::bind(https_address).await.unwrap();
    std::fs::remove_dir_all(folder).unwrap();
}

#[tokio::test]
async fn invitation_origin_is_only_a_second_exact_http_entry() {
    let folder = std::env::temp_dir().join(format!("piik-domain-origins-{}", Uuid::new_v4()));
    let primary = "http://localhost";
    let invitation = "https://invite.example";
    let owner = Uuid::new_v4().to_string();
    assert!(Domain::open(
        &folder,
        &owner,
        "invite",
        format!("{primary}/path"),
        None,
        vec![]
    )
    .is_err());
    assert!(Domain::open(
        &folder,
        &owner,
        "invite",
        primary.into(),
        Some("https://user@invite.example".into()),
        vec![]
    )
    .is_err());
    assert!(
        !folder.exists(),
        "invalid entry configuration cannot initialize domain data"
    );
    let state = Domain::open(
        &folder,
        &owner,
        "invite",
        primary.into(),
        Some(invitation.into()),
        vec![],
    )
    .unwrap();
    assert_eq!(
        state.origin(),
        primary,
        "Native retains the primary connection origin"
    );
    let identity = state.identity().0;
    let hub = state.hub.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(state.serve(listener, Router::new(), async {
        let _ = stopped.await;
    }));
    let request = |origin: &str| {
        let mut request = format!("ws://{address}/prototype/channel")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
        request
    };
    let mut sockets = Vec::new();
    for (origin, key) in [(primary, owner.as_str()), (invitation, "invite")] {
        let (mut socket, _) = connect_async(request(origin)).await.unwrap();
        send_request(
            &mut socket,
            json!({"type":"join", "key":key, "name":"Entry user"}),
        )
        .await;
        let text = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match socket.next().await.unwrap().unwrap() {
                    Message::Text(text) => break text,
                    Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                    other => panic!("unexpected entry event: {other:?}"),
                }
            }
        })
        .await
        .unwrap();
        let welcome: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(welcome["type"], "welcome");
        assert_eq!(welcome["invitationOrigin"], invitation);
        assert_eq!(welcome["state"]["channel"]["id"], identity.to_string());
        assert_eq!(
            welcome["state"]["sessions"].as_array().unwrap().len(),
            sockets.len() + 1,
            "both entries share the same admitted domain"
        );
        assert!(
            !text.contains(&owner),
            "the actual Welcome never exposes the owner key"
        );
        sockets.push(socket);
    }
    assert!(
        matches!(connect_async(request("https://stranger.example")).await,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == 403)
    );
    let checkpoint = hub
        .lock()
        .unwrap()
        .storage
        .lock()
        .unwrap()
        .load()
        .unwrap()
        .unwrap();
    assert!(
        !checkpoint.to_string().contains(invitation),
        "the invitation address is not domain identity or room data"
    );
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(sockets);
    drop(hub);
    let restored = Domain::open(&folder, &owner, "invite", primary.into(), None, vec![]).unwrap();
    assert_eq!(restored.identity().0, identity);
    {
        let mut hub = restored.hub.lock().unwrap();
        let mut probe = Endpoint::connect(&mut hub);
        probe.request(
            &mut hub,
            json!({"type":"join", "key":owner, "name":"Restored owner"}),
        );
        let welcome = probe
            .drain()
            .into_iter()
            .find(|event| event["type"] == "welcome")
            .unwrap();
        assert!(
            welcome.get("invitationOrigin").is_none(),
            "without an override Welcome keeps its existing shape"
        );
    }
    drop(restored);
    std::fs::remove_dir_all(folder).unwrap();
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
    send_request(&mut admin, json!({"type":"update_room","icon":"couch", "roomId":"living", "name":"Saved living", "access":"private", "hidden":false, "password":"room-password"})).await;
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
        None,
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

#[tokio::test]
async fn room_backup_http_restores_native_history_and_reopens_named_imports() {
    use piik_channel_core::{backup::HistoryRow, history::StoredMessage, RoomBackup};
    use piik_channel_native::backup::{self, StagedBackup};
    use std::io::Cursor;
    let folder = tempfile::tempdir().unwrap();
    let (address, stop, task, hub) = start_server(folder.path()).await;
    let (mut owner, _, mut state, credential) =
        connect_with_credential(address, "owner", "Owner").await;
    if !state.channel.rooms.iter().all(|room| room.available) || state.channel.rooms.len() != 3 {
        state = state_when(&mut owner, |state| {
            state.channel.rooms.len() == 3 && state.channel.rooms.iter().all(|room| room.available)
        })
        .await;
    }
    let previous = state
        .channel
        .rooms
        .iter()
        .find(|room| room.id == "living")
        .unwrap()
        .delivery
        .as_ref()
        .unwrap()
        .binding_id;
    let (status, bytes) =
        room_backup_http(address, "/prototype/channel/hosting", &credential, None).await;
    assert_eq!(status, 200);
    let description: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        description["sessionId"],
        state.channel.rooms[0]
            .delivery
            .as_ref()
            .unwrap()
            .host_session_id
            .to_string()
    );
    assert_eq!(description["roomIds"], json!(["living", "quiet", "studio"]));
    assert_eq!(
        room_backup_http(
            address,
            "/prototype/channel/rooms/living/backup",
            "not-owner",
            None
        )
        .await
        .0,
        403
    );
    let (status, bytes) = room_backup_http(
        address,
        "/prototype/channel/rooms/living/backup",
        &credential,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let download = tempfile::tempdir().unwrap();
    let StagedBackup::Room { snapshot, content } =
        backup::stage(Cursor::new(bytes), download.path()).unwrap()
    else {
        panic!("room");
    };
    assert!(content.is_empty() && snapshot.metadata().retained_files.is_empty());
    assert_eq!(
        snapshot
            .metadata()
            .own_credential
            .as_ref()
            .unwrap()
            .credential,
        credential
    );
    let mut metadata = snapshot.metadata().clone();
    metadata.policy.name = "Restored living".into();
    let rows = (1..=55)
        .map(|seq| HistoryRow {
            nonce: format!("retained-{seq}"),
            message: StoredMessage {
                message: piik_channel_core::wire::ChatMessage {
                    id: Uuid::new_v4(),
                    seq,
                    user_id: metadata.policy.creator_id,
                    text: format!("Saved {seq}"),
                    time: seq,
                    attachments: vec![],
                },
                reactions: Default::default(),
            },
        })
        .collect::<Vec<_>>();
    let make = |metadata, path: &str| {
        let room = RoomBackup::stage(
            &folder.path().join(path),
            metadata,
            rows.iter().cloned().map(Ok),
        )
        .unwrap();
        let mut bytes = vec![];
        backup::write_room(
            &room,
            &[],
            &mut bytes,
            |_| -> anyhow::Result<std::fs::File> { unreachable!() },
        )
        .unwrap();
        bytes
    };
    send_request(
        &mut owner,
        json!({"type":"browse","roomId":"living","active":true}),
    )
    .await;
    state_when(&mut owner, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|room| room.id == "living" && room.reading)
    })
    .await;
    let (status, _) = room_backup_http(
        address,
        "/prototype/channel/rooms/backup",
        &credential,
        Some(make(metadata.clone(), "restore.sqlite")),
    )
    .await;
    assert_eq!(status, 200);
    let state = state_when(&mut owner, |state| {
        state.channel.rooms.iter().any(|room| {
            room.id == "living"
                && room.name == "Restored living"
                && room.available
                && !room.reading
                && room
                    .delivery
                    .as_ref()
                    .is_some_and(|delivery| delivery.binding_id != previous)
        })
    })
    .await;
    assert!(state.publications.is_empty() && state.voice.is_empty());
    assert_eq!(
        room_backup_http(
            address,
            "/prototype/channel/rooms/backup",
            &credential,
            Some(b"not a zip".to_vec())
        )
        .await
        .0,
        400
    );
    let (status, bytes) = room_backup_http(
        address,
        "/prototype/channel/rooms/living/backup",
        &credential,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let restored = tempfile::tempdir().unwrap();
    let StagedBackup::Room {
        snapshot: restored_room,
        ..
    } = backup::stage(Cursor::new(bytes), restored.path()).unwrap()
    else {
        panic!("room");
    };
    let mut actual = vec![];
    restored_room
        .for_each_row(|row| {
            actual.push(row);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(&rows).unwrap()
    );
    metadata.policy.id = "imported-room".into();
    assert_eq!(
        room_backup_http(
            address,
            "/prototype/channel/rooms/backup",
            &credential,
            Some(make(metadata, "named.sqlite"))
        )
        .await
        .0,
        200
    );
    state_when(&mut owner, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|room| room.id == "imported-room" && room.available)
    })
    .await;
    assert!(
        !folder.path().join("rooms/imported-room.sqlite").exists(),
        "room ID never chooses a filesystem path"
    );
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
    drop((owner, hub));
    let (address, stop, task, hub) = start_server(folder.path()).await;
    let (mut owner, _, state) = connect(address, "owner", "Owner").await;
    if !state
        .channel
        .rooms
        .iter()
        .any(|room| room.id == "imported-room" && room.available)
    {
        state_when(&mut owner, |state| {
            state
                .channel
                .rooms
                .iter()
                .any(|room| room.id == "imported-room" && room.available)
        })
        .await;
    }
    assert_eq!(
        room_backup_http(
            address,
            "/prototype/channel/rooms/imported-room/backup",
            &credential,
            None
        )
        .await
        .0,
        200
    );
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
    drop((owner, hub, snapshot, restored_room));
}
