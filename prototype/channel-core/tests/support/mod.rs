use piik_channel_core::{
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
    pub max_host_output_bytes: usize,
    hosts: BTreeMap<String, HostedRoom>,
    sessions: BTreeMap<Uuid, Uuid>,
    states: BTreeMap<Uuid, Snapshot>,
}

impl RoomNetwork {
    pub fn new() -> Self {
        Self {
            authority: Authority::new("owner".into(), vec![]).unwrap(),
            max_host_output_bytes: 0,
            hosts: BTreeMap::new(),
            sessions: BTreeMap::new(),
            states: BTreeMap::new(),
        }
    }

    pub fn command(&mut self, connection: Uuid, value: Value) -> Effects {
        self.command_at(connection, value, 100)
    }

    pub fn command_at(&mut self, connection: Uuid, mut value: Value, now: u64) -> Effects {
        if value["type"] == "join" && value.get("protocol").is_none() {
            value["protocol"] = json!(piik_channel_core::wire::CHANNEL_PROTOCOL);
        }
        if value["type"] == "join" && value.get("signingKey").is_none() {
            value["signingKey"] = json!(piik_channel_core::conversation::SessionSigner::from_seed(
                [1; 32]
            )
            .signing_key());
        }
        let effects =
            self.authority
                .handle(connection, Request::parse(&value.to_string()).unwrap(), now);
        self.deliver(effects)
    }

    pub fn deliver(&mut self, effects: Effects) -> Effects {
        let mut pending = VecDeque::from([effects]);
        let mut delivered = Effects::default();
        while let Some(effects) = pending.pop_front() {
            delivered.close.extend(effects.close);
            for (connection, event) in effects.events {
                match event {
                    Event::HostInput { room_id, input } => {
                        let now = input.now;
                        let hosted = self
                            .hosts
                            .get_mut(&room_id)
                            .expect("registered room runtime");
                        assert_eq!(hosted.connection, connection);
                        let output = hosted.host.dispatch(input).unwrap();
                        let command =
                            json!({"type":"host_output", "roomId":room_id, "output":output})
                                .to_string();
                        self.max_host_output_bytes = self.max_host_output_bytes.max(command.len());
                        pending.push_back(self.authority.handle(
                            connection,
                            Request::parse(&command).unwrap(),
                            now,
                        ));
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
        input: piik_channel_core::host::HostInput,
    ) -> piik_channel_core::host::HostOutput {
        self.hosts
            .get_mut(room)
            .unwrap()
            .host
            .dispatch(input)
            .unwrap()
    }

    #[allow(dead_code)]
    pub fn host_connection(&mut self, room: &str, connection: Uuid) {
        self.hosts.get_mut(room).unwrap().connection = connection;
    }

    pub fn create(&mut self, connection: Uuid, access: RoomAccess, hidden: bool) -> String {
        let session = self.sessions[&connection];
        let user = self.states[&connection]
            .sessions
            .iter()
            .find(|entry| entry.id == session)
            .unwrap()
            .user_id;
        let mut policy = RoomState::new(
            Uuid::new_v4().to_string(),
            "Friends".into(),
            Default::default(),
            user,
            access,
            hidden,
            None,
        )
        .unwrap();
        let summary = piik_channel_core::host::RoomSummary::from_policy(&policy);
        let created = self.command(
            connection,
            json!({"type":"create_room", "room":summary, "requestId":"new-room"}),
        );
        policy.id = created
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::RoomCreated { room, .. } => Some(room.id),
                _ => None,
            })
            .expect("domain assigned room identity");
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
        command: piik_channel_core::conversation::ConversationCommand,
    ) -> piik_channel_core::conversation::ConversationOutcome {
        use piik_channel_core::conversation::{
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

    #[allow(dead_code)]
    pub fn policy(&self, room: &str) -> RoomState {
        self.hosts[room].host.policy().clone()
    }

    #[allow(dead_code)]
    pub fn conversation(
        &mut self,
        room: &str,
        packet: &piik_channel_core::conversation::SignedPacket,
    ) -> piik_channel_core::conversation::ConversationOutcome {
        self.hosts
            .get_mut(room)
            .unwrap()
            .host
            .dispatch_peer(packet, 100)
            .unwrap()
    }

    pub fn state(&self, connection: Uuid) -> &Snapshot {
        &self.states[&connection]
    }
}
