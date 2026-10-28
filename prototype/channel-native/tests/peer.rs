//! Real local PCs exercise the adapter's source-generation handoff. Room
//! authority/routing are covered by the domain gate; this fixture supplies leases.
use anyhow::Result;
use piik_channel_native::peer::NativePeers;
use piik_channel_prototype::wire::{
    Candidate, Command, Description, Kind, PairInfo, PublicationInfo, Signal, Track as WireTrack,
};
use rtc::{
    media_stream::MediaStreamTrack,
    peer_connection::{
        configuration::media_engine::{MediaEngine, MIME_TYPE_OPUS},
        sdp::RTCSessionDescription,
    },
    rtp,
    rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
        RtpCodecKind,
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    time::{sleep, timeout},
};
use uuid::Uuid;
use webrtc::{
    media_stream::{
        track_local::{static_rtp::TrackLocalStaticRTP, TrackLocal},
        track_remote::{TrackRemote, TrackRemoteEvent},
    },
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
        RTCPeerConnectionIceEvent,
    },
};

enum Event {
    Negotiate(Uuid),
    Candidate(Uuid, Candidate),
}
struct Handler {
    id: Uuid,
    events: mpsc::Sender<Event>,
    packets: mpsc::Sender<rtp::Packet>,
}
#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_negotiation_needed(&self) {
        self.events.try_send(Event::Negotiate(self.id)).unwrap();
    }
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        let c = event.candidate.to_json().unwrap();
        self.events
            .try_send(Event::Candidate(
                self.id,
                Candidate {
                    candidate: Some(c.candidate),
                    sdp_mid: c.sdp_mid,
                    sdp_m_line_index: c.sdp_mline_index,
                    username_fragment: c.username_fragment,
                },
            ))
            .unwrap();
    }
    async fn on_data_channel(&self, dc: Arc<dyn webrtc::data_channel::DataChannel>) {
        tokio::spawn(async move { while dc.poll().await.is_some() {} });
    }
    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let packets = self.packets.clone();
        tokio::spawn(async move {
            while let Some(event) = track.poll().await {
                if let TrackRemoteEvent::OnRtpPacket(packet) = event {
                    let _ = packets.try_send(packet);
                }
            }
        });
    }
}
struct Endpoint {
    pc: Arc<dyn PeerConnection>,
    pending: bool,
    polite: bool,
    sent: Option<Signal>,
    candidates: Vec<Candidate>,
    tracks: Arc<Mutex<Vec<WireTrack>>>,
}
fn codec() -> RTCRtpCodec {
    RTCRtpCodec {
        mime_type: MIME_TYPE_OPUS.into(),
        clock_rate: 48000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
        rtcp_feedback: vec![],
    }
}
async fn endpoint(
    native_id: Uuid,
    id: Uuid,
    payload_type: u8,
    events: mpsc::Sender<Event>,
    packets: mpsc::Sender<rtp::Packet>,
) -> Result<Endpoint> {
    let mut media = MediaEngine::default();
    media.register_codec(
        RTCRtpCodecParameters {
            rtp_codec: codec(),
            payload_type,
            ..Default::default()
        },
        RtpCodecKind::Audio,
    )?;
    let pc: Arc<dyn PeerConnection> = Arc::new(
        PeerConnectionBuilder::<String>::new()
            .with_media_engine(media)
            .with_handler(Arc::new(Handler {
                id,
                events,
                packets,
            }))
            .with_udp_addrs(vec!["0.0.0.0:0".into()])
            .build()
            .await?,
    );
    let polite = id > native_id;
    if !polite {
        pc.create_data_channel("piik-room", None).await?;
    }
    Ok(Endpoint {
        pc,
        polite,
        sent: None,
        pending: false,
        candidates: vec![],
        tracks: Arc::new(Mutex::new(vec![])),
    })
}
async fn add_source(
    endpoint: &Endpoint,
    publication: Uuid,
    ssrc: u32,
) -> Result<Arc<TrackLocalStaticRTP>> {
    let stream = Uuid::new_v4().to_string();
    let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
        stream.clone(),
        Uuid::new_v4().to_string(),
        "test Opus".into(),
        RtpCodecKind::Audio,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters {
                ssrc: Some(ssrc),
                ..Default::default()
            },
            codec: codec(),
            ..Default::default()
        }],
    )));
    endpoint.tracks.lock().unwrap().push(WireTrack {
        publication_id: publication,
        stream_id: stream,
    });
    endpoint.pc.add_track(track.clone()).await?;
    Ok(track)
}
fn packet(seq: u16, timestamp: u32, ssrc: u32) -> rtp::Packet {
    rtp::Packet {
        header: rtp::header::Header {
            version: 2,
            payload_type: 111,
            sequence_number: seq,
            timestamp,
            ssrc,
            ..Default::default()
        },
        payload: vec![0xf8, 0xff, 0xfe].into(),
    }
}
#[derive(Default)]
struct Loss {
    pair: Option<Uuid>,
    offer: bool,
    answer: bool,
    offers: Vec<Signal>,
    answers_dropped: usize,
    held: Option<Signal>,
    inject_held: bool,
    held_injected: usize,
}
async fn description(
    native: &NativePeers,
    id: Uuid,
    e: &mut Endpoint,
    loss: &Mutex<Loss>,
    exchange: Uuid,
) -> Result<()> {
    let d = e.pc.local_description().await.unwrap();
    let tracks = e.tracks.lock().unwrap().clone();
    let payload = Signal {
        description: Some(Description {
            kind: d.sdp_type.to_string(),
            sdp: Some(d.sdp),
        }),
        candidate: None,
        tracks: Some(tracks),
        resync: None,
        exchange_id: Some(exchange),
    };
    e.sent = Some(payload.clone());
    let drop = {
        let mut loss = loss.lock().unwrap();
        if loss.pair == Some(id)
            && loss.answer
            && payload.description.as_ref().unwrap().kind == "answer"
        {
            loss.answer = false;
            loss.answers_dropped += 1;
            loss.held = Some(payload.clone());
            true
        } else {
            false
        }
    };
    if !drop {
        let old = {
            let mut loss = loss.lock().unwrap();
            if loss.inject_held {
                loss.inject_held = false;
                loss.held_injected += 1;
                loss.held.clone()
            } else {
                None
            }
        };
        if let Some(old) = old {
            native.signal(id, old).await?;
        }
        // Deliver a duplicate too: native must not reapply an offer or answer.
        native.signal(id, payload.clone()).await?;
        native.signal(id, payload).await?;
    }
    Ok(())
}
fn candidate(c: Candidate) -> rtc::peer_connection::transport::RTCIceCandidateInit {
    rtc::peer_connection::transport::RTCIceCandidateInit {
        candidate: c.candidate.unwrap_or_default(),
        sdp_mid: c.sdp_mid,
        sdp_mline_index: c.sdp_m_line_index,
        username_fragment: c.username_fragment,
        url: None,
    }
}
async fn pump(
    native: Arc<NativePeers>,
    mut endpoints: HashMap<Uuid, Endpoint>,
    mut commands: mpsc::Receiver<Command>,
    mut events: mpsc::Receiver<Event>,
    mut stop: watch::Receiver<bool>,
    mut pause: watch::Receiver<bool>,
    reports: mpsc::Sender<Command>,
    loss: Arc<Mutex<Loss>>,
) -> Result<()> {
    loop {
        tokio::select! {
        _=stop.changed()=>break,
        _=pause.changed()=>{},
        Some(event)=events.recv()=>match event {
         Event::Negotiate(id)=>{let e=endpoints.get_mut(&id).unwrap();if !e.pending {e.pc.set_local_description(e.pc.create_offer(None).await?).await?;e.pending=true;description(&native,id,e,&loss,Uuid::new_v4()).await?;}},
         Event::Candidate(id,c)=>native.signal(id,Signal{candidate:Some(c),description:None,tracks:None,resync:None,exchange_id:None}).await?,
        },
        Some(command)=commands.recv(),if !*pause.borrow()=>match command {
         Command::Signal{pair_id:id,payload}=>{
          let drop={let mut loss=loss.lock().unwrap();if loss.pair==Some(id)&&payload.description.as_ref().is_some_and(|d|d.kind=="offer") {loss.offers.push(payload.clone());if loss.offer{loss.offer=false;true}else{false}}else{false}};
          if drop {continue;}let e=endpoints.get_mut(&id).unwrap();
          if payload.resync==Some(true) {if e.pending {if let Some(original)=e.sent.clone(){native.signal(id,original).await?;}}continue;}
          if let Some(d)=payload.description {
           let offer=d.kind=="offer";
           let exchange=payload.exchange_id.unwrap();
           if !offer && (!e.pending||e.sent.as_ref().and_then(|sent|sent.exchange_id)!=Some(exchange)){continue;}
           if offer&&e.sent.as_ref().is_some_and(|sent|sent.exchange_id==Some(exchange)&&sent.description.as_ref().is_some_and(|d|d.kind=="answer")){native.signal(id,e.sent.clone().unwrap()).await?;continue;}
           if offer&&e.pending&&!e.polite {continue;}
           if offer&&e.pending {e.pc.set_local_description(serde_json::from_value(serde_json::json!({"type":"rollback","sdp":""}))?).await?;e.pending=false;}
           let desc:RTCSessionDescription=serde_json::from_value(serde_json::json!({"type":d.kind,"sdp":d.sdp.unwrap_or_default()}))?;
           e.pc.set_remote_description(desc).await?;for c in e.candidates.drain(..){e.pc.add_ice_candidate(candidate(c)).await?;}
           if offer {e.pc.set_local_description(e.pc.create_answer(None).await?).await?;description(&native,id,e,&loss,exchange).await?;}else{e.pending=false;}
          }else if let Some(c)=payload.candidate {if e.pc.remote_description().await.is_some(){e.pc.add_ice_candidate(candidate(c)).await?;}else{e.candidates.push(c);}}
         },
         command=>{let _=reports.try_send(command);},
        }
        }
    }
    for (_, endpoint) in endpoints {
        endpoint.pc.close().await?;
    }
    Ok(())
}
async fn next_matching(rx: &mut mpsc::Receiver<rtp::Packet>, ssrc: Option<u32>) -> rtp::Packet {
    timeout(Duration::from_secs(10), async {
        loop {
            let packet = rx.recv().await.unwrap();
            if ssrc.is_none_or(|ssrc| ssrc == packet.header.ssrc) {
                return packet;
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn first_packet_switches_source_clock_and_preserves_old_audio_until_handoff() -> Result<()> {
    for native_id in [Uuid::nil(), Uuid::from_u128(u128::MAX)] {
        timeout(Duration::from_secs(45), async {
            let publication = Uuid::new_v4();
            let a = Uuid::new_v4();
            let b = Uuid::new_v4();
            let receiver = Uuid::new_v4();
            let (cmd_tx, cmd_rx) = mpsc::channel(64);
            let native = Arc::new(NativePeers::new(native_id, vec![], cmd_tx));
            let (event_tx, event_rx) = mpsc::channel(1024);
            let (packet_tx, mut packets) = mpsc::channel(1024);
            let (report_tx, mut reports) = mpsc::channel(256);
            let ea = endpoint(native_id, a, 111, event_tx.clone(), packet_tx.clone()).await?;
            let eb = endpoint(native_id, b, 111, event_tx.clone(), packet_tx.clone()).await?;
            let er = endpoint(native_id, receiver, 109, event_tx, packet_tx).await?;
            let receiver_pc = er.pc.clone();
            let source_a = add_source(&ea, publication, 0x11111111).await?;
            let b_pc = eb.pc.clone();
            let b_tracks = eb.tracks.clone();
            let info = PublicationInfo {
                id: publication,
                room_id: "room".into(),
                session_id: Uuid::new_v4(),
                user_id: Uuid::new_v4(),
                kind: Kind::Voice,
                muted: false,
            };
            let plans = |new_source| {
                vec![
                    PairInfo {
                        id: a,
                        peer_id: a,
                        rooms: vec!["room".into()],
                        incoming: if new_source {
                            vec![]
                        } else {
                            vec![publication]
                        },
                        outgoing: vec![],
                    },
                    PairInfo {
                        id: b,
                        peer_id: b,
                        rooms: vec!["room".into()],
                        incoming: if new_source {
                            vec![publication]
                        } else {
                            vec![]
                        },
                        outgoing: vec![],
                    },
                    PairInfo {
                        id: receiver,
                        peer_id: receiver,
                        rooms: vec!["room".into()],
                        incoming: vec![],
                        outgoing: vec![publication],
                    },
                ]
            };
            native.update(plans(false), vec![info.clone()]).await?;
            let (stop_tx, stop_rx) = watch::channel(false);
            let (pause_tx, pause_rx) = watch::channel(false);
            let loss = Arc::new(Mutex::new(Loss::default()));
            let pump = tokio::spawn(pump(
                native.clone(),
                HashMap::from([(a, ea), (b, eb), (receiver, er)]),
                cmd_rx,
                event_rx,
                stop_rx,
                pause_rx,
                report_tx,
                loss.clone(),
            ));
            // Start only after all three real reliable DCs are ready.
            timeout(Duration::from_secs(12), async {
                let mut ready = std::collections::HashSet::new();
                while ready.len() < 3 {
                    if let Some(Command::BaseState {
                        pair_id,
                        ready: true,
                        ..
                    }) = reports.recv().await
                    {
                        ready.insert(pair_id);
                    }
                }
            })
            .await?;
            // The receiver offers its own dynamic Opus PT before Native attaches
            // a sender to that negotiated transceiver. PT111 is not universal.
            receiver_pc
                .add_transceiver_from_kind(
                    RtpCodecKind::Audio,
                    Some(rtc::rtp_transceiver::RTCRtpTransceiverInit {
                        direction: rtc::rtp_transceiver::RTCRtpTransceiverDirection::Recvonly,
                        ..Default::default()
                    }),
                )
                .await?;
            timeout(Duration::from_secs(3), async {
                loop {
                    if receiver_pc.pending_local_description().await.is_none()
                        && receiver_pc
                            .current_remote_description()
                            .await
                            .is_some_and(|d| d.sdp.contains("a=rtpmap:109 opus/48000"))
                    {
                        break;
                    }
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await?;
            let sender_a = tokio::spawn(async move {
                for seq in 1000..4000 {
                    source_a
                        .write_rtp(packet(seq, 50_000 + (seq as u32 - 1000) * 960, 0x11111111))
                        .await
                        .unwrap();
                    sleep(Duration::from_millis(20)).await;
                }
            });
            let first = next_matching(&mut packets, None).await;
            let old_ssrc = first.header.ssrc;
            assert_ne!(old_ssrc, 0x11111111);
            assert_eq!(first.header.payload_type, 109);
            assert!(first.payload.as_ref() == [0xf8, 0xff, 0xfe]);
            native.update(plans(true), vec![info.clone()]).await?;
            let eb = Endpoint {
                pc: b_pc,
                pending: false,
                polite: b > native_id,
                sent: None,
                candidates: vec![],
                tracks: b_tracks,
            };
            let source_b = add_source(&eb, publication, 0x22222222).await?;
            // Control switches the input lease and negotiates B, but B sends nothing yet.
            // A's old track must remain audible until B actually delivers a packet.
            let mut old = vec![];
            for _ in 0..8 {
                old.push(next_matching(&mut packets, Some(old_ssrc)).await);
            }
            assert!(old.windows(2).all(|w| w[1]
                .header
                .timestamp
                .wrapping_sub(w[0].header.timestamp)
                == w[1]
                    .header
                    .sequence_number
                    .wrapping_sub(w[0].header.sequence_number) as u32
                    * 960));
            while let Ok(command) = reports.try_recv() {
                assert!(!matches!(command,Command::FlowState{pair_id,ready:true,..}if pair_id==b));
            }
            // A distinct source clock deliberately restarts at low values.
            let sender_b = tokio::spawn(async move {
                for seq in 10..1000 {
                    source_b
                        .write_rtp(packet(seq, 700 + (seq as u32 - 10) * 960, 0x22222222))
                        .await
                        .unwrap();
                    sleep(Duration::from_millis(20)).await;
                }
            });
            let switched = timeout(Duration::from_secs(10), async {
                loop {
                    let p = packets.recv().await.unwrap();
                    if p.header.ssrc != old_ssrc {
                        break p;
                    }
                }
            })
            .await?;
            assert_ne!(switched.header.ssrc, 0x22222222);
            assert!(switched.header.sequence_number < 1000);
            assert_eq!(
                switched.header.timestamp,
                700 + (switched.header.sequence_number as u32 - 10) * 960
            );
            let new_ssrc = switched.header.ssrc;
            for _ in 0..6 {
                let p = next_matching(&mut packets, Some(new_ssrc)).await;
                assert_eq!(
                    p.header.timestamp,
                    700 + (p.header.sequence_number as u32 - 10) * 960
                );
            }
            // Fill the existing signaling output while audio is established. No RTP
            // packet may depend on that queue or an awaited control turn completing.
            pause_tx.send(true)?;
            sleep(Duration::from_millis(50)).await;
            let mut crowded = plans(true);
            for pair in &mut crowded {
                pair.rooms = (0..160).map(|i| format!("room-{i}")).collect();
            }
            let updating = {
                let native = native.clone();
                let info = info.clone();
                tokio::spawn(async move { native.update(crowded, vec![info]).await })
            };
            sleep(Duration::from_millis(150)).await;
            assert!(
                !updating.is_finished(),
                "the real command output must be backpressured"
            );
            for _ in 0..10 {
                let p = next_matching(&mut packets, Some(new_ssrc)).await;
                assert_eq!(
                    p.header.timestamp,
                    700 + (p.header.sequence_number as u32 - 10) * 960
                );
            }
            pause_tx.send(false)?;
            timeout(Duration::from_secs(3), updating).await???;
            // Lose one real offer and then its first answer while primary audio
            // continues. Resync must replay exact SDP/tracks, preserving this PC.
            let second = Uuid::new_v4();
            let mut second_info = info.clone();
            second_info.id = second;
            let mut expanded = plans(true);
            expanded
                .iter_mut()
                .find(|p| p.id == b)
                .unwrap()
                .incoming
                .push(second);
            expanded
                .iter_mut()
                .find(|p| p.id == receiver)
                .unwrap()
                .outgoing
                .push(second);
            *loss.lock().unwrap() = Loss {
                pair: Some(receiver),
                offer: true,
                answer: true,
                ..Default::default()
            };
            native
                .update(expanded, vec![info.clone(), second_info])
                .await?;
            let second_track = add_source(&eb, second, 0x33333333).await?;
            let second_sender = tokio::spawn(async move {
                for seq in 4000..5000 {
                    second_track
                        .write_rtp(packet(seq, 90000 + (seq as u32 - 4000) * 960, 0x33333333))
                        .await
                        .unwrap();
                    sleep(Duration::from_millis(20)).await;
                }
            });
            timeout(Duration::from_secs(5), async {
                while loss.lock().unwrap().offers.is_empty() {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await?;
            for _ in 0..8 {
                next_matching(&mut packets, Some(new_ssrc)).await;
            }
            native.resync().await?;
            timeout(Duration::from_secs(5), async {
                while loss.lock().unwrap().answers_dropped == 0 {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await?;
            for _ in 0..8 {
                next_matching(&mut packets, Some(new_ssrc)).await;
            }
            native.resync().await?;
            let secondary = timeout(Duration::from_secs(5), async {
                loop {
                    let packet = packets.recv().await.unwrap();
                    if packet.header.ssrc != new_ssrc {
                        break packet;
                    }
                }
            })
            .await?;
            assert_eq!(
                secondary.header.timestamp,
                90000 + (secondary.header.sequence_number as u32 - 4000) * 960
            );
            {
                let loss = loss.lock().unwrap();
                assert!(loss.offers.len() >= 3);
                let original = serde_json::to_value(&loss.offers[0])?;
                assert_eq!(original, serde_json::to_value(&loss.offers[1])?);
                assert_eq!(original, serde_json::to_value(&loss.offers[2])?);
            }
            for _ in 0..8 {
                next_matching(&mut packets, Some(new_ssrc)).await;
            }
            // Revoke the pending offer's extra publication while its answer is
            // held by the carrier. Complete the original SDP without its revoked
            // mapping, then fence the held old answer from the next exchange.
            *loss.lock().unwrap() = Loss {
                pair: Some(receiver),
                answer: true,
                ..Default::default()
            };
            eb.tracks
                .lock()
                .unwrap()
                .retain(|track| track.publication_id != second);
            let replacement = add_source(&eb, second, 0x44444444).await?;
            let replacement_sender = tokio::spawn(async move {
                for seq in 6000..7000 {
                    replacement
                        .write_rtp(packet(seq, 190000 + (seq as u32 - 6000) * 960, 0x44444444))
                        .await
                        .unwrap();
                    sleep(Duration::from_millis(20)).await;
                }
            });
            timeout(Duration::from_secs(5), async {
                while loss.lock().unwrap().held.is_none() {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await?;
            let retired_exchange = loss
                .lock()
                .unwrap()
                .held
                .as_ref()
                .unwrap()
                .exchange_id
                .unwrap();
            native.update(plans(true), vec![info.clone()]).await?;
            loss.lock().unwrap().inject_held = true;
            native.resync().await?;
            timeout(Duration::from_secs(5), async {
                while loss.lock().unwrap().held_injected == 0 {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await?;
            for _ in 0..10 {
                next_matching(&mut packets, Some(new_ssrc)).await;
            }
            {
                let loss = loss.lock().unwrap();
                let original = loss
                    .offers
                    .iter()
                    .find(|offer| offer.exchange_id == Some(retired_exchange))
                    .unwrap();
                let replay = loss
                    .offers
                    .iter()
                    .filter(|offer| offer.exchange_id == Some(retired_exchange))
                    .nth(1)
                    .expect("the original exchange must finish first");
                assert_eq!(
                    serde_json::to_value(&original.description)?,
                    serde_json::to_value(&replay.description)?
                );
                assert!(replay
                    .tracks
                    .as_ref()
                    .unwrap()
                    .iter()
                    .all(|track| track.publication_id != second));
                let fresh = loss
                    .offers
                    .iter()
                    .find(|offer| offer.exchange_id != Some(retired_exchange))
                    .expect("ordinary next negotiation uses a fresh exchange");
                assert!(fresh
                    .tracks
                    .as_ref()
                    .unwrap()
                    .iter()
                    .all(|track| track.publication_id != second));
            }
            while let Ok(command) = reports.try_recv() {
                assert!(!matches!(
                    command,
                    Command::LinkState {
                        state: piik_channel_prototype::wire::LinkState::Failed,
                        ..
                    }
                ));
            }
            // Publication visibility is not an input lease. The Browser source
            // keeps sending, but removing the last incoming demand must end the
            // Native reader and stop forwarding without closing the base PC.
            let mut no_input = plans(true);
            for pair in &mut no_input {
                pair.incoming.clear();
            }
            native.update(no_input, vec![info.clone()]).await?;
            sleep(Duration::from_millis(100)).await;
            while packets.try_recv().is_ok() {}
            assert!(timeout(Duration::from_millis(150), packets.recv())
                .await
                .is_err());
            replacement_sender.abort();
            let _ = replacement_sender.await;
            second_sender.abort();
            let _ = second_sender.await;
            sender_a.abort();
            sender_b.abort();
            let _ = sender_a.await;
            let _ = sender_b.await;
            stop_tx.send(true)?;
            pump.await??;
            Arc::try_unwrap(native).ok().unwrap().close().await?;
            Ok::<_, anyhow::Error>(())
        })
        .await??;
    }
    Ok(())
}

#[tokio::test]
async fn close_cancels_a_full_command_output() -> Result<()> {
    let (tx, commands) = mpsc::channel(1);
    let native = NativePeers::new(Uuid::nil(), vec![], tx);
    native
        .update(
            vec![PairInfo {
                id: Uuid::new_v4(),
                peer_id: Uuid::new_v4(),
                rooms: vec!["room".into()],
                incoming: vec![],
                outgoing: vec![],
            }],
            vec![],
        )
        .await?;
    sleep(Duration::from_millis(150)).await;
    assert_eq!(commands.len(), 1);
    timeout(Duration::from_secs(3), native.close()).await??;
    Ok(())
}
