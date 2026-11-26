//! First-picture delay in timed sessions: from a viewer's subscription to the
//! first observation in which its selected input carries `decoded` proof, and
//! what a long wait was waiting on, read from the room's projection and from
//! the pairs in the endpoints' own state.

use super::driver::{Driver, Observation};
use piik_channel_core::wire::FlowState;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// A wait is classified once it has lasted this long.
pub const LONG_WAIT_MS: u64 = 5_000;

/// What a waiting viewer is waiting on at one moment, first match wins in
/// this order: its own flow; a free confirmed parent; its own pending pairs;
/// full confirmed parents; nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Class {
    /// An edge into the viewer exists (its own flow is being proved or its
    /// switch is pending).
    OwnFlow,
    /// It has a confirmed pair to a tree member with a free output, and a
    /// route operation for another receiver is in progress.
    OtherOperation,
    /// It has a confirmed pair to a tree member with a free output and no
    /// operation is in progress, yet it is not placed.
    Idle,
    /// Its direct pair to the sharer is pending and no other pair of the
    /// viewer is.
    DirectOnly,
    /// Another pair of the viewer is pending beside its pending direct pair.
    TrialBesideDirect,
    /// Another pair of the viewer is pending; its direct pair is not, and
    /// every confirmed pair it has into the tree ends at a full member
    /// (typically: direct pair confirmed, sharer full).
    TrialBehindFull,
    /// Another pair of the viewer is pending; its direct pair is not and it
    /// has no confirmed pair into the tree (direct failed, cooling down or
    /// not admitted).
    TrialAfterDirect,
    /// Confirmed pairs into the tree end only at full members and nothing of
    /// the viewer is pending.
    Capacity,
    /// No confirmed pair into the tree and nothing of the viewer pending.
    Nothing,
}

pub const CLASSES: [Class; 9] = [
    Class::DirectOnly,
    Class::TrialBesideDirect,
    Class::TrialBehindFull,
    Class::TrialAfterDirect,
    Class::OtherOperation,
    Class::Capacity,
    Class::OwnFlow,
    Class::Idle,
    Class::Nothing,
];

#[derive(Clone, Debug, Default)]
pub struct Wait {
    pub viewer: usize,
    pub since: u64,
    /// None if the viewer left or the session ended first.
    pub delay: Option<u64>,
    /// Its first input came straight from the sharer.
    pub from_sharer: bool,
    /// The class at the first observation at or after `LONG_WAIT_MS`.
    pub class: Option<Class>,
    /// Seconds spent in each class beyond `LONG_WAIT_MS`, sampled at the
    /// server's expiry ticks.
    pub seconds: BTreeMap<Class, u32>,
    /// Pairs of the viewer, other than its direct pair, that appeared while
    /// it waited and its direct pair was pending: (alternative, direct,
    /// how long the direct pair had been pending when it appeared).
    pub alternatives: Vec<(Uuid, Uuid, u64)>,
    /// Of those, how many had a direct pair that later confirmed.
    pub unnecessary: u32,
    /// Longest time one direct pair of this viewer was seen pending while it
    /// waited: the condition P1 acts on.
    pub direct_pending_ms: u64,
    /// At subscription its direct pair to the sharer was already confirmed
    /// (for example by the channel standby graph).
    pub direct_ready: bool,
    /// At the first observation at or after `LONG_WAIT_MS`: no confirmed
    /// pair into the tree.
    pub unlinked: bool,
    /// P3 and P4, at that observation: a second trial asked for and in
    /// flight (Some(true)), asked for but not in flight (Some(false)), or
    /// none asked (None).
    pub second_at5: Option<Option<bool>>,
    /// The same per sampled second beyond `LONG_WAIT_MS`: in flight, asked
    /// but not in flight, none asked.
    pub second_ticks: [u32; 3],
    /// A second trial was in flight at some observation of the wait.
    pub second_seen: bool,
    /// Failed pairs of the viewer, other than with the sharer, while it
    /// waited.
    pub trial_failures: u32,
    failures_before: u32,
}

#[derive(Default)]
pub struct Waits {
    open: BTreeMap<usize, Wait>,
    pub done: Vec<Wait>,
}

impl Waits {
    pub fn start(&mut self, driver: &Driver, viewer: usize) {
        let direct_ready = driver
            .net
            .state(driver.people[viewer].connection)
            .pairs
            .iter()
            .any(|pair| {
                pair.peer_id == driver.people[driver.source].session
                    && driver.pair_confirmed(viewer, driver.source, pair.id)
            });
        self.open.insert(
            viewer,
            Wait {
                viewer,
                since: driver.now,
                direct_ready,
                failures_before: driver.trial_failures[viewer],
                ..Wait::default()
            },
        );
    }

