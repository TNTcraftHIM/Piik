//! A source owns one child. Per-encoding pull slots preserve cancellation and
//! backpressure without making one slow consumer hold the shared IPC reader.
use super::{
    worker::{self, Command, Reply},
    CaptureClock, EncodedFrame, Settings, Target,
};
use anyhow::{anyhow, ensure, Context, Result};
use std::{
    collections::{HashMap, VecDeque},
    process::Stdio,
    sync::{Arc, Condvar, Mutex, Weak},
    thread,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{watch, Notify},
};
use uuid::Uuid;

struct Shared {
    commands: Mutex<VecDeque<Command>>,
    changed: Notify,
    // One typed source termination fact; errors can refine an intentional stop.
    stop: watch::Sender<Option<Result<(), String>>>,
    encodings: Mutex<HashMap<Uuid, Weak<Slot>>>,
}
impl Shared {
    fn stopped(&self) -> bool {
        self.stop.borrow().is_some()
    }
    fn stop(&self, error: Option<String>) {
        let result = error.map_or(Ok(()), Err);
        self.stop.send_if_modified(|stopped| {
            if stopped.is_none() || matches!((&stopped, &result), (Some(Ok(())), Err(_))) {
                *stopped = Some(result);
                true
            } else {
                false
            }
        });
    }
    fn send(&self, command: Command) -> Result<()> {
        ensure!(!self.stopped(), "capture process stopped");
        let mut commands = self.commands.lock().unwrap();
        // These are latest control values, matching the existing encoder owner,
        // not an unbounded sequence of bitrate/keyframe operations. Reads and
        // Add/Remove remain one operation per actual encoding resource.
        match &command {
            Command::Bitrate { id, bitrate } => {
                for pending in commands.iter_mut() {
                    if let Command::Bitrate {
                        id: other,
                        bitrate: value,
                    } = pending
                    {
                        if other == id {
                            *value = *bitrate;
                            return Ok(());
                        }
                    }
                }
            }
            Command::Keyframe { id }
                if commands.iter().any(
                    |pending| matches!(pending, Command::Keyframe { id: other } if other == id),
                ) =>
            {
                return Ok(())
            }
            _ => {}
        }
        commands.push_back(command);
        drop(commands);
        self.changed.notify_one();
        Ok(())
    }
    fn slot(&self, id: Uuid) -> Option<Arc<Slot>> {
        self.encodings
            .lock()
            .unwrap()
            .get(&id)
            .and_then(Weak::upgrade)
    }
    fn finished(&self, error: Option<String>) {
        self.stop(error.clone());
        self.commands.lock().unwrap().clear();
        for slot in self
            .encodings
            .lock()
            .unwrap()
            .values()
            .filter_map(Weak::upgrade)
        {
            slot.finish(error.clone());
        }
    }
}
#[derive(Clone)]
pub struct Control(Arc<Shared>);
impl Control {
    pub fn is_stopped(&self) -> bool {
        self.0.stopped()
    }
    pub fn stop(&self) {
        self.0.stop(None);
    }
    pub async fn stopped(&self) {
        let mut stopped = self.0.stop.subscribe();
        while stopped.borrow().is_none() {
            if stopped.changed().await.is_err() {
                break;
            }
        }
    }
}
pub struct Capture {
    shared: Arc<Shared>,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Capture {
    pub fn start(target: Target, fps: u32) -> Result<Self> {
        ensure!(fps > 0, "capture fps must be positive");
        let clock = CaptureClock::new()?;
        let (stop, stopped) = watch::channel(None);
        let shared = Arc::new(Shared {
            commands: Mutex::new(VecDeque::new()),
            changed: Notify::new(),
            stop,
            encodings: Mutex::new(HashMap::new()),
        });
        let source = shared.clone();
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("piik-capture-process".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                let result = runtime.block_on(supervise(source.clone(), stopped, clock, ready));
                source.finished(result.as_ref().err().map(|error| format!("{error:#}")));
                result
            })?;
        match started.recv() {
            Ok(Ok(())) => {}
            result => {
                let _ = thread.join();
                return Err(anyhow!("capture child startup failed: {result:?}"));
            }
        }
        let capture = Self {
            shared,
            thread: Some(thread),
        };
        capture.shared.send(Command::Start { target, fps })?;
        Ok(capture)
    }
    pub fn encode(&self, settings: Settings) -> Result<Encoding> {
        settings.validate()?;
        let id = Uuid::new_v4();
        let slot = Arc::new(Slot {
            id,
            state: Mutex::new(SlotState::default()),
            available: Notify::new(),
            joined: Condvar::new(),
            source: Arc::downgrade(&self.shared),
        });
        self.shared
            .encodings
            .lock()
            .unwrap()
            .insert(id, Arc::downgrade(&slot));
        self.shared.send(Command::Add { id, settings })?;
        Ok(Encoding {
            slot,
            error_reported: false,
        })
    }
    pub fn control(&self) -> Control {
        Control(self.shared.clone())
    }
    pub fn stop(mut self) -> Result<()> {
        self.shared.stop(None);
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow!("capture process supervisor panicked"))?
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.shared.stop(None);
        // The same owner joins on every path. There is no detached JoinHandle;
        // cooperative close gets one second, then supervisor kills and reaps.
        if let Some(thread) = self.thread.take() {
            match thread.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("Native capture process cleanup failed: {error:#}"),
                Err(_) => eprintln!("Native capture process supervisor panicked"),
            }
        }
    }
}

