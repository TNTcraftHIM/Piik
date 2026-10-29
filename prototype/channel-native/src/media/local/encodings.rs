//! One producer selects and retires the actual encoders used by its Outputs.
use super::*;
use crate::capture::{Encoding, EncodingControl};
use futures_util::{stream::FuturesUnordered, StreamExt};
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};
use tokio::sync::Notify;

async fn stop(encoding: Encoding) -> Result<()> {
    encoding.control().stop();
    tokio::task::spawn_blocking(move || encoding.stop()).await?
}

async fn report_failure(
    events: &mpsc::Sender<Event>,
    capture: &VideoControl,
    publication_id: Uuid,
    source: Uuid,
    video: Video,
) -> Result<()> {
    tokio::select! {
        biased;
        _ = capture.stopped() => Ok(()),
        sent = events.send(Event::EncodingFailed { publication_id, source, video }) => sent.map_err(Into::into),
    }
}

type Pump = Pin<Box<dyn Future<Output = (Video, Result<()>)> + Send>>;

struct Entry {
    video: Video,
    control: EncodingControl,
    bitrate: u32,
}
impl Entry {
    fn new(
        encoding: Encoding,
        video: Video,
        bitrate: u32,
        capture: VideoControl,
        requests: watch::Receiver<u64>,
        pumps: &mut FuturesUnordered<Pump>,
    ) -> Self {
        let control = encoding.control();
        pumps.push(pump(encoding, video.clone(), capture, requests));
        Self {
            video,
            control,
            bitrate,
        }
    }
    fn retire(self) {
        self.control.stop();
        // An idle pump is waiting on requests, not consuming encoded frames.
        self.video.request_keyframe();
    }
}

fn pump(
    mut encoding: Encoding,
    video: Video,
    capture: VideoControl,
    mut requests: watch::Receiver<u64>,
) -> Pump {
    Box::pin(async move {
        let control = encoding.control();
        let mut sps = H264Sps::default();
        let result = async {
            while !control.is_stopped() {
                tokio::select! {
                    _ = capture.stopped() => break,
                    // Keep the baseline warm without encoding unused frames.
                    // Its existing two-AU queue supplies bounded backpressure.
                    frame = encoding.recv(), if video.needed() => match frame {
                        Some(frame) => {
                            let frame = frame?;
                            sps.access_unit(&frame.bytes)?;
                            video.write(frame);
                        }
                        None => break,
                    },
                    changed = requests.changed() => {
                        changed?;
                        if video.needed() && !control.is_stopped() {
                            control.force_keyframe()?;
                        }
                    }
                }
            }
            Ok(())
        }
        .await;
        let result = result.and(stop(encoding).await);
        (video, result)
    })
}

fn select(demand: &VideoDemand, video: &Video, required: bool) -> bool {
    let Some(input) = demand.input.upgrade() else {
        return false;
    };
    if input.select(video, required).is_err() {
        return false;
    }
    input.set_active(true);
    true
}

