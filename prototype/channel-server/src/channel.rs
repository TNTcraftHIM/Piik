use crate::{
    identity::{Admission, Admitted, Identity},
    routes::Plan,
    wire::*,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use uuid::Uuid;

const MAX_PUBLICATIONS: usize = 80;
const MAX_OUTGOING: usize = 160;

#[derive(Default)]
struct Activity {
    browse: Option<String>,
    watching: BTreeSet<Uuid>,
    voice: BTreeMap<String, VoiceInfo>,
}

struct Publication {
    info: PublicationInfo,
    plan: Plan,
}
type PairKey = (Uuid, Uuid);

pub struct Channel {
    pub identity: Identity,
    id: Uuid,
    rooms: BTreeMap<String, Room>,
    activity: BTreeMap<Uuid, Activity>,
    publications: BTreeMap<Uuid, Publication>,
    history: BTreeMap<String, VecDeque<ChatMessage>>,
    nonces: BTreeMap<Uuid, VecDeque<(String, String)>>,
    pairs: BTreeMap<PairKey, Uuid>,
    ice_servers: Vec<Value>,
}

pub struct Outcome {
    pub events: Vec<(Uuid, Event)>,
    pub broadcast: bool,
    pub leave: bool,
}

impl Channel {
    pub fn new(owner_key: String, invite_key: String, ice_servers: Vec<Value>) -> Self {
        let rooms = [
            ("living", "Living room"),
            ("studio", "Studio"),
            ("quiet", "Quiet corner"),
        ]
        .into_iter()
        .map(|(id, name)| {
            (
                id.to_owned(),
                Room {
                    id: id.to_owned(),
                    name: name.to_owned(),
                },
            )
        })
        .collect();
        Self {
            identity: Identity::new(owner_key, invite_key),
            id: Uuid::new_v4(),
            rooms,
            activity: BTreeMap::new(),
            publications: BTreeMap::new(),
            history: BTreeMap::new(),
            nonces: BTreeMap::new(),
            pairs: BTreeMap::new(),
            ice_servers,
        }
    }

    pub fn join(
        &mut self,
        input: Admission<'_>,
        connection: Uuid,
        now: u64,
    ) -> Result<Admitted, &'static str> {
        let admitted = self.identity.admit(input, connection, now)?;
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
                self.room(&room_id)?;
                self.activity.get_mut(&session_id).unwrap().browse = Some(room_id.clone());
                events.push((
                    session_id,
                    Event::History {
                        messages: self
                            .history
                            .get(&room_id)
                            .map(|items| items.iter().cloned().collect())
                            .unwrap_or_default(),
                        room_id,
                    },
                ));
            }
            Command::Chat {
                room_id,
                text,
                nonce,
            } => {
                self.participate(user_id)?;
                self.room(&room_id)?;
                if text.trim().is_empty() || text.chars().count() > 2000 || !valid_id(&nonce) {
                    return Err("invalid_message");
                }
                let nonces = self.nonces.entry(user_id).or_default();
                if !nonces
                    .iter()
                    .any(|(room, seen)| room == &room_id && seen == &nonce)
                {
                    nonces.push_back((room_id.clone(), nonce));
                    if nonces.len() > 256 {
                        nonces.pop_front();
                    }
                    let message = ChatMessage {
                        id: Uuid::new_v4(),
                        user_id,
                        text: text.trim().to_owned(),
                        time: now,
                    };
                    let history = self.history.entry(room_id.clone()).or_default();
                    history.push_back(message.clone());
                    if history.len() > 100 {
                        history.pop_front();
                    }
                    for (endpoint, state) in &self.activity {
                        if state.browse.as_deref() == Some(room_id.as_str()) {
                            events.push((
                                *endpoint,
                                Event::Message {
                                    room_id: room_id.clone(),
                                    message: message.clone(),
                                },
                            ));
                        }
                    }
                }
            }
            Command::CreateRoom { name } => {
                if !self.identity.may_manage(user_id) {
                    return Err("forbidden");
                }
                let name = name.trim();
                if name.is_empty() || name.encode_utf16().count() > 64 {
                    return Err("invalid_room_name");
                }
                if self.rooms.len() >= 32 {
                    return Err("room_limit");
                }
                let id = Uuid::new_v4().to_string();
                self.rooms.insert(
                    id.clone(),
                    Room {
                        id,
                        name: name.to_owned(),
                    },
                );
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
                self.participate(user_id)?;
                self.room(&input.room_id)?;
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
                self.participate(user_id)?;
                self.room(&room_id)?;
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
                self.remove_session(session_id);
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
        })
    }

    pub fn remove_session(&mut self, session_id: Uuid) {
        self.retire_media(session_id);
        self.activity.remove(&session_id);
        self.identity.sessions.remove(&session_id);
        self.reconcile();
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

    fn room(&self, room_id: &str) -> Result<(), &'static str> {
        if self.rooms.contains_key(room_id) {
            Ok(())
        } else {
            Err("unknown_room")
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
        Snapshot {
            channel: ChannelInfo {
                id: self.id,
                name: "Piik friends".into(),
                owner_id: Some(self.identity.owner_id),
                rooms: self.rooms.values().cloned().collect(),
                roles: vec![
                    RoleInfo {
                        id: "member",
                        name: "Member",
                        permissions: vec!["chat", "publish", "subscribe", "voice"],
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
                .map(|publication| publication.info.clone())
                .collect(),
            voice: self
                .activity
                .values()
                .flat_map(|activity| activity.voice.values().cloned())
                .collect(),
            subscriptions: self.desired(session_id).into_iter().collect(),
            pairs,
            ice_servers: self.ice_servers.clone(),
        }
    }
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
