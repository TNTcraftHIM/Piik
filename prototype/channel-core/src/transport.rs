use crate::wire::{FlowBinding, FlowState, PairInfo, UdpPreparation};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseLink {
    pub room_id: String,
    pub parent: Uuid,
    pub child: Uuid,
    pub ready: bool,
    pub selected: bool,
}

#[derive(Clone, Default)]
struct Directions {
    forward: BTreeMap<Uuid, FlowBinding>,
    reverse: BTreeMap<Uuid, FlowBinding>,
    rooms: BTreeSet<String>,
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
    attempt: Attempt,
    confirmed_by: [Option<Uuid>; 2],
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct DiscoveryEdge {
    pub endpoints: (Uuid, Uuid),
    pub sockets: (Uuid, Uuid),
}

/// Current physical attempts shared by flow, room and standby interests.
#[derive(Clone, Default)]
pub struct TransportBook {
    // One optional trial for the channel. A terminal failure is remembered
    // only while the same demand and socket generations still justify it.
    discovery: Option<DiscoveryEdge>,
    rejected: BTreeSet<DiscoveryEdge>,
    discovery_deadline: Option<u64>,
    pairs: BTreeMap<(Uuid, Uuid), Pair>,
}

impl TransportBook {
    pub(crate) fn discovery_endpoints(&self) -> Option<(Uuid, Uuid)> {
        self.discovery.as_ref().map(|edge| edge.endpoints)
    }

    pub(crate) fn rejected(&self, edge: &DiscoveryEdge) -> bool {
        self.rejected.contains(edge)
    }

    pub(crate) fn has_pair(&self, endpoints: (Uuid, Uuid)) -> bool {
        self.pairs.contains_key(&endpoints)
    }

    #[cfg(test)]
    pub fn reconcile(
        &mut self,
        flows: impl IntoIterator<Item = Flow>,
        base: impl IntoIterator<Item = BaseLink>,
    ) {
        self.reconcile_with_standby(flows, base, &BTreeSet::new(), &BTreeSet::new(), 0);
    }

    pub(crate) fn reconcile_with_standby(
        &mut self,
        flows: impl IntoIterator<Item = Flow>,
        base: impl IntoIterator<Item = BaseLink>,
        standby: &BTreeSet<(Uuid, Uuid)>,
        candidates: &BTreeSet<DiscoveryEdge>,
        now: u64,
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
        for link in base {
            let key = if link.parent < link.child {
                (link.parent, link.child)
            } else {
                (link.child, link.parent)
            };
            needed.entry(key).or_default().rooms.insert(link.room_id);
        }
        self.rejected.retain(|edge| candidates.contains(edge));
        if self
            .discovery
            .as_ref()
            .is_some_and(|edge| !candidates.contains(edge))
        {
            self.discovery_deadline = None;
            if let Some(old) = self.discovery.take() {
                // A socket takeover may immediately produce the same endpoints
                // with a different generation. Discard the old optional attempt.
                if !needed.contains_key(&old.endpoints) && !standby.contains(&old.endpoints) {
                    self.pairs.remove(&old.endpoints);
                }
            }
        }
        if self.discovery.is_none() {
            self.discovery = candidates
                .iter()
                .find(|edge| !needed.contains_key(&edge.endpoints) && !self.rejected.contains(edge))
                .cloned();
            self.discovery_deadline = self
                .discovery
                .as_ref()
                .map(|_| now.saturating_add(crate::publication::SCREEN_PREPARE_MS));
        }
        if let Some(edge) = &self.discovery {
            if needed.contains_key(&edge.endpoints) || standby.contains(&edge.endpoints) {
                self.discovery_deadline = None;
            }
            needed.entry(edge.endpoints).or_default();
        }
        // An idle endpoint can keep one known neighbor. Active or preparing
        // work takes precedence at both ends, including the same pair.
        let mut occupied: BTreeSet<_> = needed.keys().flat_map(|&(a, b)| [a, b]).collect();
        for &(a, b) in standby {
            if !occupied.contains(&a) && !occupied.contains(&b) {
                needed.entry((a, b)).or_default();
                occupied.extend([a, b]);
            }
        }
        self.pairs.retain(|key, _| needed.contains_key(key));
        for (key, flows) in needed {
            self.pairs
                .entry(key)
                .or_insert_with(|| Pair {
                    id: Uuid::new_v4(),
                    flows: Directions::default(),
                    attempt: Attempt::Ordinary,
                    confirmed_by: [None; 2],
                })
                .flows = flows;
        }
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
        if confirmed
            && self
                .discovery
                .as_ref()
                .is_some_and(|edge| edge.endpoints == (*first, *second))
        {
            self.discovery_deadline = None;
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
    pub fn prepare(&mut self, id: Uuid) -> bool {
        let Some(pair) = self.pairs.values_mut().find(|pair| pair.id == id) else {
            return false;
        };
        if pair.attempt != Attempt::Ordinary || pair.confirmed_by != [None; 2] {
            return false;
        }
        pair.id = Uuid::new_v4();
        pair.attempt = Attempt::Prepared;
        true
    }

    pub(crate) fn expire_discovery(&mut self, now: u64) -> bool {
        if self
            .discovery_deadline
            .is_none_or(|deadline| deadline > now)
        {
            return false;
        }
        let edge = self.discovery.take().unwrap();
        self.pairs.remove(&edge.endpoints);
        self.rejected.insert(edge);
        self.discovery_deadline = None;
        true
    }

    pub fn retire(&mut self, id: Uuid) {
        if self
            .discovery
            .as_ref()
            .and_then(|edge| self.pairs.get(&edge.endpoints))
            .is_some_and(|pair| pair.id == id)
        {
            self.rejected.insert(self.discovery.take().unwrap());
            self.discovery_deadline = None;
        }
        self.pairs.retain(|_, pair| pair.id != id);
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
