#![cfg(feature = "sqlite")]

#[allow(dead_code)]
mod support;

use piik_channel_core::{
    conversation::{ConversationCommand, ConversationResult},
    history::HistoryResult,
    host::{RoomResult, RoomSummary, ServiceEndpoint},
    wire::{Event, FlowBinding, HostingMode, PairInfo, RoomAccess},
    AttachmentDescriptor, RoomState,
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;

fn command(net: &mut RoomNetwork, socket: Uuid, request: Value) {
    let kind = request["type"].as_str().unwrap().to_owned();
    for (_, event) in net.command(socket, request).events {
        match event {
            Event::Error { code, .. }
            | Event::RoomReply {
                result: RoomResult::Error { code },
                ..
            } => {
                panic!("{kind} failed: {code}")
            }
            _ => {}
        }
    }
}

fn join(net: &mut RoomNetwork, socket: Uuid) -> (Uuid, String) {
    net.command(socket, json!({"type":"join","name":"Route test"}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome {
                session_id,
                credential,
                ..
            } => Some((session_id, credential)),
            _ => None,
        })
        .unwrap()
}

fn pair(net: &RoomNetwork, socket: Uuid, peer: Uuid) -> &PairInfo {
    net.state(socket)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == peer)
        .unwrap()
}

fn confirm_pair(net: &mut RoomNetwork, sockets: [Uuid; 2], pair: Uuid) {
    for socket in sockets {
        command(
            net,
            socket,
            json!({"type":"link_state","pairId":pair,"state":"connected"}),
        );
    }
}

fn selected_voice(net: &RoomNetwork, socket: Uuid, publication: Uuid) -> (Uuid, FlowBinding) {
    net.state(socket)
        .pairs
        .iter()
        .flat_map(|edge| edge.incoming.iter().map(move |flow| (edge.id, *flow)))
        .find(|(_, flow)| flow.publication_id == publication && flow.selected)
        .expect("selected voice flow")
}

