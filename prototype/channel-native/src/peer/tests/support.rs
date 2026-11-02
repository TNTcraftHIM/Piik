//! Shared real endpoint and Driver fixture. Encoded samples exercise transport, not playback.
use super::*;
use piik_channel_core::wire::{FlowBinding, Kind};

pub(in crate::peer) struct Parent {
    pub(in crate::peer) feedback: Arc<tokio::sync::Mutex<mpsc::Receiver<()>>>,
    pub(in crate::peer) pair: Uuid,
    pub(in crate::peer) stream: String,
    pub(in crate::peer) audio: Uuid,
    pub(in crate::peer) video: Uuid,
    pub(in crate::peer) base: u32,
    pub(in crate::peer) keyframe_after_pli: usize,
}
pub(in crate::peer) struct Fixture {
    pub(in crate::peer) withheld: HashSet<Uuid>,
    pub(in crate::peer) video_codec: RtpCodec,
    pub(in crate::peer) writable: HashMap<Uuid, Arc<Notify>>,
    pub(in crate::peer) plis: HashMap<Uuid, usize>,
    pub(in crate::peer) driver: Driver,
    pub(in crate::peer) events: mpsc::Receiver<Event>,
    pub(in crate::peer) commands: mpsc::Receiver<NativeEvent>,
    pub(in crate::peer) sources: mpsc::Receiver<SourceReady>,
    pub(in crate::peer) remote_events: mpsc::Receiver<Event>,
    pub(in crate::peer) remote_sender: mpsc::Sender<Event>,
    pub(in crate::peer) remote: HashMap<Uuid, Transport>,
    pub(in crate::peer) runtimes: Vec<transport::Runtime>,
    pub(in crate::peer) tracks: HashMap<String, Track>,
    pub(in crate::peer) packets: HashMap<String, Vec<rtp::Packet>>,
    pub(in crate::peer) reports: HashMap<u32, Vec<rtc_rtcp::sender_report::SenderReport>>,
    pub(in crate::peer) parents: Vec<Parent>,
    pub(in crate::peer) tick: tokio::time::Interval,
    pub(in crate::peer) epoch: Instant,
    pub(in crate::peer) frame: u32,
    pub(in crate::peer) plans: Vec<PairInfo>,
    pub(in crate::peer) publication: PublicationInfo,
    pub(in crate::peer) sink: Uuid,
    pub(in crate::peer) _stop: watch::Sender<bool>,
}

