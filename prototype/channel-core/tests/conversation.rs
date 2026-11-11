#![cfg(feature = "sqlite")]
mod support;
use piik_channel_core::{
    conversation::{
        verify, verify_delivery, ConversationAddress, ConversationCommand, ConversationRecord,
        ConversationReply, ConversationRequest, SessionSigner, SignedPacket,
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

fn rejected(network: &mut RoomNetwork, connection: Uuid, packet: &SignedPacket, code: &str) {
    let effects = network.command(
        connection,
        json!({"type":"conversation","packet":packet,"requestId":"chat"}),
    );
    assert!(effects.events.iter().any(|(recipient, event)| *recipient == connection && matches!(event,
        Event::Error { code: actual, request_id } if actual == code && request_id.as_deref() == Some("chat"))));
    assert!(!effects
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Conversation { .. })));
}

#[test]
fn signed_conversation_uses_domain_carriage_without_media_paths_or_a_second_confirmation() {
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
        assert!(network.state(connection).pairs.is_empty());
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
        let replies = network.conversation(&room, &forwarded).replies().unwrap();
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
    network.command(
        owner,
        json!({"type":"revoke_room_access","roomId":room,"userId":reader_user}),
    );
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
fn reading_does_not_open_base_links_but_voice_still_does() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let reader = Uuid::new_v4();
    join(&mut network, owner);
    join(&mut network, reader);
    let room = network.create(owner, RoomAccess::Public, false);
    network.command(reader, json!({"type":"browse","roomId":room,"active":true}));
    assert!(network.state(reader).pairs.is_empty());
    network.command(
        reader,
        json!({"type":"voice","roomId":room,"joined":true,"muted":true,"deafened":false}),
    );
    assert!(!network.state(reader).pairs.is_empty());
    network.command(
        reader,
        json!({"type":"voice","roomId":room,"joined":false,"muted":true,"deafened":false}),
    );
    assert!(network.state(reader).pairs.is_empty());
}
