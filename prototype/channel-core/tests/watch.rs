#![cfg(feature = "sqlite")]
mod support;
use piik_channel_core::{
    host::RoomResult,
    wire::{Event, RoomAccess},
};
use serde_json::{json, Value};
use support::RoomNetwork;
use uuid::Uuid;
fn setup() -> (RoomNetwork, Uuid, Uuid, String) {
    let mut net = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    net.command(
        owner,
        json!({"type":"join","name":"Owner","ownerKey":"owner"}),
    );
    net.command(viewer, json!({"type":"join","name":"Viewer"}));
    let room = net.create(owner, RoomAccess::Public, false);
    (net, owner, viewer, room)
}
fn playback() -> Value {
    json!({"position":12.5,"paused":false,"rate":1.5,"anchorTime":1000})
}
fn start(room: &str, id: Uuid) -> Value {
    json!({"type":"start_watch","roomId":room,"id":id,"url":"https://example.com/movie.mp4","playback":playback(),"requestId":"start"})
}
fn ready(effects: piik_channel_core::Effects, time: u64) {
    assert!(effects.events.iter().any(|(_,e)|matches!(e,Event::RoomReply{result:RoomResult::WatchReady{server_time},..} if *server_time==time)));
}
fn error(effects: piik_channel_core::Effects, code: &str) {
    assert!(effects.events.iter().any(|(_,e)|matches!(e,Event::RoomReply{result:RoomResult::Error{code:c},..}|Event::Error{code:c,..} if c==code)));
}
#[test]
fn watch_confirmations_late_join_and_owner_control_do_not_create_media() {
    let (mut net, owner, viewer, room) = setup();
    let id = Uuid::new_v4();
    // The sharer is a reader, not the room manager.
    ready(net.command_at(viewer, start(&room, id), 2000), 2000);
    assert_eq!(
        net.state(owner).watch_activities[0].playback.anchor_time,
        1000
    );
    ready(
        net.command_at(
            owner,
            json!({"type":"join_watch","roomId":room,"id":id,"enabled":true,"requestId":"join"}),
            3000,
        ),
        3000,
    );
    assert_eq!(net.state(owner).watch_subscriptions, vec![id]);
    assert_eq!(net.state(owner).watch_activities[0].playback.position, 12.5);
    for command in [
        json!({"type":"update_watch","roomId":room,"id":id,"playback":playback()}),
        json!({"type":"stop_watch","roomId":room,"id":id}),
    ] {
        error(net.command(owner, command), "not_watch_owner");
    }
    let updated = json!({"position":30,"paused":true,"rate":2,"anchorTime":4000});
    net.command(
        viewer,
        json!({"type":"update_watch","roomId":room,"id":id,"playback":updated}),
    );
    ready(net.command_at(viewer, start(&room, id), 5000), 5000);
    assert_eq!(net.state(owner).watch_activities[0].playback.position, 30.0);
    for c in [owner, viewer] {
        let state = net.state(c);
        assert!(state.pairs.is_empty());
        assert!(state.publications.is_empty());
        assert!(state.channel.rooms[0].realtime_session_ids.is_empty());
        assert_eq!(state.channel.rooms[0].participant_session_ids.len(), 2);
    }
    net.command(
        owner,
        json!({"type":"join_watch","roomId":room,"id":id,"enabled":false}),
    );
    assert!(net.state(owner).watch_subscriptions.is_empty());
    net.command(viewer, json!({"type":"stop_watch","roomId":room,"id":id}));
    assert!(net.state(owner).watch_activities.is_empty());
}
#[test]
fn watch_validation_and_source_retirement_are_bounded() {
    let (mut net, owner, viewer, room) = setup();
    let id = Uuid::new_v4();
    for url in [
        "javascript:alert(1)",
        "/movie.mp4",
        "https://user:password@example.com/a",
    ] {
        let mut value = start(&room, id);
        value["url"] = json!(url);
        error(net.command(owner, value), "invalid_watch_url");
    }
    let mut value = start(&room, id);
    value["playback"]["rate"] = json!(0);
    error(net.command(owner, value), "invalid_watch_playback");
    net.command(viewer, start(&room, id));

    net.command(
        owner,
        json!({"type":"join_watch","roomId":room,"id":id,"enabled":true}),
    );
    net.command(viewer, json!({"type":"leave"}));
    assert!(net.state(owner).watch_activities.is_empty());
    assert!(net.state(owner).watch_subscriptions.is_empty());
    net.command(owner, start(&room, id));
    let binding = net.state(owner).channel.rooms[0]
        .delivery
        .as_ref()
        .unwrap()
        .binding_id;
    net.command(
        owner,
        json!({"type":"host_stop","roomId":room,"bindingId":binding}),
    );
    assert!(net.state(owner).watch_activities.is_empty());
}

