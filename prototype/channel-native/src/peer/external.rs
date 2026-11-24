//! One external encoded stream uses the ordinary local-source and output owners.
use super::*;
use crate::media::{clock::SourceTime, incoming::Incoming};
use futures_util::{future::BoxFuture, stream::FuturesUnordered, FutureExt};

pub(super) struct Producer {
    pub control: ExternalControl,
    video: Uuid,
    audio: Option<Uuid>,
    task: Option<JoinHandle<Option<String>>>,
    joining: Option<oneshot::Sender<()>>,
}
impl Producer {
    pub fn owns(&self, id: Uuid, kind: MediaKind) -> bool {
        match kind {
            MediaKind::Video => self.video == id,
            MediaKind::Audio => self.audio == Some(id),
        }
    }
    pub(super) fn retire_audio(&mut self, id: Uuid) {
        if self.audio == Some(id) {
            self.audio = None;
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
        if let Some(task) = self.task.as_mut() {
            let result = (&mut *task).await;
            self.task = None;
            match result {
                Ok(error) => error,
                Err(error) => Some(error.to_string()),
            }
        } else {
            None
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
        let control = ExternalControl(watch::channel(None).0, Default::default());
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
                    audio: Some(audio),
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
                        report_audio_end(&events, publication, audio, &mut cancelled, &mut stopped).await;
                    }
                },
                track = input.tracks.recv() => {
                    let Some(track) = track else { break Err(anyhow!("external_input_ended")) };
                    let kind = track.kind;
                    let first_frame = if kind == MediaKind::Video { ready.take() } else { None };
                    let sources = sources.clone(); let relay = relay.clone(); let control = control.clone();
                    readers.push(async move {
                        (kind, receive_track(track, publication, if kind == MediaKind::Video { video } else { audio }, sources, relay, first_frame, control).await)
                    }.boxed());
                },
            }
        }
    }.await;
    // Close transport and its socket readers before reporting this generation ended.
    let closed = input.transport.close().await;
    drop(readers);
    control.stop();
    let error = result.and(closed).err().map(|error| {
        eprintln!("Native external input ended: {error:#}");
        failure_reason(&error).to_owned()
    });
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

async fn report_audio_end(
    events: &mpsc::Sender<Event>,
    publication: Uuid,
    audio: Uuid,
    cancelled: &mut watch::Receiver<bool>,
    stopped: &mut watch::Receiver<Option<&'static str>>,
) {
    tokio::select! {
        _ = events.send(Event::CaptureAudioEnded { publication_id: publication, source: audio }) => {},
        _ = cancelled.wait_for(|value| *value) => {},
        _ = stopped.wait_for(Option::is_some) => {},
    }
}

fn failure_reason(error: &anyhow::Error) -> &'static str {
    if error.is::<crate::media::UnsupportedH264Format>() {
        "external_video_format_unsupported"
    } else if error.to_string() == "room_unavailable" {
        "room_unavailable"
    } else {
        "external_input_failed"
    }
}

