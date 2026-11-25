//! Placement facts of one observed tree, the stage 1 rule and the stage 2
//! question, all in participant indices. Pure arithmetic on observations.

use super::solver::Graph;
use std::collections::{BTreeMap, BTreeSet};

/// One instant: the source, the viewers who want the screen now, the room's
/// confirmed pairs, the forwarding limit of every node and the selected tree.
#[derive(Clone)]
pub struct Instant {
    pub source: usize,
    pub viewers: BTreeSet<usize>,
    pub confirmed: BTreeSet<(usize, usize)>,
    pub limit: u32,
    pub parent: BTreeMap<usize, usize>,
}

pub fn pair(a: usize, b: usize) -> (usize, usize) {
    (a.min(b), a.max(b))
}

impl Instant {
    pub fn linked(&self, a: usize, b: usize) -> bool {
        self.confirmed.contains(&pair(a, b))
    }

    /// Depth of every node with a parent chain to the source (source = 0).
    pub fn depths(&self) -> BTreeMap<usize, u32> {
        let mut depth = BTreeMap::from([(self.source, 0)]);
        for &start in self.parent.keys() {
            let mut chain = Vec::new();
            let mut node = start;
            let found = loop {
                if let Some(&d) = depth.get(&node) {
                    break Some(d);
                }
                if chain.contains(&node) || chain.len() > self.parent.len() {
                    break None;
                }
                chain.push(node);
                match self.parent.get(&node) {
                    Some(&up) => node = up,
                    None => break None,
                }
            };
            if let Some(mut d) = found {
                for &n in chain.iter().rev() {
                    d += 1;
                    depth.insert(n, d);
                }
            }
        }
        depth
    }

    pub fn children(&self) -> BTreeMap<usize, u32> {
        let mut count = BTreeMap::new();
        for &up in self.parent.values() {
            *count.entry(up).or_insert(0) += 1;
        }
        count
    }

    /// Viewers placed under the source, and the depth sum and maximum over them.
    pub fn placement(&self) -> (u32, u32, u32) {
        let depth = self.depths();
        let mut placed = 0;
        let mut total = 0;
        let mut max = 0;
        for v in &self.viewers {
            if let Some(&d) = depth.get(v) {
                placed += 1;
                total += d;
                max = max.max(d);
            }
        }
        (placed, total, max)
    }

    fn subtree(&self, root: usize) -> BTreeSet<usize> {
        let mut nodes = BTreeSet::from([root]);
        let mut grew = true;
        while grew {
            grew = false;
            for (&child, up) in &self.parent {
                if nodes.contains(up) && nodes.insert(child) {
                    grew = true;
                }
            }
        }
        nodes
    }

    /// Nodes that can adopt: the source and every viewer placed under it.
    fn tree_nodes(&self, depth: &BTreeMap<usize, u32>) -> Vec<usize> {
        depth.keys().copied().collect()
    }

    /// Stage 1 rule. A leaf `v` (a placed viewer with no children) has a
    /// strictly better place `q` when: `q` is the source or a placed viewer
    /// other than `v`'s parent; `{q, v}` is a confirmed pair; `q` forwards to
    /// fewer than its limit, so nobody else is displaced; and `depth(q) + 1 <
    /// depth(v)`. One step moves the leaf with the largest depth gain; ties go
    /// to the deeper leaf, then the lower index, then the lower-index parent.
    pub fn stage1_move(&self) -> Option<(usize, usize, usize, u32)> {
        self.better_place(false)
    }

    fn better_place(&self, branches: bool) -> Option<(usize, usize, usize, u32)> {
        let depth = self.depths();
        let children = self.children();
        let mut best: Option<(u32, u32, std::cmp::Reverse<usize>, std::cmp::Reverse<usize>)> = None;
        let mut chosen = None;
        for (&v, &up) in &self.parent {
            if !self.viewers.contains(&v) || (!branches && children.contains_key(&v)) {
                continue;
            }
            let Some(&dv) = depth.get(&v) else { continue };
            let below = if branches {
                self.subtree(v)
            } else {
                BTreeSet::from([v])
            };
            for q in self.tree_nodes(&depth) {
                if below.contains(&q) || q == up || !self.linked(q, v) {
                    continue;
                }
                if children.get(&q).copied().unwrap_or(0) >= self.limit {
                    continue;
                }
                let dq = depth[&q];
                if dq + 1 >= dv {
                    continue;
                }
                let gain = (dv - dq - 1) * below.len() as u32;
                let key = (gain, dv, std::cmp::Reverse(v), std::cmp::Reverse(q));
                if best.is_none_or(|b| key > b) {
                    best = Some(key);
                    chosen = Some((v, up, q, gain));
                }
            }
        }
        chosen
    }

    /// Applies the rule one move at a time until no leaf has a better place.
    /// Every move lowers the depth sum by at least one, so this ends.
    pub fn stage1_fixpoint(&self) -> (Instant, Vec<(usize, usize, usize)>) {
        self.fixpoint(false)
    }

    /// For comparison only, not stage 1: the same rule when the moved node may
    /// carry its whole subtree, choosing by the depth sum a move removes.
    pub fn branch_fixpoint(&self) -> (Instant, Vec<(usize, usize, usize)>) {
        self.fixpoint(true)
    }

