use std::collections::BTreeSet;
use uuid::Uuid;

/// Keep a sparse subset of real links and propose ring neighbors across actual gaps.
/// A failed ring neighbor unlocks one further neighbor in that direction.
pub(crate) fn standby(
    sessions: &BTreeSet<Uuid>,
    confirmed: &BTreeSet<(Uuid, Uuid)>,
    rejected: impl Fn((Uuid, Uuid)) -> bool,
) -> BTreeSet<(Uuid, Uuid)> {
    let peers: Vec<_> = sessions.iter().copied().collect();
    let mut pairs = BTreeSet::new();
    if peers.len() < 2 {
        return pairs;
    }
    let graph = Cuts::from_pairs(&peers, confirmed);
    for (i, &a) in peers.iter().enumerate() {
        let edge = |j: usize| (a.min(peers[j]), a.max(peers[j]));
        // Tree edges preserve components. Back edges witnessing the DFS
        // low links preserve alternate paths around intermediate vertices.
        pairs.extend(graph.parent[i].map(edge));
        pairs.extend(graph.back[i].map(edge));
        let n = peers.len();
        for step in [1, n - 1] {
            let next = (i + step) % n;
            let primary = edge(next);
            let mut target = next;
            if rejected(primary) {
                pairs.insert(primary); // Fence the failure while its endpoints remain neighbors.
                target = (next + step) % n;
            }
            if target != i {
                let pair = edge(target);
                if rejected(pair)
                    || graph.component[i] != graph.component[target]
                    || graph.separating_cuts(i, target) > 0
                {
                    pairs.insert(pair);
                }
            }
        }
    }
    pairs
}

/// Select one missing link that restores a demanded path or protects one
/// against the departure of an intermediate endpoint.
pub(crate) fn candidate(
    sessions: &BTreeSet<Uuid>,
    confirmed: &BTreeSet<(Uuid, Uuid)>,
    demand: &BTreeSet<(Uuid, Uuid)>,
    available: impl Fn(Uuid, Uuid) -> bool,
) -> Option<(Uuid, Uuid)> {
    select(sessions, confirmed, demand, available, false)
}

pub(crate) fn repair_candidate(
    sessions: &BTreeSet<Uuid>,
    confirmed: &BTreeSet<(Uuid, Uuid)>,
    demand: &BTreeSet<(Uuid, Uuid)>,
    available: impl Fn(Uuid, Uuid) -> bool,
) -> Option<(Uuid, Uuid)> {
    select(sessions, confirmed, demand, available, true)
}

/// Pick a previously failed hop only for the current source/receiver gap.
/// Oldest cooldown first lets another failed frontier get a turn after a retry fails.
pub(crate) fn retry_candidate(
    sessions: &BTreeSet<Uuid>,
    confirmed: &BTreeSet<(Uuid, Uuid)>,
    direct: (Uuid, Uuid),
    failures: impl Iterator<Item = ((Uuid, Uuid), u64)>,
) -> Option<(Uuid, Uuid)> {
    let peers: Vec<_> = sessions.iter().copied().collect();
    let graph = Cuts::from_pairs(&peers, confirmed);
    let component = |id| {
        peers
            .binary_search(&id)
            .ok()
            .and_then(|i| graph.component[i])
    };
    let source = component(direct.0)?;
    let receiver = component(direct.1)?;
    failures
        .filter_map(|(pair, after)| {
            let (a, b) = (component(pair.0)?, component(pair.1)?);
            let connects_frontier = source != receiver
                && a != b
                && [a, b]
                    .iter()
                    .any(|side| *side == source || *side == receiver);
            (pair == direct || connects_frontier).then_some((after, pair != direct, pair))
        })
        .min()
        .map(|(_, _, pair)| pair)
}

