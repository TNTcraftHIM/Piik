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

#[test]
fn deletion_withdraws_directory_authority_across_restart_without_recreating_the_room() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let creator = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Domain owner","ownerKey":"owner"}),
    );
    let (_, credential, _) = admit(
        &mut network,
        creator,
        json!({"type":"join","name":"Creator"}),
    );
    admit(
        &mut network,
        stranger,
        json!({"type":"join","name":"Stranger"}),
    );
    let deleted = room(&mut network, creator, "private", true);
    let sibling = room(&mut network, owner, "public", false);
    let policy = network.policy(&deleted);
    let summary = piik_channel_core::host::RoomSummary::from_policy(&policy);
    let forbidden = command(
        &mut network,
        stranger,
        json!({"type":"delete_room","deleteData":true,"roomId":deleted,"requestId":"deny"}),
    );
    assert!(forbidden
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "forbidden")));
    let requester = Uuid::new_v4();
    admit(
        &mut network,
        requester,
        json!({"type":"join","name":"Other creator page","credential":credential}),
    );
    let pending = network.authority.handle(
        requester,
        piik_channel_core::wire::Request::parse(
            &json!({"type":"delete_room","deleteData":true,"roomId":deleted,"requestId":"delete"})
                .to_string(),
        )
        .unwrap(),
        100,
    );
    let input = pending
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let output = network.host_turn(&deleted, input);
    network.authority.disconnect(requester, 100);
    let removed = command(
        &mut network,
        creator,
        json!({"type":"host_output","roomId":deleted,"output":output}),
    );
    assert!(
        !removed
            .events
            .iter()
            .any(|(target, event)| *target == requester && matches!(event, Event::RoomReply { .. })),
        "a closed requester receives no completion"
    );
    assert!(!network
        .state(creator)
        .channel
        .rooms
        .iter()
        .any(|room| room.id == deleted));
    assert!(network
        .state(creator)
        .channel
        .rooms
        .iter()
        .any(|room| room.id == sibling));

    let checkpoint = network.authority.export_state();
    let mut reopened = RoomNetwork::new();
    reopened.authority.import_state(checkpoint).unwrap();
    let returning = Uuid::new_v4();
    admit(
        &mut reopened,
        returning,
        json!({"type":"join","name":"Creator","credential":credential}),
    );
    for value in [json!({"type":"host_register","room":summary})] {
        let result = command(&mut reopened, returning, value);
        assert!(result
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::Error { .. })));
    }
    let created = command(
        &mut reopened,
        returning,
        json!({"type":"create_room","room":summary}),
    );
    assert!(created.events.iter().any(|(_, event)| matches!(event, Event::RoomCreated { room, .. } if room.id != deleted && room.creator_id == policy.creator_id)));
    let administrator = Uuid::new_v4();
    admit(
        &mut reopened,
        administrator,
        json!({"type":"join","name":"Domain owner","ownerKey":"owner"}),
    );
    rejected(command(
        &mut reopened,
        administrator,
        json!({"type":"admit_room","room":summary}),
    ));
    let admitted = command(
        &mut reopened,
        returning,
        json!({"type":"admit_room","room":summary,"requestId":"restore"}),
    );
    assert!(admitted
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Ack { request_id } if request_id == "restore")));
    reopened.restore_room(returning, policy);
}

