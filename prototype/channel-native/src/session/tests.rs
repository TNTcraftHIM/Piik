use super::*;
use serde_json::json;

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
            "historyWindow":100,"roles":[],"rooms":[room("target",true,json!({
                "hostSessionId":host,"bindingId":Uuid::new_v4(),"nextHops":{}
            })),room("offline",false,serde_json::Value::Null)]},
        "users":[{"id":user,"name":"Source","roles":[]},{"id":owner,"name":"Owner","roles":[]}],
        "sessions":[{"id":session_id,"userId":user,"online":true,"signingKey":vec![0;32]},
            {"id":host,"userId":owner,"online":true,"signingKey":vec![1;32]}],
        "files":[],"publications":[],"voice":[],"subscriptions":[],"pairs":[],"iceServers":[]
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
                "historyWindow":100,"roles":[],"rooms":[room("affected"),room("other")]},
            "users":[{"id":user,"name":"Source","roles":[]}],
            "sessions":[{"id":session_id,"userId":user,"online":true,"signingKey":vec![0;32]}],
            "files":[],"publications":[],"voice":[],"subscriptions":[],"pairs":[],"iceServers":[]
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
                    muted: false,
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
