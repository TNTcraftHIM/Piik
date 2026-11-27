use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct RelayLimits {
    /// A relay that a new assignment gives only receivers no participant path reaches,
    /// taking a scarce output from a participant path only when that serves more
    /// receivers. A complete incumbent path through it is kept like any other.
    pub fallback: Option<Uuid>,
    pub shared: BTreeMap<Uuid, BTreeSet<Uuid>>,
    pub source_direct_limit: Option<usize>,
    pub default: usize,
    pub overrides: BTreeMap<Uuid, usize>,
}
impl Default for RelayLimits {
    fn default() -> Self {
        Self {
            fallback: None,
            shared: Default::default(),
            source_direct_limit: None,
            default: 2,
            overrides: BTreeMap::new(),
        }
    }
}
impl RelayLimits {
    pub fn get(&self, endpoint: Uuid, source: Uuid) -> usize {
        if endpoint == source {
            return self.source_direct_limit.unwrap_or(self.default);
        }
        self.overrides.get(&endpoint).copied().unwrap_or(self.default)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Readiness {
    Forwardable,
    Decoded,
}

/// One source owns one acyclic tree. Shared physical transport ownership lives
/// above these plans: a source retiring must not close another source's pair.
#[derive(Clone)]
pub struct Plan {
    pub source: Uuid,
    pub parents: BTreeMap<Uuid, Uuid>,
    ready: BTreeMap<Uuid, Readiness>,
    // A refused parent retains the physical edge whose media attempt failed.
    failed_parents: BTreeMap<Uuid, BTreeMap<Uuid, (Uuid, Uuid)>>,
}

pub(crate) struct ScreenDemand<'a> {
    pub order: &'a [Uuid],
    pub neighbors: &'a BTreeMap<Uuid, BTreeSet<Uuid>>,
    pub relays: &'a BTreeSet<Uuid>,
}

/// Select one activity's child-to-parent paths on the room's authorized confirmed pairs.
/// Byte owners pass their still-granted assignments for this source in `selected`.
/// Refusals identify directed (sender, receiver) outputs of this activity.
pub(crate) fn activity_parents(
    source: Uuid,
    receivers: &BTreeSet<Uuid>,
    selected: &BTreeMap<Uuid, Uuid>,
    neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
    relays: &BTreeSet<Uuid>,
    limits: &RelayLimits,
    refused: &BTreeSet<(Uuid, Uuid)>,
) -> BTreeMap<Uuid, Uuid> {
    let mut plan = Plan::new(source);
    for &(parent, child) in refused {
        plan.reject_parent(child, parent);
    }

    let order: Vec<_> = receivers.iter().copied().collect();
    let graph = ScreenDemand {
        order: &order,
        neighbors,
        relays,
    };
    plan.select_activity_paths(selected, &graph, &BTreeMap::new(), limits, |_| true)
}

/// One byte activity's distribution tree: the root its branches were selected
/// from, child-to-parent branches, and directed outputs refused by forwarders.
/// Files and watch bytes each own one; their owners supply receivers and policy.
#[derive(Clone, Default)]
pub(crate) struct ByteTree {
    source: Option<Uuid>,
    parents: BTreeMap<Uuid, Uuid>,
    refused: BTreeSet<(Uuid, Uuid)>,
}
impl ByteTree {
    pub fn source(&self) -> Option<Uuid> {
        self.source
    }
    /// Current branches are extended only when they grew from the same root.
    pub fn branches(
        &self,
        source: Uuid,
        receivers: &BTreeSet<Uuid>,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        relays: &BTreeSet<Uuid>,
        limits: &RelayLimits,
    ) -> BTreeMap<Uuid, Uuid> {
        let empty = BTreeMap::new();
        let selected = if self.source == Some(source) { &self.parents } else { &empty };
        activity_parents(source, receivers, selected, neighbors, relays, limits, &self.refused)
    }
    pub fn commit(&mut self, source: Option<Uuid>, parents: BTreeMap<Uuid, Uuid>) {
        self.source = source;
        self.parents = parents;
    }
    pub fn clear_branches(&mut self) {
        self.parents.clear();
        self.refused.clear();
    }
    /// Records a forwarder refusing a branch this tree assigned to it from `source`.
    pub fn refuse(&mut self, source: Uuid, sender: Uuid, downstream: Uuid) -> bool {
        let assigned = self.source == Some(source) && self.parents.get(&downstream) == Some(&sender);
        if assigned {
            self.refused.insert((sender, downstream));
        }
        assigned
    }
    pub fn retain_refused(&mut self, receivers: &BTreeSet<Uuid>, routable: impl Fn(&Uuid) -> bool) {
        self.refused
            .retain(|(sender, peer)| !receivers.is_empty() && routable(sender) && routable(peer));
    }
    pub fn forwarding_available(&mut self, sender: Uuid) {
        self.refused.retain(|(from, _)| *from != sender);
    }
    pub fn retire_pair(&mut self, first: Uuid, second: Uuid) -> bool {
        for (child, parent) in [(first, second), (second, first)] {
            if self.parents.get(&child) == Some(&parent) {
                self.parents.remove(&child);
                return true;
            }
        }
        false
    }
    pub fn retire_endpoint(&mut self, endpoint: Uuid) {
        self.parents.retain(|child, parent| *child != endpoint && *parent != endpoint);
    }
    pub fn waiting(&self, receivers: &BTreeSet<Uuid>) -> bool {
        self.source.is_some_and(|source| {
            receivers
                .iter()
                .any(|peer| *peer != source && !self.parents.contains_key(peer))
        })
    }
    pub fn collect_frontiers(
        &self,
        receivers: &BTreeSet<Uuid>,
        unavailable: &BTreeSet<(Uuid, Uuid)>,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        relays: &BTreeSet<Uuid>,
        limits: &RelayLimits,
        frontiers: &mut Vec<crate::host::DeliveryFrontier>,
    ) {
        if let Some(source) = self.source {
            Plan::byte_frontiers(source, receivers, &self.parents, &self.refused, unavailable,
                neighbors, relays, limits, frontiers);
        }
    }
    /// `session`'s (upstream, downstream, receiving) place under the root its
    /// owner announces, or `None` when it takes no part in this activity.
    pub fn branch(
        &self,
        source: Option<Uuid>,
        receivers: &BTreeSet<Uuid>,
        session: Uuid,
    ) -> Option<(Option<Uuid>, Vec<Uuid>, bool)> {
        if receivers.is_empty() {
            return None;
        }
        let upstream = self.parents.get(&session).copied();
        let downstream: Vec<_> = self
            .parents
            .iter()
            .filter_map(|(child, parent)| (*parent == session).then_some(*child))
            .collect();
        let receiving = receivers.contains(&session);
        (receiving || source == Some(session) || upstream.is_some() || !downstream.is_empty())
            .then_some((upstream, downstream, receiving))
    }
}

impl Plan {
    pub(crate) fn activity_parents(
        &self,
        receivers: &BTreeSet<Uuid>,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        relays: &BTreeSet<Uuid>,
        limits: &RelayLimits,
        helpers: &BTreeMap<Uuid, Uuid>,
        order: &[Uuid],
    ) -> BTreeMap<Uuid, Uuid> {
        let mut remaining = receivers.clone();
        let mut requested: Vec<_> = order
            .iter()
            .copied()
            .filter(|id| remaining.remove(id))
            .collect();
        requested.extend(remaining);
        let graph = ScreenDemand {
            order: &requested,
            neighbors,
            relays,
        };
        let mut plan = Plan::new(self.source);
        plan.failed_parents.clone_from(&self.failed_parents);
        plan.select_activity_paths(&self.parents, &graph, helpers, limits, |child| {
            self.ready.contains_key(&child)
        })
    }

