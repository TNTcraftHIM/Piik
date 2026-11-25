//! Local approval owns site access; the App owns each admitted site's room hosts.
#[path = "app_backup.rs"]
mod backup;
#[path = "app_console.rs"]
mod console;
#[path = "app_terminal.rs"]
mod terminal;
#[path = "app_diagnostics.rs"]
mod diagnostics;
#[path = "app_domain.rs"]
mod hosted;
#[path = "app_sites.rs"]
mod sites;
#[path = "app_tunnel.rs"]
mod tunnel;
#[path = "app_update.rs"]
pub mod update;
#[path = "app_voice_shortcuts.rs"]
mod voice_shortcuts;
#[path = "app_whip.rs"]
mod whip;

#[path = "app_page.rs"]
pub mod page;

use crate::web;
use anyhow::{anyhow, bail, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path, State,
    },
    http::{header, HeaderMap, Request as HttpRequest, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use futures_util::{
    future::{AbortHandle, Abortable, Aborted, BoxFuture, Shared},
    stream::FuturesUnordered,
    FutureExt, SinkExt, StreamExt,
};
use piik_channel_core::RoomState;
use piik_channel_native::{
    capture::{EncodingExecution, Settings, Target, VideoCodec, VideoCodecMode},
    input::{Desktop, Mode, SourceView},
    peer::{
        CaptureAudio, CaptureLease, ExternalLease, SourceAudioSettings, SourceAudioState,
        SourceMicrophoneSettings,
    },
    session::{
        self, CaptureEdit, CommitCapture, EditCapture, HostCommand, Hosting, OpenRoom,
        PauseCapture, PrepareCapture, PublishCaptureSettings, TransferSource,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, future::Future, path::PathBuf, sync::{Arc, Weak}, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, watch, Mutex},
    task::JoinHandle,
    time::timeout,
};
use tower_http::services::ServeDir;
use uuid::Uuid;

const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const SERVICE: &str = "piik-channel-app";
const PROTOCOL: u8 = 26;
const BUILD_VERSION: &str = match option_env!("PIIK_BUILD_VERSION") {
    Some(value) => value,
    None => "development",
};
const BUILD_REVISION: &str = match option_env!("PIIK_BUILD_REVISION") {
    Some(value) => value,
    None => "development",
};
const PACKAGE_TARGET: &str = match option_env!("PIIK_BUILD_TARGET") {
    Some(value) => value,
    None => "",
};

pub type WebsitePermissionReset =
    Arc<dyn Fn(String, oneshot::Sender<std::result::Result<(), String>>) -> bool + Send + Sync>;

pub struct WindowNavigation {
    latest: std::sync::Mutex<u64>,
    dispatch: Box<dyn Fn(String, bool) -> bool + Send + Sync>,
}

impl WindowNavigation {
    pub fn new(dispatch: impl Fn(String, bool) -> bool + Send + Sync + 'static) -> Self {
        Self { latest: std::sync::Mutex::new(0), dispatch: Box::new(dispatch) }
    }
}

pub struct Config {
    pub data_root: PathBuf,
    pub assets: PathBuf,
    pub open_browser: bool,
    /// Startup presentation only; never a source of permission or service state.
    pub terminal_notice: Option<String>,
    pub page_player: Option<page::Dispatcher>,
    pub website_permission_reset: Option<WebsitePermissionReset>,
    pub window_navigation: Option<WindowNavigation>,
    pub cloudflared: PathBuf,
    pub ice_servers: Vec<Value>,
    pub update: update::Config,
}
struct Permission {
    data_id: Uuid,
    revoked: watch::Sender<bool>,
}
impl Permission {
    fn new(data_id: Uuid) -> Self {
        Self {
            data_id,
            revoked: watch::channel(false).0,
        }
    }
}
struct Host {
    credential: String,
    commands: mpsc::Sender<HostCommand>,
    ready: watch::Receiver<Option<Result<(), String>>>,
    stop: watch::Sender<bool>,
    task: HostTask,
}
type HostTask = Shared<BoxFuture<'static, ()>>;

impl Host {
    fn finished(&self) -> bool {
        self.task.clone().now_or_never().is_some()
    }
}
type HostKey = (String, Uuid, Uuid);
struct LocalSite {
    origin: String,
    invitation: String,
    request: hosted::Request,
    permission: Arc<Permission>,
}
struct Registry {
    sites: sites::Sites,
    approvals: BTreeMap<String, Arc<Permission>>,
    hosts: BTreeMap<HostKey, Host>,
    local: Option<LocalSite>,
}
impl Registry {
    fn permission(&self, site: &str) -> Option<&Arc<Permission>> {
        self.local
            .as_ref()
            .filter(|local| local.origin == site)
            .map(|local| &local.permission)
            .or_else(|| self.approvals.get(site))
    }
}
type CaptureCatalog = Option<Result<Value, String>>;
type CaptureTargets = watch::Receiver<CaptureCatalog>;
#[derive(Clone, Copy)]
enum CaptureCatalogKind { Targets, Microphones }

#[derive(Default)]
struct CaptureTargetReader {
    active: Mutex<Weak<watch::Sender<CaptureCatalog>>>,
    #[cfg(test)]
    test_read: Option<Arc<dyn Fn() -> BoxFuture<'static, Result<Value>> + Send + Sync>>,
}

struct App {
    config: Config,
    port: u16,
    token: String,
    registry: Mutex<Registry>,
    closing: watch::Sender<bool>,
    launch: Mutex<Option<hosted::Launch>>,
    desktop: Desktop,
    voice_shortcuts: voice_shortcuts::Owner,
    external_inputs: whip::Inputs,
    update: update::Owner,
    capture_targets: CaptureTargetReader,
    capture_microphones: CaptureTargetReader,
}

impl CaptureTargetReader {
    async fn read(&self, kind: CaptureCatalogKind) -> CaptureTargets {
        let mut active = self.active.lock().await;
        if let Some(result) = active.upgrade() {
            if result.borrow().is_none() {
                return result.subscribe();
            }
        }
        let (result, read) = watch::channel(None);
        let result = Arc::new(result);
        *active = Arc::downgrade(&result);
        #[cfg(test)]
        let test_read = self.test_read.clone();
        tokio::spawn(async move {
            #[cfg(test)]
            let catalog = match test_read {
                Some(read) => read().await,
                None => kind.read().await,
            };
            #[cfg(not(test))]
            let catalog = kind.read().await;
            result.send_replace(Some(catalog.map_err(|error| error.to_string())));
        });
        read
    }
}

impl CaptureCatalogKind {
    async fn read(self) -> Result<Value> {
        match self {
            Self::Targets => capture_targets().await,
            Self::Microphones => tokio::task::spawn_blocking(|| {
                Ok(serde_json::to_value(piik_channel_native::capture::microphones()?)?)
            }).await?,
        }
    }
}

fn control_event_message(pages: &page::Connection, event: Value) -> Message {
    if event["type"] == "page_closed" {
        if let Some(page_id) = event["pageId"].as_str().and_then(|id| Uuid::parse_str(id).ok()) {
            pages.close_page(page_id);
        }
    }
    Message::Text(event.to_string().into())
}

fn control_reply(id: String, result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"id":id,"result":value}),
        Err(error) => json!({"id":id,"error":error.to_string()}),
    }
}

async fn catalog_reply(pending: &mut Option<(String, CaptureTargets)>) -> Value {
    let Some((_, read)) = pending.as_mut() else { return std::future::pending().await; };
    let result = match read.wait_for(Option::is_some).await {
        Ok(value) => value.as_ref().expect("capture catalog resolved").clone(),
        Err(_) => Err("capture_targets_failed".into()),
    };
    let (id, _) = pending.take().expect("capture catalog pending");
    control_reply(id, result.map_err(anyhow::Error::msg))
}

impl App {
    async fn hello(
        &self,
        site: &str,
        permission: &Arc<Permission>,
        channel: Uuid,
        user: Uuid,
        credential: String,
        name: String,
    ) -> Result<mpsc::Sender<HostCommand>> {
        let (commands, mut ready) = self
            .ensure_host(site, permission, channel, user, credential, name)
            .await?;
        loop {
            if let Some(result) = ready.borrow().clone() {
                result.map_err(anyhow::Error::msg)?;
                return Ok(commands);
            }
            ready
                .changed()
                .await
                .map_err(|_| anyhow!("hosting_unavailable"))?;
        }
    }

    async fn ensure_host(
        &self,
        site: &str,
        permission: &Arc<Permission>,
        channel: Uuid,
        user: Uuid,
        credential: String,
        name: String,
    ) -> Result<(
        mpsc::Sender<HostCommand>,
        watch::Receiver<Option<Result<(), String>>>,
    )> {
        let key = (site.to_owned(), channel, user);
        let mut registry = loop {
            let registry = self.registry.lock().await;
            if *self.closing.borrow() {
                bail!("hosting_unavailable");
            }
            if !registry.permission(site).is_some_and(|current| Arc::ptr_eq(current, permission)) {
                bail!("site_not_approved");
            }
            let Some(host) = registry.hosts.get(&key).filter(|host| host.finished() || *host.stop.borrow()) else {
                break registry;
            };
            let task = host.task.clone();
            drop(registry);
            self.join_host(&key, task).await;
        };
        if let Some(host) = registry.hosts.get(&key) {
            if host.credential != credential {
                bail!("owner_mismatch");
            }
        } else {
            let (commands, receiver) = mpsc::channel(64);
            let (ready, admitted) = watch::channel(None);
            let (stop, mut stopped) = watch::channel(false);
            let config = session::Config {
                url: format!("{}/prototype/channel", site.replacen("http", "ws", 1)),
                origin: site.to_owned(),
                name,
                credential: Some(credential.clone()),
                server_udp: None,
                owner_key: None,
            };
            let management = Hosting {
                desktop: Some(self.desktop.clone()),
                // An approved origin owns this namespace. Remote UUIDs only select
                // data inside it, after run_host verifies the real Domain Welcome.
                directory: self
                    .config
                    .data_root
                    .join("rooms")
                    .join(permission.data_id.to_string())
                    .join(channel.to_string())
                    .join(user.to_string()),
                identity: (channel, user),
                commands: receiver,
                ready,
            };
            let task = tokio::spawn(session::run_host(
                config,
                vec![],
                Some(management),
                None,
                async move {
                    let _ = stopped.changed().await;
                },
            ));
            registry.hosts.insert(
                key.clone(),
                Host {
                    credential,
                    commands,
                    ready: admitted,
                    stop,
                    task: host_task(task),
                },
            );
        }
        let host = registry.hosts.get(&key).unwrap();
        Ok((host.commands.clone(), host.ready.clone()))
    }
    async fn join_host(&self, key: &HostKey, task: HostTask) {
        // The registry keeps its join owner if this HTTP request disconnects.
        task.clone().await;
        let mut registry = self.registry.lock().await;
        if registry.hosts.get(key).is_some_and(|host| host.task.ptr_eq(&task)) {
            registry.hosts.remove(key);
        }
    }

    async fn shutdown(&self) {
        self.closing.send_replace(true);
        let hosts = {
            let mut registry = self.registry.lock().await;
            for permission in registry.approvals.values() {
                permission.revoked.send_replace(true);
            }
            if let Some(LocalSite { permission, .. }) = &registry.local {
                permission.revoked.send_replace(true);
            }
            std::mem::take(&mut registry.hosts).into_values().collect()
        };
        stop_hosts(hosts).await;
        self.desktop.close();
        if let Some(launch) = self.launch.lock().await.take() {
            launch.close().await;
        }
        self.update.shutdown().await;
    }
}
async fn stop_hosts(hosts: Vec<Host>) {
    for host in &hosts {
        host.stop.send_replace(true);
    }
    for host in hosts {
        host.task.await;
    }
}
fn host_task(task: JoinHandle<Result<()>>) -> HostTask {
    async move {
        match task.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("App hosting ended: {error}"),
            Err(error) => eprintln!("App hosting task ended: {error}"),
        }
    }.boxed().shared()
}

/// Choose the same bounded discovery ports for each native App shell.
pub async fn listen(port: Option<u16>) -> Result<TcpListener> {
    if let Some(port) = port {
        return Ok(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?);
    }
    for port in 39721..=39730 {
        match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
            Err(error) => return Err(error.into()),
        }
    }
    bail!("Piik App discovery ports are occupied")
}

// The file is the guard: closing it releases the process's directory ownership.
fn lock_directory(directory: &std::path::Path) -> Result<std::fs::File> {
    std::fs::create_dir_all(directory)?;
    let owner = std::fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("app.lock"))?;
    piik_channel_native::hosted_room::try_lock_file(&owner).map_err(|error| {
        match error.kind() {
            std::io::ErrorKind::WouldBlock => anyhow!("This App data directory is already in use"),
            _ => error.into(),
        }
    })?;
    Ok(owner)
}

/// Local approval and persistent room hosting share one process, not page lifetime.
pub async fn serve(
    listener: TcpListener,
    config: Config,
    stop: impl Future<Output = ()> + Send + 'static,
    ready: Option<oneshot::Sender<String>>,
) -> Result<()> {
    // reqwest's rustls-no-provider requires a process default even for HTTP URLs.
    // Initialize before any App request, independent of earlier WSS/HTTPS activity.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let address = listener.local_addr()?;
    if !address.ip().is_loopback() {
        bail!("App service requires a loopback listener");
    }
    let owner = lock_directory(&config.data_root)?;
    let sites = sites::Sites::open(&config.data_root)?;
    let startup_intent = sites.startup()?;
    let mut entry = format!("http://{address}/client");
    if !matches!(startup_intent, sites::StartupIntent::None) {
        entry.push_str("?start=1");
    }
    let open_browser = config.open_browser;
    let terminal_enabled = (config.open_browser || ready.is_some()) && config.page_player.is_none()
        && std::env::var_os("PIIK_CHANNEL_APP_NO_BROWSER").is_none();
    let terminal_notice = config.terminal_notice.clone();
    let approvals = sites
        .approved()?
        .into_iter()
        .map(|(site, id)| (site, Arc::new(Permission::new(id))))
        .collect();
    let index = config.assets.join("index.html");
    let bundles = web::bundle_routes(&config.assets)?;
    let assets =
        web::static_files(ServeDir::new(&config.assets).fallback(web::document(index.clone())));
    let closing = watch::channel(false).0;
    let update = update::Owner::new(&config, closing.clone());
    let app = Arc::new(App {
        desktop: Desktop::new()?,
        external_inputs: whip::Inputs::default(),
        capture_targets: CaptureTargetReader::default(),
        capture_microphones: CaptureTargetReader::default(),
        voice_shortcuts: voice_shortcuts::Owner::default(),
        config,
        port: address.port(),
        token: Uuid::new_v4().to_string(),
        registry: Mutex::new(Registry {
            sites,
            approvals,
            hosts: BTreeMap::new(),
            local: None,
        }),
        closing,
        launch: Mutex::new(None),
        update,
    });
    if let sites::StartupIntent::Owned(request) = startup_intent {
        hosted::begin(&app, request)
            .await
            .map_err(|(_, detail)| anyhow::anyhow!("{}", detail.0))?;
    }
    let router = Router::new()
        .merge(bundles)
        .route("/", web::document(index.clone()))
        .route("/index.html", web::document(index))
        .route("/connect-discovery", get(discovery))
        .route("/health", get(health))
        .route("/rooms", get(upgrade))
        .merge(whip::routes())
        .route("/rooms/{domain}/{user}/{room}/backup", get(backup::export))
        .route("/rooms/{domain}/{user}/backup", put(backup::restore))
        .route("/rooms/{domain}/{user}/hosting", get(backup::describe))
        .route("/api/client-launcher", get(launcher))
        .route(
            "/api/client-launcher/bookmarks",
            get(bookmarks).post(save_bookmark),
        )
        .route(
            "/api/client-launcher/bookmarks/{id}",
            axum::routing::delete(delete_bookmark),
        )
        .route("/api/client-launcher/open", post(open_window))
        .route("/api/client-launcher/website-permissions", post(reset_website_permissions))
        .route(
            "/api/client-launcher/update",
            get(update_state).post(update_request),
        )
        .route("/api/client-launcher/debug", post(diagnostics::enable))
        .route(
            "/api/client-launcher/debug/export",
            post(diagnostics::export),
        )
        .route("/api/client-launcher/launch", post(hosted::launch))
        .route("/api/client-launcher/owner-entry", post(hosted::owner_entry))
        .route("/api/client-launcher/site", post(approve))
        .route("/api/client-launcher/startup-site", post(startup))
        .fallback_service(assets)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .layer(middleware::from_fn_with_state(app.clone(), access))
        .with_state(app.clone());
    let console = console::Console::new(None);
    let mut terminal =
        terminal::Terminal::start(terminal_enabled, address.port(), terminal_notice.as_deref());
    if terminal.is_none() {
        console.startup(BUILD_VERSION, BUILD_REVISION, address.port());
        if let Some(notice) = &terminal_notice {
            eprintln!("{notice}");
        }
    }
    eprintln!("App room socket listening on {address}");
    if let Some(ready) = ready {
        let _ = ready.send(entry.clone());
    }
    let mut opening = if open_browser {
        match terminal::open_browser(entry) {
            Ok(opening) => Some(opening),
            Err(error) => { eprintln!("Could not open Browser: {error}"); None }
        }
    } else { None };
    let mut report: Option<BoxFuture<'static, Result<PathBuf>>> = None;
    let shutdown_app = app.clone();
    let shutdown = async move {
        shutdown_app.desktop.revoke();
        shutdown_app.shutdown().await;
    }
    .shared();
    let stop_shutdown = shutdown.clone();
    let result = crate::web::serve_http(listener, router, async move {
        tokio::pin!(stop);
        let mut closing = app.closing.subscribe();
        let mut desktop_timer = None;
        let mut refresh = tokio::time::interval(Duration::from_secs(1));
        loop {
            if *closing.borrow() {
                break;
            }
            tokio::select! {
                _ = &mut stop => break,
                _ = closing.changed() => break,
                _ = app.desktop.tick_when_needed(&mut desktop_timer) => {}
                state = async { refresh.tick().await; launcher_view(&app).await }, if terminal.is_some() => {
                    terminal.as_mut().unwrap().show(state, false);
                }
                Some(action) = async { match terminal.as_mut() {
                    Some(view) => view.next().await,
                    None => std::future::pending().await,
                }} => match action {
                    terminal::Command::Quit => { app.closing.send_replace(true); break; }
                    terminal::Command::Diagnostics => {
                        if report.is_some() { continue; }
                        if piik_channel_native::diagnostics::enabled() {
                            report = Some(diagnostics::export_to_directory(app.config.data_root.join("diagnostics")).boxed());
                        } else {
                            terminal.as_ref().unwrap().message("Enable Help → Debug in the App launcher, reproduce the issue, then press D + Enter. / 请在 App 启动页启用帮助 → 调试，复现问题后按 D + Enter。");
                        }
                    }
                    action => {
                        if action != terminal::Command::Refresh && opening.is_some() { continue; }
                        let url = if action == terminal::Command::Launcher {
                            format!("http://127.0.0.1:{}/client", app.port)
                        } else if action == terminal::Command::Site {
                            match hosted::owner_target(&app).await {
                                Ok(target) => target,
                                Err((_, error)) => {
                                    terminal.as_ref().unwrap().message(error["detail"].as_str().unwrap_or("Site is not ready"));
                                    continue;
                                }
                            }
                        } else {
                            let state = tokio::select! {
                                _ = &mut stop => break,
                                _ = closing.changed() => break,
                                Some(next) = terminal.as_mut().unwrap().next() => {
                                    if next == terminal::Command::Quit {
                                        app.closing.send_replace(true);
                                        break;
                                    }
                                    continue;
                                }
                                state = launcher_view(&app) => state,
                            };
                            terminal.as_mut().unwrap().show(state, true);
                            continue;
                        };
                        match terminal::open_browser(url) {
                            Ok(request) => opening = Some(request),
                            Err(error) => eprintln!("Could not open Browser: {error}"),
                        }
                    }
                },
                result = async { match report.as_mut() {
                    Some(report) => report.await,
                    None => std::future::pending().await,
                }} => {
                    report = None;
                    let message = match result {
                        Ok(path) => format!("App report saved / App 报告已保存: {}", path.display()),
                        Err(error) => format!("Could not export App report / 无法导出 App 报告: {error}"),
                    };
                    terminal.as_ref().unwrap().message(&message);
                },
                result = async { match opening.as_mut() {
                    Some(task) => task.await,
                    None => std::future::pending().await,
                }} => {
                    opening = None;
                    let error = match result {
                        Ok(Ok(())) => continue,
                        Ok(Err(error)) => error.to_string(),
                        Err(error) => error.to_string(),
                    };
                    let message = format!("Could not open Browser / 无法打开浏览器: {error}");
                    if let Some(view) = &terminal {
                        view.message(&message);
                    } else {
                        eprintln!("{message}");
                    }
                }
            }
        }
        terminal.take();
        stop_shutdown.await;
    })
    .await;
    shutdown.await;
    result?;
    drop(owner);
    console.stopped();
    Ok(())
}

