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

#[test]
fn cold_voice_file_and_watch_byte_repair_use_the_only_room_reader() {
    use std::collections::BTreeSet;

    for kind in ["voice", "file", "watch"] {
        let mut network = RoomNetwork::new();
        let [source, helper, receiver] = [(); 3].map(|_| Uuid::new_v4());
        let (source_id, _) = join(&mut network, source, None);
        let (helper_id, _) = join(&mut network, helper, None);
        let (receiver_id, _) = join(&mut network, receiver, None);
        let room = network.create(source, RoomAccess::Public, false);
        for peer in [source, helper, receiver] {
            browse(&mut network, peer, &room, true);
        }
        let publication = if kind == "voice" {
            voice(&mut network, source, &room, true);
            voice(&mut network, receiver, &room, true);
            Some(publish(&mut network, source, &room, "voice"))
        } else if kind == "watch" {
            let activity = Uuid::new_v4();
            command(
                &mut network,
                source,
                json!({"type":"start_watch","roomId":room,"id":activity,
                "source":{"kind":"media","url":"https://example.com/movie.mp4"},
                "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":0},
                "byteSource":{"sessionId":source_id,"resourceId":Uuid::new_v4(),"format":"file"}}),
            );
            command(
                &mut network,
                receiver,
                json!({"type":"join_watch","roomId":room,"id":activity,"mode":"peer"}),
            );
            None
        } else {
            let (seq, attachment) = offer_file(&mut network, source, &room, "held.bin");
            command(
                &mut network,
                receiver,
                json!({"type":"file_receive","roomId":room,
                "messageSeq":seq,"attachmentId":attachment.id,"enabled":true}),
            );
            None
        };
        let direct = pair(&network, source, receiver_id, &room);
        assert!(network.state(helper).pairs.is_empty());
        command(
            &mut network,
            source,
            json!({"type":"link_state","pairId":direct.id,"state":"failed"}),
        );

        let mut confirmed = BTreeSet::new();
        for _ in 0..2 {
            let edge = network
                .state(helper)
                .pairs
                .iter()
                .find(|p| !confirmed.contains(&p.id))
                .expect("failed direct demand should discover the reader")
                .clone();
            confirmed.insert(edge.id);
            let peer = if edge.peer_id == source_id {
                source
            } else {
                receiver
            };
            for socket in [helper, peer] {
                command(
                    &mut network,
                    socket,
                    json!({"type":"link_state","pairId":edge.id,"state":"connected"}),
                );
            }
        }
        for (socket, peer_id) in [(source, source_id), (receiver, receiver_id)] {
            let edge = pair(&network, helper, peer_id, &room);
            for endpoint in [helper, socket] {
                if let Some(publication) = publication {
                    assert!(screen_input(&network, receiver, helper_id, publication).is_none());
                } else if kind == "watch" {
                    assert!(network.state(receiver).watch_bytes[0].upstream.is_none());
                } else {
                    assert!(network.state(receiver).files[0].upstream.is_none());
                }
                command(
                    &mut network,
                    endpoint,
                    json!({"type":"base_state","roomId":room,"pairId":edge.id,"ready":true}),
                );
            }
        }
        if let Some(publication) = publication {
            let (first, transit) = screen_input(&network, helper, source_id, publication).unwrap();
            let (last, delivery) =
                screen_input(&network, receiver, helper_id, publication).unwrap();
            assert_eq!(delivery.input_flow_id, Some(transit.id));
            for (socket, pair, flow, state) in [
                (helper, first, transit.id, "forwardable"),
                (receiver, last, delivery.id, "decoded"),
            ] {
                command(
                    &mut network,
                    socket,
                    json!({"type":"flow_state","pairId":pair,"flowId":flow,"state":state}),
                );
            }
        } else if kind == "watch" {
            let hop = &network.state(helper).watch_bytes[0];
            assert_eq!(hop.upstream, Some(source_id));
            assert_eq!(hop.downstream, [receiver_id]);
            assert_eq!(
                network.state(receiver).watch_bytes[0].upstream,
                Some(helper_id)
            );
        } else {
            let hop = &network.state(helper).files[0];
            assert_eq!(hop.upstream, Some(source_id));
            assert_eq!(hop.downstream, [receiver_id]);
            assert_eq!(network.state(receiver).files[0].upstream, Some(helper_id));
            deliver_repaired_file(
                &network,
                [
                    (source, source_id),
                    (helper, helper_id),
                    (receiver, receiver_id),
                ],
            );
        }
        browse(&mut network, helper, &room, false);
        assert!(network.state(helper).files.is_empty());
        assert!(network
            .state(helper)
            .pairs
            .iter()
            .all(|p| p.incoming.is_empty() && p.outgoing.is_empty() && !p.rooms.contains(&room)));
    }
}

