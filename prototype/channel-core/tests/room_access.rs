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
fn zero_leaf_join_order_insertion_passes_the_domain_projection_and_preserves_existing_voice() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Owner","key":"owner"}),
    );
    admit(
        &mut network,
        a,
        json!({"type":"join","name":"A","key":"invite"}),
    );
    admit(
        &mut network,
        b,
        json!({"type":"join","name":"B","key":"invite"}),
    );
    let room = room(&mut network, owner, "public", false);
    let apply = |network: &mut RoomNetwork, connection, value| {
        let effects = command(network, connection, value);
        assert!(
            !effects.events.iter().any(|(_, event)| matches!(
                event,
                Event::Error { .. }
                    | Event::RoomReply {
                        result: RoomResult::Error { .. },
                        ..
                    }
            )),
            "actual domain/room operation must accept the bounded insertion"
        );
    };
    apply(
        &mut network,
        owner,
        json!({"type":"update_room","roomId":room,"name":"Limited","icon":"couch","access":"public","hidden":false,"relayCapacity":1}),
    );
    apply(
        &mut network,
        owner,
        json!({"type":"browse","roomId":room,"active":true}),
    );
    apply(
        &mut network,
        a,
        json!({"type":"browse","roomId":room,"active":true,"relayCapacity":0}),
    );
    let ack = |network: &mut RoomNetwork| {
        for connection in [owner, a, b] {
            let pairs: Vec<_> = network
                .state(connection)
                .pairs
                .iter()
                .filter(|pair| pair.rooms.contains(&room))
                .map(|pair| pair.id)
                .collect();
            for pair in pairs {
                apply(
                    network,
                    connection,
                    json!({"type":"base_state","roomId":room,"pairId":pair,"ready":true}),
                );
            }
        }
    };
    ack(&mut network);
    for connection in [owner, a] {
        apply(
            &mut network,
            connection,
            json!({"type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false}),
        );
    }
    ack(&mut network);
    let first_voice = Uuid::new_v4();
    apply(
        &mut network,
        a,
        json!({"type":"publish","publication":{"id":first_voice,"roomId":room,"kind":"voice"}}),
    );
    let old: Vec<_> = network
        .state(owner)
        .pairs
        .iter()
        .flat_map(|pair| {
            pair.incoming
                .iter()
                .filter(|flow| flow.publication_id == first_voice)
                .map(move |flow| (pair.id, flow.id))
        })
        .collect();
    for (pair, flow) in &old {
        apply(
            &mut network,
            owner,
            json!({"type":"flow_state","pairId":pair,"flowId":flow,"state":"forwardable"}),
        );
    }
    apply(
        &mut network,
        b,
        json!({"type":"browse","roomId":room,"active":true,"relayCapacity":2}),
    );
    apply(
        &mut network,
        b,
        json!({"type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false}),
    );
    let second_voice = Uuid::new_v4();
    apply(
        &mut network,
        b,
        json!({"type":"publish","publication":{"id":second_voice,"roomId":room,"kind":"voice"}}),
    );
    ack(&mut network);
    assert!(old
        .iter()
        .all(|(_, old)| network.state(owner).pairs.iter().any(|pair| pair
            .incoming
            .iter()
            .any(|flow| flow.id == *old && flow.selected))));
    let shadows: Vec<_> = [owner, a, b]
        .into_iter()
        .flat_map(|connection| {
            network
                .state(connection)
                .pairs
                .iter()
                .flat_map(move |pair| {
                    pair.incoming
                        .iter()
                        .filter(|flow| !flow.selected)
                        .map(move |flow| (connection, pair.id, flow.id))
                })
        })
        .collect();
    assert!(!shadows.is_empty());
    for (connection, pair, flow) in shadows {
        apply(
            &mut network,
            connection,
            json!({"type":"flow_state","pairId":pair,"flowId":flow,"state":"forwardable"}),
        );
    }
    assert_eq!(
        network
            .state(owner)
            .pairs
            .iter()
            .filter(|pair| pair.rooms.contains(&room))
            .count(),
        1
    );
    assert_eq!(
        network
            .state(b)
            .pairs
            .iter()
            .filter(|pair| pair.rooms.contains(&room))
            .count(),
        2
    );
    assert!(network.state(b).pairs.iter().any(|pair| pair
        .outgoing
        .iter()
        .any(|flow| flow.publication_id == second_voice && flow.selected)));
}

#[test]
fn capacity_transition_keeps_candidate_hops_out_of_the_directory_and_other_room_leases() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let owner_session = admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Owner","key":"owner"}),
    )
    .0;
    admit(
        &mut network,
        first,
        json!({"type":"join","name":"First","key":"invite"}),
    );
    admit(
        &mut network,
        second,
        json!({"type":"join","name":"Second","key":"invite"}),
    );
    let a = room(&mut network, owner, "public", false);
    let b = room(&mut network, owner, "public", false);
    for id in [&a, &b] {
        for connection in [owner, first, second] {
            command(
                &mut network,
                connection,
                json!({"type":"browse","roomId":id,"active":true}),
            );
            command(
                &mut network,
                connection,
                json!({"type":"voice","roomId":id,"joined":true,"muted":true,"deafened":true}),
            );
        }
        for _ in 0..2 {
            for connection in [owner, first, second] {
                let pairs: Vec<_> = network
                    .state(connection)
                    .pairs
                    .iter()
                    .filter(|pair| pair.rooms.contains(id))
                    .map(|pair| pair.id)
                    .collect();
                for pair in pairs {
                    command(
                        &mut network,
                        connection,
                        json!({"type":"base_state","roomId":id,"pairId":pair,"ready":true}),
                    );
                }
            }
        }
    }
    let publication = Uuid::new_v4();
    for connection in [owner, first, second] {
        command(
            &mut network,
            connection,
            json!({"type":"voice","roomId":a,"joined":true,"muted":false,"deafened":false}),
        );
    }
    command(
        &mut network,
        first,
        json!({"type":"publish","publication":{"id":publication,"roomId":a,"kind":"voice"}}),
    );
    for connection in [owner, first, second] {
        let flows: Vec<_> = network
            .state(connection)
            .pairs
            .iter()
            .flat_map(|pair| pair.incoming.iter().map(move |flow| (pair.id, flow.id)))
            .collect();
        for (pair, flow) in flows {
            command(
                &mut network,
                connection,
                json!({"type":"flow_state","pairId":pair,"flowId":flow,"state":"forwardable"}),
            );
        }
    }
    let hops = |network: &RoomNetwork, id: &str| {
        network
            .state(owner)
            .channel
            .rooms
            .iter()
            .find(|room| room.id == id)
            .unwrap()
            .delivery
            .as_ref()
            .unwrap()
            .next_hops
            .clone()
    };
    let old_a = hops(&network, &a);
    let old_b = hops(&network, &b);
    let denied = command(
        &mut network,
        first,
        json!({"type":"update_room","roomId":a,"name":"Denied","icon":"couch","access":"public","hidden":false,"relayCapacity":1}),
    );
    assert!(denied.events.iter().any(|(_, event)| matches!(
        event,
        Event::RoomReply {
            result: RoomResult::Error { .. },
            ..
        }
    )));
    command(
        &mut network,
        owner,
        json!({"type":"update_room","roomId":a,"name":"Limited","icon":"couch","access":"public","hidden":false,"relayCapacity":1}),
    );
    for connection in [owner, first, second] {
        let pairs: Vec<_> = network
            .state(connection)
            .pairs
            .iter()
            .filter(|pair| pair.rooms.contains(&a))
            .map(|pair| pair.id)
            .collect();
        for pair in pairs {
            command(
                &mut network,
                connection,
                json!({"type":"base_state","roomId":a,"pairId":pair,"ready":true}),
            );
        }
    }
    assert_eq!(
        hops(&network, &a),
        old_a,
        "candidate ACKs cannot publish a new file next hop before voice proof"
    );
    let shadows: Vec<_> = [owner, first, second]
        .into_iter()
        .flat_map(|connection| {
            network
                .state(connection)
                .pairs
                .iter()
                .flat_map(move |pair| {
                    pair.incoming
                        .iter()
                        .filter(|flow| !flow.selected)
                        .map(move |flow| (connection, pair.id, flow.id))
                })
        })
        .collect();
    assert!(!shadows.is_empty());
    for (connection, pair, flow) in shadows {
        command(
            &mut network,
            connection,
            json!({"type":"flow_state","pairId":pair,"flowId":flow,"state":"forwardable"}),
        );
    }
    assert_ne!(hops(&network, &a), old_a);
    assert_eq!(hops(&network, &b), old_b);
    assert_eq!(
        network
            .state(owner)
            .pairs
            .iter()
            .filter(|pair| pair.rooms.contains(&b))
            .count(),
        2,
        "the old physical pairs still carry the other room"
    );
    assert!(network
        .state(owner)
        .channel
        .rooms
        .iter()
        .find(|room| room.id == a)
        .unwrap()
        .delivery
        .as_ref()
        .is_some_and(|delivery| delivery.host_session_id == owner_session));
}

#[test]
fn deletion_withdraws_directory_authority_across_restart_without_recreating_the_room() {
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    let creator = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Domain owner","key":"owner"}),
    );
    let (_, credential, _) = admit(
        &mut network,
        creator,
        json!({"type":"join","name":"Creator","key":"invite"}),
    );
    admit(
        &mut network,
        stranger,
        json!({"type":"join","name":"Stranger","key":"invite"}),
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
    let pending = network.authority.handle(
        owner,
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
    network.authority.disconnect(owner, 100);
    let removed = command(
        &mut network,
        creator,
        json!({"type":"host_output","roomId":deleted,"output":output}),
    );
    assert!(
        !removed
            .events
            .iter()
            .any(|(target, event)| *target == owner && matches!(event, Event::RoomReply { .. })),
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
    for value in [
        json!({"type":"host_register","room":summary}),
        json!({"type":"admit_room","room":summary}),
    ] {
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
        json!({"type":"join","name":"Domain owner","key":"owner"}),
    );
    let admitted = command(
        &mut reopened,
        administrator,
        json!({"type":"admit_room","room":summary,"requestId":"restore"}),
    );
    assert!(admitted
        .events
        .iter()
        .any(|(_, event)| matches!(event, Event::Ack { request_id } if request_id == "restore")));
    reopened.restore_room(returning, policy);
}

#[test]
fn offline_removal_and_correlated_online_deletion_keep_room_scopes_separate() {
    use piik_channel_core::wire::Request;
    let mut network = RoomNetwork::new();
    let owner = Uuid::new_v4();
    admit(
        &mut network,
        owner,
        json!({"type":"join","name":"Owner","key":"owner"}),
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
fn room_invitation_reads_are_private_and_never_rotate_the_current_link() {
    use piik_channel_core::wire::RoomInvitation;
    let mut network = core();
    let owner = Uuid::new_v4();
    let creator = Uuid::new_v4();
    let reader = Uuid::new_v4();
    for (connection, key) in [(owner, "owner"), (creator, "invite"), (reader, "invite")] {
        admit(
            &mut network,
            connection,
            json!({"type":"join","name":"User","key":key}),
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
    let key = invite(&mut network, creator, &room);
    let saved = serde_json::to_value(network.policy(&room)).unwrap();
    for manager in [creator, owner, creator] {
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
        RoomInvitation::Available { key: replacement }
    );
    assert!(network
        .state(reader)
        .channel
        .rooms
        .iter()
        .any(|value| value.id == room && value.authorized));
    let mut legacy = serde_json::to_value(network.policy(&room)).unwrap();
    legacy.as_object_mut().unwrap().remove("inviteKey");
    network.restore_room(creator, serde_json::from_value(legacy).unwrap());
    assert_eq!(read(&mut network, creator), RoomInvitation::Unrecoverable);
    command(
        &mut network,
        creator,
        json!({"type":"update_room","roomId":room,"name":"Public","icon":"couch","access":"public","hidden":false}),
    );
    rejected(command(
        &mut network,
        creator,
        json!({"type":"get_room_invite","roomId":room}),
    ));
    rejected(command(
        &mut network,
        creator,
        json!({"type":"room_invite","roomId":room}),
    ));
}

#[test]
fn topology_read_uses_current_room_admission_and_binding_without_host_turns() {
    let mut core = core();
    let owner = Uuid::new_v4();
    let reader = Uuid::new_v4();
    admit(
        &mut core,
        owner,
        json!({"type":"join","name":"Owner","key":"owner"}),
    );
    let (reader_session, _, _) = admit(
        &mut core,
        reader,
        json!({"type":"join","name":"Reader","key":"invite"}),
    );
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
            json!({"type":"publish","publication":{"id":id,"roomId":room,"kind":kind,"videoCeiling":if kind == "screen" { Some(json!({"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000})) } else { None }}}),
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
                    json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":kind,"videoCeiling":if kind == "screen" { Some(json!({"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000})) } else { None }}}),
                );
            }
        }
        let duplicate = command(
            &mut core,
            peers[0],
            json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":"screen","videoCeiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000}}}),
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
                json!({"type":"publish","publication":{"id":id,"roomId":room,"kind":"voice"}}),
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
        json!({"type":"publish","publication":{"id":picture,"roomId":studio,"kind":"screen","videoCeiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000}}}),
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
    let (_, _, initial) = admit(
        &mut core,
        outsider,
        json!({"type":"join","name":"Outsider","key":"invite"}),
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
        json!({"type":"publish","publication":{"id":private_pub,"roomId":room,"kind":"screen","videoCeiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000}}}),
    );
    command(
        &mut core,
        creator,
        json!({"type":"publish","publication":{"id":public_pub,"roomId":public_room,"kind":"screen","videoCeiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000}}}),
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
        json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":"screen","videoCeiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000}}}),
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
        json!({"type":"join","name":"Owner","key":"owner"}),
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
        json!({"type":"join","name":"Owner","key":"owner"}),
    );
    let (_, credential, _) = admit(
        &mut network,
        actor,
        json!({"type":"join","name":"Actor","key":"invite"}),
    );
    admit(
        &mut network,
        unrelated,
        json!({"type":"join","name":"Unrelated","key":"invite"}),
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
        json!({"type":"set_name","name":"Renamed owner"}),
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
    let returning = Uuid::new_v4();
    let signing_key =
        piik_channel_core::conversation::SessionSigner::from_seed([1; 32]).signing_key();
    let effects = network.authority.handle(
        returning,
        Request::parse(
            &json!({
                "type": "join", "protocol": piik_channel_core::wire::CHANNEL_PROTOCOL, "name": "Returning", "credential": credential,
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
        json!({"type":"set_name","name":"Still owner"}),
    );
    let accepted = command(
        &mut network,
        owner,
        json!({"type":"host_output","roomId":private,"output":verification}),
    );
    assert!(!accepted.close.contains(&returning));
    assert!(
        accepted
            .events
            .iter()
            .any(|(recipient, event)| *recipient == returning
                && matches!(event, Event::Welcome { .. })),
        "an existing user's verified invitation remains valid across profile changes"
    );

    let newcomer = Uuid::new_v4();
    let effects = network.authority.handle(
        newcomer,
        Request::parse(
            &json!({
                "type": "join", "protocol": piik_channel_core::wire::CHANNEL_PROTOCOL, "name": "Newcomer", "key": invitation,
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
