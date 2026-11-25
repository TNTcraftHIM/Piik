use crate::wire::{FlowBinding, FlowState, PairInfo, UdpPreparation};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Interest {
    Recovering,
    Channel,
    Room,
    Activity,
    Delivery,
}

/// Distinct pending or established peer connections per ordinary endpoint.
pub(crate) const PAIR_DEGREE_LIMIT: usize = 64;

const CHANNEL_ATTEMPT_LIMIT: usize = 4;
const ENDPOINT_ATTEMPT_LIMIT: usize = 2;
type PairKey = (Uuid, Uuid);

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum DiscoveryRank {
    Restoration,
    Completion,
    Activity,
    Room,
    Channel,
}

const DISCOVERY_TIMEOUT_MS: u64 = 20_000;
const REQUIRED_RETRY_MS: u64 = 5_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub id: Uuid,
    pub publication_id: Uuid,
    pub input_flow_id: Option<Uuid>,
    pub sender: Uuid,
    pub receiver: Uuid,
    pub selected: bool,
    // Refreshed from the room plan when projecting leases, never inferred by transport.
    pub proof: Option<FlowState>,
    pub presented: Option<bool>,
    pub presentation: bool,
}

#[derive(Clone, Default)]
struct Directions {
    forward: BTreeMap<Uuid, FlowBinding>,
    reverse: BTreeMap<Uuid, FlowBinding>,
    rooms: BTreeSet<String>,
}

