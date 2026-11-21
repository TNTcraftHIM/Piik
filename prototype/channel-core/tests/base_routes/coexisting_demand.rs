use super::*;

#[test]
fn peer_watch_requests_the_provider_pair_and_waits_for_its_room_grant() {
    let mut net = RoomNetwork::new();
    let [page, provider, viewer] = [(); 3].map(|_| Uuid::new_v4());
    let (page_session, credential) = join(&mut net, page, None);
    let (provider_session, _) = join(&mut net, provider, Some(&credential));
    join(&mut net, viewer, None);
    let room = net.create(page, RoomAccess::Public, false);
    join_base(&mut net, provider, &room);
    let existing = pair(&net, provider, page_session, &room).id;
    for socket in [page, provider] {
        command(
            &mut net,
            socket,
            json!({"type":"link_state","pairId":existing,"state":"connected"}),
        );
        command(
            &mut net,
            socket,
            json!({"type":"base_state","roomId":room,"pairId":existing,"ready":true}),
        );
    }
    let activity = Uuid::new_v4();
    command(
        &mut net,
        page,
        json!({
            "type":"start_watch","roomId":room,"id":activity,
            "source":{"kind":"media","url":"https://example.com/movie.mp4"},
            "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":0},
            "byteSource":{"sessionId":provider_session,"resourceId":Uuid::new_v4(),"format":"file"}
        }),
    );
    let watch = |net: &mut RoomNetwork, mode| {
        command(
            net,
            viewer,
            json!({"type":"join_watch","roomId":room,"id":activity,"mode":mode}),
        )
    };
    watch(&mut net, "direct");
    assert!(net.state(viewer).pairs.is_empty());
    watch(&mut net, "peer");
    let provider_pair = net
        .state(viewer)
        .pairs
        .iter()
        .find(|p| p.peer_id == provider_session)
        .expect("peer-mode demand should request the provider itself")
        .id;
    assert_eq!(net.state(viewer).watch_bytes[0].upstream, None);
    for socket in [provider, viewer] {
        command(
            &mut net,
            socket,
            json!({"type":"link_state","pairId":provider_pair,"state":"connected"}),
        );
    }
    assert_eq!(
        pair(&net, viewer, provider_session, &room).id,
        provider_pair
    );
    for socket in [provider, viewer] {
        assert_eq!(net.state(viewer).watch_bytes[0].upstream, None);
        command(
            &mut net,
            socket,
            json!({"type":"base_state","roomId":room,"pairId":provider_pair,"ready":true}),
        );
    }
    assert_eq!(
        net.state(viewer).watch_bytes[0].upstream,
        Some(provider_session)
    );
    watch(&mut net, "direct");
    assert!(net.state(viewer).watch_bytes.is_empty());
    assert_eq!(pair(&net, provider, page_session, &room).id, existing);
}

#[test]
fn one_screen_reduces_two_decoded_outputs_while_another_stays_selected() {
    let mut net = RoomNetwork::new();
    let [a, b, c, x, y] = [(); 5].map(|_| Uuid::new_v4());
    let [as_, bs, cs, xs, _] = [a, b, c, x, y].map(|peer| join(&mut net, peer, None).0);
    let room = net.create(a, RoomAccess::Public, false);
    for peer in [b, c] {
        join_base(&mut net, peer, &room);
        command(
            &mut net,
            peer,
            json!({"type":"relay_capacity","roomId":room,"capacity":1}),
        );
    }
    let sibling = publish(&mut net, x, &room, "screen");
    subscribe_screen(&mut net, y, sibling);
    let stable = screen_input(&net, y, xs, sibling).unwrap();
    command(
        &mut net,
        y,
        json!({"type":"flow_state","pairId":stable.0,"flowId":stable.1.id,"state":"decoded"}),
    );
    let picture = publish(&mut net, a, &room, "screen");
    let limit = |net: &mut RoomNetwork, limit| {
        command(
            net,
            a,
            json!({"type":"set_screen_direct_limit","publicationId":picture,"limit":limit}),
        )
    };
    limit(&mut net, 2);
    for peer in [b, c] {
        subscribe_screen(&mut net, peer, picture);
        let (pair, flow) = screen_input(&net, peer, as_, picture).unwrap();
        command(
            &mut net,
            peer,
            json!({"type":"flow_state","pairId":pair,"flowId":flow.id,"state":"decoded"}),
        );
    }
    let count = |net: &RoomNetwork| {
        [b, c]
            .into_iter()
            .filter(|peer| screen_input(net, *peer, as_, picture).is_some_and(|(_, f)| f.selected))
            .count()
    };
    assert_eq!(count(&net), 2);
    limit(&mut net, 1);
    assert_eq!(count(&net), 2);
    assert_eq!(screen_input(&net, y, xs, sibling), Some(stable));
    let (peer, (pair, flow)) = [(b, cs), (c, bs)]
        .into_iter()
        .find_map(|(peer, sender)| {
            screen_input(&net, peer, sender, picture).map(|binding| (peer, binding))
        })
        .expect("alternate flow");
    assert!(!flow.selected);
    command(
        &mut net,
        peer,
        json!({"type":"flow_state","pairId":pair,"flowId":flow.id,"state":"switch_ready"}),
    );
    let sender = if peer == b { cs } else { bs };
    assert!(screen_input(&net, peer, sender, picture)
        .is_some_and(|(id, selected)| id == pair && selected.id == flow.id && selected.selected));
    assert_eq!(count(&net), 1);
    assert_eq!(screen_input(&net, y, xs, sibling), Some(stable));
}

