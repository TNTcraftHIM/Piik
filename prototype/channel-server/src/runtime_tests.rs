use super::*;
use serde_json::{json, Value};

struct Endpoint {
    id: Uuid,
    events: mpsc::Receiver<Event>,
}

impl Endpoint {
    fn join(hub: &mut Hub, key: &str) -> Self {
        let id = Uuid::new_v4();
        let (events, queue) = mpsc::channel(64);
        let (close, _) = watch::channel(false);
        hub.clients.insert(id, Client { events, close });
        let mut endpoint = Self { id, events: queue };
        endpoint.request(hub, json!({"type":"join", "key":key, "name":"Friend"}));
        assert!(endpoint
            .drain()
            .iter()
            .any(|event| event["type"] == "welcome"));
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

#[test]
fn room_commit_owns_confirmation_retry_and_broadcast_without_domain_checkpoint() {
    let path = std::env::temp_dir().join(format!("piik-room-runtime-{}.sqlite", Uuid::new_v4()));
    let storage = storage::Storage::open(&path, storage::Limits::default()).unwrap();
    let mut hub = Hub {
        authority: Authority::new("owner".into(), "invite".into(), vec![]).unwrap(),
        clients: BTreeMap::new(),
        storage: Arc::new(Mutex::new(storage)),
    };
    let mut sender = Endpoint::join(&mut hub, "owner");
    let mut reader = Endpoint::join(&mut hub, "invite");
    reader.request(&mut hub, json!({"type":"browse", "roomId":"living"}));
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

    sender.request(&mut hub, json!({"type":"browse", "roomId":"quiet"}));
    sender.drain();
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
