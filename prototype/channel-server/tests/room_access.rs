#![cfg(feature = "server")]

use piik_channel_prototype::{
    history::HistoryRequest,
    host::RoomResult,
    wire::{Event, Snapshot},
    Effects, RoomPermission,
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
    assert!(effects.history.is_none());
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
    let mut voices = Vec::new();
    for room in ["living", "studio"] {
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
    let picture = Uuid::new_v4();
    command(
        &mut core,
        a,
        json!({"type":"publish","publication":{"id":picture,"roomId":"studio","kind":"screen","muted":false}}),
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
        json!({"type":"browse","active":true,"roomId":"quiet"}),
    );
    assert!(
        matches!(browsing.history.unwrap().request, HistoryRequest::Read { room_id, .. } if room_id == "quiet")
    );
    let after = state(
        command(
            &mut core,
            b,
            json!({"type":"voice","roomId":"studio","joined":false,"muted":true,"deafened":false}),
        ),
        b,
    );
    assert_eq!(after.pairs[0].id, pair);
    assert_eq!(after.pairs[0].incoming.len(), 2);
    assert!(after.pairs[0].incoming.contains(&picture));
    assert!(after.pairs[0].incoming.contains(&voices[0]));
    assert_eq!(after.pairs[0].outgoing, vec![voices[1]]);
    assert!(after
        .voice
        .iter()
        .any(|voice| voice.session_id == b_session && voice.room_id == "living"));
    assert!(!after
        .voice
        .iter()
        .any(|voice| voice.session_id == b_session && voice.room_id == "studio"));
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
    assert_eq!(picture_stopped.pairs[0].incoming, vec![voices[0]]);
    assert_eq!(picture_stopped.pairs[0].outgoing, vec![voices[1]]);
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
        .all(|room| room.access == piik_channel_prototype::wire::RoomAccess::Public));
    let room = room(&mut core, creator, "private", true);
    let key = invite(&mut core, creator, &room);
    let (_, outsider_credential, initial) = admit(
        &mut core,
        outsider,
        json!({"type":"join","name":"Outsider","key":"invite"}),
    );
    assert!(!initial.channel.rooms.iter().any(|r| r.id == room));
    // Promoting a channel collaborator does not bypass a room creator's privacy.
    let outsider_user = core
        .authority
        .authorize_user(&outsider_credential, "living", RoomPermission::Read)
        .unwrap();
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
        json!({"type":"publish","publication":{"id":public_pub,"roomId":"living","kind":"screen","muted":false}}),
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
    assert_eq!(guest_state.pairs[0].incoming, vec![public_pub]);
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
    for value in [
        json!({"type":"history","roomId":room}),
        json!({"type":"chat","roomId":room,"text":"Revoked","nonce":"revoked"}),
    ] {
        rejected(command(&mut core, guest, value));
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
        json!({"type":"update_room","roomId":room,"name":"Renamed","access":"private","hidden":true}),
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
            json!({"type":"update_room","roomId":room,"name":"Private","access":"private","hidden":false,"password":unicode_password}),
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
    rejected(command(
        &mut core,
        guest,
        json!({"type":"chat","roomId":room,"text":"blocked","nonce":"1"}),
    ));
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
        json!({"type":"update_room","roomId":room,"name":"Private","access":"private","hidden":false,"password":"second"}),
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
    let history = command(
        &mut restored,
        new_page,
        json!({"type":"browse","active":true,"roomId":room}),
    );
    assert!(
        history.history.is_none(),
        "domain storage must not receive Browser room history"
    );
    assert!(history.events.iter().any(|(_, event)| matches!(event,
        Event::History { room_id, messages, .. } if room_id == &room && messages.is_empty())));
    let (_, again, _) = admit(
        &mut restored,
        Uuid::new_v4(),
        json!({"type":"join","name":"Owner","key":"owner"}),
    );
    assert_eq!(again, owner_credential);
    assert!(restored.state(new_page).publications.is_empty());
    assert!(restored.state(new_page).voice.is_empty());
}
