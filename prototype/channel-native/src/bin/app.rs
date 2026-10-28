use anyhow::{Context, Result};
use piik_channel_native::app::{serve, Config};
use std::{env, path::PathBuf};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config {
        allowed_origin: env::var("PIIK_CHANNEL_APP_ORIGIN")
            .context("PIIK_CHANNEL_APP_ORIGIN is required")?,
        data_root: PathBuf::from(
            env::var("PIIK_CHANNEL_APP_DATA_DIR")
                .context("PIIK_CHANNEL_APP_DATA_DIR is required")?,
        ),
        channel_id: env::var("PIIK_CHANNEL_APP_CHANNEL_ID")
            .context("PIIK_CHANNEL_APP_CHANNEL_ID is required")?
            .parse()?,
        user_id: env::var("PIIK_CHANNEL_APP_USER_ID")
            .context("PIIK_CHANNEL_APP_USER_ID is required")?
            .parse()?,
        token: env::var("PIIK_CHANNEL_APP_TOKEN").context("PIIK_CHANNEL_APP_TOKEN is required")?,
    };
    let port: u16 = env::var("PIIK_CHANNEL_APP_PORT")
        .unwrap_or_else(|_| "18997".into())
        .parse()?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    eprintln!("App room socket listening on {}", listener.local_addr()?);
    serve(listener, config, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}
