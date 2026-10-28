use crate::{
    access::{RoomPermission, RoomState},
    history::{HistoryRequest, MessageDraft},
    identity::{Endpoint, Member},
    routes::{BaseTree, Plan, Readiness},
    transport::{BaseLink, Flow},
    wire::{FlowState, Kind, PublicationInfo, Room, RoomAccess, VoiceInfo},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const SCREEN_PREPARE_MS: u64 = 20_000;

#[derive(Clone, Default)]
struct Activity {
    reading: bool,
    watching: BTreeSet<Uuid>,
    voice: Option<VoiceInfo>,
}

#[derive(Clone)]
struct Publication {
    info: PublicationInfo,
    plan: Plan,
    leases: BTreeMap<(Uuid, Uuid), Uuid>,
    operation: Option<RouteOperation>,
    direct_attempted: BTreeSet<Uuid>,
}

#[derive(Clone, Copy)]
struct RouteOperation {
    flow: Uuid,
    deadline: u64,
    kind: OperationKind,
}

#[derive(Clone, Copy)]
enum OperationKind {
    Prepare,
    Switch { receiver: Uuid, incumbent: Uuid },
}

impl Publication {
    fn preparing_flows(&self) -> impl Iterator<Item = (Uuid, (Uuid, Uuid))> + '_ {
        self.plan
            .preparing_edges()
            .filter_map(|edge| self.leases.get(&edge).map(|flow| (*flow, edge)))
    }

    fn current_switch(&self, receiver: Uuid, incumbent: Uuid) -> bool {
        self.plan.can_shortcut(receiver)
            && self
                .plan
                .parents
                .get(&receiver)
                .and_then(|parent| self.leases.get(&(*parent, receiver)))
                == Some(&incumbent)
            && self.plan.preparing_edges().next().is_none()
    }

    fn reconcile_routes(
        &mut self,
        mut paths: BTreeSet<(Uuid, Uuid)>,
        requested: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        now: u64,
    ) {
        if let Some(RouteOperation {
            kind:
                OperationKind::Switch {
                    receiver,
                    incumbent,
                },
            ..
        }) = self.operation
        {
            if requested.contains(&receiver)
                && connected.contains(&receiver)
                && connected.contains(&self.plan.source)
                && self.current_switch(receiver, incumbent)
            {
                paths.insert((self.plan.source, receiver));
            } else {
                self.cancel_switch();
            }
        }
        self.leases.retain(|path, _| paths.contains(path));
        for path in paths {
            self.leases.entry(path).or_insert_with(Uuid::new_v4);
        }
        if self.info.kind != Kind::Screen {
            return;
        }
        if let Some(operation) = &self.operation {
            match operation.kind {
                OperationKind::Switch { .. } => return,
                OperationKind::Prepare
                    if self
                        .preparing_flows()
                        .any(|(flow, _)| flow == operation.flow) =>
                {
                    return
                }
                OperationKind::Prepare => {}
            }
        }
        let preparing = self
            .preparing_flows()
            .next()
            .map(|(flow, _)| RouteOperation {
                flow,
                deadline: now.saturating_add(SCREEN_PREPARE_MS),
                kind: OperationKind::Prepare,
            });
        self.operation = preparing;
        if self.operation.is_some() || !connected.contains(&self.plan.source) {
            return;
        }
        let candidate = requested.iter().copied().find(|child| {
            !self.direct_attempted.contains(child)
                && connected.contains(child)
                && self.plan.can_shortcut(*child)
        });
        if let Some(receiver) = candidate {
            let incumbent = self.leases[&(self.plan.parents[&receiver], receiver)];
            let flow = Uuid::new_v4();
            self.leases.insert((self.plan.source, receiver), flow);
            self.direct_attempted.insert(receiver);
            self.operation = Some(RouteOperation {
                flow,
                deadline: now.saturating_add(SCREEN_PREPARE_MS),
                kind: OperationKind::Switch {
                    receiver,
                    incumbent,
                },
            });
        }
    }

    fn cancel_switch(&mut self) {
        if let Some(RouteOperation {
            kind: OperationKind::Switch { receiver, .. },
            ..
        }) = self.operation
        {
            self.leases.remove(&(self.plan.source, receiver));
            self.operation = None;
        }
    }
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
                Publication {
                    info: PublicationInfo {
                        id,
                        room_id: self.policy.id.clone(),
                        session_id: session,
                        user_id: member.user_id,
                        kind,
                        muted,
                    },
                    plan: Plan::new(session),
                    leases: BTreeMap::new(),
                    operation: None,
                    direct_attempted: BTreeSet::new(),
                },
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
            publication
                .direct_attempted
                .retain(|child| endpoints.contains_key(child));
            let subscribers = requested
                .iter()
                .filter_map(|(session, ids)| ids.contains(id).then_some(*session))
                .collect();
            let paths: BTreeSet<_> = if let Some(base) = self
                .base
                .as_ref()
                .filter(|_| publication.info.kind == Kind::Voice)
            {
                base.project(
                    publication.info.session_id,
                    &self
                        .activity
                        .iter()
                        .filter_map(|(session, activity)| {
                            activity.voice.is_some().then_some(*session)
                        })
                        .collect(),
                )
            } else {
                publication.plan.reconcile(
                    &subscribers,
                    &available,
                    &connected,
                    self.base.as_ref(),
                );
                publication
                    .plan
                    .parents
                    .iter()
                    .map(|(child, parent)| (*parent, *child))
                    .collect()
            };
            publication.reconcile_routes(paths, &subscribers, &connected, now);
        }
    }

    pub fn next_route_deadline(&self) -> Option<u64> {
        self.publications
            .values()
            .filter_map(|publication| {
                publication
                    .operation
                    .as_ref()
                    .map(|operation| operation.deadline)
            })
            .min()
    }

    pub fn expire_media(&mut self, now: u64) -> bool {
        let mut changed = false;
        for publication in self.publications.values_mut() {
            let Some(operation) = &publication.operation else {
                continue;
            };
            if operation.deadline > now {
                continue;
            }
            match operation.kind {
                OperationKind::Switch { .. } => {
                    publication.cancel_switch();
                    changed = true;
                }
                OperationKind::Prepare => {
                    let expired = publication
                        .preparing_flows()
                        .find_map(|(flow, edge)| (flow == operation.flow).then_some(edge));
                    if let Some((parent, child)) = expired {
                        // A downstream node waiting for this source is not a failed edge.
                        publication.plan.failed(parent, child);
                        changed = true;
                    }
                }
            }
            publication.operation = None;
        }
        changed
    }

    pub fn flows(&self) -> impl Iterator<Item = Flow> + '_ {
        self.publications.iter().flat_map(move |(id, publication)| {
            publication
                .leases
                .iter()
                .map(move |((parent, child), lease)| Flow {
                    id: *lease,
                    publication_id: *id,
                    sender: *parent,
                    receiver: *child,
                    selected: self.base.is_some() && publication.info.kind == Kind::Voice
                        || publication.plan.parents.get(child) == Some(parent),
                })
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
            if let Some(RouteOperation {
                kind: OperationKind::Switch { receiver, .. },
                ..
            }) = publication.operation
            {
                if (first == publication.plan.source && second == receiver)
                    || (second == publication.plan.source && first == receiver)
                {
                    publication.cancel_switch();
                }
            }
            publication.plan.failed(first, second);
        }
    }

    pub fn flow_state(
        &mut self,
        flow_id: Uuid,
        receiver: Uuid,
        sender: Uuid,
        state: FlowState,
    ) -> Result<bool, &'static str> {
        let publication = self
            .publications
            .values_mut()
            .find(|publication| publication.leases.get(&(sender, receiver)) == Some(&flow_id))
            .ok_or("unassigned_flow")?;
        if self.base.is_some() && publication.info.kind == Kind::Voice {
            return Ok(false);
        }
        if let Some(RouteOperation {
            flow,
            kind:
                OperationKind::Switch {
                    receiver: candidate,
                    incumbent,
                },
            ..
        }) = publication.operation
        {
            if flow == flow_id {
                return Ok(match state {
                    FlowState::Failed => {
                        publication.cancel_switch();
                        true
                    }
                    FlowState::SwitchReady
                        if candidate == receiver
                            && publication.current_switch(receiver, incumbent) =>
                    {
                        publication.plan.shortcut(receiver);
                        publication.leases.retain(|_, lease| *lease != incumbent);
                        publication.operation = None;
                        true
                    }
                    _ => false,
                });
            }
        }
        Ok(match state {
            FlowState::Forwardable => {
                publication
                    .plan
                    .mark_ready(receiver, sender, Readiness::Forwardable)
            }
            FlowState::Decoded => publication
                .plan
                .mark_ready(receiver, sender, Readiness::Decoded),
            FlowState::Failed if publication.info.kind == Kind::Screen => {
                publication.plan.failed(sender, receiver);
                true
            }
            FlowState::Failed => publication.plan.mark_unready(receiver, sender),
            FlowState::SwitchReady => false,
        })
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

        room.flow_state(flows[&(id(3), id(1))], id(1), id(3), FlowState::Forwardable)
            .unwrap();
        room.reconcile(&endpoints, 19_000);
        assert_eq!(room.next_route_deadline(), Some(39_000));
        assert!(!room.expire_media(20_000));

        room.flow_state(flows[&(id(1), id(2))], id(2), id(1), FlowState::Forwardable)
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

    fn decoded_leaf_candidate() -> (RoomRuntime, BTreeMap<Uuid, Endpoint>, Flow, Flow) {
        let id = Uuid::from_u128;
        let (mut room, endpoints) = screen_on_room_base();
        // Voice and screen reuse the same base pairs but keep separate leases.
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
        let incumbent = picture
            .iter()
            .find(|f| f.receiver == id(4))
            .unwrap()
            .clone();
        for flow in picture {
            room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Forwardable)
                .unwrap();
        }
        room.reconcile(&endpoints, 1_000);
        assert!(
            room.flows().all(|f| f.selected),
            "packet proof cannot authorize a decoded candidate"
        );
        room.flow_state(
            incumbent.id,
            incumbent.receiver,
            incumbent.sender,
            FlowState::Decoded,
        )
        .unwrap();
        room.reconcile(&endpoints, 2_000);
        let candidate = room.flows().find(|f| !f.selected).unwrap();
        assert_eq!((candidate.sender, candidate.receiver), (id(3), id(4)));
        assert_eq!(room.next_route_deadline(), Some(22_000));
        (room, endpoints, incumbent, candidate)
    }

    #[test]
    fn screen_shortcut_commits_only_the_prepared_candidate_and_keeps_other_leases() {
        let id = Uuid::from_u128;
        let (mut room, endpoints, incumbent, candidate) = decoded_leaf_candidate();
        let voice: BTreeSet<_> = room
            .flows()
            .filter(|f| f.publication_id == id(11))
            .map(|f| f.id)
            .collect();
        let base: BTreeSet<_> = room.base_links().map(|f| (f.parent, f.child)).collect();
        for proof in [FlowState::Forwardable, FlowState::Decoded] {
            assert!(!room
                .flow_state(candidate.id, candidate.receiver, candidate.sender, proof)
                .unwrap());
            room.reconcile(&endpoints, 3_000);
            assert!(room.flows().any(|f| f.id == incumbent.id && f.selected));
            assert!(room.flows().any(|f| f.id == candidate.id && !f.selected));
        }
        assert!(
            !room
                .flow_state(
                    incumbent.id,
                    incumbent.receiver,
                    incumbent.sender,
                    FlowState::Forwardable
                )
                .unwrap(),
            "late packet proof cannot demote the incumbent's decoded evidence"
        );
        assert!(room
            .flow_state(
                candidate.id,
                candidate.receiver,
                candidate.sender,
                FlowState::SwitchReady
            )
            .unwrap());
        room.reconcile(&endpoints, 4_000);
        let screens: Vec<_> = room
            .flows()
            .filter(|f| f.publication_id == id(10))
            .collect();
        assert_eq!(screens.len(), 1);
        assert_eq!(
            screens[0].id, candidate.id,
            "commit keeps the warmed flow identity"
        );
        assert!(screens[0].selected);
        assert_eq!(room.next_route_deadline(), None);
        assert_eq!(
            room.flow_state(
                incumbent.id,
                incumbent.receiver,
                incumbent.sender,
                FlowState::Failed
            ),
            Err("unassigned_flow")
        );
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

    #[test]
    fn failed_or_expired_candidate_preserves_playback_and_is_not_retried_by_watch_toggles() {
        let id = Uuid::from_u128;
        for timeout in [false, true] {
            let (mut room, endpoints, incumbent, candidate) = decoded_leaf_candidate();
            let before: BTreeSet<_> = room.flows().filter(|f| f.selected).map(|f| f.id).collect();
            room.reconcile(&endpoints, 21_999);
            assert_eq!(room.next_route_deadline(), Some(22_000));
            if timeout {
                assert!(room.expire_media(22_000));
            } else {
                room.flow_state(
                    candidate.id,
                    candidate.receiver,
                    candidate.sender,
                    FlowState::Failed,
                )
                .unwrap();
            }
            room.reconcile(&endpoints, 22_000);
            assert_eq!(room.flows().map(|f| f.id).collect::<BTreeSet<_>>(), before);
            assert_eq!(room.next_route_deadline(), None);
            assert!(room.flows().any(|f| f.id == incumbent.id && f.selected));
            assert_eq!(
                room.flow_state(
                    candidate.id,
                    candidate.receiver,
                    candidate.sender,
                    FlowState::SwitchReady
                ),
                Err("unassigned_flow")
            );
            room.subscribe(endpoints[&id(4)].member, id(4), id(10), false)
                .unwrap();
            room.reconcile(&endpoints, 23_000);
            room.subscribe(endpoints[&id(4)].member, id(4), id(10), true)
                .unwrap();
            room.reconcile(&endpoints, 24_000);
            let screens: Vec<_> = room
                .flows()
                .filter(|f| f.publication_id == id(10))
                .collect();
            for flow in screens {
                room.flow_state(flow.id, flow.receiver, flow.sender, FlowState::Decoded)
                    .unwrap();
            }
            room.reconcile(&endpoints, 25_000);
            assert!(room.flows().all(|f| f.selected));
            assert_eq!(room.next_route_deadline(), None);
        }
    }

    #[test]
    fn incumbent_loss_retires_the_switch_before_ordinary_media_repair() {
        let (mut room, endpoints, incumbent, candidate) = decoded_leaf_candidate();
        room.flow_state(
            incumbent.id,
            incumbent.receiver,
            incumbent.sender,
            FlowState::Failed,
        )
        .unwrap();
        assert!(!room
            .flow_state(
                candidate.id,
                candidate.receiver,
                candidate.sender,
                FlowState::SwitchReady
            )
            .unwrap());
        room.reconcile(&endpoints, 3_000);
        assert!(!room.flows().any(|f| f.id == incumbent.id));
        assert!(room.flows().all(|f| f.selected));
        let replacement = room
            .flows()
            .find(|f| {
                f.publication_id == candidate.publication_id && f.receiver == candidate.receiver
            })
            .unwrap();
        assert_ne!(replacement.id, incumbent.id);
        assert_ne!(
            replacement.id, candidate.id,
            "availability repair starts a fresh proof lifetime"
        );
        assert_eq!(
            room.flow_state(
                candidate.id,
                candidate.receiver,
                candidate.sender,
                FlowState::Decoded
            ),
            Err("unassigned_flow")
        );
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
