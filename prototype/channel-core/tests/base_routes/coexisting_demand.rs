use super::*;

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
