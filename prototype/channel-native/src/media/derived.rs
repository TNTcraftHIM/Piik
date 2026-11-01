//! One received video owns at most one decoder; its original AU feed stays live.
use super::{
    encodings::{self, Encodings, VideoDemand},
    video::{EncodingDemand, Input, Video},
};
use crate::{
    capture::{Format, FrameTiming, Frames, Settings, VideoCodec},
    peer::Event,
};
use anyhow::Result;
use futures_util::{future::pending, StreamExt};
use std::sync::Arc;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use uuid::Uuid;

pub(crate) struct Producer {
    demands: watch::Sender<Vec<VideoDemand>>,
    task: JoinHandle<()>,
}
impl Producer {
    pub fn start(
        publication: Uuid,
        source: Uuid,
        baseline: Video,
        events: mpsc::Sender<Event>,
    ) -> Self {
        let (demands, rx) = watch::channel(Vec::new());
        let task = tokio::spawn(run(publication, source, baseline, rx, events));
        Self { demands, task }
    }
    pub fn set_demands(&self, next: Vec<VideoDemand>) {
        self.demands.send_if_modified(|current| {
            if *current == next {
                false
            } else {
                *current = next;
                true
            }
        });
    }
    pub async fn stop(self) {
        drop(self.demands);
        let _ = self.task.await;
    }
}