    fn select_activity_paths(
        mut self,
        selected: &BTreeMap<Uuid, Uuid>,
        graph: &ScreenDemand<'_>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
        live_input: impl Fn(Uuid) -> bool,
    ) -> BTreeMap<Uuid, Uuid> {
        // Keep complete incumbent paths first. A receiver that left can still be transit.
        for &receiver in graph.order {
            let mut child = receiver;
            let mut branch = Vec::new();
            while child != self.source {
                let Some(&parent) = selected.get(&child) else {
                    break;
                };
                if branch.len() >= selected.len()
                    || (parent != self.source && !graph.relays.contains(&parent))
                    || helpers
                        .get(&parent)
                        .is_some_and(|helper| selected.get(&parent) == Some(helper))
                    || !(graph
                        .neighbors
                        .get(&parent)
                        .is_some_and(|peers| peers.contains(&child))
                        || (live_input(receiver) && live_input(child)))
                    || self
                        .failed_parents
                        .get(&child)
                        .is_some_and(|failed| failed.contains_key(&parent))
                    || !self.admitted_output(parent, child, helpers, limits)
                {
                    break;
                }
                branch.push((child, parent));
                child = parent;
            }
            if child == self.source {
                self.parents.extend(branch);
            }
        }
        // A surviving assignment can serve its existing receiver through a signaling outage.
        // The scratch plan carries no payload proofs, so BFS only extends confirmed prefixes.
        // Participants serve first; the fallback reaches only receivers they leave waiting.
        // The joint tree, where the fallback may take a scarce slot, wins only by serving more.
        let first = limits.fallback.filter(|id| graph.relays.contains(id)).map(|fallback| {
            let mut participants = graph.relays.clone();
            participants.remove(&fallback);
            let mut first = self.clone();
            first.extend_confirmed(&ScreenDemand { relays: &participants, ..*graph }, helpers, limits);
            first.extend_confirmed(graph, helpers, limits);
            first
        });
        self.extend_confirmed(graph, helpers, limits);
        let served = |plan: &Plan| graph.order.iter().filter(|r| plan.parents.contains_key(r)).count();
        match first {
            Some(first) if served(&first) >= served(&self) => first.parents,
            _ => self.parents,
        }
    }

    pub fn new(source: Uuid) -> Self {
        Self {
            source,
            parents: BTreeMap::new(),
            ready: BTreeMap::new(),
            failed_parents: BTreeMap::new(),
        }
    }

    fn rooted_ready(&self, mut endpoint: Uuid) -> bool {
        let mut path = BTreeSet::new();
        while endpoint != self.source {
            if !path.insert(endpoint) || !self.ready.contains_key(&endpoint) {
                return false;
            }
            let Some(parent) = self.parents.get(&endpoint) else {
                return false;
            };
            endpoint = *parent;
        }
        true
    }

    fn confirmed_path(&self, mut child: Uuid, screen: &ScreenDemand<'_>) -> bool {
        while child != self.source {
            let Some(parent) = self.parents.get(&child) else {
                return false;
            };
            if !screen
                .neighbors
                .get(&child)
                .is_some_and(|peers| peers.contains(parent))
            {
                return false;
            }
            child = *parent;
        }
        true
    }

    /// Append branches on confirmed room pairs. The incumbent and its media
    /// proofs are read-only inputs to all candidates.
    fn extend_confirmed(
        &mut self,
        screen: &ScreenDemand<'_>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) {
        let waiting: Vec<_> = screen
            .order
            .iter()
            .copied()
            .filter(|peer| {
                !self.parents.contains_key(peer)
                    && screen.neighbors.contains_key(peer)
                    && *peer != self.source
            })
            .collect();
        if waiting.is_empty() {
            return;
        }
        let fill = |plan: &mut Plan, order: &[Uuid]| {
            for &viewer in order {
                plan.append_path(viewer, screen, helpers, limits);
            }
        };
        let rank = |plan: &Plan| {
            let served: Vec<_> = waiting
                .iter()
                .map(|v| plan.parents.contains_key(v))
                .collect();
            let hops: usize = waiting
                .iter()
                .filter(|v| plan.parents.contains_key(v))
                .map(|v| {
                    std::iter::successors(Some(*v), |p| plan.parents.get(p).copied()).count() - 1
                })
                .sum();
            (
                served.iter().filter(|covered| **covered).count(),
                served,
                Reverse(plan.parents.len()),
                Reverse(hops),
            )
        };
        let mut best = self.clone();
        fill(&mut best, &waiting);
        // Direct inputs attain full coverage with one new edge and one hop per viewer.
        if waiting
            .iter()
            .all(|viewer| best.parents.get(viewer) == Some(&self.source))
        {
            self.parents = best.parents;
            return;
        }
        // Each shared relay candidate gets first use of a
        // scarce slot. Compare complete trees after filling other demand.
        let mut best_score = rank(&best);
        for relay in screen.relays {
            if *relay == self.source
                || self.parents.contains_key(relay)
                || self.is_display(*relay, helpers)
            {
                continue;
            }
            let Some(peers) = screen.neighbors.get(relay) else {
                continue;
            };
            let limit = limits.get(*relay, self.source);
            if limit == 0 {
                continue;
            }
            let shared = limits.shared.get(relay);
            let mut remaining = limit.saturating_sub(shared.map_or(0, BTreeSet::len));
            let mut viewers = Vec::new();
            for &viewer in &waiting {
                if !peers.contains(&viewer)
                    || self
                        .failed_parents
                        .get(&viewer)
                        .is_some_and(|failed| failed.contains_key(relay))
                {
                    continue;
                }
                if !shared.is_some_and(|peers| peers.contains(&viewer)) {
                    if remaining == 0 {
                        continue;
                    }
                    remaining -= 1;
                }
                viewers.push(viewer);
            }
            if viewers.len() + usize::from(waiting.contains(relay)) < 2 {
                continue;
            }
            let mut candidate = self.clone();
            if !candidate.append_path(*relay, screen, helpers, limits)
                || candidate.is_display(*relay, helpers)
            {
                continue;
            }
            for viewer in viewers {
                candidate.parents.entry(viewer).or_insert(*relay);
            }
            fill(&mut candidate, &waiting);
            let score = rank(&candidate);
            if score > best_score {
                best_score = score;
                best = candidate;
            }
        }
        // A leaf can end a capacity-limited path. Try narrower interior vertices first.
        if best_score.0 < waiting.len() {
            let mut order = waiting.clone();
            order.sort_by_key(|viewer| {
                let degree = screen.neighbors[viewer].len();
                (degree <= 1, degree)
            });
            let mut candidate = self.clone();
            fill(&mut candidate, &order);
            if rank(&candidate) > best_score {
                best = candidate;
            }
        }
        self.parents = best.parents;
    }

    fn append_path(
        &mut self,
        target: Uuid,
        screen: &ScreenDemand<'_>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> bool {
        if self.parents.contains_key(&target) {
            return true;
        }
        let mut queue = VecDeque::from([self.source]);
        let mut visited = BTreeSet::from([self.source]);
        // Shortest added branches can start at any installed, usable prefix.
        for peer in self.subtree(self.source).into_iter().skip(1) {
            if self.rooted_ready(peer) || self.confirmed_path(peer, screen) {
                queue.push_back(peer);
                visited.insert(peer);
            }
        }
        let mut previous = BTreeMap::new();
        while let Some(parent) = queue.pop_front() {
            if (parent != self.source && !screen.relays.contains(&parent))
                || self.is_display(parent, helpers)
                || previous
                    .get(&parent)
                    .is_some_and(|upstream| helpers.get(&parent) == Some(upstream))
            {
                continue;
            }
            for &child in screen.neighbors.get(&parent).into_iter().flatten() {
                if self.parents.contains_key(&child)
                    || !self.allowed_branch(parent, child, helpers, limits)
                    || !visited.insert(child)
                {
                    continue;
                }
                previous.insert(child, parent);
                if child == target {
                    let mut next = child;
                    while let Some(&upstream) = previous.get(&next) {
                        self.parents.insert(next, upstream);
                        next = upstream;
                    }
                    return true;
                }
                queue.push_back(child);
            }
        }
        false
    }

