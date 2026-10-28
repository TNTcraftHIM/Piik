//! A local management connection starts the App's shared native room host.
use crate::session::{self, Hosting, OpenRoom};
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use piik_channel_core::RoomState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{future::Future, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, watch, Mutex},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{Request as Upgrade, Response},
        http::StatusCode,
        protocol::WebSocketConfig,
        Message,
    },
};
use uuid::Uuid;

const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST_BYTES: usize = 256 * 1024;

pub struct Config {
    pub allowed_origin: String,
    pub data_root: PathBuf,
    pub channel_id: Uuid,
    pub user_id: Uuid,
    pub token: String,
}

struct Host {
    credential: String,
    commands: mpsc::Sender<OpenRoom>,
    ready: watch::Receiver<Option<Result<(), String>>>,
    stop: watch::Sender<bool>,
    task: JoinHandle<Result<()>>,
}
struct App {
    config: Config,
    host: Mutex<Option<Host>>,
}
impl App {
    async fn hello(
        &self,
        channel: Uuid,
        user: Uuid,
        credential: String,
        name: String,
    ) -> Result<mpsc::Sender<OpenRoom>> {
        if (channel, user) != (self.config.channel_id, self.config.user_id) {
            bail!("owner_mismatch");
        }
        let mut hosting = self.host.lock().await;
        if hosting.as_ref().is_some_and(|host| host.task.is_finished()) {
            let _ = hosting.take().unwrap().task.await;
        }
        if let Some(host) = hosting.as_ref() {
            if host.credential != credential {
                bail!("owner_mismatch");
            }
        } else {
            let (commands, receiver) = mpsc::channel(64);
            let (ready, admitted) = watch::channel(None);
            let (stop, mut stopped) = watch::channel(false);
            let config = session::Config {
                url: format!(
                    "{}/prototype/channel",
                    self.config.allowed_origin.replacen("http", "ws", 1)
                ),
                origin: self.config.allowed_origin.clone(),
                name,
                credential: Some(credential.clone()),
                key: None,
            };
            let management = Hosting {
                directory: self.config.data_root.clone(),
                identity: (channel, user),
                commands: receiver,
                ready,
            };
            let task = tokio::spawn(session::run_host(
                config,
                vec![],
                Some(management),
                async move {
                    let _ = stopped.changed().await;
                },
            ));
            *hosting = Some(Host {
                credential,
                commands,
                ready: admitted,
                stop,
                task,
            });
        }
        let host = hosting.as_ref().unwrap();
        let commands = host.commands.clone();
        let mut ready = host.ready.clone();
        drop(hosting);
        timeout(IO_TIMEOUT, async {
            loop {
                let result = ready.borrow().clone();
                if let Some(result) = result {
                    return result.map_err(anyhow::Error::msg);
                }
                ready
                    .changed()
                    .await
                    .map_err(|_| anyhow!("hosting_unavailable"))?;
            }
        })
        .await??;
        Ok(commands)
    }
}

#[derive(Deserialize)]
struct Request {
    id: String,
    #[serde(flatten)]
    operation: Operation,
}
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Operation {
    Hello {
        channel_id: Uuid,
        user_id: Uuid,
        credential: String,
        name: String,
    },
    Open {
        policy: String,
    },
}

/// Page sockets manage one shared host; only stopping this service retires it.
pub async fn serve(
    listener: TcpListener,
    config: Config,
    stop: impl Future<Output = ()>,
) -> Result<()> {
    if !listener.local_addr()?.ip().is_loopback() {
        bail!("App room socket requires a loopback listener");
    }
    let origin: tokio_tungstenite::tungstenite::http::Uri = config.allowed_origin.parse()?;
    if !matches!(origin.scheme_str(), Some("http" | "https"))
        || origin.authority().is_none()
        || origin.path() != "/"
        || origin.query().is_some()
        || config.allowed_origin
            != format!(
                "{}://{}",
                origin.scheme_str().unwrap(),
                origin.authority().unwrap()
            )
    {
        bail!("App origin must be an exact HTTP or HTTPS origin");
    }
    if config.token.is_empty()
        || !config
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("App instance token must contain only letters, digits, '-' or '_'");
    }
    let app = Arc::new(App {
        config,
        host: Mutex::new(None),
    });
    let (closing, _) = watch::channel(false);
    let mut connections = JoinSet::new();
    tokio::pin!(stop);
    let result = loop {
        tokio::select! {
            _ = &mut stop => break Ok(()),
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let app = app.clone();
                    let mut closed = closing.subscribe();
                    connections.spawn(async move {
                        tokio::select! {
                            _ = closed.changed() => {},
                            _ = connection(stream, &app) => {},
                        }
                    });
                }
                Err(error) => break Err(error.into()),
            },
            _ = connections.join_next(), if !connections.is_empty() => {},
        }
    };
    closing.send_replace(true);
    while connections.join_next().await.is_some() {}
    if let Some(host) = app.host.lock().await.take() {
        let admitted = matches!(*host.ready.borrow(), Some(Ok(())));
        host.stop.send_replace(true);
        let closed = host.task.await?;
        if admitted {
            closed?;
        }
    }
    result
}

