#![cfg(feature = "sqlite")]

mod support;
use piik_channel_core::{
    conversation::{ConversationCommand, ConversationResult},
    history::HistoryResult,
    wire::{Event, PairInfo, RoomAccess},
    AttachmentDescriptor,
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;

fn join(network: &mut RoomNetwork, connection: Uuid, credential: Option<&str>) -> (Uuid, String) {
    network
        .command(
            connection,
            json!({"type":"join", "name":"Participant", "credential":credential}),
        )
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
        .unwrap()
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
fn file_activity(
    network: &RoomNetwork,
    connection: Uuid,
    room: &str,
) -> std::collections::BTreeMap<Uuid, (bool, bool)> {
    network
        .state(connection)
        .channel
        .rooms
        .iter()
        .find(|value| value.id == room)
        .unwrap()
        .file_activity
        .iter()
        .map(|activity| (activity.session_id, (activity.sending, activity.receiving)))
        .collect()
}
fn offer_file(
    network: &mut RoomNetwork,
    connection: Uuid,
    room: &str,
    name: &str,
) -> (u64, AttachmentDescriptor) {
    let attachment = AttachmentDescriptor {
        id: Uuid::new_v4(),
        name: name.into(),
        size: name.len() as u64,
        media_type: "application/octet-stream".into(),
        sha256: piik_channel_core::attachment::sha256_hex(name.as_bytes()),
    };
    let chat = ConversationCommand::Chat {
        mentions: vec![],
        reply: None,
        inline_images: Default::default(),
        text: String::new(),
        nonce: name.into(),
        attachments: vec![attachment.clone()],
    };
    let Ok(ConversationResult::History(HistoryResult::Sent(sent))) =
        network.peer_request(connection, room, chat).result
    else {
        panic!("attachment message was not confirmed");
    };
    let seq = sent.message.message.seq;
    command(
        network,
        connection,
        json!({"type":"file_offer","roomId":room,"messageSeq":seq,"attachmentId":attachment.id,"sha256":attachment.sha256,"available":true}),
    );
    (seq, attachment)
}
fn pair(network: &RoomNetwork, connection: Uuid, peer: Uuid) -> PairInfo {
    network
        .state(connection)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == peer)
        .unwrap()
        .clone()
}
fn connect(network: &mut RoomNetwork, endpoints: [Uuid; 2], pair_id: Uuid) {
    for endpoint in endpoints {
        command(
            network,
            endpoint,
            json!({"type":"link_state","pairId":pair_id,"state":"connected"}),
        );
    }
}

fn physical_pair(network: &RoomNetwork, endpoint: Uuid, peer: Uuid) -> Option<Uuid> {
    network
        .state(endpoint)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == peer)
        .map(|pair| pair.id)
}

fn warm_pair(network: &mut RoomNetwork, source: Uuid, viewer: Uuid, source_session: Uuid) -> Uuid {
    let room = network.create(source, RoomAccess::Private, true);
    let invitation = network
        .command(source, json!({"type":"room_invite","roomId":room}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::RoomInvite { key, .. } => Some(key),
            _ => None,
        })
        .unwrap();
    command(
        network,
        viewer,
        json!({"type":"enter_room","roomId":room,"inviteKey":invitation}),
    );
    browse(network, viewer, &room, true);
    let publication = publish(network, source, &room, "screen");
    subscribe_screen(network, viewer, publication);
    let edge = pair(network, viewer, source_session).id;
    connect(network, [source, viewer], edge);
    command(
        network,
        source,
        json!({"type":"unpublish","publicationId":publication}),
    );
    assert_eq!(pair(network, viewer, source_session).id, edge);
    edge
}

fn browse(network: &mut RoomNetwork, connection: Uuid, room: &str, active: bool) {
    command(
        network,
        connection,
        json!({"type":"browse", "roomId":room, "active":active}),
    );
}
fn join_room_interests(network: &mut RoomNetwork, connection: Uuid, room: &str) {
    browse(network, connection, room, true);
    command(
        network,
        connection,
        json!({"type":"voice","roomId":room,"joined":true,"muted":true,"deafened":true}),
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
        json!({"type":"publish", "publication":{"id":id,"roomId":room,"kind":kind,"source":if kind == "screen" { Some(json!({"kind":"screen","name":null})) } else { None },"videoSettings":if kind == "screen" { Some(json!({"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"})) } else { None }}}),
    );
    id
}

fn topology(
    network: &mut RoomNetwork,
    connection: Uuid,
    room: &str,
    publication: Option<Uuid>,
) -> piik_channel_core::topology::RoomTopology {
    let before = serde_json::to_value(network.authority.export_backup()).unwrap();
    let effects = network.authority.handle(connection, piik_channel_core::wire::Request::parse(
        &json!({"type":"room_topology", "roomId":room, "publicationId":publication, "requestId":"topology"}).to_string()).unwrap(), 100);
    assert_eq!(
        effects.events.len(),
        1,
        "read neither broadcasts nor dispatches a storage turn"
    );
    assert_eq!(
        serde_json::to_value(network.authority.export_backup()).unwrap(),
        before
    );
    let (recipient, event) = effects.events.into_iter().next().unwrap();
    assert_eq!(recipient, connection);
    let Event::RoomReply {
        request_id,
        result: piik_channel_core::host::RoomResult::Topology { topology },
        ..
    } = event
    else {
        panic!("scoped topology reply");
    };
    assert_eq!(request_id.as_deref(), Some("topology"));
    topology
}

#[test]
fn picture_failure_is_projected_only_to_the_authorized_receiving_watch() {
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let observer = Uuid::new_v4();
    let (source, _) = join(&mut network, host, None);
    join(&mut network, viewer, None);
    join(&mut network, observer, None);
    let room = network.create(host, RoomAccess::Public, false);
    let screen = publish(&mut network, host, &room, "screen");
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":screen, "enabled":true}),
    );
    let edge = pair(&network, viewer, source).id;
    connect(&mut network, [host, viewer], edge);
    let receiving = network
        .state(viewer)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == source && !pair.incoming.is_empty())
        .unwrap()
        .clone();
    let flow = receiving.incoming[0].id;
    command(
        &mut network,
        host,
        json!({"type":"flow_state", "pairId":receiving.id, "flowId":flow, "state":"failed"}),
    );
    assert_eq!(
        serde_json::to_value(network.state(viewer)).unwrap()["failedSubscriptions"],
        json!([screen])
    );
    for unrelated in [host, observer] {
        assert_eq!(
            serde_json::to_value(network.state(unrelated)).unwrap()["failedSubscriptions"],
            json!([])
        );
    }
    assert!(network
        .state(viewer)
        .publications
        .iter()
        .any(|publication| publication.id == screen));
    let late = network.command(
        viewer,
        json!({"type":"flow_state", "pairId":receiving.id, "flowId":flow, "state":"decoded"}),
    );
    assert!(
        late.events.is_empty(),
        "retired reports never reach the room host"
    );
    assert_eq!(
        serde_json::to_value(network.state(viewer)).unwrap()["failedSubscriptions"],
        json!([screen])
    );
}

#[test]
fn assisted_viewing_projects_new_transit_and_keeps_the_local_transport_through_commit() {
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let native = Uuid::new_v4();
    let (source, _) = join(&mut network, host, None);
    let (viewing_session, credential) = join(&mut network, viewer, None);
    let (helper, _) = join(&mut network, native, Some(&credential));
    let room = network.create(host, RoomAccess::Public, false);
    let screen = publish(&mut network, host, &room, "screen");
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":screen, "enabled":true}),
    );
    let edge = pair(&network, viewer, source).id;
    connect(&mut network, [host, viewer], edge);
    let incumbent = network
        .state(viewer)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == source && !pair.incoming.is_empty())
        .unwrap()
        .clone();
    let old = incumbent.incoming[0].id;
    let unproved = topology(&mut network, viewer, &room, Some(screen));
    assert!(unproved
        .screen
        .unwrap()
        .edges
        .iter()
        .all(|edge| edge.selected && edge.proof.is_none() && edge.presented.is_none()));
    command(
        &mut network,
        viewer,
        json!({"type":"flow_state", "pairId":incumbent.id, "flowId":old, "state":"decoded"}),
    );
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":screen, "enabled":true, "helperSessionId":helper}),
    );
    assert!(network.state(native).subscriptions.is_empty());
    let mut confirmed = None;
    for _ in 0..2 {
        let (endpoint, edge) = [(host, source), (viewer, viewing_session)]
            .into_iter()
            .find_map(|(endpoint, peer)| {
                let edge = physical_pair(&network, native, peer)?;
                (Some(edge) != confirmed).then_some((endpoint, edge))
            })
            .expect("assisted viewing must propose both physical legs");
        assert!(screen_input(&network, native, source, screen).is_none());
        assert_eq!(
            screen_input(&network, viewer, source, screen).unwrap().1.id,
            old
        );
        connect(&mut network, [endpoint, native], edge);
        confirmed = Some(edge);
    }
    let upstream = network
        .state(native)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == source && !pair.incoming.is_empty())
        .unwrap()
        .clone();
    let local = network
        .state(viewer)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == helper)
        .unwrap()
        .clone();
    assert!(!upstream.incoming[0].selected);
    assert_eq!(
        local.incoming[0].input_flow_id,
        Some(upstream.incoming[0].id)
    );
    let mut helper_state = network.state(native).clone();
    let user = helper_state.sessions.iter().find(|s| s.id == helper).unwrap().user_id;
    let reports = piik_channel_core::forwarding::ForwardingBudget::default()
        .apply(Some(0), user, &mut helper_state);
    assert!(reports.is_empty(), "the local display must survive forwarding Off");
    assert!(helper_state.pairs.iter().any(|pair| pair.peer_id == viewing_session
        && pair.outgoing.iter().any(|flow| flow.id == local.incoming[0].id)));
    let preparing = topology(&mut network, viewer, &room, Some(screen));
    let edges = &preparing.screen.as_ref().unwrap().edges;
    assert!(edges.iter().any(
        |edge| edge.selected && edge.proof == Some(piik_channel_core::wire::FlowState::Decoded)
    ));
    assert_eq!(edges.iter().filter(|edge| !edge.selected).count(), 2);
    assert!(edges
        .iter()
        .filter(|edge| !edge.selected)
        .all(|edge| edge.proof.is_none() && edge.presented == Some(false)));
    assert!(edges
        .iter()
        .any(|edge| edge.sender == helper && edge.presentation));
    assert!(!edges
        .iter()
        .any(|edge| edge.sender == source && edge.presentation));
    let serialized = serde_json::to_string(&preparing).unwrap();
    for secret in [
        old,
        incumbent.id,
        upstream.incoming[0].id,
        upstream.id,
        local.id,
    ] {
        assert!(
            !serialized.contains(&secret.to_string()),
            "read projection exposes no flow or pair IDs"
        );
    }
    command(
        &mut network,
        native,
        json!({"type":"flow_state", "pairId":upstream.id, "flowId":upstream.incoming[0].id, "state":"forwardable"}),
    );
    command(
        &mut network,
        viewer,
        json!({"type":"flow_state", "pairId":local.id, "flowId":local.incoming[0].id, "state":"decoded"}),
    );
    assert!(network
        .state(viewer)
        .pairs
        .iter()
        .flat_map(|pair| &pair.incoming)
        .any(|flow| flow.id == old && flow.selected));
    let proved = topology(&mut network, viewer, &room, Some(screen));
    let edges = proved.screen.unwrap().edges;
    assert!(edges.iter().any(|edge| edge.receiver == helper
        && edge.proof == Some(piik_channel_core::wire::FlowState::Forwardable)
        && !edge.selected));
    assert!(edges.iter().any(|edge| edge.receiver == viewing_session
        && edge.proof == Some(piik_channel_core::wire::FlowState::Decoded)
        && edge.presented == Some(false)
        && !edge.selected));
    command(
        &mut network,
        viewer,
        json!({"type":"flow_state", "pairId":local.id, "flowId":local.incoming[0].id, "state":"switch_ready"}),
    );
    let selected = network
        .state(viewer)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == helper)
        .unwrap();
    assert_eq!(selected.id, local.id);
    assert_eq!(selected.incoming[0].id, local.incoming[0].id);
    assert!(selected.incoming[0].selected);
    assert!(!network
        .state(viewer)
        .pairs
        .iter()
        .flat_map(|pair| &pair.incoming)
        .any(|flow| flow.id == old));
    let committed = topology(&mut network, viewer, &room, Some(screen));
    assert!(committed
        .screen
        .unwrap()
        .edges
        .iter()
        .all(|edge| edge.selected && edge.presented.is_none()));
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":screen, "enabled":false}),
    );
    assert!(network
        .state(native)
        .pairs
        .iter()
        .all(|pair| pair.incoming.is_empty() && pair.outgoing.is_empty()));
}

#[test]
fn screen_pause_is_authoritative_and_retains_voice_and_transport() {
    use piik_channel_core::host::RoomResult;
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (source, _) = join(&mut network, host, None);
    let (receiver, _) = join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    join_room_interests(&mut network, viewer, &room);
    for connection in [host, viewer] {
        voice(&mut network, connection, &room, true);
    }
    let speech = publish(&mut network, host, &room, "voice");
    let transport = pair(&network, viewer, source);
    assert!(topology(&mut network, viewer, &room, None)
        .pairs
        .iter()
        .all(|edge| !edge.confirmed));
    for connection in [host, viewer] {
        command(
            &mut network,
            connection,
            json!({"type":"link_state", "pairId":transport.id, "state":"connected"}),
        );
    }
    let graph = topology(&mut network, viewer, &room, None);
    assert!(graph.screen.is_none());
    assert!(graph.session_ids.contains(&source));
    assert!(graph.pairs.iter().any(|pair| pair.confirmed
        && [pair.first, pair.second].contains(&source)
        && [pair.first, pair.second].contains(&receiver)));
    let screen = publish(&mut network, host, &room, "screen");
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":screen, "enabled":true}),
    );
    let before = pair(&network, viewer, source);
    let flow = before
        .incoming
        .iter()
        .find(|flow| flow.publication_id == screen)
        .unwrap()
        .id;
    for (connection, publication, code) in [
        (viewer, screen, "not_publication_owner"),
        (host, speech, "invalid_screen_publication"),
    ] {
        let rejected = network.command(
            connection,
            json!({"type":"set_paused", "publicationId":publication, "paused":true}),
        );
        assert!(
            rejected.events.iter().any(|(_, event)| matches!(event,
            Event::RoomReply { result: RoomResult::Error { code: actual }, .. } if actual == code))
        );
    }
    command(
        &mut network,
        host,
        json!({"type":"set_paused", "publicationId":screen, "paused":true}),
    );
    let state = network.state(viewer);
    assert!(
        state
            .publications
            .iter()
            .find(|p| p.id == screen)
            .unwrap()
            .paused
    );
    assert!(
        !state
            .publications
            .iter()
            .find(|p| p.id == speech)
            .unwrap()
            .paused
    );
    assert_eq!(state.voice.len(), 2);
    assert!(state.voice.iter().all(|v| !v.muted && !v.deafened));
    assert_eq!(pair(&network, viewer, source).id, before.id);
    assert!(
        network.authority.expire(30_000).events.is_empty(),
        "pause must not expire picture preparation"
    );
    assert_eq!(
        pair(&network, viewer, source)
            .incoming
            .iter()
            .map(|f| f.id)
            .collect::<Vec<_>>(),
        before.incoming.iter().map(|f| f.id).collect::<Vec<_>>()
    );

    network.command_at(
        host,
        json!({"type":"set_paused", "publicationId":screen, "paused":false}),
        30_001,
    );
    command(
        &mut network,
        viewer,
        json!({"type":"flow_state", "pairId":before.id, "flowId":flow, "state":"decoded"}),
    );
    assert_eq!(pair(&network, host, receiver).id, before.id);
    assert!(
        !network
            .state(viewer)
            .publications
            .iter()
            .find(|p| p.id == screen)
            .unwrap()
            .paused
    );

    command(
        &mut network,
        host,
        json!({"type":"set_paused", "publicationId":screen, "paused":true}),
    );
    network.command_at(
        viewer,
        json!({"type":"link_state", "pairId":before.id, "state":"failed"}),
        31_000,
    );
    assert!(network
        .state(viewer)
        .pairs
        .iter()
        .all(|pair| pair.id != before.id));
    let repair = network.authority.expire(36_000);
    network.deliver(repair);
    assert!(
        network
            .state(viewer)
            .publications
            .iter()
            .find(|p| p.id == screen)
            .unwrap()
            .paused
    );
}

#[test]
fn required_repair_wakes_the_existing_host_and_renews_only_retired_transport() {
    use piik_channel_core::host::HostAction;
    {
        let mut network = RoomNetwork::new();
        let host = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let (source, _) = join(&mut network, host, None);
        let (receiver, _) = join(&mut network, viewer, None);
        let room = network.create(host, RoomAccess::Public, false);
        join_room_interests(&mut network, viewer, &room);
        let publication = publish(&mut network, host, &room, "screen");
        command(
            &mut network,
            viewer,
            json!({"type":"subscribe", "publicationId":publication, "enabled":true}),
        );
        let old = pair(&network, viewer, source);
        connect(&mut network, [host, viewer], old.id);
        let old_flow = pair(&network, viewer, source).incoming[0].id;
        command(
            &mut network,
            viewer,
            json!({"type":"flow_state", "pairId":old.id, "flowId":old_flow, "state":"decoded"}),
        );
        network.command_at(
            viewer,
            json!({"type":"link_state","pairId":old.id,"state":"failed"}),
            200,
        );
        assert!(network
            .state(viewer)
            .pairs
            .iter()
            .all(|edge| edge.id != old.id));
        assert!(network.authority.expire(5_199).events.is_empty());
        let wake = network.authority.expire(5_200);
        assert!(wake.events.iter().any(|(_, event)| matches!(event, Event::HostInput { input, .. } if matches!(input.action, HostAction::RouteWake))));
        assert!(
            network.authority.expire(5_200).events.is_empty(),
            "only one wake may be outstanding"
        );
        network.deliver(wake);
        assert!(
            physical_pair(&network, viewer, source).is_some(),
            "active demand retries after cooldown on the existing signaling sockets"
        );
        let restored = pair(&network, viewer, source);
        assert_ne!(restored.id, old.id);
        assert!(restored.incoming.is_empty());
        assert!(network.state(viewer).subscriptions.contains(&publication));
        assert!(network
            .state(viewer)
            .sessions
            .iter()
            .any(|session| session.id == receiver));
        // A completion from the retired transport cannot retire the new attempt.
        {
            network.command_at(
                viewer,
                json!({"type":"link_state", "pairId":old.id, "state":"failed"}),
                5_201,
            );
            let late = network.command_at(
                viewer,
                json!({"type":"signal", "pairId":old.id, "payload":{
                    "exchangeId":Uuid::new_v4(),
                    "description":{"type":"offer", "sdp":"retired-transport"}
                }}),
                5_201,
            );
            assert!(
                late.events.is_empty(),
                "retired signaling must neither forward nor report a room error"
            );
            assert_eq!(pair(&network, viewer, source).id, restored.id);
        }
        for connection in [host, viewer] {
            network.command_at(
                connection,
                json!({"type":"link_state","pairId":restored.id,"state":"connected"}),
                5_202,
            );
        }
        let flow = pair(&network, viewer, source).incoming[0].id;
        assert_ne!(flow, old_flow);
        network.command_at(
            viewer,
            json!({"type":"flow_state", "pairId":restored.id, "flowId":flow, "state":"decoded"}),
            5_203,
        );
        assert!(network.authority.expire(30_000).events.is_empty());
        assert_eq!(pair(&network, viewer, source).id, restored.id);
    }
}