    pub(crate) fn delivery_frontiers(
        &self,
        receivers: &BTreeSet<Uuid>,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        relays: &BTreeSet<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
        frontiers: &mut Vec<crate::host::DeliveryFrontier>,
    ) {
        if neighbors.is_empty() {
            return;
        }
        // With an empty incumbent tree, one available output per sender suffices for
        // any simple confirmed path. Ordinary channel gap repair already serves that case.
        if self.parents.is_empty()
            && self.failed_parents.is_empty()
            && helpers.is_empty()
            && limits.get(self.source, self.source) > 0
            && relays.iter().all(|&id| {
                id == self.source
                    || limits.get(id, self.source) > limits.shared.get(&id).map_or(0, BTreeSet::len)
            })
        {
            return;
        }
        let mut waiting: BTreeSet<_> = receivers
            .iter()
            .copied()
            .filter(|id| *id != self.source && !self.parents.contains_key(id))
            .collect();
        if waiting.is_empty() {
            return;
        }
        let allowed = |from: Uuid, to: Uuid| {
            from != to
                && to != self.source
                && (from == self.source || relays.contains(&from))
                && self.parents.get(&to).is_none_or(|owner| *owner == from)
                && self.allowed_branch(from, to, helpers, limits)
        };
        let mut before = BTreeMap::from([(self.source, self.source)]);
        let mut queue = VecDeque::from([self.source]);
        while let Some(at) = queue.pop_front() {
            for &next in neighbors.get(&at).into_iter().flatten() {
                if allowed(at, next) {
                    waiting.remove(&next);
                    if relays.contains(&next)
                        && helpers.get(&next) != Some(&at)
                        && !before.contains_key(&next)
                    {
                        before.insert(next, at);
                        queue.push_back(next);
                    }
                }
            }
        }
        if waiting.is_empty() {
            return;
        }
        // The room's parents are a single tree for all receivers. Describe its reachable
        // prefix once. Each remaining confirmed arc is represented by two compact indices.
        let mut outside = waiting.clone();
        outside.extend(relays.iter().filter(|id| !before.contains_key(id)).copied());
        let after: Vec<_> = outside.into_iter().collect();
        let mut suffix = vec![0u8; (after.len() * after.len()).div_ceil(8)];
        let mut terminal = BTreeSet::new();
        for (i, &from) in after.iter().enumerate() {
            for &to in neighbors.get(&from).into_iter().flatten() {
                let Ok(j) = after.binary_search(&to) else {
                    continue;
                };
                if allowed(from, to) {
                    let arc = (i as u8, j as u8);
                    if helpers.get(&to) == Some(&from) {
                        terminal.insert(arc);
                    } else {
                        let bit = i * after.len() + j;
                        suffix[bit / 8] |= 1 << (bit % 8);
                    }
                }
            }
        }
        let mut bridges = vec![0u8; (before.len() * after.len()).div_ceil(8)];
        let mut terminal_bridges = BTreeSet::new();
        for (i, &from) in before.keys().enumerate() {
            for (j, &to) in after.iter().enumerate() {
                if allowed(from, to)
                    && !neighbors
                        .get(&from)
                        .is_some_and(|peers| peers.contains(&to))
                {
                    let bit = i * after.len() + j;
                    if helpers.get(&to) == Some(&from) {
                        terminal_bridges.insert((i as u8, j as u8));
                    } else {
                        bridges[bit / 8] |= 1 << (bit % 8);
                    }
                }
            }
        }
        if bridges.iter().any(|&b| b != 0) || !terminal_bridges.is_empty() {
            let frontier = crate::host::DeliveryFrontier {
                source: self.source,
                waiting,
                before,
                after,
                suffix,
                terminal,
                bridges,
                terminal_bridges,
            };
            if !frontiers.contains(&frontier) {
                frontiers.push(frontier);
            }
        }
    }

    pub(crate) fn byte_frontiers(
        source: Uuid,
        receivers: &BTreeSet<Uuid>,
        parents: &BTreeMap<Uuid, Uuid>,
        refused: &BTreeSet<(Uuid, Uuid)>,
        unavailable: &BTreeSet<(Uuid, Uuid)>,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        relays: &BTreeSet<Uuid>,
        limits: &RelayLimits,
        frontiers: &mut Vec<crate::host::DeliveryFrontier>,
    ) {
        let mut plan = Self::new(source);
        plan.parents.clone_from(parents);
        for &(sender, receiver) in refused {
            plan.reject_parent(receiver, sender);
        }
        for &(a, b) in unavailable {
            plan.reject_parent(a, b);
            plan.reject_parent(b, a);
        }
        plan.delivery_frontiers(
            receivers,
            neighbors,
            relays,
            &BTreeMap::new(),
            limits,
            frontiers,
        );
    }

