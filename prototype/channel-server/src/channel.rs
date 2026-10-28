use crate::{
    access::{RoomPermission, RoomState},
    history::{HistoryRequest, HISTORY_WINDOW},
    host::{HostAction, HostOutput, RequestContext, RoomResult, RoomSummary},
    identity::{Admission, Admitted, Identity, StoredUser},
    remote::{Binding, RemoteRoom, ReplyOwner},
    room::RoomRuntime,
    transport::{Flow, TransportBook},
    wire::*,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use uuid::Uuid;

/// Local composition of domain admission, room runtimes and shared transports.
/// Browsing selects a presentation; it never owns another room's activities.
#[derive(Clone)]
pub struct Channel {
    pub identity: Identity,
    id: Uuid,
    rooms: BTreeMap<String, RoomRuntime>,
    pub(crate) remote: BTreeMap<String, RemoteRoom>,
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
            let reading_changed = matches!(&command, Command::Browse { .. });
            let mut events = Vec::new();
            let history = match command {
                Command::RevokeRoomAccess { user_id, .. } => {
                    let target = self.identity.member(user_id)?;
                    self.room_mut(&id)?.revoke(member, target)?;
                    None
                }
                Command::FlowState {
                    flow_id,
                    pair_id,
                    ready,
                } => {
                    let flow = self
                        .flow_direction(session_id, pair_id, flow_id, ready)
                        .ok_or("unassigned_flow")?;
                    self.room_mut(&id)?
                        .flow_state(flow.id, flow.receiver, flow.sender, ready)?;
                    None
                }
                command => {
                    let operation = self
                        .room_mut(&id)?
                        .command(member, session_id, command, now)?;
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
                broadcast: reading_changed || history.is_none(),
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
                            .flow(pair_id, track.flow_id)
                            .is_some_and(|flow| flow.sender == session_id)
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
                            let old_base = projection.base_links.len();
                            projection.flows.retain(|flow| {
                                !((flow.sender == session_id && flow.receiver == peer)
                                    || (flow.sender == peer && flow.receiver == session_id))
                            });
                            projection.base_links.retain(|link| {
                                !((link.parent == session_id && link.child == peer)
                                    || (link.parent == peer && link.child == session_id))
                            });
                            (old != projection.flows.len()
                                || old_base != projection.base_links.len())
                            .then(|| id.clone())
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
        self.identity
            .sessions
            .values()
            .filter(|session| {
                if let Some(room) = self.rooms.get(room_id) {
                    room.reading(session.id)
                        && self.identity.member(session.user_id).is_ok_and(|member| {
                            room.authorize(member, RoomPermission::Read).is_ok()
                        })
                } else {
                    self.remote
                        .get(room_id)
                        .and_then(|room| room.projection.as_ref())
                        .and_then(|projection| projection.views.get(&session.id))
                        .is_some_and(|view| view.room.authorized && view.room.reading)
                }
            })
            .filter_map(|session| session.connection)
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
                let readable_sessions: BTreeSet<_> = projection
                    .views
                    .iter()
                    .filter_map(|(session, view)| view.room.authorized.then_some(*session))
                    .collect();
                for view in projection.views.values_mut() {
                    for file in &mut view.files {
                        if file
                            .source_id
                            .is_some_and(|source| !readable_sessions.contains(&source))
                        {
                            file.source_id = None;
                            file.upstream = None;
                            file.downstream.clear();
                        }
                        if file
                            .upstream
                            .is_some_and(|peer| !readable_sessions.contains(&peer))
                        {
                            file.upstream = None;
                        }
                        file.downstream
                            .retain(|peer| readable_sessions.contains(peer));
                    }
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
                    [flow.sender, flow.receiver].into_iter().all(|s| {
                        projection.views.get(&s).is_some_and(|view| {
                            view.publications
                                .iter()
                                .any(|p| p.id == flow.publication_id)
                        })
                    })
                });
                projection.base_links.retain(|link| {
                    [link.parent, link.child].into_iter().all(|s| {
                        projection
                            .views
                            .get(&s)
                            .is_some_and(|view| view.room.authorized)
                    })
                });
            }
        }
        self.transports.reconcile(
            self.rooms.values().flat_map(|room| room.flows()).chain(
                self.remote
                    .values()
                    .filter(|room| room.binding.is_some())
                    .filter_map(|room| room.projection.as_ref())
                    .flat_map(|p| p.flows.iter().cloned()),
            ),
            self.rooms
                .values()
                .flat_map(|room| room.base_links())
                .chain(
                    self.remote
                        .values()
                        .filter(|room| room.binding.is_some())
                        .filter_map(|room| room.projection.as_ref())
                        .flat_map(|projection| projection.base_links.iter().cloned()),
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
            Command::Browse { room_id, .. }
            | Command::BaseState { room_id, .. }
            | Command::Chat { room_id, .. }
            | Command::FileOffer { room_id, .. }
            | Command::FileReceive { room_id, .. }
            | Command::History { room_id, .. }
            | Command::UpdateRoom { room_id, .. }
            | Command::EnterRoom { room_id, .. }
            | Command::RoomInvite { room_id }
            | Command::RevokeRoomAccess { room_id, .. }
            | Command::Voice { room_id, .. } => Some(room_id.clone()),
            Command::Publish { publication } => Some(publication.room_id.clone()),
            Command::Unpublish { publication_id } | Command::Subscribe { publication_id, .. } => {
                self.publication_room_id(*publication_id)
            }
            Command::FlowState {
                flow_id, pair_id, ..
            } => self
                .transports
                .flow(*pair_id, *flow_id)
                .and_then(|flow| self.publication_room_id(flow.publication_id)),
            _ => None,
        }
    }

    fn publication_room_id(&self, publication_id: Uuid) -> Option<String> {
        self.publication_room(publication_id)
            .map(|room| room.policy().id.clone())
            .or_else(|| {
                self.remote.iter().find_map(|(id, room)| {
                    room.projection
                        .as_ref()
                        .is_some_and(|projection| {
                            projection.views.values().any(|view| {
                                view.publications
                                    .iter()
                                    .any(|publication| publication.id == publication_id)
                            })
                        })
                        .then(|| id.clone())
                })
            })
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
            Command::Chat { .. } | Command::History { .. } => {
                return Err("room_data_channel_required");
            }
            Command::BaseState {
                room_id,
                pair_id,
                ready,
            } => {
                let peer = self
                    .peer(context.session_id, pair_id)
                    .ok_or("unassigned_pair")?;
                if !self.transports.serves_room(pair_id, &room_id) {
                    return Err("not_assigned_base");
                }
                HostAction::BaseState {
                    context,
                    peer,
                    ready,
                }
            }
            Command::RevokeRoomAccess { user_id, .. } => HostAction::Revoke {
                context,
                target: self.identity.member(user_id)?,
            },
            Command::FlowState {
                flow_id,
                pair_id,
                ready,
            } => {
                let flow = self
                    .flow_direction(context.session_id, pair_id, flow_id, ready)
                    .ok_or("unassigned_flow")?;
                HostAction::FlowState {
                    context,
                    flow_id,
                    sender: flow.sender,
                    receiver: flow.receiver,
                    ready,
                }
            }
            command => HostAction::Command { context, command },
        };
        self.host_input(id, action)
    }

    fn flow_direction(
        &self,
        reporter: Uuid,
        pair: Uuid,
        flow_id: Uuid,
        ready: bool,
    ) -> Option<Flow> {
        let flow = self.transports.flow(pair, flow_id)?;
        (flow.receiver == reporter || (!ready && flow.sender == reporter)).then_some(flow)
    }

    pub(crate) fn current_report(&self, session: Uuid, command: &Command) -> bool {
        match command {
            Command::BaseState {
                room_id, pair_id, ..
            } => {
                self.peer(session, *pair_id).is_some()
                    && self.transports.serves_room(*pair_id, room_id)
            }
            Command::FlowState {
                flow_id,
                pair_id,
                ready,
            } => self
                .flow_direction(session, *pair_id, *flow_id, *ready)
                .is_some(),
            Command::LinkState { pair_id, .. } => self.peer(session, *pair_id).is_some(),
            _ => true,
        }
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
        if projection.views.len() > 20
            || projection.flows.len() > 800
            || projection.base_links.len() > 19
        {
            return Err("invalid_room_projection");
        }
        for (recipient, view) in &projection.views {
            if !endpoints.contains_key(recipient)
                || view.room.id != id
                || view.room.creator_id != room.summary.creator_id
                || view.publications.len() > 40
                || view.voice.len() > 20
                || view.subscriptions.len() > 40
                || view.files.len() > HISTORY_WINDOW
                || (!view.room.authorized
                    && (view.room.reading
                        || !view.publications.is_empty()
                        || !view.voice.is_empty()
                        || !view.subscriptions.is_empty()
                        || !view.files.is_empty()))
            {
                return Err("invalid_room_projection");
            }
            for file in &view.files {
                let neighbor = |peer: Uuid| {
                    peer != *recipient
                        && projection.base_links.iter().any(|link| {
                            (link.parent == *recipient && link.child == peer)
                                || (link.child == *recipient && link.parent == peer)
                        })
                };
                if file.room_id != id
                    || file.message_seq == 0
                    || file.attachment.validate().is_err()
                    || file.downstream.len() > 19
                    || file.downstream.iter().collect::<BTreeSet<_>>().len()
                        != file.downstream.len()
                    || file.source_id.is_some_and(|source| {
                        !projection
                            .views
                            .get(&source)
                            .is_some_and(|view| view.room.authorized)
                    })
                    || file.upstream.is_some_and(|peer| !neighbor(peer))
                    || file.downstream.iter().any(|peer| !neighbor(*peer))
                {
                    return Err("invalid_room_projection");
                }
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
        let mut flow_ids: BTreeSet<_> = self
            .rooms
            .values()
            .flat_map(RoomRuntime::flows)
            .map(|flow| flow.id)
            .chain(
                self.remote
                    .iter()
                    .filter(|(other, _)| other.as_str() != id)
                    .filter_map(|(_, room)| room.projection.as_ref())
                    .flat_map(|projection| projection.flows.iter().map(|flow| flow.id)),
            )
            .collect();
        for flow in &projection.flows {
            if !flow_ids.insert(flow.id)
                || flow.sender == flow.receiver
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
        for link in &projection.base_links {
            if link.room_id != id
                || link.parent == link.child
                || ![link.parent, link.child].into_iter().all(|s| {
                    projection
                        .views
                        .get(&s)
                        .is_some_and(|view| view.room.authorized)
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
                view.room.available = true;
            }
            room.projection = Some(projection);
            self.reconcile();
        }
        Ok(latest)
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
        let mut files = Vec::new();
        let mut subscriptions = BTreeSet::new();
        if let Some(member) = member {
            for room in self.rooms.values() {
                if let Some(snapshot) = room.snapshot(member, session_id) {
                    rooms.push(snapshot.room);
                    publications.extend(snapshot.publications);
                    voice.extend(snapshot.voice);
                    files.extend(snapshot.files);
                    subscriptions.extend(snapshot.subscriptions);
                }
            }
            for room in self.remote.values() {
                if let Some(mut snapshot) =
                    room.snapshot(member, session_id, Self::host_online(&self.identity, room))
                {
                    snapshot.room.delivery = if snapshot.room.authorized && snapshot.room.available
                    {
                        room.binding.as_ref().zip(room.projection.as_ref()).map(
                            |(binding, projection)| RoomDelivery {
                                host_session_id: binding.session,
                                binding_id: binding.id,
                                next_hops: room_next_hops(session_id, &projection.base_links),
                            },
                        )
                    } else {
                        None
                    };
                    rooms.push(snapshot.room);
                    publications.extend(snapshot.publications);
                    voice.extend(snapshot.voice);
                    files.extend(snapshot.files);
                    subscriptions.extend(snapshot.subscriptions);
                }
            }
        }
        Snapshot {
            files,
            channel: ChannelInfo {
                history_window: HISTORY_WINDOW,
                id: self.id,
                name: "Piik friends".into(),
                owner_id: Some(self.identity.owner_id),
                rooms,
                roles: vec![
                    RoleInfo {
                        id: "member".into(),
                        name: "Member".into(),
                        permissions: ["chat", "publish", "subscribe", "voice", "create_room"]
                            .map(String::from)
                            .into(),
                    },
                    RoleInfo {
                        id: "moderator".into(),
                        name: "Moderator".into(),
                        permissions: ["chat", "publish", "subscribe", "voice", "create_room"]
                            .map(String::from)
                            .into(),
                    },
                ],
            },
            users: self
                .identity
                .users
                .values()
                .map(|user| UserInfo {
                    id: user.id,
                    name: user.name.clone(),
                    roles: user.roles.clone(),
                })
                .collect(),
            sessions: self
                .identity
                .sessions
                .values()
                .map(|session| SessionInfo {
                    id: session.id,
                    user_id: session.user_id,
                    online: session.connection.is_some(),
                    signing_key: session.signing_key,
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

fn room_next_hops(session: Uuid, links: &[crate::transport::BaseLink]) -> BTreeMap<Uuid, Uuid> {
    let mut result = BTreeMap::new();
    let mut pending = VecDeque::from([(session, session)]);
    while let Some((current, first)) = pending.pop_front() {
        for link in links {
            let next = if link.parent == current {
                link.child
            } else if link.child == current {
                link.parent
            } else {
                continue;
            };
            if next == session || result.contains_key(&next) {
                continue;
            }
            let first = if current == session { next } else { first };
            result.insert(next, first);
            pending.push_back((next, first));
        }
    }
    result
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
