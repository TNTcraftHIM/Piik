//! The pump owns one deadline and may replace a pending wait by polling a
//! future for a new instant. On Windows, a cancelled future can leave the
//! timer armed until it fires, is rearmed, or the owner drops.
//!
//! Windows uses a high-resolution waitable timer and joins its worker on
//! drop. Other platforms use Tokio. Timer precision and the scheduling
//! latency of the worker and async task are separate.

use std::{io, time::Instant};

#[cfg(not(windows))]
pub(crate) struct Deadline;

#[cfg(not(windows))]
impl Deadline {
    pub(crate) fn new() -> io::Result<Self> {
        Ok(Self)
    }

    pub(crate) async fn wait(&mut self, at: Instant) -> io::Result<()> {
        if Instant::now() < at {
            tokio::time::sleep_until(at.into()).await;
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(crate) use platform::Deadline;

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        sync::{Arc, OnceLock},
        thread::{Builder, JoinHandle},
    };
    use tokio::sync::Notify;
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{HANDLE, WAIT_OBJECT_0},
            System::Threading::{
                CreateEventW, CreateWaitableTimerExW, SetEvent, SetWaitableTimer,
                WaitForMultipleObjects, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE,
                SYNCHRONIZATION_SYNCHRONIZE, TIMER_MODIFY_STATE,
            },
        },
    };

    struct Shared {
        timer: OwnedHandle,
        stop: OwnedHandle,
        reached: Notify,
        failed: OnceLock<io::Error>,
    }

    pub(crate) struct Deadline {
        shared: Arc<Shared>,
        thread: Option<JoinHandle<()>>,
    }

    impl Deadline {
        pub(crate) fn new() -> io::Result<Self> {
            // Each successful API call returns a fresh handle. Transfer its
            // ownership immediately so subsequent creation failures close it.
            let timer = unsafe {
                let timer = CreateWaitableTimerExW(
                    None,
                    PCWSTR::null(),
                    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                    SYNCHRONIZATION_SYNCHRONIZE.0 | TIMER_MODIFY_STATE.0,
                )
                .map_err(io::Error::other)?;
                OwnedHandle::from_raw_handle(timer.0)
            };
            let stop = unsafe {
                let stop = CreateEventW(None, true, false, PCWSTR::null())
                    .map_err(io::Error::other)?;
                OwnedHandle::from_raw_handle(stop.0)
            };
            let shared = Arc::new(Shared {
                timer,
                stop,
                reached: Notify::new(),
                failed: OnceLock::new(),
            });
            let worker = shared.clone();
            let thread = Builder::new()
                .name("piik-deadline".into())
                .spawn(move || run(&worker))?;
            Ok(Self {
                shared,
                thread: Some(thread),
            })
        }

        pub(crate) async fn wait(&mut self, at: Instant) -> io::Result<()> {
            loop {
                if let Some(error) = self.shared.failed.get() {
                    return Err(io::Error::other(error.to_string()));
                }
                let remaining = at.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Ok(());
                }
                // A negative count of 100 ns units is relative. Round up so
                // sub-unit waits do not become zero, and cap the conversion.
                let due = -(remaining.as_nanos().div_ceil(100).min(i64::MAX as u128) as i64);
                // The Arc keeps the timer open across rearm and worker waits.
                unsafe {
                    SetWaitableTimer(
                        HANDLE(self.shared.timer.as_raw_handle()),
                        &due,
                        0,
                        None,
                        None,
                        false,
                    )
                    .map_err(io::Error::other)?;
                }
                // An old notification can still be pending after a rearm.
                self.shared.reached.notified().await;
            }
        }
    }

    fn run(shared: &Shared) {
        let handles = [
            HANDLE(shared.stop.as_raw_handle()),
            HANDLE(shared.timer.as_raw_handle()),
        ];
        loop {
            // Shared owns both handles for the worker's lifetime. Stop is
            // first so it wins when both objects are signaled.
            let result = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
            if result == WAIT_OBJECT_0 {
                return;
            }
            if result.0 != WAIT_OBJECT_0.0 + 1 {
                let _ = shared.failed.set(io::Error::last_os_error());
                shared.reached.notify_one();
                return;
            }
            shared.reached.notify_one();
        }
    }

    impl Drop for Deadline {
        fn drop(&mut self) {
            // The stop handle is owned and has event-modify access.
            unsafe { SetEvent(HANDLE(self.shared.stop.as_raw_handle())) }
                .expect("signal deadline stop event");
            if let Some(thread) = self.thread.take() {
                thread.join().expect("join deadline thread");
            }
        }
    }
}



#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn replaces_pending_deadlines_in_both_directions() -> io::Result<()> {
        let mut deadline = Deadline::new()?;
        for (old, new) in [(30_000, 2), (2, 60)] {
            tokio::select! {
                biased;
                result = deadline.wait(Instant::now() + Duration::from_millis(old)) => {
                    panic!("old deadline completed: {result:?}");
                }
                _ = std::future::ready(()) => {}
            }
            let at = Instant::now() + Duration::from_millis(new);
            tokio::time::timeout(Duration::from_secs(1), deadline.wait(at)).await??;
            assert!(Instant::now() >= at);
        }
        Ok(())
    }

    #[tokio::test]
    async fn expired_deadline_returns_and_drop_joins_with_timer_armed() -> io::Result<()> {
        let mut deadline = Deadline::new()?;
        deadline.wait(Instant::now() - Duration::from_secs(1)).await?;
        tokio::select! {
            biased;
            result = deadline.wait(Instant::now() + Duration::from_secs(3600)) => {
                panic!("long deadline completed: {result:?}");
            }
            _ = std::future::ready(()) => {}
        }
        let start = Instant::now();
        drop(deadline);
        assert!(start.elapsed() < Duration::from_secs(1));
        Ok(())
    }
}
