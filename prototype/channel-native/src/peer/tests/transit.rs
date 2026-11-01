//! Still-applicable source/base lifetime assertions, through current real endpoints.
use super::*;
use support::{vp8, Fixture};
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn physical_failure_retires_only_that_source_and_keeps_other_flow_leases() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let sink = f.sink;
    let flow = f.plans.iter().find(|p| p.id == sink).unwrap().outgoing[1].id;
    f.until(|f| {
        f.driver.pairs[&sink]
            .outputs
            .contains_key(&(flow, MediaKind::Video))
    })
    .await?;
    let survivor = f.output(flow, MediaKind::Video);
    f.until(|f| f.observed(&survivor.1, MediaKind::Video).is_some())
        .await?;
    let before = f.observed(&survivor.1, MediaKind::Video).unwrap();
    let failed = f.parents[0].pair;
    let rooms = f.driver.pairs[&sink].plan.rooms.clone();
    let leases: Vec<_> = f.driver.pairs[&sink]
        .plan
        .outgoing
        .iter()
        .map(|flow| flow.id)
        .collect();
    f.driver.fail(failed).await;
    f.parents.retain(|parent| parent.pair != failed);
    ensure!(
        !f.driver.pairs.contains_key(&failed)
            && f.driver
                .sources
                .values()
                .all(|s| !matches!(s.origin,SourceOrigin::Incoming{pair,..}if pair==failed)),
        "failed pair retained resources"
    );
    ensure!(
        f.driver.pairs[&sink].plan.rooms == rooms
            && f.driver.pairs[&sink]
                .plan
                .outgoing
                .iter()
                .map(|f| f.id)
                .collect::<Vec<_>>()
                == leases,
        "transport failure revoked domain leases"
    );
    f.until(|f| {
        f.observed(&survivor.1, MediaKind::Video)
            .is_some_and(|p| p.2.wrapping_sub(before.2) > 9000)
    })
    .await?;
    ensure!(
        f.output(flow, MediaKind::Video) == survivor,
        "unaffected source changed output identity"
    );
    f.close().await;
    Ok(())
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn base_channel_failure_preserves_media_on_the_same_physical_pair() -> Result<()> {
    let mut f = Fixture::new(vp8()).await?;
    let sink = f.sink;
    let flow = f.plans.iter().find(|p| p.id == sink).unwrap().outgoing[0].id;
    f.until(|f| {
        f.driver.pairs[&sink]
            .outputs
            .contains_key(&(flow, MediaKind::Video))
    })
    .await?;
    let output = f.output(flow, MediaKind::Video);
    f.until(|f| f.observed(&output.1, MediaKind::Video).is_some())
        .await?;
    let before = f.observed(&output.1, MediaKind::Video).unwrap();
    f.driver.fail_base(sink).await;
    ensure!(f.driver.pairs[&sink].base_failed && f.driver.pairs[&sink].connected());
    f.until(|f| {
        f.observed(&output.1, MediaKind::Video)
            .is_some_and(|p| p.2.wrapping_sub(before.2) > 9000)
    })
    .await?;
    ensure!(
        f.output(flow, MediaKind::Video) == output && !f.driver.pairs[&sink].plan.rooms.is_empty()
    );
    f.close().await;
    Ok(())
}
