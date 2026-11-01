//! Descriptor numbering for one output's complete, ordered VP8 frames.
use crate::media::vp8::Vp8FrameMetadata;
use anyhow::Result;
use bytes::BytesMut;
use rtc_rtp::codec::vp8::Vp8Packet;
use rtc_rtp::packetizer::Depacketizer;
use rtc_rtp::Packet;

// Stock VP8 already emits PictureID; only L and T/K add bytes.
pub(super) const DESCRIPTOR_GROWTH: usize = 2;

#[derive(Default)]
pub(super) struct Descriptor {
    tl0_pic_idx: u8,
    key_idx: u8,
}

impl Descriptor {
    pub fn rewrite(
        &mut self,
        packets: &mut [Packet],
        metadata: Option<Vp8FrameMetadata>,
        keyframe: bool,
    ) -> Result<()> {
        let Some(first) = packets.first() else {
            return Ok(());
        };
        // Incoming loss and output queue drops recover at a keyframe. A source
        // switch keeps this output's counters, as it does RTP and PictureID.
        if metadata.and_then(|m| m.temporal_id).unwrap_or(0) == 0 {
            self.tl0_pic_idx = self.tl0_pic_idx.wrapping_add(1);
        }
        // RFC 7741 permits incrementing on every keyframe without interpreting
        // the codec's critical-parameter changes.
        if keyframe {
            self.key_idx = (self.key_idx + 1) & 0x1f;
        }
        let Some(metadata) = metadata else {
            return Ok(());
        };

        let mut stock = Vp8Packet::default();
        let data = stock.depacketize(&first.payload)?;
        let old_header_size = first.payload.len() - data.len();
        let flags = (u8::from(metadata.picture_id.is_some()) << 7)
            | (u8::from(metadata.tl0_pic_idx.is_some()) << 6)
            | (u8::from(metadata.temporal_id.is_some()) << 5)
            | (u8::from(metadata.key_idx.is_some()) << 4);
        let mut header = [0u8; 6];
        header[0] = (u8::from(flags != 0) << 7) | (u8::from(metadata.non_reference) << 5);
        let mut size = 1;
        if flags != 0 {
            header[size] = flags;
            size += 1;
        }
        if metadata.picture_id.is_some() {
            // Both value and M belong to the SDK's outbound sequence. A source
            // switching its own PictureID width cannot truncate that sequence.
            let picture_id = &first.payload[2..old_header_size];
            header[size..size + picture_id.len()].copy_from_slice(picture_id);
            size += picture_id.len();
        }
        if metadata.tl0_pic_idx.is_some() {
            header[size] = self.tl0_pic_idx;
            size += 1;
        }
        if metadata.temporal_id.is_some() || metadata.key_idx.is_some() {
            header[size] = (metadata.temporal_id.unwrap_or(0) << 6)
                | (u8::from(metadata.layer_sync) << 5)
                | metadata.key_idx.map_or(0, |_| self.key_idx);
            size += 1;
        }
        for packet in packets {
            // The SDK fragments the whole AU with PID=0 and S on its first
            // packet; its marker, sequence and timestamp remain untouched.
            header[0] = (header[0] & !0x10) | (packet.payload[0] & 0x10);
            let data = &packet.payload[old_header_size..];
            let mut payload = BytesMut::with_capacity(size + data.len());
            payload.extend_from_slice(&header[..size]);
            payload.extend_from_slice(data);
            packet.payload = payload.freeze();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::RtpCodec;
    use crate::media::{
        clock::SourceTime,
        incoming::Incoming,
        packetizer::Packetizer,
        video::Video,
        vp8::{Vp8Frame, Vp8PictureId},
        EncodedFrame,
    };
    use rtc_shared::marshal::MarshalSize;
    use std::{sync::Arc, time::Duration, time::Instant};
    use tokio::sync::Notify;

    #[test]
    fn complete_aus_keep_temporal_semantics_across_sources_and_fragmentation() -> Result<()> {
        let now = Instant::now();
        let time = SourceTime::incoming(now, 0, Default::default());
        let q = Video::new(time.clone(), Arc::new(Notify::new()));
        let h = Video::new(time.clone(), Arc::new(Notify::new()));
        let mut output = Packetizer::new(
            &RtpCodec {
                mime_type: "video/VP8".into(),
                clock_rate: 90_000,
                ..Default::default()
            },
            96,
            42,
            time.clone(),
            Default::default(),
        )?;
        let mut received = Incoming::with_time("video/VP8", time, Arc::new(Notify::new()));
        let mut sent = 0u16;
        let mut received_sequence = 0u64;
        let mut previous_sequence: Option<u16> = None;
        // Switch from a short-PictureID source to a long one and back, crossing
        // the output's own 7/15-bit transition and KEYIDX wrap in the process.
        for index in 0..132u16 {
            let tid = [0, 2, 1, 2][usize::from(index % 4)];
            if index == 65 {
                continue; // An intentionally omitted, non-reference T2 AU.
            }
            let high = (64..128).contains(&index);
            let metadata = Vp8FrameMetadata {
                non_reference: tid == 2,
                picture_id: Some(Vp8PictureId {
                    value: if high {
                        10_000 + index - 64
                    } else {
                        index & 0x7f
                    },
                    extended: high,
                }),
                tl0_pic_idx: Some((index / 4) as u8 + if high { 100 } else { 0 }),
                temporal_id: Some(tid),
                layer_sync: true,
                key_idx: Some(7),
            };
            let frame = EncodedFrame {
                bytes: [vec![u8::from(tid != 0)], vec![0x55; 3000]].concat(),
                presentation_time: now + Duration::from_millis(u64::from(index) * 50),
                keyframe: tid == 0,
                vp8: Some(metadata),
            };
            let expected = Vp8FrameMetadata {
                picture_id: Some(Vp8PictureId {
                    value: sent,
                    extended: sent > 127,
                }),
                tl0_pic_idx: Some((index / 4 + 1) as u8),
                key_idx: Some(((index / 4 + 1) & 0x1f) as u8),
                ..metadata
            };
            let packets = output.packetize_source(if high { &h } else { &q }, &frame)?;
            assert!(packets.len() > 1);
            for (part, packet) in packets.iter().enumerate() {
                assert!(packet.marshal_size() <= 1200);
                assert_eq!(packet.payload[0] & 0x17, if part == 0 { 0x10 } else { 0 });
                assert_eq!(packet.header.marker, part + 1 == packets.len());
                if let Some(previous) = previous_sequence {
                    assert_eq!(packet.header.sequence_number, previous.wrapping_add(1));
                }
                previous_sequence = Some(packet.header.sequence_number);
                let mut descriptor = Vp8Frame::default();
                descriptor.depacketize(&packet.payload)?;
                assert_eq!(descriptor.metadata(), expected);
                received.push(
                    received_sequence,
                    packet.header.timestamp.into(),
                    packet.clone(),
                );
                received_sequence += 1;
            }
            let assembled = received.pop()?.expect("repacketized complete AU");
            assert_eq!(assembled.bytes, frame.bytes);
            assert_eq!(assembled.vp8, Some(expected));
            sent += 1;
        }

        // Optional-field absence and K-only Y must survive too. A producer with
        // no metadata keeps the existing SDK PictureID-only output.
        for metadata in [
            Some(Vp8FrameMetadata::default()),
            Some(Vp8FrameMetadata {
                layer_sync: true,
                key_idx: Some(12),
                ..Default::default()
            }),
            None,
        ] {
            let packets = output.packetize(vec![0, 0x55, 0x55], now, metadata)?;
            let mut descriptor = Vp8Frame::default();
            assert_eq!(
                &descriptor.depacketize(&packets[0].payload)?[..],
                [0, 0x55, 0x55]
            );
            let actual = descriptor.metadata();
            let original = metadata.unwrap_or_default();
            assert_eq!(actual.temporal_id, original.temporal_id);
            assert_eq!(actual.tl0_pic_idx, original.tl0_pic_idx);
            assert_eq!(actual.layer_sync, original.layer_sync);
            assert_eq!(actual.key_idx.is_some(), original.key_idx.is_some());
            assert_eq!(actual.picture_id.is_some(), metadata.is_none());
        }
        Ok(())
    }
}
