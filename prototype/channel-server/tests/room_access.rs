use piik_channel_prototype::{
    wire::{Event, Request, Snapshot},
    Authority, Effects, RoomPermission,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn command(core: &mut Authority, connection: Uuid, value: Value) -> Effects {
    core.handle(connection, Request::parse(&value.to_string()).unwrap(), 100)
}
fn admit(core: &mut Authority, connection: Uuid, value: Value) -> (Uuid, String, Snapshot) {
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
        .find_map(|(c, e)| match e {
            Event::State { state } if c == connection => Some(state),
            _ => None,
        })
        .unwrap()
}
fn room(core: &mut Authority, connection: Uuid, access: &str, hidden: bool) -> String {
    command(core, connection, json!({"type":"create_room","name":"Friends","access":access,"hidden":hidden,"requestId":"create"})).events.into_iter().find_map(|(_,e)|match e {
        Event::RoomCreated {room_id,request_id} => { assert_eq!(request_id.as_deref(),Some("create"));Some(room_id) }, _=>None
    }).unwrap()
}
fn invite(core: &mut Authority, connection: Uuid, room: &str) -> String {
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
    assert!(effects
        .events
        .iter()
        .any(|(_, e)| matches!(e, Event::Error { .. })));
}
fn core() -> Authority {
    Authority::new("owner".into(), "invite".into(), vec![]).unwrap()
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
        .authorize_user(&outsider_credential, "living", RoomPermission::Read)
        .unwrap();
    command(
        &mut core,
        owner,
        json!({"type":"set_roles","userId":outsider_user,"roles":["member","moderator"]}),
    );
    assert!(core
        .authorize_user(&outsider_credential, &room, RoomPermission::Read)
        .is_err());
    assert!(core
        .authorize_user(&outsider_credential, &room, RoomPermission::Manage)
        .is_err());
    rejected(command(
        &mut core,
        outsider,
        json!({"type":"browse","roomId":room}),
    ));
    rejected(command(
        &mut core,
        outsider,
        json!({"type":"enter_room","roomId":room,"inviteKey":"wrong"}),
    ));
    let guest = Uuid::new_v4();
    let (guest_session, credential, initial) = admit(
        &mut core,
        guest,
        json!({"type":"join","name":"Guest","roomId":room,"key":key}),
    );
    assert!(initial
        .channel
        .rooms
        .iter()
        .any(|r| r.id == room && r.authorized));
    let guest_user = core
        .authorize_user(&credential, &room, RoomPermission::Read)
        .unwrap();
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
    assert!(core
        .authorize_user(&credential, &room, RoomPermission::Read)
        .is_err());
    assert!(core
        .authorize_user(&outsider_credential, &room, RoomPermission::Manage)
        .is_err());
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
    command(&mut core, guest, json!({"type":"browse","roomId":room}));
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
        .authorize_user(&credential, &room, RoomPermission::Read)
        .is_ok());
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
        .authorize_user(&credential, &room, RoomPermission::Read)
        .is_ok());
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
fn checkpoint_restores_access_history_and_credentials_but_no_live_media_or_sessions() {
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
    let attachment = Uuid::new_v4();
    for i in 0..105 {
        command(
            &mut original,
            creator,
            json!({"type":"chat","roomId":room,"text":format!("Message {i}"),"nonce":format!("n{i}"),"attachments":[attachment]}),
        );
    }
    let checkpoint = serde_json::to_string(&original.export_state()).unwrap();
    assert!(!checkpoint.contains(&credential));
    assert!(!checkpoint.contains(&owner_credential));
    assert!(!checkpoint.contains(&key));
    let mut restored = core();
    restored
        .import_state(serde_json::from_str(&checkpoint).unwrap())
        .unwrap();
    assert!(restored.referenced_attachments().contains(&attachment));
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
    let history = command(
        &mut restored,
        new_page,
        json!({"type":"browse","roomId":room}),
    );
    let before = history
        .events
        .into_iter()
        .find_map(|(_, e)| match e {
            Event::History {
                messages,
                has_more,
                before,
                ..
            } => {
                assert_eq!(messages.len(), 100);
                assert!(has_more);
                assert!(before.is_none());
                messages.first().map(|message| message.seq)
            }
            _ => None,
        })
        .unwrap();
    let older = command(
        &mut restored,
        new_page,
        json!({"type":"history","roomId":room,"before":before}),
    );
    assert!(older
        .events
        .iter()
        .any(|(_, e)| matches!(e,Event::History{messages,has_more:false,..} if messages.len()==5)));
    let (_, again, _) = admit(
        &mut restored,
        Uuid::new_v4(),
        json!({"type":"join","name":"Owner","key":"owner"}),
    );
    assert_eq!(again, owner_credential);
    assert!(restored
        .authorize_user(&owner_credential, &room, RoomPermission::Manage)
        .is_ok());
}
