#![cfg(feature = "sqlite")]
mod support;
use piik_channel_core::{
    conversation::{
        verify, verify_delivery, ConversationAddress, ConversationCommand, ConversationRecord,
        ConversationReply, ConversationRequest, ConversationView, SessionSigner, SignedPacket,
    },
    wire::{Event, RoomAccess},
};
use serde_json::json;
use support::RoomNetwork;
use uuid::Uuid;

fn join(network: &mut RoomNetwork, connection: Uuid) -> Uuid {
    network
        .command(connection, json!({"type":"join","name":"Reader"}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .unwrap()
}

fn relay(
    network: &mut RoomNetwork,
    connection: Uuid,
    target: Uuid,
    packet: &SignedPacket,
) -> SignedPacket {
    let effects = network.command(
        connection,
        json!({"type":"conversation","packet":packet,"requestId":"chat"}),
    );
    assert!(
        !effects
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::Ack { .. })),
        "forwarding is not confirmation"
    );
    effects
        .events
        .into_iter()
        .find_map(|(recipient, event)| match event {
            Event::Conversation { packet } => {
                assert_eq!(recipient, target);
                Some(packet)
            }
            _ => None,
        })
        .expect("domain forwards to the intended endpoint")
}

fn refused(network: &mut RoomNetwork, connection: Uuid, target: Uuid, packet: &SignedPacket, code: &str) {
    let effects = network.command(
        connection,
        json!({"type":"conversation","packet":packet,"requestId":"chat"}),
    );
    let [(recipient, event)] = effects.events.as_slice() else { panic!("expected one refusal") };
    assert_eq!(*recipient, target);
    if target == connection {
        assert!(matches!(event, Event::Error {code: actual, request_id: Some(id)} if actual == code && id == "chat"));
    } else {
        assert!(matches!(event, Event::RoomReply {result: piik_channel_core::host::RoomResult::Error { code: actual }, request_id: Some(id), ..} if actual == code && id == "chat"));
    }
}

fn rejected(network: &mut RoomNetwork, connection: Uuid, packet: &SignedPacket, code: &str) {
    refused(network, connection, connection, packet, code);
}

