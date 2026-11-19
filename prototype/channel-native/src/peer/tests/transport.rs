use super::*;

#[tokio::test]
async fn source_ended_before_ready_fails_only_its_current_flow() -> Result<()> {
    use crate::{
        media::MediaKind,
        peer::{
            tests::{
                driver,
                support::{video_payloads, vp8},
            },
            NativeEvent, Pair,
        },
    };
    use piik_channel_core::wire::{
        Command as WireCommand, FlowBinding, FlowState, Kind, PublicationInfo,
    };

    let (mut driver, mut events, mut reports, _stop) = driver();
    let (ready, mut sources) = mpsc::channel(8);
    driver.ready_sources = ready;
    let pair = Uuid::new_v4();
    let (commands, receiver) = mpsc::channel(1);
    drop(receiver); // Exercise Driver/Track queues without constructing a network engine.
    let pc = Transport {
        pair,
        instance: Uuid::new_v4(),
        tx: commands,
    };
    let state = Arc::new(AtomicU8::new(PeerState::Connected as u8));
    let data = crate::data::DataLink::new(pair, state.clone(), driver.events.clone());
    let (demand, _) = watch::channel(BandwidthDemand {
        minimum_bps: 0,
        desired_bps: Some(0),
    });
    let (_, bandwidth) = watch::channel(Estimate::Startup(0.0));
    let screen = Uuid::new_v4();
    let voice = Uuid::new_v4();
    let flows = [(screen, Kind::Screen), (voice, Kind::Voice)].map(|(publication, kind)| {
        driver.publications.insert(
            publication,
            PublicationInfo {
                screen: (kind == Kind::Screen).then(|| piik_channel_core::wire::ScreenInfo {
                    direct_limit: None,
                    source: Default::default(),
                    title: None,
                }),
                id: publication,
                room_id: "room".into(),
                session_id: Uuid::new_v4(),
                user_id: Uuid::new_v4(),
                kind,
                paused: false,
                audience: vec![],
                video_settings: None,
            },
        );
        FlowBinding {
            id: Uuid::new_v4(),
            publication_id: publication,
            input_flow_id: None,
            selected: true,
        }
    });
    driver.pairs.insert(
        pair,
        Pair {
            plan: piik_channel_core::wire::PairInfo {
                id: pair,
                peer_id: Uuid::new_v4(),
                rooms: vec![],
                incoming: flows.to_vec(),
                outgoing: vec![],
                udp_preparation: None,
                can_receive_video_layers: false,
            },
            pc: pc.clone(),
            mapping: None,
            polite: true,
            pending_offer: None,
            stable_outputs: None,
            failed_offer: None,
            answer: None,
            negotiate: false,
            ignore_offer: false,
            candidates: vec![],
            remote: HashMap::from([
                ("screen".into(), flows[0].id),
                ("voice".into(), flows[1].id),
            ]),
            latest: HashMap::new(),
            outputs: HashMap::new(),
            rejected_outputs: HashMap::new(),
            reports: Default::default(),
            bandwidth,
            demand,
            tasks: HashMap::new(),
            dc: None,
            bulk: None,
            input: None,
            data,
            state,
            dc_open: false,
            base_failed: false,
            reported: HashSet::new(),
            deadline: None,
            overflow: Arc::new(AtomicBool::new(false)),
        },
    );
    let track = |stream: &str, kind, codec: RtpCodec| {
        let (send, receive) = mpsc::channel(8);
        (
            Track {
                transport: pc.clone(),
                mid: "0".into(),
                stream: stream.into(),
                id: format!("{stream}-track"),
                kind,
                rids: vec![],
                first_ssrc: 1,
                first_codec: RtpCodecParameters {
                    rtp_codec: codec,
                    payload_type: 96,
                },
                packets: Arc::new(tokio::sync::Mutex::new(receive)),
                encodings: Default::default(),
                reports: Arc::new(Mutex::new(HashMap::from([(
                    1,
                    (
                        SourceClockReport {
                            ssrc: 1,
                            ntp_time: 0,
                            rtp_time: 0,
                        },
                        Instant::now(),
                    ),
                )]))),
            },
            send,
        )
    };
    let packet = |payload, sequence, marker| rtp::Packet {
        header: rtp::header::Header {
            version: 2,
            ssrc: 1,
            timestamp: 3000,
            sequence_number: sequence,
            marker,
            ..Default::default()
        },
        payload,
    };
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        let (audio, audio_packets) = track("voice", MediaKind::Audio, crate::peer::codec());
        driver.track(pair, audio).await?;
        audio_packets.send(TrackEvent::Rtp(packet(vec![0xf8, 0xff, 0xfe].into(), 1, true), 1, 3000, crate::peer::codec())).await?;
        let audio = sources.recv().await.context("voice source")?;
        let audio_id = audio.source.id;
        driver.source_ready(audio).await;
        let audio_reader = driver.pairs[&pair].latest[&(flows[1].id, MediaKind::Audio)];
        while reports.try_recv().is_ok() {}

        let (video, video_packets) = track("screen", MediaKind::Video, vp8());
        driver.track(pair, video).await?;
        let key = (flows[0].id, MediaKind::Video);
        let reader = driver.pairs[&pair].latest[&key];
        let payloads = video_payloads(&vp8(), 1, true)?;
        let count = payloads.len();
        for (index, payload) in payloads.into_iter().enumerate() {
            video_packets.send(TrackEvent::Rtp(packet(payload, index as u16 + 1, index + 1 == count), index as u64 + 1, 3000, vp8())).await?;
        }
        video_packets.send(TrackEvent::End).await?;
        let ended = events.recv().await.context("reader terminal event")?;
        ensure!(matches!(ended, Event::SourceEnded { pair: ended_pair, key: ended_key, reader: ended_reader }
            if ended_pair == pair && ended_key == key && ended_reader == reader));
        ensure!(sources.len() == 1 && driver.sources.len() == 1, "Ready must remain queued when End is consumed");
        while !driver.pairs[&pair].tasks[&reader].task.is_finished() {
            tokio::task::yield_now().await;
        }
        // Unrelated Track/plan work must not forget a queued terminal event's owner.
        let (companion, companion_packets) = track("screen", MediaKind::Audio, crate::peer::codec());
        driver.track(pair, companion).await?;
        let plan = driver.pairs[&pair].plan.clone();
        driver.apply_pair(plan).await?;
        driver.event(ended).await?;
        let ready = sources.recv().await.context("queued video Ready")?;
        let ended_source = ready.source.id;
        driver.source_ready(ready).await;
        driver.event(Event::SourceEnded { pair, key, reader }).await?;

        ensure!(!driver.sources.contains_key(&ended_source), "late Ready revived its ended reader");
        ensure!(driver.pairs[&pair].connected() && driver.pairs[&pair].pc.instance == pc.instance);
        ensure!(!driver.pairs[&pair].latest.contains_key(&key) && !driver.pairs[&pair].tasks.contains_key(&reader));
        ensure!(driver.sources.contains_key(&audio_id) && driver.pairs[&pair].latest[&(flows[1].id, MediaKind::Audio)] == audio_reader);
        // An unready selected screen-audio reader is optional to its picture.
        companion_packets.send(TrackEvent::End).await?;
        driver.event(events.recv().await.context("companion audio end")?).await?;
        // A source declaration can change before a successor has produced a Track.
        let (old, old_packets) = track("screen", MediaKind::Video, vp8());
        driver.track(pair, old).await?;
        old_packets.send(TrackEvent::End).await?;
        let old_end = events.recv().await.context("withdrawn stream end")?;
        let current = driver.pairs.get_mut(&pair).unwrap();
        current.remote.remove("screen");
        current.remote.insert("replacement".into(), flows[0].id);
        driver.event(old_end).await?;
        // An older reader's queued End cannot retire a newer reader on the same flow.
        let (old, old_packets) = track("replacement", MediaKind::Video, vp8());
        driver.track(pair, old).await?;
        old_packets.send(TrackEvent::End).await?;
        let old_end = events.recv().await.context("superseded reader end")?;
        let (next, _next_packets) = track("replacement", MediaKind::Video, vp8());
        driver.track(pair, next).await?;
        let next_reader = driver.pairs[&pair].latest[&key];
        driver.event(old_end).await?;
        ensure!(driver.pairs[&pair].latest[&key] == next_reader && driver.pairs[&pair].tasks.contains_key(&next_reader));
        let (received, mut packets) = mpsc::channel(1);
        driver.relay.set(audio_id, vec![received]);
        audio_packets.send(TrackEvent::Rtp(packet(vec![0xf8, 0xff, 0xfe].into(), 2, true), 2, 3960, crate::peer::codec())).await?;
        ensure!(packets.recv().await.is_some(), "sibling voice reader stopped");
        let reports: Vec<_> = std::iter::from_fn(|| reports.try_recv().ok()).collect();
        ensure!(matches!(reports.as_slice(), [NativeEvent::Command(WireCommand::FlowState {
            pair_id, flow_id, state: FlowState::Failed,
        })] if *pair_id == pair && *flow_id == key.0), "ended current video must report one scoped failure before Ready");
        Ok(())
    }).await.unwrap_or_else(|error| Err(error.into()));
    for (_, pair) in std::mem::take(&mut driver.pairs) {
        crate::peer::close_pair(pair).await;
    }
    driver.files.close().await;
    driver.watches.close().await;
    driver.transport.close().await;
    result
}

