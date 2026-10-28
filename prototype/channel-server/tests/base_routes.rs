#![cfg(feature = "server")]

mod support;
use piik_channel_prototype::{
    conversation::ConversationCommand,
    wire::{Event, PairInfo, RoomAccess},
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;

fn join(network: &mut RoomNetwork, connection: Uuid, credential: Option<&str>) -> (Uuid, String) {
    network.command(connection, json!({"type":"join", "name":"Base participant", "key":"invite", "credential":credential}))
        .events.into_iter().find_map(|(_, event)| match event {
            Event::Welcome { session_id, credential, .. } => Some((session_id, credential)), _ => None,
        }).unwrap()
}
fn command(network: &mut RoomNetwork, connection: Uuid, command: Value) {
    let effects = network.command(connection, command);
    assert!(
        !effects.events.iter().any(|(_, event)| matches!(
            event,
            Event::Error { .. }
                | Event::RoomReply {
                    result: piik_channel_prototype::host::RoomResult::Error { .. },
                    ..
                }
        )),
        "authorized production command failed"
    );
}
fn pair(network: &RoomNetwork, connection: Uuid, peer: Uuid, room: &str) -> PairInfo {
    network
        .state(connection)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == peer && pair.rooms.iter().any(|id| id == room))
        .unwrap()
        .clone()
}
fn browse(network: &mut RoomNetwork, connection: Uuid, room: &str, active: bool) {
    command(
        network,
        connection,
        json!({"type":"browse", "roomId":room, "active":active}),
    );
}
fn voice(network: &mut RoomNetwork, connection: Uuid, room: &str, joined: bool) {
    command(
        network,
        connection,
        json!({"type":"voice", "roomId":room, "joined":joined, "muted":false, "deafened":false}),
    );
}
fn publish(network: &mut RoomNetwork, connection: Uuid, room: &str, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    command(
        network,
        connection,
        json!({"type":"publish", "publication":{"id":id,"roomId":room,"kind":kind,"muted":false}}),
    );
    id
}

#[test]
fn room_base_root_is_the_actual_host_session_and_stopping_reading_preserves_activity() {
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let other_page = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, credential) = join(&mut network, host, None);
    let (other_session, _) = join(&mut network, other_page, Some(&credential));
    let (viewer_session, _) = join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    let durable_policy = serde_json::to_value(network.policy(&room)).unwrap();
    browse(&mut network, viewer, &room, true);
    let base = pair(&network, viewer, host_session, &room);
    assert_ne!(
        base.peer_id, other_session,
        "persistent creator identity must not choose another page as root"
    );
    assert!(
        network
            .state(viewer)
            .channel
            .rooms
            .iter()
            .find(|entry| entry.id == room)
            .unwrap()
            .reading
    );
    voice(&mut network, host, &room, true);
    voice(&mut network, viewer, &room, true);
    let speaking = publish(&mut network, viewer, &room, "voice");
    command(
        &mut network,
        viewer,
        json!({"type":"base_state","roomId":room,"pairId":base.id,"ready":true}),
    );
    assert!(
        !pair(&network, host, viewer_session, &room)
            .incoming
            .contains(&speaking),
        "one endpoint report is insufficient"
    );
    command(
        &mut network,
        host,
        json!({"type":"base_state","roomId":room,"pairId":base.id,"ready":true}),
    );
    assert!(
        pair(&network, host, viewer_session, &room)
            .incoming
            .contains(&speaking),
        "both reports establish the voice path"
    );
    voice(&mut network, host, &room, false);
    let screen = publish(&mut network, viewer, &room, "screen");
    browse(&mut network, viewer, &room, false);
    browse(&mut network, viewer, "studio", true);
    let state = network.state(viewer);
    assert!(
        !state
            .channel
            .rooms
            .iter()
            .find(|entry| entry.id == room)
            .unwrap()
            .reading
    );
    assert!(state.publications.iter().any(|entry| entry.id == screen));
    assert!(state
        .voice
        .iter()
        .any(|entry| entry.session_id == viewer_session && entry.room_id == room));
    assert_eq!(pair(&network, viewer, host_session, &room).id, base.id);
    voice(&mut network, viewer, &room, false);
    assert_eq!(
        pair(&network, viewer, host_session, &room).id,
        base.id,
        "publishing still owns base membership"
    );
    command(
        &mut network,
        viewer,
        json!({"type":"unpublish", "publicationId":screen}),
    );
    assert_eq!(
        serde_json::to_value(network.policy(&room)).unwrap(),
        durable_policy,
        "base and activity do not become durable policy"
    );
    assert!(
        !network
            .state(viewer)
            .pairs
            .iter()
            .any(|entry| entry.rooms.contains(&room)),
        "last room demand releases its base lease"
    );
}

