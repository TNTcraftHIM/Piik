use super::*;
#[cfg(windows)]
use axum::http::StatusCode;
use axum::{
    body::{Body, Bytes},
    extract::State as AxumState,
    response::Response,
    routing::get,
    Router,
};
use ring::{
    digest,
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{
    fs,
    io::Write,
    ops::RangeInclusive,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

const SOURCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn cancel_after_a_disconnected_request_still_waits_for_the_worker() {
    let (commands, mut incoming) = mpsc::channel(1);
    let owner = Owner {
        state: Arc::new(Mutex::new(State::Idle)),
        commands: Some(commands),
        version: Some("v3.0.0".into()),
        ..Owner::disabled()
    };
    let operation_id = owner
        .request(Request::Download {
            version: "v3.0.1".into(),
            revision: SOURCE.into(),
        })
        .await
        .unwrap()
        .operation_id
        .unwrap();
    let work = incoming.recv().await.unwrap();
    let cancel = || owner.request(Request::Cancel { operation_id });
    {
        let mut disconnected = Box::pin(cancel());
        assert!(futures_util::poll!(&mut disconnected).is_pending());
    }
    let mut retry = Box::pin(cancel());
    assert!(futures_util::poll!(&mut retry).is_pending());
    *owner.state.lock().unwrap() = State::Idle;
    drop(work);
    assert_eq!(retry.await.unwrap().state, "idle");
}

#[test]
fn signed_update_metadata_accepts_new_descriptive_fields() {
    let key = Ed25519KeyPair::from_pkcs8(
        Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .unwrap()
            .as_ref(),
    )
    .unwrap();
    let bytes = serde_json::to_vec(&serde_json::json!({
        "schema":1,"version":"v3.0.1","revision":SOURCE,"description":"A future publisher field",
        "targets":{"windows-amd64":{"artifact":"piik-app-windows-amd64.zip","size":1,
            "sha256":"0".repeat(64),"label":"Windows App"}},
    }))
    .unwrap();
    let selection = Selection {
        version: "v3.0.1".into(),
        revision: SOURCE.into(),
    };
    let public_key = key.public_key().as_ref().try_into().unwrap();
    assert_eq!(
        package::verify_index(
            &public_key,
            &bytes,
            key.sign(&bytes).as_ref(),
            &selection,
            "windows-amd64"
        )
        .unwrap()
        .size,
        1
    );
}

fn archive() -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
    for (path, content) in [
        ("piik-app.exe", "test executable"),
        ("web/index.html", "<html>test</html>"),
        ("runtime/tunnel/cloudflared.exe", "test tunnel"),
        ("REVISION", SOURCE),
    ] {
        archive
            .start_file(
                path,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        archive.write_all(content.as_bytes()).unwrap();
    }
    archive
        .start_file(
            "web/padding.bin",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
    archive
        .write_all(
            &(0..160_000)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    archive.finish().unwrap().into_inner()
}

#[derive(Clone)]
struct Provider {
    index: Vec<u8>,
    signature: Vec<u8>,
    body: Vec<u8>,
    corrupt: bool,
    blocked_requests: Option<RangeInclusive<usize>>,
    first_requests: Option<Arc<tokio::sync::Barrier>>,
    requests: Arc<AtomicUsize>,
    disconnected: Arc<AtomicUsize>,
}
struct BodyLease(Arc<AtomicUsize>);
impl Drop for BodyLease {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

async fn provider_index(AxumState(provider): AxumState<Provider>) -> Vec<u8> {
    provider.index
}
async fn provider_signature(AxumState(provider): AxumState<Provider>) -> Vec<u8> {
    provider.signature
}
async fn provider_body(AxumState(provider): AxumState<Provider>) -> Response {
    let request = provider.requests.fetch_add(1, Ordering::SeqCst);
    let lease = BodyLease(provider.disconnected);
    // Both providers must start before either can win prefix selection.
    if request == 0 {
        if let Some(barrier) = provider.first_requests {
            barrier.wait().await;
        }
    }
    let blocked = provider
        .blocked_requests
        .is_some_and(|range| range.contains(&request));
    let mut bytes = provider.body;
    if provider.corrupt {
        bytes[0] ^= 1;
    }
    let stream = futures_util::stream::unfold(
        (bytes, 0, lease),
        move |(bytes, offset, lease)| async move {
            if offset == bytes.len() {
                return None;
            }
            if blocked {
                std::future::pending::<()>().await;
            }
            let end = (offset + 4096).min(bytes.len());
            let chunk = Bytes::copy_from_slice(&bytes[offset..end]);
            Some((Ok::<_, std::io::Error>(chunk), (bytes, end, lease)))
        },
    );
    Response::new(Body::from_stream(stream))
}

struct Fixture {
    _directory: tempfile::TempDir,
    config: super::super::Config,
    providers: [Provider; 2],
    servers: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for task in &self.servers {
            task.abort();
        }
    }
}

async fn fixture(
    blocked_requests: [Option<RangeInclusive<usize>>; 2],
    corrupt: [bool; 2],
) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("app");
    let data_root = directory.path().join("data");
    fs::create_dir_all(root.join("web")).unwrap();
    fs::create_dir_all(root.join("runtime/tunnel")).unwrap();
    fs::create_dir(&data_root).unwrap();
    fs::write(root.join("piik-app.exe"), b"old executable").unwrap();
    fs::write(root.join("web/index.html"), b"old web").unwrap();
    fs::write(root.join("runtime/tunnel/cloudflared.exe"), b"old tunnel").unwrap();
    fs::write(data_root.join("retained.txt"), b"identity and history").unwrap();
    let layout = BundleLayout {
        schema: 1,
        entrypoint: "piik-app.exe".into(),
        entries: package::entries(&root).unwrap(),
    };
    let key = Ed25519KeyPair::from_pkcs8(
        Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .unwrap()
            .as_ref(),
    )
    .unwrap();
    let body = archive();
    let hash: String = digest::digest(&digest::SHA256, &body)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let index = serde_json::to_vec(&serde_json::json!({"schema":1,"version":"v3.0.1","revision":SOURCE,
        "targets":{"windows-amd64":{"artifact":"piik-app-windows-amd64.zip","size":body.len(),"sha256":hash}}})).unwrap();
    let signature = key.sign(&index).as_ref().to_vec();
    let first_requests = blocked_requests
        .iter()
        .any(Option::is_some)
        .then(|| Arc::new(tokio::sync::Barrier::new(2)));
    let providers = [0, 1].map(|index_number| Provider {
        index: index.clone(),
        signature: signature.clone(),
        body: body.clone(),
        corrupt: corrupt[index_number],
        blocked_requests: blocked_requests[index_number].clone(),
        first_requests: first_requests.clone(),
        requests: Default::default(),
        disconnected: Default::default(),
    });
    let mut servers = vec![];
    let mut urls = vec![];
    for provider in &providers {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        urls.push(
            format!("http://{}/", listener.local_addr().unwrap())
                .parse()
                .unwrap(),
        );
        let router = Router::new()
            .route("/v3.0.1/update.json", get(provider_index))
            .route("/v3.0.1/update.json.sig", get(provider_signature))
            .route("/v3.0.1/piik-app-windows-amd64.zip", get(provider_body))
            .with_state(provider.clone());
        servers.push(tokio::spawn(async {
            axum::serve(listener, router).await.unwrap();
        }));
    }
    let options = Options {
        public_key: key.public_key().as_ref().try_into().unwrap(),
        layout,
        version: "v3.0.0".into(),
        target: "windows-amd64".into(),
        executable: root.join("piik-app.exe"),
        arguments: vec![],
        working_directory: directory.path().to_owned(),
        providers: urls.try_into().unwrap(),
    };
    Fixture {
        config: super::super::Config {
            data_root,
            assets: root.join("web"),
            open_browser: false,
            terminal_notice: None,
            page_player: None,
            website_permission_reset: None,
            window_navigation: None,
            cloudflared: root.join("runtime/tunnel/cloudflared.exe"),
            ice_servers: vec![],
            update: Config::Enabled(options),
        },
        _directory: directory,
        providers,
        servers,
    }
}

#[cfg(windows)]
async fn state(client: &reqwest::Client, origin: &str) -> serde_json::Value {
    serde_json::from_slice(
        &client
            .get(format!("{origin}/api/client-launcher/update"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
    )
    .unwrap()
}

#[cfg(windows)]
async fn post(
    client: &reqwest::Client,
    origin: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = client
        .post(format!("{origin}/api/client-launcher/update"))
        .header("Origin", origin)
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&body).unwrap())
        .send()
        .await
        .unwrap();
    let status = response.status();
    (
        status,
        serde_json::from_slice(&response.bytes().await.unwrap()).unwrap(),
    )
}

#[cfg(windows)]
async fn wait_state(client: &reqwest::Client, origin: &str, expected: &str) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let value = state(client, origin).await;
            if value["state"] == expected {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
#[cfg(windows)]
async fn local_http_owns_signed_download_and_cancel_without_retiring_the_app() {
    // The first operation chooses AtomGit. Later responses stay open for cancel and shutdown.
    let fixture = fixture([Some(0..=usize::MAX), Some(1..=usize::MAX)], [false; 2]).await;
    let Config::Enabled(options) = &fixture.config.update else {
        unreachable!()
    };
    let installation = package::Installation::inspect(options, &fixture.config).unwrap();
    let parent = installation.root.parent().unwrap();
    let operation = Uuid::new_v4();
    let abandoned = parent.join(format!(".piik-update-{operation}-download"));
    fs::create_dir(&abandoned).unwrap();
    fs::write(abandoned.join("package.zip"), b"unfinished package").unwrap();
    let pending = installation.data_root.join("update-download.json");
    fs::write(
        &pending,
        serde_json::to_vec(&serde_json::json!({
            "operation": operation, "workspace": abandoned,
        }))
        .unwrap(),
    )
    .unwrap();
    let retained = installation.data_root.join("update-workspace.json");
    let operation = Uuid::new_v4();
    let previous = parent.join(format!(".piik-update-{operation}-retained"));
    fs::create_dir(&previous).unwrap();
    fs::write(previous.join("result.json"), b"retained result").unwrap();
    let retained_record = serde_json::to_vec(&serde_json::json!({
        "operation": operation, "workspace": previous,
    }))
    .unwrap();
    fs::write(&retained, &retained_record).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = oneshot::channel();
    let (ready, started) = oneshot::channel();
    let config = super::super::Config {
        data_root: fixture.config.data_root.clone(),
        assets: fixture.config.assets.clone(),
        open_browser: false,
        terminal_notice: None,
        page_player: None,
        website_permission_reset: None,
        window_navigation: None,
        cloudflared: fixture.config.cloudflared.clone(),
        ice_servers: vec![],
        update: fixture.config.update.clone(),
    };
    let app = tokio::spawn(super::super::serve(
        listener,
        config,
        async {
            let _ = stopped.await;
        },
        Some(ready),
    ));
    started.await.unwrap();
    assert!(
        !abandoned.exists(),
        "Restart reclaims the recorded partial package"
    );
    assert_eq!(fs::read(&retained).unwrap(), retained_record);
    assert_eq!(
        fs::read(previous.join("result.json")).unwrap(),
        b"retained result"
    );
    assert_eq!(fs::read(&options.executable).unwrap(), b"old executable");
    assert!(!pending.exists());
    let client = download::client().unwrap();
    let selection = serde_json::json!({"action":"download","version":"v3.0.1","revision":SOURCE});
    let remote = client
        .post(format!("{origin}/api/client-launcher/update"))
        .header("Origin", "https://external.example")
        .header("Content-Type", "application/json")
        .body(selection.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(remote.status(), StatusCode::FORBIDDEN);
    assert_eq!(state(&client, &origin).await["state"], "idle");
    let (status, downloading) = post(&client, &origin, selection.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let id = downloading["operationId"].clone();
    assert_eq!(
        post(&client, &origin, selection.clone()).await.0,
        StatusCode::CONFLICT
    );
    let ready = wait_state(&client, &origin, "ready").await;
    assert_eq!(ready["source"], "atomgit");
    assert_eq!(ready["receivedBytes"], ready["totalBytes"]);
    assert_eq!(fixture.providers[0].requests.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.providers[1].requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        post(
            &client,
            &origin,
            serde_json::json!({"action":"cancel","operationId":Uuid::new_v4()})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post(
            &client,
            &origin,
            serde_json::json!({"action":"cancel","operationId":id})
        )
        .await
        .1["state"],
        "idle"
    );
    let (_, downloading) = post(&client, &origin, selection.clone()).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture
            .providers
            .iter()
            .any(|provider| provider.requests.load(Ordering::SeqCst) < 2)
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        post(
            &client,
            &origin,
            serde_json::json!({"action":"cancel","operationId":downloading["operationId"]})
        )
        .await
        .1["state"],
        "idle"
    );
    assert_eq!(
        fs::read(fixture.config.data_root.join("retained.txt")).unwrap(),
        b"identity and history"
    );
    assert_eq!(
        fs::read_dir(fixture._directory.path()).unwrap().count(),
        3,
        "Cancelled operation removes only its workspace"
    );
    assert!(!pending.exists());
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture
            .providers
            .iter()
            .any(|provider| provider.disconnected.load(Ordering::SeqCst) < 2)
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    post(&client, &origin, selection).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture
            .providers
            .iter()
            .any(|provider| provider.requests.load(Ordering::SeqCst) < 3)
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), app)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        fs::read_dir(fixture._directory.path()).unwrap().count(),
        3,
        "App shutdown cancels the response and cleans its unfinished package"
    );
    assert!(!pending.exists());
}

#[tokio::test]
#[cfg(windows)]
async fn failed_optional_download_keeps_app_running_and_can_be_dismissed() {
    let fixture = fixture([None, None], [true; 2]).await;
    let (closing, observer) = watch::channel(false);
    let owner = Owner::new(&fixture.config, closing.clone());
    let download = || Request::Download {
        version: "v3.0.1".into(),
        revision: SOURCE.into(),
    };
    let id = match tokio::join!(owner.request(download()), owner.request(download())) {
        (Ok(view), Err("update-busy")) | (Err("update-busy"), Ok(view)) => {
            view.operation_id.unwrap()
        }
        _ => panic!("Only one download may own the package"),
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        while owner.view().state == "downloading" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(owner.view().error, Some("download-failed"));
    assert!(!observer.has_changed().unwrap());
    assert_eq!(fs::read_dir(fixture._directory.path()).unwrap().count(), 2);
    assert_eq!(
        owner
            .request(Request::Cancel { operation_id: id })
            .await
            .unwrap()
            .state,
        "idle"
    );
    closing.send_replace(true);
    owner.shutdown().await;
}

#[tokio::test]
async fn corrupted_winner_uses_only_one_fallback_and_never_accepts_bad_signatures() {
    let fixture = fixture([None, Some(0..=0)], [true, false]).await;
    let Config::Enabled(options) = &fixture.config.update else {
        unreachable!()
    };
    let installation = package::Installation::inspect(options, &fixture.config).unwrap();
    let selection = Selection {
        version: "v3.0.1".into(),
        revision: SOURCE.into(),
    };
    let prepared = download::prepare(
        options,
        &installation,
        Uuid::new_v4(),
        &selection,
        |_, _, _| {},
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read(prepared.directory.path().join("package.zip")).unwrap(),
        fixture.providers[1].body
    );
    assert_eq!(fixture.providers[0].requests.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.providers[1].requests.load(Ordering::SeqCst), 2);
    let mut invalid = options.clone();
    invalid.public_key[0] ^= 1;
    assert!(download::prepare(
        &invalid,
        &installation,
        Uuid::new_v4(),
        &selection,
        |_, _, _| {}
    )
    .await
    .is_err());
    assert_eq!(
        fixture
            .providers
            .each_ref()
            .map(|provider| provider.requests.load(Ordering::SeqCst)),
        [1, 2],
        "Invalid signatures never start package downloads"
    );
}

#[test]
fn complete_bundle_extraction_rejects_traversal() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("package.zip");
    fs::write(&path, archive()).unwrap();
    package::extract(&path, &directory.path().join("new"), "piik-app.exe").unwrap();
    let mut bad = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
    bad.start_file("../outside.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    bad.write_all(b"escaped").unwrap();
    fs::write(&path, bad.finish().unwrap().into_inner()).unwrap();
    assert!(package::extract(&path, &directory.path().join("bad"), "piik-app.exe").is_err());
    assert!(!directory.path().join("outside.txt").exists());
    assert!(package::validate_selection(
        "v3.0.0",
        &Selection {
            version: "v3.0.0".into(),
            revision: SOURCE.into()
        }
    )
    .is_err());
    assert!(package::validate_selection(
        "v3.0.0",
        &Selection {
            version: "v3.0.1-beta.1".into(),
            revision: SOURCE.into()
        }
    )
    .is_err());
}

#[cfg(windows)]
#[tokio::test]
async fn local_archive_write_error_does_not_retry_the_mirror() {
    let fixture = fixture([None, Some(0..=0)], [false; 2]).await;
    let Config::Enabled(options) = &fixture.config.update else {
        unreachable!()
    };
    let installation = package::Installation::inspect(options, &fixture.config).unwrap();
    let operation = Uuid::new_v4();
    let prefix = format!(".piik-update-{operation}-");
    let lock = std::cell::OnceCell::new();
    let result = download::prepare(
        options,
        &installation,
        operation,
        &Selection {
            version: "v3.0.1".into(),
            revision: SOURCE.into(),
        },
        |_, _, _| {
            lock.get_or_init(|| {
                let workspace = fs::read_dir(installation.root.parent().unwrap())
                    .unwrap()
                    .map(|entry| entry.unwrap())
                    .find(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
                    .unwrap();
                let file = fs::File::options()
                    .read(true)
                    .write(true)
                    .open(workspace.path().join("package.zip"))
                    .unwrap();
                file.try_lock().unwrap();
                file
            });
        },
    )
    .await;
    assert!(result.err().unwrap().is::<std::io::Error>());
    assert_eq!(fixture.providers[0].requests.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.providers[1].requests.load(Ordering::SeqCst), 1);
}
#[tokio::test]
#[cfg(windows)]
async fn locked_abandoned_download_record_fails_only_the_update_and_can_retry() {
    use std::os::windows::fs::OpenOptionsExt;

    let fixture = fixture([None, None], [false; 2]).await;
    let Config::Enabled(options) = &fixture.config.update else {
        unreachable!()
    };
    let installation = package::Installation::inspect(options, &fixture.config).unwrap();
    let operation = Uuid::new_v4();
    let abandoned = installation
        .root
        .parent()
        .unwrap()
        .join(format!(".piik-update-{operation}-download"));
    fs::create_dir(&abandoned).unwrap();
    fs::write(abandoned.join("package.zip"), b"unfinished package").unwrap();
    let pending = installation.data_root.join("update-download.json");
    fs::write(
        &pending,
        serde_json::to_vec(&serde_json::json!({
            "operation": operation, "workspace": abandoned,
        }))
        .unwrap(),
    )
    .unwrap();
    let locked = fs::File::options()
        .read(true)
        .share_mode(3)
        .open(&pending)
        .unwrap();
    let _data_owner = super::super::lock_directory(&fixture.config.data_root).unwrap();
    let (closing, observer) = watch::channel(false);
    let owner = Owner::new(&fixture.config, closing.clone());
    assert!(owner.supported());
    assert!(!abandoned.exists());
    assert!(pending.exists());
    let request = || Request::Download {
        version: "v3.0.1".into(),
        revision: SOURCE.into(),
    };
    owner.request(request()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while owner.view().state == "downloading" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(owner.view().error, Some("download-failed"));
    assert!(!observer.has_changed().unwrap());

    drop(locked);
    owner.request(request()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while owner.view().state == "downloading" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(owner.view().state, "ready");
    closing.send_replace(true);
    owner.shutdown().await;
    assert!(!pending.exists());
}

#[tokio::test]
#[cfg(windows)]
async fn relocated_app_retires_downloads_from_its_previous_installation_parent() {
    for directory_exists in [true, false] {
        let mut fixture = fixture([None, None], [false; 2]).await;
        let Config::Enabled(options) = &mut fixture.config.update else {
            unreachable!()
        };
        let old_parent = fs::canonicalize(fixture._directory.path()).unwrap();
        let old_root = old_parent.join("app");
        let operation = Uuid::new_v4();
        let abandoned = old_parent.join(format!(".piik-update-{operation}-download"));
        if directory_exists {
            fs::create_dir(&abandoned).unwrap();
            fs::write(abandoned.join("package.zip"), b"unfinished package").unwrap();
        }
        let pending = fixture.config.data_root.join("update-download.json");
        fs::write(
            &pending,
            serde_json::to_vec(&serde_json::json!({
                "operation": operation, "workspace": abandoned,
            }))
            .unwrap(),
        )
        .unwrap();

        let new_parent = old_parent.join("portable");
        fs::create_dir(&new_parent).unwrap();
        let new_root = new_parent.join("app");
        fs::rename(&old_root, &new_root).unwrap();
        options.executable = new_root.join("piik-app.exe");
        fixture.config.assets = new_root.join("web");
        fixture.config.cloudflared = new_root.join("runtime/tunnel/cloudflared.exe");
        let _data_owner = super::super::lock_directory(&fixture.config.data_root).unwrap();
        let closing = watch::channel(false).0;
        let owner = Owner::new(&fixture.config, closing.clone());
        assert!(
            !pending.exists(),
            "The previous workspace existed: {directory_exists}"
        );
        assert!(!abandoned.exists());

        owner
            .request(Request::Download {
                version: "v3.0.1".into(),
                revision: SOURCE.into(),
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while owner.view().state == "downloading" {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(owner.view().state, "ready");
        closing.send_replace(true);
        owner.shutdown().await;

        assert!(!pending.exists());
        assert_eq!(
            fs::read(new_root.join("piik-app.exe")).unwrap(),
            b"old executable"
        );
        assert_eq!(
            fs::read(fixture.config.data_root.join("retained.txt")).unwrap(),
            b"identity and history"
        );
    }
}

#[tokio::test]
#[cfg(windows)]
async fn unmanaged_directories_and_data_inside_the_bundle_stay_manual() {
    let mut fixture = fixture([None, None], [false; 2]).await;
    let closing = watch::channel(false).0;
    fs::write(fixture.config.assets.join("personal.txt"), b"user content").unwrap();
    assert_eq!(
        Owner::new(&fixture.config, closing.clone()).view().reason,
        Some("unmanaged-installation")
    );
    fs::remove_file(fixture.config.assets.join("personal.txt")).unwrap();
    fixture.config.data_root = fixture.config.assets.clone();
    assert_eq!(
        Owner::new(&fixture.config, closing).view().reason,
        Some("unmanaged-installation")
    );
}

#[cfg(windows)]
#[tokio::test]
async fn failed_handoff_retries_after_windows_releases_a_download_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = fixture([None, None], [false; 2]).await;
    let Config::Enabled(options) = &fixture.config.update else {
        unreachable!()
    };
    let installation = package::Installation::inspect(options, &fixture.config).unwrap();
    let selection = Selection {
        version: "v3.0.1".into(),
        revision: SOURCE.into(),
    };
    let (_open, closing) = tokio::sync::watch::channel(false);
    let prepare = || {
        download::prepare(
            options,
            &installation,
            Uuid::new_v4(),
            &selection,
            |_, _, _| {},
        )
    };
    let prepared = prepare().await.unwrap();
    let path = prepared.directory.path().to_owned();
    let scanner = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(path.join("update.json.sig"))
        .unwrap();
    let handoff = |prepared| windows::handoff(options, &installation, prepared, closing.clone());
    // The fixture App is a text file. Windows rejects the copied helper at CreateProcess.
    assert_eq!(
        handoff(prepared).await.unwrap_err().to_string(),
        "Start update helper"
    );
    assert!(installation
        .data_root
        .join("update-workspace.json")
        .is_file());
    assert!(path.join("update.json.sig").is_file());
    assert!(path.join("plan.json").is_file());
    drop(scanner);
    assert_eq!(
        handoff(prepare().await.unwrap())
            .await
            .unwrap_err()
            .to_string(),
        "Start update helper"
    );
    assert!(!path.exists());
    assert_eq!(fs::read(&options.executable).unwrap(), b"old executable");
}
