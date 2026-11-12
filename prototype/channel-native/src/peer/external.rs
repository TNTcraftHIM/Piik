//! One external encoded stream uses the ordinary local-source and output owners.
use super::*;
use crate::media::{clock::SourceTime, incoming::Incoming};
use futures_util::{future::BoxFuture, stream::FuturesUnordered, FutureExt};

pub(super) struct Producer {
    pub control: ExternalControl,
    video: Uuid,
    audio: Uuid,
    task: Option<JoinHandle<Option<String>>>,
    joining: Option<oneshot::Sender<()>>,
}
impl Producer {
    pub fn owns(&self, id: Uuid, kind: MediaKind) -> bool {
        id == if kind == MediaKind::Video {
            self.video
        } else {
            self.audio
        }
    }
    pub fn is_stopped(&self) -> bool {
        self.control.is_stopped()
    }
    pub fn stop(&self) {
        self.control.stop();
    }
    pub async fn close(&mut self) -> Option<String> {
        self.stop();
        if let Some(joining) = self.joining.take() {
            let _ = joining.send(());
        }
        match self.task.take() {
            Some(task) => match task.await {
                Ok(error) => error,
                Err(error) => Some(error.to_string()),
            },
            None => None,
        }
    }
}

impl Driver {
    pub(super) async fn prepare_external(
        &mut self,
        scope: CaptureScope,
        replaces: Option<Uuid>,
        offer: String,
    ) -> Result<PreparedExternal> {
        self.cancelled_audio().await;
        self.check_local_preparation(&scope, replaces)?;
        let accepted = self.transport.accept_local_input(&offer).await?;
        let answer = accepted.answer.clone();
        let video = Uuid::new_v4();
        let audio = Uuid::new_v4();
        let control = ExternalControl(watch::channel(None).0);
        let (ready, started) = oneshot::channel();
        let (ended, completed) = oneshot::channel();
        let (joining, joined) = oneshot::channel();
        let task = tokio::spawn(run(
            accepted,
            scope.publication_id,
            video,
            audio,
            control.clone(),
            ready,
            self.ready_sources.clone(),
            self.events.clone(),
            self.relay.clone(),
            self.cancel.clone(),
            joined,
        ));
        self.local_producers.insert(
            video,
            PreparedSource {
                scope: scope.clone(),
                selected: false,
                prepared: Vec::new(),
                ended,
                producer: LocalProducer::External(Producer {
                    control: control.clone(),
                    video,
                    audio,
                    task: Some(task),
                    joining: Some(joining),
                }),
            },
        );
        Ok(PreparedExternal {
            answer,
            lease: ExternalLease {
                id: video,
                session_id: self.session,
                scope,
                ready: started,
                ended: Some(completed),
                control,
            },
        })
    }
}

