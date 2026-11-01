//! One Encoding owns one child and its AU slot. WGC remains in the parent.
use super::{
    frames::RawFrame,
    gpu,
    worker::{self, Command, Reply},
    CaptureClock, FrameTiming, Settings,
};
use crate::EncodedFrame;
use anyhow::{anyhow, ensure, Context, Result};
use std::{
    process::Stdio,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{watch, Notify},
};
use windows::core::HRESULT;
#[derive(Default)]
struct State {
    done: bool,
    latest: Option<RawFrame>,
    credit: Option<Option<i64>>,
    read: bool,
    read_sent: bool,
    frame: Option<EncodedFrame>,
    bitrate: Option<u32>,
    keyframe: bool,
    restart: Option<HRESULT>,
    independent: bool,
    last_qpc: Option<i64>,
}
impl State {
    fn begin_child(&mut self) {
        self.credit = None;
        self.read_sent = false;
        self.frame = None;
        self.independent = false;
        self.keyframe = true;
        self.restart = None;
    }
}
pub(super) struct Shared {
    state: Mutex<State>,
    changed: Notify,
    available: Notify,
    stop: watch::Sender<Option<Result<(), String>>>,
}
impl Shared {
    pub fn device_lost(&self, reason: HRESULT) {
        let mut s = self.state.lock().unwrap();
        s.restart = Some(reason);
        s.latest = None;
        s.frame = None;
        drop(s);
        self.changed.notify_one();
    }
    pub fn input(&self, frame: RawFrame) -> bool {
        let mut s = self.state.lock().unwrap();
        if self.stopped() {
            return false;
        }
        s.latest = Some(frame);
        drop(s);
        self.changed.notify_one();
        true
    }
    pub fn stop(&self, error: Option<&str>) {
        let mut s = self.state.lock().unwrap();
        self.stop.send_if_modified(|terminal| {
            if terminal.is_none() || (matches!(terminal, Some(Ok(()))) && error.is_some()) {
                *terminal = Some(error.map_or(Ok(()), |e| Err(e.to_owned())));
                true
            } else {
                false
            }
        });
        s.latest = None;
        s.frame = None;
        drop(s);
        self.changed.notify_one();
        self.available.notify_waiters();
    }
    fn finish(&self, result: &Result<()>) {
        self.stop(result.as_ref().err().map(|e| format!("{e:#}")).as_deref());
        self.state.lock().unwrap().done = true;
        self.available.notify_waiters();
    }
    pub(super) fn stopped(&self) -> bool {
        self.stop.borrow().is_some()
    }
    fn output(&self, qpc: i64, frame: EncodedFrame) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        if self.stopped() || s.restart.is_some() {
            return Ok(());
        }
        ensure!(
            s.read && s.read_sent && s.frame.is_none(),
            "unsolicited encoding AU"
        );
        // A new child shares the logical feed's clock and consumers, so its
        // first AU must be independently decodable and newer than the old child.
        if !s.independent && (!frame.keyframe || s.last_qpc.is_some_and(|last| qpc <= last)) {
            s.read_sent = false;
            s.keyframe = true;
            drop(s);
            self.changed.notify_one();
            return Ok(());
        }
        s.independent = true;
        s.last_qpc = Some(qpc);
        s.frame = Some(frame);
        drop(s);
        self.available.notify_one();
        Ok(())
    }
}
#[derive(Clone)]
pub struct EncodingControl(Arc<Shared>);
impl EncodingControl {
    pub fn is_stopped(&self) -> bool {
        self.0.stopped()
    }
    pub fn stop(&self) {
        self.0.stop(None)
    }
    pub fn force_keyframe(&self) -> Result<()> {
        let mut s = self.0.state.lock().unwrap();
        ensure!(!self.0.stopped(), "encoding stopped");
        s.keyframe = true;
        drop(s);
        self.0.changed.notify_one();
        Ok(())
    }
    pub fn set_bitrate(&self, bitrate: u32) -> Result<()> {
        ensure!(bitrate > 0, "bitrate must be positive");
        let mut s = self.0.state.lock().unwrap();
        ensure!(!self.0.stopped(), "encoding stopped");
        s.bitrate = Some(bitrate);
        drop(s);
        self.0.changed.notify_one();
        Ok(())
    }
}
pub struct Encoding {
    pub(super) shared: Arc<Shared>,
    thread: Option<thread::JoinHandle<Result<()>>>,
    error_reported: bool,
}
impl Encoding {
    pub(super) fn start(
        settings: Settings,
        clock: CaptureClock,
        timing: FrameTiming,
        latest: Option<RawFrame>,
    ) -> Result<Self> {
        let (stop, stopped) = watch::channel(None);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                latest,
                ..State::default()
            }),
            changed: Notify::new(),
            available: Notify::new(),
            stop,
        });
        let worker = shared.clone();
        let thread = thread::Builder::new()
            .name("piik-encoding-process".into())
            .spawn(move || {
                let result = (|| {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;
                    rt.block_on(supervise(worker.clone(), stopped, clock, timing, settings))
                })();
                worker.finish(&result);
                result
            })?;
        Ok(Self {
            shared,
            thread: Some(thread),
            error_reported: false,
        })
    }
    pub fn control(&self) -> EncodingControl {
        EncodingControl(self.shared.clone())
    }
    pub async fn recv(&mut self) -> Option<Result<EncodedFrame>> {
        loop {
            let notify = self.shared.available.notified();
            tokio::pin!(notify);
            notify.as_mut().enable();
            {
                let mut s = self.shared.state.lock().unwrap();
                if let Some(frame) = s.frame.take() {
                    s.read = false;
                    s.read_sent = false;
                    return Some(Ok(frame));
                }
                if s.done {
                    if self.error_reported {
                        return None;
                    }
                    self.error_reported = true;
                    return match &*self.shared.stop.borrow() {
                        Some(Err(e)) => Some(Err(anyhow!(e.clone()))),
                        _ => None,
                    };
                }
                if !self.shared.stopped() && !s.read {
                    s.read = true;
                    self.shared.changed.notify_one();
                }
            }
            notify.await;
        }
    }
    pub fn stop(mut self) -> Result<()> {
        self.shared.stop(None);
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow!("encoding supervisor panicked"))?
    }
}
impl Drop for Encoding {
    fn drop(&mut self) {
        self.shared.stop(None);
        if let Some(thread) = self.thread.take() {
            match thread.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => eprintln!("Native encoding cleanup failed: {e:#}"),
                Err(_) => eprintln!("Native encoding supervisor panicked"),
            }
        }
    }
}
enum Work {
    Stop,
    Restart(HRESULT),
    Command(Command),
    Frame(RawFrame),
    Wait,
}
async fn supervise(
    shared: Arc<Shared>,
    stopped: watch::Receiver<Option<Result<(), String>>>,
    clock: CaptureClock,
    timing: FrameTiming,
    settings: Settings,
) -> Result<()> {
    let mut recovering = None;
    loop {
        if shared.stopped() {
            return Ok(());
        }
        shared.state.lock().unwrap().begin_child();
        let result = child(shared.clone(), stopped.clone(), clock, timing, settings).await;
        if shared.stopped() {
            return result;
        }
        if shared.state.lock().unwrap().independent {
            recovering = None;
        }
        match result {
            Err(error) if recovering.is_none() && gpu::device_lost(&error).is_some() => {
                recovering = Some(error);
                // A removed source device cannot provide another valid texture.
                // A child-only loss can reuse the healthy source's latest frame.
                let mut s = shared.state.lock().unwrap();
                if s.latest.as_ref().is_some_and(|raw| unsafe {
                    raw.texture
                        .GetDevice()
                        .and_then(|device| device.GetDeviceRemovedReason())
                        .is_err()
                }) {
                    s.latest = None;
                }
            }
            Err(error) => return Err(recovering.unwrap_or(error)),
            Ok(()) => return Ok(()),
        }
        loop {
            let changed = shared.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if shared.stopped() {
                return Ok(());
            }
            if shared.state.lock().unwrap().latest.is_some() {
                break;
            }
            changed.await;
        }
    }
}