fn select(
    sessions: &BTreeSet<Uuid>,
    confirmed: &BTreeSet<(Uuid, Uuid)>,
    demand: &BTreeSet<(Uuid, Uuid)>,
    available: impl Fn(Uuid, Uuid) -> bool,
    expand_frontier: bool,
) -> Option<(Uuid, Uuid)> {
    if sessions.len() < 2 || demand.is_empty() {
        return None;
    }
    let peers: Vec<_> = sessions.iter().copied().collect();
    let indices = |&(a, b): &(Uuid, Uuid)| {
        Some((peers.binary_search(&a).ok()?, peers.binary_search(&b).ok()?))
    };
    let demands: Vec<_> = demand.iter().filter_map(indices).collect();
    let graph = Cuts::from_pairs(&peers, confirmed);
    // Requested pairs outrank every alternative. Score them directly before
    // comparing bridges between all members on either side of a gap.
    let exact = demands
        .iter()
        .filter_map(|&(a, b)| {
            let edge = (peers[a.min(b)], peers[a.max(b)]);
            if !available(edge.0, edge.1) {
                return None;
            }
            let cross = graph.component[a] != graph.component[b];
            let cuts = if cross {
                0
            } else {
                graph.separating_cuts(a, b)
            };
            (cross || cuts > 0).then_some((cross, cuts, std::cmp::Reverse(edge)))
        })
        .max();
    if let Some((_, _, std::cmp::Reverse(edge))) = exact {
        return Some(edge);
    }
    let mut benefit = Vec::new();
    score_gaps(&graph.component, &demands, &mut benefit);
    for (cut, branches) in graph.branches.iter().enumerate() {
        if branches.is_empty() || (graph.component[cut] == Some(cut) && branches.len() == 1) {
            continue;
        }
        // The parent side occupies group 'cut'. Each separating DFS subtree
        // occupies one contiguous range in discovery order.
        let mut groups = vec![None; peers.len()];
        for &peer in &graph.order {
            if graph.component[peer] == graph.component[cut] && peer != cut {
                groups[peer] = Some(cut);
            }
        }
        for branch in branches {
            let members = &graph.order[branch.clone()];
            for &peer in members {
                groups[peer] = Some(members[0]);
            }
        }
        score_gaps(&groups, &demands, &mut benefit);
    }
    let mut best = None;
    for (i, row) in benefit.iter().enumerate() {
        let a = peers[i];
        for (j, &b) in peers.iter().enumerate().skip(i + 1) {
            if row[j] == 0 || !available(a, b) {
                continue;
            }
            let rank = (graph.component[i] != graph.component[j], row[j]);
            if best.is_none_or(|(prior, _)| rank > prior) {
                best = Some((rank, (a, b)));
            }
        }
    }
    best.map(|(_, pair)| pair).or_else(|| {
        if !expand_frontier {
            return None;
        }
        for &(source, viewer) in &demands {
            let left = graph.component[source];
            let right = graph.component[viewer];
            if left == right {
                continue;
            }
            for (i, &a) in peers.iter().enumerate() {
                for (j, &b) in peers.iter().enumerate().skip(i + 1) {
                    let in_frontier = |k: usize| [left, right].contains(&graph.component[k]);
                    if in_frontier(i) != in_frontier(j) && available(a, b) {
                        return Some((a, b));
                    }
                }
            }
        }
        None
    })
}

// Credit each missing pair that would reconnect the two sides of a real
// demand. A cut itself and vertices outside its component are excluded.
fn score_gaps(groups: &[Option<usize>], demands: &[(usize, usize)], benefit: &mut Vec<Vec<usize>>) {
    let gaps: BTreeSet<_> = demands
        .iter()
        .filter_map(|&(a, b)| {
            let (a, b) = (groups[a]?, groups[b]?);
            (a != b).then_some((a.min(b), a.max(b)))
        })
        .collect();
    if gaps.is_empty() {
        return;
    }
    if benefit.is_empty() {
        benefit.resize_with(groups.len(), || vec![0; groups.len()]);
    }
    let mut members = vec![Vec::new(); groups.len()];
    for (peer, group) in groups.iter().enumerate() {
        if let Some(group) = group {
            members[*group].push(peer);
        }
    }
    for (left, right) in gaps {
        for &a in &members[left] {
            for &b in &members[right] {
                benefit[a.min(b)][a.max(b)] += 1;
            }
        }
    }
}