#[test]
fn room_participants_follow_personal_activity_and_clear_when_the_host_is_offline() {
    let mut network = RoomNetwork::new();
    let connections: Vec<_> = (0..5).map(|_| Uuid::new_v4()).collect();
    let sessions: Vec<_> = connections
        .iter()
        .map(|c| join(&mut network, *c, None).0)
        .collect();
    let room = network.create(connections[0], RoomAccess::Public, false);
    let participants = |network: &RoomNetwork| {
        network
            .state(connections[1])
            .channel
            .rooms
            .iter()
            .find(|r| r.id == room)
            .unwrap()
            .participant_session_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
    };
    assert!(
        participants(&network).is_empty(),
        "hosting alone is not personal activity"
    );
    browse(&mut network, connections[1], &room, true);
    command(
        &mut network,
        connections[2],
        json!({
            "type":"voice", "roomId":room, "joined":true, "muted":true, "deafened":true
        }),
    );
    let publication = publish(&mut network, connections[3], &room, "screen");
    command(
        &mut network,
        connections[4],
        json!({
            "type":"subscribe", "publicationId":publication, "enabled":true
        }),
    );
    assert_eq!(
        participants(&network),
        sessions[1..].iter().copied().collect()
    );
    browse(&mut network, connections[1], &room, false);
    voice(&mut network, connections[2], &room, false);
    assert_eq!(
        participants(&network),
        sessions[3..].iter().copied().collect()
    );
    command(
        &mut network,
        connections[3],
        json!({"type":"unpublish", "publicationId":publication}),
    );
    assert!(
        participants(&network).is_empty(),
        "retiring a publication also retires its watching activity"
    );

    // The room host has its own authenticated access, without needing a seat.
    let actor = network
        .state(connections[0])
        .sessions
        .iter()
        .find(|s| s.id == sessions[0])
        .unwrap()
        .user_id;
    assert!(network
        .peer_request(
            connections[0],
            &room,
            ConversationCommand::React {
                nonce: 1,
                reaction: "wave".into(),
                target: piik_channel_core::conversation::ReactionTarget::Person { user_id: actor },
            }
        )
        .result
        .is_ok());
    assert!(
        participants(&network).is_empty(),
        "interaction cooldown is not personal activity"
    );
    browse(&mut network, connections[1], &room, true);
    assert_eq!(
        participants(&network),
        std::collections::BTreeSet::from([sessions[1]])
    );
    let effects = network.authority.disconnect(connections[0], 200);
    network.deliver(effects);
    assert!(
        participants(&network).is_empty(),
        "an unavailable room has no live participant projection"
    );
    let effects = network
        .authority
        .expire(200 + piik_channel_core::RECOVERY_MS);
    network.deliver(effects);
    assert!(
        participants(&network).is_empty(),
        "retired host projection stays empty"
    );
}

#[test]
fn input_registration_is_private_and_follows_only_the_committed_picture() {
    use piik_channel_core::input::{self, InputFrame};
    use std::collections::BTreeMap;

    for commit in [false, true] {
        let mut network = RoomNetwork::new();
        // The room operator is not the publisher: it must never receive keys.
        let connections: Vec<_> = (0..4).map(|_| Uuid::new_v4()).collect();
        let sessions: Vec<_> = connections
            .iter()
            .map(|c| join(&mut network, *c, None).0)
            .collect();
        let room = network.create(connections[0], RoomAccess::Public, false);
        for index in 1..4 {
            join_room_interests(&mut network, connections[index], &room);
        }
        for (from, to) in [(2, 0), (0, 1), (1, 3)] {
            warm_pair(
                &mut network,
                connections[from],
                connections[to],
                sessions[from],
            );
        }
        let relay = 1;
        let source = 2;
        let publication = publish(&mut network, connections[source], &room, "screen");
        command(
            &mut network,
            connections[3],
            json!({"type":"subscribe","publicationId":publication,"enabled":true}),
        );
        let incoming = |network: &RoomNetwork, index: usize, selected: bool| {
            network
                .state(connections[index])
                .pairs
                .iter()
                .find_map(|pair| {
                    pair.incoming
                        .iter()
                        .find(|flow| {
                            flow.publication_id == publication && flow.selected == selected
                        })
                        .map(|flow| (pair.id, flow.id))
                })
                .unwrap()
        };
        let operator_flow = incoming(&network, 0, true).1;
        let denied = network.command(connections[0], json!({"type":"input_register","publicationId":publication,"flowId":operator_flow,"secret":vec![7u8;32]}));
        assert!(denied.events.iter().any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "unassigned_input_route")), "room administration without watching does not grant input");
        for index in [0, relay] {
            command(
                &mut network,
                connections[index],
                json!({"type":"subscribe","publicationId":publication,"enabled":true}),
            );
        }
        let leaf = incoming(&network, 3, true).1;
        let registered = network.command(connections[3], json!({"type":"input_register","publicationId":publication,"flowId":leaf,"secret":vec![7u8;32]}));
        let private: Vec<_> = registered
            .events
            .iter()
            .filter_map(|(connection, event)| {
                if let Event::InputState { registrations } = event {
                    Some((*connection, registrations))
                } else {
                    None
                }
            })
            .collect();
        assert!(private.len() == 1 && private[0].0 == connections[source]);
        assert!(
            private[0].1.len() == 1
                && private[0].1[0].secret == [7; 32]
                && private[0].1[0].flow_id == leaf
        );
        for connection in &connections {
            assert!(!serde_json::to_string(network.state(*connection))
                .unwrap()
                .contains("\"secret\""));
        }
        assert!(!serde_json::to_string(&network.authority.export_state())
            .unwrap()
            .contains("\"secret\""));

        // Exercise the actual projected multi-hop lineage in both directions.
        let mut frame = InputFrame {
            publication_id: publication,
            controller_session_id: sessions[3],
            route_id: leaf,
            flow_id: leaf,
            data: Some(json!({"opaque":"encrypted payload"})),
            closed: None,
            ready: None,
        };
        let mut bindings = BTreeMap::new();
        let (mut endpoint, mut from) = (sessions[3], None);
        loop {
            let index = sessions.iter().position(|s| *s == endpoint).unwrap();
            let routed = input::route(
                &mut frame,
                endpoint,
                network.state(connections[index]),
                from,
                None,
            )
            .unwrap();
            bindings.insert(endpoint, routed.binding);
            let Some(next) = routed.next_hop else {
                assert_eq!(endpoint, sessions[source]);
                break;
            };
            from = Some(endpoint);
            endpoint = next;
        }
        assert_eq!(
            bindings.len(),
            4,
            "the fixture must cover an internal relay, not only a direct pair"
        );
        from = None;
        loop {
            let index = sessions.iter().position(|s| *s == endpoint).unwrap();
            let routed = input::route(
                &mut frame,
                endpoint,
                network.state(connections[index]),
                from,
                bindings.get(&endpoint),
            )
            .unwrap();
            let Some(next) = routed.next_hop else {
                assert_eq!(endpoint, sessions[3]);
                break;
            };
            from = Some(endpoint);
            endpoint = next;
        }
        assert_eq!(frame.route_id, leaf);
        assert_eq!(frame.flow_id, leaf);
        assert_eq!(frame.data, Some(json!({"opaque":"encrypted payload"})));

        for index in [0, relay, 3] {
            let (pair, flow) = incoming(&network, index, true);
            command(
                &mut network,
                connections[index],
                json!({"type":"flow_state","pairId":pair,"flowId":flow,"state":"decoded"}),
            );
        }
        let warm_room = network.create(connections[source], RoomAccess::Public, false);
        let warm_screen = publish(&mut network, connections[source], &warm_room, "screen");
        subscribe_screen(&mut network, connections[relay], warm_screen);
        let warm_edge = physical_pair(&network, connections[relay], sessions[source])
            .expect("direct relay shortcut");
        connect(
            &mut network,
            [connections[source], connections[relay]],
            warm_edge,
        );
        let trial = incoming(&network, 3, false);
        let denied = network.command(connections[3], json!({"type":"input_register","publicationId":publication,"flowId":trial.1,"secret":vec![9u8;32]}));
        assert!(denied.events.iter().any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "unassigned_input_route")), "a prepared trial cannot replace the committed input secret");
        if commit {
            for index in [relay, 3] {
                let (pair, flow) = incoming(&network, index, false);
                let effects = network.command(
                    connections[index],
                    json!({"type":"flow_state","pairId":pair,"flowId":flow,"state":"switch_ready"}),
                );
                if index == 3 {
                    assert!(effects.events.iter().any(|(connection, event)| *connection == connections[source] && matches!(event, Event::InputState { registrations } if registrations.is_empty())));
                }
            }
            assert!(
                !bindings[&sessions[3]].current(sessions[3], network.state(connections[3])),
                "queued old input cannot use a newly committed path"
            );
            let stale = network.command(connections[3], json!({"type":"input_register","publicationId":publication,"flowId":leaf,"secret":vec![7u8;32]}));
            assert!(stale
                .events
                .iter()
                .any(|(_, event)| matches!(event, Event::Error { .. })));
            let fresh = incoming(&network, 3, true).1;
            let registered = network.command(connections[3], json!({"type":"input_register","publicationId":publication,"flowId":fresh,"secret":vec![9u8;32]}));
            assert!(registered.events.iter().any(|(connection, event)| *connection == connections[source] && matches!(event, Event::InputState { registrations } if registrations.len() == 1 && registrations[0].secret == [9;32] && registrations[0].flow_id == fresh)));
        } else {
            let effects = network.command(
                connections[3],
                json!({"type":"flow_state","pairId":trial.0,"flowId":trial.1,"state":"failed"}),
            );
            assert!(bindings[&sessions[3]].current(sessions[3], network.state(connections[3])));
            assert!(effects.events.iter().any(|(connection, event)| *connection == connections[source] && matches!(event, Event::InputState { registrations } if registrations.len() == 1 && registrations[0].flow_id == leaf)));
        }
        let stopped = network.command(
            connections[3],
            json!({"type":"subscribe","publicationId":publication,"enabled":false}),
        );
        assert!(stopped.events.iter().any(|(connection, event)| *connection == connections[source] && matches!(event, Event::InputState { registrations } if registrations.is_empty())));
    }
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
        join_room_interests(&mut network, connections[index], &room);
    }
    let relay = 1;
    let relay_session = sessions[relay];
    for (from, to) in [(0, 1), (0, 2), (1, 3)] {
        warm_pair(
            &mut network,
            connections[from],
            connections[to],
            sessions[from],
        );
    }
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
    let public_flow = network
        .state(connections[relay])
        .pairs
        .iter()
        .find(|pair| pair.id == shared_pair)
        .unwrap()
        .incoming
        .iter()
        .find(|flow| flow.publication_id == public)
        .unwrap()
        .id;
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
    let replacement = network
        .state(connections[3])
        .pairs
        .iter()
        .find(|p| p.peer_id == sessions[0])
        .unwrap()
        .id;
    connect(&mut network, [connections[0], connections[3]], replacement);
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
    command(
        &mut network,
        connections[0],
        json!({"type":"unpublish", "publicationId":private}),
    );
    assert!(
        network.state(connections[relay]).pairs.iter().any(|pair| {
            pair.id == shared_pair && pair.incoming.iter().any(|flow| flow.id == public_flow)
        }),
        "retiring one room's source preserves the other room's physical and media leases"
    );
    command(
        &mut network,
        connections[relay],
        json!({"type":"subscribe", "publicationId":public, "enabled":false}),
    );
    assert!(
        !network
            .state(connections[relay])
            .pairs
            .iter()
            .any(|pair| pair.id == shared_pair
                && (!pair.incoming.is_empty()
                    || !pair.outgoing.is_empty()
                    || !pair.rooms.is_empty())),
        "ending the public watch releases the final business lease"
    );
}

#[test]
fn current_host_session_and_stopping_reading_preserve_activity() {
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let other_page = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, credential) = join(&mut network, host, None);
    let (other_session, _) = join(&mut network, other_page, Some(&credential));
    let (viewer_session, _) = join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    join_room_interests(&mut network, viewer, &room);
    let pair_id = pair(&network, viewer, host_session).id;
    let delivery = network
        .state(viewer)
        .channel
        .rooms
        .iter()
        .find(|entry| entry.id == room)
        .unwrap()
        .delivery
        .as_ref()
        .unwrap();
    assert_eq!(delivery.host_session_id, host_session);
    assert_ne!(delivery.host_session_id, other_session);
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
        json!({"type":"link_state","pairId":pair_id,"state":"connected"}),
    );
    assert!(
        !pair(&network, host, viewer_session)
            .incoming
            .iter()
            .any(|flow| flow.publication_id == speaking),
        "one endpoint report is insufficient"
    );
    command(
        &mut network,
        host,
        json!({"type":"link_state","pairId":pair_id,"state":"connected"}),
    );
    assert!(
        pair(&network, host, viewer_session)
            .incoming
            .iter()
            .any(|flow| flow.publication_id == speaking),
        "both reports establish the voice path"
    );
    voice(&mut network, host, &room, false);
    let screen = publish(&mut network, viewer, &room, "screen");
    let manager = Uuid::new_v4();
    command(
        &mut network,
        manager,
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    let before = network.state(viewer).clone();
    command(
        &mut network,
        manager,
        json!({"type":"update_domain","name":"Friends domain","icon":"future_domain-v2"}),
    );
    command(
        &mut network,
        host,
        json!({"type":"update_room","roomId":room,"name":"Session room","icon":"future_room-v2","access":"public","hidden":false}),
    );
    let after = network.state(viewer);
    assert_eq!(after.channel.name, "Friends domain");
    assert_eq!(
        serde_json::to_value(&after.channel.icon).unwrap(),
        "future_domain-v2"
    );
    assert_eq!(
        after
            .channel
            .rooms
            .iter()
            .find(|entry| entry.id == room)
            .unwrap()
            .name,
        "Session room"
    );
    assert_eq!(
        serde_json::to_value(
            &after
                .channel
                .rooms
                .iter()
                .find(|entry| entry.id == room)
                .unwrap()
                .icon
        )
        .unwrap(),
        "future_room-v2"
    );
    assert_eq!(
        serde_json::to_value(&after.pairs).unwrap(),
        serde_json::to_value(&before.pairs).unwrap(),
        "metadata preserves transport and flow leases"
    );
    assert_eq!(
        serde_json::to_value(&after.publications).unwrap(),
        serde_json::to_value(&before.publications).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&after.voice).unwrap(),
        serde_json::to_value(&before.voice).unwrap()
    );
    let durable_policy = serde_json::to_value(network.policy(&room)).unwrap();
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
    assert_eq!(pair(&network, viewer, host_session).id, pair_id);
    voice(&mut network, viewer, &room, false);
    assert_eq!(
        pair(&network, viewer, host_session).id,
        pair_id,
        "the shared physical connection remains usable after leaving voice"
    );
    command(
        &mut network,
        viewer,
        json!({"type":"unpublish", "publicationId":screen}),
    );
    assert_eq!(
        serde_json::to_value(network.policy(&room)).unwrap(),
        durable_policy,
        "room activity stays out of durable policy"
    );
    assert!(
        !network
            .state(viewer)
            .pairs
            .iter()
            .any(|entry| entry.rooms.contains(&room)),
        "ending room activities releases their data grants"
    );
}

#[test]
fn voice_uses_only_mutually_confirmed_paths_and_non_listeners_can_forward_both_directions() {
    let mut network = RoomNetwork::new();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let d = Uuid::new_v4();
    let (bs, _) = join(&mut network, b, None);
    let (cs, _) = join(&mut network, c, None);
    let (ds, _) = join(&mut network, d, None);
    let room = network.create(b, RoomAccess::Public, false);
    browse(&mut network, c, &room, true);
    let relay_picture = publish(&mut network, c, &room, "screen");
    join_room_interests(&mut network, d, &room);
    voice(&mut network, b, &room, true);
    voice(&mut network, d, &room, true);
    subscribe_screen(&mut network, b, relay_picture);
    let from_b = publish(&mut network, b, &room, "voice");
    let from_d = publish(&mut network, d, &room, "voice");
    let bc = pair(&network, b, cs);
    command(
        &mut network,
        c,
        json!({"type":"link_state", "pairId":bc.id, "state":"connected"}),
    );
    assert!(
        network.state(c).pairs.iter().all(|p| !p
            .incoming
            .iter()
            .any(|flow| flow.publication_id == from_b)
            && !p.incoming.iter().any(|flow| flow.publication_id == from_d)),
        "one endpoint's open report cannot make a usable connection"
    );
    command(
        &mut network,
        b,
        json!({"type":"link_state", "pairId":bc.id, "state":"connected"}),
    );
    command(
        &mut network,
        b,
        json!({"type":"subscribe","publicationId":relay_picture,"enabled":false}),
    );
    let bd = pair(&network, b, ds);
    command(
        &mut network,
        d,
        json!({"type":"link_state", "pairId":bd.id, "state":"failed"}),
    );
    let cd = physical_pair(&network, c, ds).unwrap();
    command(
        &mut network,
        d,
        json!({"type":"link_state", "pairId":cd, "state":"connected"}),
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
        json!({"type":"link_state", "pairId":cd, "state":"connected"}),
    );
    fn flow_pair(net: &RoomNetwork, socket: Uuid, peer: Uuid) -> PairInfo {
        net.state(socket)
            .pairs
            .iter()
            .find(|edge| edge.peer_id == peer)
            .unwrap()
            .clone()
    }

    let cb = flow_pair(&network, c, bs);
    let cd = flow_pair(&network, c, ds);
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
    let before_mute = serde_json::to_value(&network.state(d).publications).unwrap();
    let before_flows = serde_json::to_value(&network.state(d).pairs).unwrap();
    command(
        &mut network,
        d,
        json!({"type":"voice","roomId":room,"joined":true,"muted":true,"deafened":true}),
    );
    command(
        &mut network,
        d,
        json!({"type":"publish","publication":{"id":from_d,"roomId":room,"kind":"voice"}}),
    );
    assert!(
        network
            .state(d)
            .voice
            .iter()
            .find(|voice| voice.session_id == ds)
            .unwrap()
            .muted
    );
    assert_eq!(
        serde_json::to_value(&network.state(d).publications).unwrap(),
        before_mute
    );
    assert_eq!(
        serde_json::to_value(&network.state(d).pairs).unwrap(),
        before_flows
    );
    assert!(network.state(d).subscriptions.contains(&from_b));
    assert!(network.state(b).subscriptions.contains(&from_d));
    assert_eq!(flow_pair(&network, c, ds).id, cd.id);
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
    subscribe_screen(&mut network, b, relay_picture);
    let (screen_pair, screen_flow) = screen_input(&network, b, cs, relay_picture).unwrap();
    assert_eq!(screen_pair, cb.id);
    let live_cd = flow_pair(&network, d, cs);
    assert!(live_cd
        .incoming
        .iter()
        .any(|flow| flow.publication_id == from_b));
    command(
        &mut network,
        d,
        json!({"type":"link_state","pairId":live_cd.id,"state":"failed"}),
    );
    let (retained_pair, retained_flow) = screen_input(&network, b, cs, relay_picture).unwrap();
    assert_eq!(
        (retained_pair, retained_flow.id),
        (screen_pair, screen_flow.id)
    );
    command(
        &mut network,
        c,
        json!({"type":"unpublish","publicationId":relay_picture}),
    );
    browse(&mut network, c, &room, false);
    assert!(
        !network
            .state(c)
            .channel
            .rooms
            .iter()
            .find(|r| r.id == room)
            .unwrap()
            .participant_session_ids
            .contains(&cs),
        "media transit does not create a seat"
    );
    assert!(network.state(c).pairs.iter().all(|pair| pair
        .incoming
        .iter()
        .chain(&pair.outgoing)
        .all(|flow| flow.publication_id != from_b && flow.publication_id != from_d)));
    browse(&mut network, c, &room, true);
    let screen = publish(&mut network, c, &room, "screen");
    command(
        &mut network,
        b,
        json!({"type":"subscribe", "publicationId":screen, "enabled":true}),
    );
    let physical = network
        .state(b)
        .pairs
        .iter()
        .find(|edge| edge.peer_id == cs)
        .unwrap()
        .id;
    connect(&mut network, [b, c], physical);
    let independent = network
        .state(b)
        .pairs
        .iter()
        .find(|p| p.incoming.iter().any(|flow| flow.publication_id == screen))
        .unwrap()
        .id;
    assert_eq!(flow_pair(&network, c, bs).id, independent);
    voice(&mut network, b, &room, false);
    voice(&mut network, d, &room, false);
    assert_eq!(
        flow_pair(&network, c, bs).id,
        independent,
        "screen and remaining room demand retain the shared pair"
    );
    command(
        &mut network,
        b,
        json!({"type":"subscribe", "publicationId":screen, "enabled":false}),
    );
    assert_eq!(
        flow_pair(&network, c, bs).id,
        independent,
        "removing the media lease keeps the confirmed pool connection"
    );
    let user = network
        .state(c)
        .sessions
        .iter()
        .find(|s| s.id == cs)
        .unwrap()
        .user_id;
    command(
        &mut network,
        c,
        json!({"type":"unpublish","publicationId":screen}),
    );
    assert!(network.state(c).sessions.iter().any(|s| s.id == cs));
    assert!(network.state(c).users.iter().any(|u| u.id == user));
    assert!(!network.state(b).publications.iter().any(|p| p.id == screen));
}

