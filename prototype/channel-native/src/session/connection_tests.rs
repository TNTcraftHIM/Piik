use super::*;

#[tokio::test]
async fn reader_preserves_rejection_and_malformed_frame_before_close() {
    use tokio_tungstenite::tungstenite::protocol::Role;
    for (text, expected) in [
        (
            r#"{"type":"error","code":"forbidden"}"#,
            "admission failed: forbidden",
        ),
        ("not-json", "invalid_channel_event"),
    ] {
        let (local, remote) = tokio::io::duplex(4096);
        let mut socket = WebSocketStream::from_raw_socket(local, Role::Client, None).await;
        let mut peer = WebSocketStream::from_raw_socket(remote, Role::Server, None).await;
        let mut session = connection_session("ws://memory.invalid".into());
        let join = Command::Join {
            protocol: piik_channel_core::wire::CHANNEL_PROTOCOL,
            name: "Memory client".into(),
            credential: None,
            owner_key: None,
            session_id: None,
            signing_key: [1; 32],
            can_use_peer_transport: true,
            can_prepare_udp: false,
            can_receive_video_layers: false,
        };
        peer.send(Message::Text(text.into())).await.unwrap();
        peer.close(None).await.unwrap();
        let mut stop = std::pin::pin!(std::future::pending());
        let error = session
            .connected(&mut socket, join, &mut stop)
            .await
            .unwrap_err();
        assert!(error.to_string().contains(expected), "{error:#}");
    }
}

#[tokio::test]
async fn reader_reports_transport_failure_after_preserving_accepted_frames() {
    use tokio_tungstenite::tungstenite::{error::ProtocolError, protocol::Role, Error};

    let (local, remote) = tokio::io::duplex(4096);
    let mut socket = WebSocketStream::from_raw_socket(local, Role::Client, None).await;
    let mut peer = WebSocketStream::from_raw_socket(remote, Role::Server, None).await;
    let text = r#"{"type":"ack","requestId":"accepted"}"#;
    peer.send(Message::Text(text.into())).await.unwrap();
    drop(peer); // An abrupt transport end has no WebSocket close handshake.

    let (sender, mut incoming) = mpsc::channel(1);
    let result = read_messages(&mut socket, sender).await;
    assert_eq!(incoming.recv().await.unwrap().text, text);
    assert!(incoming.recv().await.is_none());
    let error = result.expect_err("transport failure must not become a successful reader exit");
    assert!(matches!(
        error.downcast_ref::<Error>(),
        Some(Error::Protocol(ProtocolError::ResetWithoutClosingHandshake))
    ));
}

#[tokio::test]
async fn reader_keeps_invalid_utf8_on_carrier_recovery_path() {
    use tokio_tungstenite::tungstenite::protocol::{
        frame::{
            coding::{Data, OpCode},
            Frame,
        },
        Role,
    };

    let (local, remote) = tokio::io::duplex(4096);
    let mut socket = WebSocketStream::from_raw_socket(local, Role::Client, None).await;
    let mut peer = WebSocketStream::from_raw_socket(remote, Role::Server, None).await;
    peer.send(Message::Frame(Frame::message(
        vec![0xf0, 0x9f],
        OpCode::Data(Data::Text),
        false,
    )))
    .await
    .unwrap();
    peer.send(Message::Frame(Frame::message(
        Vec::<u8>::new(),
        OpCode::Data(Data::Continue),
        true,
    )))
    .await
    .unwrap();

    let mut session = connection_session("ws://memory.invalid".into());
    let join = Command::Join {
        protocol: piik_channel_core::wire::CHANNEL_PROTOCOL,
        name: "Memory client".into(),
        credential: None,
        owner_key: None,
        session_id: None,
        signing_key: [1; 32],
        can_use_peer_transport: true,
        can_prepare_udp: false,
        can_receive_video_layers: false,
    };
    let mut stop = std::pin::pin!(std::future::pending());
    assert!(!session
        .connected(&mut socket, join, &mut stop)
        .await
        .unwrap());
}

