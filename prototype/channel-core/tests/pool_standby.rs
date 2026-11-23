#![cfg(feature = "sqlite")]

mod support;

use piik_channel_core::{
    host::RoomResult,
    wire::{AudienceState, Event, FlowBinding, PairInfo, RoomAccess},
    Effects,
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;

fn command(net: &mut RoomNetwork, socket: Uuid, request: Value) {
    accepted(net.command(socket, request));
}

fn accepted(effects: Effects) {
    let error = effects.events.iter().find_map(|(_, event)| match event {
        Event::Error { code, .. }
        | Event::RoomReply {
            result: RoomResult::Error { code },
            ..
        } => Some(code),
        _ => None,
    });
    assert!(error.is_none(), "command rejected: {error:?}");
}

fn join(net: &mut RoomNetwork, socket: Uuid, name: &str) -> Uuid {
    net.command(socket, json!({"type":"join","name":name}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .expect("joined channel")
}

fn pair(net: &RoomNetwork, socket: Uuid, peer: Uuid) -> Option<&PairInfo> {
    net.state(socket)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == peer)
}

fn confirm(net: &mut RoomNetwork, endpoints: [(Uuid, Uuid); 2]) -> Uuid {
    let [(a, a_id), (b, b_id)] = endpoints;
    let pending = pair(net, a, b_id)
        .expect("pair assigned to the first endpoint")
        .id;
    assert_eq!(
        pair(net, b, a_id).expect("pair assigned to the peer").id,
        pending
    );
    for socket in [a, b] {
        command(
            net,
            socket,
            json!({"type":"link_state","pairId":pending,"state":"connected"}),
        );
    }
    pending
}

fn idle(net: &RoomNetwork, socket: Uuid) {
    let state = net.state(socket);
    assert!(state.pairs.iter().all(|pair| {
        pair.rooms.is_empty() && pair.incoming.is_empty() && pair.outgoing.is_empty()
    }));
    assert!(state.files.is_empty() && state.watch_bytes.is_empty());
}

fn read_room(net: &mut RoomNetwork, socket: Uuid, room: &str, reading: bool) {
    command(
        net,
        socket,
        json!({"type":"browse","roomId":room,"active":reading}),
    );
    let room = net
        .state(socket)
        .channel
        .rooms
        .iter()
        .find(|entry| entry.id == room)
        .unwrap();
    assert_eq!(room.reading, reading);
}

fn invite(net: &mut RoomNetwork, owner: Uuid, reader: Uuid, room: &str) {
    let key = net
        .command(owner, json!({"type":"room_invite","roomId":room}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::RoomInvite { key, .. } => Some(key),
            _ => None,
        })
        .expect("owner invited a room reader");
    command(
        net,
        reader,
        json!({"type":"enter_room","roomId":room,"inviteKey":key}),
    );
}

fn screen(net: &mut RoomNetwork, socket: Uuid, room: &str) -> Uuid {
    let id = Uuid::new_v4();
    command(
        net,
        socket,
        json!({"type":"publish","publication":{"id":id,"roomId":room,"kind":"screen",
        "source":{"kind":"screen","name":null},"videoSettings":{
            "ceiling":{"resolution":{"width":1280,"height":720},
                "maxFramerate":30,"maxBitrate":2500000},
            "degradationPreference":"balanced"
        }}}),
    );
    id
}

fn subscribe(net: &mut RoomNetwork, socket: Uuid, publication: Uuid, enabled: bool) {
    command(
        net,
        socket,
        json!({"type":"subscribe","publicationId":publication,"enabled":enabled}),
    );
}

fn screen_input(
    net: &RoomNetwork,
    socket: Uuid,
    peer: Uuid,
    picture: Uuid,
) -> Option<(Uuid, FlowBinding)> {
    let pair = pair(net, socket, peer)?;
    let flow = pair
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)?;
    Some((pair.id, *flow))
}

#[test]
fn proven_lobby_pair_survives_signaling_recovery_until_the_session_exits() {
    let mut net = RoomNetwork::new();
    let [first, second, resumed] = [(); 3].map(|_| Uuid::new_v4());
    let a = join(&mut net, first, "First");
    let (b, credential) = net
        .command(second, json!({"type":"join","name":"Second"}))
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
        .unwrap();
    let kept = confirm(&mut net, [(first, a), (second, b)]);
    let effects = net.authority.disconnect(second, 101);
    net.deliver(effects);
    assert_eq!(pair(&net, first, b).map(|p| p.id), Some(kept));
    idle(&net, first);
    accepted(net.command_at(
        resumed,
        json!({"type":"join","name":"Second","credential":credential,"sessionId":b}),
        102,
    ));
    assert_eq!(pair(&net, resumed, a).map(|p| p.id), Some(kept));
    assert_eq!(confirm(&mut net, [(first, a), (resumed, b)]), kept);
    command(&mut net, resumed, json!({"type":"leave"}));
    assert!(pair(&net, first, b).is_none());
}

#[test]
fn an_unconfirmed_lobby_attempt_is_released_when_signaling_disconnects() {
    let mut net = RoomNetwork::new();
    let [first, second] = [(); 2].map(|_| Uuid::new_v4());
    join(&mut net, first, "First");
    let b = join(&mut net, second, "Second");
    let attempt = pair(&net, first, b).unwrap().id;
    command(
        &mut net,
        first,
        json!({"type":"link_state","pairId":attempt,"state":"connected"}),
    );
    let effects = net.authority.disconnect(second, 101);
    net.deliver(effects);
    assert!(pair(&net, first, b).is_none());
}

#[test]
fn lobby_starts_a_bounded_probe_without_business_grants() {
    let mut net = RoomNetwork::new();
    let [a, b, c] = [(); 3].map(|_| Uuid::new_v4());
    let a_id = join(&mut net, a, "First");
    assert!(net.state(a).pairs.is_empty());
    let b_id = join(&mut net, b, "Second");
    let pending = pair(&net, a, b_id)
        .expect("two lobby peers get an initial probe")
        .id;

    let c_id = join(&mut net, c, "Third");
    assert!(
        net.state(c).pairs.is_empty(),
        "one optional probe is already in flight"
    );
    for socket in [a, b, c] {
        assert!(net.state(socket).channel.rooms.is_empty());
        idle(&net, socket);
    }
    assert_eq!(confirm(&mut net, [(a, a_id), (b, b_id)]), pending);
    assert!(pair(&net, c, a_id).is_some() || pair(&net, c, b_id).is_some());
    assert!(pair(&net, a, c_id).is_some() || pair(&net, b, c_id).is_some());
    for socket in [a, b, c] {
        idle(&net, socket);
    }
}

#[test]
fn chat_readers_reuse_a_confirmed_pair_and_room_exit_preserves_other_uses() {
    let mut net = RoomNetwork::new();
    let [owner, reader] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Owner");
    let recipient = join(&mut net, reader, "Reader");
    let first = net.create(owner, RoomAccess::Public, false);
    let second = net.create(owner, RoomAccess::Public, false);
    for room in [&first, &second] {
        read_room(&mut net, owner, room, true);
        read_room(&mut net, reader, room, true);
    }
    for socket in [owner, reader] {
        idle(&net, socket);
        let state = net.state(socket);
        assert!(state.publications.is_empty() && state.voice.is_empty());
    }
    let standby = confirm(&mut net, [(owner, source), (reader, recipient)]);

    let picture = screen(&mut net, owner, &second);
    subscribe(&mut net, reader, picture, true);
    let reused = pair(&net, reader, source).unwrap();
    assert_eq!(reused.id, standby);
    let flow = reused
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .expect("the confirmed standby pair can prepare a screen")
        .id;
    command(
        &mut net,
        reader,
        json!({"type":"flow_state","pairId":standby,"flowId":flow,"state":"decoded"}),
    );

    read_room(&mut net, reader, &first, false);
    let retained = pair(&net, reader, source).unwrap();
    assert_eq!(retained.id, standby);
    assert!(retained
        .incoming
        .iter()
        .any(|binding| binding.id == flow && binding.selected));
    assert!(net.state(owner).publications.iter().any(|item| {
        item.id == picture
            && item.audience.iter().any(|viewer| {
                viewer.session_id == recipient && viewer.state == AudienceState::Active
            })
    }));

    subscribe(&mut net, reader, picture, false);
    read_room(&mut net, reader, &second, false);
    assert_eq!(pair(&net, reader, source).unwrap().id, standby);
    idle(&net, reader);
}

#[test]
fn forwarding_off_can_hold_standby_hops_and_refuses_third_party_delivery() {
    let mut net = RoomNetwork::new();
    let [owner, helper, viewer] = [(); 3].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    let reader = join(&mut net, helper, "Reader");
    let room = net.create(owner, RoomAccess::Private, true);
    invite(&mut net, owner, helper, &room);
    read_room(&mut net, helper, &room, true);
    command(
        &mut net,
        helper,
        json!({"type":"relay_capacity","roomId":room,"capacity":0}),
    );
    let upstream = confirm(&mut net, [(owner, source), (helper, reader)]);

    let recipient = join(&mut net, viewer, "Viewer");
    invite(&mut net, owner, viewer, &room);
    read_room(&mut net, viewer, &room, true);
    if let Some(direct) = pair(&net, viewer, source).map(|pair| pair.id) {
        command(
            &mut net,
            viewer,
            json!({"type":"link_state","pairId":direct,"state":"failed"}),
        );
    }
    let downstream = confirm(&mut net, [(helper, reader), (viewer, recipient)]);
    idle(&net, helper);

    let picture = screen(&mut net, owner, &room);
    subscribe(&mut net, viewer, picture, true);
    let watch = Uuid::new_v4();
    command(
        &mut net,
        owner,
        json!({"type":"start_watch","roomId":room,"id":watch,
            "source":{"kind":"media","url":"https://example.com/movie.mp4"},
            "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":100},
            "byteSource":{"sessionId":source,"resourceId":Uuid::new_v4(),"format":"file"}}),
    );
    command(
        &mut net,
        viewer,
        json!({"type":"join_watch","roomId":room,"id":watch,"mode":"peer"}),
    );
    assert_eq!(pair(&net, helper, source).unwrap().id, upstream);
    assert_eq!(pair(&net, helper, recipient).unwrap().id, downstream);
    assert!(net.state(viewer).subscriptions.contains(&picture));
    assert!(net
        .state(viewer)
        .pairs
        .iter()
        .all(|pair| pair.incoming.is_empty()));
    let waiting = &net.state(viewer).watch_bytes[0];
    assert!(waiting.receiving && waiting.upstream.is_none());
    idle(&net, helper);

    command(
        &mut net,
        helper,
        json!({"type":"relay_capacity","roomId":room,"capacity":1}),
    );
    let forwarded = &net.state(helper).watch_bytes[0];
    assert_eq!(forwarded.upstream, Some(source));
    assert_eq!(forwarded.downstream, [recipient]);
    assert_eq!(net.state(viewer).watch_bytes[0].upstream, Some(reader));
    assert_eq!(pair(&net, helper, source).unwrap().id, upstream);
    assert_eq!(pair(&net, helper, recipient).unwrap().id, downstream);
}

