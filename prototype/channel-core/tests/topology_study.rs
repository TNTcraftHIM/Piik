#![cfg(feature = "sqlite")]
//! Offline study for ADR-0018 stage 0: how the present online planner places
//! viewers of one screen against the best tree attainable on the same
//! confirmed pairs, what a one-leaf move rule (stage 1) would do, and how often
//! one more child at a full parent (stage 2) would have helped.
//!
//! Every test here is `#[ignore]`d and runs only on request:
//! `cargo test --locked --features sqlite --test topology_study -- --ignored --nocapture`.
//! `STUDY_SCALE` multiplies the seed counts (default 1), `STUDY_SEEDS` replaces
//! them for a quick look. `STUDY_PART` selects
//! `base`, `sensitivity` or `all` (default). `released_pairs` asks whether
//! keeping every pair confirmed earlier would give leaf moves what attempting
//! one pair does; the published tables used `STUDY_SCALE=2`.
//!
//! `timed::time_model` gives endpoint answers a duration and measures each
//! viewer's first-picture delay (see `topology_study/timed.rs` for its
//! variables); with `--features sqlite,study` it also runs policies P1 and P2,
//! whose switches live in `src/study.rs`, off by default and compiled only
//! with that feature.
//!
//! The core is driven through the same public command path as the other
//! integration tests. Inputs are drawn from a seed, and participants are
//! numbered in session-identifier order, so a seed reproduces a run (checked
//! by `runs_are_deterministic` and `timed::timed_runs_are_deterministic`).

#[path = "topology_study/driver.rs"]
mod driver;
#[path = "topology_study/model.rs"]
mod model;
#[path = "topology_study/solver.rs"]
mod solver;
#[path = "topology_study/study.rs"]
mod study;
mod support;
#[path = "topology_study/timed.rs"]
mod timed;
#[path = "topology_study/tree.rs"]
mod tree;
#[path = "topology_study/waits.rs"]
mod waits;

use model::{Connectivity, Rng, Script, BASE, OPTIMISTIC, PESSIMISTIC};
use solver::Graph;
use study::{Options, Session};

/// Branch-and-bound budget per solve, by number of viewers.
fn budget(viewers: usize) -> u64 {
    match viewers {
        0..=8 => 50_000_000,
        9..=16 => 400_000,
        _ => 20_000,
    }
}

