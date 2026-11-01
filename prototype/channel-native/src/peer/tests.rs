use super::*;
use anyhow::ensure;
use piik_channel_core::wire::FlowBinding;
mod interop;
mod opus_startup;
mod sockets;
pub(super) mod support;
mod transit;
pub(super) fn driver() -> (
    Driver,
    mpsc::Receiver<Event>,
    mpsc::Receiver<NativeEvent>,
    watch::Sender<bool>,
) {
    let (commands, output) = mpsc::channel(128);
    let (events, input) = mpsc::channel(1024);
    let (ready_sources, _) = mpsc::channel(16);
    let (stop, cancel) = watch::channel(false);
    (
        Driver {
            transport: transport::Runtime::new(None),
            session: Uuid::nil(),
            ice: vec![],
            server_udp: None,
            commands,
            links: Arc::new(Mutex::new(HashMap::new())),
            cancel,
            events,
            ready_sources,
            bandwidth_changed: Arc::new(Notify::new()),
            pairs: HashMap::new(),
            preparings: HashMap::new(),
            publications: HashMap::new(),
            sources: HashMap::new(),
            #[cfg(feature = "capture")]
            captures: HashMap::new(),
            #[cfg(all(
                feature = "capture",
                any(target_os = "windows", target_os = "linux", target_os = "macos")
            ))]
            derived: HashMap::new(),
            #[cfg(feature = "capture")]
            snapshot: watch::channel(None).1,
            relay: Relay::default(),
            files: Files::new(Uuid::nil()),
            inputs: input::Inputs::new(Uuid::nil(), watch::channel(None).1, None),
        },
        input,
        output,
        stop,
    )
}

#[tokio::test]
async fn pending_udp_preparation_keeps_the_latest_plan_and_retires_with_its_lease() -> Result<()> {
    let (mut d, _events, mut commands, _stop) = driver();
    // Owned loopback destinations keep this lifecycle check off the real gateway.
    let servers = [
        tokio::net::UdpSocket::bind("127.0.0.1:0").await?,
        tokio::net::UdpSocket::bind("127.0.0.1:0").await?,
        tokio::net::UdpSocket::bind("127.0.0.1:0").await?,
    ];
    d.ice = vec![RTCIceServer {
        urls: servers
            .iter()
            .map(|socket| Ok(format!("stun:{}", socket.local_addr()?)))
            .collect::<std::io::Result<Vec<_>>>()?,
        ..Default::default()
    }];
    let mut plan = PairInfo {
        can_receive_video_layers: false,
        id: Uuid::new_v4(),
        peer_id: Uuid::new_v4(),
        udp_preparation: Some(UdpPreparation::Required),
        rooms: vec!["initial".into()],
        incoming: vec![],
        outgoing: vec![],
    };
    d.update(vec![plan.clone()], vec![], vec![]).await?;
    assert!(d.pairs.is_empty() && d.preparings.len() == 1);
    let pending = &d.preparings[&plan.id];
    let task = pending.task.id();
    let retired = pending.task.abort_handle();
    let early = Signal {
        udp: None,
        resync: Some(true),
        exchange_id: None,
        description: None,
        candidate: None,
        tracks: None,
    };
    d.signal(plan.id, early).await?;
    plan.rooms = vec!["latest".into()];
    d.update(vec![plan.clone()], vec![], vec![]).await?;
    assert_eq!(d.preparings[&plan.id].task.id(), task);
    assert_eq!(d.preparings[&plan.id].plan.rooms, vec!["latest"]);
    assert_eq!(d.preparings[&plan.id].signals.len(), 1);
    d.update(vec![], vec![], vec![]).await?;
    assert!(d.preparings.is_empty() && d.pairs.is_empty() && retired.is_finished());
    while let Ok(event) = commands.try_recv() {
        assert!(
            !matches!(
                event,
                NativeEvent::Command(Command::LinkState {
                    state: LinkState::Failed,
                    ..
                })
            ),
            "normal lease retirement is not a transport failure"
        );
    }
    d.files.close().await;
    d.transport.close().await;
    Ok(())
}

#[tokio::test]
async fn close_cancels_a_full_command_output() -> Result<()> {
    let (tx, commands) = mpsc::channel(1);
    let native = NativePeers::new(Uuid::nil(), vec![], tx);
    native
        .update(
            vec![PairInfo {
                can_receive_video_layers: false,
                udp_preparation: None,
                id: Uuid::new_v4(),
                peer_id: Uuid::new_v4(),
                rooms: vec!["room".into()],
                incoming: vec![],
                outgoing: vec![],
            }],
            vec![],
            vec![],
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(commands.len(), 1);
    tokio::time::timeout(Duration::from_secs(3), native.close()).await??;
    Ok(())
}
