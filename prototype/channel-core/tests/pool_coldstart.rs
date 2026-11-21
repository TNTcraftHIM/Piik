#![cfg(feature = "sqlite")]

mod support;
#[path = "pool_coldstart/assisted.rs"]
mod assisted;
#[path = "pool_coldstart/host_wake.rs"]
mod host_wake;

use piik_channel_core::{
    attachment::sha256_hex,
    conversation::{ConversationCommand, ConversationResult},
    history::HistoryResult,
    host::RoomResult,
    wire::{Event, FlowBinding, PairInfo, RoomAccess},
    AttachmentDescriptor,
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;

fn command(net: &mut RoomNetwork, connection: Uuid, request: Value) {
    let effects = net.command(connection, request);
    let error = effects.events.iter().find_map(|(_, event)| match event {
        Event::Error { code, .. }
        | Event::RoomReply {
            result: RoomResult::Error { code },
            ..
        } => Some(code),
        _ => None,
    });
    assert!(error.is_none(), "command rejected: {error:?}");
}

fn join(net: &mut RoomNetwork, connection: Uuid, name: &str) -> Uuid {
    net.command(connection, json!({"type":"join","name":name}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { session_id, .. } => Some(session_id),
            _ => None,
        })
        .expect("joined channel")
}

fn pair(net: &RoomNetwork, connection: Uuid, peer: Uuid) -> &PairInfo {
    net.state(connection)
        .pairs
        .iter()
        .find(|pair| pair.peer_id == peer)
        .expect("channel admitted the requested peer")
}

fn link_connected(net: &mut RoomNetwork, connection: Uuid, pair: Uuid) {
    command(
        net,
        connection,
        json!({"type":"link_state","pairId":pair,"state":"connected"}),
    );
}

fn offer_file(net: &mut RoomNetwork, owner: Uuid, room: &str) -> (u64, Uuid) {
    let bytes = b"cold start";
    let attachment = AttachmentDescriptor {
        id: Uuid::new_v4(),
        name: "sample.bin".into(),
        size: bytes.len() as u64,
        media_type: "application/octet-stream".into(),
        sha256: sha256_hex(bytes),
    };
    let request = ConversationCommand::Chat {
        mentions: vec![],
        reply: None,
        inline_images: Default::default(),
        text: String::new(),
        nonce: "file".into(),
        attachments: vec![attachment.clone()],
    };
    let Ok(ConversationResult::History(HistoryResult::Sent(sent))) =
        net.peer_request(owner, room, request).result
    else {
        panic!("attachment message was not confirmed");
    };
    let seq = sent.message.message.seq;
    command(
        net,
        owner,
        json!({"type":"file_offer","roomId":room,"messageSeq":seq,
            "attachmentId":attachment.id,"sha256":attachment.sha256,"available":true}),
    );
    (seq, attachment.id)
}

fn file_receive(room: &str, file: (u64, Uuid), enabled: bool) -> Value {
    json!({"type":"file_receive","roomId":room,"messageSeq":file.0,
        "attachmentId":file.1,"enabled":enabled})
}

fn publish_screen(net: &mut RoomNetwork, connection: Uuid, room: &str) -> Uuid {
    let id = Uuid::new_v4();
    command(
        net,
        connection,
        json!({"type":"publish","publication":{"id":id,"roomId":room,"kind":"screen",
        "source":{"kind":"screen","name":null},"videoSettings":{
            "ceiling":{"resolution":{"width":1280,"height":720},
                "maxFramerate":30,"maxBitrate":2500000},
            "degradationPreference":"balanced"
        }}}),
    );
    id
}

fn subscribe(publication: Uuid, enabled: bool) -> Value {
    json!({"type":"subscribe","publicationId":publication,"enabled":enabled})
}

fn input(pair: &PairInfo, publication: Uuid) -> Option<FlowBinding> {
    pair.incoming
        .iter()
        .find(|flow| flow.publication_id == publication)
        .copied()
}

#[test]
fn first_screen_subscription_prepares_after_link_confirmation() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    join(&mut net, receiver, "Viewer");
    let room = net.create(owner, RoomAccess::Public, false);
    let screen = publish_screen(&mut net, owner, &room);
    assert!(net.state(receiver).pairs.is_empty());

    command(&mut net, receiver, subscribe(screen, true));
    assert!(net.state(receiver).subscriptions.contains(&screen));
    assert!(!net.state(receiver).failed_subscriptions.contains(&screen));
    let pending = pair(&net, receiver, source);
    let id = pending.id;
    assert_eq!(input(pending, screen), None);

    link_connected(&mut net, receiver, id);
    assert_eq!(input(pair(&net, receiver, source), screen), None);
    link_connected(&mut net, owner, id);
    let confirmed = pair(&net, receiver, source);
    assert_eq!(confirmed.id, id);
    assert!(input(confirmed, screen).is_some());
}

