//! Shared channel authority and room state for Browser, Native and Server adapters.
//!
//! The caller supplies connection identities and time, completes room-storage
//! effects, then delivers their events before admitting another command.
//! This core owns no sockets, queues, locks or timers.
//! Use a fresh connection UUID for each transport and Unix milliseconds for time.

mod access;
pub mod attachment;
pub mod backup;
mod channel;
mod connectivity;
pub mod conversation;
pub mod file_delivery;
pub mod file_room;
pub mod forwarding;
pub mod history;
pub mod host;
mod identity;
pub mod input;
mod publication;
mod remote;
mod room;
mod routes;
#[cfg(feature = "sqlite")]
pub mod storage;
#[cfg(feature = "sqlite")]
mod stored_room;
pub mod topology;
mod transport;
pub mod udp;
pub mod watch_delivery;
pub mod wire;
pub mod wire_images;

pub use access::{RoomAppearance, RoomPermission, RoomState, MAX_RELAY_CAPACITY};
pub use attachment::{AttachmentDescriptor, AttachmentLimits, ATTACHMENT_LIMITS};
pub use channel::{DomainStateHeader, DurableState};
pub use identity::{Endpoint, Member, User, MAX_SESSIONS, PROFILE_PAGE_SIZE, RECOVERY_MS};
pub use room::{RoomRecipient, RoomRuntime, RoomSnapshot};
#[cfg(feature = "sqlite")]
pub use stored_room::{RoomBackup, StoredRoomHost};

use channel::Channel;
use host::{HostOutput, RequestContext, RoomReply, RoomResult};
use identity::Admission;
use serde_json::Value;
use uuid::Uuid;
use wire::{Command, Event, Request, CHANNEL_PROTOCOL};

/// Events are addressed to physical connections, not reusable endpoint sessions.
/// Deliver events before closing the listed connections so leave can acknowledge.
#[derive(Default)]
pub struct Effects {
    pub events: Vec<(Uuid, Event)>,
    pub close: Vec<Uuid>,
}

#[derive(Clone)]
pub struct Authority {
    channel: Channel,
}

/// A server-assigned room identity tied to the creator's current connection.
pub struct RoomCreation {
    summary: host::RoomSummary,
    session: Uuid,
    connection: Uuid,
}

impl RoomCreation {
    pub fn summary(&self) -> &host::RoomSummary {
        &self.summary
    }
}