async fn run(
    mut input: transport::AcceptedInput,
    publication: Uuid,
    video: Uuid,
    audio: Uuid,
    control: ExternalControl,
    ready: oneshot::Sender<Result<()>>,
    sources: mpsc::Sender<SourceReady>,
    events: mpsc::Sender<Event>,
    relay: Relay,
    mut cancelled: watch::Receiver<bool>,
    mut joined: oneshot::Receiver<()>,
) -> Option<String> {
    let mut stopped = control.0.subscribe();
    let mut ready = Some(ready);
    let mut readers: FuturesUnordered<BoxFuture<'static, (MediaKind, Result<()>)>> =
        FuturesUnordered::new();
    let result: Result<()> = async {
        loop {
            tokio::select! {
                _ = cancelled.wait_for(|cancelled| *cancelled).map(|_| ()) => break Ok(()),
                _ = stopped.wait_for(Option::is_some).map(|_| ()) => {
                    match *stopped.borrow() {
                        Some("room_unavailable") => break Err(anyhow!("room_unavailable")),
                        _ => break Ok(()),
                    }
                },
                _ = input.ended.changed() => {
                    break input.ended.borrow().clone().unwrap_or(Err("external_input_ended".into())).map_err(anyhow::Error::msg);
                },
                next = readers.next(), if !readers.is_empty() => {
                    if let Some((kind, result)) = next {
                        if kind == MediaKind::Video { break result; }
                        // Audio has its own output lifetime; it cannot end a working picture.
                        tokio::select! {
                            _ = events.send(Event::CaptureAudioEnded { publication_id: publication, source: audio }) => {},
                            _ = cancelled.wait_for(|cancelled| *cancelled).map(|_| ()) => break Ok(()),
                        }
                    }
                },
                track = input.tracks.recv() => {
                    let Some(track) = track else { break Err(anyhow!("external_input_ended")) };
                    let kind = track.kind;
                    let first_frame = if kind == MediaKind::Video { ready.take() } else { None };
                    let sources = sources.clone(); let relay = relay.clone();
                    readers.push(async move {
                        (kind, receive_track(track, publication, if kind == MediaKind::Video { video } else { audio }, sources, relay, first_frame).await)
                    }.boxed());
                },
            }
        }
    }.await;
    // Close transport and its socket readers before reporting this generation ended.
    let closed = input.transport.close().await;
    drop(readers);
    control.stop();
    let error = result.and(closed).err().map(|error| error.to_string());
    if let Some(ready) = ready {
        let _ = ready.send(Err(anyhow!(error
            .clone()
            .unwrap_or_else(|| "external_input_ended".into()))));
    }
    if !*cancelled.borrow() {
        tokio::select! {
            _ = events.send(Event::CaptureEnded { publication_id: publication, source: video }) => {},
            _ = cancelled.wait_for(|cancelled| *cancelled).map(|_| ()) => {},
            _ = &mut joined => {},
        }
    }
    error
}

