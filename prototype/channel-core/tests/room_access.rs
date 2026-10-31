#![cfg(feature = "sqlite")]

use piik_channel_core::{
    host::RoomResult,
    wire::{Event, Snapshot},
    Effects,
};
use serde_json::{json, Value};
use uuid::Uuid;
mod support;
use support::RoomNetwork;

fn command(core: &mut RoomNetwork, connection: Uuid, value: Value) -> Effects {
    core.command(connection, value)
}
fn admit(core: &mut RoomNetwork, connection: Uuid, value: Value) -> (Uuid, String, Snapshot) {
    command(core, connection, value)
        .events
        .into_iter()
        .find_map(|(_, e)| match e {
            Event::Welcome {
                session_id,
                credential,
                state,
                ..
            } => Some((session_id, credential, state)),
            _ => None,
        })
        .expect("admission")
}
fn state(effects: Effects, connection: Uuid) -> Snapshot {
    effects
        .events
        .into_iter()
        .rev()
        .find_map(|(c, e)| match e {
            Event::State { state } if c == connection => Some(state),
            _ => None,
        })
        .unwrap()
}
fn room(core: &mut RoomNetwork, connection: Uuid, access: &str, hidden: bool) -> String {
    core.create(
        connection,
        serde_json::from_value(json!(access)).unwrap(),
        hidden,
    )
}
fn invite(core: &mut RoomNetwork, connection: Uuid, room: &str) -> String {
    command(
        core,
        connection,
        json!({"type":"room_invite","roomId":room,"requestId":"invite"}),
    )
    .events
    .into_iter()
    .find_map(|(_, e)| match e {
        Event::RoomInvite {
            key, request_id, ..
        } => {
            assert_eq!(request_id.as_deref(), Some("invite"));
            Some(key)
        }
        _ => None,
    })
    .unwrap()
}
fn rejected(effects: Effects) {
    assert!(effects.events.iter().any(|(_, e)| matches!(
        e,
        Event::Error { .. }
            | Event::RoomReply {
                result: RoomResult::Error { .. },
                ..
            }
    )));
}
fn core() -> RoomNetwork {
    RoomNetwork::new()
}

