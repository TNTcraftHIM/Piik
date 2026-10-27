use piik_channel_prototype::{
    host::{HostAction, HostInput, RequestContext, RoomHost},
    wire::{Command, Kind, PublicationInput, RoomAccess},
    Endpoint, Member, RoomState,
};
use std::collections::BTreeMap;
use uuid::Uuid;

#[test]
fn storage_abort_does_not_restore_activity_retired_by_current_domain_endpoints() {
    for remove_session in [true, false] {
        let owner = Member {
            user_id: Uuid::new_v4(),
            participates: true,
            domain_owner: false,
        };
        let viewer = Member {
            user_id: Uuid::new_v4(),
            participates: true,
            domain_owner: false,
        };
        let publisher = Uuid::new_v4();
        let reader = Uuid::new_v4();
        let publication = Uuid::new_v4();
        let binding = Uuid::new_v4();
        let mut endpoints = BTreeMap::from([
            (
                publisher,
                Endpoint {
                    member: owner,
                    connected: true,
                },
            ),
            (
                reader,
                Endpoint {
                    member: viewer,
                    connected: true,
                },
            ),
        ]);
        let mut host = RoomHost::new(
            RoomState::new(
                "review".into(),
                "Review".into(),
                owner.user_id,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        let context = |session_id| RequestContext {
            connection: Uuid::new_v4(),
            session_id,
            request_id: None,
            now: 0,
        };
        host.dispatch(HostInput {
            binding_id: binding,
            host_session_id: publisher,
            revision: 1,
            endpoints: endpoints.clone(),
            action: HostAction::Command {
                context: context(publisher),
                command: Command::Publish {
                    publication: PublicationInput {
                        id: publication,
                        room_id: "review".into(),
                        kind: Kind::Screen,
                        muted: false,
                    },
                },
            },
        })
        .unwrap();
        assert_eq!(
            host.finish(None).unwrap().projection.views[&reader]
                .publications
                .len(),
            1
        );
        if remove_session {
            endpoints.remove(&publisher);
        } else {
            endpoints.get_mut(&publisher).unwrap().member.participates = false;
        }
        let work = host
            .dispatch(HostInput {
                binding_id: binding,
                host_session_id: publisher,
                revision: 2,
                endpoints,
                action: HostAction::Command {
                    context: context(reader),
                    command: Command::History {
                        room_id: "review".into(),
                        before: None,
                    },
                },
            })
            .unwrap();
        assert!(work.history.is_some());
        let output = host.abort("storage_failed".into()).unwrap();
        assert!(
            output.projection.views[&reader].publications.is_empty(),
            "storage failure restored {} publisher's retired activity",
            if remove_session {
                "expired"
            } else {
                "role-revoked"
            }
        );
        assert!(output.projection.flows.is_empty());
    }
}

fn review_admit(core: &mut piik_channel_prototype::Authority, connection: Uuid, key: &str) -> Uuid {
    core.handle(
        connection,
        piik_channel_prototype::wire::Request::parse(
            &serde_json::json!({"type":"join","name":"Review","key":key}).to_string(),
        )
        .unwrap(),
        0,
    )
    .events
    .into_iter()
    .find_map(|(_, e)| match e {
        piik_channel_prototype::wire::Event::Welcome { session_id, .. } => Some(session_id),
        _ => None,
    })
    .unwrap()
}
fn review_host_turn(
    core: &mut piik_channel_prototype::Authority,
    host_connection: Uuid,
    room_id: &str,
    output: piik_channel_prototype::host::HostOutput,
) -> piik_channel_prototype::Effects {
    core.handle(
        host_connection,
        piik_channel_prototype::wire::Request {
            request_id: None,
            command: Command::HostOutput {
                room_id: room_id.into(),
                output,
            },
        },
        1,
    )
}
fn review_register(
    core: &mut piik_channel_prototype::Authority,
    host_connection: Uuid,
    host: &RoomHost,
) -> piik_channel_prototype::host::HostInput {
    core.handle(
        host_connection,
        piik_channel_prototype::wire::Request {
            request_id: None,
            command: Command::HostRegister {
                room: host.summary(),
                resume_binding: None,
            },
        },
        0,
    )
    .events
    .into_iter()
    .find_map(|(_, e)| match e {
        piik_channel_prototype::wire::Event::HostInput { input, .. } => Some(input),
        _ => None,
    })
    .unwrap()
}
#[test]
fn room_host_cannot_complete_an_unissued_other_room_request() {
    use piik_channel_prototype::{
        host::{RoomReply, RoomResult},
        wire::Event,
        Authority,
    };
    let mut core = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let b_session = review_admit(&mut core, b, "invite");
    let c_session = review_admit(&mut core, c, "invite");
    let b_user = core
        .handle(
            b,
            piik_channel_prototype::wire::Request {
                request_id: None,
                command: Command::SetName { name: "B".into() },
            },
            0,
        )
        .events
        .into_iter()
        .find_map(|(connection, e)| match e {
            Event::State { state } if connection == b => Some(
                state
                    .sessions
                    .into_iter()
                    .find(|s| s.id == b_session)
                    .unwrap()
                    .user_id,
            ),
            _ => None,
        })
        .unwrap();
    let mut host = RoomHost::new(
        RoomState::new(
            "host-review".into(),
            "Review".into(),
            b_user,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap(),
    );
    let input = review_register(&mut core, b, &host);
    host.dispatch(input).unwrap();
    let mut output = host.finish(None).unwrap();
    output.reply = Some(RoomReply {
        context: RequestContext {
            connection: c,
            session_id: c_session,
            request_id: Some("other-room-request".into()),
            now: 0,
        },
        result: RoomResult::Done,
    });
    let effects = review_host_turn(&mut core, b, "host-review", output);
    assert!(
        !effects
            .events
            .iter()
            .any(|(target, event)| *target == c && matches!(event, Event::RoomReply { .. })),
        "host completed a request never routed to its room"
    );
}
#[test]
fn invited_connection_cannot_act_before_room_grant_commits() {
    use piik_channel_prototype::{
        wire::{Event, Request},
        Authority,
    };
    let mut core = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let bs = review_admit(&mut core, b, "invite");
    let bu = core
        .handle(
            b,
            Request {
                request_id: None,
                command: Command::SetName { name: "B".into() },
            },
            0,
        )
        .events
        .into_iter()
        .find_map(|(target, e)| match e {
            Event::State { state } if target == b => Some(
                state
                    .sessions
                    .into_iter()
                    .find(|s| s.id == bs)
                    .unwrap()
                    .user_id,
            ),
            _ => None,
        })
        .unwrap();
    let mut policy = RoomState::new(
        "private-review".into(),
        "Private".into(),
        bu,
        RoomAccess::Private,
        true,
        None,
    )
    .unwrap();
    let key = policy.invite().unwrap();
    let mut host = RoomHost::new(policy);
    let input = review_register(&mut core, b, &host);
    host.dispatch(input).unwrap();
    review_host_turn(&mut core, b, "private-review", host.finish(None).unwrap());
    let effects = core.handle(
        c,
        Request::parse(
            &serde_json::json!({"type":"join","name":"C","key":key,"roomId":"private-review"})
                .to_string(),
        )
        .unwrap(),
        1,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, e)| match e {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    host.dispatch(input).unwrap();
    let effects = review_host_turn(&mut core, b, "private-review", host.finish(None).unwrap());
    assert!(effects.events.iter().any(|(_,e)|matches!(e,Event::HostInput{input,..}if matches!(input.action,HostAction::GrantInvited{..}))));
    let effects = core.handle(
        c,
        Request {
            request_id: Some("premature".into()),
            command: Command::SetName {
                name: "Premature".into(),
            },
        },
        2,
    );
    assert!(
        !effects.events.iter().any(|(target, e)| *target == c
            && matches!(e,Event::Ack{request_id}if request_id=="premature")),
        "uncompleted room invitation already admitted a usable domain session"
    );
}

#[test]
fn successful_publish_projection_survives_a_later_queued_ordinary_command() {
    use piik_channel_prototype::{
        wire::{Event, Request},
        Authority,
    };
    let mut core = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let bs = review_admit(&mut core, b, "invite");
    review_admit(&mut core, c, "invite");
    let bu = core
        .handle(
            b,
            Request {
                request_id: None,
                command: Command::SetName { name: "B".into() },
            },
            0,
        )
        .events
        .into_iter()
        .find_map(|(target, e)| match e {
            Event::State { state } if target == b => Some(
                state
                    .sessions
                    .into_iter()
                    .find(|s| s.id == bs)
                    .unwrap()
                    .user_id,
            ),
            _ => None,
        })
        .unwrap();
    let mut host = RoomHost::new(
        RoomState::new(
            "concurrent-review".into(),
            "Concurrent".into(),
            bu,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap(),
    );
    let input = review_register(&mut core, b, &host);
    host.dispatch(input).unwrap();
    review_host_turn(
        &mut core,
        b,
        "concurrent-review",
        host.finish(None).unwrap(),
    );
    let publication = Uuid::new_v4();
    let effects = core.handle(
        b,
        Request {
            request_id: Some("publish".into()),
            command: Command::Publish {
                publication: PublicationInput {
                    id: publication,
                    room_id: "concurrent-review".into(),
                    kind: Kind::Screen,
                    muted: false,
                },
            },
        },
        1,
    );
    let input = effects
        .events
        .into_iter()
        .find_map(|(_, e)| match e {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    // A normal next command is queued before the preceding host result arrives.
    let queued = core.handle(
        c,
        Request {
            request_id: Some("next-history".into()),
            command: Command::History {
                room_id: "concurrent-review".into(),
                before: None,
            },
        },
        1,
    );
    assert!(queued
        .events
        .iter()
        .any(|(_, e)| matches!(e, Event::HostInput { .. })));
    host.dispatch(input).unwrap();
    let completed = review_host_turn(
        &mut core,
        b,
        "concurrent-review",
        host.finish(None).unwrap(),
    );
    assert!(
        completed.events.iter().any(|(target, e)| *target == b
            && matches!(e,Event::RoomReply{request_id:Some(id),..}if id=="publish")),
        "publish completion was lost"
    );
    // The already-acknowledged source must remain admitted in unrelated full snapshots.
    let effects = core.handle(
        c,
        Request {
            request_id: Some("rename".into()),
            command: Command::SetName { name: "C".into() },
        },
        2,
    );
    let state = effects
        .events
        .into_iter()
        .find_map(|(target, e)| match e {
            Event::State { state } if target == b => Some(state),
            _ => None,
        })
        .unwrap();
    assert!(state.publications.iter().any(|p|p.id==publication),"acknowledged capture vanished because an unrelated ordinary room command advanced revision");
}
