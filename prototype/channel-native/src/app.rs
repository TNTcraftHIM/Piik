//! Local room execution delegated by one startup-authorized Browser owner.
use crate::hosted_room::HostedRoom;
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use piik_channel_core::{conversation::SignedPacket, host::HostInput, RoomState, StoredRoomHost};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    future::Future,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::watch,
    task::JoinSet,
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
    Hello { channel_id: Uuid, user_id: Uuid },
    Policies,
    Open { policy: String },
    Summary { room_id: Uuid },
    Readers { room_id: Uuid },
    Bind { room_id: Uuid, binding_id: Uuid },
    Dispatch { room_id: Uuid, input: HostInput },
    Peer { room_id: Uuid, packet: SignedPacket },
    CloseRoom { room_id: Uuid },
}

/// The supplied listener is loopback-only; stopping waits for connection-owned
/// room runtimes and their file locks to be released.
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
    // The token is supplied locally, never minted from Browser request data.
    if config.token.is_empty()
        || !config
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("App instance token must contain only letters, digits, '-' or '_'");
    }
    std::fs::create_dir_all(&config.data_root)?;
    let config = Arc::new(config);
    let (closing, _) = watch::channel(false);
    let mut connections = JoinSet::new();
    tokio::pin!(stop);
    let result = loop {
        tokio::select! {
            _ = &mut stop => break Ok(()),
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let config = config.clone();
                    let mut closed = closing.subscribe();
                    connections.spawn(async move {
                        tokio::select! {
                            _ = closed.changed() => {},
                            _ = connection(stream, &config) => {},
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
    result
}

async fn connection(stream: TcpStream, config: &Config) -> Result<()> {
    let protocol = format!("piik-channel-rooms.{}", config.token);
    let upgrade = |request: &Upgrade, mut response: Response| {
        let admitted = request.uri().path() == "/rooms"
            && request.uri().query().is_none()
            && request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
                == Some(config.allowed_origin.as_str())
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
    let mut rooms = BTreeMap::new();
    let mut admitted = false;
    loop {
        let message = if admitted {
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
        let request = serde_json::from_value::<Request>(value.clone());
        let response = match (id, request) {
            (Some(_), Ok(request)) => {
                let result = if let Operation::Hello {
                    channel_id,
                    user_id,
                } = request.operation
                {
                    if admitted {
                        Err(anyhow!("already_initialized"))
                    } else if channel_id != config.channel_id || user_id != config.user_id {
                        Err(anyhow!("owner_mismatch"))
                    } else {
                        admitted = true;
                        Ok(Value::Null)
                    }
                } else if !admitted {
                    Err(anyhow!("hello_required"))
                } else {
                    execute(config, &mut rooms, request.operation)
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

fn execute(
    config: &Config,
    rooms: &mut BTreeMap<Uuid, HostedRoom>,
    operation: Operation,
) -> Result<Value> {
    match operation {
        Operation::Policies => {
            let mut paths = std::fs::read_dir(&config.data_root)?
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<std::io::Result<Vec<_>>>()?;
            paths.sort();
            let mut policies = Vec::new();
            for path in paths {
                if path.extension().and_then(|extension| extension.to_str()) != Some("sqlite") {
                    continue;
                }
                let Some(id) = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .and_then(|stem| Uuid::parse_str(stem).ok())
                else {
                    continue;
                };
                let host =
                    StoredRoomHost::open(&path).map_err(|error| anyhow!(error.to_string()))?;
                check_policy(config, host.policy())?;
                if host.policy().id != id.to_string() {
                    bail!("room_identity_mismatch");
                }
                policies.push(serde_json::to_string(host.policy())?);
            }
            Ok(serde_json::to_value(policies)?)
        }
        Operation::Open { policy } => {
            let policy: RoomState = serde_json::from_str(&policy)?;
            let id = check_policy(config, &policy)?;
            if !rooms.contains_key(&id) {
                let path = config.data_root.join(format!("{id}.sqlite"));
                let host = if path.try_exists()? {
                    HostedRoom::open(&path, &policy.id, config.user_id)?
                } else {
                    HostedRoom::create(&path, policy)?
                };
                rooms.insert(id, host);
            }
            Ok(json!(id))
        }
        Operation::Summary { room_id } => {
            Ok(serde_json::to_value(room(rooms, room_id)?.summary())?)
        }
        Operation::Readers { room_id } => Ok(json!(room(rooms, room_id)?.current_readers())),
        Operation::Bind {
            room_id,
            binding_id,
        } => {
            room(rooms, room_id)?.bind(binding_id)?;
            Ok(Value::Null)
        }
        Operation::Dispatch { room_id, input } => Ok(serde_json::to_value(
            room(rooms, room_id)?
                .dispatch(input)
                .map_err(anyhow::Error::msg)?,
        )?),
        Operation::Peer { room_id, packet } => {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)?
                .as_millis()
                .try_into()?;
            Ok(serde_json::to_value(
                room(rooms, room_id)?
                    .dispatch_peer(&packet, now)
                    .map_err(anyhow::Error::msg)?
                    .replies()
                    .map_err(anyhow::Error::msg)?,
            )?)
        }
        Operation::CloseRoom { room_id } => {
            rooms.remove(&room_id);
            Ok(Value::Null)
        }
        Operation::Hello { .. } => unreachable!(),
    }
}

fn check_policy(config: &Config, policy: &RoomState) -> Result<Uuid> {
    if policy.creator_id != config.user_id {
        bail!("owner_mismatch");
    }
    let id = Uuid::parse_str(&policy.id)?;
    if id.to_string() != policy.id {
        bail!("invalid_room_id");
    }
    Ok(id)
}

fn room(rooms: &mut BTreeMap<Uuid, HostedRoom>, id: Uuid) -> Result<&mut HostedRoom> {
    rooms.get_mut(&id).ok_or_else(|| anyhow!("room_not_open"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use piik_channel_core::wire::RoomAccess;
    use tokio::sync::oneshot;
    use tokio_tungstenite::{
        connect_async, tungstenite::client::IntoClientRequest, MaybeTlsStream, WebSocketStream,
    };

    type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

    async fn request(socket: &mut Socket, mut value: Value) -> Value {
        value["id"] = json!("request");
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
        let text = timeout(IO_TIMEOUT, socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[tokio::test]
    async fn authorized_socket_owns_saved_room_until_close_or_service_stop() {
        let root = std::env::temp_dir().join(format!("piik-app-{}", Uuid::new_v4()));
        let channel = Uuid::new_v4();
        let user = Uuid::new_v4();
        let id = Uuid::new_v4();
        let binding = Uuid::new_v4();
        let config = Config {
            allowed_origin: "https://site.example".into(),
            data_root: root.clone(),
            channel_id: channel,
            user_id: user,
            token: "test-instance".into(),
        };
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel();
        let service = tokio::spawn(serve(listener, config, async {
            let _ = stopped.await;
        }));
        let upgrade = |origin: &str| {
            let mut request = format!("ws://{address}/rooms")
                .into_client_request()
                .unwrap();
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
            request.headers_mut().insert(
                "sec-websocket-protocol",
                "piik-channel-rooms.test-instance".parse().unwrap(),
            );
            request
        };
        assert!(connect_async(upgrade("https://other.example"))
            .await
            .is_err());
        let (mut socket, _) = connect_async(upgrade("https://site.example"))
            .await
            .unwrap();
        let wrong = request(
            &mut socket,
            json!({"type":"hello","channelId":channel,"userId":Uuid::new_v4()}),
        )
        .await;
        assert_eq!(wrong["error"], "owner_mismatch");
        assert_eq!(
            request(&mut socket, json!({"type":"policies"})).await["error"],
            "hello_required"
        );
        assert!(request(
            &mut socket,
            json!({"type":"hello","channelId":channel,"userId":user})
        )
        .await
        .get("result")
        .is_some());
        let policy = RoomState::new(
            id.to_string(),
            "Saved".into(),
            user,
            RoomAccess::Private,
            true,
            None,
        )
        .unwrap();
        let policy = serde_json::to_string(&policy).unwrap();
        assert_eq!(
            request(&mut socket, json!({"type":"open","policy":policy})).await["result"],
            id.to_string()
        );
        let path = root.join(format!("{id}.sqlite"));
        assert!(
            HostedRoom::open(&path, &id.to_string(), user).is_err(),
            "live socket holds actual file lock"
        );
        assert!(request(
            &mut socket,
            json!({"type":"bind","roomId":id,"bindingId":binding})
        )
        .await
        .get("result")
        .is_some());
        let input = HostInput {
            now: 1,
            binding_id: binding,
            host_session_id: Uuid::new_v4(),
            revision: 1,
            endpoints: BTreeMap::new(),
            action: piik_channel_core::host::HostAction::Sync,
        };
        assert_eq!(
            request(
                &mut socket,
                json!({"type":"dispatch","roomId":id,"input":input})
            )
            .await["result"]["bindingId"],
            binding.to_string()
        );
        assert!(
            request(&mut socket, json!({"type":"close_room","roomId":id}))
                .await
                .get("result")
                .is_some()
        );
        drop(HostedRoom::open(&path, &id.to_string(), user).unwrap());
        assert_eq!(
            request(&mut socket, json!({"type":"policies"})).await["result"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        request(&mut socket, json!({"type":"open","policy":policy})).await;
        assert_eq!(
            request(&mut socket, json!({"type":"summary","roomId":id})).await["result"]["name"],
            "Saved"
        );
        assert_eq!(
            request(&mut socket, json!({"type":"readers","roomId":id})).await["result"],
            json!([])
        );
        socket.close(None).await.unwrap();
        // Drain to EOF before another connection opens the same saved room.
        timeout(IO_TIMEOUT, async { while socket.next().await.is_some() {} })
            .await
            .unwrap();
        let (mut next, _) = connect_async(upgrade("https://site.example"))
            .await
            .unwrap();
        request(
            &mut next,
            json!({"type":"hello","channelId":channel,"userId":user}),
        )
        .await;
        assert_eq!(
            request(&mut next, json!({"type":"open","policy":policy})).await["result"],
            id.to_string()
        );
        stop.send(()).unwrap();
        timeout(IO_TIMEOUT, service)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        drop(HostedRoom::open(&path, &id.to_string(), user).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}
