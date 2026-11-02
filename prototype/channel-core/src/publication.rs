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
        helper: Option<Uuid>,
        legs: BTreeMap<Uuid, Shadow>,
    },
}

#[derive(Clone)]
struct Shadow {
    flow: Flow,
    replaces: Option<Uuid>,
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

    pub fn set_paused(&mut self, paused: bool) {
        self.info.paused = paused;
        if paused {
            // A deliberate pause withdraws an unproved change, not the live tree.
            self.operation = None;
        }
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
        helpers: &BTreeMap<Uuid, Uuid>,
        now: u64,
    ) {
        self.expire(now);
        let paths = if let Some(base) = base.filter(|_| self.info.kind == Kind::Voice) {
            base.project(self.plan.source, requested)
        } else {
            self.plan
                .reconcile(requested, available, connected, base, helpers);
            // An unproved input has no picture to preserve. A proved branch
            // instead keeps every incumbent lease until the shared switch.
            for (viewer, helper) in helpers {
                if let Some(parents) = self.plan.assisted(*viewer, *helper, connected, helpers) {
                    if self
                        .branch(&parents, requested)
                        .keys()
                        .all(|receiver| self.plan.readiness(*receiver).is_none())
                    {
                        self.plan.parents = parents;
                        self.plan
                            .reconcile(requested, available, connected, base, helpers);
                    }
                }
            }
            self.plan
                .parents
                .iter()
                .map(|(child, parent)| (*parent, *child))
                .collect()
        };
        self.reconcile_leases(&paths);
        if self.info.kind != Kind::Screen || self.info.paused {
            return;
        }
        if let Some(operation) = &self.operation {
            let current = match &operation.kind {
                OperationKind::Prepare { flow } => self.preparing_flows().any(|id| id == *flow),
                OperationKind::Switch { root, helper, legs } => {
                    self.current_switch(legs)
                        && match helper {
                            Some(helper) => {
                                helpers.get(root) == Some(helper)
                                    && self
                                        .plan
                                        .assisted(*root, *helper, connected, helpers)
                                        .is_some_and(|parents| {
                                            legs.iter().all(|(receiver, leg)| {
                                                parents.get(receiver) == Some(&leg.flow.sender)
                                            })
                                        })
                            }
                            None => self.plan.can_shortcut(*root, helpers),
                        }
                        && connected.contains(&self.plan.source)
                        && legs.iter().all(|(receiver, leg)| {
                            connected.contains(receiver)
                                && requested.contains(receiver) == leg.viewing
                        })
                }
            };
            if current && matches!(operation.kind, OperationKind::Switch { .. }) {
                return;
            }
            if !current {
                self.operation = None;
            }
        }
        if !connected.contains(&self.plan.source) {
            return;
        }
        let assisted = helpers.iter().find_map(|(viewer, helper)| {
            let parents = self.plan.assisted(*viewer, *helper, connected, helpers)?;
            let legs = self.branch(&parents, requested);
            (!legs.is_empty() && legs.keys().all(|receiver| connected.contains(receiver)))
                .then_some((*viewer, Some(*helper), legs))
        });
        if let Some((root, helper, legs)) = assisted {
            self.operation = Some(RouteOperation {
                deadline: now.saturating_add(SCREEN_PREPARE_MS),
                kind: OperationKind::Switch { root, helper, legs },
            });
            return;
        }
        if self.operation.is_some() {
            return;
        }
        let preparing = self.preparing_flows().next();
        if let Some(flow) = preparing {
            self.operation = Some(RouteOperation {
                deadline: now.saturating_add(SCREEN_PREPARE_MS),
                kind: OperationKind::Prepare { flow },
            });
            return;
        }
        let root = self
            .plan
            .shortcut_candidates(helpers)
            .into_iter()
            .find(|root| {
                !self.direct_attempted.contains(root)
                    && self.plan.subtree(*root).iter().all(|receiver| {
                        connected.contains(receiver)
                            && (!requested.contains(receiver)
                                || self.plan.readiness(*receiver) == Some(Readiness::Decoded))
                    })
            });
        let Some(root) = root else { return };
        let mut parents = self.plan.parents.clone();
        parents.insert(root, self.plan.source);
        let legs = self.branch(&parents, requested);
        self.direct_attempted.insert(root);
        self.operation = Some(RouteOperation {
            deadline: now.saturating_add(SCREEN_PREPARE_MS),
            kind: OperationKind::Switch {
                root,
                helper: None,
                legs,
            },
        });
    }

    fn branch(
        &self,
        parents: &BTreeMap<Uuid, Uuid>,
        requested: &BTreeSet<Uuid>,
    ) -> BTreeMap<Uuid, Shadow> {
        self.planned_flows(parents)
            .into_iter()
            .filter_map(|(receiver, mut flow)| {
                let replaces = self.leases.get(&receiver).map(|old| old.id);
                if replaces == Some(flow.id) {
                    return None;
                }
                flow.selected = false;
                Some((
                    receiver,
                    Shadow {
                        flow,
                        replaces,
                        viewing: requested.contains(&receiver),
                        proof: None,
                        presented: false,
                    },
                ))
            })
            .collect()
    }

