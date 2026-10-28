#![cfg(feature = "server")]
mod support;
use piik_channel_prototype::{
    conversation::{
        route, ConversationAddress, ConversationCommand, ConversationRecord, ConversationReply,
        ConversationRequest, SessionSigner,
    },
    wire::{Event, RoomAccess},
};
use serde_json::json;
use support::RoomNetwork;
use uuid::Uuid;

#[test]
fn signed_conversation_routes_on_actual_authority_base_and_bounds_stale_projection_loops() {
    let mut network = RoomNetwork::new();
    let connections: Vec<_> = (0..4).map(|_| Uuid::new_v4()).collect();
    let signers: Vec<_> = (1..=4)
        .map(|seed| SessionSigner::from_seed([seed; 32]))
        .collect();
    let mut sessions = Vec::new();
    for index in 0..3 {
        let joined = network.command(connections[index], json!({"type":"join","name":"Conversation", "key":"invite", "signingKey":signers[index].signing_key()}));
        sessions.push(
            joined
                .events
                .into_iter()
                .find_map(|(_, event)| {
                    if let Event::Welcome { session_id, .. } = event {
                        Some(session_id)
                    } else {
                        None
                    }
                })
                .unwrap(),
        );
    }
    let created = network.create(connections[0], RoomAccess::Public, false);
    let room = network.policy(&created).id;
    for index in [1, 2] {
        network.command(
            connections[index],
            json!({"type":"browse","roomId":room,"active":true}),
        );
    }
    let root_relay = network
        .state(connections[1])
        .pairs
        .iter()
        .find(|pair| pair.peer_id == sessions[0])
        .unwrap()
        .id;
    for index in [0, 1] {
        network.command(
            connections[index],
            json!({"type":"base_state","roomId":room,"pairId":root_relay,"ready":true}),
        );
    }
    let joined = network.command(connections[3], json!({"type":"join","name":"Sender", "key":"invite", "signingKey":signers[3].signing_key()}));
    sessions.push(
        joined
            .events
            .into_iter()
            .find_map(|(_, event)| {
                if let Event::Welcome { session_id, .. } = event {
                    Some(session_id)
                } else {
                    None
                }
            })
            .unwrap(),
    );
    network.command(
        connections[3],
        json!({"type":"browse","roomId":room,"active":true}),
    );
    let relay_sender = network
        .state(connections[3])
        .pairs
        .iter()
        .find(|pair| pair.peer_id == sessions[1])
        .unwrap()
        .id;
    for index in [1, 3] {
        network.command(
            connections[index],
            json!({"type":"base_state","roomId":room,"pairId":relay_sender,"ready":true}),
        );
    }
    for command in [
        json!({"type":"history","roomId":room,"requestId":"blocked-history"}),
        json!({"type":"chat","roomId":room,"text":"No domain content","nonce":"blocked-chat","requestId":"blocked-chat"}),
    ] {
        let rejected = network.command(connections[3], command);
        assert!(rejected.history.is_none());
        assert!(rejected.events.iter().any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "room_data_channel_required")));
        assert!(!rejected.events.iter().any(|(_, event)| matches!(
            event,
            Event::HostInput { .. }
                | Event::History { .. }
                | Event::Message { .. }
                | Event::MessageConfirmed { .. }
        )));
    }
    let delivery = network
        .state(connections[3])
        .channel
        .rooms
        .iter()
        .find(|entry| entry.id == room)
        .unwrap()
        .delivery
        .as_ref()
        .unwrap();
    let address = ConversationAddress {
        room_id: room.clone(),
        binding_id: delivery.binding_id,
        sender: sessions[3],
        recipient: sessions[0],
        request_id: "history".into(),
    };
    let request = ConversationRequest {
        address: address.clone(),
        command: ConversationCommand::History { before: None },
    };
    let mut packet = signers[3].sign(sessions[3], &request).unwrap();
    assert_eq!(
        route(
            &mut packet,
            sessions[3],
            network.state(connections[3]),
            None
        )
        .unwrap()
        .next_hop,
        Some(sessions[1])
    );
    assert_eq!(packet.remaining_hops, 19);
    let mut stale = network.state(connections[1]).clone();
    stale
        .channel
        .rooms
        .iter_mut()
        .find(|entry| entry.id == room)
        .unwrap()
        .delivery
        .as_mut()
        .unwrap()
        .next_hops
        .insert(sessions[0], sessions[3]);
    assert!(matches!(
        route(&mut packet, sessions[1], &stale, Some(sessions[3])),
        Err("room_path_unavailable")
    ));
    assert_eq!(packet.remaining_hops, 19);
    assert_eq!(
        route(
            &mut packet,
            sessions[1],
            network.state(connections[1]),
            Some(sessions[3])
        )
        .unwrap()
        .next_hop,
        Some(sessions[0])
    );
    assert_eq!(packet.remaining_hops, 18);
    assert!(route(
        &mut packet,
        sessions[0],
        network.state(connections[0]),
        Some(sessions[1])
    )
    .unwrap()
    .next_hop
    .is_none());
    let mut exhausted = signers[3].sign(sessions[3], &request).unwrap();
    exhausted.remaining_hops = 0;
    assert!(matches!(
        route(
            &mut exhausted,
            sessions[3],
            network.state(connections[3]),
            None
        ),
        Err("conversation_hop_limit")
    ));
    assert!(route(
        &mut exhausted,
        sessions[0],
        network.state(connections[0]),
        Some(sessions[1])
    )
    .unwrap()
    .next_hop
    .is_none());
    assert!(matches!(
        route(
            &mut packet,
            sessions[1],
            network.state(connections[1]),
            Some(sessions[2])
        ),
        Err("unassigned_room_peer")
    ));
    let reply = ConversationReply {
        address: address.reply(),
        record: ConversationRecord::HistoryEnd {
            has_more: false,
            oldest_seq: None,
            before: None,
        },
    };
    let mut reply = signers[0].sign(sessions[0], &reply).unwrap();
    assert_eq!(
        route(&mut reply, sessions[0], network.state(connections[0]), None)
            .unwrap()
            .next_hop,
        Some(sessions[1])
    );
    assert_eq!(
        route(
            &mut reply,
            sessions[1],
            network.state(connections[1]),
            Some(sessions[0])
        )
        .unwrap()
        .next_hop,
        Some(sessions[3])
    );
    assert!(route(
        &mut reply,
        sessions[3],
        network.state(connections[3]),
        Some(sessions[1])
    )
    .unwrap()
    .next_hop
    .is_none());
}