#[test]
fn voice_uses_only_mutually_ready_tree_paths_and_non_listeners_can_forward_both_directions() {
    let mut network = RoomNetwork::new();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let d = Uuid::new_v4();
    let (bs, _) = join(&mut network, b, None);
    let (cs, _) = join(&mut network, c, None);
    let (ds, _) = join(&mut network, d, None);
    let room = network.create(b, RoomAccess::Public, false);
    browse(&mut network, c, &room, true);
    browse(&mut network, d, &room, true);
    voice(&mut network, b, &room, true);
    voice(&mut network, d, &room, true);
    let from_b = publish(&mut network, b, &room, "voice");
    let from_d = publish(&mut network, d, &room, "voice");
    let bc = pair(&network, b, cs, &room);
    command(
        &mut network,
        c,
        json!({"type":"base_state", "roomId":room, "pairId":bc.id, "ready":true}),
    );
    assert!(
        network
            .state(c)
            .pairs
            .iter()
            .all(|p| !p.incoming.contains(&from_b) && !p.incoming.contains(&from_d)),
        "one endpoint's open report cannot make a usable base edge"
    );
    command(
        &mut network,
        b,
        json!({"type":"base_state", "roomId":room, "pairId":bc.id, "ready":true}),
    );
    let bd = pair(&network, b, ds, &room);
    command(
        &mut network,
        d,
        json!({"type":"link_state", "pairId":bd.id, "state":"failed"}),
    );
    let cd = pair(&network, c, ds, &room);
    command(
        &mut network,
        d,
        json!({"type":"base_state", "roomId":room, "pairId":cd.id, "ready":true}),
    );
    assert!(
        network
            .state(d)
            .pairs
            .iter()
            .all(|p| !p.incoming.contains(&from_b)),
        "the replacement also needs both endpoint reports"
    );
    command(
        &mut network,
        c,
        json!({"type":"base_state", "roomId":room, "pairId":cd.id, "ready":true}),
    );
    let cb = pair(&network, c, bs, &room);
    let cd = pair(&network, c, ds, &room);
    assert!(cb.incoming.contains(&from_b) && cb.outgoing.contains(&from_d));
    assert!(cd.incoming.contains(&from_d) && cd.outgoing.contains(&from_b));
    assert!(
        !network.state(c).subscriptions.contains(&from_b)
            && !network.state(c).subscriptions.contains(&from_d)
    );
    assert!(
        !network.state(c).voice.iter().any(|v| v.session_id == cs),
        "transit does not join local microphone or listening"
    );
    for (connection, own_voice) in [(b, from_b), (d, from_d)] {
        assert!(
            network
                .state(connection)
                .pairs
                .iter()
                .all(|p| !p.incoming.contains(&own_voice)),
            "a speaker never gets its own publication back"
        );
    }
    browse(&mut network, c, &room, false);
    assert_eq!(
        pair(&network, c, bs, &room).id,
        cb.id,
        "downstream demand retains the non-reading transit"
    );
    let screen = publish(&mut network, c, &room, "screen");
    command(
        &mut network,
        b,
        json!({"type":"subscribe", "publicationId":screen, "enabled":true}),
    );
    let independent = network
        .state(b)
        .pairs
        .iter()
        .find(|p| p.incoming.contains(&screen))
        .unwrap()
        .id;
    assert_eq!(
        independent, cb.id,
        "base and screen share the existing compatible pair"
    );
    command(
        &mut network,
        d,
        json!({"type":"link_state", "pairId":cd.id, "state":"failed"}),
    );
    assert_eq!(
        network
            .state(b)
            .pairs
            .iter()
            .find(|p| p.incoming.contains(&screen))
            .unwrap()
            .id,
        independent,
        "base failure must not retire an independent healthy screen branch"
    );
    voice(&mut network, b, &room, false);
    voice(&mut network, d, &room, false);
    assert_eq!(
        pair(&network, c, bs, &room).id,
        independent,
        "screen and remaining room demand retain the shared pair"
    );
    command(
        &mut network,
        b,
        json!({"type":"subscribe", "publicationId":screen, "enabled":false}),
    );
    assert_eq!(
        pair(&network, c, bs, &room).id,
        independent,
        "removing a media lease leaves its required base lease"
    );
}

