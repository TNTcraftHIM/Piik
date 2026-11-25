use anyhow::{ensure, Context};
use piik_channel_core::{
    host::TransitKinds,
    wire::{HostingMode, RoomCreationPolicy},
};
use piik_channel_native::peer::server_udp::ServerUdp;
use piik_channel_prototype::{domain::Domain, listener_client_address, serve_server, web};
use serde::de::{value::StrDeserializer, DeserializeOwned};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};

mod owner_link;
mod release;

fn switch(key: &str, default: bool) -> anyhow::Result<bool> {
    match std::env::var(key) {
        Ok(value) if value == "true" => Ok(true),
        Ok(value) if value == "false" => Ok(false),
        Err(std::env::VarError::NotPresent) => Ok(default),
        _ => anyhow::bail!("{key} must be true or false"),
    }
}

fn first_start_setting<T: DeserializeOwned>(key: &str, default: T) -> anyhow::Result<T> {
    match std::env::var(key) {
        Ok(value) => T::deserialize(StrDeserializer::<serde::de::value::Error>::new(&value))
            .with_context(|| format!("Invalid {key}")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("Read {key}")),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<std::process::ExitCode> {
    let executable = std::env::current_exe().context("Locate the Server executable")?;
    let resources = executable.parent().context("Locate the Server directory")?;
    let directory = std::env::var_os("PIIK_CHANNEL_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| resources.join("data"));
    if std::env::args().skip(1).eq(["owner-link"]) {
        println!("{}", owner_link::request(&directory).await?);
        return Ok(std::process::ExitCode::SUCCESS);
    }
    if let Some(endpoint) = release::check_argument(std::env::args().skip(1))? {
        let result = release::check_build(&endpoint).await;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(std::process::ExitCode::from(result.exit_code()));
    }
    ensure!(
        std::env::var_os("PIIK_ENV").is_none(),
        "Detected Piik 2.x configuration (PIIK_ENV). Use the matching 2.x image or start 3.0 with its own configuration and data directory."
    );
    let room_creation_policy = first_start_setting(
        "PIIK_CHANNEL_ROOM_CREATION_POLICY",
        RoomCreationPolicy::Ordinary,
    )?;
    let hosting_mode = first_start_setting("PIIK_CHANNEL_HOSTING_MODE", HostingMode::Lightweight)?;
    // The master switch offers every kind; the operator can turn one kind off.
    let kinds = TransitKinds {
        screen: switch("PIIK_CHANNEL_SERVICE_TRANSIT_SCREEN", true)?,
        voice: switch("PIIK_CHANNEL_SERVICE_TRANSIT_VOICE", true)?,
        files: switch("PIIK_CHANNEL_SERVICE_TRANSIT_FILES", true)?,
    };
    let transit = switch("PIIK_CHANNEL_SERVICE_TRANSIT", false)?.then_some(kinds);
    let stop = piik_channel_native::shutdown_signal()?;
    let port = std::env::var("PIIK_CHANNEL_PORT")
        .unwrap_or_else(|_| "8791".into())
        .parse::<u16>()
        .context("PIIK_CHANNEL_PORT must be a port")?;
    let address = std::env::var("PIIK_CHANNEL_BIND_ADDRESS")
        .unwrap_or_else(|_| "127.0.0.1".into())
        .parse::<IpAddr>()
        .context("PIIK_CHANNEL_BIND_ADDRESS must be an IP address")?;
    let invitation_origin = std::env::var("PIIK_CHANNEL_INVITATION_ORIGIN").ok();
    // Existing domain data owns its keys; environment values seed a new domain.
    let owner = std::env::var("PIIK_CHANNEL_OWNER_KEY").unwrap_or_default();
    let ice_servers = piik_channel_prototype::ice_servers_from_environment()?;
    let frontend = std::env::var_os("PIIK_CHANNEL_WEB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| resources.join("web"));
    let routes = web::frontend(&frontend)
        .with_context(|| format!("Load Server frontend from {}", frontend.display()))?;
    let listener = tokio::net::TcpListener::bind((address, port)).await?;
    let bound = listener.local_addr()?;
    let origin = std::env::var("PIIK_CHANNEL_WEB_ORIGIN")
        .unwrap_or_else(|_| format!("http://{}", listener_client_address(bound)));
    let udp_port = std::env::var("PIIK_CHANNEL_UDP_PORT")
        .ok()
        .map(|value| value.parse::<u16>())
        .transpose()
        .context("PIIK_CHANNEL_UDP_PORT must be a port")?
        .unwrap_or(bound.port());
    ensure!(
        udp_port != 0,
        "PIIK_CHANNEL_UDP_PORT must be a fixed nonzero port"
    );
    let mut addresses: Vec<IpAddr> = match std::env::var("PIIK_CHANNEL_UDP_BIND_ADDRESS") {
        Ok(value) => {
            ensure!(
                !value.is_empty(),
                "PIIK_CHANNEL_UDP_BIND_ADDRESS must not be empty"
            );
            tokio::net::lookup_host((value.as_str(), udp_port))
                .await
                .context("Resolve PIIK_CHANNEL_UDP_BIND_ADDRESS to a local IP")?
                .map(|address| address.ip())
                .collect()
        }
        Err(std::env::VarError::NotPresent) => vec![
            std::net::Ipv4Addr::UNSPECIFIED.into(),
            std::net::Ipv6Addr::UNSPECIFIED.into(),
        ],
        Err(error) => return Err(error.into()),
    };
    addresses.sort_unstable();
    addresses.dedup();
    ensure!(
        !addresses.is_empty(),
        "PIIK_CHANNEL_UDP_BIND_ADDRESS resolved to no IP addresses"
    );
    let advertised = std::env::var("PIIK_CHANNEL_UDP_PUBLIC_ADDRESS")
        .ok()
        .map(|value| value.parse::<SocketAddr>())
        .transpose()
        .context("PIIK_CHANNEL_UDP_PUBLIC_ADDRESS must be an IP:port")?;
    ensure!(
        advertised.is_none_or(|external| addresses
            .iter()
            .any(|ip| ip.is_ipv4() == external.is_ipv4())),
        "UDP public address has no listener of its family"
    );
    let bindings: Vec<_> = addresses
        .into_iter()
        .map(|ip| {
            (
                SocketAddr::new(ip, udp_port),
                advertised.filter(|external| external.is_ipv4() == ip.is_ipv4()),
            )
        })
        .collect();
    let udp = ServerUdp::bind(&bindings)?;
    let state = Domain::open_with_options(
        &directory,
        &owner,
        origin.clone(),
        invitation_origin,
        ice_servers,
        room_creation_policy,
        Some(hosting_mode),
    )?;
    let operator = owner_link::Listener::bind(&directory)?;
    println!("Piik Server: http://{bound}");
    println!("Web interface: {origin}/");
    release::startup_notice();
    let operator_domain = state.clone();
    let (stop_server, operator_stopped) = tokio::sync::oneshot::channel();
    let server = serve_server(listener, state, directory, routes, udp, transit, async {
        tokio::select! {
            _ = stop => {},
            _ = operator_stopped => {},
        }
    });
    tokio::pin!(server);
    tokio::select! {
        result = owner_link::serve(operator, &operator_domain) => {
            let _ = stop_server.send(());
            let shutdown = server.await;
            result.context("Serve the local owner link")?;
            shutdown?;
        }
        result = &mut server => result?,
    }
    Ok(std::process::ExitCode::SUCCESS)
}