fn deliver_repaired_file(network: &RoomNetwork, peers: [(Uuid, Uuid); 3]) {
    use piik_channel_core::{
        file_delivery::{FileDelivery, FileEffect},
        file_room::FileKey,
    };
    use std::collections::{BTreeMap, VecDeque};

    let [(source, source_id), _, (receiver, receiver_id)] = peers;
    let plans = &network.state(receiver).files;
    let plan = &plans[0];
    let key = FileKey {
        room_id: plan.room_id.clone(),
        message_seq: plan.message_seq,
        attachment_id: plan.attachment.id,
    };
    let bytes = network.state(source).files[0].attachment.name.as_bytes();
    let mut nodes = BTreeMap::new();
    for (socket, session) in peers {
        let state = network.state(socket);
        let mut node = FileDelivery::new(session);
        let neighbors = state
            .pairs
            .iter()
            .map(|p| (p.peer_id, p.rooms.clone()))
            .collect();
        assert!(node.update(state.files.clone(), neighbors, 0).is_empty());
        nodes.insert(session, node);
    }
    let mut queue = VecDeque::new();
    for effect in nodes.get_mut(&receiver_id).unwrap().start(key) {
        queue.push_back((receiver_id, effect));
    }
    let mut received = Vec::new();
    let mut completed = false;
    while let Some((from, effect)) = queue.pop_front() {
        let (owner, next) = match effect {
            FileEffect::SendControl { peer, control } => (
                peer,
                nodes.get_mut(&peer).unwrap().control(from, control, 0),
            ),
            FileEffect::SendChunk { peer, frame, .. } => (
                peer,
                nodes.get_mut(&peer).unwrap().chunk(from, &frame).unwrap(),
            ),
            FileEffect::Read {
                key,
                offset,
                length,
                request_id,
            } => {
                assert_eq!(from, source_id);
                let range = offset as usize..offset as usize + length;
                (
                    from,
                    nodes.get_mut(&from).unwrap().read_result(
                        &key,
                        offset,
                        request_id,
                        bytes[range].to_vec(),
                    ),
                )
            }
            FileEffect::Write { key, offset, bytes } => {
                assert_eq!(from, receiver_id);
                assert_eq!(offset as usize, received.len());
                received.extend_from_slice(&bytes);
                (
                    from,
                    nodes
                        .get_mut(&from)
                        .unwrap()
                        .written(&key, offset, bytes.len()),
                )
            }
            FileEffect::Complete { .. } => {
                assert_eq!(from, receiver_id);
                completed = true;
                continue;
            }
            FileEffect::Failed { code, .. } => panic!("file transfer failed: {code}"),
        };
        queue.extend(next.into_iter().map(|effect| (owner, effect)));
    }
    assert!(completed);
    assert_eq!(received, bytes);
}

