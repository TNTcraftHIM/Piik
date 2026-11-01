//! One App-owned domain, independent of launcher pages and approved remote sites.
#[path = "app_stun.rs"]
mod stun;

use super::{stop_hosts, tunnel, ApiResult, App, Permission};
use crate::{domain::Domain, web};
use axum::{extract::State, http::StatusCode, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{future::pending, net::Ipv4Addr, sync::Arc};
use tokio::{
    net::{TcpListener, UdpSocket},
    sync::watch,
    task::JoinHandle,
};

#[derive(Clone)]
struct Failure {
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
enum Progress {
    Starting,
    Ready(String),
    Failed(Failure),
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

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Local,
    Link,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    mode: Mode,
    lan_address: Option<String>,
    #[serde(rename = "language")]
    _language: Option<String>,
}

pub(super) async fn describe(app: &App, state: &mut Value) -> anyhow::Result<()> {
    let addresses = web::lan_addresses()?;
    let selected = addresses
        .first()
        .map(|entry| entry.address.as_str())
        .unwrap_or("");
    state["lan"] = json!({ "addresses": addresses, "selected": selected });
    if let Some(launch) = app.launch.lock().await.as_ref() {
        match &*launch.progress.borrow() {
            Progress::Starting => state["starting"] = json!(true),
            Progress::Ready(target) => state["target"] = json!(target),
            Progress::Failed(failure) => {
                state["reason"] = json!(failure.reason);
                state["detail"] = json!(failure.detail);
            }
        }
    }
    Ok(())
}

pub(super) async fn launch(State(app): State<Arc<App>>, Json(request): Json<Request>) -> ApiResult {
    let mut progress = {
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
                if let Err(failure) = run(owner, request, stopped, &progress).await {
                    eprintln!("App startup {}: {}", failure.reason, failure.detail);
                    progress.send_replace(Progress::Failed(failure));
                }
            });
            *current = Some(Launch {
                progress: receiver,
                stop,
                task,
            });
        }
        current.as_ref().unwrap().progress.clone()
    };
    // The App owns startup. Closing this HTTP request only stops this wait.
    loop {
        match progress.borrow().clone() {
            Progress::Ready(target) => return Ok(Json(json!({ "target": target }))),
            Progress::Failed(failure) => return Err(failure.response()),
            Progress::Starting => {}
        }
        if progress.changed().await.is_err() {
            return Err(Failure::new("local-server", "The local service stopped").response());
        }
    }
}

async fn run(
    app: Arc<App>,
    request: Request,
    mut stopped: watch::Receiver<bool>,
    progress: &watch::Sender<Progress>,
) -> Result<(), Failure> {
    let routes =
        web::frontend(&app.config.assets).map_err(|error| Failure::new("configuration", error))?;
    let identity = app
        .registry
        .lock()
        .await
        .sites
        .local_identity()
        .map_err(|error| Failure::new("configuration", error))?;
    let http = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| Failure::new("local-port", error))?;
    let address = http
        .local_addr()
        .map_err(|error| Failure::new("local-port", error))?;
    let origin = format!("http://{address}");
    let https = if matches!(request.mode, Mode::Local) {
        Some(local_https(request.lan_address.as_deref(), address.port()).await?)
    } else {
        None
    };
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
    let invitation = match (&https, &tunnel) {
        (Some(https), _) => https.origin(),
        (_, Some(tunnel)) => tunnel.origin(),
        _ => unreachable!(),
    };
    let domain = Domain::open(
        &app.config.data_root.join("domain"),
        &identity.owner,
        &identity.invite,
        origin.clone(),
        Some(invitation.to_owned()),
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
    if let Some(https) = &https {
        eprintln!("Local invitation entry: {}", https.origin());
        eprintln!("Certificate SHA-256: {}", https.fingerprint());
    }
    let permission = Arc::new(Permission::new(identity.namespace));
    app.registry.lock().await.local = Some((origin.clone(), permission.clone()));
    let owner_key = domain.owner_key();
    let (stop_domain, mut domain_stopped) = watch::channel(false);
    let mut service = tokio::spawn(domain.serve_with_https(http, https, routes, async move {
        let _ = domain_stopped.changed().await;
    }));
    progress.send_replace(Progress::Ready(format!(
        "{origin}/?piik-client-port={}#owner={}&piik-client=1",
        app.port, owner_key
    )));
    let (result, finished_service) = tokio::select! {
        _ = stopped.changed() => (Ok(()), None),
        result = &mut service => (Err(Failure::new("local-server", "The local service stopped")), Some(result)),
        result = async {
            match &stun {
                Some(socket) => stun::serve(socket).await,
                None => pending().await,
            }
        } => (Err(Failure::new("local-network", result.err().map(|error| error.to_string())
            .unwrap_or_else(|| "Local discovery stopped".into()))), None),
        result = async {
            match tunnel.as_mut() {
                Some(tunnel) => tunnel.wait().await,
                None => pending().await,
            }
        } => (Err(Failure::new("tunnel-stopped", result.err().map(|error| error.to_string())
            .unwrap_or_else(|| "The public invitation service stopped".into()))), None),
    };
    // Retire this origin's Native hosts while their domain can still acknowledge Leave.
    let hosts = {
        let mut registry = app.registry.lock().await;
        registry.local = None;
        permission.revoked.send_replace(true);
        let keys: Vec<_> = registry
            .hosts
            .keys()
            .filter(|(site, ..)| site == &origin)
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
