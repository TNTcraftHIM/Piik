use super::*;

#[test]
fn independent_room_catalogs_share_the_same_per_endpoint_source_rules() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let peers: Vec<_> = (0..20).map(|_| join(&mut channel, false)).collect();
    for room_id in ["living", "studio", "quiet"] {
        for peer in &peers {
            channel
                .handle(
                    peer.session_id,
                    Command::Voice {
                        room_id: room_id.into(),
                        joined: true,
                        muted: false,
                        deafened: false,
                    },
                    0,
                )
                .unwrap();
            for kind in [Kind::Screen, Kind::Voice] {
                channel
                    .handle(
                        peer.session_id,
                        Command::Publish {
                            publication: PublicationInput {
                                id: Uuid::new_v4(),
                                room_id: room_id.into(),
                                kind,
                                muted: false,
                            },
                        },
                        0,
                    )
                    .unwrap();
            }
        }
        assert_eq!(channel.rooms[room_id].publications().count(), 40);
    }
    assert_eq!(
        channel.snapshot(peers[0].session_id).publications.len(),
        120
    );
}

#[test]
fn revoking_private_relay_retires_its_subtree_without_changing_public_flow() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let source = join(&mut channel, false);
    let peers: Vec<_> = (0..3).map(|_| join(&mut channel, false)).collect();
    let id = "private".to_owned();
    let mut room = RoomState::new(
        id.clone(),
        "Private".into(),
        source.user_id,
        RoomAccess::Private,
        true,
        None,
    )
    .unwrap();
    room.grants.extend(peers.iter().map(|p| p.user_id));
    channel.rooms.insert(id.clone(), RoomRuntime::new(room));
    let private = Uuid::new_v4();
    channel
        .handle(
            source.session_id,
            Command::Publish {
                publication: PublicationInput {
                    id: private,
                    room_id: id.clone(),
                    kind: Kind::Screen,
                    muted: false,
                },
            },
            0,
        )
        .unwrap();
    let public = publish(&mut channel, source.session_id, Kind::Screen);
    for peer in peers.iter().take(2) {
        watch(&mut channel, peer.session_id, private);
    }
    let relay = peers[0].session_id;
    let pair = channel.snapshot(relay).pairs[0].id;
    channel
        .handle(
            relay,
            Command::FlowState {
                flow_id: channel
                    .snapshot(relay)
                    .pairs
                    .iter()
                    .find(|p| p.id == pair)
                    .unwrap()
                    .incoming
                    .iter()
                    .find(|flow| flow.publication_id == private)
                    .unwrap()
                    .id,
                pair_id: pair,
                state: FlowState::Forwardable,
            },
            0,
        )
        .unwrap();
    watch(&mut channel, peers[2].session_id, private);
    assert_eq!(parents(&channel, private)[&peers[2].session_id], relay);
    watch(&mut channel, relay, public);
    let public_pair = channel
        .snapshot(relay)
        .pairs
        .iter()
        .find(|p| p.incoming.iter().any(|flow| flow.publication_id == public))
        .unwrap()
        .id;
    channel
        .handle(
            source.session_id,
            Command::RevokeRoomAccess {
                room_id: id,
                user_id: peers[0].user_id,
            },
            0,
        )
        .unwrap();
    let plan = parents(&channel, private);
    assert!(!plan.contains_key(&relay));
    assert!(!plan.values().any(|parent| *parent == relay));
    assert!(plan.contains_key(&peers[2].session_id));
    assert!(channel.snapshot(relay).pairs.iter().any(
        |p| p.id == public_pair && p.incoming.iter().any(|flow| flow.publication_id == public)
    ));
}

fn join(channel: &mut Channel, owner: bool) -> Admitted {
    channel
        .join(
            Admission {
                signing_key: crate::conversation::SessionSigner::from_seed([1; 32]).signing_key(),
                name: "Friend",
                credential: None,
                key: Some(if owner { "owner" } else { "invite" }),
                resume: None,
            },
            Uuid::new_v4(),
            0,
        )
        .unwrap()
}