impl Directions {
    fn has_lease(&self) -> bool {
        !(self.forward.is_empty() && self.reverse.is_empty() && self.rooms.is_empty())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Attempt {
    Ordinary,
    Prepared,
}

#[derive(Clone)]
struct Pair {
    id: Uuid,
    flows: Directions,
    interest: Interest,
    attempt: Attempt,
    confirmed_by: [Option<Uuid>; 2],
    disconnected_by: [Option<Uuid>; 2],
    was_confirmed: bool,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct DiscoveryEdge {
    pub endpoints: (Uuid, Uuid),
    pub sockets: (Uuid, Uuid),
}

impl DiscoveryEdge {
    pub(crate) fn current(
        endpoints: (Uuid, Uuid),
        identity: &crate::identity::Identity,
    ) -> Option<Self> {
        let socket = |id| {
            identity
                .sessions
                .get(&id)
                .and_then(|session| session.connection)
        };
        Some(Self {
            endpoints,
            sockets: (socket(endpoints.0)?, socket(endpoints.1)?),
        })
    }
}

#[derive(Clone)]
struct Pending {
    edge: DiscoveryEdge,
    deadline: u64,
    restoring: bool,
}

#[derive(Clone)]
struct Failure {
    retry_after: u64,
    was_confirmed: bool,
}

/// Current physical attempts shared by flow, room and standby interests.
#[derive(Clone, Default)]
pub struct TransportBook {
    discovery: BTreeMap<PairKey, Pending>,
    // Keep failures while the same demand and socket generations justify them.
    rejected: BTreeMap<DiscoveryEdge, Failure>,
    next_required_retry: Option<u64>,
    pairs: BTreeMap<PairKey, Pair>,
    /// Study P1 only: the channel clock of the current reconcile, and the
    /// last expiry check that looked for head starts ending.
    #[cfg(feature = "study")]
    pub(crate) study_now: u64,
    #[cfg(feature = "study")]
    race_checked: u64,
}

impl TransportBook {
    /// Study P1 only: a pending attempt on this edge has had its head start.
    #[cfg(feature = "study")]
    pub(crate) fn raced(&self, edge: &DiscoveryEdge) -> bool {
        crate::study::race_direct_after().is_some_and(|head| {
            self.discovery.get(&edge.endpoints).is_some_and(|pending| {
                pending.edge == *edge
                    && pending.deadline - DISCOVERY_TIMEOUT_MS + head <= self.study_now
            })
        })
    }

    pub(crate) fn pending(&self, edge: &DiscoveryEdge) -> bool {
        self.discovery
            .get(&edge.endpoints)
            .is_some_and(|pending| pending.edge == *edge)
    }

    pub(crate) fn pending_edges(&self) -> impl Iterator<Item = &DiscoveryEdge> {
        self.discovery.values().map(|pending| &pending.edge)
    }

    pub(crate) fn failures(&self) -> impl Iterator<Item = &DiscoveryEdge> {
        self.rejected.keys()
    }
    pub(crate) fn retain_failures(&mut self, needed: &BTreeSet<DiscoveryEdge>) {
        self.rejected.retain(|edge, _| needed.contains(edge));
    }

    pub(crate) fn rejected(&self, edge: &DiscoveryEdge) -> bool {
        self.rejected.contains_key(edge)
    }

    pub(crate) fn retry_after(&self, edge: &DiscoveryEdge) -> Option<u64> {
        self.rejected.get(edge).map(|failure| failure.retry_after)
    }

    pub(crate) fn previously_confirmed(&self, edge: &DiscoveryEdge) -> bool {
        self.rejected
            .get(edge)
            .is_some_and(|failure| failure.was_confirmed)
            || self
                .discovery
                .get(&edge.endpoints)
                .is_some_and(|pending| pending.edge == *edge && pending.restoring)
    }

    pub(crate) fn has_pair(&self, endpoints: (Uuid, Uuid)) -> bool {
        self.pairs.contains_key(&endpoints)
    }

    pub(crate) fn admitted_pairs(&self) -> impl Iterator<Item = (Uuid, Uuid)> + '_ {
        self.pairs.keys().copied()
    }

    /// Keep a proven transport available to its sessions while signaling is recovering.
    pub(crate) fn recovering_pairs(
        &self,
        identity: &crate::identity::Identity,
    ) -> BTreeSet<(Uuid, Uuid)> {
        self.pairs
            .iter()
            .filter_map(|(&key @ (a, b), pair)| {
                let first = identity.sessions.get(&a)?;
                let second = identity.sessions.get(&b)?;
                if !first.can_use_peer_transport || !second.can_use_peer_transport {
                    return None;
                }
                let sockets = [first.connection, second.connection];
                (pair.was_confirmed && (sockets.contains(&None) || sockets != pair.confirmed_by))
                    .then_some(key)
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn reconcile_with_standby(
        &mut self,
        flows: impl IntoIterator<Item = Flow>,
        room_grants: impl IntoIterator<Item = ((Uuid, Uuid), String)>,
        interests: &BTreeMap<DiscoveryEdge, Interest>,
        completions: &[(DiscoveryEdge, BTreeSet<(Uuid, Uuid)>)],
        required_retries: &BTreeSet<DiscoveryEdge>,
        recovering: &BTreeSet<(Uuid, Uuid)>,
        now: u64,
        degree_limit: impl Fn(Uuid) -> usize,
    ) {
        self.reconcile_with_fallback(
            flows,
            room_grants,
            interests,
            completions,
            required_retries,
            recovering,
            now,
            degree_limit,
            |_, _| {},
        );
    }

    pub(crate) fn reconcile_with_fallback(
        &mut self,
        flows: impl IntoIterator<Item = Flow>,
        room_grants: impl IntoIterator<Item = ((Uuid, Uuid), String)>,
        interests: &BTreeMap<DiscoveryEdge, Interest>,
        completions: &[(DiscoveryEdge, BTreeSet<(Uuid, Uuid)>)],
        required_retries: &BTreeSet<DiscoveryEdge>,
        recovering: &BTreeSet<(Uuid, Uuid)>,
        now: u64,
        degree_limit: impl Fn(Uuid) -> usize,
        alternatives: impl FnOnce(&mut Self, &mut BTreeSet<PairKey>),
    ) {
        let mut needed = BTreeMap::<_, Directions>::new();
        for flow in flows {
            let (key, forward) = if flow.sender < flow.receiver {
                ((flow.sender, flow.receiver), true)
            } else {
                ((flow.receiver, flow.sender), false)
            };
            let directions = needed.entry(key).or_default();
            if forward {
                &mut directions.forward
            } else {
                &mut directions.reverse
            }
            .insert(
                flow.id,
                FlowBinding {
                    id: flow.id,
                    publication_id: flow.publication_id,
                    input_flow_id: flow.input_flow_id,
                    selected: flow.selected,
                    presentation: flow.presentation,
                },
            );
        }
        for (pair, room) in room_grants {
            needed.entry(pair).or_default().rooms.insert(room);
        }
        self.next_required_retry = required_retries
            .iter()
            .filter_map(|edge| self.retry_after(edge))
            .filter(|&deadline| deadline > now)
            .min();
        let requests: BTreeMap<_, _> = interests
            .iter()
            .filter(|(edge, _)| {
                self.retry_after(edge)
                    .is_none_or(|at| at <= now && required_retries.contains(edge))
            })
            .map(|(edge, &interest)| (edge.endpoints, (edge, interest)))
            .collect();
        self.pairs.retain(|key, pair| {
            if let Some(flows) = needed.remove(key) {
                pair.flows = flows;
                pair.interest = Interest::Activity;
                return true;
            }
            pair.flows = Directions::default();
            if let Some(&(edge, interest)) = requests.get(key) {
                if pair.confirmed_by == [Some(edge.sockets.0), Some(edge.sockets.1)]
                    || self
                        .discovery
                        .get(key)
                        .is_some_and(|pending| pending.edge == *edge)
                {
                    pair.interest = interest;
                    return true;
                }
            }
            pair.interest = Interest::Recovering;
            recovering.contains(key)
        });
        self.discovery.retain(|key, pending| {
            self.pairs.contains_key(key)
                && requests
                    .get(key)
                    .is_some_and(|(edge, _)| **edge == pending.edge)
        });
        // An activity can leave a pair with only standby interest.
        let mut standby: Vec<_> = self
            .discovery
            .keys()
            .filter_map(|&key| {
                let interest = self.pairs[&key].interest;
                (interest <= Interest::Room).then_some((Reverse(interest), key))
            })
            .collect();
        standby.sort_unstable();
        for (_, key) in standby.into_iter().skip(1) {
            self.release(key);
        }

        self.trim_standby(&degree_limit);
        let mut prefixes = BTreeMap::<_, Vec<_>>::new();
        for (edge, prefix) in completions {
            prefixes.entry(edge).or_default().push(prefix);
        }
        let ready_prefixes = |book: &Self, edge: &DiscoveryEdge| {
            prefixes
                .get(edge)
                .into_iter()
                .flatten()
                .copied()
                .filter(|prefix| {
                    prefix.iter().all(|key| {
                        let Some((edge, _)) = requests.get(key) else {
                            return false;
                        };
                        book.pairs.get(key).is_some_and(|p| {
                            p.confirmed_by == [Some(edge.sockets.0), Some(edge.sockets.1)]
                        })
                    })
                })
                .collect::<Vec<_>>()
        };

        // Protect all ready prefixes of each in-flight attempt, including
        // multiple room requests that share a physical attempt.
        let mut protected = BTreeSet::new();
        for (&key, pending) in &self.discovery {
            if pending.restoring && required_retries.contains(&pending.edge) {
                protected.insert(key);
            }
            for prefix in ready_prefixes(self, &pending.edge) {
                protected.insert(key);
                protected.extend(prefix);
            }
        }
        for (key, flows) in needed {
            self.admit(
                key,
                Interest::Activity,
                flows,
                None,
                &protected,
                &degree_limit,
            );
        }

        let mut candidates = Vec::new();
        for &(edge, interest) in requests.values() {
            let rank = match interest {
                Interest::Activity
                    if required_retries.contains(edge) && self.previously_confirmed(edge) =>
                {
                    DiscoveryRank::Restoration
                }
                Interest::Activity if prefixes.contains_key(edge) => DiscoveryRank::Completion,
                Interest::Activity => DiscoveryRank::Activity,
                Interest::Room => DiscoveryRank::Room,
                Interest::Channel => DiscoveryRank::Channel,
                _ => continue,
            };
            candidates.push((rank, self.retry_after(edge), edge, interest));
        }
        // Requests enter in pair order. Keep that order within ties.
        candidates.sort_by_key(|&(rank, retry, _, _)| (rank, retry));
        let mut alternatives = Some(alternatives);
        for (rank, _, edge, interest) in candidates {
            if rank > DiscoveryRank::Completion {
                if let Some(complete) = alternatives.take() {
                    complete(self, &mut protected);
                }
            }
            if self.has_pair(edge.endpoints) {
                continue;
            }
            let ready = ready_prefixes(self, edge);
            let completes = !ready.is_empty();
            if prefixes.contains_key(edge) && !completes {
                continue;
            }
            let empty = BTreeSet::new();
            let admitted = ready
                .into_iter()
                .chain((!completes).then_some(&empty))
                .any(|prefix| {
                    let mut reserved = protected.clone();
                    reserved.extend(prefix);
                    self.admit(
                        edge.endpoints,
                        interest,
                        Directions::default(),
                        Some((rank, completes)),
                        &reserved,
                        &degree_limit,
                    )
                });
            if admitted {
                self.start_discovery(edge, now);
                if completes || rank == DiscoveryRank::Restoration {
                    protected.insert(edge.endpoints);
                    protected.extend(ready_prefixes(self, edge).into_iter().flatten().copied());
                }
            }
        }
        if let Some(complete) = alternatives {
            complete(self, &mut protected);
        }
    }

    fn start_discovery(&mut self, edge: &DiscoveryEdge, now: u64) {
        self.discovery.insert(
            edge.endpoints,
            Pending {
                edge: edge.clone(),
                deadline: now.saturating_add(DISCOVERY_TIMEOUT_MS),
                restoring: self
                    .rejected
                    .remove(edge)
                    .is_some_and(|failure| failure.was_confirmed),
            },
        );
    }

    pub(crate) fn try_completion(
        &mut self,
        edge: &DiscoveryEdge,
        prefix: &BTreeSet<PairKey>,
        protected: &mut BTreeSet<PairKey>,
        now: u64,
        degree_limit: &impl Fn(Uuid) -> usize,
    ) -> bool {
        if let Some(deadline) = self.retry_after(edge).filter(|&deadline| deadline > now) {
            self.next_required_retry = Some(
                self.next_required_retry
                    .map_or(deadline, |old| old.min(deadline)),
            );
            return false;
        }
        if !self.pending(edge) {
            if self.has_pair(edge.endpoints) {
                return false;
            }
            let mut reserved = protected.clone();
            reserved.extend(prefix);
            let rank = if self.previously_confirmed(edge) {
                DiscoveryRank::Restoration
            } else {
                DiscoveryRank::Completion
            };
            if !self.admit(
                edge.endpoints,
                Interest::Activity,
                Directions::default(),
                Some((rank, true)),
                &reserved,
                degree_limit,
            ) {
                return false;
            }
            self.start_discovery(edge, now);
        }
        if let Some(pair) = self.pairs.get_mut(&edge.endpoints) {
            pair.interest = pair.interest.max(Interest::Activity);
        }
        protected.insert(edge.endpoints);
        protected.extend(prefix);
        true
    }

    pub(crate) fn only_pending_completions(&self, protected: &BTreeSet<PairKey>) -> bool {
        self.discovery.len() == CHANNEL_ATTEMPT_LIMIT
            && self.discovery.keys().all(|key| protected.contains(key))
    }

    pub(crate) fn finish_completions(
        &mut self,
        temporary: &BTreeSet<PairKey>,
        protected: &BTreeSet<PairKey>,
    ) {
        for &key in temporary {
            if protected.contains(&key) {
                if let Some(pair) = self.pairs.get_mut(&key) {
                    pair.interest = pair.interest.max(Interest::Activity);
                }
            } else if self
                .pairs
                .get(&key)
                .is_some_and(|p| p.interest == Interest::Recovering && !p.flows.has_lease())
            {
                self.release(key);
            }
        }
    }

    // A service can lose its larger allowance while its room leases are still live.
    fn trim_standby(&mut self, limit: &impl Fn(Uuid) -> usize) {
        let mut degree = BTreeMap::<_, usize>::new();
        for &(a, b) in self.pairs.keys() {
            *degree.entry(a).or_default() += 1;
            *degree.entry(b).or_default() += 1;
        }
        if degree.iter().all(|(&id, &count)| count <= limit(id)) {
            return;
        }
        let mut idle: Vec<_> = self
            .pairs
            .iter()
            .filter(|(_, pair)| !pair.flows.has_lease() && pair.interest != Interest::Delivery)
            .map(|(&key, pair)| (pair.interest, key))
            .collect();
        idle.sort_unstable();
        for (_, (a, b)) in idle {
            if degree[&a] > limit(a) || degree[&b] > limit(b) {
                self.release((a, b));
                *degree.get_mut(&a).unwrap() -= 1;
                *degree.get_mut(&b).unwrap() -= 1;
            }
        }
    }

    fn release(&mut self, key: PairKey) {
        self.pairs.remove(&key);
        self.discovery.remove(&key);
    }

    // Reserve all required capacity before releasing either endpoint's resources.
    fn admit(
        &mut self,
        key: PairKey,
        priority: Interest,
        flows: Directions,
        discovery: Option<(DiscoveryRank, bool)>,
        protected: &BTreeSet<PairKey>,
        degree_limit: &impl Fn(Uuid) -> usize,
    ) -> bool {
        let replace_partial = discovery.is_none_or(|(_, completes)| completes);
        let replace_pending = discovery.is_none_or(|(rank, _)| rank <= DiscoveryRank::Completion);
        let channel_full = discovery.is_some() && self.discovery.len() == CHANNEL_ATTEMPT_LIMIT;
        let reclaimable = |key: &PairKey, pair: &Pair| {
            let replace_activity = if self.discovery.contains_key(key) {
                replace_pending
            } else {
                replace_partial
            };
            !protected.contains(key)
                && !pair.flows.has_lease()
                && (pair.interest < priority
                    || (replace_activity && pair.interest == Interest::Activity))
        };
        let mut reclaimable_trials: Vec<_> = self
            .discovery
            .keys()
            .filter_map(|&key| {
                let pair = &self.pairs[&key];
                reclaimable(&key, pair).then_some((pair.interest, key))
            })
            .collect();
        reclaimable_trials.sort_unstable();
        if channel_full && reclaimable_trials.is_empty() {
            return false;
        }

        let mut victims = BTreeSet::new();
        if discovery.is_some() && priority <= Interest::Room {
            if let Some(&standby) = self
                .discovery
                .keys()
                .find(|key| self.pairs[key].interest <= Interest::Room)
            {
                if !reclaimable(&standby, &self.pairs[&standby]) {
                    return false;
                }
                victims.insert(standby);
            }
        }
        let incident = |key: PairKey, endpoint| key.0 == endpoint || key.1 == endpoint;
        if discovery.is_some() {
            for endpoint in [key.0, key.1] {
                let occupied = self
                    .discovery
                    .keys()
                    .filter(|&&key| incident(key, endpoint) && !victims.contains(&key))
                    .count();
                if occupied >= ENDPOINT_ATTEMPT_LIMIT {
                    let Some(&(_, victim)) = reclaimable_trials
                        .iter()
                        .find(|(_, key)| incident(*key, endpoint) && !victims.contains(key))
                    else {
                        return false;
                    };
                    victims.insert(victim);
                }
            }
        }
        for endpoint in [key.0, key.1] {
            let incident = self
                .pairs
                .iter()
                .filter(|(&key, _)| incident(key, endpoint) && !victims.contains(&key));
            let needed = (incident.clone().count() + 1).saturating_sub(degree_limit(endpoint));
            if needed == 0 {
                continue;
            }
            let needs_trial_slot =
                channel_full && !victims.iter().any(|key| self.discovery.contains_key(key));
            let mut available: Vec<_> = incident
                .filter_map(|(&key, pair)| {
                    let no_trial = !self.discovery.contains_key(&key);
                    reclaimable(&key, pair).then_some((
                        needs_trial_slot && no_trial,
                        pair.interest,
                        no_trial,
                        key,
                    ))
                })
                .collect();
            if available.len() < needed {
                return false;
            }
            available.sort_unstable();
            victims.extend(available.into_iter().take(needed).map(|(_, _, _, key)| key));
        }
        if channel_full && !victims.iter().any(|key| self.discovery.contains_key(key)) {
            let Some(&(_, victim)) = reclaimable_trials.first() else {
                return false;
            };
            victims.insert(victim);
        }
        for victim in victims {
            self.release(victim);
        }
        self.pairs.insert(
            key,
            Pair {
                id: Uuid::new_v4(),
                flows,
                interest: priority,
                attempt: Attempt::Ordinary,
                confirmed_by: [None; 2],
                disconnected_by: [None; 2],
                was_confirmed: false,
            },
        );
        true
    }

    pub fn peer(&self, endpoint: Uuid, id: Uuid) -> Option<Uuid> {
        self.pairs.iter().find_map(|((first, second), pair)| {
            if pair.id != id {
                None
            } else if *first == endpoint {
                Some(*second)
            } else if *second == endpoint {
                Some(*first)
            } else {
                None
            }
        })
    }

    pub fn flow(&self, id: Uuid, flow_id: Uuid) -> Option<Flow> {
        self.pairs.iter().find_map(|((first, second), pair)| {
            if pair.id != id {
                return None;
            }
            let (sender, receiver, binding) =
                if let Some(binding) = pair.flows.forward.get(&flow_id) {
                    (*first, *second, *binding)
                } else {
                    (*second, *first, *pair.flows.reverse.get(&flow_id)?)
                };
            Some(Flow {
                id: flow_id,
                publication_id: binding.publication_id,
                input_flow_id: binding.input_flow_id,
                sender,
                receiver,
                selected: binding.selected,
                proof: None,
                presented: None,
                presentation: binding.presentation,
            })
        })
    }

    pub fn serves_room(&self, id: Uuid, room: &str) -> bool {
        self.pairs
            .values()
            .any(|pair| pair.id == id && pair.flows.rooms.contains(room))
    }

    /// Records a temporary disconnection from the caller's authenticated socket.
    pub(crate) fn observe_disconnected(
        &mut self,
        endpoint: Uuid,
        socket: Uuid,
        id: Uuid,
        disconnected: bool,
    ) -> bool {
        let Some((&(a, b), pair)) = self.pairs.iter_mut().find(|(_, p)| p.id == id) else {
            return false;
        };
        let side = if a == endpoint {
            0
        } else if b == endpoint {
            1
        } else {
            return false;
        };
        let value = disconnected.then_some(socket);
        std::mem::replace(&mut pair.disconnected_by[side], value) != value
    }

    /// A new socket report may complete the evidence for this pair.
    pub fn connected(
        &mut self,
        endpoint: Uuid,
        connection: Uuid,
        peer_connection: Option<Uuid>,
        id: Uuid,
    ) -> bool {
        let Some(((first, second), pair)) = self.pairs.iter_mut().find(|(_, pair)| pair.id == id)
        else {
            return false;
        };
        let side = if *first == endpoint {
            0
        } else if *second == endpoint {
            1
        } else {
            return false;
        };
        if pair.confirmed_by[side] == Some(connection) {
            return false;
        }
        pair.confirmed_by[side] = Some(connection);
        let confirmed = peer_connection.is_some() && pair.confirmed_by[1 - side] == peer_connection;
        pair.was_confirmed |= confirmed;
        if confirmed {
            self.discovery.remove(&(*first, *second));
        }
        confirmed
    }

    pub(crate) fn disconnected_pairs<'a>(
        &'a self,
        identity: &'a crate::identity::Identity,
    ) -> impl Iterator<Item = (Uuid, Uuid)> + 'a {
        self.pairs.iter().flat_map(move |(&(a, b), p)| {
            [(a, b, p.disconnected_by[0]), (b, a, p.disconnected_by[1])]
                .into_iter()
                .filter_map(move |(from, to, socket)| {
                    (socket.is_some()
                        && identity.sessions.get(&from).and_then(|s| s.connection) == socket)
                        .then_some((from, to))
                })
        })
    }
    pub(crate) fn confirmed_pairs<'a>(
        &'a self,
        identity: &'a crate::identity::Identity,
    ) -> impl Iterator<Item = (Uuid, Uuid)> + 'a {
        self.pairs.iter().filter_map(|(&(a, b), pair)| {
            let sockets = [
                identity.sessions.get(&a)?.connection?,
                identity.sessions.get(&b)?.connection?,
            ];
            (pair.confirmed_by == sockets.map(Some)).then_some((a, b))
        })
    }

    // The caller authorizes both current online capabilities. Only this book
    // replaces a physical attempt; logical leases and their deadlines stay put.
    pub fn prepare(&mut self, id: Uuid, now: u64) -> bool {
        let Some((key, pair)) = self.pairs.iter_mut().find(|(_, pair)| pair.id == id) else {
            return false;
        };
        if pair.attempt != Attempt::Ordinary || pair.confirmed_by != [None; 2] {
            return false;
        }
        pair.id = Uuid::new_v4();
        pair.disconnected_by = [None; 2];
        pair.attempt = Attempt::Prepared;
        if let Some(pending) = self.discovery.get_mut(key) {
            pending.deadline = now.saturating_add(DISCOVERY_TIMEOUT_MS);
        }
        true
    }

    pub(crate) fn expire_discovery(&mut self, now: u64) -> bool {
        let retry_due = self.next_required_retry.take_if(|at| *at <= now).is_some();
        // Study P1 only: wake a reconcile when a pending attempt's head start ends.
        #[cfg(feature = "study")]
        let retry_due = retry_due
            || crate::study::race_direct_after().is_some_and(|head| {
                let checked = std::mem::replace(&mut self.race_checked, now);
                self.discovery.values().any(|pending| {
                    let at = pending.deadline - DISCOVERY_TIMEOUT_MS + head;
                    checked < at && at <= now
                })
            });
        let pending_before = self.discovery.len();
        self.discovery.retain(|key, pending| {
            if pending.deadline > now {
                return true;
            }
            self.pairs.remove(key);
            self.rejected.insert(
                pending.edge.clone(),
                Failure {
                    retry_after: now.saturating_add(REQUIRED_RETRY_MS),
                    was_confirmed: pending.restoring,
                },
            );
            false
        });
        retry_due || self.discovery.len() < pending_before
    }

    pub fn retire(&mut self, id: Uuid, identity: &crate::identity::Identity, now: u64) {
        let Some((&endpoints, pair)) = self.pairs.iter().find(|(_, pair)| pair.id == id) else {
            return;
        };
        if let Some(edge) = DiscoveryEdge::current(endpoints, identity) {
            let was_confirmed = self.previously_confirmed(&edge)
                || (pair.was_confirmed
                    && pair.confirmed_by == [Some(edge.sockets.0), Some(edge.sockets.1)]);
            self.rejected.insert(
                edge,
                Failure {
                    retry_after: now.saturating_add(REQUIRED_RETRY_MS),
                    was_confirmed,
                },
            );
        }
        self.release(endpoints);
    }

    pub fn prepared(&self, id: Uuid) -> bool {
        self.pairs
            .values()
            .any(|pair| pair.id == id && pair.attempt == Attempt::Prepared)
    }

    pub fn snapshot(
        &self,
        endpoint: Uuid,
        can_prepare: impl Fn(Uuid) -> bool,
        can_receive_video_layers: impl Fn(Uuid) -> bool,
    ) -> Vec<PairInfo> {
        self.pairs
            .iter()
            .filter_map(|((first, second), pair)| {
                let (peer, outgoing, incoming) = if *first == endpoint {
                    (*second, &pair.flows.forward, &pair.flows.reverse)
                } else if *second == endpoint {
                    (*first, &pair.flows.reverse, &pair.flows.forward)
                } else {
                    return None;
                };
                Some(PairInfo {
                    id: pair.id,
                    udp_preparation: match pair.attempt {
                        Attempt::Prepared => Some(UdpPreparation::Required),
                        Attempt::Ordinary
                            if pair.confirmed_by == [None; 2] && can_prepare(peer) =>
                        {
                            Some(UdpPreparation::Available)
                        }
                        Attempt::Ordinary => None,
                    },
                    peer_id: peer,
                    can_receive_video_layers: can_receive_video_layers(peer),
                    rooms: pair.flows.rooms.iter().cloned().collect(),
                    outgoing: outgoing.values().copied().collect(),
                    incoming: incoming.values().copied().collect(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(a: u128, b: u128) -> DiscoveryEdge {
        DiscoveryEdge {
            endpoints: (Uuid::from_u128(a), Uuid::from_u128(b)),
            sockets: (Uuid::from_u128(a + 10), Uuid::from_u128(b + 10)),
        }
    }

    fn confirm(book: &mut TransportBook, edge: &DiscoveryEdge) -> Uuid {
        let id = book.pairs[&edge.endpoints].id;
        let (a, b) = edge.endpoints;
        let (sa, sb) = edge.sockets;
        assert!(!book.connected(a, sa, Some(sb), id));
        assert!(book.connected(b, sb, Some(sa), id));
        id
    }

    #[test]
    fn disconnection_reports_are_fenced_by_current_endpoint_socket() {
        let mut book = TransportBook::default();
        let e = edge(1, 2);
        book.reconcile_with_standby(
            [],
            [],
            &BTreeMap::from([(e.clone(), Interest::Channel)]),
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            0,
            |_| 2,
        );
        let id = confirm(&mut book, &e);
        let (a, b) = e.endpoints;
        let (sa, sb) = e.sockets;
        let mut identity = crate::identity::Identity::new(String::new());
        for (id, socket) in [(e.endpoints.0, e.sockets.0), (e.endpoints.1, e.sockets.1)] {
            identity.sessions.insert(
                id,
                crate::identity::Session {
                    id,
                    user_id: id,
                    connection: Some(socket),
                    disconnected_at: None,
                    signing_key: [0; 32],
                    can_use_peer_transport: true,
                    can_prepare_udp: false,
                    can_receive_video_layers: false,
                },
            );
        }
        assert!(book.observe_disconnected(a, sa, id, true));
        assert_eq!(
            book.confirmed_pairs(&identity).collect::<Vec<_>>(),
            vec![(a, b)]
        );
        assert!(!book.observe_disconnected(b, sb, id, false));
        assert!(!book.observe_disconnected(a, sa, id, true));
        assert_eq!(book.pairs[&e.endpoints].disconnected_by, [Some(sa), None]);
        assert!(book.observe_disconnected(a, sa, id, false));
        assert!(!book.connected(a, sa, None, id));
        assert!(!book.observe_disconnected(a, sa, Uuid::nil(), true));
    }

    #[test]
    fn capacity_wait_preserves_standby_until_both_ends_can_admit() {
        let mut book = TransportBook::default();
        let first = edge(1, 3);
        let busy = edge(2, 4);
        let waiting = edge(1, 2);
        let mut interests = BTreeMap::from([(first.clone(), Interest::Channel)]);
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            0,
            |_| 1,
        );
        let standby = confirm(&mut book, &first);

        let grant = (busy.endpoints, "file room".to_owned());
        interests.insert(waiting.clone(), Interest::Activity);
        book.reconcile_with_standby(
            [],
            [grant.clone()],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            1,
            |_| 1,
        );
        let active = book.pairs[&busy.endpoints].id;
        assert!(book.serves_room(active, "file room"));
        assert_eq!(book.pairs[&first.endpoints].id, standby);
        assert!(!book.has_pair(waiting.endpoints));
        assert!(!book.expire_discovery(u64::MAX));
        assert!(!book.rejected(&waiting));

        let mut cancelled = book.clone();
        cancelled.reconcile_with_standby(
            [],
            [],
            &[(first.clone(), Interest::Channel)].into(),
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            2,
            |_| 1,
        );
        assert!(!cancelled.has_pair(waiting.endpoints));
        assert_eq!(cancelled.pairs[&first.endpoints].id, standby);

        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            2,
            |_| 1,
        );
        assert!(book.pending(&waiting));
        assert!(!book.has_pair(first.endpoints));
        assert!(!book.rejected(&first));
    }

    #[test]
    fn selected_and_preparing_flows_share_distinct_physical_slots() {
        let mut book = TransportBook::default();
        let old = edge(1, 2);
        let next = edge(1, 3);
        let waiting = edge(1, 4);
        let make_flow = |pair: &DiscoveryEdge, n: u128, selected| Flow {
            id: Uuid::from_u128(n),
            publication_id: Uuid::from_u128(n),
            input_flow_id: None,
            sender: pair.endpoints.0,
            receiver: pair.endpoints.1,
            selected,
            proof: None,
            presented: None,
            presentation: false,
        };
        let interests = [(waiting.clone(), Interest::Activity)].into();
        book.reconcile_with_standby(
            [
                make_flow(&old, 21, true),
                make_flow(&old, 22, false),
                make_flow(&next, 23, false),
            ],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            1,
            |_| 2,
        );
        let old_id = confirm(&mut book, &old);
        let next_id = confirm(&mut book, &next);
        assert!(book.flow(old_id, Uuid::from_u128(21)).unwrap().selected);
        assert!(!book.flow(old_id, Uuid::from_u128(22)).unwrap().selected);
        assert!(!book.has_pair(waiting.endpoints));
        book.reconcile_with_standby(
            [make_flow(&next, 23, true)],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            2,
            |_| 2,
        );
        assert!(book.flow(next_id, Uuid::from_u128(23)).unwrap().selected);
        assert!(book.flow(old_id, Uuid::from_u128(21)).is_none());
        assert!(book.pending(&waiting));
    }

    #[test]
    fn a_payload_grant_can_reclaim_preparing_segments_after_a_service_loses_its_role() {
        let mut book = TransportBook::default();
        let center = Uuid::from_u128(1);
        let a = edge(1, 2);
        let b = edge(1, 3);
        let service_limit = |id| if id == center { 2 } else { 1 };
        let segments = [
            (a.clone(), Interest::Activity),
            (b.clone(), Interest::Activity),
        ]
        .into();
        book.reconcile_with_standby(
            [],
            [],
            &segments,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            0,
            service_limit,
        );
        confirm(&mut book, &a);
        book.reconcile_with_standby(
            [],
            [],
            &segments,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            1,
            service_limit,
        );
        confirm(&mut book, &b);

        let mut idle = book.clone();
        idle.reconcile_with_standby(
            [],
            [],
            &segments,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            2,
            |_| 1,
        );
        assert_eq!(idle.pairs.len(), 1);
        assert_eq!(idle.failures().count(), 0);

        let granted = edge(1, 4);
        let grant = (granted.endpoints, "file room".to_owned());
        book.reconcile_with_standby(
            [],
            [grant],
            &segments,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            2,
            |_| 1,
        );
        assert_eq!(book.pairs.len(), 1);
        assert!(book.serves_room(book.pairs[&granted.endpoints].id, "file room"));
        assert_eq!(book.failures().count(), 0);
    }

    #[test]
    fn completing_a_repair_keeps_its_own_prefix_and_releases_a_competing_partial_path() {
        let mut book = TransportBook::default();
        let left = edge(1, 2);
        let right = edge(1, 3);
        let first_finish = edge(1, 4);
        let other_finish = edge(1, 5);
        let mut interests = BTreeMap::from([
            (left.clone(), Interest::Activity),
            (right.clone(), Interest::Activity),
        ]);
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            0,
            |_| 2,
        );
        let first = confirm(&mut book, &left);
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            1,
            |_| 2,
        );
        confirm(&mut book, &right);
        interests.insert(first_finish.clone(), Interest::Activity);
        interests.insert(other_finish.clone(), Interest::Activity);
        let proposals = [
            (first_finish.clone(), [left.endpoints].into()),
            (other_finish.clone(), [right.endpoints].into()),
        ];
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &proposals,
            &BTreeSet::new(),
            &BTreeSet::new(),
            2,
            |_| 2,
        );
        assert!(book.pending(&first_finish));
        assert_eq!(book.pairs[&left.endpoints].id, first);
        assert!(!book.has_pair(right.endpoints));
        let finishing = book.pairs[&first_finish.endpoints].id;
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &proposals,
            &BTreeSet::new(),
            &BTreeSet::new(),
            8,
            |_| 2,
        );
        assert_eq!(book.pairs[&first_finish.endpoints].id, finishing);
        assert_eq!(
            book.discovery[&first_finish.endpoints].deadline,
            2 + DISCOVERY_TIMEOUT_MS
        );
        confirm(&mut book, &first_finish);
        interests.insert(left.clone(), Interest::Delivery);
        interests.insert(first_finish.clone(), Interest::Delivery);
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &proposals[1..],
            &BTreeSet::new(),
            &BTreeSet::new(),
            9,
            |_| 2,
        );
        assert_eq!(book.pairs[&left.endpoints].id, first);
        assert_eq!(book.pairs[&first_finish.endpoints].id, finishing);
        assert!(!book.has_pair(other_finish.endpoints));
        assert_eq!(book.failures().count(), 0);
    }

