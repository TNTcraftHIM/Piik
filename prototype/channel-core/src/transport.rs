use crate::wire::{FlowBinding, FlowState, PairInfo, UdpPreparation};
use serde::{Deserialize, Serialize};
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
    // One optional trial for the channel. A terminal failure is remembered
    // only while the same demand and socket generations still justify it.
    discovery: Option<Pending>,
    rejected: BTreeMap<DiscoveryEdge, Failure>,
    next_required_retry: Option<u64>,
    pairs: BTreeMap<(Uuid, Uuid), Pair>,
}

impl TransportBook {
    pub(crate) fn discovery_endpoints(&self) -> Option<(Uuid, Uuid)> {
        self.discovery
            .as_ref()
            .map(|pending| pending.edge.endpoints)
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
                .as_ref()
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
                let sockets = [
                    identity.sessions.get(&a)?.connection,
                    identity.sessions.get(&b)?.connection,
                ];
                (pair.was_confirmed && (sockets.contains(&None) || sockets != pair.confirmed_by))
                    .then_some(key)
            })
            .collect()
    }

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
                        .as_ref()
                        .is_some_and(|pending| pending.edge == *edge)
                {
                    pair.interest = interest;
                    return true;
                }
            }
            pair.interest = Interest::Recovering;
            recovering.contains(key)
        });
        // Only an admitted unconfirmed physical attempt owns this timer.
        if self.discovery.as_ref().is_some_and(|pending| {
            let edge = &pending.edge;
            !self.pairs.contains_key(&edge.endpoints)
                || !requests
                    .get(&edge.endpoints)
                    .is_some_and(|(current, _)| *current == edge)
        }) {
            self.discovery = None;
        }

        self.trim_standby(&degree_limit);
        for (key, flows) in needed {
            self.admit(key, Interest::Activity, flows, None, &degree_limit);
        }
        let prefix_ready = |book: &Self, prefix: &BTreeSet<_>| {
            prefix.iter().all(|key| {
                let Some((edge, _)) = requests.get(key) else {
                    return false;
                };
                book.pairs
                    .get(key)
                    .is_some_and(|p| p.confirmed_by == [Some(edge.sockets.0), Some(edge.sockets.1)])
            })
        };
        if let Some(current) = &self.discovery {
            if self.pairs[&current.edge.endpoints].flows.has_lease()
                || (current.restoring && required_retries.contains(&current.edge))
                || completions
                    .iter()
                    .any(|(edge, prefix)| edge == &current.edge && prefix_ready(self, prefix))
            {
                return;
            }
        }
        // Restore a required previously working leg ahead of an unverified shortcut.
        for edge in required_retries {
            if !self.previously_confirmed(edge)
                || self.has_pair(edge.endpoints)
                || !requests
                    .get(&edge.endpoints)
                    .is_some_and(|&(e, priority)| e == edge && priority == Interest::Activity)
            {
                continue;
            }
            let mut prefixes = completions
                .iter()
                .filter(|(candidate, _)| candidate == edge)
                .peekable();
            let admitted = if prefixes.peek().is_none() {
                self.admit(
                    edge.endpoints,
                    Interest::Activity,
                    Directions::default(),
                    None,
                    &degree_limit,
                )
            } else {
                prefixes.any(|(_, prefix)| {
                    prefix_ready(self, prefix)
                        && self.admit(
                            edge.endpoints,
                            Interest::Activity,
                            Directions::default(),
                            Some(prefix),
                            &degree_limit,
                        )
                })
            };
            if admitted {
                self.start_discovery(edge, now);
                return;
            }
        }
        for (edge, prefix) in completions {
            if requests
                .get(&edge.endpoints)
                .is_some_and(|&(e, interest)| e == edge && interest == Interest::Activity)
                && !self.has_pair(edge.endpoints)
                && prefix_ready(self, prefix)
                && self.admit(
                    edge.endpoints,
                    Interest::Activity,
                    Directions::default(),
                    Some(prefix),
                    &degree_limit,
                )
            {
                self.start_discovery(edge, now);
                return;
            }
        }
        for priority in [Interest::Activity, Interest::Room, Interest::Channel] {
            if self
                .discovery
                .as_ref()
                .is_some_and(|p| self.pairs[&p.edge.endpoints].interest >= priority)
            {
                break;
            }
            for (&key, &(edge, interest)) in &requests {
                if interest != priority
                    || self.pairs.contains_key(&key)
                    || completions.iter().any(|(completion, _)| completion == edge)
                    || !self.admit(key, interest, Directions::default(), None, &degree_limit)
                {
                    continue;
                }
                self.start_discovery(edge, now);
                return;
            }
        }
    }

    fn start_discovery(&mut self, edge: &DiscoveryEdge, now: u64) {
        self.discovery = Some(Pending {
            edge: edge.clone(),
            deadline: now.saturating_add(DISCOVERY_TIMEOUT_MS),
            restoring: self
                .rejected
                .remove(edge)
                .is_some_and(|failure| failure.was_confirmed),
        });
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

    fn release(&mut self, key: (Uuid, Uuid)) {
        self.pairs.remove(&key);
        if self.discovery_endpoints() == Some(key) {
            self.discovery = None;
        }
    }

    // Reserve both endpoint slots before releasing either standby.
    fn admit(
        &mut self,
        key: (Uuid, Uuid),
        priority: Interest,
        flows: Directions,
        prefix: Option<&BTreeSet<(Uuid, Uuid)>>,
        degree_limit: &impl Fn(Uuid) -> usize,
    ) -> bool {
        let can_replace_partial = flows.has_lease() || prefix.is_some();
        let replaced_trial = if flows.has_lease() {
            None
        } else {
            self.discovery_endpoints()
        };
        let mut victims: Vec<_> = replaced_trial.into_iter().collect();
        for endpoint in [key.0, key.1] {
            let incident = self.pairs.iter().filter(|(key, _)| {
                Some(**key) != replaced_trial && (key.0 == endpoint || key.1 == endpoint)
            });
            let needed = (incident.clone().count() + 1).saturating_sub(degree_limit(endpoint));
            if needed == 0 {
                continue;
            }
            let mut available: Vec<_> = incident
                .filter_map(|(&key, pair)| {
                    let lower = pair.interest < priority
                        || (can_replace_partial && pair.interest == Interest::Activity);
                    (lower && !pair.flows.has_lease() && !prefix.is_some_and(|p| p.contains(&key)))
                        .then_some((pair.interest, key))
                })
                .collect();
            if available.len() < needed {
                return false;
            }
            available.sort_unstable();
            victims.extend(available.into_iter().take(needed).map(|(_, key)| key));
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
                presentation: false,
            })
        })
    }

    pub fn serves_room(&self, id: Uuid, room: &str) -> bool {
        self.pairs
            .values()
            .any(|pair| pair.id == id && pair.flows.rooms.contains(room))
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
        if confirmed
            && self
                .discovery
                .as_ref()
                .is_some_and(|pending| pending.edge.endpoints == (*first, *second))
        {
            self.discovery = None;
        }
        confirmed
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
        pair.attempt = Attempt::Prepared;
        if let Some(pending) = self.discovery.as_mut().filter(|p| p.edge.endpoints == *key) {
            pending.deadline = now.saturating_add(DISCOVERY_TIMEOUT_MS);
        }
        true
    }

    pub(crate) fn expire_discovery(&mut self, now: u64) -> bool {
        let retry_due = self.next_required_retry.take_if(|at| *at <= now).is_some();
        let Some(pending) = self.discovery.take_if(|pending| pending.deadline <= now) else {
            return retry_due;
        };
        self.pairs.remove(&pending.edge.endpoints);
        self.rejected.insert(
            pending.edge,
            Failure {
                retry_after: now.saturating_add(REQUIRED_RETRY_MS),
                was_confirmed: pending.restoring,
            },
        );
        true
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
        assert_eq!(book.discovery_endpoints(), Some(waiting.endpoints));
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
        assert_eq!(book.discovery_endpoints(), Some(waiting.endpoints));
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
        assert_eq!(book.discovery_endpoints(), Some(first_finish.endpoints));
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
            book.discovery.as_ref().unwrap().deadline,
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
        assert_eq!(book.discovery_endpoints(), Some(room.endpoints));
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
        assert_eq!(book.discovery_endpoints(), Some(channel.endpoints));

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
        assert_eq!(book.discovery_endpoints(), Some(room.endpoints));
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
        assert_eq!(book.discovery_endpoints(), Some(channel.endpoints));
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
        assert_eq!(book.discovery_endpoints(), Some(leg.endpoints));
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
        assert_eq!(book.discovery_endpoints(), Some(leg.endpoints));
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
        assert_eq!(book.discovery_endpoints(), Some(second.endpoints));
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
        assert!(book.discovery_endpoints().is_none());
        assert!(book.pairs.is_empty());
    }
}