async fn receive_track(
    track: Track,
    publication: Uuid,
    id: Uuid,
    sources: mpsc::Sender<SourceReady>,
    relay: Relay,
    mut ready: Option<oneshot::Sender<Result<()>>>,
    control: ExternalControl,
) -> Result<()> {
    let result = async {
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
        kind,
        feed: SourceFeed::Rtp {
            codec: codec.clone(),
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
            TrackEvent::Rtp(packet, sequence, time, received_codec) => {
                if packet.header.ssrc != ssrc {
                    continue;
                }
                anyhow::ensure!(
                    crate::media::compatible(&codec, &received_codec),
                    "external_codec_changed"
                );
                if kind == MediaKind::Video {
                    if incoming.is_none() {
                        let Some(at) = track.presentation(packet.header.timestamp, ssrc) else {
                            continue;
                        };
                        let input = Incoming::with_time(
                            &codec.mime_type,
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
    }.await;
    // Both completion paths describe the same producer failure, whichever the page polls first.
    if let Err(error) = &result {
        control.record_failure(error);
    }
    if let Some(ready) = ready.take() {
        let reason = result
            .as_ref()
            .err()
            .map(failure_reason)
            .unwrap_or("external_input_failed");
        let _ = ready.send(Err(anyhow!(reason)));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peer::tests::support::{endpoint, h264, send, video_payloads};

    #[tokio::test]
    async fn stopping_external_input_releases_backpressured_audio_end() {
        let (events, _receiver) = mpsc::channel(1);
        let _capacity = events.reserve().await.unwrap();
        let (_session, mut cancelled) = watch::channel(false);
        let control = ExternalControl(watch::channel(None).0, Default::default());
        let mut stopped = control.0.subscribe();
        let report = report_audio_end(
            &events,
            Uuid::new_v4(),
            Uuid::new_v4(),
            &mut cancelled,
            &mut stopped,
        );
        tokio::pin!(report);
        assert!(futures_util::poll!(&mut report).is_pending());
        control.stop();
        assert!(futures_util::poll!(&mut report).is_ready());
    }

    #[tokio::test]
    async fn audio_end_before_ready_retires_only_that_external_source() -> Result<()> {
        let (mut driver, mut events, mut commands, _stop) = crate::peer::tests::driver();
        let (sources, mut ready) = mpsc::channel(2);
        driver.ready_sources = sources;
        let publication = Uuid::new_v4();
        let video_id = Uuid::new_v4();
        let audio_id = Uuid::new_v4();
        let control = ExternalControl(watch::channel(None).0, Default::default());
        let (joining, joined) = oneshot::channel();
        let (ended, _ended) = oneshot::channel();
        driver.local_producers.insert(
            video_id,
            PreparedSource {
                scope: CaptureScope {
                    publication_id: publication,
                    room_id: "owned".into(),
                    binding_id: Uuid::new_v4(),
                },
                selected: true,
                prepared: vec![],
                ended,
                producer: LocalProducer::External(Producer {
                    control: control.clone(),
                    video: video_id,
                    audio: Some(audio_id),
                    task: Some(tokio::spawn(async move {
                        let _ = joined.await;
                        None
                    })),
                    joining: Some(joining),
                }),
            },
        );
        driver.publications.insert(
            publication,
            PublicationInfo {
                id: publication,
                room_id: "owned".into(),
                session_id: driver.session,
                user_id: Uuid::new_v4(),
                kind: piik_channel_core::wire::Kind::Screen,
                paused: false,
                audience: vec![],
                video_settings: None,
                screen: Some(piik_channel_core::wire::ScreenInfo {
                    predecessor: None,
                    direct_limit: None,
                    source: Default::default(),
                    title: None,
                }),
            },
        );
        let now = Instant::now();
        let video = crate::media::video::Video::new(
            SourceTime::local(now, rtc_shared::time::SystemInstant::now(now)),
            Arc::new(Notify::new()),
        );
        video.set_codec(h264())?;
        let result = async {
            driver.source_ready(SourceReady {
                source: Source { id: video_id, publication_id: publication, origin: SourceOrigin::Local,
                    kind: MediaKind::Video, feed: SourceFeed::Video(video.clone()), layers: None },
                media: InitialMedia::Video(crate::EncodedFrame { bytes: vec![1], presentation_time: now,
                    keyframe: true, vp8: None }),
            }).await;
            // A predecessor's audio event cannot withdraw this generation's source.
            driver.event(Event::CaptureAudioEnded { publication_id: publication, source: Uuid::new_v4() }).await?;
            anyhow::ensure!(driver.local_producers[&video_id].producer.owns(audio_id, MediaKind::Audio));
            let (keyframes, _) = watch::channel(0);
            driver.ready_sources.send(SourceReady {
                source: Source { id: audio_id, publication_id: publication, origin: SourceOrigin::Local,
                    kind: MediaKind::Audio, layers: None, feed: SourceFeed::Rtp {
                        codec: codec(), keyframes, report: Default::default(),
                    } },
                media: InitialMedia::Rtp(vec![]),
            }).await.map_err(|_| anyhow!("fixture Ready queue closed"))?;
            driver.events.send(Event::CaptureAudioEnded { publication_id: publication, source: audio_id }).await?;
            driver.event(events.recv().await.context("audio End")?).await?;
            anyhow::ensure!(!driver.sources.contains_key(&audio_id), "ended audio was not removed");
            driver.source_ready(ready.recv().await.context("late audio Ready")?).await;
            let resurrected = driver.sources.contains_key(&audio_id);
            let output = video.subscribe();
            video.write(crate::EncodedFrame { bytes: vec![2], presentation_time: now + Duration::from_millis(1),
                keyframe: true, vp8: None });
            anyhow::ensure!(output.recv().await.context("video stopped")?.bytes == [2]);
            let video_alive = driver.sources.contains_key(&video_id)
                && driver.local_producers[&video_id].producer.owns(video_id, MediaKind::Video)
                && !control.is_stopped();
            let whole_publication_failed = commands.try_recv().is_ok();
            anyhow::ensure!(video_alive && driver.capture_audio.is_empty() && !whole_publication_failed, "optional audio ended its picture owner");
            anyhow::ensure!(!resurrected, "late Ready reinstalled the ended OBS audio source");
            Ok(())
        }.await;
        for (_, mut capture) in driver.local_producers.drain() {
            capture.producer.close().await;
        }
        for (_, mut producer) in driver.derived.drain() {
            producer.stop().await;
        }
        driver.files.close().await;
        driver.watches.close().await;
        driver.transport.close().await;
        result
    }

    #[tokio::test]
    async fn cancelled_external_close_retains_its_actor_join() {
        use std::future::Future;
        let (release, blocked) = oneshot::channel::<()>();
        let (finished, finished_rx) = oneshot::channel();
        let (joining, joined) = oneshot::channel();
        let mut producer = Producer {
            control: ExternalControl(watch::channel(None).0, Default::default()),
            video: Uuid::new_v4(),
            audio: Some(Uuid::new_v4()),
            joining: Some(joining),
            task: Some(tokio::spawn(async move {
                joined.await.unwrap();
                blocked.await.unwrap();
                let _ = finished.send(());
                Some("actor-finished".to_owned())
            })),
        };
        let mut first = Box::pin(producer.close());
        assert!(
            std::future::poll_fn(|cx| {
                std::task::Poll::Ready(first.as_mut().poll(cx).is_pending())
            })
            .await
        );
        drop(first);
        let mut second = Box::pin(producer.close());
        let premature = std::future::poll_fn(|cx| {
            std::task::Poll::Ready(match second.as_mut().poll(cx) {
                std::task::Poll::Pending => None,
                std::task::Poll::Ready(result) => Some(result),
            })
        })
        .await;
        release.send(()).unwrap();
        finished_rx.await.unwrap();
        let result = match premature.as_ref() {
            Some(result) => result.clone(),
            None => second.await,
        };
        assert!(
            premature.is_none(),
            "second close returned before external actor completion"
        );
        assert_eq!(result.as_deref(), Some("actor-finished"));
    }


    #[test]
    fn unsupported_obs_high10_retains_the_actionable_format_error() {
        let error = anyhow::Error::new(crate::media::UnsupportedH264Format([0x6e, 0, 0x34]))
            .context("external input first complete access unit");
        assert_eq!(failure_reason(&error), "external_video_format_unsupported");
        assert!(format!("{error:#}").contains("High 10 profile"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unsupported_sps_fact_precedes_both_ready_and_ended_completions() -> Result<()> {
        for ended_first in [false, true] {
            let (mut driver, mut events, _commands, _stop) = crate::peer::tests::driver();
            let sender_runtime = transport::Runtime::new(None);
            let (sender, _events) = endpoint(&sender_runtime, Uuid::new_v4(),
                Some(std::net::UdpSocket::bind("127.0.0.1:0")?)).await?;
            let video = Uuid::new_v4();
            let (_, writable, _) = sender.add_output(video, h264(), MediaKind::Video, "obs".into(), vec![]).await?;
            sender.offer().await?;
            let (_, offer) = sender.local_description().await?;
            let mut prepared = driver.prepare_external(CaptureScope {
                publication_id: Uuid::new_v4(), room_id: "external-room".into(), binding_id: Uuid::new_v4(),
            }, None, offer).await?;
            let control = prepared.lease.control();
            sender.accept("answer".into(), prepared.answer).await?;
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            let mut frame = 0u32;
            let result = tokio::time::timeout(Duration::from_secs(10), async {
                // Send real local RTC packets carrying a complete synthetic SPS AU.
                // SDP remains Baseline, as stock OBS's default declaration does.
                while control.unsupported_video_format().is_none() {
                    tick.tick().await;
                    frame += 1;
                    let packet = rtp::Packet {
                        header: rtp::header::Header { version: 2, marker: true, timestamp: frame * 1800, ..Default::default() },
                        payload: vec![0x67, 0x6e, 0, 0x34].into(),
                    };
                    send(&sender, video, vec![packet], Instant::now(), &writable).await?;
                }
                let expected = Some(UnsupportedVideoFormat { codec: "h264", profile_idc: 110, constraint_flags: 0, level_idc: 52 });
                assert_eq!(control.unsupported_video_format(), expected);
                if !ended_first {
                    assert_eq!(prepared.lease.ready().await.unwrap_err().to_string(), "external_video_format_unsupported");
                    assert_eq!(control.unsupported_video_format(), expected);
                }
                while driver.local_producers.contains_key(&prepared.lease.id) {
                    driver.event(events.recv().await.context("failed input never ended")?).await?;
                }
                assert_eq!(prepared.lease.ended.take().unwrap().await?, Err("external_video_format_unsupported".into()));
                if ended_first {
                    assert_eq!(prepared.lease.ready().await.unwrap_err().to_string(), "external_video_format_unsupported");
                }
                assert_eq!(control.unsupported_video_format(), expected);
                assert!(driver.sources.is_empty());
                Ok::<_, anyhow::Error>(())
            }).await;
            prepared.lease.stop();
            for (_, mut source) in driver.local_producers.drain() { source.producer.close().await; }
            sender.close().await?;
            sender_runtime.close().await;
            driver.transport.close().await;
            result??;
        }
        Ok(())
    }

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
        old_control.record_failure(&crate::media::UnsupportedH264Format([0x6e, 0, 0x34]).into());
        old.stop();
        let mut next = driver.prepare_external(scope, None, offer).await?.lease;
        assert!(next.control().unsupported_video_format().is_none());
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
                    source = received.recv() => driver.source_ready(source.context("source receiver closed")?).await,
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
                paused: false, audience: vec![], screen: Some(piik_channel_core::wire::ScreenInfo { predecessor: None, direct_limit: None, source: Default::default(), title: None }),
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
            driver.update(vec![], vec![], vec![]).await;
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
        for (_, mut producer) in driver.derived.drain() {
            producer.stop().await;
        }
        sender.close().await?;
        sender_runtime.close().await;
        driver.transport.close().await;
        result??;
        Ok(())
    }
    #[tokio::test]
    async fn source_stop_before_and_after_selection() -> Result<()> {
        for early in [true, false] {
            let (mut driver, _events, mut commands, _stop) = crate::peer::tests::driver();
            let publication = Uuid::new_v4();
            let old = Uuid::new_v4();
            let candidate = Uuid::new_v4();
            driver.inputs = input::Inputs::new(
                driver.session,
                watch::channel(None).1,
                Some(crate::input::lifecycle_fixture_desktop()),
            );
            let (old_source, _) = driver
                .inputs
                .source(
                    publication,
                    old,
                    crate::capture::Target {
                        kind: crate::capture::TargetKind::Display,
                        source_id: "fixture".into(),
                        title: "synthetic lifecycle target".into(),
                        pid: 0,
                        creation_time: None,
                    },
                )?
                .unwrap();
            old_source.set_mode(crate::input::Mode::Ask)?;
            let scope = CaptureScope {
                publication_id: publication,
                room_id: "fixture".into(),
                binding_id: Uuid::new_v4(),
            };
            let candidate_control = ExternalControl(watch::channel(None).0, Default::default());
            for (id, selected, control) in [
                (
                    old,
                    true,
                    ExternalControl(watch::channel(None).0, Default::default()),
                ),
                (candidate, false, candidate_control.clone()),
            ] {
                driver.local_producers.insert(
                    id,
                    PreparedSource {
                        scope: scope.clone(),
                        selected,
                        prepared: vec![],
                        ended: oneshot::channel().0,
                        producer: LocalProducer::External(Producer {
                            control,
                            video: id,
                            audio: None,
                            task: None,
                            joining: None,
                        }),
                    },
                );
            }
            driver.publications.insert(
                publication,
                PublicationInfo {
                    id: publication,
                    room_id: scope.room_id.clone(),
                    session_id: driver.session,
                    user_id: Uuid::new_v4(),
                    kind: piik_channel_core::wire::Kind::Screen,
                    paused: false,
                    audience: vec![],
                    video_settings: None,
                    screen: None,
                },
            );
            let (started, waiting) = oneshot::channel();
            let (release, blocked) = std::sync::mpsc::channel();
            let (finished, completed) = oneshot::channel();
            let audio =
                crate::media::local::tests::controlled_audio_retirement(started, blocked, finished);
            driver.capture_audio.insert(publication, (scope, audio));
            if early {
                candidate_control.stop();
                assert_eq!(
                    driver
                        .commit_capture(candidate)
                        .await
                        .err()
                        .unwrap()
                        .to_string(),
                    "capture_unavailable"
                );
                assert!(driver.local_producers[&old].selected);
                old_source.set_mode(crate::input::Mode::Ask)?;
                assert!(driver.capture_audio.contains_key(&publication));
                release.send(())?;
            } else {
                {
                    let commit = driver.commit_capture(candidate);
                    tokio::pin!(commit);
                    tokio::select! {
                        ready = waiting => ready?,
                        _ = &mut commit => anyhow::bail!("commit did not await the audio owner"),
                    }
                    candidate_control.stop();
                    release.send(())?;
                    commit.await?;
                };
                assert!(driver.local_producers[&candidate].selected);
                assert!(!driver.local_producers[&old].selected);
                assert!(old_source.set_mode(crate::input::Mode::Ask).is_err());
                driver.capture_ended(publication, candidate).await;
                assert!(
                    matches!(commands.try_recv(), Ok(NativeEvent::CaptureEnded { publication_id, .. }) if publication_id == publication)
                );
            }
            driver.close().await?;
            completed.await?;
        }
        Ok(())
    }
}
