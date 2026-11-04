//! Explicit App diagnostics, retained only in this process. These targets carry
//! reviewed capture/encoder errors, never requests, registry data or SDK dumps.
use anyhow::{anyhow, Result};
use log::{LevelFilter, Log, Metadata, Record};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fmt::{self, Write as _},
    io::Write,
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const MAX_RECORDS: usize = 8_192;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024;
static RECORDER: Recorder = Recorder(Mutex::new(None));
static INSTALLED: OnceLock<std::result::Result<(), log::SetLoggerError>> = OnceLock::new();

pub fn enabled() -> bool {
    RECORDER.0.lock().unwrap().is_some()
}

/// Logger installation and opt-in survive Android runtime restarts in one PID.
pub fn enable() -> Result<()> {
    INSTALLED
        .get_or_init(|| {
            log::set_logger(&RECORDER)?;
            log::set_max_level(LevelFilter::Warn);
            Ok(())
        })
        .as_ref()
        .map_err(|error| anyhow!("App diagnostics could not start: {error}"))?;
    RECORDER.0.lock().unwrap().get_or_insert_with(Buffer::new);
    Ok(())
}

pub fn snapshot() -> Option<Snapshot> {
    RECORDER.0.lock().unwrap().as_ref().map(|buffer| Snapshot {
        started_at_ms: buffer.started_at_ms,
        evicted: buffer.evicted,
        truncated: buffer.truncated,
        retained_bytes: buffer.bytes,
        events: buffer.events.iter().cloned().collect(),
    })
}

#[derive(Clone, Serialize)]
struct Event {
    sequence: u64,
    at_ms: u64,
    elapsed_ms: u64,
    level: &'static str,
    target: &'static str,
    message: Box<str>,
}
struct Buffer {
    started: Instant,
    started_at_ms: u64,
    events: VecDeque<Event>,
    bytes: usize,
    sequence: u64,
    evicted: u64,
    truncated: u64,
}
impl Buffer {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            started_at_ms: now_ms(),
            events: VecDeque::new(),
            bytes: 0,
            sequence: 0,
            evicted: 0,
            truncated: 0,
        }
    }
    fn push(&mut self, record: &Record<'_>, target: &'static str) {
        let mut text = LimitedText::default();
        let _ = write!(text, "{}", record.args());
        let mut clean = LimitedText::default();
        let _ = clean.write_str(&technical_text(&text.text));
        self.truncated += u64::from(text.truncated || clean.truncated);
        self.sequence += 1;
        let event = Event {
            sequence: self.sequence,
            at_ms: now_ms(),
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            level: record.level().as_str(),
            target,
            message: clean.text.into_boxed_str(),
        };
        self.bytes += event_bytes(&event);
        self.events.push_back(event);
        while self.events.len() > MAX_RECORDS || self.bytes > MAX_BYTES {
            self.bytes -= event_bytes(&self.events.pop_front().unwrap());
            self.evicted += 1;
        }
    }
}
fn event_bytes(event: &Event) -> usize {
    std::mem::size_of::<Event>() + event.message.len()
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn target(value: &str) -> Option<&'static str> {
    match value {
        "piik.capture" => Some("piik.capture"),
        "piik.encoder" => Some("piik.encoder"),
        _ => None,
    }
}
struct Recorder(Mutex<Option<Buffer>>);
impl Log for Recorder {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        target(metadata.target()).is_some()
            && metadata.level() <= log::Level::Warn
            && self.0.lock().unwrap().is_some()
    }
    fn log(&self, record: &Record<'_>) {
        // Log callers may bypass enabled(); the sink enforces its own boundary.
        let Some(target) = target(record.target()) else {
            return;
        };
        if record.level() > log::Level::Warn {
            return;
        }
        if let Some(buffer) = self.0.lock().unwrap().as_mut() {
            buffer.push(record, target);
        }
    }
    fn flush(&self) {}
}
#[derive(Default)]
struct LimitedText {
    text: String,
    truncated: bool,
}
impl fmt::Write for LimitedText {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        let mut length = (MAX_RECORD_BYTES - self.text.len()).min(value.len());
        while !value.is_char_boundary(length) {
            length -= 1;
        }
        self.text.push_str(&value[..length]);
        self.truncated |= length != value.len();
        Ok(())
    }
}
fn technical_text(text: &str) -> String {
    // Technical error chains can include an upstream URL or credential suffix.
    // Do not retain that detail, and never accept an SDP/candidate dump.
    let lower = text.to_ascii_lowercase();
    let private = [
        "v=0",
        "candidate:",
        "a=ice-",
        "password",
        "passwd",
        "token",
        "secret",
        "credential",
        "authorization",
        "cookie",
        "ufrag",
        "bearer",
        "sdp",
    ]
    .into_iter()
    .filter_map(|key| lower.find(key))
    .min();
    let (text, omitted) = private.map_or((text, false), |at| (&text[..at], true));
    let mut result = String::new();
    for word in text.split_inclusive(char::is_whitespace) {
        if word.contains("://") || word.starts_with("stun:") || word.starts_with("turn:") {
            result.push_str("[URL omitted] ");
        } else {
            result.push_str(word);
        }
    }
    if omitted {
        result.push_str("[private detail omitted]");
    }
    result
}

