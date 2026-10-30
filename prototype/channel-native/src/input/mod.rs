//! Source consent and physical input share one process-owned desktop executor.
//! Room admission and selected-route validation happen before registration here.
mod cipher;
mod gamepad;
mod keyboard;
#[cfg(all(feature = "capture", target_os = "linux"))]
pub(crate) mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
mod tests;
#[cfg(target_os = "windows")]
mod windows;

use crate::capture::Target;
use anyhow::{anyhow, bail, ensure, Result};
use cipher::Cipher;
use futures_util::future::{AbortHandle, Abortable};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

const MAX_CONTROLLERS: usize = 20;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Off,
    Ask,
    Room,
    Password,
}

/// Trusted domain registration, never accepted from an input relay.
pub struct Registration {
    pub controller: Uuid,
    pub flow: Uuid,
    pub secret: [u8; 32],
}

#[derive(Clone, Debug)]
pub struct Reply {
    pub publication: Uuid,
    pub controller: Uuid,
    pub flow: Uuid,
    /// The encrypted inner packet's `data`, with id=controller.simple()/epoch=flow.simple().
    pub data: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestView {
    pub id: String,
    pub peer_id: Uuid,
    pub state: &'static str,
    pub endpoint_id: String,
}

/// Matches the shared native remote-control state, without secret or grant tokens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    pub mode: Mode,
    pub platform: &'static str,
    pub requests: Vec<RequestView>,
    pub co_play: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gamepad: Option<bool>,
    pub simultaneous: bool,
    pub can_set_stop_shortcut: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_shortcut: Option<u8>,
}

#[derive(Clone)]
pub struct Desktop(
    Arc<Mutex<Executor>>,
    #[cfg(target_os = "windows")] Arc<Mutex<Option<windows::Shortcut>>>,
    #[cfg(target_os = "macos")] Arc<Mutex<Option<macos::Shortcut>>>,
);

/// Clones refer to the same capture identity. Explicit close retires every clone.
#[derive(Clone)]
pub struct Source(Arc<SourceHandle>);
struct SourceHandle {
    desktop: Desktop,
    video: Uuid,
    publication: Uuid,
}
impl Drop for SourceHandle {
    fn drop(&mut self) {
        self.desktop.0.lock().unwrap().close(self.video);
    }
}

impl Desktop {
    pub fn new() -> Result<Self> {
        // Opening the optional bus must never hold the input executor lock.
        let gamepad = gamepad::Backend::connect().ok();
        #[cfg(target_os = "windows")]
        {
            Ok(Self::with_backend(Box::new(windows::System), gamepad))
        }
        #[cfg(target_os = "macos")]
        {
            Ok(Self::with_backend(
                Box::new(macos::System::default()),
                gamepad,
            ))
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            Ok(Self::with_backend(Box::new(Unsupported), gamepad))
        }
    }

    #[cfg(test)]
    fn with_sink(sink: Box<dyn Sink>) -> Self {
        Self::with_backend(sink, None)
    }

    fn with_backend(sink: Box<dyn Sink>, gamepad: Option<gamepad::Backend>) -> Self {
        Self(
            Arc::new(Mutex::new(Executor {
                sink,
                sources: BTreeMap::new(),
                owner: None,
                releases: BTreeMap::new(),
                gamepad,
            })),
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            Arc::new(Mutex::new(None)),
        )
    }