#[test]
fn failed_base_data_channel_repairs_its_lease_without_closing_a_shared_screen_pair() {
    let mut network = RoomNetwork::new();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let d = Uuid::new_v4();
    let (bs, _) = join(&mut network, b, None);
    let (cs, _) = join(&mut network, c, None);
    let (ds, _) = join(&mut network, d, None);
    let room = network.create(b, RoomAccess::Public, false);
    browse(&mut network, c, &room, true);
    browse(&mut network, d, &room, true);
    let bc = pair(&network, b, cs, &room);
    let bd = pair(&network, b, ds, &room);
    for (first, second, id) in [(b, c, bc.id), (b, d, bd.id)] {
        for connection in [first, second] {
            command(
                &mut network,
                connection,
                json!({"type":"base_state","roomId":room,"pairId":id,"ready":true}),
            );
        }
    }
    let screen = publish(&mut network, c, &room, "screen");
    command(
        &mut network,
        b,
        json!({"type":"subscribe","publicationId":screen,"enabled":true}),
    );
    assert_eq!(
        network
            .state(b)
            .pairs
            .iter()
            .find(|p| p.incoming.contains(&screen))
            .unwrap()
            .id,
        bc.id
    );
    // This is the actual frontend failBase report for a closed/timed-out DC on a connected PC.
    command(
        &mut network,
        c,
        json!({"type":"base_state","roomId":room,"pairId":bc.id,"ready":false}),
    );
    assert!(
        network
            .state(c)
            .pairs
            .iter()
            .any(|p| p.peer_id == ds && p.rooms.contains(&room)),
        "failed base leg remained assigned forever instead of trying the ready sibling"
    );
    let retained = network
        .state(b)
        .pairs
        .iter()
        .find(|p| p.incoming.contains(&screen))
        .unwrap();
    assert_eq!(
        retained.id, bc.id,
        "base repair must not close the screen's physical pair"
    );
    assert!(
        !retained.rooms.contains(&room),
        "failed base lease retires independently of the media lease"
    );
    assert_eq!(
        pair(&network, d, bs, &room).id,
        bd.id,
        "healthy sibling remains stable"
    );
    for ready in [true, false] {
        command(
            &mut network,
            c,
            json!({"type":"base_state","roomId":room,"pairId":bc.id,"ready":ready}),
        );
    }
    assert!(
        !network
            .state(c)
            .pairs
            .iter()
            .find(|p| p.id == bc.id)
            .unwrap()
            .rooms
            .contains(&room),
        "late base completion cannot reacquire a retired room lease"
    );
}

