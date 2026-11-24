#![cfg(feature = "sqlite")]

mod support;

use piik_channel_core::{
    host::RoomResult,
    wire::{Event, PairInfo, RoomAccess},
    Effects,
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;

fn command(net: &mut RoomNetwork, connection: Uuid, value: Value, now: u64) -> Effects {
    let result = net.command_at(connection, value, now);
    for (_, event) in &result.events {
        match event {
            Event::Error { code, .. }
            | Event::RoomReply {
                result: RoomResult::Error { code },
                ..
            } => {
                panic!("production request failed: {code}")
            }
            _ => {}
        }
    }
    result
}

fn welcome(effects: Effects) -> (Uuid, String) {
    effects
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
        .expect("authenticated endpoint")
}

fn pair(net: &RoomNetwork, connection: Uuid, peer: Uuid) -> Option<PairInfo> {
    net.state(connection)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == peer)
        .cloned()
}

fn candidate(id: Uuid) -> Value {
    json!({"type":"signal", "pairId":id, "payload":{"candidate":{
        "candidate":"candidate:1 1 UDP 2130706431 192.0.2.22 41002 typ host",
        "sdpMid":"0", "sdpMLineIndex":0, "usernameFragment":"changed-address"
    }}})
}

fn connected(
    net: &mut RoomNetwork,
    source: Uuid,
    viewer: Uuid,
    source_session: Uuid,
    id: Uuid,
    now: u64,
) {
    let report = json!({"type":"link_state", "pairId":id, "state":"connected"});
    command(net, source, report.clone(), now);
    assert!(
        pair(net, viewer, source_session)
            .unwrap()
            .incoming
            .is_empty(),
        "one endpoint is not physical proof"
    );
    command(net, viewer, report, now);
    let confirmed = pair(net, viewer, source_session).unwrap();
    let input = *confirmed.incoming.first().unwrap_or_else(|| {
        panic!(
            "no incoming flow after both reports at {now}; pair={}; subscriptions={:?}",
            serde_json::to_string(&confirmed).unwrap(),
            net.state(viewer).subscriptions
        )
    });
    command(
        net,
        viewer,
        json!({"type":"flow_state", "pairId":id, "flowId":input.id, "state":"decoded"}),
        now,
    );
    assert!(pair(net, viewer, source_session).unwrap().incoming[0].selected);
}

#[test]
fn pair_and_signaling_replacement_do_not_inherit_retired_candidate_reports() {
    replaced_pair(false);
}

#[test]
fn media_failure_before_pair_failure_cannot_block_the_replacement() {
    replaced_pair(true);
}

fn publish(net: &mut RoomNetwork, source: Uuid, viewer: Uuid, room: &str, publication: Uuid) {
    command(
        net,
        source,
        json!({"type":"publish", "publication":{
            "id":publication, "roomId":room, "kind":"screen", "source":{"kind":"screen", "name":null},
            "videoSettings":{"ceiling":{"resolution":{"width":640,"height":360},
            "maxFramerate":30,"maxBitrate":1000000},"degradationPreference":"balanced"}
        }}),
        100,
    );
    command(
        net,
        viewer,
        json!({"type":"subscribe", "publicationId":publication, "enabled":true}),
        100,
    );
}