fn publish(channel: &mut Channel, session: Uuid, kind: Kind) -> Uuid {
    let id = Uuid::new_v4();
    channel
        .handle(
            session,
            Command::Publish {
                publication: PublicationInput {
                    id,
                    room_id: "living".into(),
                    kind,
                    muted: false,
                },
            },
            0,
        )
        .unwrap();
    id
}

fn watch(channel: &mut Channel, session: Uuid, publication: Uuid) {
    channel
        .handle(
            session,
            Command::Subscribe {
                publication_id: publication,
                enabled: true,
            },
            0,
        )
        .unwrap();
}

fn parents(channel: &Channel, publication: Uuid) -> BTreeMap<Uuid, Uuid> {
    channel
        .publication_room(publication)
        .unwrap()
        .flows()
        .filter(|flow| flow.publication_id == publication)
        .map(|flow| (flow.receiver, flow.sender))
        .collect()
}

fn voice(channel: &mut Channel, session: Uuid, joined: bool, muted: bool, deafened: bool) {
    channel
        .handle(
            session,
            Command::Voice {
                room_id: "living".into(),
                joined,
                muted,
                deafened,
            },
            0,
        )
        .unwrap();
}

#[test]
fn concurrent_sources_share_one_pair_and_retire_independently() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let first = join(&mut channel, true);
    let second = join(&mut channel, false);
    let a = publish(&mut channel, first.session_id, Kind::Screen);
    let b = publish(&mut channel, second.session_id, Kind::Screen);
    watch(&mut channel, first.session_id, b);
    watch(&mut channel, second.session_id, a);
    let before = channel.snapshot(first.session_id);
    assert_eq!(before.pairs.len(), 1);
    assert_eq!(
        before.pairs[0]
            .outgoing
            .iter()
            .map(|flow| flow.publication_id)
            .collect::<Vec<_>>(),
        vec![a]
    );
    assert_eq!(
        before.pairs[0]
            .incoming
            .iter()
            .map(|flow| flow.publication_id)
            .collect::<Vec<_>>(),
        vec![b]
    );
    channel
        .handle(
            first.session_id,
            Command::Unpublish { publication_id: a },
            0,
        )
        .unwrap();
    let after = channel.snapshot(first.session_id);
    assert_eq!(after.pairs[0].id, before.pairs[0].id);
    assert_eq!(
        after.pairs[0]
            .incoming
            .iter()
            .map(|flow| flow.publication_id)
            .collect::<Vec<_>>(),
        vec![b]
    );
    assert!(after.pairs[0].outgoing.is_empty());
    assert!(channel
        .handle(
            first.session_id,
            Command::Unpublish { publication_id: a },
            0
        )
        .is_ok());
    assert!(channel
        .handle(
            first.session_id,
            Command::Unpublish { publication_id: b },
            0
        )
        .is_err());
    assert!(channel
        .handle(
            second.session_id,
            Command::Publish {
                publication: PublicationInput {
                    id: a,
                    room_id: "living".into(),
                    kind: Kind::Screen,
                    muted: false
                }
            },
            0
        )
        .is_err());
}

