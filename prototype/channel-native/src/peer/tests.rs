use super::*;
use piik_channel_core::wire::{FlowBinding, Kind};

fn driver() -> (
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
            session: Uuid::nil(),
            ice: vec![],
            commands,
            links: Arc::new(Mutex::new(HashMap::new())),
            cancel,
            events,
            ready_sources,
            bandwidth_changed: Arc::new(Notify::new()),
            pairs: HashMap::new(),
            publications: HashMap::new(),
            sources: HashMap::new(),
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            captures: HashMap::new(),
            relay: Relay::default(),
            files: Files::new(Uuid::nil()),
            inputs: input::Inputs::new(Uuid::nil(), watch::channel(None).1, None),
        },
        input,
        output,
        stop,
    )
}

async fn output(
    d: &mut Driver,
    pair: Uuid,
    flow: Uuid,
    publication: Uuid,
    kind: RtpCodecKind,
) -> Result<Uuid> {
    let input = Uuid::new_v4();
    let source = Source {
        id: Uuid::new_v4(),
        publication_id: publication,
        origin: SourceOrigin::Incoming {
            flow_id: input,
            pair: Uuid::new_v4(),
            stream: Uuid::new_v4().to_string(),
        },
        codec: if kind == RtpCodecKind::Audio {
            codec()
        } else {
            RTCRtpCodec {
                mime_type: "video/VP8".into(),
                clock_rate: 90_000,
                ..Default::default()
            }
        },
        kind,
        feed: SourceFeed::Rtp {
            keyframes: watch::channel(0).0,
            report: Arc::new(Mutex::new(None)),
        },
    };
    let p = d.pairs.get_mut(&pair).unwrap();
    let input = if let Some(binding) = p.plan.outgoing.iter().find(|binding| binding.id == flow) {
        binding.input_flow_id.unwrap()
    } else {
        p.plan.outgoing.push(FlowBinding {
            id: flow,
            publication_id: publication,
            input_flow_id: Some(input),
            selected: true,
        });
        input
    };
    let source = Source {
        origin: SourceOrigin::Incoming {
            flow_id: input,
            pair: Uuid::new_v4(),
            stream: Uuid::new_v4().to_string(),
        },
        ..source
    };
    let next = Output::new(
        &*p.pc,
        &source,
        Uuid::new_v4().to_string(),
        pair,
        (flow, kind),
        d.events.clone(),
        p.reports.clone(),
    )
    .await?;
    let id = next.id;
    p.outputs.insert((flow, kind), next);
    d.sources.retain(|_, old| {
        !(old.kind == kind
            && matches!(old.origin, SourceOrigin::Incoming { flow_id, .. } if flow_id == input))
    });
    d.sources.insert(source.id, source);
    Ok(id)
}

async fn negotiate(d: &mut Driver, pair: Uuid, remote: &dyn PeerConnection) -> Result<()> {
    if d.pairs[&pair].pending_offer.is_none() {
        d.offer(pair).await?;
    }
    let offer = d.pairs[&pair]
        .pending_offer
        .as_ref()
        .unwrap()
        .signal
        .clone();
    remote
        .set_remote_description(serde_json::from_value(serde_json::json!({
            "type":"offer", "sdp":offer.description.unwrap().sdp.unwrap()
        }))?)
        .await?;
    remote
        .set_local_description(remote.create_answer(None).await?)
        .await?;
    d.signal(
        pair,
        Signal {
            description: Some(Description {
                kind: "answer".into(),
                sdp: Some(remote.local_description().await.unwrap().sdp),
            }),
            exchange_id: offer.exchange_id,
            tracks: Some(vec![]),
            candidate: None,
            resync: None,
        },
    )
    .await
}

#[tokio::test]
async fn rejected_ice_candidates_preserve_connectivity_and_the_open_channel() -> Result<()> {
    let (mut d, mut events, _commands, _stop) = driver();
    let pair = Uuid::new_v4();
    d.update(
        vec![PairInfo {
            id: pair,
            peer_id: Uuid::new_v4(),
            rooms: vec!["room".into()],
            incoming: vec![],
            outgoing: vec![],
        }],
        vec![],
        vec![],
    )
    .await?;
    let remote_id = Uuid::new_v4();
    let remote = builder(true, SenderReports::default(), MediaFeedback::default())?
        .with_handler(Arc::new(Handler {
            pair: remote_id,
            events: d.events.clone(),
            overflow: Arc::new(AtomicBool::new(false)),
            state: Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8)),
        }))
        .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
        .build()
        .await?;
    let bad = Candidate {
        candidate: Some("candidate:invalid".into()),
        sdp_mid: Some("0".into()),
        sdp_m_line_index: Some(0),
        username_fragment: None,
    };
    let signal = |candidate| Signal {
        candidate: Some(candidate),
        description: None,
        tracks: None,
        exchange_id: None,
        resync: None,
    };
    // Overflow is disposable input too; it must not prevent the pending SDP
    // and later real candidates from establishing this same physical pair.
    for _ in 0..129 {
        d.signal(pair, signal(bad.clone())).await?;
    }
    assert_eq!(d.pairs[&pair].candidates.len(), 128);
    negotiate(&mut d, pair, &remote).await?;
    let channel = tokio::time::timeout(Duration::from_secs(10), async {
        let mut channel = None;
        loop {
            if d.pairs[&pair].connected() && channel.is_some() {
                return Ok::<_, anyhow::Error>(channel.unwrap());
            }
            match events.recv().await.unwrap() {
                Event::Candidate(id, candidate) if id == pair => {
                    remote.add_ice_candidate(candidate.to_json()?).await?;
                }
                Event::Candidate(_, candidate) => {
                    d.signal(pair, signal(signal_candidate(candidate)?)).await?;
                }
                Event::Channel(id, current) if id == remote_id => {
                    if current.label().await? == "piik-room" {
                        channel = Some(current);
                    }
                }
                _ => {}
            }
        }
    })
    .await??;
    let base = d.pairs[&pair].dc.as_ref().unwrap().1.clone();
    for rejected in [false, true] {
        if rejected {
            assert!(
                d.pairs[&pair]
                    .pc
                    .add_ice_candidate(ice_candidate(bad.clone()))
                    .await
                    .is_err(),
                "the actual SDK rejects this candidate"
            );
            d.signal(pair, signal(bad.clone())).await?;
        }
        let text = if rejected {
            "after rejection"
        } else {
            "before rejection"
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while base.ready_state().await? != rtc::data_channel::RTCDataChannelState::Open {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            base.send_text(text).await?;
            while let Some(event) = channel.poll().await {
                if let webrtc::data_channel::DataChannelEvent::OnMessage(message) = event {
                    assert_eq!(message.data.as_ref(), text.as_bytes());
                    return Ok::<_, anyhow::Error>(());
                }
            }
            Err(anyhow!("channel closed after a rejected candidate"))
        })
        .await??;
    }
    assert!(d.pairs[&pair].connected());
    close_pair(d.pairs.remove(&pair).unwrap()).await;
    remote.close().await?;
    Ok(())
}

