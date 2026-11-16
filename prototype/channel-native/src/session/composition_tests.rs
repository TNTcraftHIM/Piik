use super::*;
use anyhow::{ensure, Context as _};
use futures_util::{stream, Sink};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
#[path = "core_burst.rs"]
mod core_burst;
use core_burst::CoreBurst;

fn frames(events: &[Event]) -> Result<Vec<String>> {
    let mut images = piik_channel_core::wire_images::StateImageEncoder::default();
    events
        .iter()
        .map(|e| images.encode(e).map_err(Into::into))
        .collect()
}

#[tokio::test]
async fn restored_host_catalog_preserves_event_order_and_expired_carrier_authority() -> Result<()> {
    let mut core = CoreBurst::new()?;
    let events = core.recovery()?;
    let texts = frames(&events)?;
    let charged: usize = texts
        .iter()
        .map(|text| text.len() + std::mem::size_of::<Incoming>())
        .sum();
    let host_inputs = events
        .iter()
        .filter(|e| matches!(e, Event::HostInput { .. }))
        .count();
    ensure!(events.len() == 98 && host_inputs == 32);
    let mut reader = stream::iter(texts.into_iter().map(|s| Ok(Message::Text(s.into()))))
        .chain(stream::pending());
    let (tx, mut rx) = mpsc::channel(SIGNALING_QUEUE_BYTES / std::mem::size_of::<Incoming>() + 1);
    let mut reading = Box::pin(read_messages(&mut reader, tx));
    let terminal = match futures_util::poll!(&mut reading) {
        Poll::Pending => "pending",
        Poll::Ready(Ok(())) => "carrier_end",
        Poll::Ready(Err(error)) => return Err(error),
    };
    let queued = rx.len();
    let mut decoded = piik_channel_core::wire_images::StateImageDecoder::default();
    let mut semaphore = None;
    let mut peak = 0;
    for (index, expected) in events.iter().take(queued).enumerate() {
        let incoming = rx.recv().await.context("missing queued Core event")?;
        if semaphore.is_none() {
            let budget = incoming._budget.semaphore().clone();
            peak = SIGNALING_QUEUE_BYTES + std::mem::size_of::<Incoming>()
                - budget.available_permits();
            semaphore = Some(budget);
        }
        ensure!(
            serde_json::to_value(decoded.decode(&incoming.text).map_err(anyhow::Error::msg)?)?
                == serde_json::to_value(expected)?,
            "Core event order changed at {index}"
        );
    }
    drop(reading);
    drop(rx);
    let returned = semaphore.as_ref().is_none_or(|s| {
        s.available_permits() == SIGNALING_QUEUE_BYTES + std::mem::size_of::<Incoming>()
    });
    ensure!(returned);
    ensure!(
        peak == charged,
        "raw input budget did not track all queued frames"
    );
    ensure!(queued==events.len() && terminal=="pending", "raw queue interrupted legitimate Core restore: admitted {queued}/{} events; aggregate {charged} bytes exceeds chosen budget {}",events.len(),SIGNALING_QUEUE_BYTES);
    // A queued authentic Welcome must not revive an already expired carrier.
    let welcome = events
        .iter()
        .find(|e| matches!(e, Event::Welcome { .. }))
        .unwrap()
        .clone();
    let state = match &welcome {
        Event::Welcome { state, .. } => state.clone(),
        _ => unreachable!(),
    };
    let mut native = session(&mut core, state);
    let mut source = stream::iter(
        frames(&[welcome])?
            .into_iter()
            .map(|s| Ok(Message::Text(s.into()))),
    );
    let (sender, mut messages) = mpsc::channel(2);
    read_messages(&mut source, sender).await?;
    let (_carrier, ended) = watch::channel(Some(
        Instant::now() - Duration::from_millis(RECOVERY_MS + 1),
    ));
    let mut stopping = Box::pin(std::future::pending::<()>());
    let mut writer = RecordedSink::default();
    let outcome = time::timeout(
        Duration::from_secs(1),
        native.connected_messages(&mut writer, &mut messages, ended, &mut stopping),
    )
    .await?;
    let retired = native.live.is_none();
    native.release().await?;
    ensure!(
        !outcome? && retired && writer.messages.is_empty(),
        "queued Welcome revived expired carrier authority"
    );
    Ok(())
}

