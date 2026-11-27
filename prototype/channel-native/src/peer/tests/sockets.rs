use super::*;
use crate::peer::server_udp::ServerUdp;
use crate::peer::transport::Runtime;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use support::{endpoint, exchange, open, open_with_answer};
fn available(address: SocketAddr) -> bool {
    std::net::UdpSocket::bind(address).is_ok()
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
async fn fixed_and_ordinary_udp_keep_pair_ownership_and_ipv6() -> Result<()> {
    let reserved = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = reserved.local_addr()?.port();
    drop(reserved);
    let fixed4 = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let fixed6 = SocketAddr::from((Ipv6Addr::LOCALHOST, port));
    let external = "192.0.2.1:41000".parse()?;
    let service = ServerUdp::bind(&[(fixed4, Some(external)), (fixed6, None)])?;
    let mapped = service
        .mapped_candidate(&str0m::Candidate::host(fixed4, "udp")?)?
        .context("fixed listener mapping missing")?;
    ensure!(
        mapped.addr() == external
            && mapped.local() == fixed4
            && mapped.kind() == str0m::CandidateKind::ServerReflexive,
        "fixed listener mapping lost its real socket base"
    );
    let server = Runtime::new(Some(service.clone()));

    let client4 = Runtime::ipv4_loopback();
    let v6_service = ServerUdp::bind(&[(SocketAddr::from((Ipv6Addr::LOCALHOST, 0)), None)])?;
    let client6 = Runtime::new(Some(v6_service.clone()));
    let pair4 = Uuid::new_v4();
    let pair6 = Uuid::new_v4();
    let (server4, _) = endpoint(&server, pair4).await?;
    let (remote4, mut events4) = endpoint(&client4, pair4).await?;
    let announced: Vec<_> = std::iter::from_fn(|| events4.try_recv().ok())
        .filter_map(|event| match event {
            Event::Candidate(_, candidate, None) => Some(candidate),
            _ => None,
        })
        .collect();
    let (server6, _) = endpoint(&server, pair6).await?;
    let (remote6, mut events6) = endpoint(&client6, pair6).await?;
    let (left4, right4, sdp) = open_with_answer(&server4, &remote4, &mut events4)
        .await
        .context("ordinary IPv4 pair")?;
    let addresses = local_candidates(&sdp)?;
    ensure!(
        !announced.is_empty()
            && announced.iter().all(|candidate| {
                candidate.ufrag().is_some()
                    && addresses.iter().any(|registered| {
                        registered.to_sdp_string()
                            == crate::peer::signal_candidate(candidate.clone(), None)
                                .candidate
                                .unwrap()
                    })
            }),
        "announced host candidate differs from the SDK's registered candidate"
    );
    let client_address = addresses.iter().find(|c| c.addr().is_ipv4()).context("missing IPv4 address")?.addr();
    ensure!(client_address != fixed4);
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
        !available(fixed4) && !available(fixed6) && !available(client_address),
        "live transport did not own its required port"
    );

    server4.close().await?;
    remote4.close().await?;
    ensure!(
        available(client_address),
        "ordinary pair close failed to join its reader/release exact socket"
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
    let (a, _) = endpoint(&left, Uuid::new_v4()).await?;
    let (b, mut events) = endpoint(&right, Uuid::new_v4()).await?;
    let (sent, received) = open(&a, &b, &mut events).await?;
    ensure!(a.add_candidate("not-a-candidate".into()).await.is_err());
    a.add_signaled_candidate(piik_channel_core::wire::Candidate {
        candidate: Some("unsupported linear hint".into()),
        origin: Some(piik_channel_core::wire::CandidateOrigin::Linear),
        username_fragment: Some("old-generation".into()),
        sdp_mid: None,
        sdp_m_line_index: Some(0),
    })
    .await?;
    exchange(&sent, &received, "after-rejected-candidate").await?;
    exchange(&received, &sent, "reverse-after-rejected-candidate").await?;
    a.close().await?;
    b.close().await?;
    left.close().await;
    right.close().await;
    Ok(())
}