#[test]
fn channel_owner_removal_retires_an_offline_rooms_invite_and_creator_restore() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let creator = Uuid::new_v4();
    let reader = Uuid::new_v4();
    admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    let (_, creator_credential, _) = admit(
        &mut network,
        creator,
        json!({"type":"join","name":"Creator"}),
    );
    let (_, reader_credential, _) =
        admit(&mut network, reader, json!({"type":"join","name":"Reader"}));
    let id = room(&mut network, creator, "private", true);
    let key = invite(&mut network, creator, &id);
    let entry = json!({"type":"enter_room","roomId":id,"inviteKey":key});
    command(&mut network, reader, entry.clone());
    assert!(network
        .state(reader)
        .channel
        .rooms
        .iter()
        .any(|room| room.id == id && room.authorized));
    let summary = piik_channel_core::host::RoomSummary::from_policy(&network.policy(&id));

    let disconnected = network.authority.disconnect(creator, 200);
    network.deliver(disconnected);
    let removal = command(
        &mut network,
        owner,
        json!({"type":"delete_room","roomId":id,"deleteData":true}),
    );
    assert!(removal.events.iter().any(|(_, event)| matches!(
        event,
        Event::RoomReply {
            result: RoomResult::Deleted {
                data_removed: false
            },
            ..
        }
    )));
    assert!(network
        .state(reader)
        .channel
        .rooms
        .iter()
        .all(|room| room.id != id));

    let saved = serde_json::to_vec(&network.authority.export_backup()).unwrap();
    let checkpoint: piik_channel_core::backup::DomainMetadata =
        serde_json::from_slice(&saved).unwrap();
    let mut reopened = RoomNetwork::new();
    reopened.authority = checkpoint.into_authority(vec![]).unwrap();
    let returning_reader = Uuid::new_v4();
    let (_, _, state) = admit(
        &mut reopened,
        returning_reader,
        json!({
            "type":"join","name":"Reader","credential":reader_credential
        }),
    );
    assert!(state.channel.rooms.iter().all(|room| room.id != id));
    let returning_creator = Uuid::new_v4();
    admit(
        &mut reopened,
        returning_creator,
        json!({
            "type":"join","name":"Creator","credential":creator_credential
        }),
    );
    for request in [
        json!({"type":"host_register","room":summary}),
        json!({"type":"admit_room","room":summary,"requestId":"restore"}),
    ] {
        let denied = command(&mut reopened, returning_creator, request);
        assert!(denied.events.iter().any(|(_, event)| matches!(event,
            Event::Error { code, .. } if code == "room_not_in_domain"
        )));
        assert!(!denied
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::HostInput { .. })));
    }
    let denied = command(&mut reopened, returning_reader, entry);
    assert!(denied.events.iter().any(|(_, event)| matches!(event,
        Event::Error { code, .. } if code == "room_unavailable"
    )));
    assert!(reopened
        .state(returning_reader)
        .channel
        .rooms
        .iter()
        .all(|room| room.id != id));
}

#[test]
fn offline_removal_and_correlated_online_deletion_keep_room_scopes_separate() {
    use piik_channel_core::wire::Request;
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    let first = room(&mut network, owner, "public", false);
    let second = room(&mut network, owner, "public", false);
    let directory_only = room(&mut network, owner, "public", false);
    let removal = network.authority.handle(owner, Request::parse(&json!({"type":"delete_room","deleteData":false,"roomId":directory_only,"requestId":"no-data-consent"}).to_string()).unwrap(), 100);
    assert!(
        !removal
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::HostInput { .. })),
        "an online host must never receive a storage deletion without consent"
    );
    let removal = network.deliver(removal);
    assert!(removal.events.iter().any(|(_, event)| matches!(
        event,
        Event::RoomReply {
            result: RoomResult::Deleted {
                data_removed: false
            },
            ..
        }
    )));
    let binding = network
        .state(owner)
        .channel
        .rooms
        .iter()
        .find(|room| room.id == second)
        .unwrap()
        .delivery
        .as_ref()
        .unwrap()
        .binding_id;
    let effects = network.authority.handle(
        owner,
        Request::parse(
            &json!({"type":"delete_room","deleteData":true,"roomId":first,"requestId":"scoped"})
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
    let output = network.host_turn(&first, input);
    let wrong = command(
        &mut network,
        owner,
        json!({"type":"host_output","roomId":second,"output":output}),
    );
    assert!(wrong
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Error { .. })));
    let valid = command(
        &mut network,
        owner,
        json!({"type":"host_output","roomId":first,"output":output}),
    );
    assert!(valid.events.iter().any(|(_, event)| matches!(
        event,
        Event::RoomReply {
            result: RoomResult::Deleted { data_removed: true },
            ..
        }
    )));
    command(
        &mut network,
        owner,
        json!({"type":"host_stop","roomId":second,"bindingId":binding}),
    );
    let removed = command(
        &mut network,
        owner,
        json!({"type":"delete_room","deleteData":true,"roomId":second,"requestId":"offline"}),
    );
    assert!(removed.events.iter().any(|(_, event)| matches!(
        event,
        Event::RoomReply {
            result: RoomResult::Deleted {
                data_removed: false
            },
            ..
        }
    )));
    assert!(network.state(owner).channel.rooms.is_empty());
}

