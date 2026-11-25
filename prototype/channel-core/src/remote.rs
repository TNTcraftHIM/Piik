//! Domain directory and the current live room-host binding. No room policy lives here.
use crate::{
    host::*,
    identity::{Endpoint, Member},
    room::RoomSnapshot,
    wire::{Room, RoomAccess, RoomCapabilities},
};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct Binding {
    pub id: Uuid,
    pub session: Uuid,
    pub connection: Uuid,
    pub revision: u64,
    // A failed link retires routes. A new binding or scope update also retires the previous participant set.
    pub projection_floor: u64,
    pub scope_floor: u64,
    // Signed conversation needs a covering read policy after registration or possible revocation.
    pub read_floor: u64,
    pub applied_revision: u64,
    pub replies: BTreeMap<u64, ReplyOwner>,
    pub failed_pairs: BTreeMap<(Uuid, Uuid), u64>,
}

impl Binding {
    pub(crate) fn invalidate_scope(&mut self) {
        self.projection_floor = self.revision;
        self.scope_floor = self.revision;
    }

    pub(crate) fn awaiting_pair_failure(&self) -> bool {
        self.scope_floor <= self.applied_revision && self.applied_revision < self.projection_floor
    }
}

#[derive(Clone)]
pub(crate) enum ReplyOwner {
    Request {
        context: RequestContext,
        member: Member,
        completion: Option<RoomResult>,
        delete: bool,
    },
    RouteWake,
}

pub(crate) type RetiredRoomReply = (String, RoomReply);

#[derive(Clone)]
pub(crate) struct RemoteRoom {
    pub summary: RoomSummary,
    pub reservation: Option<Uuid>,
    pub known_sessions: BTreeSet<Uuid>,
    pub binding: Option<Binding>,
    pub projection: Option<RoomProjection>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ByteActivity {
    File(u64, Uuid),
    Watch(Uuid),
}

struct ByteRoute<'a> {
    upstream: &'a mut Option<Uuid>,
    downstream: &'a mut Vec<Uuid>,
    receiving: bool,
}

fn byte_routes(
    view: &mut crate::room::RoomRecipient,
) -> impl Iterator<Item = (ByteActivity, ByteRoute<'_>)> {
    let files = view.files.iter_mut().map(|p| {
        (
            ByteActivity::File(p.message_seq, p.attachment.id),
            ByteRoute {
                upstream: &mut p.upstream,
                downstream: &mut p.downstream,
                receiving: p.receiving,
            },
        )
    });
    let watches = view.watch_bytes.iter_mut().map(|p| {
        (
            ByteActivity::Watch(p.activity_id),
            ByteRoute {
                upstream: &mut p.upstream,
                downstream: &mut p.downstream,
                receiving: p.receiving,
            },
        )
    });
    files.chain(watches)
}

fn retire_byte_branches(projection: &mut RoomProjection, first: Uuid, second: Uuid) -> bool {
    let mut cuts = BTreeMap::new();
    for (parent, child) in [(first, second), (second, first)] {
        if let Some(view) = projection.views.get_mut(&child) {
            for (id, branch) in byte_routes(view) {
                if *branch.upstream == Some(parent) {
                    cuts.insert(id, (parent, child));
                }
            }
        }
    }
    if cuts.is_empty() {
        return false;
    }
    let mut trees: BTreeMap<_, BTreeMap<_, _>> = BTreeMap::new();
    for (&session, view) in &mut projection.views {
        for (id, branch) in byte_routes(view).filter(|(id, _)| cuts.contains_key(id)) {
            trees.entry(id).or_default().insert(session, branch);
        }
    }
    for (id, mut tree) in trees {
        let (mut parent, mut child) = cuts[&id];
        let mut disconnected = vec![child];
        while let Some(session) = disconnected.pop() {
            if let Some(branch) = tree.get_mut(&session) {
                *branch.upstream = None;
                disconnected.append(branch.downstream);
            }
        }
        // An upstream relay may have served only the disconnected subtree.
        while let Some(branch) = tree.get_mut(&parent) {
            branch.downstream.retain(|peer| *peer != child);
            if branch.receiving || !branch.downstream.is_empty() {
                break;
            }
            let Some(grandparent) = branch.upstream.take() else {
                break;
            };
            child = parent;
            parent = grandparent;
        }
    }
    for (&session, view) in &mut projection.views {
        view.files.retain(|p| {
            p.receiving
                || p.source_id == Some(session)
                || p.upstream.is_some()
                || !p.downstream.is_empty()
        });
        view.watch_bytes.retain(|p| {
            p.receiving
                || p.source.session_id == session
                || p.upstream.is_some()
                || !p.downstream.is_empty()
        });
    }
    true
}

impl RemoteRoom {
    pub fn occupies_slot(&self) -> bool {
        self.reservation.is_some() || self.binding.is_some()
    }

