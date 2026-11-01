use anyhow::{ensure, Context};
use piik_channel_native::peer::server_udp::ServerUdp;
use piik_channel_prototype::{domain::Domain, serve_server, web};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};

mod release;

#[tokio::main]
async fn main() -> anyhow::Result<std::process::ExitCode> {
    if let Some(endpoint) = release::check_argument(std::env::args().skip(1))? {
        let result = release::check_build(&endpoint);
        println!("{}", serde_json::to_string(&result)?);
        return Ok(std::process::ExitCode::from(result.exit_code()));
    }
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
    let owner = std::env::var("PIIK_CHANNEL_OWNER_KEY")
        .context("Set PIIK_CHANNEL_OWNER_KEY to a private stable startup key")?;
    let invite = std::env::var("PIIK_CHANNEL_INVITE_KEY")
        .context("Set PIIK_CHANNEL_INVITE_KEY to a separate stable invitation key")?;
    let ice_servers = piik_channel_prototype::ice_servers_from_environment()?;
    let executable = std::env::current_exe().context("Locate the Server executable")?;
    let resources = executable.parent().context("Locate the Server directory")?;
    let directory = std::env::var_os("PIIK_CHANNEL_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| resources.join("data"));
    let frontend = std::env::var_os("PIIK_CHANNEL_WEB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| resources.join("web"));
    let routes = web::frontend(&frontend)
        .with_context(|| format!("Load Server frontend from {}", frontend.display()))?;
    let listener = tokio::net::TcpListener::bind((address, port)).await?;
    let bound = listener.local_addr()?;
    let origin = std::env::var("PIIK_CHANNEL_WEB_ORIGIN")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{}", bound.port()));
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
    let addresses: Vec<IpAddr> = match std::env::var("PIIK_CHANNEL_UDP_BIND_ADDRESS") {
        Ok(value) => vec![value
            .parse()
            .context("PIIK_CHANNEL_UDP_BIND_ADDRESS must be a local IP")?],
        Err(std::env::VarError::NotPresent) => vec![
            std::net::Ipv4Addr::UNSPECIFIED.into(),
            std::net::Ipv6Addr::UNSPECIFIED.into(),
        ],
        Err(error) => return Err(error.into()),
    };
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
    let state = Domain::open(
        &directory,
        &owner,
        &invite,
        origin.clone(),
        invitation_origin,
        ice_servers,
    )?;
    println!("Piik Server: http://{bound}");
    println!(
        "Web interface: {origin}/__channel-preview (use your configured owner or invitation key)"
    );
    release::startup_notice();
    serve_server(listener, state, directory, owner, routes, udp, stop).await?;
    Ok(std::process::ExitCode::SUCCESS)
}
