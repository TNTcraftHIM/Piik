#![cfg(feature = "sqlite")]

#[path = "pool_coldstart/assisted.rs"]
mod assisted;
#[path = "pool_coldstart/host_wake.rs"]
mod host_wake;
mod support;

use piik_channel_core::wire::ReplyResult;
use piik_channel_core::{
    attachment::sha256_hex,
    conversation::{ConversationCommand, ConversationResult},
    history::HistoryResult,

    wire::{Event, FlowBinding, PairInfo, RoomAccess},
    AttachmentDescriptor,
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;

fn command(net: &mut RoomNetwork, connection: Uuid, request: Value) {
    let effects = net.command(connection, request);
    let error = effects.events.iter().find_map(|(_, event)| match event {
        Event::Error { code, .. } | Event::Reply { result: ReplyResult::Error { code }, .. } => Some(code),
        _ => None,
    });
    assert!(error.is_none(), "command rejected: {error:?}");
}

fn join(net: &mut RoomNetwork, connection: Uuid, name: &str) -> Uuid {
    join_endpoint(net, connection, name).0
}

fn join_endpoint(net: &mut RoomNetwork, connection: Uuid, name: &str) -> (Uuid, String) {
    net.command(connection, json!({"type":"join","name":name}))
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
        .expect("joined channel")
}

fn no_payload_grants(net: &RoomNetwork, socket: Uuid) {
    assert!(net.state(socket).pairs.iter().all(|pair| {
        pair.rooms.is_empty() && pair.incoming.is_empty() && pair.outgoing.is_empty()
    }));
}

fn pair(net: &RoomNetwork, connection: Uuid, peer: Uuid) -> &PairInfo {
    net.state(connection)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == peer)
        .expect("channel admitted the requested peer")
}

fn link_connected(net: &mut RoomNetwork, connection: Uuid, pair: Uuid) {
    command(
        net,
        connection,
        json!({"type":"link_state","pairId":pair,"state":"connected"}),
    );
}

fn offer_file(net: &mut RoomNetwork, owner: Uuid, room: &str) -> (u64, Uuid) {
    let bytes = b"cold start";
    let attachment = AttachmentDescriptor {
        id: Uuid::new_v4(),
        name: "sample.bin".into(),
        size: bytes.len() as u64,
        media_type: "application/octet-stream".into(),
        sha256: sha256_hex(bytes),
    };
    let request = ConversationCommand::Chat {
        mentions: vec![],
        reply: None,
        inline_images: Default::default(),
        text: String::new(),
        nonce: "file".into(),
        attachments: vec![attachment.clone()],
    };
    let Ok(ConversationResult::History(HistoryResult::Sent(sent))) =
        net.peer_request(owner, room, request).result
    else {
        panic!("attachment message was not confirmed");
    };
    let seq = sent.message.message.seq;
    command(
        net,
        owner,
        json!({"type":"file_offer","roomId":room,"messageSeq":seq,
            "attachmentId":attachment.id,"sha256":attachment.sha256,"available":true}),
    );
    (seq, attachment.id)
}

fn file_receive(room: &str, file: (u64, Uuid), enabled: bool) -> Value {
    json!({"type":"file_receive","roomId":room,"messageSeq":file.0,
        "attachmentId":file.1,"enabled":enabled})
}

fn publish_screen(net: &mut RoomNetwork, connection: Uuid, room: &str) -> Uuid {
    let id = Uuid::new_v4();
    command(
        net,
        connection,
        json!({"type":"publish","publication":{"id":id,"roomId":room,"kind":"screen",
        "source":{"kind":"screen","name":null},"videoSettings":{
            "ceiling":{"resolution":{"width":1280,"height":720},
                "maxFramerate":30,"maxBitrate":2500000},
            "degradationPreference":"balanced"
        }}}),
    );
    id
}

fn subscribe(publication: Uuid, enabled: bool) -> Value {
    json!({"type":"subscribe","publicationId":publication,"enabled":enabled})
}

