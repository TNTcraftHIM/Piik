//! Actual-pump admission/Output worker regression. No decoder/network-capacity claim.
use super::*;
use crate::media::{
    self,
    clock::SourceTime,
    video::{EncodingDemand, Layers, Video},
    OutputStreams, Source, SourceFeed, SourceOrigin,
};
use rtc_shared::time::SystemInstant;

async fn add(runtime: &Runtime, pair: Uuid) -> Result<(Transport, mpsc::Receiver<Event>)> {
    crate::peer::tests::support::endpoint(runtime, pair, None).await
}

fn format() -> RtpCodec {
    RtpCodec {
        mime_type: "video/VP8".into(),
        clock_rate: 90_000,
        ..Default::default()
    }
}
fn packet() -> rtp::Packet {
    rtp::Packet {
        header: rtp::header::Header {
            version: 2,
            marker: true,
            sequence_number: 1,
            timestamp: 90_000,
            ..Default::default()
        },
        payload: vec![0x10, 0, 0, 0].into(),
    }
}

pub async fn run() -> Result<serde_json::Value> {
    demand_boundary()?;
    // A negotiated sender without any delivered ICE/DTLS packets has no sampled
    // send queue. None must never be interpreted as permission to enqueue AUs.
    let unconnected = Runtime::new(None);
    let pair = Uuid::new_v4();
    let (tx, _) = add(&unconnected, pair).await?;
    let id = Uuid::new_v4();
    let _ = tx
        .add_output(
            id,
            format(),
            MediaKind::Video,
            "unconnected".into(),
            vec![String::new()],
        )
        .await?;
    ensure!(tx.offer().await?, "missing unconnected offer");
    let (_, sdp) = tx.local_description().await?;
    let mut remote = Rtc::builder()
        .clear_codecs()
        .enable_vp8(true)
        .set_rtp_mode(true)
        .build(Instant::now());
    remote.add_local_candidate(Candidate::host(
        "127.0.0.1:9".parse::<std::net::SocketAddr>()?,
        "udp",
    )?);
    let answer = remote
        .sdp_api()
        .accept_offer(SdpOffer::from_sdp_string(&sdp)?)?;
    tx.accept("answer".into(), answer.to_sdp_string()).await?;
    let mut held = vec![packet()];
    for _ in 0..128 {
        held = tx
            .write_au(id, String::new(), held, Instant::now())
            .await?
            .context("unready sender admitted media")?;
    }
    tx.call(move |e| {
        let mid = e.outputs[&id].mid.unwrap();
        ensure!(
            !e.rtc.is_connected(),
            "negative control unexpectedly connected"
        );
        let mut direct = e.rtc.direct_api();
        let stream = direct.stream_tx_by_mid(mid, None).unwrap();
        ensure!(
            stream.queue_info().is_none_or(|q| q.packet_count() == 0),
            "unready queue accumulated media"
        );
        Ok(())
    })
    .await?;
    tx.close().await?;
    unconnected.close().await;

    let left = Runtime::new(None);
    let right = Runtime::new(None);
    let pair = Uuid::new_v4();
    let (tx, _) = add(&left, pair).await?;
    let (rx, mut events) = add(&right, pair).await?;
    let now = Instant::now();
    let time = SourceTime::local(now, SystemInstant::now(now));
    let q = Video::new(time.clone(), Arc::new(Notify::new()));
    let h = Video::new(time, Arc::new(Notify::new()));
    let layers = Layers::new(vec!["q".into(), "h".into()]);
    layers.insert("q".into(), q.clone());
    layers.insert("h".into(), h.clone());
    let source = Source {
        id: Uuid::new_v4(),
        publication_id: Uuid::new_v4(),
        origin: SourceOrigin::Incoming {
            pair: Uuid::new_v4(),
            flow_id: Uuid::new_v4(),
            stream: "generated-encoded-fixture".into(),
        },
        codec: format(),
        kind: MediaKind::Video,
        feed: SourceFeed::Video(h.clone()),
        layers: Some(layers.clone()),
    };
    let (failures, mut failed) = mpsc::channel(32);
    let output = media::Output::new(
        &tx,
        &source,
        "queue-output".into(),
        pair,
        (Uuid::new_v4(), MediaKind::Video),
        failures,
        OutputStreams::default(),
        true,
        false,
    )
    .await?;
    let sibling_id = Uuid::new_v4();
    let (_sibling_feedback, sibling_writable) = tx
        .add_output(
            sibling_id,
            format(),
            MediaKind::Video,
            "retirement-survivor".into(),
            vec![String::new()],
        )
        .await?;
    ensure!(tx.offer().await?, "missing actual Output offer");
    let (kind, sdp) = tx.local_description().await?;
    rx.accept(kind, sdp).await?;
    let (kind, sdp) = rx.local_description().await?;
    tx.accept(kind, sdp).await?;
    output.confirm(tx.confirm(output.id).await?.flatten())?;
    output.select_layers(&layers, EncodingDemand::Original, now)?;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !tx.call(|e| Ok(e.rtc.is_connected())).await? {
            tokio::task::yield_now().await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let output_id = output.id;
    let h_ssrc = tx
        .call(move |e| {
            let mid = e.outputs[&output_id].mid.unwrap();
            Ok(*e
                .rtc
                .direct_api()
                .stream_tx_by_mid(mid, Some(Rid::from("h")))
                .unwrap()
                .ssrc())
        })
        .await?;
    let frame = |length, at| crate::EncodedFrame {
        bytes: vec![0; length],
        presentation_time: at,
        keyframe: true,
        vp8: None,
    };
    q.write(frame(2 * 1024 * 1024, Instant::now()));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let queued = tx
                .call(move |e| {
                    let mid = e.outputs[&output_id].mid.unwrap();
                    Ok(e.rtc
                        .direct_api()
                        .stream_tx_by_mid(mid, Some(Rid::from("q")))
                        .unwrap()
                        .queue_info()
                        .is_some_and(|q| q.packet_count() > 0))
                })
                .await?;
            if queued {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await??;
    q.write(frame(512, Instant::now() + Duration::from_millis(1)));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !tx
            .call(move |e| Ok(e.outputs[&output_id].waiting.contains("q")))
            .await?
        {
            tokio::task::yield_now().await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    h.write(frame(64, Instant::now()));
    let track = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if let Event::Track(_, track) = event {
                return Ok::<_, anyhow::Error>(track);
            }
        }
        anyhow::bail!("missing incoming track")
    })
    .await??;
    let h_before_q_drained = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = track.poll().await {
            if let TrackEvent::Rtp(packet, ..) = event {
                if packet.header.ssrc == h_ssrc {
                    return tx
                        .call(move |e| Ok(e.outputs[&output_id].waiting.contains("q")))
                        .await;
                }
            }
        }
        anyhow::bail!("track closed before healthy RID advanced")
    })
    .await??;
    ensure!(
        h_before_q_drained,
        "healthy RID waited behind another RID's pending AU"
    );
    ensure!(
        failed.try_recv().is_err(),
        "temporary admission fullness failed the output"
    );
    let _ = tx.create_channel("withheld-stop-offer").await?;
    ensure!(tx.offer().await?, "missing withheld signaling offer");
    let (retired_ssrcs, queued_before, rtx_enabled) = tx
        .call(move |e| {
            ensure!(e.pending.is_some(), "offer was not withheld");
            let mid = e.outputs[&output_id].mid.unwrap();
            let mut direct = e.rtc.direct_api();
            let mut streams = Vec::new();
            let mut queued = 0;
            let mut rtx = false;
            for rid in ["q", "h"] {
                let stream = direct
                    .stream_tx_by_mid(mid, Some(Rid::from(rid)))
                    .context("retiring stream missing")?;
                streams.push(*stream.ssrc());
                queued += stream.queue_info().map_or(0, |q| q.packet_count());
                rtx |= stream.rtx().is_some();
            }
            Ok((streams, queued, rtx))
        })
        .await?;
    ensure!(
        queued_before > 0 && rtx_enabled,
        "gate did not own an admitted queue/RTX sender before retirement"
    );
    tokio::time::timeout(Duration::from_secs(2), output.close(&tx)).await?;
    let retired = retired_ssrcs.clone();
    tx.call(move |e| {
        ensure!(
            e.pending.is_some() && e.outputs[&output_id].retired,
            "retirement depended on SDP answer"
        );
        let sibling_mid = e.outputs[&sibling_id].mid.unwrap();
        let mut direct = e.rtc.direct_api();
        ensure!(
            retired
                .iter()
                .all(|ssrc| direct.stream_tx(&(*ssrc).into()).is_none()),
            "retired queue/cache owner remains sendable"
        );
        ensure!(
            direct.stream_tx_by_mid(sibling_mid, None).is_some(),
            "retirement removed sibling sender"
        );
        Ok(())
    })
    .await?;
    send(&tx, sibling_id, &sibling_writable, 90_000).await?;
    let survivor = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if let Event::Track(_, track) = event {
                if track.stream == "retirement-survivor" {
                    return Ok::<_, anyhow::Error>(track);
                }
            }
        }
        anyhow::bail!("surviving output did not arrive while stop offer was withheld")
    })
    .await??;
    receive(&survivor, 90_000).await?;
    // Finish the already pending exchange, then let the unchanged SDP owner
    // apply its deferred stop while the other output keeps its existing stream.
    for _ in 0..2 {
        let (kind, sdp) = tx.local_description().await?;
        rx.accept(kind, sdp).await?;
        let (kind, sdp) = rx.local_description().await?;
        tx.accept(kind, sdp).await?;
        if tx
            .call(move |e| Ok(!e.outputs.contains_key(&output_id)))
            .await?
        {
            break;
        }
        ensure!(tx.offer().await?, "deferred SDP stop offer missing");
    }
    tx.call(move |e| {
        ensure!(
            !e.outputs.contains_key(&output_id),
            "deferred stop spec not retired"
        );
        Ok(())
    })
    .await?;
    send(&tx, sibling_id, &sibling_writable, 93_000).await?;
    receive(&survivor, 93_000).await?;
    tx.close().await?;
    rx.close().await?;
    left.close().await;
    right.close().await;
    Ok(
        serde_json::json!({"passed":true,"unreadyAttempts":128,"unreadyAdmitted":0,"singleAuRepresentationBytes":2*1024*1024,"oneQueuedAuPerRid":true,"onePendingAuRetained":true,"healthyRidAdvancesWhileOtherPending":true,"blockedOutputCloseJoined":true,"queuedPacketsBeforeRetire":queued_before,"retiredPrimaryStreams":retired_ssrcs.len(),"rtxNegotiatedBeforeRetire":rtx_enabled,"retiredQueueAndRtxOwnerAbsentBeforeSdpAnswer":true,"otherOutputAdvancesWhileStopOfferWithheld":true,"laterSdpStopCompletes":true,"otherOutputAdvancesAfterStop":true,"pacerAlgorithm":"unmodified str0m GCC/pacer/RTX","capacityRecoveryClaim":false,"decoderPlaybackClaim":false}),
    )
}