#[test]
fn background_file_trial_survives_another_room_link_failure_until_host_ack() {
    let mut net = RoomNetwork::new();
    let [source, helper, receiver, other] = [(); 4].map(|_| Uuid::new_v4());
    let [src, _, rx, _] = [source, helper, receiver, other].map(|p| join(&mut net, p, None).0);
    let room = net.create(source, RoomAccess::Public, false);
    browse(&mut net, helper, &room, true);
    join_base(&mut net, other, &room);
    command(
        &mut net,
        other,
        json!({"type":"relay_capacity","roomId":room,"capacity":0}),
    );
    let (seq, file) = offer_file(&mut net, source, &room, "background.bin");
    command(
        &mut net,
        receiver,
        json!({"type":"file_receive","roomId":room,"messageSeq":seq,
        "attachmentId":file.id,"enabled":true}),
    );
    let direct = pair(&net, source, rx, &room);
    command(
        &mut net,
        source,
        json!({"type":"link_state","pairId":direct.id,"state":"failed"}),
    );
    let trial = net.state(helper).pairs[0].id;
    let unrelated = pair(&net, other, src, &room).id;
    let failure = json!({"type":"link_state","pairId":unrelated,"state":"failed"});
    let effects = net.authority.handle(
        other,
        piik_channel_core::wire::Request::parse(&failure.to_string()).unwrap(),
        100,
    );
    assert!(effects
        .events
        .iter()
        .any(|(_, e)| matches!(e, Event::HostInput{input,..} if !input.failed_pairs.is_empty())));
    for (_, e) in effects
        .events
        .iter()
        .filter(|(socket, _)| *socket == helper)
    {
        if let Event::State { state } = e {
            assert!(
                state.pairs.iter().any(|pair| pair.id == trial),
                "lost pending background file trial before room ACK"
            );
        }
    }
    net.deliver(effects);
    assert!(net.state(helper).pairs.iter().any(|pair| pair.id == trial));
}

#[test]
fn new_room_flow_consumes_an_existing_physical_failure() {
    let mut net = RoomNetwork::new();
    let [source, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let (source_id, _) = join(&mut net, source, None);
    let (receiver_id, credential) = join(&mut net, receiver, None);
    let room = net.create(source, RoomAccess::Public, false);
    let other = net.create(source, RoomAccess::Public, false);
    let screen = publish(&mut net, source, &room, "screen");
    let sibling = publish(&mut net, source, &other, "screen");
    let healthy = Uuid::new_v4();
    join(&mut net, healthy, None);
    subscribe_screen(&mut net, healthy, sibling);
    let shared = screen_input(&net, healthy, source_id, sibling).unwrap().0;
    for endpoint in [healthy, source] {
        command(
            &mut net,
            endpoint,
            json!({"type":"link_state","pairId":shared,"state":"connected"}),
        );
    }
    subscribe_screen(&mut net, receiver, screen);
    let direct = screen_input(&net, receiver, source_id, screen).unwrap().0;
    // The second room has planned its first lease but the domain hasn't received it.
    let request = json!({"type":"subscribe","publicationId":sibling,"enabled":true});
    let effects = net.authority.handle(
        receiver,
        piik_channel_core::wire::Request::parse(&request.to_string()).unwrap(),
        100,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { room_id, input } if room_id == other => Some(input),
            _ => None,
        })
        .unwrap();
    let delayed = net.host_turn(&other, input);
    command(
        &mut net,
        receiver,
        json!({"type":"link_state","pairId":direct,"state":"failed"}),
    );
    assert!(net.state(receiver).pairs.is_empty());
    let update = json!({"type":"host_output","roomId":other,"output":delayed});
    let repair = net.authority.handle(
        source,
        piik_channel_core::wire::Request::parse(&update.to_string()).unwrap(),
        100,
    );
    let edge = (source_id.min(receiver_id), source_id.max(receiver_id));
    assert!(repair.events.iter().any(|(_, event)| matches!(event,
        Event::HostInput { room_id, input } if room_id == &other && input.failed_pairs.iter()
            .any(|failure| (failure.first, failure.second) == edge))));
    net.deliver(repair);
    assert!(net
        .state(receiver)
        .pairs
        .iter()
        .all(|p| p.peer_id != source_id));
    assert_eq!(
        screen_input(&net, healthy, source_id, sibling).unwrap().0,
        shared
    );

    let resumed = Uuid::new_v4();
    net.command_at(
        resumed,
        json!({"type":"join","sessionId":receiver_id,
        "credential":credential,"name":"Returning receiver"}),
        101,
    );
    let fresh_room = net.create(source, RoomAccess::Public, false);
    let fresh_screen = publish(&mut net, source, &fresh_room, "screen");
    subscribe_screen(&mut net, resumed, fresh_screen);
    assert_ne!(
        screen_input(&net, resumed, source_id, fresh_screen)
            .unwrap()
            .0,
        direct
    );
}
