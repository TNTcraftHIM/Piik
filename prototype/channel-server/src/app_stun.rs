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
        let (length, peer) = socket.recv_from(&mut bytes).await?;
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
