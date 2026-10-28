//! A Quick Tunnel is one owned cloudflared child; cloudflared owns reconnection.
use anyhow::{bail, Context, Result};
use std::{
    future::Future,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::{Child, Command},
    sync::oneshot,
    task::JoinHandle,
    time::timeout,
};
use url::Url;
use uuid::Uuid;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LOG_LINE: usize = 64 * 1024;

#[derive(Debug)]
pub struct Failure {
    pub reason: &'static str,
    detail: String,
}
impl Failure {
    fn new(reason: &'static str, detail: impl std::fmt::Display) -> Self {
        Self {
            reason,
            detail: detail.to_string(),
        }
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail)
    }
}
impl std::error::Error for Failure {}

pub struct Tunnel {
    origin: String,
    // Dropping an unfinished start or a live owner also wakes the child owner.
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<()>>>,
}

impl Tunnel {
    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub async fn wait(&mut self) -> Result<()> {
        let Some(task) = self.task.as_mut() else {
            return Ok(());
        };
        let result = task.await;
        self.task = None;
        result.context("public tunnel task failed")?
    }

    pub async fn close(mut self) -> Result<()> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.wait().await
    }
}

/// Cancellation covers acquisition. A returned tunnel is explicitly closed after
/// the caller has drained its local service, preserving ordered App shutdown.
pub async fn start(
    executable: &Path,
    local_origin: &str,
    cancelled: impl Future<Output = ()>,
) -> std::result::Result<Tunnel, Failure> {
    let origin = Url::parse(local_origin).map_err(|error| Failure::new("tunnel-start", error))?;
    let loopback = match origin.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if origin.scheme() != "http"
        || !loopback
        || origin.port_or_known_default() == Some(0)
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err(Failure::new(
            "tunnel-start",
            "invalid tunnel loopback origin",
        ));
    }

    let config = TemporaryConfig::new().map_err(|error| Failure::new("tunnel-start", error))?;
    let mut command = Command::new(executable);
    command
        .args(["tunnel", "--config"])
        .arg(&config.0)
        .args([
            "--no-autoupdate",
            "--loglevel",
            "info",
            "--output",
            "json",
            "--protocol",
            "auto",
            "--max-edge-addr-retries",
            "0",
            "--url",
            local_origin,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // An inherited named-tunnel selection must not replace this Quick Tunnel.
    for (key, _) in std::env::vars_os() {
        if key
            .to_str()
            .is_some_and(|key| key.to_ascii_uppercase().starts_with("TUNNEL_"))
        {
            command.env_remove(key);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|error| {
        Failure::new(
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) {
                "tunnel-unavailable"
            } else {
                "tunnel-start"
            },
            error,
        )
    })?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (ready, registered) = oneshot::channel();
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        let _config = config;
        let result = supervise(&mut child, stdout, stderr, ready, stopped).await;
        // Every exit (including malformed output and a dropped startup future)
        // joins the child before releasing its temporary configuration.
        if child.try_wait()?.is_none() {
            child.kill().await.context("public tunnel could not stop")?;
        }
        result
    });
    let mut tunnel = Tunnel {
        origin: String::new(),
        stop: Some(stop),
        task: Some(task),
    };
    let acquired = tokio::select! {
        biased;
        _ = cancelled => Err(Failure::new("tunnel-stopped", "public tunnel startup cancelled")),
        result = timeout(STARTUP_TIMEOUT, registered) => match result {
            Ok(Ok(origin)) => Ok(origin),
            Ok(Err(_)) => Err(Failure::new("tunnel-exited", "public tunnel exited before connecting")),
            Err(_) => Err(Failure::new("tunnel-timeout", "public tunnel did not connect within 30 seconds")),
        }
    };
    match acquired {
        Ok(origin) => {
            tunnel.origin = origin;
            Ok(tunnel)
        }
        Err(mut error) => {
            if let Err(cause) = tunnel.close().await {
                error.detail = format!("{}: {cause}", error.detail);
            }
            Err(error)
        }
    }
}

async fn supervise(
    child: &mut Child,
    stdout: impl AsyncRead + Unpin,
    stderr: impl AsyncRead + Unpin,
    ready: oneshot::Sender<String>,
    mut stopped: oneshot::Receiver<()>,
) -> Result<()> {
    let (mut stdout, mut stderr) = (BufReader::new(stdout), BufReader::new(stderr));
    // The other pipe winning select must not discard a partly read line.
    let (mut stdout_line, mut stderr_line) = (Vec::new(), Vec::new());
    let (mut stdout_closed, mut stderr_closed) = (false, false);
    let mut ready = Some(ready);
    let mut origin = None;
    let mut registered = false;
    loop {
        let line = tokio::select! {
            _ = &mut stopped => return Ok(()),
            status = child.wait() => bail!("public tunnel exited: {}", status?),
            line = log_line(&mut stdout, &mut stdout_line), if !stdout_closed => {
                let line = line?;
                stdout_closed = line.is_none();
                line
            },
            line = log_line(&mut stderr, &mut stderr_line), if !stderr_closed => {
                let line = line?;
                stderr_closed = line.is_none();
                line
            },
        };
        if let Some(line) = line {
            let entry = serde_json::from_str::<serde_json::Value>(&line).ok();
            let message = entry
                .as_ref()
                .and_then(|entry| entry.get("message"))
                .and_then(|message| message.as_str())
                .unwrap_or(&line);
            if origin.is_none() {
                origin = quick_origin(message);
            }
            registered |= message.contains("Registered tunnel connection");
            // Dependency output is consumed, not forwarded: it may include
            // credentials and private path identifiers as structured fields.
        }
        if registered && origin.is_some() && ready.is_some() {
            if let Some(status) = child.try_wait()? {
                bail!("public tunnel exited: {status}");
            }
            let _ = ready.take().unwrap().send(origin.take().unwrap());
        }
    }
}

async fn log_line(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    line: &mut Vec<u8>,
) -> Result<Option<String>> {
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(
                    String::from_utf8_lossy(&std::mem::take(line)).into_owned(),
                ))
            };
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|end| end + 1);
        let length = end.unwrap_or(buffer.len());
        if line.len() + length > MAX_LOG_LINE {
            bail!("public tunnel output line exceeds limit");
        }
        line.extend_from_slice(&buffer[..length]);
        reader.consume(length);
        if end.is_some() {
            return Ok(Some(
                String::from_utf8_lossy(&std::mem::take(line)).into_owned(),
            ));
        }
    }
}

fn quick_origin(message: &str) -> Option<String> {
    message.split_ascii_whitespace().find_map(|word| {
        let url = Url::parse(word).ok()?;
        let label = url.host_str()?.strip_suffix(".trycloudflare.com")?;
        if url.scheme() != "https"
            || label.is_empty()
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        Some(url.origin().ascii_serialization())
    })
}

struct TemporaryConfig(PathBuf);
impl TemporaryConfig {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("piik-quick-tunnel-{}.yml", Uuid::new_v4()));
        let config = Self(path);
        std::fs::write(&config.0, "metrics: 127.0.0.1:0\n")
            .context("public tunnel configuration could not be created")?;
        Ok(config)
    }
}
impl Drop for TemporaryConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