#[tokio::test]
async fn cancelled_driver_pair_retirement_keeps_real_child_joins() -> Result<()> {
    use crate::peer::{tests::driver, Pair, Reader};
    use std::future::Future;

    let (mut driver, _events, _commands, _stop) = driver();
    // Use the real Transport command boundary without binding any UDP socket.
    let (commands, mut requests) = mpsc::channel(8);
    let id = Uuid::new_v4();
    let instance = Uuid::new_v4();
    let pc = Transport {
        pair: id,
        instance,
        tx: commands,
    };
    let state = Arc::new(AtomicU8::new(PeerState::Connected as u8));
    let data = crate::data::DataLink::new(id, state.clone(), driver.events.clone());
    let (demand, _) = watch::channel(BandwidthDemand {
        minimum_bps: 0,
        desired_bps: Some(0),
    });
    let (_, bandwidth) = watch::channel(Estimate::Startup(0.0));
    let (started, running) = oneshot::channel();
    let (ended, mut dropped) = oneshot::channel();
    struct Ended(Option<oneshot::Sender<()>>);
    impl Drop for Ended {
        fn drop(&mut self) {
            if let Some(done) = self.0.take() {
                let _ = done.send(());
            }
        }
    }
    let reader = tokio::spawn(async move {
        let _ended = Ended(Some(ended));
        let _ = started.send(());
        std::future::pending::<()>().await;
    });
    let observer = reader.abort_handle();
    running.await?;
    driver.pairs.insert(
        id,
        Pair {
            plan: piik_channel_core::wire::PairInfo {
                id,
                peer_id: Uuid::new_v4(),
                rooms: vec![],
                incoming: vec![],
                outgoing: vec![],
                udp_preparation: None,
                can_receive_video_layers: false,
            },
            pc,
            mapping: None,
            polite: false,
            pending_offer: None,
            stable_outputs: None,
            failed_offer: None,
            answer: None,
            negotiate: false,
            ignore_offer: false,
            candidates: vec![],
            remote: HashMap::new(),
            latest: HashMap::new(),
            outputs: HashMap::new(),
            rejected_outputs: HashMap::new(),
            reports: crate::media::OutputStreams::default(),
            bandwidth,
            demand,
            tasks: HashMap::from([(
                Uuid::new_v4(),
                Reader {
                    key: (Uuid::new_v4(), MediaKind::Video),
                    track: "retiring".into(),
                    stream: "retiring".into(),
                    task: reader,
                },
            )]),
            dc: None,
            bulk: None,
            input: None,
            data,
            state,
            dc_open: false,
            base_failed: false,
            reported: HashSet::new(),
            deadline: None,
            overflow: Arc::new(AtomicBool::new(false)),
        },
    );
    let mut retirement = Box::pin(driver.retire_pair(id));
    let done = tokio::select! {
        result = &mut retirement => panic!("retirement completed before transport removal: {result}"),
        request = requests.recv() => match request {
            Some(Command::Remove(pair, generation, done)) => {
                assert_eq!((pair, generation), (id, instance));
                done
            }
            _ => panic!("expected actual Transport::close removal request"),
        },
    };
    drop(retirement); // Driver's stop select cancels this exact work future.
    assert!(driver.pairs.is_empty());
    assert!(!observer.is_finished());
    let mut shutdown = Box::pin(driver.finish_pair_retirement());
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(shutdown.as_mut().poll(cx).is_pending()))
            .await
    );
    assert!(dropped.try_recv().is_err());
    done.send(()).unwrap();
    shutdown.await;
    assert!(
        observer.is_finished(),
        "Driver shutdown must join the removed Pair reader"
    );
    dropped.await?;
    assert!(driver.retiring_pair.get_mut().unwrap().is_none());
    driver.files.close().await;
    driver.watches.close().await;
    driver.transport.close().await;
    Ok(())
}

