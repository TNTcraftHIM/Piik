use super::*;
use serde_json::json;

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
                    "hasPassword":false,"authorized":true,"canManage":true,"available":true,
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
                    capture_id: Uuid::new_v4(), replacing: false, result,
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
