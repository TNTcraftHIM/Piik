use crate::wire::PairInfo;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub publication_id: Uuid,
    pub sender: Uuid,
    pub receiver: Uuid,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseLink {
    pub room_id: String,
    pub parent: Uuid,
    pub child: Uuid,
}

#[derive(Clone, Default)]
struct Directions {
    forward: BTreeSet<Uuid>,
    reverse: BTreeSet<Uuid>,
    rooms: BTreeSet<String>,
}

#[derive(Clone)]
struct Pair {
    id: Uuid,
    flows: Directions,
}

/// Logical flow leases share one pair identity until the last lease retires.
#[derive(Clone, Default)]
pub struct TransportBook {
    pairs: BTreeMap<(Uuid, Uuid), Pair>,
}

impl TransportBook {
    pub fn reconcile(
        &mut self,
        flows: impl IntoIterator<Item = Flow>,
        base: impl IntoIterator<Item = BaseLink>,
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
            .insert(flow.publication_id);
        }
        for link in base {
            let key = if link.parent < link.child {
                (link.parent, link.child)
            } else {
                (link.child, link.parent)
            };
            needed.entry(key).or_default().rooms.insert(link.room_id);
        }
        self.pairs.retain(|key, _| needed.contains_key(key));
        for (key, flows) in needed {
            self.pairs
                .entry(key)
                .or_insert_with(|| Pair {
                    id: Uuid::new_v4(),
                    flows: Directions::default(),
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

    pub fn allows(&self, id: Uuid, sender: Uuid, publication: Uuid) -> bool {
        self.pairs.iter().any(|((first, second), pair)| {
            pair.id == id
                && ((*first == sender && pair.flows.forward.contains(&publication))
                    || (*second == sender && pair.flows.reverse.contains(&publication)))
        })
    }

    pub fn serves_room(&self, id: Uuid, room: &str) -> bool {
        self.pairs
            .values()
            .any(|pair| pair.id == id && pair.flows.rooms.contains(room))
    }

    pub fn retire(&mut self, id: Uuid) {
        self.pairs.retain(|_, pair| pair.id != id);
    }

    pub fn snapshot(&self, endpoint: Uuid) -> Vec<PairInfo> {
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
                    peer_id: peer,
                    rooms: pair.flows.rooms.iter().cloned().collect(),
                    outgoing: outgoing.iter().copied().collect(),
                    incoming: incoming.iter().copied().collect(),
                })
            })
            .collect()
    }
}
