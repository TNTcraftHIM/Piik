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
            #[cfg(target_os = "windows")]
            captures: HashMap::new(),
            relay: Relay::default(),
            files: Files::new(Uuid::nil()),
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
                    remote.add_ice_candidate(ice_candidate(candidate)).await?;
                }
                Event::Candidate(_, candidate) => {
                    d.signal(pair, signal(candidate)).await?;
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
        vec![],
        vec![],
    )
    .await?;
    d.publications.insert(
        publication,
        PublicationInfo {
            id: publication,
            kind: Kind::Screen,
            room_id: "room".into(),
            session_id: d.session,
            user_id: d.session,
            muted: false,
        },
    );
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

    d.pairs[&pair].outputs[&key]
        .video_input()
        .unwrap()
        .upgrade()
        .unwrap()
        .select(&low, true)?;
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
    let (source, output, writer) = (failed.source, failed.id, failed.rtp_sink().unwrap());
    d.event(Event::OutputFailed {
        pair,
        key: (voice_flow, RtpCodecKind::Audio),
        source,
        output,
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