#[test]
fn at_the_physical_limit_a_private_screen_waits_until_a_slot_is_released() {
    // The production physical degree limit, exercised through real room uses.
    const DEGREE_LIMIT: usize = 64;
    const VIEWERS_PER_ROOM: usize = 8;
    let mut net = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let source = join(&mut net, owner, "Source");
    let mut active = Vec::new();
    for first in (0..DEGREE_LIMIT).step_by(VIEWERS_PER_ROOM) {
        let room = net.create(owner, RoomAccess::Private, true);
        let picture = screen(&mut net, owner, &room);
        command(
            &mut net,
            owner,
            json!({"type":"set_screen_direct_limit","publicationId":picture,"limit":VIEWERS_PER_ROOM}),
        );
        for _ in first..(first + VIEWERS_PER_ROOM).min(DEGREE_LIMIT) {
            let viewer = Uuid::new_v4();
            let recipient = join(&mut net, viewer, "Viewer");
            invite(&mut net, owner, viewer, &room);
            subscribe(&mut net, viewer, picture, true);
            let pair_id = confirm(&mut net, [(owner, source), (viewer, recipient)]);
            let (_, flow) = screen_input(&net, viewer, source, picture)
                .expect("private screen prepares on the confirmed pair");
            command(
                &mut net,
                viewer,
                json!({"type":"flow_state","pairId":pair_id,"flowId":flow.id,"state":"decoded"}),
            );
            let binding = screen_input(&net, viewer, source, picture).unwrap();
            active.push((viewer, picture, binding));
        }
    }

    let viewer = Uuid::new_v4();
    join(&mut net, viewer, "Waiting viewer");
    let room = net.create(owner, RoomAccess::Private, true);
    let picture = screen(&mut net, owner, &room);
    invite(&mut net, owner, viewer, &room);
    subscribe(&mut net, viewer, picture, true);
    let assert_waiting = |net: &RoomNetwork| {
        let state = net.state(viewer);
        assert!(state.subscriptions.contains(&picture));
        assert!(!state.failed_subscriptions.contains(&picture));
        assert!(pair(net, viewer, source).is_none());
        assert_eq!(net.state(owner).pairs.len(), DEGREE_LIMIT);
    };
    assert_waiting(&net);
    let now = 60_100;
    let expired = net.authority.expire(now);
    accepted(net.deliver(expired));
    assert_waiting(&net);

    let (released, selected, _) = active.remove(0);
    accepted(net.command_at(
        released,
        json!({"type":"subscribe","publicationId":selected,"enabled":false}),
        now,
    ));
    let admitted = pair(&net, viewer, source)
        .expect("releasing one use admits the waiting pair")
        .id;
    assert!(screen_input(&net, viewer, source, picture).is_none());
    for socket in [owner, viewer] {
        accepted(net.command_at(
            socket,
            json!({"type":"link_state","pairId":admitted,"state":"connected"}),
            now,
        ));
    }
    let (pair_id, flow) =
        screen_input(&net, viewer, source, picture).expect("confirmed pair wakes the room");
    assert_eq!(pair_id, admitted);
    accepted(net.command_at(
        viewer,
        json!({"type":"flow_state","pairId":admitted,"flowId":flow.id,"state":"decoded"}),
        now,
    ));
    assert_eq!(net.state(owner).pairs.len(), DEGREE_LIMIT);
    for (socket, publication, binding) in active {
        assert_eq!(
            screen_input(&net, socket, source, publication),
            Some(binding)
        );
    }
}