fn replaced_pair(media_failure_first: bool) {
    let mut net = RoomNetwork::new();
    let source = Uuid::from_u128(1);
    let viewer = Uuid::from_u128(2);
    let next_viewer = Uuid::from_u128(3);
    let (source_session, _) = welcome(command(
        &mut net,
        source,
        json!({"type":"join", "name":"Source"}),
        100,
    ));
    let (viewer_session, credential) = welcome(command(
        &mut net,
        viewer,
        json!({"type":"join", "name":"Viewer"}),
        100,
    ));
    let room = net.create(source, RoomAccess::Public, false);
    command(
        &mut net,
        viewer,
        json!({"type":"browse", "roomId":room, "active":true}),
        100,
    );
    let publication = Uuid::from_u128(10);
    publish(&mut net, source, viewer, &room, publication);
    let sibling = Uuid::from_u128(4);
    welcome(command(
        &mut net,
        sibling,
        json!({"type":"join", "name":"Sibling"}),
        100,
    ));
    let other_room = net.create(source, RoomAccess::Public, false);
    publish(&mut net, source, sibling, &other_room, Uuid::from_u128(11));
    let original = pair(&net, viewer, source_session).unwrap().id;
    connected(&mut net, source, viewer, source_session, original, 200);
    let sibling_pair = pair(&net, sibling, source_session).unwrap().id;
    connected(&mut net, source, sibling, source_session, sibling_pair, 200);
    let sibling_flow = pair(&net, sibling, source_session).unwrap().incoming[0];
    let replacement = original;

    if media_failure_first {
        let old_flow = pair(&net, viewer, source_session).unwrap().incoming[0].id;
        command(
            &mut net,
            viewer,
            json!({"type":"flow_state", "pairId":replacement,"flowId":old_flow,"state":"failed"}),
            6090,
        );
        assert!(pair(&net, viewer, source_session)
            .unwrap()
            .incoming
            .is_empty());
    }
    command(
        &mut net,
        viewer,
        json!({"type":"link_state", "pairId":replacement, "state":"failed"}),
        6100,
    );
    assert!(pair(&net, viewer, source_session).is_none());
    let resumed = command(
        &mut net,
        next_viewer,
        json!({"type":"join", "name":"Viewer", "credential":credential,
        "sessionId":viewer_session}),
        6200,
    );
    assert_eq!(resumed.close, vec![viewer]);
    assert_eq!(welcome(resumed).0, viewer_session);
    let authenticated = pair(&net, next_viewer, source_session)
        .expect("new signaling generation is not the old failed edge")
        .id;
    assert_ne!(authenticated, replacement);
    assert!(pair(&net, next_viewer, source_session)
        .unwrap()
        .incoming
        .is_empty());
    for stale in [
        candidate(replacement),
        json!({"type":"link_state", "pairId":replacement,"state":"failed"}),
    ] {
        assert!(command(&mut net, next_viewer, stale, 6201)
            .events
            .is_empty());
        assert_eq!(
            pair(&net, next_viewer, source_session).unwrap().id,
            authenticated
        );
    }
    let expired_socket = net.command_at(
        viewer,
        json!({"type":"link_state", "pairId":authenticated, "state":"failed"}),
        6201,
    );
    assert_eq!(expired_socket.close, vec![viewer]);
    assert_eq!(
        pair(&net, next_viewer, source_session).unwrap().id,
        authenticated
    );
    for endpoint in [source, next_viewer] {
        command(
            &mut net,
            endpoint,
            json!({"type":"link_state", "pairId":authenticated,"state":"connected"}),
            6202,
        );
    }
    let topology = command(
        &mut net,
        next_viewer,
        json!({"type":"room_topology","roomId":room,
        "publicationId":publication,"requestId":"inspect-physical-proof"}),
        6203,
    )
    .events
    .into_iter()
    .find_map(|(_, event)| match event {
        Event::RoomReply {
            result: RoomResult::Topology { topology },
            ..
        } => Some(topology),
        _ => None,
    })
    .unwrap();
    assert!(topology.pairs.iter().any(|p| p.confirmed
        && ((p.first == source_session && p.second == viewer_session)
            || (p.second == source_session && p.first == viewer_session))));
    assert_eq!(topology.screen.unwrap().edges.len(), 1);
    let flow = pair(&net, next_viewer, source_session).unwrap().incoming[0];
    command(
        &mut net,
        next_viewer,
        json!({"type":"flow_state", "pairId":authenticated,"flowId":flow.id,"state":"decoded"}),
        6204,
    );
    let after_old_deadline = net.authority.expire(11100);
    net.deliver(after_old_deadline);
    assert_eq!(
        pair(&net, next_viewer, source_session).unwrap().id,
        authenticated
    );
    assert!(pair(&net, next_viewer, source_session).unwrap().incoming[0].selected);
    assert_eq!(
        pair(&net, sibling, source_session).unwrap().id,
        sibling_pair
    );
    assert_eq!(
        pair(&net, sibling, source_session).unwrap().incoming[0],
        sibling_flow
    );
}

#[test]
fn a_media_failure_on_a_healthy_pair_keeps_its_existing_repair_delay() {
    let mut net = RoomNetwork::new();
    let (source, viewer) = (Uuid::new_v4(), Uuid::new_v4());
    let (source_session, _) = welcome(command(
        &mut net,
        source,
        json!({"type":"join","name":"Source"}),
        100,
    ));
    welcome(command(
        &mut net,
        viewer,
        json!({"type":"join","name":"Viewer"}),
        100,
    ));
    let room = net.create(source, RoomAccess::Public, false);
    let publication = Uuid::new_v4();
    publish(&mut net, source, viewer, &room, publication);
    let original = pair(&net, viewer, source_session).unwrap().id;
    connected(&mut net, source, viewer, source_session, original, 200);
    let old_flow = pair(&net, viewer, source_session).unwrap().incoming[0].id;
    command(
        &mut net,
        viewer,
        json!({"type":"flow_state","pairId":original,"flowId":old_flow,"state":"failed"}),
        1000,
    );
    assert_eq!(pair(&net, viewer, source_session).unwrap().id, original);
    assert!(pair(&net, viewer, source_session)
        .unwrap()
        .incoming
        .is_empty());
    for endpoint in [source, viewer] {
        command(
            &mut net,
            endpoint,
            json!({"type":"link_state","pairId":original,"state":"connected"}),
            1001,
        );
    }
    let before_retry = net.authority.expire(5999);
    net.deliver(before_retry);
    assert!(pair(&net, viewer, source_session)
        .unwrap()
        .incoming
        .is_empty());
    let due = net.authority.expire(6000);
    net.deliver(due);
    let current = pair(&net, viewer, source_session).unwrap();
    assert_eq!(current.id, original);
    assert_ne!(current.incoming[0].id, old_flow);
}
