//! Select room-authorized connections and retain in-progress paths until delivery takes over.
use super::Channel;
use crate::host::RoomProjection;
use crate::identity::{Endpoint, Identity};
use crate::transport::{DiscoveryEdge, Interest, TransportBook, PAIR_DEGREE_LIMIT};
use crate::remote::RemoteRoom;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use uuid::Uuid;

#[derive(Clone, Default)]
pub(super) struct Repair {
    segments: BTreeSet<DiscoveryEdge>,
    trial: Option<DiscoveryEdge>,
    joined: bool,
}

impl Repair {
    fn retain_frontiers(
        &mut self,
        source: Uuid,
        viewer: Uuid,
        links: &BTreeSet<(Uuid, Uuid)>,
        proposal: impl Fn((Uuid, Uuid)) -> DiscoveryEdge,
    ) -> bool {
        self.segments.clear();
        self.joined = false;
        let mut trial_sides = 0;
        let mut neighbors = BTreeMap::<Uuid, Vec<Uuid>>::new();
        for &(a, b) in links {
            neighbors.entry(a).or_default().push(b);
            neighbors.entry(b).or_default().push(a);
        }
        for (root, other) in [(source, viewer), (viewer, source)] {
            let mut parent = BTreeMap::from([(root, root)]);
            let mut queue = VecDeque::from([root]);
            while let Some(at) = queue.pop_front() {
                for &next in neighbors.get(&at).into_iter().flatten() {
                    if let std::collections::btree_map::Entry::Vacant(entry) = parent.entry(next) {
                        entry.insert(at);
                        queue.push_back(next);
                    }
                }
            }
            // Protect the delivery path, or just the confirmed prefix leading
            // to this trial. Other branches can yield their slots to demand.
            let target = if parent.contains_key(&other) {
                Some(other)
            } else {
                self.trial.as_ref().and_then(|trial| {
                    let (a, b) = trial.endpoints;
                    [a, b].into_iter().find(|id| parent.contains_key(id))
                })
            };
            if let Some(mut at) = target {
                while at != root {
                    let previous = parent[&at];
                    self.segments.insert(proposal((at.min(previous), at.max(previous))));
                    at = previous;
                }
                if target == Some(other) {
                    self.joined = true;
                    break;
                }
                trial_sides += 1;
            }
        }
        trial_sides == 2
    }
}

type Pair = (Uuid, Uuid);
pub(super) type Repairs = BTreeMap<(String, DiscoveryEdge), Repair>;
#[derive(Default)]
struct DiscoveryPlan {
    retained: BTreeSet<(String, DiscoveryEdge)>,
    relevant_failures: BTreeSet<DiscoveryEdge>,
    interests: BTreeMap<DiscoveryEdge, Interest>,
    completions: Vec<(DiscoveryEdge, BTreeSet<Pair>)>,
    required_retries: BTreeSet<DiscoveryEdge>,
}
impl DiscoveryPlan {
    fn keep(&mut self, edge: DiscoveryEdge, interest: Interest) {
        self.interests
            .entry(edge)
            .and_modify(|old| *old = (*old).max(interest))
            .or_insert(interest);
    }