async fn send(tx: &Transport, id: Uuid, writable: &Notify, timestamp: u32) -> Result<()> {
    let mut packet = packet();
    packet.header.timestamp = timestamp;
    let mut pending = vec![packet];
    loop {
        let notified = writable.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        match tx
            .write_au(id, String::new(), pending, Instant::now())
            .await?
        {
            None => return Ok(()),
            Some(au) => pending = au,
        }
        notified.await;
    }
}
async fn receive(track: &Track, timestamp: u32) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = track.poll().await {
            if let TrackEvent::Rtp(packet, ..) = event {
                if packet.header.timestamp == timestamp {
                    return Ok::<_, anyhow::Error>(());
                }
            }
        }
        anyhow::bail!("surviving sender stopped")
    })
    .await?
}

pub fn demand_boundary() -> Result<serde_json::Value> {
    ensure!(desired_bps(None) == 100_000_000, "unknown ceiling lost");
    ensure!(desired_bps(Some(0)) == 0, "idle ceiling became demand");
    ensure!(
        desired_bps(Some(750_000)) == 750_000,
        "configured ceiling changed"
    );
    Ok(
        serde_json::json!({"passed":true,"unknown":100_000_000,"idle":0,"configured":750_000,"scope":"typed transport demand translation; library probe control reviewed separately"}),
    )
}
