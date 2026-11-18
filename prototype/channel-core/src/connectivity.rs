use std::collections::BTreeSet;
use uuid::Uuid;

/// Select one missing link that restores a demanded path or protects one
/// against the departure of an intermediate endpoint.
pub(crate) fn candidate(
    sessions: &BTreeSet<Uuid>,
    confirmed: &BTreeSet<(Uuid, Uuid)>,
    demand: &BTreeSet<(Uuid, Uuid)>,
    available: impl Fn(Uuid, Uuid) -> bool,
) -> Option<(Uuid, Uuid)> {
    if sessions.len() < 2 || demand.is_empty() {
        return None;
    }
    let peers: Vec<_> = sessions.iter().copied().collect();
    let indices = |&(a, b): &(Uuid, Uuid)| {
        Some((peers.binary_search(&a).ok()?, peers.binary_search(&b).ok()?))
    };
    let demands: Vec<_> = demand.iter().filter_map(indices).collect();
    let mut neighbors = vec![Vec::new(); peers.len()];
    for (a, b) in confirmed.iter().filter_map(indices) {
        neighbors[a].push(b);
        neighbors[b].push(a);
    }
    let mut graph = Cuts::new(peers.len());
    for root in 0..peers.len() {
        if graph.discovery[root] == 0 {
            graph.visit(&neighbors, root, None, root);
        }
    }
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
    best.map(|(_, pair)| pair)
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
}

impl Cuts {
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
        let mut low = self.discovery[at];
        for &next in &neighbors[at] {
            if self.discovery[next] == 0 {
                let start = self.order.len();
                let child_low = self.visit(neighbors, next, Some(at), root);
                low = low.min(child_low);
                if child_low >= self.discovery[at] {
                    self.branches[at].push(start..self.order.len());
                }
            } else if Some(next) != parent {
                low = low.min(self.discovery[next]);
            }
        }
        low
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
