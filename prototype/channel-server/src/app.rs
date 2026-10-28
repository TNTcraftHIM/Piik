//! Local approval owns site access; the App owns each admitted site's room hosts.
#[path = "app_sites.rs"]
mod sites;

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
use futures_util::{SinkExt, StreamExt};
use piik_channel_core::RoomState;
use piik_channel_native::session::{self, Hosting, OpenRoom};
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

pub struct Config {
    pub data_root: PathBuf,
    pub assets: PathBuf,
    pub open_browser: bool,
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
    commands: mpsc::Sender<OpenRoom>,
    ready: watch::Receiver<Option<Result<(), String>>>,
    stop: watch::Sender<bool>,
    task: JoinHandle<Result<()>>,
}
type HostKey = (String, Uuid, Uuid);
struct Registry {
    sites: sites::Sites,
    approvals: BTreeMap<String, Arc<Permission>>,
    hosts: BTreeMap<HostKey, Host>,
}
struct App {
    config: Config,
    port: u16,
    token: String,
    registry: Mutex<Registry>,
    closing: watch::Sender<bool>,
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
    ) -> Result<mpsc::Sender<OpenRoom>> {
        let mut registry = self.registry.lock().await;
        if *self.closing.borrow() {
            bail!("hosting_unavailable");
        }
        if !registry
            .approvals
            .get(site)
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
            std::mem::take(&mut registry.hosts).into_values().collect()
        };
        stop_hosts(hosts).await;
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
        config,
        port: address.port(),
        token: Uuid::new_v4().to_string(),
        registry: Mutex::new(Registry {
            sites,
            approvals,
            hosts: BTreeMap::new(),
        }),
        closing: watch::channel(false).0,
    });
    let router = Router::new()
        .route("/connect-discovery", get(discovery))
        .route("/health", get(health))
        .route("/rooms", get(upgrade))
        .route("/api/client-launcher", get(launcher))
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
            stop.await;
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
        Some(site) => app.registry.lock().await.approvals.contains_key(site),
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
        "defaultMode":"link","modes":[],"siteAccess":"rooms","version":"development",
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
    let registry = app.registry.lock().await;
    launcher_state(&registry, app.port)
        .map(Json)
        .map_err(operation_failure)
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
    let permission = app.registry.lock().await.approvals.get(&site).cloned();
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
}
async fn connection(
    mut socket: WebSocket,
    app: &App,
    site: &str,
    permission: &Arc<Permission>,
) -> Result<()> {
    let mut host = None;
    loop {
        let message = if host.is_some() {
            socket.next().await
        } else {
            timeout(IO_TIMEOUT, socket.next()).await?
        };
        let Some(message) = message else { break };
        let text = match message? {
            Message::Text(text) => text,
            Message::Close(_) => {
                timeout(IO_TIMEOUT, socket.flush()).await??;
                break;
            }
            Message::Ping(_) | Message::Pong(_) => {
                timeout(IO_TIMEOUT, socket.flush()).await??;
                continue;
            }
            _ => bail!("App requests must be text"),
        };
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
                                .hello(site, permission, channel_id, user_id, credential, name)
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
            socket.send(Message::Text(response.to_string().into())),
        )
        .await??;
    }
    Ok(())
}
async fn open(commands: &mpsc::Sender<OpenRoom>, policy: &str) -> Result<Value> {
    let policy: RoomState = serde_json::from_str(policy)?;
    let (result, opened) = oneshot::channel();
    commands
        .send(OpenRoom { policy, result })
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    Ok(serde_json::to_value(
        opened
            .await
            .map_err(|_| anyhow!("hosting_unavailable"))?
            .map_err(anyhow::Error::msg)?,
    )?)
}