    pub fn failed_pair(&mut self, first: Uuid, second: Uuid) -> bool {
        let (Some(binding), Some(projection)) = (&mut self.binding, &mut self.projection) else {
            return false;
        };
        let mut pending: Vec<_> = projection.flows.iter()
            .filter(|flow| (flow.sender, flow.receiver) == (first, second)
                || (flow.sender, flow.receiver) == (second, first))
            .map(|flow| flow.id).collect();
        let lost_flow = !pending.is_empty();
        if lost_flow {
            let mut children: BTreeMap<_, Vec<_>> = BTreeMap::new();
            for flow in &projection.flows {
                if let Some(input) = flow.input_flow_id {
                    children.entry(input).or_default().push(flow.id);
                }
            }
            let mut retired = BTreeSet::new();
            while let Some(id) = pending.pop() {
                if retired.insert(id) {
                    pending.extend(children.remove(&id).unwrap_or_default());
                }
            }
            projection.flows.retain(|flow| !retired.contains(&flow.id));
        }
        let lost_byte_edge = retire_byte_branches(projection, first, second);
        if !lost_byte_edge && !lost_flow {
            return false;
        }
        // Keep the invalidation until this binding acknowledges a covering input,
        // including when its signaling socket cannot currently receive that input.
        binding.revision += 1;
        binding.projection_floor = binding.revision;
        binding
            .failed_pairs
            .insert((first.min(second), first.max(second)), binding.revision);
        true
    }

    pub fn drain_replies(&mut self) -> Vec<RetiredRoomReply> {
        let Some(binding) = &mut self.binding else {
            return Vec::new();
        };
        std::mem::take(&mut binding.replies)
            .into_values()
            .filter_map(|owner| match owner {
                ReplyOwner::Request { context, .. } => Some((
                    self.summary.id.clone(),
                    RoomReply {
                        context,
                        result: RoomResult::Error {
                            code: "room_context_changed".into(),
                        },
                    },
                )),
                _ => None,
            })
            .collect()
    }

    pub fn pause(&mut self) -> Vec<RetiredRoomReply> {
        let replies = self.drain_replies();
        self.binding = None;
        if let Some(projection) = &mut self.projection {
            projection.picture = None;
            projection.next_route_deadline = None;
            projection.flows.clear();
            projection.publications.clear();
            projection.watch_activities.clear();
            projection.voice.clear();
            projection.participant_session_ids.clear();
            for view in projection.views.values_mut() {
                view.subscriptions.clear();
                view.watch_subscriptions.clear();
                view.watch_bytes.clear();
                view.failed_subscriptions.clear();
                view.files.clear();
                view.reading = false;
                view.transit_endpoint = None;
            }
        }
        replies
    }

    pub fn restored(summary: RoomSummary) -> Self {
        Self {
            summary,
            reservation: None,
            known_sessions: BTreeSet::new(),
            binding: None,
            projection: None,
        }
    }

    pub(crate) fn planning_sessions(
        &self,
        service: Option<ServiceEndpoint>,
        actor: Option<Uuid>,
    ) -> BTreeSet<Uuid> {
        let Some((binding, projection)) = self.binding.as_ref().zip(self.projection.as_ref())
        else {
            return BTreeSet::new();
        };
        if binding.applied_revision < binding.projection_floor {
            return BTreeSet::new();
        }
        Self::projected_sessions(binding, projection, service, actor)
    }

    pub(crate) fn projected_sessions(
        binding: &Binding,
        projection: &RoomProjection,
        service: Option<ServiceEndpoint>,
        actor: Option<Uuid>,
    ) -> BTreeSet<Uuid> {
        let mut sessions: BTreeSet<_> = projection
            .participant_session_ids
            .iter()
            .copied()
            .chain([binding.session])
            .chain(actor)
            .chain(
                projection
                    .views
                    .values()
                    .filter(|view| view.authorized)
                    .flat_map(|view| view.screen_helpers.values().copied()),
            )
            .chain(
                projection
                    .views
                    .iter()
                    .filter(|(_, view)| !view.files.is_empty() || !view.watch_bytes.is_empty())
                    .map(|(id, _)| *id),
            )
            .filter(|id| projection.views.get(id).is_some_and(|view| view.authorized))
            .collect();
        if let Some(service) = service.filter(|_| projection.allow_service_relay) {
            sessions.insert(service.session_id);
        }
        sessions
    }

