//! Timed sessions: first-picture delay under the present rule and policy P1,
//! with the tables the time-model report quotes.

use super::driver::{Timing, EXPIRE_EVERY_MS};
use super::model::{Connectivity, BASE, OPTIMISTIC, PESSIMISTIC};
use super::study::Options;
use super::waits::CLASSES;
use super::{budget, header, ratio, run_row, spread, Row};

fn env_ms(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn env_list(name: &str, default: &[u64]) -> Vec<u64> {
    std::env::var(name)
        .ok()
        .map(|s| s.split(',').map(|p| p.trim().parse().unwrap()).collect())
        .unwrap_or_else(|| default.to_vec())
}

/// Median, 90th percentile and maximum of pooled delays, in seconds.
fn delays(values: &mut [u64]) -> (String, String, String) {
    if values.is_empty() {
        return ("n/a".into(), "n/a".into(), "n/a".into());
    }
    values.sort_unstable();
    let at = |q: f64| values[((values.len() - 1) as f64 * q).round() as usize] as f64 / 1000.0;
    (
        format!("{:.1}", at(0.5)),
        format!("{:.1}", at(0.9)),
        format!("{:.1}", *values.last().unwrap() as f64 / 1000.0),
    )
}

pub struct TimedRow {
    pub model: Connectivity,
    pub failure_ms: u64,
    pub viewers: usize,
    pub policy: &'static str,
    /// "warm": viewers are in the channel from the start (the harness's
    /// shape); "cold": they enable peer transport only on arrival.
    pub arrival: &'static str,
    pub row: Row,
}

impl TimedRow {
    fn key(&self) -> String {
        format!(
            "| {} | {} | {} | {} | {} |",
            self.arrival,
            self.model.name,
            self.failure_ms / 1000,
            self.viewers,
            self.policy
        )
    }
    fn waits(&self) -> impl Iterator<Item = &super::waits::Wait> {
        self.row.sessions.iter().flat_map(|s| s.waits.iter())
    }
}

pub fn time_tables(rows: &[TimedRow]) {
    header(
        "First-picture delay per viewer arrival (subscription to a selected input with decoded proof), L = 2",
        &[
            "arrival",
            "setting",
            "F s",
            "N",
            "policy",
            "arrivals",
            "censored",
            "median s",
            "p90 s",
            "max s",
            "over 5 s %",
            "over 20 s %",
            "first input from the sharer %",
            "direct pair confirmed at subscription %",
            "direct pair pending >= 1 s / >= 2 s while waiting %",
        ],
    );
    for r in rows {
        let arrivals = r.waits().count();
        let mut resolved: Vec<u64> = r.waits().filter_map(|w| w.delay).collect();
        let n = resolved.len().max(1) as f64;
        let over = |limit: u64| 100.0 * resolved.iter().filter(|&&d| d > limit).count() as f64 / n;
        let (over5, over20) = (over(5_000), over(20_000));
        let sharer = 100.0
            * r.waits()
                .filter(|w| w.delay.is_some() && w.from_sharer)
                .count() as f64
            / n;
        let censored = arrivals - resolved.len();
        let share = |f: &dyn Fn(&super::waits::Wait) -> bool| {
            100.0 * r.waits().filter(|w| f(w)).count() as f64 / arrivals.max(1) as f64
        };
        let ready = share(&|w| w.direct_ready);
        let pend1 = share(&|w| w.direct_pending_ms >= 1_000);
        let pend2 = share(&|w| w.direct_pending_ms >= 2_000);
        let (median, p90, max) = delays(&mut resolved);
        println!(
            "{} {arrivals} | {censored} | {median} | {p90} | {max} | {over5:.1} | {over20:.1} | {sharer:.0} | {ready:.0} | {pend1:.1} / {pend2:.1} |",
            r.key()
        );
    }

    let names: Vec<String> = CLASSES.iter().map(|c| format!("{c:?}")).collect();
    let mut columns = vec!["arrival", "setting", "F s", "N", "policy", "waits over 5 s"];
    columns.extend(names.iter().map(String::as_str));
    header(
        "What waits longer than 5 s were waiting on: % of those waits by class at the 5 s mark [% of their waiting seconds beyond 5 s]",
        &columns,
    );
    for r in rows {
        let long: Vec<_> = r.waits().filter(|w| w.class.is_some()).collect();
        let n = long.len().max(1) as f64;
        let seconds: u32 = long.iter().flat_map(|w| w.seconds.values()).sum();
        let cells: Vec<String> = CLASSES
            .iter()
            .map(|c| {
                let at5 = long.iter().filter(|w| w.class == Some(*c)).count() as f64;
                let secs: u32 = long.iter().filter_map(|w| w.seconds.get(c)).sum();
                format!(
                    "{:.0} [{:.0}]",
                    100.0 * at5 / n,
                    100.0 * f64::from(secs) / f64::from(seconds.max(1))
                )
            })
            .collect();
        println!("{} {} | {} |", r.key(), long.len(), cells.join(" | "));
    }

    println!(
        "
### Longest waits per row (seed, viewer, subscribed at ms, delay s, class at 5 s)
"
    );
    for r in rows {
        let mut all: Vec<_> = r
            .row
            .sessions
            .iter()
            .flat_map(|s| s.waits.iter().map(move |w| (s.seed, w)))
            .filter(|(_, w)| w.class.is_some())
            .collect();
        all.sort_by_key(|(_, w)| std::cmp::Reverse(w.delay.unwrap_or(u64::MAX)));
        let top: Vec<String> = all
            .iter()
            .take(3)
            .map(|(seed, w)| {
                format!(
                    "({seed}, {}, {}, {}, {:?})",
                    w.viewer,
                    w.since,
                    w.delay
                        .map_or("open".into(), |d| format!("{:.1}", d as f64 / 1000.0)),
                    w.class.unwrap()
                )
            })
            .collect();
        println!("- {} {}", r.key(), top.join(" "));
    }
    header(
        "Attempts and depth",
        &[
            "arrival",
            "setting",
            "F s",
            "N",
            "policy",
            "pairs started per session",
            "viewer pairs started beside its pending direct pair (all seeds)",
            "of those, started with the direct pair / after under 1 s / after 1 s or more",
            "of which the direct pair then confirmed",
            "mean depth planner",
            "max depth planner",
            "summed depth, all instants and seeds",
            "excess hops over the confirmed optimum (all seeds)",
            "unplaced % of viewer-instants",
            "harness: errors / unsettled / early observations",
        ],
    );
    for r in rows {
        let row = &r.row;
        let alternatives: usize = r.waits().map(|w| w.alternatives.len()).sum();
        let unnecessary: u32 = r.waits().map(|w| w.unnecessary).sum();
        let lag = |f: &dyn Fn(u64) -> bool| {
            r.waits()
                .flat_map(|w| w.alternatives.iter())
                .filter(|(_, _, lag)| f(*lag))
                .count()
        };
        let lags = format!(
            "{} / {} / {}",
            lag(&|l| l == 0),
            lag(&|l| l > 0 && l < 1_000),
            lag(&|l| l >= 1_000)
        );
        println!(
            "{} {} | {alternatives} | {lags} | {unnecessary} | {} | {} | {} | {} | {:.1} | {} / {} / {} |",
            r.key(),
            spread(row.per(|s| f64::from(s.pairs_started)), 0),
            spread(row.per(|s| ratio(s.total, s.placed)), 2),
            spread(row.per(|s| ratio(s.max_sum, s.instants)), 2),
            row.sum(|s| s.total),
            row.sum(|s| s.depth_gap),
            100.0
                * ratio(
                    row.sum(|s| s.viewer_instants - s.placed),
                    row.sum(|s| s.viewer_instants)
                ),
            row.sum(|s| s.errors),
            row.sum(|s| s.unsettled),
            row.sum(|s| s.early_observations),
        );
    }
}

/// Endpoint answers take time: first-picture delay under the present rule
/// and, with `--features sqlite,study`, policy P1 (race one alternative once
/// Timed sessions replay identically from their seed: trees at every
/// observation and every arrival's delay.
#[test]
#[ignore = "study: timed determinism"]
fn timed_runs_are_deterministic() {
    use super::model::Script;
    for (model, cold) in [(PESSIMISTIC, false), (BASE, true)] {
        for index in 0..8 {
            let script = Script::draw(super::seed_of(&model, 16, index), 16, &model);
            let options = Options {
                limit: 2,
                budget: 1_000,
                all_pairs: false,
                execute_stage1: false,
                verbose: false,
                timing: Some(Timing {
                    success_ms: 500,
                    failure_ms: 20_000,
                    proof_ms: 500,
                }),
                race_ms: cfg!(feature = "study").then_some(1_000),
                cold,
            };
            let first = super::study::run(&script, options);
            let second = super::study::run(&script, options);
            if let Some(i) = (0..first.log.len().min(second.log.len()))
                .find(|&i| first.log[i] != second.log[i])
            {
                let from = i.saturating_sub(8);
                panic!(
                    "seed {} diverges at answer {i}:
{:#?}
vs
{:#?}",
                    script.seed,
                    &first.log[from..(i + 3).min(first.log.len())],
                    &second.log[from..(i + 3).min(second.log.len())]
                );
            }
            let delays = |s: &super::study::Session| -> Vec<_> {
                s.waits.iter().map(|w| (w.viewer, w.delay)).collect()
            };
            assert_eq!(delays(&first), delays(&second), "seed {}", script.seed);
            assert_eq!(first.trace, second.trace, "seed {}", script.seed);
        }
    }
    println!("sixteen timed sessions replayed identically");
}

/// Endpoint answers take time: first-picture delay under the present rule
/// and, with `--features sqlite,study`, policy P1 (race one alternative once
/// the direct pair has been pending H = 1 s or 2 s). `STUDY_SUCCESS_MS` and
/// `STUDY_PROOF_MS` (default 500) set the success and proof times,
/// `STUDY_FAILURES_MS` the failure times (default `5000,20000`),
/// `STUDY_SIZES` the viewer counts (default `8,16,32`), `STUDY_MODELS` the
/// settings (default all three), `STUDY_THREADS` the rows run in parallel
/// (default 4). Seeds as elsewhere (`STUDY_SCALE`, `STUDY_SEEDS`).
#[test]
#[ignore = "study: time model, long"]
fn time_model() {
    let success_ms = env_ms("STUDY_SUCCESS_MS", 500);
    let proof_ms = env_ms("STUDY_PROOF_MS", 500);
    let failures = env_list("STUDY_FAILURES_MS", &[5_000, 20_000]);
    let sizes = env_list("STUDY_SIZES", &[8, 16, 32]);
    let threads = env_ms("STUDY_THREADS", 4).max(1) as usize;
    let wanted = std::env::var("STUDY_MODELS").unwrap_or_default();
    let models: Vec<_> = [PESSIMISTIC, BASE, OPTIMISTIC]
        .into_iter()
        .filter(|m| wanted.is_empty() || wanted.split(',').any(|w| w == m.name))
        .collect();
    let mut policies: Vec<(&'static str, Option<u64>)> = vec![("present", None)];
    if cfg!(feature = "study") {
        policies.push(("P1 H=1s", Some(1_000)));
        policies.push(("P1 H=2s", Some(2_000)));
    }
    println!(
        "time model: success {success_ms} ms, proof {proof_ms} ms, failures {failures:?} ms, expiry every {EXPIRE_EVERY_MS} ms"
    );
    let arrivals: Vec<&'static str> = match std::env::var("STUDY_ARRIVALS").as_deref() {
        Ok("warm") => vec!["warm"],
        Ok("cold") => vec!["cold"],
        _ => vec!["warm", "cold"],
    };
    let mut jobs = Vec::new();
    for &arrival in &arrivals {
        for &model in &models {
            for &failure_ms in &failures {
                for &viewers in &sizes {
                    for &(policy, race_ms) in &policies {
                        jobs.push((
                            arrival,
                            model,
                            failure_ms,
                            viewers as usize,
                            policy,
                            race_ms,
                        ));
                    }
                }
            }
        }
    }
    let started = std::time::Instant::now();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let Some(&(arrival, model, failure_ms, viewers, policy, race_ms)) = jobs.get(i)
                else {
                    return;
                };
                let options = Options {
                    limit: 2,
                    budget: budget(viewers),
                    all_pairs: false,
                    execute_stage1: false,
                    verbose: false,
                    timing: Some(Timing {
                        success_ms,
                        failure_ms,
                        proof_ms,
                    }),
                    race_ms,
                    cold: arrival == "cold",
                };
                let row = run_row(&model, viewers, options);
                eprintln!(
                    "{arrival} {} F={failure_ms} N={viewers} {policy} done at {:?}",
                    model.name,
                    started.elapsed()
                );
                results.lock().unwrap().push((
                    i,
                    TimedRow {
                        model,
                        failure_ms,
                        viewers,
                        policy,
                        arrival,
                        row,
                    },
                ));
            });
        }
    });
    let mut rows = results.into_inner().unwrap();
    rows.sort_by_key(|(i, _)| *i);
    let rows: Vec<_> = rows.into_iter().map(|(_, r)| r).collect();
    time_tables(&rows);
}