#[test]
fn selective_subscriptions_ready_relays_and_failed_pair_ids_are_fenced() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let source = join(&mut channel, true);
    let endpoints = [
        join(&mut channel, false),
        join(&mut channel, false),
        join(&mut channel, false),
    ];
    let publication = publish(&mut channel, source.session_id, Kind::Screen);
    assert!(channel.snapshot(endpoints[0].session_id).pairs.is_empty());
    for endpoint in &endpoints {
        watch(&mut channel, endpoint.session_id, publication);
    }
    let source_pairs = channel.snapshot(source.session_id).pairs;
    assert_eq!(source_pairs.len(), 2);
    let relay = source_pairs[0].peer_id;
    channel
        .handle(
            relay,
            Command::FlowState {
                flow_id: source_pairs[0]
                    .outgoing
                    .iter()
                    .find(|flow| flow.publication_id == publication)
                    .unwrap()
                    .id,
                pair_id: source_pairs[0].id,
                state: FlowState::Forwardable,
            },
            0,
        )
        .unwrap();
    assert_eq!(parents(&channel, publication).len(), 3);
    assert_eq!(channel.snapshot(source.session_id).pairs.len(), 2);
    let relay_snapshot = channel.snapshot(relay);
    assert!(relay_snapshot.pairs.iter().any(|pair| pair
        .outgoing
        .iter()
        .any(|flow| flow.publication_id == publication)));
    let healthy = source_pairs[1].clone();
    channel
        .handle(
            relay,
            Command::LinkState {
                pair_id: source_pairs[0].id,
                state: LinkState::Failed,
            },
            0,
        )
        .unwrap();
    assert!(channel.peer(relay, source_pairs[0].id).is_none());
    assert_eq!(
        parents(&channel, publication).get(&healthy.peer_id),
        Some(&source.session_id)
    );
    assert!(channel
        .handle(
            relay,
            Command::FlowState {
                flow_id: source_pairs[0]
                    .outgoing
                    .iter()
                    .find(|flow| flow.publication_id == publication)
                    .unwrap()
                    .id,
                pair_id: source_pairs[0].id,
                state: FlowState::Forwardable
            },
            0
        )
        .is_err());
}

#[test]
fn deafen_preserves_voice_routes_and_role_revocation_preserves_identity() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let owner = join(&mut channel, true);
    let friend = join(&mut channel, false);
    voice(&mut channel, owner.session_id, true, false, false);
    voice(&mut channel, friend.session_id, true, false, false);
    let owner_voice = publish(&mut channel, owner.session_id, Kind::Voice);
    let friend_voice = publish(&mut channel, friend.session_id, Kind::Voice);
    let screen = publish(&mut channel, friend.session_id, Kind::Screen);
    watch(&mut channel, owner.session_id, screen);
    assert!(channel
        .snapshot(friend.session_id)
        .subscriptions
        .contains(&owner_voice));
    voice(&mut channel, friend.session_id, true, true, true);
    channel
        .handle(
            friend.session_id,
            Command::Publish {
                publication: PublicationInput {
                    id: friend_voice,
                    room_id: "living".into(),
                    kind: Kind::Voice,
                    muted: false,
                },
            },
            0,
        )
        .unwrap();
    assert!(
        channel
            .publication_room(friend_voice)
            .unwrap()
            .publication(friend_voice)
            .unwrap()
            .muted
    );
    assert!(channel
        .snapshot(friend.session_id)
        .subscriptions
        .contains(&owner_voice));
    assert!(channel
        .snapshot(owner.session_id)
        .subscriptions
        .contains(&friend_voice));
    assert!(channel
        .snapshot(owner.session_id)
        .subscriptions
        .contains(&screen));
    channel
        .handle(
            owner.session_id,
            Command::SetRoles {
                user_id: friend.user_id,
                roles: vec![],
            },
            0,
        )
        .unwrap();
    assert!(channel.identity.sessions.contains_key(&friend.session_id));
    assert!(channel.identity.users.contains_key(&friend.user_id));
    assert!(channel.publication_room(friend_voice).is_none());
    assert!(channel.publication_room(screen).is_none());
    assert!(channel.publication_room(owner_voice).is_some());
    assert!(channel
        .register_host(
            friend.session_id,
            channel.identity.sessions[&friend.session_id]
                .connection
                .unwrap(),
            RoomSummary {
                id: "forbidden".into(),
                name: "Forbidden".into(),
                creator_id: friend.user_id,
                access: RoomAccess::Public,
                hidden: false,
                has_password: false,
            },
            None,
        )
        .is_err());
}