    pub(crate) fn candidate_parent(
        &self,
        child: Uuid,
        connected: &BTreeSet<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> Option<Uuid> {
        self.candidate_parent_where(child, connected, helpers, limits, |_| true)
    }
    /// Whether some pair on `from`'s path up to the source is reported down:
    /// `down` holds directed `(child, parent)` observations, the child reporting.
    pub(crate) fn path_down(&self, from: Uuid, down: &BTreeSet<(Uuid, Uuid)>) -> bool {
        let mut child = from;
        while let Some(&parent) = self.parents.get(&child) {
            if down.contains(&(child, parent)) {
                return true;
            }
            child = parent;
        }
        false
    }

    pub(crate) fn candidate_parent_where(
        &self,
        child: Uuid,
        connected: &BTreeSet<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
        allowed: impl Fn(Uuid) -> bool,
    ) -> Option<Uuid> {
        if !connected.contains(&self.source) || !connected.contains(&child) {
            return None;
        }
        let current = self.parents.get(&child);
        let descendants = self.subtree(child);
        self.subtree(self.source)
            .into_iter()
            .filter(|parent| self.rooted_ready(*parent) && allowed(*parent))
            .filter(|parent| {
                *parent != child
                    && !descendants.contains(parent)
                    && !self.is_display(*parent, helpers)
                    && connected.contains(parent)
                    && !self
                        .failed_parents
                        .get(&child)
                        .is_some_and(|failed| failed.contains_key(parent))
            })
            .filter(|parent| self.admitted_output(*parent, child, helpers, limits))
            // Readiness changes must not revoke a valid equal-depth reservation.
            .min_by_key(|parent| {
                (
                    limits.fallback == Some(*parent),
                    std::iter::successors(Some(*parent), |node| self.parents.get(node).copied())
                        .count(),
                    current != Some(parent),
                )
            })
    }

    fn is_display(&self, child: Uuid, helpers: &BTreeMap<Uuid, Uuid>) -> bool {
        helpers
            .get(&child)
            .is_some_and(|helper| self.parents.get(&child) == Some(helper))
    }

    fn wan_outputs(
        &self,
        parent: Uuid,
        excluding: Option<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
    ) -> usize {
        self.parents
            .iter()
            .filter(|(child, upstream)| {
                Some(**child) != excluding
                    && **upstream == parent
                    && helpers.get(child) != Some(&parent)
            })
            .count()
    }

    fn allowed_branch(
        &self,
        parent: Uuid,
        child: Uuid,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> bool {
        !self
            .failed_parents
            .get(&child)
            .is_some_and(|refused| refused.contains_key(&parent))
            && self.admitted_output(parent, child, helpers, limits)
    }

    fn admitted_output(
        &self,
        parent: Uuid,
        child: Uuid,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> bool {
        if helpers.get(&child) == Some(&parent) {
            return true;
        }
        let limit = limits.get(parent, self.source);
        limit > 0
            && (limits
                .shared
                .get(&parent)
                .is_some_and(|peers| peers.contains(&child))
                || self.output_count(parent, Some(child), helpers, limits) < limit)
    }
    fn output_count(
        &self,
        parent: Uuid,
        excluding: Option<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> usize {
        let shared = limits.shared.get(&parent);
        shared.map_or(0, BTreeSet::len)
            + self
                .parents
                .iter()
                .filter(|(child, sender)| {
                    **sender == parent
                        && Some(**child) != excluding
                        && helpers.get(child) != Some(&parent)
                        && !shared.is_some_and(|peers| peers.contains(child))
                })
                .count()
    }
    /// Move this receiver and its downstream branches behind a relay. Only
    /// the helper map gives a presentation edge its local fanout exemption.
    pub fn through_relay(
        &self,
        viewer: Uuid,
        helper: Uuid,
        connected: &BTreeSet<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> Option<BTreeMap<Uuid, Uuid>> {
        if !connected.contains(&viewer)
            || !connected.contains(&helper)
            || self
                .failed_parents
                .get(&viewer)
                .is_some_and(|parents| parents.contains_key(&helper))
        {
            return None;
        }
        let mut candidate = self.clone();
        candidate.parents.remove(&viewer);
        if helper != self.source && !candidate.subtree(self.source).contains(&helper) {
            candidate.parents.remove(&helper);
            let parent = candidate.candidate_parent(helper, connected, helpers, limits)?;
            candidate.parents.insert(helper, parent);
        }
        for (child, parent) in &mut candidate.parents {
            if *parent == viewer && *child != helper {
                *parent = helper;
            }
        }
        candidate.parents.insert(viewer, helper);
        // Each installed node must still have one acyclic path to the source.
        for child in candidate.parents.keys() {
            let mut seen = BTreeSet::new();
            let mut current = *child;
            while current != self.source {
                if !seen.insert(current) {
                    return None;
                }
                current = *candidate.parents.get(&current)?;
            }
        }
        if candidate.parents == self.parents
            || candidate.parents.values().any(|parent| {
                candidate.is_display(*parent, helpers)
                    || candidate.output_count(*parent, None, helpers, limits)
                        > self
                            .output_count(*parent, None, helpers, limits)
                            .max(limits.get(*parent, self.source))
            })
        {
            return None;
        }
        Some(candidate.parents)
    }

    pub fn reject_parent(&mut self, child: Uuid, parent: Uuid) {
        self.reject_path(child, parent, (parent, child));
    }

    pub fn reject_path(&mut self, child: Uuid, parent: Uuid, failed: (Uuid, Uuid)) {
        self.failed_parents.entry(child).or_default().insert(parent, failed);
    }

    pub fn retain_refusals(&mut self, neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>) {
        self.failed_parents.retain(|_, parents| {
            parents.retain(|_, (sender, receiver)| {
                neighbors.get(sender).is_some_and(|peers| peers.contains(receiver))
            });
            !parents.is_empty()
        });
    }
    pub fn retry_parent(&mut self, parent: Uuid) {
        self.failed_parents.retain(|_, parents| {
            parents.remove(&parent);
            !parents.is_empty()
        });
    }

    /// Necessary reductions in deterministic child order. Select a feasible
    /// move before binding the next operation to its child and deadline.
    pub fn capacity_children(
        &self,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> Vec<Uuid> {
        self.parents
            .iter()
            .filter_map(|(child, parent)| {
                (helpers.get(child) != Some(parent)
                    && !self.admitted_output(*parent, *child, helpers, limits))
                .then_some(*child)
            })
            .collect()
    }

    pub fn mark_ready(&mut self, child: Uuid, parent: Uuid, proof: Readiness) -> bool {
        if self.parents.get(&child) != Some(&parent) {
            return false;
        }
        if self
            .ready
            .get(&child)
            .is_some_and(|current| *current >= proof)
        {
            return false;
        }
        self.ready.insert(child, proof);
        true
    }

    pub fn needs_repair(&self, requested: &BTreeSet<Uuid>, connected: &BTreeSet<Uuid>) -> bool {
        connected.contains(&self.source)
            && requested.iter().any(|child| {
                *child != self.source
                    && connected.contains(child)
                    && !self.parents.contains_key(child)
            })
            && self.failed_parents.iter().any(|(child, parents)| {
                !self.parents.contains_key(child)
                    && connected.contains(child)
                    && parents.keys().any(|parent| connected.contains(parent))
            })
    }

    pub fn retry_required(&mut self, requested: &BTreeSet<Uuid>, connected: &BTreeSet<Uuid>) {
        if !self.needs_repair(requested, connected) {
            return;
        }
        // Detached transit can block a required path too. Keep every installed
        // parent's failure memory, including a healthy relay's failed shortcut.
        self.failed_parents.retain(|child, parents| {
            if !self.parents.contains_key(child) && connected.contains(child) {
                parents.retain(|parent, _| !connected.contains(parent));
            }
            !parents.is_empty()
        });
    }

    pub fn can_shortcut(
        &self,
        child: Uuid,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> bool {
        self.parents
            .get(&child)
            .is_some_and(|parent| *parent != self.source)
            && self.ready.contains_key(&child)
            && !self.is_display(child, helpers)
            && self.wan_outputs(self.source, None, helpers) < limits.get(self.source, self.source)
            && !self
                .failed_parents
                .get(&child)
                .is_some_and(|failed| failed.contains_key(&self.source))
    }

    pub fn subtree(&self, root: Uuid) -> Vec<Uuid> {
        let mut nodes = vec![root];
        let mut index = 0;
        while index < nodes.len() {
            let parent = nodes[index];
            nodes.extend(
                self.parents
                    .iter()
                    .filter_map(|(child, upstream)| (*upstream == parent).then_some(*child)),
            );
            index += 1;
        }
        nodes
    }

    pub fn shortcut_candidates(
        &self,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> Vec<Uuid> {
        let mut candidates = self.subtree(self.source);
        candidates.retain(|child| self.can_shortcut(*child, helpers, limits));
        // Preserve shallow-first order within each class; moving a branch
        // benefits its descendants without spending another source output.
        candidates.sort_by_key(|child| !self.parents.values().any(|parent| parent == child));
        candidates
    }

    pub fn readiness(&self, child: Uuid) -> Option<Readiness> {
        self.ready.get(&child).copied()
    }

    pub fn forget_ready(&mut self, child: Uuid) {
        self.ready.remove(&child);
    }

    pub fn adopt_branch(&mut self, proof: impl IntoIterator<Item = (Uuid, Uuid, Readiness)>) {
        for (child, parent, ready) in proof {
            self.parents.insert(child, parent);
            self.ready.insert(child, ready);
        }
    }

    pub fn preparing_edges(&self) -> impl Iterator<Item = (Uuid, Uuid)> + '_ {
        self.parents.iter().filter_map(|(child, parent)| {
            (!self.ready.contains_key(child)
                && (*parent == self.source || self.ready.contains_key(parent)))
            .then_some((*parent, *child))
        })
    }

    pub fn failed(&mut self, first: Uuid, second: Uuid) {
        let child = if self.parents.get(&first) == Some(&second) {
            Some(first)
        } else if self.parents.get(&second) == Some(&first) {
            Some(second)
        } else {
            None
        };
        if let Some(child) = child {
            self.reject_parent(child, self.parents[&child]);
            self.detach(child);
        }
    }

    pub fn failed_pair(&mut self, first: Uuid, second: Uuid) {
        // Physical admission belongs to TransportBook. Retire this instance's
        // media refusal and proof; a confirmed replacement may carry new media.
        self.failed_parents.retain(|_, parents| {
            parents.retain(|_, edge| *edge != (first, second) && *edge != (second, first));
            !parents.is_empty()
        });
        for (child, parent) in [(first, second), (second, first)] {
            if self.parents.get(&child) == Some(&parent) {
                self.detach(child);
            }
        }
    }

    pub(crate) fn detach(&mut self, child: Uuid) {
        let mut pending = vec![child];
        while let Some(current) = pending.pop() {
            pending.extend(
                self.parents
                    .iter()
                    .filter_map(|(next, parent)| (*parent == current).then_some(*next)),
            );
            self.parents.remove(&current);
            self.ready.remove(&current);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_frontiers_can_propose_a_missing_middle_or_first_hop() {
        let id = Uuid::from_u128;
        let mut plan = Plan::new(id(1));
        plan.reject_parent(id(4), id(5));
        plan.reject_parent(id(3), id(2));
        let mut links = confirmed_neighbors(&[(1, 2), (2, 3), (3, 4), (4, 5), (1, 5)]);
        let relays = set(&[1, 2, 3, 4, 5]);
        let receivers = set(&[4]);
        let mut out = Vec::new();
        plan.delivery_frontiers(
            &receivers,
            &links,
            &relays,
            &Default::default(),
            &Default::default(),
            &mut out,
        );
        let choices: BTreeSet<_> = out[0].candidates(id(4)).collect();
        assert!(choices.contains(&(id(5), id(3))) && choices.contains(&(id(1), id(3))));
        assert_eq!(out[0].before.get(&id(5)), Some(&id(1)));
        assert_eq!(out[0].tail(id(4), |_, _| true).get(&id(3)), Some(&id(4)));
        links.entry(id(5)).or_default().insert(id(3));
        links.entry(id(3)).or_default().insert(id(5));
        let parents = plan.activity_parents(
            &receivers,
            &links,
            &relays,
            &Default::default(),
            &Default::default(),
            &[],
        );
        assert_eq!(parents.get(&id(4)), Some(&id(3)));
        assert_eq!(parents.get(&id(3)), Some(&id(5)));
    }

    #[test]
    fn activity_parents_keep_live_inputs_without_extending_an_unconfirmed_prefix() {
        let (source, relay, live, pending, new) = (id(1), id(2), id(3), id(4), id(5));
        // The source-to-relay transport is absent from the fresh signaling snapshot.
        let mut neighbors: BTreeMap<Uuid, BTreeSet<Uuid>> = [
            (relay, [live, pending, new].into()),
            (live, [relay].into()),
            (pending, [relay].into()),
            (new, [relay].into()),
        ]
        .into();
        let mut plan = Plan::new(source);
        let granted: BTreeMap<_, _> = [(relay, source), (live, relay)].into();
        plan.parents = granted.clone();
        plan.parents.insert(pending, relay);
        plan.mark_ready(relay, source, Readiness::Forwardable);
        plan.mark_ready(live, relay, Readiness::Decoded);
        let receivers = [live, pending, new].into();
        let relays = [relay].into();
        let limits = RelayLimits {
            default: 3,
            ..Default::default()
        };
        let media = |graph: &_| {
            plan.activity_parents(&receivers, graph, &relays, &limits, &BTreeMap::new(), &[])
        };
        let bytes = |graph: &_, grants: &_, relays: &_| {
            activity_parents(
                source,
                &receivers,
                grants,
                graph,
                relays,
                &limits,
                &BTreeSet::new(),
            )
        };
        assert_eq!(media(&neighbors), granted);
        assert_eq!(bytes(&neighbors, &granted, &relays), granted);
        assert!(bytes(&neighbors, &BTreeMap::new(), &relays).is_empty());
        assert!(bytes(&neighbors, &granted, &BTreeSet::new()).is_empty());

        neighbors.insert(source, [relay].into());
        neighbors.get_mut(&relay).unwrap().insert(source);
        let restored = [
            (relay, source),
            (live, relay),
            (pending, relay),
            (new, relay),
        ]
        .into();
        assert_eq!(media(&neighbors), restored);
        assert_eq!(bytes(&neighbors, &granted, &relays), restored);
    }

    #[test]
    fn activity_parents_honor_publication_order_proof_failures_and_display_outputs() {
        let (s, a, b) = (id(1), id(2), id(3));
        let neighbors = [(s, [a, b].into()), (a, [s].into()), (b, [s].into())].into();
        let mut plan = Plan::new(s);
        let query = |plan: &Plan, helpers: &_| {
            plan.activity_parents(
                &[a, b].into(),
                &neighbors,
                &BTreeSet::new(),
                &RelayLimits {
                    source_direct_limit: Some(1),
                    ..Default::default()
                },
                helpers,
                &[b, a],
            )
        };
        assert_eq!(query(&plan, &BTreeMap::new()), [(b, s)].into());
        let display = [(a, s)].into();
        assert_eq!(query(&plan, &display), [(a, s), (b, s)].into());
        plan.reject_parent(b, s);
        assert_eq!(query(&plan, &display), [(a, s)].into());
    }

    #[test]
    fn activity_parents_keep_voice_chain_while_file_uses_new_direct_pair() {
        let (a, b, c) = (id(1), id(2), id(3));
        let mut neighbors: BTreeMap<_, BTreeSet<_>> =
            [(a, [b].into()), (b, [a, c].into()), (c, [b].into())].into();
        let limits = RelayLimits::default();
        let select_voice = |neighbors: &_, selected: &_| {
            activity_parents(
                a,
                &[c].into(),
                selected,
                neighbors,
                &[b].into(),
                &limits,
                &BTreeSet::new(),
            )
        };
        let voice = select_voice(&neighbors, &BTreeMap::new());
        assert_eq!(voice, [(b, a), (c, b)].into());

        neighbors.get_mut(&a).unwrap().insert(c);
        neighbors.get_mut(&c).unwrap().insert(a);
        let file = activity_parents(
            c,
            &[a].into(),
            &BTreeMap::new(),
            &neighbors,
            &[b].into(),
            &limits,
            &[(b, a)].into(),
        );
        assert_eq!(file, [(a, c)].into());
        assert_eq!(select_voice(&neighbors, &voice), voice);
    }

    #[test]
    fn activity_parents_respect_withdrawn_or_unavailable_outputs_and_preserve_other_receivers() {
        let (source, relay, a, b) = (id(1), id(2), id(3), id(4));
        let neighbors = [
            (source, [relay, a].into()),
            (relay, [source, a, b].into()),
            (a, [source, relay].into()),
            (b, [relay].into()),
        ]
        .into();
        let limits = RelayLimits::default();
        let selected = [(relay, source), (a, relay), (b, relay)].into();
        let choose = |selected: &_, relays: &_, limits: &_, refused: &_| {
            activity_parents(
                source,
                &[a, b].into(),
                selected,
                &neighbors,
                relays,
                limits,
                refused,
            )
        };
        assert_eq!(
            choose(&selected, &[relay].into(), &limits, &[(relay, a)].into()),
            [(a, source), (relay, source), (b, relay)].into()
        );
        assert_eq!(
            choose(&selected, &BTreeSet::new(), &limits, &BTreeSet::new()),
            [(a, source)].into()
        );
        let at_limit = RelayLimits {
            shared: [(relay, [a, id(5)].into())].into(),
            ..limits
        };
        assert_eq!(
            choose(&selected, &[relay].into(), &at_limit, &BTreeSet::new()),
            [(a, relay), (relay, source)].into()
        );
        let cycle = [(b, relay), (relay, b)].into();
        assert_eq!(
            choose(
                &cycle,
                &[relay, b].into(),
                &RelayLimits::default(),
                &BTreeSet::new()
            ),
            [(a, source), (b, relay), (relay, source)].into()
        );
    }
    #[test]
    fn confirmed_viewer_reuses_slot_released_by_unconfirmed_input() {
        let id = Uuid::from_u128;
        let (source, exclusive, shared, viewer) = (id(1), id(2), id(3), id(4));
        let order = [exclusive, shared, viewer];
        let neighbors = [
            (source, [shared, viewer].into()),
            (shared, [source].into()),
            (viewer, [source].into()),
        ]
        .into();
        let mut plan = Plan::new(source);
        plan.parents.extend([(exclusive, source), (shared, source)]);
        let limits = RelayLimits {
            source_direct_limit: Some(2),
            shared: [(source, [shared].into())].into(),
            ..Default::default()
        };
        plan.parents = plan.activity_parents(
            &order.into(),
            &neighbors,
            &BTreeSet::new(),
            &limits,
            &BTreeMap::new(),
            &order,
        );
        assert_eq!(plan.parents, [(viewer, source), (shared, source)].into());
    }

    #[test]
    fn confirmed_relay_serves_new_viewer_without_displacing_pending_direct_slot() {
        let id = Uuid::from_u128;
        let (source, pending, relay, viewer) = (id(1), id(2), id(3), id(4));
        let order = [pending, relay, viewer];
        let neighbors = [
            (source, [pending, relay, viewer].into()),
            (pending, [source].into()),
            (relay, [source, viewer].into()),
            (viewer, [source, relay].into()),
        ]
        .into();
        let limits = RelayLimits {
            source_direct_limit: Some(2),
            default: 1,
            ..Default::default()
        };
        let mut plan = Plan::new(source);
        plan.parents.extend([(pending, source), (relay, source)]);
        plan.ready.insert(relay, Readiness::Decoded);

        plan.parents = plan.activity_parents(
            &order.into(),
            &neighbors,
            &[relay].into(),
            &limits,
            &BTreeMap::new(),
            &order,
        );

        assert_eq!(plan.parents.get(&pending), Some(&source));
        assert!(!plan.ready.contains_key(&pending));
        assert_eq!(plan.parents.get(&relay), Some(&source));
        assert!(matches!(plan.ready.get(&relay), Some(Readiness::Decoded)));
        assert_eq!(plan.parents.get(&viewer), Some(&relay));
        assert_eq!(
            plan.parents
                .values()
                .filter(|&&parent| parent == source)
                .count(),
            2
        );
        assert_eq!(
            plan.parents
                .values()
                .filter(|&&parent| parent == relay)
                .count(),
            1
        );
    }

    #[test]
    fn confirmed_chain_reuses_a_publishers_edge_to_the_only_leaf() {
        let neighbors = [
            (id(0), set(&[1, 2, 3])),
            (id(1), set(&[0, 2, 3, 4])),
            (id(2), set(&[0, 1, 3])),
            (id(3), set(&[0, 1, 2])),
            (id(4), set(&[1])),
        ]
        .into();
        let limits = RelayLimits {
            default: 1,
            shared: [(id(1), set(&[4]))].into(),
            ..Default::default()
        };
        let mut plan = Plan::new(id(0));
        let demand = ScreenDemand {
            order: &[id(1), id(2), id(3), id(4)],
            neighbors: &neighbors,
            relays: &set(&[1, 2, 3]),
        };
        plan.extend_confirmed(&demand, &BTreeMap::new(), &limits);
        assert_eq!(plan.parents.len(), 4);
        assert_eq!(plan.parents[&id(4)], id(1));
    }

    #[test]
    fn confirmed_routes_on_five_nodes_match_simple_path_bounds() {
        // With one output per endpoint, any rooted delivery tree is a simple path.
        fn longest_path(graph: &BTreeMap<Uuid, BTreeSet<Uuid>>, path: &mut Vec<Uuid>) -> usize {
            let mut best = path.len() - 1;
            for next in &graph[path.last().unwrap()] {
                if !path.contains(next) {
                    path.push(*next);
                    best = best.max(longest_path(graph, path));
                    path.pop();
                }
            }
            best
        }

        let nodes = [0, 1, 2, 3, 4].map(Uuid::from_u128);
        let source = nodes[0];
        let viewers = &nodes[1..];
        let relays = viewers.iter().copied().collect();
        let limits = RelayLimits {
            default: 1,
            source_direct_limit: Some(1),
            ..Default::default()
        };
        let edges: Vec<_> = nodes
            .iter()
            .enumerate()
            .flat_map(|(i, &a)| nodes[i + 1..].iter().map(move |&b| (a, b)))
            .collect();
        let graph_count = 1 << edges.len();
        let mut optimal_count = 0;
        for mask in 0..graph_count {
            let mut graph: BTreeMap<_, _> = nodes.map(|id| (id, BTreeSet::new())).into();
            for (bit, &(a, b)) in edges.iter().enumerate() {
                if mask & (1 << bit) != 0 {
                    graph.get_mut(&a).unwrap().insert(b);
                    graph.get_mut(&b).unwrap().insert(a);
                }
            }
            let demand = ScreenDemand {
                order: viewers,
                neighbors: &graph,
                relays: &relays,
            };
            let mut plan = Plan::new(source);
            plan.extend_confirmed(&demand, &BTreeMap::new(), &limits);

            assert!(!plan.parents.contains_key(&source), "graph {mask}");
            let mut senders = BTreeSet::new();
            for (&child, &parent) in &plan.parents {
                assert!(
                    graph[&parent].contains(&child),
                    "unconfirmed edge in graph {mask}"
                );
                assert!(senders.insert(parent), "multiple outputs in graph {mask}");
                let mut seen = BTreeSet::new();
                let mut node = child;
                while node != source {
                    assert!(seen.insert(node), "cycle in graph {mask}");
                    node = *plan
                        .parents
                        .get(&node)
                        .expect("route must reach the source");
                }
            }
            // An eligible neighbor of the free tail could be served by one more hop.
            let tail = std::iter::once(&source)
                .chain(plan.parents.keys())
                .find(|node| !senders.contains(*node))
                .expect("a finite path has a tail");
            assert!(
                graph[tail]
                    .iter()
                    .all(|neighbor| *neighbor == source || plan.parents.contains_key(neighbor)),
                "unserved neighbor of the free tail in graph {mask}"
            );
            let optimum = longest_path(&graph, &mut vec![source]);
            assert!(plan.parents.len() <= optimum, "graph {mask}");
            if plan.parents.len() == optimum {
                optimal_count += 1;
            }
        }
        println!("optimal viewer coverage on {optimal_count}/{graph_count} five-node graphs");
    }
    #[test]
    fn waiting_screen_reuses_confirmed_chain_without_disturbing_other_viewers() {
        let mut plan = Plan::new(id(1));
        let viewers = set(&[4, 5]);
        route(&mut plan, &viewers, &[(1, 2), (1, 5), (2, 3)]);
        assert_eq!(plan.parents, [(id(5), id(1))].into());
        plan.mark_ready(id(5), id(1), Readiness::Decoded);
        route(&mut plan, &viewers, &[(1, 2), (1, 5), (2, 3), (3, 4)]);
        assert_eq!(
            plan.parents,
            [
                (id(2), id(1)),
                (id(3), id(2)),
                (id(4), id(3)),
                (id(5), id(1))
            ]
            .into()
        );
        assert!(plan.readiness(id(5)) == Some(Readiness::Decoded));
        assert!(plan.readiness(id(2)).is_none());
    }
    #[test]
    fn shared_relays_are_compared_after_remaining_viewers_join() {
        let id = Uuid::from_u128;
        let mut neighbors = BTreeMap::<_, BTreeSet<_>>::new();
        for (left, right) in [
            (0, 1),
            (0, 2),
            (0, 3),
            (0, 5),
            (0, 6),
            (1, 2),
            (5, 1),
            (5, 2),
            (6, 3),
            (6, 4),
        ] {
            neighbors.entry(id(left)).or_default().insert(id(right));
            neighbors.entry(id(right)).or_default().insert(id(left));
        }
        let order = [1, 2, 3, 4].map(id);
        let screen = ScreenDemand {
            order: &order,
            neighbors: &neighbors,
            relays: &[1, 5, 6].map(id).into(),
        };
        let mut plan = Plan::new(id(0));
        plan.extend_confirmed(&screen, &BTreeMap::new(), &RelayLimits::default());
        assert!(order.iter().all(|v| plan.confirmed_path(*v, &screen)));
    }
    #[test]
    fn personal_limits_apply_only_to_relays() {
        let id = Uuid::from_u128;
        let mut limits = RelayLimits {
            fallback: None,
            shared: Default::default(),
            source_direct_limit: None,
            default: 2,
            overrides: [(id(1), 1), (id(2), 4), (id(3), 3)].into(),
        };
        assert_eq!(limits.get(id(1), id(2)), 1);
        assert_eq!(limits.get(id(2), id(2)), 2);
        assert_eq!(limits.get(id(3), id(2)), 3);
        for endpoint in [id(1), id(2), id(3)] {
            limits.overrides.insert(endpoint, 0);
        }
        assert_eq!(limits.get(id(1), id(2)), 0);
        assert_eq!(limits.get(id(2), id(2)), 2);
        assert_eq!(limits.get(id(3), id(2)), 0);
    }

    #[test]
    fn a_moved_child_takes_any_ready_participant_before_the_fallback() {
        let mut plan = Plan::new(id(1));
        plan.parents = [(2, 1), (3, 1), (4, 3), (9, 3)]
            .map(|(child, parent)| (id(child), id(parent)))
            .into();
        for (child, parent) in plan.parents.clone() {
            plan.mark_ready(child, parent, Readiness::Decoded);
        }
        let connected = set(&[1, 2, 3, 4, 9]);
        let choose = |limits: &RelayLimits| {
            plan.candidate_parent(id(9), &connected, &BTreeMap::new(), limits)
        };
        // Every parent may keep one output, so 9 must leave 3.
        let limits = RelayLimits { default: 1, ..Default::default() };
        assert_eq!(choose(&limits), Some(id(2)), "the shallower participant wins");
        let limits = RelayLimits { fallback: Some(id(2)), ..limits };
        assert_eq!(choose(&limits), Some(id(4)));
    }

    #[test]
    fn the_fallback_takes_a_scarce_source_slot_when_that_serves_more_receivers() {
        // Listeners 2 and 3 reach only the source and forward nothing; 4 and 5
        // reach only the service 9. The source keeps two outputs.
        let (source, service) = (id(1), id(9));
        let neighbors = confirmed_neighbors(&[(1, 2), (1, 3), (1, 9), (9, 4), (9, 5)]);
        let limits = RelayLimits { fallback: Some(service), ..Default::default() };
        let parents = activity_parents(
            source,
            &set(&[2, 3, 4, 5]),
            &BTreeMap::new(),
            &neighbors,
            &[service].into(),
            &limits,
            &BTreeSet::new(),
        );
        assert_eq!(parents, [(2, 1), (9, 1), (4, 9), (5, 9)].map(|(c, p)| (id(c), id(p))).into());
    }

    #[test]
    fn assisted_branch_reuses_the_parent_slot_and_keeps_two_wan_outputs() {
        let id = Uuid::from_u128;
        let connected = (1..=7).map(id).collect();
        let helpers = BTreeMap::from([(id(2), id(6))]);
        let mut plan = Plan::new(id(1));
        plan.parents = BTreeMap::from([
            (id(2), id(1)),
            (id(3), id(1)),
            (id(4), id(2)),
            (id(5), id(2)),
        ]);
        for (child, parent) in plan.parents.clone() {
            plan.mark_ready(child, parent, Readiness::Decoded);
        }
        let candidate = plan
            .through_relay(id(2), id(6), &connected, &helpers, &Default::default())
            .unwrap();
        assert_eq!(
            candidate,
            BTreeMap::from([
                (id(2), id(6)),
                (id(3), id(1)),
                (id(4), id(6)),
                (id(5), id(6)),
                (id(6), id(1)),
            ])
        );
        plan.adopt_branch(
            candidate
                .into_iter()
                .map(|(child, parent)| (child, parent, Readiness::Decoded)),
        );
        assert_eq!(plan.wan_outputs(id(6), None, &helpers), 2);
        assert_eq!(
            plan.parents
                .values()
                .filter(|parent| **parent == id(6))
                .count(),
            3
        );
        let requested = [2, 3, 4, 5, 7].into_iter().map(id).collect();
        let neighbors =
            confirmed_neighbors(&[(1, 3), (1, 6), (2, 6), (4, 6), (5, 6), (2, 7), (3, 7)]);
        plan.parents = plan.activity_parents(
            &requested,
            &neighbors,
            &connected,
            &RelayLimits::default(),
            &helpers,
            &[],
        );
        assert_eq!(
            plan.parents[&id(7)],
            id(3),
            "the display leaf cannot become a WAN parent"
        );
        assert!(!plan
            .shortcut_candidates(&helpers, &Default::default())
            .contains(&id(2)));
        assert!(plan
            .through_relay(id(2), id(6), &connected, &helpers, &Default::default())
            .is_none());
        let source_helper = BTreeMap::from([(id(2), id(1))]);
        let candidate = plan
            .through_relay(
                id(2),
                id(1),
                &connected,
                &source_helper,
                &Default::default(),
            )
            .unwrap();
        assert_eq!(candidate[&id(2)], id(1));
        assert!(
            !candidate.contains_key(&id(1)),
            "a Native source needs no self input"
        );
    }

    fn confirmed_neighbors(pairs: &[(u128, u128)]) -> BTreeMap<Uuid, BTreeSet<Uuid>> {
        let mut neighbors = BTreeMap::<Uuid, BTreeSet<Uuid>>::new();
        for &(a, b) in pairs {
            neighbors.entry(id(a)).or_default().insert(id(b));
            neighbors.entry(id(b)).or_default().insert(id(a));
        }
        neighbors
    }

    fn route(plan: &mut Plan, viewers: &BTreeSet<Uuid>, pairs: &[(u128, u128)]) {
        let neighbors = confirmed_neighbors(pairs);
        let relays = neighbors.keys().copied().collect();
        plan.parents = plan.activity_parents(
            viewers,
            &neighbors,
            &relays,
            &RelayLimits::default(),
            &BTreeMap::new(),
            &[],
        );
        plan.ready
            .retain(|child, _| plan.parents.contains_key(child));
    }

    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }
    fn set(values: &[u128]) -> BTreeSet<Uuid> {
        values.iter().map(|value| id(*value)).collect()
    }

    #[test]
    fn source_fanout_then_ready_subscriber_relay_and_sticky_healthy_edges() {
        let mut plan = Plan::new(id(1));
        let requested = set(&[2, 3, 4, 5]);
        let mut edges = vec![(1, 2), (1, 3)];
        route(&mut plan, &requested, &edges);
        assert_eq!(plan.parents.len(), 2);
        assert!(plan.mark_ready(id(2), id(1), Readiness::Forwardable));
        edges.extend([(2, 4), (2, 5)]);
        route(&mut plan, &requested, &edges);
        assert_eq!(plan.parents[&id(4)], id(2));
        assert_eq!(plan.parents[&id(5)], id(2));
        route(&mut plan, &requested, &edges);
        assert_eq!(plan.parents[&id(3)], id(1));
        assert_eq!(plan.parents[&id(4)], id(2));
    }

    #[test]
    fn relay_failure_retires_descendants_only_and_does_not_mutate_another_source() {
        let mut first = Plan::new(id(1));
        let mut second = Plan::new(id(2));
        let requested = set(&[2, 3, 4, 5]);
        let mut edges = vec![(1, 2), (1, 3), (2, 3), (2, 4), (2, 5)];
        route(&mut first, &requested, &edges);
        first.mark_ready(id(2), id(1), Readiness::Forwardable);
        route(&mut first, &requested, &edges);
        route(&mut second, &set(&[1, 3]), &edges);
        let second_before = second.parents.clone();
        first.failed(id(1), id(2));
        assert_eq!(first.parents, BTreeMap::from([(id(3), id(1))]));
        first.mark_ready(id(3), id(1), Readiness::Forwardable);
        edges.extend([(3, 4), (3, 5)]);
        route(&mut first, &requested, &edges);
        assert_eq!(first.parents[&id(3)], id(1));
        assert_ne!(first.parents.get(&id(2)), Some(&id(1)));
        assert_eq!(second.parents, second_before);
    }

    #[test]
    fn unwatch_keeps_required_transit_until_its_last_downstream_leaves() {
        let mut plan = Plan::new(id(1));
        route(&mut plan, &set(&[2, 3, 4]), &[(1, 2), (1, 3), (2, 4)]);
        plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        route(&mut plan, &set(&[2, 3, 4]), &[(1, 2), (1, 3), (2, 4)]);
        let before = plan.parents.clone();
        route(&mut plan, &set(&[3, 4]), &[(1, 2), (1, 3), (2, 4)]);
        assert_eq!(plan.parents, before);
        assert!(
            !plan.mark_ready(id(2), id(1), Readiness::Forwardable),
            "existing transit proof is retained"
        );
        route(&mut plan, &set(&[3]), &[(1, 2), (1, 3), (2, 4)]);
        assert!(!plan.parents.contains_key(&id(2)));
        assert!(!plan.parents.values().any(|parent| *parent == id(2)));
        assert!(!plan.mark_ready(id(2), id(1), Readiness::Forwardable));
        assert_eq!(plan.parents, BTreeMap::from([(id(3), id(1))]));
    }

    #[test]
    fn view_toggles_do_not_retry_a_failed_parent() {
        let mut plan = Plan::new(id(1));
        route(&mut plan, &set(&[2]), &[(1, 2)]);
        plan.failed(id(1), id(2));
        route(&mut plan, &set(&[]), &[(1, 2)]);
        route(&mut plan, &set(&[2]), &[(1, 2)]);
        assert!(plan.parents.is_empty());
    }

    #[test]
    fn required_repair_retains_a_healthy_relays_failed_shortcut() {
        let mut plan = Plan::new(id(1));
        let requested = set(&[2, 3]);
        route(
            &mut plan,
            &requested,
            &[(1, 2), (1, 3), (2, 3), (1, 4), (2, 4), (3, 4)],
        );
        plan.mark_ready(id(2), id(1), Readiness::Decoded);
        plan.failed(id(1), id(3));
        route(
            &mut plan,
            &requested,
            &[(1, 2), (1, 3), (2, 3), (1, 4), (2, 4), (3, 4)],
        );
        assert_eq!(plan.parents[&id(3)], id(2));
        plan.mark_ready(id(3), id(2), Readiness::Decoded);
        let requested = set(&[2, 3, 4]);
        route(
            &mut plan,
            &requested,
            &[(1, 2), (1, 3), (2, 3), (1, 4), (2, 4), (3, 4)],
        );
        while let Some(parent) = plan.parents.get(&id(4)).copied() {
            plan.failed(parent, id(4));
            route(
                &mut plan,
                &requested,
                &[(1, 2), (1, 3), (2, 3), (1, 4), (2, 4), (3, 4)],
            );
        }
        let available = set(&[1, 2, 3, 4]);
        assert!(plan.needs_repair(&requested, &available));
        plan.retry_required(&requested, &available);
        route(
            &mut plan,
            &requested,
            &[(1, 2), (1, 3), (2, 3), (1, 4), (2, 4), (3, 4)],
        );
        assert_eq!(plan.parents[&id(4)], id(1));
        assert_eq!(plan.parents[&id(3)], id(2));
        assert!(!plan.can_shortcut(id(3), &BTreeMap::new(), &Default::default()));
        assert!(!plan.needs_repair(&requested, &available));
    }

    #[test]
    fn healthy_unwatch_rewatch_and_ancestor_loss_do_not_mark_a_leg_failed() {
        let mut plan = Plan::new(id(1));
        route(
            &mut plan,
            &set(&[2]),
            &[(1, 2), (1, 3), (2, 4), (2, 3), (3, 4)],
        );
        plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        route(
            &mut plan,
            &set(&[]),
            &[(1, 2), (1, 3), (2, 4), (2, 3), (3, 4)],
        );
        route(
            &mut plan,
            &set(&[2]),
            &[(1, 2), (1, 3), (2, 4), (2, 3), (3, 4)],
        );
        assert_eq!(plan.parents[&id(2)], id(1));

        plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        route(
            &mut plan,
            &set(&[2, 3, 4]),
            &[(1, 2), (1, 3), (2, 4), (2, 3), (3, 4)],
        );
        assert_eq!(plan.parents[&id(4)], id(2));
        plan.failed(id(1), id(2));
        assert!(plan.failed_parents[&id(2)].contains_key(&id(1)));
        assert!(plan
            .failed_parents
            .get(&id(4))
            .is_none_or(BTreeMap::is_empty));
        plan.mark_ready(id(3), id(1), Readiness::Forwardable);
        route(
            &mut plan,
            &set(&[2, 3, 4]),
            &[(1, 2), (1, 3), (2, 4), (2, 3), (3, 4)],
        );
        assert_eq!(plan.parents[&id(2)], id(3));
        assert!(plan.parents.contains_key(&id(4)));
    }
    #[test]
    fn exhausted_old_parents_do_not_block_a_new_ready_candidate() {
        let mut plan = Plan::new(id(1));
        let mut edges = vec![(1, 2), (1, 3), (2, 4), (3, 4)];
        let viewers = set(&[2, 3, 4]);
        route(&mut plan, &viewers, &edges);
        for (child, parent) in plan.parents.clone() {
            plan.mark_ready(child, parent, Readiness::Forwardable);
        }
        for _ in 0..2 {
            let parent = plan.parents[&id(4)];
            plan.failed(parent, id(4));
            route(&mut plan, &viewers, &edges);
        }
        assert!(!plan.parents.contains_key(&id(4)));
        edges.extend([(3, 5), (4, 5)]);
        route(&mut plan, &set(&[2, 3, 4, 5]), &edges);
        assert_eq!(plan.parents[&id(4)], id(5));
        plan.retry_parent(id(2));
        assert!(!plan.failed_parents[&id(4)].contains_key(&id(2)));
    }
}
