use piik_channel_native::session::{run, Config};
use std::{io, time::Duration};
use tokio::{io::AsyncReadExt, net::TcpListener, sync::oneshot, time::timeout};

#[tokio::test]
async fn hosting_starts_wss_tls_and_cancels_an_unfinished_handshake() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let hosting = tokio::spawn(run(
        Config {
            url: format!("wss://{address}/prototype/channel"),
            origin: format!("https://{address}"),
            name: "TLS fixture".into(),
            owner_key: None,
            credential: None,
            server_udp: None,
        },
        vec![],
        async {
            let _ = stopped.await;
        },
    ));
    // Only observe the real client handshake; no server certificate or trust override.
    let handshake = timeout(Duration::from_secs(10), async {
        let (mut socket, _) = listener.accept().await?;
        let mut prefix = [0; 6];
        socket.read_exact(&mut prefix).await?;
        Ok::<_, io::Error>((socket, prefix))
    })
    .await;

    // Keep the accepted TCP connection open until the real hosting task has retired.
    let _ = stop.send(());
    timeout(Duration::from_secs(10), hosting)
        .await
        .expect("hosting must join after cancellation")
        .expect("hosting must not panic while constructing TLS")
        .expect("cancellation must finish normally");
    let (_socket, prefix) = handshake
        .expect("WSS must begin TLS within the harness deadline")
        .expect("WSS must send a ClientHello");
    assert_eq!(prefix[0], 22, "TLS handshake record");
    assert_eq!(prefix[1], 3, "TLS record major version");
    assert!(u16::from_be_bytes([prefix[3], prefix[4]]) > 0);
    assert_eq!(prefix[5], 1, "ClientHello handshake");
}
