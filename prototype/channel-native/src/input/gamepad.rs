//! Optional gamepad devices. Grants stay with the input executor; all driver
//! calls and device destruction run outside its lock on the owning worker.
use anyhow::{ensure, Result};
use serde::Deserialize;
use std::{
    sync::{Arc, Mutex},
    thread::JoinHandle,
};
use tokio::{
    runtime::Handle,
    sync::{oneshot, watch},
};

const MAX_PADS: usize = 4;

/// The existing Browser standard-gamepad report, independent of the OS backend.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub buttons: u32,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub left_x: i16,
    pub left_y: i16,
    pub right_x: i16,
    pub right_y: i16,
}

impl Report {
    pub fn valid(&self) -> bool {
        self.buttons & !((1 << 17) - 1) == 0
    }
}

#[derive(Clone, Copy)]
enum Update {
    Report(Report),
    Reset,
}

pub(super) trait Device: Send {
    fn update(&mut self, report: Report) -> Result<()>;
    fn reset(&mut self) -> Result<()>;
}
type Open = Arc<dyn Fn() -> Result<Box<dyn Device>> + Send + Sync>;

/// The library owns its four-target quota, serial allocation and bus session.
/// This owner retains only real worker joins, not a second device registry.
pub struct Backend {
    open: Open,
    stop: watch::Sender<bool>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl Backend {
    /// Blocking capability admission. Call outside the keyboard/mouse lock.
    pub fn connect() -> Result<Self> {
        #[cfg(target_os = "windows")]
        {
            let client = vigem_rust::Client::builder()
                .max_targets(MAX_PADS as u32)
                .connect()?;
            Ok(Self::with_open(Arc::new(move || {
                let client = client.clone();
                let pending = client.new_x360_target().plug()?;
                let target = pending.wait_for_ready()?;
                drop(pending);
                Ok(Box::new(WindowsPad {
                    target,
                    _client: client,
                }))
            })))
        }
        #[cfg(not(target_os = "windows"))]
        anyhow::bail!("gamepad_unavailable")
    }

    pub(super) fn with_open(open: Open) -> Self {
        let (stop, _) = watch::channel(false);
        Self {
            open,
            stop,
            workers: Mutex::new(vec![]),
        }
    }

    /// Allocate only after an approved controller actually reports a gamepad.
    /// Enumeration must not delay the input executor or another device.
    pub fn open(&self) -> Result<Pad> {
        ensure!(!*self.stop.borrow(), "gamepad_backend_closed");
        let runtime = Handle::try_current()?;
        let (latest, reports) = watch::channel(Some(Update::Reset));
        let (failed, error) = oneshot::channel();
        let stop = self.stop.subscribe();
        let open = self.open.clone();
        let mut workers = self.workers.lock().unwrap();
        let mut index = 0;
        while index < workers.len() {
            if workers[index].is_finished() {
                let _ = workers.swap_remove(index).join();
            } else {
                index += 1;
            }
        }
        ensure!(workers.len() < MAX_PADS, "gamepad_limit");
        let worker = std::thread::Builder::new()
            .name("piik-gamepad".into())
            .spawn(move || {
                if let Err(error) = run(open, reports, stop, runtime) {
                    let _ = failed.send(error.to_string());
                }
            })?;
        workers.push(worker);
        Ok(Pad { latest, error })
    }

    /// Stop and join outside the input lock, during App shutdown.
    pub fn shutdown(mut self) {
        self.stop.send_replace(true);
        for worker in std::mem::take(self.workers.get_mut().unwrap()) {
            let _ = worker.join();
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

/// Non-Clone grant-owned lease. Drop signals stop without waiting for driver I/O.
pub struct Pad {
    latest: watch::Sender<Option<Update>>,
    error: oneshot::Receiver<String>,
}

impl Pad {
    pub fn update(&self, report: Report) -> Result<()> {
        self.send(Update::Report(report))
    }

    /// Neutralize without surrendering the game's assigned device/player slot.
    pub fn reset(&self) -> Result<()> {
        self.send(Update::Reset)
    }

    fn send(&self, update: Update) -> Result<()> {
        ensure!(!self.latest.is_closed(), "gamepad_stopped");
        ensure!(
            self.latest.send_if_modified(|current| {
                if current.is_none() {
                    return false;
                }
                *current = Some(update);
                true // Repeated full reports are meaningful to an enumerating driver.
            }),
            "gamepad_stopped"
        );
        Ok(())
    }

    pub fn stop(&self) {
        self.latest.send_replace(None);
    }

    /// Poll from the existing input observation turn; no new error timer.
    pub fn error(&mut self) -> Option<String> {
        match self.error.try_recv() {
            Ok(error) => Some(error),
            Err(oneshot::error::TryRecvError::Empty) => None,
            Err(oneshot::error::TryRecvError::Closed) => Some("gamepad_worker_ended".into()),
        }
    }
}

impl Drop for Pad {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(
    open: Open,
    mut reports: watch::Receiver<Option<Update>>,
    mut stop: watch::Receiver<bool>,
    runtime: Handle,
) -> Result<()> {
    if *stop.borrow() || reports.has_changed().is_err() || reports.borrow().is_none() {
        return Ok(());
    }
    let mut device = open()?;
    // Reports produced while plugging/enumerating were not executed. Discard
    // them and wait for the Browser's next complete current state.
    let stopped = reports.borrow_and_update().is_none() || *stop.borrow();
    let result = (|| {
        if stopped {
            return Ok(());
        }
        loop {
            let changed = runtime.block_on(async {
                tokio::select! {
                    _ = stop.changed() => false,
                    changed = reports.changed() => changed.is_ok(),
                }
            });
            if !changed || *stop.borrow() {
                return Ok(());
            }
            let update = *reports.borrow_and_update();
            match update {
                None => return Ok(()),
                Some(Update::Report(report)) => device.update(report)?,
                Some(Update::Reset) => device.reset()?,
            }
        }
    })();
    let _ = device.reset();
    // Unique target Drop unplugs even if a final neutral report was rejected.
    drop(device);
    result
}

#[cfg(target_os = "windows")]
struct WindowsPad {
    target: vigem_rust::TargetHandle<vigem_rust::Xbox360>,
    // Target owns a Weak client; keep this session alive until after target Drop.
    _client: vigem_rust::Client,
}

#[cfg(target_os = "windows")]
impl Device for WindowsPad {
    fn update(&mut self, report: Report) -> Result<()> {
        match self.target.update(&x360(report)) {
            // The driver may temporarily have no USB read queued. A regular
            // full state repeats on the next Browser report; never sleep here.
            Err(vigem_rust::ClientError::Bus(vigem_rust::BusError::TargetNotReady { .. })) => {
                Ok(())
            }
            result => result.map_err(Into::into),
        }
    }
    fn reset(&mut self) -> Result<()> {
        self.target
            .update(&vigem_rust::X360Report::default())
            .map_err(Into::into)
    }
}

#[cfg(target_os = "windows")]
fn x360(report: Report) -> vigem_rust::X360Report {
    use vigem_rust::X360Button as B;
    let buttons = [
        B::A,
        B::B,
        B::X,
        B::Y,
        B::LEFT_SHOULDER,
        B::RIGHT_SHOULDER,
        B::empty(),
        B::empty(),
        B::BACK,
        B::START,
        B::LEFT_THUMB,
        B::RIGHT_THUMB,
        B::DPAD_UP,
        B::DPAD_DOWN,
        B::DPAD_LEFT,
        B::DPAD_RIGHT,
        B::GUIDE,
    ]
    .into_iter()
    .enumerate()
    .filter(|(index, _)| report.buttons & (1 << index) != 0)
    .fold(B::empty(), |all, (_, button)| all | button);
    vigem_rust::X360Report {
        buttons,
        left_trigger: report.left_trigger,
        right_trigger: report.right_trigger,
        thumb_lx: report.left_x,
        thumb_ly: report.left_y.saturating_neg(),
        thumb_rx: report.right_x,
        thumb_ry: report.right_y.saturating_neg(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Event {
        Opening(usize),
        Report(usize, Report),
        Reset(usize),
        Closed(usize),
    }
    struct Recorded {
        id: usize,
        events: Arc<Mutex<Vec<Event>>>,
    }
    impl Device for Recorded {
        fn update(&mut self, report: Report) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(Event::Report(self.id, report));
            Ok(())
        }
        fn reset(&mut self) -> Result<()> {
            self.events.lock().unwrap().push(Event::Reset(self.id));
            Ok(())
        }
    }
    impl Drop for Recorded {
        fn drop(&mut self) {
            self.events.lock().unwrap().push(Event::Closed(self.id));
        }
    }

    async fn wait(events: &Mutex<Vec<Event>>, expected: Event, report: Option<(&Pad, Report)>) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some((pad, value)) = report {
                pad.update(value).unwrap();
            }
            if events.lock().unwrap().contains(&expected) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "missing {expected:?}: {:?}",
                events.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn enumeration_cancellation_and_shutdown_preserve_the_other_pad() {
        let events = Arc::new(Mutex::new(vec![]));
        let (release, blocked) = mpsc::channel();
        let blocked = Mutex::new(Some(blocked));
        let count = AtomicUsize::new(0);
        let backend = Backend::with_open(Arc::new({
            let events = events.clone();
            move || {
                let id = count.fetch_add(1, Ordering::SeqCst) + 1;
                events.lock().unwrap().push(Event::Opening(id));
                if id == 2 {
                    let _ = blocked.lock().unwrap().take().unwrap().recv();
                }
                Ok(Box::new(Recorded {
                    id,
                    events: events.clone(),
                }))
            }
        }));
        let first = backend.open().unwrap();
        let a = Report {
            buttons: 1,
            ..Report::default()
        };
        wait(&events, Event::Report(1, a), Some((&first, a))).await;
        let second = backend.open().unwrap();
        wait(&events, Event::Opening(2), None).await;
        second
            .update(Report {
                buttons: 2,
                ..Report::default()
            })
            .unwrap();
        second
            .update(Report {
                buttons: 4,
                ..Report::default()
            })
            .unwrap();
        let b = Report {
            buttons: 8,
            ..Report::default()
        };
        wait(&events, Event::Report(1, b), Some((&first, b))).await;
        second.stop();
        assert!(second.update(a).is_err());
        drop(second);
        let third = backend.open().unwrap();
        let fourth = backend.open().unwrap();
        wait(&events, Event::Opening(4), None).await;
        // The cancelled second worker still owns its in-flight driver call.
        assert!(backend.open().is_err());
        drop(third);
        drop(fourth);
        release.send(()).unwrap();
        wait(&events, Event::Closed(2), None).await;
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::Report(2, _))));
        first.reset().unwrap();
        wait(&events, Event::Reset(1), None).await;
        assert!(!events.lock().unwrap().contains(&Event::Closed(1)));
        let resumed = Report {
            buttons: 16,
            ..Report::default()
        };
        wait(&events, Event::Report(1, resumed), Some((&first, resumed))).await;
        backend.shutdown();
        assert!(first.update(b).is_err());
        assert!(events.lock().unwrap().contains(&Event::Closed(1)));
    }
}
