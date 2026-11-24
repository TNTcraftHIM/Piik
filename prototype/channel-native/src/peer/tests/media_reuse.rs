//! Repeated output leases share SDP carriers, never RTP or flow generations.
use super::*;
use crate::peer::tests::support::{endpoint, h264, send, vp8, Fixture};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn polite_collision_reoffers_a_reused_sender_without_losing_its_live_connection() -> Result<()>
{
    use crate::media::{Output, Source, SourceFeed, SourceOrigin};
    use crate::peer::tests::support::{exchange, open};
    use crate::peer::{Description, Driver, NativeEvent, PairInfo, Signal};
    use piik_channel_core::wire::{FlowBinding, Kind, PublicationInfo};

    fn description(kind: String, sdp: String, exchange: Uuid) -> Signal {
        Signal {
            udp: None,
            description: Some(Description {
                kind,
                sdp: Some(sdp),
            }),
            exchange_id: Some(exchange),
            candidate: None,
            tracks: Some(vec![]),
            resync: None,
        }
    }
    async fn answer(driver: &mut Driver, pair: Uuid, remote: &Transport) -> Result<()> {
        let signal = driver.pairs[&pair]
            .pending_offer
            .as_ref()
            .context("missing Driver offer")?
            .signal
            .clone();
        let offer = signal.description.unwrap();
        remote.accept(offer.kind, offer.sdp.unwrap()).await?;
        let (kind, sdp) = remote.local_description().await?;
        driver
            .signal(pair, description(kind, sdp, signal.exchange_id.unwrap()))
            .await
    }

    let (mut driver, mut events, mut commands, _stop) = crate::peer::tests::driver();
    let fixed = crate::peer::server_udp::ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
    let original = std::mem::replace(&mut driver.transport, Runtime::new(Some(fixed.clone())));
    original.close().await;
    driver.server_udp = Some(fixed);
    driver.session = Uuid::from_u128(2);
    let fixed = crate::peer::server_udp::ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
    let other = Runtime::new(Some(fixed));
    let pair = Uuid::new_v4();
    let first_flow = Uuid::new_v4();
    let publication = PublicationInfo {
        id: Uuid::new_v4(),
        room_id: "glare".into(),
        session_id: driver.session,
        user_id: Uuid::new_v4(),
        kind: Kind::Voice,
        screen: None,
        paused: false,
        audience: vec![],
        video_settings: None,
    };
    let source = Source {
        id: Uuid::new_v4(),
        publication_id: publication.id,
        origin: SourceOrigin::Local,
        kind: MediaKind::Audio,
        feed: SourceFeed::Rtp {
            codec: crate::peer::codec(),
            keyframes: watch::channel(0).0,
            report: Default::default(),
        },
        layers: None,
    };
    driver
        .publications
        .insert(publication.id, publication.clone());
    driver.sources.insert(source.id, source.clone());
    let binding = |id| FlowBinding {
        id,
        publication_id: publication.id,
        input_flow_id: None,
        presentation: false,
        selected: true,
    };
    let plan = PairInfo {
        id: pair,
        peer_id: Uuid::from_u128(1),
        udp_preparation: None,
        can_receive_video_layers: false,
        rooms: vec![],
        incoming: vec![],
        outgoing: vec![binding(first_flow)],
    };
    driver.create_pair(&plan, None).await?;
    let pc = driver.pairs[&pair].pc.clone();
    let (remote, mut remote_events) = endpoint(&other, pair, None).await?;
    let result = async {
        let (forward, reverse) = open(&pc, &remote, &mut remote_events).await?;
        let instance = pc.connection_metrics().await?.connection_id;
        let output = Output::new(
            &pc,
            &source,
            "microphone".into(),
            pair,
            (first_flow, MediaKind::Audio),
            driver.events.clone(),
            driver.pairs[&pair].reports.clone(),
            false,
            false,
        )
        .await?;
        let first = output.id;
        let stream = output.stream.clone();
        driver
            .pairs
            .get_mut(&pair)
            .unwrap()
            .outputs
            .insert((first_flow, MediaKind::Audio), output);
        driver.offer(pair).await?;
        answer(&mut driver, pair, &remote).await?;
        let mid = pc.call(move |e| Ok(e.outputs[&first].mid.unwrap())).await?;
        driver.pairs.get_mut(&pair).unwrap().plan.outgoing.clear();
        driver
            .pairs
            .get_mut(&pair)
            .unwrap()
            .outputs
            .remove(&(first_flow, MediaKind::Audio))
            .unwrap()
            .close(&pc)
            .await;
        driver.offer(pair).await?;
        answer(&mut driver, pair, &remote).await?;
        pc.call(move |e| {
            ensure!(
                e.outputs[&first].reusable
                    && e.rtc.media(mid).unwrap().direction() == Direction::Inactive
            );
            Ok(())
        })
        .await?;

        let next_flow = Uuid::new_v4();
        driver
            .pairs
            .get_mut(&pair)
            .unwrap()
            .plan
            .outgoing
            .push(binding(next_flow));
        let output = Output::new(
            &pc,
            &source,
            "replacement-flow".into(),
            pair,
            (next_flow, MediaKind::Audio),
            driver.events.clone(),
            driver.pairs[&pair].reports.clone(),
            false,
            false,
        )
        .await?;
        let next = output.id;
        ensure!(
            output.stream == stream,
            "fixture must reuse the original negotiated carrier"
        );
        driver
            .pairs
            .get_mut(&pair)
            .unwrap()
            .outputs
            .insert((next_flow, MediaKind::Audio), output);
        driver.offer(pair).await?;
        let abandoned = driver.pairs[&pair]
            .pending_offer
            .as_ref()
            .unwrap()
            .signal
            .exchange_id
            .unwrap();
        pc.call(move |e| {
            ensure!(
                e.outputs[&next].mid == Some(mid)
                    && e.rtc.media(mid).unwrap().direction() == Direction::SendOnly
            );
            Ok(())
        })
        .await?;
        while events.try_recv().is_ok() {}
        while commands.try_recv().is_ok() {}

        // Ordinary remote source addition races the reused local sending half.
        remote
            .add_output(
                Uuid::new_v4(),
                vp8(),
                MediaKind::Video,
                "remote-new-source".into(),
                vec![String::new()],
            )
            .await?;
        ensure!(remote.offer().await?);
        let (kind, offer) = remote.local_description().await?;
        let competing = Uuid::new_v4();
        driver
            .signal(pair, description(kind, offer, competing))
            .await?;
        let replacement = driver.pairs[&pair]
            .pending_offer
            .as_ref()
            .context("polite collision lost the desired reused sender")?
            .signal
            .clone();
        ensure!(replacement.exchange_id != Some(abandoned));
        let sent: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok())
            .filter_map(|event| match event {
                NativeEvent::Command(crate::peer::Command::Signal { payload, .. }) => Some(payload),
                _ => None,
            })
            .collect();
        let answer_signal = sent
            .iter()
            .find(|s| s.exchange_id == Some(competing))
            .context("competing offer was not answered")?;
        let offer_signal = sent
            .iter()
            .position(|s| s.exchange_id == replacement.exchange_id)
            .context("replacement offer was not sent")?;
        ensure!(
            sent.iter()
                .position(|s| s.exchange_id == Some(competing))
                .unwrap()
                < offer_signal,
            "answer must precede replacement offer"
        );
        let value = answer_signal.description.as_ref().unwrap();
        remote
            .accept(value.kind.clone(), value.sdp.clone().unwrap())
            .await?;
        // An old answer cannot consume the new pending exchange, even if delayed
        // until after the polite side completed the competing offer.
        driver
            .signal(
                pair,
                description(
                    "answer".into(),
                    "old answer must not be parsed".into(),
                    abandoned,
                ),
            )
            .await?;
        ensure!(
            driver.pairs[&pair]
                .pending_offer
                .as_ref()
                .unwrap()
                .signal
                .exchange_id
                == replacement.exchange_id
        );
        answer(&mut driver, pair, &remote).await?;
        ensure!(driver.pairs[&pair]
            .stable_outputs
            .as_ref()
            .is_some_and(|outputs| outputs.contains(&next)));
        ensure!(pc.connection_metrics().await?.connection_id == instance);
        pc.call(move |e| {
            ensure!(
                e.outputs[&next].mid == Some(mid)
                    && e.rtc.media(mid).unwrap().direction().is_sending()
            );
            Ok(())
        })
        .await?;
        while let Ok(event) = events.try_recv() {
            ensure!(
                !matches!(event,Event::OutputFailed{output,..}if output==next),
                "rolled-back output was misreported as failed"
            );
        }
        driver.pairs[&pair].outputs[&(next_flow,MediaKind::Audio)].rtp_sink().context("negotiated audio sink")?
            .send(rtc_rtp::Packet {
                header: rtc_rtp::header::Header {
                    version: 2,
                    marker: true,
                    sequence_number: 1,
                    timestamp: 960,
                    ..Default::default()
                },
                payload: vec![0xf8, 0xff, 0xfe].into(),
            })
            .await?;
        let track = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = remote_events.recv().await {
                if let Event::Track(_, track) = event {
                    return Ok::<_, anyhow::Error>(track);
                }
            }
            anyhow::bail!("reused sender did not deliver audio")
        })
        .await??;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = track.poll().await {
                if let TrackEvent::Rtp(packet, ..) = event {
                    ensure!(packet.payload.as_ref() == [0xf8, 0xff, 0xfe]);
                    return Ok::<_, anyhow::Error>(());
                }
            }
            anyhow::bail!("audio track retired")
        })
        .await??;
        exchange(&forward, &reverse, "after-collision").await?;
        exchange(&reverse, &forward, "reverse-after-collision").await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    driver
        .retire_pair(
            pair,
            crate::diagnostics::RetirementReason::ProjectionRemoved,
        )
        .await;
    driver.files.close().await;
    driver.watches.close().await;
    driver.transport.close().await;
    remote.close().await?;
    other.close().await;
    result
}

