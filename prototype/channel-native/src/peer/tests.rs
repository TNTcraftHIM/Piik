use super::*;
use anyhow::ensure;
use piik_channel_core::wire::FlowBinding;
mod interop;
mod opus_startup;
mod sockets;
pub(super) mod support;
mod transit;

#[cfg(feature = "capture")]
#[tokio::test]
async fn stale_capture_lease_precedes_invalid_audio_endpoint() -> Result<()> {
    use crate::capture::{EncodingExecution, Settings, Target, TargetKind, VideoCodecMode};

    let (mut driver, _events, _commands, _stop) = driver();
    let result = driver.prepare_capture(
        CaptureScope {
            publication_id: Uuid::new_v4(),
            room_id: "room".into(),
            binding_id: Uuid::new_v4(),
        },
        Some(Uuid::new_v4()),
        Target {
            kind: TargetKind::Display,
            source_id: "display".into(),
            title: String::new(),
            pid: 0,
            creation_time: None,
        },
        Settings {
            degradation_preference: crate::capture::DegradationPreference::Balanced,
            width: 640,
            height: 360,
            fps: 30,
            bitrate: 1_000_000,
        },
        VideoCodecMode::Auto,
        EncodingExecution::Auto,
        true,
        None,
        Some(String::new()),
        false,
    ).await;
    driver.files.close().await;
    driver.watches.close().await;
    driver.transport.close().await;
    assert_eq!(result.err().expect("stale replacement").to_string(), "capture_not_owned");
    Ok(())
}

#[cfg(feature = "capture")]
#[tokio::test]
async fn cancelled_audio_retirement_keeps_the_worker_join_owned() -> Result<()> {
    let (mut driver, _events, _commands, _stop) = driver();
    let publication = Uuid::new_v4();
    let (started, stopping) = oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let (finished, mut completed) = oneshot::channel();
    let producer =
        crate::media::local::tests::controlled_audio_retirement(started, blocked, finished);
    driver.capture_audio.insert(
        publication,
        (
            CaptureScope {
                publication_id: publication,
                room_id: "room".into(),
                binding_id: Uuid::new_v4(),
            },
            producer,
        ),
    );
    {
        let retiring = driver.retire_capture_audio(publication);
        tokio::pin!(retiring);
        tokio::select! {
            result = stopping => result?,
            _ = &mut retiring => anyhow::bail!("retirement returned before its worker"),
        }
        // Same work-future cancellation as the Driver's outer stop select.
    }
    let retained = driver.capture_audio.contains_key(&publication);
    let worker_pending = matches!(
        completed.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    );
    let waited = {
        let closing = async {
            for (_, (_, mut producer)) in driver.capture_audio.drain() {
                producer.close().await;
            }
        };
        tokio::pin!(closing);
        let waited = futures_util::poll!(&mut closing).is_pending();
        release.send(())?;
        if waited {
            closing.await;
        }
        waited
    };
    completed.await?;
    ensure!(driver.capture_audio.is_empty());
    driver.files.close().await;
    driver.watches.close().await;
    driver.transport.close().await;
    ensure!(
        retained && worker_pending && waited,
        "cancelled audio retirement lost its pending worker join"
    );
    Ok(())
}

#[cfg(feature = "capture")]
#[tokio::test]
async fn publication_audio_settings_belong_to_the_mixer_until_it_stops() -> Result<()> {
    let (sources, _ready) = mpsc::channel(2);
    let (events, _ended) = mpsc::channel(2);
    let (_cancel, cancelled) = watch::channel(false);
    let mut producer = crate::media::local::AudioProducer::start(
        Uuid::new_v4(),
        sources,
        events,
        Relay::default(),
        cancelled,
    );
    let owner = CaptureAudio::new("room".into(), producer.control.clone());
    let muted = SourceAudioSettings {
        bitrate: 96_000,
        gain: 0.0,
    };
    owner.configure(muted)?;
    assert_eq!(*producer.control.settings.borrow(), muted);
    assert!(!owner.is_stopped());
    assert!(owner
        .configure(SourceAudioSettings {
            bitrate: 1,
            gain: 1.0
        })
        .is_err());
    assert_eq!(*producer.control.settings.borrow(), muted);
    producer.control.stop();
    assert!(owner.is_stopped());
    assert_eq!(
        owner
            .configure(SourceAudioSettings::default())
            .unwrap_err()
            .to_string(),
        "capture_unavailable"
    );
    producer.close().await;
    Ok(())
}

