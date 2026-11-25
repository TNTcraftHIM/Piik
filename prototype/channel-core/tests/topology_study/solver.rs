//! The best delivery tree attainable on given confirmed pairs under given
//! forwarding limits, by exhaustive branch and bound, with bounds when the
//! search budget runs out.
//!
//! Objective, from the forwarding plan's lexicographic tuple specialised to a
//! room in which every non-source member watches (so tree edges equal covered
//! viewers): first the most viewers placed, then the smallest total depth.
//! The smallest maximum depth among trees with the most viewers placed is
//! solved separately; it can belong to a different tree.
//!
//! Search space. A rooted tree splits into depth levels, and each level is
//! assigned to parents on the level above by a capacity-respecting matching.
//! If a node could join a level and is left for later, moving it (with its
//! whole subtree) up to that level keeps every limit and lowers depth, so only
//! maximal matchable levels need trying. Maximal matchable sets of a
//! transversal matroid all have the size of a maximum matching.

pub struct Graph {
    /// Node 0 is the source.
    pub adjacency: Vec<u64>,
    pub limit: Vec<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Value {
    pub cover: u32,
    pub total: u32,
}

impl Value {
    fn better(self, other: Value) -> bool {
        self.cover > other.cover || (self.cover == other.cover && self.total < other.total)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Attainable {
    /// Exact optimum when `exact`; otherwise the best tree found.
    pub cover: u32,
    pub total: u32,
    pub max_depth: u32,
    pub exact: bool,
    /// Valid whether or not the search finished. `total_lower` and
    /// `max_lower` hold for any tree placing at least `cover` viewers.
    pub cover_upper: u32,
    pub total_lower: u32,
    pub max_lower: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Total,
    /// Most viewers with every depth at most `cap`.
    Capped {
        cap: u32,
        target: u32,
    },
}

struct Search<'a> {
    graph: &'a Graph,
    mode: Mode,
    best: Value,
    /// Deepest level of the tree that gave `best`.
    best_max: u32,
    nodes: u64,
    budget: u64,
    aborted: bool,
}

fn bits(mask: u64) -> impl Iterator<Item = usize> {
    let mut rest = mask;
    std::iter::from_fn(move || {
        (rest != 0).then(|| {
            let bit = rest.trailing_zeros() as usize;
            rest &= rest - 1;
            bit
        })
    })
}

impl Graph {
    fn all(&self) -> u64 {
        if self.adjacency.len() == 64 {
            u64::MAX
        } else {
            (1u64 << self.adjacency.len()) - 1
        }
    }

    fn neighbors(&self, set: u64) -> u64 {
        bits(set).fold(0, |acc, node| acc | self.adjacency[node])
    }

    /// Whether every node of `chosen` can take a slot of a `frontier` parent
    /// it is linked to, each parent offering its limit in slots.
    fn matchable(&self, chosen: u64, frontier: u64) -> bool {
        let slots: Vec<usize> = bits(frontier)
            .flat_map(|parent| std::iter::repeat(parent).take(self.limit[parent] as usize))
            .collect();
        let mut owner: Vec<Option<usize>> = vec![None; slots.len()];
        for child in bits(chosen) {
            let mut seen = vec![false; slots.len()];
            if !self.augment(child, &slots, &mut owner, &mut seen) {
                return false;
            }
        }
        true
    }

