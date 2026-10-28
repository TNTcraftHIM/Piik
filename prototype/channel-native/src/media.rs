//! One output RTP clock belongs to one received source track. A source replacement
//! creates a new sender/SSRC; clocks from different sources are never spliced.
use anyhow::Result;
use rtc::{
    media_stream::MediaStreamTrack,
    rtp,
    rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{sync::mpsc, task::JoinHandle};
use uuid::Uuid;
use webrtc::{
    media_stream::track_local::{static_rtp::TrackLocalStaticRTP, TrackLocal},
    peer_connection::PeerConnection,
    rtp_transceiver::RtpSender,
};

#[derive(Clone)]
pub(crate) struct Source {
    pub id: Uuid,
    pub pair: Uuid,
    pub stream: String,
    pub codec: RTCRtpCodec,
    pub ssrc: u32,
}

pub(crate) struct Output {
    pub source: Uuid,
    pub stream: String,
    pub sender: Arc<dyn RtpSender>,
    packets: mpsc::Sender<rtp::Packet>,
    task: JoinHandle<()>,
}
impl Output {
    pub async fn new(pc: &dyn PeerConnection, source: &Source) -> Result<Self> {
        let id = Uuid::new_v4();
        let ssrc = u32::from_be_bytes(id.as_bytes()[..4].try_into().unwrap());
        let stream = id.to_string();
        let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
            stream.clone(),
            Uuid::new_v4().to_string(),
            "Opus relay".into(),
            RtpCodecKind::Audio,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                codec: source.codec.clone(),
                ..Default::default()
            }],
        )));
        let sender = pc.add_track(track.clone()).await?;
        // Independent media writers prevent a slow child from holding another child
        // or the PC control actor. Overflow drops real-time audio, never reliable DC.
        let (packets, mut rx) = mpsc::channel::<rtp::Packet>(1);
        let negotiated = sender.clone();
        let task = tokio::spawn(async move {
            while let Some(packet) = rx.recv().await {
                let Ok(parameters) = negotiated.get_parameters().await else {
                    break;
                };
                let Some(codec) = parameters
                    .rtp_parameters
                    .codecs
                    .iter()
                    .find(|codec| codec.rtp_codec.mime_type.eq_ignore_ascii_case("audio/opus"))
                else {
                    continue;
                };
                // The sender owns negotiated PT (e.g. a remote offer may use 109).
                // Construct a hop-local header: no upstream TWCC/abs-send-time/CSRC.
                let packet = rtp::Packet {
                    header: rtp::header::Header {
                        version: 2,
                        marker: packet.header.marker,
                        payload_type: codec.payload_type,
                        sequence_number: packet.header.sequence_number,
                        timestamp: packet.header.timestamp,
                        ssrc,
                        ..Default::default()
                    },
                    payload: packet.payload,
                };
                if track.write_rtp(packet).await.is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            source: source.id,
            stream,
            sender,
            packets,
            task,
        })
    }
    pub fn sink(&self) -> mpsc::Sender<rtp::Packet> {
        self.packets.clone()
    }
    pub async fn close(self, pc: &dyn PeerConnection) {
        self.task.abort();
        let _ = self.task.await;
        let _ = pc.remove_track(&self.sender).await;
    }
}

// A transport projection, not a route planner. The control owner installs its
// current source identity and writer handles; readers hold this lock only long
// enough to enqueue one packet. No SDP, SQLite, or signaling await is on this path.
#[derive(Clone, Default)]
pub(crate) struct Relay(Arc<Mutex<HashMap<Uuid, (Uuid, Vec<mpsc::Sender<rtp::Packet>>)>>>);
impl Relay {
    pub fn set(&self, publication: Uuid, source: Uuid, targets: Vec<mpsc::Sender<rtp::Packet>>) {
        self.0
            .lock()
            .unwrap()
            .insert(publication, (source, targets));
    }
    pub fn retain(&self, publications: &std::collections::HashSet<Uuid>) {
        self.0
            .lock()
            .unwrap()
            .retain(|id, _| publications.contains(id));
    }
    pub fn write(&self, publication: Uuid, source: Uuid, packet: rtp::Packet) {
        let routes = self.0.lock().unwrap();
        if let Some((active, targets)) = routes.get(&publication) {
            if *active == source {
                for target in targets {
                    let _ = target.try_send(packet.clone());
                }
            }
        }
    }
}
