//! The same room command owner runs in the service or a Browser/App host.
//! Adapters serialize inputs, commit requested storage, then publish `finish`.
use crate::{
    history::{HistoryRequest, HistoryResult},
    identity::{Endpoint, Member},
    room::{RoomRuntime, RoomSnapshot},
    transport::{BaseLink, Flow},
    wire::{Command, FlowState, RoomAccess},
    RoomState,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSummary {
    pub id: String,
    pub name: String,
    pub icon: crate::wire::IdentityIcon,
    pub creator_id: Uuid,
    pub access: RoomAccess,
    pub hidden: bool,
    pub has_password: bool,
}

impl RoomSummary {
    pub fn from_policy(policy: &RoomState) -> Self {
        let view = policy.view(policy.creator_id, false).expect("room owner");
        Self {
            id: view.id,
            name: view.name,
            icon: view.icon,
            creator_id: view.creator_id,
            access: view.access,
            hidden: view.hidden,
            has_password: view.has_password,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    pub connection: Uuid,
    pub session_id: Uuid,
    pub request_id: Option<String>,
    pub now: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HostAction {
    Sync,
    RouteWake,
    Command {
        context: RequestContext,
        command: Command,
    },
    Revoke {
        context: RequestContext,
        target: Member,
    },
    FlowState {
        context: RequestContext,
        flow_id: Uuid,
        sender: Uuid,
        receiver: Uuid,
        state: FlowState,
    },
    BaseState {
        context: RequestContext,
        peer: Uuid,
        ready: bool,
    },
    PairFailed {
        first: Uuid,
        second: Uuid,
    },
    VerifyInvite {
        ticket: Uuid,
        key: String,
        member: Option<Member>,
    },
    GrantInvited {
        context: RequestContext,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub now: u64,
    pub binding_id: Uuid,
    pub host_session_id: Uuid,
    pub revision: u64,
    pub endpoints: BTreeMap<Uuid, Endpoint>,
    pub action: HostAction,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RoomResult {
    Done,
    Invite { key: String },
    Invited,
    Error { code: String },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomReply {
    pub context: RequestContext,
    pub result: RoomResult,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteVerification {
    pub ticket: Uuid,
    pub accepted: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomProjection {
    pub next_route_deadline: Option<u64>,
    pub summary: RoomSummary,
    pub views: BTreeMap<Uuid, RoomSnapshot>,
    pub flows: Vec<Flow>,
    pub base_links: Vec<BaseLink>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOutput {
    pub binding_id: Uuid,
    pub revision: u64,
    pub projection: RoomProjection,
    pub reply: Option<RoomReply>,
    pub invitation: Option<InviteVerification>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWork {
    pub policy: Option<RoomState>,
    pub history: Option<HistoryRequest>,
}

pub(crate) struct RoomOperation {
    pub result: RoomResult,
    pub history: Option<HistoryRequest>,
    pub policy_changed: bool,
}

impl RoomRuntime {
    /// Only domain-authenticated context reaches this shared room dispatch.
    pub(crate) fn command(
        &mut self,
        member: Member,
        session: Uuid,
        command: Command,
    ) -> Result<RoomOperation, &'static str> {
        let mut op = RoomOperation {
            result: RoomResult::Done,
            history: None,
            policy_changed: false,
        };
        match command {
            Command::Browse { active, .. } => self.browse(member, session, active)?,
            Command::FileOffer {
                message_seq,
                attachment_id,
                available,
                ..
            } => {
                op.history =
                    self.file_command(member, session, message_seq, attachment_id, true, available)?
            }
            Command::FileReceive {
                message_seq,
                attachment_id,
                enabled,
                ..
            } => {
                op.history =
                    self.file_command(member, session, message_seq, attachment_id, false, enabled)?
            }
            Command::UpdateRoom {
                name,
                icon,
                access,
                hidden,
                password,
                ..
            } => {
                self.update(member, name, icon, access, hidden, password)?;
                op.policy_changed = true;
            }
            Command::EnterRoom {
                password,
                invite_key,
                ..
            } => {
                self.enter(member, password.as_deref(), invite_key.as_deref())?;
                op.policy_changed = true;
            }
            Command::RoomInvite { .. } => {
                op.result = RoomResult::Invite {
                    key: self.invite(member)?,
                };
                op.policy_changed = true;
            }
            Command::Publish { publication } => self.publish(
                member,
                session,
                publication.id,
                publication.kind,
                publication.muted,
            )?,
            Command::Unpublish { publication_id } => {
                self.unpublish(session, publication_id)?;
            }
            Command::Subscribe {
                publication_id,
                enabled,
            } => {
                self.subscribe(member, session, publication_id, enabled)?;
            }
            Command::Voice {
                joined,
                muted,
                deafened,
                ..
            } => self.set_voice(member, session, joined, muted, deafened)?,
            _ => return Err("invalid_room_command"),
        }
        Ok(op)
    }
}

struct Pending {
    before: RoomRuntime,
    input: HostInput,
    reply: Option<RoomReply>,
    invitation: Option<InviteVerification>,
    history: bool,
}

struct RoomAuthority {
    binding_id: Uuid,
    host_session_id: Uuid,
    endpoints: BTreeMap<Uuid, Endpoint>,
}

pub struct RoomHost {
    authority: Option<RoomAuthority>,
    room: RoomRuntime,
    pending: Option<Pending>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Request;

    #[test]
    fn forwarding_a_room_update_preserves_omitted_password_and_explicit_removal() {
        let owner = Member {
            user_id: Uuid::new_v4(),
            participates: true,
            domain_owner: false,
        };
        let session = Uuid::new_v4();
        let mut host = RoomHost::new(
            RoomState::new(
                "private".into(),
                "Original".into(),
                Default::default(),
                owner.user_id,
                RoomAccess::Private,
                true,
                Some("secret".into()),
            )
            .unwrap(),
        );
        for (request, expected) in [
            (
                r#"{"type":"update_room","icon":"couch","roomId":"private","name":"Renamed","access":"private","hidden":true}"#,
                true,
            ),
            (
                r#"{"type":"update_room","icon":"couch","roomId":"private","name":"Renamed","access":"private","hidden":true,"password":null}"#,
                false,
            ),
        ] {
            let input = HostInput {
                now: 0,
                binding_id: Uuid::new_v4(),
                host_session_id: session,
                revision: 1,
                endpoints: BTreeMap::from([(
                    session,
                    Endpoint {
                        signing_key: [1; 32],
                        member: owner,
                        connected: true,
                    },
                )]),
                action: HostAction::Command {
                    context: RequestContext {
                        connection: Uuid::new_v4(),
                        session_id: session,
                        request_id: None,
                        now: 0,
                    },
                    command: Request::parse(request).ok().unwrap().command,
                },
            };
            // This is the actual domain -> WebSocket -> Browser Rust boundary.
            let input = serde_json::from_str(&serde_json::to_string(&input).unwrap()).unwrap();
            assert!(host.dispatch(input).unwrap().policy.is_some());
            let output = host.finish(None).unwrap();
            assert_eq!(output.projection.summary.has_password, expected);
        }
    }
}

impl RoomHost {
    pub fn new(policy: RoomState) -> Self {
        Self {
            authority: None,
            room: RoomRuntime::new(policy),
            pending: None,
        }
    }
    pub fn policy(&self) -> &RoomState {
        self.room.policy()
    }
    pub fn summary(&self) -> RoomSummary {
        RoomSummary::from_policy(self.policy())
    }

    /// Called inside the adapter's existing serialized room storage turn.
    /// Only the authenticated domain input can replace these authority facts.
    pub fn prepare_peer(
        &mut self,
        packet: &crate::conversation::SignedPacket,
        now: u64,
    ) -> Result<crate::conversation::PreparedConversation, &'static str> {
        use crate::conversation::{
            verify, ConversationCommand, ConversationRecord, ConversationRequest, ConversationWork,
            PreparedConversation, INTERACTION_REACTIONS,
        };
        if self.pending.is_some() {
            return Err("room_operation_pending");
        }
        let authority = self.authority.as_ref().ok_or("room_host_offline")?;
        let endpoint = authority
            .endpoints
            .get(&packet.sender)
            .ok_or("session_expired")?;
        let request: ConversationRequest = verify(packet, endpoint.signing_key)?;
        if request.address.sender != packet.sender
            || request.address.recipient != authority.host_session_id
            || request.address.binding_id != authority.binding_id
            || request.address.room_id != self.room.policy().id
            || !crate::wire::valid_id(&request.address.request_id)
        {
            return Err("invalid_conversation_scope");
        }
        let work = match request.command {
            ConversationCommand::InteractionReady => self
                .room
                .authorize(endpoint.member, crate::RoomPermission::Read)
                .map(|()| {
                    ConversationWork::Immediate(ConversationRecord::InteractionReady {
                        server_time: now,
                        reaction_ids: INTERACTION_REACTIONS
                            .iter()
                            .map(|id| (*id).into())
                            .collect(),
                    })
                }),
            ConversationCommand::Interaction {
                reaction,
                target_user_id,
            } => self
                .room
                .interaction(
                    endpoint.member,
                    packet.sender,
                    reaction,
                    target_user_id,
                    &authority.endpoints,
                    now,
                )
                .map(ConversationWork::Immediate),
            ConversationCommand::Chat {
                text,
                nonce,
                attachments,
            } => self
                .room
                .chat(endpoint.member, text, nonce, attachments, now)
                .map(ConversationWork::History),
            ConversationCommand::History { before } => self
                .room
                .history(endpoint.member, before)
                .map(ConversationWork::History),
        };
        Ok(PreparedConversation {
            address: request.address,
            work,
        })
    }

    pub fn current_readers(&self) -> Vec<Uuid> {
        self.authority
            .as_ref()
            .map(|authority| {
                authority
                    .endpoints
                    .iter()
                    .filter_map(|(session, endpoint)| {
                        (self.room.reading(*session)
                            && self
                                .room
                                .authorize(endpoint.member, crate::RoomPermission::Read)
                                .is_ok())
                        .then_some(*session)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn dispatch(&mut self, input: HostInput) -> Result<HostWork, &'static str> {
        if self.pending.is_some() {
            return Err("room_operation_pending");
        }
        self.authority = Some(RoomAuthority {
            binding_id: input.binding_id,
            host_session_id: input.host_session_id,
            endpoints: input.endpoints.clone(),
        });
        self.room.set_host_session(input.host_session_id);
        self.room.reconcile(&input.endpoints, input.now);
        let before = self.room.clone();
        let mut reply = None;
        let mut invitation = None;
        let mut work = HostWork {
            policy: None,
            history: None,
        };
        let context = match &input.action {
            HostAction::Command { context, .. }
            | HostAction::Revoke { context, .. }
            | HostAction::FlowState { context, .. }
            | HostAction::BaseState { context, .. }
            | HostAction::GrantInvited { context } => Some(context.clone()),
            _ => None,
        };
        let apply = (|| -> Result<RoomResult, &'static str> {
            let member = context
                .as_ref()
                .map(|c| {
                    input
                        .endpoints
                        .get(&c.session_id)
                        .map(|e| e.member)
                        .ok_or("session_expired")
                })
                .transpose()?;
            match &input.action {
                HostAction::Sync => {}
                HostAction::RouteWake => {
                    self.room.expire_media(input.now);
                }
                HostAction::BaseState {
                    context,
                    peer,
                    ready,
                } => {
                    self.room.base_state(context.session_id, *peer, *ready)?;
                }
                HostAction::PairFailed { first, second } => self.room.failed_pair(*first, *second),
                HostAction::VerifyInvite {
                    ticket,
                    key,
                    member,
                } => {
                    invitation = Some(InviteVerification {
                        ticket: *ticket,
                        accepted: member.is_some_and(|member| {
                            self.room
                                .authorize(member, crate::RoomPermission::Read)
                                .is_ok()
                        }) || self.room.accepts_invite(key),
                    })
                }
                HostAction::GrantInvited { .. } => {
                    self.room.grant_invited(member.unwrap().user_id);
                    work.policy = Some(self.policy().clone());
                    return Ok(RoomResult::Invited);
                }
                HostAction::Command { context, command } => {
                    let op =
                        self.room
                            .command(member.unwrap(), context.session_id, command.clone())?;
                    if op.policy_changed {
                        work.policy = Some(self.policy().clone());
                    }
                    work.history = op.history;
                    return Ok(op.result);
                }
                HostAction::Revoke { target, .. } => {
                    self.room.revoke(member.unwrap(), *target)?;
                    work.policy = Some(self.policy().clone());
                }
                HostAction::FlowState {
                    context,
                    flow_id,
                    sender,
                    receiver,
                    state,
                } => {
                    if context.session_id != *receiver
                        && (*state != FlowState::Failed || context.session_id != *sender)
                    {
                        return Err("unassigned_flow");
                    }
                    self.room
                        .flow_state(*flow_id, *receiver, *sender, *state, input.now)?;
                }
            }
            Ok(RoomResult::Done)
        })();
        let result = match apply {
            Ok(result) => result,
            Err(code) => {
                self.room = before.clone();
                work = HostWork {
                    policy: None,
                    history: None,
                };
                RoomResult::Error { code: code.into() }
            }
        };
        if let Some(context) = context {
            reply = Some(RoomReply { context, result });
        }
        self.room.reconcile(&input.endpoints, input.now);
        self.pending = Some(Pending {
            before,
            input,
            reply,
            invitation,
            history: work.history.is_some(),
        });
        Ok(work)
    }

    pub fn finish(&mut self, history: Option<HistoryResult>) -> Result<HostOutput, &'static str> {
        let pending = self.pending.as_ref().ok_or("no_room_operation")?;
        if pending.history != history.is_some() {
            return Err("history_result_required");
        }
        let mut pending = self.pending.take().unwrap();
        if let Some(result) = history {
            let HistoryResult::Attachment {
                message_seq,
                attachment,
            } = result
            else {
                return Err("invalid_file_operation");
            };
            let HostAction::Command { context, command } = &pending.input.action else {
                return Err("invalid_file_operation");
            };
            let offer = matches!(command, Command::FileOffer { .. });
            if let Err(code) =
                self.room
                    .finish_file(context.session_id, message_seq, attachment, offer)
            {
                pending.reply.as_mut().unwrap().result = RoomResult::Error { code: code.into() };
            }
            self.room
                .reconcile(&pending.input.endpoints, pending.input.now);
        }
        Ok(self.output(pending))
    }

    pub fn abort(&mut self, code: String) -> Result<HostOutput, &'static str> {
        let mut pending = self.pending.take().ok_or("no_room_operation")?;
        self.room = pending.before.clone();
        if let Some(reply) = &mut pending.reply {
            reply.result = RoomResult::Error { code };
        }
        Ok(self.output(pending))
    }

    fn output(&self, pending: Pending) -> HostOutput {
        let views = pending
            .input
            .endpoints
            .iter()
            .filter_map(|(session, endpoint)| {
                self.room
                    .snapshot(endpoint.member, *session)
                    .map(|snapshot| (*session, snapshot))
            })
            .collect();
        HostOutput {
            binding_id: pending.input.binding_id,
            revision: pending.input.revision,
            projection: RoomProjection {
                next_route_deadline: self.room.next_route_deadline(),
                summary: self.summary(),
                views,
                flows: self.room.flows().collect(),
                base_links: self.room.base_links().collect(),
            },
            reply: pending.reply,
            invitation: pending.invitation,
        }
    }
}
