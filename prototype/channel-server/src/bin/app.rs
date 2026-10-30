use anyhow::{Context, Result};
use piik_channel_prototype::app::{serve, Config};
use std::{env, path::PathBuf};
use tokio::net::TcpListener;

fn main() -> Result<()> {
    #[cfg(target_os = "windows")]
    if piik_channel_native::capture::worker_entry()? {
        return Ok(());
    }
    let _capture_runtime = piik_channel_native::capture::Runtime::new()?;
    run()
}

#[tokio::main]
async fn run() -> Result<()> {
    let executable = env::current_exe().context("Locate the App executable")?;
    let resources = executable.parent().context("Locate the App directory")?;
    let config = Config {
        data_root: match env::var_os("PIIK_CHANNEL_APP_DATA_DIR") {
            Some(directory) => PathBuf::from(directory),
            None => dirs::data_local_dir()
                .context("No local application data directory")?
                .join("Piik")
                .join("channel-app"),
        },
        assets: env::var_os("PIIK_CHANNEL_APP_WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| resources.join("web")),
        open_browser: env::var_os("PIIK_CHANNEL_APP_NO_BROWSER").is_none(),
        cloudflared: env::var_os("PIIK_CHANNEL_CLOUDFLARED")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                resources
                    .join("runtime")
                    .join("tunnel")
                    .join(format!("cloudflared{}", env::consts::EXE_SUFFIX))
            }),
        ice_servers: piik_channel_prototype::ice_servers_from_environment()?,
    };
    anyhow::ensure!(
        config.assets.join("index.html").is_file(),
        "App frontend is missing: {}",
        config.assets.join("index.html").display()
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
