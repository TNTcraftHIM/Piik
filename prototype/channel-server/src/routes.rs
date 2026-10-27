use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const FANOUT: usize = 2;
const FAILED_PARENTS: usize = 4;

/// One source owns one acyclic tree. Shared physical transport ownership lives
/// above these plans: a source retiring must not close another source's pair.
#[derive(Clone)]
pub struct Plan {
    pub source: Uuid,
    pub parents: BTreeMap<Uuid, Uuid>,
    ready: BTreeSet<Uuid>,
    failed_parents: BTreeMap<Uuid, BTreeSet<Uuid>>,
}

impl Plan {
    pub fn new(source: Uuid) -> Self {
        Self {
            source,
            parents: BTreeMap::new(),
            ready: BTreeSet::new(),
            failed_parents: BTreeMap::new(),
        }
    }

    pub fn reconcile(
        &mut self,
        requested: &BTreeSet<Uuid>,
        available: &BTreeSet<Uuid>,
        connected: &BTreeSet<Uuid>,
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
        self.ready.retain(|child| self.parents.contains_key(child));
        self.failed_parents
            .retain(|child, _| available.contains(child));
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
            let failed = self.failed_parents.entry(*child).or_default();
            if failed.len() >= FAILED_PARENTS {
                continue;
            }
            let candidates = std::iter::once(self.source).chain(self.ready.iter().copied());
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

    pub fn mark_ready(&mut self, child: Uuid, parent: Uuid) -> bool {
        if self.parents.get(&child) != Some(&parent) {
            return false;
        }
        self.ready.insert(child)
    }

    pub fn ready_edges(&self) -> impl Iterator<Item = (Uuid, Uuid)> + '_ {
        self.parents
            .iter()
            .filter_map(|(child, parent)| self.ready.contains(child).then_some((*parent, *child)))
    }

    pub fn mark_unready(&mut self, child: Uuid, parent: Uuid) -> bool {
        if self.parents.get(&child) != Some(&parent) || !self.ready.remove(&child) {
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
        self.plan.reconcile(demand, available, connected);
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
            self.plan.mark_ready(child, parent);
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
        plan.reconcile(&requested, &available, &available);
        assert_eq!(plan.parents.len(), 2);
        assert!(plan.mark_ready(id(2), id(1)));
        plan.reconcile(&requested, &available, &available);
        assert_eq!(plan.parents[&id(4)], id(2));
        assert_eq!(plan.parents[&id(5)], id(2));
        plan.reconcile(&requested, &available, &available);
        assert_eq!(plan.parents[&id(3)], id(1));
        assert_eq!(plan.parents[&id(4)], id(2));
    }

    #[test]
    fn relay_failure_retires_descendants_only_and_does_not_mutate_another_source() {
        let mut first = Plan::new(id(1));
        let mut second = Plan::new(id(2));
        let requested = set(&[2, 3, 4, 5]);
        let available = set(&[1, 2, 3, 4, 5]);
        first.reconcile(&requested, &available, &available);
        first.mark_ready(id(2), id(1));
        first.reconcile(&requested, &available, &available);
        second.reconcile(&set(&[1, 3]), &available, &available);
        let second_before = second.parents.clone();
        first.failed(id(1), id(2));
        assert_eq!(first.parents, BTreeMap::from([(id(3), id(1))]));
        first.mark_ready(id(3), id(1));
        first.reconcile(&requested, &available, &available);
        assert_eq!(first.parents[&id(3)], id(1));
        assert_ne!(first.parents.get(&id(2)), Some(&id(1)));
        assert_eq!(second.parents, second_before);
    }

    #[test]
    fn unwatch_keeps_required_transit_until_its_last_downstream_leaves() {
        let mut plan = Plan::new(id(1));
        let available = set(&[1, 2, 3, 4]);
        plan.reconcile(&set(&[2, 3, 4]), &available, &available);
        plan.mark_ready(id(2), id(1));
        plan.reconcile(&set(&[2, 3, 4]), &available, &available);
        let before = plan.parents.clone();
        plan.reconcile(&set(&[3, 4]), &available, &available);
        assert_eq!(plan.parents, before);
        assert!(
            !plan.mark_ready(id(2), id(1)),
            "existing transit proof is retained"
        );
        plan.reconcile(&set(&[3]), &available, &available);
        assert!(!plan.parents.contains_key(&id(2)));
        assert!(!plan.parents.values().any(|parent| *parent == id(2)));
        assert!(!plan.mark_ready(id(2), id(1)));
        assert_eq!(plan.parents, BTreeMap::from([(id(3), id(1))]));
    }

    #[test]
    fn view_toggles_do_not_retry_a_failed_parent() {
        let mut plan = Plan::new(id(1));
        let available = set(&[1, 2]);
        plan.reconcile(&set(&[2]), &available, &available);
        plan.failed(id(1), id(2));
        plan.reconcile(&set(&[]), &available, &available);
        plan.reconcile(&set(&[2]), &available, &available);
        assert!(plan.parents.is_empty());
    }

    #[test]
    fn healthy_unwatch_rewatch_and_ancestor_loss_do_not_mark_a_leg_failed() {
        let mut plan = Plan::new(id(1));
        let available = set(&[1, 2, 3, 4]);
        plan.reconcile(&set(&[2]), &available, &available);
        plan.mark_ready(id(2), id(1));
        plan.reconcile(&set(&[]), &available, &available);
        plan.reconcile(&set(&[2]), &available, &available);
        assert_eq!(plan.parents[&id(2)], id(1));

        plan.mark_ready(id(2), id(1));
        plan.reconcile(&set(&[2, 3, 4]), &available, &available);
        assert_eq!(plan.parents[&id(4)], id(2));
        plan.failed(id(1), id(2));
        assert!(plan.failed_parents[&id(2)].contains(&id(1)));
        assert!(plan.failed_parents[&id(4)].is_empty());
        plan.mark_ready(id(3), id(1));
        plan.reconcile(&set(&[2, 3, 4]), &available, &available);
        assert_eq!(plan.parents[&id(2)], id(3));
        assert!(plan.parents.contains_key(&id(4)));
    }
}