#[tokio::test]
async fn retained_capture_transfers_its_single_completion_to_the_new_lease() {
    fn lease(producer: Uuid) -> CaptureLease {
        let (_, ready) = oneshot::channel();
        #[cfg(feature = "capture")]
        let (mixer, system_audio) = crate::media::local::AudioControl::fixture();
        CaptureLease {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            scope: CaptureScope {
                publication_id: Uuid::new_v4(),
                room_id: "room".into(),
                binding_id: Uuid::new_v4(),
            },
            ready,
            codec: Arc::new(std::sync::OnceLock::new()),
            required_audio: None,
            audio: None,
            audio_error: None,
            ended: None,
            remote: None,
            input_state: None,
            #[cfg(feature = "capture")]
            control: None,
            #[cfg(feature = "capture")]
            mixer,
            #[cfg(feature = "capture")]
            system_audio,
            producer,
        }
    }
    let producer = Uuid::new_v4();
    let mut previous = lease(producer);
    let mut replacement = lease(producer);
    replacement.scope = previous.scope.clone();
    replacement.session_id = previous.session_id;
    let (finished, ended) = oneshot::channel();
    previous.ended = Some(ended);
    replacement.adopt_previous(&mut previous);
    assert!(previous.ended.is_none());
    assert_ne!(previous.id, replacement.id);
    finished.send(Err("codec stopped".into())).unwrap();
    assert_eq!(
        replacement.ended.take().unwrap().await.unwrap(),
        Err("codec stopped".into())
    );
}

