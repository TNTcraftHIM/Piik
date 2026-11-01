//! Capture startup and shutdown; encoder selection is shared with relay derivation.
use super::*;
use crate::{
    capture::Encoding,
    media::encodings::{stop, Encodings},
};
use futures_util::{future::Aborted, StreamExt};
use std::sync::Arc;
use tokio::sync::Notify;

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
    settings: Settings,
    publication_id: Uuid,
    source_id: Uuid,
    time: SourceTime,
    control: Control,
    ready: oneshot::Sender<Result<()>>,
    ready_sources: mpsc::Sender<SourceReady>,
    events: mpsc::Sender<Event>,
    mut cancelled: watch::Receiver<bool>,
    mut demands: watch::Receiver<Vec<VideoDemand>>,
) -> Option<String> {
    let changed = Arc::new(Notify::new());
    let frames = Video::new(time.clone(), changed.clone());
    let requests = frames.requests();
    let mut initial = Some(encoding);
    let mut encodings = Encodings::new(time.clone(), changed.clone());
    let mut ready = Some(ready);
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