struct Cuts {
    discovery: Vec<usize>,
    order: Vec<usize>,
    component: Vec<Option<usize>>,
    branches: Vec<Vec<std::ops::Range<usize>>>,
    parent: Vec<Option<usize>>,
    back: Vec<Option<usize>>,
}

impl Cuts {
    fn from_pairs(peers: &[Uuid], confirmed: &BTreeSet<(Uuid, Uuid)>) -> Self {
        let mut neighbors = vec![Vec::new(); peers.len()];
        for &(a, b) in confirmed {
            if let (Ok(a), Ok(b)) = (peers.binary_search(&a), peers.binary_search(&b)) {
                neighbors[a].push(b);
                neighbors[b].push(a);
            }
        }
        let mut graph = Self::new(peers.len());
        for root in 0..peers.len() {
            if graph.discovery[root] == 0 {
                graph.visit(&neighbors, root, None, root);
            }
        }
        graph
    }

    fn separating_cuts(&self, a: usize, b: usize) -> usize {
        let (left, right) = (self.discovery[a] - 1, self.discovery[b] - 1);
        self.branches
            .iter()
            .enumerate()
            .filter(|(cut, branches)| {
                *cut != a
                    && *cut != b
                    && branches
                        .iter()
                        .any(|range| range.contains(&left) != range.contains(&right))
            })
            .count()
    }

    fn new(n: usize) -> Self {
        Self {
            discovery: vec![0; n],
            order: Vec::new(),
            component: vec![None; n],
            branches: vec![Vec::new(); n],
            parent: vec![None; n],
            back: vec![None; n],
        }
    }

