//! Allocate one physical connection's target to its actual local video outputs.
use super::*;

impl Driver {
    #[cfg(target_os = "windows")]
    pub(super) fn reconcile_encodings(&mut self) {
        use crate::media::local;
        let now = Instant::now();
        let mut demands: HashMap<Uuid, Vec<local::VideoDemand>> = HashMap::new();
        for pair in self.pairs.values_mut() {
            let target = *pair.bandwidth.borrow_and_update() as u64;
            let mut videos = Vec::new();
            let mut inputs = HashMap::new();
            let mut opaque = 0;
            for (key, output) in &mut pair.outputs {
                if !pair
                    .stable_outputs
                    .as_ref()
                    .is_some_and(|ids| ids.contains(&output.id))
                {
                    continue;
                }
                if let Some((publication, producer)) = self
                    .captures
                    .iter()
                    .find(|(_, producer)| producer.video == output.source)
                {
                    if let Some(input) = output.video_input() {
                        videos.push(VideoRequest {
                            id: output.id,
                            cap_bps: producer.settings.bitrate,
                            selected: pair
                                .plan
                                .outgoing
                                .iter()
                                .any(|flow| flow.id == key.0 && flow.selected),
                        });
                        inputs.insert(output.id, (*publication, input));
                    }
                } else if self
                    .captures
                    .values()
                    .any(|producer| producer.audio == Some(output.source))
                {
                    opaque += output.bitrate(now).max(u64::from(local::AUDIO_BITRATE));
                } else {
                    opaque += output.bitrate(now);
                }
            }
            for (output, bitrate) in allocate(target, opaque, &videos) {
                let (publication, input) = inputs.remove(&output).unwrap();
                demands
                    .entry(publication)
                    .or_default()
                    .push(local::VideoDemand {
                        output,
                        input,
                        bitrate,
                    });
            }
        }
        for (publication, producer) in &self.captures {
            let mut current = demands.remove(publication).unwrap_or_default();
            current.sort_unstable_by_key(|demand| demand.output);
            producer.set_demands(current);
        }
    }
}

struct VideoRequest {
    pub id: Uuid,
    /// The source's configured ceiling, not its currently reduced encoder rate.
    pub cap_bps: u32,
    pub selected: bool,
}

/// `videos` contains confirmed senders only. `opaque_bps` is the cost of the
/// connection's other RTP outputs; those streams are not controlled here.
///
/// Within each class, configured ceilings are the allocation weights. As in
/// libwebrtc's relative allocation, cap each result at its requested maximum:
/// https://webrtc.googlesource.com/src/+/main/call/bitrate_allocator.cc
/// Optional route overlap uses only what remains after selected video demand.
/// Results preserve input order and include zero allocations without a floor.
fn allocate(target_bps: u64, opaque_bps: u64, videos: &[VideoRequest]) -> Vec<(Uuid, u32)> {
    let mut remaining = u128::from(target_bps.saturating_sub(opaque_bps));
    let mut allocations: Vec<_> = videos.iter().map(|video| (video.id, 0)).collect();
    for selected in [true, false] {
        let total: u128 = videos
            .iter()
            .filter(|video| video.selected == selected)
            .map(|video| u128::from(video.cap_bps))
            .sum();
        if total == 0 {
            continue;
        }
        let budget = remaining.min(total);
        for (video, (_, allocation)) in videos.iter().zip(&mut allocations) {
            if video.selected == selected {
                *allocation = (budget * u128::from(video.cap_bps) / total) as u32;
            }
        }
        remaining -= budget;
    }
    allocations
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(id: u128, cap_bps: u32, selected: bool) -> VideoRequest {
        VideoRequest {
            id: Uuid::from_u128(id),
            cap_bps,
            selected,
        }
    }

    #[test]
    fn two_selected_screens_share_one_target_after_opaque_rtp() {
        let videos = [
            video(1, 1_200_000, true),
            video(2, 600_000, true),
            video(3, 600_000, false),
        ];
        assert_eq!(
            allocate(1_200_000, 300_000, &videos),
            vec![
                (videos[0].id, 600_000),
                (videos[1].id, 300_000),
                (videos[2].id, 0)
            ]
        );

        // Retiring one real output releases its share without changing a room.
        assert_eq!(
            allocate(1_200_000, 300_000, &videos[..1]),
            vec![(videos[0].id, 900_000)]
        );
        assert_eq!(
            allocate(200_000, 300_000, &videos),
            vec![(videos[0].id, 0), (videos[1].id, 0), (videos[2].id, 0)]
        );
    }

    #[test]
    fn optional_overlap_uses_residual_and_never_exceeds_its_source_cap() {
        let videos = [video(1, 1_000_000, true), video(2, 800_000, false)];
        assert_eq!(
            allocate(1_700_000, 200_000, &videos),
            vec![(videos[0].id, 1_000_000), (videos[1].id, 500_000)]
        );
        assert_eq!(
            allocate(3_000_000, 200_000, &videos),
            vec![(videos[0].id, 1_000_000), (videos[1].id, 800_000)]
        );
    }
}
