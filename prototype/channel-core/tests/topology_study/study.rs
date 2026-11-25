//! One scripted session through the real core, observed after every event.

use super::driver::{Driver, Observation, Timing};
use super::model::{Action, Script, QUIET_STEPS_MS};
use super::solver::Value;
use super::tree::Instant;
use super::waits::{Wait, Waits};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy)]
pub struct Options {
    pub limit: u8,
    /// Branch-and-bound nodes per solve before falling back to bounds.
    pub budget: u64,
    /// Also bound the tree on every connectable pair, not only confirmed ones.
    pub all_pairs: bool,
    /// Execute the stage 1 rule through the core after every event.
    pub execute_stage1: bool,
    /// Print every instant.
    pub verbose: bool,
    /// Endpoint answers take time (None: instant, as in the stage 0 tables).
    pub timing: Option<Timing>,
    /// Policy P1: race one alternative once the direct pair has been pending
    /// this long. Needs the crate feature `study`.
    pub race_ms: Option<u64>,
    /// Viewers enable peer transport only on arrival (see `Driver::cold`).
    pub cold: bool,
}

/// After the last scripted event, timed sessions keep running this long so
/// that waits still open can finish. Nothing else is recorded meanwhile.
const DRAIN_MS: u64 = 60_000;

/// Sets the study-only product switches for one session on this thread and
/// restores the shipped rule afterwards.
struct Policy;

impl Policy {
    fn set(race_ms: Option<u64>) -> Self {
        #[cfg(feature = "study")]
        piik_channel_core::study::RACE_DIRECT_AFTER_MS.with(|c| c.set(race_ms));
        #[cfg(not(feature = "study"))]
        assert!(race_ms.is_none(), "policy P1 needs --features sqlite,study");
        Policy
    }
}

impl Drop for Policy {
    fn drop(&mut self) {
        #[cfg(feature = "study")]
        piik_channel_core::study::RACE_DIRECT_AFTER_MS.with(|c| c.set(None));
    }
}

