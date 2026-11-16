use super::*;
use anyhow::{ensure, Context as _};
use piik_channel_core::{wire::Request, Authority};
use tokio::net::TcpListener;

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

        first.close(None).await?;
        status.wait_for(Option::is_none).await?;
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
