//! Kernel network lab process boundary: production Domain, room session and NativePeers.
//! No pair, candidate, SDP, preparation deadline or readiness is manufactured here.
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use piik_channel_core::{
    conversation::SessionSigner,
    wire::{Command, Event},
};
use piik_channel_native::{
    peer::{NativeEvent, NativePeers},
    session::{self, Config, RoomFile},
};
use piik_channel_prototype::domain::Domain;
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{mpsc, watch},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};
use uuid::Uuid;

#[path = "../src/app_stun.rs"]
mod app_stun;
const ORIGIN: &str = "http://198.51.100.1:9000";
const ROOM: &str = "kernel-lab-room";
const OWNER: &str = "owned-kernel-lab-owner";
const INVITE: &str = "owned-kernel-lab-invite";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
fn emit(value: Value) {
    println!(
        "{}",
        json!({"atMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(), "event": value})
    );
}
async fn stop() {
    let _ = tokio::signal::ctrl_c().await;
}
async fn send(socket: &mut Socket, command: Command) -> Result<()> {
    socket
        .send(Message::Text(serde_json::to_string(&command)?.into()))
        .await?;
    Ok(())
}
async fn domain(path: PathBuf) -> Result<()> {
    let ice = vec![
        json!({"urls":["stun:198.51.100.1:3478","stun:198.51.100.1:3479","stun:198.51.100.1:3480"],"username":"","credential":""}),
    ];
    let listener = TcpListener::bind((
        "0.0.0.0",
        std::env::var("PIIK_CHANNEL_PORT")
            .unwrap_or_else(|_| "9000".into())
            .parse::<u16>()?,
    ))
    .await?;
    let domain = Domain::open(&path, OWNER, INVITE, ORIGIN.into(), None, ice)?;
    let mut services = Vec::new();
    for port in [3478, 3479, 3480] {
        let socket = UdpSocket::bind(("198.51.100.1", port)).await?;
        services.push(tokio::spawn(async move { app_stun::serve(&socket).await }));
    }
    emit(json!({"type":"domain-ready"}));
    let result = domain.serve(listener, axum::Router::new(), stop()).await;
    for service in services {
        service.abort();
        let _ = service.await;
    }
    result
}
async fn host(path: PathBuf) -> Result<()> {
    std::fs::create_dir_all(&path)?;
    session::run(
        Config {
            url: format!("{}/prototype/channel", ORIGIN.replace("http:", "ws:")),
            origin: ORIGIN.into(),
            name: "Kernel Native host".into(),
            key: Some(OWNER.into()),
            credential: None,
            server_udp: None,
        },
        vec![RoomFile {
            path: path.join("room.sqlite"),
            id: ROOM.into(),
            name: "Kernel room".into(),
        }],
        stop(),
    )
    .await
}
async fn participant() -> Result<()> {
    let mut seed = [0; 32];
    SystemRandom::new()
        .fill(&mut seed)
        .map_err(|_| anyhow::anyhow!("session key generation failed"))?;
    let signer = SessionSigner::from_seed(seed);
    let mut request =
        format!("{}/prototype/channel", ORIGIN.replace("http:", "ws:")).into_client_request()?;
    request.headers_mut().insert("Origin", ORIGIN.parse()?);
    let (mut socket, _) = connect_async_with_config(request, None, true).await?;
    // This bridge has the same Native UDP preparation implementation and a real default interface.
    let can_prepare_udp = tokio::task::spawn_blocking(netwatch::interfaces::HomeRouter::new)
        .await?
        .and_then(|router| router.my_ip)
        .is_some_and(|ip| ip.is_ipv4());
    send(
        &mut socket,
        Command::Join {
            name: "Kernel Native reader".into(),
            credential: None,
            key: Some(INVITE.into()),
            session_id: None,
            room_id: None,
            signing_key: signer.signing_key(),
            can_prepare_udp,
            can_receive_video_layers: true,
        },
    )
    .await?;
    let (commands, mut events) = mpsc::channel(1024);
    let (snapshots, snapshot) = watch::channel(None);
    let mut peers: Option<NativePeers> = None;
    let mut local = Uuid::nil();
    let mut browsing = false;
    let stopped = stop();
    tokio::pin!(stopped);
    let result = async {
        loop { tokio::select! {
            _ = &mut stopped => break,
            event = events.recv(), if peers.is_some() => match event.context("Native event owner closed")? {
                NativeEvent::Command(command) => {
                    let value = serde_json::to_value(&command)?;
                    if value["type"] == "signal" {
                        let signal = &value["payload"];
                        emit(json!({"type":"native-signal", "pairId":value["pairId"],
                            "udp":signal["udp"]["type"], "prediction":signal["udp"]["prediction"],
                            "description":signal["description"]["type"], "candidate":signal.get("candidate").is_some()}));
                    } else { emit(json!({"type":"native-command", "command":value})); }
                    send(&mut socket, command).await?;
                }
                NativeEvent::Conversation { .. } => {
                    // This probe owns transport/media only. Normal-session history
                    // and file-control acceptance remains in the ordinary control.
                    emit(json!({"type":"unhandled-probe-conversation"}));
                }
                NativeEvent::CaptureEnded { .. } => bail!("unexpected capture in transport-only participant"),
            },
            frame = socket.next() => {
                let text = match frame.context("domain closed")?? {
                    Message::Text(text) => text,
                    Message::Ping(bytes) => { socket.send(Message::Pong(bytes)).await?; continue; }
                    Message::Pong(_) => continue,
                    _ => bail!("domain ended signaling"),
                };
                let state = match serde_json::from_str::<Event>(&text)? {
                    Event::Welcome { session_id, state, .. } => {
                        local = session_id;
                        let ice = state.ice_servers.iter().cloned().map(serde_json::from_value).collect::<std::result::Result<Vec<_>, _>>()?;
                        peers = Some(NativePeers::with_input(local, ice, commands.clone(), snapshot.clone(), None, None));
                        emit(json!({"type":"admitted", "sessionId":local, "canPrepareUdp":can_prepare_udp}));
                        Some(state)
                    }
                    Event::State { state } => Some(state),
                    Event::Signal { pair_id, payload, .. } => {
                        peers.as_ref().context("signal before admission")?.signal(pair_id, payload).await?; None
                    }
                    Event::Error { code, .. } => bail!("domain rejected operation: {code}"),
                    _ => None,
                };
                if let Some(state) = state {
                    emit(json!({"type":"plan", "pairs":state.pairs.iter().map(|p| json!({"id":p.id,"peerId":p.peer_id,"preparation":p.udp_preparation,"rooms":p.rooms})).collect::<Vec<_>>()}));
                    snapshots.send_replace(Some(state.clone()));
                    peers.as_ref().unwrap().update(state.pairs, state.publications, state.files).await?;
                    if !browsing && state.channel.rooms.iter().any(|room| room.id == ROOM && room.available && room.authorized) {
                        send(&mut socket, Command::Browse { room_id: ROOM.into(), active: true }).await?; browsing = true;
                    }
                }
            }
        }}
        Ok::<_, anyhow::Error>(())
    }.await;
    snapshots.send_replace(None);
    if let Some(peers) = peers {
        peers.close().await?;
    }
    let _ = send(&mut socket, Command::Leave).await;
    let _ = socket.close(None).await;
    emit(json!({"type":"participant-closed", "sessionId":local}));
    result
}
#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::args().nth(1).context("mode required")?;
    let path = PathBuf::from(std::env::args().nth(2).unwrap_or_default());
    let result = match mode.as_str() {
        "domain" => domain(path).await,
        "host" => host(path).await,
        "participant" => participant().await,
        _ => bail!("unknown bridge mode"),
    };
    emit(
        json!({"type":"process-closed", "mode":mode,"ok":result.is_ok(),"error":result.as_ref().err().map(ToString::to_string)}),
    );
    result
}
