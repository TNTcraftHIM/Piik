#![cfg(feature = "sqlite")]

mod support;
use piik_channel_core::{
    conversation::ConversationCommand,
    host::{RoomResult, ServiceEndpoint, ServiceTransit, TransitKinds},
    wire::{AudienceState, Event, PairInfo, RoomAccess},
    Effects,
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;

fn accepted(effects: Effects) {
    assert!(
        !effects.events.iter().any(|(_, event)| matches!(
            event,
            Event::Error { .. }
                | Event::RoomReply {
                    result: RoomResult::Error { .. },
                    ..
                }
        )),
        "{}",
        serde_json::to_string(&effects.events).unwrap()
    );
}

fn command(net: &mut RoomNetwork, connection: Uuid, value: Value) {
    accepted(net.command(connection, value));
}

fn join(net: &mut RoomNetwork, connection: Uuid, operator: bool) -> Uuid {
    net.command(
        connection,
        json!({"type":"join","name":"Fixture endpoint",
        "ownerKey":operator.then_some("owner")}),
    )
    .events
    .into_iter()
    .find_map(|(_, event)| match event {
        Event::Welcome { session_id, .. } => Some(session_id),
        _ => None,
    })
    .unwrap()
}

const ALL_KINDS: TransitKinds = TransitKinds { screen: true, voice: true, files: true };

fn register_service(net: &mut RoomNetwork, session: Option<Uuid>) -> Result<Effects, &'static str> {
    register_service_kinds(net, session, ALL_KINDS)
}

fn register_service_kinds(
    net: &mut RoomNetwork,
    session: Option<Uuid>,
    kinds: TransitKinds,
) -> Result<Effects, &'static str> {
    let endpoint = session
        .map(|session_id| {
            net.authority
                .current_connection(session_id)
                .map(|connection_id| ServiceTransit {
                    endpoint: ServiceEndpoint { session_id, connection_id },
                    kinds,
                })
                .ok_or("service_unavailable")
        })
        .transpose()?;
    net.authority.set_service_endpoint(endpoint)
}

fn private_room(net: &mut RoomNetwork, host: Uuid, viewer: Uuid) -> String {
    let room = net.create(host, RoomAccess::Private, true);
    let invite = net
        .command(host, json!({"type":"room_invite","roomId":room}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::RoomReply { result: piik_channel_core::host::RoomResult::Invite { key }, .. } => Some(key),
            _ => None,
        })
        .unwrap();
    command(
        net,
        viewer,
        json!({"type":"enter_room","roomId":room,"inviteKey":invite}),
    );
    room
}

fn preference(net: &RoomNetwork, room: &str, enabled: bool) -> Value {
    let policy = net.policy(room);
    json!({"type":"update_room","roomId":room,"name":policy.name,"icon":policy.appearance.icon,
        "access":policy.access,"hidden":policy.hidden,"allowServiceRelay":enabled})
}

fn set_preference(net: &mut RoomNetwork, host: Uuid, room: &str, enabled: bool) {
    let request = preference(net, room, enabled);
    command(net, host, request);
}

fn pair(net: &RoomNetwork, connection: Uuid, peer: Uuid) -> PairInfo {
    net.state(connection)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == peer)
        .unwrap()
        .clone()
}

fn assert_no_payload(net: &RoomNetwork, socket: Uuid) {
    assert!(net
        .state(socket)
        .pairs
        .iter()
        .all(|p| p.rooms.is_empty() && p.incoming.is_empty() && p.outgoing.is_empty()));
}

fn confirm_hop(net: &mut RoomNetwork, endpoints: [Uuid; 2], pair_id: Uuid) {
    for socket in endpoints {
        assert!(net
            .state(socket)
            .pairs
            .iter()
            .any(|pair| pair.id == pair_id));
        command(
            net,
            socket,
            json!({"type":"link_state","pairId":pair_id,"state":"connected"}),
        );
    }
}

fn acknowledge_hop(net: &mut RoomNetwork, endpoints: [Uuid; 2], pair_id: Uuid, room: &str) {
    for socket in endpoints {
        assert!(net
            .state(socket)
            .pairs
            .iter()
            .any(|p| p.id == pair_id && p.rooms.iter().any(|r| r == room)));
        command(
            net,
            socket,
            json!({"type":"room_data_state","roomId":room,"pairId":pair_id,"ready":true}),
        );
    }
}

fn confirm_service_path(net: &mut RoomNetwork, service: Uuid, host: Uuid, viewer: Uuid) {
    let mut pending = vec![host, viewer];
    while !pending.is_empty() {
        let (index, pair_id) = pending
            .iter()
            .enumerate()
            .find_map(|(index, socket)| {
                net.state(*socket).pairs.iter().find_map(|pair| {
                    net.state(service)
                        .pairs
                        .iter()
                        .any(|other| other.id == pair.id)
                        .then_some((index, pair.id))
                })
            })
            .expect("channel assigned the next service hop to both endpoints");
        let peer = pending.swap_remove(index);
        confirm_hop(net, [service, peer], pair_id);
    }
}

