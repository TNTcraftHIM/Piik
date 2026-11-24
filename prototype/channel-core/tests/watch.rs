#![cfg(feature = "sqlite")]
mod support;
use piik_channel_core::{
    host::RoomResult,
    wire::{Event, RoomAccess},
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;
fn setup() -> (RoomNetwork, Uuid, Uuid, String) {
    let mut net = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    net.command(
        owner,
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    net.command(viewer, json!({"type":"join","name":"Viewer"}));
    let room = net.create(owner, RoomAccess::Public, false);
    (net, owner, viewer, room)
}
fn playback() -> Value {
    json!({"timeline":"media","position":12.5,"paused":false,"rate":1.5,"anchorTime":1000})
}
fn start(room: &str, id: Uuid) -> Value {
    json!({"type":"start_watch","roomId":room,"id":id,"source":{"kind":"media","url":"https://example.com/movie.mp4"},"playback":playback(),"requestId":"start"})
}
fn ready(effects: piik_channel_core::Effects, time: u64) {
    assert!(effects.events.iter().any(|(_,e)|matches!(e,Event::RoomReply{result:RoomResult::WatchReady{server_time},..} if *server_time==time)));
}
fn error(effects: piik_channel_core::Effects, code: &str) {
    assert!(effects.events.iter().any(|(_,e)|matches!(e,Event::RoomReply{result:RoomResult::Error{code:c},..}|Event::Error{code:c,..} if c==code)));
}
#[test]
fn program_timeline_is_required_and_stays_with_the_activity() {
    let (mut net, owner, viewer, room) = setup();
    let id = Uuid::new_v4();
    let mut command = start(&room, id);
    command["playback"]["timeline"] = json!("program");
    command["playback"]["position"] = json!(1794744006.0);
    ready(net.command_at(owner, command.clone(), 2000), 2000);
    net.command(
        viewer,
        json!({"type":"join_watch","roomId":room,"id":id,"mode":"direct"}),
    );
    error(
        net.command(
            owner,
            json!({"type":"update_watch","roomId":room,"id":id,"playback":playback()}),
        ),
        "watch_timeline_changed",
    );
    assert_eq!(
        net.state(viewer).watch_activities[0].playback.position,
        1794744006.0
    );
    error(
        net.command(owner, start(&room, id)),
        "watch_identity_conflict",
    );
    command["playback"]
        .as_object_mut()
        .unwrap()
        .remove("timeline");
    assert!(piik_channel_core::wire::Request::parse(&command.to_string()).is_err());
}
#[test]
fn watch_confirmations_late_join_and_owner_control_do_not_create_media() {
    let (mut net, owner, viewer, room) = setup();
    let id = Uuid::new_v4();
    // The sharer is a reader, not the room manager.
    ready(net.command_at(viewer, start(&room, id), 2000), 2000);
    assert_eq!(
        serde_json::to_value(&net.state(owner).watch_activities[0].source).unwrap(),
        start(&room, id)["source"]
    );
    assert_eq!(
        net.state(owner).watch_activities[0].playback.anchor_time,
        1000
    );
    ready(
        net.command_at(
            owner,
            json!({"type":"join_watch","roomId":room,"id":id,"mode":"direct","requestId":"join"}),
            3000,
        ),
        3000,
    );
    assert_eq!(
        net.state(owner)
            .watch_subscriptions
            .iter()
            .map(|s| s.id)
            .collect::<Vec<_>>(),
        vec![id]
    );
    assert_eq!(net.state(owner).watch_activities[0].playback.position, 12.5);
    for command in [
        json!({"type":"update_watch","roomId":room,"id":id,"playback":playback()}),
        json!({"type":"stop_watch","roomId":room,"id":id}),
    ] {
        error(net.command(owner, command), "not_watch_owner");
    }
    let updated =
        json!({"timeline":"media","position":30,"paused":true,"rate":2,"anchorTime":4000});
    net.command(
        viewer,
        json!({"type":"update_watch","roomId":room,"id":id,"playback":updated}),
    );
    ready(net.command_at(viewer, start(&room, id), 5000), 5000);
    assert_eq!(net.state(owner).watch_activities[0].playback.position, 30.0);
    for c in [owner, viewer] {
        let state = net.state(c);
        assert!(state.pairs.iter().all(|pair| pair.rooms.is_empty()
            && pair.incoming.is_empty()
            && pair.outgoing.is_empty()));
        assert!(state.publications.is_empty());
        assert_eq!(state.watch_activities[0].viewer_session_ids.len(), 1);
        assert!(!state.watch_activities[0]
            .viewer_session_ids
            .contains(&state.watch_activities[0].session_id));
        assert_eq!(state.channel.rooms[0].participant_session_ids.len(), 2);
    }
    net.command(
        owner,
        json!({"type":"join_watch","roomId":room,"id":id,"mode":null}),
    );
    assert!(net.state(owner).watch_subscriptions.is_empty());
    assert!(net.state(owner).watch_activities[0]
        .viewer_session_ids
        .is_empty());
    assert_eq!(
        net.state(owner).channel.rooms[0]
            .participant_session_ids
            .len(),
        1
    );
    net.command(viewer, json!({"type":"stop_watch","roomId":room,"id":id}));
    assert!(net.state(owner).watch_activities.is_empty());
}
#[test]
fn watch_validation_and_source_retirement_are_bounded() {
    let (mut net, owner, viewer, room) = setup();
    let id = Uuid::new_v4();
    for url in [
        "javascript:alert(1)",
        "/movie.mp4",
        "https://user:password@example.com/a",
    ] {
        let mut value = start(&room, id);
        value["source"]["url"] = json!(url);
        error(net.command(owner, value), "invalid_watch_url");
    }
    let mut legacy = start(&room, id);
    legacy.as_object_mut().unwrap().remove("source");
    legacy["url"] = json!("https://example.com/movie.mp4");
    assert!(piik_channel_core::wire::Request::parse(&legacy.to_string()).is_err());
    let mut invalid_kind = start(&room, id);
    invalid_kind["source"]["mediaUrl"] = json!("https://example.com/other.mp4");
    assert!(piik_channel_core::wire::Request::parse(&invalid_kind.to_string()).is_err());
    let webpage = json!({"kind":"website","url":"https://example.com/watch"});
    let source: piik_channel_core::wire::WatchSource =
        serde_json::from_value(webpage.clone()).unwrap();
    assert_eq!(serde_json::to_value(source).unwrap(), webpage);
    let mut value = start(&room, id);
    value["playback"]["rate"] = json!(0);
    error(net.command(owner, value), "invalid_watch_playback");
    net.command(viewer, start(&room, id));

    net.command(
        owner,
        json!({"type":"join_watch","roomId":room,"id":id,"mode":"direct"}),
    );
    net.command(viewer, json!({"type":"leave"}));
    assert!(net.state(owner).watch_activities.is_empty());
    assert!(net.state(owner).watch_subscriptions.is_empty());
    net.command(owner, start(&room, id));
    let binding = net.state(owner).channel.rooms[0]
        .delivery
        .as_ref()
        .unwrap()
        .binding_id;
    net.command(
        owner,
        json!({"type":"host_stop","roomId":room,"bindingId":binding}),
    );
    assert!(net.state(owner).watch_activities.is_empty());
}

#[test]
fn watch_room_access_revoke_preserves_other_room_media() {
    let (mut net, owner, viewer, public) = setup();
    let private = net.create(owner, RoomAccess::Private, false);
    let id = Uuid::new_v4();
    error(
        net.command(viewer, start(&private, id)),
        "room_access_required",
    );
    net.command(owner,json!({"type":"update_room","roomId":private,"name":"Private","icon":"couch","access":"private","hidden":false,"password":"secret"}));
    net.command(
        viewer,
        json!({"type":"enter_room","roomId":private,"password":"secret"}),
    );
    net.command(viewer, start(&private, id));
    net.command(
        owner,
        json!({"type":"join_watch","roomId":private,"id":id,"mode":"direct"}),
    );
    for kind in ["voice", "screen"] {
        if kind == "voice" {
            net.command(viewer,json!({"type":"voice","roomId":public,"joined":true,"muted":false,"deafened":false}));
        }
        let source = if kind == "screen" {
            json!({"kind":"screen","name":null})
        } else {
            Value::Null
        };
        net.command(viewer,json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":public,"kind":kind,"source":source,"videoSettings":null}}));
    }
    let before = serde_json::to_value(&net.state(owner).publications).unwrap();
    assert_eq!(before.as_array().unwrap().len(), 2);
    let viewer_user = net.state(viewer).watch_activities[0].user_id;
    net.command(
        owner,
        json!({"type":"revoke_room_access","roomId":private,"userId":viewer_user}),
    );
    for c in [owner, viewer] {
        assert!(net.state(c).watch_activities.is_empty());
        assert!(net.state(c).watch_subscriptions.is_empty());
    }
    assert_eq!(
        serde_json::to_value(&net.state(owner).publications).unwrap(),
        before
    );
    error(
        net.command(
            viewer,
            json!({"type":"update_watch","roomId":private,"id":id,"playback":playback()}),
        ),
        "room_access_required",
    );
}

#[test]
fn watch_disconnect_recovers_until_session_expiry() {
    let (mut net, owner, viewer, room) = setup();
    let id = Uuid::new_v4();
    net.command(viewer, start(&room, id));
    net.command(
        owner,
        json!({"type":"join_watch","roomId":room,"id":id,"mode":"direct"}),
    );
    let effects = net.authority.disconnect(viewer, 1000);
    net.deliver(effects);
    assert_eq!(net.state(owner).watch_activities.len(), 1);
    let effects = net.authority.expire(1000 + piik_channel_core::RECOVERY_MS);
    net.deliver(effects);
    assert!(net.state(owner).watch_activities.is_empty());
    assert!(net.state(owner).watch_subscriptions.is_empty());
}

#[test]
fn replacing_watch_validates_before_retiring_source_and_viewers() {
    let (mut net, owner, viewer, room) = setup();
    let old = Uuid::new_v4();
    let next = Uuid::new_v4();
    net.command(owner, start(&room, old));
    net.command(
        viewer,
        json!({"type":"join_watch","roomId":room,"id":old,"mode":"direct"}),
    );
    let mut replacement = start(&room, next);
    replacement["source"] =
        json!({"kind":"website","url":"https://example.com/watch","mediaUrl":"javascript:bad"});
    error(net.command(owner, replacement.clone()), "invalid_watch_url");
    assert_eq!(
        net.state(viewer)
            .watch_subscriptions
            .iter()
            .map(|s| s.id)
            .collect::<Vec<_>>(),
        vec![old]
    );
    assert_eq!(net.state(viewer).watch_activities[0].id, old);
    replacement["source"]["mediaUrl"] = json!("https://example.com/next.mp4");
    replacement["replaceId"] = json!(Uuid::new_v4());
    error(net.command(owner, replacement.clone()), "watch_identity_conflict");
    assert_eq!(net.state(viewer).watch_subscriptions[0].id, old);
    replacement["replaceId"] = json!(old);
    let expected_source = replacement["source"].clone();
    let mut conflict = replacement.clone();
    conflict["id"] = json!(old);
    error(net.command(owner, conflict), "watch_identity_conflict");
    ready(net.command_at(owner, replacement, 6000), 6000);
    assert_eq!(
        serde_json::to_value(&net.state(viewer).watch_activities[0].source).unwrap(),
        expected_source
    );
    assert!(net.state(viewer).watch_subscriptions.is_empty());
    assert_eq!(net.state(viewer).watch_activities.len(), 1);
    assert_eq!(net.state(viewer).watch_activities[0].replace_id, Some(old));
    assert_eq!(net.state(viewer).watch_activities[0].id, next);
    net.command(owner, json!({"type":"stop_watch","roomId":room,"id":old}));
    assert_eq!(net.state(viewer).watch_activities[0].id, next);
}

#[test]
fn initial_watch_bytes_validate_before_replacing_the_activity_and_subscriptions() {
    let (mut net, owner, viewer, room) = setup();
    let old = Uuid::new_v4();
    let next = Uuid::new_v4();
    net.command(owner, start(&room, old));
    net.command(
        viewer,
        json!({"type":"join_watch","roomId":room,"id":old,"mode":"direct"}),
    );
    let provider = Uuid::new_v4();
    let provider_session = net
        .command(
            provider,
            json!({"type":"join","name":"App","ownerKey":"owner"}),
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .unwrap();
    let effects = net.authority.disconnect(provider, 1000);
    net.deliver(effects);
    let before = net.state(viewer);
    let owner_session = before.watch_activities[0].session_id;
    let foreign_session = before.watch_activities[0].viewer_session_ids[0];
    let activities = serde_json::to_value(&before.watch_activities).unwrap();
    let subscriptions = before.watch_subscriptions.clone();
    let mut replacement = start(&room, next);
    replacement["source"] = json!({"kind":"website","url":"https://example.com/watch"});
    replacement["byteSource"] =
        json!({"sessionId":provider_session,"resourceId":Uuid::new_v4(),"format":"hls"});
    for unavailable in [provider_session, foreign_session, Uuid::new_v4()] {
        replacement["byteSource"]["sessionId"] = json!(unavailable);
        error(
            net.command(owner, replacement.clone()),
            "watch_provider_unavailable",
        );
        assert_eq!(
            serde_json::to_value(&net.state(viewer).watch_activities).unwrap(),
            activities
        );
        assert_eq!(net.state(viewer).watch_subscriptions, subscriptions);
    }
    replacement["byteSource"]["sessionId"] = json!(owner_session);
    let initial_bytes = replacement["byteSource"].clone();
    ready(net.command_at(owner, replacement, 2000), 2000);
    for connection in [owner, viewer] {
        let state = net.state(connection);
        assert_eq!(state.watch_activities.len(), 1);
        assert_eq!(state.watch_activities[0].id, next);
        assert_eq!(
            serde_json::to_value(&state.watch_activities[0].byte_source).unwrap(),
            initial_bytes
        );
        assert!(state.watch_subscriptions.is_empty());
        assert!(state.watch_activities[0].viewer_session_ids.is_empty());
    }
}

#[test]
fn start_retry_preserves_later_forwarding_settings_after_initial_provider_retires() {
    let (mut net, owner, viewer, room) = setup();
    let provider = Uuid::new_v4();
    let provider_session = net
        .command(
            provider,
            json!({"type":"join","name":"App","ownerKey":"owner"}),
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .unwrap();
    let activity = Uuid::new_v4();
    let mut initial = start(&room, activity);
    initial["byteSource"] =
        json!({"sessionId":provider_session,"resourceId":Uuid::new_v4(),"format":"hls"});
    ready(net.command_at(owner, initial.clone(), 2000), 2000);
    net.command(
        viewer,
        json!({"type":"join_watch","roomId":room,"id":activity,"mode":"direct"}),
    );
    let updated_bytes =
        json!({"sessionId":provider_session,"resourceId":Uuid::new_v4(),"format":"file"});
    net.command(owner, json!({"type":"set_watch_byte_source","roomId":room,"id":activity,"byteSource":updated_bytes}));
    net.command(owner, json!({"type":"update_watch","roomId":room,"id":activity,"playback": {"timeline":"media","position":30,"paused":true,"rate":1,"anchorTime":3000}}));
    ready(net.command_at(owner, initial.clone(), 4000), 4000);
    assert_eq!(
        serde_json::to_value(&net.state(viewer).watch_activities[0].byte_source).unwrap(),
        updated_bytes
    );
    net.command(
        owner,
        json!({"type":"set_watch_byte_source","roomId":room,"id":activity,"byteSource":null}),
    );
    let effects = net.authority.disconnect(provider, 5000);
    net.deliver(effects);
    ready(net.command_at(owner, initial, 6000), 6000);
    let state = net.state(viewer);
    assert_eq!(state.watch_activities.len(), 1);
    assert!(state.watch_activities[0].byte_source.is_none());
    assert_eq!(state.watch_activities[0].playback.position, 30.0);
    assert_eq!(state.watch_subscriptions[0].id, activity);
}

#[test]
fn watch_byte_source_and_mode_cross_the_real_room_projection() {
    let (mut net, _writer, viewer, room) = setup();
    // The browser controls the watch over signaling. Its native sibling serves the bytes.
    let owner = Uuid::new_v4();
    net.command(owner, json!({"type":"join","name":"Browser","ownerKey":"owner","canUsePeerTransport":false}));
    let provider = Uuid::new_v4();
    let provider_session = net
        .command(
            provider,
            json!({"type":"join","name":"App","ownerKey":"owner"}),
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .unwrap();
    let activity = Uuid::new_v4();
    net.command(owner, start(&room, activity));
    let set_source = json!({"type":"set_watch_byte_source","roomId":room,"id":activity,"byteSource":{"sessionId":provider_session,"resourceId":Uuid::new_v4(),"format":"file"},"requestId":"source"});
    error(net.command(viewer, set_source.clone()), "not_watch_owner");
    net.command(owner, set_source);
    assert!(net.state(owner).pairs.is_empty());
    assert_eq!(
        net.state(viewer).watch_activities[0]
            .byte_source
            .as_ref()
            .unwrap()
            .session_id,
        provider_session
    );
    ready(net.command_at(viewer,json!({"type":"join_watch","roomId":room,"id":activity,"mode":"direct","requestId":"join"}),200),200);
    assert!(
        net.state(viewer).watch_bytes.is_empty()
            && net
                .state(viewer)
                .pairs
                .iter()
                .all(|pair| pair.rooms.is_empty()
                    && pair.incoming.is_empty()
                    && pair.outgoing.is_empty())
    );
    ready(net.command_at(viewer,json!({"type":"join_watch","roomId":room,"id":activity,"mode":"peer","requestId":"join"}),300),300);
    let pair = net
        .state(viewer)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == provider_session)
        .expect("the peer viewer requests a transport to the provider")
        .id;
    assert!(net.state(viewer).watch_bytes[0].upstream.is_none());
    for connection in [provider, viewer] {
        let effects = net.command_at(
            connection,
            json!({"type":"link_state","pairId":pair,"state":"connected"}),
            300,
        );
        assert!(
            !effects
                .events
                .iter()
                .any(|(_, event)| matches!(event, Event::Error { .. })),
            "projection must validate the connected watch path"
        );
    }
    assert_eq!(net.state(viewer).watch_bytes.len(), 1);
    assert!(net.state(viewer).watch_bytes[0].receiving);
    assert_eq!(
        net.state(viewer).watch_bytes[0].upstream,
        Some(provider_session)
    );
    // A signaling interruption keeps the admitted source and existing range lease.
    let before = net.state(viewer).clone();
    let viewer_session = before.watch_activities[0].viewer_session_ids[0];
    let source = before.watch_activities[0].byte_source.clone();
    let peers = |state: &piik_channel_core::wire::Snapshot| {
        state
            .pairs
            .iter()
            .map(|pair| (pair.peer_id, pair.rooms.clone()))
            .collect()
    };
    let mut delivery = piik_channel_core::watch_delivery::WatchDelivery::new(viewer_session);
    assert!(delivery
        .update(before.watch_bytes.clone(), peers(&before))
        .is_empty());
    let request = Uuid::new_v4();
    let key = piik_channel_core::watch_delivery::WatchKey {
        room_id: room.clone(),
        activity_id: activity,
        resource_id: source.as_ref().unwrap().resource_id,
    };
    assert!(matches!(
        delivery.read(key, request, 0, 1024).as_slice(),
        [piik_channel_core::watch_delivery::WatchEffect::SendControl { .. }]
    ));
    let effects = net.authority.disconnect(provider, 400);
    for (connection, event) in &effects.events {
        if let Event::State { state } = event {
            if *connection == viewer {
                assert_eq!(
                    state.watch_activities[0].byte_source, source,
                    "Domain projection must retain the admitted source before the host reconciles"
                );
            }
        }
    }
    net.deliver(effects);
    assert_eq!(net.state(viewer).watch_activities[0].byte_source, source);
    assert_eq!(net.state(viewer).watch_bytes, before.watch_bytes);
    assert_eq!(
        net.state(viewer).watch_subscriptions,
        before.watch_subscriptions
    );
    assert!(delivery
        .update(
            net.state(viewer).watch_bytes.clone(),
            peers(net.state(viewer))
        )
        .is_empty());
    error(
        net.command(
            owner,
            json!({"type":"set_watch_byte_source","roomId":room,"id":activity,
        "byteSource":{"sessionId":provider_session,"resourceId":Uuid::new_v4(),"format":"file"}}),
        ),
        "watch_provider_unavailable",
    );
    assert_eq!(net.state(viewer).watch_activities[0].byte_source, source);
    let resumed = Uuid::new_v4();
    let joined = net.command_at(
        resumed,
        json!({"type":"join","name":"App","ownerKey":"owner","sessionId":provider_session}),
        7400,
    );
    assert!(joined.events.iter().any(|(_, event)| matches!(event,
        Event::Welcome { session_id, .. } if *session_id == provider_session)));
    assert_eq!(net.state(viewer).watch_activities[0].byte_source, source);
    assert_eq!(
        net.state(viewer).watch_subscriptions,
        before.watch_subscriptions
    );
    assert!(delivery
        .update(
            net.state(viewer).watch_bytes.clone(),
            peers(net.state(viewer))
        )
        .is_empty());
    // The existing authority deadline, not a new reader timer, ends this grant.
    let effects = net.authority.disconnect(resumed, 8000);
    net.deliver(effects);
    let effects = net
        .authority
        .expire(8000 + piik_channel_core::RECOVERY_MS - 1);
    net.deliver(effects);
    assert_eq!(net.state(viewer).watch_activities[0].byte_source, source);
    let effects = net.authority.expire(8000 + piik_channel_core::RECOVERY_MS);
    net.deliver(effects);
    assert!(net.state(viewer).watch_activities[0].byte_source.is_none());
    assert!(net.state(viewer).watch_bytes.is_empty());
    assert_eq!(
        net.state(viewer).watch_subscriptions,
        before.watch_subscriptions
    );
    assert!(delivery.update(vec![], peers(net.state(viewer))).iter().any(|effect|
        matches!(effect, piik_channel_core::watch_delivery::WatchEffect::Failed { request_id, .. } if *request_id == request)));
    assert!(piik_channel_core::wire::Request::parse(
        &json!({"type":"join_watch","roomId":room,"id":activity,"enabled":true}).to_string()
    )
    .is_err());
}

#[test]
fn offline_provider_keeps_only_its_previously_admitted_source() {
    let (mut net, owner, viewer, room) = setup();
    let provider = Uuid::new_v4();
    let provider_session = net
        .command(
            provider,
            json!({"type":"join","name":"App","ownerKey":"owner"}),
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .unwrap();
    let activity = Uuid::new_v4();
    let source = json!({"sessionId":provider_session,"resourceId":Uuid::new_v4(),"format":"file"});
    let mut initial = start(&room, activity);
    initial["byteSource"] = source.clone();
    net.command(owner, initial);
    let effects = net.authority.disconnect(provider, 400);
    net.deliver(effects);
    let mut replacement = start(&room, Uuid::new_v4());
    replacement["byteSource"] = source.clone();
    error(
        net.command(owner, replacement),
        "watch_provider_unavailable",
    );
    assert_eq!(net.state(viewer).watch_activities[0].id, activity);

    // The Domain also rejects a host inventing an offline source. Reuse an actual
    // host output, changing only the claimed source, so room/revision ownership is valid.
    let command = json!({"type":"update_watch","roomId":room,"id":activity,"playback":playback(),"requestId":"update"});
    let effects = net.authority.handle(
        owner,
        piik_channel_core::wire::Request::parse(&command.to_string()).unwrap(),
        500,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let output = net.host_turn(&room, input);
    for replace_activity in [false, true] {
        let mut invalid = serde_json::to_value(&output).unwrap();
        if replace_activity {
            invalid["projection"]["watchActivities"][0]["id"] = json!(Uuid::new_v4());
        } else {
            invalid["projection"]["watchActivities"][0]["byteSource"]["resourceId"] =
                json!(Uuid::new_v4());
        }
        error(
            net.command(
                owner,
                json!({"type":"host_output","roomId":room,"output":invalid}),
            ),
            "invalid_room_projection",
        );
    }
    let accepted = net.command(
        owner,
        json!({"type":"host_output","roomId":room,"output":output}),
    );
    assert!(accepted.events.iter().any(|(_, event)| matches!(
        event,
        Event::RoomReply {
            result: RoomResult::Done,
            ..
        }
    )));
    assert_eq!(
        serde_json::to_value(&net.state(viewer).watch_activities[0].byte_source).unwrap(),
        source
    );

    // Explicit withdrawal still ends the grant during recovery; the old source
    // cannot be restored by either the owner command or a stale host declaration.
    net.command(
        owner,
        json!({"type":"set_watch_byte_source","roomId":room,"id":activity,"byteSource":null}),
    );
    assert!(net.state(viewer).watch_activities[0].byte_source.is_none());
    error(
        net.command(
            owner,
            json!({"type":"set_watch_byte_source","roomId":room,"id":activity,"byteSource":source}),
        ),
        "watch_provider_unavailable",
    );
    let effects = net.authority.handle(
        owner,
        piik_channel_core::wire::Request::parse(&command.to_string()).unwrap(),
        600,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let mut output = serde_json::to_value(net.host_turn(&room, input)).unwrap();
    output["projection"]["watchActivities"][0]["byteSource"] = source;
    error(
        net.command(
            owner,
            json!({"type":"host_output","roomId":room,"output":output}),
        ),
        "invalid_room_projection",
    );
    assert!(net.state(viewer).watch_activities[0].byte_source.is_none());
}

#[test]
fn watch_audience_projects_all_modes_and_sessions_without_peer_demand() {
    let (mut net, owner, viewer, room) = setup();
    let other = Uuid::new_v4();
    let other_page = Uuid::new_v4();
    let (other_session, credential) = net
        .command(other, json!({"type":"join","name":"Other"}))
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
    let other_page_session = net
        .command(
            other_page,
            json!({"type":"join","name":"Other page","credential":credential}),
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .unwrap();
    let activity = Uuid::new_v4();
    let mut website = start(&room, activity);
    website["source"] = json!({"kind":"website","url":"https://example.com/watch"});
    net.command(owner, website);
    for (connection, mode) in [(viewer, "direct"), (other, "peer"), (other_page, "direct")] {
        net.command(
            connection,
            json!({"type":"join_watch","roomId":room,"id":activity,"mode":mode}),
        );
    }
    for connection in [owner, viewer, other, other_page] {
        let state = net.state(connection);
        let audience = &state.watch_activities[0].viewer_session_ids;
        assert_eq!(audience.len(), 3);
        assert!(
            audience.contains(&other_session) && audience.contains(&other_page_session),
            "same user's endpoints remain separate wire facts"
        );
        assert_eq!(state.channel.rooms[0].participant_session_ids.len(), 4);
        assert!(
            state.pairs.iter().all(|pair| pair.rooms.is_empty()
                && pair.incoming.is_empty()
                && pair.outgoing.is_empty())
                && state.watch_bytes.is_empty()
                && state.publications.is_empty()
        );
    }
    net.command(
        other,
        json!({"type":"join_watch","roomId":room,"id":activity,"mode":"direct"}),
    );
    assert_eq!(
        net.state(owner).watch_activities[0]
            .viewer_session_ids
            .len(),
        3,
        "mode changes do not duplicate participation"
    );
    let effects = net.authority.disconnect(other, 1000);
    net.deliver(effects);
    assert!(
        net.state(owner).watch_activities[0]
            .viewer_session_ids
            .contains(&other_session),
        "temporary signaling loss keeps existing participation"
    );
    let effects = net.authority.expire(30_000);
    net.deliver(effects);
    assert!(!net.state(owner).watch_activities[0]
        .viewer_session_ids
        .contains(&other_session));
    assert!(net.state(owner).watch_activities[0]
        .viewer_session_ids
        .contains(&other_page_session));
    net.command(
        other_page,
        json!({"type":"join_watch","roomId":room,"id":activity,"mode":null}),
    );
    assert_eq!(
        net.state(owner).watch_activities[0]
            .viewer_session_ids
            .len(),
        1
    );
}

#[test]
fn watch_audience_is_room_private_and_revoke_removes_viewer_only() {
    let (mut net, owner, viewer, _) = setup();
    let private = net.create(owner, RoomAccess::Private, false);
    net.command(owner,json!({"type":"update_room","roomId":private,"name":"Private","icon":"couch","access":"private","hidden":false,"password":"secret"}));
    let activity = Uuid::new_v4();
    net.command(owner, start(&private, activity));
    assert!(net.state(viewer).watch_activities.is_empty());
    assert!(net
        .state(viewer)
        .channel
        .rooms
        .iter()
        .find(|r| r.id == private)
        .unwrap()
        .participant_session_ids
        .is_empty());
    net.command(
        viewer,
        json!({"type":"enter_room","roomId":private,"password":"secret"}),
    );
    net.command(
        viewer,
        json!({"type":"join_watch","roomId":private,"id":activity,"mode":"direct"}),
    );
    let viewer_session = net.state(owner).watch_activities[0].viewer_session_ids[0];
    let viewer_user = net
        .state(owner)
        .sessions
        .iter()
        .find(|session| session.id == viewer_session)
        .unwrap()
        .user_id;
    net.command(
        owner,
        json!({"type":"revoke_room_access","roomId":private,"userId":viewer_user}),
    );
    assert!(net.state(viewer).watch_activities.is_empty());
    assert!(net.state(owner).watch_activities[0]
        .viewer_session_ids
        .is_empty());
    assert_eq!(net.state(owner).watch_activities[0].id, activity);
    assert_eq!(
        net.state(owner)
            .channel
            .rooms
            .iter()
            .find(|r| r.id == private)
            .unwrap()
            .participant_session_ids,
        vec![net.state(owner).watch_activities[0].session_id]
    );
}

#[test]
fn confirmed_exit_links_once_to_an_existing_source_in_the_same_room() {
    let (mut net, owner, viewer, room) = setup();
    let old = Uuid::new_v4();
    let screen = Uuid::new_v4();
    let next = Uuid::new_v4();
    let stop = json!({"type":"stop_watch","roomId":room,"id":old,"successorScreenId":screen});
    let unpublish = json!({"type":"unpublish","publicationId":screen,"successorWatchId":next});
    net.command(owner, start(&room, old));
    net.command(viewer, json!({"type":"join_watch","roomId":room,"id":old,"mode":"direct"}));
    error(net.command(owner, stop.clone()), "publication_unavailable");
    assert_eq!(net.state(viewer).watch_subscriptions[0].id, old);
    net.command(owner, json!({"type":"publish","publication":{"id":screen,"roomId":room,"kind":"screen","source":{"kind":"screen","name":"Desktop"}}}));
    error(net.command(viewer, stop.clone()), "publication_unavailable");
    net.command(owner, stop);
    assert!(net.state(viewer).watch_subscriptions.is_empty());
    assert_eq!(net.state(viewer).publications[0].screen.as_ref().unwrap().replace_watch_id, Some(old));
    net.command(viewer, json!({"type":"subscribe","publicationId":screen,"enabled":true}));
    assert!(net.state(viewer).subscriptions.contains(&screen));
    assert_eq!(net.state(viewer).publications[0].screen.as_ref().unwrap().replace_watch_id, None);
    net.command(owner, start(&room, next));
    error(net.command(viewer, unpublish.clone()), "watch_identity_conflict");
    net.command(owner, unpublish);
    assert!(net.state(viewer).subscriptions.is_empty());
    assert!(net.state(viewer).publications.is_empty());
    assert!(net.state(viewer).watch_subscriptions.is_empty());
    assert_eq!(net.state(viewer).watch_activities[0].replace_screen_id, Some(screen));
}

#[test]
fn queued_joins_and_batched_retirements_preserve_both_windows() {
    use piik_channel_core::wire::Request;
    let (mut net, owner, viewer, room) = setup();
    let second = Uuid::new_v4();
    let bystander = Uuid::new_v4();
    net.command(second, json!({"type":"join","name":"Second"}));
    net.command(bystander, json!({"type":"join","name":"Bystander"}));
    let sources = [(owner, Uuid::new_v4(), Uuid::new_v4()), (second, Uuid::new_v4(), Uuid::new_v4())];
    for (publisher, watch, screen) in sources {
        net.command(publisher, start(&room, watch));
        net.command(publisher, json!({"type":"publish","publication":{"id":screen,"roomId":room,"kind":"screen","source":{"kind":"screen","name":"Desktop"}}}));
    }
    let mut outputs = Vec::new();
    let mut delay = |net: &mut RoomNetwork, sender, command: Value| {
        let effects = net.authority.handle(sender, Request::parse(&command.to_string()).unwrap(), 120);
        for (host, event) in effects.events {
            if let Event::HostInput { room_id, input } = event {
                let output = net.host_turn(&room_id, input);
                outputs.push((host, json!({"type":"host_output","roomId":room_id,"output":output})));
            }
        }
    };
    for (_, watch, _) in sources {
        delay(&mut net, viewer, json!({"type":"join_watch","id":watch,"roomId":room,"mode":"direct"}));
    }
    for (publisher, watch, screen) in sources {
        delay(&mut net, publisher, json!({"type":"stop_watch","id":watch,"roomId":room,"successorScreenId":screen}));
    }
    // Changing the participant scope requires a covering revision before either stop reply is delivered.
    delay(&mut net, bystander, json!({"type":"leave"}));
    assert!(outputs.len() >= 5);
    let mut marked = Vec::new();
    for (host, output) in outputs {
        let effects = net.command(host, output);
        for (target, event) in effects.events {
            if let Event::State { state } = event {
                let markers: Vec<_> = state.publications.iter().filter_map(|p| Some((p.id, p.screen.as_ref()?.replace_watch_id?))).collect();
                if !markers.is_empty() {
                    assert_eq!(target, viewer);
                    marked.push(markers);
                }
            }
        }
    }
    assert_eq!(marked.len(), 1);
    assert_eq!(marked[0].len(), 2);
    for (_, watch, screen) in sources { assert!(marked[0].contains(&(screen,watch))); }
}
