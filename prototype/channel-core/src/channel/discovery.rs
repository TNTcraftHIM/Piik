//! Select room-authorized connections and retain in-progress paths until delivery takes over.
use super::Channel;
use crate::host::{DeliveryFrontier,RoomProjection};
use crate::identity::{Endpoint, Identity};
use crate::transport::{DiscoveryEdge, Interest, TransportBook, PAIR_DEGREE_LIMIT};
use crate::remote::RemoteRoom;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::rc::Rc;
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
fn pair(a: Uuid, b: Uuid) -> Pair {
    (a.min(b), a.max(b))
}
// The depth term is the offered parent's depth under study P2, else 0.
type CrossingRank = (bool, bool, Option<u64>, usize, Pair);
#[cfg(feature = "study")]
fn depth_term(depth: usize) -> usize {
    if crate::study::depth_before_id() {
        depth
    } else {
        0
    }
}
#[cfg(not(feature = "study"))]
fn depth_term(_: usize) -> usize {
    0
}
fn path_segments(
    prefix: &BTreeSet<Pair>,
    mut at: Uuid,
    tail: &BTreeMap<Uuid, Uuid>,
) -> BTreeSet<Pair> {
    let mut segments = prefix.clone();
    while tail[&at] != at {
        let next = tail[&at];
        segments.insert(pair(at, next));
        at = next;
    }
    segments
}
pub(super) type Repairs = BTreeMap<(String, DiscoveryEdge), Repair>;
#[derive(Default)]
struct DiscoveryPlan {
    retained: BTreeSet<(String, DiscoveryEdge)>,
    relevant_failures: BTreeSet<DiscoveryEdge>,
    interests: BTreeMap<DiscoveryEdge, Interest>,
    completions: Vec<(DiscoveryEdge, BTreeSet<Pair>)>,
    required_retries: BTreeSet<DiscoveryEdge>,
    advised: BTreeSet<(String, DiscoveryEdge)>,
    temporary: BTreeSet<Pair>,
}
impl DiscoveryPlan {
    fn keep(&mut self, edge: DiscoveryEdge, interest: Interest) {
        self.interests
            .entry(edge)
            .and_modify(|old| *old = (*old).max(interest))
            .or_insert(interest);
    }