#[test]
fn failed_room_data_channel_repairs_file_without_closing_a_shared_screen_pair() {
    let mut network = RoomNetwork::new();
    let [source, relay, viewer] = [(); 3].map(|_| Uuid::new_v4());
    let [source_id, relay_id, viewer_id] =
        [source, relay, viewer].map(|socket| join(&mut network, socket, None).0);
    let room = network.create(source, RoomAccess::Public, false);
    browse(&mut network, relay, &room, true);
    for (from, to, id) in [
        (source, viewer, source_id),
        (source, relay, source_id),
        (relay, viewer, relay_id),
    ] {
        warm_pair(&mut network, from, to, id);
    }
    let screen = publish(&mut network, source, &room, "screen");
    subscribe_screen(&mut network, viewer, screen);
    let active = screen_input(&network, viewer, source_id, screen).unwrap();
    command(
        &mut network,
        viewer,
        json!({"type":"flow_state","pairId":active.0,"flowId":active.1.id,"state":"decoded"}),
    );
    let (seq, file) = offer_file(&mut network, source, &room, "data.bin");
    command(
        &mut network,
        viewer,
        json!({"type":"file_receive","roomId":room,"messageSeq":seq,"attachmentId":file.id,"enabled":true}),
    );
    assert_eq!(network.state(viewer).files[0].upstream, Some(source_id));
    assert!(pair(&network, viewer, source_id).rooms.contains(&room));
    for endpoint in [source, viewer] {
        command(
            &mut network,
            endpoint,
            json!({"type":"room_data_state","roomId":room,"pairId":active.0,"ready":true}),
        );
    }
    command(
        &mut network,
        viewer,
        json!({"type":"room_data_state","roomId":room,"pairId":active.0,"ready":false}),
    );
    assert_eq!(
        screen_input(&network, viewer, source_id, screen),
        Some(active)
    );
    assert!(pair(&network, viewer, source_id).rooms.is_empty());
    assert_eq!(network.state(viewer).files[0].upstream, Some(relay_id));
    assert!(network.state(relay).files[0]
        .downstream
        .contains(&viewer_id));
    for ready in [true, false] {
        let ignored = network.command(
            viewer,
            json!({"type":"room_data_state","roomId":room,"pairId":active.0,"ready":ready}),
        );
        assert!(!ignored
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::HostInput { .. })));
    }
    assert_eq!(network.state(viewer).files[0].upstream, Some(relay_id));
}

