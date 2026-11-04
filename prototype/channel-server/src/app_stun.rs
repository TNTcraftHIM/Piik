//! Binding discovery for the App's selected Local LAN entry.
use rtc_stun::fingerprint::FINGERPRINT;
use rtc_stun::message::Message;
use rtc_stun::message::BINDING_REQUEST;
use rtc_stun::message::BINDING_SUCCESS;
use rtc_stun::xoraddr::XorMappedAddress;
use tokio::net::UdpSocket;

pub(super) async fn serve(socket: &UdpSocket) -> anyhow::Result<()> {
    let mut bytes = [0; 65535];
    loop {
        let (length, peer) = match socket.recv_from(&mut bytes).await {
            Ok(received) => received,
            // Windows can report a prior response's peer ICMP error on this read.
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => continue,
            Err(error) => return Err(error.into()),
        };
        let mut request = Message::new();
        if request.unmarshal_binary(&bytes[..length]).is_err() || request.typ != BINDING_REQUEST {
            continue;
        }
        let mut response = Message::new();
        response.build(&[
            Box::new(request.transaction_id),
            Box::new(BINDING_SUCCESS),
            Box::new(XorMappedAddress {
                ip: peer.ip(),
                port: peer.port(),
            }),
            Box::new(FINGERPRINT),
        ])?;
        // A failed response to one peer does not retire discovery for the domain.
        let _ = socket.send_to(&response.raw, peer).await;
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{net::Ipv4Addr, task::Poll, time::Duration};
    use tokio::time::timeout;

    #[tokio::test]
    async fn closed_peer_does_not_end_local_discovery() -> anyhow::Result<()> {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let address = socket.local_addr()?;
        let closed = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
        let closed_address = closed.local_addr()?;
        drop(closed);

        // Windows reports this peer's ICMP error on the same socket's next read.
        // Wait for readiness without consuming that error before starting STUN.
        socket.send_to(b"closed-peer", closed_address).await?;
        timeout(Duration::from_secs(2), socket.readable()).await??;
        let mut discovery = Box::pin(serve(&socket));
        match futures_util::poll!(discovery.as_mut()) {
            Poll::Pending => {}
            Poll::Ready(result) => panic!("a peer error stopped Local discovery: {result:?}"),
        }

        let client = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let mut request = Message::new();
        request.build(&[Box::new(BINDING_REQUEST), Box::new(FINGERPRINT)])?;
        client.send_to(&request.raw, address).await?;
        let mut bytes = [0; 1024];
        let (length, _) = timeout(Duration::from_secs(2), async {
            tokio::select! {
                result = &mut discovery => anyhow::bail!("Local discovery ended: {result:?}"),
                received = client.recv_from(&mut bytes) => received.map_err(anyhow::Error::from),
            }
        })
        .await??;
        let mut response = Message::new();
        response.unmarshal_binary(&bytes[..length])?;
        assert_eq!(response.typ, BINDING_SUCCESS);
        assert_eq!(response.transaction_id, request.transaction_id);

        drop(discovery);
        drop(socket);
        let rebound = UdpSocket::bind(address).await?;
        assert_eq!(rebound.local_addr()?, address);
        Ok(())
    }
}