    fn finish_admission<'a>(
        &self,
        book: &mut TransportBook,
        identity: &Identity,
        repairs: &mut Repairs,
        protected: &mut BTreeSet<Pair>,
        now: u64,
        limit: impl Fn(Uuid) -> usize,
        room: impl Fn(&str) -> Option<(&'a RoomProjection, BTreeSet<Uuid>)>,
    ) {
        for key @ (room_id, direct) in &self.advised {
            let Some(repair) = repairs.get_mut(key) else {
                continue;
            };
            let Some(preferred) = repair.trial.take() else {
                continue;
            };
            if book.pending(&preferred) {
                repair.trial = Some(preferred);
                continue;
            }
            repair.segments.clear();
            let Some((projection, scope)) = room(room_id) else {
                continue;
            };
            let (a, b) = direct.endpoints;
            let confirmed = book.confirmed_pairs(identity).collect();
            let discovery = Discovery {
                identity,
                transports: book,
                confirmed,
            };
            let only_pending = book.only_pending_completions(protected);
            let mut choices = Vec::new();
            let mut tails = Vec::new();
            for f in &projection.delivery_frontiers {
                let target = if f.source == a {
                    b
                } else if f.source == b {
                    a
                } else {
                    continue;
                };
                if !f.waiting.contains(&target) {
                    continue;
                }
                let tail = discovery.suffix(f, target, &scope, projection);
                let index = tails.len();
                for (rank, edge, prefix, to, terminal) in
                    discovery.crossings(f, &scope, only_pending)
                {
                    if edge.endpoints != direct.endpoints
                        && edge.endpoints != preferred.endpoints
                        && tail.contains_key(&to)
                        && (!terminal || to == target)
                    {
                        choices.push((rank, edge, index, prefix, to));
                    }
                }
                tails.push(tail);
            }
            choices.sort_by_key(|entry| entry.0);
            for (_, edge, index, prefix, to) in choices {
                let prefix = path_segments(&prefix, to, &tails[index]);
                if book.try_completion(&edge, &prefix, protected, now, &limit) {
                    repair.trial = Some(edge);
                    repair.segments = prefix
                        .into_iter()
                        .filter_map(|p| DiscoveryEdge::current(p, identity))
                        .collect();
                    break;
                }
            }
        }
        book.finish_completions(&self.temporary, protected);
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
fn confirmed_prefix(
    confirmed: &BTreeSet<Pair>,
    scope: &BTreeSet<Uuid>,
    frontier: &DeliveryFrontier,
    mut at: Uuid,
) -> Option<BTreeSet<Pair>> {
    let mut prefix = BTreeSet::new();
    while at != frontier.source {
        let &next = frontier.before.get(&at)?;
        let key = pair(at, next);
        if !scope.contains(&next) || !confirmed.contains(&key) || !prefix.insert(key) {
            return None;
        }
        at = next;
    }
    Some(prefix)
}

impl Discovery<'_> {
    fn suffix(
        &self,
        frontier: &DeliveryFrontier,
        target: Uuid,
        scope: &BTreeSet<Uuid>,
        projection: &RoomProjection,
    ) -> BTreeMap<Uuid, Uuid> {
        frontier.tail(target, |a, b| {
            scope.contains(&a)
                && scope.contains(&b)
                && projection.relay_session_ids.contains(&a)
                && self.confirmed.contains(&pair(a, b))
        })
    }

    fn rank(&self, edge: &DiscoveryEdge, depth: usize) -> CrossingRank {
        (
            !self.confirmed.contains(&edge.endpoints),
            !self.transports.pending(edge),
            self.transports.retry_after(edge),
            depth_term(depth),
            edge.endpoints,
        )
    }

    fn crossings<'a>(
        &'a self,
        frontier: &'a DeliveryFrontier,
        scope: &'a BTreeSet<Uuid>,
        only_pending: bool,
    ) -> impl Iterator<Item = (CrossingRank, DiscoveryEdge, Rc<BTreeSet<Pair>>, Uuid, bool)> + 'a
    {
        let edges: Box<dyn Iterator<Item = (Uuid, Uuid, bool)> + 'a> = if only_pending {
            Box::new(
                self.transports
                    .pending_edges()
                    .flat_map(|e| {
                        let (a, b) = e.endpoints;
                        [(a, b), (b, a)]
                    })
                    .filter_map(|(a, b)| frontier.live_crossing(a, b)),
            )
        } else {
            Box::new(frontier.crossings())
        };
        let mut prefixes = BTreeMap::new();
        edges.filter_map(move |(from, to, terminal)| {
            if !scope.contains(&from) || !scope.contains(&to) {
                return None;
            }
            let key = pair(from, to);
            let edge = DiscoveryEdge::current(key, self.identity)?;
            if self.transports.has_pair(key)
                && !self.transports.pending(&edge)
                && !self.confirmed.contains(&key)
            {
                return None;
            }
            let prefix = prefixes
                .entry(from)
                .or_insert_with(|| {
                    confirmed_prefix(&self.confirmed, scope, frontier, from).map(Rc::new)
                })
                .as_ref()?;
            // The offered parent `from` is `prefix.len()` hops below the source.
            let rank = self.rank(&edge, prefix.len());
            Some((rank, edge, prefix.clone(), to, terminal))
        })
    }

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
    /// Study P1 only: this unconfirmed direct pair is still pending and has
    /// had its head start, so repair may race one alternative beside it.
    #[cfg(feature = "study")]
    fn raced(&self, direct: Pair) -> bool {
        !self.confirmed.contains(&direct) && self.transports.raced(&self.proposal(direct))
    }
    #[cfg(not(feature = "study"))]
    fn raced(&self, _: Pair) -> bool {
        false
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
    fn room_suggestions(
        &self,
        projection: &RoomProjection,
        scope: &BTreeSet<Uuid>,
        requested: &BTreeMap<Pair, bool>,
    ) -> BTreeMap<Pair, (DiscoveryEdge, BTreeSet<Pair>)> {
        let mut suggestions = BTreeMap::new();
        let mut chosen = BTreeMap::<Pair, CrossingRank>::new();
        for frontier in &projection.delivery_frontiers {
            let source = frontier.source;
            if !scope.contains(&source) {
                continue;
            }
            let targets: Vec<_> = frontier
                .waiting
                .iter()
                .copied()
                .filter(|&t| {
                    let direct = pair(source, t);
                    scope.contains(&t)
                        && requested.get(&direct) == Some(&true)
                        && (self.confirmed.contains(&direct)
                            || self.transports.rejected(&self.proposal(direct))
                            || self.raced(direct))
                })
                .collect();
            if targets.is_empty() {
                continue;
            }
            // Keep one extra option because a receiver's direct pair has its own request.
            let mut entering = BTreeMap::<(Uuid, bool), Vec<_>>::new();
            for (rank, edge, prefix, to, terminal) in self.crossings(frontier, scope, false) {
                let edges = entering.entry((to, terminal)).or_default();
                let pos = edges.partition_point(|(r, _, _)| *r <= rank);
                if pos < 2 {
                    edges.insert(pos, (rank, edge, prefix));
                    edges.truncate(2);
                }
            }
            for target in targets {
                let direct = pair(source, target);
                let tail = self.suffix(frontier, target, scope, projection);
                let best = entering
                    .iter()
                    .filter(|((to, leaf), _)| tail.contains_key(to) && (!*leaf || *to == target))
                    .filter_map(|(&(to, _), options)| {
                        options
                            .iter()
                            .find(|(_, e, _)| e.endpoints != direct)
                            .map(|(r, e, prefix)| (r, e, prefix, to))
                    })
                    .min_by_key(|(r, _, _, _)| **r);
                if let Some((r, edge, prefix, at)) = best {
                    if chosen.get(&direct).is_some_and(|old| old <= r) {
                        continue;
                    }
                    let segments = path_segments(prefix, at, &tail);
                    chosen.insert(direct, *r);
                    suggestions.insert(direct, (edge.clone(), segments));
                }
            }
        }
        suggestions
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
        let before = plan.advised.len();
        let mut suggestions = self.room_suggestions(projection, scope, requested);
        // A terminal direct failure opens one room-local recovery trial.
        for (&pair @ (source, viewer), &waiting) in requested {
            let allowed =
                |id| id == viewer || id == source || projection.relay_session_ids.contains(&id);
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
                let eligible: BTreeSet<_> =
                    scope.iter().copied().filter(|id| allowed(*id)).collect();
                let links: BTreeSet<_> = self
                    .confirmed
                    .iter()
                    .copied()
                    .filter(|(a, b)| eligible.contains(a) && eligible.contains(b))
                    .collect();
                (eligible, links)
            });
            if waiting {
                let mut proven = self
                    .transports
                    .failures()
                    .chain(self.transports.pending_edges())
                    .filter(|edge| self.current(edge) && self.transports.previously_confirmed(edge))
                    .map(|edge| {
                        (
                            edge.endpoints,
                            self.transports.retry_after(edge).unwrap_or(0),
                        )
                    })
                    .peekable();
                if proven.peek().is_some() {
                    let (eligible, links) = &*view;
                    if let Some(key) =
                        crate::connectivity::retry_candidate(eligible, links, pair, proven)
                    {
                        let edge = self.proposal(key);
                        plan.required_retries.insert(edge.clone());
                        plan.keep(edge.clone(), Interest::Activity);
                        let mut restore = Repair {
                            trial: Some(edge.clone()),
                            ..Repair::default()
                        };
                        let completes =
                            restore.retain_frontiers(source, viewer, links, |p| self.proposal(p));
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
            let confirmed_gap = waiting
                && self.confirmed.contains(&pair)
                && projection.delivery_frontiers.iter().any(|f| {
                    (f.source == source && f.waiting.contains(&viewer))
                        || (f.source == viewer && f.waiting.contains(&source))
                });
            let raced = waiting && self.raced(pair);
            if !self.transports.rejected(&direct) && !confirmed_gap {
                // Let admission skip a capacity-blocked request when another
                // waiting delivery in this room can start on different peers.
                if !self.confirmed.contains(&pair) {
                    if waiting {
                        plan.completions.push((direct.clone(), BTreeSet::new()));
                    }
                    plan.keep(direct.clone(), Interest::Activity);
                }
                if !raced {
                    continue;
                }
            }
            if !waiting {
                continue;
            }
            let (eligible, links) = &*view;
            demand.remove(&pair);
            let key = (projection.summary.id.clone(), direct);
            plan.retained.insert(key.clone());
            let repair = repairs.entry(key.clone()).or_default();
            repair.trial = None;
            repair.joined = false;
            let suggestion = suggestions.remove(&pair);
            if let Some((edge, prefix)) = &suggestion {
                if links.contains(&edge.endpoints) {
                    repair.joined = true;
                    repair.segments = prefix.iter().map(|&key| self.proposal(key)).collect();
                    repair.segments.insert(edge.clone());
                    for leg in &repair.segments {
                        plan.keep(leg.clone(), Interest::Delivery);
                    }
                    continue;
                }
            }
            let fresh = suggestion
                .as_ref()
                .filter(|(e, _)| !self.transports.rejected(e))
                .map(|(e, _)| e.endpoints);
            let trial = fresh
                .or_else(|| {
                    crate::connectivity::repair_candidate(
                        eligible,
                        links,
                        &[pair].into(),
                        |a, b| {
                            let e = self.proposal((a, b));
                            !links.contains(&(a, b))
                                && !(raced && (a, b) == pair)
                                && !self.transports.rejected(&e)
                                && (self.transports.pending(&e)
                                    || !self.transports.has_pair((a, b)))
                        },
                    )
                })
                .or_else(|| {
                    let failures = self.transports.failures().filter_map(|edge| {
                        if !self.current(edge) || self.transports.has_pair(edge.endpoints) {
                            return None;
                        }
                        Some((edge.endpoints, self.transports.retry_after(edge)?))
                    });
                    let physical =
                        crate::connectivity::retry_candidate(eligible, links, pair, failures);
                    let suggested = suggestion.as_ref().map(|(e, _)| e.endpoints);
                    physical
                        .into_iter()
                        .chain(suggested)
                        .min_by_key(|&p| self.transports.retry_after(&self.proposal(p)))
                });
            if let Some(edge) = trial {
                let trial = self.proposal(edge);
                if self.transports.rejected(&trial) {
                    plan.required_retries.insert(trial.clone());
                }
                plan.keep(trial.clone(), Interest::Activity);
                repair.trial = Some(trial);
            }
            if let Some((trial, prefix)) = suggestion
                .as_ref()
                .filter(|(e, _)| repair.trial.as_ref() == Some(e))
            {
                repair.joined = false;
                repair.segments = prefix.iter().map(|p| self.proposal(*p)).collect();
                if self.transports.pending(trial) {
                    for edge in &repair.segments {
                        plan.keep(edge.clone(), Interest::Activity);
                    }
                }
                plan.advised.insert(key);
                plan.completions.push((trial.clone(), prefix.clone()));
                continue;
            }
            let bridges =
                repair.retain_frontiers(source, viewer, links, |pair| self.proposal(pair));
            let interest = if repair.joined {
                Interest::Delivery
            } else {
                Interest::Activity
            };
            for edge in &repair.segments {
                plan.keep(edge.clone(), interest);
            }
            if let Some(trial) = repair.trial.as_ref().filter(|_| !repair.joined && bridges) {
                let prefix = repair.segments.iter().map(|edge| edge.endpoints).collect();
                plan.completions.push((trial.clone(), prefix));
            }
        }
        if plan.advised.len() > before {
            for &key in &self.confirmed {
                if scope.contains(&key.0) && scope.contains(&key.1) {
                    plan.keep(self.proposal(key), Interest::Recovering);
                    plan.temporary.insert(key);
                }
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
    pub(super) fn reconcile_transports(&mut self, endpoints: &BTreeMap<Uuid, Endpoint>) {
        #[cfg(feature = "study")]
        {
            self.transports.study_now = self.now;
        }
        let discovery = Discovery {
            identity: &self.identity,
            transports: &self.transports,
            confirmed: self.transports.confirmed_pairs(&self.identity).collect(),
        };
        let mut plan = DiscoveryPlan::default();
        let online = endpoints
            .iter()
            .filter_map(|(&id, endpoint)| endpoint.online_peer().then_some(id))
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
            scope.retain(|id| online.contains(id));
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
                    binding,
                    projection,
                    self.service_endpoint,
                    None,
                );
                discovery.carry(
                    projection,
                    &demand,
                    &retained_scope,
                    &self.repairs,
                    &mut plan,
                );
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
        plan.relevant_failures
            .extend(plan.interests.keys().cloned());
        self.transports.retain_failures(&plan.relevant_failures);
        // A covering projection acknowledges delivery. Keep that receipt for
        // this binding only while the physical failure still applies.
        for binding in self
            .remote
            .values_mut()
            .filter_map(|room| room.binding.as_mut())
        {
            binding.failed_pairs.retain(|&pair, revision| {
                *revision > binding.applied_revision
                    || DiscoveryEdge::current(pair, &self.identity)
                        .is_some_and(|edge| self.transports.rejected(&edge))
            });
        }
        let bound_projections = self
            .remote
            .values()
            .filter(|room| room.binding.is_some())
            .filter_map(|room| room.projection.as_ref());
        let service = self.service_endpoint;
        let limit = |id| {
            if service.is_some_and(|e| e.session_id == id) {
                crate::identity::MAX_SESSIONS - 1
            } else {
                PAIR_DEGREE_LIMIT
            }
        };
        self.transports.reconcile_with_fallback(
            bound_projections
                .clone()
                .flat_map(|projection| projection.flows.iter().cloned()),
            bound_projections.flat_map(RoomProjection::room_data_grants),
            &plan.interests,
            &plan.completions,
            &plan.required_retries,
            &self.transports.recovering_pairs(&self.identity),
            self.now,
            limit,
            |book, protected| {
                plan.finish_admission(
                    book,
                    &self.identity,
                    &mut self.repairs,
                    protected,
                    self.now,
                    limit,
                    |id| {
                        let room = self.remote.get(id)?;
                        Some((
                            room.projection.as_ref()?,
                            room.planning_sessions(service, None).intersection(&online).copied().collect(),
                        ))
                    },
                )
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
                        can_use_peer_transport: true,
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
    fn refused_file_rotates_terminal_pairs_and_commits_only_after_confirmation() {
        use crate::{
            access::RoomState,
            room::RoomRuntime,
            wire::{ByteBranchTarget, RoomAccess},
        };
        let mut identity = Identity::new(String::new());
        let peers = join(&mut identity, ["1", "2", "3", "4", "5", "6"]);
        let [src, left, left_block, dst, right_block, right] = peers;
        let endpoints = identity.endpoints();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "room".into(),
                "Room".into(),
                Default::default(),
                endpoints[&src].member.user_id,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        for &id in &peers {
            room.browse(endpoints[&id].member, id, true).unwrap();
        }
        let item = crate::AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "file".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        for (p, offer) in [(src, true), (dst, false)] {
            room.finish_file(
                p,
                1,
                endpoints[&src].member.user_id,
                item.clone(),
                offer,
                true,
            )
            .unwrap();
        }
        let pair = |a: Uuid, b: Uuid| (a.min(b), a.max(b));
        let edge = |p| DiscoveryEdge::current(p, &identity).unwrap();
        let direct = pair(src, dst);
        let ring: BTreeSet<_> = (0..6).map(|i| pair(peers[i], peers[(i + 1) % 6])).collect();
        let mut book = TransportBook::default();
        let mut keep = BTreeMap::new();
        for key in ring.iter().copied().chain([direct]) {
            let e = edge(key);
            keep.insert(e.clone(), Interest::Activity);
            book.reconcile_with_standby(
                [],
                [],
                &keep,
                &[],
                &BTreeSet::new(),
                &BTreeSet::new(),
                0,
                |_| 64,
            );
            let id = book
                .snapshot(key.0, |_| false, |_| false)
                .into_iter()
                .find(|p| p.peer_id == key.1)
                .unwrap()
                .id;
            if key == direct {
                book.retire(id, &identity, 0);
                keep.remove(&e);
            } else {
                book.connected(key.0, e.sockets.0, Some(e.sockets.1), id);
                assert!(book.connected(key.1, e.sockets.1, Some(e.sockets.0), id));
            }
        }
        let target = ByteBranchTarget::File {
            message_seq: 1,
            attachment_id: item.id,
            source_id: src,
        };
        for _ in 0..2 {
            room.reconcile_with_pairs(&endpoints, 1, &ring);
            let parent = room.projection(&endpoints).views[&dst].files[0]
                .upstream
                .unwrap();
            assert!([left_block, right_block].contains(&parent));
            room.refuse_byte_branch(endpoints[&parent].member, parent, target.clone(), dst)
                .unwrap();
        }
        room.reconcile_with_pairs(&endpoints, 2, &ring);
        let projection: RoomProjection =
            serde_json::from_value(serde_json::to_value(room.projection(&endpoints)).unwrap())
                .unwrap();
        assert_eq!(
            projection.delivery_frontiers[0]
                .candidates(dst)
                .filter(|&(a, b)| pair(a, b) != direct)
                .collect::<BTreeSet<_>>(),
            [(left, dst), (right, dst)].into()
        );
        let mut revoked = room.clone();
        revoked
            .set_relay_capacity(endpoints[&left].member, left, Some(0))
            .unwrap();
        revoked.reconcile_with_pairs(&endpoints, 2, &ring);
        assert!(revoked
            .projection(&endpoints)
            .delivery_frontiers
            .iter()
            .all(|f| f.candidates(dst).all(|(a, b)| a != left && b != left)));
        let mut attempted = BTreeSet::new();
        let mut repairs = Repairs::new();
        for step in 0..2 {
            let discovery = Discovery {
                identity: &identity,
                transports: &book,
                confirmed: book.confirmed_pairs(&identity).collect(),
            };
            let mut plan = DiscoveryPlan::default();
            discovery.repair(
                &projection,
                &peers.into(),
                &projection.requested_pairs(),
                &mut [direct].into(),
                &mut repairs,
                &mut plan,
            );
            let (e, prefix) = plan
                .completions
                .iter()
                .find(|(e, _)| e.endpoints != direct)
                .unwrap()
                .clone();
            let (a, b) = e.endpoints;
            let sender = if a == dst { b } else { a };
            assert!([left, right].contains(&sender) && attempted.insert(sender));
            assert_eq!(prefix, [pair(src, sender)].into());
            plan.interests.extend(keep.clone());
            book.reconcile_with_standby(
                [],
                [],
                &plan.interests,
                &plan.completions,
                &plan.required_retries,
                &BTreeSet::new(),
                3 + step,
                |_| 64,
            );
            let id = book
                .snapshot(a, |_| false, |_| false)
                .into_iter()
                .find(|p| p.peer_id == b)
                .unwrap()
                .id;
            if step == 0 {
                book.retire(id, &identity, 3);
                continue;
            }
            assert!(!book.connected(a, e.sockets.0, Some(e.sockets.1), id));
            assert_eq!(book.confirmed_pairs(&identity).count(), 6);
            assert!(book.connected(b, e.sockets.1, Some(e.sockets.0), id));
            room.reconcile_with_pairs(&endpoints, 5, &book.confirmed_pairs(&identity).collect());
            let delivered = room.projection(&endpoints);
            assert_eq!(delivered.views[&dst].files[0].upstream, Some(sender));
            assert!(delivered.delivery_frontiers.is_empty());
        }
    }

    #[test]
    fn capacity_wait_tries_a_second_authorized_room_completion() {
        use crate::{
            access::RoomState,
            room::RoomRuntime,
            wire::{ByteBranchTarget, RoomAccess},
        };
        let mut identity = Identity::new(String::new());
        let peers = join(&mut identity, ["1", "2", "3", "4", "5", "6"]);
        let [src, left, left_block, dst, right_block, right] = peers;
        let extra = join(&mut identity, ["extra"; 62]);
        let endpoints = identity.endpoints();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "room".into(),
                "Room".into(),
                Default::default(),
                endpoints[&src].member.user_id,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        for &id in &peers {
            room.browse(endpoints[&id].member, id, true).unwrap();
        }
        let item = crate::AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "file".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        for (p, offer) in [(src, true), (dst, false)] {
            room.finish_file(
                p,
                1,
                endpoints[&src].member.user_id,
                item.clone(),
                offer,
                true,
            )
            .unwrap();
        }
        let pair = |a: Uuid, b: Uuid| (a.min(b), a.max(b));
        let edge = |p| DiscoveryEdge::current(p, &identity).unwrap();
        let direct = pair(src, dst);
        let ring: BTreeSet<_> = (0..6).map(|i| pair(peers[i], peers[(i + 1) % 6])).collect();
        let mut book = TransportBook::default();
        let mut keep = BTreeMap::new();
        for key in ring.iter().copied().chain([direct]) {
            let e = edge(key);
            keep.insert(e.clone(), Interest::Activity);
            book.reconcile_with_standby(
                [],
                [],
                &keep,
                &[],
                &BTreeSet::new(),
                &BTreeSet::new(),
                0,
                |_| 64,
            );
            let id = book
                .snapshot(key.0, |_| false, |_| false)
                .into_iter()
                .find(|p| p.peer_id == key.1)
                .unwrap()
                .id;
            if key == direct {
                book.retire(id, &identity, 0);
                keep.remove(&e);
            } else {
                book.connected(key.0, e.sockets.0, Some(e.sockets.1), id);
                assert!(book.connected(key.1, e.sockets.1, Some(e.sockets.0), id));
            }
        }
        let target = ByteBranchTarget::File {
            message_seq: 1,
            attachment_id: item.id,
            source_id: src,
        };
        for _ in 0..2 {
            room.reconcile_with_pairs(&endpoints, 1, &ring);
            let parent = room.projection(&endpoints).views[&dst].files[0]
                .upstream
                .unwrap();
            assert!([left_block, right_block].contains(&parent));
            room.refuse_byte_branch(endpoints[&parent].member, parent, target.clone(), dst)
                .unwrap();
        }
        room.reconcile_with_pairs(&endpoints, 2, &ring);
        let projection: RoomProjection =
            serde_json::from_value(serde_json::to_value(room.projection(&endpoints)).unwrap())
                .unwrap();
        assert_eq!(
            projection.delivery_frontiers[0]
                .candidates(dst)
                .filter(|&(a, b)| pair(a, b) != direct)
                .collect::<BTreeSet<_>>(),
            [(left, dst), (right, dst)].into()
        );
        let mut revoked = room.clone();
        revoked
            .set_relay_capacity(endpoints[&left].member, left, Some(0))
            .unwrap();
        revoked.reconcile_with_pairs(&endpoints, 2, &ring);
        assert!(revoked
            .projection(&endpoints)
            .delivery_frontiers
            .iter()
            .all(|f| f.candidates(dst).all(|(a, b)| a != left && b != left)));

        let (first, alternate) = if pair(left, dst) < pair(right, dst) {
            (left, right)
        } else {
            (right, left)
        };
        let protected: Vec<_> = ring
            .iter()
            .copied()
            .chain(extra.iter().map(|&x| pair(first, x)))
            .map(|p| (p, String::from("stable-room-use")))
            .collect();
        book.reconcile_with_standby(
            [],
            protected.clone(),
            &keep,
            &[],
            &Default::default(),
            &Default::default(),
            2,
            |_| 64,
        );
        assert_eq!(
            book.admitted_pairs()
                .filter(|&(a, b)| a == first || b == first)
                .count(),
            64
        );
        let mut stable_room = RoomRuntime::new(
            RoomState::new(
                "stable-room-use".into(),
                "Other".into(),
                Default::default(),
                endpoints[&src].member.user_id,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        for (i, &(key, _)) in protected.iter().enumerate() {
            let row = book
                .snapshot(key.0, |_| false, |_| false)
                .into_iter()
                .find(|p| p.peer_id == key.1)
                .unwrap();
            let e = edge(key);
            book.connected(key.0, e.sockets.0, Some(e.sockets.1), row.id);
            book.connected(key.1, e.sockets.1, Some(e.sockets.0), row.id);
            let mut file = item.clone();
            file.id = Uuid::new_v4();
            let owner = if key.0 == first { key.1 } else { key.0 };
            let receiver = if key.0 == owner { key.1 } else { key.0 };
            for (id, offer) in [(owner, true), (receiver, false)] {
                stable_room
                    .finish_file(
                        id,
                        i as u64 + 1,
                        endpoints[&owner].member.user_id,
                        file.clone(),
                        offer,
                        true,
                    )
                    .unwrap();
            }
        }
        stable_room.reconcile_with_pairs(&endpoints, 2, &book.confirmed_pairs(&identity).collect());
        let stable = stable_room.projection(&endpoints);
        assert_eq!(
            stable
                .room_data_grants()
                .filter(|((a, b), _)| *a == first || *b == first)
                .count(),
            64
        );
        let mut channel = Channel::new(String::new(), vec![]);
        channel.identity = identity.clone();
        channel.transports = book;
        for next in [projection, stable] {
            let binding = crate::remote::Binding {
                id: Uuid::new_v4(),
                session: src,
                connection: identity.sessions[&src].connection.unwrap(),
                revision: 1,
                projection_floor: 1,
                scope_floor: 1,
                read_floor: 1,
                applied_revision: 1,
                replies: Default::default(),
                failed_pairs: Default::default(),
            };
            channel.remote.insert(
                next.summary.id.clone(),
                RemoteRoom {
                    summary: next.summary.clone(),
                    binding: Some(binding),
                    projection: Some(next),
                    reservation: None,
                    known_sessions: Default::default(),
                },
            );
        }
        let failed = edge(pair(first, dst));
        let alternative = edge(pair(alternate, dst));
        let stable_ids = |book: &TransportBook| {
            book.snapshot(first, |_| false, |_| false)
                .into_iter()
                .map(|pair| (pair.peer_id, pair.id))
                .collect::<BTreeMap<_, _>>()
        };
        let occupied = stable_ids(&channel.transports);
        let mut attempt = None;
        for now in [3, 4, 5] {
            channel.now = now;
            channel.reconcile_transports(&endpoints);
            assert!(!channel.transports.has_pair(failed.endpoints));
            assert!(!channel.transports.rejected(&failed));
            assert!(
                channel.transports.pending(&alternative),
                "blocked A must yield to B in the same channel reconciliation"
            );
            let repair = &channel.repairs[&("room".into(), edge(direct))];
            assert!(repair.trial.as_ref() == Some(&alternative));
            assert!(repair.segments == [edge(pair(src, alternate))].into());
            let id = channel
                .transports
                .snapshot(dst, |_| false, |_| false)
                .into_iter()
                .find(|p| p.peer_id == alternate)
                .unwrap()
                .id;
            assert_eq!(*attempt.get_or_insert(id), id);
            assert_eq!(stable_ids(&channel.transports), occupied);
            assert!(channel.transports.pending_edges().count() <= 4);
            assert!(
                channel
                    .transports
                    .pending_edges()
                    .filter(|e| [e.endpoints.0, e.endpoints.1].contains(&dst))
                    .count()
                    <= 2
            );
        }
        let id = attempt.unwrap();
        let (a, b) = alternative.endpoints;
        let (sa, sb) = alternative.sockets;
        assert!(!channel.transports.connected(a, sa, Some(sb), id));
        assert!(channel.transports.connected(b, sb, Some(sa), id));
        channel.reconcile_transports(&endpoints);
        room.reconcile_with_pairs(
            &endpoints,
            6,
            &channel.transports.confirmed_pairs(&identity).collect(),
        );
        let delivered = room.projection(&endpoints);
        assert_eq!(delivered.views[&dst].files[0].upstream, Some(alternate));
        channel.remote.get_mut("room").unwrap().projection = Some(delivered);
        channel.reconcile_transports(&endpoints);
        assert!(!channel.repairs.contains_key(&("room".into(), edge(direct))));
    }

    #[test]
    fn shared_suffix_preserves_each_waiters_direct_failure_gate() {
        use crate::{access::RoomState, room::RoomRuntime, wire::RoomAccess};
        let mut identity = Identity::new(String::new());
        let peers = join(
            &mut identity,
            ["source", "prefix", "bridge", "fresh", "failed"],
        );
        let [source, head, tail, fresh, failed] = peers;
        let endpoints = identity.endpoints();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "room".into(),
                "Room".into(),
                Default::default(),
                endpoints[&source].member.user_id,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        for id in peers {
            room.browse(endpoints[&id].member, id, true).unwrap();
        }
        let item = crate::AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "file".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        for (id, offer) in [(source, true), (fresh, false), (failed, false)] {
            room.finish_file(
                id,
                1,
                endpoints[&source].member.user_id,
                item.clone(),
                offer,
                true,
            )
            .unwrap();
        }
        let pair = |a: Uuid, b: Uuid| (a.min(b), a.max(b));
        let target = crate::wire::ByteBranchTarget::File {
            message_seq: 1,
            attachment_id: item.id,
            source_id: source,
        };
        room.reconcile_with_pairs(
            &endpoints,
            0,
            &[pair(source, head), pair(head, fresh)].into(),
        );
        room.refuse_byte_branch(endpoints[&head].member, head, target, fresh)
            .unwrap();
        let confirmed = [pair(source, head), pair(tail, fresh), pair(tail, failed)].into();
        room.reconcile_with_pairs(&endpoints, 0, &confirmed);
        let projection = room.projection(&endpoints);
        assert_eq!(projection.delivery_frontiers.len(), 1);
        assert_eq!(
            projection.delivery_frontiers[0].waiting,
            [fresh, failed].into()
        );
        let mut book = TransportBook::default();
        let key = pair(source, failed);
        let edge = DiscoveryEdge::current(key, &identity).unwrap();
        book.reconcile_with_standby(
            [],
            [],
            &[(edge, Interest::Activity)].into(),
            &[],
            &BTreeSet::new(),
            &BTreeSet::new(),
            0,
            |_| 64,
        );
        let id = book.snapshot(key.0, |_| false, |_| false)[0].id;
        book.retire(id, &identity, 1);
        let discovery = Discovery {
            identity: &identity,
            transports: &book,
            confirmed,
        };
        let suggestions =
            discovery.room_suggestions(&projection, &peers.into(), &projection.requested_pairs());
        assert_eq!(
            suggestions.keys().copied().collect::<BTreeSet<_>>(),
            [key].into()
        );
        assert_ne!(suggestions[&key].0.endpoints, key);
    }

    #[test]
    fn host_frame_keeps_the_full_reply_and_only_advice_that_fits() {
        use crate::{
            access::RoomState,
            host::{DeliveryFrontier, HostOutput},
            room::RoomRuntime,
            wire::{Command, RoomAccess, CHANNEL_MESSAGE_BYTES},
        };
        let mut identity = Identity::new(String::new());
        let [source, viewer] = join(&mut identity, ["source", "viewer"]);
        let endpoints = identity.endpoints();
        let room = RoomRuntime::new(
            RoomState::new(
                "room".into(),
                "Room".into(),
                Default::default(),
                endpoints[&source].member.user_id,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        let mut output = HostOutput {
            binding_id: source,
            revision: 17,
            projection: room.projection(&endpoints),
            reply: None,
        };
        let hint = DeliveryFrontier {
            source,
            before: [(source, source)].into(),
            after: vec![viewer],
            waiting: [viewer].into(),
            suffix: vec![0],
            bridges: vec![1],
            ..Default::default()
        };
        let frame = |output: &HostOutput| {
            serde_json::to_vec(&Command::HostOutput {
                room_id: output.projection.summary.id.clone(),
                output: output.clone(),
            })
            .unwrap()
        };
        output.projection.picture = Some(String::new());
        output.projection.delivery_frontiers.push(hint.clone());
        let padding = CHANNEL_MESSAGE_BYTES - frame(&output).len();
        output.projection.picture = Some("x".repeat(padding));
        assert_eq!(frame(&output).len(), CHANNEL_MESSAGE_BYTES);
        let expected = frame(&output);
        output.projection.delivery_frontiers.push(hint);
        assert!(frame(&output).len() > CHANNEL_MESSAGE_BYTES);
        let fitted = output.within_domain_frame();
        assert_eq!(fitted.projection.delivery_frontiers.len(), 1);
        assert_eq!(frame(&fitted), expected);
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
