use super::*;
use piik_channel_core::wire::Request;

#[test]
fn changing_the_screen_helper_updates_visibility_of_its_existing_pair() {
    let mut net = RoomNetwork::new();
    let [source, helper, viewer] = [(); 3].map(|_| Uuid::new_v4());
    let publisher = join(&mut net, source, "Source");
    net.command(
        viewer,
        json!({"type":"join","name":"Viewer","ownerKey":"owner"}),
    );
    let app = net
        .command(
            helper,
            json!({"type":"join","name":"App","ownerKey":"owner"}),
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .unwrap();

    let shared = net.create(source, RoomAccess::Public, false);
    let other_screen = publish_screen(&mut net, source, &shared);
    command(&mut net, helper, subscribe(other_screen, true));
    let established = pair(&net, helper, publisher).id;
    link_connected(&mut net, source, established);
    link_connected(&mut net, helper, established);

    let room = net.create(source, RoomAccess::Public, false);
    let screen = publish_screen(&mut net, source, &room);
    let edge = (publisher.min(app), publisher.max(app));
    for using_helper in [true, false] {
        let mut request = subscribe(screen, true);
        if using_helper {
            request["helperSessionId"] = json!(app);
        }
        command(&mut net, viewer, request);
        assert!(!net.state(helper).subscriptions.contains(&screen));
        assert!(!net
            .state(source)
            .channel
            .rooms
            .iter()
            .find(|r| r.id == room)
            .unwrap()
            .participant_session_ids
            .contains(&app));
        let browse = json!({"type":"browse","roomId":room,"active":true});
        let effects =
            net.authority
                .handle(source, Request::parse(&browse.to_string()).unwrap(), 102);
        let input = effects
            .events
            .iter()
            .find_map(|(_, event)| match event {
                Event::HostInput { input, room_id } if room_id == &room => Some(input),
                _ => None,
            })
            .unwrap();
        assert_eq!(input.confirmed_pairs.contains(&edge), using_helper);
        net.deliver(effects);
        assert_eq!(pair(&net, helper, publisher).id, established);
    }
}

#[test]
fn adding_a_watch_provider_reuses_its_confirmed_pair_in_another_room() {
    let mut net = RoomNetwork::new();
    let [page, provider, viewer] = [(); 3].map(|_| Uuid::new_v4());
    net.command(
        page,
        json!({"type":"join","name":"Page","ownerKey":"owner"}),
    );
    let app = net
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
    join(&mut net, viewer, "Viewer");
    let shared = net.create(provider, RoomAccess::Public, false);
    let screen = publish_screen(&mut net, provider, &shared);
    command(&mut net, viewer, subscribe(screen, true));
    let established = pair(&net, viewer, app).id;
    link_connected(&mut net, provider, established);
    link_connected(&mut net, viewer, established);

    let room = net.create(page, RoomAccess::Public, false);
    let watch = Uuid::new_v4();
    command(
        &mut net,
        page,
        json!({"type":"start_watch","roomId":room,"id":watch,
        "source":{"kind":"media","url":"https://example.com/movie.mp4"},
        "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":0}}),
    );
    command(
        &mut net,
        viewer,
        json!({"type":"join_watch","roomId":room,"id":watch,"mode":"peer"}),
    );
    command(
        &mut net,
        page,
        json!({"type":"set_watch_byte_source","roomId":room,"id":watch,
        "byteSource":{"sessionId":app,"resourceId":Uuid::new_v4(),"format":"file"}}),
    );
    assert_eq!(pair(&net, viewer, app).id, established);
    assert_eq!(net.state(viewer).watch_bytes[0].upstream, Some(app));

    // The other room continues using the pair while this room repairs its data channel.
    let report =
        |ready| json!({"type":"base_state","roomId":room,"pairId":established,"ready":ready});
    command(&mut net, viewer, report(false));
    assert_eq!(net.state(viewer).watch_bytes[0].upstream, None);
    assert!(!pair(&net, viewer, app).rooms.contains(&room));
    let due = net.authority.expire(5_101);
    net.deliver(due);
    let repaired = pair(&net, viewer, app);
    assert_eq!(repaired.id, established);
    assert!(repaired.rooms.contains(&room));
    assert!(input(repaired, screen).is_some());
    command(&mut net, viewer, report(true));
    assert_eq!(net.state(viewer).watch_bytes[0].upstream, Some(app));
}

