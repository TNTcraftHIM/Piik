use super::*;
use support::{send, vp8, Fixture};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opus_starts_with_fresh_audio_and_preserves_source_timestamp_gaps() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let sink = f.sink;
        let flow = f.plans.last().unwrap().outgoing[0].id;
        // Establish the room's base connection before introducing source audio.
        f.tick.reset_after(Duration::from_secs(30));
        f.until(|f| {
            f.driver.pairs[&sink].connected()
                && f.driver.pairs[&sink].pending_offer.is_none()
        })
        .await?;
        f.withheld.insert(sink);
        f.tick.reset();
        f.until(|f| {
            f.frame >= 8
                && f.driver.pairs[&sink]
                    .outputs
                    .contains_key(&(flow, RtpCodecKind::Audio))
                && f.driver.pairs[&sink].pending_offer.is_some()
        })
        .await?;
        f.tick.reset_after(Duration::from_secs(30));

        let output = &f.driver.pairs[&sink].outputs[&(flow, RtpCodecKind::Audio)];
        let stream = output.stream.clone();
        let source = output.source;
        let mut targets: Vec<_> = output.rtp_sink().into_iter().collect();
        let (audit, mut arrived) = mpsc::channel(16);
        targets.push(audit);
        f.driver.relay.set(source, targets);
        let parent = &f.parents[0];
        let upstream = f.remote[&parent.pair].clone();
        let audio = parent.audio;
        let writable = f.writable[&audio].clone();
        let frame = f.frame + 1;
        let stale_timestamp = parent.base.wrapping_add(frame * 960);
        let at = f.epoch + Duration::from_millis(u64::from(frame - 1) * 20);
        let packet = |timestamp| rtp::Packet {
            header: rtp::header::Header {
                version: 2,
                marker: true,
                timestamp,
                ..Default::default()
            },
            payload: vec![0xf8, 0xff, 0xfe].into(),
        };
        send(
            &upstream,
            audio,
            vec![packet(stale_timestamp)],
            at,
            &writable,
        )
        .await?;
        // Observe real ingress before releasing SDP, without replacing a route
        // or relying on a sleep to decide whether old audio already arrived.
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let received = arrived.recv().await.context("source observer retired")?;
                if received.header.timestamp == stale_timestamp {
                    return Ok::<_, anyhow::Error>(());
                }
            }
        })
        .await??;
        f.release_offer(sink).await?;
        f.until(|f| {
            f.driver.pairs[&sink]
                .stable_outputs
                .as_ref()
                .is_some_and(|outputs| {
                    outputs.contains(
                        &f.driver.pairs[&sink].outputs[&(flow, RtpCodecKind::Audio)].id,
                    )
                })
        })
        .await?;

        let intervals = [960, 2880, 3840];
        let expected = intervals.map(|ticks| stale_timestamp.wrapping_add(ticks));
        for (timestamp, ticks) in expected.into_iter().zip(intervals) {
            send(
                &upstream,
                audio,
                vec![packet(timestamp)],
                at + Duration::from_millis(u64::from(ticks) / 48),
                &writable,
            )
            .await?;
        }
        f.until(|f| {
            f.tracks.values().any(|track| {
                track.stream == stream
                    && track.kind == RtpCodecKind::Audio
                    && f.packets.get(&track.id).is_some_and(|packets| packets.len() >= 3)
            })
        })
        .await?;
        let track = f
            .tracks
            .values()
            .find(|track| track.stream == stream && track.kind == RtpCodecKind::Audio)
            .unwrap();
        let actual: Vec<_> = f.packets[&track.id]
            .iter()
            .map(|packet| packet.header.timestamp)
            .collect();
        ensure!(
            actual == expected,
            "unnegotiated Opus replayed or source timestamp gaps changed: {actual:?}, expected {expected:?}"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    f.close().await;
    result.context("real Opus startup did not complete")?
}
