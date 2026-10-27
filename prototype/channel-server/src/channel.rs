use crate::{
    access::{RoomPermission, RoomState},
    history::{HistoryRequest, HISTORY_WINDOW},
    identity::{Admission, Admitted, Identity, StoredUser},
    room::RoomRuntime,
    transport::TransportBook,
    wire::*,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const MAX_PUBLICATIONS: usize = 80;

/// Local composition of domain admission, room runtimes and shared transports.
/// Browsing selects a presentation; it never owns another room's activities.
#[derive(Clone)]
pub struct Channel {
    pub identity: Identity,
    id: Uuid,
    rooms: BTreeMap<String, RoomRuntime>,
    browsing: BTreeMap<Uuid, String>,
    transports: TransportBook,
    ice_servers: Vec<Value>,
}

pub struct Outcome {
    pub events: Vec<(Uuid, Event)>,
    pub broadcast: bool,
    pub leave: bool,
    pub history: Option<HistoryRequest>,
}

impl Channel {
    pub fn new(owner_key: String, invite_key: String, ice_servers: Vec<Value>) -> Self {
        let identity = Identity::new(owner_key, invite_key);
        let rooms = [
            ("living", "Living room"),
            ("studio", "Studio"),
            ("quiet", "Quiet corner"),
        ]
        .into_iter()
        .map(|(id, name)| {
            let policy = RoomState::new(
                id.into(),
                name.into(),
                identity.owner_id,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap();
            (id.to_owned(), RoomRuntime::new(policy))
        })
        .collect();
        Self {
            identity,
            id: Uuid::new_v4(),
            rooms,
            browsing: BTreeMap::new(),
            transports: TransportBook::default(),
            ice_servers,
        }
    }

    #[cfg(test)]
    pub fn join(
        &mut self,
        input: Admission<'_>,
        connection: Uuid,
        now: u64,
    ) -> Result<Admitted, &'static str> {
        self.join_room(input, connection, now, None)
    }

    pub fn join_room(
        &mut self,
        input: Admission<'_>,
        connection: Uuid,
        now: u64,
        room_id: Option<&str>,
    ) -> Result<Admitted, &'static str> {
        let invited_room = room_id
            .filter(|id| {
                self.rooms
                    .get(*id)
                    .is_some_and(|room| input.key.is_some_and(|key| room.accepts_invite(key)))
            })
            .map(str::to_owned);
        let key = invited_room
            .as_ref()
            .map(|_| self.identity.invite_key.clone());
        let admitted = self.identity.admit(
            Admission {
                key: key.as_deref().or(input.key),
                ..input
            },
            connection,
            now,
        )?;
        if let Some(id) = invited_room {
            self.rooms
                .get_mut(&id)
                .unwrap()
                .grant_invited(admitted.user_id);
        }
        self.reconcile();
        Ok(admitted)
    }

    pub fn handle(
        &mut self,
        session_id: Uuid,
        command: Command,
        now: u64,
    ) -> Result<Outcome, &'static str> {
        let user_id = self
            .identity
            .sessions
            .get(&session_id)
            .ok_or("session_expired")?
            .user_id;
        let member = self.identity.member(user_id)?;
        let mut events = Vec::new();
        let mut broadcast = false;
        let mut leave = false;
        let mut history = None;
        match command {
            Command::Join { .. } => return Err("already_joined"),
            Command::SetName { name } => {
                let name = name.trim();
                if name.is_empty() || name.encode_utf16().count() > 40 {
                    return Err("invalid_name");
                }
                self.identity.users.get_mut(&user_id).unwrap().name = name.to_owned();
                broadcast = true;
            }
            Command::Browse { room_id } => {
                history = Some(self.room(&room_id)?.history(member, None)?);
                self.browsing.insert(session_id, room_id);
            }
            Command::History { room_id, before } => {
                history = Some(self.room(&room_id)?.history(member, before)?);
            }
            Command::Chat {
                room_id,
                text,
                nonce,
                attachments,
            } => {
                history = Some(
                    self.room(&room_id)?
                        .chat(member, text, nonce, attachments, now)?,
                );
            }
            Command::CreateRoom {
                name,
                access,
                hidden,
                password,
            } => {
                if !member.participates {
                    return Err("forbidden");
                }
                if self.rooms.len() >= 32 {
                    return Err("room_limit");
                }
                let id = Uuid::new_v4().to_string();
                let policy = RoomState::new(id.clone(), name, user_id, access, hidden, password)?;
                self.rooms.insert(id.clone(), RoomRuntime::new(policy));
                events.push((
                    session_id,
                    Event::RoomCreated {
                        room_id: id,
                        request_id: None,
                    },
                ));
                broadcast = true;
            }
            Command::UpdateRoom {
                room_id,
                name,
                access,
                hidden,
                password,
            } => {
                self.room_mut(&room_id)?
                    .update(member, name, access, hidden, password)?;
                broadcast = true;
            }
            Command::EnterRoom {
                room_id,
                password,
                invite_key,
            } => {
                self.room_mut(&room_id)?.enter(
                    member,
                    password.as_deref(),
                    invite_key.as_deref(),
                )?;
                broadcast = true;
            }
            Command::RoomInvite { room_id } => {
                let key = self.room_mut(&room_id)?.invite(member)?;
                events.push((
                    session_id,
                    Event::RoomInvite {
                        room_id,
                        key,
                        request_id: None,
                    },
                ));
            }
            Command::RevokeRoomAccess {
                room_id,
                user_id: target,
            } => {
                let target = self.identity.member(target)?;
                self.room_mut(&room_id)?.revoke(member, target)?;
                broadcast = true;
            }
            Command::SetRoles {
                user_id: target,
                roles,
            } => {
                self.identity
                    .assign_roles(user_id, target, roles.into_iter().collect())?;
                broadcast = true;
            }
            Command::Publish { publication: input } => {
                if let Some(room) = self.publication_room(input.id) {
                    if room.policy().id != input.room_id {
                        return Err("publication_identity_conflict");
                    }
                } else if self
                    .rooms
                    .values()
                    .map(|room| room.publications().count())
                    .sum::<usize>()
                    >= MAX_PUBLICATIONS
                {
                    return Err("publication_limit");
                }
                self.room_mut(&input.room_id)?.publish(
                    member,
                    session_id,
                    input.id,
                    input.kind,
                    input.muted,
                )?;
                broadcast = true;
            }
            Command::Unpublish { publication_id } => {
                if let Some(room) = self.publication_room_mut(publication_id) {
                    broadcast = room.unpublish(session_id, publication_id)?;
                }
            }
            Command::Subscribe {
                publication_id,
                enabled,
            } => {
                broadcast = self
                    .publication_room_mut(publication_id)
                    .ok_or("publication_unavailable")?
                    .subscribe(member, session_id, publication_id, enabled)?;
            }
            Command::Voice {
                room_id,
                joined,
                muted,
                deafened,
            } => {
                let room = self.room(&room_id)?;
                if joined
                    && !room.voice_joined(session_id)
                    && self
                        .rooms
                        .values()
                        .map(|room| room.voice().count())
                        .sum::<usize>()
                        >= 160
                {
                    return Err("voice_limit");
                }
                self.room_mut(&room_id)?
                    .set_voice(member, session_id, joined, muted, deafened)?;
                broadcast = true;
            }
            Command::Signal { pair_id, payload } => {
                if !payload.valid() {
                    return Err("invalid_signal");
                }
                let peer = self.peer(session_id, pair_id).ok_or("unassigned_pair")?;
                if payload.tracks.as_ref().is_some_and(|tracks| {
                    tracks.iter().any(|track| {
                        !self
                            .transports
                            .allows(pair_id, session_id, track.publication_id)
                    })
                }) {
                    return Err("unassigned_publication");
                }
                events.push((
                    peer,
                    Event::Signal {
                        pair_id,
                        from_session_id: session_id,
                        payload,
                    },
                ));
            }
            Command::LinkState { pair_id, state } => {
                let peer = self.peer(session_id, pair_id).ok_or("unassigned_pair")?;
                if matches!(state, LinkState::Failed) {
                    self.transports.retire(pair_id);
                    for room in self.rooms.values_mut() {
                        room.failed_pair(session_id, peer);
                    }
                    broadcast = true;
                }
            }
            Command::FlowState {
                publication_id,
                pair_id,
                ready,
            } => {
                let peer = self.peer(session_id, pair_id).ok_or("unassigned_pair")?;
                broadcast = self
                    .publication_room_mut(publication_id)
                    .ok_or("publication_unavailable")?
                    .flow_state(publication_id, session_id, peer, ready)?;
            }
            Command::Leave => {
                self.retire_session(session_id);
                broadcast = true;
                leave = true;
            }
        }
        if broadcast {
            self.reconcile();
        }
        Ok(Outcome {
            events,
            broadcast,
            leave,
            history,
        })
    }

    fn room(&self, id: &str) -> Result<&RoomRuntime, &'static str> {
        self.rooms.get(id).ok_or("room_unavailable")
    }
    fn room_mut(&mut self, id: &str) -> Result<&mut RoomRuntime, &'static str> {
        self.rooms.get_mut(id).ok_or("room_unavailable")
    }
    fn publication_room(&self, id: Uuid) -> Option<&RoomRuntime> {
        self.rooms
            .values()
            .find(|room| room.publication(id).is_some())
    }
    fn publication_room_mut(&mut self, id: Uuid) -> Option<&mut RoomRuntime> {
        self.rooms
            .values_mut()
            .find(|room| room.publication(id).is_some())
    }

    fn retire_session(&mut self, session_id: Uuid) {
        for room in self.rooms.values_mut() {
            room.retire_session(session_id);
        }
        self.browsing.remove(&session_id);
        self.identity.sessions.remove(&session_id);
    }

    pub fn expire_sessions(&mut self, now: u64) -> bool {
        let expired = self.identity.expired(now);
        if expired.is_empty() {
            return false;
        }
        for session_id in expired {
            self.retire_session(session_id);
        }
        self.reconcile();
        true
    }

    pub fn authorize(
        &self,
        user: Uuid,
        room_id: &str,
        permission: RoomPermission,
    ) -> Result<(), &'static str> {
        self.room(room_id)?
            .authorize(self.identity.member(user)?, permission)
    }

    pub fn history_audience(&self, room_id: &str) -> Vec<Uuid> {
        self.browsing
            .iter()
            .filter(|(_, room)| room.as_str() == room_id)
            .filter_map(|(session, _)| self.identity.sessions[session].connection)
            .collect()
    }

    fn reconcile(&mut self) {
        let endpoints = self.identity.endpoints();
        for room in self.rooms.values_mut() {
            room.reconcile(&endpoints);
        }
        self.browsing.retain(|session, id| {
            self.rooms.get(id).is_some_and(|room| {
                room.authorize(endpoints[session].member, RoomPermission::Read)
                    .is_ok()
            })
        });
        self.transports
            .reconcile(self.rooms.values().flat_map(|room| room.flows()));
    }

    pub fn export_state(&self) -> DurableState {
        DurableState {
            version: 2,
            id: self.id,
            owner_id: self.identity.owner_id,
            users: self.identity.export_users(),
            rooms: self
                .rooms
                .iter()
                .map(|(id, room)| (id.clone(), room.policy().clone()))
                .collect(),
        }
    }

    pub fn import_state(&mut self, state: DurableState) -> Result<(), &'static str> {
        if state.version != 2 || state.rooms.len() > 32 {
            return Err("invalid_state");
        }
        let mut identity = Identity::new(
            self.identity.owner_key.clone(),
            self.identity.invite_key.clone(),
        );
        identity.restore_users(state.owner_id, state.users)?;
        self.identity = identity;
        self.id = state.id;
        self.rooms = state
            .rooms
            .into_iter()
            .map(|(id, policy)| (id, RoomRuntime::new(policy)))
            .collect();
        self.browsing.clear();
        self.transports = TransportBook::default();
        Ok(())
    }

    pub fn peer(&self, endpoint: Uuid, pair_id: Uuid) -> Option<Uuid> {
        self.transports.peer(endpoint, pair_id)
    }

    pub fn snapshot(&self, session_id: Uuid) -> Snapshot {
        let member = self
            .identity
            .sessions
            .get(&session_id)
            .and_then(|session| self.identity.member(session.user_id).ok());
        let reads = |room: &RoomRuntime| {
            member.is_some_and(|member| room.authorize(member, RoomPermission::Read).is_ok())
        };
        Snapshot {
            channel: ChannelInfo {
                history_window: HISTORY_WINDOW,
                id: self.id,
                name: "Piik friends".into(),
                owner_id: Some(self.identity.owner_id),
                rooms: member
                    .map(|member| {
                        self.rooms
                            .values()
                            .filter_map(|room| room.view(member))
                            .collect()
                    })
                    .unwrap_or_default(),
                roles: vec![
                    RoleInfo {
                        id: "member",
                        name: "Member",
                        permissions: vec!["chat", "publish", "subscribe", "voice", "create_room"],
                    },
                    RoleInfo {
                        id: "moderator",
                        name: "Moderator",
                        permissions: vec!["chat", "publish", "subscribe", "voice", "create_room"],
                    },
                ],
            },
            users: self.identity.users.values().cloned().collect(),
            sessions: self
                .identity
                .sessions
                .values()
                .map(|session| SessionInfo {
                    id: session.id,
                    user_id: session.user_id,
                    online: session.connection.is_some(),
                })
                .collect(),
            publications: self
                .rooms
                .values()
                .filter(|room| reads(room))
                .flat_map(|room| room.publications().cloned())
                .collect(),
            voice: self
                .rooms
                .values()
                .filter(|room| reads(room))
                .flat_map(|room| room.voice().cloned())
                .collect(),
            subscriptions: self
                .rooms
                .values()
                .flat_map(|room| room.subscriptions(session_id))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            pairs: self.transports.snapshot(session_id),
            ice_servers: self.ice_servers.clone(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableState {
    version: u32,
    id: Uuid,
    owner_id: Uuid,
    users: Vec<StoredUser>,
    rooms: BTreeMap<String, RoomState>,
}

#[cfg(test)]
#[path = "channel_tests.rs"]
mod tests;
