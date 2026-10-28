#![cfg(feature = "sqlite")]

mod support;
use piik_channel_core::{
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
                    result: piik_channel_core::host::RoomResult::Error { .. },
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
fn revoking_a_private_transit_retires_its_branch_and_keeps_its_public_pair() {
    let mut network = RoomNetwork::new();
    let connections: Vec<_> = (0..4).map(|_| Uuid::new_v4()).collect();
    let sessions: Vec<_> = connections
        .iter()
        .map(|connection| join(&mut network, *connection, None).0)
        .collect();
    let room = network.create(connections[0], RoomAccess::Private, true);
    let invitation = network
        .command(connections[0], json!({"type":"room_invite","roomId":room}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::RoomInvite { key, .. } => Some(key),
            _ => None,
        })
        .unwrap();
    for index in 1..4 {
        command(
            &mut network,
            connections[index],
            json!({"type":"enter_room","roomId":room,"inviteKey":invitation}),
        );
        browse(&mut network, connections[index], &room, true);
        let edge = network
            .state(connections[index])
            .pairs
            .iter()
            .find(|pair| pair.rooms.contains(&room))
            .unwrap()
            .clone();
        let parent = sessions
            .iter()
            .position(|session| *session == edge.peer_id)
            .unwrap();
        for endpoint in [connections[index], connections[parent]] {
            command(
                &mut network,
                endpoint,
                json!({"type":"base_state","roomId":room,"pairId":edge.id,"ready":true}),
            );
        }
    }
    let relay_session = network
        .state(connections[3])
        .pairs
        .iter()
        .find(|pair| pair.rooms.contains(&room))
        .unwrap()
        .peer_id;
    let relay = sessions
        .iter()
        .position(|session| *session == relay_session)
        .unwrap();
    assert_ne!(
        relay, 0,
        "the fourth participant needs an actual internal transit"
    );
    let private = publish(&mut network, connections[0], &room, "screen");
    for index in 1..4 {
        command(
            &mut network,
            connections[index],
            json!({"type":"subscribe","publicationId":private,"enabled":true}),
        );
    }
    let public_room = network.create(connections[0], RoomAccess::Public, false);
    let public = publish(&mut network, connections[0], &public_room, "screen");
    command(
        &mut network,
        connections[relay],
        json!({"type":"subscribe","publicationId":public,"enabled":true}),
    );
    let shared_pair = network
        .state(connections[relay])
        .pairs
        .iter()
        .find(|pair| {
            pair.incoming
                .iter()
                .any(|flow| flow.publication_id == public)
        })
        .unwrap()
        .id;
    assert!(network
        .state(connections[relay])
        .pairs
        .iter()
        .find(|pair| pair.id == shared_pair)
        .unwrap()
        .incoming
        .iter()
        .any(|flow| flow.publication_id == private));
    let user = network
        .state(connections[relay])
        .sessions
        .iter()
        .find(|session| session.id == relay_session)
        .unwrap()
        .user_id;
    command(
        &mut network,
        connections[0],
        json!({"type":"revoke_room_access","roomId":room,"userId":user}),
    );
    let retired = network.state(connections[relay]);
    assert!(!retired
        .publications
        .iter()
        .any(|publication| publication.id == private));
    assert!(retired.pairs.iter().any(|pair| pair.id == shared_pair
        && pair
            .incoming
            .iter()
            .any(|flow| flow.publication_id == public)));
    assert!(network
        .state(connections[3])
        .pairs
        .iter()
        .any(|pair| pair.peer_id != relay_session
            && pair
                .incoming
                .iter()
                .any(|flow| flow.publication_id == private)));
    assert!(!network
        .state(connections[3])
        .pairs
        .iter()
        .any(|pair| pair.peer_id == relay_session
            && pair
                .incoming
                .iter()
                .any(|flow| flow.publication_id == private)));
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
            .iter()
            .any(|flow| flow.publication_id == speaking),
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
            .iter()
            .any(|flow| flow.publication_id == speaking),
        "both reports establish the voice path"
    );
    voice(&mut network, host, &room, false);
    let screen = publish(&mut network, viewer, &room, "screen");
    browse(&mut network, viewer, &room, false);
    let other_room = network.create(other_page, RoomAccess::Public, false);
    browse(&mut network, viewer, &other_room, true);
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
        network.state(c).pairs.iter().all(|p| !p
            .incoming
            .iter()
            .any(|flow| flow.publication_id == from_b)
            && !p.incoming.iter().any(|flow| flow.publication_id == from_d)),
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
            .all(|p| !p.incoming.iter().any(|flow| flow.publication_id == from_b)),
        "the replacement also needs both endpoint reports"
    );
    command(
        &mut network,
        c,
        json!({"type":"base_state", "roomId":room, "pairId":cd.id, "ready":true}),
    );
    let cb = pair(&network, c, bs, &room);
    let cd = pair(&network, c, ds, &room);
    assert!(
        cb.incoming.iter().any(|flow| flow.publication_id == from_b)
            && cb.outgoing.iter().any(|flow| flow.publication_id == from_d)
    );
    assert!(
        cd.incoming.iter().any(|flow| flow.publication_id == from_d)
            && cd.outgoing.iter().any(|flow| flow.publication_id == from_b)
    );
    assert!(
        !network.state(c).subscriptions.contains(&from_b)
            && !network.state(c).subscriptions.contains(&from_d)
    );
    assert!(
        !network.state(c).voice.iter().any(|v| v.session_id == cs),
        "transit does not join local microphone or listening"
    );
    command(
        &mut network,
        d,
        json!({"type":"voice","roomId":room,"joined":true,"muted":true,"deafened":true}),
    );
    command(
        &mut network,
        d,
        json!({"type":"publish","publication":{"id":from_d,"roomId":room,"kind":"voice","muted":false}}),
    );
    assert!(
        network
            .state(d)
            .publications
            .iter()
            .find(|p| p.id == from_d)
            .unwrap()
            .muted
    );
    assert!(network.state(d).subscriptions.contains(&from_b));
    assert!(network.state(b).subscriptions.contains(&from_d));
    assert_eq!(pair(&network, c, ds, &room).id, cd.id);
    voice(&mut network, d, &room, true);
    for (connection, own_voice) in [(b, from_b), (d, from_d)] {
        assert!(
            network.state(connection).pairs.iter().all(|p| !p
                .incoming
                .iter()
                .any(|flow| flow.publication_id == own_voice)),
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
        .find(|p| p.incoming.iter().any(|flow| flow.publication_id == screen))
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
            .find(|p| p.incoming.iter().any(|flow| flow.publication_id == screen))
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
    let user = network
        .state(c)
        .sessions
        .iter()
        .find(|s| s.id == cs)
        .unwrap()
        .user_id;
    let owner = Uuid::new_v4();
    command(
        &mut network,
        owner,
        json!({"type":"join","key":"owner","name":"Domain owner"}),
    );
    command(
        &mut network,
        owner,
        json!({"type":"set_roles","userId":user,"roles":[]}),
    );
    assert!(network.state(c).sessions.iter().any(|s| s.id == cs));
    assert!(network.state(c).users.iter().any(|u| u.id == user));
    assert!(!network.state(b).publications.iter().any(|p| p.id == screen));
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
            .find(|p| p.incoming.iter().any(|flow| flow.publication_id == screen))
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
        .find(|p| p.incoming.iter().any(|flow| flow.publication_id == screen))
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
        "sha256":piik_channel_core::attachment::sha256_hex(b"abc") });
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
        Ok(piik_channel_core::history::HistoryResult::Sent(_))
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
        .expire(200 + piik_channel_core::RECOVERY_MS - 1);
    network.deliver(effects);
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(source_session)
    );
    let effects = network
        .authority
        .expire(200 + piik_channel_core::RECOVERY_MS);
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
fn retired_picture_report_cannot_fail_recreated_flow_on_retained_base_pair() {
    let mut network = RoomNetwork::new();
    let source = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (source_session, _) = join(&mut network, source, None);
    join(&mut network, viewer, None);
    let room = network.create(source, RoomAccess::Public, false);
    browse(&mut network, viewer, &room, true);
    let lease = pair(&network, viewer, source_session, &room);
    for endpoint in [source, viewer] {
        command(
            &mut network,
            endpoint,
            json!({"type":"base_state", "roomId":room, "pairId":lease.id, "ready":true}),
        );
    }
    let picture = publish(&mut network, source, &room, "screen");
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":picture, "enabled":true}),
    );
    let old_flow = pair(&network, viewer, source_session, &room)
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .unwrap()
        .id;
    voice(&mut network, source, &room, true);
    voice(&mut network, viewer, &room, true);
    let microphone = publish(&mut network, source, &room, "voice");
    let voice_flow = pair(&network, viewer, source_session, &room)
        .incoming
        .iter()
        .find(|flow| flow.publication_id == microphone)
        .unwrap()
        .id;
    assert!(pair(&network, viewer, source_session, &room)
        .incoming
        .iter()
        .any(|flow| flow.publication_id == picture));
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":picture, "enabled":false}),
    );
    let retired = pair(&network, viewer, source_session, &room);
    assert_eq!(retired.id, lease.id);
    assert!(!retired
        .incoming
        .iter()
        .any(|flow| flow.publication_id == picture));
    assert!(retired.rooms.contains(&room));
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":picture, "enabled":true}),
    );
    assert!(pair(&network, viewer, source_session, &room)
        .incoming
        .iter()
        .any(|flow| flow.publication_id == picture));

    // This callback belongs to the retired media reader, while its physical
    // base pair and publication now serve a newly requested picture flow.
    let recreated = pair(&network, viewer, source_session, &room)
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .unwrap()
        .id;
    assert_ne!(recreated, old_flow);
    let signaling = network.command(source, json!({"type":"signal","pairId":lease.id,"payload":{
        "exchangeId":Uuid::new_v4(),"description":{"type":"offer","sdp":"pending-shared-pair"},
        "tracks":[{"flowId":old_flow,"streamId":"retired"},{"flowId":voice_flow,"streamId":"voice"}]
    }}));
    assert!(signaling.events.iter().any(|(recipient, event)| *recipient == viewer && matches!(event,
        Event::Signal { payload, .. } if payload.tracks.as_ref().is_some_and(|tracks| tracks.len() == 1 && tracks[0].flow_id == voice_flow))));
    for ready in [true, false] {
        let ignored = network.command(
            viewer,
            json!({"type":"flow_state", "flowId":old_flow, "pairId":lease.id, "state":if ready { "forwardable" } else { "failed" }}),
        );
        assert!(
            ignored.events.is_empty(),
            "retired reports are rejected before reaching the current route"
        );
    }
    let current = pair(&network, viewer, source_session, &room);
    assert_eq!(current.id, lease.id);
    assert!(current.rooms.contains(&room));
    assert!(
        current
            .incoming
            .iter()
            .any(|flow| flow.publication_id == picture),
        "a retired failure must not remove the replacement picture flow"
    );
    assert_eq!(
        current
            .incoming
            .iter()
            .find(|flow| flow.publication_id == picture)
            .unwrap()
            .id,
        recreated
    );
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
        "sha256":piik_channel_core::attachment::sha256_hex(b"abc")});
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
        Ok(piik_channel_core::history::HistoryResult::Sent(_))
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
        json!({"type":"flow_state","flowId":root_relay.incoming.iter().find(|flow| flow.publication_id == picture).unwrap().id,"pairId":root_relay.id,"state":"forwardable"}),
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
        json!({"type":"flow_state","flowId":root_viewer.incoming.iter().find(|flow| flow.publication_id == picture).unwrap().id,"pairId":root_viewer.id,"state":"forwardable"}),
    );
    assert!(ignored.events.is_empty());
    let ignored = network.command(
        stranger,
        json!({"type":"flow_state","flowId":root_viewer.incoming.iter().find(|flow| flow.publication_id == picture).unwrap().id,"pairId":root_viewer.id,"state":"failed"}),
    );
    assert!(ignored.events.is_empty());
    // This receiver has never supplied ready=true. A real add-track/codec failure
    // at its sender must immediately admit the already-ready relay alternative.
    command(
        &mut network,
        source,
        json!({"type":"flow_state","flowId":root_viewer.incoming.iter().find(|flow| flow.publication_id == picture).unwrap().id,"pairId":root_viewer.id,"state":"failed"}),
    );
    let repaired = network.state(viewer);
    assert!(repaired
        .pairs
        .iter()
        .any(|pair| pair.peer_id == relay_session
            && pair
                .incoming
                .iter()
                .any(|flow| flow.publication_id == picture)));
    let retained = repaired
        .pairs
        .iter()
        .find(|pair| pair.id == root_viewer.id)
        .unwrap();
    assert!(retained.rooms.contains(&room));
    assert!(retained
        .outgoing
        .iter()
        .any(|flow| flow.publication_id == companion));
    assert!(!retained
        .incoming
        .iter()
        .any(|flow| flow.publication_id == picture));
    assert_eq!(
        serde_json::to_value(&repaired.files).unwrap(),
        serde_json::to_value(&before.files).unwrap()
    );
    assert_eq!(repaired.voice.len(), before.voice.len());
    let voice_ids: Vec<_> = repaired
        .publications
        .iter()
        .filter(|publication| publication.kind == piik_channel_core::wire::Kind::Voice)
        .map(|publication| publication.id)
        .collect();
    for publication in voice_ids {
        let old = before
            .pairs
            .iter()
            .find(|pair| {
                pair.incoming
                    .iter()
                    .any(|flow| flow.publication_id == publication)
                    || pair
                        .outgoing
                        .iter()
                        .any(|flow| flow.publication_id == publication)
            })
            .unwrap();
        let current = repaired
            .pairs
            .iter()
            .find(|pair| {
                pair.incoming
                    .iter()
                    .any(|flow| flow.publication_id == publication)
                    || pair
                        .outgoing
                        .iter()
                        .any(|flow| flow.publication_id == publication)
            })
            .unwrap();
        assert_eq!(current.id, old.id);
    }
    // The physical pair still serves other work, but its old picture lease no
    // longer authorizes either endpoint to damage the replacement route.
    for endpoint in [source, viewer] {
        let ignored = network.command(endpoint, json!({"type":"flow_state","flowId":root_viewer.incoming.iter().find(|flow| flow.publication_id == picture).unwrap().id,"pairId":root_viewer.id,"state":"failed"}));
        assert!(ignored.events.is_empty());
    }
    assert!(network
        .state(viewer)
        .pairs
        .iter()
        .any(|pair| pair.peer_id == relay_session
            && pair
                .incoming
                .iter()
                .any(|flow| flow.publication_id == picture)));
    assert!(network
        .state(source)
        .pairs
        .iter()
        .any(|pair| pair.peer_id == viewer_session
            && pair
                .incoming
                .iter()
                .any(|flow| flow.publication_id == companion)));
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
        .filter(|pair| {
            pair.outgoing
                .iter()
                .any(|flow| flow.publication_id == picture)
        })
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
            .filter(|pair| pair
                .incoming
                .iter()
                .any(|flow| flow.publication_id == picture))
            .count(),
        1
    );
    assert_eq!(
        transit_view
            .pairs
            .iter()
            .filter(|pair| pair
                .outgoing
                .iter()
                .any(|flow| flow.publication_id == picture))
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
                .filter(|pair| {
                    pair.outgoing
                        .iter()
                        .any(|flow| flow.publication_id == picture)
                })
                .count()
        })
        .sum();
    assert_eq!(
        copies, 6,
        "two downstream viewers share each common suffix edge exactly once"
    );
    let forwarding_before: Vec<_> = network
        .state(connections[0])
        .pairs
        .iter()
        .flat_map(|pair| pair.incoming.iter().chain(&pair.outgoing))
        .filter(|flow| flow.publication_id == picture)
        .map(|flow| flow.id)
        .collect();
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
    assert!(network.state(connections[0]).pairs.iter().any(|pair| pair
        .incoming
        .iter()
        .any(|flow| flow.publication_id == picture)));
    assert!(network.state(connections[0]).pairs.iter().any(|pair| pair
        .outgoing
        .iter()
        .any(|flow| flow.publication_id == picture)));
    let forwarding_after: Vec<_> = network
        .state(connections[0])
        .pairs
        .iter()
        .flat_map(|pair| pair.incoming.iter().chain(&pair.outgoing))
        .filter(|flow| flow.publication_id == picture)
        .map(|flow| flow.id)
        .collect();
    assert_eq!(
        forwarding_after, forwarding_before,
        "unwatch preserves necessary transit leases"
    );
    let before: Vec<_> = connections
        .iter()
        .map(|connection| {
            network
                .state(*connection)
                .pairs
                .iter()
                .filter(|pair| {
                    pair.incoming
                        .iter()
                        .any(|flow| flow.publication_id == picture)
                        || pair
                            .outgoing
                            .iter()
                            .any(|flow| flow.publication_id == picture)
                })
                .map(|pair| {
                    (
                        pair.id,
                        pair.incoming
                            .iter()
                            .find(|flow| flow.publication_id == picture)
                            .map(|flow| flow.id),
                        pair.outgoing
                            .iter()
                            .find(|flow| flow.publication_id == picture)
                            .map(|flow| flow.id),
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
            .filter(|pair| {
                pair.incoming
                    .iter()
                    .any(|flow| flow.publication_id == picture)
                    || pair
                        .outgoing
                        .iter()
                        .any(|flow| flow.publication_id == picture)
            })
            .map(|pair| {
                (
                    pair.id,
                    pair.incoming
                        .iter()
                        .find(|flow| flow.publication_id == picture)
                        .map(|flow| flow.id),
                    pair.outgoing
                        .iter()
                        .find(|flow| flow.publication_id == picture)
                        .map(|flow| flow.id),
                )
            })
            .collect();
        assert_eq!(
            after, before[index],
            "base repair does not replace an independently healthy screen path"
        );
    }
}

#[test]
fn hosted_media_deadline_wakes_room_without_fencing_an_earlier_request() {
    use piik_channel_core::{host::HostAction, wire::Request};
    let mut network = RoomNetwork::new();
    let source = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let (source_session, _) = join(&mut network, source, None);
    let (a_session, _) = join(&mut network, a, None);
    join(&mut network, b, None);
    let room = network.create(source, RoomAccess::Public, false);
    for viewer in [a, b] {
        browse(&mut network, viewer, &room, true);
    }
    for viewer in [a, b] {
        let lease = pair(&network, viewer, source_session, &room);
        for endpoint in [source, viewer] {
            command(
                &mut network,
                endpoint,
                json!({"type":"base_state","roomId":room,"pairId":lease.id,"ready":true}),
            );
        }
    }
    for endpoint in [source, a] {
        voice(&mut network, endpoint, &room, true);
    }
    publish(&mut network, source, &room, "voice");
    let picture = publish(&mut network, source, &room, "screen");
    command(
        &mut network,
        a,
        json!({"type":"subscribe","publicationId":picture,"enabled":true}),
    );
    let proven = pair(&network, a, source_session, &room);
    let proven_flow = proven
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .unwrap()
        .id;
    command(
        &mut network,
        a,
        json!({"type":"flow_state","flowId":proven_flow,"pairId":proven.id,"state":"forwardable"}),
    );
    let starting_effects = network.authority.handle(
        b,
        Request::parse(
            &json!({"type":"subscribe","publicationId":picture,"enabled":true}).to_string(),
        )
        .unwrap(),
        100,
    );
    let starting_input = starting_effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let starting = network.host_turn(&room, starting_input);
    // Execute an ordinary turn, but keep its valid domain reply in flight.
    let effects = network.authority.handle(
        a,
        Request::parse(
            &json!({"type":"browse","roomId":room,"active":true,"requestId":"earlier"}).to_string(),
        )
        .unwrap(),
        100,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let earlier = network.host_turn(&room, input);
    // A newer input is already issued; the completed earlier projection must
    // still install its first media deadline without waiting for the input queue.
    command(
        &mut network,
        source,
        json!({"type":"host_output","roomId":room,"output":starting}),
    );
    let before = network.state(b).clone();
    let deadline = earlier.projection.next_route_deadline.unwrap();
    assert_eq!(deadline, 20_100);
    let effects = network.authority.expire(deadline);
    assert!(
        !effects
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::State { .. })),
        "domain does not project a route replacement itself"
    );
    let wake = effects
        .events
        .iter()
        .find_map(|(recipient, event)| match event {
            Event::HostInput { input, .. } => {
                assert_eq!(
                    *recipient, source,
                    "wake addresses the physical host connection"
                );
                Some(input.clone())
            }
            _ => None,
        })
        .unwrap();
    assert!(matches!(wake.action, HostAction::RouteWake));
    assert_eq!(wake.now, deadline);
    assert_eq!(
        serde_json::to_value(&network.state(b).pairs).unwrap(),
        serde_json::to_value(&before.pairs).unwrap(),
        "domain wake does not choose or mutate room paths"
    );
    let mut stale_projection = earlier.clone();
    stale_projection.reply = None;
    let late = network.command(
        source,
        json!({"type":"host_output","roomId":room,"output":earlier}),
    );
    assert!(
        late.events.iter().any(|(target, event)| *target == a
            && matches!(event,Event::RoomReply{request_id:Some(id),..}if id=="earlier")),
        "wake does not invalidate an earlier ordinary reply"
    );
    assert!(!network.authority.expire(deadline+1).events.iter().any(|(_,event)|matches!(event,Event::HostInput{input,..}if matches!(input.action,HostAction::RouteWake))),"old projection cannot reinsert a consumed wake deadline");
    network.deliver(effects);
    let repaired_pairs = serde_json::to_value(&network.state(b).pairs).unwrap();
    assert!(network
        .state(b)
        .pairs
        .iter()
        .any(|pair| pair.peer_id == a_session
            && pair
                .incoming
                .iter()
                .any(|flow| flow.publication_id == picture)));
    let replay = network.command(
        source,
        json!({"type":"host_output","roomId":room,"output":stale_projection}),
    );
    assert!(
        !replay
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::State { .. })),
        "old projection is not re-applied"
    );
    assert_eq!(
        serde_json::to_value(&network.state(b).pairs).unwrap(),
        repaired_pairs
    );
    let retained = pair(&network, a, source_session, &room);
    assert_eq!(retained.id, proven.id);
    assert_eq!(retained.rooms, proven.rooms);
    assert_eq!(
        serde_json::to_value(retained.incoming).unwrap(),
        serde_json::to_value(proven.incoming).unwrap(),
        "proven picture and voice bindings remain"
    );
}

