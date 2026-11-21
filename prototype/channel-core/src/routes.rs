use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use uuid::Uuid;

const BASE_PREPARE_MS: u64 = 20_000;

#[derive(Clone)]
pub(crate) struct RelayLimits {
    pub shared: BTreeMap<Uuid, BTreeSet<Uuid>>,
    pub source_direct_limit: Option<usize>,
    pub default: usize,
    pub host: Uuid,
    pub overrides: BTreeMap<Uuid, usize>,
}
impl Default for RelayLimits {
    fn default() -> Self {
        Self {
            shared: Default::default(),
            source_direct_limit: None,
            default: 2,
            host: Uuid::nil(),
            overrides: BTreeMap::new(),
        }
    }
}
impl RelayLimits {
    pub fn get(&self, endpoint: Uuid, source: Uuid) -> usize {
        if endpoint == source {
            if let Some(limit) = self.source_direct_limit {
                return limit;
            }
        }
        match self.overrides.get(&endpoint).copied() {
            Some(0) if endpoint == source || endpoint == self.host => self.default,
            Some(capacity) => capacity,
            None => self.default,
        }
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
    failed_parents: BTreeMap<Uuid, BTreeSet<Uuid>>,
}

pub(crate) struct ScreenDemand<'a> {
    pub order: &'a [Uuid],
    pub neighbors: &'a BTreeMap<Uuid, BTreeSet<Uuid>>,
    pub relays: &'a BTreeSet<Uuid>,
}

impl Plan {
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

    pub fn reconcile(
        &mut self,
        requested: &BTreeSet<Uuid>,
        available: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        base: Option<&BaseTree>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) {
        self.reconcile_demand(requested, available, connected, base, helpers, limits, None)
    }

    pub fn reconcile_demand(
        &mut self,
        requested: &BTreeSet<Uuid>,
        available: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        base: Option<&BaseTree>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
        screen: Option<&ScreenDemand<'_>>,
    ) {
        let remove: Vec<_> = self
            .parents
            .iter()
            .filter_map(|(child, parent)| {
                (!available.contains(child) || !available.contains(parent)).then_some(*child)
            })
            .collect();
        for child in remove {
            self.detach(child);
        }
        self.failed_parents.retain(|child, parents| {
            parents.retain(|parent| available.contains(parent));
            available.contains(child)
        });
        let base_parents: BTreeMap<_, _> = base
            .into_iter()
            .flat_map(|base| base.project(self.source, requested))
            .map(|(parent, child)| (child, parent))
            .collect();
        if connected.contains(&self.source) {
            for child in requested {
                if self.parents.contains_key(child)
                    && !self.ready.contains_key(child)
                    && !self.is_display(*child, helpers)
                    && !screen.is_some_and(|screen| self.confirmed_path(*child, screen))
                {
                    if let Some(screen) = screen {
                        if self.replace_pending_path(*child, requested, screen, helpers, limits) {
                            continue;
                        }
                    }
                    self.graft_base(*child, &base_parents, available, connected, helpers, limits);
                }
            }
        }
        // Consumption owns demand; the ancestors still needed to deliver it
        // retain their transport and proof even when they stop watching locally.
        let mut needed = requested.clone();
        for receiver in requested {
            let mut child = *receiver;
            while let Some(parent) = self.parents.get(&child) {
                if *parent == self.source {
                    break;
                }
                needed.insert(*parent);
                child = *parent;
            }
        }
        self.parents.retain(|child, _| needed.contains(child));
        self.ready
            .retain(|child, _| self.parents.contains_key(child));
        if !connected.contains(&self.source) {
            return;
        }
        if let Some(screen) = screen {
            self.extend_confirmed(screen, helpers, limits);
            self.reassign_pending_direct(screen, helpers, limits);
        }
        // Unknown paths use the existing admission and repair policy.
        for child in requested {
            if *child == self.source
                || self.parents.contains_key(child)
                || !connected.contains(child)
            {
                continue;
            }
            if self.graft_base(*child, &base_parents, available, connected, helpers, limits) {
                continue;
            }
            if let Some(parent) = self.candidate_parent(*child, connected, helpers, limits) {
                self.parents.insert(*child, parent);
            }
        }
    }

    fn reassign_pending_direct(
        &mut self,
        screen: &ScreenDemand<'_>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) {
        let Some(connected) = screen.neighbors.get(&self.source) else {
            return;
        };
        let shared = limits.shared.get(&self.source);
        for &viewer in screen.order {
            if viewer == self.source
                || self.parents.contains_key(&viewer)
                || !connected.contains(&viewer)
                || self.failed_parents.get(&viewer).is_some_and(|failed| failed.contains(&self.source))
            {
                continue;
            }
            // Preserve every usable, shared or assisted branch. Only an exclusive
            // unconfirmed leaf can release a source output for this viewer.
            let leaf = screen.order.iter().rev().copied().find(|peer| {
                self.parents.get(peer) == Some(&self.source)
                    && !connected.contains(peer)
                    && !self.ready.contains_key(peer)
                    && !shared.is_some_and(|others| others.contains(peer))
                    && !self.parents.values().any(|parent| parent == peer)
                    && !helpers.contains_key(peer)
                    && !helpers.values().any(|helper| helper == peer)
            });
            if let Some(leaf) = leaf {
                self.parents.remove(&leaf);
                if self.admitted_output(self.source, viewer, helpers, limits) {
                    self.parents.insert(viewer, self.source);
                } else {
                    self.parents.insert(leaf, self.source);
                }
            }
        }
    }