#[test]
fn file_receivers_in_one_or_two_rooms_share_the_discovery_slot() {
    for separate_rooms in [false, true] {
        let mut network = RoomNetwork::new();
        let sockets = [(); 5].map(|_| Uuid::new_v4());
        let ids = sockets.map(|c| join(&mut network, c, None).0);
        let mut make_chain = |members: &[usize]| {
            let host = sockets[members[0]];
            let room = network.create(host, RoomAccess::Public, false);
            command(
                &mut network,
                host,
                json!({"type":"update_room","roomId":room,"name":"Files","icon":"couch","access":"public","hidden":false,"relayCapacity":1}),
            );
            for peers in members.windows(2) {
                let parent = peers[0];
                let child = peers[1];
                join_base(&mut network, sockets[child], &room);
                let id = pair(&network, sockets[child], ids[parent], &room).id;
                for socket in [sockets[parent], sockets[child]] {
                    command(
                        &mut network,
                        socket,
                        json!({"type":"link_state","pairId":id,"state":"connected"}),
                    );
                    command(
                        &mut network,
                        socket,
                        json!({"type":"base_state","roomId":room,"pairId":id,"ready":true}),
                    );
                }
            }
            room
        };
        let first_room = make_chain(if separate_rooms {
            &[0, 1, 2]
        } else {
            &[0, 1, 2, 3]
        });
        let (second_room, sender, receiver) = if separate_rooms {
            (make_chain(&[3, 1, 4]), 3, 4)
        } else {
            (first_room.clone(), 1, 3)
        };
        let mut receive = |room: &str, source: usize, viewer: usize| {
            let (seq, attachment) = offer_file(&mut network, sockets[source], room, "test.bin");
            command(
                &mut network,
                sockets[viewer],
                json!({"type":"file_receive","roomId":room,"messageSeq":seq,"attachmentId":attachment.id,"enabled":true}),
            );
        };
        receive(&first_room, 0, 2);
        receive(&second_room, sender, receiver);
        let shortcut = |n: &RoomNetwork, source: usize, viewer: usize| {
            n.state(sockets[viewer])
                .pairs
                .iter()
                .find(|p| p.peer_id == ids[source])
                .map(|p| p.id)
        };
        let first = shortcut(&network, 0, 2);
        let second = shortcut(&network, sender, receiver);
        assert_ne!(first.is_some(), second.is_some());
        let (a, b, trial) = first
            .map(|id| (0, 2, id))
            .unwrap_or_else(|| (sender, receiver, second.unwrap()));
        for socket in [sockets[a], sockets[b]] {
            command(
                &mut network,
                socket,
                json!({"type":"link_state","pairId":trial,"state":"connected"}),
            );
        }
        assert_eq!(shortcut(&network, a, b), Some(trial));
        assert!(shortcut(&network, 0, 2).is_some());
        assert!(shortcut(&network, sender, receiver).is_some());
        command(&mut network, sockets[2], json!({"type":"leave"}));
        command(&mut network, sockets[receiver], json!({"type":"leave"}));
        for (source, viewer) in [(0, 2), (sender, receiver)] {
            assert!(network
                .state(sockets[source])
                .pairs
                .iter()
                .all(|p| p.peer_id != ids[viewer]));
        }
    }
}

