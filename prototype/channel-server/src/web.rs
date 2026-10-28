//! Frontend assets and the domain's bound network entries.
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use rustls::pki_types::CertificateDer;
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
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
        .route_service("/", ServeFile::new(index.clone()))
        .route_service("/__channel-preview", ServeFile::new(index))
        .fallback_service(ServeDir::new(directory).append_index_html_on_directories(false)))
}
