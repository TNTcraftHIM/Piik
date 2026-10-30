//! Domain directory and the current live room-host binding. No room policy lives here.
use crate::{
    host::*,
    identity::{Endpoint, Member},
    room::RoomSnapshot,
    wire::{Room, RoomAccess, RoomCapabilities},
};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct Binding {
    pub id: Uuid,
    pub session: Uuid,
    pub connection: Uuid,
    pub revision: u64,
    // Invalidations can advance the floor before the host's covering output arrives.
    pub projection_floor: u64,
    pub applied_revision: u64,
    pub replies: BTreeMap<u64, ReplyOwner>,
}

#[derive(Clone)]
pub(crate) enum ReplyOwner {
    Request {
        context: RequestContext,
        member: Member,
        completion: Option<RoomResult>,
    },
    Invitation {
        ticket: Uuid,
        member: Option<Member>,
    },
    RouteWake,
}

#[derive(Clone)]
pub(crate) struct RemoteRoom {
    pub summary: RoomSummary,
    pub binding: Option<Binding>,
    pub projection: Option<RoomProjection>,
}

impl RemoteRoom {
    pub fn pause(&mut self) {
        self.binding = None;
        if let Some(projection) = &mut self.projection {
            projection.next_route_deadline = None;
            projection.flows.clear();
            projection.base_links.clear();
            for view in projection.views.values_mut() {
                view.publications.clear();
                view.voice.clear();
                view.subscriptions.clear();
                view.room.available = false;
                view.room.reading = false;
            }
        }
    }

    pub fn restored(summary: RoomSummary) -> Self {
        Self {
            summary,
            binding: None,
            projection: None,
        }
    }

    pub fn input(
        &mut self,
        endpoints: BTreeMap<Uuid, Endpoint>,
        action: HostAction,
        now: u64,
    ) -> Result<(Uuid, HostInput), &'static str> {
        let binding = self.binding.as_mut().ok_or("room_host_offline")?;
        let owner = match &action {
            HostAction::Command { context, .. }
            | HostAction::Revoke { context, .. }
            | HostAction::FlowState { context, .. }
            | HostAction::BaseState { context, .. }
            | HostAction::GrantInvited { context } => Some(ReplyOwner::Request {
                context: context.clone(),
                member: endpoints[&context.session_id].member,
                completion: None,
            }),
            HostAction::RouteWake => Some(ReplyOwner::RouteWake),
            HostAction::VerifyInvite { ticket, member, .. } => Some(ReplyOwner::Invitation {
                ticket: *ticket,
                member: *member,
            }),
            _ => None,
        };
        if owner.is_some() && binding.replies.len() >= 64 {
            return Err("room_busy");
        }
        binding.revision += 1;
        if matches!(
            action,
            HostAction::RouteWake | HostAction::PairFailed { .. }
        ) {
            binding.projection_floor = binding.revision;
        }
        if let Some(owner) = owner {
            binding.replies.insert(binding.revision, owner);
        }
        Ok((
            binding.session,
            HostInput {
                now,
                binding_id: binding.id,
                host_session_id: binding.session,
                revision: binding.revision,
                endpoints,
                action,
            },
        ))
    }

    pub fn snapshot(&self, member: Member, session: Uuid, available: bool) -> Option<RoomSnapshot> {
        if let Some(view) = self.projection.as_ref().and_then(|p| p.views.get(&session)) {
            let mut view = view.clone();
            view.room.available = available;
            return Some(view);
        }
        let manager = member.domain_owner || member.user_id == self.summary.creator_id;
        if self.summary.hidden && !manager {
            return None;
        }
        Some(RoomSnapshot {
            room: Room {
                delivery: None,
                id: self.summary.id.clone(),
                name: self.summary.name.clone(),
                creator_id: self.summary.creator_id,
                access: self.summary.access,
                hidden: self.summary.hidden,
                has_password: self.summary.has_password,
                authorized: manager || self.summary.access == RoomAccess::Public,
                can_manage: manager,
                available: false,
                reading: false,
                capabilities: RoomCapabilities { attachments: false },
                members: None,
            },
            files: vec![],
            publications: vec![],
            voice: vec![],
            subscriptions: vec![],
        })
    }
}
