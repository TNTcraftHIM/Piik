use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const FANOUT: usize = 2;

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

impl Plan {
    pub fn new(source: Uuid) -> Self {
        Self {
            source,
            parents: BTreeMap::new(),
            ready: BTreeMap::new(),
            failed_parents: BTreeMap::new(),
        }
    }

    pub fn reconcile(
        &mut self,
        requested: &BTreeSet<Uuid>,
        available: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
        base: Option<&BaseTree>,
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
                if self.parents.contains_key(child) && !self.ready.contains_key(child) {
                    self.graft_base(*child, &base_parents, available, connected);
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
        for child in requested {
            if *child == self.source
                || self.parents.contains_key(child)
                || !connected.contains(child)
            {
                continue;
            }
            if self.graft_base(*child, &base_parents, available, connected) {
                continue;
            }
            if let Some(parent) = self.candidate_parent(*child, connected) {
                self.parents.insert(*child, parent);
            }
        }
    }

    fn candidate_parent(&self, child: Uuid, connected: &BTreeSet<Uuid>) -> Option<Uuid> {
        if !connected.contains(&self.source) || !connected.contains(&child) {
            return None;
        }
        self.subtree(self.source)
            .into_iter()
            .filter(|parent| *parent == self.source || self.ready.contains_key(parent))
            .filter(|parent| {
                *parent != child
                    && connected.contains(parent)
                    && !self
                        .failed_parents
                        .get(&child)
                        .is_some_and(|failed| failed.contains(parent))
            })
            .find(|parent| {
                self.parents
                    .iter()
                    .filter(|(receiver, upstream)| **receiver != child && *upstream == parent)
                    .count()
                    < FANOUT
            })
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

    pub fn can_shortcut(&self, child: Uuid) -> bool {
        self.parents
            .get(&child)
            .is_some_and(|parent| *parent != self.source)
            && self.ready.contains_key(&child)
            && self
                .parents
                .values()
                .filter(|parent| **parent == self.source)
                .count()
                < FANOUT
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

    pub fn shortcut_candidates(&self) -> Vec<Uuid> {
        let mut candidates = self.subtree(self.source);
        candidates.retain(|child| self.can_shortcut(*child));
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

    pub fn adopt_branch(&mut self, root: Uuid, proof: impl IntoIterator<Item = (Uuid, Readiness)>) {
        self.parents.insert(root, self.source);
        self.ready.extend(proof);
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

    fn detach(&mut self, child: Uuid) {
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
}

impl BaseTree {
    pub fn new(root: Uuid) -> Self {
        Self {
            plan: Plan::new(root),
            acknowledged: BTreeSet::new(),
        }
    }
    pub fn root(&self) -> Uuid {
        self.plan.source
    }
    pub fn needs_repair(&self, demand: &BTreeSet<Uuid>, connected: &BTreeSet<Uuid>) -> bool {
        self.plan.needs_repair(demand, connected)
    }
    pub fn retry_required(&mut self, demand: &BTreeSet<Uuid>, connected: &BTreeSet<Uuid>) {
        if !self.plan.needs_repair(demand, connected) {
            return;
        }
        // Unproved reservations must not consume the capacity needed to repair
        // a required base path. Keep the acknowledged healthy tree installed.
        self.plan
            .parents
            .retain(|child, _| self.plan.ready.contains_key(child));
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
    }
    pub fn reconcile(
        &mut self,
        demand: &BTreeSet<Uuid>,
        available: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
    ) {
        self.plan.reconcile(demand, available, connected, None);
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
            if let Some(parent) = self.plan.candidate_parent(child, connected) {
                self.plan.parents.insert(child, parent);
            }
        }
        self.plan.reconcile(demand, available, connected, None);
        self.plan
            .failed_parents
            .retain(|child, _| demand.contains(child) || self.plan.parents.contains_key(child));
        self.prune_proofs();
    }
    fn prune_proofs(&mut self) {
        self.acknowledged.retain(|(first, second)| {
            self.plan.parents.get(first) == Some(second)
                || self.plan.parents.get(second) == Some(first)
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
        if self.acknowledged.contains(&(peer, endpoint)) {
            self.plan.mark_ready(child, parent, Readiness::Forwardable);
        }
        changed
    }
    pub fn failed(&mut self, first: Uuid, second: Uuid) {
        self.plan.failed_pair(first, second);
        self.prune_proofs();
    }

    /// Walk the ready tree from the actual source, then retain only the unique
    /// paths to listeners. Shared directed edges carry one copy of that source.
    pub fn project(&self, source: Uuid, listeners: &BTreeSet<Uuid>) -> BTreeSet<(Uuid, Uuid)> {
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
                if visited.insert(*next) {
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
    fn required_base_repair_releases_unproved_capacity_before_retrying() {
        let id = Uuid::from_u128;
        let connected = BTreeSet::from([id(1), id(2), id(3), id(4)]);
        let mut demand = BTreeSet::new();
        let mut base = BaseTree::new(id(1));
        for child in [2, 3, 4] {
            demand.insert(id(child));
            base.reconcile(&demand, &connected, &connected);
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
            base.reconcile(&demand, &connected, &connected);
        }
        assert!(base.needs_repair(&demand, &connected));
        assert_eq!(base.plan.parents.get(&id(4)), Some(&id(1)));
        assert!(!base.plan.ready.contains_key(&id(4)));
        base.retry_required(&demand, &connected);
        base.reconcile(&demand, &connected, &connected);
        assert_eq!(
            base.plan.parents.get(&id(3)),
            Some(&id(1)),
            "the healthy base stays installed"
        );
        assert!(base.plan.ready.contains_key(&id(3)));
        assert_eq!(
            base.plan.parents.get(&id(2)),
            Some(&id(1)),
            "the reachable old relay edge needs a free root slot to retry"
        );
    }
    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }
    fn set(values: &[u128]) -> BTreeSet<Uuid> {
        values.iter().map(|value| id(*value)).collect()
    }

    #[test]
    fn recovered_base_replaces_an_unproved_screen_fallback() {
        let connected = set(&[1, 2, 3, 4]);
        let demand = set(&[2, 3, 4]);
        let watching = set(&[4]);
        let mut base = BaseTree::new(id(1));
        for _ in 0..2 {
            base.reconcile(&demand, &connected, &connected);
            for (parent, child) in base.links().collect::<Vec<_>>() {
                base.state(parent, child, true);
                base.state(child, parent, true);
            }
        }
        let mut screen = Plan::new(id(3));
        screen.reconcile(&watching, &connected, &connected, Some(&base));
        for (child, parent) in screen.parents.clone() {
            screen.mark_ready(child, parent, Readiness::Decoded);
        }
        // H=1, R=2, S=3, V=4. The two relay edges and later shortcut
        // attempts fail independently while H-S stays ready.
        for (first, second) in [(2, 4), (1, 2), (3, 4), (3, 2)] {
            base.failed(id(first), id(second));
            screen.failed(id(first), id(second));
            base.reconcile(&demand, &connected, &connected);
            screen.reconcile(&watching, &connected, &connected, Some(&base));
        }
        base.retry_required(&demand, &connected);
        screen.retry_required(&watching, &connected);
        base.reconcile(&demand, &connected, &connected);
        screen.reconcile(&watching, &connected, &connected, Some(&base));
        let pending: Vec<_> = base.links().collect();
        base.state(id(1), id(2), true);
        base.reconcile(&demand, &connected, &connected);
        assert_eq!(base.links().collect::<Vec<_>>(), pending);
        base.state(id(2), id(1), true);
        base.reconcile(&demand, &connected, &connected);
        assert!(base.plan.ready.contains_key(&id(2)));
        assert!(base.plan.ready.contains_key(&id(3)));
        assert_eq!(screen.parents[&id(4)], id(3));
        assert_eq!(base.plan.parents[&id(4)], id(2));
        base.state(id(2), id(4), true);
        base.state(id(4), id(2), true);
        screen.reconcile(&watching, &connected, &connected, Some(&base));
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
        screen.reconcile(&set(&[2, 3, 4]), &available, &available, None);
        screen.mark_ready(id(2), id(1), Readiness::Forwardable);
        screen.reconcile(&set(&[2, 3, 4]), &available, &available, None);
        screen.mark_ready(id(4), id(2), Readiness::Decoded);
        screen.forget_ready(id(2));
        let before = screen.parents.clone();

        let mut base = BaseTree::new(id(4));
        for _ in 0..2 {
            base.reconcile(&set(&[1, 2, 3]), &available, &available);
            for (parent, child) in base.links().collect::<Vec<_>>() {
                base.state(parent, child, true);
                base.state(child, parent, true);
            }
        }
        base.failed(id(1), id(3));
        base.reconcile(&set(&[1, 2, 3]), &available, &available);
        assert_eq!(base.plan.parents[&id(3)], id(2));
        base.state(id(2), id(3), true);
        base.state(id(3), id(2), true);
        let parents = base
            .project(id(1), &set(&[3]))
            .into_iter()
            .map(|(parent, child)| (child, parent))
            .collect();
        assert!(!screen.graft_base(id(3), &parents, &available, &available));
        assert_eq!(screen.parents, before);
    }

    #[test]
    fn source_fanout_then_ready_subscriber_relay_and_sticky_healthy_edges() {
        let mut plan = Plan::new(id(1));
        let requested = set(&[2, 3, 4, 5]);
        let available = set(&[1, 2, 3, 4, 5]);
        plan.reconcile(&requested, &available, &available, None);
        assert_eq!(plan.parents.len(), 2);
        assert!(plan.mark_ready(id(2), id(1), Readiness::Forwardable));
        plan.reconcile(&requested, &available, &available, None);
        assert_eq!(plan.parents[&id(4)], id(2));
        assert_eq!(plan.parents[&id(5)], id(2));
        plan.reconcile(&requested, &available, &available, None);
        assert_eq!(plan.parents[&id(3)], id(1));
        assert_eq!(plan.parents[&id(4)], id(2));
    }

    #[test]
    fn relay_failure_retires_descendants_only_and_does_not_mutate_another_source() {
        let mut first = Plan::new(id(1));
        let mut second = Plan::new(id(2));
        let requested = set(&[2, 3, 4, 5]);
        let available = set(&[1, 2, 3, 4, 5]);
        first.reconcile(&requested, &available, &available, None);
        first.mark_ready(id(2), id(1), Readiness::Forwardable);
        first.reconcile(&requested, &available, &available, None);
        second.reconcile(&set(&[1, 3]), &available, &available, None);
        let second_before = second.parents.clone();
        first.failed(id(1), id(2));
        assert_eq!(first.parents, BTreeMap::from([(id(3), id(1))]));
        first.mark_ready(id(3), id(1), Readiness::Forwardable);
        first.reconcile(&requested, &available, &available, None);
        assert_eq!(first.parents[&id(3)], id(1));
        assert_ne!(first.parents.get(&id(2)), Some(&id(1)));
        assert_eq!(second.parents, second_before);
    }

    #[test]
    fn unwatch_keeps_required_transit_until_its_last_downstream_leaves() {
        let mut plan = Plan::new(id(1));
        let available = set(&[1, 2, 3, 4]);
        plan.reconcile(&set(&[2, 3, 4]), &available, &available, None);
        plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        plan.reconcile(&set(&[2, 3, 4]), &available, &available, None);
        let before = plan.parents.clone();
        plan.reconcile(&set(&[3, 4]), &available, &available, None);
        assert_eq!(plan.parents, before);
        assert!(
            !plan.mark_ready(id(2), id(1), Readiness::Forwardable),
            "existing transit proof is retained"
        );
        plan.reconcile(&set(&[3]), &available, &available, None);
        assert!(!plan.parents.contains_key(&id(2)));
        assert!(!plan.parents.values().any(|parent| *parent == id(2)));
        assert!(!plan.mark_ready(id(2), id(1), Readiness::Forwardable));
        assert_eq!(plan.parents, BTreeMap::from([(id(3), id(1))]));
    }

    #[test]
    fn view_toggles_do_not_retry_a_failed_parent() {
        let mut plan = Plan::new(id(1));
        let available = set(&[1, 2]);
        plan.reconcile(&set(&[2]), &available, &available, None);
        plan.failed(id(1), id(2));
        plan.reconcile(&set(&[]), &available, &available, None);
        plan.reconcile(&set(&[2]), &available, &available, None);
        assert!(plan.parents.is_empty());
    }

    #[test]
    fn required_repair_retains_a_healthy_relays_failed_shortcut() {
        let available = set(&[1, 2, 3, 4]);
        let mut plan = Plan::new(id(1));
        let requested = set(&[2, 3]);
        plan.reconcile(&requested, &available, &available, None);
        plan.mark_ready(id(2), id(1), Readiness::Decoded);
        plan.failed(id(1), id(3));
        plan.reconcile(&requested, &available, &available, None);
        assert_eq!(plan.parents[&id(3)], id(2));
        plan.mark_ready(id(3), id(2), Readiness::Decoded);
        let requested = set(&[2, 3, 4]);
        plan.reconcile(&requested, &available, &available, None);
        while let Some(parent) = plan.parents.get(&id(4)).copied() {
            plan.failed(parent, id(4));
            plan.reconcile(&requested, &available, &available, None);
        }
        assert!(plan.needs_repair(&requested, &available));
        plan.retry_required(&requested, &available);
        plan.reconcile(&requested, &available, &available, None);
        assert_eq!(plan.parents[&id(4)], id(1));
        assert_eq!(plan.parents[&id(3)], id(2));
        assert!(!plan.can_shortcut(id(3)));
        assert!(!plan.needs_repair(&requested, &available));
    }

    #[test]
    fn unrelated_failure_memory_does_not_cancel_pending_base_admission() {
        let available = set(&[1, 2, 3, 4, 5]);
        let mut base = BaseTree::new(id(1));
        base.reconcile(&set(&[2, 3]), &available, &available);
        base.state(id(1), id(2), true);
        base.state(id(2), id(1), true);
        // A different source's physical trial failed between these members.
        base.failed(id(2), id(3));
        base.reconcile(&set(&[3, 4, 5]), &available, &available);
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
        plan.reconcile(&set(&[2]), &available, &available, None);
        plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        plan.reconcile(&set(&[]), &available, &available, None);
        plan.reconcile(&set(&[2]), &available, &available, None);
        assert_eq!(plan.parents[&id(2)], id(1));

        plan.mark_ready(id(2), id(1), Readiness::Forwardable);
        plan.reconcile(&set(&[2, 3, 4]), &available, &available, None);
        assert_eq!(plan.parents[&id(4)], id(2));
        plan.failed(id(1), id(2));
        assert!(plan.failed_parents[&id(2)].contains(&id(1)));
        assert!(plan
            .failed_parents
            .get(&id(4))
            .is_none_or(BTreeSet::is_empty));
        plan.mark_ready(id(3), id(1), Readiness::Forwardable);
        plan.reconcile(&set(&[2, 3, 4]), &available, &available, None);
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
            plan.reconcile(&requested, &available, &available, None);
            for (child, parent) in plan.parents.clone() {
                plan.mark_ready(child, parent, Readiness::Forwardable);
            }
        }
        for _ in 0..4 {
            let parent = plan.parents[&id(9)];
            plan.failed(parent, id(9));
            plan.reconcile(&requested, &available, &available, None);
        }
        // Keep failing actual assigned candidates until the existing live pool
        // has no free untried parent; a new endpoint must still get a chance.
        while let Some(parent) = plan.parents.get(&id(9)).copied() {
            plan.failed(parent, id(9));
            plan.reconcile(&requested, &available, &available, None);
        }
        available.insert(id(10));
        requested.insert(id(10));
        plan.reconcile(&requested, &available, &available, None);
        let parent = plan.parents[&id(10)];
        plan.mark_ready(id(10), parent, Readiness::Forwardable);
        plan.reconcile(&requested, &available, &available, None);
        assert_eq!(plan.parents[&id(9)], id(10));
        // Session retirement removes its old candidate failure fact. Mere
        // demand toggles retain it, as the existing regression above checks.
        available.remove(&id(4));
        plan.reconcile(&requested, &available, &available, None);
        assert!(!plan.failed_parents[&id(9)].contains(&id(4)));
    }
    #[test]
    fn base_suffix_installs_transit_without_borrowing_its_media_proof() {
        let available = set(&[1, 2, 3, 4]);
        let mut base = BaseTree::new(id(1));
        base.reconcile(&set(&[2, 3, 4]), &available, &available);
        for peer in [id(2), id(3)] {
            base.state(id(1), peer, true);
            base.state(peer, id(1), true);
        }
        base.reconcile(&set(&[2, 3, 4]), &available, &available);
        base.state(id(2), id(4), true);
        base.state(id(4), id(2), true);
        let mut screen = Plan::new(id(3));
        screen.reconcile(&set(&[4]), &available, &available, Some(&base));
        assert_eq!(
            screen.parents,
            BTreeMap::from([(id(1), id(3)), (id(2), id(1)), (id(4), id(2))])
        );
        // Failure can belong to detached transit rather than the subscriber.
        screen.failed(id(3), id(1));
        screen.reconcile(&set(&[4]), &available, &available, Some(&base));
        assert_eq!(screen.parents[&id(4)], id(3));
        screen.failed(id(3), id(4));
        screen.reconcile(&set(&[4]), &available, &available, Some(&base));
        assert!(screen.parents.is_empty());
        screen.retry_required(&set(&[4]), &available);
        screen.reconcile(&set(&[4]), &available, &available, Some(&base));
        assert_eq!(
            screen.parents,
            BTreeMap::from([(id(1), id(3)), (id(2), id(1)), (id(4), id(2))])
        );
        assert_eq!(
            screen.ready_edges().count(),
            0,
            "control readiness cannot prove picture delivery"
        );
        screen.reconcile(&set(&[2, 4]), &available, &available, Some(&base));
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
        screen.reconcile(&set(&[4]), &available, &available, Some(&base));
        assert_eq!(
            screen.parents,
            BTreeMap::from([(id(4), id(3))]),
            "failed base picture preparation uses the same availability fallback"
        );
    }
}
