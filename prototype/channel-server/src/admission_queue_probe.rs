//! Measurement only: how deep the hosted Native connection's 64-event queue gets
//! when many clients join at nearly the same time. Run with
//! `cargo test --release --lib admission_queue_probe -- --ignored --nocapture`.
use super::*;
use futures_util::{SinkExt, StreamExt};
use piik_channel_core::{conversation::SessionSigner, wire::CHANNEL_PROTOCOL};
use serde_json::json;
use std::{io::Write, net::SocketAddr};
use tokio::sync::{mpsc::error::TrySendError, oneshot};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};

struct Probe {
    created: Instant,
    max_depth: usize,
    sent: usize,
    host_inputs: usize,
    full_rejections: usize,
    first_full: Option<(Instant, String)>,
    host: bool,
    sender: mpsc::WeakSender<Event>,
    close: watch::Sender<bool>,
}

static PROBE: Mutex<BTreeMap<Uuid, Probe>> = Mutex::new(BTreeMap::new());

/// Called from `Hub::send` after each `try_send`, under the Hub lock.
pub(super) fn record(
    connection: Uuid,
    client: &Client,
    host_input: bool,
    sent: &Result<(), TrySendError<Event>>,
) {
    let sender = &client.events;
    let mut probe = PROBE.lock().unwrap();
    let entry = probe.entry(connection).or_insert_with(|| Probe {
        created: Instant::now(),
        max_depth: 0,
        sent: 0,
        host_inputs: 0,
        full_rejections: 0,
        first_full: None,
        host: false,
        sender: sender.downgrade(),
        close: client.close.clone(),
    });
    entry.host |= host_input;
    match sent {
        Ok(()) => {
            entry.sent += 1;
            entry.host_inputs += usize::from(host_input);
            entry.max_depth = entry
                .max_depth
                .max(sender.max_capacity() - sender.capacity())
        }
        Err(TrySendError::Full(event)) => {
            entry.full_rejections += 1;
            if entry.first_full.is_none() {
                let kind = serde_json::to_value(event).unwrap()["type"].to_string();
                entry.first_full = Some((Instant::now(), kind));
            }
            entry.max_depth = sender.max_capacity();
        }
        Err(TrySendError::Closed(_)) => {}
    }
}

fn host_depth() -> usize {
    PROBE
        .lock()
        .unwrap()
        .values()
        .filter(|probe| probe.host)
        .filter_map(|probe| probe.sender.upgrade())
        .map(|sender| sender.max_capacity() - sender.capacity())
        .max()
        .unwrap_or(0)
}