fn screen(net: &mut RoomNetwork, host: Uuid, viewer: Uuid, room: &str) -> Uuid {
    let id = Uuid::new_v4();
    command(
        net,
        host,
        json!({"type":"publish","publication":{"id":id,"roomId":room,
        "kind":"screen","source":{"kind":"screen","name":"Private source title"},
        "videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},
        "maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}}),
    );
    command(
        net,
        viewer,
        json!({"type":"subscribe","publicationId":id,"enabled":true}),
    );
    id
}

fn start_peer_watch(
    net: &mut RoomNetwork,
    host: Uuid,
    viewer: Uuid,
    room: &str,
    source: Uuid,
) -> Uuid {
    let activity = Uuid::new_v4();
    command(
        net,
        host,
        json!({"type":"start_watch","roomId":room,"id":activity,
        "source":{"kind":"media","url":"https://example.com/private.mp4"},
        "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":100},
        "byteSource":{"sessionId":source,"resourceId":Uuid::new_v4(),"format":"file"}}),
    );
    command(
        net,
        viewer,
        json!({"type":"join_watch","roomId":room,"id":activity,"mode":"peer"}),
    );
    activity
}

fn topology(
    net: &mut RoomNetwork,
    host: Uuid,
    room: &str,
) -> piik_channel_core::topology::RoomTopology {
    net.command(host, json!({"type":"room_topology","roomId":room}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::RoomReply {
                result: RoomResult::Topology { topology },
                ..
            } => Some(topology),
            _ => None,
        })
        .unwrap()
}

fn bridge(
    net: &mut RoomNetwork,
    host: Uuid,
    viewer: Uuid,
    service: Uuid,
    source: Uuid,
    relay: Uuid,
    room: &str,
    expect_direct_attempt: bool,
) -> Uuid {
    set_preference(net, host, room, true);
    let picture = screen(net, host, viewer, room);
    if expect_direct_attempt {
        let direct = pair(net, viewer, source);
        assert!(direct.incoming.is_empty());
        command(
            net,
            viewer,
            json!({"type":"link_state","pairId":direct.id,"state":"failed"}),
        );
        confirm_service_path(net, service, host, viewer);
    } else {
        assert!(net
            .state(viewer)
            .pairs
            .iter()
            .all(|pair| pair.peer_id != source));
    }
    prove_service_screen(net, viewer, service, source, relay, picture);
    assert_eq!(topology(net, host, room).transit_session, Some(relay));
    picture
}

fn prove_service_screen(
    net: &mut RoomNetwork,
    viewer: Uuid,
    service: Uuid,
    source: Uuid,
    relay: Uuid,
    picture: Uuid,
) {
    let input = pair(net, service, source);
    let input_flow = input
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .expect("confirmed service upstream has the screen input")
        .id;
    command(
        net,
        service,
        json!({"type":"flow_state","pairId":input.id,"flowId":input_flow,"state":"forwardable"}),
    );
    let output = pair(net, viewer, relay);
    let incoming = output
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .expect("forwardable screen has a service output to the viewer");
    assert_eq!(incoming.input_flow_id, Some(input_flow));
    command(
        net,
        viewer,
        json!({"type":"flow_state","pairId":output.id,"flowId":incoming.id,"state":"decoded"}),
    );
    assert!(pair(net, viewer, relay)
        .incoming
        .iter()
        .any(|flow| flow.id == incoming.id && flow.selected));
    assert!(net.state(viewer).publications.iter().any(|publication| {
        publication.id == picture
            && publication
                .audience
                .iter()
                .any(|viewer| viewer.state == AudienceState::Active)
    }));
}

#[test]
fn exact_service_lease_carries_assigned_media_and_bytes_without_room_read() {
    let mut net = RoomNetwork::new();
    let [host, viewer, service, operator_page] = std::array::from_fn(|_| Uuid::new_v4());
    let source = join(&mut net, host, false);
    let destination = join(&mut net, viewer, false);
    let relay = join(&mut net, service, true);
    join(&mut net, operator_page, true);
    let room = private_room(&mut net, host, viewer);
    let mut policy = serde_json::to_value(net.policy(&room)).unwrap();
    policy["allowServiceRelay"] = json!(true);
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    for outsider in [viewer, operator_page] {
        let request = preference(&net, &room, true);
        let denied = net.command(outsider, request);
        let expected = if outsider == viewer {
            "forbidden"
        } else {
            "room_unavailable"
        };
        assert!(
            denied.events.iter().any(|(_, event)| matches!(event,
            Event::Error { code, .. } if code == expected)
                || matches!(event,
            Event::RoomReply { result: RoomResult::Error { code }, .. } if code == expected)),
            "{}",
            serde_json::to_string(&denied.events).unwrap()
        );
    }
    set_preference(&mut net, host, &room, true);
    assert_no_payload(&net, service);
    assert_eq!(
        topology(&mut net, host, &room).transit_session,
        None,
        "permission alone must not be projected as a live forwarding lease"
    );
    let picture = bridge(&mut net, host, viewer, service, source, relay, &room, true);
    let room_view = net
        .state(host)
        .channel
        .rooms
        .iter()
        .find(|value| value.id == room)
        .unwrap();
    assert!(!room_view.participant_session_ids.contains(&relay));

    for connection in [host, viewer] {
        command(
            &mut net,
            connection,
            json!({"type":"voice","roomId":room,"joined":true,
            "muted":true,"deafened":false}),
        );
    }
    let voice = Uuid::new_v4();
    command(
        &mut net,
        host,
        json!({"type":"publish","publication":{"id":voice,"roomId":room,"kind":"voice"}}),
    );
    assert!(pair(&net, service, source)
        .incoming
        .iter()
        .any(|flow| flow.publication_id == voice));
    assert!(pair(&net, service, destination)
        .outgoing
        .iter()
        .any(|flow| flow.publication_id == voice));
    assert!(net.state(service).voice.is_empty());

    let attachment = piik_channel_core::AttachmentDescriptor {
        id: Uuid::new_v4(),
        name: "shared.bin".into(),
        size: 3,
        media_type: "application/octet-stream".into(),
        sha256: piik_channel_core::attachment::sha256_hex(b"abc"),
    };
    assert!(net
        .peer_request(
            host,
            &room,
            ConversationCommand::Chat {
                mentions: vec![],
                reply: None,
                inline_images: Default::default(),
                text: "Private history".into(),
                nonce: "attachment".into(),
                attachments: vec![attachment.clone()],
            }
        )
        .result
        .is_ok());
    command(
        &mut net,
        host,
        json!({"type":"file_offer","roomId":room,"messageSeq":1,
        "attachmentId":attachment.id,"sha256":attachment.sha256,"available":true}),
    );
    command(
        &mut net,
        viewer,
        json!({"type":"file_receive","roomId":room,"messageSeq":1,
        "attachmentId":attachment.id,"enabled":true}),
    );
    let up = pair(&net, service, source).id;
    let down = pair(&net, service, destination).id;
    acknowledge_hop(&mut net, [host, service], up, &room);
    acknowledge_hop(&mut net, [service, viewer], down, &room);
    let file = &net.state(service).files[0];
    assert_eq!(file.upstream, Some(source));
    assert_eq!(file.downstream, vec![destination]);
    assert!(!file.receiving);
    let activity = &net
        .state(host)
        .channel
        .rooms
        .iter()
        .find(|value| value.id == room)
        .unwrap()
        .file_activity;
    assert_eq!(activity.len(), 2);
    assert!(activity
        .iter()
        .any(|value| value.session_id == source && value.sending && !value.receiving));
    assert!(activity
        .iter()
        .any(|value| value.session_id == destination && value.receiving && !value.sending));
    assert!(
        !activity.iter().any(|value| value.session_id == relay),
        "forwarding is not a personal file operation"
    );

    command(&mut net, service, json!({"type":"byte_branch_refused","roomId":room,"downstreamId":destination,
        "target":{"kind":"file","messageSeq":1,"attachmentId":attachment.id,"sourceId":source}}));
    assert!(net.state(service).files.is_empty());
    command(&mut net, service, json!({"type":"forwarding_available","roomId":room,"kind":"file"}));
    assert_eq!(net.state(service).files[0].downstream, [destination]);

    let activity = start_peer_watch(&mut net, host, viewer, &room, source);
    let bytes = &net.state(service).watch_bytes[0];
    assert_eq!(bytes.upstream, Some(source));
    assert_eq!(bytes.downstream, vec![destination]);
    assert!(!bytes.receiving);
    assert!(net.state(service).watch_activities.is_empty());
    assert!(net.state(service).watch_subscriptions.is_empty());

    let supplied = net
        .state(service)
        .publications
        .iter()
        .find(|p| p.id == picture)
        .unwrap();
    assert!(supplied.audience.is_empty());
    assert!(supplied.screen.as_ref().unwrap().source.name.is_none());
    for connection in [service, operator_page] {
        assert!(net
            .state(connection)
            .channel
            .rooms
            .iter()
            .all(|entry| entry.id != room));
        assert!(net
            .peer_request(
                connection,
                &room,
                ConversationCommand::History { before: None }
            )
            .result
            .is_err());
        assert!(net
            .peer_request(
                connection,
                &room,
                ConversationCommand::Chat {
                    mentions: vec![],
                    reply: None,
                    inline_images: Default::default(),
                    text: "Denied".into(),
                    nonce: "denied".into(),
                    attachments: vec![],
                }
            )
            .result
            .is_err());
    }
    assert!(net.state(operator_page).publications.is_empty());
    assert!(net.state(operator_page).files.is_empty());
    assert!(net.state(operator_page).watch_bytes.is_empty());
    assert_no_payload(&net, operator_page);
    for denied in [
        json!({"type":"browse","roomId":room,"active":true}),
        json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":"voice"}}),
        json!({"type":"subscribe","publicationId":picture,"enabled":true}),
        json!({"type":"file_receive","roomId":room,"messageSeq":1,"attachmentId":attachment.id,"enabled":true}),
        json!({"type":"join_watch","roomId":room,"id":activity,"mode":"peer"}),
    ] {
        assert!(net.command(service, denied).events.iter().any(|(_, event)| matches!(event,
            Event::RoomReply { result: RoomResult::Error { code }, .. } if code == "room_unavailable"
        )));
    }
    assert_eq!(
        serde_json::to_value(net.policy(&room)).unwrap(),
        policy,
        "temporary service work never grants its user lasting room membership"
    );

    command(
        &mut net,
        viewer,
        json!({"type":"subscribe","publicationId":picture,"enabled":false}),
    );
    assert!(!net
        .state(service)
        .publications
        .iter()
        .any(|p| p.id == picture));
    assert_eq!(net.state(service).files.len(), 1);
    command(
        &mut net,
        viewer,
        json!({"type":"file_receive","roomId":room,"messageSeq":1,
        "attachmentId":attachment.id,"enabled":false}),
    );
    command(
        &mut net,
        viewer,
        json!({"type":"join_watch","roomId":room,"id":activity,"mode":null}),
    );
    for connection in [host, viewer] {
        command(
            &mut net,
            connection,
            json!({"type":"voice","roomId":room,"joined":false,
            "muted":true,"deafened":true}),
        );
    }
    assert!(net.state(service).files.is_empty());
    assert!(net.state(service).watch_bytes.is_empty());
    assert_eq!(topology(&mut net, host, &room).transit_session, None);
    assert_no_payload(&net, service);
    let idle = pair(&net, service, source);
    let idle_id = idle.id;
    let idle_socket = host;
    let ordinary_room = private_room(&mut net, service, idle_socket);
    let ordinary_screen = screen(&mut net, service, idle_socket, &ordinary_room);
    let reused = pair(&net, idle_socket, relay);
    assert_eq!(reused.id, idle_id);
    let flow = reused
        .incoming
        .iter()
        .find(|flow| flow.publication_id == ordinary_screen)
        .expect("the authorized screen immediately uses the confirmed pair");
    command(
        &mut net,
        idle_socket,
        json!({"type":"flow_state","pairId":idle_id,"flowId":flow.id,"state":"decoded"}),
    );
    command(
        &mut net,
        idle_socket,
        json!({"type":"subscribe","publicationId":ordinary_screen,"enabled":false}),
    );

    set_preference(&mut net, host, &room, false);
    assert_no_payload(&net, service);
    assert_eq!(topology(&mut net, host, &room).transit_session, None);
}

#[test]
fn public_owner_opt_in_readback_distinguishes_availability_selection_and_work() {
    let mut net = RoomNetwork::new();
    let [host, viewer, service] = std::array::from_fn(|_| Uuid::new_v4());
    join(&mut net, host, false);
    join(&mut net, viewer, false);
    let relay = join(&mut net, service, true);
    let room = private_room(&mut net, host, viewer);
    let projected = |net: &RoomNetwork, connection| {
        let row = net
            .state(connection)
            .channel
            .rooms
            .iter()
            .find(|row| row.id == room)?;
        row.service_relay
            .map(|relay| (relay.enabled, relay.available))
    };
    // A new room uses the service once the site offers it.
    assert_eq!(projected(&net, host), Some((true, false)));
    assert_eq!(projected(&net, viewer), None);
    let policy = serde_json::to_value(net.policy(&room)).unwrap();
    assert!(!topology(&mut net, host, &room).service_available);
    set_preference(&mut net, host, &room, true);
    let saved = topology(&mut net, host, &room);
    assert!(!saved.service_available && saved.service_enabled && saved.transit_session.is_none());
    set_preference(&mut net, host, &room, false);
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    let state = topology(&mut net, host, &room);
    assert!(state.service_available && !state.service_enabled && state.transit_session.is_none());
    let request = preference(&net, &room, true);
    let denied = net.command(viewer, request);
    assert!(denied.events.iter().any(|(_, event)| matches!(event, Event::RoomReply { result: RoomResult::Error { code }, .. } if code == "forbidden")));
    set_preference(&mut net, host, &room, true);
    let state = topology(&mut net, host, &room);
    assert_eq!(projected(&net, host), Some((true, true)));
    assert_eq!(projected(&net, viewer), None);
    assert!(state.service_available && state.service_enabled && state.transit_session.is_none());
    assert_no_payload(&net, service);
    assert!(net.policy(&room).allow_service_relay);
    assert_eq!(
        serde_json::to_value(net.policy(&room)).unwrap()["grants"],
        policy["grants"]
    );
    set_preference(&mut net, host, &room, false);
    assert!(!topology(&mut net, host, &room).service_enabled);
    let effects = register_service(&mut net, None).unwrap();
    accepted(net.deliver(effects));
    assert!(!topology(&mut net, host, &room).service_available);
}

#[test]
fn transit_retirement_keeps_other_room_leases_and_rejects_old_service_outputs() {
    let mut net = RoomNetwork::new();
    let [host, viewer, service, successor] = std::array::from_fn(|_| Uuid::new_v4());
    let source = join(&mut net, host, false);
    let destination = join(&mut net, viewer, false);
    let relay = join(&mut net, service, true);
    let room = private_room(&mut net, host, viewer);
    set_preference(&mut net, host, &room, true);
    let unavailable = topology(&mut net, host, &room);
    assert!(unavailable.service_enabled && !unavailable.service_available);
    assert_eq!(unavailable.transit_session, None);
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    let first = bridge(&mut net, host, viewer, service, source, relay, &room, true);
    let shared_upstream = pair(&net, service, source).id;
    let shared_downstream = pair(&net, service, destination).id;
    let second_room = private_room(&mut net, host, viewer);
    let second = bridge(
        &mut net,
        host,
        viewer,
        service,
        source,
        relay,
        &second_room,
        false,
    );
    let sibling_watch = start_peer_watch(&mut net, host, viewer, &second_room, source);
    assert_eq!(pair(&net, service, source).id, shared_upstream);
    assert_eq!(pair(&net, service, destination).id, shared_downstream);
    let old_input = pair(&net, service, source)
        .incoming
        .into_iter()
        .find(|flow| flow.publication_id == first)
        .unwrap();
    let sibling_flow = pair(&net, service, destination)
        .outgoing
        .into_iter()
        .find(|flow| flow.publication_id == second)
        .unwrap();
    // The host commits this earlier On, but its confirmation/projection is delayed.
    let mut allow = preference(&net, &room, true);
    allow["requestId"] = json!("delayed-allow");
    let held = net.authority.handle(
        host,
        piik_channel_core::wire::Request::parse(&allow.to_string()).unwrap(),
        100,
    );
    let input = held
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let old_allow = net.host_turn(&room, input);
    assert_eq!(
        old_allow.projection.views[&relay]
            .transit_endpoint
            .map(|endpoint| (endpoint.session_id, endpoint.connection_id)),
        Some((relay, service))
    );
    let mut off = preference(&net, &room, false);
    off["requestId"] = json!("committed-off");
    let stopped = net.command(host, off);
    assert!(stopped.events.iter().any(|(_, event)| matches!(event,
        Event::RoomReply { request_id: Some(id), result: RoomResult::Done, .. }
            if id == "committed-off"
    )));
    accepted(stopped);
    assert!(!net.policy(&room).allow_service_relay);

    let delayed = net.command(
        host,
        json!({"type":"host_output","roomId":room,"output":old_allow}),
    );
    assert!(delayed.events.iter().any(|(_, event)| matches!(event,
        Event::RoomReply { request_id: Some(id), result: RoomResult::Done, .. }
            if id == "delayed-allow"
    )));
    accepted(delayed);
    // A still-live physical pair is not consent to restore a retired room flow.
    command(
        &mut net,
        service,
        json!({"type":"link_state","pairId":shared_upstream,"state":"connected"}),
    );
    command(
        &mut net,
        service,
        json!({"type":"flow_state","pairId":shared_upstream,"flowId":old_input.id,"state":"forwardable"}),
    );
    let stopped = topology(&mut net, host, &room);
    assert!(!stopped.service_enabled && stopped.service_available);
    assert_eq!(stopped.transit_session, None);
    assert!(!net.policy(&room).allow_service_relay);
    assert_eq!(pair(&net, service, source).id, shared_upstream);
    let retained = pair(&net, service, destination);
    assert_eq!(retained.id, shared_downstream);
    assert_eq!(
        serde_json::to_value(
            retained
                .outgoing
                .iter()
                .find(|flow| flow.publication_id == second)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(sibling_flow).unwrap(),
        "late On confirmation and retired flow proof must preserve the sibling lease",
    );
    assert!(!retained.rooms.contains(&room));
    assert!(retained.rooms.contains(&second_room));
    assert!(net.state(service).watch_bytes.iter().any(|plan| {
        plan.activity_id == sibling_watch
            && plan.upstream == Some(source)
            && plan.downstream == [destination]
    }));
    assert!(!retained
        .outgoing
        .iter()
        .any(|flow| flow.publication_id == first));
    assert!(retained
        .outgoing
        .iter()
        .any(|flow| flow.publication_id == second));
    assert_eq!(topology(&mut net, host, &room).transit_session, None);

    let request =
        piik_channel_core::wire::Request::parse(&preference(&net, &second_room, true).to_string())
            .unwrap();
    let held = net.authority.handle(host, request, 100);
    let input = held
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let old_output = net.host_turn(&second_room, input);
    let replacement = join(&mut net, successor, true);
    let effects = register_service(&mut net, Some(replacement)).unwrap();
    accepted(net.deliver(effects));
    accepted(net.command(
        host,
        json!({"type":"host_output","roomId":second_room,"output":old_output}),
    ));
    assert_no_payload(&net, service);
    assert!(net.policy(&second_room).allow_service_relay);
    assert!(net
        .state(service)
        .channel
        .rooms
        .iter()
        .all(|entry| entry.id != second_room));
    assert!(net
        .state(successor)
        .channel
        .rooms
        .iter()
        .all(|entry| entry.id != second_room));
    assert!(topology(&mut net, host, &second_room).service_enabled);
    assert!(topology(&mut net, host, &second_room).service_available);

    // Saved consent selects the current registered endpoint without another write.
    confirm_service_path(&mut net, successor, host, viewer);
    prove_service_screen(&mut net, viewer, successor, source, replacement, second);
    let current = topology(&mut net, host, &second_room);
    assert_eq!(current.transit_session, Some(replacement));
    let delivered = pair(&net, viewer, replacement)
        .incoming
        .into_iter()
        .find(|flow| flow.publication_id == second)
        .unwrap()
        .id;
    command(
        &mut net,
        host,
        json!({"type":"host_stop","roomId":second_room,"bindingId":current.binding_id}),
    );
    assert_no_payload(&net, successor);
    let summary = piik_channel_core::host::RoomSummary::from_policy(&net.policy(&second_room));
    command(
        &mut net,
        host,
        json!({"type":"host_register","room":summary}),
    );
    let restarted = topology(&mut net, host, &second_room);
    assert_ne!(restarted.binding_id, current.binding_id);
    assert!(restarted.service_enabled);
    assert!(net.state(viewer).subscriptions.contains(&second));
    let current_publication = net
        .state(viewer)
        .publications
        .iter()
        .find(|p| p.id == second)
        .unwrap();
    assert!(current_publication
        .audience
        .iter()
        .all(|watcher| watcher.state != AudienceState::Active));
    assert!(net
        .state(viewer)
        .pairs
        .iter()
        .flat_map(|p| &p.incoming)
        .all(|flow| flow.id != delivered));
    let operator_user = net
        .state(successor)
        .sessions
        .iter()
        .find(|s| s.id == replacement)
        .unwrap()
        .user_id;
    assert!(!net.policy(&room).reads(operator_user));
    assert!(!net.policy(&second_room).reads(operator_user));
}

#[test]
fn channel_rejects_service_work_of_a_kind_its_operator_turned_off() {
    let mut net = RoomNetwork::new();
    let [host, viewer, service] = std::array::from_fn(|_| Uuid::new_v4());
    let source = join(&mut net, host, false);
    join(&mut net, viewer, false);
    let relay = join(&mut net, service, true);
    let room = private_room(&mut net, host, viewer);
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    bridge(&mut net, host, viewer, service, source, relay, &room, true);
    let screen_off = TransitKinds { screen: false, ..ALL_KINDS };
    let effects = register_service_kinds(&mut net, Some(relay), screen_off).unwrap();
    let mut rejected = false;
    for (connection, event) in effects.events {
        if let Event::HostInput { room_id, mut input } = event {
            // A host that ignores the operator keeps the service on the screen path.
            input.service_endpoint.as_mut().unwrap().kinds = ALL_KINDS;
            let output = net.host_turn(&room_id, input);
            let request = json!({"type":"host_output","roomId":room_id,"output":output});
            let request = piik_channel_core::wire::Request::parse(&request.to_string()).unwrap();
            let reply = net.authority.handle(connection, request, 100);
            rejected |= reply.events.iter().any(|(_, event)| {
                matches!(event, Event::Error { code, .. } if code == "invalid_room_projection")
            });
        }
    }
    assert!(rejected);
}

#[test]
fn a_service_that_offers_no_kind_reads_as_unavailable() {
    let mut net = RoomNetwork::new();
    let [host, viewer, service] = std::array::from_fn(|_| Uuid::new_v4());
    join(&mut net, host, false);
    join(&mut net, viewer, false);
    let relay = join(&mut net, service, true);
    let room = private_room(&mut net, host, viewer);
    let offer = |net: &mut RoomNetwork, kinds| {
        let effects = register_service_kinds(net, Some(relay), kinds).unwrap();
        accepted(net.deliver(effects));
        let state = net.state(host);
        let row = state.channel.rooms.iter().find(|row| row.id == room);
        let projected = row.and_then(|row| row.service_relay).map(|relay| relay.available);
        (projected, topology(net, host, &room).service_available)
    };
    // The master switch is on, and the operator turned every kind off.
    let none = TransitKinds { screen: false, voice: false, files: false };
    assert_eq!(offer(&mut net, none), (Some(false), false));
    let voice = TransitKinds { voice: true, ..none };
    assert_eq!(offer(&mut net, voice), (Some(true), true));
}

#[test]
fn public_read_grants_the_registered_server_no_participant_role() {
    let mut net = RoomNetwork::new();
    let [host, service] = std::array::from_fn(|_| Uuid::new_v4());
    join(&mut net, host, false);
    let session_id = join(&mut net, service, true);
    let room = net.create(host, RoomAccess::Public, false);
    net.authority.set_room_writer(ServiceEndpoint { session_id, connection_id: service }).unwrap();

    // The local room fixture generates an ordinary public reader's projection.
    // The authority knows this socket belongs to the Server with forwarding off.
    let reply = net.command(service, json!({"type":"browse","roomId":room,"active":true}));
    assert!(reply.events.iter().any(|(_, event)| matches!(event,
        Event::Error { code, .. } if code == "invalid_room_projection"
    )));
    let state = net.state(host);
    let view = state.channel.rooms.iter().find(|view| view.id == room).unwrap();
    assert!(!view.participant_session_ids.contains(&session_id));
}

#[test]
fn public_read_alone_does_not_keep_withdrawn_service_work() {
    let mut net = RoomNetwork::new();
    let [host, viewer, service, operator_page] = std::array::from_fn(|_| Uuid::new_v4());
    let source = join(&mut net, host, false);
    join(&mut net, viewer, false);
    let relay = join(&mut net, service, true);
    net.authority.set_room_writer(ServiceEndpoint { session_id: relay, connection_id: service }).unwrap();
    let person = join(&mut net, operator_page, true);
    let room = net.create(host, RoomAccess::Public, false);
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    let picture = bridge(&mut net, host, viewer, service, source, relay, &room, true);
    let retired_pairs: Vec<_> = net
        .state(service)
        .pairs
        .iter()
        .map(|pair| pair.id)
        .collect();
    let effects = register_service(&mut net, None).unwrap();
    let states: Vec<_> = effects
        .events
        .iter()
        .filter_map(|(_, event)| match event {
            Event::State { state } => Some(state),
            _ => None,
        })
        .collect();
    assert!(!states.is_empty());
    assert!(
        states.iter().all(|state| state
            .pairs
            .iter()
            .all(|pair| !retired_pairs.contains(&pair.id)
                || (pair.rooms.is_empty()
                    && pair.incoming.is_empty()
                    && pair.outgoing.is_empty()))),
        "the domain must withdraw service grants before the room host replies"
    );
    accepted(net.deliver(effects));
    assert!(net.state(service).pairs.iter().all(|pair| {
        !pair.rooms.contains(&room)
            && pair
                .incoming
                .iter()
                .chain(&pair.outgoing)
                .all(|flow| flow.publication_id != picture)
    }));
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    confirm_service_path(&mut net, service, host, viewer);
    prove_service_screen(&mut net, viewer, service, source, relay, picture);
    assert!(net.state(service).pairs.iter().any(|pair| {
        pair.incoming
            .iter()
            .chain(&pair.outgoing)
            .any(|flow| flow.publication_id == picture)
    }));
    set_preference(&mut net, host, &room, false);
    assert!(net
        .state(service)
        .pairs
        .iter()
        .all(|pair| !pair.rooms.contains(&room)));
    let service_room = net
        .state(service)
        .channel
        .rooms
        .iter()
        .find(|value| value.id == room)
        .unwrap();
    assert!(
        service_room.authorized,
        "the room setting does not revoke public Read"
    );
    assert!(!service_room.participant_session_ids.contains(&relay));
    command(
        &mut net,
        operator_page,
        json!({"type":"voice","roomId":room,
        "joined":true,"muted":true,"deafened":true}),
    );
    let participant = net
        .state(host)
        .channel
        .rooms
        .iter()
        .find(|value| value.id == room)
        .unwrap();
    assert!(participant.participant_session_ids.contains(&person));
    assert!(
        !participant.participant_session_ids.contains(&relay),
        "the same user's real Browser stays distinct from pure service work"
    );
    let hosted = net.create(service, RoomAccess::Public, false);
    let own_screen = screen(&mut net, service, viewer, &hosted);
    let own_pair = pair(&net, viewer, relay).id;
    confirm_hop(&mut net, [service, viewer], own_pair);
    let effects = register_service(&mut net, None).unwrap();
    accepted(net.deliver(effects));
    let retained = pair(&net, viewer, relay);
    assert_eq!(retained.id, own_pair);
    assert!(retained
        .incoming
        .iter()
        .any(|flow| flow.publication_id == own_screen));
}

#[test]
fn service_socket_reconnect_cannot_revive_a_lease_even_when_host_missed_disconnect() {
    let mut net = RoomNetwork::new();
    let [host, viewer, service, resumed_host, resumed_service] =
        std::array::from_fn(|_| Uuid::new_v4());
    let (source, credential) = net
        .command(host, json!({"type":"join","name":"Browser host"}))
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
    join(&mut net, viewer, false);
    let relay = join(&mut net, service, true);
    let room = private_room(&mut net, host, viewer);

    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    let picture = bridge(&mut net, host, viewer, service, source, relay, &room, true);
    let original_policy = serde_json::to_value(net.policy(&room)).unwrap();
    let prior = pair(&net, viewer, relay);
    let old_flow = prior
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .unwrap()
        .id;
    let original_binding = topology(&mut net, host, &room).binding_id;

    // RoomHost misses the service's disconnected input, as happens while its page reconnects.
    let effects = net.authority.disconnect(host, 101);
    accepted(net.deliver(effects));
    let effects = net.authority.disconnect(service, 102);
    assert!(!effects
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::HostInput { .. })));
    accepted(net.deliver(effects));
    for pair in net
        .state(viewer)
        .pairs
        .iter()
        .filter(|pair| pair.peer_id == relay)
    {
        assert!(pair.rooms.is_empty() && pair.incoming.is_empty() && pair.outgoing.is_empty());
    }
    assert!(matches!(
        register_service(&mut net, Some(relay)),
        Err("service_unavailable")
    ));

    let resumed = net.command_at(
        resumed_service,
        json!({"type":"join","name":"Server resumed","ownerKey":"owner","sessionId":relay}),
        103,
    );
    assert!(resumed.events.iter().any(|(_, event)| matches!(event,
        Event::Welcome { session_id, .. } if *session_id == relay)));
    assert!(
        matches!(
            net.authority.set_service_endpoint(Some(ServiceTransit {
                endpoint: ServiceEndpoint { session_id: relay, connection_id: service },
                kinds: ALL_KINDS,
            })),
            Err("service_unavailable")
        ),
        "a delayed old Welcome cannot register the replacement socket"
    );
    assert_no_payload(&net, resumed_service);
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    assert_no_payload(&net, resumed_service);

    net.host_connection(&room, resumed_host);
    command(
        &mut net,
        resumed_host,
        json!({"type":"join","name":"Browser host","credential":credential,"sessionId":source}),
    );
    let summary = piik_channel_core::host::RoomSummary::from_policy(&net.policy(&room));
    command(
        &mut net,
        resumed_host,
        json!({"type":"host_register","room":summary,"resumeBinding":original_binding}),
    );
    let restored = topology(&mut net, resumed_host, &room);
    assert_eq!(restored.binding_id, original_binding);
    assert!(restored.service_enabled);
    command(
        &mut net,
        viewer,
        json!({"type":"flow_state","pairId":prior.id,"flowId":old_flow,"state":"decoded"}),
    );
    assert_no_payload(&net, resumed_service);
    assert_eq!(restored.transit_session, None);
    assert_eq!(
        serde_json::to_value(net.policy(&room)).unwrap(),
        original_policy
    );

    // Same-room saved intent creates fresh leases for the new socket.
    if let Some(direct) = net
        .state(viewer)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == source)
        .map(|pair| pair.id)
    {
        command(
            &mut net,
            viewer,
            json!({"type":"link_state","pairId":direct,"state":"failed"}),
        );
    }
    confirm_service_path(&mut net, resumed_service, resumed_host, viewer);
    prove_service_screen(&mut net, viewer, resumed_service, source, relay, picture);
    assert_eq!(
        topology(&mut net, resumed_host, &room).transit_session,
        Some(relay)
    );
    let effects = register_service(&mut net, None).unwrap();
    accepted(net.deliver(effects));
    assert_no_payload(&net, resumed_service);
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    assert!(topology(&mut net, resumed_host, &room).service_enabled);
    confirm_service_path(&mut net, resumed_service, resumed_host, viewer);
    prove_service_screen(&mut net, viewer, resumed_service, source, relay, picture);
    assert_eq!(
        topology(&mut net, resumed_host, &room).transit_session,
        Some(relay)
    );
    command(&mut net, resumed_service, json!({"type":"leave"}));
    for socket in [resumed_host, viewer] {
        assert!(net.state(socket).pairs.iter().all(|p| p.peer_id != relay));
    }
}