#[test]
fn file_copy_selection_uses_the_last_link_confirmation_without_an_extra_sync() {
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let source = Uuid::new_v4();
    let copy = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    join(&mut network, host, None);
    let (source_session, _) = join(&mut network, source, None);
    let (copy_session, _) = join(&mut network, copy, None);
    let (viewer_session, _) = join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    command(
        &mut network,
        host,
        json!({"type":"update_room","roomId":room,"name":"Friends","icon":"couch","access":"public","hidden":false,"relayCapacity":1}),
    );
    for endpoint in [source, viewer] {
        browse(&mut network, endpoint, &room, true);
        command(
            &mut network,
            endpoint,
            json!({"type":"relay_capacity","roomId":room,"capacity":0}),
        );
    }
    let attachment = json!({"id":Uuid::new_v4(),"name":"committed-copy.bin","size":3,"mediaType":"application/octet-stream",
        "sha256":piik_channel_core::attachment::sha256_hex(b"abc")});
    assert!(network
        .peer_request(
            source,
            &room,
            ConversationCommand::Chat {
                mentions: vec![],
                reply: None,
                inline_images: Default::default(),
                text: String::new(),
                nonce: "committed-copy".into(),
                attachments: vec![serde_json::from_value(attachment.clone()).unwrap()],
            }
        )
        .result
        .is_ok());
    command(
        &mut network,
        source,
        json!({"type":"file_offer","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"sha256":attachment["sha256"],"available":true}),
    );
    command(
        &mut network,
        viewer,
        json!({"type":"file_receive","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"enabled":true}),
    );
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(source_session)
    );
    assert_eq!(network.state(viewer).files[0].upstream, None);
    command(
        &mut network,
        copy,
        json!({"type":"file_offer","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"sha256":attachment["sha256"],"available":true}),
    );
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(source_session),
        "a complete copy without a committed path is not a usable replacement"
    );
    if let Some(original) = physical_pair(&network, viewer, source_session) {
        command(
            &mut network,
            viewer,
            json!({"type":"link_state","pairId":original,"state":"failed"}),
        );
    }
    browse(&mut network, copy, &room, true);
    let warm_room = network.create(copy, RoomAccess::Private, true);
    let invitation = network
        .command(copy, json!({"type":"room_invite","roomId":warm_room}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::RoomInvite { key, .. } => Some(key),
            _ => None,
        })
        .unwrap();
    command(
        &mut network,
        viewer,
        json!({"type":"enter_room","roomId":warm_room,"inviteKey":invitation}),
    );
    let screen = publish(&mut network, copy, &warm_room, "screen");
    subscribe_screen(&mut network, viewer, screen);
    let edge = pair(&network, viewer, copy_session).id;
    let acknowledgements = [(copy, edge), (viewer, edge)];
    for (index, (endpoint, pair_id)) in acknowledgements.into_iter().enumerate() {
        assert_eq!(
            network.state(viewer).files[0].source_id,
            Some(source_session),
            "uncommitted candidates must not select the offered copy"
        );
        command(
            &mut network,
            endpoint,
            json!({"type":"link_state","pairId":pair_id,"state":"connected"}),
        );
        if index == 0 {
            assert_eq!(
                network.state(viewer).files[0].source_id,
                Some(source_session)
            );
        }
    }
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(copy_session),
        "the last ACK's own projection must expose the now-ready offered copy"
    );
    assert_eq!(network.state(viewer).files[0].upstream, Some(copy_session));
    assert!(network.state(copy).files[0]
        .downstream
        .contains(&viewer_session));
    assert_eq!(
        file_activity(&network, host, &room),
        [
            (copy_session, (true, false)),
            (viewer_session, (false, true))
        ]
        .into()
    );
}

#[test]
fn file_delivery_uses_a_ready_copy_when_its_online_source_loses_every_receiver_path() {
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let source = Uuid::new_v4();
    let copy = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, _) = join(&mut network, host, None);
    let (source_session, _) = join(&mut network, source, None);
    let (copy_session, _) = join(&mut network, copy, None);
    let (viewer_session, _) = join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    for socket in [source, copy, viewer] {
        browse(&mut network, socket, &room, true);
    }
    for (from, to, id) in [
        (source, host, source_session),
        (host, copy, host_session),
        (copy, viewer, copy_session),
    ] {
        warm_pair(&mut network, from, to, id);
    }
    let branch = pair(&network, viewer, copy_session);
    let attachment = json!({"id":Uuid::new_v4(),"name":"reachable-copy.bin","size":3,"mediaType":"application/octet-stream",
        "sha256":piik_channel_core::attachment::sha256_hex(b"abc")});
    let confirmation = network.peer_request(
        source,
        &room,
        ConversationCommand::Chat {
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
            text: String::new(),
            nonce: "reachable-copy".into(),
            attachments: vec![serde_json::from_value(attachment.clone()).unwrap()],
        },
    );
    assert!(confirmation.result.is_ok());
    command(
        &mut network,
        source,
        json!({"type":"file_offer","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"sha256":attachment["sha256"],"available":true}),
    );
    for endpoint in [host, viewer] {
        command(
            &mut network,
            endpoint,
            json!({"type":"file_receive","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"enabled":true}),
        );
    }
    command(
        &mut network,
        copy,
        json!({"type":"file_offer","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"sha256":attachment["sha256"],"available":true}),
    );
    assert_eq!(
        network.state(host).files[0].source_id,
        Some(source_session),
        "a new readable copy must not displace an active healthy source"
    );
    assert_eq!(network.state(host).files[0].upstream, Some(source_session));
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(source_session)
    );
    assert_eq!(network.state(viewer).files[0].upstream, Some(copy_session));
    command(
        &mut network,
        host,
        json!({"type":"file_receive","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"enabled":false}),
    );
    let source_pair = pair(&network, source, host_session);
    command(
        &mut network,
        source,
        json!({"type":"link_state","pairId":source_pair.id,"state":"failed"}),
    );
    assert!(
        network
            .state(viewer)
            .sessions
            .iter()
            .any(|session| session.id == source_session && session.online),
        "RTC path loss is not holder signaling retirement"
    );
    assert_eq!(
        pair(&network, copy, viewer_session).id,
        branch.id,
        "the existing ready copy-to-receiver branch is retained"
    );
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(copy_session),
        "an online but unreachable source must yield to its ready authorized complete copy"
    );
    assert_eq!(network.state(viewer).files[0].upstream, Some(copy_session));
    assert!(network.state(copy).files[0]
        .downstream
        .contains(&viewer_session));
}

#[test]
fn idle_file_copies_hold_no_room_data_grant_and_signaling_recovery_preserves_active_delivery() {
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let source = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, _) = join(&mut network, host, None);
    let (source_session, credential) = join(&mut network, source, None);
    let (viewer_session, _) = join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    let (seq, attachment) = offer_file(&mut network, source, &room, "retained.bin");
    assert!(
        network
            .state(source)
            .pairs
            .iter()
            .all(|pair| pair.rooms.is_empty()),
        "an idle readable copy adds no data grant"
    );
    assert!(
        network.state(source).files.is_empty(),
        "idle copies are not active delivery plans"
    );
    assert!(file_activity(&network, host, &room).is_empty());
    for socket in [source, viewer] {
        warm_pair(&mut network, host, socket, host_session);
        browse(&mut network, socket, &room, true);
    }
    command(
        &mut network,
        viewer,
        json!({"type":"file_receive", "roomId":room, "messageSeq":seq, "attachmentId":attachment.id, "enabled":true}),
    );
    let active = network.state(viewer).files[0].clone();
    assert_eq!(active.source_id, Some(source_session));
    assert_eq!(active.upstream, Some(host_session));
    let host_plan = &network.state(host).files[0];
    assert_eq!(host_plan.upstream, Some(source_session));
    assert_eq!(host_plan.downstream, [viewer_session]);
    assert!(!host_plan.receiving);
    let active_people = [
        (source_session, (true, false)),
        (viewer_session, (false, true)),
    ]
    .into();
    assert_eq!(
        file_activity(&network, host, &room),
        active_people,
        "only the selected source and requesting viewer participate in the file transfer"
    );
    let (reply_seq, reply) = offer_file(&mut network, viewer, &room, "return.bin");
    command(
        &mut network,
        source,
        json!({"type":"file_receive", "roomId":room, "messageSeq":reply_seq, "attachmentId":reply.id, "enabled":true}),
    );
    assert_eq!(
        file_activity(&network, host, &room),
        [
            (source_session, (true, true)),
            (viewer_session, (true, true))
        ]
        .into(),
        "each requester can receive one attachment while serving the other"
    );
    command(
        &mut network,
        source,
        json!({"type":"file_offer", "roomId":room, "messageSeq":reply_seq, "attachmentId":reply.id, "sha256":reply.sha256, "available":true}),
    );
    command(
        &mut network,
        source,
        json!({"type":"file_receive", "roomId":room, "messageSeq":reply_seq, "attachmentId":reply.id, "enabled":false}),
    );
    assert_eq!(
        file_activity(&network, host, &room),
        active_people,
        "retaining the completed copy ends only that transfer's activity"
    );
    let lease = pair(&network, viewer, host_session).id;
    browse(&mut network, source, &room, false);
    browse(&mut network, viewer, &room, false);
    assert!(
        network
            .state(viewer)
            .channel
            .rooms
            .iter()
            .find(|r| r.id == room)
            .unwrap()
            .participant_session_ids
            .is_empty(),
        "active file delivery does not create seats"
    );
    assert_eq!(pair(&network, viewer, host_session).id, lease);
    let effects = network.authority.disconnect(source, 100);
    network.deliver(effects);
    assert_eq!(
        network.state(viewer).files[0].source_id,
        Some(source_session)
    );
    assert_eq!(network.state(viewer).files[0].upstream, active.upstream);
    assert_eq!(
        file_activity(&network, viewer, &room),
        active_people,
        "signaling loss alone does not cancel an established file operation"
    );
    assert_eq!(pair(&network, viewer, host_session).id, lease);
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
    assert_eq!(
        file_activity(&network, viewer, &room),
        [(viewer_session, (false, true))].into(),
        "a waiting receiver remains active after the serving session retires"
    );
    command(
        &mut network,
        viewer,
        json!({"type":"file_receive", "roomId":room, "messageSeq":seq, "attachmentId":attachment.id, "enabled":false}),
    );
    assert!(network.state(viewer).files.is_empty());
    assert!(network
        .state(viewer)
        .pairs
        .iter()
        .all(|pair| pair.rooms.is_empty()));
    assert!(file_activity(&network, viewer, &room).is_empty());
}

#[test]
fn file_activity_follows_room_grants_and_disappears_with_its_host() {
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    let (host_session, _) = join(&mut network, host, None);
    let (viewer_session, _) = join(&mut network, viewer, None);
    join(&mut network, outsider, None);
    let room = network.create(host, RoomAccess::Private, false);
    command(
        &mut network,
        host,
        json!({"type":"update_room","roomId":room,"name":"Private","icon":"couch","access":"private","hidden":false,"password":"secret"}),
    );
    let (seq, attachment) = offer_file(&mut network, host, &room, "private.bin");
    assert!(file_activity(&network, host, &room).is_empty());
    let receive = json!({"type":"file_receive","roomId":room,"messageSeq":seq,"attachmentId":attachment.id,"enabled":true});
    let denied = network.command(viewer, receive.clone());
    assert!(denied.events.iter().any(|(_, event)| matches!(event,
        Event::RoomReply { result: piik_channel_core::host::RoomResult::Error { code }, .. } if code == "room_access_required")));
    assert!(file_activity(&network, host, &room).is_empty());

    command(
        &mut network,
        viewer,
        json!({"type":"enter_room","roomId":room,"password":"secret"}),
    );
    command(&mut network, viewer, receive.clone());
    let active_people = [
        (host_session, (true, false)),
        (viewer_session, (false, true)),
    ]
    .into();
    assert_eq!(file_activity(&network, host, &room), active_people);
    assert_eq!(file_activity(&network, viewer, &room), active_people);
    assert!(
        file_activity(&network, outsider, &room).is_empty(),
        "visible room metadata does not disclose private activity"
    );
    let wire = serde_json::to_value(network.state(viewer)).unwrap();
    let expected: Vec<_> = active_people
        .iter()
        .map(|(id, (sending, receiving))| json!({"sessionId":id, "sending":sending, "receiving":receiving}))
        .collect();
    assert_eq!(
        wire["channel"]["rooms"][0]["fileActivity"],
        json!(expected),
        "the room exposes just the session and its file roles"
    );

    let user = network
        .state(host)
        .sessions
        .iter()
        .find(|value| value.id == viewer_session)
        .unwrap()
        .user_id;
    command(
        &mut network,
        host,
        json!({"type":"revoke_room_access","roomId":room,"userId":user}),
    );
    assert!(file_activity(&network, viewer, &room).is_empty());
    assert!(
        file_activity(&network, host, &room).is_empty(),
        "revocation removes the receiver and its source demand"
    );
    command(
        &mut network,
        viewer,
        json!({"type":"enter_room","roomId":room,"password":"secret"}),
    );
    command(&mut network, viewer, receive);
    assert_eq!(file_activity(&network, viewer, &room), active_people);
    let effects = network.authority.disconnect(host, 200);
    network.deliver(effects);
    let unavailable = network
        .state(viewer)
        .channel
        .rooms
        .iter()
        .find(|value| value.id == room)
        .unwrap();
    assert!(!unavailable.available);
    assert!(
        unavailable.file_activity.is_empty(),
        "unavailable authority never projects a stale live activity"
    );
}

#[test]
fn retired_picture_report_cannot_fail_recreated_flow_on_shared_pair() {
    let mut network = RoomNetwork::new();
    let source = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (source_session, _) = join(&mut network, source, None);
    join(&mut network, viewer, None);
    let room = network.create(source, RoomAccess::Public, false);
    join_room_interests(&mut network, viewer, &room);
    let lease = pair(&network, viewer, source_session);
    for endpoint in [source, viewer] {
        command(
            &mut network,
            endpoint,
            json!({"type":"link_state","pairId":lease.id,"state":"connected"}),
        );
    }
    let picture = publish(&mut network, source, &room, "screen");
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":picture, "enabled":true}),
    );
    let old_flow = pair(&network, viewer, source_session)
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .unwrap()
        .id;
    voice(&mut network, source, &room, true);
    voice(&mut network, viewer, &room, true);
    let microphone = publish(&mut network, source, &room, "voice");
    let voice_flow = pair(&network, viewer, source_session)
        .incoming
        .iter()
        .find(|flow| flow.publication_id == microphone)
        .unwrap()
        .id;
    assert!(pair(&network, viewer, source_session)
        .incoming
        .iter()
        .any(|flow| flow.publication_id == picture));
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":picture, "enabled":false}),
    );
    let retired = pair(&network, viewer, source_session);
    assert_eq!(retired.id, lease.id);
    assert!(!retired
        .incoming
        .iter()
        .any(|flow| flow.publication_id == picture));
    assert!(retired.rooms.is_empty());
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":picture, "enabled":true}),
    );
    assert!(pair(&network, viewer, source_session)
        .incoming
        .iter()
        .any(|flow| flow.publication_id == picture));

    // This callback belongs to the retired media reader, while its physical
    // pair and publication now serve a newly requested picture flow.
    let recreated = pair(&network, viewer, source_session)
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
    let current = pair(&network, viewer, source_session);
    assert_eq!(current.id, lease.id);
    assert!(current.rooms.is_empty());
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
fn offline_room_host_consumes_pair_failure_before_resuming_a_prepared_branch() {
    use piik_channel_core::wire::Request;
    let mut network = RoomNetwork::new();
    let connections: Vec<_> = (0..4).map(|_| Uuid::new_v4()).collect();
    let admitted: Vec<_> = connections
        .iter()
        .map(|c| join(&mut network, *c, None))
        .collect();
    let sessions: Vec<_> = admitted.iter().map(|(s, _)| *s).collect();
    let room = network.create(connections[0], RoomAccess::Public, false);
    for connection in &connections {
        join_room_interests(&mut network, *connection, &room);
    }
    for (from, to) in [(2, 0), (0, 1), (1, 3)] {
        warm_pair(
            &mut network,
            connections[from],
            connections[to],
            sessions[from],
        );
    }
    let relay = 1;
    let source = 2;
    let picture = publish(&mut network, connections[source], &room, "screen");
    for index in [0, relay, 3] {
        command(
            &mut network,
            connections[index],
            json!({"type":"subscribe","publicationId":picture,"enabled":true}),
        );
    }
    let selected: Vec<_> = connections
        .iter()
        .flat_map(|c| {
            network
                .state(*c)
                .pairs
                .iter()
                .flat_map(|p| {
                    p.incoming
                        .iter()
                        .filter(|f| f.publication_id == picture && f.selected)
                        .map(|f| (*c, p.id, f.id))
                })
                .collect::<Vec<_>>()
        })
        .collect();
    for (endpoint, pair, flow) in &selected {
        command(
            &mut network,
            *endpoint,
            json!({"type":"flow_state","pairId":pair,"flowId":flow,"state":"decoded"}),
        );
    }
    // The second room has independent delivery on a shared pair.
    let other_room = network.create(connections[source], RoomAccess::Public, false);
    warm_pair(
        &mut network,
        connections[source],
        connections[relay],
        sessions[source],
    );
    command(
        &mut network,
        connections[0],
        json!({"type":"relay_capacity","roomId":other_room,"capacity":0}),
    );
    let other_picture = publish(&mut network, connections[source], &other_room, "screen");
    command(
        &mut network,
        connections[0],
        json!({"type":"subscribe","publicationId":other_picture,"enabled":true}),
    );
    let sibling_pair = pair(&network, connections[0], sessions[source]);
    let sibling_flow = sibling_pair
        .incoming
        .iter()
        .find(|f| f.publication_id == other_picture)
        .unwrap()
        .id;
    command(
        &mut network,
        connections[0],
        json!({"type":"flow_state","pairId":sibling_pair.id,"flowId":sibling_flow,"state":"decoded"}),
    );

    let candidate = |network: &RoomNetwork, index| {
        network
            .state(connections[index])
            .pairs
            .iter()
            .find_map(|p| {
                p.incoming
                    .iter()
                    .find(|f| f.publication_id == picture && !f.selected)
                    .map(|f| (p.id, f.id))
            })
            .unwrap()
    };
    let relay_shadow = candidate(&network, relay);
    let leaf_shadow = candidate(&network, 3);
    command(
        &mut network,
        connections[relay],
        json!({"type":"flow_state","pairId":relay_shadow.0,"flowId":relay_shadow.1,"state":"switch_ready"}),
    );
    let before = topology(&mut network, connections[0], &room, Some(picture));
    let room_summary = serde_json::to_value(
        network
            .state(connections[0])
            .channel
            .rooms
            .iter()
            .find(|r| r.id == room)
            .unwrap(),
    )
    .unwrap();

    assert_eq!(
        pair(&network, connections[relay], sessions[source]).id,
        relay_shadow.0
    );
    let offline = network.authority.disconnect(connections[0], 100);
    network.deliver(offline);
    let other_topology = topology(&mut network, connections[source], &other_room, None);
    assert!(other_topology.session_ids.contains(&sessions[0]));
    let sibling_endpoints = (
        sessions[0].min(sessions[source]),
        sessions[0].max(sessions[source]),
    );
    assert!(other_topology
        .pairs
        .iter()
        .any(|pair| pair.confirmed && (pair.first, pair.second) == sibling_endpoints));
    command(
        &mut network,
        connections[relay],
        json!({"type":"link_state","pairId":relay_shadow.0,"state":"failed"}),
    );
    assert!(!network
        .state(connections[relay])
        .pairs
        .iter()
        .any(|p| p.id == relay_shadow.0));

    let resumed = Uuid::new_v4();
    network.command_at(resumed, json!({"type":"join","name":"Returning host","credential":admitted[0].1,"sessionId":sessions[0]}), 100);
    network.host_connection(&room, resumed);
    let effects = network.authority.handle(
        resumed,
        Request::parse(
            &json!({"type":"host_register","room":room_summary,"resumeBinding":before.binding_id})
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
    assert_eq!(input.failed_pairs.len(), 1);
    assert_eq!(
        (input.failed_pairs[0].first, input.failed_pairs[0].second),
        (
            sessions[relay].min(sessions[source]),
            sessions[relay].max(sessions[source])
        )
    );
    let output = network.host_turn(&room, input);
    assert!(output
        .projection
        .flows
        .iter()
        .all(|f| f.id != relay_shadow.1 && f.id != leaf_shadow.1));
    // Until that output is acknowledged, another ordinary input covers the
    // same failure fact; it must not depend on HostRegister being the caller.
    let repeated = network.authority.handle(
        connections[relay],
        Request::parse(&json!({"type":"browse","roomId":room,"active":true}).to_string()).unwrap(),
        100,
    );
    let repeated_input = repeated
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    assert_eq!(repeated_input.failed_pairs.len(), 1);
    let repeated_output = network.host_turn(&room, repeated_input);
    command(
        &mut network,
        resumed,
        json!({"type":"host_output","roomId":room,"output":repeated_output}),
    );
    command(
        &mut network,
        resumed,
        json!({"type":"host_output","roomId":room,"output":output}),
    );
    let after = topology(&mut network, resumed, &room, Some(picture));
    assert_eq!(after.binding_id, before.binding_id);
    for (endpoint, pair, flow) in &selected {
        let endpoint = if *endpoint == connections[0] {
            resumed
        } else {
            *endpoint
        };
        assert!(network
            .state(endpoint)
            .pairs
            .iter()
            .any(|p| p.id == *pair && p.incoming.iter().any(|f| f.id == *flow && f.selected)));
    }
    let late = network.command(connections[3], json!({"type":"flow_state","pairId":leaf_shadow.0,"flowId":leaf_shadow.1,"state":"switch_ready"}));
    assert!(
        late.events.is_empty(),
        "retired downstream proof cannot commit a broken candidate"
    );
    assert!(network
        .state(resumed)
        .pairs
        .iter()
        .any(|p| p.id == sibling_pair.id && p.incoming.iter().any(|f| f.id == sibling_flow)));

    let current = topology(&mut network, resumed, &room, Some(picture));
    assert!(current
        .screen
        .unwrap()
        .edges
        .iter()
        .filter(|e| e.selected)
        .all(|edge| before
            .screen
            .as_ref()
            .unwrap()
            .edges
            .iter()
            .any(|old| old.selected
                && old.sender == edge.sender
                && old.receiver == edge.receiver)));

    command(
        &mut network,
        connections[source],
        json!({"type":"link_state","pairId":sibling_pair.id,"state":"failed"}),
    );
    let retired = topology(&mut network, connections[source], &other_room, None);
    assert!(retired
        .pairs
        .iter()
        .all(|pair| !pair.confirmed || (pair.first, pair.second) != sibling_endpoints));
}

#[test]
fn unacknowledged_pair_failure_does_not_revoke_its_later_required_retry() {
    use piik_channel_core::wire::Request;
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, _) = join(&mut network, host, None);
    join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    join_room_interests(&mut network, viewer, &room);
    let screen = publish(&mut network, host, &room, "screen");
    subscribe_screen(&mut network, viewer, screen);
    let pending = pair(&network, viewer, host_session).id;
    connect(&mut network, [host, viewer], pending);
    let original = pair(&network, viewer, host_session);
    let before = topology(&mut network, host, &room, None);
    let input = |network: &mut RoomNetwork, command: Value, now| {
        network
            .authority
            .handle(viewer, Request::parse(&command.to_string()).unwrap(), now)
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::HostInput { input, .. } => Some(input),
                _ => None,
            })
            .unwrap()
    };
    let failed = input(
        &mut network,
        json!({"type":"link_state","pairId":original.id,"state":"failed"}),
        100,
    );
    assert_eq!(failed.failed_pairs.len(), 1);
    let failed_output = network.host_turn(&room, failed);
    assert!(failed_output.projection.flows.is_empty());
    // These inputs were issued while the domain had not received a covering
    // host output. The host has nevertheless already consumed the failure.
    let mut repaired = None;
    for now in [5_100, 5_101] {
        let repeated = input(
            &mut network,
            json!({"type":"browse","roomId":room,"active":true}),
            now,
        );
        assert_eq!(repeated.failed_pairs.len(), 1);
        let output = network.host_turn(&room, repeated);
        assert!(output.projection.flows.is_empty());
        repaired = Some(output);
    }
    network.command_at(
        host,
        json!({"type":"host_output","roomId":room,"output":repaired.unwrap()}),
        5_102,
    );
    let after_ack = input(
        &mut network,
        json!({"type":"browse","roomId":room,"active":true}),
        5_103,
    );
    assert!(
        after_ack.failed_pairs.is_empty(),
        "a covering output retires the failure fact"
    );
    let output = network.host_turn(&room, after_ack);
    network.command_at(
        host,
        json!({"type":"host_output","roomId":room,"output":output}),
        5_103,
    );
    network.command_at(
        host,
        json!({"type":"host_output","roomId":room,"output":failed_output}),
        5_104,
    );
    let due = network.authority.expire(5_104);
    network.deliver(due);
    let retry = pair(&network, viewer, host_session);
    assert_ne!(retry.id, original.id);
    for endpoint in [host, viewer] {
        network.command_at(
            endpoint,
            json!({"type":"link_state","pairId":retry.id,"state":"connected"}),
            5_105,
        );
    }
    let recovered = topology(&mut network, host, &room, None);
    assert_eq!(recovered.binding_id, before.binding_id);
    assert_eq!(recovered.pairs.len(), 1);
    assert!(recovered.pairs[0].confirmed);
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
        join_room_interests(&mut network, connection, &room);
        warm_pair(&mut network, source, connection, source_session);
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
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
            text: String::new(),
            nonce: "retained".into(),
            attachments: vec![serde_json::from_value(attachment.clone()).unwrap()],
        },
    );
    assert!(matches!(
        confirmation.result,
        Ok(
            piik_channel_core::conversation::ConversationResult::History(
                piik_channel_core::history::HistoryResult::Sent(_)
            )
        )
    ));
    command(
        &mut network,
        source,
        json!({"type":"file_offer","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"sha256":attachment["sha256"],"available":true}),
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
    let root_relay = pair(&network, relay, source_session);
    let root_viewer = pair(&network, viewer, source_session);
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
    let repair = network
        .state(viewer)
        .pairs
        .iter()
        .find(|edge| edge.peer_id == relay_session)
        .unwrap()
        .id;
    connect(&mut network, [relay, viewer], repair);
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
fn internal_screen_source_uses_three_confirmed_connections_and_shared_nonviewer_transit() {
    let mut network = RoomNetwork::new();
    let connections: Vec<_> = (0..7).map(|_| Uuid::new_v4()).collect();
    let sessions: Vec<_> = connections
        .iter()
        .map(|connection| join(&mut network, *connection, None).0)
        .collect();
    let room = network.create(connections[0], RoomAccess::Public, false);
    for connection in &connections[1..] {
        join_room_interests(&mut network, *connection, &room);
    }
    for (from, to) in [(1, 0), (1, 3), (1, 4), (0, 2), (2, 5), (2, 6)] {
        warm_pair(
            &mut network,
            connections[from],
            connections[to],
            sessions[from],
        );
    }
    let source = connections[1];
    let transit = connections[2];
    let picture = publish(&mut network, source, &room, "screen");
    command(
        &mut network,
        source,
        json!({"type":"set_screen_direct_limit","publicationId":picture,"limit":3}),
    );
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
        "the source uses its three confirmed connections within its direct limit"
    );
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
}

#[test]
fn publication_completion_waits_for_installed_projection_and_keeps_request_ownership() {
    use piik_channel_core::{host::RoomResult, wire::Request, RoomState};
    for outcome in [
        "pending",
        "already-applied",
        "disconnected",
        "new-binding",
        "error",
    ] {
        let mut network = RoomNetwork::new();
        let host = Uuid::new_v4();
        let publisher = Uuid::new_v4();
        network.command(
            host,
            json!({"type":"join","name":"Host","ownerKey":"owner"}),
        );
        let (_publisher_session, _) = join(&mut network, publisher, None);
        let room = network.create(host, RoomAccess::Public, false);
        join_room_interests(&mut network, publisher, &room);
        let existing = publish(&mut network, host, &room, "screen");
        subscribe_screen(&mut network, publisher, existing);
        let existing_edge = pair(&network, host, _publisher_session).id;
        connect(&mut network, [host, publisher], existing_edge);
        let pair_id = network.state(publisher).pairs.iter().next().unwrap().id;
        let publication = Uuid::new_v4();
        let effects = network.authority.handle(publisher, Request::parse(&json!({
            "type":"publish","requestId":"publication-order",
            "publication":{"id":publication,"roomId":room,"kind":if outcome == "error" { "voice" } else { "screen" },"source":{"kind":"screen","name":null},"videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}
        }).to_string()).unwrap(), 100);
        let input = effects
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::HostInput { input, .. } => Some(input),
                _ => None,
            })
            .unwrap();
        let output = network.host_turn(&room, input);
        if outcome == "pending" {
            use piik_channel_core::wire::{FileAvailability, FILE_AVAILABILITY_LIMIT};

            for (limit, count, authorized, reading) in [
                (Some(FILE_AVAILABILITY_LIMIT + 1), 1, true, true),
                (Some(1), 2, true, true),
                (Some(1), 1, true, false),
                (Some(1), 1, false, true),
                (None, 1, true, true),
            ] {
                let mut invalid = output.clone();
                invalid.projection.capabilities.file_availability_limit = limit;
                let view = invalid
                    .projection
                    .views
                    .get_mut(&_publisher_session)
                    .unwrap();
                view.authorized = authorized;
                view.reading = reading;
                view.file_availability = Some(FileAvailability {
                    observation_id: Uuid::new_v4(),
                    available: vec![true; count],
                });
                let rejected = network.command(
                    host,
                    json!({"type":"host_output","roomId":room,"output":invalid}),
                );
                assert!(
                    rejected.events.iter().any(|(_, event)| matches!(
                        event, Event::Error { code, .. } if code == "invalid_room_projection"
                    )),
                    "accepted invalid observation ({limit:?}, {count}, {authorized}, {reading})"
                );
            }
        }
        let mut invalid = output.clone();
        invalid.projection.summary.id = "wrong-room".into();
        let rejected = network.command(
            host,
            json!({"type":"host_output","roomId":room,"output":invalid}),
        );
        assert!(rejected.events.iter().any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "invalid_room_projection")));
        // Rejecting a bad projection must not consume its valid request owner.
        // Another endpoint's real failure arrives while the committed result is in flight.
        let failure = network.authority.handle(
            publisher,
            Request::parse(
                &json!({
                    "type":"link_state","pairId":pair_id,"state":"failed"
                })
                .to_string(),
            )
            .unwrap(),
            101,
        );
        let repair_input = failure
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::HostInput { input, .. } => Some(input),
                _ => None,
            })
            .unwrap();
        let repair = network.host_turn(&room, repair_input);
        if outcome == "already-applied" {
            network.command(
                host,
                json!({"type":"host_output","roomId":room,"output":repair.clone()}),
            );
        }
        let completed = network.command(
            host,
            json!({"type":"host_output","roomId":room,"output":output}),
        );
        let completion = |effects: &piik_channel_core::Effects| {
            effects
                .events
                .iter()
                .find_map(|(recipient, event)| match event {
                    Event::RoomReply {
                        request_id: Some(id),
                        result,
                        ..
                    } if *recipient == publisher && id == "publication-order" => {
                        Some(result.clone())
                    }
                    _ => None,
                })
        };
        if outcome == "already-applied" {
            assert!(
                matches!(completion(&completed), Some(RoomResult::Done)),
                "an installed newer projection covers a late result"
            );
            continue;
        }
        if outcome == "error" {
            assert!(
                matches!(completion(&completed), Some(RoomResult::Error { .. })),
                "an explicit failure does not wait for projection"
            );
            continue;
        }
        assert!(
            completion(&completed).is_none(),
            "{outcome}: success cannot precede installed authority"
        );
        let unrelated = network.command(
            host,
            json!({"type":"set_profile","avatar":null,"name":"Renamed"}),
        );
        assert!(completion(&unrelated).is_none());
        assert!(!network
            .state(publisher)
            .publications
            .iter()
            .any(|entry| entry.id == publication));
        match outcome {
            "pending" => {
                let delivered = network.command(
                    host,
                    json!({"type":"host_output","roomId":room,"output":repair}),
                );
                let state = delivered.events.iter().position(|(recipient, event)| *recipient == publisher && matches!(event, Event::State { state } if state.publications.iter().any(|entry| entry.id == publication))).unwrap();
                let reply = delivered.events.iter().position(|(recipient, event)| *recipient == publisher && matches!(event, Event::RoomReply { request_id: Some(id), result: RoomResult::Done, .. } if id == "publication-order")).unwrap();
                assert!(
                    state < reply,
                    "installed State must precede successful completion"
                );
                let again = network.command(
                    host,
                    json!({"type":"set_profile","avatar":null,"name":"Still here"}),
                );
                assert!(completion(&again).is_none(), "completion is consumed once");
            }
            "disconnected" => {
                let effects = network.authority.disconnect(publisher, 102);
                let delivered = network.deliver(effects);
                assert!(
                    completion(&delivered).is_none(),
                    "a disconnected physical requester cannot receive a result"
                );
                let late = network.command(
                    host,
                    json!({"type":"host_output","roomId":room,"output":repair}),
                );
                assert!(completion(&late).is_none());
            }
            "new-binding" => {
                network.command(
                    host,
                    json!({"type":"host_stop","roomId":room,"bindingId":repair.binding_id}),
                );
                let creator = repair.projection.summary.creator_id;
                network.restore_room(
                    host,
                    RoomState::new(
                        room.clone(),
                        "Restored".into(),
                        Default::default(),
                        creator,
                        RoomAccess::Public,
                        false,
                        None,
                    )
                    .unwrap(),
                );
                let late = network.command(
                    host,
                    json!({"type":"host_output","roomId":room,"output":repair}),
                );
                assert!(
                    completion(&late).is_none(),
                    "a replacement binding cannot replay old completion"
                );
                assert!(late.events.iter().any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "stale_room_host")));
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn room_default_reduction_converges_through_the_room_host() {
    let mut network = RoomNetwork::new();
    let [source, a, b] = [(); 3].map(|_| Uuid::new_v4());
    let (session, _) = join(&mut network, source, None);
    for viewer in [a, b] {
        join(&mut network, viewer, None);
    }
    let room = network.create(source, RoomAccess::Public, false);
    for viewer in [a, b] {
        browse(&mut network, viewer, &room, true);
        warm_pair(&mut network, source, viewer, session);
    }
    let picture = publish(&mut network, source, &room, "screen");
    for viewer in [a, b] {
        subscribe_screen(&mut network, viewer, picture);
        let (edge, flow) = screen_input(&network, viewer, session, picture).unwrap();
        command(
            &mut network,
            viewer,
            json!({"type":"flow_state","pairId":edge,"flowId":flow.id,"state":"decoded"}),
        );
    }
    let outputs = |network: &RoomNetwork| {
        network
            .state(source)
            .pairs
            .iter()
            .flat_map(|pair| &pair.outgoing)
            .filter(|flow| flow.selected && flow.publication_id == picture)
            .count()
    };
    assert_eq!(outputs(&network), 2);
    command(
        &mut network,
        source,
        json!({"type":"update_room","roomId":room,"name":"Friends","icon":"couch","access":"public","hidden":false,"relayCapacity":1}),
    );
    assert_eq!(outputs(&network), 2);
    let effects = network.authority.expire(20_100);
    assert!(effects.events.iter().any(|(_, event)| matches!(event, Event::HostInput { room_id, input } if room_id == &room && matches!(input.action, piik_channel_core::host::HostAction::RouteWake))));
    network.deliver(effects);
    assert_eq!(outputs(&network), 1);
}

#[test]
fn hosted_media_deadline_wakes_room_without_fencing_an_earlier_request() {
    use piik_channel_core::{
        host::{HostAction, RoomResult},
        wire::Request,
    };
    let mut network = RoomNetwork::new();
    let source = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let (source_session, _) = join(&mut network, source, None);
    let (a_session, _) = join(&mut network, a, None);
    join(&mut network, b, None);
    let room = network.create(source, RoomAccess::Public, false);
    for viewer in [a, b] {
        join_room_interests(&mut network, viewer, &room);
    }
    for viewer in [a, b] {
        warm_pair(&mut network, source, viewer, source_session);
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
    let proven = pair(&network, a, source_session);
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
    let warmed = publish(&mut network, a, &room, "screen");
    subscribe_screen(&mut network, b, warmed);
    let relay_pair = physical_pair(&network, b, a_session).unwrap();
    connect(&mut network, [a, b], relay_pair);
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
        !late.events.iter().any(|(target, event)| *target == a
            && matches!(event,Event::RoomReply{request_id:Some(id),..}if id=="earlier")),
        "success waits until the wake's covering projection is installed"
    );
    assert!(!network.authority.expire(deadline+1).events.iter().any(|(_,event)|matches!(event,Event::HostInput{input,..}if matches!(input.action,HostAction::RouteWake))),"old projection cannot reinsert a consumed wake deadline");
    let completed = network.deliver(effects);
    assert!(completed.events.iter().any(|(target, event)| *target == a
        && matches!(event, Event::RoomReply { request_id: Some(id), result: RoomResult::Done, .. } if id == "earlier")),
        "wake preserves and completes the earlier request after applying its projection");
    let repair = network
        .state(b)
        .pairs
        .iter()
        .find(|edge| edge.peer_id == a_session)
        .unwrap()
        .id;
    connect(&mut network, [a, b], repair);
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
    let retained = pair(&network, a, source_session);
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
    use piik_channel_core::{host::RoomResult, wire::Request};
    let mut network = RoomNetwork::new();
    let host = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, _) = join(&mut network, host, None);
    join(&mut network, viewer, None);
    let room = network.create(host, RoomAccess::Public, false);
    join_room_interests(&mut network, viewer, &room);
    let picture = publish(&mut network, host, &room, "screen");
    subscribe_screen(&mut network, viewer, picture);
    let original = pair(&network, viewer, host_session);
    connect(&mut network, [host, viewer], original.id);
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
                if !input.failed_pairs.is_empty())
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
        join_room_interests(&mut network, viewer, &room);
    }
    let c_picture = publish(&mut network, c, &room, "screen");
    subscribe_screen(&mut network, host, c_picture);
    let c_pair = pair(&network, c, host_session).id;
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

