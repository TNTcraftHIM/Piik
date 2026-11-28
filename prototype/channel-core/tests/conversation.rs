#![cfg(feature = "sqlite")]
mod support;
use piik_channel_core::wire::ReplyResult;
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
            .any(|(_, event)| matches!(event, Event::Reply { result: ReplyResult::Done, .. })),
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
        assert!(matches!(event, Event::Reply { request_id: id, result: ReplyResult::Error { code: actual }, .. } if actual == code && id == "chat"));
    } else {
        assert!(matches!(event, Event::Reply { room_id: Some(_), request_id: id, result: ReplyResult::Error { code: actual } } if actual == code && id == "chat"));
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
        .command(owner, json!({"type":"room_invite","roomId":room,"requestId":"invite"}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Reply { room_id: Some(_), result: ReplyResult::Invite { key }, .. } => Some(key),
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
                    attachments: vec![piik_channel_core::AttachmentDescriptor {
                        id: Uuid::new_v4(),
                        name: "sample.bin".into(),
                        size: 3,
                        media_type: "image/x-piik-test".into(),
                        sha256: piik_channel_core::attachment::sha256_hex(b"abc"),
                    }],
                },
            },
        )
        .unwrap();
    let mut future = serde_json::to_value(&address).unwrap();
    future["command"] = json!(["future_action"]);
    let array = signer.sign(reader_session, &future).unwrap();
    rejected(&mut network, reader, &array, "invalid_conversation");
    future["command"] = json!({"type":"future_action","detail":1});
    let signed = signer.sign(reader_session, &future).unwrap();
    let delivered = relay(&mut network, reader, owner, &signed);
    assert_eq!(delivered.payload, signed.payload);
    assert_eq!(delivered.signature, signed.signature);
    let error = network.conversation(&room, &delivered).replies().unwrap().remove(0);
    assert!(matches!(&error.body, piik_channel_core::conversation::WriterBody::Record(ConversationRecord::Error { code }) if code == "unsupported"));
    let reader_view: ConversationView = serde_json::from_value(serde_json::to_value(network.state(reader)).unwrap()).unwrap();
    future["command"] = json!({
        "type":"react", "nonce":1, "reaction":"heart", "futureCommand":true,
        "target":{"type":"person","userId":network.policy(&room).creator_id,"futureTarget":true}
    });
    let signed = signer.sign(reader_session, &future).unwrap();
    let delivered = relay(&mut network, reader, owner, &signed);
    let replies = network.conversation(&room, &delivered).replies().unwrap();
    assert!(matches!(replies[0].content(), ConversationRecord::Reaction { event: Some(_), .. }));
    for field in ["record", "notice"] {
        let mut reply = serde_json::to_value(address.reply()).unwrap();
        reply[field] = serde_json::to_value(replies[0].content()).unwrap();
        reply[field]["futureRecord"] = json!(true);
        reply[field]["event"]["target"]["futureTarget"] = json!(true);
        let signed = signer.sign(owner_session, &reply).unwrap();
        let mut envelope = serde_json::to_value(&signed).unwrap();
        envelope["futurePacket"] = json!(true);
        let packet = serde_json::from_value(envelope).unwrap();
        let delivered = relay(&mut network, owner, reader, &packet);
        assert_eq!(delivered.payload, signed.payload);
        let result = serde_json::to_value(reader_view.verify(&delivered, reader_session).unwrap()).unwrap();
        assert_eq!(result["role"], field);
        assert_eq!(result[field]["event"]["reaction"], "heart");
    }
    for field in ["record", "notice"] {
        let mut reply = serde_json::to_value(address.reply()).unwrap();
        reply[field] = json!({"type":"future_result","detail":2});
        let signed = signer.sign(owner_session, &reply).unwrap();
        let delivered = relay(&mut network, owner, reader, &signed);
        assert_eq!(delivered.payload, signed.payload);
        assert_eq!(delivered.signature, signed.signature);
        let result = serde_json::to_value(reader_view.verify(&delivered, reader_session).unwrap()).unwrap();
        if field == "record" {
            assert_eq!(result["role"], "unknown_record");
            assert_eq!(result["requestId"], address.request_id);
        } else {
            assert_eq!(result, json!({"role":"ignored"}));
        }
    }
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
            if let ConversationRecord::Confirmed { message, inserted } = parsed.content() {
                assert_eq!(*inserted, !retry);
                if retry {
                    assert_eq!(confirmed, Some(message.message.id));
                } else {
                    confirmed = Some(message.message.id);
                }
                assert_eq!(message.message.seq, 1);
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
                command: ConversationCommand::History {
                    before: None,
                    parts: vec!["unknownPart".into(), "inlineImages".into(), "inlineImages".into()],
                },
            },
        )
        .unwrap();
    let forwarded = relay(&mut network, reader, owner, &history);
    let replies = network.conversation(&room, &forwarded).replies().unwrap();
    assert_eq!(replies.len(), 1);
    assert!(matches!(replies[0].content(), ConversationRecord::HistoryPage { parts, messages, .. }
        if parts == &["inlineImages"] && messages.len() == 1 && messages[0].message.id == confirmed.unwrap()
            && messages[0].message.attachments[0].media_type == "image/x-piik-test"));
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
                command: ConversationCommand::History { before: None, parts: vec!["inlineImages".into()] },
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
        Event::Error { room_id: Some(_), code } if code == "forbidden")));
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
    assert!(!stale.events.iter().any(|(_, event)| matches!(event, Event::Error { .. } | Event::Reply { result: ReplyResult::Error { .. }, .. })));
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
    assert!(matches!(replies[0].content(), ConversationRecord::Confirmed { message, inserted: true } if message.message.seq == 1));
    let confirmed = signer.sign(owner_session, &replies[0]).unwrap();

    let live = ConversationReply {
        address: ConversationAddress { recipient: observer_session, ..replies[0].address.clone() },
        body: piik_channel_core::conversation::WriterBody::Notice(replies[0].content().broadcast().unwrap()),
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
    assert!(matches!(replies[0].content(), ConversationRecord::Confirmed { message, inserted: false } if message.message.seq == 1));
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
    assert!(fanout.events.is_empty());
    let after = network.deliver(covering);
    assert!(after.events.iter().any(|(connection, event)| *connection == owner && matches!(event,
        Event::Error { room_id: Some(_), code } if code == "forbidden")));
    assert!(network.state(reader).channel.rooms.iter().any(|r| r.id == room && r.authorized && r.available));
    assert!(matches!(blocked.events.as_slice(),
        [(target, Event::Reply { room_id: Some(room_id), request_id: id, result: ReplyResult::Error { code } })]
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

#[test]
fn unsupported_read_policy_recovers_through_one_writer_sync() {
    use piik_channel_core::{host::{HostAction, HostInput}, wire::Request};

    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let reader = Uuid::new_v4();
    let writer_session = join(&mut network, owner);
    let reader_session = join(&mut network, reader);
    let room = network.create(owner, RoomAccess::Public, false);
    network.command(reader, json!({"type":"browse","roomId":room,"active":true}));
    // Keep a decoded screen flow active while the read policy is revalidated.
    let screen = Uuid::new_v4();
    network.command(owner, json!({"type":"publish","publication":{
        "id":screen,"roomId":room,"kind":"screen","source":{"kind":"screen","name":null},
        "videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":30,
            "maxBitrate":2500000},"degradationPreference":"balanced"}
    }}));
    network.command(reader, json!({"type":"subscribe","publicationId":screen,"enabled":true}));
    let edge = network.state(reader).pairs.iter().find(|p| p.peer_id == writer_session).unwrap().id;
    for connection in [reader, owner] {
        network.command(connection, json!({"type":"link_state","pairId":edge,"state":"connected"}));
    }
    let active_flow = |net: &RoomNetwork| net.state(reader).pairs.iter().find(|p| p.id == edge)
        .unwrap().incoming.iter().find(|f| f.publication_id == screen).unwrap().id;
    let flow = active_flow(&network);
    network.command(reader, json!({"type":"flow_state","pairId":edge,"flowId":flow,"state":"decoded"}));
    let audience = |net: &RoomNetwork| net.state(owner).publications.iter().find(|p| p.id == screen)
        .unwrap().audience.iter().find(|a| a.session_id == reader_session).unwrap().state;
    assert_eq!(audience(&network), piik_channel_core::wire::AudienceState::Active);
    let binding = network.state(reader).channel.rooms.iter().find(|r| r.id == room)
        .unwrap().delivery.as_ref().unwrap().binding_id;
    let history = SessionSigner::from_seed([1; 32]).sign(reader_session, &ConversationRequest {
        address: ConversationAddress {
            room_id: room.clone(), binding_id: binding, sender: reader_session,
            recipient: writer_session, request_id: "chat".into(),
        },
        command: ConversationCommand::History { before: None, parts: vec![] },
    }).unwrap();
    relay(&mut network, reader, owner, &history);

    let handle = |net: &mut RoomNetwork, request: serde_json::Value| {
        net.authority.handle(owner, Request::parse(&request.to_string()).unwrap(), 101)
    };
    let take_input = |net: &mut RoomNetwork, request| {
        handle(net, request).events.into_iter().find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        }).unwrap()
    };
    // Hold a real, earlier writer output while the Domain issues the read barrier.
    let earlier = take_input(&mut network, json!({"type":"browse","roomId":room,"active":true,"requestId":"earlier"}));
    let earlier = network.host_turn(&room, earlier);
    let barrier = take_input(&mut network, json!({"type":"update_room","roomId":room,"access":"private","requestId":"policy"}));
    let revision = barrier.revision;
    // Simulate a new read-policy request as decoded by an older writer.
    let mut wire = serde_json::to_value(barrier).unwrap();
    wire["action"] = json!({"type":"future_read_policy"});
    let older: HostInput = serde_json::from_value(wire).unwrap();
    assert!(older.action.is_unsupported());
    let unsupported = json!({"type":"host_unsupported","roomId":room,"bindingId":binding,"revision":revision});
    let answer = handle(&mut network, unsupported.clone());
    assert!(answer.events.iter().any(|(_, e)| matches!(e, Event::Reply {
        request_id, result: ReplyResult::Error { code }, ..
    } if request_id == "policy" && code == "unsupported")));
    assert!(handle(&mut network, unsupported).events.is_empty());
    rejected(&mut network, reader, &history, "room_busy");
    let lower = handle(&mut network, json!({"type":"host_output","roomId":room,"output":earlier}));
    assert!(lower.events.iter().any(|(_, e)| matches!(e, Event::Reply {
        request_id, result: ReplyResult::Done, ..
    } if request_id == "earlier")));
    rejected(&mut network, reader, &history, "room_busy");

    assert_eq!(answer.events.iter().filter(|(_, e)| matches!(e, Event::HostInput { input, .. }
        if matches!(input.action, HostAction::Sync) && input.binding_id == binding && input.revision > revision)).count(), 1);
    network.deliver(answer);
    relay(&mut network, reader, owner, &history);
    assert_eq!(active_flow(&network), flow);
    assert_eq!(audience(&network), piik_channel_core::wire::AudienceState::Active);
}
