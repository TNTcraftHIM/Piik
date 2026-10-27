use piik_channel_prototype::{
    host::RoomHost,
    storage,
    wire::{Event, Request, RoomAccess, Snapshot},
    Authority, Effects, RoomState,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use uuid::Uuid;

struct HostedRoom {
    connection: Uuid,
    host: RoomHost,
    store: storage::Storage,
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

    pub fn command(&mut self, connection: Uuid, value: Value) -> Effects {
        let effects =
            self.authority
                .handle(connection, Request::parse(&value.to_string()).unwrap(), 100);
        self.deliver(effects)
    }

    fn deliver(&mut self, effects: Effects) -> Effects {
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
                        let work = hosted.host.dispatch(input).unwrap();
                        if let Some(policy) = work.policy {
                            hosted
                                .store
                                .save(&serde_json::to_value(policy).unwrap())
                                .unwrap();
                        }
                        let history = work
                            .history
                            .as_ref()
                            .map(|request| hosted.store.history(request).unwrap());
                        let output = hosted.host.finish(history).unwrap();
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
        let host = RoomHost::new(policy);
        let summary = host.summary();
        let mut store =
            storage::Storage::open(Path::new(":memory:"), storage::Limits::default()).unwrap();
        store
            .save(&serde_json::to_value(host.policy()).unwrap())
            .unwrap();
        self.hosts.insert(
            id.clone(),
            HostedRoom {
                connection,
                host,
                store,
            },
        );
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

    pub fn policy(&self, room: &str) -> RoomState {
        serde_json::from_value(self.hosts[room].store.load().unwrap().unwrap()).unwrap()
    }

    pub fn state(&self, connection: Uuid) -> &Snapshot {
        &self.states[&connection]
    }
}