#[test]
fn history_requests_and_signal_tracks_use_the_actual_authority() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let first = join(&mut channel, true);
    let second = join(&mut channel, false);
    channel
        .handle(
            first.session_id,
            Command::Browse {
                room_id: "living".into(),
                active: true,
            },
            0,
        )
        .unwrap();
    channel
        .handle(
            second.session_id,
            Command::Browse {
                room_id: "quiet".into(),
                active: true,
            },
            0,
        )
        .unwrap();
    let message = channel
        .handle(
            first.session_id,
            Command::Chat {
                attachments: vec![],
                room_id: "living".into(),
                text: "Hello".into(),
                nonce: "once".into(),
            },
            10,
        )
        .unwrap();
    assert!(message.events.is_empty());
    let Some(HistoryRequest::Send { room_id, draft }) = message.history else {
        panic!("chat must be committed by the room store");
    };
    assert_eq!(room_id, "living");
    assert_eq!(draft.user_id, first.user_id);
    assert_eq!(draft.nonce, "once");
    assert_eq!(
        channel.history_audience("living"),
        vec![channel.identity.sessions[&first.session_id]
            .connection
            .unwrap()]
    );
    let source = publish(&mut channel, first.session_id, Kind::Screen);
    let own = publish(&mut channel, second.session_id, Kind::Screen);
    watch(&mut channel, second.session_id, source);
    let pair_id = channel.snapshot(first.session_id).pairs[0].id;
    let spoof = Signal {
        resync: None,
        exchange_id: None,
        description: None,
        candidate: None,
        tracks: Some(vec![Track {
            flow_id: own,
            stream_id: "stream".into(),
        }]),
    };
    let filtered = channel
        .handle(
            first.session_id,
            Command::Signal {
                pair_id,
                payload: spoof,
            },
            0,
        )
        .unwrap();
    assert!(
        matches!(&filtered.events[..], [(_, Event::Signal { payload, .. })]
        if payload.tracks.as_ref().is_some_and(Vec::is_empty))
    );
    let payload = Signal {
        resync: None,
        exchange_id: None,
        description: None,
        candidate: None,
        tracks: Some(vec![Track {
            flow_id: channel.snapshot(first.session_id).pairs[0]
                .outgoing
                .iter()
                .find(|flow| flow.publication_id == source)
                .unwrap()
                .id,
            stream_id: "stream".into(),
        }]),
    };
    let forwarded = channel
        .handle(first.session_id, Command::Signal { pair_id, payload }, 0)
        .unwrap();
    assert_eq!(forwarded.events.len(), 1);
    assert_eq!(forwarded.events[0].0, second.session_id);

    // A physical pair combines authorized flows across rooms.
    let tracks: Vec<_> = (0..100)
        .map(|_| Track {
            flow_id: Uuid::new_v4(),
            stream_id: Uuid::new_v4().to_string(),
        })
        .collect();
    channel.transports.reconcile(
        tracks.iter().map(|track| crate::transport::Flow {
            id: track.flow_id,
            publication_id: Uuid::new_v4(),
            input_flow_id: None,
            sender: first.session_id,
            receiver: second.session_id,
            selected: true,
        }),
        [],
    );
    let pair_id = channel.snapshot(first.session_id).pairs[0].id;
    let forwarded = channel
        .handle(
            first.session_id,
            Command::Signal {
                pair_id,
                payload: Signal {
                    resync: None,
                    exchange_id: None,
                    description: None,
                    candidate: None,
                    tracks: Some(tracks),
                },
            },
            0,
        )
        .unwrap();
    assert!(
        matches!(&forwarded.events[0].1, Event::Signal { payload, .. }
        if payload.tracks.as_ref().unwrap().len() == 100)
    );
}

