use anyhow::{Context, Result};
use piik_channel_prototype::app::{serve, Config};
use std::{env, path::PathBuf};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config {
        data_root: match env::var_os("PIIK_CHANNEL_APP_DATA_DIR") {
            Some(directory) => PathBuf::from(directory),
            None => dirs::data_local_dir()
                .context("No local application data directory")?
                .join("Piik")
                .join("channel-app"),
        },
        assets: PathBuf::from(
            env::var_os("PIIK_CHANNEL_APP_WEB_DIR").unwrap_or_else(|| "build/channel-web".into()),
        ),
        open_browser: env::var_os("PIIK_CHANNEL_APP_NO_BROWSER").is_none(),
        cloudflared: PathBuf::from(
            env::var_os("PIIK_CHANNEL_CLOUDFLARED").unwrap_or_else(|| "cloudflared".into()),
        ),
        ice_servers: piik_channel_prototype::ice_servers_from_environment()?,
    };
    anyhow::ensure!(
        config.assets.join("index.html").is_file(),
        "Build the shared channel Web interface first"
    );
    let listener = if let Ok(port) = env::var("PIIK_CHANNEL_APP_PORT") {
        TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port.parse::<u16>()?)).await?
    } else {
        let mut available = None;
        for port in 39721..=39730 {
            match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
                Ok(listener) => {
                    available = Some(listener);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
                Err(error) => return Err(error.into()),
            }
        }
        available.context("Piik App discovery ports are occupied")?
    };
    serve(listener, config, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}