fn input(pair: &PairInfo, publication: Uuid) -> Option<FlowBinding> {
    pair.incoming
        .iter()
        .find(|flow| flow.publication_id == publication)
        .copied()
}

#[test]
fn refused_file_crosses_two_confirmed_sides_and_wakes_its_room() {
    let mut net = RoomNetwork::new();
    let mut nodes: Vec<_> = (0..6)
        .map(|i| {
            let socket = Uuid::new_v4();
            (join(&mut net, socket, &format!("peer{i}")), socket)
        })
        .collect();
    nodes.sort();
    let room = net.create(nodes[0].1, RoomAccess::Public, false);
    for &(_, socket) in &nodes {
        command(
            &mut net,
            socket,
            json!({"type":"browse","roomId":room,"active":true}),
        );
    }
    let mut confirmed = std::collections::BTreeSet::new();
    for _ in 0..6 {
        let (a, b, id) = (0..6)
            .find_map(|a| {
                let b = (a + 1) % 6;
                let p = net
                    .state(nodes[a].1)
                    .pairs
                    .iter()
                    .find(|p| p.peer_id == nodes[b].0)?;
                (!confirmed.contains(&p.id)).then_some((a, b, p.id))
            })
            .expect("next ring standby");
        for side in [a, b] {
            link_connected(&mut net, nodes[side].1, id);
        }
        confirmed.insert(id);
    }
    let screen = publish_screen(&mut net, nodes[0].1, &room);
    command(&mut net, nodes[1].1, subscribe(screen, true));
    let voice = Uuid::new_v4();
    for side in [4, 3] {
        command(
            &mut net,
            nodes[side].1,
            json!({"type":"voice","roomId":room,"joined":true,"muted":side==3,"deafened":false}),
        );
    }
    command(
        &mut net,
        nodes[4].1,
        json!({"type":"publish","publication":{"id":voice,"roomId":room,"kind":"voice"}}),
    );
    let healthy = [(0, 1, screen), (4, 3, voice)].map(|(from, to, pub_id)| {
        let leg = pair(&net, nodes[to].1, nodes[from].0);
        (from, to, pub_id, leg.id, input(leg, pub_id).unwrap().id)
    });
    for &(_, to, _, pair_id, flow_id) in &healthy {
        command(
            &mut net,
            nodes[to].1,
            json!({"type":"flow_state","pairId":pair_id,"flowId":flow_id,"state":"decoded"}),
        );
    }
    let file = offer_file(&mut net, nodes[0].1, &room);
    command(&mut net, nodes[3].1, file_receive(&room, file, true));
    for _ in 0..2 {
        let parent = net.state(nodes[3].1).files[0]
            .upstream
            .expect("next confirmed route");
        let (from, to) = if parent == nodes[2].0 {
            (2, 3)
        } else {
            assert_eq!(parent, nodes[4].0);
            (5, 4)
        };
        command(
            &mut net,
            nodes[from].1,
            json!({"type":"byte_branch_refused","roomId":room,
            "target":{"kind":"file","messageSeq":file.0,"attachmentId":file.1,"sourceId":nodes[0].0},
            "downstreamId":nodes[to].0}),
        );
    }
    // Only the middle missing link can connect. Refusals keep their direction and owner.
    let mut failed = std::collections::BTreeSet::new();
    for _ in 0..16 {
        assert!(net.state(nodes[3].1).files[0].upstream.is_none());
        let (a, b, id) = (0..6)
            .find_map(|a| {
                net.state(nodes[a].1)
                    .pairs
                    .iter()
                    .find(|p| !confirmed.contains(&p.id) && !failed.contains(&p.id))
                    .map(|p| {
                        (
                            a,
                            nodes.iter().position(|v| v.0 == p.peer_id).unwrap(),
                            p.id,
                        )
                    })
            })
            .expect("room should have a physical candidate");
        if (a.min(b), a.max(b)) == (1, 4) {
            link_connected(&mut net, nodes[a].1, id);
            assert!(net.state(nodes[3].1).files[0].upstream.is_none());
            link_connected(&mut net, nodes[b].1, id);
            assert_eq!(net.state(nodes[3].1).files[0].upstream, Some(nodes[4].0));
            assert_eq!(net.state(nodes[4].1).files[0].upstream, Some(nodes[1].0));
            assert_eq!(net.state(nodes[1].1).files[0].upstream, Some(nodes[0].0));
            for (from, to, pub_id, pair_id, flow_id) in healthy {
                let leg = pair(&net, nodes[to].1, nodes[from].0);
                assert_eq!(leg.id, pair_id);
                assert_eq!(
                    input(leg, pub_id).filter(|f| f.selected).unwrap().id,
                    flow_id
                );
            }
            return;
        }
        command(
            &mut net,
            nodes[a].1,
            json!({"type":"link_state","pairId":id,"state":"failed"}),
        );
        failed.insert(id);
    }
    panic!("exhausted useful physical edges");
}

