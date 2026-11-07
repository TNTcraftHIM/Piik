use super::*;
use serde_json::json;

#[tokio::test]
async fn deferred_conversations_keep_their_deadline_and_retire_with_room_authority() {
    use piik_channel_core::conversation::ConversationAddress;
    let (mut session, _socket, _remote, mut state) = capture_projection_session().await;
    let live = session.live.as_mut().unwrap();
    let sender = state.channel.rooms[0]
        .delivery
        .as_ref()
        .unwrap()
        .host_session_id;
    let recipient = Uuid::new_v4();
    let binding = state.channel.rooms[0].delivery.as_ref().unwrap().binding_id;
    let signer = SessionSigner::from_seed([2; 32]);
    state
        .sessions
        .iter_mut()
        .find(|entry| entry.id == sender)
        .unwrap()
        .signing_key = signer.signing_key();
    state.pairs.push(
        serde_json::from_value(json!({ "id": Uuid::new_v4(), "peerId": sender,
        "rooms": ["target"], "incoming": [], "outgoing": [] }))
        .unwrap(),
    );
    let packet = signer
        .sign(
            sender,
            &ConversationReply {
                address: ConversationAddress {
                    room_id: "target".into(),
                    binding_id: binding,
                    sender,
                    recipient,
                    request_id: "deferred".into(),
                },
                record: ConversationRecord::HistoryEnd {
                    count: 0,
                    has_more: false,
                    oldest_seq: None,
                    before: None,
                },
            },
        )
        .unwrap();
    live.room.snapshot.send_replace(Some(state.clone()));
    live.room.receive(&live.peers, sender, packet.clone());
    assert_eq!(live.room.waiting.len(), 1);
    let deadline = live.room.waiting[0].deadline;
    live.room.update(&live.peers);
    assert_eq!(live.room.waiting[0].deadline, deadline);
    assert_eq!(
        live.room.waiting[0].packets[0].remaining_hops,
        packet.remaining_hops
    );
    state.channel.rooms[0].delivery.as_mut().unwrap().binding_id = Uuid::new_v4();
    live.room.snapshot.send_replace(Some(state));
    live.room.update(&live.peers);
    assert!(live.room.waiting.is_empty());
    session.release().await.unwrap();
}

#[tokio::test]
async fn deferred_history_keeps_its_complete_batch_ahead_of_later_records_until_peer_installation()
{
    use piik_channel_core::{
        conversation::{ConversationAddress, ConversationResult},
        history::{ConfirmationInput, HistoryResult, MessageDraft, HISTORY_PAGE},
    };
    let (mut session, _socket, _remote, mut state) = capture_projection_session().await;
    let live = session.live.as_mut().unwrap();
    let peer = state.channel.rooms[0]
        .delivery
        .as_ref()
        .unwrap()
        .host_session_id;
    let delivery = state.channel.rooms[0].delivery.as_mut().unwrap();
    delivery.host_session_id = live.session;
    delivery.next_hops.insert(peer, peer);
    let binding = delivery.binding_id;
    state
        .sessions
        .iter_mut()
        .find(|entry| entry.id == live.session)
        .unwrap()
        .signing_key = live.room.signer.signing_key();
    state.pairs.push(
        serde_json::from_value(json!({ "id": Uuid::new_v4(), "peerId": peer,
        "rooms": ["target"], "incoming": [], "outgoing": [] }))
        .unwrap(),
    );
    live.room.snapshot.send_replace(Some(state));
    let address = ConversationAddress {
        room_id: "target".into(),
        binding_id: binding,
        sender: peer,
        recipient: live.session,
        request_id: "history".into(),
    };
    let messages = (0..HISTORY_PAGE)
        .map(|seq| {
            MessageDraft {
                user_id: peer,
                nonce: format!("nonce-{seq}"),
                text: format!("Message {seq}"),
                attachments: vec![],
                time: 1,
            }
            .prepare_confirmation(ConfirmationInput::New {
                last_seq: seq as u64,
            })
            .unwrap()
            .message
        })
        .collect();
    let replies = address
        .replies(Ok(ConversationResult::History(HistoryResult::Page {
            messages,
            has_more: false,
            oldest_seq: Some(1),
            before: None,
        })))
        .unwrap();
    assert_eq!(replies.len(), 101);
    live.room.replies(&live.peers, &replies).unwrap();
    let mut later = replies.last().unwrap().clone();
    later.address.request_id = "later".into();
    live.room.replies(&live.peers, &[later]).unwrap();
    assert_eq!(
        live.room
            .waiting
            .iter()
            .map(|turn| turn.packets.len())
            .collect::<Vec<_>>(),
        [101, 1]
    );
    let end: ConversationReply = conversation::verify(
        &live.room.waiting[0].packets[100],
        live.room.signer.signing_key(),
    )
    .unwrap();
    assert!(matches!(
        end.record,
        ConversationRecord::HistoryEnd {
            count: HISTORY_PAGE,
            ..
        }
    ));
    live.room.waiting[0].deadline = Instant::now();
    live.room.update(&live.peers);
    assert_eq!(live.room.waiting.len(), 1);
    let remaining: ConversationReply = conversation::verify(
        &live.room.waiting[0].packets[0],
        live.room.signer.signing_key(),
    )
    .unwrap();
    assert_eq!(remaining.address.request_id, "later");
    live.room.disconnected();
    assert!(live.room.waiting.is_empty());
    session.release().await.unwrap();
}