#[test]
fn file_and_watch_use_the_confirmed_shortcut_while_voice_keeps_its_relay() {
    let mut net = RoomNetwork::new();
    net.authority.set_hosting_mode(HostingMode::Hosted);
    let [writer, a, b, c] = [(); 4].map(|_| Uuid::new_v4());
    let [(writer_session, _), (a_session, _), (b_session, b_credential), (c_session, _)] =
        [writer, a, b, c].map(|socket| join(&mut net, socket));
    net.authority
        .set_room_writer(ServiceEndpoint {
            session_id: writer_session,
            connection_id: writer,
        })
        .unwrap();
    let owner = net
        .state(b)
        .sessions
        .iter()
        .find(|session| session.id == b_session)
        .unwrap()
        .user_id;
    let mut policy = RoomState::new(
        "independent-activities".into(),
        "Independent activities".into(),
        Default::default(),
        owner,
        RoomAccess::Public,
        false,
        None,
    )
    .unwrap();
    let creation = net
        .authority
        .prepare_hosted_creation(b_session, b, RoomSummary::from_policy(&policy))
        .unwrap();
    net.authority.reserve_hosted_creation(&creation).unwrap();
    policy.id = creation.summary().id.clone();
    let room = net.restore_room(writer, policy);

    for socket in [b, a, c] {
        command(
            &mut net,
            socket,
            json!({"type":"browse","roomId":room,"active":true}),
        );
        command(
            &mut net,
            socket,
            json!({"type":"voice","roomId":room,"joined":true,"muted":socket != a,"deafened":socket == b}),
        );
    }
    let screen = Uuid::new_v4();
    command(
        &mut net,
        b,
        json!({"type":"publish","publication":{
            "id":screen,"roomId":room,"kind":"screen","source":{"kind":"screen","name":null},
            "videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":30,"maxBitrate":2500000},"degradationPreference":"balanced"}
        }}),
    );
    for socket in [a, c] {
        command(
            &mut net,
            socket,
            json!({"type":"subscribe","publicationId":screen,"enabled":true}),
        );
        let edge = pair(&net, socket, b_session).id;
        confirm_pair(&mut net, [socket, b], edge);
        let bad = net.command(
            Uuid::new_v4(),
            json!({"type":"link_state","pairId":edge,"state":"disconnected"}),
        );
        assert!(bad
            .events
            .iter()
            .any(|(_, e)| matches!(e, Event::Error { .. })));
        for (reporter, state) in [
            (socket, "disconnected"),
            (b, "connected"),
            (socket, "connected"),
        ] {
            command(
                &mut net,
                reporter,
                json!({"type":"link_state","pairId":edge,"state":state}),
            );
        }
        assert_eq!(pair(&net, socket, b_session).id, edge);
    }
    let mic = Uuid::new_v4();
    command(
        &mut net,
        a,
        json!({"type":"publish","publication":{"id":mic,"roomId":room,"kind":"voice"}}),
    );
    let first = pair(&net, b, a_session);
    let transit = first
        .incoming
        .iter()
        .find(|flow| flow.publication_id == mic)
        .unwrap()
        .id;
    let ab = first.id;
    let voice = selected_voice(&net, c, mic);
    assert_eq!(voice.0, pair(&net, c, b_session).id);
    assert_eq!(voice.1.input_flow_id, Some(transit));
    for (socket, pair, flow) in [(b, ab, transit), (c, voice.0, voice.1.id)] {
        command(
            &mut net,
            socket,
            json!({"type":"flow_state","pairId":pair,"flowId":flow,"state":"forwardable"}),
        );
    }
    command(
        &mut net,
        b,
        json!({"type":"unpublish","publicationId":screen}),
    );
    assert_eq!(selected_voice(&net, c, mic), voice);

    let bytes = b"independent transmission";
    let attachment = AttachmentDescriptor {
        id: Uuid::new_v4(),
        name: "example.bin".into(),
        size: bytes.len() as u64,
        media_type: "application/octet-stream".into(),
        sha256: piik_channel_core::attachment::sha256_hex(bytes),
    };
    let Ok(ConversationResult::History(HistoryResult::Sent(sent))) = net
        .peer_request(
            c,
            &room,
            ConversationCommand::Chat {
                mentions: vec![],
                reply: None,
                inline_images: Default::default(),
                text: String::new(),
                nonce: "file".into(),
                attachments: vec![attachment.clone()],
            },
        )
        .result
    else {
        panic!("attachment message was not confirmed");
    };
    let seq = sent.message.message.seq;
    command(
        &mut net,
        c,
        json!({"type":"file_offer","roomId":room,"messageSeq":seq,"attachmentId":attachment.id,"sha256":attachment.sha256,"available":true}),
    );
    let receive_file = |net: &mut RoomNetwork, enabled| {
        command(
            net,
            a,
            json!({"type":"file_receive","roomId":room,"messageSeq":seq,"attachmentId":attachment.id,"enabled":enabled}),
        );
    };
    receive_file(&mut net, true);
    assert_eq!(net.state(a).files[0].upstream, Some(b_session));
    let ac = pair(&net, a, c_session).id;
    command(
        &mut net,
        b,
        json!({"type":"byte_branch_refused","roomId":room,"target":{"kind":"file","messageSeq":seq,"attachmentId":attachment.id,"sourceId":c_session},"downstreamId":a_session}),
    );
    assert!(net.state(a).files[0].receiving);
    assert_eq!(net.state(a).files[0].upstream, None);
    assert_eq!(selected_voice(&net, c, mic), voice);

    confirm_pair(&mut net, [a, c], ac);
    assert_eq!(net.state(a).files[0].source_id, Some(c_session));
    assert_eq!(
        net.state(a).files[0].upstream,
        Some(c_session),
        "the confirmed direct file path is ready while voice still plays through B"
    );
    assert_eq!(selected_voice(&net, c, mic), voice);
    assert!(net.state(b).files.is_empty());

    let watch = Uuid::new_v4();
    let resource = Uuid::new_v4();
    command(
        &mut net,
        a,
        json!({
            "type":"start_watch","roomId":room,"id":watch,
            "source":{"kind":"media","url":"https://example.com/movie.mp4"},
            "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":0},
            "byteSource":{"sessionId":a_session,"resourceId":resource,"format":"file"}
        }),
    );
    command(
        &mut net,
        c,
        json!({"type":"join_watch","roomId":room,"id":watch,"mode":"peer"}),
    );
    let watch_plan = net.state(c).watch_bytes[0].clone();
    assert_eq!(watch_plan.source.session_id, a_session);
    assert_eq!(watch_plan.source.resource_id, resource);
    assert_eq!(watch_plan.upstream, Some(a_session));
    assert_eq!(net.state(a).files[0].upstream, Some(c_session));
    assert_eq!(selected_voice(&net, c, mic), voice);

    receive_file(&mut net, false);
    assert!(net.state(a).files.iter().all(|file| !file.receiving));
    assert_eq!(pair(&net, a, c_session).id, ac);
    assert_eq!(net.state(c).watch_bytes, [watch_plan]);
    assert_eq!(selected_voice(&net, c, mic), voice);
    command(
        &mut net,
        a,
        json!({"type":"stop_watch","roomId":room,"id":watch}),
    );
    assert!(net.state(c).watch_bytes.is_empty());
    assert_eq!(pair(&net, b, a_session).id, ab);
    assert_eq!(selected_voice(&net, c, mic), voice);
    let replacement = Uuid::new_v4();
    let resumed = net.command(
        replacement,
        json!({"type":"join","name":"Route test","credential":b_credential,"sessionId":b_session}),
    );
    assert!(resumed.close.contains(&b));
    let stale = net.command(
        b,
        json!({"type":"link_state","pairId":ab,"state":"disconnected"}),
    );
    assert!(stale.close.contains(&b));
    let current = pair(&net, replacement, a_session).id;
    command(
        &mut net,
        replacement,
        json!({"type":"link_state","pairId":current,"state":"disconnected"}),
    );
    command(
        &mut net,
        replacement,
        json!({"type":"link_state","pairId":current,"state":"connected"}),
    );
}
