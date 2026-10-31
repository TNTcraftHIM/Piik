use super::graphics::{Display, Image};
use anyhow::{anyhow, ensure, Result};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::watch;

/// SurfaceFlinger/SurfaceTexture and AudioRecord TIMEBASE_MONOTONIC share this clock.
#[derive(Clone, Copy)]
pub(super) struct Clock {
    nanos: i64,
    instant: Instant,
}
impl Clock {
    pub fn new() -> Result<Self> {
        Ok(Self {
            nanos: Self::now()?,
            instant: Instant::now(),
        })
    }
    pub fn now() -> Result<i64> {
        let mut time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        ensure!(
            unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } == 0,
            "clock_gettime failed"
        );
        Ok(time.tv_sec * 1_000_000_000 + time.tv_nsec)
    }
    pub fn project(self, nanos: i64) -> Instant {
        let delta = nanos - self.nanos;
        let duration = Duration::from_nanos(delta.unsigned_abs());
        if delta >= 0 {
            self.instant + duration
        } else {
            self.instant - duration
        }
    }
}

#[derive(Clone)]
pub(super) struct RawFrame {
    pub image: Image,
    pub nanos: i64,
}
#[derive(Clone)]
enum State {
    Live(Option<RawFrame>),
    Stopped(Option<String>),
}
#[derive(Clone)]
pub(super) struct Frames {
    state: Arc<watch::Sender<State>>,
    pub display: Arc<Display>,
    pub clock: Clock,
}
impl Frames {
    pub fn new() -> Result<Self> {
        Ok(Self {
            state: Arc::new(watch::channel(State::Live(None)).0),
            display: Display::new()?,
            clock: Clock::new()?,
        })
    }
    pub fn stop(&self, error: Option<String>) {
        self.state.send_if_modified(|state| {
            if matches!(state, State::Stopped(_)) {
                return false;
            }
            *state = State::Stopped(error);
            true
        });
    }
    pub fn is_stopped(&self) -> bool {
        matches!(*self.state.borrow(), State::Stopped(_))
    }
    pub fn publish(&self, frame: RawFrame) {
        self.state.send_if_modified(|state| {
            if matches!(state, State::Stopped(_)) {
                return false;
            }
            *state = State::Live(Some(frame));
            true
        });
    }
    pub async fn recv_after(&self, previous: Option<i64>) -> Result<Option<RawFrame>> {
        let mut changed = self.state.subscribe();
        loop {
            match &*changed.borrow_and_update() {
                State::Stopped(Some(error)) => return Err(anyhow!(error.clone())),
                State::Stopped(None) => return Ok(None),
                State::Live(Some(frame)) if previous.is_none_or(|last| frame.nanos > last) => {
                    return Ok(Some(frame.clone()))
                }
                _ => {}
            }
            changed.changed().await?;
        }
    }
    pub async fn stopped(&self) {
        let mut changed = self.state.subscribe();
        while !matches!(*changed.borrow_and_update(), State::Stopped(_)) {
            if changed.changed().await.is_err() {
                break;
            }
        }
    }
}
