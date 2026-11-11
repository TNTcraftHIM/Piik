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
pub mod conversation;
pub mod file_delivery;
pub mod file_room;
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
pub mod wire;
pub mod wire_images;

pub use access::{RoomPermission, RoomState};
pub use attachment::{AttachmentDescriptor, AttachmentLimits, ATTACHMENT_LIMITS};
pub use channel::DurableState;
pub use identity::{Endpoint, Member, User, RECOVERY_MS};
pub use room::{RoomRuntime, RoomSnapshot};
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
                .is_none_or(|current| current.summary != *room),
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
            | Command::CreateRoom { .. }
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
            Command::Conversation { packet } => {
                match self.channel.relay_conversation(session_id, packet) {
                    Ok(recipient) => self.deliver(
                        recipient,
                        Event::Conversation {
                            packet: packet.clone(),
                        },
                        &mut effects,
                    ),
                    Err(code) => Self::error(connection, request.request_id, code, &mut effects),
                }
                return effects;
            }
            Command::CreateRoom { room } => {
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
                if let Err(code) = self.channel.manages_room(session_id, room_id) {
                    Self::error(connection, request.request_id, code, &mut effects);
                } else if *delete_data && self.channel.room_online(room_id) {
                    match self
                        .channel
                        .forward_room(room_id, context, request.command.clone())
                    {
                        Ok((session, event)) => self.deliver(session, event, &mut effects),
                        Err(code) => {
                            Self::error(connection, request.request_id, code, &mut effects)
                        }
                    }
                } else {
                    for (room, binding, reply) in self.channel.remove_room(room_id) {
                        self.room_reply(&room, binding, reply, &mut effects);
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
                        for (room, binding, reply) in replies {
                            self.room_reply(&room, binding, reply, &mut effects);
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
                        for (room, binding, reply) in replies {
                            self.room_reply(&room, binding, reply, &mut effects);
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
                for (room, binding, reply) in outcome.replies {
                    self.room_reply(&room, binding, reply, &mut effects);
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
            for (room, binding, reply) in room.pause() {
                if &reply.context != request {
                    self.room_reply(&room, binding, reply, &mut effects);
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
        for (room, binding, reply) in replies {
            self.room_reply(&room, binding, reply, &mut effects);
        }
        if expired {
            self.sync_hosts(&mut effects, true);
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
                        credential: admitted.credential,
                        session_id: admitted.session_id,
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
        if output
            .reply
            .as_ref()
            .is_some_and(|reply| matches!(reply.result, RoomResult::Deleted { data_removed: true }))
        {
            for (room, binding, reply) in self.channel.remove_room(room_id) {
                self.room_reply(&room, binding, reply, effects);
            }
            self.broadcast(None, effects);
        }
        if accepted.projection_applied {
            self.broadcast(None, effects);
        }
        for reply in accepted.replies {
            self.room_reply(room_id, output.binding_id, reply, effects);
        }
        Ok(())
    }

    fn room_reply(
        &mut self,
        room_id: &str,
        _binding_id: Uuid,
        reply: RoomReply,
        effects: &mut Effects,
    ) {
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