#[test]
fn failed_pair_does_not_invalidate_an_earlier_browse_reply_or_revive_old_projection() {
    use piik_channel_core::{
        host::{HostAction, RoomResult},
        wire::Request,
    };
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, _) = join(&mut network, host, None);
    join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    browse(&mut network, viewer, &room, true);
    let original = pair(&network, viewer, host_session, &room);
    for endpoint in [host, viewer] {
        command(
            &mut network,
            endpoint,
            json!({"type":"base_state","roomId":room,"pairId":original.id,"ready":true}),
        );
    }
    let effects = network.authority.handle(
        viewer,
        Request::parse(
            &json!({"type":"browse","roomId":room,"active":true,"requestId":"before-failure"})
                .to_string(),
        )
        .unwrap(),
        100,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let earlier = network.host_turn(&room, input);
    let effects = network.authority.handle(
        viewer,
        Request::parse(
            &json!({"type":"link_state","pairId":original.id,"state":"failed"}).to_string(),
        )
        .unwrap(),
        101,
    );
    assert!(effects.events.iter().any(|(recipient, event)| {
        *recipient == host
            && matches!(event, Event::HostInput { input, .. }
                if matches!(input.action, HostAction::PairFailed { .. }))
    }));
    network.deliver(effects);
    assert!(!network
        .state(viewer)
        .pairs
        .iter()
        .any(|pair| pair.id == original.id));
    let late = network.command(
        host,
        json!({"type":"host_output","roomId":room,"output":earlier}),
    );
    assert!(
        late.events.iter().any(|(recipient, event)| {
            *recipient == viewer
                && matches!(event, Event::RoomReply {
                    request_id: Some(id), result: RoomResult::Done, ..
                } if id == "before-failure")
        }),
        "physical pair failure does not revoke a completed Browse request"
    );
    assert!(
        !network
            .state(viewer)
            .pairs
            .iter()
            .any(|pair| pair.id == original.id),
        "old Browse projection must not restore the retired physical pair"
    );
}