pub struct Snapshot {
    started_at_ms: u64,
    evicted: u64,
    truncated: u64,
    retained_bytes: usize,
    events: Vec<Event>,
}
impl Snapshot {
    /// Snapshot owns bounded data; compression/download never holds the logger.
    pub fn write_archive(
        self,
        output: impl Write,
        version: &str,
        revision: &str,
        package_target: &str,
    ) -> Result<()> {
        let mut zip = ZipWriter::new_stream(output);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("metadata.json", options)?;
        serde_json::to_writer(
            &mut zip,
            &serde_json::json!({
                "version":version,"revision":revision,"packageTarget":package_target,
                "os":std::env::consts::OS,"arch":std::env::consts::ARCH,
                "startedAtMs":self.started_at_ms,"exportedAtMs":now_ms(),
                "maxRecords":MAX_RECORDS,"maxBytes":MAX_BYTES,"maxRecordBytes":MAX_RECORD_BYTES,
                "retainedRecords":self.events.len(),"retainedBytes":self.retained_bytes,
                "evicted":self.evicted,"truncated":self.truncated,
            }),
        )?;
        zip.start_file("events.ndjson", options)?;
        for event in self.events {
            serde_json::to_writer(&mut zip, &event)?;
            zip.write_all(b"\n")?;
        }
        zip.finish()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_bounds_targets_and_export() {
        let recorder = Recorder(Mutex::new(None));
        let emit = |target: &str, args: fmt::Arguments<'_>| {
            recorder.log(
                &Record::builder()
                    .target(target)
                    .level(log::Level::Warn)
                    .args(args)
                    .build(),
            );
        };
        emit("piik.capture", format_args!("off"));
        assert!(recorder.0.lock().unwrap().is_none());
        *recorder.0.lock().unwrap() = Some(Buffer::new());
        emit("piik.capture.extra", format_args!("not an accepted target"));
        emit("str0m", format_args!("SDK body"));
        assert!(recorder
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .events
            .is_empty());
        for _ in 0..MAX_RECORDS + 1 {
            emit("piik.capture", format_args!("capture ended"));
        }
        let mut state = recorder.0.lock().unwrap();
        let buffer = state.as_mut().unwrap();
        assert_eq!(buffer.events.len(), MAX_RECORDS);
        assert_eq!(buffer.evicted, 1);
        drop(state);
        let large = "界".repeat(MAX_RECORD_BYTES);
        for _ in 0..MAX_BYTES / MAX_RECORD_BYTES + 1 {
            emit("piik.encoder", format_args!("{large}"));
        }
        let state = recorder.0.lock().unwrap();
        let buffer = state.as_ref().unwrap();
        assert!(buffer.bytes <= MAX_BYTES && buffer.truncated > 0);
        assert!(buffer
            .events
            .iter()
            .all(|e| e.message.len() <= MAX_RECORD_BYTES));
        assert_eq!(
            technical_text("codec failed: https://private.invalid/#key token=private"),
            "codec failed: [URL omitted] [private detail omitted]"
        );
        let snapshot = Snapshot {
            started_at_ms: buffer.started_at_ms,
            evicted: buffer.evicted,
            truncated: buffer.truncated,
            retained_bytes: buffer.bytes,
            events: buffer.events.iter().cloned().collect(),
        };
        drop(state);
        let mut bytes = Vec::new();
        snapshot
            .write_archive(&mut bytes, "test", "revision", "fixture")
            .unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(zip.len(), 2);
        assert!(zip.by_name("metadata.json").is_ok());
        assert!(zip.by_name("events.ndjson").is_ok());
    }
}