#[test]
fn signed_conversation_uses_domain_carriage_without_payload_grants_or_a_second_confirmation() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let reader = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    let owner_session = join(&mut network, owner);
    let reader_session = join(&mut network, reader);
    join(&mut network, outsider);
    let room = network.create(owner, RoomAccess::Private, false);
    let key = network
        .command(owner, json!({"type":"room_invite","roomId":room}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::RoomInvite { key, .. } => Some(key),
            _ => None,
        })
        .unwrap();
    network.command(
        reader,
        json!({"type":"enter_room","roomId":room,"inviteKey":key}),
    );
    network.command(reader, json!({"type":"browse","roomId":room,"active":true}));
    for connection in [owner, reader] {
        assert_no_payload_grants(&network, connection);
    }
    let view = network
        .state(reader)
        .channel
        .rooms
        .iter()
        .find(|value| value.id == room)
        .unwrap();
    assert!(
        view.participant_session_ids.contains(&reader_session),
        "reading still has room presence"
    );
    let address = ConversationAddress {
        room_id: room.clone(),
        binding_id: view.delivery.as_ref().unwrap().binding_id,
        sender: reader_session,
        recipient: owner_session,
        request_id: "chat".into(),
    };
    let signer = SessionSigner::from_seed([1; 32]);
    let packet = signer
        .sign(
            reader_session,
            &ConversationRequest {
                address: address.clone(),
                command: ConversationCommand::Chat {
                    mentions: vec![],
                    reply: None,
                    inline_images: Default::default(),
                    text: "Works without ICE".into(),
                    nonce: "one-write".into(),
                    attachments: vec![],
                },
            },
        )
        .unwrap();
    let mut confirmed = None;
    for retry in [false, true] {
        let forwarded = relay(&mut network, reader, owner, &packet);
        assert_eq!(
            verify_delivery(&forwarded, owner_session, network.state(owner)).unwrap(),
            address
        );
        let mut described = serde_json::to_value(network.state(owner)).unwrap();
        described["watchActivities"] = json!([{"playback":{"timeline":"future-timeline"}}]);
        described["pairs"] = json!([{"futureTransport":true}]);
        let text_view: ConversationView = serde_json::from_value(described).unwrap();
        assert!(matches!(
            text_view.verify(&forwarded, owner_session).unwrap(),
            piik_channel_core::conversation::ReceivedConversation::Command(received) if received == address
        ));
        let replies = network.conversation(&room, &forwarded).replies().unwrap();
        // Hold the covering HostInput after the writer commits. The person
        // leaving is neither the writer nor the still-connected chat sender.
        let covering = (!retry).then(|| {
            let leaver = Uuid::new_v4();
            join(&mut network, leaver);
            let leave = piik_channel_core::wire::Request::parse(r#"{"type":"leave"}"#).unwrap();
            let effects = network.authority.handle(leaver, leave, 101);
            assert!(effects.events.iter().any(|(_, event)| matches!(event, Event::HostInput { .. })));
            effects
        });
        for reply in replies {
            let returned = signer.sign(owner_session, &reply).unwrap();
            let returned = relay(&mut network, owner, reader, &returned);
            verify_delivery(&returned, reader_session, network.state(reader)).unwrap();
            let parsed: ConversationReply = verify(&returned, signer.signing_key()).unwrap();
            if let ConversationRecord::Confirmed { message, inserted } = parsed.record {
                assert_eq!(inserted, !retry);
                if retry {
                    assert_eq!(confirmed, Some(message.id));
                } else {
                    confirmed = Some(message.id);
                }
                assert_eq!(message.seq, 1);
            }
        }
        if let Some(covering) = covering {
            network.deliver(covering);
        }
    }
    assert!(confirmed.is_some());
    assert_eq!(
        network
            .state(owner)
            .channel
            .rooms
            .iter()
            .find(|value| value.id == room)
            .unwrap()
            .last_message_seq,
        1,
        "the authorized owner learns the head without browsing or media paths"
    );
    assert_eq!(
        network
            .state(outsider)
            .channel
            .rooms
            .iter()
            .find(|value| value.id == room)
            .unwrap()
            .last_message_seq,
        0,
        "a locked private-room directory does not reveal its message head"
    );
    let history = signer
        .sign(
            reader_session,
            &ConversationRequest {
                address: address.clone(),
                command: ConversationCommand::History { before: None },
            },
        )
        .unwrap();
    let forwarded = relay(&mut network, reader, owner, &history);
    let replies = network.conversation(&room, &forwarded).replies().unwrap();
    assert!(replies.iter().any(|reply| matches!(&reply.record, ConversationRecord::HistoryMessage { message } if message.id == confirmed.unwrap())));
    assert!(matches!(
        replies.last().unwrap().record,
        ConversationRecord::HistoryEnd { count: 1, .. }
    ));
    rejected(
        &mut network,
        outsider,
        &packet,
        "invalid_conversation_sender",
    );
    let mut forged = packet.clone();
    forged.payload.push(' ');
    rejected(
        &mut network,
        reader,
        &forged,
        "invalid_conversation_signature",
    );
    let mut peer_address = address.clone();
    peer_address.recipient = reader_session;
    let peer_packet = signer
        .sign(
            reader_session,
            &ConversationRequest {
                address: peer_address,
                command: ConversationCommand::History { before: None },
            },
        )
        .unwrap();
    rejected(
        &mut network,
        reader,
        &peer_packet,
        "invalid_conversation_scope",
    );
    let reader_user = network
        .state(reader)
        .sessions
        .iter()
        .find(|session| session.id == reader_session)
        .unwrap()
        .user_id;
    let private_reply = signer.sign(owner_session, &replies[0]).unwrap();
    // Resuming the same binding must verify its current read policy before
    // relaying private history from a preceding turn.
    let summary = piik_channel_core::host::RoomSummary::from_policy(&network.policy(&room));
    let register = piik_channel_core::wire::Request::parse(
        &json!({"type":"host_register","room":summary,"resumeBinding":address.binding_id}).to_string(),
    ).unwrap();
    let resume = network.authority.handle(owner, register, 108);
    refused(&mut network, owner, reader, &private_reply, "room_busy");
    network.deliver(resume);
    relay(&mut network, owner, reader, &private_reply);

    // A policy command that fails still produces a covering read projection.
    let owner_user = network.policy(&room).creator_id;
    let own_revoke = network.command(owner, json!({"type":"revoke_room_access","roomId":room,"userId":owner_user}));
    assert!(own_revoke.events.iter().any(|(_, event)| matches!(event,
        Event::RoomReply { result: piik_channel_core::host::RoomResult::Error { code }, .. } if code == "forbidden")));
    relay(&mut network, owner, reader, &private_reply);
    let revoke = piik_channel_core::wire::Request::parse(
        &json!({"type":"revoke_room_access","roomId":room,"userId":reader_user}).to_string(),
    ).unwrap();
    let revoke = network.authority.handle(owner, revoke, 110);
    let input = revoke.events.into_iter().find_map(|(_, event)| match event {
        Event::HostInput { input, .. } => Some(input),
        _ => None,
    }).unwrap();
    let revoked = network.host_turn(&room, input);
    assert!(!revoked.projection.views[&reader_session].authorized);

    // An unrelated later input supersedes this projection while the durable
    // removal of the reader's grant already took effect at the room writer.
    let leave = piik_channel_core::wire::Request::parse(r#"{"type":"leave"}"#).unwrap();
    let cover = network.authority.handle(outsider, leave, 111);
    let output = piik_channel_core::wire::Request::parse(
        &json!({"type":"host_output","roomId":room,"output":revoked}).to_string(),
    ).unwrap();
    let stale = network.authority.handle(owner, output, 112);
    assert!(!stale.events.iter().any(|(_, event)| matches!(event, Event::Error { .. })));
    refused(&mut network, owner, reader, &private_reply, "room_busy");
    network.deliver(cover);
    refused(&mut network, owner, reader, &private_reply, "room_access_required");
    rejected(&mut network, reader, &packet, "room_access_required");
    network.command(
        reader,
        json!({"type":"enter_room","roomId":room,"inviteKey":key}),
    );
    let policy = network.policy(&room);
    network.restore_room(owner, policy);
    rejected(&mut network, reader, &packet, "invalid_conversation_scope");
    assert!(verify_delivery(&packet, owner_session, network.state(owner)).is_err());
}

#[test]
fn committed_chat_crossing_read_revalidation_reaches_its_online_requester() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let reader = Uuid::new_v4();
    let observer = Uuid::new_v4();
    let observer_session = join(&mut network, observer);
    let owner_session = join(&mut network, owner);
    let reader_session = join(&mut network, reader);
    let room = network.create(owner, RoomAccess::Public, false);
    for connection in [owner, reader, observer] {
        network.command(connection, json!({"type":"browse","roomId":room,"active":true}));
    }
    let state = network.state(reader);
    let view = state.channel.rooms.iter().find(|value| value.id == room).unwrap();
    let pair = state.pairs.iter().find(|pair| pair.peer_id == owner_session).unwrap().id;
    let owner_user = state.sessions.iter().find(|s| s.id == owner_session).unwrap().user_id;
    let signer = SessionSigner::from_seed([1; 32]);
    let address = ConversationAddress {
        room_id: room.clone(),
        binding_id: view.delivery.as_ref().unwrap().binding_id,
        sender: reader_session,
        recipient: owner_session,
        request_id: "online-chat".into(),
    };
    let packet = signer.sign(reader_session, &ConversationRequest {
        address: address.clone(),
        command: ConversationCommand::Chat {
            text: "committed before permission check".into(),
            nonce: "stable-nonce".into(),
            mentions: vec![], reply: None, inline_images: Default::default(), attachments: vec![],
        },
    }).unwrap();
    let forwarded = relay(&mut network, reader, owner, &packet);
    let replies = network.conversation(&room, &forwarded).replies().unwrap();
    assert!(matches!(&replies[0].record, ConversationRecord::Confirmed { message, inserted: true } if message.seq == 1));
    let confirmed = signer.sign(owner_session, &replies[0]).unwrap();

    let live = ConversationReply {
        address: ConversationAddress { recipient: observer_session, ..replies[0].address.clone() },
        record: replies[0].record.broadcast().unwrap(),
    };
    let live = signer.sign(owner_session, &live).unwrap();

    // Confirming the transport changes the room's routes while its writer still holds this reply.
    let link = json!({"type":"link_state","pairId":pair,"state":"connected"});
    network.command(owner, link.clone());
    let route = network.authority.handle(reader, piik_channel_core::wire::Request::parse(&link.to_string()).unwrap(), 101);
    assert!(route.events.iter().any(|(_, event)| matches!(event, Event::HostInput { .. })));
    relay(&mut network, owner, reader, &confirmed);
    network.deliver(route);

    // A retry of this committed write produces the same idempotent confirmation.
    let mut retry: ConversationRequest = verify(&packet, signer.signing_key()).unwrap();
    retry.address.request_id = "retry-chat".into();
    let packet = signer.sign(reader_session, &retry).unwrap();
    let forwarded = relay(&mut network, reader, owner, &packet);
    let replies = network.conversation(&room, &forwarded).replies().unwrap();
    assert!(matches!(&replies[0].record, ConversationRecord::Confirmed { message, inserted: false } if message.seq == 1));
    let confirmed = signer.sign(owner_session, &replies[0]).unwrap();
    // This real permission check will fail. Read remains available after the writer answers.
    let change = json!({"type":"revoke_room_access","roomId":room,"userId":owner_user});
    let covering = network.authority.handle(owner, piik_channel_core::wire::Request::parse(&change.to_string()).unwrap(), 102);
    assert!(covering.events.iter().any(|(_, event)| matches!(event, Event::HostInput { .. })));
    let blocked = network.command(owner, json!({"type":"conversation","packet":confirmed,"requestId":"writer-send"}));
    assert!(!blocked.events.iter().any(|(_, event)| matches!(event, Event::Conversation { .. })));
    let mut forged = confirmed.clone();
    forged.signature[0] ^= 1;
    rejected(&mut network, owner, &forged, "invalid_conversation_signature");
    rejected(&mut network, observer, &confirmed, "invalid_conversation_sender");
    let mut stale = replies[0].clone();
    stale.address.binding_id = Uuid::new_v4();
    rejected(&mut network, owner, &signer.sign(owner_session, &stale).unwrap(), "invalid_conversation_scope");
    let fanout = network.command(owner, json!({"type":"conversation","packet":live}));
    assert!(matches!(fanout.events.as_slice(),
        [(target, Event::RoomReply { room_id, result: piik_channel_core::host::RoomResult::Error { code }, request_id: Some(id) })]
            if *target == observer && room_id == &room && code == "room_busy" && id == &address.request_id));
    let after = network.deliver(covering);
    assert!(after.events.iter().any(|(connection, event)| *connection == owner && matches!(event,
        Event::RoomReply { result: piik_channel_core::host::RoomResult::Error { code }, .. } if code == "forbidden")));
    assert!(network.state(reader).channel.rooms.iter().any(|r| r.id == room && r.authorized && r.available));
    assert!(matches!(blocked.events.as_slice(),
        [(target, Event::RoomReply { room_id, result: piik_channel_core::host::RoomResult::Error { code }, request_id: Some(id) })]
            if *target == reader && room_id == &room && code == "room_busy" && id == &retry.address.request_id));
}