async fn connection(stream: TcpStream, app: &App) -> Result<()> {
    let protocol = format!("piik-channel-rooms.{}", app.config.token);
    let upgrade = |request: &Upgrade, mut response: Response| {
        let admitted = request.uri().path() == "/rooms"
            && request.uri().query().is_none()
            && request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
                == Some(app.config.allowed_origin.as_str())
            && request
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.split(',').any(|value| value.trim() == protocol));
        if !admitted {
            let mut rejection = tokio_tungstenite::tungstenite::http::Response::new(Some(
                "App connection not authorized".into(),
            ));
            *rejection.status_mut() = StatusCode::FORBIDDEN;
            return Err(rejection);
        }
        response
            .headers_mut()
            .insert("sec-websocket-protocol", protocol.parse().unwrap());
        Ok(response)
    };
    let options = WebSocketConfig::default()
        .max_message_size(Some(MAX_REQUEST_BYTES))
        .max_frame_size(Some(MAX_REQUEST_BYTES));
    let mut socket = timeout(
        IO_TIMEOUT,
        accept_hdr_async_with_config(stream, upgrade, Some(options)),
    )
    .await??;
    let mut host = None;
    loop {
        let message = if host.is_some() {
            socket.next().await
        } else {
            timeout(IO_TIMEOUT, socket.next()).await?
        };
        let Some(message) = message else { break };
        let text = match message? {
            Message::Text(text) => text,
            Message::Close(_) => {
                timeout(IO_TIMEOUT, socket.flush()).await??;
                break;
            }
            Message::Ping(_) | Message::Pong(_) => {
                timeout(IO_TIMEOUT, socket.flush()).await??;
                continue;
            }
            _ => bail!("App requests must be text"),
        };
        let value: Value = serde_json::from_str(&text)?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 256);
        let response = match (id, serde_json::from_value::<Request>(value.clone())) {
            (Some(_), Ok(request)) => {
                let result: Result<Value> = match request.operation {
                    Operation::Hello {
                        channel_id,
                        user_id,
                        credential,
                        name,
                    } => {
                        if host.is_some() {
                            Err(anyhow!("already_initialized"))
                        } else {
                            match app.hello(channel_id, user_id, credential, name).await {
                                Ok(commands) => {
                                    host = Some(commands);
                                    Ok(Value::Null)
                                }
                                Err(error) => Err(error),
                            }
                        }
                    }
                    Operation::Open { policy } => {
                        if let Some(commands) = &host {
                            open(commands, &policy).await
                        } else {
                            Err(anyhow!("hello_required"))
                        }
                    }
                };
                match result {
                    Ok(result) => json!({"id":request.id,"result":result}),
                    Err(error) => json!({"id":request.id,"error":error.to_string()}),
                }
            }
            _ => json!({"id":id,"error":"invalid_request"}),
        };
        timeout(
            IO_TIMEOUT,
            socket.send(Message::Text(response.to_string().into())),
        )
        .await??;
    }
    Ok(())
}

async fn open(commands: &mpsc::Sender<OpenRoom>, policy: &str) -> Result<Value> {
    let policy: RoomState = serde_json::from_str(policy)?;
    let (result, opened) = oneshot::channel();
    commands
        .send(OpenRoom { policy, result })
        .await
        .map_err(|_| anyhow!("hosting_unavailable"))?;
    Ok(serde_json::to_value(
        opened
            .await
            .map_err(|_| anyhow!("hosting_unavailable"))?
            .map_err(anyhow::Error::msg)?,
    )?)
}
