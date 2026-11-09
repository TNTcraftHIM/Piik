//! Local approval owns site access; the App owns each admitted site's room hosts.
#[path = "app_backup.rs"]
mod backup;
#[path = "app_console.rs"]
mod console;
#[path = "app_diagnostics.rs"]
mod diagnostics;
#[path = "app_domain.rs"]
mod hosted;
#[path = "app_sites.rs"]
mod sites;
#[path = "app_tunnel.rs"]
mod tunnel;

use crate::web;
use anyhow::{anyhow, bail, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, State,
    },
    http::{header, HeaderMap, Request as HttpRequest, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use futures_util::{
    future::{AbortHandle, Abortable, Aborted, BoxFuture},
    stream::FuturesUnordered,
    FutureExt, SinkExt, StreamExt,
};
use piik_channel_core::RoomState;
use piik_channel_native::{
    capture::{Settings, Target, VideoCodec, VideoCodecMode},
    input::{Desktop, Mode, SourceView},
    peer::{
        CaptureAudio, CaptureLease, SourceAudioSettings, SourceAudioState, SourceMicrophoneSettings,
    },
    session::{
        self, CommitCapture, HostCommand, Hosting, OpenRoom, PauseCapture, PrepareCapture,
        PublishCaptureCeiling, TransferSource,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, future::Future, path::PathBuf, sync::Arc, time::Duration};
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
const PROTOCOL: u8 = 3;
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

pub struct Config {
    pub data_root: PathBuf,
    pub assets: PathBuf,
    pub open_browser: bool,
    pub cloudflared: PathBuf,
    pub ice_servers: Vec<Value>,
}
fn entry_url(site: &str, port: u16) -> Result<String> {
    if site.is_empty() {
        return Ok(format!("http://127.0.0.1:{port}/client"));
    }
    let mut url = url::Url::parse(&site)?;
    url.query_pairs_mut()
        .append_pair("piik-client-port", &port.to_string());
    url.set_fragment(Some("piik-client=1"));
    Ok(url.into())
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
    task: JoinHandle<Result<()>>,
}
type HostKey = (String, Uuid, Uuid);
struct Registry {
    sites: sites::Sites,
    approvals: BTreeMap<String, Arc<Permission>>,
    hosts: BTreeMap<HostKey, Host>,
    local: Option<(String, Arc<Permission>)>,
}
impl Registry {
    async fn join_host(&mut self, key: &HostKey) {
        wait_host(&mut self.hosts.get_mut(key).unwrap().task).await;
        self.hosts.remove(key);
    }

    fn permission(&self, site: &str) -> Option<&Arc<Permission>> {
        self.local
            .as_ref()
            .filter(|(origin, _)| origin == site)
            .map(|(_, permission)| permission)
            .or_else(|| self.approvals.get(site))
    }
}
struct App {
    config: Config,
    port: u16,
    token: String,
    registry: Mutex<Registry>,
    closing: watch::Sender<bool>,
    launch: Mutex<Option<hosted::Launch>>,
    desktop: Desktop,
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
        let mut registry = self.registry.lock().await;
        if *self.closing.borrow() {
            bail!("hosting_unavailable");
        }
        if !registry
            .permission(site)
            .is_some_and(|current| Arc::ptr_eq(current, permission))
        {
            bail!("site_not_approved");
        }
        let key = (site.to_owned(), channel, user);
        if registry
            .hosts
            .get(&key)
            .is_some_and(|host| host.task.is_finished() || *host.stop.borrow())
        {
            registry.join_host(&key).await;
        }
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
                key: None,
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
                    task,
                },
            );
        }
        let host = registry.hosts.get(&key).unwrap();
        let commands = host.commands.clone();
        let mut ready = host.ready.clone();
        drop(registry);
        timeout(IO_TIMEOUT, async {
            loop {
                let result = ready.borrow().clone();
                if let Some(result) = result {
                    return result.map_err(anyhow::Error::msg);
                }
                ready
                    .changed()
                    .await
                    .map_err(|_| anyhow!("hosting_unavailable"))?;
            }
        })
        .await??;
        Ok(commands)
    }
    async fn shutdown(&self) {
        self.closing.send_replace(true);
        let hosts = {
            let mut registry = self.registry.lock().await;
            for permission in registry.approvals.values() {
                permission.revoked.send_replace(true);
            }
            if let Some((_, permission)) = &registry.local {
                permission.revoked.send_replace(true);
            }
            std::mem::take(&mut registry.hosts).into_values().collect()
        };
        stop_hosts(hosts).await;
        self.desktop.close();
        if let Some(launch) = self.launch.lock().await.take() {
            launch.close().await;
        }
    }
}
async fn stop_hosts(hosts: Vec<Host>) {
    for host in &hosts {
        host.stop.send_replace(true);
    }
    for mut host in hosts {
        wait_host(&mut host.task).await;
    }
}
async fn wait_host(task: &mut JoinHandle<Result<()>>) {
    match task.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("App hosting ended: {error}"),
        Err(error) => eprintln!("App hosting task ended: {error}"),
    }
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
    let address = listener.local_addr()?;
    if !address.ip().is_loopback() {
        bail!("App service requires a loopback listener");
    }
    let owner = lock_directory(&config.data_root)?;
    let sites = sites::Sites::open(&config.data_root)?;
    let entry = entry_url(&sites.startup()?, address.port())?;
    let open_browser = config.open_browser;
    let approvals = sites
        .approved()?
        .into_iter()
        .map(|(site, id)| (site, Arc::new(Permission::new(id))))
        .collect();
    let index = config.assets.join("index.html");
    let assets =
        web::static_files(ServeDir::new(&config.assets).fallback(web::document(index.clone())));
    let app = Arc::new(App {
        desktop: Desktop::new()?,
        config,
        port: address.port(),
        token: Uuid::new_v4().to_string(),
        registry: Mutex::new(Registry {
            sites,
            approvals,
            hosts: BTreeMap::new(),
            local: None,
        }),
        closing: watch::channel(false).0,
        launch: Mutex::new(None),
    });
    let router = Router::new()
        .route("/", web::document(index.clone()))
        .route("/index.html", web::document(index))
        .route("/connect-discovery", get(discovery))
        .route("/health", get(health))
        .route("/rooms", get(upgrade))
        .route("/rooms/{domain}/{user}/{room}/backup", get(backup::export))
        .route("/rooms/{domain}/{user}/backup", put(backup::restore))
        .route("/rooms/{domain}/{user}/hosting", get(backup::describe))
        .route("/api/client-launcher", get(launcher))
        .route("/api/client-launcher/debug", post(diagnostics::enable))
        .route(
            "/api/client-launcher/debug/export",
            post(diagnostics::export),
        )
        .route("/api/client-launcher/launch", post(hosted::launch))
        .route("/api/client-launcher/site", post(approve))
        .route("/api/client-launcher/startup-site", post(startup))
        .fallback_service(assets)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .layer(middleware::from_fn_with_state(app.clone(), access))
        .with_state(app.clone());
    let console = console::Console::new(None);
    console.startup(BUILD_VERSION, BUILD_REVISION, address.port());
    eprintln!("App room socket listening on {address}");
    if let Some(ready) = ready {
        let _ = ready.send(entry.clone());
    }
    if open_browser {
        tokio::task::spawn_blocking(move || {
            if let Err(error) = webbrowser::open(&entry) {
                eprintln!("Open the App address in your browser: {error}");
            }
        });
    }
    axum::serve(crate::web::http_listener(listener), router)
        .with_graceful_shutdown(async move {
            tokio::pin!(stop);
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    _ = &mut stop => break,
                    _ = tick.tick() => app.desktop.tick(),
                }
            }
            app.desktop.revoke();
            app.shutdown().await;
        })
        .await?;
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
    let allowed = match &origin {
        Some(site) => app.registry.lock().await.permission(site).is_some(),
        None => false,
    };
    if path.starts_with("/api/client-launcher") {
        let local = origin.as_ref().is_some_and(|site| local_origin(&app, site));
        if request.method() == axum::http::Method::POST {
            if !local
                || headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.split(';').next())
                    .map(str::trim)
                    != Some("application/json")
            {
                return StatusCode::FORBIDDEN.into_response();
            }
        } else if origin.is_some() && !local {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    if (health || backup) && !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cors = origin.filter(|_| discovery || ((health || backup) && allowed));
    let private_network = headers
        .get("access-control-request-private-network")
        .is_some_and(|value| value == "true");
    let mut response =
        if request.method() == axum::http::Method::OPTIONS && (discovery || health || backup) {
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
            if backup { "GET, PUT, OPTIONS" } else { "GET" }
                .parse()
                .unwrap(),
        );
        if backup {
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                "Authorization, Content-Type, X-Piik-Credential"
                    .parse()
                    .unwrap(),
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
        json!({"service":SERVICE,"protocol":PROTOCOL,"port":app.port,
        "connectURL":format!("http://127.0.0.1:{}/client",app.port)}),
    )
}
async fn health(State(app): State<Arc<App>>) -> Json<Value> {
    Json(
        json!({"service":SERVICE,"protocol":PROTOCOL,"port":app.port,"token":app.token,
        "version":BUILD_VERSION,"revision":BUILD_REVISION,"packageTarget":PACKAGE_TARGET}),
    )
}
fn launcher_state(registry: &Registry, port: u16) -> Result<Value> {
    Ok(
        json!({"sites":registry.approvals.keys().collect::<Vec<_>>(),"startupSite":registry.sites.startup()?,
        "version":BUILD_VERSION,"revision":BUILD_REVISION,
        "packageTarget":PACKAGE_TARGET,"controlPort":port,"debug":piik_channel_native::diagnostics::enabled()}),
    )
}
type ApiResult = std::result::Result<Json<Value>, (StatusCode, Json<Value>)>;
fn operation_failure(error: anyhow::Error) -> (StatusCode, Json<Value>) {
    eprintln!("App site operation failed: {error}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"detail":"App settings could not be saved"})),
    )
}
async fn launcher(State(app): State<Arc<App>>) -> ApiResult {
    let mut state = {
        let registry = app.registry.lock().await;
        launcher_state(&registry, app.port).map_err(operation_failure)?
    };
    hosted::describe(&app, &mut state)
        .await
        .map_err(operation_failure)?;
    Ok(Json(state))
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
    let id = registry
        .sites
        .approve(&site, change.allowed)
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
        let keys: Vec<_> = registry
            .hosts
            .keys()
            .filter(|(origin, ..)| origin == &site)
            .cloned()
            .collect();
        for key in &keys {
            registry.hosts[key].stop.send_replace(true);
        }
        for key in keys {
            registry.join_host(&key).await;
        }
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
    if !change.site.is_empty() && !registry.approvals.contains_key(&change.site) {
        return Err((
            StatusCode::CONFLICT,
            Json(launcher_state(&registry, app.port).map_err(operation_failure)?),
        ));
    }
    registry
        .sites
        .set_startup(&change.site)
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
            tokio::select! {
                _ = closing.changed() => {}, _ = revoked.changed() => {},
                _ = connection(socket, &app, &site, &permission) => {},
            }
        })
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
    ConnectionMetrics {
        room_id: String,
        publication_id: Option<Uuid>,
    },
    Targets,
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
        #[serde(default)]
        audio_settings: SourceAudioSettings,
        #[serde(default)]
        audio: bool,
        #[serde(default)]
        exclude_audio: Option<Target>,
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
}

