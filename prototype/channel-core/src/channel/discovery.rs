//! Select room-authorized connections and retain in-progress paths until delivery takes over.
use super::Channel;
use crate::host::RoomProjection;
use crate::identity::{Endpoint, Identity};
use crate::transport::{DiscoveryEdge, TransportBook};
use crate::remote::RemoteRoom;
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
pub(super) type Repairs = BTreeMap<(String, DiscoveryEdge), Repair>;
#[derive(Default)]
struct DiscoveryPlan {
    retained: BTreeSet<(String, DiscoveryEdge)>,
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
        requested: &BTreeMap<Pair, bool>,
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
        for (&pair @ (source, viewer), &waiting) in requested {
            let allowed = |id| id == viewer || id == source || readers.contains(&id);
            plan.relevant_failures.extend(
                self.transports
                    .failures()
                    .filter(|edge| {
                        allowed(edge.endpoints.0) && allowed(edge.endpoints.1) && self.current(edge)
                    })
                    .cloned(),
            );
            if !scope.contains(&viewer) || !scope.contains(&source) || !waiting {
                continue;
            }
            let direct = self.proposal(pair);
            if !self.transports.rejected(&direct) {
                continue;
            }
            demand.remove(&pair);
            let key = (projection.summary.id.clone(), direct);
            plan.retained.insert(key.clone());
            let repair = repairs.entry(key).or_default();
            repair.segments.clear();
            repair.trial = None;
            let eligible: BTreeSet<_> = scope.iter().copied().filter(|id| allowed(*id)).collect();
            let links: BTreeSet<_> = self
                .confirmed
                .iter()
                .copied()
                .filter(|(a, b)| eligible.contains(a) && eligible.contains(b))
                .collect();
            let joined =
                repair.retain_frontiers(source, viewer, &links, |pair| self.proposal(pair));
            if let Some(edge) =
                crate::connectivity::repair_candidate(&eligible, &links, &[pair].into(), |a, b| {
                    let e = self.proposal((a, b));
                    !links.contains(&(a, b))
                        && !self.transports.rejected(&e)
                        && (self.discovery == Some((a, b)) || !self.transports.has_pair((a, b)))
                })
            {
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

    fn ordinary(
        &self,
        scope: &BTreeSet<Uuid>,
        graph: &BTreeSet<Pair>,
        demand: &BTreeSet<Pair>,
        plan: &mut DiscoveryPlan,
    ) {
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
                plan.preparing
                    .extend(discovery.confirmed.intersection(&demand).copied());
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
            plan.standby.extend(&graph);
            plan.preparing.extend(graph.intersection(&demand).copied());
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
            .extend(plan.candidates.iter().cloned());
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
            &plan.standby,
            &plan.preparing,
            &plan.candidates,
            self.now,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::Admission;

    #[test]
    fn first_room_demand_proposes_only_the_authorized_pair() {
        let mut identity = Identity::new(String::new());
        let [source, receiver, outsider] = ["Source", "Receiver", "Outsider"].map(|name| {
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
        });
        let direct = (source.min(receiver), source.max(receiver));
        let outside = (source.min(outsider), source.max(outsider));
        let discovery = Discovery {
            identity: &identity,
            transports: &TransportBook::default(),
            confirmed: BTreeSet::new(),
            discovery: None,
        };
        let mut plan = DiscoveryPlan::default();
        discovery.ordinary(
            &[source, receiver].into(),
            &discovery.confirmed,
            &[direct, outside].into(),
            &mut plan,
        );
        assert_eq!(plan.candidates.len(), 1);
        assert!(plan.candidates.contains(&discovery.proposal(direct)));
    }
}
