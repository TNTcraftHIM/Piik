#![cfg(feature = "sqlite")]

mod support;

use piik_channel_core::{
    host::RoomSummary,
    wire::{Event, Request, RoomAccess, RoomCreationPolicy},
    Effects,
};
use serde_json::json;
use support::RoomNetwork;
use uuid::Uuid;

fn denied(effects: Effects, code: &str) {
    assert!(effects
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Error { code: actual, .. } if actual == code)));
}

#[test]
fn guest_policy_applies_at_every_directory_write_and_survives_restart() {
    let mut site = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let guest = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    site.command(
        owner,
        json!({"type":"join","name":"Operator","ownerKey":"owner"}),
    );
    let credential = site
        .command(guest, json!({"type":"join","name":"Guest"}))
        .events
        .into_iter()
        .find_map(|(_, e)| match e {
            Event::Welcome { credential, .. } => Some(credential),
            _ => None,
        })
        .unwrap();
    site.command(stranger, json!({"type":"join","name":"Visitor"}));
    let guest_public = site.create(guest, RoomAccess::Public, false);
    let guest_summary = RoomSummary::from_policy(&site.policy(&guest_public));
    let public = site.create(owner, RoomAccess::Public, false);
    let restrict = json!({"type":"set_room_creation_policy","policy":"invite_only"});
    denied(site.command(guest, restrict.clone()), "forbidden");
    site.command(owner, restrict);
    for connection in [owner, stranger] {
        let channel = &site.state(connection).channel;
        assert!(!channel.rooms.iter().any(|room| room.id == guest_public));
        assert!(channel.rooms.iter().any(|room| room.id == public));
    }
    assert!(site
        .state(owner)
        .channel
        .managed_room_ids
        .contains(&guest_public));
    assert!(site.state(stranger).channel.managed_room_ids.is_empty());
    for action in ["create_room", "admit_room", "host_register"] {
        denied(
            site.command(guest, json!({"type":action, "room":guest_summary})),
            "room_creation_restricted",
        );
    }
    let private = site.create(guest, RoomAccess::Private, true);
    let private_summary = RoomSummary::from_policy(&site.policy(&private));
    let turn = site.authority.handle(
        guest,
        Request::parse(&json!({"type":"browse","roomId":private,"active":true}).to_string())
            .unwrap(),
        100,
    );
    let input = turn
        .events
        .into_iter()
        .find_map(|(_, e)| match e {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    let valid = site.host_turn(&private, input);
    let mut forged = valid.clone();
    forged.projection.summary.hidden = false;
    denied(
        site.command(
            guest,
            json!({"type":"host_output","roomId":private,"output":forged}),
        ),
        "room_creation_restricted",
    );
    site.command(
        guest,
        json!({"type":"host_output","roomId":private,"output":valid}),
    );
    for (hidden, password) in [(false, None), (true, Some("guest-pass"))] {
        denied(site.command(guest, json!({"type":"update_room","roomId":private,"name":"Guest secret","access":"private","hidden":hidden,"icon":"couch","password":password})), "room_creation_restricted");
    }
    site.command(guest, json!({"type":"update_room","roomId":private,"name":"Guest secret","access":"private","hidden":true,"icon":"couch"}));
    assert!(site
        .state(guest)
        .channel
        .rooms
        .iter()
        .any(|room| room.name == "Guest secret"));
    for connection in [owner, stranger] {
        assert!(site
            .state(connection)
            .channel
            .rooms
            .iter()
            .all(|room| room.id != private));
    }
    let key = site
        .command(guest, json!({"type":"room_invite","roomId":private}))
        .events
        .into_iter()
        .find_map(|(_, e)| match e {
            Event::RoomReply { result: piik_channel_core::host::RoomResult::Invite { key }, .. } => Some(key),
            _ => None,
        })
        .unwrap();
    site.command(
        stranger,
        json!({"type":"enter_room","roomId":private,"inviteKey":key}),
    );
    assert!(site
        .state(stranger)
        .channel
        .rooms
        .iter()
        .any(|room| room.id == private && room.authorized));
    let binding = site
        .state(guest)
        .channel
        .rooms
        .iter()
        .find(|room| room.id == private)
        .unwrap()
        .delivery
        .as_ref()
        .unwrap()
        .binding_id;
    site.command(
        guest,
        json!({"type":"host_stop","roomId":private,"bindingId":binding}),
    );
    let removed = site.command(
        owner,
        json!({"type":"delete_room","roomId":private,"deleteData":true}),
    );
    assert!(removed.events.iter().any(|(_, event)| matches!(
        event,
        Event::RoomReply {
            result: piik_channel_core::host::RoomResult::Deleted {
                data_removed: false
            },
            ..
        }
    )));
    let checkpoint = site.authority.export_state();
    let mut restored = RoomNetwork::new();
    restored.authority.import_state(checkpoint).unwrap();
    restored.command(
        guest,
        json!({"type":"join","name":"Guest","credential":credential}),
    );
    assert_eq!(
        restored.state(guest).channel.room_creation_policy,
        RoomCreationPolicy::InviteOnly
    );
    for action in ["admit_room", "host_register"] {
        denied(
            restored.command(guest, json!({"type":action,"room":private_summary})),
            "room_not_in_domain",
        );
    }
    restored.command(
        owner,
        json!({"type":"join","name":"Operator","ownerKey":"owner"}),
    );
    restored.command(
        owner,
        json!({"type":"set_room_creation_policy","policy":"owner_only"}),
    );
    denied(
        restored.command(guest, json!({"type":"create_room","room":private_summary})),
        "room_creation_restricted",
    );
    restored.create(owner, RoomAccess::Public, false);
}

#[test]
fn only_creating_session_can_cancel_an_unbound_room() {
    let mut site = RoomNetwork::new();
    let [creator, sibling, stranger] = [(); 3].map(|_| Uuid::new_v4());
    let credential = site
        .command(creator, json!({"type":"join","name":"Creator"}))
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome { credential, .. } => Some(credential),
            _ => None,
        })
        .unwrap();
    site.command(
        sibling,
        json!({"type":"join","name":"Sibling","credential":credential}),
    );
    site.command(stranger, json!({"type":"join","name":"Other"}));
    let bound = site.create(creator, RoomAccess::Public, false);
    let summary = RoomSummary::from_policy(&site.policy(&bound));
    let create = json!({"type":"create_room","room":summary});
    let mut pending = String::new();
    for _ in 1..32 {
        pending = site
            .command(creator, create.clone())
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::RoomCreated { room, .. } => Some(room.id),
                _ => None,
            })
            .unwrap();
    }
    let cancel = |site: &mut RoomNetwork, connection, id: &str| {
        let effects = site.command(
            connection,
            json!({"type":"cancel_room_creation","roomId":id,"requestId":"cancel"}),
        );
        assert!(effects.events.iter().any(|(to, event)| *to == connection
            && matches!(event, Event::Ack {request_id} if request_id=="cancel")));
    };
    for connection in [sibling, stranger] {
        cancel(&mut site, connection, &pending);
    }
    cancel(&mut site, creator, &bound);
    assert!(site
        .state(creator)
        .channel
        .rooms
        .iter()
        .any(|room| room.id == bound));
    denied(site.command(creator, create.clone()), "room_limit");
    cancel(&mut site, creator, &pending);
    cancel(&mut site, creator, &pending);
    assert!(site
        .command(creator, create.clone())
        .events
        .iter()
        .any(|(_, e)| matches!(e, Event::RoomCreated { .. })));
    denied(site.command(creator, create), "room_limit");
}
