//! Drives the real channel authority and room host through the public command
//! path the other integration tests use. The harness plays every endpoint: it
//! answers each proposed physical pair from the connectivity script and proves
//! every assigned flow as a healthy client would. It never plans anything.

use super::model::Script;
use crate::support::RoomNetwork;
use piik_channel_core::{
    host::RoomResult,
    topology::RoomTopology,
    wire::{Event, FlowState, Request, RoomAccess},
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Upper bound on answer rounds after one event. Reaching it is reported.
const SETTLE_ROUNDS: usize = 400;

/// How long endpoints take, in milliseconds of the core's clock. Without it
/// (`Driver::timing == None`) every answer is instant, as in the stage 0 and
/// released-pairs tables. ASSUMPTIONS: one constant each, every endpoint alike.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// A connectable pair: each side reports `connected` this long after the
    /// pair first appears in its own state.
    pub success_ms: u64,
    /// A pair that cannot connect: the first side to see it reports `failed`
    /// this long after (the authority's own deadline may come first).
    pub failure_ms: u64,
    /// A flow: the receiver sends its proof steps this long after the flow
    /// first appears in its state (`decoded`, `switch_ready` or `forwardable`).
    pub proof_ms: u64,
}

/// The server calls `Authority::expire` once a second
/// (`channel-server/src/domain.rs`, the `expiry` interval); every command
/// also expires first (`Authority::handle`). Expiry delivers room wakes.
pub const EXPIRE_EVERY_MS: u64 = 1_000;

/// The core's limit on discovery attempts per channel
/// (`CHANNEL_ATTEMPT_LIMIT` in `src/transport.rs`); a tick with this many
/// pairs in flight counts as saturated.
pub const CHANNEL_SATURATED: usize = 4;

pub struct Person {
    pub connection: Uuid,
    pub session: Uuid,
    credential: String,
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
    /// Every screen edge: sender, receiver, selected, proof.
    pub edges: Vec<(usize, usize, bool, Option<FlowState>)>,
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
    pub timing: Option<Timing>,
    /// The room's output limit per forwarder (`relayCapacity`).
    pub limit: u8,
    /// When each endpoint first saw each pair or flow id in its own state.
    pub seen: BTreeMap<(usize, Uuid), u64>,
    /// Distinct pair ids that ever appeared in some endpoint's state.
    pub pairs_started: BTreeSet<Uuid>,
    /// The last time the driver gave the authority any input (a command or an
    /// expiry). Observing at that time cannot run its timers early.
    pub touched: u64,
    /// Observations at a moment without other input (their expiry could run
    /// a timer before a runtime would); counted, expected rare.
    pub early_observations: usize,
    /// Cold arrival: viewers are in the channel from the start but without
    /// peer transport, and enable it (by rejoining their session) only when
    /// they arrive, so no standby pair of theirs exists before.
    pub cold: bool,
    /// Timed sessions only, the cost of trials. Pair ids that carried a
    /// screen flow in some endpoint's state at a settled moment.
    pub carried: BTreeSet<Uuid>,
    /// Most pairs in flight (in an endpoint's state and not yet confirmed by
    /// both sides) at one settled moment: at one endpoint, and in the channel.
    pub peak_endpoint: usize,
    pub peak_channel: usize,
    /// Expiry ticks sampled, and those at which the channel had
    /// `CHANNEL_SATURATED` or more pairs in flight.
    pub ticks: usize,
    pub saturated_ticks: usize,
    /// Every answer the driver gave, in participant terms (for replay checks).
    pub log: Vec<String>,
}