async fn completed_source_check(assigned: bool) -> JoinHandle<bool> {
    let task = tokio::spawn(async move { assigned });
    while !task.is_finished() {
        tokio::task::yield_now().await;
    }
    task
}

#[tokio::test]
async fn source_checks_preserve_current_paths_and_shared_socket_siblings() -> Result<()> {
    use crate::peer::tests::support::{endpoint, exchange, open};
    let fixed = ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
    let server = Runtime::new(Some(fixed.clone()));
    let remote = Runtime::new(None);
    let (first, mut first_events) = endpoint(&server, Uuid::new_v4(), None).await?;
    let (first_peer, mut first_peer_events) = endpoint(
        &remote,
        Uuid::new_v4(),
        Some(std::net::UdpSocket::bind("127.0.0.1:0")?),
    )
    .await?;
    let (second, _) = endpoint(&server, Uuid::new_v4(), None).await?;
    let (second_peer, mut second_peer_events) = endpoint(
        &remote,
        Uuid::new_v4(),
        Some(std::net::UdpSocket::bind("127.0.0.1:0")?),
    )
    .await?;
    let (first_send, first_receive) = open(&first, &first_peer, &mut first_peer_events)
        .await
        .context("first shared listener peer")?;
    let (second_send, second_receive) = open(&second, &second_peer, &mut second_peer_events)
        .await
        .context("second shared listener peer")?;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !first
            .call(|engine| Ok(engine.selected_source().is_some()))
            .await?
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("selected source observation")??;
    let present = completed_source_check(true).await;
    first
        .call(move |engine| {
            let source = engine.selected_source().unwrap();
            let error = std::io::Error::from(std::io::ErrorKind::NetworkUnreachable);
            let mut probe = source;
            probe.set_port(source.port().wrapping_add(1));
            engine.send_failed(probe, source, &error);
            ensure!(
                engine.source_error.is_none(),
                "unrelated candidate probe became selected-path failure"
            );
            engine.send_failed(source, source, &error);
            engine.source_check = Some((Some(source), present));
            engine.check_source();
            ensure!(
                engine.source_check.is_none()
                    && engine.source_error == Some(source)
                    && engine.rtc.is_alive(),
                "assigned source was failed or its present result cached"
            );
            Ok(())
        })
        .await?;
    exchange(&first_send, &first_receive, "assigned-source-survives").await?;
    let stale_absent = completed_source_check(false).await;
    first
        .call(move |engine| {
            let source = engine.selected_source().unwrap();
            ensure!(
                engine.source_error.is_none(),
                "successful traffic retained the failure fact"
            );
            engine.source_check = Some((Some(source), stale_absent));
            engine.sent_from(source);
            engine.send_failed(
                source,
                source,
                &std::io::Error::from(std::io::ErrorKind::NetworkUnreachable),
            );
            engine.check_source();
            ensure!(
                engine.rtc.is_alive() && engine.source_check.is_none(),
                "completed old absent result survived success followed by a new error"
            );
            Ok(())
        })
        .await?;
    let absent = completed_source_check(false).await;
    first
        .call(move |engine| {
            let source = engine.selected_source().unwrap();
            engine.send_failed(
                source,
                source,
                &std::io::Error::from(std::io::ErrorKind::NetworkUnreachable),
            );
            engine.source_check = Some((Some(source), absent));
            engine.check_source();
            ensure!(
                !engine.rtc.is_alive()
                    && engine.state.load(Ordering::Acquire) == PeerState::Failed as u8,
                "removed selected source did not retire the SDK through pair failure"
            );
            Ok(())
        })
        .await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = first_events.recv().await {
            if matches!(event, Event::State(_, PeerState::Failed)) {
                return Ok::<_, anyhow::Error>(());
            }
        }
        anyhow::bail!("source loss did not enter existing pair failure")
    })
    .await??;
    first.close().await?;
    exchange(&second_send, &second_receive, "shared-socket-sibling").await?;
    exchange(&second_receive, &second_send, "shared-socket-return").await?;
    first_peer.close().await?;
    second.close().await?;
    second_peer.close().await?;
    server.close().await;
    remote.close().await;
    ensure!(
        fixed.sockets[0].local_addr().is_ok(),
        "pair retirement closed service socket"
    );
    Ok(())
}

#[tokio::test]
async fn source_check_task_retires_with_its_transport() -> Result<()> {
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let runtime = Runtime::new(Some(ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?));
    let (transport, _) =
        crate::peer::tests::support::endpoint(&runtime, Uuid::new_v4(), None).await?;
    let dropped = Arc::new(AtomicBool::new(false));
    let guard = Dropped(dropped.clone());
    transport
        .call(move |engine| {
            engine.source_check = Some((
                None,
                tokio::spawn(async move {
                    let _guard = guard;
                    std::future::pending::<bool>().await
                }),
            ));
            Ok(())
        })
        .await?;
    transport.close().await?;
    ensure!(
        dropped.load(Ordering::Acquire),
        "retirement did not cancel and join verification"
    );
    runtime.close().await;
    Ok(())
}
#[path = "admission.rs"]
mod admission;
#[path = "bulk.rs"]
mod bulk;
#[path = "codec_change.rs"]
mod codec_change;
#[path = "feedback.rs"]
mod feedback;
#[path = "media_reuse.rs"]
mod media_reuse;