#[derive(Default)]
struct SlotState {
    stopping: bool,
    done: bool,
    read: bool,
    frame: Option<EncodedFrame>,
    error: Option<String>,
}
struct Slot {
    id: Uuid,
    state: Mutex<SlotState>,
    available: Notify,
    joined: Condvar,
    source: Weak<Shared>,
}
impl Slot {
    fn finish(&self, error: Option<String>) {
        let mut state = self.state.lock().unwrap();
        if state.done {
            return;
        }
        state.error = error;
        state.done = true;
        state.frame = None;
        state.read = false;
        drop(state);
        self.available.notify_waiters();
        self.joined.notify_all();
    }
    fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        if state.stopping || state.done {
            return;
        }
        state.stopping = true;
        state.frame = None;
        drop(state);
        if let Some(source) = self.source.upgrade() {
            // Source stop already owns all joins; do not enqueue after its stop.
            if !source.stopped() {
                let _ = source.send(Command::Remove { id: self.id });
            }
        } else {
            self.finish(None);
        }
    }
}
#[derive(Clone)]
pub struct EncodingControl(Arc<Slot>);
impl EncodingControl {
    pub fn is_stopped(&self) -> bool {
        let state = self.0.state.lock().unwrap();
        state.stopping
            || state.done
            || self
                .0
                .source
                .upgrade()
                .is_none_or(|source| source.stopped())
    }
    pub fn stop(&self) {
        self.0.stop();
    }
    pub fn force_keyframe(&self) -> Result<()> {
        ensure!(!self.is_stopped(), "encoding stopped");
        self.0
            .source
            .upgrade()
            .context("capture stopped")?
            .send(Command::Keyframe { id: self.0.id })
    }
    pub fn set_bitrate(&self, bitrate: u32) -> Result<()> {
        ensure!(bitrate > 0, "bitrate must be positive");
        ensure!(!self.is_stopped(), "encoding stopped");
        self.0
            .source
            .upgrade()
            .context("capture stopped")?
            .send(Command::Bitrate {
                id: self.0.id,
                bitrate,
            })
    }
}
pub struct Encoding {
    slot: Arc<Slot>,
    error_reported: bool,
}
impl Encoding {
    pub fn control(&self) -> EncodingControl {
        EncodingControl(self.slot.clone())
    }
    pub async fn recv(&mut self) -> Option<Result<EncodedFrame>> {
        loop {
            let available = self.slot.available.notified();
            tokio::pin!(available);
            available.as_mut().enable();
            {
                let mut state = self.slot.state.lock().unwrap();
                if let Some(frame) = state.frame.take() {
                    state.read = false;
                    return Some(Ok(frame));
                }
                if state.done {
                    if self.error_reported {
                        return None;
                    }
                    self.error_reported = true;
                    return state
                        .error
                        .as_ref()
                        .map(|error| Err(anyhow!(error.clone())));
                }
                if !state.read && !state.stopping {
                    let Some(source) = self.slot.source.upgrade() else {
                        return None;
                    };
                    if let Err(error) = source.send(Command::Read { id: self.slot.id }) {
                        return Some(Err(error));
                    }
                    state.read = true;
                }
            }
            // Canceling this future retains the exact outstanding Read and any
            // arriving AU in Slot; only consuming it permits the next Read.
            available.await;
        }
    }
    pub fn stop(self) -> Result<()> {
        self.slot.stop();
        let state = self.slot.state.lock().unwrap();
        let state = self
            .slot
            .joined
            .wait_while(state, |state| !state.done)
            .unwrap();
        if let Some(error) = &state.error {
            return Err(anyhow!(error.clone()));
        }
        Ok(())
    }
}
impl Drop for Encoding {
    fn drop(&mut self) {
        self.slot.stop();
        if let Some(source) = self.slot.source.upgrade() {
            source.encodings.lock().unwrap().remove(&self.slot.id);
        }
    }
}