#[tokio::test(start_paused = true)]
async fn reader_services_ping_while_business_has_not_consumed_its_frame() {
    use tokio_tungstenite::tungstenite::protocol::Role;
    let (local, remote) = tokio::io::duplex(4096);
    let mut socket = WebSocketStream::from_raw_socket(local, Role::Client, None).await;
    let mut peer = WebSocketStream::from_raw_socket(remote, Role::Server, None).await;
    let (sender, mut incoming) = mpsc::channel(1);
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        tokio::select! {
            _ = stopped => {},
            result = read_messages(&mut socket, sender) => panic!("reader ended: {result:?}"),
        }
    });
    peer.send(Message::Text(
        r#"{"type":"ack","requestId":"pending"}"#.into(),
    ))
    .await
    .unwrap();
    for _ in 0..3 {
        time::advance(Duration::from_secs(8)).await;
        peer.send(Message::Ping(vec![1].into())).await.unwrap();
        assert!(
            matches!(peer.next().await, Some(Ok(Message::Pong(bytes))) if bytes.as_ref() == [1])
        );
        assert!(!task.is_finished());
    }
    assert_eq!(incoming.len(), 1, "business work remains queued");
    stop.send(()).unwrap();
    task.await.unwrap();
    let message = incoming.recv().await.unwrap();
    assert!(message.text.contains("pending"));
    let budget = message._budget.semaphore().clone();
    drop(message);
    assert_eq!(
        budget.available_permits(),
        SIGNALING_QUEUE_BYTES + std::mem::size_of::<Incoming>()
    );
}

fn connection_session(url: String) -> Session {
    Session {
        forwarding_limit: None,
        service_admission: None,
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
        snapshot_job: None,
    }
}

#[tokio::test]
async fn stalled_handshake_can_be_stopped() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut session = connection_session(format!("ws://{}", listener.local_addr().unwrap()));
    let (stop, stopped) = oneshot::channel();
    let mut stopped = std::pin::pin!(async { stopped.await.unwrap() });
    let mut drive = std::pin::pin!(session.drive(&mut stopped));
    let _tcp = tokio::select! {
        tcp = time::timeout(Duration::from_secs(2), listener.accept()) => tcp.unwrap().unwrap(),
        result = &mut drive => panic!("session ended before handshake: {result:?}"),
    };
    stop.send(()).unwrap();
    time::timeout(Duration::from_secs(2), drive)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn join_advertises_udp_preparation_for_ordinary_native() -> Result<()> {
    for fixed in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let mut session = connection_session(format!("ws://{}", listener.local_addr()?));
        if fixed {
            session.config.server_udp = Some(crate::peer::server_udp::ServerUdp::bind(&[(
                "127.0.0.1:0".parse()?,
                None,
            )])?);
        }
        let mut stopped = std::pin::pin!(std::future::pending());
        let server = async {
            let mut socket = tokio_tungstenite::accept_async(listener.accept().await.unwrap().0)
                .await
                .unwrap();
            let packet = socket.next().await.unwrap().unwrap();
            piik_channel_core::wire::Request::parse(packet.to_text().unwrap()).unwrap()
        };
        let start = Instant::now();
        let request = tokio::select! {
            request = time::timeout(Duration::from_secs(2), server) => request?,
            result = session.drive(&mut stopped) => panic!("session ended before Join: {result:?}"),
        };
        assert!(
            matches!(request.command, Command::Join { can_prepare_udp, .. } if can_prepare_udp != fixed)
        );
        eprintln!("received Join fixed={fixed} after {:?}", start.elapsed());
    }
    Ok(())
}

