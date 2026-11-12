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

fn profiles(
    core: &mut Authority,
    connection: Uuid,
    ids: Vec<Uuid>,
    now: u64,
) -> Vec<piik_channel_core::wire::UserInfo> {
    apply(
        core,
        connection,
        json!({"type":"profiles","requestId":"profiles","ids":ids}),
        now,
    )
    .events
    .into_iter()
    .find_map(|(_, event)| match event {
        Event::Profiles { profiles, .. } => Some(profiles),
        _ => None,
    })
    .unwrap()
}

#[test]
fn retained_profiles_are_read_in_bounded_pages_without_consuming_live_identity_capacity() {
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let owner = Uuid::new_v4();
    let (_, _, initial) = join(&mut core, owner, true, 0);
    let owner_id = initial.users[0].id;
    let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    let mut retained = Vec::new();
    for index in 0..75 {
        let connection = Uuid::new_v4();
        let (session, credential, state) = join(&mut core, connection, false, 0);
        let id = state
            .sessions
            .iter()
            .find(|endpoint| endpoint.id == session)
            .unwrap()
            .user_id;
        apply(
            &mut core,
            connection,
            json!({"type":"set_profile","name":format!("Friend {index}"),"avatar":image}),
            0,
        );
        retained.push((id, credential));
        apply(&mut core, connection, json!({"type":"leave"}), 0);
    }
    let current = profiles(&mut core, owner, vec![retained[0].0, Uuid::new_v4()], 0);
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].avatar.as_deref(), Some(image));
    let original_version = current[0].version.clone();
    let mut cursor = None;
    let mut listed = Vec::new();
    loop {
        let page = apply(
            &mut core,
            owner,
            json!({"type":"profiles","requestId":"page","after":cursor,"query":"  FRIEND "}),
            0,
        );
        let (profiles, total, next) = page
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::Profiles {
                    profiles,
                    total,
                    next_cursor,
                    ..
                } => Some((profiles, total, next_cursor)),
                _ => None,
            })
            .unwrap();
        assert_eq!(total, 76);
        assert!(profiles.len() <= piik_channel_core::PROFILE_PAGE_SIZE);
        listed.extend(profiles.into_iter().map(|profile| profile.id));
        cursor = next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(listed.len(), 76);
    assert!(listed.windows(2).all(|pair| pair[0] < pair[1]));
    for query in [
        json!({"type":"profiles","requestId":"bad","ids":vec![owner_id;33]}),
        json!({"type":"profiles","requestId":"bad","ids":[owner_id],"query":"Friend"}),
        json!({"type":"profiles","requestId":"bad","query":"x".repeat(41)}),
    ] {
        assert!(apply(&mut core, owner, query, 0).events.iter().any(
            |(_, e)| matches!(e, Event::Error { code, .. } if code == "invalid_profile_query")
        ));
    }
    let checkpoint = serde_json::to_value(core.export_backup()).unwrap();
    assert!(checkpoint["state"]["users"]
        .as_array()
        .unwrap()
        .iter()
        .all(|user| user.get("version").is_none()));
    let metadata: piik_channel_core::backup::DomainMetadata =
        serde_json::from_value(checkpoint).unwrap();
    let mut restored = metadata.into_authority(vec![]).unwrap();
    let connection = Uuid::new_v4();
    let joined = apply(
        &mut restored,
        connection,
        json!({"type":"join","credential":retained[0].1,"name":"Old display"}),
        1,
    );
    let (self_profile, state) = joined
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome {
                self_profile,
                state,
                ..
            } => Some((self_profile, state)),
            _ => None,
        })
        .unwrap();
    assert_eq!(self_profile.version, original_version);
    assert_eq!(self_profile.avatar.as_deref(), Some(image));
    assert_eq!(state.channel.user_count, 76);
    assert_eq!(state.users.len(), 2); // current endpoint and the offline site owner
    assert!(serde_json::to_value(&state.users)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .all(|user| user.get("avatar").is_none()));
    apply(
        &mut restored,
        connection,
        json!({"type":"set_profile","name":"New name","avatar":null}),
        2,
    );
    let changed = profiles(&mut restored, connection, vec![self_profile.id], 2).remove(0);
    assert_ne!(changed.version, original_version);
    assert!(changed.avatar.is_none());
    let (_, _, state) = join(&mut restored, Uuid::new_v4(), false, 3);
    assert_eq!(state.channel.user_count, 77);
    for name in ["Caf\u{e9}", "Cafe\u{301}"] {
        apply(
            &mut restored,
            connection,
            json!({"type":"set_profile","name":name,"avatar":null}),
            4,
        );
        for query in ["CAF\u{c9}", "CAFE\u{301}"] {
            let found = apply(
                &mut restored,
                connection,
                json!({"type":"profiles","requestId":"normalized","query":query}),
                4,
            );
            assert!(
                found.events.iter().any(
                    |(_, event)| matches!(event, Event::Profiles { profiles, total:1, .. }
                if profiles.len()==1 && profiles[0].id==self_profile.id && profiles[0].name==name)
                ),
                "name {name:?} must match query {query:?}"
            );
        }
    }
    let name = "\u{e9}".repeat(40);
    apply(
        &mut restored,
        connection,
        json!({"type":"set_profile","name":name,"avatar":null}),
        5,
    );
    let found = apply(
        &mut restored,
        connection,
        json!({"type":"profiles","requestId":"normalized-limit","query":"e\u{301}".repeat(40)}),
        5,
    );
    assert!(found.events.iter().any(
        |(_, event)| matches!(event, Event::Profiles { profiles, total:1, .. }
        if profiles.len()==1 && profiles[0].id==self_profile.id && profiles[0].name==name)
    ));
}