async fn receive_track(
    track: Track,
    publication: Uuid,
    id: Uuid,
    sources: mpsc::Sender<SourceReady>,
    relay: Relay,
    mut ready: Option<oneshot::Sender<Result<()>>>,
) -> Result<()> {
    let kind = track.kind;
    let ssrc = track.first_ssrc;
    let codec = track.first_codec.rtp_codec.clone();
    anyhow::ensure!(supported(&codec, kind), "external_codec_unsupported");
    let report = track.report(ssrc);
    let (keyframes, _) = watch::channel(0);
    let mut source = Source {
        id,
        publication_id: publication,
        origin: SourceOrigin::Local,
        codec,
        kind,
        feed: SourceFeed::Rtp {
            keyframes,
            report: report.clone(),
        },
        layers: None,
    };
    let mut incoming: Option<Incoming> = None;
    let mut requests: Option<watch::Receiver<u64>> = None;
    let changed = Arc::new(Notify::new());
    let mut first = true;
    loop {
        let event = tokio::select! {
            event = track.poll() => match event { Some(event) => event, None => break },
            _ = async { match requests.as_mut() { Some(requests) => { let _ = requests.changed().await; }, None => std::future::pending().await } } => {
                track.request_keyframe(ssrc).await?;
                continue;
            },
        };
        match event {
            TrackEvent::End => break,
            TrackEvent::Report(reports) => {
                for (received, at) in reports {
                    if received.ssrc == ssrc {
                        *report.lock().unwrap() = Some((received, at));
                    }
                }
                if kind == MediaKind::Video
                    && incoming.as_ref().is_none_or(Incoming::waiting_for_keyframe)
                {
                    track.request_keyframe(ssrc).await?;
                }
            }
            TrackEvent::Rtp(packet, sequence, time, codec) => {
                if packet.header.ssrc != ssrc {
                    continue;
                }
                anyhow::ensure!(
                    crate::media::compatible(&source.codec, &codec),
                    "external_codec_changed"
                );
                if kind == MediaKind::Video {
                    if incoming.is_none() {
                        let Some(at) = track.presentation(packet.header.timestamp, ssrc) else {
                            continue;
                        };
                        let input = Incoming::with_time(
                            &source.codec.mime_type,
                            SourceTime::incoming(at, packet.header.timestamp, report.clone()),
                            changed.clone(),
                        );
                        requests = Some(input.video().requests());
                        input.video().request_keyframe();
                        incoming = Some(input);
                    }
                    let input = incoming.as_mut().unwrap();
                    input.push(sequence, time, packet);
                    while let Some(frame) = input.pop()? {
                        if first {
                            first = false;
                            source.feed = SourceFeed::Video(input.video().clone());
                            sources
                                .send(SourceReady {
                                    source: source.clone(),
                                    media: InitialMedia::Video(frame),
                                })
                                .await?;
                            if let Some(ready) = ready.take() {
                                let _ = ready.send(Ok(()));
                            }
                        } else {
                            input.video().write(frame);
                        }
                    }
                } else {
                    if track.presentation(packet.header.timestamp, ssrc).is_none()
                        || packet.payload.is_empty() && (first || !packet.header.padding)
                    {
                        continue;
                    }
                    if first {
                        first = false;
                        sources
                            .send(SourceReady {
                                source: source.clone(),
                                media: InitialMedia::Rtp(vec![packet]),
                            })
                            .await?;
                    } else {
                        relay.write(id, packet);
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peer::tests::support::{endpoint, h264, send, video_payloads};

    #[tokio::test]
    async fn cancelled_external_preparation_joins_without_stopping_its_successor() -> Result<()> {
        let (mut driver, mut events, mut commands, _stop) = crate::peer::tests::driver();
        let sender_runtime = transport::Runtime::new(None);
        let (sender, _events) = endpoint(
            &sender_runtime,
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
        let (_, offer) = sender.local_description().await?;
        let scope = CaptureScope {
            publication_id: Uuid::new_v4(),
            room_id: "external-room".into(),
            binding_id: Uuid::new_v4(),
        };
        let mut old = driver
            .prepare_external(scope.clone(), None, offer.clone())
            .await?
            .lease;
        let old_control = old.control();
        old.stop();
        let mut next = driver.prepare_external(scope, None, offer).await?.lease;
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            while driver.local_producers.contains_key(&old.id) {
                driver
                    .event(events.recv().await.context("cancelled input never ended")?)
                    .await?;
            }
            assert_eq!(old.ended.take().unwrap().await?, Ok(()));
            assert!(old.ready().await.is_err());
            old_control.stop();
            assert!(!next.is_stopped());
            assert!(driver.capture_current(next.id, false));
            assert!(
                commands.try_recv().is_err(),
                "retiring a predecessor cannot withdraw its successor"
            );
            next.stop();
            while driver.local_producers.contains_key(&next.id) {
                driver
                    .event(events.recv().await.context("successor never ended")?)
                    .await?;
            }
            assert_eq!(next.ended.take().unwrap().await?, Ok(()));
            Ok::<_, anyhow::Error>(())
        })
        .await;
        for (_, mut source) in driver.local_producers.drain() {
            source.producer.close().await;
        }
        sender.close().await?;
        sender_runtime.close().await;
        driver.transport.close().await;
        result??;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn external_generation_waits_for_complete_video_commits_without_capture_and_retires(
    ) -> Result<()> {
        let (mut driver, mut events, _commands, _stop) = crate::peer::tests::driver();
        let (sources, mut received) = mpsc::channel(16);
        driver.ready_sources = sources;
        let sender_runtime = transport::Runtime::new(None);
        let (sender, _events) = endpoint(
            &sender_runtime,
            Uuid::new_v4(),
            Some(std::net::UdpSocket::bind("127.0.0.1:0")?),
        )
        .await?;
        let video = Uuid::new_v4();
        let audio = Uuid::new_v4();
        let (_, video_writable, _) = sender
            .add_output(video, h264(), MediaKind::Video, "obs".into(), vec![])
            .await?;
        let (_, audio_writable, _) = sender
            .add_output(audio, codec(), MediaKind::Audio, "obs".into(), vec![])
            .await?;
        sender.offer().await?;
        let (_, offer) = sender.local_description().await?;
        let scope = CaptureScope {
            publication_id: Uuid::new_v4(),
            room_id: "external-room".into(),
            binding_id: Uuid::new_v4(),
        };
        let mut prepared = driver.prepare_external(scope.clone(), None, offer).await?;
        assert!(matches!(
            prepared.lease.ready.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(driver.capture_audio.is_empty());
        sender.accept("answer".into(), prepared.answer).await?;
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        let mut frame = 0u32;
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            while driver.local_producers[&prepared.lease.id].prepared.len() < 2 {
                tokio::select! {
                    source = received.recv() => driver.source_ready(source.context("source receiver closed")?).await?,
                    _ = tick.tick() => {
                        frame += 1;
                        let audio_packet = rtp::Packet { header: rtp::header::Header { version:2,marker:true,timestamp:frame*960,..Default::default() }, payload:vec![0xf8,0xff,0xfe].into() };
                        send(&sender,audio,vec![audio_packet],Instant::now(),&audio_writable).await?;
                        let payloads = video_payloads(&h264(), frame, true)?;
                        let last = payloads.len()-1;
                        let packets = payloads.into_iter().enumerate().map(|(index,payload)|rtp::Packet { header:rtp::header::Header { version:2,marker:index==last,timestamp:frame*1800,..Default::default() },payload }).collect();
                        send(&sender,video,packets,Instant::now(),&video_writable).await?;
                    }
                }
            }
            prepared.lease.ready().await?;
            assert!(driver.sources.is_empty(), "uncommitted input cannot reach ordinary outputs");
            assert!(driver.local_producers[&prepared.lease.id].prepared.iter().any(|ready| matches!(&ready.media, InitialMedia::Video(frame) if frame.keyframe)));
            driver.publications.insert(scope.publication_id, PublicationInfo {
                id: scope.publication_id, room_id: scope.room_id.clone(), session_id: driver.session,
                user_id: Uuid::new_v4(), kind: piik_channel_core::wire::Kind::Screen,
                paused: false, audience: vec![], screen: Some(piik_channel_core::wire::ScreenInfo { source: Default::default(), title: None }),
                video_settings: None,
            });
            let input = driver.commit_capture(prepared.lease.id).await?;
            assert!(input.remote.is_none() && input.state.is_none());
            assert!(driver.capture_audio.is_empty());
            assert_eq!(driver.sources.len(), 2);
            assert!(driver.sources.values().any(|source| matches!(source.feed, SourceFeed::Video(_))));
            assert!(driver.sources.values().any(|source| source.kind == MediaKind::Audio && matches!(source.feed, SourceFeed::Rtp { .. })));
            #[cfg(any(target_os="windows",target_os="linux",target_os="macos"))]
            assert!(driver.derived.contains_key(&prepared.lease.id));
            // The normal authoritative update retires the same local owner.
            driver.update(vec![], vec![], vec![]).await?;
            while driver.local_producers.contains_key(&prepared.lease.id) {
                driver.event(events.recv().await.context("source never ended")?).await?;
            }
            assert_eq!(prepared.lease.ended.take().unwrap().await?, Err("room_unavailable".into()));
            assert!(driver.sources.is_empty());
            driver.reconcile_encodings().await;
            Ok::<_,anyhow::Error>(())
        }).await;
        prepared.lease.stop();
        for (_, mut source) in driver.local_producers.drain() {
            source.producer.close().await;
        }
        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
        for (_, producer) in driver.derived.drain() {
            producer.stop().await;
        }
        sender.close().await?;
        sender_runtime.close().await;
        driver.transport.close().await;
        result??;
        Ok(())
    }
}