impl Authority {
    pub fn new(owner_key: String, ice_servers: Vec<Value>) -> Result<Self, &'static str> {
        if !wire::valid_id(&owner_key) {
            return Err("invalid_owner_key");
        }
        Ok(Self {
            channel: Channel::new(owner_key, ice_servers),
        })
    }

    /// Checkpoint domain identity and hosted-room summaries; room data stays with its host.
    pub fn export_state(&self) -> DurableState {
        self.channel.export_state()
    }

    /// Seed a newly opened domain before admitting its first connection.
    pub fn set_room_creation_policy(&mut self, policy: wire::RoomCreationPolicy) {
        self.channel.set_room_creation_policy(policy);
    }

    pub fn hosting_mode(&self) -> wire::HostingMode {
        self.channel.hosting_mode
    }

    pub fn set_hosting_mode(&mut self, mode: wire::HostingMode) {
        self.channel.hosting_mode = mode;
    }

    pub fn set_room_writer(&mut self, writer: host::ServiceEndpoint) -> Result<(), &'static str> {
        if self.current_connection(writer.session_id) != Some(writer.connection_id) {
            return Err("hosting_unavailable");
        }
        self.channel.room_writer = Some(writer);
        Ok(())
    }

    pub fn offline_hosted_creator(&self, id: &str) -> Option<Uuid> {
        if let Some(creator) = self.channel.pending_room_deletions.get(id) {
            return Some(*creator);
        }
        let room = self.channel.remote.get(id)?;
        (self.hosting_mode() == wire::HostingMode::Hosted
            && room.reservation.is_none()
            && !self.channel.room_online(id))
        .then_some(room.summary.creator_id)
    }

    pub fn cancel_room_reservation(&mut self, connection: Uuid, room_id: &str) -> bool {
        let Some(session) = self.channel.identity.session_for_connection(connection) else {
            return false;
        };
        self.cancel_reservation(session, room_id)
    }

    fn cancel_reservation(&mut self, session: Uuid, room_id: &str) -> bool {
        if self
            .channel
            .remote
            .get(room_id)
            .is_some_and(|room| room.reservation == Some(session) && room.binding.is_none())
        {
            self.channel.remote.remove(room_id);
            return true;
        }
        false
    }

    /// The storage owner has confirmed that the retired room's records are gone.
    pub fn finish_hosted_deletion(&mut self, id: &str) -> Effects {
        let mut effects = Effects::default();
        if self.channel.pending_room_deletions.remove(id).is_some() {
            self.broadcast(None, &mut effects);
        }
        effects
    }

    /// Private hosting data for the domain's storage owner, never a client event.
    pub fn export_backup(&self) -> backup::DomainMetadata {
        backup::DomainMetadata {
            version: 2,
            state: self.export_state(),
            owner_key: self.channel.identity.owner_key.clone(),
        }
    }

    /// The local App/Server bootstrap uses the key owned by the opened domain.
    pub fn owner_admission_key(&self) -> &str {
        &self.channel.identity.owner_key
    }

    pub fn is_owner_credential(&self, credential: &str) -> bool {
        self.user_for_credential(credential)
            .is_some_and(|user| user.id == self.channel.identity.owner_id)
    }

    pub fn is_room_creator(&self, room_id: &str, user_id: Uuid) -> bool {
        self.channel
            .remote
            .get(room_id)
            .is_some_and(|room| room.summary.creator_id == user_id)
    }

    /// Verify a supplied personal credential without creating or changing a session.
    pub fn user_for_credential(&self, credential: &str) -> Option<&User> {
        let id = self.channel.identity.user_for_credential(credential)?;
        self.channel.identity.users.get(&id)
    }

    /// Host history/activity never rewrites the domain checkpoint. Only public
    /// directory changes and completed domain admission belong in that store.
    pub fn changes_metadata(&self, request: &Request) -> bool {
        match &request.command {
            Command::HostRegister { room, .. } => self
                .channel
                .remote
                .get(&room.id)
                .is_none_or(|current| current.reservation.is_some() || current.summary != *room),
            Command::HostOutput { room_id, output } => {
                self.channel
                    .remote
                    .get(room_id)
                    .is_some_and(|room| room.summary != output.projection.summary)
                    || output.reply.as_ref().is_some_and(|reply| {
                        matches!(reply.result, RoomResult::Deleted { data_removed: true })
                    })
            }
            Command::Join { .. }
            | Command::SetProfile { .. }
            | Command::UpdateDomain { .. }
            | Command::SetRoomCreationPolicy { .. }
            | Command::AdmitRoom { .. }
            | Command::DeleteRoom { .. } => true,
            _ => false,
        }
    }
    /// Restore before admitting connections. Transport rollback should use a live clone.
    pub fn import_state(&mut self, state: DurableState) -> Result<(), &'static str> {
        self.channel.import_state(state)
    }
    pub fn owner_name(&self) -> Option<&str> {
        self.channel
            .identity
            .users
            .get(&self.channel.identity.owner_id)
            .map(|user| user.name.as_str())
    }

    /// The channel and its owner's user ID, available before any endpoint joins.
    pub fn identity(&self) -> (Uuid, Uuid) {
        self.channel.identity()
    }

    /// The embedding Server passes its Native's actual Welcome, never a later socket lookup.
    pub fn set_service_endpoint(
        &mut self,
        service: Option<host::ServiceEndpoint>,
    ) -> Result<Effects, &'static str> {
        if service.is_some_and(|service| {
            self.current_connection(service.session_id) != Some(service.connection_id)
        }) {
            return Err("service_unavailable");
        }
        self.channel.service_endpoint = service;
        self.channel.reconcile();
        let mut effects = Effects::default();
        self.sync_hosts(&mut effects, true);
        self.broadcast(None, &mut effects);
        Ok(effects)
    }

    pub fn current_connection(&self, session: Uuid) -> Option<Uuid> {
        self.channel.identity.sessions.get(&session)?.connection
    }

    pub fn prepare_hosted_creation(
        &self,
        session: Uuid,
        connection: Uuid,
        summary: host::RoomSummary,
    ) -> Result<RoomCreation, &'static str> {
        let creation = self.channel.prepare_creation(session, summary)?;
        if self.hosting_mode() != wire::HostingMode::Hosted || creation.connection != connection {
            return Err("disconnected");
        }
        self.channel.validate_room_summary(&creation.summary)?;
        Ok(creation)
    }

    /// Only an installed or actively installing room needs a directory reservation.
    pub fn reserve_hosted_creation(&mut self, creation: &RoomCreation) -> Result<(), &'static str> {
        if self.hosting_mode() != wire::HostingMode::Hosted
            || self.current_connection(creation.session) != Some(creation.connection)
        {
            return Err("disconnected");
        }
        self.channel.reserve_creation(creation)
    }

    pub fn creation_connection(&self, session: Uuid, user: Uuid) -> Result<Uuid, &'static str> {
        let connection = self
            .channel
            .identity
            .sessions
            .get(&session)
            .filter(|endpoint| endpoint.user_id == user)
            .and_then(|endpoint| endpoint.connection)
            .ok_or("forbidden")?;
        self.channel.check_room_creator(user)?;
        Ok(connection)
    }

    pub fn cancel_hosted_creation(&mut self, creation: &RoomCreation) -> Effects {
        let mut effects = Effects::default();
        if self.cancel_reservation(creation.session, &creation.summary.id) {
            self.broadcast(None, &mut effects);
        }
        effects
    }

    /// Apply a validated request only through its current connection binding.
    pub fn handle(&mut self, connection: Uuid, request: Request, now: u64) -> Effects {
        let mut effects = self.expire(now);
        let Some(session_id) = self.channel.identity.session_for_connection(connection) else {
            self.join(connection, request, now, &mut effects);
            return effects;
        };
        // Transport completion can arrive after its last lease has retired.
        if !self.channel.current_report(session_id, &request.command) {
            if let Some(request_id) = request.request_id {
                effects.events.push((connection, Event::Ack { request_id }));
            }
            return effects;
        }
        let context = RequestContext {
            connection,
            session_id,
            request_id: request.request_id.clone(),
            now,
        };
        match &request.command {
            Command::Profiles { ids, after, query } => {
                match request
                    .request_id
                    .clone()
                    .ok_or("invalid_request_id")
                    .and_then(|request_id| {
                        self.channel
                            .identity
                            .profiles(ids.as_deref(), *after, query.as_deref())
                            .map(|(profiles, total, next_cursor)| Event::Profiles {
                                request_id,
                                profiles,
                                total,
                                next_cursor,
                            })
                    }) {
                    Ok(event) => effects.events.push((connection, event)),
                    Err(code) => Self::error(connection, request.request_id, code, &mut effects),
                }
                return effects;
            }
            Command::Conversation { packet } => {
                match self.channel.relay_conversation(session_id, packet) {
                    Ok((recipient, changed)) => {
                        self.deliver(
                            recipient,
                            Event::Conversation {
                                packet: packet.clone(),
                            },
                            &mut effects,
                        );
                        if changed {
                            self.broadcast(None, &mut effects);
                        }
                    }
                    Err(code) => Self::error(connection, request.request_id, code, &mut effects),
                }
                return effects;
            }
            Command::CancelRoomCreation { room_id } => {
                if self.cancel_room_reservation(connection, room_id) {
                    self.broadcast(None, &mut effects);
                }
                if let Some(request_id) = request.request_id {
                    effects.events.push((connection, Event::Ack { request_id }));
                }
                return effects;
            }
            Command::CreateRoom { room, .. } => {
                match self.channel.create_room(session_id, room.clone()) {
                    Ok(room) => {
                        self.broadcast(None, &mut effects);
                        effects.events.push((
                            connection,
                            Event::RoomCreated {
                                room,
                                request_id: request.request_id,
                            },
                        ));
                    }
                    Err(code) => Self::error(connection, request.request_id, code, &mut effects),
                }
                return effects;
            }
            Command::AdmitRoom { room } => {
                match self.channel.admit_room(session_id, room.clone()) {
                    Ok(()) => {
                        self.broadcast(None, &mut effects);
                        if let Some(request_id) = request.request_id {
                            effects.events.push((connection, Event::Ack { request_id }));
                        }
                    }
                    Err(code) => Self::error(connection, request.request_id, code, &mut effects),
                }
                return effects;
            }
            Command::DeleteRoom {
                room_id,
                delete_data,
            } => {
                let actor = self.channel.identity.sessions[&session_id].user_id;
                let room = self.channel.remote.get(room_id);
                let hosted_data = self.hosting_mode() == wire::HostingMode::Hosted
                    && room.is_some_and(|room| room.reservation.is_none());
                if let Err(code) = self.channel.can_remove_room(session_id, room_id) {
                    Self::error(connection, request.request_id, code, &mut effects);
                } else if self.channel.room_online(room_id)
                    && (hosted_data
                        || (*delete_data
                            && room.is_some_and(|room| room.summary.creator_id == actor)))
                {
                    match self.channel.forward_room(
                        room_id,
                        context,
                        Command::DeleteRoom {
                            room_id: room_id.clone(),
                            delete_data: true,
                        },
                    ) {
                        Ok((session, event)) => self.deliver(session, event, &mut effects),
                        Err(code) => {
                            Self::error(connection, request.request_id, code, &mut effects)
                        }
                    }
                } else {
                    if hosted_data {
                        self.channel
                            .pending_room_deletions
                            .insert(room_id.clone(), room.unwrap().summary.creator_id);
                    }
                    for (room, reply) in self.channel.remove_room(room_id, actor) {
                        self.room_reply(&room, reply, &mut effects);
                    }
                    self.broadcast(None, &mut effects);
                    effects.events.push((
                        connection,
                        Event::RoomReply {
                            room_id: room_id.clone(),
                            request_id: request.request_id,
                            result: RoomResult::Deleted {
                                data_removed: false,
                            },
                        },
                    ));
                }
                return effects;
            }
            Command::RoomTopology {
                room_id,
                publication_id,
            } => {
                match self
                    .channel
                    .room_topology(room_id, session_id, *publication_id)
                {
                    Ok(topology) => effects.events.push((
                        connection,
                        Event::RoomReply {
                            room_id: room_id.clone(),
                            request_id: request.request_id,
                            result: RoomResult::Topology { topology },
                        },
                    )),
                    Err(code) => Self::error(connection, request.request_id, code, &mut effects),
                }
                return effects;
            }
            Command::HostRegister {
                room,
                resume_binding,
            } => {
                let result = self.channel.register_host(
                    session_id,
                    connection,
                    room.clone(),
                    *resume_binding,
                );
                match result {
                    Ok((events, replies)) => {
                        for (room, reply) in replies {
                            self.room_reply(&room, reply, &mut effects);
                        }
                        for (session, event) in events {
                            self.deliver(session, event, &mut effects);
                        }
                        self.broadcast(None, &mut effects);
                        if let Some(request_id) = request.request_id {
                            effects.events.push((connection, Event::Ack { request_id }));
                        }
                    }
                    Err(code) => Self::error(connection, request.request_id, code, &mut effects),
                }
                return effects;
            }
            Command::HostOutput { room_id, output } => {
                if let Err(code) = self.host_output(
                    room_id,
                    session_id,
                    connection,
                    output.clone(),
                    &mut effects,
                ) {
                    Self::error(connection, request.request_id, code, &mut effects);
                }
                return effects;
            }
            Command::HostStop {
                room_id,
                binding_id,
            } => {
                match self
                    .channel
                    .stop_host(room_id, session_id, connection, *binding_id)
                {
                    Ok(replies) => {
                        for (room, reply) in replies {
                            self.room_reply(&room, reply, &mut effects);
                        }
                        self.broadcast(None, &mut effects);
                        if let Some(request_id) = request.request_id {
                            effects.events.push((connection, Event::Ack { request_id }));
                        }
                    }
                    Err(code) => Self::error(connection, request.request_id, code, &mut effects),
                }
                return effects;
            }
            _ => {}
        }
        if let Some(room) = self.channel.command_room(&request.command) {
            match self.channel.forward_room(&room, context, request.command) {
                Ok((session, event)) => self.deliver(session, event, &mut effects),
                Err(code) => Self::error(connection, request.request_id, code, &mut effects),
            }
            return effects;
        }
        let sync_hosts = matches!(request.command, Command::Leave);
        match self.channel.handle(session_id, request.command, now) {
            Ok(outcome) => {
                for (room, reply) in outcome.replies {
                    self.room_reply(&room, reply, &mut effects);
                }
                for (recipient, event) in outcome.events {
                    self.deliver(recipient, event, &mut effects);
                }
                if sync_hosts {
                    self.sync_hosts(&mut effects, true);
                }
                if outcome.broadcast {
                    self.broadcast(None, &mut effects);
                }
                if outcome.leave {
                    effects.events.push((
                        connection,
                        Event::State {
                            state: self.channel.snapshot(session_id),
                        },
                    ));
                }
                if let Some(request_id) = request.request_id {
                    effects.events.push((connection, Event::Ack { request_id }));
                }
                if outcome.leave {
                    effects.close.push(connection);
                }
            }
            Err(code) => effects.events.push((
                connection,
                Event::Error {
                    code: code.into(),
                    request_id: request.request_id,
                },
            )),
        }
        effects
    }

    pub fn disconnect(&mut self, connection: Uuid, now: u64) -> Effects {
        self.channel.now = now;
        let mut effects = Effects::default();
        if let Some(session_id) = self.channel.identity.session_for_connection(connection) {
            self.channel
                .identity
                .disconnect(session_id, connection, now);
            self.channel.reconcile();
            self.sync_hosts(&mut effects, false);
            self.broadcast(None, &mut effects);
        }
        effects
    }

    /// Room data is already deleted, but the directory checkpoint failed.
    /// Preserve its prior summary as unavailable so removal can be retried.
    pub fn failed_room_delete(&mut self, id: &str, request: &RequestContext) -> Effects {
        let mut effects = Effects::default();
        if let Some(room) = self.channel.remote.get_mut(id) {
            for (room, reply) in room.pause() {
                if &reply.context != request {
                    self.room_reply(&room, reply, &mut effects);
                }
            }
        }
        self.channel.reconcile();
        self.broadcast(None, &mut effects);
        effects
    }

    /// Expire endpoint activities together, keeping unrelated publications alive.
    pub fn expire(&mut self, now: u64) -> Effects {
        self.channel.now = now;
        let mut effects = Effects::default();
        let (expired, replies) = self.channel.expire_sessions(now);
        for (room, reply) in replies {
            self.room_reply(&room, reply, &mut effects);
        }
        if expired {
            self.sync_hosts(&mut effects, true);
        }
        if self.channel.expire_discovery(now) || expired {
            self.broadcast(None, &mut effects);
        }
        for (session, event) in self.channel.wake_hosts(now) {
            self.deliver(session, event, &mut effects);
        }
        effects
    }

    fn join(&mut self, connection: Uuid, request: Request, now: u64, effects: &mut Effects) {
        if matches!(&request.command, Command::Join { protocol, .. } if *protocol != CHANNEL_PROTOCOL)
        {
            Self::error(
                connection,
                request.request_id,
                "incompatible_protocol",
                effects,
            );
            effects.close.push(connection);
            return;
        }
        let Command::Join {
            protocol: _,
            name,
            credential,
            owner_key,
            session_id,
            signing_key,
            can_prepare_udp,
            can_receive_video_layers,
        } = request.command
        else {
            effects.events.push((
                connection,
                Event::Error {
                    code: "join_required".into(),
                    request_id: request.request_id,
                },
            ));
            effects.close.push(connection);
            return;
        };
        match self.channel.join(
            Admission {
                name: &name,
                credential: credential.as_deref(),
                owner_key: owner_key.as_deref(),
                resume: session_id.as_deref(),
                signing_key,
                can_prepare_udp,
                can_receive_video_layers,
            },
            connection,
            now,
        ) {
            Ok(admitted) => {
                if let Some(old) = admitted
                    .replaced_connection
                    .filter(|old| *old != connection)
                {
                    effects.close.push(old);
                }
                effects.events.push((
                    connection,
                    Event::Welcome {
                        protocol: CHANNEL_PROTOCOL,
                        self_profile: self.channel.identity.users
                            [&self.channel.identity.sessions[&admitted.session_id].user_id]
                            .profile(),
                        credential: admitted.credential,
                        session_id: admitted.session_id,
                        connection_id: connection,
                        state: self.channel.snapshot(admitted.session_id),
                        invitation_origin: None,
                    },
                ));
                if let Some(request_id) = request.request_id {
                    effects.events.push((connection, Event::Ack { request_id }));
                }
                self.sync_hosts(effects, false);
                self.broadcast(Some(admitted.session_id), effects);
            }
            Err(code) => {
                effects.events.push((
                    connection,
                    Event::Error {
                        code: code.into(),
                        request_id: request.request_id,
                    },
                ));
                effects.close.push(connection);
            }
        }
    }

    fn deliver(&self, session_id: Uuid, event: Event, effects: &mut Effects) {
        if let Some(connection) = self
            .channel
            .identity
            .sessions
            .get(&session_id)
            .and_then(|session| session.connection)
        {
            effects.events.push((connection, event));
        }
    }

    fn error(connection: Uuid, request_id: Option<String>, code: &str, effects: &mut Effects) {
        effects.events.push((
            connection,
            Event::Error {
                code: code.into(),
                request_id,
            },
        ));
    }

    fn sync_hosts(&mut self, effects: &mut Effects, invalidate_projection: bool) {
        for (session, event) in self.channel.sync_hosts(invalidate_projection) {
            self.deliver(session, event, effects);
        }
    }

    fn host_output(
        &mut self,
        room_id: &str,
        session: Uuid,
        connection: Uuid,
        output: HostOutput,
        effects: &mut Effects,
    ) -> Result<(), &'static str> {
        let accepted = self
            .channel
            .accept_host(room_id, session, connection, &output)?;
        if let Some(actor) = accepted.deleted_by {
            for (room, reply) in self.channel.remove_room(room_id, actor) {
                self.room_reply(&room, reply, effects);
            }
            self.broadcast(None, effects);
        }
        if let Some((session, event)) = accepted.repair_input {
            self.deliver(session, event, effects);
        }
        if accepted.projection_applied {
            self.broadcast(None, effects);
        }
        for reply in accepted.replies {
            self.room_reply(room_id, reply, effects);
        }
        Ok(())
    }

    fn room_reply(&mut self, room_id: &str, reply: RoomReply, effects: &mut Effects) {
        let context = reply.context;
        if self
            .channel
            .identity
            .session_for_connection(context.connection)
            != Some(context.session_id)
        {
            return;
        }
        let mut completion = RoomResult::Done;
        match reply.result {
            RoomResult::Invite { key } => effects.events.push((
                context.connection,
                Event::RoomInvite {
                    room_id: room_id.into(),
                    key,
                    request_id: context.request_id.clone(),
                },
            )),
            RoomResult::InviteState { invitation } => effects.events.push((
                context.connection,
                Event::RoomInviteState {
                    room_id: room_id.into(),
                    invitation,
                    request_id: context.request_id.clone(),
                },
            )),
            RoomResult::WatchReady { server_time } => {
                completion = RoomResult::WatchReady { server_time }
            }
            RoomResult::Error { code } => completion = RoomResult::Error { code },
            RoomResult::Deleted { data_removed } => {
                completion = RoomResult::Deleted { data_removed }
            }
            _ => {}
        }
        effects.events.push((
            context.connection,
            Event::RoomReply {
                room_id: room_id.into(),
                request_id: context.request_id,
                result: completion,
            },
        ));
    }

    fn broadcast(&mut self, except: Option<Uuid>, effects: &mut Effects) {
        for (source, event) in self.channel.input_states() {
            self.deliver(source, event, effects);
        }
        for session in self
            .channel
            .identity
            .sessions
            .values()
            .filter(|session| Some(session.id) != except && session.connection.is_some())
        {
            self.deliver(
                session.id,
                Event::State {
                    state: self.channel.snapshot(session.id),
                },
                effects,
            );
        }
    }
}
