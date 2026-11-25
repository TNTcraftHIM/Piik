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
        endpoint.request(
            hub,
            json!({"type":"join", "ownerKey":(key!="invite").then_some(key), "name":"Friend"}),
        );
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
            command["canUsePeerTransport"] = json!(true);
            command["protocol"] = json!(piik_channel_core::wire::CHANNEL_PROTOCOL);
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
    let open = |owner| Domain::open(&folder, owner, "http://localhost".into(), None, vec![]);
    let domain = open("saved-owner").unwrap();
    let identity = domain.identity();
    drop(domain);
    let domain = open("different-owner").unwrap();
    assert_eq!(domain.identity(), identity);
    let old_checkpoint;
    {
        let mut hub = domain.hub.lock().unwrap();
        let owner = Endpoint::join(&mut hub, "saved-owner");
        assert_eq!(owner.user, identity.1);
        old_checkpoint = serde_json::to_value(hub.authority.export_state()).unwrap();
    }
    let in_flight = domain.hub.clone();
    drop(domain);
    let contender = Domain::open_with_options(
        &folder,
        "saved-owner",
        "http://localhost".into(),
        None,
        vec![],
        RoomCreationPolicy::Ordinary,
        Some(HostingMode::Lightweight),
    );
    assert!(
        matches!(contender, Err(error) if error.to_string() == "This channel data directory is already in use")
    );
    drop(in_flight);
    for owner_seed in ["different-owner", ""] {
        let reopened = open(owner_seed).unwrap();
        assert_eq!(reopened.identity(), identity);
        assert_eq!(reopened.owner_key(), "saved-owner");
        let state =
            serde_json::to_value(reopened.hub.lock().unwrap().authority.export_state()).unwrap();
        assert!(state.get("access").is_none());
        assert!(state.get("passwordHash").is_none());
        let mut hub = reopened.hub.lock().unwrap();
        let owner = Endpoint::join(&mut hub, "saved-owner");
        assert_eq!(owner.user, identity.1);
        let mut rejected = Endpoint::connect(&mut hub);
        rejected.request(
            &mut hub,
            json!({"type":"join", "name":"Wrong seed", "ownerKey":"different-owner"}),
        );
        assert!(rejected
            .drain()
            .iter()
            .any(|event| event["type"] == "error"));
    }
    let path = folder.join("channel.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    let body: String = db.query_row("SELECT body FROM checkpoint", [], |row| row.get(0)).unwrap();
    let mut checkpoint: Value = serde_json::from_str(&body).unwrap();
    checkpoint["state"]["hostedRooms"]["studio"] = json!({
        "id":"studio","name":"Studio","icon":"data:image/png;base64,iVBORw0KGgo=",
        "creatorId":identity.1,"access":"private","hidden":true,"hasPassword":false
    });
    for unsupported in [old_checkpoint, checkpoint] {
        db.execute("UPDATE checkpoint SET body=?1", [unsupported.to_string()]).unwrap();
        let original = std::fs::read(&path).unwrap();
        assert!(open("saved-owner")
            .err()
            .unwrap()
            .to_string()
            .contains("unsupported_domain_checkpoint"));
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
    db.execute("DELETE FROM checkpoint", []).unwrap();
    assert!(open("saved-owner").err().unwrap().to_string().contains("invalid_storage_schema"));
    drop(db);
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn previous_domain_sqlite_format_is_rejected_without_modification() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("channel.sqlite");
    let authority = Authority::new("old-owner".into(), vec![]).unwrap();
    let mut old = storage::Storage::open(&path).unwrap();
    old.save(&serde_json::to_value(authority.export_backup()).unwrap()).unwrap();
    drop(old);
    let original = std::fs::read(&path).unwrap();
    let result = Domain::open(directory.path(), "new-owner", "http://localhost".into(), None, vec![]);
    assert!(result.err().unwrap().to_string().contains("unsupported_storage_version"));
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn profile_storage_failure_preserves_the_shared_user_until_commit_and_reopen() {
    let folder = tempfile::tempdir().unwrap();
    let domain = Domain::open(
        folder.path(),
        "owner",
        "http://localhost".into(),
        None,
        vec![],
    )
    .unwrap();
    let avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    let user;
    let committed_profile;
    let read_profile = |hub: &mut Hub, endpoint: &mut Endpoint, user: Uuid| {
        endpoint.request(
            hub,
            json!({"type":"profiles","requestId":"read-profile","ids":[user]}),
        );
        endpoint
            .drain()
            .into_iter()
            .find(|event| event["type"] == "profiles")
            .unwrap()["profiles"][0]
            .clone()
    };
    {
        let mut hub = domain.hub.lock().unwrap();
        let mut owner = Endpoint::join(&mut hub, "owner");
        let mut observer = Endpoint::join(&mut hub, "invite");
        user = owner.user;
        owner.drain();
        observer.drain();
        let initial_profile = read_profile(&mut hub, &mut owner, user);
        let saved = serde_json::to_value(hub.storage.load().unwrap().unwrap()).unwrap();
        let failure = rusqlite::Connection::open(folder.path().join("channel.sqlite")).unwrap();
        failure.execute_batch("CREATE TRIGGER reject_profile BEFORE UPDATE ON domain_user BEGIN SELECT RAISE(ABORT,'held'); END;").unwrap();
        owner.request(&mut hub, json!({"type":"set_profile", "name":"New profile", "avatar":avatar, "requestId":"profile"}));
        let failed = owner.drain();
        assert!(failed.iter().any(|event| event["type"] == "error"
            && event["code"] == "storage_failed"
            && event["requestId"] == "profile"));
        assert!(!failed
            .iter()
            .any(|event| event["type"] == "ack" || event["type"] == "state"));
        assert!(observer.drain().is_empty());
        assert_eq!(serde_json::to_value(hub.storage.load().unwrap().unwrap()).unwrap(), saved);
        assert_eq!(hub.authority.owner_name(), Some("Friend"));
        assert_eq!(read_profile(&mut hub, &mut observer, user), initial_profile);
        failure
            .execute_batch("DROP TRIGGER reject_profile")
            .unwrap();
        owner.request(&mut hub, json!({"type":"set_profile", "name":"New profile", "avatar":avatar, "requestId":"retry"}));
        assert!(owner
            .drain()
            .iter()
            .any(|event| event["type"] == "ack" && event["requestId"] == "retry"));
        let summary = observer
            .drain()
            .into_iter()
            .find_map(|event| {
                (event["type"] == "state").then(|| {
                    event["state"]["users"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|entry| entry["id"] == user.to_string())
                        .unwrap()
                        .clone()
                })
            })
            .unwrap();
        assert_eq!(summary["name"], "New profile");
        assert!(summary.get("avatar").is_none());
        assert_ne!(summary["version"], initial_profile["version"]);
        committed_profile = read_profile(&mut hub, &mut observer, user);
        assert_eq!(committed_profile["name"], "New profile");
        assert_eq!(committed_profile["avatar"], avatar);
        assert_eq!(committed_profile["version"], summary["version"]);
    }
    drop(domain);
    let reopened =
        Domain::open(folder.path(), "", "http://localhost".into(), None, vec![]).unwrap();
    let mut hub = reopened.hub.lock().unwrap();
    let mut owner = Endpoint::join(&mut hub, "owner");
    assert_eq!(owner.user, user);
    assert_eq!(read_profile(&mut hub, &mut owner, user), committed_profile);
    let saved = serde_json::to_value(hub.authority.export_state()).unwrap();
    assert!(saved["users"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == user.to_string()
            && entry["name"] == "New profile"
            && entry["avatar"] == avatar));
}

#[test]
fn domain_metadata_requires_owner_and_commits_before_broadcast_then_reopens() {
    let path = std::env::temp_dir().join(format!("piik-domain-metadata-{}.sqlite", Uuid::new_v4()));
    let mut hub = Hub {
        launch_tickets: BTreeMap::new(),
        _directory_owner: None,
        authority: Authority::new("owner".into(), vec![]).unwrap(),
        clients: BTreeMap::new(),
        invitation_origin: None,
        room_commands: None,
        storage: storage::DomainStorage::open(&path).unwrap(),
    };
    hub.storage.save_header(&hub.authority).unwrap();
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
        serde_json::to_value(hub.storage.load().unwrap().unwrap()).unwrap()["state"],
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
    assert!(state["state"]["channel"].get("hasPassword").is_none());
    let _: piik_channel_core::wire::Snapshot =
        serde_json::from_value(state["state"].clone()).unwrap();
    drop(hub);
    let store = storage::DomainStorage::open(&path).unwrap();
    let mut restored = store.load().unwrap().unwrap()
        .into_authority(vec![])
        .unwrap();
    let saved = serde_json::to_value(restored.export_state()).unwrap();
    assert_eq!(saved["name"], "Friends");
    assert_eq!(saved["icon"], icon);
    assert!(saved.get("access").is_none());
    assert!(saved.get("passwordHash").is_none());
    let join=Request::parse(&json!({"type":"join","canUsePeerTransport":true,"protocol":piik_channel_core::wire::CHANNEL_PROTOCOL,
        "name":"Visitor","signingKey":piik_channel_core::conversation::SessionSigner::from_seed([1;32]).signing_key()}).to_string()).unwrap();
    assert!(restored
        .handle(Uuid::new_v4(), join, 1)
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Welcome { .. })));
    drop(store);
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn retired_or_closing_connections_cannot_execute_queued_requests() {
    let mut hub = Hub {
        launch_tickets: BTreeMap::new(),
        _directory_owner: None,
        authority: Authority::new("owner".into(), vec![]).unwrap(),
        clients: BTreeMap::new(),
        invitation_origin: None,
        room_commands: None,
        storage: storage::DomainStorage::open(Path::new(":memory:")).unwrap(),
    };
    hub.storage.save_header(&hub.authority).unwrap();
    let mut active = Endpoint::join(&mut hub, "owner");
    let mut retired = Endpoint::join(&mut hub, "invite");
    retired.request(&mut hub, json!({"type":"leave","requestId":"leaving"}));
    assert!(!hub.clients.contains_key(&retired.id));
    assert!(retired
        .drain()
        .iter()
        .any(|event| event["type"] == "ack" && event["requestId"] == "leaving"));
    let saved = serde_json::to_value(hub.authority.export_state()).unwrap();
    retired.request(&mut hub, json!({"type":"join","name":"Late join"}));
    assert_eq!(
        serde_json::to_value(hub.authority.export_state()).unwrap(),
        saved
    );
    active.drain();
    active.request(
        &mut hub,
        json!({"type":"set_profile","avatar":null,"name":"Active"}),
    );
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
        json!({"type":"set_profile","avatar":null,"name":"Closing command"}),
    );
    assert_eq!(
        serde_json::to_value(hub.authority.export_state()).unwrap(),
        saved
    );
    assert!(closing.drain().is_empty());
    active.drain();
    active.request(
        &mut hub,
        json!({"type":"set_profile","avatar":null,"name":"Still active","requestId":"active"}),
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
) -> piik_channel_core::host::HostOutput {
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
    output
}

#[test]
fn directory_save_failure_cannot_restore_a_room_hosts_revoked_flows() {
    use piik_channel_core::{
        host::{RoomHost, RoomResult},
        wire::{RoomAccess, VideoCeiling, VideoResolution},
        RoomState,
    };
    let directory_path =
        std::env::temp_dir().join(format!("piik-directory-failure-{}.sqlite", Uuid::new_v4()));
    let room_path =
        std::env::temp_dir().join(format!("piik-host-policy-{}.sqlite", Uuid::new_v4()));
    let directory_store = storage::DomainStorage::open(&directory_path).unwrap();
    let mut room_store = storage::Storage::open(&room_path).unwrap();
    let mut hub = Hub {
        launch_tickets: BTreeMap::new(),
        _directory_owner: None,
        authority: Authority::new("owner".into(), vec![]).unwrap(),
        clients: BTreeMap::new(),
        storage: directory_store,
        invitation_origin: None,
        room_commands: None,
    };
    hub.storage.save_header(&hub.authority).unwrap();
    let mut operator = Endpoint::join(&mut hub, "owner");
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
        json!({"type":"admit_room", "room":host.summary()}),
    );
    let admitted_users = serde_json::to_value(hub.authority.export_state()).unwrap()["users"]
        .as_array()
        .unwrap()
        .len();
    operator.request(
        &mut hub,
        json!({"type":"host_register", "room":host.summary()}),
    );
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    let publication = Uuid::new_v4();
    let ceiling = VideoCeiling {
        resolution: VideoResolution {
            width: 1280,
            height: 720,
        },
        max_framerate: 30.0,
        max_bitrate: 5_000_000,
    };
    operator.request(&mut hub, json!({"type":"publish", "publication":{"id":publication,"roomId":"hosted","kind":"screen","source":{"kind":"screen","name":null},"videoSettings":{"ceiling":ceiling,"degradationPreference":"balanced"}}}));
    let output = complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    assert!(matches!(output.reply.unwrap().result, RoomResult::Done));
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
    for endpoint in [&mut operator, &mut viewer] {
        endpoint.request(
            &mut hub,
            json!({"type":"link_state","pairId":pair,"state":"connected"}),
        );
    }
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    assert!(viewer.drain().iter().any(|event| event["type"] == "state"
        && event["state"]["pairs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["incoming"]
                .as_array()
                .unwrap()
                .iter()
                .any(|flow| flow["publicationId"] == publication.to_string()))));
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
        serde_json::to_value(hub.storage.load().unwrap().unwrap()).unwrap()["state"]["hostedRooms"]["hosted"]
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
            .any(|event| event["type"] == "ack" && event["requestId"] == "retired-path"),
        "retired signaling is acknowledged without restoring its revoked path"
    );
    let private = updates
        .iter()
        .find(|event| event["type"] == "state")
        .expect("committed room revocation must reach clients despite directory failure");
    assert!(private["state"]["pairs"]
        .as_array()
        .unwrap()
        .iter()
        .all(|pair| ["rooms", "incoming", "outgoing"]
            .iter()
            .all(|field| pair[*field].as_array().unwrap().is_empty())));
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

    // Site identity commits first. A later room grant has only its room storage owner.
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
    let mut failed = Endpoint::connect(&mut hub);
    failed.request(
        &mut hub,
        json!({"type":"join","name":"New visitor","requestId":"admission"}),
    );
    assert!(failed
        .drain()
        .iter()
        .any(|event| event["code"] == "storage_failed"));
    assert_eq!(
        serde_json::to_value(hub.authority.export_state()).unwrap()["users"]
            .as_array()
            .unwrap()
            .len(),
        admitted_users
    );
    database
        .execute_batch("DROP TRIGGER reject_checkpoint;")
        .unwrap();
    let mut invited = Endpoint::join(&mut hub, "invite");
    let recovered = serde_json::to_value(hub.storage.load().unwrap().unwrap()).unwrap();
    assert_eq!(recovered["state"]["hostedRooms"]["hosted"]["access"], "private");
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    database.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'metadata unavailable'); END;").unwrap();
    invited.request(
        &mut hub,
        json!({"type":"enter_room","roomId":"hosted","inviteKey":invitation,"requestId":"entry"}),
    );
    complete_host_turn(&mut hub, &mut operator, &mut host, &mut room_store);
    assert!(invited
        .drain()
        .iter()
        .any(|event| event["type"] == "room_reply"
            && event["requestId"] == "entry"
            && event["result"]["type"] == "done"));
    assert!(host.policy().grants.contains(&invited.user));
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

