//! Shared channel authority and room state for Browser, Native and Server adapters.
//!
//! The caller supplies connection identities and time, completes room-storage
//! effects, then delivers their events before admitting another command.
//! This core owns no sockets, queues, locks or timers.
//! Use a fresh connection UUID for each transport and Unix milliseconds for time.

mod access;
pub mod attachment;
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
mod transport;
pub mod wire;

pub use access::{RoomPermission, RoomState};
pub use attachment::{AttachmentDescriptor, AttachmentLimits, ATTACHMENT_LIMITS};
pub use channel::DurableState;
pub use identity::{Endpoint, Member, User, RECOVERY_MS};
pub use room::{RoomRuntime, RoomSnapshot};
#[cfg(feature = "sqlite")]
pub use stored_room::StoredRoomHost;

use channel::Channel;
use host::{HostAction, HostOutput, RequestContext, RoomReply, RoomResult};
use identity::Admission;
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;
use wire::{Command, Event, Request};

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
    pending_joins: BTreeMap<Uuid, PendingJoin>,
}

#[derive(Clone)]
struct PendingJoin {
    ticket: Uuid,
    room_id: String,
    binding_id: Uuid,
    command: Command,
    request_id: Option<String>,
    admitted: Option<identity::Admitted>,
    created_user: bool,
    started: u64,
}