impl Fixture {
    pub(in crate::peer) async fn new(video_codec: RtpCodec) -> Result<Self> {
        let (commands, output) = mpsc::channel(256);
        let (events, input) = mpsc::channel(1024);
        let (ready, sources) = mpsc::channel(64);
        let (stop, cancel) = watch::channel(false);
        let (remote_sender, remote_events) = mpsc::channel(256);
        let fixed = server_udp::ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
        let driver = Driver {
            transport: transport::Runtime::new(Some(fixed.clone())),
            session: Uuid::nil(),
            ice: vec![],
            server_udp: Some(fixed),
            commands,
            links: Default::default(),
            cancel,
            events,
            ready_sources: ready,
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
        };
        let publication = PublicationInfo {
            id: Uuid::new_v4(),
            room_id: "room".into(),
            session_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            kind: Kind::Screen,
            muted: false,
            paused: false,
        };
        let mut f = Self {
            withheld: HashSet::new(),
            video_codec,
            writable: HashMap::new(),
            plis: HashMap::new(),
            driver,
            events: input,
            commands: output,
            sources,
            remote_events,
            remote_sender,
            remote: HashMap::new(),
            runtimes: vec![],
            tracks: HashMap::new(),
            packets: HashMap::new(),
            reports: HashMap::new(),
            parents: vec![],
            tick: tokio::time::interval(Duration::from_millis(20)),
            epoch: Instant::now(),
            frame: 0,
            plans: vec![],
            publication,
            sink: Uuid::new_v4(),
            _stop: stop,
        };
        let first = f.add_remote(Uuid::new_v4()).await?;
        let second = f.add_remote(Uuid::new_v4()).await?;
        f.add_remote(f.sink).await?;
        let first_input = Uuid::new_v4();
        let second_input = Uuid::new_v4();
        let old_output = Uuid::new_v4();
        let warm_output = Uuid::new_v4();
        for (pair, flow, selected) in [(first, first_input, true), (second, second_input, false)] {
            f.plans.push(PairInfo {
                id: pair,
                peer_id: Uuid::new_v4(),
                udp_preparation: None,
                can_receive_video_layers: false,
                rooms: vec!["room".into()],
                incoming: vec![FlowBinding {
                    id: flow,
                    publication_id: f.publication.id,
                    input_flow_id: None,
                    selected,
                }],
                outgoing: vec![],
            });
        }
        f.plans.push(PairInfo {
            id: f.sink,
            peer_id: Uuid::new_v4(),
            udp_preparation: None,
            can_receive_video_layers: false,
            rooms: vec!["room".into()],
            incoming: vec![],
            outgoing: vec![
                FlowBinding {
                    id: old_output,
                    publication_id: f.publication.id,
                    input_flow_id: Some(first_input),
                    selected: true,
                },
                FlowBinding {
                    id: warm_output,
                    publication_id: f.publication.id,
                    input_flow_id: Some(second_input),
                    selected: false,
                },
            ],
        });
        f.driver
            .update(f.plans.clone(), vec![f.publication.clone()], vec![])
            .await?;
        for (index, pair) in [first, second].into_iter().enumerate() {
            f.start_parent(pair, 500_000 + index as u32 * 900_000)
                .await?;
        }
        f.epoch = Instant::now();
        f.tick = tokio::time::interval(Duration::from_millis(20));
        Ok(f)
    }
    pub(in crate::peer) async fn add_remote(&mut self, pair: Uuid) -> Result<Uuid> {
        let fixed = server_udp::ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
        let runtime = transport::Runtime::new(Some(fixed));
        let (_, demand) = watch::channel(Some(1_000_000));
        let (handle, _) = runtime
            .add(
                pair,
                None,
                self.remote_sender.clone(),
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicU8::new(0)),
                demand,
                Arc::new(Notify::new()),
                &[],
            )
            .await?;
        self.remote.insert(pair, handle);
        self.runtimes.push(runtime);
        Ok(pair)
    }
    pub(in crate::peer) async fn start_parent(&mut self, pair: Uuid, base: u32) -> Result<()> {
        let stream = Uuid::new_v4().to_string();
        let audio = Uuid::new_v4();
        let video = Uuid::new_v4();
        let remote = &self.remote[&pair];
        let (_, audio_writable) = remote
            .add_output(
                audio,
                codec(),
                MediaKind::Audio,
                stream.clone(),
                vec![String::new()],
            )
            .await?;
        let (feedback, video_writable) = remote
            .add_output(
                video,
                self.video_codec.clone(),
                MediaKind::Video,
                stream.clone(),
                vec![String::new()],
            )
            .await?;
        self.writable.insert(audio, audio_writable);
        self.writable.insert(video, video_writable);
        self.parents.retain(|p| p.pair != pair);
        self.parents.push(Parent {
            feedback: Arc::new(tokio::sync::Mutex::new(feedback)),
            pair,
            stream: stream.clone(),
            audio,
            video,
            base,
            keyframe_after_pli: 0,
        });
        ensure_offer(remote).await?;
        let (kind, sdp) = remote.local_description().await?;
        let flow = self.plans.iter().find(|p| p.id == pair).unwrap().incoming[0].id;
        self.driver
            .signal(
                pair,
                Signal {
                    udp: None,
                    description: Some(Description {
                        kind,
                        sdp: Some(sdp),
                    }),
                    exchange_id: Some(Uuid::new_v4()),
                    tracks: Some(vec![WireTrack {
                        flow_id: flow,
                        stream_id: stream,
                    }]),
                    candidate: None,
                    resync: None,
                },
            )
            .await?;
        Ok(())
    }
    pub(in crate::peer) async fn step(&mut self) -> Result<()> {
        let mut readers = futures_util::stream::FuturesUnordered::new();
        for (id, track) in &self.tracks {
            let id = id.clone();
            let track = track.clone();
            readers.push(async move { (id, track.poll().await) });
        }
        let mut feedbacks = futures_util::stream::FuturesUnordered::new();
        for parent in &self.parents {
            let pair = parent.pair;
            let feedback = parent.feedback.clone();
            feedbacks.push(async move { (pair, feedback.lock().await.recv().await) });
        }
        let changed = self.driver.bandwidth_changed.clone();
        tokio::select! {
            Some((pair,Some(())))=feedbacks.next(),if !feedbacks.is_empty()=>{*self.plis.entry(pair).or_default()+=1;},
            _=changed.notified()=>self.driver.refresh_media(false).await?,
            Some(event)=self.events.recv()=>self.driver.event(event).await?,
            Some(source)=self.sources.recv()=>self.driver.source_ready(source).await?,
            Some(command)=self.commands.recv()=>if let NativeEvent::Command(Command::Signal{pair_id,payload})=command {
                let remote=&self.remote[&pair_id];
                if let Some(description)=payload.description {
                    if description.kind=="offer" && self.withheld.contains(&pair_id){return Ok(());}
                    if description.kind=="answer" {remote.accept(description.kind,description.sdp.unwrap()).await?;}
                    else {
                        remote.accept(description.kind,description.sdp.unwrap()).await?;
                        let(kind,sdp)=remote.local_description().await?;
                        let tracks=self.parents.iter().find(|p|p.pair==pair_id).map(|p|vec![WireTrack{flow_id:self.plans.iter().find(|plan|plan.id==pair_id).unwrap().incoming[0].id,stream_id:p.stream.clone()}]).unwrap_or_default();
                        self.driver.signal(pair_id,Signal{udp:None,description:Some(Description{kind,sdp:Some(sdp)}),exchange_id:payload.exchange_id,tracks:Some(tracks),candidate:None,resync:None}).await?;
                    }
                }else if let Some(candidate)=payload.candidate {let _=remote.add_candidate(candidate.candidate.unwrap_or_default()).await;}
            },
            Some(event)=self.remote_events.recv()=>if let Event::Track(_pair,track)=event {self.tracks.insert(track.id.clone(),track);},
            Some((id,event))=readers.next(),if !readers.is_empty()=>match event {
                Some(TrackEvent::Rtp(packet, ..))=>{let packets=self.packets.entry(id).or_default();if packets.len()<2048{packets.push(packet);}},
                Some(TrackEvent::Report(reports))=>for(sr,_)in reports {let records=self.reports.entry(sr.ssrc).or_default();if records.len()<32{records.push(sr);}},
                Some(TrackEvent::End)|None=>{self.tracks.remove(&id);},
            },
            _=self.tick.tick()=>{
                self.frame+=1;if self.frame%50==0{self.driver.refresh_media(false).await?;self.driver.request_pending_keyframes();}let wallclock=self.epoch+Duration::from_millis(u64::from(self.frame.saturating_sub(1))*20);
                for parent in &self.parents {
                    if self.remote[&parent.pair].confirm(parent.audio).await?.flatten().is_none(){continue;}
                    let audio=rtp::Packet{header:rtp::header::Header{version:2,marker:true,sequence_number:self.frame as u16,timestamp:parent.base.wrapping_add(self.frame*960),..Default::default()},payload:vec![0xf8,0xff,0xfe].into()};
                    send(&self.remote[&parent.pair],parent.audio,vec![audio],wallclock,&self.writable[&parent.audio]).await?;
                    if self.frame%5==0 {
                        let keyframe=self.plis.get(&parent.pair).copied().unwrap_or_default()>=parent.keyframe_after_pli;
                        let payloads=video_payloads(&self.video_codec,self.frame,keyframe)?;
                        let last=payloads.len()-1;
                        let packets=payloads.into_iter().enumerate().map(|(part,payload)|rtp::Packet{header:rtp::header::Header{version:2,marker:part==last,sequence_number:(self.frame as usize+part)as u16,timestamp:parent.base.wrapping_add(self.frame*1800),..Default::default()},payload}).collect();
                        send(&self.remote[&parent.pair],parent.video,packets,wallclock,&self.writable[&parent.video]).await?;
                    }
                }
            }
        }
        // Match the Native actor's completed turn, including adaptive video demand.
        self.driver.reconcile_encodings().await;
        Ok(())
    }
    pub(in crate::peer) async fn until(&mut self, ready: impl Fn(&Self) -> bool) -> Result<()> {
        let result = tokio::time::timeout(Duration::from_secs(12), async {
            while !ready(self) {
                self.step().await?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await;
        if result.is_err() {
            for (id, p) in &self.driver.pairs {
                eprintln!("WARM_STATE pair={id} connected={} pending={:?} negotiate={} stable={:?} outputs={:?}",p.connected(),p.pending_offer.as_ref().map(|o|&o.outputs),p.negotiate,p.stable_outputs,p.outputs.values().map(|o|(o.id,o.source,o.stream.clone())).collect::<Vec<_>>());
            }
            eprintln!(
                "WARM_STATE frames={} sources={} tracks={:?}",
                self.frame,
                self.driver.sources.len(),
                self.tracks
                    .values()
                    .map(|t| (&t.stream, t.kind, t.first_ssrc))
                    .collect::<Vec<_>>()
            );
        }
        result??;
        Ok(())
    }
    pub(in crate::peer) fn output(&self, flow: Uuid, kind: MediaKind) -> (Uuid, String) {
        let output = &self.driver.pairs[&self.sink].outputs[&(flow, kind)];
        (output.id, output.stream.clone())
    }
    pub(in crate::peer) fn observed(
        &self,
        stream: &str,
        kind: MediaKind,
    ) -> Option<(String, u32, u32)> {
        self.tracks
            .values()
            .find(|t| t.stream == stream && t.kind == kind)
            .and_then(|t| {
                self.packets
                    .get(&t.id)
                    .and_then(|p| p.last())
                    .map(|p| (t.id.clone(), p.header.ssrc, p.header.timestamp))
            })
    }
    pub(in crate::peer) async fn release_offer(&mut self, pair: Uuid) -> Result<()> {
        self.withheld.remove(&pair);
        let signal = self.driver.pairs[&pair]
            .pending_offer
            .as_ref()
            .context("no withheld offer")?
            .signal
            .clone();
        let description = signal.description.unwrap();
        let remote = &self.remote[&pair];
        remote
            .accept(description.kind, description.sdp.unwrap())
            .await?;
        let (kind, sdp) = remote.local_description().await?;
        self.driver
            .signal(
                pair,
                Signal {
                    udp: None,
                    description: Some(Description {
                        kind,
                        sdp: Some(sdp),
                    }),
                    exchange_id: signal.exchange_id,
                    tracks: Some(vec![]),
                    candidate: None,
                    resync: None,
                },
            )
            .await
    }
    pub(in crate::peer) async fn close(mut self) {
        self.driver.inputs.close();
        for (_, pair) in self.driver.pairs.drain() {
            close_pair(pair).await;
        }
        self.driver.files.close().await;
        self.driver.transport.close().await;
        for runtime in self.runtimes {
            runtime.close().await;
        }
    }
}
async fn ensure_offer(transport: &Transport) -> Result<()> {
    anyhow::ensure!(transport.offer().await?, "missing media offer");
    Ok(())
}

pub(in crate::peer) fn vp8() -> RtpCodec {
    RtpCodec {
        mime_type: "video/VP8".into(),
        clock_rate: 90_000,
        ..Default::default()
    }
}
pub(in crate::peer) fn h264() -> RtpCodec {
    RtpCodec {
        mime_type: "video/H264".into(),
        clock_rate: 90_000,
        sdp_fmtp_line: "packetization-mode=1;profile-level-id=42c028".into(),
        ..Default::default()
    }
}
pub(in crate::peer) fn video_payloads(
    codec: &RtpCodec,
    frame: u32,
    keyframe: bool,
) -> Result<Vec<bytes::Bytes>> {
    if codec.mime_type.eq_ignore_ascii_case("video/H264") {
        use rtc_rtp::codec::h264::H264Payloader;
        use rtc_rtp::packetizer::Payloader;
        let prefix = if keyframe {
            [
                vec![0, 0, 0, 1],
                sps(),
                vec![0, 0, 0, 1, 0x68, 0x22, 0x33, 0, 0, 0, 1, 0x65],
            ]
            .concat()
        } else {
            vec![0, 0, 0, 1, 0x41]
        };
        let access_unit = [prefix, vec![0x55; 700], frame.to_be_bytes().to_vec()].concat();
        return Ok(H264Payloader::default().payload(1200, &access_unit.into())?);
    }
    use rtc_rtp::codec::vp8::Vp8Payloader;
    use rtc_rtp::packetizer::Payloader;
    let bytes = [
        vec![
            u8::from(!keyframe),
            0,
            0,
            0x9d,
            0x01,
            0x2a,
            0x80,
            0x02,
            0x68,
            0x01,
            0,
        ],
        vec![0x55; 7000],
        frame.to_be_bytes().to_vec(),
    ]
    .concat();
    Ok(Vp8Payloader::default().payload(1200, &bytes.into())?)
}
pub(in crate::peer) fn sps() -> Vec<u8> {
    vec![
        103, 66, 192, 40, 149, 160, 30, 0, 137, 249, 112, 22, 160, 32, 32, 40, 0, 0, 31, 64, 0, 7,
        83, 0, 120, 225, 85,
    ]
}
pub(in crate::peer) async fn send(
    transport: &Transport,
    id: Uuid,
    mut packets: Vec<rtp::Packet>,
    at: Instant,
    writable: &Notify,
) -> Result<()> {
    loop {
        let ready = writable.notified();
        tokio::pin!(ready);
        ready.as_mut().enable();
        match transport.write_au(id, String::new(), packets, at).await? {
            None => return Ok(()),
            Some(pending) => packets = pending,
        }
        ready.await;
    }
}

use crate::data::MessageScope;
use crate::peer::transport::{Channel, ChannelEvent};
use piik_channel_core::{
    conversation::{encode_control, ControlFrame, ConversationAddress, SessionSigner},
    wire::{ChannelInfo, Room, RoomAccess, RoomCapabilities, RoomDelivery, SessionInfo, Snapshot},
};
use std::collections::BTreeMap;
pub(in crate::peer) async fn open(
    left: &Transport,
    right: &Transport,
    events: &mut mpsc::Receiver<Event>,
) -> Result<(Arc<Channel>, Arc<Channel>)> {
    let local = left.create_channel("piik-room").await?;
    ensure!(left.offer().await?, "missing first SDP offer");
    let (kind, sdp) = left.local_description().await?;
    right.accept(kind, sdp).await?;
    let (kind, sdp) = right.local_description().await?;
    left.accept(kind, sdp).await?;
    let remote = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if let Event::Channel(_, channel) = event {
                return Ok::<_, anyhow::Error>(channel);
            }
        }
        anyhow::bail!("remote transport retired before channel opened")
    })
    .await??;
    for channel in [&local, &remote] {
        ensure!(
            matches!(
                tokio::time::timeout(Duration::from_secs(5), channel.poll()).await?,
                Some(ChannelEvent::Open)
            ),
            "missing channel-open event"
        );
    }
    Ok((local, remote))
}

