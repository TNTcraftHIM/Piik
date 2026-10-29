//! The capture's baseline encoder and the independent encoders actually leased by Outputs.
use super::*;
use crate::capture::Encoding;
use std::collections::HashMap;
use std::sync::Arc;

async fn stop(encoding: Encoding) -> Result<()> {
    encoding.control().stop();
    tokio::task::spawn_blocking(move || encoding.stop()).await?
}

async fn report_failure(
    events: &mpsc::Sender<Event>,
    capture: &VideoControl,
    event: Event,
) -> Result<()> {
    tokio::select! {
        biased;
        _ = capture.stopped() => Ok(()),
        sent = events.send(event) => sent.map_err(Into::into),
    }
}

async fn baseline(
    mut encoding: Encoding,
    frames: Video,
    capture: VideoControl,
    mut requests: watch::Receiver<u64>,
) -> Result<()> {
    let control = encoding.control();
    let mut sps = H264Sps::default();
    let result = async {
        loop {
            tokio::select! {
                _ = capture.stopped() => break,
                frame = encoding.recv() => match frame {
                    Some(frame) => {
                        let frame = frame?;
                        sps.access_unit(&frame.bytes)?;
                        frames.write(frame);
                    }
                    None => break,
                },
                changed = requests.changed() => {
                    changed?;
                    control.force_keyframe()?;
                }
            }
        }
        Ok(())
    }
    .await;
    result.and(stop(encoding).await)
}

struct Limited {
    encoding: Encoding,
    frames: Video,
    requests: watch::Receiver<u64>,
}
async fn output(
    id: Uuid,
    capture: Arc<Capture>,
    settings: Settings,
    baseline: Video,
    mut demands: watch::Receiver<Vec<VideoDemand>>,
) -> Result<()> {
    let control = capture.control();
    let mut limited: Option<Limited> = None;
    let mut adopted = None;
    let mut applied = None;
    let mut sps = H264Sps::default();
    let result = async {
        loop {
            let demand = demands
                .borrow_and_update()
                .iter()
                .find(|d| d.output == id)
                .cloned();
            let Some(demand) = demand else { break };
            if applied.as_ref() != Some(&demand) {
                let Some(input) = demand.input.upgrade() else {
                    break;
                };
                adopted = None;
                if demand.bitrate == 0 {
                    input.set_active(false);
                    drop(input);
                    if let Some(old) = limited.take() {
                        if let Err(error) = stop(old.encoding).await {
                            eprintln!("Native retired output encoding failed: {error:#}");
                        }
                    }
                } else if demand.bitrate >= settings.bitrate {
                    adopted = Some(input.select(&baseline)?);
                    input.set_active(true);
                } else {
                    if let Some(current) = &limited {
                        current.encoding.control().set_bitrate(demand.bitrate)?;
                    } else {
                        let encoding = capture.encode(Settings {
                            bitrate: demand.bitrate,
                            ..settings
                        })?;
                        let frames = Video::new(baseline.time());
                        limited = Some(Limited {
                            encoding,
                            requests: frames.requests(),
                            frames,
                        });
                    }
                    let _ = input.select(&limited.as_ref().unwrap().frames)?;
                    input.set_active(true);
                }
                applied = Some(demand);
            }
            let has_limited = limited.is_some();
            let (encoding, keyframes) = match limited.as_mut() {
                Some(current) => (Some(&mut current.encoding), Some(&mut current.requests)),
                None => (None, None),
            };
            tokio::select! {
                _ = control.stopped() => break,
                changed = demands.changed() => { if changed.is_err() { break; } },
                result = async { adopted.as_mut().unwrap().await }, if adopted.is_some() => {
                    adopted = None;
                    if result.is_ok() {
                        if let Some(old) = limited.take() {
                            if let Err(error) = stop(old.encoding).await {
                                eprintln!("Native retired output encoding failed: {error:#}");
                            }
                        }
                    }
                },
                frame = async { encoding.unwrap().recv().await }, if has_limited => {
                    let frame = frame.ok_or_else(|| anyhow!("encoding ended"))??;
                    sps.access_unit(&frame.bytes)?;
                    limited.as_ref().unwrap().frames.write(frame);
                },
                changed = async { keyframes.unwrap().changed().await }, if has_limited => {
                    changed?;
                    limited.as_ref().unwrap().encoding.control().force_keyframe()?;
                }
            }
        }
        Ok(())
    }
    .await;
    if let Some(old) = limited {
        if let Err(error) = stop(old.encoding).await {
            eprintln!("Native retired output encoding failed: {error:#}");
        }
    }
    result
}

