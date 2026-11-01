use crate::wire::{FlowBinding, PairInfo, UdpPreparation};
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
    ever_connected: bool,
}

/// Logical flow leases share one current physical attempt until the last retires.
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
        self.pairs.retain(|key, _| needed.contains_key(key));
        for (key, flows) in needed {
            self.pairs
                .entry(key)
                .or_insert_with(|| Pair {
                    id: Uuid::new_v4(),
                    flows: Directions::default(),
                    attempt: Attempt::Ordinary,
                    ever_connected: false,
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
            })
        })
    }

    pub fn serves_room(&self, id: Uuid, room: &str) -> bool {
        self.pairs
            .values()
            .any(|pair| pair.id == id && pair.flows.rooms.contains(room))
    }

    pub fn connected(&mut self, id: Uuid) {
        if let Some(pair) = self.pairs.values_mut().find(|pair| pair.id == id) {
            pair.ever_connected = true;
        }
    }

    // The caller authorizes both current online capabilities. Only this book
    // replaces a physical attempt; logical leases and their deadlines stay put.
    pub fn prepare(&mut self, id: Uuid) -> bool {
        let Some(pair) = self.pairs.values_mut().find(|pair| pair.id == id) else {
            return false;
        };
        if pair.attempt != Attempt::Ordinary || pair.ever_connected {
            return false;
        }
        pair.id = Uuid::new_v4();
        pair.attempt = Attempt::Prepared;
        true
    }

    pub fn retire(&mut self, id: Uuid) {
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
                        Attempt::Ordinary if !pair.ever_connected && can_prepare(peer) => {
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