fn retire_unused(limited: &mut HashMap<Uuid, Entry>) {
    let retired: Vec<_> = limited
        .iter()
        .filter(|(_, entry)| !entry.video.needed())
        .map(|(id, _)| *id)
        .collect();
    for id in retired {
        limited.remove(&id).unwrap().retire();
    }
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
    let changed = Arc::new(Notify::new());
    let frames = Video::new(time, changed.clone());
    let requests = frames.requests();
    let mut initial = Some(encoding);
    let mut baseline: Option<Entry> = None;
    let mut limited = HashMap::<Uuid, Entry>::new();
    let mut pumps = FuturesUnordered::<Pump>::new();
    // Only handles are retained here, so a removed transport demand is paused
    // even if its Output has not finished closing yet.
    let mut inputs = HashMap::<Uuid, Weak<Input>>::new();
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
        baseline = Some(Entry::new(initial.take().unwrap(), frames, settings.bitrate,
            control.video.clone(), requests, &mut pumps));
        loop {
            tokio::select! {
                _ = control.video.stopped() => break,
                _ = cancelled.changed() => break,
                update = demands.changed() => {
                    if update.is_err() { break; }
                    let next = demands.borrow_and_update().clone();
                    inputs.retain(|id, input| {
                        let keep = next.iter().any(|d| d.output == *id && d.input.ptr_eq(input));
                        if !keep { if let Some(input) = input.upgrade() { input.set_active(false); } }
                        keep
                    });
                    for demand in &next { inputs.insert(demand.output, demand.input.clone()); }
                    let mut failed = Vec::new();
                    let full: Vec<_> = next.iter().filter(|d| d.bitrate >= settings.bitrate).collect();
                    if !full.is_empty() {
                        let video = baseline.as_ref().map(|entry| entry.video.clone())
                            .unwrap_or_else(|| Video::new(time, changed.clone()));
                        let requests = video.requests();
                        for demand in full { select(demand, &video, false); }
                        if baseline.is_none() && video.needed() {
                            match capture.encode(settings) {
                                Ok(encoding) => baseline = Some(Entry::new(encoding, video, settings.bitrate,
                                    control.video.clone(), requests, &mut pumps)),
                                Err(error) => {
                                    eprintln!("Native baseline encoding failed: {error:#}");
                                    failed.push(video);
                                }
                            }
                        }
                    }
                    for demand in next.iter().filter(|d| d.bitrate < settings.bitrate) {
                        if demand.bitrate == 0 {
                            if let Some(input) = demand.input.upgrade() { input.set_active(false); }
                            continue;
                        }
                        if let Some(entry) = limited.get_mut(&demand.output) {
                            if select(demand, &entry.video, true) && entry.bitrate != demand.bitrate {
                                if let Err(error) = entry.control.set_bitrate(demand.bitrate) {
                                    eprintln!("Native output encoding failed: {error:#}");
                                    let entry = limited.remove(&demand.output).unwrap();
                                    failed.push(entry.video.clone());
                                    entry.retire();
                                } else {
                                    entry.bitrate = demand.bitrate;
                                }
                            }
                        } else {
                            let video = Video::new(time, changed.clone());
                            let requests = video.requests();
                            if !select(demand, &video, true) { continue; }
                            match capture.encode(Settings { bitrate: demand.bitrate, ..settings }) {
                                Ok(encoding) => { limited.insert(demand.output, Entry::new(encoding, video,
                                    demand.bitrate, control.video.clone(), requests, &mut pumps)); }
                                Err(error) => {
                                    eprintln!("Native output encoding failed: {error:#}");
                                    failed.push(video);
                                }
                            }
                        }
                    }
                    for video in failed {
                        report_failure(&events, &control.video, publication_id, source_id, video).await?;
                    }
                },
                _ = changed.notified() => {},
                Some((video, result)) = pumps.next(), if !pumps.is_empty() => {
                    let owned = if baseline.as_ref().is_some_and(|entry| entry.video.same(&video)) {
                        baseline.take();
                        true
                    } else {
                        let id = limited.iter().find(|(_, entry)| entry.video.same(&video)).map(|(id, _)| *id);
                        id.is_some_and(|id| limited.remove(&id).is_some())
                    };
                    if owned && !control.video.is_stopped() {
                        eprintln!("Native encoding ended: {:?}", result.err());
                        report_failure(&events, &control.video, publication_id, source_id, video).await?;
                    } else if let Err(error) = result {
                        eprintln!("Native retired encoding failed: {error:#}");
                    }
                }
            }
            // Adoption/closure can retire an encoder, but never retries a failed
            // allocation. Only a real change to demands starts another attempt.
            retire_unused(&mut limited);
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    control.stop();
    if let Some(entry) = baseline {
        entry.retire();
    }
    for (_, entry) in limited {
        entry.retire();
    }
    while pumps.next().await.is_some() {}
    if let Some(encoding) = initial {
        let _ = stop(encoding).await;
    }
    let joined = tokio::task::spawn_blocking(move || capture.stop())
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
