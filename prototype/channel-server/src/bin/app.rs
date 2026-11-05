use anyhow::{Context, Result};
use piik_channel_prototype::app::{listen, serve, Config};
use std::{env, path::PathBuf};

fn main() -> Result<()> {
    #[cfg(target_os = "windows")]
    if piik_channel_native::capture::worker_entry()? {
        return Ok(());
    }
    let _capture_runtime = piik_channel_native::capture::Runtime::new()?;
    #[cfg(target_os = "macos")]
    return piik_channel_prototype::app_macos::run(run);
    #[cfg(not(target_os = "macos"))]
    run()
}

#[tokio::main]
async fn run(
    #[cfg(target_os = "macos")] quit: Option<tokio::sync::oneshot::Receiver<()>>,
    #[cfg(target_os = "macos")] ready: Option<tokio::sync::oneshot::Sender<String>>,
) -> Result<()> {
    let stop = piik_channel_native::shutdown_signal()?;
    #[cfg(target_os = "macos")]
    let stop = async move {
        match quit {
            Some(quit) => tokio::select! {
                _ = stop => {},
                _ = quit => {},
            },
            None => stop.await,
        }
    };
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
    let port = env::var("PIIK_CHANNEL_APP_PORT")
        .ok()
        .map(|port| port.parse())
        .transpose()?;
    let listener = listen(port).await?;
    #[cfg(not(target_os = "macos"))]
    let ready = None;
    serve(listener, config, stop, ready).await
}
