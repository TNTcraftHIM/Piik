use crate::{
    access::{RoomPermission, RoomState},
    history::{HistoryRequest, HISTORY_WINDOW},
    host::{HostAction, HostOutput, RequestContext, RoomResult, RoomSummary},
    identity::{Admission, Admitted, Identity, StoredUser},
    remote::{Binding, RemoteRoom, ReplyOwner},
    room::RoomRuntime,
    transport::TransportBook,
    wire::*,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Local composition of domain admission, room runtimes and shared transports.
/// Browsing selects a presentation; it never owns another room's activities.
#[derive(Clone)]
pub struct Channel {
    pub identity: Identity,
    id: Uuid,
    rooms: BTreeMap<String, RoomRuntime>,
    pub(crate) remote: BTreeMap<String, RemoteRoom>,
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
            remote: BTreeMap::new(),
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
        if let Some(id) = self
            .command_room(&command)
            .filter(|id| self.rooms.contains_key(id))
        {
            if let Command::Publish { publication } = &command {
                if self
                    .publication_room(publication.id)
                    .is_some_and(|room| room.policy().id != id)
                {
                    return Err("publication_identity_conflict");
                }
            }
            let mut events = Vec::new();
            let history = match command {
                Command::RevokeRoomAccess { user_id, .. } => {
                    let target = self.identity.member(user_id)?;
                    self.room_mut(&id)?.revoke(member, target)?;
                    None
                }
                Command::FlowState {
                    publication_id,
                    pair_id,
                    ready,
                } => {
                    let peer = self.peer(session_id, pair_id).ok_or("unassigned_pair")?;
                    self.room_mut(&id)?
                        .flow_state(publication_id, session_id, peer, ready)?;
                    None
                }
                command => {
                    let operation = self
                        .room_mut(&id)?
                        .command(member, session_id, command, now, true)?;
                    if operation.browse {
                        self.browsing.insert(session_id, id.clone());
                    }
                    if let RoomResult::Invite { key } = operation.result {
                        events.push((
                            session_id,
                            Event::RoomInvite {
                                room_id: id,
                                key,
                                request_id: None,
                            },
                        ));
                    }
                    operation.history
                }
            };
            self.reconcile();
            return Ok(Outcome {
                events,
                broadcast: history.is_none(),
                leave: false,
                history,
            });
        }
        let mut events = Vec::new();
        let mut broadcast = false;
        let mut leave = false;
        let history = None;
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
            Command::HostRegister { .. }
            | Command::HostOutput { .. }
            | Command::HostStop { .. } => return Err("invalid_request"),
            Command::SetRoles {
                user_id: target,
                roles,
            } => {
                self.identity
                    .assign_roles(user_id, target, roles.into_iter().collect())?;
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
                    let affected: Vec<_> = self
                        .remote
                        .iter_mut()
                        .filter_map(|(id, room)| {
                            let projection = room.projection.as_mut()?;
                            let old = projection.flows.len();
                            projection.flows.retain(|flow| {
                                !((flow.sender == session_id && flow.receiver == peer)
                                    || (flow.sender == peer && flow.receiver == session_id))
                            });
                            (old != projection.flows.len()).then(|| id.clone())
                        })
                        .collect();
                    for id in affected {
                        if let Ok(event) = self.host_input(
                            &id,
                            HostAction::PairFailed {
                                first: session_id,
                                second: peer,
                            },
                        ) {
                            events.push(event);
                        }
                    }
                    broadcast = true;
                }
            }
            Command::Unpublish { .. } => {}
            Command::Subscribe { .. } | Command::FlowState { .. } => {
                return Err("publication_unavailable")
            }
            Command::Leave => {
                self.retire_session(session_id);
                broadcast = true;
                leave = true;
            }
            _ => return Err("room_unavailable"),
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

    pub(crate) fn retire_session(&mut self, session_id: Uuid) {
        for room in self.rooms.values_mut() {
            room.retire_session(session_id);
        }
        self.browsing.remove(&session_id);
        self.identity.sessions.remove(&session_id);
        for remote in self.remote.values_mut() {
            if remote
                .binding
                .as_ref()
                .is_some_and(|binding| binding.session == session_id)
            {
                remote.pause();
            }
        }
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
        if self.remote.contains_key(room_id) {
            return Err("attachments_unavailable");
        }
        self.room(room_id)?
            .authorize(self.identity.member(user)?, permission)
    }

    pub fn history_audience(&self, room_id: &str) -> Vec<Uuid> {
        self.browsing
            .iter()
            .filter(|(_, room)| room.as_str() == room_id)
            .filter(|(session, _)| {
                self.remote.get(room_id).is_none_or(|room| {
                    room.projection
                        .as_ref()
                        .and_then(|p| p.views.get(session))
                        .is_some_and(|view| view.room.authorized)
                })
            })
            .filter_map(|(session, _)| {
                self.identity
                    .sessions
                    .get(session)
                    .and_then(|session| session.connection)
            })
            .collect()
    }

    pub(crate) fn reconcile(&mut self) {
        let endpoints = self.identity.endpoints();
        for room in self.rooms.values_mut() {
            room.reconcile(&endpoints);
        }
        for room in self.remote.values_mut() {
            if let Some(projection) = &mut room.projection {
                projection
                    .views
                    .retain(|session, _| endpoints.contains_key(session));
                for view in projection.views.values_mut() {
                    view.publications.retain(|p| {
                        endpoints
                            .get(&p.session_id)
                            .is_some_and(|e| e.member.participates)
                    });
                    view.voice.retain(|v| {
                        endpoints
                            .get(&v.session_id)
                            .is_some_and(|e| e.member.participates)
                    });
                    view.subscriptions
                        .retain(|id| view.publications.iter().any(|p| p.id == *id));
                }
                projection.flows.retain(|flow| {
                    [flow.sender, flow.receiver]
                        .into_iter()
                        .all(|s| endpoints.get(&s).is_some_and(|e| e.member.participates))
                });
            }
        }
        self.browsing.retain(|session, id| {
            self.remote.contains_key(id)
                || self.rooms.get(id).is_some_and(|room| {
                    room.authorize(endpoints[session].member, RoomPermission::Read)
                        .is_ok()
                })
        });
        self.transports.reconcile(
            self.rooms.values().flat_map(|room| room.flows()).chain(
                self.remote
                    .values()
                    .filter(|room| room.binding.is_some())
                    .filter_map(|room| room.projection.as_ref())
                    .flat_map(|p| p.flows.iter().cloned()),
            ),
        );
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
            hosted_rooms: self
                .remote
                .iter()
                .map(|(id, room)| (id.clone(), room.summary.clone()))
                .collect(),
        }
    }

    pub fn import_state(&mut self, state: DurableState) -> Result<(), &'static str> {
        if state.version != 2 || state.rooms.len() + state.hosted_rooms.len() > 32 {
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
        self.remote = state
            .hosted_rooms
            .into_iter()
            .map(|(id, summary)| (id, RemoteRoom::restored(summary)))
            .collect();
        self.transports = TransportBook::default();
        Ok(())
    }

    pub fn peer(&self, endpoint: Uuid, pair_id: Uuid) -> Option<Uuid> {
        self.transports.peer(endpoint, pair_id)
    }

    pub(crate) fn command_room(&self, command: &Command) -> Option<String> {
        match command {
            Command::Browse { room_id }
            | Command::Chat { room_id, .. }
            | Command::History { room_id, .. }
            | Command::UpdateRoom { room_id, .. }
            | Command::EnterRoom { room_id, .. }
            | Command::RoomInvite { room_id }
            | Command::RevokeRoomAccess { room_id, .. }
            | Command::Voice { room_id, .. } => Some(room_id.clone()),
            Command::Publish { publication } => Some(publication.room_id.clone()),
            Command::Unpublish { publication_id }
            | Command::Subscribe { publication_id, .. }
            | Command::FlowState { publication_id, .. } => self
                .publication_room(*publication_id)
                .map(|room| room.policy().id.clone())
                .or_else(|| {
                    self.remote.iter().find_map(|(id, room)| {
                        room.projection
                            .as_ref()
                            .is_some_and(|p| {
                                p.views.values().any(|view| {
                                    view.publications.iter().any(|p| p.id == *publication_id)
                                })
                            })
                            .then(|| id.clone())
                    })
                }),
            _ => None,
        }
    }

    pub(crate) fn register_host(
        &mut self,
        session: Uuid,
        connection: Uuid,
        summary: RoomSummary,
        resume: Option<Uuid>,
    ) -> Result<(Uuid, Vec<(Uuid, Event)>), &'static str> {
        let member = self
            .identity
            .member(self.identity.sessions[&session].user_id)?;
        if summary.creator_id != member.user_id
            || (!self.remote.contains_key(&summary.id) && !member.participates)
        {
            return Err("forbidden");
        }
        if !valid_id(&summary.id)
            || summary.name.trim().is_empty()
            || summary.name.encode_utf16().count() > 64
        {
            return Err("invalid_room_name");
        }
        if self.rooms.contains_key(&summary.id) {
            return Err("room_identity_conflict");
        }
        if !self.remote.contains_key(&summary.id) && self.rooms.len() + self.remote.len() >= 32 {
            return Err("room_limit");
        }
        let room_id = summary.id.clone();
        let remote = self
            .remote
            .entry(room_id.clone())
            .or_insert_with(|| RemoteRoom::restored(summary.clone()));
        if remote.summary.creator_id != member.user_id {
            return Err("forbidden");
        }
        // A live owner in another page is not displaced by opening its local data.
        if remote.binding.as_ref().is_some_and(|binding| {
            binding.session != session
                && self
                    .identity
                    .sessions
                    .get(&binding.session)
                    .is_some_and(|s| s.connection.is_some())
        }) {
            return Err("room_already_hosted");
        }
        let continuing = remote
            .binding
            .as_ref()
            .is_some_and(|binding| binding.session == session && Some(binding.id) == resume);
        if continuing {
            remote.binding.as_mut().unwrap().connection = connection;
            remote.binding.as_mut().unwrap().replies.clear();
        } else {
            remote.binding = Some(Binding {
                id: Uuid::new_v4(),
                session,
                connection,
                revision: 0,
                minimum_revision: 0,
                replies: BTreeMap::new(),
            });
            remote.projection = None;
        }
        remote.summary = summary;
        let id = remote.binding.as_ref().unwrap().id;
        let mut events = vec![(
            session,
            Event::HostBound {
                room_id: room_id.clone(),
                binding_id: id,
            },
        )];
        events.push(self.host_input(&room_id, HostAction::Sync)?);
        let binding = self
            .remote
            .get_mut(&room_id)
            .unwrap()
            .binding
            .as_mut()
            .unwrap();
        binding.minimum_revision = binding.revision;
        self.reconcile();
        Ok((id, events))
    }

    pub(crate) fn host_input(
        &mut self,
        id: &str,
        action: HostAction,
    ) -> Result<(Uuid, Event), &'static str> {
        let endpoints = self.identity.endpoints();
        let remote = self.remote.get_mut(id).ok_or("room_unavailable")?;
        if !Self::host_online(&self.identity, remote) {
            return Err("room_host_offline");
        }
        let (session, input) = remote.input(endpoints, action)?;
        Ok((
            session,
            Event::HostInput {
                room_id: id.into(),
                input,
            },
        ))
    }

    pub(crate) fn forward_room(
        &mut self,
        id: &str,
        context: RequestContext,
        command: Command,
    ) -> Result<(Uuid, Event), &'static str> {
        let action = match command {
            Command::RevokeRoomAccess { user_id, .. } => HostAction::Revoke {
                context,
                target: self.identity.member(user_id)?,
            },
            Command::FlowState {
                publication_id,
                pair_id,
                ready,
            } => {
                let sender = self
                    .peer(context.session_id, pair_id)
                    .ok_or("unassigned_pair")?;
                HostAction::FlowState {
                    context,
                    publication_id,
                    sender,
                    ready,
                }
            }
            command => HostAction::Command { context, command },
        };
        self.host_input(id, action)
    }

    pub(crate) fn sync_hosts(&mut self, invalidate: bool) -> Vec<(Uuid, Event)> {
        let ids: Vec<_> = self.remote.keys().cloned().collect();
        ids.into_iter()
            .filter_map(|id| {
                let event = self.host_input(&id, HostAction::Sync).ok()?;
                if invalidate {
                    let binding = self.remote.get_mut(&id).unwrap().binding.as_mut().unwrap();
                    binding.minimum_revision = binding.revision;
                }
                Some(event)
            })
            .collect()
    }

    pub(crate) fn stop_host(
        &mut self,
        id: &str,
        session: Uuid,
        connection: Uuid,
        binding: Uuid,
    ) -> Result<(), &'static str> {
        let room = self.remote.get_mut(id).ok_or("room_unavailable")?;
        if !room
            .binding
            .as_ref()
            .is_some_and(|b| b.id == binding && b.session == session && b.connection == connection)
        {
            return Err("stale_room_host");
        }
        room.pause();
        self.reconcile();
        Ok(())
    }

    pub(crate) fn accept_host(
        &mut self,
        id: &str,
        session: Uuid,
        connection: Uuid,
        output: &HostOutput,
    ) -> Result<bool, &'static str> {
        let room = self.remote.get(id).ok_or("room_unavailable")?;
        let binding = room.binding.as_ref().ok_or("stale_room_host")?;
        if binding.id != output.binding_id
            || binding.session != session
            || binding.connection != connection
        {
            return Err("stale_room_host");
        }
        if output.revision > binding.revision {
            return Err("invalid_room_revision");
        }
        let reply_valid = match binding.replies.get(&output.revision) {
            Some(ReplyOwner::Request(context)) => {
                output
                    .reply
                    .as_ref()
                    .is_some_and(|reply| &reply.context == context)
                    && output.invitation.is_none()
            }
            Some(ReplyOwner::Invitation(ticket)) => {
                output
                    .invitation
                    .as_ref()
                    .is_some_and(|invitation| invitation.ticket == *ticket)
                    && output.reply.is_none()
            }
            None => output.reply.is_none() && output.invitation.is_none(),
        };
        if !reply_valid {
            return Err("invalid_room_reply");
        }
        let latest = output.revision >= binding.minimum_revision;
        self.remote
            .get_mut(id)
            .unwrap()
            .binding
            .as_mut()
            .unwrap()
            .replies
            .remove(&output.revision);
        let room = &self.remote[id];
        if !latest {
            return Ok(false);
        }
        let projection = &output.projection;
        if projection.summary.id != id || projection.summary.creator_id != room.summary.creator_id {
            return Err("invalid_room_projection");
        }
        // One room has at most two publications per authenticated endpoint.
        // Check its transport leases at the domain boundary, never trust a host to name another room's flows.
        let endpoints = self.identity.endpoints();
        if projection.views.len() > 20 || projection.flows.len() > 800 {
            return Err("invalid_room_projection");
        }
        for (recipient, view) in &projection.views {
            if !endpoints.contains_key(recipient)
                || view.room.id != id
                || view.room.creator_id != room.summary.creator_id
                || view.publications.len() > 40
                || view.voice.len() > 20
                || view.subscriptions.len() > 40
                || (!view.room.authorized
                    && (!view.publications.is_empty()
                        || !view.voice.is_empty()
                        || !view.subscriptions.is_empty()))
            {
                return Err("invalid_room_projection");
            }
            for publication in &view.publications {
                if publication.room_id != id
                    || !endpoints.get(&publication.session_id).is_some_and(|e| {
                        e.member.user_id == publication.user_id && e.member.participates
                    })
                    || self.publication_room(publication.id).is_some()
                    || self.remote.iter().any(|(other_id, other)| {
                        other_id != id
                            && other.projection.as_ref().is_some_and(|p| {
                                p.views
                                    .values()
                                    .any(|v| v.publications.iter().any(|p| p.id == publication.id))
                            })
                    })
                {
                    return Err("invalid_room_projection");
                }
            }
        }
        for flow in &projection.flows {
            if flow.sender == flow.receiver
                || !endpoints.contains_key(&flow.sender)
                || !endpoints.contains_key(&flow.receiver)
                || !projection.views.get(&flow.sender).is_some_and(|v| {
                    v.room.authorized && v.publications.iter().any(|p| p.id == flow.publication_id)
                })
                || !projection.views.get(&flow.receiver).is_some_and(|v| {
                    v.room.authorized && v.publications.iter().any(|p| p.id == flow.publication_id)
                })
            {
                return Err("invalid_room_projection");
            }
        }
        if latest {
            let room = self.remote.get_mut(id).unwrap();
            room.summary = projection.summary.clone();
            let mut projection = projection.clone();
            for view in projection.views.values_mut() {
                view.room.capabilities.attachments = false;
                view.room.available = true;
            }
            room.projection = Some(projection);
            self.reconcile();
        }
        Ok(latest)
    }

    pub(crate) fn browse_remote(&mut self, session: Uuid, id: &str) {
        self.browsing.insert(session, id.into());
    }

    fn host_online(identity: &Identity, room: &RemoteRoom) -> bool {
        room.binding.as_ref().is_some_and(|b| {
            identity
                .sessions
                .get(&b.session)
                .is_some_and(|s| s.connection == Some(b.connection))
        })
    }

    pub fn snapshot(&self, session_id: Uuid) -> Snapshot {
        let member = self
            .identity
            .sessions
            .get(&session_id)
            .and_then(|session| self.identity.member(session.user_id).ok());
        let mut rooms = Vec::new();
        let mut publications = Vec::new();
        let mut voice = Vec::new();
        let mut subscriptions = BTreeSet::new();
        if let Some(member) = member {
            for room in self.rooms.values() {
                if let Some(snapshot) = room.snapshot(member, session_id) {
                    rooms.push(snapshot.room);
                    publications.extend(snapshot.publications);
                    voice.extend(snapshot.voice);
                    subscriptions.extend(snapshot.subscriptions);
                }
            }
            for room in self.remote.values() {
                if let Some(snapshot) =
                    room.snapshot(member, session_id, Self::host_online(&self.identity, room))
                {
                    rooms.push(snapshot.room);
                    publications.extend(snapshot.publications);
                    voice.extend(snapshot.voice);
                    subscriptions.extend(snapshot.subscriptions);
                }
            }
        }
        Snapshot {
            channel: ChannelInfo {
                history_window: HISTORY_WINDOW,
                id: self.id,
                name: "Piik friends".into(),
                owner_id: Some(self.identity.owner_id),
                rooms,
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
            publications,
            voice,
            subscriptions: subscriptions.into_iter().collect(),
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
    #[serde(default)]
    hosted_rooms: BTreeMap<String, RoomSummary>,
}

impl DurableState {
    pub(crate) fn omit_users(&mut self, pending: impl Iterator<Item = Uuid>) {
        let pending: BTreeSet<_> = pending.collect();
        self.users.retain(|user| !pending.contains(&user.id));
    }
}

#[cfg(test)]
#[path = "channel_tests.rs"]
mod tests;
