use super::{Buffer, MAX_RECORDS, RECORDER};
use log::{Level, Record};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Instant,
};

// The recorder lock serializes registration, final summaries and ZIP snapshots.
// On the capture thread only the opt-in flag and the counters are accessed.
pub(super) static ENABLED: AtomicBool = AtomicBool::new(false);

pub(super) struct Captures {
    next_source: u64,
    active: BTreeMap<u64, Arc<Counts>>,
}

impl Captures {
    pub(super) const fn new() -> Self {
        Self {
            next_source: 1,
            active: BTreeMap::new(),
        }
    }

    pub(super) fn samples(&self, enabled_at: Instant) -> Vec<Sample> {
        let now = Instant::now();
        self.active
            .iter()
            .map(|(&source, counts)| counts.sample(source, enabled_at, now))
            .collect()
    }
}

struct Counts {
    started: Instant,
    callbacks: AtomicU64,
    published: AtomicU64,
    cadence_skipped: AtomicU64,
    received: AtomicU64,
}

impl Counts {
    fn sample(&self, source: u64, enabled_at: Instant, now: Instant) -> Sample {
        Sample {
            source,
            elapsed_ms: now.duration_since(self.started.max(enabled_at)).as_millis(),
            encoded_aus_read_all_outputs: self.received.load(Ordering::Relaxed),
            raw_published: self.published.load(Ordering::Relaxed),
            cadence_skipped: self.cadence_skipped.load(Ordering::Relaxed),
            wgc_callbacks: self.callbacks.load(Ordering::Relaxed),
        }
    }
}

#[derive(Serialize)]
pub(super) struct Sample {
    pub(super) source: u64,
    pub(super) elapsed_ms: u128,
    pub(super) wgc_callbacks: u64,
    pub(super) raw_published: u64,
    pub(super) cadence_skipped: u64,
    pub(super) encoded_aus_read_all_outputs: u64,
}

pub(crate) struct CaptureFrames {
    source: u64,
    counts: Arc<Counts>,
}

impl CaptureFrames {
    pub(crate) fn start() -> Option<Arc<Self>> {
        let mut state = RECORDER.0.lock().unwrap();
        let captures = &mut state.captures;
        if captures.active.len() >= MAX_RECORDS {
            return None;
        }
        let source = captures.next_source;
        captures.next_source += 1;
        let counts = Arc::new(Counts {
            started: Instant::now(),
            callbacks: 0.into(),
            published: 0.into(),
            cadence_skipped: 0.into(),
            received: 0.into(),
        });
        captures.active.insert(source, counts.clone());
        Some(Arc::new(Self { source, counts }))
    }

    fn increment(counter: &AtomicU64) {
        if ENABLED.load(Ordering::Relaxed) {
            counter.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(crate) fn callback(&self) {
        Self::increment(&self.counts.callbacks);
    }
    pub(crate) fn published(&self) {
        Self::increment(&self.counts.published);
    }
    pub(crate) fn cadence_skipped(&self) {
        Self::increment(&self.counts.cadence_skipped);
    }
    pub(crate) fn received(&self) {
        Self::increment(&self.counts.received);
    }
}

impl Drop for CaptureFrames {
    fn drop(&mut self) {
        let mut state = RECORDER.0.lock().unwrap();
        state.captures.active.remove(&self.source);
        if let Some(buffer) = state.buffer.as_mut() {
            let sample = self
                .counts
                .sample(self.source, buffer.started, Instant::now());
            buffer.capture_finished(&sample);
        }
    }
}

impl Buffer {
    fn capture_finished(&mut self, sample: &Sample) {
        if let Ok(json) = serde_json::to_string(sample) {
            self.push(
                &Record::builder()
                    .level(Level::Info)
                    .args(format_args!("Capture frame summary: {json}"))
                    .build(),
                "piik.capture",
            );
        }
    }
}