#[tokio::test]
async fn physical_pair_failure_retires_resources_without_revoking_base_leases() -> Result<()> {
    let (mut d, mut events, mut commands, _stop) = driver();
    let live = Uuid::new_v4();
    let failed = Uuid::new_v4();
    let publication = Uuid::new_v4();
    d.update(
        [live, failed]
            .into_iter()
            .map(|id| PairInfo {
                id,
                peer_id: Uuid::new_v4(),
                rooms: vec!["room".into()],
                incoming: vec![],
                outgoing: vec![],
            })
            .collect(),
        vec![PublicationInfo {
            id: publication,
            kind: Kind::Voice,
            room_id: "room".into(),
            session_id: d.session,
            user_id: d.session,
            muted: false,
        }],
        vec![],
    )
    .await?;
    let flow = Uuid::new_v4();
    output(&mut d, live, flow, publication, RtpCodecKind::Audio).await?;
    let source = d.pairs[&live].outputs[&(flow, RtpCodecKind::Audio)].source;
    if let SourceOrigin::Incoming { pair, .. } = &mut d.sources.get_mut(&source).unwrap().origin {
        *pair = failed;
    }
    // Local and other physical pairs' sources survive this retirement.
    let mut local = d.sources[&source].clone();
    local.id = Uuid::new_v4();
    local.origin = SourceOrigin::Local;
    let local_id = local.id;
    d.sources.insert(local.id, local);
    let mut other = d.sources[&source].clone();
    other.id = Uuid::new_v4();
    other.origin = SourceOrigin::Incoming {
        pair: Uuid::new_v4(),
        flow_id: Uuid::new_v4(),
        stream: "other".into(),
    };
    let other_id = other.id;
    d.sources.insert(other.id, other);
    let downstream = d.pairs[&live].outputs[&(flow, RtpCodecKind::Audio)]
        .rtp_sink()
        .unwrap();
    d.relay.set(source, vec![downstream.clone()]);
    let failed_flow = Uuid::new_v4();
    output(
        &mut d,
        failed,
        failed_flow,
        publication,
        RtpCodecKind::Audio,
    )
    .await?;
    let retired_writer = d.pairs[&failed].outputs[&(failed_flow, RtpCodecKind::Audio)]
        .rtp_sink()
        .unwrap();
    let failed_peer = d.pairs[&failed].plan.peer_id;
    let failed_token = d.pairs[&failed].dc.as_ref().unwrap().0;
    let failed_state = d.pairs[&failed].state.clone();
    let senders = d.pairs[&failed].data.senders();
    let remote_id = Uuid::new_v4();
    let remote = builder(true, SenderReports::default(), MediaFeedback::default())?
        .with_handler(Arc::new(Handler {
            pair: remote_id,
            events: d.events.clone(),
            overflow: Arc::new(AtomicBool::new(false)),
            state: Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8)),
        }))
        .with_udp_addrs(vec!["0.0.0.0:0".into()])
        .build()
        .await?;
    negotiate(&mut d, live, &remote).await?;
    let channel = tokio::time::timeout(Duration::from_secs(10), async {
        let mut channel = None;
        loop {
            if d.pairs[&live].connected() && channel.is_some() {
                return Ok::<_, anyhow::Error>(channel.unwrap());
            }
            match events.recv().await.unwrap() {
                Event::Candidate(id, candidate) if id == live => {
                    remote.add_ice_candidate(candidate.to_json()?).await?;
                }
                Event::Candidate(id, candidate) if id == remote_id => {
                    d.pairs[&live]
                        .pc
                        .add_ice_candidate(candidate.to_json()?)
                        .await?;
                }
                Event::Channel(id, current) if id == remote_id => {
                    if current.label().await? == "piik-room" {
                        channel = Some(current);
                    }
                }
                _ => {}
            }
        }
    })
    .await
    .context("physical retirement fixture transport readiness")??;
    let base = d.pairs[&live].dc.as_ref().unwrap().1.clone();
    tokio::time::timeout(Duration::from_secs(5), async {
        while base.ready_state().await? != rtc::data_channel::RTCDataChannelState::Open {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    while commands.try_recv().is_ok() {}
    // The atomic PC failure can precede its State event and arrive as DC close.
    failed_state.store(RTCPeerConnectionState::Failed as u8, Ordering::Release);
    d.event(Event::Dc(failed, failed_token, false)).await?;
    assert!(!d.pairs.contains_key(&failed));
    assert!(!d.links.lock().unwrap().contains_key(&failed_peer));
    assert!(!d.sources.contains_key(&source));
    assert!(d.sources.contains_key(&local_id) && d.sources.contains_key(&other_id));
    assert!(downstream.is_closed() && retired_writer.is_closed());
    assert!(senders.control.is_closed() && senders.bulk.is_closed() && senders.input.is_closed());
    assert_eq!(
        failed_state.load(Ordering::Acquire),
        RTCPeerConnectionState::Closed as u8
    );
    let mut transitions = vec![];
    while let Ok(event) = commands.try_recv() {
        match event {
            NativeEvent::Command(Command::LinkState {
                pair_id,
                state: LinkState::Failed,
            }) => transitions.push(pair_id),
            NativeEvent::Command(Command::BaseState { ready: false, .. }) => {
                panic!("physical failure revoked logical base")
            }
            NativeEvent::Command(Command::FlowState {
                state: FlowState::Failed,
                ..
            }) => panic!("source retirement rejected another flow"),
            _ => {}
        }
    }
    assert_eq!(transitions, vec![failed]);
    for event in [
        Event::Dc(failed, failed_token, false),
        Event::State(failed, RTCPeerConnectionState::Failed),
        Event::DataWriteFailed {
            pair: failed,
            lane: Lane::Control,
            token: failed_token,
            temporary: true,
        },
    ] {
        d.event(event).await?;
    }
    assert!(
        commands.try_recv().is_err(),
        "old callbacks cannot fail the retired pair again"
    );
    assert!(d.pairs[&live].connected());
    base.send_text("sibling survives physical retirement")
        .await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = channel.poll().await {
            if let DataChannelEvent::OnMessage(message) = event {
                assert_eq!(
                    message.data.as_ref(),
                    b"sibling survives physical retirement"
                );
                return Ok::<_, anyhow::Error>(());
            }
        }
        Err(anyhow!("sibling channel closed"))
    })
    .await??;
    // An independently closed control channel on a still-connected PC retains
    // that transport and reports only the logical base failure.
    let live_token = d.pairs[&live].dc.as_ref().unwrap().0;
    d.event(Event::Dc(live, live_token, false)).await?;
    assert!(d.pairs[&live].connected());
    assert!(d.pairs[&live].base_failed);
    assert!(
        matches!(commands.try_recv()?, NativeEvent::Command(Command::BaseState { pair_id, ready: false, .. }) if pair_id == live)
    );
    assert!(commands.try_recv().is_err());
    d.pairs[&live]
        .state
        .store(RTCPeerConnectionState::Closed as u8, Ordering::Release);
    d.event(Event::State(live, RTCPeerConnectionState::Closed))
        .await?;
    assert!(!d.pairs.contains_key(&live));
    remote.close().await?;
    d.files.close().await;
    Ok(())
}

