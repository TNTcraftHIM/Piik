//! One App-owned domain, independent of launcher pages and approved remote sites.
#[path = "app_stun.rs"]
mod stun;

use super::{console::Console, sites::StartupIntent, stop_hosts, tunnel, ApiResult, App, Permission};
use crate::{domain::Domain, web};
use axum::{extract::State, http::StatusCode, Json};
use piik_channel_core::wire::HostingMode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{future::pending, net::Ipv4Addr, num::NonZeroU16, sync::Arc};
use tokio::{
    net::{TcpListener, UdpSocket},
    sync::{mpsc, watch},
    task::JoinHandle,
};

const DEFAULT_SITE_PORT: u16 = 8787;

#[derive(Clone)]
pub(super) struct Failure {
    reason: &'static str,
    detail: String,
}
impl Failure {
    fn new(reason: &'static str, detail: impl std::fmt::Display) -> Self {
        Self {
            reason,
            detail: detail.to_string(),
        }
    }
    fn response(self) -> (StatusCode, Json<Value>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "reason": self.reason, "detail": self.detail })),
        )
    }
}
#[derive(Clone)]
pub(super) enum Progress {
    Starting,
    Ready(Ready),
    Failed(Failure),
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Ready {
    target: String,
    #[serde(skip)]
    domain: Domain,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_certificate: Option<LocalCertificate>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalCertificate {
    origin: String,
    sha256_fingerprint: String,
}
impl Ready {
    fn new(target: String, https: Option<&web::LanHttps>, domain: Domain) -> Self {
        Self {
            target,
            domain,
            local_certificate: https.map(|https| LocalCertificate {
                origin: https.origin().to_owned(),
                sha256_fingerprint: https.fingerprint(),
            }),
        }
    }
    fn describe(&self, state: &mut Value) {
        state["target"] = json!(self.target);
        if let Some(certificate) = &self.local_certificate {
            state["localCertificate"] = json!(certificate);
        }
    }
}
pub(super) struct Launch {
    progress: watch::Receiver<Progress>,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Launch {
    pub async fn close(self) {
        self.stop.send_replace(true);
        if let Err(error) = self.task.await {
            eprintln!("App domain task ended: {error}");
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Mode {
    Local,
    Link,
    External,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    pub mode: Mode,
    // A launch override; persisted startup follows Sites::domain_port.
    #[serde(skip_serializing)]
    port: Option<NonZeroU16>,
    lan_address: Option<String>,
    language: Option<String>,
    pub public_origin: Option<String>,
}

impl Request {
    fn validate(&self) -> anyhow::Result<()> {
        match (&self.mode, &self.public_origin) {
            (Mode::External, Some(origin)) => {
                web::origin(origin)?;
                anyhow::ensure!(
                    origin.starts_with("https://"),
                    "public_origin_requires_https"
                );
            }
            (Mode::External, None) => anyhow::bail!("public_origin_required"),
            (_, Some(_)) => anyhow::bail!("public_origin_requires_external_mode"),
            _ => {}
        }
        Ok(())
    }
}

pub(super) async fn describe(app: &App, state: &mut Value) -> anyhow::Result<()> {
    let port = app
        .registry
        .lock()
        .await
        .sites
        .domain_port()?
        .map_or(DEFAULT_SITE_PORT, NonZeroU16::get);
    state["sitePort"] = json!(port);
    state["siteAddress"] = json!(format!("http://127.0.0.1:{port}"));
    let addresses = web::lan_addresses()?;
    let selected = addresses
        .first()
        .map(|entry| entry.address.as_str())
        .unwrap_or("");
    state["lan"] = json!({ "addresses": addresses, "selected": selected });
    if let Some(launch) = app.launch.lock().await.as_ref() {
        match &*launch.progress.borrow() {
            Progress::Starting => state["starting"] = json!(true),
            Progress::Ready(ready) => ready.describe(state),
            Progress::Failed(failure) => {
                state["reason"] = json!(failure.reason);
                state["detail"] = json!(failure.detail);
            }
        }
    }
    Ok(())
}

pub(super) async fn owner_entry(State(app): State<Arc<App>>) -> ApiResult {
    owner_target(&app).await.map(|target| Json(json!({ "target": target })))
}

pub(super) async fn owner_target(app: &App) -> Result<String, (StatusCode, Json<Value>)> {
    let launch = app.launch.lock().await;
    let ready = launch.as_ref().map(|launch| launch.progress.borrow());
    let Some(Progress::Ready(ready)) = ready.as_deref() else {
        return Err((StatusCode::CONFLICT, Json(json!({"detail":"Site is not ready"}))));
    };
    let ticket = ready.domain.launch_ticket().map_err(super::operation_failure)?;
    Ok(format!("{}&launch={ticket}", ready.target))
}

pub(super) async fn launch(State(app): State<Arc<App>>, Json(request): Json<Request>) -> ApiResult {
    let mut progress = begin(&app, request).await?;
    // The App owns startup. Closing this HTTP request only stops this wait.
    loop {
        match progress.borrow().clone() {
            Progress::Ready(ready) => return Ok(Json(json!(ready))),
            Progress::Failed(failure) => return Err(failure.response()),
            Progress::Starting => {}
        }
        if progress.changed().await.is_err() {
            return Err(Failure::new("local-server", "The local service stopped").response());
        }
    }
}

pub(super) async fn begin(
    app: &Arc<App>,
    request: Request,
) -> Result<watch::Receiver<Progress>, (StatusCode, Json<Value>)> {
    request.validate().map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"reason":"configuration", "detail":error.to_string()})),
        )
    })?;
    let mut current = app.launch.lock().await;
    if *app.closing.borrow() {
        return Err(Failure::new("local-server", "Piik App is closing").response());
    }
    if current.as_ref().is_some_and(|launch| {
        launch.task.is_finished() || matches!(*launch.progress.borrow(), Progress::Failed(_))
    }) {
        current.take().unwrap().close().await;
    }
    if current.is_none() {
        let (progress, receiver) = watch::channel(Progress::Starting);
        let (stop, stopped) = watch::channel(false);
        let owner = app.clone();
        let task = tokio::spawn(async move {
            let console = Console::new(request.language.as_deref());
            console.starting(!matches!(request.mode, Mode::Local));
            let port = owner.port;
            if let Err(failure) = run(owner, request, stopped, &progress, &console).await {
                eprintln!("App startup {}: {}", failure.reason, failure.detail);
                log::error!(target: "piik.app", "App startup {}: {}", failure.reason, failure.detail);
                console.failed(port);
                progress.send_replace(Progress::Failed(failure));
            }
        });
        *current = Some(Launch {
            progress: receiver,
            stop,
            task,
        });
    }
    Ok(current.as_ref().unwrap().progress.clone())
}

