use crate::{
    access::{RoomPermission, RoomState},
    history::{HistoryRequest, MessageDraft},
    identity::{Endpoint, Member},
    publication::Publication,
    routes::{ByteTree, RelayLimits},
    transport::Flow,
    wire::{
        ViewSource, validate_video_settings, AudienceState, FlowState, Kind, PublicationAudience,
        PublicationInfo, Room, RoomAccess, VideoSettings, VoiceInfo,
    },
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[cfg(test)]
use crate::publication::SCREEN_PREPARE_MS;

const REQUIRED_REPAIR_MS: u64 = 5_000;

#[derive(Clone, Default)]
struct Activity {
    handoffs: Vec<SourceHandoff>,
    reading: bool,
    file_observation: Option<FileObservation>,
    watch_subscriptions: BTreeMap<Uuid, crate::wire::WatchMode>,
    watching: BTreeMap<Uuid, Option<Uuid>>,
    voice: Option<VoiceInfo>,
    relay_capacity: Option<u8>,
    next_interaction_at: u64,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct SourceHandoff {
    pub predecessor: ViewSource,
    pub target: ViewSource,
}

#[derive(Clone)]
struct FileObservation {
    id: Uuid,
    keys: Vec<(u64, Uuid)>,
}

#[derive(Clone)]
struct Watch {
    replace_id: Option<Uuid>,
    bytes: ByteTree,
    user_id: Uuid,
    session_id: Uuid,
    source: crate::wire::WatchSource,
    playback: crate::wire::WatchPlayback,
    // The requested provider; `bytes` holds the root its branches grew from.
    // Changing this clears those branches or routes again in the same reconcile.
    byte_source: Option<crate::wire::WatchByteSource>,
}

/// One room owns its policy, activities and logical flows. It neither owns
/// domain identities nor creates physical peer connections.
#[derive(Clone)]
pub struct RoomRuntime {
    pub(crate) last_message_seq: u64,
    policy: RoomState,
    activity: BTreeMap<Uuid, Activity>,
    publications: BTreeMap<Uuid, Publication>,
    watch_activities: BTreeMap<Uuid, Watch>,
    writer: Option<(Uuid, crate::wire::HostingMode)>,
    transit_endpoint: Option<crate::host::ServiceEndpoint>,
    delivery_frontiers: Vec<crate::host::DeliveryFrontier>,
    repair_at: Option<u64>,
    failed_data_pairs: BTreeSet<(Uuid, Uuid)>,
    files: crate::file_room::FileRoom,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub watch_activities: Vec<crate::wire::WatchActivity>,
    pub watch_subscriptions: Vec<crate::wire::WatchSubscription>,
    pub watch_bytes: Vec<crate::watch_delivery::WatchBytePlan>,
    pub files: Vec<crate::file_room::FilePlan>,
    pub room: Room,
    pub publications: Vec<PublicationInfo>,
    pub voice: Vec<VoiceInfo>,
    pub subscriptions: Vec<Uuid>,
    pub failed_subscriptions: Vec<Uuid>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomRecipient {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub handoffs: Vec<SourceHandoff>,
    pub screen_helpers: BTreeMap<Uuid, Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transit_endpoint: Option<crate::host::ServiceEndpoint>,
    pub watch_subscriptions: Vec<crate::wire::WatchSubscription>,
    pub watch_bytes: Vec<crate::watch_delivery::WatchBytePlan>,
    pub authorized: bool,
    pub can_manage: bool,
    pub reading: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_availability: Option<crate::wire::FileAvailability>,
    pub relay_override: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<Uuid>>,
    pub files: Vec<crate::file_room::FilePlan>,
    pub subscriptions: Vec<Uuid>,
    pub failed_subscriptions: Vec<Uuid>,
}

impl RoomRuntime {
    pub fn new(policy: RoomState) -> Self {
        Self {
            last_message_seq: 0,
            policy,
            activity: BTreeMap::new(),
            publications: BTreeMap::new(),
            watch_activities: BTreeMap::new(),
            writer: None,
            transit_endpoint: None,
            delivery_frontiers: Vec::new(),
            repair_at: None,
            failed_data_pairs: BTreeSet::new(),
            files: Default::default(),
        }
    }

    pub fn policy(&self) -> &RoomState {
        &self.policy
    }

    pub(crate) fn set_service_relay_preference(&mut self, allowed: bool) {
        self.policy.allow_service_relay = allowed;
    }

    pub(crate) fn reset_routes(&mut self) {
        self.delivery_frontiers.clear();
        self.transit_endpoint = None;
        self.repair_at = None;
        self.failed_data_pairs.clear();
        self.files.reset_routes();
        for watch in self.watch_activities.values_mut() {
            watch.bytes.clear_branches();
        }
        for publication in self.publications.values_mut() {
            publication.reset_routes();
        }
    }

    pub(crate) fn service_endpoint(
        &mut self,
        service: Option<crate::host::ServiceEndpoint>,
        endpoints: &BTreeMap<Uuid, Endpoint>,
        now: u64,
        confirmed_pairs: &BTreeSet<(Uuid, Uuid)>,
    ) {
        if self.transit_endpoint != service {
            if let Some(previous) = self.selected_service() {
                // Withdraw proof from the old service socket before deriving new work.
                let session = previous.session_id;
                let files = self
                    .files
                    .plans(&self.policy.id, session)
                    .into_iter()
                    .flat_map(|plan| plan.upstream.into_iter().chain(plan.downstream));
                let watches = self
                    .watch_byte_plans(session)
                    .into_iter()
                    .flat_map(|plan| plan.upstream.into_iter().chain(plan.downstream));
                let peers: BTreeSet<_> = files.chain(watches).collect();
                for peer in peers {
                    self.retire_byte_pair(session, peer);
                }
                for publication in self.publications.values_mut() {
                    publication.retire_transport(session);
                }
                let mut retired = endpoints.clone();
                if let Some(endpoint) = retired.get_mut(&previous.session_id) {
                    endpoint.connected = false;
                }
                self.reconcile_with_pairs(&retired, now, confirmed_pairs);
            }
            self.transit_endpoint = service;
        }
    }

    fn selected_service(&self) -> Option<crate::host::ServiceEndpoint> {
        self.transit_endpoint
            .filter(|_| self.policy.allow_service_relay)
    }

    pub fn authorize(
        &self,
        member: Member,
        permission: RoomPermission,
    ) -> Result<(), &'static str> {
        if !self.policy.reads(member.user_id) {
            return Err(if self.policy.hidden {
                "room_unavailable"
            } else {
                "room_access_required"
            });
        }
        match permission {
            RoomPermission::Read => Ok(()),
            RoomPermission::Manage if self.policy.manages(member.user_id) => Ok(()),
            _ => Err("forbidden"),
        }
    }

    #[cfg(test)]
    pub(crate) fn snapshot(&self, member: Member, session: Uuid) -> Option<RoomSnapshot> {
        let view = self.recipient(member, session, true, |_| false)?;
        self.project(BTreeMap::from([(session, view)]))
            .snapshot(session, true)
    }

    pub(crate) fn projection(
        &self,
        endpoints: &BTreeMap<Uuid, Endpoint>,
    ) -> crate::host::RoomProjection {
        let limits = self.relay_limits();
        let mut projection = self.project(
            endpoints
                .iter()
                .filter_map(|(session, endpoint)| {
                    self.recipient(endpoint.member, *session, endpoint.connected, |key| {
                        self.files.available(key, endpoints, &limits)
                    })
                    .map(|view| (*session, view))
                })
                .collect(),
        );
        projection.relay_session_ids.retain(|id| endpoints.get(id).is_some_and(|e| e.can_use_peer_transport));
        projection
    }

    fn recipient(
        &self,
        member: Member,
        session: Uuid,
        connected: bool,
        file_available: impl Fn(&(u64, Uuid)) -> bool,
    ) -> Option<RoomRecipient> {
        let room = self.policy.view(member.user_id);
        let authorized = room.as_ref().is_some_and(|room| room.authorized);
        let files = self.files.plans(&self.policy.id, session);
        let watch_bytes = self.watch_byte_plans(session);
        let transit_endpoint = self.selected_service().filter(|service| {
            service.session_id == session
                && (!files.is_empty()
                    || !watch_bytes.is_empty()
                    || self
                        .flows()
                        .any(|flow| flow.sender == session || flow.receiver == session))
        });
        if room.is_none() && transit_endpoint.is_none() {
            return None;
        }
        let subscriptions = if authorized {
            self.subscriptions(session).into_iter().collect::<Vec<_>>()
        } else {
            vec![]
        };
        Some(RoomRecipient {
            handoffs: self.activity.get(&session).filter(|_| authorized).map(|a| a.handoffs.clone()).unwrap_or_default(),
            screen_helpers: self
                .activity
                .get(&session)
                .filter(|_| authorized)
                .into_iter()
                .flat_map(|activity| &activity.watching)
                .filter_map(|(id, helper)| helper.map(|endpoint| (*id, endpoint)))
                .collect(),
            transit_endpoint,
            watch_subscriptions: self
                .activity
                .get(&session)
                .filter(|_| authorized)
                .map(|a| {
                    a.watch_subscriptions
                        .iter()
                        .map(|(id, mode)| crate::wire::WatchSubscription {
                            id: *id,
                            mode: *mode,
                        })
                        .collect()
                })
                .unwrap_or_default(),
            watch_bytes: if authorized || transit_endpoint.is_some() {
                watch_bytes
            } else {
                vec![]
            },
            authorized,
            can_manage: room.as_ref().is_some_and(|room| room.can_manage),
            members: room.and_then(|room| room.members),
            reading: authorized && self.reading(session),
            file_availability: self
                .activity
                .get(&session)
                .filter(|activity| activity.reading && authorized && connected)
                .and_then(|activity| activity.file_observation.as_ref())
                .map(|observation| crate::wire::FileAvailability {
                    observation_id: observation.id,
                    available: observation.keys.iter().map(file_available).collect(),
                }),
            relay_override: self
                .activity
                .get(&session)
                .and_then(|activity| activity.relay_capacity),
            files: if authorized || transit_endpoint.is_some() {
                files
            } else {
                vec![]
            },
            failed_subscriptions: self
                .publications
                .values()
                .filter(|publication| {
                    publication.delivery_failed(session)
                        && subscriptions.contains(&publication.info.id)
                })
                .map(|publication| publication.info.id)
                .collect(),
            subscriptions,
        })
    }

    fn project(&self, views: BTreeMap<Uuid, RoomRecipient>) -> crate::host::RoomProjection {
        let (relay_session_ids, _) = self.relay_sessions();
        let mut projection = crate::host::RoomProjection {
            delivery_frontiers: Vec::new(),
            relay_session_ids,
            allow_service_relay: self.policy.allow_service_relay,
            watch_activities: self
                .watch_activities
                .iter()
                .map(|(id, activity)| crate::wire::WatchActivity {
                    predecessor: None,
                    id: *id,
                    room_id: self.policy.id.clone(),
                    user_id: activity.user_id,
                    session_id: activity.session_id,
                    source: activity.source.clone(),
                    playback: activity.playback.clone(),
                    byte_source: activity.byte_source.clone(),
                    viewer_session_ids: views
                        .iter()
                        .filter_map(|(session, view)| {
                            (view.authorized
                                && view
                                    .watch_subscriptions
                                    .iter()
                                    .any(|subscription| subscription.id == *id))
                            .then_some(*session)
                        })
                        .collect(),
                })
                .collect(),
            last_message_seq: self.last_message_seq,
            summary: crate::host::RoomSummary::from_policy(&self.policy),
            picture: if views.values().any(|view| view.authorized && view.reading) {
                self.policy.appearance.picture.clone()
            } else {
                None
            },
            capabilities: crate::wire::RoomCapabilities {
                attachments: self.attachments_available(),
                history_seek: true,
                file_availability_limit: Some(crate::wire::FILE_AVAILABILITY_LIMIT),
            },
            participant_session_ids: self
                .media_sessions()
                .into_iter()
                .chain(self.activity.iter().filter_map(|(session, activity)| {
                    (activity.reading || !activity.watch_subscriptions.is_empty())
                        .then_some(*session)
                }))
                .chain(self.watch_activities.values().map(|a| a.session_id))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            publications: self
                .publications
                .values()
                .map(|publication| {
                    let mut info = publication.info.clone();
                    if info.kind == Kind::Screen {
                        info.audience = self
                            .activity
                            .iter()
                            .filter(|(_, activity)| activity.watching.contains_key(&info.id))
                            .map(|(session, _)| PublicationAudience {
                                session_id: *session,
                                state: if publication.delivery_failed(*session) {
                                    AudienceState::Failed
                                } else if publication.flows().any(|flow| {
                                    flow.receiver == *session
                                        && flow.selected
                                        && flow.proof == Some(FlowState::Decoded)
                                }) {
                                    AudienceState::Active
                                } else {
                                    AudienceState::Preparing
                                },
                            })
                            .collect();
                    }
                    info
                })
                .collect(),
            voice: self.voice().cloned().collect(),
            views,
            next_route_deadline: self.next_route_deadline(),
            flows: self.flows().collect(),
        };
        if !self.delivery_frontiers.is_empty() {
            let waiting = projection.requested_pairs();
            for mut frontier in self.delivery_frontiers.iter().cloned() {
                frontier.waiting.retain(|&id| waiting.get(&(frontier.source.min(id),frontier.source.max(id))) == Some(&true));
                if !frontier.waiting.is_empty() { projection.delivery_frontiers.push(frontier); }
            }
        }
        projection
    }

    pub(crate) fn set_default_relay_capacity(&mut self, capacity: u8) {
        self.policy.relay_capacity = capacity;
    }
    pub(crate) fn set_relay_capacity(
        &mut self,
        member: Member,
        session: Uuid,
        capacity: Option<u8>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        if capacity.is_some_and(|capacity| capacity > crate::MAX_RELAY_CAPACITY) {
            return Err("invalid_relay_capacity");
        }
        self.activity.entry(session).or_default().relay_capacity = capacity;
        Ok(())
    }

    fn relay_limits(&self) -> RelayLimits {
        RelayLimits {
            shared: Default::default(),
            source_direct_limit: None,
            default: self.policy.relay_capacity as usize,
            overrides: self
                .activity
                .iter()
                .filter_map(|(session, activity)| {
                    activity
                        .relay_capacity
                        .map(|capacity| (*session, capacity as usize))
                })
                .collect(),
        }
    }

    pub(crate) fn set_writer(&mut self, session: Uuid, mode: crate::wire::HostingMode) {
        self.writer = Some((session, mode));
    }

    pub fn attachments_available(&self) -> bool {
        self.writer.is_some()
    }
    pub(crate) fn remove_message_files(&mut self, from: u64, through: u64) -> BTreeSet<Uuid> {
        self.files.remove_messages(from, through)
    }
    pub(crate) fn forwarding_available(
        &mut self,
        sender: Uuid,
        kind: Option<crate::forwarding::ForwardingKind>,
    ) {
        use crate::forwarding::ForwardingKind;
        if kind.is_none_or(|kind| kind == ForwardingKind::File) {
            self.files.forwarding_available(sender);
            for watch in self.watch_activities.values_mut() {
                watch.bytes.forwarding_available(sender);
            }
        }
        for publication in self.publications.values_mut() {
            if kind.is_none_or(|kind| {
                matches!(
                    (kind, publication.info.kind),
                    (ForwardingKind::Voice, Kind::Voice) | (ForwardingKind::Screen, Kind::Screen)
                )
            }) {
                publication.forwarding_available(sender);
            }
        }
    }
    pub(crate) fn refuse_byte_branch(
        &mut self, member: Member, sender: Uuid, target: crate::wire::ByteBranchTarget, downstream: Uuid,
    ) -> Result<(), &'static str> {
        if !self.selected_service().is_some_and(|service| service.session_id == sender) {
            self.authorize(member, RoomPermission::Read)?;
        }
        match target {
            crate::wire::ByteBranchTarget::File { message_seq, attachment_id, source_id } =>
                self.files.refuse_branch(message_seq, attachment_id, source_id, sender, downstream),
            crate::wire::ByteBranchTarget::Watch { activity_id, source } => {
                let watch = self.watch_activities.get_mut(&activity_id).ok_or("unassigned_watch_branch")?;
                if watch.byte_source.as_ref() != Some(&source) || sender == source.session_id
                    || !watch.bytes.refuse(source.session_id, sender, downstream) {
                    return Err("unassigned_watch_branch");
                }
                Ok(())
            }
        }
    }
    pub(crate) fn file_command(
        &mut self,
        member: Member,
        session: Uuid,
        seq: u64,
        id: Uuid,
        offer: bool,
        enabled: bool,
    ) -> Result<Option<HistoryRequest>, &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        if !self.attachments_available() {
            return Err("attachments_unavailable");
        }
        if enabled || offer {
            Ok(Some(HistoryRequest::Attachment {
                room_id: self.policy.id.clone(),
                message_seq: seq,
                attachment_id: id,
            }))
        } else {
            self.files.remove(session, seq, id, offer);
            Ok(None)
        }
    }
    pub(crate) fn finish_file(
        &mut self,
        session: Uuid,
        seq: u64,
        author_id: Uuid,
        attachment: crate::AttachmentDescriptor,
        offer: bool,
        enabled: bool,
    ) -> Result<(), &'static str> {
        if enabled {
            self.files
                .install(session, seq, author_id, attachment, offer)
        } else {
            self.files.remove(session, seq, attachment.id, offer);
            Ok(())
        }
    }
    pub fn reading(&self, session: Uuid) -> bool {
        self.activity
            .get(&session)
            .is_some_and(|activity| activity.reading)
    }
    fn forwarding_participants(&self) -> BTreeSet<Uuid> {
        let mut participants = self.media_sessions();
        participants.extend(self.files.demand());
        for (source, receiver) in self.watch_byte_pairs() {
            participants.extend([source, receiver]);
        }
        participants
    }

    // Active participants can finish a bounded handoff after lowering their limit.
    // A new third-party output always requires a positive effective allowance.
    fn relay_sessions(&self) -> (BTreeSet<Uuid>, BTreeSet<Uuid>) {
        use crate::wire::HostingMode;
        let mut active = self.forwarding_participants();
        let service = self.selected_service().map(|endpoint| endpoint.session_id);
        if let Some((id, HostingMode::Lightweight)) = self.writer {
            active.insert(id);
        }
        active.extend(service);
        let mut candidates = active.clone();
        candidates.extend(
            self.activity
                .iter()
                .filter_map(|(id, state)| state.reading.then_some(*id)),
        );
        if let Some((writer, HostingMode::Hosted)) = self.writer {
            if Some(writer) != service {
                active.remove(&writer);
                candidates.remove(&writer);
            }
        }
        candidates.retain(|id| {
            self.activity
                .get(id)
                .and_then(|state| state.relay_capacity)
                .unwrap_or(self.policy.relay_capacity)
                > 0
        });
        (candidates, active)
    }

    fn media_sessions(&self) -> BTreeSet<Uuid> {
        self.activity
            .iter()
            .filter_map(|(session, activity)| {
                (activity.voice.is_some() || !activity.watching.is_empty()).then_some(*session)
            })
            .chain(self.publications.values().map(|p| p.info.session_id))
            .collect()
    }
    pub fn browse(
        &mut self,
        member: Member,
        session: Uuid,
        active: bool,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        let activity = self.activity.entry(session).or_default();
        activity.reading = active;
        if !active {
            activity.file_observation = None;
        }
        Ok(())
    }

    pub(crate) fn observe_files(
        &mut self,
        member: Member,
        session: Uuid,
        observation_id: Uuid,
        keys: Vec<(u64, Uuid)>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        let Some(activity) = self
            .activity
            .get_mut(&session)
            .filter(|activity| activity.reading)
        else {
            return Err("room_not_reading");
        };
        if keys.len() > crate::wire::FILE_AVAILABILITY_LIMIT
            || observation_id.is_nil()
            || keys
                .iter()
                .any(|(seq, id)| *seq == 0 || *seq > i64::MAX as u64 || id.is_nil())
        {
            return Err("invalid_file_observation");
        }
        activity.file_observation = (!keys.is_empty()).then_some(FileObservation {
            id: observation_id,
            keys,
        });
        Ok(())
    }

    pub(crate) fn reaction(
        &self,
        member: Member,
        session: Uuid,
        reaction: String,
        target: crate::conversation::ReactionTarget,
        endpoints: &BTreeMap<Uuid, Endpoint>,
        now: u64,
    ) -> Result<crate::conversation::ReactionEvent, &'static str> {
        use crate::conversation::{ReactionEvent, ReactionTarget, INTERACTION_REACTIONS};
        self.authorize(member, RoomPermission::Read)?;
        if !INTERACTION_REACTIONS.contains(&reaction.as_str()) {
            return Err("invalid_interaction");
        }
        if self
            .activity
            .get(&session)
            .is_some_and(|activity| now < activity.next_interaction_at)
        {
            return Err("rate_limited");
        }
        match &target {
            ReactionTarget::Message { message_seq, .. } if *message_seq == 0 => {
                return Err("message_unavailable")
            }
            ReactionTarget::Publication { publication_id } => {
                self.publication_reaction(*publication_id)?;
            }
            ReactionTarget::Person { user_id }
                if !endpoints.values().any(|endpoint| {
                    endpoint.connected
                        && endpoint.member.user_id == *user_id
                        && self.policy.reads(*user_id)
                }) =>
            {
                return Err("target_unavailable")
            }
            _ => {}
        }
        Ok(ReactionEvent {
            id: Uuid::new_v4(),
            occurred_at: now,
            sender_user_id: member.user_id,
            reaction,
            target,
        })
    }

    pub(crate) fn publication_reaction(
        &self,
        id: Uuid,
    ) -> Result<crate::conversation::PublicationReactions, &'static str> {
        let publication = self
            .publications
            .get(&id)
            .filter(|publication| publication.info.kind == Kind::Screen)
            .ok_or("publication_unavailable")?;
        Ok(crate::conversation::PublicationReactions {
            publication_id: id,
            reactions: publication.reactions.clone(),
        })
    }

    pub(crate) fn publication_reactions(&self) -> Vec<crate::conversation::PublicationReactions> {
        self.publications
            .keys()
            .filter_map(|id| self.publication_reaction(*id).ok())
            .collect()
    }

    pub(crate) fn commit_reaction(
        &mut self,
        session: Uuid,
        event: &crate::conversation::ReactionEvent,
    ) -> Result<Option<crate::conversation::ReactionSnapshot>, &'static str> {
        use crate::conversation::{ReactionSnapshot, ReactionTarget, INTERACTION_INTERVAL_MS};
        let snapshot = if let ReactionTarget::Publication { publication_id } = event.target {
            let publication = self
                .publications
                .get_mut(&publication_id)
                .ok_or("publication_unavailable")?;
            publication.reactions.add(&event.reaction)?;
            Some(ReactionSnapshot::Publication(
                self.publication_reaction(publication_id)?,
            ))
        } else {
            None
        };
        self.activity
            .entry(session)
            .or_default()
            .next_interaction_at = event.occurred_at.saturating_add(INTERACTION_INTERVAL_MS);
        Ok(snapshot)
    }

    pub fn enter(
        &mut self,
        member: Member,
        password: Option<&str>,
        invite: Option<&str>,
    ) -> Result<(), &'static str> {
        self.policy.enter(member.user_id, password, invite)
    }

    pub fn update(
        &mut self,
        member: Member,
        name: String,
        appearance: crate::RoomAppearance,
        access: RoomAccess,
        hidden: bool,
        password: Option<Option<String>>,
        voice_bitrate: Option<u32>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        if voice_bitrate.is_some_and(|bitrate| !crate::access::valid_audio_bitrate(bitrate)) {
            return Err("invalid_audio_bitrate");
        }
        self.policy
            .update(name, appearance, access, hidden, password)?;
        if let Some(bitrate) = voice_bitrate {
            self.policy.voice_bitrate = bitrate;
        }
        Ok(())
    }

    pub fn invite(&mut self, member: Member) -> Result<String, &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        self.policy.invite()
    }

    pub fn invitation(&self, member: Member) -> Result<crate::wire::RoomInvitation, &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        self.policy.invitation()
    }

    pub fn revoke(&mut self, member: Member, target: Member) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        if self.policy.access != RoomAccess::Private || self.policy.manages(target.user_id) {
            return Err("forbidden");
        }
        self.policy.grants.remove(&target.user_id);
        Ok(())
    }

    pub fn history(
        &self,
        member: Member,
        before: Option<u64>,
    ) -> Result<HistoryRequest, &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        Ok(HistoryRequest::Read {
            room_id: self.policy.id.clone(),
            before,
        })
    }

    pub(crate) fn seek_history(
        &self,
        member: Member,
        after: u64,
    ) -> Result<HistoryRequest, &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        // Both SQLite and the Browser's numeric IndexedDB keys must represent the cursor exactly.
        const MAX_SAFE_CURSOR: u64 = (1u64 << f64::MANTISSA_DIGITS) - 1;
        if after > MAX_SAFE_CURSOR {
            return Err("invalid_history_cursor");
        }
        Ok(HistoryRequest::Seek {
            room_id: self.policy.id.clone(),
            after,
            exclude_author: member.user_id,
        })
    }

    pub fn chat(
        &self,
        member: Member,
        text: String,
        nonce: String,
        attachments: Vec<crate::attachment::AttachmentDescriptor>,
        inline_images: BTreeMap<Uuid, crate::attachment::ImageRendition>,
        mentions: Vec<crate::history::Mention>,
        reply: Option<crate::history::ReplyTarget>,
        now: u64,
    ) -> Result<HistoryRequest, &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        if !self.attachments_available() && !attachments.is_empty() {
            return Err("attachments_unavailable");
        }
        Ok(HistoryRequest::Send {
            room_id: self.policy.id.clone(),
            draft: MessageDraft::new(
                member.user_id,
                nonce,
                text,
                attachments,
                inline_images,
                mentions,
                reply,
                now,
            )?,
        })
    }

    pub(crate) fn start_watch(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        replace_id: Option<Uuid>,
        source: crate::wire::WatchSource,
        playback: crate::wire::WatchPlayback,
        byte_source: Option<crate::wire::WatchByteSource>,
        endpoints: &BTreeMap<Uuid, Endpoint>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        source.validate()?;
        playback.validate()?;
        if let Some(current) = self.watch_activities.get(&id) {
            if current.session_id != session
                || current.replace_id != replace_id
                || current.source != source
                || current.playback.timeline != playback.timeline
            {
                return Err("watch_identity_conflict");
            }
            // A start retry must preserve later playback and forwarding settings.
            return Ok(());
        }
        self.validate_watch_byte_source(member, byte_source.as_ref(), endpoints)?;
        let previous = self
            .watch_activities
            .iter()
            .find_map(|(id, activity)| (activity.session_id == session).then_some(*id));
        if replace_id.is_some() && replace_id != previous {
            return Err("watch_identity_conflict");
        }
        if let Some(previous) = previous {
            if replace_id.is_some() {
                self.handoff(ViewSource::Watch(previous), ViewSource::Watch(id));
            }
            self.stop_watch(member, session, previous)?;
        }
        self.watch_activities.insert(
            id,
            Watch {
                replace_id,
                bytes: ByteTree::default(),
                user_id: member.user_id,
                session_id: session,
                source,
                playback,
                byte_source,
            },
        );
        Ok(())
    }
    pub(crate) fn handoff(&mut self, old: ViewSource, target: ViewSource) {
        for activity in self.activity.values_mut() {
            if activity.handoffs.iter().any(|pending| pending.target == target) {
                activity.handoffs.retain(|pending| pending.target != old);
                continue;
            }
            if let Some(pending) = activity.handoffs.iter_mut().find(|p| p.target == old) {
                pending.target = target;
            } else {
                let subscribed = match old {
                    ViewSource::Screen(id) => activity.watching.contains_key(&id),
                    ViewSource::Watch(id) => activity.watch_subscriptions.contains_key(&id),
                };
                if subscribed {
                    activity.handoffs.push(SourceHandoff { predecessor: old, target });
                }
            }
        }
    }

    pub(crate) fn watch_owner(&self, id: Uuid) -> Option<Uuid> {
        self.watch_activities.get(&id).map(|watch| watch.session_id)
    }

    pub(crate) fn watch_user(&self, id: Uuid) -> Option<Uuid> {
        self.watch_activities.get(&id).map(|watch| watch.user_id)
    }

    pub(crate) fn update_watch(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        playback: crate::wire::WatchPlayback,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        playback.validate()?;
        let activity = self
            .watch_activities
            .get_mut(&id)
            .ok_or("watch_unavailable")?;
        if activity.session_id != session {
            return Err("not_watch_owner");
        }
        if activity.playback.timeline != playback.timeline {
            return Err("watch_timeline_changed");
        }
        activity.playback = playback;
        Ok(())
    }
    pub(crate) fn set_watch_byte_source(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        source: Option<crate::wire::WatchByteSource>,
        endpoints: &BTreeMap<Uuid, Endpoint>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        let activity = self.watch_activities.get(&id).ok_or("watch_unavailable")?;
        if activity.session_id != session {
            return Err("not_watch_owner");
        }
        self.validate_watch_byte_source(member, source.as_ref(), endpoints)?;
        let activity = self.watch_activities.get_mut(&id).unwrap();
        if activity.byte_source != source {
            activity.bytes.clear_branches();
            activity.byte_source = source;
        }
        Ok(())
    }
    fn validate_watch_byte_source(
        &self,
        member: Member,
        source: Option<&crate::wire::WatchByteSource>,
        endpoints: &BTreeMap<Uuid, Endpoint>,
    ) -> Result<(), &'static str> {
        if let Some(source) = source {
            let provider = endpoints
                .get(&source.session_id)
                .ok_or("watch_provider_unavailable")?;
            if !provider.online_peer() || provider.member.user_id != member.user_id {
                return Err("watch_provider_unavailable");
            }
            self.authorize(provider.member, RoomPermission::Read)?;
        }
        Ok(())
    }
    fn watch_receivers(activities: &BTreeMap<Uuid, Activity>, id: Uuid) -> impl Iterator<Item = Uuid> + '_ {
        activities.iter().filter_map(move |(session, activity)| {
            (activity.watch_subscriptions.get(&id) == Some(&crate::wire::WatchMode::Peer))
                .then_some(*session)
        })
    }
    fn watch_byte_pairs(&self) -> impl Iterator<Item = (Uuid, Uuid)> + '_ {
        self.watch_activities
            .iter()
            .filter_map(|(&id, activity)| Some((id, activity.byte_source.as_ref()?.session_id)))
            .flat_map(|(id, source)| {
                Self::watch_receivers(&self.activity, id)
                    .map(move |receiver| (source, receiver))
            })
    }
    fn watch_byte_plans(&self, session: Uuid) -> Vec<crate::watch_delivery::WatchBytePlan> {
        self.watch_activities
            .iter()
            .filter_map(|(id, activity)| {
                let source = activity.byte_source.as_ref()?;
                let receivers: BTreeSet<_> = Self::watch_receivers(&self.activity, *id).collect();
                let (upstream, downstream, receiving) =
                    activity.bytes.branch(Some(source.session_id), &receivers, session)?;
                Some(crate::watch_delivery::WatchBytePlan {
                    room_id: self.policy.id.clone(),
                    activity_id: *id,
                    source: source.clone(),
                    upstream,
                    downstream,
                    receiving,
                })
            })
            .collect()
    }
    pub(crate) fn join_watch(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        mode: Option<crate::wire::WatchMode>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        if let Some(mode) = mode {
            let source = self.watch_activities.get(&id).ok_or("watch_unavailable")?;
            if source.session_id != session {
                self.activity
                    .entry(session)
                    .or_default()
                    .watch_subscriptions
                    .insert(id, mode);
            }
        } else if let Some(activity) = self.activity.get_mut(&session) {
            activity.watch_subscriptions.remove(&id);
        }
        if let Some(activity) = self.activity.get_mut(&session) {
            let source = ViewSource::Watch(id);
            activity.handoffs.retain(|p| p.target != source && (mode.is_some() || p.predecessor != source));
        }
        Ok(())
    }
    pub(crate) fn stop_watch(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        if let Some(activity) = self.watch_activities.get(&id) {
            if activity.session_id != session {
                return Err("not_watch_owner");
            }
        }
        self.watch_activities.remove(&id);
        for activity in self.activity.values_mut() {
            activity.watch_subscriptions.remove(&id);
        }
        Ok(())
    }

    pub fn publications(&self) -> impl Iterator<Item = &PublicationInfo> {
        self.publications
            .values()
            .map(|publication| &publication.info)
    }

    pub fn publication(&self, id: Uuid) -> Option<&PublicationInfo> {
        self.publications
            .get(&id)
            .map(|publication| &publication.info)
    }

    pub fn publish(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        kind: Kind,
        video_settings: Option<VideoSettings>,
        source: Option<crate::wire::ScreenSource>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        validate_video_settings(kind, video_settings)?;
        if kind == Kind::Voice && source.is_some() {
            return Err("invalid_screen_publication");
        }
        let source = source
            .map(|mut source| {
                source.name = source
                    .name
                    .as_deref()
                    .map(|name| crate::wire::title(name).ok_or("invalid_title"))
                    .transpose()?;
                Ok::<_, &'static str>(source)
            })
            .transpose()?;
        if kind == Kind::Voice && !self.voice_joined(session) {
            return Err("voice_not_joined");
        }
        if let Some(publication) = self.publications.get_mut(&id) {
            if publication.info.session_id != session || publication.info.kind != kind {
                return Err("publication_identity_conflict");
            }
            publication.info.video_settings = video_settings;
            if let Some(source) = source {
                publication
                    .info
                    .screen
                    .as_mut()
                    .ok_or("invalid_screen_publication")?
                    .source = source;
            }
        } else {
            if self.publications.values().any(|publication| {
                publication.info.session_id == session && publication.info.kind == kind
            }) {
                return Err("source_already_published");
            }
            self.publications.insert(
                id,
                Publication::new(PublicationInfo {
                    screen: if kind == Kind::Screen {
                        Some(crate::wire::ScreenInfo {
                            predecessor: None,
                            direct_limit: None,
                            source: source.ok_or("invalid_screen_source")?,
                            title: None,
                        })
                    } else {
                        None
                    },
                    id,
                    room_id: self.policy.id.clone(),
                    session_id: session,
                    user_id: member.user_id,
                    kind,
                    paused: false,
                    audience: Vec::new(),
                    video_settings,
                }),
            );
        }
        Ok(())
    }

    pub fn unpublish(&mut self, session: Uuid, id: Uuid) -> Result<bool, &'static str> {
        let Some(publication) = self.publications.get(&id) else {
            return Ok(false);
        };
        if publication.info.session_id != session {
            return Err("not_publication_owner");
        }
        self.publications.remove(&id);
        for activity in self.activity.values_mut() { activity.watching.remove(&id); }
        Ok(true)
    }

    fn owned_screen(
        &mut self,
        session: Uuid,
        id: Uuid,
    ) -> Result<&mut crate::wire::ScreenInfo, &'static str> {
        let publication = self
            .publications
            .get_mut(&id)
            .ok_or("publication_unavailable")?;
        if publication.info.session_id != session {
            return Err("not_publication_owner");
        }
        publication
            .info
            .screen
            .as_mut()
            .ok_or("invalid_screen_publication")
    }
    pub(crate) fn set_screen_direct_limit(
        &mut self,
        session: Uuid,
        id: Uuid,
        limit: Option<u8>,
    ) -> Result<(), &'static str> {
        let screen = self.owned_screen(session, id)?;
        if limit.is_some_and(|value| !(1..=crate::MAX_RELAY_CAPACITY).contains(&value)) {
            return Err("invalid_relay_capacity");
        }
        screen.direct_limit = limit;
        Ok(())
    }
    pub fn set_title(
        &mut self,
        session: Uuid,
        id: Uuid,
        title: Option<String>,
    ) -> Result<(), &'static str> {
        let screen = self.owned_screen(session, id)?;
        screen.title = title
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| crate::wire::title(value).ok_or("invalid_title"))
            .transpose()?;
        Ok(())
    }

    pub fn set_paused(
        &mut self,
        session: Uuid,
        id: Uuid,
        paused: bool,
    ) -> Result<(), &'static str> {
        let publication = self
            .publications
            .get_mut(&id)
            .ok_or("publication_unavailable")?;
        if publication.info.session_id != session {
            return Err("not_publication_owner");
        }
        if publication.info.kind != Kind::Screen {
            return Err("invalid_screen_publication");
        }
        publication.set_paused(paused);
        Ok(())
    }

    pub fn transfer_source(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        to_session: Uuid,
        endpoints: &BTreeMap<Uuid, Endpoint>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        let publication = self.publication(id).ok_or("publication_unavailable")?;
        if publication.session_id != session {
            return Err("not_publication_owner");
        }
        if publication.kind != Kind::Screen {
            return Err("invalid_source_transfer");
        }
        let target = endpoints
            .get(&to_session)
            .filter(|endpoint| endpoint.online_peer())
            .ok_or("source_unavailable")?;
        if target.member.user_id != publication.user_id {
            return Err("forbidden");
        }
        self.authorize(target.member, RoomPermission::Read)?;
        if self.publications.values().any(|other| {
            other.info.id != id
                && other.info.session_id == to_session
                && other.info.kind == Kind::Screen
        }) {
            return Err("source_already_published");
        }
        self.publications
            .get_mut(&id)
            .unwrap()
            .transfer_source(to_session);
        if let Some(activity) = self.activity.get_mut(&to_session) {
            activity.watching.remove(&id);
        }
        Ok(())
    }

    pub fn subscribe(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        enabled: bool,
        helper: Option<(Uuid, &Endpoint)>,
    ) -> Result<bool, &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        let Some(publication) = self.publications.get(&id) else {
            if !enabled {
                if let Some(activity) = self.activity.get_mut(&session) {
                    if let Some(index) = activity.handoffs.iter().position(|p| p.predecessor == ViewSource::Screen(id)) {
                        activity.handoffs.remove(index);
                        return Ok(true);
                    }
                }
            }
            return Err("publication_unavailable");
        };
        if publication.info.kind != Kind::Screen || publication.info.session_id == session {
            return Err("invalid_subscription");
        }
        let helper = if enabled {
            helper
                .map(|(id, endpoint)| {
                    if id == session {
                        return Err("invalid_subscription");
                    }
                    if endpoint.member.user_id != member.user_id {
                        return Err("forbidden");
                    }
                    if !endpoint.online_peer() {
                        return Err("helper_unavailable");
                    }
                    self.authorize(endpoint.member, RoomPermission::Read)?;
                    Ok(id)
                })
                .transpose()?
        } else {
            None
        };
        let activity = self.activity.entry(session).or_default();
        let source = ViewSource::Screen(id);
        activity.handoffs.retain(|p| p.target != source && (enabled || p.predecessor != source));
        let publication = self.publications.get_mut(&id).unwrap();
        if enabled && !activity.watching.contains_key(&id) {
            publication.watch_order.push(session);
        } else if !enabled {
            publication.watch_order.retain(|viewer| *viewer != session);
        }
        Ok(if enabled {
            activity.watching.insert(id, helper) != Some(helper)
        } else {
            activity.watching.remove(&id).is_some()
        })
    }

    pub fn voice(&self) -> impl Iterator<Item = &VoiceInfo> {
        self.activity
            .values()
            .filter_map(|activity| activity.voice.as_ref())
    }

    pub fn voice_joined(&self, session: Uuid) -> bool {
        self.activity
            .get(&session)
            .is_some_and(|activity| activity.voice.is_some())
    }

    pub fn set_voice(
        &mut self,
        member: Member,
        session: Uuid,
        joined: bool,
        muted: bool,
        deafened: bool,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        self.activity.entry(session).or_default().voice = joined.then(|| VoiceInfo {
            session_id: session,
            room_id: self.policy.id.clone(),
            muted,
            deafened,
        });
        self.publications.retain(|_, publication| {
            publication.info.session_id != session || publication.info.kind != Kind::Voice || joined
        });
        Ok(())
    }

    pub fn subscriptions(&self, session: Uuid) -> BTreeSet<Uuid> {
        let Some(activity) = self.activity.get(&session) else {
            return BTreeSet::new();
        };
        let mut requested: BTreeSet<_> = activity.watching.keys().copied().collect();
        if activity.voice.is_some() {
            requested.extend(
                self.publications
                    .values()
                    .filter(|publication| {
                        publication.info.kind == Kind::Voice
                            && publication.info.session_id != session
                    })
                    .map(|publication| publication.info.id),
            );
        }
        requested
    }

    pub fn retire_session(&mut self, session: Uuid) {
        self.publications
            .retain(|_, publication| publication.info.session_id != session);
        self.watch_activities.retain(|_, a| a.session_id != session);
        for activity in self.watch_activities.values_mut() {
            if activity
                .byte_source
                .as_ref()
                .is_some_and(|source| source.session_id == session)
            {
                activity.byte_source = None;
            }
        }
        self.activity.remove(&session);
        for activity in self.activity.values_mut() {
            activity
                .watch_subscriptions
                .retain(|id, _| self.watch_activities.contains_key(id));
        }
    }

    pub fn reconcile(&mut self, endpoints: &BTreeMap<Uuid, Endpoint>, now: u64) {
        self.reconcile_with_pairs(endpoints, now, &BTreeSet::new());
    }

    pub(crate) fn reconcile_with_pairs(
        &mut self,
        endpoints: &BTreeMap<Uuid, Endpoint>,
        now: u64,
        confirmed_pairs: &BTreeSet<(Uuid, Uuid)>,
    ) {
        // Keep the retiring service's role while deriving ordinary routing demand.
        let transit_endpoint = self.transit_endpoint;
        self.transit_endpoint = self.transit_endpoint.filter(|service| {
            endpoints
                .get(&service.session_id)
                .is_some_and(Endpoint::online_peer)
        });
        let repair_due = self.repair_at.is_some_and(|deadline| deadline <= now);
        if repair_due {
            self.repair_at = None;
        }
        let mut needs_repair = false;
        let readable: BTreeSet<_> = endpoints
            .iter()
            .filter_map(|(session, endpoint)| {
                self.authorize(endpoint.member, RoomPermission::Read)
                    .is_ok()
                    .then_some(*session)
            })
            .collect();
        let peers: BTreeSet<_> = readable.iter().copied()
            .filter(|id| endpoints[id].can_use_peer_transport).collect();
        self.watch_activities
            .retain(|_, a| readable.contains(&a.session_id));
        for activity in self.watch_activities.values_mut() {
            if activity
                .byte_source
                .as_ref()
                .is_some_and(|source| !peers.contains(&source.session_id))
            {
                activity.byte_source = None;
            }
        }
        let service = self.selected_service().map(|service| service.session_id);
        self.files.reconcile(&peers, service);
        self.publications
            .retain(|_, publication| peers.contains(&publication.info.session_id));
        self.activity
            .retain(|session, _| readable.contains(session));
        for (session, activity) in &mut self.activity {
            activity.handoffs.retain(|p| match p.target {
                ViewSource::Screen(id) => self.publications.contains_key(&id),
                ViewSource::Watch(id) => self.watch_activities.contains_key(&id),
            });
            if !peers.contains(session) {
                activity.voice = None;
                activity.watching.clear();
                activity.watch_subscriptions.retain(|_, mode| *mode != crate::wire::WatchMode::Peer);
            }
            if !endpoints
                .get(session)
                .is_some_and(|endpoint| endpoint.connected)
            {
                activity.file_observation = None;
            }
        }
        for activity in self.activity.values_mut() {
            activity
                .watch_subscriptions
                .retain(|id, _| self.watch_activities.contains_key(id));
            activity
                .watching
                .retain(|id, _| self.publications.contains_key(id));
            for helper in activity.watching.values_mut() {
                if helper.is_some_and(|id| !peers.contains(&id)) {
                    *helper = None;
                }
            }
        }
        let requested: BTreeMap<_, _> = self
            .activity
            .keys()
            .map(|session| (*session, self.subscriptions(*session)))
            .collect();
        let (mut new_relays, active) = self.relay_sessions();
        let mut routable = peers;
        if let Some(endpoint) = transit_endpoint {
            let session = endpoint.session_id;
            if service.is_none() && !active.contains(&session) && !self.reading(session) {
                // Public Read alone is not consent to use the site's service.
                routable.remove(&session);
            }
        }
        if let Some((writer, crate::wire::HostingMode::Hosted)) = self.writer {
            routable.remove(&writer);
        }
        routable.extend(service);
        let connected: BTreeSet<_> = endpoints
            .iter()
            .filter_map(|(session, endpoint)| {
                (endpoint.connected && routable.contains(session)).then_some(*session)
            })
            .collect();
        self.delivery_frontiers.clear();
        let limits = self.relay_limits();
        let mut neighbors = BTreeMap::<Uuid, BTreeSet<Uuid>>::new();
        for &(a, b) in confirmed_pairs {
            if connected.contains(&a) && connected.contains(&b) {
                neighbors.entry(a).or_default().insert(b);
                neighbors.entry(b).or_default().insert(a);
            }
        }
        new_relays.retain(|id| routable.contains(id));
        let relays: BTreeSet<_> = new_relays
            .union(&active)
            .filter(|id| routable.contains(id))
            .copied()
            .collect();
        self.failed_data_pairs
            .retain(|pair| !repair_due && confirmed_pairs.contains(pair));
        let mut byte_neighbors = neighbors.clone();
        for &(a, b) in &self.failed_data_pairs {
            if let Some(peers) = byte_neighbors.get_mut(&a) {
                peers.remove(&b);
            }
            if let Some(peers) = byte_neighbors.get_mut(&b) {
                peers.remove(&a);
            }
        }
        self.files
            .route(endpoints, &byte_neighbors, &new_relays, &limits);
        self.files.collect_frontiers(endpoints, &byte_neighbors, &new_relays, &limits, &self.failed_data_pairs, &mut self.delivery_frontiers);
        let mut waiting_bytes = self.files.waiting();
        for (id, watch) in &mut self.watch_activities {
            let receivers: BTreeSet<_> = Self::watch_receivers(&self.activity, *id).collect();
            watch.bytes.retain_refused(&receivers, |peer| routable.contains(peer));
            let source = watch.byte_source.as_ref().map(|source| source.session_id);
            let parents = source
                .map(|source| watch.bytes.branches(source, &receivers, &byte_neighbors, &new_relays, &limits))
                .unwrap_or_default();
            watch.bytes.commit(source, parents);
            watch.bytes.collect_frontiers(&receivers, &self.failed_data_pairs, &byte_neighbors, &new_relays,
                &limits, &mut self.delivery_frontiers);
            waiting_bytes |= watch.bytes.waiting(&receivers);
        }
        let mut reserved = BTreeMap::<(Uuid, Uuid), usize>::new();
        for flow in self.flows().filter(|flow| {
            !flow.presentation
                && flow.input_flow_id.is_some()
                && self.publications[&flow.publication_id].info.kind == Kind::Screen
        }) {
            *reserved.entry((flow.sender, flow.receiver)).or_default() += 1;
        }
        for (id, publication) in &mut self.publications {
            publication.retain_sessions(&routable);
            let helpers = self
                .activity
                .iter()
                .filter_map(|(viewer, activity)| {
                    activity
                        .watching
                        .get(id)
                        .copied()
                        .flatten()
                        .map(|helper| (*viewer, helper))
                })
                .collect();
            let subscribers = requested
                .iter()
                .filter_map(|(session, ids)| ids.contains(id).then_some(*session))
                .collect();
            if repair_due {
                publication.retry_required(&subscribers, &connected);
            }
            if publication.info.kind == Kind::Screen {
                for flow in publication.relay_flows(&helpers) {
                    *reserved.get_mut(&(flow.sender, flow.receiver)).unwrap() -= 1;
                }
            }
            let mut screen_limits = limits.clone();
            if publication.info.kind == Kind::Screen {
                // A screen source owns its outputs. Forwarders share their
                // remaining capacity across all other screens in the room.
                screen_limits.source_direct_limit = publication
                    .info
                    .screen
                    .as_ref()
                    .and_then(|s| s.direct_limit)
                    .map(usize::from);
                for (&(sender, receiver), &count) in &reserved {
                    if count > 0 && sender != publication.info.session_id {
                        screen_limits
                            .shared
                            .entry(sender)
                            .or_default()
                            .insert(receiver);
                    }
                }
            }
            publication.reconcile(
                &subscribers,
                &connected,
                &relays,
                &helpers,
                &screen_limits,
                &neighbors,
                now,
            );
            if !publication.info.paused {
                publication.collect_frontiers(&subscribers, &neighbors, &new_relays, &helpers,
                    &screen_limits, &mut self.delivery_frontiers);
            }
            publication.bound_screen_preparation(&screen_limits, &helpers);
            if publication.info.kind == Kind::Screen {
                for flow in publication.relay_flows(&helpers) {
                    *reserved.entry((flow.sender, flow.receiver)).or_default() += 1;
                }
            }
            needs_repair |= publication.needs_repair(&subscribers, &connected);
        }
        if !waiting_bytes {
            self.failed_data_pairs.clear();
        }
        needs_repair |= !self.failed_data_pairs.is_empty();
        if needs_repair {
            self.repair_at
                .get_or_insert(now.saturating_add(REQUIRED_REPAIR_MS));
        } else {
            self.repair_at = None;
        }
    }

    pub fn next_route_deadline(&self) -> Option<u64> {
        self.publications
            .values()
            .filter_map(Publication::deadline)
            .chain(self.repair_at)
            .min()
    }

    pub fn expire_media(&mut self, now: u64) -> bool {
        self.publications
            .values_mut()
            .fold(false, |changed, publication| {
                publication.expire(now) || changed
            })
    }

    pub fn flows(&self) -> impl Iterator<Item = Flow> + '_ {
        self.publications
            .values()
            .flat_map(Publication::flows)
            .map(|mut flow| {
                flow.presentation = self
                    .activity
                    .get(&flow.receiver)
                    .and_then(|activity| activity.watching.get(&flow.publication_id))
                    .is_some_and(|helper| *helper == Some(flow.sender));
                flow
            })
    }

    pub fn room_data_state(
        &mut self,
        endpoint: Uuid,
        peer: Uuid,
        ready: bool,
    ) -> Result<bool, &'static str> {
        let pair = (endpoint.min(peer), endpoint.max(peer));
        let data = if ready {
            self.failed_data_pairs.remove(&pair)
        } else {
            let assigned = self
                .files
                .plans(&self.policy.id, endpoint)
                .iter()
                .any(|p| p.upstream == Some(peer) || p.downstream.contains(&peer))
                || self
                    .watch_byte_plans(endpoint)
                    .iter()
                    .any(|p| p.upstream == Some(peer) || p.downstream.contains(&peer));
            if assigned {
                self.retire_byte_pair(endpoint, peer);
            }
            assigned && self.failed_data_pairs.insert(pair)
        };
        Ok(data)
    }

    fn retire_byte_pair(&mut self, first: Uuid, second: Uuid) {
        self.files.failed_pair(first, second);
        for watch in self.watch_activities.values_mut() {
            watch.bytes.retire_pair(first, second);
        }
    }

    pub fn failed_pair(&mut self, first: Uuid, second: Uuid) {
        self.retire_byte_pair(first, second);
        self.failed_data_pairs
            .remove(&(first.min(second), first.max(second)));
        for publication in self.publications.values_mut() {
            publication.failed_pair(first, second);
        }
    }

    pub fn flow_state(
        &mut self,
        flow_id: Uuid,
        receiver: Uuid,
        sender: Uuid,
        state: FlowState,
        now: u64,
    ) -> Result<bool, &'static str> {
        let publication = self
            .publications
            .values_mut()
            .find(|p| {
                p.flows().any(|flow| {
                    flow.id == flow_id && flow.sender == sender && flow.receiver == receiver
                })
            })
            .ok_or("unassigned_flow")?;
        Ok(publication.flow_state(flow_id, receiver, sender, state, now))
    }
}

