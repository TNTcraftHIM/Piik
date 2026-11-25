use super::*;
use crate::peer::tests::support::{vp8, Fixture};
use piik_channel_core::wire::{Command as WireCommand, LinkState};

async fn until(
    f: &mut Fixture,
    label: &'static str,
    ready: impl Fn(&Fixture) -> bool,
) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(40), async {
        while !ready(f) {
            f.step().await?;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context(label)?
}

async fn drop_stun(pc: &Transport, drop: bool) -> Result<()> {
    pc.call(move |engine| {
        engine.test_drop_stun = drop;
        Ok(())
    })
    .await
}

async fn consent_responses(pc: &Transport) -> Result<u64> {
    pc.call(|engine| {
        Ok(engine.peer_stats.as_ref()
            .and_then(|stats| stats.selected_candidate_pair.as_ref())
            .context("selected pair consent statistics unavailable")?.responses_received)
    }).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_disconnection_preserves_established_media_until_sdk_consent_expires() -> Result<()>
{
    let mut f = Fixture::new(vp8()).await?;
    let result = tokio::time::timeout(Duration::from_secs(105), async {
        let pair = f.sink;
        let flow = f.plans.last().unwrap().outgoing[0].id;
        f.until(|f| {
            let p = &f.driver.pairs[&pair];
            p.connected() && p.dc_open && p.pending_offer.is_none()
                && p.plan.outgoing.iter().all(|flow|
                    [MediaKind::Video, MediaKind::Audio].iter().all(|kind| p.outputs.contains_key(&(flow.id, *kind))))
        }).await?;
        let (_, stream) = f.output(flow, MediaKind::Video);
        f.until(|f| f.driver.pairs[&pair].outputs.iter()
            .filter(|((_, kind), _)| *kind == MediaKind::Video)
            .all(|(_, output)| f.observed(&output.stream, MediaKind::Video).is_some())).await?;
        let left = f.driver.pairs[&pair].pc.clone();
        let right = f.remote[&pair].clone();
        let instance = left.instance;
        let outputs = f.driver.pairs[&pair].output_ids();
        let control = f.driver.pairs[&pair].dc.as_ref().unwrap().0;
        let bulk = f.driver.pairs[&pair].bulk.as_ref().map(|channel| channel.0);
        let source_ids: HashSet<_> = f.driver.sources.keys().copied().collect();
        let description = left.local_description().await?;
        f.reported.clear();
        drop_stun(&left, true).await?;
        drop_stun(&right, true).await?;
        let cut = Instant::now();
        until(&mut f, "Native did not observe actual SDK disconnection", |f| {
            f.reported.iter().any(|command| matches!(command,
                WireCommand::LinkState {pair_id, state: LinkState::Disconnected} if *pair_id == pair))
                || !f.driver.pairs.contains_key(&pair)
        }).await?;
        ensure!(f.driver.pairs.contains_key(&pair), "Native retired the recoverable RTC");
        ensure!(!f.driver.pairs[&pair].connected() && f.driver.pairs[&pair].established());
        ensure!(left.call(|engine| Ok(engine.rtc.has_send_consent())).await?,
            "disconnected state outlived its send permission");
        eprintln!("RECOVERY disconnected_ms={}", cut.elapsed().as_millis());

        // Signaling restoration reports the current observation, not the old positive one.
        f.reported.clear();
        f.driver.resync().await;
        until(&mut f, "disconnected resync was not reported", |f| {
            f.reported.iter().any(|command| matches!(command,
                WireCommand::LinkState {pair_id, state: LinkState::Disconnected} if *pair_id == pair))
        }).await?;
        ensure!(!f.reported.iter().any(|command| matches!(command,
            WireCommand::LinkState {pair_id, state: LinkState::Connected} if *pair_id == pair)));
        f.driver.refresh_outputs().await;
        f.driver.deadlines().await;
        let retained = &f.driver.pairs[&pair];
        ensure!(retained.pc.instance == instance, "transport instance changed");
        ensure!(retained.output_ids() == outputs, "outputs changed after resync/refresh: {:?}", retained.outputs.iter().map(|(key, out)| (*key, out.id, out.source)).collect::<Vec<_>>());
        ensure!(retained.dc.as_ref().map(|channel| channel.0) == Some(control));
        ensure!(retained.bulk.as_ref().map(|channel| channel.0) == bulk);
        ensure!(retained.deadline.is_none() && !retained.room_data_failed);
        ensure!(source_ids.iter().all(|source| f.driver.sources.contains_key(source)));

        let before = f.observed(&stream, MediaKind::Video).unwrap();
        until(&mut f, "authorized media stalled during ICE disconnection", |f| {
            f.observed(&stream, MediaKind::Video).is_some_and(|now| now.2.wrapping_sub(before.2) >= 90_000)
        }).await?;
        ensure!(f.driver.pairs[&pair].state.load(Ordering::Acquire) == PeerState::Disconnected as u8);
        eprintln!("RECOVERY disconnected_rtp_advanced_ms={}", cut.elapsed().as_millis());
        let responses_before_recovery = [consent_responses(&left).await?, consent_responses(&right).await?];
        drop_stun(&left, false).await?;
        drop_stun(&right, false).await?;
        until(&mut f, "the same Native RTC did not recover", |f| {
            f.driver.pairs.get(&pair).is_some_and(|p| p.connected())
                && f.reported.iter().any(|command| matches!(command,
                    WireCommand::LinkState {pair_id, state: LinkState::Connected} if *pair_id == pair))
                && f.observed(&stream, MediaKind::Video).is_some_and(|now| now.2 != before.2)
        }).await?;
        ensure!(f.driver.pairs[&pair].pc.instance == instance);
        ensure!(f.driver.pairs[&pair].output_ids() == outputs);
        ensure!(left.local_description().await? == description, "recovery renegotiated the RTC");
        ensure!(f.observed(&stream, MediaKind::Video).unwrap().0 == before.0);
        ensure!(f.driver.pairs[&pair].dc.as_ref().unwrap().0 == control);
        eprintln!("RECOVERY same_instance_reconnected_ms={}", cut.elapsed().as_millis());

        // An inbound check can restore Connected without renewing send consent.
        // Start the next outage only after each endpoint received a fresh valid response.
        while consent_responses(&left).await? <= responses_before_recovery[0]
            || consent_responses(&right).await? <= responses_before_recovery[1]
        {
            f.step().await?;
        }
        eprintln!("RECOVERY renewed_responses={:?}", [consent_responses(&left).await?, consent_responses(&right).await?]);

        // A second outage runs through the SDK's own consent deadline. Other pairs keep their resources.
        f.reported.clear();
        drop_stun(&left, true).await?;
        drop_stun(&right, true).await?;
        let expired_cut = Instant::now();
        until(&mut f, "consent expiry did not enter ordinary pair retirement", |f| {
            !f.driver.pairs.contains_key(&pair)
                && f.reported.iter().any(|command| matches!(command,
                    WireCommand::LinkState {pair_id, state: LinkState::Failed} if *pair_id == pair))
        }).await?;
        ensure!(expired_cut.elapsed() >= Duration::from_secs(25),
            "pair failed before the SDK's consent-expiry boundary");
        f.driver.finish_pair_retirement().await?;
        ensure!(left.call(|_| Ok(())).await.is_err(), "retired transport still accepted work");
        ensure!(f.driver.pairs.values().all(|p| p.connected() && p.dc_open));
        ensure!(source_ids.iter().all(|source| f.driver.sources.contains_key(source)));
        eprintln!("RECOVERY expired_pair_retired_ms={}", expired_cut.elapsed().as_millis());
        Ok::<_, anyhow::Error>(())
    }).await.unwrap_or_else(|error| Err(error.into()));
    f.close().await;
    result
}

#[tokio::test]
async fn ice_observations_do_not_admit_a_transport_before_dtls() -> Result<()> {
    use crate::peer::tests::support::endpoint;
    let runtime = Runtime::new(None);
    let (pc, _) = endpoint(&runtime, Uuid::new_v4(), None).await?;
    let result = pc
        .call(|engine| {
            ensure!(engine.state.load(Ordering::Acquire) == PeerState::New as u8);
            engine.event(RtcEvent::IceConnectionStateChange(
                str0m::IceConnectionState::Connected,
            ));
            ensure!(engine.state.load(Ordering::Acquire) == PeerState::New as u8);
            ensure!(!engine.can_send_media());
            engine.event(RtcEvent::IceConnectionStateChange(
                str0m::IceConnectionState::Disconnected,
            ));
            ensure!(!PeerState::established(
                engine.state.load(Ordering::Acquire)
            ));
            ensure!(!engine.rtc.is_alive());
            Ok(())
        })
        .await;
    pc.close().await?;
    runtime.close().await;
    result
}

#[tokio::test]
async fn queued_input_is_discarded_at_the_serialized_disconnected_write_boundary() -> Result<()> {
    use crate::data::{DataLink, Lane, Message, MessageScope};
    use crate::peer::tests::support::{endpoint, message, open};
    use piik_channel_core::input::{InputBinding, InputHop};
    let runtime = Runtime::new(None);
    let (left, _) = endpoint(
        &runtime,
        Uuid::new_v4(),
        Some(std::net::UdpSocket::bind("127.0.0.1:0")?),
    )
    .await?;
    let (right, mut events) = endpoint(
        &runtime,
        Uuid::new_v4(),
        Some(std::net::UdpSocket::bind("127.0.0.1:0")?),
    )
    .await?;
    let (channel, remote) = open(&left, &right, &mut events).await?;
    let state = left.call(|engine| Ok(engine.state.clone())).await?;
    let (failed, mut failures) = mpsc::channel(8);
    let link = DataLink::new(left.pair, state.clone(), failed);
    let ready = link.bind(Lane::Input, channel.token, channel.clone());
    ensure!(ready.set(true));
    let snapshot = crate::peer::input::tests::state();
    let local = Uuid::from_u128(2);
    let binding = InputBinding {
        publication_id: Uuid::from_u128(4),
        controller_session_id: Uuid::from_u128(3),
        route_id: Uuid::from_u128(6),
        upstream: Some(InputHop {
            pair_id: Uuid::from_u128(7),
            peer_id: Uuid::from_u128(1),
            flow_id: Uuid::from_u128(5),
        }),
        downstream: Some(InputHop {
            pair_id: Uuid::from_u128(8),
            peer_id: Uuid::from_u128(3),
            flow_id: Uuid::from_u128(6),
        }),
    };
    ensure!(binding.current(local, &snapshot));
    let (_snapshot, current) = watch::channel(Some(snapshot));
    let input_scope = MessageScope::Input {
        snapshot: current,
        local,
        binding,
    };
    let sender = link.senders().input;
    let result = async {
        let slots = left.tx.reserve_many(left.tx.max_capacity()).await?;
        sender
            .try_send(Message {
                bytes: b"stale input".to_vec(),
                scope: input_scope.clone(),
                report_failure: true,
            })
            .map_err(|_| anyhow!("input queue full"))?;
        tokio::time::timeout(Duration::from_secs(2), async {
            while sender.capacity() != sender.max_capacity() {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        // Hold only admission to Runtime; no SDK or Core scope is invalidated.
        state.store(PeerState::Disconnected as u8, Ordering::Release);
        drop(slots);
        let (_, file_scope, _lease) = message("surviving file control")?;
        ensure!(
            channel
                .write(false, b"control survives".to_vec(), file_scope, false)
                .await?
        );
        let received = tokio::time::timeout(Duration::from_secs(2), remote.poll()).await?;
        ensure!(
            matches!(received, Some(ChannelEvent::Message(bytes)) if bytes == b"control survives"),
            "queued input entered SCTP after disconnection"
        );
        ensure!(input_scope.allowed());
        ensure!(
            left.call(|engine| Ok(engine.rtc.is_alive() && engine.rtc.has_send_consent()))
                .await?
        );
        ensure!(failures.try_recv().is_err());
        state.store(PeerState::Connected as u8, Ordering::Release);
        sender
            .try_send(Message {
                bytes: b"fresh input".to_vec(),
                scope: input_scope,
                report_failure: true,
            })
            .map_err(|_| anyhow!("input queue full"))?;
        let received = tokio::time::timeout(Duration::from_secs(2), remote.poll()).await?;
        ensure!(matches!(received, Some(ChannelEvent::Message(bytes)) if bytes == b"fresh input"));
        Ok(())
    }
    .await;
    link.close().await;
    left.close().await?;
    right.close().await?;
    runtime.close().await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn consent_expiry_retires_established_transport_while_ice_checks_an_alternate() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let result = tokio::time::timeout(Duration::from_secs(45), async {
        let pair = f.sink;
        f.until(|f| f.driver.pairs.values().all(|p| p.connected() && p.dc_open)).await?;
        let transport = f.driver.pairs[&pair].pc.clone();
        let states = Arc::new(Mutex::new(Vec::new()));
        let observed = states.clone();
        transport.call(move |engine| {
            ensure!(engine.rtc.has_send_consent());
            engine.test_drop_stun_responses = true;
            engine.test_ice_states = Some(observed);
            Ok(())
        }).await?;
        let (input, _snapshot, mut verify_holds) = crate::peer::input::tests::held_source(
            f.driver.session, f.publication.clone(), f.driver.pairs[&pair].plan.clone());
        f.driver.inputs = input;
        let cut = Instant::now();
        while cut.elapsed() < Duration::from_secs(23) {
            f.step().await?;
        }
        verify_holds(false);
        ensure!(f.driver.pairs[&pair].connected());
        // An unanswered eligible candidate keeps the SDK Checking when active consent expires.
        let unanswered = std::net::UdpSocket::bind("127.0.0.1:0")?;
        let candidate = Candidate::host(unanswered.local_addr()?, "udp")?.to_sdp_string();
        transport.add_candidate(candidate).await?;
        while cut.elapsed() < Duration::from_secs(33) && f.driver.pairs.contains_key(&pair) {
            f.step().await?;
        }
        let states = states.lock().unwrap().clone();
        eprintln!("EXPIRY elapsed_ms={} sdk_states={states:?} retained={}", cut.elapsed().as_millis(), f.driver.pairs.contains_key(&pair));
        ensure!(states.contains(&str0m::IceConnectionState::Checking), "fixture never reached SDK Checking");
        ensure!(!states.contains(&str0m::IceConnectionState::Disconnected), "fixture crossed the old disconnect guard");
        ensure!(!f.driver.pairs.contains_key(&pair), "expired transport remained established in Checking");
        verify_holds(true);
        f.driver.finish_pair_retirement().await?;
        ensure!(f.driver.pairs.values().all(|p| p.connected() && p.dc_open));
        Ok::<_, anyhow::Error>(())
    }).await.unwrap_or_else(|error| Err(error.into()));
    f.close().await;
    result
}

#[tokio::test]
async fn healthy_ice_restart_keeps_the_established_transport_while_consent_is_retained() -> Result<()> {
    use crate::peer::tests::support::{endpoint, exchange, open};
    let runtime = Runtime::new(None);
    let (left, _) = endpoint(&runtime, Uuid::new_v4(), Some(std::net::UdpSocket::bind("127.0.0.1:0")?)).await?;
    let (right, mut events) = endpoint(&runtime, Uuid::new_v4(), Some(std::net::UdpSocket::bind("127.0.0.1:0")?)).await?;
    let (send, receive) = open(&left, &right, &mut events).await?;
    let result = async {
        exchange(&send, &receive, "before restart").await?;
        let offer = left.call(|engine| {
            let mut change = engine.rtc.sdp_api();
            change.ice_restart(true);
            let (offer, pending) = change.apply().context("no restart offer")?;
            engine.pending = Some(pending);
            engine.drain();
            ensure!(engine.rtc.is_alive() && engine.rtc.has_send_consent());
            ensure!(PeerState::established(engine.state.load(Ordering::Acquire)));
            Ok(offer.to_sdp_string())
        }).await?;
        right.accept("offer".into(), offer).await?;
        let (kind, answer) = right.local_description().await?;
        left.accept(kind, answer).await?;
        exchange(&send, &receive, "after restart").await?;
        ensure!(left.call(|engine| Ok(engine.rtc.is_alive() && engine.rtc.has_send_consent())).await?);
        Ok::<_, anyhow::Error>(())
    }.await;
    left.close().await?;
    right.close().await?;
    runtime.close().await;
    result
}
