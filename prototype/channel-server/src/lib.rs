//! Domain I/O and explicit Server hosting composition.
pub mod domain;
pub mod web;

use domain::Domain;
use piik_channel_native::session::{self as native, Config, RoomFile};
use std::{future::Future, path::PathBuf};
use tokio::sync::watch;

/// Server owns its Native rooms for the explicitly started service lifetime.
pub async fn serve_server(
    listener: tokio::net::TcpListener,
    domain: Domain,
    directory: PathBuf,
    owner: String,
    routes: axum::Router,
    stop: impl Future<Output = ()>,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(directory.join("rooms"))?;
    let config = Config {
        url: format!("ws://{}/prototype/channel", listener.local_addr()?),
        origin: domain.origin().into(),
        name: domain.owner_name().unwrap_or_else(|| "Piik Server".into()),
        key: Some(owner),
        credential: None,
    };
    let rooms = [
        ("living", "Living room"),
        ("studio", "Studio"),
        ("quiet", "Quiet corner"),
    ]
    .into_iter()
    .map(|(id, name)| RoomFile {
        path: directory.join("rooms").join(format!("{id}.sqlite")),
        id: id.into(),
        name: name.into(),
    })
    .collect();
    let (stop_native, mut native_stopped) = watch::channel(false);
    let (stop_domain, mut domain_stopped) = watch::channel(false);
    let hosting = native::run(config, rooms, async {
        let _ = native_stopped.changed().await;
    });
    let mut service = tokio::spawn(domain.serve(listener, routes, async move {
        let _ = domain_stopped.changed().await;
    }));
    tokio::pin!(hosting, stop);
    let (result, finished_domain) = tokio::select! {
        _ = &mut stop => {
            let _ = stop_native.send(true);
            (hosting.await, None)
        }
        result = &mut hosting => (result.and_then(|()| Err(anyhow::anyhow!("Native hosting stopped unexpectedly"))), None),
        result = &mut service => {
            let _ = stop_native.send(true);
            let closed = hosting.await;
            (closed.and_then(|()| Err(anyhow::anyhow!("HTTP service stopped unexpectedly"))), Some(result))
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