#[test]
fn session_retirement_does_not_close_another_sources_surviving_pair() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let a = join(&mut channel, true);
    let b = join(&mut channel, false);
    let c = join(&mut channel, false);
    let source = publish(&mut channel, a.session_id, Kind::Screen);
    let other_source = publish(&mut channel, b.session_id, Kind::Screen);
    watch(&mut channel, c.session_id, source);
    watch(&mut channel, c.session_id, other_source);
    let other_pair = channel.snapshot(b.session_id).pairs[0].id;
    channel.handle(a.session_id, Command::Leave, 0).unwrap();
    assert!(channel.publication_room(source).is_none());
    assert!(channel.publication_room(other_source).is_some());
    assert_eq!(channel.snapshot(b.session_id).pairs[0].id, other_pair);
}

#[test]
fn unknown_sender_fields_fail_with_the_request_id_intact() {
    let request = Request::parse(
        r#"{"type":"chat","requestId":"operation","roomId":"living","text":"spoof","nonce":"n","userId":"other"}"#,
    );
    assert!(
        matches!(request, Err((Some(request_id), "invalid_request")) if request_id == "operation")
    );
}

#[test]
fn text_limits_match_browser_utf16_snapshots_and_unicode_chat() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let owner = join(&mut channel, true);
    assert!(channel
        .handle(
            owner.session_id,
            Command::SetName {
                name: "😀".repeat(21)
            },
            0
        )
        .is_err());
    assert!(channel
        .handle(
            owner.session_id,
            Command::Chat {
                attachments: vec![],
                room_id: "living".into(),
                text: "😀".repeat(2000),
                nonce: "limit".into()
            },
            0
        )
        .is_ok());
    assert!(channel
        .handle(
            owner.session_id,
            Command::Chat {
                attachments: vec![],
                room_id: "living".into(),
                text: "😀".repeat(2001),
                nonce: "excess".into()
            },
            0
        )
        .is_err());
}

#[test]
fn connected_screen_without_media_proof_expires_to_a_ready_relay() {
    let mut authority = crate::Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
    let connections = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let mut sessions = Vec::new();
    for connection in connections {
        let effects = authority.handle(
            connection,
            Request::parse(
                &serde_json::json!({
                    "type":"join", "key":"invite", "name":"Screen participant",
                    "signingKey":crate::conversation::SessionSigner::from_seed([1;32]).signing_key()
                })
                .to_string(),
            )
            .unwrap(),
            0,
        );
        sessions.push(
            effects
                .events
                .into_iter()
                .find_map(|(_, event)| match event {
                    Event::Welcome { session_id, .. } => Some(session_id),
                    _ => None,
                })
                .unwrap(),
        );
    }
    let publication = Uuid::new_v4();
    let commands = [
        (
            connections[0],
            serde_json::json!({"type":"publish", "publication":{"id":publication,"roomId":"living","kind":"screen","muted":false}}),
        ),
        (
            connections[1],
            serde_json::json!({"type":"subscribe","publicationId":publication,"enabled":true}),
        ),
        (
            connections[2],
            serde_json::json!({"type":"subscribe","publicationId":publication,"enabled":true}),
        ),
    ];
    for (connection, command) in commands {
        let effects =
            authority.handle(connection, Request::parse(&command.to_string()).unwrap(), 0);
        assert!(!effects
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::Error { .. })));
    }
    let a = authority.channel.snapshot(sessions[1]).pairs[0].clone();
    let b = authority.channel.snapshot(sessions[2]).pairs[0].clone();
    let a_flow = a
        .incoming
        .iter()
        .find(|flow| flow.publication_id == publication)
        .unwrap()
        .id;
    let b_flow = b
        .incoming
        .iter()
        .find(|flow| flow.publication_id == publication)
        .unwrap()
        .id;
    for (connection, pair_id) in [
        (connections[0], a.id),
        (connections[1], a.id),
        (connections[0], b.id),
        (connections[2], b.id),
    ] {
        authority.handle(
            connection,
            Request {
                request_id: None,
                command: Command::LinkState {
                    pair_id,
                    state: LinkState::Connected,
                },
            },
            0,
        );
    }
    authority.handle(
        connections[1],
        Request {
            request_id: None,
            command: Command::FlowState {
                flow_id: a_flow,
                pair_id: a.id,
                state: FlowState::Forwardable,
            },
        },
        0,
    );
    authority.expire(20_000);
    let retained = authority.channel.snapshot(sessions[1]);
    assert!(
        retained
            .pairs
            .iter()
            .any(|pair| pair.id == a.id && pair.incoming.iter().any(|flow| flow.id == a_flow)),
        "the proven source-to-A flow and physical pair survive"
    );
    let repaired = authority.channel.snapshot(sessions[2]);
    assert!(
        !repaired
            .pairs
            .iter()
            .any(|pair| pair.incoming.iter().any(|flow| flow.id == b_flow)),
        "connected PC without media proof must not retain its expired flow"
    );
    assert!(
        repaired.pairs.iter().any(|pair| pair.peer_id == sessions[1]
            && pair
                .incoming
                .iter()
                .any(|flow| flow.publication_id == publication)),
        "B must try the already-proven A relay"
    );
}