async fn supervise(
    shared: Arc<Shared>,
    mut stopped: watch::Receiver<Option<Result<(), String>>>,
    clock: CaptureClock,
    ready: std::sync::mpsc::SyncSender<Result<(), String>>,
) -> Result<()> {
    let job = super::job::Job::new()?;
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    command
        .arg(worker::ARG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    command.creation_flags(0x0800_0000); // Hidden worker, never a second App UI.
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return Err(error.into());
        }
    };
    // Child cannot initialize capture before parent sends Start, which happens
    // only after this assignment and startup acknowledgement.
    if let Err(error) = job.assign(
        child
            .raw_handle()
            .context("missing capture process handle")?,
    ) {
        child.start_kill()?;
        child.wait().await?;
        let _ = ready.send(Err(error.to_string()));
        return Err(error);
    }
    let _ = ready.send(Ok(()));
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let writer_source = shared.clone();
    let mut writer_stop = stopped.clone();
    let writer = tokio::spawn(async move {
        let result = async {
            loop {
                let changed = writer_source.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if writer_source.stopped() {
                    worker::write_json(&mut input, &Command::Stop).await?;
                    input.shutdown().await?;
                    break;
                }
                let command = writer_source.commands.lock().unwrap().pop_front();
                if let Some(command) = command {
                    worker::write_json(&mut input, &command).await?;
                    input.flush().await?;
                    continue;
                }
                tokio::select! {
                    biased;
                    _ = writer_stop.changed() => {},
                    _ = changed => {},
                }
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = &result {
            if !writer_source.stopped() {
                writer_source.stop(Some(format!("capture process write failed: {error:#}")));
            }
        }
        result
    });
    let reader_source = shared.clone();
    let reader = tokio::spawn(async move {
        let result = async {
            loop {
                match worker::read_json(&mut output).await? {
                    Reply::Au {
                        id,
                        qpc,
                        keyframe,
                        length,
                    } => {
                        ensure!(length <= worker::MAX_AU, "capture IPC AU too large");
                        let mut bytes = vec![0; length];
                        output.read_exact(&mut bytes).await?;
                        if let Some(slot) = reader_source.slot(id) {
                            let mut state = slot.state.lock().unwrap();
                            if !state.stopping && !state.done {
                                ensure!(
                                    state.read && state.frame.is_none(),
                                    "unsolicited capture AU"
                                );
                                state.frame = Some(EncodedFrame {
                                    bytes,
                                    presentation_time: clock.instant(qpc),
                                    keyframe,
                                });
                                drop(state);
                                slot.available.notify_one();
                            }
                        }
                    }
                    Reply::EncodingEnded { id, error } => {
                        if let Some(slot) = reader_source.slot(id) {
                            slot.finish(error);
                        }
                    }
                    Reply::CaptureEnded { error } => {
                        reader_source.stop(error.clone());
                        return error.map_or(Ok(()), |error| Err(anyhow!(error)));
                    }
                }
            }
        }
        .await;
        if let Err(error) = &result {
            reader_source.stop(Some(format!("capture process read failed: {error:#}")));
        }
        result
    });
    let status = tokio::select! {
        status = child.wait() => status,
        _ = stopped.changed() => {
            match tokio::time::timeout(Duration::from_secs(1), child.wait()).await {
                Ok(status) => status,
                Err(_) => { child.start_kill()?; child.wait().await }
            }
        }
    }?;
    // Reaped child implies stdout will reach EOF. Drain its final result before
    // deciding success; child.wait can win while CaptureEnded is still buffered.
    writer.abort();
    let _ = writer.await;
    let read = reader.await.context("capture process reader panicked")?;
    shared.stop(None);
    ensure!(status.success(), "capture process exited {status}");
    read?;
    if let Some(Err(error)) = stopped.borrow().as_ref() {
        return Err(anyhow!(error.clone()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::Poll;
    #[tokio::test]
    async fn cancelled_recv_retains_the_same_reply_and_one_read() {
        let (stop, _) = watch::channel(None);
        let source = Arc::new(Shared {
            commands: Mutex::new(VecDeque::new()),
            changed: Notify::new(),
            stop,
            encodings: Mutex::new(HashMap::new()),
        });
        let id = Uuid::new_v4();
        let slot = Arc::new(Slot {
            id,
            state: Mutex::new(SlotState::default()),
            available: Notify::new(),
            joined: Condvar::new(),
            source: Arc::downgrade(&source),
        });
        let mut encoding = Encoding {
            slot: slot.clone(),
            error_reported: false,
        };
        let mut waiting = Box::pin(encoding.recv());
        assert!(matches!(futures_util::poll!(&mut waiting), Poll::Pending));
        assert!(
            matches!(source.commands.lock().unwrap().pop_front(), Some(Command::Read { id: sent }) if sent == id)
        );
        drop(waiting);
        let mut resumed = Box::pin(encoding.recv());
        assert!(matches!(futures_util::poll!(&mut resumed), Poll::Pending));
        assert!(
            source.commands.lock().unwrap().is_empty(),
            "cancelled recv must not send another Read"
        );
        let pts = std::time::Instant::now();
        // Substitute only the external IPC arrival; recv/cancellation remains
        // the actual proxy implementation and its original per-encoding slot.
        slot.state.lock().unwrap().frame = Some(EncodedFrame {
            bytes: vec![1, 2, 3],
            presentation_time: pts,
            keyframe: true,
        });
        slot.available.notify_one();
        let frame = resumed.await.unwrap().unwrap();
        assert_eq!(frame.presentation_time, pts);
        assert_eq!(frame.bytes, [1, 2, 3]);
        assert!(source.commands.lock().unwrap().is_empty());
    }
    #[test]
    fn clock_roundtrip_retains_raw_qpc_to_100ns() {
        let clock = CaptureClock::new().unwrap();
        for delta in [-10_000_001, -1, 0, 1, 10_000_001] {
            let qpc = clock.qpc + delta;
            assert_eq!(clock.presentation_qpc(clock.instant(qpc)), qpc);
        }
    }
    #[test]
    fn final_child_error_refines_requested_stop() {
        let (stop, _) = watch::channel(None);
        let source = Shared {
            commands: Mutex::new(VecDeque::new()),
            changed: Notify::new(),
            stop,
            encodings: Mutex::new(HashMap::new()),
        };
        source.stop(None);
        source.stop(Some("child shutdown failed".into()));
        source.stop(None);
        assert_eq!(
            *source.stop.borrow(),
            Some(Err("child shutdown failed".into()))
        );
    }
    #[tokio::test]
    async fn encoding_stop_retains_real_failure_after_one_recv_error() {
        let (stop, _) = watch::channel(None);
        let source = Arc::new(Shared {
            commands: Mutex::new(VecDeque::new()),
            changed: Notify::new(),
            stop,
            encodings: Mutex::new(HashMap::new()),
        });
        let slot = Arc::new(Slot {
            id: Uuid::new_v4(),
            state: Mutex::new(SlotState::default()),
            available: Notify::new(),
            joined: Condvar::new(),
            source: Arc::downgrade(&source),
        });
        let mut encoding = Encoding {
            slot: slot.clone(),
            error_reported: false,
        };
        encoding.control().stop();
        slot.finish(Some("worker join failed".into()));
        assert_eq!(
            encoding.recv().await.unwrap().unwrap_err().to_string(),
            "worker join failed"
        );
        assert!(encoding.recv().await.is_none());
        assert_eq!(
            encoding.stop().unwrap_err().to_string(),
            "worker join failed"
        );
        assert!(
            !source.stopped(),
            "one encoding failure does not retire its source"
        );
    }
}