fn request_origin(headers: &HeaderMap) -> Option<String> {
    web::origin(headers.get(header::ORIGIN)?.to_str().ok()?).ok()
}
fn local_origin(app: &App, value: &str) -> bool {
    value == format!("http://127.0.0.1:{}", app.port)
        || value == format!("http://localhost:{}", app.port)
}
async fn access(
    State(app): State<Arc<App>>,
    request: HttpRequest<axum::body::Body>,
    next: Next,
) -> Response {
    let headers = request.headers();
    if !headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| local_origin(&app, &format!("http://{host}")))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let origin = request_origin(headers);
    if headers.contains_key(header::ORIGIN) && origin.is_none() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = request.uri().path();
    let discovery = path == "/connect-discovery";
    let health = path == "/health";
    let backup = path.starts_with("/rooms/");
    let whip_methods = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .and_then(|path| whip::methods(path.as_str()));
    let whip_preflight = whip_methods.is_some()
        && request.method() == axum::http::Method::OPTIONS
        && origin.is_some()
        && headers.contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);
    let allowed = match &origin {
        Some(site) => app.registry.lock().await.permission(site).is_some(),
        None => false,
    };
    if path.starts_with("/api/client-launcher") {
        let local = origin.as_ref().is_some_and(|site| local_origin(&app, site));
        if !matches!(
            *request.method(),
            axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
        ) {
            if !local
                || (request.method() == axum::http::Method::POST
                    && headers
                        .get(header::CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.split(';').next())
                        .map(str::trim)
                        != Some("application/json"))
            {
                return StatusCode::FORBIDDEN.into_response();
            }
        } else if origin.is_some() && !local {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    if ((health || backup) || (whip_methods.is_some() && origin.is_some())) && !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cors =
        origin.filter(|_| discovery || ((health || backup || whip_methods.is_some()) && allowed));
    let private_network = headers
        .get("access-control-request-private-network")
        .is_some_and(|value| value == "true");
    let mut response = if whip_preflight {
        // A preflight has no Bearer. It describes only this approved Origin's
        // HTTP methods; the actual request still needs its live page permit.
        let mut response = StatusCode::OK.into_response();
        if whip_methods == whip::methods(whip::ENDPOINT) {
            response
                .headers_mut()
                .insert("accept-post", "application/sdp".parse().unwrap());
        }
        response
    } else if request.method() == axum::http::Method::OPTIONS && (discovery || health || backup) {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    if let Some(origin) = cors {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.parse().unwrap());
        response
            .headers_mut()
            .insert(header::VARY, "Origin".parse().unwrap());
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            whip_methods
                .unwrap_or(if backup { "GET, PUT, OPTIONS" } else { "GET" })
                .parse()
                .unwrap(),
        );
        if backup || whip_methods.is_some() {
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                if backup {
                    "Authorization, Content-Type, X-Piik-Credential"
                } else {
                    "Authorization, Content-Type"
                }
                .parse()
                .unwrap(),
            );
        }
        if whip_methods.is_some() {
            response.headers_mut().insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Location".parse().unwrap(),
            );
        }
        if private_network {
            response.headers_mut().insert(
                "access-control-allow-private-network",
                "true".parse().unwrap(),
            );
        }
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        "frame-ancestors 'none'".parse().unwrap(),
    );
    response
        .headers_mut()
        .insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}
async fn discovery(State(app): State<Arc<App>>) -> Json<Value> {
    Json(
        json!({"service":SERVICE,"protocol":PROTOCOL,"domainProtocol":piik_channel_core::wire::CHANNEL_PROTOCOL,"port":app.port,
        "windowNavigation":app.config.window_navigation.is_some(),"connectURL":format!("http://127.0.0.1:{}/client",app.port)}),
    )
}
async fn health(State(app): State<Arc<App>>) -> Json<Value> {
    let mut state = json!({"service":SERVICE,"protocol":PROTOCOL,"domainProtocol":piik_channel_core::wire::CHANNEL_PROTOCOL,"port":app.port,"token":app.token,
        "version":BUILD_VERSION,"revision":BUILD_REVISION,"packageTarget":PACKAGE_TARGET,
        "windowNavigation":app.config.window_navigation.is_some(),"updateSupported":app.update.supported()});
    if app.config.page_player.is_some() {
        state["pagePlayer"] = json!(true);
    }
    if voice_shortcuts::AVAILABLE {
        state["backgroundVoiceShortcuts"] = json!(true);
    }
    #[cfg(feature = "capture")]
    if piik_channel_native::peer::supports_external_input() {
        state["externalScreenInputAvailable"] = json!(true);
    }
    Json(state)
}

fn launcher_state(registry: &Registry, port: u16) -> Result<Value> {
    let startup = registry.sites.startup()?;
    let site = match &startup {
        sites::StartupIntent::External(site) => site.as_str(),
        sites::StartupIntent::Owned(_) => registry
            .local
            .as_ref()
            .map(|local| local.invitation.as_str())
            .unwrap_or(""),
        sites::StartupIntent::None => "",
    };
    let mode = match &startup {
        sites::StartupIntent::Owned(request) => Some(&request.mode),
        _ => None,
    };
    let public_origin = match registry.local.as_ref().map(|local| &local.request) {
        Some(request) => request.public_origin.as_deref(),
        None => match &startup {
            sites::StartupIntent::Owned(request) => request.public_origin.as_deref(),
            _ => None,
        },
    };
    let mut state = json!({"sites":registry.approvals.keys().collect::<Vec<_>>(),"startupSite":site,"startupMode":mode,
        "ownedSites":registry.local.as_ref().map(|local| vec![&local.origin,&local.invitation]).unwrap_or_default(),
        "version":BUILD_VERSION,"revision":BUILD_REVISION,
        "packageTarget":PACKAGE_TARGET,"controlPort":port,"debug":piik_channel_native::diagnostics::enabled()});
    if let Some(origin) = public_origin {
        state["publicOrigin"] = json!(origin);
    }
    if let Some(local) = &registry.local {
        state["localSite"] = json!(local.origin);
    }
    Ok(state)
}
type ApiResult = std::result::Result<Json<Value>, (StatusCode, Json<Value>)>;
fn operation_failure(error: anyhow::Error) -> (StatusCode, Json<Value>) {
    eprintln!("App site operation failed: {error}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"detail":"App settings could not be saved"})),
    )
}
async fn launcher_view(app: &App) -> anyhow::Result<Value> {
    let mut state = {
        let registry = app.registry.lock().await;
        launcher_state(&registry, app.port)?
    };
    state["windowNavigation"] = json!(app.config.window_navigation.is_some());
    state["websitePermissionReset"] = json!(app.config.website_permission_reset.is_some());
    hosted::describe(app, &mut state).await?;
    Ok(state)
}
async fn launcher(State(app): State<Arc<App>>) -> ApiResult {
    launcher_view(&app).await.map(Json).map_err(operation_failure)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveBookmark {
    id: Option<Uuid>,
    origin: String,
    name: String,
}
fn invalid_request(detail: &str) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({"detail":detail})))
}
async fn bookmarks(State(app): State<Arc<App>>) -> ApiResult {
    let registry = app.registry.lock().await;
    Ok(Json(
        json!({"bookmarks":registry.sites.bookmarks().map_err(operation_failure)?}),
    ))
}
async fn save_bookmark(
    State(app): State<Arc<App>>,
    Json(request): Json<SaveBookmark>,
) -> ApiResult {
    let origin =
        web::origin(&request.origin).map_err(|_| invalid_request("Invalid site address"))?;
    let name = request.name.trim();
    if origin.len() > 4096 || name.encode_utf16().count() > 40 {
        return Err(invalid_request("Invalid bookmark"));
    }
    let mut registry = app.registry.lock().await;
    let saved = |registry: &Registry| {
        request.id.map(|id| {
            registry.sites.bookmarks().map_err(operation_failure)?.into_iter()
                .find(|entry| entry.id == id)
                .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"detail":"Bookmark not found"}))))
        }).transpose()
    };
    let previous = saved(&registry)?;
    if previous.as_ref().is_none_or(|entry| entry.origin != origin) {
        drop(registry);
        verify_launcher_site(&app, &origin).await?;
        registry = app.registry.lock().await;
        if saved(&registry)? != previous {
            return Err((StatusCode::PRECONDITION_FAILED, Json(json!({"detail":"Bookmark changed"}))));
        }
    }
    let bookmark = sites::Bookmark {
        id: request.id.unwrap_or_else(Uuid::new_v4),
        origin,
        name: name.into(),
    };
    if !registry
        .sites
        .save_bookmark(&bookmark)
        .map_err(operation_failure)?
    {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"detail":"Site already bookmarked"})),
        ));
    }
    Ok(Json(
        json!({"bookmarks":registry.sites.bookmarks().map_err(operation_failure)?}),
    ))
}
async fn delete_bookmark(State(app): State<Arc<App>>, Path(id): Path<Uuid>) -> ApiResult {
    let registry = app.registry.lock().await;
    registry
        .sites
        .delete_bookmark(id)
        .map_err(operation_failure)?;
    Ok(Json(
        json!({"bookmarks":registry.sites.bookmarks().map_err(operation_failure)?}),
    ))
}
// Check the public marker without sending invitation parameters or App credentials.
async fn verify_launcher_site(app: &App, origin: &str) -> std::result::Result<(), (StatusCode, Json<Value>)> {
    // An active LAN listener and the loopback listener serve the same App-owned domain.
    // Its ephemeral HTTPS certificate belongs to that listener only.
    let local = app.registry.lock().await.local.as_ref()
        .filter(|local| matches!(local.request.mode, hosted::Mode::Local) && local.invitation == origin)
        .map(|local| local.origin.clone());
    verify_site(local.as_deref().unwrap_or(origin)).await
}

async fn verify_site(origin: &str) -> std::result::Result<(), (StatusCode, Json<Value>)> {
    let unavailable = || (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"detail":"site_unavailable"})));
    let mismatch = || (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"detail":"not_piik_site"})));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(IO_TIMEOUT)
        .build()
        .map_err(|_| unavailable())?;
    let mut response = client.get(format!("{origin}/healthz")).send().await.map_err(|_| unavailable())?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(mismatch());
    }
    if response.status() != StatusCode::OK {
        return Err(unavailable());
    }
    let mut expected = crate::domain::HEALTH_MARKER.as_bytes();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        expected = expected.strip_prefix(chunk.as_ref()).ok_or_else(mismatch)?;
    }
    if expected.is_empty() { Ok(()) } else { Err(mismatch()) }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenWindow {
    url: String,
}
async fn open_window(State(app): State<Arc<App>>, Json(request): Json<OpenWindow>) -> ApiResult {
    let url = url::Url::parse(&request.url).map_err(|_| invalid_request("Invalid site URL"))?;
    if request.url.len() > 4096
        || !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid_request("Invalid site URL"));
    }
    let origin = url.origin().ascii_serialization();
    let Some(navigation) = &app.config.window_navigation else {
        verify_launcher_site(&app, &origin).await?;
        return Ok(Json(json!({"opened":false})));
    };
    let intent = {
        let mut latest = navigation.latest.lock().unwrap();
        *latest = latest.wrapping_add(1);
        *latest
    };
    verify_launcher_site(&app, &origin).await?;
    let local = app.registry.lock().await.local.as_ref().is_some_and(|site| {
        site.origin == origin || (site.invitation == origin && matches!(site.request.mode, hosted::Mode::Local))
    });
    let latest = navigation.latest.lock().unwrap();
    if *latest != intent {
        return Err((StatusCode::CONFLICT, Json(json!({"detail":"Site selection changed"}))));
    }
    if !(navigation.dispatch)(request.url, local) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"detail":"Window unavailable"})),
        ));
    }
    Ok(Json(json!({"opened":true})))
}
async fn reset_website_permissions(
    State(app): State<Arc<App>>,
    Json(request): Json<Startup>,
) -> ApiResult {
    let site = web::origin(&request.site).map_err(|_| invalid_request("Invalid site origin"))?;
    let Some(reset) = &app.config.website_permission_reset else {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({"detail":"Website permission reset is unavailable"})),
        ));
    };
    let (reply, completed) = oneshot::channel();
    if !reset(site, reply) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"detail":"Window unavailable"})),
        ));
    }
    timeout(IO_TIMEOUT, completed)
        .await
        .map_err(|_| operation_failure(anyhow!("Website permission reset timed out")))?
        .map_err(|_| operation_failure(anyhow!("Window unavailable")))?
        .map_err(|error| operation_failure(anyhow!(error)))?;
    let registry = app.registry.lock().await;
    launcher_state(&registry, app.port)
        .map(Json)
        .map_err(operation_failure)
}
async fn update_state(State(app): State<Arc<App>>) -> Json<update::View> {
    Json(app.update.view())
}
async fn update_request(
    State(app): State<Arc<App>>,
    Json(request): Json<update::Request>,
) -> std::result::Result<Json<update::View>, (StatusCode, Json<Value>)> {
    app.update
        .request(request)
        .await
        .map(Json)
        .map_err(|detail| {
            (
                if detail == "invalid-release" {
                    StatusCode::BAD_REQUEST
                } else {
                    StatusCode::CONFLICT
                },
                Json(json!({"detail":detail})),
            )
        })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    site: String,
    allowed: bool,
}
async fn approve(State(app): State<Arc<App>>, Json(change): Json<Approval>) -> ApiResult {
    let site = web::origin(&change.site).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail":"Invalid site address"})),
        )
    })?;
    let mut registry = app.registry.lock().await;
    if registry
        .local
        .as_ref()
        .is_some_and(|local| local.origin == site)
    {
        return Err((
            StatusCode::CONFLICT,
            Json(launcher_state(&registry, app.port).map_err(operation_failure)?),
        ));
    }
    let current_invitation = registry
        .local
        .as_ref()
        .is_some_and(|local| local.invitation == site);
    let id = registry
        .sites
        .approve(&site, change.allowed, current_invitation)
        .map_err(operation_failure)?;
    if change.allowed {
        registry
            .approvals
            .entry(site.clone())
            .or_insert_with(|| Arc::new(Permission::new(id)));
    } else {
        if let Some(permission) = registry.approvals.remove(&site) {
            permission.revoked.send_replace(true);
        }
        let stopping: Vec<_> = registry.hosts.iter()
            .filter(|((origin, ..), _)| origin == &site)
            .map(|(key, host)| {
                host.stop.send_replace(true);
                (key.clone(), host.task.clone())
            })
            .collect();
        drop(registry);
        for (key, task) in stopping {
            app.join_host(&key, task).await;
        }
        registry = app.registry.lock().await;
    }
    Ok(Json(
        launcher_state(&registry, app.port).map_err(operation_failure)?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Startup {
    site: String,
}
async fn startup(State(app): State<Arc<App>>, Json(change): Json<Startup>) -> ApiResult {
    let registry = app.registry.lock().await;
    if !change.site.is_empty() && registry.permission(&change.site).is_none() {
        return Err((
            StatusCode::CONFLICT,
            Json(launcher_state(&registry, app.port).map_err(operation_failure)?),
        ));
    }
    let intent = if change.site.is_empty() {
        sites::StartupIntent::None
    } else if let Some(local) = registry
        .local
        .as_ref()
        .filter(|local| local.origin == change.site || local.invitation == change.site)
    {
        sites::StartupIntent::Owned(local.request.clone())
    } else {
        sites::StartupIntent::External(change.site.clone())
    };
    registry
        .sites
        .set_startup(&intent)
        .map_err(operation_failure)?;
    launcher_state(&registry, app.port)
        .map(Json)
        .map_err(operation_failure)
}
async fn upgrade(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(site) = request_origin(&headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let permission = app.registry.lock().await.permission(&site).cloned();
    let Some(permission) = permission else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let protocol = format!("piik-channel-rooms.{}", app.token);
    if !headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|value| value.trim() == protocol))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.protocols([protocol])
        .max_message_size(MAX_REQUEST_BYTES)
        .max_frame_size(MAX_REQUEST_BYTES)
        .on_upgrade(move |socket| async move {
            let mut closing = app.closing.subscribe();
            let mut revoked = permission.revoked.subscribe();
            if *closing.borrow() || *revoked.borrow() {
                return;
            }
            connection(socket, &app, &site, &permission, &mut closing, &mut revoked).await;
        })
}
fn control_request(text: &str) -> Result<std::result::Result<Request, Value>> {
    let value: Value = serde_json::from_str(text)?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 256);
    Ok(match (id, serde_json::from_str(text)) {
        (Some(_), Ok(request)) => Ok(request),
        _ => Err(json!({"id":id,"error":"invalid_request"})),
    })
}

async fn send_control(
    writer: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    response: Value,
) -> Result<()> {
    timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
    Ok(())
}

#[derive(Deserialize)]
struct Request {
    id: String,
    #[serde(flatten)]
    operation: Operation,
}
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Operation {
    Hello {
        channel_id: Uuid,
        user_id: Uuid,
        credential: String,
        name: String,
    },
    Open {
        policy: String,
    },
    LocalEndpoint,
    RelayCapacity(piik_channel_native::session::RelayCapacityRequest),
    ConnectionMetrics {
        room_id: String,
        publication_id: Option<Uuid>,
    },
    Targets,
    PrepareExternalInput {
        publication_id: Uuid,
        room_id: String,
    },
    CancelExternalInput {
        publication_id: Uuid,
    },
    Microphones,
    Preview {
        target: Target,
    },
    CancelPreview {
        request_id: String,
    },
    PrepareCapture {
        publication_id: Uuid,
        room_id: String,
        target: Target,
        settings: Settings,
        codec_mode: VideoCodecMode,
        encoding_execution: EncodingExecution,
        #[serde(default)]
        audio_settings: SourceAudioSettings,
        #[serde(default)]
        audio: bool,
        #[serde(default)]
        exclude_audio: Option<Target>,
        render_endpoint_id: Option<String>,
        #[serde(default)]
        show_capture_border: bool,
    },
    CommitCapture {
        publication_id: Uuid,
        capture_id: Uuid,
    },
    CaptureAudioSettings {
        publication_id: Uuid,
        settings: SourceAudioSettings,
    },
    CaptureMicrophone {
        publication_id: Uuid,
        capture_id: Uuid,
        room_id: String,
        settings: SourceMicrophoneSettings,
    },
    CaptureVideoSettings {
        publication_id: Uuid,
        capture_id: Uuid,
        settings: Settings,
    },
    CaptureDirectLimit {
        publication_id: Uuid,
        limit: Option<u8>,
    },
    CaptureTitle {
        publication_id: Uuid,
        capture_id: Uuid,
        title: Option<String>,
    },
    CapturePaused {
        publication_id: Uuid,
        capture_id: Uuid,
        paused: bool,
    },
    CancelCapture {
        publication_id: Uuid,
    },
    TransferSource {
        publication_id: Uuid,
        capture_id: Uuid,
        to_session_id: Uuid,
    },
    StopCapture {
        publication_id: Uuid,
        capture_id: Option<Uuid>,
        successor_watch_id: Option<Uuid>,
    },
    InputPolicy {
        publication_id: Uuid,
        capture_id: Uuid,
        mode: Mode,
        password: Option<String>,
        simultaneous: Option<bool>,
    },
    InputDecide {
        publication_id: Uuid,
        controller_session_id: Uuid,
        intent: Uuid,
        allow: bool,
    },
    InputShortcut {
        publication_id: Uuid,
        key: u8,
    },
    VoiceShortcuts(voice_shortcuts::Settings),
    #[serde(untagged)]
    Page(page::Operation),
}

