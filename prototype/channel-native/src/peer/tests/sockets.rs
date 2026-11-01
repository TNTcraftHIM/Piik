use super::*;
use crate::peer::server_udp::ServerUdp;
use crate::peer::transport::Runtime;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use support::{endpoint, exchange, open};
fn available(address: SocketAddr) -> bool {
    std::net::UdpSocket::bind(address).is_ok()
}
async fn add(
    runtime: &Runtime,
    pair: Uuid,
    prepared: Option<(std::net::UdpSocket, std::net::SocketAddrV4)>,
) -> Result<(Transport, mpsc::Receiver<Event>)> {
    endpoint(runtime, pair, prepared.map(|(socket, _)| socket)).await
}
fn local_candidates(sdp: &str) -> Result<Vec<str0m::Candidate>> {
    sdp.lines()
        .filter_map(|line| line.strip_prefix("a=candidate:"))
        .map(|line| {
            str0m::Candidate::from_sdp_string(&format!("candidate:{line}")).map_err(Into::into)
        })
        .collect()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fixed_and_prepared_udp_keep_pair_ownership_and_ipv6() -> Result<()> {
    let reserved = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = reserved.local_addr()?.port();
    drop(reserved);
    let fixed4 = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let fixed6 = SocketAddr::from((Ipv6Addr::LOCALHOST, port));
    let service = ServerUdp::bind(&[(fixed4, None), (fixed6, None)])?;
    let server = Runtime::new(Some(service.clone()));

    // Adopt this exact socket. Its only owner after transfer is the real pump.
    let prepared = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
    let prepared_address = prepared.local_addr()?;
    let client4 = Runtime::new(None);
    let v6_service = ServerUdp::bind(&[(SocketAddr::from((Ipv6Addr::LOCALHOST, 0)), None)])?;
    let client6 = Runtime::new(Some(v6_service.clone()));
    let pair4 = Uuid::new_v4();
    let pair6 = Uuid::new_v4();
    let (server4, _) = add(&server, pair4, None).await?;
    let SocketAddr::V4(target) = fixed4 else {
        unreachable!()
    };
    let candidate = crate::peer::prepared_candidate(target)?.candidate.unwrap();
    ensure!(
        str0m::Candidate::from_sdp_string(&candidate)?.addr() == fixed4,
        "prepared target changed identity"
    );
    let (remote4, mut events4) = add(&client4, pair4, Some((prepared, target))).await?;
    let (server6, _) = add(&server, pair6, None).await?;
    let (remote6, mut events6) = add(&client6, pair6, None).await?;
    let (left4, right4) = open(&server4, &remote4, &mut events4)
        .await
        .context("prepared IPv4 pair")?;
    // Match Driver's post-accept remote-candidate application. The tuple's target
    // must never become this adopted socket's local advertised mapping.
    remote4.add_candidate(candidate).await?;
    let (_, sdp) = remote4.local_description().await?;
    let addresses = local_candidates(&sdp)?;
    ensure!(
        addresses.iter().any(|c| c.addr() == prepared_address),
        "prepared socket missing from local SDP"
    );
    ensure!(
        addresses.iter().all(|c| c.addr() != fixed4),
        "peer target advertised as local mapping"
    );
    // Compare actual ordinary discovery: this machine may have no usable IPv6
    // interface after loopback and unscoped link-local addresses are excluded.
    let (ordinary, _) = add(&client4, Uuid::new_v4(), None).await?;
    ordinary.create_channel("ordinary-candidates").await?;
    ordinary.offer().await?;
    let (_, ordinary_sdp) = ordinary.local_description().await?;
    let ordinary_addresses = local_candidates(&ordinary_sdp)?;
    let ipv6 = |candidates: &[str0m::Candidate]| {
        candidates
            .iter()
            .filter(|candidate| candidate.addr().is_ipv6())
            .map(|candidate| candidate.addr().ip())
            .collect::<HashSet<_>>()
    };
    ensure!(
        ipv6(&addresses) == ipv6(&ordinary_addresses),
        "prepared IPv4 socket suppressed ordinary IPv6 candidates"
    );
    ensure!(
        ordinary_addresses
            .iter()
            .all(|candidate| !candidate.addr().ip().is_loopback()),
        "wildcard discovery advertised a loopback interface"
    );
    ordinary.close().await?;
    let (left6, right6) = open(&server6, &remote6, &mut events6)
        .await
        .context("shared fixed IPv6 pair")?;
    for (send, receive, tag) in [
        (&left4, &right4, "v4-out"),
        (&right4, &left4, "v4-in"),
        (&left6, &right6, "v6-out"),
        (&right6, &left6, "v6-in"),
    ] {
        exchange(send, receive, tag).await?;
    }
    ensure!(
        !available(fixed4) && !available(fixed6) && !available(prepared_address),
        "live transport did not own its required port"
    );

    server4.close().await?;
    remote4.close().await?;
    ensure!(
        available(prepared_address),
        "prepared pair close failed to join its reader/release exact socket"
    );
    ensure!(
        !available(fixed4) && !available(fixed6),
        "one pair close released service-owned listeners"
    );
    for index in 0..8 {
        exchange(&left6, &right6, &format!("healthy-sibling-out-{index}")).await?;
        exchange(&right6, &left6, &format!("healthy-sibling-in-{index}")).await?;
    }
    server6.close().await?;
    remote6.close().await?;
    server.close().await;
    client4.close().await;
    client6.close().await;
    ensure!(
        !available(fixed4) && !available(fixed6),
        "runtime retired the service owner's sockets"
    );
    // A successor reader lease starts only after the predecessor pump joined.
    let successor = Runtime::new(Some(service.clone()));
    successor.close().await;
    drop(service);
    drop(v6_service);
    ensure!(
        available(fixed4) && available(fixed6),
        "final owner did not release fixed ports"
    );
    Ok(())
}
#[tokio::test]
async fn requested_bind_failure_releases_prior_owned_socket() -> Result<()> {
    let occupied = std::net::UdpSocket::bind("127.0.0.1:0")?;
    let held = occupied.local_addr()?;
    let first = std::net::UdpSocket::bind("127.0.0.1:0")?.local_addr()?;
    ensure!(
        ServerUdp::bind(&[(first, None), (held, None)]).is_err(),
        "required bind was silently skipped"
    );
    std::net::UdpSocket::bind(first)?;
    Ok(())
}
#[tokio::test]
async fn invalid_candidates_do_not_retire_an_established_channel() -> Result<()> {
    let fixed = ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
    let left = Runtime::new(Some(fixed));
    let fixed = ServerUdp::bind(&[("127.0.0.1:0".parse()?, None)])?;
    let right = Runtime::new(Some(fixed));
    let (a, _) = endpoint(&left, Uuid::new_v4(), None).await?;
    let (b, mut events) = endpoint(&right, Uuid::new_v4(), None).await?;
    let (sent, received) = open(&a, &b, &mut events).await?;
    ensure!(a.add_candidate("not-a-candidate".into()).await.is_err());
    exchange(&sent, &received, "after-rejected-candidate").await?;
    exchange(&received, &sent, "reverse-after-rejected-candidate").await?;
    a.close().await?;
    b.close().await?;
    left.close().await;
    right.close().await;
    Ok(())
}
