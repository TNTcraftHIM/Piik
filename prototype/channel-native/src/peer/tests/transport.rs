use super::*;
#[path = "admission.rs"]
mod admission;
#[path = "bulk.rs"]
mod bulk;
#[path = "history.rs"]
mod history;
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
        reference_ref.set_recv_buffer_size(1024 * 1024)?;
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
        socket2::SockRef::from(&large).set_recv_buffer_size(2 * 1024 * 1024)?;
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
                RtpCodecKind::Audio,
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