#[tokio::test]
async fn conversation_confirmation_keeps_healthy_readers_state_in_turn_order() {
    use piik_channel_core::{conversation::SessionSigner, wire::RoomAccess, StoredRoomHost};

    let folder = tempfile::tempdir().unwrap();
    let domain = Domain::open(
        folder.path(),
        "owner",
        "http://localhost".into(),
        None,
        vec![],
    )
    .unwrap();
    let (host, mut reader, mut observer, packet) = {
        let mut hub = domain.hub.lock().unwrap();
        let mut host = Endpoint::join(&mut hub, "owner");
        let mut reader = Endpoint::join(&mut hub, "invite");
        let mut observer = Endpoint::join(&mut hub, "invite");
        let policy = RoomState::new(
            "living".into(),
            "Living".into(),
            Default::default(),
            host.user,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap();
        let mut room = StoredRoomHost::create(Path::new(":memory:"), policy).unwrap();
        host.request(&mut hub, json!({"type":"admit_room","room":room.summary()}));
        host.request(
            &mut hub,
            json!({"type":"host_register","room":room.summary()}),
        );
        stored_turn(&mut hub, &mut host, &mut room);
        reader.request(
            &mut hub,
            json!({"type":"browse","roomId":"living","active":true}),
        );
        let binding = stored_turn(&mut hub, &mut host, &mut room);
        let packet = SessionSigner::from_seed([1;32]).sign(host.session, &json!({
            "roomId":"living","bindingId":binding,"sender":host.session,
            "recipient":reader.session,"requestId":"chat",
            "record":{"type":"confirmed","inserted":true,"message":{
                "id":Uuid::new_v4(),"seq":1,"userId":reader.user,"text":"Hello","time":1,"attachments":[]
            }}
        })).unwrap();
        reader.drain();
        observer.drain();
        // Keep this reader's writer paused until the next authority turn.
        let queue = &hub.clients[&reader.id].events;
        while queue.capacity() > 0 {
            queue
                .try_send(Event::Ack {
                    request_id: "queued".into(),
                })
                .unwrap();
        }
        (host, reader, observer, packet)
    };

    let request =
        Request::parse(&json!({"type":"conversation","packet":packet}).to_string()).unwrap();
    let confirmation = dispatch_request(&domain, host.id, request);
    tokio::pin!(confirmation);
    let completed = confirmation.as_mut().now_or_never().is_some();
    observer.request(
        &mut domain.hub.lock().unwrap(),
        json!({"type":"set_profile","avatar":null,"name":"Updated"}),
    );
    reader.drain();
    if !completed {
        confirmation.await;
    }
    let names: Vec<_> = std::iter::from_fn(|| observer.events.try_recv().ok())
        .filter_map(|event| match event {
            Event::State { state } => state
                .users
                .into_iter()
                .find(|user| user.id == observer.user)
                .map(|user| user.name),
            _ => None,
        })
        .collect();
    assert_eq!(names, ["Friend", "Updated"]);
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
    let state = Domain::open(&folder, "owner", "http://localhost".into(), None, vec![]).unwrap();
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
                json!({"type":"admit_room", "room":host.summary()}),
            );
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
        mentions: vec![],
        reply: None,
        inline_images: Default::default(),
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
            .query_row("SELECT count(*) FROM sqlite_schema WHERE name='message'", [], |row| row
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
        value["canUsePeerTransport"] = json!(true);
        value["protocol"] = json!(piik_channel_core::wire::CHANNEL_PROTOCOL);
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
    join_with_credential(address, key, name, None).await
}
async fn join_with_credential(
    address: std::net::SocketAddr,
    key: &str,
    name: &str,
    credential: Option<&str>,
) -> (Socket, Uuid, Snapshot, String) {
    let mut request = format!("ws://{address}/prototype/channel")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "http://localhost".parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    send_request(
        &mut socket,
        json!({"type":"join", "ownerKey":(key!="invite").then_some(key), "name":name, "credential":credential}),
    )
    .await;
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
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let response = client
        .request(
            if upload.is_some() {
                reqwest::Method::PUT
            } else {
                reqwest::Method::GET
            },
            format!("http://{address}{path}"),
        )
        .bearer_auth(credential)
        .header("Content-Type", "application/zip")
        .body(upload.unwrap_or_default())
        .send()
        .await
        .unwrap();
    (
        response.status().as_u16(),
        response.bytes().await.unwrap().to_vec(),
    )
}
async fn start_server(
    folder: &Path,
) -> (
    std::net::SocketAddr,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<anyhow::Result<()>>,
    Arc<Mutex<Hub>>,
) {
    let state = Domain::open_with_options(
        folder,
        "owner",
        "http://localhost".into(),
        None,
        vec![],
        Default::default(),
        Some(Default::default()),
    )
    .unwrap();
    let hub = state.hub.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let folder = folder.to_owned();
    // A free TCP port does not reserve the same port for UDP in parallel tests.
    let udp = piik_channel_native::peer::server_udp::ServerUdp::bind(&[(
        std::net::SocketAddr::new(address.ip(), 0),
        None,
    )])
    .unwrap();
    let task = tokio::spawn(serve(
        listener,
        state,
        folder,
        Router::new(),
        udp,
        None,
        async {
            let _ = stopped.await;
        },
    ));
    (address, stop, task, hub)
}

#[tokio::test]
async fn wildcard_listeners_host_native_rooms_and_retire_on_stop() {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    for (bind, dial) in [
        (
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ),
        (
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ),
    ] {
        let folder = tempfile::tempdir().unwrap();
        let domain = Domain::open(
            folder.path(),
            "owner",
            "http://localhost".into(),
            None,
            vec![],
        )
        .unwrap();
        let listener = TcpListener::bind(SocketAddr::new(bind, 0)).await.unwrap();
        let bound = listener.local_addr().unwrap();
        assert!(bound.ip().is_unspecified());
        let address = SocketAddr::new(dial, bound.port());
        let udp = piik_channel_native::peer::server_udp::ServerUdp::bind(&[(
            SocketAddr::new(dial, 0),
            None,
        )])
        .unwrap();
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(serve(
            listener,
            domain,
            folder.path().to_owned(),
            Router::new(),
            udp,
            None,
            async {
                let _ = stopped.await;
            },
        ));
        let (mut socket, own_session, initial) = connect(address, "owner", "Owner").await;
        let ready = |state: &Snapshot| {
            state.channel.rooms.len() == 3 && state.channel.rooms.iter().all(|room| room.available)
        };
        let state = if ready(&initial) {
            initial
        } else {
            state_when(&mut socket, ready).await
        };
        let host = state.channel.rooms[0]
            .delivery
            .as_ref()
            .unwrap()
            .host_session_id;
        assert_ne!(host, own_session);
        stop.send(()).unwrap();
        state_when(&mut socket, |state| {
            !state.sessions.iter().any(|session| session.id == host)
                && state.channel.rooms.iter().all(|room| !room.available)
        })
        .await;
        tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            TcpListener::bind(bound).await.is_ok(),
            "public listener must be released"
        );
    }
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
    send_request(&mut guest, json!({"type":"join", "name":"LAN guest"})).await;
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
    assert!(Domain::open(&folder, &owner, format!("{primary}/path"), None, vec![]).is_err());
    assert!(Domain::open(
        &folder,
        &owner,
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
            json!({"type":"join", "ownerKey":(key!="invite").then_some(key), "name":"Entry user"}),
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
        .load()
        .unwrap()
        .unwrap();
    assert!(
        !serde_json::to_string(&checkpoint).unwrap().contains(invitation),
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
    let restored = Domain::open(&folder, &owner, primary.into(), None, vec![]).unwrap();
    assert_eq!(restored.identity().0, identity);
    {
        let mut hub = restored.hub.lock().unwrap();
        let mut probe = Endpoint::connect(&mut hub);
        probe.request(
            &mut hub,
            json!({"type":"join", "ownerKey":owner, "name":"Restored owner"}),
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
async fn websocket_history_crosses_the_bounded_queue_without_a_media_pair() {
    use piik_channel_core::conversation::{
        ConversationAddress, ConversationCommand, ConversationRecord, ConversationReply,
        ConversationRequest, SessionSigner,
    };
    let folder = tempfile::tempdir().unwrap();
    let (address, stop, task, _) = start_server(folder.path()).await;
    let (mut socket, session, initial) = connect(address, "owner", "Reader").await;
    let state = if initial
        .channel
        .rooms
        .iter()
        .any(|room| room.id == "living" && room.available)
    {
        initial
    } else {
        state_when(&mut socket, |state| {
            state
                .channel
                .rooms
                .iter()
                .any(|room| room.id == "living" && room.available)
        })
        .await
    };
    let delivery = state
        .channel
        .rooms
        .iter()
        .find(|room| room.id == "living")
        .unwrap()
        .delivery
        .clone()
        .unwrap();
    let host_key = state
        .sessions
        .iter()
        .find(|peer| peer.id == delivery.host_session_id)
        .unwrap()
        .signing_key;
    send_request(
        &mut socket,
        json!({"type":"browse", "roomId":"living", "active":true}),
    )
    .await;
    let state = state_when(&mut socket, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|room| room.id == "living" && room.reading)
    })
    .await;
    assert!(
        state.pairs.iter().all(|pair| pair.rooms.is_empty()
            && pair.incoming.is_empty()
            && pair.outgoing.is_empty()),
        "reading history requires no room data grant or media flow"
    );
    let signer = SessionSigner::from_seed([1; 32]);
    for index in 0..50 {
        let request_id = format!("message-{index}");
        let packet = signer
            .sign(
                session,
                &ConversationRequest {
                    address: ConversationAddress {
                        room_id: "living".into(),
                        binding_id: delivery.binding_id,
                        sender: session,
                        recipient: delivery.host_session_id,
                        request_id: request_id.clone(),
                    },
                    command: ConversationCommand::Chat {
                        mentions: vec![],
                        reply: None,
                        inline_images: Default::default(),
                        text: format!("Saved message {index}"),
                        nonce: request_id.clone(),
                        attachments: vec![],
                    },
                },
            )
            .unwrap();
        send_request(&mut socket, json!({"type":"conversation", "packet":packet})).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match event(&mut socket).await {
                    Event::Conversation { packet } => {
                        let reply = ConversationReply::verify(&packet, host_key).unwrap();
                        if reply.address.request_id == request_id
                            && matches!(reply.record, ConversationRecord::Confirmed { .. })
                        {
                            break;
                        }
                    }
                    Event::Error { code, .. } => panic!("conversation failed: {code}"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
    }
    let packet = signer
        .sign(
            session,
            &ConversationRequest {
                address: ConversationAddress {
                    room_id: "living".into(),
                    binding_id: delivery.binding_id,
                    sender: session,
                    recipient: delivery.host_session_id,
                    request_id: "page".into(),
                },
                command: ConversationCommand::History { before: None },
            },
        )
        .unwrap();
    send_request(&mut socket, json!({"type":"conversation", "packet":packet})).await;
    let (mut messages, mut reactions, mut frames) = (0, 0, 0);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match event(&mut socket).await {
                Event::Conversation { packet } => {
                    let reply = ConversationReply::verify(&packet, host_key).unwrap();
                    if reply.address.request_id != "page" {
                        continue;
                    }
                    frames += 1;
                    match reply.record {
                        ConversationRecord::HistoryMessage { .. } => messages += 1,
                        ConversationRecord::MessageReactions { .. } => reactions += 1,
                        ConversationRecord::HistoryEnd { count, .. } => {
                            assert_eq!(count, 50);
                            break;
                        }
                        _ => panic!("unexpected history record"),
                    }
                }
                Event::Error { code, .. } => panic!("history failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!((frames, messages, reactions), (101, 50, 50));
    send_request(
        &mut socket,
        json!({"type":"set_profile","avatar":null, "name":"Still connected"}),
    )
    .await;
    state_when(&mut socket, |state| {
        state
            .users
            .iter()
            .any(|user| user.name == "Still connected")
    })
    .await;
    socket.close(None).await.unwrap();
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
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
    let query = json!({"type":"room_topology", "roomId":"living", "requestId":"topology"});
    let checkpoint = serde_json::to_value(hub.lock().unwrap().authority.export_backup()).unwrap();
    assert!(!hub
        .lock()
        .unwrap()
        .authority
        .changes_metadata(Uuid::nil(), &Request::parse(&query.to_string()).unwrap()));
    admin
        .send(Message::Text(query.to_string().into()))
        .await
        .unwrap();
    let topology = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Event::RoomReply {
                request_id,
                result: piik_channel_core::host::RoomResult::Topology { topology },
                ..
            } = event(&mut admin).await
            {
                assert_eq!(request_id.as_deref(), Some("topology"));
                break topology;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        topology.binding_id,
        initial.channel.rooms[0]
            .delivery
            .as_ref()
            .unwrap()
            .binding_id
    );
    assert!(topology.pairs.iter().all(|pair| {
        topology.session_ids.contains(&pair.first) && topology.session_ids.contains(&pair.second)
    }));
    assert!(topology.screen.is_none());
    assert_eq!(
        serde_json::to_value(hub.lock().unwrap().authority.export_backup()).unwrap(),
        checkpoint
    );
    let owner = initial
        .sessions
        .iter()
        .find(|session| session.id == native)
        .unwrap()
        .user_id;
    let rooms = crate::room_directory(&folder, (initial.channel.id, owner));
    assert!(initial
        .channel
        .rooms
        .iter()
        .all(|room| room.creator_id == owner && room.capabilities.attachments));
    send_request(
        &mut admin,
        json!({"type":"set_profile","avatar":null, "name":"Owner renamed"}),
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
        send_request(
            &mut admin,
            json!({"type":"voice", "roomId":room,
            "joined":true, "muted":true, "deafened":false}),
        )
        .await;
    }
    state_when(&mut admin, |state| {
        ["living", "studio"].iter().all(|id| {
            state
                .channel
                .rooms
                .iter()
                .any(|room| room.id == *id && room.reading)
        })
    })
    .await;
    send_request(
        &mut admin,
        json!({"type":"browse", "roomId":"living", "active":false}),
    )
    .await;
    send_request(
        &mut admin,
        json!({"type":"voice", "roomId":"living",
        "joined":false, "muted":true, "deafened":false}),
    )
    .await;
    let remaining = state_when(&mut admin, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|room| room.id == "living" && !room.reading)
            && state
                .channel
                .rooms
                .iter()
                .any(|room| room.id == "studio" && room.reading)
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
            json!({"type":"join", "ownerKey":"owner", "name":"Owner renamed"}),
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
            .open(rooms.join(format!("{id}.sqlite.lock")))
            .unwrap();
        lock.try_lock()
            .expect("stopped service releases the runtime lock");
    }
    let saved = StoredRoomHost::open(&rooms.join("living.sqlite")).unwrap();
    assert_eq!(saved.policy().name, "Saved living");
    assert!(saved.policy().access == RoomAccess::Private);
    assert!(saved.policy().grants.contains(&guest_user));
    drop(saved);
    let restored = Domain::open(&folder, "owner", "http://localhost".into(), None, vec![]).unwrap();
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

use piik_channel_core::conversation::{
    ConversationAddress, ConversationCommand, ConversationRecord, ConversationReply,
    ConversationRequest, SessionSigner,
};

async fn room_conversation(
    socket: &mut Socket,
    session: Uuid,
    state: &Snapshot,
    room_id: &str,
    command: ConversationCommand,
) -> Vec<ConversationRecord> {
    let delivery = state
        .channel
        .rooms
        .iter()
        .find(|room| room.id == room_id)
        .unwrap()
        .delivery
        .as_ref()
        .unwrap();
    let key = state
        .sessions
        .iter()
        .find(|peer| peer.id == delivery.host_session_id)
        .unwrap()
        .signing_key;
    let request_id = Uuid::new_v4().to_string();
    let packet = SessionSigner::from_seed([1; 32])
        .sign(
            session,
            &ConversationRequest {
                address: ConversationAddress {
                    room_id: room_id.into(),
                    binding_id: delivery.binding_id,
                    sender: session,
                    recipient: delivery.host_session_id,
                    request_id: request_id.clone(),
                },
                command,
            },
        )
        .unwrap();
    send_request(socket, json!({"type":"conversation", "packet":packet})).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut records = vec![];
        loop {
            match event(socket).await {
                Event::Conversation { packet } => {
                    let reply = ConversationReply::verify(&packet, key).unwrap();
                    if reply.address.request_id != request_id {
                        continue;
                    }
                    assert!(!matches!(reply.record, ConversationRecord::Error { .. }));
                    let finished = matches!(
                        reply.record,
                        ConversationRecord::Confirmed { .. }
                            | ConversationRecord::HistoryEnd { .. }
                    );
                    records.push(reply.record);
                    if finished {
                        return records;
                    }
                }
                Event::Error { code, .. } => panic!("conversation failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn hosted_private_room_keeps_its_manager_grants_and_history_on_service_restart() {
    use piik_channel_core::wire::{HostingMode, RoomCreationPolicy};
    let folder = tempfile::tempdir().unwrap();
    drop(
        Domain::open_with_options(
            folder.path(),
            "owner",
            "http://localhost".into(),
            None,
            vec![],
            RoomCreationPolicy::Ordinary,
            Some(HostingMode::Hosted),
        )
        .unwrap(),
    );
    let (address, stop, task, _) = start_server(folder.path()).await;
    let (mut operator, operator_session, _, operator_credential) =
        connect_with_credential(address, "owner", "Operator").await;
    let (mut creator, creator_session, _, creator_credential) =
        connect_with_credential(address, "invite", "Manager").await;
    send_request(
        &mut creator,
        json!({"type":"create_room","room":{"id":"new","name":"Hidden guest room","icon":"couch",
        "creatorId":Uuid::nil(),"access":"private","hidden":true,"hasPassword":false}}),
    )
    .await;
    let room = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match event(&mut creator).await {
                Event::RoomCreated { room, .. } => break room,
                Event::Error { code, .. } => panic!("creation failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    send_request(&mut creator, json!({"type":"room_invite","roomId":room.id})).await;
    let invite = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match event(&mut creator).await {
                Event::RoomInvite { key, .. } => break key,
                Event::Error { code, .. } => panic!("invite failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let (mut reader, session, initial, credential) =
        connect_with_credential(address, "invite", "Reader").await;
    assert!(!initial.channel.rooms.iter().any(|r| r.id == room.id));
    send_request(
        &mut reader,
        json!({"type":"enter_room","roomId":room.id,"inviteKey":invite}),
    )
    .await;
    let readable = |state: &Snapshot| {
        state
            .channel
            .rooms
            .iter()
            .any(|r| r.id == room.id && r.authorized && r.available && !r.can_manage)
    };
    let initial = state_when(&mut reader, readable).await;
    assert_ne!(creator_session, operator_session);
    assert_ne!(creator_credential, operator_credential);
    assert_ne!(credential, creator_credential);
    assert_ne!(credential, operator_credential);
    let room_backup_path = format!("/prototype/channel/rooms/{}/backup", room.id);
    let (status, archive) =
        room_backup_http(address, &room_backup_path, &creator_credential, None).await;
    assert_eq!(status, 200, "{:?}", String::from_utf8_lossy(&archive));
    for unauthorized in [&credential, &operator_credential] {
        assert_eq!(
            room_backup_http(address, &room_backup_path, unauthorized, None)
                .await
                .0,
            403
        );
        assert_eq!(
            room_backup_http(address, &room_backup_path, unauthorized, Some(Vec::new()))
                .await
                .0,
            403
        );
    }
    send_request(
        &mut creator,
        json!({"type":"create_room","room":{"id":"other","name":"Other guest room","icon":"couch",
        "creatorId":Uuid::nil(),"access":"public","hidden":false,"hasPassword":false}}),
    )
    .await;
    let other_room = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match event(&mut creator).await {
                Event::RoomCreated { room, .. } => break room,
                Event::Error { code, .. } => panic!("creation failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let other_backup_path = format!("/prototype/channel/rooms/{}/backup", other_room.id);
    state_when(&mut creator, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|room| room.id == other_room.id && room.available)
    })
    .await;
    let (status, wrong_room) =
        room_backup_http(address, &other_backup_path, &creator_credential, None).await;
    assert_eq!(status, 200);
    let (status, response) = room_backup_http(
        address,
        &room_backup_path,
        &creator_credential,
        Some(wrong_room),
    )
    .await;
    assert_eq!(status, 409, "{:?}", String::from_utf8_lossy(&response));
    assert_eq!(
        serde_json::from_slice::<Value>(&response).unwrap()["error"],
        "backup_room_mismatch"
    );
    let (status, response) = room_backup_http(
        address,
        &room_backup_path,
        &creator_credential,
        Some(archive),
    )
    .await;
    assert_eq!(status, 200, "{:?}", String::from_utf8_lossy(&response));
    for path in ["/prototype/channel/backup", "/prototype/channel/hosting"] {
        assert_eq!(
            room_backup_http(address, path, &creator_credential, None)
                .await
                .0,
            403
        );
    }
    let (status, domain_archive) = room_backup_http(
        address,
        "/prototype/channel/backup",
        &operator_credential,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        room_backup_http(
            address,
            "/prototype/channel/backup",
            &creator_credential,
            Some(domain_archive)
        )
        .await
        .0,
        403
    );
    send_request(&mut operator, json!({"type":"leave"})).await;
    assert_ne!(
        initial
            .channel
            .rooms
            .iter()
            .find(|r| r.id == room.id)
            .unwrap()
            .delivery
            .as_ref()
            .unwrap()
            .host_session_id,
        creator_session
    );
    send_request(&mut creator, json!({"type":"leave"})).await;
    state_when(&mut reader, |s| {
        readable(s) && !s.sessions.iter().any(|e| e.id == creator_session)
    })
    .await;
    send_request(
        &mut reader,
        json!({"type":"browse","roomId":room.id,"active":true}),
    )
    .await;
    let state = state_when(&mut reader, |s| {
        s.channel.rooms.iter().any(|r| r.id == room.id && r.reading)
    })
    .await;
    let sent = room_conversation(
        &mut reader,
        session,
        &state,
        &room.id,
        ConversationCommand::Chat {
            text: "After manager left".into(),
            nonce: "reader-1".into(),
            mentions: vec![],
            reply: None,
            attachments: vec![],
            inline_images: Default::default(),
        },
    )
    .await;
    assert!(matches!(&sent[0], ConversationRecord::Confirmed { message, .. } if message.seq == 1));
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
    let (address, stop, task, _) = start_server(folder.path()).await;
    let (mut reader, session, initial, _) =
        join_with_credential(address, "invite", "Reader", Some(&credential)).await;
    if !readable(&initial) {
        state_when(&mut reader, readable).await;
    }
    send_request(
        &mut reader,
        json!({"type":"browse","roomId":room.id,"active":true}),
    )
    .await;
    let state = state_when(&mut reader, |s| {
        s.channel.rooms.iter().any(|r| r.id == room.id && r.reading)
    })
    .await;
    let history = room_conversation(
        &mut reader,
        session,
        &state,
        &room.id,
        ConversationCommand::History { before: None },
    )
    .await;
    assert!(history.iter().any(|r| matches!(r, ConversationRecord::HistoryMessage {message} if message.text == "After manager left")));
    let (_, _, stranger) = connect(address, "invite", "Stranger").await;
    assert!(!stranger.channel.rooms.iter().any(|r| r.id == room.id));
    let (mut operator, _, state) = connect(address, "owner", "Operator").await;
    assert!(!state.channel.rooms.iter().any(|r| r.id == room.id));
    send_request(
        &mut operator,
        json!({"type":"set_room_creation_policy","policy":"owner_only"}),
    )
    .await;
    state_when(&mut operator, |s| {
        s.channel.room_creation_policy == RoomCreationPolicy::OwnerOnly
    })
    .await;
    let database = crate::room_directory(
        folder.path(),
        (state.channel.id, state.channel.owner_id.unwrap()),
    )
    .join(format!("{}.sqlite", room.id));
    let failure = rusqlite::Connection::open(&database).unwrap();
    failure.execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON checkpoint BEGIN SELECT RAISE(ABORT,'held'); END;").unwrap();
    let remove = json!({"type":"delete_room","roomId":room.id,"deleteData":false,"requestId":"remove-private"});
    operator
        .send(Message::Text(remove.to_string().into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match event(&mut operator).await {
                Event::Error { code, request_id }
                    if request_id.as_deref() == Some("remove-private") =>
                {
                    assert_eq!(code, "storage_failed");
                    break;
                }
                Event::RoomReply { .. } => panic!("confirmed a failed deletion"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        failure
            .query_row("SELECT COUNT(*) FROM message", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
    let (address, stop, task, _) = start_server(folder.path()).await;
    let (mut operator, _, state) = connect(address, "owner", "Operator").await;
    assert!(state.channel.managed_room_ids.contains(&room.id));
    assert!(state.channel.rooms.iter().all(|entry| entry.id != room.id));
    let (_, _, stranger) = connect(address, "invite", "Stranger").await;
    assert!(stranger.channel.managed_room_ids.is_empty());
    assert!(stranger
        .channel
        .rooms
        .iter()
        .all(|entry| entry.id != room.id));
    failure.execute_batch("DROP TRIGGER refuse_delete").unwrap();
    // The room database may commit before the directory can acknowledge it.
    let directory_fault = rusqlite::Connection::open(folder.path().join("channel.sqlite")).unwrap();
    directory_fault
        .execute_batch(
            "CREATE TRIGGER refuse_cleanup BEFORE UPDATE ON checkpoint
         WHEN json_type(OLD.body,'$.state.pendingRoomDeletions') IS NOT NULL
          AND json_type(NEW.body,'$.state.pendingRoomDeletions') IS NULL
         BEGIN SELECT RAISE(ABORT,'held'); END;",
        )
        .unwrap();
    send_request(&mut operator, remove.clone()).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match event(&mut operator).await {
                Event::Error { code, .. } => {
                    assert_eq!(code, "storage_failed");
                    break;
                }
                Event::RoomReply { .. } => panic!("confirmed an uncommitted directory removal"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(storage::Storage::open_existing(&database)
        .unwrap()
        .load()
        .unwrap()
        .is_none());
    directory_fault
        .execute_batch("DROP TRIGGER refuse_cleanup")
        .unwrap();
    send_request(&mut operator, remove).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match event(&mut operator).await {
                Event::RoomReply {
                    result: piik_channel_core::host::RoomResult::Deleted { data_removed },
                    ..
                } => {
                    assert!(data_removed);
                    break;
                }
                Event::Error { code, .. } => panic!("retirement failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        failure
            .query_row("SELECT COUNT(*) FROM message", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let (_, _, state) = connect(address, "owner", "Operator").await;
    assert!(!state.channel.managed_room_ids.contains(&room.id));
    assert!(storage::Storage::open_existing(&database)
        .unwrap()
        .load()
        .unwrap()
        .is_none());
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn invalid_room_storage_keeps_sibling_chat_and_http_available_and_recovers_after_repair() {
    use piik_channel_core::{
        history::{HistoryRequest, MessageDraft},
        storage::Storage,
        wire::RoomAccess,
        RoomState, StoredRoomHost,
    };

    for damage in [
        "locked",
        "empty",
        "corrupt",
        "unsupported",
        "invalid_json",
        "invalid_policy",
        "missing_history",
        "duplicate_id",
        "late_duplicate",
    ] {
        let folder = tempfile::tempdir().unwrap();
        let domain = Domain::open(
            folder.path(),
            "owner",
            "http://localhost".into(),
            None,
            vec![],
        )
        .unwrap();
        let identity = domain.identity();
        let rooms = crate::room_directory(folder.path(), identity);
        std::fs::create_dir_all(&rooms).unwrap();
        {
            let mut hub = domain.hub.lock().unwrap();
            let owner = Endpoint::join(&mut hub, "owner");
            for id in ["healthy", "damaged"] {
                let path = rooms.join(format!("{id}.sqlite"));
                let room = StoredRoomHost::create(
                    &path,
                    RoomState::new(
                        id.into(),
                        id.into(),
                        Default::default(),
                        identity.1,
                        RoomAccess::Public,
                        false,
                        None,
                    )
                    .unwrap(),
                )
                .unwrap();
                owner.request(
                    &mut hub,
                    json!({"type":"admit_room", "room":room.summary()}),
                );
                drop(room);
                Storage::open(&path)
                    .unwrap()
                    .history(&HistoryRequest::Send {
                        room_id: id.into(),
                        draft: MessageDraft::new(
                            identity.1,
                            "before-restart".into(),
                            "Retained history".into(),
                            vec![],
                            Default::default(),
                            vec![],
                            None,
                            1,
                        )
                        .unwrap(),
                    })
                    .unwrap();
            }
        }
        drop(domain);
        let damaged = rooms.join("damaged.sqlite");
        let original = std::fs::read(&damaged).unwrap();
        let mut room_lock = None;
        let duplicate = rooms.join("another-name.sqlite");
        if damage == "late_duplicate" {
            std::fs::write(&damaged, b"unreadable checkpoint").unwrap();
        } else if damage == "duplicate_id" {
            std::fs::copy(&damaged, &duplicate).unwrap();
        } else if damage == "locked" {
            let lock = std::fs::File::create(damaged.with_added_extension("lock")).unwrap();
            lock.try_lock().unwrap();
            room_lock = Some(lock);
        } else if damage == "empty" {
            std::fs::write(&damaged, b"").unwrap();
        } else if damage == "corrupt" {
            std::fs::write(&damaged, b"not a SQLite database").unwrap();
        } else {
            let db = rusqlite::Connection::open(&damaged).unwrap();
            match damage {
                "unsupported" => db.execute_batch("PRAGMA user_version=7;").unwrap(),
                "invalid_json" => {
                    db.execute("UPDATE checkpoint SET body='{'", []).unwrap();
                }
                "invalid_policy" => {
                    let body: String = db
                        .query_row("SELECT body FROM checkpoint", [], |row| row.get(0))
                        .unwrap();
                    let mut policy: Value = serde_json::from_str(&body).unwrap();
                    policy["relayCapacity"] = json!(0);
                    db.execute("UPDATE checkpoint SET body=?1", [policy.to_string()])
                        .unwrap();
                }
                "missing_history" => db.execute_batch("DROP TABLE message;").unwrap(),
                _ => unreachable!(),
            }
        }
        let expected_bytes = if damage == "late_duplicate" { original.clone() } else { std::fs::read(&damaged).unwrap() };
        for repaired in [false, true] {
            if repaired {
                if matches!(damage, "duplicate_id" | "late_duplicate") {
                    assert_eq!(std::fs::read(&duplicate).unwrap(), original);
                    std::fs::remove_file(&duplicate).unwrap();
                } else if damage == "locked" {
                    drop(room_lock.take());
                } else {
                    std::fs::write(&damaged, &original).unwrap();
                }
            }
            let (address, stop, task, hub) = start_server(folder.path()).await;
            let (mut socket, session, initial, credential) =
                connect_with_credential(address, "owner", "Owner").await;
            let ready = |state: &Snapshot| {
                state.channel.rooms.len() == 2
                    && state
                        .channel
                        .rooms
                        .iter()
                        .all(|room| room.available == (room.id == "healthy" || repaired))
            };
            let state = if ready(&initial) {
                initial
            } else {
                state_when(&mut socket, ready).await
            };
            assert_eq!(
                state
                    .channel
                    .rooms
                    .iter()
                    .find(|room| room.id == "damaged")
                    .unwrap()
                    .creator_id,
                identity.1
            );
            assert_eq!(
                room_backup_http(address, "/healthz", &credential, None)
                    .await
                    .0,
                200
            );
            send_request(
                &mut socket,
                json!({"type":"browse", "roomId":"healthy", "active":true}),
            )
            .await;
            let state = state_when(&mut socket, |state| {
                state
                    .channel
                    .rooms
                    .iter()
                    .any(|room| room.id == "healthy" && room.reading)
            })
            .await;
            if matches!(damage, "duplicate_id" | "late_duplicate") && !repaired {
                if damage == "late_duplicate" {
                    std::fs::write(&damaged, &original).unwrap();
                    std::fs::write(&duplicate, &original).unwrap();
                }
                let commands = hub.lock().unwrap().room_commands.clone().unwrap();
                let (result, reply) = tokio::sync::oneshot::channel();
                commands.send(piik_channel_native::session::HostCommand::DeleteRetired {
                    id: "damaged".into(),
                    creator: identity.1,
                    result,
                }).await.unwrap();
                assert!(!reply.await.unwrap(), "ambiguous files must both survive");
            }
            let expected = if repaired { 3 } else { 2 };
            let sent = room_conversation(
                &mut socket,
                session,
                &state,
                "healthy",
                ConversationCommand::Chat {
                    mentions: vec![],
                    reply: None,
                    inline_images: Default::default(),
                    text: format!("Healthy {expected}"),
                    nonce: format!("healthy-{expected}"),
                    attachments: vec![],
                },
            )
            .await;
            assert!(
                matches!(&sent[0], ConversationRecord::Confirmed { message, .. } if message.seq == expected)
            );
            let history = room_conversation(
                &mut socket,
                session,
                &state,
                "healthy",
                ConversationCommand::History { before: None },
            )
            .await;
            assert!(history.iter().any(|record| matches!(record, ConversationRecord::HistoryMessage { message } if message.text == "Retained history")));
            assert!(
                matches!(history.last(), Some(ConversationRecord::HistoryEnd { count, .. }) if *count == expected as usize)
            );
            assert!(
                !task.is_finished(),
                "{damage}: a room data failure must not end shared hosting"
            );
            stop.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(10), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            drop(socket);
            drop(hub);
            if !repaired {
                assert_eq!(
                    std::fs::read(&damaged).unwrap(),
                    expected_bytes,
                    "{damage}: failed data stays untouched"
                );
            }
        }
    }
}

#[tokio::test]
async fn unscoped_sqlite_at_rooms_root_prevents_http_startup() {
    let folder = tempfile::tempdir().unwrap();
    std::fs::create_dir(folder.path().join("rooms")).unwrap();
    let unscoped = folder.path().join("rooms/legacy.sqlite");
    std::fs::write(&unscoped, b"preserved private layout").unwrap();
    let (address, _stop, rejected, hub) = start_server(folder.path()).await;
    assert!(tokio::time::timeout(Duration::from_secs(10), rejected)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("unsupported_room_storage_layout"));
    assert_eq!(
        std::fs::read(&unscoped).unwrap(),
        b"preserved private layout"
    );
    TcpListener::bind(address).await.expect("failed hosting releases HTTP listener");
    drop(hub);
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
    let saved = serde_json::to_value(hub.lock().unwrap().authority.export_backup()).unwrap();
    let (status, bytes) =
        room_backup_http(address, "/prototype/channel/identity", &credential, None).await;
    assert_eq!(status, 200);
    let identified: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(identified["domainId"], state.channel.id.to_string());
    send_request(
        &mut owner,
        json!({"type":"profiles","ids":[state.channel.owner_id.unwrap()]}),
    )
    .await;
    let profile = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match event(&mut owner).await {
                Event::Profiles {
                    mut profiles,
                    total: 1,
                    next_cursor: None,
                    ..
                } => break profiles.pop().unwrap(),
                Event::Error { code, .. } => panic!("profile read failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(identified["user"], serde_json::to_value(profile).unwrap());
    assert_eq!(
        serde_json::to_value(hub.lock().unwrap().authority.export_backup()).unwrap(),
        saved
    );
    assert_eq!(
        room_backup_http(address, "/prototype/channel/identity", "invalid", None)
            .await
            .0,
        403
    );
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
        .map(|seq| {
            HistoryRow::Message(piik_channel_core::backup::LiveHistoryRow {
                nonce: format!("retained-{seq}"),
                message: StoredMessage {
                    message: piik_channel_core::wire::ChatMessage {
                        mentions: vec![],
                        reply: None,
                        inline_images: Default::default(),
                        id: Uuid::new_v4(),
                        seq,
                        user_id: metadata.policy.creator_id,
                        archived_author_name: None,
                        text: format!("Saved {seq}"),
                        time: seq,
                        attachments: vec![],
                    },
                    reactions: Default::default(),
                },
            })
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
        !crate::room_directory(folder.path(), hub.lock().unwrap().authority.identity())
            .join("imported-room.sqlite")
            .exists(),
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

#[tokio::test]
async fn domain_backup_restarts_its_operator_and_preserves_other_domain_room_files() {
    use piik_channel_native::backup::{self, StagedBackup};
    let folder = tempfile::tempdir().unwrap();
    let (address, stop, task, hub) = start_server(folder.path()).await;
    let (mut owner, _, initial, credential) =
        connect_with_credential(address, "owner", "Owner").await;
    let ready = |state: &Snapshot| {
        state.channel.rooms.len() == 3 && state.channel.rooms.iter().all(|room| room.available)
    };
    let initial = if ready(&initial) {
        initial
    } else {
        state_when(&mut owner, ready).await
    };
    let old_native = initial.channel.rooms[0]
        .delivery
        .as_ref()
        .unwrap()
        .host_session_id;
    let identity = hub.lock().unwrap().authority.identity();
    let rooms = crate::room_directory(folder.path(), identity);
    let (status, bytes) =
        room_backup_http(address, "/prototype/channel/backup", &credential, None).await;
    assert_eq!(status, 200);
    let staging = tempfile::tempdir().unwrap();
    let StagedBackup::Domain(mut metadata) =
        backup::stage(std::io::Cursor::new(bytes), staging.path()).unwrap()
    else {
        panic!("domain backup")
    };
    assert_eq!(metadata.owner_key, "owner");
    let archive = |metadata: &DomainMetadata| {
        let mut bytes = vec![];
        backup::write_domain(metadata, &mut bytes).unwrap();
        bytes
    };
    metadata.owner_key = "restored-owner".into();
    // Reject only the new durable record. Ordinary old-domain admissions can
    // still commit, proving the service reopens its old operator after failure.
    let reject = rusqlite::Connection::open(folder.path().join("channel.sqlite")).unwrap();
    reject.execute_batch("CREATE TRIGGER reject_restore BEFORE INSERT ON domain_user WHEN EXISTS(SELECT 1 FROM checkpoint WHERE instr(body, 'restored-owner') > 0) BEGIN SELECT RAISE(ABORT, 'restore_rejected'); END;").unwrap();
    let (status, failure) = room_backup_http(
        address,
        "/prototype/channel/backup",
        &credential,
        Some(archive(&metadata)),
    )
    .await;
    assert_eq!(status, 409);
    assert!(
        String::from_utf8_lossy(&failure).contains("restore_rejected"),
        "{}",
        String::from_utf8_lossy(&failure)
    );
    let after_failure = state_when(&mut owner, |state| {
        ready(state)
            && state.channel.rooms[0]
                .delivery
                .as_ref()
                .unwrap()
                .host_session_id
                != old_native
    })
    .await;
    assert_eq!(hub.lock().unwrap().authority.owner_admission_key(), "owner");
    reject.execute_batch("DROP TRIGGER reject_restore").unwrap();
    drop(reject);
    let (status, result) = room_backup_http(
        address,
        "/prototype/channel/backup",
        &credential,
        Some(archive(&metadata)),
    )
    .await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&result));
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(frame) = owner.next().await {
            if matches!(frame.unwrap(), Message::Close(_)) {
                return;
            }
        }
    })
    .await
    .unwrap();
    let (mut owner, _, initial, current_credential) =
        connect_with_credential(address, "restored-owner", "Stale name").await;
    let restored = if ready(&initial) {
        initial
    } else {
        state_when(&mut owner, ready).await
    };
    assert_eq!(restored.channel.id, identity.0);
    assert_ne!(
        restored.channel.rooms[0]
            .delivery
            .as_ref()
            .unwrap()
            .host_session_id,
        after_failure.channel.rooms[0]
            .delivery
            .as_ref()
            .unwrap()
            .host_session_id
    );
    assert_eq!(
        room_backup_http(address, "/prototype/channel/identity", &credential, None)
            .await
            .0,
        403
    );
    assert!(restored.publications.is_empty() && restored.voice.is_empty());
    assert!(restored.channel.rooms.iter().all(|room| !room.reading));
    let previous_file = std::fs::read(rooms.join("living.sqlite")).unwrap();
    let next_id = Uuid::new_v4();
    let mut different = serde_json::to_value(metadata).unwrap();
    different["state"]["id"] = json!(next_id);
    let different: DomainMetadata = serde_json::from_value(different).unwrap();
    assert_eq!(
        room_backup_http(
            address,
            "/prototype/channel/backup",
            &current_credential,
            Some(archive(&different))
        )
        .await
        .0,
        200
    );
    let (mut owner, _, initial, _) =
        connect_with_credential(address, "restored-owner", "Owner").await;
    let admitted = |state: &Snapshot| state.sessions.len() >= 2;
    let current = if admitted(&initial) {
        initial
    } else {
        state_when(&mut owner, admitted).await
    };
    assert_eq!(current.channel.id, next_id);
    assert_eq!(current.channel.rooms.len(), 3);
    assert!(current.channel.rooms.iter().all(|room| !room.available));
    assert!(
        std::fs::read_dir(crate::room_directory(folder.path(), (next_id, identity.1)))
            .unwrap()
            .next()
            .is_none()
    );
    assert_eq!(
        std::fs::read(rooms.join("living.sqlite")).unwrap(),
        previous_file
    );
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
    drop((owner, hub));
    let (address, stop, task, hub) = start_server(folder.path()).await;
    let (mut owner, _, initial) = connect(address, "restored-owner", "Owner").await;
    let current = if admitted(&initial) {
        initial
    } else {
        state_when(&mut owner, admitted).await
    };
    assert_eq!(current.channel.id, next_id);
    assert!(current.channel.rooms.iter().all(|room| !room.available));
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
    drop((owner, hub));
}

async fn room_copy_http(
    address: std::net::SocketAddr,
    credential: &str,
    session: Uuid,
    archive: &[u8],
) -> (u16, Value) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
        .post(format!("http://{address}/prototype/channel/rooms/copy"))
        .bearer_auth(credential)
        .header("X-Piik-Session", session.to_string())
        .header("Content-Type", "application/zip")
        .body(archive.to_vec())
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.bytes().await.unwrap();
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| panic!("HTTP {status}: {}", String::from_utf8_lossy(&bytes)));
    (status, body)
}

#[tokio::test]
async fn hosted_room_copy_installs_history_under_fresh_authority() {
    use piik_channel_core::wire::{HostingMode, RoomCreationPolicy};
    use std::io::Write;

    let folder = tempfile::tempdir().unwrap();
    drop(
        Domain::open_with_options(
            folder.path(),
            "owner",
            "http://localhost".into(),
            None,
            vec![],
            RoomCreationPolicy::Ordinary,
            Some(HostingMode::Hosted),
        )
        .unwrap(),
    );
    let (address, stop, task, hub) = start_server(folder.path()).await;
    let (mut operator, operator_session, _, owner_credential) =
        connect_with_credential(address, "owner", "Operator").await;
    let (mut creator, creator_session, _, creator_credential) =
        connect_with_credential(address, "invite", "Creator").await;
    let identity = hub.lock().unwrap().authority.identity();
    let path = crate::room_directory(folder.path(), identity).join("unrelated.sqlite");
    let locked = rusqlite::Connection::open(path).unwrap();
    locked.execute_batch("BEGIN EXCLUSIVE; CREATE TABLE hold(value)").unwrap();
    send_request(
        &mut operator,
        json!({"type":"create_room","room":{
            "id":"source","name":"Backup source","icon":"couch","creatorId":Uuid::nil(),
            "access":"public","hidden":false,"hasPassword":false
        }}),
    )
    .await;
    let source = state_when(&mut operator, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|room| room.name == "Backup source" && room.available)
    })
    .await
    .channel
    .rooms
    .into_iter()
    .find(|room| room.name == "Backup source")
    .unwrap();
    let backup_path = format!("/prototype/channel/rooms/{}/backup", source.id);

    // A normal browser copy carries history and archived names, without room credentials.
    let source_author = Uuid::new_v4();
    let message_id = Uuid::new_v4();
    let image_id = Uuid::new_v4();
    let thumbnail = "UklGRmFiY2RXRUJQcHJldmlldw==";
    let manifest = json!({
        "kind": "room_copy", "version": 2,
        "authors": {(source_author.to_string()): "Source author"}, "retainedFiles": []
    });
    let message = json!({
        "nonce":"source-retry",
        "id":message_id, "seq":1, "userId":source_author, "text":"Copied history", "time":1,
        "attachments":[{"id":image_id,"name":"image.png","size":1000,"mediaType":"image/png","sha256":"a".repeat(64)}],
        "inlineImages":{(image_id.to_string()):{"data":thumbnail,"mediaType":"image/webp","original":false,"width":48,"height":32}},
        "reactions":{"revision":1,"counts":{"wave":1}}
    });
    let pack = |history: &str, settings: &Value| {
        let mut archive = Vec::new();
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut zip = zip::ZipWriter::new_stream(&mut archive);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        zip.start_file("history.ndjson", options).unwrap();
        zip.write_all(history.as_bytes()).unwrap();
        zip.start_file("settings.json", options).unwrap();
        zip.write_all(settings.to_string().as_bytes()).unwrap();
        zip.finish().unwrap();
        archive
    };
    let (status, full) = room_backup_http(address, &backup_path, &owner_credential, None).await;
    assert_eq!(status, 200);
    let settings = json!({
        "type":"create_room",
        "room":{"id":"living","name":"Imported conversation","icon":"couch",
                "creatorId":source_author,"access":"private","hidden":true,"hasPassword":false}
    });
    let reply = json!({
        "nonce":"second", "id":Uuid::new_v4(), "seq":2, "userId":Uuid::new_v4(),
        "text":"Reply", "time":2, "attachments":[], "reactions":{"revision":0,"counts":{}},
        "reply":{"seq":1,"userId":source_author,"text":"Copied history","notify":false}
    });
    let history = format!("{message}\n{reply}\n");
    let valid = pack(&history, &settings);
    let malformed = pack("invalid history", &settings);
    let interrupted = &valid[..valid.len() - 32];
    let authority = || serde_json::to_value(hub.lock().unwrap().authority.export_backup()).unwrap();
    let before = authority();
    for (session, archive, expected_status) in [
        (operator_session, valid.as_slice(), 403),
        (creator_session, malformed.as_slice(), 400),
        (creator_session, full.as_slice(), 400),
        (creator_session, b"invalid archive".as_slice(), 400),
        // Simulate an upload ending before the ZIP directory.
        (creator_session, interrupted, 400),
    ] {
        let (status, body) = room_copy_http(address, &creator_credential, session, archive).await;
        assert_eq!(status, expected_status, "{body}");
        assert!(body["error"].is_string(), "{body}");
        assert_eq!(authority(), before);
    }

    send_request(
        &mut operator,
        json!({"type":"set_room_creation_policy","policy":"owner_only"}),
    )
    .await;
    state_when(&mut operator, |state| {
        state.channel.room_creation_policy == RoomCreationPolicy::OwnerOnly
    })
    .await;
    let before = authority();
    for archive in [&[][..], valid.as_slice()] {
        let (status, body) =
            room_copy_http(address, &creator_credential, creator_session, archive).await;
        assert_eq!(status, 403, "{body}");
        assert_eq!(body["error"], "room_creation_restricted");
        assert_eq!(authority(), before);
    }

    send_request(
        &mut operator,
        json!({"type":"set_room_creation_policy","policy":"invite_only"}),
    )
    .await;
    state_when(&mut operator, |state| {
        state.channel.room_creation_policy == RoomCreationPolicy::InviteOnly
    })
    .await;
    let before = authority();
    let mut public = settings.clone();
    public["room"]["access"] = json!("public");
    public["room"]["hidden"] = json!(false);
    let (status, body) = room_copy_http(
        address,
        &creator_credential,
        creator_session,
        &pack(&history, &public),
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"], "room_creation_restricted");
    assert_eq!(authority(), before);

    let (status, body) =
        room_copy_http(address, &creator_credential, creator_session, &valid).await;
    assert!((200..300).contains(&status), "{status}: {body}");
    let room: piik_channel_core::host::RoomSummary =
        serde_json::from_value(body["room"].clone()).unwrap();
    assert_ne!(room.id, source.id);
    assert_ne!(room.creator_id, source_author);
    let creator_ready = state_when(&mut creator, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|r| r.id == room.id && r.can_manage && r.available)
    })
    .await;
    let creator_info = creator_ready
        .sessions
        .iter()
        .find(|session| session.id == creator_session)
        .unwrap();
    assert_eq!(room.creator_id, creator_info.user_id);
    assert_ne!(Some(room.creator_id), creator_ready.channel.owner_id);
    send_request(&mut creator, json!({"type":"room_invite","roomId":room.id})).await;
    let invite = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match event(&mut creator).await {
                Event::RoomInvite { key, .. } => break key,
                Event::Error { code, .. } => panic!("invite failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let (mut reader, reader_session, initial) = connect(address, "invite", "Reader").await;
    assert!(!initial.channel.rooms.iter().any(|r| r.id == room.id));
    send_request(
        &mut reader,
        json!({"type":"enter_room","roomId":room.id,"inviteKey":invite}),
    )
    .await;
    state_when(&mut reader, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|r| r.id == room.id && r.authorized && r.available && !r.can_manage)
    })
    .await;
    send_request(
        &mut reader,
        json!({"type":"browse","roomId":room.id,"active":true}),
    )
    .await;
    let readable = state_when(&mut reader, |state| {
        state
            .channel
            .rooms
            .iter()
            .any(|r| r.id == room.id && r.reading)
    })
    .await;
    let history = room_conversation(
        &mut reader,
        reader_session,
        &readable,
        &room.id,
        ConversationCommand::History { before: None },
    )
    .await;
    assert!(matches!(history.as_slice(), [
        ConversationRecord::HistoryMessage { message },
        ConversationRecord::MessageReactions { snapshot },
        ConversationRecord::HistoryMessage { message: response },
        ConversationRecord::MessageReactions { .. },
        ConversationRecord::HistoryEnd { count: 2, .. },
    ] if message.id != message_id && message.user_id != source_author && message.user_id != room.creator_id
        && message.archived_author_name.as_deref() == Some("Source author")
        && response.reply.as_ref().is_some_and(|reply| reply.user_id == message.user_id
            && reply.archived_author_name.as_deref() == Some("Source author"))
        && message.text == "Copied history"
        && message.inline_images.get(&image_id).is_some_and(|image| image.data == thumbnail)
        && snapshot.message_id == message.id && snapshot.reactions.counts.get("wave") == Some(&1)));
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn owner_room_backup_rejects_busy_restore_before_reading_upload() {
    use axum::{body::{Body, Bytes}, extract::State, http::{header, HeaderMap, StatusCode}};
    use std::sync::atomic::{AtomicBool, Ordering};
    let folder = tempfile::tempdir().unwrap();
    let domain = Domain::open(folder.path(), "owner", "http://localhost".into(), None, vec![]).unwrap();
    let mut headers = HeaderMap::new();
    let (commands, _writer) = mpsc::channel(1);
    {
        let mut hub = domain.hub.lock().unwrap();
        hub.room_commands = Some(commands);
        let mut owner = Endpoint::connect(&mut hub);
        owner.request(&mut hub, json!({"type":"join","ownerKey":"owner","name":"Owner"}));
        let welcome = owner.drain().into_iter().find(|event| event["type"] == "welcome").unwrap();
        let credential = welcome["credential"].as_str().unwrap();
        headers.insert(header::AUTHORIZATION, format!("Bearer {credential}").parse().unwrap());
    }
    headers.insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    let _busy = domain.room_restore.clone().try_acquire_owned().unwrap();
    let polled = Arc::new(AtomicBool::new(false));
    let observed = polled.clone();
    let body = Body::from_stream(futures_util::stream::once(async move {
        observed.store(true, Ordering::SeqCst);
        Ok::<_, std::io::Error>(Bytes::new())
    }));
    let (status, _) = backup::restore(State(domain), headers, body).await.unwrap_err();
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(!polled.load(Ordering::SeqCst));
}
