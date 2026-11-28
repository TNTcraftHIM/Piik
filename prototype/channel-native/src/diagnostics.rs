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

#[cfg(all(feature = "capture", windows))]
mod capture_frames;
#[cfg(all(feature = "capture", windows))]
pub(crate) use capture_frames::CaptureFrames;

const MAX_RECORDS: usize = 8_192;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024;
static RECORDER: Recorder = Recorder::new();
static INSTALLED: OnceLock<std::result::Result<(), log::SetLoggerError>> = OnceLock::new();

pub fn enabled() -> bool {
    RECORDER.0.lock().unwrap().buffer.is_some()
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
    Observed,
    Stable,
    Sequential,
    Irregular,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreparationOutcome {
    Superseded,
    Succeeded,
    Failed,
    TimedOut,
    PeerRefused,
    TaskFailed,
    CommitFailed,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RetirementReason {
    ProjectionRemoved,
    SetupFailed,
    ConnectionDeadline,
    PeerFailed,
    PeerClosed,
    TerminalDataChannel,
    SignalingFailed,
    EventFailed,
    DriverShutdown,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TransportFailure {
    SendConsentUnavailable,
    SendSourceUnavailable,
    RtcOutputFailed,
    DeadlineWaitFailed,
}
#[derive(Clone, Copy, Default, Serialize)]
pub(crate) struct PreparationChecks {
    pub pool_opened: usize,
    pub pool_primed: usize,
    pub search_targets_sent: usize,
    pub checks_sent: usize,
    pub authenticated_reply: bool,
    pub ready_sent: bool,
    pub ready_received: bool,
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
    PreparationChecksFinished {
        #[serde(flatten)]
        checks: PreparationChecks,
    },
    TransportCreated,
    PairSetupFailed,
    RetirementStarted {
        reason: RetirementReason,
    },
    GatewayProbe {
        upnp: bool,
        pcp: bool,
        nat_pmp: bool,
    },
    GatewayCandidateAdmitted,
    IceConnected,
    IceDisconnected,
    TransportConnected,
    TransportFailed {
        reason: TransportFailure,
    },
    TransportClosed,
    SelectedPair {
        ipv6: bool,
    },
}

pub(crate) fn rtc_pair(pair: Uuid, event: RtcPairEvent) {
    RECORDER.rtc_pair(pair, event);
}

/// Record one terminal App control or page lifetime event.
pub fn app_retired(owner: Uuid, page: Option<Uuid>, reason: &'static str) {
    let mut state = RECORDER.0.lock().unwrap();
    let Some(buffer) = state.buffer.as_mut() else {
        return;
    };
    let event = if page.is_some() {
        "page_retired"
    } else {
        "control_retired"
    };
    let message = serde_json::json!({"event": event, "ownerId": owner, "pageId": page, "reason": reason});
    buffer.push(
        &Record::builder()
            .level(log::Level::Info)
            .args(format_args!("{message}"))
            .build(),
        "piik.app",
    );
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
    let mut state = RECORDER.0.lock().unwrap();
    state.buffer.get_or_insert_with(Buffer::new);
    #[cfg(all(feature = "capture", windows))]
    capture_frames::ENABLED.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

pub fn snapshot() -> Option<Snapshot> {
    let state = RECORDER.0.lock().unwrap();
    state.buffer.as_ref().map(|buffer| Snapshot {
        #[cfg(all(feature = "capture", windows))]
        capture_sources: state.captures.samples(buffer.started),
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
struct RecorderState {
    buffer: Option<Buffer>,
    #[cfg(all(feature = "capture", windows))]
    captures: capture_frames::Captures,
}

struct Recorder(Mutex<RecorderState>);
impl Recorder {
    const fn new() -> Self {
        Self(Mutex::new(RecorderState {
            buffer: None,
            #[cfg(all(feature = "capture", windows))]
            captures: capture_frames::Captures::new(),
        }))
    }

    fn rtc_pair(&self, pair: Uuid, event: RtcPairEvent) {
        let mut state = self.0.lock().unwrap();
        let Some(buffer) = state.buffer.as_mut() else {
            return;
        };
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
        let Some(buffer) = state.buffer.as_mut() else {
            return;
        };
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
            && self.0.lock().unwrap().buffer.is_some()
    }
    fn log(&self, record: &Record<'_>) {
        // Log callers may bypass enabled(); the sink enforces its own boundary.
        let Some(target) = target(record.target()) else {
            return;
        };
        if record.level() > log::Level::Warn {
            return;
        }
        if let Some(buffer) = self.0.lock().unwrap().buffer.as_mut() {
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
    #[cfg(all(feature = "capture", windows))]
    capture_sources: Vec<capture_frames::Sample>,
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
        #[cfg(all(feature = "capture", windows))]
        if !self.capture_sources.is_empty() {
            zip.start_file("capture-frames.json", options)?;
            serde_json::to_writer(&mut zip, &self.capture_sources)?;
        }
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
    fn preparation_checks_summary_serializes_reviewed_fields() {
        let event = RtcPairEvent::PreparationChecksFinished {
            checks: PreparationChecks {
                pool_opened: 64,
                pool_primed: 13,
                checks_sent: 13,
                ready_sent: true,
                ..PreparationChecks::default()
            },
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "stage": "preparation_checks_finished",
                "pool_opened": 64,
                "pool_primed": 13,
                "search_targets_sent": 0,
                "checks_sent": 13,
                "authenticated_reply": false,
                "ready_sent": true,
                "ready_received": false,
            })
        );
    }

    #[cfg(all(feature = "capture", windows))]
    #[test]
    fn capture_samples_keep_sources_and_stage_counts_separate() {
        const CHILD: &str = "PIIK_CAPTURE_SAMPLE_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "diagnostics::tests::capture_samples_keep_sources_and_stage_counts_separate",
                ])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            return;
        }
        let source = CaptureFrames::start().unwrap();
        source.callback();
        source.received();
        assert!(snapshot().is_none());
        enable().unwrap();
        source.callback();
        source.published();
        source.callback();
        source.cadence_skipped();
        source.received();
        source.received();
        let second_source = CaptureFrames::start().unwrap();
        second_source.callback();

        let active = snapshot().unwrap().capture_sources;
        assert_eq!(active.len(), 2);
        assert_eq!(active[0].wgc_callbacks, 2);
        assert_eq!(active[0].raw_published, 1);
        assert_eq!(active[0].cadence_skipped, 1);
        assert_eq!(active[0].encoded_aus_read_all_outputs, 2);
        assert_eq!(active[1].wgc_callbacks, 1);
        assert_eq!(active[1].encoded_aus_read_all_outputs, 0);
        assert_ne!(active[0].source, active[1].source);
        enable().unwrap();
        assert_eq!(snapshot().unwrap().capture_sources[0].raw_published, 1);

        drop(source);
        let report = snapshot().unwrap();
        assert_eq!(report.capture_sources.len(), 1);
        assert_eq!(report.capture_sources[0].source, active[1].source);
        let summaries: Vec<serde_json::Value> = report
            .events
            .iter()
            .filter_map(|event| event.message.strip_prefix("Capture frame summary: "))
            .map(|value| serde_json::from_str(value).unwrap())
            .collect();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0]["source"], active[0].source);
        assert_eq!(summaries[0]["encoded_aus_read_all_outputs"], 2);
    }

    #[test]
    fn pair_stages_export_only_after_opt_in_without_conflating_preparation_and_ice() {
        let recorder = Recorder::new();
        let first = Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
        let second = Uuid::parse_str("00000000-0000-4000-8000-000000000002").unwrap();
        recorder.rtc_pair(first, RtcPairEvent::TransportConnected);
        assert!(recorder.0.lock().unwrap().buffer.is_none());
        recorder.0.lock().unwrap().buffer = Some(Buffer::new());
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
        recorder.rtc_pair(first, RtcPairEvent::TransportCreated);
        recorder.rtc_pair(
            first,
            RtcPairEvent::GatewayProbe {
                upnp: false,
                pcp: false,
                nat_pmp: true,
            },
        );
        recorder.rtc_pair(first, RtcPairEvent::GatewayCandidateAdmitted);
        recorder.rtc_pair(first, RtcPairEvent::SelectedPair { ipv6: true });
        recorder.rtc_pair(first, RtcPairEvent::TransportConnected);
        recorder.rtc_pair(
            second,
            RtcPairEvent::PreparationFinished {
                outcome: PreparationOutcome::Succeeded,
            },
        );
        recorder.rtc_pair(
            first,
            RtcPairEvent::RetirementStarted {
                reason: RetirementReason::ProjectionRemoved,
            },
        );
        for reason in [
            TransportFailure::SendConsentUnavailable,
            TransportFailure::SendSourceUnavailable,
            TransportFailure::RtcOutputFailed,
            TransportFailure::DeadlineWaitFailed,
        ] {
            recorder.rtc_pair(first, RtcPairEvent::TransportFailed { reason });
        }
        let state = recorder.0.lock().unwrap();
        let buffer = state.buffer.as_ref().unwrap();
        let snapshot = Snapshot {
            #[cfg(all(feature = "capture", windows))]
            capture_sources: Vec::new(),
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
        assert_eq!(events.len(), 14);
        assert!(events
            .iter()
            .all(|event| event["level"] == "INFO" && event["target"] == "piik.rtc"));
        let details: Vec<serde_json::Value> = events
            .iter()
            .map(|event| serde_json::from_str(event["message"].as_str().unwrap()).unwrap())
            .collect();
        assert!(details[..8]
            .iter()
            .all(|event| event["pair"] == pair_alias(first)));
        assert_eq!(details[8]["pair"], pair_alias(second));
        assert_ne!(pair_alias(first), pair_alias(second));
        assert_eq!(pair_alias(first), "pair-848dc696e2308b21");
        assert_eq!(
            details[0]["event"],
            serde_json::json!({"stage":"mappings","local":"stable","remote":"irregular"})
        );
        assert_eq!(details[1]["event"]["count"], 256);
        assert_eq!(details[2]["event"]["outcome"], "timed_out");
        assert_eq!(details[3]["event"]["stage"], "transport_created");
        assert_eq!(
            details[4]["event"],
            serde_json::json!({"stage":"gateway_probe","upnp":false,"pcp":false,"nat_pmp":true})
        );
        assert_eq!(
            details[5]["event"],
            serde_json::json!({"stage":"gateway_candidate_admitted"})
        );
        assert_eq!(
            details[6]["event"],
            serde_json::json!({"stage":"selected_pair","ipv6":true})
        );
        assert_eq!(details[7]["event"]["stage"], "transport_connected");
        assert_eq!(details[8]["event"]["stage"], "preparation_finished");
        assert_eq!(
            details[9],
            serde_json::json!({"pair":pair_alias(first),"event":{"stage":"retirement_started","reason":"projection_removed"}})
        );
        for (record, reason) in details[10..].iter().zip([
            "send_consent_unavailable",
            "send_source_unavailable",
            "rtc_output_failed",
            "deadline_wait_failed",
        ]) {
            assert_eq!(
                *record,
                serde_json::json!({"pair":pair_alias(first),"event":{"stage":"transport_failed","reason":reason}})
            );
        }
        for raw in [first.to_string(), second.to_string()] {
            assert!(!text.contains(&raw));
        }
        assert!(
            !text.contains("address") && !text.contains("\"port\"") && !text.contains("secret")
        );
    }

    #[test]
    fn audio_scope_is_opt_in_and_distinguishes_process_exclusion() {
        let recorder = Recorder::new();
        recorder.system_audio_source(Some((42, false)));
        assert!(recorder.0.lock().unwrap().buffer.is_none());
        recorder.0.lock().unwrap().buffer = Some(Buffer::new());
        recorder.system_audio_source(None);
        recorder.system_audio_source(Some((41, true)));
        recorder.system_audio_source(Some((42, false)));
        let state = recorder.0.lock().unwrap();
        let events = &state.buffer.as_ref().unwrap().events;
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
        let recorder = Recorder::new();
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
        assert!(recorder.0.lock().unwrap().buffer.is_none());
        recorder.0.lock().unwrap().buffer = Some(Buffer::new());
        emit("piik.capture.extra", format_args!("not an accepted target"));
        emit("str0m", format_args!("SDK body"));
        assert!(recorder
            .0
            .lock()
            .unwrap()
            .buffer
            .as_ref()
            .unwrap()
            .events
            .is_empty());
        for _ in 0..MAX_RECORDS + 1 {
            emit("piik.capture", format_args!("capture ended"));
        }
        let mut state = recorder.0.lock().unwrap();
        let buffer = state.buffer.as_mut().unwrap();
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
        let buffer = state.buffer.as_ref().unwrap();
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
            #[cfg(all(feature = "capture", windows))]
            capture_sources: Vec::new(),
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