    fn replace_pending_path(
        &mut self,
        viewer: Uuid,
        requested: &BTreeSet<Uuid>,
        screen: &ScreenDemand<'_>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> bool {
        if !screen.neighbors.contains_key(&viewer)
            || self.parents.values().any(|parent| *parent == viewer)
        {
            return false;
        }
        let mut candidate = self.clone();
        let mut child = viewer;
        // Release only the unproved suffix reserved exclusively for this viewer.
        while let Some(parent) = candidate.parents.remove(&child) {
            if parent == self.source
                || requested.contains(&parent)
                || self.ready.contains_key(&parent)
                || candidate.parents.values().any(|other| *other == parent)
            {
                break;
            }
            child = parent;
        }
        if candidate.append_path(viewer, screen, helpers, limits)
            && candidate.parents != self.parents
        {
            self.parents = candidate.parents;
            return true;
        }
        false
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
                    || self.failed_parents.get(&viewer).is_some_and(|failed| failed.contains(relay))
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
                if !self.admitted_output(parent, child, helpers, limits)
                    || self.parents.contains_key(&child)
                    || self
                        .failed_parents
                        .get(&child)
                        .is_some_and(|failed| failed.contains(&parent))
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

    pub(crate) fn candidate_parent(
        &self,
        child: Uuid,
        connected: &BTreeSet<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> Option<Uuid> {
        self.preferred_parent(child, connected, helpers, limits, &BTreeSet::new())
    }

    fn preferred_parent(
        &self,
        child: Uuid,
        connected: &BTreeSet<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
        confirmed_demand: &BTreeSet<(Uuid, Uuid)>,
    ) -> Option<Uuid> {
        if !connected.contains(&self.source) || !connected.contains(&child) {
            return None;
        }
        let current = self.parents.get(&child);
        let descendants = self.subtree(child);
        self.subtree(self.source)
            .into_iter()
            .filter(|parent| self.rooted_ready(*parent))
            .filter(|parent| {
                *parent != child
                    && !descendants.contains(parent)
                    && !self.is_display(*parent, helpers)
                    && connected.contains(parent)
                    && !self
                        .failed_parents
                        .get(&child)
                        .is_some_and(|failed| failed.contains(parent))
            })
            .filter(|parent| self.admitted_output(*parent, child, helpers, limits))
            // Readiness changes must not revoke a valid equal-depth reservation.
            .min_by_key(|parent| {
                (
                    !confirmed_demand.contains(&((*parent).min(child), (*parent).max(child))),
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
        limit > 0 && (limits.shared.get(&parent).is_some_and(|peers| peers.contains(&child))
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
                .is_some_and(|parents| parents.contains(&helper))
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
        self.failed_parents.entry(child).or_default().insert(parent);
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
        origin_paths: &BTreeSet<(Uuid, Uuid)>,
    ) -> Vec<Uuid> {
        self.parents
            .iter()
            .filter_map(|(child, parent)| {
                (helpers.get(child) != Some(parent)
                    && !(limits.source_direct_limit.is_none()
                        && self.source == *parent
                        && origin_paths.contains(&(*parent, *child)))
                    && !self.admitted_output(*parent, *child, helpers, limits))
                .then_some(*child)
            })
            .collect()
    }

    /// Reuse the existing physical path without applying the policy used to
    /// construct new branches. Reversing a base tree can give its source three
    /// required outputs; that is not a claim about the device's media capacity.
    fn graft_base(
        &mut self,
        receiver: Uuid,
        base_parents: &BTreeMap<Uuid, Uuid>,
        available: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        helpers: &BTreeMap<Uuid, Uuid>,
        limits: &RelayLimits,
    ) -> bool {
        // New receivers may reuse an installed input prefix. Replacing a
        // candidate instead requires a proved prefix or the complete base path.
        let replacing = self.parents.contains_key(&receiver);
        let mut suffix = Vec::new();
        let mut child = receiver;
        while child != self.source
            && !self.ready.contains_key(&child)
            && (replacing || !self.parents.contains_key(&child))
        {
            let Some(parent) = base_parents.get(&child).copied() else {
                return false;
            };
            if !available.contains(&child)
                || !available.contains(&parent)
                || !connected.contains(&child)
                || !connected.contains(&parent)
                || self.is_display(parent, helpers)
                || ((parent != self.source || limits.source_direct_limit.is_some())
                    && helpers.get(&child) != Some(&parent)
                    && self.parents.get(&child) != Some(&parent)
                    && !self.admitted_output(parent, child, helpers, limits))
                || self
                    .failed_parents
                    .get(&child)
                    .is_some_and(|failed| failed.contains(&parent))
            {
                return false;
            }
            suffix.push((child, parent));
            child = parent;
        }
        if child != self.source
            && suffix
                .iter()
                .any(|(node, _)| self.subtree(*node).contains(&child))
        {
            return false;
        }
        for (child, parent) in suffix {
            self.parents.insert(child, parent);
        }
        true
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
                    && parents.iter().any(|parent| connected.contains(parent))
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
                parents.retain(|parent| !connected.contains(parent));
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
                .is_some_and(|failed| failed.contains(&self.source))
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

    pub fn ready_edges(&self) -> impl Iterator<Item = (Uuid, Uuid)> + '_ {
        self.parents.iter().filter_map(|(child, parent)| {
            self.ready.contains_key(child).then_some((*parent, *child))
        })
    }

    pub fn preparing_edges(&self) -> impl Iterator<Item = (Uuid, Uuid)> + '_ {
        self.parents.iter().filter_map(|(child, parent)| {
            (!self.ready.contains_key(child)
                && (*parent == self.source || self.ready.contains_key(parent)))
            .then_some((*parent, *child))
        })
    }

    pub fn mark_unready(&mut self, child: Uuid, parent: Uuid) -> bool {
        if self.parents.get(&child) != Some(&parent) || self.ready.remove(&child).is_none() {
            return false;
        }
        let descendants: Vec<_> = self
            .parents
            .iter()
            .filter_map(|(next, upstream)| (*upstream == child).then_some(*next))
            .collect();
        for next in descendants {
            self.detach(next);
        }
        true
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
            self.failed_parents
                .entry(child)
                .or_default()
                .insert(self.parents[&child]);
            self.detach(child);
        }
    }

    pub fn failed_pair(&mut self, first: Uuid, second: Uuid) {
        // Physical failure also applies to candidates used by another tree or
        // a prepared branch. Only this plan's current nodes consume that fact.
        for (child, parent) in [(first, second), (second, first)] {
            if self.parents.contains_key(&child) {
                self.failed_parents.entry(child).or_default().insert(parent);
            }
        }
        self.failed(first, second);
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

/// A room's bidirectional base uses the same bounded tree admission. Its proof
/// is both installed DataChannel endpoints, independent of media frame proof.
#[derive(Clone)]
pub struct BaseTree {
    plan: Plan,
    acknowledged: BTreeSet<(Uuid, Uuid)>,
    operation: Option<BaseOperation>,
}
#[derive(Clone)]
struct BaseOperation {
    child: Uuid,
    candidate: Option<BaseCandidate>,
    replaces: Option<Uuid>,
    deadline: u64,
}
#[derive(Clone, Copy)]
enum BaseCandidate {
    Reparent { parent: Uuid },
    Insert { parent: Uuid, branch: Uuid },
    FileShortcut { source: Uuid },
}
impl BaseOperation {
    fn edges(&self) -> Vec<(Uuid, Uuid)> {
        match self.candidate {
            Some(BaseCandidate::Reparent { parent }) => vec![(parent, self.child)],
            Some(BaseCandidate::Insert { parent, branch }) => {
                vec![(parent, self.child), (self.child, branch)]
            }
            Some(BaseCandidate::FileShortcut { source }) => vec![(source, self.child)],
            None => vec![],
        }
    }
}

impl BaseTree {
    pub fn confirmed_repair_paths(
        &self,
        demand: &BTreeSet<Uuid>,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        relays: &BTreeSet<Uuid>,
        limits: &RelayLimits,
    ) -> BTreeSet<(Uuid, Uuid)> {
        let graph = ScreenDemand {
            order: &[],
            neighbors,
            relays,
        };
        let mut plan = self.plan.clone();
        let mut edges = BTreeSet::new();
        for &target in demand {
            if target == self.root() || self.ready(target) {
                continue;
            }
            if plan.parents.contains_key(&target) && !plan.confirmed_path(target, &graph) {
                plan.replace_pending_path(target, demand, &graph, &BTreeMap::new(), limits);
            } else {
                plan.append_path(target, &graph, &BTreeMap::new(), limits);
            }
            if plan.confirmed_path(target, &graph) {
                let mut child = target;
                while let Some(&parent) = plan.parents.get(&child) {
                    edges.insert((parent, child));
                    child = parent;
                }
            }
        }
        edges
    }
    pub fn pending_after_direct_failure(&self, peer: Uuid) -> bool {
        !self.ready(peer)
            && self
                .plan
                .failed_parents
                .get(&peer)
                .is_some_and(|parents| parents.contains(&self.root()))
    }

    pub fn new(root: Uuid) -> Self {
        Self {
            plan: Plan::new(root),
            acknowledged: BTreeSet::new(),
            operation: None,
        }
    }
    pub fn root(&self) -> Uuid {
        self.plan.source
    }
    pub fn ready(&self, child: Uuid) -> bool {
        self.plan.readiness(child).is_some()
    }
    pub fn needs_repair(&self, demand: &BTreeSet<Uuid>, connected: &BTreeSet<Uuid>) -> bool {
        self.plan.needs_repair(demand, connected)
    }
    pub fn retry_required(&mut self, demand: &BTreeSet<Uuid>, connected: &BTreeSet<Uuid>) {
        self.plan.retry_required(demand, connected);
    }
    pub fn links(&self) -> impl Iterator<Item = (Uuid, Uuid)> + '_ {
        self.plan
            .parents
            .iter()
            .map(|(child, parent)| (*parent, *child))
    }
    fn contains(&self, first: Uuid, second: Uuid) -> bool {
        self.plan.parents.get(&first) == Some(&second)
            || self.plan.parents.get(&second) == Some(&first)
            || self.candidate_links().iter().any(|(parent, child)| {
                (*parent == first && *child == second) || (*parent == second && *child == first)
            })
    }
    #[cfg(test)]
    pub fn reconcile(
        &mut self,
        demand: &BTreeSet<Uuid>,
        available: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        limits: &RelayLimits,
        now: u64,
    ) {
        self.reconcile_confirmed(demand, available, connected, limits, now, &BTreeSet::new())
    }

    pub(crate) fn reconcile_confirmed(
        &mut self,
        demand: &BTreeSet<Uuid>,
        available: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        limits: &RelayLimits,
        now: u64,
        confirmed_demand: &BTreeSet<(Uuid, Uuid)>,
    ) {
        self.plan
            .reconcile(demand, available, connected, None, &BTreeMap::new(), limits);
        // Reconsider unproved edges without releasing their reserved capacity.
        // Identical choices retain the physical lease and partial endpoint ACKs.
        let pending: Vec<_> = self
            .plan
            .parents
            .keys()
            .filter(|child| !self.plan.ready.contains_key(child))
            .copied()
            .collect();
        for child in pending {
            let current = self.plan.parents[&child];
            // Preserve a confirmed physical pair while the other endpoint acknowledges its room grant.
            let acknowledging = self.acknowledged.contains(&(current, child))
                || self.acknowledged.contains(&(child, current));
            if acknowledging && confirmed_demand.contains(&(current.min(child), current.max(child)))
            {
                continue;
            }
            let parent = self.plan.preferred_parent(
                child,
                connected,
                &BTreeMap::new(),
                limits,
                confirmed_demand,
            );
            if let Some(parent) = parent {
                self.plan.parents.insert(child, parent);
            }
        }
        self.plan
            .reconcile(demand, available, connected, None, &BTreeMap::new(), limits);
        self.plan
            .failed_parents
            .retain(|child, _| demand.contains(child) || self.plan.parents.contains_key(child));
        self.prune_proofs();
        for (&child, &parent) in &self.plan.parents {
            if self.acknowledged.contains(&(child, parent))
                && self.acknowledged.contains(&(parent, child))
            {
                self.plan.ready.insert(child, Readiness::Forwardable);
            }
        }
        if self
            .operation
            .as_ref()
            .is_some_and(|operation| operation.deadline <= now)
        {
            let operation = self.operation.take().unwrap();
            if let Some(BaseCandidate::FileShortcut { source }) = operation.candidate {
                self.plan.reject_parent(operation.child, source);
            } else if let Some(parent) = operation.replaces {
                self.plan.failed(parent, operation.child);
            } else {
                self.plan.reject_parent(operation.child, self.root());
            }
            self.prune_proofs();
        }
        if let Some(operation) = &self.operation {
            match operation.candidate {
                // File demand revalidates its candidate after base reconciliation.
                Some(BaseCandidate::FileShortcut { .. }) => {}
                _ if self.plan.parents.get(&operation.child).copied() != operation.replaces
                    || (operation.replaces.is_none()
                        && (!connected.contains(&operation.child)
                            || !demand.contains(&operation.child)))
                    || operation.replaces.is_some_and(|parent| {
                        self.plan.wan_outputs(parent, None, &BTreeMap::new())
                            <= limits.get(parent, self.root())
                    }) =>
                {
                    self.operation = None;
                    self.prune_proofs();
                }
                Some(candidate)
                    if !self.valid_candidate(operation.child, candidate, connected, limits) =>
                {
                    self.abort();
                }
                _ => {}
            }
        }
        if self.operation.is_none() {
            let excess = self
                .plan
                .capacity_children(&BTreeMap::new(), limits, &BTreeSet::new());
            if let Some(first) = excess.first().copied() {
                let (child, candidate) = excess
                    .into_iter()
                    .find_map(|child| {
                        self.route_candidate(
                            child,
                            self.plan.parents.get(&child).copied(),
                            connected,
                            limits,
                        )
                        .map(|candidate| (child, Some(candidate)))
                    })
                    .unwrap_or((first, None));
                self.operation = Some(BaseOperation {
                    child,
                    candidate,
                    replaces: self.plan.parents.get(&child).copied(),
                    deadline: now.saturating_add(BASE_PREPARE_MS),
                });
            } else if let Some((child, candidate)) = demand
                .iter()
                .filter(|child| {
                    **child != self.root()
                        && connected.contains(child)
                        && !self.plan.parents.contains_key(child)
                })
                .find_map(|child| {
                    self.route_candidate(*child, None, connected, limits)
                        .map(|candidate| (*child, candidate))
                })
            {
                self.operation = Some(BaseOperation {
                    child,
                    candidate: Some(candidate),
                    replaces: None,
                    deadline: now.saturating_add(BASE_PREPARE_MS),
                });
            }
        }
        if let Some((child, replaces)) = self
            .operation
            .as_ref()
            .filter(|operation| operation.candidate.is_none())
            .map(|operation| (operation.child, operation.replaces))
        {
            let candidate = self.route_candidate(child, replaces, connected, limits);
            self.operation.as_mut().unwrap().candidate = candidate;
        }
    }
    fn route_candidate(
        &self,
        child: Uuid,
        replaces: Option<Uuid>,
        connected: &BTreeSet<Uuid>,
        limits: &RelayLimits,
    ) -> Option<BaseCandidate> {
        self.plan
            .candidate_parent(child, connected, &BTreeMap::new(), limits)
            .map(|parent| BaseCandidate::Reparent { parent })
            .or_else(|| {
                let branches: Vec<_> = replaces.map_or_else(
                    || {
                        self.plan
                            .parents
                            .iter()
                            .map(|(branch, parent)| (*branch, *parent))
                            .collect()
                    },
                    |branch| {
                        self.plan
                            .parents
                            .get(&branch)
                            .map(|parent| vec![(branch, *parent)])
                            .unwrap_or_default()
                    },
                );
                branches.into_iter().find_map(|(branch, parent)| {
                    let candidate = BaseCandidate::Insert { parent, branch };
                    self.valid_candidate(child, candidate, connected, limits)
                        .then_some(candidate)
                })
            })
    }
    fn valid_candidate(
        &self,
        child: Uuid,
        candidate: BaseCandidate,
        connected: &BTreeSet<Uuid>,
        limits: &RelayLimits,
    ) -> bool {
        if !connected.contains(&child) {
            return false;
        }
        let failed = |parent| {
            self.plan
                .failed_parents
                .get(&child)
                .is_some_and(|parents| parents.contains(&parent))
        };
        match candidate {
            BaseCandidate::Reparent { parent } => {
                connected.contains(&parent)
                    && self.plan.rooted_ready(parent)
                    && !self.plan.subtree(child).contains(&parent)
                    && !failed(parent)
                    && self.plan.wan_outputs(parent, Some(child), &BTreeMap::new())
                        < limits.get(parent, self.root())
            }
            BaseCandidate::Insert { parent, branch } => {
                child != branch
                    && child != parent
                    && self.plan.parents.get(&branch) == Some(&parent)
                    && self.plan.rooted_ready(branch)
                    && connected.contains(&parent)
                    && connected.contains(&branch)
                    && !failed(parent)
                    && !failed(branch)
                    && (self.plan.parents.get(&child).is_none()
                        || self.plan.parents.get(&child) == Some(&branch))
                    && self.plan.wan_outputs(child, None, &BTreeMap::new())
                        < limits.get(child, self.root())
            }
            BaseCandidate::FileShortcut { source } => {
                connected.contains(&source)
                    && self.plan.rooted_ready(source)
                    && self.plan.rooted_ready(child)
                    && !failed(source)
                    && self
                        .file_shortcut_plan(source, child)
                        .capacity_children(&BTreeMap::new(), limits, &BTreeSet::new())
                        .is_empty()
            }
        }
    }
    pub fn prepare_file_shortcut(
        &mut self,
        requested: &[(Uuid, Uuid)],
        connected: &BTreeSet<Uuid>,
        limits: &RelayLimits,
        now: u64,
    ) {
        let retired = if let Some(operation) = &self.operation {
            let Some(BaseCandidate::FileShortcut { source }) = operation.candidate else {
                return;
            };
            let pair = (source, operation.child);
            if requested.contains(&pair)
                && self.valid_candidate(
                    operation.child,
                    BaseCandidate::FileShortcut { source },
                    connected,
                    limits,
                )
            {
                return;
            }
            self.operation = None;
            self.prune_proofs();
            Some(pair)
        } else {
            None
        };
        if let Some((source, child)) = requested.iter().copied().find(|&(source, child)| {
            Some((source, child)) != retired
                && self.valid_candidate(
                    child,
                    BaseCandidate::FileShortcut { source },
                    connected,
                    limits,
                )
        }) {
            self.operation = Some(BaseOperation {
                child,
                candidate: Some(BaseCandidate::FileShortcut { source }),
                replaces: None,
                deadline: now.saturating_add(BASE_PREPARE_MS),
            });
        }
    }
    fn prune_proofs(&mut self) {
        let candidates = self.candidate_links();
        self.acknowledged.retain(|(first, second)| {
            self.plan.parents.get(first) == Some(second)
                || self.plan.parents.get(second) == Some(first)
                || candidates.iter().any(|(parent, child)| {
                    (*parent == *first && *child == *second)
                        || (*parent == *second && *child == *first)
                })
        });
    }
    pub fn state(&mut self, endpoint: Uuid, peer: Uuid, ready: bool) -> bool {
        if !self.contains(endpoint, peer) {
            return false;
        }
        if !ready {
            self.failed(endpoint, peer);
            return true;
        }
        let (child, parent) = if self.plan.parents.get(&endpoint) == Some(&peer) {
            (endpoint, peer)
        } else {
            (peer, endpoint)
        };
        let changed = self.acknowledged.insert((endpoint, peer));
        if self.candidate_links().iter().any(|(parent, child)| {
            (*parent == endpoint && *child == peer) || (*parent == peer && *child == endpoint)
        }) {
            return changed;
        }
        if self.acknowledged.contains(&(peer, endpoint)) {
            self.plan.mark_ready(child, parent, Readiness::Forwardable);
        }
        changed
    }
    pub fn failed(&mut self, first: Uuid, second: Uuid) {
        if self.candidate_links().iter().any(|(parent, child)| {
            (*parent == first && *child == second) || (*parent == second && *child == first)
        }) {
            if self.plan.parents.get(&first) == Some(&second)
                || self.plan.parents.get(&second) == Some(&first)
            {
                self.plan.failed_pair(first, second);
            }
            self.abort_candidate(Some((first, second)));
            return;
        }
        self.plan.failed_pair(first, second);
        self.prune_proofs();
    }

    pub fn deadline(&self) -> Option<u64> {
        self.operation.as_ref().map(|operation| operation.deadline)
    }
    pub fn candidate_links(&self) -> Vec<(Uuid, Uuid)> {
        self.operation
            .as_ref()
            .map_or_else(Vec::new, BaseOperation::edges)
    }
    pub fn candidate_ready(&self) -> bool {
        let candidates = self.candidate_links();
        !candidates.is_empty()
            && candidates.iter().all(|(parent, child)| {
                self.acknowledged.contains(&(*parent, *child))
                    && self.acknowledged.contains(&(*child, *parent))
            })
    }
    pub fn candidate_tree(&self) -> Option<Self> {
        let operation = self.operation.as_ref()?;
        let edges = operation.edges();
        if edges.is_empty() {
            return None;
        }
        let mut candidate = self.clone();
        candidate.operation = None;
        if let Some(BaseCandidate::FileShortcut { source }) = operation.candidate {
            candidate.plan = self.file_shortcut_plan(source, operation.child);
            return Some(candidate);
        }
        for (parent, child) in edges {
            candidate.plan.parents.insert(child, parent);
            candidate
                .plan
                .mark_ready(child, parent, Readiness::Forwardable);
        }
        Some(candidate)
    }
    fn file_shortcut_plan(&self, source: Uuid, receiver: Uuid) -> Plan {
        let mut plan = self.plan.clone();
        // Room ACKs prove both directions of the retained edges.
        let mut child = source;
        let mut parent = plan.parents.remove(&child);
        while let Some(previous) = parent {
            parent = plan.parents.insert(previous, child);
            plan.ready.insert(previous, Readiness::Forwardable);
            child = previous;
        }
        plan.ready.remove(&source);
        plan.source = source;
        plan.parents.insert(receiver, source);
        plan.mark_ready(receiver, source, Readiness::Forwardable);
        plan
    }
    pub fn commit(&mut self) {
        if let Some(candidate) = self.candidate_tree() {
            self.plan = candidate.plan;
            self.operation = None;
            self.prune_proofs();
        }
    }
    pub fn abort(&mut self) {
        self.abort_candidate(None);
    }

    fn abort_candidate(&mut self, failed_pair: Option<(Uuid, Uuid)>) {
        if let Some(operation) = &mut self.operation {
            for (a, b) in operation.edges() {
                if failed_pair.is_none_or(|pair| pair == (a, b) || pair == (b, a)) {
                    let peer = if operation.child == a { b } else { a };
                    self.plan.reject_parent(operation.child, peer);
                }
            }
            if matches!(
                operation.candidate,
                Some(BaseCandidate::FileShortcut { .. })
            ) {
                self.operation = None;
            } else {
                operation.candidate = None;
            }
            self.prune_proofs();
        }
    }

    /// Walk the ready tree from the actual source, then retain only the unique
    /// paths to listeners. Shared directed edges carry one copy of that source.
    pub fn project(&self, source: Uuid, listeners: &BTreeSet<Uuid>) -> BTreeSet<(Uuid, Uuid)> {
        self.project_avoiding(source, listeners, &BTreeSet::new())
    }
    pub fn project_avoiding(
        &self,
        source: Uuid,
        listeners: &BTreeSet<Uuid>,
        refused: &BTreeSet<(Uuid, Uuid)>,
    ) -> BTreeSet<(Uuid, Uuid)> {
        let mut adjacency = BTreeMap::<Uuid, Vec<Uuid>>::new();
        for (parent, child) in self.plan.ready_edges() {
            adjacency.entry(parent).or_default().push(child);
            adjacency.entry(child).or_default().push(parent);
        }
        let mut parents = BTreeMap::new();
        let mut visited = BTreeSet::from([source]);
        let mut pending = vec![source];
        while let Some(node) = pending.pop() {
            for next in adjacency.get(&node).into_iter().flatten() {
                if !refused.contains(&(node, *next)) && visited.insert(*next) {
                    parents.insert(*next, node);
                    pending.push(*next);
                }
            }
        }
        let mut flows = BTreeSet::new();
        for listener in listeners {
            let mut child = *listener;
            while let Some(parent) = parents.get(&child) {
                flows.insert((*parent, child));
                child = *parent;
            }
        }
        flows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmed_viewer_reuses_only_an_exclusive_pending_source_slot() {
        let id = Uuid::from_u128;
        let (source, exclusive, shared, viewer) = (id(1), id(2), id(3), id(4));
        let order = [exclusive, shared, viewer];
        let members = [source, exclusive, shared, viewer].into();
        let neighbors = [(source, [viewer].into()), (viewer, [source].into())].into();
        let graph = ScreenDemand { order: &order, neighbors: &neighbors, relays: &BTreeSet::new() };
        let mut plan = Plan::new(source);
        plan.parents.extend([(exclusive, source), (shared, source)]);
        let limits = RelayLimits {
            source_direct_limit: Some(2),
            shared: [(source, [shared].into())].into(),
            ..Default::default()
        };
        plan.reconcile_demand(&order.into(), &members, &members, None, &BTreeMap::new(), &limits, Some(&graph));
        assert_eq!(plan.parents, [(viewer, source), (shared, source)].into());
    }

    #[test]
    fn confirmed_relay_serves_new_viewer_without_displacing_pending_direct_slot() {
        let id = Uuid::from_u128;
        let (source, pending, relay, viewer) = (id(1), id(2), id(3), id(4));
        let order = [pending, relay, viewer];
        let members = [source, pending, relay, viewer].into();
        let neighbors = [
            (source, [relay, viewer].into()),
            (relay, [source, viewer].into()),
            (viewer, [source, relay].into()),
        ]
        .into();
        let graph = ScreenDemand {
            order: &order,
            neighbors: &neighbors,
            relays: &[relay].into(),
        };
        let limits = RelayLimits {
            source_direct_limit: Some(2),
            default: 1,
            ..Default::default()
        };
        let mut plan = Plan::new(source);
        plan.parents.extend([(pending, source), (relay, source)]);
        plan.ready.insert(relay, Readiness::Decoded);

        plan.reconcile_demand(
            &order.into(),
            &members,
            &members,
            None,
            &BTreeMap::new(),
            &limits,
            Some(&graph),
        );

        assert_eq!(plan.parents.get(&pending), Some(&source));
        assert!(!plan.ready.contains_key(&pending));
        assert_eq!(plan.parents.get(&relay), Some(&source));
        assert!(matches!(plan.ready.get(&relay), Some(Readiness::Decoded)));
        assert_eq!(plan.parents.get(&viewer), Some(&relay));
        assert_eq!(plan.parents.values().filter(|&&parent| parent == source).count(), 2);
        assert_eq!(plan.parents.values().filter(|&&parent| parent == relay).count(), 1);
    }

    #[test]
    fn confirmed_chain_reuses_a_publishers_edge_to_the_only_leaf() {
        let neighbors = [(id(0), set(&[1, 2, 3])), (id(1), set(&[0, 2, 3, 4])),
            (id(2), set(&[0, 1, 3])), (id(3), set(&[0, 1, 2])), (id(4), set(&[1]))].into();
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
        let [b, a, d, c, other] = [1, 2, 3, 4, 5].map(Uuid::from_u128);
        let mut neighbors = BTreeMap::<_, BTreeSet<_>>::new();
        for (x, y) in [(b, a), (a, d), (d, c)] {
            neighbors.entry(x).or_default().insert(y);
            neighbors.entry(y).or_default().insert(x);
        }
        let viewers = [c, other].into();
        let online = [b, a, d, c, other].into();
        let screen = ScreenDemand {
            order: &[c, other],
            neighbors: &neighbors,
            relays: &[a].into(),
        };
        let limits = RelayLimits::default();
        for prefix in [a, d] {
            let mut plan = Plan::new(b);
            plan.parents = [(prefix, b), (c, prefix), (other, b)].into();
            plan.mark_ready(other, b, Readiness::Decoded);
            if prefix == a {
                plan.mark_ready(a, b, Readiness::Forwardable);
            }
            let before = plan.parents.clone();
            plan.reconcile_demand(
                &viewers,
                &online,
                &online,
                None,
                &BTreeMap::new(),
                &limits,
                Some(&screen),
            );
            assert_eq!(plan.parents, before);
            let relays = [a, d].into();
            let enabled = ScreenDemand {
                relays: &relays,
                ..screen
            };
            plan.reconcile_demand(
                &viewers,
                &online,
                &online,
                None,
                &BTreeMap::new(),
                &limits,
                Some(&enabled),
            );
            assert_eq!(plan.parents, [(a, b), (d, a), (c, d), (other, b)].into());
            assert!(plan.readiness(other) == Some(Readiness::Decoded));
            if prefix == a {
                assert!(plan.readiness(a) == Some(Readiness::Forwardable));
            }
        }
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
    fn positive_endpoint_limits_apply_to_host_and_source_without_changing_zero_roots() {
        let id = Uuid::from_u128;
        let mut limits = RelayLimits {
            shared: Default::default(),
            source_direct_limit: None,
            default: 2,
            host: id(1),
            overrides: [(id(1), 1), (id(2), 4), (id(3), 3)].into(),
        };
        assert_eq!(limits.get(id(1), id(2)), 1);
        assert_eq!(limits.get(id(2), id(2)), 4);
        assert_eq!(limits.get(id(3), id(2)), 3);
        for endpoint in [id(1), id(2), id(3)] {
            limits.overrides.insert(endpoint, 0);
        }
        assert_eq!(limits.get(id(1), id(2)), 2);
        assert_eq!(limits.get(id(2), id(2)), 2);
        assert_eq!(limits.get(id(3), id(2)), 0);
    }
    #[test]
    fn host_override_reduction_prepares_migration_and_increase_keeps_healthy_tree() {
        let id = Uuid::from_u128;
        let online = [1, 2, 3, 4].into_iter().map(id).collect();
        let mut tree = BaseTree::new(id(1));
        tree.plan.parents = [(id(2), id(1)), (id(3), id(1)), (id(4), id(2))].into();
        for (child, parent) in tree.plan.parents.clone() {
            tree.plan.mark_ready(child, parent, Readiness::Forwardable);
        }
        let original = tree.plan.parents.clone();
        let mut limits = RelayLimits {
            shared: Default::default(),
            source_direct_limit: None,
            default: 2,
            host: id(1),
            overrides: [(id(1), 3)].into(),
        };
        tree.reconcile(&online, &online, &online, &limits, 0);
        assert_eq!(tree.plan.parents, original);
        assert!(tree.candidate_links().is_empty());
        limits.overrides.insert(id(1), 1);
        tree.reconcile(&online, &online, &online, &limits, 10);
        assert_eq!(tree.plan.parents, original);
        assert_eq!(tree.candidate_links().len(), 1);
        let deadline = tree.deadline();
        tree.reconcile(&online, &online, &online, &limits, 11);
        assert_eq!(tree.deadline(), deadline);
        limits.overrides.insert(id(1), 3);
        tree.reconcile(&online, &online, &online, &limits, 12);
        assert_eq!(tree.plan.parents, original);
        assert!(tree.candidate_links().is_empty());
    }

    #[test]
    fn capacity_candidate_losing_its_root_path_keeps_the_old_branch_and_deadline() {
        let id = Uuid::from_u128;
        let online = [1, 2, 3, 4].into_iter().map(id).collect();
        let mut base = BaseTree::new(id(1));
        base.plan.parents = [(id(2), id(1)), (id(3), id(1)), (id(4), id(2))].into();
        for (child, parent) in base.plan.parents.clone() {
            base.plan.mark_ready(child, parent, Readiness::Forwardable);
        }
        let limits = RelayLimits {
            overrides: [(id(2), 0)].into(),
            ..Default::default()
        };
        base.reconcile(&online, &online, &online, &limits, 10);
        assert_eq!(base.candidate_links(), vec![(id(3), id(4))]);
        base.state(id(3), id(4), true);
        base.state(id(4), id(3), true);
        assert!(base.candidate_ready());
        let deadline = base.deadline();
        base.failed(id(1), id(3));
        base.reconcile(&online, &online, &online, &limits, 11);
        assert_eq!(base.deadline(), deadline);
        assert!(!base.candidate_ready());
        assert!(
            base.plan.parents.get(&id(4)) == Some(&id(2)),
            "the acknowledged but unrooted candidate cannot release a healthy incumbent"
        );
        assert!(!base
            .candidate_tree()
            .is_some_and(|candidate| candidate.plan.parents.get(&id(4)) == Some(&id(3))));
    }

    #[test]
    fn failed_insert_leg_allows_another_branch_under_the_same_parent() {
        let online = set(&[1, 2, 3, 4]);
        let mut base = BaseTree::new(id(1));
        let limits = RelayLimits {
            default: 0,
            overrides: [(id(1), 2), (id(4), 1)].into(),
            ..Default::default()
        };
        for branch in [id(2), id(3)] {
            base.plan.parents.insert(branch, id(1));
            base.state(id(1), branch, true);
            base.state(branch, id(1), true);
        }
        base.reconcile(&online, &online, &online, &limits, 10);
        assert_eq!(base.candidate_links(), [(id(1), id(4)), (id(4), id(2))]);
        assert!(base.state(id(2), id(4), false));
        assert_eq!(base.plan.failed_parents[&id(4)], set(&[2]));
        base.reconcile(&online, &online, &online, &limits, 11);
        assert_eq!(base.candidate_links(), [(id(1), id(4)), (id(4), id(3))]);
        assert_eq!(base.deadline(), Some(20_010));
        assert!(base.ready(id(2)) && base.ready(id(3)));
    }

    #[test]
    fn failed_capacity_rotation_retires_only_the_original_excess_edge_at_the_same_deadline() {
        let id = Uuid::from_u128;
        let online = [1, 2, 3].into_iter().map(id).collect();
        let mut base = BaseTree::new(id(1));
        base.plan.parents = [(id(2), id(1)), (id(3), id(2))].into();
        for (child, parent) in base.plan.parents.clone() {
            base.plan.mark_ready(child, parent, Readiness::Forwardable);
        }
        let limits = RelayLimits {
            default: 1,
            overrides: [(id(2), 0), (id(3), 2)].into(),
            ..Default::default()
        };
        base.reconcile(&online, &online, &online, &limits, 10);
        assert_eq!(base.candidate_links(), vec![(id(1), id(3)), (id(3), id(2))]);
        base.failed(id(1), id(3));
        base.reconcile(&online, &online, &online, &limits, 11);
        assert_eq!(base.deadline(), Some(20_010));
        assert_eq!(base.plan.parents.get(&id(3)), Some(&id(2)));
        base.reconcile(&online, &online, &online, &limits, 20_010);
        assert_eq!(
            base.plan.parents.get(&id(2)),
            Some(&id(1)),
            "the parent slot's healthy leaf is not the edge the user withdrew"
        );
        assert!(!base.plan.parents.contains_key(&id(3)));
    }

    #[test]
    fn required_capacity_deadline_survives_same_session_signaling_recovery() {
        let all = set(&[1, 2, 3]);
        let mut demand = BTreeSet::new();
        let mut base = BaseTree::new(id(1));
        let mut limits = RelayLimits {
            shared: Default::default(),
            source_direct_limit: None,
            default: 1,
            host: id(1),
            overrides: BTreeMap::new(),
        };
        for endpoint in [2, 3] {
            demand.insert(id(endpoint));
            base.reconcile(&demand, &all, &all, &limits, 0);
            for (parent, child) in base.links().collect::<Vec<_>>() {
                base.state(parent, child, true);
                base.state(child, parent, true);
            }
        }
        assert_eq!(base.plan.parents, [(id(2), id(1)), (id(3), id(2))].into());
        limits.overrides = [(id(2), 0), (id(3), 2)].into();
        base.reconcile(&demand, &all, &all, &limits, 10);
        assert_eq!(base.deadline(), Some(20_010));
        assert_eq!(base.candidate_links(), [(id(1), id(3)), (id(3), id(2))]);
        // Signaling recovery retains this endpoint and its healthy media. It may
        // retire the candidate, but cannot renew the explicit reduction's TTL.
        let connected = set(&[1, 2]);
        for now in [11, 1000] {
            base.reconcile(&demand, &all, &connected, &limits, now);
            assert_eq!(base.deadline(), Some(20_010));
            assert!(base.candidate_links().is_empty());
        }
        base.reconcile(&demand, &all, &all, &limits, 1500);
        assert_eq!(base.deadline(), Some(20_010));
        base.reconcile(&demand, &all, &all, &limits, 20_010);
        assert_eq!(base.plan.parents.get(&id(2)), Some(&id(1)));
        assert!(
            base.ready(id(2)),
            "the retained healthy branch keeps its proof"
        );
        assert!(
            !base.links().any(|(parent, _)| parent == id(2)),
            "zero must stop forwarding at the original required deadline"
        );
    }

    #[test]
    fn transit_rotation_retains_partial_proof_and_an_ineligible_missing_leaf_cannot_block_a_relay()
    {
        let id = Uuid::from_u128;
        let online = [1, 2, 3, 4].into_iter().map(id).collect();
        let mut base = BaseTree::new(id(1));
        base.plan.parents = [(id(2), id(1)), (id(3), id(2)), (id(4), id(3))].into();
        for (child, parent) in base.plan.parents.clone() {
            base.plan.mark_ready(child, parent, Readiness::Forwardable);
        }
        let limits = RelayLimits {
            default: 1,
            overrides: [(id(2), 0), (id(3), 2), (id(4), 0)].into(),
            ..Default::default()
        };
        let demand = [id(4)].into_iter().collect();
        base.reconcile(&demand, &online, &online, &limits, 10);
        let candidates = base.candidate_links();
        assert_eq!(candidates, vec![(id(1), id(3)), (id(3), id(2))]);
        for (parent, child) in candidates {
            base.state(parent, child, true);
            base.reconcile(&demand, &online, &online, &limits, 11);
            base.state(child, parent, true);
            base.reconcile(&demand, &online, &online, &limits, 12);
            assert_eq!(
                base.deadline(),
                Some(20_010),
                "a required transit node need not have personal demand"
            );
        }
        assert!(base.candidate_ready());
        base.commit();
        assert_eq!(base.plan.parents.get(&id(2)), Some(&id(3)));

        let mut base = BaseTree::new(id(1));
        base.plan.parents.insert(id(2), id(1));
        base.plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        let limits = RelayLimits {
            default: 1,
            overrides: [(id(2), 0), (id(3), 0), (id(4), 2)].into(),
            ..Default::default()
        };
        base.reconcile(&online, &online, &online, &limits, 20);
        assert_eq!(
            base.candidate_links(),
            vec![(id(1), id(4)), (id(4), id(2))],
            "the missing zero leaf cannot occupy the one operation before a feasible relay"
        );
        for (parent, child) in base.candidate_links() {
            base.state(parent, child, true);
            base.state(child, parent, true);
        }
        base.commit();
        base.reconcile(&online, &online, &online, &limits, 21);
        assert_eq!(base.plan.parents.get(&id(3)), Some(&id(4)));
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
        plan.reconcile(
            &requested,
            &connected,
            &connected,
            None,
            &helpers,
            &Default::default(),
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

    #[test]
    fn required_base_repair_waits_for_pending_admission_to_finish() {
        let id = Uuid::from_u128;
        let connected = BTreeSet::from([id(1), id(2), id(3), id(4)]);
        let mut demand = BTreeSet::new();
        let mut base = BaseTree::new(id(1));
        for child in [2, 3, 4] {
            demand.insert(id(child));
            base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
            for (parent, child) in base.links().collect::<Vec<_>>() {
                base.state(parent, child, true);
                base.state(child, parent, true);
            }
        }
        assert_eq!(
            base.plan.parents,
            BTreeMap::from([(id(2), id(1)), (id(3), id(1)), (id(4), id(2))])
        );
        // The two relay edges fail independently. Failed shortcut attempts then
        // time out at different times, while H-S remains ready throughout.
        for (first, second) in [(2, 4), (1, 2), (3, 4), (3, 2)] {
            base.failed(id(first), id(second));
            base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
        }
        assert!(base.needs_repair(&demand, &connected));
        assert_eq!(base.plan.parents.get(&id(4)), Some(&id(1)));
        assert!(!base.plan.ready.contains_key(&id(4)));
        base.retry_required(&demand, &connected);
        base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
        assert_eq!(
            base.plan.parents.get(&id(3)),
            Some(&id(1)),
            "the healthy base stays installed"
        );
        assert!(base.plan.ready.contains_key(&id(3)));
        assert_eq!(
            base.plan.parents.get(&id(4)),
            Some(&id(1)),
            "another required path's retry cannot revoke pending admission"
        );
        // The pending edge's own failure releases its capacity. Normal
        // reconciliation can then retry the old relay at the root.
        base.failed(id(1), id(4));
        base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
        assert_eq!(
            base.plan.parents.get(&id(2)),
            Some(&id(1)),
            "the relay retries once the occupied root slot actually retires"
        );
    }
    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }
    fn set(values: &[u128]) -> BTreeSet<Uuid> {
        values.iter().map(|value| id(*value)).collect()
    }

    #[test]
    fn pending_base_keeps_its_ready_parent_on_an_equal_depth_tie() {
        use crate::transport::{BaseLink, TransportBook};

        let available = set(&[1, 2, 3, 4]);
        let demand = set(&[2, 3, 4]);
        let mut base = BaseTree::new(id(1));
        base.reconcile(&demand, &available, &available, &Default::default(), 0);
        // B=2 is earlier in the BFS order, but only A=3 can yet relay C=4.
        base.state(id(1), id(3), true);
        base.state(id(3), id(1), true);
        base.reconcile(&demand, &available, &available, &Default::default(), 0);
        assert_eq!(base.plan.parents[&id(4)], id(3));
        assert!(!base.ready(id(4)));

        let project = |transports: &mut TransportBook, base: &BaseTree| {
            transports.reconcile(
                std::iter::empty(),
                base.links().map(|(parent, child)| BaseLink {
                    room_id: "room".into(),
                    parent,
                    child,
                    ready: base.ready(child),
                    selected: true,
                }),
            );
        };
        let mut transports = TransportBook::default();
        project(&mut transports, &base);
        let original = transports.snapshot(id(4), |_| false, |_| false)[0].clone();

        // C's first offer may still be in flight. B becoming ready changes
        // neither A's authority/capacity nor the depth of C's installed edge.
        base.state(id(1), id(2), true);
        base.state(id(2), id(1), true);
        base.reconcile(&demand, &available, &available, &Default::default(), 0);
        project(&mut transports, &base);
        let current = transports.snapshot(id(4), |_| false, |_| false);
        assert_eq!(current.len(), 1);
        assert_eq!(
            current[0].id, original.id,
            "an equal-depth ready relay must not revoke the pending physical attempt"
        );
        assert_eq!(current[0].peer_id, id(3));
        assert_eq!(base.plan.parents[&id(4)], id(3));

        // Releasing B's root slot still permits an actually shallower parent.
        base.reconcile(
            &set(&[3, 4]),
            &available,
            &available,
            &Default::default(),
            0,
        );
        assert_eq!(base.plan.parents[&id(4)], id(1));
    }

    #[test]
    fn recovered_base_replaces_an_unproved_screen_fallback() {
        let connected = set(&[1, 2, 3, 4]);
        let demand = set(&[2, 3, 4]);
        let watching = set(&[4]);
        let mut base = BaseTree::new(id(1));
        for _ in 0..2 {
            base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
            for (parent, child) in base.links().collect::<Vec<_>>() {
                base.state(parent, child, true);
                base.state(child, parent, true);
            }
        }
        let mut screen = Plan::new(id(3));
        screen.reconcile(
            &watching,
            &connected,
            &connected,
            Some(&base),
            &BTreeMap::new(),
            &Default::default(),
        );
        for (child, parent) in screen.parents.clone() {
            screen.mark_ready(child, parent, Readiness::Decoded);
        }
        // H=1, R=2, S=3, V=4. The two relay edges and later shortcut
        // attempts fail independently while H-S stays ready.
        for (first, second) in [(2, 4), (1, 2), (3, 4), (3, 2)] {
            base.failed(id(first), id(second));
            screen.failed(id(first), id(second));
            base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
            screen.reconcile(
                &watching,
                &connected,
                &connected,
                Some(&base),
                &BTreeMap::new(),
                &Default::default(),
            );
        }
        base.retry_required(&demand, &connected);
        screen.retry_required(&watching, &connected);
        base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
        screen.reconcile(
            &watching,
            &connected,
            &connected,
            Some(&base),
            &BTreeMap::new(),
            &Default::default(),
        );
        // Preserve the pending root admission until its own attempt fails;
        // clearing another missing path's history does not cancel that lease.
        assert_eq!(base.plan.parents.get(&id(4)), Some(&id(1)));
        base.failed(id(1), id(4));
        base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
        base.retry_required(&demand, &connected);
        base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
        let pending: Vec<_> = base.links().collect();
        base.state(id(1), id(2), true);
        base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
        assert_eq!(base.links().collect::<Vec<_>>(), pending);
        base.state(id(2), id(1), true);
        base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
        assert!(base.plan.ready.contains_key(&id(2)));
        assert!(base.plan.ready.contains_key(&id(3)));
        assert_eq!(screen.parents[&id(4)], id(3));
        assert_eq!(base.plan.parents[&id(4)], id(3));
        // A recovered equal-depth relay waits for this base attempt's own failure.
        // The picture fallback is independent and remains installed for the graft.
        assert!(base.state(id(3), id(4), false));
        base.reconcile(&demand, &connected, &connected, &Default::default(), 0);
        assert_eq!(base.plan.parents[&id(4)], id(2));
        base.state(id(2), id(4), true);
        base.state(id(4), id(2), true);
        screen.reconcile(
            &watching,
            &connected,
            &connected,
            Some(&base),
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(
            screen.parents,
            BTreeMap::from([(id(1), id(3)), (id(2), id(1)), (id(4), id(2))]),
            "a complete base path must be reusable before an unproved shortcut times out"
        );
    }

    #[test]
    fn base_graft_preserves_pending_media_when_the_existing_anchor_would_cycle() {
        let available = set(&[1, 2, 3, 4]);
        let mut screen = Plan::new(id(1));
        screen.reconcile(
            &set(&[2, 3, 4]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        screen.mark_ready(id(2), id(1), Readiness::Forwardable);
        screen.reconcile(
            &set(&[2, 3, 4]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        screen.mark_ready(id(4), id(2), Readiness::Decoded);
        screen.forget_ready(id(2));
        let before = screen.parents.clone();

        let mut base = BaseTree::new(id(4));
        for _ in 0..2 {
            base.reconcile(
                &set(&[1, 2, 3]),
                &available,
                &available,
                &Default::default(),
                0,
            );
            for (parent, child) in base.links().collect::<Vec<_>>() {
                base.state(parent, child, true);
                base.state(child, parent, true);
            }
        }
        base.failed(id(1), id(3));
        base.reconcile(
            &set(&[1, 2, 3]),
            &available,
            &available,
            &Default::default(),
            0,
        );
        assert_eq!(base.plan.parents[&id(3)], id(2));
        base.state(id(2), id(3), true);
        base.state(id(3), id(2), true);
        let parents = base
            .project(id(1), &set(&[3]))
            .into_iter()
            .map(|(parent, child)| (child, parent))
            .collect();
        assert!(!screen.graft_base(
            id(3),
            &parents,
            &available,
            &available,
            &BTreeMap::new(),
            &Default::default()
        ));
        assert_eq!(screen.parents, before);
    }

    #[test]
    fn source_fanout_then_ready_subscriber_relay_and_sticky_healthy_edges() {
        let mut plan = Plan::new(id(1));
        let requested = set(&[2, 3, 4, 5]);
        let available = set(&[1, 2, 3, 4, 5]);
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents.len(), 2);
        assert!(plan.mark_ready(id(2), id(1), Readiness::Forwardable));
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents[&id(4)], id(2));
        assert_eq!(plan.parents[&id(5)], id(2));
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents[&id(3)], id(1));
        assert_eq!(plan.parents[&id(4)], id(2));
    }

    #[test]
    fn relay_failure_retires_descendants_only_and_does_not_mutate_another_source() {
        let mut first = Plan::new(id(1));
        let mut second = Plan::new(id(2));
        let requested = set(&[2, 3, 4, 5]);
        let available = set(&[1, 2, 3, 4, 5]);
        first.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        first.mark_ready(id(2), id(1), Readiness::Forwardable);
        first.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        second.reconcile(
            &set(&[1, 3]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        let second_before = second.parents.clone();
        first.failed(id(1), id(2));
        assert_eq!(first.parents, BTreeMap::from([(id(3), id(1))]));
        first.mark_ready(id(3), id(1), Readiness::Forwardable);
        first.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(first.parents[&id(3)], id(1));
        assert_ne!(first.parents.get(&id(2)), Some(&id(1)));
        assert_eq!(second.parents, second_before);
    }

    #[test]
    fn unwatch_keeps_required_transit_until_its_last_downstream_leaves() {
        let mut plan = Plan::new(id(1));
        let available = set(&[1, 2, 3, 4]);
        plan.reconcile(
            &set(&[2, 3, 4]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        plan.reconcile(
            &set(&[2, 3, 4]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        let before = plan.parents.clone();
        plan.reconcile(
            &set(&[3, 4]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents, before);
        assert!(
            !plan.mark_ready(id(2), id(1), Readiness::Forwardable),
            "existing transit proof is retained"
        );
        plan.reconcile(
            &set(&[3]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert!(!plan.parents.contains_key(&id(2)));
        assert!(!plan.parents.values().any(|parent| *parent == id(2)));
        assert!(!plan.mark_ready(id(2), id(1), Readiness::Forwardable));
        assert_eq!(plan.parents, BTreeMap::from([(id(3), id(1))]));
    }

    #[test]
    fn view_toggles_do_not_retry_a_failed_parent() {
        let mut plan = Plan::new(id(1));
        let available = set(&[1, 2]);
        plan.reconcile(
            &set(&[2]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        plan.failed(id(1), id(2));
        plan.reconcile(
            &set(&[]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        plan.reconcile(
            &set(&[2]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert!(plan.parents.is_empty());
    }

    #[test]
    fn required_repair_retains_a_healthy_relays_failed_shortcut() {
        let available = set(&[1, 2, 3, 4]);
        let mut plan = Plan::new(id(1));
        let requested = set(&[2, 3]);
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        plan.mark_ready(id(2), id(1), Readiness::Decoded);
        plan.failed(id(1), id(3));
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents[&id(3)], id(2));
        plan.mark_ready(id(3), id(2), Readiness::Decoded);
        let requested = set(&[2, 3, 4]);
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        while let Some(parent) = plan.parents.get(&id(4)).copied() {
            plan.failed(parent, id(4));
            plan.reconcile(
                &requested,
                &available,
                &available,
                None,
                &BTreeMap::new(),
                &Default::default(),
            );
        }
        assert!(plan.needs_repair(&requested, &available));
        plan.retry_required(&requested, &available);
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents[&id(4)], id(1));
        assert_eq!(plan.parents[&id(3)], id(2));
        assert!(!plan.can_shortcut(id(3), &BTreeMap::new(), &Default::default()));
        assert!(!plan.needs_repair(&requested, &available));
    }

    #[test]
    fn unrelated_failure_memory_does_not_cancel_pending_base_admission() {
        let available = set(&[1, 2, 3, 4, 5]);
        let mut base = BaseTree::new(id(1));
        base.reconcile(
            &set(&[2, 3]),
            &available,
            &available,
            &Default::default(),
            0,
        );
        base.state(id(1), id(2), true);
        base.state(id(2), id(1), true);
        // A different source's physical trial failed between these members.
        base.failed(id(2), id(3));
        base.reconcile(
            &set(&[3, 4, 5]),
            &available,
            &available,
            &Default::default(),
            0,
        );
        assert_eq!(
            base.plan.parents,
            BTreeMap::from([(id(3), id(1)), (id(4), id(1))])
        );
        assert!(!base.needs_repair(&set(&[3, 4, 5]), &available));
        let pending = base.plan.parents.clone();
        base.retry_required(&set(&[3, 4, 5]), &available);
        assert_eq!(base.plan.parents, pending);
    }

    #[test]
    fn healthy_unwatch_rewatch_and_ancestor_loss_do_not_mark_a_leg_failed() {
        let mut plan = Plan::new(id(1));
        let available = set(&[1, 2, 3, 4]);
        plan.reconcile(
            &set(&[2]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        plan.reconcile(
            &set(&[]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        plan.reconcile(
            &set(&[2]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents[&id(2)], id(1));

        plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        plan.reconcile(
            &set(&[2, 3, 4]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents[&id(4)], id(2));
        plan.failed(id(1), id(2));
        assert!(plan.failed_parents[&id(2)].contains(&id(1)));
        assert!(plan
            .failed_parents
            .get(&id(4))
            .is_none_or(BTreeSet::is_empty));
        plan.mark_ready(id(3), id(1), Readiness::Forwardable);
        plan.reconcile(
            &set(&[2, 3, 4]),
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents[&id(2)], id(3));
        assert!(plan.parents.contains_key(&id(4)));
    }
    #[test]
    fn exhausted_old_parents_do_not_block_a_new_ready_candidate() {
        let mut plan = Plan::new(id(1));
        let mut requested = set(&[2, 3, 4, 5, 6, 7, 8, 9]);
        let mut available = requested.clone();
        available.insert(id(1));
        for _ in 0..5 {
            plan.reconcile(
                &requested,
                &available,
                &available,
                None,
                &BTreeMap::new(),
                &Default::default(),
            );
            for (child, parent) in plan.parents.clone() {
                plan.mark_ready(child, parent, Readiness::Forwardable);
            }
        }
        for _ in 0..4 {
            let parent = plan.parents[&id(9)];
            plan.failed(parent, id(9));
            plan.reconcile(
                &requested,
                &available,
                &available,
                None,
                &BTreeMap::new(),
                &Default::default(),
            );
        }
        // Keep failing actual assigned candidates until the existing live pool
        // has no free untried parent; a new endpoint must still get a chance.
        while let Some(parent) = plan.parents.get(&id(9)).copied() {
            plan.failed(parent, id(9));
            plan.reconcile(
                &requested,
                &available,
                &available,
                None,
                &BTreeMap::new(),
                &Default::default(),
            );
        }
        available.insert(id(10));
        requested.insert(id(10));
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        let parent = plan.parents[&id(10)];
        plan.mark_ready(id(10), parent, Readiness::Forwardable);
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(plan.parents[&id(9)], id(10));
        // Session retirement removes its old candidate failure fact. Mere
        // demand toggles retain it, as the existing regression above checks.
        available.remove(&id(4));
        plan.reconcile(
            &requested,
            &available,
            &available,
            None,
            &BTreeMap::new(),
            &Default::default(),
        );
        assert!(!plan.failed_parents[&id(9)].contains(&id(4)));
    }
    #[test]
    fn base_suffix_installs_transit_without_borrowing_its_media_proof() {
        let available = set(&[1, 2, 3, 4]);
        let mut base = BaseTree::new(id(1));
        base.reconcile(
            &set(&[2, 3, 4]),
            &available,
            &available,
            &Default::default(),
            0,
        );
        for peer in [id(2), id(3)] {
            base.state(id(1), peer, true);
            base.state(peer, id(1), true);
        }
        base.reconcile(
            &set(&[2, 3, 4]),
            &available,
            &available,
            &Default::default(),
            0,
        );
        base.state(id(2), id(4), true);
        base.state(id(4), id(2), true);
        let mut screen = Plan::new(id(3));
        screen.reconcile(
            &set(&[4]),
            &available,
            &available,
            Some(&base),
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(
            screen.parents,
            BTreeMap::from([(id(1), id(3)), (id(2), id(1)), (id(4), id(2))])
        );
        // Failure can belong to detached transit rather than the subscriber.
        screen.failed(id(3), id(1));
        screen.reconcile(
            &set(&[4]),
            &available,
            &available,
            Some(&base),
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(screen.parents[&id(4)], id(3));
        screen.failed(id(3), id(4));
        screen.reconcile(
            &set(&[4]),
            &available,
            &available,
            Some(&base),
            &BTreeMap::new(),
            &Default::default(),
        );
        assert!(screen.parents.is_empty());
        screen.retry_required(&set(&[4]), &available);
        screen.reconcile(
            &set(&[4]),
            &available,
            &available,
            Some(&base),
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(
            screen.parents,
            BTreeMap::from([(id(1), id(3)), (id(2), id(1)), (id(4), id(2))])
        );
        assert_eq!(
            screen.ready_edges().count(),
            0,
            "control readiness cannot prove picture delivery"
        );
        screen.reconcile(
            &set(&[2, 4]),
            &available,
            &available,
            Some(&base),
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(
            screen.parents.len(),
            3,
            "shared suffix is installed once before the first media proof"
        );
        screen.mark_ready(id(1), id(3), Readiness::Forwardable);
        assert_eq!(
            screen.ready_edges().collect::<Vec<_>>(),
            vec![(id(3), id(1))]
        );
        screen.failed(id(3), id(1));
        screen.reconcile(
            &set(&[4]),
            &available,
            &available,
            Some(&base),
            &BTreeMap::new(),
            &Default::default(),
        );
        assert_eq!(
            screen.parents,
            BTreeMap::from([(id(4), id(3))]),
            "failed base picture preparation uses the same availability fallback"
        );
    }
}
