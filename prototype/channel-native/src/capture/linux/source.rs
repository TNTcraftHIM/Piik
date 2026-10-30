use super::{message_error, Control, Encoding, Frames, Pipeline};
use crate::capture::{Settings, Target, TargetKind};
use anyhow::{anyhow, ensure, Context as _, Result};
use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
use futures_util::StreamExt;
use gst::prelude::*;
use std::{os::fd::AsRawFd, thread};

pub fn targets() -> Result<Vec<Target>> {
    gst::init()?;
    ensure!(
        gst::ElementFactory::find("pipewiresrc").is_some(),
        "PipeWire capture plugin unavailable"
    );
    tokio::runtime::Handle::try_current()?.block_on(async {
        let portal = Screencast::new().await?;
        let kinds = portal.available_source_types().await?;
        ensure!(
            kinds.intersects(SourceType::Monitor | SourceType::Window),
            "desktop capture unavailable"
        );
        Ok(vec![Target {
            kind: TargetKind::Picker,
            source_id: "0".into(),
            title: "Screen or window".into(),
            pid: 0,
            creation_time: None,
        }])
    })
}

pub struct Capture {
    frames: Frames,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Capture {
    pub fn start(target: Target, fps: u32) -> Result<Self> {
        ensure!(
            matches!(target.kind, TargetKind::Picker),
            "Linux capture uses the system picker"
        );
        ensure!(fps > 0 && fps <= i32::MAX as u32, "invalid capture FPS");
        gst::init()?;
        let frames = Frames::new();
        let worker = frames.clone();
        let runtime = tokio::runtime::Handle::try_current()?;
        let thread = thread::Builder::new()
            .name("piik-linux-capture".into())
            .spawn(move || {
                let result = runtime.block_on(run(&worker, fps));
                worker.finish(result.as_ref().err().map(|e| format!("{e:#}")));
                result
            })?;
        Ok(Self {
            frames,
            thread: Some(thread),
        })
    }
    pub fn encode(&self, settings: Settings) -> Result<Encoding> {
        ensure!(!self.frames.control().is_stopped(), "capture stopped");
        Encoding::start(self.frames.clone(), settings)
    }
    pub fn control(&self) -> Control {
        self.frames.control()
    }
    pub fn stop(mut self) -> Result<()> {
        self.control().stop();
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow!("capture worker panicked"))?
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.control().stop();
        if let Some(thread) = self.thread.take() {
            if let Err(error) = thread
                .join()
                .map_err(|_| anyhow!("capture worker panicked"))
                .and_then(|r| r)
            {
                eprintln!("Linux capture cleanup: {error:#}");
            }
        }
    }
}

async fn run(frames: &Frames, fps: u32) -> Result<()> {
    let control = frames.control();
    let portal = tokio::select! {
        _ = control.stopped() => return Ok(()),
        portal = Screencast::new() => portal?,
    };
    // Do not cancel CreateSession after sending it: retain its result so even
    // a stop during the OS request closes exactly the session it created.
    let session = portal.create_session(Default::default()).await?;
    let result: Result<()> = async {
        let mut closed = session.receive_closed().await?;
        let selection = async {
            let kinds = portal.available_source_types().await?
                & (SourceType::Monitor | SourceType::Window);
            ensure!(!kinds.is_empty(), "desktop capture unavailable");
            let cursors = portal.available_cursor_modes().await?;
            let cursor = if cursors.contains(CursorMode::Embedded) { CursorMode::Embedded } else { CursorMode::Hidden };
            portal.select_sources(&session, SelectSourcesOptions::default()
                .set_sources(kinds).set_multiple(false).set_cursor_mode(cursor))
                .await?.response()?;
            let response = portal.start(&session, None, Default::default()).await?.response()?;
            ensure!(response.streams().len() == 1, "expected one selected screen or window");
            let stream = response.streams()[0].clone();
            let fd = portal.open_pipe_wire_remote(&session, Default::default()).await?;
            Ok::<_, anyhow::Error>((stream, fd))
        };
        let (stream, fd) = tokio::select! {
            biased;
            _ = control.stopped() => return Ok(()),
            _ = closed.next() => return Err(anyhow!("desktop sharing permission ended")),
            selected = selection => selected?,
        };
        let source = gst::ElementFactory::make("pipewiresrc")
            .property("fd", fd.as_raw_fd())
            .property("path", stream.pipe_wire_node_id().to_string())
            .build()?;
        let caps = gst::Caps::builder("video/x-raw")
            .field("max-framerate", gst::Fraction::new(fps as i32, 1)).build();
        let sink = gst_app::AppSink::builder().caps(&caps).sync(false).async_(false)
            .enable_last_sample(false).max_buffers(1).drop(true).wait_on_eos(false).build();
        let pipeline = Pipeline(gst::Pipeline::new());
        frames.clock().pipeline(&pipeline.0);
        pipeline.0.add_many([&source, sink.upcast_ref()])?;
        source.link(&sink)?;
        let mut samples = sink.stream();
        let bus = pipeline.0.bus().context("missing capture bus")?;
        let mut messages = bus.stream();
        pipeline.0.set_state(gst::State::Playing)?;
        loop {
            tokio::select! {
                biased;
                _ = control.stopped() => return Ok(()),
                _ = closed.next() => return Err(anyhow!("desktop sharing permission ended")),
                message = messages.next() => {
                    let message = message.context("capture bus closed")?;
                    if let Some(error) = message_error(&message) { return Err(error); }
                },
                sample = samples.next() => frames.publish(&sample.context("capture stream ended")?)?,
            }
        }
        // Pipeline drops to NULL before the authorized FD and session retire.
    }.await;
    let closed = session.close().await.map_err(anyhow::Error::from);
    result.and(closed)
}