#[derive(Default)]
struct RecordedSink {
    messages: Vec<Message>,
    block_after: Option<usize>,
    blocked: Arc<tokio::sync::Notify>,
}
impl Sink<Message> for RecordedSink {
    type Error = tokio_tungstenite::tungstenite::Error;
    fn poll_ready(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<std::result::Result<(), Self::Error>> {
        if self.block_after.is_some_and(|n| self.messages.len() >= n) {
            self.blocked.notify_one();
            Poll::Pending
        } else {
            Poll::Ready(Ok(()))
        }
    }
    fn start_send(
        mut self: Pin<&mut Self>,
        message: Message,
    ) -> std::result::Result<(), Self::Error> {
        self.messages.push(message);
        Ok(())
    }
    fn poll_flush(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<std::result::Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<std::result::Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}
fn session(core: &mut CoreBurst, state: Snapshot) -> Session {
    let signer = Arc::new(SessionSigner::from_seed([1; 32]));
    let (commands, received) = mpsc::channel(64);
    Session {
        config: Config {
            url: "ws://owned.invalid".into(),
            origin: "http://owned.invalid".into(),
            name: "Owned Native host".into(),
            owner_key: None,
            credential: Some(core.credential.clone()),
            server_udp: None,
        },
        files: vec![],
        live: Some(Live {
            session: core.session,
            room: RoomTurns {
                local: core.session,
                rooms: std::mem::take(&mut core.hosts),
                signer: signer.clone(),
                snapshot: watch::channel(Some(state)).0,
            },
            peers: NativePeers::new(core.session, vec![], commands),
            commands: received,
            pairs: BTreeSet::new(),
        }),
        recovery: None,
        signer,
        hosting: None,
        opening: BTreeMap::new(),
        pending_captures: BTreeMap::new(),
        pending_relay: BTreeMap::new(),
    }
}
fn addressed_input(core: &mut CoreBurst, index: usize, name: &str) -> Result<Event> {
    let e = core.update_room(index, name);
    ensure!(
        !e.events
            .iter()
            .any(|(_, e)| matches!(e, Event::RoomReply { .. })),
        "room confirmation preceded actual Host storage"
    );
    e.events
        .into_iter()
        .find_map(|(to, e)| {
            (to == core.connection && matches!(e, Event::HostInput { .. })).then_some(e)
        })
        .context("missing actual HostInput")
}

#[tokio::test]
async fn stored_room_commit_precedes_reply_and_stop_discards_queued_work() -> Result<()> {
    let mut core = CoreBurst::new()?;
    let recovery = core.recovery()?;
    let state = recovery
        .iter()
        .find_map(|e| {
            if let Event::Welcome { state, .. } = e {
                Some(state.clone())
            } else {
                None
            }
        })
        .unwrap();
    // Settle real recovery sync before moving the same stored hosts to Native.
    core.settle(piik_channel_core::Effects {
        events: recovery.into_iter().map(|e| (core.connection, e)).collect(),
        close: vec![],
    })?;
    let mut native = session(&mut core, state);
    let mut sink = RecordedSink::default();
    let first = addressed_input(&mut core, 0, "Committed before reply")?;
    ensure!(core.stored_name(0)? == "Owned room 0");
    native.event(first, &mut sink).await?;
    ensure!(core.stored_name(0)? == "Committed before reply");
    ensure!(sink.messages.len() == 1);
    let request = piik_channel_core::wire::Request::parse(sink.messages[0].to_text()?)
        .map_err(|e| anyhow!("parse output {e:?}"))?;
    ensure!(matches!(request.command, Command::HostOutput { .. }));
    let confirmed = core
        .authority
        .handle(core.connection, request, core.now + 1);
    ensure!(confirmed.events.iter().any(|(_,e)|matches!(e,Event::RoomReply{request_id:Some(id),result:RoomResult::Done,..}if id=="owned-update-0")),"actual HostOutput did not confirm stored update");
    let inputs = vec![
        addressed_input(&mut core, 1, "Committed but carrier blocked")?,
        addressed_input(&mut core, 2, "Must remain queued")?,
    ];
    let texts = frames(&inputs)?;
    let mut reader = stream::iter(texts.into_iter().map(|s| Ok(Message::Text(s.into()))))
        .chain(stream::pending());
    let (tx, mut incoming) = mpsc::channel(64);
    let mut reading = Box::pin(read_messages(&mut reader, tx));
    ensure!(matches!(futures_util::poll!(&mut reading), Poll::Pending));
    // Preserve actual incoming permits, including the one held across business work.
    let first = incoming.recv().await.unwrap();
    let budget = first._budget.semaphore().clone();
    let second = incoming.recv().await.unwrap();
    let (qtx, mut queue) = mpsc::channel(2);
    qtx.send(first).await.map_err(|_| anyhow!("queue closed"))?;
    qtx.send(second)
        .await
        .map_err(|_| anyhow!("queue closed"))?;
    drop(qtx);
    let mut blocked = RecordedSink {
        block_after: Some(1),
        ..Default::default()
    };
    let notice = blocked.blocked.clone();
    let (stop, stopped) = oneshot::channel();
    let mut stopping = Box::pin(async {
        let _ = stopped.await;
    });
    let join = Command::Join {
        protocol: piik_channel_core::wire::CHANNEL_PROTOCOL,
        name: "Owned".into(),
        credential: None,
        owner_key: None,
        session_id: None,
        signing_key: [1; 32],
        can_prepare_udp: false,
        can_receive_video_layers: false,
    };
    write(&mut blocked, &join, None).await?;
    let (_carrier, carrier_end) = watch::channel(None);
    {
        let mut work = Box::pin(native.connected_messages(
            &mut blocked,
            &mut queue,
            carrier_end,
            &mut stopping,
        ));
        tokio::select! {_=notice.notified()=>{},result=&mut work=>anyhow::bail!("business ended before blocked HostOutput: {result:?}"),_=time::sleep(Duration::from_secs(2))=>anyhow::bail!("HostOutput did not reach blocked writer")};
        ensure!(core.stored_name(1)? == "Committed but carrier blocked");
        ensure!(core.stored_name(2)? == "Owned room 2");
        stop.send(()).unwrap();
        ensure!(time::timeout(Duration::from_secs(1), &mut work).await??);
    }
    ensure!(
        blocked.messages.len() == 1,
        "queued storage work or uncommitted reply escaped stop"
    );
    drop(queue);
    drop(reading);
    drop(incoming);
    ensure!(budget.available_permits() == SIGNALING_QUEUE_BYTES + std::mem::size_of::<Incoming>());
    native.release().await?;
    // Reopen from actual committed SQLite policy; no optimistic confirmation required.
    let persisted = core.stored_name(1)?;
    ensure!(persisted == "Committed but carrier blocked");
    ensure!(core.stored_name(2)? == "Owned room 2");
    Ok(())
}
