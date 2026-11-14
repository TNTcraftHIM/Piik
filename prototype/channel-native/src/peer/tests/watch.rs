use super::*;
use crate::{
    data::{DataLink, Lane},
    watch::{ReadResult, Reader, Watches},
};
use piik_channel_core::{
    watch_delivery::{
        WatchBytePlan, WatchControl, WatchDelivery, WatchEffect, WatchKey, WATCH_WINDOW_BYTES,
    },
    wire::{WatchByteSource, WatchFormat},
};
use std::{future::Future, pin::Pin, sync::atomic::AtomicUsize};

struct Source {
    calls: Arc<AtomicUsize>,
    entered: Arc<Notify>,
    dropped: Arc<Notify>,
    release: Option<Arc<Notify>>,
}
impl Reader for Source {
    fn read(
        &self,
        _: Uuid,
        offset: u64,
        length: u32,
    ) -> Pin<Box<dyn Future<Output = Result<ReadResult>> + Send + '_>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if offset == 99 {
                struct Guard(Arc<Notify>);
                impl Drop for Guard {
                    fn drop(&mut self) {
                        self.0.notify_one();
                    }
                }
                let _guard = Guard(self.dropped.clone());
                self.entered.notify_one();
                if let Some(release) = &self.release {
                    release.notified().await;
                } else {
                    std::future::pending::<()>().await;
                }
            }
            Ok(ReadResult {
                bytes: (0..length)
                    .map(|n| ((offset + n as u64) % 251) as u8)
                    .collect(),
                mime_type: "video/mp4".into(),
                total_size: Some(1_000_000),
                eof: false,
            })
        })
    }
}

