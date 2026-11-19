#![cfg(feature = "sqlite")]

mod support;
use piik_channel_core::{
    conversation::ConversationCommand,
    host::RoomResult,
    wire::{Event, PairInfo, RoomAccess},
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

fn register_service(net: &mut RoomNetwork, session: Option<Uuid>) -> Result<Effects, &'static str> {
    let endpoint = session
        .map(|session_id| {
            net.authority
                .current_connection(session_id)
                .map(|connection_id| piik_channel_core::host::ServiceEndpoint {
                    session_id,
                    connection_id,
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
            Event::RoomInvite { key, .. } => Some(key),
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

fn acknowledge_base(net: &mut RoomNetwork, endpoints: &[Uuid], room: &str) {
    // The second turn covers a downstream admitted after its parent became ready.
    for _ in 0..2 {
        for &connection in endpoints {
            let pairs: Vec<_> = net
                .state(connection)
                .pairs
                .iter()
                .filter(|pair| pair.rooms.iter().any(|id| id == room))
                .map(|pair| pair.id)
                .collect();
            for pair in pairs {
                command(
                    net,
                    connection,
                    json!({"type":"base_state","roomId":room,"pairId":pair,"ready":true}),
                );
            }
        }
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
) -> Uuid {
    set_preference(net, host, room, true);
    let picture = screen(net, host, viewer, room);
    let direct = pair(net, viewer, source);
    command(
        net,
        viewer,
        json!({"type":"link_state","pairId":direct.id,"state":"failed"}),
    );
    acknowledge_base(net, &[host, service, viewer], room);
    let input = pair(net, service, source);
    let incoming = input
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .unwrap();
    command(
        net,
        service,
        json!({"type":"flow_state","pairId":input.id,"flowId":incoming.id,"state":"forwardable"}),
    );
    let output = pair(net, viewer, relay);
    let incoming = output
        .incoming
        .iter()
        .find(|flow| flow.publication_id == picture)
        .unwrap();
    command(
        net,
        viewer,
        json!({"type":"flow_state","pairId":output.id,"flowId":incoming.id,"state":"decoded"}),
    );
    assert_eq!(topology(net, host, room).transit_session, Some(relay));
    picture
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
    assert!(net.state(service).pairs.is_empty());
    assert_eq!(
        topology(&mut net, host, &room).transit_session,
        None,
        "permission alone must not be projected as a live forwarding lease"
    );
    let picture = bridge(&mut net, host, viewer, service, source, relay, &room);
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

    let activity = Uuid::new_v4();
    command(
        &mut net,
        host,
        json!({"type":"start_watch","roomId":room,"id":activity,
        "source":{"kind":"media","url":"https://example.com/private.mp4"},
        "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":100},
        "byteSource":{"sessionId":source,"resourceId":Uuid::new_v4(),"format":"file"}}),
    );
    command(
        &mut net,
        viewer,
        json!({"type":"join_watch","roomId":room,"id":activity,"mode":"peer"}),
    );
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
    assert!(net.state(operator_page).pairs.is_empty());
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
    assert!(net.state(service).pairs.is_empty());
    assert!(net.state(service).files.is_empty());
    assert!(net.state(service).watch_bytes.is_empty());
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
    assert_eq!(projected(&net, host), Some((false, false)));
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
    assert!(net.state(service).pairs.is_empty());
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
    let first = bridge(&mut net, host, viewer, service, source, relay, &room);
    let shared_upstream = pair(&net, service, source).id;
    let shared_downstream = pair(&net, service, destination).id;
    let second_room = private_room(&mut net, host, viewer);
    let second = bridge(&mut net, host, viewer, service, source, relay, &second_room);
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
    assert!(net.state(service).pairs.is_empty());
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
    acknowledge_base(&mut net, &[host, successor, viewer], &second_room);
    let current = topology(&mut net, host, &second_room);
    assert_eq!(current.transit_session, Some(replacement));
    command(
        &mut net,
        host,
        json!({"type":"host_stop","roomId":second_room,"bindingId":current.binding_id}),
    );
    assert!(net.state(successor).pairs.is_empty());
    let summary = piik_channel_core::host::RoomSummary::from_policy(&net.policy(&second_room));
    command(
        &mut net,
        host,
        json!({"type":"host_register","room":summary}),
    );
    let restarted = topology(&mut net, host, &second_room);
    assert_ne!(restarted.binding_id, current.binding_id);
    assert!(restarted.service_enabled);
    acknowledge_base(&mut net, &[host, successor, viewer], &second_room);
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
fn public_read_alone_does_not_keep_withdrawn_service_work() {
    let mut net = RoomNetwork::new();
    let [host, viewer, service, operator_page] = std::array::from_fn(|_| Uuid::new_v4());
    let source = join(&mut net, host, false);
    join(&mut net, viewer, false);
    let relay = join(&mut net, service, true);
    let person = join(&mut net, operator_page, true);
    let room = net.create(host, RoomAccess::Public, false);
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    let picture = bridge(&mut net, host, viewer, service, source, relay, &room);
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
            .all(|pair| !retired_pairs.contains(&pair.id))),
        "the domain must withdraw pure service pairs before the room host replies"
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
    command(
        &mut net,
        viewer,
        json!({"type":"voice","roomId":hosted,
        "joined":true,"muted":true,"deafened":true}),
    );
    assert!(
        net.state(service)
            .pairs
            .iter()
            .any(|pair| pair.rooms.contains(&hosted)),
        "an actual room host retains its ordinary base role without the optional relay preference"
    );
    let hosting_pair = net
        .state(service)
        .pairs
        .iter()
        .find(|pair| pair.rooms.contains(&hosted))
        .unwrap()
        .id;
    let effects = register_service(&mut net, None).unwrap();
    assert!(effects.events.iter().any(|(connection, event)| {
        *connection == service
            && matches!(event, Event::State { state } if state.pairs.iter().any(|pair| pair.id == hosting_pair))
    }));
    accepted(net.deliver(effects));
    assert!(net
        .state(service)
        .pairs
        .iter()
        .any(|pair| pair.id == hosting_pair && pair.rooms.contains(&hosted)));
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
    bridge(&mut net, host, viewer, service, source, relay, &room);
    let original_policy = serde_json::to_value(net.policy(&room)).unwrap();
    let old_pair_ids: Vec<_> = net
        .state(service)
        .pairs
        .iter()
        .map(|pair| pair.id)
        .collect();
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
    assert!(net
        .state(viewer)
        .pairs
        .iter()
        .all(|pair| pair.peer_id != relay));
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
            net.authority
                .set_service_endpoint(Some(piik_channel_core::host::ServiceEndpoint {
                    session_id: relay,
                    connection_id: service,
                })),
            Err("service_unavailable")
        ),
        "a delayed old Welcome cannot register the replacement socket"
    );
    assert!(net.state(resumed_service).pairs.is_empty());
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    assert!(net.state(resumed_service).pairs.is_empty());

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
    assert!(net
        .state(resumed_service)
        .pairs
        .iter()
        .all(|pair| !old_pair_ids.contains(&pair.id)));
    assert_eq!(
        serde_json::to_value(net.policy(&room)).unwrap(),
        original_policy
    );

    // Same-room saved intent creates fresh leases for the new socket.
    acknowledge_base(&mut net, &[resumed_host, resumed_service, viewer], &room);
    assert_eq!(
        topology(&mut net, resumed_host, &room).transit_session,
        Some(relay)
    );
    let effects = register_service(&mut net, None).unwrap();
    accepted(net.deliver(effects));
    assert!(net.state(resumed_service).pairs.is_empty());
    let effects = register_service(&mut net, Some(relay)).unwrap();
    accepted(net.deliver(effects));
    assert!(topology(&mut net, resumed_host, &room).service_enabled);
    acknowledge_base(&mut net, &[resumed_host, resumed_service, viewer], &room);
    assert_eq!(
        topology(&mut net, resumed_host, &room).transit_session,
        Some(relay)
    );
}