#[tokio::test]
async fn resumed_endpoint_retires_its_missing_host_after_a_deleted_output_cannot_be_sent() {
    use piik_channel_core::{
        host::{HostAction, HostInput, RequestContext},
        Endpoint, Member,
    };
    let (mut session, mut socket, mut remote, mut state) = capture_projection_session().await;
    let native = session.live.as_ref().unwrap().session;
    let user = state
        .sessions
        .iter()
        .find(|entry| entry.id == native)
        .unwrap()
        .user_id;
    let binding = state.channel.rooms[0].delivery.as_ref().unwrap().binding_id;
    state.channel.rooms[0].creator_id = user;
    state.channel.rooms[0]
        .delivery
        .as_mut()
        .unwrap()
        .host_session_id = native;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("room.sqlite");
    let policy = RoomState::new(
        "target".into(),
        "Target".into(),
        Default::default(),
        user,
        RoomAccess::Public,
        false,
        None,
    )
    .unwrap();
    let mut host = HostedRoom::create(&path, policy).unwrap();
    host.bind(binding).unwrap();
    session
        .live
        .as_mut()
        .unwrap()
        .room
        .rooms
        .insert("target".into(), host);
    session.files.push(RoomFile {
        path: path.clone(),
        id: "target".into(),
        name: "Target".into(),
        bootstrap: false,
    });
    session.state(state.clone(), &mut socket).await.unwrap();
    remote.close(None).await.unwrap();
    let _ = socket.close(None).await;
    let input = HostInput {
        now: 1,
        binding_id: binding,
        host_session_id: native,
        revision: 1,
        endpoints: [(
            native,
            Endpoint {
                signing_key: session.signer.signing_key(),
                member: Member {
                    user_id: user,
                    domain_owner: false,
                },
                connected: true,
            },
        )]
        .into(),
        action: HostAction::Command {
            context: RequestContext {
                connection: Uuid::new_v4(),
                session_id: native,
                request_id: Some("delete".into()),
                now: 1,
            },
            command: Command::DeleteRoom {
                room_id: "target".into(),
                delete_data: true,
            },
        },
    };
    assert!(session
        .event(
            Event::HostInput {
                room_id: "target".into(),
                input
            },
            &mut socket
        )
        .await
        .is_err());
    assert!(!session
        .live
        .as_ref()
        .unwrap()
        .room
        .rooms
        .contains_key("target"));
    assert!(session.files.is_empty());
    assert!(piik_channel_core::storage::Storage::open(&path)
        .unwrap()
        .load()
        .unwrap()
        .is_none());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (client, peer) = tokio::join!(tokio_tungstenite::connect_async(url), async {
        tokio_tungstenite::accept_async(listener.accept().await.unwrap().0).await
    });
    let (mut socket, _) = client.unwrap();
    let mut peer = peer.unwrap();
    session
        .event(
            Event::Welcome {
                credential: "fixture".into(),
                session_id: native,
                state,
                invite_key: None,
                invitation_origin: None,
            },
            &mut socket,
        )
        .await
        .unwrap();
    let packet = tokio::time::timeout(std::time::Duration::from_secs(1), peer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let request = piik_channel_core::wire::Request::parse(packet.to_text().unwrap()).unwrap();
    assert!(
        matches!(request.command, Command::HostStop { room_id, binding_id } if room_id == "target" && binding_id == binding)
    );
    session.release().await.unwrap();
}

#[tokio::test]
async fn missing_room_restore_waits_for_domain_admission_and_drops_denied_or_retired_staging() {
    use piik_channel_core::{backup::RoomMetadata, wire::Request, RoomBackup};
    let (mut session, mut socket, mut remote, state) = capture_projection_session().await;
    let directory = tempfile::tempdir().unwrap();
    let user = state
        .sessions
        .iter()
        .find(|entry| Some(entry.id) == session.live.as_ref().map(|live| live.session))
        .unwrap()
        .user_id;
    let (_commands, received) = mpsc::channel(1);
    session.hosting = Some(Hosting {
        directory: directory.path().into(),
        identity: (state.channel.id, user),
        commands: received,
        ready: watch::channel(None).0,
        desktop: None,
    });
    for denied in [true, false] {
        let staging = tempfile::tempdir().unwrap();
        let path = staging.path().to_owned();
        let policy = RoomState::new(
            "restored".into(),
            "Restored".into(),
            Default::default(),
            user,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap();
        let room = RoomBackup::stage(
            &path.join("room.sqlite"),
            RoomMetadata {
                version: 1,
                domain_id: state.channel.id,
                policy,
                own_credential: None,
                retained_files: vec![],
            },
            std::iter::empty(),
        )
        .unwrap();
        let (result, response) = oneshot::channel();
        session
            .restore_room(
                RestoreRoom {
                    snapshot: RoomSnapshot {
                        room,
                        directory: staging,
                    },
                    result,
                },
                &mut socket,
            )
            .await
            .unwrap();
        let request =
            Request::parse(remote.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert!(matches!(request.command, Command::AdmitRoom { .. }));
        assert!(
            stored_rooms(directory.path()).unwrap().is_empty(),
            "no destination room was written before admission"
        );
        if denied {
            session
                .event(
                    Event::Error {
                        code: "forbidden".into(),
                        request_id: request.request_id,
                    },
                    &mut socket,
                )
                .await
                .unwrap();
            assert_eq!(response.await.unwrap().err().unwrap(), "forbidden");
        } else {
            session.release().await.unwrap();
            assert_eq!(
                response.await.unwrap().err().unwrap(),
                "hosting_unavailable"
            );
        }
        assert!(
            !path.exists(),
            "the staged database is released with its request"
        );
        assert!(stored_rooms(directory.path()).unwrap().is_empty());
        assert!(session.opening.is_empty());
    }
}

async fn capture_projection_session() -> (Session, Socket, WebSocketStream<TcpStream>, Snapshot) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (client, remote) = tokio::join!(tokio_tungstenite::connect_async(&url), async {
        tokio_tungstenite::accept_async(listener.accept().await.unwrap().0).await
    });
    let (mut socket, _) = client.unwrap();
    let session_id = Uuid::new_v4();
    let host = Uuid::new_v4();
    let user = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let room = |id, available, delivery| {
        json!({
            "id":id,"name":id,"icon":"couch","creatorId":owner,"access":"private","hidden":true,
            "hasPassword":false,"voiceBitrate":64_000,"authorized":true,"canManage":false,"available":available,
            "reading":false,"participantSessionIds":[],"capabilities":{"attachments":false},"delivery":delivery
        })
    };
    let state: Snapshot = serde_json::from_value(json!({
        "channel":{"id":Uuid::new_v4(),"name":"Capture projection","icon":"couch","ownerId":owner,
            "access":"private","hasPassword":false,"inviteHash":piik_channel_core::domain_invite_hash("fixture"),
            "historyWindow":100,"rooms":[room("target",true,json!({
                "hostSessionId":host,"bindingId":Uuid::new_v4(),"nextHops":{}
            })),room("offline",false,serde_json::Value::Null)]},
        "users":[{"id":user,"name":"Source"},{"id":owner,"name":"Owner"}],
        "sessions":[{"id":session_id,"userId":user,"online":true,"signingKey":vec![0;32]},
            {"id":host,"userId":owner,"online":true,"signingKey":vec![1;32]}],
        "files":[],"publications":[],"voice":[],"subscriptions":[],"failedSubscriptions":[],"pairs":[],"iceServers":[]
    }))
    .unwrap();
    let mut session = Session {
        config: Config {
            url,
            origin: "http://localhost".into(),
            name: "Source".into(),
            key: None,
            credential: None,
            server_udp: None,
        },
        files: vec![],
        live: None,
        recovery: None,
        signer: Arc::new(SessionSigner::from_seed([1; 32])),
        hosting: None,
        opening: BTreeMap::new(),
        pending_captures: BTreeMap::new(),
    };
    let mut welcome = state.clone();
    // A fresh Native endpoint has no view of this already-authorized hidden room.
    welcome.channel.rooms.remove(0);
    session
        .event(
            Event::Welcome {
                credential: "fixture".into(),
                session_id,
                state: welcome,
                invite_key: None,
                invitation_origin: None,
            },
            &mut socket,
        )
        .await
        .unwrap();
    (session, socket, remote.unwrap(), state)
}

#[tokio::test]
async fn release_keeps_peer_shutdown_owned_when_cancelled() {
    use futures_util::FutureExt;

    let (mut session, _socket, _remote, _state) = capture_projection_session().await;
    let mut commands = std::mem::replace(
        &mut session.live.as_mut().unwrap().commands,
        mpsc::channel(1).1,
    );
    session.recovery = Some(Instant::now() + Duration::from_millis(RECOVERY_MS));
    {
        let mut closing = Box::pin(session.release());
        // This current-thread task cannot finish the spawned Driver until we yield.
        assert!(closing.as_mut().now_or_never().is_none());
    }
    let retained = session.live.is_some();
    session.release().await.unwrap();
    let joined = commands.is_closed();
    // Drain notifications even if the first release lost its join handle.
    while commands.recv().await.is_some() {}
    assert!(
        retained && joined,
        "shutdown owner retained={retained}, joined={joined}"
    );
    assert!(session.live.is_none() && session.recovery.is_none());
}

fn projection_capture(result: oneshot::Sender<Result<CaptureLease, String>>) -> PrepareCapture {
    PrepareCapture {
        publication_id: Uuid::new_v4(),
        room_id: "target".into(),
        target: Target {
            kind: crate::capture::TargetKind::Picker,
            source_id: "1".into(),
            title: "Unavailable fixture picker".into(),
            pid: 0,
            creation_time: None,
        },
        settings: Settings {
            width: 640,
            height: 360,
            fps: 30,
            bitrate: 1_000_000,
        },
        codec_mode: crate::capture::VideoCodecMode::Vp8,
        audio: false,
        show_capture_border: false,
        exclude_audio: None,
        replaces: None,
        result,
    }
}

#[tokio::test]
async fn capture_prepare_waits_for_room_authority_before_platform_preparation() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (mut session, mut socket, mut remote, state) = capture_projection_session().await;
        let (result, mut response) = oneshot::channel();
        let mut request = projection_capture(result);
        // The real producer admission rejects this replacement before opening a device.
        request.replaces = Some(Uuid::new_v4());
        session.prepare_capture(request, &mut socket).await.unwrap();
        match response.try_recv() {
            Err(oneshot::error::TryRecvError::Empty) => {}
            Ok(Err(code)) => panic!("preparation completed before room confirmation: {code}"),
            _ => panic!("preparation must wait for room confirmation"),
        }
        let Message::Text(text) = remote.next().await.unwrap().unwrap() else {
            panic!("EnterRoom confirmation")
        };
        let command: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(command["type"], "enter_room");
        assert_eq!(command["roomId"], "target");
        assert!(command["password"].is_null() && command["inviteKey"].is_null());
        let id = command["requestId"].as_str().unwrap().to_owned();
        session
            .event(
                Event::Ack {
                    request_id: id.clone(),
                },
                &mut socket,
            )
            .await
            .unwrap();
        session
            .event(
                Event::RoomReply {
                    room_id: "offline".into(),
                    request_id: Some(id.clone()),
                    result: RoomResult::Done,
                },
                &mut socket,
            )
            .await
            .unwrap();
        assert!(!state.channel.rooms[1].available);
        session
            .event(Event::State { state }, &mut socket)
            .await
            .unwrap();
        assert_eq!(session.pending_captures.len(), 1);
        assert!(matches!(
            response.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(session
            .live
            .as_ref()
            .unwrap()
            .peers
            .capture_publications()
            .await
            .unwrap()
            .is_empty());
        session
            .event(
                Event::RoomReply {
                    room_id: "target".into(),
                    request_id: Some(id),
                    result: RoomResult::Done,
                },
                &mut socket,
            )
            .await
            .unwrap();
        assert!(matches!(response.await, Ok(Err(code)) if code == "capture_not_owned"));
        assert!(session.pending_captures.is_empty());
        session.release().await.unwrap();
    })
    .await
    .expect("room confirmation and source admission complete");
}

#[tokio::test]
async fn waiting_capture_prepare_retires_before_late_room_confirmation() {
    tokio::time::timeout(Duration::from_secs(10), async {
        for change in ["room-error", "released", "caller-closed"] {
            let (mut session, mut socket, _remote, state) = capture_projection_session().await;
            let (result, response) = oneshot::channel();
            let mut response = Some(response);
            session
                .prepare_capture(projection_capture(result), &mut socket)
                .await
                .unwrap();
            assert_eq!(session.pending_captures.len(), 1);
            let id = session.pending_captures.keys().next().unwrap().clone();
            match change {
                "room-error" => {
                    session
                        .event(
                            Event::RoomReply {
                                room_id: "target".into(),
                                request_id: Some(id.clone()),
                                result: RoomResult::Error {
                                    code: "room_context_changed".into(),
                                },
                            },
                            &mut socket,
                        )
                        .await
                        .unwrap();
                }
                "released" => session.release().await.unwrap(),
                "caller-closed" => {
                    session.state(state, &mut socket).await.unwrap();
                    drop(response.take());
                }
                _ => unreachable!(),
            }
            if let Some(response) = response {
                let expected = if change == "released" {
                    "hosting_unavailable"
                } else {
                    "room_context_changed"
                };
                assert!(
                    matches!(response.await, Ok(Err(code)) if code == expected),
                    "{change}"
                );
            }
            session
                .event(
                    Event::RoomReply {
                        room_id: "target".into(),
                        request_id: Some(id),
                        result: RoomResult::Done,
                    },
                    &mut socket,
                )
                .await
                .unwrap();
            assert!(session.pending_captures.is_empty(), "{change}");
            if session.live.is_some() {
                assert!(
                    session
                        .live
                        .as_ref()
                        .unwrap()
                        .peers
                        .capture_publications()
                        .await
                        .unwrap()
                        .is_empty(),
                    "{change}: a later projection must not start a retired source"
                );
                session.release().await.unwrap();
            }
        }
    })
    .await
    .expect("all pending requests retire without starting capture");
}

#[tokio::test]
async fn capture_ceiling_completes_only_on_the_correlated_room_reply() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (client, remote) = tokio::join!(tokio_tungstenite::connect_async(&url), async {
        tokio_tungstenite::accept_async(listener.accept().await.unwrap().0).await
    });
    let (mut socket, _) = client.unwrap();
    let _remote = remote.unwrap();
    let mut session = Session {
        config: Config {
            url,
            origin: "http://localhost".into(),
            name: "Source".into(),
            key: None,
            credential: None,
            server_udp: None,
        },
        files: vec![],
        live: None,
        recovery: None,
        signer: Arc::new(SessionSigner::from_seed([1; 32])),
        hosting: None,
        opening: BTreeMap::new(),
        pending_captures: BTreeMap::new(),
    };
    for result in [
        RoomResult::Done,
        RoomResult::Error {
            code: "room_rejected".into(),
        },
    ] {
        let (done, mut response) = oneshot::channel();
        let id = Uuid::new_v4().to_string();
        session.pending_captures.insert(
            id.clone(),
            PendingCapture::Ceiling(PublishCaptureCeiling {
                scope: CaptureScope {
                    publication_id: Uuid::new_v4(),
                    room_id: "room".into(),
                    binding_id: Uuid::new_v4(),
                },
                capture_id: Uuid::new_v4(),
                ceiling: Settings {
                    width: 640,
                    height: 360,
                    fps: 30,
                    bitrate: 1_000_000,
                }
                .into(),
                result: done,
            }),
        );
        session
            .event(
                Event::Ack {
                    request_id: id.clone(),
                },
                &mut socket,
            )
            .await
            .unwrap();
        session
            .event(
                Event::RoomReply {
                    room_id: "other".into(),
                    request_id: Some(id.clone()),
                    result: RoomResult::Done,
                },
                &mut socket,
            )
            .await
            .unwrap();
        assert!(matches!(
            response.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        let expected = match &result {
            RoomResult::Done => Ok(()),
            RoomResult::Error { code } => Err(code.clone()),
            _ => unreachable!(),
        };
        session
            .event(
                Event::RoomReply {
                    room_id: "room".into(),
                    request_id: Some(id.clone()),
                    result,
                },
                &mut socket,
            )
            .await
            .unwrap();
        assert_eq!(response.await.unwrap(), expected);
        assert!(session.pending_captures.is_empty());
        session
            .event(
                Event::RoomReply {
                    room_id: "room".into(),
                    request_id: Some(id),
                    result: RoomResult::Done,
                },
                &mut socket,
            )
            .await
            .unwrap();
        assert!(session.pending_captures.is_empty());
    }
}

#[tokio::test]
async fn pending_capture_commit_ends_with_its_room_and_retires_a_late_publication() {
    tokio::time::timeout(Duration::from_secs(10), async {
        for change in ["offline", "replaced", "revoked"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let (client, remote) = tokio::join!(tokio_tungstenite::connect_async(&url), async {
                tokio_tungstenite::accept_async(listener.accept().await.unwrap().0).await
            });
            let (mut socket, _) = client.unwrap();
            let mut remote = remote.unwrap();
            let session_id = Uuid::new_v4();
            let user = Uuid::new_v4();
            let binding = Uuid::new_v4();
            let room = |id| {
                json!({
                    "id":id,"name":id,"icon":"couch","creatorId":user,"access":"public","hidden":false,
                    "hasPassword":false,"voiceBitrate":64_000,"authorized":true,"canManage":true,"available":true,
                    "reading":false,"participantSessionIds":[],"capabilities":{"attachments":false},
                    "delivery":{"hostSessionId":Uuid::new_v4(),"bindingId":binding,"nextHops":{}}
                })
            };
            let mut state: Snapshot = serde_json::from_value(json!({
            "channel":{"id":Uuid::new_v4(),"name":"Capture lifecycle","icon":"couch","ownerId":user,
                "access":"private","hasPassword":false,"inviteHash":piik_channel_core::domain_invite_hash("fixture"),
                "historyWindow":100,"rooms":[room("affected"),room("other")]},
            "users":[{"id":user,"name":"Source"}],
            "sessions":[{"id":session_id,"userId":user,"online":true,"signingKey":vec![0;32]}],
            "files":[],"publications":[],"voice":[],"subscriptions":[],"failedSubscriptions":[],"pairs":[],"iceServers":[]
        }))
        .unwrap();
            let mut session = Session {
                config: Config {
                    url,
                    origin: "http://localhost".into(),
                    name: "Source".into(),
                    key: None,
                    credential: None,
                    server_udp: None,
                },
                files: vec![],
                live: None,
                recovery: None,
                signer: Arc::new(SessionSigner::from_seed([1; 32])),
                hosting: None,
                opening: BTreeMap::new(),
                pending_captures: BTreeMap::new(),
            };
            session
                .event(
                    Event::Welcome {
                        credential: "fixture".into(),
                        session_id,
                        state: state.clone(),
                        invite_key: None,
                        invitation_origin: None,
                    },
                    &mut socket,
                )
                .await
                .unwrap();
            let mut requests = Vec::new();
            for id in ["affected", "other"] {
                let publication_id = Uuid::new_v4();
                let (result, response) = oneshot::channel();
                let request_id = Uuid::new_v4().to_string();
                // Preparation owns the platform device; this fixture starts at
                // the real Session's pending room-authority acknowledgement.
                session.pending_captures.insert(request_id.clone(), PendingCapture::Commit(CommitCapture {
                    scope: CaptureScope { publication_id, room_id: id.into(), binding_id: binding },
                    capture_id: Uuid::new_v4(), replacing: false, retaining: false,
                    video_ceiling: Some(Settings { width: 640, height: 360, fps: 30, bitrate: 5_000_000 }.into()), result,
                }));
                requests.push((
                    publication_id,
                    response,
                    request_id,
                ));
            }
            session.state(state.clone(), &mut socket).await.unwrap();
            assert!(requests.iter_mut().all(|(_, response, _)| matches!(
                response.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            )));
            match change {
                "offline" => state.channel.rooms[0].available = false,
                "replaced" => {
                    state.channel.rooms[0].delivery.as_mut().unwrap().binding_id = Uuid::new_v4()
                }
                "revoked" => state.channel.rooms[0].authorized = false,
                _ => unreachable!(),
            }
            session.state(state.clone(), &mut socket).await.unwrap();
            let cancelled = requests[0].1.try_recv();
            assert!(
                matches!(&cancelled, Ok(Err(code)) if code == "room_unavailable"),
                "{change}: retiring the room must resolve capture startup"
            );
            assert!(
                matches!(
                    requests[1].1.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty)
                ),
                "another room's pending producer remains owned"
            );

            state.channel.rooms[0].available = true;
            state.channel.rooms[0].authorized = true;
            state.publications = requests
                .iter()
                .map(|(id, _, _)| piik_channel_core::wire::PublicationInfo {
                    id: *id,
                    room_id: if *id == requests[0].0 {
                        "affected"
                    } else {
                        "other"
                    }
                    .into(),
                    session_id,
                    user_id: user,
                    kind: Kind::Screen,
                    paused: false,
                    video_ceiling: Some(Settings { width: 640, height: 360, fps: 30, bitrate: 5_000_000 }.into()),
                })
                .collect();
            session.state(state, &mut socket).await.unwrap();
            let Message::Text(text) = remote.next().await.unwrap().unwrap() else {
                panic!("Unpublish")
            };
            let cleanup: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(cleanup["type"], "unpublish");
            assert_eq!(cleanup["publicationId"], requests[0].0.to_string());
            session
                .event(
                    Event::RoomReply {
                        room_id: "affected".into(),
                        request_id: Some(requests[0].2.clone()),
                        result: RoomResult::Done,
                    },
                    &mut socket,
                )
                .await
                .unwrap();
            assert_eq!(
                session.pending_captures.len(),
                1,
                "late completion cannot revive retired capture"
            );
            session.release().await.unwrap();
            let (_, response, _) = requests.pop().unwrap();
            assert!(matches!(response.await, Ok(Err(code)) if code == "hosting_unavailable"));
        }
    })
    .await
    .expect("capture lifecycle and websocket responses complete");
}
