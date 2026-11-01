//! Capture startup and shutdown; encoder selection is shared with relay derivation.
use super::*;
use crate::{
    capture::Encoding,
    media::encodings::{stop, Encodings},
};
use futures_util::{future::Aborted, StreamExt};
use std::sync::Arc;
use tokio::sync::Notify;

struct Prepared {
    encoding: Encoding,
    first: crate::EncodedFrame,
}

async fn prepare(
    capture: &Capture,
    control: &VideoControl,
    mut request: VideoSettingsRequest,
) -> (VideoSettingsRequest, Result<Prepared>) {
    let mut encoding = match capture.encode(request.settings) {
        Ok(encoding) => encoding,
        Err(error) => return (request, Err(error)),
    };
    let result = tokio::select! {
        biased;
        _ = control.stopped() => Err(anyhow!("capture_unavailable")),
        _ = request.result.closed() => Err(Aborted.into()),
        frame = encoding.recv() => frame.unwrap_or_else(|| Err(anyhow!("capture encoding ended before its first frame"))),
    }.and_then(|frame| {
        anyhow::ensure!(frame.keyframe, "capture encoding did not start independently");
        let mut sps = H264Sps::default();
        sps.access_unit(&frame.bytes)?;
        anyhow::ensure!(sps.last.is_some(), "capture first access unit has no SPS");
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

async fn report_failure(
    events: &mpsc::Sender<Event>,
    capture: &VideoControl,
    publication_id: Uuid,
    source: Uuid,
    video: Video,
    layers: Option<&crate::media::video::Layers>,
) -> Result<()> {
    // SourceReady and failure events have separate queues. Retire the shared
    // inventory here even when the Driver has not registered SourceReady yet.
    let retired_supply = layers.filter(|layers| layers.retire(&video)).cloned();
    tokio::select! {
        biased;
        _ = capture.stopped() => Ok(()),
        sent = events.send(Event::EncodingFailed { publication_id, source, video, retired_supply }) => sent.map_err(Into::into),
    }
}

pub(super) async fn run(
    capture: Capture,
    encoding: Encoding,
    mut settings: Settings,
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
    let mut initial = Some(encoding);
    let mut encodings = Encodings::new(time.clone(), changed.clone());
    let mut ready = Some(ready);
    let mut preparing = None;
    let result = async {
        let frame = tokio::select! {
            _ = control.video.stopped() => return Ok(()),
            _ = cancelled.changed() => return Ok(()),
            frame = initial.as_mut().unwrap().recv() => match frame {
                Some(frame) => frame?,
                None => return Ok(()),
            },
        };
        let mut sps = H264Sps::default();
        sps.access_unit(&frame.bytes)?;
        let profile = sps.last.ok_or_else(|| anyhow!("capture first access unit has no SPS"))?;
        let low = Video::new(time.clone(), changed.clone());
        let layers = match capture.encode(settings.lower_layer()) {
            Ok(encoding) => {
                let supply = crate::media::video::Layers::new(vec!["q".into(), "h".into()]);
                supply.insert("q".into(), low.clone());
                supply.insert("h".into(), frames.clone());
                encodings.supplied(encoding, low.clone());
                Some(supply)
            }
            Err(error) => {
                eprintln!("Native lower source encoding unavailable: {error:#}");
                None
            }
        };
        let source = Source {
            id: source_id, publication_id, origin: SourceOrigin::Local, kind: MediaKind::Video,
            codec: RtpCodec { mime_type: "video/H264".into(), clock_rate: 90_000,
                sdp_fmtp_line: format!("packetization-mode=1;profile-level-id={:02x}{:02x}{:02x}", profile[0], profile[1], profile[2]), ..Default::default() },
            layers: layers.clone(),
            feed: SourceFeed::Video(frames.clone()),
        };
        tokio::select! {
            _ = control.video.stopped() => return Ok(()),
            _ = cancelled.changed() => return Ok(()),
            sent = ready_sources.send(SourceReady { source, media: InitialMedia::Video(frame) }) => sent?,
        }
        let _ = ready.take().unwrap().send(Ok(()));
        encodings.baseline(initial.take().unwrap(), frames.clone(), requests);
        loop {
            tokio::select! {
                _ = control.video.stopped() => break,
                _ = cancelled.changed() => break,
                request = changes.recv(), if preparing.is_none() => {
                    let Some(request) = request else { break; };
                    if request.result.is_closed() { continue; }
                    if request.settings == settings {
                        let _ = request.result.send(Ok(()));
                    } else {
                        preparing = Some(Box::pin(prepare(&capture, &control.video, request)));
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
                    let previous = std::mem::replace(&mut encodings, Encodings::new(time.clone(), changed.clone()));
                    previous.stop().await;
                    settings = request.settings;
                    encodings.baseline(prepared.encoding, frames.clone(), frames.requests());
                    if let Some(layers) = &layers {
                        match capture.encode(settings.lower_layer()) {
                            Ok(encoding) => {
                                layers.insert("q".into(), low.clone());
                                encodings.supplied(encoding, low.clone());
                            }
                            Err(error) => {
                                layers.remove("q");
                                eprintln!("Native lower source encoding unavailable: {error:#}");
                            }
                        }
                    }
                    control.video_settings.send_replace(settings);
                    let failed = encodings.reconcile(&next, None, |bitrate| {
                        capture.encode(Settings { bitrate, ..settings })
                    });
                    frames.write(prepared.first);
                    bandwidth_changed.notify_one();
                    for video in failed {
                        report_failure(&events, &control.video, publication_id, source_id, video, layers.as_ref()).await?;
                    }
                    let _ = request.result.send(Ok(()));
                },
                update = demands.changed() => {
                    if update.is_err() { break; }
                    let next = demands.borrow_and_update().clone();
                    let failed = encodings.reconcile(&next, None, |bitrate| {
                        capture.encode(Settings { bitrate, ..settings })
                    });
                    for video in failed {
                        report_failure(&events, &control.video, publication_id, source_id, video, layers.as_ref()).await?;
                    }
                },
                _ = changed.notified() => {},
                Some((video, result)) = encodings.pumps.next(), if !encodings.pumps.is_empty() => {
                    if encodings.retired_or_failed(&video, result) {
                        report_failure(&events, &control.video, publication_id, source_id, video, layers.as_ref()).await?;
                    }
                }
            }
            // Adoption/closure can retire an encoder, but never retries a failed
            // allocation. Only a real change to demands starts another attempt.
            encodings.retire_unused();
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    control.stop();
    if let Some(preparing) = preparing.take() {
        let (request, prepared) = preparing.await;
        if let Ok(prepared) = prepared {
            let _ = stop(prepared.encoding).await;
        }
        let _ = request.result.send(Err(anyhow!("capture_unavailable")));
    }
    drop(preparing);
    encodings.stop().await;
    let result = if let Some(encoding) = initial {
        result.and(stop(encoding).await)
    } else {
        result
    };
    let joined = tokio::task::spawn_blocking(move || capture.stop())
        .await
        .map_err(anyhow::Error::from)
        .and_then(|result| result);
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