    pub fn input(
        &mut self,
        hosting_mode: crate::wire::HostingMode,
        channel_owner_id: Uuid,
        endpoints: BTreeMap<Uuid, Endpoint>,
        service_endpoint: Option<ServiceTransit>,
        pairs: impl Iterator<Item = (Uuid, Uuid)>,
        action: HostAction,
        now: u64,
    ) -> Result<(Uuid, HostInput), &'static str> {
        let actor = match &action {
            HostAction::Command { context, .. } => Some(context.session_id),
            _ => None,
        };
        let sessions = match self.binding.as_ref().zip(self.projection.as_ref()) {
            Some((binding, projection)) if binding.applied_revision >= binding.scope_floor => {
                let service = service_endpoint.map(|service| service.endpoint);
                Self::projected_sessions(binding, projection, service, actor)
            }
            _ => BTreeSet::new(),
        };
        let confirmed_pairs = pairs
            .filter(|(a, b)| sessions.contains(a) && sessions.contains(b))
            .collect();
        let binding = self.binding.as_mut().ok_or("room_host_offline")?;
        binding.failed_pairs.retain(|(first, second), _| {
            endpoints.contains_key(first) && endpoints.contains_key(second)
        });
        let owner = match &action {
            HostAction::Command { context, .. }
            | HostAction::RemoveHostedRoom { context }
            | HostAction::Revoke { context, .. }
            | HostAction::FlowState { context, .. }
            | HostAction::RoomDataState { context, .. } => Some(ReplyOwner::Request {
                context: context.clone(),
                member: endpoints[&context.session_id].member,
                completion: None,
                delete: matches!(
                    &action,
                    HostAction::RemoveHostedRoom { .. }
                        | HostAction::Command {
                            command: crate::wire::Command::DeleteRoom {
                                delete_data: true,
                                ..
                            },
                            ..
                        }
                ),
            }),
            HostAction::RouteWake => Some(ReplyOwner::RouteWake),
            _ => None,
        };
        if owner.is_some() && binding.replies.len() >= 64 {
            return Err("room_busy");
        }
        binding.revision += 1;
        match &action {
            HostAction::Revoke { context, .. }
            | HostAction::Command {
                context,
                command: crate::wire::Command::UpdateRoom { access: Some(RoomAccess::Private), .. },
            } if endpoints[&context.session_id].member.user_id == self.summary.creator_id => {
                binding.read_floor = binding.revision;
            }
            _ => {}
        }
        if matches!(action, HostAction::RouteWake) {
            binding.invalidate_scope();
        }
        if let Some(owner) = owner {
            binding.replies.insert(binding.revision, owner);
        }
        Ok((
            binding.session,
            HostInput {
                hosting_mode,
                channel_owner_id,
                now,
                binding_id: binding.id,
                host_session_id: binding.session,
                revision: binding.revision,
                confirmed_pairs,
                failed_pairs: binding
                    .failed_pairs
                    .iter()
                    .filter(|(_, revision)| **revision > binding.applied_revision)
                    .map(|((first, second), revision)| PairFailure {
                        first: *first,
                        second: *second,
                        revision: *revision,
                    })
                    .collect(),
                endpoints,
                service_endpoint,
                action,
            },
        ))
    }

    pub fn snapshot(&self, member: Member, session: Uuid, available: bool) -> Option<RoomSnapshot> {
        // Existing participant work can survive a signaling-only disconnect
        // until the binding retires. Public directory visitors see no such row.
        let known = self.known_sessions.contains(&session);
        if available || (self.binding.is_some() && known) {
            if let Some(projection) = &self.projection {
                if projection.views.contains_key(&session) {
                    return projection.snapshot(session, available);
                }
            }
        }
        let manager = member.user_id == self.summary.creator_id;
        let summary = self
            .projection
            .as_ref()
            .map_or(&self.summary, |p| &p.summary);
        let discoverable = available && self.projection.is_some() && !summary.hidden;
        if !manager && !discoverable && !(known && self.projection.is_some()) {
            return None;
        }
        Some(RoomSnapshot {
            watch_activities: vec![],
            watch_subscriptions: vec![],
            watch_bytes: vec![],
            room: Room {
                delivery: None,
                id: summary.id.clone(),
                name: summary.name.clone(),
                icon: summary.icon.clone(),
                picture: None,
                creator_id: summary.creator_id,
                access: summary.access,
                hidden: summary.hidden,
                has_password: summary.has_password,
                voice_bitrate: summary.voice_bitrate,
                relay_capacity: summary.relay_capacity,
                relay_override: None,
                service_relay: None,
                authorized: manager || known || summary.access == RoomAccess::Public,
                can_manage: manager,
                available: discoverable,
                reading: false,
                participant_session_ids: Vec::new(),
                history_lineage: None,
                last_message_seq: 0,
                file_activity: Vec::new(),
                file_availability: None,
                capabilities: RoomCapabilities {
                    attachments: false,
                    history_seek: false,
                    file_availability_limit: None,
                },
                members: None,
            },
            files: vec![],
            publications: vec![],
            voice: vec![],
            subscriptions: vec![],
            failed_subscriptions: vec![],
        })
    }
}