#[tokio::test]
async fn capture_scope_survives_host_signaling_recovery_but_not_retired_authority() {
    use futures_util::FutureExt;
    use piik_channel_core::{
        host::RoomHost,
        wire::{Event as CoreEvent, Request, RoomAccess},
        Authority, Effects, RoomState, RECOVERY_MS,
    };
    use serde_json::{json, Value};

    fn send(core: &mut Authority, connection: Uuid, mut command: Value, now: u64) -> Effects {
        if command["type"] == "join" {
            command["protocol"] = json!(piik_channel_core::wire::CHANNEL_PROTOCOL);
            command["signingKey"] = json!(
                piik_channel_core::conversation::SessionSigner::from_seed([1; 32]).signing_key()
            );
        }
        core.handle(
            connection,
            Request::parse(&command.to_string()).unwrap(),
            now,
        )
    }
    fn state(effects: &Effects, connection: Uuid) -> &Snapshot {
        effects
            .events
            .iter()
            .rev()
            .find_map(|(target, event)| match event {
                CoreEvent::State { state } if *target == connection => Some(state),
                _ => None,
            })
            .expect("current authority snapshot")
    }
    fn finish(
        core: &mut Authority,
        host: &mut RoomHost,
        connection: Uuid,
        effects: Effects,
        now: u64,
    ) -> Effects {
        let (room_id, input) = effects
            .events
            .into_iter()
            .find_map(|(_, event)| match event {
                CoreEvent::HostInput { room_id, input } => Some((room_id, input)),
                _ => None,
            })
            .expect("actual room-host work");
        host.dispatch(input).unwrap();
        let output = host.finish(None).unwrap();
        send(
            core,
            connection,
            json!({"type":"host_output","roomId":room_id,"output":output}),
            now,
        )
    }

    let mut core = Authority::new("owner".into(), vec![]).unwrap();
    let host_connection = Uuid::new_v4();
    let native_connection = Uuid::new_v4();
    let admitted = send(
        &mut core,
        host_connection,
        json!({"type":"join","canUsePeerTransport":false,"ownerKey":"owner","name":"Host"}),
        0,
    );
    let (host_session, credential, owner) = admitted
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            CoreEvent::Welcome {
                session_id,
                credential,
                state,
                ..
            } => Some((session_id, credential, state.channel.owner_id.unwrap())),
            _ => None,
        })
        .unwrap();
    let admitted = send(
        &mut core,
        native_connection,
        json!({"type":"join","canUsePeerTransport":true,"name":"Native"}),
        1,
    );
    let native_user = admitted
        .events
        .into_iter()
        .find_map(|(_, event)| match event {
            CoreEvent::Welcome {
                session_id, state, ..
            } => Some(
                state
                    .sessions
                    .iter()
                    .find(|s| s.id == session_id)
                    .unwrap()
                    .user_id,
            ),
            _ => None,
        })
        .unwrap();
    let mut policy = RoomState::new(
        "capture".into(),
        "Capture".into(),
        Default::default(),
        owner,
        RoomAccess::Private,
        false,
        None,
    )
    .unwrap();
    policy.grants.insert(native_user);
    let mut host = RoomHost::new(policy.clone());
    let admitted = send(
        &mut core,
        host_connection,
        json!({"type":"admit_room","room":host.summary()}),
        2,
    );
    assert!(!admitted
        .events
        .iter()
        .any(|(_, event)| matches!(event, CoreEvent::Error { .. })));
    let registered = send(
        &mut core,
        host_connection,
        json!({"type":"host_register","room":host.summary()}),
        2,
    );
    let registered = finish(&mut core, &mut host, host_connection, registered, 2);
    let binding = state(&registered, native_connection).channel.rooms[0]
        .delivery
        .as_ref()
        .unwrap()
        .binding_id;
    let scope = CaptureScope {
        publication_id: Uuid::new_v4(),
        room_id: "capture".into(),
        binding_id: binding,
    };
    assert!(scope.is_current(state(&registered, native_connection)));
    let (projection, snapshot) =
        watch::channel(Some(state(&registered, native_connection).clone()));
    let mut authority = InputAuthority {
        scope: scope.clone(),
        snapshot,
    };
    assert!(authority.is_current());
    let publish = json!({"type":"publish","publication":{"id":scope.publication_id,"roomId":"capture","kind":"screen","source":{"kind":"screen","name":null},
        "videoSettings":{"ceiling":{"resolution":{"width":640,"height":360},"maxFramerate":30,"maxBitrate":5_000_000},"degradationPreference":"balanced"}}});
    let published = send(&mut core, native_connection, publish.clone(), 3);
    finish(&mut core, &mut host, host_connection, published, 3);

    let disconnected = core.disconnect(host_connection, 100);
    let recovering = state(&disconnected, native_connection);
    assert!(!recovering.channel.rooms[0].available);
    assert_eq!(
        recovering.channel.rooms[0]
            .delivery
            .as_ref()
            .map(|d| d.binding_id),
        Some(binding),
        "temporary signaling loss must not hide the retained room authority"
    );
    assert!(
        scope.is_current(recovering),
        "pending permission and active captures retain their authority"
    );
    projection.send_replace(Some(recovering.clone()));
    assert!(authority.is_current());
    assert!(
        authority.retired().now_or_never().is_none(),
        "temporary unavailability is not revocation"
    );
    assert!(recovering
        .publications
        .iter()
        .any(|p| p.id == scope.publication_id));
    let refused = send(&mut core, native_connection, publish, 101);
    assert!(refused.events.iter().any(|(_, event)| matches!(event, CoreEvent::Error { code, .. } if code == "room_host_offline")), "retained authority does not admit new offline room writes");

    let resumed_connection = Uuid::new_v4();
    let resumed = send(
        &mut core,
        resumed_connection,
        json!({"type":"join","canUsePeerTransport":false,"credential":credential,"sessionId":host_session,"name":"Host"}),
        200,
    );
    assert!(resumed.events.iter().any(|(_, event)| matches!(event, CoreEvent::Welcome { session_id, .. } if *session_id == host_session)));
    let registered = send(
        &mut core,
        resumed_connection,
        json!({"type":"host_register","room":host.summary(),"resumeBinding":binding}),
        201,
    );
    let resumed = finish(&mut core, &mut host, resumed_connection, registered, 201);
    assert!(state(&resumed, native_connection).channel.rooms[0].available);
    assert!(scope.is_current(state(&resumed, native_connection)));

    let mut expiring = core.clone();
    expiring.disconnect(resumed_connection, 300);
    assert!(expiring.expire(300 + RECOVERY_MS - 1).events.is_empty());
    let expired = expiring.expire(300 + RECOVERY_MS);
    assert!(!scope.is_current(state(&expired, native_connection)));
    assert!(state(&expired, native_connection).channel.rooms[0]
        .delivery
        .is_none());
    assert!(state(&expired, native_connection).publications.is_empty());

    let stopped = send(
        &mut core.clone(),
        resumed_connection,
        json!({"type":"host_stop","roomId":"capture","bindingId":binding}),
        300,
    );
    assert!(!scope.is_current(state(&stopped, native_connection)));
    assert!(state(&stopped, native_connection).channel.rooms[0]
        .delivery
        .is_none());

    let mut replacing = core.clone();
    let mut replacement_host = RoomHost::new(policy);
    let registered = send(
        &mut replacing,
        resumed_connection,
        json!({"type":"host_register","room":replacement_host.summary()}),
        300,
    );
    let replaced = finish(
        &mut replacing,
        &mut replacement_host,
        resumed_connection,
        registered,
        300,
    );
    let replacement = state(&replaced, native_connection);
    assert!(replacement.channel.rooms[0].available);
    assert!(replacement.channel.rooms[0].delivery.is_some());
    assert!(
        !scope.is_current(replacement),
        "a new live binding cannot retain an old lease"
    );

    let revoke = send(
        &mut core,
        resumed_connection,
        json!({"type":"revoke_room_access","roomId":"capture","userId":native_user}),
        300,
    );
    let revoked = finish(&mut core, &mut host, resumed_connection, revoke, 300);
    assert!(!state(&revoked, native_connection).channel.rooms[0].authorized);
    assert!(state(&revoked, native_connection).channel.rooms[0]
        .delivery
        .is_none());
    assert!(!scope.is_current(state(&revoked, native_connection)));
    projection.send_replace(Some(state(&revoked, native_connection).clone()));
    authority.retired().await;
    assert!(!authority.is_current());
    projection.send_replace(Some(state(&resumed, native_connection).clone()));
    assert!(authority.is_current());
    drop(projection);
    authority.retired().await;
    assert!(
        !authority.is_current(),
        "a retained snapshot cannot outlive its Native owner"
    );
}

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
            cancel,
            events,
            ready_sources,
            bandwidth_changed: Arc::new(Notify::new()),
            admitted: HashSet::new(),
            pairs: HashMap::new(),
            retiring_pair: None,
            retirement_failed: mpsc::channel(1).0,
            preparings: HashMap::new(),
            publications: HashMap::new(),
            sources: HashMap::new(),
            #[cfg(feature = "capture")]
            local_producers: HashMap::new(),
            #[cfg(feature = "capture")]
            capture_audio: HashMap::new(),
            #[cfg(all(
                feature = "capture",
                any(target_os = "windows", target_os = "linux", target_os = "macos")
            ))]
            derived: HashMap::new(),
            #[cfg(feature = "capture")]
            snapshot: watch::channel(None).1,
            relay: Relay::default(),
            files: Files::new(Uuid::nil()),
            watches: Watches::new(Uuid::nil()),
            inputs: input::Inputs::new(Uuid::nil(), watch::channel(None).1, None),
        },
        input,
        output,
        stop,
    )
}

