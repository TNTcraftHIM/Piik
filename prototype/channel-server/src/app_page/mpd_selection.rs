use super::*;
use piik_channel_mpd::MpdSnapshot;
pub(super) struct MpdCatalog {
    pub reader: Arc<reader::OriginReader>,
    pub snapshot: Arc<MpdSnapshot>,
    pub cancel: watch::Sender<bool>,
    pub retired: watch::Receiver<bool>,
}
struct Preparing {
    cancel: watch::Sender<bool>,
    committed: bool,
}
impl Drop for Preparing {
    fn drop(&mut self) {
        if !self.committed {
            self.cancel.send_replace(true);
        }
    }
}
impl Connection {
    pub fn inspect_mpd(
        self: &Arc<Self>,
        page: Uuid,
        candidate_id: Option<Uuid>,
        choice: Uuid,
        read_id: Uuid,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        let (read, cancelled) = self.begin_read(page, read_id)?;
        {
            let mut media = self.media.lock().unwrap();
            ensure!(
                media.len() < MAX_MEDIA_SLOTS || media.contains_key(&(page, candidate_id)),
                "page_player_limit"
            );
            ensure!(candidate_id.is_none() || !media.keys().any(|(p,c)| *p == page && c.is_some() && *c != candidate_id), "watch_source_busy");
            let slot = media.entry((page, candidate_id)).or_default();
            ensure!(slot.inspection.is_none(), "watch_read_busy");
            slot.inspection = Some(read_id);
        }
        let connection = self.clone();
        Ok(async move {
            let _read = read;
            let (cancel, _) = watch::channel(false);
            let mut preparing = Preparing {
                cancel: cancel.clone(),
                committed: false,
            };
            let work = async {
                let dispatch = connection
                    .dispatch
                    .as_ref()
                    .ok_or_else(|| anyhow!("page_player_unavailable"))?;
                let (reply, result) = oneshot::channel();
                ensure_dispatch(dispatch(Command::Media {
                    owner: connection.owner,
                    page_id: page, candidate_id,
                    choice_id: choice,
                    indexed: false,
                    reply,
                }))?;
                let (context, _) = result.await?.map_err(anyhow::Error::msg)?;
                ensure!(context.format == Format::Dash, "watch_mpd_unsupported");
                let retired = context.retired.clone();
                let (reader, snapshot) =
                    reader::OriginReader::prepare_mpd(context, cancel.subscribe()).await?;
                let tracks = snapshot
                    .choices()
                    .iter()
                    .map(|c| {
                        let mut value = serde_json::to_value(&c.info).unwrap();
                        value["id"] = json!(c.id);
                        value
                    })
                    .collect::<Vec<_>>();
                let reply = json!({"sourceId":snapshot.source_id,"tracks":tracks});
                ensure!(
                    serde_json::to_vec(&reply)?.len() <= 256 * 1024,
                    "watch_resource_limit"
                );
                ensure!(!*retired.borrow(), "watch_source_retired");
                let mut media = connection.media.lock().unwrap();
                let slot = media
                    .get_mut(&(page, candidate_id))
                    .ok_or_else(|| anyhow!("watch_source_retired"))?;
                ensure!(slot.inspection == Some(read_id), "watch_source_retired");
                slot.mpd = Some(Arc::new(MpdCatalog {
                    reader,
                    snapshot,
                    cancel: cancel.clone(),
                    retired,
                }));
                preparing.committed = true;
                Ok(reply)
            };
            let result = Abortable::new(work, cancelled)
                .await
                .map_err(|_| anyhow!("watch_read_cancelled"))
                .and_then(|v| v);
            result
        }
        .boxed())
    }
    pub fn prepare_mpd_media(
        self: &Arc<Self>,
        page: Uuid,
        candidate_id: Option<Uuid>,
        source: Uuid,
        video: Uuid,
        audio: Option<Uuid>,
        host: mpsc::Sender<HostCommand>,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        let catalog = self
            .media
            .lock()
            .unwrap()
            .get(&(page, candidate_id))
            .and_then(|slot| slot.mpd.clone())
            .ok_or_else(|| anyhow!("watch_source_changed"))?;
        ensure!(catalog.snapshot.source_id == source, "watch_source_changed");
        ensure!(
            catalog
                .snapshot
                .choices()
                .iter()
                .any(|c| c.id == video && c.info.kind == "video"),
            "watch_source_changed"
        );
        if let Some(audio) = audio {
            ensure!(
                audio != video
                    && catalog
                        .snapshot
                        .choices()
                        .iter()
                        .any(|c| c.id == audio && c.info.kind == "audio"),
                "watch_source_changed"
            );
        }
        let selected = std::iter::once(video).chain(audio).collect();
        self.prepare_selection(page, candidate_id, MediaSelection::Mpd { catalog, selected }, host)
    }
}