#[test]
fn public_discovery_ends_with_host_presence_while_known_sessions_keep_scoped_status() {
    let mut network = RoomNetwork::new();
    let creator = Uuid::new_v4();
    let visitor = Uuid::new_v4();
    let reader = Uuid::new_v4();
    for connection in [creator, visitor, reader] {
        admit(
            &mut network,
            connection,
            json!({"type":"join","name":"Member"}),
        );
    }
    let id = room(&mut network, creator, "public", false);
    assert!(network
        .state(visitor)
        .channel
        .rooms
        .iter()
        .any(|room| room.id == id && room.available));
    command(
        &mut network,
        reader,
        json!({"type":"browse","roomId":id,"active":true}),
    );
    let effects = network.authority.disconnect(creator, 200);
    network.deliver(effects);
    assert!(network.state(visitor).channel.rooms.is_empty());
    let offline = &network.state(reader).channel.rooms[0];
    assert_eq!(offline.id, id);
    assert!(!offline.available && offline.delivery.is_some() && offline.members.is_none());
    let direct = command(
        &mut network,
        visitor,
        json!({"type":"enter_room","roomId":id}),
    );
    assert!(direct.events.iter().any(
        |(_, event)| matches!(event, Event::Error { code, .. } if code == "room_host_offline")
    ));
    let late = Uuid::new_v4();
    let (_, _, state) = admit(&mut network, late, json!({"type":"join","name":"Later"}));
    assert!(state.channel.rooms.is_empty());
    let expired = network
        .authority
        .expire(200 + piik_channel_core::RECOVERY_MS);
    network.deliver(expired);
    assert!(network.state(reader).channel.rooms[0].delivery.is_none());
}

#[test]
fn room_picture_only_reaches_an_admitted_reader_while_the_room_is_online() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let writer = Uuid::new_v4();
    let reader = Uuid::new_v4();
    admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Site owner","ownerKey":"owner"}),
    );
    let (_, writer_key, _) = admit(&mut network, writer, json!({"type":"join","name":"Writer"}));
    let (reader_session, _, reader_state) =
        admit(&mut network, reader, json!({"type":"join","name":"Reader"}));
    let reader_user = reader_state
        .sessions
        .iter()
        .find(|s| s.id == reader_session)
        .unwrap()
        .user_id;
    let id = room(&mut network, writer, "public", false);
    let picture = "data:image/png;base64,iVBORw0KGgo=";
    let edit = |access| json!({"type":"update_room","roomId":id,"name":"Studio","icon":"star","picture":picture,"access":access,"hidden":false});
    let row = |net: &RoomNetwork, connection| {
        let room = net
            .state(connection)
            .channel
            .rooms
            .iter()
            .find(|r| r.id == id)
            .unwrap();
        serde_json::to_value(room).unwrap()
    };
    let browse = |active| json!({"type":"browse","roomId":id,"active":active});
    command(&mut network, writer, edit("public"));
    for visitor in [owner, reader] {
        assert_eq!(row(&network, visitor)["icon"], "star");
        assert!(row(&network, visitor).get("picture").is_none());
    }
    command(&mut network, reader, browse(true));
    assert_eq!(row(&network, reader)["picture"], picture);
    command(&mut network, reader, browse(false));
    assert!(row(&network, reader).get("picture").is_none());

    command(&mut network, writer, edit("private"));
    let key = invite(&mut network, writer, &id);
    let enter = json!({"type":"enter_room","roomId":id,"inviteKey":key});
    command(&mut network, reader, enter.clone());
    assert!(row(&network, reader).get("picture").is_none());
    command(&mut network, reader, browse(true));
    assert_eq!(row(&network, reader)["picture"], picture);
    command(
        &mut network,
        writer,
        json!({"type":"revoke_room_access","roomId":id,"userId":reader_user}),
    );
    assert!(row(&network, reader).get("picture").is_none());
    assert!(row(&network, owner).get("picture").is_none());
    command(&mut network, reader, enter);
    command(&mut network, reader, browse(true));
    assert_eq!(row(&network, reader)["picture"], picture);
    let effects = network.authority.disconnect(writer, 200);
    network.deliver(effects);
    assert_eq!(row(&network, reader)["available"], false);
    assert!(row(&network, reader).get("picture").is_none());

    let metadata = network.authority.export_backup();
    let archive = serde_json::to_value(metadata.archive_metadata().unwrap()).unwrap();
    let summary = &archive["state"]["hostedRooms"][&id];
    assert_eq!(summary["icon"], "star");
    assert!(summary.get("picture").is_none());
    let mut reopened = RoomNetwork::new();
    reopened.authority = metadata.into_authority(vec![]).unwrap();
    admit(
        &mut reopened,
        writer,
        json!({"type":"join","name":"Writer","credential":writer_key}),
    );
    let offline = row(&reopened, writer);
    assert_eq!(offline["icon"], "star");
    assert_eq!(offline["available"], false);
    assert!(offline.get("picture").is_none());
    assert!(!serde_json::to_string(&reopened.authority.export_backup())
        .unwrap()
        .contains(picture));
}

