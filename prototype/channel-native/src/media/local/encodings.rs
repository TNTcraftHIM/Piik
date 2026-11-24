//! Capture startup and shutdown; encoder selection is shared with relay derivation.
use super::*;
use crate::{
    capture::Encoding,
    media::{
        encodings::{stop, Encodings},
        video::Layers,
    },
};
use futures_util::{future::Aborted, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

struct Prepared {
    encoding: Encoding,
    first: crate::EncodedFrame,
}

fn first_codec(codec: VideoCodec, frame: &crate::EncodedFrame) -> Result<RtpCodec> {
    anyhow::ensure!(
        frame.keyframe,
        "capture encoding did not start independently"
    );
    match codec {
        VideoCodec::H264 => H264Sps::initial_codec(&frame.bytes),
        VideoCodec::Vp8 => Ok(RtpCodec {
            mime_type: "video/VP8".into(),
            clock_rate: 90_000,
            ..Default::default()
        }),
    }
}

async fn initial(
    capture: &Capture,
    control: &VideoControl,
    settings: Settings,
    codec: VideoCodec,
    deadline: Option<Duration>,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<(Prepared, RtpCodec)> {
    let mut encoding = capture.encode(settings, codec)?;
    let frame = async {
        if let Some(deadline) = deadline {
            #[cfg(target_os = "android")]
            capture.wait_for_input().await?;
            tokio::time::timeout(deadline, encoding.recv())
                .await
                .map_err(|_| anyhow!("H264 startup proof timed out"))?
        } else {
            encoding.recv().await
        }
        .unwrap_or_else(|| Err(anyhow!("capture encoding ended before its first frame")))
    };
    let result = tokio::select! {
        biased;
        stopped = control.stopped() => stopped.and(Err(Aborted.into())),
        _ = cancelled.wait_for(|value| *value) => Err(Aborted.into()),
        frame = frame => frame.and_then(|frame| first_codec(codec, &frame).map(|rtp| (frame, rtp))),
    };
    match result {
        Ok((first, rtp)) => Ok((Prepared { encoding, first }, rtp)),
        Err(error) => {
            let _ = stop(encoding).await;
            Err(error)
        }
    }
}

async fn prepare(
    candidate: Result<Encoding>,
    frames: &Video,
    control: &VideoControl,
    codec: VideoCodec,
    mut request: VideoSettingsRequest,
) -> (VideoSettingsRequest, Result<Prepared>) {
    let mut encoding = match candidate {
        Ok(encoding) => encoding,
        Err(error) => return (request, Err(error)),
    };
    let result = tokio::select! {
        biased;
        _ = control.stopped() => Err(anyhow!("capture_unavailable")),
        _ = request.result.closed() => Err(Aborted.into()),
        frame = encoding.recv() => frame.unwrap_or_else(|| Err(anyhow!("capture encoding ended before its first frame"))),
    }.and_then(|frame| {
        frames.set_codec(first_codec(codec, &frame)?)?;
        Ok(frame)
    });
    match result {
        Ok(first) => (request, Ok(Prepared { encoding, first })),
        Err(error) => {
            let _ = stop(encoding).await;
            (request, Err(error))
        }
    }
}

fn install_lower(
    encodings: &mut Encodings,
    layers: &Layers,
    low: &Video,
    candidate: Result<Encoding>,
) {
    match candidate {
        Ok(encoding) => {
            layers.insert("q".into(), low.clone());
            encodings.supplied(encoding, low.clone());
        }
        Err(error) => {
            layers.remove("q");
            eprintln!("Native lower source encoding unavailable: {error:#}");
            log::warn!(target: "piik.encoder", "Lower source encoding unavailable: {error:#}");
        }
    }
}

async fn report_failure(
    events: &mpsc::Sender<Event>,
    capture: &VideoControl,
    publication_id: Uuid,
    source: Uuid,
    video: Video,
    layers: &Layers,
) -> Result<()> {
    // SourceReady and failure events have separate queues. Retire the shared
    // inventory here even when the Driver has not registered SourceReady yet.
    let retired_supply = layers.retire(&video).then(|| layers.clone());
    tokio::select! {
        biased;
        _ = capture.stopped() => Ok(()),
        sent = events.send(Event::EncodingFailed { publication_id, source, video, retired_supply }) => sent.map_err(Into::into),
    }
}

pub(super) async fn run(
    capture: Capture,
    mut settings: Settings,
    mode: VideoCodecMode,
    publication_id: Uuid,
    source_id: Uuid,
    time: SourceTime,
    control: Control,
    ready: oneshot::Sender<Result<()>>,
    ready_sources: mpsc::Sender<SourceReady>,
    events: mpsc::Sender<Event>,
    mut cancelled: watch::Receiver<bool>,
    mut demands: watch::Receiver<Vec<VideoDemand>>,
    mut changes: mpsc::Receiver<VideoSettingsRequest>,
    bandwidth_changed: Arc<Notify>,
) -> Option<String> {
    let changed = Arc::new(Notify::new());
    let frames = Video::new(time.clone(), changed.clone());
    let requests = frames.requests();
    let mut encoding = None;
    let mut encodings = None;
    let mut ready = Some(ready);
    let mut preparing = None;
    let result = async {
        let mut codec = mode.initial();
        let fallback = mode == VideoCodecMode::Auto && VideoCodec::Vp8.supported();
        let prepared = initial(&capture, &control.video, settings, codec,
            fallback.then_some(Duration::from_secs(4)), &mut cancelled).await;
        let (prepared, rtp) = match prepared {
            Err(error) if fallback && !error.is::<Aborted>() && !control.video.is_stopped() && !*cancelled.borrow() => {
                eprintln!("Native Auto H264 startup was not proved: {error:#}; trying VP8");
                log::warn!(target: "piik.encoder", "H264 startup proof failed: {error:#}");
                codec = VideoCodec::Vp8;
                initial(&capture, &control.video, settings, codec, None, &mut cancelled).await?
            }
            result => result?,
        };
        let _ = control.codec.set(codec);
        frames.set_codec(rtp)?;
        let encodings = encodings.insert(Encodings::new(time.clone(), changed.clone(), codec));
        encoding = Some(prepared.encoding);
        let frame = prepared.first;
        let low = Video::new(time.clone(), changed.clone());
        // Keep the declared RIDs when the lower encoder is unavailable.
        let layers = Layers::new(vec!["q".into(), "h".into()]);
        layers.insert("h".into(), frames.clone());
        install_lower(encodings, &layers, &low, capture.encode(settings.lower_layer(), codec));
        let source = Source {
            id: source_id, publication_id, origin: SourceOrigin::Local, kind: MediaKind::Video,
            layers: Some(layers.clone()),
            feed: SourceFeed::Video(frames.clone()),
        };
        tokio::select! {
            _ = control.video.stopped() => return Ok(()),
            _ = cancelled.changed() => return Ok(()),
            sent = ready_sources.send(SourceReady { source, media: InitialMedia::Video(frame) }) => sent?,
        }
        let _ = ready.take().unwrap().send(Ok(()));
        encodings.baseline(encoding.take().unwrap(), frames.clone(), requests);
        let mut ended = Ok(());
        while !encodings.pumps.is_empty() || preparing.is_some() {
            tokio::select! {
                _ = control.video.stopped() => return Ok(()),
                _ = cancelled.changed() => return Ok(()),
                request = changes.recv(), if preparing.is_none() => {
                    let Some(request) = request else { return Ok(()); };
                    if request.result.is_closed() { continue; }
                    if request.settings == settings {
                        let _ = request.result.send(Ok(()));
                    } else {
                        let candidate = capture.encode(request.settings, codec);
                        preparing = Some(Box::pin(prepare(candidate, &frames, &control.video, codec, request)));
                    }
                },
                prepared = async { preparing.as_mut().unwrap().await }, if preparing.is_some() => {
                    preparing = None;
                    let (request, prepared) = prepared;
                    let prepared = match prepared {
                        Ok(prepared) => prepared,
                        Err(error) => { let _ = request.result.send(Err(error)); continue; },
                    };
                    if request.result.is_closed() || control.video.is_stopped() {
                        let _ = stop(prepared.encoding).await;
                        continue;
                    }
                    if request.settings.fps != settings.fps {
                        if let Err(error) = capture.set_fps(request.settings.fps).await {
                            let _ = stop(prepared.encoding).await;
                            let _ = request.result.send(Err(error));
                            continue;
                        }
                    }
                    let next = demands.borrow().clone();
                    // Reuse the existing fresh-IDR admission boundary. A prepared
                    // AU can precede the incumbent's last sent source timestamp.
                    for demand in &next {
                        if let Some(input) = demand.input.upgrade() { input.set_active(false); }
                    }
                    let previous = std::mem::replace(encodings, Encodings::new(time.clone(), changed.clone(), codec));
                    previous.stop().await;
                    ended = Ok(());
                    settings = request.settings;
                    encodings.baseline(prepared.encoding, frames.clone(), frames.requests());
                    layers.insert("h".into(), frames.clone());
                    install_lower(encodings, &layers, &low, capture.encode(settings.lower_layer(), codec));
                    control.video_settings.send_replace(settings);
                    let failed = encodings.reconcile(&next, None, |bitrate| {
                        capture.encode(Settings { bitrate, ..settings }, codec)
                    }).await;
                    frames.write(prepared.first);
                    bandwidth_changed.notify_one();
                    for (video, result) in failed {
                        ended = result;
                        report_failure(&events, &control.video, publication_id, source_id, video, &layers).await?;
                    }
                    let _ = request.result.send(Ok(()));
                },
                update = demands.changed() => {
                    if update.is_err() { return Ok(()); }
                    let next = demands.borrow_and_update().clone();
                    let failed = encodings.reconcile(&next, None, |bitrate| {
                        capture.encode(Settings { bitrate, ..settings }, codec)
                    }).await;
                    for (video, result) in failed {
                        ended = result;
                        report_failure(&events, &control.video, publication_id, source_id, video, &layers).await?;
                    }
                },
                _ = changed.notified() => {},
                Some((video, result)) = encodings.pumps.next(), if !encodings.pumps.is_empty() => {
                    if let Some(result) = encodings.retired_or_failed(&video, result) {
                        ended = result;
                        report_failure(&events, &control.video, publication_id, source_id, video, &layers).await?;
                    }
                }
            }
            // Adoption/closure can retire an encoder, but never retries a failed
            // allocation. Only a real change to demands starts another attempt.
            encodings.retire_unused();
        }
        ended
    }.await;
    if let Err(error) = &result {
        if !error.is::<Aborted>() {
            log::warn!(target: "piik.capture", "Capture ended: {error:#}");
        }
    }
    control.stop();
    if let Some(preparing) = preparing.take() {
        let (request, prepared) = preparing.await;
        if let Ok(prepared) = prepared {
            let _ = stop(prepared.encoding).await;
        }
        let _ = request.result.send(Err(anyhow!("capture_unavailable")));
    }
    drop(preparing);
    if let Some(encodings) = encodings {
        encodings.stop().await;
    }
    let result = if let Some(encoding) = encoding {
        result.and(stop(encoding).await)
    } else {
        result
    };
    let joined = tokio::task::spawn_blocking(move || capture.stop())
        .await
        .map_err(anyhow::Error::from)
        .and_then(|result| result);
    if let Err(error) = &joined {
        log::warn!(target: "piik.capture", "Capture cleanup failed: {error:#}");
    }
    let result = result.and(joined);
    let error = result.as_ref().err().map(|error| format!("{error:#}"));
    if let Some(ready) = ready {
        let _ = ready.send(result.and(Err(Aborted.into())));
    }
    if !*cancelled.borrow() {
        tokio::select! {
            _ = events.send(Event::CaptureEnded { publication_id, source: source_id }) => {},
            _ = cancelled.changed() => {},
        }
    }
    error
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::capture::{DegradationPreference, FrameTiming, Frames};

    #[tokio::test]
    async fn failed_initial_lower_allocation_keeps_a_recoverable_rid() -> Result<()> {
        let now = Instant::now();
        let time = SourceTime::local(now, SystemInstant::now(now));
        let changed = Arc::new(Notify::new());
        let high = Video::new(time.clone(), changed.clone());
        let low = Video::new(time.clone(), changed.clone());
        let layers = Layers::new(vec!["q".into(), "h".into()]);
        layers.insert("h".into(), high.clone());
        let mut encodings = Encodings::new(time.clone(), changed.clone(), VideoCodec::Vp8);
        install_lower(&mut encodings, &layers, &low, Err(anyhow!("encoder busy")));

        let old_inventory = layers.snapshot();
        assert_eq!(old_inventory[0].0, "q");
        assert!(old_inventory[0].1.is_none());
        assert!(old_inventory[1].1.as_ref().unwrap().same(&high));
        let incumbent = crate::media::video::Input::new(time, changed);
        let frame = crate::EncodedFrame {
            bytes: vec![1],
            presentation_time: now + Duration::from_millis(1),
            keyframe: true,
            vp8: None,
        };
        install_lower(
            &mut encodings,
            &layers,
            &low,
            Ok(Encoding::with_test_frame(frame)),
        );
        let new_inventory = layers.snapshot();
        assert_eq!(new_inventory[0].0, old_inventory[0].0);
        assert!(new_inventory[0].1.as_ref().unwrap().same(&low));
        crate::media::video::Supply(layers.snapshot()).supply(
            &[("q".into(), incumbent.clone())],
            crate::media::video::EncodingDemand::Original,
            now,
        )?;
        let newcomer = low.subscribe();
        tokio::time::timeout(Duration::from_secs(1), async {
            tokio::select! {
                result = async {
                    let a = incumbent.recv().await.unwrap();
                    let b = newcomer.recv().await.unwrap();
                    assert!(a.keyframe);
                    assert!(b.keyframe);
                } => result,
                _ = encodings.pumps.next() => panic!("supplied encoder ended before delivery"),
            }
        })
        .await?;
        encodings.stop().await;
        Ok(())
    }

    #[tokio::test]
    async fn replacement_first_au_preserves_the_live_profile() -> Result<()> {
        let now = Instant::now();
        let video = Video::new(
            SourceTime::local(now, SystemInstant::now(now)),
            Arc::new(Notify::new()),
        );
        let original = [0x42, 0xe0, 0x1f];
        video.set_codec(RtpCodec::h264(original))?;
        let reader = video.subscribe();
        let frame = |profile: [u8; 3], tail: &[u8], ms| crate::EncodedFrame {
            bytes: [vec![0, 0, 1, 0x67], profile.to_vec(), tail.to_vec()].concat(),
            presentation_time: now + Duration::from_millis(ms),
            keyframe: true,
            vp8: None,
        };
        let control = Frames::new(FrameTiming::Source)?.control();
        let settings = Settings {
            width: 640,
            height: 360,
            fps: 30,
            bitrate: 500_000,
            degradation_preference: DegradationPreference::Balanced,
        };
        let recovery = &[0, 0, 1, 0x68, 1, 0, 0, 1, 0x65, 1][..];
        let mut next_ms = 1;
        for (profile, tail, compatible) in [
            (original, &[0, 0, 1, 0x65, 1][..], false),
            (original, &[0, 0, 1, 0x68, 1, 0, 0, 1, 0x61, 1], false),
            ([0x4d, 0, 0x1f], recovery, false),
            ([0x42, 0xe0, 0x32], recovery, true),
        ] {
            let candidate = Encoding::with_test_frame(frame(profile, tail, next_ms));
            next_ms += 1;
            let candidate_control = candidate.control();
            let (result, _receiver) = oneshot::channel();
            let (_, prepared) = prepare(
                Ok(candidate),
                &video,
                &control,
                VideoCodec::H264,
                VideoSettingsRequest { settings, result },
            )
            .await;
            assert_eq!(prepared.is_ok(), compatible, "candidate {profile:x?}");
            if let Ok(prepared) = prepared {
                stop(prepared.encoding).await?;
            } else {
                assert!(candidate_control.is_stopped());
                assert!(!control.is_stopped());
                video.write(frame(original, recovery, next_ms));
                let delivered = tokio::time::timeout(Duration::from_secs(1), reader.recv()).await?;
                assert_eq!(
                    delivered.unwrap().bytes,
                    frame(original, recovery, next_ms).bytes
                );
                next_ms += 1;
            }
        }
        Ok(())
    }
}