#[cfg(test)]
mod tests {
    fn confirmed_pairs(pairs: &[(u128, u128)]) -> BTreeSet<(Uuid, Uuid)> {
        pairs
            .iter()
            .map(|&(a, b)| (Uuid::from_u128(a.min(b)), Uuid::from_u128(a.max(b))))
            .collect()
    }

    fn screen_room_pairs() -> BTreeSet<(Uuid, Uuid)> {
        confirmed_pairs(&[(1, 3), (1, 2), (2, 4)])
    }

    fn screen_settings() -> Option<crate::wire::VideoSettings> {
        Some(crate::wire::VideoSettings {
            degradation_preference: crate::wire::DegradationPreference::Balanced,
            ceiling: crate::wire::VideoCeiling {
                resolution: crate::wire::VideoResolution {
                    width: 1280,
                    height: 720,
                },
                max_framerate: 29.97,
                max_bitrate: 2_500_000,
            },
        })
    }
    use super::*;
    #[test]
    fn watch_byte_demand_preserves_direct_viewers_and_retires_provider() {
        use crate::wire::{WatchByteSource, WatchFormat, WatchMode, WatchPlayback, WatchSource};
        let id = Uuid::from_u128;
        let mut endpoints: BTreeMap<_, _> = (1..=4)
            .map(|value| {
                (
                    id(value),
                    Endpoint {
                        signing_key: [value as u8; 32],
                        member: Member {
                            user_id: id(if value == 4 { 1 } else { value }),
                        },
                        can_use_peer_transport: true,
                        connected: true,
                    },
                )
            })
            .collect();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "watch".into(),
                "Watch".into(),
                Default::default(),
                id(1),
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        room.set_writer(id(1), crate::wire::HostingMode::Lightweight);
        let owner = endpoints[&id(1)].member;
        room.start_watch(
            owner,
            id(1),
            id(10),
            None,
            WatchSource::Media {
                url: "https://example.com/movie.mp4".into(),
            },
            WatchPlayback {
                timeline: crate::wire::WatchTimeline::Media,
                position: 0.,
                paused: true,
                rate: 1.,
                anchor_time: 0,
            },
            None,
            &endpoints,
        )
        .unwrap();
        room.join_watch(
            endpoints[&id(2)].member,
            id(2),
            id(10),
            Some(WatchMode::Direct),
        )
        .unwrap();
        let source = WatchByteSource {
            session_id: id(4),
            resource_id: id(11),
            format: WatchFormat::File,
        };
        assert_eq!(
            room.set_watch_byte_source(
                endpoints[&id(2)].member,
                id(2),
                id(10),
                Some(source.clone()),
                &endpoints
            ),
            Err("not_watch_owner")
        );
        let mut foreign = source.clone();
        foreign.session_id = id(3);
        assert_eq!(
            room.set_watch_byte_source(owner, id(1), id(10), Some(foreign), &endpoints),
            Err("watch_provider_unavailable")
        );
        room.set_watch_byte_source(owner, id(1), id(10), Some(source), &endpoints)
            .unwrap();
        room.reconcile(&endpoints, 0);
        assert!(room.forwarding_participants().is_empty());
        room.join_watch(
            endpoints[&id(3)].member,
            id(3),
            id(10),
            Some(WatchMode::Peer),
        )
        .unwrap();
        room.reconcile(&endpoints, 1);
        assert_eq!(
            room.forwarding_participants(),
            BTreeSet::from([id(3), id(4)])
        );
        let waiting = room.watch_byte_plans(id(3)).pop().unwrap();
        assert!(waiting.receiving && waiting.upstream.is_none());
        room.browse(owner, id(1), true).unwrap();
        let pairs = confirmed_pairs(&[(1, 4), (1, 3)]);
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        let source_plan = room.watch_byte_plans(id(4)).pop().unwrap();
        let transit = room.watch_byte_plans(id(1)).pop().unwrap();
        let viewer = room.watch_byte_plans(id(3)).pop().unwrap();
        assert_eq!(source_plan.downstream, vec![id(1)]);
        assert_eq!(transit.upstream, Some(id(4)));
        assert_eq!(transit.downstream, vec![id(3)]);
        assert!(!transit.receiving);
        assert_eq!(viewer.upstream, Some(id(1)));
        assert!(viewer.receiving);
        assert!(room.watch_byte_plans(id(2)).is_empty());
        let target = crate::wire::ByteBranchTarget::Watch {
            activity_id: id(10),
            source: source_plan.source,
        };
        room.refuse_byte_branch(owner, id(1), target, id(3)).unwrap();
        room.join_watch(endpoints[&id(3)].member, id(3), id(10), Some(WatchMode::Direct)).unwrap();
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        room.join_watch(endpoints[&id(3)].member, id(3), id(10), Some(WatchMode::Peer)).unwrap();
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert_eq!(room.watch_byte_plans(id(3))[0].upstream, Some(id(1)));
        room.set_watch_byte_source(owner, id(1), id(10), None, &endpoints)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        assert!(room.watch_byte_plans(id(3)).is_empty());
        assert_eq!(
            room.activity[&id(2)].watch_subscriptions[&id(10)],
            WatchMode::Direct
        );
        assert_eq!(
            room.activity[&id(3)].watch_subscriptions[&id(10)],
            WatchMode::Peer
        );
        room.set_watch_byte_source(
            owner,
            id(1),
            id(10),
            Some(WatchByteSource {
                session_id: id(4),
                resource_id: id(12),
                format: WatchFormat::File,
            }),
            &endpoints,
        )
        .unwrap();
        endpoints.get_mut(&id(4)).unwrap().connected = false;
        room.reconcile(&endpoints, 4);
        assert!(room.watch_activities[&id(10)].byte_source.is_some());
        assert_eq!(
            room.forwarding_participants(),
            BTreeSet::from([id(3), id(4)])
        );
        endpoints.remove(&id(4));
        room.reconcile(&endpoints, 5);
        assert!(room.watch_activities[&id(10)].byte_source.is_none());
        assert!(room.forwarding_participants().is_empty());
        assert!(room.watch_activities.contains_key(&id(10)));
    }

