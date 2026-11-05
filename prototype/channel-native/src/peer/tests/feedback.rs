//! Real SDP/DTLS/SRTP/RTCP feedback to the selected complete-frame feed.
use super::*;
use crate::media::{
    self,
    clock::SourceTime,
    video::{EncodingDemand, Layers, Video},
    OutputStreams, Source, SourceFeed, SourceOrigin,
};
use rtc_shared::time::SystemInstant;

async fn receive(track: &Track, ssrc: u32) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = track.poll().await {
            if let TrackEvent::Rtp(packet, ..) = event {
                if packet.header.ssrc == ssrc && packet.header.marker {
                    return Ok(());
                }
            }
        }
        anyhow::bail!("feedback control lost its live sender")
    })
    .await?
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keyframe_feedback_preserves_rid_and_shared_siblings() -> Result<()> {
    let left = Runtime::new(None);
    let right = Runtime::new(None);
    let pair = Uuid::new_v4();
    let (tx, _) = crate::peer::tests::support::endpoint(&left, pair, None).await?;
    let (rx, mut events) = crate::peer::tests::support::endpoint(&right, pair, None).await?;
    let now = Instant::now();
    let time = SourceTime::local(now, SystemInstant::now(now));
    let q = Video::new(time.clone(), Arc::new(Notify::new()));
    let h = Video::new(time, Arc::new(Notify::new()));
    let healthy = h.subscribe();
    let layers = Layers::new(vec!["q".into(), "h".into()]);
    layers.insert("q".into(), q.clone());
    layers.insert("h".into(), h.clone());
    let source = Source {
        id: Uuid::new_v4(),
        publication_id: Uuid::new_v4(),
        origin: SourceOrigin::Incoming {
            pair: Uuid::new_v4(),
            flow_id: Uuid::new_v4(),
            stream: "shared-feedback-source".into(),
            reader: Uuid::new_v4(),
        },
        codec: RtpCodec {
            mime_type: "video/VP8".into(),
            clock_rate: 90_000,
            ..Default::default()
        },
        kind: MediaKind::Video,
        feed: SourceFeed::Video(h.clone()),
        layers: Some(layers.clone()),
    };
    let (failures, mut failed) = mpsc::channel(8);
    let layered = media::Output::new(
        &tx,
        &source,
        "layered".into(),
        pair,
        (Uuid::new_v4(), MediaKind::Video),
        failures.clone(),
        OutputStreams::default(),
        true,
        false,
    )
    .await?;
    let ordinary = media::Output::new(
        &tx,
        &source,
        "ordinary".into(),
        pair,
        (Uuid::new_v4(), MediaKind::Video),
        failures,
        OutputStreams::default(),
        false,
        false,
    )
    .await?;
    ensure!(tx.offer().await?);
    let (kind, sdp) = tx.local_description().await?;
    rx.accept(kind, sdp).await?;
    let (kind, sdp) = rx.local_description().await?;
    tx.accept(kind, sdp).await?;
    for output in [&layered, &ordinary] {
        output.confirm(tx.confirm(output.id).await?.flatten())?;
        output.select_layers(&layers, EncodingDemand::Original, now)?;
    }
    let layered_id = layered.id;
    let ordinary_id = ordinary.id;
    let (q_ssrc, h_ssrc, ordinary_ssrc) = tx
        .call(move |e| {
            let mid = e.outputs[&layered_id].mid.unwrap();
            let ordinary = e.outputs[&ordinary_id].mid.unwrap();
            let mut direct = e.rtc.direct_api();
            let q = *direct
                .stream_tx_by_mid(mid, Some(Rid::from("q")))
                .unwrap()
                .ssrc();
            let h = *direct
                .stream_tx_by_mid(mid, Some(Rid::from("h")))
                .unwrap()
                .ssrc();
            let ordinary = *direct.stream_tx_by_mid(ordinary, None).unwrap().ssrc();
            Ok((q, h, ordinary))
        })
        .await?;
    let frame = || crate::EncodedFrame {
        bytes: vec![0; 64],
        presentation_time: Instant::now(),
        keyframe: true,
        vp8: None,
    };
    q.write(frame());
    h.write(frame());
    healthy
        .recv()
        .await
        .context("healthy h reader did not start")?;
    let mut tracks = HashMap::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while tracks.len() < 2 {
            if let Some(Event::Track(_, track)) = events.recv().await {
                tracks.insert(track.stream.clone(), track);
            }
        }
    })
    .await?;
    let layered_track = &tracks["layered"];
    let ordinary_track = &tracks["ordinary"];
    // Receive both RIDs before issuing feedback, independently of their order.
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut seen = HashSet::new();
        while seen.len() < 2 {
            if let Some(TrackEvent::Rtp(packet, ..)) = layered_track.poll().await {
                seen.insert(packet.header.ssrc);
            }
        }
        ensure!(seen == HashSet::from([q_ssrc, h_ssrc]));
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    receive(ordinary_track, ordinary_ssrc).await?;
    let mut q_requests = q.requests();
    let mut h_requests = h.requests();
    let q_before = *q_requests.borrow_and_update();
    let h_before = *h_requests.borrow_and_update();
    layered_track.request_keyframe(q_ssrc).await?;
    tokio::time::timeout(Duration::from_secs(5), q_requests.changed()).await??;
    h.write(frame());
    let (feed, _) = healthy
        .recv_with_source()
        .await
        .context("healthy h reader stopped")?;
    ensure!(feed.same(&h));
    receive(layered_track, h_ssrc).await?;
    receive(ordinary_track, ordinary_ssrc).await?;
    let q_after = *q_requests.borrow();
    let h_after = *h_requests.borrow();
    println!("RID_KEYFRAME_OBSERVATION qRequests={} hRequests={} healthyFeedRetained=true healthyRtpRetained=true", q_after - q_before, h_after - h_before);
    ensure!(q_after > q_before, "q PLI did not refresh q");
    ensure!(
        h_after == h_before,
        "q PLI refreshed the unrelated shared h feed"
    );

    // An SDK None RID addresses only the ordinary encoding. Missing/unknown
    // RIDs on a simulcast MID do not expand into whole-source requests.
    tx.call(move |e| {
        let mid = e.outputs[&layered_id].mid.unwrap();
        for rid in [None, Some(Rid::from("unknown"))] {
            e.event(RtcEvent::KeyframeRequest(str0m::media::KeyframeRequest {
                mid,
                rid,
                kind: str0m::media::KeyframeRequestKind::Pli,
            }));
        }
        Ok(())
    })
    .await?;
    ordinary_track.request_keyframe(ordinary_ssrc).await?;
    tokio::time::timeout(Duration::from_secs(5), h_requests.changed()).await??;
    ensure!(*q_requests.borrow() == q_after);
    ensure!(*h_requests.borrow() == h_after + 1);
    ordinary.close(&tx).await;
    tx.call(move |e| {
        let mid = e.outputs[&ordinary_id].mid.unwrap();
        e.event(RtcEvent::KeyframeRequest(str0m::media::KeyframeRequest {
            mid,
            rid: None,
            kind: str0m::media::KeyframeRequestKind::Pli,
        }));
        Ok(())
    })
    .await?;
    h.write(frame());
    healthy
        .recv()
        .await
        .context("retiring another output stopped the h reader")?;
    receive(layered_track, h_ssrc).await?;
    ensure!(*q_requests.borrow() == q_after && *h_requests.borrow() == h_after + 1);
    ensure!(failed.try_recv().is_err());
    println!("RID_KEYFRAME_BOUNDARY ordinaryRidEmpty=true unknownRidIgnored=true retiredOutputIgnored=true");
    healthy.close();
    layered.close(&tx).await;
    tx.close().await?;
    rx.close().await?;
    left.close().await;
    right.close().await;
    Ok(())
}