#[test]
fn first_voice_receiver_keeps_subscribed_until_the_link_is_confirmed() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Speaker");
    join(&mut net, receiver, "Listener");
    let room = net.create(owner, RoomAccess::Public, false);
    let voice = Uuid::new_v4();
    command(
        &mut net,
        owner,
        json!({"type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false}),
    );
    command(
        &mut net,
        owner,
        json!({"type":"publish","publication":{"id":voice,"roomId":room,"kind":"voice"}}),
    );
    assert!(net.state(receiver).pairs.is_empty());

    command(
        &mut net,
        receiver,
        json!({"type":"voice","roomId":room,"joined":true,"muted":true,"deafened":false}),
    );
    assert!(net.state(receiver).subscriptions.contains(&voice));
    let pending = pair(&net, receiver, source);
    let id = pending.id;
    assert_eq!(input(pending, voice), None);

    link_connected(&mut net, owner, id);
    assert_eq!(input(pair(&net, receiver, source), voice), None);
    link_connected(&mut net, receiver, id);
    let confirmed = pair(&net, receiver, source);
    assert_eq!(confirmed.id, id);
    assert!(input(confirmed, voice).is_some());
}

#[test]
fn first_file_request_waits_for_both_endpoints_and_wakes_the_room() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    let recipient = join(&mut net, receiver, "Recipient");
    let room = net.create(owner, RoomAccess::Public, false);
    let file = offer_file(&mut net, owner, &room);
    assert!(net.state(receiver).pairs.is_empty());

    command(&mut net, receiver, file_receive(&room, file, true));
    let waiting = &net.state(receiver).files[0];
    assert!(waiting.receiving);
    assert_eq!(waiting.source_id, Some(source));
    assert_eq!(waiting.upstream, None);

    let pending = pair(&net, receiver, source).id;
    link_connected(&mut net, owner, pending);
    assert_eq!(net.state(receiver).files[0].upstream, None);
    link_connected(&mut net, receiver, pending);

    assert_eq!(pair(&net, receiver, source).id, pending);
    assert_eq!(net.state(receiver).files[0].upstream, Some(source));
    assert_eq!(net.state(owner).files[0].downstream, vec![recipient]);
}

#[test]
fn first_forwarded_byte_request_connects_the_provider_to_the_receiver() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Provider");
    let recipient = join(&mut net, receiver, "Viewer");
    let room = net.create(owner, RoomAccess::Public, false);
    let watch = Uuid::new_v4();
    command(
        &mut net,
        owner,
        json!({"type":"start_watch","roomId":room,"id":watch,
            "source":{"kind":"media","url":"https://example.com/movie.mp4"},
            "playback":{"timeline":"media","position":0,"paused":false,"rate":1,"anchorTime":0},
            "byteSource":{"sessionId":source,"resourceId":Uuid::new_v4(),"format":"file"}}),
    );
    command(
        &mut net,
        receiver,
        json!({"type":"join_watch","roomId":room,"id":watch,"mode":"direct"}),
    );
    assert!(net.state(receiver).watch_bytes.is_empty());
    assert!(net.state(receiver).pairs.is_empty());

    command(
        &mut net,
        receiver,
        json!({"type":"join_watch","roomId":room,"id":watch,"mode":"peer"}),
    );
    let waiting = &net.state(receiver).watch_bytes[0];
    assert_eq!(waiting.activity_id, watch);
    assert!(waiting.receiving);
    assert_eq!(waiting.source.session_id, source);
    assert_eq!(waiting.upstream, None);

    let pending = pair(&net, receiver, source).id;
    link_connected(&mut net, receiver, pending);
    assert_eq!(net.state(receiver).watch_bytes[0].upstream, None);
    link_connected(&mut net, owner, pending);

    assert_eq!(pair(&net, receiver, source).id, pending);
    assert_eq!(net.state(receiver).watch_bytes[0].upstream, Some(source));
    assert_eq!(net.state(owner).watch_bytes[0].downstream, vec![recipient]);
}

