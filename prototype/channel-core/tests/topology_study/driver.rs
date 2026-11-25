//! Drives the real channel authority and room host through the public command
//! path the other integration tests use. The harness plays every endpoint: it
//! answers each proposed physical pair from the connectivity script and proves
//! every assigned flow as a healthy client would. It never plans anything.

use super::model::Script;
use crate::support::RoomNetwork;
use piik_channel_core::{
    host::RoomResult,
    topology::RoomTopology,
    wire::{Event, Request, RoomAccess},
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Upper bound on answer rounds after one event. Reaching it is reported.
const SETTLE_ROUNDS: usize = 400;

pub struct Person {
    pub connection: Uuid,
    pub session: Uuid,
}

/// The tree and graph the room reports at one instant, in participant indices.
#[derive(Clone, Default)]
pub struct Observation {
    /// child -> parent for selected screen flows.
    pub parent: BTreeMap<usize, usize>,
    /// Prepared but unselected flows (an operation in progress).
    pub preparing: usize,
    /// Receivers with more than one selected input (should not happen).
    pub doubled: usize,
    /// Confirmed pairs among the room's planning sessions, as (low, high).
    pub confirmed: BTreeSet<(usize, usize)>,
}

pub struct Driver {
    pub net: RoomNetwork,
    pub people: Vec<Person>,
    rank: BTreeMap<Uuid, usize>,
    pub room: String,
    pub screen: Uuid,
    pub source: usize,
    pub now: u64,
    connectable: Vec<Vec<bool>>,
    answered: BTreeSet<(usize, Uuid)>,
    attempted: BTreeSet<Uuid>,
    proved: BTreeMap<(usize, Uuid), u8>,
    pub online: Vec<bool>,
    pub viewing: Vec<bool>,
    /// Commands the core rejected with an error, and settle loops cut short.
    pub errors: usize,
    pub unsettled: usize,
    pub pair_attempts: usize,
    pub pair_failures: usize,
    /// Physical pairs each side has answered as connected.
    connected: BTreeSet<(usize, Uuid)>,
    /// Every participant pair confirmed at any moment of the session: both
    /// sides answered the same physical pair as connected, which is when the
    /// core's pair book confirms it (`TransportBook::connected`). Tracked here
    /// rather than from observations so a pair confirmed and released within
    /// one settle loop still counts.
    pub ever_confirmed: BTreeSet<(usize, usize)>,
}

impl Driver {
    /// Joins every participant at once so that session identifiers can be
    /// ranked; participant `i` is the `i`-th identifier. Nobody enters the
    /// room until the script says so.
    pub fn new(script: &Script, limit: u8) -> Self {
        let mut net = RoomNetwork::new();
        let now = 100;
        let mut people = Vec::new();
        for _ in 0..script.people {
            let connection = Uuid::new_v4();
            let session = net
                .command_at(connection, json!({"type":"join","name":"Participant"}), now)
                .events
                .into_iter()
                .find_map(|(_, event)| match event {
                    Event::Welcome { session_id, .. } => Some(session_id),
                    _ => None,
                })
                .expect("joined channel");
            people.push(Person {
                connection,
                session,
            });
        }
        people.sort_by_key(|person| person.session);
        let rank = people
            .iter()
            .enumerate()
            .map(|(index, person)| (person.session, index))
            .collect();
        let source = script.source;
        let room = net.create(people[source].connection, RoomAccess::Public, false);
        let mut driver = Self {
            net,
            people,
            rank,
            room,
            screen: Uuid::from_u128(u128::from(script.seed) << 64 | 0x5C2EE7),
            source,
            now,
            connectable: script.connectable.clone(),
            answered: BTreeSet::new(),
            attempted: BTreeSet::new(),
            proved: BTreeMap::new(),
            online: vec![true; script.people],
            viewing: vec![false; script.people],
            errors: 0,
            unsettled: 0,
            pair_attempts: 0,
            pair_failures: 0,
            connected: BTreeSet::new(),
            ever_confirmed: BTreeSet::new(),
        };
        let room = driver.room.clone();
        driver.send(
            source,
            json!({"type":"update_room","roomId":room,"relayCapacity":limit}),
        );
        driver.send(source, json!({"type":"browse","roomId":room,"active":true}));
        let screen = driver.screen;
        driver.send(
            source,
            json!({"type":"publish","publication":{"id":screen,"roomId":room,"kind":"screen",
                "source":{"kind":"screen","name":null},"videoSettings":{
                "ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":30,"maxBitrate":2500000},
                "degradationPreference":"balanced"}}}),
        );
        driver.settle();
        driver
    }

    fn send(&mut self, person: usize, command: Value) {
        let effects = self
            .net
            .command_at(self.people[person].connection, command, self.now);
        if effects.events.iter().any(|(_, event)| {
            matches!(
                event,
                Event::Error { .. }
                    | Event::RoomReply {
                        result: RoomResult::Error { .. },
                        ..
                    }
            )
        }) {
            self.errors += 1;
        }
    }

    pub fn advance(&mut self, now: u64) {
        self.now = self.now.max(now);
        let effects = self.net.authority.expire(self.now);
        self.net.deliver(effects);
        self.settle();
    }

    pub fn arrive(&mut self, person: usize) {
        let room = self.room.clone();
        self.send(person, json!({"type":"browse","roomId":room,"active":true}));
        self.subscribe(person, true);
    }

    pub fn subscribe(&mut self, person: usize, enabled: bool) {
        self.viewing[person] = enabled;
        let screen = self.screen;
        self.send(
            person,
            json!({"type":"subscribe","publicationId":screen,"enabled":enabled}),
        );
        self.settle();
    }

    pub fn leave(&mut self, person: usize) {
        self.send(person, json!({"type":"leave"}));
        self.online[person] = false;
        self.viewing[person] = false;
        self.settle();
    }

    /// Answers every outstanding pair and flow until a full round changes nothing.
    pub fn settle(&mut self) {
        for _ in 0..SETTLE_ROUNDS {
            if !self.answer_round() {
                return;
            }
        }
        self.unsettled += 1;
    }

    fn answer_round(&mut self) -> bool {
        let mut acted = false;
        for person in 0..self.people.len() {
            if !self.online[person] {
                continue;
            }
            let connection = self.people[person].connection;
            let mut pairs = self.net.state(connection).pairs.clone();
            pairs.sort_by_key(|pair| self.rank.get(&pair.peer_id).copied());
            for pair in pairs {
                let Some(&peer) = self.rank.get(&pair.peer_id) else {
                    continue;
                };
                if self.answered.insert((person, pair.id)) {
                    acted = true;
                    if self.attempted.insert(pair.id) {
                        self.pair_attempts += 1;
                    }
                    if self.connectable[person][peer] {
                        self.connected.insert((person, pair.id));
                        if self.connected.contains(&(peer, pair.id)) {
                            self.ever_confirmed
                                .insert((person.min(peer), person.max(peer)));
                        }
                        self.send(
                            person,
                            json!({"type":"link_state","pairId":pair.id,"state":"connected"}),
                        );
                    } else {
                        self.answered.insert((peer, pair.id));
                        self.pair_failures += 1;
                        self.send(
                            person,
                            json!({"type":"link_state","pairId":pair.id,"state":"failed"}),
                        );
                    }
                    // Later rounds read the state this answer produced.
                    break;
                }
                let mut flows: Vec<_> = pair
                    .incoming
                    .iter()
                    .filter(|flow| flow.publication_id == self.screen)
                    .copied()
                    .collect();
                flows.sort_by_key(|flow| (flow.selected, flow.id));
                for flow in flows {
                    // A watching client proves decoding, and presentation for a
                    // candidate beside a live input; a transit-only client
                    // proves it can forward.
                    let steps: &[&str] = match (self.viewing[person], flow.selected) {
                        (true, true) => &["decoded"],
                        (true, false) => &["decoded", "switch_ready"],
                        (false, _) => &["forwardable"],
                    };
                    let done = self.proved.entry((person, flow.id)).or_insert(0);
                    if usize::from(*done) >= steps.len() {
                        continue;
                    }
                    let state = steps[usize::from(*done)];
                    *done += 1;
                    acted = true;
                    self.send(
                        person,
                        json!({"type":"flow_state","pairId":pair.id,"flowId":flow.id,"state":state}),
                    );
                }
            }
        }
        acted
    }

    /// The room's read-only topology projection, as the source sees it.
    pub fn observe(&mut self) -> Observation {
        let request = json!({"type":"room_topology","roomId":self.room,
            "publicationId":self.screen,"requestId":"study"});
        let effects = self.net.authority.handle(
            self.people[self.source].connection,
            Request::parse(&request.to_string()).unwrap(),
            self.now,
        );
        let topology: RoomTopology = effects
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::RoomReply {
                    result: RoomResult::Topology { topology },
                    ..
                } => Some(topology),
                _ => None,
            })
            .expect("room topology reply");
        let mut observation = Observation::default();
        for pair in &topology.pairs {
            if !pair.confirmed {
                continue;
            }
            if let (Some(&a), Some(&b)) = (self.rank.get(&pair.first), self.rank.get(&pair.second))
            {
                observation.confirmed.insert((a.min(b), a.max(b)));
            }
        }
        if let Some(screen) = topology.screen {
            for edge in screen.edges {
                let (Some(&sender), Some(&receiver)) =
                    (self.rank.get(&edge.sender), self.rank.get(&edge.receiver))
                else {
                    continue;
                };
                if !edge.selected {
                    observation.preparing += 1;
                } else if observation.parent.insert(receiver, sender).is_some() {
                    observation.doubled += 1;
                }
            }
        }
        observation
    }
}