/// Sums over the observed instants of one session.
#[derive(Clone, Default, Debug)]
pub struct Session {
    pub instants: u32,
    pub viewer_instants: u32,
    pub placed: u32,
    pub total: u32,
    pub max_sum: u32,
    pub max_max: u32,
    pub unplaced_free: u32,
    pub unplaced_full: u32,
    pub unplaced_none: u32,
    // Attainable on the same confirmed pairs and limits.
    pub opt_cover: u32,
    pub opt_total: u32,
    pub opt_max_sum: u32,
    pub opt_exact: u32,
    pub opt_cover_upper: u32,
    pub opt_total_lower: u32,
    pub opt_max_lower_sum: u32,
    pub worse_cover: u32,
    pub worse_total: u32,
    pub worse_max: u32,
    /// Depth sum above the attainable one, at instants of equal coverage.
    pub depth_gap: u32,
    pub equal_cover_instants: u32,
    // Stage 1 what-if on the planner's own tree.
    pub s1_moves: u32,
    pub s1_total: u32,
    pub s1_max_sum: u32,
    pub s1_closed: u32,
    pub s1_opportunities: u32,
    pub s1_recurring: u32,
    pub s1_longest: u32,
    pub s1_instants_with_move: u32,
    /// The same with whole branches allowed to move (comparison, not stage 1).
    pub branch_moves: u32,
    pub branch_total: u32,
    pub branch_max_sum: u32,
    pub branch_closed: u32,
    /// Stage 1 what-if when the move's pair may be attempted (comparison).
    pub pairs_total: u32,
    pub pairs_max_sum: u32,
    /// Depth sum above the attainable tree on every connectable pair, at
    /// instants of equal coverage, and the part the attempting rule removes.
    pub all_gap: u32,
    pub pairs_closed: u32,
    /// Distinct pairs the attempting rule tried in the session, and failed.
    pub whatif_attempted: BTreeSet<(usize, usize)>,
    pub whatif_failed: BTreeSet<(usize, usize)>,
    /// `s1_closed` counted at the instants `pairs_closed` is, against `all_gap`.
    pub s1_closed_all: u32,
    // Retention what-if. A released pair was confirmed at some earlier moment
    // of the session, is not confirmed now, and both endpoints are present
    // (the source or a watching viewer) with their original sessions.
    pub released: u32,
    /// Released pairs that an earlier observation had also seen confirmed.
    pub released_observed: u32,
    /// Confirmed pairs with both endpoints present, the base of `released`.
    pub member_confirmed: u32,
    /// Observed confirmed pairs the driver never saw both sides confirm
    /// (should be zero: the tracking would be incomplete).
    pub untracked: u32,
    /// The stage 1 leaf rule on confirmed plus released pairs, no attempts.
    pub kept_moves: u32,
    pub kept_max_sum: u32,
    /// Its depth reduction at the instants `s1_closed` and `pairs_closed` count.
    pub kept_closed: u32,
    pub kept_closed_all: u32,
    /// Successful attempts of the attempting rule, per instant, and how many
    /// of them were released pairs.
    pub attempts_ok: u32,
    pub attempts_released: u32,
    /// Pairs per present endpoint at every instant: confirmed now, and
    /// confirmed plus released (what keeping every pair would hold).
    pub degree_now: Vec<u32>,
    pub degree_kept: Vec<u32>,
    /// Pairs seen confirmed at any observation so far.
    pub observed: BTreeSet<(usize, usize)>,
    /// Placed viewers at instants of equal coverage, the base of `depth_gap`.
    pub equal_cover_placed: u32,
    /// The same two sums before the first departure of the session only.
    pub early_gap: u32,
    pub early_placed: u32,
    // Stage 2 question.
    pub unmet_refused: u32,
    pub unmet_deeper: u32,
    pub unmet_gain: u32,
    pub unmet_recurring: u32,
    pub unmet_instants: u32,
    // Attainable if every connectable pair were confirmed.
    pub all_cover: u32,
    pub all_total: u32,
    pub all_exact: u32,
    // Parent changes between observations.
    pub repairs: u32,
    pub voluntary: u32,
    /// Voluntary changes whose new parent is not the sharer.
    pub voluntary_other: u32,
    pub lost: u32,
    pub most_changes: u32,
    pub viewers_seen: u32,
    // Forwarding load.
    pub forwarder_instants: u32,
    pub at_limit: u32,
    pub over_limit: u32,
    pub max_outdeg: u32,
    // Stage 1 executed through the core.
    pub exec_moves: u32,
    pub exec_as_predicted: u32,
    pub exec_moved_back: u32,
    /// A move that exactly undoes the same viewer's previous stage 1 move.
    pub exec_reversed: u32,
    pub exec_cap_hits: u32,
    pub exec_no_gain: u32,
    pub exec_lost: u32,
    // Harness health.
    pub errors: u32,
    pub unsettled: u32,
    pub preparing: u32,
    pub doubled: u32,
    pub infeasible: u32,
    pub transit: u32,
    pub pair_attempts: u32,
    pub pair_failures: u32,
    pub confirmed: u32,
    pub relay_departures: u32,
    /// Parent maps in order, for the determinism check.
    pub trace: Vec<BTreeMap<usize, usize>>,
    /// Instants worth reading, with the reason.
    pub notes: Vec<String>,
    pub seed: u64,
    pub log: Vec<String>,
    // Timed sessions only.
    /// One entry per viewer arrival.
    pub waits: Vec<Wait>,
    /// Distinct physical pair ids any endpoint was asked to try.
    pub pairs_started: u32,
    pub early_observations: u32,
}

fn instant(driver: &Driver, observation: &Observation, limit: u8) -> Instant {
    let viewers: BTreeSet<usize> = (0..driver.people.len())
        .filter(|&p| driver.online[p] && driver.viewing[p] && p != driver.source)
        .collect();
    Instant {
        source: driver.source,
        viewers,
        confirmed: observation.confirmed.clone(),
        limit: u32::from(limit),
        parent: observation.parent.clone(),
    }
}