impl Authority {
    pub fn new(
        owner_key: String,
        invite_key: String,
        ice_servers: Vec<Value>,
    ) -> Result<Self, &'static str> {
        if !wire::valid_id(&owner_key) || !wire::valid_id(&invite_key) || owner_key == invite_key {
            return Err("invalid_admission_keys");
        }
        Ok(Self {
            channel: Channel::new(owner_key, invite_key, ice_servers),
            pending_joins: BTreeMap::new(),
        })
    }

    /// Checkpoint domain identity and hosted-room summaries; room data stays with its host.
    pub fn export_state(&self) -> DurableState {
        let mut state = self.channel.export_state();
        state.omit_users(
            self.pending_joins
                .values()
                .filter(|pending| pending.created_user)
                .filter_map(|pending| pending.admitted.as_ref().map(|admitted| admitted.user_id)),
        );
        state
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
                    || output
                        .reply
                        .as_ref()
                        .is_some_and(|reply| matches!(reply.result, RoomResult::Invited))
            }
            Command::Join { .. } | Command::SetName { .. } | Command::SetRoles { .. } => true,
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
        if self
            .pending_joins
            .get(&connection)
            .is_some_and(|pending| pending.admitted.is_some())
        {
            Self::error(
                connection,
                request.request_id,
                "room_admission_pending",
                &mut effects,
            );
            return effects;
        }
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
                    Ok((_, events)) => {
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
                    now,
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
            _ => {}
        }
        if let Some(room) = self.channel.command_room(&request.command) {
            match self.channel.forward_room(&room, context, request.command) {
                Ok((session, event)) => self.deliver(session, event, &mut effects),
                Err(code) => Self::error(connection, request.request_id, code, &mut effects),
            }
            return effects;
        }
        let sync_hosts = matches!(request.command, Command::SetRoles { .. } | Command::Leave);
        match self.channel.handle(session_id, request.command, now) {
            Ok(outcome) => {
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
        if let Some(pending) = self.pending_joins.remove(&connection) {
            self.retire_pending(&pending);
        }
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

    /// Expire endpoint activities together, keeping unrelated publications alive.
    pub fn expire(&mut self, now: u64) -> Effects {
        self.channel.now = now;
        let mut effects = Effects::default();
        if self.channel.expire_sessions(now) {
            self.sync_hosts(&mut effects, true);
            self.broadcast(None, &mut effects);
        }
        for (session, event) in self.channel.wake_hosts(now) {
            self.deliver(session, event, &mut effects);
        }
        let expired: Vec<_> = self
            .pending_joins
            .iter()
            .filter(|(_, pending)| now.saturating_sub(pending.started) >= identity::RECOVERY_MS)
            .map(|(connection, _)| *connection)
            .collect();
        for connection in expired {
            let pending = self.pending_joins.remove(&connection).unwrap();
            self.retire_pending(&pending);
            Self::error(
                connection,
                pending.request_id,
                "room_host_offline",
                &mut effects,
            );
            effects.close.push(connection);
        }
        effects
    }

    fn join(&mut self, connection: Uuid, request: Request, now: u64, effects: &mut Effects) {
        if let Command::Join {
            room_id: Some(id),
            key: Some(key),
            credential,
            ..
        } = &request.command
        {
            if self.channel.remote.contains_key(id)
                && key != &self.channel.identity.invite_key
                && key != &self.channel.identity.owner_key
            {
                let ticket = Uuid::new_v4();
                let member = credential
                    .as_deref()
                    .and_then(|credential| self.channel.identity.user_for_credential(credential))
                    .and_then(|user| self.channel.identity.member(user).ok());
                match self.channel.host_input(
                    id,
                    HostAction::VerifyInvite {
                        ticket,
                        key: key.clone(),
                        member,
                    },
                ) {
                    Ok((session, event)) => {
                        let binding_id = self.channel.remote[id].binding.as_ref().unwrap().id;
                        self.pending_joins.insert(
                            connection,
                            PendingJoin {
                                ticket,
                                room_id: id.clone(),
                                binding_id,
                                command: request.command,
                                request_id: request.request_id,
                                admitted: None,
                                created_user: false,
                                started: now,
                            },
                        );
                        self.deliver(session, event, effects);
                    }
                    Err(code) => {
                        Self::error(connection, request.request_id, code, effects);
                        effects.close.push(connection);
                    }
                }
                return;
            }
        }
        let Command::Join {
            name,
            credential,
            key,
            session_id,
            room_id: _,
            signing_key,
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
                key: key.as_deref(),
                resume: session_id.as_deref(),
                signing_key,
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
                let owner = self.channel.identity.users[&admitted.user_id].owner;
                effects.events.push((
                    connection,
                    Event::Welcome {
                        credential: admitted.credential,
                        session_id: admitted.session_id,
                        state: self.channel.snapshot(admitted.session_id),
                        invite_key: owner.then(|| self.channel.identity.invite_key.clone()),
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
        now: u64,
        effects: &mut Effects,
    ) -> Result<(), &'static str> {
        let accepted = self
            .channel
            .accept_host(room_id, session, connection, &output)?;
        if accepted.projection_applied {
            self.broadcast(None, effects);
        }
        if let Some(invitation) = output.invitation {
            let target = self.pending_joins.iter().find_map(|(connection, pending)| {
                (pending.ticket == invitation.ticket
                    && pending.room_id == room_id
                    && pending.binding_id == output.binding_id
                    && pending.admitted.is_none())
                .then_some(*connection)
            });
            if let Some(target) = target {
                if !invitation.accepted || !accepted.invitation_current {
                    let pending = self.pending_joins.remove(&target).unwrap();
                    Self::error(target, pending.request_id, "invitation_required", effects);
                    effects.close.push(target);
                } else {
                    let pending = self.pending_joins.get(&target).unwrap().clone();
                    let Command::Join {
                        name,
                        credential,
                        session_id,
                        signing_key,
                        ..
                    } = &pending.command
                    else {
                        unreachable!()
                    };
                    let key = self.channel.identity.invite_key.clone();
                    let existing_user = credential.as_deref().and_then(|credential| {
                        self.channel.identity.user_for_credential(credential)
                    });
                    match self.channel.join(
                        Admission {
                            name,
                            credential: credential.as_deref(),
                            key: Some(&key),
                            resume: session_id.as_deref(),
                            signing_key: *signing_key,
                        },
                        target,
                        now,
                    ) {
                        Ok(admitted) => {
                            if let Some(old) =
                                admitted.replaced_connection.filter(|old| *old != target)
                            {
                                effects.close.push(old);
                            }
                            let context = RequestContext {
                                connection: target,
                                session_id: admitted.session_id,
                                request_id: pending.request_id,
                                now,
                            };
                            self.pending_joins.get_mut(&target).unwrap().admitted = Some(admitted);
                            self.pending_joins.get_mut(&target).unwrap().created_user =
                                existing_user.is_none();
                            self.sync_hosts(effects, false);
                            let (host, event) = self
                                .channel
                                .host_input(room_id, HostAction::GrantInvited { context })?;
                            self.deliver(host, event, effects);
                        }
                        Err(code) => {
                            self.pending_joins.remove(&target);
                            Self::error(target, pending.request_id, code, effects);
                            effects.close.push(target);
                        }
                    }
                }
            }
        }
        for reply in accepted.replies {
            self.room_reply(room_id, output.binding_id, reply, effects);
        }
        Ok(())
    }

    fn room_reply(
        &mut self,
        room_id: &str,
        binding_id: Uuid,
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
        if let RoomResult::Invited = reply.result {
            if let Some(pending) = self
                .pending_joins
                .remove(&context.connection)
                .filter(|pending| pending.room_id == room_id && pending.binding_id == binding_id)
            {
                if let Some(admitted) = pending.admitted {
                    effects.events.push((
                        context.connection,
                        Event::Welcome {
                            credential: admitted.credential,
                            session_id: admitted.session_id,
                            state: self.channel.snapshot(admitted.session_id),
                            invite_key: None,
                            invitation_origin: None,
                        },
                    ));
                    if let Some(request_id) = pending.request_id {
                        effects
                            .events
                            .push((context.connection, Event::Ack { request_id }));
                    }
                    self.broadcast(Some(admitted.session_id), effects);
                }
            }
            return;
        }
        if self.pending_joins.contains_key(&context.connection) {
            let pending = self.pending_joins.remove(&context.connection).unwrap();
            self.retire_pending(&pending);
            let code = if let RoomResult::Error { code } = reply.result {
                code
            } else {
                "room_storage_failed".into()
            };
            Self::error(context.connection, pending.request_id, &code, effects);
            effects.close.push(context.connection);
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
            RoomResult::Error { code } => completion = RoomResult::Error { code },
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
        for session in self.channel.identity.sessions.values().filter(|session| {
            Some(session.id) != except
                && session
                    .connection
                    .is_some_and(|connection| !self.pending_joins.contains_key(&connection))
        }) {
            self.deliver(
                session.id,
                Event::State {
                    state: self.channel.snapshot(session.id),
                },
                effects,
            );
        }
    }

    fn retire_pending(&mut self, pending: &PendingJoin) {
        if let Some(admitted) = &pending.admitted {
            self.channel.retire_session(admitted.session_id);
            if pending.created_user {
                self.channel.identity.users.remove(&admitted.user_id);
            }
            self.channel.reconcile();
        }
    }
}
