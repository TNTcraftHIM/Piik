use super::*;
use serde_json::{json, Value};

struct Endpoint {
    id: Uuid,
    user: Uuid,
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
        endpoint
    }

    fn request(&self, hub: &mut Hub, command: Value) {
        hub.request(self.id, Request::parse(&command.to_string()).unwrap());
    }

    fn drain(&mut self) -> Vec<Value> {
        std::iter::from_fn(|| self.events.try_recv().ok())
            .map(|event| serde_json::to_value(event).unwrap())
            .collect()
    }
}

fn complete_host_turn(
    hub: &mut Hub,
    endpoint: &mut Endpoint,
    host: &mut piik_channel_prototype::host::RoomHost,
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
    use piik_channel_prototype::{host::RoomHost, wire::RoomAccess, RoomState};
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

#[test]
fn room_commit_owns_confirmation_retry_and_broadcast_without_domain_checkpoint() {
    let path = std::env::temp_dir().join(format!("piik-room-runtime-{}.sqlite", Uuid::new_v4()));
    let storage = storage::Storage::open(&path).unwrap();
    let mut hub = Hub {
        authority: Authority::new("owner".into(), "invite".into(), vec![]).unwrap(),
        clients: BTreeMap::new(),
        storage: Arc::new(Mutex::new(storage)),
    };
    let mut sender = Endpoint::join(&mut hub, "owner");
    let mut reader = Endpoint::join(&mut hub, "invite");
    reader.request(
        &mut hub,
        json!({"type":"browse", "active":true, "roomId":"living"}),
    );
    reader.drain();
    sender.drain();
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("CREATE TRIGGER reject_message BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();

    let sending = json!({"type":"chat", "roomId":"living", "text":"Hello", "nonce":"same-send", "requestId":"first"});
    sender.request(&mut hub, sending.clone());
    assert_eq!(
        sender.drain(),
        vec![json!({"type":"error", "code":"storage_failed", "requestId":"first"})]
    );
    assert!(reader.drain().is_empty());

    database
        .execute_batch("DROP TRIGGER reject_message;")
        .unwrap();
    sender.request(&mut hub, sending);
    let confirmed = sender.drain();
    assert_eq!(confirmed.len(), 2);
    assert_eq!(confirmed[0]["type"], "message_confirmed");
    assert_eq!(confirmed[0]["message"]["seq"], 1);
    assert_eq!(confirmed[1], json!({"type":"ack", "requestId":"first"}));
    assert_eq!(
        reader.drain(),
        vec![json!({"type":"message", "roomId":"living", "message":confirmed[0]["message"]})]
    );

    sender.request(
        &mut hub,
        json!({"type":"browse", "active":true, "roomId":"quiet"}),
    );
    sender.drain();
    reader.drain();
    database.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'metadata unavailable'); END;").unwrap();
    sender.request(&mut hub, json!({"type":"chat", "roomId":"living", "text":"Changed retry", "nonce":"same-send", "requestId":"retry"}));
    let retry = sender.drain();
    assert_eq!(retry[0]["message"], confirmed[0]["message"]);
    assert_eq!(retry[0]["requestId"], "retry");
    assert_eq!(retry[1], json!({"type":"ack", "requestId":"retry"}));
    assert!(
        reader.drain().is_empty(),
        "a retry must not rebroadcast an old message"
    );

    sender.request(&mut hub, json!({"type":"chat", "roomId":"quiet", "text":"Other room", "nonce":"same-send", "requestId":"second-room"}));
    let other = sender.drain();
    let other = other
        .iter()
        .find(|event| event["type"] == "message_confirmed")
        .unwrap();
    assert_eq!(other["message"]["seq"], 1);
    assert_ne!(other["message"]["id"], confirmed[0]["message"]["id"]);
    assert!(reader.drain().is_empty());

    reader.request(
        &mut hub,
        json!({"type":"history", "roomId":"living", "requestId":"read"}),
    );
    let history = reader.drain();
    assert_eq!(history[0]["messages"], json!([confirmed[0]["message"]]));
    assert_eq!(history[1], json!({"type":"ack", "requestId":"read"}));
    drop(database);
    drop(hub);
    std::fs::remove_file(path).unwrap();
}
