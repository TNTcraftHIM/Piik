use crate::{
    access::{RoomPermission, RoomState},
    history::{HistoryRequest, MessageDraft},
    identity::{Endpoint, Member},
    publication::Publication,
    routes::BaseTree,
    transport::{BaseLink, Flow},
    wire::{
        validate_video_ceiling, FlowState, Kind, PublicationInfo, Room, RoomAccess, VideoCeiling,
        VoiceInfo,
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
    next_interaction_at: u64,
}

/// One room owns its policy, activities and logical flows. It neither owns
/// domain identities nor creates physical peer connections.
#[derive(Clone)]
pub struct RoomRuntime {
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
}

impl RoomRuntime {
    pub fn new(policy: RoomState) -> Self {
        Self {
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
        if !self.policy.reads(member.user_id, member.domain_owner) {
            return Err(if self.policy.hidden {
                "room_unavailable"
            } else {
                "room_access_required"
            });
        }
        match permission {
            RoomPermission::Read => Ok(()),
            RoomPermission::Write if member.participates => Ok(()),
            RoomPermission::Manage if self.policy.manages(member.user_id, member.domain_owner) => {
                Ok(())
            }
            _ => Err("forbidden"),
        }
    }

    pub fn snapshot(&self, member: Member, session: Uuid) -> Option<RoomSnapshot> {
        let mut room = self.policy.view(member.user_id, member.domain_owner)?;
        room.capabilities.attachments = self.base.is_some();
        room.reading = room.authorized && self.reading(session);
        let mut snapshot = RoomSnapshot {
            room,
            files: Vec::new(),
            publications: Vec::new(),
            voice: Vec::new(),
            subscriptions: Vec::new(),
        };
        if snapshot.room.authorized {
            snapshot.room.participant_session_ids = self.personal_sessions().into_iter().collect();
            snapshot.files = self
                .base
                .as_ref()
                .map(|base| self.files.plans(&self.policy.id, session, base))
                .unwrap_or_default();
            snapshot.publications = self.publications().cloned().collect();
            snapshot.voice = self.voice().cloned().collect();
            snapshot.subscriptions = self.subscriptions(session).into_iter().collect();
        }
        Some(snapshot)
    }

    pub fn accepts_invite(&self, key: &str) -> bool {
        self.policy.accepts_invite(key)
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
    fn personal_sessions(&self) -> BTreeSet<Uuid> {
        self.activity
            .iter()
            .filter_map(|(session, activity)| {
                (activity.reading || activity.voice.is_some() || !activity.watching.is_empty())
                    .then_some(*session)
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

    pub fn grant_invited(&mut self, user: Uuid) {
        self.policy.grants.insert(user);
    }

    pub(crate) fn interaction(
        &mut self,
        member: Member,
        session: Uuid,
        reaction: String,
        target_user_id: Option<Uuid>,
        endpoints: &BTreeMap<Uuid, Endpoint>,
        now: u64,
    ) -> Result<crate::conversation::ConversationRecord, &'static str> {
        use crate::conversation::{
            ConversationRecord, INTERACTION_INTERVAL_MS, INTERACTION_REACTIONS,
        };
        self.authorize(member, RoomPermission::Read)?;
        if !INTERACTION_REACTIONS.contains(&reaction.as_str())
            || (matches!(reaction.as_str(), "tomato" | "poop") && target_user_id.is_none())
        {
            return Err("invalid_interaction");
        }
        let activity = self.activity.entry(session).or_default();
        if now < activity.next_interaction_at {
            return Err("rate_limited");
        }
        activity.next_interaction_at = now.saturating_add(INTERACTION_INTERVAL_MS);
        if target_user_id.is_some_and(|user| {
            !endpoints.values().any(|endpoint| {
                endpoint.connected
                    && endpoint.member.user_id == user
                    && self.policy.reads(user, endpoint.member.domain_owner)
            })
        }) {
            return Err("target_unavailable");
        }
        Ok(ConversationRecord::Interaction {
            id: Uuid::new_v4(),
            occurred_at: now,
            sender_user_id: member.user_id,
            reaction,
            target_user_id,
        })
    }

    pub fn enter(
        &mut self,
        member: Member,
        password: Option<&str>,
        invite: Option<&str>,
    ) -> Result<(), &'static str> {
        self.policy
            .enter(member.user_id, member.domain_owner, password, invite)
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

    pub fn revoke(&mut self, member: Member, target: Member) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        if self.policy.access != RoomAccess::Private
            || self.policy.manages(target.user_id, target.domain_owner)
        {
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

    pub fn set_reaction(
        &self,
        member: Member,
        message_seq: u64,
        reaction: String,
        active: bool,
    ) -> Result<HistoryRequest, &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        if message_seq == 0 || !crate::history::valid_message_reaction(&reaction) {
            return Err("invalid_reaction");
        }
        Ok(HistoryRequest::SetReaction {
            room_id: self.policy.id.clone(),
            message_seq,
            user_id: member.user_id,
            reaction,
            active,
        })
    }

    pub fn chat(
        &self,
        member: Member,
        text: String,
        nonce: String,
        attachments: Vec<crate::attachment::AttachmentDescriptor>,
        now: u64,
    ) -> Result<HistoryRequest, &'static str> {
        self.authorize(member, RoomPermission::Write)?;
        if !self.attachments_available() && !attachments.is_empty() {
            return Err("attachments_unavailable");
        }
        Ok(HistoryRequest::Send {
            room_id: self.policy.id.clone(),
            draft: MessageDraft::new(member.user_id, nonce, text, attachments, now)?,
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
        muted: bool,
        video_ceiling: Option<VideoCeiling>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Write)?;
        validate_video_ceiling(kind, video_ceiling)?;
        let muted = if kind == Kind::Voice {
            self.activity
                .get(&session)
                .and_then(|activity| activity.voice.as_ref())
                .ok_or("voice_not_joined")?
                .muted
        } else {
            muted
        };
        if let Some(publication) = self.publications.get_mut(&id) {
            if publication.info.session_id != session || publication.info.kind != kind {
                return Err("publication_identity_conflict");
            }
            publication.info.muted = muted;
            publication.info.video_ceiling = video_ceiling;
        } else {
            if self.publications.values().any(|publication| {
                publication.info.session_id == session && publication.info.kind == kind
            }) {
                return Err("source_already_published");
            }
            self.publications.insert(
                id,
                Publication::new(PublicationInfo {
                    id,
                    room_id: self.policy.id.clone(),
                    session_id: session,
                    user_id: member.user_id,
                    kind,
                    muted,
                    paused: false,
                    video_ceiling,
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
        self.authorize(member, RoomPermission::Write)?;
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
        self.authorize(target.member, RoomPermission::Write)?;
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
        self.authorize(member, RoomPermission::Write)?;
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
                    self.authorize(endpoint.member, RoomPermission::Write)?;
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
        self.authorize(member, RoomPermission::Write)?;
        self.activity.entry(session).or_default().voice = joined.then(|| VoiceInfo {
            session_id: session,
            room_id: self.policy.id.clone(),
            muted,
            deafened,
        });
        self.publications.retain(|_, publication| {
            publication.info.session_id != session || publication.info.kind != Kind::Voice || joined
        });
        for publication in self.publications.values_mut().filter(|publication| {
            publication.info.session_id == session && publication.info.kind == Kind::Voice
        }) {
            publication.info.muted = muted;
        }
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
        let available: BTreeSet<_> = endpoints
            .iter()
            .filter_map(|(session, endpoint)| {
                self.authorize(endpoint.member, RoomPermission::Write)
                    .is_ok()
                    .then_some(*session)
            })
            .collect();
        self.files.reconcile(&readable);
        self.publications
            .retain(|_, publication| available.contains(&publication.info.session_id));
        self.activity
            .retain(|session, _| readable.contains(session));
        for (session, activity) in &mut self.activity {
            if !available.contains(session) {
                activity.voice = None;
                activity.watching.clear();
            }
            activity
                .watching
                .retain(|id, _| self.publications.contains_key(id));
            for helper in activity.watching.values_mut() {
                if helper.is_some_and(|id| !available.contains(&id)) {
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
                (endpoint.connected && available.contains(session)).then_some(*session)
            })
            .collect();
        let mut demand = self.personal_sessions();
        if let Some(base) = &mut self.base {
            demand.extend(self.files.demand());
            let base_connected = endpoints
                .iter()
                .filter_map(|(session, endpoint)| {
                    (endpoint.connected && readable.contains(session)).then_some(*session)
                })
                .collect();
            if repair_due {
                base.retry_required(&demand, &base_connected);
            }
            base.reconcile(&demand, &readable, &base_connected);
            needs_repair |= base.needs_repair(&demand, &base_connected);
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
                &available,
                &connected,
                self.base.as_ref(),
                &helpers,
                now,
            );
            needs_repair |= publication.needs_repair(&subscribers, &connected);
        }
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

    pub fn base_links(&self) -> impl Iterator<Item = BaseLink> + '_ {
        self.base
            .iter()
            .flat_map(|base| base.links())
            .map(|(parent, child)| BaseLink {
                room_id: self.policy.id.clone(),
                parent,
                child,
                ready: self.base.as_ref().is_some_and(|base| base.ready(child)),
            })
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
        Ok(publication.flow_state(flow_id, receiver, sender, state, now))
    }
}

#[cfg(test)]
mod tests {
    fn screen_ceiling() -> Option<crate::wire::VideoCeiling> {
        Some(crate::wire::VideoCeiling {
            resolution: crate::wire::VideoResolution {
                width: 1280,
                height: 720,
            },
            max_framerate: 29.97,
            max_bitrate: 2_500_000,
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
        assert!(trial
            .values()
            .all(|new| room.flows().any(|flow| flow.id == new.id && flow.selected)));
        assert!(!room.flows().any(|flow| flow.sender == id(2)));
        assert!(room
            .snapshot(viewer, id(5))
            .unwrap()
            .subscriptions
            .is_empty());
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
        for user in [id(2), id(3), id(4)] {
            room.grant_invited(user);
        }
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
                        member: Member {
                            user_id: id(value),
                            participates: true,
                            domain_owner: value == 1,
                        },
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
            false,
            screen_ceiling(),
        )
        .unwrap();
        room.subscribe(endpoints[&id(4)].member, id(4), publication, true, None)
            .unwrap();
        room.reconcile(&endpoints, 0);
        (room, endpoints)
    }

    #[test]
    fn source_ceiling_upsert_preserves_routes_pause_and_transfer() {
        let id = Uuid::from_u128;
        let (mut room, mut endpoints) = screen_on_room_base();
        let member = endpoints[&id(3)].member;
        let flows = serde_json::to_value(room.flows().collect::<Vec<_>>()).unwrap();
        let deadline = room.next_route_deadline();
        let mut ceiling = screen_ceiling().unwrap();
        ceiling.max_framerate = 59.94;
        room.publish(member, id(3), id(10), Kind::Screen, false, Some(ceiling))
            .unwrap();
        assert_eq!(
            room.publication(id(10)).unwrap().video_ceiling,
            Some(ceiling)
        );
        assert_eq!(
            serde_json::to_value(room.flows().collect::<Vec<_>>()).unwrap(),
            flows
        );
        assert_eq!(room.next_route_deadline(), deadline);
        room.set_paused(id(3), id(10), true).unwrap();
        room.publish(member, id(3), id(10), Kind::Screen, false, Some(ceiling))
            .unwrap();
        assert!(room.publication(id(10)).unwrap().paused);
        assert_eq!(
            room.publish(member, id(3), id(10), Kind::Screen, false, None),
            Err("invalid_video_ceiling")
        );
        assert_eq!(
            room.publish(member, id(3), id(11), Kind::Voice, false, Some(ceiling)),
            Err("invalid_video_ceiling")
        );
        endpoints.get_mut(&id(4)).unwrap().member = member;
        room.transfer_source(member, id(3), id(10), id(4), &endpoints)
            .unwrap();
        let publication = room.publication(id(10)).unwrap();
        assert_eq!(publication.video_ceiling, Some(ceiling));
        assert!(publication.paused);
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
                        member: Member {
                            user_id: id(value),
                            participates: true,
                            domain_owner: value == 3,
                        },
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
            room.browse(endpoints[&id(endpoint)].member, id(endpoint), true)
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
        room.browse(endpoints[&id(2)].member, id(2), true).unwrap();
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
                            member: crate::Member {
                                user_id: id(n),
                                participates: true,
                                domain_owner: n == 1,
                            },
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
                false,
                screen_ceiling(),
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
                    false,
                    screen_ceiling(),
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
    fn screen_transfer_requires_the_current_source_and_a_live_writable_same_user_target() {
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
        endpoints.get_mut(&id(5)).unwrap().member.participates = false;
        assert_eq!(
            room.transfer_source(source, id(3), id(10), id(5), &endpoints),
            Err("forbidden")
        );
        endpoints.get_mut(&id(5)).unwrap().member = source;
        room.publish(source, id(5), id(11), Kind::Screen, false, screen_ceiling())
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
        room.publish(source, id(3), id(11), Kind::Voice, false, None)
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
            false,
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
            assert_eq!(room.next_route_deadline(), Some(8_000));
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
    fn branch_proof_expires_synchronously_before_the_last_viewer_can_commit() {
        let id = Uuid::from_u128;
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
        // A repeated report cannot renew the first viewer's quality evidence.
        room.flow_state(
            relay.id,
            relay.receiver,
            relay.sender,
            FlowState::SwitchReady,
            7_999,
        )
        .unwrap();
        assert_eq!(room.next_route_deadline(), Some(8_000));
        room.flow_state(
            viewer.id,
            viewer.receiver,
            viewer.sender,
            FlowState::SwitchReady,
            8_000,
        )
        .unwrap();
        room.reconcile(&endpoints, 8_000);
        assert!(old
            .iter()
            .all(|old| room.flows().any(|f| f.id == old.id && f.selected)));
        assert!(shadow
            .iter()
            .all(|old| !room.flows().any(|f| f.id == old.id)));
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
            participates: true,
            domain_owner: false,
        };
        let viewer = Member {
            user_id: Uuid::new_v4(),
            ..owner
        };
        let owner_session = Uuid::new_v4();
        let viewer_session = Uuid::new_v4();
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
        room.grant_invited(viewer.user_id);
        let picture = Uuid::new_v4();
        let voice = Uuid::new_v4();
        room.publish(
            owner,
            owner_session,
            picture,
            Kind::Screen,
            false,
            screen_ceiling(),
        )
        .unwrap();
        room.set_voice(owner, owner_session, true, false, false)
            .unwrap();
        room.publish(owner, owner_session, voice, Kind::Voice, false, None)
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
            BTreeSet::from([owner_session, viewer_session])
        );
        assert_eq!(admitted.publications.len(), 2);
        assert_eq!(admitted.voice.len(), 2);
        assert_eq!(
            admitted.subscriptions.into_iter().collect::<BTreeSet<_>>(),
            BTreeSet::from([picture, voice]),
        );

        room.revoke(owner, viewer).unwrap();
        let locked = room.snapshot(viewer, viewer_session).unwrap();
        assert!(!locked.room.authorized);
        assert!(!locked.room.can_manage);
        assert!(locked.room.participant_session_ids.is_empty());
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
    }
}