    // A subtree whose low link cannot reach above its parent is separated
    // from the parent side when that parent leaves.
    fn visit(
        &mut self,
        neighbors: &[Vec<usize>],
        at: usize,
        parent: Option<usize>,
        root: usize,
    ) -> usize {
        self.order.push(at);
        self.discovery[at] = self.order.len();
        self.component[at] = Some(root);
        self.parent[at] = parent;
        let mut low = self.discovery[at];
        let mut child_lowest = low;
        for &next in &neighbors[at] {
            if self.discovery[next] == 0 {
                let start = self.order.len();
                let child_low = self.visit(neighbors, next, Some(at), root);
                child_lowest = child_lowest.min(child_low);
                low = low.min(child_low);
                if child_low >= self.discovery[at] {
                    self.branches[at].push(start..self.order.len());
                }
            } else if Some(next) != parent {
                if self.discovery[next] < self.discovery[self.back[at].unwrap_or(at)] {
                    self.back[at] = Some(next);
                }
                low = low.min(self.discovery[next]);
            }
        }
        if low >= child_lowest {
            self.back[at] = None;
        }
        low
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_retry_uses_a_failed_frontier_or_the_undelivered_direct_pair() {
        let id = Uuid::from_u128;
        let peers = (1..=6).map(id).collect();
        let direct = (id(1), id(3));
        let mut links = [(id(1), id(2))].into();
        let failures = [
            ((id(2), id(7)), 0), // Outside the room.
            ((id(5), id(6)), 1), // Unrelated to either frontier.
            ((id(2), id(3)), 3),
            (direct, 10),
        ];
        assert_eq!(
            retry_candidate(&peers, &links, direct, failures.into_iter()),
            Some((id(2), id(3)))
        );
        links.insert((id(2), id(3)));
        assert_eq!(
            retry_candidate(&peers, &links, direct, failures.into_iter()),
            Some(direct)
        );
    }

    #[test]
    fn idle_neighbors_form_a_sparse_cycle_and_reuse_confirmed_bridges() {
        let id = Uuid::from_u128;
        let peers = (1..=6).map(id).collect();
        let standby = |peers: &BTreeSet<Uuid>, graph: &BTreeSet<(Uuid, Uuid)>| {
            super::standby(peers, graph, |_| false)
        };
        let ring: BTreeSet<_> = [(1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (1, 6)]
            .map(|(a, b)| (id(a), id(b)))
            .into();
        assert_eq!(standby(&peers, &BTreeSet::new()), ring);
        assert_eq!(standby(&peers, &ring), ring);

        let triangles: BTreeSet<_> = [(1, 2), (2, 3), (1, 3), (4, 5), (5, 6), (4, 6), (2, 5)]
            .map(|(a, b)| (id(a), id(b)))
            .into();
        let mut linked = triangles.clone();
        let edge = *standby(&peers, &linked).difference(&linked).next().unwrap();
        assert_ne!(edge.0, id(2));
        assert_ne!(edge.1, id(5));
        linked.insert(edge);
        assert!(standby(&peers, &linked).is_subset(&linked));

        let mesh = (1..=6)
            .flat_map(|a| ((a + 1)..=6).map(move |b| (id(a), id(b))))
            .collect();
        let retained = standby(&peers, &mesh);
        assert_eq!(retained.len(), peers.len());
        assert_eq!(standby(&peers, &retained), retained);
    }

    #[test]
    fn failed_neighbors_offer_a_bounded_second_choice_for_the_gap() {
        let id = Uuid::from_u128;
        let peers = (0..40).map(id).collect();
        let chain = (1..39).map(|n| (id(n), id(n + 1))).collect();
        let failed: BTreeSet<_> = [(id(0), id(1)), (id(0), id(39))].into();
        let options = standby(&peers, &chain, |pair| failed.contains(&pair));
        assert!(options.contains(&(id(0), id(2))));
        assert!(options.contains(&(id(0), id(38))));
        assert!(failed.is_subset(&options));
        assert_eq!(standby(&peers, &BTreeSet::new(), |_| true).len(), 80);
    }

    #[test]
    fn a_leaf_off_a_resilient_demand_path_needs_no_trial() {
        let id = Uuid::from_u128;
        let peers = (1..=5).map(id).collect();
        let confirmed = [(1, 2), (2, 3), (3, 4), (1, 4), (2, 5)]
            .map(|(a, b)| (id(a), id(b)))
            .into();
        let demand = [(id(1), id(3))].into();
        assert!(candidate(&peers, &confirmed, &demand, |_, _| true).is_none());
        assert!(candidate(&peers, &confirmed, &BTreeSet::new(), |_, _| true).is_none());
    }

    #[test]
    fn a_failed_direct_trial_prefers_another_pair_in_the_same_demanded_gap() {
        let id = Uuid::from_u128;
        let peers = (1..=5).map(id).collect();
        // 1 is idle. 6 is outside the room and cannot close the gap.
        let confirmed = [(2, 3), (4, 5), (2, 6), (4, 6)]
            .map(|(a, b)| (id(a), id(b)))
            .into();
        let demand = [(id(3), id(4))].into();
        let pair = candidate(&peers, &confirmed, &demand, |a, b| (a, b) != (id(3), id(4))).unwrap();
        assert!([id(2), id(3)].contains(&pair.0));
        assert!([id(4), id(5)].contains(&pair.1));
    }

    #[test]
    fn two_triangles_need_independent_bridges_and_a_failed_pair_has_an_alternative() {
        let id = Uuid::from_u128;
        let peers = (1..=6).map(id).collect();
        let mut confirmed = [(1, 2), (2, 3), (1, 3), (4, 5), (5, 6), (4, 6)]
            .map(|(a, b)| (id(a), id(b)))
            .into();
        let demand = [(id(4), id(1))].into();
        let bridge = candidate(&peers, &confirmed, &demand, |_, _| true).unwrap();
        assert_eq!(bridge, (id(1), id(4)));
        let alternate = candidate(&peers, &confirmed, &demand, |a, b| (a, b) != bridge).unwrap();
        assert!(alternate.0 <= id(3) && alternate.1 >= id(4));
        confirmed.insert(bridge);
        assert!(candidate(&peers, &confirmed, &demand, |_, _| true).is_none());
        let demand = [(id(2), id(5))].into();
        let second = candidate(&peers, &confirmed, &demand, |_, _| true).unwrap();
        assert!(second.0 != bridge.0 && second.1 != bridge.1);
        confirmed.insert(second);
        assert!(candidate(&peers, &confirmed, &demand, |_, _| true).is_none());
    }
}
