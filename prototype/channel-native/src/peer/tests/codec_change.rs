//! Real SDK packets cross the retained UDP/DTLS/SRTP endpoint; samples test transport, not playback.
use super::*;
use crate::peer::tests::support::{h264, send_rid, sps, video_payloads, vp8, Fixture};
use piik_channel_core::wire::{Description, Signal, Track as WireTrack};

fn source(f: &Fixture, flow: Uuid) -> Option<&crate::media::Source> {
    f.driver.sources.values().find(|source| source.kind == MediaKind::Video
        && matches!(source.origin, crate::media::SourceOrigin::Incoming { flow_id, .. } if flow_id == flow))
}

async fn set_codec(f: &Fixture, codec: RtpCodec, rid: &'static str) -> Result<u32> {
    let parent = &f.parents[0];
    let video = parent.video;
    f.remote[&parent.pair]
        .call(move |engine| {
            let output = engine.outputs.get_mut(&video).context("sending video")?;
            output.codec = codec;
            let mid = output.mid.context("sending MID")?;
            Ok(*engine
                .rtc
                .direct_api()
                .stream_tx_by_mid(mid, (!rid.is_empty()).then(|| rid.into()))
                .context("sending stream")?
                .ssrc())
        })
        .await
}

async fn received_h264(f: &mut Fixture, flow: Uuid) -> Result<()> {
    f.until(|f| {
        f.driver.pairs[&f.sink]
            .outputs
            .contains_key(&(flow, MediaKind::Video))
    })
    .await?;
    let (_, stream) = f.output(flow, MediaKind::Video);
    f.until(|f| {
        f.tracks
            .values()
            .filter(|track| track.stream == stream && track.kind == MediaKind::Video)
            .any(|track| {
                track.first_codec.rtp_codec.mime_type == "video/H264"
                    && f.packets.get(&track.id).is_some_and(|packets| {
                        packets.iter().any(|packet| {
                            packet
                                .payload
                                .windows(sps().len())
                                .any(|bytes| bytes == sps())
                        })
                    })
            })
    })
    .await
    .context("H264 AU reaches the child under H264 payload type")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn empty_rtp_before_h264_cannot_choose_the_source_codec() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    f.parents[0].video_enabled = false;
    let result = async {
        let pair = f.parents[0].pair;
        let input = f.plans[0].incoming[0].id;
        let flow = f.plans.last().unwrap().outgoing[0].id;
        let pc = f.driver.pairs[&pair].pc.clone();
        f.until(|f| f.driver.pairs[&pair].connected()).await?;
        let ssrc = empty_vp8(&f, "").await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !pc
                .call(move |engine| {
                    Ok(engine
                        .rtc
                        .direct_api()
                        .stream_rx(&ssrc.into())
                        .is_some_and(|stream| stream.last_time().is_some()))
                })
                .await?
            {
                f.step().await?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        ensure!(
            pc.call(|engine| Ok(engine
                .tracks
                .values()
                .all(|track| track.track.kind != MediaKind::Video)))
                .await?,
            "empty RTP established a video track"
        );
        ensure!(source(&f, input).is_none());
        ensure!(set_codec(&f, h264(), "").await? == ssrc);
        f.parents[0].video_codec = h264();
        f.parents[0].video_enabled = true;
        f.until(|f| source(f, input).is_some_and(|s| s.codec().mime_type == "video/H264"))
            .await
            .context("first media selects H264")?;
        received_h264(&mut f, flow).await
    }
    .await;
    f.close().await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_vp8_then_h264_on_the_same_ssrc_replaces_only_video_format() -> Result<()> {
    let mut f = Fixture::with_video_rids(vp8(), vec!["q".into(), "h".into()]).await?;
    let result = async {
        // This is a format/lifetime control with two retained consumers, not
        // an optional shadow's admission against another flow's bandwidth.
        f.plans.last_mut().unwrap().outgoing[1].selected = true;
        f.driver
            .update(f.plans.clone(), vec![f.publication.clone()], vec![])
            .await?;
        let pair = f.parents[0].pair;
        let input = f.plans[0].incoming[0].id;
        let flow = f.plans.last().unwrap().outgoing[0].id;
        let sibling = f.plans.last().unwrap().outgoing[1].id;
        let incoming_pc = f.driver.pairs[&pair].pc.clone();
        let outgoing_pc = f.driver.pairs[&f.sink].pc.clone();
        f.until(|f| {
            source(f, input).is_some_and(|s| {
                s.layers
                    .as_ref()
                    .unwrap()
                    .snapshot()
                    .iter()
                    .all(|(_, input)| input.is_some())
            })
        })
        .await
        .context("initial RID feeds")?;
        f.until(|f| {
            [flow, sibling].iter().all(|id| {
                [MediaKind::Audio, MediaKind::Video].iter().all(|kind| {
                    f.driver.pairs[&f.sink]
                        .outputs
                        .get(&(*id, *kind))
                        .is_some_and(|out| f.observed(&out.stream, *kind).is_some())
                })
            })
        })
        .await
        .context("initial retained outputs")?;
        let old_audio = f.output(flow, MediaKind::Audio);
        let other_video = f.output(sibling, MediaKind::Video);
        let previous = source(&f, input).unwrap().clone();
        let reader = f.driver.pairs[&pair].latest[&(input, MediaKind::Video)];
        let reader_task = f.driver.pairs[&pair].tasks[&reader].task.id();
        let q_ssrc = set_codec(&f, vp8(), "q").await?;
        f.parents[0].video_enabled = false;
        // The q representation switches while h still supplies the old format.
        ensure!(set_codec(&f, h264(), "q").await? == q_ssrc);
        frame(&f, "q", h264()).await?;
        f.until(|f| source(f, input).is_some_and(|s| s.codec().mime_type == "video/H264"))
            .await
            .context("H264 payload owns the new source format")?;
        let current = source(&f, input).unwrap().clone();
        ensure!(current.id != previous.id);
        ensure!(current.video().unwrap().time().epoch == previous.video().unwrap().time().epoch);
        let at = current.video().unwrap().time().epoch;
        ensure!(
            current.video().unwrap().time().ntp(at) == previous.video().unwrap().time().ntp(at)
        );
        frame(&f, "h", vp8()).await?;
        ensure!(empty_vp8(&f, "q").await? == q_ssrc);
        // Exercise the reader's extended-sequence boundary with a delayed old
        // codec event; real SRTP would also reject an already-received duplicate.
        incoming_pc
            .call(move |engine| {
                let track = engine
                    .tracks
                    .values()
                    .find(|t| t.track.kind == MediaKind::Video)
                    .unwrap();
                track.tx.try_send(TrackEvent::Rtp(
                    rtp::Packet {
                        header: rtp::header::Header {
                            ssrc: q_ssrc,
                            ..Default::default()
                        },
                        payload: vec![0x10, 0].into(),
                    },
                    0,
                    0,
                    vp8(),
                ))?;
                Ok(())
            })
            .await?;
        let drained = f.frame + 10;
        f.until(|f| f.frame >= drained).await?;
        ensure!(
            incoming_pc
                .call(move |engine| {
                    let track = engine
                        .tracks
                        .values()
                        .find(|t| t.track.kind == MediaKind::Video)
                        .unwrap();
                    Ok(track.track.encodings.lock().unwrap()[&q_ssrc]
                        .1
                        .rtp_codec
                        .mime_type
                        == "video/H264")
                })
                .await?,
            "empty old-PT packet changed the reported media codec"
        );
        ensure!(
            source(&f, input).unwrap().id == current.id,
            "old RID/late packet rolled back the format"
        );
        ensure!(current
            .layers
            .as_ref()
            .unwrap()
            .snapshot()
            .iter()
            .find(|(rid, _)| rid == "h")
            .unwrap()
            .1
            .is_none());
        ensure!(set_codec(&f, h264(), "q").await? == q_ssrc);
        f.parents[0].video_codec = h264();
        f.parents[0].video_enabled = true;
        f.until(|f| {
            source(f, input).is_some_and(|s| {
                s.layers
                    .as_ref()
                    .unwrap()
                    .snapshot()
                    .iter()
                    .all(|(_, input)| input.is_some())
            })
        })
        .await?;
        received_h264(&mut f, flow).await?;
        ensure!(source(&f, input).unwrap().id == current.id);
        ensure!(f.driver.pairs[&pair].latest[&(input, MediaKind::Video)] == reader);
        ensure!(f.driver.pairs[&pair].tasks[&reader].task.id() == reader_task);
        ensure!(f.output(flow, MediaKind::Audio) == old_audio);
        ensure!(f.output(sibling, MediaKind::Video) == other_video);
        ensure!(incoming_pc.stable().await && outgoing_pc.stable().await);

        // End the actual remote video MID. Its latest format must retire with
        // the stable reader, while this pair's audio and the sibling survive.
        f.parents[0].video_enabled = false;
        let remote = &f.remote[&pair];
        remote.retire_output(f.parents[0].video).await?;
        ensure!(remote.offer().await?);
        let (kind, sdp) = remote.local_description().await?;
        f.driver
            .signal(
                pair,
                Signal {
                    udp: None,
                    description: Some(Description {
                        kind,
                        sdp: Some(sdp),
                    }),
                    exchange_id: Some(Uuid::new_v4()),
                    candidate: None,
                    resync: None,
                    tracks: Some(vec![WireTrack {
                        flow_id: input,
                        stream_id: f.parents[0].stream.clone(),
                    }]),
                },
            )
            .await?;
        f.until(|f| {
            !f.driver.pairs[&pair].tasks.contains_key(&reader) && source(f, input).is_none()
        })
        .await?;
        ensure!(!f.driver.pairs[&f.sink]
            .outputs
            .contains_key(&(flow, MediaKind::Video)));
        ensure!(f.output(flow, MediaKind::Audio) == old_audio);
        ensure!(f.output(sibling, MediaKind::Video) == other_video);
        Ok(())
    }
    .await;
    f.close().await;
    result
}

async fn frame(f: &Fixture, rid: &'static str, codec: RtpCodec) -> Result<()> {
    set_codec(f, codec.clone(), rid).await?;
    let parent = &f.parents[0];
    let payloads = video_payloads(&codec, f.frame, true)?;
    let last = payloads.len() - 1;
    let packets = payloads
        .into_iter()
        .enumerate()
        .map(|(part, payload)| rtp::Packet {
            header: rtp::header::Header {
                version: 2,
                marker: part == last,
                timestamp: parent.base.wrapping_add(f.frame * 1800),
                ..Default::default()
            },
            payload,
        })
        .collect();
    send_rid(
        &f.remote[&parent.pair],
        parent.video,
        rid.into(),
        packets,
        f.epoch + Duration::from_millis(u64::from(f.frame.saturating_sub(1)) * 20),
        &f.writable[&parent.video],
    )
    .await
}

async fn empty_vp8(f: &Fixture, rid: &'static str) -> Result<u32> {
    // Real authenticated empty RTP. The public SDK writer has no padding-bit setter.
    let parent = &f.parents[0];
    let (video, timestamp) = (parent.video, parent.base.wrapping_add(f.frame * 1800));
    f.remote[&parent.pair]
        .call(move |engine| {
            let pt = engine
                .rtc
                .codec_config()
                .params()
                .iter()
                .find(|p| p.spec().codec == Codec::Vp8)
                .unwrap()
                .pt();
            let output = engine.outputs.get_mut(&video).unwrap();
            let next = output.seq.entry(rid.into()).or_insert(1.into());
            let sequence = *next;
            *next = (**next + 1).into();
            let mid = output.mid.unwrap();
            let mut direct = engine.rtc.direct_api();
            let stream = direct
                .stream_tx_by_mid(mid, (!rid.is_empty()).then(|| rid.into()))
                .context("empty RTP stream")?;
            stream.write_rtp(RtpWrite::new(
                pt,
                sequence,
                timestamp,
                Instant::now(),
                vec![],
            ));
            Ok(*stream.ssrc())
        })
        .await
}