#[cfg(any(target_os = "windows", target_os = "linux"))]
#[tokio::test]
async fn fixed_udp_selects_each_bound_address_and_preserves_wildcard_sending() -> Result<()> {
    use crate::peer::tests::support::{endpoint, exchange, open};

    for wildcard in [false, true] {
        let reserved = std::net::UdpSocket::bind("127.0.0.1:0")?;
        let port = reserved.local_addr()?.port();
        drop(reserved);
        let selected = SocketAddr::from(([127, 0, 0, 2], port));
        let bindings = if wildcard {
            vec![(SocketAddr::from(([0, 0, 0, 0], port)), None)]
        } else {
            vec![
                (SocketAddr::from(([127, 0, 0, 1], port)), None),
                (selected, None),
            ]
        };
        let server = Runtime::new(Some(ServerUdp::bind(&bindings)?));
        let remote = Runtime::new(Some(ServerUdp::bind(&[("127.0.0.3:0".parse()?, None)])?));
        let (sender, mut candidates) = endpoint(&server, Uuid::new_v4(), None).await?;
        let (receiver, mut events) = endpoint(&remote, Uuid::new_v4(), None).await?;
        let candidates: Vec<_> = std::iter::from_fn(|| candidates.try_recv().ok())
            .filter_map(|event| match event {
                Event::Candidate(_, candidate, _) => Some(candidate),
                _ => None,
            })
            .collect();
        let result = async {
            sender
                .call(move |engine| {
                    // Keep both real sockets, while ICE uses the second local base.
                    // Wildcard interface enumeration excludes loopback; admit this
                    // owned loopback address through the same SDK candidate API.
                    for candidate in candidates {
                        if candidate.addr() != selected {
                            ensure!(engine.rtc.direct_api().invalidate_candidate(&candidate));
                        }
                    }
                    if wildcard {
                        ensure!(engine
                            .rtc
                            .add_local_candidate(Candidate::host(selected, "udp")?)
                            .is_some());
                    }
                    Ok(())
                })
                .await?;
            let (sent, received) = open(&sender, &receiver, &mut events).await?;
            exchange(&sent, &received, "selected-local-base").await?;
            exchange(&received, &sent, "return-to-local-base").await?;
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(source) = sender.call(|engine| Ok(engine.selected_source())).await?
                    {
                        ensure!(source == selected, "ICE selected another local base");
                        return Ok::<_, anyhow::Error>(());
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await??;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        sender.close().await?;
        receiver.close().await?;
        server.close().await;
        remote.close().await;
        result.with_context(|| format!("fixed UDP wildcard={wildcard}"))?;
    }
    Ok(())
}

fn h264_profiles(profiles: &[u32]) -> str0m::format::CodecConfig {
    str0m::format::CodecConfig::new_from_payload_params(
        crate::media::h264_codecs()
            .params()
            .iter()
            .filter(|p| {
                p.spec()
                    .format
                    .profile_level_id
                    .is_some_and(|id| profiles.contains(&id))
            })
            .copied()
            .collect(),
    )
}

#[test]
fn transit_without_derivation_advertises_cb_while_local_input_keeps_all_profiles() -> Result<()> {
    for (local_input, can_derive, expected_profiles) in [
        (false, false, vec![0x42e01f]),
        (
            true,
            false,
            vec![0x42001f, 0x42e01f, 0x4d001f, 0x64001f, 0x640c1f],
        ),
        (
            false,
            true,
            vec![0x42001f, 0x42e01f, 0x4d001f, 0x64001f, 0x640c1f],
        ),
    ] {
        let mut builder = Rtc::builder().clear_codecs();
        *builder.codec_config() = transport_codecs(local_input, can_derive);
        let mut rtc = builder.build(Instant::now());
        let mut changes = rtc.sdp_api();
        changes.add_media(MediaKind::Video, Direction::SendOnly, None, None, None);
        changes.add_media(MediaKind::Audio, Direction::SendOnly, None, None, None);
        let (offer, _) = changes.apply().context("missing codec offer")?;
        let mut profiles = Vec::new();
        let mut vp8 = false;
        let mut opus = false;
        for params in offer.media_lines.iter().flat_map(|line| line.rtp_params()) {
            match params.spec().codec {
                Codec::H264 => {
                    ensure!(params.spec().format.packetization_mode == Some(1));
                    profiles.push(
                        params
                            .spec()
                            .format
                            .profile_level_id
                            .context("missing profile")?,
                    );
                }
                Codec::Vp8 => vp8 = true,
                Codec::Opus => opus = true,
                _ => {}
            }
        }
        profiles.sort_unstable();
        ensure!(profiles == expected_profiles);
        ensure!(vp8 == !local_input && opus);
    }
    Ok(())
}

#[tokio::test]
async fn negotiated_profiles_map_actual_au_codec_on_one_sender() -> Result<()> {
    use crate::peer::tests::support::endpoint;
    let profiles = h264_profiles(&[0x42e01f, 0x64001f]);
    let baseline = codec(&profiles.params()[0]).rtp_codec;
    let high = codec(&profiles.params()[1]).rtp_codec;
    let left = Runtime::new(None).with_codecs(profiles.clone());
    let right = Runtime::new(None).with_codecs(profiles);
    let (tx, _) = endpoint(&left, Uuid::new_v4(), None).await?;
    let (rx, mut events) = endpoint(&right, Uuid::new_v4(), None).await?;
    let result = async {
        let id = Uuid::new_v4();
        let (_, writable, _) = tx
            .add_output(
                id,
                high.clone(),
                MediaKind::Video,
                "profiles".into(),
                vec![],
            )
            .await?;
        tx.offer().await?;
        let (kind, sdp) = tx.local_description().await?;
        rx.accept(kind, sdp).await?;
        let (kind, sdp) = rx.local_description().await?;
        tx.accept(kind, sdp).await?;
        let alternatives = tx
            .confirm(id)
            .await?
            .flatten()
            .context("unconfirmed output")?;
        ensure!(
            alternatives.len() == 2,
            "negotiation lost a profile alternative"
        );
        let mut track = None::<Track>;
        let mut received = Vec::new();
        // Codec-independent IDR payload exercises RTP mapping; no decoder claim.
        for (index, actual) in [high, baseline].into_iter().enumerate() {
            let mut packets = vec![rtp::Packet {
                header: rtp::header::Header {
                    version: 2,
                    marker: true,
                    timestamp: 90000 + index as u32 * 3000,
                    ..Default::default()
                },
                payload: vec![0x65, 0x88, 0x84].into(),
            }];
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let ready = writable.notified();
                    tokio::pin!(ready);
                    ready.as_mut().enable();
                    match tx
                        .write_au(id, String::new(), actual.clone(), packets, Instant::now())
                        .await?
                    {
                        None => break,
                        Some(pending) => packets = pending,
                    }
                    ready.await;
                }
                if track.is_none() {
                    while let Some(event) = events.recv().await {
                        if let Event::Track(_, incoming) = event {
                            track = Some(incoming);
                            break;
                        }
                    }
                }
                let incoming = track.as_ref().context("missing received track")?;
                while let Some(event) = incoming.poll().await {
                    if let TrackEvent::Rtp(packet, _, _, negotiated) = event {
                        let expected = alternatives
                            .iter()
                            .find(|c| crate::media::compatible(&actual, &c.rtp_codec))
                            .context("missing actual profile")?;
                        ensure!(packet.header.payload_type == expected.payload_type);
                        ensure!(crate::media::compatible(&actual, &negotiated));
                        received.push(packet);
                        return Ok::<_, anyhow::Error>(());
                    }
                }
                anyhow::bail!("profile switch ended the receive track")
            })
            .await??;
        }
        ensure!(received[0].header.ssrc == received[1].header.ssrc);
        ensure!(
            received[1].header.sequence_number
                == received[0].header.sequence_number.wrapping_add(1)
        );
        ensure!(received[0].header.payload_type != received[1].header.payload_type);
        Ok::<_, anyhow::Error>(())
    }
    .await;
    tx.close().await?;
    rx.close().await?;
    left.close().await;
    right.close().await;
    result
}

