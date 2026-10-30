use anyhow::{bail, Context, Result};
use piik_channel_native::session::{run, Config, RoomFile};
use std::{env, path::PathBuf};

fn main() -> Result<()> {
    #[cfg(all(feature = "capture", target_os = "windows"))]
    if piik_channel_native::capture::worker_entry()? {
        return Ok(());
    }
    let _capture_runtime = piik_channel_native::capture::Runtime::new()?;
    run_native()
}
#[tokio::main]
async fn run_native() -> Result<()> {
    let stop = piik_channel_native::shutdown_signal()?;
    let mut args = env::args().skip(1);
    let mut rooms = Vec::new();
    while let Some(flag) = args.next() {
        if flag != "--room" {
            bail!("usage: piik-channel-native --room <database> <id> <name> [--room ...]");
        }
        rooms.push(RoomFile {
            path: PathBuf::from(args.next().context("missing room database path")?),
            id: args.next().context("missing room id")?,
            name: args.next().context("missing room name")?,
        });
    }
    if rooms.is_empty() {
        bail!("at least one --room is required");
    }
    let config = Config {
        url: env::var("CHANNEL_WS_URL").context("CHANNEL_WS_URL is required")?,
        origin: env::var("CHANNEL_UI_ORIGIN").context("CHANNEL_UI_ORIGIN is required")?,
        name: env::var("PIIK_CHANNEL_NATIVE_NAME").unwrap_or_else(|_| "Native Host".into()),
        key: env::var("PIIK_CHANNEL_NATIVE_KEY").ok(),
        credential: env::var("PIIK_CHANNEL_NATIVE_CREDENTIAL").ok(),
    };
    run(config, rooms, stop).await
}
