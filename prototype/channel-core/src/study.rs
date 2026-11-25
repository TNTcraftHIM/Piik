//! Policy switches for the offline placement study (`tests/topology_study.rs`).
//! Compiled only with the `study` feature, which no shipped build enables, and
//! every switch defaults to the shipped rule. Thread-local, so study tests that
//! run in parallel cannot see each other's settings.
use std::cell::Cell;

thread_local! {
    /// P1 "race an alternative": once a waiting receiver's direct pair to the
    /// source has been pending this many milliseconds, repair may also choose
    /// and admit one alternative trial for it, as after a rejection.
    pub static RACE_DIRECT_AFTER_MS: Cell<Option<u64>> = const { Cell::new(None) };
}

pub(crate) fn race_direct_after() -> Option<u64> {
    RACE_DIRECT_AFTER_MS.with(Cell::get)
}