#[test]
fn withdrawing_a_file_keeps_the_screen_on_the_same_pair() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    join(&mut net, receiver, "Recipient");
    let room = net.create(owner, RoomAccess::Public, false);
    let file = offer_file(&mut net, owner, &room);
    let screen = publish_screen(&mut net, owner, &room);
    assert!(net.state(receiver).pairs.is_empty());

    command(&mut net, receiver, file_receive(&room, file, true));
    let pending = pair(&net, receiver, source).id;
    command(&mut net, receiver, subscribe(screen, true));
    assert_eq!(pair(&net, receiver, source).id, pending);
    link_connected(&mut net, owner, pending);
    link_connected(&mut net, receiver, pending);

    let screen_flow = input(pair(&net, receiver, source), screen).expect("screen input");
    command(
        &mut net,
        receiver,
        json!({"type":"flow_state","pairId":pending,"flowId":screen_flow.id,"state":"decoded"}),
    );
    let active_screen = input(pair(&net, receiver, source), screen).unwrap();
    assert!(active_screen.selected);
    assert!(!net.state(receiver).failed_subscriptions.contains(&screen));
    assert_eq!(net.state(receiver).files[0].upstream, Some(source));

    command(&mut net, receiver, file_receive(&room, file, false));
    assert!(net.state(receiver).files.is_empty());
    let surviving_pair = pair(&net, receiver, source);
    assert_eq!(surviving_pair.id, pending);
    assert_eq!(input(surviving_pair, screen), Some(active_screen));
}

#[test]
fn cancelling_a_waiting_file_retires_its_attempt() {
    let mut net = RoomNetwork::new();
    let [owner, receiver] = [(); 2].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    join(&mut net, receiver, "Recipient");
    let room = net.create(owner, RoomAccess::Public, false);
    let file = offer_file(&mut net, owner, &room);

    command(&mut net, receiver, file_receive(&room, file, true));
    let retired = pair(&net, receiver, source).id;
    link_connected(&mut net, owner, retired);
    assert_eq!(net.state(receiver).files[0].upstream, None);
    command(&mut net, receiver, file_receive(&room, file, false));
    assert!(net.state(receiver).files.is_empty());
    assert!(net.state(owner).files.is_empty());
    assert!(net.state(receiver).pairs.is_empty());
    assert!(net.state(owner).pairs.is_empty());

    link_connected(&mut net, receiver, retired);
    assert!(net.state(receiver).pairs.is_empty());

    command(&mut net, receiver, file_receive(&room, file, true));
    let current = pair(&net, receiver, source).id;
    assert_ne!(current, retired);
    link_connected(&mut net, receiver, current);
    link_connected(&mut net, owner, retired);
    assert_eq!(pair(&net, receiver, source).id, current);
    assert_eq!(net.state(receiver).files[0].upstream, None);
    link_connected(&mut net, owner, current);
    assert_eq!(net.state(receiver).files[0].upstream, Some(source));
}

#[test]
fn cold_screen_direct_failure_discovers_a_room_reader_before_media_failure() {
    let mut net = RoomNetwork::new();
    let [owner, receiver, helper] = [(); 3].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    let viewer = join(&mut net, receiver, "Viewer");
    join(&mut net, helper, "Reader");
    let room = net.create(owner, RoomAccess::Public, false);
    command(&mut net, helper, json!({"type":"browse","roomId":room,"active":true}));
    let screen = publish_screen(&mut net, owner, &room);
    command(&mut net, receiver, subscribe(screen, true));
    let pending = pair(&net, receiver, source);
    assert!(input(pending, screen).is_none());
    let direct = pending.id;
    assert!(net.state(helper).pairs.is_empty());

    command(
        &mut net,
        receiver,
        json!({"type":"link_state","pairId":direct,"state":"failed"}),
    );
    let repair = net.state(helper).pairs.first().expect("room reader repair");
    assert!([source, viewer].contains(&repair.peer_id));
    let state = net.state(receiver);
    assert!(state.subscriptions.contains(&screen));
    assert!(!state.failed_subscriptions.contains(&screen));
}