pub fn run(script: &Script, options: Options) -> Session {
    let _policy = Policy::set(options.race_ms);
    let mut driver = Driver::new(script, options.limit, options.timing, options.cold);
    let mut waits = Waits::default();
    let timed = options.timing.is_some();
    let mut session = Session::default();
    let mut last: Option<Instant> = None;
    let mut changes: BTreeMap<usize, u32> = BTreeMap::new();
    let mut opportunities: BTreeMap<(usize, usize), u32> = BTreeMap::new();
    let mut unmet_seen: BTreeSet<(usize, usize)> = BTreeSet::new();
    let mut executed: BTreeMap<usize, Vec<(usize, usize)>> = BTreeMap::new();
    let mut seen_viewers = BTreeSet::new();
    let mut any_departure = false;
    for event in &script.events {
        if timed {
            driver.run_until(event.at, |d| waits.step(d));
        } else {
            driver.advance(event.at);
        }
        let mut departed = None;
        match event.action {
            Action::Arrive(viewer) => {
                driver.arrive(viewer);
                if timed {
                    waits.start(&driver, viewer);
                }
                seen_viewers.insert(viewer);
            }
            Action::Leave(viewer) => {
                if driver.online[viewer] {
                    driver.leave(viewer);
                    departed = Some(viewer);
                }
            }
            Action::RelayLeaves(draw) => {
                let tree = driver.observe();
                let relays: BTreeSet<usize> = tree
                    .parent
                    .values()
                    .copied()
                    .filter(|&p| p != driver.source && driver.online[p])
                    .collect();
                if !relays.is_empty() {
                    let relays: Vec<_> = relays.into_iter().collect();
                    let viewer = relays[(draw % relays.len() as u64) as usize];
                    driver.leave(viewer);
                    departed = Some(viewer);
                    session.relay_departures += 1;
                }
            }
        }
        any_departure |= departed.is_some();
        if timed {
            waits.step(&mut driver);
            // Observe at the server's expiry tick after the quiet period, a
            // moment the authority has input anyway (see `Driver::observe`).
            let tick = super::driver::EXPIRE_EVERY_MS;
            let at = (event.at + QUIET_STEPS_MS[1]).div_ceil(tick) * tick;
            driver.run_until(at, |d| waits.step(d));
        } else {
            for quiet in QUIET_STEPS_MS {
                driver.advance(event.at + quiet);
            }
        }
        let observation = driver.observe();
        let mut now = instant(&driver, &observation, options.limit);

        // Parent changes the planner made since the last instant.
        if let Some(before) = &last {
            let orphaned: BTreeSet<usize> = departed
                .map(|gone| {
                    let mut set = BTreeSet::from([gone]);
                    let mut grew = true;
                    while grew {
                        grew = false;
                        for (&c, p) in &before.parent {
                            if set.contains(p) && set.insert(c) {
                                grew = true;
                            }
                        }
                    }
                    set
                })
                .unwrap_or_default();
            for &v in &now.viewers {
                let (Some(old), new) = (before.parent.get(&v), now.parent.get(&v)) else {
                    continue;
                };
                match new {
                    None => session.lost += 1,
                    Some(new) if new != old => {
                        *changes.entry(v).or_insert(0) += 1;
                        if orphaned.contains(&v) {
                            session.repairs += 1;
                        } else {
                            session.voluntary += 1;
                            if *new != now.source {
                                session.voluntary_other += 1;
                                session.notes.push(format!(
                                    "voluntary change not to the sharer seed {} at {}: viewer {v} {old}->{new}",
                                    script.seed, event.at
                                ));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        // Stage 1 executed: re-place one leaf at a time through the planner.
        if options.execute_stage1 {
            let cap = 3 * script.people;
            let mut count = 0;
            while let Some((v, from, to, _)) = now.stage1_move() {
                if count == cap {
                    session.exec_cap_hits += 1;
                    session.notes.push(format!(
                        "stage 1 cap hit seed {} at {}",
                        script.seed, event.at
                    ));
                    break;
                }
                count += 1;
                if options.verbose {
                    println!("    stage 1: move {v} from {from} to {to}");
                }
                let depth = now.depths();
                let predicted = depth[&to] + 1;
                let old_depth = depth[&v];
                driver.subscribe(v, false);
                driver.subscribe(v, true);
                let observation = driver.observe();
                let next = instant(&driver, &observation, options.limit);
                session.exec_moves += 1;
                let history = executed.entry(v).or_default();
                match (next.parent.get(&v), next.depths().get(&v)) {
                    (Some(&up), Some(&d)) => {
                        if up != from {
                            *changes.entry(v).or_insert(0) += 1;
                        }
                        if d == predicted {
                            session.exec_as_predicted += 1;
                        }
                        if d >= old_depth {
                            session.exec_no_gain += 1;
                        }
                        if history.iter().any(|(left, _)| *left == up) {
                            session.exec_moved_back += 1;
                            session.notes.push(format!(
                                "stage 1 moved back seed {} at {}: viewer {v} to {up}",
                                script.seed, event.at
                            ));
                        }
                        if history.last() == Some(&(up, from)) {
                            session.exec_reversed += 1;
                            session.notes.push(format!(
                                "stage 1 reversed its previous move seed {} at {}: viewer {v} {from}->{up}",
                                script.seed, event.at
                            ));
                        }
                        history.push((from, up));
                    }
                    _ => session.exec_lost += 1,
                }
                now = next;
            }
        }
        let observation = if options.execute_stage1 {
            driver.observe()
        } else {
            observation
        };

        if options.verbose {
            let depth = now.depths();
            let attainable = now
                .graph(&|a, b| now.linked(a, b))
                .solve(None, options.budget);
            println!(
                "{:>7} {:?} departed {:?}
    tree {:?}
    depth {:?}
    confirmed {:?}
    placement {:?} attainable cover {} total {} max {} exact {}
    stage 1 what-if {:?}
    unmet {:?}",
                event.at,
                event.action,
                departed,
                now.parent,
                depth,
                now.confirmed,
                now.placement(),
                attainable.cover,
                attainable.total,
                attainable.max_depth,
                attainable.exact,
                now.stage1_fixpoint().1,
                now.unmet_demand(),
            );
        }
        let (gap, placed) = (session.depth_gap, session.equal_cover_placed);
        record(&mut session, &driver, &observation, &now, options, script);
        if !any_departure {
            session.early_gap += session.depth_gap - gap;
            session.early_placed += session.equal_cover_placed - placed;
        }

        // Recurring stage 1 opportunities and unmet demand on the planner's tree.
        let current: BTreeSet<(usize, usize)> = now
            .parent
            .iter()
            .filter(|(v, _)| leaf_has_better_place(&now, **v))
            .map(|(&v, &up)| (v, up))
            .collect();
        opportunities.retain(|key, _| current.contains(key));
        for key in &current {
            let streak = opportunities.entry(*key).or_insert(0);
            *streak += 1;
            if *streak == 1 {
                session.s1_opportunities += 1;
            }
            if *streak == 2 {
                session.s1_recurring += 1;
            }
            session.s1_longest = session.s1_longest.max(*streak);
        }
        let unmet: BTreeSet<(usize, usize)> = now
            .unmet_demand()
            .into_iter()
            .map(|(v, q, _)| (v, q))
            .collect();
        for key in &unmet {
            if unmet_seen.contains(key) {
                session.unmet_recurring += 1;
            }
        }
        unmet_seen = unmet;

        session.trace.push(now.parent.clone());
        last = Some(now);
    }
    if timed {
        driver.run_until(driver.now + DRAIN_MS, |d| waits.step(d));
        session.waits = waits.finish(&driver);
        session.pairs_started = driver.pairs_started.len() as u32;
        session.early_observations = driver.early_observations as u32;
    }
    session.seed = script.seed;
    session.log = std::mem::take(&mut driver.log);
    session.most_changes = changes.values().copied().max().unwrap_or(0);
    session.viewers_seen = seen_viewers.len() as u32;
    session.errors = driver.errors as u32;
    session.unsettled = driver.unsettled as u32;
    session.pair_attempts = driver.pair_attempts as u32;
    session.pair_failures = driver.pair_failures as u32;
    session
}

fn leaf_has_better_place(tree: &Instant, v: usize) -> bool {
    let depth = tree.depths();
    let children = tree.children();
    if children.contains_key(&v) || !tree.viewers.contains(&v) {
        return false;
    }
    let (Some(&dv), Some(&up)) = (depth.get(&v), tree.parent.get(&v)) else {
        return false;
    };
    depth.iter().any(|(&q, &dq)| {
        q != v
            && q != up
            && tree.linked(q, v)
            && children.get(&q).copied().unwrap_or(0) < tree.limit
            && dq + 1 < dv
    })
}

fn record(
    session: &mut Session,
    driver: &Driver,
    observation: &Observation,
    now: &Instant,
    options: Options,
    script: &Script,
) {
    session.instants += 1;
    session.viewer_instants += now.viewers.len() as u32;
    session.preparing += observation.preparing as u32;
    session.doubled += observation.doubled as u32;
    session.confirmed += now.confirmed.len() as u32;
    let (placed, total, max) = now.placement();
    session.placed += placed;
    session.total += total;
    session.max_sum += max;
    session.max_max = session.max_max.max(max);
    let (free, full, none) = now.unplaced();
    session.unplaced_free += free;
    session.unplaced_full += full;
    session.unplaced_none += none;
    if free > 0 {
        session.notes.push(format!(
            "unplaced with a free parent seed {} limit {} at {}: {:?}",
            script.seed, options.limit, driver.now, now.parent
        ));
    }

    // Load.
    let children = now.children();
    let depth = now.depths();
    for (&node, &count) in &children {
        if !depth.contains_key(&node) {
            continue;
        }
        session.forwarder_instants += 1;
        if count >= now.limit {
            session.at_limit += 1;
        }
        if count > now.limit {
            session.over_limit += 1;
        }
        session.max_outdeg = session.max_outdeg.max(count);
    }

    // The planner's tree must be a feasible tree of the solver's model to be
    // used as an incumbent: only present viewers, confirmed pairs, limits.
    let members: BTreeSet<usize> = now.viewers.iter().copied().chain([now.source]).collect();
    let transit = now.parent.keys().filter(|c| !members.contains(c)).count();
    session.transit += transit as u32;
    let feasible = transit == 0
        && now.parent.iter().all(|(&c, &p)| now.linked(c, p))
        && children.values().all(|&count| count <= now.limit);
    if !feasible {
        session.infeasible += 1;
    }
    let incumbent = feasible.then_some((
        Value {
            cover: placed,
            total,
        },
        max,
    ));

    let attainable = now
        .graph(&|a, b| now.linked(a, b))
        .solve(incumbent, options.budget);
    session.opt_cover += attainable.cover;
    session.opt_total += attainable.total;
    session.opt_max_sum += attainable.max_depth;
    session.opt_exact += u32::from(attainable.exact);
    session.opt_cover_upper += attainable.cover_upper;
    session.opt_total_lower += attainable.total_lower;
    session.opt_max_lower_sum += attainable.max_lower;
    if attainable.cover > placed {
        session.worse_cover += 1;
    }
    if attainable.cover < placed || (attainable.cover == placed && attainable.total > total) {
        session.notes.push(format!(
            "planner beats the solver model seed {} limit {} at {}: {:?}",
            script.seed, options.limit, driver.now, now.parent
        ));
    }
    if attainable.cover == placed {
        session.equal_cover_instants += 1;
        session.equal_cover_placed += placed;
        session.depth_gap += total.saturating_sub(attainable.total);
        if attainable.total < total {
            session.worse_total += 1;
        }
        if attainable.max_depth < max {
            session.worse_max += 1;
        }
    }

    // Stage 1 what-if, one move at a time to its fixed point.
    let (after, moves) = now.stage1_fixpoint();
    let (_, s1_total, s1_max) = after.placement();
    session.s1_moves += moves.len() as u32;
    session.s1_total += s1_total;
    session.s1_max_sum += s1_max;
    if !moves.is_empty() {
        session.s1_instants_with_move += 1;
    }
    if attainable.cover == placed {
        session.s1_closed += total - s1_total;
    }
    // Retention what-if: the same leaf rule on confirmed plus released pairs.
    let present = |&(a, b): &(usize, usize)| members.contains(&a) && members.contains(&b);
    let current: BTreeSet<(usize, usize)> = now.confirmed.iter().copied().filter(present).collect();
    session.untracked += now
        .confirmed
        .iter()
        .filter(|key| !driver.ever_confirmed.contains(key))
        .count() as u32;
    let released: BTreeSet<(usize, usize)> = driver
        .ever_confirmed
        .iter()
        .copied()
        .filter(|key| present(key) && !current.contains(key))
        .collect();
    session.released += released.len() as u32;
    session.released_observed += released.intersection(&session.observed).count() as u32;
    session.member_confirmed += current.len() as u32;
    session.observed.extend(now.confirmed.iter().copied());
    let mut kept = now.clone();
    kept.confirmed.extend(released.iter().copied());
    let (kept_after, kept_moves) = kept.stage1_fixpoint();
    let (_, kept_total, kept_max) = kept_after.placement();
    session.kept_moves += kept_moves.len() as u32;
    session.kept_max_sum += kept_max;
    if attainable.cover == placed {
        session.kept_closed += total - kept_total;
    }
    for &m in &members {
        let degree = |pairs: &BTreeSet<(usize, usize)>| {
            pairs.iter().filter(|&&(a, b)| a == m || b == m).count() as u32
        };
        session.degree_now.push(degree(&current));
        session
            .degree_kept
            .push(degree(&current) + degree(&released));
    }

    let connectable = &script.connectable;
    let (after, _, attempts) = now.stage1_with_attempts(&|a, b| connectable[a][b]);
    let (_, pairs_total, pairs_max) = after.placement();
    session.pairs_total += pairs_total;
    session.pairs_max_sum += pairs_max;
    for (key, ok) in attempts {
        session.whatif_attempted.insert(key);
        if !ok {
            session.whatif_failed.insert(key);
        } else {
            session.attempts_ok += 1;
            session.attempts_released += u32::from(released.contains(&key));
        }
    }
    let (after, moves) = now.branch_fixpoint();
    let (_, branch_total, branch_max) = after.placement();
    session.branch_moves += moves.len() as u32;
    session.branch_total += branch_total;
    session.branch_max_sum += branch_max;
    if attainable.cover == placed {
        session.branch_closed += total - branch_total;
    }

    // Stage 2 question.
    for (_, _, gain) in now.unmet_demand() {
        match gain {
            None => session.unmet_refused += 1,
            Some(g) => {
                session.unmet_deeper += 1;
                session.unmet_gain += g;
            }
        }
    }
    if !now.unmet_demand().is_empty() {
        session.unmet_instants += 1;
    }

    if options.all_pairs {
        let connectable = &script.connectable;
        let all = now
            .graph(&|a, b| connectable[a][b])
            .solve(incumbent, options.budget);
        session.all_cover += all.cover;
        session.all_total += all.total;
        session.all_exact += u32::from(all.exact);
        if all.cover == placed {
            session.all_gap += total.saturating_sub(all.total);
            session.pairs_closed += total - pairs_total;
            session.s1_closed_all += total - s1_total;
            session.kept_closed_all += total - kept_total;
        }
    }
}
