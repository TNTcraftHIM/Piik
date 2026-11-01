use super::{frames, message_error, portal, Encoding, Frames, Pipeline, RawFrame};
use crate::capture::{FrameTiming, Settings, Target, TargetKind};
use crate::input::{linux::Connection as Eis, Source as InputSource};
use anyhow::{anyhow, ensure, Context as _, Result};
use ashpd::desktop::{
    remote_desktop::{DeviceType, RemoteDesktop, SelectDevicesOptions, SelectedDevices},
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType, Stream, Streams},
    Session,
};
use futures_util::{future::AbortHandle, StreamExt};
use gst::prelude::*;
use std::{
    future::Future,
    os::fd::{AsRawFd, OwnedFd},
    pin::Pin,
    sync::Arc,
    thread,
};
use tokio::sync::{mpsc, oneshot};

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
    control: Control,
    thread: Option<thread::JoinHandle<Result<()>>>,
}

#[derive(Clone)]
pub struct Control {
    frames: frames::Control,
    requests: mpsc::Sender<Authorization>,
}
struct Authorization {
    source: InputSource,
    request: AbortHandle,
    reply: oneshot::Sender<Result<()>>,
}
impl Control {
    pub fn stop(&self) {
        self.frames.stop();
    }
    pub fn is_stopped(&self) -> bool {
        self.frames.is_stopped()
    }
    pub async fn stopped(&self) {
        self.frames.stopped().await;
    }

    pub(crate) async fn authorize(&self, source: InputSource, request: AbortHandle) -> Result<()> {
        ensure!(!self.is_stopped(), "capture stopped");
        ensure!(!request.is_aborted(), "input_authorization_cancelled");
        if source.has_endpoint() {
            return Ok(());
        }
        let (reply, completed) = oneshot::channel();
        self.requests
            .try_send(Authorization {
                source,
                request,
                reply,
            })
            .map_err(|_| anyhow!("input_authorization_unavailable"))?;
        completed
            .await
            .context("capture stopped during input authorization")?
            .map_err(|error| match error.downcast_ref::<ashpd::Error>() {
                Some(ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled)) => {
                    anyhow!("input_authorization_cancelled")
                }
                _ => error,
            })
    }
}
impl Capture {
    pub fn audio(&self, target: Target) -> Result<super::AudioCapture> {
        super::AudioCapture::start(target)
    }