    /// Runs after every settled moment of the timed driver.
    pub fn step(&mut self, driver: &mut Driver) {
        if self.open.is_empty() {
            return;
        }
        let gone: Vec<_> = self
            .open
            .keys()
            .copied()
            .filter(|&v| !driver.online[v] || !driver.viewing[v])
            .collect();
        for v in gone {
            self.done.push(self.open.remove(&v).unwrap());
        }
        // Observe only where the authority already had input at this moment.
        if self.open.is_empty() || driver.touched != driver.now {
            return;
        }
        let now = driver.now;
        let observation = driver.observe();
        let source = driver.source;
        let viewers: Vec<_> = self.open.keys().copied().collect();
        for v in viewers {
            let picture = observation.edges.iter().find(|&&(_, r, selected, proof)| {
                r == v && selected && proof == Some(FlowState::Decoded)
            });
            let wait = self.open.get_mut(&v).unwrap();
            if let Some(&(sender, ..)) = picture {
                wait.delay = Some(now - wait.since);
                wait.from_sharer = sender == source;
                self.done.push(self.open.remove(&v).unwrap());
                continue;
            }
            let second = driver.second_trial(v);
            wait.second_seen |= second == Some(true);
            wait.trial_failures = driver.trial_failures[v] - wait.failures_before;
            let pending = driver.pending_pairs(v);
            if let Some(&(_, direct)) = pending.iter().find(|(peer, _)| *peer == source) {
                if let Some(&at) = driver.seen.get(&(v, direct)) {
                    wait.direct_pending_ms = wait.direct_pending_ms.max(now - at);
                }
                let direct_at = driver.seen.get(&(v, direct)).copied().unwrap_or(now);
                for &(peer, id) in &pending {
                    let Some(&at) = driver.seen.get(&(v, id)) else {
                        continue;
                    };
                    if peer != source
                        && at >= wait.since
                        && !wait.alternatives.iter().any(|(alt, ..)| *alt == id)
                    {
                        wait.alternatives
                            .push((id, direct, at.saturating_sub(direct_at)));
                    }
                }
            }
            let waited = now - wait.since;
            if waited >= LONG_WAIT_MS {
                let (class, unlinked) = classify(driver, &observation, v, &pending);
                if wait.class.is_none() {
                    wait.class = Some(class);
                    wait.unlinked = unlinked;
                    wait.second_at5 = Some(second);
                }
                if now % super::driver::EXPIRE_EVERY_MS == 0 && waited > LONG_WAIT_MS {
                    *wait.seconds.entry(class).or_default() += 1;
                    let state = match second {
                        Some(true) => 0,
                        Some(false) => 1,
                        None => 2,
                    };
                    wait.second_ticks[state] += 1;
                    if std::env::var_os("STUDY_WAIT_TRACE").is_some() {
                        let ages: Vec<_> = pending
                            .iter()
                            .map(|&(peer, id)| {
                                (peer, driver.seen.get(&(v, id)).map(|&at| now - at))
                            })
                            .collect();
                        let linked: Vec<_> = observation
                            .confirmed
                            .iter()
                            .filter(|&&(a, b)| a == v || b == v)
                            .map(|&(a, b)| if a == v { b } else { a })
                            .collect();
                        let operations: Vec<_> = observation
                            .edges
                            .iter()
                            .filter(|&&(_, _, selected, proof)| !selected || proof.is_none())
                            .collect();
                        println!(
                            "  t={now} viewer {v} waited {waited}: {class:?}; pending (peer, age) {ages:?}; confirmed with {linked:?}; tree {:?}; unproved edges {operations:?}",
                            observation.parent
                        );
                    }
                }
            }
        }
    }

    /// Closes open waits and settles which alternatives proved unnecessary.
    pub fn finish(mut self, driver: &Driver) -> Vec<Wait> {
        self.done
            .extend(std::mem::take(&mut self.open).into_values());
        let mut done = self.done;
        for wait in &mut done {
            wait.unnecessary = wait
                .alternatives
                .iter()
                .filter(|(_, direct, _)| driver.pair_confirmed(wait.viewer, driver.source, *direct))
                .count() as u32;
        }
        done
    }
}

fn classify(
    driver: &Driver,
    observation: &Observation,
    v: usize,
    pending: &[(usize, Uuid)],
) -> (Class, bool) {
    let source = driver.source;
    let tree: BTreeSet<usize> = observation.parent.keys().copied().chain([source]).collect();
    let mut children = BTreeMap::<usize, u32>::new();
    for &p in observation.parent.values() {
        *children.entry(p).or_default() += 1;
    }
    let limit = u32::from(driver.limit);
    let linked: Vec<usize> = tree
        .iter()
        .copied()
        .filter(|&p| observation.confirmed.contains(&(p.min(v), p.max(v))))
        .collect();
    let unlinked = linked.is_empty();
    if observation.edges.iter().any(|&(_, r, ..)| r == v) {
        return (Class::OwnFlow, unlinked);
    }
    if linked
        .iter()
        .any(|p| children.get(p).copied().unwrap_or(0) < limit)
    {
        let operation = observation
            .edges
            .iter()
            .any(|&(_, r, selected, proof)| r != v && (!selected || proof.is_none()));
        let class = if operation {
            Class::OtherOperation
        } else {
            Class::Idle
        };
        return (class, unlinked);
    }
    let direct = pending.iter().any(|(peer, _)| *peer == source);
    let other = pending.iter().any(|(peer, _)| *peer != source);
    let class = match (direct, other, unlinked) {
        (true, false, _) => Class::DirectOnly,
        (true, true, _) => Class::TrialBesideDirect,
        (false, true, false) => Class::TrialBehindFull,
        (false, true, true) => Class::TrialAfterDirect,
        (false, false, false) => Class::Capacity,
        (false, false, true) => Class::Nothing,
    };
    (class, unlinked)
}