    fn augment(
        &self,
        child: usize,
        slots: &[usize],
        owner: &mut [Option<usize>],
        seen: &mut [bool],
    ) -> bool {
        for slot in 0..slots.len() {
            if seen[slot] || self.adjacency[slots[slot]] & (1 << child) == 0 {
                continue;
            }
            seen[slot] = true;
            match owner[slot] {
                None => {
                    owner[slot] = Some(child);
                    return true;
                }
                Some(other) => {
                    if self.augment(other, slots, owner, seen) {
                        owner[slot] = Some(child);
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Largest number of `candidates` the `frontier` can adopt at once.
    fn max_matching(&self, candidates: u64, frontier: u64) -> u32 {
        let slots: Vec<usize> = bits(frontier)
            .flat_map(|parent| std::iter::repeat(parent).take(self.limit[parent] as usize))
            .collect();
        let mut owner: Vec<Option<usize>> = vec![None; slots.len()];
        let mut size = 0;
        for child in bits(candidates) {
            let mut seen = vec![false; slots.len()];
            if self.augment(child, &slots, &mut owner, &mut seen) {
                size += 1;
            }
        }
        size
    }

    /// Relaxation for pruning. Below `frontier`, a node at level `j` is within
    /// distance `j` of the frontier, so level `j` holds at most `w_j =
    /// min(slots_j, e_j)` nodes, where `e_j` counts unplaced nodes within
    /// distance `j` and `slots_j = max limit * w_(j-1)` (the frontier's own
    /// limits for `j = 1`). Every tree from this state therefore has at most
    /// `C_j = min(C_(j-1) + w_j, e_j)` nodes in its first `j` levels. Returns
    /// the increments of `C`, which bound coverage within any depth, the depth
    /// sum of covering every reachable node and the depth that needs.
    fn level_bound(&self, placed: u64, frontier: u64) -> Vec<u32> {
        let free = self.all() & !placed;
        let mut within = Vec::new();
        let mut seen = frontier;
        let mut ring = frontier;
        let mut count = 0;
        loop {
            let next = self.neighbors(ring) & free & !seen;
            if next == 0 {
                break;
            }
            count += u64::from(next.count_ones());
            within.push(count);
            seen |= next;
            ring = next;
        }
        let max_limit = u64::from(bits(free).map(|n| self.limit[n]).max().unwrap_or(0));
        let mut slots: u64 = bits(frontier).map(|n| u64::from(self.limit[n])).sum();
        let mut levels = Vec::new();
        let mut covered = 0;
        let mut j = 0;
        while covered < count && slots > 0 {
            let eligible = within[j.min(within.len() - 1)];
            let width = slots.min(eligible);
            let next = (covered + width).min(eligible);
            levels.push((next - covered) as u32);
            covered = next;
            slots = width * max_limit;
            j += 1;
        }
        levels
    }

    pub fn solve(&self, incumbent: Option<(Value, u32)>, budget: u64) -> Attainable {
        let root = 1u64;
        let levels = self.level_bound(root, root);
        let cover_upper: u32 = levels.iter().sum();
        // Depth of the k-th shallowest possible slot, k = 1, 2, ...
        let slot_depths: Vec<u32> = levels
            .iter()
            .enumerate()
            .flat_map(|(j, &count)| std::iter::repeat(j as u32 + 1).take(count as usize))
            .collect();
        let mut search = Search {
            graph: self,
            mode: Mode::Total,
            best: incumbent.map_or(Value { cover: 0, total: 0 }, |(value, _)| value),
            best_max: incumbent.map_or(0, |(_, max)| max),
            nodes: 0,
            budget,
            aborted: false,
        };
        search.run(root, root, 0, Value { cover: 0, total: 0 });
        let best = search.best;
        let exact_total = !search.aborted;
        // Smallest maximum depth reaching the best known coverage: the best
        // tree found so far bounds it from above.
        let mut max_depth = search.best_max;
        if let Some((value, max)) = incumbent {
            if value.cover == best.cover {
                max_depth = max_depth.min(max);
            }
        }
        let mut exact_max = exact_total;
        // Any tree placing `best.cover` viewers is at least this deep, and its
        // depth sum is at least that of the shallowest slots.
        let max_lower = best
            .cover
            .checked_sub(1)
            .map_or(0, |k| slot_depths[k as usize]);
        let total_lower: u32 = slot_depths.iter().take(best.cover as usize).sum();
        let mut cap = max_lower;
        while cap < max_depth {
            let mut capped = Search {
                graph: self,
                mode: Mode::Capped {
                    cap,
                    target: best.cover,
                },
                best: Value { cover: 0, total: 0 },
                best_max: 0,
                nodes: 0,
                budget,
                aborted: false,
            };
            capped.run(root, root, 0, Value { cover: 0, total: 0 });
            if capped.best.cover >= best.cover {
                max_depth = cap;
                break;
            }
            if capped.aborted {
                exact_max = false;
            }
            cap += 1;
        }
        if best.cover == 0 {
            max_depth = 0;
        }
        Attainable {
            cover: best.cover,
            total: best.total,
            max_depth,
            exact: exact_total && exact_max,
            cover_upper: if exact_total { best.cover } else { cover_upper },
            // Bounds for trees placing at least `cover` viewers; with fewer
            // slots filled first, mean depth over `cover` is a lower bound too.
            total_lower: if exact_total { best.total } else { total_lower },
            max_lower: if exact_total && exact_max {
                max_depth
            } else {
                max_lower
            },
        }
    }
}

impl Search<'_> {
    fn offer(&mut self, value: Value, depth: u32) {
        if value.better(self.best) {
            self.best = value;
            self.best_max = depth;
        }
    }

    fn done(&self) -> bool {
        self.aborted
            || matches!(self.mode, Mode::Capped { target, .. } if self.best.cover >= target)
    }

    fn run(&mut self, placed: u64, frontier: u64, depth: u32, value: Value) {
        if self.done() {
            return;
        }
        self.nodes += 1;
        if self.nodes > self.budget {
            self.aborted = true;
            return;
        }
        let graph = self.graph;
        let candidates = graph.neighbors(frontier) & !placed;
        let capped_out = matches!(self.mode, Mode::Capped { cap, .. } if depth >= cap);
        if candidates == 0 || capped_out {
            self.offer(value, depth);
            return;
        }
        let levels = graph.level_bound(placed, frontier);
        match self.mode {
            Mode::Total => {
                let cover_upper = value.cover + levels.iter().sum::<u32>();
                if cover_upper < self.best.cover {
                    return;
                }
                if cover_upper == self.best.cover {
                    let total_lower = value.total
                        + levels
                            .iter()
                            .enumerate()
                            .map(|(j, count)| (depth + j as u32 + 1) * count)
                            .sum::<u32>();
                    if total_lower >= self.best.total {
                        return;
                    }
                }
            }
            Mode::Capped { cap, .. } => {
                let room = (cap - depth) as usize;
                let cover_upper = value.cover + levels.iter().take(room).sum::<u32>();
                if cover_upper <= self.best.cover {
                    return;
                }
            }
        }
        let size = graph.max_matching(candidates, frontier);
        // Try nodes with more unplaced neighbours first; they widen the next level.
        let mut order: Vec<usize> = bits(candidates).collect();
        let free = !placed & !candidates;
        order.sort_by_key(|&n| std::cmp::Reverse((graph.adjacency[n] & free).count_ones()));
        self.bases(&order, 0, 0, size, frontier, placed, depth, value);
    }

    #[allow(clippy::too_many_arguments)]
    fn bases(
        &mut self,
        order: &[usize],
        at: usize,
        set: u64,
        size: u32,
        frontier: u64,
        placed: u64,
        depth: u32,
        value: Value,
    ) {
        if self.done() {
            return;
        }
        if set.count_ones() == size {
            let next = Value {
                cover: value.cover + size,
                total: value.total + size * (depth + 1),
            };
            self.run(placed | set, set, depth + 1, next);
            return;
        }
        if at == order.len() || (order.len() - at) < (size - set.count_ones()) as usize {
            return;
        }
        let node = order[at];
        let with = set | (1 << node);
        if self.graph.matchable(with, frontier) {
            self.bases(order, at + 1, with, size, frontier, placed, depth, value);
        }
        self.bases(order, at + 1, set, size, frontier, placed, depth, value);
    }
}

#[cfg(test)]
pub mod checks {
    use super::*;

    /// Brute force over every parent assignment, for cross-checking.
    pub fn brute(graph: &Graph) -> (Value, u32) {
        let n = graph.adjacency.len();
        let mut parent = vec![usize::MAX; n];
        let mut best = (Value { cover: 0, total: 0 }, 0);
        let mut best_max = u32::MAX;
        let mut best_cover_for_max = 0;
        fn rec(
            g: &Graph,
            v: usize,
            parent: &mut Vec<usize>,
            best: &mut (Value, u32),
            best_max: &mut u32,
            best_cover_for_max: &mut u32,
        ) {
            let n = g.adjacency.len();
            if v == n {
                let mut outdeg = vec![0u32; n];
                for c in 1..n {
                    if parent[c] != usize::MAX {
                        outdeg[parent[c]] += 1;
                    }
                }
                if (0..n).any(|p| outdeg[p] > g.limit[p]) {
                    return;
                }
                let mut cover = 0;
                let mut total = 0;
                let mut max = 0;
                for c in 1..n {
                    if parent[c] == usize::MAX {
                        continue;
                    }
                    let mut depth = 0;
                    let mut x = c;
                    while x != 0 {
                        if depth > n as u32 || parent[x] == usize::MAX {
                            return;
                        }
                        x = parent[x];
                        depth += 1;
                    }
                    cover += 1;
                    total += depth;
                    max = max.max(depth);
                }
                let value = Value { cover, total };
                if value.better(best.0) {
                    *best = (value, max);
                }
                if cover > *best_cover_for_max || (cover == *best_cover_for_max && max < *best_max)
                {
                    *best_cover_for_max = cover;
                    *best_max = max;
                }
                return;
            }
            parent[v] = usize::MAX;
            rec(g, v + 1, parent, best, best_max, best_cover_for_max);
            for p in 0..n {
                if p != v && g.adjacency[p] & (1 << v) != 0 {
                    parent[v] = p;
                    rec(g, v + 1, parent, best, best_max, best_cover_for_max);
                }
            }
            parent[v] = usize::MAX;
        }
        rec(
            graph,
            1,
            &mut parent,
            &mut best,
            &mut best_max,
            &mut best_cover_for_max,
        );
        (best.0, best_max)
    }
}
