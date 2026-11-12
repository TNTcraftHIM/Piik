use crate::{
    access::{RoomPermission, RoomState},
    history::{HistoryRequest, MessageDraft},
    identity::{Endpoint, Member},
    publication::Publication,
    routes::{BaseTree, RelayLimits},
    transport::{BaseLink, Flow},
    wire::{
        validate_video_settings, AudienceState, FlowState, Kind, PublicationAudience,
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
    reading: bool,
    watching: BTreeMap<Uuid, Option<Uuid>>,
    voice: Option<VoiceInfo>,
    relay_capacity: Option<u8>,
    next_interaction_at: u64,
}

/// One room owns its policy, activities and logical flows. It neither owns
/// domain identities nor creates physical peer connections.
#[derive(Clone)]
pub struct RoomRuntime {
    pub(crate) last_message_seq: u64,
    policy: RoomState,
    activity: BTreeMap<Uuid, Activity>,
    publications: BTreeMap<Uuid, Publication>,
    base: Option<BaseTree>,
    repair_at: Option<u64>,
    files: crate::file_room::FileRoom,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
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
    pub authorized: bool,
    pub can_manage: bool,
    pub reading: bool,
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
            base: None,
            repair_at: None,
            files: Default::default(),
        }
    }

    pub fn policy(&self) -> &RoomState {
        &self.policy
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
        let view = self.recipient(member, session)?;
        self.project(BTreeMap::from([(session, view)]))
            .snapshot(session, true)
    }

    pub(crate) fn projection(
        &self,
        endpoints: &BTreeMap<Uuid, Endpoint>,
    ) -> crate::host::RoomProjection {
        self.project(
            endpoints
                .iter()
                .filter_map(|(session, endpoint)| {
                    self.recipient(endpoint.member, *session)
                        .map(|view| (*session, view))
                })
                .collect(),
        )
    }

    fn recipient(&self, member: Member, session: Uuid) -> Option<RoomRecipient> {
        let room = self.policy.view(member.user_id)?;
        let subscriptions = if room.authorized {
            self.subscriptions(session).into_iter().collect::<Vec<_>>()
        } else {
            vec![]
        };
        Some(RoomRecipient {
            authorized: room.authorized,
            can_manage: room.can_manage,
            members: room.members,
            reading: room.authorized && self.reading(session),
            relay_override: self
                .activity
                .get(&session)
                .and_then(|activity| activity.relay_capacity),
            files: if room.authorized {
                self.base
                    .as_ref()
                    .map(|base| self.files.plans(&self.policy.id, session, base))
                    .unwrap_or_default()
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
        crate::host::RoomProjection {
            last_message_seq: self.last_message_seq,
            summary: crate::host::RoomSummary::from_policy(&self.policy),
            capabilities: crate::wire::RoomCapabilities {
                attachments: self.base.is_some(),
            },
            participant_session_ids: self
                .media_sessions()
                .into_iter()
                .chain(
                    self.activity
                        .iter()
                        .filter_map(|(session, activity)| activity.reading.then_some(*session)),
                )
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
            base_links: self.base_links().collect(),
        }
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
        if capacity.is_some_and(|capacity| capacity > 20) {
            return Err("invalid_relay_capacity");
        }
        self.activity.entry(session).or_default().relay_capacity = capacity;
        Ok(())
    }

    fn relay_limits(&self) -> RelayLimits {
        RelayLimits {
            default: self.policy.relay_capacity as usize,
            host: self.base.as_ref().map_or(Uuid::nil(), BaseTree::root),
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

    pub fn set_host_session(&mut self, session: Uuid) {
        if self.base.as_ref().is_none_or(|base| base.root() != session) {
            self.base = Some(BaseTree::new(session));
        }
    }
    pub fn attachments_available(&self) -> bool {
        self.base.is_some()
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
        attachment: crate::AttachmentDescriptor,
        offer: bool,
        enabled: bool,
    ) -> Result<(), &'static str> {
        if enabled {
            self.files.install(session, seq, attachment, offer)
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
        self.activity.entry(session).or_default().reading = active;
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
            ReactionTarget::Message { message_seq } if *message_seq == 0 => {
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
        icon: crate::wire::IdentityIcon,
        access: RoomAccess,
        hidden: bool,
        password: Option<Option<String>>,
        voice_bitrate: Option<u32>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        if voice_bitrate.is_some_and(|bitrate| !crate::access::valid_audio_bitrate(bitrate)) {
            return Err("invalid_audio_bitrate");
        }
        self.policy.update(name, icon, access, hidden, password)?;
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
        Ok(true)
    }

    pub fn set_title(
        &mut self,
        session: Uuid,
        id: Uuid,
        title: Option<String>,
    ) -> Result<(), &'static str> {
        let publication = self
            .publications
            .get_mut(&id)
            .ok_or("publication_unavailable")?;
        if publication.info.session_id != session {
            return Err("not_publication_owner");
        }
        let screen = publication
            .info
            .screen
            .as_mut()
            .ok_or("invalid_screen_publication")?;
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
            .filter(|endpoint| endpoint.connected)
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
        let publication = self
            .publications
            .get(&id)
            .ok_or("publication_unavailable")?;
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
                    if !endpoint.connected {
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
        self.activity.remove(&session);
    }

    pub fn reconcile(&mut self, endpoints: &BTreeMap<Uuid, Endpoint>, now: u64) {
        let limits = self.relay_limits();
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
        self.files.reconcile(&readable);
        self.publications
            .retain(|_, publication| readable.contains(&publication.info.session_id));
        self.activity
            .retain(|session, _| readable.contains(session));
        for activity in self.activity.values_mut() {
            activity
                .watching
                .retain(|id, _| self.publications.contains_key(id));
            for helper in activity.watching.values_mut() {
                if helper.is_some_and(|id| !readable.contains(&id)) {
                    *helper = None;
                }
            }
        }
        let requested: BTreeMap<_, _> = self
            .activity
            .keys()
            .map(|session| (*session, self.subscriptions(*session)))
            .collect();
        let connected = endpoints
            .iter()
            .filter_map(|(session, endpoint)| {
                (endpoint.connected && readable.contains(session)).then_some(*session)
            })
            .collect();
        let mut demand = self.media_sessions();
        if let Some(base) = &mut self.base {
            demand.extend(self.files.demand());
            if repair_due {
                base.retry_required(&demand, &connected);
            }
            base.reconcile(&demand, &readable, &connected, &limits, now);
        }
        for (id, publication) in &mut self.publications {
            publication.retain_sessions(endpoints);
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
            publication.reconcile(
                &subscribers,
                &readable,
                &connected,
                self.base.as_ref(),
                &helpers,
                &limits,
                now,
            );
            needs_repair |= publication.needs_repair(&subscribers, &connected);
        }
        self.prepare_base(&requested);
        if self.base.as_ref().is_some_and(BaseTree::candidate_ready)
            && self.publications.values().all(Publication::base_ready)
        {
            self.base.as_mut().unwrap().commit();
            for (id, publication) in &mut self.publications {
                publication.commit_base();
                if publication.info.kind == Kind::Voice {
                    let subscribers = requested
                        .iter()
                        .filter_map(|(session, ids)| ids.contains(id).then_some(*session))
                        .collect();
                    publication.reconcile(
                        &subscribers,
                        &readable,
                        &connected,
                        self.base.as_ref(),
                        &BTreeMap::new(),
                        &limits,
                        now,
                    );
                }
            }
        }
        // The final base ACK can make a cached copy reachable in this same turn.
        if self
            .base
            .as_ref()
            .is_some_and(|base| self.files.select_ready_sources(base))
        {
            demand = self.media_sessions();
            demand.extend(self.files.demand());
            self.base
                .as_mut()
                .unwrap()
                .reconcile(&demand, &readable, &connected, &limits, now);
            self.prepare_base(&requested);
        }
        needs_repair |= self
            .base
            .as_ref()
            .is_some_and(|base| base.needs_repair(&demand, &connected));
        if needs_repair {
            self.repair_at
                .get_or_insert(now.saturating_add(REQUIRED_REPAIR_MS));
        } else {
            self.repair_at = None;
        }
    }

    fn prepare_base(&mut self, requested: &BTreeMap<Uuid, BTreeSet<Uuid>>) {
        if let Some(candidate) = self.base.as_ref().and_then(BaseTree::candidate_tree) {
            let deadline = self.base.as_ref().unwrap().deadline().unwrap();
            for (id, publication) in &mut self.publications {
                let subscribers = requested
                    .iter()
                    .filter_map(|(session, ids)| ids.contains(id).then_some(*session))
                    .collect();
                publication.prepare_base(&candidate, &subscribers, deadline);
            }
        } else {
            for publication in self.publications.values_mut() {
                publication.abort_base();
            }
        }
    }

    pub fn next_route_deadline(&self) -> Option<u64> {
        self.publications
            .values()
            .filter_map(Publication::deadline)
            .chain(self.base.as_ref().and_then(BaseTree::deadline))
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

    pub fn base_links(&self) -> impl Iterator<Item = BaseLink> + '_ {
        self.base
            .iter()
            .flat_map(|base| base.links())
            .map(|(parent, child)| BaseLink {
                room_id: self.policy.id.clone(),
                parent,
                child,
                ready: self.base.as_ref().is_some_and(|base| base.ready(child)),
                selected: true,
            })
            .chain(self.base.iter().flat_map(|base| {
                base.candidate_links()
                    .into_iter()
                    .map(|(parent, child)| BaseLink {
                        room_id: self.policy.id.clone(),
                        parent,
                        child,
                        ready: base.candidate_ready(),
                        selected: false,
                    })
            }))
    }
    pub fn base_state(
        &mut self,
        endpoint: Uuid,
        peer: Uuid,
        ready: bool,
    ) -> Result<bool, &'static str> {
        Ok(self
            .base
            .as_mut()
            .ok_or("base_unavailable")?
            .state(endpoint, peer, ready))
    }

    pub fn failed_pair(&mut self, first: Uuid, second: Uuid) {
        if let Some(base) = &mut self.base {
            base.failed(first, second);
        }
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
        let base_flow = publication.base_flow(flow_id);
        let changed = publication.flow_state(flow_id, receiver, sender, state, now);
        if base_flow && state == FlowState::Failed {
            if let Some(base) = &mut self.base {
                base.abort();
            }
            for publication in self.publications.values_mut() {
                publication.abort_base();
            }
        }
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
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
    fn assisted_viewing_prepares_native_transit_and_preserves_the_viewer_branch() {
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_on_room_base();
        let viewer = endpoints[&id(2)].member;
        endpoints.insert(
            id(5),
            Endpoint {
                signing_key: [5; 32],
                member: viewer,
                connected: true,
            },
        );
        room.subscribe(viewer, id(2), id(10), true, None).unwrap();
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                .unwrap();
        }
        let old: BTreeMap<_, _> = room.flows().map(|flow| (flow.receiver, flow)).collect();
        let command = serde_json::from_value(serde_json::json!({
            "type": "subscribe", "publicationId": id(10), "enabled": true, "helperSessionId": id(5),
        }))
        .unwrap();
        room.command(viewer, id(2), command, &endpoints).unwrap();
        room.reconcile(&endpoints, 2);
        assert!(room
            .snapshot(viewer, id(2))
            .unwrap()
            .room
            .realtime_session_ids
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
        room.reconcile(&endpoints, 4);
        assert!(room
            .snapshot(viewer, id(2))
            .unwrap()
            .room
            .realtime_session_ids
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
        room.reconcile(&endpoints, 5);
        assert!(!room.flows().any(|flow| flow.receiver == id(2)));
        assert!(room
            .flows()
            .any(|flow| flow.sender == id(5) && flow.receiver == id(4) && flow.selected));
    }

    #[test]
    fn assisted_viewing_replaces_unproved_inputs_without_waiting_for_the_old_path() {
        let id = Uuid::from_u128;
        for playing in [false, true] {
            let (mut room, mut endpoints) = screen_on_room_base();
            let viewer = endpoints[&id(2)].member;
            endpoints.insert(
                id(5),
                Endpoint {
                    signing_key: [5; 32],
                    member: viewer,
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
            room.reconcile(&endpoints, 2);
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
            room.reconcile(&endpoints, 5);
            assert!(candidate
                .values()
                .all(|new| room.flows().any(|flow| flow.id == new.id && flow.selected)));
            assert!(!room.flows().any(|flow| flow.sender == id(2)));
        }
    }

    #[test]
    fn assisted_viewing_failure_preserves_the_incumbent_without_repeating_the_choice() {
        let id = Uuid::from_u128;
        for failure in 0..3 {
            let (mut room, mut endpoints) = screen_on_room_base();
            let viewer = endpoints[&id(2)].member;
            endpoints.insert(
                id(5),
                Endpoint {
                    signing_key: [5; 32],
                    member: viewer,
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
            room.reconcile(&endpoints, 2);
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
                _ => room.failed_pair(local.sender, local.receiver),
            }
            for now in [20_003, 25_003, 30_003] {
                room.reconcile(&endpoints, now);
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
    fn assisted_viewing_authority_and_intent_retire_with_the_existing_activity() {
        use crate::wire::Command;
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_on_room_base();
        let viewer = endpoints[&id(2)].member;
        endpoints.insert(
            id(5),
            Endpoint {
                signing_key: [5; 32],
                member: viewer,
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
        room.reconcile(&endpoints, 1);
        endpoints.get_mut(&id(5)).unwrap().connected = false;
        room.reconcile(&endpoints, 2);
        assert_eq!(
            room.activity[&id(2)].watching[&id(10)],
            Some(id(5)),
            "temporary signaling loss retains the existing authority window"
        );
        endpoints.remove(&id(5));
        room.reconcile(&endpoints, 3);
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
        room.reconcile(&endpoints, 4);
        assert!(room.subscriptions(id(2)).is_empty());

        // A room grant belongs to the user, including its approved helper.
        endpoints.insert(
            id(5),
            Endpoint {
                signing_key: [5; 32],
                member: viewer,
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
        room.reconcile(&endpoints, 5);
        room.revoke(owner, viewer).unwrap();
        room.reconcile(&endpoints, 6);
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

    fn screen_on_room_base() -> (RoomRuntime, BTreeMap<Uuid, Endpoint>) {
        let id = Uuid::from_u128;
        let endpoints: BTreeMap<_, _> = (1..=4)
            .map(|value| {
                (
                    id(value),
                    Endpoint {
                        signing_key: [value as u8; 32],
                        member: Member { user_id: id(value) },
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
        room.set_host_session(id(1));
        for (session, endpoint) in &endpoints {
            room.browse(endpoint.member, *session, true).unwrap();
            room.set_voice(endpoint.member, *session, true, true, false)
                .unwrap();
        }
        for _ in 0..2 {
            room.reconcile(&endpoints, 0);
            let links: Vec<_> = room.base_links().collect();
            for link in links {
                room.base_state(link.parent, link.child, true).unwrap();
                room.base_state(link.child, link.parent, true).unwrap();
            }
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
        room.reconcile(&endpoints, 0);
        (room, endpoints)
    }

    #[test]
    fn ready_file_copy_retires_unneeded_insertion_and_its_voice_candidate() {
        let id = Uuid::from_u128;
        let endpoints: BTreeMap<_, _> = (1..=3)
            .map(|value| {
                (
                    id(value),
                    Endpoint {
                        signing_key: [value as u8; 32],
                        member: Member { user_id: id(value) },
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
        room.set_host_session(id(1));
        room.set_default_relay_capacity(1);
        room.set_relay_capacity(endpoints[&id(2)].member, id(2), Some(0))
            .unwrap();
        for session in [id(1), id(2)] {
            room.set_voice(endpoints[&session].member, session, true, false, false)
                .unwrap();
        }
        room.reconcile(&endpoints, 0);
        room.base_state(id(1), id(2), true).unwrap();
        room.base_state(id(2), id(1), true).unwrap();
        room.publish(
            endpoints[&id(1)].member,
            id(1),
            id(20),
            Kind::Voice,
            None,
            None,
        )
        .unwrap();
        room.reconcile(&endpoints, 1);
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
        room.finish_file(id(3), 1, attachment.clone(), true, true)
            .unwrap();
        room.reconcile(&endpoints, 2);
        assert!(
            !room
                .projection(&endpoints)
                .snapshot(id(2), true)
                .unwrap()
                .room
                .realtime_session_ids
                .contains(&id(3)),
            "an idle cached copy has no realtime activity"
        );
        room.finish_file(id(2), 1, attachment.clone(), false, true)
            .unwrap();
        room.reconcile(&endpoints, 2);
        assert!(
            room.projection(&endpoints)
                .snapshot(id(2), true)
                .unwrap()
                .room
                .realtime_session_ids
                .contains(&id(3)),
            "the selected file source participates while its path prepares"
        );
        assert!(room
            .base_links()
            .any(|link| !link.selected && (link.parent == id(3) || link.child == id(3))));
        assert!(
            room.flows()
                .any(|flow| flow.publication_id == id(20) && !flow.selected),
            "inserting the unavailable file source prepares a replacement voice route"
        );

        room.finish_file(id(1), 1, attachment, true, true).unwrap();
        room.reconcile(&endpoints, 3);
        assert!(
            !room
                .projection(&endpoints)
                .snapshot(id(2), true)
                .unwrap()
                .room
                .realtime_session_ids
                .contains(&id(3)),
            "a replaced file source returns to being only a cached copy"
        );
        assert_eq!(
            room.snapshot(endpoints[&id(2)].member, id(2))
                .unwrap()
                .files[0]
                .source_id,
            Some(id(1))
        );
        assert!(
            room.base_links()
                .all(|link| link.selected && link.parent != id(3) && link.child != id(3)),
            "the unused file source must not retain a candidate or base lease"
        );
        let retained: Vec<_> = room
            .flows()
            .filter(|flow| flow.publication_id == id(20))
            .collect();
        assert_eq!(
            retained.len(),
            1,
            "the discarded base candidate must retire its voice shadow"
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
        room.set_host_session(id(1));
        room.set_default_relay_capacity(3);
        for (session, capacity) in [(2, 1), (3, 0), (4, 0), (5, 2)] {
            room.set_relay_capacity(endpoints[&id(session)].member, id(session), Some(capacity))
                .unwrap();
        }
        // Ordinary admissions establish 1->{2,3,4}, then 2->5.
        for sessions in [&[1, 2, 3, 4][..], &[5][..]] {
            for session in sessions {
                room.set_voice(
                    endpoints[&id(*session)].member,
                    id(*session),
                    true,
                    false,
                    false,
                )
                .unwrap();
            }
            room.reconcile(&endpoints, 0);
            for link in room.base_links().collect::<Vec<_>>() {
                room.base_state(link.parent, link.child, true).unwrap();
                room.base_state(link.child, link.parent, true).unwrap();
            }
            room.reconcile(&endpoints, 1);
        }
        let original: BTreeSet<_> = room
            .base_links()
            .map(|link| (link.parent, link.child))
            .collect();
        assert_eq!(
            original,
            [
                (id(1), id(2)),
                (id(1), id(3)),
                (id(1), id(4)),
                (id(2), id(5))
            ]
            .into()
        );
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
        room.reconcile(&endpoints, 2);
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
        let mut transports = crate::transport::TransportBook::default();
        transports.reconcile(room.flows(), room.base_links());
        room.set_default_relay_capacity(2);
        room.reconcile(&endpoints, 10);
        let candidate = room
            .base_links()
            .find(|link| !link.selected)
            .expect("a feasible sibling must migrate before any healthy subtree is retired");
        assert_eq!((candidate.parent, candidate.child), (id(5), id(3)));
        assert!(old
            .iter()
            .all(|id| room.flows().any(|flow| flow.id == *id && flow.selected)));
        transports.reconcile(room.flows(), room.base_links());
        let first_pair = transports
            .snapshot(id(3), |_| false, |_| false)
            .into_iter()
            .find(|pair| pair.peer_id == id(5))
            .unwrap()
            .id;

        // Withdrawing the reduction releases both candidate transport and voice work.
        room.set_default_relay_capacity(3);
        room.reconcile(&endpoints, 11);
        assert!(!room.base_links().any(|link| !link.selected));
        assert!(!room.flows().any(|flow| !flow.selected));
        assert_eq!(
            room.base_links()
                .map(|link| (link.parent, link.child))
                .collect::<BTreeSet<_>>(),
            original
        );
        transports.reconcile(room.flows(), room.base_links());
        assert!(!transports
            .snapshot(id(3), |_| false, |_| false)
            .iter()
            .any(|pair| pair.id == first_pair));

        room.set_default_relay_capacity(2);
        room.reconcile(&endpoints, 20);
        transports.reconcile(room.flows(), room.base_links());
        let second_pair = transports
            .snapshot(id(3), |_| false, |_| false)
            .into_iter()
            .find(|pair| pair.peer_id == id(5))
            .unwrap()
            .id;
        assert_ne!(second_pair, first_pair);
        let deadline = room.next_route_deadline();
        room.base_state(id(5), id(3), true).unwrap();
        room.reconcile(&endpoints, 21);
        assert_eq!(room.next_route_deadline(), deadline);
        room.base_state(id(3), id(5), true).unwrap();
        room.reconcile(&endpoints, 22);
        assert!(
            room.base_links().any(|link| !link.selected),
            "both voice sources still need media proof"
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
        room.reconcile(&endpoints, 24);
        assert_eq!(
            room.base_links()
                .map(|link| (link.parent, link.child))
                .collect::<BTreeSet<_>>(),
            [
                (id(1), id(2)),
                (id(1), id(4)),
                (id(2), id(5)),
                (id(5), id(3))
            ]
            .into()
        );
        assert!(!room.flows().any(|flow| !flow.selected));
        assert!(room.flows().filter(|flow| flow.receiver == id(3)).count() == 2);
        transports.reconcile(room.flows(), room.base_links());
        let peers = transports.snapshot(id(3), |_| false, |_| false);
        assert!(!peers.iter().any(|pair| pair.peer_id == id(1)));
        assert_eq!(
            peers.iter().find(|pair| pair.peer_id == id(5)).unwrap().id,
            second_pair
        );
    }

    #[test]
    fn reduction_selection_keeps_existing_operations_and_picture_proof() {
        let id = Uuid::from_u128;
        for multiple_parents in [false, true] {
            let count = if multiple_parents { 7 } else { 5 };
            let all: BTreeSet<_> = (1..=count).map(id).collect();
            let mut limits = RelayLimits {
                default: 3,
                host: id(1),
                overrides: if multiple_parents {
                    [(id(3), 0), (id(4), 0), (id(5), 0), (id(6), 0), (id(7), 2)].into()
                } else {
                    [(id(2), 1), (id(3), 0), (id(4), 0), (id(5), 2)].into()
                },
            };
            let mut base = BaseTree::new(id(1));
            let mut picture = Publication::new(PublicationInfo {
                screen: Some(crate::wire::ScreenInfo {
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
            let requested: BTreeSet<_> = (2..=count).map(id).collect();
            for requested in [
                [id(2), id(3), id(4)].into_iter().collect(),
                requested.clone(),
            ] {
                base.reconcile(&requested, &all, &all, &limits, 0);
                for (parent, child) in base.links().collect::<Vec<_>>() {
                    base.state(parent, child, true);
                    base.state(child, parent, true);
                }
                picture.reconcile(&requested, &all, &all, None, &helpers, &limits, 0);
                for flow in picture.flows().collect::<Vec<_>>() {
                    picture.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1);
                }
            }
            if multiple_parents {
                // Physical trials from another activity can fail without changing
                // this ready tree. Parent 1 then has no feasible reduction, while
                // its overloaded child 2 can still move 5 to 7.
                for endpoint in [3, 4] {
                    base.failed(id(endpoint), id(7));
                    picture.failed_pair(id(endpoint), id(7));
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
            base.reconcile(&requested, &all, &all, &limits, 10);
            assert_eq!(base.candidate_links(), vec![expected]);
            let base_deadline = base.deadline();
            base.reconcile(&requested, &all, &all, &limits, 1_000);
            assert_eq!(base.candidate_links(), vec![expected]);
            assert_eq!(base.deadline(), base_deadline);
            picture.reconcile(&requested, &all, &all, None, &helpers, &limits, 10);
            let candidate = picture.flows().find(|flow| !flow.selected).unwrap();
            assert_eq!((candidate.sender, candidate.receiver), expected);
            let deadline = picture.deadline();
            picture.reconcile(&requested, &all, &all, None, &helpers, &limits, 1_000);
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
            picture.reconcile(&requested, &all, &all, None, &helpers, &limits, 1_003);
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
    fn relay_limit_migrates_base_and_voice_before_releasing_the_incumbent() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_on_room_base();
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                .unwrap();
        }
        for (session, endpoint) in &endpoints {
            room.set_voice(endpoint.member, *session, true, false, false)
                .unwrap();
        }
        room.publish(
            endpoints[&id(4)].member,
            id(4),
            id(20),
            Kind::Voice,
            None,
            None,
        )
        .unwrap();
        room.reconcile(&endpoints, 2);
        for flow in room
            .flows()
            .filter(|flow| flow.publication_id == id(20))
            .collect::<Vec<_>>()
        {
            room.flow_state(
                flow.id,
                flow.receiver,
                flow.sender,
                FlowState::Forwardable,
                3,
            )
            .unwrap();
        }
        let voice: BTreeSet<_> = room
            .flows()
            .filter(|flow| flow.publication_id == id(20))
            .map(|flow| flow.id)
            .collect();
        let picture: BTreeSet<_> = room
            .flows()
            .filter(|flow| flow.publication_id == id(10) && flow.selected)
            .map(|flow| flow.id)
            .collect();
        room.set_default_relay_capacity(1);
        room.reconcile(&endpoints, 10);
        let candidate = room.base_links().find(|link| !link.selected).unwrap();
        assert_eq!(room.base_links().filter(|link| link.selected).count(), 3);
        assert!(voice
            .iter()
            .all(|old| room.flows().any(|flow| flow.id == *old && flow.selected)));
        room.base_state(candidate.parent, candidate.child, true)
            .unwrap();
        room.base_state(candidate.child, candidate.parent, true)
            .unwrap();
        room.reconcile(&endpoints, 11);
        assert!(
            room.base_links().any(|link| !link.selected),
            "transport ACKs cannot retire the old voice route"
        );
        let shadows: Vec<_> = room
            .flows()
            .filter(|flow| !flow.selected && flow.publication_id == id(20))
            .collect();
        assert!(!shadows.is_empty());
        for flow in &shadows {
            room.flow_state(
                flow.id,
                flow.receiver,
                flow.sender,
                FlowState::Forwardable,
                12,
            )
            .unwrap();
        }
        room.reconcile(&endpoints, 13);
        assert!(!room.base_links().any(|link| !link.selected));
        assert!(room.base_links().any(|link| link.parent == candidate.parent
            && link.child == candidate.child
            && link.selected));
        assert!(shadows
            .iter()
            .all(|new| room.flows().any(|flow| flow.id == new.id && flow.selected)));
        assert!(
            picture
                .iter()
                .all(|old| room.flows().any(|flow| flow.id == *old && flow.selected)),
            "independent picture delivery keeps its healthy leases"
        );
        let mut transports = crate::transport::TransportBook::default();
        transports.reconcile(room.flows(), room.base_links());
        assert!(!transports.snapshot(id(1), |_| false, |_| false).is_empty());
    }

    #[test]
    fn bounded_base_insertion_and_rotation_admit_a_relay_without_revoking_the_old_voice_path() {
        let id = Uuid::from_u128;
        for already_joined in [false, true] {
            let endpoints: BTreeMap<_, _> = (1..=3)
                .map(|value| {
                    (
                        id(value),
                        Endpoint {
                            signing_key: [value as u8; 32],
                            member: Member { user_id: id(value) },
                            connected: true,
                        },
                    )
                })
                .collect();
            let mut room = RoomRuntime::new(
                RoomState::new(
                    "limited".into(),
                    "Limited".into(),
                    Default::default(),
                    id(1),
                    RoomAccess::Public,
                    false,
                    None,
                )
                .unwrap(),
            );
            room.set_host_session(id(1));
            room.set_default_relay_capacity(1);
            room.set_voice(endpoints[&id(1)].member, id(1), true, true, false)
                .unwrap();
            room.set_voice(endpoints[&id(2)].member, id(2), true, true, false)
                .unwrap();
            room.set_relay_capacity(
                endpoints[&id(2)].member,
                id(2),
                Some(if already_joined { 2 } else { 0 }),
            )
            .unwrap();
            room.reconcile(&endpoints, 0);
            for link in room.base_links().collect::<Vec<_>>() {
                room.base_state(link.parent, link.child, true).unwrap();
                room.base_state(link.child, link.parent, true).unwrap();
            }
            room.reconcile(&endpoints, 1);
            for endpoint in [id(1), id(2)] {
                room.set_voice(endpoints[&endpoint].member, endpoint, true, false, false)
                    .unwrap();
            }
            room.publish(
                endpoints[&id(2)].member,
                id(2),
                id(20),
                Kind::Voice,
                None,
                None,
            )
            .unwrap();
            room.reconcile(&endpoints, 2);
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
            let old_voice = room.flows().find(|flow| flow.receiver == id(1)).unwrap().id;
            room.command(
                endpoints[&id(3)].member,
                id(3),
                crate::wire::Command::Browse {
                    room_id: "limited".into(),
                    active: true,
                    relay_capacity: Some(2),
                },
                &endpoints,
            )
            .unwrap();
            if already_joined {
                room.reconcile(&endpoints, 3);
                for link in room
                    .base_links()
                    .filter(|link| link.selected)
                    .collect::<Vec<_>>()
                {
                    room.base_state(link.parent, link.child, true).unwrap();
                    room.base_state(link.child, link.parent, true).unwrap();
                }
                room.reconcile(&endpoints, 4);
                room.set_relay_capacity(endpoints[&id(2)].member, id(2), Some(0))
                    .unwrap();
            }
            room.set_voice(endpoints[&id(3)].member, id(3), true, false, false)
                .unwrap();
            room.publish(
                endpoints[&id(3)].member,
                id(3),
                id(21),
                Kind::Voice,
                None,
                None,
            )
            .unwrap();
            room.reconcile(&endpoints, 5);
            let candidates: Vec<_> = room.base_links().filter(|link| !link.selected).collect();
            assert_eq!(candidates.len(), 2);
            assert!(candidates
                .iter()
                .any(|link| link.parent == id(1) && link.child == id(3)));
            assert!(candidates
                .iter()
                .any(|link| link.parent == id(3) && link.child == id(2)));
            for link in candidates {
                room.base_state(link.parent, link.child, true).unwrap();
                room.base_state(link.child, link.parent, true).unwrap();
            }
            room.reconcile(&endpoints, 6);
            assert!(room
                .base_links()
                .any(|link| link.selected && link.parent == id(1) && link.child == id(2)));
            assert!(room
                .flows()
                .any(|flow| flow.id == old_voice && flow.selected));
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
                    7,
                )
                .unwrap();
            }
            room.reconcile(&endpoints, 8);
            let selected: BTreeSet<_> = room
                .base_links()
                .filter(|link| link.selected)
                .map(|link| (link.parent, link.child))
                .collect();
            assert_eq!(selected, [(id(1), id(3)), (id(3), id(2))].into());
            assert!(!room.base_links().any(|link| !link.selected));
            assert!(room.flows().any(|flow| flow.publication_id == id(21) && flow.sender == id(3)), "first delivery from the newly inserted origin uses ordinary committed-base reconciliation");
        }
    }

    #[test]
    fn relay_reduction_uses_the_picture_switch_proof_and_preserves_the_viewer() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_on_room_base();
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                .unwrap();
        }
        let old = room.flows().find(|flow| flow.receiver == id(4)).unwrap();
        room.set_relay_capacity(endpoints[&id(2)].member, id(2), Some(0))
            .unwrap();
        room.set_relay_capacity(endpoints[&id(3)].member, id(3), Some(0))
            .unwrap();
        room.reconcile(&endpoints, 2);
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
        room.reconcile(&endpoints, 5);
        assert!(room
            .flows()
            .any(|flow| flow.id == candidate.id && flow.selected));
        assert!(!room
            .flows()
            .any(|flow| flow.publication_id == id(10) && flow.sender == id(2)));
        assert!(room.subscriptions(id(4)).contains(&id(10)));
    }

    #[test]
    fn zero_relay_limit_retires_an_excess_branch_at_its_deadline_but_allows_own_voice() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_on_room_base();
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
        room.reconcile(&endpoints, 10);
        assert!(
            room.base_links()
                .filter(|link| link.selected)
                .any(|link| link.parent == id(2)),
            "the old branch remains during its bounded transition"
        );
        assert!(
            room.flows()
                .any(|flow| flow.publication_id == id(20) && flow.sender == id(2)),
            "zero rejects relaying others, not originating voice"
        );
        room.reconcile(&endpoints, 20_010);
        assert!(!room
            .base_links()
            .filter(|link| link.selected)
            .any(|link| link.parent == id(2)));
        assert!(
            room.base_links()
                .filter(|link| link.selected && link.parent == id(1))
                .count()
                <= 1
        );
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
        let (mut room, endpoints) = screen_on_room_base();
        for receiver in [id(1), id(2)] {
            room.subscribe(endpoints[&receiver].member, receiver, id(10), true, None)
                .unwrap();
        }
        room.reconcile(&endpoints, 0);
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
        room.reconcile(&endpoints, 1);
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
        room.reconcile(&endpoints, 2);
        assert_eq!(room.next_route_deadline(), Some(5_002));
        room.reconcile(&endpoints, 5_001);
        assert!(!room.flows().any(|flow| flow.receiver == id(2)));
        room.reconcile(&endpoints, 5_002);
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
        room.reconcile(&endpoints, 5_003);
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
        room.reconcile(&endpoints, 5_005);
        assert_eq!(failures(&room, id(4)), serde_json::json!([id(10)]));
        for action in ["unwatch", "transfer", "unpublish", "revoke"] {
            let mut ended = room.clone();
            let viewer = endpoints[&id(4)].member;
            match action {
                "unwatch" => {
                    ended.subscribe(viewer, id(4), id(10), false, None).unwrap();
                    ended.reconcile(&endpoints, 5_006);
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
            ended.reconcile(&endpoints, 5_006);
            assert_eq!(failures(&ended, id(4)), serde_json::json!([]), "{action}");
        }
    }

    #[test]
    fn source_title_follows_authority_and_committed_source_without_changing_routes() {
        use crate::wire::ScreenSource;
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_on_room_base();
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
        let (mut room, mut endpoints) = screen_on_room_base();
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
    fn failed_screen_shortcut_is_not_a_new_base_candidate() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_on_room_base();
        for flow in room.flows().collect::<Vec<_>>() {
            room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 0)
                .unwrap();
        }
        room.reconcile(&endpoints, 0);
        assert!(room
            .flows()
            .any(|flow| { flow.sender == id(3) && flow.receiver == id(2) && !flow.selected }));
        let base = room
            .base_links()
            .map(|link| (link.parent, link.child))
            .collect::<Vec<_>>();
        room.failed_pair(id(3), id(2));
        room.reconcile(&endpoints, 1);
        assert_eq!(
            room.base_links()
                .map(|link| (link.parent, link.child))
                .collect::<Vec<_>>(),
            base
        );
        room.failed_pair(id(2), id(4));
        room.reconcile(&endpoints, 2);
        room.failed_pair(id(1), id(2));
        room.reconcile(&endpoints, 3);
        assert!(!room
            .base_links()
            .any(|link| link.parent == id(3) && link.child == id(2)));
    }

    #[test]
    fn required_repair_preserves_another_pending_physical_attempt() {
        use crate::transport::TransportBook;

        let id = Uuid::from_u128;
        let endpoints: BTreeMap<_, _> = (1..=4)
            .map(|value| {
                (
                    id(value),
                    Endpoint {
                        signing_key: [value as u8; 32],
                        member: Member { user_id: id(value) },
                        connected: true,
                    },
                )
            })
            .collect();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "repair".into(),
                "Repair".into(),
                Default::default(),
                id(3),
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        room.set_host_session(id(3));
        // Source=1 is ready; Relay=4 still owns the other root slot.
        for endpoint in [1, 4] {
            room.set_voice(
                endpoints[&id(endpoint)].member,
                id(endpoint),
                true,
                true,
                false,
            )
            .unwrap();
        }
        room.reconcile(&endpoints, 0);
        room.base_state(id(3), id(1), true).unwrap();
        room.base_state(id(1), id(3), true).unwrap();
        let mut transports = TransportBook::default();
        transports.reconcile(room.flows(), room.base_links());
        let original = transports
            .snapshot(id(3), |_| true, |_| true)
            .into_iter()
            .find(|pair| pair.peer_id == id(4))
            .unwrap();
        let healthy = transports
            .snapshot(id(3), |_| true, |_| true)
            .into_iter()
            .find(|pair| pair.peer_id == id(1))
            .unwrap();

        // The new Viewer=2 exhausts its assigned Source path. Its cooldown
        // cannot revoke Relay's independent, still-valid connection attempt.
        room.set_voice(endpoints[&id(2)].member, id(2), true, true, false)
            .unwrap();
        room.reconcile(&endpoints, 100);
        assert!(room
            .base_links()
            .any(|link| link.parent == id(1) && link.child == id(2)));
        room.failed_pair(id(1), id(2));
        room.reconcile(&endpoints, 100);
        assert_eq!(room.next_route_deadline(), Some(5_100));
        room.reconcile(&endpoints, 5_096);
        transports.reconcile(room.flows(), room.base_links());
        assert!(transports.prepare(original.id));
        let prepared = transports
            .snapshot(id(3), |_| true, |_| true)
            .into_iter()
            .find(|pair| pair.peer_id == id(4))
            .unwrap();
        assert_ne!(prepared.id, original.id);
        assert!(transports.prepared(prepared.id));
        // The physical owner can transition immediately before a room wake.
        room.reconcile(&endpoints, 5_100);
        transports.reconcile(room.flows(), room.base_links());
        assert_eq!(transports.peer(id(3), prepared.id), Some(id(4)));
        assert_eq!(transports.peer(id(3), healthy.id), Some(id(1)));

        transports.connected(prepared.id);
        room.base_state(id(3), id(4), true).unwrap();
        room.base_state(id(4), id(3), true).unwrap();
        room.reconcile(&endpoints, 5_200);
        // The Viewer's own next attempt may exhaust; the now-ready Relay then
        // carries it without replacing either retained root connection.
        assert!(room
            .base_links()
            .any(|link| link.parent == id(1) && link.child == id(2)));
        room.failed_pair(id(1), id(2));
        room.reconcile(&endpoints, 25_100);
        assert!(room
            .base_links()
            .any(|link| link.parent == id(4) && link.child == id(2)));
        room.base_state(id(4), id(2), true).unwrap();
        room.base_state(id(2), id(4), true).unwrap();
        room.reconcile(&endpoints, 25_101);
        transports.reconcile(room.flows(), room.base_links());
        assert_eq!(transports.peer(id(3), prepared.id), Some(id(4)));
        assert_eq!(transports.peer(id(3), healthy.id), Some(id(1)));
        assert_eq!(room.next_route_deadline(), None);
    }

    #[test]
    fn required_routes_recover_without_replacing_healthy_flows_or_endpoint_authority() {
        let id = Uuid::from_u128;
        for count in [2, 3] {
            let mut endpoints: BTreeMap<_, _> = (1..=count)
                .map(|n| {
                    (
                        id(n),
                        Endpoint {
                            member: crate::Member { user_id: id(n) },
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
            room.set_host_session(id(1));
            for (session, endpoint) in &endpoints {
                room.browse(endpoint.member, *session, true).unwrap();
                room.set_voice(endpoint.member, *session, true, true, false)
                    .unwrap();
            }
            room.reconcile(&endpoints, 0);
            for link in room.base_links().collect::<Vec<_>>() {
                room.base_state(link.parent, link.child, true).unwrap();
                room.base_state(link.child, link.parent, true).unwrap();
            }
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
            room.reconcile(&endpoints, 0);
            for flow in room.flows().collect::<Vec<_>>() {
                room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, 1)
                    .unwrap();
            }
            room.reconcile(&endpoints, 1);
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
                room.reconcile(&endpoints, 1);
                Some(
                    room.flows()
                        .find(|flow| flow.publication_id == id(11))
                        .unwrap(),
                )
            } else {
                None
            };
            room.failed_pair(id(1), id(2));
            room.reconcile(&endpoints, 2);
            if count == 3 {
                assert!(room
                    .base_links()
                    .any(|link| link.parent == id(3) && link.child == id(2)));
                room.failed_pair(id(3), id(2));
            }
            room.reconcile(&endpoints, 3);
            let deadline = room
                .next_route_deadline()
                .expect("required failed paths must have a repair wake");
            assert_eq!(deadline, if count == 2 { 5_002 } else { 5_003 });
            // Demand toggles cannot bypass or restart the room's cooldown.
            for enabled in [false, true] {
                room.subscribe(endpoints[&id(2)].member, id(2), id(10), enabled, None)
                    .unwrap();
                room.reconcile(&endpoints, 1_000);
                assert_eq!(room.next_route_deadline(), Some(deadline));
            }
            room.reconcile(&endpoints, deadline - 1);
            assert!(!room.base_links().any(|link| link.child == id(2)));
            assert!(!room.flows().any(|flow| flow.receiver == id(2)));
            room.reconcile(&endpoints, deadline);
            assert!(room
                .base_links()
                .any(|link| link.parent == id(1) && link.child == id(2)));
            let restored = room.flows().find(|flow| flow.receiver == id(2)).unwrap();
            assert_ne!(restored.id, old.id);
            assert_eq!(
                room.next_route_deadline(),
                Some(if preparing.is_some() {
                    1 + SCREEN_PREPARE_MS
                } else {
                    deadline + SCREEN_PREPARE_MS
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
                room.flow_state(old.id, id(2), id(1), FlowState::Decoded, deadline),
                Err("unassigned_flow")
            );
            room.base_state(id(1), id(2), true).unwrap();
            room.base_state(id(2), id(1), true).unwrap();
            room.flow_state(restored.id, id(2), id(1), FlowState::Decoded, deadline + 1)
                .unwrap();
            if let Some(preparing) = preparing {
                assert!(room.flows().any(|flow| flow.id == preparing.id));
                room.flow_state(
                    preparing.id,
                    preparing.receiver,
                    preparing.sender,
                    FlowState::Decoded,
                    deadline + 1,
                )
                .unwrap();
            }
            room.reconcile(&endpoints, deadline + 1);
            assert_eq!(room.next_route_deadline(), None);
            if count == 2 {
                room.failed_pair(id(1), id(2));
                room.reconcile(&endpoints, 10_000);
                assert_eq!(room.next_route_deadline(), Some(15_000));
                endpoints.get_mut(&id(2)).unwrap().connected = false;
                room.reconcile(&endpoints, 10_001);
                assert_eq!(room.next_route_deadline(), None);
                endpoints.get_mut(&id(2)).unwrap().connected = true;
                room.reconcile(&endpoints, 10_002);
                assert_eq!(room.next_route_deadline(), Some(15_002));
                room.subscribe(endpoints[&id(2)].member, id(2), id(10), false, None)
                    .unwrap();
                room.browse(endpoints[&id(2)].member, id(2), false).unwrap();
                room.set_voice(endpoints[&id(2)].member, id(2), false, true, false)
                    .unwrap();
                room.reconcile(&endpoints, 10_003);
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
        let (mut room, mut endpoints) = screen_on_room_base();
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
    fn screen_transfer_preserves_viewers_room_paths_and_unrelated_voice() {
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_on_room_base();
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
        for now in 1..=3 {
            room.reconcile(&endpoints, now);
            let links: Vec<_> = room.base_links().collect();
            for link in links {
                room.base_state(link.parent, link.child, true).unwrap();
                room.base_state(link.child, link.parent, true).unwrap();
            }
        }
        room.reconcile(&endpoints, 4);
        let base: Vec<_> = room
            .base_links()
            .map(|link| (link.parent, link.child))
            .collect();
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
        room.reconcile(&endpoints, 5);
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
            base,
            room.base_links()
                .map(|link| (link.parent, link.child))
                .collect::<Vec<_>>()
        );
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
    }

    #[test]
    fn same_endpoint_source_change_preserves_proven_paths_and_retires_old_preparation() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_on_room_base();
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
        room.reconcile(&endpoints, 1);
        room.transfer_source(source, id(3), id(10), id(3), &endpoints)
            .unwrap();
        room.reconcile(&endpoints, 2);
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

        for now in 4..=6 {
            let selected: Vec<_> = room.flows().filter(|flow| flow.selected).collect();
            for flow in selected {
                room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded, now)
                    .unwrap();
            }
            room.reconcile(&endpoints, now);
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
        room.reconcile(&endpoints, 7);
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
        let (mut room, endpoints) = screen_on_room_base();
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
        room.reconcile(&endpoints, 10_000);
        assert_eq!(room.next_route_deadline(), Some(SCREEN_PREPARE_MS));

        room.flow_state(
            flows[&(id(3), id(1))],
            id(1),
            id(3),
            FlowState::Forwardable,
            19_000,
        )
        .unwrap();
        room.reconcile(&endpoints, 19_000);
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
        room.reconcile(&endpoints, 38_000);
        assert_eq!(room.next_route_deadline(), Some(58_000));
        assert!(!room.expire_media(39_000));
        assert!(room.expire_media(58_000));
        room.reconcile(&endpoints, 58_000);
        assert!(room.flows().all(|flow| flow.id != flows[&(id(2), id(4))]));
        assert!(room
            .flows()
            .any(|flow| flow.sender == id(3) && flow.receiver == id(4)));
        assert_eq!(
            room.base_links().count(),
            3,
            "media expiry keeps the room base"
        );
        assert_eq!(room.next_route_deadline(), Some(78_000));

        room.subscribe(endpoints[&id(4)].member, id(4), publication, false, None)
            .unwrap();
        room.reconcile(&endpoints, 60_000);
        assert!(room.flows().next().is_none());
        assert_eq!(room.next_route_deadline(), None);
        assert!(!room.expire_media(78_000));
    }

    fn branch_candidate(
        relay_watching: bool,
    ) -> (RoomRuntime, BTreeMap<Uuid, Endpoint>, Vec<Flow>, Vec<Flow>) {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_on_room_base();
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
        room.reconcile(&endpoints, 0);
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
        room.reconcile(&endpoints, 1_000);
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
        room.reconcile(&endpoints, 2_000);
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
        (room, endpoints, picture, shadow)
    }

    #[test]
    fn screen_audience_follows_watch_intent_and_current_decoded_proof() {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_on_room_base();
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

        let (mut room, mut endpoints, _, _) = branch_candidate(false);
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
        room.reconcile(&endpoints, 2_001);
        assert_eq!(snapshot(&room).publications[0].audience, expected);
        endpoints.remove(&id(4));
        room.reconcile(&endpoints, 2_002);
        assert_eq!(snapshot(&room).publications[0].audience, expected[..1]);
    }

    #[test]
    fn internal_branch_waits_for_all_viewers_then_adopts_the_entire_warmed_lineage() {
        let id = Uuid::from_u128;
        for relay_watching in [false, true] {
            let (mut room, endpoints, old, shadow) = branch_candidate(relay_watching);
            let voice: BTreeSet<_> = room
                .flows()
                .filter(|f| f.publication_id == id(11))
                .map(|f| f.id)
                .collect();
            let base: BTreeSet<_> = room.base_links().map(|f| (f.parent, f.child)).collect();
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
            room.reconcile(&endpoints, 4_000);
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
            assert_eq!(
                room.base_links()
                    .map(|f| (f.parent, f.child))
                    .collect::<BTreeSet<_>>(),
                base
            );
        }
    }

    #[test]
    fn failed_or_expired_shadow_preserves_the_committed_branch_and_attempt_lifetime() {
        let id = Uuid::from_u128;
        for timeout in [false, true] {
            let (mut room, endpoints, old, shadow) = branch_candidate(true);
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
            room.reconcile(&endpoints, 22_000);
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
            room.reconcile(&endpoints, 23_000);
            room.subscribe(endpoints[&id(2)].member, id(2), id(10), true, None)
                .unwrap();
            room.reconcile(&endpoints, 24_000);
            assert!(!room.flows().any(|f| !f.selected && f.receiver == id(2)));
        }
    }

    #[test]
    fn branch_proofs_refresh_independently_and_decoded_withdraws_only_its_permission() {
        let id = Uuid::from_u128;
        for withdrawal in [false, true] {
            let (mut room, endpoints, old, shadow) = branch_candidate(true);
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
            room.reconcile(&endpoints, pending_at);
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
        let (mut room, endpoints, old, shadow) = branch_candidate(true);
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
        room.reconcile(&endpoints, 4_000);
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
        let (mut room, endpoints, old, shadow) = branch_candidate(true);
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
        room.reconcile(&endpoints, 3_000);
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
        assert_eq!(
            admitted
                .room
                .participant_session_ids
                .into_iter()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([owner_session, viewer_session, reader_session])
        );
        assert_eq!(
            admitted
                .room
                .realtime_session_ids
                .into_iter()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([owner_session, viewer_session]),
            "chat reading alone is not realtime participation"
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
        assert!(!locked.room.can_manage);
        assert!(locked.room.participant_session_ids.is_empty());
        assert!(locked.room.realtime_session_ids.is_empty());
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