#[test]
fn unrelated_leave_does_not_invalidate_an_earlier_browse_reply_or_revive_retired_activity() {
    use piik_channel_core::{host::RoomResult, wire::Request};
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let (host_session, _) = join(&mut network, host, None);
    let (b_session, _) = join(&mut network, b, None);
    let (c_session, _) = join(&mut network, c, None);
    let room = network.create(host, RoomAccess::Public, false);
    for viewer in [b, c] {
        browse(&mut network, viewer, &room, true);
    }
    let c_pair = pair(&network, c, host_session, &room).id;
    let c_picture = publish(&mut network, c, &room, "screen");
    let b_identity = network
        .state(b)
        .sessions
        .iter()
        .find(|session| session.id == b_session)
        .unwrap()
        .clone();
    let effects = network.authority.handle(
        b,
        Request::parse(
            &json!({"type":"browse","roomId":room,"active":true,"requestId":"before-c-leaves"})
                .to_string(),
        )
        .unwrap(),
        100,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let earlier = network.host_turn(&room, input);
    command(&mut network, c, json!({"type":"leave"}));
    let current = network.state(b);
    assert_eq!(
        serde_json::to_value(
            current
                .sessions
                .iter()
                .find(|session| session.id == b_session)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(b_identity).unwrap(),
        "B's admitted session is unchanged"
    );
    assert!(current
        .channel
        .rooms
        .iter()
        .any(|view| view.id == room && view.authorized && view.available && view.reading));
    assert!(!current
        .sessions
        .iter()
        .any(|session| session.id == c_session));
    assert!(!current
        .publications
        .iter()
        .any(|publication| publication.id == c_picture));
    let late = network.command(
        host,
        json!({"type":"host_output","roomId":room,"output":earlier}),
    );
    let reply = late
        .events
        .iter()
        .find_map(|(recipient, event)| match event {
            Event::RoomReply {
                request_id: Some(id),
                result,
                ..
            } if *recipient == b && id == "before-c-leaves" => Some(result),
            _ => None,
        })
        .expect("B receives its original request result");
    assert!(
        matches!(reply, RoomResult::Done),
        "unrelated C leaving does not revoke B's completed Browse request"
    );
    for connection in [host, b] {
        let state = network.state(connection);
        assert!(!state
            .publications
            .iter()
            .any(|publication| publication.id == c_picture));
        assert!(
            !state
                .pairs
                .iter()
                .any(|pair| pair.id == c_pair || pair.peer_id == c_session),
            "old projection must not revive C's pair"
        );
    }
}