#[tokio::test]
async fn room_control_open_before_driver_notification_survives_deadline_and_resync() -> Result<()> {
    let mut f = support::Fixture::new(support::vp8()).await?;
    let pair = f.sink;
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        f.withheld.insert(pair);
        f.until(|f| f.driver.pairs[&pair].pending_offer.is_some()).await?;
        f.release_offer(pair).await?;
        // Hold the real channel-open notification while the Driver takes its deadline turn.
        let opened = loop {
            let event = f.events.recv().await.context("Driver event queue closed")?;
            if matches!(event, Event::Dc(id, _, true) if id == pair) {
                break event;
            }
        };
        let p = &f.driver.pairs[&pair];
        let token = p.dc.as_ref().context("missing control binding")?.0;
        ensure!(p.connected() && p.data.senders().current(Lane::Control, token, true));
        f.driver.pairs.get_mut(&pair).unwrap().deadline = Some(Deadline::Control(Instant::now()));
        f.driver.deadlines().await;
        let p = &f.driver.pairs[&pair];
        ensure!(!p.room_data_failed, "deadline retired an open room control binding");
        ensure!(p.deadline.is_none() && p.dc.as_ref().is_some_and(|dc| dc.0 == token));
        f.driver.resync().await;
        f.driver.event(opened).await?;
        let mut reports = Vec::new();
        while let Ok(command) = f.commands.try_recv() {
            if let NativeEvent::Command(Command::RoomDataState { pair_id, room_id, ready }) = command {
                if pair_id == pair { reports.push((room_id, ready)); }
            }
        }
        ensure!(reports == [("room".into(), true), ("room".into(), true)],
            "expected first readiness and authenticated resync, got {reports:?}");
        Ok::<_, anyhow::Error>(())
    }).await;
    f.close().await;
    result?
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
    d.ice = vec![IceServer {
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
        udp_preparation: Some(piik_channel_core::wire::UdpPreparation::Available),
        rooms: vec!["initial".into()],
        incoming: vec![],
        outgoing: vec![],
    };
    d.update(vec![plan.clone()], vec![], vec![]).await;
    assert!(d.pairs.contains_key(&plan.id) && d.preparings.len() == 1);
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
    d.update(vec![plan.clone()], vec![], vec![]).await;
    assert_eq!(d.preparings[&plan.id].task.id(), task);
    assert_eq!(d.pairs[&plan.id].plan.rooms, vec!["latest"]);
    assert_eq!(d.preparings[&plan.id].instance, d.pairs[&plan.id].pc.instance);
    d.update(vec![], vec![], vec![]).await;
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
    d.watches.close().await;
    d.transport.close().await;
    Ok(())
}