#[test]
fn watch_room_access_revoke_preserves_other_room_media() {
    let (mut net, owner, viewer, public) = setup();
    let private = net.create(owner, RoomAccess::Private, false);
    let id = Uuid::new_v4();
    error(
        net.command(viewer, start(&private, id)),
        "room_access_required",
    );
    net.command(owner,json!({"type":"update_room","roomId":private,"name":"Private","icon":"couch","access":"private","hidden":false,"password":"secret"}));
    net.command(
        viewer,
        json!({"type":"enter_room","roomId":private,"password":"secret"}),
    );
    net.command(viewer, start(&private, id));
    net.command(
        owner,
        json!({"type":"join_watch","roomId":private,"id":id,"enabled":true}),
    );
    for kind in ["voice", "screen"] {
        if kind == "voice" {
            net.command(viewer,json!({"type":"voice","roomId":public,"joined":true,"muted":false,"deafened":false}));
        }
        let source = if kind == "screen" {
            json!({"kind":"screen","name":null})
        } else {
            Value::Null
        };
        net.command(viewer,json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":public,"kind":kind,"source":source,"videoSettings":null}}));
    }
    let before = serde_json::to_value(&net.state(owner).publications).unwrap();
    assert_eq!(before.as_array().unwrap().len(), 2);
    let viewer_user = net.state(viewer).watch_activities[0].user_id;
    net.command(
        owner,
        json!({"type":"revoke_room_access","roomId":private,"userId":viewer_user}),
    );
    for c in [owner, viewer] {
        assert!(net.state(c).watch_activities.is_empty());
        assert!(net.state(c).watch_subscriptions.is_empty());
    }
    assert_eq!(
        serde_json::to_value(&net.state(owner).publications).unwrap(),
        before
    );
    error(
        net.command(
            viewer,
            json!({"type":"update_watch","roomId":private,"id":id,"playback":playback()}),
        ),
        "room_access_required",
    );
}

#[test]
fn watch_disconnect_recovers_until_session_expiry() {
    let (mut net, owner, viewer, room) = setup();
    let id = Uuid::new_v4();
    net.command(viewer, start(&room, id));
    net.command(
        owner,
        json!({"type":"join_watch","roomId":room,"id":id,"enabled":true}),
    );
    let effects = net.authority.disconnect(viewer, 1000);
    net.deliver(effects);
    assert_eq!(net.state(owner).watch_activities.len(), 1);
    let effects = net.authority.expire(1000 + piik_channel_core::RECOVERY_MS);
    net.deliver(effects);
    assert!(net.state(owner).watch_activities.is_empty());
    assert!(net.state(owner).watch_subscriptions.is_empty());
}

#[test]
fn replacing_watch_validates_before_retiring_source_and_viewers() {
    let (mut net, owner, viewer, room) = setup();
    let old = Uuid::new_v4();
    let next = Uuid::new_v4();
    net.command(owner, start(&room, old));
    net.command(
        viewer,
        json!({"type":"join_watch","roomId":room,"id":old,"enabled":true}),
    );
    let mut replacement = start(&room, next);
    replacement["url"] = json!("javascript:bad");
    error(net.command(owner, replacement.clone()), "invalid_watch_url");
    assert_eq!(net.state(viewer).watch_subscriptions, vec![old]);
    assert_eq!(net.state(viewer).watch_activities[0].id, old);
    replacement["url"] = json!("https://example.com/next.mp4");
    let mut conflict = replacement.clone();
    conflict["id"] = json!(old);
    error(net.command(owner, conflict), "watch_identity_conflict");
    ready(net.command_at(owner, replacement, 6000), 6000);
    assert!(net.state(viewer).watch_subscriptions.is_empty());
    assert_eq!(net.state(viewer).watch_activities.len(), 1);
    assert_eq!(net.state(viewer).watch_activities[0].id, next);
    net.command(owner, json!({"type":"stop_watch","roomId":room,"id":old}));
    assert_eq!(net.state(viewer).watch_activities[0].id, next);
}
