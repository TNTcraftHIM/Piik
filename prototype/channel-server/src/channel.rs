use crate::access::{RoomPermission, RoomState};
use crate::history::{HistoryRequest, MessageDraft, HISTORY_WINDOW};
use crate::identity::StoredUser;
use crate::{
    identity::{Admission, Admitted, Identity},
    routes::Plan,
    wire::*,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const MAX_PUBLICATIONS: usize = 80;
const MAX_OUTGOING: usize = 160;

#[derive(Clone, Default)]
struct Activity {
    browse: Option<String>,
    watching: BTreeSet<Uuid>,
    voice: BTreeMap<String, VoiceInfo>,
}

#[derive(Clone)]
struct Publication {
    info: PublicationInfo,
    plan: Plan,
}
type PairKey = (Uuid, Uuid);

#[derive(Clone)]
pub struct Channel {
    pub identity: Identity,
    id: Uuid,
    rooms: BTreeMap<String, RoomState>,
    activity: BTreeMap<Uuid, Activity>,
    publications: BTreeMap<Uuid, Publication>,
    pairs: BTreeMap<PairKey, Uuid>,
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
            (
                id.to_owned(),
                RoomState::new(
                    id.to_owned(),
                    name.to_owned(),
                    identity.owner_id,
                    RoomAccess::Public,
                    false,
                    None,
                )
                .unwrap(),
            )
        })
        .collect();
        Self {
            identity,
            id: Uuid::new_v4(),
            rooms,
            activity: BTreeMap::new(),
            publications: BTreeMap::new(),
            pairs: BTreeMap::new(),
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
        let key = if invited_room.is_some() {
            Some(self.identity.invite_key.clone())
        } else {
            None
        };
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
                .grants
                .insert(admitted.user_id);
        }
        self.activity.entry(admitted.session_id).or_default();
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
                self.authorize(user_id, &room_id, RoomPermission::Read)?;
                self.activity.get_mut(&session_id).unwrap().browse = Some(room_id.clone());
                history = Some(HistoryRequest::Read {
                    room_id,
                    before: None,
                });
            }
            Command::History { room_id, before } => {
                self.authorize(user_id, &room_id, RoomPermission::Read)?;
                history = Some(HistoryRequest::Read { room_id, before });
            }
            Command::Chat {
                room_id,
                text,
                nonce,
                attachments,
            } => {
                self.authorize(user_id, &room_id, RoomPermission::Write)?;
                history = Some(HistoryRequest::Send {
                    room_id,
                    draft: MessageDraft::new(user_id, nonce, text, attachments, now)?,
                });
            }
            Command::CreateRoom {
                name,
                access,
                hidden,
                password,
            } => {
                self.participate(user_id)?;
                if self.rooms.len() >= 32 {
                    return Err("room_limit");
                }
                let id = Uuid::new_v4().to_string();
                let room = RoomState::new(id.clone(), name, user_id, access, hidden, password)?;
                self.rooms.insert(id.clone(), room);
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
                self.authorize(user_id, &room_id, RoomPermission::Manage)?;
                self.rooms
                    .get_mut(&room_id)
                    .unwrap()
                    .update(name, access, hidden, password)?;
                self.prune_access();
                broadcast = true;
            }
            Command::EnterRoom {
                room_id,
                password,
                invite_key,
            } => {
                self.rooms
                    .get_mut(&room_id)
                    .ok_or("room_access_required")?
                    .enter(
                        user_id,
                        self.identity.owner_id,
                        password.as_deref(),
                        invite_key.as_deref(),
                    )?;
                broadcast = true;
            }
            Command::RoomInvite { room_id } => {
                self.authorize(user_id, &room_id, RoomPermission::Manage)?;
                let key = self.rooms.get_mut(&room_id).unwrap().invite()?;
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
                self.authorize(user_id, &room_id, RoomPermission::Manage)?;
                let room = self.rooms.get_mut(&room_id).unwrap();
                if room.access != RoomAccess::Private
                    || room.manages(target, self.identity.owner_id)
                {
                    return Err("forbidden");
                }
                room.grants.remove(&target);
                self.prune_access();
                broadcast = true;
            }
            Command::SetRoles {
                user_id: target,
                roles,
            } => {
                self.identity
                    .assign_roles(user_id, target, roles.into_iter().collect())?;
                if !self.identity.may_participate(target) {
                    let affected: Vec<_> = self
                        .identity
                        .sessions
                        .values()
                        .filter(|session| session.user_id == target)
                        .map(|session| session.id)
                        .collect();
                    for endpoint in affected {
                        self.retire_media(endpoint);
                    }
                }
                broadcast = true;
            }
            Command::Publish { publication: input } => {
                self.authorize(user_id, &input.room_id, RoomPermission::Write)?;
                let muted = if input.kind == Kind::Voice {
                    self.activity[&session_id]
                        .voice
                        .get(&input.room_id)
                        .ok_or("voice_not_joined")?
                        .muted
                } else {
                    input.muted
                };
                if let Some(publication) = self.publications.get_mut(&input.id) {
                    if publication.info.session_id != session_id
                        || publication.info.room_id != input.room_id
                        || publication.info.kind != input.kind
                    {
                        return Err("publication_identity_conflict");
                    }
                    publication.info.muted = muted;
                } else {
                    if self.publications.len() >= MAX_PUBLICATIONS {
                        return Err("publication_limit");
                    }
                    if self.publications.values().any(|publication| {
                        publication.info.session_id == session_id
                            && publication.info.room_id == input.room_id
                            && publication.info.kind == input.kind
                    }) {
                        return Err("source_already_published");
                    }
                    self.publications.insert(
                        input.id,
                        Publication {
                            info: PublicationInfo {
                                id: input.id,
                                room_id: input.room_id,
                                session_id,
                                user_id,
                                kind: input.kind,
                                muted,
                            },
                            plan: Plan::new(session_id),
                        },
                    );
                }
                broadcast = true;
            }
            Command::Unpublish { publication_id } => {
                if let Some(publication) = self.publications.get(&publication_id) {
                    if publication.info.session_id != session_id {
                        return Err("not_publication_owner");
                    }
                    self.publications.remove(&publication_id);
                    broadcast = true;
                }
            }
            Command::Subscribe {
                publication_id,
                enabled,
            } => {
                self.participate(user_id)?;
                let publication = self
                    .publications
                    .get(&publication_id)
                    .ok_or("publication_unavailable")?;
                if publication.info.kind != Kind::Screen
                    || publication.info.session_id == session_id
                {
                    return Err("invalid_subscription");
                }
                self.authorize(user_id, &publication.info.room_id, RoomPermission::Read)?;
                let activity = self.activity.get_mut(&session_id).unwrap();
                broadcast = if enabled {
                    activity.watching.insert(publication_id)
                } else {
                    activity.watching.remove(&publication_id)
                };
            }
            Command::Voice {
                room_id,
                joined,
                muted,
                deafened,
            } => {
                self.authorize(user_id, &room_id, RoomPermission::Write)?;
                if joined
                    && self
                        .activity
                        .values()
                        .map(|activity| activity.voice.len())
                        .sum::<usize>()
                        >= 160
                    && !self.activity[&session_id].voice.contains_key(&room_id)
                {
                    return Err("voice_limit");
                }
                let activity = self.activity.get_mut(&session_id).unwrap();
                if joined {
                    activity.voice.insert(
                        room_id.clone(),
                        VoiceInfo {
                            session_id,
                            room_id: room_id.clone(),
                            muted,
                            deafened,
                        },
                    );
                } else {
                    activity.voice.remove(&room_id);
                }
                self.publications.retain(|_, publication| {
                    publication.info.session_id != session_id
                        || publication.info.kind != Kind::Voice
                        || publication.info.room_id != room_id
                        || joined
                });
                for publication in self.publications.values_mut().filter(|publication| {
                    publication.info.session_id == session_id
                        && publication.info.kind == Kind::Voice
                        && publication.info.room_id == room_id
                }) {
                    publication.info.muted = muted;
                }
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
                            .publications
                            .get(&track.publication_id)
                            .is_some_and(|publication| {
                                publication.plan.parents.get(&peer) == Some(&session_id)
                            })
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
                    for publication in self.publications.values_mut() {
                        publication.plan.failed(session_id, peer);
                    }
                    self.pairs.remove(&pair_key(session_id, peer));
                    broadcast = true;
                }
            }
            Command::FlowState {
                publication_id,
                pair_id,
                ready,
            } => {
                let peer = self.peer(session_id, pair_id).ok_or("unassigned_pair")?;
                let publication = self
                    .publications
                    .get_mut(&publication_id)
                    .ok_or("publication_unavailable")?;
                if publication.plan.parents.get(&session_id) != Some(&peer) {
                    return Err("not_assigned_receiver");
                }
                broadcast = if ready {
                    publication.plan.mark_ready(session_id, peer)
                } else {
                    publication.plan.mark_unready(session_id, peer)
                };
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

    fn retire_session(&mut self, session_id: Uuid) {
        self.retire_media(session_id);
        self.activity.remove(&session_id);
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

    fn retire_media(&mut self, session_id: Uuid) {
        self.publications
            .retain(|_, publication| publication.info.session_id != session_id);
        if let Some(activity) = self.activity.get_mut(&session_id) {
            activity.watching.clear();
            activity.voice.clear();
        }
    }

    fn participate(&self, user_id: Uuid) -> Result<(), &'static str> {
        if self.identity.may_participate(user_id) {
            Ok(())
        } else {
            Err("forbidden")
        }
    }

    pub fn authorize(
        &self,
        user: Uuid,
        room_id: &str,
        permission: RoomPermission,
    ) -> Result<(), &'static str> {
        if !self.identity.users.contains_key(&user) {
            return Err("invalid_credential");
        }
        let room = self.rooms.get(room_id).ok_or("room_unavailable")?;
        if !room.reads(user, self.identity.owner_id) {
            return Err(if room.hidden {
                "room_unavailable"
            } else {
                "room_access_required"
            });
        }
        match permission {
            RoomPermission::Read => Ok(()),
            RoomPermission::Write => self.participate(user),
            RoomPermission::Manage if room.manages(user, self.identity.owner_id) => Ok(()),
            _ => Err("forbidden"),
        }
    }

    pub fn history_audience(&self, room_id: &str) -> Vec<Uuid> {
        self.activity
            .iter()
            .filter(|(_, activity)| activity.browse.as_deref() == Some(room_id))
            .filter_map(|(session, _)| self.identity.sessions[session].connection)
            .collect()
    }

    fn prune_access(&mut self) {
        let allowed: BTreeMap<_, BTreeSet<_>> = self
            .identity
            .sessions
            .values()
            .map(|session| {
                (
                    session.id,
                    self.rooms
                        .keys()
                        .filter(|id| {
                            self.authorize(session.user_id, id, RoomPermission::Read)
                                .is_ok()
                        })
                        .cloned()
                        .collect(),
                )
            })
            .collect();
        self.publications.retain(|_, publication| {
            allowed
                .get(&publication.info.session_id)
                .is_some_and(|rooms| rooms.contains(&publication.info.room_id))
        });
        for (session, activity) in &mut self.activity {
            let rooms = &allowed[session];
            if activity
                .browse
                .as_ref()
                .is_some_and(|id| !rooms.contains(id))
            {
                activity.browse = None;
            }
            activity.voice.retain(|id, _| rooms.contains(id));
            activity.watching.retain(|id| {
                self.publications
                    .get(id)
                    .is_some_and(|p| rooms.contains(&p.info.room_id))
            });
        }
    }

    fn desired(&self, session_id: Uuid) -> BTreeSet<Uuid> {
        let Some(activity) = self.activity.get(&session_id) else {
            return BTreeSet::new();
        };
        let mut subscriptions = activity.watching.clone();
        for publication in self.publications.values().filter(|publication| {
            publication.info.kind == Kind::Voice && publication.info.session_id != session_id
        }) {
            let room = &publication.info.room_id;
            if activity.voice.contains_key(room)
                && self
                    .activity
                    .get(&publication.info.session_id)
                    .is_some_and(|owner| owner.voice.contains_key(room))
            {
                subscriptions.insert(publication.info.id);
            }
        }
        subscriptions
    }

    fn reconcile(&mut self) {
        let published: BTreeSet<_> = self.publications.keys().copied().collect();
        for activity in self.activity.values_mut() {
            activity.watching.retain(|id| published.contains(id));
        }
        let requested: BTreeMap<_, _> = self
            .identity
            .sessions
            .keys()
            .map(|endpoint| (*endpoint, self.desired(*endpoint)))
            .collect();
        let available: BTreeSet<_> = self.identity.sessions.keys().copied().collect();
        let connected: BTreeSet<_> = self
            .identity
            .sessions
            .values()
            .filter(|session| session.connection.is_some())
            .map(|session| session.id)
            .collect();
        for (id, publication) in &mut self.publications {
            let subscribers = requested
                .iter()
                .filter_map(|(endpoint, ids)| ids.contains(id).then_some(*endpoint))
                .collect();
            publication
                .plan
                .reconcile(&subscribers, &available, &connected);
        }
        // Every physical pair carries the union of admitted publication flows.
        // Removal happens only after the final flow using that pair retires.
        let mut needed = BTreeSet::new();
        let mut outgoing: BTreeMap<Uuid, usize> = BTreeMap::new();
        for publication in self.publications.values_mut() {
            let excess: Vec<_> = publication
                .plan
                .parents
                .iter()
                .filter_map(|(child, parent)| {
                    let count = outgoing.entry(*parent).or_default();
                    *count += 1;
                    (*count > MAX_OUTGOING).then_some((*child, *parent))
                })
                .collect();
            for (child, parent) in excess {
                publication.plan.failed(child, parent);
            }
            for (child, parent) in &publication.plan.parents {
                needed.insert(pair_key(*child, *parent));
            }
        }
        self.pairs.retain(|key, _| needed.contains(key));
        for key in needed {
            self.pairs.entry(key).or_insert_with(Uuid::new_v4);
        }
    }

    pub fn export_state(&self) -> DurableState {
        DurableState {
            version: 2,
            id: self.id,
            owner_id: self.identity.owner_id,
            users: self.identity.export_users(),
            rooms: self.rooms.clone(),
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
        self.rooms = state.rooms;
        self.activity.clear();
        self.publications.clear();
        self.pairs.clear();
        Ok(())
    }

    pub fn peer(&self, endpoint: Uuid, pair_id: Uuid) -> Option<Uuid> {
        self.pairs.iter().find_map(|((first, second), id)| {
            if *id != pair_id {
                None
            } else if *first == endpoint {
                Some(*second)
            } else if *second == endpoint {
                Some(*first)
            } else {
                None
            }
        })
    }

    pub fn snapshot(&self, session_id: Uuid) -> Snapshot {
        let mut pairs = Vec::new();
        for ((first, second), id) in &self.pairs {
            let peer = if *first == session_id {
                *second
            } else if *second == session_id {
                *first
            } else {
                continue;
            };
            let mut outgoing = Vec::new();
            let mut incoming = Vec::new();
            for (publication_id, publication) in &self.publications {
                if publication.plan.parents.get(&peer) == Some(&session_id) {
                    outgoing.push(*publication_id);
                }
                if publication.plan.parents.get(&session_id) == Some(&peer) {
                    incoming.push(*publication_id);
                }
            }
            pairs.push(PairInfo {
                id: *id,
                peer_id: peer,
                outgoing,
                incoming,
            });
        }
        let user = self.identity.sessions.get(&session_id).map(|s| s.user_id);
        let reads = |room: &str| {
            user.is_some_and(|u| self.authorize(u, room, RoomPermission::Read).is_ok())
        };
        Snapshot {
            channel: ChannelInfo {
                history_window: HISTORY_WINDOW,
                id: self.id,
                name: "Piik friends".into(),
                owner_id: Some(self.identity.owner_id),
                rooms: user
                    .map(|u| {
                        self.rooms
                            .values()
                            .filter_map(|room| room.view(u, self.identity.owner_id))
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
                .publications
                .values()
                .filter(|publication| reads(&publication.info.room_id))
                .map(|publication| publication.info.clone())
                .collect(),
            voice: self
                .activity
                .values()
                .flat_map(|activity| {
                    activity
                        .voice
                        .values()
                        .filter(|voice| reads(&voice.room_id))
                        .cloned()
                })
                .collect(),
            subscriptions: self.desired(session_id).into_iter().collect(),
            pairs,
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

fn pair_key(first: Uuid, second: Uuid) -> PairKey {
    if first < second {
        (first, second)
    } else {
        (second, first)
    }
}

#[cfg(test)]
#[path = "channel_tests.rs"]
mod tests;
