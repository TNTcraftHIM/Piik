//! Frontend assets and the domain's bound network entries.
use axum::{
    extract::Request,
    http::{header, HeaderValue},
    middleware::{self, Next},
    response::Response,
    routing::{get_service, MethodRouter},
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use rustls::pki_types::CertificateDer;
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::{future::Future, time::Duration};
use tokio::net::TcpListener;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeader,
};

// One HTTP drain budget for both bound entries, using the existing server owner.
pub(crate) const HTTP_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) async fn serve_http(
    listener: TcpListener,
    routes: Router,
    stop: impl Future<Output = ()>,
) -> std::io::Result<()> {
    let handle = axum_server::Handle::new();
    let server = axum_server::from_tcp(listener.into_std()?)?
        .acceptor(axum_server::accept::NoDelayAcceptor::new())
        .handle(handle.clone())
        .serve(routes.into_make_service());
    tokio::pin!(server, stop);
    tokio::select! {
        result = &mut server => result,
        _ = &mut stop => {
            handle.graceful_shutdown(Some(HTTP_DRAIN_TIMEOUT));
            server.await
        }
    }
}

#[derive(Serialize)]
pub struct LanAddress {
    pub address: String,
    pub name: String,
}

pub fn lan_addresses() -> anyhow::Result<Vec<LanAddress>> {
    let mut addresses: Vec<_> = if_addrs::get_if_addrs()?
        .into_iter()
        .filter(|interface| interface.is_oper_up())
        .filter_map(|interface| {
            let IpAddr::V4(ip) = interface.ip() else {
                return None;
            };
            (!ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() && !ip.is_multicast())
                .then(|| LanAddress {
                    address: ip.to_string(),
                    name: interface.name,
                })
        })
        .collect();
    addresses.sort_by(|a, b| a.address.cmp(&b.address).then(a.name.cmp(&b.name)));
    addresses.dedup_by(|a, b| a.address == b.address);
    Ok(addresses)
}

/// A bound HTTPS entry. Its key and certificate live only with this runtime.
pub struct LanHttps {
    pub(crate) listener: TcpListener,
    pub(crate) config: RustlsConfig,
    pub(crate) certificate: CertificateDer<'static>,
    origin: String,
}

impl LanHttps {
    pub async fn bind(address: IpAddr, port: u16) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::new(address, port)).await?;
        let origin = format!("https://{}", listener.local_addr()?);
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec![address.to_string()])?;
        let certificate = cert.der().clone();
        let config =
            RustlsConfig::from_der(vec![certificate.to_vec()], signing_key.serialize_der()).await?;
        Ok(Self {
            listener,
            config,
            certificate,
            origin,
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// SHA-256 leaf fingerprint, matching the existing terminal's uppercase hex.
    pub fn fingerprint(&self) -> String {
        ring::digest::digest(&ring::digest::SHA256, self.certificate.as_ref())
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect()
    }
}

pub(crate) fn origin(value: &str) -> anyhow::Result<String> {
    let url = url::Url::parse(value)?;
    if !matches!(url.scheme(), "http" | "https") || url.origin().ascii_serialization() != value {
        anyhow::bail!("invalid_site_origin");
    }
    Ok(value.to_owned())
}

pub fn frontend(directory: &Path) -> anyhow::Result<Router> {
    let index = directory.join("index.html");
    anyhow::ensure!(
        index.is_file(),
        "frontend directory must contain index.html"
    );
    Ok(Router::new()
        .route("/", document(index.clone()))
        .route("/__channel-preview", document(index.clone()))
        .route("/index.html", document(index))
        .fallback_service(static_files(
            ServeDir::new(directory).append_index_html_on_directories(false),
        )))
}

pub(crate) fn static_files<F>(files: ServeDir<F>) -> SetResponseHeader<ServeDir<F>, HeaderValue> {
    SetResponseHeader::appending(
        files.precompressed_br().precompressed_gzip(),
        header::VARY,
        HeaderValue::from_static("Accept-Encoding"),
    )
}

pub(crate) fn document<S: Clone + Send + Sync + 'static>(index: PathBuf) -> MethodRouter<S> {
    get_service(ServeFile::new(index)).layer(middleware::from_fn(refresh_document))
}

