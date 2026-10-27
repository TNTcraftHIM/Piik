use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const FANOUT: usize = 2;
const ATTEMPTS: usize = 4;

/// One source owns one acyclic tree. Shared physical transport ownership lives
/// above these plans: a source retiring must not close another source's pair.
pub struct Plan {
    pub source: Uuid,
    pub parents: BTreeMap<Uuid, Uuid>,
    ready: BTreeSet<Uuid>,
    attempted: BTreeMap<Uuid, BTreeSet<Uuid>>,
}

impl Plan {
    pub fn new(source: Uuid) -> Self {
        Self {
            source,
            parents: BTreeMap::new(),
            ready: BTreeSet::new(),
            attempted: BTreeMap::new(),
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
                (!requested.contains(child)
                    || !available.contains(child)
                    || !available.contains(parent))
                .then_some(*child)
            })
            .collect();
        for child in remove {
            self.detach(child);
        }
        self.attempted.retain(|child, _| requested.contains(child));
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
            let tried = self.attempted.entry(*child).or_default();
            if tried.len() >= ATTEMPTS {
                continue;
            }
            let candidates = std::iter::once(self.source).chain(self.ready.iter().copied());
            let parent = candidates
                .filter(|parent| {
                    parent != child && connected.contains(parent) && !tried.contains(parent)
                })
                .find(|parent| {
                    self.parents
                        .values()
                        .filter(|existing| *existing == parent)
                        .count()
                        < FANOUT
                });
            if let Some(parent) = parent {
                tried.insert(parent);
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
    fn unsubscribing_a_relay_cannot_leave_an_orphan_or_create_a_cycle() {
        let mut plan = Plan::new(id(1));
        let available = set(&[1, 2, 3, 4]);
        plan.reconcile(&set(&[2, 3, 4]), &available, &available);
        plan.mark_ready(id(2), id(1));
        plan.reconcile(&set(&[2, 3, 4]), &available, &available);
        plan.reconcile(&set(&[3, 4]), &available, &available);
        assert!(!plan.parents.contains_key(&id(2)));
        assert!(!plan.parents.values().any(|parent| *parent == id(2)));
        assert!(!plan.mark_ready(id(2), id(1)));
    }
}