#[test]
fn cancelling_file_or_screen_preserves_the_other_on_the_same_pair() {
    for cancel_file in [false, true] {
        let mut network = RoomNetwork::new();
        let [source, viewer] = [1, 2].map(Uuid::from_u128);
        let (upstream, _) = join(&mut network, source, None);
        join(&mut network, viewer, None);
        let room = network.create(source, RoomAccess::Public, false);
        let screen = publish(&mut network, source, &room, "screen");
        subscribe_screen(&mut network, viewer, screen);
        let (shared, flow) = screen_input(&network, viewer, upstream, screen).unwrap();
        let (seq, attachment) = offer_file(&mut network, source, &room, "shared.bin");
        let receive = |n: &mut RoomNetwork, enabled| {
            command(
                n,
                viewer,
                json!({"type":"file_receive","roomId":room,"messageSeq":seq,"attachmentId":attachment.id,"enabled":enabled}),
            )
        };
        receive(&mut network, true);
        for socket in [source, viewer] {
            command(
                &mut network,
                socket,
                json!({"type":"link_state","pairId":shared,"state":"connected"}),
            );
            command(
                &mut network,
                socket,
                json!({"type":"base_state","roomId":room,"pairId":shared,"ready":true}),
            );
        }
        command(
            &mut network,
            viewer,
            json!({"type":"flow_state","pairId":shared,"flowId":flow.id,"state":"decoded"}),
        );
        assert_eq!(network.state(viewer).files[0].upstream, Some(upstream));
        if cancel_file {
            receive(&mut network, false);
            assert!(network.state(viewer).files.iter().all(|f| !f.receiving));
            assert_eq!(
                screen_input(&network, viewer, upstream, screen),
                Some((shared, flow))
            );
        } else {
            command(
                &mut network,
                viewer,
                json!({"type":"subscribe","publicationId":screen,"enabled":false}),
            );
            assert!(screen_input(&network, viewer, upstream, screen).is_none());
            assert_eq!(pair(&network, viewer, upstream, &room).id, shared);
            assert_eq!(network.state(viewer).files[0].upstream, Some(upstream));
        }
    }
}

#[test]
fn room_capacity_changes_apply_to_an_active_screen() {
    let mut network = RoomNetwork::new();
    let host = Uuid::from_u128(1);
    let (source, _) = join(&mut network, host, None);
    let viewers = [2, 3, 4].map(Uuid::from_u128);
    let room = network.create(host, RoomAccess::Public, false);
    let update = |network: &mut RoomNetwork, capacity| {
        command(
            network,
            host,
            json!({
                "type":"update_room","roomId":room,"name":"Capacity","icon":"couch",
                "access":"public","hidden":false,"relayCapacity":capacity
            }),
        )
    };
    update(&mut network, 1);
    let screen = publish(&mut network, host, &room, "screen");
    let inputs =
        |network: &RoomNetwork| viewers.map(|viewer| screen_input(network, viewer, source, screen));
    let decode = |network: &mut RoomNetwork, viewer| {
        let (pair, flow) = screen_input(network, viewer, source, screen).unwrap();
        command(
            network,
            viewer,
            json!({"type":"flow_state","pairId":pair,"flowId":flow.id,"state":"decoded"}),
        );
    };
    for viewer in viewers {
        join(&mut network, viewer, None);
        // A receiver cannot absorb another viewer when the source limit drops.
        command(
            &mut network,
            viewer,
            json!({"type":"relay_capacity","roomId":room,"capacity":0}),
        );
        subscribe_screen(&mut network, viewer, screen);
        if viewer == viewers[0] {
            decode(&mut network, viewer);
        }
    }
    let [Some(first), None, None] = inputs(&network) else {
        panic!("only the first subscriber should have an input");
    };
    update(&mut network, 3);
    assert_eq!(inputs(&network)[0], Some(first));
    for viewer in &viewers[1..] {
        decode(&mut network, *viewer);
    }
    let admitted = inputs(&network);
    update(&mut network, 1);
    assert_eq!(inputs(&network), admitted);
    for (now, remaining) in [(20_100, 2), (40_100, 1)] {
        let effects = network.authority.expire(now);
        network.deliver(effects);
        let current = inputs(&network);
        assert_eq!(current.iter().flatten().count(), remaining);
        assert!(current
            .iter()
            .zip(admitted)
            .all(|(input, old)| input.is_none() || *input == old));
    }
}