    #[test]
    fn assisted_viewing_prepares_native_transit_and_preserves_the_viewer_branch() {
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_room();
        let viewer = endpoints[&id(2)].member;
        endpoints.insert(
            id(5),
            Endpoint {
                signing_key: [5; 32],
                member: viewer,
                can_use_peer_transport: true,
                connected: true,
            },
        );
        room.subscribe(viewer, id(2), id(10), true, None).unwrap();
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                .unwrap();
        }
        // The helper reserves one WAN output for the other viewer. Its paired
        // display also receives the prepared picture under that same cap.
        room.set_relay_capacity(endpoints[&id(5)].member, id(5), Some(1))
            .unwrap();
        let old: BTreeMap<_, _> = room.flows().map(|flow| (flow.receiver, flow)).collect();
        let command = serde_json::from_value(serde_json::json!({
            "type": "subscribe", "publicationId": id(10), "enabled": true, "helperSessionId": id(5),
        }))
        .unwrap();
        room.command(viewer, id(2), command, &endpoints).unwrap();
        let pairs = confirmed_pairs(&[(1, 3), (1, 2), (2, 4), (3, 5), (2, 5), (4, 5)]);
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert!(!room
            .snapshot(viewer, id(2))
            .unwrap()
            .room
            .participant_session_ids
            .contains(&id(5)));
        let trial: BTreeMap<_, _> = room
            .flows()
            .filter(|flow| !flow.selected)
            .map(|flow| (flow.receiver, flow))
            .collect();
        assert_eq!(trial.len(), 3);
        assert_eq!(trial[&id(2)].sender, id(5));
        assert_eq!(trial[&id(4)].sender, id(5));
        assert_eq!(trial[&id(2)].input_flow_id, Some(trial[&id(5)].id));
        assert_eq!(trial[&id(4)].input_flow_id, Some(trial[&id(5)].id));
        assert!(old
            .values()
            .all(|old| room.flows().any(|flow| flow.id == old.id && flow.selected)));
        for flow in trial.values() {
            room.flow_state(
                flow.id,
                flow.receiver,
                flow.sender,
                FlowState::Forwardable,
                3,
            )
            .unwrap();
        }
        assert!(old
            .values()
            .all(|old| room.flows().any(|flow| flow.id == old.id && flow.selected)));
        for receiver in [id(2), id(4)] {
            let flow = &trial[&receiver];
            room.flow_state(flow.id, receiver, flow.sender, FlowState::SwitchReady, 4)
                .unwrap();
            if receiver == id(2) {
                let pending = room
                    .flows()
                    .find(|candidate| candidate.id == flow.id)
                    .unwrap();
                assert!(!pending.selected);
                assert_eq!(pending.proof, Some(FlowState::Decoded));
                assert_eq!(pending.presented, Some(true));
                assert!(pending.presentation);
            }
        }
        room.reconcile_with_pairs(&endpoints, 4, &pairs);
        assert!(!room
            .snapshot(viewer, id(2))
            .unwrap()
            .room
            .participant_session_ids
            .contains(&id(5)));
        assert!(trial
            .values()
            .all(|new| room.flows().any(|flow| flow.id == new.id && flow.selected)));
        assert!(!room.flows().any(|flow| flow.sender == id(2)));
        assert!(room
            .snapshot(viewer, id(5))
            .unwrap()
            .subscriptions
            .is_empty());
        assert_eq!(
            room.snapshot(viewer, id(2)).unwrap().publications[0]
                .audience
                .iter()
                .map(|viewer| viewer.session_id)
                .collect::<Vec<_>>(),
            vec![id(2), id(4)],
            "a helper without its own watch intent is not an audience member"
        );
        room.subscribe(viewer, id(2), id(10), false, None).unwrap();
        room.reconcile_with_pairs(&endpoints, 5, &pairs);
        assert!(!room.flows().any(|flow| flow.receiver == id(2)));
        assert!(room
            .flows()
            .any(|flow| flow.sender == id(5) && flow.receiver == id(4) && flow.selected));
    }

    #[test]
    fn assisted_viewing_replaces_unproved_inputs_without_waiting_for_the_old_path() {
        let id = Uuid::from_u128;
        for playing in [false, true] {
            let (mut room, mut endpoints) = screen_room();
            let viewer = endpoints[&id(2)].member;
            endpoints.insert(
                id(5),
                Endpoint {
                    signing_key: [5; 32],
                    member: viewer,
                    can_use_peer_transport: true,
                    connected: true,
                },
            );
            room.subscribe(viewer, id(2), id(10), true, None).unwrap();
            // A can already receive while D has never decoded. The helper
            // must not wait for D's failed Browser relay to become usable.
            if playing {
                for flow in room
                    .flows()
                    .filter(|flow| flow.receiver != id(4))
                    .collect::<Vec<_>>()
                {
                    room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                        .unwrap();
                }
            }
            room.subscribe(
                viewer,
                id(2),
                id(10),
                true,
                Some((id(5), &endpoints[&id(5)])),
            )
            .unwrap();
            let pairs = confirmed_pairs(&[(1, 3), (1, 2), (2, 4), (3, 5), (2, 5), (4, 5)]);
            room.reconcile_with_pairs(&endpoints, 2, &pairs);
            let candidate: BTreeMap<_, _> = room
                .flows()
                .filter(|flow| {
                    flow.selected != playing && [id(2), id(4), id(5)].contains(&flow.receiver)
                })
                .map(|flow| (flow.receiver, flow))
                .collect();
            assert_eq!(candidate[&id(2)].sender, id(5));
            assert_eq!(candidate[&id(4)].sender, id(5));
            if !playing {
                assert_eq!(
                    room.flows().count(),
                    3,
                    "unused old transit retires in the same turn"
                );
            }
            let native = &candidate[&id(5)];
            room.flow_state(
                native.id,
                native.receiver,
                native.sender,
                FlowState::Forwardable,
                3,
            )
            .unwrap();
            for receiver in [id(4), id(2)] {
                let flow = &candidate[&receiver];
                room.flow_state(flow.id, receiver, flow.sender, FlowState::Decoded, 4)
                    .unwrap();
            }
            if playing {
                assert!(room.flows().any(|flow| !flow.selected));
                let flow = &candidate[&id(2)];
                room.flow_state(
                    flow.id,
                    flow.receiver,
                    flow.sender,
                    FlowState::SwitchReady,
                    5,
                )
                .unwrap();
            }
            room.reconcile_with_pairs(&endpoints, 5, &pairs);
            assert!(candidate
                .values()
                .all(|new| room.flows().any(|flow| flow.id == new.id && flow.selected)));
            assert!(!room.flows().any(|flow| flow.sender == id(2)));
        }
    }

    #[test]
    fn assisted_viewing_failure_preserves_the_incumbent_without_repeating_the_choice() {
        let id = Uuid::from_u128;
        for failure in 0..2 {
            let (mut room, mut endpoints) = screen_room();
            let viewer = endpoints[&id(2)].member;
            endpoints.insert(
                id(5),
                Endpoint {
                    signing_key: [5; 32],
                    member: viewer,
                    can_use_peer_transport: true,
                    connected: true,
                },
            );
            room.subscribe(viewer, id(2), id(10), true, None).unwrap();
            for flow in room.flows().collect::<Vec<_>>() {
                room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                    .unwrap();
            }
            let old: BTreeSet<_> = room.flows().map(|flow| flow.id).collect();
            room.subscribe(
                viewer,
                id(2),
                id(10),
                true,
                Some((id(5), &endpoints[&id(5)])),
            )
            .unwrap();
            let pairs = confirmed_pairs(&[(1, 3), (1, 2), (2, 4), (3, 5), (2, 5), (4, 5)]);
            room.reconcile_with_pairs(&endpoints, 2, &pairs);
            let local = room
                .flows()
                .find(|flow| !flow.selected && flow.receiver == id(2))
                .unwrap();
            match failure {
                0 => {
                    room.flow_state(local.id, local.receiver, local.sender, FlowState::Failed, 3)
                        .unwrap();
                }
                1 => {
                    assert!(room.expire_media(20_002));
                }
                _ => unreachable!(),
            }
            for now in [20_003, 25_003, 30_003] {
                room.reconcile_with_pairs(&endpoints, now, &pairs);
                assert!(old
                    .iter()
                    .all(|id| room.flows().any(|flow| flow.id == *id && flow.selected)));
                assert!(!room
                    .flows()
                    .any(|flow| flow.sender == id(5) || flow.receiver == id(5)));
            }
        }
    }

    #[test]
    fn assisted_media_refusal_retires_with_its_failed_upstream_pair() {
        let id = Uuid::from_u128;
        for media_first in [false, true] {
            let (mut room, mut endpoints) = screen_room();
            let viewer = endpoints[&id(2)].member;
            endpoints.insert(
                id(5),
                Endpoint {
                    signing_key: [5; 32],
                    member: viewer,
                    can_use_peer_transport: true,
                    connected: true,
                },
            );
            room.subscribe(viewer, id(2), id(10), true, None).unwrap();
            for flow in room.flows().collect::<Vec<_>>() {
                room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                    .unwrap();
            }
            let incumbent: BTreeSet<_> = room.flows().map(|flow| flow.id).collect();
            room.subscribe(
                viewer,
                id(2),
                id(10),
                true,
                Some((id(5), &endpoints[&id(5)])),
            )
            .unwrap();
            let mut pairs = confirmed_pairs(&[(1, 3), (1, 2), (2, 4), (3, 5), (2, 5), (4, 5)]);
            room.reconcile_with_pairs(&endpoints, 2, &pairs);
            let upstream = room
                .flows()
                .find(|flow| !flow.selected && flow.receiver == id(5))
                .unwrap();
            assert_eq!(upstream.sender, id(3));
            if media_first {
                room.flow_state(
                    upstream.id,
                    upstream.receiver,
                    upstream.sender,
                    FlowState::Failed,
                    3,
                )
                .unwrap();
                room.reconcile_with_pairs(&endpoints, 4, &pairs);
                assert!(!room.flows().any(|flow| !flow.selected));
            }
            room.failed_pair(upstream.sender, upstream.receiver);
            pairs.remove(&(id(3), id(5)));
            room.reconcile_with_pairs(&endpoints, 5, &pairs);
            assert!(incumbent
                .iter()
                .all(|id| room.flows().any(|flow| flow.id == *id && flow.selected)));
            assert!(!room.flows().any(|flow| !flow.selected));
            pairs.insert((id(3), id(5)));
            room.reconcile_with_pairs(&endpoints, 6, &pairs);
            let replacement = room
                .flows()
                .find(|flow| !flow.selected && flow.receiver == id(5))
                .expect(
                    "the replaced upstream no longer rejects the helper's separate display edge",
                );
            assert_ne!(replacement.id, upstream.id);
            assert!(incumbent
                .iter()
                .all(|id| room.flows().any(|flow| flow.id == *id && flow.selected)));
        }
    }

    #[test]
    fn assisted_viewing_authority_and_intent_retire_with_the_existing_activity() {
        use crate::wire::Command;
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_room();
        let viewer = endpoints[&id(2)].member;
        endpoints.insert(
            id(5),
            Endpoint {
                signing_key: [5; 32],
                member: viewer,
                can_use_peer_transport: true,
                connected: true,
            },
        );
        let watch = |helper| Command::Subscribe {
            publication_id: id(10),
            enabled: true,
            helper_session_id: Some(helper),
        };
        for (helper, error) in [
            (id(2), "invalid_subscription"),
            (id(3), "forbidden"),
            (id(6), "helper_unavailable"),
        ] {
            assert_eq!(
                room.command(viewer, id(2), watch(helper), &endpoints).err(),
                Some(error)
            );
            assert!(!room.subscriptions(id(2)).contains(&id(10)));
        }
        endpoints.get_mut(&id(5)).unwrap().connected = false;
        assert_eq!(
            room.command(viewer, id(2), watch(id(5)), &endpoints).err(),
            Some("helper_unavailable")
        );
        endpoints.get_mut(&id(5)).unwrap().connected = true;
        room.command(viewer, id(2), watch(id(5)), &endpoints)
            .unwrap();
        let pairs = confirmed_pairs(&[(1, 3), (1, 2), (2, 4), (3, 5), (2, 5), (4, 5)]);
        room.reconcile_with_pairs(&endpoints, 1, &pairs);
        assert!(room
            .flows()
            .any(|flow| flow.sender == id(5) || flow.receiver == id(5)));
        endpoints.get_mut(&id(5)).unwrap().connected = false;
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert_eq!(
            room.activity[&id(2)].watching[&id(10)],
            Some(id(5)),
            "temporary signaling loss retains the existing authority window"
        );
        endpoints.remove(&id(5));
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        assert_eq!(room.activity[&id(2)].watching[&id(10)], None);
        assert!(!room
            .flows()
            .any(|flow| flow.sender == id(5) || flow.receiver == id(5)));
        room.command(
            viewer,
            id(2),
            Command::Subscribe {
                publication_id: id(10),
                enabled: false,
                helper_session_id: Some(id(5)),
            },
            &endpoints,
        )
        .unwrap();
        assert!(
            !room.subscriptions(id(2)).contains(&id(10)),
            "unwatch does not require an expired helper"
        );
        room.subscribe(viewer, id(2), id(10), true, None).unwrap();
        room.retire_session(id(2));
        room.reconcile_with_pairs(&endpoints, 4, &pairs);
        assert!(room.subscriptions(id(2)).is_empty());

        // A room grant belongs to the user, including its approved helper.
        endpoints.insert(
            id(5),
            Endpoint {
                signing_key: [5; 32],
                member: viewer,
                can_use_peer_transport: true,
                connected: true,
            },
        );
        let owner = endpoints[&id(1)].member;
        room.update(
            owner,
            "Private".into(),
            Default::default(),
            RoomAccess::Private,
            false,
            None,
            None,
        )
        .unwrap();
        for user in [id(2), id(3), id(4)] {
            room.policy.grants.insert(user);
        }
        room.command(viewer, id(2), watch(id(5)), &endpoints)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 5, &pairs);
        assert!(room
            .flows()
            .any(|flow| flow.sender == id(5) || flow.receiver == id(5)));
        room.revoke(owner, viewer).unwrap();
        room.reconcile_with_pairs(&endpoints, 6, &pairs);
        assert!(room.subscriptions(id(2)).is_empty());
        assert!(!room
            .flows()
            .any(|flow| [id(2), id(5)].contains(&flow.sender)
                || [id(2), id(5)].contains(&flow.receiver)));
        assert_eq!(
            room.command(viewer, id(2), watch(id(5)), &endpoints).err(),
            Some("room_access_required")
        );
    }

    mod screen_direct_limit;

    #[test]
    fn file_observation_is_private_and_tracks_live_holders_without_routing() {
        use crate::wire::Command;

        let reader = Uuid::from_u128(1);
        let holder = Uuid::from_u128(2);
        let member = Member { user_id: reader };
        let mut endpoints = BTreeMap::from([
            (
                reader,
                Endpoint {
                    member,
                    can_use_peer_transport: true,
                    connected: true,
                    signing_key: [1; 32],
                },
            ),
            (
                holder,
                Endpoint {
                    member: Member { user_id: holder },
                    can_use_peer_transport: true,
                    connected: true,
                    signing_key: [2; 32],
                },
            ),
        ]);
        let mut room = RoomRuntime::new(
            RoomState::new(
                "files".into(),
                "Files".into(),
                Default::default(),
                reader,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        let attachment = crate::AttachmentDescriptor {
            id: Uuid::from_u128(3),
            name: "file.txt".into(),
            size: 1,
            media_type: "text/plain".into(),
            sha256: crate::attachment::sha256_hex(b"a"),
        };
        let observation_id = Uuid::from_u128(4);
        let observe = |keys| Command::ObserveFiles {
            room_id: "files".into(),
            observation_id,
            keys,
        };
        let keys = vec![(1, attachment.id)];
        assert_eq!(
            room.command(member, reader, observe(keys.clone()), &endpoints)
                .err(),
            Some("room_not_reading"),
        );
        room.browse(member, reader, true).unwrap();
        room.command(member, reader, observe(keys.clone()), &endpoints)
            .unwrap();
        for (now, available) in [(1, false), (2, true), (3, false)] {
            if now == 2 {
                room.files
                    .install(holder, 1, holder, attachment.clone(), true)
                    .unwrap();
            }
            if now == 3 {
                endpoints.get_mut(&holder).unwrap().connected = false;
            }
            room.reconcile(&endpoints, now);
            let projection = room.projection(&endpoints);
            let reader_view = projection.snapshot(reader, true).unwrap();
            let observation = reader_view.room.file_availability.unwrap();
            assert_eq!(observation.observation_id, observation_id);
            assert_eq!(observation.available, vec![available]);
            assert!(projection
                .snapshot(holder, true)
                .unwrap()
                .room
                .file_availability
                .is_none());
            assert!(reader_view.files.is_empty());
        }
        room.command(member, reader, observe(vec![]), &endpoints)
            .unwrap();
        assert!(room
            .snapshot(member, reader)
            .unwrap()
            .room
            .file_availability
            .is_none());
        room.command(member, reader, observe(keys), &endpoints)
            .unwrap();
        room.browse(member, reader, false).unwrap();
        room.browse(member, reader, true).unwrap();
        assert!(room
            .snapshot(member, reader)
            .unwrap()
            .room
            .file_availability
            .is_none());
    }

    #[test]
    fn file_observation_and_delivery_follow_copy_forwarding_permission() {
        let id = Uuid::from_u128;
        let (fixture, endpoints) = screen_room();
        let mut room = RoomRuntime::new(fixture.policy);
        let (reader, copy, author) = (id(1), id(2), id(3));
        room.set_writer(reader, crate::wire::HostingMode::Lightweight);
        let file = crate::AttachmentDescriptor {
            id: id(30),
            name: "copy.bin".into(),
            size: 1,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"a"),
        };
        let member = endpoints[&reader].member;
        room.browse(member, reader, true).unwrap();
        room.observe_files(member, reader, id(31), vec![(1, file.id)]).unwrap();
        room.finish_file(copy, 1, author, file.clone(), true, true).unwrap();
        room.finish_file(reader, 1, author, file.clone(), false, true).unwrap();
        let pairs = confirmed_pairs(&[(1, 2), (1, 3)]);
        for (step, limit, expected_source) in [(1, 0, None), (2, 1, Some(copy)), (3, 0, Some(author))] {
            room.set_relay_capacity(endpoints[&copy].member, copy, Some(limit)).unwrap();
            if step == 3 {
                room.set_relay_capacity(endpoints[&author].member, author, Some(0)).unwrap();
                room.finish_file(author, 1, author, file.clone(), true, true).unwrap();
            }
            room.reconcile_with_pairs(&endpoints, step, &pairs);
            let view = room.projection(&endpoints).snapshot(reader, true).unwrap();
            assert_eq!(view.files[0].upstream, expected_source);
            assert_eq!(view.room.file_availability.unwrap().available, [expected_source.is_some()]);
        }
    }

    fn screen_room() -> (RoomRuntime, BTreeMap<Uuid, Endpoint>) {
        let id = Uuid::from_u128;
        let endpoints: BTreeMap<_, _> = (1..=4)
            .map(|value| {
                (
                    id(value),
                    Endpoint {
                        signing_key: [value as u8; 32],
                        member: Member { user_id: id(value) },
                        can_use_peer_transport: true,
                        connected: true,
                    },
                )
            })
            .collect();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "friends".into(),
                "Friends".into(),
                Default::default(),
                id(1),
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        room.set_writer(id(1), crate::wire::HostingMode::Lightweight);
        for (session, endpoint) in &endpoints {
            room.browse(endpoint.member, *session, true).unwrap();
            room.set_voice(endpoint.member, *session, true, true, false)
                .unwrap();
        }
        let publication = id(10);
        room.publish(
            endpoints[&id(3)].member,
            id(3),
            publication,
            Kind::Screen,
            screen_settings(),
            Some(crate::wire::ScreenSource::default()),
        )
        .unwrap();
        room.subscribe(endpoints[&id(4)].member, id(4), publication, true, None)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 0, &screen_room_pairs());
        (room, endpoints)
    }

    #[test]
    fn paused_screen_releases_relay_capacity_for_another_screen() {
        let id = Uuid::from_u128;
        let (relay, publisher, first, second) = (id(2), id(3), id(10), id(20));
        let reduction_at = 10;
        let deadline = reduction_at + SCREEN_PREPARE_MS;
        let pairs = confirmed_pairs(&[(3, 1), (1, 2), (2, 4), (2, 5), (2, 6)]);

        for pause_before_reduction in [false, true] {
            let (mut room, mut endpoints) = screen_room();
            for value in [5, 6] {
                let session = id(value);
                let member = Member { user_id: session };
                endpoints.insert(
                    session,
                    Endpoint {
                        signing_key: [value as u8; 32],
                        member,
                        can_use_peer_transport: true,
                        connected: true,
                    },
                );
                room.browse(member, session, true).unwrap();
            }
            for flow in room.flows().collect::<Vec<_>>() {
                room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                    .unwrap();
            }
            let relay_member = endpoints[&relay].member;
            room.set_relay_capacity(relay_member, relay, Some(2)).unwrap();
            room.subscribe(endpoints[&id(6)].member, id(6), first, true, None)
                .unwrap();
            room.reconcile_with_pairs(&endpoints, 2, &pairs);
            assert!(room.flows().any(|flow| {
                flow.publication_id == first && flow.sender == relay && flow.receiver == id(6)
            }));

            if pause_before_reduction {
                room.set_paused(publisher, first, true).unwrap();
            }
            room.set_relay_capacity(relay_member, relay, Some(1)).unwrap();
            room.reconcile_with_pairs(&endpoints, reduction_at, &pairs);
            if !pause_before_reduction {
                room.set_paused(publisher, first, true).unwrap();
            }
            assert_eq!(
                room.next_route_deadline(),
                Some(deadline),
                "pause before reduction: {pause_before_reduction}"
            );

            room.publish(
                endpoints[&id(1)].member,
                id(1),
                second,
                Kind::Screen,
                screen_settings(),
                Some(crate::wire::ScreenSource::default()),
            )
            .unwrap();
            room.subscribe(endpoints[&id(5)].member, id(5), second, true, None)
                .unwrap();

            let second_can_reach_viewer = |room: &RoomRuntime| {
                room.flows().any(|flow| {
                    flow.publication_id == second && flow.sender == relay && flow.receiver == id(5)
                })
            };
            room.reconcile_with_pairs(&endpoints, deadline - 1, &pairs);
            assert!(room.flows().any(|flow| {
                flow.publication_id == first && flow.sender == relay && flow.receiver == id(4)
            }));
            assert!(!second_can_reach_viewer(&room));

            room.reconcile_with_pairs(&endpoints, deadline, &pairs);
            // Keep one downstream on the paused screen and make one slot available.
            room.set_relay_capacity(relay_member, relay, Some(2)).unwrap();
            room.reconcile_with_pairs(&endpoints, deadline + 1, &pairs);
            assert!(
                second_can_reach_viewer(&room),
                "pause before reduction: {pause_before_reduction}"
            );
        }
    }

    #[test]
    fn refused_file_transit_reuses_confirmed_pair_with_zero_forwarding() {
        let id = Uuid::from_u128;
        let (fixture, endpoints) = screen_room();
        let (a, b, c, writer) = (id(1), id(2), id(3), id(4));
        let mut room = RoomRuntime::new(fixture.policy);
        room.set_writer(writer, crate::wire::HostingMode::Hosted);
        for session in [a, b, c] {
            room.set_relay_capacity(endpoints[&session].member, session, Some(0))
                .unwrap();
            room.set_voice(endpoints[&session].member, session, true, true, false)
                .unwrap();
            room.reconcile(&endpoints, 0);
        }
        let file = crate::AttachmentDescriptor {
            id: id(9),
            name: "sample".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        room.finish_file(b, 1, b, file.clone(), true, true).unwrap();
        room.finish_file(c, 1, b, file.clone(), false, true)
            .unwrap();
        let mut confirmed = BTreeSet::from([(a, b), (a, c)]);
        room.reconcile_with_pairs(&endpoints, 0, &confirmed);
        assert!(room.projection(&endpoints).views[&a].files.is_empty());
        assert_eq!(
            room.projection(&endpoints).views[&c].files[0].upstream,
            None
        );
        room.set_relay_capacity(endpoints[&a].member, a, Some(1))
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 1, &confirmed);
        room.refuse_byte_branch(endpoints[&a].member, a, crate::wire::ByteBranchTarget::File { message_seq: 1, attachment_id: file.id, source_id: b }, c).unwrap();
        room.set_relay_capacity(endpoints[&a].member, a, Some(0))
            .unwrap();
        confirmed.insert((b, c));
        room.reconcile_with_pairs(&endpoints, 2, &confirmed);
        room.reconcile_with_pairs(&endpoints, 3, &confirmed);
        let views = room.projection(&endpoints).views;
        assert_eq!(views[&c].files[0].upstream, Some(b));
        assert_eq!(views[&b].files[0].downstream, vec![c]);
        assert!(views[&a].files.is_empty() && views[&writer].files.is_empty());
    }

    #[test]
    fn hosted_repair_reuses_the_helpers_confirmed_hop() {
        let id = Uuid::from_u128;
        let (prior, endpoints) = screen_room();
        let mut room = RoomRuntime::new(prior.policy);
        room.set_writer(id(5), crate::wire::HostingMode::Hosted);
        let (source, first_receiver, helper, waiting) = (id(1), id(2), id(3), id(4));
        for (&peer, endpoint) in &endpoints {
            room.browse(endpoint.member, peer, true).unwrap();
        }
        let file = crate::AttachmentDescriptor {
            id: id(9),
            name: "sample".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        room.finish_file(source, 1, source, file.clone(), true, true)
            .unwrap();
        room.finish_file(first_receiver, 1, source, file.clone(), false, true)
            .unwrap();
        let mut pairs = BTreeSet::from([(source, first_receiver), (first_receiver, helper)]);
        room.reconcile_with_pairs(&endpoints, 0, &pairs);
        room.finish_file(waiting, 1, source, file, false, true)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 1, &pairs);
        room.failed_pair(source, waiting);
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        room.failed_pair(first_receiver, waiting);
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        assert_eq!(
            room.projection(&endpoints).views[&waiting].files[0].upstream,
            None
        );
        pairs.insert((helper, waiting));
        room.reconcile_with_pairs(&endpoints, 4, &pairs);
        let views = room.projection(&endpoints).views;
        assert_eq!(views[&first_receiver].files[0].upstream, Some(source));
        assert_eq!(views[&helper].files[0].upstream, Some(first_receiver));
        assert_eq!(views[&waiting].files[0].upstream, Some(helper));
    }

    #[test]
    fn hosted_file_repair_uses_a_reader_with_both_confirmed_links() {
        let id = Uuid::from_u128;
        let (prior, endpoints) = screen_room();
        let mut room = RoomRuntime::new(prior.policy.clone());
        room.set_writer(id(5), crate::wire::HostingMode::Hosted);
        let (b, c, a, d) = (id(1), id(2), id(3), id(4));
        for (&peer, endpoint) in &endpoints {
            room.browse(endpoint.member, peer, true).unwrap();
        }
        let file = crate::attachment::AttachmentDescriptor {
            id: id(9),
            name: "sample".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        room.files.install(b, 1, b, file.clone(), true).unwrap();
        room.files.install(c, 1, b, file.clone(), false).unwrap();
        let mut pairs = BTreeSet::from([(b, c)]);
        room.reconcile_with_pairs(&endpoints, 0, &pairs);
        assert_eq!(
            room.projection(&endpoints).views[&c].files[0].upstream,
            Some(b)
        );
        room.failed_pair(b, c);
        pairs = [(b, a), (b, d)].into();
        room.reconcile_with_pairs(&endpoints, 1, &pairs);
        assert_eq!(
            room.projection(&endpoints).views[&c].files[0].upstream,
            None
        );
        pairs.insert((c, d));
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert_eq!(
            room.snapshot(endpoints[&c].member, c).unwrap().files[0].upstream,
            Some(d)
        );
        assert!(room.projection(&endpoints).views[&a].files.is_empty());
        room.browse(endpoints[&c].member, c, false).unwrap();
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        let room_view = room.projection(&endpoints).snapshot(a, true).unwrap().room;
        assert!(!room_view.participant_session_ids.contains(&c));
        assert_eq!(
            room_view
                .file_activity
                .iter()
                .map(|entry| (entry.session_id, entry.sending, entry.receiving))
                .collect::<Vec<_>>(),
            [(b, true, false), (c, false, true)]
        );
        room.files.remove(c, 1, file.id, false);
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        assert!(room
            .projection(&endpoints)
            .views
            .values()
            .all(|view| view.files.is_empty()));
        assert!(room
            .projection(&endpoints)
            .snapshot(a, true)
            .unwrap()
            .room
            .file_activity
            .is_empty());
    }

    #[test]
    fn waiting_voice_and_files_use_confirmed_pairs_without_room_ack() {
        let id = Uuid::from_u128;
        let (prior, endpoints) = screen_room();
        let (a, b, c) = (id(1), id(2), id(3));
        for voice in [true, false] {
            let mut room = RoomRuntime::new(prior.policy.clone());
            room.set_writer(b, crate::wire::HostingMode::Lightweight);
            let file = crate::attachment::AttachmentDescriptor {
                id: id(9),
                name: "sample".into(),
                size: 3,
                media_type: "application/octet-stream".into(),
                sha256: crate::attachment::sha256_hex(b"abc"),
            };
            if voice {
                for peer in [a, b, c] {
                    room.set_voice(endpoints[&peer].member, peer, true, true, false)
                        .unwrap();
                }
                room.publish(endpoints[&a].member, a, id(10), Kind::Voice, None, None)
                    .unwrap();
            } else {
                room.files.install(a, 1, a, file.clone(), true).unwrap();
                room.files.install(c, 1, a, file.clone(), false).unwrap();
            }
            room.reconcile_with_pairs(&endpoints, 0, &BTreeSet::from([(a, b)]));
            assert!(room.flows().all(|flow| flow.receiver != c));
            if !voice {
                assert_eq!(
                    room.projection(&endpoints).views[&c].files[0].upstream,
                    None
                );
                assert!(!room.room_data_state(c, a, false).unwrap());
            }
            let pairs = BTreeSet::from([(a, b), (a, c)]);
            room.reconcile_with_pairs(&endpoints, 1, &pairs);
            if voice {
                assert!(room
                    .flows()
                    .any(|f| f.sender == a && f.receiver == c && f.proof.is_none()));
                room.set_voice(endpoints[&c].member, c, false, true, false)
                    .unwrap();
            } else {
                assert_eq!(
                    room.snapshot(endpoints[&c].member, c).unwrap().files[0].upstream,
                    Some(a)
                );
                assert!(room.room_data_state(c, a, false).unwrap());
                room.reconcile_with_pairs(&endpoints, 2, &pairs);
                assert_eq!(
                    room.projection(&endpoints).views[&c].files[0].upstream,
                    None
                );
                assert!(room.room_data_state(c, a, true).unwrap());
                room.reconcile_with_pairs(&endpoints, 3, &pairs);
                assert_eq!(
                    room.projection(&endpoints).views[&c].files[0].upstream,
                    Some(a)
                );
                room.files.remove(c, 1, file.id, false);
            }
            room.reconcile_with_pairs(&endpoints, 5, &pairs);
            assert!(room.flows().all(|flow| flow.receiver != c));
            assert!(room.projection(&endpoints).views[&c].files.is_empty());
        }
    }

    #[test]
    fn waiting_viewers_share_a_confirmed_branch_and_keep_the_serving_flow() {
        let id = Uuid::from_u128;
        let (original, mut endpoints) = screen_room();
        let mut room = RoomRuntime::new(original.policy.clone());
        for number in [5, 6] {
            endpoints.insert(
                id(number),
                Endpoint {
                    member: Member {
                        user_id: id(number),
                    },
                    signing_key: [number as u8; 32],
                    can_use_peer_transport: true,
                    connected: true,
                },
            );
        }
        for (&peer, endpoint) in &endpoints {
            room.browse(endpoint.member, peer, true).unwrap();
            let capacity = if peer == id(1) || peer == id(5) { 2 } else { 0 };
            room.set_relay_capacity(endpoint.member, peer, Some(capacity))
                .unwrap();
        }
        room.publish(
            endpoints[&id(1)].member,
            id(1),
            id(10),
            Kind::Screen,
            screen_settings(),
            Some(Default::default()),
        )
        .unwrap();
        let watch = |room: &mut RoomRuntime, peer| {
            room.subscribe(endpoints[&peer].member, peer, id(10), true, None)
                .unwrap();
        };
        watch(&mut room, id(6));
        room.reconcile_with_pairs(&endpoints, 0, &confirmed_pairs(&[(1, 6)]));
        let serving = room.flows().next().unwrap();
        room.flow_state(
            serving.id,
            serving.receiver,
            serving.sender,
            FlowState::Decoded,
            1,
        )
        .unwrap();
        // One source slot remains. Viewer 4 requested first and has a direct
        // path. Readers 2 and 3 can both receive via a single upstream to 5.
        for viewer in [4, 3, 2] {
            watch(&mut room, id(viewer));
        }
        let pairs = confirmed_pairs(&[(1, 6), (1, 4), (1, 5), (5, 2), (5, 3)]);
        // With room for just one receiver behind 5 the candidates tie on
        // coverage, so the older viewer 4 receives the remaining source slot.
        let mut tie = room.clone();
        tie.set_relay_capacity(endpoints[&id(5)].member, id(5), Some(1))
            .unwrap();
        tie.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert!(tie.flows().any(|flow| flow.receiver == id(4)));

        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        let flows = room.flows().collect::<Vec<_>>();
        assert!(flows
            .iter()
            .any(|flow| flow.id == serving.id && flow.proof == Some(FlowState::Decoded)));
        assert_eq!(
            flows
                .iter()
                .filter(|flow| flow.proof.is_none())
                .map(|flow| (flow.sender, flow.receiver))
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([(id(1), id(5)), (id(5), id(3)), (id(5), id(2))])
        );
        let relay = flows.iter().find(|flow| flow.receiver == id(5)).unwrap();
        assert!(flows
            .iter()
            .filter(|flow| flow.sender == id(5))
            .all(|flow| flow.input_flow_id == Some(relay.id)));
        assert_eq!(room.next_route_deadline(), Some(2 + SCREEN_PREPARE_MS));
        room.flow_state(relay.id, id(5), id(1), FlowState::Failed, 3)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        assert!(room
            .flows()
            .any(|flow| flow.id == serving.id && flow.proof == Some(FlowState::Decoded)));
        assert!(room
            .flows()
            .any(|flow| flow.sender == id(1) && flow.receiver == id(4)));
    }

    #[test]
    fn reader_keeps_its_picture_lease_when_joining_voice_and_shares_capacity_when_watching() {
        let id = Uuid::from_u128;
        let (template, endpoints) = screen_room();
        let mut room = RoomRuntime::new(template.policy.clone());
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        let member = |session| endpoints[&session].member;
        room.browse(member(a), a, true).unwrap();
        room.set_relay_capacity(member(a), a, Some(1)).unwrap();
        for (publisher, publication) in [(b, id(10)), (d, id(11))] {
            room.publish(
                member(publisher),
                publisher,
                publication,
                Kind::Screen,
                screen_settings(),
                Some(crate::wire::ScreenSource::default()),
            )
            .unwrap();
        }
        room.subscribe(member(c), c, id(10), true, None).unwrap();
        room.reconcile(&endpoints, 0);
        room.failed_pair(b, c);
        let mut pairs = confirmed_pairs(&[(1, 2), (1, 3)]);
        room.reconcile_with_pairs(&endpoints, 1, &pairs);
        let input = room.flows().find(|f| f.receiver == a).unwrap();
        let output = room.flows().find(|f| f.receiver == c).unwrap();
        assert_eq!(output.sender, a);
        room.flow_state(input.id, a, b, FlowState::Forwardable, 2)
            .unwrap();
        room.flow_state(output.id, c, a, FlowState::Decoded, 2)
            .unwrap();
        room.set_voice(member(a), a, true, true, false).unwrap();
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        room.browse(member(a), a, false).unwrap();
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        assert!(room.flows().any(|f| f.id == output.id));
        for publication in [id(10), id(11)] {
            room.subscribe(member(a), a, publication, true, None)
                .unwrap();
        }
        room.subscribe(member(c), c, id(11), true, None).unwrap();
        pairs.insert((a, d));
        room.reconcile_with_pairs(&endpoints, 4, &pairs);
        let second_input = room
            .flows()
            .find(|f| f.publication_id == id(11) && f.receiver == a)
            .unwrap();
        room.flow_state(second_input.id, a, d, FlowState::Decoded, 5)
            .unwrap();
        room.failed_pair(d, c);
        room.reconcile_with_pairs(&endpoints, 6, &pairs);
        let outputs: Vec<_> = room.flows().filter(|f| f.sender == a).collect();
        assert_eq!(outputs.len(), 2);
        assert!(outputs.iter().any(|flow| flow.id == output.id));
        assert!(outputs.iter().all(|flow| flow.receiver == c));
        let second = outputs.iter().find(|f| f.publication_id == id(11)).unwrap();
        room.flow_state(second.id, c, a, FlowState::Decoded, 6)
            .unwrap();
        room.subscribe(member(b), b, id(11), true, None).unwrap();
        room.failed_pair(d, b);
        room.reconcile_with_pairs(&endpoints, 6, &pairs);
        assert!(!room.flows().any(|f| f.sender == a && f.receiver == b));
        room.set_relay_capacity(member(a), a, Some(0)).unwrap();
        room.reconcile_with_pairs(&endpoints, 7, &pairs);
        assert!(room
            .flows()
            .any(|flow| flow.id == output.id && flow.selected));
        room.reconcile_with_pairs(&endpoints, 7 + SCREEN_PREPARE_MS, &pairs);
        assert!(!room
            .flows()
            .any(|flow| flow.sender == a && flow.receiver == c));
        assert!(room
            .flows()
            .any(|flow| flow.receiver == a && flow.publication_id == id(10)));
    }

    #[test]
    fn voice_and_file_transit_release_after_the_last_room_activity() {
        let id = Uuid::from_u128;
        for file_mode in [true, false] {
            let (old, ends) = screen_room();
            let mut r = RoomRuntime::new(old.policy.clone());
            r.set_writer(id(1), crate::wire::HostingMode::Lightweight);
            r.set_default_relay_capacity(1);
            for n in 1..=3 {
                r.set_voice(ends[&id(n)].member, id(n), true, true, false)
                    .unwrap();
                r.browse(ends[&id(n)].member, id(n), true).unwrap();
            }
            if file_mode {
                let a = crate::AttachmentDescriptor {
                    id: id(20),
                    name: "f".into(),
                    size: 3,
                    media_type: "application/octet-stream".into(),
                    sha256: crate::attachment::sha256_hex(b"abc"),
                };
                r.files.install(id(1), 1, id(1), a.clone(), true).unwrap();
                r.files.install(id(3), 1, id(1), a, false).unwrap();
            } else {
                r.publish(ends[&id(1)].member, id(1), id(20), Kind::Voice, None, None)
                    .unwrap();
            }
            let pairs = confirmed_pairs(&[(1, 2), (2, 3)]);
            for t in [1, 2, 120001] {
                if t == 2 {
                    r.browse(ends[&id(2)].member, id(2), false).unwrap();
                    r.set_voice(ends[&id(2)].member, id(2), false, true, false)
                        .unwrap();
                }
                r.reconcile_with_pairs(&ends, t, &pairs);
                if file_mode {
                    assert_eq!(
                        t == 1,
                        r.snapshot(ends[&id(2)].member, id(2))
                            .unwrap()
                            .files
                            .iter()
                            .any(|p| p.upstream == Some(id(1)) && p.downstream.contains(&id(3)))
                    );
                } else {
                    assert_eq!(
                        t == 1,
                        r.flows().any(|f| f.sender == id(2) && f.receiver == id(3))
                    );
                }
            }
        }
    }
    #[test]
    fn confirmed_screen_transit_ends_with_the_readers_last_room_activity() {
        let id = Uuid::from_u128;
        let (template, endpoints) = screen_room();
        let mut room = RoomRuntime::new(template.policy.clone());
        let (host, source, relay, viewer, screen) = (id(1), id(1), id(2), id(3), id(10));
        let member = |session| endpoints[&session].member;
        room.set_writer(host, crate::wire::HostingMode::Lightweight);
        room.browse(member(relay), relay, true).unwrap();
        room.set_voice(member(relay), relay, true, true, false)
            .unwrap();
        room.publish(
            member(source),
            source,
            screen,
            Kind::Screen,
            screen_settings(),
            Some(Default::default()),
        )
        .unwrap();
        room.subscribe(member(viewer), viewer, screen, true, None)
            .unwrap();
        let links = [(source, relay), (relay, viewer)].into();
        room.reconcile_with_pairs(&endpoints, 0, &links);
        let through = |room: &RoomRuntime| {
            room.flows()
                .any(|f| f.publication_id == screen && f.sender == relay && f.receiver == viewer)
        };
        assert!(through(&room));
        room.browse(member(relay), relay, false).unwrap();
        room.reconcile_with_pairs(&endpoints, 1, &links);
        assert!(through(&room));
        room.set_voice(member(relay), relay, false, true, false)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 2, &links);
        assert!(
            !through(&room),
            "public admission and confirmed links cannot retain inactive screen transit"
        );
        assert!(!room
            .flows()
            .any(|f| f.publication_id == screen && f.receiver == relay));
    }
    #[test]
    fn ready_file_copy_clears_unserved_holder_without_preparing_voice() {
        let id = Uuid::from_u128;
        let endpoints: BTreeMap<_, _> = (1..=3)
            .map(|value| {
                (
                    id(value),
                    Endpoint {
                        signing_key: [value as u8; 32],
                        member: Member { user_id: id(value) },
                        can_use_peer_transport: true,
                        connected: true,
                    },
                )
            })
            .collect();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "friends".into(),
                "Friends".into(),
                Default::default(),
                id(1),
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        room.set_writer(id(1), crate::wire::HostingMode::Lightweight);
        room.set_default_relay_capacity(1);
        room.set_relay_capacity(endpoints[&id(2)].member, id(2), Some(0))
            .unwrap();
        for session in [id(1), id(2)] {
            room.set_voice(endpoints[&session].member, session, true, false, false)
                .unwrap();
        }
        room.reconcile(&endpoints, 0);
        room.publish(
            endpoints[&id(1)].member,
            id(1),
            id(20),
            Kind::Voice,
            None,
            None,
        )
        .unwrap();
        let pairs = confirmed_pairs(&[(1, 2)]);
        room.reconcile_with_pairs(&endpoints, 1, &pairs);
        let voice = room
            .flows()
            .find(|flow| flow.publication_id == id(20))
            .unwrap();
        room.flow_state(
            voice.id,
            voice.receiver,
            voice.sender,
            FlowState::Forwardable,
            1,
        )
        .unwrap();

        let attachment = crate::AttachmentDescriptor {
            id: id(30),
            name: "copy.bin".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        room.finish_file(id(3), 1, id(3), attachment.clone(), true, true)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert!(
            !room
                .projection(&endpoints)
                .snapshot(id(2), true)
                .unwrap()
                .room
                .file_activity
                .iter()
                .any(|activity| activity.session_id == id(3)),
            "an idle cached copy has no file activity"
        );
        room.finish_file(id(2), 1, id(3), attachment.clone(), false, true)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert!(
            room.projection(&endpoints)
                .snapshot(id(2), true)
                .unwrap()
                .room
                .file_activity
                .iter()
                .any(|activity| activity.session_id == id(3) && activity.sending),
            "the selected file source participates while its path prepares"
        );
        assert_eq!(
            room.projection(&endpoints).views[&id(2)].files[0].upstream,
            None
        );
        assert!(
            room.flows()
                .all(|flow| flow.id == voice.id && flow.selected),
            "file admission keeps the established voice lease"
        );

        room.finish_file(id(1), 1, id(3), attachment, true, true)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        assert!(
            !room
                .projection(&endpoints)
                .snapshot(id(2), true)
                .unwrap()
                .room
                .file_activity
                .iter()
                .any(|activity| activity.session_id == id(3)),
            "a replaced file source returns to being only a cached copy"
        );
        assert_eq!(
            room.snapshot(endpoints[&id(2)].member, id(2))
                .unwrap()
                .files[0]
                .source_id,
            Some(id(1))
        );
        assert!(room.projection(&endpoints).views[&id(3)].files.is_empty());
        let retained: Vec<_> = room
            .flows()
            .filter(|flow| flow.publication_id == id(20))
            .collect();
        assert_eq!(
            retained.len(),
            1,
            "the discarded file route leaves one voice lease"
        );
        assert_eq!(retained[0].id, voice.id);
        assert!(retained[0].selected);
    }

    #[test]
    fn capacity_reduction_moves_a_feasible_sibling_and_releases_abandoned_reservations() {
        let id = Uuid::from_u128;
        let endpoints: BTreeMap<_, _> = (1..=5)
            .map(|value| {
                (
                    id(value),
                    Endpoint {
                        signing_key: [value as u8; 32],
                        member: Member { user_id: id(value) },
                        can_use_peer_transport: true,
                        connected: true,
                    },
                )
            })
            .collect();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "capacity".into(),
                "Capacity".into(),
                Default::default(),
                id(1),
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        room.set_writer(id(1), crate::wire::HostingMode::Lightweight);
        room.set_default_relay_capacity(3);
        for (session, capacity) in [(2, 1), (3, 0), (4, 0), (5, 2)] {
            room.set_relay_capacity(endpoints[&id(session)].member, id(session), Some(capacity))
                .unwrap();
        }
        for peer in 1..=5 {
            room.set_voice(endpoints[&id(peer)].member, id(peer), true, false, false)
                .unwrap();
        }
        for source in [1, 5] {
            room.publish(
                endpoints[&id(source)].member,
                id(source),
                id(source + 20),
                Kind::Voice,
                None,
                None,
            )
            .unwrap();
        }
        let mut pairs = confirmed_pairs(&[(1, 2), (1, 3), (1, 4), (2, 5)]);
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(
                flow.id,
                flow.receiver,
                flow.sender,
                FlowState::Forwardable,
                2,
            )
            .unwrap();
        }
        let old: BTreeSet<_> = room.flows().map(|flow| flow.id).collect();
        assert!(!old.is_empty());
        room.set_default_relay_capacity(2);
        room.reconcile_with_pairs(&endpoints, 10, &pairs);
        let deadline = room.next_route_deadline();
        assert!(deadline.is_some());
        assert!(room.flows().all(|flow| flow.selected));
        pairs.insert((id(3), id(5)));
        room.reconcile_with_pairs(&endpoints, 11, &pairs);
        let abandoned = room.flows().find(|flow| !flow.selected).unwrap();
        room.set_default_relay_capacity(3);
        room.reconcile_with_pairs(&endpoints, 12, &pairs);
        assert!(room.flows().all(|flow| flow.selected));
        assert_eq!(
            room.flows().map(|flow| flow.id).collect::<BTreeSet<_>>(),
            old
        );
        assert_eq!(
            room.flow_state(
                abandoned.id,
                abandoned.receiver,
                abandoned.sender,
                FlowState::Forwardable,
                12
            ),
            Err("unassigned_flow")
        );
        room.set_default_relay_capacity(2);
        room.reconcile_with_pairs(&endpoints, 22, &pairs);
        let replacement = room
            .flows()
            .find(|flow| !flow.selected)
            .expect("the publication needs media proof on its replacement path");
        assert_eq!(
            (
                replacement.publication_id,
                replacement.sender,
                replacement.receiver
            ),
            (id(21), id(5), id(3))
        );
        assert!(old
            .iter()
            .all(|id| room.flows().any(|flow| flow.id == *id && flow.selected)));
        for flow in room
            .flows()
            .filter(|flow| !flow.selected)
            .collect::<Vec<_>>()
        {
            room.flow_state(
                flow.id,
                flow.receiver,
                flow.sender,
                FlowState::Forwardable,
                23,
            )
            .unwrap();
        }
        room.reconcile_with_pairs(&endpoints, 24, &pairs);

        assert!(!room.flows().any(|flow| !flow.selected));
        assert!(room
            .flows()
            .any(|flow| flow.id == replacement.id && flow.selected));
        assert_eq!(
            room.flows().filter(|flow| flow.receiver == id(3)).count(),
            2
        );
        assert_ne!(replacement.id, abandoned.id);
        assert!(room.flows().any(|flow| flow.publication_id == id(25)
            && flow.sender == id(1)
            && flow.receiver == id(3)));
    }

    #[test]
    fn reduction_selection_keeps_existing_operations_and_picture_proof() {
        let id = Uuid::from_u128;
        for multiple_parents in [false, true] {
            let count = if multiple_parents { 7 } else { 5 };
            let all: BTreeSet<_> = (1..=count).map(id).collect();
            let mut limits = RelayLimits {
                shared: Default::default(),
                source_direct_limit: None,
                default: 3,
                overrides: if multiple_parents {
                    [(id(3), 0), (id(4), 0), (id(5), 0), (id(6), 0), (id(7), 2)].into()
                } else {
                    [(id(2), 1), (id(3), 0), (id(4), 0), (id(5), 2)].into()
                },
            };
            let mut picture = Publication::new(PublicationInfo {
                screen: Some(crate::wire::ScreenInfo {
                    predecessor: None,
                    direct_limit: None,
                    source: Default::default(),
                    title: None,
                }),
                id: id(10),
                room_id: "capacity".into(),
                session_id: id(1),
                user_id: id(1),
                kind: Kind::Screen,
                paused: false,
                audience: Vec::new(),
                video_settings: screen_settings(),
            });
            let helpers = BTreeMap::new();
            let mut neighbors = BTreeMap::<Uuid, BTreeSet<Uuid>>::new();
            let origin_edges = [(1, 2), (1, 3), (1, 4), (2, 5)];
            let extra_edges = if multiple_parents {
                &[(2, 6), (2, 7)][..]
            } else {
                &[]
            };
            for &(a, b) in origin_edges.iter().chain(extra_edges) {
                neighbors.entry(id(a)).or_default().insert(id(b));
                neighbors.entry(id(b)).or_default().insert(id(a));
            }
            let requested: BTreeSet<_> = (2..=count).map(id).collect();
            for requested in [
                [id(2), id(3), id(4)].into_iter().collect(),
                requested.clone(),
            ] {
                picture.reconcile(&requested, &all, &all, &helpers, &limits, &neighbors, 0);
                for flow in picture.flows().collect::<Vec<_>>() {
                    picture.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1);
                }
            }
            let old: BTreeMap<_, _> = picture
                .flows()
                .map(|flow| (flow.receiver, flow.id))
                .collect();
            limits.default = 2;
            let expected = if multiple_parents {
                (id(7), id(5))
            } else {
                (id(5), id(3))
            };
            neighbors.entry(expected.0).or_default().insert(expected.1);
            neighbors.entry(expected.1).or_default().insert(expected.0);
            picture.reconcile(&requested, &all, &all, &helpers, &limits, &neighbors, 10);
            let candidate = picture.flows().find(|flow| !flow.selected).unwrap();
            assert_eq!((candidate.sender, candidate.receiver), expected);
            let deadline = picture.deadline();
            picture.reconcile(&requested, &all, &all, &helpers, &limits, &neighbors, 1_000);
            assert_eq!(picture.deadline(), deadline);
            assert!(picture
                .flows()
                .any(|flow| flow.id == candidate.id && !flow.selected));
            picture.flow_state(
                candidate.id,
                candidate.receiver,
                candidate.sender,
                FlowState::Decoded,
                1_001,
            );
            assert!(picture
                .flows()
                .any(|flow| flow.id == old[&candidate.receiver] && flow.selected));
            picture.flow_state(
                candidate.id,
                candidate.receiver,
                candidate.sender,
                FlowState::SwitchReady,
                1_002,
            );
            picture.reconcile(&requested, &all, &all, &helpers, &limits, &neighbors, 1_003);
            assert!(picture
                .flows()
                .any(|flow| flow.id == candidate.id && flow.selected));
            for (&receiver, &old) in &old {
                if receiver == candidate.receiver {
                    continue;
                }
                assert!(picture.flows().any(|flow| flow.id == old && flow.selected));
            }
        }
    }

    #[test]
    fn relay_reduction_uses_the_picture_switch_proof_and_preserves_the_viewer() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_room();
        let pairs = confirmed_pairs(&[(1, 3), (1, 2), (2, 4), (3, 4)]);
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                .unwrap();
        }
        let old = room.flows().find(|flow| flow.receiver == id(4)).unwrap();
        room.set_relay_capacity(endpoints[&id(2)].member, id(2), Some(0))
            .unwrap();
        room.set_relay_capacity(endpoints[&id(3)].member, id(3), Some(0))
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        let candidate = room
            .flows()
            .find(|flow| flow.publication_id == id(10) && flow.receiver == id(4) && !flow.selected)
            .unwrap();
        assert_eq!(candidate.sender, id(3), "the publication origin uses the room default even when its personal relay override is zero");
        for state in [FlowState::Forwardable, FlowState::Decoded] {
            room.flow_state(candidate.id, candidate.receiver, candidate.sender, state, 3)
                .unwrap();
            assert!(room.flows().any(|flow| flow.id == old.id && flow.selected));
        }
        room.flow_state(
            candidate.id,
            candidate.receiver,
            candidate.sender,
            FlowState::SwitchReady,
            4,
        )
        .unwrap();
        room.reconcile_with_pairs(&endpoints, 5, &pairs);
        assert!(room
            .flows()
            .any(|flow| flow.id == candidate.id && flow.selected));
        assert!(!room
            .flows()
            .any(|flow| flow.publication_id == id(10) && flow.sender == id(2)));
        assert!(room.subscriptions(id(4)).contains(&id(10)));
    }

    #[test]
    fn publishing_voice_and_watch_bytes_uses_the_source_fanout() {
        use crate::wire::{WatchByteSource, WatchFormat, WatchMode, WatchPlayback, WatchSource, WatchTimeline};
        let id = Uuid::from_u128;
        let (existing, endpoints) = screen_room();
        let mut room = RoomRuntime::new(existing.policy);
        room.set_default_relay_capacity(2);
        let source = id(1);
        let owner = endpoints[&source].member;
        let watch = id(10);
        let voice = id(20);
        let listeners = [id(2), id(3)];
        for session in [source, listeners[0], listeners[1]] {
            room.set_voice(endpoints[&session].member, session, true, false, false).unwrap();
        }
        room.publish(owner, source, voice, Kind::Voice, None, None).unwrap();
        room.start_watch(owner, source, watch, None,
            WatchSource::Media { url: "https://example.com/movie.mp4".into() },
            WatchPlayback { timeline: WatchTimeline::Media, position: 0., paused: true, rate: 1., anchor_time: 0 },
            Some(WatchByteSource { session_id: source, resource_id: id(11), format: WatchFormat::File }),
            &endpoints,
        ).unwrap();
        for session in listeners {
            room.join_watch(endpoints[&session].member, session, watch, Some(WatchMode::Peer)).unwrap();
        }
        let pairs = confirmed_pairs(&[(1, 2), (1, 3)]);
        for limit in [Some(1), Some(0), None] {
            room.set_relay_capacity(owner, source, limit).unwrap();
            room.reconcile_with_pairs(&endpoints, 1, &pairs);
            assert_eq!(room.flows().filter(|flow| flow.publication_id == voice && flow.sender == source).count(), 2);
            assert_eq!(room.watch_byte_plans(source)[0].downstream, listeners);
        }
    }

    #[test]
    fn zero_relay_limit_retires_an_excess_branch_at_its_deadline_but_allows_own_voice() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_room();
        let pairs = screen_room_pairs();
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                .unwrap();
        }
        room.set_default_relay_capacity(1);
        for endpoint in [id(2), id(3), id(4)] {
            room.set_relay_capacity(endpoints[&endpoint].member, endpoint, Some(0))
                .unwrap();
        }
        room.set_voice(endpoints[&id(2)].member, id(2), true, false, false)
            .unwrap();
        room.set_voice(endpoints[&id(1)].member, id(1), true, false, false)
            .unwrap();
        room.publish(
            endpoints[&id(2)].member,
            id(2),
            id(20),
            Kind::Voice,
            None,
            None,
        )
        .unwrap();
        room.reconcile_with_pairs(&endpoints, 10, &pairs);
        assert!(room
            .flows()
            .any(|flow| flow.publication_id == id(10) && flow.sender == id(2) && flow.selected));
        assert!(
            room.flows()
                .any(|flow| flow.publication_id == id(20) && flow.sender == id(2)),
            "zero rejects relaying others, not originating voice"
        );
        room.reconcile_with_pairs(&endpoints, 20_010, &pairs);
        assert!(!room
            .flows()
            .any(|flow| flow.publication_id == id(10) && flow.sender == id(2)));
        assert_eq!(
            room.snapshot(endpoints[&id(2)].member, id(2))
                .unwrap()
                .room
                .relay_override,
            Some(0)
        );
    }

    #[test]
    fn failed_picture_delivery_follows_the_watch_until_current_decoded_proof() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_room();
        let mut pairs = screen_room_pairs();
        for receiver in [id(1), id(2)] {
            room.subscribe(endpoints[&receiver].member, receiver, id(10), true, None)
                .unwrap();
        }
        room.reconcile_with_pairs(&endpoints, 0, &pairs);
        let failed = room.flows().find(|flow| flow.receiver == id(2)).unwrap();
        let sibling = room.flows().find(|flow| flow.receiver == id(1)).unwrap();
        let failures = |room: &RoomRuntime, receiver| {
            serde_json::to_value(
                room.snapshot(endpoints[&receiver].member, receiver)
                    .unwrap(),
            )
            .unwrap()["failedSubscriptions"]
                .clone()
        };
        room.flow_state(
            failed.id,
            failed.receiver,
            failed.sender,
            FlowState::Failed,
            1,
        )
        .unwrap();
        pairs.insert((id(2), id(3)));
        room.reconcile_with_pairs(&endpoints, 1, &pairs);
        assert_eq!(failures(&room, id(2)), serde_json::json!([id(10)]));
        assert_eq!(failures(&room, id(4)), serde_json::json!([id(10)]));
        assert_eq!(failures(&room, id(1)), serde_json::json!([]));
        assert!(room.flows().any(|flow| flow.id == sibling.id));
        assert_eq!(
            room.flow_state(
                failed.id,
                failed.receiver,
                failed.sender,
                FlowState::Decoded,
                2
            ),
            Err("unassigned_flow")
        );
        // Exhaust the alternative too, then let the existing room wake reopen
        // failed choices without erasing the watching page's last result.
        let alternative = room.flows().find(|flow| flow.receiver == id(2)).unwrap();
        room.flow_state(
            alternative.id,
            alternative.receiver,
            alternative.sender,
            FlowState::Failed,
            2,
        )
        .unwrap();
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert_eq!(room.next_route_deadline(), Some(5_002));
        room.reconcile_with_pairs(&endpoints, 5_001, &pairs);
        assert!(!room.flows().any(|flow| flow.receiver == id(2)));
        room.reconcile_with_pairs(&endpoints, 5_002, &pairs);
        assert_eq!(failures(&room, id(4)), serde_json::json!([id(10)]));
        let restored = room.flows().find(|flow| flow.receiver == id(2)).unwrap();
        room.flow_state(
            restored.id,
            restored.receiver,
            restored.sender,
            FlowState::Forwardable,
            5_002,
        )
        .unwrap();
        assert_eq!(failures(&room, id(2)), serde_json::json!([id(10)]));
        room.flow_state(
            restored.id,
            restored.receiver,
            restored.sender,
            FlowState::Decoded,
            5_003,
        )
        .unwrap();
        assert_eq!(failures(&room, id(2)), serde_json::json!([]));
        assert_eq!(failures(&room, id(4)), serde_json::json!([id(10)]));
        assert_eq!(
            room.flow_state(
                failed.id,
                failed.receiver,
                failed.sender,
                FlowState::Failed,
                5_003
            ),
            Err("unassigned_flow")
        );
        assert_eq!(failures(&room, id(2)), serde_json::json!([]));
        room.reconcile_with_pairs(&endpoints, 5_003, &pairs);
        let child = room
            .flows()
            .find(|flow| flow.receiver == id(4) && flow.selected)
            .unwrap();
        room.flow_state(
            child.id,
            child.receiver,
            child.sender,
            FlowState::Decoded,
            5_004,
        )
        .unwrap();
        assert_eq!(failures(&room, id(4)), serde_json::json!([]));

        room.flow_state(
            child.id,
            child.receiver,
            child.sender,
            FlowState::Failed,
            5_005,
        )
        .unwrap();
        room.reconcile_with_pairs(&endpoints, 5_005, &pairs);
        assert_eq!(failures(&room, id(4)), serde_json::json!([id(10)]));
        for action in ["unwatch", "transfer", "unpublish", "revoke"] {
            let mut ended = room.clone();
            let viewer = endpoints[&id(4)].member;
            match action {
                "unwatch" => {
                    ended.subscribe(viewer, id(4), id(10), false, None).unwrap();
                    ended.reconcile_with_pairs(&endpoints, 5_006, &pairs);
                    ended.subscribe(viewer, id(4), id(10), true, None).unwrap();
                }
                "transfer" => ended
                    .transfer_source(endpoints[&id(3)].member, id(3), id(10), id(3), &endpoints)
                    .unwrap(),
                "unpublish" => {
                    ended.unpublish(id(3), id(10)).unwrap();
                }
                "revoke" => {
                    ended
                        .update(
                            endpoints[&id(1)].member,
                            "Friends".into(),
                            Default::default(),
                            RoomAccess::Private,
                            false,
                            None,
                            None,
                        )
                        .unwrap();
                    ended.revoke(endpoints[&id(1)].member, viewer).unwrap();
                }
                _ => unreachable!(),
            }
            ended.reconcile_with_pairs(&endpoints, 5_006, &pairs);
            assert_eq!(failures(&ended, id(4)), serde_json::json!([]), "{action}");
        }
    }

    #[test]
    fn source_title_follows_authority_and_committed_source_without_changing_routes() {
        use crate::wire::ScreenSource;
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_room();
        let member = endpoints[&id(3)].member;
        let metadata = |name: &str| {
            Some(ScreenSource {
                name: Some(name.into()),
                ..Default::default()
            })
        };
        let flows = serde_json::to_value(room.flows().collect::<Vec<_>>()).unwrap();
        let deadline = room.next_route_deadline();
        room.publish(
            member,
            id(3),
            id(10),
            Kind::Screen,
            screen_settings(),
            metadata("Editor"),
        )
        .unwrap();
        room.set_title(id(3), id(10), Some("  Demo  ".into()))
            .unwrap();
        room.publish(
            member,
            id(3),
            id(10),
            Kind::Screen,
            screen_settings(),
            metadata("Browser"),
        )
        .unwrap();
        room.publish(member, id(3), id(10), Kind::Screen, screen_settings(), None)
            .unwrap();
        let screen = room.publication(id(10)).unwrap().screen.as_ref().unwrap();
        assert_eq!(screen.title.as_deref(), Some("Demo"));
        assert_eq!(screen.source.name.as_deref(), Some("Browser"));
        assert_eq!(
            serde_json::to_value(room.flows().collect::<Vec<_>>()).unwrap(),
            flows
        );
        assert_eq!(room.next_route_deadline(), deadline);
        endpoints.get_mut(&id(4)).unwrap().member = member;
        for session in [id(1), id(4)] {
            assert_eq!(
                room.set_title(session, id(10), Some("No".into())),
                Err("not_publication_owner")
            );
        }
        assert_eq!(
            room.set_title(id(3), id(10), Some("\u{1f600}".repeat(33))),
            Err("invalid_title")
        );
        room.transfer_source(member, id(3), id(10), id(4), &endpoints)
            .unwrap();
        assert_eq!(
            room.publication(id(10))
                .unwrap()
                .screen
                .as_ref()
                .unwrap()
                .title
                .as_deref(),
            Some("Demo")
        );
        assert_eq!(
            room.set_title(id(3), id(10), None),
            Err("not_publication_owner")
        );
        room.set_title(id(4), id(10), Some("   ".into())).unwrap();
        let projected = serde_json::to_value(room.publication(id(10)).unwrap()).unwrap();
        assert!(projected["title"].is_null());
        assert_eq!(projected["source"]["name"], "Browser");
        room.unpublish(id(4), id(10)).unwrap();
        assert!(room.publication(id(10)).is_none());
        assert_eq!(
            room.publish(member, id(4), id(10), Kind::Screen, screen_settings(), None),
            Err("invalid_screen_source")
        );
    }

    #[test]
    fn source_ceiling_upsert_preserves_routes_pause_and_transfer() {
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_room();
        let member = endpoints[&id(3)].member;
        let flows = serde_json::to_value(room.flows().collect::<Vec<_>>()).unwrap();
        let deadline = room.next_route_deadline();
        let mut ceiling = screen_settings().unwrap();
        ceiling.ceiling.max_framerate = 59.94;
        room.publish(
            member,
            id(3),
            id(10),
            Kind::Screen,
            Some(ceiling),
            Some(crate::wire::ScreenSource::default()),
        )
        .unwrap();
        assert_eq!(
            room.publication(id(10)).unwrap().video_settings,
            Some(ceiling)
        );
        assert_eq!(
            serde_json::to_value(room.flows().collect::<Vec<_>>()).unwrap(),
            flows
        );
        assert_eq!(room.next_route_deadline(), deadline);
        room.set_paused(id(3), id(10), true).unwrap();
        let deadline = room.next_route_deadline();
        ceiling.degradation_preference = crate::wire::DegradationPreference::MaintainFramerate;
        room.publish(
            member,
            id(3),
            id(10),
            Kind::Screen,
            Some(ceiling),
            Some(crate::wire::ScreenSource::default()),
        )
        .unwrap();
        assert!(room.publication(id(10)).unwrap().paused);
        assert_eq!(
            serde_json::to_value(room.flows().collect::<Vec<_>>()).unwrap(),
            flows
        );
        assert_eq!(room.next_route_deadline(), deadline);
        let mut rejected = ceiling;
        rejected.degradation_preference = crate::wire::DegradationPreference::MaintainResolution;
        assert_eq!(
            room.publish(
                member,
                id(4),
                id(10),
                Kind::Screen,
                Some(rejected),
                Some(crate::wire::ScreenSource::default())
            ),
            Err("publication_identity_conflict")
        );
        assert_eq!(
            room.publication(id(10)).unwrap().video_settings,
            Some(ceiling)
        );
        assert_eq!(
            room.publish(
                member,
                id(3),
                id(10),
                Kind::Screen,
                Some(crate::wire::VideoSettings {
                    ceiling: crate::wire::VideoCeiling {
                        max_bitrate: 0,
                        ..ceiling.ceiling
                    },
                    ..ceiling
                }),
                Some(crate::wire::ScreenSource::default())
            ),
            Err("invalid_video_settings")
        );
        assert_eq!(
            room.publish(member, id(3), id(11), Kind::Voice, Some(ceiling), None),
            Err("invalid_video_settings")
        );
        room.set_voice(member, id(3), false, true, false).unwrap();
        assert_eq!(
            room.publish(member, id(3), id(11), Kind::Voice, None, None),
            Err("voice_not_joined")
        );
        endpoints.get_mut(&id(4)).unwrap().member = member;
        room.transfer_source(member, id(3), id(10), id(4), &endpoints)
            .unwrap();
        let publication = room.publication(id(10)).unwrap();
        assert_eq!(publication.video_settings, Some(ceiling));
        assert!(publication.paused);
        room.publish(member, id(4), id(10), Kind::Screen, None, None)
            .unwrap();
        assert!(room.publication(id(10)).unwrap().video_settings.is_none());
        assert!(room.publication(id(10)).unwrap().paused);
    }

    #[test]
    fn screen_repair_admits_permitted_service_instead_of_using_a_presentation_leaf() {
        let id = Uuid::from_u128;
        let [source, display, viewer, service] = [1, 2, 3, 4].map(id);
        let publication = id(10);
        let endpoints: BTreeMap<_, _> = (1..=4)
            .map(|value| {
                (
                    id(value),
                    Endpoint {
                        signing_key: [value as u8; 32],
                        member: Member {
                            user_id: id(if value == 2 { 1 } else { value }),
                        },
                        can_use_peer_transport: true,
                        connected: true,
                    },
                )
            })
            .collect();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "screen-repair".into(),
                "Screen repair".into(),
                Default::default(),
                source,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        room.set_writer(source, crate::wire::HostingMode::Lightweight);
        room.set_service_relay_preference(true);
        room.service_endpoint(
            Some(crate::host::ServiceEndpoint {
                session_id: service,
                connection_id: id(14),
            }),
            &endpoints,
            0,
            &BTreeSet::new(),
        );
        for (publication, sender, receiver, helper) in [
            (publication, source, display, Some(source)),
            (id(11), display, source, None),
        ] {
            room.publish(
                endpoints[&sender].member,
                sender,
                publication,
                Kind::Screen,
                screen_settings(),
                Some(crate::wire::ScreenSource::default()),
            )
            .unwrap();
            room.subscribe(
                endpoints[&receiver].member,
                receiver,
                publication,
                true,
                helper.map(|helper| (helper, &endpoints[&helper])),
            )
            .unwrap();
        }
        let mut pairs = BTreeSet::from([(source, display)]);
        room.reconcile_with_pairs(&endpoints, 0, &pairs);
        let previews: Vec<_> = room.flows().collect();
        for preview in &previews {
            room.flow_state(
                preview.id,
                preview.receiver,
                preview.sender,
                FlowState::Decoded,
                1,
            )
            .unwrap();
        }
        let previews: Vec<_> = previews.iter().map(|flow| flow.id).collect();
        room.reconcile_with_pairs(&endpoints, 1, &pairs);
        assert!(room.flows().any(|flow| {
            flow.publication_id == publication && flow.receiver == display && flow.presentation
        }));

        room.subscribe(endpoints[&viewer].member, viewer, publication, true, None)
            .unwrap();
        pairs.insert((source, viewer));
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert!(!room.flows().any(|flow| flow.receiver == service));
        pairs.remove(&(source, viewer));
        pairs.extend([(display, viewer), (source, service), (viewer, service)]);
        let mut denied = room.clone();
        denied.set_service_relay_preference(false);
        denied.failed_pair(source, viewer);
        denied.reconcile_with_pairs(&endpoints, 3, &pairs);
        denied.reconcile_with_pairs(&endpoints, 4, &pairs);
        assert!(!denied
            .flows()
            .any(|flow| flow.receiver == viewer || flow.receiver == service));
        let connected = endpoints.keys().copied().collect();
        assert!(!denied.publications[&publication].needs_repair(&[viewer].into(), &connected));
        assert!(denied.delivery_frontiers.iter().any(|f| f.source == source && f.waiting.contains(&viewer)));
        denied.set_service_relay_preference(true);
        denied.reconcile_with_pairs(&endpoints, 4, &pairs);
        assert!(denied
            .flows()
            .any(|flow| flow.sender == source && flow.receiver == service));

        room.failed_pair(source, viewer);
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        room.reconcile_with_pairs(&endpoints, 4, &pairs);

        let upstream = room
            .flows()
            .find(|flow| flow.sender == source && flow.receiver == service)
            .expect(
                "a healthy base through a display leaf must not suppress service screen repair",
            );
        assert!(!upstream.presentation);
        assert!(room.subscriptions(service).is_empty());
        let deadline = room.publications[&publication].deadline();
        // Another required path may already have scheduled the shared room wake.
        room.repair_at = Some(5_003);
        room.reconcile_with_pairs(&endpoints, 5_003, &pairs);
        assert!(room.flows().any(|flow| flow.id == upstream.id));
        assert_eq!(room.publications[&publication].deadline(), deadline);
        room.flow_state(upstream.id, service, source, FlowState::Forwardable, 5_004)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 5_004, &pairs);
        let downstream = room
            .flows()
            .find(|flow| flow.sender == service && flow.receiver == viewer)
            .expect("the service's forwardable input must admit the waiting viewer");
        assert_eq!(downstream.input_flow_id, Some(upstream.id));
        room.flow_state(downstream.id, viewer, service, FlowState::Decoded, 5_005)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 5_005, &pairs);
        assert!(room.flows().any(|flow| {
            flow.id == downstream.id && flow.selected && flow.proof == Some(FlowState::Decoded)
        }));

        assert!(previews
            .iter()
            .all(|id| room.flows().any(|flow| flow.id == *id)));
        let mut withdrawn = room.clone();
        withdrawn.set_service_relay_preference(false);
        withdrawn.reconcile_with_pairs(&endpoints, 5_006, &pairs);
        assert!(!withdrawn
            .flows()
            .any(|flow| flow.sender == service || flow.receiver == service));
        assert!(previews
            .iter()
            .all(|id| withdrawn.flows().any(|flow| flow.id == *id)));
        room.subscribe(endpoints[&viewer].member, viewer, publication, false, None)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 5_006, &pairs);
        assert!(!room
            .flows()
            .any(|flow| flow.sender == service || flow.receiver == service));
        assert!(previews
            .iter()
            .all(|id| room.flows().any(|flow| flow.id == *id)));
    }

    #[test]
    fn failed_screen_shortcut_preserves_incumbent_and_cannot_prepare_again() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_room();
        let mut pairs = confirmed_pairs(&[(1, 3), (1, 2), (2, 4), (2, 3)]);
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 0)
                .unwrap();
        }
        room.reconcile_with_pairs(&endpoints, 0, &pairs);
        assert!(room
            .flows()
            .any(|flow| { flow.sender == id(3) && flow.receiver == id(2) && !flow.selected }));
        let incumbent: BTreeSet<_> = room
            .flows()
            .filter(|flow| flow.selected)
            .map(|flow| flow.id)
            .collect();
        room.failed_pair(id(3), id(2));
        pairs.remove(&(id(2), id(3)));
        room.reconcile_with_pairs(&endpoints, 1, &pairs);
        assert_eq!(
            room.flows().map(|flow| flow.id).collect::<BTreeSet<_>>(),
            incumbent
        );
        room.failed_pair(id(2), id(4));
        pairs.remove(&(id(2), id(4)));
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        room.failed_pair(id(1), id(2));
        pairs.remove(&(id(1), id(2)));
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        assert!(!room
            .flows()
            .any(|flow| flow.sender == id(3) && flow.receiver == id(2)));
    }

    #[test]
    fn voice_uses_an_independent_confirmed_path_while_screen_plays() {
        let id = Uuid::from_u128;
        let (fixture, endpoints) = screen_room();
        let mut room = RoomRuntime::new(fixture.policy.clone());
        let (host, source, viewer) = (id(1), id(2), id(3));
        room.set_writer(host, crate::wire::HostingMode::Lightweight);
        room.publish(
            endpoints[&source].member,
            source,
            id(10),
            Kind::Screen,
            screen_settings(),
            Some(crate::wire::ScreenSource::default()),
        )
        .unwrap();
        room.subscribe(endpoints[&viewer].member, viewer, id(10), true, None)
            .unwrap();
        let pairs = BTreeSet::from([(source, viewer)]);
        room.reconcile_with_pairs(&endpoints, 0, &pairs);
        let picture = room.flows().find(|flow| flow.receiver == viewer).unwrap();
        assert_eq!(picture.sender, source);
        room.flow_state(picture.id, viewer, source, FlowState::Decoded, 1)
            .unwrap();

        for peer in [source, viewer] {
            room.failed_pair(host, peer);
        }
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        assert!(room
            .flows()
            .any(|flow| flow.id == picture.id && flow.proof == Some(FlowState::Decoded)));
        assert_eq!(room.next_route_deadline(), None);

        for peer in [host, viewer] {
            room.set_voice(endpoints[&peer].member, peer, true, false, false)
                .unwrap();
        }
        room.publish(
            endpoints[&host].member,
            host,
            id(20),
            Kind::Voice,
            None,
            None,
        )
        .unwrap();
        room.reconcile_with_pairs(&endpoints, 3, &pairs);
        assert!(!room.flows().any(|flow| flow.publication_id == id(20)));
        let pairs = BTreeSet::from([(source, viewer), (host, viewer)]);
        room.reconcile_with_pairs(&endpoints, 4, &pairs);
        assert!(room.flows().any(|flow| flow.publication_id == id(20)
            && flow.sender == host
            && flow.receiver == viewer));
        assert!(room
            .flows()
            .any(|flow| flow.id == picture.id && flow.proof == Some(FlowState::Decoded)));
    }

    #[test]
    fn physical_recovery_uses_confirmed_pairs_without_a_room_retry_timer() {
        let id = Uuid::from_u128;
        for count in [2, 3] {
            let mut endpoints: BTreeMap<_, _> = (1..=count)
                .map(|n| {
                    (
                        id(n),
                        Endpoint {
                            member: crate::Member { user_id: id(n) },
                            can_use_peer_transport: true,
                            connected: true,
                            signing_key: [0; 32],
                        },
                    )
                })
                .collect();
            let mut room = RoomRuntime::new(
                RoomState::new(
                    "repair".into(),
                    "Repair".into(),
                    Default::default(),
                    id(1),
                    RoomAccess::Public,
                    false,
                    None,
                )
                .unwrap(),
            );
            room.set_writer(id(1), crate::wire::HostingMode::Lightweight);
            for (session, endpoint) in &endpoints {
                room.browse(endpoint.member, *session, true).unwrap();
                room.set_voice(endpoint.member, *session, true, true, false)
                    .unwrap();
            }
            let mut pairs: BTreeSet<_> = (2..=count).map(|n| (id(1), id(n))).collect();
            room.reconcile_with_pairs(&endpoints, 0, &pairs);
            room.publish(
                endpoints[&id(1)].member,
                id(1),
                id(10),
                Kind::Screen,
                screen_settings(),
                Some(crate::wire::ScreenSource::default()),
            )
            .unwrap();
            for n in 2..=count {
                room.subscribe(endpoints[&id(n)].member, id(n), id(10), true, None)
                    .unwrap();
            }
            room.reconcile_with_pairs(&endpoints, 0, &pairs);
            for flow in room.flows().collect::<Vec<_>>() {
                room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                    .unwrap();
            }
            room.reconcile_with_pairs(&endpoints, 1, &pairs);
            let old = room.flows().find(|flow| flow.receiver == id(2)).unwrap();
            let healthy = room.flows().find(|flow| flow.receiver == id(3));
            let preparing = if count == 3 {
                room.publish(
                    endpoints[&id(3)].member,
                    id(3),
                    id(11),
                    Kind::Screen,
                    screen_settings(),
                    Some(crate::wire::ScreenSource::default()),
                )
                .unwrap();
                room.subscribe(endpoints[&id(1)].member, id(1), id(11), true, None)
                    .unwrap();
                room.reconcile_with_pairs(&endpoints, 1, &pairs);
                Some(
                    room.flows()
                        .find(|flow| flow.publication_id == id(11))
                        .unwrap(),
                )
            } else {
                None
            };
            room.failed_pair(id(1), id(2));
            pairs.remove(&(id(1), id(2)));
            if count == 3 {
                pairs.insert((id(2), id(3)));
            }
            room.reconcile_with_pairs(&endpoints, 2, &pairs);
            if count == 3 {
                assert!(room
                    .flows()
                    .any(|flow| flow.sender == id(3) && flow.receiver == id(2)));
                room.failed_pair(id(3), id(2));
                pairs.remove(&(id(2), id(3)));
            }
            room.reconcile_with_pairs(&endpoints, 3, &pairs);
            let independent_deadline = preparing.as_ref().map(|_| 1 + SCREEN_PREPARE_MS);
            assert_eq!(room.next_route_deadline(), independent_deadline);
            room.reconcile_with_pairs(&endpoints, 1_000, &pairs);
            assert_eq!(room.next_route_deadline(), independent_deadline);
            assert!(!room.flows().any(|flow| flow.receiver == id(2)));
            let restored_at = 1_001;
            pairs.insert((id(1), id(2)));
            room.reconcile_with_pairs(&endpoints, restored_at, &pairs);
            let restored = room.flows().find(|flow| flow.receiver == id(2)).unwrap();
            assert_ne!(restored.id, old.id);
            assert_eq!(
                room.next_route_deadline(),
                Some(if preparing.is_some() {
                    1 + SCREEN_PREPARE_MS
                } else {
                    restored_at + SCREEN_PREPARE_MS
                })
            );
            if let Some(healthy) = healthy {
                assert!(room
                    .flows()
                    .any(|flow| flow.id == healthy.id && flow.selected));
            }
            let view = room.snapshot(endpoints[&id(2)].member, id(2)).unwrap();
            assert!(view.room.reading && view.subscriptions.contains(&id(10)));
            assert!(view
                .publications
                .iter()
                .any(|p| p.id == id(10) && p.session_id == id(1)));
            assert_eq!(
                room.flow_state(old.id, id(2), id(1), FlowState::Decoded, restored_at),
                Err("unassigned_flow")
            );
            room.flow_state(restored.id, id(2), id(1), FlowState::Decoded, restored_at + 1)
                .unwrap();
            if let Some(preparing) = preparing {
                assert!(room.flows().any(|flow| flow.id == preparing.id));
                room.flow_state(
                    preparing.id,
                    preparing.receiver,
                    preparing.sender,
                    FlowState::Decoded,
                    restored_at + 1,
                )
                .unwrap();
            }
            room.reconcile_with_pairs(&endpoints, restored_at + 1, &pairs);
            assert_eq!(room.next_route_deadline(), None);
            if count == 2 {
                room.failed_pair(id(1), id(2));
                pairs.remove(&(id(1), id(2)));
                room.reconcile_with_pairs(&endpoints, 10_000, &pairs);
                assert_eq!(room.next_route_deadline(), None);
                endpoints.get_mut(&id(2)).unwrap().connected = false;
                room.reconcile_with_pairs(&endpoints, 10_001, &pairs);
                assert_eq!(room.next_route_deadline(), None);
                endpoints.get_mut(&id(2)).unwrap().connected = true;
                room.reconcile_with_pairs(&endpoints, 10_002, &pairs);
                assert_eq!(room.next_route_deadline(), None);
                room.subscribe(endpoints[&id(2)].member, id(2), id(10), false, None)
                    .unwrap();
                room.browse(endpoints[&id(2)].member, id(2), false).unwrap();
                room.set_voice(endpoints[&id(2)].member, id(2), false, true, false)
                    .unwrap();
                room.reconcile_with_pairs(&endpoints, 10_003, &pairs);
                assert_eq!(
                    room.next_route_deadline(),
                    None,
                    "no demand owns no repair wake"
                );
            }
        }
    }

    #[test]
    fn screen_transfer_requires_the_current_source_and_a_live_same_user_target() {
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_room();
        endpoints.insert(id(5), endpoints[&id(3)].clone());
        let source = endpoints[&id(3)].member;
        assert_eq!(
            room.transfer_source(endpoints[&id(4)].member, id(4), id(10), id(5), &endpoints),
            Err("not_publication_owner")
        );
        assert_eq!(
            room.transfer_source(source, id(3), id(10), id(4), &endpoints),
            Err("forbidden")
        );
        endpoints.get_mut(&id(5)).unwrap().connected = false;
        assert_eq!(
            room.transfer_source(source, id(3), id(10), id(5), &endpoints),
            Err("source_unavailable")
        );
        endpoints.get_mut(&id(5)).unwrap().connected = true;
        endpoints.get_mut(&id(5)).unwrap().member = source;
        room.publish(
            source,
            id(5),
            id(11),
            Kind::Screen,
            screen_settings(),
            Some(crate::wire::ScreenSource::default()),
        )
        .unwrap();
        assert_eq!(
            room.transfer_source(source, id(3), id(10), id(5), &endpoints),
            Err("source_already_published")
        );
        assert_eq!(room.publication(id(10)).unwrap().session_id, id(3));
        assert!(room
            .snapshot(endpoints[&id(4)].member, id(4))
            .unwrap()
            .subscriptions
            .contains(&id(10)));
    }

    #[test]
    fn screen_transfer_preserves_viewer_intent_and_unrelated_voice() {
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_room();
        endpoints.insert(id(5), endpoints[&id(3)].clone());
        let source = endpoints[&id(3)].member;
        room.browse(source, id(5), true).unwrap();
        room.subscribe(source, id(5), id(10), true, None).unwrap();
        for session in [id(3), id(4)] {
            room.set_voice(endpoints[&session].member, session, true, false, false)
                .unwrap();
        }
        room.publish(source, id(3), id(11), Kind::Voice, None, None)
            .unwrap();
        let mut pairs = screen_room_pairs();
        pairs.insert((id(3), id(5)));
        room.reconcile_with_pairs(&endpoints, 4, &pairs);
        let old_screen: BTreeSet<_> = room
            .flows()
            .filter(|flow| flow.publication_id == id(10))
            .map(|flow| flow.id)
            .collect();
        let voice: BTreeSet<_> = room
            .flows()
            .filter(|flow| flow.publication_id == id(11))
            .map(|flow| flow.id)
            .collect();
        assert!(!voice.is_empty());

        room.transfer_source(source, id(3), id(10), id(5), &endpoints)
            .unwrap();
        pairs.insert((id(4), id(5)));
        room.reconcile_with_pairs(&endpoints, 5, &pairs);
        let picture = room.publication(id(10)).unwrap();
        assert_eq!(
            (picture.id, picture.user_id, picture.session_id),
            (id(10), source.user_id, id(5))
        );
        assert!(picture.kind == Kind::Screen);
        assert!(room
            .snapshot(endpoints[&id(4)].member, id(4))
            .unwrap()
            .subscriptions
            .contains(&id(10)));
        assert!(!room
            .snapshot(source, id(5))
            .unwrap()
            .subscriptions
            .contains(&id(10)));

        assert_eq!(
            voice,
            room.flows()
                .filter(|flow| flow.publication_id == id(11))
                .map(|flow| flow.id)
                .collect()
        );
        assert_eq!(room.publication(id(11)).unwrap().session_id, id(3));
        assert!(room
            .flows()
            .filter(|flow| flow.publication_id == id(10))
            .all(|flow| !old_screen.contains(&flow.id)));
        assert!(room.flows().any(|flow| flow.publication_id == id(10)
            && flow.sender == id(5)
            && flow.input_flow_id.is_none()));
        assert_eq!(room.unpublish(id(3), id(10)), Err("not_publication_owner"));
        for (now, watching) in [(6, false), (7, true)] {
            room.subscribe(endpoints[&id(4)].member, id(4), id(10), watching, None)
                .unwrap();
            room.reconcile_with_pairs(&endpoints, now, &pairs);
            assert_eq!(
                room.flows().any(|flow| flow.publication_id == id(10)),
                watching
            );
            assert_eq!(
                voice,
                room.flows()
                    .filter(|flow| flow.publication_id == id(11))
                    .map(|flow| flow.id)
                    .collect()
            );
        }
        room.unpublish(id(5), id(10)).unwrap();
        room.reconcile_with_pairs(&endpoints, 8, &pairs);
        assert_eq!(voice, room.flows().map(|flow| flow.id).collect());
    }

    #[test]
    fn same_endpoint_source_change_preserves_proven_paths_and_retires_old_preparation() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_room();
        let mut pairs = screen_room_pairs();
        let source = endpoints[&id(3)].member;
        let before: BTreeMap<_, _> = room
            .flows()
            .map(|flow| ((flow.sender, flow.receiver), flow.id))
            .collect();
        room.flow_state(
            before[&(id(3), id(1))],
            id(1),
            id(3),
            FlowState::Forwardable,
            1,
        )
        .unwrap();
        room.reconcile_with_pairs(&endpoints, 1, &pairs);
        room.transfer_source(source, id(3), id(10), id(3), &endpoints)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 2, &pairs);
        let after: BTreeMap<_, _> = room
            .flows()
            .map(|flow| ((flow.sender, flow.receiver), flow.id))
            .collect();
        assert_eq!(before[&(id(3), id(1))], after[&(id(3), id(1))]);
        assert_ne!(before[&(id(1), id(2))], after[&(id(1), id(2))]);
        assert_ne!(before[&(id(2), id(4))], after[&(id(2), id(4))]);
        assert_eq!(room.next_route_deadline(), Some(2 + SCREEN_PREPARE_MS));
        assert_eq!(
            room.flow_state(before[&(id(1), id(2))], id(2), id(1), FlowState::Decoded, 3),
            Err("unassigned_flow")
        );

        pairs.insert((id(2), id(3)));
        for now in 4..=6 {
            let selected: Vec<_> = room.flows().filter(|flow| flow.selected).collect();
            for flow in selected {
                room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, now)
                    .unwrap();
            }
            room.reconcile_with_pairs(&endpoints, now, &pairs);
        }
        let selected: BTreeSet<_> = room
            .flows()
            .filter(|flow| flow.selected)
            .map(|flow| flow.id)
            .collect();
        let trial: Vec<_> = room.flows().filter(|flow| !flow.selected).collect();
        assert!(!trial.is_empty());
        room.transfer_source(source, id(3), id(10), id(3), &endpoints)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 7, &pairs);
        assert_eq!(
            selected,
            room.flows()
                .filter(|flow| flow.selected)
                .map(|flow| flow.id)
                .collect()
        );
        for flow in trial {
            assert_eq!(
                room.flow_state(
                    flow.id,
                    flow.receiver,
                    flow.sender,
                    FlowState::SwitchReady,
                    8
                ),
                Err("unassigned_flow")
            );
        }
    }

    #[test]
    fn media_preparation_waits_for_the_upstream_without_extending_its_own_deadline() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_room();
        let mut pairs = screen_room_pairs();
        let publication = id(10);
        let flows: BTreeMap<_, _> = room
            .flows()
            .map(|flow| ((flow.sender, flow.receiver), flow.id))
            .collect();
        assert_eq!(
            flows.keys().copied().collect::<BTreeSet<_>>(),
            BTreeSet::from([(id(3), id(1)), (id(1), id(2)), (id(2), id(4))])
        );
        assert_eq!(room.next_route_deadline(), Some(SCREEN_PREPARE_MS));
        room.reconcile_with_pairs(&endpoints, 10_000, &pairs);
        assert_eq!(room.next_route_deadline(), Some(SCREEN_PREPARE_MS));

        room.flow_state(
            flows[&(id(3), id(1))],
            id(1),
            id(3),
            FlowState::Forwardable,
            19_000,
        )
        .unwrap();
        room.reconcile_with_pairs(&endpoints, 19_000, &pairs);
        assert_eq!(room.next_route_deadline(), Some(39_000));
        assert!(!room.expire_media(20_000));

        room.flow_state(
            flows[&(id(1), id(2))],
            id(2),
            id(1),
            FlowState::Forwardable,
            38_000,
        )
        .unwrap();
        room.reconcile_with_pairs(&endpoints, 38_000, &pairs);
        assert_eq!(room.next_route_deadline(), Some(58_000));
        assert!(!room.expire_media(39_000));
        assert!(room.expire_media(58_000));
        pairs.insert((id(3), id(4)));
        room.reconcile_with_pairs(&endpoints, 58_000, &pairs);
        assert!(room.flows().all(|flow| flow.id != flows[&(id(2), id(4))]));
        assert!(room
            .flows()
            .any(|flow| flow.sender == id(3) && flow.receiver == id(4)));

        assert_eq!(room.next_route_deadline(), Some(78_000));

        room.subscribe(endpoints[&id(4)].member, id(4), publication, false, None)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 60_000, &pairs);
        assert!(room.flows().next().is_none());
        assert_eq!(room.next_route_deadline(), None);
        assert!(!room.expire_media(78_000));
    }

    fn branch_candidate(
        relay_watching: bool,
    ) -> (
        RoomRuntime,
        BTreeMap<Uuid, Endpoint>,
        BTreeSet<(Uuid, Uuid)>,
        Vec<Flow>,
        Vec<Flow>,
    ) {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_room();
        let mut pairs = screen_room_pairs();
        room.subscribe(endpoints[&id(1)].member, id(1), id(10), true, None)
            .unwrap();
        room.subscribe(
            endpoints[&id(2)].member,
            id(2),
            id(10),
            relay_watching,
            None,
        )
        .unwrap();
        // Room voice retains the same physical pairs during the screen change.
        for session in [id(3), id(4)] {
            room.set_voice(endpoints[&session].member, session, true, false, false)
                .unwrap();
        }
        room.publish(
            endpoints[&id(3)].member,
            id(3),
            id(11),
            Kind::Voice,
            None,
            None,
        )
        .unwrap();
        room.reconcile_with_pairs(&endpoints, 0, &pairs);
        let picture: Vec<_> = room
            .flows()
            .filter(|f| f.publication_id == id(10))
            .collect();
        for flow in &picture {
            room.flow_state(
                flow.id,
                flow.receiver,
                flow.sender,
                FlowState::Forwardable,
                1_000,
            )
            .unwrap();
        }
        room.reconcile_with_pairs(&endpoints, 1_000, &pairs);
        assert!(
            room.flows().all(|f| f.selected),
            "watchers need an actual decoded baseline"
        );
        for flow in picture
            .iter()
            .filter(|f| f.receiver != id(2) || relay_watching)
        {
            room.flow_state(
                flow.id,
                flow.receiver,
                flow.sender,
                FlowState::Decoded,
                2_000,
            )
            .unwrap();
        }
        pairs.insert((id(2), id(3)));
        room.reconcile_with_pairs(&endpoints, 2_000, &pairs);
        let shadow: Vec<_> = room.flows().filter(|f| !f.selected).collect();
        assert_eq!(
            shadow
                .iter()
                .map(|f| (f.sender, f.receiver))
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([(id(3), id(2)), (id(2), id(4))])
        );
        let root = shadow.iter().find(|f| f.receiver == id(2)).unwrap();
        let child = shadow.iter().find(|f| f.receiver == id(4)).unwrap();
        assert_eq!(root.input_flow_id, None);
        assert_eq!(child.input_flow_id, Some(root.id));
        assert_eq!(room.next_route_deadline(), Some(22_000));
        (room, endpoints, pairs, picture, shadow)
    }

    #[test]
    fn screen_audience_follows_watch_intent_and_current_decoded_proof() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_room();
        let audience = |room: &RoomRuntime, recipient| {
            room.snapshot(endpoints[&recipient].member, recipient)
                .unwrap()
                .publications
                .into_iter()
                .find(|publication| publication.id == id(10))
                .unwrap()
                .audience
        };
        let preparing = vec![PublicationAudience {
            session_id: id(4),
            state: AudienceState::Preparing,
        }];
        assert_eq!(audience(&room, id(3)), preparing);
        assert_eq!(audience(&room, id(4)), preparing);
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(
                flow.id,
                flow.receiver,
                flow.sender,
                FlowState::Forwardable,
                1,
            )
            .unwrap();
        }
        assert_eq!(audience(&room, id(3)), preparing);
        let flow = room.flows().find(|flow| flow.receiver == id(4)).unwrap();
        room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 2)
            .unwrap();
        let active = vec![PublicationAudience {
            session_id: id(4),
            state: AudienceState::Active,
        }];
        assert_eq!(audience(&room, id(3)), active);
        assert_eq!(audience(&room, id(4)), active);
        // Reading/voice/forwarding never turn an endpoint into a screen watcher.
        assert!(room.reading(id(2)) && room.voice_joined(id(2)));
        room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Failed, 3)
            .unwrap();
        assert_eq!(audience(&room, id(3))[0].state, AudienceState::Failed);

        let (mut room, mut endpoints, pairs, _, _) = branch_candidate(false);
        let viewer = endpoints[&id(4)].member;
        let expected = vec![
            PublicationAudience {
                session_id: id(1),
                state: AudienceState::Active,
            },
            PublicationAudience {
                session_id: id(4),
                state: AudienceState::Active,
            },
        ];
        let snapshot = |room: &RoomRuntime| room.snapshot(viewer, id(4)).unwrap();
        assert_eq!(snapshot(&room).publications[0].audience, expected);
        assert!(snapshot(&room).publications[1].audience.is_empty());
        // The relay's prepared shadow does not replace a decoded incumbent or add a person.
        endpoints.get_mut(&id(4)).unwrap().connected = false;
        room.reconcile_with_pairs(&endpoints, 2_001, &pairs);
        assert_eq!(snapshot(&room).publications[0].audience, expected);
        endpoints.remove(&id(4));
        room.reconcile_with_pairs(&endpoints, 2_002, &pairs);
        assert_eq!(snapshot(&room).publications[0].audience, expected[..1]);
    }

    #[test]
    fn internal_branch_waits_for_all_viewers_then_adopts_the_entire_warmed_lineage() {
        let id = Uuid::from_u128;
        for relay_watching in [false, true] {
            let (mut room, endpoints, pairs, old, shadow) = branch_candidate(relay_watching);
            let voice: BTreeSet<_> = room
                .flows()
                .filter(|f| f.publication_id == id(11))
                .map(|f| f.id)
                .collect();
            let relay = shadow.iter().find(|f| f.receiver == id(2)).unwrap();
            let viewer = shadow.iter().find(|f| f.receiver == id(4)).unwrap();
            assert!(!room
                .flow_state(
                    viewer.id,
                    viewer.receiver,
                    viewer.sender,
                    FlowState::SwitchReady,
                    3_000
                )
                .unwrap());
            assert_eq!(room.next_route_deadline(), Some(22_000));
            assert!(old
                .iter()
                .all(|old| room.flows().any(|f| f.id == old.id && f.selected)));
            if relay_watching {
                assert!(!room
                    .flow_state(
                        relay.id,
                        relay.receiver,
                        relay.sender,
                        FlowState::Decoded,
                        4_000
                    )
                    .unwrap());
            }
            assert!(room
                .flow_state(
                    relay.id,
                    relay.receiver,
                    relay.sender,
                    if relay_watching {
                        FlowState::SwitchReady
                    } else {
                        FlowState::Forwardable
                    },
                    4_000
                )
                .unwrap());
            room.reconcile_with_pairs(&endpoints, 4_000, &pairs);
            let screens: Vec<_> = room
                .flows()
                .filter(|f| f.publication_id == id(10))
                .collect();
            assert_eq!(screens.len(), 3);
            assert!(screens.iter().all(|f| f.selected));
            for warm in &shadow {
                let adopted = screens.iter().find(|f| f.id == warm.id).unwrap();
                assert_eq!(
                    adopted.input_flow_id, warm.input_flow_id,
                    "commit never rebinds the warm sender"
                );
            }
            for retired in old.iter().filter(|f| f.receiver != id(1)) {
                assert_eq!(
                    room.flow_state(
                        retired.id,
                        retired.receiver,
                        retired.sender,
                        FlowState::Failed,
                        5_000
                    ),
                    Err("unassigned_flow")
                );
            }
            assert_eq!(room.next_route_deadline(), None);
            assert_eq!(
                room.flows()
                    .filter(|f| f.publication_id == id(11))
                    .map(|f| f.id)
                    .collect::<BTreeSet<_>>(),
                voice
            );
        }
    }
    #[test]
    fn failed_or_expired_shadow_preserves_the_committed_branch_and_attempt_lifetime() {
        let id = Uuid::from_u128;
        for timeout in [false, true] {
            let (mut room, endpoints, pairs, old, shadow) = branch_candidate(true);
            let viewer = shadow.iter().find(|f| f.receiver == id(4)).unwrap();
            if timeout {
                assert!(room.expire_media(22_000));
            } else {
                assert!(room
                    .flow_state(
                        viewer.id,
                        viewer.receiver,
                        viewer.sender,
                        FlowState::Failed,
                        21_999
                    )
                    .unwrap());
            }
            room.reconcile_with_pairs(&endpoints, 22_000, &pairs);
            assert!(old
                .iter()
                .all(|old| room.flows().any(|f| f.id == old.id && f.selected)));
            assert!(shadow
                .iter()
                .all(|old| !room.flows().any(|f| f.id == old.id)));
            for receiver in [id(1), id(2), id(4)] {
                assert_eq!(
                    serde_json::to_value(
                        room.snapshot(endpoints[&receiver].member, receiver)
                            .unwrap()
                    )
                    .unwrap()["failedSubscriptions"],
                    serde_json::json!([]),
                    "an optional candidate does not fail its healthy incumbent"
                );
            }
            // A different target may be attempted, but toggling local watching
            // cannot reset the relay's consumed source-path attempt.
            room.subscribe(endpoints[&id(2)].member, id(2), id(10), false, None)
                .unwrap();
            room.reconcile_with_pairs(&endpoints, 23_000, &pairs);
            room.subscribe(endpoints[&id(2)].member, id(2), id(10), true, None)
                .unwrap();
            room.reconcile_with_pairs(&endpoints, 24_000, &pairs);
            assert!(!room.flows().any(|f| !f.selected && f.receiver == id(2)));
        }
    }

    #[test]
    fn branch_proofs_refresh_independently_and_decoded_withdraws_only_its_permission() {
        let id = Uuid::from_u128;
        for withdrawal in [false, true] {
            let (mut room, endpoints, pairs, old, shadow) = branch_candidate(true);
            let relay = shadow.iter().find(|f| f.receiver == id(2)).unwrap();
            let viewer = shadow.iter().find(|f| f.receiver == id(4)).unwrap();
            room.flow_state(
                relay.id,
                relay.receiver,
                relay.sender,
                FlowState::SwitchReady,
                3_000,
            )
            .unwrap();
            assert_eq!(
                room.next_route_deadline(),
                Some(22_000),
                "first approval cannot consume another viewer's preparation time"
            );
            let pending_at = if withdrawal {
                room.flow_state(
                    relay.id,
                    relay.receiver,
                    relay.sender,
                    FlowState::Decoded,
                    4_000,
                )
                .unwrap();
                assert_eq!(
                    room.flows()
                        .find(|flow| flow.id == relay.id)
                        .unwrap()
                        .presented,
                    Some(false)
                );
                4_100
            } else {
                // This is a fresh observation, not a replay of the first approval.
                room.flow_state(
                    relay.id,
                    relay.receiver,
                    relay.sender,
                    FlowState::SwitchReady,
                    7_999,
                )
                .unwrap();
                assert_eq!(room.next_route_deadline(), Some(22_000));
                12_999 // Exactly five seconds: the refreshed proof is stale.
            };
            room.flow_state(
                viewer.id,
                viewer.receiver,
                viewer.sender,
                FlowState::SwitchReady,
                pending_at,
            )
            .unwrap();
            room.reconcile_with_pairs(&endpoints, pending_at, &pairs);
            assert!(old
                .iter()
                .all(|old| room.flows().any(|f| f.id == old.id && f.selected)));
            assert!(
                shadow
                    .iter()
                    .all(|old| room.flows().any(|f| f.id == old.id && !f.selected)),
                "a stale or withdrawn permission does not expire the operation"
            );
            room.flow_state(
                relay.id,
                relay.receiver,
                relay.sender,
                FlowState::SwitchReady,
                pending_at + 100,
            )
            .unwrap();
            assert!(shadow
                .iter()
                .all(|warm| room.flows().any(|f| f.id == warm.id && f.selected)));
            assert_eq!(room.next_route_deadline(), None);
        }
    }

    #[test]
    fn watching_changes_cancel_shadow_consumers_without_changing_transit() {
        let id = Uuid::from_u128;
        let (mut room, endpoints, pairs, old, shadow) = branch_candidate(true);
        let relay = shadow.iter().find(|f| f.receiver == id(2)).unwrap();
        room.flow_state(
            relay.id,
            relay.receiver,
            relay.sender,
            FlowState::SwitchReady,
            3_000,
        )
        .unwrap();
        room.subscribe(endpoints[&id(2)].member, id(2), id(10), false, None)
            .unwrap();
        room.reconcile_with_pairs(&endpoints, 4_000, &pairs);
        assert!(old
            .iter()
            .all(|old| room.flows().any(|f| f.id == old.id && f.selected)));
        assert!(shadow
            .iter()
            .all(|old| !room.flows().any(|f| f.id == old.id)));
    }

    #[test]
    fn incumbent_loss_replaces_the_whole_input_lineage_before_ordinary_media_repair() {
        let id = Uuid::from_u128;
        let (mut room, endpoints, pairs, old, shadow) = branch_candidate(true);
        let relay = old.iter().find(|f| f.receiver == id(2)).unwrap();
        room.flow_state(
            relay.id,
            relay.receiver,
            relay.sender,
            FlowState::Failed,
            3_000,
        )
        .unwrap();
        let candidate = shadow.iter().find(|f| f.receiver == id(2)).unwrap();
        assert!(!room
            .flow_state(
                candidate.id,
                candidate.receiver,
                candidate.sender,
                FlowState::SwitchReady,
                3_000
            )
            .unwrap());
        room.reconcile_with_pairs(&endpoints, 3_000, &pairs);
        let screens: Vec<_> = room
            .flows()
            .filter(|f| f.publication_id == id(10))
            .collect();
        assert!(screens.iter().all(|f| f.selected));
        for receiver in [id(2), id(4)] {
            let replacement = screens.iter().find(|f| f.receiver == receiver).unwrap();
            assert!(
                !old.iter().chain(&shadow).any(|f| f.id == replacement.id),
                "changed input means new lease even on an unchanged edge"
            );
        }
        let input = screens.iter().find(|f| f.receiver == id(2)).unwrap();
        let output = screens.iter().find(|f| f.receiver == id(4)).unwrap();
        assert_eq!(output.input_flow_id, Some(input.id));
        assert_eq!(room.next_route_deadline(), Some(23_000));
    }

    #[test]
    fn room_projection_obeys_private_access_before_exposing_activity() {
        let owner = Member {
            user_id: Uuid::new_v4(),
        };
        let viewer = Member {
            user_id: Uuid::new_v4(),
            ..owner
        };
        let owner_session = Uuid::new_v4();
        let viewer_session = Uuid::new_v4();
        let reader_session = Uuid::new_v4();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "private".into(),
                "Friends".into(),
                Default::default(),
                owner.user_id,
                RoomAccess::Private,
                false,
                None,
            )
            .unwrap(),
        );
        room.policy.grants.insert(viewer.user_id);
        room.browse(viewer, reader_session, true).unwrap();
        let picture = Uuid::new_v4();
        let voice = Uuid::new_v4();
        room.publish(
            owner,
            owner_session,
            picture,
            Kind::Screen,
            screen_settings(),
            Some(crate::wire::ScreenSource::default()),
        )
        .unwrap();
        room.set_voice(owner, owner_session, true, false, false)
            .unwrap();
        room.publish(owner, owner_session, voice, Kind::Voice, None, None)
            .unwrap();
        room.set_voice(viewer, viewer_session, true, false, false)
            .unwrap();
        room.subscribe(viewer, viewer_session, picture, true, None)
            .unwrap();

        let admitted = room.snapshot(viewer, viewer_session).unwrap();
        assert!(admitted.room.authorized);
        assert!(admitted.room.capabilities.history_seek);
        let projection = room.project(BTreeMap::from([(
            viewer_session,
            room.recipient(viewer, viewer_session, true, |_| false).unwrap(),
        )]));
        assert!(
            !projection
                .snapshot(viewer_session, false)
                .unwrap()
                .room
                .capabilities
                .history_seek
        );
        assert_eq!(
            admitted
                .room
                .participant_session_ids
                .into_iter()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([owner_session, viewer_session, reader_session])
        );
        assert_eq!(admitted.publications.len(), 2);
        assert_eq!(
            admitted
                .publications
                .iter()
                .find(|p| p.id == picture)
                .unwrap()
                .audience,
            vec![PublicationAudience {
                session_id: viewer_session,
                state: AudienceState::Preparing
            }]
        );
        assert_eq!(
            serde_json::to_value(&admitted.publications).unwrap(),
            serde_json::to_value(&room.snapshot(owner, owner_session).unwrap().publications)
                .unwrap()
        );
        assert_eq!(admitted.voice.len(), 2);
        assert_eq!(
            admitted.subscriptions.into_iter().collect::<BTreeSet<_>>(),
            BTreeSet::from([picture, voice]),
        );

        room.revoke(owner, viewer).unwrap();
        room.reconcile(
            &[(owner_session, owner), (viewer_session, viewer)]
                .into_iter()
                .map(|(session, member)| {
                    (
                        session,
                        Endpoint {
                            member,
                            can_use_peer_transport: true,
                            connected: true,
                            signing_key: [0; 32],
                        },
                    )
                })
                .collect(),
            0,
        );
        let locked = room.snapshot(viewer, viewer_session).unwrap();
        assert!(!locked.room.authorized);
        assert!(!locked.room.capabilities.history_seek);
        assert!(!locked.room.can_manage);
        assert!(locked.room.participant_session_ids.is_empty());
        assert!(locked.room.file_activity.is_empty());
        assert!(locked.publications.is_empty());
        assert!(locked.voice.is_empty());
        assert!(locked.subscriptions.is_empty());

        room.update(
            owner,
            "Friends".into(),
            Default::default(),
            RoomAccess::Private,
            true,
            None,
            None,
        )
        .unwrap();
        assert!(room.snapshot(viewer, viewer_session).is_none());
        let own = room.snapshot(owner, owner_session).unwrap();
        assert!(own.room.authorized && own.room.can_manage);
        assert_eq!(own.publications.len(), 2);
        assert!(own
            .publications
            .iter()
            .all(|publication| publication.audience.is_empty()));
    }
}
