//! Explicit App diagnostics, retained only in this process. Records carry reviewed
//! technical failures and capture configuration, never input content or SDK dumps.
use anyhow::{anyhow, Result};
use log::{LevelFilter, Log, Metadata, Record};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fmt::{self, Write as _},
    io::Write,
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const MAX_RECORDS: usize = 8_192;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024;
static RECORDER: Recorder = Recorder(Mutex::new(None));
static INSTALLED: OnceLock<std::result::Result<(), log::SetLoggerError>> = OnceLock::new();

pub fn enabled() -> bool {
    RECORDER.0.lock().unwrap().is_some()
}

// Canonical UUID text permits offline correlation with Browser pairId; the
// namespace is distinct from 2.x Go diagnostic IDs. Never hash socket tuples.
pub(crate) fn pair_alias(pair: Uuid) -> String {
    let digest = Sha256::digest(format!("piik-native-pair-v1:{pair}"));
    format!(
        "pair-{}",
        digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreparationStep {
    LocalAddress,
    StunResolution,
    Survey,
    PeerObservation,
    Checks,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MappingKind {
    Stable,
    Sequential,
    Irregular,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreparationOutcome {
    Succeeded,
    Failed,
    TimedOut,
    PeerRefused,
    TaskFailed,
    CommitFailed,
}
#[derive(Clone, Copy, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub(crate) enum RtcPairEvent {
    PreparationStarted {
        initiator: bool,
    },
    Preparation {
        step: PreparationStep,
    },
    Mappings {
        local: MappingKind,
        remote: MappingKind,
    },
    Hypotheses {
        count: usize,
        random: bool,
    },
    PreparationFinished {
        outcome: PreparationOutcome,
    },
    OrdinaryFallback,
    TransportCreated {
        prepared: bool,
    },
    PairSetupFailed,
    IceConnected,
    IceDisconnected,
    TransportConnected,
    TransportClosed,
    SelectedPair {
        ipv6: bool,
    },
}

pub(crate) fn rtc_pair(pair: Uuid, event: RtcPairEvent) {
    RECORDER.rtc_pair(pair, event);
}

/// The selected sound scope is useful even when capture succeeds without an error.
#[cfg(all(feature = "capture", windows))]
pub(crate) fn system_audio_source(process: Option<(u32, bool)>) {
    RECORDER.system_audio_source(process);
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
        "piik.app" => Some("piik.app"),
        "piik.input" => Some("piik.input"),
        "piik.capture" => Some("piik.capture"),
        "piik.encoder" => Some("piik.encoder"),
        "piik.rtc" => Some("piik.rtc"),
        _ => None,
    }
}
struct Recorder(Mutex<Option<Buffer>>);
impl Recorder {
    fn rtc_pair(&self, pair: Uuid, event: RtcPairEvent) {
        let mut state = self.0.lock().unwrap();
        let Some(buffer) = state.as_mut() else { return };
        // No formatting or hashing before opt-in; fields are reviewed values,
        // never an upstream error string, address, SDP or preparation key.
        if let Ok(message) =
            serde_json::to_string(&serde_json::json!({"pair": pair_alias(pair), "event": event}))
        {
            buffer.push(
                &Record::builder()
                    .level(log::Level::Info)
                    .args(format_args!("{message}"))
                    .build(),
                "piik.rtc",
            );
        }
    }
    #[cfg(any(test, all(feature = "capture", windows)))]
    fn system_audio_source(&self, process: Option<(u32, bool)>) {
        let mut state = self.0.lock().unwrap();
        let Some(buffer) = state.as_mut() else { return };
        let (scope, process_id) = match process {
            None => ("default-output", None),
            Some((pid, true)) => ("include-process-tree", Some(pid)),
            Some((pid, false)) => ("exclude-process-tree", Some(pid)),
        };
        buffer.push(
            &Record::builder()
                .level(log::Level::Info)
                .args(format_args!(
                    "System audio configured: scope={scope} selected_pid={process_id:?} native_process_id={}",
                    std::process::id(),
                ))
                .build(),
            "piik.capture",
        );
    }
}
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
    fn pair_stages_export_only_after_opt_in_without_conflating_preparation_and_ice() {
        let recorder = Recorder(Mutex::new(None));
        let first = Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
        let second = Uuid::parse_str("00000000-0000-4000-8000-000000000002").unwrap();
        recorder.rtc_pair(first, RtcPairEvent::TransportConnected);
        assert!(recorder.0.lock().unwrap().is_none());
        *recorder.0.lock().unwrap() = Some(Buffer::new());
        recorder.rtc_pair(
            first,
            RtcPairEvent::Mappings {
                local: MappingKind::Stable,
                remote: MappingKind::Irregular,
            },
        );
        recorder.rtc_pair(
            first,
            RtcPairEvent::Hypotheses {
                count: 256,
                random: true,
            },
        );
        recorder.rtc_pair(
            first,
            RtcPairEvent::PreparationFinished {
                outcome: PreparationOutcome::TimedOut,
            },
        );
        recorder.rtc_pair(first, RtcPairEvent::OrdinaryFallback);
        recorder.rtc_pair(first, RtcPairEvent::SelectedPair { ipv6: true });
        recorder.rtc_pair(first, RtcPairEvent::TransportConnected);
        recorder.rtc_pair(
            second,
            RtcPairEvent::PreparationFinished {
                outcome: PreparationOutcome::Succeeded,
            },
        );
        let state = recorder.0.lock().unwrap();
        let buffer = state.as_ref().unwrap();
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
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("events.ndjson").unwrap(), &mut text)
            .unwrap();
        let events: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events.len(), 7);
        assert!(events
            .iter()
            .all(|event| event["level"] == "INFO" && event["target"] == "piik.rtc"));
        let details: Vec<serde_json::Value> = events
            .iter()
            .map(|event| serde_json::from_str(event["message"].as_str().unwrap()).unwrap())
            .collect();
        assert!(details[..6]
            .iter()
            .all(|event| event["pair"] == pair_alias(first)));
        assert_eq!(details[6]["pair"], pair_alias(second));
        assert_ne!(pair_alias(first), pair_alias(second));
        assert_eq!(pair_alias(first), "pair-848dc696e2308b21");
        assert_eq!(
            details[0]["event"],
            serde_json::json!({"stage":"mappings","local":"stable","remote":"irregular"})
        );
        assert_eq!(details[1]["event"]["count"], 256);
        assert_eq!(details[2]["event"]["outcome"], "timed_out");
        assert_eq!(details[3]["event"]["stage"], "ordinary_fallback");
        assert_eq!(
            details[4]["event"],
            serde_json::json!({"stage":"selected_pair","ipv6":true})
        );
        assert_eq!(details[5]["event"]["stage"], "transport_connected");
        assert_eq!(details[6]["event"]["stage"], "preparation_finished");
        for raw in [first.to_string(), second.to_string()] {
            assert!(!text.contains(&raw));
        }
        assert!(
            !text.contains("address") && !text.contains("\"port\"") && !text.contains("secret")
        );
    }

    #[test]
    fn audio_scope_is_opt_in_and_distinguishes_process_exclusion() {
        let recorder = Recorder(Mutex::new(None));
        recorder.system_audio_source(Some((42, false)));
        assert!(recorder.0.lock().unwrap().is_none());
        *recorder.0.lock().unwrap() = Some(Buffer::new());
        recorder.system_audio_source(None);
        recorder.system_audio_source(Some((41, true)));
        recorder.system_audio_source(Some((42, false)));
        let state = recorder.0.lock().unwrap();
        let events = &state.as_ref().unwrap().events;
        assert_eq!(events.len(), 3);
        assert!(events[0]
            .message
            .contains("scope=default-output selected_pid=None"));
        assert!(events[1]
            .message
            .contains("scope=include-process-tree selected_pid=Some(41)"));
        assert!(events[2]
            .message
            .contains("scope=exclude-process-tree selected_pid=Some(42)"));
        assert!(events.iter().all(|event| event.level == "INFO"
            && event
                .message
                .contains(&format!("native_process_id={}", std::process::id()))));
    }

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
        emit("piik.rtc", format_args!("off transport"));
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
            emit("piik.input", format_args!("{large}"));
        }
        emit("piik.app", format_args!("App startup tunnel-start: https://synthetic-private.invalid/?invite=synthetic-invite#owner=synthetic-owner credential=synthetic-credential"));
        emit("piik.rtc", format_args!("UDP send failures: match_order=[selected,other,unknown] ipv4=count:2000 last_os_error:10051"));
        emit(
            "str0m",
            format_args!("synthetic-chat-body synthetic-source-title"),
        );
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
        let metadata: serde_json::Value =
            serde_json::from_reader(zip.by_name("metadata.json").unwrap()).unwrap();
        assert_eq!(metadata["version"], "test");
        assert_eq!(metadata["revision"], "revision");
        assert_eq!(metadata["packageTarget"], "fixture");
        let mut events = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("events.ndjson").unwrap(), &mut events)
            .unwrap();
        assert!(events.contains("App startup tunnel-start"));
        assert!(
            events.contains("piik.rtc")
                && events.contains("UDP send failures")
                && events.contains("10051")
        );
        assert!(events.contains("[URL omitted]"));
        for marker in [
            "synthetic-private",
            "synthetic-invite",
            "synthetic-owner",
            "synthetic-credential",
            "synthetic-chat-body",
            "synthetic-source-title",
        ] {
            assert!(
                !events.contains(marker),
                "private marker retained: {marker}"
            );
        }
    }
}