impl Driver {
    /// Joins every participant at once so that session identifiers can be
    /// ranked; participant `i` is the `i`-th identifier. Nobody enters the
    /// room until the script says so.
    pub fn new(script: &Script, limit: u8, timing: Option<Timing>, cold: bool) -> Self {
        let mut net = RoomNetwork::new();
        let now = 100;
        let mut people = Vec::new();
        for _ in 0..script.people {
            let connection = Uuid::new_v4();
            let mut join = json!({"type":"join","name":"Participant"});
            if timing.is_some() || cold {
                join["canUsePeerTransport"] = json!(false);
            }
            let (session, credential) = net
                .command_at(connection, join, now)
                .events
                .into_iter()
                .find_map(|(_, event)| match event {
                    Event::Welcome {
                        session_id,
                        credential,
                        ..
                    } => Some((session_id, credential)),
                    _ => None,
                })
                .expect("joined channel");
            people.push(Person {
                connection,
                session,
                credential,
            });
        }
        people.sort_by_key(|person| person.session);
        let rank = people
            .iter()
            .enumerate()
            .map(|(index, person)| (person.session, index))
            .collect();
        let source = script.source;
        // Timed sessions: pairs proposed while people join would outlive the
        // joins, and join order is random in participant terms. Join without
        // peer transport, then enable it in participant order (cold: the
        // sharer only; viewers enable it when they arrive).
        if timing.is_some() || cold {
            for (index, person) in people.iter_mut().enumerate() {
                if !cold || index == source {
                    Self::rejoin(&mut net, person, now);
                }
            }
        }
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
            timing,
            limit,
            seen: BTreeMap::new(),
            pairs_started: BTreeSet::new(),
            touched: now,
            early_observations: 0,
            cold,
            carried: BTreeSet::new(),
            peak_endpoint: 0,
            peak_channel: 0,
            ticks: 0,
            saturated_ticks: 0,
            log: Vec::new(),
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
        self.touched = self.now;
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
        if self.timing.is_some() {
            self.run_until(now, |_| {});
            return;
        }
        self.now = self.now.max(now);
        let effects = self.net.authority.expire(self.now);
        self.net.deliver(effects);
        self.settle();
    }

    /// Timed mode: moves the clock to `target` through every moment at which
    /// something happens, as a runtime would: each endpoint answer that falls
    /// due, and the server's once-a-second expiry. Between those moments the
    /// authority receives no input, so this is exact for any finer step.
    /// `step` runs after each moment has settled.
    pub fn run_until(&mut self, target: u64, mut step: impl FnMut(&mut Self)) {
        loop {
            let tick = (self.now / EXPIRE_EVERY_MS + 1) * EXPIRE_EVERY_MS;
            let next = self
                .next_due()
                .map_or(tick, |due| due.min(tick))
                .min(target);
            if next <= self.now {
                return;
            }
            self.now = next;
            if next == tick {
                self.touched = next;
                let effects = self.net.authority.expire(next);
                self.net.deliver(effects);
            }
            self.settle();
            self.sample_attempts(next == tick);
            step(self);
        }
    }

    /// Records the pairs in flight at this settled moment (timed sessions).
    fn sample_attempts(&mut self, tick: bool) {
        let mut channel = BTreeSet::new();
        for person in (0..self.people.len()).filter(|&p| self.online[p]) {
            let pending = self.pending_pairs(person);
            self.peak_endpoint = self.peak_endpoint.max(pending.len());
            channel.extend(pending.into_iter().map(|(_, id)| id));
        }
        self.peak_channel = self.peak_channel.max(channel.len());
        if tick {
            self.ticks += 1;
            if channel.len() >= CHANNEL_SATURATED {
                self.saturated_ticks += 1;
            }
        }
    }

    /// The earliest answer due after now, from what the endpoints have seen.
    fn next_due(&self) -> Option<u64> {
        let timing = self.timing?;
        let mut due: Option<u64> = None;
        let mut consider = |at: u64| {
            if at > self.now {
                due = Some(due.map_or(at, |d| d.min(at)));
            }
        };
        for person in (0..self.people.len()).filter(|&p| self.online[p]) {
            for pair in &self.net.state(self.people[person].connection).pairs {
                let Some(&peer) = self.rank.get(&pair.peer_id) else {
                    continue;
                };
                if !self.answered.contains(&(person, pair.id)) {
                    if let Some(&seen) = self.seen.get(&(person, pair.id)) {
                        consider(seen + Self::answer_ms(timing, self.connectable[person][peer]));
                    }
                    continue;
                }
                for flow in &pair.incoming {
                    if let Some(&seen) = self.seen.get(&(person, flow.id)) {
                        consider(seen + timing.proof_ms);
                    }
                }
            }
        }
        due
    }

    fn answer_ms(timing: Timing, connectable: bool) -> u64 {
        if connectable {
            timing.success_ms
        } else {
            timing.failure_ms
        }
    }

