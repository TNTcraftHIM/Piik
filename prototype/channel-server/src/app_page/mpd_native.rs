//! A source-owned MPD snapshot admits selected URLs into the existing reader.
use super::*;
use piik_channel_mpd::{Cancelled, Limits, MpdSnapshot, ResolvedTrack};
impl OriginReader {
    pub async fn prepare_mpd(
        context: MediaContext,
        stopped: watch::Receiver<bool>,
    ) -> Result<(Arc<Self>, Arc<MpdSnapshot>)> {
        let reader = Self::new(context, stopped)?;
        let source = reader.clone();
        let snapshot = reader
            .source_operation(async move {
                let url = url::Url::parse(&source.context.url)?;
                let mut response = source.response(&url, 0, None).await?;
                ensure!(response.status().is_success(), "watch_media_unavailable");
                ensure!(
                    response
                        .content_length()
                        .is_none_or(|n| n <= MAX_MANIFEST as u64),
                    "watch_manifest_limit"
                );
                let final_url = response.url().clone();
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(request_failure)? {
                    ensure!(
                        bytes.len() + chunk.len() <= MAX_MANIFEST,
                        "watch_manifest_limit"
                    );
                    bytes.extend_from_slice(&chunk);
                }
                let xml = String::from_utf8(bytes).map_err(|_| anyhow!("watch_mpd_invalid"))?;
                let cancelled = source.mpd_cancelled();
                let root = source.root;
                // No JS handle survives this synchronous source operation or crosses an await.
                tokio::task::spawn_blocking(move || {
                    // Observe worker retirement in the cancellation regression.
                    #[cfg(test)]
                    let (cancelled, _worker_exit) =
                        crate::app::page::mpd_selection_tests::worker_retirement::observe(
                            final_url.path(),
                            cancelled,
                        );
                    MpdSnapshot::inspect(
                        root,
                        xml,
                        final_url,
                        Limits {
                            manifest_bytes: MAX_MANIFEST,
                            resources: MAX_RESOURCES,
                            heap_bytes: 64 * 1024 * 1024,
                            stack_bytes: 1024 * 1024,
                        },
                        cancelled,
                    )
                })
                .await
                .map_err(|_| anyhow!("watch_mpd_engine_unavailable"))?
            })
            .await?;
        Ok((reader, Arc::new(snapshot)))
    }
    fn mpd_cancelled(&self) -> Cancelled {
        let page = self.context.retired.clone();
        let stopped = self.stopped.clone();
        Arc::new(move || {
            *page.borrow()
                || *stopped.borrow()
                || page.has_changed().is_err()
                || stopped.has_changed().is_err()
        })
    }
    pub async fn admit_mpd(
        &self,
        snapshot: Arc<MpdSnapshot>,
        selected: Vec<Uuid>,
    ) -> Result<()> {
        ensure!(snapshot.source_id == self.root, "watch_source_changed");
        self.source_operation(async {
            let selected_for_resolve = selected.clone();
            let snapshot_for_resolve = snapshot.clone();
            let tracks = tokio::task::spawn_blocking(move || {
                snapshot_for_resolve.resolve_selected(&selected_for_resolve)
            })
            .await
            .map_err(|_| anyhow!("watch_mpd_engine_unavailable"))??;
            let current = self.resources.lock().await;
            ensure!(!(self.mpd_cancelled())(), "watch_source_retired");
            let mut next = current.clone();
            let mut ids = BTreeMap::new();
            for recipe in tracks.iter().flat_map(ResolvedTrack::resources) {
                if ids.contains_key(&recipe.url) {
                    continue;
                }
                let url = url::Url::parse(&recipe.url).map_err(|_| anyhow!("watch_mpd_invalid"))?;
                let existing = next.iter().find_map(|(id, r)| match r {
                    Resource::File { url: known, .. } if *known == url => Some(*id),
                    _ => None,
                });
                let id = existing.unwrap_or_else(Uuid::new_v4);
                next.insert(
                    id,
                    Resource::File {
                        url,
                        size: None,
                        retention: Retention::default(),
                    },
                );
                ensure!(next.len() <= MAX_RESOURCES, "watch_resource_limit");
                ids.insert(recipe.url.clone(), id);
            }
            drop(current);
            let manifest = tokio::task::spawn_blocking(move || {
                snapshot.serialize_selected(&selected, &ids)
            })
            .await
            .map_err(|_| anyhow!("watch_mpd_engine_unavailable"))??;
            ensure!(!(self.mpd_cancelled())(), "watch_source_retired");
            next.insert(
                self.root,
                Resource::Memory {
                    bytes: Arc::new(manifest.into_bytes()),
                    mime_type: "application/dash+xml".into(),
                },
            );
            *self.resources.lock().await = next;
            Ok(())
        })
        .await
    }
    pub(super) async fn source_operation<T>(
        &self,
        work: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let mut page = self.context.retired.clone();
        let mut stopped = self.stopped.clone();
        tokio::select! {biased;
            _=page.wait_for(|v|*v)=>bail!("watch_source_retired"),
            _=stopped.wait_for(|v|*v)=>bail!("watch_source_retired"),
            result=work=>result,
        }
    }
}
#[cfg(test)]
#[path = "mpd_native_tests.rs"]
mod tests;
