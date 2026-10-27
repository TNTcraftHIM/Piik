//! Temporary channel authority shared by App and Server entry points.
//!
//! The caller supplies connection identities and time, completes room-storage
//! effects, then delivers their events before admitting another command.
//! This core owns no sockets, queues, locks or timers.
//! Use a fresh connection UUID for each transport and Unix milliseconds for time.

mod access;
mod channel;
pub mod history;
mod identity;
mod room;
mod routes;
mod transport;
pub mod wire;

pub use access::RoomPermission;
pub use channel::DurableState;
pub use identity::User;
pub use wire::MAX_MESSAGE_ATTACHMENTS;

use channel::Channel;
use identity::Admission;
use serde_json::Value;
use uuid::Uuid;
use wire::{Command, Event, Request};

/// Events are addressed to physical connections, not reusable endpoint sessions.
/// Deliver events before closing the listed connections so leave can acknowledge.
#[derive(Default)]
pub struct Effects {
    pub events: Vec<(Uuid, Event)>,
    pub close: Vec<Uuid>,
    pub history: Option<history::HistoryEffect>,
}

#[derive(Clone)]
pub struct Authority {
    channel: Channel,
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
        })
    }

    /// Checkpoint identity and room policy. Room history has its own storage owner.
    pub fn export_state(&self) -> DurableState {
        self.channel.export_state()
    }
    /// Restore before admitting connections. Transport rollback should use a live clone.
    pub fn import_state(&mut self, state: DurableState) -> Result<(), &'static str> {
        self.channel.import_state(state)
    }
    pub fn authorize_user(
        &self,
        credential: &str,
        room: &str,
        permission: RoomPermission,
    ) -> Result<Uuid, &'static str> {
        let user = self
            .channel
            .identity
            .user_for_credential(credential)
            .ok_or("invalid_credential")?;
        self.channel.authorize(user, room, permission)?;
        Ok(user)
    }
    /// Apply a validated request only through its current connection binding.
    pub fn handle(&mut self, connection: Uuid, request: Request, now: u64) -> Effects {
        let mut effects = self.expire(now);
        let Some(session_id) = self.channel.identity.session_for_connection(connection) else {
            self.join(connection, request, now, &mut effects);
            return effects;
        };
        match self.channel.handle(session_id, request.command, now) {
            Ok(outcome) => {
                if let Some(history) = outcome.history {
                    let audience = self.channel.history_audience(history.room_id());
                    effects.history = Some(history::HistoryEffect {
                        request: history,
                        connection,
                        request_id: request.request_id.clone(),
                        audience,
                    });
                }
                for (recipient, mut event) in outcome.events {
                    match &mut event {
                        Event::RoomCreated { request_id, .. }
                        | Event::RoomInvite { request_id, .. } => {
                            *request_id = request.request_id.clone()
                        }
                        _ => {}
                    }
                    self.deliver(recipient, event, &mut effects);
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
                if let Some(request_id) = request.request_id.filter(|_| effects.history.is_none()) {
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
        let mut effects = Effects::default();
        if let Some(session_id) = self.channel.identity.session_for_connection(connection) {
            self.channel
                .identity
                .disconnect(session_id, connection, now);
            self.broadcast(None, &mut effects);
        }
        effects
    }

    /// Expire endpoint activities together, keeping unrelated publications alive.
    pub fn expire(&mut self, now: u64) -> Effects {
        let mut effects = Effects::default();
        if self.channel.expire_sessions(now) {
            self.broadcast(None, &mut effects);
        }
        effects
    }

    fn join(&mut self, connection: Uuid, request: Request, now: u64, effects: &mut Effects) {
        let Command::Join {
            name,
            credential,
            key,
            session_id,
            room_id,
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
        match self.channel.join_room(
            Admission {
                name: &name,
                credential: credential.as_deref(),
                key: key.as_deref(),
                resume: session_id.as_deref(),
            },
            connection,
            now,
            room_id.as_deref(),
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
                    },
                ));
                if let Some(request_id) = request.request_id {
                    effects.events.push((connection, Event::Ack { request_id }));
                }
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

    fn broadcast(&self, except: Option<Uuid>, effects: &mut Effects) {
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