async fn child(
    shared: Arc<Shared>,
    mut stopped: watch::Receiver<Option<Result<(), String>>>,
    clock: CaptureClock,
    timing: FrameTiming,
    mut settings: Settings,
) -> Result<()> {
    let job = super::job::Job::new()?;
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .arg(worker::ARG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .spawn()?;
    if let Err(error) = job.assign(
        child
            .raw_handle()
            .context("missing encoding process handle")?,
    ) {
        child.start_kill()?;
        child.wait().await?;
        return Err(error);
    }
    let process = child.raw_handle().unwrap() as usize;
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let writer_shared = shared.clone();
    let mut writer = tokio::spawn(async move {
        let result = async {
            settings.bitrate = writer_shared
                .state
                .lock()
                .unwrap()
                .bitrate
                .unwrap_or(settings.bitrate);
            worker::write_json(&mut input, &Command::Start { settings, timing }).await?;
            loop {
                let changed = writer_shared.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let work = {
                    let mut s = writer_shared.state.lock().unwrap();
                    if writer_shared.stopped() {
                        Work::Stop
                    } else if let Some(reason) = s.restart.take() {
                        Work::Restart(reason)
                    } else if let Some(bitrate) = s.bitrate.filter(|b| *b != settings.bitrate) {
                        settings.bitrate = bitrate;
                        Work::Command(Command::Bitrate { bitrate })
                    } else if std::mem::take(&mut s.keyframe) {
                        Work::Command(Command::Keyframe)
                    } else if s.read && !s.read_sent {
                        s.read_sent = true;
                        Work::Command(Command::Read)
                    } else if let Some(after) = s.credit {
                        if let Some(raw) = s
                            .latest
                            .as_ref()
                            .filter(|raw| after.is_none_or(|after| raw.qpc > after))
                            .cloned()
                        {
                            s.credit = None;
                            Work::Frame(raw)
                        } else {
                            Work::Wait
                        }
                    } else {
                        Work::Wait
                    }
                };
                match work {
                    Work::Stop => {
                        worker::write_json(&mut input, &Command::Stop).await?;
                        input.shutdown().await?;
                        break;
                    }
                    Work::Restart(reason) => {
                        return Err(windows::core::Error::from_hresult(reason).into())
                    }
                    Work::Command(command) => worker::write_json(&mut input, &command).await?,
                    Work::Frame(raw) => {
                        let device = unsafe { raw.texture.GetDevice()? };
                        let frame = gpu::send(raw, process as _)
                            .map_err(|error| gpu::failure(error, &device))?;
                        worker::write_json(&mut input, &Command::Frame { frame }).await?;
                    }
                    Work::Wait => {
                        changed.await;
                        continue;
                    }
                }
                input.flush().await?;
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        result.context("encoding write")
    });
    let reader_shared = shared.clone();
    let mut reader = tokio::spawn(async move {
        let result = async {
            loop {
                match worker::read_json(&mut output).await? {
                    Reply::NeedFrame { after } => {
                        let mut s = reader_shared.state.lock().unwrap();
                        ensure!(s.credit.is_none(), "duplicate raw credit");
                        s.credit = Some(after);
                        drop(s);
                        reader_shared.changed.notify_one();
                    }
                    Reply::Au {
                        qpc,
                        keyframe,
                        length,
                    } => {
                        ensure!(length <= worker::MAX_AU, "encoding IPC AU too large");
                        let mut bytes = vec![0; length];
                        output.read_exact(&mut bytes).await?;
                        reader_shared.output(
                            qpc,
                            EncodedFrame {
                                vp8: None,
                                bytes,
                                presentation_time: clock.instant(qpc),
                                keyframe,
                            },
                        )?;
                    }
                    Reply::EncodingEnded {
                        error,
                        device_removed,
                    } => {
                        return error.map_or(Ok(()), |error| {
                            Err(match device_removed {
                                Some(code) => anyhow::Error::from(
                                    windows::core::Error::from_hresult(HRESULT(code)),
                                )
                                .context(error),
                                None => anyhow!(error),
                            })
                        });
                    }
                }
            }
        }
        .await;
        result.context("encoding read")
    });
    let (write, read, status) = tokio::select! {
        write = &mut writer => (Some(write), None, None),
        read = &mut reader => (None, Some(read), None),
        status = child.wait() => (None, None, Some(status)),
        _ = stopped.changed() => (None, None, None),
    };
    // Dropping the only stdin writer asks the child to stop. Keep draining its
    // terminal reply while the existing bounded process shutdown joins it.
    if write.is_none() {
        writer.abort();
        let _ = writer.await;
    }
    let status = match status {
        Some(status) => status,
        None => match tokio::time::timeout(Duration::from_secs(1), child.wait()).await {
            Ok(status) => status,
            Err(_) => {
                child.start_kill()?;
                child.wait().await
            }
        },
    }?;
    let read = match read {
        Some(read) => read,
        None => reader.await,
    }
    .context("encoding reader panicked")?;
    let write = write.map_or(Ok(()), |write| write.context("encoding writer panicked")?);
    let result = match (write, read) {
        (Err(write), Err(read)) if gpu::device_lost(&read).is_none() => Err(write),
        (write, read) => read.and(write),
    };
    result.with_context(|| format!("encoding process exited {status}"))?;
    ensure!(status.success(), "encoding process exited {status}");
    if let Some(Err(error)) = &*shared.stop.borrow() {
        return Err(anyhow!(error.clone()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::Poll;
    fn proxy() -> Encoding {
        let (stop, _) = watch::channel(None);
        Encoding {
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                changed: Notify::new(),
                available: Notify::new(),
                stop,
            }),
            thread: None,
            error_reported: false,
        }
    }
    #[tokio::test]
    async fn cancelled_recv_retains_the_same_reply_and_one_read() {
        let mut encoding = proxy();
        let shared = encoding.shared.clone();
        let mut pending = Box::pin(encoding.recv());
        assert!(matches!(futures_util::poll!(&mut pending), Poll::Pending));
        drop(pending);
        {
            let mut state = shared.state.lock().unwrap();
            assert!(state.read);
            assert!(!state.read_sent);
            state.read_sent = true;
        }
        let mut pending = Box::pin(encoding.recv());
        assert!(matches!(futures_util::poll!(&mut pending), Poll::Pending));
        assert!(shared.state.lock().unwrap().read_sent);
        let pts = std::time::Instant::now();
        shared.state.lock().unwrap().frame = Some(EncodedFrame {
            vp8: None,
            bytes: vec![1, 2, 3],
            presentation_time: pts,
            keyframe: true,
        });
        shared.available.notify_one();
        let frame = pending.await.unwrap().unwrap();
        assert_eq!(frame.bytes, [1, 2, 3]);
        assert_eq!(frame.presentation_time, pts);
        assert!(!shared.state.lock().unwrap().read);
    }
    #[test]
    fn clock_roundtrip_retains_raw_qpc_to_100ns() {
        let clock = CaptureClock::new().unwrap();
        for delta in [-10_000_001, -1, 0, 1, 10_000_001] {
            let qpc = clock.qpc + delta;
            assert_eq!(clock.presentation_qpc(clock.instant(qpc)), qpc);
        }
    }
    #[tokio::test]
    async fn child_replacement_retains_demand_clock_and_requires_a_fresh_independent_au() {
        let mut encoding = proxy();
        let clock = CaptureClock::new().unwrap();
        encoding.control().set_bitrate(600_000).unwrap();
        let deliver = |qpc, keyframe| {
            encoding.shared.state.lock().unwrap().read_sent = true;
            encoding
                .shared
                .output(
                    qpc,
                    EncodedFrame {
                        vp8: None,
                        bytes: vec![u8::from(keyframe)],
                        presentation_time: clock.instant(qpc),
                        keyframe,
                    },
                )
                .unwrap();
        };
        encoding.shared.state.lock().unwrap().read = true;
        deliver(clock.qpc, true);
        let first = encoding.shared.state.lock().unwrap().frame.take().unwrap();
        assert_eq!(first.presentation_time, clock.instant(clock.qpc));

        encoding.shared.state.lock().unwrap().begin_child();
        for (qpc, keyframe) in [(clock.qpc, true), (clock.qpc + 1, false)] {
            deliver(qpc, keyframe);
            let state = encoding.shared.state.lock().unwrap();
            assert!(state.frame.is_none());
            assert!(state.read && !state.read_sent && state.keyframe);
        }
        deliver(clock.qpc + 2, true);
        let frame = encoding.recv().await.unwrap().unwrap();
        assert!(frame.keyframe);
        assert_eq!(frame.presentation_time, clock.instant(clock.qpc + 2));
        let state = encoding.shared.state.lock().unwrap();
        assert_eq!(state.bitrate, Some(600_000));
        assert_eq!(state.last_qpc, Some(clock.qpc + 2));
        assert!(!state.read);
    }
    #[test]
    fn final_child_error_refines_requested_stop() {
        let encoding = proxy();
        encoding.shared.stop(None);
        encoding.shared.stop(Some("child failed"));
        encoding.shared.stop(Some("generic later failure"));
        encoding.shared.stop(None);
        assert_eq!(
            *encoding.shared.stop.borrow(),
            Some(Err("child failed".into()))
        );
    }
    #[tokio::test]
    async fn encoding_stop_retains_failure_after_one_recv_error() {
        let mut encoding = proxy();
        encoding.control().stop();
        encoding.shared.finish(&Err(anyhow!("worker failed")));
        assert_eq!(
            encoding.recv().await.unwrap().unwrap_err().to_string(),
            "worker failed"
        );
        assert!(encoding.recv().await.is_none());
        encoding.thread = Some(thread::spawn(|| Err(anyhow!("worker failed"))));
        assert_eq!(encoding.stop().unwrap_err().to_string(), "worker failed");
    }
}