#[test]
fn first_screen_subscription_prepares_after_link_confirmation() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    join(&mut net, receiver, "Viewer");
    let room = net.create(owner, RoomAccess::Public, false);
    let screen = publish_screen(&mut net, owner, &room);
    no_payload_grants(&net, receiver);

    command(&mut net, receiver, subscribe(screen, true));
    assert!(net.state(receiver).subscriptions.contains(&screen));
    assert!(!net.failed_screens(receiver).contains(&screen));
    let pending = pair(&net, receiver, source);
    let id = pending.id;
    assert_eq!(input(pending, screen), None);

    link_connected(&mut net, receiver, id);
    assert_eq!(input(pair(&net, receiver, source), screen), None);
    link_connected(&mut net, owner, id);
    let confirmed = pair(&net, receiver, source);
    assert_eq!(confirmed.id, id);
    assert!(input(confirmed, screen).is_some());
}

#[test]
fn first_voice_receiver_keeps_subscribed_until_the_link_is_confirmed() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Speaker");
    join(&mut net, receiver, "Listener");
    let room = net.create(owner, RoomAccess::Public, false);
    let voice = Uuid::new_v4();
    command(
        &mut net,
        owner,
        json!({"type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false}),
    );
    command(
        &mut net,
        owner,
        json!({"type":"publish","publication":{"id":voice,"roomId":room,"kind":"voice"}}),
    );
    no_payload_grants(&net, receiver);

    command(
        &mut net,
        receiver,
        json!({"type":"voice","roomId":room,"joined":true,"muted":true,"deafened":false}),
    );
    assert!(net.state(receiver).subscriptions.contains(&voice));
    let pending = pair(&net, receiver, source);
    let id = pending.id;
    assert_eq!(input(pending, voice), None);

    link_connected(&mut net, owner, id);
    assert_eq!(input(pair(&net, receiver, source), voice), None);
    link_connected(&mut net, receiver, id);
    let confirmed = pair(&net, receiver, source);
    assert_eq!(confirmed.id, id);
    assert!(input(confirmed, voice).is_some());
}

#[test]
fn first_file_request_waits_for_both_endpoints_and_wakes_the_room() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    let recipient = join(&mut net, receiver, "Recipient");
    let room = net.create(owner, RoomAccess::Public, false);
    let file = offer_file(&mut net, owner, &room);
    no_payload_grants(&net, receiver);

    command(&mut net, receiver, file_receive(&room, file, true));
    let waiting = &net.state(receiver).files[0];
    assert!(waiting.receiving);
    assert_eq!(waiting.source_id, Some(source));
    assert_eq!(waiting.upstream, None);

    let pending = pair(&net, receiver, source).id;
    link_connected(&mut net, owner, pending);
    assert_eq!(net.state(receiver).files[0].upstream, None);
    link_connected(&mut net, receiver, pending);

    assert_eq!(pair(&net, receiver, source).id, pending);
    assert_eq!(net.state(receiver).files[0].upstream, Some(source));
    assert_eq!(net.state(owner).files[0].downstream, vec![recipient]);
}

