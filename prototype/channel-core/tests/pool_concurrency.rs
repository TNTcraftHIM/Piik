#![cfg(feature = "sqlite")]

mod support;

use piik_channel_core::{
    host::RoomResult,
    wire::{Event, FlowBinding, RoomAccess},
    Effects,
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;

#[derive(Clone, Copy)]
struct Endpoint {
    socket: Uuid,
    session: Uuid,
}

fn join(net: &mut RoomNetwork) -> Endpoint {
    let socket = Uuid::new_v4();
    let session = net
        .command(socket, json!({"type":"join","name":"Member"}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .unwrap();
    Endpoint { socket, session }
}

fn command(net: &mut RoomNetwork, socket: Uuid, value: Value, now: u64) -> Effects {
    let result = net.command_at(socket, value, now);
    for (_, event) in &result.events {
        if let Event::Error { code, .. }
        | Event::RoomReply {
            result: RoomResult::Error { code },
            ..
        } = event
        {
            panic!("command rejected: {code}");
        }
    }
    result
}

struct Viewing {
    source: Endpoint,
    viewer: Endpoint,
    screen: Uuid,
}

impl Viewing {
    fn new(net: &mut RoomNetwork, source: Endpoint, viewer: Endpoint) -> Self {
        let room = net.create(source.socket, RoomAccess::Public, false);
        let screen = Uuid::new_v4();
        command(
            net,
            source.socket,
            json!({"type":"publish","publication":{"id":screen,"roomId":room,"kind":"screen",
            "source":{"kind":"screen","name":null},"videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},
            "maxFramerate":30,"maxBitrate":2500000},"degradationPreference":"balanced"}}}),
            100,
        );
        Self {
            source,
            viewer,
            screen,
        }
    }

    fn subscribe(&self, net: &mut RoomNetwork, enabled: bool, now: u64) -> Effects {
        command(
            net,
            self.viewer.socket,
            json!({"type":"subscribe","publicationId":self.screen,"enabled":enabled}),
            now,
        )
    }

    fn pair(&self, net: &RoomNetwork) -> Option<Uuid> {
        net.state(self.viewer.socket)
            .pairs
            .iter()
            .find(|p| p.peer_id == self.source.session)
            .map(|p| p.id)
    }

    fn input(&self, net: &RoomNetwork) -> Option<FlowBinding> {
        net.state(self.viewer.socket)
            .pairs
            .iter()
            .find(|p| p.peer_id == self.source.session)?
            .incoming
            .iter()
            .find(|f| f.publication_id == self.screen)
            .copied()
    }

    fn confirm(&self, net: &mut RoomNetwork, now: u64) -> [Effects; 3] {
        let id = self.pair(net).expect("business pair assigned");
        assert!(net
            .state(self.source.socket)
            .pairs
            .iter()
            .any(|p| p.id == id && p.peer_id == self.viewer.session));
        let report = json!({"type":"link_state","pairId":id,"state":"connected"});
        let first = command(net, self.source.socket, report.clone(), now);
        assert!(self.input(net).is_none());
        let second = command(net, self.viewer.socket, report, now);
        let input = self.input(net).expect("both current sockets confirmed");
        let decoded = command(
            net,
            self.viewer.socket,
            json!({"type":"flow_state","pairId":id,"flowId":input.id,"state":"decoded"}),
            now,
        );
        assert!(self.input(net).unwrap().selected);
        [first, second, decoded]
    }
}

#[test]
fn unrelated_cold_rooms_get_connections_while_the_first_pair_is_silent() {
    let mut net = RoomNetwork::new();
    let incumbent_source = join(&mut net);
    let incumbent_viewer = join(&mut net);
    let incumbent = Viewing::new(&mut net, incumbent_source, incumbent_viewer);
    incumbent.subscribe(&mut net, true, 100);
    incumbent.confirm(&mut net, 100);
    let original_pair = incumbent.pair(&net).unwrap();
    let original_flow = incumbent.input(&net).unwrap();
    let mut observed = 0;
    let mut check_incumbent = |effects: Effects| {
        for (socket, event) in effects.events {
            if socket == incumbent_viewer.socket {
                if let Event::State { state } = event {
                    assert!(state
                        .pairs
                        .iter()
                        .any(|p| p.id == original_pair && p.incoming.contains(&original_flow)));
                    observed += 1;
                }
            }
        }
    };
    let rooms: Vec<_> = (0..5)
        .map(|_| {
            let source = join(&mut net);
            let viewer = join(&mut net);
            Viewing::new(&mut net, source, viewer)
        })
        .collect();
    for room in &rooms {
        check_incumbent(room.subscribe(&mut net, true, 100));
    }
    let silent = rooms[0].pair(&net).unwrap();
    for room in &rooms[1..4] {
        assert!(
            room.pair(&net).is_some(),
            "independent room must get a trial at the request timestamp"
        );
    }
    assert!(
        rooms[4].pair(&net).is_none(),
        "channel has four active trial slots"
    );
    for room in &rooms[1..] {
        for effects in room.confirm(&mut net, 200) {
            check_incumbent(effects);
        }
    }
    assert_eq!(rooms[0].pair(&net), Some(silent));
    assert!(rooms[0].input(&net).is_none());
    assert!(observed > 0);
}

#[test]
fn fresh_shared_source_demand_precedes_an_eligible_retry_after_silence() {
    let mut net = RoomNetwork::new();
    let source = join(&mut net);
    let rooms: Vec<_> = (0..4)
        .map(|_| {
            let viewer = join(&mut net);
            Viewing::new(&mut net, source, viewer)
        })
        .collect();
    for room in &rooms[..3] {
        room.subscribe(&mut net, true, 100);
    }
    let first = rooms[0].pair(&net).unwrap();
    let second = rooms[1]
        .pair(&net)
        .expect("source has two independent trial slots");
    assert_ne!(first, second);
    assert!(rooms[2].pair(&net).is_none());
    command(
        &mut net,
        source.socket,
        json!({"type":"link_state","pairId":first,"state":"failed"}),
        1_000,
    );
    let third = rooms[2]
        .pair(&net)
        .expect("first failure releases a source slot");
    rooms[3].subscribe(&mut net, true, 1_000);

    // The first edge can retry at 6 s. The second and third still own both slots.
    let retry = net.authority.expire(6_000);
    net.deliver(retry);
    assert!(rooms[0].pair(&net).is_none());
    assert!(rooms[3].pair(&net).is_none());
    let deadline = net.authority.expire(20_100);
    net.deliver(deadline);
    assert!(rooms[0].pair(&net).is_none());
    assert_ne!(rooms[1].pair(&net), Some(second));
    assert_eq!(rooms[2].pair(&net), Some(third));
    assert!(
        rooms[3].pair(&net).is_some(),
        "fresh viewer gets the released slot"
    );
    rooms[3].confirm(&mut net, 20_200);
}

#[test]
fn withdrawing_one_room_preserves_the_other_rooms_pending_and_selected_pair() {
    let mut net = RoomNetwork::new();
    let source = join(&mut net);
    let viewer = join(&mut net);
    let a = Viewing::new(&mut net, source, viewer);
    let b = Viewing::new(&mut net, source, viewer);
    a.subscribe(&mut net, true, 100);
    let pair = a.pair(&net).unwrap();
    b.subscribe(&mut net, true, 100);
    a.subscribe(&mut net, false, 100);
    assert_eq!(b.pair(&net), Some(pair));
    b.confirm(&mut net, 200);
    assert!(a.input(&net).is_none());
    let selected = b.input(&net).unwrap();
    a.subscribe(&mut net, true, 300);
    assert!(a.input(&net).is_some());
    a.subscribe(&mut net, false, 400);
    assert!(a.input(&net).is_none());
    assert_eq!(b.pair(&net), Some(pair));
    assert_eq!(b.input(&net), Some(selected));
}
