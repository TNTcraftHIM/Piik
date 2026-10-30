//! Local approval owns site access; the App owns each admitted site's room hosts.
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
    routing::{get, post},
    Json, Router,
};
use futures_util::{stream::FuturesUnordered, SinkExt, StreamExt};
use piik_channel_core::RoomState;
use piik_channel_native::{
    capture::{Settings, Target},
    input::{Desktop, Mode, SourceView},
    peer::CaptureLease,
    session::{self, HostCommand, Hosting, OpenRoom, StartCapture},
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
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const SERVICE: &str = "piik-channel-app";
const PROTOCOL: u8 = 1;
// Prototype native-share defaults; the shared share settings will supply these.
const CAPTURE_SETTINGS: Settings = Settings {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 4_000_000,
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
            .is_some_and(|host| host.task.is_finished())
        {
            let _ = registry.hosts.remove(&key).unwrap().task.await;
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
    for host in hosts {
        match host.task.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("App hosting ended: {error}"),
            Err(error) => eprintln!("App hosting task ended: {error}"),
        }
    }
}

/// Local approval and persistent room hosting share one process, not page lifetime.
pub async fn serve(
    listener: TcpListener,
    config: Config,
    stop: impl Future<Output = ()> + Send + 'static,
) -> Result<()> {
    let address = listener.local_addr()?;
    if !address.ip().is_loopback() {
        bail!("App service requires a loopback listener");
    }
    std::fs::create_dir_all(&config.data_root)?;
    // Approval and hosting have one process owner for this local data directory.
    let owner = std::fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config.data_root.join("app.lock"))?;
    owner
        .try_lock()
        .map_err(|_| anyhow!("This App data directory is already in use"))?;
    let sites = sites::Sites::open(&config.data_root)?;
    let entry = entry_url(&sites.startup()?, address.port())?;
    let open_browser = config.open_browser;
    let approvals = sites
        .approved()?
        .into_iter()
        .map(|(site, id)| (site, Arc::new(Permission::new(id))))
        .collect();
    let assets =
        ServeDir::new(&config.assets).fallback(ServeFile::new(config.assets.join("index.html")));
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
        .route("/connect-discovery", get(discovery))
        .route("/health", get(health))
        .route("/rooms", get(upgrade))
        .route("/api/client-launcher", get(launcher))
        .route("/api/client-launcher/launch", post(hosted::launch))
        .route("/api/client-launcher/site", post(approve))
        .route("/api/client-launcher/startup-site", post(startup))
        .fallback_service(assets)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .layer(middleware::from_fn_with_state(app.clone(), access))
        .with_state(app.clone());
    eprintln!("App room socket listening on {address}");
    eprintln!("Open Piik App: {entry}");
    if open_browser {
        tokio::task::spawn_blocking(move || {
            if let Err(error) = webbrowser::open(&entry) {
                eprintln!("Open the App address in your browser: {error}");
            }
        });
    }
    axum::serve(listener, router)
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
    if health && !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cors = origin.filter(|_| discovery || (health && allowed));
    let private_network = headers
        .get("access-control-request-private-network")
        .is_some_and(|value| value == "true");
    let mut response = if request.method() == axum::http::Method::OPTIONS && (discovery || health) {
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
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_METHODS, "GET".parse().unwrap());
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
    Json(json!({"service":SERVICE,"protocol":PROTOCOL,"port":app.port,"token":app.token}))
}
fn launcher_state(registry: &Registry, port: u16) -> Result<Value> {
    Ok(
        json!({"sites":registry.approvals.keys().collect::<Vec<_>>(),"startupSite":registry.sites.startup()?,
        "defaultMode":"link","modes":["local","link"],"siteAccess":"channel","version":"development",
        "revision":"development","controlPort":port}),
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
    let (result, hosts) = {
        let mut registry = app.registry.lock().await;
        let id = registry
            .sites
            .approve(&site, change.allowed)
            .map_err(operation_failure)?;
        let mut retired = Vec::new();
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
            for key in keys {
                retired.push(registry.hosts.remove(&key).unwrap());
            }
        }
        (
            launcher_state(&registry, app.port).map_err(operation_failure)?,
            retired,
        )
    };
    stop_hosts(hosts).await;
    Ok(Json(result))
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
    Targets,
    StartCapture {
        room_id: String,
        target: Target,
        #[serde(default)]
        audio: bool,
    },
    StopCapture {
        publication_id: Uuid,
    },
    InputPolicy {
        publication_id: Uuid,
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
            let mut host = None;
            let mut captures: BTreeMap<Uuid, CaptureLease> = BTreeMap::new();
            let mut audio_errors = FuturesUnordered::new();
            let mut input_states = FuturesUnordered::new();
            loop {
                let mut initial_input = None;
                let message = tokio::select! {
                    message = async {
                        if host.is_some() { Ok(queue.recv().await) }
                        else { timeout(IO_TIMEOUT, queue.recv()).await }
                    } => message?,
                    Some((publication_id, error)) = audio_errors.next(), if !audio_errors.is_empty() => {
                        let error: Option<String> = error;
                        if error.is_some() && captures.get(&publication_id).is_some_and(|lease| !lease.is_stopped()) {
                            let event = json!({"type":"capture_audio_failed","publicationId":publication_id});
                            timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                        }
                        continue;
                    }
                    Some((publication_id, changed, state)) = input_states.next(), if !input_states.is_empty() => {
                        let state: Option<SourceView> = state;
                        if let Some(state) = state.filter(|_| captures.get(&publication_id).is_some_and(|lease| !lease.is_stopped())) {
                            let event = json!({"type":"input_state","publicationId":publication_id,"state":state});
                            timeout(IO_TIMEOUT, writer.send(Message::Text(event.to_string().into()))).await??;
                            input_states.push(next_input_state(publication_id, changed));
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
                            Operation::Targets => match &host {
                                Some(_) => capture_targets().await,
                                None => Err(anyhow!("hello_required")),
                            },
                            Operation::StartCapture {
                                room_id,
                                target,
                                audio,
                            } => match &host {
                                Some(commands) => {
                                    captures.retain(|_, lease| !lease.is_stopped());
                                    let publication_id = Uuid::new_v4();
                                    match start_capture(
                                        commands,
                                        publication_id,
                                        room_id,
                                        target,
                                        audio,
                                    )
                                    .await
                                    {
                                        Ok(mut lease) => {
                                            if let Some(error) = lease.audio_error.take() {
                                                audio_errors.push(async move {
                                                    (publication_id, error.await.ok())
                                                });
                                            }
                                            if let Some(state) = &lease.input_state {
                                                initial_input =
                                                    Some((publication_id, state.borrow().clone()));
                                                input_states.push(next_input_state(
                                                    publication_id,
                                                    state.clone(),
                                                ));
                                            }
                                            captures.insert(publication_id, lease);
                                            Ok(json!({"publicationId":publication_id}))
                                        }
                                        Err(error) => Err(error),
                                    }
                                }
                                None => Err(anyhow!("hello_required")),
                            },
                            Operation::StopCapture { publication_id } => {
                                drop(captures.remove(&publication_id));
                                Ok(Value::Null)
                            }
                            Operation::InputPolicy {
                                publication_id,
                                mode,
                                password,
                                simultaneous,
                            } => (|| -> Result<Value> {
                                let lease = captures
                                    .get(&publication_id)
                                    .filter(|lease| !lease.is_stopped())
                                    .ok_or_else(|| anyhow!("input_source_unavailable"))?;
                                let source = lease
                                    .remote
                                    .as_ref()
                                    .ok_or_else(|| anyhow!("input_source_unavailable"))?;
                                if let Some(password) = password {
                                    source.set_policy(mode, &password)?;
                                } else if lease
                                    .input_state
                                    .as_ref()
                                    .is_none_or(|state| state.borrow().mode != mode)
                                {
                                    source.set_mode(mode)?;
                                }
                                if let Some(enabled) = simultaneous {
                                    source.set_simultaneous(enabled)?;
                                }
                                Ok(Value::Null)
                            })(),
                            Operation::InputDecide {
                                publication_id,
                                controller_session_id,
                                intent,
                                allow,
                            } => (|| -> Result<Value> {
                                let lease = captures
                                    .get(&publication_id)
                                    .filter(|lease| !lease.is_stopped())
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
                            } => (|| -> Result<Value> {
                                let lease = captures
                                    .get(&publication_id)
                                    .filter(|lease| !lease.is_stopped())
                                    .ok_or_else(|| anyhow!("input_source_unavailable"))?;
                                if lease.remote.is_none() {
                                    bail!("input_source_unavailable");
                                }
                                app.desktop.set_shortcut(key)?;
                                Ok(json!({"key":key,"available":true}))
                            })(),
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
                if let Some((publication_id, state)) = initial_input {
                    let event =
                        json!({"type":"input_state","publicationId":publication_id,"state":state});
                    timeout(
                        IO_TIMEOUT,
                        writer.send(Message::Text(event.to_string().into())),
                    )
                    .await??;
                }
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
    mut changed: watch::Receiver<SourceView>,
) -> (Uuid, watch::Receiver<SourceView>, Option<SourceView>) {
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
            let sources = piik_channel_native::capture::targets()?;
            let audio = piik_channel_native::capture::audio_capabilities();
            Ok(json!({"sources": sources, "processAudio": audio.process_audio, "systemAudio": audio.system_audio}))
        }).await?
    }
    #[cfg(not(feature = "capture"))]
    {
        Ok(json!({"sources": [], "processAudio": false, "systemAudio": false}))
    }
}

async fn start_capture(
    commands: &mpsc::Sender<HostCommand>,
    publication_id: Uuid,
    room_id: String,
    target: Target,
    audio: bool,
) -> Result<CaptureLease> {
    if !cfg!(feature = "capture") {
        bail!("capture_unavailable");
    }
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::StartCapture(StartCapture {
            publication_id,
            room_id,
            target,
            settings: CAPTURE_SETTINGS,
            audio,
            result,
        }))
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    let mut lease = response
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?
        .map_err(anyhow::Error::msg)?;
    lease.ready().await.map_err(|_| anyhow!("capture_failed"))?;
    Ok(lease)
}
