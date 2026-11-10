use piik_channel_core::{
    wire::{Event, Request, Snapshot},
    Authority, Effects,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn apply(core: &mut Authority, connection: Uuid, mut command: Value, now: u64) -> Effects {
    if command["type"] == "join" {
        if command.get("protocol").is_none() {
            command["protocol"] = json!(piik_channel_core::wire::CHANNEL_PROTOCOL);
        }
        command["signingKey"] =
            json!(piik_channel_core::conversation::SessionSigner::from_seed([1; 32]).signing_key());
    }
    core.handle(
        connection,
        Request::parse(&command.to_string()).unwrap(),
        now,
    )
}

fn welcome(effects: Effects, connection: Uuid) -> (Uuid, String, Snapshot) {
    effects
        .events
        .into_iter()
        .find_map(|(target, event)| match event {
            Event::Welcome {
                session_id,
                credential,
                state,
                ..
            } if target == connection => Some((session_id, credential, state)),
            _ => None,
        })
        .expect("successful admission")
}

fn join(core: &mut Authority, connection: Uuid, owner: bool, now: u64) -> (Uuid, String, Snapshot) {
    welcome(
        apply(
            core,
            connection,
            json!({"type":"join", "ownerKey":owner.then_some("owner"), "name":"Friend"}),
            now,
        ),
        connection,
    )
}

#[test]
fn domain_protocol_rejects_old_clients_before_admission() {
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let before = serde_json::to_value(core.export_backup()).unwrap();
    for protocol in [None, Some(0), Some(1), Some(2), Some(3), Some(4), Some(5)] {
        let connection = Uuid::new_v4();
        let mut join = json!({"type":"join","name":"Old","requestId":"join",
            "signingKey":piik_channel_core::conversation::SessionSigner::from_seed([1; 32]).signing_key()});
        if let Some(protocol) = protocol {
            join["protocol"] = json!(protocol);
        }
        let effects = core.handle(connection, Request::parse(&join.to_string()).unwrap(), 0);
        assert!(effects.close.contains(&connection));
        assert!(effects.events.iter().any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "incompatible_protocol")));
        assert!(!effects
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::Welcome { .. } | Event::HostInput { .. })));
        assert_eq!(serde_json::to_value(core.export_backup()).unwrap(), before);
    }
    let connection = Uuid::new_v4();
    let effects = apply(
        &mut core,
        connection,
        json!({"type":"join","name":"Current"}),
        0,
    );
    assert!(effects.events.iter().any(|(_, event)| matches!(event, Event::Welcome { protocol, .. } if *protocol == piik_channel_core::wire::CHANNEL_PROTOCOL)));
}

