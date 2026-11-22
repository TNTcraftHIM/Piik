use crate::{
    routes::{Plan, Readiness, RelayLimits},
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
    pub reactions: crate::history::MessageReactions,
    plan: Plan,
    leases: BTreeMap<Uuid, Flow>,
    operation: Option<RouteOperation>,
    pub(crate) watch_order: Vec<Uuid>,
    direct_attempted: BTreeSet<Uuid>,
    transit_helpers: BTreeSet<Uuid>,
    // A route retry does not erase the watching page's last delivery result.
    failed_receivers: BTreeSet<Uuid>,
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
    Reduce {
        root: Uuid,
        legs: BTreeMap<Uuid, Shadow>,
    },
}

#[derive(Clone)]
struct Shadow {
    flow: Flow,
    replaces: Option<Uuid>,
    viewing: bool,
    proof: Option<Readiness>,
    presented_at: Option<u64>,
}

impl Shadow {
    fn record_proof(&mut self, state: FlowState, now: u64) -> bool {
        match state {
            FlowState::Forwardable => {
                self.proof = self.proof.max(Some(Readiness::Forwardable));
            }
            FlowState::Decoded => {
                self.proof = Some(Readiness::Decoded);
                self.presented_at = None;
            }
            FlowState::SwitchReady if self.viewing => {
                self.proof = Some(Readiness::Decoded);
                self.presented_at = Some(now);
            }
            FlowState::SwitchReady | FlowState::Failed => return false,
        }
        true
    }

    fn ready(&self, incumbent: Option<Readiness>, now: u64) -> bool {
        self.proof.is_some()
            && (!self.viewing
                || (self.proof == Some(Readiness::Decoded)
                    && (incumbent != Some(Readiness::Decoded)
                        || self
                            .presented_at
                            .is_some_and(|at| now.saturating_sub(at) < QUALITY_EVIDENCE_MS))))
    }
}

impl Publication {
    pub fn new(info: PublicationInfo) -> Self {
        Self {
            plan: Plan::new(info.session_id),
            info,
            reactions: Default::default(),
            leases: BTreeMap::new(),
            operation: None,
            watch_order: Vec::new(),
            direct_attempted: BTreeSet::new(),
            transit_helpers: BTreeSet::new(),
            failed_receivers: BTreeSet::new(),
        }
    }

    pub fn retain_sessions(&mut self, authorized: &BTreeSet<Uuid>) {
        self.transit_helpers.retain(|id| authorized.contains(id));
        self.direct_attempted
            .retain(|child| authorized.contains(child));
    }

    pub fn reset_routes(&mut self) {
        self.plan = Plan::new(self.info.session_id);
        self.operation = None;
        self.leases.clear();
        self.direct_attempted.clear();
        self.failed_receivers.clear();
        self.transit_helpers.clear();
    }

    pub fn retire_transport(&mut self, session: Uuid) {
        if self
            .flows()
            .any(|flow| !flow.selected && (flow.sender == session || flow.receiver == session))
        {
            self.operation = None;
        }
        self.plan.detach(session);
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
    pub fn forwarding_available(&mut self, sender: Uuid) {
        self.plan.retry_parent(sender);
    }

    pub fn delivery_failed(&self, receiver: Uuid) -> bool {
        self.failed_receivers.contains(&receiver)
    }

    fn fail_delivery(&mut self, receiver: Uuid) {
        if self.info.kind == Kind::Screen {
            self.failed_receivers.extend(self.plan.subtree(receiver));
        }
    }

    pub fn transfer_source(&mut self, session: Uuid) {
        self.operation = None;
        self.failed_receivers.clear();
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
            self.reset_routes();
        }
    }

    pub fn bound_screen_preparation(
        &mut self,
        limits: &RelayLimits,
        helpers: &BTreeMap<Uuid, Uuid>,
    ) {
        if self.info.kind != Kind::Screen || self.operation.is_none() {
            return;
        }
        let mut outputs = BTreeMap::<Uuid, (BTreeSet<Uuid>, bool)>::new();
        for flow in self.relay_flows(helpers) {
            let (peers, preparing) = outputs.entry(flow.sender).or_default();
            peers.insert(flow.receiver);
            *preparing |= !flow.selected;
        }
        if outputs.into_iter().any(|(sender, (mut peers, preparing))| {
            if let Some(shared) = limits.shared.get(&sender) {
                peers.extend(shared);
            }
            preparing && peers.len() > limits.get(sender, self.plan.source)
        }) {
            self.operation = None;
        }
    }

