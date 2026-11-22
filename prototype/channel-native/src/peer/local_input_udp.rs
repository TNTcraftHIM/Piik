use super::UdpIo;
use anyhow::Result;
use netwatch::interfaces::State;
use socket2::{Domain, Protocol, SockFilter, Socket, Type};
use std::net::{IpAddr, SocketAddr};
use tokio::net::UdpSocket;

pub(super) fn bind(state: State) -> Result<Option<UdpIo>> {
    // Stock OBS/libnice gathers ordinary interface addresses. A same-host
    // packet to one of those addresses still arrives through Linux loopback.
    let preferred = state
        .default_route_interface
        .as_ref()
        .and_then(|name| state.interfaces.get(name));
    let address = preferred
        .into_iter()
        .chain(state.interfaces.values())
        .filter(|interface| interface.is_up())
        .flat_map(|interface| interface.addrs())
        .map(|address| address.addr())
        .find(|ip| {
            matches!(ip, IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local()
            && !v4.is_unspecified() && !v4.is_multicast() && !v4.is_broadcast())
        });
    let Some(address) = address else {
        return Ok(None);
    };
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // Linux include/net/flow.h defines LOOPBACK_IFINDEX for every network
    // namespace. Install the ingress filter before the port can receive.
    const LOOPBACK_IFINDEX: u32 = 1;
    socket.attach_filter(&[
        SockFilter::new(
            (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
            0,
            0,
            (libc::SKF_AD_OFF + libc::SKF_AD_IFINDEX) as u32,
        ),
        SockFilter::new(
            (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
            0,
            1,
            LOOPBACK_IFINDEX,
        ),
        SockFilter::new((libc::BPF_RET | libc::BPF_K) as u16, 0, 0, u32::MAX),
        SockFilter::new((libc::BPF_RET | libc::BPF_K) as u16, 0, 0, 0),
    ])?;
    socket.bind(&SocketAddr::new(address, 0).into())?;
    socket.set_nonblocking(true)?;
    Ok(Some(UdpIo::new(UdpSocket::from_std(socket.into())?)?))
}