#[test]
fn losing_the_only_file_pair_withdraws_the_grant_before_host_ack() {
    let mut net = RoomNetwork::new();
    let [source, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let a = join(&mut net, source, "Holder");
    let b = join(&mut net, receiver, "Receiver");
    let room = net.create(source, RoomAccess::Public, false);
    let file = offer_file(&mut net, source, &room);
    command(&mut net, receiver, file_receive(&room, file, true));
    let pair_id = pair(&net, receiver, a).id;
    link_connected(&mut net, source, pair_id);
    link_connected(&mut net, receiver, pair_id);
    assert_eq!(net.state(receiver).files[0].upstream, Some(a));

    let failure = json!({"type":"link_state","pairId":pair_id,"state":"failed"});
    let effects =
        net.authority
            .handle(receiver, Request::parse(&failure.to_string()).unwrap(), 101);
    assert!(effects.events.iter().any(|(_, event)| matches!(event, Event::HostInput { room_id, input }
        if room_id == &room && input.failed_pairs.iter().any(|pair| (pair.first, pair.second) == (a.min(b), a.max(b))))));
    for target in [source, receiver] {
        let state = effects
            .events
            .iter()
            .find_map(|(connection, event)| match event {
                Event::State { state } if *connection == target => Some(state),
                _ => None,
            })
            .unwrap();
        assert!(state
            .files
            .iter()
            .all(|plan| plan.upstream.is_none() && plan.downstream.is_empty()));
        assert!(state.pairs.iter().all(|pair| pair.id != pair_id));
    }
    net.deliver(effects);
    let waiting = &net.state(receiver).files[0];
    assert!(waiting.receiving);
    assert_eq!(waiting.source_id, Some(a));
    assert_eq!(waiting.upstream, None);
}

#[test]
fn confirmation_during_scope_change_wakes_the_host_after_ack() {
    let mut net = RoomNetwork::new();
    let [source, viewer, other] = [0; 3].map(|_| Uuid::new_v4());
    let a = join(&mut net, source, "Source");
    let b = join(&mut net, viewer, "Viewer");
    join(&mut net, other, "Other");
    let room = net.create(source, RoomAccess::Public, false);
    let screen = publish_screen(&mut net, source, &room);
    command(&mut net, viewer, subscribe(screen, true));
    let pair_id = pair(&net, viewer, a).id;
    let edge = (a.min(b), a.max(b));
    link_connected(&mut net, source, pair_id);

    let effects = net
        .authority
        .handle(other, Request::parse(r#"{"type":"leave"}"#).unwrap(), 101);
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { room_id, input } if room_id == room => Some(input),
            _ => None,
        })
        .unwrap();
    assert!(!input.confirmed_pairs.contains(&edge));
    let report = json!({"type":"link_state","pairId":pair_id,"state":"connected"});
    let effects = net
        .authority
        .handle(viewer, Request::parse(&report.to_string()).unwrap(), 102);
    assert!(!effects
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::HostInput { .. })));

    let acknowledge = |net: &mut RoomNetwork, input| {
        let output = net.host_turn(&room, input);
        net.authority.handle(
            source,
            Request {
                request_id: None,
                command: piik_channel_core::wire::Command::HostOutput {
                    room_id: room.clone(),
                    output,
                },
            },
            103,
        )
    };
    let effects = acknowledge(&mut net, input);
    let mut updates = effects
        .events
        .into_iter()
        .filter_map(|(_, event)| match event {
            Event::HostInput { room_id, input } if room_id == room => Some(input),
            _ => None,
        });
    let update = updates
        .next()
        .expect("host receives current graph after acknowledging scope");
    assert!(update.confirmed_pairs.contains(&edge));
    assert!(updates.next().is_none());
    let effects = acknowledge(&mut net, update);
    assert!(!effects
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::HostInput { .. } | Event::Error { .. })));
}