#[test]
fn reading_keeps_standby_idle_until_voice_delivery_begins() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let reader = Uuid::new_v4();
    let owner_session = join(&mut network, owner);
    let reader_session = join(&mut network, reader);
    let room = network.create(owner, RoomAccess::Public, false);
    for connection in [owner, reader] {
        network.command(
            connection,
            json!({"type":"browse","roomId":room,"active":true}),
        );
        assert_no_payload_grants(&network, connection);
    }
    let standby = network
        .state(reader)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == owner_session)
        .expect("room readers can establish a standby pair")
        .id;
    for connection in [owner, reader] {
        network.command(
            connection,
            json!({"type":"link_state","pairId":standby,"state":"connected"}),
        );
        network.command(
            connection,
            json!({"type":"voice","roomId":room,"joined":true,"muted":true,"deafened":false}),
        );
        assert_no_payload_grants(&network, connection);
    }
    assert_eq!(network.state(reader).voice.len(), 2);
    network.command(
        reader,
        json!({"type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false}),
    );
    let publication = Uuid::new_v4();
    network.command(
        reader,
        json!({"type":"publish","publication":{"id":publication,"roomId":room,"kind":"voice","source":null,"videoSettings":null}}),
    );
    let incoming = network
        .state(owner)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == reader_session)
        .unwrap();
    assert_eq!(incoming.id, standby);
    assert!(incoming
        .incoming
        .iter()
        .any(|flow| flow.publication_id == publication && flow.selected));
    network.command(
        reader,
        json!({"type":"voice","roomId":room,"joined":false,"muted":true,"deafened":false}),
    );
    for connection in [owner, reader] {
        assert_no_payload_grants(&network, connection);
    }
    assert!(network
        .state(owner)
        .voice
        .iter()
        .all(|voice| voice.session_id != reader_session));
    assert!(network
        .state(reader)
        .pairs
        .iter()
        .any(|pair| pair.id == standby));
}

fn assert_no_payload_grants(network: &RoomNetwork, connection: Uuid) {
    let state = network.state(connection);
    assert!(state.pairs.iter().all(|pair| {
        pair.rooms.is_empty() && pair.incoming.is_empty() && pair.outgoing.is_empty()
    }));
    assert!(state.files.is_empty() && state.watch_bytes.is_empty());
}
