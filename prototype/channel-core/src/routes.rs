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
        self.failed_parents.retain(|child, parents| {
            parents.retain(|parent| available.contains(parent));
            available.contains(child)
        });
        if !connected.contains(&self.source) {
            return;
        }
        let base_parents: BTreeMap<_, _> = base
            .into_iter()
            .flat_map(|base| base.project(self.source, requested))
            .map(|(parent, child)| (child, parent))
            .collect();
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
            let failed = self.failed_parents.entry(*child).or_default();
            let candidates = std::iter::once(self.source).chain(self.ready.keys().copied());
            let parent = candidates
                .filter(|parent| {
                    parent != child && connected.contains(parent) && !failed.contains(parent)
                })
                .find(|parent| {
                    self.parents
                        .values()
                        .filter(|existing| *existing == parent)
                        .count()
                        < FANOUT
                });
            if let Some(parent) = parent {
                self.parents.insert(*child, parent);
            }
        }
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
        let mut suffix = Vec::new();
        let mut child = receiver;
        while child != self.source && !self.parents.contains_key(&child) {
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
        self.plan.failed(first, second);
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
        assert!(plan.failed_parents[&id(4)].is_empty());
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
