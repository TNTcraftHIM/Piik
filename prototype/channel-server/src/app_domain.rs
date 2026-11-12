//! One App-owned domain, independent of launcher pages and approved remote sites.
#[path = "app_stun.rs"]
mod stun;

use super::{console::Console, stop_hosts, tunnel, ApiResult, App, Permission};
use crate::{domain::Domain, web};
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{future::pending, net::Ipv4Addr, sync::Arc};
use tokio::{
    net::{TcpListener, UdpSocket},
    sync::{mpsc, watch},
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
    Ready(Ready),
    Failed(Failure),
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    target: String,
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
    fn new(target: String, https: Option<&web::LanHttps>) -> Self {
        Self {
            target,
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
    language: Option<String>,
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
            Progress::Ready(ready) => ready.describe(state),
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
                let console = Console::new(request.language.as_deref());
                console.starting(matches!(request.mode, Mode::Link));
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
        current.as_ref().unwrap().progress.clone()
    };
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

async fn run(
    app: Arc<App>,
    request: Request,
    mut stopped: watch::Receiver<bool>,
    progress: &watch::Sender<Progress>,
    console: &Console,
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
    let saved_port = app
        .registry
        .lock()
        .await
        .sites
        .domain_port()
        .map_err(|error| Failure::new("configuration", error))?;
    let bind_address =
        std::net::SocketAddrV4::new(Ipv4Addr::LOCALHOST, saved_port.map_or(0, |port| port.get()));
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
    if saved_port.is_none() {
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
    let invitation = match (&https, &tunnel) {
        (Some(https), _) => https.origin(),
        (_, Some(tunnel)) => tunnel.origin(),
        _ => unreachable!(),
    }
    .to_owned();
    let domain = Domain::open(
        &app.config.data_root.join("domain"),
        &identity.owner,
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
    let mut ready = Ready::new(
        format!(
            "{origin}/?piik-client-port={}#owner={}&piik-client=1",
            app.port,
            domain.owner_key()
        ),
        https.as_ref(),
    );
    if let Some(certificate) = &ready.local_certificate {
        eprintln!("Local invitation entry: {}", certificate.origin);
        eprintln!("Certificate SHA-256: {}", certificate.sha256_fingerprint);
    }
    let permission = Arc::new(Permission::new(identity.namespace));
    app.registry.lock().await.local = Some((origin.clone(), permission.clone()));
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
    console.ready(&invitation);
    progress.send_replace(Progress::Ready(ready.clone()));
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
                // Keep the existing creation gate through shutdown and replacement.
                // Remote approved sites with another authority keep their own hosts.
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
                stop_hosts(hosts).await;
                let result = domain.restore(request.metadata, &request.credential);
                drop(registry);
                if result.is_ok() {
                    ready.target = format!(
                        "{origin}/?piik-client-port={}#owner={}&piik-client=1", app.port, domain.owner_key()
                    );
                    progress.send_replace(Progress::Ready(ready.clone()));
                } else {
                    for ((site, domain, user), credential) in restart {
                        let permission = app.registry.lock().await.permission(&site).cloned();
                        if let Some(permission) = permission {
                            if let Err(error) = app.hello(&site, &permission, domain, user, credential, "Piik App".into()).await {
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
    async fn ready_reports_the_current_invitation_certificate_and_preserves_it_on_restore() {
        let http = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let target = format!("http://{}/#owner=before", http.local_addr().unwrap());
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
        let mut ready = Ready::new(target.clone(), Some(&https));
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

        ready.target = format!("http://{}/#owner=after", http.local_addr().unwrap());
        assert_ne!(json!(ready)["target"], post["target"]);
        assert_eq!(json!(ready)["localCertificate"], certificate);
        let public = Ready::new("http://127.0.0.1:12345/#owner=public".into(), None);
        assert_eq!(json!(public), json!({"target": public.target}));
        let mut get = json!({});
        public.describe(&mut get);
        assert_eq!(get, json!(public));
    }
}