// Uses the real domain -> SQLite RoomHost projection fixture above.
fn preparation_network(ice: Vec<Value>) -> RoomNetwork {
    let mut network = RoomNetwork::new();
    network.authority = piik_channel_core::Authority::new("owner".into(), ice).unwrap();
    network
}
fn preparation_ice() -> Vec<Value> {
    vec![json!({"urls":["stun:one.example", "stun:two.example", "stun:three.example"]})]
}
fn prepare_capable_join(network: &mut RoomNetwork, connection: Uuid) -> (Uuid, String) {
    network
        .command(
            connection,
            json!({"type":"join","name":"Native participant","canPrepareUdp":true,"canReceiveVideoLayers":true}),
        )
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
        .unwrap()
}
#[test]
fn coordinated_udp_preparation_replaces_only_the_physical_attempt_and_preserves_room_expiry() {
    use piik_channel_core::{host::HostAction, wire::Request};
    let mut network = preparation_network(preparation_ice());
    let host = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, _) = prepare_capable_join(&mut network, host);
    prepare_capable_join(&mut network, viewer);
    let healthy = Uuid::new_v4();
    join(&mut network, healthy, None);
    let room = network.create(host, RoomAccess::Public, false);
    join_room_interests(&mut network, viewer, &room);
    let picture = publish(&mut network, host, &room, "screen");
    subscribe_screen(&mut network, healthy, picture);
    let healthy_pair = warm_pair(&mut network, host, healthy, host_session);
    assert_eq!(
        screen_input(&network, healthy, host_session, picture)
            .unwrap()
            .0,
        healthy_pair
    );
    network.command_at(
        viewer,
        json!({"type":"subscribe","publicationId":picture,"enabled":true}),
        101,
    );
    let original = pair(&network, viewer, host_session);
    assert!(original.can_receive_video_layers);
    assert_eq!(
        original.udp_preparation,
        Some(piik_channel_core::wire::UdpPreparation::Available)
    );
    assert!(original.incoming.is_empty());
    // Retain an actual RoomHost deadline before changing a physical attempt.
    let input = network
        .authority
        .handle(
            viewer,
            Request::parse(&json!({"type":"browse","roomId":room,"active":true}).to_string())
                .unwrap(),
            100,
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let projection = network.host_turn(&room, input);
    let deadline = projection.projection.next_route_deadline.unwrap();
    command(
        &mut network,
        host,
        json!({"type":"host_output","roomId":room,"output":projection}),
    );
    let effects = network.authority.handle(
        viewer,
        Request::parse(
            &json!({"type":"link_state","pairId":original.id,"state":"failed"}).to_string(),
        )
        .unwrap(),
        101,
    );
    assert!(
        !effects
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::HostInput { .. })),
        "prepared replacement is not a RoomHost route failure"
    );
    network.deliver(effects);
    let prepared = pair(&network, viewer, host_session);
    assert!(prepared.can_receive_video_layers);
    assert_ne!(prepared.id, original.id);
    assert_eq!(
        prepared.udp_preparation,
        Some(piik_channel_core::wire::UdpPreparation::Required)
    );
    assert_eq!(prepared.rooms, original.rooms);
    assert_eq!(prepared.incoming, original.incoming);
    assert_eq!(prepared.outgoing, original.outgoing);
    assert!(
        serde_json::to_value(&network.state(viewer).sessions)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s.get("canPrepareUdp").is_none() && s.get("canReceiveVideoLayers").is_none()),
        "runtime capability is not public roster data"
    );
    let stale = network.command_at(
        viewer,
        json!({"type":"signal","pairId":original.id,"payload":{"resync":true}}),
        102,
    );
    assert!(
        stale.events.is_empty(),
        "retired signaling cannot reach or fail the prepared replacement"
    );
    let input = network
        .authority
        .handle(
            viewer,
            Request::parse(&json!({"type":"browse","roomId":room,"active":true}).to_string())
                .unwrap(),
            102,
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let projection = network.host_turn(&room, input);
    assert_eq!(
        projection.projection.next_route_deadline,
        Some(deadline),
        "physical preparation cannot extend a logical route operation"
    );
    network.command_at(
        host,
        json!({"type":"host_output","roomId":room,"output":projection}),
        102,
    );
    let effects = network.authority.handle(
        viewer,
        Request::parse(
            &json!({"type":"link_state","pairId":prepared.id,"state":"failed"}).to_string(),
        )
        .unwrap(),
        103,
    );

    network.deliver(effects);
    assert!(!network
        .state(viewer)
        .pairs
        .iter()
        .any(|p| p.id == prepared.id));
    assert!(network
        .state(viewer)
        .pairs
        .iter()
        .all(|p| p.udp_preparation != Some(piik_channel_core::wire::UdpPreparation::Required)));
    // The unchanged expiry remains authoritative for the unrelated room flow.
    let expired = network.authority.expire(deadline);
    assert!(expired.events.iter().any(|(_,event)|matches!(event,Event::HostInput{input,..}if matches!(input.action,HostAction::RouteWake))));
    network.deliver(expired);
    assert!(screen_input(&network, healthy, host_session, picture).is_none());
    assert!(network
        .state(healthy)
        .failed_subscriptions
        .contains(&picture));
}

