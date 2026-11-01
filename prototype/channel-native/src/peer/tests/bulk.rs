//! One Core pull-window of real frames over ordered SCTP. The fixture delays
//! one encrypted datagram and pauses the consumer; no production fault hooks.
use super::*;
use crate::peer::tests::support::{endpoint, message, send, video_payloads, vp8};
use piik_channel_core::{
    attachment::{sha256_hex, AttachmentDescriptor},
    file_delivery::{FileControl, FileDelivery, FileEffect, FILE_RANGE_BYTES},
    file_room::{FileKey, FilePlan},
};

fn window() -> Result<(Vec<Vec<u8>>, FileDelivery, Uuid)> {
    let source = Uuid::from_u128(1);
    let peer = Uuid::from_u128(2);
    let mut sender = FileDelivery::new(source);
    let mut receiver = FileDelivery::new(peer);
    let mut source_plans = Vec::new();
    let mut receiver_plans = Vec::new();
    let mut keys = Vec::new();
    for index in 0..15u64 {
        let bytes = vec![index as u8; FILE_RANGE_BYTES];
        let key = FileKey {
            room_id: "bulk".into(),
            message_seq: index + 1,
            attachment_id: Uuid::new_v4(),
        };
        let plan = FilePlan {
            room_id: key.room_id.clone(),
            message_seq: key.message_seq,
            attachment: AttachmentDescriptor {
                id: key.attachment_id,
                name: format!("{index}.bin"),
                size: bytes.len() as u64,
                media_type: "application/octet-stream".into(),
                sha256: sha256_hex(&bytes),
            },
            source_id: Some(source),
            upstream: None,
            downstream: vec![peer],
            receiving: false,
        };
        source_plans.push(plan.clone());
        receiver_plans.push(FilePlan {
            upstream: Some(source),
            downstream: vec![],
            receiving: true,
            ..plan
        });
        keys.push((key, bytes));
    }
    sender.update(source_plans);
    receiver.update(receiver_plans);
    let mut frames = Vec::new();
    for (key, bytes) in keys {
        receiver.start(key.clone());
        let effects = sender.control(
            peer,
            FileControl::Pull {
                key: key.clone(),
                offset: 0,
            },
        );
        ensure!(
            effects.iter().any(
                |effect| matches!(effect,FileEffect::Read{length,..}if *length==FILE_RANGE_BYTES)
            ),
            "range was not admitted by Core"
        );
        for effect in sender.read_result(&key, 0, bytes) {
            if let FileEffect::SendChunk { frame, .. } = effect {
                frames.push(frame);
            }
        }
    }
    ensure!(
        frames.len() > 128 && frames.iter().map(Vec::len).sum::<usize>() < 1024 * 1024,
        "fixture is not a normal sub1MiB pull window"
    );
    Ok((frames, receiver, source))
}
pub(super) enum Window {
    Bulk,
    History,
}
pub(super) async fn scenario(window: Window) -> Result<serde_json::Value> {
    let history = matches!(window, Window::History);
    let a_socket = std::net::UdpSocket::bind("127.0.0.1:0")?;
    let a_addr = a_socket.local_addr()?;
    let b_socket = std::net::UdpSocket::bind("127.0.0.1:0")?;
    let b_addr = b_socket.local_addr()?;
    let a_runtime = Runtime::new(None);
    let b_runtime = Runtime::new(None);
    let (a, mut a_events) = endpoint(&a_runtime, Uuid::new_v4(), Some(a_socket)).await?;
    let (b, mut b_events) = endpoint(&b_runtime, Uuid::new_v4(), Some(b_socket)).await?;
    let proxy = UdpSocket::bind("127.0.0.1:0").await?;
    let proxy_addr = proxy.local_addr()?;
    let armed = Arc::new(AtomicBool::new(false));
    let proxy_armed = armed.clone();
    let release = Arc::new(Notify::new());
    let proxy_release = release.clone();
    let (held_notice, mut held_rx) = mpsc::channel(1);
    let proxy_task = tokio::spawn(async move {
        let mut buffer = vec![0; 65536];
        let mut held: Option<(Vec<u8>, SocketAddr)> = None;
        loop {
            tokio::select! {
                result=proxy.recv_from(&mut buffer)=>{
                    let (len,from)=result?;let destination=if from==a_addr{b_addr}else if from==b_addr{a_addr}else{continue};
                    if from==a_addr && len>1024 && rtc_shared::util::match_dtls(&buffer[..len]) && proxy_armed.swap(false,Ordering::AcqRel) {
                        held=Some((buffer[..len].to_vec(),destination));let _=held_notice.try_send(len);continue;
                    }
                    proxy.send_to(&buffer[..len],destination).await?;
                }
                _=proxy_release.notified(),if held.is_some()=>{let (bytes,destination)=held.take().unwrap();proxy.send_to(&bytes,destination).await?;}
            }
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    });
    let result = async {
    let label = if history { "piik-room" } else { "piik-file" };
    let sent = a.create_channel(label).await?;
    let video = Uuid::new_v4();
    let (_feedback, writable) = a
        .add_output(
            video,
            vp8(),
            MediaKind::Video,
            "bulk-sibling-video".into(),
            vec![String::new()],
        )
        .await?;
    ensure!(a.offer().await?);
    let without_candidates = |sdp: String| {
        sdp.lines()
            .filter(|line| !line.starts_with("a=candidate:"))
            .collect::<Vec<_>>()
            .join("\r\n")
            + "\r\n"
    };
    let (kind, sdp) = a.local_description().await?;
    b.accept(kind, without_candidates(sdp)).await?;
    let (kind, sdp) = b.local_description().await?;
    a.accept(kind, without_candidates(sdp)).await?;
    let candidate = Candidate::host(proxy_addr, "udp")?.to_sdp_string();
    a.add_candidate(candidate.clone()).await?;
    b.add_candidate(candidate).await?;
    let received = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = b_events.recv().await {
            if let Event::Channel(_, channel) = event {
                return Ok::<_, anyhow::Error>(channel);
            }
        }
        anyhow::bail!("bulk channel missing")
    })
    .await??;
    for channel in [&sent, &received] {
        ensure!(matches!(
            tokio::time::timeout(Duration::from_secs(5), channel.poll()).await?,
            Some(ChannelEvent::Open)
        ));
    }
    let emit = |timestamp| {
        let mut packets = Vec::new();
        let payloads = video_payloads(&vp8(), 1).unwrap();
        let last = payloads.len() - 1;
        for (part, payload) in payloads.into_iter().enumerate() {
            packets.push(rtp::Packet {
                header: rtp::header::Header {
                    version: 2,
                    marker: part == last,
                    timestamp,
                    ..Default::default()
                },
                payload,
            });
        }
        packets
    };
    send(&a, video, emit(90_000), Instant::now(), &writable).await?;
    let track = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = b_events.recv().await {
            if let Event::Track(_, track) = event {
                return Ok::<_, anyhow::Error>(track);
            }
        }
        anyhow::bail!("sibling video missing")
    })
    .await??;
    let (frames, scopes, mut core) = if history {
        let (frames, scopes) = super::history::pages()?
            .into_iter()
            .unzip::<_, _, Vec<_>, Vec<_>>();
        (frames, scopes, None)
    } else {
        let (frames, core, source) = self::window()?;
        let (_, scope) = message("owned bulk-window authorization")?;
        let scopes = vec![scope; frames.len()];
        (frames, scopes, Some((core, source)))
    };
    armed.store(true, Ordering::Release);
    for (frame, scope) in frames.iter().zip(&scopes) {
        loop {
            let ready = sent.low.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if sent
                .write(!history, frame.clone(), scope.clone(), false)
                .await?
            {
                break;
            }
            ready.await;
        }
    }
    let held_bytes = tokio::time::timeout(Duration::from_secs(5), held_rx.recv())
        .await?
        .context("no encrypted ordered fragment delayed")?;
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let overflow = b.call(|e| Ok(e.overflow.load(Ordering::Acquire))).await?;
            if overflow || received.rx.lock().await.len() >= frames.len() {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await??;
    let overflow = b.call(|e| Ok(e.overflow.load(Ordering::Acquire))).await?;
    let queued = received.rx.lock().await.len();
    println!("ORDERED_RECEIVE_OBSERVATION label={label} overflow={overflow} queued={queued} expected={} held_bytes={held_bytes}", frames.len());
    let mut complete = 0;
    {
        ensure!(
            !overflow && queued == frames.len(),
            "legal ordered window overflowed receive owner: overflow={overflow}, queued={queued}, expected={}", frames.len()
        );
        for expected in &frames {
            let Some(ChannelEvent::Message(actual)) = received.poll().await else {
                anyhow::bail!("file event lost")
            };
            ensure!(
                actual == *expected,
                "ordered file frames changed or duplicated"
            );
            let effects = if let Some((core, source)) = core.as_mut() {
                core.chunk(*source, &actual).map_err(anyhow::Error::msg)?
            } else {
                Vec::new()
            };
            for effect in effects {
                if let FileEffect::Write { key, offset, bytes } = effect {
                    for effect in core.as_mut().unwrap().0.written(&key, offset, bytes.len()) {
                        if matches!(effect, FileEffect::Complete { .. }) {
                            complete += 1;
                        }
                    }
                }
            }
        }
        if history {
            super::history::verify_pages(&frames)?;
        } else {
            ensure!(complete == 15, "Core file digests did not all complete");
        }
        send(&a, video, emit(93_000), Instant::now(), &writable).await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = track.poll().await {
                if matches!(event,TrackEvent::Rtp(packet, ..)if packet.header.timestamp==93_000) {
                    return Ok::<_, anyhow::Error>(());
                }
            }
            anyhow::bail!("media stopped after bulk window")
        })
        .await??;
        ensure!(
            a.call(|e| Ok(e.rtc.is_connected())).await?
                && b.call(|e| Ok(e.rtc.is_connected())).await?
        );
    }

    let mut reclaimed = false;
    if history {
        // Leave one real page queued; retained closed bindings keep Arc<Channel>.
        for (frame, scope) in frames.iter().zip(&scopes).take(101) {
            loop {
                let ready = sent.low.notified();
                tokio::pin!(ready);
                ready.as_mut().enable();
                if sent.write(false, frame.clone(), scope.clone(), false).await? { break; }
                ready.await;
            }
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while received.rx.lock().await.len() != 101 { tokio::task::yield_now().await; }
        }).await?;
        ensure!(b.call(|e|Ok(e.receive_memory.available_permits())).await? < RECEIVE_MEMORY);
        let retained = received.clone();
        received.close().await?;
        ensure!(b.call(|e|Ok(e.receive_memory.available_permits())).await? == RECEIVE_MEMORY,
            "closing retained channel did not reclaim queued memory");
        ensure!(retained.rx.lock().await.is_empty() && retained.closed.load(Ordering::Acquire));
        send(&a, video, emit(96_000), Instant::now(), &writable).await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = track.poll().await {
                if matches!(event,TrackEvent::Rtp(packet, ..)if packet.header.timestamp==96_000) { return Ok::<_,anyhow::Error>(()); }
            }
            anyhow::bail!("closing Control stopped retained video")
        }).await??;
        ensure!(a.call(|e|Ok(e.rtc.is_connected())).await? && b.call(|e|Ok(e.rtc.is_connected())).await?);
        reclaimed = true;
    }
    Ok(
        serde_json::json!({"overflow":overflow,"frames":frames.len(),"queuedBeforeRead":queued,"heldEncryptedDatagramBytes":held_bytes,"completeCoreDigests":complete,"mediaContinues":true,"retainedCloseReclaimed":reclaimed,"receiveEventMemory":RECEIVE_EVENT_MEMORY,"receiveMemory":RECEIVE_MEMORY}),
    )
    }.await;
    a.close().await?;
    b.close().await?;
    a_runtime.close().await;
    b_runtime.close().await;
    proxy_task.abort();
    let _ = proxy_task.await;
    while a_events.try_recv().is_ok() {}
    result
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordered_bulk_window_uses_core_bound_and_keeps_media_alive() -> Result<()> {
    let after = scenario(Window::Bulk).await?;
    ensure!(after["overflow"] == false && after["completeCoreDigests"] == 15);
    println!("BULK_WINDOW_RECEIPT {after}");
    Ok(())
}
