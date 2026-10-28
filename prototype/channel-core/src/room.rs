use crate::{
    access::{RoomPermission, RoomState},
    history::{HistoryRequest, MessageDraft},
    identity::{Endpoint, Member},
    publication::Publication,
    routes::BaseTree,
    transport::{BaseLink, Flow},
    wire::{FlowState, Kind, PublicationInfo, Room, RoomAccess, VoiceInfo},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[cfg(test)]
use crate::publication::SCREEN_PREPARE_MS;

#[derive(Clone, Default)]
struct Activity {
    reading: bool,
    watching: BTreeSet<Uuid>,
    voice: Option<VoiceInfo>,
}

/// One room owns its policy, activities and logical flows. It neither owns
/// domain identities nor creates physical peer connections.
#[derive(Clone)]
pub struct RoomRuntime {
    policy: RoomState,
    activity: BTreeMap<Uuid, Activity>,
    publications: BTreeMap<Uuid, Publication>,
    base: Option<BaseTree>,
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
        if enabled {
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
    ) -> Result<(), &'static str> {
        self.files.install(session, seq, attachment, offer)
    }
    pub fn reading(&self, session: Uuid) -> bool {
        self.activity
            .get(&session)
            .is_some_and(|activity| activity.reading)
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
        access: RoomAccess,
        hidden: bool,
        password: Option<Option<String>>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        self.policy.update(name, access, hidden, password)
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
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Write)?;
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

    pub fn subscribe(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        enabled: bool,
    ) -> Result<bool, &'static str> {
        self.authorize(member, RoomPermission::Write)?;
        let publication = self
            .publications
            .get(&id)
            .ok_or("publication_unavailable")?;
        if publication.info.kind != Kind::Screen || publication.info.session_id == session {
            return Err("invalid_subscription");
        }
        let activity = self.activity.entry(session).or_default();
        Ok(if enabled {
            activity.watching.insert(id)
        } else {
            activity.watching.remove(&id)
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
        let mut requested = activity.watching.clone();
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
                .retain(|id| self.publications.contains_key(id));
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
        if let Some(base) = &mut self.base {
            let mut demand: BTreeSet<_> = self
                .activity
                .iter()
                .filter_map(|(session, activity)| {
                    (activity.reading || activity.voice.is_some() || !activity.watching.is_empty())
                        .then_some(*session)
                })
                .collect();
            demand.extend(self.files.demand());
            demand.extend(self.publications.values().map(|p| p.info.session_id));
            let base_connected = endpoints
                .iter()
                .filter_map(|(session, endpoint)| {
                    (endpoint.connected && readable.contains(session)).then_some(*session)
                })
                .collect();
            base.reconcile(&demand, &readable, &base_connected);
        }
        for (id, publication) in &mut self.publications {
            publication.retain_sessions(endpoints);
            let subscribers = requested
                .iter()
                .filter_map(|(session, ids)| ids.contains(id).then_some(*session))
                .collect();
            publication.reconcile(
                &subscribers,
                &available,
                &connected,
                self.base.as_ref(),
                now,
            );
        }
    }

    pub fn next_route_deadline(&self) -> Option<u64> {
        self.publications
            .values()
            .filter_map(Publication::deadline)
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
        self.publications.values().flat_map(Publication::flows)
    }

    pub fn base_links(&self) -> impl Iterator<Item = BaseLink> + '_ {
        self.base
            .iter()
            .flat_map(|base| base.links())
            .map(|(parent, child)| BaseLink {
                room_id: self.policy.id.clone(),
                parent,
                child,
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
    use super::*;

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
        )
        .unwrap();
        room.subscribe(endpoints[&id(4)].member, id(4), publication, true)
            .unwrap();
        room.reconcile(&endpoints, 0);
        (room, endpoints)
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

        room.subscribe(endpoints[&id(4)].member, id(4), publication, false)
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
        room.subscribe(endpoints[&id(1)].member, id(1), id(10), true)
            .unwrap();
        room.subscribe(endpoints[&id(2)].member, id(2), id(10), relay_watching)
            .unwrap();
        // Room voice retains the same physical pairs during the screen change.
        for session in [id(3), id(4)] {
            room.set_voice(endpoints[&session].member, session, true, false, false)
                .unwrap();
        }
        room.publish(endpoints[&id(3)].member, id(3), id(11), Kind::Voice, false)
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
            room.subscribe(endpoints[&id(2)].member, id(2), id(10), false)
                .unwrap();
            room.reconcile(&endpoints, 23_000);
            room.subscribe(endpoints[&id(2)].member, id(2), id(10), true)
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
        room.subscribe(endpoints[&id(2)].member, id(2), id(10), false)
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
        room.publish(owner, owner_session, picture, Kind::Screen, false)
            .unwrap();
        room.set_voice(owner, owner_session, true, false, false)
            .unwrap();
        room.publish(owner, owner_session, voice, Kind::Voice, false)
            .unwrap();
        room.set_voice(viewer, viewer_session, true, false, false)
            .unwrap();
        room.subscribe(viewer, viewer_session, picture, true)
            .unwrap();

        let admitted = room.snapshot(viewer, viewer_session).unwrap();
        assert!(admitted.room.authorized);
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
        assert!(locked.publications.is_empty());
        assert!(locked.voice.is_empty());
        assert!(locked.subscriptions.is_empty());

        room.update(owner, "Friends".into(), RoomAccess::Private, true, None)
            .unwrap();
        assert!(room.snapshot(viewer, viewer_session).is_none());
        let own = room.snapshot(owner, owner_session).unwrap();
        assert!(own.room.authorized && own.room.can_manage);
        assert_eq!(own.publications.len(), 2);
    }
}