#[test]
fn failed_link_input_keeps_confirmed_links_between_room_readers() {
    use piik_channel_core::wire::Request;
    let mut network = RoomNetwork::new();
    let (b, c, d) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let (bs, _) = join(&mut network, b, None);
    let (cs, _) = join(&mut network, c, None);
    let (ds, _) = join(&mut network, d, None);
    let room = network.create(b, RoomAccess::Public, false);
    join_room_interests(&mut network, c, &room);
    browse(&mut network, d, &room, true);
    let screen = publish(&mut network, b, &room, "screen");
    subscribe_screen(&mut network, c, screen);
    let direct = pair(&network, c, bs);
    connect(&mut network, [b, c], direct.id);
    for peer in [b, c] {
        warm_pair(&mut network, d, peer, ds);
    }
    let failure = json!({"type":"link_state","pairId":direct.id,"state":"failed"});
    let effects = network
        .authority
        .handle(c, Request::parse(&failure.to_string()).unwrap(), 100);
    let input = effects
        .events
        .iter()
        .find_map(|(_, e)| match e {
            Event::HostInput { room_id, input }
                if room_id == &room && !input.failed_pairs.is_empty() =>
            {
                Some(input)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(
        input.confirmed_pairs,
        [(bs.min(ds), bs.max(ds)), (cs.min(ds), cs.max(ds))]
            .into_iter()
            .collect()
    );
}

#[test]
fn duplicate_transport_failure_keeps_confirmed_file_alternate() {
    check_file_repair(true, false);
}

#[test]
fn hosted_file_repair_reuses_three_confirmed_pairs() {
    check_file_repair(true, true);
}

#[test]
fn browser_host_file_repair_reuses_three_confirmed_pairs() {
    check_file_repair(false, true);
}

fn check_file_repair(hosted: bool, two_relays: bool) {
    use piik_channel_core::{
        host::{RoomSummary, ServiceEndpoint},
        wire::{HostingMode, Request},
        RoomState,
    };

    let mut network = RoomNetwork::new();
    if hosted {
        network.authority.set_hosting_mode(HostingMode::Hosted);
    }
    let [writer, b, c, first_reader, second_reader, e] = std::array::from_fn(|_| Uuid::new_v4());
    let (writer_session, _) = join(&mut network, writer, None);
    let (bs, _) = join(&mut network, b, None);
    let (cs, _) = join(&mut network, c, None);
    let (b, bs, c, cs) = if bs > cs {
        (b, bs, c, cs)
    } else {
        (c, cs, b, bs)
    };
    let (first_session, _) = join(&mut network, first_reader, None);
    let (second_session, _) = join(&mut network, second_reader, None);
    let (es, _) = join(&mut network, e, None);
    let (a, d, ds) = if first_session < second_session {
        (first_reader, second_reader, second_session)
    } else {
        (second_reader, first_reader, first_session)
    };
    if hosted {
        network
            .authority
            .set_room_writer(ServiceEndpoint {
                session_id: writer_session,
                connection_id: writer,
            })
            .unwrap();
    }
    let mut create = |actor, session, name: &str| {
        if !hosted {
            return network.create(actor, RoomAccess::Public, false);
        }
        let owner = network
            .state(actor)
            .sessions
            .iter()
            .find(|s| s.id == session)
            .unwrap()
            .user_id;
        let mut policy = RoomState::new(
            name.into(),
            name.into(),
            Default::default(),
            owner,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap();
        let creation = network
            .authority
            .prepare_hosted_creation(session, actor, RoomSummary::from_policy(&policy))
            .unwrap();
        network
            .authority
            .reserve_hosted_creation(&creation)
            .unwrap();
        policy.id = creation.summary().id.clone();
        network.restore_room(writer, policy)
    };
    let room = create(b, bs, "File room");
    let mut chain = if two_relays {
        vec![(c, cs), (e, es), (d, ds), (b, bs)]
    } else {
        vec![(c, cs), (d, ds), (b, bs)]
    };
    if !hosted {
        chain.reverse();
    }
    let leases: Vec<_> = chain
        .windows(2)
        .enumerate()
        .map(|(i, nodes)| {
            (
                create(nodes[0].0, nodes[0].1, &format!("Voice room {i}")),
                nodes,
            )
        })
        .collect();
    let mut confirmed = Vec::new();
    for (other, nodes) in leases {
        let [(parent, parent_session), (peer, peer_session)] = [nodes[0], nodes[1]];
        voice(&mut network, parent, &other, true);
        voice(&mut network, peer, &other, true);
        publish(&mut network, parent, &other, "voice");
        let edge = pair(&network, peer, parent_session);
        for socket in [peer, parent] {
            command(
                &mut network,
                socket,
                json!({"type":"link_state","pairId":edge.id,"state":"connected"}),
            );
        }
        confirmed.push((parent, parent_session, peer, peer_session, edge.id));
    }
    for peer in [a, b, c, d] {
        browse(&mut network, peer, &room, true);
    }
    if two_relays {
        browse(&mut network, e, &room, true);
    }
    let (seq, attachment) = offer_file(&mut network, b, &room, "held.bin");
    command(
        &mut network,
        c,
        json!({"type":"file_receive","roomId":room,
        "messageSeq":seq,"attachmentId":attachment.id,"enabled":true}),
    );
    let direct = pair(&network, c, bs);
    for socket in [b, c] {
        for report in [json!({"type":"link_state","pairId":direct.id,"state":"failed"})] {
            let effects =
                network
                    .authority
                    .handle(socket, Request::parse(&report.to_string()).unwrap(), 100);
            if let Some(input) = effects.events.iter().find_map(|(_, event)| match event {
                Event::HostInput { room_id, input } if room_id == &room => Some(input),
                _ => None,
            }) {
                for &(_, from, _, to, _) in &confirmed {
                    assert!(
                        input
                            .confirmed_pairs
                            .contains(&(from.min(to), from.max(to))),
                        "{report}"
                    );
                }
            }
            network.deliver(effects);
        }
    }
    for (parent, from, _, to, id) in confirmed {
        let graph = topology(&mut network, c, &room, None).pairs;
        assert!(
            network
                .state(parent)
                .pairs
                .iter()
                .any(|pair| pair.id == id && pair.rooms.contains(&room)),
            "confirmed edge {from}–{to} has no file-room lease: {}",
            serde_json::to_string(&graph).unwrap()
        );
    }
    if !hosted {
        chain.reverse();
    }
    for nodes in chain.windows(2) {
        let (receiver, receiver_session) = nodes[0];
        let (sender, sender_session) = nodes[1];
        assert!(network
            .state(receiver)
            .files
            .iter()
            .any(|file| file.room_id == room && file.upstream == Some(sender_session)));
        assert!(network
            .state(sender)
            .files
            .iter()
            .any(|file| file.room_id == room && file.downstream.contains(&receiver_session)));
    }
}

#[test]
fn confirmed_business_pairs_follow_room_scope_sockets_and_flow_leases() {
    use piik_channel_core::wire::Request;
    use std::collections::BTreeSet;

    let mut network = RoomNetwork::new();
    let source = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (a, _) = join(&mut network, source, None);
    let (b, credential) = join(&mut network, viewer, None);
    let edge = (a.min(b), a.max(b));
    let first = network.create(source, RoomAccess::Public, false);
    let second = network.create(source, RoomAccess::Public, false);
    let unrelated = network.create(source, RoomAccess::Private, true);
    let idle = network.create(source, RoomAccess::Public, false);
    browse(&mut network, viewer, &second, true);
    let screen = publish(&mut network, source, &first, "screen");
    command(
        &mut network,
        viewer,
        json!({"type":"subscribe", "publicationId":screen, "enabled":true}),
    );
    let pair = network
        .state(viewer)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == a)
        .unwrap()
        .id;
    let report = |pair| {
        Request::parse(&json!({"type":"link_state","pairId":pair,"state":"connected"}).to_string())
            .unwrap()
    };
    let report_rooms = |network: &mut RoomNetwork, socket, pair| {
        let effects = network.authority.handle(socket, report(pair), 100);
        let rooms: BTreeSet<_> = effects
            .events
            .iter()
            .filter_map(|(_, event)| match event {
                Event::HostInput { room_id, input } if input.confirmed_pairs.contains(&edge) => {
                    Some(room_id.clone())
                }
                _ => None,
            })
            .collect();
        network.deliver(effects);
        rooms
    };
    assert!(report_rooms(&mut network, source, pair).is_empty());
    assert!(report_rooms(&mut network, source, pair).is_empty());
    assert_eq!(
        report_rooms(&mut network, viewer, pair),
        BTreeSet::from([first.clone(), second.clone()])
    );
    let resumed = Uuid::new_v4();
    let effects = network.authority.handle(resumed, Request::parse(&json!({
        "type":"join", "canUsePeerTransport":true,"protocol":piik_channel_core::wire::CHANNEL_PROTOCOL,
        "name":"Returning viewer","credential":credential,"sessionId":b,
        "signingKey":piik_channel_core::conversation::SessionSigner::from_seed([1;32]).signing_key()
    }).to_string()).unwrap(), 101);
    let mut synced = BTreeSet::new();
    for (_, event) in &effects.events {
        if let Event::HostInput { room_id, input } = event {
            assert!(!input.confirmed_pairs.contains(&edge));
            synced.insert(room_id.clone());
        }
    }
    assert_eq!(
        synced,
        BTreeSet::from([first.clone(), second.clone(), unrelated, idle])
    );
    network.deliver(effects);
    assert!(report_rooms(&mut network, viewer, pair).is_empty());
    let late_disconnect = network.authority.disconnect(viewer, 102);
    network.deliver(late_disconnect);
    assert_eq!(physical_pair(&network, resumed, a), Some(pair));
    assert!(report_rooms(&mut network, source, pair).is_empty());
    assert_eq!(
        report_rooms(&mut network, resumed, pair),
        BTreeSet::from([first, second.clone()])
    );

    let other = publish(&mut network, source, &second, "screen");
    command(
        &mut network,
        resumed,
        json!({"type":"subscribe","publicationId":other,"enabled":true}),
    );
    command(
        &mut network,
        source,
        json!({"type":"unpublish","publicationId":screen}),
    );
    let lease = network
        .state(resumed)
        .pairs
        .iter()
        .find(|p| p.id == pair)
        .unwrap();
    assert!(lease
        .incoming
        .iter()
        .any(|flow| flow.publication_id == other));
    assert!(lease
        .incoming
        .iter()
        .all(|flow| flow.publication_id != screen));
    command(
        &mut network,
        source,
        json!({"type":"unpublish","publicationId":other}),
    );
    let standby = network
        .state(resumed)
        .pairs
        .iter()
        .find(|p| p.id == pair)
        .unwrap();
    assert!(standby.rooms.is_empty() && standby.incoming.is_empty() && standby.outgoing.is_empty());
    let next = publish(&mut network, source, &second, "screen");
    command(
        &mut network,
        resumed,
        json!({"type":"subscribe","publicationId":next,"enabled":true}),
    );
    assert!(network
        .state(resumed)
        .pairs
        .iter()
        .any(|p| p.id == pair && p.incoming.iter().any(|f| f.publication_id == next)));
    command(
        &mut network,
        source,
        json!({"type":"unpublish","publicationId":next}),
    );
    assert!(network.state(resumed).pairs.iter().any(|p| p.id == pair));
    browse(&mut network, resumed, &second, false);
    assert!(network
        .state(resumed)
        .pairs
        .iter()
        .filter(|p| p.id == pair)
        .all(|p| p.rooms.is_empty() && p.incoming.is_empty() && p.outgoing.is_empty()));
    command(&mut network, resumed, json!({"type":"leave"}));
    assert!(network.state(source).pairs.iter().all(|p| p.id != pair));
    let stale = network.authority.handle(source, report(pair), 102);
    assert!(
        stale.events.is_empty(),
        "a retired pair report cannot wake a room"
    );
}

#[test]
fn refused_file_branch_recovers_on_the_shared_pair_without_retiring_voice() {
    let mut network = RoomNetwork::new();
    let source = Uuid::new_v4();
    let relay = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (a, _) = join(&mut network, source, None);
    let (b, _) = join(&mut network, relay, None);
    let (c, _) = join(&mut network, viewer, None);
    let room = network.create(source, RoomAccess::Public, false);
    command(
        &mut network,
        source,
        json!({"type":"update_room","roomId":room,"name":"Friends","icon":"couch","access":"public","hidden":false,"relayCapacity":1}),
    );
    for (child, parent, parent_session) in [(relay, source, a), (viewer, relay, b)] {
        join_room_interests(&mut network, child, &room);
        warm_pair(&mut network, parent, child, parent_session);
    }
    let shortcut = |network: &RoomNetwork| {
        network
            .state(viewer)
            .pairs
            .iter()
            .find(|p| p.peer_id == a)
            .map(|p| p.id)
    };
    let (seq, attachment) = offer_file(&mut network, source, &room, "shared.bin");
    let receive = |network: &mut RoomNetwork, enabled: bool| {
        command(
            network,
            viewer,
            json!({"type":"file_receive","roomId":room,"messageSeq":seq,"attachmentId":attachment.id,"enabled":enabled}),
        )
    };
    receive(&mut network, true);
    let trial = shortcut(&network).expect("receiver requests direct connection");
    let incumbent = pair(&network, viewer, b).id;
    voice(&mut network, source, &room, true);
    voice(&mut network, viewer, &room, true);
    let mic = publish(&mut network, source, &room, "voice");
    let voice_flow = |network: &RoomNetwork| {
        pair(network, viewer, b)
            .incoming
            .iter()
            .find(|flow| flow.publication_id == mic)
            .unwrap()
            .id
    };
    let active_voice = voice_flow(&network);
    assert_eq!(network.state(viewer).files[0].upstream, Some(b));
    command(
        &mut network,
        relay,
        json!({"type":"byte_branch_refused","roomId":room,"target":{"kind":"file","messageSeq":seq,"attachmentId":attachment.id,"sourceId":a},"downstreamId":c}),
    );
    let waiting = &network.state(viewer).files[0];
    assert!(waiting.receiving);
    assert_eq!(waiting.source_id, Some(a));
    assert_eq!(waiting.upstream, None);
    assert_eq!(voice_flow(&network), active_voice);
    assert_eq!(pair(&network, viewer, b).id, incumbent);
    command(
        &mut network,
        relay,
        json!({"type":"forwarding_available","roomId":room,"kind":"file"}),
    );
    assert_eq!(network.state(viewer).files[0].upstream, Some(b));
    assert_eq!(voice_flow(&network), active_voice);
    receive(&mut network, false);
    assert_eq!(shortcut(&network), Some(trial));
    assert_eq!(pair(&network, viewer, b).id, incumbent);
    assert_eq!(voice_flow(&network), active_voice);
    command(
        &mut network,
        source,
        json!({"type":"unpublish","publicationId":mic}),
    );
    assert!(network
        .state(viewer)
        .pairs
        .iter()
        .filter(|edge| edge.peer_id == a)
        .all(|edge| edge.rooms.is_empty()));
}

#[test]
fn hosted_file_shortcut_does_not_interrupt_voice() {
    check_hosted_file_shortcut(true);
}

#[test]
fn hosted_file_shortcut_failure_preserves_voice_and_allows_recovery_on_the_old_pair() {
    check_hosted_file_shortcut(false);
}

fn check_hosted_file_shortcut(warmed: bool) {
    use piik_channel_core::{
        host::{RoomSummary, ServiceEndpoint},
        wire::HostingMode,
        RoomState,
    };

    let mut network = RoomNetwork::new();
    network.authority.set_hosting_mode(HostingMode::Hosted);
    let [writer, relay, source, viewer] = std::array::from_fn(|_| Uuid::new_v4());
    let (writer_session, _) = join(&mut network, writer, None);
    let (b, _) = join(&mut network, relay, None);
    let (a, _) = join(&mut network, source, None);
    let (c, _) = join(&mut network, viewer, None);
    network
        .authority
        .set_room_writer(ServiceEndpoint {
            session_id: writer_session,
            connection_id: writer,
        })
        .unwrap();
    let owner = network
        .state(relay)
        .sessions
        .iter()
        .find(|s| s.id == b)
        .unwrap()
        .user_id;
    let mut policy = RoomState::new(
        "hosted-file".into(),
        "Hosted file".into(),
        Default::default(),
        owner,
        RoomAccess::Public,
        false,
        None,
    )
    .unwrap();
    let creation = network
        .authority
        .prepare_hosted_creation(b, relay, RoomSummary::from_policy(&policy))
        .unwrap();
    network
        .authority
        .reserve_hosted_creation(&creation)
        .unwrap();
    policy.id = creation.summary().id.clone();
    let room = network.restore_room(writer, policy);
    join_room_interests(&mut network, relay, &room);
    for child in [source, viewer] {
        join_room_interests(&mut network, child, &room);
        let trial = publish(&mut network, relay, &room, "screen");
        subscribe_screen(&mut network, child, trial);
        let edge = pair(&network, child, b).id;
        connect(&mut network, [relay, child], edge);
        command(
            &mut network,
            relay,
            json!({"type":"unpublish","publicationId":trial}),
        );
    }
    voice(&mut network, source, &room, true);
    voice(&mut network, viewer, &room, true);
    let mic = publish(&mut network, source, &room, "voice");
    command(
        &mut network,
        source,
        json!({"type":"relay_capacity","roomId":room,"capacity":0}),
    );
    let voice_flow = |network: &RoomNetwork| {
        network
            .state(viewer)
            .pairs
            .iter()
            .flat_map(|p| &p.incoming)
            .find(|flow| flow.publication_id == mic && flow.selected)
            .map(|flow| flow.id)
    };
    let active_voice = voice_flow(&network).unwrap();
    for (socket, peer) in [(relay, a), (viewer, b)] {
        let edge = pair(&network, socket, peer);
        let flow = edge
            .incoming
            .iter()
            .find(|flow| flow.publication_id == mic)
            .unwrap();
        command(
            &mut network,
            socket,
            json!({"type":"flow_state","pairId":edge.id,"flowId":flow.id,"state":"forwardable"}),
        );
    }
    let (seq, attachment) = offer_file(&mut network, source, &room, "shortcut.bin");
    command(
        &mut network,
        viewer,
        json!({"type":"file_receive","roomId":room,"messageSeq":seq,"attachmentId":attachment.id,"enabled":true}),
    );
    let shortcut = network
        .state(viewer)
        .pairs
        .iter()
        .find(|edge| edge.peer_id == a)
        .unwrap()
        .id;
    assert_eq!(network.state(viewer).files[0].upstream, Some(b));
    command(
        &mut network,
        relay,
        json!({"type":"byte_branch_refused","roomId":room,"target":{"kind":"file","messageSeq":seq,"attachmentId":attachment.id,"sourceId":a},"downstreamId":c}),
    );
    assert_eq!(network.state(viewer).files[0].upstream, None);
    assert_eq!(voice_flow(&network), Some(active_voice));
    if warmed {
        connect(&mut network, [source, viewer], shortcut);
        assert_eq!(network.state(viewer).files[0].upstream, Some(a));
        assert_eq!(pair(&network, viewer, a).id, shortcut);
        assert_eq!(voice_flow(&network), Some(active_voice));
        command(
            &mut network,
            viewer,
            json!({"type":"set_profile","name":"Still receiving","avatar":null}),
        );
        assert_eq!(network.state(viewer).files[0].upstream, Some(a));
    } else {
        command(
            &mut network,
            viewer,
            json!({"type":"link_state","pairId":shortcut,"state":"failed"}),
        );
        assert_eq!(network.state(viewer).files[0].upstream, None);
        assert_eq!(voice_flow(&network), Some(active_voice));
        command(
            &mut network,
            relay,
            json!({"type":"forwarding_available","roomId":room,"kind":"file"}),
        );
        assert_eq!(network.state(viewer).files[0].upstream, Some(b));
    }
    assert_eq!(voice_flow(&network), Some(active_voice));
}

#[test]
fn demand_probes_one_shortcut_over_a_working_relay() {
    use piik_channel_core::wire::Request;

    for outcome in ["confirmed", "timeout", "failed"] {
        let mut network = RoomNetwork::new();
        let source = Uuid::new_v4();
        let relay = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let (a, _) = join(&mut network, source, None);
        let (b, _) = join(&mut network, relay, None);
        let (c, _) = join(&mut network, viewer, None);
        let room = network.create(source, RoomAccess::Public, false);
        command(
            &mut network,
            source,
            json!({"type":"update_room","roomId":room,"name":"Friends","icon":"couch","access":"public","hidden":false,"relayCapacity":1}),
        );
        for (child, parent, parent_session) in [(relay, source, a), (viewer, relay, b)] {
            join_room_interests(&mut network, child, &room);
            warm_pair(&mut network, parent, child, parent_session);
        }
        let screen = publish(&mut network, source, &room, "screen");
        command(
            &mut network,
            viewer,
            json!({"type":"subscribe","publicationId":screen,"enabled":true}),
        );
        let upstream = pair(&network, relay, a);
        let forwarded = upstream
            .incoming
            .iter()
            .find(|f| f.publication_id == screen)
            .unwrap()
            .id;
        command(
            &mut network,
            relay,
            json!({"type":"flow_state","pairId":upstream.id,"flowId":forwarded,"state":"decoded"}),
        );
        let incumbent = pair(&network, viewer, b);
        let flow = incumbent
            .incoming
            .iter()
            .find(|f| f.publication_id == screen)
            .unwrap()
            .id;
        command(
            &mut network,
            viewer,
            json!({"type":"flow_state","pairId":incumbent.id,"flowId":flow,"state":"decoded"}),
        );

        let trial = network
            .state(viewer)
            .pairs
            .iter()
            .find(|p| p.peer_id == a)
            .unwrap()
            .clone();
        assert!(trial.rooms.is_empty() && trial.incoming.is_empty() && trial.outgoing.is_empty());
        let edge = (a.min(c), a.max(c));
        let report = || {
            Request::parse(
                &json!({"type":"link_state","pairId":trial.id,"state":"connected"}).to_string(),
            )
            .unwrap()
        };
        let effects = network.authority.handle(source, report(), 101);
        assert!(effects.events.iter().all(|(_, e)| !matches!(e, Event::HostInput { input, .. } if input.confirmed_pairs.contains(&edge))));
        network.deliver(effects);
        match outcome {
            "confirmed" => {
                let effects = network.authority.handle(viewer, report(), 102);
                assert!(effects.events.iter().any(|(_, e)| matches!(e, Event::HostInput { input, .. } if input.confirmed_pairs.contains(&edge))));
                network.deliver(effects);
                assert!(network.state(viewer).pairs.iter().any(|p| p.id == trial.id));
            }
            "timeout" => {
                let effects = network.authority.expire(20_101);
                network.deliver(effects);
            }
            _ => command(
                &mut network,
                viewer,
                json!({"type":"link_state","pairId":trial.id,"state":"failed"}),
            ),
        }
        if outcome != "confirmed" {
            command(
                &mut network,
                viewer,
                json!({"type":"set_profile","name":"Still watching","avatar":null}),
            );
            assert!(
                network.state(viewer).pairs.iter().all(|p| p.peer_id != a),
                "{outcome}: {:?}",
                serde_json::to_value(&network.state(viewer).pairs).unwrap()
            );
        }
        assert!(
            network
                .state(viewer)
                .pairs
                .iter()
                .any(|p| p.id == incumbent.id
                    && p.incoming.iter().any(|f| f.id == flow && f.selected))
        );
        if outcome == "confirmed" {
            let disconnect = network.authority.disconnect(relay, 103);
            for (_, event) in &disconnect.events {
                if let Event::State { state } = event {
                    if state
                        .sessions
                        .iter()
                        .any(|session| session.id == b && !session.online)
                    {
                        assert!(state.pairs.iter().any(|p| p.id == trial.id),
                            "channel discarded the confirmed pair before the room repaired delivery");
                    }
                }
            }
            network.deliver(disconnect);
            assert!(
                network.state(viewer).pairs.iter().any(|p| p.id == trial.id),
                "after host disconnect projection"
            );
            command(
                &mut network,
                source,
                json!({"type":"link_state","pairId":upstream.id,"state":"failed"}),
            );
            command(
                &mut network,
                viewer,
                json!({"type":"link_state","pairId":incumbent.id,"state":"failed"}),
            );
            assert!(
                network.state(viewer).pairs.iter().any(|p| p.id == trial.id),
                "after incumbent failure"
            );
            let repair = network.authority.expire(5_104);
            network.deliver(repair);
            assert!(network.state(viewer).pairs.iter().any(|p| p.id == trial.id
                && p.incoming
                    .iter()
                    .any(|f| f.publication_id == screen && f.selected)));
            command(&mut network, viewer, json!({"type":"leave"}));
            assert!(network.state(source).pairs.iter().all(|p| p.id != trial.id));
        }
    }
}

#[test]
fn standby_carries_no_business_and_retires_on_leave_or_recovery_expiry() {
    for withdrawal in ["other demand", "disconnect", "leave"] {
        let mut network = RoomNetwork::new();
        let source = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let other = Uuid::new_v4();
        let (a, _) = join(&mut network, source, None);
        join(&mut network, viewer, None);
        let (c, _) = join(&mut network, other, None);
        let room = network.create(source, RoomAccess::Public, false);
        browse(&mut network, viewer, &room, true);
        let screen = publish(&mut network, source, &room, "screen");
        command(
            &mut network,
            viewer,
            json!({"type":"subscribe","publicationId":screen,"enabled":true}),
        );
        let pair = network
            .state(viewer)
            .pairs
            .iter()
            .find(|p| p.peer_id == a)
            .unwrap()
            .id;
        for endpoint in [source, viewer] {
            command(
                &mut network,
                endpoint,
                json!({"type":"link_state","pairId":pair,"state":"connected"}),
            );
        }
        command(
            &mut network,
            source,
            json!({"type":"unpublish","publicationId":screen}),
        );
        let idle =
            |p: &PairInfo| p.incoming.is_empty() && p.outgoing.is_empty() && p.rooms.is_empty();
        let standby = |network: &RoomNetwork| {
            network
                .state(source)
                .pairs
                .iter()
                .any(|p| p.id == pair && idle(p))
        };
        assert!(standby(&network));
        match withdrawal {
            "other demand" => {
                let next = publish(&mut network, source, &room, "screen");
                command(
                    &mut network,
                    other,
                    json!({"type":"subscribe","publicationId":next,"enabled":true}),
                );
                let edge = network
                    .state(other)
                    .pairs
                    .iter()
                    .find(|edge| edge.peer_id == a)
                    .unwrap()
                    .id;
                connect(&mut network, [source, other], edge);
                assert!(network
                    .state(source)
                    .pairs
                    .iter()
                    .any(|p| p.peer_id == c && !p.outgoing.is_empty()));
                assert!(network
                    .state(source)
                    .pairs
                    .iter()
                    .filter(|p| p.id == pair)
                    .all(idle));
            }
            "disconnect" => {
                voice(&mut network, viewer, &room, true);
                let disconnected_at = 100;
                let effects = network.authority.disconnect(viewer, disconnected_at);
                network.deliver(effects);
                assert!(standby(&network));

                voice(&mut network, source, &room, true);
                publish(&mut network, source, &room, "voice");
                assert!(standby(&network));

                let expires_at = disconnected_at + piik_channel_core::RECOVERY_MS;
                let before_expiry = network.authority.expire(expires_at - 1);
                network.deliver(before_expiry);
                assert!(standby(&network));
                let expired = network.authority.expire(expires_at);
                network.deliver(expired);
                assert!(network.state(source).pairs.iter().all(|p| p.id != pair));
            }
            _ => {
                command(&mut network, viewer, json!({"type":"leave"}));
                assert!(network.state(source).pairs.iter().all(|p| p.id != pair));
            }
        }
    }
}

#[test]
fn coordinated_udp_preparation_uses_current_capability_and_never_restarts_a_connected_pair() {
    use piik_channel_core::wire::Request;
    for connected in [false, true] {
        let mut network = preparation_network(preparation_ice());
        let host = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let (host_session, _) = prepare_capable_join(&mut network, host);
        let (viewer_session, credential) = prepare_capable_join(&mut network, viewer);
        let room = network.create(host, RoomAccess::Public, false);
        join_room_interests(&mut network, viewer, &room);
        let screen = publish(&mut network, host, &room, "screen");
        subscribe_screen(&mut network, viewer, screen);
        let original = pair(&network, viewer, host_session);
        if connected {
            command(
                &mut network,
                host,
                json!({"type":"link_state","pairId":original.id,"state":"connected"}),
            );
            // Connected is a transport fact; the ordinary opportunity is gone.
            // A later snapshot, rather than another connection attempt, shows it.
            command(
                &mut network,
                host,
                json!({"type":"set_profile","avatar":null,"name":"Connected Native"}),
            );
            assert_eq!(pair(&network, host, viewer_session).udp_preparation, None);
        } else {
            // Resume onto a client without this runtime capability. The same Session
            // and existing pair remain, but the previous client's claim cannot survive.
            let resumed = Uuid::new_v4();
            let effects=network.command(resumed,json!({"type":"join","name":"Browser participant","credential":credential,"sessionId":viewer_session.to_string()}));
            assert!(effects.events.iter().any(|(_,event)|matches!(event,Event::Welcome{session_id,..}if *session_id==viewer_session)));
            assert_eq!(pair(&network, host, viewer_session).udp_preparation, None);
        }
        let failed_id = pair(&network, host, viewer_session).id;
        let effects = network.authority.handle(
            host,
            Request::parse(
                &json!({"type":"link_state","pairId":failed_id,"state":"failed"}).to_string(),
            )
            .unwrap(),
            101,
        );
        network.deliver(effects);
        assert!(!network.state(host).pairs.iter().any(|p| p.id == failed_id));
        assert!(network
            .state(host)
            .pairs
            .iter()
            .all(|p| p.udp_preparation != Some(piik_channel_core::wire::UdpPreparation::Required)));
    }
}

#[test]
fn coordinated_udp_preparation_requires_distinct_configured_stun_authorities() {
    use piik_channel_core::{udp::stun_servers, wire::UdpPreparation};
    for (ice, expected_count) in [
        vec![],
        vec![json!({"urls":"stun:192.168.1.2:3478"})],
        vec![
            json!({"urls":["stun:ONE.example", "stun:one.example.:3478", "stun:two.example", "turn:three.example", "stuns:four.example", "stun:five.example?transport=tcp", "stun:[::1]"]}),
        ],
        vec![
            json!({"urls":["STUN:ONE.example.", "stun:two.example:3479", "stun:203.0.113.5:3480"]}),
        ],
        vec![
            json!({"urls":["STUN:ONE.example.", "stun:two.example:3479", "stun:203.0.113.5:3480", "stun:four.example", "stun:FOUR.example.:3478"]}),
        ],
    ]
    .into_iter()
    .zip([0, 0, 0, 3, 4])
    {
        let servers = stun_servers(&ice);
        assert_eq!(servers.as_ref().map_or(0, Vec::len), expected_count);
        let configured = servers.is_some();
        if let Some(servers) = servers {
            assert_eq!(servers[0].host, "one.example");
            assert_eq!(servers[0].port, 3478);
            assert_eq!(servers[1].port, 3479);
            assert_eq!(servers[2].host, "203.0.113.5");
        }
        let mut network = preparation_network(ice);
        let host = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let (host_session, _) = prepare_capable_join(&mut network, host);
        prepare_capable_join(&mut network, viewer);
        let room = network.create(host, RoomAccess::Public, false);
        join_room_interests(&mut network, viewer, &room);
        let original = pair(&network, viewer, host_session);
        assert_eq!(
            original.udp_preparation,
            configured.then_some(UdpPreparation::Available)
        );
        command(
            &mut network,
            viewer,
            json!({"type":"link_state","pairId":original.id,"state":"failed"}),
        );
        assert_eq!(
            network
                .state(viewer)
                .pairs
                .iter()
                .any(|pair| pair.udp_preparation == Some(UdpPreparation::Required)),
            configured
        );
    }
}

#[test]
fn coordinated_udp_signals_use_only_the_required_pair_and_fixed_endpoint_roles() {
    let mut network = preparation_network(preparation_ice());
    let host = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let (host_session, _) = prepare_capable_join(&mut network, host);
    let (viewer_session, _) = prepare_capable_join(&mut network, viewer);
    let (initiator, responder) = if host_session < viewer_session {
        (host, viewer)
    } else {
        (viewer, host)
    };
    let room = network.create(host, RoomAccess::Public, false);
    join_room_interests(&mut network, viewer, &room);
    let original = pair(&network, viewer, host_session);
    let observation = json!({"kind":"sequential","address":"203.0.113.5","port":42000,"step":2});
    let offer = json!({"udp":{"type":"offer","secret":vec![7u8;32],"observation":observation}});
    let rejected = network.command(
        initiator,
        json!({"type":"signal","pairId":original.id,"payload":offer}),
    );
    assert!(rejected
        .events
        .iter()
        .any(|(_, event)| matches!(event,Event::Error{code,..} if code=="invalid_signal")));
    command(
        &mut network,
        viewer,
        json!({"type":"link_state","pairId":original.id,"state":"failed"}),
    );
    let prepared = pair(&network, viewer, host_session);
    let answer = json!({"udp":{"type":"answer","observation":observation}});
    for (from, payload, accepted) in [
        (initiator, offer.clone(), true),
        (responder, offer, false),
        (responder, answer.clone(), true),
        (initiator, answer, false),
        (
            responder,
            json!({"udp":{"type":"answer","observation":{"kind":"sequential","address":"203.0.113.5","port":42000,"step":-2}}}),
            true,
        ),
        (
            responder,
            json!({"udp":{"type":"answer","observation":{"kind":"sequential","address":"203.0.113.5","port":1024,"step":-1}}}),
            false,
        ),
        (
            responder,
            json!({"udp":{"type":"answer","observation":{"kind":"sequential","address":"203.0.113.5","port":42000,"step":-17}}}),
            false,
        ),
        (
            responder,
            json!({"udp":{"type":"answer","observation":{"kind":"stable","address":"203.0.113.5","port":42000}}}),
            true,
        ),
        (
            responder,
            json!({"udp":{"type":"answer","observation":{"kind":"irregular","address":"203.0.113.5"}}}),
            true,
        ),
        (
            responder,
            json!({"udp":{"type":"answer","observation":{"kind":"sequential","address":"203.0.113.5","port":42000,"step":0}}}),
            false,
        ),
        (initiator, json!({"udp":{"type":"ready"}}), true),
        (responder, json!({"udp":{"type":"ready"}}), true),
        (initiator, json!({"udp":{"type":"unavailable"}}), true),
        (responder, json!({"udp":{"type":"unavailable"}}), true),
        (initiator, json!({"udp":{"type":"complete"}}), true),
        (responder, json!({"udp":{"type":"complete"}}), true),
        (
            initiator,
            json!({"udp":{"type":"complete"},"resync":true}),
            false,
        ),
        (
            responder,
            json!({"udp":{"type":"answer","observation":{"kind":"sequential","address":"127.0.0.1","port":42000,"step":0}}}),
            false,
        ),
        (
            responder,
            json!({"udp":{"type":"answer","observation":{"kind":"sequential","address":"203.0.113.5","port":65530,"step":2}}}),
            false,
        ),
    ] {
        let result = network.command(
            from,
            json!({"type":"signal","pairId":prepared.id,"payload":payload}),
        );
        assert_eq!(
            result.events.iter().any(|(to, event)| *to != from
                && matches!(event,Event::Signal{pair_id,..} if *pair_id==prepared.id)),
            accepted
        );
        assert_eq!(
            result
                .events
                .iter()
                .any(|(_, event)| matches!(event,Event::Error{code,..} if code=="invalid_signal")),
            !accepted
        );
    }
}

#[test]
fn linear_ice_candidate_provenance_requires_its_generation() {
    use piik_channel_core::wire::Signal;
    let candidate = "candidate:real 1 udp 123 203.0.113.1 41000 typ srflx";
    for (value, valid) in [
        (json!({"candidate":{"candidate":candidate}}), true),
        (
            json!({"candidate":{"candidate":candidate,"origin":"linear","usernameFragment":"current"}}),
            true,
        ),
        (
            json!({"candidate":{"candidate":candidate,"origin":"linear"}}),
            false,
        ),
        (
            json!({"candidate":{"candidate":candidate,"origin":"linear","usernameFragment":" "}}),
            false,
        ),
        (
            json!({"candidate":{"candidate":"","origin":"linear","usernameFragment":"current"}}),
            false,
        ),
    ] {
        assert_eq!(
            serde_json::from_value::<Signal>(value).unwrap().valid(),
            valid
        );
    }
    assert!(serde_json::from_value::<Signal>(json!({"candidate":{
        "candidate":candidate,"origin":"observed","usernameFragment":"current"
    }}))
    .is_err());
}

#[test]
#[ignore = "capacity acceptance: run explicitly in release mode with 81 endpoints"]
fn two_twenty_person_rooms_share_site_capacity_with_browser_app_and_bounded_profiles() {
    use base64ct::{Base64, Encoding};
    use piik_channel_core::wire::{CHANNEL_MESSAGE_BYTES, IDENTITY_IMAGE_URL_BYTES};
    let mut network = RoomNetwork::new();
    let operator = Uuid::new_v4();
    command(
        &mut network,
        operator,
        json!({"type":"join","ownerKey":"owner","name":"Server"}),
    );
    let mut bytes = Base64::decode_vec("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==").unwrap();
    bytes.resize(
        (IDENTITY_IMAGE_URL_BYTES - "data:image/png;base64,".len()) / 4 * 3,
        0,
    );
    let image = format!("data:image/png;base64,{}", Base64::encode_string(&bytes));
    let mut people = Vec::new();
    for _ in 0..40 {
        let browser = Uuid::new_v4();
        let app = Uuid::new_v4();
        let (browser_session, credential) = join(&mut network, browser, None);
        let (app_session, _) = join(&mut network, app, Some(&credential));
        command(
            &mut network,
            browser,
            json!({"type":"set_profile","name":"Participant","avatar":image}),
        );
        people.push((browser, app, browser_session, app_session));
    }
    assert_eq!(network.state(operator).sessions.len(), 81);
    assert_eq!(network.state(operator).channel.user_count, 41);
    let mut rooms = Vec::new();
    for group in people.chunks(20) {
        let room = network.create(group[0].1, RoomAccess::Public, false);
        let mut screens = Vec::new();
        for &(browser, app, _, _) in group {
            browse(&mut network, browser, &room, true);
            voice(&mut network, browser, &room, true);
            publish(&mut network, browser, &room, "voice");
            screens.push(publish(&mut network, app, &room, "screen"));
        }
        for &(browser, _, _, helper) in group {
            for screen in &screens {
                command(
                    &mut network,
                    browser,
                    json!({"type":"subscribe","publicationId":screen,"enabled":true,"helperSessionId":helper}),
                );
            }
        }
        let attachment = json!({"id":Uuid::new_v4(),"name":"file.bin","mediaType":"application/octet-stream","size":3,"sha256":piik_channel_core::attachment::sha256_hex(b"abc")});
        assert!(network
            .peer_request(
                group[1].1,
                &room,
                ConversationCommand::Chat {
                    mentions: vec![],
                    reply: None,
                    inline_images: Default::default(),
                    text: String::new(),
                    nonce: "capacity-file".into(),
                    attachments: vec![serde_json::from_value(attachment.clone()).unwrap()]
                }
            )
            .result
            .is_ok());
        command(
            &mut network,
            group[1].1,
            json!({"type":"file_offer","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"sha256":attachment["sha256"],"available":true}),
        );
        command(
            &mut network,
            group[19].0,
            json!({"type":"file_receive","roomId":room,"messageSeq":1,"attachmentId":attachment["id"],"enabled":true}),
        );
        rooms.push(room);
    }
    // Report assigned transport/flow facts through the same public authority path.
    // These are deterministic Core proofs, not a claim about real media bandwidth.
    for _ in 0..2 {
        for &(browser, app, _, _) in &people {
            for connection in [browser, app] {
                let pairs = network.state(connection).pairs.clone();
                for pair in pairs {
                    command(
                        &mut network,
                        connection,
                        json!({"type":"link_state","pairId":pair.id,"state":"connected"}),
                    );
                    for flow in pair.incoming {
                        command(
                            &mut network,
                            connection,
                            json!({"type":"flow_state","pairId":pair.id,"flowId":flow.id,"state":"decoded"}),
                        );
                    }
                }
            }
        }
    }
    for (index, room) in rooms.iter().enumerate() {
        let group = &people[index * 20..index * 20 + 20];
        let state = network.state(group[0].0);
        let visible = state
            .channel
            .rooms
            .iter()
            .find(|value| &value.id == room)
            .unwrap();
        let users: std::collections::BTreeSet<_> = visible
            .participant_session_ids
            .iter()
            .map(|id| {
                state
                    .sessions
                    .iter()
                    .find(|session| session.id == *id)
                    .unwrap()
                    .user_id
            })
            .collect();
        assert_eq!(users.len(), 20);
        assert_eq!(
            state
                .publications
                .iter()
                .filter(|source| &source.room_id == room)
                .count(),
            40
        );
        assert_eq!(
            state
                .voice
                .iter()
                .filter(|voice| &voice.room_id == room)
                .count(),
            20
        );
        assert!(network
            .state(group[19].0)
            .files
            .iter()
            .any(|plan| &plan.room_id == room && plan.receiving));
        command(
            &mut network,
            group[0].1,
            json!({"type":"update_room","roomId":room,"name":"Full room","icon":"couch","picture":image,"access":"public","hidden":false}),
        );
    }
    // Every room hosts a maximum-size picture. Only its active readers receive it.
    for _ in 2..32 {
        let room = network.create(people[0].1, RoomAccess::Public, false);
        command(
            &mut network,
            people[0].1,
            json!({"type":"update_room","roomId":room,"name":"Idle room","icon":"couch","picture":image,"access":"public","hidden":false}),
        );
    }
    command(
        &mut network,
        operator,
        json!({"type":"update_domain","name":"Large friends site","icon":image}),
    );
    let directory = &network.state(operator).channel.rooms;
    assert_eq!(directory.len(), 32);
    assert!(directory.iter().all(|room| room.picture.is_none()));
    for (group, id) in people.chunks(20).zip(&rooms) {
        let reading = network
            .state(group[0].0)
            .channel
            .rooms
            .iter()
            .find(|room| &room.id == id)
            .unwrap();
        assert_eq!(reading.picture.as_deref(), Some(image.as_str()));
    }
    let mut max_state_bytes = 0;
    for &(browser, app, _, _) in &people {
        for connection in [browser, app] {
            let event = Event::State {
                state: network.state(connection).clone(),
            };
            let bytes = serde_json::to_vec(&event).unwrap().len();
            max_state_bytes = max_state_bytes.max(bytes);
            assert!(bytes < CHANNEL_MESSAGE_BYTES);
            let mut encoder = piik_channel_core::wire_images::StateImageEncoder::default();
            let mut decoder = piik_channel_core::wire_images::StateImageDecoder::default();
            decoder.decode(&encoder.encode(&event).unwrap()).unwrap();
            decoder.decode(&encoder.encode(&event).unwrap()).unwrap();
        }
    }
    let profile_reply = network.command(
        operator,
        json!({"type":"profiles","requestId":"page","query":"Participant"}),
    );
    let profile_event = profile_reply
        .events
        .iter()
        .find(|(_, event)| matches!(event, Event::Profiles { .. }))
        .unwrap();
    let profile_bytes = serde_json::to_vec(&profile_event.1).unwrap().len();
    assert!(profile_bytes < 1024 * 1024);
    assert!(network.max_host_output_bytes < CHANNEL_MESSAGE_BYTES);
    eprintln!("capacity target: endpoints=81 users=41 rooms=32 activeRooms=2 screens=40 voices=40 maxStateBytes={max_state_bytes} maxHostOutputBytes={} profilePageBytes={profile_bytes}",network.max_host_output_bytes);
    // Leaving retires this user's Browser activities without retiring the other room.
    command(&mut network, people[19].0, json!({"type":"leave"}));
    assert_eq!(
        network
            .state(people[20].0)
            .voice
            .iter()
            .filter(|voice| voice.room_id == rooms[1])
            .count(),
        20
    );
}

#[test]
fn udp_observation_preserves_port_bounds_in_both_directions() {
    use piik_channel_core::wire::UdpObservation;
    for (port, step, target) in [
        (1088, -16, Some(1024)),
        (1087, -16, None),
        (65471, 16, Some(65535)),
        (65472, 16, None),
        (42000, 17, None),
        (42000, -17, None),
        (1024, 0, None),
    ] {
        let observation = UdpObservation::Sequential {
            address: "203.0.113.5".parse().unwrap(),
            port,
            step,
        };
        assert_eq!(observation.target().map(|address| address.port()), target);
    }
    let address = "203.0.113.5".parse().unwrap();
    assert_eq!(
        UdpObservation::Stable {
            address,
            port: 1024
        }
        .target()
        .unwrap()
        .port(),
        1024
    );
    assert!(!UdpObservation::Stable {
        address,
        port: 1023
    }
    .valid());
    assert!(UdpObservation::Irregular { address }.valid());
    assert!(UdpObservation::Irregular { address }.target().is_none());
    for address in [
        "0.0.0.0",
        "10.0.0.1",
        "127.0.0.1",
        "169.254.1.1",
        "172.16.0.1",
        "192.168.1.1",
        "224.0.0.1",
        "255.255.255.255",
    ] {
        assert!(!UdpObservation::Irregular {
            address: address.parse().unwrap()
        }
        .valid());
    }
    for observation in [
        json!({"address":"203.0.113.5","port":42000,"step":2}),
        json!({"kind":"irregular","address":"203.0.113.5","port":42000}),
        json!({"kind":"stable","address":"203.0.113.5","port":42000,"step":0}),
    ] {
        assert!(serde_json::from_value::<UdpObservation>(observation).is_err());
    }
    for signal in [
        json!({"type":"unavailable","reason":"private source details"}),
        json!({"type":"ready","strategy":"birthday"}),
        json!({"type":"answer","prediction":{"address":"203.0.113.5","port":42000,"step":2}}),
    ] {
        assert!(serde_json::from_value::<piik_channel_core::wire::UdpSignal>(signal).is_err());
    }
}

fn screen_input(
    network: &RoomNetwork,
    receiver: Uuid,
    sender: Uuid,
    screen: Uuid,
) -> Option<(Uuid, piik_channel_core::wire::FlowBinding)> {
    network
        .state(receiver)
        .pairs
        .iter()
        .filter(|pair| pair.peer_id == sender)
        .find_map(|pair| {
            pair.incoming
                .iter()
                .find(|flow| flow.publication_id == screen)
                .map(|flow| (pair.id, *flow))
        })
}

fn subscribe_screen(network: &mut RoomNetwork, connection: Uuid, screen: Uuid) {
    command(
        network,
        connection,
        json!({"type":"subscribe","publicationId":screen,"enabled":true}),
    );
}

#[test]
fn reader_relay_follows_room_scope_and_releases_proved_flows_at_zero() {
    let mut network = RoomNetwork::new();
    let [reader, publisher, viewer] = [(); 3].map(|_| Uuid::new_v4());
    let (relay, _) = join(&mut network, reader, None);
    let (source, _) = join(&mut network, publisher, None);
    let (audience, _) = join(&mut network, viewer, None);
    let room = network.create(publisher, RoomAccess::Public, false);
    let other = network.create(reader, RoomAccess::Public, false);
    browse(&mut network, reader, &other, true);
    let screen = publish(&mut network, publisher, &room, "screen");
    subscribe_screen(&mut network, viewer, screen);
    let direct = physical_pair(&network, viewer, source).unwrap();
    assert!(screen_input(&network, reader, source, screen).is_none());
    command(
        &mut network,
        viewer,
        json!({"type":"link_state","pairId":direct,"state":"failed"}),
    );
    assert!(screen_input(&network, viewer, relay, screen).is_none());
    assert!(network.state(viewer).subscriptions.contains(&screen));
    assert!(network
        .state(viewer)
        .pairs
        .iter()
        .filter(|pair| pair.peer_id == relay)
        .all(|pair| !pair.rooms.contains(&room)));

    browse(&mut network, reader, &room, true);
    let relay_path = [(reader, source, publisher), (reader, audience, viewer)];
    let mut confirmed = None;
    for _ in 0..2 {
        let (from, to, pair) = relay_path
            .iter()
            .find_map(|&(from, peer, to)| {
                let pair = physical_pair(&network, from, peer)?;
                (Some(pair) != confirmed).then_some((from, to, pair))
            })
            .expect("repair must propose both reader legs");
        connect(&mut network, [from, to], pair);
        confirmed = Some(pair);
    }
    let (upstream_pair, upstream) = screen_input(&network, reader, source, screen).unwrap();
    let (downstream_pair, downstream) = screen_input(&network, viewer, relay, screen).unwrap();
    assert_eq!(downstream.input_flow_id, Some(upstream.id));
    let publication = network
        .state(publisher)
        .publications
        .iter()
        .find(|p| p.id == screen)
        .unwrap();
    assert_eq!(
        publication
            .audience
            .iter()
            .map(|entry| entry.session_id)
            .collect::<Vec<_>>(),
        vec![audience]
    );
    command(
        &mut network,
        reader,
        json!({"type":"flow_state","pairId":upstream_pair,"flowId":upstream.id,"state":"forwardable"}),
    );
    command(
        &mut network,
        viewer,
        json!({"type":"flow_state","pairId":downstream_pair,"flowId":downstream.id,"state":"decoded"}),
    );
    assert!(network.state(viewer).failed_subscriptions.is_empty());

    voice(&mut network, reader, &room, true);
    assert_eq!(
        screen_input(&network, viewer, relay, screen),
        Some((downstream_pair, downstream))
    );
    subscribe_screen(&mut network, reader, screen);
    assert_eq!(
        screen_input(&network, viewer, relay, screen),
        Some((downstream_pair, downstream))
    );
    assert!(network.state(viewer).failed_subscriptions.is_empty());

    let personal = screen_input(&network, reader, source, screen).unwrap();
    command(
        &mut network,
        reader,
        json!({"type":"relay_capacity","roomId":room,"capacity":0}),
    );
    assert_eq!(
        screen_input(&network, viewer, relay, screen),
        Some((downstream_pair, downstream))
    );
    network.command_at(
        reader,
        json!({"type":"browse","roomId":room,"active":true}),
        10_100,
    );
    let just_before = network.authority.expire(20_099);
    network.deliver(just_before);
    assert_eq!(
        screen_input(&network, viewer, relay, screen),
        Some((downstream_pair, downstream))
    );
    let deadline = network.authority.expire(20_100);
    network.deliver(deadline);
    assert!(screen_input(&network, viewer, relay, screen).is_none());
    assert_eq!(
        screen_input(&network, reader, source, screen),
        Some(personal)
    );
    assert!(network.state(reader).subscriptions.contains(&screen));
}

#[test]
fn reader_relay_reserves_capacity_across_publications_before_proof() {
    let mut network = RoomNetwork::new();
    let [reader, publisher, viewer, second_publisher, second_viewer] =
        [(); 5].map(|_| Uuid::new_v4());
    let (relay, _) = join(&mut network, reader, None);
    let (source, _) = join(&mut network, publisher, None);
    let (second_source, _) = join(&mut network, second_publisher, None);
    let [viewer_session, second_viewer_session] =
        [viewer, second_viewer].map(|endpoint| join(&mut network, endpoint, None).0);
    let room = network.create(publisher, RoomAccess::Public, false);
    browse(&mut network, reader, &room, true);
    command(
        &mut network,
        reader,
        json!({"type":"relay_capacity","roomId":room,"capacity":1}),
    );
    for endpoint in [publisher, viewer, second_publisher, second_viewer] {
        command(
            &mut network,
            endpoint,
            json!({"type":"relay_capacity","roomId":room,"capacity":0}),
        );
        warm_pair(&mut network, reader, endpoint, relay);
    }
    let first = publish(&mut network, publisher, &room, "screen");
    let second = publish(&mut network, second_publisher, &room, "screen");
    let first_direct = warm_pair(&mut network, publisher, viewer, source);
    let second_direct = warm_pair(&mut network, second_publisher, second_viewer, second_source);

    subscribe_screen(&mut network, viewer, first);
    assert_eq!(
        screen_input(&network, viewer, source, first).unwrap().0,
        first_direct
    );
    command(
        &mut network,
        viewer,
        json!({"type":"link_state","pairId":first_direct,"state":"failed"}),
    );
    let first_branch = screen_input(&network, viewer, relay, first)
        .expect("the first picture reserves the reader before any flow proof");
    assert_eq!(
        first_branch.1.input_flow_id,
        Some(screen_input(&network, reader, source, first).unwrap().1.id)
    );

    subscribe_screen(&mut network, second_viewer, second);
    assert_eq!(
        screen_input(&network, second_viewer, second_source, second)
            .unwrap()
            .0,
        second_direct
    );
    command(
        &mut network,
        second_viewer,
        json!({"type":"link_state","pairId":second_direct,"state":"failed"}),
    );
    assert!(network.state(second_viewer).subscriptions.contains(&second));
    assert!(network
        .state(second_viewer)
        .pairs
        .iter()
        .flat_map(|pair| &pair.incoming)
        .all(|flow| flow.publication_id != second));
    assert_eq!(
        screen_input(&network, viewer, relay, first),
        Some(first_branch)
    );
    let output_peers = |network: &RoomNetwork| {
        network
            .state(reader)
            .pairs
            .iter()
            .filter(|pair| !pair.outgoing.is_empty())
            .map(|pair| pair.peer_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(output_peers(&network), [viewer_session]);

    command(
        &mut network,
        viewer,
        json!({"type":"subscribe","publicationId":first,"enabled":false}),
    );
    let second_branch = screen_input(&network, second_viewer, relay, second)
        .expect("the waiting second picture uses the released slot");
    assert_eq!(
        second_branch.1.input_flow_id,
        Some(
            screen_input(&network, reader, second_source, second)
                .unwrap()
                .1
                .id
        )
    );
    assert_eq!(output_peers(&network), [second_viewer_session]);

    subscribe_screen(&mut network, viewer, first);
    assert!(screen_input(&network, viewer, relay, first).is_none());
    let mut budget = piik_channel_core::forwarding::ForwardingBudget::default();
    for update in budget.capacity_updates(relay, Some(2), network.state(reader)) {
        command(&mut network, reader, serde_json::to_value(update).unwrap());
    }
    assert!(screen_input(&network, viewer, relay, first).is_some());
    assert_eq!(screen_input(&network, second_viewer, relay, second), Some(second_branch));

    browse(&mut network, reader, &room, false);
    assert!(screen_input(&network, viewer, relay, first).is_none());
    assert!(screen_input(&network, second_viewer, relay, second).is_none());
    assert!(network
        .state(reader)
        .pairs
        .iter()
        .all(|pair| pair.incoming.is_empty() && pair.outgoing.is_empty()));
}

#[test]
fn screen_reaches_its_only_viewer_through_two_room_readers() {
    use std::collections::BTreeSet;

    for warm in [false, true] {
        let mut network = RoomNetwork::new();
        let mut peers = [(); 4].map(|_| {
            let connection = Uuid::new_v4();
            (join(&mut network, connection, None).0, connection)
        });
        peers.sort(); // Keep the planner's session ordering reproducible.
        let sessions = peers.map(|(session, _)| session);
        let connections = peers.map(|(_, connection)| connection);
        let [publisher, first, second, viewer] = connections;
        let room = network.create(publisher, RoomAccess::Public, false);
        browse(&mut network, first, &room, true);
        browse(&mut network, second, &room, true);
        let mut handled = BTreeSet::new();
        if warm {
            let middle = warm_pair(&mut network, first, second, sessions[1]);
            handled.insert(middle);
        }
        let pair_ids = |network: &RoomNetwork| {
            connections
                .iter()
                .flat_map(|peer| network.state(*peer).pairs.iter().map(|pair| pair.id))
                .collect::<BTreeSet<_>>()
        };
        let screen = publish(&mut network, publisher, &room, "screen");
        assert!(network
            .state(viewer)
            .pairs
            .iter()
            .all(|pair| pair.incoming.is_empty()));
        subscribe_screen(&mut network, viewer, screen);

        // Answer each assigned transport once. Only adjacent endpoints can connect.
        while let Some((from, to, id)) = peers.iter().enumerate().find_map(|(from, &(_, peer))| {
            network.state(peer).pairs.iter().find_map(|pair| {
                let to = sessions.iter().position(|id| *id == pair.peer_id)?;
                (from < to && !handled.contains(&pair.id)).then_some((from, to, pair.id))
            })
        }) {
            assert!(
                handled.len() < 12,
                "discovery repeatedly allocated the same route"
            );
            handled.insert(id);
            if to == from + 1 {
                for connection in [connections[from], connections[to]] {
                    command(
                        &mut network,
                        connection,
                        json!({"type":"link_state","pairId":id,"state":"connected"}),
                    );
                }
            } else {
                command(
                    &mut network,
                    connections[from],
                    json!({"type":"link_state","pairId":id,"state":"failed"}),
                );
            }
        }
        let chain = |network: &RoomNetwork| {
            [0, 1, 2].map(|i| {
                screen_input(network, connections[i + 1], sessions[i], screen)
                    .expect("the viewer needs all three legs")
            })
        };
        let proved = chain(&network);
        let mut upstream = None;
        for (i, (pair, flow)) in proved.iter().enumerate() {
            assert!(flow.selected);
            assert_eq!(flow.input_flow_id, upstream);
            upstream = Some(flow.id);
            let proof = if i == 2 { "decoded" } else { "forwardable" };
            command(
                &mut network,
                connections[i + 1],
                json!({"type":"flow_state","pairId":pair,"flowId":flow.id,"state":proof}),
            );
        }
        let stable = pair_ids(&network);
        for now in [5_100, 20_100, 40_100] {
            let effects = network.authority.expire(now);
            network.deliver(effects);
            assert_eq!(pair_ids(&network), stable);
            assert_eq!(chain(&network), proved);
        }
        for reader in [first, second] {
            assert!(!network.state(reader).subscriptions.contains(&screen));
        }
        assert!(network.state(viewer).failed_subscriptions.is_empty());
        network.command_at(
            viewer,
            json!({"type":"subscribe","publicationId":screen,"enabled":false}),
            40_101,
        );
        for peer in connections {
            assert!(network.state(peer).pairs.iter().all(|pair| pair
                .incoming
                .iter()
                .chain(&pair.outgoing)
                .all(|flow| flow.publication_id != screen)));
        }
    }
}

#[path = "base_routes/coexisting_demand.rs"]
mod coexisting_demand;

#[test]
fn in_flight_room_updates_merge_at_the_room_host() {
    use piik_channel_core::wire::Request;

    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    join(&mut network, owner, None);
    join(&mut network, outsider, None);
    let room = network.create(owner, RoomAccess::Public, false);
    let patch = |fields: Value| {
        let mut command = json!({"type":"update_room","roomId":room});
        command
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        Request::parse(&command.to_string()).unwrap()
    };
    let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    let privacy = network.authority.handle(
        owner,
        patch(json!({"access":"private","hidden":true,"picture":image,"password":"fixture"})),
        100,
    );
    let audio = network
        .authority
        .handle(owner, patch(json!({"voiceBitrate":96000})), 100);
    network.deliver(privacy);
    network.deliver(audio);
    let policy = network.policy(&room);
    assert!(policy.access == RoomAccess::Private);
    assert!(
        policy.hidden && piik_channel_core::host::RoomSummary::from_policy(&policy).has_password
    );
    assert_eq!(policy.appearance.picture.as_deref(), Some(image));
    assert_eq!(policy.voice_bitrate, 96000);
    assert!(!network
        .state(outsider)
        .channel
        .rooms
        .iter()
        .any(|r| r.id == room));

    let unauthorized = network
        .authority
        .handle(outsider, patch(json!({"access":"public"})), 101);
    network.deliver(unauthorized);
    assert!(network.policy(&room).access == RoomAccess::Private);
    let clear =
        network
            .authority
            .handle(owner, patch(json!({"picture":null,"password":null})), 102);
    network.deliver(clear);
    let policy = network.policy(&room);
    assert!(
        !piik_channel_core::host::RoomSummary::from_policy(&policy).has_password
            && policy.appearance.picture.is_none()
    );
    assert!(policy.hidden);
    assert_eq!(policy.voice_bitrate, 96000);
}

#[test]
fn busy_room_retries_the_personal_limit_on_the_next_snapshot() {
    use piik_channel_core::{forwarding::ForwardingBudget, wire::Request};
    let mut network = RoomNetwork::new();
    let socket = Uuid::new_v4();
    let (session, _) = join(&mut network, socket, None);
    let room = network.create(socket, RoomAccess::Public, false);
    let mut pending = Vec::new();
    for _ in 0..64 {
        let request = Request::parse(&json!({"type":"browse","roomId":room,"active":true}).to_string()).unwrap();
        let effect = network.authority.handle(socket, request, 100);
        assert!(effect.events.iter().any(|(_, event)| matches!(event, Event::HostInput { .. })));
        pending.push(effect);
    }
    let mut budget = ForwardingBudget::default();
    let update = budget.capacity_updates(session, Some(1), network.state(socket)).into_iter()
        .find(|u| matches!(&u.command, piik_channel_core::wire::Command::RelayCapacity { room_id, .. } if room_id == &room)).unwrap();
    let refused = network.command(socket, serde_json::to_value(update).unwrap());
    let id = refused.events.iter().find_map(|(_, event)| match event {
        Event::Error { code, request_id } if code == "room_busy" => request_id.as_deref(),
        _ => None,
    }).unwrap();
    budget.capacity_reply(id);
    for effect in pending { network.deliver(effect); }
    for update in budget.capacity_updates(session, Some(1), network.state(socket)) {
        command(&mut network, socket, serde_json::to_value(update).unwrap());
    }
    assert_eq!(network.state(socket).channel.rooms.iter().find(|r| r.id == room).unwrap().relay_override, Some(1));
}

#[test]
fn watch_uses_an_alternate_while_a_file_keeps_the_relays_only_slot() {
    use piik_channel_core::forwarding::ForwardingBudget;
    let mut net = RoomNetwork::new();
    let [source, relay, alternate, viewer, reader] = [(); 5].map(|_| Uuid::new_v4());
    let [s, r, a, v, x] = [source, relay, alternate, viewer, reader].map(|socket| join(&mut net, socket, None).0);
    let room = net.create(source, RoomAccess::Public, false);
    let file_room = net.create(source, RoomAccess::Public, false);
    browse(&mut net, relay, &room, true);
    browse(&mut net, relay, &file_room, true);
    for (from, to, id) in [(source, relay, s), (relay, reader, r), (relay, viewer, r)] {
        warm_pair(&mut net, from, to, id);
    }
    let (seq,file) = offer_file(&mut net,source,&file_room,"watch-quota.bin");
    let receive = |enabled| json!({"type":"file_receive","roomId":file_room,"messageSeq":seq,"attachmentId":file.id,"enabled":enabled});
    command(&mut net,reader,receive(true));
    let initial = net.state(relay).clone();
    assert_eq!(initial.files.iter().find(|p|p.room_id==file_room).unwrap().downstream, [x]);
    let watch = Uuid::new_v4();
    let resource = Uuid::new_v4();
    let byte_source=json!({"sessionId":s,"resourceId":resource,"format":"file"});
    command(&mut net,source,json!({"type":"start_watch","roomId":room,"id":watch,
        "source":{"kind":"media","url":"https://example.com/movie.mp4"},
        "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":0},
        "byteSource":byte_source}));
    command(&mut net,viewer,json!({"type":"join_watch","roomId":room,"id":watch,"mode":"peer"}));
    let upstream = |net:&RoomNetwork| net.state(viewer).watch_bytes.iter().find(|p|p.activity_id==watch).unwrap().upstream;
    assert_eq!(upstream(&net),Some(r));
    browse(&mut net,alternate,&room,true);
    warm_pair(&mut net,source,alternate,s);
    warm_pair(&mut net,alternate,viewer,a);
    assert_eq!(upstream(&net),Some(r));
    let user=initial.sessions.iter().find(|p|p.id==r).unwrap().user_id;
    let mut budget=ForwardingBudget::default();
    assert!(budget.apply(Some(1),user,&mut initial.clone()).is_empty());
    let before=net.state(relay).clone();
    let commands=budget.apply(Some(1),user,&mut before.clone());
    assert_eq!(commands.len(),1);
    let refuse=serde_json::to_value(&commands[0]).unwrap();
    assert_eq!(refuse,json!({"type":"byte_branch_refused","roomId":room,"downstreamId":v,
        "target":{"kind":"watch","activityId":watch,"source":byte_source}}));
    command(&mut net,relay,refuse.clone());
    assert_eq!(upstream(&net),Some(a));
    assert_eq!(net.state(relay).files.iter().find(|p|p.room_id==file_room).unwrap().downstream, [x]);
    command(&mut net,reader,receive(false));
    let freed=net.state(relay).clone();
    let wakes=budget.apply(Some(1),user,&mut freed.clone());
    assert_eq!(wakes.len(),1);
    let wake=serde_json::to_value(&wakes[0]).unwrap();
    assert_eq!(wake,json!({"type":"forwarding_available","roomId":room,"kind":"file"}));
    command(&mut net,relay,wake);
    assert_eq!(upstream(&net),Some(a));
    let replacement=json!({"sessionId":s,"resourceId":Uuid::new_v4(),"format":"file"});
    command(&mut net,source,json!({"type":"set_watch_byte_source","roomId":room,"id":watch,"byteSource":replacement}));
    let late=net.command(relay,refuse);
    assert!(late.events.iter().any(|(_,event)| matches!(event, Event::RoomReply { result:piik_channel_core::host::RoomResult::Error{code}, .. } if code=="unassigned_watch_branch")));
}

#[test]
fn resuming_without_peer_transport_retires_media_and_file_routes_but_keeps_room_reading() {
    let mut net = RoomNetwork::new();
    let [owner, old, resumed] = [(); 3].map(|_| Uuid::new_v4());
    let (owner_id, _) = join(&mut net, owner, None);
    let (participant, credential) = join(&mut net, old, None);
    let room = net.create(owner, RoomAccess::Public, false);
    for socket in [owner, old] {
        browse(&mut net, socket, &room, true);
    }
    let link = pair(&net, old, owner_id).id;
    connect(&mut net, [owner, old], link);
    let picture = publish(&mut net, old, &room, "screen");
    subscribe_screen(&mut net, owner, picture);
    voice(&mut net, old, &room, true);
    let (seq, file) = offer_file(&mut net, old, &room, "sample.bin");
    command(&mut net, owner, json!({"type":"file_receive","roomId":room,
        "messageSeq":seq,"attachmentId":file.id,"enabled":true}));
    assert!(pair(&net, owner, participant).rooms.contains(&room));
    assert!(net.state(owner).files.iter().any(|plan| plan.upstream == Some(participant)));
    // The writer has already performed this operation against the previous endpoints.
    let request = |value: Value| piik_channel_core::wire::Request::parse(&value.to_string()).unwrap();
    let browse_turn = net.authority.handle(owner, request(json!({"type":"browse","roomId":room,
        "active":true,"requestId":"pending-browse"})), 100);
    let input = browse_turn.events.into_iter().find_map(|(_, event)| match event {
        Event::HostInput { input, .. } => Some(input),
        _ => None,
    }).unwrap();
    let old_output = net.host_turn(&room, input);
    assert!(old_output.projection.relay_session_ids.contains(&participant));
    let sync = net.authority.handle(resumed, request(json!({"type":"join","name":"Same reader",
        "credential":credential,"protocol":piik_channel_core::wire::CHANNEL_PROTOCOL,"sessionId":participant,
        "signingKey":piik_channel_core::conversation::SessionSigner::from_seed([1;32]).signing_key()})), 101);
    let pending = net.authority.handle(owner, request(json!({"type":"host_output","roomId":room,"output":old_output})), 101);
    assert!(!pending.events.iter().any(|(_, event)| matches!(event, Event::Error { .. } | Event::RoomReply { .. })));
    net.deliver(pending);
    let effects = net.deliver(sync);
    assert_eq!(effects.events.iter().filter(|(socket, event)| *socket == owner && matches!(event,
        Event::RoomReply {request_id: Some(id), result: piik_channel_core::host::RoomResult::Done, ..} if id == "pending-browse")).count(), 1);
    assert!(effects.events.iter().any(|(socket, event)| *socket == resumed
        && matches!(event, Event::Welcome {session_id, state, ..} if *session_id == participant && state.pairs.is_empty())));
    for socket in [resumed, owner] {
        let state = net.state(socket);
        assert!(state.pairs.is_empty());
        assert!(state.publications.iter().all(|p| p.session_id != participant));
        assert!(state.voice.iter().all(|v| v.session_id != participant));
        assert!(state.files.iter().all(|f| f.upstream.is_none() && f.downstream.is_empty() && f.source_id.is_none()));
        assert!(state.channel.rooms.iter().any(|r| r.id == room && r.authorized && r.reading));
    }
    assert!(net.peer_request(resumed, &room, ConversationCommand::History { before: None }).result.is_ok());
}
