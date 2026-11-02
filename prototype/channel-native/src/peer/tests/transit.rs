//! Still-applicable source/base lifetime assertions, through current real endpoints.
use super::*;
use support::{vp8, Fixture};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selected_screen_metrics_keep_room_voice_and_exclude_other_room() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let mut voice = f.publication.clone();
    voice.id = Uuid::new_v4();
    voice.kind = piik_channel_core::wire::Kind::Voice;
    let voice_input = f.plans[1].incoming[0].id;
    let voice_output = f.plans.iter().find(|p| p.id == f.sink).unwrap().outgoing[1].id;
    for plan in &mut f.plans {
        for flow in plan.incoming.iter_mut().chain(&mut plan.outgoing) {
            if flow.id == voice_input || flow.id == voice_output {
                flow.publication_id = voice.id;
            }
        }
    }
    f.driver
        .update(
            f.plans.clone(),
            vec![f.publication.clone(), voice.clone()],
            vec![],
        )
        .await?;
    f.until(|f| f.frame >= 70).await?;
    let measured = f
        .driver
        .connection_metrics("room", Some(f.publication.id))
        .await?;
    let streams: Vec<_> = measured.iter().flat_map(|pair| &pair.streams).collect();
    ensure!(streams
        .iter()
        .any(|stream| stream.publication_id == f.publication.id && stream.media == "video"));
    ensure!(streams
        .iter()
        .any(|stream| stream.publication_id == voice.id && stream.media == "audio"));
    ensure!(f
        .driver
        .connection_metrics("other", Some(f.publication.id))
        .await?
        .is_empty());
    voice.room_id = "other".into();
    f.driver
        .update(
            f.plans.clone(),
            vec![f.publication.clone(), voice.clone()],
            vec![],
        )
        .await?;
    let measured = f
        .driver
        .connection_metrics("room", Some(f.publication.id))
        .await?;
    ensure!(measured
        .iter()
        .flat_map(|pair| &pair.streams)
        .all(|stream| stream.publication_id != voice.id));
    f.close().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn screen_pause_stops_both_outputs_and_resumes_the_same_source_clock() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let sink = f.sink;
    let flow = f.plans.iter().find(|p| p.id == sink).unwrap().outgoing[0].id;
    f.until(|f| {
        [MediaKind::Audio, MediaKind::Video].iter().all(|kind| {
            f.driver.pairs[&sink]
                .outputs
                .get(&(flow, *kind))
                .is_some_and(|output| f.observed(&output.stream, *kind).is_some())
        })
    })
    .await?;
    let video = f.output(flow, MediaKind::Video);
    let audio = f.output(flow, MediaKind::Audio);
    let video_source = f.driver.pairs[&sink].outputs[&(flow, MediaKind::Video)].source;
    let source = f.driver.sources[&video_source].video().unwrap().clone();
    let before = f.observed(&video.1, MediaKind::Video).unwrap();
    f.publication.paused = true;
    f.driver
        .update(f.plans.clone(), vec![f.publication.clone()], vec![])
        .await?;
    f.driver.reconcile_encodings().await;
    // Drain the already-transmitted AU; the upstream fixture keeps producing AV.
    let drained = f.frame + 10;
    f.until(|f| f.frame >= drained).await?;
    let silent_video = f.observed(&video.1, MediaKind::Video).unwrap();
    let silent_audio = f.observed(&audio.1, MediaKind::Audio).unwrap();
    let paused = f.frame + 20;
    f.until(|f| f.frame >= paused).await?;
    ensure!(f.observed(&video.1, MediaKind::Video).unwrap() == silent_video);
    ensure!(f.observed(&audio.1, MediaKind::Audio).unwrap() == silent_audio);
    ensure!(source.same(f.driver.sources[&video_source].video().unwrap()));
    ensure!(
        source.time().epoch
            == f.driver.sources[&video_source]
                .video()
                .unwrap()
                .time()
                .epoch
    );
    ensure!(f.driver.pairs[&sink].connected());
    f.publication.paused = false;
    f.driver
        .update(f.plans.clone(), vec![f.publication.clone()], vec![])
        .await?;
    f.driver.reconcile_encodings().await;
    f.until(|f| {
        f.observed(&video.1, MediaKind::Video)
            .is_some_and(|p| p.2.wrapping_sub(silent_video.2) > 0)
            && f.observed(&audio.1, MediaKind::Audio)
                .is_some_and(|p| p.2.wrapping_sub(silent_audio.2) > 0)
    })
    .await?;
    let resumed = f.observed(&video.1, MediaKind::Video).unwrap();
    ensure!(f.output(flow, MediaKind::Video) == video && f.output(flow, MediaKind::Audio) == audio);
    ensure!(
        (resumed.0, resumed.1) == (before.0, before.1),
        "pause replaced the receiver track/SSRC"
    );
    f.close().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn physical_failure_retires_only_that_source_and_keeps_other_flow_leases() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let sink = f.sink;
    let flow = f.plans.iter().find(|p| p.id == sink).unwrap().outgoing[1].id;
    f.until(|f| {
        f.driver.pairs[&sink]
            .outputs
            .contains_key(&(flow, MediaKind::Video))
    })
    .await?;
    let survivor = f.output(flow, MediaKind::Video);
    f.until(|f| f.observed(&survivor.1, MediaKind::Video).is_some())
        .await?;
    let before = f.observed(&survivor.1, MediaKind::Video).unwrap();
    let failed = f.parents[0].pair;
    let rooms = f.driver.pairs[&sink].plan.rooms.clone();
    let leases: Vec<_> = f.driver.pairs[&sink]
        .plan
        .outgoing
        .iter()
        .map(|flow| flow.id)
        .collect();
    f.driver.fail(failed).await;
    f.parents.retain(|parent| parent.pair != failed);
    ensure!(
        !f.driver.pairs.contains_key(&failed)
            && f.driver
                .sources
                .values()
                .all(|s| !matches!(s.origin,SourceOrigin::Incoming{pair,..}if pair==failed)),
        "failed pair retained resources"
    );
    ensure!(
        f.driver.pairs[&sink].plan.rooms == rooms
            && f.driver.pairs[&sink]
                .plan
                .outgoing
                .iter()
                .map(|f| f.id)
                .collect::<Vec<_>>()
                == leases,
        "transport failure revoked domain leases"
    );
    f.until(|f| {
        f.observed(&survivor.1, MediaKind::Video)
            .is_some_and(|p| p.2.wrapping_sub(before.2) > 9000)
    })
    .await?;
    ensure!(
        f.output(flow, MediaKind::Video) == survivor,
        "unaffected source changed output identity"
    );
    f.close().await;
    Ok(())
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn base_channel_failure_preserves_media_on_the_same_physical_pair() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let sink = f.sink;
    let flow = f.plans.iter().find(|p| p.id == sink).unwrap().outgoing[0].id;
    f.until(|f| {
        f.driver.pairs[&sink]
            .outputs
            .contains_key(&(flow, MediaKind::Video))
    })
    .await?;
    let output = f.output(flow, MediaKind::Video);
    f.until(|f| f.observed(&output.1, MediaKind::Video).is_some())
        .await?;
    let before = f.observed(&output.1, MediaKind::Video).unwrap();
    f.driver.fail_base(sink).await;
    ensure!(f.driver.pairs[&sink].base_failed && f.driver.pairs[&sink].connected());
    f.until(|f| {
        f.observed(&output.1, MediaKind::Video)
            .is_some_and(|p| p.2.wrapping_sub(before.2) > 9000)
    })
    .await?;
    ensure!(
        f.output(flow, MediaKind::Video) == output && !f.driver.pairs[&sink].plan.rooms.is_empty()
    );
    f.close().await;
    Ok(())
}
