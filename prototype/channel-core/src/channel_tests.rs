use super::*;

#[test]
fn decorative_icon_keys_are_bounded_but_not_a_preset_enum() {
    let key = "future-Preset_42";
    let icon: IdentityIcon = serde_json::from_value(serde_json::json!(key)).unwrap();
    assert_eq!(serde_json::to_value(icon).unwrap(), key);
    for invalid in [
        String::new(),
        "x".repeat(65),
        "https://example.com/icon".into(),
        "two words".into(),
    ] {
        assert!(serde_json::from_value::<IdentityIcon>(serde_json::json!(invalid)).is_err());
    }
    use base64ct::{Base64, Encoding};
    let image = format!(
        "data:image/png;base64,{}",
        Base64::encode_string(b"\x89PNG\r\n\x1a\n")
    );
    let icon: IdentityIcon = serde_json::from_value(serde_json::json!(image)).unwrap();
    assert_eq!(serde_json::to_value(icon).unwrap(), image);
    for invalid in [
        "data:image/png;base64,".into(),
        "data:image/png;base64,not-an-image".into(),
        "data:image/png;base64,PHN2Zz4=".into(),
        image.replace("image/png", "image/webp"),
        image.replace("image/png", "image/svg+xml"),
        format!("{image}{}", "A".repeat(IDENTITY_IMAGE_URL_BYTES)),
    ] {
        assert!(serde_json::from_value::<IdentityIcon>(serde_json::json!(invalid)).is_err());
    }
}

