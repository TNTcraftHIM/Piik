use piik_channel_prototype::{
    wire::{Event, Request, RoomAccess, Snapshot},
    Authority, Effects, RoomState, StoredRoomHost,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use uuid::Uuid;

struct HostedRoom {
    connection: Uuid,
    host: StoredRoomHost,
}

/// Delivers the production room protocol between separate authority and hosts.
/// Room commands and persistence use the real Rust owners, not test equivalents.
pub struct RoomNetwork {
    pub authority: Authority,
    hosts: BTreeMap<String, HostedRoom>,
    sessions: BTreeMap<Uuid, Uuid>,
    states: BTreeMap<Uuid, Snapshot>,
}

impl RoomNetwork {
    pub fn new() -> Self {
        Self {
            authority: Authority::new("owner".into(), "invite".into(), vec![]).unwrap(),
            hosts: BTreeMap::new(),
            sessions: BTreeMap::new(),
            states: BTreeMap::new(),
        }
    }

    pub fn command(&mut self, connection: Uuid, mut value: Value) -> Effects {
        if value["type"] == "join" && value.get("signingKey").is_none() {
            value["signingKey"] = json!(
                piik_channel_prototype::conversation::SessionSigner::from_seed([1; 32])
                    .signing_key()
            );
        }
        let effects =
            self.authority
                .handle(connection, Request::parse(&value.to_string()).unwrap(), 100);
        self.deliver(effects)
    }

    pub fn deliver(&mut self, effects: Effects) -> Effects {
        let mut pending = VecDeque::from([effects]);
        let mut delivered = Effects::default();
        while let Some(effects) = pending.pop_front() {
            delivered.close.extend(effects.close);
            if let Some(history) = effects.history {
                assert!(delivered.history.is_none());
                delivered.history = Some(history);
            }
            for (connection, event) in effects.events {
                match event {
                    Event::HostInput { room_id, input } => {
                        let hosted = self
                            .hosts
                            .get_mut(&room_id)
                            .expect("registered room runtime");
                        assert_eq!(hosted.connection, connection);
                        let output = hosted.host.dispatch(input).unwrap();
                        pending.push_back(self.authority.handle(connection, Request::parse(
                            &json!({"type":"host_output", "roomId":room_id, "output":output}).to_string(),
                        ).unwrap(), 100));
                    }
                    event => {
                        match &event {
                            Event::Welcome {
                                session_id, state, ..
                            } => {
                                self.sessions.insert(connection, *session_id);
                                self.states.insert(connection, state.clone());
                            }
                            Event::State { state } => {
                                self.states.insert(connection, state.clone());
                            }
                            _ => {}
                        }
                        delivered.events.push((connection, event));
                    }
                }
            }
        }
        delivered
    }

    #[allow(dead_code)]
    pub fn host_turn(
        &mut self,
        room: &str,
        input: piik_channel_prototype::host::HostInput,
    ) -> piik_channel_prototype::host::HostOutput {
        self.hosts
            .get_mut(room)
            .unwrap()
            .host
            .dispatch(input)
            .unwrap()
    }

    pub fn create(&mut self, connection: Uuid, access: RoomAccess, hidden: bool) -> String {
        let session = self.sessions[&connection];
        let user = self.states[&connection]
            .sessions
            .iter()
            .find(|entry| entry.id == session)
            .unwrap()
            .user_id;
        let policy = RoomState::new(
            Uuid::new_v4().to_string(),
            "Friends".into(),
            user,
            access,
            hidden,
            None,
        )
        .unwrap();
        self.restore_room(connection, policy)
    }

    pub fn restore_room(&mut self, connection: Uuid, policy: RoomState) -> String {
        let id = policy.id.clone();
        let host = StoredRoomHost::create(Path::new(":memory:"), policy).unwrap();
        let summary = host.summary();
        self.hosts
            .insert(id.clone(), HostedRoom { connection, host });
        let registered = self.command(
            connection,
            json!({"type":"host_register", "room":summary, "requestId":"create"}),
        );
        assert!(!registered
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::Error { .. })));
        assert!(self.states[&connection]
            .channel
            .rooms
            .iter()
            .any(|room| room.id == id && room.available));
        id
    }

    // The default admission fixture binds this actual signing key. Room data
    // executes at the room's SQLite owner rather than returning through domain events.
    #[allow(dead_code)]
    pub fn peer_request(
        &mut self,
        connection: Uuid,
        room: &str,
        command: piik_channel_prototype::conversation::ConversationCommand,
    ) -> piik_channel_prototype::conversation::ConversationOutcome {
        use piik_channel_prototype::conversation::{
            ConversationAddress, ConversationRequest, SessionSigner,
        };
        let host_connection = self.hosts[room].connection;
        let delivery = self.states[&host_connection]
            .channel
            .rooms
            .iter()
            .find(|entry| entry.id == room)
            .unwrap()
            .delivery
            .as_ref()
            .unwrap();
        let sender = self.sessions[&connection];
        let request = ConversationRequest {
            address: ConversationAddress {
                room_id: room.into(),
                binding_id: delivery.binding_id,
                sender,
                recipient: delivery.host_session_id,
                request_id: Uuid::new_v4().to_string(),
            },
            command,
        };
        let packet = SessionSigner::from_seed([1; 32])
            .sign(sender, &request)
            .unwrap();
        self.hosts
            .get_mut(room)
            .unwrap()
            .host
            .dispatch_peer(&packet, 100)
            .unwrap()
    }

    pub fn policy(&self, room: &str) -> RoomState {
        self.hosts[room].host.policy().clone()
    }

    pub fn state(&self, connection: Uuid) -> &Snapshot {
        &self.states[&connection]
    }
}