#[derive(Default)]
struct Capture {
    active: Option<SourceLease>,
    pending: Option<PendingCapture>,
    audio: Option<CaptureAudio>,
    audio_settings: SourceAudioSettings,
}
enum SourceLease {
    Capture(CaptureLease),
    External(ExternalLease),
}
impl SourceLease {
    fn external_identity(&self) -> Option<(Uuid, Uuid)> {
        match self {
            Self::External(lease) if !lease.is_stopped() => Some((lease.id, lease.session_id)),
            _ => None,
        }
    }
    fn id(&self) -> Uuid {
        match self {
            Self::Capture(lease) => lease.id,
            Self::External(lease) => lease.id,
        }
    }
    fn producer_id(&self) -> Uuid {
        match self {
            Self::Capture(lease) => lease.producer_id(),
            Self::External(lease) => lease.id,
        }
    }
    fn is_stopped(&self) -> bool {
        match self {
            Self::Capture(lease) => lease.is_stopped(),
            Self::External(lease) => lease.is_stopped(),
        }
    }
    fn scope(&self) -> &piik_channel_native::peer::CaptureScope {
        match self {
            Self::Capture(lease) => &lease.scope,
            Self::External(lease) => &lease.scope,
        }
    }
    fn capture(&self) -> Option<&CaptureLease> {
        match self {
            Self::Capture(lease) => Some(lease),
            _ => None,
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceKind {
    Capture,
    External,
}
struct PendingCapture {
    kind: SourceKind,
    request: AbortHandle,
    phase: CapturePhase,
}
enum CapturePhase {
    Preparing,
    WaitingForExternal(Uuid),
    Prepared(SourceLease),
    // The host result owns a submitted switch even if the source ends first.
    Committing(Uuid),
}
impl CapturePhase {
    fn candidate_id(&self) -> Option<Uuid> {
        match self {
            Self::Preparing => None,
            Self::WaitingForExternal(id) | Self::Committing(id) => Some(*id),
            Self::Prepared(lease) => Some(lease.id()),
        }
    }

    fn prepared(&self) -> Option<&SourceLease> {
        match self {
            Self::Prepared(lease) => Some(lease),
            _ => None,
        }
    }
}
enum CaptureResult {
    Prepared {
        lease: CaptureLease,
        codec: VideoCodec,
    },
    Committed(SourceLease),
}
impl Capture {
    fn pending_for(&mut self, producer: Uuid) -> Option<&mut PendingCapture> {
        self.pending
            .as_mut()
            .filter(|pending| pending.phase.candidate_id() == Some(producer))
    }
    fn retire_producer(&mut self, producer: Uuid) -> bool {
        let active = self
            .active
            .as_ref()
            .is_some_and(|source| source.id() == producer);
        let pending = self.pending_for(producer).is_some();
        if active {
            self.active = None;
        }
        if pending {
            self.pending = None;
        }
        active || pending
    }
    fn external_event(
        &self,
        publication: Uuid,
        prepared: bool,
        closed: bool,
        error: Option<&str>,
    ) -> Value {
        external_input_event(
            publication,
            self.active
                .as_ref()
                .and_then(SourceLease::external_identity),
            prepared
                .then(|| {
                    self.pending
                        .as_ref()
                        .and_then(|pending| pending.phase.prepared())
                        .and_then(SourceLease::external_identity)
                })
                .flatten(),
            closed,
            error,
        )
    }
    fn lease(&self) -> Option<&CaptureLease> {
        self.source().and_then(SourceLease::capture)
    }
    fn source(&self) -> Option<&SourceLease> {
        self.active.as_ref().filter(|lease| !lease.is_stopped())
    }
    fn prepare(
        &mut self,
        kind: SourceKind,
        settings: SourceAudioSettings,
    ) -> Result<(AbortHandle, futures_util::future::AbortRegistration)> {
        settings.validate()?;
        anyhow::ensure!(self.pending.is_none(), "capture_pending");
        if self.lease().is_none() {
            self.audio_settings = settings;
        }
        let (request, registration) = AbortHandle::new_pair();
        self.pending = Some(PendingCapture {
            kind,
            request: request.clone(),
            phase: CapturePhase::Preparing,
        });
        Ok((request, registration))
    }
    fn configure_audio(&mut self, settings: SourceAudioSettings) -> Result<()> {
        settings.validate()?;
        anyhow::ensure!(
            self.lease().is_some() || self.pending.is_some(),
            "capture_unavailable"
        );
        if let Some(audio) = self.audio.as_ref().filter(|audio| !audio.is_stopped()) {
            audio.configure(settings)?;
        } else {
            anyhow::ensure!(self.pending.is_some(), "capture_unavailable");
        }
        self.audio_settings = settings;
        Ok(())
    }

    fn install_prepared(&mut self, mut lease: CaptureLease) -> Result<()> {
        if let Some(audio) = lease.audio.take() {
            self.audio = Some(audio);
        }
        if let Some(audio) = &self.audio {
            audio.configure(self.audio_settings)?;
        }
        let pending = self
            .pending
            .as_mut()
            .ok_or_else(|| anyhow!("capture_cancelled"))?;
        pending.phase = CapturePhase::Prepared(SourceLease::Capture(lease));
        Ok(())
    }
}
fn external_input_event(
    publication: Uuid,
    active: Option<(Uuid, Uuid)>,
    prepared: Option<(Uuid, Uuid)>,
    closed: bool,
    error: Option<&str>,
) -> Value {
    let (state, source) = if closed {
        ("closed", None)
    } else if prepared.is_some() {
        ("prepared", prepared)
    } else if active.is_some() {
        ("live", active)
    } else {
        (if error.is_some() { "error" } else { "waiting" }, None)
    };
    let mut event =
        json!({"type":"external_input_state","publicationId":publication,"state":state});
    if let Some((capture, session)) = source {
        event["captureId"] = json!(capture);
        event["sessionId"] = json!(session);
        event["codec"] = json!("h264");
    }
    if let Some(error) = error {
        event["error"] = json!(match error {
            "room_unavailable" | "external_video_format_unsupported" | "external_video_offer_unsupported" => error,
            _ => "external_input_failed",
        });
    }
    event
}

fn retire_external(
    captures: &mut BTreeMap<Uuid, Capture>,
    page: &mut whip::Page,
    publication: Uuid,
    generation: Uuid,
    ended: Result<(), String>,
) -> Option<Value> {
    let resource = page.resources.remove(&generation)?;
    let capture = captures.get_mut(&publication)?;
    if !capture.retire_producer(generation)
        || !page.permits.get(&publication).is_some_and(|permit| permit.id == resource.permit)
    {
        return None;
    }
    let retired = ended.as_ref().err().is_some_and(|error| error == "room_unavailable");
    if retired {
        page.remove(publication);
    }
    Some(external_format_event(
        capture.external_event(publication, false, retired, ended.as_ref().err().map(String::as_str)),
        resource.control.unsupported_video_format(),
    ))
}

fn cancel_external_input(
    publication: Uuid,
    capture: Option<&mut Capture>,
    external: &mut whip::Page,
) -> Option<Value> {
    let active = capture.and_then(|capture| {
        if capture.pending.as_ref().is_some_and(|pending| pending.kind == SourceKind::External) {
            capture.pending = None;
        }
        capture.source().and_then(SourceLease::external_identity)
    });
    if active.is_some() {
        Some(external_input_event(publication, active, None, false, None))
    } else {
        external
            .remove(publication)
            .then(|| external_input_event(publication, None, None, true, None))
    }
}

fn external_format_event(mut event: Value, format: Option<piik_channel_native::peer::UnsupportedVideoFormat>) -> Value {
    if event["error"] == "external_video_format_unsupported" {
        if let Some(format) = format {
            event["unsupportedVideoFormat"] = json!(format);
        }
    }
    event
}
impl Drop for PendingCapture {
    fn drop(&mut self) {
        self.request.abort();
    }
}

fn capture_end_event(
    publication_id: Uuid,
    producer_id: Uuid,
    current: Option<(Uuid, Uuid)>,
    result: Option<Result<(), String>>,
) -> Option<Value> {
    let (_, capture_id) = current.filter(|(current, _)| *current == producer_id)?;
    Some(
        json!({"type":"capture_ended","publicationId":publication_id,"captureId":capture_id,"failed":result.is_some_and(|result| result.is_err())}),
    )
}

async fn connection(
    socket: WebSocket,
    app: &App,
    site: &str,
    permission: &Arc<Permission>,
    closing: &mut watch::Receiver<bool>,
    revoked: &mut watch::Receiver<bool>,
) {
    let (mut writer, mut reader) = socket.split();
    let close_socket = {
        let (incoming, mut queue) = mpsc::channel(64);
        let reading = async move {
            loop {
                match reader.next().await {
                    Some(Ok(Message::Text(text))) => match incoming.try_send(text) {
                        Ok(()) => {}
                        Err(mpsc::error::TrySendError::Full(_)) => return "request_queue_full",
                        Err(mpsc::error::TrySendError::Closed(_)) => return "request_queue_closed",
                    },
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) => return "peer_close",
                    Some(Ok(Message::Binary(_))) => return "unexpected_binary",
                    Some(Err(_)) => return "read_error",
                    None => return "read_eof",
                }
            }
        };
        let (control_events, mut event_queue) = mpsc::channel(64);
        let pages = Arc::new(page::Connection::for_site(
            app.config.page_player.clone(),
            control_events.clone(),
            site.to_owned(),
        ));
        let processing = async {
            let host = loop {
                let text = match timeout(IO_TIMEOUT, queue.recv()).await {
                    Ok(Some(text)) => text,
                    Ok(None) => return Ok("request_queue_closed"),
                    Err(_) => return Ok("hello_timeout"),
                };
                let request = match control_request(&text)? {
                    Ok(request) => request,
                    Err(response) => {
                        send_control(&mut writer, response).await?;
                        continue;
                    }
                };
                let result = match request.operation {
                    Operation::Hello { channel_id, user_id, credential, name } => {
                        app.hello(site, permission, channel_id, user_id, credential, name).await
                    }
                    _ => Err(anyhow!("hello_required")),
                };
                match result {
                    Ok(host) => {
                        send_control(&mut writer, control_reply(request.id, Ok(Value::Null))).await?;
                        break host;
                    }
                    Err(error) => send_control(&mut writer, control_reply(request.id, Err(error))).await?,
                }
            };
            let mut voice_shortcuts = app.voice_shortcuts.connect();
            let mut captures: BTreeMap<Uuid, Capture> = BTreeMap::new();
            let mut capture_starts: FuturesUnordered<
                BoxFuture<'static, (String, Uuid, AbortHandle, Result<CaptureResult>)>,
            > = FuturesUnordered::new();
            let mut audio_errors = FuturesUnordered::new();
            let mut capture_ends = FuturesUnordered::new();
            let mut input_states = FuturesUnordered::new();
            let mut audio_states = FuturesUnordered::new();
            let mut operations = FuturesUnordered::new();
            let mut capture_stops = FuturesUnordered::new();
            let mut opening: Option<BoxFuture<'static, Value>> = None;
            let mut metrics: Option<BoxFuture<'static, Value>> = None;
            let mut targets = None;
            let mut microphones = None;
            let mut previews = FuturesUnordered::new();
            let (external_requests, mut external_queue) = mpsc::channel(8);
            let mut external_page = whip::Page::default();
            let mut external_offers: FuturesUnordered<
                BoxFuture<
                    'static,
                    (
                        Arc<whip::Permit>,
                        AbortHandle,
                        oneshot::Sender<Result<(Uuid, String), StatusCode>>,
                        Result<piik_channel_native::peer::PreparedExternal>,
                    ),
                >,
            > = FuturesUnordered::new();
            let mut external_ready: FuturesUnordered<
                BoxFuture<'static, (Arc<whip::Permit>, Uuid, AbortHandle, Result<ExternalLease>)>,
            > = FuturesUnordered::new();
            let mut external_ends: FuturesUnordered<
                BoxFuture<'static, (Uuid, Uuid, Result<(), String>)>,
            > = FuturesUnordered::new();
            let mut external_deletes: FuturesUnordered<BoxFuture<'static, ()>> =
                FuturesUnordered::new();
            let mut external_authorizations: FuturesUnordered<
                BoxFuture<
                    'static,
                    (
                        String,
                        Uuid,
                        String,
                        AbortHandle,
                        Result<piik_channel_native::peer::InputAuthority>,
                    ),
                >,
            > = FuturesUnordered::new();
            let mut external_revocations: FuturesUnordered<BoxFuture<'static, (Uuid, Uuid)>> =
                FuturesUnordered::new();
            let mut preview: Option<(String, Option<oneshot::Sender<()>>)> = None;
            loop {
                captures.retain(|_, capture| capture.pending.is_some() || capture.active.is_some());
                let message = tokio::select! {
                    _ = pages.overflowed() => return Ok::<_, anyhow::Error>("page_event_queue_full"),
                    event = voice_shortcuts.next() => {
                        timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                        continue;
                    }
                    Some(event) = event_queue.recv() => {
                        timeout(IO_TIMEOUT, writer.send(control_event_message(&pages, event))).await??;
                        continue;
                    }
                    Some((id, publication_id, room_id, cancel, authority)) = external_authorizations.next(), if !external_authorizations.is_empty() => {
                        let cancelled = cancel.is_aborted();
                        if !cancelled { if let Some(capture) = captures.get_mut(&publication_id) { capture.pending = None; } }
                        let result = authority.and_then(|authority| {
                            anyhow::ensure!(!cancelled, "capture_cancelled");
                            anyhow::ensure!(authority.is_current(), "room_unavailable");
                            if let Some(permit) = external_page.permits.get(&publication_id) {
                                anyhow::ensure!(permit.room == room_id && !permit.stopped(), "capture_room_mismatch");
                                return Ok(permit.descriptor(app.port));
                            }
                            anyhow::ensure!(!external_page.permits.values().any(|permit| permit.room == room_id), "capture_pending");
                            let permit = app.external_inputs.permit(publication_id, room_id, external_requests.clone(), authority);
                            let watching = permit.clone();
                            external_revocations.push(async move {
                                let mut authority = watching.authority.clone();
                                let mut cancelled = watching.cancelled();
                                tokio::select! {
                                    _ = authority.retired() => {},
                                    _ = cancelled.wait_for(|cancelled| *cancelled) => {},
                                }
                                (watching.publication, watching.id)
                            }.boxed());
                            let descriptor = permit.descriptor(app.port);
                            external_page.permits.insert(publication_id, permit);
                            Ok(descriptor)
                        });
                        let response = control_reply(id, result);
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        continue;
                    }
                    Some((publication_id, permit_id)) = external_revocations.next(), if !external_revocations.is_empty() => {
                        if !external_page.permits.get(&publication_id).is_some_and(|permit| permit.id == permit_id) { continue; }
                        external_page.remove(publication_id);
                        let event = external_input_event(publication_id, None, None, true, None);
                        timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                        continue;
                    }
                    Some(request) = external_queue.recv() => {
                        match request {
                            whip::Request::Inspect { permit, generation, response } => {
                                let result = if permit.stopped() {
                                    Err(StatusCode::GONE)
                                } else if external_page.resources.get(&generation).is_some_and(|resource| {
                                    resource.permit == permit.id && !resource.control.is_stopped()
                                }) {
                                    Ok(())
                                } else {
                                    Err(StatusCode::NOT_FOUND)
                                };
                                let _ = response.send(result);
                            }
                            whip::Request::Offer { permit, offer, response } => {
                                if permit.stopped() || !external_page.permits.get(&permit.publication).is_some_and(|p| Arc::ptr_eq(p, &permit)) {
                                    let _ = response.send(Err(StatusCode::GONE)); continue;
                                }
                                let commands = host.clone();
                                let capture = captures.entry(permit.publication).or_default();
                                let Ok((cancel, registration)) = capture.prepare(SourceKind::External, capture.audio_settings) else { let _ = response.send(Err(StatusCode::CONFLICT)); continue; };
                                let replaces = capture.source().map(SourceLease::producer_id);
                                external_offers.push(async move {
                                    let mut response = response;
                                    let result = whip::prepare(&permit, commands, offer, replaces, registration, &mut response).await;
                                    (permit, cancel, response, result)
                                }.boxed());
                            }
                            whip::Request::Delete { permit, generation, response } => {
                                let Some(resource) = external_page.resources.get_mut(&generation).filter(|r| r.permit == permit.id) else { let _ = response.send(Err(StatusCode::NOT_FOUND)); continue; };
                                if resource.deleting { let _ = response.send(Err(StatusCode::CONFLICT)); continue; }
                                resource.deleting = true;
                                resource.control.stop();
                                let ended = resource.ended.clone();
                                external_deletes.push(async move { let _ = ended.await; let _ = response.send(Ok(())); }.boxed());
                            }
                        }
                        continue;
                    }
                    Some(()) = external_deletes.next(), if !external_deletes.is_empty() => { continue; }
                    Some((permit, cancel, response, prepared)) = external_offers.next(), if !external_offers.is_empty() => {
                        let publication_id = permit.publication;
                        if cancel.is_aborted() || permit.stopped() || response.is_closed() {
                            if !cancel.is_aborted() { if let Some(capture) = captures.get_mut(&publication_id) { capture.pending = None; } }
                            drop(prepared); let _ = response.send(Err(StatusCode::GONE)); continue;
                        }
                        match prepared {
                            Ok(mut prepared) => {
                                let generation = prepared.lease.id;
                                let (cancel, registration) = AbortHandle::new_pair();
                                let pending = captures.get_mut(&publication_id).unwrap().pending.as_mut().unwrap();
                                pending.request = cancel.clone();
                                pending.phase = CapturePhase::WaitingForExternal(generation);
                                let ended = prepared.lease.ended.take().expect("external generation owns completion");
                                let ended: whip::Ended = async move { ended.await.unwrap_or_else(|_| Err("external_input_stopped".into())) }.boxed().shared();
                                external_page.resources.insert(generation, whip::Resource { permit: permit.id, control: prepared.lease.control(), ended: ended.clone(), deleting: false });
                                external_ends.push(async move { (publication_id, generation, ended.await) }.boxed());
                                if response.send(Ok((generation, prepared.answer))).is_err() { prepared.lease.stop(); }
                                external_ready.push(async move {
                                    let mut revoked = permit.cancelled();
                                    let work = async {
                                        prepared.lease.ready().await?;
                                        Ok(prepared.lease)
                                    };
                                    let result = tokio::select! {
                                        result = Abortable::new(work, registration) => result.unwrap_or_else(|_| Err(anyhow!("capture_cancelled"))),
                                        _ = revoked.wait_for(|value| *value) => Err(anyhow!("capture_cancelled")),
                                    };
                                    (permit, generation, cancel, result)
                                }.boxed());
                            }
                            Err(error) => {
                                if let Some(capture) = captures.get_mut(&publication_id) { capture.pending = None; }
                                let _ = response.send(Err(StatusCode::UNPROCESSABLE_ENTITY));
                                let reason = error.to_string();
                                let retired = reason == "room_unavailable";
                                if retired { external_page.remove(publication_id); }
                                let event = captures.get(&publication_id).unwrap().external_event(publication_id, false, retired, Some(&reason));
                                timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                            }
                        }
                        continue;
                    }
                    Some((permit, generation, cancel, result)) = external_ready.next(), if !external_ready.is_empty() => {
                        let publication_id = permit.publication;
                        let Some(capture) = captures.get_mut(&publication_id) else { drop(result); continue; };
                        let Some(pending) = capture.pending_for(generation) else { drop(result); continue; };
                        if cancel.is_aborted() || permit.stopped() {
                            capture.pending = None;
                            drop(result); continue;
                        }
                        let event = match result {
                            Ok(lease) if !lease.is_stopped() => {
                                pending.phase = CapturePhase::Prepared(SourceLease::External(lease));
                                capture.external_event(publication_id, true, false, None)
                            }
                            // The producer ended after reporting readiness. Its terminal
                            // result owns the error and retirement of this generation.
                            Ok(_) => continue,
                            Err(error) => {
                                let error = error.to_string();
                                let retired = error == "room_unavailable";
                                capture.pending = None;
                                if retired { external_page.remove(publication_id); }
                                let event = capture.external_event(publication_id, false, retired, Some(&error));
                                match external_page.resources.get(&generation) {
                                    Some(resource) => external_format_event(event, resource.control.unsupported_video_format()),
                                    None => event,
                                }
                            }
                        };
                        timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                        continue;
                    }
                    Some((publication_id, generation, ended)) = external_ends.next(), if !external_ends.is_empty() => {
                        if captures.get_mut(&publication_id).and_then(|capture| capture.pending_for(generation)).is_some_and(|pending| matches!(pending.phase, CapturePhase::Committing(_))) {
                            continue;
                        }
                        if let Some(event) = retire_external(&mut captures, &mut external_page, publication_id, generation, ended) {
                            timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                        }
                        continue;
                    }
                    _ = host.closed() => return Ok("host_queue_closed"),
                    message = queue.recv() => message,
                    Some((publication_id, capture_id, error)) = audio_errors.next(), if !audio_errors.is_empty() => {
                        let error: Option<String> = error;
                        if error.is_some() && captures.get(&publication_id).and_then(Capture::lease).is_some_and(|lease| lease.id == capture_id) {
                            let event = json!({"type":"capture_audio_failed","publicationId":publication_id});
                            timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                        }
                        continue;
                    }
                    Some((publication_id, producer_id, result)) = capture_ends.next(), if !capture_ends.is_empty() => {
                        if let Some(capture) = captures.get_mut(&publication_id) {
                            let current = capture.active.as_ref().map(|lease| (lease.producer_id(), lease.id()));
                            if let Some(event) = capture_end_event(publication_id, producer_id, current, result) {
                                capture.active = None;
                                timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                            }
                        }
                        continue;
                    }
                    Some((publication_id, producer_id, changed, state)) = input_states.next(), if !input_states.is_empty() => {
                        let state: Option<SourceView> = state;
                        if let Some(state) = state.filter(|_| captures.get(&publication_id).and_then(Capture::lease).is_some_and(|lease| lease.producer_id() == producer_id)) {
                            let event = json!({"type":"input_state","publicationId":publication_id,"state":state});
                            timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                            input_states.push(next_input_state(publication_id, producer_id, changed));
                        }
                        continue;
                    }
                    Some((publication_id, changed, state)) = audio_states.next(), if !audio_states.is_empty() => {
                        let state: Option<SourceAudioState> = state;
                        if let Some(state) = state.filter(|_| captures.get(&publication_id).and_then(|c| c.audio.as_ref()).and_then(CaptureAudio::audio_state).is_some_and(|current| current.same_channel(&changed))) {
                            let event = json!({"type":"capture_audio_state","publicationId":publication_id,"state":state});
                            timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                            audio_states.push(next_audio_state(publication_id, changed));
                        }
                        continue;
                    }
                    response = async {
                        tokio::select! {
                            response = catalog_reply(&mut targets) => response,
                            response = catalog_reply(&mut microphones) => response,
                        }
                    }, if targets.is_some() || microphones.is_some() => {
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        continue;
                    }
                    response = async { opening.as_mut().expect("room open pending").await }, if opening.is_some() => {
                        opening = None;
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        continue;
                    }
                    response = async { metrics.as_mut().expect("metrics pending").await }, if metrics.is_some() => {
                        metrics = None;
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        continue;
                    }
                    Some((id, publication_id, capture_id, result)) = capture_stops.next(), if !capture_stops.is_empty() => {
                        let result: Result<()> = result;
                        let result = result.and_then(|()| {
                            let capture = captures.get_mut(&publication_id).ok_or_else(|| anyhow!("capture_unavailable"))?;
                            anyhow::ensure!(capture.active.as_ref().is_some_and(|lease| lease.id() == capture_id), "capture_unavailable");
                            capture.active = None;
                            if capture.pending.is_none() {
                                captures.remove(&publication_id);
                                external_page.remove(publication_id);
                            }
                            Ok(())
                        });
                        let response = control_reply(id, result.map(|()| Value::Null));
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        continue;
                    }
                    Some(response) = operations.next(), if !operations.is_empty() => {
                        let response: Value = response;
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        continue;
                    }
                    Some((id, result)) = previews.next(), if !previews.is_empty() => {
                        let result: Result<Option<String>> = result;
                        preview = None; // The capture has stopped and its worker has joined.
                        let response = control_reply(id, result.map(|image| json!(image)));
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        continue;
                    }
                    Some((id, publication_id, request, result)) = capture_starts.next(), if !capture_starts.is_empty() => {
                        let request: AbortHandle = request;
                        let result: Result<CaptureResult> = result;
                        let ended = (!request.is_aborted()).then(|| {
                            let pending = captures.get(&publication_id)?.pending.as_ref()?;
                            if pending.kind != SourceKind::External { return None; }
                            let CapturePhase::Committing(generation) = pending.phase else { return None; };
                            Some((generation, external_page.resources.get(&generation)?.ended.peek()?.clone()))
                        }).flatten();
                        let mut initial_input = None;
                        let mut initial_audio = None;
                        let result = if request.is_aborted() {
                            // Stop already retired this request, including a completed
                            // future that had not yet been observed by the processor.
                            drop(result);
                            Err(anyhow!("capture_cancelled"))
                        } else {
                            match result {
                                Ok(CaptureResult::Prepared { lease, codec }) => {
                                    let value = json!({"captureId":lease.id,"sessionId":lease.session_id,"codec":codec});
                                    if let Some(capture) = captures.get_mut(&publication_id) {
                                        if let Some(state) = lease.audio.as_ref().and_then(CaptureAudio::audio_state) { audio_states.push(next_audio_state(publication_id, state)); }
                                        capture.install_prepared(lease).map(|_| value)
                                    } else {
                                        Err(anyhow!("capture_cancelled"))
                                    }
                                }
                                Ok(CaptureResult::Committed(SourceLease::Capture(mut lease))) => {
                                    let retained = lease.retains_video();
                                    let capture = captures.entry(publication_id).or_default();
                                    if let Some(SourceLease::Capture(previous)) = capture.active.as_mut() { lease.adopt_previous(previous); }
                                    let capture_id = lease.id;
                                    if let Some(ended) = lease.ended.take() {
                                        let producer_id = lease.producer_id();
                                        capture_ends.push(async move { (publication_id, producer_id, ended.await.ok()) });
                                    }
                                    if let Some(error) = lease.audio_error.take() {
                                        audio_errors.push(async move { (publication_id, capture_id, error.await.ok()) });
                                    }
                                    if let Some(state) = &lease.input_state {
                                        initial_input = Some(state.borrow().clone());
                                        if !retained { input_states.push(next_input_state(publication_id, lease.producer_id(), state.clone())); }
                                    }
                                    if let Some(state) = lease.audio_state() {
                                        initial_audio = Some(state.borrow().clone());
                                    }
                                    capture.pending = None;
                                    capture.active = Some(SourceLease::Capture(lease));
                                    if external_page.remove(publication_id) {
                                        let event = external_input_event(publication_id, None, None, true, None);
                                        timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                                    }
                                    Ok(Value::Null)
                                }
                                Ok(CaptureResult::Committed(SourceLease::External(lease))) => {
                                    let capture = captures.entry(publication_id).or_default();
                                    capture.pending = None;
                                    capture.audio = None;
                                    capture.active = Some(SourceLease::External(lease));
                                    let event = capture.external_event(publication_id, false, false, None);
                                    timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                                    Ok(Value::Null)
                                }
                                Err(error) => Err(error),
                            }
                        };
                        if result.is_err() && !request.is_aborted() {
                            if let Some(capture) = captures.get_mut(&publication_id) {
                                let external = capture.pending.as_ref().is_some_and(|pending| pending.kind == SourceKind::External);
                                if ended.is_none() { capture.pending = None; }
                                if external && ended.is_none() && external_page.permits.contains_key(&publication_id) {
                                    let event = capture.external_event(publication_id, false, false, Some("external_input_failed"));
                                    timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                                }
                            }
                        }
                        let response = control_reply(id, result);
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        if let Some((generation, ended)) = ended {
                            if let Some(event) = retire_external(&mut captures, &mut external_page, publication_id, generation, ended) {
                                timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                            }
                        }
                        if let Some(state) = initial_input {
                            let event = json!({"type":"input_state","publicationId":publication_id,"state":state});
                            timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                        }
                        if let Some(state) = initial_audio {
                            let event = json!({"type":"capture_audio_state","publicationId":publication_id,"state":state});
                            timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                        }
                        continue;
                    }
                };
                let Some(text) = message else { return Ok("request_queue_closed") };
                let request = match control_request(&text)? {
                    Ok(request) => request,
                    Err(response) => {
                        send_control(&mut writer, response).await?;
                        continue;
                    }
                };
                let result: Result<Value> = match request.operation {
                    Operation::PrepareExternalInput {
                        publication_id,
                        room_id,
                    } => {
                        if !piik_channel_native::peer::supports_external_input() {
                            Err(anyhow!("external_input_unavailable"))
                        } else if let Some(permit) =
                            external_page.permits.get(&publication_id)
                        {
                            if permit.room != room_id || permit.stopped() {
                                Err(anyhow!("capture_room_mismatch"))
                            } else {
                                Ok(permit.descriptor(app.port))
                            }
                        } else if external_page
                            .permits
                            .values()
                            .any(|permit| permit.room == room_id)
                        {
                            Err(anyhow!("capture_pending"))
                        } else {
                            let commands = host.clone();
                            let capture = captures.entry(publication_id).or_default();
                            match capture.prepare(SourceKind::External, capture.audio_settings) {
                                Err(error) => Err(error),
                                Ok((cancel, registration)) => {
                                    external_authorizations.push(
                                        async move {
                                            let (result, authorized) = oneshot::channel();
                                            let authority = Abortable::new(
                                                async {
                                                    commands
                                                        .send(HostCommand::AuthorizeInput {
                                                            publication_id,
                                                            room_id: room_id.clone(),
                                                            result,
                                                        })
                                                        .await
                                                        .map_err(|_| {
                                                            anyhow!("hosting_unavailable")
                                                        })?;
                                                    authorized
                                                        .await
                                                        .map_err(|_| {
                                                            anyhow!("hosting_unavailable")
                                                        })?
                                                        .map_err(anyhow::Error::msg)
                                                },
                                                registration,
                                            )
                                            .await
                                            .unwrap_or_else(|_| {
                                                Err(anyhow!("capture_cancelled"))
                                            });
                                            (
                                                request.id,
                                                publication_id,
                                                room_id,
                                                cancel,
                                                authority,
                                            )
                                        }
                                        .boxed(),
                                    );
                                    continue;
                                }
                            }
                        }
                    }
                    Operation::Page(page::Operation::PageMediaPrepare {
                        page_id, candidate_id,
                        choice_id,
                    }) => {
                        match pages.prepare_media(page_id, candidate_id, choice_id, host.clone()) {
                            Ok(work) => {
                                operations.push(async move { control_reply(request.id, work.await) }.boxed());
                                continue;
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Operation::Page(page::Operation::PageMediaPrepareIndexed { page_id, candidate_id, video, audio }) => {
                        match pages.prepare_indexed_media(page_id, candidate_id, video, audio, host.clone()) {
                            Ok(work) => {
                                operations.push(async move { control_reply(request.id, work.await) }.boxed());
                                continue;
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Operation::Page(page::Operation::PageMediaPrepareMpd {
                        page_id, candidate_id,
                        source_id,
                        video_id,
                        audio_id,
                    }) => {
                        match pages.prepare_mpd_media(
                            page_id, candidate_id,
                            source_id,
                            video_id,
                            audio_id,
                            host.clone(),
                        ) {
                            Ok(work) => {
                                operations.push(
                                    async move { control_reply(request.id, work.await) }.boxed(),
                                );
                                continue;
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Operation::Page(page::Operation::PageMediaResource(resource)) => {
                        match resource {
                            page::ResourceRequest::InspectMpd {
                                page_id, candidate_id,
                                choice_id,
                                read_id,
                            } => match pages.inspect_mpd(page_id, candidate_id, choice_id, read_id) {
                                Ok(work) => {
                                    operations.push(
                                        async move { control_reply(request.id, work.await) }.boxed(),
                                    );
                                    continue;
                                }
                                Err(error) => Err(error),
                            },
                            page::ResourceRequest::ReadMetadata { page_id, candidate_id, choice_id, read_id, offset, length } => {
                                match pages.read_metadata(page_id, candidate_id, choice_id, read_id, offset, length) {
                                    Ok(work) => {
                                        operations.push(async move { control_reply(request.id, work.await) }.boxed());
                                        continue;
                                    }
                                    Err(error) => Err(error),
                                }
                            }
                            page::ResourceRequest::Read {
                                page_id,
                                source_id,
                                resource_id,
                                read_id,
                                offset,
                                length,
                            } => {
                                match pages.read_resource(
                                    page_id,
                                    source_id,
                                    resource_id,
                                    read_id,
                                    offset,
                                    length,
                                ) {
                                    Ok(work) => {
                                        operations.push(async move { control_reply(request.id, work.await) }.boxed());
                                        continue;
                                    }
                                    Err(error) => Err(error),
                                }
                            }
                            page::ResourceRequest::Cancel {
                                page_id,
                                read_id,
                            } => {
                                pages.cancel_resource(page_id, read_id);
                                Ok(Value::Null)
                            }
                        }
                    }
                    Operation::Page(page::Operation::PageMediaStop { page_id, candidate_id }) => {
                        if let Some(candidate) = candidate_id { pages.cancel_candidate(page_id, candidate); pages.request(page::Operation::PageMediaStop { page_id, candidate_id }).await?; } else { pages.stop_media(page_id); }
                        Ok(Value::Null)
                    }
                    Operation::Page(operation) => {
                        let source_page =
                            if let page::Operation::PageMediaSources { page_id, candidate_id } =
                                &operation
                            {
                                Some((*page_id, *candidate_id))
                            } else {
                                None
                            };
                        let mut result = pages.request(operation).await;
                        if let (Some(page), Ok(value)) = (source_page, &mut result) {
                            value["byteSource"] =
                                serde_json::to_value(pages.scoped_source(page.0, page.1))?;
                        }
                        // Selection facts (including the current top-level URL) precede confirmation.
                        for _ in 0..event_queue.len() {
                            let Ok(event) = event_queue.try_recv() else {
                                break;
                            };
                            timeout(
                                IO_TIMEOUT,
                                writer.send(control_event_message(&pages, event)),
                            )
                            .await??;
                        }
                        result
                    }
                    Operation::Hello { .. } => Err(anyhow!("already_initialized")),
                    Operation::Open { policy } => {
                        if opening.is_some() {
                            Err(anyhow!("request_pending"))
                        } else {
                            let commands = host.clone();
                            opening = Some(async move {
                                control_reply(request.id, open(&commands, &policy).await)
                            }.boxed());
                            continue;
                        }
                    }
                    Operation::LocalEndpoint => {
                        let commands = host.clone();
                        operations.push(async move {
                            let endpoint = async {
                                let (result, response) = oneshot::channel();
                                commands.send(HostCommand::LocalEndpoint(result)).await
                                    .map_err(|_| anyhow!("hosting_unavailable"))?;
                                let session_id = response.await.map_err(|_| anyhow!("hosting_unavailable"))?;
                                Ok::<_, anyhow::Error>(json!({"sessionId": session_id}))
                            }.await;
                            control_reply(request.id, endpoint)
                        }.boxed());
                        continue;
                    }
                    Operation::RelayCapacity(relay) => {
                        let (result, response) = oneshot::channel();
                        let commands = host.clone();
                        let request_id = request.id.clone();
                        operations.push(async move {
                            let work = async {
                                commands
                                    .send(HostCommand::RelayCapacity { request: relay, result })
                                    .await
                                    .map_err(|_| anyhow!("hosting_unavailable"))?;
                                let result = timeout(IO_TIMEOUT, response)
                                    .await
                                    .map_err(|_| anyhow!("request_timeout"))??
                                    .map_err(anyhow::Error::msg)?;
                                serde_json::to_value(result).map_err(anyhow::Error::from)
                            }.await;
                            control_reply(request_id, work)
                        }.boxed());
                        continue;
                    }
                    Operation::ConnectionMetrics {
                        room_id,
                        publication_id,
                    } => {
                        if metrics.is_some() {
                            Err(anyhow!("request_pending"))
                        } else {
                            let commands = host.clone();
                            metrics = Some(async move {
                                let measured = timeout(IO_TIMEOUT, async {
                                    let (result, response) = oneshot::channel();
                                    commands.send(HostCommand::ConnectionMetrics { room_id, publication_id, result }).await.map_err(|_| anyhow!("hosting_unavailable"))?;
                                    let measured = response.await?.map_err(anyhow::Error::msg)?;
                                    Ok::<_, anyhow::Error>(serde_json::to_value(measured)?)
                                }).await;
                                control_reply(request.id, measured.unwrap_or_else(|_| Err(anyhow!("request_timeout"))))
                            }.boxed());
                            continue;
                        }
                    }
                    operation @ (Operation::Targets | Operation::Microphones) => {
                        let (kind, reader, pending) = match operation {
                            Operation::Targets => (CaptureCatalogKind::Targets, &app.capture_targets, &mut targets),
                            _ => (CaptureCatalogKind::Microphones, &app.capture_microphones, &mut microphones),
                        };
                        if let Some((id, _)) = pending.replace((request.id, reader.read(kind).await)) {
                            let response = control_reply(id, Err(anyhow!("request_cancelled")));
                            timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        }
                        continue;
                    }
                    Operation::Preview { target } => {
                        if preview.is_some() {
                            Err(anyhow!("preview_busy"))
                        } else {
                            let (cancel, cancelled) = oneshot::channel();
                            preview = Some((request.id.clone(), Some(cancel)));
                            previews.push(async move {
                                (
                                    request.id,
                                    piik_channel_native::capture::preview(
                                        target, cancelled,
                                    )
                                    .await,
                                )
                            });
                            continue;
                        }
                    }
                    Operation::CancelPreview { request_id } => {
                        if let Some((id, cancel)) = &mut preview {
                            if *id == request_id {
                                if let Some(cancel) = cancel.take() {
                                    let _ = cancel.send(());
                                }
                            }
                        }
                        Ok(Value::Null)
                    }
                    Operation::PrepareCapture {
                        publication_id,
                        room_id,
                        target,
                        settings,
                        codec_mode,
                        encoding_execution,
                        audio_settings,
                        audio,
                        exclude_audio,
                        render_endpoint_id,
                        show_capture_border,
                    } => {
                        let capture = captures.entry(publication_id).or_default();
                        match capture.prepare(SourceKind::Capture, audio_settings) {
                            Err(error) => Err(error),
                            Ok((cancel, registration)) => {
                                let replaces =
                                    capture.source().map(SourceLease::producer_id);
                                let picker_events = cfg!(target_os = "android").then(|| control_events.clone());
                                let commands = host.clone();
                                capture_starts.push(
                                    async move {
                                        let result = Abortable::new(
                                            prepare_capture(
                                                &commands,
                                                publication_id,
                                                room_id,
                                                target,
                                                settings,
                                                codec_mode,
                                                encoding_execution,
                                                audio,
                                                exclude_audio,
                                                render_endpoint_id,
                                                show_capture_border,
                                                replaces,
                                                picker_events.as_ref().map(|events| (events, request.id.as_str())),
                                            ),
                                            registration,
                                        )
                                        .await
                                        .unwrap_or_else(|_| {
                                            Err(anyhow!("capture_cancelled"))
                                        });
                                        (request.id, publication_id, cancel, result)
                                    }
                                    .boxed(),
                                );
                                continue;
                            }
                        }
                    }
                    Operation::CommitCapture {
                        publication_id,
                        capture_id,
                    } => {
                        let candidate = captures.get_mut(&publication_id).and_then(|capture| {
                            let pending = capture.pending.as_mut()?;
                            let lease = pending.phase.prepared()?;
                            (lease.id() == capture_id && !lease.is_stopped())
                                .then_some((pending, capture.active.is_some()))
                        });
                        match candidate {
                            None => Err(anyhow!("capture_unavailable")),
                            Some((pending, replacing)) => {
                                let (cancel, registration) = AbortHandle::new_pair();
                                let previous = std::mem::replace(
                                    &mut pending.phase, CapturePhase::Committing(capture_id),
                                );
                                let CapturePhase::Prepared(lease) = previous else { unreachable!("candidate was prepared") };
                                pending.request.abort();
                                pending.request = cancel.clone();
                                let commands = host.clone();
                                capture_starts.push(
                                    async move {
                                        let result = Abortable::new(
                                            commit_capture(&commands, lease, replacing),
                                            registration,
                                        )
                                        .await
                                        .unwrap_or_else(|_| Err(anyhow!("capture_cancelled")))
                                        .map(CaptureResult::Committed);
                                        (request.id, publication_id, cancel, result)
                                    }
                                    .boxed(),
                                );
                                continue;
                            }
                        }
                    }
                    Operation::CancelCapture { publication_id } | Operation::CancelExternalInput { publication_id }
                        if captures.get(&publication_id).and_then(|capture| capture.pending.as_ref())
                            .is_some_and(|pending| matches!(pending.phase, CapturePhase::Committing(_))) =>
                    {
                        Err(anyhow!("capture_pending"))
                    }
                    Operation::CancelExternalInput { publication_id } => {
                        if let Some(event) = cancel_external_input(
                            publication_id,
                            captures.get_mut(&publication_id),
                            &mut external_page,
                        ) {
                            timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                        }
                        Ok(Value::Null)
                    }
                    Operation::CancelCapture { publication_id } => {
                        let cancel =
                            captures.get_mut(&publication_id).and_then(|capture| {
                                capture.pending.take_if(|pending| pending.kind == SourceKind::Capture);
                                capture.lease().map(CaptureLease::cancel_microphone)
                            });
                        match cancel {
                            Some(Ok(cancel)) => {
                                operations.push(async move {
                                    control_reply(request.id, cancel.await.map(|()| Value::Null))
                                }.boxed());
                                continue;
                            }
                            Some(Err(error)) => Err(error),
                            None => Ok(Value::Null),
                        }
                    }
                    Operation::TransferSource {
                        publication_id,
                        capture_id,
                        to_session_id,
                    } => {
                        let lease = captures
                            .get(&publication_id)
                            .and_then(Capture::source)
                            .filter(|lease| lease.id() == capture_id);
                        if let Some(lease) = lease {
                            let commands = host.clone();
                            let scope = lease.scope().clone();
                            let capture_id = lease.producer_id();
                            operations.push(async move {
                                let result = transfer_source(&commands, scope, capture_id, to_session_id).await;
                                control_reply(request.id, result.map(|()| Value::Null))
                            }.boxed());
                            continue;
                        } else {
                            Err(anyhow!("capture_unavailable"))
                        }
                    }
                    Operation::StopCapture { publication_id, capture_id: Some(capture_id), successor_watch_id: Some(successor_watch_id) } => {
                        if let Some(lease) = captures.get(&publication_id).and_then(Capture::source)
                            .filter(|lease| lease.id() == capture_id) {
                            let commands = host.clone();
                            let scope = lease.scope().clone();
                            let producer = lease.producer_id();
                            capture_stops.push(async move {
                                let result = edit_capture(&commands, scope, producer, CaptureEdit::Stop { successor_watch_id }).await;
                                (request.id, publication_id, capture_id, result)
                            }.boxed());
                            continue;
                        }
                        Err(anyhow!("capture_unavailable"))
                    }
                    Operation::StopCapture { publication_id, capture_id: None, successor_watch_id: None } => {
                        if external_page.remove(publication_id) {
                            let event = external_input_event(
                                publication_id,
                                None,
                                None,
                                true,
                                None,
                            );
                            timeout(
                                IO_TIMEOUT,
                                writer.send(Message::Text(event.to_string().into())),
                            )
                            .await??;
                        }
                        if let Some(capture) = captures.remove(&publication_id) {
                            if let Some(CapturePhase::Committing(generation)) = capture.pending.as_ref().map(|p| &p.phase) {
                                if external_page.resources.get(generation).is_some_and(|resource| resource.ended.peek().is_some()) {
                                    external_page.resources.remove(generation);
                                }
                            }
                        }
                        Ok(Value::Null)
                    }
                    Operation::StopCapture { .. } => Err(anyhow!("invalid_request")),
                    Operation::CaptureAudioSettings {
                        publication_id,
                        settings,
                    } => captures
                        .get_mut(&publication_id)
                        .ok_or_else(|| anyhow!("capture_unavailable"))
                        .and_then(|capture| capture.configure_audio(settings))
                        .map(|_| Value::Null),
                    Operation::CaptureVideoSettings {
                        publication_id,
                        capture_id,
                        settings,
                    } => {
                        let update = captures
                            .get(&publication_id)
                            .and_then(Capture::lease)
                            .filter(|lease| lease.id == capture_id)
                            .ok_or_else(|| anyhow!("capture_unavailable"))
                            .and_then(|lease| {
                                let commands = host.clone();
                                let scope = lease.scope.clone();
                                let producer = lease.producer_id();
                                lease.configure_video(settings, async move {
                                    publish_capture_settings(
                                        &commands,
                                        scope,
                                        producer,
                                        settings.into(),
                                    )
                                    .await
                                })
                            });
                        match update {
                            Ok(update) => {
                                operations.push(async move {
                                    control_reply(request.id, update.await.map(|()| Value::Null))
                                }.boxed());
                                continue;
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Operation::CaptureMicrophone {
                        publication_id,
                        capture_id,
                        room_id,
                        settings,
                    } => {
                        let update = captures
                            .get(&publication_id)
                            .and_then(Capture::lease)
                            .filter(|lease| {
                                lease.id == capture_id && lease.scope.room_id == room_id
                            })
                            .ok_or_else(|| anyhow!("capture_unavailable"))
                            .and_then(|lease| {
                                Ok((
                                    lease.configure_microphone(settings)?,
                                    lease
                                        .audio_state()
                                        .ok_or_else(|| anyhow!("capture_unavailable"))?,
                                ))
                            });
                        match update {
                            Ok((update, state)) => {
                                operations.push(async move {
                                    control_reply(request.id, update.await.map(|()| json!(state.borrow().microphone.clone())))
                                }.boxed());
                                continue;
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Operation::CapturePaused {
                        publication_id,
                        capture_id,
                        paused,
                    } => {
                        let lease = captures
                            .get(&publication_id)
                            .and_then(Capture::source)
                            .filter(|lease| lease.id() == capture_id);
                        if let Some(lease) = lease {
                            let commands = host.clone();
                            let scope = lease.scope().clone();
                            let capture_id = lease.producer_id();
                            operations.push(async move {
                                let result = pause_capture(&commands, scope, capture_id, paused).await;
                                control_reply(request.id, result.map(|()| Value::Null))
                            }.boxed());
                            continue;
                        } else {
                            Err(anyhow!("capture_unavailable"))
                        }
                    }
                    operation @ (Operation::CaptureTitle { .. }
                    | Operation::CaptureDirectLimit { .. }) => {
                        let (publication_id, expected_capture, edit) = match operation {
                            Operation::CaptureTitle {
                                publication_id,
                                capture_id,
                                title,
                            } => (
                                publication_id,
                                Some(capture_id),
                                CaptureEdit::Title(title),
                            ),
                            Operation::CaptureDirectLimit {
                                publication_id,
                                limit,
                            } => (publication_id, None, CaptureEdit::DirectLimit(limit)),
                            _ => unreachable!(),
                        };
                        let lease = captures
                            .get(&publication_id)
                            .and_then(Capture::source)
                            .filter(|lease| {
                                expected_capture.is_none_or(|id| lease.id() == id)
                            });
                        if let Some(lease) = lease {
                            let commands = host.clone();
                            let scope = lease.scope().clone();
                            let capture_id = lease.producer_id();
                            operations.push(async move {
                                let result = edit_capture(&commands, scope, capture_id, edit).await;
                                control_reply(request.id, result.map(|()| Value::Null))
                            }.boxed());
                            continue;
                        } else {
                            Err(anyhow!("capture_unavailable"))
                        }
                    }
                    Operation::InputPolicy {
                        publication_id,
                        capture_id,
                        mode,
                        password,
                        simultaneous,
                    } => {
                        let policy = captures
                            .get(&publication_id)
                            .and_then(Capture::lease)
                            .filter(|lease| lease.id == capture_id)
                            .ok_or_else(|| anyhow!("input_source_unavailable"))
                            .and_then(|lease| {
                                lease.set_input_policy(mode, password, simultaneous)
                            });
                        match policy {
                            Ok(policy) => {
                                operations.push(async move {
                                    control_reply(request.id, policy.await.map(|()| Value::Null))
                                }.boxed());
                                continue;
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Operation::InputDecide {
                        publication_id,
                        controller_session_id,
                        intent,
                        allow,
                    } => (|| -> Result<Value> {
                        let lease = captures
                            .get(&publication_id)
                            .and_then(Capture::lease)
                            .ok_or_else(|| anyhow!("input_source_unavailable"))?;
                        let source = lease
                            .remote
                            .as_ref()
                            .ok_or_else(|| anyhow!("input_source_unavailable"))?;
                        source.decide(controller_session_id, intent, allow)?;
                        Ok(Value::Null)
                    })(),
                    Operation::InputShortcut {
                        publication_id,
                        key,
                    } => {
                        let shortcut = captures
                            .get(&publication_id)
                            .and_then(Capture::lease)
                            .and_then(|lease| lease.remote.as_ref())
                            .ok_or_else(|| anyhow!("input_source_unavailable"))
                            .and_then(|source| source.set_shortcut(key));
                        match shortcut {
                            Ok(shortcut) => {
                                let desktop = app.desktop.clone();
                                operations.push(async move {
                                    control_reply(request.id, shortcut.await.map(|()| {
                                        let label = desktop.shortcut_label();
                                        let available = label.as_ref().is_none_or(Option::is_some);
                                        let mut value = json!({"key":key,"available":available});
                                        if let Some(label) = label { value["stopShortcutLabel"] = json!(label); }
                                        value
                                    }))
                                }.boxed());
                                continue;
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Operation::VoiceShortcuts(settings) => {
                        // This loop writes the report before polling the new registration's events.
                        voice_shortcuts.configure(settings)
                            .and_then(|report| Ok(serde_json::to_value(report)?))
                    }
                    };
                send_control(&mut writer, control_reply(request.id, result)).await?;
            }
        };
        tokio::pin!(reading, processing);
        let (reason, close_socket) = tokio::select! {
            biased;
            _ = closing.changed() => ("app_shutdown", false),
            _ = revoked.changed() => ("permission_revoked", false),
            reason = &mut reading => (reason, true),
            result = &mut processing => (result.unwrap_or_else(control_error_reason), true),
        };
        piik_channel_native::diagnostics::app_retired(pages.owner(), None, reason);
        close_socket
    };
    // Dropping the processor first stops every page-owned capture, including
    // while a Native request is awaiting admission or a room-host response.
    if close_socket {
        tokio::select! {
            biased;
            _ = closing.changed() => {},
            _ = revoked.changed() => {},
            _ = timeout(IO_TIMEOUT, writer.close()) => {},
        }
    }
}

fn control_error_reason(error: anyhow::Error) -> &'static str {
    if error.is::<axum::Error>() {
        "write_error"
    } else if error.is::<tokio::time::error::Elapsed>() {
        "write_timeout"
    } else {
        "request_processing_failed"
    }
}

async fn next_input_state(
    publication: Uuid,
    producer: Uuid,
    mut changed: watch::Receiver<SourceView>,
) -> (Uuid, Uuid, watch::Receiver<SourceView>, Option<SourceView>) {
    let state = changed
        .changed()
        .await
        .ok()
        .map(|_| changed.borrow_and_update().clone());
    (publication, producer, changed, state)
}
async fn next_audio_state(
    publication: Uuid,
    mut changed: watch::Receiver<SourceAudioState>,
) -> (
    Uuid,
    watch::Receiver<SourceAudioState>,
    Option<SourceAudioState>,
) {
    let state = changed
        .changed()
        .await
        .ok()
        .map(|_| changed.borrow_and_update().clone());
    (publication, changed, state)
}
async fn open(commands: &mpsc::Sender<HostCommand>, policy: &str) -> Result<Value> {
    let policy: RoomState = serde_json::from_str(policy)?;
    let (result, opened) = oneshot::channel();
    commands
        .send(HostCommand::Open(OpenRoom { policy, result }))
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    Ok(serde_json::to_value(
        opened
            .await
            .map_err(|_| anyhow!("hosting_unavailable"))?
            .map_err(anyhow::Error::msg)?,
    )?)
}

async fn capture_targets() -> Result<Value> {
    #[cfg(feature = "capture")]
    {
        tokio::task::spawn_blocking(|| {
            let codecs = piik_channel_native::capture::video_codecs()?;
            let sources = if codecs.is_empty() {
                Vec::new()
            } else {
                piik_channel_native::capture::targets()?
                    .into_iter()
                    .map(Target::with_catalog_title)
                    .collect()
            };
            let audio = piik_channel_native::capture::audio_capabilities();
            let mut result = json!({"sources": sources, "codecs": codecs, "softwareEncodingCodecs": piik_channel_native::capture::software_video_codecs()?, "processAudio": audio.process_audio, "processAudioExclusion": audio.process_audio_exclusion, "systemAudio": audio.system_audio, "captureBorderControl": piik_channel_native::capture::capture_border_control(), "videoAdaptation": piik_channel_native::capture::supports_video_adaptation()});
            #[cfg(target_os = "windows")]
            {
                result["renderEndpoints"] = json!(piik_channel_native::capture::render_endpoints().ok());
            }
            if let Some(activation) = piik_channel_native::capture::activation_url()? {
                result["activationURL"] = json!(activation);
            }
            Ok(result)
        }).await?
    }
    #[cfg(not(feature = "capture"))]
    {
        Ok(
            json!({"sources": [], "codecs": [], "softwareEncodingCodecs": [], "processAudio": false, "processAudioExclusion": false, "systemAudio": false, "captureBorderControl": false, "videoAdaptation": false}),
        )
    }
}

async fn prepare_capture(
    commands: &mpsc::Sender<HostCommand>,
    publication_id: Uuid,
    room_id: String,
    target: Target,
    settings: Settings,
    codec_mode: VideoCodecMode,
    encoding_execution: EncodingExecution,
    audio: bool,
    exclude_audio: Option<Target>,
    render_endpoint_id: Option<String>,
    show_capture_border: bool,
    replaces: Option<Uuid>,
    picker: Option<(&mpsc::Sender<Value>, &str)>,
) -> Result<CaptureResult> {
    if !cfg!(feature = "capture") {
        bail!("capture_unavailable");
    }
    settings.validate()?;
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::PrepareCapture(PrepareCapture {
            publication_id,
            room_id,
            target,
            settings,
            codec_mode,
            encoding_execution,
            audio,
            exclude_audio,
            render_endpoint_id,
            show_capture_border,
            replaces,
            result,
        }))
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    let mut lease = response
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?
        .map_err(anyhow::Error::msg)?;
    if let Some((events, request_id)) = picker {
        events.send(json!({"type":"picker_ready","requestId":request_id,"captureId":lease.id})).await?;
    }
    lease.ready().await.map_err(|error| {
        if error.is::<Aborted>() {
            anyhow!("capture_cancelled")
        } else {
            anyhow!("capture_failed")
        }
    })?;
    Ok(CaptureResult::Prepared {
        codec: lease.video_codec()?,
        lease,
    })
}

async fn commit_capture(
    commands: &mpsc::Sender<HostCommand>,
    mut lease: SourceLease,
    replacing: bool,
) -> Result<SourceLease> {
    anyhow::ensure!(!lease.is_stopped(), "capture_cancelled");
    let (result, response) = oneshot::channel();
    let capture = lease.capture();
    commands
        .send(HostCommand::CommitCapture(CommitCapture {
            scope: lease.scope().clone(),
            capture_id: lease.id(),
            replacing,
            retaining: capture.is_some_and(CaptureLease::retains_video),
            video_settings: capture.and_then(CaptureLease::video_settings),
            result,
        }))
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    let input = response
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?
        .map_err(anyhow::Error::msg)?;
    if let SourceLease::Capture(lease) = &mut lease {
        lease.remote = input.remote;
        lease.input_state = input.state;
    }
    Ok(lease)
}
async fn transfer_source(
    commands: &mpsc::Sender<HostCommand>,
    scope: piik_channel_native::peer::CaptureScope,
    capture_id: Uuid,
    to_session_id: Uuid,
) -> Result<()> {
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::TransferSource(TransferSource {
            scope,
            capture_id,
            to_session_id,
            result,
        }))
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    response
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?
        .map_err(anyhow::Error::msg)
}

async fn pause_capture(
    commands: &mpsc::Sender<HostCommand>,
    scope: piik_channel_native::peer::CaptureScope,
    capture_id: Uuid,
    paused: bool,
) -> Result<()> {
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::PauseCapture(PauseCapture {
            scope,
            capture_id,
            paused,
            result,
        }))
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    response
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?
        .map_err(anyhow::Error::msg)
}

async fn edit_capture(
    commands: &mpsc::Sender<HostCommand>,
    scope: piik_channel_native::peer::CaptureScope,
    capture_id: Uuid,
    edit: CaptureEdit,
) -> Result<()> {
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::EditCapture(EditCapture {
            scope,
            capture_id,
            edit,
            result,
        }))
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    response
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?
        .map_err(anyhow::Error::msg)
}

async fn publish_capture_settings(
    commands: &mpsc::Sender<HostCommand>,
    scope: piik_channel_native::peer::CaptureScope,
    capture_id: Uuid,
    settings: piik_channel_core::wire::VideoSettings,
) -> Result<()> {
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::PublishCaptureSettings(
            PublishCaptureSettings {
                scope,
                capture_id,
                settings,
                result,
            },
        ))
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    response
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?
        .map_err(anyhow::Error::msg)
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[tokio::test]
    async fn host_readiness_is_not_an_io_timeout_or_a_restore_barrier() {
        use tokio_tungstenite::{
            connect_async,
            tungstenite::{client::IntoClientRequest, Message as WsMessage},
        };
        let directory = tempfile::tempdir().unwrap();
        let site = "https://owned.test".to_string();
        let key = (site.clone(), Uuid::from_u128(1), Uuid::from_u128(2));
        let permission = Arc::new(Permission::new(Uuid::from_u128(3)));
        let other_site = "https://other.test".to_string();
        let other_key = (other_site.clone(), key.1, key.2);
        let other_permission = Arc::new(Permission::new(Uuid::from_u128(4)));
        let (commands, mut receiver) = mpsc::channel(1);
        let (ready, admitted) = watch::channel(None);
        let (stop, mut stopped) = watch::channel(false);
        let (entered, mut target_reads) = mpsc::unbounded_channel();
        let release_targets = Arc::new(tokio::sync::Semaphore::new(0));
        let target_gate = release_targets.clone();
        let (mic_entered, mut mic_reads) = mpsc::unbounded_channel();
        let release_microphones = Arc::new(tokio::sync::Semaphore::new(0));
        let microphone_gate = release_microphones.clone();
        let host = Host {
            credential: "owned".into(),
            commands: commands.clone(),
            ready: admitted,
            stop: stop.clone(),
            task: host_task(tokio::spawn(async move {
                let _ = stopped.changed().await;
                Ok(())
            })),
        };
        let mut other_stopped = stop.subscribe();
        let other_host = Host {
            credential: "owned".into(),
            commands: commands.clone(),
            ready: watch::channel(Some(Ok(()))).1,
            stop: stop.clone(),
            task: host_task(tokio::spawn(async move {
                let _ = other_stopped.changed().await;
                Ok(())
            })),
        };
        let app = Arc::new(App {
            config: Config {
                data_root: directory.path().into(),
                assets: directory.path().into(),
                open_browser: false,
                terminal_notice: None,
                page_player: None,
                website_permission_reset: None,
                window_navigation: None,
                cloudflared: PathBuf::new(),
                ice_servers: vec![],
                update: Default::default(),
            },
            port: 0,
            token: "owned".into(),
            registry: Mutex::new(Registry {
                sites: sites::Sites::open(directory.path()).unwrap(),
                approvals: BTreeMap::from([
                    (site.clone(), permission.clone()),
                    (other_site.clone(), other_permission),
                ]),
                hosts: BTreeMap::from([(key.clone(), host), (other_key, other_host)]),
                local: None,
            }),
            closing: watch::channel(false).0,
            launch: Mutex::new(None),
            desktop: Desktop::new().unwrap(),
            external_inputs: whip::Inputs::default(),
            capture_targets: CaptureTargetReader {
                test_read: Some(Arc::new(move || {
                    entered.send(()).unwrap();
                    let target_gate = target_gate.clone();
                    async move {
                        target_gate.acquire().await.unwrap().forget();
                        Ok(json!({"sources":[]}))
                    }.boxed()
                })),
                ..Default::default()
            },
            capture_microphones: CaptureTargetReader {
                test_read: Some(Arc::new(move || {
                    mic_entered.send(()).unwrap();
                    let microphone_gate = microphone_gate.clone();
                    async move {
                        microphone_gate.acquire().await.unwrap().forget();
                        Ok(json!([{"id":"mic","label":"Fixture microphone"}]))
                    }.boxed()
                })),
                ..Default::default()
            },
            voice_shortcuts: voice_shortcuts::Owner::default(),
            update: update::Owner::disabled(),
        });
        // The Native readiness producer is held before Welcome/bindings. Restoring
        // a retained runtime must not wait for that remote fact in the Domain loop.
        let (restored, pending) = app
            .ensure_host(
                &site,
                &permission,
                key.1,
                key.2,
                "owned".into(),
                "Test".into(),
            )
            .await
            .unwrap();
        assert!(restored.same_channel(&commands));
        assert!(pending.borrow().is_none());
        drop(pending);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop_server, server_stopped) = oneshot::channel();
        let router = Router::new()
            .route("/rooms", get(upgrade))
            .with_state(app.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = server_stopped.await;
                })
                .await
                .unwrap();
        });
        let mut request = format!("ws://{address}/rooms")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", site.parse().unwrap());
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            "piik-channel-rooms.owned".parse().unwrap(),
        );
        let (mut socket, _) = connect_async(request.clone()).await.unwrap();
        let exchange =
            async |socket: &mut tokio_tungstenite::WebSocketStream<_>, request: Value| {
                socket.send(WsMessage::Text(request.to_string().into())).await.unwrap();
                let reply = timeout(IO_TIMEOUT, socket.next()).await.unwrap().unwrap().unwrap();
                serde_json::from_str::<Value>(reply.to_text().unwrap()).unwrap()
            };
        for operation in [
            json!({"id":"before-hello","type":"local_endpoint"}),
            json!({"id":"before-hello","type":"cancel_preview","requestId":"preview"}),
            json!({"id":"before-hello","type":"stop_capture","publicationId":Uuid::new_v4()}),
        ] {
            assert_eq!(
                exchange(&mut socket, operation).await,
                json!({"id":"before-hello","error":"hello_required"})
            );
        }
        assert_eq!(
            exchange(&mut socket, json!({"id":"bad-request","type":"unknown"})).await,
            json!({"id":"bad-request","error":"invalid_request"})
        );
        assert!(receiver.try_recv().is_err());
        socket
            .send(WsMessage::Text(
                json!({"id":"hello","type":"hello","channelId":key.1,
            "userId":key.2,"credential":"owned","name":"Test"})
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        timeout(IO_TIMEOUT, async {
            while ready.receiver_count() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // A real upgraded control WebSocket must remain pending beyond the old
        // five-second admission wrapper while Native readiness is held.
        assert!(timeout(IO_TIMEOUT + Duration::from_secs(1), socket.next())
            .await
            .is_err());
        socket.close(None).await.unwrap();
        // The production reader/processor select drops hello on peer close;
        // its independently retained Host continues to own the only receiver.
        timeout(IO_TIMEOUT, async {
            while ready.receiver_count() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!*stop.borrow());
        ready.send_replace(Some(Ok(())));
        let connected = app
            .hello(
                &site,
                &permission,
                key.1,
                key.2,
                "owned".into(),
                "Test".into(),
            )
            .await
            .unwrap();
        assert!(connected.same_channel(&commands));
        for revoke in [false, true] {
            ready.send_replace(Some(Ok(())));
            let (mut socket, _) = connect_async(request.clone()).await.unwrap();
            let hello = json!({"id":"hello","type":"hello","channelId":key.1,
                "userId":key.2,"credential":"owned","name":"Test"});
            let mut wrong_credential = hello.clone();
            wrong_credential["credential"] = json!("wrong");
            assert_eq!(
                exchange(&mut socket, wrong_credential).await,
                json!({"id":"hello","error":"owner_mismatch"})
            );
            assert_eq!(
                exchange(&mut socket, hello.clone()).await,
                json!({"id":"hello","result":null})
            );
            assert_eq!(
                exchange(&mut socket, hello).await,
                json!({"id":"hello","error":"already_initialized"})
            );
            if voice_shortcuts::AVAILABLE {
                let enable = json!({
                    "id":"voice","type":"voice_shortcuts","enabled":true,"microphone":null,"listening":null
                });
                let result = json!({"id":"voice","result":{"microphone":"unbound","listening":"unbound"}});
                assert_eq!(exchange(&mut socket, enable.clone()).await, result);

                let mut other_request = request.clone();
                let other_origin = if revoke { &other_site } else { &site };
                other_request.headers_mut().insert("Origin", other_origin.parse().unwrap());
                let (mut other, _) = connect_async(other_request).await.unwrap();
                assert_eq!(
                    exchange(&mut other, json!({
                        "id":"hello","type":"hello","channelId":key.1,
                        "userId":key.2,"credential":"owned","name":"Other tab"
                    })).await,
                    json!({"id":"hello","result":null})
                );
                let mut disable = enable.clone();
                disable["enabled"] = json!(false);
                assert_eq!(exchange(&mut other, disable).await, result);
                assert_eq!(
                    exchange(&mut other, enable).await,
                    json!({"id":"voice","error":"voice_shortcuts_in_use"})
                );
                other.close(None).await.unwrap();
            }
            // A previously approved control remains valid while its Native Host
            // loses admission. Identity reads do not reuse the readiness gate.
            ready.send_replace(None);
            socket.send(WsMessage::Text(json!({"id":"microphones","type":"microphones"}).to_string().into())).await.unwrap();
            timeout(IO_TIMEOUT, mic_reads.recv()).await.unwrap().unwrap();
            if !revoke {
                socket.send(WsMessage::Text(json!({"id":"old-targets","type":"targets"}).to_string().into())).await.unwrap();
                timeout(IO_TIMEOUT, target_reads.recv()).await.unwrap().unwrap();
                socket.send(WsMessage::Text(json!({"id":"refresh-targets","type":"targets"}).to_string().into())).await.unwrap();
                let cancelled = timeout(IO_TIMEOUT, socket.next()).await.unwrap().unwrap().unwrap();
                assert_eq!(serde_json::from_str::<Value>(cancelled.to_text().unwrap()).unwrap(),
                    json!({"id":"old-targets","error":"request_cancelled"}));
                for endpoint in [Some(Uuid::new_v4()), None] {
                    socket
                        .send(WsMessage::Text(
                            json!({"id":"endpoint","type":"local_endpoint"})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                    let HostCommand::LocalEndpoint(result) = timeout(IO_TIMEOUT, receiver.recv())
                        .await.unwrap().unwrap() else { panic!("local endpoint read expected") };
                    result.send(endpoint).unwrap();
                    let reply = timeout(IO_TIMEOUT, socket.next()).await.unwrap().unwrap().unwrap();
                    assert_eq!(
                        serde_json::from_str::<Value>(reply.to_text().unwrap()).unwrap(),
                        json!({"id":"endpoint","result":{"sessionId":endpoint}})
                    );
                    assert!(ready.borrow().is_none());
                }
                assert!(target_reads.try_recv().is_err());
                assert!(mic_reads.try_recv().is_err());
                let policy = RoomState::new(
                    "test-room".into(), "Test room".into(), Default::default(), key.2,
                    piik_channel_core::wire::RoomAccess::Public, false, None,
                ).unwrap();
                socket.send(WsMessage::Text(json!({
                    "id":"open","type":"open","policy":serde_json::to_string(&policy).unwrap()
                }).to_string().into())).await.unwrap();
                let HostCommand::Open(opening) = timeout(IO_TIMEOUT, receiver.recv())
                    .await.unwrap().unwrap() else { panic!("room opening expected") };
                socket.send(WsMessage::Text(json!({
                    "id":"second-open","type":"open","policy":serde_json::to_string(&policy).unwrap()
                }).to_string().into())).await.unwrap();
                let second = timeout(IO_TIMEOUT, socket.next()).await.unwrap().unwrap().unwrap();
                assert_eq!(serde_json::from_str::<Value>(second.to_text().unwrap()).unwrap(),
                    json!({"id":"second-open","error":"request_pending"}));
                assert!(receiver.try_recv().is_err());
                release_microphones.add_permits(1);
                let microphones = timeout(IO_TIMEOUT, socket.next()).await.unwrap().unwrap().unwrap();
                assert_eq!(serde_json::from_str::<Value>(microphones.to_text().unwrap()).unwrap(),
                    json!({"id":"microphones","result":[{"id":"mic","label":"Fixture microphone"}]}));
                assert!(opening.result.send(Err("fixture_open_failed".into())).is_ok());
                let opened = timeout(IO_TIMEOUT, socket.next()).await.unwrap().unwrap().unwrap();
                assert_eq!(serde_json::from_str::<Value>(opened.to_text().unwrap()).unwrap(),
                    json!({"id":"open","error":"fixture_open_failed"}));
                release_targets.add_permits(1);
                let refreshed = timeout(IO_TIMEOUT, socket.next()).await.unwrap().unwrap().unwrap();
                assert_eq!(serde_json::from_str::<Value>(refreshed.to_text().unwrap()).unwrap(),
                    json!({"id":"refresh-targets","result":{"sources":[]}}));
                socket.send(WsMessage::Text(json!({"id":"new-targets","type":"targets"}).to_string().into())).await.unwrap();
                timeout(IO_TIMEOUT, target_reads.recv()).await.unwrap().unwrap();
                release_targets.add_permits(1);
                let refreshed = timeout(IO_TIMEOUT, socket.next()).await.unwrap().unwrap().unwrap();
                assert_eq!(serde_json::from_str::<Value>(refreshed.to_text().unwrap()).unwrap(),
                    json!({"id":"new-targets","result":{"sources":[]}}));
            }
            socket
                .send(WsMessage::Text(
                    json!({"id":"pending-endpoint","type":"local_endpoint"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let pending = timeout(IO_TIMEOUT, receiver.recv()).await;
            if revoke {
                permission.revoked.send_replace(true);
                let closed = timeout(IO_TIMEOUT, socket.next()).await.unwrap();
                assert!(match closed {
                    None | Some(Err(_)) | Some(Ok(WsMessage::Close(_))) => true,
                    _ => false,
                });
                release_microphones.add_permits(1);
            } else {
                socket.close(None).await.unwrap();
            }
            let HostCommand::LocalEndpoint(mut result) = pending
                .expect("mic enumeration blocked the authorized control socket")
                .unwrap() else { panic!("pending local endpoint read expected") };
            timeout(IO_TIMEOUT, result.closed()).await.unwrap();
            assert!(!*stop.borrow(), "control retirement stopped its independent Host");
            if voice_shortcuts::AVAILABLE {
                let settings = serde_json::from_value(json!({
                    "enabled":true,"microphone":null,"listening":null
                })).unwrap();
                assert!(app.voice_shortcuts.connect().configure(settings).is_ok());
            }
        }
        timeout(IO_TIMEOUT, app.shutdown()).await.unwrap();
        assert!(*stop.borrow());
        let _ = stop_server.send(());
        timeout(IO_TIMEOUT, server).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn active_resource_websocket_reads_and_cancels_without_blocking_control() {
        use tokio_tungstenite::{
            connect_async,
            tungstenite::{client::IntoClientRequest, Message as WsMessage},
        };
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = tempfile::tempdir().unwrap();
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let media_url = format!("http://{}/file", origin.local_addr().unwrap());
        let (entered, mut slow) = mpsc::unbounded_channel();
        let (released, mut released_reads) = mpsc::unbounded_channel();
        struct PendingHttp(mpsc::UnboundedSender<()>);
        impl Drop for PendingHttp {
            fn drop(&mut self) { let _ = self.0.send(()); }
        }
        let http = tokio::spawn(async move {
            axum::serve(
                origin,
                Router::new().route(
                    "/file",
                    get(move |headers: HeaderMap| {
                        let entered = entered.clone();
                        let released = released.clone();
                        async move {
                            let value = headers
                                .get("range")
                                .unwrap()
                                .to_str()
                                .unwrap()
                                .strip_prefix("bytes=")
                                .unwrap();
                            let (start, end) = value.split_once('-').unwrap();
                            let start = start.parse::<u64>().unwrap();
                            let end = end.parse::<u64>().unwrap().min(131071);
                            if start == 65536 {
                                let _pending = PendingHttp(released);
                                entered.send(()).unwrap();
                                std::future::pending::<()>().await;
                            }
                            Response::builder()
                                .status(206)
                                .header("Content-Type", "video/mp4")
                                .header("Content-Range", format!("bytes {start}-{end}/131072"))
                                .body(axum::body::Body::from(vec![
                                    42u8;
                                    (end - start + 1) as usize
                                ]))
                                .unwrap()
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let site = "https://owned.test".to_string();
        let channel = Uuid::new_v4();
        let user = Uuid::new_v4();
        let session = Uuid::new_v4();
        let mut sites = sites::Sites::open(dir.path()).unwrap();
        let permission = Arc::new(Permission::new(sites.approve(&site, true, false).unwrap()));
        let (commands, mut inputs) = mpsc::channel(8);
        let (stop, mut stopped) = watch::channel(false);
        let (registered, mut registrations) = mpsc::unbounded_channel();
        let (revoked, mut revocations) = mpsc::unbounded_channel();
        let (metrics, mut measurements) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let (_provider_alive, provider_retired) = watch::channel(false);
            loop {
                tokio::select! {
                    _=stopped.changed()=>break,
                    command=inputs.recv()=>match command {
                        Some(HostCommand::RegisterWatchReader { resource_id,reader,result })=>{registered.send((resource_id,reader)).unwrap();let _=result.send(Ok(piik_channel_native::session::WatchReaderRegistration { session_id: session, retired: provider_retired.clone() }));},
                        Some(HostCommand::RevokeWatchReader { resource_id })=>{let _=revoked.send(resource_id);},
                        Some(HostCommand::ConnectionMetrics { result, .. })=>{metrics.send(result).unwrap();},
                        Some(_)=>panic!("unexpected host command"),None=>break,
                    }
                }
            }
            Ok(())
        });
        let host = Host {
            credential: "owned".into(),
            commands,
            ready: watch::channel(Some(Ok(()))).1,
            stop,
            task: host_task(task),
        };
        let (_retire, retired) = watch::channel(false);
        let dispatch: page::Dispatcher = Arc::new(move |command| {
            if let page::Command::Media { reply, .. } = command {
                let _ = reply.send(Ok((page::MediaContext {
                    url: media_url.clone(),
                    request: None,
                    format: page::Format::File,
                    size: Some(131072),
                    retired: retired.clone(),
                    cookies: Arc::new(|_| Box::pin(async { Ok(None) })),
                }, Default::default())));
            }
            true
        });
        let app = Arc::new(App {
            config: Config {
                data_root: dir.path().into(),
                assets: dir.path().into(),
                open_browser: false,
                terminal_notice: None,
                page_player: Some(dispatch),
                website_permission_reset: None,
                window_navigation: None,
                cloudflared: PathBuf::new(),
                ice_servers: vec![],
                update: Default::default(),
            },
            port: address.port(),
            token: "owned".into(),
            registry: Mutex::new(Registry {
                sites,
                approvals: BTreeMap::from([(site.clone(), permission)]),
                hosts: BTreeMap::from([((site.clone(), channel, user), host)]),
                local: None,
            }),
            closing: watch::channel(false).0,
            launch: Mutex::new(None),
            desktop: Desktop::new().unwrap(),
            external_inputs: whip::Inputs::default(),
            capture_targets: CaptureTargetReader::default(),
            capture_microphones: CaptureTargetReader::default(),
            voice_shortcuts: voice_shortcuts::Owner::default(),
            update: update::Owner::disabled(),
        });
        let server_app = app.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/rooms", get(upgrade))
                    .with_state(server_app),
            )
            .await
            .unwrap();
        });
        let mut request = format!("ws://{address}/rooms")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", site.parse().unwrap());
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            "piik-channel-rooms.owned".parse().unwrap(),
        );
        let (mut socket, _) = connect_async(request).await.unwrap();
        macro_rules! send {
            ($v:expr) => {
                socket
                    .send(WsMessage::Text($v.to_string().into()))
                    .await
                    .unwrap()
            };
        }
        macro_rules! receive {
            () => {
                serde_json::from_str::<Value>(
                    &timeout(Duration::from_secs(3), socket.next())
                        .await
                        .unwrap()
                        .unwrap()
                        .unwrap()
                        .into_text()
                        .unwrap(),
                )
                .unwrap()
            };
        }
        send!(
            json!({"id":"hello","type":"hello","channelId":channel,"userId":user,"credential":"owned","name":"Owned"})
        );
        assert!(receive!()["error"].is_null());
        let page = Uuid::new_v4();
        let metadata = |id: Uuid, offset: u64| json!({"id":id,"type":"page_media_resource","action":"read_metadata","pageId":page,"choiceId":Uuid::new_v4(),"readId":id,"offset":offset,"length":16});
        let pending_metadata = Uuid::new_v4();
        send!(metadata(pending_metadata, 65536));
        timeout(Duration::from_secs(3), slow.recv()).await.unwrap().unwrap();
        let metrics = |id: &str| json!({"id":id,"type":"connection_metrics","roomId":"room"});
        send!(metrics("metrics"));
        send!(metrics("duplicate"));
        assert_eq!(receive!(), json!({"id":"duplicate","error":"request_pending"}));
        let measure = || piik_channel_native::peer::NativeConnectionMetrics {
            session_id: session, binding_id: channel, connections: vec![],
        };
        measurements.recv().await.unwrap().send(Err("room_unavailable".into())).unwrap();
        assert_eq!(receive!(), json!({"id":"metrics","error":"room_unavailable"}));
        send!(metrics("retry"));
        measurements.recv().await.unwrap().send(Ok(measure())).unwrap();
        assert_eq!(receive!(), json!({"id":"retry","result":measure()}));
        send!(json!({"id":"cancel-metadata","type":"page_media_resource","action":"cancel","pageId":page,"readId":pending_metadata}));
        let replies = [receive!(), receive!()];
        assert!(replies.iter().any(|reply| reply["id"] == "cancel-metadata" && reply["error"].is_null()));
        assert!(replies.iter().any(|reply| reply["id"] == pending_metadata.to_string() && reply["error"] == "watch_read_cancelled"));
        timeout(Duration::from_secs(3), released_reads.recv()).await.unwrap().unwrap();
        send!(metadata(Uuid::new_v4(), 0));
        let next_metadata = receive!();
        assert!(next_metadata["error"].is_null(), "{next_metadata}");
        assert_eq!(next_metadata["result"]["bytesBase64"].as_str().unwrap().len(), 24);
        send!(
            json!({"id":"prepare","type":"page_media_prepare","pageId":page,"choiceId":Uuid::new_v4()})
        );
        let prepared = receive!();
        assert!(prepared["error"].is_null(), "{prepared}");
        let root = prepared["result"]["resourceId"]
            .as_str()
            .unwrap()
            .to_string();
        let (registered_root, reader) = registrations.recv().await.unwrap();
        assert_eq!(registered_root.to_string(), root);
        assert_eq!(
            reader.read(registered_root, 0, 1).await.unwrap().bytes,
            vec![42]
        );
        let read = |id: Uuid, offset: u64, length: u32| json!({"id":id,"type":"page_media_resource","action":"read","pageId":page,"sourceId":root,"resourceId":root,"readId":id,"offset":offset,"length":length});
        send!(read(Uuid::new_v4(), 0, 65536));
        let full = receive!();
        assert!(full["error"].is_null(), "{full}");
        assert_eq!(full["result"]["bytesBase64"].as_str().unwrap().len(), 87384);
        assert!(full.to_string().len() < MAX_REQUEST_BYTES);
        let pending = Uuid::new_v4();
        send!(read(pending, 65536, 65536));
        timeout(Duration::from_secs(3), slow.recv())
            .await
            .unwrap()
            .unwrap();
        send!(
            json!({"id":"cancel","type":"page_media_resource","action":"cancel","pageId":page,"readId":pending})
        );
        let first = receive!();
        let second = receive!();
        assert!([&first, &second]
            .iter()
            .any(|v| v["id"] == "cancel" && v["error"].is_null()));
        assert!([&first, &second]
            .iter()
            .any(|v| v["id"] == pending.to_string() && v["error"] == "watch_read_cancelled"));
        timeout(Duration::from_secs(3), released_reads.recv()).await.unwrap().unwrap();
        send!(read(Uuid::new_v4(), 0, 1));
        assert!(receive!()["error"].is_null());
        send!(json!({"id":"stop","type":"page_media_stop","pageId":page}));
        assert!(receive!()["error"].is_null());
        send!(read(Uuid::new_v4(), 0, 1));
        assert_eq!(receive!()["error"], "watch_source_retired");
        assert_eq!(
            timeout(Duration::from_secs(3), revocations.recv())
                .await
                .unwrap()
                .unwrap(),
            registered_root
        );
        send!(json!({"id":"prepare-again","type":"page_media_prepare","pageId":page,"choiceId":Uuid::new_v4()}));
        let prepared = receive!(); assert!(prepared["error"].is_null());
        let (new_root, retained) = registrations.recv().await.unwrap();
        assert_ne!(new_root, registered_root);
        send!(read(Uuid::new_v4(),0,1));assert_eq!(receive!()["error"],"watch_source_retired");
        send!(json!({"id":"closing-read","type":"page_media_resource","action":"read","pageId":page,"sourceId":new_root,"resourceId":new_root,"readId":Uuid::new_v4(),"offset":65536,"length":1}));
        timeout(Duration::from_secs(3),slow.recv()).await.unwrap().unwrap();
        send!(metadata(Uuid::new_v4(), 65536));
        timeout(Duration::from_secs(3), slow.recv()).await.unwrap().unwrap();
        send!(metrics("closing"));
        let mut closing_metrics = timeout(Duration::from_secs(3), measurements.recv()).await.unwrap().unwrap();
        socket.close(None).await.unwrap();
        timeout(Duration::from_secs(3), closing_metrics.closed()).await.unwrap();
        for _ in 0..2 {
            timeout(Duration::from_secs(3), released_reads.recv()).await.unwrap().unwrap();
        }
        assert_eq!(timeout(Duration::from_secs(3),revocations.recv()).await.unwrap().unwrap(),new_root);
        assert_eq!(retained.read(new_root,0,1).await.unwrap_err().to_string(),"watch_source_retired");
        {
            let registry = app.registry.lock().await;
            assert_eq!(registry.hosts.len(), 1);
            assert!(!registry.hosts.values().next().unwrap().finished());
        }
        app.registry.lock().await.hosts.values().for_each(|h| {
            h.stop.send_replace(true);
        });
        server.abort();
        http.abort();
        let _ = server.await;
        let _ = http.await;
    }


    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
    };

    #[tokio::test]
    async fn external_startup_checks_the_site_before_opening_it() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let site = format!("http://{}", listener.local_addr().unwrap());
        let mut sites = sites::Sites::open(directory.path()).unwrap();
        let bookmark = sites::Bookmark { id: Uuid::new_v4(), origin: site.clone(), name: "Old".into() };
        sites.save_bookmark(&bookmark).unwrap();
        sites.approve(&site, true, false).unwrap();
        sites.set_startup(&sites::StartupIntent::External(site.clone())).unwrap();
        drop(sites);
        let release = Arc::new(tokio::sync::Notify::new());
        let waiting = Arc::new(tokio::sync::Notify::new());
        let gate = release.clone();
        let requested = waiting.clone();
        let fixture = tokio::spawn(async move {
            let routes = Router::new().route("/healthz", get(move || async move {
                requested.notify_one();
                gate.notified().await;
                "ordinary page"
            }));
            axum::serve(listener, routes).await.unwrap();
        });
        let config = Config {
            data_root: directory.path().into(), assets: directory.path().into(),
            open_browser: false, terminal_notice: None, page_player: None,
            website_permission_reset: None, window_navigation: None,
            cloudflared: PathBuf::new(), ice_servers: vec![], update: Default::default(),
        };
        let (ready, entry) = oneshot::channel();
        let (stop, stopped) = oneshot::channel();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let service = tokio::spawn(serve(listener, config, async { let _ = stopped.await; }, Some(ready)));
        let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().unwrap();
        let health = || client.get(format!("{origin}/health")).header("Origin", &site).send();
        assert_eq!(health().await.expect("local health independent of startup site").status(), StatusCode::OK);
        assert_eq!(entry.await.unwrap(), format!("{origin}/client?start=1"));
        let state = client.get(format!("{origin}/api/client-launcher")).send().await.unwrap();
        let state: Value = serde_json::from_slice(&state.bytes().await.unwrap()).unwrap();
        assert_eq!(state["startupSite"], site);
        let navigation = tokio::spawn(reqwest::Client::new().post(format!("{origin}/api/client-launcher/open"))
            .header("Origin", &origin).header("Content-Type", "application/json")
            .body(json!({"url":site}).to_string()).send());
        timeout(Duration::from_secs(2), waiting.notified()).await.unwrap();
        assert_eq!(health().await.unwrap().status(), StatusCode::OK);
        release.notify_one();
        let rejected = navigation.await.unwrap().unwrap();
        assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let detail: Value = serde_json::from_slice(&rejected.bytes().await.unwrap()).unwrap();
        assert_eq!(detail["detail"], "not_piik_site");
        fixture.abort();
        let _ = fixture.await;
        let renamed = reqwest::Client::new().post(format!("{origin}/api/client-launcher/bookmarks"))
            .header("Origin", &origin).header("Content-Type", "application/json")
            .body(json!({"id":bookmark.id, "origin":site, "name":"Offline rename"}).to_string())
            .send().await.unwrap();
        assert_eq!(renamed.status(), StatusCode::OK);
        let result: Value = serde_json::from_slice(&renamed.bytes().await.unwrap()).unwrap();
        assert_eq!(result["bookmarks"][0]["name"], "Offline rename");
        stop.send(()).unwrap();
        service.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn bookmarks_and_window_navigation_are_local_and_keep_separate_authority() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Mutex as StdMutex,
        };
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let local = format!("http://{address}");
        let site_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let site_origin = format!("http://{}", site_listener.local_addr().unwrap());
        let remote = site_origin.as_str();
        let lan = web::LanHttps::bind("127.0.0.1".parse().unwrap(), 0).await.unwrap();
        let lan_origin = lan.origin().to_owned();
        let domain = crate::domain::Domain::open(
            &directory.path().join("domain"), "owner", site_origin.clone(), Some(lan_origin.clone()), vec![],
        ).unwrap();
        let site = tokio::spawn(domain.serve_with_https(site_listener, Some(lan), Router::new(), std::future::pending()));
        let mut sites = sites::Sites::open(directory.path()).unwrap();
        let permission = Arc::new(Permission::new(sites.approve(remote, true, false).unwrap()));
        sites
            .set_startup(&sites::StartupIntent::External(remote.into()))
            .unwrap();
        let navigations = Arc::new(StdMutex::new(Vec::new()));
        let available = Arc::new(AtomicBool::new(true));
        let app = Arc::new(App {
            config: Config {
                data_root: directory.path().into(),
                assets: directory.path().into(),
                open_browser: false,
                terminal_notice: None,
                page_player: None,
                website_permission_reset: None,
                window_navigation: Some(WindowNavigation::new({
                    let navigations = navigations.clone();
                    let available = available.clone();
                    move |url, _| {
                        if !available.load(Ordering::Relaxed) {
                            return false;
                        }
                        navigations.lock().unwrap().push(url);
                        true
                    }
                })),
                cloudflared: PathBuf::new(),
                ice_servers: vec![],
                update: Default::default(),
            },
            port: address.port(),
            token: "test".into(),
            registry: Mutex::new(Registry {
                sites,
                approvals: BTreeMap::from([(remote.into(), permission.clone())]),
                hosts: BTreeMap::new(),
                local: None,
            }),
            closing: watch::channel(false).0,
            launch: Mutex::new(None),
            desktop: Desktop::new().unwrap(),
            external_inputs: whip::Inputs::default(),
            capture_targets: CaptureTargetReader::default(),
            capture_microphones: CaptureTargetReader::default(),
            voice_shortcuts: voice_shortcuts::Owner::default(),
            update: update::Owner::disabled(),
        });
        let router = Router::new()
            .route(
                "/api/client-launcher/bookmarks",
                get(bookmarks).post(save_bookmark),
            )
            .route(
                "/api/client-launcher/bookmarks/{id}",
                axum::routing::delete(delete_bookmark),
            )
            .route("/api/client-launcher/open", post(open_window))
            .layer(middleware::from_fn_with_state(app.clone(), access))
            .with_state(app.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .timeout(IO_TIMEOUT)
            .build()
            .unwrap();
        let endpoint = format!("{local}/api/client-launcher/bookmarks");
        let create = json!({"origin":remote,"name":"  Friend  "});
        for method in [
            reqwest::Method::GET,
            reqwest::Method::POST,
            reqwest::Method::DELETE,
        ] {
            let response = client
                .request(method, &endpoint)
                .header("Origin", remote)
                .header("Content-Type", "application/json")
                .body(create.to_string())
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        assert_eq!(
            client
                .get(&endpoint)
                .header("Host", "untrusted.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .post(&endpoint)
                .header("Content-Type", "application/json")
                .body(create.to_string())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        for origin in [
            "https://friend.example/#invite=secret",
            "https://user:secret@friend.example",
            "file:///private",
        ] {
            assert_eq!(
                client
                    .post(&endpoint)
                    .header("Origin", &local)
                    .header("Content-Type", "application/json")
                    .body(json!({"origin":origin,"name":""}).to_string())
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        let response = client
            .post(&endpoint)
            .header("Origin", &local)
            .header("Content-Type", "application/json")
            .body(create.to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let saved: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(saved["bookmarks"][0]["name"], "Friend");
        let id = saved["bookmarks"][0]["id"].as_str().unwrap();
        assert_eq!(
            client
                .post(&endpoint)
                .header("Origin", &local)
                .header("Content-Type", "application/json")
                .body(create.to_string())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        let invitation = format!("{remote}/rooms/abc?view=screen#invite=secret");
        let open = format!("{local}/api/client-launcher/open");
        assert_eq!(
            client
                .post(&open)
                .header("Origin", remote)
                .header("Content-Type", "application/json")
                .body(json!({"url":invitation}).to_string())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .post(&open)
                .header("Origin", &local)
                .header("Content-Type", "application/json")
                .body(json!({"url":invitation}).to_string())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(*navigations.lock().unwrap(), vec![invitation.as_str()]);
        // A cold-start launcher and a saved-site window can verify targets concurrently.
        let delayed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let slow = format!("http://{}", delayed.local_addr().unwrap());
        let (arrived, mut checks) = mpsc::unbounded_channel();
        let marker = tokio::spawn(async move {
            let routes = Router::new().route("/healthz", get(move || {
                let (release, wait) = oneshot::channel::<()>();
                arrived.send(release).unwrap();
                async move { wait.await.unwrap(); crate::domain::HEALTH_MARKER }
            }));
            axum::serve(delayed, routes).await.unwrap();
        });
        let select = |target: &str| client.post(&open).header("Origin", &local)
            .header("Content-Type", "application/json").body(json!({"url":target}).to_string());
        for (target, status) in [(remote, StatusCode::OK), (local.as_str(), StatusCode::UNPROCESSABLE_ENTITY)] {
            let response = tokio::spawn(select(&slow).send());
            let release = timeout(IO_TIMEOUT, checks.recv()).await.unwrap().unwrap();
            assert!(!navigations.lock().unwrap().contains(&slow));
            assert_eq!(select(target).send().await.unwrap().status(), status);
            release.send(()).unwrap();
            assert_eq!(response.await.unwrap().unwrap().status(), StatusCode::CONFLICT);
            assert_eq!(*navigations.lock().unwrap(), vec![invitation.as_str(), remote]);
        }
        marker.abort();
        let _ = marker.await;
        for url in [
            "javascript:alert(1)",
            "file:///private",
            "https://user:secret@friend.example/",
        ] {
            assert_eq!(
                client
                    .post(&open)
                    .header("Origin", &local)
                    .header("Content-Type", "application/json")
                    .body(json!({"url":url}).to_string())
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        available.store(false, Ordering::Relaxed);
        assert_eq!(
            client
                .post(&open)
                .header("Origin", &local)
                .header("Content-Type", "application/json")
                .body(json!({"url":invitation}).to_string())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        for (reply, expected) in [
            (axum::response::Html("<html>Ordinary website</html>").into_response(), StatusCode::UNPROCESSABLE_ENTITY),
            (axum::response::Redirect::temporary(remote).into_response(), StatusCode::SERVICE_UNAVAILABLE),
            (StatusCode::SERVICE_UNAVAILABLE.into_response(), StatusCode::SERVICE_UNAVAILABLE),
        ] {
            let fixture = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", fixture.local_addr().unwrap());
            let status = reply.status();
            let headers = reply.headers().clone();
            let body = axum::body::to_bytes(reply.into_body(), 1024).await.unwrap();
            let server = tokio::spawn(async move {
                let routes = Router::new().route("/healthz", get(move || async move { (status, headers, body) }));
                axum::serve(fixture, routes).await.unwrap();
            });
            for (endpoint, request) in [(&open, json!({"url":origin})), (&endpoint, json!({"origin":origin,"name":"Other"}))] {
                let response = client.post(endpoint).header("Origin", &local)
                    .header("Content-Type", "application/json").body(request.to_string()).send().await.unwrap();
                assert_eq!(response.status(), expected);
            }
            server.abort();
            let _ = server.await;
        }
        let current = client
            .get(&endpoint)
            .header("Origin", &local)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&current).unwrap(), saved);
        assert_eq!(
            client
                .delete(format!("{endpoint}/{id}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .delete(format!("{endpoint}/{id}"))
                .header("Origin", &local)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(navigations.lock().unwrap().len(), 2);
        let registry = app.registry.lock().await;
        assert!(registry.sites.bookmarks().unwrap().is_empty());
        assert!(
            matches!(registry.sites.startup().unwrap(), sites::StartupIntent::External(origin) if origin == remote)
        );
        assert!(Arc::ptr_eq(
            registry.permission(remote).unwrap(),
            &permission
        ));
        drop(registry);
        // The very same self-signed entry is unavailable externally and verifiable while App-owned.
        assert_eq!(verify_site(&lan_origin).await.unwrap_err().0, StatusCode::SERVICE_UNAVAILABLE);
        app.registry.lock().await.local = Some(LocalSite {
            origin: site_origin.clone(), invitation: lan_origin.clone(),
            request: serde_json::from_value(json!({"mode":"local"})).unwrap(),
            permission: Arc::new(Permission::new(Uuid::new_v4())),
        });
        available.store(true, Ordering::Relaxed);
        for (route, body) in [(&endpoint, json!({"origin":lan_origin,"name":"LAN"})), (&open, json!({"url":lan_origin}))] {
            let response = client.post(route).header("Origin", &local).header("Content-Type", "application/json")
                .body(body.to_string()).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        assert_eq!(navigations.lock().unwrap().last(), Some(&lan_origin));
        site.abort();
        let _ = site.await;
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn local_site_permission_follows_the_domain_without_a_saved_approval() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("index.html"), "Piik").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let control = format!("http://{address}");
        let invitation = "https://invitation.example";
        let remote = "https://friend.example";
        let app = Arc::new(App {
            config: Config {
                data_root: directory.path().into(),
                assets: directory.path().into(),
                open_browser: false,
                terminal_notice: None,
                page_player: None,
                website_permission_reset: None,
                window_navigation: None,
                cloudflared: PathBuf::new(),
                ice_servers: vec![],
                update: Default::default(),
            },
            port: address.port(),
            token: "test".into(),
            registry: Mutex::new(Registry {
                sites: sites::Sites::open(directory.path()).unwrap(),
                approvals: BTreeMap::new(),
                hosts: BTreeMap::new(),
                local: None,
            }),
            closing: watch::channel(false).0,
            launch: Mutex::new(None),
            desktop: Desktop::new().unwrap(),
            external_inputs: whip::Inputs::default(),
            capture_targets: CaptureTargetReader::default(),
            capture_microphones: CaptureTargetReader::default(),
            voice_shortcuts: voice_shortcuts::Owner::default(),
            update: update::Owner::disabled(),
        });
        let router = Router::new()
            .route("/api/client-launcher", get(launcher))
            .route("/api/client-launcher/launch", post(hosted::launch))
        .route("/api/client-launcher/owner-entry", post(hosted::owner_entry))
            .route("/api/client-launcher/site", post(approve))
            .route("/api/client-launcher/startup-site", post(startup))
            .route("/health", get(health))
            .layer(middleware::from_fn_with_state(app.clone(), access))
            .with_state(app.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder()
            .timeout(IO_TIMEOUT)
            .build()
            .unwrap();
        let post = async |path: &str, body: Value| {
            client
                .post(format!("{control}/api/client-launcher/{path}"))
                .header("Origin", &control)
                .header("Content-Type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .unwrap()
        };
        let state = async || -> Value {
            serde_json::from_slice(
                &client
                    .get(format!("{control}/api/client-launcher"))
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap(),
            )
            .unwrap()
        };
        let access_status = async |site: &str| {
            client
                .get(format!("{control}/health"))
                .header("Origin", site)
                .send()
                .await
                .unwrap()
                .status()
        };
        let checks = std::panic::AssertUnwindSafe(async {
            let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = first.local_addr().unwrap().port();
            drop(first);
            let response = post(
                "launch",
                json!({"mode":"external", "publicOrigin":invitation, "port":port}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let current = state().await;
            let local = format!("http://127.0.0.1:{port}");
            assert_eq!(current["localSite"], local);
            assert_eq!(current["sites"], json!([]));
            let response = post("startup-site", json!({"site":local})).await;
            assert_eq!(response.status(), StatusCode::OK);
            let current: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
            assert_eq!(current["startupMode"], "external");
            assert_eq!(current["localSite"], local);
            for site in [invitation, remote] {
                assert_eq!(access_status(site).await, StatusCode::FORBIDDEN);
                assert_eq!(
                    post("startup-site", json!({"site":site})).await.status(),
                    StatusCode::CONFLICT
                );
            }
            // Keep a host execution boundary alive while exercising the real
            // approval handler. An ineffective revoke must not retire it.
            let (stop, mut stopped) = watch::channel(false);
            let (commands, _receiver) = mpsc::channel(1);
            let key = (local.clone(), Uuid::new_v4(), Uuid::new_v4());
            let permission = {
                let mut registry = app.registry.lock().await;
                registry.hosts.insert(
                    key.clone(),
                    Host {
                        credential: "test".into(),
                        commands,
                        ready: watch::channel(Some(Ok(()))).1,
                        stop: stop.clone(),
                        task: host_task(tokio::spawn(async move {
                            let _ = stopped.changed().await;
                            Ok(())
                        })),
                    },
                );
                registry.permission(&local).unwrap().clone()
            };
            for allowed in [true, false] {
                let response = post("site", json!({"site":local, "allowed":allowed})).await;
                assert_eq!(response.status(), StatusCode::CONFLICT);
                let current: Value =
                    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
                assert_eq!(current["localSite"], local);
                assert_eq!(current["startupMode"], "external");
                assert!(!*stop.borrow());
                assert!(!*permission.revoked.borrow());
            }
            {
                let registry = app.registry.lock().await;
                assert!(registry.sites.approved().unwrap().is_empty());
                assert!(registry.approvals.is_empty());
                assert!(registry.hosts.contains_key(&key));
            }
            assert_eq!(access_status(&local).await, StatusCode::OK);
            // External approvals remain independent of the owned site's lifetime.
            assert_eq!(
                post("site", json!({"site":remote,"allowed":true}))
                    .await
                    .status(),
                StatusCode::OK
            );
            app.launch.lock().await.take().unwrap().close().await;
            assert!(*permission.revoked.borrow());
            assert_eq!(access_status(&local).await, StatusCode::FORBIDDEN);
            let current = state().await;
            assert!(current.get("localSite").is_none());
            assert_eq!(access_status(remote).await, StatusCode::OK);
            assert_eq!(
                post("site", json!({"site":remote,"allowed":false}))
                    .await
                    .status(),
                StatusCode::OK
            );
            assert_eq!(access_status(remote).await, StatusCode::FORBIDDEN);
        })
        .catch_unwind()
        .await;
        timeout(IO_TIMEOUT, app.shutdown()).await.unwrap();
        server.abort();
        let _ = server.await;
        checks.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
    }

    #[tokio::test]
    async fn owned_startup_tracks_the_live_invitation_and_not_a_hostname() {
        let directory = tempfile::tempdir().unwrap();
        let old = "https://first.example";
        let fresh = "https://next.example";
        let external = "https://other.trycloudflare.com";
        let app = |invitation: &str| {
            let mut sites = sites::Sites::open(directory.path()).unwrap();
            let permission = Arc::new(Permission::new(Uuid::new_v4()));
            let mut approvals = BTreeMap::new();
            for site in [old, fresh, external] {
                let id = sites.approve(site, true, false).unwrap();
                approvals.insert(site.into(), Arc::new(Permission::new(id)));
            }
            Arc::new(App {
                config: Config {
                    data_root: directory.path().into(),
                    assets: directory.path().into(),
                    open_browser: false,
                    terminal_notice: None,
                    page_player: None,
                    website_permission_reset: None,
                    window_navigation: None,
                    cloudflared: PathBuf::new(),
                    ice_servers: vec![],
                    update: Default::default(),
                },
                port: 39731,
                token: "test".into(),
                registry: Mutex::new(Registry {
                    sites,
                    approvals,
                    hosts: BTreeMap::new(),
                    local: Some(LocalSite {
                        origin: "http://127.0.0.1:8787".into(),
                        invitation: invitation.into(),
                        request: serde_json::from_value(json!({"mode":"link"})).unwrap(),
                        permission,
                    }),
                }),
                closing: watch::channel(false).0,
                launch: Mutex::new(None),
                desktop: Desktop::new().unwrap(),
                external_inputs: whip::Inputs::default(),
                capture_targets: CaptureTargetReader::default(),
                capture_microphones: CaptureTargetReader::default(),
                voice_shortcuts: voice_shortcuts::Owner::default(),
                update: update::Owner::disabled(),
            })
        };
        let first = app(old);
        let saved = startup(State(first.clone()), Json(Startup { site: old.into() }))
            .await
            .unwrap()
            .0;
        assert_eq!(saved["startupSite"], old);
        assert_eq!(saved["startupMode"], "link");
        {
            let registry = first.registry.lock().await;
            let stored = serde_json::to_string(&registry.sites.startup().unwrap()).unwrap();
            assert!(!stored.contains(old));
        }
        drop(first);
        let restarted = app(fresh);
        let state = launcher(State(restarted.clone())).await.unwrap().0;
        assert_eq!(state["startupSite"], fresh);
        // Revoking an obsolete grant cannot change the owned launch intention.
        let _ = approve(
            State(restarted.clone()),
            Json(Approval {
                site: old.into(),
                allowed: false,
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            launcher(State(restarted.clone())).await.unwrap().0["startupMode"],
            "link"
        );
        let saved = startup(
            State(restarted.clone()),
            Json(Startup {
                site: external.into(),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(saved["startupSite"], external);
        assert!(saved["startupMode"].is_null());
        let _ = startup(
            State(restarted.clone()),
            Json(Startup { site: fresh.into() }),
        )
        .await
        .unwrap();
        let db = rusqlite::Connection::open(directory.path().join("app.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER reject_revoke BEFORE UPDATE OF allowed ON app_site
             WHEN NEW.allowed = 0 BEGIN SELECT RAISE(ABORT, 'revoke failed'); END;",
        )
        .unwrap();
        let revoke = || {
            Json(Approval {
                site: fresh.into(),
                allowed: false,
            })
        };
        let error = approve(State(restarted.clone()), revoke())
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
        let permission = restarted
            .registry
            .lock()
            .await
            .permission(fresh)
            .unwrap()
            .clone();
        assert!(!*permission.revoked.borrow());
        let disk = sites::Sites::open(directory.path()).unwrap();
        assert!(disk.approved().unwrap().contains_key(fresh));
        assert!(matches!(
            disk.startup().unwrap(),
            sites::StartupIntent::Owned(_)
        ));

        db.execute_batch("DROP TRIGGER reject_revoke").unwrap();
        let cleared = approve(State(restarted), revoke()).await.unwrap().0;
        assert!(*permission.revoked.borrow());
        assert!(!disk.approved().unwrap().contains_key(fresh));
        assert!(matches!(
            disk.startup().unwrap(),
            sites::StartupIntent::None
        ));
        assert_eq!(cleared["startupSite"], "");
        assert!(cleared["startupMode"].is_null());
    }

    #[test]
    fn publication_audio_settings_survive_pending_picture_work_and_end_with_the_page_capture() {
        let old = SourceAudioSettings {
            bitrate: 96_000,
            gain: 1.0,
        };
        let muted = SourceAudioSettings { gain: 0.0, ..old };
        let mut capture = Capture::default();
        assert_eq!(
            capture.configure_audio(muted).unwrap_err().to_string(),
            "capture_unavailable"
        );
        let (_request, _registration) = capture.prepare(SourceKind::Capture, old).unwrap();
        capture.configure_audio(muted).unwrap();
        assert_eq!(capture.audio_settings, muted);
        // A duplicate preparation cannot replace accepted audio intent while
        // the existing request owns its first frame/commit wait.
        assert_eq!(
            capture.prepare(SourceKind::Capture, old).unwrap_err().to_string(),
            "capture_pending"
        );
        assert_eq!(capture.audio_settings, muted);
        assert!(capture
            .configure_audio(SourceAudioSettings {
                gain: f32::NAN,
                ..old
            })
            .is_err());
        assert_eq!(capture.audio_settings, muted);
        capture.pending = None;
        assert_eq!(
            capture.configure_audio(old).unwrap_err().to_string(),
            "capture_unavailable"
        );
        let mut captures = BTreeMap::from([(Uuid::new_v4(), capture)]);
        captures.retain(|_, capture| capture.pending.is_some() || capture.active.is_some());
        assert!(captures.is_empty());
    }

    #[test]
    fn input_policy_requires_the_selected_capture_identity() {
        let capture_id = Uuid::new_v4();
        let mut wire = json!({"id":"policy","type":"input_policy","publicationId":Uuid::new_v4(),"captureId":capture_id,"mode":"room"});
        assert!(matches!(
            serde_json::from_value::<Request>(wire.clone()).unwrap().operation,
            Operation::InputPolicy { capture_id: id, .. } if id == capture_id
        ));
        wire.as_object_mut().unwrap().remove("captureId");
        assert!(serde_json::from_value::<Request>(wire).is_err());
    }

    #[test]
    fn publication_audio_command_has_no_picture_capture_identity() {
        let mut wire = json!({"id":"audio","type":"capture_audio_settings","publicationId":Uuid::new_v4(),"settings":{"bitrate":128000,"gain":0}});
        assert!(matches!(
            serde_json::from_value::<Request>(wire.clone())
                .unwrap()
                .operation,
            Operation::CaptureAudioSettings { .. }
        ));
        wire["captureId"] = json!(Uuid::new_v4());
        assert!(serde_json::from_value::<Request>(wire).is_err());
    }

    #[tokio::test]
    async fn disconnected_approval_retains_stopping_hosts_until_joined() {
        let directory = tempfile::tempdir().unwrap();
        let site = "https://site.test".to_owned();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut sites = sites::Sites::open(directory.path()).unwrap();
        let permission = Arc::new(Permission::new(sites.approve(&site, true, false).unwrap()));
        let first_key = (site.clone(), Uuid::from_u128(1), Uuid::from_u128(1));
        let second_key = (site.clone(), Uuid::from_u128(2), Uuid::from_u128(2));
        let (release, wait_release) = oneshot::channel();
        let (finished, wait_finished) = oneshot::channel();
        let (first_commands, mut first_receiver) = mpsc::channel(1);
        let (second_commands, _second_receiver) = mpsc::channel(1);
        let original_commands = second_commands.clone();
        let (first_stop, mut first_stopped) = watch::channel(false);
        let (second_stop, mut second_stopped) = watch::channel(false);
        let first = Host {
            credential: "credential".into(),
            commands: first_commands,
            ready: watch::channel(Some(Ok(()))).1,
            stop: first_stop,
            task: host_task(tokio::spawn(async move {
                let _ = first_stopped.changed().await;
                Ok(())
            })),
        };
        let second = Host {
            credential: "credential".into(),
            commands: second_commands,
            ready: watch::channel(Some(Ok(()))).1,
            stop: second_stop,
            task: host_task(tokio::spawn(async move {
                let _ = second_stopped.changed().await;
                let _ = wait_release.await;
                let _ = finished.send(());
                Ok(())
            })),
        };
        let app = Arc::new(App {
            config: Config {
                data_root: directory.path().into(),
                assets: directory.path().into(),
                open_browser: false,
                terminal_notice: None,
                page_player: None,
                website_permission_reset: None,
                window_navigation: None,
                cloudflared: PathBuf::new(),
                ice_servers: vec![],
                update: Default::default(),
            },
            port: address.port(),
            token: "test".into(),
            registry: Mutex::new(Registry {
                sites,
                approvals: BTreeMap::from([(site.clone(), permission.clone())]),
                hosts: BTreeMap::from([(first_key.clone(), first), (second_key.clone(), second)]),
                local: None,
            }),
            closing: watch::channel(false).0,
            launch: Mutex::new(None),
            desktop: Desktop::new().unwrap(),
            external_inputs: whip::Inputs::default(),
            capture_targets: CaptureTargetReader::default(),
            capture_microphones: CaptureTargetReader::default(),
            voice_shortcuts: voice_shortcuts::Owner::default(),
            update: update::Owner::disabled(),
        });
        // Observe the actual HTTP handler future being dropped, without replacing
        // its production approval/retirement work with a test implementation.
        let (entered, mut requests) = mpsc::channel(2);
        let router = Router::new()
            .route(
                "/api/client-launcher/site",
                post(move |state, change| {
                    let entered = entered.clone();
                    async move {
                        let (alive, ended) = oneshot::channel::<()>();
                        entered.send(ended).await.unwrap();
                        let _alive = alive;
                        approve(state, change).await
                    }
                }),
            )
            .route("/api/client-launcher", get(launcher))
            .with_state(app.clone());
        let (stop_http, stopped) = oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        let post = |allowed| {
            let body = json!({"site":site,"allowed":allowed}).to_string();
            format!("POST /api/client-launcher/site HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
        };
        let checks = std::panic::AssertUnwindSafe(async {
            let mut client = TcpStream::connect(address).await.unwrap();
            client.write_all(post(false).as_bytes()).await.unwrap();
            let dropped = timeout(IO_TIMEOUT, requests.recv()).await.unwrap().unwrap();
            assert!(
                timeout(IO_TIMEOUT, first_receiver.recv())
                    .await
                    .unwrap()
                    .is_none(),
                "the first completed host is removed before waiting for its sibling"
            );
            // The active revoke still owns its join, while unrelated launcher reads can proceed.
            let mut independent = TcpStream::connect(address).await.unwrap();
            independent.write_all(format!(
                "GET /api/client-launcher HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
            ).as_bytes()).await.unwrap();
            let mut state = String::new();
            timeout(IO_TIMEOUT, independent.read_to_string(&mut state)).await.unwrap().unwrap();
            assert!(state.starts_with("HTTP/1.1 200"));
            drop(client);
            assert!(
                timeout(IO_TIMEOUT, dropped).await.unwrap().is_err(),
                "closing TCP really cancelled the HTTP handler"
            );
            let mut reader = TcpStream::connect(address).await.unwrap();
            let get = format!(
                "GET /api/client-launcher HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
            );
            reader.write_all(get.as_bytes()).await.unwrap();
            let mut response = String::new();
            timeout(IO_TIMEOUT, reader.read_to_string(&mut response))
                .await
                .unwrap()
                .unwrap();
            assert!(response.starts_with("HTTP/1.1 200"));
            let retained = app.registry.lock().await.hosts.contains_key(&second_key);
            let revoked = *permission.revoked.borrow();
            let mut joining_stopped_host = true;
            if retained {
                let mut client = TcpStream::connect(address).await.unwrap();
                client.write_all(post(true).as_bytes()).await.unwrap();
                let mut response = String::new();
                timeout(IO_TIMEOUT, client.read_to_string(&mut response))
                    .await
                    .unwrap()
                    .unwrap();
                assert!(response.starts_with("HTTP/1.1 200"));
                let current = app.registry.lock().await.approvals[&site].clone();
                joining_stopped_host = {
                    let hello = app.hello(
                        &site,
                        &current,
                        second_key.1,
                        second_key.2,
                        "credential".into(),
                        "Test".into(),
                    );
                    tokio::pin!(hello);
                    futures_util::poll!(&mut hello).is_pending()
                };
                assert!(app.registry.lock().await.hosts[&second_key]
                    .commands
                    .same_channel(&original_commands));
            }
            (retained, revoked, joining_stopped_host)
        })
        .catch_unwind()
        .await;
        let _ = release.send(());
        let joined = timeout(IO_TIMEOUT, app.shutdown()).await;
        let finished = timeout(IO_TIMEOUT, wait_finished).await;
        let empty = app.registry.lock().await.hosts.is_empty();
        let _ = stop_http.send(());
        let closed = timeout(IO_TIMEOUT, server).await;
        joined.unwrap();
        finished.unwrap().unwrap();
        closed.unwrap().unwrap().unwrap();
        let (retained, revoked, joining_stopped_host) =
            checks.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
        println!("TCP handler cancelled; retained={retained}; reauthorization joins={joining_stopped_host}; hosts empty={empty}; HTTP server joined");
        assert!(revoked);
        assert!(
            retained,
            "HTTP cancellation must not discard the unfinished host join owner"
        );
        assert!(
            joining_stopped_host,
            "reauthorization must join the stopping host, not return its old commands"
        );
        assert!(empty);
    }
}

#[cfg(all(test, feature = "capture"))]
mod tests {
    use super::*;

    #[test]
    fn voice_shortcut_wire_requires_explicit_slots_and_strict_bindings() {
        let valid = r#"{"id":"1","type":"voice_shortcuts","enabled":true,"microphone":null,"listening":{"key":"F10","ctrl":true,"alt":false,"shift":true,"meta":false}}"#;
        assert!(matches!(
            serde_json::from_str::<Request>(valid).unwrap().operation,
            Operation::VoiceShortcuts(_)
        ));
        for invalid in [
            valid.replace(r#""microphone":null,"#, ""),
            valid.replace(r#""microphone":null"#, r#""microphone":null,"roomId":"private""#),
            valid.replace(r#""meta":false"#, r#""meta":false,"muted":true"#),
            valid.replace(r#""meta":false"#, r#""meta":false,"meta":true"#),
        ] {
            assert!(serde_json::from_str::<Request>(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn old_external_ready_and_end_cannot_retire_the_successor_pending_source() {
        let mut capture = Capture::default();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let (old, _) = capture.prepare(SourceKind::External, SourceAudioSettings::default()).unwrap();
        capture.pending.as_mut().unwrap().phase = CapturePhase::WaitingForExternal(first);
        capture.pending = None;
        let (current, _) = capture.prepare(SourceKind::External, SourceAudioSettings::default()).unwrap();
        capture.pending.as_mut().unwrap().phase = CapturePhase::WaitingForExternal(second);
        assert!(old.is_aborted());
        assert!(capture.pending_for(first).is_none());
        assert!(!capture.retire_producer(first));
        assert_eq!(capture.pending.as_ref().unwrap().phase.candidate_id(), Some(second));
        assert!(!current.is_aborted());
        assert!(capture.retire_producer(second));
        assert!(current.is_aborted());
        assert!(capture.pending.is_none());
    }

    #[test]
    fn external_candidate_failure_preserves_the_active_source_projection() {
        let publication = Uuid::new_v4();
        let active = (Uuid::new_v4(), Uuid::new_v4());
        let event = external_input_event(
            publication,
            Some(active),
            None,
            false,
            Some("external_input_failed"),
        );
        assert_eq!(event["state"], "live");
        assert_eq!(event["captureId"], json!(active.0));
        assert_eq!(event["sessionId"], json!(active.1));
        assert_eq!(event["error"], "external_input_failed");
        assert_eq!(
            external_input_event(publication, None, None, false, None)["state"],
            "waiting"
        );
        for (reason, expected) in [
            (
                "external_video_format_unsupported",
                "external_video_format_unsupported",
            ),
            ("external_video_offer_unsupported", "external_video_offer_unsupported"),
            ("private decoder detail", "external_input_failed"),
        ] {
            let failed = external_input_event(publication, None, None, false, Some(reason));
            assert_eq!(failed["state"], "error");
            assert_eq!(failed["error"], expected);
        }
        let closed = external_input_event(publication, Some(active), None, true, None);
        assert_eq!(closed["state"], "closed");
        assert!(closed.get("captureId").is_none());
    }

    #[test]
    fn external_format_detail_describes_failed_candidate_without_changing_incumbent() {
        let publication = Uuid::new_v4();
        let active = (Uuid::new_v4(), Uuid::new_v4());
        let format = Some(piik_channel_native::peer::UnsupportedVideoFormat {
            codec: "h264", profile_idc: 110, constraint_flags: 0, level_idc: 52,
        });
        let event = external_format_event(external_input_event(publication, Some(active), None, false,
            Some("external_video_format_unsupported")), format);
        assert_eq!(event["state"], "live");
        assert_eq!(event["captureId"], json!(active.0));
        assert_eq!(event["unsupportedVideoFormat"], json!({"codec":"h264","profileIdc":110,"constraintFlags":0,"levelIdc":52}));
        let unrelated = external_format_event(external_input_event(publication, None, None, false,
            Some("private decoder detail")), format);
        assert_eq!(unrelated["error"], "external_input_failed");
        assert!(unrelated.get("unsupportedVideoFormat").is_none());
    }

    #[tokio::test]
    async fn capture_completion_follows_the_active_producer_and_current_lease() {
        let publication = Uuid::new_v4();
        let producer = Uuid::new_v4();
        let audio_replacement = Uuid::new_v4();
        let (finished, ended) = oneshot::channel();
        let mut completions = FuturesUnordered::new();
        completions.push(async move { (producer, ended.await.ok()) });
        finished
            .send(Err("private codec failure".to_owned()))
            .unwrap();
        let (completed, result) = completions.next().await.unwrap();
        assert_eq!(
            capture_end_event(
                publication,
                completed,
                Some((producer, audio_replacement)),
                result
            ),
            Some(json!({
                "type":"capture_ended", "publicationId":publication, "captureId":audio_replacement, "failed":true,
            }))
        );
        assert!(capture_end_event(
            publication,
            producer,
            Some((Uuid::new_v4(), Uuid::new_v4())),
            Some(Err("retired codec".into()))
        )
        .is_none());
        assert!(capture_end_event(
            publication,
            producer,
            None,
            Some(Err("stopped codec".into()))
        )
        .is_none());
        for result in [Some(Ok(())), None] {
            assert_eq!(
                capture_end_event(
                    publication,
                    producer,
                    Some((producer, audio_replacement)),
                    result
                )
                .unwrap()["failed"],
                false
            );
        }
    }

    #[tokio::test]
    async fn selected_capture_settings_reach_the_host_command() {
        let mut wire = json!({
            "id": "selected-profile", "type": "prepare_capture", "roomId": "room",
            "publicationId": Uuid::new_v4(), "codecMode": "vp8", "encodingExecution": "software",
            "target": {"kind": "display", "sourceId": "1", "title": "Test display"},
            "settings": {"width": 1280, "height": 720, "fps": 24, "bitrate": 2_500_000,"degradationPreference":"balanced"},
            "audioSettings": {"bitrate":192000,"gain":0.5},
            "audio": true,
            "showCaptureBorder": true,
            "excludeAudio": {"kind":"window","sourceId":"2","title":"Excluded app","pid":42,"creationTime":"1234"}
        });
        let request: Request = serde_json::from_value(wire.clone()).unwrap();
        let Operation::PrepareCapture {
            publication_id,
            room_id,
            target,
            settings,
            codec_mode,
            encoding_execution,
            audio_settings,
            audio,
            exclude_audio,
            render_endpoint_id,
            show_capture_border,
        } = request.operation
        else {
            panic!("expected capture request");
        };
        assert_eq!(
            audio_settings,
            SourceAudioSettings {
                bitrate: 192_000,
                gain: 0.5
            }
        );
        let publication = publication_id;
        let (commands, mut received) = mpsc::channel(1);
        let (picker_events, mut events) = mpsc::channel(1);
        let start = prepare_capture(
            &commands,
            publication,
            room_id,
            target.clone(),
            settings,
            codec_mode,
            encoding_execution,
            audio,
            exclude_audio,
            render_endpoint_id,
            show_capture_border,
            None,
            Some((&picker_events, "selected-profile")),
        );
        let host = async {
            let HostCommand::PrepareCapture(request) = received.recv().await.unwrap() else {
                panic!("expected producer command");
            };
            assert_eq!(request.publication_id, publication);
            assert_eq!(request.room_id, "room");
            assert!(request.audio);
            assert!(request.show_capture_border);
            assert_eq!(request.codec_mode, VideoCodecMode::Vp8);
            assert_eq!(request.encoding_execution, EncodingExecution::Software);
            assert_eq!(
                serde_json::to_value(request.exclude_audio).unwrap(),
                wire["excludeAudio"]
            );
            assert_eq!(
                serde_json::to_value(request.settings).unwrap(),
                wire["settings"]
            );
            // Stop at the existing HostCommand boundary, without starting OS capture.
            let _ = request.result.send(Err("test_capture_not_started".into()));
        };
        let (result, ()) = tokio::join!(start, host);
        assert_eq!(
            result.err().unwrap().to_string(),
            "test_capture_not_started"
        );

        assert!(matches!(events.try_recv(), Err(mpsc::error::TryRecvError::Empty)));

        let invalid = Settings { fps: 0, ..settings };
        let error = prepare_capture(
            &commands,
            publication,
            "room".into(),
            target,
            invalid,
            VideoCodecMode::H264,
            EncodingExecution::Auto,
            false,
            None,
            None,
            false,
            None,
            None,
        )
        .await
        .err()
        .unwrap();
        assert!(error
            .to_string()
            .contains("fps and bitrate must be positive"));
        assert!(matches!(
            received.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        let mut missing_execution = wire.clone();
        missing_execution
            .as_object_mut()
            .unwrap()
            .remove("encodingExecution");
        assert!(serde_json::from_value::<Request>(missing_execution).is_err());
        wire["encodingExecution"] = json!("hardware");
        assert!(serde_json::from_value::<Request>(wire.clone()).is_err());
        wire["encodingExecution"] = json!("software");
        wire.as_object_mut().unwrap().remove("settings");
        assert!(serde_json::from_value::<Request>(wire).is_err());

        let capture_id = Uuid::new_v4();
        let update: Request = serde_json::from_value(json!({
            "id":"live-profile", "type":"capture_video_settings",
            "publicationId":publication, "captureId":capture_id, "settings":settings,
        }))
        .unwrap();
        let Operation::CaptureVideoSettings {
            publication_id,
            capture_id: actual_capture,
            settings: actual_settings,
        } = update.operation
        else {
            panic!("expected live capture settings");
        };
        assert_eq!(
            (publication_id, actual_capture, actual_settings),
            (publication, capture_id, settings)
        );
        assert_eq!(
            serde_json::to_value(piik_channel_core::wire::VideoSettings::from(settings)).unwrap(),
            json!({"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":24.0,"maxBitrate":2_500_000},"degradationPreference":"balanced"})
        );
    }

    #[tokio::test]
    async fn capture_settings_response_waits_for_the_native_room_reply() {
        let scope = piik_channel_native::peer::CaptureScope {
            publication_id: Uuid::new_v4(),
            room_id: "room".into(),
            binding_id: Uuid::new_v4(),
        };
        let producer = Uuid::new_v4();
        let ceiling = Settings {
            degradation_preference: piik_channel_core::wire::DegradationPreference::Balanced,
            width: 1280,
            height: 720,
            fps: 24,
            bitrate: 2_500_000,
        }
        .into();
        for acknowledgement in [Ok(()), Err("room_rejected".to_owned())] {
            let (commands, mut requests) = mpsc::channel(1);
            let update = publish_capture_settings(&commands, scope.clone(), producer, ceiling);
            tokio::pin!(update);
            let request = tokio::select! {
                request = requests.recv() => request.unwrap(),
                result = &mut update => panic!("App replied before Native authority: {result:?}"),
            };
            let HostCommand::PublishCaptureSettings(request) = request else {
                panic!("ceiling command")
            };
            assert_eq!(request.scope.publication_id, scope.publication_id);
            assert_eq!(request.scope.binding_id, scope.binding_id);
            assert_eq!(request.capture_id, producer);
            assert_eq!(request.settings, ceiling);
            assert!(futures_util::poll!(&mut update).is_pending());
            request.result.send(acknowledgement.clone()).unwrap();
            assert_eq!(
                update.await.map_err(|error| error.to_string()),
                acknowledgement
            );
        }
    }
}
#[cfg(test)]
mod page_contract_tests {
    use super::*;
    #[test]
    fn relay_capacity_app_operation_keeps_read_and_set_scopes_explicit() {
        let read: Request = serde_json::from_value(
            json!({"id":"read","type":"relay_capacity","action":"read"}),
        )
        .unwrap();
        assert!(matches!(
            read.operation,
            Operation::RelayCapacity(
                piik_channel_native::session::RelayCapacityRequest::Read { .. }
            )
        ));
        let mut set = json!({"id":"set","type":"relay_capacity","action":"set","sessionId":Uuid::new_v4(),"capacity":null});
        assert!(serde_json::from_value::<Request>(set.clone()).is_ok());
        set.as_object_mut().unwrap().remove("sessionId");
        assert!(serde_json::from_value::<Request>(set).is_err());
    }
    #[test]
    fn page_commands_share_the_authorized_app_envelope() {
        let id = Uuid::new_v4();
        let request:Request=serde_json::from_value(json!({"id":"request","type":"page_prepare","pageId":id,"url":"https://example.com/watch"})).unwrap();
        assert!(
            matches!(request.operation,Operation::Page(page::Operation::PagePrepare{page_id,..}) if page_id==id)
        );
        assert!(serde_json::from_value::<Request>(json!({"id":"request","type":"page_patch","pageId":id,"patch":{"position":1,"cookie":"secret"}})).is_err());
    }
}

#[cfg(test)]
#[test]
fn actual_browser_mpd_commands_deserialize_at_app_boundary() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("app_page/mpd_request_fixture.json")).unwrap();
    for fixture in fixtures {
        let command = fixture["command"].clone();
        let parsed: Request = serde_json::from_value(command.clone()).unwrap();
        match command["type"].as_str().unwrap() {
            "page_media_prepare_mpd" => assert!(matches!(
                parsed.operation,
                Operation::Page(page::Operation::PageMediaPrepareMpd { .. })
            )),
            "page_media_resource" => assert!(matches!(
                parsed.operation,
                Operation::Page(page::Operation::PageMediaResource(_))
            )),
            _ => panic!("unexpectedfixture"),
        }
    }
}