#[test]
fn image_directory_and_active_host_output_fit_the_domain_socket_budget() {
    use crate::{
        file_room::FilePlan,
        host::{HostAction, HostInput, RoomHost},
        wire::*,
    };
    use base64ct::{Base64, Encoding};

    let mut bytes = Base64::decode_vec("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==").unwrap();
    bytes.resize(
        (IDENTITY_IMAGE_URL_BYTES - "data:image/png;base64,".len()) / 4 * 3,
        0,
    );
    let icon = IdentityIcon::try_from(format!(
        "data:image/png;base64,{}",
        Base64::encode_string(&bytes)
    ))
    .unwrap();
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let sessions: Vec<_> = (0..20)
        .map(|index| {
            channel
                .join(
                    Admission {
                        can_prepare_udp: false,
                        can_receive_video_layers: false,
                        name: "Participant",
                        credential: None,
                        key: Some(if index == 0 { "owner" } else { "invite" }),
                        resume: None,
                        signing_key: [255; 32],
                    },
                    Uuid::new_v4(),
                    0,
                )
                .unwrap()
                .session_id
        })
        .collect();
    let owner = channel.identity.sessions[&sessions[0]].user_id;
    let room_id = "r".repeat(128);
    let mut host = RoomHost::new(
        crate::RoomState::new(
            room_id.clone(),
            "房".repeat(64),
            icon.clone(),
            owner,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap(),
    );
    host.dispatch(HostInput {
        now: 0,
        binding_id: Uuid::new_v4(),
        host_session_id: sessions[0],
        revision: 1,
        endpoints: channel.identity.endpoints(),
        action: HostAction::Sync,
    })
    .unwrap();
    let mut output = host.finish(None).unwrap();
    // Full directory, three active rooms, both publication kinds, voice and one
    // attachment selection per active room. This is not a total catalog limit.
    for view in output.projection.views.values_mut() {
        view.room.participant_session_ids = sessions.clone();
        view.publications = sessions
            .iter()
            .flat_map(|session| {
                [Kind::Screen, Kind::Voice].map(|kind| PublicationInfo {
                    id: Uuid::new_v4(),
                    room_id: room_id.clone(),
                    session_id: *session,
                    user_id: channel.identity.sessions[session].user_id,
                    kind,
                    muted: false,
                })
            })
            .collect();
        view.voice = sessions
            .iter()
            .map(|session| VoiceInfo {
                session_id: *session,
                room_id: room_id.clone(),
                muted: false,
                deafened: false,
            })
            .collect();
        view.subscriptions = view.publications.iter().map(|source| source.id).collect();
        view.files = (0..8)
            .map(|index| FilePlan {
                room_id: room_id.clone(),
                message_seq: index + 1,
                attachment: crate::AttachmentDescriptor {
                    id: Uuid::new_v4(),
                    name: "🖼".repeat(240),
                    size: crate::ATTACHMENT_LIMITS.max_file_bytes,
                    media_type: "application/octet-stream".into(),
                    sha256: "f".repeat(64),
                },
                source_id: Some(sessions[0]),
                upstream: Some(sessions[1]),
                downstream: vec![sessions[2], sessions[3]],
                receiving: true,
            })
            .collect();
    }
    let room = output.projection.views[&sessions[0]].clone();
    output.projection.base_links = sessions
        .iter()
        .enumerate()
        .skip(1)
        .map(|(index, child)| crate::transport::BaseLink {
            room_id: room_id.clone(),
            parent: sessions[(index - 1) / 2],
            child: *child,
        })
        .collect();
    output.projection.flows = room
        .publications
        .iter()
        .flat_map(|source| {
            sessions
                .iter()
                .filter(move |session| **session != source.session_id)
                .map(|receiver| crate::transport::Flow {
                    id: Uuid::new_v4(),
                    publication_id: source.id,
                    input_flow_id: Some(Uuid::new_v4()),
                    sender: sessions[0],
                    receiver: *receiver,
                    selected: true,
                })
        })
        .collect();
    let host_bytes = serde_json::to_vec(&Command::HostOutput {
        room_id: room_id.clone(),
        output,
    })
    .unwrap()
    .len();
    let mut state = channel.snapshot(sessions[0]);
    state.channel.icon = icon;
    state.channel.name = "域".repeat(64);
    state.users = (0..64)
        .map(|_| UserInfo {
            id: Uuid::new_v4(),
            name: "名".repeat(40),
            roles: ["member".into(), "moderator".into()].into_iter().collect(),
        })
        .collect();
    for index in 0..32 {
        let id = format!("{index:0128}");
        let mut view = room.clone();
        view.room.id = id.clone();
        view.room.members = Some(state.users.iter().map(|user| user.id).collect());
        view.room.delivery = Some(RoomDelivery {
            host_session_id: sessions[0],
            binding_id: Uuid::new_v4(),
            next_hops: sessions
                .iter()
                .skip(1)
                .map(|session| (*session, sessions[1]))
                .collect(),
        });
        for publication in &mut view.publications {
            publication.id = Uuid::new_v4();
            publication.room_id = id.clone();
        }
        for voice in &mut view.voice {
            voice.room_id = id.clone();
        }
        for file in &mut view.files {
            file.room_id = id.clone();
        }
        if index < 3 {
            state
                .subscriptions
                .extend(view.publications.iter().map(|source| source.id));
            state.publications.extend(view.publications);
            state.voice.extend(view.voice);
            state.files.extend(view.files);
        } else {
            view.room.participant_session_ids.clear();
            view.room.delivery = None;
        }
        state.channel.rooms.push(view.room);
    }
    state.pairs = sessions
        .iter()
        .skip(1)
        .map(|peer| PairInfo {
            udp_preparation: None,
            can_receive_video_layers: false,
            id: Uuid::new_v4(),
            peer_id: *peer,
            rooms: state
                .channel
                .rooms
                .iter()
                .map(|room| room.id.clone())
                .collect(),
            outgoing: state
                .publications
                .iter()
                .take(64)
                .map(|source| FlowBinding {
                    id: Uuid::new_v4(),
                    publication_id: source.id,
                    input_flow_id: Some(Uuid::new_v4()),
                    selected: true,
                })
                .collect(),
            incoming: state
                .publications
                .iter()
                .take(64)
                .map(|source| FlowBinding {
                    id: Uuid::new_v4(),
                    publication_id: source.id,
                    input_flow_id: Some(Uuid::new_v4()),
                    selected: true,
                })
                .collect(),
        })
        .collect();
    let snapshot_bytes = serde_json::to_vec(&Event::State { state }).unwrap().len();
    eprintln!("identity directory: {snapshot_bytes} bytes; host output: {host_bytes} bytes");
    assert!(snapshot_bytes < 2 * 1024 * 1024);
    assert!(host_bytes < 2 * 1024 * 1024);
}

#[test]
fn unknown_sender_fields_fail_with_the_request_id_intact() {
    let request = Request::parse(
        r#"{"type":"chat","requestId":"operation","roomId":"living","text":"spoof","nonce":"n","userId":"other"}"#,
    );
    assert!(
        matches!(request, Err((Some(request_id), "invalid_request")) if request_id == "operation")
    );
}

#[test]
fn text_limits_match_browser_utf16_and_room_history() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let owner = channel
        .join(
            Admission {
                can_prepare_udp: false,
                can_receive_video_layers: false,
                name: "Owner",
                credential: None,
                key: Some("owner"),
                resume: None,
                signing_key: crate::conversation::SessionSigner::from_seed([1; 32]).signing_key(),
            },
            Uuid::new_v4(),
            0,
        )
        .unwrap();
    assert!(channel
        .handle(
            owner.session_id,
            Command::SetName {
                name: "\u{1f600}".repeat(21)
            },
            0
        )
        .is_err());
    assert!(channel
        .handle(
            owner.session_id,
            Command::UpdateDomain {
                name: "\u{1f600}".repeat(33),
                icon: Default::default(),
            },
            0
        )
        .is_err());
    assert!(channel
        .handle(
            owner.session_id,
            Command::UpdateDomain {
                name: "   ".into(),
                icon: Default::default(),
            },
            0
        )
        .is_err());
    channel
        .handle(
            owner.session_id,
            Command::UpdateDomain {
                name: format!(" {} ", "\u{1f600}".repeat(32)),
                icon: Default::default(),
            },
            0,
        )
        .unwrap();
    assert_eq!(
        channel.snapshot(owner.session_id).channel.name,
        "\u{1f600}".repeat(32)
    );
    let mut old = serde_json::to_value(channel.export_state()).unwrap();
    old["version"] = serde_json::json!(3);
    assert_eq!(
        channel.import_state(serde_json::from_value(old).unwrap()),
        Err("invalid_state")
    );
    assert!(crate::history::MessageDraft::new(
        owner.user_id,
        "limit".into(),
        "\u{1f600}".repeat(2000),
        vec![],
        0
    )
    .is_ok());
    assert!(crate::history::MessageDraft::new(
        owner.user_id,
        "excess".into(),
        "\u{1f600}".repeat(2001),
        vec![],
        0
    )
    .is_err());
}
