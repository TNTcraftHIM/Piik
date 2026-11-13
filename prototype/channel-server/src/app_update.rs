//! One local App operation owns a verified package until cancellation or installation.
#[path = "app_update/download.rs"]
mod download;
#[path = "app_update/package.rs"]
mod package;
#[cfg(windows)]
#[path = "app_update/windows.rs"]
mod windows;

pub use package::{BundleEntry, BundleLayout, EntryKind};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

const GITHUB: &str = "https://github.com/TNTcraftHIM/Piik/releases/download/";
const ATOMGIT: &str = "https://atomgit.com/TNTcraftHIM/Piik/releases/download/";

/// Composition inputs come from the installed build, never from an HTTP request.
#[derive(Clone)]
pub struct Options {
    pub public_key: [u8; 32],
    pub layout: BundleLayout,
    pub version: String,
    pub target: String,
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub working_directory: PathBuf,
    pub providers: [url::Url; 2],
}

#[derive(Clone)]
pub enum Config {
    Unavailable(&'static str),
    Enabled(Options),
}

impl Default for Config {
    fn default() -> Self {
        Self::Unavailable(if cfg!(windows) {
            "untrusted-build"
        } else {
            "unsupported-platform"
        })
    }
}

impl Config {
    pub fn packaged() -> Self {
        if !cfg!(windows) {
            return Self::default();
        }
        let Some(public_key) = option_env!("PIIK_UPDATE_PUBLIC_KEY").and_then(package::hex::<32>)
        else {
            return Self::Unavailable("untrusted-build");
        };
        let layout = option_env!("PIIK_APP_BUNDLE_LAYOUT")
            .and_then(|value| serde_json::from_str::<BundleLayout>(value).ok());
        let Some(layout) = layout else {
            return Self::Unavailable("unmanaged-installation");
        };
        let (Ok(executable), Ok(working_directory)) =
            (std::env::current_exe(), std::env::current_dir())
        else {
            return Self::Unavailable("unmanaged-installation");
        };
        Self::Enabled(Options {
            public_key,
            layout,
            executable,
            working_directory,
            arguments: std::env::args_os().skip(1).collect(),
            version: super::BUILD_VERSION.into(),
            target: super::PACKAGE_TARGET.into(),
            providers: [GITHUB.parse().unwrap(), ATOMGIT.parse().unwrap()],
        })
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Selection {
    version: String,
    revision: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Request {
    Download { version: String, revision: String },
    Cancel { operation_id: Uuid },
    Install { operation_id: Uuid },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct View {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    received_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

struct Operation {
    id: Uuid,
    selection: Selection,
    received: u64,
    total: Option<u64>,
    source: Option<&'static str>,
}

enum State {
    Unavailable(&'static str),
    Idle,
    Downloading {
        operation: Operation,
        cancel: watch::Sender<bool>,
        finished: Option<oneshot::Receiver<()>>,
    },
    Ready {
        operation: Operation,
        package: package::Prepared,
    },
    Installing(Operation),
    Failed {
        operation: Operation,
        error: &'static str,
    },
}

impl State {
    fn operation(&self) -> Option<&Operation> {
        match self {
            Self::Downloading { operation, .. }
            | Self::Ready { operation, .. }
            | Self::Installing(operation)
            | Self::Failed { operation, .. } => Some(operation),
            _ => None,
        }
    }

    fn view(&self) -> View {
        let operation = self.operation();
        View {
            state: match self {
                Self::Unavailable(_) => "unavailable",
                Self::Idle => "idle",
                Self::Downloading { .. } => "downloading",
                Self::Ready { .. } => "ready",
                Self::Installing(_) => "installing",
                Self::Failed { .. } => "failed",
            },
            reason: if let Self::Unavailable(reason) = self {
                Some(reason)
            } else {
                None
            },
            operation_id: operation.map(|op| op.id),
            version: operation.map(|op| op.selection.version.clone()),
            revision: operation.map(|op| op.selection.revision.clone()),
            received_bytes: operation.map(|op| op.received),
            total_bytes: operation.and_then(|op| op.total),
            source: operation.and_then(|op| op.source),
            error: if let Self::Failed { error, .. } = self {
                Some(error)
            } else {
                None
            },
        }
    }
}

enum Work {
    Download {
        id: Uuid,
        selection: Selection,
        cancel: watch::Receiver<bool>,
        finished: oneshot::Sender<()>,
    },
    Install {
        id: Uuid,
        package: package::Prepared,
    },
}

pub(super) struct Owner {
    state: Arc<Mutex<State>>,
    requests: tokio::sync::Mutex<()>,
    commands: Option<mpsc::Sender<Work>>,
    finished: tokio::sync::Mutex<Option<oneshot::Receiver<()>>>,
    closing: watch::Sender<bool>,
    version: Option<String>,
}

impl Owner {
    #[cfg(test)]
    pub fn disabled() -> Self {
        Self::unavailable("untrusted-build", watch::channel(false).0)
    }

    fn unavailable(reason: &'static str, closing: watch::Sender<bool>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::Unavailable(reason))),
            requests: Default::default(),
            commands: None,
            finished: Default::default(),
            closing,
            version: None,
        }
    }

    pub fn new(config: &super::Config, closing: watch::Sender<bool>) -> Self {
        let options = match &config.update {
            Config::Unavailable(reason) => return Self::unavailable(reason, closing),
            Config::Enabled(options) => options.clone(),
        };
        if !cfg!(windows) {
            return Self::unavailable("unsupported-platform", closing);
        }
        if options
            .version
            .strip_prefix('v')
            .and_then(|version| semver::Version::parse(version).ok())
            .is_none()
        {
            return Self::unavailable("untrusted-build", closing);
        }
        let installation = match package::Installation::inspect(&options, config) {
            Ok(installation) => installation,
            Err(error) => {
                log::info!(target: "piik.update", "Manual update required: {error:#}");
                return Self::unavailable("unmanaged-installation", closing);
            }
        };
        let version = Some(options.version.clone());
        let state = Arc::new(Mutex::new(State::Idle));
        let (commands, incoming) = mpsc::channel(1);
        let (finished, ended) = oneshot::channel();
        let owned_state = state.clone();
        let owned_closing = closing.clone();
        // The process owns this one network runtime. System DNS cannot hold up
        // the App runtime's shutdown, and cancellation still drops response bodies.
        let thread = std::thread::Builder::new()
            .name("piik-app-update".into())
            .spawn(move || {
                match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .max_blocking_threads(2)
                    .build()
                {
                    Ok(runtime) => {
                        runtime.block_on(worker(
                            options,
                            installation,
                            owned_state,
                            incoming,
                            owned_closing,
                        ));
                        runtime.shutdown_background();
                    }
                    Err(error) => {
                        log::error!(target: "piik.update", "Start update runtime: {error}");
                        *owned_state.lock().unwrap() = State::Unavailable("updater-unavailable");
                    }
                }
                let _ = finished.send(());
            });
        if thread.is_err() {
            return Self::unavailable("updater-unavailable", closing);
        }
        Self {
            state,
            requests: Default::default(),
            commands: Some(commands),
            finished: tokio::sync::Mutex::new(Some(ended)),
            closing,
            version,
        }
    }

    pub fn view(&self) -> View {
        self.state.lock().unwrap().view()
    }
    pub fn supported(&self) -> bool {
        !matches!(*self.state.lock().unwrap(), State::Unavailable(_))
    }

    pub async fn request(&self, request: Request) -> std::result::Result<View, &'static str> {
        let _request = self.requests.lock().await;
        if *self.closing.borrow() {
            return Err("app-closing");
        }
        let commands = self.commands.as_ref().ok_or("update-unavailable")?;
        match request {
            Request::Download { version, revision } => {
                let selection = Selection { version, revision };
                package::validate_selection(self.version.as_deref().unwrap(), &selection)
                    .map_err(|_| "invalid-release")?;
                let mut state = self.state.lock().unwrap();
                if !matches!(*state, State::Idle | State::Failed { .. }) {
                    return Err("update-busy");
                }
                let id = Uuid::new_v4();
                let (cancel, cancelled) = watch::channel(false);
                let (finished, ended) = oneshot::channel();
                *state = State::Downloading {
                    operation: Operation {
                        id,
                        selection: selection.clone(),
                        received: 0,
                        total: None,
                        source: None,
                    },
                    cancel,
                    finished: Some(ended),
                };
                if commands
                    .try_send(Work::Download {
                        id,
                        selection,
                        cancel: cancelled,
                        finished,
                    })
                    .is_err()
                {
                    *state = State::Unavailable("updater-unavailable");
                    return Err("update-unavailable");
                }
            }
            Request::Cancel { operation_id } => {
                let ended = {
                    let mut state = self.state.lock().unwrap();
                    if state.operation().map(|op| op.id) != Some(operation_id) {
                        return Err("stale-operation");
                    }
                    match &mut *state {
                        State::Downloading {
                            cancel, finished, ..
                        } => {
                            cancel.send_replace(true);
                            finished.take()
                        }
                        State::Ready { .. } | State::Failed { .. } => {
                            *state = State::Idle;
                            None
                        }
                        _ => return Err("update-busy"),
                    }
                };
                if let Some(ended) = ended {
                    let _ = ended.await;
                }
            }
            Request::Install { operation_id } => {
                let mut state = self.state.lock().unwrap();
                if state.operation().map(|op| op.id) != Some(operation_id) {
                    return Err("stale-operation");
                }
                if !matches!(*state, State::Ready { .. }) {
                    return Err("update-not-ready");
                }
                let State::Ready { operation, package } =
                    std::mem::replace(&mut *state, State::Idle)
                else {
                    unreachable!()
                };
                *state = State::Installing(operation);
                if commands
                    .try_send(Work::Install {
                        id: operation_id,
                        package,
                    })
                    .is_err()
                {
                    let State::Installing(operation) = std::mem::replace(&mut *state, State::Idle)
                    else {
                        unreachable!()
                    };
                    *state = State::Failed {
                        operation,
                        error: "install-failed",
                    };
                    return Err("update-unavailable");
                }
            }
        }
        Ok(self.view())
    }

    pub async fn shutdown(&self) {
        if let Some(ended) = self.finished.lock().await.take() {
            let _ = ended.await;
        }
    }
}

async fn worker(
    options: Options,
    installation: package::Installation,
    state: Arc<Mutex<State>>,
    mut incoming: mpsc::Receiver<Work>,
    closing: watch::Sender<bool>,
) {
    let mut stopped = closing.subscribe();
    loop {
        if *stopped.borrow() {
            break;
        }
        let work = tokio::select! {
            _ = stopped.changed() => break,
            work = incoming.recv() => match work { Some(work) => work, None => break },
        };
        match work {
            Work::Download {
                id,
                selection,
                mut cancel,
                finished,
            } => {
                let progress = |received, total, source| {
                    if let State::Downloading { operation, .. } = &mut *state.lock().unwrap() {
                        if operation.id == id {
                            operation.received = received;
                            operation.total = Some(total);
                            operation.source = Some(source);
                        }
                    }
                };
                let result = tokio::select! {
                    biased;
                    _ = stopped.changed() => None,
                    _ = cancel.changed() => None,
                    result = download::prepare(&options, &installation, id, &selection, progress) => Some(result),
                };
                let mut current = state.lock().unwrap();
                if current.operation().map(|op| op.id) == Some(id) {
                    let State::Downloading { operation, .. } =
                        std::mem::replace(&mut *current, State::Idle)
                    else {
                        unreachable!()
                    };
                    if !*cancel.borrow() && !*stopped.borrow() {
                        match result {
                            Some(Ok(package)) => *current = State::Ready { operation, package },
                            Some(Err(error)) => {
                                log::warn!(target: "piik.update", "Download update: {error:#}");
                                *current = State::Failed {
                                    operation,
                                    error: "download-failed",
                                };
                            }
                            None => {}
                        }
                    }
                }
                drop(current);
                let _ = finished.send(());
            }
            Work::Install { id, package } => {
                #[cfg(windows)]
                let result =
                    windows::handoff(&options, &installation, package, closing.subscribe()).await;
                #[cfg(not(windows))]
                let result: Result<()> = {
                    drop(package);
                    Err(anyhow!("unsupported platform"))
                };
                match result {
                    Ok(()) => {
                        closing.send_replace(true);
                    }
                    Err(error) => {
                        log::error!(target: "piik.update", "Install update: {error:#}");
                        let mut current = state.lock().unwrap();
                        if current.operation().map(|op| op.id) == Some(id) {
                            let State::Installing(operation) =
                                std::mem::replace(&mut *current, State::Idle)
                            else {
                                unreachable!()
                            };
                            *current = State::Failed {
                                operation,
                                error: "install-failed",
                            };
                        }
                    }
                }
            }
        }
    }
    let mut current = state.lock().unwrap();
    if !matches!(*current, State::Installing(_)) {
        *current = State::Idle;
    }
}

/// The copied installed executable handles this before capture, windows or data open.
pub fn helper_entry() -> Result<bool> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--apply-update")) {
        return Ok(false);
    }
    let path = args
        .next()
        .ok_or_else(|| anyhow!("Update plan is missing"))?;
    anyhow::ensure!(args.next().is_none(), "Unexpected update arguments");
    #[cfg(windows)]
    windows::run(PathBuf::from(path))?;
    #[cfg(not(windows))]
    {
        let _ = path;
        anyhow::bail!("Automatic installation is unavailable on this platform");
    }
    Ok(true)
}

#[cfg(test)]
#[path = "app_update/tests.rs"]
mod tests;
