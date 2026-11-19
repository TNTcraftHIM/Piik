//! Select room-authorized connections and retain in-progress paths until delivery takes over.
use super::Channel;
use crate::host::RoomProjection;
use crate::identity::{Endpoint, Identity};
use crate::transport::{DiscoveryEdge, TransportBook};
use crate::wire::Kind;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Default)]
pub(super) struct Repair {
    segments: BTreeSet<DiscoveryEdge>,
    trial: Option<DiscoveryEdge>,
}

impl Repair {
    fn retain_frontiers(
        &mut self,
        source: Uuid,
        viewer: Uuid,
        links: &BTreeSet<(Uuid, Uuid)>,
        proposal: impl Fn((Uuid, Uuid)) -> DiscoveryEdge,
    ) -> bool {
        let mut reached = BTreeSet::new();
        let mut joined = false;
        for root in [source, viewer] {
            if !reached.insert(root) {
                joined = true;
                continue;
            }
            loop {
                let before = reached.len();
                for &(a, b) in links {
                    if reached.contains(&a) != reached.contains(&b) {
                        reached.extend([a, b]);
                        self.segments.insert(proposal((a, b)));
                    }
                }
                if before == reached.len() {
                    break;
                }
            }
        }
        joined
    }
}

type Pair = (Uuid, Uuid);
type Repairs = BTreeMap<(Uuid, DiscoveryEdge), Repair>;
#[derive(Default)]
struct DiscoveryPlan {
    retained: BTreeSet<(Uuid, DiscoveryEdge)>,
    preparing: BTreeSet<Pair>,
    relevant_failures: BTreeSet<DiscoveryEdge>,
    standby: BTreeSet<Pair>,
    candidates: BTreeSet<DiscoveryEdge>,
}
struct Discovery<'a> {
    identity: &'a Identity,
    transports: &'a TransportBook,
    confirmed: BTreeSet<Pair>,
    discovery: Option<Pair>,
}
impl Discovery<'_> {
    fn proposal(&self, endpoints: Pair) -> DiscoveryEdge {
        let (a, b) = endpoints;
        DiscoveryEdge {
            endpoints,
            sockets: (
                self.identity.sessions[&a].connection.unwrap(),
                self.identity.sessions[&b].connection.unwrap(),
            ),
        }
    }
    fn current(&self, edge: &DiscoveryEdge) -> bool {
        let socket = |id| self.identity.sessions.get(&id).and_then(|s| s.connection);
        socket(edge.endpoints.0).zip(socket(edge.endpoints.1)) == Some(edge.sockets)
    }
    fn carry(
        &self,
        projection: &RoomProjection,
        repairs: &Repairs,
        plan: &mut DiscoveryPlan,
    ) {
        let carried = |id: &Uuid| {
            projection.participant_session_ids.contains(id)
                && projection.views.get(id).is_some_and(|v| v.authorized)
        };

        for (key, repair) in repairs {
            let (screen, edge) = key;
            if projection.publications.iter().any(|p| p.id == *screen)
                && carried(&edge.endpoints.0)
                && carried(&edge.endpoints.1)
                && self.current(edge)
            {
                plan.retained.insert(key.clone());
                let carried_edge = |e: &DiscoveryEdge| {
                    carried(&e.endpoints.0) && carried(&e.endpoints.1) && self.current(e)
                };
                plan.preparing.extend(
                    repair
                        .segments
                        .iter()
                        .chain(repair.trial.iter())
                        .filter(|e| carried_edge(e) && self.confirmed.contains(&e.endpoints))
                        .map(|e| e.endpoints),
                );
                if let Some(e) = repair.trial.as_ref().filter(|e| {
                    carried_edge(e)
                        && Some(e.endpoints) == self.discovery
                        && !self.confirmed.contains(&e.endpoints)
                }) {
                    plan.candidates.insert(e.clone());
                }
            }
        }
    }
    fn repair(
        &self,
        projection: &RoomProjection,
        scope: &BTreeSet<Uuid>,
        demand: &mut BTreeSet<Pair>,
        repairs: &mut Repairs,
        plan: &mut DiscoveryPlan,
    ) {
        let readers: BTreeSet<_> = projection
            .views
            .iter()
            .filter_map(|(&id, v)| {
                (v.authorized
                    && v.reading
                    && v.relay_override
                        .unwrap_or(projection.summary.relay_capacity)
                        > 0)
                .then_some(id)
            })
            .collect();
        // A terminal direct failure opens one room-local recovery trial.
        for (&viewer, view) in &projection.views {
            if !view.authorized {
                continue;
            }
            for screen in &view.subscriptions {
                let Some(publication) = projection
                    .publications
                    .iter()
                    .find(|p| p.id == *screen && p.kind == Kind::Screen && !p.paused)
                else {
                    continue;
                };
                let source = publication.session_id;
                let pair = (source.min(viewer), source.max(viewer));
                let allowed = |id| id == viewer || id == source || readers.contains(&id);
                plan.relevant_failures.extend(
                    self.transports
                        .failures()
                        .filter(|edge| {
                            allowed(edge.endpoints.0)
                                && allowed(edge.endpoints.1)
                                && self.current(edge)
                        })
                        .cloned(),
                );
                if !scope.contains(&viewer)
                    || !scope.contains(&source)
                    || !self
                        .transports
                        .rejected(&self.proposal(pair))
                    || !view.failed_subscriptions.contains(screen)
                {
                    continue;
                }
                demand.remove(&pair);
                let key = (*screen, self.proposal(pair));
                plan.retained.insert(key.clone());
                let repair = repairs.entry(key).or_default();
                repair.segments.clear();
                repair.trial = None;
                let eligible: BTreeSet<_> =
                    scope.iter().copied().filter(|id| allowed(*id)).collect();
                let links: BTreeSet<_> = self
                    .confirmed
                    .iter()
                    .copied()
                    .filter(|(a, b)| eligible.contains(a) && eligible.contains(b))
                    .collect();
                let joined =
                    repair.retain_frontiers(source, viewer, &links, |pair| self.proposal(pair));
                if let Some(edge) = crate::connectivity::repair_candidate(
                    &eligible,
                    &links,
                    &[pair].into(),
                    |a, b| {
                        let e = self.proposal((a, b));
                        !links.contains(&(a, b))
                            && !self.transports.rejected(&e)
                            && (self.discovery == Some((a, b)) || !self.transports.has_pair((a, b)))
                    },
                ) {
                    let trial = self.proposal(edge);
                    plan.candidates.insert(trial.clone());
                    repair.trial = Some(trial);
                }
                if joined || repair.trial.is_some() {
                    plan.preparing
                        .extend(repair.segments.iter().map(|e| e.endpoints));
                } else {
                    repair.segments.clear();
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
        if demand.is_empty() || graph.is_empty() {
            return;
        }
        let available = |a: Uuid, b: Uuid| {
            let pair = (a.min(b), a.max(b));
            Some(pair) == self.discovery || !self.transports.has_pair(pair)
        };
        if let Some(first) = crate::connectivity::candidate(scope, graph, demand, available) {
            let edge = self.proposal(first);
            // Keep a single alternative per room after a failed primary.
            // Retaining both proposals keeps failed generations fenced.
            if self.transports.rejected(&edge) {
                if let Some(next) = crate::connectivity::candidate(scope, graph, demand, |a, b| {
                    (a, b) != first && available(a, b)
                }) {
                    plan.candidates.insert(self.proposal(next));
                }
            }
            plan.candidates.insert(edge);
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
            discovery: self.transports.discovery_endpoints(),
        };
        let mut plan = DiscoveryPlan::default();
        for room in self
            .remote
            .values()
            .filter(|room| Self::host_online(&self.identity, room))
        {
            let Some(projection) = &room.projection else {
                continue;
            };
            let mut demand = projection.requested_pairs();
            let mut scope = room.planning_sessions(self.service_endpoint, None);
            scope.retain(|id| endpoints.get(id).is_some_and(|endpoint| endpoint.connected));
            // While the host acknowledges a failed pair, only carry existing uses
            // from that projection. Other invalidations wait for fresh room grants.
            if scope.is_empty()
                && room.binding.as_ref().is_some_and(|b| {
                    b.projection_floor == b.applied_revision + 1
                        && b.failed_pairs.values().any(|v| *v == b.projection_floor)
                })
            {
                plan.preparing
                    .extend(discovery.confirmed.intersection(&demand).copied());
                discovery.carry(projection, &self.repairs, &mut plan);
            }
            let graph: BTreeSet<_> = discovery
                .confirmed
                .iter()
                .copied()
                .filter(|(a, b)| scope.contains(a) && scope.contains(b))
                .collect();
            plan.standby.extend(&graph);
            plan.preparing.extend(graph.intersection(&demand).copied());
            discovery.repair(
                projection,
                &scope,
                &mut demand,
                &mut self.repairs,
                &mut plan,
            );
            discovery.ordinary(&scope, &graph, &demand, &mut plan);
        }
        self.repairs.retain(|key, _| plan.retained.contains(key));
        plan.relevant_failures
            .extend(plan.candidates.iter().cloned());
        self.transports.retain_failures(&plan.relevant_failures);
        self.transports.reconcile_with_standby(
            self.remote
                .values()
                .filter(|room| room.binding.is_some())
                .filter_map(|room| room.projection.as_ref())
                .flat_map(|projection| projection.flows.iter().cloned()),
            self.remote
                .values()
                .filter(|room| room.binding.is_some())
                .filter_map(|room| room.projection.as_ref())
                .flat_map(|projection| projection.base_links.iter().cloned()),
            &plan.standby,
            &plan.preparing,
            &plan.candidates,
            self.now,
        );
    }
}