async fn run(
    app: Arc<App>,
    request: Request,
    mut stopped: watch::Receiver<bool>,
    progress: &watch::Sender<Progress>,
    console: &Console,
) -> Result<(), Failure> {
    let routes =
        web::frontend(&app.config.assets).map_err(|error| Failure::new("configuration", error))?;
    let namespace = app
        .registry
        .lock()
        .await
        .sites
        .local_namespace()
        .map_err(|error| Failure::new("configuration", error))?;
    let saved_port = app
        .registry
        .lock()
        .await
        .sites
        .domain_port()
        .map_err(|error| Failure::new("configuration", error))?;
    let port = request
        .port
        .or(saved_port)
        .map_or(DEFAULT_SITE_PORT, NonZeroU16::get);
    let bind_address = std::net::SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let http = TcpListener::bind(bind_address)
        .await
        .map_err(|error| Failure::new("local-port", format!("{bind_address}: {error}")))?;
    let address = http
        .local_addr()
        .map_err(|error| Failure::new("local-port", error))?;
    let origin = format!("http://{address}");
    let https = if matches!(request.mode, Mode::Local) {
        Some(local_https(request.lan_address.as_deref(), address.port()).await?)
    } else {
        None
    };
    if saved_port.map(NonZeroU16::get) != Some(port) {
        app.registry
            .lock()
            .await
            .sites
            .set_domain_port(std::num::NonZeroU16::new(address.port()).expect("bound TCP port"))
            .map_err(|error| Failure::new("configuration", error))?;
    }
    let stun = match &https {
        Some(https) => Some(
            UdpSocket::bind((
                https
                    .listener
                    .local_addr()
                    .map_err(|error| Failure::new("local-network", error))?
                    .ip(),
                0,
            ))
            .await
            .map_err(|error| Failure::new("local-network", error))?,
        ),
        None => None,
    };
    let ice_servers = match &stun {
        Some(socket) => vec![json!({"urls": [format!("stun:{}", socket.local_addr()
            .map_err(|error| Failure::new("local-network", error))?)]})],
        None => app.config.ice_servers.clone(),
    };
    let mut tunnel = if matches!(request.mode, Mode::Link) {
        Some(
            tunnel::start(&app.config.cloudflared, &origin, async {
                let _ = stopped.changed().await;
            })
            .await
            .map_err(|error| Failure::new(error.reason, error))?,
        )
    } else {
        None
    };
    let invitation = match (&https, &tunnel, &request.public_origin) {
        (Some(https), _, _) => https.origin(),
        (_, Some(tunnel), _) => tunnel.origin(),
        (_, _, Some(origin)) => origin,
        _ => unreachable!(),
    }
    .to_owned();
    let domain = Domain::open(
        &app.config.data_root.join("domain"),
        None,
        origin.clone(),
        Some(invitation.clone()),
        ice_servers,
    );
    let domain = match domain {
        Ok(domain) if !*app.closing.borrow() && !*stopped.borrow() => domain,
        result => {
            if let Some(tunnel) = tunnel.take() {
                let _ = tunnel.close().await;
            }
            return Err(Failure::new(
                "local-server",
                result
                    .err()
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "Piik App is closing".into()),
            ));
        }
    };
    let ready = Ready::new(
        format!("{origin}/?piik-client-port={}#piik-client=1", app.port),
        https.as_ref(),
        domain.clone(),
    );
    if let Some(certificate) = &ready.local_certificate {
        eprintln!("Local invitation entry: {}", certificate.origin);
        eprintln!("Certificate SHA-256: {}", certificate.sha256_fingerprint);
    }
    let permission = Arc::new(Permission::new(namespace));
    {
        let mut registry = app.registry.lock().await;
        // A successful retry can change how the same auto-started site is hosted.
        let configured = registry.sites.startup().and_then(|startup| {
            if matches!(startup, StartupIntent::Owned(_)) {
                registry.sites.set_startup(&StartupIntent::Owned(request.clone()))?;
            }
            Ok(())
        });
        if let Err(error) = configured {
            drop(registry);
            if let Some(tunnel) = tunnel.take() {
                let _ = tunnel.close().await;
            }
            return Err(Failure::new("configuration", error));
        }
        registry.local = Some(super::LocalSite {
            origin: origin.clone(),
            invitation: invitation.clone(),
            request: request.clone(),
            permission: permission.clone(),
        });
    }
    let (commands, mut restores) = mpsc::channel::<crate::domain::RestoreDomain>(1);
    let domain = domain.with_restores(commands);
    let (stop_domain, mut domain_stopped) = watch::channel(false);
    let mut service = tokio::spawn(domain.clone().serve_with_https(
        http,
        https,
        routes,
        async move {
            let _ = domain_stopped.changed().await;
        },
    ));
    console.ready(&origin, &invitation, matches!(request.mode, Mode::External));
    progress.send_replace(Progress::Ready(ready));
    let (result, finished_service) = loop {
        tokio::select! {
            _ = stopped.changed() => break (Ok(()), None),
            result = &mut service => break (Err(Failure::new("local-server", "The local service stopped")), Some(result)),
            result = async {
                match &stun {
                    Some(socket) => stun::serve(socket).await,
                    None => pending().await,
                }
            } => break (Err(Failure::new("local-network", result.err().map(|error| error.to_string())
                .unwrap_or_else(|| "Local discovery stopped".into()))), None),
            result = async {
                match tunnel.as_mut() {
                    Some(tunnel) => tunnel.wait().await,
                    None => pending().await,
                }
            } => break (Err(Failure::new("tunnel-stopped", result.err().map(|error| error.to_string())
                .unwrap_or_else(|| "The public invitation service stopped".into()))), None),
            Some(request) = restores.recv() => {
                if request.result.is_closed() { continue; }
                if !domain.is_owner_credential(&request.credential) {
                    let _ = request.result.send(Err("forbidden".into()));
                    continue;
                }
                if request.metadata.state.hosting_mode() == HostingMode::Hosted {
                    let _ = request.result.send(Err("hosted_channel_requires_server".into()));
                    continue;
                }
                // Keep host creation exclusive through shutdown and replacement;
                // ordinary registry reads do not wait for Native retirement.
                let creation = app.host_creation.write().await;
                let mut registry = app.registry.lock().await;
                let domain_id = domain.identity().0;
                let keys: Vec<_> = registry.hosts.keys()
                    .filter(|(site, id, _)| *id == domain_id && domain.allows_origin(site))
                    .cloned().collect();
                let mut hosts = vec![];
                let mut restart = vec![];
                for key in keys {
                    let host = registry.hosts.remove(&key).unwrap();
                    restart.push((key, host.credential.clone()));
                    hosts.push(host);
                }
                drop(registry);
                stop_hosts(hosts).await;
                let result = domain.restore(request.metadata, &request.credential);
                drop(creation);
                if result.is_err() {
                    // Restore the retained runtimes; their remote readiness must not
                    // hold the Domain loop or its stop signal after a failed import.
                    for ((site, domain, user), credential) in restart {
                        let permission = app.registry.lock().await.permission(&site).cloned();
                        if let Some(permission) = permission {
                            if let Err(error) = app.ensure_host(&site, &permission, domain, user, credential, "Piik App".into()).await {
                                eprintln!("App hosting restart: {error}");
                            }
                        }
                    }
                }
                let _ = request.result.send(result.map_err(|error| error.to_string()));
            }
        }
    };
    // Retire this origin's Native hosts while their domain can still acknowledge Leave.
    let hosts = {
        let mut registry = app.registry.lock().await;
        registry.local = None;
        permission.revoked.send_replace(true);
        let keys: Vec<_> = registry
            .hosts
            .keys()
            .filter(|(site, id, _)| *id == domain.identity().0 && domain.allows_origin(site))
            .cloned()
            .collect();
        keys.into_iter()
            .map(|key| registry.hosts.remove(&key).unwrap())
            .collect()
    };
    stop_hosts(hosts).await;
    stop_domain.send_replace(true);
    let domain_result = match finished_service {
        Some(result) => result,
        None => service.await,
    };
    if let Some(tunnel) = tunnel {
        if let Err(error) = tunnel.close().await {
            eprintln!("App tunnel cleanup: {error}");
        }
    }
    domain_result
        .map_err(|error| Failure::new("local-server", error))?
        .map_err(|error| Failure::new("local-server", error))?;
    result
}

