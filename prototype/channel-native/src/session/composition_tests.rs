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
    core.browse_catalog()?;
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
    let restored = events
        .iter()
        .rev()
        .find_map(|event| match event {
            Event::State { state } => Some(state),
            _ => None,
        })
        .context("missing restored catalog")?;
    ensure!(restored.channel.rooms.len() == 32);
    ensure!(
        restored.channel.rooms.iter().all(|room| {
            room.authorized
                && room.reading
                && room.available
                && room.picture.as_ref().is_some_and(|picture| {
                    picture.len() >= piik_channel_core::wire::IDENTITY_IMAGE_URL_BYTES - 3
                })
        }),
        "restored catalog lost an authorized maximum-size room picture"
    );
    ensure!(
        texts
            .iter()
            .map(|text| text.matches("data:image/png;base64,").count())
            .sum::<usize>()
            == 32
    );
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

#[tokio::test]
async fn changing_native_limit_rechecks_a_verified_holder_and_reports_one_refusal() -> Result<()> {
    use piik_channel_core::{attachment::AttachmentDescriptor, file_room::FilePlan, wire::Request};
    let mut core = CoreBurst::new()?;
    let mut state = core
        .recovery()?
        .into_iter()
        .find_map(|event| match event {
            Event::Welcome { state, .. } => Some(state),
            _ => None,
        })
        .context("missing current Welcome")?;
    let recipient = state
        .sessions
        .iter()
        .find(|s| s.id != core.session)
        .context("missing recipient")?;
    let plan = FilePlan {
        author_id: recipient.user_id,
        room_id: core.room_ids[0].clone(),
        message_seq: 1,
        attachment: AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "held.bin".into(),
            size: 1,
            media_type: String::new(),
            sha256: "0".repeat(64),
        },
        source_id: Some(core.session),
        upstream: None,
        downstream: vec![recipient.id],
        receiving: false,
    };
    state.files = vec![
        plan.clone(),
        FilePlan {
            author_id: core.user,
            message_seq: 2,
            ..plan.clone()
        },
    ];
    let mut native = session(&mut core, state);
    let mut writer = RecordedSink::default();
    native.set_forwarding_limit(Some(0), &mut writer).await?;
    native.set_forwarding_limit(Some(0), &mut writer).await?;
    let declines: Vec<_> = writer
        .messages
        .iter()
        .filter_map(|message| Request::parse(message.to_text().ok()?).ok())
        .filter_map(|request| match request.command {
            Command::ByteBranchRefused {
                room_id,
                target: piik_channel_core::wire::ByteBranchTarget::File { message_seq, attachment_id, source_id },
                downstream_id,
            } => Some((
                room_id,
                message_seq,
                attachment_id,
                source_id,
                downstream_id,
            )),
            _ => None,
        })
        .collect();
    ensure!(
        declines
            == [(
                plan.room_id.clone(),
                1,
                plan.attachment.id,
                core.session,
                plan.downstream[0]
            )]
    );
    writer.messages.clear();
    native.set_forwarding_limit(None, &mut writer).await?;
    ensure!(writer.messages.iter().all(|message| !message
        .to_text()
        .unwrap_or("")
        .contains("byte_branch_refused")));
    native.release().await?;
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
        release_error: None,
        ingress: signaling_budget(),
        turn: None,
        local_slots: None,
        forwarding_limit: None,
        service_admission: None,
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
            room_open_failures: Default::default(),
            forwarding_budget: Default::default(),
            session: core.session,
            room: RoomTurns {
                local: core.session,
                rooms: Rooms::with_execution(
                    std::mem::take(&mut core.hosts),
                    Arc::new(tokio::sync::Semaphore::new(2)),
                    2,
                ),
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
        snapshot_job: None,
        room_discovery: None,
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
async fn cancelled_release_keeps_snapshot_join_without_repolling_closed_peers() -> Result<()> {
    let mut core = CoreBurst::new()?;
    let state = core
        .recovery()?
        .into_iter()
        .find_map(|event| match event {
            Event::Welcome { state, .. } => Some(state),
            _ => None,
        })
        .context("missing current Welcome")?;
    let mut native = session(&mut core, state);
    let cancel = Arc::new(AtomicBool::new(false));
    let (release, blocked) = std::sync::mpsc::channel();
    let (entered, started) = oneshot::channel();
    // Control only the blocking I/O wait; Session release and NativePeers are real.
    native.snapshot_job = Some(SnapshotJob {
        cancel: cancel.clone(),
        task: tokio::task::spawn_blocking(move || {
            let directory = tempfile::tempdir().expect("snapshot directory");
            let _ = entered.send(directory.path().to_owned());
            let _ = blocked.recv_timeout(Duration::from_secs(3));
        }),
    });
    let directory = time::timeout(Duration::from_secs(2), started).await??;
    time::timeout(Duration::from_secs(2), async {
        loop {
            {
                let releasing = native.release();
                tokio::pin!(releasing);
                ensure!(futures_util::poll!(&mut releasing).is_pending());
            }
            if native.live.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    ensure!(cancel.load(Ordering::Acquire));
    ensure!(directory.exists());
    ensure!(native
        .snapshot_job
        .as_ref()
        .is_some_and(|job| !job.task.is_finished()));
    release.send(())?;
    time::timeout(Duration::from_secs(2), native.release()).await??;
    ensure!(native.live.is_none() && native.snapshot_job.is_none());
    ensure!(!directory.exists());
    Ok(())
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
        ..Default::default()
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
        can_use_peer_transport: true,
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
        // The second room arrives after Session has entered the blocked wire write.
        qtx.send(second)
            .await
            .map_err(|_| anyhow!("queue closed"))?;

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_release_finishes_sibling_storage_and_returns_first_error() -> Result<()> {
    let mut core = CoreBurst::new()?;
    let state = core
        .recovery()?
        .into_iter()
        .find_map(|event| match event {
            Event::Welcome { state, .. } => Some(state),
            _ => None,
        })
        .context("missing Welcome")?;
    let mut native = session(&mut core, state);
    let rooms = &mut native.live.as_mut().unwrap().room.rooms;
    let (entered, started) = oneshot::channel();
    let (resume, wait) = std::sync::mpsc::channel();
    let (settled, receipt) = oneshot::channel();

    rooms.post(&core.room_ids[1], true, false, move |host| {
        let _ = entered.send(());
        wait.recv_timeout(Duration::from_secs(4))?;
        host.as_mut().context("missing sibling")?.delete_data()?;
        Ok(Box::new(move |_, _| {
            let _ = settled.send(());
            Ok(vec![])
        }))
    })?;
    started.await?;
    let id = core.room_ids[0].clone();
    let path = core.paths[&id].clone();
    let creator = core.user;
    rooms.post(&core.room_ids[0], true, false, move |_| {
        HostedRoom::open(&path, &id, creator)?;
        anyhow::bail!("opened a file with an active room writer")
    })?;
    // Only the other room can publish a result while the sibling is held.
    time::timeout(Duration::from_secs(2), async {
        while rooms.finished.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    {
        let mut closing = Box::pin(native.release());
        ensure!(futures_util::poll!(&mut closing).is_pending());
    }
    resume.send(())?;
    let error = time::timeout(Duration::from_secs(3), native.release())
        .await?
        .unwrap_err();
    ensure!(error.is::<RoomStorageInUse>());
    receipt.await?;
    ensure!(native.live.is_none());
    for id in &core.room_ids[..2] {
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(core.paths[id].with_added_extension("lock"))?;
        crate::hosted_room::try_lock_file(&lock)?;
    }
    Ok(())
}

fn room_review_session() -> Result<(
    CoreBurst,
    Session,
    tempfile::TempDir,
    watch::Receiver<Option<Result<(), String>>>,
    Event,
)> {
    let mut core = CoreBurst::new()?;
    let welcome = core
        .recovery()?
        .into_iter()
        .find(|e| matches!(e, Event::Welcome { .. }))
        .context("missing state")?;
    let Event::Welcome { state, .. } = &welcome else {
        unreachable!()
    };
    let state = state.clone();
    let identity = (state.channel.id, core.user);
    let mut native = session(&mut core, state);
    let dir = tempfile::tempdir()?;
    let (ready, status) = watch::channel(None);
    let (_sender, commands) = mpsc::channel(4);
    native.hosting = Some(Hosting {
        directory: dir.path().into(),
        identity,
        ready,
        commands,
        desktop: None,
    });
    Ok((core, native, dir, status, welcome))
}

async fn receive_one_room(native: &mut Session, sink: &mut RecordedSink) -> Result<()> {
    let done = time::timeout(
        Duration::from_secs(3),
        native.live.as_mut().unwrap().room.rooms.finished.recv(),
    )
    .await?
    .context("room stopped")?;
    native.finish_room(done, Some(sink)).await
}

#[tokio::test]
async fn media_cleanup_clears_saved_copy_without_notifying_its_other_writer() -> Result<()> {
    use piik_channel_core::{
        attachment::ImageRendition,
        history::{HistoryRequest, HistoryResult, MessageDraft},
        storage::Storage,
        AttachmentDescriptor,
    };
    let (core, mut native, directory, _ready, _welcome) = room_review_session()?;
    let a = core.room_ids[0].clone();
    let b = core.room_ids[1].clone();
    let live = native.live.as_mut().unwrap();
    live.room.rooms.retain(|id, _| id == &a);
    let mut view = live.room.snapshot.borrow().as_ref().unwrap().clone();
    let current_writer = Uuid::new_v4();
    let room = view
        .channel
        .rooms
        .iter_mut()
        .find(|room| room.id == b)
        .unwrap();
    room.delivery = Some(RoomDelivery {
        host_session_id: current_writer,
        binding_id: Uuid::new_v4(),
    });
    live.room.snapshot.send_replace(Some(view));
    let local_path = directory.path().join("dormant.sqlite");
    let policy = RoomState::new(
        b.clone(),
        "Dormant".into(),
        Default::default(),
        core.user,
        RoomAccess::Public,
        false,
        None,
    )
    .map_err(anyhow::Error::msg)?;
    drop(HostedRoom::create(&local_path, policy)?);
    let file = AttachmentDescriptor {
        id: Uuid::new_v4(),
        name: "sample.gif".into(),
        media_type: "image/gif".into(),
        size: 6,
        sha256: "a".repeat(64),
    };
    let draft = MessageDraft::new(
        core.user,
        "first".into(),
        "kept".into(),
        vec![file.clone()],
        BTreeMap::from([(
            file.id,
            ImageRendition {
                data: "R0lGODlh".into(),
                media_type: "image/gif".into(),
                original: false,
                width: 1,
                height: 1,
            },
        )]),
        vec![],
        None,
        1,
    )
    .map_err(anyhow::Error::msg)?;
    let mut db = Storage::open_existing(&local_path).map_err(storage_error)?;
    db.history(&HistoryRequest::Send {
        room_id: b.clone(),
        draft,
    })
    .map_err(anyhow::Error::msg)?;
    drop(db);
    native.files.push(RoomFile {
        id: b.clone(),
        path: local_path.clone(),
        bootstrap: false,
        name: String::new(),
    });
    let (answer, response) = oneshot::channel();
    native.clear_media(answer);
    let mut sink = RecordedSink::default();
    for _ in 0..2 {
        receive_one_room(&mut native, &mut sink).await?;
    }
    let report = response.await?.map_err(anyhow::Error::msg)?;
    ensure!(report.cleared_rooms == 2 && report.failed_rooms == 0 && report.cache_failures == 0);
    ensure!(sink
        .messages
        .iter()
        .all(|msg| !msg.to_text().unwrap_or("").contains(&b)));
    let mut db = Storage::open_existing(&local_path).map_err(storage_error)?;
    let HistoryResult::Page { messages, .. } = db
        .history(&HistoryRequest::Read {
            room_id: b.clone(),
            before: None,
        })
        .map_err(anyhow::Error::msg)?
    else {
        bail!("expected history")
    };
    ensure!(messages[0].message.inline_images.is_empty() && messages[0].message.text == "kept");
    ensure!(!native.live.as_ref().unwrap().room.rooms.contains_key(&b));
    native.release().await
}

#[tokio::test]
async fn room_review_retired_ack_replies_only_to_the_original_opener() -> Result<()> {
    let (core, mut native, _dir, _ready, _welcome) = room_review_session()?;
    let id = Uuid::new_v4().to_string();
    let policy = RoomState::new(
        id.clone(),
        "test".into(),
        Default::default(),
        core.user,
        RoomAccess::Public,
        false,
        None,
    )
    .map_err(anyhow::Error::msg)?;
    let mut sink = RecordedSink::default();
    let (reply, mut old) = oneshot::channel();
    native
        .open_room(
            OpenRoom {
                policy: policy.clone(),
                result: reply,
            },
            None,
            &mut sink,
        )
        .await?;
    receive_one_room(&mut native, &mut sink).await?;
    let registration = native.opening[&id].request_id.clone();
    native
        .route_event(
            Event::HostBound {
                room_id: id.clone(),
                binding_id: Uuid::new_v4(),
            },
            &mut sink,
        )
        .await?;
    receive_one_room(&mut native, &mut sink).await?;
    let (resume, wait) = std::sync::mpsc::channel();
    let (entered, started) = oneshot::channel();
    native
        .live
        .as_mut()
        .unwrap()
        .room
        .rooms
        .post(&id, true, false, move |_| {
            let _ = entered.send(());
            wait.recv_timeout(Duration::from_secs(4))?;
            Ok(Box::new(|_, _| Ok(vec![])))
        })?;
    started.await?;
    native
        .route_event(
            Event::Ack {
                request_id: registration.clone(),
            },
            &mut sink,
        )
        .await?;
    let state = native
        .live
        .as_ref()
        .unwrap()
        .room
        .snapshot
        .borrow()
        .clone()
        .unwrap();
    native
        .route_event(Event::State { state }, &mut sink)
        .await?;
    let (reply, mut new) = oneshot::channel();
    native
        .open_room(
            OpenRoom {
                policy,
                result: reply,
            },
            None,
            &mut sink,
        )
        .await?;
    resume.send(())?;
    // Process the held turn, stale Ack, and replacement open before asking the new writer to bind.
    for _ in 0..3 {
        receive_one_room(&mut native, &mut sink).await?;
    }
    ensure!(
        matches!(old.try_recv(),Ok(Err(code)) if code=="room_unavailable"),
        "retired registration still owns the old opener"
    );
    ensure!(matches!(
        new.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    let next = native.opening[&id].request_id.clone();
    ensure!(next != registration);
    native
        .route_event(
            Event::HostBound {
                room_id: id.clone(),
                binding_id: Uuid::new_v4(),
            },
            &mut sink,
        )
        .await?;
    native
        .route_event(Event::Ack { request_id: next }, &mut sink)
        .await?;
    for _ in 0..2 {
        receive_one_room(&mut native, &mut sink).await?;
    }
    ensure!(new.await?.map_err(anyhow::Error::msg)?.id == id);
    native.release().await
}

#[tokio::test]
async fn room_review_failing_reservation_releases_last_ready_waiter() -> Result<()> {
    let (core, mut native, dir, ready, _welcome) = room_review_session()?;
    let id = Uuid::new_v4().to_string();
    let policy = RoomState::new(
        id.clone(),
        "other writer".into(),
        Default::default(),
        core.user,
        RoomAccess::Public,
        false,
        None,
    )
    .map_err(anyhow::Error::msg)?;
    let _other_writer =
        HostedRoom::create(&dir.path().join(format!("{id}.sqlite")), policy.clone())?;
    let mut sink = RecordedSink::default();
    let (reply, result) = oneshot::channel();
    native
        .open_room(
            OpenRoom {
                policy,
                result: reply,
            },
            None,
            &mut sink,
        )
        .await?;
    native
        .route_event(
            Event::HostBound {
                room_id: core.room_ids[0].clone(),
                binding_id: Uuid::new_v4(),
            },
            &mut sink,
        )
        .await?;
    // Both turns are posted. Deliver the successful bind first, whichever task completed first.
    let rooms = &mut native.live.as_mut().unwrap().room.rooms;
    let a = rooms.finished.recv().await.unwrap();
    let b = rooms.finished.recv().await.unwrap();
    let (bind, failed) = if a.id == id { (b, a) } else { (a, b) };
    native.finish_room(bind, Some(&mut sink)).await?;
    ensure!(ready.borrow().is_none());
    native.finish_room(failed, Some(&mut sink)).await?;
    ensure!(result.await?.is_err());
    ensure!(
        matches!(&*ready.borrow(), Some(Ok(()))),
        "last reservation disappeared without publishing ready"
    );
    native.release().await
}

#[tokio::test]
async fn room_review_fresh_welcome_settles_saved_registration_when_open_fails() -> Result<()> {
    let (core, mut native, dir, ready, mut welcome) = room_review_session()?;
    let id = Uuid::new_v4().to_string();
    let policy = RoomState::new(
        id.clone(),
        "stored".into(),
        Default::default(),
        core.user,
        RoomAccess::Public,
        false,
        None,
    )
    .map_err(anyhow::Error::msg)?;
    let mut sink = RecordedSink::default();
    let (reply, mut pending) = oneshot::channel();
    native
        .open_room(
            OpenRoom {
                policy,
                result: reply,
            },
            None,
            &mut sink,
        )
        .await?;
    receive_one_room(&mut native, &mut sink).await?;
    ensure!(native.opening.contains_key(&id));
    native.release().await?;
    let _taken = HostedRoom::open(&dir.path().join(format!("{id}.sqlite")), &id, core.user)?;
    let Event::Welcome { state, .. } = &mut welcome else {
        unreachable!()
    };
    let mut entry = state.channel.rooms[0].clone();
    entry.id = id.clone();
    entry.creator_id = core.user;
    state.channel.rooms = vec![entry];
    native.route_event(welcome, &mut sink).await?;
    ensure!(matches!(
        pending.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    receive_one_room(&mut native, &mut sink).await?;
    ensure!(matches!(pending.try_recv(),Ok(Err(code)) if code=="room_unavailable"));
    ensure!(!native.opening.contains_key(&id) && matches!(&*ready.borrow(), Some(Ok(()))));
    native.release().await
}

#[tokio::test]
async fn confirmed_registration_replies_locally_after_its_carrier_disconnects() -> Result<()> {
    let (mut core, mut native, _directory, _ready, _welcome) = room_review_session()?;
    let id = core.room_ids[0].clone();
    let summary = piik_channel_core::StoredRoomHost::open(&core.paths[&id])
        .map_err(anyhow::Error::from_boxed)?
        .summary();
    let (result, reply) = oneshot::channel();
    let writes = native.register_room(summary, None, false, OpeningReply::new(None, result, None));
    let [(register, request_id)] = writes
        .try_into()
        .map_err(|_| anyhow!("expected one registration"))?;
    let addressed = core.command(register, request_id.clone()).events;
    let mut wire = RecordedSink::default();
    let mut sync = None;
    let mut confirmed = false;
    for (to, event) in addressed {
        if to != core.connection {
            continue;
        }
        let bound = matches!(&event, Event::HostBound { room_id, .. } if room_id == &id);
        let input = matches!(&event, Event::HostInput { room_id, .. } if room_id == &id);
        let ack = matches!(&event, Event::Ack {request_id: returned} if Some(returned) == request_id.as_ref());
        native.route_event(event, &mut wire).await?;
        if bound {
            receive_one_room(&mut native, &mut wire).await?;
        }
        if input {
            // Holding the preceding Sync completion keeps this room's Ack query queued.
            sync = native
                .live
                .as_mut()
                .unwrap()
                .room
                .rooms
                .finished
                .recv()
                .await;
        }
        if ack {
            confirmed = true;
            break;
        }
    }
    ensure!(confirmed && !native.opening.contains_key(&id));
    native.live.as_mut().unwrap().room.disconnected();
    native
        .finish_room(sync.context("missing Core Sync")?, None)
        .await?;
    let queried = time::timeout(
        Duration::from_secs(3),
        native.live.as_mut().unwrap().room.rooms.finished.recv(),
    )
    .await?
    .context("missing Ack query")?;
    native.finish_room(queried, None).await?;
    ensure!(native.live.as_ref().unwrap().room.rooms[&id]
        .binding()
        .is_some());
    ensure!(reply.await?.map_err(anyhow::Error::msg)?.id == id);
    native.release().await
}