#[test]
fn abandoned_reservations_and_stopped_guest_rooms_release_active_slots() {
    let mut network = RoomNetwork::new();
    let creator = Uuid::new_v4();
    let visitor = Uuid::new_v4();
    for connection in [creator, visitor] {
        admit(
            &mut network,
            connection,
            json!({"type":"join","name":"Guest"}),
        );
    }
    let live = room(&mut network, creator, "public", false);
    let summary = piik_channel_core::host::RoomSummary::from_policy(&network.policy(&live));
    let reserve = json!({"type":"create_room","room":summary,"requestId":"reserve"});
    for _ in 1..32 {
        assert!(command(&mut network, creator, reserve.clone())
            .events
            .iter()
            .any(|(_, e)| matches!(e, Event::RoomCreated { .. })));
    }
    assert_eq!(network.state(visitor).channel.rooms.len(), 1);
    assert_eq!(
        serde_json::to_value(network.authority.export_state()).unwrap()["hostedRooms"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
    assert!(command(&mut network, visitor, reserve.clone())
        .events
        .iter()
        .any(|(_, e)| matches!(e, Event::Error { code, .. } if code == "room_limit")));
    let binding = network
        .state(creator)
        .channel
        .rooms
        .iter()
        .find(|r| r.id == live)
        .unwrap()
        .delivery
        .as_ref()
        .unwrap()
        .binding_id;
    command(
        &mut network,
        creator,
        json!({"type":"host_stop","roomId":live,"bindingId":binding}),
    );
    assert!(command(&mut network, visitor, reserve.clone())
        .events
        .iter()
        .any(|(_, e)| matches!(e, Event::RoomCreated { .. })));
    command(&mut network, creator, json!({"type":"leave"}));
    for _ in 1..32 {
        assert!(command(&mut network, visitor, reserve.clone())
            .events
            .iter()
            .any(|(_, e)| matches!(e, Event::RoomCreated { .. })));
    }
}

fn command(core: &mut RoomNetwork, connection: Uuid, value: Value) -> Effects {
    core.command(connection, value)
}
fn connect_pair(core: &mut RoomNetwork, endpoints: [Uuid; 2], pair_id: Uuid) {
    for connection in endpoints {
        let effects = command(
            core,
            connection,
            json!({"type":"link_state","pairId":pair_id,"state":"connected"}),
        );
        assert!(!effects
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::Error { .. })));
    }
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
fn room_invitation_reads_are_manager_only_and_never_rotate_the_current_link() {
    use piik_channel_core::wire::RoomInvitation;
    let mut network = core();
    let owner = Uuid::new_v4();
    let creator = Uuid::new_v4();
    let reader = Uuid::new_v4();
    for (connection, key) in [(owner, "owner"), (creator, "invite"), (reader, "invite")] {
        admit(
            &mut network,
            connection,
            json!({"type":"join","name":"User","ownerKey":(key=="owner").then_some(key)}),
        );
    }
    let room = room(&mut network, creator, "private", false);
    let read = |network: &mut RoomNetwork, connection| {
        command(
            network,
            connection,
            json!({"type":"get_room_invite","roomId":room,"requestId":"read-invite"}),
        )
        .events
        .into_iter()
        .find_map(|(recipient, event)| match event {
            Event::RoomInviteState {
                room_id,
                invitation,
                request_id,
            } => {
                assert_eq!(recipient, connection);
                assert_eq!(room_id, room);
                assert_eq!(request_id.as_deref(), Some("read-invite"));
                Some(invitation)
            }
            _ => None,
        })
        .unwrap()
    };
    assert_eq!(read(&mut network, creator), RoomInvitation::Missing);
    rejected(command(
        &mut network,
        owner,
        json!({"type":"get_room_invite","roomId":room}),
    ));
    let key = invite(&mut network, creator, &room);
    let saved = serde_json::to_value(network.policy(&room)).unwrap();
    for manager in [creator, creator] {
        assert_eq!(
            read(&mut network, manager),
            RoomInvitation::Available { key: key.clone() }
        );
        assert_eq!(serde_json::to_value(network.policy(&room)).unwrap(), saved);
    }
    command(
        &mut network,
        reader,
        json!({"type":"enter_room","roomId":room,"inviteKey":key}),
    );
    let denied = command(
        &mut network,
        reader,
        json!({"type":"get_room_invite","roomId":room}),
    );
    assert!(!denied
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::RoomInviteState { .. })));
    rejected(denied);
    for connection in [owner, creator, reader] {
        let snapshot = serde_json::to_string(network.state(connection)).unwrap();
        assert!(!snapshot.contains(&key));
    }
    let replacement = invite(&mut network, creator, &room);
    assert_ne!(key, replacement);
    assert_eq!(
        read(&mut network, creator),
        RoomInvitation::Available {
            key: replacement.clone(),
        }
    );
    assert!(network
        .state(reader)
        .channel
        .rooms
        .iter()
        .any(|value| value.id == room && value.authorized));
    command(
        &mut network,
        creator,
        json!({"type":"update_room","roomId":room,"name":"Public","icon":"couch","access":"public","hidden":false}),
    );
    assert_eq!(
        read(&mut network, creator),
        RoomInvitation::Available { key: replacement }
    );
    let public_key = invite(&mut network, creator, &room);
    assert_eq!(
        read(&mut network, creator),
        RoomInvitation::Available { key: public_key }
    );
    network.policy(&room).validate().unwrap();
}

