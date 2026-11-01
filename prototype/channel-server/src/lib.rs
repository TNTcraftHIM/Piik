//! Domain I/O and explicit App/Server hosting composition.
pub mod app;
mod backup;
pub mod domain;
pub mod web;

use domain::Domain;
use piik_channel_native::peer::server_udp::ServerUdp;
use piik_channel_native::session::{self as native, Config, Hosting, RoomFile};
use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{mpsc, watch};

pub(crate) fn room_directory(directory: &Path, identity: (uuid::Uuid, uuid::Uuid)) -> PathBuf {
    directory
        .join("rooms")
        .join(identity.0.to_string())
        .join(identity.1.to_string())
}

struct NativeService {
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl NativeService {
    fn start(
        domain: &Domain,
        address: std::net::SocketAddr,
        directory: &Path,
        udp: Arc<ServerUdp>,
        bootstrap: bool,
    ) -> anyhow::Result<Self> {
        let directory = room_directory(directory, domain.identity());
        std::fs::create_dir_all(&directory)?;
        let config = Config {
            url: format!("ws://{address}/prototype/channel"),
            origin: domain.origin().into(),
            name: domain.owner_name().unwrap_or_else(|| "Piik Server".into()),
            key: Some(domain.owner_key()),
            credential: None,
            server_udp: Some(udp),
        };
        let rooms = if bootstrap {
            [
                ("living", "Living room"),
                ("studio", "Studio"),
                ("quiet", "Quiet corner"),
            ]
            .into_iter()
            .map(|(id, name)| RoomFile {
                path: directory.join(format!("{id}.sqlite")),
                id: id.into(),
                name: name.into(),
            })
            .collect()
        } else {
            vec![]
        };
        let (commands, requests) = mpsc::channel(64);
        let management = Hosting {
            directory,
            identity: domain.identity(),
            commands: requests,
            ready: watch::channel(None).0,
            desktop: None,
        };
        domain.set_room_commands(Some(commands));
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(native::run_host(
            config,
            rooms,
            Some(management),
            async move {
                let _ = stopped.changed().await;
            },
        ));
        Ok(Self { stop, task })
    }

    async fn close(&mut self) -> anyhow::Result<()> {
        self.stop.send_replace(true);
        (&mut self.task).await?
    }
}

pub fn ice_servers_from_environment() -> anyhow::Result<Vec<serde_json::Value>> {
    match std::env::var("PIIK_CHANNEL_ICE_SERVERS") {
        Ok(value) => Ok(serde_json::from_str(&value)?),
        Err(std::env::VarError::NotPresent) => Ok(vec![serde_json::json!({ "urls": [
            "stun:stun.cloudflare.com:3478", "stun:stun.miwifi.com:3478", "stun:stun.chat.bilibili.com:3478"
        ] })]),
        Err(error) => Err(error.into()),
    }
}

/// Server owns its Native rooms for the explicitly started service lifetime.
pub async fn serve_server(
    listener: tokio::net::TcpListener,
    domain: Domain,
    directory: PathBuf,
    routes: axum::Router,
    udp: Arc<ServerUdp>,
    stop: impl Future<Output = ()>,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(directory.join("rooms"))?;
    for entry in std::fs::read_dir(directory.join("rooms"))? {
        anyhow::ensure!(entry?.path().extension().and_then(|value| value.to_str()) != Some("sqlite"),
            "unsupported_room_storage_layout: preserve rooms/*.sqlite and import supported room backups into the scoped room directory");
    }
    let address = listener.local_addr()?;
    let (commands, mut restores) = mpsc::channel::<domain::RestoreDomain>(1);
    let domain = domain.with_restores(commands);
    let mut hosting = NativeService::start(
        &domain,
        address,
        &directory,
        udp.clone(),
        domain.was_created(),
    )?;
    let (stop_domain, mut domain_stopped) = watch::channel(false);
    let mut service = tokio::spawn(domain.clone().serve(listener, routes, async move {
        let _ = domain_stopped.changed().await;
    }));
    tokio::pin!(stop);
    let (result, finished_domain) = loop {
        tokio::select! {
            _ = &mut stop => break (hosting.close().await, None),
            result = &mut hosting.task => break (result.map_err(anyhow::Error::from).and_then(|result| result)
                .and_then(|()| Err(anyhow::anyhow!("Native hosting stopped unexpectedly"))), None),
            result = &mut service => {
                let closed = hosting.close().await;
                break (closed.and_then(|()| Err(anyhow::anyhow!("HTTP service stopped unexpectedly"))), Some(result));
            }
            Some(request) = restores.recv() => {
                if request.result.is_closed() { continue; }
                if !domain.is_owner_credential(&request.credential) {
                    let _ = request.result.send(Err("forbidden".into()));
                    continue;
                }
                if let Err(error) = hosting.close().await {
                    let _ = request.result.send(Err(error.to_string()));
                    break (Err(error), None);
                }
                domain.set_room_commands(None);
                let result = domain.restore(request.metadata, &request.credential);
                // A failed durable replacement keeps the old authority and restarts
                // its same saved rooms; neither branch recreates missing histories.
                match NativeService::start(&domain, address, &directory, udp.clone(), false) {
                    Ok(next) => hosting = next,
                    Err(error) => {
                        let _ = request.result.send(Err(error.to_string()));
                        break (Err(error), None);
                    }
                }
                let _ = request.result.send(result.map_err(|error| error.to_string()));
            }
        }
    };
    // Native departure is acknowledged while the domain service is live.
    let _ = stop_domain.send(true);
    let domain_result = match finished_domain {
        Some(result) => result,
        None => service.await,
    };
    domain_result??;
    result
}