#[tokio::test]
async fn optional_opaque_admission_preserves_selected_rtp_and_the_open_channel() -> Result<()> {
    async fn message(channel: &dyn DataChannel, expected: &str) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = channel.poll().await {
                if let webrtc::data_channel::DataChannelEvent::OnMessage(message) = event {
                    assert_eq!(message.data.as_ref(), expected.as_bytes());
                    return Ok(());
                }
            }
            Err(anyhow!("remote channel closed before delivery"))
        })
        .await?
    }
    async fn packet(track: &dyn TrackRemote) -> Result<rtp::Packet> {
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = track.poll().await {
                if let TrackRemoteEvent::OnRtpPacket(packet) = event {
                    return Ok(packet);
                }
            }
            Err(anyhow!("remote track closed before RTP arrived"))
        })
        .await?
    }
    let (mut d, mut events, mut commands, _stop) = driver();
    let pair = Uuid::new_v4();
    d.update(
        vec![PairInfo {
            id: pair,
            peer_id: Uuid::new_v4(),
            rooms: vec!["room".into()],
            incoming: vec![],
            outgoing: vec![],
        }],
        vec![],
        vec![],
    )
    .await?;
    let voice = Uuid::new_v4();
    let screen = Uuid::new_v4();
    for (id, kind) in [(voice, Kind::Voice), (screen, Kind::Screen)] {
        d.publications.insert(
            id,
            PublicationInfo {
                id,
                kind,
                room_id: "room".into(),
                session_id: d.session,
                user_id: d.session,
                muted: false,
            },
        );
    }
    let selected = Uuid::new_v4();
    output(&mut d, pair, selected, voice, RtpCodecKind::Audio).await?;
    d.refresh_outputs().await?;
    let selected_key = (selected, RtpCodecKind::Audio);
    let selected_output = &d.pairs[&pair].outputs[&selected_key];
    let selected_id = selected_output.id;
    let selected_sender = selected_output.sender.id();
    let selected_source = selected_output.source;
    let pc = d.pairs[&pair].pc.clone();
    let remote_id = Uuid::new_v4();
    let remote = builder(true, SenderReports::default(), MediaFeedback::default())?
        .with_handler(Arc::new(Handler {
            pair: remote_id,
            events: d.events.clone(),
            overflow: Arc::new(AtomicBool::new(false)),
            state: Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8)),
        }))
        .with_udp_addrs(vec!["0.0.0.0:0".into()])
        .build()
        .await?;
    negotiate(&mut d, pair, &remote).await?;
    let channel = tokio::time::timeout(Duration::from_secs(10), async {
        let mut channel = None;
        loop {
            if d.pairs[&pair].connected() && channel.is_some() {
                return Ok::<_, anyhow::Error>(channel.unwrap());
            }
            match events.recv().await.unwrap() {
                Event::Candidate(id, candidate) if id == pair => {
                    remote.add_ice_candidate(candidate.to_json()?).await?;
                }
                Event::Candidate(_, candidate) => {
                    pc.add_ice_candidate(candidate.to_json()?).await?;
                }
                Event::Channel(id, current) if id == remote_id => {
                    if current.label().await? == "piik-room" {
                        channel = Some(current);
                    }
                }
                _ => {}
            }
        }
    })
    .await??;
    let base = d.pairs[&pair].dc.as_ref().unwrap().1.clone();
    tokio::time::timeout(Duration::from_secs(5), async {
        while base.ready_state().await? != rtc::data_channel::RTCDataChannelState::Open {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let rtp = |sequence_number, size| rtp::Packet {
        header: rtp::header::Header {
            version: 2,
            sequence_number,
            timestamp: u32::from(sequence_number) * 960,
            marker: true,
            ..Default::default()
        },
        payload: vec![0xf8; size].into(),
    };
    d.relay.write(selected_source, rtp(1, 88));
    let selected_track = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Event::Track(id, track)) = events.recv().await {
                if id == remote_id {
                    return track;
                }
            }
        }
    })
    .await?;
    assert_eq!(packet(&*selected_track).await?.header.sequence_number, 1);
    base.send_text("before admission").await?;
    message(&*channel, "before admission").await?;

    let optional = Uuid::new_v4();
    let incoming = Uuid::new_v4();
    d.pairs
        .get_mut(&pair)
        .unwrap()
        .plan
        .outgoing
        .push(FlowBinding {
            id: optional,
            publication_id: screen,
            input_flow_id: Some(incoming),
            selected: false,
        });
    let mut source_ids = Vec::new();
    for kind in [RtpCodecKind::Video, RtpCodecKind::Audio] {
        let source = Source {
            id: Uuid::new_v4(),
            publication_id: screen,
            kind,
            origin: SourceOrigin::Incoming {
                pair: Uuid::new_v4(),
                flow_id: incoming,
                stream: Uuid::new_v4().to_string(),
            },
            codec: if kind == RtpCodecKind::Audio {
                codec()
            } else {
                RTCRtpCodec {
                    mime_type: "video/VP8".into(),
                    clock_rate: 90_000,
                    ..Default::default()
                }
            },
            feed: SourceFeed::Rtp {
                keyframes: watch::channel(0).0,
                report: Default::default(),
            },
        };
        source_ids.push((source.id, kind));
        d.sources.insert(source.id, source);
    }
    let (target, bandwidth) = watch::channel(100_000.0);
    d.pairs.get_mut(&pair).unwrap().bandwidth = bandwidth;
    d.refresh_outputs().await?;
    assert_eq!(d.pairs[&pair].outputs.len(), 1, "unknown trials must wait");
    assert!(d.pairs[&pair].rejected_outputs.is_empty());
    for (source, kind) in &source_ids {
        d.relay.write(
            *source,
            rtp(
                10,
                if *kind == RtpCodecKind::Video {
                    988
                } else {
                    188
                },
            ),
        );
    }
    tokio::time::sleep(Duration::from_millis(1100)).await;
    d.refresh_outputs().await?;
    let admitted: Vec<_> = source_ids
        .iter()
        .map(|(_, kind)| {
            let out = &d.pairs[&pair].outputs[&(optional, *kind)];
            (out.id, out.sender.id(), out.rtp_sink().unwrap())
        })
        .collect();
    assert_eq!(d.pairs[&pair].outputs.len(), 3);
    d.refresh_outputs().await?;
    for ((_, kind), (id, sender, _)) in source_ids.iter().zip(&admitted) {
        let out = &d.pairs[&pair].outputs[&(optional, *kind)];
        assert_eq!(out.id, *id);
        assert_eq!(out.sender.id(), *sender);
    }
    negotiate(&mut d, pair, &remote).await?;
    for (source, kind) in &source_ids {
        d.relay.write(
            *source,
            rtp(
                11,
                if *kind == RtpCodecKind::Video {
                    988
                } else {
                    188
                },
            ),
        );
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut received = HashSet::new();
        while received.len() < 2 {
            if let Some(Event::Track(id, track)) = events.recv().await {
                if id == remote_id {
                    assert_eq!(packet(&*track).await?.header.sequence_number, 11);
                    received.insert(track.kind().await);
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    while commands.try_recv().is_ok() {}
    let now = Instant::now();
    let selected_cost = d.relay.bitrate(selected_source, now).unwrap();
    let optional_cost: u64 = source_ids
        .iter()
        .map(|(source, _)| d.relay.bitrate(*source, now).unwrap())
        .sum();
    assert!(selected_cost < 1_600 && selected_cost + optional_cost > 1_600);
    target.send_replace(1_600.0);
    d.refresh_outputs().await?;
    d.refresh_outputs().await?;
    let p = &d.pairs[&pair];
    assert_eq!(p.outputs.len(), 1);
    assert_eq!(p.outputs[&selected_key].id, selected_id);
    assert_eq!(p.outputs[&selected_key].sender.id(), selected_sender);
    assert!(Arc::ptr_eq(&p.pc, &pc));
    assert!(Arc::ptr_eq(&p.dc.as_ref().unwrap().1, &base));
    assert!(p.connected());
    let senders: HashSet<_> = pc
        .get_senders()
        .await
        .iter()
        .map(|sender| sender.id())
        .collect();
    for (_, sender, sink) in admitted {
        assert!(sink.is_closed(), "the actual candidate writer must retire");
        assert!(!senders.contains(&sender));
    }
    let failed: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok())
        .filter_map(|event| match event {
            NativeEvent::Command(Command::FlowState {
                flow_id,
                state: FlowState::Failed,
                ..
            }) => Some(flow_id),
            NativeEvent::Command(Command::LinkState {
                state: LinkState::Failed,
                ..
            }) => panic!("shared pair failed"),
            _ => None,
        })
        .collect();
    assert_eq!(failed, vec![optional]);
    // A new companion track does not revive this still-leased failed trial,
    // even after its input is measured and connection headroom returns.
    let old_audio = source_ids
        .iter()
        .find(|(_, kind)| *kind == RtpCodecKind::Audio)
        .unwrap()
        .0;
    let mut late_audio = d.sources.remove(&old_audio).unwrap();
    late_audio.id = Uuid::new_v4();
    let late_audio_id = late_audio.id;
    d.sources.insert(late_audio_id, late_audio);
    target.send_replace(100_000.0);
    d.refresh_outputs().await?;
    d.relay.write(late_audio_id, rtp(12, 188));
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let admission = d.bandwidth_plans(Instant::now());
    assert!(!admission[&pair].waiting.contains(&optional));
    assert!(!admission[&pair].rejected.contains(&optional));
    d.refresh_outputs().await?;
    assert_eq!(d.pairs[&pair].outputs.len(), 1);
    assert_eq!(d.pairs[&pair].outputs[&selected_key].id, selected_id);
    assert!(
        !std::iter::from_fn(|| commands.try_recv().ok()).any(|event| matches!(
            event,
            NativeEvent::Command(Command::FlowState {
                state: FlowState::Failed,
                ..
            })
        ))
    );
    d.relay.write(selected_source, rtp(2, 88));
    assert_eq!(packet(&*selected_track).await?.header.sequence_number, 2);
    base.send_text("after rejection").await?;
    message(&*channel, "after rejection").await?;
    close_pair(d.pairs.remove(&pair).unwrap()).await;
    remote.close().await?;
    Ok(())
}

#[tokio::test]
async fn ipv6_candidates_connect_and_release_their_udp_ports() -> Result<()> {
    use std::net::{IpAddr, Ipv6Addr, SocketAddr};

    match std::net::UdpSocket::bind((Ipv6Addr::LOCALHOST, 0)) {
        Ok(socket) => drop(socket),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
            ) =>
        {
            eprintln!("IPv6 loopback is unavailable: {error}");
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    }
    let (mut d, mut events, _commands, _stop) = driver();
    let pair = Uuid::new_v4();
    d.update(
        vec![PairInfo {
            id: pair,
            peer_id: Uuid::new_v4(),
            rooms: vec!["room".into()],
            incoming: vec![],
            outgoing: vec![],
        }],
        vec![],
        vec![],
    )
    .await?;
    let remote_id = Uuid::new_v4();
    let remote = builder(true, SenderReports::default(), MediaFeedback::default())?
        .with_handler(Arc::new(Handler {
            pair: remote_id,
            events: d.events.clone(),
            overflow: Arc::new(AtomicBool::new(false)),
            state: Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8)),
        }))
        .with_udp_addrs(vec!["[::1]:0".into()])
        .build()
        .await?;
    negotiate(&mut d, pair, &remote).await?;
    let mut ports = HashSet::new();
    let channel = tokio::time::timeout(Duration::from_secs(5), async {
        let mut channel = None;
        loop {
            if d.pairs[&pair].connected() && channel.is_some() {
                return Ok::<_, anyhow::Error>(channel.unwrap());
            }
            match events.recv().await.unwrap() {
                Event::Candidate(id, candidate) => {
                    let candidate = signal_candidate(candidate)?;
                    let fields: Vec<_> = candidate
                        .candidate
                        .as_deref()
                        .unwrap()
                        .split_whitespace()
                        .collect();
                    let ip: IpAddr = fields[4].parse()?;
                    if !ip.is_ipv6() {
                        continue;
                    }
                    ports.insert(SocketAddr::new(ip, fields[5].parse()?));
                    if id == pair {
                        remote.add_ice_candidate(ice_candidate(candidate)).await?;
                    } else {
                        d.signal(
                            pair,
                            Signal {
                                candidate: Some(candidate),
                                description: None,
                                tracks: None,
                                exchange_id: None,
                                resync: None,
                            },
                        )
                        .await?;
                    }
                }
                Event::Channel(id, current) if id == remote_id => {
                    if current.label().await? == "piik-room" {
                        channel = Some(current);
                    }
                }
                _ => {}
            }
        }
    })
    .await;
    let result = async {
        let channel = channel??;
        assert!(ports.len() >= 2, "both PCs must gather an IPv6 candidate");
        let base = d.pairs[&pair].dc.as_ref().unwrap().1.clone();
        tokio::time::timeout(Duration::from_secs(5), async {
            while base.ready_state().await? != rtc::data_channel::RTCDataChannelState::Open {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            base.send_text("IPv6 transport").await?;
            while let Some(event) = channel.poll().await {
                if let webrtc::data_channel::DataChannelEvent::OnMessage(message) = event {
                    assert_eq!(message.data.as_ref(), b"IPv6 transport");
                    return Ok::<_, anyhow::Error>(());
                }
            }
            Err(anyhow!("IPv6 channel closed before delivery"))
        })
        .await??;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    close_pair(d.pairs.remove(&pair).unwrap()).await;
    remote.close().await?;
    result?;
    for address in ports {
        std::net::UdpSocket::bind(address)
            .with_context(|| format!("IPv6 UDP port retained after PC close: {address}"))?;
    }
    Ok(())
}

#[tokio::test]
async fn local_video_output_keeps_its_sender_clock_and_recovers_current_encoding() -> Result<()> {
    use crate::{
        capture::EncodedFrame,
        media::{packetizer::CaptureTime, video::Video},
    };
    use rtc::shared::time::SystemInstant;

    async fn packet(track: &dyn TrackRemote) -> Result<rtp::Packet> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(TrackRemoteEvent::OnRtpPacket(packet)) = track.poll().await {
                    return packet;
                }
            }
        })
        .await
        .map_err(Into::into)
    }

    let (mut d, mut events, _commands, _stop) = driver();
    let pair = Uuid::new_v4();
    let flow = Uuid::new_v4();
    let publication = Uuid::new_v4();
    d.update(
        vec![PairInfo {
            id: pair,
            peer_id: Uuid::new_v4(),
            rooms: vec![],
            incoming: vec![],
            outgoing: vec![FlowBinding {
                id: flow,
                publication_id: publication,
                input_flow_id: None,
                selected: true,
            }],
        }],
        vec![PublicationInfo {
            id: publication,
            kind: Kind::Screen,
            room_id: "room".into(),
            session_id: d.session,
            user_id: d.session,
            muted: false,
        }],
        vec![],
    )
    .await?;
    let epoch = Instant::now() - Duration::from_secs(1);
    let time = CaptureTime {
        epoch,
        clock: SystemInstant::now(epoch),
    };
    let changed = Arc::new(Notify::new());
    let high = Video::new(time, changed.clone());
    let low = Video::new(time, changed);
    let mut high_requests = high.requests();
    let mut low_requests = low.requests();
    let source = Source {
        id: Uuid::new_v4(),
        publication_id: publication,
        origin: SourceOrigin::Local,
        kind: RtpCodecKind::Video,
        codec: RTCRtpCodec {
            mime_type: "video/H264".into(),
            clock_rate: 90_000,
            sdp_fmtp_line: "packetization-mode=1;profile-level-id=42c01f".into(),
            ..Default::default()
        },
        feed: SourceFeed::Video(high.clone()),
    };
    let source_id = source.id;
    d.sources.insert(source.id, source);
    d.refresh_outputs().await?;
    let key = (flow, RtpCodecKind::Video);
    let output_id = d.pairs[&pair].outputs[&key].id;
    let sender_id = d.pairs[&pair].outputs[&key].sender.id();
    let stream = d.pairs[&pair].outputs[&key].stream.clone();
    let frame = |tag, keyframe, ms| EncodedFrame {
        // Complete NAL units exercise the real SDK packetizer/PC. Hardware AU
        // decoding is covered by the capture-to-browser acceptance fixture.
        bytes: vec![0, 0, 0, 1, if keyframe { 0x65 } else { 0x41 }, tag, 0x80],
        presentation_time: time.epoch + Duration::from_millis(ms),
        keyframe,
    };

    // Until SDP is confirmed the real writer cannot drain its AU mailbox.
    let requested = *high_requests.borrow_and_update();
    high.write(frame(1, true, 0));
    high.write(frame(2, false, 20));
    high.write(frame(3, false, 40));
    assert_eq!(*high_requests.borrow_and_update(), requested);
    high.write(frame(4, false, 60));
    assert!(!high_requests.has_changed()?);

    let remote_id = Uuid::new_v4();
    let remote: Arc<dyn PeerConnection> = Arc::new(
        builder(true, SenderReports::default(), MediaFeedback::default())?
            .with_handler(Arc::new(Handler {
                pair: remote_id,
                events: d.events.clone(),
                overflow: Arc::new(AtomicBool::new(false)),
                state: Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8)),
            }))
            .with_udp_addrs(vec!["0.0.0.0:0".into()])
            .build()
            .await?,
    );
    negotiate(&mut d, pair, &*remote).await?;
    d.pairs[&pair].outputs[&key]
        .video_input()
        .unwrap()
        .upgrade()
        .unwrap()
        .set_active(true);
    tokio::time::timeout(Duration::from_secs(10), async {
        while !d.pairs[&pair].connected() {
            if let Some(Event::Candidate(id, candidate)) = events.recv().await {
                let candidate = signal_candidate(candidate)?;
                if id == pair {
                    remote.add_ice_candidate(ice_candidate(candidate)).await?;
                } else {
                    d.pairs[&pair]
                        .pc
                        .add_ice_candidate(ice_candidate(candidate))
                        .await?;
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    tokio::time::timeout(Duration::from_secs(5), high_requests.changed()).await??;
    assert!(*high_requests.borrow_and_update() > requested);
    high.write(frame(5, true, 100));
    let track = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Event::Track(id, track)) = events.recv().await {
                if id == remote_id {
                    return track;
                }
            }
        }
    })
    .await?;
    let first = packet(&*track).await?;
    assert_eq!(first.payload[1], 5); // No dependent P frame survived the overflow.

    // An optional switch keeps the incumbent until the candidate supplies IDR.
    d.pairs[&pair].outputs[&key]
        .video_input()
        .unwrap()
        .upgrade()
        .unwrap()
        .select(&low, false)?;
    let requested = *low_requests.borrow_and_update();
    low.write(frame(6, false, 120));
    // A restarted encoder's old static IDR must request a fresh IDR, not wrap RTP time.
    low.write(frame(7, true, 50));
    assert_eq!(*low_requests.borrow_and_update(), requested + 1);
    high.write(frame(8, false, 140));
    let incumbent = packet(&*track).await?;
    assert_eq!(incumbent.payload[1], 8);
    low.write(frame(9, true, 200));
    let switched = packet(&*track).await?;
    assert_eq!(switched.payload[1], 9);
    assert_eq!(switched.header.ssrc, first.header.ssrc);
    assert_eq!(
        switched
            .header
            .timestamp
            .wrapping_sub(first.header.timestamp),
        9_000
    );
    assert_eq!(
        switched.header.sequence_number,
        incumbent.header.sequence_number.wrapping_add(1)
    );
    high.write(frame(10, false, 220));
    low.write(frame(11, false, 260));
    assert_eq!(packet(&*track).await?.payload[1], 11);

    high_requests.borrow_and_update();
    low_requests.borrow_and_update();
    track
        .write_rtcp(vec![Box::new(PictureLossIndication {
            sender_ssrc: 1,
            media_ssrc: first.header.ssrc,
        })])
        .await?;
    tokio::time::timeout(Duration::from_secs(5), low_requests.changed()).await??;
    assert!(!high_requests.has_changed()?);

    let report = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(TrackRemoteEvent::OnRtcpPacket(packets)) = track.poll().await {
                for packet in packets {
                    if let Some(report) = packet.as_any().downcast_ref::<SenderReport>() {
                        return report.clone();
                    }
                }
            }
        }
    })
    .await?;
    assert_eq!(report.ssrc, first.header.ssrc);
    let elapsed = report
        .ntp_time
        .wrapping_sub(time.clock.ntp(time.epoch + Duration::from_millis(100)));
    let expected = ((elapsed as u128 * 90_000) >> 32) as u32;
    assert!(
        report
            .rtp_time
            .wrapping_sub(first.header.timestamp)
            .abs_diff(expected)
            <= 2
    );
    let output = &d.pairs[&pair].outputs[&key];
    assert_eq!(output.id, output_id);
    assert_eq!(output.source, source_id);
    assert_eq!(output.sender.id(), sender_id);
    assert_eq!(output.stream, stream);
    close_pair(d.pairs.remove(&pair).unwrap()).await;
    remote.close().await?;
    Ok(())
}

