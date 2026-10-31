use crate::{
    identity::Endpoint,
    routes::{BaseTree, Plan, Readiness},
    transport::Flow,
    wire::{FlowState, Kind, PublicationInfo},
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use uuid::Uuid;

pub(crate) const SCREEN_PREPARE_MS: u64 = 20_000;
// Same lifetime as the existing viewer-quality evidence contract.
const QUALITY_EVIDENCE_MS: u64 = 5_000;

/// One committed tree and at most one prepared change. Flow identity includes
/// its input: promoting a prepared branch never rebinds a live sender.
#[derive(Clone)]
pub(crate) struct Publication {
    pub info: PublicationInfo,
    plan: Plan,
    leases: BTreeMap<Uuid, Flow>,
    operation: Option<RouteOperation>,
    direct_attempted: BTreeSet<Uuid>,
}

#[derive(Clone)]
struct RouteOperation {
    deadline: u64,
    kind: OperationKind,
}

#[derive(Clone)]
enum OperationKind {
    Prepare {
        flow: Uuid,
    },
    Switch {
        root: Uuid,
        legs: BTreeMap<Uuid, Shadow>,
    },
}

#[derive(Clone)]
struct Shadow {
    flow: Flow,
    replaces: Uuid,
    viewing: bool,
    proof: Option<Readiness>,
    presented: bool,
}

impl Publication {
    pub fn new(info: PublicationInfo) -> Self {
        Self {
            plan: Plan::new(info.session_id),
            info,
            leases: BTreeMap::new(),
            operation: None,
            direct_attempted: BTreeSet::new(),
        }
    }

    pub fn retain_sessions(&mut self, endpoints: &BTreeMap<Uuid, Endpoint>) {
        self.direct_attempted
            .retain(|child| endpoints.contains_key(child));
    }

    pub fn needs_repair(&self, requested: &BTreeSet<Uuid>, connected: &BTreeSet<Uuid>) -> bool {
        self.plan.needs_repair(requested, connected)
    }

    pub fn retry_required(&mut self, requested: &BTreeSet<Uuid>, connected: &BTreeSet<Uuid>) {
        self.plan.retry_required(requested, connected);
    }

    pub fn transfer_source(&mut self, session: Uuid) {
        self.operation = None;
        if self.info.session_id == session {
            // Retain proven paths; old-source preparation must prove a new lease.
            let preparing: BTreeSet<_> = self
                .plan
                .preparing_edges()
                .map(|(_, child)| child)
                .collect();
            self.leases.retain(|child, _| !preparing.contains(child));
        } else {
            self.info.session_id = session;
            self.plan = Plan::new(session);
            self.leases.clear();
            self.direct_attempted.clear();
        }
    }

    pub fn reconcile(
        &mut self,
        requested: &BTreeSet<Uuid>,
        available: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        base: Option<&BaseTree>,
        now: u64,
    ) {
        self.expire(now);
        let paths = if let Some(base) = base.filter(|_| self.info.kind == Kind::Voice) {
            base.project(self.plan.source, requested)
        } else {
            self.plan.reconcile(requested, available, connected, base);
            self.plan
                .parents
                .iter()
                .map(|(child, parent)| (*parent, *child))
                .collect()
        };
        self.reconcile_leases(&paths);
        if self.info.kind != Kind::Screen {
            return;
        }
        if let Some(operation) = &self.operation {
            let current = match &operation.kind {
                OperationKind::Prepare { flow } => self.preparing_flows().any(|id| id == *flow),
                OperationKind::Switch { root, legs } => {
                    self.current_switch(*root, legs)
                        && connected.contains(&self.plan.source)
                        && legs.iter().all(|(receiver, leg)| {
                            connected.contains(receiver)
                                && requested.contains(receiver) == leg.viewing
                        })
                }
            };
            if current {
                return;
            }
            self.operation = None;
        }
        let preparing = self.preparing_flows().next();
        if let Some(flow) = preparing {
            self.operation = Some(RouteOperation {
                deadline: now.saturating_add(SCREEN_PREPARE_MS),
                kind: OperationKind::Prepare { flow },
            });
            return;
        }
        if !connected.contains(&self.plan.source) {
            return;
        }
        let root = self.plan.shortcut_candidates().into_iter().find(|root| {
            !self.direct_attempted.contains(root)
                && self.plan.subtree(*root).iter().all(|receiver| {
                    connected.contains(receiver)
                        && (!requested.contains(receiver)
                            || self.plan.readiness(*receiver) == Some(Readiness::Decoded))
                })
        });
        let Some(root) = root else { return };
        let mut legs = BTreeMap::<Uuid, Shadow>::new();
        for receiver in self.plan.subtree(root) {
            let old = &self.leases[&receiver];
            let sender = if receiver == root {
                self.plan.source
            } else {
                old.sender
            };
            legs.insert(
                receiver,
                Shadow {
                    flow: Flow {
                        id: Uuid::new_v4(),
                        publication_id: self.info.id,
                        input_flow_id: (receiver != root).then(|| legs[&sender].flow.id),
                        sender,
                        receiver,
                        selected: false,
                    },
                    replaces: old.id,
                    viewing: requested.contains(&receiver),
                    proof: None,
                    presented: false,
                },
            );
        }
        self.direct_attempted.insert(root);
        self.operation = Some(RouteOperation {
            deadline: now.saturating_add(SCREEN_PREPARE_MS),
            kind: OperationKind::Switch { root, legs },
        });
    }

    fn reconcile_leases(&mut self, paths: &BTreeSet<(Uuid, Uuid)>) {
        let mut next = BTreeMap::<Uuid, Flow>::new();
        let mut pending = VecDeque::from([self.plan.source]);
        while let Some(sender) = pending.pop_front() {
            let input_flow_id = next.get(&sender).map(|flow| flow.id);
            for (_, receiver) in paths.iter().filter(|(parent, _)| *parent == sender) {
                let lease = self
                    .leases
                    .remove(receiver)
                    .filter(|flow| flow.sender == sender && flow.input_flow_id == input_flow_id)
                    .unwrap_or_else(|| {
                        self.plan.forget_ready(*receiver);
                        Flow {
                            id: Uuid::new_v4(),
                            publication_id: self.info.id,
                            input_flow_id,
                            sender,
                            receiver: *receiver,
                            selected: true,
                        }
                    });
                next.insert(*receiver, lease);
                pending.push_back(*receiver);
            }
        }
        self.leases = next;
    }

    fn preparing_flows(&self) -> impl Iterator<Item = Uuid> + '_ {
        self.plan
            .preparing_edges()
            .filter_map(|(_, child)| self.leases.get(&child).map(|f| f.id))
    }

    fn current_switch(&self, root: Uuid, legs: &BTreeMap<Uuid, Shadow>) -> bool {
        self.plan.can_shortcut(root)
            && self.plan.preparing_edges().next().is_none()
            && self.plan.subtree(root).len() == legs.len()
            && legs.iter().all(|(receiver, leg)| {
                self.leases.get(receiver).is_some_and(|old| {
                    old.id == leg.replaces && self.plan.parents.get(receiver) == Some(&old.sender)
                })
            })
    }

    pub fn deadline(&self) -> Option<u64> {
        self.operation.as_ref().map(|op| op.deadline)
    }

    pub fn expire(&mut self, now: u64) -> bool {
        if self.deadline().is_none_or(|deadline| deadline > now) {
            return false;
        }
        match self.operation.take().unwrap().kind {
            OperationKind::Switch { .. } => true,
            OperationKind::Prepare { flow } => {
                let expired = self.plan.preparing_edges().find(|(_, child)| {
                    self.leases.get(child).is_some_and(|lease| lease.id == flow)
                });
                if let Some(edge) = expired {
                    self.plan.failed(edge.0, edge.1);
                    true
                } else {
                    false
                }
            }
        }
    }

    pub fn flows(&self) -> impl Iterator<Item = Flow> + '_ {
        self.leases
            .values()
            .cloned()
            .chain(self.operation.iter().flat_map(|op| {
                match &op.kind {
                    OperationKind::Switch { legs, .. } => Some(legs.values()),
                    OperationKind::Prepare { .. } => None,
                }
                .into_iter()
                .flatten()
                .map(|leg| leg.flow.clone())
            }))
    }

    pub fn failed_pair(&mut self, first: Uuid, second: Uuid) {
        if self.operation.as_ref().is_some_and(|op| match &op.kind {
            OperationKind::Switch { legs, .. } => legs.values().any(|leg| {
                (leg.flow.sender == first && leg.flow.receiver == second)
                    || (leg.flow.sender == second && leg.flow.receiver == first)
            }),
            OperationKind::Prepare { .. } => false,
        }) {
            self.operation = None;
        }
        self.plan.failed(first, second);
    }

    pub fn flow_state(
        &mut self,
        id: Uuid,
        receiver: Uuid,
        sender: Uuid,
        state: FlowState,
        now: u64,
    ) -> bool {
        let expired = self.expire(now);
        if let Some(RouteOperation {
            kind: OperationKind::Switch { root, legs },
            ..
        }) = &self.operation
        {
            if !self.current_switch(*root, legs) {
                self.operation = None;
            }
        }
        if let Some(RouteOperation {
            deadline,
            kind: OperationKind::Switch { legs, .. },
        }) = &mut self.operation
        {
            if let Some(leg) = legs.get_mut(&receiver).filter(|leg| leg.flow.id == id) {
                match state {
                    FlowState::Failed => {
                        self.operation = None;
                        return true;
                    }
                    FlowState::Forwardable => {
                        leg.proof = leg.proof.max(Some(Readiness::Forwardable))
                    }
                    FlowState::Decoded => leg.proof = Some(Readiness::Decoded),
                    FlowState::SwitchReady if leg.viewing => {
                        leg.proof = Some(Readiness::Decoded);
                        leg.presented = true;
                        *deadline = (*deadline).min(now.saturating_add(QUALITY_EVIDENCE_MS));
                    }
                    FlowState::SwitchReady => return false,
                }
                if legs
                    .values()
                    .all(|leg| leg.proof.is_some() && (!leg.viewing || leg.presented))
                {
                    let OperationKind::Switch { root, legs } = self.operation.take().unwrap().kind
                    else {
                        unreachable!()
                    };
                    self.plan.adopt_branch(
                        root,
                        legs.iter()
                            .map(|(receiver, leg)| (*receiver, leg.proof.unwrap())),
                    );
                    for (receiver, mut leg) in legs {
                        leg.flow.selected = true;
                        self.leases.insert(receiver, leg.flow);
                    }
                    return true;
                }
                return false;
            }
        }
        if !self.leases.get(&receiver).is_some_and(|flow| flow.id == id) {
            return expired;
        }
        match state {
            FlowState::Forwardable => {
                self.plan
                    .mark_ready(receiver, sender, Readiness::Forwardable)
            }
            FlowState::Decoded => self.plan.mark_ready(receiver, sender, Readiness::Decoded),
            FlowState::Failed if self.info.kind == Kind::Screen => {
                self.plan.failed(sender, receiver);
                true
            }
            FlowState::Failed => self.plan.mark_unready(receiver, sender),
            FlowState::SwitchReady => false,
        }
    }
}
