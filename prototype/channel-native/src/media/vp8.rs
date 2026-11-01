//! VP8 descriptor facts retained with their complete encoded frame.
use bytes::Bytes;
use rtc::{
    rtp::{codec::vp8::Vp8Packet, packetizer::Depacketizer},
    shared::error::Result,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vp8PictureId {
    pub value: u16,
    pub extended: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Vp8FrameMetadata {
    pub non_reference: bool,
    pub picture_id: Option<Vp8PictureId>,
    pub tl0_pic_idx: Option<u8>,
    pub temporal_id: Option<u8>,
    pub layer_sync: bool,
    pub key_idx: Option<u8>,
}

#[derive(Default)]
pub(crate) struct Vp8Frame(Vp8FrameMetadata);

impl Vp8Frame {
    pub fn metadata(&self) -> Vp8FrameMetadata {
        self.0
    }
}

impl Depacketizer for Vp8Frame {
    fn depacketize(&mut self, payload: &Bytes) -> Result<Bytes> {
        // Optional fields belong to this packet, never to the preceding one.
        let mut packet = Vp8Packet::default();
        let data = packet.depacketize(payload)?;
        self.0 = Vp8FrameMetadata {
            non_reference: packet.n != 0,
            picture_id: (packet.i != 0).then(|| Vp8PictureId {
                value: packet.picture_id,
                // The SDK exposes PictureID's value but not its encoded width.
                extended: payload[2] & 0x80 != 0,
            }),
            tl0_pic_idx: (packet.l != 0).then_some(packet.tl0_pic_idx),
            temporal_id: (packet.t != 0).then_some(packet.tid),
            // Y is meaningful with KEYIDX even when TID is absent (RFC 7741).
            layer_sync: (packet.t != 0 || packet.k != 0)
                && payload[payload.len() - data.len() - 1] & 0x20 != 0,
            key_idx: (packet.k != 0).then_some(packet.key_idx),
        };
        Ok(data)
    }

    fn is_partition_head(&self, payload: &Bytes) -> bool {
        // A complete frame starts at partition zero; other partition heads
        // remain part of the same access unit.
        Vp8Packet::default().is_partition_head(payload) && payload[0] & 0x07 == 0
    }

    fn is_partition_tail(&self, marker: bool, payload: &Bytes) -> bool {
        Vp8Packet::default().is_partition_tail(marker, payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{clock::SourceTime, incoming::Incoming};
    use rtc::rtp::{Header, Packet};
    use std::{sync::Arc, time::Instant};
    use tokio::sync::Notify;

    #[test]
    fn incoming_au_retains_head_metadata_and_absent_fields() -> anyhow::Result<()> {
        let now = Instant::now();
        let mut incoming = Incoming::with_time(
            "video/VP8",
            SourceTime::incoming(now, 0, Default::default()),
            Arc::new(Notify::new()),
        );
        let full = Vp8FrameMetadata {
            picture_id: Some(Vp8PictureId {
                value: 1,
                extended: true,
            }),
            tl0_pic_idx: Some(0x33),
            temporal_id: Some(0),
            layer_sync: true,
            key_idx: Some(7),
            ..Default::default()
        };
        let frames = [
            (
                vec![vec![0x90, 0xf0, 0x80, 1, 0x33, 0x27, 0, 0x55, 0x55]],
                vec![0, 0x55, 0x55],
                full,
            ),
            (
                vec![
                    vec![0xb0, 0xf0, 2, 0x33, 0xa7, 1, 0x55, 0x55],
                    vec![0, 0x66, 0x77, 0x88],
                ],
                vec![1, 0x55, 0x55, 0x66, 0x77, 0x88],
                Vp8FrameMetadata {
                    non_reference: true,
                    picture_id: Some(Vp8PictureId {
                        value: 2,
                        extended: false,
                    }),
                    temporal_id: Some(2),
                    ..full
                },
            ),
            (
                vec![vec![0x10, 0, 0x44, 0x55]],
                vec![0, 0x44, 0x55],
                Vp8FrameMetadata::default(),
            ),
            (
                vec![vec![0x90, 0x10, 0x28, 0, 0x44, 0x55]],
                vec![0, 0x44, 0x55],
                Vp8FrameMetadata {
                    layer_sync: true,
                    key_idx: Some(8),
                    ..Default::default()
                },
            ),
        ];
        let mut sequence = 0;
        for (index, (packets, bytes, metadata)) in frames.into_iter().enumerate() {
            let last = packets.len() - 1;
            for (fragment, payload) in packets.into_iter().enumerate() {
                sequence += 1;
                incoming.push(
                    sequence.into(),
                    index as u64 * 3000,
                    Packet {
                        header: Header {
                            sequence_number: sequence,
                            timestamp: index as u32 * 3000,
                            marker: fragment == last,
                            ..Default::default()
                        },
                        payload: payload.into(),
                    },
                );
            }
            let frame = incoming.pop()?.expect("complete VP8 frame");
            assert_eq!(frame.bytes, bytes);
            assert_eq!(frame.vp8, Some(metadata));
            assert!(incoming.pop()?.is_none());
        }
        Ok(())
    }
}
