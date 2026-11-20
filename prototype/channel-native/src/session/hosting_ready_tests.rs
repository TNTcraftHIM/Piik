use super::*;
use anyhow::{ensure, Context as _};
use piik_channel_core::{wire::Request, Authority};
use tokio::net::TcpListener;

async fn local_endpoint(commands: &mpsc::Sender<HostCommand>) -> Result<Option<Uuid>> {
    let (answer, response) = oneshot::channel();
    commands
        .send(HostCommand::LocalEndpoint(answer))
        .await
        .map_err(|_| anyhow!("host command closed"))?;
    Ok(response.await?)
}

#[tokio::test]
async fn current_host_readiness_retires_between_actual_admissions_and_on_stop() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let mut authority = Authority::new("owned-ready".into(), vec![]).map_err(anyhow::Error::msg)?;
    let identity = authority.identity();
    // No ICE peers or public discovery. The fixed loopback entry bypasses router lookup.
    let udp = crate::peer::server_udp::ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
    let (commands, requests) = mpsc::channel(4);
    let (ready, mut status) = watch::channel(None);
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(run_host(
        Config {
            url: format!("ws://{}/prototype/channel", listener.local_addr()?),
            origin: "http://owned.invalid".into(),
            name: "Owned readiness".into(),
            owner_key: Some("owned-ready".into()),
            credential: None,
            server_udp: Some(udp),
        },
        vec![],
        Some(Hosting {
            directory: directory.path().into(),
            identity,
            commands: requests,
            ready,
            desktop: None,
        }),
        None,
        async move {
            let _ = stopped.await;
        },
    ));
    let observed = async {
        let connection = Uuid::new_v4();
        let (stream, _) = listener.accept().await?;
        let mut first = tokio_tungstenite::accept_async(stream).await?;
        let join = first.next().await.context("first join missing")??;
        let effects = authority.handle(
            connection,
            Request::parse(join.to_text()?).map_err(|error| anyhow!("join: {error:?}"))?,
            0,
        );
        ensure!(local_endpoint(&commands).await?.is_none());
        let mut first_id = None;
        for (recipient, event) in effects.events {
            if recipient != connection {
                continue;
            }
            if let Event::Welcome { session_id, .. } = &event {
                first_id = Some(*session_id);
            }
            first
                .send(Message::Text(serde_json::to_string(&event)?.into()))
                .await?;
        }
        status
            .wait_for(|value| matches!(value, Some(Ok(()))))
            .await?;
        let (answer, response) = oneshot::channel();
        commands
            .send(HostCommand::Describe(answer))
            .await
            .map_err(|_| anyhow!("host command closed"))?;
        ensure!(
            response.await?.map_err(anyhow::Error::msg)?.session_id
                == first_id.context("first welcome missing")?
        );
        ensure!(local_endpoint(&commands).await? == first_id);

        // The first registration of a copied room must already have durable history.
        use piik_channel_core::{
            backup::{DeletedHistoryRow, HistoryRow, RoomMetadata},
            RoomBackup,
        };
        let id = Uuid::new_v4().to_string();
        let policy = RoomState::new(
            id.clone(),
            "Copy".into(),
            Default::default(),
            identity.1,
            RoomAccess::Public,
            false,
            None,
        )
        .map_err(anyhow::Error::msg)?;
        let permit = Arc::new(tokio::sync::Semaphore::new(1));
        let mut retry_response = None;
        for seq in [7, 9] {
            let staging = tempfile::tempdir()?;
            let row = HistoryRow::Deleted(DeletedHistoryRow {
                seq,
                retry_key: "a".repeat(64),
            });
            let room = RoomBackup::stage(
                &staging.path().join("room.sqlite"),
                RoomMetadata {
                    version: 3,
                    domain_id: identity.0,
                    policy: policy.clone(),
                    own_credential: None,
                    retained_files: vec![],
                },
                [Ok(row)],
            )
            .map_err(anyhow::Error::from_boxed)?;
            let (result, response) = oneshot::channel();
            commands
                .send(HostCommand::CreateCopy {
                    snapshot: RoomSnapshot {
                        room,
                        directory: staging,
                    },
                    result,
                    scratch: permit.clone().acquire_owned().await?,
                })
                .await
                .map_err(|_| anyhow!("host command closed"))?;
            let registration = first.next().await.context("missing registration")??;
            let request = Request::parse(registration.to_text()?).map_err(|e| anyhow!("{e:?}"))?;
            ensure!(matches!(request.command, Command::HostRegister { .. }));
            let read = tempfile::tempdir()?;
            let copy = RoomBackup::snapshot_readonly(
                &directory.path().join(format!("{id}.sqlite")),
                &read.path().join("read.sqlite"),
                identity.0,
                &id,
                identity.1,
                None,
                || false,
            )
            .map_err(anyhow::Error::from_boxed)?;
            let mut rows = vec![];
            copy.for_each_row(|row| {
                rows.push(row.seq());
                Ok(())
            })
            .map_err(anyhow::Error::from_boxed)?;
            ensure!(rows == [seq]);
            if seq == 7 {
                first
                    .send(Message::Text(
                        serde_json::to_string(&Event::Error {
                            code: "fixture_denied".into(),
                            request_id: request.request_id,
                        })?
                        .into(),
                    ))
                    .await?;
                ensure!(response.await?.err().as_deref() == Some("fixture_denied"));
                let entries = std::fs::read_dir(directory.path())?
                    .map(|entry| entry.map(|entry| entry.file_name()))
                    .collect::<std::io::Result<Vec<_>>>()?;
                ensure!(entries == [std::ffi::OsString::from(format!("{id}.sqlite.lock"))]);
                let lock = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(directory.path().join(&entries[0]))?;
                crate::hosted_room::try_lock_file(&lock)?;
            } else {
                retry_response = Some(response);
            }
        }

        let admitted = authority.handle(
            connection,
            Request {
                request_id: None,
                command: Command::AdmitRoom {
                    room: RoomSummary::from_policy(&policy),
                },
            },
            1,
        );
        ensure!(
            !admitted
                .events
                .iter()
                .any(|(_, event)| matches!(event, Event::Error { .. })),
            "{:?}",
            serde_json::to_string(&admitted.events)?
        );
        first.close(None).await?;
        status.wait_for(Option::is_none).await?;
        ensure!(
            local_endpoint(&commands).await? == first_id,
            "temporary admission loss erased retained local provenance"
        );
        authority.disconnect(connection, 1);
        authority.expire(RECOVERY_MS + 2);
        let next_connection = Uuid::new_v4();
        let (stream, _) = listener.accept().await?;
        let mut next = tokio_tungstenite::accept_async(stream).await?;
        let join = next.next().await.context("replacement join missing")??;
        let effects = authority.handle(
            next_connection,
            Request::parse(join.to_text()?).map_err(|error| anyhow!("join: {error:?}"))?,
            RECOVERY_MS + 3,
        );
        ensure!(
            status.borrow().is_none(),
            "prior success survived before current Welcome"
        );
        ensure!(local_endpoint(&commands).await? == first_id);
        let (answer, response) = oneshot::channel();
        commands
            .send(HostCommand::Describe(answer))
            .await
            .map_err(|_| anyhow!("host command closed"))?;
        ensure!(
            matches!(response.await?, Err(code) if code == "hosting_unavailable"),
            "nonadmitted actor changed its command semantics"
        );
        let mut next_id = None;
        for (recipient, event) in effects.events {
            if recipient != next_connection {
                continue;
            }
            if let Event::Welcome { session_id, .. } = &event {
                next_id = Some(*session_id);
            }
            next.send(Message::Text(serde_json::to_string(&event)?.into()))
                .await?;
        }
        let retry = next
            .next()
            .await
            .context("missing copy re-registration")??;
        let retry = Request::parse(retry.to_text()?).map_err(|e| anyhow!("{e:?}"))?;
        ensure!(matches!(retry.command, Command::HostRegister { .. }));
        next.send(Message::Text(
            serde_json::to_string(&Event::Error {
                code: "fixture_denied".into(),
                request_id: retry.request_id,
            })?
            .into(),
        ))
        .await?;
        status
            .wait_for(|value| matches!(value, Some(Ok(()))))
            .await?;
        let (answer, response) = oneshot::channel();
        commands
            .send(HostCommand::Describe(answer))
            .await
            .map_err(|_| anyhow!("host command closed"))?;
        let description = response.await?.map_err(anyhow::Error::msg)?;
        ensure!(Some(description.session_id) == next_id && next_id != first_id);
        ensure!(local_endpoint(&commands).await? == next_id);
        ensure!(
            retry_response.unwrap().await?.err().as_deref()
                == Some("room_created_connection_failed")
        );
        ensure!(directory.path().join(format!("{id}.sqlite")).try_exists()?);
        Ok::<_, anyhow::Error>(())
    };
    let result = time::timeout(Duration::from_secs(5), observed).await;
    let _ = stop.send(());
    let ended = time::timeout(Duration::from_secs(2), task).await???;
    let _ = ended;
    result??;
    ensure!(
        matches!(&*status.borrow(), Some(Err(code)) if code == "hosting_stopped"),
        "terminal Native owner left success latched"
    );
    Ok(())
}