#[tokio::test]
async fn local_offer_failure_releases_only_its_new_outputs_on_a_live_pair() -> Result<()> {
    let (mut d, mut events, mut commands, _stop) = driver();
    let pair = Uuid::new_v4();
    let other_pair = Uuid::new_v4();
    d.update(
        vec![
            PairInfo {
                id: pair,
                peer_id: Uuid::new_v4(),
                rooms: vec!["room".into()],
                incoming: vec![],
                outgoing: vec![],
            },
            PairInfo {
                id: other_pair,
                peer_id: Uuid::new_v4(),
                rooms: vec![],
                incoming: vec![],
                outgoing: vec![],
            },
        ],
        vec![],
        vec![],
    )
    .await?;
    let remote_id = Uuid::new_v4();
    let remote: Arc<dyn PeerConnection> = Arc::new(
        builder(true, SenderReports::default(), MediaFeedback::default())?
            .with_handler(Arc::new(Handler {
                pair: remote_id,
                events: d.events.clone(),
                overflow: Arc::new(AtomicBool::new(false)),
                state: Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8)),
            }))
            .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
            .build()
            .await?,
    );
    let voice = Uuid::new_v4();
    let screen = Uuid::new_v4();
    for (id, kind) in [(voice, Kind::Voice), (screen, Kind::Screen)] {
        d.publications.insert(
            id,
            PublicationInfo {
                id,
                kind,
                room_id: "room".into(),
                session_id: d.session,
                user_id: d.session,
                muted: false,
            },
        );
    }
    let voice_flow = Uuid::new_v4();
    let screen_flow = Uuid::new_v4();
    output(&mut d, pair, voice_flow, voice, RtpCodecKind::Audio).await?;
    output(&mut d, pair, screen_flow, screen, RtpCodecKind::Video).await?;
    negotiate(&mut d, pair, &*remote).await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !d.pairs[&pair].connected() {
            if let Some(Event::Candidate(id, candidate)) = events.recv().await {
                let candidate = signal_candidate(candidate)?;
                if id == pair {
                    remote.add_ice_candidate(ice_candidate(candidate)).await?;
                } else {
                    d.pairs[&pair]
                        .pc
                        .add_ice_candidate(ice_candidate(candidate))
                        .await?;
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let other_remote = builder(true, SenderReports::default(), MediaFeedback::default())?
        .with_handler(Arc::new(Handler {
            pair: Uuid::new_v4(),
            events: d.events.clone(),
            overflow: Arc::new(AtomicBool::new(false)),
            state: Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8)),
        }))
        .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
        .build()
        .await?;
    let other_flow = Uuid::new_v4();
    output(&mut d, other_pair, other_flow, voice, RtpCodecKind::Audio).await?;
    negotiate(&mut d, other_pair, &other_remote).await?;
    while commands.try_recv().is_ok() {}
    let stable = d.pairs[&pair].output_ids();
    let old_senders: HashSet<_> = d.pairs[&pair]
        .pc
        .get_senders()
        .await
        .iter()
        .map(|s| s.id())
        .collect();
    let base = d.pairs[&pair].dc.as_ref().unwrap().1.clone();
    tokio::time::timeout(Duration::from_secs(5), async {
        while base.ready_state().await? != rtc::data_channel::RTCDataChannelState::Open {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let added_voice = Uuid::new_v4();
    output(&mut d, pair, added_voice, voice, RtpCodecKind::Audio).await?;
    output(&mut d, pair, screen_flow, screen, RtpCodecKind::Audio).await?;
    let added: Vec<_> = d.pairs[&pair]
        .outputs
        .values()
        .filter(|out| !stable.contains(&out.id))
        .map(|out| (out.sender.id(), out.rtp_sink().unwrap()))
        .collect();
    let attempted = d.pairs[&pair].output_ids();
    // A sender added after this attempt's snapshot belongs to later work.
    let late_flow = Uuid::new_v4();
    let late = output(&mut d, pair, late_flow, voice, RtpCodecKind::Audio).await?;
    // The SDK seals PeerConnection, so inject the API result at this private
    // boundary while exercising real negotiated PCs, senders and writers.
    d.finish_offer(pair, true, attempted, Err(anyhow!("local offer rejected")))
        .await?;
    let p = &d.pairs[&pair];
    assert!(p.connected());
    assert!(p.output_ids().is_superset(&stable));
    assert!(p.output_ids().contains(&late));
    let senders: HashSet<_> = p.pc.get_senders().await.iter().map(|s| s.id()).collect();
    assert!(senders.is_superset(&old_senders));
    for (sender, sink) in added {
        assert!(!senders.contains(&sender));
        assert!(sink.is_closed());
    }
    let failed: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok())
        .filter_map(|event| match event {
            NativeEvent::Command(Command::FlowState {
                flow_id,
                state: FlowState::Failed,
                ..
            }) => Some(flow_id),
            NativeEvent::Command(Command::LinkState {
                state: LinkState::Failed,
                ..
            }) => panic!("shared pair failed"),
            _ => None,
        })
        .collect();
    assert_eq!(failed, vec![added_voice]);
    base.send_text("base survives").await?;
    for sequence_number in 47..50 {
        d.pairs[&pair].outputs[&(voice_flow, RtpCodecKind::Audio)]
            .rtp_sink()
            .unwrap()
            .send(rtp::Packet {
                header: rtp::header::Header {
                    version: 2,
                    sequence_number,
                    timestamp: 48_000 + u32::from(sequence_number - 47) * 960,
                    ..Default::default()
                },
                payload: vec![0xf8, 0xff, 0xfe].into(),
            })
            .await?;
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Event::Track(id, track)) = events.recv().await {
                if id == remote_id {
                    while let Some(event) = track.poll().await {
                        if let TrackRemoteEvent::OnRtpPacket(packet) = event {
                            if packet.header.sequence_number >= 47 {
                                return;
                            }
                        }
                    }
                }
            }
        }
    })
    .await?;
    d.refresh_media(false).await?;
    assert!(!d.pairs[&pair]
        .outputs
        .contains_key(&(added_voice, RtpCodecKind::Audio)));
    // A successful remote exchange confirms its own senders; it does not
    // consume the local failure's right to retry after resources are released.
    remote
        .set_local_description(remote.create_offer(None).await?)
        .await?;
    let exchange = Uuid::new_v4();
    d.signal(
        pair,
        Signal {
            description: Some(Description {
                kind: "offer".into(),
                sdp: Some(remote.local_description().await.unwrap().sdp),
            }),
            exchange_id: Some(exchange),
            tracks: Some(vec![]),
            candidate: None,
            resync: None,
        },
    )
    .await?;
    let answer = d.pairs[&pair].answer.as_ref().unwrap();
    assert_eq!(answer.exchange_id, Some(exchange));
    remote
        .set_remote_description(serde_json::from_value(serde_json::json!({
            "type":"answer", "sdp":answer.description.as_ref().unwrap().sdp
        }))?)
        .await?;
    d.refresh_media(false).await?;
    assert!(!d.pairs[&pair]
        .outputs
        .contains_key(&(screen_flow, RtpCodecKind::Audio)));
    let released = d.pairs[&other_pair].outputs[&(other_flow, RtpCodecKind::Audio)]
        .rtp_sink()
        .unwrap();
    d.pairs
        .get_mut(&other_pair)
        .unwrap()
        .plan
        .outgoing
        .retain(|flow| flow.id != other_flow);
    d.refresh_media(false).await?;
    assert!(released.is_closed());
    assert!(d.pairs[&pair]
        .outputs
        .contains_key(&(screen_flow, RtpCodecKind::Audio)));
    assert!(d.pairs[&pair].output_ids().is_superset(&stable));
    assert!(d.pairs[&pair].output_ids().contains(&late));
    assert!(!d.pairs[&pair]
        .outputs
        .contains_key(&(added_voice, RtpCodecKind::Audio)));
    negotiate(&mut d, pair, &*remote).await?;
    let admitted = d.pairs[&pair].output_ids();
    d.refresh_media(false).await?;
    d.refresh_media(false).await?;
    assert_eq!(d.pairs[&pair].output_ids(), admitted);
    assert!(d.pairs[&pair].pending_offer.is_none());
    // A local failure without new work is also contained and not retried.
    let attempted = d.pairs[&pair].output_ids();
    d.finish_offer(pair, true, attempted, Err(anyhow!("no new work")))
        .await?;
    d.offer(pair).await?;
    assert!(d.pairs[&pair].pending_offer.is_none());
    // A replacement is new work even when RTC reuses the same sender slot.
    // The retired source is never reinstated after its replacement fails.
    let old = d
        .pairs
        .get_mut(&pair)
        .unwrap()
        .outputs
        .remove(&(voice_flow, RtpCodecKind::Audio))
        .unwrap();
    let retired = old.rtp_sink().unwrap();
    old.close(&*d.pairs[&pair].pc).await;
    let replacement = output(&mut d, pair, voice_flow, voice, RtpCodecKind::Audio).await?;
    let rejected = d.pairs[&pair].outputs[&(voice_flow, RtpCodecKind::Audio)]
        .rtp_sink()
        .unwrap();
    let attempted = d.pairs[&pair].output_ids();
    d.finish_offer(pair, true, attempted, Err(anyhow!("replacement rejected")))
        .await?;
    assert!(retired.is_closed() && rejected.is_closed());
    assert!(!d.pairs[&pair].output_ids().contains(&replacement));
    assert!(!d.pairs[&pair]
        .outputs
        .contains_key(&(voice_flow, RtpCodecKind::Audio)));
    assert!(std::iter::from_fn(|| commands.try_recv().ok()).any(|event| matches!(event,
        NativeEvent::Command(Command::FlowState { flow_id, state: FlowState::Failed, .. }) if flow_id == voice_flow)));
    let binding = d.pairs[&pair]
        .plan
        .outgoing
        .iter()
        .find(|binding| binding.id == voice_flow)
        .copied()
        .unwrap();
    d.pairs
        .get_mut(&pair)
        .unwrap()
        .plan
        .outgoing
        .retain(|binding| binding.id != voice_flow);
    d.refresh_media(false).await?;
    d.pairs.get_mut(&pair).unwrap().plan.outgoing.push(binding);
    d.refresh_media(false).await?;
    let readmitted = &d.pairs[&pair].outputs[&(voice_flow, RtpCodecKind::Audio)];
    assert!(d.pairs[&pair]
        .pc
        .get_senders()
        .await
        .iter()
        .any(|sender| sender.id() == readmitted.sender.id()));
    negotiate(&mut d, pair, &*remote).await?;
    let failed = &d.pairs[&pair].outputs[&(voice_flow, RtpCodecKind::Audio)];
    let (source, output_id, writer) = (failed.source, failed.id, failed.rtp_sink().unwrap());
    d.event(Event::OutputFailed {
        pair,
        key: (voice_flow, RtpCodecKind::Audio),
        source,
        output: output_id,
    })
    .await?;
    assert!(writer.is_closed());
    // The route owner has not yet withdrawn this flow. Other endpoint work
    // cannot recreate its failed writer from the still-current source.
    d.refresh_media(false).await?;
    d.refresh_media(false).await?;
    assert!(!d.pairs[&pair]
        .outputs
        .contains_key(&(voice_flow, RtpCodecKind::Audio)));
    assert!(d.pairs[&pair]
        .outputs
        .contains_key(&(screen_flow, RtpCodecKind::Video)));
    // A new companion's local-offer failure retires the entire optional flow,
    // including its previously negotiated primary, while selected work stays.
    let optional = Uuid::new_v4();
    output(&mut d, pair, optional, screen, RtpCodecKind::Video).await?;
    d.pairs
        .get_mut(&pair)
        .unwrap()
        .plan
        .outgoing
        .iter_mut()
        .find(|binding| binding.id == optional)
        .unwrap()
        .selected = false;
    negotiate(&mut d, pair, &*remote).await?;
    let selected: HashSet<_> = d.pairs[&pair]
        .outputs
        .iter()
        .filter(|(key, _)| key.0 != optional)
        .map(|(_, out)| out.id)
        .collect();
    output(&mut d, pair, optional, screen, RtpCodecKind::Audio).await?;
    let optional_writers: Vec<_> = d.pairs[&pair]
        .outputs
        .iter()
        .filter(|(key, _)| key.0 == optional)
        .map(|(_, out)| (out.sender.id(), out.rtp_sink().unwrap()))
        .collect();
    while commands.try_recv().is_ok() {}
    let attempted = d.pairs[&pair].output_ids();
    d.finish_offer(
        pair,
        true,
        attempted,
        Err(anyhow!("optional companion rejected")),
    )
    .await?;
    assert_eq!(d.pairs[&pair].output_ids(), selected);
    assert!(d.pairs[&pair].connected());
    assert!(Arc::ptr_eq(&d.pairs[&pair].dc.as_ref().unwrap().1, &base));
    let senders: HashSet<_> = d.pairs[&pair]
        .pc
        .get_senders()
        .await
        .iter()
        .map(|sender| sender.id())
        .collect();
    for (sender, writer) in optional_writers {
        assert!(writer.is_closed());
        assert!(!senders.contains(&sender));
    }
    let failed: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok())
        .filter_map(|event| match event {
            NativeEvent::Command(Command::FlowState {
                flow_id,
                state: FlowState::Failed,
                ..
            }) => Some(flow_id),
            NativeEvent::Command(Command::LinkState {
                state: LinkState::Failed,
                ..
            }) => panic!("shared pair failed"),
            _ => None,
        })
        .collect();
    assert_eq!(failed, vec![optional]);
    let attempted = d.pairs[&pair].output_ids();
    assert!(d
        .finish_offer(pair, false, attempted, Err(anyhow!("initial offer")))
        .await
        .is_err());
    // An error after SDP has actually entered have-local-offer is outside
    // this recovery boundary, even before application signaling is sent.
    let pc = d.pairs[&pair].pc.clone();
    pc.set_local_description(pc.create_offer(None).await?)
        .await?;
    let attempted = d.pairs[&pair].output_ids();
    assert!(d
        .finish_offer(pair, true, attempted, Err(anyhow!("installed offer")))
        .await
        .is_err());
    remote.close().await?;
    other_remote.close().await?;
    close_pair(d.pairs.remove(&other_pair).unwrap()).await;
    close_pair(d.pairs.remove(&pair).unwrap()).await;
    d.files.close().await;
    Ok(())
}