    pub fn start(target: Target, fps: u32, _audio: bool) -> Result<Self> {
        ensure!(
            matches!(target.kind, TargetKind::Picker),
            "Linux capture uses the system picker"
        );
        ensure!(fps > 0 && fps <= i32::MAX as u32, "invalid capture FPS");
        let frames = Frames::new(FrameTiming::Capture)?;
        let (requests, receiver) = mpsc::channel(1);
        let control = Control {
            frames: frames.control(),
            requests,
        };
        let worker = frames.clone();
        let runtime = tokio::runtime::Handle::try_current()?;
        let thread = thread::Builder::new()
            .name("piik-linux-capture".into())
            .spawn(move || {
                let result = runtime.block_on(run(&worker, fps, receiver));
                worker.finish(result.as_ref().err().map(|e| format!("{e:#}")));
                result
            })?;
        Ok(Self {
            frames,
            control,
            thread: Some(thread),
        })
    }
    pub fn encode(&self, settings: Settings) -> Result<Encoding> {
        ensure!(!self.frames.control().is_stopped(), "capture stopped");
        Encoding::start(self.frames.clone(), settings)
    }
    pub fn control(&self) -> Control {
        self.control.clone()
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

// The session owns permission; Video owns its PipeWire FD until pipeline NULL.
enum PortalSession {
    Screen(Arc<Session<Screencast>>),
    Desktop(Arc<Session<RemoteDesktop>>),
}
impl PortalSession {
    async fn close(&self) -> Result<()> {
        match self {
            Self::Screen(session) => session.close().await?,
            Self::Desktop(session) => session.close().await?,
        }
        Ok(())
    }
    fn closed(&self) -> Pin<Box<dyn Future<Output = Result<()>>>> {
        match self {
            Self::Screen(session) => {
                let session = session.clone();
                Box::pin(async move {
                    session.receive_closed().await?.next().await;
                    Err(anyhow!("desktop sharing permission ended"))
                })
            }
            Self::Desktop(session) => {
                let session = session.clone();
                Box::pin(async move {
                    session.receive_closed().await?.next().await;
                    Err(anyhow!("desktop sharing permission ended"))
                })
            }
        }
    }
}

struct Video {
    // Field order is also the partial-initialization/drop order.
    _pipeline: Pipeline,
    samples: gst_app::app_sink::AppSinkStream,
    messages: gst::bus::BusStream,
    _fd: OwnedFd,
}
impl Video {
    fn new(frames: &Frames, fps: u32, stream: &Stream, fd: OwnedFd) -> Result<Self> {
        let source = gst::ElementFactory::make("pipewiresrc")
            .property("fd", fd.as_raw_fd())
            .property("path", stream.pipe_wire_node_id().to_string())
            .build()?;
        let caps = gst::Caps::builder("video/x-raw")
            .field("max-framerate", gst::Fraction::new(fps as i32, 1))
            .build();
        let sink = gst_app::AppSink::builder()
            .caps(&caps)
            .sync(false)
            .async_(false)
            .enable_last_sample(false)
            .max_buffers(1)
            .drop(true)
            .wait_on_eos(false)
            .build();
        let pipeline = Pipeline(gst::Pipeline::new());
        frames.clock().pipeline(&pipeline.0);
        pipeline.0.add_many([&source, sink.upcast_ref()])?;
        source.link(&sink)?;
        let samples = sink.stream();
        let messages = pipeline.0.bus().context("missing capture bus")?.stream();
        pipeline.0.set_state(gst::State::Playing)?;
        Ok(Self {
            _pipeline: pipeline,
            samples,
            messages,
            _fd: fd,
        })
    }
    async fn next(&mut self, frames: &Frames) -> Result<RawFrame> {
        loop {
            tokio::select! {
                biased;
                message = self.messages.next() => {
                    let message = message.context("capture bus closed")?;
                    if let Some(error) = message_error(&message) { return Err(error); }
                }
                sample = self.samples.next() => {
                    return frames.frame(&sample.context("capture stream ended")?);
                }
            }
        }
    }
}

struct Active {
    video: Video,
    input: Option<Eis>,
    session: PortalSession,
    closed: Pin<Box<dyn Future<Output = Result<()>>>>,
}
impl Active {
    async fn next(&mut self, frames: &Frames) -> Result<RawFrame> {
        tokio::select! {
            biased;
            result = &mut self.closed => { result?; unreachable!(); }
            raw = next_frame(&mut self.video, &mut self.input, frames) => raw,
        }
    }
    async fn close(self) -> Result<()> {
        let Self {
            video,
            input,
            session,
            closed,
        } = self;
        drop(video);
        drop(input);
        drop(closed);
        session.close().await
    }
}

async fn next_frame(
    video: &mut Video,
    input: &mut Option<Eis>,
    frames: &Frames,
) -> Result<RawFrame> {
    // ConnectToEIS requires closing its shared Portal session on disconnection.
    // Individual rejected input actions do not end this connection.
    loop {
        tokio::select! {
            biased;
            result = async { input.as_mut().unwrap().dispatch().await }, if input.is_some() => result?,
            raw = video.next(frames) => return raw,
        }
    }
}

async fn options(portal: &Screencast, remote: bool) -> Result<SelectSourcesOptions> {
    let requested = if remote {
        SourceType::Monitor.into()
    } else {
        SourceType::Monitor | SourceType::Window
    };
    let kinds = portal.available_source_types().await? & requested;
    ensure!(!kinds.is_empty(), "desktop capture unavailable");
    let cursor = if portal
        .available_cursor_modes()
        .await?
        .contains(CursorMode::Embedded)
    {
        CursorMode::Embedded
    } else {
        CursorMode::Hidden
    };
    Ok(SelectSourcesOptions::default()
        .set_sources(kinds)
        .set_multiple(false)
        .set_cursor_mode(cursor))
}

// Cancellation always unwinds through session.close(), including when the page
// drops its reply receiver. CreateSession itself is allowed to finish first.
async fn prepare(
    frames: &Frames,
    fps: u32,
    mut reply: Option<&mut oneshot::Sender<Result<()>>>,
) -> Result<Option<(Active, RawFrame)>> {
    let control = frames.control();
    if control.is_stopped() {
        return Ok(None);
    }
    let remote = reply.is_some();
    let screen = Screencast::new().await?;
    let desktop = if remote {
        Some(RemoteDesktop::new().await?)
    } else {
        None
    };
    let session = if let Some(desktop) = &desktop {
        PortalSession::Desktop(Arc::new(desktop.create_session(Default::default()).await?))
    } else {
        PortalSession::Screen(Arc::new(screen.create_session(Default::default()).await?))
    };
    let mut closed = session.closed();
    let selected = async {
        let mut cancelled = Box::pin(async {
            tokio::select! {
                biased;
                _ = control.stopped() => Ok(()),
                _ = async {
                    if let Some(reply) = &mut reply { reply.closed().await; }
                    else { std::future::pending::<()>().await; }
                } => Ok(()),
                result = &mut closed => result,
            }
        });
        let devices = DeviceType::Keyboard | DeviceType::Pointer;
        let configure = async {
            let options = options(&screen, remote).await?;
            match &session {
                PortalSession::Screen(session) => {
                    screen.select_sources(session, options).await?.response()?;
                }
                PortalSession::Desktop(session) => {
                    desktop
                        .as_ref()
                        .unwrap()
                        .select_devices(
                            session,
                            SelectDevicesOptions::default().set_devices(devices),
                        )
                        .await?
                        .response()?;
                    screen.select_sources(session, options).await?.response()?;
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        tokio::select! {
            biased;
            result = &mut cancelled => return result.map(|_| None),
            result = configure => result?,
        }

        // Start owns its pending Request until Response or explicit Close;
        // it must not be dropped by a surrounding cancellation select.
        let stream = match &session {
            PortalSession::Screen(session) => {
                let Some(response) =
                    portal::start::<Streams>(&screen, session.as_ref(), &mut cancelled).await?
                else {
                    return Ok(None);
                };
                ensure!(
                    response.streams().len() == 1,
                    "expected one selected screen or window"
                );
                response.streams()[0].clone()
            }
            PortalSession::Desktop(session) => {
                let Some(response) = portal::start::<SelectedDevices>(
                    desktop.as_ref().unwrap(),
                    session.as_ref(),
                    &mut cancelled,
                )
                .await?
                else {
                    return Ok(None);
                };
                ensure!(
                    response.devices().contains(devices),
                    "keyboard and pointer permission required"
                );
                ensure!(
                    response.streams().len() == 1,
                    "expected one selected monitor"
                );
                response.streams()[0].clone()
            }
        };
        let open = async {
            let (fd, mut input) = match &session {
                PortalSession::Screen(session) => (
                    screen
                        .open_pipe_wire_remote(session, Default::default())
                        .await?,
                    None,
                ),
                PortalSession::Desktop(session) => {
                    let fd = desktop
                        .as_ref()
                        .unwrap()
                        .connect_to_eis(session, Default::default())
                        .await?;
                    let mut input =
                        Eis::connect(fd, stream.mapping_id().map(str::to_owned)).await?;
                    input.ready().await?;
                    // The first image must follow input negotiation, not predate it.
                    let fd = screen
                        .open_pipe_wire_remote(session, Default::default())
                        .await?;
                    (fd, Some(input))
                }
            };
            let mut video = Video::new(frames, fps, &stream, fd)?;
            let first = next_frame(&mut video, &mut input, frames).await?;
            Ok::<_, anyhow::Error>((video, input, first))
        };
        tokio::select! {
            biased;
            result = &mut cancelled => result.map(|_| None),
            result = open => result.map(Some),
        }
    }
    .await;
    match selected {
        Ok(Some((video, input, first))) => Ok(Some((
            Active {
                video,
                input,
                session,
                closed,
            },
            first,
        ))),
        result => {
            // A failed/cancelled Start may already have closed its Session.
            // Cleanup must not replace the interaction's original result.
            result.and(session.close().await.map(|_| None))
        }
    }
}

async fn authorize(
    active: &mut Active,
    frames: &Frames,
    fps: u32,
    mut request: Authorization,
) -> Result<()> {
    if request.reply.is_closed() {
        return Ok(());
    }
    if request.source.has_endpoint() {
        let _ = request.reply.send(Ok(()));
        return Ok(());
    }
    let control = frames.control();
    let candidate = {
        let preparing = prepare(frames, fps, Some(&mut request.reply));
        tokio::pin!(preparing);
        loop {
            tokio::select! {
                biased;
                candidate = &mut preparing => break candidate,
                raw = active.next(frames) => match raw {
                    Ok(raw) => frames.publish_frame(raw),
                    Err(error) => {
                        control.stop();
                        // Do not drop preparation: it must close any created session.
                        if let Ok(Some((candidate, _))) = preparing.await { candidate.close().await?; }
                        return Err(error);
                    }
                }
            }
        }
    };
    let (candidate, raw) = match candidate {
        Ok(Some(candidate)) => candidate,
        result => {
            let _ = request
                .reply
                .send(result.and_then(|_| Err(anyhow!("input_authorization_cancelled"))));
            return Ok(());
        }
    };
    if request.reply.is_closed() || control.is_stopped() {
        candidate.close().await?;
        return Ok(());
    }
    let committed = frames.present_now(raw).and_then(|raw| {
        request.source.bind_endpoint(
            candidate.input.as_ref().unwrap().endpoint(),
            &request.request,
        )?;
        Ok(raw)
    });
    let raw = match committed {
        Ok(raw) => raw,
        Err(error) => {
            candidate.close().await?;
            let _ = request.reply.send(Err(error));
            return Ok(());
        }
    };
    // No await between binding input authority and committing the new media.
    let previous = std::mem::replace(active, candidate);
    frames.publish_frame(raw);
    if let Err(error) = previous.close().await {
        eprintln!("Previous Linux capture cleanup: {error:#}");
    }
    let _ = request.reply.send(Ok(()));
    Ok(())
}

async fn run(frames: &Frames, fps: u32, mut requests: mpsc::Receiver<Authorization>) -> Result<()> {
    let Some((mut active, first)) = prepare(frames, fps, None).await? else {
        return Ok(());
    };
    frames.publish_frame(first);
    let control = frames.control();
    let result = async {
        loop {
            tokio::select! {
                biased;
                _ = control.stopped() => return Ok(()),
                request = requests.recv() => match request {
                    Some(request) => authorize(&mut active, frames, fps, request).await?,
                    None => return Ok(()),
                },
                raw = active.next(frames) => frames.publish_frame(raw?),
            }
        }
    }
    .await;
    let closed = active.close().await;
    result.and(closed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires a running desktop Portal and attended source selection"]
    async fn portal_capture_and_pending_authorization_have_separate_lifetimes() -> Result<()> {
        let target = tokio::task::spawn_blocking(targets)
            .await??
            .into_iter()
            .next()
            .context("no system picker")?;
        let capture = Capture::start(target.clone(), 30, false)?;
        eprintln!("Portal check: select a source for the first capture");
        let frame = tokio::time::timeout(Duration::from_secs(90), capture.frames.recv_after(None))
            .await??
            .context("capture ended before its first image")?;
        ensure!(
            frame.info.width() > 0 && frame.info.height() > 0,
            "empty source geometry"
        );
        ensure!(
            frame.buffer.size() >= frame.info.size(),
            "incomplete source image"
        );
        ensure!(
            Instant::now().saturating_duration_since(frame.time) < Duration::from_secs(5),
            "source PTS left the system-time domain"
        );
        eprintln!(
            "Portal check: received {}x{}; the control permission request will be cancelled",
            frame.info.width(),
            frame.info.height()
        );

        let desktop = crate::input::Desktop::new()?;
        let (source, _replies, _state) =
            desktop.source(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), target)?;
        {
            let control = capture.control();
            let (request, _registration) = AbortHandle::new_pair();
            let pending = control.authorize(source.clone(), request);
            tokio::pin!(pending);
            tokio::select! {
                result = &mut pending => { result?; anyhow::bail!("control permission was unexpectedly approved"); }
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            }
        }
        ensure!(
            !source.has_endpoint(),
            "cancelled permission installed an input endpoint"
        );
        // Give cancellation time to reach the Portal, then require a new image
        // from the original stream rather than merely checking its local handle.
        let after_cancel = Instant::now() + Duration::from_secs(1);
        eprintln!("Portal check: animate the selected source after cancellation");
        tokio::time::timeout(
            Duration::from_secs(10),
            capture.frames.recv_after(Some(after_cancel)),
        )
        .await
        .context("existing capture stopped producing images after cancellation")??
        .context("cancelling control permission ended the existing capture")?;
        source.close();
        eprintln!("Portal check: control permission cancelled; stopping the capture");
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::task::spawn_blocking(move || capture.stop()),
        )
        .await???;
        ensure!(
            !Screencast::new()
                .await?
                .available_source_types()
                .await?
                .is_empty(),
            "Portal lost capture capabilities after cancellation"
        );
        Ok(())
    }
}
