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
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

const SOURCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
    delay: Duration,
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
    provider.requests.fetch_add(1, Ordering::SeqCst);
    let mut bytes = provider.body;
    if provider.corrupt {
        bytes[0] ^= 1;
    }
    let lease = BodyLease(provider.disconnected);
    let stream = futures_util::stream::unfold(
        (bytes, 0, lease),
        move |(bytes, offset, lease)| async move {
            if offset == bytes.len() {
                return None;
            }
            tokio::time::sleep(provider.delay).await;
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

async fn fixture(delays: [Duration; 2], corrupt: [bool; 2]) -> Fixture {
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
    let providers = [0, 1].map(|index_number| Provider {
        index: index.clone(),
        signature: signature.clone(),
        body: body.clone(),
        corrupt: corrupt[index_number],
        delay: delays[index_number],
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
    let fixture = fixture(
        [Duration::from_millis(12), Duration::from_millis(1)],
        [false, false],
    )
    .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = oneshot::channel();
    let (ready, started) = oneshot::channel();
    let config = super::super::Config {
        data_root: fixture.config.data_root.clone(),
        assets: fixture.config.assets.clone(),
        open_browser: false,
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
        2,
        "Cancelled operation removes only its workspace"
    );
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
        2,
        "App shutdown cancels the response and cleans its unfinished package"
    );
}

#[tokio::test]
async fn corrupted_winner_uses_only_one_fallback_and_never_accepts_bad_signatures() {
    let fixture = fixture(
        [Duration::from_millis(1), Duration::from_millis(12)],
        [true, false],
    )
    .await;
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
        fixture.providers[0].requests.load(Ordering::SeqCst),
        1,
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

#[tokio::test]
#[cfg(windows)]
async fn unmanaged_directories_and_data_inside_the_bundle_stay_manual() {
    let mut fixture = fixture([Duration::ZERO; 2], [false; 2]).await;
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