#[test]
fn hosted_room_catalogs_keep_the_per_room_source_limit_without_a_domain_total() {
    let mut core = core();
    let peers: Vec<_> = (0..20).map(|index| {
        let connection = Uuid::new_v4();
        admit(&mut core, connection, json!({"type":"join","name":"Participant","key":if index == 0 {"owner"} else {"invite"}}));
        connection
    }).collect();
    let rooms: Vec<_> = (0..3)
        .map(|_| room(&mut core, peers[0], "public", false))
        .collect();
    for room in &rooms {
        for connection in &peers {
            command(
                &mut core,
                *connection,
                json!({"type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false}),
            );
            for kind in ["screen", "voice"] {
                command(
                    &mut core,
                    *connection,
                    json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":kind,"muted":false}}),
                );
            }
        }
        let duplicate = command(
            &mut core,
            peers[0],
            json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":"screen","muted":false}}),
        );
        assert!(duplicate.events.iter().any(|(_, event)| matches!(event,
            Event::RoomReply { result: RoomResult::Error { code }, .. } if code == "source_already_published")));
        assert_eq!(
            core.state(peers[0])
                .publications
                .iter()
                .filter(|publication| &publication.room_id == room)
                .count(),
            40
        );
    }
    assert_eq!(core.state(peers[0]).publications.len(), 120);
}

#[test]
fn independent_rooms_share_transport_without_sharing_activity_lifetimes() {
    let mut core = core();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    admit(
        &mut core,
        a,
        json!({"type":"join","name":"A","key":"owner"}),
    );
    let (b_session, _, _) = admit(
        &mut core,
        b,
        json!({"type":"join","name":"B","key":"invite"}),
    );
    let living = room(&mut core, a, "public", false);
    let studio = room(&mut core, a, "public", false);
    let quiet = room(&mut core, a, "public", false);
    let mut voices = Vec::new();
    for room in [&living, &studio] {
        for connection in [a, b] {
            command(
                &mut core,
                connection,
                json!({"type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false}),
            );
            let id = Uuid::new_v4();
            voices.push(id);
            command(
                &mut core,
                connection,
                json!({"type":"publish","publication":{"id":id,"roomId":room,"kind":"voice","muted":false}}),
            );
        }
    }
    for room in [&living, &studio] {
        let pair = core
            .state(b)
            .pairs
            .iter()
            .find(|pair| pair.rooms.contains(room))
            .unwrap()
            .id;
        for connection in [a, b] {
            command(
                &mut core,
                connection,
                json!({"type":"base_state","roomId":room,"pairId":pair,"ready":true}),
            );
        }
    }
    let picture = Uuid::new_v4();
    command(
        &mut core,
        a,
        json!({"type":"publish","publication":{"id":picture,"roomId":studio,"kind":"screen","muted":false}}),
    );
    let before = state(
        command(
            &mut core,
            b,
            json!({"type":"subscribe","publicationId":picture,"enabled":true}),
        ),
        b,
    );
    assert_eq!(before.pairs.len(), 1);
    assert_eq!(before.pairs[0].incoming.len(), 3);
    assert_eq!(before.pairs[0].outgoing.len(), 2);
    let pair = before.pairs[0].id;

    let browsing = command(
        &mut core,
        b,
        json!({"type":"browse","active":true,"roomId":quiet}),
    );
    assert!(!browsing
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Error { .. })));
    assert!(
        matches!(core.peer_request(b, &quiet, piik_channel_core::conversation::ConversationCommand::History { before: None }).result,
        Ok(piik_channel_core::history::HistoryResult::Page { messages, .. }) if messages.is_empty())
    );
    let after = state(
        command(
            &mut core,
            b,
            json!({"type":"voice","roomId":studio,"joined":false,"muted":true,"deafened":false}),
        ),
        b,
    );
    assert_eq!(after.pairs[0].id, pair);
    assert_eq!(after.pairs[0].incoming.len(), 2);
    assert!(after.pairs[0]
        .incoming
        .iter()
        .any(|flow| flow.publication_id == picture));
    assert!(after.pairs[0]
        .incoming
        .iter()
        .any(|flow| flow.publication_id == voices[0]));
    assert_eq!(
        after.pairs[0]
            .outgoing
            .iter()
            .map(|flow| flow.publication_id)
            .collect::<Vec<_>>(),
        vec![voices[1]]
    );
    assert!(after
        .voice
        .iter()
        .any(|voice| voice.session_id == b_session && voice.room_id == living));
    assert!(!after
        .voice
        .iter()
        .any(|voice| voice.session_id == b_session && voice.room_id == studio));
    assert!(after
        .publications
        .iter()
        .any(|publication| publication.id == voices[2]));
    assert!(!after
        .publications
        .iter()
        .any(|publication| publication.id == voices[3]));

    let picture_stopped = state(
        command(
            &mut core,
            a,
            json!({"type":"unpublish","publicationId":picture}),
        ),
        b,
    );
    assert_eq!(picture_stopped.pairs[0].id, pair);
    assert_eq!(
        picture_stopped.pairs[0]
            .incoming
            .iter()
            .map(|flow| flow.publication_id)
            .collect::<Vec<_>>(),
        vec![voices[0]]
    );
    assert_eq!(
        picture_stopped.pairs[0]
            .outgoing
            .iter()
            .map(|flow| flow.publication_id)
            .collect::<Vec<_>>(),
        vec![voices[1]]
    );
}

#[test]
fn private_invitation_is_complete_admission_and_revoke_removes_only_its_activity() {
    let mut core = core();
    let owner = Uuid::new_v4();
    let creator = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    admit(
        &mut core,
        owner,
        json!({"type":"join","name":"Owner","key":"owner"}),
    );
    let (_, _, creator_state) = admit(
        &mut core,
        creator,
        json!({"type":"join","name":"Creator","key":"invite"}),
    );
    assert!(creator_state
        .channel
        .rooms
        .iter()
        .all(|room| room.access == piik_channel_core::wire::RoomAccess::Public));
    let public_room = room(&mut core, creator, "public", false);
    let room = room(&mut core, creator, "private", true);
    let key = invite(&mut core, creator, &room);
    let (outsider_session, _, initial) = admit(
        &mut core,
        outsider,
        json!({"type":"join","name":"Outsider","key":"invite"}),
    );
    assert!(!initial.channel.rooms.iter().any(|r| r.id == room));
    // Promoting a channel collaborator does not bypass a room creator's privacy.
    let outsider_user = initial
        .sessions
        .iter()
        .find(|session| session.id == outsider_session)
        .unwrap()
        .user_id;
    command(
        &mut core,
        owner,
        json!({"type":"set_roles","userId":outsider_user,"roles":["member","moderator"]}),
    );
    assert!(!core
        .state(outsider)
        .channel
        .rooms
        .iter()
        .any(|entry| entry.id == room));
    rejected(command(
        &mut core,
        outsider,
        json!({"type":"browse","active":true,"roomId":room}),
    ));
    rejected(command(
        &mut core,
        outsider,
        json!({"type":"enter_room","roomId":room,"inviteKey":"wrong"}),
    ));
    let guest = Uuid::new_v4();
    let (guest_session, _, initial) = admit(
        &mut core,
        guest,
        json!({"type":"join","name":"Guest","roomId":room,"key":key}),
    );
    assert!(initial
        .channel
        .rooms
        .iter()
        .any(|r| r.id == room && r.authorized));
    let guest_user = initial
        .sessions
        .iter()
        .find(|entry| entry.id == guest_session)
        .unwrap()
        .user_id;
    let private_pub = Uuid::new_v4();
    let public_pub = Uuid::new_v4();
    command(
        &mut core,
        creator,
        json!({"type":"publish","publication":{"id":private_pub,"roomId":room,"kind":"screen","muted":false}}),
    );
    command(
        &mut core,
        creator,
        json!({"type":"publish","publication":{"id":public_pub,"roomId":public_room,"kind":"screen","muted":false}}),
    );
    command(
        &mut core,
        guest,
        json!({"type":"subscribe","publicationId":public_pub,"enabled":true}),
    );
    let shared = state(
        command(
            &mut core,
            guest,
            json!({"type":"subscribe","publicationId":private_pub,"enabled":true}),
        ),
        guest,
    );
    assert_eq!(shared.pairs.len(), 1);
    assert_eq!(shared.pairs[0].incoming.len(), 2);
    let pair = shared.pairs[0].id;
    rejected(command(
        &mut core,
        outsider,
        json!({"type":"subscribe","publicationId":private_pub,"enabled":true}),
    ));
    let revoked = command(
        &mut core,
        creator,
        json!({"type":"revoke_room_access","roomId":room,"userId":guest_user}),
    );
    let guest_state = state(revoked, guest);
    assert!(!guest_state.channel.rooms.iter().any(|r| r.id == room));
    assert!(!guest_state.publications.iter().any(|p| p.id == private_pub));
    assert_eq!(guest_state.pairs[0].id, pair);
    assert_eq!(
        guest_state.pairs[0]
            .incoming
            .iter()
            .map(|flow| flow.publication_id)
            .collect::<Vec<_>>(),
        vec![public_pub]
    );
    assert_eq!(
        guest_state
            .sessions
            .iter()
            .find(|s| s.id == guest_session)
            .unwrap()
            .user_id,
        guest_user
    );
    assert!(!core
        .state(guest)
        .channel
        .rooms
        .iter()
        .any(|entry| entry.id == room));
    for request in [
        piik_channel_core::conversation::ConversationCommand::History { before: None },
        piik_channel_core::conversation::ConversationCommand::Chat {
            text: "Revoked".into(),
            nonce: "revoked".into(),
            attachments: vec![],
        },
    ] {
        assert_eq!(
            core.peer_request(guest, &room, request).result.err(),
            Some("room_unavailable")
        );
    }
    rejected(command(
        &mut core,
        outsider,
        json!({"type":"room_invite","roomId":room}),
    ));
    // The channel owner can manage the room; the creator's ordinary member role suffices too.
    let updated = command(
        &mut core,
        owner,
        json!({"type":"update_room","icon":"couch","roomId":room,"name":"Renamed","access":"private","hidden":true}),
    );
    assert!(!updated
        .events
        .iter()
        .any(|(_, e)| matches!(e, Event::Error { .. })));
}

#[test]
fn public_to_private_requires_explicit_grant_and_password_rotation_keeps_existing_grants() {
    let mut core = core();
    let creator = Uuid::new_v4();
    let guest = Uuid::new_v4();
    admit(
        &mut core,
        creator,
        json!({"type":"join","name":"Creator","key":"invite"}),
    );
    let (_, credential, _) = admit(
        &mut core,
        guest,
        json!({"type":"join","name":"Guest","key":"invite"}),
    );
    let room = room(&mut core, creator, "public", false);
    let unicode_password = "密".repeat(128);
    command(
        &mut core,
        guest,
        json!({"type":"browse","active":true,"roomId":room}),
    );
    let locked = state(
        command(
            &mut core,
            creator,
            json!({"type":"update_room","icon":"couch","roomId":room,"name":"Private","access":"private","hidden":false,"password":unicode_password}),
        ),
        guest,
    );
    assert!(
        !locked
            .channel
            .rooms
            .iter()
            .find(|r| r.id == room)
            .unwrap()
            .authorized
    );
    assert_eq!(
        core.peer_request(
            guest,
            &room,
            piik_channel_core::conversation::ConversationCommand::Chat {
                text: "blocked".into(),
                nonce: "1".into(),
                attachments: vec![]
            }
        )
        .result
        .err(),
        Some("room_access_required")
    );
    command(
        &mut core,
        guest,
        json!({"type":"enter_room","roomId":room,"password":unicode_password}),
    );
    assert!(core
        .state(guest)
        .channel
        .rooms
        .iter()
        .any(|entry| entry.id == room && entry.authorized));
    let first = invite(&mut core, creator, &room);
    let second = invite(&mut core, creator, &room);
    assert_ne!(first, second);
    let (_, _, reconnected) = admit(
        &mut core,
        Uuid::new_v4(),
        json!({"type":"join","name":"Guest","credential":credential,"roomId":room,"key":first}),
    );
    assert!(reconnected
        .channel
        .rooms
        .iter()
        .any(|candidate| candidate.id == room && candidate.authorized));
    command(
        &mut core,
        creator,
        json!({"type":"update_room","icon":"couch","roomId":room,"name":"Private","access":"private","hidden":false,"password":"second"}),
    );
    assert!(core
        .state(guest)
        .channel
        .rooms
        .iter()
        .any(|entry| entry.id == room && entry.authorized));
    let another = Uuid::new_v4();
    admit(
        &mut core,
        another,
        json!({"type":"join","name":"Another","key":"invite"}),
    );
    rejected(command(
        &mut core,
        another,
        json!({"type":"enter_room","roomId":room,"password":"first"}),
    ));
    rejected(command(
        &mut core,
        another,
        json!({"type":"enter_room","roomId":room,"inviteKey":first}),
    ));
    command(
        &mut core,
        another,
        json!({"type":"enter_room","roomId":room,"inviteKey":second}),
    );
}

#[test]
fn separate_domain_and_room_checkpoints_restore_identity_without_reviving_media() {
    let mut original = core();
    let creator = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let (_, owner_credential, _) = admit(
        &mut original,
        owner,
        json!({"type":"join","name":"Owner","key":"owner"}),
    );
    let (_, credential, _) = admit(
        &mut original,
        creator,
        json!({"type":"join","name":"Creator","key":"invite"}),
    );
    let room = room(&mut original, creator, "private", true);
    let key = invite(&mut original, creator, &room);
    command(
        &mut original,
        creator,
        json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":"screen","muted":false}}),
    );
    let active = state(
        command(
            &mut original,
            creator,
            json!({"type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false}),
        ),
        creator,
    );
    assert_eq!(active.publications.len(), 1);
    assert_eq!(active.voice.len(), 1);
    let policy = original.policy(&room);
    let checkpoint = serde_json::to_string(&original.authority.export_state()).unwrap();
    assert!(!checkpoint.contains(&credential));
    assert!(!checkpoint.contains(&owner_credential));
    assert!(!checkpoint.contains(&key));
    let room_policy = serde_json::to_value(&policy).unwrap();
    assert!(!checkpoint.contains(&serde_json::to_string(&room_policy["inviteHash"]).unwrap()));
    let mut restored = core();
    restored
        .authority
        .import_state(serde_json::from_str(&checkpoint).unwrap())
        .unwrap();
    let new_page = Uuid::new_v4();
    let (_, _, initial) = admit(
        &mut restored,
        new_page,
        json!({"type":"join","name":"Creator","credential":credential}),
    );
    assert_eq!(initial.sessions.len(), 1);
    assert!(initial.publications.is_empty());
    assert!(initial.pairs.is_empty());
    assert!(initial.voice.is_empty());
    assert!(!initial
        .channel
        .rooms
        .iter()
        .any(|candidate| candidate.id == room && candidate.available));
    restored.restore_room(new_page, policy);
    assert!(restored
        .state(new_page)
        .channel
        .rooms
        .iter()
        .any(|candidate| candidate.id == room
            && candidate.authorized
            && candidate.can_manage
            && candidate.available));
    let browsing = command(
        &mut restored,
        new_page,
        json!({"type":"browse","active":true,"roomId":room}),
    );
    assert!(!browsing
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Error { .. })));
    assert!(restored
        .state(new_page)
        .channel
        .rooms
        .iter()
        .any(|entry| entry.id == room && entry.reading));
    let history = restored.peer_request(
        new_page,
        &room,
        piik_channel_core::conversation::ConversationCommand::History { before: None },
    );
    assert!(
        matches!(history.result, Ok(piik_channel_core::history::HistoryResult::Page { messages, .. }) if messages.is_empty())
    );
    let (_, again, _) = admit(
        &mut restored,
        Uuid::new_v4(),
        json!({"type":"join","name":"Owner","key":"owner"}),
    );
    assert_eq!(again, owner_credential);
    assert!(restored.state(new_page).publications.is_empty());
    assert!(restored.state(new_page).voice.is_empty());
}

#[test]
fn late_room_results_follow_the_requesters_current_authority() {
    use piik_channel_core::{host::HostAction, wire::Request};
    let mut network = core();
    let owner = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let unrelated = Uuid::new_v4();
    admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Owner","key":"owner"}),
    );
    let (actor_session, credential, state) = admit(
        &mut network,
        actor,
        json!({"type":"join","name":"Actor","key":"invite"}),
    );
    admit(
        &mut network,
        unrelated,
        json!({"type":"join","name":"Unrelated","key":"invite"}),
    );
    let actor_user = state
        .sessions
        .iter()
        .find(|session| session.id == actor_session)
        .unwrap()
        .user_id;
    let public = room(&mut network, owner, "public", false);
    let private = room(&mut network, owner, "private", true);
    let invitation = invite(&mut network, owner, &private);

    let effects = network.authority.handle(
        actor,
        Request::parse(
            &json!({"type":"browse","roomId":public,"active":true,"requestId":"before-revoke"})
                .to_string(),
        )
        .unwrap(),
        100,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let earlier = network.host_turn(&public, input);
    command(
        &mut network,
        owner,
        json!({"type":"set_roles","userId":actor_user,"roles":[]}),
    );
    let late = command(
        &mut network,
        owner,
        json!({"type":"host_output","roomId":public,"output":earlier}),
    );
    let result = late
        .events
        .iter()
        .find_map(|(recipient, event)| match event {
            Event::RoomReply {
                request_id: Some(id),
                result,
                ..
            } if *recipient == actor && id == "before-revoke" => Some(result),
            _ => None,
        })
        .expect("the original request receives its scoped result");
    assert!(matches!(result, RoomResult::Error { code } if code == "room_context_changed"));

    command(
        &mut network,
        owner,
        json!({"type":"set_roles","userId":actor_user,"roles":["member"]}),
    );
    let returning = Uuid::new_v4();
    let signing_key =
        piik_channel_core::conversation::SessionSigner::from_seed([1; 32]).signing_key();
    let effects = network.authority.handle(
        returning,
        Request::parse(
            &json!({
                "type": "join", "name": "Returning", "credential": credential,
                "key": invitation, "roomId": private, "signingKey": signing_key,
            })
            .to_string(),
        )
        .unwrap(),
        100,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    assert!(matches!(
        input.action,
        HostAction::VerifyInvite {
            member: Some(_),
            ..
        }
    ));
    let verification = network.host_turn(&private, input);
    assert!(verification.invitation.as_ref().unwrap().accepted);
    command(
        &mut network,
        owner,
        json!({"type":"set_roles","userId":actor_user,"roles":[]}),
    );
    let rejected = command(
        &mut network,
        owner,
        json!({"type":"host_output","roomId":private,"output":verification}),
    );
    assert!(rejected.close.contains(&returning));
    assert!(
        !rejected
            .events
            .iter()
            .any(|(recipient, event)| *recipient == returning
                && matches!(event, Event::Welcome { .. })),
        "an existing user's stale invitation cannot bypass changed authority"
    );

    let newcomer = Uuid::new_v4();
    let effects = network.authority.handle(
        newcomer,
        Request::parse(
            &json!({
                "type": "join", "name": "Newcomer", "key": invitation,
                "roomId": private, "signingKey": signing_key,
            })
            .to_string(),
        )
        .unwrap(),
        100,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    assert!(matches!(
        input.action,
        HostAction::VerifyInvite { member: None, .. }
    ));
    let verification = network.host_turn(&private, input);
    assert!(verification.invitation.as_ref().unwrap().accepted);
    command(&mut network, unrelated, json!({"type":"leave"}));
    let admitted = command(
        &mut network,
        owner,
        json!({"type":"host_output","roomId":private,"output":verification}),
    );
    assert!(
        admitted
            .events
            .iter()
            .any(|(recipient, event)| *recipient == newcomer
                && matches!(event, Event::Welcome { .. })),
        "a new invitee has no existing Member dependency on unrelated departures"
    );
}