    #[test]
    fn preemption_reuses_the_displaced_trials_slot() {
        let mut book = TransportBook::default();
        let neighbor = edge(1, 2);
        let channel = edge(1, 3);
        let room = edge(1, 4);
        let mut interests = [(neighbor.clone(), Interest::Channel)].into();
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            0,
            |_| 2,
        );
        let retained = confirm(&mut book, &neighbor);
        interests.insert(channel.clone(), Interest::Channel);
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            1,
            |_| 2,
        );
        interests.insert(room.clone(), Interest::Room);
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            2,
            |_| 2,
        );
        assert!(book.pending(&room));
        assert_eq!(book.pairs[&neighbor.endpoints].id, retained);
        assert!(!book.has_pair(channel.endpoints));
    }

    #[test]
    fn only_admitted_higher_priority_attempt_can_preempt_the_current_trial() {
        let mut book = TransportBook::default();
        let channel = edge(1, 2);
        let room = edge(2, 3);
        let busy = edge(3, 4);
        let grant = (busy.endpoints, "screen".to_owned());
        let mut interests = BTreeMap::from([(channel.clone(), Interest::Channel)]);
        book.reconcile_with_standby(
            [],
            [grant.clone()],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            0,
            |_| 1,
        );
        let old = book.pairs[&channel.endpoints].id;
        interests.insert(room.clone(), Interest::Room);
        book.reconcile_with_standby(
            [],
            [grant],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            1,
            |_| 1,
        );
        assert_eq!(book.pairs[&channel.endpoints].id, old);
        assert!(book.pending(&channel));

        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            2,
            |_| 1,
        );
        assert!(book.pending(&room));
        assert!(!book.has_pair(channel.endpoints));
        assert!(!book.rejected(&channel));
        assert!(!book.connected(
            channel.endpoints.0,
            channel.sockets.0,
            Some(channel.sockets.1),
            old
        ));
        let ready = confirm(&mut book, &room);
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            3,
            |_| 2,
        );
        assert!(book.pending(&channel));
        assert_eq!(book.pairs[&room.endpoints].id, ready);
    }

    #[test]
    fn prepared_attempt_gets_its_own_timeout_and_only_required_delivery_retries() {
        let mut book = TransportBook::default();
        let edge = edge(1, 2);
        let interests = [(edge.clone(), Interest::Activity)].into();
        let required = [edge.clone()].into();
        let reconcile = |book: &mut TransportBook, retries: &BTreeSet<_>, now, limit| {
            book.reconcile_with_standby(
                [],
                [],
                &interests,
                &[],
                retries,
                &BTreeSet::new(),
                now,
                |_| limit,
            )
        };
        let empty = BTreeSet::new();
        reconcile(&mut book, &empty, 0, 1);
        let ordinary = book.pairs[&edge.endpoints].id;
        let prepared_at = DISCOVERY_TIMEOUT_MS - 1;
        assert!(book.prepare(ordinary, prepared_at));
        let prepared = book.pairs[&edge.endpoints].id;
        assert_ne!(prepared, ordinary);
        assert!(!book.prepare(prepared, prepared_at + 1));
        assert!(!book.expire_discovery(DISCOVERY_TIMEOUT_MS));
        let failed_at = prepared_at + DISCOVERY_TIMEOUT_MS;
        assert!(book.expire_discovery(failed_at));
        let retry_at = failed_at + REQUIRED_RETRY_MS;
        assert_eq!(book.retry_after(&edge), Some(retry_at));
        reconcile(&mut book, &required, failed_at, 1);
        assert!(!book.expire_discovery(retry_at - 1));
        // A withdrawn request leaves only optional interest in the failed generation.
        let mut cancelled = book.clone();
        reconcile(&mut cancelled, &empty, retry_at - 1, 1);
        assert!(!cancelled.expire_discovery(retry_at));
        assert!(!cancelled.has_pair(edge.endpoints));
        reconcile(&mut book, &required, retry_at - 1, 0);
        assert!(book.expire_discovery(retry_at));
        reconcile(&mut book, &required, retry_at, 0);
        assert!(!book.expire_discovery(retry_at + 1));
        assert_eq!(book.retry_after(&edge), Some(retry_at));
        reconcile(&mut book, &required, retry_at + 1, 1);
        assert_ne!(book.pairs[&edge.endpoints].id, prepared);
        assert!(!book.rejected(&edge));
        confirm(&mut book, &edge);
        assert!(!book.expire_discovery(u64::MAX));
    }

    #[test]
    fn a_required_leg_remembers_prior_delivery_through_blackout_and_shares_the_trial_slot() {
        let mut book = TransportBook::default();
        let leg = edge(2, 3);
        let shortcut = edge(1, 2);
        let occupied = edge(3, 4);
        let mut identity = crate::identity::Identity::new(String::new());
        for (id, socket) in [
            (leg.endpoints.0, leg.sockets.0),
            (leg.endpoints.1, leg.sockets.1),
        ] {
            identity.sessions.insert(
                id,
                crate::identity::Session {
                    id,
                    user_id: id,
                    connection: Some(socket),
                    disconnected_at: None,
                    signing_key: [0; 32],
                    can_use_peer_transport: true,
                    can_prepare_udp: false,
                    can_receive_video_layers: false,
                },
            );
        }
        let mut interests = BTreeMap::from([(leg.clone(), Interest::Activity)]);
        let required = BTreeSet::from([leg.clone()]);
        let completions = [(shortcut.clone(), BTreeSet::new())];
        let update = |book: &mut TransportBook, interests: &_, grants: Vec<_>, now| {
            book.reconcile_with_standby(
                [],
                grants,
                interests,
                &completions,
                &required,
                &BTreeSet::new(),
                now,
                |_| 1,
            );
        };
        update(&mut book, &interests, vec![], 0);
        let old = confirm(&mut book, &leg);
        book.retire(old, &identity, 1);
        assert!(book.previously_confirmed(&leg));
        let mut next_generation = leg.clone();
        next_generation.sockets.0 = Uuid::new_v4();
        assert!(!book.previously_confirmed(&next_generation));
        interests.insert(shortcut.clone(), Interest::Activity);
        update(&mut book, &interests, vec![], REQUIRED_RETRY_MS);
        let shortcut_id = book.pairs[&shortcut.endpoints].id;
        let due = REQUIRED_RETRY_MS + 1;
        update(
            &mut book,
            &interests,
            vec![(occupied.endpoints, "occupied".into())],
            due,
        );
        assert_eq!(book.pairs[&shortcut.endpoints].id, shortcut_id);
        update(&mut book, &interests, vec![], due + 1);
        assert_eq!(book.pairs[&shortcut.endpoints].id, shortcut_id);
        let shortcut_timeout = REQUIRED_RETRY_MS + DISCOVERY_TIMEOUT_MS;
        assert!(!book.expire_discovery(shortcut_timeout - 1));
        assert!(book.expire_discovery(shortcut_timeout));
        assert!(!book.previously_confirmed(&shortcut));
        update(&mut book, &interests, vec![], shortcut_timeout);
        assert!(book.pending(&leg));
        assert!(book.previously_confirmed(&leg));
        let attempt = book.pairs[&leg.endpoints].id;
        book.retire(attempt, &identity, shortcut_timeout + 1);
        assert!(book.previously_confirmed(&leg));
        let retry = shortcut_timeout + 1 + REQUIRED_RETRY_MS;
        let fresh_shortcut = edge(1, 4);
        interests.insert(fresh_shortcut.clone(), Interest::Activity);
        book.reconcile_with_standby(
            [],
            [],
            &interests,
            &[(fresh_shortcut, BTreeSet::new())],
            &required,
            &BTreeSet::new(),
            retry,
            |_| 1,
        );
        assert!(book.pending(&leg));
        assert!(book.confirmed_pairs(&identity).next().is_none());
        assert!(book.expire_discovery(retry + DISCOVERY_TIMEOUT_MS));
        assert!(book.previously_confirmed(&leg));
        book.retain_failures(&BTreeSet::new());
        assert!(!book.previously_confirmed(&leg));
    }

    #[test]
    fn confirmed_demand_keeps_its_pair_and_releases_the_next_trial() {
        let edge = |start| DiscoveryEdge {
            endpoints: (Uuid::from_u128(start), Uuid::from_u128(start + 1)),
            sockets: (Uuid::new_v4(), Uuid::new_v4()),
        };
        let first = edge(1);
        let second = edge(3);
        let candidates = [
            (first.clone(), Interest::Activity),
            (second.clone(), Interest::Activity),
        ]
        .into();
        let mut book = TransportBook::default();
        book.reconcile_with_standby(
            [],
            [],
            &candidates,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            0,
            |_| 1,
        );
        let first_id = book.pairs[&first.endpoints].id;
        let (a, b) = first.endpoints;
        let (a_socket, b_socket) = first.sockets;
        assert!(!book.connected(a, a_socket, Some(b_socket), first_id));
        assert!(book.connected(b, b_socket, Some(a_socket), first_id));

        book.reconcile_with_standby(
            [],
            [],
            &candidates,
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            1,
            |_| 1,
        );
        assert!(book.pending(&second));
        assert_eq!(book.pairs[&first.endpoints].id, first_id);
        assert!(book.has_pair(second.endpoints));

        book.reconcile_with_standby(
            [],
            [],
            &BTreeMap::new(),
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            2,
            |_| 1,
        );
        assert!(book.discovery.is_empty());
        assert!(book.pairs.is_empty());
    }
    #[test]
    fn an_endpoint_degree_waiter_keeps_its_demand_while_other_pairs_start() {
        let mut book = TransportBook::default();
        let first = edge(1, 2);
        let waiting = edge(1, 3);
        let independent = edge(4, 5);
        let candidates = [first.clone(), waiting.clone(), independent.clone()];
        let mut interests = candidates
            .iter()
            .cloned()
            .map(|e| (e, Interest::Activity))
            .collect::<BTreeMap<_, _>>();
        let completions = candidates.map(|e| (e, BTreeSet::new()));
        let update = |book: &mut TransportBook, interests: &_, now| {
            book.reconcile_with_standby(
                [],
                [],
                interests,
                &completions,
                &BTreeSet::new(),
                &BTreeSet::new(),
                now,
                |_| 1,
            );
        };
        update(&mut book, &interests, 0);
        let first_id = book.pairs[&first.endpoints].id;
        let independent_id = book.pairs[&independent.endpoints].id;
        assert!(!book.has_pair(waiting.endpoints));
        assert!(!book.rejected(&waiting));
        update(&mut book, &interests, 1);
        assert_eq!(book.pairs[&first.endpoints].id, first_id);
        assert_eq!(
            book.discovery[&first.endpoints].deadline,
            DISCOVERY_TIMEOUT_MS
        );

        interests.remove(&first);
        update(&mut book, &interests, 2);
        assert!(!book.has_pair(first.endpoints));
        assert!(book.pending(&waiting));
        assert_eq!(book.pairs[&independent.endpoints].id, independent_id);
        assert_eq!(
            book.discovery[&independent.endpoints].deadline,
            DISCOVERY_TIMEOUT_MS
        );
    }

    #[test]
    fn in_flight_completions_share_a_confirmed_prefix_until_the_last_use() {
        let mut book = TransportBook::default();
        let prefix = edge(1, 2);
        let first = edge(2, 3);
        let sibling = edge(2, 4);
        let competitor = edge(2, 5);
        let competitor_prefix = edge(5, 6);
        let mut interests = BTreeMap::from([
            (prefix.clone(), Interest::Activity),
            (competitor_prefix.clone(), Interest::Activity),
        ]);
        let update = |book: &mut TransportBook, interests: &_, completions: &[_], now| {
            book.reconcile_with_standby(
                [],
                [],
                interests,
                completions,
                &BTreeSet::new(),
                &BTreeSet::new(),
                now,
                |_| 3,
            );
        };
        update(&mut book, &interests, &[], 0);
        let prefix_id = confirm(&mut book, &prefix);
        confirm(&mut book, &competitor_prefix);
        interests.extend(
            [first.clone(), sibling.clone(), competitor.clone()].map(|e| (e, Interest::Activity)),
        );
        let completions = [
            (first.clone(), [prefix.endpoints].into()),
            (sibling.clone(), [prefix.endpoints].into()),
            (competitor.clone(), [competitor_prefix.endpoints].into()),
        ];
        update(&mut book, &interests, &completions, 1);
        assert!(book.pending(&first));
        assert!(book.pending(&sibling));
        assert!(!book.has_pair(competitor.endpoints));
        assert!(!book.rejected(&competitor));
        let sibling_id = book.pairs[&sibling.endpoints].id;
        interests.remove(&first);
        update(&mut book, &interests, &completions[1..], 2);
        assert!(!book.has_pair(first.endpoints));
        assert!(book.pending(&competitor));
        assert_eq!(book.pairs[&prefix.endpoints].id, prefix_id);
        assert_eq!(
            book.discovery[&sibling.endpoints].deadline,
            1 + DISCOVERY_TIMEOUT_MS
        );
        assert_eq!(confirm(&mut book, &sibling), sibling_id);
        assert!(book.pairs[&prefix.endpoints].was_confirmed);
    }

    #[test]
    fn a_shared_completion_can_start_when_only_one_rooms_prefix_can_fit() {
        let mut book = TransportBook::default();
        let first_prefix = edge(1, 3);
        let leased_prefix = edge(2, 3);
        let trial = edge(3, 4);
        let mut interests = BTreeMap::from([
            (first_prefix.clone(), Interest::Activity),
            (leased_prefix.clone(), Interest::Activity),
        ]);
        let grant = (leased_prefix.endpoints, "second room".to_owned());
        let update = |book: &mut TransportBook, interests: &_, completions: &[_], now| {
            book.reconcile_with_standby(
                [],
                [grant.clone()],
                interests,
                completions,
                &BTreeSet::new(),
                &BTreeSet::new(),
                now,
                |_| 2,
            );
        };
        update(&mut book, &interests, &[], 0);
        confirm(&mut book, &first_prefix);
        let leased_id = confirm(&mut book, &leased_prefix);
        interests.insert(trial.clone(), Interest::Activity);
        let completions = [
            (trial.clone(), [first_prefix.endpoints].into()),
            (trial.clone(), [leased_prefix.endpoints].into()),
        ];
        update(&mut book, &interests, &completions, 1);
        assert!(book.pending(&trial));
        assert!(!book.has_pair(first_prefix.endpoints));
        assert_eq!(book.pairs[&leased_prefix.endpoints].id, leased_id);
        assert!(book.serves_room(leased_id, "second room"));
        assert_eq!(book.failures().count(), 0);
    }

    #[test]
    fn required_restoration_reclaims_only_the_pending_pair_needed_by_both_budgets() {
        let mut book = TransportBook::default();
        let trial = edge(1, 2);
        let idle = edge(1, 3);
        let restoration = edge(1, 4);
        let leased = edge(4, 5);
        let siblings = [edge(6, 7), edge(8, 9), edge(10, 11)];
        let mut interests = BTreeMap::from([(idle.clone(), Interest::Channel)]);
        let mut completions = Vec::new();
        let mut retries = BTreeSet::new();
        let update = |book: &mut TransportBook,
                      interests: &_,
                      completions: &[_],
                      retries: &_,
                      grants: Vec<_>,
                      now| {
            book.reconcile_with_standby(
                [],
                grants,
                interests,
                completions,
                retries,
                &BTreeSet::new(),
                now,
                |id| if id == Uuid::from_u128(1) { 2 } else { 1 },
            );
        };
        update(&mut book, &interests, &completions, &retries, vec![], 0);
        let idle_id = confirm(&mut book, &idle);
        // A same-generation failure from a previously confirmed connection.
        book.rejected.insert(
            restoration.clone(),
            Failure {
                retry_after: REQUIRED_RETRY_MS,
                was_confirmed: true,
            },
        );
        retries.insert(restoration.clone());
        interests.extend(siblings.iter().cloned().map(|e| (e, Interest::Activity)));
        interests.insert(restoration.clone(), Interest::Activity);
        interests.insert(trial.clone(), Interest::Room);
        completions.extend(siblings.iter().cloned().map(|e| (e, BTreeSet::new())));
        let grant = (leased.endpoints, "file room".to_owned());
        update(
            &mut book,
            &interests,
            &completions,
            &retries,
            vec![grant.clone()],
            1,
        );
        assert_eq!(book.discovery.len(), CHANNEL_ATTEMPT_LIMIT);
        let trial_id = book.pairs[&trial.endpoints].id;
        let siblings_ids = siblings.each_ref().map(|e| book.pairs[&e.endpoints].id);
        update(
            &mut book,
            &interests,
            &completions,
            &retries,
            vec![grant],
            REQUIRED_RETRY_MS,
        );
        assert_eq!(book.pairs[&trial.endpoints].id, trial_id);
        assert_eq!(
            book.discovery[&trial.endpoints].deadline,
            1 + DISCOVERY_TIMEOUT_MS
        );
        assert!(book.rejected(&restoration));
        assert_eq!(book.pairs[&idle.endpoints].id, idle_id);

        update(
            &mut book,
            &interests,
            &completions,
            &retries,
            vec![],
            REQUIRED_RETRY_MS + 1,
        );
        assert_eq!(book.discovery.len(), CHANNEL_ATTEMPT_LIMIT);
        assert!(book.pending(&restoration));
        assert!(book.previously_confirmed(&restoration));
        assert!(!book.has_pair(trial.endpoints));
        assert!(!book.rejected(&trial));
        assert!(book.peer(trial.endpoints.0, trial_id).is_none());
        assert_eq!(book.pairs[&idle.endpoints].id, idle_id);
        for (edge, id) in siblings.iter().zip(siblings_ids) {
            assert_eq!(book.pairs[&edge.endpoints].id, id);
            assert_eq!(
                book.discovery[&edge.endpoints].deadline,
                1 + DISCOVERY_TIMEOUT_MS
            );
        }
    }

    #[test]
    fn preparation_confirmation_and_expiry_each_affect_only_their_pair() {
        let mut book = TransportBook::default();
        let prepared = edge(1, 2);
        let silent = edge(3, 4);
        let soon_ready = edge(5, 6);
        let candidates = [prepared.clone(), silent.clone(), soon_ready.clone()];
        let interests = candidates
            .iter()
            .cloned()
            .map(|e| (e, Interest::Activity))
            .collect();
        let mut completions = vec![(prepared.clone(), BTreeSet::new())];
        completions.extend(candidates.map(|e| (e, BTreeSet::new())));
        let update = |book: &mut TransportBook, completions: &[_], now| {
            book.reconcile_with_standby(
                [],
                [],
                &interests,
                completions,
                &BTreeSet::new(),
                &BTreeSet::new(),
                now,
                |_| 1,
            );
        };
        update(&mut book, &completions, 0);
        assert_eq!(book.discovery.len(), 3);
        let old = book.pairs[&prepared.endpoints].id;
        let silent_id = book.pairs[&silent.endpoints].id;
        let ready_id = book.pairs[&soon_ready.endpoints].id;
        update(&mut book, &completions[1..], DISCOVERY_TIMEOUT_MS - 1);
        assert_eq!(book.pairs[&prepared.endpoints].id, old);
        assert!(book.prepare(old, DISCOVERY_TIMEOUT_MS - 1));
        assert_ne!(book.pairs[&prepared.endpoints].id, old);
        assert_eq!(book.pairs[&silent.endpoints].id, silent_id);
        assert_eq!(
            book.discovery[&silent.endpoints].deadline,
            DISCOVERY_TIMEOUT_MS
        );
        assert_eq!(confirm(&mut book, &soon_ready), ready_id);
        assert!(book.expire_discovery(DISCOVERY_TIMEOUT_MS));
        assert!(book.rejected(&silent));
        assert!(!book.has_pair(silent.endpoints));
        assert_eq!(
            book.discovery[&prepared.endpoints].deadline,
            2 * DISCOVERY_TIMEOUT_MS - 1
        );
        assert!(book.peer(prepared.endpoints.0, old).is_none());
        let prepared_id = confirm(&mut book, &prepared);
        assert!(book.prepared(prepared_id));
        assert_eq!(book.pairs[&soon_ready.endpoints].id, ready_id);
        assert!(book.discovery.is_empty());
    }

    #[test]
    fn fresh_activity_gets_a_freed_slot_ahead_of_an_eligible_retry() {
        let mut book = TransportBook::default();
        let first = edge(1, 2);
        let second = edge(1, 3);
        let fresh = edge(1, 4);
        let mut interests = BTreeMap::new();
        let required = [first.clone(), second.clone()].into();
        let update =
            |book: &mut TransportBook, interests: &BTreeMap<DiscoveryEdge, Interest>, now| {
                let completions = interests
                    .keys()
                    .cloned()
                    .map(|e| (e, BTreeSet::new()))
                    .collect::<Vec<_>>();
                book.reconcile_with_standby(
                    [],
                    [],
                    interests,
                    &completions,
                    &required,
                    &BTreeSet::new(),
                    now,
                    |_| PAIR_DEGREE_LIMIT,
                );
            };
        interests.insert(first.clone(), Interest::Activity);
        update(&mut book, &interests, 0);
        interests.insert(second.clone(), Interest::Activity);
        update(&mut book, &interests, REQUIRED_RETRY_MS + 1);
        interests.insert(fresh.clone(), Interest::Activity);
        update(&mut book, &interests, REQUIRED_RETRY_MS + 2);
        assert!(!book.has_pair(fresh.endpoints));
        assert!(book.expire_discovery(DISCOVERY_TIMEOUT_MS));
        update(
            &mut book,
            &interests,
            DISCOVERY_TIMEOUT_MS + REQUIRED_RETRY_MS,
        );
        assert!(book.pending(&fresh));
        assert!(book.pending(&second));
        assert!(!book.has_pair(first.endpoints));
        assert!(book.rejected(&first));
        assert!(book.expire_discovery(2 * DISCOVERY_TIMEOUT_MS + REQUIRED_RETRY_MS));
        assert!(book.rejected(&second));
        assert!(book.rejected(&fresh));
        assert!(book.discovery.is_empty());

        // When both retries are eligible and only one slot is available,
        // the earlier deadline wins within the same priority.
        interests.remove(&fresh);
        let other = edge(1, 5);
        interests.insert(other.clone(), Interest::Activity);
        update(
            &mut book,
            &interests,
            2 * DISCOVERY_TIMEOUT_MS + 2 * REQUIRED_RETRY_MS,
        );
        assert!(book.pending(&other));
        assert!(book.pending(&first));
        assert!(!book.has_pair(second.endpoints));
    }
}
