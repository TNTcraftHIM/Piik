//! A Server service owns its fixed sockets across all physical peer leases.
use super::mapping;
use anyhow::{ensure, Context, Result};
use rtc::peer_connection::transport::{RTCIceCandidate, RTCIceCandidateType, RTCIceProtocol};
use std::{net::SocketAddr, sync::Arc};

pub struct ServerUdp {
    pub(super) sockets: Vec<Arc<super::transport::UdpIo>>,
    pub(super) leased: std::sync::atomic::AtomicBool,
    mappings: Vec<(SocketAddr, SocketAddr)>,
}

impl ServerUdp {
    /// Each mapping names a real local bind and an optional externally forwarded address.
    /// IPv6 uses a separate v6-only socket so the same port also works on IPv4.
    pub fn bind(bindings: &[(SocketAddr, Option<SocketAddr>)]) -> Result<Arc<Self>> {
        let mut sockets = Vec::new();
        let mut mappings = Vec::new();
        for &(bind, advertised) in bindings {
            if let Some(advertised) = advertised {
                ensure!(
                    bind.is_ipv4() == advertised.is_ipv4(),
                    "UDP mapping address families differ"
                );
                ensure!(
                    !advertised.ip().is_unspecified() && advertised.port() != 0,
                    "UDP public address must be concrete"
                );
            }
            let socket = (|| -> std::io::Result<std::net::UdpSocket> {
                let socket = socket2::Socket::new(
                    socket2::Domain::for_address(bind),
                    socket2::Type::DGRAM,
                    Some(socket2::Protocol::UDP),
                )?;
                if bind.is_ipv6() {
                    socket.set_only_v6(true)?;
                }
                socket.bind(&bind.into())?;
                Ok(socket.into())
            })();
            let socket = socket.with_context(|| format!("Bind Server UDP {bind}"))?;
            let local = socket.local_addr()?;
            socket.set_nonblocking(true)?;
            sockets.push(Arc::new(super::transport::UdpIo::new(
                tokio::net::UdpSocket::from_std(socket)?,
            )?));
            if let Some(advertised) = advertised {
                mappings.push((local, advertised));
            }
        }
        ensure!(!sockets.is_empty(), "No Server UDP listener available");
        Ok(Arc::new(Self {
            sockets,
            mappings,
            leased: false.into(),
        }))
    }

    pub(super) fn mapped_candidate(
        &self,
        base: &RTCIceCandidate,
    ) -> Result<Option<RTCIceCandidate>> {
        if base.protocol != RTCIceProtocol::Udp
            || base.typ != RTCIceCandidateType::Host
            || base.component != 1
        {
            return Ok(None);
        }
        let Ok(ip) = base.address.parse::<std::net::IpAddr>() else {
            return Ok(None);
        };
        let mapped = self.mappings.iter().find(|(local, _)| {
            local.port() == base.port
                && local.is_ipv4() == ip.is_ipv4()
                && (local.ip().is_unspecified() || local.ip() == ip)
        });
        mapped
            .map(|(_, external)| mapping::candidate(base, *external))
            .transpose()
    }
}