/// The live host queue is empty in three successive samples about 10 ms apart.
async fn settle(limit: Duration) -> bool {
    let end = Instant::now() + limit;
    let mut quiet = 0;
    while Instant::now() < end {
        if host_depth() == 0 {
            quiet += 1;
            if quiet >= 3 {
                return true;
            }
        } else {
            quiet = 0;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

const OWNER: &str = "owner";
const ORIGIN: &str = "http://localhost";
const LIMIT: Duration = Duration::from_secs(30);
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone, Copy, PartialEq)]
enum Pattern {
    Burst,
    Spread,
    Sequential,
    Kick,
}

async fn open(address: SocketAddr) -> Socket {
    let mut request = format!("ws://{address}/prototype/channel")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", ORIGIN.parse().unwrap());
    connect_async(request).await.unwrap().0
}

fn join(name: &str, owner: bool, index: usize) -> Message {
    let mut seed = [7u8; 32];
    seed[0] = index as u8;
    seed[1] = if owner { 0xff } else { 1 };
    Message::Text(
        json!({"type":"join","protocol":CHANNEL_PROTOCOL,"canUsePeerTransport":false,"name":name,
            "ownerKey":owner.then_some(OWNER),"signingKey":SessionSigner::from_seed(seed).signing_key()})
        .to_string()
        .into(),
    )
}

async fn next_event(socket: &mut Socket) -> Option<Event> {
    loop {
        match socket.next().await? {
            Ok(Message::Text(text)) => return Some(serde_json::from_str(&text).unwrap()),
            Ok(_) => continue,
            Err(_) => return None,
        }
    }
}

fn rooms_up(state: &piik_channel_core::wire::Snapshot, rooms: usize) -> bool {
    state.channel.rooms.len() >= rooms && state.channel.rooms.iter().all(|room| room.available)
}

async fn owner_state(socket: &mut Socket, rooms: usize) -> Uuid {
    let mut connection = None;
    tokio::time::timeout(LIMIT, async {
        loop {
            match next_event(socket).await.expect("owner socket") {
                Event::Welcome {
                    connection_id,
                    state,
                    ..
                } => {
                    connection = Some(connection_id);
                    if rooms_up(&state, rooms) {
                        break;
                    }
                }
                Event::State { state } if rooms_up(&state, rooms) => break,
                Event::Error { code, .. } => panic!("owner setup failed: {code}"),
                _ => {}
            }
        }
    })
    .await
    .expect("owner room state");
    connection.unwrap_or_default()
}

#[derive(Default)]
struct Outcome {
    host_max: usize,
    host_full: usize,
    host_connections: usize,
    ordinary_max: usize,
    owner_max: usize,
    admissions_ms: f64,
    settle_ms: Option<f64>,
    welcomed: usize,
    failed: usize,
    clients_closed: usize,
    reconnect_ms: Option<f64>,
    rooms_back_ms: Option<f64>,
    recovery_host_connections: usize,
    recovery_full: usize,
}

fn recovery_window() -> Duration {
    Duration::from_secs(
        std::env::var("PIIK_PROBE_RECOVERY_S")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(60),
    )
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

async fn drive(address: SocketAddr, rooms: usize, clients: usize, pattern: Pattern) -> Outcome {
    // Owner: wait for the three bootstrap rooms, then create the rest on the host.
    let mut owner = open(address).await;
    owner.send(join("Owner", true, 0)).await.unwrap();
    let owner_connection = owner_state(&mut owner, 3).await;
    let mut ready = rooms <= 3;
    for index in 3..rooms {
        let request = Uuid::new_v4().to_string();
        owner
            .send(Message::Text(
                json!({"type":"create_room","requestId":request,"room":{"id":"new",
                "name":format!("Room {index}"),"icon":"couch","creatorId":Uuid::nil(),
                "access":"public","hidden":false,"hasPassword":false}})
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(LIMIT, async {
            loop {
                match next_event(&mut owner).await.expect("owner socket") {
                    Event::RoomCreated { .. } => break,
                    Event::Error { code, .. } => panic!("creation failed: {code}"),
                    Event::State { state } => ready = rooms_up(&state, rooms),
                    _ => {}
                }
            }
        })
        .await
        .expect("room creation");
    }
    if !ready {
        owner_state(&mut owner, rooms).await;
    }
    assert!(settle(LIMIT).await, "host queue did not settle before the run");
    for probe in PROBE.lock().unwrap().values_mut() {
        probe.max_depth = 0;
    }

    let (stop, stopped) = watch::channel(false);
    let owner_seen = Arc::new(Mutex::new(Vec::<(Instant, bool)>::new()));
    let owner_task = {
        let seen = owner_seen.clone();
        let mut stopped = stopped.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    event = next_event(&mut owner) => match event {
                        Some(Event::State { state }) => seen.lock().unwrap().push((Instant::now(), rooms_up(&state, rooms))),
                        Some(_) => {}
                        None => break,
                    }
                }
            }
            let _ = owner.close(None).await;
        })
    };

    let mut go = Vec::new();
    let mut reports = Vec::new();
    let mut ready = Vec::new();
    let mut tasks = Vec::new();
    for index in 0..clients {
        let (go_send, go_receive) = oneshot::channel::<()>();
        let (report_send, report_receive) = oneshot::channel::<Result<Instant, String>>();
        let (ready_send, ready_receive) = oneshot::channel::<()>();
        go.push(go_send);
        reports.push(report_receive);
        ready.push(ready_receive);
        let mut stopped = stopped.clone();
        let delay = if pattern == Pattern::Spread {
            Duration::from_micros((Uuid::new_v4().as_u128() % 500_000) as u64)
        } else {
            Duration::ZERO
        };
        tasks.push(tokio::spawn(async move {
            let mut socket = if pattern == Pattern::Sequential {
                let _ = go_receive.await;
                open(address).await
            } else {
                let socket = open(address).await;
                let _ = ready_send.send(());
                let _ = go_receive.await;
                socket
            };
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            socket
                .send(join(&format!("Guest {index}"), false, index))
                .await
                .unwrap();
            let report = match tokio::time::timeout(LIMIT, next_event(&mut socket)).await {
                Ok(Some(Event::Welcome { .. })) => Ok(Instant::now()),
                Ok(Some(Event::Error { code, .. })) => Err(code),
                Ok(other) => Err(format!("unexpected {:?}", other.is_some())),
                Err(_) => Err("timeout".into()),
            };
            let _ = report_send.send(report);
            // Keep reading like a live client until the run ends.
            let closed_early = loop {
                tokio::select! {
                    _ = stopped.changed() => break false,
                    frame = socket.next() => if !matches!(frame, Some(Ok(_))) { break true },
                }
            };
            let _ = socket.close(None).await;
            closed_early
        }));
    }

    let mut outcome = Outcome::default();
    let mut last = None::<Instant>;
    let start;
    if matches!(pattern, Pattern::Sequential | Pattern::Kick) {
        start = Instant::now();
        for (go, report) in go.into_iter().zip(reports) {
            let _ = go.send(());
            match report.await.unwrap() {
                Ok(at) => {
                    outcome.welcomed += 1;
                    last = Some(at);
                }
                Err(_) => outcome.failed += 1,
            }
            settle(LIMIT).await;
        }
    } else {
        for ready in ready {
            let _ = ready.await;
        }
        start = Instant::now();
        for go in go {
            let _ = go.send(());
        }
        for report in reports {
            match report.await.unwrap() {
                Ok(at) => {
                    outcome.welcomed += 1;
                    last = Some(last.map_or(at, |last| last.max(at)));
                }
                Err(_) => outcome.failed += 1,
            }
        }
    }
    let last = last.unwrap_or(start);
    outcome.admissions_ms = ms(last - start);
    if settle(LIMIT).await {
        outcome.settle_ms = Some(ms(last.elapsed()));
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Admission-phase figures, before any forced close, recovery or departure.
    let first_close = {
        let probe = PROBE.lock().unwrap();
        for (connection, probe) in probe.iter() {
            if probe.host {
                outcome.host_connections += 1;
                outcome.host_max = outcome.host_max.max(probe.max_depth);
                outcome.host_full += probe.full_rejections;
            } else if *connection == owner_connection {
                outcome.owner_max = probe.max_depth;
            } else {
                outcome.ordinary_max = outcome.ordinary_max.max(probe.max_depth);
            }
        }
        if pattern == Pattern::Kick {
            for probe in probe.values() {
                if probe.host && probe.sender.upgrade().is_some() {
                    let _ = probe.close.send(true);
                }
            }
            Some(Instant::now())
        } else {
            probe
                .values()
                .filter(|probe| probe.host)
                .filter_map(|probe| probe.first_full.as_ref().map(|(at, _)| *at))
                .min()
        }
    };
    if let Some(closed) = first_close {
        // Recovery: a new connection receives events, and every room is up in the
        // owner's state for three seconds after the last host close.
        let end = closed + recovery_window();
        loop {
            let (reconnected, last_close) = {
                let probe = PROBE.lock().unwrap();
                let hosts = probe.values().filter(|probe| probe.host);
                let reconnected = hosts.clone().map(|probe| probe.created).filter(|at| *at > closed).min();
                let last_close = hosts
                    .filter_map(|probe| probe.first_full.as_ref().map(|(at, _)| *at))
                    .fold(closed, Instant::max);
                (reconnected, last_close)
            };
            if outcome.reconnect_ms.is_none() {
                outcome.reconnect_ms = reconnected.map(|at| ms(at - closed));
            }
            let up_since = {
                let seen = owner_seen.lock().unwrap();
                let mut since = None;
                for (at, up) in seen.iter().rev() {
                    if !*up || *at <= last_close {
                        break;
                    }
                    since = Some(*at);
                }
                since
            };
            if let Some(since) = up_since {
                if Instant::now() > since + Duration::from_secs(3) {
                    outcome.rooms_back_ms = Some(ms(since - closed));
                    break;
                }
            }
            if Instant::now() > end {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let probe = PROBE.lock().unwrap();
        for probe in probe.values().filter(|probe| probe.host && probe.created > closed) {
            outcome.recovery_host_connections += 1;
            outcome.recovery_full += probe.full_rejections;
        }
    }
    if std::env::var_os("PIIK_PROBE_TRACE").is_some() {
        let probe = PROBE.lock().unwrap();
        let mut hosts: Vec<_> = probe.values().filter(|probe| probe.host).collect();
        hosts.sort_by_key(|probe| probe.created);
        for probe in hosts {
            let offset = |at: Instant| {
                if at >= start {
                    format!("+{:.0}", ms(at - start))
                } else {
                    format!("-{:.0}", ms(start - at))
                }
            };
            println!(
                "TRACE host created {} ms, first full {}, sent {}, host inputs {}, full rejections {}, max depth {}",
                offset(probe.created),
                probe
                    .first_full
                    .as_ref()
                    .map_or("-".into(), |(at, kind)| format!("{} ms ({kind})", offset(*at))),
                probe.sent,
                probe.host_inputs,
                probe.full_rejections,
                probe.max_depth
            );
        }
    }

    let _ = stop.send(true);
    for task in tasks {
        if let Ok(Ok(true)) = tokio::time::timeout(Duration::from_secs(10), task).await {
            outcome.clients_closed += 1;
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(10), owner_task).await;
    outcome
}

fn list(name: &str, default: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_else(|_| default.into())
        .split(',')
        .map(|value| value.trim().to_owned())
        .collect()
}

#[test]
#[ignore = "measurement; run explicitly"]
fn admission_queue_probe() {
    let server = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let client = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    let rooms = list("PIIK_PROBE_R", "4,16,32");
    let clients = list("PIIK_PROBE_N", "8,30,60,120");
    let patterns = list("PIIK_PROBE_PATTERNS", "burst,spread,sequential");
    let repetitions: usize = std::env::var("PIIK_PROBE_REPS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5);
    let path = std::env::var("PIIK_PROBE_OUT")
        .unwrap_or_else(|_| "admission-queue-probe.csv".into());
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .unwrap();
    let header = "R,N,pattern,rep,host_max,host_full_rejections,host_connections,ordinary_max,owner_max,admissions_ms,settle_ms,welcomed,failed,clients_closed,host_reconnect_ms,rooms_back_ms,recovery_host_connections,recovery_full_rejections";
    writeln!(out, "{header}").unwrap();
    println!("{header}");
    for r in &rooms {
        for n in &clients {
            for pattern_name in &patterns {
                let pattern = match pattern_name.as_str() {
                    "burst" => Pattern::Burst,
                    "spread" => Pattern::Spread,
                    "sequential" => Pattern::Sequential,
                    "kick" => Pattern::Kick,
                    other => panic!("unknown pattern {other}"),
                };
                for rep in 0..repetitions {
                    PROBE.lock().unwrap().clear();
                    let folder = tempfile::tempdir().unwrap();
                    let (address, stop, task) = server.block_on(async {
                        let domain = Domain::open_with_options(
                            folder.path(),
                            OWNER,
                            ORIGIN.into(),
                            None,
                            vec![],
                            RoomCreationPolicy::Ordinary,
                            Some(HostingMode::Hosted),
                        )
                        .unwrap();
                        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                        let address = listener.local_addr().unwrap();
                        let udp = piik_channel_native::peer::server_udp::ServerUdp::bind(&[(
                            SocketAddr::new(address.ip(), 0),
                            None,
                        )])
                        .unwrap();
                        let (stop, stopped) = oneshot::channel::<()>();
                        let task = tokio::spawn(crate::serve_server(
                            listener,
                            domain,
                            folder.path().to_owned(),
                            Router::new(),
                            udp,
                            None,
                            async {
                                let _ = stopped.await;
                            },
                        ));
                        (address, stop, task)
                    });
                    let o = client.block_on(drive(
                        address,
                        r.parse().unwrap(),
                        n.parse().unwrap(),
                        pattern,
                    ));
                    let _ = stop.send(());
                    let _ = server.block_on(async {
                        tokio::time::timeout(Duration::from_secs(20), task).await
                    });
                    PROBE.lock().unwrap().clear();
                    let option = |value: Option<f64>| value.map_or("-".into(), |v| format!("{v:.1}"));
                    let line = format!(
                        "{r},{n},{pattern_name},{rep},{},{},{},{},{},{:.1},{},{},{},{},{},{},{},{}",
                        o.host_max,
                        o.host_full,
                        o.host_connections,
                        o.ordinary_max,
                        o.owner_max,
                        o.admissions_ms,
                        option(o.settle_ms),
                        o.welcomed,
                        o.failed,
                        o.clients_closed,
                        option(o.reconnect_ms),
                        option(o.rooms_back_ms),
                        o.recovery_host_connections,
                        o.recovery_full,
                    );
                    writeln!(out, "{line}").unwrap();
                    println!("{line}");
                }
            }
        }
    }
}
