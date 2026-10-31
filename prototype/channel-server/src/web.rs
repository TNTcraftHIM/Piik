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
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};

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
        .fallback_service(ServeDir::new(directory).append_index_html_on_directories(false)))
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
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let conditional = modified
            .map(|date| format!("If-Modified-Since: {date}\r\n"))
            .unwrap_or_default();
        stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: {address}\r\n{conditional}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8(bytes).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        let headers = head
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        (status, headers, body.into())
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
            Router::new().fallback_service(document(index.clone())),
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