#[tokio::test]
async fn stalled_handshake_releases_expired_session_before_late_join() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut session = connection_session(format!("ws://{}", listener.local_addr().unwrap()));
    let directory = tempfile::tempdir().unwrap();
    let (host_commands, requests) = mpsc::channel(4);
    session.hosting = Some(Hosting {
        directory: directory.path().into(),
        identity: (Uuid::new_v4(), Uuid::new_v4()),
        commands: requests,
        ready: watch::channel(None).0,
        desktop: None,
    });
    let local_endpoint = || async {
        let (result, response) = oneshot::channel();
        host_commands
            .send(HostCommand::LocalEndpoint(result))
            .await
            .unwrap();
        response.await.unwrap()
    };
    let previous = Uuid::new_v4();
    let (commands, mut events) = mpsc::channel(8);
    session.live = Some(Live {
        room_open_failures: Default::default(),
        forwarding_budget: Default::default(),
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
    let (complete, handshake) = oneshot::channel();
    let server = async {
        let tcp = listener.accept().await.unwrap().0;
        handshake.await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let packet = socket.next().await.unwrap().unwrap();
        let request = piik_channel_core::wire::Request::parse(packet.to_text().unwrap()).unwrap();
        (socket, request)
    };
    let (stop, stopped) = oneshot::channel();
    let mut stopped = std::pin::pin!(async {
        let _ = stopped.await;
    });
    {
        let mut server = std::pin::pin!(server);
        let mut drive = std::pin::pin!(session.drive(&mut stopped));
        tokio::select! {
            _ = async { while events.recv().await.is_some() {} } => {},
            result = &mut drive => panic!("session ended before recovery: {result:?}"),
            _ = time::sleep(Duration::from_secs(2)) => panic!("expired peers stayed alive"),
        }
        tokio::select! {
            endpoint = local_endpoint() => assert_eq!(endpoint, None),
            result = &mut drive => panic!("session ended before retired endpoint read: {result:?}"),
            _ = time::sleep(Duration::from_secs(2)) => panic!("retired endpoint read waited for handshake"),
        }
        complete.send(()).unwrap();
        let (socket, request) = tokio::select! {
            result = &mut server => result,
            result = &mut drive => panic!("session ended before Join: {result:?}"),
            _ = time::sleep(Duration::from_secs(2)) => panic!("late handshake did not resume Join"),
        };
        assert!(
            matches!(
                request.command,
                Command::Join {
                    session_id: None,
                    can_use_peer_transport: true,
                    can_prepare_udp: true,
                    ..
                }
            ),
            "late handshake restored expired authority or advertised false capability"
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

#[cfg(not(all(feature = "capture", target_os = "windows")))]
#[tokio::test]
async fn unsupported_software_execution_rejects_before_room_or_capture_effects() {
    use crate::capture::{EncodingExecution, Settings, Target, TargetKind, VideoCodecMode};
    use futures_util::FutureExt;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (client, remote) = tokio::join!(tokio_tungstenite::connect_async(&url), async {
        tokio_tungstenite::accept_async(listener.accept().await.unwrap().0).await
    });
    let mut socket = client.unwrap().0;
    let mut remote = remote.unwrap();
    let mut session = connection_session(url);
    let previous = Uuid::new_v4();
    let (commands, mut events) = mpsc::channel(8);
    session.live = Some(Live {
        room_open_failures: Default::default(),
        forwarding_budget: Default::default(),
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
    for codec_mode in [
        VideoCodecMode::Auto,
        VideoCodecMode::H264,
        VideoCodecMode::Vp8,
    ] {
        let (result, response) = oneshot::channel();
        session
            .prepare_capture(
                PrepareCapture {
                    publication_id: Uuid::new_v4(),
                    room_id: "room".into(),
                    target: Target {
                        kind: TargetKind::Picker,
                        source_id: "not-opened".into(),
                        title: "No device should open".into(),
                        pid: 0,
                        creation_time: None,
                    },
                    settings: Settings {
                        degradation_preference: crate::capture::DegradationPreference::Balanced,
                        width: 640,
                        height: 360,
                        fps: 30,
                        bitrate: 1_000_000,
                    },
                    codec_mode,
                    encoding_execution: EncodingExecution::Software,
                    audio: true,
                    show_capture_border: false,
                    exclude_audio: None,
                    render_endpoint_id: None,
                    replaces: None,
                    result,
                },
                &mut socket,
            )
            .await
            .unwrap();
        assert_eq!(
            time::timeout(Duration::from_secs(2), response)
                .await
                .expect("unsupported request must reject without room confirmation")
                .unwrap()
                .err()
                .unwrap(),
            "unsupported_encoding_execution"
        );
        assert!(session.pending_captures.is_empty());
        assert!(
            remote.next().now_or_never().is_none(),
            "unsupported request entered room authority"
        );
        assert!(session
            .live
            .as_ref()
            .unwrap()
            .peers
            .capture_publications()
            .await
            .unwrap()
            .is_empty());
        assert!(events.try_recv().is_err());
    }
    session.release().await.unwrap();
}