#[tokio::test]
async fn close_cancels_a_full_command_output() -> Result<()> {
    let (tx, commands) = mpsc::channel(1);
    let mut native = NativePeers::new(Uuid::nil(), vec![], tx);
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
            vec![],
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(commands.len(), 1);
    tokio::time::timeout(Duration::from_secs(3), native.close()).await??;
    Ok(())
}

#[tokio::test]
async fn driver_ends_with_an_error_when_its_transport_runtime_stops() -> Result<()> {
    let fixed = server_udp::ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
    let holder = transport::Runtime::new(Some(fixed.clone()));
    // The round trip proves the holder owns the lease, so the Driver's runtime stops at once.
    let (held, _) = support::endpoint(&holder, Uuid::new_v4()).await?;
    let (tx, _commands) = mpsc::channel(8);
    let mut native =
        NativePeers::with_input(Uuid::nil(), vec![], tx, watch::channel(None).1, None, Some(fixed));
    let result = tokio::time::timeout(Duration::from_secs(3), &mut native.task)
        .await
        .context("Driver outlived its transport runtime")??;
    let error = result.expect_err("a stopped runtime is a Driver failure");
    ensure!(
        format!("{error:#}").contains("native transport runtime stopped"),
        "unexpected Driver failure: {error:#}"
    );
    held.close().await?;
    holder.close().await;
    Ok(())
}
#[path = "tests/watch.rs"]
mod watch_bytes;