#[test]
fn text_participant_can_read_without_spending_a_peer_slot() {
    let mut net = RoomNetwork::new();
    let [source, viewer, text] = [(); 3].map(|_| Uuid::new_v4());
    let source_id = join(&mut net, source, "Source");
    let viewer_id = join(&mut net, viewer, "Viewer");
    let room = net.create(source, RoomAccess::Public, false);
    read_room(&mut net, viewer, &room, true);
    let direct = confirm(&mut net, [(source, source_id), (viewer, viewer_id)]);
    // Same join capabilities and browse payload as the shipped Node SDK.
    command(&mut net, text, json!({"type":"join","name":"Reader","canUsePeerTransport":false}));
    let lobby = net.state(text).pairs.len();
    read_room(&mut net, text, &room, true);
    let browsing = net.state(text).pairs.len();
    let picture = screen(&mut net, source, &room);
    subscribe(&mut net, viewer, picture, true);
    let (pair_id, flow) = screen_input(&net, viewer, source_id, picture).unwrap();
    assert_eq!(pair_id, direct);
    command(&mut net, viewer, json!({"type":"flow_state","pairId":direct,"flowId":flow.id,"state":"decoded"}));
    let during_screen = net.state(text).pairs.len();
    command(&mut net, viewer, json!({"type":"link_state","pairId":direct,"state":"failed"}));
    let after_direct_failure = net.state(text).pairs.len();
    assert_eq!([lobby, browsing, during_screen, after_direct_failure], [0; 4]);
}
