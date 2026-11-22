//! The same room command owner runs in the service or a Browser/App host.
//! Adapters serialize inputs, commit requested storage, then publish `finish`.
use crate::{
    history::{HistoryRequest, HistoryResult},
    identity::{Endpoint, Member},
    room::{RoomRecipient, RoomRuntime, RoomSnapshot},
    transport::Flow,
    wire::{Command, FlowState, PublicationInfo, Room, RoomAccess, RoomCapabilities, VoiceInfo},
    RoomState,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSummary {
    pub id: String,
    pub name: String,
    pub icon: crate::wire::RoomIcon,
    pub creator_id: Uuid,
    pub access: RoomAccess,
    pub hidden: bool,
    pub has_password: bool,
    #[serde(default = "crate::access::default_voice_bitrate")]
    pub voice_bitrate: u32,
    #[serde(default = "crate::access::default_relay_capacity")]
    pub relay_capacity: u8,
}

impl RoomSummary {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if !crate::wire::valid_id(&self.id)
            || self.name.trim().is_empty()
            || self.name.encode_utf16().count() > 64
        {
            return Err("invalid_room_name");
        }
        if !crate::access::valid_audio_bitrate(self.voice_bitrate) {
            return Err("invalid_audio_bitrate");
        }
        if !(1..=crate::MAX_RELAY_CAPACITY).contains(&self.relay_capacity) {
            return Err("invalid_relay_capacity");
        }
        Ok(())
    }
    pub fn from_policy(policy: &RoomState) -> Self {
        let view = policy.view(policy.creator_id).expect("room owner");
        Self {
            id: view.id,
            name: view.name,
            icon: view.icon,
            creator_id: view.creator_id,
            access: view.access,
            hidden: view.hidden,
            has_password: view.has_password,
            voice_bitrate: view.voice_bitrate,
            relay_capacity: view.relay_capacity,
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
    RemoveHostedRoom {
        context: RequestContext,
    },
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
    RoomDataState {
        context: RequestContext,
        peer: Uuid,
        ready: bool,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairFailure {
    pub first: Uuid,
    pub second: Uuid,
    pub revision: u64,
}

/// The service's current authenticated socket, not a durable user capability.
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEndpoint {
    pub session_id: Uuid,
    pub connection_id: Uuid,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    #[serde(default)]
    pub hosting_mode: crate::wire::HostingMode,
    pub channel_owner_id: Uuid,
    pub now: u64,
    pub binding_id: Uuid,
    pub host_session_id: Uuid,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_pairs: Vec<PairFailure>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub confirmed_pairs: BTreeSet<(Uuid, Uuid)>,
    pub endpoints: BTreeMap<Uuid, Endpoint>,
    #[serde(default)]
    pub service_endpoint: Option<ServiceEndpoint>,
    pub action: HostAction,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RoomResult {
    WatchReady {
        server_time: u64,
    },
    Done,
    Deleted {
        data_removed: bool,
    },
    Topology {
        topology: crate::topology::RoomTopology,
    },
    Invite {
        key: String,
    },
    InviteState {
        invitation: crate::wire::RoomInvitation,
    },
    Error {
        code: String,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomReply {
    pub context: RequestContext,
    pub result: RoomResult,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomProjection {
    pub relay_session_ids: BTreeSet<Uuid>,
    pub allow_service_relay: bool,
    pub watch_activities: Vec<crate::wire::WatchActivity>,
    pub last_message_seq: u64,
    pub next_route_deadline: Option<u64>,
    pub summary: RoomSummary,
    #[serde(
        default,
        deserialize_with = "crate::wire::avatar",
        skip_serializing_if = "Option::is_none"
    )]
    pub picture: Option<String>,
    pub capabilities: RoomCapabilities,
    pub participant_session_ids: Vec<Uuid>,
    pub publications: Vec<PublicationInfo>,
    pub voice: Vec<VoiceInfo>,
    pub views: BTreeMap<Uuid, RoomRecipient>,
    pub flows: Vec<Flow>,
}

impl RoomProjection {
    /// Each physical pair has one demand entry. A waiting delivery can use a repair trial.
    pub(crate) fn requested_pairs(&self) -> BTreeMap<(Uuid, Uuid), bool> {
        let publishers: BTreeMap<_, _> = self
            .publications
            .iter()
            .filter(|publication| !publication.paused)
            .map(|publication| (publication.id, publication))
            .collect();
        let selected: BTreeSet<_> = self
            .flows
            .iter()
            .filter(|f| f.selected)
            .map(|f| (f.publication_id, f.receiver))
            .collect();
        let mut pairs = BTreeMap::new();
        let mut request = |source: Uuid, receiver: Uuid, waiting: bool| {
            if source != receiver {
                *pairs
                    .entry((source.min(receiver), source.max(receiver)))
                    .or_default() |= waiting;
            }
        };
        for (&receiver, view) in self.views.iter().filter(|(_, view)| view.authorized) {
            for id in &view.subscriptions {
                let Some(publication) = publishers.get(id) else {
                    continue;
                };
                let upstream_receiver = view.screen_helpers.get(id).copied().unwrap_or(receiver);
                request(
                    publication.session_id,
                    upstream_receiver,
                    !selected.contains(&(*id, upstream_receiver)),
                );
                // A paired display consumes its helper's local connection directly.
                request(upstream_receiver, receiver, false);
            }
            let files = view
                .files
                .iter()
                .filter(|plan| plan.receiving)
                .filter_map(|plan| Some((plan.source_id?, plan.upstream.is_none())));
            let watch_sources = view
                .watch_bytes
                .iter()
                .filter(|plan| plan.receiving)
                .map(|plan| (plan.source.session_id, plan.upstream.is_none()));
            for (source, waiting) in files.chain(watch_sources) {
                request(source, receiver, waiting);
            }
        }
        pairs
    }

    fn file_activity(&self) -> Vec<crate::wire::FileActivity> {
        self.views
            .iter()
            .filter(|(_, view)| view.authorized)
            .filter_map(|(session, view)| {
                let sending = view
                    .files
                    .iter()
                    .any(|file| file.source_id == Some(*session));
                let receiving = view.files.iter().any(|file| file.receiving);
                (sending || receiving).then_some(crate::wire::FileActivity {
                    session_id: *session,
                    sending,
                    receiving,
                })
            })
            .collect()
    }

    /// Assemble only the recipient's authorized view; the host owns these rights.
    pub fn snapshot(&self, session: Uuid, available: bool) -> Option<RoomSnapshot> {
        let view = self.views.get(&session)?;
        if !view.authorized && (view.transit_endpoint.is_some() || self.summary.hidden) {
            return None;
        }
        Some(RoomSnapshot {
            watch_activities: if view.authorized {
                self.watch_activities.clone()
            } else {
                vec![]
            },
            watch_subscriptions: view.watch_subscriptions.clone(),
            watch_bytes: view.watch_bytes.clone(),
            room: Room {
                last_message_seq: if view.authorized {
                    self.last_message_seq
                } else {
                    0
                },
                id: self.summary.id.clone(),
                name: self.summary.name.clone(),
                icon: self.summary.icon.clone(),
                picture: if available && view.authorized && view.reading {
                    self.picture.clone()
                } else {
                    None
                },
                creator_id: self.summary.creator_id,
                access: self.summary.access,
                hidden: self.summary.hidden,
                has_password: self.summary.has_password,
                voice_bitrate: self.summary.voice_bitrate,
                relay_capacity: self.summary.relay_capacity,
                relay_override: view.relay_override,
                service_relay: None,
                authorized: view.authorized,
                can_manage: view.can_manage,
                reading: view.reading,
                available,
                delivery: None,
                members: view.members.clone(),
                capabilities: RoomCapabilities {
                    history_seek: self.capabilities.history_seek && view.authorized && available,
                    file_availability_limit: self
                        .capabilities
                        .file_availability_limit
                        .filter(|_| view.authorized && available),
                    ..self.capabilities.clone()
                },
                file_availability: view
                    .file_availability
                    .clone()
                    .filter(|_| view.authorized && view.reading && available),
                participant_session_ids: if view.authorized && available {
                    self.participant_session_ids.clone()
                } else {
                    vec![]
                },
                file_activity: if view.authorized && available {
                    self.file_activity()
                } else {
                    vec![]
                },
            },
            publications: if view.authorized {
                self.publications.clone()
            } else {
                vec![]
            },
            voice: if view.authorized {
                self.voice.clone()
            } else {
                vec![]
            },
            files: view.files.clone(),
            subscriptions: view.subscriptions.clone(),
            failed_subscriptions: view.failed_subscriptions.clone(),
        })
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOutput {
    pub binding_id: Uuid,
    pub revision: u64,
    pub projection: RoomProjection,
    pub reply: Option<RoomReply>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWork {
    pub policy: Option<RoomState>,
    pub history: Option<HistoryRequest>,
    pub delete: bool,
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
        endpoints: &BTreeMap<Uuid, Endpoint>,
    ) -> Result<RoomOperation, &'static str> {
        let mut op = RoomOperation {
            result: RoomResult::Done,
            history: None,
            policy_changed: false,
        };
        match command {
            Command::Browse {
                active,
                relay_capacity,
                ..
            } => {
                if active {
                    if let Some(capacity) = relay_capacity {
                        self.set_relay_capacity(member, session, Some(capacity))?;
                    }
                }
                self.browse(member, session, active)?;
            }
            Command::ObserveFiles {
                observation_id,
                keys,
                ..
            } => self.observe_files(member, session, observation_id, keys)?,
            Command::FileOffer {
                message_seq,
                attachment_id,
                available,
                ..
            } => {
                op.history =
                    self.file_command(member, session, message_seq, attachment_id, true, available)?
            }
            Command::FileBranchRefused {
                message_seq,
                attachment_id,
                source_id,
                downstream_id,
                ..
            } => {
                self.refuse_file_branch(
                    session,
                    message_seq,
                    attachment_id,
                    source_id,
                    downstream_id,
                )?;
            }
            Command::ForwardingAvailable { kind, .. } => self.forwarding_available(session, kind),
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
                picture,
                access,
                hidden,
                password,
                voice_bitrate,
                relay_capacity,
                allow_service_relay,
                ..
            } => {
                if relay_capacity
                    .is_some_and(|capacity| !(1..=crate::MAX_RELAY_CAPACITY).contains(&capacity))
                {
                    return Err("invalid_relay_capacity");
                }
                let appearance = crate::RoomAppearance {
                    icon: icon.unwrap_or_else(|| self.policy().appearance.icon.clone()),
                    picture: picture.unwrap_or_else(|| self.policy().appearance.picture.clone()),
                };
                self.update(
                    member,
                    name.unwrap_or_else(|| self.policy().name.clone()),
                    appearance,
                    access.unwrap_or(self.policy().access),
                    hidden.unwrap_or(self.policy().hidden),
                    password,
                    voice_bitrate,
                )?;
                if let Some(capacity) = relay_capacity {
                    self.set_default_relay_capacity(capacity);
                }
                if let Some(allowed) = allow_service_relay {
                    self.set_service_relay_preference(allowed);
                }
                op.policy_changed = true;
            }
            Command::RelayCapacity { capacity, .. } => {
                self.set_relay_capacity(member, session, capacity)?
            }
            Command::EnterRoom {
                password,
                invite_key,
                ..
            } => {
                let authorized = self.policy().reads(member.user_id);
                self.enter(member, password.as_deref(), invite_key.as_deref())?;
                op.policy_changed = !authorized;
            }
            Command::RoomInvite { .. } => {
                op.result = RoomResult::Invite {
                    key: self.invite(member)?,
                };
                op.policy_changed = true;
            }
            Command::GetRoomInvite { .. } => {
                op.result = RoomResult::InviteState {
                    invitation: self.invitation(member)?,
                };
            }
            Command::StartWatch {
                id,
                source,
                playback,
                byte_source,
                ..
            } => self.start_watch(
                member,
                session,
                id,
                source,
                playback,
                byte_source,
                endpoints,
            )?,
            Command::UpdateWatch { id, playback, .. } => {
                self.update_watch(member, session, id, playback)?
            }
            Command::SetWatchByteSource {
                id, byte_source, ..
            } => self.set_watch_byte_source(member, session, id, byte_source, endpoints)?,
            Command::JoinWatch { id, mode, .. } => self.join_watch(member, session, id, mode)?,
            Command::StopWatch { id, .. } => self.stop_watch(member, session, id)?,
            Command::Publish { publication } => self.publish(
                member,
                session,
                publication.id,
                publication.kind,
                publication.video_settings,
                publication.source,
            )?,
            Command::Unpublish { publication_id } => {
                self.unpublish(session, publication_id)?;
            }
            Command::SetScreenDirectLimit {
                publication_id,
                limit,
            } => self.set_screen_direct_limit(session, publication_id, limit)?,
            Command::SetTitle {
                publication_id,
                title,
            } => self.set_title(session, publication_id, title)?,
            Command::SetPaused {
                publication_id,
                paused,
            } => {
                self.set_paused(session, publication_id, paused)?;
            }
            Command::TransferSource {
                publication_id,
                to_session_id,
            } => self.transfer_source(member, session, publication_id, to_session_id, endpoints)?,
            Command::Subscribe {
                publication_id,
                enabled,
                helper_session_id,
            } => {
                let helper = helper_session_id
                    .filter(|_| enabled)
                    .map(|id| {
                        endpoints
                            .get(&id)
                            .map(|endpoint| (id, endpoint))
                            .ok_or("helper_unavailable")
                    })
                    .transpose()?;
                self.subscribe(member, session, publication_id, enabled, helper)?;
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
    history: bool,
}

struct RoomAuthority {
    now: u64,
    confirmed_pairs: BTreeSet<(Uuid, Uuid)>,
    channel_owner_id: Uuid,
    binding_id: Uuid,
    host_session_id: Uuid,
    revision: u64,
    endpoints: BTreeMap<Uuid, Endpoint>,
    reaction_nonces: BTreeMap<Uuid, u64>,
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
    fn hosted_writer_sync_plans_cold_file_and_voice_between_participants() {
        let id = Uuid::from_u128;
        let (writer, source, receiver) = (id(1), id(2), id(3));
        let member = Member { user_id: source };
        let endpoints: BTreeMap<_, _> = [writer, source, receiver, id(6)]
            .into_iter()
            .map(|session| {
                (
                    session,
                    Endpoint {
                        member: Member { user_id: session },
                        signing_key: [0; 32],
                        connected: true,
                    },
                )
            })
            .collect();
        for voice in [false, true] {
            let mut host = RoomHost::new(
                RoomState::new(
                    "room".into(),
                    "Room".into(),
                    Default::default(),
                    source,
                    crate::wire::RoomAccess::Public,
                    false,
                    None,
                )
                .unwrap(),
            );
            let mut input = HostInput {
                hosting_mode: crate::wire::HostingMode::Hosted,
                channel_owner_id: writer,
                service_endpoint: None,
                now: 0,
                binding_id: id(4),
                host_session_id: writer,
                revision: 1,
                confirmed_pairs: Default::default(),
                failed_pairs: vec![],
                endpoints: endpoints.clone(),
                action: HostAction::Sync,
            };
            host.dispatch(input.clone()).unwrap();
            assert!(
                host.finish(None)
                    .unwrap()
                    .projection
                    .capabilities
                    .attachments
            );
            // A chat reader is available before either participant starts delivery.
            let reader = Member { user_id: id(6) };
            host.room.browse(reader, id(6), true).unwrap();
            if voice {
                host.room.set_relay_capacity(reader, id(6), Some(0)).unwrap();
            }
            host.room.reconcile(&endpoints, 0);
            assert!(host.room.flows().next().is_none());
            if voice {
                for session in [source, receiver] {
                    host.room
                        .set_voice(Member { user_id: session }, session, true, true, false)
                        .unwrap();
                }
                host.room
                    .publish(member, source, id(5), crate::wire::Kind::Voice, None, None)
                    .unwrap();
            } else {
                let attachment = crate::AttachmentDescriptor {
                    id: id(5),
                    name: "file".into(),
                    media_type: "application/octet-stream".into(),
                    size: 3,
                    sha256: crate::attachment::sha256_hex(b"abc"),
                };
                host.room
                    .finish_file(source, 1, source, attachment.clone(), true, true)
                    .unwrap();
                host.room
                    .finish_file(receiver, 1, source, attachment, false, true)
                    .unwrap();
            }
            input.revision += 1;
            host.dispatch(input.clone()).unwrap();
            let waiting = host.finish(None).unwrap().projection;
            assert_eq!(waiting.requested_pairs().get(&(source, receiver)), Some(&true));
            assert!(waiting.flows.is_empty());
            if !voice {
                assert_eq!(waiting.views[&receiver].files[0].upstream, None);
            }
            input.revision += 1;
            input.confirmed_pairs.insert((source, receiver));
            host.dispatch(input.clone()).unwrap();
            let projection = host.finish(None).unwrap().projection;
            if voice {
                assert!(projection
                    .flows
                    .iter()
                    .any(|flow| flow.sender == source && flow.receiver == receiver));
            } else {
                assert_eq!(projection.views[&receiver].files[0].upstream, Some(source));
                // When the direct pair fails, the available reader can carry the same request.
                input.revision += 1;
                input.failed_pairs.push(PairFailure {
                    first: source,
                    second: receiver,
                    revision: input.revision,
                });
                input.confirmed_pairs = [(source, id(6)), (receiver, id(6))].into();
                host.dispatch(input).unwrap();
                let projection = host.finish(None).unwrap().projection;
                assert_eq!(projection.views[&receiver].files[0].upstream, Some(id(6)));
                assert_eq!(projection.views[&id(6)].files[0].upstream, Some(source));
            }
        }
    }

    #[test]
    fn counted_reactions_commit_after_storage_and_follow_each_publication_lifetime() {
        use crate::conversation::{
            ConversationAddress, ConversationCommand, ConversationRecord, ConversationRequest,
            ConversationResult, ConversationWork, ReactionSnapshot, ReactionTarget, SessionSigner,
            INTERACTION_REACTIONS,
        };
        let owner = Member {
            user_id: Uuid::new_v4(),
        };
        let sharer = Member {
            user_id: Uuid::new_v4(),
        };
        let (local, first, second, binding) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let key = SessionSigner::from_seed([5; 32]);
        let endpoints = [(local, owner), (first, sharer), (second, sharer)]
            .into_iter()
            .map(|(session, member)| {
                (
                    session,
                    Endpoint {
                        member,
                        connected: true,
                        signing_key: key.signing_key(),
                    },
                )
            })
            .collect();
        let mut host = RoomHost::new(
            RoomState::new(
                "room".into(),
                "Room".into(),
                Default::default(),
                owner.user_id,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        host.dispatch(HostInput {
            hosting_mode: Default::default(),
            channel_owner_id: Uuid::nil(),
            service_endpoint: None,
            now: 0,
            binding_id: binding,
            host_session_id: local,
            revision: 1,
            endpoints,
            confirmed_pairs: Default::default(),
            failed_pairs: vec![],
            action: HostAction::Sync,
        })
        .unwrap();
        host.finish(None).unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let settings = serde_json::from_value(serde_json::json!({"ceiling":{"resolution":{"width":640,"height":360},"maxFramerate":30,"maxBitrate":1000000},"degradationPreference":"balanced"})).unwrap();
        host.room
            .publish(
                sharer,
                first,
                a,
                crate::wire::Kind::Screen,
                Some(settings),
                Some(crate::wire::ScreenSource::default()),
            )
            .unwrap();
        host.room
            .publish(
                sharer,
                second,
                b,
                crate::wire::Kind::Screen,
                Some(settings),
                Some(crate::wire::ScreenSource::default()),
            )
            .unwrap();
        let send = |host: &mut RoomHost, nonce, target, reaction: &str, now, fail| {
            let request = ConversationRequest {
                address: ConversationAddress {
                    room_id: "room".into(),
                    binding_id: binding,
                    sender: local,
                    recipient: local,
                    request_id: format!("action-{nonce}"),
                },
                command: ConversationCommand::React {
                    nonce,
                    target,
                    reaction: reaction.into(),
                },
            };
            let prepared = host
                .prepare_peer(&key.sign(local, &request).unwrap(), now)
                .unwrap();
            let result = if fail {
                Err("storage_failed")
            } else {
                prepared.work.map(|work| match work {
                    ConversationWork::Immediate(record) => ConversationResult::Immediate(record),
                    _ => panic!("live reaction needs no history write"),
                })
            };
            host.finish_peer(prepared.address, result)
                .unwrap()
                .replies()
                .unwrap()
                .remove(0)
                .record
        };
        let target = ReactionTarget::Publication { publication_id: a };
        assert!(matches!(
            send(&mut host, 1, target.clone(), "poop", 1000, true),
            ConversationRecord::Error { .. }
        ));
        assert!(host
            .room
            .publication_reaction(a)
            .unwrap()
            .reactions
            .counts
            .is_empty());
        let first_event = send(&mut host, 1, target.clone(), "poop", 1000, false);
        assert!(first_event.broadcast().is_some());
        assert!(send(&mut host, 1, target.clone(), "poop", 1001, false)
            .broadcast()
            .is_none());
        assert!(
            matches!(send(&mut host, 2, target.clone(), "poop", 1001, false), ConversationRecord::Error { ref code } if code=="rate_limited")
        );
        let other = send(
            &mut host,
            2,
            ReactionTarget::Publication { publication_id: b },
            "poop",
            1800,
            false,
        );
        assert!(
            matches!(other, ConversationRecord::Reaction { snapshot: Some(ReactionSnapshot::Publication(ref value)), .. } if value.publication_id==b&&value.reactions.counts["poop"]==1)
        );
        for (index, reaction) in INTERACTION_REACTIONS.iter().enumerate() {
            let nonce = index as u64 + 3;
            assert!(send(
                &mut host,
                nonce,
                target.clone(),
                reaction,
                nonce * 800 + 200,
                false
            )
            .broadcast()
            .is_some());
        }
        assert_eq!(
            host.room
                .publication_reaction(a)
                .unwrap()
                .reactions
                .counts
                .len(),
            16
        );
        assert_eq!(
            host.room.publication_reaction(a).unwrap().reactions.counts["poop"],
            2
        );
        host.room.set_paused(first, a, true).unwrap();
        host.room
            .publish(
                sharer,
                first,
                a,
                crate::wire::Kind::Screen,
                Some(settings),
                Some(crate::wire::ScreenSource::default()),
            )
            .unwrap();
        assert_eq!(
            host.room
                .publication_reaction(a)
                .unwrap()
                .reactions
                .revision,
            17
        );
        let person = send(
            &mut host,
            19,
            ReactionTarget::Person {
                user_id: sharer.user_id,
            },
            "poop",
            16000,
            false,
        );
        assert!(matches!(
            person,
            ConversationRecord::Reaction {
                event: Some(_),
                snapshot: None,
                ..
            }
        ));
        assert_eq!(
            host.room
                .publication_reaction(b)
                .unwrap()
                .reactions
                .revision,
            1
        );
        host.room.unpublish(first, a).unwrap();
        assert!(
            matches!(send(&mut host, 20, target, "poop", 16800, false), ConversationRecord::Error { ref code } if code=="publication_unavailable")
        );
        assert_eq!(host.room.publication_reactions().len(), 1);
        let fresh = Uuid::new_v4();
        host.room
            .publish(
                sharer,
                first,
                fresh,
                crate::wire::Kind::Screen,
                Some(settings),
                Some(crate::wire::ScreenSource::default()),
            )
            .unwrap();
        assert!(host
            .room
            .publication_reaction(fresh)
            .unwrap()
            .reactions
            .counts
            .is_empty());
    }

    #[test]
    fn authorized_entry_projects_a_new_endpoint_without_a_policy_write() {
        let owner = Member {
            user_id: Uuid::new_v4(),
        };
        let friend = Member {
            user_id: Uuid::new_v4(),
            ..owner
        };
        let host_session = Uuid::new_v4();
        let browser = Uuid::new_v4();
        let native = Uuid::new_v4();
        let binding = Uuid::new_v4();
        let mut host = RoomHost::new(
            RoomState::new(
                "room".into(),
                "Private room".into(),
                Default::default(),
                owner.user_id,
                RoomAccess::Private,
                true,
                Some("secret".into()),
            )
            .unwrap(),
        );
        let endpoint = |member| Endpoint {
            signing_key: [1; 32],
            member,
            connected: true,
        };
        for (revision, session, password) in [(1, browser, Some("secret")), (2, native, None)] {
            let before = serde_json::to_value(host.policy()).unwrap();
            let mut endpoints =
                BTreeMap::from([(host_session, endpoint(owner)), (browser, endpoint(friend))]);
            if session == native {
                endpoints.insert(native, endpoint(friend));
            }
            let input = HostInput {
                hosting_mode: Default::default(),
                channel_owner_id: Uuid::nil(),
                service_endpoint: None,
                now: 0,
                binding_id: binding,
                host_session_id: host_session,
                revision,
                confirmed_pairs: Default::default(),
                failed_pairs: Vec::new(),
                endpoints,
                action: HostAction::Command {
                    context: RequestContext {
                        connection: Uuid::new_v4(),
                        session_id: session,
                        request_id: Some(Uuid::new_v4().to_string()),
                        now: 0,
                    },
                    command: Command::EnterRoom {
                        room_id: "room".into(),
                        password: password.map(str::to_owned),
                        invite_key: None,
                    },
                },
            };
            assert_eq!(
                host.dispatch(input).unwrap().policy.is_some(),
                session == browser
            );
            let output = host.finish(None).unwrap();
            let room = output.projection.snapshot(session, true).unwrap().room;
            assert!(room.authorized && room.hidden);
            assert!(!room.reading);
            if session == native {
                assert_eq!(serde_json::to_value(host.policy()).unwrap(), before);
            }
        }
    }

    #[test]
    fn forwarded_room_updates_preserve_or_clear_the_password_and_picture() {
        let owner = Member {
            user_id: Uuid::new_v4(),
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
        let image = "data:image/png;base64,iVBORw0KGgo=";
        for (request, has_password, picture) in [
            (
                r#"{"type":"update_room","icon":"star","picture":"data:image/png;base64,iVBORw0KGgo=","roomId":"private","name":"Original","access":"private","hidden":true,"voiceBitrate":96000}"#,
                true,
                Some(image),
            ),
            (
                r#"{"type":"update_room","icon":"couch","roomId":"private","name":"Renamed","access":"private","hidden":true,"voiceBitrate":96000}"#,
                true,
                Some(image),
            ),
            (
                r#"{"type":"update_room","icon":"couch","roomId":"private","name":"Renamed","access":"private","hidden":true,"password":null,"picture":null}"#,
                false,
                None,
            ),
        ] {
            let input = HostInput {
                hosting_mode: Default::default(),
                channel_owner_id: Uuid::nil(),
                service_endpoint: None,
                now: 0,
                binding_id: Uuid::new_v4(),
                host_session_id: session,
                revision: 1,
                confirmed_pairs: Default::default(),
                failed_pairs: Vec::new(),
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
            assert_eq!(output.projection.summary.has_password, has_password);
            assert_eq!(output.projection.summary.voice_bitrate, 96_000);
            let restored: RoomState =
                serde_json::from_str(&serde_json::to_string(host.policy()).unwrap()).unwrap();
            assert_eq!(restored.voice_bitrate, 96_000);
            assert_eq!(restored.appearance.picture.as_deref(), picture);
        }
    }

    #[test]
    fn room_voice_bitrate_requires_manage_and_rejects_invalid_without_policy_changes() {
        let owner = Member {
            user_id: Uuid::new_v4(),
        };
        let other = Member {
            user_id: Uuid::new_v4(),
            ..owner
        };
        let mut room = RoomRuntime::new(
            RoomState::new(
                "voice".into(),
                "Voice".into(),
                Default::default(),
                owner.user_id,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        assert_eq!(room.policy().voice_bitrate, 64_000);
        for (member, bitrate, expected) in [
            (other, 96_000, "forbidden"),
            (owner, 5_999, "invalid_audio_bitrate"),
            (owner, 320_001, "invalid_audio_bitrate"),
        ] {
            assert_eq!(
                room.update(
                    member,
                    "Changed".into(),
                    Default::default(),
                    RoomAccess::Public,
                    false,
                    None,
                    Some(bitrate)
                ),
                Err(expected)
            );
            assert_eq!(room.policy().name, "Voice");
            assert_eq!(room.policy().voice_bitrate, 64_000);
        }
        for bitrate in [6_000, 320_000] {
            room.update(
                owner,
                "Voice".into(),
                Default::default(),
                RoomAccess::Public,
                false,
                None,
                Some(bitrate),
            )
            .unwrap();
            assert_eq!(room.policy().voice_bitrate, bitrate);
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
    pub fn seed_history(&mut self, last_seq: u64) -> Result<(), &'static str> {
        if self.authority.is_some() || last_seq > i64::MAX as u64 {
            return Err("invalid_history_seed");
        }
        self.room.last_message_seq = last_seq;
        Ok(())
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
            PreparedConversation, ReactionSnapshot, ReactionTarget, INTERACTION_REACTIONS,
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
        let actor = endpoint.member.user_id;
        let moderator = self.room.policy().manages(actor) || actor == authority.channel_owner_id;
        let work = match request.command {
            ConversationCommand::DeleteMessage {
                message_seq,
                message_id,
            } => self
                .room
                .authorize(endpoint.member, crate::RoomPermission::Read)
                .and_then(|()| {
                    if message_seq == 0 || message_seq > self.room.last_message_seq {
                        return Err("message_unavailable");
                    }
                    Ok(ConversationWork::History(HistoryRequest::DeleteMessage {
                        room_id: self.room.policy().id.clone(),
                        message_seq,
                        message_id,
                        author_id: (!moderator).then_some(actor),
                    }))
                }),
            ConversationCommand::ClearHistory { through_seq } => self
                .room
                .authorize(endpoint.member, crate::RoomPermission::Read)
                .and_then(|()| {
                    if !moderator {
                        return Err("forbidden");
                    }
                    if through_seq > self.room.last_message_seq {
                        return Err("message_unavailable");
                    }
                    Ok(ConversationWork::History(HistoryRequest::ClearHistory {
                        room_id: self.room.policy().id.clone(),
                        through_seq,
                    }))
                }),
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
                        publication_reactions: self.room.publication_reactions(),
                    })
                }),
            ConversationCommand::React {
                nonce,
                target,
                reaction,
            } => (|| {
                self.room
                    .authorize(endpoint.member, crate::RoomPermission::Read)?;
                if nonce == 0 {
                    return Err("invalid_reaction_nonce");
                }
                let repeated = nonce
                    <= authority
                        .reaction_nonces
                        .get(&packet.sender)
                        .copied()
                        .unwrap_or(0);
                let event = if repeated {
                    None
                } else {
                    Some(self.room.reaction(
                        endpoint.member,
                        packet.sender,
                        reaction,
                        target.clone(),
                        &authority.endpoints,
                        now,
                    )?)
                };
                if let ReactionTarget::Message {
                    message_seq,
                    message_id,
                } = target
                {
                    return Ok(ConversationWork::History(HistoryRequest::React {
                        room_id: self.room.policy().id.clone(),
                        message_seq,
                        message_id,
                        nonce,
                        event,
                    }));
                }
                let snapshot = if let ReactionTarget::Publication { publication_id } = target {
                    Some(ReactionSnapshot::Publication(
                        self.room.publication_reaction(publication_id)?,
                    ))
                } else {
                    None
                };
                Ok(ConversationWork::Immediate(ConversationRecord::Reaction {
                    nonce,
                    event,
                    snapshot,
                }))
            })(),
            ConversationCommand::Chat {
                mentions,
                reply,
                inline_images,
                text,
                nonce,
                attachments,
            } => self
                .room
                .chat(
                    endpoint.member,
                    text,
                    nonce,
                    attachments,
                    inline_images,
                    mentions,
                    reply,
                    now,
                )
                .map(ConversationWork::History),
            ConversationCommand::History { before } => self
                .room
                .history(endpoint.member, before)
                .map(ConversationWork::History),
            ConversationCommand::HistorySeek { after } => self
                .room
                .seek_history(endpoint.member, after)
                .map(ConversationWork::History),
        };
        Ok(PreparedConversation {
            address: request.address,
            work,
        })
    }

    /// The adapter's serialized room turn calls this only after its storage
    /// transaction completes. Failed work consumes neither a nonce nor a live effect.
    pub fn finish_peer(
        &mut self,
        address: crate::conversation::ConversationAddress,
        mut result: Result<crate::conversation::ConversationResult, &'static str>,
    ) -> Result<crate::conversation::ConversationOutcome, &'static str> {
        use crate::conversation::{ConversationRecord, ConversationResult};
        let authority = self.authority.as_mut().ok_or("room_host_offline")?;
        if address.binding_id != authority.binding_id
            || address.recipient != authority.host_session_id
        {
            return Err("invalid_conversation_scope");
        }
        if let Ok(ConversationResult::History(HistoryResult::Sent(confirmation))) = &result {
            self.room.last_message_seq = self
                .room
                .last_message_seq
                .max(confirmation.message.message.seq);
        }
        let removed_files = match &result {
            Ok(ConversationResult::History(HistoryResult::MessageDeleted { message_seq })) => {
                Some(self.room.remove_message_files(*message_seq, *message_seq))
            }
            Ok(ConversationResult::History(HistoryResult::HistoryCleared { through_seq })) => {
                Some(self.room.remove_message_files(0, *through_seq))
            }
            _ => None,
        };
        let projection_update = removed_files
            .as_ref()
            .is_some_and(|participants| !participants.is_empty())
            .then(|| {
                self.room.reconcile_with_pairs(
                    &authority.endpoints,
                    authority.now,
                    &authority.confirmed_pairs,
                );
                HostOutput {
                    binding_id: authority.binding_id,
                    revision: authority.revision,
                    projection: self.room.projection(&authority.endpoints),
                    reply: None,
                }
            });
        let committed = match &mut result {
            Ok(ConversationResult::History(HistoryResult::Reacted(confirmation))) => confirmation
                .event
                .as_ref()
                .map(|event| (confirmation.nonce, event, None)),
            Ok(ConversationResult::Immediate(ConversationRecord::Reaction {
                nonce,
                event,
                snapshot,
            })) => event.as_ref().map(|event| (*nonce, event, Some(snapshot))),
            _ => None,
        };
        if let Some((nonce, event, snapshot)) = committed {
            match self.room.commit_reaction(address.sender, event) {
                Ok(current) => {
                    if let Some(snapshot) = snapshot {
                        *snapshot = current;
                    }
                    authority.reaction_nonces.insert(address.sender, nonce);
                }
                Err(code) => result = Err(code),
            }
        }
        Ok(crate::conversation::ConversationOutcome {
            address,
            result,
            projection_update,
            removal_recipients: removed_files.map_or_else(Vec::new, |participants| {
                self.readers_and_file_participants(&participants)
            }),
        })
    }

    pub fn current_readers(&self) -> Vec<Uuid> {
        self.readers_and_file_participants(&BTreeSet::new())
    }

    fn readers_and_file_participants(&self, participants: &BTreeSet<Uuid>) -> Vec<Uuid> {
        self.authority
            .as_ref()
            .map(|authority| {
                authority
                    .endpoints
                    .iter()
                    .filter_map(|(session, endpoint)| {
                        (endpoint.connected
                            && (self.room.reading(*session) || participants.contains(session))
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
        if self
            .authority
            .as_ref()
            .is_some_and(|authority| authority.binding_id != input.binding_id)
        {
            self.room.reset_routes();
        }
        self.room.service_endpoint(
            input.service_endpoint,
            &input.endpoints,
            input.now,
            &input.confirmed_pairs,
        );
        let applied = self
            .authority
            .as_ref()
            .filter(|authority| authority.binding_id == input.binding_id)
            .map_or(0, |authority| authority.revision);
        for pair in input
            .failed_pairs
            .iter()
            .filter(|pair| pair.revision > applied)
        {
            self.room.failed_pair(pair.first, pair.second);
        }
        let mut reaction_nonces = self
            .authority
            .as_mut()
            .filter(|authority| authority.binding_id == input.binding_id)
            .map(|authority| std::mem::take(&mut authority.reaction_nonces))
            .unwrap_or_default();
        reaction_nonces.retain(|session, _| input.endpoints.contains_key(session));
        self.authority = Some(RoomAuthority {
            now: input.now,
            confirmed_pairs: input.confirmed_pairs.clone(),
            channel_owner_id: input.channel_owner_id,
            binding_id: input.binding_id,
            host_session_id: input.host_session_id,
            revision: input.revision,
            endpoints: input.endpoints.clone(),
            reaction_nonces,
        });
        self.room
            .set_writer(input.host_session_id, input.hosting_mode);
        self.room
            .reconcile_with_pairs(&input.endpoints, input.now, &input.confirmed_pairs);
        let before = self.room.clone();
        let mut reply = None;
        let mut work = HostWork {
            policy: None,
            history: None,
            delete: false,
        };
        let context = match &input.action {
            HostAction::Command { context, .. }
            | HostAction::RemoveHostedRoom { context }
            | HostAction::Revoke { context, .. }
            | HostAction::FlowState { context, .. }
            | HostAction::RoomDataState { context, .. } => Some(context.clone()),
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
                HostAction::RemoveHostedRoom { .. } => {
                    work.delete = true;
                    return Ok(RoomResult::Deleted { data_removed: true });
                }
                HostAction::RouteWake => {
                    self.room.expire_media(input.now);
                }
                HostAction::RoomDataState {
                    context,
                    peer,
                    ready,
                } => {
                    self.room.room_data_state(context.session_id, *peer, *ready)?;
                }
                HostAction::Command { context, command } => {
                    if matches!(
                        command,
                        Command::DeleteRoom {
                            delete_data: true,
                            ..
                        }
                    ) {
                        self.room
                            .authorize(member.unwrap(), crate::RoomPermission::Manage)?;
                        work.delete = true;
                        return Ok(RoomResult::Deleted { data_removed: true });
                    }
                    let op = self.room.command(
                        member.unwrap(),
                        context.session_id,
                        command.clone(),
                        &input.endpoints,
                    )?;
                    if op.policy_changed {
                        work.policy = Some(self.policy().clone());
                    }
                    work.history = op.history;
                    return Ok(
                        if matches!(
                            command,
                            Command::StartWatch { .. } | Command::JoinWatch { mode: Some(_), .. }
                        ) {
                            RoomResult::WatchReady {
                                server_time: context.now,
                            }
                        } else {
                            op.result
                        },
                    );
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
                    delete: false,
                };
                RoomResult::Error { code: code.into() }
            }
        };
        if let Some(context) = context {
            reply = Some(RoomReply { context, result });
        }
        self.room
            .reconcile_with_pairs(&input.endpoints, input.now, &input.confirmed_pairs);
        self.pending = Some(Pending {
            before,
            input,
            reply,
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
                author_id,
                message_seq,
                attachment,
            } = result
            else {
                return Err("invalid_file_operation");
            };
            let HostAction::Command { context, command } = &pending.input.action else {
                return Err("invalid_file_operation");
            };
            let result = match command {
                Command::FileOffer { sha256, .. }
                    if !attachment.sha256.eq_ignore_ascii_case(sha256) =>
                {
                    Err("attachment_content_mismatch")
                }
                Command::FileOffer { available, .. } => self.room.finish_file(
                    context.session_id,
                    message_seq,
                    author_id,
                    attachment,
                    true,
                    *available,
                ),
                Command::FileReceive { enabled, .. } => self.room.finish_file(
                    context.session_id,
                    message_seq,
                    author_id,
                    attachment,
                    false,
                    *enabled,
                ),
                _ => Err("invalid_file_operation"),
            };
            if let Err(code) = result {
                pending.reply.as_mut().unwrap().result = RoomResult::Error { code: code.into() };
            }
            self.room.reconcile_with_pairs(
                &pending.input.endpoints,
                pending.input.now,
                &pending.input.confirmed_pairs,
            );
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
        HostOutput {
            binding_id: pending.input.binding_id,
            revision: pending.input.revision,
            projection: self.room.projection(&pending.input.endpoints),
            reply: pending.reply,
        }
    }
}