pub(super) async fn run(
    capture: Capture,
    encoding: Encoding,
    settings: Settings,
    publication_id: Uuid,
    source_id: Uuid,
    time: CaptureTime,
    control: Control,
    audio: Option<JoinHandle<()>>,
    ready: oneshot::Sender<Result<()>>,
    ready_sources: mpsc::Sender<SourceReady>,
    events: mpsc::Sender<Event>,
    mut cancelled: watch::Receiver<bool>,
    mut demands: watch::Receiver<Vec<VideoDemand>>,
) -> Option<String> {
    let frames = Video::new(time);
    let initial_requests = frames.requests();
    let capture = Arc::new(capture);
    let mut initial = Some(encoding);
    let mut baseline_task = None;
    let mut outputs: HashMap<Uuid, JoinHandle<()>> = HashMap::new();
    let mut ready = Some(ready);
    let result = async {
        let frame = tokio::select! {
            _ = control.video.stopped() => return Ok(()),
            _ = cancelled.changed() => return Ok(()),
            frame = initial.as_mut().unwrap().recv() => frame.ok_or_else(|| anyhow!("capture ended before its first frame"))??,
        };
        let mut sps = H264Sps::default();
        sps.access_unit(&frame.bytes)?;
        let profile = sps.last.ok_or_else(|| anyhow!("capture first access unit has no SPS"))?;
        let source = Source {
            id: source_id, publication_id, origin: SourceOrigin::Local, kind: RtpCodecKind::Video,
            codec: RTCRtpCodec { mime_type: "video/H264".into(), clock_rate: 90_000,
                sdp_fmtp_line: format!("packetization-mode=1;profile-level-id={:02x}{:02x}{:02x}", profile[0], profile[1], profile[2]), ..Default::default() },
            feed: SourceFeed::Video(frames.clone()),
        };
        tokio::select! {
            _ = control.video.stopped() => return Ok(()),
            _ = cancelled.changed() => return Ok(()),
            sent = ready_sources.send(SourceReady { source, media: InitialMedia::Video(frame) }) => sent?,
        }
        let _ = ready.take().unwrap().send(Ok(()));
        baseline_task = Some(tokio::spawn(baseline(initial.take().unwrap(), frames.clone(), control.video.clone(), initial_requests)));
        loop {
            tokio::select! {
                _ = control.video.stopped() => break,
                _ = cancelled.changed() => break,
                changed = demands.changed() => {
                    if changed.is_err() { break; }
                    let next = demands.borrow_and_update().clone();
                    let retired: Vec<_> = outputs.keys().filter(|id| !next.iter().any(|d| d.output == **id)).copied().collect();
                    for id in retired {
                        let _ = outputs.remove(&id).unwrap().await;
                    }
                    if baseline_task.is_none() && next.iter().any(|d| d.bitrate >= settings.bitrate) {
                        match capture.encode(settings) {
                            Ok(encoding) => baseline_task = Some(tokio::spawn(baseline(encoding, frames.clone(), control.video.clone(), frames.requests()))),
                            Err(error) => {
                                eprintln!("Native baseline encoding failed: {error:#}");
                                for demand in next.iter().filter(|d| d.bitrate >= settings.bitrate) {
                                    report_failure(&events, &control.video, Event::EncodingFailed { publication_id, source: source_id, output: demand.output }).await?;
                                }
                            }
                        }
                    }
                    for demand in next {
                        if outputs.contains_key(&demand.output) { continue; }
                        let id = demand.output;
                        let capture = capture.clone();
                        let frames = frames.clone();
                        let demands = demands.clone();
                        let events = events.clone();
                        outputs.insert(id, tokio::spawn(async move {
                            let control = capture.control();
                            if let Err(error) = output(id, capture, settings, frames, demands).await {
                                if !control.is_stopped() {
                                    eprintln!("Native output encoding failed: {error:#}");
                                    let _ = report_failure(&events, &control, Event::EncodingFailed { publication_id, source: source_id, output: id }).await;
                                }
                            }
                        }));
                    }
                },
                result = async { baseline_task.as_mut().unwrap().await }, if baseline_task.is_some() => {
                    baseline_task = None;
                    if !control.video.is_stopped() {
                        let error = result.map_err(anyhow::Error::from).and_then(|r| r).err();
                        eprintln!("Native baseline encoding ended: {error:?}");
                        let failed: Vec<_> = demands.borrow().iter().filter(|d| d.bitrate >= settings.bitrate).map(|d| d.output).collect();
                        for output in failed {
                            report_failure(&events, &control.video, Event::EncodingFailed { publication_id, source: source_id, output }).await?;
                        }
                    }
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    control.stop();
    for (_, task) in outputs {
        let _ = task.await;
    }
    if let Some(task) = baseline_task {
        let _ = task.await;
    }
    if let Some(encoding) = initial {
        let _ = stop(encoding).await;
    }
    let joined = tokio::task::spawn_blocking(move || {
        Arc::try_unwrap(capture)
            .map_err(|_| anyhow!("capture still has an encoder owner"))?
            .stop()
    })
    .await
    .map_err(anyhow::Error::from)
    .and_then(|result| result);
    if let Some(audio) = audio {
        if let Err(error) = audio.await {
            eprintln!("Native audio task failed: {error}");
        }
    }
    let error = result.and(joined).err().map(|error| format!("{error:#}"));
    if let Some(ready) = ready {
        let _ = ready.send(Err(anyhow!(error
            .clone()
            .unwrap_or_else(|| "capture ended before its first frame".into()))));
    }
    if !*cancelled.borrow() {
        tokio::select! {
            _ = events.send(Event::CaptureEnded { publication_id, source: source_id }) => {},
            _ = cancelled.changed() => {},
        }
    }
    error
}