#[test]
fn open_site_visitors_enter_public_rooms_without_future_private_grants() {
    let mut network = core();
    let creator = Uuid::new_v4();
    admit(
        &mut network,
        creator,
        json!({"type":"join","name":"Creator"}),
    );
    let public = room(&mut network, creator, "public", false);
    let private = room(&mut network, creator, "private", true);
    let key = invite(&mut network, creator, &private);
    let guest = Uuid::new_v4();
    let (session, _, initial) = admit(&mut network, guest, json!({"type":"join","name":"Guest"}));
    let user = initial
        .sessions
        .iter()
        .find(|s| s.id == session)
        .unwrap()
        .user_id;
    assert!(initial
        .channel
        .rooms
        .iter()
        .any(|r| r.id == public && r.authorized));
    assert!(!initial.channel.rooms.iter().any(|r| r.id == private));
    assert!(!network.policy(&public).grants.contains(&user));
    command(
        &mut network,
        guest,
        json!({"type":"enter_room","roomId":private,"inviteKey":key}),
    );
    assert!(network.policy(&private).grants.contains(&user));
    command(
        &mut network,
        creator,
        json!({"type":"update_room","roomId":private,"name":"Public now","icon":"couch","access":"public","hidden":false}),
    );
    assert!(network.policy(&private).accepts_invite(&key));
    command(
        &mut network,
        creator,
        json!({"type":"update_room","roomId":private,"name":"Private again","icon":"couch","access":"private","hidden":true}),
    );
    let another = Uuid::new_v4();
    admit(
        &mut network,
        another,
        json!({"type":"join","name":"Another"}),
    );
    command(
        &mut network,
        another,
        json!({"type":"enter_room","roomId":private,"inviteKey":key}),
    );
    assert!(network
        .state(another)
        .channel
        .rooms
        .iter()
        .any(|r| r.id == private && r.authorized));
    let replacement = invite(&mut network, creator, &private);
    assert!(!network.policy(&private).accepts_invite(&key));
    assert!(network.policy(&private).accepts_invite(&replacement));
    assert!(network.policy(&private).grants.contains(&user));
}