#[tokio::test]
async fn restricted_profile_confirmation_retains_alternatives_but_rejects_wrong_actual_codec(
) -> Result<()> {
    use crate::peer::tests::support::endpoint;
    let high = codec(&h264_profiles(&[0x64001f]).params()[0]).rtp_codec;
    let left = Runtime::new(None).with_codecs(transport_codecs(false, true));
    let right = Runtime::new(None).with_codecs(transport_codecs(false, false));
    let (tx, _) = endpoint(&left, Uuid::new_v4(), None).await?;
    let (rx, _) = endpoint(&right, Uuid::new_v4(), None).await?;
    let result = async {
        let id = Uuid::new_v4();
        tx.add_output(
            id,
            high.clone(),
            MediaKind::Video,
            "restricted".into(),
            vec![],
        )
        .await?;
        tx.offer().await?;
        let (kind, sdp) = tx.local_description().await?;
        rx.accept(kind, sdp).await?;
        let (kind, sdp) = rx.local_description().await?;
        tx.accept(kind, sdp).await?;
        let alternatives = tx
            .confirm(id)
            .await?
            .flatten()
            .context("baseline alternative was rejected with preferred High")?;
        ensure!(alternatives.len() == 1);
        ensure!(!crate::media::compatible(&high, &alternatives[0].rtp_codec));
        ensure!(
            tx.write_au(id, String::new(), high, vec![], Instant::now())
                .await
                .is_err(),
            "High AU was labeled with the Baseline payload type"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    tx.close().await?;
    rx.close().await?;
    left.close().await;
    right.close().await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_input_receives_h264_opus_reports_and_pli_then_joins_its_socket() -> Result<()> {
    local_input_delivery(|offer| {
        // OBS can advertise its LAN interfaces as well as connect to our local answer.
        offer.replace(
            "a=sendonly",
            "a=candidate:lan 1 udp 1 192.0.2.1 49152 typ host\r\na=sendonly",
        )
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_input_delivers_media_without_offered_candidates() -> Result<()> {
    local_input_delivery(|offer| {
        offer
            .split_inclusive('\n')
            .filter(|line| {
                !line.starts_with("a=candidate:") && !line.starts_with("a=end-of-candidates")
            })
            .collect()
    })
    .await
}

async fn local_input_delivery(publisher_offer: impl FnOnce(&str) -> String) -> Result<()> {
    use crate::peer::tests::support::{endpoint, h264, send, video_payloads};
    use futures_util::{stream::FuturesUnordered, StreamExt};
    let sender_runtime = Runtime::new(None);
    // Local ingest must not consume or advertise the room server's shared UDP.
    let fixed = ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
    let receiver_runtime = Runtime::new(Some(fixed));
    let prepared = std::net::UdpSocket::bind("127.0.0.1:0")?;
    let (sender, _events) = endpoint(&sender_runtime, Uuid::new_v4(), Some(prepared)).await?;
    let video = Uuid::new_v4();
    let audio = Uuid::new_v4();
    let (mut feedback, video_writable, _) = sender
        .add_output(
            video,
            h264(),
            MediaKind::Video,
            "obs".into(),
            vec![String::new()],
        )
        .await?;
    let (_, audio_writable, _) = sender
        .add_output(
            audio,
            crate::peer::codec(),
            MediaKind::Audio,
            "obs".into(),
            vec![],
        )
        .await?;
    sender.offer().await?;
    let (_, offer) = sender.local_description().await?;
    ensure!(!offer.contains("urn:3gpp:video-orientation"));
    ensure!(!offer.lines().any(|line| line == "a=ice-lite"));
    let local_offer = publisher_offer(&offer);
    let mut input = receiver_runtime
        .accept_local_input(&local_offer)
        .await
        .context("local SDP accept/answer")?;
    ensure!(input.answer.lines().any(|line| line == "a=ice-lite"));
    let answer = SdpAnswer::from_sdp_string(&input.answer)?;
    let address = answer
        .media_lines
        .iter()
        .flat_map(|line| line.ice_candidates())
        .next()
        .context("no local candidate")?
        .addr();
    ensure!(address.ip() == std::net::Ipv4Addr::LOCALHOST);
    ensure!(
        input.ended.borrow().is_none(),
        "answer must precede first media"
    );
    input
        .transport
        .call(|engine| {
            ensure!(
                engine.sockets.len() == 1
                    && engine.sockets[0].local_addr()?.ip() == std::net::Ipv4Addr::LOCALHOST
            );
            ensure!(
                engine.discovery.is_none()
                    && engine.turn_setup_task.is_none()
                    && engine.turn.is_empty()
            );
            Ok(())
        })
        .await?;
    sender
        .accept("answer".into(), input.answer.clone())
        .await
        .context("sender SDP answer")?;
    let mut tracks = HashMap::<MediaKind, Track>::new();
    let mut packets = HashMap::<MediaKind, Vec<rtp::Packet>>::new();
    let mut reports = HashSet::new();
    let mut frame = 0u32;
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let mut reading = FuturesUnordered::new();
            for (&kind, track) in &tracks {
                let track = track.clone();
                reading.push(async move { (kind, track.poll().await) });
            }
            tokio::select! {
                Some(track) = input.tracks.recv(), if tracks.len()<2 => { tracks.insert(track.kind, track); },
                Some((kind,event)) = reading.next(), if !reading.is_empty() => match event {
                    Some(TrackEvent::Rtp(packet,..)) => { packets.entry(kind).or_default().push(packet); },
                    Some(TrackEvent::Report(values)) => if !values.is_empty() { reports.insert(kind); },
                    _ => anyhow::bail!("local track ended before its media"),
                },
                _ = tick.tick() => {
                    frame += 1;
                    let audio_packet = rtp::Packet { header: rtp::header::Header { version:2,marker:true,timestamp:frame*960,..Default::default() }, payload:vec![0xf8,0xff,0xfe].into() };
                    send(&sender,audio,vec![audio_packet],Instant::now(),&audio_writable).await.context("audio ICE/DTLS/RTP admission")?;
                    let payloads=video_payloads(&h264(),frame,true)?;
                    let last=payloads.len()-1;
                    let video_packets=payloads.into_iter().enumerate().map(|(index,payload)|rtp::Packet{header:rtp::header::Header{version:2,marker:index==last,timestamp:frame*1800,..Default::default()},payload}).collect();
                    send(&sender,video,video_packets,Instant::now(),&video_writable).await.context("video RTP admission")?;
                }
            }
            if reports.len()==2 && packets.get(&MediaKind::Audio).is_some_and(|p|p.len()>1) && packets.get(&MediaKind::Video).is_some_and(|p|p.iter().filter(|p|p.header.marker).count()>1) { break; }
        }
        use rtc_rtp::packetizer::Depacketizer;
        let mut decoder=rtc_rtp::codec::h264::H264Packet::default();
        let mut access_unit=Vec::new();
        for packet in &packets[&MediaKind::Video] {
            access_unit.extend_from_slice(&decoder.depacketize(&packet.payload)?);
            if packet.header.marker {break;}
        }
        ensure!(crate::media::h264::nals(&access_unit)?.any(|nal|nal[0]&31==5), "complete H264 IDR was not delivered");
        ensure!(packets[&MediaKind::Audio].iter().all(|p| p.payload.as_ref()==[0xf8,0xff,0xfe]));
        let video_track=&tracks[&MediaKind::Video];
        ensure!(video_track.report(video_track.first_ssrc).lock().unwrap().is_some());
        video_track.request_keyframe(video_track.first_ssrc).await.context("send PLI after complete A/V and SR")?;
        tokio::time::timeout(Duration::from_secs(5),feedback.recv()).await.context("PLI feedback timed out after complete H264/Opus and both SRs")?.context("sender feedback channel closed")?;
        Ok::<_,anyhow::Error>(())
    }).await;
    input
        .transport
        .close()
        .await
        .context("close and join local transport")?;
    ensure!(matches!(&*input.ended.borrow(), Some(Ok(()))));
    ensure!(
        std::net::UdpSocket::bind(address).is_ok(),
        "local input socket was not joined/released"
    );
    for track in tracks.values() {
        tokio::time::timeout(Duration::from_secs(1), async {
            while track.poll().await.is_some() {}
        })
        .await
        .context("drain closed input track")?;
    }
    sender.close().await?;
    sender_runtime.close().await;
    receiver_runtime.close().await;
    result.context("local A/V RTP and Sender Report progression deadline")??;
    Ok(())
}

#[tokio::test]
async fn local_input_rejects_direction_codec_and_extra_media() -> Result<()> {
    use crate::peer::tests::support::{endpoint, h264};
    let runtime = Runtime::new(None);
    let (sender, _) = endpoint(
        &runtime,
        Uuid::new_v4(),
        Some(std::net::UdpSocket::bind("127.0.0.1:0")?),
    )
    .await?;
    sender
        .add_output(
            Uuid::new_v4(),
            h264(),
            MediaKind::Video,
            "obs".into(),
            vec![],
        )
        .await?;
    sender.offer().await?;
    let (_, sdp) = sender.local_description().await?;
    let offer = sdp;
    for invalid in [
        offer.replace("a=sendonly", "a=sendrecv"),
        offer.replace("H264/90000", "VP8/90000"),
    ] {
        ensure!(runtime.accept_local_input(&invalid).await.is_err());
    }
    let orientation_offer = offer.replace(
        "a=sendonly",
        "a=extmap:13 urn:3gpp:video-orientation\r\na=sendonly",
    );
    let accepted = runtime.accept_local_input(&orientation_offer).await?;
    ensure!(!accepted.answer.contains("urn:3gpp:video-orientation"));
    sender.accept("answer".into(), accepted.answer).await?;
    accepted.transport.close().await?;
    sender.create_channel("not-local-media").await?;
    sender.offer().await?;
    let (_, sdp) = sender.local_description().await?;
    ensure!(runtime.accept_local_input(&sdp).await.is_err());
    sender.close().await?;
    runtime.close().await;
    Ok(())
}

#[test]
fn wildcard_candidates_ignore_unusable_interfaces_without_losing_valid_paths() -> Result<()> {
    let interfaces = [
        "169.254.83.107",
        "255.255.255.255",
        "224.0.0.1",
        "0.0.0.0",
        "127.0.0.1",
        "192.168.1.10",
        "::1",
        "fe80::1",
        "ff02::1",
        "fd00::1",
    ]
    .map(|ip| match ip.parse::<std::net::IpAddr>().unwrap() {
        std::net::IpAddr::V4(ip) => {
            netwatch::interfaces::IpNet::V4(format!("{ip}/32").parse().unwrap())
        }
        std::net::IpAddr::V6(ip) => netwatch::interfaces::IpNet::V6 {
            net: format!("{ip}/128").parse().unwrap(),
            scope_id: 0,
            flags: Default::default(),
        },
    });
    let v4 = host_candidates("0.0.0.0:42000".parse()?, interfaces.clone().into_iter())?;
    let v6 = host_candidates("[::]:42000".parse()?, interfaces.clone().into_iter())?;
    assert_eq!(
        v4.iter().map(Candidate::addr).collect::<Vec<_>>(),
        vec!["192.168.1.10:42000".parse::<SocketAddr>()?]
    );
    assert_eq!(
        v6.iter().map(Candidate::addr).collect::<Vec<_>>(),
        vec!["[fd00::1]:42000".parse::<SocketAddr>()?]
    );
    let explicit = "127.0.0.1:42000".parse()?;
    assert_eq!(
        host_candidates(explicit, interfaces.clone().into_iter())?[0].addr(),
        explicit
    );
    assert!(host_candidates("169.254.83.107:42000".parse()?, interfaces.into_iter()).is_err());
    Ok(())
}

#[test]
fn interface_state_changes_only_admit_usable_ipv6_addresses() -> Result<()> {
    use netwatch::interfaces::{IpNet, Ipv6AddrFlags};
    let socket: SocketAddr = "[::]:42000".parse()?;
    let snapshot = |flags| {
        [
            IpNet::V6 {
                net: "2001:db8::10/64".parse().unwrap(),
                scope_id: 0,
                flags,
            },
            IpNet::V6 {
                net: "fd00::20/64".parse().unwrap(),
                scope_id: 0,
                flags: Ipv6AddrFlags {
                    deprecated: true,
                    temporary: true,
                    ..Default::default()
                },
            },
            IpNet::V4("192.0.2.30/24".parse().unwrap()),
        ]
    };
    let stable: SocketAddr = "[fd00::20]:42000".parse()?;
    let changing: SocketAddr = "[2001:db8::10]:42000".parse()?;
    for (flags, expected) in [
        (
            Ipv6AddrFlags {
                tentative: true,
                ..Default::default()
            },
            vec![stable],
        ),
        (Ipv6AddrFlags::default(), vec![changing, stable]),
        (
            Ipv6AddrFlags {
                duplicated: true,
                ..Default::default()
            },
            vec![stable],
        ),
    ] {
        let addresses = snapshot(flags);
        let candidates = host_candidates(socket, addresses.clone().into_iter())?;
        assert_eq!(
            candidates.iter().map(Candidate::addr).collect::<Vec<_>>(),
            expected,
            "per-address flags were lost before SDK candidate admission"
        );
        assert_eq!(
            host_candidates("0.0.0.0:42000".parse()?, addresses.into_iter())?
                .iter()
                .map(Candidate::addr)
                .collect::<Vec<_>>(),
            vec!["192.0.2.30:42000".parse::<SocketAddr>()?]
        );
    }
    Ok(())
}

#[tokio::test]
async fn metrics_keep_sdk_sample_clock_and_discard_retired_mid_events() -> Result<()> {
    let runtime = Runtime::new(None);
    let (pc, _) = crate::peer::tests::support::endpoint(&runtime, Uuid::new_v4(), None).await?;
    let output = Uuid::new_v4();
    pc.add_output(
        output,
        crate::peer::codec(),
        MediaKind::Audio,
        "sound".into(),
        vec![],
    )
    .await?;
    pc.offer().await?;
    pc.call(move |engine| {
        let mid = engine.outputs[&output].mid.context("missing offered MID")?;
        let stats = MediaEgressStats {
            mid,
            rid: None,
            bytes: 4096,
            packets: 16,
            firs: 0,
            plis: 0,
            nacks: 0,
            rtt: Some(Duration::from_millis(12)),
            loss: Some(0.25),
            timestamp: Instant::now(),
            remote: None,
        };
        engine.event(RtcEvent::MediaEgressStats(stats));
        Ok(())
    })
    .await?;
    let first = pc.connection_metrics().await?;
    ensure!(first.streams.len() == 1);
    ensure!(first.streams[0].counters.bytes == 4096);
    ensure!(first.streams[0].counters.rtt_ms == Some(12.0));
    ensure!(
        first.bwe_bps.is_none(),
        "startup budget is not measured BWE"
    );
    let second = pc.connection_metrics().await?;
    ensure!(first.connection_id == second.connection_id);
    ensure!(
        first.streams[0].counters.sample_timestamp_ms
            == second.streams[0].counters.sample_timestamp_ms
    );
    ensure!(second.streams[0].counters.age_ms >= first.streams[0].counters.age_ms);
    pc.retire_output(output).await?;
    pc.call(move |engine| {
        ensure!(engine.egress_stats.is_empty());
        let mid = engine.outputs[&output].mid.context("missing retired MID")?;
        engine.event(RtcEvent::MediaEgressStats(MediaEgressStats {
            mid,
            rid: None,
            bytes: 9999,
            packets: 99,
            firs: 0,
            plis: 0,
            nacks: 0,
            rtt: None,
            loss: None,
            timestamp: Instant::now(),
            remote: None,
        }));
        ensure!(
            engine.egress_stats.is_empty(),
            "late event revived retired MID"
        );
        Ok(())
    })
    .await?;
    ensure!(pc.connection_metrics().await?.streams.is_empty());
    pc.close().await?;
    runtime.close().await;
    Ok(())
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn whole_au_admission_and_immediate_retirement_preserve_other_senders() -> Result<()> {
    let receipt = admission::run().await?;
    ensure!(receipt["passed"] == true);
    Ok(())
}
#[tokio::test]
async fn receive_buffer_request_raises_small_and_retains_larger_supplied_values() -> Result<()> {
    for bind in ["127.0.0.1:0", "[::1]:0"] {
        let reference = std::net::UdpSocket::bind(bind)?;
        let reference_ref = socket2::SockRef::from(&reference);
        reference_ref.set_recv_buffer_size(2 * 1024 * 1024)?;
        let expected = reference_ref.recv_buffer_size()?;
        let small = std::net::UdpSocket::bind(bind)?;
        socket2::SockRef::from(&small).set_recv_buffer_size(4096)?;
        small.set_nonblocking(true)?;
        let owner = UdpIo::new(UdpSocket::from_std(small)?)?;
        ensure!(
            owner.state.recv_buffer_size((&owner.socket).into())? >= expected,
            "small receive buffer was not raised to the OS-accepted request"
        );
        let large = std::net::UdpSocket::bind(bind)?;
        socket2::SockRef::from(&large).set_recv_buffer_size(4 * 1024 * 1024)?;
        let supplied = socket2::SockRef::from(&large).recv_buffer_size()?;
        large.set_nonblocking(true)?;
        let owner = UdpIo::new(UdpSocket::from_std(large)?)?;
        ensure!(
            owner.state.recv_buffer_size((&owner.socket).into())? >= supplied,
            "larger caller receive buffer was reduced"
        );
    }
    Ok(())
}

#[tokio::test]
async fn native_opus_offer_and_answer_request_stereo_receive() -> Result<()> {
    let runtime = Runtime::new(None);
    let (left, _) = crate::peer::tests::support::endpoint(&runtime, Uuid::new_v4(), None).await?;
    let (right, _) = crate::peer::tests::support::endpoint(&runtime, Uuid::new_v4(), None).await?;
    let result = async {
        let (_feedback, _writable, _) = left
            .add_output(
                Uuid::new_v4(),
                crate::peer::codec(),
                MediaKind::Audio,
                "stereo".into(),
                vec![],
            )
            .await?;
        ensure!(left.offer().await?);
        let (kind, offer) = left.local_description().await?;
        right.accept(kind, offer.clone()).await?;
        let (_, answer) = right.local_description().await?;
        for (phase, sdp) in [("offer", offer), ("answer", answer)] {
            let pt = sdp
                .lines()
                .find_map(|line| {
                    line.strip_prefix("a=rtpmap:")
                        .and_then(|line| line.split_once(" opus/48000/2"))
                        .map(|(pt, _)| pt)
                })
                .context("Opus mapping missing")?;
            let prefix = format!("a=fmtp:{pt} ");
            let fmtp = sdp
                .lines()
                .find_map(|line| line.strip_prefix(&prefix))
                .context("Opus fmtp missing")?;
            ensure!(
                fmtp.split(';')
                    .any(|parameter| parameter.trim() == "stereo=1"),
                "{phase} did not request stereo: {fmtp}"
            );
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    left.close().await?;
    right.close().await?;
    runtime.close().await;
    result
}

#[tokio::test]
async fn rebinding_writer_preserves_messages_queued_for_current_channel() -> Result<()> {
    use crate::data::{DataLink, Lane, Message};
    use crate::peer::tests::support::{endpoint, message, open};

    let runtime = Runtime::new(None);
    let (left, _) = endpoint(&runtime, Uuid::new_v4(), None).await?;
    let (right, mut events) = endpoint(&runtime, Uuid::new_v4(), None).await?;
    let (old, _) = open(&left, &right, &mut events).await?;
    let next = left.create_channel("piik-room").await?;
    if left.offer().await? {
        let (kind, sdp) = left.local_description().await?;
        right.accept(kind, sdp).await?;
        let (kind, sdp) = right.local_description().await?;
        left.accept(kind, sdp).await?;
    }
    let remote = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if let Event::Channel(_, channel) = event {
                return Ok::<_, anyhow::Error>(channel);
            }
        }
        Err(anyhow!("replacement channel was not installed"))
    })
    .await??;
    for channel in [&next, &remote] {
        ensure!(matches!(
            tokio::time::timeout(Duration::from_secs(5), channel.poll()).await?,
            Some(ChannelEvent::Open)
        ));
    }

    let (failures, mut failed) = mpsc::channel(8);
    let link = DataLink::new(
        left.pair,
        Arc::new(AtomicU8::new(PeerState::Connected as u8)),
        failures,
    );
    let result = async {
        let senders = link.senders();
        let old_ready = link.bind(Lane::Control, Uuid::new_v4(), old);
        ensure!(old_ready.set(true));
        let (_, scope, _lease) = message("scope owner")?;
        let record = |tag: &str| -> Result<Message> {
            let (bytes, _, _) = message(tag)?;
            Ok(Message {
                bytes,
                scope: scope.clone(),
                report_failure: true,
            })
        };

        // Hold only admission to the real command loop, so the old Channel::write
        // remains pending while the pair writer observes its replacement.
        let held = left.tx.reserve_many(left.tx.max_capacity()).await?;
        senders
            .control
            .try_send(record("old in-flight")?)
            .map_err(|_| anyhow!("control queue full"))?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while senders.control.capacity() != senders.control.max_capacity() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .context("old message never entered Channel::write")?;

        link.unbind(Lane::Control);
        let next_ready = link.bind(Lane::Control, Uuid::new_v4(), next);
        ensure!(next_ready.set(true));
        let expected = [record("current one")?, record("current two")?];
        let bytes: Vec<_> = expected
            .iter()
            .map(|message| message.bytes.clone())
            .collect();
        for message in expected {
            senders
                .control
                .try_send(message)
                .map_err(|_| anyhow!("control queue full"))?;
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while senders.control.capacity() == senders.control.max_capacity() - 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .context("writer never processed the binding change")?;
        drop(held);

        for expected in bytes {
            let received = tokio::time::timeout(Duration::from_secs(5), remote.poll())
                .await
                .context("current-binding message was discarded during old-send cancellation")?;
            ensure!(matches!(received, Some(ChannelEvent::Message(bytes)) if bytes == expected));
        }
        ensure!(
            failed.try_recv().is_err(),
            "replacement reported an old-send failure"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    link.close().await;
    left.close().await?;
    right.close().await?;
    runtime.close().await;
    result
}
