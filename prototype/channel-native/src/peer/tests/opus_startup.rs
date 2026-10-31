use super::*;
use rtc::{
    media_stream::MediaStreamTrack,
    rtp_transceiver::rtp_sender::{RTCRtpCodingParameters, RTCRtpEncodingParameters},
};
use webrtc::media_stream::track_local::{static_rtp::TrackLocalStaticRTP, TrackLocal};

struct Voice {
    driver: Driver,
    events: mpsc::Receiver<Event>,
    ready: mpsc::Receiver<SourceReady>,
    peers: Vec<(Uuid, Uuid, Arc<dyn PeerConnection>)>,
    received: Option<Arc<dyn TrackRemote>>,
}
impl Voice {
    async fn step(&mut self) -> Result<()> {
        tokio::select! {
            Some(ready) = self.ready.recv() => self.driver.source_ready(ready).await?,
            Some(event) = self.events.recv() => match event {
                Event::Candidate(id, candidate) => {
                    if let Some((_, _, remote)) = self.peers.iter().find(|(pair, _, _)| *pair == id) {
                        remote.add_ice_candidate(candidate.to_json()?).await?;
                    } else if let Some((pair, _, _)) = self.peers.iter().find(|(_, remote, _)| *remote == id) {
                        self.driver.pairs[pair].pc.add_ice_candidate(candidate.to_json()?).await?;
                    }
                }
                Event::Negotiate(_) => {}, // SDP completion is deliberately controlled below.
                Event::Track(id, track) if id == self.peers[1].1 => self.received = Some(track),
                event => self.driver.event(event).await?,
            }
        }
        Ok(())
    }
    async fn settle(&mut self) -> Result<()> {
        let until = tokio::time::Instant::now() + Duration::from_millis(20);
        while let Ok(result) = tokio::time::timeout_at(until, self.step()).await {
            result?;
        }
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opus_startup_and_padding_preserve_only_real_sequence_gaps() -> Result<()> {
    let (mut d, events, _commands, _stop) = driver();
    let (ready_tx, ready) = mpsc::channel(8);
    d.ready_sources = ready_tx;
    let publication = Uuid::new_v4();
    let upstream = Uuid::new_v4();
    let downstream = Uuid::new_v4();
    let publisher_id = Uuid::new_v4();
    let viewer_id = Uuid::new_v4();
    let incoming = Uuid::new_v4();
    let outgoing = Uuid::new_v4();
    d.update(
        vec![
            PairInfo {
                id: upstream,
                peer_id: publisher_id,
                rooms: vec![],
                outgoing: vec![],
                incoming: vec![FlowBinding {
                    id: incoming,
                    publication_id: publication,
                    input_flow_id: None,
                    selected: true,
                }],
            },
            PairInfo {
                id: downstream,
                peer_id: viewer_id,
                rooms: vec!["voice".into()],
                incoming: vec![],
                outgoing: vec![FlowBinding {
                    id: outgoing,
                    publication_id: publication,
                    input_flow_id: Some(incoming),
                    selected: true,
                }],
            },
        ],
        vec![PublicationInfo {
            id: publication,
            kind: Kind::Voice,
            room_id: "voice".into(),
            session_id: publisher_id,
            user_id: publisher_id,
            muted: false,
        }],
        vec![],
    )
    .await?;
    d.pairs.get_mut(&upstream).unwrap().polite = true;
    let mut peers = Vec::new();
    for (pair, remote) in [(upstream, publisher_id), (downstream, viewer_id)] {
        let pc = builder(
            pair == downstream,
            SenderReports::default(),
            MediaFeedback::default(),
        )?
        .with_handler(Arc::new(Handler {
            pair: remote,
            events: d.events.clone(),
            overflow: Arc::new(AtomicBool::new(false)),
            state: Arc::new(AtomicU8::new(RTCPeerConnectionState::New as u8)),
        }))
        .with_udp_addrs(vec!["0.0.0.0:0".into()])
        .build()
        .await?;
        peers.push((pair, remote, Arc::new(pc) as Arc<dyn PeerConnection>));
    }
    let publisher = peers[0].2.clone();
    let viewer = peers[1].2.clone();
    let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
        "voice-source".into(),
        "opus".into(),
        "voice".into(),
        RtpCodecKind::Audio,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters {
                ssrc: Some(7),
                ..Default::default()
            },
            codec: codec(),
            ..Default::default()
        }],
    )));
    let sender = publisher.add_track(track.clone()).await?;
    let mut fixture = Voice {
        driver: d,
        events,
        ready,
        peers,
        received: None,
    };
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        // The downstream control connection precedes the audio sender, as in the UI.
        negotiate(&mut fixture.driver, downstream, &*viewer).await?;
        publisher.set_local_description(publisher.create_offer(None).await?).await?;
        fixture.driver.signal(upstream, Signal {
            description: Some(Description { kind: "offer".into(), sdp: Some(publisher.local_description().await.unwrap().sdp) }),
            tracks: Some(vec![WireTrack { flow_id: incoming, stream_id: "voice-source".into() }]),
            exchange_id: Some(Uuid::new_v4()), candidate: None, resync: None,
        }).await?;
        let answer = fixture.driver.pairs[&upstream].answer.as_ref().unwrap().description.as_ref().unwrap();
        publisher.set_remote_description(serde_json::from_value(serde_json::json!({"type":"answer", "sdp":answer.sdp}))?).await?;
        while !fixture.driver.pairs.values().all(Pair::connected) { fixture.step().await?; }
        let payload_type = sender.get_parameters().await?.rtp_parameters.codecs.into_iter()
            .find(|codec| codec.rtp_codec.mime_type.eq_ignore_ascii_case("audio/opus")).unwrap().payload_type;
        let packet = |sequence: u16, padding: bool| rtp::Packet {
            header: rtp::Header { version: 2, payload_type, ssrc: 7, sequence_number: sequence,
                timestamp: u32::from(sequence) * 960, padding, ..Default::default() },
            payload: if padding { Default::default() } else { vec![0xf8, 0xff, 0xfe].into() },
        };
        track.write_rtp(packet(1000, false)).await?;
        while fixture.driver.sources.is_empty() { fixture.step().await?; }
        // These packets arrive while this new output has no negotiated sending format.
        for sequence in 1001..=1004 {
            track.write_rtp(packet(sequence, false)).await?;
            fixture.settle().await?;
        }
        negotiate(&mut fixture.driver, downstream, &*viewer).await?;
        fixture.settle().await?;
        // A valid padding packet occupies 1006. Deliberately never send media 1008.
        for (sequence, padding) in [(1005, false), (1006, true), (1007, false), (1009, false)] {
            track.write_rtp(packet(sequence, padding)).await?;
            fixture.settle().await?;
        }
        // Browsers probe with padding in a burst, not one packet per media tick.
        for sequence in 1010..=1091 {
            track.write_rtp(packet(sequence, true)).await?;
        }
        track.write_rtp(packet(1092, false)).await?;
        fixture.settle().await?;
        track.write_rtp(packet(1093, false)).await?;
        fixture.settle().await?;
        while fixture.received.is_none() { fixture.step().await?; }
        let received = fixture.received.as_ref().unwrap();
        let mut actual = Vec::new();
        loop {
            if let Some(TrackRemoteEvent::OnRtpPacket(packet)) = received.poll().await {
                actual.push((packet.header.sequence_number, packet.header.padding, packet.payload.len()));
                if packet.header.sequence_number == 1093 { break; }
            }
        }
        eprintln!("Opus actual downstream (sequence, padding, payload): {actual:?}");
        let mut expected = vec![(1005, false, 3), (1006, true, 0), (1007, false, 3), (1009, false, 3)];
        expected.extend((1010..=1091).map(|sequence| (sequence, true, 0)));
        expected.extend([(1092, false, 3), (1093, false, 3)]);
        anyhow::ensure!(actual == expected,
            "pre-negotiation stale media and filtered padding must not create gaps; unsent media 1008 must remain missing");
        Ok::<_, anyhow::Error>(())
    }).await;
    fixture.driver.update(vec![], vec![], vec![]).await?;
    publisher.close().await?;
    viewer.close().await?;
    fixture.driver.files.close().await;
    result??;
    Ok(())
}
