use super::*;
use support::*;
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shadow_flows_preserve_source_clock_and_warm_outputs() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let sink = f.sink;
    let old_flow = f.plans.last().unwrap().outgoing[0].id;
    let warm_flow = f.plans.last().unwrap().outgoing[1].id;
    f.until(|f| {
        [old_flow, warm_flow].iter().all(|flow| {
            [RtpCodecKind::Audio, RtpCodecKind::Video]
                .iter()
                .all(|kind| f.driver.pairs[&sink].outputs.contains_key(&(*flow, *kind)))
        })
    })
    .await
    .context("both real source generations become ready")?;
    let warm_audio = f.output(warm_flow, RtpCodecKind::Audio);
    let warm_video = f.output(warm_flow, RtpCodecKind::Video);
    f.until(|f| {
        f.observed(&warm_audio.1, RtpCodecKind::Audio).is_some()
            && f.observed(&warm_video.1, RtpCodecKind::Video).is_some()
    })
    .await
    .context("warm output emits both kinds")?;
    let before_audio = f.observed(&warm_audio.1, RtpCodecKind::Audio).unwrap();
    let before_video = f.observed(&warm_video.1, RtpCodecKind::Video).unwrap();
    f.until(|f| {
        f.reports
            .get(&before_audio.1)
            .is_some_and(|reports| reports.len() >= 2)
            && f.reports
                .get(&before_video.1)
                .is_some_and(|reports| reports.len() >= 2)
    })
    .await
    .context("two actual outgoing SRs for warm A/V")?;
    let original_pc = f.driver.pairs[&sink].pc.clone();
    f.plans
        .last_mut()
        .unwrap()
        .outgoing
        .retain(|flow| flow.id == warm_flow);
    f.plans.last_mut().unwrap().outgoing[0].selected = true;
    let original = f.plans[0].id;
    f.plans.retain(|p| p.id != original);
    f.plans
        .iter_mut()
        .filter(|p| p.id != sink)
        .for_each(|p| p.incoming[0].selected = true);
    f.parents.retain(|p| p.pair != original);
    f.driver
        .update(f.plans.clone(), vec![f.publication.clone()], vec![])
        .await?;
    f.until(|f| {
        f.observed(&warm_audio.1, RtpCodecKind::Audio)
            .is_some_and(|p| p.2.wrapping_sub(before_audio.2) > 9600)
            && f.observed(&warm_video.1, RtpCodecKind::Video)
                .is_some_and(|p| p.2.wrapping_sub(before_video.2) > 18000)
    })
    .await
    .context("selected candidate keeps emitting")?;
    anyhow::ensure!(
        f.output(warm_flow, RtpCodecKind::Audio) == warm_audio
            && f.output(warm_flow, RtpCodecKind::Video) == warm_video,
        "warm commit replaced prepared output identity"
    );
    anyhow::ensure!(
        f.observed(&warm_audio.1, RtpCodecKind::Audio).unwrap().0 == before_audio.0
            && f.observed(&warm_audio.1, RtpCodecKind::Audio).unwrap().1 == before_audio.1
            && f.observed(&warm_video.1, RtpCodecKind::Video).unwrap().1 == before_video.1,
        "warm commit replaced receiver/SSRC"
    );
    anyhow::ensure!(
        original_pc.stable().await,
        "warm commit lost the retained physical connection"
    );

    // A genuinely replaced input declaration must allocate a fresh output.
    let pair = f.parents[0].pair;
    let previous_audio = f.parents[0].audio;
    let previous_video = f.parents[0].video;
    f.remote[&pair].retire_output(previous_audio).await?;
    f.remote[&pair].retire_output(previous_video).await?;
    f.start_parent(pair, 7_000_000).await?;
    f.until(|f| {
        f.driver.pairs[&sink]
            .outputs
            .get(&(warm_flow, RtpCodecKind::Audio))
            .is_some_and(|o| o.id != warm_audio.0)
            && f.driver.pairs[&sink]
                .outputs
                .get(&(warm_flow, RtpCodecKind::Video))
                .is_some_and(|o| o.id != warm_video.0)
    })
    .await
    .context("replacement incoming source allocates fresh outputs")?;
    let replacement_audio = f.output(warm_flow, RtpCodecKind::Audio);
    let replacement_video = f.output(warm_flow, RtpCodecKind::Video);
    f.until(|f| {
        f.observed(&replacement_audio.1, RtpCodecKind::Audio)
            .is_some()
            && f.observed(&replacement_video.1, RtpCodecKind::Video)
                .is_some()
    })
    .await?;
    anyhow::ensure!(
        f.observed(&replacement_audio.1, RtpCodecKind::Audio)
            .unwrap()
            .1
            != before_audio.1
            && f.observed(&replacement_video.1, RtpCodecKind::Video)
                .unwrap()
                .1
                != before_video.1,
        "replacement reused retired SSRC"
    );
    let result = serde_json::json!({"passed":true,"realIncomingRtpAndSenderFeedback":true,"warmCommitRetainsAudioVideoOutputIds":true,"warmCommitRetainsReceiverAndSsrc":true,"twoActualSenderReportsForEachKind":true,"replacedSourceGetsFreshSenderAndSsrc":true,"retainedPhysicalConnection":true,"decoderPlaybackClaim":false});
    f.close().await;
    ensure!(result["passed"] == true);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_h264_au_reaches_two_children_on_retained_pairs() -> Result<()> {
    let mut f = Fixture::new(h264()).await?;
    let first = f.sink;
    let flow = f.plans.iter().find(|p| p.id == first).unwrap().outgoing[0].id;
    f.until(|f| {
        f.driver.pairs[&first]
            .outputs
            .contains_key(&(flow, RtpCodecKind::Video))
    })
    .await?;
    let output = f.output(flow, RtpCodecKind::Video);
    f.until(|f| f.observed(&output.1, RtpCodecKind::Video).is_some())
        .await?;
    let before = f.observed(&output.1, RtpCodecKind::Video).unwrap();
    let second = f.add_remote(Uuid::new_v4()).await?;
    let child_flow = Uuid::new_v4();
    let input = f.plans.iter().find(|p| p.id == first).unwrap().outgoing[0].input_flow_id;
    f.plans.push(PairInfo {
        id: second,
        peer_id: Uuid::new_v4(),
        udp_preparation: None,
        can_receive_video_layers: false,
        rooms: vec!["room".into()],
        incoming: vec![],
        outgoing: vec![FlowBinding {
            id: child_flow,
            publication_id: f.publication.id,
            input_flow_id: input,
            selected: true,
        }],
    });
    f.driver
        .update(f.plans.clone(), vec![f.publication.clone()], vec![])
        .await?;
    f.until(|f| {
        f.driver.pairs[&second]
            .outputs
            .contains_key(&(child_flow, RtpCodecKind::Video))
    })
    .await?;
    let second_stream = f.driver.pairs[&second].outputs[&(child_flow, RtpCodecKind::Video)]
        .stream
        .clone();
    f.until(|f| {
        [&output.1, &second_stream].iter().all(|stream| {
            f.tracks
                .values()
                .filter(|t| t.stream == stream.as_str() && t.kind == RtpCodecKind::Video)
                .any(|t| {
                    f.packets.get(&t.id).is_some_and(|packets| {
                        packets.iter().any(|p| {
                            p.payload
                                .windows(sps().len())
                                .any(|w| w == sps().as_slice())
                        })
                    })
                })
        })
    })
    .await?;
    ensure!(
        f.output(flow, RtpCodecKind::Video) == output,
        "new child replaced existing output"
    );
    let current = f.observed(&output.1, RtpCodecKind::Video).unwrap();
    ensure!(
        current.0 == before.0 && current.1 == before.1,
        "retained child reset receiver/SSRC: before={before:?}, current={current:?}"
    );
    f.until(|f| {
        f.observed(&output.1, RtpCodecKind::Video)
            .is_some_and(|packet| packet.2.wrapping_sub(before.2) > 0)
    })
    .await
    .context("retained child advances after new child receives its IDR")?;
    let after = f.observed(&output.1, RtpCodecKind::Video).unwrap();
    ensure!(
        after.0 == before.0 && after.1 == before.1,
        "retained child reset receiver/SSRC: before={before:?}, after={after:?}"
    );
    ensure!(f.driver.pairs[&first].pc.stable().await && f.driver.pairs[&second].pc.stable().await);
    f.close().await;
    Ok(())
}
fn correlated(sr: &rtc::rtcp::sender_report::SenderReport, rtp: u32, rate: u32) -> i128 {
    (i128::from(sr.ntp_time) * 1_000_000_000 >> 32)
        + i128::from(rtp.wrapping_sub(sr.rtp_time) as i32) * 1_000_000_000 / i128::from(rate)
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn screen_video_bursts_and_audio_share_stream_clock_and_relay_pli() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let sink = f.sink;
    let flow = f.plans.iter().find(|p| p.id == sink).unwrap().outgoing[0].id;
    f.until(|f| {
        [RtpCodecKind::Audio, RtpCodecKind::Video]
            .iter()
            .all(|kind| f.driver.pairs[&sink].outputs.contains_key(&(flow, *kind)))
    })
    .await?;
    let audio = f.output(flow, RtpCodecKind::Audio);
    let video = f.output(flow, RtpCodecKind::Video);
    ensure!(audio.1 == video.1, "A/V output streams split");
    f.until(|f| {
        [RtpCodecKind::Audio, RtpCodecKind::Video]
            .iter()
            .all(|kind| {
                f.observed(&audio.1, *kind).is_some_and(|p| {
                    f.reports
                        .get(&p.1)
                        .is_some_and(|reports| reports.len() >= 2)
                })
            })
    })
    .await?;
    let audio_track = f
        .tracks
        .values()
        .find(|t| t.stream == audio.1 && t.kind == RtpCodecKind::Audio)
        .unwrap()
        .clone();
    let video_track = f
        .tracks
        .values()
        .find(|t| t.stream == video.1 && t.kind == RtpCodecKind::Video)
        .unwrap()
        .clone();
    let video_packets = &f.packets[&video_track.id];
    let markers: Vec<_> = video_packets
        .iter()
        .filter(|packet| packet.header.marker)
        .collect();
    let packet = *markers.last().context("complete burst marker missing")?;
    ensure!(
        video_packets.len() > markers.len(),
        "fixture did not send multi-packet video bursts"
    );
    let frame = u32::from_be_bytes(packet.payload[packet.payload.len() - 4..].try_into()?);
    let source_base = f.parents[0].base;
    let audio_packet = f.packets[&audio_track.id]
        .iter()
        .find(|p| p.header.timestamp == source_base.wrapping_add(frame * 960))
        .context("matching source audio frame")?;
    let audio_sr = f.reports[&audio_packet.header.ssrc].last().unwrap();
    let video_sr = f.reports[&packet.header.ssrc].last().unwrap();
    let skew = (correlated(audio_sr, audio_packet.header.timestamp, 48000)
        - correlated(video_sr, packet.header.timestamp, 90000))
    .abs();
    ensure!(
        skew <= 1_000_000,
        "shared source frame projected A/V clocks differ by {skew}ns"
    );
    for pair in markers.windows(2) {
        let a = u32::from_be_bytes(pair[0].payload[pair[0].payload.len() - 4..].try_into()?);
        let b = u32::from_be_bytes(pair[1].payload[pair[1].payload.len() - 4..].try_into()?);
        let ticks = pair[1]
            .header
            .timestamp
            .wrapping_sub(pair[0].header.timestamp);
        ensure!(
            ticks.abs_diff(b.wrapping_sub(a) * 1800) <= 1,
            "video source intervals changed"
        );
    }
    let source_pair = f.parents[0].pair;
    let before = f.plis.get(&source_pair).copied().unwrap_or(0);
    video_track.request_keyframe(video_track.first_ssrc).await?;
    f.until(|f| f.plis.get(&source_pair).copied().unwrap_or(0) > before)
        .await?;
    f.close().await;
    Ok(())
}