    /// Browser preferences own the key; Native holds only this process binding.
    pub fn set_shortcut(&self, key: u8) -> Result<()> {
        ensure!((1..=11).contains(&key), "invalid_input_shortcut");
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let mut current = self.1.lock().unwrap();
            if current.as_ref().is_some_and(|shortcut| shortcut.key == key) {
                return Ok(());
            }
            #[cfg(target_os = "windows")]
            let next = windows::Shortcut::new(key, Arc::downgrade(&self.0))?;
            #[cfg(target_os = "macos")]
            let next = macos::Shortcut::new(key)?;
            *current = Some(next);
            for source in self.0.lock().unwrap().sources.values() {
                source
                    .view
                    .send_modify(|view| view.stop_shortcut = Some(key));
            }
            Ok(())
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            bail!("input_platform_unavailable")
        }
    }

    pub fn source(
        &self,
        publication: Uuid,
        video: Uuid,
        target: Target,
    ) -> Result<(Source, mpsc::Receiver<Reply>, watch::Receiver<SourceView>)> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let shortcut = self.1.lock().unwrap();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let shortcut_view = shortcut.as_ref().map(|s| s.key);
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let shortcut_view = None;
        let mut executor = self.0.lock().unwrap();
        ensure!(
            !executor.sources.contains_key(&video),
            "input_source_already_active"
        );
        let (replies, receiver) = mpsc::channel(64);
        let (view, changed) = watch::channel(SourceView {
            mode: Mode::Off,
            platform: platform(),
            requests: vec![],
            co_play: true,
            gamepad: cfg!(target_os = "windows").then_some(executor.gamepad.is_some()),
            simultaneous: false,
            can_set_stop_shortcut: cfg!(any(target_os = "windows", target_os = "macos")),
            stop_shortcut: shortcut_view,
        });
        executor.sources.insert(
            video,
            SourceState {
                publication,
                target,
                endpoint: Endpoint::default(),
                permission: None,
                mode: Mode::Off,
                password: [0; 32],
                password_retry: None,
                simultaneous: false,
                available: true,
                controllers: BTreeMap::new(),
                replies,
                view,
            },
        );
        Ok((
            Source(Arc::new(SourceHandle {
                desktop: self.clone(),
                video,
                publication,
            })),
            receiver,
            changed,
        ))
    }

    /// The App owns one 100 ms observation/cleanup tick across its sites and sources.
    pub fn tick(&self) {
        #[cfg(target_os = "macos")]
        if self
            .1
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(macos::Shortcut::pressed)
        {
            self.revoke();
        }
        let mut executor = self.0.lock().unwrap();
        executor.retry_releases();
        if let Some(video) = executor.owner {
            let _ = executor.with_source(video, |e, source| {
                for c in source.controllers.values_mut() {
                    if c.pad.as_mut().is_some_and(|pad| pad.error().is_some()) {
                        c.fail_pad();
                    }
                }
                e.observe(source);
                Ok(())
            });
        }
    }

    pub fn revoke(&self) {
        self.0.lock().unwrap().revoke();
    }

    pub fn close(&self) {
        let mut executor = self.0.lock().unwrap();
        let ids: Vec<_> = executor.sources.keys().copied().collect();
        for id in ids {
            executor.close(id);
        }
        executor.retry_releases();
        let gamepad = executor.gamepad.take();
        drop(executor);
        if let Some(gamepad) = gamepad {
            gamepad.shutdown();
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        self.1.lock().unwrap().take();
    }
}

impl Source {
    pub fn publication(&self) -> Uuid {
        self.0.publication
    }
    pub fn video(&self) -> Uuid {
        self.0.video
    }
    fn run(
        &self,
        action: impl FnOnce(&mut Executor, &mut SourceState) -> Result<()>,
    ) -> Result<()> {
        self.0
            .desktop
            .0
            .lock()
            .unwrap()
            .with_source(self.0.video, action)
    }
    pub fn close(&self) {
        self.0.desktop.0.lock().unwrap().close(self.0.video);
    }

    pub fn set_mode(&self, mode: Mode) -> Result<()> {
        self.set_policy(mode, "")
    }
    pub fn set_policy(&self, mode: Mode, password: &str) -> Result<()> {
        let password = policy_password(mode, password)?;
        self.run(|e, source| {
            source.cancel_permission();
            e.set_policy(source, mode, password)
        })
    }