    pub fn relay_flows<'a>(
        &'a self,
        helpers: &'a BTreeMap<Uuid, Uuid>,
    ) -> impl Iterator<Item = Flow> + 'a {
        self.flows().filter(|flow| {
            flow.input_flow_id.is_some() && helpers.get(&flow.receiver) != Some(&flow.sender)
        })
    }

    pub fn reconcile(
        &mut self,
        requested: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        relays: &BTreeSet<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        now: u64,
    ) {
        self.watch_order.retain(|viewer| requested.contains(viewer));
        self.expire(now);
        self.failed_receivers
            .retain(|receiver| requested.contains(receiver));
        let confirmed = |parent, child| {
            neighbors
                .get(&parent)
                .is_some_and(|peers| peers.contains(&child))
        };
        self.transit_helpers
            .retain(|helper| self.plan.parents.values().any(|parent| parent == helper));
        self.transit_helpers.extend(helpers.values().copied());
        let relays: BTreeSet<_> = relays.union(&self.transit_helpers).copied().collect();
        let relays = &relays;
        let unavailable: Vec<_> = self
            .plan
            .parents
            .iter()
            .filter_map(|(&child, &parent)| {
                ((!confirmed(parent, child) && self.plan.readiness(child).is_none())
                    || (parent != self.plan.source
                        && !relays.contains(&parent)
                        && helpers.get(&child) != Some(&parent)))
                .then_some(child)
            })
            .collect();
        for child in unavailable {
            self.plan.detach(child);
        }
        if self.plan.capacity_children(helpers, limits).is_empty() {
            self.plan.parents = self.plan.activity_parents(
                requested,
                neighbors,
                relays,
                limits,
                helpers,
                &self.watch_order,
            );
        }
        for (viewer, helper) in helpers {
            if let Some(parents) = self
                .plan
                .through_relay(*viewer, *helper, connected, helpers, limits)
            {
                if parents.iter().all(|(&c, &p)| confirmed(p, c))
                    && self
                        .branch(&parents, requested)
                        .keys()
                        .all(|c| self.plan.readiness(*c).is_none())
                {
                    self.plan.parents = parents;
                }
            }
        }
        let mut needed = BTreeSet::new();
        for receiver in requested {
            let mut child = *receiver;
            while let Some(&parent) = self.plan.parents.get(&child) {
                if !needed.insert(child) {
                    break;
                }
                child = parent;
            }
        }
        self.plan.parents.retain(|child, _| needed.contains(child));
        self.reconcile_leases();
        if self.info.paused {
            return;
        }
        if matches!(
            self.operation.as_ref().map(|operation| &operation.kind),
            Some(OperationKind::Reduce { .. })
        ) {
            self.prepare_reduction(
                requested, connected, helpers, limits, neighbors, relays, now,
            );
            return;
        }
        if !self.plan.capacity_children(helpers, limits).is_empty() {
            self.operation = None;
            self.prepare_reduction(
                requested, connected, helpers, limits, neighbors, relays, now,
            );
            return;
        }
        if let Some(operation) = &self.operation {
            let current = match &operation.kind {
                OperationKind::Prepare { flow } => self.preparing_flows().any(|id| id == *flow),
                OperationKind::Reduce { .. } => unreachable!(),
                OperationKind::Switch { root, helper, legs } => {
                    self.current_switch(legs)
                        && match helper {
                            Some(helper) => {
                                helpers.get(root) == Some(helper)
                                    && self
                                        .plan
                                        .through_relay(*root, *helper, connected, helpers, limits)
                                        .is_some_and(|parents| {
                                            legs.iter().all(|(receiver, leg)| {
                                                parents.get(receiver) == Some(&leg.flow.sender)
                                            })
                                        })
                            }
                            None => self.plan.can_shortcut(*root, helpers, limits),
                        }
                        && connected.contains(&self.plan.source)
                        && legs.iter().all(|(receiver, leg)| {
                            confirmed(leg.flow.sender, *receiver)
                                && (self.info.kind == Kind::Screen && requested.contains(receiver))
                                    == leg.viewing
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
        if self.info.kind != Kind::Screen || !connected.contains(&self.plan.source) {
            return;
        }
        let assisted = helpers.iter().find_map(|(viewer, helper)| {
            let parents = self
                .plan
                .through_relay(*viewer, *helper, connected, helpers, limits)?;
            let legs = self.branch(&parents, requested);
            (!legs.is_empty()
                && legs
                    .iter()
                    .all(|(&receiver, leg)| confirmed(leg.flow.sender, receiver)))
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
            .shortcut_candidates(helpers, limits)
            .into_iter()
            .find(|root| {
                confirmed(self.plan.source, *root)
                    && !self.direct_attempted.contains(root)
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
                        viewing: self.info.kind == Kind::Screen && requested.contains(&receiver),
                        proof: None,
                        presented_at: None,
                    },
                ))
            })
            .collect()
    }

    fn prepare_reduction(
        &mut self,
        requested: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        relays: &BTreeSet<Uuid>,
        now: u64,
    ) {
        let pending = self
            .operation
            .as_ref()
            .and_then(|operation| match &operation.kind {
                OperationKind::Reduce { root, .. } => Some((*root, operation.deadline)),
                _ => None,
            });
        let excess = self.plan.capacity_children(helpers, limits);
        let Some(first) = excess.first().copied() else {
            self.operation = None;
            return;
        };
        let candidate = |root| {
            let mut eligible: BTreeSet<_> = neighbors
                .get(&root)
                .into_iter()
                .flatten()
                .filter(|peer| **peer == self.plan.source || relays.contains(peer))
                .copied()
                .collect();
            eligible.extend([self.plan.source, root]);
            self.plan
                .candidate_parent(root, &eligible, helpers, limits)
                .filter(|parent| {
                    neighbors
                        .get(&root)
                        .is_some_and(|peers| peers.contains(parent))
                })
        };
        let retained = pending.filter(|(root, _)| excess.contains(root));
        let retained_root = retained.map(|(root, _)| root);
        let feasible = retained_root
            .and_then(|root| candidate(root).map(|parent| (root, parent)))
            .or_else(|| {
                excess
                    .into_iter()
                    .find_map(|root| candidate(root).map(|parent| (root, parent)))
            });
        let (root, parent) = feasible
            .map(|(root, parent)| (root, Some(parent)))
            .unwrap_or((retained_root.unwrap_or(first), None));
        let deadline = retained.map_or(now.saturating_add(SCREEN_PREPARE_MS), |(_, deadline)| {
            deadline
        });
        let Some(parent) = parent else {
            self.operation = Some(RouteOperation {
                deadline,
                kind: OperationKind::Reduce {
                    root,
                    legs: BTreeMap::new(),
                },
            });
            return;
        };
        if let Some(RouteOperation {
            kind: OperationKind::Reduce { legs, .. },
            ..
        }) = &self.operation
        {
            if !legs.is_empty()
                && self.current_switch(legs)
                && legs.get(&root).is_some_and(|leg| leg.flow.sender == parent)
                && legs.iter().all(|(receiver, leg)| {
                    connected.contains(receiver)
                        && (self.info.kind == Kind::Screen && requested.contains(receiver))
                            == leg.viewing
                })
            {
                return;
            }
        }
        let mut parents = self.plan.parents.clone();
        parents.insert(root, parent);
        self.operation = Some(RouteOperation {
            deadline,
            kind: OperationKind::Reduce {
                root,
                legs: self.branch(&parents, requested),
            },
        });
    }

    fn adopt(&mut self, legs: BTreeMap<Uuid, Shadow>) {
        self.plan.adopt_branch(
            legs.iter()
                .map(|(receiver, leg)| (*receiver, leg.flow.sender, leg.proof.unwrap())),
        );
        for (receiver, mut leg) in legs {
            leg.flow.selected = true;
            self.leases.insert(receiver, leg.flow);
            self.failed_receivers.remove(&receiver);
        }
    }

    fn reconcile_leases(&mut self) {
        let next = self.planned_flows(&self.plan.parents);
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
            OperationKind::Reduce { root, .. } => {
                self.fail_delivery(root);
                if let Some(parent) = self.plan.parents.get(&root).copied() {
                    self.plan.failed(parent, root);
                }
                true
            }
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
                    self.fail_delivery(edge.1);
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
                    OperationKind::Switch { legs, .. } | OperationKind::Reduce { legs, .. } => {
                        Some(legs.values())
                    }
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
                    flow.presented = Some(leg.presented_at.is_some());
                    flow
                })
            }))
    }

    pub fn failed_pair(&mut self, first: Uuid, second: Uuid) {
        if let Some(receiver) = self.leases.values().find_map(|flow| {
            ((flow.sender == first && flow.receiver == second)
                || (flow.sender == second && flow.receiver == first))
                .then_some(flow.receiver)
        }) {
            self.fail_delivery(receiver);
        }
        if self.operation.as_ref().is_some_and(|op| match &op.kind {
            OperationKind::Switch { legs, .. } | OperationKind::Reduce { legs, .. } => {
                legs.values().any(|leg| {
                    (leg.flow.sender == first && leg.flow.receiver == second)
                        || (leg.flow.sender == second && leg.flow.receiver == first)
                })
            }
            OperationKind::Prepare { .. } => false,
        }) {
            match self.operation.take().unwrap() {
                RouteOperation {
                    kind:
                        OperationKind::Switch {
                            root,
                            helper: Some(helper),
                            ..
                        },
                    ..
                } => self.plan.reject_parent(root, helper),
                RouteOperation {
                    deadline,
                    kind: OperationKind::Reduce { root, legs },
                } => {
                    if let Some(leg) = legs.get(&root) {
                        self.plan.reject_parent(root, leg.flow.sender);
                    }
                    self.operation = Some(RouteOperation {
                        deadline,
                        kind: OperationKind::Reduce {
                            root,
                            legs: BTreeMap::new(),
                        },
                    });
                }
                _ => {}
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
            kind: OperationKind::Reduce { root, legs },
            ..
        }) = &mut self.operation
        {
            if let Some(leg) = legs
                .get_mut(&receiver)
                .filter(|leg| leg.flow.id == id && leg.flow.sender == sender)
            {
                if state == FlowState::Failed {
                    if let Some(candidate) = legs.get(root) {
                        self.plan.reject_parent(*root, candidate.flow.sender);
                    }
                    legs.clear();
                    return true;
                }
                if !leg.record_proof(state, now) {
                    return false;
                }
                if legs
                    .iter()
                    .all(|(receiver, leg)| leg.ready(self.plan.readiness(*receiver), now))
                {
                    let OperationKind::Reduce { legs, .. } = self.operation.take().unwrap().kind
                    else {
                        unreachable!()
                    };
                    self.adopt(legs);
                }
                return true;
            }
        }
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
            kind: OperationKind::Switch { root, helper, legs },
            ..
        }) = &mut self.operation
        {
            if let Some(leg) = legs.get_mut(&receiver).filter(|leg| leg.flow.id == id) {
                if state == FlowState::Failed {
                    if let Some(helper) = helper {
                        self.plan.reject_parent(*root, *helper);
                    }
                    self.operation = None;
                    return true;
                }
                if !leg.record_proof(state, now) {
                    return false;
                }
                if legs
                    .iter()
                    .all(|(receiver, leg)| leg.ready(self.plan.readiness(*receiver), now))
                {
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
                        if leg.proof == Some(Readiness::Decoded) {
                            self.failed_receivers.remove(&receiver);
                        }
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
            FlowState::Decoded => {
                let changed = self.plan.mark_ready(receiver, sender, Readiness::Decoded);
                let recovered = self.plan.readiness(receiver) == Some(Readiness::Decoded)
                    && self.failed_receivers.remove(&receiver);
                changed || recovered
            }
            FlowState::Failed => {
                self.fail_delivery(receiver);
                self.plan.failed(sender, receiver);
                true
            }
            FlowState::SwitchReady => false,
        }
    }
}
