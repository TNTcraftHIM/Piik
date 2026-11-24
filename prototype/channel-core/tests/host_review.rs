use piik_channel_core::{
    host::{HostAction, HostInput, RequestContext, RoomHost},
    wire::{Command, Kind, PublicationInput, RoomAccess, VideoCeiling, VideoResolution},
    Endpoint, Member, RoomState,
};
use std::collections::BTreeMap;
use uuid::Uuid;

#[test]
fn storage_abort_does_not_restore_activity_retired_by_current_domain_endpoints() {
    let owner = Member {
        user_id: Uuid::new_v4(),
    };
    let viewer = owner; // Another endpoint of the room creator can still commit policy.
    let publisher = Uuid::new_v4();
    let reader = Uuid::new_v4();
    let publication = Uuid::new_v4();
    let binding = Uuid::new_v4();
    let mut endpoints = BTreeMap::from([
        (
            publisher,
            Endpoint {
                member: owner,
                can_use_peer_transport: true,
                connected: true,
                signing_key: piik_channel_core::conversation::SessionSigner::from_seed([1; 32])
                    .signing_key(),
            },
        ),
        (
            reader,
            Endpoint {
                member: viewer,
                can_use_peer_transport: true,
                connected: true,
                signing_key: piik_channel_core::conversation::SessionSigner::from_seed([2; 32])
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
        hosting_mode: Default::default(),
        channel_owner_id: Uuid::nil(),
        service_endpoint: None,
        now: 0,
        binding_id: binding,
        host_session_id: publisher,
        revision: 1,
        confirmed_pairs: Default::default(),
        failed_pairs: Vec::new(),
        endpoints: endpoints.clone(),
        action: HostAction::Command {
            context: context(publisher),
            command: Command::Publish {
                publication: PublicationInput {
                    source: Some(Default::default()),
                    id: publication,
                    room_id: "review".into(),
                    kind: Kind::Screen,
                    video_settings: Some(piik_channel_core::wire::VideoSettings {
                        degradation_preference:
                            piik_channel_core::wire::DegradationPreference::Balanced,
                        ceiling: VideoCeiling {
                            resolution: VideoResolution {
                                width: 1280,
                                height: 720,
                            },
                            max_framerate: 29.97,
                            max_bitrate: 2500000,
                        },
                    }),
                },
            },
        },
    })
    .unwrap();
    assert_eq!(host.finish(None).unwrap().projection.publications.len(), 1);
    endpoints.remove(&publisher);
    let work = host
        .dispatch(HostInput {
            hosting_mode: Default::default(),
            channel_owner_id: Uuid::nil(),
            service_endpoint: None,
            now: 0,
            binding_id: binding,
            host_session_id: publisher,
            revision: 2,
            confirmed_pairs: Default::default(),
            failed_pairs: Vec::new(),
            endpoints,
            action: HostAction::Command {
                context: context(reader),
                command: Command::UpdateRoom {
                    room_id: "review".into(),
                    name: Some("Updated".into()),
                    icon: Default::default(),
                    picture: None,
                    access: None,
                    hidden: None,
                    password: None,
                    voice_bitrate: None,
                    relay_capacity: None,
                    allow_service_relay: Some(true),
                },
            },
        })
        .unwrap();
    assert!(work.policy.is_some());
    let output = host.abort("storage_failed".into()).unwrap();
    assert!(
        !host.policy().allow_service_relay,
        "a failed policy commit must roll back the saved choice"
    );
    assert!(
        output.projection.publications.is_empty(),
        "storage failure restored the expired publisher's retired activity"
    );
    assert!(output.projection.flows.is_empty());
}

fn review_admit(core: &mut piik_channel_core::Authority, connection: Uuid, key: &str) -> Uuid {
    core.handle(
        connection,
        piik_channel_core::wire::Request::parse(
            &serde_json::json!({"type":"join","canUsePeerTransport":true,"protocol":piik_channel_core::wire::CHANNEL_PROTOCOL,"signingKey":piik_channel_core::conversation::SessionSigner::from_seed([1; 32]).signing_key(),"name":"Review","ownerKey":(key=="owner").then_some(key)}).to_string(),
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
            command: Command::AdmitRoom {
                room: host.summary(),
            },
        },
        0,
    );
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
fn pending_room_request_finishes_when_its_host_binding_retires() {
    use piik_channel_core::{
        host::RoomResult,
        wire::{Event, Request},
        Authority, RECOVERY_MS,
    };
    for case in [
        "stop",
        "leave",
        "expire",
        "rebind",
        "resume",
        "requester-replaced",
    ] {
        let mut core = Authority::new("owner".into(), vec![]).unwrap();
        let owner = Uuid::new_v4();
        let reader = Uuid::new_v4();
        review_admit(&mut core, owner, "owner");
        let joined = core.handle(reader, Request::parse(&serde_json::json!({
            "type":"join","canUsePeerTransport":true,"protocol":piik_channel_core::wire::CHANNEL_PROTOCOL, "name":"Reader", "signingKey":piik_channel_core::conversation::SessionSigner::from_seed([2; 32]).signing_key()
        }).to_string()).unwrap(), 0);
        let (reader_session, credential) = joined
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::Welcome {
                    session_id,
                    credential,
                    ..
                } => Some((session_id, credential)),
                _ => None,
            })
            .unwrap();
        let publisher = Uuid::new_v4();
        let publisher_session = review_admit(&mut core, publisher, "friend");
        let room_id = "retiring-host";
        let mut host = RoomHost::new(
            RoomState::new(
                room_id.into(),
                "Retirement".into(),
                Default::default(),
                core.identity().1,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        let input = review_register(&mut core, owner, &host);
        let binding = input.binding_id;
        let publisher_user = input.endpoints[&publisher_session].member.user_id;
        host.dispatch(input).unwrap();
        let mut initial = host.finish(None).unwrap();
        let publication = Uuid::new_v4();
        initial.projection.publications.push(piik_channel_core::wire::PublicationInfo {
            id: publication, room_id: room_id.into(), session_id: publisher_session,
            user_id: publisher_user, kind: Kind::Screen, paused: false,
            screen: Some(piik_channel_core::wire::ScreenInfo { predecessor: None, direct_limit: None, source: Default::default(), title: None }),
            video_settings: Some(serde_json::from_value(serde_json::json!({"ceiling":{"resolution":{"width":640,"height":360},"maxFramerate":30,"maxBitrate":1000000},"degradationPreference":"balanced"})).unwrap()),
            audience: vec![piik_channel_core::wire::PublicationAudience { session_id: reader_session, state: piik_channel_core::wire::AudienceState::Failed }],
        });
        let recipient = initial.projection.views.get_mut(&reader_session).unwrap();
        recipient.subscriptions.push(publication);
        recipient.failed_subscriptions.push(publication);
        recipient
            .files
            .push(piik_channel_core::file_room::FilePlan {
                author_id: Uuid::new_v4(),
                room_id: room_id.into(),
                message_seq: 1,
                attachment: piik_channel_core::AttachmentDescriptor {
                    id: Uuid::new_v4(),
                    name: "waiting.bin".into(),
                    media_type: "application/octet-stream".into(),
                    size: 1,
                    sha256: "0".repeat(64),
                },
                source_id: None,
                upstream: None,
                downstream: vec![],
                receiving: true,
            });
        let accepted = review_host_turn(&mut core, owner, room_id, initial);
        assert!(!accepted
            .events
            .iter()
            .any(|(_, event)| matches!(event, Event::Error { .. })));
        if case == "stop" {
            let mut retired_source = core.clone();
            let retired = retired_source.handle(
                publisher,
                Request {
                    request_id: None,
                    command: Command::Leave,
                },
                1,
            );
            let state = retired
                .events
                .iter()
                .find_map(|(target, event)| match event {
                    Event::State { state } if *target == reader => Some(state),
                    _ => None,
                })
                .unwrap();
            assert!(
                state.publications.is_empty()
                    && state.subscriptions.is_empty()
                    && state.failed_subscriptions.is_empty()
            );
        }

        let pending = core.handle(
            reader,
            Request {
                request_id: Some("preflight-enter".into()),
                command: Command::EnterRoom {
                    room_id: room_id.into(),
                    password: None,
                    invite_key: None,
                },
            },
            1,
        );
        let input = pending
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                Event::HostInput { input, .. } => Some(input),
                _ => None,
            })
            .unwrap();
        host.dispatch(input).unwrap();
        let delayed = host.finish(None).unwrap();

        let replacement = Uuid::new_v4();
        if case == "requester-replaced" {
            core.handle(replacement, Request::parse(&serde_json::json!({
                "type":"join","canUsePeerTransport":true,"protocol":piik_channel_core::wire::CHANNEL_PROTOCOL, "name":"Reader", "credential":credential, "sessionId":reader_session,
                "signingKey":piik_channel_core::conversation::SessionSigner::from_seed([2; 32]).signing_key()
            }).to_string()).unwrap(), 2);
        }
        let effects = match case {
            "leave" => core.handle(
                owner,
                Request {
                    request_id: None,
                    command: Command::Leave,
                },
                2,
            ),
            "expire" => {
                let grace = core.disconnect(owner, 2);
                let state = grace
                    .events
                    .iter()
                    .find_map(|(target, event)| match event {
                        Event::State { state } if *target == reader => Some(state),
                        _ => None,
                    })
                    .unwrap();
                assert_eq!(state.files.len(), 1);
                assert_eq!(state.failed_subscriptions, vec![publication]);
                core.expire(RECOVERY_MS + 2)
            }
            "rebind" | "resume" => core.handle(
                owner,
                Request {
                    request_id: None,
                    command: Command::HostRegister {
                        room: host.summary(),
                        resume_binding: (case == "resume").then_some(binding),
                    },
                },
                2,
            ),
            _ => core.handle(
                owner,
                Request {
                    request_id: None,
                    command: Command::HostStop {
                        room_id: room_id.into(),
                        binding_id: binding,
                    },
                },
                2,
            ),
        };
        if matches!(case, "stop" | "leave" | "expire" | "rebind") {
            let state = effects
                .events
                .iter()
                .find_map(|(target, event)| match event {
                    Event::State { state } if *target == reader => Some(state),
                    _ => None,
                })
                .unwrap();
            assert!(
                state.publications.is_empty()
                    && state.files.is_empty()
                    && state.failed_subscriptions.is_empty(),
                "{case} retained retired activity"
            );
        }
        let replies: Vec<_> = effects
            .events
            .iter()
            .filter(|(_, event)| {
                matches!(event,
            Event::RoomReply { request_id: Some(id), .. } if id == "preflight-enter")
            })
            .collect();
        if case == "requester-replaced" {
            assert!(
                replies.is_empty(),
                "retired request was redirected to a new connection"
            );
        } else {
            assert_eq!(replies.len(), 1, "{case} left its room request pending");
            assert!(
                matches!(replies[0], (target, Event::RoomReply { room_id: id,
                result: RoomResult::Error { code }, .. })
                if *target == reader && id == room_id && code == "room_context_changed")
            );
        }
        let late = review_host_turn(&mut core, owner, room_id, delayed);
        assert!(
            !late.events.iter().any(|(target, event)| (*target == reader
                || *target == replacement)
                && matches!(event,
                Event::RoomReply { request_id: Some(id), .. } if id == "preflight-enter")),
            "{case} completed a retired request from late host output"
        );
    }
}

#[test]
fn room_host_cannot_complete_an_unissued_other_room_request() {
    use piik_channel_core::{
        host::{RoomReply, RoomResult},
        wire::Event,
        Authority,
    };
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let b_session = review_admit(&mut core, b, "owner");
    let c_session = review_admit(&mut core, c, "invite");
    let b_user = core
        .handle(
            b,
            piik_channel_core::wire::Request {
                request_id: None,
                command: Command::SetProfile {
                    avatar: Some(None),
                    name: Some("B".into()),
                },
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
fn room_entry_waits_for_commit_without_blocking_site_identity() {
    use piik_channel_core::{
        wire::{Event, Request},
        Authority,
    };
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let bs = review_admit(&mut core, b, "owner");
    let bu = core
        .handle(
            b,
            Request {
                request_id: None,
                command: Command::SetProfile {
                    avatar: Some(None),
                    name: Some("B".into()),
                },
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
    let binding = input.binding_id;
    host.dispatch(input).unwrap();
    review_host_turn(&mut core, b, "private-review", host.finish(None).unwrap());
    review_admit(&mut core, c, "invite");
    let effects = core.handle(
        c,
        Request::parse(
            &serde_json::json!({
                "type":"enter_room","roomId":"private-review","inviteKey":key,"requestId":"entry"
            })
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
    assert!(host.dispatch(input).unwrap().policy.is_some());
    let effects = core.handle(
        c,
        Request {
            request_id: Some("rename".into()),
            command: Command::SetProfile {
                avatar: Some(None),
                name: Some("Still connected".into()),
            },
        },
        2,
    );
    assert!(effects
        .events
        .iter()
        .any(|(target, e)| *target == c
            && matches!(e,Event::Ack{request_id} if request_id=="rename")));
    let stopped = core.handle(
        b,
        Request {
            request_id: None,
            command: Command::HostStop {
                room_id: "private-review".into(),
                binding_id: binding,
            },
        },
        3,
    );
    assert!(!stopped.close.contains(&c));
    assert!(stopped.events.iter().any(|(target,e)| *target==c && matches!(e,
        Event::RoomReply { request_id:Some(id), result:piik_channel_core::host::RoomResult::Error { code }, .. } if id=="entry" && code=="room_context_changed")));
}

#[test]
fn successful_publish_projection_survives_a_later_queued_ordinary_command() {
    use piik_channel_core::{
        wire::{Event, Request},
        Authority,
    };
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    let bs = review_admit(&mut core, b, "owner");
    review_admit(&mut core, c, "invite");
    let bu = core
        .handle(
            b,
            Request {
                request_id: None,
                command: Command::SetProfile {
                    avatar: Some(None),
                    name: Some("B".into()),
                },
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
                    source: Some(Default::default()),
                    id: publication,
                    room_id: "concurrent-review".into(),
                    kind: Kind::Screen,
                    video_settings: Some(piik_channel_core::wire::VideoSettings {
                        degradation_preference:
                            piik_channel_core::wire::DegradationPreference::Balanced,
                        ceiling: VideoCeiling {
                            resolution: VideoResolution {
                                width: 1280,
                                height: 720,
                            },
                            max_framerate: 29.97,
                            max_bitrate: 2500000,
                        },
                    }),
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
                relay_capacity: None,
            },
        },
        1,
    );
    assert!(queued
        .events
        .iter()
        .any(|(_, e)| matches!(e, Event::HostInput { .. })));
    host.dispatch(input).unwrap();
    let output = host.finish(None).unwrap();
    let mut forged_delete = output.clone();
    forged_delete.reply.as_mut().unwrap().result =
        piik_channel_core::host::RoomResult::Deleted { data_removed: true };
    let rejected = review_host_turn(&mut core, b, "concurrent-review", forged_delete);
    assert!(rejected.events.iter().any(
        |(_, event)| matches!(event, Event::Error { code, .. } if code == "invalid_room_reply")
    ));
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
            command: Command::SetProfile {
                avatar: Some(None),
                name: Some("C".into()),
            },
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
    assert!(state.publications.iter().any(|p|p.id==publication),"acknowledged capture vanished because an unrelated ordinary room command advanced revision");
}

// Each carrier has two room readers. Confirm the actual pairs that the scheduler admits.
fn review_confirm_pairs(
    core: &mut piik_channel_core::Authority,
    name: &str,
    endpoints: &[(Uuid, Uuid)],
    edges: &[(usize, usize)],
) {
    use piik_channel_core::wire::{Event, LinkState, Request};
    let sockets: BTreeMap<_, _> = endpoints
        .iter()
        .map(|(socket, id)| (*id, *socket))
        .collect();
    for &(a, b) in edges {
        let room = format!("{name}-{a}-{b}");
        let mut host = RoomHost::new(
            RoomState::new(
                room.clone(),
                room.clone(),
                Default::default(),
                core.identity().1,
                RoomAccess::Public,
                false,
                None,
            )
            .unwrap(),
        );
        host.dispatch(review_register(core, endpoints[0].0, &host))
            .unwrap();
        let mut output = host.finish(None).unwrap();
        output.projection.participant_session_ids = vec![endpoints[a].1, endpoints[b].1];
        for reader in [a, b] {
            output
                .projection
                .views
                .get_mut(&endpoints[reader].1)
                .unwrap()
                .reading = true;
        }
        let mut events = review_host_turn(core, endpoints[0].0, &room, output).events;
        let mut confirmed = std::collections::BTreeSet::new();
        loop {
            let mut reports = vec![];
            for (socket, event) in events {
                let Event::State { state } = event else {
                    continue;
                };
                for pair in state.pairs {
                    if confirmed.insert(pair.id) {
                        reports.push((pair.id, socket, sockets[&pair.peer_id]));
                    }
                }
            }
            if reports.is_empty() {
                break;
            }
            events = vec![];
            for (id, left, right) in reports {
                for socket in [left, right] {
                    events.extend(
                        core.handle(
                            socket,
                            Request {
                                request_id: None,
                                command: Command::LinkState {
                                    pair_id: id,
                                    state: LinkState::Connected,
                                },
                            },
                            1,
                        )
                        .events,
                    );
                }
            }
        }
    }
}

#[test]
fn host_projection_rejects_conflicting_flow_identity_and_audience_scope() {
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
        "audience_unknown",
        "audience_duplicate",
        "publication_duplicate",
        "members_nonmanager",
        "manager_wrong_user",
        "unauthorized_activity",
        "missing_screen_metadata",
        "voice_screen_metadata",
        "long_source_name",
        "long_screen_title",
        "invalid_summary_voice_bitrate",
        "invalid_summary_relay_capacity",
        "invalid_relay_override",
    ] {
        let mut core = Authority::new("owner".into(), vec![]).unwrap();
        let source = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let source_session = review_admit(&mut core, source, "owner");
        let viewer_session = review_admit(&mut core, viewer, "invite");
        let state = core
            .handle(
                source,
                Request {
                    request_id: None,
                    command: Command::SetProfile {
                        avatar: Some(None),
                        name: Some("Source".into()),
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
        review_confirm_pairs(&mut core, "identity-carriers", &[(source,source_session),(viewer,viewer_session)], &[(0,1)]);
        let mut checked_conflict = false;
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
                            source: Some(Default::default()),
                            id: publication,
                            room_id: room.into(),
                            kind: Kind::Screen,
                            video_settings: Some(piik_channel_core::wire::VideoSettings {
                                degradation_preference:
                                    piik_channel_core::wire::DegradationPreference::Balanced,
                                ceiling: VideoCeiling {
                                    resolution: VideoResolution {
                                        width: 1280,
                                        height: 720,
                                    },
                                    max_framerate: 29.97,
                                    max_bitrate: 2500000,
                                },
                            }),
                        },
                    },
                ),
                (
                    viewer,
                    Command::Subscribe {
                        helper_session_id: None,
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
                    checked_conflict = true;
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
                        "invalid_summary_voice_bitrate" => {
                            output.projection.summary.voice_bitrate = 0
                        }
                        "invalid_summary_relay_capacity" => {
                            output.projection.summary.relay_capacity = 21
                        }
                        "invalid_relay_override" => {
                            output
                                .projection
                                .views
                                .get_mut(&viewer_session)
                                .unwrap()
                                .relay_override = Some(21)
                        }
                        "missing_screen_metadata" => {
                            output.projection.publications[0].screen = None
                        }
                        "voice_screen_metadata" => {
                            let publication = &mut output.projection.publications[0];
                            publication.kind = Kind::Voice;
                            publication.video_settings = None;
                            publication.audience.clear();
                        }
                        "long_source_name" => {
                            output.projection.publications[0]
                                .screen
                                .as_mut()
                                .unwrap()
                                .source
                                .name = Some("\u{1f600}".repeat(33))
                        }
                        "long_screen_title" => {
                            output.projection.publications[0]
                                .screen
                                .as_mut()
                                .unwrap()
                                .title = Some("x".repeat(65))
                        }
                        "members_nonmanager" => {
                            output
                                .projection
                                .views
                                .get_mut(&viewer_session)
                                .unwrap()
                                .members = Some(vec![user])
                        }
                        "manager_wrong_user" => {
                            output
                                .projection
                                .views
                                .get_mut(&viewer_session)
                                .unwrap()
                                .can_manage = true
                        }
                        "unauthorized_activity" => {
                            output
                                .projection
                                .views
                                .get_mut(&viewer_session)
                                .unwrap()
                                .authorized = false
                        }
                        "audience_unknown" | "audience_duplicate" | "publication_duplicate" => {
                            let publication = &mut output.projection.publications[0];
                            match conflict {
                                "audience_unknown" => {
                                    publication.audience[0].session_id = Uuid::new_v4()
                                }
                                "audience_duplicate" => {
                                    publication.audience.push(publication.audience[0].clone())
                                }
                                "publication_duplicate" => {
                                    let duplicate = publication.clone();
                                    output.projection.publications.push(duplicate)
                                }
                                _ => unreachable!(),
                            }
                        }
                        _ => unreachable!(),
                    }
                    let effects = review_host_turn(&mut core, source, room, output);
                    assert!(effects.events.iter().any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "invalid_room_projection")), "invalid flow ownership must be rejected: {conflict}");
                    let state = core
                        .handle(
                            source,
                            Request {
                                request_id: None,
                                command: Command::SetProfile {
                                    avatar: Some(None),
                                    name: Some("Source".into()),
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
                    if conflict == "audience_unknown" {
                        let source_view = |effects: piik_channel_core::Effects| {
                            effects
                                .events
                                .into_iter()
                                .find_map(|(target, event)| match event {
                                    Event::State { state } if target == source => Some(state),
                                    _ => None,
                                })
                                .unwrap()
                        };
                        let grace = source_view(core.disconnect(viewer, 3));
                        assert!(grace
                            .publications
                            .iter()
                            .any(|p| p.audience.iter().any(|a| a.session_id == viewer_session)));
                        let retired = source_view(core.expire(piik_channel_core::RECOVERY_MS + 3));
                        assert!(
                            retired.publications.iter().all(|p| p.audience.is_empty()),
                            "domain retirement prunes old host audience before any host Sync reply"
                        );
                    }
                    break;
                }
                let effects = review_host_turn(&mut core, source, room, output.clone());
                if room == "first-review" && !output.projection.flows.is_empty() {
                    for (target, event) in &effects.events {
                        if let Event::State { state } = event {
                            if [source, viewer].contains(target) {
                                let audience = &state
                                    .publications
                                    .iter()
                                    .find(|p| p.id == publication)
                                    .unwrap()
                                    .audience;
                                assert_eq!(
                                    audience,
                                    &vec![piik_channel_core::wire::PublicationAudience {
                                        session_id: viewer_session,
                                        state: piik_channel_core::wire::AudienceState::Preparing,
                                    }]
                                );
                            }
                        }
                    }
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
        assert!(checked_conflict, "missing assigned flow for {conflict}");
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
                command: Command::SetProfile {
                    avatar: Some(None),
                    name: Some("Review".into()),
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
        "retired_input",
        "fresh_lineage",
        "source_descriptor",
        "invalid_ceiling",
        "missing_input",
        "other_publication",
        "wrong_sender",
        "false_origin",
        "selected_borrows_shadow",
        "distinct_shadow_anchors",
        "unconsumed_shadow_transit",
        "shadow_cycle",
        "selected_cycle",
        "shadow_uses_own_old_branch",
        "source_receives_itself",
        "live_publication",
        "live_sender",
        "live_receiver",
        "live_input",
    ] {
        let mut core = Authority::new("owner".into(), vec![]).unwrap();
        let connections: [Uuid; 5] = std::array::from_fn(|_| Uuid::new_v4());
        let [source, relay, branch, viewer, transit] = connections.map(|connection| {
            let key = if connection == connections[0] {
                "owner"
            } else {
                "invite"
            };
            review_admit(&mut core, connection, key)
        });
        let source_user = state(&mut core, connections[0])
            .sessions
            .iter()
            .find(|session| session.id == source)
            .unwrap()
            .user_id;
        let sessions = [source, relay, branch, viewer, transit];
        let endpoints: Vec<_> = connections.into_iter().zip(sessions).collect();
        review_confirm_pairs(&mut core, "selected-carriers", &endpoints, &[(0,1),(1,2),(2,3),(0,4)]);
        review_confirm_pairs(&mut core, "trial-carriers", &endpoints, &[(0,2),(0,1),(1,3)]);
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
        let mut initial = host.finish(None).unwrap();
        if case == "retired_input" {
            initial.projection.participant_session_ids = sessions.to_vec();
        }
        review_host_turn(&mut core, connections[0], room_id, initial);

        let publication = Uuid::new_v4();
        let mut published = output(
            &mut core,
            connections[0],
            &mut host,
            Command::Publish {
                publication: PublicationInput {
                    source: Some(Default::default()),
                    id: publication,
                    room_id: room_id.into(),
                    kind: Kind::Screen,
                    video_settings: Some(piik_channel_core::wire::VideoSettings {
                        degradation_preference:
                            piik_channel_core::wire::DegradationPreference::Balanced,
                        ceiling: VideoCeiling {
                            resolution: VideoResolution {
                                width: 1280,
                                height: 720,
                            },
                            max_framerate: 29.97,
                            max_bitrate: 2500000,
                        },
                    }),
                },
            },
        );
        published.projection.flows = serde_json::from_value(serde_json::json!([{
            "id": Uuid::new_v4(), "publicationId": publication,
            "sender": source, "receiver": relay, "inputFlowId": null, "selected": true,
            "proof": null, "presented": null, "presentation": false,
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
        if case == "retired_input" {
            let healthy = leg(source, transit, None, true);
            published.projection.flows.push(healthy.clone());
            let watch = Uuid::new_v4();
            let byte_source = serde_json::json!({"sessionId":source, "resourceId":Uuid::new_v4(),"format":"file"});
            published.projection.watch_activities = serde_json::from_value(serde_json::json!([{
                "id":watch,"roomId":room_id,"userId":source_user,"sessionId":source,
                "source":{"kind":"media","url":"https://example.com/clip.mp4"},
                "playback":{"timeline":"media","position":0.0,"paused":false,"rate":1.0,"anchorTime":1},
                "viewerSessionIds":[viewer,transit],"byteSource":byte_source
            }])).unwrap();
            published.projection.participant_session_ids = sessions.to_vec();
            let attachment = serde_json::json!({"id":Uuid::new_v4(),"name":"fixture.bin","size":3,
                "mediaType":"application/octet-stream","sha256":"a".repeat(64)});
            for (session, parent, children) in [
                (source,None,vec![relay,transit]), (relay,Some(source),vec![branch]),
                (branch,Some(relay),vec![viewer]), (viewer,Some(branch),vec![]), (transit,Some(source),vec![]),
            ] {
                let view = published.projection.views.get_mut(&session).unwrap();
                let receiving = session == viewer || session == transit;
                if receiving {
                    view.watch_subscriptions = serde_json::from_value(serde_json::json!([{"id":watch,"mode":"peer"}])).unwrap();
                }
                view.watch_bytes = serde_json::from_value(serde_json::json!([{
                    "roomId":room_id,"activityId":watch,"source":byte_source,"upstream":parent,
                    "downstream":children,"receiving":receiving
                }])).unwrap();
                view.files = serde_json::from_value(serde_json::json!([{
                    "roomId":room_id,"messageSeq":1,"authorId":source_user,"attachment":attachment,
                    "sourceId":source,"upstream":parent,"downstream":children,"receiving":receiving
                }])).unwrap();
            }
            // The host's prepared three-hop path is in flight when its first carrier fails.
            let carrier = state(&mut core, connections[0]).pairs.into_iter()
                .find(|p| p.peer_id == relay).unwrap().id;
            core.handle(connections[0], Request { request_id: None, command: Command::LinkState {
                pair_id: carrier, state: piik_channel_core::wire::LinkState::Failed,
            }}, 1);
            let mut invalid = published.clone();
            invalid.projection.views.get_mut(&relay).unwrap().watch_bytes[0].upstream = Some(branch);
            assert!(review_host_turn(&mut core, connections[0], room_id, invalid).events.iter()
                .any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "invalid_room_projection")));
            let result = review_host_turn(&mut core, connections[0], room_id, published);
            assert!(result.events.iter().any(|(_, e)| matches!(e, Event::HostInput { room_id: room, input }
                if room == room_id && input.failed_pairs.iter().any(|failure|
                    (failure.first, failure.second) == (source.min(relay), source.max(relay))))));
            for socket in connections {
                let snapshot = state(&mut core, socket);
                let targets: Vec<_> = snapshot.pairs.iter().filter(|p| p.rooms.iter().any(|r| r == room_id)).map(|p| p.peer_id).collect();
                if socket == connections[0] || socket == connections[4] {
                    assert_eq!(targets, [if socket == connections[0] { transit } else { source }]);
                } else {
                    assert!(targets.is_empty());
                }
                if socket == connections[3] || socket == connections[4] {
                    let file = &snapshot.files[0];
                    let plan = &snapshot.watch_bytes[0];
                    let parent = (socket == connections[4]).then_some(source);
                    assert!(file.receiving && plan.receiving);
                    assert_eq!((file.source_id,file.upstream), (Some(source),parent));
                    assert_eq!((plan.source.session_id,plan.upstream), (source,parent));
                }
                let grants: Vec<_> = snapshot.pairs.iter().flat_map(|p| p.incoming.iter().chain(&p.outgoing))
                    .filter(|f| f.publication_id == publication).map(|f| f.id).collect();
                if socket == connections[0] || socket == connections[4] {
                    assert_eq!(grants, [healthy.id]);
                } else {
                    assert!(grants.is_empty());
                }
            }
            continue;
        }
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
                relay_capacity: None,
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
            let mut other = prepared.projection.publications[0].clone();
            other.id = other_publication;
            other.kind = Kind::Voice;
            other.video_settings = None;
            other.screen = None;
            other.audience.clear();
            prepared.projection.publications.push(other);
        }
        let flows = &mut prepared.projection.flows;
        match case {
            "invalid_ceiling" => {
                prepared.projection.publications[0]
                    .video_settings
                    .as_mut()
                    .unwrap()
                    .ceiling
                    .max_bitrate = 0;
            }
            "source_descriptor" => {
                let publication = &mut prepared.projection.publications[0];
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
            "distinct_shadow_anchors" => {
                flows[4].sender = relay;
                flows[4].input_flow_id = Some(first.id);
            }
            "unconsumed_shadow_transit" => flows.push(leg(source, transit, None, false)),
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
                    relay_capacity: None,
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

#[test]
fn host_output_requires_current_pairs_for_new_media_and_scopes_screen_helpers() {
    use piik_channel_core::wire::{Event, LinkState, Request};
    use serde_json::json;
    let mut core = piik_channel_core::Authority::new("owner".into(), vec![]).unwrap();
    let [writer, reader] = [Uuid::new_v4(), Uuid::new_v4()];
    let source = review_admit(&mut core, writer, "owner");
    let signer = piik_channel_core::conversation::SessionSigner::from_seed([2; 32]).signing_key();
    let join_reader = |core: &mut piik_channel_core::Authority,
                       socket,
                       credential: Option<String>,
                       resume: Option<Uuid>| {
        core.handle(
            socket,
            Request::parse(
                &json!({"type":"join","canUsePeerTransport":true,"protocol":piik_channel_core::wire::CHANNEL_PROTOCOL,
            "name":"Viewer","signingKey":signer,"credential":credential,"sessionId":resume})
                .to_string(),
            )
            .unwrap(),
            1,
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::Welcome {
                session_id,
                credential,
                ..
            } => Some((session_id, credential)),
            _ => None,
        })
        .unwrap()
    };
    let (viewer, credential) = join_reader(&mut core, reader, None, None);
    let helper_socket = Uuid::new_v4();
    let (helper, _) = join_reader(&mut core, helper_socket, Some(credential.clone()), None);
    let room = "media-grants";
    let mut host = RoomHost::new(
        RoomState::new(
            room.into(),
            "Media grants".into(),
            Default::default(),
            core.identity().1,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap(),
    );
    let input = review_register(&mut core, writer, &host);
    host.dispatch(input).unwrap();
    let mut output = host.finish(None).unwrap();
    let publication = Uuid::new_v4();
    output.projection.publications = serde_json::from_value(json!([{
        "id":publication,"roomId":room,"sessionId":source,"userId":core.identity().1,
        "kind":"screen","paused":false,"audience":[],"source":{"kind":"screen"}
    }]))
    .unwrap();
    output
        .projection
        .views
        .get_mut(&viewer)
        .unwrap()
        .subscriptions
        .push(publication);
    output.projection.participant_session_ids = vec![source, viewer];
    output
        .projection
        .views
        .get_mut(&viewer)
        .unwrap()
        .screen_helpers
        .insert(publication, helper);
    let effects = review_host_turn(&mut core, writer, room, output.clone());
    assert!(
        effects
            .events
            .iter()
            .all(|(_, event)| !matches!(event, Event::Error { .. })),
        "{}",
        serde_json::to_string(&effects.events).unwrap()
    );

    let pair = effects
        .events
        .iter()
        .find_map(|(socket, event)| match event {
            Event::State { state } if *socket == writer => state
                .pairs
                .iter()
                .find(|p| p.peer_id == helper)
                .map(|p| p.id),
            _ => None,
        })
        .unwrap();
    let rejected = |effects: piik_channel_core::Effects| {
        effects.events.iter()
        .any(|(_, event)| matches!(event, Event::Error { code, .. } if code == "invalid_room_projection"))
    };
    let mut wrong_helper = output.clone();
    wrong_helper
        .projection
        .views
        .get_mut(&viewer)
        .unwrap()
        .screen_helpers
        .insert(publication, source);
    assert!(rejected(review_host_turn(
        &mut core,
        writer,
        room,
        wrong_helper
    )));
    let mut revoked = output.clone();
    revoked.projection.views.get_mut(&helper).unwrap().authorized = false;
    assert!(rejected(review_host_turn(&mut core, writer, room, revoked)));

    output.projection.flows = serde_json::from_value(json!([{
        "id":Uuid::new_v4(),"publicationId":publication,"sender":source,"receiver":helper,
        "inputFlowId":null,"selected":true,"proof":null,"presented":null,"presentation":false
    }]))
    .unwrap();
    assert!(rejected(review_host_turn(
        &mut core,
        writer,
        room,
        output.clone()
    )));
    for socket in [writer, helper_socket] {
        core.handle(
            socket,
            Request {
                request_id: None,
                command: Command::LinkState {
                    pair_id: pair,
                    state: LinkState::Connected,
                },
            },
            1,
        );
        assert_eq!(
            rejected(review_host_turn(&mut core, writer, room, output.clone())),
            socket == writer
        );
    }
    core.disconnect(helper_socket, 2);
    assert!(!rejected(review_host_turn(
        &mut core,
        writer,
        room,
        output.clone()
    )));
    let mut changed = output.clone();
    changed.projection.flows[0].id = Uuid::new_v4();
    assert!(rejected(review_host_turn(&mut core, writer, room, changed)));
    let mut new_choice = output.clone();
    let mut new_share = new_choice.projection.publications[0].clone();
    new_share.id = Uuid::new_v4();
    let view = new_choice.projection.views.get_mut(&viewer).unwrap();
    view.subscriptions.push(new_share.id);
    view.screen_helpers.insert(new_share.id, helper);
    new_choice.projection.publications.push(new_share);
    assert!(rejected(review_host_turn(
        &mut core, writer, room, new_choice
    )));

    let (resumed, _) = join_reader(&mut core, Uuid::new_v4(), Some(credential), Some(helper));
    assert_eq!(resumed, helper);
    let retained = review_host_turn(&mut core, writer, room, output.clone());
    assert!(retained
        .events
        .iter()
        .any(|(socket, event)| matches!(event, Event::State { state }
        if *socket == writer && state.pairs.iter().any(|p| p.id == pair
            && p.outgoing.iter().any(|f| f.id == output.projection.flows[0].id)))));
}

#[test]
fn room_topology_exposes_only_admitted_pairs_inside_the_current_room_scope() {
    use piik_channel_core::{
        host::RoomResult,
        wire::{Event, LinkState, Request},
        Authority,
    };
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let [writer, reader] = [Uuid::new_v4(), Uuid::new_v4()];
    let owner = review_admit(&mut core, writer, "owner");
    let peer = review_admit(&mut core, reader, "reader");
    let room = "scoped-pairs";
    let mut host = RoomHost::new(
        RoomState::new(
            room.into(),
            room.into(),
            Default::default(),
            core.identity().1,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap(),
    );
    host.dispatch(review_register(&mut core, writer, &host))
        .unwrap();
    let mut output = host.finish(None).unwrap();
    let initial = review_host_turn(&mut core, writer, room, output.clone());
    let carrier = initial
        .events
        .iter()
        .find_map(|(socket, event)| match event {
            Event::State { state } if *socket == writer => {
                state.pairs.iter().find(|p| p.peer_id == peer).map(|p| p.id)
            }
            _ => None,
        })
        .unwrap();
    let topology = |core: &mut Authority| {
        core.handle(
            writer,
            Request {
                request_id: None,
                command: Command::RoomTopology {
                    room_id: room.into(),
                    publication_id: None,
                },
            },
            1,
        )
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            Event::RoomReply {
                result: RoomResult::Topology { topology },
                ..
            } => Some(topology),
            _ => None,
        })
        .unwrap()
    };
    let isolated = topology(&mut core);
    assert_eq!(isolated.session_ids, [owner]);
    assert!(isolated.pairs.is_empty());
    output.projection.views.get_mut(&peer).unwrap().reading = true;
    output.projection.participant_session_ids.push(peer);
    review_host_turn(&mut core, writer, room, output);
    let (first, second) = (owner.min(peer), owner.max(peer));
    for socket in [writer, reader] {
        let current = topology(&mut core);
        assert_eq!(current.session_ids, [first, second]);
        assert_eq!(current.pairs.len(), 1);
        let pair = &current.pairs[0];
        assert_eq!(
            (pair.first, pair.second, pair.confirmed),
            (first, second, false)
        );
        core.handle(
            socket,
            Request {
                request_id: None,
                command: Command::LinkState {
                    pair_id: carrier,
                    state: LinkState::Connected,
                },
            },
            1,
        );
    }
    assert!(topology(&mut core).pairs[0].confirmed);
}

#[test]
fn relay_candidates_admit_the_writer_and_voice_member_within_the_room_grant() {
    use piik_channel_core::{
        wire::{Event, Request},
        Authority, Effects,
    };
    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let [writer_socket, voice_socket, lobby_socket] = [(); 3].map(|_| Uuid::new_v4());
    let writer = review_admit(&mut core, writer_socket, "owner");
    let speaker = review_admit(&mut core, voice_socket, "speaker");
    let lobby = review_admit(&mut core, lobby_socket, "lobby");
    let room = "relay-admission";
    let mut host = RoomHost::new(
        RoomState::new(
            room.into(),
            room.into(),
            Default::default(),
            core.identity().1,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap(),
    );
    host.dispatch(review_register(&mut core, writer_socket, &host))
        .unwrap();
    let initial = host.finish(None).unwrap();
    assert!(initial.projection.relay_session_ids.contains(&writer));
    assert!(!initial.projection.views[&writer].reading);
    review_host_turn(&mut core, writer_socket, room, initial);
    let joined = core.handle(
        voice_socket,
        Request {
            request_id: None,
            command: Command::Voice {
                room_id: room.into(),
                joined: true,
                muted: true,
                deafened: false,
            },
        },
        1,
    );
    let input = joined
        .events
        .into_iter()
        .find_map(|(_, e)| match e {
            Event::HostInput { input, .. } => Some(input),
            _ => None,
        })
        .unwrap();
    host.dispatch(input).unwrap();
    let actual = host.finish(None).unwrap();
    assert!(!actual.projection.views[&speaker].reading);
    assert_eq!(
        actual.projection.relay_session_ids,
        [writer, speaker].into()
    );
    let rejected = |result: Effects| {
        result
            .events
            .iter()
            .any(|(_, e)| matches!(e, Event::Error {code,..} if code == "invalid_room_projection"))
    };
    let mut outside = actual.clone();
    outside.projection.relay_session_ids.insert(lobby);
    assert!(rejected(review_host_turn(
        &mut core,
        writer_socket,
        room,
        outside
    )));
    let mut off = actual.clone();
    off.projection
        .views
        .get_mut(&speaker)
        .unwrap()
        .relay_override = Some(0);
    assert!(rejected(review_host_turn(
        &mut core,
        writer_socket,
        room,
        off
    )));
    let accepted = review_host_turn(&mut core, writer_socket, room, actual);
    assert!(accepted
        .events
        .iter()
        .any(|(socket, e)| matches!(e,Event::State{state}
        if *socket==voice_socket && state.voice.iter().any(|v| v.session_id==speaker))));
}
