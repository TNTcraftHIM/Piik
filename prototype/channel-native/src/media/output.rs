//! One admitted output owns its sender and each negotiated encoding's RTP clock.
use super::{
    packetizer::Packetizer, video, OutputStream, OutputStreams, Source, SourceFeed, SourceOrigin,
    TrackKey, RTP_PACKETS,
};
use crate::peer::transport::Transport;
use anyhow::Result;
use futures_util::{stream::FuturesUnordered, StreamExt};
use rtc::{rtp, rtp_transceiver::rtp_sender::RTCRtpCodecParameters};
use std::sync::Arc;
use std::sync::Weak;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use uuid::Uuid;

#[derive(Clone)]
enum Input {
    Rtp(mpsc::Sender<rtp::Packet>),
    Video(Arc<video::Input>),
}

#[derive(Clone)]
struct Encoding {
    rid: String,
    ssrc: u32,
    input: Input,
}

enum Reader {
    Rtp(mpsc::Receiver<rtp::Packet>),
    Video(Arc<video::Input>, Packetizer),
}
impl Reader {
    async fn recv(&mut self) -> Option<Result<Vec<rtp::Packet>>> {
        match self {
            Self::Rtp(rx) => rx.recv().await.map(|packet| Ok(vec![packet])),
            Self::Video(input, packetizer) => input
                .recv_with_source()
                .await
                .map(|(video, frame)| packetizer.packetize_source(&video, &frame)),
        }
    }
}

struct Writer {
    transport: Transport,
    reports: OutputStreams,
    clock_rate: u32,
    output: Uuid,
    writable: Arc<tokio::sync::Notify>,
}
async fn write(
    mut reader: (u32, String, Reader),
    writer: Arc<Writer>,
) -> ((u32, String, Reader), Option<Result<()>>) {
    let Some(packets) = reader.2.recv().await else {
        return (reader, None);
    };
    let (ssrc, rid) = (reader.0, reader.1.clone());
    let (id, clock_rate) = (writer.output, writer.clock_rate);
    let (transport, output_reports, writable) =
        (&writer.transport, &writer.reports, &writer.writable);
    let result = async {
        let packets = packets?;
        let timestamp = packets.first().map(|p| p.header.timestamp).unwrap_or(0);
        let wallclock = {
            let streams = output_reports.0.lock().unwrap();
            let stream = &streams[&ssrc];
            let report = stream.report.lock().unwrap();
            report
                .as_ref()
                .and_then(|(sr, at)| {
                    if let Some(clock) = &stream.clock {
                        return clock.projected(*at).map(|(at, _)| at);
                    }
                    let ticks = timestamp.wrapping_sub(sr.rtp_time) as i32;
                    let duration = std::time::Duration::from_nanos(
                        u64::from(ticks.unsigned_abs()) * 1_000_000_000 / u64::from(clock_rate),
                    );
                    let projected = if ticks >= 0 {
                        *at + duration
                    } else {
                        *at - duration
                    };
                    Some(projected)
                })
                .unwrap_or_else(std::time::Instant::now)
        };
        let queued = std::time::Instant::now();
        if wallclock > queued {
            tokio::time::sleep_until(wallclock.into()).await;
        }
        let mut pending = packets;
        loop {
            let changed = writable.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match transport
                .write_au(id, rid.clone(), pending, wallclock)
                .await?
            {
                None => break,
                Some(au) => pending = au,
            }
            changed.await;
        }
        Ok(())
    }
    .await;
    (reader, Some(result))
}

pub(crate) struct Output {
    pub id: Uuid,
    pub source: Uuid,
    pub stream: String,

