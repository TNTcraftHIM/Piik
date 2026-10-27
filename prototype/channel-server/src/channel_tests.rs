use super::*;

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
                publication_id: private,
                pair_id: pair,
                ready: true,
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
        .find(|p| p.incoming.contains(&public))
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
    assert!(channel
        .snapshot(relay)
        .pairs
        .iter()
        .any(|p| p.id == public_pair && p.incoming.contains(&public)));
}

fn join(channel: &mut Channel, owner: bool) -> Admitted {
    channel
        .join(
            Admission {
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
    assert_eq!(before.pairs[0].outgoing, vec![a]);
    assert_eq!(before.pairs[0].incoming, vec![b]);
    channel
        .handle(
            first.session_id,
            Command::Unpublish { publication_id: a },
            0,
        )
        .unwrap();
    let after = channel.snapshot(first.session_id);
    assert_eq!(after.pairs[0].id, before.pairs[0].id);
    assert_eq!(after.pairs[0].incoming, vec![b]);
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
                publication_id: publication,
                pair_id: source_pairs[0].id,
                ready: true,
            },
            0,
        )
        .unwrap();
    assert_eq!(parents(&channel, publication).len(), 3);
    assert_eq!(channel.snapshot(source.session_id).pairs.len(), 2);
    let relay_snapshot = channel.snapshot(relay);
    assert!(relay_snapshot
        .pairs
        .iter()
        .any(|pair| pair.outgoing.contains(&publication)));
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
                publication_id: publication,
                pair_id: source_pairs[0].id,
                ready: true
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
        .handle(
            friend.session_id,
            Command::CreateRoom {
                name: "Forbidden".into(),
                access: RoomAccess::Public,
                hidden: false,
                password: None
            },
            0
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
            },
            0,
        )
        .unwrap();
    channel
        .handle(
            second.session_id,
            Command::Browse {
                room_id: "quiet".into(),
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
        description: None,
        candidate: None,
        tracks: Some(vec![Track {
            publication_id: own,
            stream_id: "stream".into(),
        }]),
    };
    assert!(channel
        .handle(
            first.session_id,
            Command::Signal {
                pair_id,
                payload: spoof
            },
            0
        )
        .is_err());
    let payload = Signal {
        description: None,
        candidate: None,
        tracks: Some(vec![Track {
            publication_id: source,
            stream_id: "stream".into(),
        }]),
    };
    let forwarded = channel
        .handle(first.session_id, Command::Signal { pair_id, payload }, 0)
        .unwrap();
    assert_eq!(forwarded.events.len(), 1);
    assert_eq!(forwarded.events[0].0, second.session_id);
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
