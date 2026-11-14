use super::*;

fn connection_session(url: String) -> Session {
    Session {
        config: Config {
            url,
            origin: "http://localhost".into(),
            name: "Pending capability".into(),
            owner_key: None,
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
    }
}

#[tokio::test]
async fn pending_udp_capability_keeps_stop_and_recovery_owned_by_session() {
    let mut outcomes = Vec::new();
    for recovery in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut session = connection_session(format!("ws://{}", listener.local_addr().unwrap()));
        session.recovery = recovery.then(|| Instant::now() + Duration::from_millis(200));
        let server = tokio::spawn(async move {
            let mut socket = tokio_tungstenite::accept_async(listener.accept().await.unwrap().0)
                .await
                .unwrap();
            // Keep the WebSocket open while Join is pending.
            socket.next().await
        });
        let entered = tokio::sync::Notify::new();
        let (stop, stopped) = oneshot::channel();
        let mut stopped = std::pin::pin!(async {
            let _ = stopped.await;
        });
        let finished = {
            let mut drive = std::pin::pin!(session.drive(&mut stopped, || {
                entered.notify_one();
                std::future::pending::<bool>()
            }));
            tokio::select! {
                _ = entered.notified() => {},
                result = &mut drive => panic!("session ended before lookup: {result:?}"),
                _ = time::sleep(Duration::from_secs(2)) => panic!("lookup did not start"),
            }
            if !recovery {
                stop.send(()).unwrap();
            }
            time::timeout(Duration::from_millis(400), &mut drive).await
        };
        let responsive = if recovery {
            session.recovery.is_none()
        } else {
            matches!(finished, Ok(Ok(())))
        };
        eprintln!("pending capability: recovery={recovery}, responsive={responsive}");
        outcomes.push(responsive);
        server.abort();
        let _ = server.await;
        session.release().await.unwrap();
    }
    assert_eq!(
        outcomes,
        vec![true, true],
        "optional lookup blocked session lifetime"
    );
}

#[tokio::test]
async fn pending_udp_capability_releases_expired_session_before_late_join() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut session = connection_session(format!("ws://{}", listener.local_addr().unwrap()));
    let previous = Uuid::new_v4();
    let (commands, mut events) = mpsc::channel(8);
    session.live = Some(Live {
        session: previous,
        room: RoomTurns {
            local: previous,
            rooms: BTreeMap::new(),
            signer: session.signer.clone(),
            snapshot: watch::channel(None).0,
        },
        peers: NativePeers::new(previous, vec![], commands),
        commands: mpsc::channel(1).1,
        pairs: BTreeSet::new(),
    });
    session.recovery = Some(Instant::now() + Duration::from_millis(200));
    let server = async {
        let mut socket = tokio_tungstenite::accept_async(listener.accept().await.unwrap().0)
            .await
            .unwrap();
        let packet = socket.next().await.unwrap().unwrap();
        let request = piik_channel_core::wire::Request::parse(packet.to_text().unwrap()).unwrap();
        (socket, request)
    };
    let (complete, lookup) = oneshot::channel();
    let lookup = std::cell::RefCell::new(Some(lookup));
    let entered = tokio::sync::Notify::new();
    let (stop, stopped) = oneshot::channel();
    let mut stopped = std::pin::pin!(async {
        let _ = stopped.await;
    });
    {
        let mut server = std::pin::pin!(server);
        let mut drive = std::pin::pin!(session.drive(&mut stopped, || {
            let lookup = lookup
                .borrow_mut()
                .take()
                .expect("one query per connection");
            entered.notify_one();
            async move { lookup.await.unwrap() }
        }));
        tokio::select! {
            _ = entered.notified() => {},
            _ = &mut server => panic!("Join preceded capability"),
            result = &mut drive => panic!("session ended before lookup: {result:?}"),
            _ = time::sleep(Duration::from_secs(2)) => panic!("lookup did not start"),
        }
        tokio::select! {
            _ = async { while events.recv().await.is_some() {} } => {},
            result = &mut drive => panic!("session ended before recovery: {result:?}"),
            _ = time::sleep(Duration::from_secs(2)) => panic!("expired peers stayed alive"),
        }
        complete.send(false).unwrap();
        let (socket, request) = tokio::select! {
            result = &mut server => result,
            result = &mut drive => panic!("session ended before Join: {result:?}"),
            _ = time::sleep(Duration::from_secs(2)) => panic!("late capability did not resume Join"),
        };
        assert!(
            matches!(
                request.command,
                Command::Join {
                    session_id: None,
                    can_prepare_udp: false,
                    ..
                }
            ),
            "late lookup restored expired authority or advertised false capability"
        );
        drop(socket);
        stop.send(()).unwrap();
        time::timeout(Duration::from_secs(2), &mut drive)
            .await
            .unwrap()
            .unwrap();
    }
    assert!(session.live.is_none() && session.recovery.is_none());
}