struct Decoding {
    encodings: Encodings,
    frames: Frames,
    input: Arc<Input>,
    format: watch::Receiver<Option<Format>>,
    task: JoinHandle<Result<()>>,
}
impl Decoding {
    fn start(baseline: &Video) -> Result<Self> {
        let frames = Frames::new(FrameTiming::Source)?;
        let worker = frames.clone();
        let input = baseline.subscribe();
        let feed = input.clone();
        let (format, formats) = watch::channel(None);
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let task = {
            #[cfg(target_os = "windows")]
            let epoch = baseline.time().epoch;
            #[cfg(target_os = "macos")]
            let clock = frames.clock();
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                let result = (|| -> Result<()> {
                    #[cfg(target_os = "windows")]
                    let mut decoder = crate::capture::Decoder::new(epoch)?;
                    #[cfg(target_os = "macos")]
                    let mut decoder = crate::capture::Decoder::new(clock)?;
                    while let Some(frame) = runtime.block_on(feed.recv()) {
                        decoder.decode(&frame, &mut |texture, time, current| {
                            worker.publish(texture, time);
                            format.send_if_modified(|previous| {
                                if *previous == Some(current) {
                                    false
                                } else {
                                    *previous = Some(current);
                                    true
                                }
                            });
                            Ok(())
                        })?;
                    }
                    Ok(())
                })();
                worker.finish(result.as_ref().err().map(|error| format!("{error:#}")));
                result
            })
        };
        #[cfg(target_os = "linux")]
        let task = tokio::spawn(async move {
            let access_units = futures_util::stream::unfold(feed, |input| async move {
                input.recv().await.map(|frame| (frame, input))
            });
            crate::capture::decoder::run(access_units, worker, format).await
        });
        Ok(Self {
            encodings: Encodings::new(baseline.time(), baseline.changed(), VideoCodec::H264),
            frames,
            input,
            format: formats,
            task,
        })
    }
    async fn stop(self) {
        self.encodings.stop().await;
        self.input.close();
        self.frames.control().stop();
        let _ = self.task.await;
    }
    // The actor has already consumed the decoder JoinHandle. A published format
    // does not imply its notification was handled and encoder owners created.
    async fn ended(mut self, current: &[VideoDemand], baseline: &Video) -> Vec<Video> {
        self.input.close();
        let mut failed = self.encodings.take_failed();
        self.encodings.stop().await;
        if failed.is_empty() {
            failed = failed_allocations(current, baseline);
        }
        failed
    }
}
fn direct(next: &[VideoDemand]) {
    for demand in next {
        if demand.encoding == EncodingDemand::Paused {
            if let Some(input) = demand.input.upgrade() {
                input.set_active(false);
            }
        } else if demand.encoding == EncodingDemand::Original {
            if let Some(video) = &demand.source {
                encodings::select(demand, video, false);
            }
        }
    }
}
fn needs_decoder(next: &[VideoDemand]) -> bool {
    next.iter().any(|d| {
        matches!(d.encoding, EncodingDemand::Limited(_))
            && d.input.upgrade().is_some_and(|input| !input.is_closed())
    })
}
fn apply(decoding: &mut Decoding, next: &[VideoDemand]) -> Vec<Video> {
    let Some(format) = *decoding.format.borrow() else {
        return vec![];
    };
    decoding
        .encodings
        .reconcile(next, Some(&decoding.input), |bitrate| {
            decoding.frames.encode(
                Settings {
                    width: format.width,
                    height: format.height,
                    fps: format.fps,
                    bitrate,
                },
                VideoCodec::H264,
            )
        })
}
// Without an encoder owner, fail only Inputs requiring a derived encoding;
// the original feed remains usable.
fn failed_allocations(next: &[VideoDemand], baseline: &Video) -> Vec<Video> {
    next.iter()
        .filter(|d| matches!(d.encoding, EncodingDemand::Limited(_)))
        .filter_map(|demand| {
            let video = Video::new(baseline.time(), baseline.changed());
            encodings::select(demand, &video, true).then_some(video)
        })
        .collect()
}
async fn run(
    publication: Uuid,
    source: Uuid,
    baseline: Video,
    mut demands: watch::Receiver<Vec<VideoDemand>>,
    events: mpsc::Sender<Event>,
) {
    let changed = baseline.changed();
    let mut current = Vec::new();
    let mut decoding: Option<Decoding> = None;
    enum Wake {
        Demand(Result<(), watch::error::RecvError>),
        Format,
        Decoded(Result<Result<()>, tokio::task::JoinError>),
        Encoded((Video, Result<()>)),
        Selection,
    }
    'running: loop {
        let wake = {
            let (format, task, pumps) = match decoding.as_mut() {
                Some(decoder) => (
                    Some(&mut decoder.format),
                    Some(&mut decoder.task),
                    Some(&mut decoder.encodings.pumps),
                ),
                None => (None, None, None),
            };
            tokio::select! {
                result = demands.changed() => Wake::Demand(result),
                _ = async {
                    if let Some(format) = format {
                        if format.changed().await.is_ok() { return; }
                    }
                    pending::<()>().await;
                } => Wake::Format,
                result = async { if let Some(task) = task { task.await } else { pending().await } } => Wake::Decoded(result),
                result = async { if let Some(pumps) = pumps { if !pumps.is_empty() { return pumps.next().await.unwrap(); } } pending().await } => Wake::Encoded(result),
                _ = changed.notified() => Wake::Selection,
            }
        };
        let mut failed = Vec::new();
        match wake {
            Wake::Demand(Err(_)) => break,
            Wake::Demand(Ok(())) => {
                current = demands.borrow_and_update().clone();
                direct(&current);
                if decoding.is_none() && needs_decoder(&current) {
                    let source = current
                        .iter()
                        .find(|d| matches!(d.encoding, EncodingDemand::Limited(_)))
                        .and_then(|d| d.source.as_ref())
                        .unwrap_or(&baseline);
                    match Decoding::start(source) {
                        Ok(decoder) => decoding = Some(decoder),
                        Err(error) => {
                            eprintln!("Native derived decoder initialization failed: {error:#}");
                            failed = failed_allocations(&current, &baseline);
                        }
                    }
                }
                if let Some(decoder) = &mut decoding {
                    if let Some(source) = current
                        .iter()
                        .find(|d| matches!(d.encoding, EncodingDemand::Limited(_)))
                        .and_then(|d| d.source.as_ref())
                    {
                        if let Err(error) = decoder.input.select(source, false) {
                            eprintln!("Native decoder input selection failed: {error:#}");
                            break;
                        }
                    }
                    failed = apply(decoder, &current);
                }
            }
            Wake::Format => {
                if let Some(decoder) = &mut decoding {
                    failed = apply(decoder, &current);
                }
            }
            Wake::Encoded((video, result)) => {
                if decoding
                    .as_mut()
                    .unwrap()
                    .encodings
                    .retired_or_failed(&video, result)
                {
                    failed.push(video);
                }
            }
            Wake::Decoded(result) => {
                eprintln!("Native derived decoder ended: {result:?}");
                failed = decoding.take().unwrap().ended(&current, &baseline).await;
            }
            Wake::Selection => {}
        }
        for video in failed {
            let sent = events.send(Event::EncodingFailed {
                retired_supply: None,
                publication_id: publication,
                source,
                video,
            });
            tokio::pin!(sent);
            let mut updated = false;
            loop {
                tokio::select! {
                    result = &mut sent => { if result.is_err() { break 'running; } break; },
                    result = demands.changed() => { if result.is_err() { break 'running; } updated = true; },
                }
            }
            if updated {
                demands.mark_changed();
            }
        }
        if let Some(decoder) = &mut decoding {
            decoder.encodings.retire_unused();
        }
        // Full-rate demand alone cannot retire the current limited encoder:
        // it remains needed until the original feed supplies an adopted IDR.
        // This also cancels initialization if its demand disappears first.
        if !needs_decoder(&current)
            && decoding
                .as_ref()
                .is_none_or(|decoder| !decoder.encodings.has_limited())
        {
            if let Some(decoder) = decoding.take() {
                decoder.stop().await;
            }
        }
    }
    if let Some(decoder) = decoding {
        decoder.stop().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{media::clock::SourceTime, EncodedFrame};
    use rtc_shared::time::SystemInstant;
    use std::time::{Duration, Instant};
    use tokio::sync::Notify;

    #[tokio::test]
    async fn decoder_ends_after_format_before_allocation_fails_only_limited() -> Result<()> {
        let epoch = Instant::now();
        let baseline = Video::new(
            SourceTime::local(epoch, SystemInstant::now(epoch)),
            Arc::new(Notify::new()),
        );
        let healthy = baseline.subscribe();
        let limited = baseline.subscribe();
        let current = vec![
            VideoDemand {
                output: Uuid::new_v4(),
                rid: String::new(),
                source: Some(baseline.clone()),
                input: Arc::downgrade(&healthy),
                encoding: EncodingDemand::Original,
            },
            VideoDemand {
                output: Uuid::new_v4(),
                rid: String::new(),
                source: Some(baseline.clone()),
                input: Arc::downgrade(&limited),
                encoding: EncodingDemand::Limited(500_000),
            },
        ];
        let frames = Frames::new(FrameTiming::Source)?;
        let worker = frames.clone();
        let (format, formats) = watch::channel(None);
        let mut decoding = Decoding {
            encodings: Encodings::new(baseline.time(), baseline.changed(), VideoCodec::H264),
            frames,
            input: baseline.subscribe(),
            format: formats,
            task: tokio::spawn(async move {
                format.send_replace(Some(Format {
                    width: 640,
                    height: 360,
                    fps: 30,
                }));
                worker.finish(Some("decoder ended after publishing format".into()));
                Ok(())
            }),
        };
        (&mut decoding.task).await??;
        assert!(decoding.format.borrow().is_some());
        let failed = decoding.ended(&current, &baseline).await;
        assert_eq!(failed.len(), 1);
        assert!(limited.failed(&failed[0]));
        assert!(!healthy.failed(&failed[0]));
        assert!(limited.recv().await.is_none());
        baseline.write(EncodedFrame {
            vp8: None,
            bytes: vec![1],
            presentation_time: epoch + Duration::from_millis(1),
            keyframe: true,
        });
        assert_eq!(healthy.recv().await.unwrap().bytes, vec![1]);
        Ok(())
    }
}