#[test]
fn topology_read_uses_current_room_admission_and_binding_without_host_turns() {
    let mut core = core();
    let owner = Uuid::new_v4();
    let reader = Uuid::new_v4();
    admit(
        &mut core,
        owner,
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    let (reader_session, _, _) = admit(&mut core, reader, json!({"type":"join","name":"Reader"}));
    let reader_user = core
        .state(reader)
        .sessions
        .iter()
        .find(|session| session.id == reader_session)
        .unwrap()
        .user_id;
    let private = room(&mut core, owner, "private", false);
    let query = |room: &str, publication: Option<Uuid>| {
        json!({"type":"room_topology", "roomId":room,
        "publicationId":publication,"requestId":"inspect"})
    };
    rejected(command(&mut core, reader, query(&private, None)));
    let key = invite(&mut core, owner, &private);
    command(
        &mut core,
        reader,
        json!({"type":"enter_room","roomId":private,"inviteKey":key}),
    );
    let before = serde_json::to_value(core.authority.export_backup()).unwrap();
    let effects = command(&mut core, reader, query(&private, None));
    assert_eq!(effects.events.len(), 1);
    assert_eq!(
        serde_json::to_value(core.authority.export_backup()).unwrap(),
        before
    );
    let old_binding = match &effects.events[0] {
        (
            connection,
            Event::RoomReply {
                result: RoomResult::Topology { topology },
                ..
            },
        ) if *connection == reader => topology.binding_id,
        _ => panic!("admitted reader receives its scoped reply"),
    };
    let other = room(&mut core, owner, "public", false);
    let outside = Uuid::new_v4();
    let voice = Uuid::new_v4();
    for (id, room, kind) in [(outside, &other, "screen"), (voice, &private, "voice")] {
        command(
            &mut core,
            owner,
            json!({"type":"publish","publication":{"id":id,"roomId":room,"kind":kind,"source":if kind == "screen" { Some(json!({"kind":"screen","name":null})) } else { None },"videoSettings":if kind == "screen" { Some(json!({"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"})) } else { None }}}),
        );
    }
    rejected(command(&mut core, reader, query(&private, Some(outside))));
    rejected(command(&mut core, reader, query(&private, Some(voice))));
    rejected(command(&mut core, reader, query("not-a-room", None)));
    command(
        &mut core,
        owner,
        json!({"type":"revoke_room_access","roomId":private,"userId":reader_user}),
    );
    rejected(command(&mut core, reader, query(&private, None)));
    let summary = core
        .state(owner)
        .channel
        .rooms
        .iter()
        .find(|room| room.id == private)
        .unwrap()
        .clone();
    command(
        &mut core,
        owner,
        json!({"type":"host_stop","roomId":private,"bindingId":old_binding}),
    );
    rejected(command(&mut core, owner, query(&private, None)));
    command(
        &mut core,
        owner,
        json!({"type":"host_register","room":summary}),
    );
    let effects = command(&mut core, owner, query(&private, None));
    assert!(effects.events.iter().any(|(_, event)| matches!(event,
        Event::RoomReply { result: RoomResult::Topology { topology }, .. } if topology.binding_id != old_binding)));
    rejected(command(&mut core, reader, query(&private, None)));
}

#[test]
fn hosted_room_catalogs_keep_the_per_room_source_limit_without_a_domain_total() {
    let mut core = core();
    let peers: Vec<_> = (0..20).map(|index| {
        let connection = Uuid::new_v4();
        admit(&mut core, connection, json!({"type":"join","name":"Participant","ownerKey":(index==0).then_some("owner")}));
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
                    json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":kind,"source":if kind == "screen" { Some(json!({"kind":"screen","name":null})) } else { None },"videoSettings":if kind == "screen" { Some(json!({"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"})) } else { None }}}),
                );
            }
        }
        let duplicate = command(
            &mut core,
            peers[0],
            json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":"screen","source":{"kind":"screen","name":null},"videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}}),
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
        json!({"type":"join","name":"A","ownerKey":"owner"}),
    );
    let (b_session, _, _) = admit(&mut core, b, json!({"type":"join","name":"B"}));
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
                json!({"type":"publish","publication":{"id":id,"roomId":room,"kind":"voice"}}),
            );
        }
    }
    let shared_pair = core.state(b).pairs[0].id;
    assert!(core.state(b).pairs[0].incoming.is_empty());
    connect_pair(&mut core, [a, b], shared_pair);
    let picture = Uuid::new_v4();
    command(
        &mut core,
        a,
        json!({"type":"publish","publication":{"id":picture,"roomId":studio,"kind":"screen","source":{"kind":"screen","name":null},"videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}}),
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
        Ok(piik_channel_core::conversation::ConversationResult::History(piik_channel_core::history::HistoryResult::Page { messages, .. })) if messages.is_empty())
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
fn private_room_entry_and_revoke_preserve_site_identity_and_other_activity() {
    let mut core = core();
    let owner = Uuid::new_v4();
    let creator = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    admit(
        &mut core,
        owner,
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    let (creator_session, _, creator_state) =
        admit(&mut core, creator, json!({"type":"join","name":"Creator"}));
    assert!(creator_state
        .channel
        .rooms
        .iter()
        .all(|room| room.access == piik_channel_core::wire::RoomAccess::Public));
    let public_room = room(&mut core, creator, "public", false);
    let room = room(&mut core, creator, "private", true);
    let key = invite(&mut core, creator, &room);
    let (_, _, initial) = admit(
        &mut core,
        outsider,
        json!({"type":"join","name":"Outsider"}),
    );
    assert!(!initial.channel.rooms.iter().any(|r| r.id == room));
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
    let (guest_session, _, _) = admit(&mut core, guest, json!({"type":"join","name":"Guest"}));
    command(
        &mut core,
        guest,
        json!({"type":"enter_room","roomId":room,"inviteKey":key}),
    );
    let initial = core.state(guest).clone();
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
        json!({"type":"publish","publication":{"id":private_pub,"roomId":room,"kind":"screen","source":{"kind":"screen","name":null},"videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}}),
    );
    command(
        &mut core,
        creator,
        json!({"type":"publish","publication":{"id":public_pub,"roomId":public_room,"kind":"screen","source":{"kind":"screen","name":null},"videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}}),
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
    let requested = shared
        .pairs
        .iter()
        .find(|p| p.peer_id == creator_session)
        .unwrap();
    assert!(requested.incoming.is_empty());
    let pair = requested.id;
    connect_pair(&mut core, [creator, guest], pair);
    let shared = core.state(guest);
    assert_eq!(
        shared
            .pairs
            .iter()
            .find(|p| p.id == pair)
            .unwrap()
            .incoming
            .len(),
        2
    );
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
    let retained = guest_state.pairs.iter().find(|p| p.id == pair).unwrap();
    assert_eq!(
        retained
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
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
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
    // Site maintenance does not grant access to another user's private room.
    let updated = command(
        &mut core,
        owner,
        json!({"type":"update_room","icon":"couch","roomId":room,"name":"Renamed","access":"private","hidden":true}),
    );
    rejected(updated);
    assert!(!core.state(owner).channel.rooms.iter().any(|r| r.id == room));
}

#[test]
fn public_to_private_requires_explicit_grant_and_password_rotation_keeps_existing_grants() {
    let mut core = core();
    let creator = Uuid::new_v4();
    let guest = Uuid::new_v4();
    admit(&mut core, creator, json!({"type":"join","name":"Creator"}));
    let (_, credential, _) = admit(&mut core, guest, json!({"type":"join","name":"Guest"}));
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
                mentions: vec![],
                reply: None,
                inline_images: Default::default(),
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
    let returning = Uuid::new_v4();
    admit(
        &mut core,
        returning,
        json!({"type":"join","name":"Guest","credential":credential}),
    );
    let reconnected = core.state(returning);
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
    admit(&mut core, another, json!({"type":"join","name":"Another"}));
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
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    let (_, credential, _) = admit(
        &mut original,
        creator,
        json!({"type":"join","name":"Creator"}),
    );
    let room = room(&mut original, creator, "private", true);
    let key = invite(&mut original, creator, &room);
    command(
        &mut original,
        creator,
        json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":"screen","source":{"kind":"screen","name":null},"videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}}),
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
    let mut legacy = serde_json::to_value(original.authority.export_backup()).unwrap();
    for user in legacy["state"]["users"].as_array_mut().unwrap().iter_mut() {
        user["roles"] = if user["id"] == json!(policy.creator_id) {
            json!([])
        } else {
            json!(["member", "moderator"])
        };
    }
    let checkpoint = serde_json::to_string(&legacy).unwrap();
    assert!(!checkpoint.contains(&credential));
    assert!(!checkpoint.contains(&owner_credential));
    assert!(!checkpoint.contains(&key));
    let room_policy = serde_json::to_value(&policy).unwrap();
    assert!(!checkpoint.contains(&serde_json::to_string(&room_policy["inviteHash"]).unwrap()));
    let mut restored = core();
    let backup: piik_channel_core::backup::DomainMetadata =
        serde_json::from_str(&checkpoint).unwrap();
    restored.authority = backup.into_authority(vec![]).unwrap();
    assert!(
        serde_json::to_value(restored.authority.export_backup()).unwrap()["state"]["users"]
            .as_array()
            .unwrap()
            .iter()
            .all(|user| user.get("roles").is_none())
    );
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
    assert!(initial
        .channel
        .rooms
        .iter()
        .all(|room| room.participant_session_ids.is_empty()));
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
        matches!(history.result, Ok(piik_channel_core::conversation::ConversationResult::History(piik_channel_core::history::HistoryResult::Page { messages, .. })) if messages.is_empty())
    );
    let sent = restored.peer_request(
        new_page,
        &room,
        piik_channel_core::conversation::ConversationCommand::Chat {
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
            text: "Still admitted".into(),
            nonce: "after-legacy-restore".into(),
            attachments: vec![],
        },
    );
    assert!(
        sent.result.is_ok(),
        "a previously empty role list is no longer a participation restriction"
    );
    let created = self::room(&mut restored, new_page, "public", false);
    assert_eq!(
        restored.policy(&created).creator_id,
        original.policy(&room).creator_id
    );
    let (_, again, _) = admit(
        &mut restored,
        Uuid::new_v4(),
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    assert_eq!(again, owner_credential);
    assert!(restored.state(new_page).publications.is_empty());
    assert!(restored.state(new_page).voice.is_empty());
}

#[test]
fn late_room_results_ignore_unrelated_profile_changes_and_departures() {
    use piik_channel_core::{host::HostAction, wire::Request};
    let mut network = core();
    let owner = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let unrelated = Uuid::new_v4();
    admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    let (_, credential, _) = admit(&mut network, actor, json!({"type":"join","name":"Actor"}));
    admit(
        &mut network,
        unrelated,
        json!({"type":"join","name":"Unrelated"}),
    );
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
        json!({"type":"set_profile","avatar":null,"name":"Renamed owner"}),
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
    assert!(matches!(result, RoomResult::Done));
    for (name, credential, departure) in [
        ("Returning", Some(credential.as_str()), false),
        ("Newcomer", None, true),
    ] {
        let connection = Uuid::new_v4();
        admit(
            &mut network,
            connection,
            json!({"type":"join","name":name,"credential":credential}),
        );
        let effects = network.authority.handle(
            connection,
            Request::parse(
                &json!({
                    "type":"enter_room","roomId":private,"inviteKey":invitation,"requestId":"entry"
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
        assert!(matches!(input.action, HostAction::Command { .. }));
        let entered = network.host_turn(&private, input);
        if departure {
            command(&mut network, unrelated, json!({"type":"leave"}));
        } else {
            command(
                &mut network,
                owner,
                json!({"type":"set_profile","avatar":null,"name":"Still owner"}),
            );
        }
        let accepted = command(
            &mut network,
            owner,
            json!({"type":"host_output","roomId":private,"output":entered}),
        );
        assert!(!accepted.close.contains(&connection));
        assert!(accepted
            .events
            .iter()
            .any(|(recipient, event)| *recipient == connection
                && matches!(event,
            Event::RoomReply { request_id:Some(id),result:RoomResult::Done,.. } if id=="entry")));
    }
}

#[test]
fn resumed_host_can_retire_its_current_binding_before_registering_again() {
    let mut network = RoomNetwork::new();
    let old = Uuid::new_v4();
    let (session, credential, _) = admit(
        &mut network,
        old,
        json!({"type":"join","name":"Host","ownerKey":"owner"}),
    );
    let other = Uuid::new_v4();
    admit(
        &mut network,
        other,
        json!({"type":"join","name":"Second session","credential":credential}),
    );
    let id = room(&mut network, old, "public", false);
    let binding = network
        .state(old)
        .channel
        .rooms
        .iter()
        .find(|room| room.id == id)
        .unwrap()
        .delivery
        .as_ref()
        .unwrap()
        .binding_id;

    let query = piik_channel_core::wire::Request::parse(
        &json!({
            "type":"delete_room", "deleteData":true, "roomId":id, "requestId":"prior"
        })
        .to_string(),
    )
    .unwrap();
    let input = network
        .authority
        .handle(old, query, 100)
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let late_output = network.host_turn(&id, input);
    network.authority.disconnect(old, 100);
    let resumed = Uuid::new_v4();
    network.host_connection(&id, resumed);
    let (current, _, _) = admit(
        &mut network,
        resumed,
        json!({
            "type":"join","name":"Host","credential":credential,"sessionId":session
        }),
    );
    assert_eq!(current, session);

    let early_output = network.command(
        resumed,
        json!({"type":"host_output","roomId":id,"output":late_output}),
    );
    assert!(early_output.events.iter().any(|(to, event)| *to == resumed
        && matches!(event, Event::Error { code, .. } if code == "stale_room_host")));

    let stop = |binding: Uuid| json!({"type":"host_stop","roomId":id,"bindingId":binding,"requestId":"stop"});
    for (connection, candidate, expected) in [
        (old, binding, "join_required"),
        (other, binding, "stale_room_host"),
        (resumed, Uuid::new_v4(), "stale_room_host"),
    ] {
        let rejected = network.command(connection, stop(candidate));
        assert!(rejected.events.iter().any(|(to, event)| *to == connection
            && matches!(event, Event::Error { code, .. } if code == expected)));
    }
    let stopped = network.command(resumed, stop(binding));
    assert!(stopped.events.iter().any(|(to, event)| *to == resumed
        && matches!(event, Event::Ack { request_id } if request_id == "stop")));
    let room = network
        .state(resumed)
        .channel
        .rooms
        .iter()
        .find(|room| room.id == id)
        .unwrap();
    assert!(room.delivery.is_none() && !room.available);
}
