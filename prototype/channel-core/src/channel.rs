use crate::{
    file_room::FILE_REGISTRATION_LIMIT,
    history::HISTORY_WINDOW,
    host::{HostAction, HostOutput, RequestContext, RoomReply, RoomResult, RoomSummary},
    identity::{Admission, Admitted, Identity, StoredUser, MAX_SESSIONS},
    remote::{Binding, RemoteRoom, ReplyOwner, RetiredRoomReply},
    transport::{Flow, TransportBook},
    wire::*,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use uuid::Uuid;

const MAX_ACTIVE_ROOMS: usize = 32;
// Directory space for the live set plus one equally sized recovery set.
const MAX_ROOMS: usize = 64;

mod discovery;
use discovery::Repair;

/// Domain admission, hosted-room directory and shared transport leases.
/// Browsing selects a presentation; it never owns another room's activities.
#[derive(Clone)]
pub struct Channel {
    pub identity: Identity,
    pub(crate) now: u64,
    id: Uuid,
    name: String,
    icon: IdentityIcon,
    pub(crate) hosting_mode: HostingMode,
    pub(crate) room_writer: Option<crate::host::ServiceEndpoint>,
    room_creation_policy: RoomCreationPolicy,
    restorable_rooms: BTreeMap<String, Uuid>,
    pub(crate) pending_room_deletions: BTreeMap<String, Uuid>,
    pub(crate) remote: BTreeMap<String, RemoteRoom>,
    transports: TransportBook,
    repairs: BTreeMap<(Uuid, crate::transport::DiscoveryEdge), Repair>,
    input_registrations: BTreeMap<Uuid, Vec<crate::input::InputRegistration>>,
    ice_servers: Vec<Value>,
    pub(crate) service_endpoint: Option<crate::host::ServiceEndpoint>,
}

pub(crate) struct HostAcceptance {
    pub projection_applied: bool,
    pub replies: Vec<RoomReply>,
    pub deleted_by: Option<Uuid>,
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

    pub fn new(owner_key: String, ice_servers: Vec<Value>) -> Self {
        let identity = Identity::new(owner_key);
        Self {
            identity,
            now: 0,
            id: Uuid::new_v4(),
            name: "Piik friends".into(),
            icon: IdentityIcon::default(),
            hosting_mode: HostingMode::default(),
            room_writer: None,
            room_creation_policy: RoomCreationPolicy::default(),
            restorable_rooms: BTreeMap::new(),
            pending_room_deletions: BTreeMap::new(),
            remote: BTreeMap::new(),
            transports: TransportBook::default(),
            repairs: BTreeMap::new(),
            input_registrations: BTreeMap::new(),
            ice_servers,
            service_endpoint: None,
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
            Command::SetProfile { name, avatar } => {
                self.identity
                    .users
                    .get_mut(&user_id)
                    .unwrap()
                    .set_profile(name, avatar)?;
                broadcast = true;
            }
            Command::UpdateDomain { name, icon } => {
                if user_id != self.identity.owner_id {
                    return Err("forbidden");
                }
                if let Some(name) = name {
                    self.name = title(&name).ok_or("invalid_domain_name")?;
                }
                if let Some(icon) = icon {
                    self.icon = icon;
                }
                broadcast = true;
            }
            Command::SetRoomCreationPolicy { policy } => {
                if user_id != self.identity.owner_id {
                    return Err("forbidden");
                }
                replies = self.set_room_creation_policy(policy);
                broadcast = true;
            }
            Command::HostRegister { .. }
            | Command::Conversation { .. }
            | Command::CancelRoomCreation { .. }
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
                        || !self.can_prepare_udp(session_id, peer)
                        || !match udp {
                            UdpSignal::Offer { .. } => session_id < peer,
                            UdpSignal::Answer { .. } => session_id > peer,
                            UdpSignal::Ready {}
                            | UdpSignal::Unavailable {}
                            | UdpSignal::Complete => true,
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
                    let connection = self.identity.sessions[&session_id]
                        .connection
                        .ok_or("disconnected")?;
                    let peer_connection =
                        self.identity.sessions.get(&peer).and_then(|s| s.connection);
                    if self
                        .transports
                        .connected(session_id, connection, peer_connection, pair_id)
                    {
                        let rooms: Vec<_> = self
                            .remote
                            .iter()
                            .filter(|(_, room)| {
                                let scope = room.planning_sessions(self.service_endpoint, None);
                                scope.contains(&session_id) && scope.contains(&peer)
                            })
                            .map(|(id, _)| id.clone())
                            .collect();
                        for room in rooms {
                            if let Ok(event) = self.host_input(&room, HostAction::Sync) {
                                events.push(event);
                            }
                        }
                    }
                } else if self.can_prepare_udp(session_id, peer) && self.transports.prepare(pair_id)
                {
                    broadcast = true;
                } else {
                    self.transports.retire(pair_id, &self.identity);
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
            | Command::SetScreenDirectLimit { .. }
            | Command::SetTitle { .. }
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
        self.remote
            .retain(|_, room| room.reservation != Some(session_id));
        let mut replies = Vec::new();
        for remote in self.remote.values_mut() {
            remote.known_sessions.remove(&session_id);
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

    pub(crate) fn expire_discovery(&mut self, now: u64) -> bool {
        if self.transports.expire_discovery(now) {
            self.reconcile();
            return true;
        }
        false
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
        self.service_endpoint = self.service_endpoint.filter(|service| {
            self.identity
                .sessions
                .get(&service.session_id)
                .is_some_and(|session| session.connection == Some(service.connection_id))
        });
        for room in self.remote.values_mut() {
            if let Some(projection) = &mut room.projection {
                projection
                    .views
                    .retain(|session, _| endpoints.contains_key(session));
                let mut routable_sessions = BTreeSet::new();
                for (session, view) in &mut projection.views {
                    let was_transit = view.transit_endpoint.is_some();
                    view.transit_endpoint = view.transit_endpoint.filter(|endpoint| {
                        Some(*endpoint) == self.service_endpoint
                            && endpoint.session_id == *session
                            && (projection
                                .base_links
                                .iter()
                                .any(|link| link.parent == *session || link.child == *session)
                                || projection.flows.iter().any(|flow| {
                                    flow.sender == *session || flow.receiver == *session
                                }))
                    });
                    let ordinary = !was_transit
                        || room
                            .binding
                            .as_ref()
                            .is_some_and(|binding| binding.session == *session)
                        || projection.participant_session_ids.contains(session)
                        || view
                            .files
                            .iter()
                            .any(|file| file.receiving || file.source_id == Some(*session))
                        || view
                            .watch_bytes
                            .iter()
                            .any(|plan| plan.receiving || plan.source.session_id == *session);
                    if view.transit_endpoint.is_some() || (view.authorized && ordinary) {
                        routable_sessions.insert(*session);
                    }
                }
                let readable_sessions: BTreeSet<_> = projection
                    .views
                    .iter()
                    .filter_map(|(session, view)| view.authorized.then_some(*session))
                    .collect();
                projection
                    .publications
                    .retain(|p| readable_sessions.contains(&p.session_id));
                projection
                    .watch_activities
                    .retain(|a| readable_sessions.contains(&a.session_id));
                for activity in &mut projection.watch_activities {
                    activity.viewer_session_ids.retain(|session| {
                        readable_sessions.contains(session)
                            && projection.views[session]
                                .watch_subscriptions
                                .iter()
                                .any(|subscription| subscription.id == activity.id)
                    });
                    if activity
                        .byte_source
                        .as_ref()
                        .is_some_and(|source| !readable_sessions.contains(&source.session_id))
                    {
                        activity.byte_source = None;
                    }
                }
                for publication in &mut projection.publications {
                    publication
                        .audience
                        .retain(|viewer| readable_sessions.contains(&viewer.session_id));
                }
                projection
                    .voice
                    .retain(|v| readable_sessions.contains(&v.session_id));
                projection
                    .participant_session_ids
                    .retain(|session| readable_sessions.contains(session));
                for (session, view) in &mut projection.views {
                    view.watch_bytes.retain_mut(|plan| {
                        if !routable_sessions.contains(session)
                            || !projection.watch_activities.iter().any(|activity| {
                                activity.id == plan.activity_id
                                    && activity.byte_source.as_ref() == Some(&plan.source)
                            })
                        {
                            return false;
                        }
                        if plan
                            .upstream
                            .is_some_and(|peer| !routable_sessions.contains(&peer))
                        {
                            plan.upstream = None;
                        }
                        plan.downstream
                            .retain(|peer| routable_sessions.contains(peer));
                        true
                    });
                    if !routable_sessions.contains(session) {
                        view.files.clear();
                    }
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
                            .is_some_and(|peer| !routable_sessions.contains(&peer))
                        {
                            file.upstream = None;
                        }
                        file.downstream
                            .retain(|peer| routable_sessions.contains(peer));
                    }
                    if !view.authorized {
                        view.files
                            .retain(|file| file.upstream.is_some() && !file.downstream.is_empty());
                        view.watch_bytes
                            .retain(|plan| plan.upstream.is_some() && !plan.downstream.is_empty());
                    }
                    view.watch_subscriptions.retain(|subscription| {
                        view.authorized
                            && projection
                                .watch_activities
                                .iter()
                                .any(|a| a.id == subscription.id)
                    });
                    view.subscriptions
                        .retain(|id| projection.publications.iter().any(|p| p.id == *id));
                    view.failed_subscriptions
                        .retain(|id| view.subscriptions.contains(id));
                }
                projection.flows.retain(|flow| {
                    [flow.sender, flow.receiver]
                        .into_iter()
                        .all(|s| routable_sessions.contains(&s))
                        && projection
                            .publications
                            .iter()
                            .any(|p| p.id == flow.publication_id)
                });
                projection.base_links.retain(|link| {
                    [link.parent, link.child]
                        .into_iter()
                        .all(|s| routable_sessions.contains(&s))
                });
            }
        }
        self.reconcile_transports(&endpoints);
    }

    pub fn export_state(&self) -> DurableState {
        DurableState {
            version: 6,
            users: self.identity.export_users(),
            header: DomainStateHeader {
                hosting_mode: self.hosting_mode,
                room_creation_policy: self.room_creation_policy,
                restorable_rooms: self.restorable_rooms.clone(),
                pending_room_deletions: self.pending_room_deletions.clone(),
                id: self.id,
                name: self.name.clone(),
                icon: self.icon.clone(),
                owner_id: self.identity.owner_id,
                hosted_rooms: self
                    .remote
                    .iter()
                    .filter(|(_, room)| room.reservation.is_none())
                    .map(|(id, room)| (id.clone(), room.summary.clone()))
                    .collect(),
            },
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
                if !view.authorized || !view.subscriptions.contains(&publication) {
                    return None;
                }
                let source = projection
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
        if state.version != 6 {
            return Err("invalid_state");
        }
        state.header.validate()?;
        let mut identity = Identity::new(self.identity.owner_key.clone());
        identity.restore_users(state.header.owner_id, state.users)?;
        if state
            .header
            .hosted_rooms
            .values()
            .any(|room| !identity.users.contains_key(&room.creator_id))
            || state
                .header
                .restorable_rooms
                .values()
                .chain(state.header.pending_room_deletions.values())
                .any(|creator| !identity.users.contains_key(creator))
        {
            return Err("invalid_state");
        }
        let name = title(&state.header.name).ok_or("invalid_state")?;
        self.identity = identity;
        self.id = state.header.id;
        self.name = name;
        self.icon = state.header.icon;
        self.hosting_mode = state.header.hosting_mode;
        self.room_writer = None;
        self.room_creation_policy = state.header.room_creation_policy;
        self.restorable_rooms = state.header.restorable_rooms;
        self.pending_room_deletions = state.header.pending_room_deletions;
        self.remote = state
            .header
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
            Command::StartWatch { room_id, .. }
            | Command::SetWatchByteSource { room_id, .. }
            | Command::UpdateWatch { room_id, .. }
            | Command::JoinWatch { room_id, .. }
            | Command::StopWatch { room_id, .. }
            | Command::Browse { room_id, .. }
            | Command::BaseState { room_id, .. }
            | Command::FileOffer { room_id, .. }
            | Command::FileBranchRefused { room_id, .. }
            | Command::ForwardingAvailable { room_id, .. }
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
            | Command::SetScreenDirectLimit { publication_id, .. }
            | Command::SetTitle { publication_id, .. }
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
                    projection
                        .publications
                        .iter()
                        .any(|publication| publication.id == publication_id)
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
        let assigned = match self.hosting_mode {
            HostingMode::Lightweight => summary.creator_id == member.user_id,
            HostingMode::Hosted => {
                self.room_writer
                    == Some(crate::host::ServiceEndpoint {
                        session_id: session,
                        connection_id: connection,
                    })
            }
        };
        if !assigned {
            return Err("forbidden");
        }
        self.validate_room_summary(&summary)?;
        let room_id = summary.id.clone();
        if self
            .remote
            .get(&room_id)
            .is_some_and(|room| !room.occupies_slot())
        {
            self.check_active_room_limit()?;
        }
        let remote = self.remote.get_mut(&room_id).ok_or("room_not_in_domain")?;
        if remote.summary.creator_id != summary.creator_id {
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
            if remote.summary != summary {
                remote.projection = None;
            }
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
            remote.known_sessions.clear();
        }
        remote.summary = summary;
        remote.reservation = None;
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
        room: RoomSummary,
    ) -> Result<RoomSummary, &'static str> {
        let creation = self.prepare_creation(session, room)?;
        self.reserve_creation(&creation)?;
        Ok(creation.summary)
    }

    pub(crate) fn check_room_creator(&self, user: Uuid) -> Result<(), &'static str> {
        if self.room_creation_policy.permits_request(user == self.identity.owner_id, None) {
            Ok(())
        } else {
            Err("room_creation_restricted")
        }
    }

    pub(crate) fn prepare_creation(
        &self,
        session: Uuid,
        mut room: RoomSummary,
    ) -> Result<crate::RoomCreation, &'static str> {
        let endpoint = self
            .identity
            .sessions
            .get(&session)
            .ok_or("disconnected")?;
        let connection = endpoint.connection.ok_or("disconnected")?;
        room.id = Uuid::new_v4().to_string();
        room.creator_id = self.identity.member(endpoint.user_id)?.user_id;
        Ok(crate::RoomCreation {
            summary: room,
            session,
            connection,
        })
    }

    pub(crate) fn reserve_creation(
        &mut self,
        creation: &crate::RoomCreation,
    ) -> Result<(), &'static str> {
        self.check_active_room_limit()?;
        self.validate_room_summary(&creation.summary)?;
        self.insert_validated_room(creation.summary.clone())?;
        self.remote.get_mut(&creation.summary.id).unwrap().reservation = Some(creation.session);
        Ok(())
    }

    pub(crate) fn admit_room(
        &mut self,
        session: Uuid,
        room: RoomSummary,
    ) -> Result<(), &'static str> {
        let member = self
            .identity
            .member(self.identity.sessions[&session].user_id)?;
        if room.creator_id != member.user_id {
            return Err("forbidden");
        }
        self.identity.member(room.creator_id)?;
        self.validate_room_summary(&room)?;
        if let Some(current) = self.remote.get(&room.id) {
            return if current.summary.creator_id == room.creator_id {
                Ok(())
            } else {
                Err("forbidden")
            };
        }
        if member.user_id != self.identity.owner_id
            && self.restorable_rooms.get(&room.id) != Some(&member.user_id)
        {
            return Err("room_not_in_domain");
        }
        self.insert_validated_room(room)
    }

    fn check_active_room_limit(&self) -> Result<(), &'static str> {
        if self
            .remote
            .values()
            .filter(|room| room.occupies_slot())
            .count()
            >= MAX_ACTIVE_ROOMS
        {
            return Err("room_limit");
        }
        Ok(())
    }

    pub(crate) fn validate_room_summary(&self, room: &RoomSummary) -> Result<(), &'static str> {
        room.validate()?;
        self.check_room_policy(room)
    }

    fn insert_validated_room(&mut self, room: RoomSummary) -> Result<(), &'static str> {
        if self.pending_room_deletions.contains_key(&room.id) {
            return Err("room_not_in_domain");
        }
        if self.remote.len() + self.restorable_rooms.len() + self.pending_room_deletions.len()
            >= MAX_ROOMS
            && !self.restorable_rooms.contains_key(&room.id)
        {
            return Err("room_limit");
        }
        self.restorable_rooms.remove(&room.id);
        self.remote
            .insert(room.id.clone(), RemoteRoom::restored(room));
        Ok(())
    }

    pub(crate) fn set_room_creation_policy(
        &mut self,
        policy: RoomCreationPolicy,
    ) -> Vec<RetiredRoomReply> {
        self.room_creation_policy = policy;
        let mut replies = Vec::new();
        self.remote.retain(|_, room| {
            room.reservation.is_none() || policy.permits(Some(self.identity.owner_id), &room.summary)
        });
        for room in self.remote.values_mut() {
            if !policy.permits(Some(self.identity.owner_id), &room.summary) {
                replies.extend(room.pause());
                room.projection = None;
            }
        }
        replies
    }

    fn check_room_policy(&self, summary: &RoomSummary) -> Result<(), &'static str> {
        if self
            .room_creation_policy
            .permits(Some(self.identity.owner_id), summary)
        {
            Ok(())
        } else {
            Err("room_creation_restricted")
        }
    }

    pub(crate) fn can_remove_room(&self, session: Uuid, id: &str) -> Result<(), &'static str> {
        let member = self
            .identity
            .member(self.identity.sessions[&session].user_id)?;
        let creator = self
            .remote
            .get(id)
            .map(|room| room.summary.creator_id)
            .or_else(|| self.pending_room_deletions.get(id).copied());
        let owner = member.user_id == self.identity.owner_id;
        if creator.is_none() && !(owner && self.restorable_rooms.contains_key(id)) {
            return Err("room_not_in_domain");
        }
        if creator == Some(member.user_id) || owner {
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
        &mut self,
        session: Uuid,
        packet: &crate::conversation::SignedPacket,
    ) -> Result<(Uuid, bool), &'static str> {
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
        let mut changed = false;
        if address.sender == binding.session {
            if let Ok(reply) =
                serde_json::from_str::<crate::conversation::ConversationReply>(&packet.payload)
            {
                if let crate::conversation::ConversationRecord::Confirmed { message, .. } =
                    reply.record
                {
                    if message.seq == 0 || message.seq > i64::MAX as u64 {
                        return Err("invalid_message");
                    }
                    if let Some(projection) = self
                        .remote
                        .get_mut(&address.room_id)
                        .and_then(|room| room.projection.as_mut())
                    {
                        changed = message.seq > projection.last_message_seq;
                        projection.last_message_seq = projection.last_message_seq.max(message.seq);
                    }
                }
            }
        }
        Ok((address.recipient, changed))
    }

    pub(crate) fn remove_room(&mut self, id: &str, actor: Uuid) -> Vec<RetiredRoomReply> {
        self.restorable_rooms.remove(id);
        let replies = self.remote.remove(id).map_or_else(Vec::new, |mut room| {
            if self.hosting_mode == HostingMode::Lightweight
                && room.reservation.is_none()
                && actor == room.summary.creator_id
                && actor != self.identity.owner_id
            {
                self.restorable_rooms.insert(id.to_owned(), actor);
            }
            room.drain_replies()
        });
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
        let (session, input) = remote.input(
            self.hosting_mode,
            self.identity.owner_id,
            endpoints,
            self.service_endpoint,
            self.transports.confirmed_pairs(&self.identity),
            action,
            self.now,
        )?;
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
        if let Command::UpdateRoom {
            access,
            hidden,
            password,
            ..
        } = &command
        {
            let mut proposed = self
                .remote
                .get(id)
                .ok_or("room_unavailable")?
                .summary
                .clone();
            proposed.access = access.unwrap_or(proposed.access);
            proposed.hidden = hidden.unwrap_or(proposed.hidden);
            if let Some(password) = password {
                proposed.has_password = password.is_some();
            }
            self.check_room_policy(&proposed)?;
        }
        let action = match command {
            Command::DeleteRoom {
                delete_data: true, ..
            } if self.hosting_mode == HostingMode::Hosted => {
                HostAction::RemoveHostedRoom { context }
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
        let reply_valid = match binding.replies.get(&output.revision) {
            Some(ReplyOwner::Request {
                context,
                completion,
                ..
            }) => {
                output
                    .reply
                    .as_ref()
                    .is_some_and(|reply| &reply.context == context)
                    && completion.is_none()
            }
            Some(ReplyOwner::RouteWake) | None => output.reply.is_none(),
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
            let Some(ReplyOwner::Request { member, .. }) = self
                .remote
                .get_mut(id)
                .unwrap()
                .binding
                .as_mut()
                .unwrap()
                .replies
                .remove(&output.revision)
            else {
                unreachable!()
            };
            return Ok(HostAcceptance {
                deleted_by: Some(member.user_id),
                projection_applied: false,
                replies: vec![reply.clone()],
            });
        }
        let projection_applied = output.revision >= binding.projection_floor;
        let room = &self.remote[id];
        if !projection_applied {
            return Ok(self.finish_host_output(id, output, false));
        }
        let projection = &output.projection;
        self.check_room_policy(&projection.summary)?;
        if projection.summary.validate().is_err()
            || projection.last_message_seq > i64::MAX as u64
            || projection.summary.id != id
            || projection.summary.creator_id != room.summary.creator_id
        {
            return Err("invalid_room_projection");
        }
        // One room has at most two publications per authenticated endpoint.
        // Check its transport leases at the domain boundary, never trust a host to name another room's flows.
        const MAX_PUBLICATIONS: usize = 2 * MAX_SESSIONS;
        const MAX_TREE_EDGES: usize = MAX_SESSIONS - 1;
        let endpoints = self.identity.endpoints();
        if projection.views.len() > MAX_SESSIONS
            // Each publication can retain committed and prepared tree flows.
            || projection.flows.len() > MAX_PUBLICATIONS * (MAX_TREE_EDGES + MAX_TREE_EDGES)
            || projection
                .base_links
                .iter()
                .filter(|link| link.selected)
                .count()
                > MAX_TREE_EDGES
            || projection
                .base_links
                .iter()
                .filter(|link| !link.selected)
                .count()
                > 2
        {
            return Err("invalid_room_projection");
        }
        if projection.publications.len() > MAX_PUBLICATIONS
            || projection.voice.len() > MAX_SESSIONS
            || projection.participant_session_ids.len() > MAX_SESSIONS
            || projection
                .participant_session_ids
                .iter()
                .any(|session| !projection.views.get(session).is_some_and(|v| v.authorized))
            || projection.voice.iter().any(|voice| {
                voice.room_id != id
                    || !projection
                        .views
                        .get(&voice.session_id)
                        .is_some_and(|v| v.authorized)
            })
        {
            return Err("invalid_room_projection");
        }
        let mut watch_ids = BTreeSet::new();
        let mut watch_owners = BTreeSet::new();
        if projection.watch_activities.len() > MAX_SESSIONS {
            return Err("invalid_room_projection");
        }
        for activity in &projection.watch_activities {
            let viewers: BTreeSet<_> = activity.viewer_session_ids.iter().copied().collect();
            let subscribed: BTreeSet<_> = projection
                .views
                .iter()
                .filter_map(|(session, view)| {
                    (view.authorized
                        && view
                            .watch_subscriptions
                            .iter()
                            .any(|subscription| subscription.id == activity.id))
                    .then_some(*session)
                })
                .collect();
            if !watch_ids.insert(activity.id)
                || !watch_owners.insert(activity.session_id)
                || activity.room_id != id
                || activity.playback.validate().is_err()
                || activity.source.validate().is_err()
                || activity.viewer_session_ids.len() > MAX_SESSIONS
                || viewers.len() != activity.viewer_session_ids.len()
                || viewers.contains(&activity.session_id)
                || viewers != subscribed
                || !projection
                    .views
                    .get(&activity.session_id)
                    .is_some_and(|v| v.authorized)
                || !endpoints
                    .get(&activity.session_id)
                    .is_some_and(|e| e.member.user_id == activity.user_id)
            {
                return Err("invalid_room_projection");
            }
            if let Some(source) = &activity.byte_source {
                // Recovery retains an admitted source, never an offline replacement.
                let retained = room.projection.as_ref().is_some_and(|previous| {
                    previous.watch_activities.iter().any(|previous| {
                        previous.id == activity.id
                            && previous.session_id == activity.session_id
                            && previous.byte_source.as_ref() == Some(source)
                    })
                });
                if !endpoints.get(&source.session_id).is_some_and(|endpoint| {
                    endpoint.member.user_id == activity.user_id && (endpoint.connected || retained)
                }) || !projection
                    .views
                    .get(&source.session_id)
                    .is_some_and(|view| view.authorized)
                {
                    return Err("invalid_room_projection");
                }
            }
        }
        for (recipient, view) in &projection.views {
            if view.allow_service_relay && !view.can_manage
                || view
                    .transit_endpoint
                    .is_some_and(|endpoint| Some(endpoint) != self.service_endpoint)
            {
                return Err("invalid_room_projection");
            }
            if !endpoints.contains_key(recipient)
                || view.transit_endpoint.is_some()
                    && (Some(*recipient) != self.service_endpoint.map(|service| service.session_id)
                        || !(projection
                            .base_links
                            .iter()
                            .any(|link| link.parent == *recipient || link.child == *recipient)
                            || projection.flows.iter().any(|flow| {
                                flow.sender == *recipient || flow.receiver == *recipient
                            })))
                || view.can_manage
                    && (!view.authorized
                        || endpoints[recipient].member.user_id != projection.summary.creator_id)
                || view.members.is_some() && !view.can_manage
                || view
                    .relay_override
                    .is_some_and(|capacity| capacity > crate::MAX_RELAY_CAPACITY)
                || view.watch_subscriptions.len() > MAX_SESSIONS
                || view
                    .watch_subscriptions
                    .iter()
                    .map(|s| s.id)
                    .collect::<BTreeSet<_>>()
                    .len()
                    != view.watch_subscriptions.len()
                || view.watch_bytes.len() > MAX_SESSIONS
                || view
                    .watch_subscriptions
                    .iter()
                    .any(|subscription| !watch_ids.contains(&subscription.id))
                || view.subscriptions.len() > MAX_PUBLICATIONS
                || view.failed_subscriptions.len() > MAX_PUBLICATIONS
                || view.failed_subscriptions.iter().any(|id| {
                    !view.subscriptions.contains(id)
                        || !projection.publications.iter().any(|publication| {
                            publication.id == *id && publication.kind == Kind::Screen
                        })
                })
                || view.files.len() > FILE_REGISTRATION_LIMIT
                || (!view.authorized
                    && (view.reading
                        || !view.watch_subscriptions.is_empty()
                        || view.transit_endpoint.is_none() && !view.watch_bytes.is_empty()
                        || !view.subscriptions.is_empty()
                        || !view.failed_subscriptions.is_empty()
                        || view.transit_endpoint.is_none() && !view.files.is_empty()))
            {
                return Err("invalid_room_projection");
            }
            let mut planned = BTreeSet::new();
            for plan in &view.watch_bytes {
                let neighbor = |peer: Uuid| {
                    peer != *recipient
                        && projection
                            .base_links
                            .iter()
                            .filter(|link| link.selected && link.ready)
                            .any(|link| {
                                (link.parent == *recipient && link.child == peer)
                                    || (link.child == *recipient && link.parent == peer)
                            })
                };
                if !planned.insert(plan.activity_id)
                    || !view.authorized
                        && (plan.receiving
                            || plan.source.session_id == *recipient
                            || plan.upstream.is_none()
                            || plan.downstream.is_empty())
                    || plan.room_id != id
                    || !projection.watch_activities.iter().any(|a| {
                        a.id == plan.activity_id && a.byte_source.as_ref() == Some(&plan.source)
                    })
                    || plan.receiving
                        != view.watch_subscriptions.iter().any(|s| {
                            s.id == plan.activity_id && s.mode == crate::wire::WatchMode::Peer
                        })
                    || (plan.source.session_id == *recipient && plan.upstream.is_some())
                    || plan
                        .upstream
                        .is_some_and(|peer| !neighbor(peer) || plan.downstream.contains(&peer))
                    || plan.downstream.len() > MAX_TREE_EDGES
                    || plan.downstream.iter().collect::<BTreeSet<_>>().len()
                        != plan.downstream.len()
                    || plan.downstream.iter().any(|peer| !neighbor(*peer))
                {
                    return Err("invalid_room_projection");
                }
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
                    || !view.authorized
                        && (file.receiving
                            || file.source_id == Some(*recipient)
                            || file.upstream.is_none()
                            || file.downstream.is_empty())
                    || file.message_seq == 0
                    || file.attachment.validate().is_err()
                    || file.downstream.len() > MAX_TREE_EDGES
                    || file.downstream.iter().collect::<BTreeSet<_>>().len()
                        != file.downstream.len()
                    || file.source_id.is_some_and(|source| {
                        !projection
                            .views
                            .get(&source)
                            .is_some_and(|view| view.authorized)
                    })
                    || file.upstream.is_some_and(|peer| !neighbor(peer))
                    || file.downstream.iter().any(|peer| !neighbor(*peer))
                {
                    return Err("invalid_room_projection");
                }
            }
        }
        let mut publications = BTreeMap::new();
        for publication in &projection.publications {
            if publications.insert(publication.id, publication).is_some()
                || validate_video_settings(publication.kind, publication.video_settings).is_err()
                || match (publication.kind, &publication.screen) {
                    (Kind::Screen, Some(screen)) => {
                        screen
                            .direct_limit
                            .is_some_and(|n| !(1..=crate::MAX_RELAY_CAPACITY).contains(&n))
                            || [&screen.source.name, &screen.title]
                                .into_iter()
                                .flatten()
                                .any(|value| title(value).as_deref() != Some(value.as_str()))
                    }
                    (Kind::Voice, None) => false,
                    _ => true,
                }
                || publication.room_id != id
                || publication.audience.len() > MAX_SESSIONS
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
                                view.authorized && view.subscriptions.contains(&publication.id)
                            })
                })
                || !endpoints
                    .get(&publication.session_id)
                    .is_some_and(|e| e.member.user_id == publication.user_id)
                || !projection
                    .views
                    .get(&publication.session_id)
                    .is_some_and(|view| view.authorized)
                || self.remote.iter().any(|(other_id, other)| {
                    other_id != id
                        && other
                            .projection
                            .as_ref()
                            .is_some_and(|p| p.publications.iter().any(|p| p.id == publication.id))
                })
            {
                return Err("invalid_room_projection");
            }
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
                    (v.authorized || v.transit_endpoint.is_some())
                        && publications.contains_key(&flow.publication_id)
                })
                || !projection.views.get(&flow.receiver).is_some_and(|v| {
                    (v.authorized || v.transit_endpoint.is_some())
                        && publications.contains_key(&flow.publication_id)
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
            let source = publications[&flow.publication_id].session_id;
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
                        .is_some_and(|view| view.authorized || view.transit_endpoint.is_some())
                })
            {
                return Err("invalid_room_projection");
            }
        }
        let base_root = projection.base_root(binding.session);
        if self.hosting_mode == HostingMode::Lightweight && base_root != binding.session {
            return Err("invalid_room_projection");
        }
        let mut base_parents = BTreeMap::new();
        for link in projection.base_links.iter().filter(|link| link.selected) {
            if link.child == base_root
                || base_parents.insert(link.child, link.parent).is_some()
            {
                return Err("invalid_room_projection");
            }
        }
        for child in base_parents.keys() {
            let mut path = BTreeSet::new();
            let mut node = *child;
            while node != base_root {
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
            while parent != base_root {
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
        let mut next = projection.clone();
        if let Some(previous) = &room.projection {
            next.last_message_seq = next.last_message_seq.max(previous.last_message_seq);
        }
        // Public access alone applies to every visitor. Only a personal room
        // interaction, or the host's private grant, qualifies for offline status.
        room.known_sessions
            .retain(|id| next.views.get(id).is_some_and(|view| view.authorized));
        room.known_sessions
            .extend(next.views.iter().filter_map(|(id, view)| {
                (view.authorized
                    && (room.summary.access == RoomAccess::Private
                        || view.reading
                        || next.participant_session_ids.contains(id)
                        || !view.subscriptions.is_empty()
                        || !view.watch_subscriptions.is_empty()
                        || view
                            .files
                            .iter()
                            .any(|plan| plan.receiving || plan.source_id == Some(*id))))
                .then_some(*id)
            }));
        room.projection = Some(next);
        self.reconcile();
        Ok(self.finish_host_output(id, output, true))
    }

    fn finish_host_output(
        &mut self,
        id: &str,
        output: &HostOutput,
        projection_applied: bool,
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
            deleted_by: None,
            projection_applied,
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

    fn service_relay(
        &self,
        recipient: Option<&crate::room::RoomRecipient>,
    ) -> crate::wire::ServiceRelay {
        crate::wire::ServiceRelay {
            available: self.service_endpoint.is_some(),
            enabled: recipient.is_some_and(|view| view.allow_service_relay),
        }
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
                Ok::<_, &'static str>(ScreenTopology {
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
        let relay = self.service_relay(projection.views.get(&session));
        Ok(RoomTopology {
            service_available: relay.available,
            service_enabled: relay.enabled,
            binding_id: binding.id,
            transit_session: projection
                .views
                .iter()
                .find_map(|(session, view)| view.transit_endpoint.is_some().then_some(*session)),
            base: BaseTopology {
                root_session_id: projection.base_root(binding.session),
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
        let mut watch_activities = Vec::new();
        let mut watch_bytes = Vec::new();
        let mut watch_subscriptions = BTreeSet::new();
        let mut voice = Vec::new();
        let mut files = Vec::new();
        let mut subscriptions = BTreeSet::new();
        let mut failed_subscriptions = BTreeSet::new();
        if let Some(member) = member {
            for room in self.remote.values() {
                if member.user_id != room.summary.creator_id
                    && !self
                        .room_creation_policy
                        .permits(Some(self.identity.owner_id), &room.summary)
                {
                    continue;
                }
                if let Some(projection) =
                    room.projection.as_ref().filter(|_| room.binding.is_some())
                {
                    if let Some(view) = projection
                        .views
                        .get(&session_id)
                        .filter(|view| view.transit_endpoint.is_some() && !view.authorized)
                    {
                        publications.extend(
                            projection
                                .publications
                                .iter()
                                .filter(|publication| {
                                    projection.flows.iter().any(|flow| {
                                        flow.publication_id == publication.id
                                            && (flow.sender == session_id
                                                || flow.receiver == session_id)
                                    })
                                })
                                .cloned()
                                .map(|mut publication| {
                                    publication.audience.clear();
                                    if let Some(screen) = &mut publication.screen {
                                        screen.title = None;
                                        screen.source.name = None;
                                    }
                                    publication
                                }),
                        );
                        files.extend(view.files.clone());
                        watch_bytes.extend(view.watch_bytes.clone());
                    }
                }
                if let Some(mut snapshot) =
                    room.snapshot(member, session_id, Self::host_online(&self.identity, room))
                {
                    let bound = room.binding.as_ref().zip(room.projection.as_ref());
                    if let Some((binding, projection)) = bound.filter(|_| snapshot.room.authorized)
                    {
                        snapshot.room.delivery = Some(RoomDelivery {
                            host_session_id: binding.session,
                            binding_id: binding.id,
                            next_hops: room_next_hops(session_id, &projection.base_links),
                        });
                        if snapshot.room.available
                            && binding.applied_revision >= binding.projection_floor
                        {
                            snapshot.room.service_relay = projection
                                .views
                                .get(&session_id)
                                .filter(|view| view.can_manage)
                                .map(|view| self.service_relay(Some(view)));
                        }
                    }
                    rooms.push(snapshot.room);
                    publications.extend(snapshot.publications);
                    watch_activities.extend(snapshot.watch_activities);
                    watch_bytes.extend(snapshot.watch_bytes);
                    watch_subscriptions.extend(snapshot.watch_subscriptions);
                    voice.extend(snapshot.voice);
                    files.extend(snapshot.files);
                    subscriptions.extend(snapshot.subscriptions);
                    failed_subscriptions.extend(snapshot.failed_subscriptions);
                }
            }
        }
        let user_ids: BTreeSet<_> = self
            .identity
            .sessions
            .values()
            .map(|session| session.user_id)
            .chain(rooms.iter().map(|room| room.creator_id))
            .chain(std::iter::once(self.identity.owner_id))
            .collect();
        Snapshot {
            watch_activities,
            watch_bytes,
            watch_subscriptions: watch_subscriptions.into_iter().collect(),
            files,
            channel: ChannelInfo {
                hosting_mode: self.hosting_mode,
                room_creation_policy: self.room_creation_policy,
                managed_room_ids: if member
                    .is_some_and(|member| member.user_id == self.identity.owner_id)
                {
                    self.remote
                        .keys()
                        .chain(self.restorable_rooms.keys())
                        .chain(self.pending_room_deletions.keys())
                        .cloned()
                        .collect()
                } else {
                    Vec::new()
                },
                user_count: self.identity.users.len(),
                history_window: HISTORY_WINDOW,
                id: self.id,
                name: self.name.clone(),
                icon: self.icon.clone(),
                owner_id: Some(self.identity.owner_id),
                rooms,
            },
            users: user_ids
                .iter()
                .filter_map(|id| self.identity.users.get(id))
                .map(crate::identity::User::summary)
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
    pub(crate) version: u32,
    #[serde(flatten)]
    pub(crate) header: DomainStateHeader,
    pub(crate) users: Vec<StoredUser>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainStateHeader {
    #[serde(default)]
    pub(crate) hosting_mode: HostingMode,
    #[serde(default)]
    pub(crate) room_creation_policy: RoomCreationPolicy,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) restorable_rooms: BTreeMap<String, Uuid>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) pending_room_deletions: BTreeMap<String, Uuid>,
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) icon: IdentityIcon,
    pub(crate) owner_id: Uuid,
    #[serde(deserialize_with = "read_directory")]
    pub(crate) hosted_rooms: BTreeMap<String, RoomSummary>,
}

// Older checkpoints put the room's uploaded picture in its directory icon.
// Keep the binding and let its room writer restore the picture.
fn read_directory<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, RoomSummary>, D::Error> {
    BTreeMap::<String, Value>::deserialize(deserializer)?
        .into_iter()
        .map(|(id, mut row)| {
            if row
                .get("icon")
                .and_then(Value::as_str)
                .is_some_and(identity_image)
            {
                row["icon"] = serde_json::to_value(RoomIcon::default()).unwrap();
            }
            let summary = serde_json::from_value(row).map_err(serde::de::Error::custom)?;
            Ok((id, summary))
        })
        .collect()
}

impl DurableState {
    pub fn hosting_mode(&self) -> HostingMode {
        self.header.hosting_mode
    }
}

impl RoomCreationPolicy {
    pub fn permits(self, owner_id: Option<Uuid>, room: &RoomSummary) -> bool {
        self.permits_request(Some(room.creator_id) == owner_id, Some(room))
    }

    // Before an upload is read, only the requesting user's role is available.
    fn permits_request(self, is_owner: bool, settings: Option<&RoomSummary>) -> bool {
        is_owner || match self {
            Self::Ordinary => true,
            Self::InviteOnly => settings.is_none_or(|room| {
                room.access == RoomAccess::Private && room.hidden && !room.has_password
            }),
            Self::OwnerOnly => false,
        }
    }
}

impl DomainStateHeader {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_nil()
            || self.owner_id.is_nil()
            || title(&self.name).is_none()
            || self.hosted_rooms.len()
                + self.restorable_rooms.len()
                + self.pending_room_deletions.len()
                > MAX_ROOMS
            || self.pending_room_deletions.iter().any(|(id, creator)| {
                self.hosting_mode != HostingMode::Hosted
                    || !valid_id(id)
                    || creator.is_nil()
                    || self.hosted_rooms.contains_key(id)
                    || self.restorable_rooms.contains_key(id)
            })
            || self.restorable_rooms.iter().any(|(id, creator)| {
                !valid_id(id)
                    || creator.is_nil()
                    || *creator == self.owner_id
                    || self.hosted_rooms.contains_key(id)
            })
            || self
                .hosted_rooms
                .iter()
                .any(|(id, room)| id != &room.id || room.validate().is_err())
        {
            return Err("invalid_state");
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "channel_tests.rs"]
mod tests;
