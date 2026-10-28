use piik_channel_prototype::{
    history::HistoryRequest,
    wire::{Event, Request, Snapshot},
    Authority, Effects,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn apply(core: &mut Authority, connection: Uuid, mut command: Value, now: u64) -> Effects {
    if command["type"] == "join" {
        command["signingKey"] = json!(
            piik_channel_prototype::conversation::SessionSigner::from_seed([1; 32]).signing_key()
        );
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
            json!({"type":"join", "key":if owner {"owner"} else {"invite"}, "name":"Friend"}),
            now,
        ),
        connection,
    )
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

#[test]
fn replacement_fences_old_commands_and_close_without_retiring_healthy_sources() {
    let mut core = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
    let owner = Uuid::new_v4();
    let old = Uuid::new_v4();
    let current = Uuid::new_v4();
    let watcher = Uuid::new_v4();
    join(&mut core, owner, true, 0);
    let (session, credential, _) = join(&mut core, old, false, 0);
    join(&mut core, watcher, false, 0);
    let own_source = Uuid::new_v4();
    let other_source = Uuid::new_v4();
    for (connection, source) in [(owner, own_source), (old, other_source)] {
        apply(
            &mut core,
            connection,
            json!({"type":"publish", "publication":{"id":source, "roomId":"living", "kind":"screen", "muted":false}}),
            0,
        );
    }
    let watching = apply(
        &mut core,
        watcher,
        json!({"type":"subscribe", "publicationId":own_source, "enabled":true}),
        0,
    );
    let healthy_pair = state(&watching, watcher).pairs[0].id;
    let healthy_flow = state(&watching, watcher).pairs[0]
        .incoming
        .iter()
        .find(|flow| flow.publication_id == own_source)
        .unwrap()
        .id;
    for connection in [owner, watcher] {
        apply(
            &mut core,
            connection,
            json!({"type":"link_state","pairId":healthy_pair,"state":"connected"}),
            0,
        );
    }
    apply(
        &mut core,
        watcher,
        json!({"type":"flow_state","flowId":healthy_flow,"pairId":healthy_pair,"state":"forwardable"}),
        0,
    );

    let resumed = apply(
        &mut core,
        current,
        json!({"type":"join", "name":"Friend", "credential":credential, "sessionId":session}),
        50,
    );
    assert_eq!(resumed.close, vec![old]);
    assert!(resumed.events.iter().all(|(target, _)| *target != old));
    assert_eq!(welcome(resumed, current).0, session);

    let stale = apply(
        &mut core,
        old,
        json!({"type":"unpublish", "publicationId":other_source}),
        60,
    );
    assert_eq!(stale.close, vec![old]);
    let stale_send = apply(
        &mut core,
        old,
        json!({"type":"chat", "roomId":"living", "text":"Stale", "nonce":"stale"}),
        60,
    );
    assert!(stale_send.history.is_none());
    assert_eq!(stale_send.close, vec![old]);
    assert!(core.disconnect(old, 70).events.is_empty());
    let updated = apply(
        &mut core,
        owner,
        json!({"type":"set_name", "name":"Owner"}),
        80,
    );
    assert!(state(&updated, current)
        .publications
        .iter()
        .any(|source| source.id == other_source));

    core.disconnect(current, 100);
    assert!(core.disconnect(current, 15_000).events.is_empty());
    assert!(core.expire(20_099).events.is_empty());
    let expired = core.expire(20_100);
    let remaining = state(&expired, watcher);
    assert!(!remaining
        .publications
        .iter()
        .any(|source| source.id == other_source));
    assert!(remaining
        .publications
        .iter()
        .any(|source| source.id == own_source));
    assert_eq!(remaining.pairs[0].id, healthy_pair);
    assert!(!remaining
        .sessions
        .iter()
        .any(|endpoint| endpoint.id == session));
}

#[test]
fn history_requests_carry_authenticated_author_and_defer_confirmation() {
    let mut core = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
    let connection = Uuid::new_v4();
    let (session, _, joined) = join(&mut core, connection, false, 0);
    let author = joined
        .sessions
        .iter()
        .find(|endpoint| endpoint.id == session)
        .unwrap()
        .user_id;

    let browse = apply(
        &mut core,
        connection,
        json!({"type":"browse","active":true, "roomId":"studio", "requestId":"browse"}),
        1,
    );
    assert!(browse
        .events
        .iter()
        .all(|(_, event)| !matches!(event, Event::History { .. })));
    assert!(
        state(&browse, connection)
            .channel
            .rooms
            .iter()
            .find(|room| room.id == "studio")
            .unwrap()
            .reading
    );
    assert!(browse.history.is_none());
    assert!(browse
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Ack { request_id } if request_id == "browse")));

    let send = apply(
        &mut core,
        connection,
        json!({"type":"chat", "roomId":"living", "text":"  Hello  ", "nonce":"send-once", "attachments":[], "requestId":"send"}),
        2,
    );
    assert!(send.events.is_empty());
    assert!(send.close.is_empty());
    let HistoryRequest::Send { room_id, draft } = send.history.unwrap().request else {
        panic!("authorized chat must produce a store request");
    };
    assert_eq!(room_id, "living");
    assert_eq!(draft.user_id, author);
    assert_eq!(draft.nonce, "send-once");
    assert_eq!(draft.text, "Hello");
    assert!(draft.attachments.is_empty());
    assert_eq!(draft.time, 2);

    let older = apply(
        &mut core,
        connection,
        json!({"type":"history", "roomId":"living", "before":12, "requestId":"older"}),
        3,
    );
    assert!(older.events.is_empty());
    assert!(matches!(
        older.history.unwrap().request,
        HistoryRequest::Read { room_id, before: Some(12) } if room_id == "living"
    ));
}

#[test]
fn public_dispatch_owns_authorization_state_before_ack_and_explicit_leave() {
    assert!(matches!(
        Authority::new("same".into(), "same".into(), vec![]),
        Err("invalid_admission_keys")
    ));
    let mut core = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
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
    let revoked = apply(
        &mut core,
        owner,
        json!({"type":"set_roles", "userId":guest_user, "roles":[], "requestId":"roles"}),
        1,
    );
    assert!(
        matches!(revoked.events.last(), Some((target, Event::Ack { request_id })) if *target == owner && request_id == "roles")
    );
    assert!(state(&revoked, guest)
        .users
        .iter()
        .find(|user| user.id == guest_user)
        .unwrap()
        .roles
        .is_empty());
    assert!(state(&revoked, guest)
        .sessions
        .iter()
        .any(|endpoint| endpoint.id == guest_session && endpoint.online));
    let forbidden = apply(
        &mut core,
        guest,
        json!({"type":"host_register", "room":{"id":Uuid::new_v4(), "name":"Denied", "creatorId":guest_user,
            "access":"public", "hidden":false, "hasPassword":false}, "requestId":"create"}),
        2,
    );
    assert!(forbidden.close.is_empty());
    assert!(
        matches!(forbidden.events.as_slice(), [(target, Event::Error { code, request_id:Some(request_id) })] if *target == guest && code == "forbidden" && request_id == "create")
    );
    let denied_send = apply(
        &mut core,
        guest,
        json!({"type":"chat", "roomId":"living", "text":"Denied", "nonce":"denied"}),
        2,
    );
    assert!(denied_send.history.is_none());
    assert!(matches!(
        denied_send.events.as_slice(),
        [(target, Event::Error { code, .. })] if *target == guest && code == "forbidden"
    ));

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
    let mut core = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
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
        json!({"type":"join", "key":"invite", "name":"Waiting"}),
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