#[test]
fn retired_screen_binding_does_not_block_shared_pair_voice_sdp() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let source = join(&mut channel, true);
    let viewer = join(&mut channel, false);
    for endpoint in [source.session_id, viewer.session_id] {
        voice(&mut channel, endpoint, true, false, false);
    }
    let speaking = publish(&mut channel, source.session_id, Kind::Voice);
    let picture = publish(&mut channel, source.session_id, Kind::Screen);
    watch(&mut channel, viewer.session_id, picture);
    let reverse = publish(&mut channel, viewer.session_id, Kind::Voice);
    let shared = channel.snapshot(source.session_id).pairs[0].clone();
    let mut tracks: Vec<_> = shared
        .outgoing
        .iter()
        .map(|flow| Track {
            flow_id: flow.id,
            stream_id: flow.publication_id.to_string(),
        })
        .collect();
    assert_eq!(tracks.len(), 2);
    let reverse_flow = shared
        .incoming
        .iter()
        .find(|flow| flow.publication_id == reverse)
        .unwrap()
        .id;
    tracks.push(Track {
        flow_id: reverse_flow,
        stream_id: "reverse-voice".into(),
    });
    tracks.push(Track {
        flow_id: Uuid::new_v4(),
        stream_id: "unknown".into(),
    });
    let voice_flow = shared
        .outgoing
        .iter()
        .find(|flow| flow.publication_id == speaking)
        .unwrap()
        .id;
    let exchange = Uuid::new_v4();
    let payload = Signal {
        resync: None,
        exchange_id: Some(exchange),
        description: Some(Description {
            kind: "offer".into(),
            sdp: Some("v=0\r\n".into()),
        }),
        candidate: None,
        tracks: Some(tracks),
    };
    channel
        .handle(
            source.session_id,
            Command::Unpublish {
                publication_id: picture,
            },
            0,
        )
        .unwrap();
    let retained = channel.snapshot(source.session_id).pairs[0].clone();
    assert_eq!(retained.id, shared.id);
    assert_eq!(retained.outgoing.len(), 1);
    assert_eq!(retained.outgoing[0].id, voice_flow);
    let forwarded = channel
        .handle(
            source.session_id,
            Command::Signal {
                pair_id: shared.id,
                payload,
            },
            0,
        )
        .expect("a retired screen binding must not discard SDP for the still-assigned voice pair");
    assert!(
        matches!(&forwarded.events[..], [(recipient, Event::Signal { payload, .. })]
        if *recipient == viewer.session_id && payload.exchange_id == Some(exchange)
        && payload.description.as_ref().is_some_and(|description| description.kind == "offer" && description.sdp.as_deref() == Some("v=0\r\n"))
        && payload.tracks.as_ref().is_some_and(|tracks|tracks.len()==1 && tracks[0].flow_id==voice_flow))
    );
}