#[tokio::test]
async fn a_reused_sender_preserves_the_remote_sending_half_of_its_media() -> Result<()> {
    let runtime = Runtime::new(None);
    let other = Runtime::new(None);
    let (pc, mut events) = endpoint(&runtime, Uuid::new_v4(), None).await?;
    let (remote, _) = endpoint(&other, Uuid::new_v4(), None).await?;
    let result = async {
        let id = Uuid::new_v4();
        let (_, forward_writable, stream) = pc
            .add_output(
                id,
                crate::peer::codec(),
                MediaKind::Audio,
                "duplex".into(),
                vec![String::new()],
            )
            .await?;
        ensure!(pc.offer().await?);
        let (kind, offer) = pc.local_description().await?;
        remote.accept(kind, offer).await?;
        let (kind, answer) = remote.local_description().await?;
        pc.accept(kind, answer).await?;
        let mid = pc.call(move |e| Ok(e.outputs[&id].mid.unwrap())).await?;
        // Browser addTrack may attach its microphone to our audio transceiver.
        let reverse = Uuid::new_v4();
        let (_, writable, _) = remote
            .add_output(
                reverse,
                crate::peer::codec(),
                MediaKind::Audio,
                "microphone".into(),
                vec![String::new()],
            )
            .await?;
        remote
            .call(move |e| {
                e.outputs.get_mut(&reverse).unwrap().mid = Some(mid);
                Ok(())
            })
            .await?;
        ensure!(remote.offer().await?);
        let (kind, offer) = remote.local_description().await?;
        pc.accept(kind, offer).await?;
        let (kind, answer) = pc.local_description().await?;
        remote.accept(kind, answer).await?;
        ensure!(
            !pc.offer().await?,
            "active output removed the receiving direction"
        );
        let next = Uuid::new_v4();
        let mut incoming: Option<Track> = None;
        let mut sending = (id, forward_writable);
        let mut measurements = Vec::new();
        for phase in 0..3 {
            if phase == 1 {
                pc.retire_output(id).await?;
            } else if phase == 2 {
                let (_, writable, next_stream) = pc
                    .add_output(
                        next,
                        crate::peer::codec(),
                        MediaKind::Audio,
                        "new-flow".into(),
                        vec![String::new()],
                    )
                    .await?;
                ensure!(next_stream == stream);
                sending = (next, writable);
            }
            if phase > 0 {
                ensure!(pc.offer().await?);
                let (kind, offer) = pc.local_description().await?;
                remote.accept(kind, offer).await?;
                let (kind, answer) = remote.local_description().await?;
                pc.accept(kind, answer).await?;
            }
            pc.call(move |e| {
                let expected = if phase == 1 {
                    Direction::RecvOnly
                } else {
                    Direction::SendRecv
                };
                ensure!(e.rtc.media(mid).unwrap().direction() == expected);
                if phase == 1 {
                    ensure!(e.outputs[&id].reusable);
                }
                if phase == 2 {
                    ensure!(e.outputs[&next].mid == Some(mid));
                }
                Ok(())
            })
            .await?;
            let timestamp = (phase + 1) * 960;
            let packet = rtp::Packet {
                header: rtp::header::Header {
                    version: 2,
                    marker: true,
                    sequence_number: phase as u16,
                    timestamp,
                    ..Default::default()
                },
                payload: vec![0xf8, 0xff, 0xfe].into(),
            };
            tokio::time::timeout(Duration::from_secs(5), async {
                send(&remote, reverse, vec![packet], Instant::now(), &writable).await?;
                if incoming.is_none() {
                    while let Some(event) = events.recv().await {
                        if let Event::Track(_, track) = event {
                            incoming = Some(track);
                            break;
                        }
                    }
                }
                let track = incoming.as_ref().context("missing reverse track")?;
                while let Some(event) = track.poll().await {
                    if let TrackEvent::Rtp(packet, ..) = event {
                        ensure!(packet.header.timestamp == timestamp);
                        ensure!(
                            packet.header.ssrc == track.first_ssrc,
                            "reverse sender changed"
                        );
                        return Ok::<_, anyhow::Error>(());
                    }
                }
                anyhow::bail!("reverse audio ended when only our sender retired")
            })
            .await??;
            if phase != 1 {
                let packets = if phase == 0 { 1 } else { 2 };
                for sequence in 0..packets {
                    send(
                        &pc,
                        sending.0,
                        vec![rtp::Packet {
                            header: rtp::header::Header {
                                version: 2,
                                marker: true,
                                sequence_number: sequence as u16,
                                timestamp: (sequence + 1) as u32 * 960,
                                ..Default::default()
                            },
                            payload: vec![0xf8, 0xff, 0xfe].into(),
                        }],
                        Instant::now(),
                        &sending.1,
                    )
                    .await?;
                }
                let counters =
                    tokio::time::timeout(Duration::from_secs(5), async {
                        loop {
                            let counters =
                                pc.connection_metrics().await?.streams.into_iter().find(
                                    |sample| {
                                        sample.outgoing && sample.counters.packets == packets
                                    },
                                );
                            let received =
                                remote.connection_metrics().await?.streams.into_iter().find(
                                    |sample| {
                                        !sample.outgoing
                                            && sample.counters.packets == u64::from(phase) + 1
                                    },
                                );
                            if let (Some(sent), Some(received)) = (counters, received) {
                                ensure!(received.counters.output_id.is_none());
                                break Ok::<_, anyhow::Error>(sent.counters);
                            }
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                    })
                    .await??;
                measurements.push((sending.0, counters));
            }
        }
        ensure!(measurements[0].1.mid == measurements[1].1.mid);
        ensure!(
            measurements[1].1.bytes == measurements[0].1.bytes * 2,
            "reused MID did not start a new SDK egress counter"
        );
        for (output, counters) in measurements {
            ensure!(
                counters.output_id == Some(output),
                "Native metric lost the current Output counter owner"
            );
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    pc.close().await?;
    remote.close().await?;
    runtime.close().await;
    other.close().await;
    result
}

#[tokio::test]
async fn rejected_fixed_codec_reuses_inactive_media_after_the_answer() -> Result<()> {
    let runtime = Runtime::new(None);
    let (pc, _) = endpoint(&runtime, Uuid::new_v4(), None).await?;
    let mut remote = Rtc::builder()
        .clear_codecs()
        .enable_vp8(true)
        .set_rtp_mode(true)
        .build(Instant::now());
    remote.add_local_candidate(Candidate::host(
        "127.0.0.1:9".parse::<SocketAddr>()?,
        "udp",
    )?);
    let result = async {
        let mut carrier = None;
        let mut initial_size = 0;
        for attempt in 0..12 {
            let id = Uuid::new_v4();
            let (_, _, stream) = pc
                .add_output(
                    id,
                    h264(),
                    MediaKind::Video,
                    Uuid::new_v4().to_string(),
                    vec![String::new()],
                )
                .await?;
            ensure!(pc.offer().await?);
            let (_, offer) = pc.local_description().await?;
            ensure!(
                offer
                    .lines()
                    .filter(|line| line.starts_with("m=video "))
                    .count()
                    == 1,
                "retry appended an SDP media section"
            );
            if attempt == 0 {
                initial_size = offer.len();
            }
            ensure!(offer.len() <= initial_size + 32, "retry grew SDP history");
            let answer = remote
                .sdp_api()
                .accept_offer(SdpOffer::from_sdp_string(&offer)?)?;
            ensure!(
                answer
                    .to_sdp_string()
                    .lines()
                    .any(|line| line.starts_with("m=video 9 ")),
                "negative control must accept VP8 on the same media section"
            );
            pc.accept("answer".into(), answer.to_sdp_string()).await?;
            ensure!(
                matches!(pc.confirm(id).await?, Some(None)),
                "fixed H264 was not rejected"
            );
            let mid = pc
                .call(move |engine| {
                    ensure!(
                        engine.outputs.len() == 1,
                        "retired lease records accumulated"
                    );
                    Ok(engine.outputs[&id].mid.unwrap())
                })
                .await?;
            if let Some((previous_mid, previous_stream)) = &carrier {
                ensure!(
                    *previous_mid == mid && *previous_stream == stream,
                    "retry changed its negotiated MID/MSID"
                );
            } else {
                carrier = Some((mid, stream));
            }
            pc.retire_output(id).await?;
            ensure!(pc.offer().await?);
            let (_, offer) = pc.local_description().await?;
            let answer = remote
                .sdp_api()
                .accept_offer(SdpOffer::from_sdp_string(&offer)?)?;
            pc.accept("answer".into(), answer.to_sdp_string()).await?;
        }
        // A direction mutation is not acknowledgement. Keep a replacement off
        // a carrier whose active lease has not completed its inactive exchange.
        let id = Uuid::new_v4();
        let (_, _, first_stream) = pc
            .add_output(
                id,
                vp8(),
                MediaKind::Video,
                Uuid::new_v4().to_string(),
                vec![String::new()],
            )
            .await?;
        ensure!(pc.offer().await?);
        let (_, offer) = pc.local_description().await?;
        let answer = remote
            .sdp_api()
            .accept_offer(SdpOffer::from_sdp_string(&offer)?)?;
        pc.accept("answer".into(), answer.to_sdp_string()).await?;
        ensure!(
            pc.confirm(id).await?.flatten().is_some(),
            "compatible output did not recover"
        );
        pc.retire_output(id).await?;
        ensure!(pc.offer().await?);
        let next = Uuid::new_v4();
        let (_, _, next_stream) = pc
            .add_output(
                next,
                vp8(),
                MediaKind::Video,
                Uuid::new_v4().to_string(),
                vec![String::new()],
            )
            .await?;
        ensure!(
            next_stream != first_stream,
            "rebound an unacknowledged carrier"
        );
        pc.call(move |engine| {
            ensure!(engine.outputs[&next].mid.is_none());
            Ok(())
        })
        .await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    pc.close().await?;
    runtime.close().await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_media_leases_keep_sibling_av_and_use_fresh_rtp() -> Result<()> {
    let mut fixture = Fixture::new(vp8()).await?;
    let result = async {
        let sink = fixture.sink;
        let pc = fixture.driver.pairs[&sink].pc.clone();
        let sibling = fixture.plans.last().unwrap().outgoing[0].id;
        let mut binding = fixture.plans.last().unwrap().outgoing[1];
        fixture
            .until(|f| {
                [sibling, binding.id].iter().all(|flow| {
                    [MediaKind::Audio, MediaKind::Video].iter().all(|kind| {
                        f.driver.pairs[&sink]
                            .outputs
                            .get(&(*flow, *kind))
                            .is_some_and(|out| f.observed(&out.stream, *kind).is_some())
                    })
                })
            })
            .await?;
        let sibling_audio = fixture.output(sibling, MediaKind::Audio);
        let sibling_video = fixture.output(sibling, MediaKind::Video);
        let stream = fixture.output(binding.id, MediaKind::Video).1;
        let original_sibling = fixture
            .observed(&sibling_video.1, MediaKind::Video)
            .unwrap();
        let mut previous_audio = fixture.observed(&stream, MediaKind::Audio).unwrap();
        let mut previous_video = fixture.observed(&stream, MediaKind::Video).unwrap();
        let sections = pc
            .local_description()
            .await?
            .1
            .lines()
            .filter(|line| line.starts_with("m="))
            .count();
        for _ in 0..8 {
            fixture
                .plans
                .last_mut()
                .unwrap()
                .outgoing
                .retain(|flow| flow.id != binding.id);
            fixture
                .driver
                .update(
                    fixture.plans.clone(),
                    vec![fixture.publication.clone()],
                    vec![],
                )
                .await;
            tokio::time::timeout(Duration::from_secs(5), async {
                while !pc
                    .call(|engine| {
                        Ok(engine.outputs.values().filter(|out| out.reusable).count() == 2)
                    })
                    .await?
                {
                    fixture.step().await?;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await??;
            binding.id = Uuid::new_v4();
            fixture.plans.last_mut().unwrap().outgoing.push(binding);
            fixture
                .driver
                .update(
                    fixture.plans.clone(),
                    vec![fixture.publication.clone()],
                    vec![],
                )
                .await;
            ensure!(
                fixture.output(binding.id, MediaKind::Audio).1 == stream
                    && fixture.output(binding.id, MediaKind::Video).1 == stream,
                "new flow split its audio/video or stole the sibling stream"
            );
            fixture
                .until(|f| {
                    f.observed(&stream, MediaKind::Audio)
                        .is_some_and(|packet| packet.1 != previous_audio.1)
                        && f.observed(&stream, MediaKind::Video)
                            .is_some_and(|packet| packet.1 != previous_video.1)
                })
                .await?;
            previous_audio = fixture.observed(&stream, MediaKind::Audio).unwrap();
            previous_video = fixture.observed(&stream, MediaKind::Video).unwrap();
            ensure!(
                fixture.output(sibling, MediaKind::Audio) == sibling_audio
                    && fixture.output(sibling, MediaKind::Video) == sibling_video
            );
            ensure!(fixture.driver.pairs[&sink].connected() && fixture.driver.pairs[&sink].dc_open);
            let (_, sdp) = pc.local_description().await?;
            ensure!(sdp.lines().filter(|line| line.starts_with("m=")).count() == sections);
            pc.call(|engine| {
                ensure!(engine.outputs.len() == 4, "retired AV leases accumulated");
                Ok(())
            })
            .await?;
        }
        let current_sibling = fixture
            .observed(&sibling_video.1, MediaKind::Video)
            .unwrap();
        ensure!(
            current_sibling.1 == original_sibling.1 && current_sibling.2 != original_sibling.2,
            "healthy sibling stopped or changed RTP identity"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    fixture.close().await;
    result
}