    fn fixpoint(&self, branches: bool) -> (Instant, Vec<(usize, usize, usize)>) {
        let mut tree = self.clone();
        let mut moves = Vec::new();
        while let Some((v, from, to, _)) = tree.better_place(branches) {
            tree.parent.insert(v, to);
            moves.push((v, from, to));
        }
        (tree, moves)
    }

    /// For comparison only, not stage 1 as written: the same rule when the
    /// best move's pair is not confirmed yet and may be attempted once. An
    /// attempt succeeds exactly when `connectable` says so; a failed pair is
    /// not tried again. Each step either moves a leaf or retires a pair, so it
    /// ends. Returns the tree, the moves and every attempt with its outcome.
    pub fn stage1_with_attempts(
        &self,
        connectable: &dyn Fn(usize, usize) -> bool,
    ) -> (
        Instant,
        Vec<(usize, usize, usize)>,
        Vec<((usize, usize), bool)>,
    ) {
        let mut tree = self.clone();
        let mut failed = BTreeSet::new();
        let mut moves = Vec::new();
        let mut attempts = Vec::new();
        let nodes: Vec<usize> = std::iter::once(self.source)
            .chain(self.viewers.iter().copied())
            .collect();
        loop {
            let mut view = tree.clone();
            for &a in &nodes {
                for &b in &self.viewers {
                    let key = pair(a, b);
                    if a != b && !failed.contains(&key) {
                        view.confirmed.insert(key);
                    }
                }
            }
            let Some((v, from, to, _)) = view.stage1_move() else {
                break;
            };
            let key = pair(v, to);
            if !tree.confirmed.contains(&key) {
                let ok = connectable(v, to);
                attempts.push((key, ok));
                if !ok {
                    failed.insert(key);
                    continue;
                }
                tree.confirmed.insert(key);
            }
            tree.parent.insert(v, to);
            moves.push((v, from, to));
        }
        (tree, moves, attempts)
    }

    /// Unplaced viewers, split by what the tree offered them: a parent with a
    /// free slot and a confirmed pair (a missed placement), only parents at
    /// their limit, or no confirmed pair into the tree at all.
    pub fn unplaced(&self) -> (u32, u32, u32) {
        let depth = self.depths();
        let children = self.children();
        let (mut free, mut full, mut none) = (0, 0, 0);
        for &v in &self.viewers {
            if depth.contains_key(&v) {
                continue;
            }
            let parents: Vec<_> = self
                .tree_nodes(&depth)
                .into_iter()
                .filter(|&q| self.linked(q, v))
                .collect();
            if parents
                .iter()
                .any(|q| children.get(q).copied().unwrap_or(0) < self.limit)
            {
                free += 1;
            } else if !parents.is_empty() {
                full += 1;
            } else {
                none += 1;
            }
        }
        (free, full, none)
    }

    /// Stage 2 question. For each viewer, the best depth a free slot offers and
    /// the best depth one more child at a parent at its limit would offer. A
    /// situation is counted when the latter is strictly better than both the
    /// former and the viewer's present place. Returns (viewer, parent at its
    /// limit, depth gain or None when the viewer was unplaced).
    pub fn unmet_demand(&self) -> Vec<(usize, usize, Option<u32>)> {
        let depth = self.depths();
        let children = self.children();
        let mut found = Vec::new();
        for &v in &self.viewers {
            let current = depth.get(&v).copied();
            let up = self.parent.get(&v).copied();
            let below = if current.is_some() {
                self.subtree(v)
            } else {
                BTreeSet::from([v])
            };
            let mut best_free = u32::MAX;
            let mut best_full: Option<(u32, usize)> = None;
            for q in self.tree_nodes(&depth) {
                if below.contains(&q) || Some(q) == up || !self.linked(q, v) {
                    continue;
                }
                let place = depth[&q] + 1;
                if children.get(&q).copied().unwrap_or(0) < self.limit {
                    best_free = best_free.min(place);
                } else if best_full.is_none_or(|(d, p)| (place, q) < (d, p)) {
                    best_full = Some((place, q));
                }
            }
            let Some((place, q)) = best_full else {
                continue;
            };
            if place >= best_free {
                continue;
            }
            match current {
                None => found.push((v, q, None)),
                Some(d) if place < d => found.push((v, q, Some(d - place))),
                _ => {}
            }
        }
        found
    }

    /// The solver's graph on the source and present viewers, with the given pairs.
    pub fn graph(&self, pairs: &dyn Fn(usize, usize) -> bool) -> Graph {
        let nodes: Vec<usize> = std::iter::once(self.source)
            .chain(self.viewers.iter().copied())
            .collect();
        let mut adjacency = vec![0u64; nodes.len()];
        for (i, &a) in nodes.iter().enumerate() {
            for (j, &b) in nodes.iter().enumerate() {
                if i != j && pairs(a, b) {
                    adjacency[i] |= 1 << j;
                }
            }
        }
        Graph {
            adjacency,
            limit: vec![self.limit; nodes.len()],
        }
    }
}