    /// Resumes the session from a new socket with peer transport enabled.
    fn rejoin(net: &mut RoomNetwork, person: &mut Person, now: u64) {
        let connection = Uuid::new_v4();
        let effects = net.command_at(
            connection,
            json!({"type":"join","name":"Participant","credential":person.credential,
                "sessionId":person.session,"canUsePeerTransport":true}),
            now,
        );
        let resumed = effects.events.iter().any(|(_, event)| {
            matches!(event, Event::Welcome { session_id, .. } if *session_id == person.session)
        });
        assert!(resumed, "cold arrival resumes its session");
        person.connection = connection;
    }

    pub fn arrive(&mut self, person: usize) {
        if self.cold {
            self.touched = self.now;
            Self::rejoin(&mut self.net, &mut self.people[person], self.now);
        }
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
                if pair
                    .incoming
                    .iter()
                    .chain(&pair.outgoing)
                    .any(|flow| flow.publication_id == self.screen)
                {
                    self.carried.insert(pair.id);
                }
                if let Some(timing) = self.timing {
                    if !self.answered.contains(&(person, pair.id)) {
                        self.pairs_started.insert(pair.id);
                        let seen = *self.seen.entry((person, pair.id)).or_insert(self.now);
                        let wait = Self::answer_ms(timing, self.connectable[person][peer]);
                        if self.now < seen + wait {
                            continue;
                        }
                    }
                }
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
                        self.log.push(format!("{} {person} link {peer} ok", self.now));
                        self.send(
                            person,
                            json!({"type":"link_state","pairId":pair.id,"state":"connected"}),
                        );
                    } else {
                        self.answered.insert((peer, pair.id));
                        self.pair_failures += 1;
                        self.log.push(format!("{} {person} link {peer} failed", self.now));
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
                    if let Some(timing) = self.timing {
                        let seen = *self.seen.entry((person, flow.id)).or_insert(self.now);
                        if self.now < seen + timing.proof_ms {
                            continue;
                        }
                    }
                    let done = self.proved.entry((person, flow.id)).or_insert(0);
                    if usize::from(*done) >= steps.len() {
                        continue;
                    }
                    let state = steps[usize::from(*done)];
                    *done += 1;
                    acted = true;
                    self.log.push(format!(
                        "{} {person} flow {peer} selected {} {state}",
                        self.now, flow.selected
                    ));
                    self.send(
                        person,
                        json!({"type":"flow_state","pairId":pair.id,"flowId":flow.id,"state":state}),
                    );
                }
            }
        }
        acted
    }

    /// Pairs in `person`'s state that both sides have not yet answered as
    /// connected: attempts in progress. (peer, pair id).
    pub fn pending_pairs(&self, person: usize) -> Vec<(usize, Uuid)> {
        self.net
            .state(self.people[person].connection)
            .pairs
            .iter()
            .filter_map(|pair| {
                let peer = *self.rank.get(&pair.peer_id)?;
                (!self.pair_confirmed(person, peer, pair.id)).then_some((peer, pair.id))
            })
            .collect()
    }

    /// Both sides of this physical pair have answered `connected`.
    pub fn pair_confirmed(&self, a: usize, b: usize, id: Uuid) -> bool {
        self.connected.contains(&(a, id)) && self.connected.contains(&(b, id))
    }

    /// The room's read-only topology projection, as the source sees it.
    pub fn observe(&mut self) -> Observation {
        let request = json!({"type":"room_topology","roomId":self.room,
            "publicationId":self.screen,"requestId":"study"});
        let mut effects = self.net.authority.handle(
            self.people[self.source].connection,
            Request::parse(&request.to_string()).unwrap(),
            self.now,
        );
        if self.timing.is_some() {
            // `handle` expires first. The driver observes only at a moment it
            // already gave the authority input, so that expiry finds nothing
            // due; deliver whatever it does produce rather than drop it.
            if self.touched != self.now {
                self.early_observations += 1;
            }
            effects = self.net.deliver(effects);
            self.touched = self.now;
            self.settle();
        }
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
                observation
                    .edges
                    .push((sender, receiver, edge.selected, edge.proof));
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
