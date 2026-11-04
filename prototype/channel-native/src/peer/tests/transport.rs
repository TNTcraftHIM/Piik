use super::*;
#[path = "admission.rs"]
mod admission;
#[path = "bulk.rs"]
mod bulk;
#[path = "codec_change.rs"]
mod codec_change;
#[path = "history.rs"]
mod history;

#[tokio::test]
async fn metrics_keep_sdk_sample_clock_and_discard_retired_mid_events() -> Result<()> {
    let runtime = Runtime::new(None);
    let (pc, _) = crate::peer::tests::support::endpoint(&runtime, Uuid::new_v4(), None).await?;
    let output = Uuid::new_v4();
    pc.add_output(
        output,
        crate::peer::codec(),
        MediaKind::Audio,
        "sound".into(),
        vec![],
    )
    .await?;
    pc.offer().await?;
    pc.call(move |engine| {
        let mid = engine.outputs[&output].mid.context("missing offered MID")?;
        let stats = MediaEgressStats {
            mid,
            rid: None,
            bytes: 4096,
            packets: 16,
            firs: 0,
            plis: 0,
            nacks: 0,
            rtt: Some(Duration::from_millis(12)),
            loss: Some(0.25),
            timestamp: Instant::now(),
            remote: None,
        };
        engine.event(RtcEvent::MediaEgressStats(stats));
        Ok(())
    })
    .await?;
    let first = pc.connection_metrics().await?;
    ensure!(first.streams.len() == 1);
    ensure!(first.streams[0].counters.bytes == 4096);
    ensure!(first.streams[0].counters.rtt_ms == Some(12.0));
    ensure!(
        first.bwe_bps.is_none(),
        "startup budget is not measured BWE"
    );
    let second = pc.connection_metrics().await?;
    ensure!(first.connection_id == second.connection_id);
    ensure!(
        first.streams[0].counters.sample_timestamp_ms
            == second.streams[0].counters.sample_timestamp_ms
    );
    ensure!(second.streams[0].counters.age_ms >= first.streams[0].counters.age_ms);
    pc.retire_output(output).await?;
    pc.call(move |engine| {
        ensure!(engine.egress_stats.is_empty());
        let mid = engine.outputs[&output].mid.context("missing retired MID")?;
        engine.event(RtcEvent::MediaEgressStats(MediaEgressStats {
            mid,
            rid: None,
            bytes: 9999,
            packets: 99,
            firs: 0,
            plis: 0,
            nacks: 0,
            rtt: None,
            loss: None,
            timestamp: Instant::now(),
            remote: None,
        }));
        ensure!(
            engine.egress_stats.is_empty(),
            "late event revived retired MID"
        );
        Ok(())
    })
    .await?;
    ensure!(pc.connection_metrics().await?.streams.is_empty());
    pc.close().await?;
    runtime.close().await;
    Ok(())
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn whole_au_admission_and_immediate_retirement_preserve_other_senders() -> Result<()> {
    let receipt = admission::run().await?;
    ensure!(receipt["passed"] == true);
    Ok(())
}
#[tokio::test]
async fn receive_buffer_request_raises_small_and_retains_larger_supplied_values() -> Result<()> {
    for bind in ["127.0.0.1:0", "[::1]:0"] {
        let reference = std::net::UdpSocket::bind(bind)?;
        let reference_ref = socket2::SockRef::from(&reference);
        reference_ref.set_recv_buffer_size(2 * 1024 * 1024)?;
        let expected = reference_ref.recv_buffer_size()?;
        let small = std::net::UdpSocket::bind(bind)?;
        socket2::SockRef::from(&small).set_recv_buffer_size(4096)?;
        small.set_nonblocking(true)?;
        let owner = UdpIo::new(UdpSocket::from_std(small)?)?;
        ensure!(
            owner.state.recv_buffer_size((&owner.socket).into())? >= expected,
            "small receive buffer was not raised to the OS-accepted request"
        );
        let large = std::net::UdpSocket::bind(bind)?;
        socket2::SockRef::from(&large).set_recv_buffer_size(4 * 1024 * 1024)?;
        let supplied = socket2::SockRef::from(&large).recv_buffer_size()?;
        large.set_nonblocking(true)?;
        let owner = UdpIo::new(UdpSocket::from_std(large)?)?;
        ensure!(
            owner.state.recv_buffer_size((&owner.socket).into())? >= supplied,
            "larger caller receive buffer was reduced"
        );
    }
    Ok(())
}

#[tokio::test]
async fn native_opus_offer_and_answer_request_stereo_receive() -> Result<()> {
    let runtime = Runtime::new(None);
    let (left, _) = crate::peer::tests::support::endpoint(&runtime, Uuid::new_v4(), None).await?;
    let (right, _) = crate::peer::tests::support::endpoint(&runtime, Uuid::new_v4(), None).await?;
    let result = async {
        let (_feedback, _writable) = left
            .add_output(
                Uuid::new_v4(),
                crate::peer::codec(),
                MediaKind::Audio,
                "stereo".into(),
                vec![],
            )
            .await?;
        ensure!(left.offer().await?);
        let (kind, offer) = left.local_description().await?;
        right.accept(kind, offer.clone()).await?;
        let (_, answer) = right.local_description().await?;
        for (phase, sdp) in [("offer", offer), ("answer", answer)] {
            let pt = sdp
                .lines()
                .find_map(|line| {
                    line.strip_prefix("a=rtpmap:")
                        .and_then(|line| line.split_once(" opus/48000/2"))
                        .map(|(pt, _)| pt)
                })
                .context("Opus mapping missing")?;
            let prefix = format!("a=fmtp:{pt} ");
            let fmtp = sdp
                .lines()
                .find_map(|line| line.strip_prefix(&prefix))
                .context("Opus fmtp missing")?;
            ensure!(
                fmtp.split(';')
                    .any(|parameter| parameter.trim() == "stereo=1"),
                "{phase} did not request stereo: {fmtp}"
            );
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    left.close().await?;
    right.close().await?;
    runtime.close().await;
    result
}

#[tokio::test]
async fn rebinding_writer_preserves_messages_queued_for_current_channel() -> Result<()> {
    use crate::data::{queue_controls, DataLink, Lane, Message, MessageScope};
    use crate::peer::tests::support::{endpoint, message, open};

    let runtime = Runtime::new(None);
    let (left, _) = endpoint(&runtime, Uuid::new_v4(), None).await?;
    let (right, mut events) = endpoint(&runtime, Uuid::new_v4(), None).await?;
    let (old, _) = open(&left, &right, &mut events).await?;
    let next = left.create_channel("piik-room").await?;
    if left.offer().await? {
        let (kind, sdp) = left.local_description().await?;
        right.accept(kind, sdp).await?;
        let (kind, sdp) = right.local_description().await?;
        left.accept(kind, sdp).await?;
    }
    let remote = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if let Event::Channel(_, channel) = event {
                return Ok::<_, anyhow::Error>(channel);
            }
        }
        Err(anyhow!("replacement channel was not installed"))
    })
    .await??;
    for channel in [&next, &remote] {
        ensure!(matches!(
            tokio::time::timeout(Duration::from_secs(5), channel.poll()).await?,
            Some(ChannelEvent::Open)
        ));
    }

    let (failures, mut failed) = mpsc::channel(8);
    let link = DataLink::new(
        left.pair,
        Arc::new(AtomicU8::new(PeerState::Connected as u8)),
        failures,
    );
    let result = async {
        let senders = link.senders();
        let old_ready = link.bind(Lane::Control, Uuid::new_v4(), old);
        ensure!(old_ready.set(true));
        let (_, MessageScope::Conversation { snapshot, .. }) = message("scope owner")? else {
            unreachable!()
        };
        let (authority, _) = watch::channel(snapshot.borrow().clone());
        let record = |tag: &str| -> Result<Message> {
            let (bytes, mut scope) = message(tag)?;
            let MessageScope::Conversation { snapshot, .. } = &mut scope else {
                unreachable!()
            };
            *snapshot = authority.subscribe();
            Ok(Message {
                bytes,
                scope,
                report_failure: true,
            })
        };

        // Hold only admission to the real command loop, so the old Channel::write
        // remains pending while the pair writer observes its replacement.
        let held = left.tx.reserve_many(left.tx.max_capacity()).await?;
        queue_controls(&senders.control, vec![record("old in-flight")?])
            .map_err(anyhow::Error::msg)?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while senders.control.capacity() != senders.control.max_capacity() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .context("old message never entered Channel::write")?;

        link.unbind(Lane::Control);
        let next_ready = link.bind(Lane::Control, Uuid::new_v4(), next);
        ensure!(next_ready.set(true));
        let expected = [record("current one")?, record("current two")?];
        let bytes: Vec<_> = expected
            .iter()
            .map(|message| message.bytes.clone())
            .collect();
        queue_controls(&senders.control, expected.into_iter().collect())
            .map_err(anyhow::Error::msg)?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while senders.control.capacity() == senders.control.max_capacity() - 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .context("writer never processed the binding change")?;
        drop(held);

        for expected in bytes {
            let received = tokio::time::timeout(Duration::from_secs(5), remote.poll())
                .await
                .context("current-binding message was discarded during old-send cancellation")?;
            ensure!(matches!(received, Some(ChannelEvent::Message(bytes)) if bytes == expected));
        }
        ensure!(
            failed.try_recv().is_err(),
            "replacement reported an old-send failure"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    link.close().await;
    left.close().await?;
    right.close().await?;
    runtime.close().await;
    result
}