    fn retain_direct(&mut self, discovery: &Discovery<'_>, pair: Pair, waiting: bool) {
        let interest = if waiting { Interest::Delivery } else { Interest::Activity };
        self.keep(discovery.proposal(pair), interest);
    }
}
struct Discovery<'a> {
    identity: &'a Identity,
    transports: &'a TransportBook,
    confirmed: BTreeSet<Pair>,
}
impl Discovery<'_> {
    fn standby(
        &self,
        peers: &BTreeSet<Uuid>,
        links: &BTreeSet<Pair>,
        interest: Interest,
        plan: &mut DiscoveryPlan,
    ) {
        for pair in crate::connectivity::standby(peers, links, |pair| {
            self.transports.rejected(&self.proposal(pair))
        }) {
            plan.keep(self.proposal(pair), interest);
        }
    }
    fn proposal(&self, endpoints: Pair) -> DiscoveryEdge {
        DiscoveryEdge::current(endpoints, self.identity).unwrap()
    }
    fn current(&self, edge: &DiscoveryEdge) -> bool {
        DiscoveryEdge::current(edge.endpoints, self.identity).as_ref() == Some(edge)
    }
    fn carry(
        &self,
        projection: &RoomProjection,
        demand: &BTreeSet<Pair>,
        scope: &BTreeSet<Uuid>,
        repairs: &Repairs,
        plan: &mut DiscoveryPlan,
    ) {
        for (key, repair) in repairs {
            let (room, edge) = key;
            if *room == projection.summary.id
                && demand.contains(&edge.endpoints)
                && scope.contains(&edge.endpoints.0)
                && scope.contains(&edge.endpoints.1)
                && self.current(edge)
            {
                plan.retained.insert(key.clone());
                let carried_edge = |e: &DiscoveryEdge| {
                    scope.contains(&e.endpoints.0)
                        && scope.contains(&e.endpoints.1)
                        && self.current(e)
                };
                let joined = repair.joined && repair.segments.iter().all(|edge| {
                    carried_edge(edge) && self.confirmed.contains(&edge.endpoints)
                });
                let carried =
                    repair
                        .segments
                        .iter()
                        .chain(repair.trial.iter())
                        .filter(|e| carried_edge(e) && self.confirmed.contains(&e.endpoints));
                for edge in carried {
                    let interest = if joined && repair.segments.contains(edge) {
                        Interest::Delivery
                    } else {
                        Interest::Activity
                    };
                    plan.keep(edge.clone(), interest);
                }
                if let Some(e) = repair.trial.as_ref().filter(|e| {
                    carried_edge(e)
                        && self.transports.pending(e)
                        && !self.confirmed.contains(&e.endpoints)
                }) {
                    plan.keep(e.clone(), Interest::Activity);
                    let mut pending = Repair {
                        trial: Some(e.clone()),
                        ..Repair::default()
                    };
                    let links = repair
                        .segments
                        .iter()
                        .filter_map(|edge| {
                            (carried_edge(edge) && self.confirmed.contains(&edge.endpoints))
                                .then_some(edge.endpoints)
                        })
                        .collect();
                    let (source, viewer) = edge.endpoints;
                    if pending.retain_frontiers(source, viewer, &links, |p| self.proposal(p)) {
                        plan.completions.push((
                            e.clone(),
                            pending.segments.iter().map(|edge| edge.endpoints).collect(),
                        ));
                    }
                }
            }
        }
    }
    fn repair(
        &self,
        projection: &RoomProjection,
        scope: &BTreeSet<Uuid>,
        requested: &BTreeMap<Pair, bool>,
        demand: &mut BTreeSet<Pair>,
        repairs: &mut Repairs,
        plan: &mut DiscoveryPlan,
    ) {
        // A terminal direct failure opens one room-local recovery trial.
        for (&pair @ (source, viewer), &waiting) in requested {
            let allowed = |id| id == viewer || id == source || projection.relay_session_ids.contains(&id);
            plan.relevant_failures.extend(
                self.transports
                    .failures()
                    .filter(|edge| {
                        allowed(edge.endpoints.0) && allowed(edge.endpoints.1) && self.current(edge)
                    })
                    .cloned(),
            );
            if !scope.contains(&viewer) || !scope.contains(&source) {
                continue;
            }
            let view = std::cell::LazyCell::new(|| {
                let eligible: BTreeSet<_> = scope.iter().copied().filter(|id| allowed(*id)).collect();
                let links: BTreeSet<_> = self
                    .confirmed
                    .iter()
                    .copied()
                    .filter(|(a, b)| eligible.contains(a) && eligible.contains(b))
                    .collect();
                (eligible, links)
            });
            if waiting {
                let mut proven = self.transports
                    .failures()
                    .chain(self.transports.pending_edges())
                    .filter(|edge| self.current(edge) && self.transports.previously_confirmed(edge))
                    .map(|edge| (edge.endpoints, self.transports.retry_after(edge).unwrap_or(0)))
                    .peekable();
                if proven.peek().is_some() {
                    let (eligible, links) = &*view;
                    if let Some(key) = crate::connectivity::retry_candidate(eligible, links, pair, proven) {
                        let edge = self.proposal(key);
                        plan.required_retries.insert(edge.clone());
                        plan.keep(edge.clone(), Interest::Activity);
                        let mut restore = Repair { trial: Some(edge.clone()), ..Repair::default() };
                        let completes = restore.retain_frontiers(source, viewer, links, |p| self.proposal(p));
                        for segment in &restore.segments {
                            plan.keep(segment.clone(), Interest::Activity);
                        }
                        if completes {
                            let prefix = restore.segments.iter().map(|e| e.endpoints).collect();
                            plan.completions.push((edge, prefix));
                        }
                    }
                }
            }
            let direct = self.proposal(pair);
            if !self.transports.rejected(&direct) {
                // Let admission skip a capacity-blocked request when another
                // waiting delivery in this room can start on different peers.
                if !self.confirmed.contains(&pair) {
                    if waiting {
                        plan.completions.push((direct.clone(), BTreeSet::new()));
                    }
                    plan.keep(direct, Interest::Activity);
                }
                continue;
            }
            if !waiting {
                continue;
            }
            let (eligible, links) = &*view;
            demand.remove(&pair);
            let key = (projection.summary.id.clone(), direct);
            plan.retained.insert(key.clone());
            let repair = repairs.entry(key).or_default();
            repair.trial = None;
            let trial = crate::connectivity::repair_candidate(eligible, links, &[pair].into(), |a, b| {
                    let e = self.proposal((a, b));
                    !links.contains(&(a, b))
                        && !self.transports.rejected(&e)
                        && (self.transports.pending(&e) || !self.transports.has_pair((a, b)))
                }).or_else(|| {
                    let failures = self.transports.failures().filter_map(|edge| {
                        if !self.current(edge) || self.transports.has_pair(edge.endpoints) {
                            return None;
                        }
                        Some((edge.endpoints, self.transports.retry_after(edge)?))
                    });
                    crate::connectivity::retry_candidate(eligible, links, pair, failures)
                });
            if let Some(edge) = trial {
                let trial = self.proposal(edge);
                if self.transports.rejected(&trial) {
                    plan.required_retries.insert(trial.clone());
                }
                plan.keep(trial.clone(), Interest::Activity);
                repair.trial = Some(trial);
            }
            let bridges = repair.retain_frontiers(source, viewer, links, |pair| self.proposal(pair));
            let interest = if repair.joined { Interest::Delivery } else { Interest::Activity };
            for edge in &repair.segments {
                plan.keep(edge.clone(), interest);
            }
            if let Some(trial) = repair.trial.as_ref().filter(|_| !repair.joined && bridges) {
                let prefix = repair.segments.iter().map(|edge| edge.endpoints).collect();
                plan.completions.push((trial.clone(), prefix));
            }
        }
    }

    fn ordinary(
        &self,
        scope: &BTreeSet<Uuid>,
        graph: &BTreeSet<Pair>,
        demand: &BTreeSet<Pair>,
        plan: &mut DiscoveryPlan,
    ) {
        let available = |a: Uuid, b: Uuid| {
            let pair = (a.min(b), a.max(b));
            !self.transports.has_pair(pair) || self.transports.pending(&self.proposal(pair))
        };
        if let Some(first) = crate::connectivity::candidate(scope, graph, demand, available) {
            let edge = self.proposal(first);
            // Keep a single alternative per room after a failed primary.
            // Retaining both proposals keeps failed generations fenced.
            if self.transports.rejected(&edge) {
                if let Some(next) = crate::connectivity::candidate(scope, graph, demand, |a, b| {
                    (a, b) != first && available(a, b)
                }) {
                    plan.keep(self.proposal(next), Interest::Activity);
                }
            }
            plan.keep(edge, Interest::Activity);
        }
    }
}
impl Channel {
    pub(super) fn reconcile_transports(
        &mut self,
        endpoints: &BTreeMap<Uuid, Endpoint>,
    ) {
        let discovery = Discovery {
            identity: &self.identity,
            transports: &self.transports,
            confirmed: self.transports.confirmed_pairs(&self.identity).collect(),
        };
        let mut plan = DiscoveryPlan::default();
        let online = endpoints.iter()
            .filter_map(|(&id, endpoint)| endpoint.connected.then_some(id))
            .collect();
        discovery.standby(&online, &discovery.confirmed, Interest::Channel, &mut plan);
        for room in self
            .remote
            .values()
            .filter(|room| Self::host_online(&self.identity, room))
        {
            let Some(projection) = &room.projection else {
                continue;
            };
            let requested = projection.requested_pairs();
            let mut demand: BTreeSet<_> = requested.keys().copied().collect();
            let mut scope = room.planning_sessions(self.service_endpoint, None);
            scope.retain(|id| endpoints.get(id).is_some_and(|endpoint| endpoint.connected));
            // While the host acknowledges a failed pair, only carry existing uses
            // from that projection. Other invalidations wait for fresh room grants.
            if let Some(binding) = room
                .binding
                .as_ref()
                .filter(|binding| scope.is_empty() && binding.awaiting_pair_failure())
            {
                for &pair in discovery.confirmed.intersection(&demand) {
                    plan.retain_direct(&discovery, pair, requested[&pair]);
                }
                let retained_scope = RemoteRoom::projected_sessions(
                    binding, projection, self.service_endpoint, None,
                );
                discovery.carry(projection, &demand, &retained_scope, &self.repairs, &mut plan);
            }
            let graph: BTreeSet<_> = discovery
                .confirmed
                .iter()
                .copied()
                .filter(|(a, b)| scope.contains(a) && scope.contains(b))
                .collect();
            discovery.standby(&scope, &graph, Interest::Room, &mut plan);
            for &pair in graph.intersection(&demand) {
                plan.retain_direct(&discovery, pair, requested[&pair]);
            }
            discovery.repair(
                projection,
                &scope,
                &requested,
                &mut demand,
                &mut self.repairs,
                &mut plan,
            );
            discovery.ordinary(&scope, &graph, &demand, &mut plan);
        }
        self.repairs.retain(|key, _| plan.retained.contains(key));
        plan.relevant_failures.extend(plan.interests.keys().cloned());
        self.transports.retain_failures(&plan.relevant_failures);
        // A covering projection acknowledges delivery. Keep that receipt for
        // this binding only while the physical failure still applies.
        for binding in self.remote.values_mut().filter_map(|room| room.binding.as_mut()) {
            binding.failed_pairs.retain(|&pair, revision| {
                *revision > binding.applied_revision || DiscoveryEdge::current(pair, &self.identity)
                    .is_some_and(|edge| self.transports.rejected(&edge))
            });
        }
        let bound_projections = self.remote.values()
            .filter(|room| room.binding.is_some())
            .filter_map(|room| room.projection.as_ref());
        self.transports.reconcile_with_standby(
            bound_projections.clone().flat_map(|projection| projection.flows.iter().cloned()),
            bound_projections.flat_map(RoomProjection::room_data_grants),
            &plan.interests,
            &plan.completions,
            &plan.required_retries,
            &self.transports.recovering_pairs(&self.identity),
            self.now,
            |endpoint| {
                if self.service_endpoint.is_some_and(|service| service.session_id == endpoint) {
                    crate::identity::MAX_SESSIONS - 1
                } else {
                    PAIR_DEGREE_LIMIT
                }
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::Admission;

    #[test]
    fn repair_reserves_the_trial_prefix_without_pinning_idle_neighbors() {
        let id = Uuid::from_u128;
        let edge = |pair| DiscoveryEdge { endpoints: pair, sockets: pair };
        let mut repair = Repair::default();
        repair.trial = Some(edge((id(2), id(4))));
        let links = [(id(1), id(2)), (id(1), id(3))].into();
        assert!(repair.retain_frontiers(id(1), id(4), &links, edge));
        assert_eq!(repair.segments.len(), 1);
        assert!(repair.segments.contains(&edge((id(1), id(2)))));
        assert!(!repair.joined);

        repair.trial = Some(edge((id(2), id(5))));
        assert!(!repair.retain_frontiers(id(1), id(4), &links, edge));
        assert!(!repair.joined);

        let mut linked = links;
        linked.insert((id(2), id(4)));
        assert!(!repair.retain_frontiers(id(1), id(4), &linked, edge));
        assert!(repair.joined);
        assert_eq!(repair.segments.len(), 2);
    }

    fn join<const N: usize>(identity: &mut Identity, names: [&str; N]) -> [Uuid; N] {
        names.map(|name| {
            identity
                .admit(
                    Admission {
                        name,
                        signing_key: [0; 32],
                        can_prepare_udp: false,
                        can_receive_video_layers: false,
                        credential: None,
                        owner_key: None,
                        resume: None,
                    },
                    Uuid::new_v4(),
                    0,
                )
                .unwrap()
                .session_id
        })
    }

    #[test]
    fn recovery_reconnects_the_writer_and_relay_between_confirmed_end_legs() {
        use crate::{access::RoomState, room::RoomRuntime, wire::{HostingMode, RoomAccess}};
        let mut identity = Identity::new(String::new());
        let [source, writer, relay, viewer] = join(&mut identity, ["Source", "Host", "Relay", "Viewer"]);
        let endpoints = identity.endpoints();
        let mut room = RoomRuntime::new(RoomState::new(
            "room".into(), "Room".into(), Default::default(), endpoints[&writer].member.user_id,
            RoomAccess::Public, false, None,
        ).unwrap());
        room.set_writer(writer, HostingMode::Lightweight);
        for browser in [source, relay, viewer] {
            room.browse(endpoints[&browser].member, browser, true).unwrap();
        }
        let projection = room.projection(&endpoints);
        assert!(!projection.views[&writer].reading);
        let pair = |a: Uuid, b: Uuid| (a.min(b), a.max(b));
        let direct = pair(source, viewer);
        let mut transports = TransportBook::default();
        // The network fixture blocks the three shortcuts throughout the outage.
        for key in [direct, pair(source, relay), pair(writer, viewer)] {
            let edge = DiscoveryEdge::current(key, &identity).unwrap();
            transports.reconcile_with_standby([], [], &[(edge, Interest::Activity)].into(),
                &[], &BTreeSet::new(), &BTreeSet::new(), 0, |_| PAIR_DEGREE_LIMIT);
            let attempt = transports.snapshot(key.0, |_| false, |_| false)[0].id;
            transports.retire(attempt, &identity, 0);
        }
        let discovery = Discovery {
            identity: &identity, transports: &transports,
            confirmed: [pair(source, writer), pair(relay, viewer)].into(),
        };
        let mut plan = DiscoveryPlan::default();
        discovery.repair(
            &projection, &[source, writer, relay, viewer].into(), &[(direct, true)].into(),
            &mut [direct].into(), &mut Repairs::new(), &mut plan,
        );
        let middle = DiscoveryEdge::current(pair(writer, relay), &identity).unwrap();
        assert!(plan.completions.iter().any(|(edge, prefix)|
            *edge == middle && *prefix == discovery.confirmed));

        // Before the UDP outage the middle leg was proven by both sockets.
        let request = [(middle.clone(), Interest::Activity)].into();
        transports.reconcile_with_standby([], [], &request, &[], &BTreeSet::new(),
            &BTreeSet::new(), 1, |_| PAIR_DEGREE_LIMIT);
        let middle_id = transports.snapshot(writer, |_| false, |_| false)[0].id;
        let (a, b) = middle.endpoints;
        let (left, right) = middle.sockets;
        transports.connected(a, left, Some(right), middle_id);
        assert!(transports.connected(b, right, Some(left), middle_id));
        transports.retire(middle_id, &identity, 50_000);

        // The disconnected direct shortcut is already retrying when the middle leg cools down.
        let shortcut = DiscoveryEdge::current(direct, &identity).unwrap();
        transports.reconcile_with_standby([], [], &[(shortcut.clone(), Interest::Activity)].into(),
            &[], &[shortcut.clone()].into(), &BTreeSet::new(), 50_001, |_| PAIR_DEGREE_LIMIT);
        let discovery = Discovery {
            identity: &identity, transports: &transports,
            confirmed: [pair(source, writer), pair(relay, viewer)].into(),
        };
        assert!(transports.pending(&shortcut));
        for waiting in [false, true] {
            let mut plan = DiscoveryPlan::default();
            discovery.repair(&projection, &[source, writer, relay, viewer].into(),
                &[(direct, waiting)].into(), &mut [direct].into(), &mut Repairs::new(), &mut plan);
            assert_eq!(plan.required_retries.contains(&middle), waiting);
        }

        // The viewer's last hop also worked before the outage. Its first
        // recovery attempt times out while UDP is still blocked.
        let last = DiscoveryEdge::current(pair(relay, viewer), &identity).unwrap();
        let request = [(last.clone(), Interest::Activity)].into();
        transports.reconcile_with_standby([], [], &request, &[], &BTreeSet::new(),
            &BTreeSet::new(), 50_002, |_| PAIR_DEGREE_LIMIT);
        let original = transports.snapshot(relay, |_| false, |_| false)[0].id;
        let (a, b) = last.endpoints;
        let (left, right) = last.sockets;
        transports.connected(a, left, Some(right), original);
        assert!(transports.connected(b, right, Some(left), original));
        transports.retire(original, &identity, 50_003);
        let retries = [last.clone()].into();
        transports.reconcile_with_standby([], [], &request, &[], &retries,
            &BTreeSet::new(), 55_003, |_| PAIR_DEGREE_LIMIT);
        assert!(transports.pending(&last));
        assert!(transports.expire_discovery(75_003));

        // Once the writer–relay leg returns, the old viewer leg can finish
        // delivery. The never-confirmed shortcuts are still candidates.
        let discovery = Discovery {
            identity: &identity, transports: &transports,
            confirmed: [pair(source, writer), middle.endpoints].into(),
        };
        let mut plan = DiscoveryPlan::default();
        discovery.repair(&projection, &[source, writer, relay, viewer].into(),
            &[(direct, true)].into(), &mut [direct].into(), &mut Repairs::new(), &mut plan);
        assert!(plan.required_retries.contains(&last));
        assert!(plan.completions.iter().any(|(edge, prefix)|
            *edge == last && *prefix == discovery.confirmed));
    }

    #[test]
    fn first_room_demand_proposes_only_the_authorized_pair() {
        let mut identity = Identity::new(String::new());
        let [source, receiver, outsider] = join(&mut identity, ["Source", "Receiver", "Outsider"]);
        let direct = (source.min(receiver), source.max(receiver));
        let outside = (source.min(outsider), source.max(outsider));
        let discovery = Discovery {
            identity: &identity,
            transports: &TransportBook::default(),
            confirmed: BTreeSet::new(),
        };
        let mut plan = DiscoveryPlan::default();
        discovery.ordinary(
            &[source, receiver].into(),
            &discovery.confirmed,
            &[direct, outside].into(),
            &mut plan,
        );
        assert_eq!(plan.interests.len(), 1);
        assert!(plan.interests.get(&discovery.proposal(direct)) == Some(&Interest::Activity));
    }
}
