use crate::{
    history::HISTORY_WINDOW,
    host::{HostAction, HostOutput, RequestContext, RoomReply, RoomResult, RoomSummary},
    identity::{Admission, Admitted, Identity, StoredUser},
    remote::{Binding, RemoteRoom, ReplyOwner, RetiredRoomReply},
    transport::{Flow, TransportBook},
    wire::*,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use uuid::Uuid;

/// Domain admission, hosted-room directory and shared transport leases.
/// Browsing selects a presentation; it never owns another room's activities.
#[derive(Clone)]
pub struct Channel {
    pub identity: Identity,
    pub(crate) now: u64,
    id: Uuid,
    name: String,
    icon: IdentityIcon,
    pub(crate) remote: BTreeMap<String, RemoteRoom>,
    transports: TransportBook,
    input_registrations: BTreeMap<Uuid, Vec<crate::input::InputRegistration>>,
    ice_servers: Vec<Value>,
}

pub(crate) struct HostAcceptance {
    pub projection_applied: bool,
    pub invitation_current: bool,
    pub replies: Vec<RoomReply>,
}

pub struct Outcome {
    pub events: Vec<(Uuid, Event)>,
    pub replies: Vec<RetiredRoomReply>,
    pub broadcast: bool,
    pub leave: bool,
}

impl Channel {
    fn can_prepare_udp(&self, first: Uuid, second: Uuid) -> bool {
        crate::udp::stun_servers(&self.ice_servers).is_some()
            && [first, second].into_iter().all(|id| {
                self.identity
                    .sessions
                    .get(&id)
                    .is_some_and(|session| session.connection.is_some() && session.can_prepare_udp)
            })
    }
    pub(crate) fn identity(&self) -> (Uuid, Uuid) {
        (self.id, self.identity.owner_id)
    }

    pub fn new(owner_key: String, invite_key: String, ice_servers: Vec<Value>) -> Self {
        let identity = Identity::new(owner_key, invite_key);
        Self {
            identity,
            now: 0,
            id: Uuid::new_v4(),
            name: "Piik friends".into(),
            icon: IdentityIcon::default(),
            remote: BTreeMap::new(),
            transports: TransportBook::default(),
            input_registrations: BTreeMap::new(),
            ice_servers,
        }
    }

    pub fn join(
        &mut self,
        input: Admission<'_>,
        connection: Uuid,
        now: u64,
    ) -> Result<Admitted, &'static str> {
        self.now = now;
        let admitted = self.identity.admit(input, connection, now)?;
        self.reconcile();
        Ok(admitted)
    }

    pub fn handle(
        &mut self,
        session_id: Uuid,
        command: Command,
        now: u64,
    ) -> Result<Outcome, &'static str> {
        self.now = now;
        let user_id = self
            .identity
            .sessions
            .get(&session_id)
            .ok_or("session_expired")?
            .user_id;
        let mut events = Vec::new();
        let mut broadcast = false;
        let mut leave = false;
        let mut replies = Vec::new();
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
            Command::UpdateDomain {
                name,
                icon,
                access,
                password,
            } => {
                if user_id != self.identity.owner_id {
                    return Err("forbidden");
                }
                let name = title(&name).ok_or("invalid_domain_name")?;
                self.identity.update_admission(access, password)?;
                self.name = name;
                self.icon = icon;
                broadcast = true;
            }
            Command::HostRegister { .. }
            | Command::Conversation { .. }
            | Command::DomainInvite {}
            | Command::CreateRoom { .. }
            | Command::AdmitRoom { .. }
            | Command::DeleteRoom { .. }
            | Command::HostOutput { .. }
            | Command::HostStop { .. } => return Err("invalid_request"),
            Command::Signal {
                pair_id,
                mut payload,
            } => {
                if !payload.valid() {
                    return Err("invalid_signal");
                }
                let peer = self.peer(session_id, pair_id).ok_or("unassigned_pair")?;
                if let Some(udp) = &payload.udp {
                    if !self.transports.prepared(pair_id)
                        || !match udp {
                            UdpSignal::Offer { .. } => session_id < peer,
                            UdpSignal::Answer { .. } => session_id > peer,
                            UdpSignal::Complete => true,
                        }
                    {
                        return Err("invalid_signal");
                    }
                }
                if let Some(tracks) = &mut payload.tracks {
                    // Retired media cannot bind a stream, but must not discard
                    // an in-flight SDP exchange for this still-admitted pair.
                    tracks.retain(|track| {
                        self.transports
                            .flow(pair_id, track.flow_id)
                            .is_some_and(|flow| flow.sender == session_id)
                    });
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
            Command::InputRegister {
                publication_id,
                flow_id,
                secret,
            } => {
                let source = self
                    .input_source(session_id, publication_id, flow_id)
                    .ok_or("unassigned_input_route")?;
                let registrations = self.input_registrations.entry(source).or_default();
                registrations.retain(|r| {
                    r.publication_id != publication_id || r.controller_session_id != session_id
                });
                registrations.push(crate::input::InputRegistration {
                    publication_id,
                    controller_session_id: session_id,
                    flow_id,
                    secret,
                });
                events.extend(self.input_states());
            }
            Command::LinkState { pair_id, state } => {
                let peer = self.peer(session_id, pair_id).ok_or("unassigned_pair")?;
                if matches!(state, LinkState::Connected) {
                    self.transports.connected(pair_id);
                } else if self.can_prepare_udp(session_id, peer) && self.transports.prepare(pair_id)
                {
                    broadcast = true;
                } else {
                    self.transports.retire(pair_id);
                    let affected: Vec<_> = self
                        .remote
                        .iter_mut()
                        .filter_map(|(id, room)| {
                            room.failed_pair(session_id, peer).then(|| id.clone())
                        })
                        .collect();
                    for id in affected {
                        if let Ok(event) = self.host_input(&id, HostAction::Sync) {
                            events.push(event);
                        }
                    }
                    broadcast = true;
                }
            }
            Command::Unpublish { .. } => {}
            Command::Subscribe { .. }
            | Command::SetPaused { .. }
            | Command::TransferSource { .. }
            | Command::FlowState { .. } => return Err("publication_unavailable"),
            Command::Leave => {
                replies = self.retire_session(session_id);
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
            replies,
            broadcast,
            leave,
        })
    }

    pub(crate) fn retire_session(&mut self, session_id: Uuid) -> Vec<RetiredRoomReply> {
        self.identity.sessions.remove(&session_id);
        let mut replies = Vec::new();
        for remote in self.remote.values_mut() {
            if remote
                .binding
                .as_ref()
                .is_some_and(|binding| binding.session == session_id)
            {
                replies.extend(remote.pause());
            }
        }
        replies
    }

    pub fn expire_sessions(&mut self, now: u64) -> (bool, Vec<RetiredRoomReply>) {
        let expired = self.identity.expired(now);
        if expired.is_empty() {
            return (false, Vec::new());
        }
        let mut replies = Vec::new();
        for session_id in expired {
            replies.extend(self.retire_session(session_id));
        }
        self.reconcile();
        (true, replies)
    }

    pub(crate) fn reconcile(&mut self) {
        let endpoints = self.identity.endpoints();
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
                    view.publications
                        .retain(|p| readable_sessions.contains(&p.session_id));
                    for publication in &mut view.publications {
                        publication
                            .audience
                            .retain(|viewer| readable_sessions.contains(&viewer.session_id));
                    }
                    view.voice
                        .retain(|v| readable_sessions.contains(&v.session_id));
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
            self.remote
                .values()
                .filter(|room| room.binding.is_some())
                .filter_map(|room| room.projection.as_ref())
                .flat_map(|projection| projection.flows.iter().cloned()),
            self.remote
                .values()
                .filter(|room| room.binding.is_some())
                .filter_map(|room| room.projection.as_ref())
                .flat_map(|projection| projection.base_links.iter().cloned()),
        );
    }

    pub fn export_state(&self) -> DurableState {
        DurableState {
            version: 4,
            id: self.id,
            name: self.name.clone(),
            icon: self.icon.clone(),
            owner_id: self.identity.owner_id,
            access: self.identity.access,
            password_hash: self.identity.password_hash.clone(),
            users: self.identity.export_users(),
            hosted_rooms: self
                .remote
                .iter()
                .map(|(id, room)| (id.clone(), room.summary.clone()))
                .collect(),
        }
    }

    fn input_source(&self, controller: Uuid, publication: Uuid, flow: Uuid) -> Option<Uuid> {
        self.identity.sessions.get(&controller)?;
        self.remote
            .values()
            .filter(|room| room.binding.is_some())
            .find_map(|room| {
                let projection = room.projection.as_ref()?;
                let view = projection.views.get(&controller)?;
                if !view.room.authorized || !view.subscriptions.contains(&publication) {
                    return None;
                }
                let source = view
                    .publications
                    .iter()
                    .find(|p| p.id == publication && p.kind == Kind::Screen)?
                    .session_id;
                projection
                    .flows
                    .iter()
                    .any(|f| {
                        f.id == flow
                            && f.publication_id == publication
                            && f.receiver == controller
                            && f.selected
                    })
                    .then_some(source)
            })
    }

    // Secrets have only this private source-directed event, never room-host work,
    // public snapshots or the durable directory.
    pub(crate) fn input_states(&mut self) -> Vec<(Uuid, Event)> {
        let mut events = Vec::new();
        for (source, mut registrations) in std::mem::take(&mut self.input_registrations) {
            registrations.retain(|r| {
                self.input_source(r.controller_session_id, r.publication_id, r.flow_id)
                    == Some(source)
            });
            events.push((
                source,
                Event::InputState {
                    registrations: registrations.clone(),
                },
            ));
            if !registrations.is_empty() {
                self.input_registrations.insert(source, registrations);
            }
        }
        events
    }

    pub fn import_state(&mut self, state: DurableState) -> Result<(), &'static str> {
        if state.version != 4 || state.hosted_rooms.len() > 32 {
            return Err("invalid_state");
        }
        let mut identity = Identity::new(
            self.identity.owner_key.clone(),
            self.identity.invite_key.clone(),
        );
        if (state.access == RoomAccess::Public && state.password_hash.is_some())
            || state
                .password_hash
                .as_ref()
                .is_some_and(|hash| argon2::password_hash::PasswordHash::new(hash).is_err())
        {
            return Err("invalid_state");
        }
        identity.access = state.access;
        identity.password_hash = state.password_hash;
        identity.restore_users(state.owner_id, state.users)?;
        let name = title(&state.name).ok_or("invalid_state")?;
        self.identity = identity;
        self.id = state.id;
        self.name = name;
        self.icon = state.icon;
        self.remote = state
            .hosted_rooms
            .into_iter()
            .map(|(id, summary)| (id, RemoteRoom::restored(summary)))
            .collect();
        self.transports = TransportBook::default();
        self.input_registrations.clear();
        Ok(())
    }

    pub fn peer(&self, endpoint: Uuid, pair_id: Uuid) -> Option<Uuid> {
        self.transports.peer(endpoint, pair_id)
    }

    pub(crate) fn command_room(&self, command: &Command) -> Option<String> {
        match command {
            Command::Browse { room_id, .. }
            | Command::BaseState { room_id, .. }
            | Command::FileOffer { room_id, .. }
            | Command::FileReceive { room_id, .. }
            | Command::UpdateRoom { room_id, .. }
            | Command::EnterRoom { room_id, .. }
            | Command::RoomInvite { room_id }
            | Command::GetRoomInvite { room_id }
            | Command::RevokeRoomAccess { room_id, .. }
            | Command::Voice { room_id, .. } => Some(room_id.clone()),
            Command::RelayCapacity { room_id, .. } => Some(room_id.clone()),
            Command::Publish { publication } => Some(publication.room_id.clone()),
            Command::Unpublish { publication_id }
            | Command::SetPaused { publication_id, .. }
            | Command::TransferSource { publication_id, .. }
            | Command::Subscribe { publication_id, .. } => {
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
    }

    pub(crate) fn register_host(
        &mut self,
        session: Uuid,
        connection: Uuid,
        summary: RoomSummary,
        resume: Option<Uuid>,
    ) -> Result<(Vec<(Uuid, Event)>, Vec<RetiredRoomReply>), &'static str> {
        let member = self
            .identity
            .member(self.identity.sessions[&session].user_id)?;
        if summary.creator_id != member.user_id {
            return Err("forbidden");
        }
        summary.validate()?;
        let room_id = summary.id.clone();
        let remote = self.remote.get_mut(&room_id).ok_or("room_not_in_domain")?;
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
        let replies = remote.drain_replies();
        if continuing {
            remote.binding.as_mut().unwrap().connection = connection;
        } else {
            remote.binding = Some(Binding {
                id: Uuid::new_v4(),
                session,
                connection,
                revision: 0,
                projection_floor: 0,
                applied_revision: 0,
                replies: BTreeMap::new(),
                failed_pairs: BTreeMap::new(),
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
        binding.projection_floor = binding.revision;
        self.reconcile();
        Ok((events, replies))
    }

    pub(crate) fn create_room(
        &mut self,
        session: Uuid,
        mut room: RoomSummary,
    ) -> Result<RoomSummary, &'static str> {
        let member = self
            .identity
            .member(self.identity.sessions[&session].user_id)?;
        room.id = Uuid::new_v4().to_string();
        room.creator_id = member.user_id;
        self.insert_room(room.clone())?;
        Ok(room)
    }

    pub(crate) fn admit_room(
        &mut self,
        session: Uuid,
        room: RoomSummary,
    ) -> Result<(), &'static str> {
        let member = self
            .identity
            .member(self.identity.sessions[&session].user_id)?;
        if !member.domain_owner {
            return Err("forbidden");
        }
        self.identity.member(room.creator_id)?;
        room.validate()?;
        if let Some(current) = self.remote.get(&room.id) {
            return if current.summary.creator_id == room.creator_id {
                Ok(())
            } else {
                Err("forbidden")
            };
        }
        self.insert_room(room)
    }

    fn insert_room(&mut self, room: RoomSummary) -> Result<(), &'static str> {
        room.validate()?;
        if self.remote.len() >= 32 {
            return Err("room_limit");
        }
        self.remote
            .insert(room.id.clone(), RemoteRoom::restored(room));
        Ok(())
    }

    pub(crate) fn manages_room(&self, session: Uuid, id: &str) -> Result<(), &'static str> {
        let member = self
            .identity
            .member(self.identity.sessions[&session].user_id)?;
        let room = self.remote.get(id).ok_or("room_not_in_domain")?;
        if member.domain_owner || member.user_id == room.summary.creator_id {
            Ok(())
        } else {
            Err("forbidden")
        }
    }

    pub(crate) fn room_online(&self, id: &str) -> bool {
        self.remote
            .get(id)
            .is_some_and(|room| Self::host_online(&self.identity, room))
    }

    pub(crate) fn relay_conversation(
        &self,
        session: Uuid,
        packet: &crate::conversation::SignedPacket,
    ) -> Result<Uuid, &'static str> {
        if packet.sender != session {
            return Err("invalid_conversation_sender");
        }
        let sender = self
            .identity
            .sessions
            .get(&session)
            .ok_or("session_expired")?;
        let address = crate::conversation::verify_address(packet, sender.signing_key)?;
        let room = self
            .remote
            .get(&address.room_id)
            .ok_or("room_unavailable")?;
        if !Self::host_online(&self.identity, room) {
            return Err("room_host_offline");
        }
        let binding = room.binding.as_ref().ok_or("room_host_offline")?;
        if address.binding_id != binding.id || !valid_id(&address.request_id) {
            return Err("invalid_conversation_scope");
        }
        let participant = if address.sender == binding.session {
            address.recipient
        } else if address.recipient == binding.session {
            address.sender
        } else {
            return Err("invalid_conversation_scope");
        };
        let recipient = self
            .identity
            .sessions
            .get(&address.recipient)
            .ok_or("session_expired")?;
        if recipient.connection.is_none() {
            return Err("disconnected");
        }
        let endpoint = self
            .identity
            .sessions
            .get(&participant)
            .ok_or("session_expired")?;
        let member = self.identity.member(endpoint.user_id)?;
        let view = room
            .snapshot(member, participant, true)
            .ok_or("room_access_required")?;
        if !view.room.authorized || binding.applied_revision < binding.projection_floor {
            return Err("room_access_required");
        }
        Ok(address.recipient)
    }

    pub(crate) fn remove_room(&mut self, id: &str) -> Vec<RetiredRoomReply> {
        let replies = self
            .remote
            .remove(id)
            .map_or_else(Vec::new, |mut room| room.drain_replies());
        self.reconcile();
        replies
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
        let (session, input) = remote.input(endpoints, action, self.now)?;
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
                state,
            } => {
                let flow = self
                    .flow_direction(context.session_id, pair_id, flow_id, state)
                    .ok_or("unassigned_flow")?;
                HostAction::FlowState {
                    context,
                    flow_id,
                    sender: flow.sender,
                    receiver: flow.receiver,
                    state,
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
        state: FlowState,
    ) -> Option<Flow> {
        let flow = self.transports.flow(pair, flow_id)?;
        (flow.receiver == reporter || (state == FlowState::Failed && flow.sender == reporter))
            .then_some(flow)
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
                state,
            } => self
                .flow_direction(session, *pair_id, *flow_id, *state)
                .is_some(),
            Command::Signal { pair_id, .. } | Command::LinkState { pair_id, .. } => {
                self.peer(session, *pair_id).is_some()
            }
            _ => true,
        }
    }

    pub(crate) fn wake_hosts(&mut self, now: u64) -> Vec<(Uuid, Event)> {
        self.now = now;
        let due: Vec<_> = self
            .remote
            .iter()
            .filter_map(|(id, room)| {
                room.projection
                    .as_ref()
                    .and_then(|p| p.next_route_deadline)
                    .filter(|deadline| *deadline <= now)
                    .map(|_| id.clone())
            })
            .collect();
        let mut events = Vec::new();
        for id in due {
            if self.remote[&id].binding.as_ref().is_some_and(|binding| {
                binding
                    .replies
                    .values()
                    .any(|owner| matches!(owner, ReplyOwner::RouteWake))
            }) {
                continue;
            }
            if let Ok(event) = self.host_input(&id, HostAction::RouteWake) {
                self.remote
                    .get_mut(&id)
                    .unwrap()
                    .projection
                    .as_mut()
                    .unwrap()
                    .next_route_deadline = None;
                events.push(event);
            }
        }
        events
    }

    pub(crate) fn sync_hosts(&mut self, invalidate_projection: bool) -> Vec<(Uuid, Event)> {
        let ids: Vec<_> = self.remote.keys().cloned().collect();
        ids.into_iter()
            .filter_map(|id| {
                let event = self.host_input(&id, HostAction::Sync).ok()?;
                if invalidate_projection {
                    let binding = self.remote.get_mut(&id).unwrap().binding.as_mut().unwrap();
                    binding.projection_floor = binding.revision;
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
    ) -> Result<Vec<RetiredRoomReply>, &'static str> {
        let room = self.remote.get_mut(id).ok_or("room_unavailable")?;
        if !room
            .binding
            .as_ref()
            .is_some_and(|b| b.id == binding && b.session == session && b.connection == connection)
        {
            return Err("stale_room_host");
        }
        let replies = room.pause();
        self.reconcile();
        Ok(replies)
    }

    pub(crate) fn accept_host(
        &mut self,
        id: &str,
        session: Uuid,
        connection: Uuid,
        output: &HostOutput,
    ) -> Result<HostAcceptance, &'static str> {
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
        let (reply_valid, invitation_current) = match binding.replies.get(&output.revision) {
            Some(ReplyOwner::Request {
                context,
                completion,
                ..
            }) => (
                output
                    .reply
                    .as_ref()
                    .is_some_and(|reply| &reply.context == context)
                    && completion.is_none()
                    && output.invitation.is_none(),
                true,
            ),
            Some(ReplyOwner::Invitation { ticket, member }) => (
                output
                    .invitation
                    .as_ref()
                    .is_some_and(|invitation| invitation.ticket == *ticket)
                    && output.reply.is_none(),
                member
                    .is_none_or(|member| self.identity.member(member.user_id).ok() == Some(member)),
            ),
            Some(ReplyOwner::RouteWake) | None => {
                (output.reply.is_none() && output.invitation.is_none(), true)
            }
        };
        if !reply_valid {
            return Err("invalid_room_reply");
        }
        if let Some(reply) = output
            .reply
            .as_ref()
            .filter(|reply| matches!(reply.result, RoomResult::Deleted { .. }))
        {
            if !matches!(reply.result, RoomResult::Deleted { data_removed: true })
                || !matches!(
                    binding.replies.get(&output.revision),
                    Some(ReplyOwner::Request { delete: true, .. })
                )
            {
                return Err("invalid_room_reply");
            }
            self.remote
                .get_mut(id)
                .unwrap()
                .binding
                .as_mut()
                .unwrap()
                .replies
                .remove(&output.revision);
            return Ok(HostAcceptance {
                projection_applied: false,
                invitation_current: false,
                replies: vec![reply.clone()],
            });
        }
        let projection_applied = output.revision >= binding.projection_floor;
        let room = &self.remote[id];
        if !projection_applied {
            return Ok(self.finish_host_output(id, output, false, invitation_current));
        }
        let projection = &output.projection;
        if projection.summary.id != id || projection.summary.creator_id != room.summary.creator_id {
            return Err("invalid_room_projection");
        }
        // One room has at most two publications per authenticated endpoint.
        // Check its transport leases at the domain boundary, never trust a host to name another room's flows.
        let endpoints = self.identity.endpoints();
        if projection.views.len() > 20
            || projection.flows.len() > 40 * (19 + 19)
            || projection
                .base_links
                .iter()
                .filter(|link| link.selected)
                .count()
                > 19
            || projection
                .base_links
                .iter()
                .filter(|link| !link.selected)
                .count()
                > 2
        {
            return Err("invalid_room_projection");
        }
        for (recipient, view) in &projection.views {
            if !endpoints.contains_key(recipient)
                || view.room.id != id
                || view.room.creator_id != room.summary.creator_id
                || view.publications.len() > 40
                || view.voice.len() > 20
                || view.room.participant_session_ids.len() > 20
                || view.room.participant_session_ids.iter().any(|session| {
                    !projection
                        .views
                        .get(session)
                        .is_some_and(|v| v.room.authorized)
                })
                || view.subscriptions.len() > 40
                || view.failed_subscriptions.len() > 40
                || view.failed_subscriptions.iter().any(|id| {
                    !view.subscriptions.contains(id)
                        || !view.publications.iter().any(|publication| {
                            publication.id == *id && publication.kind == Kind::Screen
                        })
                })
                || view.files.len() > HISTORY_WINDOW
                || (!view.room.authorized
                    && (view.room.reading
                        || !view.room.participant_session_ids.is_empty()
                        || !view.publications.is_empty()
                        || !view.voice.is_empty()
                        || !view.subscriptions.is_empty()
                        || !view.failed_subscriptions.is_empty()
                        || !view.files.is_empty()))
            {
                return Err("invalid_room_projection");
            }
            for file in &view.files {
                let neighbor = |peer: Uuid| {
                    peer != *recipient
                        && projection
                            .base_links
                            .iter()
                            .filter(|link| link.selected)
                            .any(|link| {
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
                if validate_video_settings(publication.kind, publication.video_settings).is_err()
                    || publication.room_id != id
                    || publication.audience.len() > crate::identity::MAX_SESSIONS
                    || (publication.kind != Kind::Screen && !publication.audience.is_empty())
                    || publication
                        .audience
                        .iter()
                        .map(|viewer| viewer.session_id)
                        .collect::<BTreeSet<_>>()
                        .len()
                        != publication.audience.len()
                    || publication.audience.iter().any(|viewer| {
                        viewer.session_id == publication.session_id
                            || !projection
                                .views
                                .get(&viewer.session_id)
                                .is_some_and(|view| {
                                    view.room.authorized
                                        && view.subscriptions.contains(&publication.id)
                                })
                    })
                    || !endpoints
                        .get(&publication.session_id)
                        .is_some_and(|e| e.member.user_id == publication.user_id)
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
        let mut publications = BTreeMap::new();
        for publication in projection
            .views
            .values()
            .flat_map(|view| &view.publications)
        {
            let source = (
                publication.session_id,
                publication.user_id,
                publication.kind,
                publication.video_settings,
                &publication.audience,
            );
            if publications
                .insert(publication.id, source)
                .is_some_and(|previous| previous != source)
            {
                return Err("invalid_room_projection");
            }
        }
        if publications.len() > 40 {
            return Err("invalid_room_projection");
        }
        let mut flow_ids: BTreeSet<_> = self
            .remote
            .iter()
            .filter(|(other, _)| other.as_str() != id)
            .filter_map(|(_, room)| room.projection.as_ref())
            .flat_map(|projection| projection.flows.iter().map(|flow| flow.id))
            .collect();
        let previous: BTreeMap<_, _> = room
            .projection
            .iter()
            .flat_map(|projection| &projection.flows)
            .map(|flow| (flow.id, flow))
            .collect();
        let flows: BTreeMap<_, _> = projection
            .flows
            .iter()
            .map(|flow| (flow.id, flow))
            .collect();
        let mut inputs = BTreeSet::new();
        for flow in &projection.flows {
            if !flow_ids.insert(flow.id)
                || !inputs.insert((flow.publication_id, flow.receiver, flow.selected))
                || flow.sender == flow.receiver
                || !endpoints.contains_key(&flow.sender)
                || !endpoints.contains_key(&flow.receiver)
                || !projection.views.get(&flow.sender).is_some_and(|v| {
                    v.room.authorized && v.publications.iter().any(|p| p.id == flow.publication_id)
                })
                || !projection.views.get(&flow.receiver).is_some_and(|v| {
                    v.room.authorized && v.publications.iter().any(|p| p.id == flow.publication_id)
                })
                || previous.get(&flow.id).is_some_and(|old| {
                    old.publication_id != flow.publication_id
                        || old.sender != flow.sender
                        || old.receiver != flow.receiver
                        || old.input_flow_id != flow.input_flow_id
                })
            {
                return Err("invalid_room_projection");
            }
        }
        let mut shadow_roots = BTreeMap::new();
        for flow in &projection.flows {
            let source = publications[&flow.publication_id].0;
            if flow.receiver == source {
                return Err("invalid_room_projection");
            }
            let root = match flow.input_flow_id {
                None if flow.sender == source => true,
                Some(input_id) => {
                    let input = flows.get(&input_id).ok_or("invalid_room_projection")?;
                    if input.publication_id != flow.publication_id
                        || input.receiver != flow.sender
                        || (flow.selected && !input.selected)
                    {
                        return Err("invalid_room_projection");
                    }
                    input.selected
                }
                None => return Err("invalid_room_projection"),
            };
            // One prepared branch may introduce transit without an incumbent.
            // Its new leaves still replace selected inputs, and every root
            // attaches to the same unchanged input (or the publication source).
            if !flow.selected
                && ((!inputs.contains(&(flow.publication_id, flow.receiver, true))
                    && !projection
                        .flows
                        .iter()
                        .any(|output| !output.selected && output.input_flow_id == Some(flow.id)))
                    || (root
                        && shadow_roots
                            .insert(flow.publication_id, flow.input_flow_id)
                            .is_some_and(|anchor| anchor != flow.input_flow_id)))
            {
                return Err("invalid_room_projection");
            }
        }
        // Each flow has one input. Following that chain is enough to prove a
        // source path and reject cycles, including a shadow through its own old branch.
        for flow in &projection.flows {
            let mut path = BTreeSet::new();
            let mut current = flow;
            loop {
                if !path.insert(current.receiver) {
                    return Err("invalid_room_projection");
                }
                let Some(input_id) = current.input_flow_id else {
                    break;
                };
                current = flows[&input_id];
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
        let mut base_parents = BTreeMap::new();
        for link in projection.base_links.iter().filter(|link| link.selected) {
            if link.child == binding.session
                || base_parents.insert(link.child, link.parent).is_some()
            {
                return Err("invalid_room_projection");
            }
        }
        for child in base_parents.keys() {
            let mut path = BTreeSet::new();
            let mut node = *child;
            while node != binding.session {
                if !path.insert(node) {
                    return Err("invalid_room_projection");
                }
                node = *base_parents.get(&node).ok_or("invalid_room_projection")?;
            }
        }
        let candidates: Vec<_> = projection
            .base_links
            .iter()
            .filter(|link| !link.selected)
            .collect();
        let mut proposed = base_parents.clone();
        if let [link] = candidates.as_slice() {
            if !base_parents.contains_key(&link.child) || base_parents[&link.child] == link.parent {
                return Err("invalid_room_projection");
            }
            proposed.insert(link.child, link.parent);
        } else if let [first, second] = candidates.as_slice() {
            let (entry, branch) = if first.child == second.parent {
                (*first, *second)
            } else {
                (*second, *first)
            };
            if entry.child != branch.parent
                || entry.parent == branch.child
                || base_parents.get(&branch.child) != Some(&entry.parent)
                || base_parents
                    .get(&entry.child)
                    .is_some_and(|parent| *parent != branch.child)
            {
                return Err("invalid_room_projection");
            }
            proposed.insert(entry.child, entry.parent);
            proposed.insert(branch.child, branch.parent);
        }
        for link in candidates {
            let mut path = BTreeSet::new();
            let mut parent = link.child;
            while parent != binding.session {
                if !path.insert(parent) {
                    return Err("invalid_room_projection");
                }
                parent = *proposed.get(&parent).ok_or("invalid_room_projection")?;
            }
        }
        let room = self.remote.get_mut(id).unwrap();
        room.binding.as_mut().unwrap().projection_floor = output.revision;
        room.binding.as_mut().unwrap().applied_revision = output.revision;
        room.binding
            .as_mut()
            .unwrap()
            .failed_pairs
            .retain(|_, revision| *revision > output.revision);
        room.summary = projection.summary.clone();
        let mut projection = projection.clone();
        for view in projection.views.values_mut() {
            view.room.available = true;
        }
        room.projection = Some(projection);
        self.reconcile();
        Ok(self.finish_host_output(id, output, true, invitation_current))
    }

    fn finish_host_output(
        &mut self,
        id: &str,
        output: &HostOutput,
        projection_applied: bool,
        invitation_current: bool,
    ) -> HostAcceptance {
        let binding = self.remote.get_mut(id).unwrap().binding.as_mut().unwrap();
        if let Some(ReplyOwner::Request { completion, .. }) =
            binding.replies.get_mut(&output.revision)
        {
            *completion = Some(output.reply.as_ref().unwrap().result.clone());
        } else {
            binding.replies.remove(&output.revision);
        }
        let ready: Vec<_> = binding
            .replies
            .iter()
            .filter_map(|(revision, owner)| {
                let ReplyOwner::Request {
                    context,
                    member,
                    completion: Some(result),
                    ..
                } = owner
                else {
                    return None;
                };
                let current = self.identity.session_for_connection(context.connection)
                    == Some(context.session_id)
                    && self.identity.member(member.user_id).ok().as_ref() == Some(member);
                (*revision <= binding.applied_revision
                    || !current
                    || matches!(result, RoomResult::Error { .. }))
                .then_some((*revision, current))
            })
            .collect();
        let replies = ready
            .into_iter()
            .map(|(revision, current)| {
                let ReplyOwner::Request {
                    context,
                    completion,
                    ..
                } = binding.replies.remove(&revision).unwrap()
                else {
                    unreachable!()
                };
                RoomReply {
                    context,
                    result: if current {
                        completion.unwrap()
                    } else {
                        RoomResult::Error {
                            code: "room_context_changed".into(),
                        }
                    },
                }
            })
            .collect();
        HostAcceptance {
            projection_applied,
            invitation_current,
            replies,
        }
    }

    fn host_online(identity: &Identity, room: &RemoteRoom) -> bool {
        room.binding.as_ref().is_some_and(|b| {
            identity
                .sessions
                .get(&b.session)
                .is_some_and(|s| s.connection == Some(b.connection))
        })
    }

    pub(crate) fn room_topology(
        &self,
        id: &str,
        session: Uuid,
        publication_id: Option<Uuid>,
    ) -> Result<crate::topology::RoomTopology, &'static str> {
        use crate::topology::{BaseEdge, BaseTopology, RoomTopology, ScreenEdge, ScreenTopology};
        let member = self.identity.member(
            self.identity
                .sessions
                .get(&session)
                .ok_or("session_expired")?
                .user_id,
        )?;
        let room = self.remote.get(id).ok_or("room_unavailable")?;
        if !Self::host_online(&self.identity, room) {
            return Err("room_unavailable");
        }
        let binding = room.binding.as_ref().ok_or("room_unavailable")?;
        if binding.applied_revision < binding.projection_floor {
            return Err("room_unavailable");
        }
        let view = room
            .snapshot(member, session, true)
            .ok_or("room_unavailable")?;
        if !view.room.authorized {
            return Err("room_access_required");
        }
        let projection = room.projection.as_ref().ok_or("room_unavailable")?;
        let screen = publication_id
            .map(|publication_id| {
                let publication = view
                    .publications
                    .iter()
                    .find(|publication| {
                        publication.id == publication_id && publication.kind == Kind::Screen
                    })
                    .ok_or("publication_unavailable")?;
                Ok(ScreenTopology {
                    publication_id,
                    source_session_id: publication.session_id,
                    edges: projection
                        .flows
                        .iter()
                        .filter(|flow| flow.publication_id == publication_id)
                        .map(|flow| ScreenEdge {
                            sender: flow.sender,
                            receiver: flow.receiver,
                            selected: flow.selected,
                            proof: flow.proof,
                            presented: flow.presented,
                            presentation: flow.presentation,
                        })
                        .collect(),
                })
            })
            .transpose()?;
        Ok(RoomTopology {
            binding_id: binding.id,
            base: BaseTopology {
                root_session_id: binding.session,
                edges: projection
                    .base_links
                    .iter()
                    .filter(|link| link.selected)
                    .map(|link| BaseEdge {
                        sender: link.parent,
                        receiver: link.child,
                        ready: link.ready,
                    })
                    .collect(),
            },
            screen,
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
        let mut failed_subscriptions = BTreeSet::new();
        if let Some(member) = member {
            for room in self.remote.values() {
                if let Some(mut snapshot) =
                    room.snapshot(member, session_id, Self::host_online(&self.identity, room))
                {
                    snapshot.room.delivery = if snapshot.room.authorized {
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
                    failed_subscriptions.extend(snapshot.failed_subscriptions);
                }
            }
        }
        Snapshot {
            files,
            channel: ChannelInfo {
                history_window: HISTORY_WINDOW,
                id: self.id,
                name: self.name.clone(),
                icon: self.icon.clone(),
                owner_id: Some(self.identity.owner_id),
                access: self.identity.access,
                has_password: self.identity.password_hash.is_some(),
                invite_hash: crate::domain_invite_hash(&self.identity.invite_key),
                rooms,
            },
            users: self
                .identity
                .users
                .values()
                .map(|user| UserInfo {
                    id: user.id,
                    name: user.name.clone(),
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
            failed_subscriptions: failed_subscriptions.into_iter().collect(),
            pairs: self.transports.snapshot(
                session_id,
                |peer| self.can_prepare_udp(session_id, peer),
                |peer| {
                    self.identity
                        .sessions
                        .get(&peer)
                        .is_some_and(|session| session.can_receive_video_layers)
                },
            ),
            ice_servers: self.ice_servers.clone(),
        }
    }
}

fn room_next_hops(session: Uuid, links: &[crate::transport::BaseLink]) -> BTreeMap<Uuid, Uuid> {
    let mut result = BTreeMap::new();
    let mut pending = VecDeque::from([(session, session)]);
    while let Some((current, first)) = pending.pop_front() {
        for link in links.iter().filter(|link| link.selected) {
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
    name: String,
    icon: IdentityIcon,
    owner_id: Uuid,
    #[serde(default = "crate::identity::private_access")]
    access: RoomAccess,
    password_hash: Option<String>,
    users: Vec<StoredUser>,
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