    negotiated: watch::Sender<Option<RTCRtpCodecParameters>>,
    encodings: Vec<Encoding>,
    task: JoinHandle<()>,
    feedback: JoinHandle<()>,
    reports: OutputStreams,
}
impl Output {
    pub async fn new(
        pc: &Transport,
        source: &Source,
        stream: String,
        pair: Uuid,
        key: TrackKey,
        events: mpsc::Sender<crate::peer::Event>,
        reports: OutputStreams,
        preserve_layers: bool,
    ) -> Result<Self> {
        let id = Uuid::new_v4();
        let ssrc = u32::from_be_bytes(id.as_bytes()[..4].try_into().unwrap());
        let supplied = source.layers.as_ref().filter(|_| preserve_layers);
        #[cfg(any(feature = "capture", test))]
        if matches!(source.origin, SourceOrigin::Local) {
            anyhow::ensure!(
                supplied.is_none_or(video::Layers::has_feed),
                "local source has no surviving supplied encoding"
            );
        }
        let supply = supplied.map(video::Layers::snapshot);
        let rids = supply
            .as_ref()
            .map(|layers| layers.iter().map(|(rid, _)| rid.clone()).collect())
            .unwrap_or_else(|| vec![String::new()]);
        let (mut feedback_rx, writable) = pc
            .add_output(
                id,
                source.codec.clone(),
                source.kind,
                stream.clone(),
                rids.clone(),
            )
            .await?;
        let mut encodings = Vec::new();
        let mut readers = Vec::new();
        for (index, rid) in rids.into_iter().enumerate() {
            let ssrc = ssrc.wrapping_add(index as u32 * 2);
            let (input, reader, report) = match &source.feed {
                SourceFeed::Rtp { report, .. } => {
                    let (packets, rx) = mpsc::channel(RTP_PACKETS);
                    (Input::Rtp(packets), Reader::Rtp(rx), report.clone())
                }
                SourceFeed::Video(video) => {
                    let report: super::SourceReport = Default::default();
                    let packetizer = match Packetizer::new(
                        &source.codec,
                        0, // The writer applies this sender's negotiated payload type.
                        ssrc,
                        video.time(),
                        report.clone(),
                    ) {
                        Ok(packetizer) => packetizer,
                        Err(error) => {
                            let _ = pc.retire_output(id).await;
                            return Err(error);
                        }
                    };
                    let input = match &supply {
                        Some(layers) => layers
                            .iter()
                            .find(|(id, _)| *id == rid)
                            .and_then(|(_, video)| video.as_ref())
                            .map_or_else(
                                || video::Input::new(video.time(), video.changed()),
                                video::Video::subscribe,
                            ),
                        None => video.subscribe(),
                    };
                    // Adaptive sources wait for confirmed transport demand. A relay
                    // without a decoder can directly consume its original AU feed.
                    let adaptive = match &source.origin {
                        #[cfg(any(feature = "capture", test))]
                        SourceOrigin::Local => true,
                        SourceOrigin::Incoming { .. } => {
                            source.codec.mime_type.eq_ignore_ascii_case("video/H264")
                                && cfg!(all(
                                    feature = "capture",
                                    any(
                                        target_os = "windows",
                                        target_os = "linux",
                                        target_os = "macos"
                                    )
                                ))
                        }
                    };
                    input.set_active(!adaptive);
                    (
                        Input::Video(input.clone()),
                        Reader::Video(input, packetizer),
                        report,
                    )
                }
            };
            reports.0.lock().unwrap().insert(
                ssrc,
                OutputStream {
                    report,
                    clock: match &source.feed {
                        SourceFeed::Video(video) => Some(video.time()),
                        SourceFeed::Rtp { .. } => None,
                    },
                },
            );
            encodings.push(Encoding {
                rid: rid.clone(),
                ssrc,
                input,
            });
            readers.push((ssrc, rid, reader));
        }
        let (negotiated, mut format) = watch::channel(None::<RTCRtpCodecParameters>);
        let source_id = source.id;
        let upstream = source.clone();
        let feedback_inputs = encodings.clone();
        let feedback = tokio::spawn(async move {
            while feedback_rx.recv().await.is_some() {
                for encoding in &feedback_inputs {
                    match &encoding.input {
                        Input::Rtp(_) => upstream.request_keyframe(),
                        Input::Video(input) => input.request_keyframe(),
                    }
                }
            }
        });
        let writer = Arc::new(Writer {
            transport: pc.clone(),
            reports: reports.clone(),
            clock_rate: source.codec.clock_rate,
            output: id,
            writable,
        });
        let mut writes = readers
            .into_iter()
            .map(|reader| write(reader, writer.clone()))
            .collect::<FuturesUnordered<_>>();
        let task = tokio::spawn(async move {
            let result = async {
                loop {
                    tokio::select! {
                        changed = format.changed() => {
                            if changed.is_err() { break; }
                            anyhow::ensure!(format.borrow().is_some(), "encoded codec no longer negotiated");
                        }
                        next = writes.next(), if format.borrow().is_some() => {
                            let Some((reader,result))=next else {break};
                            if let Some(result)=result {result?;writes.push(write(reader,writer.clone()));}
                        }
                    }

                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                eprintln!("Native encoded output failed: {error}");
                let _ = events
                    .send(crate::peer::Event::OutputFailed {
                        pair,
                        key,
                        source: source_id,
                        output: id,
                    })
                    .await;
            }
        });
        Ok(Self {
            id,
            source: source.id,
            stream,
            negotiated,
            encodings,
            task,
            feedback,
            reports,
        })
    }
    pub fn rtp_sink(&self) -> Option<mpsc::Sender<rtp::Packet>> {
        if self.negotiated.borrow().is_none() {
            return None;
        }
        match &self.encodings.first()?.input {
            Input::Rtp(packets) => Some(packets.clone()),
            Input::Video(_) => None,
        }
    }
    pub fn video_input(&self) -> Option<Weak<video::Input>> {
        let encoding = self.encodings.first()?;
        if !encoding.rid.is_empty() {
            return None;
        }
        match &encoding.input {
            Input::Video(input) => Some(Arc::downgrade(input)),
            Input::Rtp(_) => None,
        }
    }
    #[cfg(feature = "capture")]
    pub fn video_inputs(&self) -> Vec<(String, Weak<video::Input>)> {
        self.encodings
            .iter()
            .filter_map(|encoding| match &encoding.input {
                Input::Video(input) => Some((encoding.rid.clone(), Arc::downgrade(input))),
                Input::Rtp(_) => None,
            })
            .collect()
    }
    #[cfg(feature = "capture")]
    pub fn encoding_failed(&self, video: &video::Video, layers: Option<&video::Layers>) -> bool {
        if let Some(input) = self.video_input().and_then(|input| input.upgrade()) {
            return input.failed(video);
        }
        for encoding in &self.encodings {
            if let Input::Video(input) = &encoding.input {
                if layers.is_some() {
                    input.retire(video);
                } else {
                    input.failed(video);
                }
            }
        }
        // The source inventory includes failures predating this output. Unbound
        // RID readers must not keep an exhausted local supply alive.
        layers.map_or_else(
            || {
                self.encodings.iter().all(
                    |encoding| matches!(&encoding.input, Input::Video(input) if input.is_closed()),
                )
            },
            |layers| !layers.has_feed(),
        )
    }
    pub fn select_layers(
        &self,
        layers: &video::Layers,
        demand: video::EncodingDemand,
        now: std::time::Instant,
    ) -> Result<()> {
        if let Some(input) = self.video_input().and_then(|input| input.upgrade()) {
            layers.select(&input, demand, now)
        } else {
            let inputs = self
                .encodings
                .iter()
                .filter_map(|encoding| match &encoding.input {
                    Input::Video(input) => Some((encoding.rid.clone(), input.clone())),
                    _ => None,
                })
                .collect::<Vec<_>>();
            layers.supply(&inputs, demand, now)
        }
    }
    pub fn confirm(&self, codec: Option<RTCRtpCodecParameters>) -> Result<()> {
        self.negotiated.send_replace(codec);
        Ok(())
    }
    pub async fn close(self, pc: &Transport) {
        for encoding in &self.encodings {
            if let Input::Video(input) = &encoding.input {
                input.close();
            }
        }
        self.task.abort();
        self.feedback.abort();
        let _ = self.task.await;
        let _ = self.feedback.await;
        let _ = pc.retire_output(self.id).await;
        let mut reports = self.reports.0.lock().unwrap();
        for encoding in &self.encodings {
            reports.remove(&encoding.ssrc);
        }
    }
}