#[test]
fn domain_protocol_rejects_old_clients_before_admission() {
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let before = serde_json::to_value(core.export_backup()).unwrap();
    for protocol in [
        None,
        Some(0),
        Some(1),
        Some(2),
        Some(3),
        Some(4),
        Some(5),
        Some(6),
    ] {
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
        core.command_at(connection, json!({"type":"publish","publication":{"id":source,"roomId":room,"kind":"screen","source":{"kind":"screen","name":null},"videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}}), 100);
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
    core.command_at(
        owner,
        json!({"type":"set_profile","avatar":null,"name":"Owner"}),
        180,
    );
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
        mentions: vec![],
        reply: None,
        inline_images: Default::default(),
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
    for _ in 0..piik_channel_core::MAX_SESSIONS - 2 {
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
    assert_eq!(state.sessions.len(), piik_channel_core::MAX_SESSIONS);
    assert!(!state
        .sessions
        .iter()
        .any(|session| session.id == old_session));
}

#[test]
fn domain_checkpoint_and_backup_preserve_profile_across_endpoint_admission() {
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    assert_eq!(core.owner_name(), None);
    // A fresh persistent checkpoint may reserve an owner who has not joined yet.
    let fresh = core.export_backup();
    assert!(fresh.clone().into_authority(vec![]).is_ok());
    assert!(fresh.archive_metadata().is_err());
    let guest = Uuid::new_v4();
    join(&mut core, guest, false, 0);
    assert!(core.export_backup().into_authority(vec![]).is_ok());
    apply(&mut core, guest, json!({"type":"leave"}), 0);
    let owner = Uuid::new_v4();
    let (_, credential, initial) = join(&mut core, owner, true, 0);
    assert!(initial.channel.rooms.is_empty());
    let avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    apply(
        &mut core,
        owner,
        json!({"type":"set_profile","avatar":avatar,"name":"Saved owner"}),
        1,
    );
    let checkpoint = serde_json::to_value(core.export_state()).unwrap();
    assert_eq!(checkpoint["version"], 6);
    assert!(checkpoint.get("rooms").is_none());
    assert_eq!(checkpoint["hostedRooms"], json!({}));
    let mut restored = Authority::new("owner".into(), vec![]).unwrap();
    restored
        .import_state(serde_json::from_value(checkpoint.clone()).unwrap())
        .unwrap();
    assert_eq!(restored.owner_name(), Some("Saved owner"));
    let backup = serde_json::to_value(restored.export_backup()).unwrap();
    assert_eq!(backup["version"], 2);
    let backup: piik_channel_core::backup::DomainMetadata = serde_json::from_value(backup).unwrap();
    restored = backup.into_authority(vec![]).unwrap();
    for admission in [
        json!({"type":"join","ownerKey":"owner","name":"Old owner page"}),
        json!({"type":"join","credential":credential,"name":"Piik Native"}),
    ] {
        let connection = Uuid::new_v4();
        let (_, _, state) = welcome(apply(&mut restored, connection, admission, 2), connection);
        assert_eq!(state.users[0].name, "Saved owner");
        assert_eq!(
            profiles(&mut restored, connection, vec![state.users[0].id], 2)[0]
                .avatar
                .as_deref(),
            Some(avatar)
        );
        assert_eq!(restored.owner_name(), Some("Saved owner"));
    }
    for field in ["id", "ownerId"] {
        let mut invalid = checkpoint.clone();
        invalid[field] = json!(Uuid::nil());
        assert_eq!(
            restored.import_state(serde_json::from_value(invalid).unwrap()),
            Err("invalid_state")
        );
        assert_eq!(restored.owner_name(), Some("Saved owner"));
    }
    let mut old = checkpoint;
    old["version"] = json!(5);
    assert_eq!(
        restored.import_state(serde_json::from_value(old).unwrap()),
        Err("invalid_state")
    );
    assert_eq!(restored.owner_name(), Some("Saved owner"));
}

#[test]
fn profile_update_and_clear_follow_the_user_across_live_endpoints() {
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let first = Uuid::new_v4();
    let (first_session, credential, _) = join(&mut core, first, false, 0);
    let second = Uuid::new_v4();
    let (_, _, initial) = welcome(
        apply(
            &mut core,
            second,
            json!({"type":"join", "credential":credential, "name":"Old device name"}),
            1,
        ),
        second,
    );
    let user_id = initial
        .sessions
        .iter()
        .find(|session| session.id == first_session)
        .unwrap()
        .user_id;
    let stranger = Uuid::new_v4();
    join(&mut core, stranger, true, 2);
    let avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    let updated = apply(
        &mut core,
        first,
        json!({"type":"set_profile", "name":" Same friend ", "avatar":avatar, "requestId":"profile"}),
        3,
    );
    for connection in [first, second, stranger] {
        let snapshot = state(&updated, connection);
        let user = snapshot
            .users
            .iter()
            .find(|user| user.id == user_id)
            .unwrap();
        assert_eq!(user.name, "Same friend");
        let profile = profiles(&mut core, connection, vec![user_id], 3).remove(0);
        assert_eq!(profile.avatar.as_deref(), Some(avatar));
        assert_eq!(user.version, profile.version);
    }
    assert!(updated.events.iter().any(|(target, event)| *target == first
        && matches!(event, Event::Ack { request_id } if request_id == "profile")));
    core.disconnect(first, 4);
    let resumed = Uuid::new_v4();
    let (_, _, snapshot) = welcome(
        apply(
            &mut core,
            resumed,
            json!({"type":"join", "credential":credential, "sessionId":first_session, "name":"Stale startup name"}),
            5,
        ),
        resumed,
    );
    assert_eq!(
        profiles(&mut core, resumed, vec![user_id], 5)[0]
            .avatar
            .as_deref(),
        Some(avatar)
    );
    let previous_version = snapshot
        .users
        .iter()
        .find(|user| user.id == user_id)
        .unwrap()
        .version
        .clone();
    let cleared = apply(
        &mut core,
        second,
        json!({"type":"set_profile", "name":"Same friend", "avatar":null}),
        6,
    );
    assert!(profiles(&mut core, resumed, vec![user_id], 6)[0]
        .avatar
        .is_none());
    assert_ne!(
        state(&cleared, resumed)
            .users
            .iter()
            .find(|user| user.id == user_id)
            .unwrap()
            .version,
        previous_version
    );
    assert!(serde_json::to_value(core.export_state()).unwrap()["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|user| user["id"] == user_id.to_string())
        .unwrap()["avatar"]
        .is_null());
}