#[test]
fn open_site_preserves_personal_identity_and_reserves_metadata_for_its_operator() {
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let operator = Uuid::new_v4();
    let (_, operator_credential, _) = join(&mut core, operator, true, 0);
    let visitor = Uuid::new_v4();
    let (session, credential, initial) = join(&mut core, visitor, false, 0);
    let user = initial
        .sessions
        .iter()
        .find(|value| value.id == session)
        .unwrap()
        .user_id;
    let channel = serde_json::to_value(initial.channel).unwrap();
    for removed in ["access", "hasPassword", "inviteHash"] {
        assert!(channel.get(removed).is_none());
    }
    let change = json!({"type":"update_domain","name":"Friends","icon":"couch"});
    assert!(apply(&mut core, visitor, change.clone(), 1)
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Error { code,.. } if code=="forbidden")));
    assert_eq!(
        state(&apply(&mut core, operator, change, 1), visitor)
            .channel
            .name,
        "Friends"
    );
    assert!(core.is_owner_credential(&operator_credential));
    assert!(!core.is_owner_credential(&credential));
    core.disconnect(visitor, 2);
    let next = Uuid::new_v4();
    let (resumed, same_credential, current) = welcome(
        apply(
            &mut core,
            next,
            json!({"type":"join","name":"Visitor","credential":credential,"sessionId":session}),
            3,
        ),
        next,
    );
    assert_eq!(resumed, session);
    assert_eq!(same_credential, credential);
    assert_eq!(
        current
            .sessions
            .iter()
            .find(|value| value.id == resumed)
            .unwrap()
            .user_id,
        user
    );
    assert!(Request::parse(r#"{"type":"domain_invite"}"#).is_err());
    assert!(Request::parse(
        r#"{"type":"update_domain","name":"Locked","icon":"couch","access":"private"}"#
    )
    .is_err());
}

fn state(effects: &Effects, connection: Uuid) -> &Snapshot {
    effects
        .events
        .iter()
        .find_map(|(target, event)| match event {
            Event::State { state } if *target == connection => Some(state),
            _ => None,
        })
        .expect("personalized state")
}

#[cfg(feature = "sqlite")]
mod support;

#[cfg(feature = "sqlite")]
#[test]
fn replacement_fences_old_commands_and_close_without_retiring_healthy_sources() {
    use piik_channel_core::wire::RoomAccess;
    let mut core = support::RoomNetwork::new();
    let owner = Uuid::new_v4();
    let old = Uuid::new_v4();
    let current = Uuid::new_v4();
    let watcher = Uuid::new_v4();
    core.command_at(
        owner,
        json!({"type":"join","ownerKey":"owner","name":"Owner"}),
        0,
    );
    let (session, credential, _) = welcome(
        core.command_at(old, json!({"type":"join","name":"Source"}), 0),
        old,
    );
    core.command_at(watcher, json!({"type":"join","name":"Watcher"}), 0);
    let room = core.create(owner, RoomAccess::Public, false);
    let own_source = Uuid::new_v4();
    let other_source = Uuid::new_v4();
    for (connection, source) in [(owner, own_source), (old, other_source)] {
        core.command_at(connection, json!({"type":"publish","publication":{"id":source,"roomId":room,"kind":"screen","videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}}), 100);
    }
    core.command_at(
        watcher,
        json!({"type":"subscribe","publicationId":own_source,"enabled":true}),
        100,
    );
    let pair = core
        .state(watcher)
        .pairs
        .iter()
        .find(|pair| {
            pair.incoming
                .iter()
                .any(|flow| flow.publication_id == own_source)
        })
        .unwrap()
        .id;
    let flow = core
        .state(watcher)
        .pairs
        .iter()
        .flat_map(|pair| &pair.incoming)
        .find(|flow| flow.publication_id == own_source)
        .unwrap()
        .id;
    core.command_at(
        watcher,
        json!({"type":"flow_state","flowId":flow,"pairId":pair,"state":"decoded"}),
        100,
    );
    let resumed = core.command_at(
        current,
        json!({"type":"join","name":"Source","credential":credential,"sessionId":session}),
        150,
    );
    assert_eq!(resumed.close, vec![old]);
    assert_eq!(welcome(resumed, current).0, session);
    let stale = core.command_at(
        old,
        json!({"type":"unpublish","publicationId":other_source}),
        160,
    );
    assert_eq!(stale.close, vec![old]);
    assert!(core.authority.disconnect(old, 170).events.is_empty());
    core.command_at(owner, json!({"type":"set_name","name":"Owner"}), 180);
    assert!(core
        .state(current)
        .publications
        .iter()
        .any(|source| source.id == other_source));
    let disconnected = core.authority.disconnect(current, 200);
    core.deliver(disconnected);
    assert!(core.authority.disconnect(current, 15_000).events.is_empty());
    assert!(core.authority.expire(20_199).events.is_empty());
    let expired = core.authority.expire(20_200);
    core.deliver(expired);
    let remaining = core.state(watcher);
    assert!(!remaining
        .publications
        .iter()
        .any(|source| source.id == other_source));
    assert!(remaining
        .publications
        .iter()
        .any(|source| source.id == own_source));
    assert!(remaining.pairs.iter().any(|candidate| candidate.id == pair));
    assert!(!remaining
        .sessions
        .iter()
        .any(|endpoint| endpoint.id == session));
}

#[cfg(feature = "sqlite")]
#[test]
fn hosted_history_uses_authenticated_peer_author_and_the_original_confirmation() {
    use piik_channel_core::{
        conversation::{ConversationCommand, ConversationResult},
        history::HistoryResult,
        wire::RoomAccess,
    };
    let mut core = support::RoomNetwork::new();
    let owner = Uuid::new_v4();
    let author = Uuid::new_v4();
    core.command(
        owner,
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    let (session, _, joined) = welcome(
        core.command(author, json!({"type":"join","name":"Writer"})),
        author,
    );
    let user = joined
        .sessions
        .iter()
        .find(|entry| entry.id == session)
        .unwrap()
        .user_id;
    let room = core.create(owner, RoomAccess::Public, false);
    core.command(author, json!({"type":"browse","active":true,"roomId":room}));
    let send = |text: &str| ConversationCommand::Chat {
        text: text.into(),
        nonce: "send-once".into(),
        attachments: vec![],
    };
    let ConversationResult::History(HistoryResult::Sent(first)) = core
        .peer_request(author, &room, send("  Hello  "))
        .result
        .unwrap()
    else {
        panic!("confirmed send")
    };
    assert!(first.inserted);
    assert_eq!(first.message.message.user_id, user);
    assert_eq!(first.message.message.text, "Hello");
    assert_eq!(first.message.message.seq, 1);
    let ConversationResult::History(HistoryResult::Sent(retry)) = core
        .peer_request(author, &room, send("Changed retry"))
        .result
        .unwrap()
    else {
        panic!("original confirmation")
    };
    assert!(!retry.inserted);
    assert_eq!(
        serde_json::to_value(first.message).unwrap(),
        serde_json::to_value(retry.message).unwrap()
    );
    assert!(
        matches!(core.peer_request(author, &room, ConversationCommand::History { before:Some(12) }).result,
        Ok(ConversationResult::History(HistoryResult::Page { messages, .. })) if messages.len() == 1)
    );
}

#[test]
fn public_dispatch_owns_authorization_state_before_ack_and_explicit_leave() {
    assert!(matches!(
        Authority::new("".into(), vec![]),
        Err("invalid_owner_key")
    ));
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let owner = Uuid::new_v4();
    let guest = Uuid::new_v4();
    join(&mut core, owner, true, 0);
    let (guest_session, _, joined) = join(&mut core, guest, false, 0);
    let guest_user = joined
        .sessions
        .iter()
        .find(|endpoint| endpoint.id == guest_session)
        .unwrap()
        .user_id;
    let created = apply(
        &mut core,
        guest,
        json!({"type":"create_room", "room":{"id":Uuid::new_v4(), "name":"Friends", "icon":"couch", "creatorId":guest_user,
            "access":"public", "hidden":false, "hasPassword":false}, "requestId":"create"}),
        2,
    );
    assert!(created.close.is_empty());
    assert!(
        matches!(created.events.last(), Some((target, Event::RoomCreated { room, request_id:Some(request_id) }))
        if *target == guest && room.creator_id == guest_user && request_id == "create")
    );
    let left = apply(
        &mut core,
        guest,
        json!({"type":"leave", "requestId":"leave"}),
        3,
    );
    assert_eq!(left.close, vec![guest]);
    assert!(
        matches!(left.events.last(), Some((target, Event::Ack { request_id })) if *target == guest && request_id == "leave")
    );
    assert!(!state(&left, owner)
        .sessions
        .iter()
        .any(|endpoint| endpoint.id == guest_session));
    assert!(core.disconnect(guest, 4).events.is_empty());
}

#[test]
fn admission_expires_old_endpoint_without_requiring_a_transport_timer() {
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let owner = Uuid::new_v4();
    join(&mut core, owner, true, 0);
    let old = Uuid::new_v4();
    let (old_session, credential, _) = join(&mut core, old, false, 0);
    for _ in 0..18 {
        join(&mut core, Uuid::new_v4(), false, 0);
    }
    core.disconnect(old, 100);
    let waiting = Uuid::new_v4();
    let full = apply(
        &mut core,
        waiting,
        json!({"type":"join", "name":"Waiting"}),
        20_099,
    );
    assert_eq!(full.close, vec![waiting]);
    assert!(full
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "channel_full")));
    let current = Uuid::new_v4();
    let renewed = apply(
        &mut core,
        current,
        json!({"type":"join", "credential":credential, "sessionId":old_session, "name":"Friend"}),
        20_100,
    );
    let (new_session, _, state) = welcome(renewed, current);
    assert_ne!(old_session, new_session);
    assert_eq!(state.sessions.len(), 20);
    assert!(!state
        .sessions
        .iter()
        .any(|session| session.id == old_session));
}

#[test]
fn domain_checkpoint_has_no_room_policy_and_preserves_the_saved_owner_name() {
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    assert_eq!(core.owner_name(), None);
    let owner = Uuid::new_v4();
    let (_, credential, initial) = join(&mut core, owner, true, 0);
    assert!(initial.channel.rooms.is_empty());
    apply(
        &mut core,
        owner,
        json!({"type":"set_name","name":"Saved owner"}),
        1,
    );
    let checkpoint = serde_json::to_value(core.export_state()).unwrap();
    assert_eq!(checkpoint["version"], 5);
    assert!(checkpoint.get("rooms").is_none());
    assert_eq!(checkpoint["hostedRooms"], json!({}));
    let mut restored = Authority::new("owner".into(), vec![]).unwrap();
    restored
        .import_state(serde_json::from_value(checkpoint.clone()).unwrap())
        .unwrap();
    assert_eq!(restored.owner_name(), Some("Saved owner"));
    for admission in [
        json!({"type":"join","ownerKey":"owner","name":"Old owner page"}),
        json!({"type":"join","credential":credential,"name":"Piik Native"}),
    ] {
        let connection = Uuid::new_v4();
        let (_, _, state) = welcome(apply(&mut restored, connection, admission, 2), connection);
        assert_eq!(state.users[0].name, "Saved owner");
        assert_eq!(restored.owner_name(), Some("Saved owner"));
    }
    let mut old = checkpoint;
    old["version"] = json!(2);
    assert_eq!(
        restored.import_state(serde_json::from_value(old).unwrap()),
        Err("invalid_state")
    );
    assert_eq!(restored.owner_name(), Some("Saved owner"));
}
