use piik_channel_core::{
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
        let mut endpoints =
            BTreeMap::from([
                (
                    publisher,
                    Endpoint {
                        member: owner,
                        connected: true,
                        signing_key:
                            piik_channel_core::conversation::SessionSigner::from_seed([1; 32])
                                .signing_key(),
                    },
                ),
                (
                    reader,
                    Endpoint {
                        member: viewer,
                        connected: true,
                        signing_key:
                            piik_channel_core::conversation::SessionSigner::from_seed([2; 32])
                                .signing_key(),
                    },
                ),
            ]);
        let mut host = RoomHost::new(
            RoomState::new(
                "review".into(),
                "Review".into(),
                Default::default(),
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
            now: 0,
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
                now: 0,
                binding_id: binding,
                host_session_id: publisher,
                revision: 2,
                endpoints,
                action: HostAction::Command {
                    context: context(reader),
                    command: Command::EnterRoom {
                        room_id: "review".into(),
                        password: None,
                        invite_key: None,
                    },
                },
            })
            .unwrap();
        assert!(work.policy.is_some());
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

fn review_admit(core: &mut piik_channel_core::Authority, connection: Uuid, key: &str) -> Uuid {
    core.handle(
        connection,
        piik_channel_core::wire::Request::parse(
            &serde_json::json!({"type":"join","signingKey":piik_channel_core::conversation::SessionSigner::from_seed([1; 32]).signing_key(),"name":"Review","key":key}).to_string(),
        )
        .unwrap(),
        0,
    )
    .events
    .into_iter()
    .find_map(|(_, e)| match e {
        piik_channel_core::wire::Event::Welcome { session_id, .. } => Some(session_id),
        _ => None,
    })
    .unwrap()
}
fn review_host_turn(
    core: &mut piik_channel_core::Authority,
    host_connection: Uuid,
    room_id: &str,
    output: piik_channel_core::host::HostOutput,
) -> piik_channel_core::Effects {
    core.handle(
        host_connection,
        piik_channel_core::wire::Request {
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
    core: &mut piik_channel_core::Authority,
    host_connection: Uuid,
    host: &RoomHost,
) -> piik_channel_core::host::HostInput {
    core.handle(
        host_connection,
        piik_channel_core::wire::Request {
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
        piik_channel_core::wire::Event::HostInput { input, .. } => Some(input),
        _ => None,
    })
    .unwrap()
}
#[test]
fn room_host_cannot_complete_an_unissued_other_room_request() {
    use piik_channel_core::{
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
            piik_channel_core::wire::Request {
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
            Default::default(),
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
    use piik_channel_core::{
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
        Default::default(),
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
            &serde_json::json!({"type":"join","signingKey":piik_channel_core::conversation::SessionSigner::from_seed([2; 32]).signing_key(),"name":"C","key":key,"roomId":"private-review"})
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
    use piik_channel_core::{
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
            Default::default(),
            bu,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap(),
    );
    let input = review_register(&mut core, b, &host);
    let domain_binding = input.binding_id;
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
            request_id: Some("next-browse".into()),
            command: Command::Browse {
                room_id: "concurrent-review".into(),
                active: true,
            },
        },
        1,
    );
    assert!(queued
        .events
        .iter()
        .any(|(_, e)| matches!(e, Event::HostInput { .. })));
    host.dispatch(input).unwrap();
    let mut output = host.finish(None).unwrap();
    for view in output.projection.views.values_mut() {
        view.room.delivery = Some(piik_channel_core::wire::RoomDelivery {
            host_session_id: Uuid::new_v4(),
            binding_id: Uuid::new_v4(),
            next_hops: BTreeMap::from([(Uuid::new_v4(), Uuid::new_v4())]),
        });
    }
    let completed = review_host_turn(&mut core, b, "concurrent-review", output);
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
    let delivery = state
        .channel
        .rooms
        .iter()
        .find(|room| room.id == "concurrent-review")
        .unwrap()
        .delivery
        .as_ref()
        .unwrap();
    assert_eq!(delivery.binding_id, domain_binding);
    assert_eq!(delivery.host_session_id, bs);
    assert!(
        delivery.next_hops.is_empty(),
        "room-provided delivery fields cannot forge domain binding or routes"
    );
    assert!(state.publications.iter().any(|p|p.id==publication),"acknowledged capture vanished because an unrelated ordinary room command advanced revision");
}

#[test]
fn host_projection_rejects_conflicting_flow_identity_and_input_ownership() {
    use piik_channel_core::{
        wire::{Event, Request},
        Authority,
    };
    for conflict in [
        "cross_room_id",
        "same_room_id",
        "two_selected",
        "two_candidates",
        "candidate_without_selected",
    ] {
        let mut core = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
        let source = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let source_session = review_admit(&mut core, source, "invite");
        review_admit(&mut core, viewer, "invite");
        let state = core
            .handle(
                source,
                Request {
                    request_id: None,
                    command: Command::SetName {
                        name: "Source".into(),
                    },
                },
                0,
            )
            .events
            .into_iter()
            .find_map(|(_, e)| {
                if let Event::State { state } = e {
                    Some(state)
                } else {
                    None
                }
            })
            .unwrap();
        let user = state
            .sessions
            .iter()
            .find(|s| s.id == source_session)
            .unwrap()
            .user_id;
        let mut original_flow = None;
        let mut original_pairs: Option<serde_json::Value> = None;
        for room in ["first-review", "second-review"] {
            let mut host = RoomHost::new(
                RoomState::new(
                    room.into(),
                    room.into(),
                    Default::default(),
                    user,
                    RoomAccess::Public,
                    false,
                    None,
                )
                .unwrap(),
            );
            let input = review_register(&mut core, source, &host);
            host.dispatch(input).unwrap();
            review_host_turn(&mut core, source, room, host.finish(None).unwrap());
            let publication = Uuid::new_v4();
            for (connection, command) in [
                (
                    source,
                    Command::Publish {
                        publication: PublicationInput {
                            id: publication,
                            room_id: room.into(),
                            kind: Kind::Screen,
                            muted: false,
                        },
                    },
                ),
                (
                    viewer,
                    Command::Subscribe {
                        publication_id: publication,
                        enabled: true,
                    },
                ),
            ] {
                let effects = core.handle(
                    connection,
                    Request {
                        request_id: None,
                        command,
                    },
                    1,
                );
                let input = effects
                    .events
                    .into_iter()
                    .find_map(|(_, event)| {
                        if let Event::HostInput { input, .. } = event {
                            Some(input)
                        } else {
                            None
                        }
                    })
                    .unwrap();
                host.dispatch(input).unwrap();
                let mut output = host.finish(None).unwrap();
                if room == "second-review" && !output.projection.flows.is_empty() {
                    let flows = &mut output.projection.flows;
                    match conflict {
                        "cross_room_id" => flows[0].id = original_flow.unwrap(),
                        "same_room_id" => flows.push(flows[0].clone()),
                        "two_selected" => {
                            let mut duplicate = flows[0].clone();
                            duplicate.id = Uuid::new_v4();
                            flows.push(duplicate);
                        }
                        "two_candidates" => {
                            for _ in 0..2 {
                                let mut candidate = flows[0].clone();
                                candidate.id = Uuid::new_v4();
                                candidate.selected = false;
                                flows.push(candidate);
                            }
                        }
                        "candidate_without_selected" => flows[0].selected = false,
                        _ => unreachable!(),
                    }
                    let effects = review_host_turn(&mut core, source, room, output);
                    assert!(effects.events.iter().any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "invalid_room_projection")), "invalid flow ownership must be rejected: {conflict}");
                    let state = core
                        .handle(
                            source,
                            Request {
                                request_id: None,
                                command: Command::SetName {
                                    name: "Source".into(),
                                },
                            },
                            2,
                        )
                        .events
                        .into_iter()
                        .find_map(|(target, e)| {
                            if let Event::State { state } = e {
                                (target == source).then_some(state)
                            } else {
                                None
                            }
                        })
                        .unwrap();
                    assert_eq!(
                        serde_json::to_value(&state.pairs).unwrap(),
                        original_pairs.as_ref().unwrap().clone(),
                        "rejected projection must preserve the original shared pair and flow"
                    );
                    break;
                }
                let effects = review_host_turn(&mut core, source, room, output.clone());
                if room == "first-review" && !output.projection.flows.is_empty() {
                    original_flow = Some(output.projection.flows[0].id);
                    original_pairs = effects.events.into_iter().find_map(|(target, event)| {
                        if let Event::State { state } = event {
                            (target == source).then(|| serde_json::to_value(state.pairs).unwrap())
                        } else {
                            None
                        }
                    });
                }
            }
        }
    }
}

#[test]
fn host_projection_keeps_shadow_lineage_owned_and_promotes_the_same_leases() {
    use piik_channel_core::{
        wire::{Event, Request},
        Authority,
    };

    fn state(core: &mut Authority, connection: Uuid) -> piik_channel_core::wire::Snapshot {
        core.handle(
            connection,
            Request {
                request_id: None,
                command: Command::SetName {
                    name: "Review".into(),
                },
            },
            1,
        )
        .events
        .into_iter()
        .find_map(|(target, event)| match event {
            Event::State { state } if target == connection => Some(state),
            _ => None,
        })
        .unwrap()
    }

    fn output(
        core: &mut Authority,
        connection: Uuid,
        host: &mut RoomHost,
        command: Command,
    ) -> piik_channel_core::host::HostOutput {
        let input = core
            .handle(
                connection,
                Request {
                    request_id: None,
                    command,
                },
                1,
            )
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::HostInput { input, .. } => Some(input),
                _ => None,
            })
            .unwrap();
        host.dispatch(input).unwrap();
        host.finish(None).unwrap()
    }

    for case in [
        "shadow",
        "promotion",
        "fresh_lineage",
        "source_descriptor",
        "missing_input",
        "other_publication",
        "wrong_sender",
        "false_origin",
        "selected_borrows_shadow",
        "two_shadow_roots",
        "shadow_cycle",
        "selected_cycle",
        "shadow_uses_own_old_branch",
        "source_receives_itself",
        "live_publication",
        "live_sender",
        "live_receiver",
        "live_input",
    ] {
        let mut core = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
        let connections: [Uuid; 4] = std::array::from_fn(|_| Uuid::new_v4());
        let [source, relay, branch, viewer] =
            connections.map(|connection| review_admit(&mut core, connection, "invite"));
        let source_user = state(&mut core, connections[0])
            .sessions
            .iter()
            .find(|session| session.id == source)
            .unwrap()
            .user_id;
        let room_id = "lineage-review";
        let mut host = RoomHost::new(
            RoomState::new(
                room_id.into(),
                "Lineage".into(),
                Default::default(),
                source_user,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        let input = review_register(&mut core, connections[0], &host);
        let relay_user = input.endpoints[&relay].member.user_id;
        host.dispatch(input).unwrap();
        review_host_turn(
            &mut core,
            connections[0],
            room_id,
            host.finish(None).unwrap(),
        );

        let publication = Uuid::new_v4();
        let mut published = output(
            &mut core,
            connections[0],
            &mut host,
            Command::Publish {
                publication: PublicationInput {
                    id: publication,
                    room_id: room_id.into(),
                    kind: Kind::Screen,
                    muted: false,
                },
            },
        );
        published.projection.flows = serde_json::from_value(serde_json::json!([{
            "id": Uuid::new_v4(), "publicationId": publication,
            "sender": source, "receiver": relay, "inputFlowId": null, "selected": true,
        }]))
        .unwrap();
        let first = published.projection.flows[0].clone();
        let leg = |sender, receiver, input_flow_id, selected| {
            let mut flow = first.clone();
            flow.id = Uuid::new_v4();
            flow.sender = sender;
            flow.receiver = receiver;
            flow.input_flow_id = input_flow_id;
            flow.selected = selected;
            flow
        };
        let second = leg(relay, branch, Some(first.id), true);
        let third = leg(branch, viewer, Some(second.id), true);
        published.projection.flows = vec![first.clone(), second.clone(), third.clone()];
        let accepted = review_host_turn(&mut core, connections[0], room_id, published);
        assert!(!accepted
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::Error { .. })));
        let original = serde_json::to_value(state(&mut core, connections[2]).pairs).unwrap();

        let mut prepared = output(
            &mut core,
            connections[0],
            &mut host,
            Command::Browse {
                room_id: room_id.into(),
                active: true,
            },
        );
        let root = leg(source, branch, None, false);
        let child = leg(branch, viewer, Some(root.id), false);
        prepared.projection.flows = vec![
            first.clone(),
            second.clone(),
            third.clone(),
            root.clone(),
            child.clone(),
        ];
        let other_publication = Uuid::new_v4();
        if matches!(case, "other_publication" | "live_publication") {
            for view in prepared.projection.views.values_mut() {
                let mut other = view.publications[0].clone();
                other.id = other_publication;
                other.kind = Kind::Voice;
                view.publications.push(other);
            }
        }
        let flows = &mut prepared.projection.flows;
        match case {
            "source_descriptor" => {
                let publication = &mut prepared
                    .projection
                    .views
                    .get_mut(&viewer)
                    .unwrap()
                    .publications[0];
                publication.session_id = relay;
                publication.user_id = relay_user;
            }
            "missing_input" => flows[4].input_flow_id = Some(Uuid::new_v4()),
            "other_publication" => {
                let mut foreign = leg(source, branch, None, true);
                foreign.publication_id = other_publication;
                flows[4].input_flow_id = Some(foreign.id);
                flows.push(foreign);
            }
            "wrong_sender" => flows[4].input_flow_id = Some(first.id),
            "false_origin" => flows[4].input_flow_id = None,
            "selected_borrows_shadow" => {
                flows[2].id = Uuid::new_v4();
                flows[2].input_flow_id = Some(root.id);
            }
            "two_shadow_roots" => {
                flows[4].sender = source;
                flows[4].input_flow_id = None;
            }
            "shadow_cycle" => {
                flows[3].sender = viewer;
                flows[3].input_flow_id = Some(child.id);
            }
            "selected_cycle" => {
                for flow in &mut flows[..3] {
                    flow.id = Uuid::new_v4();
                }
                flows[0].sender = branch;
                flows[0].input_flow_id = Some(flows[1].id);
                flows[1].input_flow_id = Some(flows[0].id);
                flows[2].input_flow_id = Some(flows[1].id);
            }
            "shadow_uses_own_old_branch" => {
                flows[3].sender = viewer;
                flows[3].input_flow_id = Some(third.id);
            }
            "source_receives_itself" => flows.push(leg(relay, source, Some(first.id), true)),
            "live_publication" => {
                for flow in flows {
                    flow.publication_id = other_publication;
                }
            }
            "live_sender" => {
                flows[1].sender = source;
                flows[1].input_flow_id = None;
            }
            "live_receiver" => {
                flows[1].receiver = viewer;
                flows[2].sender = viewer;
                flows[2].receiver = branch;
            }
            "live_input" | "fresh_lineage" => {
                flows[1].id = Uuid::new_v4();
                flows[2].input_flow_id = Some(flows[1].id);
                if case == "fresh_lineage" {
                    flows[2].id = Uuid::new_v4();
                }
            }
            "shadow" | "promotion" => {}
            _ => unreachable!(),
        }
        let effects = review_host_turn(&mut core, connections[0], room_id, prepared);
        if !matches!(case, "shadow" | "promotion" | "fresh_lineage") {
            assert!(effects.events.iter().any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "invalid_room_projection")), "accepted invalid lineage: {case}");
            assert_eq!(
                serde_json::to_value(state(&mut core, connections[2]).pairs).unwrap(),
                original,
                "invalid {case} changed admitted transports"
            );
            continue;
        }
        assert!(
            !effects
                .events
                .iter()
                .any(|(_, event)| matches!(event, Event::Error { .. })),
            "rejected valid lineage: {case}"
        );
        let before = state(&mut core, connections[2]);
        let carriers: BTreeMap<_, _> = before
            .pairs
            .iter()
            .flat_map(|pair| {
                pair.incoming
                    .iter()
                    .chain(&pair.outgoing)
                    .filter(|flow| flow.id == root.id || flow.id == child.id)
                    .map(|flow| (flow.id, pair.id))
            })
            .collect();
        assert_eq!(
            carriers.len(),
            2,
            "the complete shadow branch must be admitted"
        );
        if case == "promotion" {
            let mut committed = output(
                &mut core,
                connections[0],
                &mut host,
                Command::Browse {
                    room_id: room_id.into(),
                    active: false,
                },
            );
            committed.projection.flows = vec![root, child];
            for flow in &mut committed.projection.flows {
                flow.selected = true;
            }
            let effects = review_host_turn(&mut core, connections[0], room_id, committed);
            assert!(!effects
                .events
                .iter()
                .any(|(_, event)| matches!(event, Event::Error { .. })));
            let after = state(&mut core, connections[2]);
            let promoted: BTreeMap<_, _> = after
                .pairs
                .iter()
                .flat_map(|pair| {
                    pair.incoming.iter().chain(&pair.outgoing).map(|flow| {
                        assert!(flow.selected);
                        (flow.id, pair.id)
                    })
                })
                .collect();
            assert_eq!(
                promoted, carriers,
                "commit must retain both proven physical carriers"
            );
        }
    }
}
