//! HTTP boundary tests for current Host admission; no GUI or real identities.
use super::*;
use crate::app::{host_task, sites, update, whip, Config, Host, Permission, Registry};
use axum::{
    routing::{get, put},
    Router,
};
use piik_channel_native::{input::Desktop, session::HostingDescription};
use std::{collections::BTreeMap, net::SocketAddr, path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, watch, Mutex},
    task::JoinHandle,
    time::timeout,
};

const LIMIT: Duration = Duration::from_secs(2);
const SITE: &str = "https://owned.test";

struct Fixture {
    _directory: tempfile::TempDir,
    app: Arc<App>,
    address: SocketAddr,
    domain: Uuid,
    user: Uuid,
    ready: watch::Sender<Option<Result<(), String>>>,
    stopped: watch::Sender<bool>,
    permission: Arc<Permission>,
    commands: mpsc::Sender<HostCommand>,
    inputs: mpsc::Receiver<HostCommand>,
    stop_server: oneshot::Sender<()>,
    server: JoinHandle<()>,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let domain = Uuid::new_v4();
        let user = Uuid::new_v4();
        let permission = Arc::new(Permission::new(Uuid::new_v4()));
        let (commands, inputs) = mpsc::channel(8);
        let (ready, admitted) = watch::channel(None);
        let (stopped, mut stopping) = watch::channel(false);
        let host = Host {
            credential: "owned-credential".into(),
            commands: commands.clone(),
            ready: admitted,
            stop: stopped.clone(),
            task: host_task(tokio::spawn(async move {
                let _ = stopping.wait_for(|value| *value).await;
                Ok(())
            })),
        };
        let app = Arc::new(App {
            config: Config {
                data_root: directory.path().into(),
                assets: directory.path().into(),
                open_browser: false,
                terminal_notice: None,
                page_player: None,
                website_permission_reset: None,
                window_navigation: None,
                cloudflared: PathBuf::new(),
                ice_servers: vec![],
                update: Default::default(),
            },
            port: address.port(),
            token: "owned-token".into(),
            host_creation: Default::default(),
            registry: Mutex::new(Registry {
                sites: sites::Sites::open(directory.path()).unwrap(),
                approvals: BTreeMap::from([(SITE.into(), permission.clone())]),
                hosts: BTreeMap::from([((SITE.into(), domain, user), host)]),
                local: None,
            }),
            closing: watch::channel(false).0,
            launch: Mutex::new(None),
            desktop: Desktop::new().unwrap(),
            external_inputs: whip::Inputs::default(),
            capture_targets: Default::default(),
            capture_microphones: Default::default(),
            voice_shortcuts: Default::default(),
            update: update::Owner::disabled(),
        });
        let router = Router::new()
            .route("/rooms/{domain}/{user}/hosting", get(describe))
            .route("/rooms/{domain}/{user}/{room}/backup", get(export))
            .route("/rooms/{domain}/{user}/backup", put(restore))
            .with_state(app.clone());
        let (stop_server, server_stopped) = oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = server_stopped.await;
                })
                .await
                .unwrap();
        });
        Self {
            _directory: directory,
            app,
            address,
            domain,
            user,
            ready,
            stopped,
            permission,
            commands,
            inputs,
            stop_server,
            server,
        }
    }

    async fn request(&self) -> TcpStream {
        self.request_path("GET", "hosting").await
    }

    async fn request_path(&self, method: &str, path: &str) -> TcpStream {
        let mut socket = TcpStream::connect(self.address).await.unwrap();
        socket.write_all(format!(
            "{method} /rooms/{}/{}/{path} HTTP/1.1\r\nHost: {}\r\nOrigin: {SITE}\r\nAuthorization: Bearer owned-token\r\nX-Piik-Credential: owned-credential\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            self.domain, self.user, self.address
        ).as_bytes()).await.unwrap();
        socket
    }

    async fn waiters(&self, count: usize) {
        timeout(LIMIT, async {
            while self.ready.receiver_count() != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    async fn describe_reply(&mut self) -> oneshot::Sender<Result<HostingDescription, String>> {
        match timeout(LIMIT, self.inputs.recv()).await.unwrap().unwrap() {
            HostCommand::Describe(reply) => reply,
            _ => panic!("description must not create or mutate a room"),
        }
    }

    async fn finish(self) {
        timeout(LIMIT, self.app.shutdown()).await.unwrap();
        let _ = self.stop_server.send(());
        timeout(LIMIT, self.server).await.unwrap().unwrap();
    }
}

async fn response(mut socket: TcpStream) -> String {
    let mut value = String::new();
    timeout(LIMIT, socket.read_to_string(&mut value))
        .await
        .unwrap()
        .unwrap();
    value
}

#[tokio::test]
async fn concurrent_descriptions_follow_current_admission_without_recreating_the_host() {
    let mut fixture = Fixture::new().await;
    // Backup operations stay fail-fast while current admission is absent; only
    // the read-only description waits for Native recovery.
    for (method, path) in [("GET", "owned-room/backup"), ("PUT", "backup")] {
        let denied = response(fixture.request_path(method, path).await).await;
        assert!(denied.starts_with("HTTP/1.1 403"), "{denied}");
        assert!(fixture.inputs.try_recv().is_err());
    }
    let first = fixture.request().await;
    let second = fixture.request().await;
    fixture.waiters(3).await;
    assert!(fixture.inputs.try_recv().is_err());
    fixture.ready.send_replace(Some(Ok(())));
    let old_first = fixture.describe_reply().await;
    let old_second = fixture.describe_reply().await;
    // One old success arrives late; the other query is consumed after admission
    // loss. Both HTTP operations await the current owner without polling.
    fixture.ready.send_replace(None);
    assert!(old_first
        .send(Ok(HostingDescription {
            session_id: Uuid::new_v4(),
            room_ids: vec!["retired-room".into()],
            unavailable: vec![],
        }))
        .is_ok());
    assert!(old_second.send(Err("hosting_unavailable".into())).is_ok());
    assert!(timeout(Duration::from_millis(25), fixture.inputs.recv())
        .await
        .is_err());
    let current = Uuid::new_v4();
    fixture.ready.send_replace(Some(Ok(())));
    for _ in 0..2 {
        assert!(fixture
            .describe_reply()
            .await
            .send(Ok(HostingDescription {
                session_id: current,
                room_ids: vec!["owned-room".into()],
                unavailable: vec![],
            }))
            .is_ok());
    }
    for socket in [first, second] {
        let reply = response(socket).await;
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        let body: serde_json::Value =
            serde_json::from_str(reply.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["sessionId"], current.to_string());
        assert_eq!(body["roomIds"], serde_json::json!(["owned-room"]));
    }
    fixture.waiters(1).await;
    {
        let registry = fixture.app.registry.lock().await;
        assert_eq!(registry.hosts.len(), 1);
        let host = registry.hosts.values().next().unwrap();
        assert!(host.commands.same_channel(&fixture.commands));
        assert!(!host.finished());
        assert!(!*host.stop.borrow());
    }
    fixture.finish().await;
}

#[tokio::test]
async fn cancelled_http_wait_releases_only_itself_and_owner_retirement_releases_the_rest() {
    let fixture = Fixture::new().await;
    let cancelled = fixture.request().await;
    let sibling = fixture.request().await;
    fixture.waiters(3).await;
    drop(cancelled);
    fixture.waiters(2).await;
    assert!(!*fixture.stopped.borrow());
    assert!(!fixture
        .app
        .registry
        .lock()
        .await
        .hosts
        .values()
        .next()
        .unwrap()
        .finished());
    fixture.stopped.send_replace(true);
    let reply = response(sibling).await;
    assert!(reply.starts_with("HTTP/1.1 503"), "{reply}");
    fixture.waiters(1).await;
    fixture.finish().await;

    let fixture = Fixture::new().await;
    let revoked = fixture.request().await;
    fixture.waiters(2).await;
    fixture.permission.revoked.send_replace(true);
    let reply = response(revoked).await;
    assert!(reply.starts_with("HTTP/1.1 403"), "{reply}");
    fixture.waiters(1).await;
    assert!(!*fixture.stopped.borrow());
    fixture.finish().await;
}