async fn refresh_document(mut request: Request, next: Next) -> Response {
    // A rollback can have an older mtime than the browser's cached HTML. Always
    // replace that entry so it names this package's assets, even on an old cache.
    request.headers_mut().remove(header::IF_MODIFIED_SINCE);
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        fs,
        time::{Duration, UNIX_EPOCH},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn request(
        address: SocketAddr,
        path: &str,
        modified: Option<&str>,
    ) -> (u16, BTreeMap<String, String>, String) {
        let conditional = modified
            .map(|date| format!("If-Modified-Since: {date}\r\n"))
            .unwrap_or_default();
        let (status, headers, body) = request_bytes(address, path, &conditional).await;
        (status, headers, String::from_utf8(body).unwrap())
    }

    async fn request_bytes(
        address: SocketAddr,
        path: &str,
        headers: &str,
    ) -> (u16, BTreeMap<String, String>, Vec<u8>) {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET {path} HTTP/1.1\r\nHost: {address}\r\n{headers}Connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        let separator = bytes
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap();
        let head = std::str::from_utf8(&bytes[..separator]).unwrap();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        let headers = head
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        (status, headers, bytes[separator + 4..].to_vec())
    }

    #[tokio::test]
    async fn shared_static_files_negotiate_precompressed_assets() {
        let directory =
            std::env::temp_dir().join(format!("piik-web-encoding-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("assets")).unwrap();
        let index = directory.join("index.html");
        fs::write(&index, "frontend").unwrap();
        // A minimal WASM module and its valid precompressed representations.
        let identity = [0, 97, 115, 109, 1, 0, 0, 0];
        let brotli = [139, 3, 128, 0, 97, 115, 109, 1, 0, 0, 0, 3];
        let gzip = [
            31, 139, 8, 0, 0, 0, 0, 0, 2, 10, 99, 72, 44, 206, 101, 100, 96, 96, 0, 0, 206, 51, 75,
            28, 8, 0, 0, 0,
        ];
        fs::write(directory.join("assets/adapter.wasm"), identity).unwrap();
        fs::write(directory.join("assets/adapter.wasm.br"), brotli).unwrap();
        fs::write(directory.join("assets/adapter.wasm.gz"), gzip).unwrap();
        let routes = frontend(&directory).unwrap().nest(
            "/app",
            Router::new().fallback_service(static_files(
                ServeDir::new(&directory).fallback(document(index)),
            )),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, routes)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let mut responses = Vec::new();
        for path in ["/assets/adapter.wasm", "/app/assets/adapter.wasm"] {
            for (encoding, expected) in [
                ("br, gzip", Some("br")),
                ("gzip", Some("gzip")),
                ("identity", None),
            ] {
                responses.push((
                    expected,
                    request_bytes(address, path, &format!("Accept-Encoding: {encoding}\r\n")).await,
                ));
            }
        }
        stop.send(()).unwrap();
        server.await.unwrap();
        fs::remove_dir_all(directory).unwrap();
        for (encoding, response) in responses {
            assert_eq!(response.0, 200);
            assert_eq!(
                response.1.get("content-type").map(String::as_str),
                Some("application/wasm")
            );
            assert_eq!(
                response.1.get("content-encoding").map(String::as_str),
                encoding
            );
            assert_eq!(
                response.1.get("vary").map(String::as_str),
                Some("Accept-Encoding")
            );
            assert_eq!(
                response.2,
                match encoding {
                    Some("br") => brotli.as_slice(),
                    Some("gzip") => gzip.as_slice(),
                    _ => identity.as_slice(),
                }
            );
        }
    }

    #[tokio::test]
    async fn rollback_refreshes_documents_without_disabling_asset_validation() {
        let directory =
            std::env::temp_dir().join(format!("piik-web-rollback-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("assets")).unwrap();
        let index = directory.join("index.html");
        fs::write(&index, "<script src=\"/assets/new.js\"></script>").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&index)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_100)),
            )
            .unwrap();
        fs::write(directory.join("assets/new.js"), "new").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let routes = frontend(&directory).unwrap().nest(
            "/spa",
            Router::new().fallback_service(static_files(
                ServeDir::new(&directory).fallback(document(index.clone())),
            )),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, routes)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let newer = request(address, "/", None).await;
        assert_eq!(newer.0, 200);
        assert!(newer.2.contains("new.js"));
        let cached_modified = newer.1.get("last-modified").unwrap().clone();
        fs::write(&index, "<script src=\"/assets/old.js\"></script>").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&index)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
            )
            .unwrap();
        fs::remove_file(directory.join("assets/new.js")).unwrap();
        fs::write(directory.join("assets/old.js"), "old").unwrap();
        let mut responses = Vec::new();
        for path in [
            "/",
            "/__channel-preview",
            "/index.html",
            "/spa/client/route",
        ] {
            for modified in [&cached_modified[..], "Thu, 01 Jan 2099 00:00:00 GMT"] {
                responses.push(request(address, path, Some(modified)).await);
            }
        }
        let asset = request(address, "/assets/old.js", None).await;
        let asset_cached = request(
            address,
            "/assets/old.js",
            asset.1.get("last-modified").map(String::as_str),
        )
        .await;
        let missing = request(address, "/assets/new.js", None).await;
        let unknown_api = request(address, "/api/unknown", None).await;
        stop.send(()).unwrap();
        server.await.unwrap();
        fs::remove_dir_all(&directory).unwrap();
        for response in responses {
            assert_eq!(response.0, 200, "rollback must replace cached newer HTML");
            assert!(response.2.contains("old.js"));
            assert_eq!(
                response.1.get("cache-control").map(String::as_str),
                Some("no-store")
            );
        }
        assert_eq!(asset.0, 200);
        assert_ne!(
            asset.1.get("cache-control").map(String::as_str),
            Some("no-store")
        );
        assert_eq!(asset_cached.0, 304);
        assert_eq!(missing.0, 404);
        assert_eq!(unknown_api.0, 404);
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
        sync::oneshot,
        time::timeout,
    };

    async fn request(address: SocketAddr, path: &str) -> String {
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut reply = String::new();
        socket.read_to_string(&mut reply).await.unwrap();
        reply
    }

    #[tokio::test]
    async fn healthy_http_request_finishes_during_shutdown() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (started, entered) = oneshot::channel();
        let started = std::sync::Arc::new(std::sync::Mutex::new(Some(started)));
        let routes = Router::new().route(
            "/owned",
            axum::routing::get(move || {
                let started = started.clone();
                async move {
                    if let Some(started) = started.lock().unwrap().take() {
                        let _ = started.send(());
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    "completed"
                }
            }),
        );
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(serve_http(listener, routes, async {
            let _ = stopped.await;
        }));
        let client = tokio::spawn(request(address, "/owned"));
        entered.await.unwrap();
        stop.send(()).unwrap();
        timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let response = client.await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200") && response.ends_with("completed"));
    }

    #[tokio::test]
    async fn shutdown_retires_incomplete_http_headers_and_bodies() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let routes = Router::new().route(
            "/",
            axum::routing::get(|| async { "ready" })
                .post(|_: axum::Json<serde_json::Value>| async { "complete" }),
        );
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(serve_http(listener, routes, async {
            let _ = stopped.await;
        }));
        let mut header = TcpStream::connect(address).await.unwrap();
        header.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        let mut body = TcpStream::connect(address).await.unwrap();
        body.write_all(format!("POST / HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{{").as_bytes()).await.unwrap();
        assert!(request(address, "/").await.starts_with("HTTP/1.1 200"));
        stop.send(()).unwrap();
        timeout(HTTP_DRAIN_TIMEOUT + Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        for mut socket in [header, body] {
            let mut bytes = Vec::new();
            timeout(Duration::from_millis(300), socket.read_to_end(&mut bytes))
                .await
                .expect("accepted connection remains live after HTTP retirement")
                .unwrap_or_else(|error| {
                    assert!(
                        matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof
                        ),
                        "unexpected retirement read failure: {error}"
                    );
                    0
                });
        }
    }
}