#[test]
fn idle_file_copies_release_base_and_signaling_recovery_preserves_active_delivery() {
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let source = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, _) = join(&mut network, host, None);
    let (source_session, credential) = join(&mut network, source, None);
    let (viewer_session, _) = join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    let attachment = json!({ "id":Uuid::new_v4(), "name":"retained.bin", "size":3, "mediaType":"application/octet-stream",
        "sha256":piik_channel_prototype::attachment::sha256_hex(b"abc") });
    let confirmation = network.peer_request(
        source,
        &room,
        ConversationCommand::Chat {
            text: String::new(),
            nonce: "file".into(),
            attachments: vec![serde_json::from_value(attachment.clone()).unwrap()],
        },
    );
    assert!(matches!(
        confirmation.result,
        Ok(piik_channel_prototype::history::HistoryResult::Sent(_))
    ));
    command(
        &mut network,
        source,
        json!({"type":"file_offer", "roomId":room, "messageSeq":1, "attachmentId":attachment["id"], "available":true}),
    );
    assert!(
        network.state(source).pairs.is_empty(),
        "idle readable copy does not own a live base connection"
    );
    assert!(
        network.state(source).files.is_empty(),
        "idle copies are not active delivery plans"
    );
    command(
        &mut network,
        viewer,
        json!({"type":"file_receive", "roomId":room, "messageSeq":1, "attachmentId":attachment["id"], "enabled":true}),
    );
    for connection in [source, viewer] {
        let session = if connection == source {
            source_session
        } else {
            viewer_session
        };
        let lease = pair(&network, connection, host_session, &room);
        command(
            &mut network,
            connection,
            json!({"type":"base_state", "roomId":room, "pairId":lease.id, "ready":true}),
        );
        command(
            &mut network,
            host,
            json!({"type":"base_state", "roomId":room, "pairId":lease.id, "ready":true}),
        );
        assert_eq!(pair(&network, host, session, &room).id, lease.id);
    }
    let active = network.state(viewer).files[0].clone();
    assert_eq!(active.source_id, Some(source_session));
    assert_eq!(active.upstream, Some(host_session));
    let lease = pair(&network, viewer, host_session, &room).id;
    browse(&mut network, source, &room, false);
    browse(&mut network, viewer, &room, false);
    assert_eq!(pair(&network, viewer, host_session, &room).id, lease);
    let effects = network.authority.disconnect(source, 100);
    network.deliver(effects);
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(source_session)
    );
    assert_eq!(network.state(viewer).files[0].upstream, active.upstream);
    assert_eq!(pair(&network, viewer, host_session, &room).id, lease);
    command(
        &mut network,
        source,
        json!({"type":"join", "name":"Recovered", "credential":credential, "sessionId":source_session}),
    );
    assert!(network
        .state(source)
        .sessions
        .iter()
        .any(|session| session.id == source_session && session.online));
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(source_session)
    );
    let effects = network.authority.disconnect(source, 200);
    network.deliver(effects);
    let effects = network
        .authority
        .expire(200 + piik_channel_prototype::RECOVERY_MS - 1);
    network.deliver(effects);
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(source_session)
    );
    let effects = network
        .authority
        .expire(200 + piik_channel_prototype::RECOVERY_MS);
    network.deliver(effects);
    assert_eq!(
        network.state(viewer).files[0].source_id,
        None,
        "retired session withdraws its copy"
    );
    command(
        &mut network,
        viewer,
        json!({"type":"file_receive", "roomId":room, "messageSeq":1, "attachmentId":attachment["id"], "enabled":false}),
    );
    assert!(network.state(viewer).files.is_empty());
    assert!(network.state(viewer).pairs.is_empty());
}

