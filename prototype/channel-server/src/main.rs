use piik_channel_prototype::{domain::Domain, serve_server, web};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port = std::env::var("PIIK_CHANNEL_PORT")
        .unwrap_or_else(|_| "8791".into())
        .parse::<u16>()
        .expect("PIIK_CHANNEL_PORT must be a port");
    let origin =
        std::env::var("PIIK_CHANNEL_WEB_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:8790".into());
    let owner = std::env::var("PIIK_CHANNEL_OWNER_KEY")
        .expect("Set PIIK_CHANNEL_OWNER_KEY to a private stable startup key");
    let invite = std::env::var("PIIK_CHANNEL_INVITE_KEY")
        .expect("Set PIIK_CHANNEL_INVITE_KEY to a separate stable invitation key");
    let ice_servers = std::env::var("PIIK_CHANNEL_ICE_SERVERS")
        .map(|value| {
            serde_json::from_str::<Vec<serde_json::Value>>(&value)
                .expect("PIIK_CHANNEL_ICE_SERVERS must be a JSON array")
        })
        .unwrap_or_default();
    let directory = std::env::var("PIIK_CHANNEL_DATA_DIR")
        .unwrap_or_else(|_| "build/channel-prototype-data".into());
    let directory = PathBuf::from(directory);
    let routes = match std::env::var_os("PIIK_CHANNEL_WEB_DIR") {
        Some(directory) => web::frontend(&PathBuf::from(directory))?,
        None => axum::Router::new(),
    };
    let state = Domain::open(&directory, &owner, &invite, origin.clone(), ice_servers)?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("Piik Rust channel prototype: http://127.0.0.1:{port}");
    println!(
        "Web interface: {origin}/__channel-preview (use your configured owner or invitation key)"
    );
    serve_server(listener, state, directory, owner, routes, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}