fn scale() -> usize {
    std::env::var("STUDY_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1)
}

fn seeds(viewers: usize) -> usize {
    if let Some(count) = std::env::var("STUDY_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
    {
        return count;
    }
    scale()
        * match viewers {
            0..=4 => 120,
            5..=8 => 80,
            9..=16 => 40,
            _ => 24,
        }
}

fn seed_of(model: &Connectivity, viewers: usize, index: usize) -> u64 {
    let tag = match model.name {
        "pessimistic" => 1,
        "base" => 2,
        _ => 3,
    };
    (tag << 48) | ((viewers as u64) << 32) | index as u64
}

#[test]
#[ignore = "study: solver cross-check"]
fn solver_matches_brute_force_on_small_graphs() {
    let mut rng = Rng::new(7);
    for case in 0..6_000 {
        let n = 2 + rng.below(6);
        let limit = 1 + rng.below(3) as u32;
        let density = 0.15 + 0.7 * rng.unit();
        let mut adjacency = vec![0u64; n];
        for a in 0..n {
            for b in a + 1..n {
                if rng.chance(density) {
                    adjacency[a] |= 1 << b;
                    adjacency[b] |= 1 << a;
                }
            }
        }
        let graph = Graph {
            adjacency,
            limit: vec![limit; n],
        };
        let (expected, expected_max) = solver::checks::brute(&graph);
        let got = graph.solve(None, u64::MAX);
        assert!(got.exact, "case {case}");
        // Without search, the bounds must still hold for the optimum.
        let bounds = graph.solve(Some((expected, expected_max)), 0);
        assert!(
            bounds.cover_upper >= expected.cover
                && bounds.total_lower <= expected.total
                && bounds.max_lower <= expected_max,
            "bounds, case {case}"
        );
        assert_eq!(
            (got.cover, got.total, got.max_depth),
            (expected.cover, expected.total, expected_max),
            "case {case}: n {n} limit {limit} {:?}",
            graph.adjacency
        );
    }
    println!("solver agrees with brute force on 6000 random graphs of 2 to 7 nodes");
}

/// The limit-1 case of the repository's five-node comparison
/// (`confirmed_routes_on_five_nodes_match_simple_path_bounds` in `src/routes.rs`):
/// with one output per endpoint the best coverage is the longest simple path.
#[test]
#[ignore = "study: solver cross-check"]
fn solver_matches_longest_path_on_all_five_node_graphs() {
    fn longest(adjacency: &[u64], at: usize, used: u64) -> u32 {
        let mut best = 0;
        for next in 0..adjacency.len() {
            if adjacency[at] & (1 << next) != 0 && used & (1 << next) == 0 {
                best = best.max(1 + longest(adjacency, next, used | (1 << next)));
            }
        }
        best
    }
    let edges: Vec<(usize, usize)> = (0..5)
        .flat_map(|a| (a + 1..5).map(move |b| (a, b)))
        .collect();
    for mask in 0..(1u32 << edges.len()) {
        let mut adjacency = vec![0u64; 5];
        for (bit, &(a, b)) in edges.iter().enumerate() {
            if mask & (1 << bit) != 0 {
                adjacency[a] |= 1 << b;
                adjacency[b] |= 1 << a;
            }
        }
        let graph = Graph {
            adjacency: adjacency.clone(),
            limit: vec![1; 5],
        };
        assert_eq!(
            graph.solve(None, u64::MAX).cover,
            longest(&adjacency, 0, 1),
            "graph {mask}"
        );
    }
}

#[test]
#[ignore = "study: determinism"]
fn runs_are_deterministic() {
    for (viewers, limit) in [(8, 2), (16, 2), (8, 1), (16, 3)] {
        for index in 0..3 {
            let script = Script::draw(seed_of(&BASE, viewers, index), viewers, &BASE);
            let options = Options {
                limit,
                budget: 1_000,
                all_pairs: false,
                execute_stage1: index == 0,
                verbose: false,
                timing: None,
                race_ms: None,
                depth_first: false,
                cold: false,
            };
            let first = study::run(&script, options);
            let second = study::run(&script, options);
            assert_eq!(
                first.trace, second.trace,
                "seed {} limit {limit}",
                script.seed
            );
        }
    }
    println!("twelve scripted sessions replayed identically");
}

/// The values one table row reports for one seed.
struct Row {
    sessions: Vec<Session>,
}

fn ratio(a: u32, b: u32) -> f64 {
    if b == 0 {
        f64::NAN
    } else {
        f64::from(a) / f64::from(b)
    }
}

fn spread(mut values: Vec<f64>, digits: usize) -> String {
    values.retain(|v| v.is_finite());
    if values.is_empty() {
        return "n/a".into();
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |q: f64| values[((values.len() - 1) as f64 * q).round() as usize];
    format!(
        "{:.d$} [{:.d$}–{:.d$}]",
        at(0.5),
        at(0.1),
        at(0.9),
        d = digits
    )
}

fn mean(values: &[f64]) -> f64 {
    let finite: Vec<_> = values.iter().copied().filter(|v| v.is_finite()).collect();
    finite.iter().sum::<f64>() / finite.len().max(1) as f64
}

impl Row {
    fn per(&self, f: impl Fn(&Session) -> f64) -> Vec<f64> {
        self.sessions.iter().map(f).collect()
    }
    fn sum(&self, f: impl Fn(&Session) -> u32) -> u32 {
        self.sessions.iter().map(f).sum()
    }
}

fn run_row(model: &Connectivity, viewers: usize, options: Options) -> Row {
    let count = seeds(viewers);
    let sessions = (0..count)
        .map(|index| {
            let script = Script::draw(seed_of(model, viewers, index), viewers, model);
            study::run(&script, options)
        })
        .collect();
    Row { sessions }
}

const SIZES: [usize; 4] = [4, 8, 16, 32];
const LIMITS: [u8; 3] = [1, 2, 3];

fn part(name: &str) -> bool {
    let wanted = std::env::var("STUDY_PART").unwrap_or_else(|_| "all".into());
    wanted == "all" || wanted == name
}

fn header(title: &str, columns: &[&str]) {
    println!("\n### {title}\n");
    println!("| {} |", columns.join(" | "));
    println!(
        "|{}|",
        columns
            .iter()
            .map(|_| " --- ")
            .collect::<Vec<_>>()
            .join("|")
    );
}

fn placement_table(model: &Connectivity, rows: &[(usize, u8, Row)]) {
    header(
        &format!(
            "Placement against the attainable tree ({} connectivity)",
            model.name
        ),
        &[
            "N",
            "L",
            "seeds",
            "pairs ok",
            "confirmed/viewer",
            "unplaced % planner",
            "unplaced % attainable",
            "unplaced with free parent",
            "mean depth planner",
            "mean depth attainable",
            "mean depth after stage 1",
            "max depth planner",
            "max depth attainable",
            "max depth after stage 1",
            "instants not optimal %",
            "excess hops per viewer at equal coverage",
            "same, before the first departure",
            "exact %",
        ],
    );
    for (viewers, limit, row) in rows {
        let pairs = row.per(|s| {
            ratio(
                s.pair_attempts.saturating_sub(s.pair_failures),
                s.pair_attempts,
            )
        });
        let confirmed = row.per(|s| ratio(s.confirmed, s.viewer_instants));
        let unplaced = row.per(|s| 100.0 * ratio(s.viewer_instants - s.placed, s.viewer_instants));
        let unplaced_opt =
            row.per(|s| 100.0 * ratio(s.viewer_instants - s.opt_cover, s.viewer_instants));
        let missed = row.sum(|s| s.unplaced_free);
        let depth = row.per(|s| ratio(s.total, s.placed));
        let depth_opt = row.per(|s| ratio(s.opt_total, s.opt_cover));
        let depth_s1 = row.per(|s| ratio(s.s1_total, s.placed));
        let max = row.per(|s| ratio(s.max_sum, s.instants));
        let max_opt = row.per(|s| ratio(s.opt_max_sum, s.instants));
        let max_s1 = row.per(|s| ratio(s.s1_max_sum, s.instants));
        let worse = row.per(|s| 100.0 * ratio(s.worse_cover + s.worse_total, s.instants));
        let excess = row.per(|s| ratio(s.depth_gap, s.equal_cover_placed));
        let early = row.per(|s| ratio(s.early_gap, s.early_placed));
        let exact = 100.0 * ratio(row.sum(|s| s.opt_exact), row.sum(|s| s.instants));
        println!(
            "| {viewers} | {limit} | {} | {} | {} | {} | {} | {missed} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {exact:.0} |",
            row.sessions.len(),
            spread(pairs, 2),
            spread(confirmed, 1),
            spread(unplaced, 1),
            spread(unplaced_opt, 1),
            spread(depth, 2),
            spread(depth_opt, 2),
            spread(depth_s1, 2),
            spread(max, 2),
            spread(max_opt, 2),
            spread(max_s1, 2),
            spread(worse, 0),
            spread(excess, 2),
            spread(early, 2),
        );
    }
}

fn bounds_table(model: &Connectivity, rows: &[(usize, u8, Row)]) {
    header(
        &format!(
            "Bounds where the search did not finish ({} connectivity)",
            model.name
        ),
        &[
            "N",
            "L",
            "exact %",
            "unplaced % lower bound",
            "mean depth lower bound",
            "max depth lower bound",
            "unplaced % if every connectable pair were confirmed",
            "mean depth then",
        ],
    );
    for (viewers, limit, row) in rows {
        let exact = 100.0 * ratio(row.sum(|s| s.opt_exact), row.sum(|s| s.instants));
        let unplaced_lb = row.per(|s| {
            100.0
                * ratio(
                    s.viewer_instants.saturating_sub(s.opt_cover_upper),
                    s.viewer_instants,
                )
        });
        let depth_lb = row.per(|s| ratio(s.opt_total_lower, s.opt_cover));
        let max_lb = row.per(|s| ratio(s.opt_max_lower_sum, s.instants));
        let all = row.sum(|s| s.instants) > 0 && row.sum(|s| s.all_cover) > 0;
        let (all_unplaced, all_depth) = if all {
            (
                spread(
                    row.per(|s| 100.0 * ratio(s.viewer_instants - s.all_cover, s.viewer_instants)),
                    1,
                ) + &format!(
                    " ({:.0}% exact)",
                    100.0 * ratio(row.sum(|s| s.all_exact), row.sum(|s| s.instants))
                ),
                spread(row.per(|s| ratio(s.all_total, s.all_cover)), 2),
            )
        } else {
            ("not run".into(), "not run".into())
        };
        println!(
            "| {viewers} | {limit} | {exact:.0} | {} | {} | {} | {all_unplaced} | {all_depth} |",
            spread(unplaced_lb, 1),
            spread(depth_lb, 2),
            spread(max_lb, 2),
        );
    }
}

fn closed(row: &Row, f: impl Fn(&Session) -> u32) -> String {
    let gap = row.sum(|s| s.depth_gap);
    if gap == 0 {
        "no gap".into()
    } else {
        format!("{:.0}", 100.0 * ratio(row.sum(f), gap))
    }
}

fn stage1_table(model: &Connectivity, rows: &[(usize, u8, Row)]) {
    header(
        &format!("Stage 1 rule as a what-if on the planner's trees ({} connectivity)", model.name),
        &[
            "N",
            "L",
            "moves per session",
            "instants with a move %",
            "opportunities per session",
            "recurring per session",
            "sessions with a recurring one %",
            "longest streak (instants)",
            "excess hops (all seeds)",
            "closed by leaf moves %",
            "closed by branch moves % (comparison)",
            "attempting a pair: closed % of the gap to the optimum on every connectable pair (comparison)",
            "pairs attempted per session (failed)",
            "max depth planner",
            "after leaf moves",
            "after branch moves",
            "after leaf moves attempting pairs",
            "attainable",
        ],
    );
    for (viewers, limit, row) in rows {
        let recurring_sessions = 100.0
            * row.sessions.iter().filter(|s| s.s1_recurring > 0).count() as f64
            / row.sessions.len() as f64;
        let longest = row.sessions.iter().map(|s| s.s1_longest).max().unwrap_or(0);
        println!(
            "| {viewers} | {limit} | {} | {} | {} | {} | {recurring_sessions:.0} | {longest} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            spread(row.per(|s| f64::from(s.s1_moves)), 1),
            spread(row.per(|s| 100.0 * ratio(s.s1_instants_with_move, s.instants)), 0),
            spread(row.per(|s| f64::from(s.s1_opportunities)), 1),
            spread(row.per(|s| f64::from(s.s1_recurring)), 1),
            row.sum(|s| s.depth_gap),
            closed(row, |s| s.s1_closed),
            closed(row, |s| s.branch_closed),
            {
                let gap = row.sum(|s| s.all_gap);
                if gap == 0 {
                    "no gap".to_string()
                } else {
                    format!("{:.0} (of {gap} hops)", 100.0 * ratio(row.sum(|s| s.pairs_closed), gap))
                }
            },
            format!(
                "{} ({})",
                spread(row.per(|s| s.whatif_attempted.len() as f64), 1),
                spread(row.per(|s| s.whatif_failed.len() as f64), 1)
            ),
            spread(row.per(|s| ratio(s.max_sum, s.instants)), 2),
            spread(row.per(|s| ratio(s.s1_max_sum, s.instants)), 2),
            spread(row.per(|s| ratio(s.branch_max_sum, s.instants)), 2),
            spread(row.per(|s| ratio(s.pairs_max_sum, s.instants)), 2),
            spread(row.per(|s| ratio(s.opt_max_sum, s.instants)), 2),
        );
    }
}

/// Pooled share of `part` in `whole`, in percent.
fn pooled(row: &Row, part: impl Fn(&Session) -> u32, whole: impl Fn(&Session) -> u32) -> String {
    let base = row.sum(whole);
    if base == 0 {
        "n/a".into()
    } else {
        format!("{:.0}", 100.0 * ratio(row.sum(part), base))
    }
}

/// Median, 90th percentile and maximum over every endpoint-instant of a row.
fn degrees(row: &Row, f: impl Fn(&Session) -> &Vec<u32>) -> String {
    let mut all: Vec<u32> = row
        .sessions
        .iter()
        .flat_map(|s| f(s).iter().copied())
        .collect();
    if all.is_empty() {
        return "n/a".into();
    }
    all.sort_unstable();
    let at = |q: f64| all[((all.len() - 1) as f64 * q).round() as usize];
    format!("{} [{}] max {}", at(0.5), at(0.9), all[all.len() - 1])
}

fn released_table(model: &Connectivity, rows: &[(usize, u8, Row)]) {
    header(
        &format!(
            "Leaf moves over released pairs: pairs confirmed earlier whose endpoints are still present ({} connectivity)",
            model.name
        ),
        &[
            "N",
            "L",
            "seeds",
            "released pairs per instant",
            "released / confirmed now %",
            "released pairs an earlier observation saw %",
            "untracked",
            "gap to confirmed optimum (hops)",
            "existing pairs: closed % of it",
            "existing + released: closed % of it",
            "gap to connectable optimum (hops)",
            "existing pairs: closed % of it",
            "existing + released: closed % of it",
            "one attempt: closed % of it",
            "existing + released / one attempt %",
            "successful attempts that were released pairs %",
            "pairs per endpoint now: median [p90] max",
            "pairs per endpoint keeping all: median [p90] max",
            "max depth: leaf moves / + released / attempting / attainable",
        ],
    );
    for (viewers, limit, row) in rows {
        println!(
            "| {viewers} | {limit} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} / {} / {} / {} |",
            row.sessions.len(),
            spread(row.per(|s| ratio(s.released, s.instants)), 1),
            spread(row.per(|s| 100.0 * ratio(s.released, s.member_confirmed)), 0),
            pooled(row, |s| s.released_observed, |s| s.released),
            row.sum(|s| s.untracked),
            row.sum(|s| s.depth_gap),
            closed(row, |s| s.s1_closed),
            closed(row, |s| s.kept_closed),
            row.sum(|s| s.all_gap),
            pooled(row, |s| s.s1_closed_all, |s| s.all_gap),
            pooled(row, |s| s.kept_closed_all, |s| s.all_gap),
            pooled(row, |s| s.pairs_closed, |s| s.all_gap),
            pooled(row, |s| s.kept_closed_all, |s| s.pairs_closed),
            pooled(row, |s| s.attempts_released, |s| s.attempts_ok),
            degrees(row, |s| &s.degree_now),
            degrees(row, |s| &s.degree_kept),
            spread(row.per(|s| ratio(s.s1_max_sum, s.instants)), 2),
            spread(row.per(|s| ratio(s.kept_max_sum, s.instants)), 2),
            spread(row.per(|s| ratio(s.pairs_max_sum, s.instants)), 2),
            spread(row.per(|s| ratio(s.opt_max_sum, s.instants)), 2),
        );
    }
}

fn executed_table(model: &Connectivity, rows: &[(usize, u8, Row)], executed: &[(usize, u8, Row)]) {
    header(
        &format!("Stage 1 executed by the core's planner, one leaf re-placed at a time ({} connectivity)", model.name),
        &[
            "N",
            "L",
            "moves per session",
            "placed at the predicted depth %",
            "returned to a former parent",
            "exact reversals",
            "no gain / lost",
            "cap hits",
            "mean depth: planner arm / executed arm",
            "excess hops per viewer: planner arm / executed arm",
            "max depth: planner arm / executed arm",
            "unplaced %: planner arm / executed arm",
            "parent changes per viewer: planner arm / executed arm",
        ],
    );
    for (viewers, limit, e) in executed {
        let Some((_, _, row)) = rows.iter().find(|(v, l, _)| v == viewers && l == limit) else {
            continue;
        };
        let pair = |f: &dyn Fn(&Session) -> f64, digits| {
            format!(
                "{} / {}",
                spread(row.per(f), digits),
                spread(e.per(f), digits)
            )
        };
        let changes = |s: &Session| ratio(s.repairs + s.voluntary + s.exec_moves, s.viewers_seen);
        println!(
            "| {viewers} | {limit} | {} | {:.0} | {} | {} | {} / {} | {} | {} | {} | {} | {} | {} |",
            spread(e.per(|s| f64::from(s.exec_moves)), 1),
            100.0 * ratio(e.sum(|s| s.exec_as_predicted), e.sum(|s| s.exec_moves)),
            e.sum(|s| s.exec_moved_back),
            e.sum(|s| s.exec_reversed),
            e.sum(|s| s.exec_no_gain),
            e.sum(|s| s.exec_lost),
            e.sum(|s| s.exec_cap_hits),
            pair(&|s| ratio(s.total, s.placed), 2),
            pair(&|s| ratio(s.depth_gap, s.equal_cover_placed), 2),
            pair(&|s| ratio(s.max_sum, s.instants), 2),
            pair(&|s| 100.0 * ratio(s.viewer_instants - s.placed, s.viewer_instants), 1),
            pair(&changes, 2),
        );
    }
}

fn stage2_table(model: &Connectivity, rows: &[(usize, u8, Row)]) {
    header(
        &format!(
            "Stage 2 question: one more child at a full parent ({} connectivity)",
            model.name
        ),
        &[
            "N",
            "L",
            "refused viewer-instants per session",
            "deeper viewer-instants per session",
            "mean depth gain when deeper",
            "instants with a case %",
            "sessions with a case %",
            "cases persisting to the next instant",
            "unplaced, only full parents linked",
            "unplaced, no confirmed pair into the tree",
        ],
    );
    for (viewers, limit, row) in rows {
        let refused = row.per(|s| f64::from(s.unmet_refused));
        let deeper = row.per(|s| f64::from(s.unmet_deeper));
        let gain = ratio(row.sum(|s| s.unmet_gain), row.sum(|s| s.unmet_deeper));
        let instants = row.per(|s| 100.0 * ratio(s.unmet_instants, s.instants));
        let sessions = 100.0
            * row
                .sessions
                .iter()
                .filter(|s| s.unmet_refused + s.unmet_deeper > 0)
                .count() as f64
            / row.sessions.len() as f64;
        println!(
            "| {viewers} | {limit} | {} | {} | {gain:.2} | {} | {sessions:.0} | {} | {} | {} |",
            spread(refused, 1),
            spread(deeper, 1),
            spread(instants, 0),
            row.sum(|s| s.unmet_recurring),
            row.sum(|s| s.unplaced_full),
            row.sum(|s| s.unplaced_none),
        );
    }
}

fn behaviour_table(model: &Connectivity, rows: &[(usize, u8, Row)]) {
    header(
        &format!("Planner behaviour over time ({} connectivity)", model.name),
        &[
            "N",
            "L",
            "relay departures",
            "repair changes per session",
            "voluntary changes (all seeds; not to the sharer)",
            "lost placements (all seeds)",
            "most changes of one viewer",
            "forwarders at their limit %",
            "largest fan-out",
            "over limit",
            "harness: errors / unsettled / preparing / transit / infeasible",
        ],
    );
    for (viewers, limit, row) in rows {
        println!(
            "| {viewers} | {limit} | {} | {} | {} ({}) | {} | {} | {:.0} | {} | {} | {} / {} / {} / {} / {} |",
            row.sum(|s| s.relay_departures),
            spread(row.per(|s| f64::from(s.repairs)), 1),
            row.sum(|s| s.voluntary),
            row.sum(|s| s.voluntary_other),
            row.sum(|s| s.lost),
            row.sessions.iter().map(|s| s.most_changes).max().unwrap_or(0),
            100.0 * ratio(row.sum(|s| s.at_limit), row.sum(|s| s.forwarder_instants)),
            row.sessions.iter().map(|s| s.max_outdeg).max().unwrap_or(0),
            row.sum(|s| s.over_limit),
            row.sum(|s| s.errors),
            row.sum(|s| s.unsettled),
            row.sum(|s| s.preparing),
            row.sum(|s| s.transit),
            row.sum(|s| s.infeasible),
        );
    }
}

fn notes(rows: &[(usize, u8, Row)], label: &str) {
    let mut printed = 0;
    for (viewers, limit, row) in rows {
        let mut kinds: std::collections::BTreeMap<String, (usize, String)> = Default::default();
        for session in &row.sessions {
            for note in &session.notes {
                let kind: String = note.split(" seed ").next().unwrap_or("").to_string();
                let entry = kinds.entry(kind).or_insert((0, note.clone()));
                entry.0 += 1;
            }
        }
        for (kind, (count, example)) in kinds {
            println!("- {label} N={viewers} L={limit}: {kind}: {count} times; first: {example}");
            printed += 1;
        }
    }
    if printed == 0 {
        println!("- {label}: no notes");
    }
}

fn grid(model: &Connectivity, sizes: &[usize], limits: &[u8], execute_up_to: usize) {
    let started = std::time::Instant::now();
    let mut rows = Vec::new();
    let mut executed = Vec::new();
    for &viewers in sizes {
        for &limit in limits {
            let options = Options {
                limit,
                budget: budget(viewers),
                all_pairs: true,
                execute_stage1: false,
                verbose: false,
                timing: None,
                race_ms: None,
                depth_first: false,
                cold: false,
            };
            rows.push((viewers, limit, run_row(model, viewers, options)));
            if viewers <= execute_up_to {
                let options = Options {
                    all_pairs: false,
                    execute_stage1: true,
                    ..options
                };
                executed.push((viewers, limit, run_row(model, viewers, options)));
            }
            eprintln!(
                "{} N={viewers} L={limit} done at {:?}",
                model.name,
                started.elapsed()
            );
        }
    }
    println!(
        "\n## {} connectivity (expected connectable pairs {:.0}%)",
        model.name,
        100.0 * model.expected_pair_success()
    );
    placement_table(model, &rows);
    bounds_table(model, &rows);
    stage1_table(model, &rows);
    executed_table(model, &rows, &executed);
    stage2_table(model, &rows);
    behaviour_table(model, &rows);
    println!("\n### Notes ({})\n", model.name);
    notes(&rows, "planner");
    notes(&executed, "stage 1 executed");
    let means: Vec<f64> = rows
        .iter()
        .map(|(_, _, row)| mean(&row.per(|s| ratio(s.total, s.placed))))
        .collect();
    eprintln!(
        "{} finished in {:?}; mean depths {means:?}",
        model.name,
        started.elapsed()
    );
}

/// Prints one session instant by instant: `STUDY_TRACE=seed,viewers,limit[,execute]`.
#[test]
#[ignore = "study: one traced session"]
fn trace() {
    let spec = std::env::var("STUDY_TRACE").expect("STUDY_TRACE=seed,viewers,limit[,execute]");
    let parts: Vec<u64> = spec.split(',').map(|p| p.trim().parse().unwrap()).collect();
    let (seed, viewers, limit) = (parts[0], parts[1] as usize, parts[2] as u8);
    let tag = seed >> 48;
    let model = [PESSIMISTIC, BASE, OPTIMISTIC][(tag.max(1) - 1) as usize];
    let script = Script::draw(seed, viewers, &model);
    println!(
        "{} seed {seed}: source {} classes {:?}",
        model.name, script.source, script.classes
    );
    let session = study::run(
        &script,
        Options {
            limit,
            budget: budget(viewers),
            all_pairs: false,
            execute_stage1: parts.get(3) == Some(&1),
            verbose: true,
            // Timed: `STUDY_TRACE_F` = failure ms (success and proof 500 ms);
            // `STUDY_TRACE_RACE` = P1 head start ms.
            timing: std::env::var("STUDY_TRACE_F").ok().map(|f| driver::Timing {
                success_ms: 500,
                failure_ms: f.parse().unwrap(),
                proof_ms: 500,
            }),
            race_ms: std::env::var("STUDY_TRACE_RACE")
                .ok()
                .map(|h| h.parse().unwrap()),
            depth_first: std::env::var_os("STUDY_TRACE_DEPTH").is_some(),
            cold: std::env::var_os("STUDY_TRACE_COLD").is_some(),
        },
    );
    for note in &session.notes {
        println!("note: {note}");
    }
}

/// Would keeping every confirmed pair do what attempting one pair does? The
/// stage 1 rows at L = 2 with the same options as `study`, so its two
/// existing columns must reproduce, beside the released-pairs counterfactual.
#[test]
#[ignore = "study: released pairs, a few minutes"]
fn released_pairs() {
    for model in [PESSIMISTIC, BASE, OPTIMISTIC] {
        let rows: Vec<_> = [8, 16, 32]
            .into_iter()
            .map(|viewers| {
                let options = Options {
                    limit: 2,
                    budget: budget(viewers),
                    all_pairs: true,
                    execute_stage1: false,
                    verbose: false,
                    timing: None,
                    race_ms: None,
                    depth_first: false,
                    cold: false,
                };
                (viewers, 2, run_row(&model, viewers, options))
            })
            .collect();
        println!(
            "\n## {} connectivity (expected connectable pairs {:.0}%)",
            model.name,
            100.0 * model.expected_pair_success()
        );
        stage1_table(&model, &rows);
        released_table(&model, &rows);
        let harness: u32 = rows
            .iter()
            .map(|(_, _, row)| row.sum(|s| s.errors + s.unsettled + s.infeasible + s.transit))
            .sum();
        println!("\nharness errors / unsettled / infeasible / transit, all rows: {harness}");
    }
}

#[test]
#[ignore = "study: full run, several minutes"]
fn study() {
    if part("base") {
        grid(&BASE, &SIZES, &LIMITS, 32);
    }
    if part("sensitivity") {
        for model in [PESSIMISTIC, OPTIMISTIC] {
            grid(&model, &SIZES, &[2], 32);
        }
    }
}