#[test]
fn sender_picture_preparation_failure_repairs_only_its_assigned_flow() {
    let mut network = RoomNetwork::new();
    let source = Uuid::new_v4();
    let relay = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    let (source_session, _) = join(&mut network, source, None);
    let (relay_session, _) = join(&mut network, relay, None);
    let (viewer_session, _) = join(&mut network, viewer, None);
    join(&mut network, stranger, None);
    let room = network.create(source, RoomAccess::Public, false);
    for connection in [relay, viewer] {
        browse(&mut network, connection, &room, true);
    }
    for connection in [relay, viewer] {
        let lease = pair(&network, connection, source_session, &room);
        for endpoint in [source, connection] {
            command(
                &mut network,
                endpoint,
                json!({"type":"base_state", "roomId":room, "pairId":lease.id, "ready":true}),
            );
        }
    }
    for connection in [source, viewer] {
        voice(&mut network, connection, &room, true);
        publish(&mut network, connection, &room, "voice");
    }
    let attachment = json!({"id":Uuid::new_v4(),"name":"live.bin","size":3,"mediaType":"application/octet-stream",
        "sha256":piik_channel_prototype::attachment::sha256_hex(b"abc")});
    let confirmation = network.peer_request(
        source,
        &room,
        ConversationCommand::Chat {
            text: String::new(),
            nonce: "retained".into(),
            attachments: vec![serde_json::from_value(attachment.clone()).unwrap()],
        },
    );
    assert!(matches!(
        confirmation.result,
        Ok(piik_channel_prototype::history::HistoryResult::Sent(_))
    ));
    command(
        &mut network,
        source,
        json!({"type":"file_offer","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"available":true}),
    );
    command(
        &mut network,
        viewer,
        json!({"type":"file_receive","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"enabled":true}),
    );
    let picture = publish(&mut network, source, &room, "screen");
    for connection in [relay, viewer] {
        command(
            &mut network,
            connection,
            json!({"type":"subscribe","publicationId":picture,"enabled":true}),
        );
    }
    let root_relay = pair(&network, relay, source_session, &room);
    let root_viewer = pair(&network, viewer, source_session, &room);
    command(
        &mut network,
        relay,
        json!({"type":"flow_state","publicationId":picture,"pairId":root_relay.id,"ready":true}),
    );
    let companion = publish(&mut network, viewer, &room, "screen");
    command(
        &mut network,
        source,
        json!({"type":"subscribe","publicationId":companion,"enabled":true}),
    );
    let before = network.state(viewer).clone();
    // A sender cannot claim receiver readiness, nor can an unrelated endpoint
    // report failure for somebody else's otherwise-current pair.
    let ignored = network.command(
        source,
        json!({"type":"flow_state","publicationId":picture,"pairId":root_viewer.id,"ready":true}),
    );
    assert!(ignored.events.is_empty());
    let ignored = network.command(
        stranger,
        json!({"type":"flow_state","publicationId":picture,"pairId":root_viewer.id,"ready":false}),
    );
    assert!(ignored.events.is_empty());
    // This receiver has never supplied ready=true. A real add-track/codec failure
    // at its sender must immediately admit the already-ready relay alternative.
    command(
        &mut network,
        source,
        json!({"type":"flow_state","publicationId":picture,"pairId":root_viewer.id,"ready":false}),
    );
    let repaired = network.state(viewer);
    assert!(repaired
        .pairs
        .iter()
        .any(|pair| pair.peer_id == relay_session && pair.incoming.contains(&picture)));
    let retained = repaired
        .pairs
        .iter()
        .find(|pair| pair.id == root_viewer.id)
        .unwrap();
    assert!(retained.rooms.contains(&room));
    assert!(retained.outgoing.contains(&companion));
    assert!(!retained.incoming.contains(&picture));
    assert_eq!(
        serde_json::to_value(&repaired.files).unwrap(),
        serde_json::to_value(&before.files).unwrap()
    );
    assert_eq!(repaired.voice.len(), before.voice.len());
    let voice_ids: Vec<_> = repaired
        .publications
        .iter()
        .filter(|publication| publication.kind == piik_channel_prototype::wire::Kind::Voice)
        .map(|publication| publication.id)
        .collect();
    for publication in voice_ids {
        let old = before
            .pairs
            .iter()
            .find(|pair| {
                pair.incoming.contains(&publication) || pair.outgoing.contains(&publication)
            })
            .unwrap();
        let current = repaired
            .pairs
            .iter()
            .find(|pair| {
                pair.incoming.contains(&publication) || pair.outgoing.contains(&publication)
            })
            .unwrap();
        assert_eq!(current.id, old.id);
    }
    // The physical pair still serves other work, but its old picture lease no
    // longer authorizes either endpoint to damage the replacement route.
    for endpoint in [source, viewer] {
        let ignored = network.command(endpoint, json!({"type":"flow_state","publicationId":picture,"pairId":root_viewer.id,"ready":false}));
        assert!(ignored.events.is_empty());
    }
    assert!(network
        .state(viewer)
        .pairs
        .iter()
        .any(|pair| pair.peer_id == relay_session && pair.incoming.contains(&picture)));
    assert!(network
        .state(source)
        .pairs
        .iter()
        .any(|pair| pair.peer_id == viewer_session && pair.incoming.contains(&companion)));
}

#[test]
fn internal_screen_source_uses_three_existing_base_directions_and_shared_nonviewer_transit() {
    let mut network = RoomNetwork::new();
    let connections: Vec<_> = (0..7).map(|_| Uuid::new_v4()).collect();
    let sessions: Vec<_> = connections
        .iter()
        .map(|connection| join(&mut network, *connection, None).0)
        .collect();
    let room = network.create(connections[0], RoomAccess::Public, false);
    for connection in &connections[1..] {
        browse(&mut network, *connection, &room, true);
    }
    // Establish the real bounded room tree through both endpoint DC proofs.
    for _ in 0..4 {
        let edges: Vec<_> = connections
            .iter()
            .flat_map(|connection| {
                network
                    .state(*connection)
                    .pairs
                    .iter()
                    .filter(|pair| pair.rooms.contains(&room))
                    .map(|pair| (*connection, pair.id))
                    .collect::<Vec<_>>()
            })
            .collect();
        for (connection, pair_id) in edges {
            command(
                &mut network,
                connection,
                json!({"type":"base_state","roomId":room,"pairId":pair_id,"ready":true}),
            );
        }
    }
    let root_children: Vec<_> = network
        .state(connections[0])
        .pairs
        .iter()
        .filter(|pair| pair.rooms.contains(&room))
        .map(|pair| pair.peer_id)
        .collect();
    assert_eq!(root_children.len(), 2);
    let source_session = root_children[0];
    let transit_session = root_children[1];
    let connection_of = |session| {
        connections[sessions
            .iter()
            .position(|candidate| *candidate == session)
            .unwrap()]
    };
    let source = connection_of(source_session);
    let transit = connection_of(transit_session);
    assert_eq!(
        network
            .state(source)
            .pairs
            .iter()
            .filter(|pair| pair.rooms.contains(&room))
            .count(),
        3
    );
    assert_eq!(
        network
            .state(transit)
            .pairs
            .iter()
            .filter(|pair| pair.rooms.contains(&room))
            .count(),
        3
    );
    let picture = publish(&mut network, source, &room, "screen");
    let viewers: Vec<_> = connections
        .iter()
        .copied()
        .filter(|connection| *connection != source && *connection != transit)
        .collect();
    for connection in &viewers {
        command(
            &mut network,
            *connection,
            json!({"type":"subscribe","publicationId":picture,"enabled":true}),
        );
    }
    let source_outputs: Vec<_> = network
        .state(source)
        .pairs
        .iter()
        .filter(|pair| pair.outgoing.contains(&picture))
        .collect();
    assert_eq!(
        source_outputs.len(),
        3,
        "reverse base projection is not limited by its root-oriented branching policy"
    );
    for pair in source_outputs {
        assert!(
            pair.rooms.contains(&room),
            "startup reuses existing physical base pairs"
        );
    }
    let transit_view = network.state(transit);
    assert!(!transit_view.subscriptions.contains(&picture));
    assert_eq!(
        transit_view
            .pairs
            .iter()
            .filter(|pair| pair.incoming.contains(&picture))
            .count(),
        1
    );
    assert_eq!(
        transit_view
            .pairs
            .iter()
            .filter(|pair| pair.outgoing.contains(&picture))
            .count(),
        2
    );
    let copies: usize = connections
        .iter()
        .map(|connection| {
            network
                .state(*connection)
                .pairs
                .iter()
                .filter(|pair| pair.outgoing.contains(&picture))
                .count()
        })
        .sum();
    assert_eq!(
        copies, 6,
        "two downstream viewers share each common suffix edge exactly once"
    );
    // Local unwatch does not retire the root's necessary forwarding duty.
    command(
        &mut network,
        connections[0],
        json!({"type":"subscribe","publicationId":picture,"enabled":false}),
    );
    assert!(!network
        .state(connections[0])
        .subscriptions
        .contains(&picture));
    assert!(network
        .state(connections[0])
        .pairs
        .iter()
        .any(|pair| pair.incoming.contains(&picture)));
    assert!(network
        .state(connections[0])
        .pairs
        .iter()
        .any(|pair| pair.outgoing.contains(&picture)));
    let before: Vec<_> = connections
        .iter()
        .map(|connection| {
            network
                .state(*connection)
                .pairs
                .iter()
                .filter(|pair| pair.incoming.contains(&picture) || pair.outgoing.contains(&picture))
                .map(|pair| {
                    (
                        pair.id,
                        pair.incoming.contains(&picture),
                        pair.outgoing.contains(&picture),
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect();
    let root_pair = network
        .state(source)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == sessions[0])
        .unwrap()
        .id;
    command(
        &mut network,
        source,
        json!({"type":"base_state","roomId":room,"pairId":root_pair,"ready":false}),
    );
    for (index, connection) in connections.iter().enumerate() {
        let after: Vec<_> = network
            .state(*connection)
            .pairs
            .iter()
            .filter(|pair| pair.incoming.contains(&picture) || pair.outgoing.contains(&picture))
            .map(|pair| {
                (
                    pair.id,
                    pair.incoming.contains(&picture),
                    pair.outgoing.contains(&picture),
                )
            })
            .collect();
        assert_eq!(
            after, before[index],
            "base repair does not replace an independently healthy screen path"
        );
    }
}