pub(in crate::peer) fn message(tag: &str) -> Result<(Vec<u8>, MessageScope)> {
    let sender = Uuid::from_u128(1);
    let receiver = Uuid::from_u128(2);
    let pair = Uuid::from_u128(3);
    let binding = Uuid::from_u128(4);
    let signer = SessionSigner::from_seed([6; 32]);
    let packet = signer
        .sign(
            sender,
            &ConversationAddress {
                room_id: "transport-check".into(),
                binding_id: binding,
                sender,
                recipient: receiver,
                request_id: tag.into(),
            },
        )
        .map_err(anyhow::Error::msg)?;
    let snapshot = Snapshot {
        files: vec![],
        channel: ChannelInfo {
            history_window: 1,
            id: Uuid::nil(),
            name: "Transport check".into(),
            icon: Default::default(),
            owner_id: None,
            roles: vec![],
            rooms: vec![Room {
                id: "transport-check".into(),
                name: "Transport check".into(),
                icon: Default::default(),
                creator_id: sender,
                access: RoomAccess::Public,
                hidden: false,
                has_password: false,
                voice_bitrate: 64_000,
                authorized: true,
                can_manage: true,
                available: true,
                reading: true,
                participant_session_ids: vec![sender, receiver],
                capabilities: RoomCapabilities { attachments: false },
                delivery: Some(RoomDelivery {
                    host_session_id: sender,
                    binding_id: binding,
                    next_hops: BTreeMap::from([(receiver, receiver)]),
                }),
                members: None,
            }],
        },
        users: vec![],
        sessions: vec![SessionInfo {
            id: sender,
            user_id: sender,
            online: true,
            signing_key: signer.signing_key(),
        }],
        publications: vec![],
        voice: vec![],
        subscriptions: vec![],
        pairs: vec![PairInfo {
            id: pair,
            udp_preparation: None,
            peer_id: receiver,
            can_receive_video_layers: false,
            rooms: vec!["transport-check".into()],
            incoming: vec![],
            outgoing: vec![],
        }],
        ice_servers: vec![],
    };
    let scope = MessageScope::Conversation {
        snapshot: watch::channel(Some(snapshot)).1,
        local: sender,
        peer: receiver,
        from: None,
        packet: packet.clone(),
    };
    let bytes = encode_control(&ControlFrame::Conversation(packet)).map_err(anyhow::Error::msg)?;
    Ok((bytes, scope))
}

pub(in crate::peer) async fn exchange(send: &Channel, receive: &Channel, tag: &str) -> Result<()> {
    let (bytes, scope) = message(tag)?;
    ensure!(
        send.write(false, bytes.clone(), scope, false).await?,
        "small scoped message was not admitted"
    );
    let received = tokio::time::timeout(Duration::from_secs(5), receive.poll()).await?;
    ensure!(
        matches!(received,Some(ChannelEvent::Message(value)) if value==bytes),
        "channel data crossed the wrong engine or was lost"
    );
    Ok(())
}

pub(in crate::peer) async fn endpoint(
    runtime: &transport::Runtime,
    pair: Uuid,
    prepared: Option<std::net::UdpSocket>,
) -> Result<(Transport, mpsc::Receiver<Event>)> {
    let (events, rx) = mpsc::channel(256);
    let (_, demand) = watch::channel(Some(4_000_000));
    let (handle, _) = runtime
        .add(
            pair,
            prepared,
            events,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU8::new(0)),
            demand,
            Arc::new(Notify::new()),
            &[],
        )
        .await?;
    Ok((handle, rx))
}