#[test]
fn first_forwarded_byte_request_connects_the_provider_to_the_receiver() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Provider");
    let recipient = join(&mut net, receiver, "Viewer");
    let room = net.create(owner, RoomAccess::Public, false);
    let watch = Uuid::new_v4();
    command(
        &mut net,
        owner,
        json!({"type":"start_watch","roomId":room,"id":watch,
            "source":{"kind":"media","url":"https://example.com/movie.mp4"},
            "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":0},
            "byteSource":{"sessionId":source,"resourceId":Uuid::new_v4(),"format":"file"}}),
    );
    command(
        &mut net,
        receiver,
        json!({"type":"join_watch","roomId":room,"id":watch,"mode":"direct"}),
    );
    assert!(net.state(receiver).watch_bytes.is_empty());
    no_payload_grants(&net, receiver);

    command(
        &mut net,
        receiver,
        json!({"type":"join_watch","roomId":room,"id":watch,"mode":"peer"}),
    );
    let waiting = &net.state(receiver).watch_bytes[0];
    assert_eq!(waiting.activity_id, watch);
    assert!(waiting.receiving);
    assert_eq!(waiting.source.session_id, source);
    assert_eq!(waiting.upstream, None);

    let pending = pair(&net, receiver, source).id;
    link_connected(&mut net, receiver, pending);
    assert_eq!(net.state(receiver).watch_bytes[0].upstream, None);
    link_connected(&mut net, owner, pending);

    assert_eq!(pair(&net, receiver, source).id, pending);
    assert_eq!(net.state(receiver).watch_bytes[0].upstream, Some(source));
    assert_eq!(net.state(owner).watch_bytes[0].downstream, vec![recipient]);
}

#[test]
fn withdrawing_a_file_keeps_the_screen_on_the_same_pair() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    join(&mut net, receiver, "Recipient");
    let room = net.create(owner, RoomAccess::Public, false);
    let file = offer_file(&mut net, owner, &room);
    let screen = publish_screen(&mut net, owner, &room);
    no_payload_grants(&net, receiver);

    command(&mut net, receiver, file_receive(&room, file, true));
    let pending = pair(&net, receiver, source).id;
    command(&mut net, receiver, subscribe(screen, true));
    assert_eq!(pair(&net, receiver, source).id, pending);
    link_connected(&mut net, owner, pending);
    link_connected(&mut net, receiver, pending);

    let screen_flow = input(pair(&net, receiver, source), screen).expect("screen input");
    command(
        &mut net,
        receiver,
        json!({"type":"flow_state","pairId":pending,"flowId":screen_flow.id,"state":"decoded"}),
    );
    let active_screen = input(pair(&net, receiver, source), screen).unwrap();
    assert!(active_screen.selected);
    assert!(!net.failed_screens(receiver).contains(&screen));
    assert_eq!(net.state(receiver).files[0].upstream, Some(source));

    command(&mut net, receiver, file_receive(&room, file, false));
    assert!(net.state(receiver).files.is_empty());
    let surviving_pair = pair(&net, receiver, source);
    assert_eq!(surviving_pair.id, pending);
    assert_eq!(input(surviving_pair, screen), Some(active_screen));
}

