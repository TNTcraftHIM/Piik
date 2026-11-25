//! The platform's precise clock: a wake-up at an instant, to about a millisecond.
//!
//! Callers state the instant and assume nothing about how fine a timer is. This
//! module is the one place that knows which platform can keep that promise with
//! the runtime's own timer and which cannot.
//!
//! Linux, macOS and Android can. A tokio timer on Windows fires on the system
//! tick: 15.6 ms unless a process has raised it, and Windows 11 does not keep a
//! raised period for a process that is neither visible nor audible, which is an
//! App sharing a game while minimized. There one thread sleeps on the caller's
//! behalf with `std::thread::sleep`, which uses a high-resolution waitable
//! timer on Windows 10 1803 and later.
//!
//! The first caller is the engine pump. The SDK's pacer and bandwidth probes
//! need their deadlines met: with the default tick a Native sender's estimate
//! stayed near 240 kbit/s on loopback, and with deadlines met it passed
//! 11 Mbit/s in two seconds.

use std::time::Instant;

#[cfg(windows)]
use std::{
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

/// A coarse wait can return a tick or two late; the precise part starts here.
#[cfg(windows)]
const COARSE: Duration = Duration::from_millis(32);
/// How late an instant that replaces a later one can be noticed.
#[cfg(windows)]
const SLICE: Duration = Duration::from_millis(1);

#[cfg(windows)]
#[derive(Default)]
struct State {
    at: Option<Instant>,
    stop: bool,
}

#[cfg(windows)]
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    armed: Condvar,
    reached: tokio::sync::Notify,
}

/// One owner per pump. Dropping it ends and joins its thread within a slice.
pub(crate) struct Deadline {
    #[cfg(windows)]
    shared: Arc<Shared>,
    #[cfg(windows)]
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Deadline {
    pub(crate) fn new() -> Self {
        #[cfg(windows)]
        {
            let shared = Arc::new(Shared::default());
            let run = shared.clone();
            let thread = std::thread::Builder::new()
                .name("piik-deadline".into())
                .spawn(move || sleep_for(&run))
                .expect("spawn the deadline thread");
            Self {
                shared,
                thread: Some(thread),
            }
        }
        #[cfg(not(windows))]
        Self {}
    }

    /// Returns once `at` has passed. One waiter at a time, which the exclusive borrow
    /// enforces. Dropping the future and waiting for another
    /// instant, earlier or later, replaces the one in effect.
    pub(crate) async fn wait(&mut self, at: Instant) {
        #[cfg(windows)]
        while Instant::now() < at {
            self.shared.state.lock().unwrap().at = Some(at);
            self.shared.armed.notify_one();
            // A wake-up for an instant this one replaced is checked against the clock.
            self.shared.reached.notified().await;
        }
        #[cfg(not(windows))]
        if Instant::now() < at {
            tokio::time::sleep_until(at.into()).await;
        }
    }
}

#[cfg(windows)]
fn sleep_for(shared: &Shared) {
    let mut state = shared.state.lock().unwrap();
    while !state.stop {
        let Some(at) = state.at else {
            state = shared.armed.wait(state).unwrap();
            continue;
        };
        let now = Instant::now();
        if now >= at {
            state.at = None;
            shared.reached.notify_one();
        } else if at - now > COARSE {
            // Far away: wait where a new instant can interrupt.
            state = shared.armed.wait_timeout(state, at - now - COARSE).unwrap().0;
        } else {
            drop(state);
            std::thread::sleep((at - now).min(SLICE));
            state = shared.state.lock().unwrap();
        }
    }
}

#[cfg(windows)]
impl Drop for Deadline {
    fn drop(&mut self) {
        self.shared.state.lock().unwrap().stop = true;
        self.shared.armed.notify_one();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_near_instant_is_met_without_waiting_for_the_system_tick() {
        let mut deadline = Deadline::new();
        let wait = Duration::from_millis(2);
        let mut late = Vec::new();
        for _ in 0..100 {
            let start = Instant::now();
            deadline.wait(start + wait).await;
            late.push(start.elapsed().saturating_sub(wait));
        }
        late.sort();
        // A tokio timer on the default Windows tick is late by about 14 ms here.
        assert!(
            late[late.len() / 2] < Duration::from_millis(5),
            "median lateness {:?}",
            late[late.len() / 2]
        );
    }

    #[tokio::test]
    async fn an_earlier_instant_replaces_a_later_one() {
        let mut deadline = Deadline::new();
        let start = Instant::now();
        // Abandon a far wait, as a select does when another branch is ready.
        tokio::select! {
            _ = deadline.wait(start + Duration::from_secs(30)) => unreachable!(),
            _ = tokio::task::yield_now() => {}
        }
        deadline.wait(Instant::now() + Duration::from_millis(5)).await;
        assert!(start.elapsed() < Duration::from_secs(1));
        // And a later one after it is still waited for in full.
        let again = Instant::now();
        deadline.wait(again + Duration::from_millis(60)).await;
        assert!(again.elapsed() >= Duration::from_millis(60));
    }
}