async fn local_https(selected: Option<&str>, port: u16) -> Result<web::LanHttps, Failure> {
    let selected = selected.unwrap_or("");
    let addresses = web::lan_addresses().map_err(|error| Failure::new("local-network", error))?;
    if !addresses.iter().any(|entry| entry.address == selected) {
        return Err(Failure::new(
            "local-network",
            "Select an available local network address",
        ));
    }
    web::LanHttps::bind(
        selected
            .parse()
            .map_err(|error| Failure::new("local-network", error))?,
        port,
    )
    .await
    .map_err(|error| Failure::new("local-network", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn restore_keeps_host_creation_exclusive_without_holding_registry_reads() {
        use super::super::{host_task, CaptureTargetReader, Config, Desktop, Host, Registry};
        use futures_util::{SinkExt, StreamExt};
        use std::{
            collections::BTreeMap,
            io::Cursor,
            path::PathBuf,
            time::{Duration, Instant},
        };
        use tokio::sync::{oneshot, Mutex};
        use tokio_tungstenite::{
            connect_async,
            tungstenite::{client::IntoClientRequest, Message},
        };
        use uuid::Uuid;

        for reject in [false, true] {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let data = tempfile::tempdir().unwrap();
            std::fs::write(
                data.path().join("index.html"),
                "<html><head></head><body>Test</body></html>",
            )
            .unwrap();
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let app = Arc::new(App {
                config: Config {
                    data_root: data.path().into(),
                    assets: data.path().into(),
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
                token: "test".into(),
                host_creation: Default::default(),
                registry: Mutex::new(Registry {
                    sites: super::super::sites::Sites::open(data.path()).unwrap(),
                    approvals: BTreeMap::new(),
                    hosts: BTreeMap::new(),
                    local: None,
                }),
                closing: watch::channel(false).0,
                launch: Mutex::new(None),
                desktop: Desktop::new().unwrap(),
                voice_shortcuts: Default::default(),
                external_inputs: Default::default(),
                update: super::super::update::Owner::disabled(),
                capture_targets: CaptureTargetReader::default(),
                capture_microphones: CaptureTargetReader::default(),
            });
            let mut progress = begin(
                &app,
                Request {
                    mode: Mode::External,
                    port: NonZeroU16::new(port),
                    lan_address: None,
                    language: None,
                    public_origin: Some("https://restore.test".into()),
                },
            )
            .await
            .unwrap();
            let domain = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match progress.borrow().clone() {
                        Progress::Ready(ready) => break ready.domain,
                        Progress::Failed(_) => panic!("fixture domain failed"),
                        Progress::Starting => {}
                    }
                    progress.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
            let origin = domain.origin().to_owned();
            let owner_key = domain.owner_key();
            let mut join = format!("{}/prototype/channel", origin.replacen("http", "ws", 1))
                .into_client_request()
                .unwrap();
            join.headers_mut().insert("Origin", origin.parse().unwrap());
            let (mut socket, _) = connect_async(join).await.unwrap();
            socket
                .send(Message::Text(
                    json!({
                        "type":"join", "protocol":piik_channel_core::wire::CHANNEL_PROTOCOL,
                        "name":"Owner", "ownerKey":owner_key, "signingKey":vec![1u8; 32],
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            let credential = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let message = socket.next().await.unwrap().unwrap();
                    if let Message::Text(text) = message {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        if value["type"] == "welcome" {
                            break value["credential"].as_str().unwrap().to_owned();
                        }
                    }
                }
            })
            .await
            .unwrap();
            let client = reqwest::Client::new();
            let backup_url = format!("{origin}/prototype/channel/backup");
            let bytes = client
                .get(&backup_url)
                .bearer_auth(&credential)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .bytes()
                .await
                .unwrap();
            let staging = tempfile::tempdir().unwrap();
            let piik_channel_native::backup::StagedBackup::Domain(mut metadata) =
                piik_channel_native::backup::stage(Cursor::new(bytes), staging.path()).unwrap()
            else {
                panic!("domain backup expected")
            };
            metadata.owner_key = "restored-owner".into();
            let mut archive = vec![];
            piik_channel_native::backup::write_domain(&metadata, &mut archive).unwrap();
            let rejection = reject.then(|| {
                let database = rusqlite::Connection::open(data.path().join("domain/channel.sqlite")).unwrap();
                database.execute_batch("CREATE TRIGGER reject_restore BEFORE INSERT ON domain_user WHEN EXISTS(SELECT 1 FROM checkpoint WHERE instr(body, 'restored-owner') > 0) BEGIN SELECT RAISE(ABORT, 'restore_rejected'); END;").unwrap();
                database
            });

            let (stop, mut stopped) = watch::channel(false);
            let (retiring, entered) = oneshot::channel();
            let (release, release_join) = oneshot::channel();
            let (commands, _receiver) = mpsc::channel(1);
            let previous = Host {
                credential: credential.clone(),
                commands,
                ready: watch::channel(Some(Ok(()))).1,
                stop,
                task: host_task(tokio::spawn(async move {
                    stopped.changed().await.unwrap();
                    retiring.send(()).unwrap();
                    release_join.await.unwrap();
                    Ok(())
                })),
            };
            let permission = {
                let mut registry = app.registry.lock().await;
                registry.hosts.insert(
                    (origin.clone(), domain.identity().0, Uuid::new_v4()),
                    previous,
                );
                registry.permission(&origin).unwrap().clone()
            };
            let restore = tokio::spawn(async move {
                client
                    .put(backup_url)
                    .bearer_auth(&credential)
                    .header("Content-Type", "application/zip")
                    .body(archive)
                    .send()
                    .await
                    .unwrap()
            });
            tokio::time::timeout(Duration::from_secs(5), entered)
                .await
                .unwrap()
                .unwrap();
            let requested_at = Instant::now();
            let launcher = tokio::time::timeout(
                Duration::from_millis(200),
                super::super::launcher(State(app.clone())),
            )
            .await;
            let launcher_wait = requested_at.elapsed();
            assert_eq!(
                domain.owner_key(),
                owner_key,
                "retirement precedes authority replacement"
            );
            let creating_app = app.clone();
            let creating_origin = origin.clone();
            let identity = domain.identity();
            let mut creating = tokio::spawn(async move {
                creating_app
                    .ensure_host(
                        &creating_origin,
                        &permission,
                        identity.0,
                        Uuid::new_v4(),
                        "late-old-credential".into(),
                        "Pending host".into(),
                    )
                    .await
            });
            let creation_waits = tokio::time::timeout(Duration::from_millis(50), &mut creating)
                .await
                .is_err();
            release.send(()).unwrap();
            let response = tokio::time::timeout(Duration::from_secs(5), restore)
                .await
                .unwrap()
                .unwrap();
            let status = response.status();
            let created = tokio::time::timeout(Duration::from_secs(5), creating)
                .await
                .unwrap()
                .unwrap();
            let restored_key = domain.owner_key();
            drop(socket);
            app.shutdown().await;
            drop(rejection);

            assert!(
                creation_waits,
                "a new host must not start before the restore commits"
            );
            assert!(created.is_ok());
            assert_eq!(
                status,
                if reject {
                    reqwest::StatusCode::CONFLICT
                } else {
                    reqwest::StatusCode::OK
                }
            );
            assert_eq!(
                restored_key,
                if reject {
                    owner_key.as_str()
                } else {
                    "restored-owner"
                }
            );
            assert!(
                launcher.is_ok_and(|response| response.is_ok()),
                "launcher waited {launcher_wait:?} for Native retirement"
            );
            eprintln!("Launcher response while Native retirement was held: {launcher_wait:?}");
        }
    }

    #[test]
    fn startup_request_does_not_freeze_the_http_port_override() {
        let missing: Request = serde_json::from_value(json!({"mode":"local"})).unwrap();
        assert!(missing.port.is_none());
        let request: Request =
            serde_json::from_value(json!({"mode":"local", "port":8787})).unwrap();
        assert_eq!(request.port.unwrap().get(), 8787);
        let saved =
            serde_json::to_value(super::super::sites::StartupIntent::Owned(request)).unwrap();
        assert!(saved["value"].get("port").is_none());
        let restored: Request = serde_json::from_value(saved["value"].clone()).unwrap();
        assert!(restored.port.is_none());
        for port in [0, 65536] {
            assert!(
                serde_json::from_value::<Request>(json!({"mode":"local", "port":port})).is_err()
            );
        }
    }

    #[tokio::test]
    async fn ready_reports_the_current_invitation_certificate_and_preserves_it_on_restore() {
        let http = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let target = format!("http://{}/#piik-client=1", http.local_addr().unwrap());
        let data = tempfile::tempdir().unwrap();
        let domain = Domain::open(data.path(), Some("test-owner"), format!("http://{}", http.local_addr().unwrap()), None, vec![]).unwrap();
        let https = web::LanHttps::bind(Ipv4Addr::LOCALHOST.into(), 0)
            .await
            .unwrap();
        let fingerprint: String =
            ring::digest::digest(&ring::digest::SHA256, https.certificate.as_ref())
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02X}"))
                .collect();
        let certificate = json!({
            "origin": https.origin(),
            "sha256Fingerprint": fingerprint,
        });
        let ready = Ready::new(target.clone(), Some(&https), domain.clone());
        let post = json!(ready);
        assert_eq!(
            post,
            json!({"target": target, "localCertificate": certificate})
        );
        let mut get = json!({"sites": []});
        ready.describe(&mut get);
        assert_eq!(get["localCertificate"], post["localCertificate"]);
        assert_eq!(get["target"], post["target"]);
        assert_eq!(get["sites"], json!([]));

        let public = Ready::new(target, None, domain);
        assert_eq!(json!(public), json!({"target": public.target}));
        let mut get = json!({});
        public.describe(&mut get);
        assert_eq!(get, json!(public));
    }
}