#[tokio::test]
async fn watch_reader_transfers_ranges_and_cancels_on_authority_retirement() -> Result<()> {
    use support::{endpoint, open};
    let runtime = transport::Runtime::new(None);
    let (left, _) = endpoint(&runtime, Uuid::new_v4(), None).await?;
    let (right, mut events) = endpoint(&runtime, Uuid::new_v4(), None).await?;
    let (control, remote_control) = open(&left, &right, &mut events).await?;
    let bulk = left.create_channel("piik-file").await?;
    if left.offer().await? {
        let (kind, sdp) = left.local_description().await?;
        right.accept(kind, sdp).await?;
        let (kind, sdp) = right.local_description().await?;
        left.accept(kind, sdp).await?;
    }
    let remote_bulk = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if let Event::Channel(_, channel) = event {
                return Ok::<_, anyhow::Error>(channel);
            }
        }
        Err(anyhow!("bulk channel missing"))
    })
    .await
    .context("bulk channel discovery")??;
    for channel in [&bulk, &remote_bulk] {
        ensure!(matches!(
            tokio::time::timeout(Duration::from_secs(5), channel.poll())
                .await
                .context("bulk open")?,
            Some(ChannelEvent::Open)
        ));
    }
    let (failures, _failed) = mpsc::channel(8);
    let link = DataLink::new(
        Uuid::new_v4(),
        Arc::new(AtomicU8::new(PeerState::Connected as u8)),
        failures,
    );
    let token = Uuid::new_v4();
    link.bind(Lane::Control, token, control).set(true);
    link.bind(Lane::Bulk, Uuid::new_v4(), bulk).set(true);
    let session = Uuid::new_v4();
    let peer = Uuid::new_v4();
    let resource = Uuid::new_v4();
    let key = WatchKey {
        room_id: "watch".into(),
        activity_id: Uuid::new_v4(),
        resource_id: resource,
    };
    let plan = WatchBytePlan {
        room_id: key.room_id.clone(),
        activity_id: key.activity_id,
        source: WatchByteSource {
            session_id: session,
            resource_id: resource,
            format: WatchFormat::File,
        },
        upstream: None,
        downstream: vec![peer],
        receiving: false,
    };
    let watches = Watches::new(session);
    let calls = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(Notify::new());
    let dropped = Arc::new(Notify::new());
    watches
        .register(
            resource,
            Arc::new(Source {
                calls: calls.clone(),
                entered: entered.clone(),
                dropped: dropped.clone(),
                release: None,
            }),
        )
        .await?;
    watches.attach(peer, link.senders()).await;
    let receiver = watches.receiver();
    watches
        .update(vec![], vec![], vec![(peer, vec![key.room_id.clone()])])
        .await;
    let mut consumer = WatchDelivery::new(peer);
    consumer.update(
        vec![WatchBytePlan {
            upstream: Some(session),
            downstream: vec![],
            receiving: true,
            ..plan.clone()
        }],
        vec![(session, vec![key.room_id.clone()])],
    );
    let request = Uuid::new_v4();
    let pull = consumer
        .read(key.clone(), request, 37, WATCH_WINDOW_BYTES)
        .into_iter()
        .find_map(|effect| {
            if let WatchEffect::SendControl { control, .. } = effect {
                Some(control)
            } else {
                None
            }
        })
        .unwrap();
    receiver.control(peer, token, pull).await;
    // The same Pull survives the source snapshot arriving later; the consumer
    // receives no second snapshot and never resubmits it.
    watches
        .update(vec![], vec![], vec![(peer, vec![key.room_id.clone()])])
        .await;
    ensure!(calls.load(Ordering::SeqCst) == 0);
    watches
        .update(
            vec![plan.clone()],
            vec![],
            vec![(peer, vec![key.room_id.clone()])],
        )
        .await;
    let bytes = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ChannelEvent::Message(bytes)) = remote_bulk.poll().await {
                for effect in consumer
                    .chunk(session, bytes.as_slice())
                    .map_err(anyhow::Error::msg)?
                {
                    if let WatchEffect::Received { result, .. } = effect {
                        return Ok::<_, anyhow::Error>(result.bytes);
                    }
                }
            }
        }
    })
    .await
    .context("range delivery")??;
    ensure!(
        bytes
            == (0..WATCH_WINDOW_BYTES)
                .map(|n| ((37 + n) % 251) as u8)
                .collect::<Vec<_>>()
    );
    // Retiring A must deliver its terminal error over the surviving room lease,
    // while B's real consumer keeps receiving through the same physical peer.
    let other_key = WatchKey {
        activity_id: Uuid::new_v4(),
        resource_id: Uuid::new_v4(),
        ..key.clone()
    };
    let other_plan = WatchBytePlan {
        activity_id: other_key.activity_id,
        source: WatchByteSource {
            resource_id: other_key.resource_id,
            ..plan.source.clone()
        },
        ..plan.clone()
    };
    let other_entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    watches
        .register(
            other_key.resource_id,
            Arc::new(Source {
                calls: Arc::new(AtomicUsize::new(0)),
                entered: other_entered.clone(),
                dropped: Arc::new(Notify::new()),
                release: Some(release.clone()),
            }),
        )
        .await?;
    watches
        .update(
            vec![plan.clone(), other_plan.clone()],
            vec![],
            vec![(peer, vec![key.room_id.clone()])],
        )
        .await;
    consumer.update(
        [plan.clone(), other_plan.clone()]
            .into_iter()
            .map(|p| WatchBytePlan {
                upstream: Some(session),
                downstream: vec![],
                receiving: true,
                ..p
            })
            .collect(),
        vec![(session, vec![key.room_id.clone()])],
    );
    let stopped = Uuid::new_v4();
    let surviving = Uuid::new_v4();
    for (key, request) in [(key.clone(), stopped), (other_key.clone(), surviving)] {
        for effect in consumer.read(key, request, 99, 1024) {
            if let WatchEffect::SendControl { control, .. } = effect {
                receiver.control(peer, token, control).await;
            }
        }
    }
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .context("A read start")?;
    tokio::time::timeout(Duration::from_secs(3), other_entered.notified())
        .await
        .context("B read start")?;
    watches
        .update(
            vec![other_plan],
            vec![],
            vec![(peer, vec![key.room_id.clone()])],
        )
        .await;
    tokio::time::timeout(Duration::from_secs(3), dropped.notified())
        .await
        .context("A read cancelled")?;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ChannelEvent::Message(bytes)) = remote_control.poll().await {
                if let Some(piik_channel_core::conversation::ControlFrame::Watch(control)) =
                    crate::data::control(bytes.as_slice())
                {
                    for effect in consumer.control(session, control) {
                        if let WatchEffect::Failed { request_id, .. } = effect {
                            ensure!(request_id == stopped, "retiring A failed B");
                            return Ok::<_, anyhow::Error>(());
                        }
                    }
                }
            }
        }
    })
    .await
    .context("retired activity terminal delivery")??;
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tokio::select! {
                event = remote_control.poll() => {
                    if let Some(ChannelEvent::Message(bytes)) = event {
                        if let Some(piik_channel_core::conversation::ControlFrame::Watch(control)) = crate::data::control(bytes.as_slice()) {
                            for effect in consumer.control(session, control) {
                                ensure!(!matches!(effect, WatchEffect::Failed { request_id, .. } if request_id == surviving), "B consumer failed after A retirement");
                            }
                        }
                    }
                }
                event = remote_bulk.poll() => {
                    if let Some(ChannelEvent::Message(bytes)) = event {
                        for effect in consumer.chunk(session, bytes.as_slice()).map_err(anyhow::Error::msg)? {
                            if let WatchEffect::Received { request_id, result } = effect {
                                ensure!(request_id == surviving && result.bytes == (0..1024).map(|n| ((99+n)%251) as u8).collect::<Vec<_>>());
                                return Ok::<_, anyhow::Error>(());
                            }
                        }
                    }
                }
            }
        }
    }).await.context("B survives A retirement")??;
    watches.revoke(other_key.resource_id).await;
    watches
        .update(
            vec![plan.clone()],
            vec![],
            vec![(peer, vec![key.room_id.clone()])],
        )
        .await;
    for retirement in ["cancel", "route", "provider"] {
        let request = Uuid::new_v4();
        receiver
            .control(
                peer,
                token,
                WatchControl::Pull {
                    key: key.clone(),
                    request_id: request,
                    offset: 99,
                    length: 1024,
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .context("reader started")?;
        if retirement == "provider" {
            watches.revoke(resource).await;
        } else if retirement == "route" {
            watches
                .update(vec![], vec![], vec![(peer, vec![key.room_id.clone()])])
                .await;
        } else {
            receiver
                .control(
                    peer,
                    token,
                    WatchControl::Cancel {
                        key: key.clone(),
                        request_id: request,
                    },
                )
                .await;
        }
        tokio::time::timeout(Duration::from_secs(3), dropped.notified())
            .await
            .context("reader cancelled")?;
        if retirement == "route" {
            watches
                .update(
                    vec![plan.clone()],
                    vec![],
                    vec![(peer, vec![key.room_id.clone()])],
                )
                .await;
        }
    }
    watches.close().await;
    link.close().await;
    left.close().await?;
    right.close().await?;
    runtime.close().await;
    Ok(())
}