    /// Begin in request order; an OS dialog never holds the desktop executor lock.
    pub(crate) fn configure<F: std::future::Future<Output = Result<()>> + Send + 'static>(
        &self,
        mode: Mode,
        password: Option<String>,
        simultaneous: Option<bool>,
        authorize: impl FnOnce(AbortHandle) -> F + Send + 'static,
    ) -> Result<impl std::future::Future<Output = Result<()>> + Send + 'static> {
        let (request, registration) = AbortHandle::new_pair();
        let mut changed_password = None;
        self.run(|_, source| {
            if password.is_some() || source.mode != mode {
                changed_password = Some(policy_password(mode, password.as_deref().unwrap_or(""))?);
            }
            source.cancel_permission();
            source.permission = Some(request.clone());
            Ok(())
        })?;
        let source = self.clone();
        Ok(async move {
            let permit = request.clone();
            let result = Abortable::new(
                async move {
                    if mode != Mode::Off {
                        authorize(permit).await?;
                    }
                    Ok(())
                },
                registration,
            )
            .await
            .unwrap_or_else(|_| Err(anyhow!("input_authorization_cancelled")));
            source
                .run(|e, source| {
                    ensure!(!request.is_aborted(), "input_authorization_cancelled");
                    source.permission.take();
                    result?;
                    if let Some(password) = changed_password {
                        e.set_policy(source, mode, password)?;
                    }
                    if let Some(enabled) = simultaneous {
                        e.set_simultaneous(source, enabled);
                    }
                    Ok(())
                })
                .map_err(|error| {
                    if request.is_aborted() {
                        anyhow!("input_authorization_cancelled")
                    } else {
                        error
                    }
                })
        })
    }

    #[cfg(all(feature = "capture", target_os = "linux"))]
    pub(crate) fn has_endpoint(&self) -> bool {
        self.0
            .desktop
            .0
            .lock()
            .unwrap()
            .sources
            .get(&self.0.video)
            .is_some_and(|source| matches!(source.endpoint, Endpoint::Portal(_)))
    }

    /// The capture owner commits the selected Portal and its input authority together.
    #[cfg(all(feature = "capture", target_os = "linux"))]
    pub(crate) fn bind_endpoint(
        &self,
        endpoint: linux::Endpoint,
        request: &AbortHandle,
    ) -> Result<()> {
        self.run(|e, source| {
            ensure!(!request.is_aborted(), "input_authorization_cancelled");
            ensure!(source.available, "input_source_unavailable");
            e.revoke_all(source);
            source.endpoint = Endpoint::Portal(endpoint);
            Ok(())
        })
    }

    pub fn set_simultaneous(&self, enabled: bool) -> Result<()> {
        self.run(|e, source| {
            source.cancel_permission();
            e.set_simultaneous(source, enabled);
            Ok(())
        })
    }

    pub fn register(&self, registration: Registration) -> Result<()> {
        self.run(|e, source| {
            if source
                .controllers
                .get(&registration.controller)
                .is_some_and(|c| c.flow == registration.flow && c.secret == registration.secret)
            {
                return Ok(());
            }
            if let Some(mut old) = source.controllers.remove(&registration.controller) {
                e.release(source, &mut old);
            }
            ensure!(
                source.controllers.len() < MAX_CONTROLLERS,
                "input_controller_limit"
            );
            source.controllers.insert(
                registration.controller,
                Controller {
                    flow: registration.flow,
                    secret: registration.secret,
                    cipher: Cipher::new(&registration.secret),
                    intent: None,
                    grant: None,
                    held: BTreeSet::new(),
                    suspended: false,
                    failed: false,
                    reason: None,
                    last: None,
                    pad: None,
                    pad_failed: false,
                },
            );
            Ok(())
        })
    }

    pub fn retire(&self, controller: Uuid, flow: Uuid) -> Result<()> {
        self.run(|e, source| {
            if source
                .controllers
                .get(&controller)
                .is_some_and(|c| c.flow == flow)
            {
                let mut c = source.controllers.remove(&controller).unwrap();
                e.release(source, &mut c);
            }
            Ok(())
        })
    }

    /// Carrier loss ends consent, while the domain-owned registration and its
    /// replay counter survive until the selected flow/secret is actually retired.
    pub fn release(&self, controller: Uuid, flow: Uuid) -> Result<()> {
        self.run(|e, source| {
            if source
                .controllers
                .get(&controller)
                .is_some_and(|c| c.flow == flow)
            {
                let mut c = source.controllers.remove(&controller).unwrap();
                e.release(source, &mut c);
                source.controllers.insert(controller, c);
            }
            Ok(())
        })
    }

    pub fn decide(&self, controller: Uuid, intent: Uuid, allow: bool) -> Result<()> {
        let video = self.0.video;
        self.run(|e, source| {
            ensure!(
                source
                    .controllers
                    .get(&controller)
                    .is_some_and(|c| c.intent == Some(intent)),
                "input_request_retired"
            );
            let mut c = source.controllers.remove(&controller).unwrap();
            let result = if allow && c.grant.is_none() {
                // Explicit handover may replace this source's exclusive controller.
                if !source.simultaneous {
                    e.revoke_all(source);
                }
                e.grant(video, source, &mut c)
            } else {
                if !allow {
                    e.release(source, &mut c);
                }
                Ok(())
            };
            source.controllers.insert(controller, c);
            result
        })
    }

    pub fn receive(&self, controller: Uuid, flow: Uuid, data: &str) -> Result<()> {
        let video = self.0.video;
        self.run(|e, source| {
            let Some(c) = source
                .controllers
                .get_mut(&controller)
                .filter(|c| c.flow == flow)
            else {
                return Ok(());
            };
            // Relay garbage has no authority and must not revoke a legitimate grant.
            let Ok(plain) = c.cipher.open(data, flow) else {
                return Ok(());
            };
            let Ok(command) = serde_json::from_slice::<Command>(&plain) else {
                return Ok(());
            };
            let mut c = source.controllers.remove(&controller).unwrap();
            let result = e.command(video, source, &mut c, command);
            source.controllers.insert(controller, c);
            result
        })
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Bounds {
    left: i32,
    top: i32,
    width: i32,
    height: i32,
}
enum TargetState {
    Ready(Bounds),
    Suspended,
    Lost,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Held {
    Key(u16),
    Button(u8),
}
#[derive(Clone, Debug, PartialEq)]
enum Action {
    Move(f64, f64),
    Relative(i32, i32),
    Held(Held, bool),
    Wheel(i32),
    Text(String),
}
trait Sink: Send {
    /// Called only by the source page enabling control, never by remote requests.
    fn authorize(&mut self) -> Result<()> {
        Ok(())
    }
    fn observe(&mut self, target: &Target) -> TargetState;
    fn apply(&mut self, bounds: Bounds, action: &Action) -> Result<()>;
}

#[derive(Clone, Default)]
enum Endpoint {
    #[default]
    System,
    #[cfg(all(feature = "capture", target_os = "linux"))]
    Portal(linux::Endpoint),
}
impl Endpoint {
    fn authorize(&self, sink: &mut dyn Sink) -> Result<()> {
        match self {
            Self::System => sink.authorize(),
            #[cfg(all(feature = "capture", target_os = "linux"))]
            Self::Portal(endpoint) => match endpoint.observe() {
                TargetState::Ready(_) => Ok(()),
                _ => bail!("input_source_unavailable"),
            },
        }
    }
    fn observe(&self, sink: &mut dyn Sink, target: &Target) -> TargetState {
        match self {
            Self::System => sink.observe(target),
            #[cfg(all(feature = "capture", target_os = "linux"))]
            Self::Portal(endpoint) => endpoint.observe(),
        }
    }
    fn apply(&self, sink: &mut dyn Sink, bounds: Bounds, action: &Action) -> Result<()> {
        match self {
            Self::System => sink.apply(bounds, action),
            #[cfg(all(feature = "capture", target_os = "linux"))]
            Self::Portal(endpoint) => endpoint.apply(bounds, action),
        }
    }
    fn has_text(&self) -> bool {
        match self {
            Self::System => cfg!(any(target_os = "windows", target_os = "macos")),
            #[cfg(all(feature = "capture", target_os = "linux"))]
            Self::Portal(endpoint) => endpoint.has_text(),
        }
    }
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
struct Unsupported;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl Sink for Unsupported {
    fn authorize(&mut self) -> Result<()> {
        bail!("input_permission_required")
    }
    fn observe(&mut self, _: &Target) -> TargetState {
        TargetState::Lost
    }
    fn apply(&mut self, _: Bounds, _: &Action) -> Result<()> {
        bail!("input_platform_unavailable")
    }
}

struct Executor {
    sink: Box<dyn Sink>,
    sources: BTreeMap<Uuid, SourceState>,
    owner: Option<Uuid>,
    /// Only failed releases survive their grant; never replay presses or motion.
    releases: BTreeMap<Held, Endpoint>,
    gamepad: Option<gamepad::Backend>,
}
struct SourceState {
    publication: Uuid,
    target: Target,
    endpoint: Endpoint,
    permission: Option<AbortHandle>,
    mode: Mode,
    password: [u8; 32],
    password_retry: Option<Instant>,
    simultaneous: bool,
    available: bool,
    controllers: BTreeMap<Uuid, Controller>,
    replies: mpsc::Sender<Reply>,
    view: watch::Sender<SourceView>,
}
impl SourceState {
    fn cancel_permission(&mut self) {
        if let Some(request) = self.permission.take() {
            request.abort();
        }
    }
}

fn policy_password(mode: Mode, password: &str) -> Result<[u8; 32]> {
    ensure!(
        password.len() <= 512 && (mode == Mode::Password) == !password.is_empty(),
        "invalid_input_policy"
    );
    Ok(Sha256::digest(password.as_bytes()).into())
}
struct Controller {
    flow: Uuid,
    secret: [u8; 32],
    cipher: Cipher,
    intent: Option<Uuid>,
    grant: Option<String>,
    held: BTreeSet<Held>,
    suspended: bool,
    failed: bool,
    reason: Option<&'static str>,
    last: Option<RemoteState>,
    pad: Option<gamepad::Pad>,
    pad_failed: bool,
}

impl Controller {
    fn fail_pad(&mut self) {
        self.pad.take();
        self.pad_failed = true;
        self.reason = Some("gamepad");
    }

    fn reset_pad(&mut self) {
        if self.pad.as_ref().is_some_and(|pad| pad.reset().is_err()) {
            self.fail_pad();
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteState {
    state: &'static str,
    mode: Mode,
    platform: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    intent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    co_play: bool,
    capabilities: Vec<&'static str>,
    input_failed: bool,
}

impl Executor {
    fn set_policy(
        &mut self,
        source: &mut SourceState,
        mode: Mode,
        password: [u8; 32],
    ) -> Result<()> {
        ensure!(
            source.available || mode == Mode::Off,
            "input_source_unavailable"
        );
        if mode != Mode::Off {
            source.endpoint.authorize(self.sink.as_mut())?;
        }
        self.revoke_all(source);
        source.mode = mode;
        source.password = password;
        Ok(())
    }

    fn set_simultaneous(&mut self, source: &mut SourceState, enabled: bool) {
        if source.simultaneous != enabled {
            self.revoke_all(source);
            source.simultaneous = enabled;
        }
    }

    fn revoke(&mut self) {
        let ids: Vec<_> = self.sources.keys().copied().collect();
        for id in ids {
            let _ = self.with_source(id, |e, source| {
                source.cancel_permission();
                e.revoke_all(source);
                // Local stop requires fresh consent, including automatic modes.
                if source.mode != Mode::Off {
                    source.mode = Mode::Ask;
                    source.password = [0; 32];
                }
                Ok(())
            });
        }
    }
    fn with_source(
        &mut self,
        video: Uuid,
        action: impl FnOnce(&mut Self, &mut SourceState) -> Result<()>,
    ) -> Result<()> {
        let mut source = self
            .sources
            .remove(&video)
            .ok_or_else(|| anyhow!("input_source_retired"))?;
        let result = action(self, &mut source);
        self.emit(&mut source);
        if self.owner == Some(video) && !source.controllers.values().any(|c| c.grant.is_some()) {
            self.owner = None;
        }
        self.sources.insert(video, source);
        result
    }

    fn close(&mut self, video: Uuid) {
        if let Some(mut source) = self.sources.remove(&video) {
            source.cancel_permission();
            source.available = false;
            self.revoke_all(&mut source);
            self.emit(&mut source);
        }
        if self.owner == Some(video) {
            self.owner = None;
        }
    }

    fn retry_releases(&mut self) {
        let sink = self.sink.as_mut();
        self.releases.retain(|held, endpoint| {
            endpoint
                .apply(sink, Bounds::default(), &Action::Held(*held, false))
                .is_err()
        });
    }

    fn release_holds(&mut self, source: &SourceState, c: &mut Controller) {
        for held in std::mem::take(&mut c.held) {
            if !source
                .controllers
                .values()
                .any(|other| other.held.contains(&held))
                && source
                    .endpoint
                    .apply(
                        self.sink.as_mut(),
                        Bounds::default(),
                        &Action::Held(held, false),
                    )
                    .is_err()
            {
                self.releases.insert(held, source.endpoint.clone());
            }
        }
    }
    fn release(&mut self, source: &SourceState, c: &mut Controller) {
        self.release_holds(source, c);
        c.pad.take();
        c.pad_failed = false;
        c.intent = None;
        c.grant = None;
        c.suspended = false;
        c.failed = false;
        c.reason = None;
    }
    fn revoke_all(&mut self, source: &mut SourceState) {
        let ids: Vec<_> = source.controllers.keys().copied().collect();
        for id in ids {
            let mut c = source.controllers.remove(&id).unwrap();
            self.release(source, &mut c);
            source.controllers.insert(id, c);
        }
    }

    fn observe(&mut self, source: &mut SourceState) -> Option<Bounds> {
        match source.endpoint.observe(self.sink.as_mut(), &source.target) {
            TargetState::Ready(bounds) => {
                for c in source.controllers.values_mut() {
                    c.suspended = false;
                }
                Some(bounds)
            }
            TargetState::Suspended => {
                let ids: Vec<_> = source.controllers.keys().copied().collect();
                for id in ids {
                    let mut c = source.controllers.remove(&id).unwrap();
                    if c.grant.is_some() {
                        self.release_holds(source, &mut c);
                        if !c.suspended {
                            c.reset_pad();
                        }
                        c.suspended = true;
                    }
                    source.controllers.insert(id, c);
                }
                None
            }
            TargetState::Lost => {
                source.available = false;
                self.revoke_all(source);
                None
            }
        }
    }

    fn grant(&mut self, video: Uuid, source: &mut SourceState, c: &mut Controller) -> Result<()> {
        ensure!(
            source.available && source.mode != Mode::Off,
            "input_source_unavailable"
        );
        if self.owner.is_some_and(|owner| owner != video)
            || (!source.simultaneous
                && source
                    .controllers
                    .values()
                    .any(|other| other.grant.is_some()))
        {
            c.reason = Some("busy");
            c.intent = None;
            bail!("input_busy");
        }
        let mut token = [0; 32];
        getrandom::fill(&mut token).map_err(|_| anyhow!("input_random_unavailable"))?;
        c.grant = Some(token.iter().map(|byte| format!("{byte:02x}")).collect());
        c.reason = None;
        self.owner = Some(video);
        match source.endpoint.observe(self.sink.as_mut(), &source.target) {
            TargetState::Ready(_) => c.suspended = false,
            TargetState::Suspended => c.suspended = true,
            TargetState::Lost => {
                source.available = false;
                self.release(source, c);
                self.revoke_all(source);
            }
        }
        Ok(())
    }

    fn command(
        &mut self,
        video: Uuid,
        source: &mut SourceState,
        c: &mut Controller,
        command: Command,
    ) -> Result<()> {
        match command {
            Command::Sync | Command::Capabilities { .. } => c.last = None,
            Command::Release { intent } => {
                if c.intent == Some(intent) {
                    self.release(source, c);
                }
            }
            Command::Request { intent, password } => {
                if !source.available || source.mode == Mode::Off {
                    c.last = None;
                    return Ok(());
                }
                if c.intent == Some(intent) {
                    return Ok(());
                }
                self.release(source, c);
                c.intent = Some(intent);
                match source.mode {
                    Mode::Ask => {}
                    Mode::Room => self.grant(video, source, c)?,
                    Mode::Password => {
                        let now = Instant::now();
                        let digest: [u8; 32] =
                            Sha256::digest(password.as_deref().unwrap_or("").as_bytes()).into();
                        c.reason = if source.password_retry.is_some_and(|deadline| now < deadline) {
                            Some("retry")
                        } else {
                            source.password_retry = Some(now + Duration::from_secs(1));
                            (!bool::from(digest.ct_eq(&source.password))).then_some("password")
                        };
                        if c.reason.is_some() {
                            c.intent = None;
                        } else {
                            self.grant(video, source, c)?;
                        }
                    }
                    Mode::Off => {}
                }
            }
            Command::Input { grant, event } => {
                if c.grant.as_deref() != Some(&grant) || !source.available {
                    return Ok(());
                }
                self.retry_releases();
                match &event {
                    InputEvent::Gamepad { gamepad } if !gamepad.valid() => return Ok(()),
                    InputEvent::GamepadStop => {
                        c.pad.take();
                        return Ok(());
                    }
                    InputEvent::GamepadReset => {
                        c.reset_pad();
                        return Ok(());
                    }
                    _ => {}
                }
                if matches!(event, InputEvent::Reset) {
                    self.release_holds(source, c);
                    c.reset_pad();
                    return Ok(());
                }
                let bounds = match source.endpoint.observe(self.sink.as_mut(), &source.target) {
                    TargetState::Ready(bounds) => {
                        c.suspended = false;
                        bounds
                    }
                    TargetState::Suspended => {
                        self.release_holds(source, c);
                        if !c.suspended {
                            c.reset_pad();
                        }
                        c.suspended = true;
                        return Ok(());
                    }
                    TargetState::Lost => {
                        source.available = false;
                        self.release(source, c);
                        self.revoke_all(source);
                        return Ok(());
                    }
                };
                if let InputEvent::Gamepad { gamepad } = event {
                    if c.pad_failed {
                        return Ok(());
                    }
                    let result = (|| {
                        if c.pad.is_none() {
                            let backend = self
                                .gamepad
                                .as_ref()
                                .ok_or_else(|| anyhow!("gamepad_unavailable"))?;
                            c.pad = Some(backend.open()?);
                        }
                        c.pad.as_ref().unwrap().update(gamepad)
                    })();
                    if result.is_err() {
                        c.fail_pad();
                    }
                    return Ok(());
                }
                let Some(action) = event.action() else {
                    return Ok(());
                };
                let releasing = matches!(action, Action::Held(_, false));
                if !releasing && !self.releases.is_empty() {
                    c.failed = true;
                    return Ok(());
                }
                let result = match &action {
                    Action::Held(held, down) => {
                        if *down {
                            let shared = source
                                .controllers
                                .values()
                                .any(|other| other.held.contains(held));
                            let result = if c.held.contains(held) || !shared {
                                source.endpoint.apply(self.sink.as_mut(), bounds, &action)
                            } else {
                                Ok(())
                            };
                            if result.is_ok() {
                                c.held.insert(*held);
                            }
                            result
                        } else if c.held.remove(held)
                            && !source
                                .controllers
                                .values()
                                .any(|other| other.held.contains(held))
                        {
                            let result = source.endpoint.apply(self.sink.as_mut(), bounds, &action);
                            if result.is_err() {
                                self.releases.insert(*held, source.endpoint.clone());
                            }
                            result
                        } else {
                            Ok(())
                        }
                    }
                    Action::Text(_) => {
                        if source
                            .controllers
                            .values()
                            .any(|other| other.grant.is_some())
                        {
                            return Ok(());
                        }
                        self.release_holds(source, c);
                        if self.releases.is_empty() {
                            source.endpoint.apply(self.sink.as_mut(), bounds, &action)
                        } else {
                            Err(anyhow!("input_cleanup_pending"))
                        }
                    }
                    _ => source.endpoint.apply(self.sink.as_mut(), bounds, &action),
                };
                // A rejected operation is not permission revocation and is never replayed.
                c.failed = result.is_err();
            }
        }
        Ok(())
    }

    fn emit(&mut self, source: &mut SourceState) {
        let count = source
            .controllers
            .values()
            .filter(|c| c.grant.is_some())
            .count();
        let ids: Vec<_> = source.controllers.keys().copied().collect();
        for id in ids {
            let mut c = source.controllers.remove(&id).unwrap();
            let mut capabilities = vec!["inputFeedback"];
            if count <= 1 && source.endpoint.has_text() {
                capabilities.push("text");
            }
            if self.gamepad.is_some() && !c.pad_failed {
                capabilities.push("gamepad");
            }
            let state = RemoteState {
                state: if !source.available || source.mode == Mode::Off {
                    "unavailable"
                } else if c.grant.is_some() {
                    if c.suspended {
                        "suspended"
                    } else {
                        "active"
                    }
                } else if c.intent.is_some() {
                    "pending"
                } else {
                    "ready"
                },
                mode: source.mode,
                platform: platform(),
                intent: c.intent.map(|id| id.simple().to_string()),
                grant: c.grant.clone(),
                reason: c.reason,
                co_play: true,
                capabilities,
                input_failed: c.failed,
            };
            if c.last.as_ref() != Some(&state) {
                let reply = serde_json::to_vec(&state)
                    .map_err(anyhow::Error::from)
                    .and_then(|bytes| c.cipher.seal(&bytes, c.flow));
                let sent = reply.is_ok_and(|data| {
                    source
                        .replies
                        .try_send(Reply {
                            publication: source.publication,
                            controller: id,
                            flow: c.flow,
                            data,
                        })
                        .is_ok()
                });
                if sent {
                    c.last = Some(state);
                } else {
                    // Backpressure stops the grant, but the authenticated route
                    // remains registered and its next sync can recover consent.
                    self.release(source, &mut c);
                    c.last = None;
                }
            }
            source.controllers.insert(id, c);
        }
        let view = SourceView {
            mode: source.mode,
            platform: platform(),
            co_play: true,
            gamepad: cfg!(target_os = "windows").then_some(self.gamepad.is_some()),
            simultaneous: source.simultaneous,
            can_set_stop_shortcut: source.view.borrow().can_set_stop_shortcut,
            stop_shortcut: source.view.borrow().stop_shortcut,
            requests: source
                .controllers
                .iter()
                .filter_map(|(id, c)| {
                    c.intent.map(|intent| RequestView {
                        id: intent.simple().to_string(),
                        peer_id: *id,
                        endpoint_id: id.simple().to_string(),
                        state: if c.grant.is_none() {
                            "pending"
                        } else if c.suspended {
                            "suspended"
                        } else {
                            "active"
                        },
                    })
                })
                .collect(),
        };
        source.view.send_if_modified(|current| {
            if *current == view {
                false
            } else {
                *current = view;
                true
            }
        });
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Command {
    Sync,
    Capabilities {
        #[serde(rename = "inputFeedback")]
        _feedback: Option<bool>,
    },
    Request {
        intent: Uuid,
        password: Option<String>,
    },
    Release {
        intent: Uuid,
    },
    #[serde(untagged)]
    Input {
        grant: String,
        #[serde(flatten)]
        event: InputEvent,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum InputEvent {
    Move {
        x: f64,
        y: f64,
    },
    Relative {
        dx: i32,
        dy: i32,
    },
    Key {
        code: String,
        down: bool,
    },
    Button {
        button: u8,
        down: bool,
    },
    Wheel {
        delta: i32,
    },
    Text {
        text: String,
    },
    Reset,
    Gamepad {
        gamepad: gamepad::Report,
    },
    #[serde(rename = "gamepad-reset")]
    GamepadReset,
    #[serde(rename = "gamepad-stop")]
    GamepadStop,
}
impl InputEvent {
    fn action(self) -> Option<Action> {
        match self {
            Self::Move { x, y }
                if x.is_finite()
                    && y.is_finite()
                    && (0.0..=1.0).contains(&x)
                    && (0.0..=1.0).contains(&y) =>
            {
                Some(Action::Move(x, y))
            }
            Self::Relative { dx, dy }
                if (-32767..=32767).contains(&dx) && (-32767..=32767).contains(&dy) =>
            {
                Some(Action::Relative(dx, dy))
            }
            Self::Key { code, down } => {
                keyboard::scan(&code).map(|scan| Action::Held(Held::Key(scan), down))
            }
            Self::Button { button, down } if button <= 4 => {
                Some(Action::Held(Held::Button(button), down))
            }
            Self::Wheel { delta } if (-1200..=1200).contains(&delta) => Some(Action::Wheel(delta)),
            Self::Text { text } if text.len() <= 2048 && !text.contains('\0') => {
                Some(Action::Text(text))
            }
            _ => None,
        }
    }
}