    fn reconcile_leases(&mut self, paths: &BTreeSet<(Uuid, Uuid)>) {
        let parents = paths
            .iter()
            .map(|(parent, child)| (*child, *parent))
            .collect();
        let next = self.planned_flows(&parents);
        for (receiver, flow) in &next {
            if self.leases.get(receiver).map(|old| old.id) != Some(flow.id) {
                self.plan.forget_ready(*receiver);
            }
        }
        self.leases = next;
    }

    fn planned_flows(&self, parents: &BTreeMap<Uuid, Uuid>) -> BTreeMap<Uuid, Flow> {
        let mut next = BTreeMap::<Uuid, Flow>::new();
        let mut pending = VecDeque::from([self.plan.source]);
        while let Some(sender) = pending.pop_front() {
            let input_flow_id = next.get(&sender).map(|flow| flow.id);
            for (receiver, _) in parents.iter().filter(|(_, parent)| **parent == sender) {
                let lease = self
                    .leases
                    .get(receiver)
                    .filter(|flow| flow.sender == sender && flow.input_flow_id == input_flow_id)
                    .cloned()
                    .unwrap_or_else(|| Flow {
                        id: Uuid::new_v4(),
                        publication_id: self.info.id,
                        input_flow_id,
                        sender,
                        receiver: *receiver,
                        selected: true,
                        proof: None,
                        presented: None,
                        presentation: false,
                    });
                next.insert(*receiver, lease);
                pending.push_back(*receiver);
            }
        }
        next
    }

    fn preparing_flows(&self) -> impl Iterator<Item = Uuid> + '_ {
        self.plan
            .preparing_edges()
            .filter_map(|(_, child)| self.leases.get(&child).map(|f| f.id))
    }

    fn current_switch(&self, legs: &BTreeMap<Uuid, Shadow>) -> bool {
        legs.iter().all(|(receiver, leg)| {
            self.leases.get(receiver).map(|old| old.id) == leg.replaces
                && self
                    .leases
                    .get(receiver)
                    .is_none_or(|old| self.plan.parents.get(receiver) == Some(&old.sender))
        }) && self.leases.values().all(|flow| {
            legs.contains_key(&flow.receiver)
                || flow
                    .input_flow_id
                    .is_none_or(|input| !legs.values().any(|leg| leg.replaces == Some(input)))
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
            OperationKind::Switch { root, helper, .. } => {
                if let Some(helper) = helper {
                    self.plan.reject_parent(root, helper);
                }
                true
            }
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
            .map(|flow| {
                let mut flow = flow.clone();
                flow.proof = self.plan.readiness(flow.receiver).map(|proof| match proof {
                    Readiness::Forwardable => FlowState::Forwardable,
                    Readiness::Decoded => FlowState::Decoded,
                });
                flow
            })
            .chain(self.operation.iter().flat_map(|op| {
                match &op.kind {
                    OperationKind::Switch { legs, .. } => Some(legs.values()),
                    OperationKind::Prepare { .. } => None,
                }
                .into_iter()
                .flatten()
                .map(|leg| {
                    let mut flow = leg.flow.clone();
                    flow.proof = leg.proof.map(|proof| match proof {
                        Readiness::Forwardable => FlowState::Forwardable,
                        Readiness::Decoded => FlowState::Decoded,
                    });
                    flow.presented = Some(leg.presented);
                    flow
                })
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
            if let OperationKind::Switch { root, helper, .. } = self.operation.take().unwrap().kind
            {
                if let Some(helper) = helper {
                    self.plan.reject_parent(root, helper);
                }
            }
        }
        self.plan.failed_pair(first, second);
    }

    pub fn flow_state(
        &mut self,
        id: Uuid,
        receiver: Uuid,
        sender: Uuid,
        state: FlowState,
        now: u64,
    ) -> bool {
        if self.info.paused && state != FlowState::Failed {
            return false;
        }
        let expired = self.expire(now);
        if let Some(RouteOperation {
            kind: OperationKind::Switch { legs, .. },
            ..
        }) = &self.operation
        {
            if !self.current_switch(legs) {
                self.operation = None;
            }
        }
        if let Some(RouteOperation {
            deadline,
            kind: OperationKind::Switch { root, helper, legs },
        }) = &mut self.operation
        {
            if let Some(leg) = legs.get_mut(&receiver).filter(|leg| leg.flow.id == id) {
                match state {
                    FlowState::Failed => {
                        if let Some(helper) = helper {
                            self.plan.reject_parent(*root, *helper);
                        }
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
                if legs.iter().all(|(receiver, leg)| {
                    leg.proof.is_some()
                        && (!leg.viewing
                            || (leg.proof == Some(Readiness::Decoded)
                                && (self.plan.readiness(*receiver) != Some(Readiness::Decoded)
                                    || leg.presented)))
                }) {
                    let OperationKind::Switch { legs, .. } = self.operation.take().unwrap().kind
                    else {
                        unreachable!()
                    };
                    self.plan.adopt_branch(
                        legs.iter().map(|(receiver, leg)| {
                            (*receiver, leg.flow.sender, leg.proof.unwrap())
                        }),
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