#[derive(Default)]
struct Capture {
    active: Option<CaptureLease>,
    pending: Option<PendingCapture>,
    audio: Option<CaptureAudio>,
    audio_settings: SourceAudioSettings,
}
struct PendingCapture {
    request: AbortHandle,
    lease: Option<CaptureLease>,
}
enum CaptureResult {
    Prepared {
        lease: CaptureLease,
        codec: VideoCodec,
    },
    Committed(CaptureLease),
}
impl Capture {
    fn lease(&self) -> Option<&CaptureLease> {
        self.active.as_ref().filter(|lease| !lease.is_stopped())
    }
    fn prepare(
        &mut self,
        settings: SourceAudioSettings,
    ) -> Result<(AbortHandle, futures_util::future::AbortRegistration)> {
        settings.validate()?;
        anyhow::ensure!(self.pending.is_none(), "capture_pending");
        if self.lease().is_none() {
            self.audio_settings = settings;
        }
        let (request, registration) = AbortHandle::new_pair();
        self.pending = Some(PendingCapture {
            request: request.clone(),
            lease: None,
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
        self.pending
            .as_mut()
            .ok_or_else(|| anyhow!("capture_cancelled"))?
            .lease = Some(lease);
        Ok(())
    }
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
) -> Result<()> {
    let (mut writer, mut reader) = socket.split();
    let result = {
        let (incoming, mut queue) = mpsc::channel(64);
        let reading = async move {
            loop {
                match reader.next().await {
                    Some(Ok(Message::Text(text))) => incoming
                        .try_send(text)
                        .map_err(|_| anyhow!("App request queue full"))?,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => return Ok::<_, anyhow::Error>(()),
                }
            }
        };
        let processing = async {
            let mut host: Option<mpsc::Sender<HostCommand>> = None;
            let mut captures: BTreeMap<Uuid, Capture> = BTreeMap::new();
            let mut capture_starts: FuturesUnordered<
                BoxFuture<'static, (String, Uuid, AbortHandle, Result<CaptureResult>)>,
            > = FuturesUnordered::new();
            let mut audio_errors = FuturesUnordered::new();
            let mut capture_ends = FuturesUnordered::new();
            let mut input_states = FuturesUnordered::new();
            let mut audio_states = FuturesUnordered::new();
            let mut operations = FuturesUnordered::new();
            let mut previews = FuturesUnordered::new();
            let mut preview: Option<(String, Option<oneshot::Sender<()>>)> = None;
            loop {
                captures.retain(|_, capture| capture.pending.is_some() || capture.active.is_some());
                let message = tokio::select! {
                    _ = async {
                        match &host {
                            Some(commands) => commands.closed().await,
                            None => std::future::pending().await,
                        }
                    } => break,
                    message = async {
                        if host.is_some() { Ok(queue.recv().await) }
                        else { timeout(IO_TIMEOUT, queue.recv()).await }
                    } => message?,
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
                            let current = capture.active.as_ref().map(|lease| (lease.producer_id(), lease.id));
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
                    Some(response) = operations.next(), if !operations.is_empty() => {
                        let response: Value = response;
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        continue;
                    }
                    Some((id, result)) = previews.next(), if !previews.is_empty() => {
                        let result: Result<Option<String>> = result;
                        preview = None; // The capture has stopped and its worker has joined.
                        let response = match result {
                            Ok(image) => json!({"id":id,"result":image}),
                            Err(error) => json!({"id":id,"error":error.to_string()}),
                        };
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
                        continue;
                    }
                    Some((id, publication_id, request, result)) = capture_starts.next(), if !capture_starts.is_empty() => {
                        let request: AbortHandle = request;
                        let result: Result<CaptureResult> = result;
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
                                Ok(CaptureResult::Committed(mut lease)) => {
                                    let retained = lease.retains_video();
                                    let capture = captures.entry(publication_id).or_default();
                                    if let Some(previous) = capture.active.as_mut() { lease.adopt_previous(previous); }
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
                                    capture.active = Some(lease);
                                    Ok(Value::Null)
                                }
                                Err(error) => Err(error),
                            }
                        };
                        let response = match result {
                            Ok(value) => json!({"id":id,"result":value}),
                            Err(error) => {
                                if !request.is_aborted() {
                                    if let Some(capture) = captures.get_mut(&publication_id) { capture.pending = None; }
                                }
                                json!({"id":id,"error":error.to_string()})
                            }
                        };
                        timeout(IO_TIMEOUT, writer.send(Message::Text(response.to_string().into()))).await??;
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
                let Some(text) = message else { break };
                let value: Value = serde_json::from_str(&text)?;
                let id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty() && id.len() <= 256);
                let response = match (id, serde_json::from_value::<Request>(value.clone())) {
                    (Some(_), Ok(request)) => {
                        let result: Result<Value> = match request.operation {
                            Operation::Hello {
                                channel_id,
                                user_id,
                                credential,
                                name,
                            } => {
                                if host.is_some() {
                                    Err(anyhow!("already_initialized"))
                                } else {
                                    match app
                                        .hello(
                                            site, permission, channel_id, user_id, credential, name,
                                        )
                                        .await
                                    {
                                        Ok(commands) => {
                                            host = Some(commands);
                                            Ok(Value::Null)
                                        }
                                        Err(error) => Err(error),
                                    }
                                }
                            }
                            Operation::Open { policy } => match &host {
                                Some(commands) => open(commands, &policy).await,
                                None => Err(anyhow!("hello_required")),
                            },
                            Operation::ConnectionMetrics {
                                room_id,
                                publication_id,
                            } => match &host {
                                Some(commands) if operations.is_empty() => {
                                    let commands = commands.clone();
                                    operations.push(async move {
                                        let measured = timeout(IO_TIMEOUT, async {
                                            let (result, response) = oneshot::channel();
                                            commands.send(HostCommand::ConnectionMetrics { room_id, publication_id, result }).await.map_err(|_| anyhow!("hosting_unavailable"))?;
                                            let measured = response.await?.map_err(anyhow::Error::msg)?;
                                            Ok::<_, anyhow::Error>(serde_json::to_value(measured)?)
                                        }).await;
                                        match measured {
                                            Ok(Ok(value)) => json!({"id":request.id,"result":value}),
                                            Ok(Err(error)) => json!({"id":request.id,"error":error.to_string()}),
                                            Err(_) => json!({"id":request.id,"error":"request_timeout"}),
                                        }
                                    }.boxed());
                                    continue;
                                }
                                Some(_) => Err(anyhow!("request_pending")),
                                None => Err(anyhow!("hello_required")),
                            },
                            Operation::Targets => match &host {
                                Some(_) => capture_targets().await,
                                None => Err(anyhow!("hello_required")),
                            },
                            Operation::Microphones => match &host {
                                Some(_) => {
                                    tokio::task::spawn_blocking(|| {
                                        Ok(serde_json::to_value(
                                            piik_channel_native::capture::microphones()?,
                                        )?)
                                    })
                                    .await?
                                }
                                None => Err(anyhow!("hello_required")),
                            },
                            Operation::Preview { target } => {
                                if host.is_none() {
                                    Err(anyhow!("hello_required"))
                                } else if preview.is_some() {
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
                                audio_settings,
                                audio,
                                exclude_audio,
                                show_capture_border,
                            } => match &host {
                                Some(commands) => {
                                    let capture = captures.entry(publication_id).or_default();
                                    match capture.prepare(audio_settings) {
                                        Err(error) => Err(error),
                                        Ok((cancel, registration)) => {
                                            let replaces =
                                                capture.lease().map(CaptureLease::producer_id);
                                            let commands = commands.clone();
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
                                                            audio_settings,
                                                            audio,
                                                            exclude_audio,
                                                            show_capture_border,
                                                            replaces,
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
                                None => Err(anyhow!("hello_required")),
                            },
                            Operation::CommitCapture {
                                publication_id,
                                capture_id,
                            } => {
                                let lease = captures
                                    .get_mut(&publication_id)
                                    .and_then(|capture| capture.pending.as_mut())
                                    .and_then(|pending| pending.lease.as_mut())
                                    .filter(|lease| lease.id == capture_id && !lease.is_stopped());
                                if lease.is_none() {
                                    Err(anyhow!("capture_unavailable"))
                                } else if let Some(commands) = &host {
                                    let capture = captures.get_mut(&publication_id).unwrap();
                                    let lease =
                                        capture.pending.as_mut().unwrap().lease.take().unwrap();
                                    let replacing = capture.active.is_some();
                                    let (cancel, registration) = AbortHandle::new_pair();
                                    capture.pending = Some(PendingCapture {
                                        request: cancel.clone(),
                                        lease: None,
                                    });
                                    let commands = commands.clone();
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
                                } else {
                                    Err(anyhow!("hello_required"))
                                }
                            }
                            Operation::CancelCapture { publication_id } => {
                                let cancel =
                                    captures.get_mut(&publication_id).and_then(|capture| {
                                        capture.pending = None;
                                        capture.lease().map(CaptureLease::cancel_microphone)
                                    });
                                match cancel {
                                    Some(Ok(cancel)) => {
                                        operations.push(async move {
                                            match cancel.await {
                                                Ok(()) => json!({"id":request.id,"result":null}),
                                                Err(error) => json!({"id":request.id,"error":error.to_string()}),
                                            }
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
                                    .and_then(Capture::lease)
                                    .filter(|lease| lease.id == capture_id);
                                if let (Some(commands), Some(lease)) = (&host, lease) {
                                    let commands = commands.clone();
                                    let scope = lease.scope.clone();
                                    let capture_id = lease.producer_id();
                                    operations.push(async move {
                                        let result = transfer_source(&commands, scope, capture_id, to_session_id).await;
                                        match result {
                                            Ok(()) => json!({"id":request.id,"result":null}),
                                            Err(error) => json!({"id":request.id,"error":error.to_string()}),
                                        }
                                    }.boxed());
                                    continue;
                                } else {
                                    Err(anyhow!("capture_unavailable"))
                                }
                            }
                            Operation::StopCapture { publication_id } => {
                                drop(captures.remove(&publication_id));
                                Ok(Value::Null)
                            }
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
                                        let commands = host
                                            .as_ref()
                                            .ok_or_else(|| anyhow!("hello_required"))?
                                            .clone();
                                        let scope = lease.scope.clone();
                                        let producer = lease.producer_id();
                                        lease.configure_video(settings, async move {
                                            publish_capture_ceiling(
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
                                            match update.await {
                                                Ok(()) => json!({"id":request.id,"result":null}),
                                                Err(error) => json!({"id":request.id,"error":error.to_string()}),
                                            }
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
                                            match update.await {
                                                Ok(()) => json!({"id":request.id,"result":state.borrow().microphone.clone()}),
                                                Err(error) => json!({"id":request.id,"error":error.to_string()}),
                                            }
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
                                    .and_then(Capture::lease)
                                    .filter(|lease| lease.id == capture_id);
                                if let (Some(commands), Some(lease)) = (&host, lease) {
                                    let commands = commands.clone();
                                    let scope = lease.scope.clone();
                                    let capture_id = lease.producer_id();
                                    operations.push(async move {
                                        let result = pause_capture(&commands, scope, capture_id, paused).await;
                                        match result {
                                            Ok(()) => json!({"id":request.id,"result":null}),
                                            Err(error) => json!({"id":request.id,"error":error.to_string()}),
                                        }
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
                                            match policy.await {
                                                Ok(()) => json!({"id":request.id,"result":null}),
                                                Err(error) => json!({"id":request.id,"error":error.to_string()}),
                                            }
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
                                            match shortcut.await {
                                                Ok(()) => {
                                                    let label = desktop.shortcut_label();
                                                    let available = label.as_ref().is_none_or(Option::is_some);
                                                    let mut value = json!({"key":key,"available":available});
                                                    if let Some(label) = label { value["stopShortcutLabel"] = json!(label); }
                                                    json!({"id":request.id,"result":value})
                                                }
                                                Err(error) => json!({"id":request.id,"error":error.to_string()}),
                                            }
                                        }.boxed());
                                        continue;
                                    }
                                    Err(error) => Err(error),
                                }
                            }
                        };
                        match result {
                            Ok(result) => json!({"id":request.id,"result":result}),
                            Err(error) => json!({"id":request.id,"error":error.to_string()}),
                        }
                    }
                    _ => json!({"id":id,"error":"invalid_request"}),
                };
                timeout(
                    IO_TIMEOUT,
                    writer.send(Message::Text(response.to_string().into())),
                )
                .await??;
            }
            Ok(())
        };
        tokio::pin!(reading, processing);
        tokio::select! {
            result = &mut reading => result,
            result = &mut processing => result,
        }
    };
    // Dropping the processor first stops every page-owned capture, including
    // while a Native request is awaiting admission or a room-host response.
    let _ = timeout(IO_TIMEOUT, writer.close()).await;
    result
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
            };
            let audio = piik_channel_native::capture::audio_capabilities();
            let mut result = json!({"sources": sources, "codecs": codecs, "processAudio": audio.process_audio, "processAudioExclusion": audio.process_audio_exclusion, "systemAudio": audio.system_audio, "captureBorderControl": piik_channel_native::capture::capture_border_control()});
            if let Some(activation) = piik_channel_native::capture::activation_url()? {
                result["activationURL"] = json!(activation);
            }
            Ok(result)
        }).await?
    }
    #[cfg(not(feature = "capture"))]
    {
        Ok(
            json!({"sources": [], "codecs": [], "processAudio": false, "processAudioExclusion": false, "systemAudio": false, "captureBorderControl": false}),
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
    audio_settings: SourceAudioSettings,
    audio: bool,
    exclude_audio: Option<Target>,
    show_capture_border: bool,
    replaces: Option<Uuid>,
) -> Result<CaptureResult> {
    if !cfg!(feature = "capture") {
        bail!("capture_unavailable");
    }
    settings.validate()?;
    audio_settings.validate()?;
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::PrepareCapture(PrepareCapture {
            publication_id,
            room_id,
            target,
            settings,
            codec_mode,
            audio,
            exclude_audio,
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
    mut lease: CaptureLease,
    replacing: bool,
) -> Result<CaptureLease> {
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::CommitCapture(CommitCapture {
            scope: lease.scope.clone(),
            capture_id: lease.id,
            replacing,
            retaining: lease.retains_video(),
            video_ceiling: lease.video_ceiling(),
            result,
        }))
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    let input = response
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?
        .map_err(anyhow::Error::msg)?;
    lease.remote = input.remote;
    lease.input_state = input.state;
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

async fn publish_capture_ceiling(
    commands: &mpsc::Sender<HostCommand>,
    scope: piik_channel_native::peer::CaptureScope,
    capture_id: Uuid,
    ceiling: piik_channel_core::wire::VideoCeiling,
) -> Result<()> {
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::PublishCaptureCeiling(PublishCaptureCeiling {
            scope,
            capture_id,
            ceiling,
            result,
        }))
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
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
    };

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
        let (_request, _registration) = capture.prepare(old).unwrap();
        capture.configure_audio(muted).unwrap();
        assert_eq!(capture.audio_settings, muted);
        // A duplicate preparation cannot replace accepted audio intent while
        // the existing request owns its first frame/commit wait.
        assert_eq!(
            capture.prepare(old).unwrap_err().to_string(),
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
        let permission = Arc::new(Permission::new(sites.approve(&site, true).unwrap()));
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
            task: tokio::spawn(async move {
                let _ = first_stopped.changed().await;
                Ok(())
            }),
        };
        let second = Host {
            credential: "credential".into(),
            commands: second_commands,
            ready: watch::channel(Some(Ok(()))).1,
            stop: second_stop,
            task: tokio::spawn(async move {
                let _ = second_stopped.changed().await;
                let _ = wait_release.await;
                let _ = finished.send(());
                Ok(())
            }),
        };
        let app = Arc::new(App {
            config: Config {
                data_root: directory.path().into(),
                assets: directory.path().into(),
                open_browser: false,
                cloudflared: PathBuf::new(),
                ice_servers: vec![],
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
            "publicationId": Uuid::new_v4(), "codecMode": "vp8",
            "target": {"kind": "display", "sourceId": "1", "title": "Test display"},
            "settings": {"width": 1280, "height": 720, "fps": 24, "bitrate": 2_500_000},
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
            audio_settings,
            audio,
            exclude_audio,
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
        let start = prepare_capture(
            &commands,
            publication,
            room_id,
            target.clone(),
            settings,
            codec_mode,
            audio_settings,
            audio,
            exclude_audio,
            show_capture_border,
            None,
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

        let invalid = Settings { fps: 0, ..settings };
        let error = prepare_capture(
            &commands,
            publication,
            "room".into(),
            target,
            invalid,
            VideoCodecMode::H264,
            SourceAudioSettings::default(),
            false,
            None,
            false,
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
            serde_json::to_value(piik_channel_core::wire::VideoCeiling::from(settings)).unwrap(),
            json!({"resolution":{"width":1280,"height":720},"maxFramerate":24.0,"maxBitrate":2_500_000})
        );
    }

    #[tokio::test]
    async fn capture_ceiling_response_waits_for_the_native_room_reply() {
        let scope = piik_channel_native::peer::CaptureScope {
            publication_id: Uuid::new_v4(),
            room_id: "room".into(),
            binding_id: Uuid::new_v4(),
        };
        let producer = Uuid::new_v4();
        let ceiling = Settings {
            width: 1280,
            height: 720,
            fps: 24,
            bitrate: 2_500_000,
        }
        .into();
        for acknowledgement in [Ok(()), Err("room_rejected".to_owned())] {
            let (commands, mut requests) = mpsc::channel(1);
            let update = publish_capture_ceiling(&commands, scope.clone(), producer, ceiling);
            tokio::pin!(update);
            let request = tokio::select! {
                request = requests.recv() => request.unwrap(),
                result = &mut update => panic!("App replied before Native authority: {result:?}"),
            };
            let HostCommand::PublishCaptureCeiling(request) = request else {
                panic!("ceiling command")
            };
            assert_eq!(request.scope.publication_id, scope.publication_id);
            assert_eq!(request.scope.binding_id, scope.binding_id);
            assert_eq!(request.capture_id, producer);
            assert_eq!(request.ceiling, ceiling);
            assert!(futures_util::poll!(&mut update).is_pending());
            request.result.send(acknowledgement.clone()).unwrap();
            assert_eq!(
                update.await.map_err(|error| error.to_string()),
                acknowledgement
            );
        }
    }
}