#[test]
fn cancelling_a_waiting_file_keeps_lobby_pair_and_recovery_needs_current_proof() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    let (recipient, credential) = join_endpoint(&mut net, receiver, "Recipient");
    let room = net.create(owner, RoomAccess::Public, false);
    let file = offer_file(&mut net, owner, &room);

    command(&mut net, receiver, file_receive(&room, file, true));
    let standby = pair(&net, receiver, source).id;
    link_connected(&mut net, owner, standby);
    assert_eq!(net.state(receiver).files[0].upstream, None);
    command(&mut net, receiver, file_receive(&room, file, false));
    assert!(net.state(receiver).files.is_empty());
    assert!(net.state(owner).files.is_empty());
    assert_eq!(pair(&net, receiver, source).id, standby);
    no_payload_grants(&net, receiver);
    no_payload_grants(&net, owner);

    link_connected(&mut net, receiver, standby);
    assert!(net.state(receiver).files.is_empty());
    no_payload_grants(&net, receiver);

    let replacement = Uuid::new_v4();
    let disconnected = net.authority.disconnect(receiver, 100);
    net.deliver(disconnected);
    assert_eq!(pair(&net, owner, recipient).id, standby);
    command(
        &mut net,
        replacement,
        json!({"type":"join","name":"Recipient","sessionId":recipient,"credential":credential}),
    );
    command(&mut net, replacement, file_receive(&room, file, true));
    assert_eq!(pair(&net, replacement, source).id, standby);
    net.command(
        receiver,
        json!({"type":"link_state","pairId":standby,"state":"connected"}),
    );
    link_connected(&mut net, owner, standby);
    assert_eq!(net.state(replacement).files[0].upstream, None);
    no_payload_grants(&net, replacement);
    link_connected(&mut net, replacement, standby);
    assert_eq!(pair(&net, replacement, source).id, standby);
    assert!(pair(&net, replacement, source).rooms.contains(&room));
    assert_eq!(net.state(replacement).files[0].upstream, Some(source));
}

#[test]
fn cold_screen_direct_failure_discovers_a_room_reader_before_media_failure() {
    let mut net = RoomNetwork::new();
    let [owner, receiver, helper, lobby] = [(); 4].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    let viewer = join(&mut net, receiver, "Viewer");
    let reader = join(&mut net, helper, "Reader");
    join(&mut net, lobby, "Lobby");
    let room = net.create(owner, RoomAccess::Public, false);
    command(
        &mut net,
        helper,
        json!({"type":"browse","roomId":room,"active":true}),
    );
    let screen = publish_screen(&mut net, owner, &room);
    command(&mut net, receiver, subscribe(screen, true));
    let pending = pair(&net, receiver, source);
    assert!(input(pending, screen).is_none());
    let direct = pending.id;
    no_payload_grants(&net, helper);

    command(
        &mut net,
        receiver,
        json!({"type":"link_state","pairId":direct,"state":"failed"}),
    );
    let mut confirmed = Vec::new();
    for _ in 0..2 {
        let leg = net
            .state(helper)
            .pairs
            .iter()
            .find(|p| [source, viewer].contains(&p.peer_id) && !confirmed.contains(&p.id))
            .expect("reader connects both sides of the failed direct path");
        let peer = if leg.peer_id == source {
            owner
        } else {
            receiver
        };
        let id = leg.id;
        link_connected(&mut net, helper, id);
        link_connected(&mut net, peer, id);
        confirmed.push(id);
    }
    let upstream = pair(&net, helper, source);
    let transit = input(upstream, screen).unwrap();
    let incoming = pair(&net, receiver, reader);
    let delivery = input(incoming, screen).unwrap();
    assert_eq!(delivery.input_flow_id, Some(transit.id));
    for (socket, edge, flow, proof) in [
        (helper, upstream.id, transit.id, "forwardable"),
        (receiver, incoming.id, delivery.id, "decoded"),
    ] {
        command(
            &mut net,
            socket,
            json!({"type":"flow_state","pairId":edge,"flowId":flow,"state":proof}),
        );
    }
    assert!(
        input(pair(&net, receiver, reader), screen)
            .unwrap()
            .selected
    );
    no_payload_grants(&net, lobby);
    assert!(net.state(receiver).subscriptions.contains(&screen));
    assert!(!net.failed_screens(receiver).contains(&screen));
}