#[test]
fn hosted_writer_projects_the_confirmed_pair_and_voice_flow_between_participants() {
    use piik_channel_core::{
        host::{RoomSummary, ServiceEndpoint},
        wire::HostingMode,
        RoomState,
    };
    let mut net = RoomNetwork::new();
    net.authority.set_hosting_mode(HostingMode::Hosted);
    let (writer, a, b) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let writer_session = join(&mut net, writer, false);
    let source = join(&mut net, a, true);
    let receiver = join(&mut net, b, false);
    net.authority
        .set_room_writer(ServiceEndpoint {
            session_id: writer_session,
            connection_id: writer,
        })
        .unwrap();
    let owner = net
        .state(a)
        .sessions
        .iter()
        .find(|s| s.id == source)
        .unwrap()
        .user_id;
    let mut policy = RoomState::new(
        "room".into(),
        "Room".into(),
        Default::default(),
        owner,
        RoomAccess::Public,
        false,
        None,
    )
    .unwrap();
    let creation = net
        .authority
        .prepare_hosted_creation(source, a, RoomSummary::from_policy(&policy))
        .unwrap();
    net.authority.reserve_hosted_creation(&creation).unwrap();
    policy.id = creation.summary().id.clone();
    let room = net.restore_room(writer, policy);
    for peer in [a, b] {
        command(
            &mut net,
            peer,
            json!({"type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false}),
        );
    }
    let voice = Uuid::new_v4();
    command(
        &mut net,
        a,
        json!({"type":"publish","publication":{"id":voice,"roomId":room,"kind":"voice"}}),
    );
    let edge = pair(&net, b, source).id;
    confirm_hop(&mut net, [a, b], edge);
    assert!(pair(&net, b, source)
        .incoming
        .iter()
        .any(|flow| flow.publication_id == voice));
    assert!(topology(&mut net, a, &room).pairs.iter().any(
        |p| p.confirmed && (p.first, p.second) == (source.min(receiver), source.max(receiver))
    ));
    assert_eq!(
        net.state(a).channel.rooms[0]
            .delivery
            .as_ref()
            .unwrap()
            .host_session_id,
        writer_session
    );
}

#[test]
fn hosted_transit_pair_survives_room_manager_session_expiry_until_revoked() {
    use piik_channel_core::{
        host::{RoomSummary, ServiceEndpoint},
        wire::{HostingMode, Request},
        RoomState, RECOVERY_MS,
    };
    let mut net = RoomNetwork::new();
    net.authority.set_hosting_mode(HostingMode::Hosted);
    let [writer, manager, source, viewer] = std::array::from_fn(|_| Uuid::new_v4());
    let service = join(&mut net, writer, false);
    let creator = join(&mut net, manager, true);
    let sender = join(&mut net, source, false);
    let receiver = join(&mut net, viewer, false);
    let user = |id| {
        net.state(manager)
            .sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap()
            .user_id
    };
    let mut policy = RoomState::new(
        "private".into(),
        "Private".into(),
        Default::default(),
        user(creator),
        RoomAccess::Private,
        false,
        None,
    )
    .unwrap();
    policy.grants.extend([user(sender), user(receiver)]);
    net.authority
        .set_room_writer(ServiceEndpoint {
            session_id: service,
            connection_id: writer,
        })
        .unwrap();
    let effects = register_service(&mut net, Some(service)).unwrap();
    accepted(net.deliver(effects));
    let creation = net
        .authority
        .prepare_hosted_creation(creator, manager, RoomSummary::from_policy(&policy))
        .unwrap();
    net.authority.reserve_hosted_creation(&creation).unwrap();
    policy.id = creation.summary().id.clone();
    let room = net.restore_room(writer, policy);
    set_preference(&mut net, manager, &room, true);
    let picture = screen(&mut net, source, viewer, &room);
    let direct = pair(&net, viewer, sender);
    command(
        &mut net,
        viewer,
        json!({"type":"link_state","pairId":direct.id,"state":"failed"}),
    );
    confirm_service_path(&mut net, writer, source, viewer);
    prove_service_screen(&mut net, viewer, writer, sender, service, picture);

    let effects = net.authority.disconnect(manager, 100);
    accepted(net.deliver(effects));
    let now = 100 + RECOVERY_MS;
    let effects = net.authority.expire(now);
    accepted(net.deliver(effects));
    let request = Request::parse(
        &json!({"type":"voice","roomId":room,"joined":true,"muted":true,"deafened":true})
            .to_string(),
    )
    .unwrap();
    let effects = net.authority.handle(source, request, now);
    let edge = (sender.min(service), sender.max(service));
    assert!(effects.events.iter().any(|(_, event)| matches!(event,
        Event::HostInput { input, .. } if !input.endpoints.contains_key(&creator) && input.confirmed_pairs.contains(&edge)
    )));
    accepted(net.deliver(effects));

    join(&mut net, manager, true);
    set_preference(&mut net, manager, &room, false);
    assert_no_payload(&net, writer);
}
