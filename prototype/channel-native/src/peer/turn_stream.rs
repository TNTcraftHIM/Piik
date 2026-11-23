//! Socket owner for one TURN/TCP or TURN/TLS allocation.
use super::*;
use bytes::BytesMut;
use rtc_shared::turn_framing::TurnStreamDecoder;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::MaybeTlsStream;

// Complete TURN frames only. Partial writes stay with this connection's writer.
const WRITE_FRAMES: usize = 128;
pub(super) struct Stream {
    pub id: Uuid,
    outgoing: mpsc::Sender<BytesMut>,
    task: JoinHandle<()>,
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Stream {
    pub fn closed(&self) -> bool {
        self.outgoing.is_closed()
    }

    pub fn write(&self, frame: BytesMut) -> Result<()> {
        // A slow stream can shed a whole relayed datagram before writing it.
        // Preserve queue space for allocate, refresh and permission requests.
        if self.outgoing.capacity() <= 4 {
            use rtc_stun::message::{MessageType, CLASS_INDICATION, METHOD_SEND};
            use rtc_turn::proto::chandata::ChannelData;
            let send_indication = MessageType::new(METHOD_SEND, CLASS_INDICATION).value();
            if ChannelData::is_channel_data(&frame)
                || frame.starts_with(&send_indication.to_be_bytes())
            {
                return Ok(());
            }
        }
        self.outgoing
            .try_send(frame)
            .map_err(|_| anyhow!("TURN stream write queue unavailable"))
    }

    pub async fn connect(
        url: &IceServerUrl,
        server: SocketAddr,
        handle: Transport,
    ) -> Result<(Self, SocketAddr)> {
        let tcp = TcpStream::connect(server).await?;
        tcp.set_nodelay(true)?;
        let local = tcp.local_addr()?;
        let socket = if url.transport == IceTransport::Tls {
            let name = rustls::pki_types::ServerName::try_from(url.host.clone())?;
            let tls = tokio_rustls::TlsConnector::from(tls_config().await?);
            MaybeTlsStream::Rustls(tls.connect(name, tcp).await?)
        } else {
            MaybeTlsStream::Plain(tcp)
        };
        let id = Uuid::new_v4();
        let (outgoing, pending) = mpsc::channel(WRITE_FRAMES);
        let task = tokio::spawn(async move {
            if let Err(error) = drive(socket, pending, &handle, id).await {
                eprintln!("Native TURN stream: {error}");
            }
            // drive drops the receiver first. The pump notices the closed
            // queue even when no new media or timer is due on this pair.
            let _ = handle.call(|_| Ok(())).await;
        });
        Ok((Self { id, outgoing, task }, local))
    }
}

async fn drive(
    socket: MaybeTlsStream<TcpStream>,
    mut writes: mpsc::Receiver<BytesMut>,
    handle: &Transport,
    id: Uuid,
) -> Result<()> {
    let (mut reader, mut writer) = tokio::io::split(socket);
    let read = async {
        let mut decoder = TurnStreamDecoder::new();
        let mut buffer = [0; 8192];
        loop {
            let len = reader.read(&mut buffer).await?;
            if len == 0 {
                return Ok::<(), anyhow::Error>(());
            }
            let at = Instant::now();
            decoder.extend_from_slice(&buffer[..len]);
            let mut messages = Vec::new();
            while let Some(message) = decoder.next_message()? {
                messages.push(message);
            }
            if !messages.is_empty() {
                handle
                    .call(move |engine| {
                        if let Some(endpoint) = engine.turn.get_mut(&Key::Stream(id)) {
                            for message in messages {
                                endpoint.read_message(at, &message);
                            }
                        }
                        Ok(())
                    })
                    .await?;
            }
        }
    };
    let write = async {
        while let Some(frame) = writes.recv().await {
            writer.write_all(&frame).await?;
            writer.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    };
    tokio::select! { result = read => result, result = write => result }
}

// Same trust sources as the signaling WSS client. Native root loading can
// touch disk and the OS certificate store, so keep it off the async runtime.
async fn tls_config() -> Result<Arc<rustls::ClientConfig>> {
    static CONFIG: tokio::sync::OnceCell<Arc<rustls::ClientConfig>> =
        tokio::sync::OnceCell::const_new();
    Ok(CONFIG
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(|| -> Result<_> {
                let builder = rustls::ClientConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()?;
                #[cfg(target_os = "android")]
                let builder = {
                    use rustls_platform_verifier::BuilderVerifierExt;
                    builder.with_platform_verifier()?
                };
                #[cfg(not(target_os = "android"))]
                let builder = {
                    let mut roots = rustls::RootCertStore::empty();
                    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
                    ensure!(!roots.is_empty(), "no usable native TLS roots");
                    builder.with_root_certificates(roots)
                };
                Ok(Arc::new(builder.with_no_client_auth()))
            })
            .await?
        })
        .await?
        .clone())
}
