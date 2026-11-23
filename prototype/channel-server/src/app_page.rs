//! Page players belong to one approved App WebSocket, never to website messages.
#[path = "app_page/mpd_selection.rs"]
mod mpd_selection;
use anyhow::{anyhow, bail, ensure, Result};
use futures_util::{
    future::{AbortHandle, AbortRegistration, Abortable, BoxFuture},
    FutureExt,
};
use piik_channel_native::session::HostCommand;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Mutex};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;
#[path = "app_page/indexed.rs"]
pub mod indexed;
#[path = "app_page/reader.rs"]
mod reader;
use piik_channel_core::watch_delivery::WATCH_WINDOW_BYTES;
pub use piik_channel_core::wire::WatchFormat as Format;
const MAX_MEDIA_READS: usize = 4;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub type Cookies = Arc<dyn Fn(String) -> BoxFuture<'static, Result<Option<String>>> + Send + Sync>;
/// Request facts belong to one successful WebView response and never enter room data.
#[derive(Clone, PartialEq, Eq)]
pub struct ObservedRequestContext {
    pub url: url::Url,
    pub referer: Option<reqwest::header::HeaderValue>,
    pub user_agent: Option<reqwest::header::HeaderValue>,
}
pub struct MediaContext {
    pub request: Option<Arc<ObservedRequestContext>>,
    pub url: String,
    pub format: Format,
    pub size: Option<u64>,
    pub retired: watch::Receiver<bool>,
    pub cookies: Cookies,
}

/// The selected WebView choice owns the file reader across inspection and admission.
#[derive(Clone, Default)]
pub struct IndexedFile(Arc<Mutex<Option<Arc<reader::OriginReader>>>>);
impl IndexedFile {
    fn open(&self, context: MediaContext) -> Result<Arc<reader::OriginReader>> {
        ensure!(context.format == Format::File, "watch_resource_unavailable");
        let mut file = self.0.lock().unwrap();
        if let Some(reader) = file.as_ref() {
            return Ok(reader.clone());
        }
        let retired = context.retired.clone();
        let reader = reader::OriginReader::new(context, retired)?;
        *file = Some(reader.clone());
        Ok(reader)
    }
}

pub type Dispatcher = Arc<dyn Fn(Command) -> bool + Send + Sync>;
pub enum Command {
    Media {
        owner: Uuid,
        page_id: Uuid,
        choice_id: Uuid,
        indexed: bool,
        reply: oneshot::Sender<Result<(MediaContext, IndexedFile), String>>,
    },
    Cookies {
        owner: Uuid,
        page_id: Uuid,
        document: Uuid,
        url: String,
        reply: oneshot::Sender<Result<Option<String>, String>>,
    },
    Request {
        owner: Uuid,
        operation: Operation,
        events: Events,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Retire {
        owner: Uuid,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    PagePrepare {
        page_id: Uuid,
        url: String,
    },
    PageSelect {
        page_id: Uuid,
        candidate_id: Uuid,
    },
    PageRead {
        page_id: Uuid,
    },
    PagePatch {
        page_id: Uuid,
        patch: Patch,
    },
    PageFocus {
        page_id: Uuid,
    },
    PageHide {
        page_id: Uuid,
    },
    PageClose {
        page_id: Uuid,
    },
    PageMediaSources {
        page_id: Uuid,
    },
    PageMediaPrepare {
        page_id: Uuid,
        choice_id: Uuid,
    },
    PageMediaPrepareIndexed {
        page_id: Uuid,
        video: indexed::TrackRecipe,
        audio: Option<indexed::TrackRecipe>,
    },
    PageMediaPrepareMpd {
        page_id: Uuid,
        source_id: Uuid,
        video_id: Uuid,
        audio_id: Option<Uuid>,
    },
    PageMediaResource(ResourceRequest),
    PageMediaStop {
        page_id: Uuid,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceRequest {
    InspectMpd {
        page_id: Uuid,
        choice_id: Uuid,
        read_id: Uuid,
    },
    ReadMetadata {
        page_id: Uuid,
        choice_id: Uuid,
        read_id: Uuid,
        offset: u64,
        length: u32,
    },
    Read {
        page_id: Uuid,
        source_id: Uuid,
        resource_id: Uuid,
        read_id: Uuid,
        offset: u64,
        length: u32,
    },
    Cancel {
        page_id: Uuid,
        read_id: Uuid,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
}
impl Patch {
    pub fn validate(&self) -> Result<()> {
        if self.position.is_some_and(|v| !v.is_finite() || v < 0.)
            || self
                .rate
                .is_some_and(|v| !v.is_finite() || v <= 0. || v > 16.)
        {
            bail!("invalid_watch_playback");
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaState {
    pub position: f64,
    pub paused: bool,
    pub rate: f64,
    pub duration: Option<f64>,
    pub ready_state: u8,
    pub ended: bool,
    pub buffered: Vec<(f64, f64)>,
}
impl MediaState {
    pub fn validate(&self) -> Result<()> {
        Patch {
            position: Some(self.position),
            rate: Some(self.rate),
            paused: None,
        }
        .validate()?;
        if self.ready_state > 4 || self.duration.is_some_and(|v| !v.is_finite() || v < 0.) {
            bail!("invalid_watch_playback");
        }
        if self.buffered.iter().any(|(start, end)| {
            !start.is_finite() || !end.is_finite() || *start < 0. || end < start
        }) {
            bail!("invalid_watch_playback");
        }
        Ok(())
    }
}
pub fn valid_url(value: &str) -> bool {
    value.len() <= 4096
        && url::Url::parse(value).ok().is_some_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
}
#[derive(Clone)]
pub struct Events {
    pub(crate) origin: String,
    queue: mpsc::Sender<Value>,
    overflow: watch::Sender<bool>,
}
impl Events {
    pub fn send(&self, event: Value) {
        if matches!(
            self.queue.try_send(event),
            Err(mpsc::error::TrySendError::Full(_))
        ) {
            self.overflow.send_replace(true);
        }
    }
}
struct Registration {
    reader: Arc<dyn piik_channel_native::watch::Reader>,
    source: piik_channel_core::wire::WatchByteSource,
    retired: watch::Receiver<bool>,
    cancel: watch::Sender<bool>,
    provider_retired: watch::Receiver<bool>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}
#[derive(Default)]
struct MediaSlot {
    inspection: Option<Uuid>,
    mpd: Option<Arc<mpd_selection::MpdCatalog>>,
    pending: Option<(Uuid, watch::Sender<bool>)>,
    active: Option<Registration>,
}
impl Drop for MediaSlot {
    fn drop(&mut self) {
        if let Some((_, cancel)) = &self.pending {
            cancel.send_replace(true);
        }
    }
}
enum MediaSelection {
    Mpd {
        catalog: Arc<mpd_selection::MpdCatalog>,
        selected: Vec<Uuid>,
    },
    Direct(Uuid),
    Indexed {
        video: indexed::TrackRecipe,
        audio: Option<indexed::TrackRecipe>,
    },
}
pub struct Connection {
    owner: Uuid,
    dispatch: Option<Dispatcher>,
    events: Events,
    overflow: watch::Receiver<bool>,
    media: Mutex<BTreeMap<Uuid, MediaSlot>>,
    media_reads: Arc<tokio::sync::Semaphore>,
    resource_reads: Mutex<BTreeMap<Uuid, (Uuid, AbortHandle)>>,
}
struct ResourceRead {
    page_id: Uuid,
    connection: Arc<Connection>,
    id: Uuid,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Drop for ResourceRead {
    fn drop(&mut self) {
        self.connection
            .resource_reads
            .lock()
            .unwrap()
            .remove(&self.id);
        if let Some(slot) = self.connection.media.lock().unwrap().get_mut(&self.page_id) {
            if slot.inspection == Some(self.id) {
                slot.inspection = None;
            }
        }
    }
}
impl Connection {
    #[cfg(test)]
    pub fn new(dispatch: Option<Dispatcher>, events: mpsc::Sender<Value>) -> Self {
        Self::for_site(dispatch, events, String::new())
    }
    pub fn for_site(dispatch: Option<Dispatcher>, events: mpsc::Sender<Value>, origin: String) -> Self {
        let (overflow, failed) = watch::channel(false);
        Self {
            owner: Uuid::new_v4(),
            dispatch,
            events: Events {
                origin,
                queue: events,
                overflow,
            },
            overflow: failed,
            media: Mutex::new(BTreeMap::new()),
            media_reads: Arc::new(tokio::sync::Semaphore::new(MAX_MEDIA_READS)),
            resource_reads: Mutex::new(BTreeMap::new()),
        }
    }
    pub(super) fn owner(&self) -> Uuid {
        self.owner
    }

    pub fn media_source(&self, page: Uuid) -> Option<piik_channel_core::wire::WatchByteSource> {
        self.media
            .lock()
            .unwrap()
            .get(&page)
            .and_then(|slot| slot.active.as_ref())
            .filter(|active| !*active.cancel.borrow() && !*active.retired.borrow() && !*active.provider_retired.borrow())
            .map(|active| active.source.clone())
    }
    fn retire_media(&self, page: Uuid, root: Uuid) {
        let removed = {
            let mut sources = self.media.lock().unwrap();
            let Some(slot) = sources.get_mut(&page) else { return };
            if !slot.active.as_ref().is_some_and(|active| active.source.resource_id == root) { return; }
            let removed = slot.active.take();
            if slot.pending.is_none() && slot.mpd.is_none() && slot.inspection.is_none() {
                sources.remove(&page);
            }
            removed
        };
        drop(removed); // Cancels this reader's in-flight origin reads before notifying the page.
        self.events.send(serde_json::json!({"type":"page_media_changed","pageId":page}));
    }
    pub fn stop_media(&self, page: Uuid) {
        self.media.lock().unwrap().remove(&page);
    }
    pub fn prepare_indexed_media(
        self: &Arc<Self>,
        page: Uuid,
        video: indexed::TrackRecipe,
        audio: Option<indexed::TrackRecipe>,
        host: mpsc::Sender<HostCommand>,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        self.prepare_selection(page, MediaSelection::Indexed { video, audio }, host)
    }
    pub fn prepare_media(
        self: &Arc<Self>,
        page: Uuid,
        choice: Uuid,
        host: mpsc::Sender<HostCommand>,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        self.prepare_selection(page, MediaSelection::Direct(choice), host)
    }
    fn prepare_selection(
        self: &Arc<Self>,
        page: Uuid,
        selection: MediaSelection,
        host: mpsc::Sender<HostCommand>,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        let (cancel, mut cancelled) = match &selection {
            MediaSelection::Mpd { catalog, .. } => {
                (catalog.cancel.clone(), catalog.cancel.subscribe())
            }
            _ => watch::channel(false),
        };
        let catalog_source = match &selection {
            MediaSelection::Mpd { catalog, .. } => Some(catalog.snapshot.source_id),
            _ => None,
        };
        let generation = Uuid::new_v4();
        {
            let mut sources = self.media.lock().unwrap();
            if sources.len() >= 64 && !sources.contains_key(&page) {
                bail!("page_player_limit");
            }
            let slot = sources.entry(page).or_default();
            if slot.pending.is_some() || slot.active.is_some() {
                bail!("watch_source_busy");
            }
            slot.pending = Some((generation, cancel.clone()));
        }
        let connection = self.clone();
        Ok(async move {
            let work = async {
                let dispatch = connection.dispatch.as_ref().ok_or_else(|| anyhow!("page_player_unavailable"))?;
                let owner = connection.owner;
                let resolve = |choice_id, indexed| async move {
                    let (reply, result) = oneshot::channel();
                    ensure_dispatch(dispatch(Command::Media { owner, page_id: page, choice_id, indexed, reply }))?;
                    result.await?.map_err(anyhow::Error::msg)
                };
                let (root, format, reader, retired): (
                    _,
                    _,
                    Arc<dyn piik_channel_native::watch::Reader>,
                    watch::Receiver<bool>,
                ) = match selection {
                    MediaSelection::Mpd { catalog, selected } => {
                        catalog
                            .reader
                            .admit_mpd(catalog.snapshot.clone(), selected)
                            .await?;
                        (
                            catalog.reader.root,
                            Format::Dash,
                            catalog.reader.clone(),
                            catalog.retired.clone(),
                        )
                    }
                    MediaSelection::Direct(choice) => {
                        let (context, _) = resolve(choice, false).await?;
                        ensure!(
                            context.format != Format::Dash,
                            "watch_mpd_selection_required"
                        );
                        let format = context.format;
                        let retired = context.retired.clone();
                        let reader = reader::OriginReader::prepare(context, cancel.subscribe()).await?;
                        (reader.root, format, reader, retired)
                    }
                    MediaSelection::Indexed { video, audio } => {
                        let (video_context, file) = resolve(video.choice_id, true).await?;
                        let retired = video_context.retired.clone();
                        let video_reader = file.open(video_context)?;
                        let audio = if let Some(recipe) = audio {
                            let (context, file) = resolve(recipe.choice_id, true).await?;
                            Some((recipe, file.open(context)?))
                        } else { None };
                        let reader = indexed::IndexedReader::prepare((video, video_reader), audio, cancel.subscribe()).await?;
                        (reader.root, Format::Hls, reader, retired)
                    }
                };
                let (lifetime, provider_ready) = oneshot::channel::<watch::Receiver<bool>>();
                let owner = Arc::downgrade(&connection);
                let mut watching = retired.clone();
                let mut stop = cancel.subscribe();
                let revoke = host.clone();
                // Own revocation before Register can enqueue a successful reply.
                tokio::spawn(async move {
                    let provider = async {
                        if let Ok(mut retired) = provider_ready.await {
                            let _ = retired.wait_for(|value| *value).await;
                        }
                    };
                    tokio::select! {
                        _ = watching.wait_for(|value| *value) => {},
                        _ = stop.wait_for(|value| *value) => {},
                        _ = provider => {},
                    }
                    if let Some(connection) = owner.upgrade() {
                        connection.retire_media(page, root);
                    }
                    let _ = revoke.send(HostCommand::RevokeWatchReader { resource_id: root }).await;
                });
                let (result, response) = oneshot::channel();
                host.send(HostCommand::RegisterWatchReader { resource_id: root, reader: reader.clone(), result }).await.map_err(|_| anyhow!("hosting_unavailable"))?;
                let provider = response.await?.map_err(anyhow::Error::msg)?;
                let source = piik_channel_core::wire::WatchByteSource { session_id: provider.session_id, resource_id: root, format };
                let registration = Registration { reader, source: source.clone(), retired, cancel: cancel.clone(), provider_retired: provider.retired.clone() };
                let _ = lifetime.send(provider.retired);
                {
                    let mut sources = connection.media.lock().unwrap();
                    ensure_not_cancelled(&cancel)?;
                    anyhow::ensure!(
                        !*registration.retired.borrow() && !*registration.provider_retired.borrow(),
                        "watch_source_retired"
                    );
                    let slot = sources
                        .get_mut(&page)
                        .ok_or_else(|| anyhow!("watch_source_retired"))?;
                    anyhow::ensure!(
                        slot.pending
                            .as_ref()
                            .is_some_and(|(id, _)| *id == generation),
                        "watch_source_retired"
                    );
                    ensure!(
                        catalog_source.is_none_or(|id| slot
                            .mpd
                            .as_ref()
                            .is_some_and(|catalog| catalog.snapshot.source_id == id)),
                        "watch_source_changed"
                    );
                    slot.active = Some(registration);
                    slot.pending = None;
                }
                Ok(serde_json::to_value(source)?)
            };
            let result = tokio::select! {
                biased;
                _ = cancelled.wait_for(|value| *value) => Err(anyhow!("watch_source_retired")),
                result = work => result,
            };
            if result.is_err() {
                let mut sources = connection.media.lock().unwrap();
                if let Some(slot) = sources.get_mut(&page) {
                    if slot.pending.as_ref().is_some_and(|(id, _)| *id == generation) { slot.pending = None; }
                }
                sources.retain(|_, slot| {
                    slot.pending.is_some()
                        || slot.active.is_some()
                        || slot.mpd.is_some()
                        || slot.inspection.is_some()
                });
            }
            result
        }.boxed())
    }
    pub fn read_resource(
        self: &Arc<Self>,
        page_id: Uuid,
        source_id: Uuid,
        resource_id: Uuid,
        read_id: Uuid,
        offset: u64,
        length: u32,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        anyhow::ensure!(
            length > 0
                && length as usize <= WATCH_WINDOW_BYTES
                && offset
                    .checked_add(u64::from(length))
                    .is_some_and(|end| end <= SAFE_INTEGER),
            "invalid_watch_range"
        );
        let reader = {
            let pages = self.media.lock().unwrap();
            let active = pages
                .get(&page_id)
                .and_then(|slot| slot.active.as_ref())
                .filter(|active| {
                    !*active.cancel.borrow()
                        && !*active.retired.borrow()
                        && !*active.provider_retired.borrow()
                        && active.source.resource_id == source_id
                })
                .ok_or_else(|| anyhow!("watch_source_retired"))?;
            active.reader.clone()
        };
        let (lease, cancelled) = self.begin_read(page_id, read_id)?;
        Ok(async move {
            let _lease = lease;
            use base64ct::{Base64, Encoding};
            let result = Abortable::new(reader.read(resource_id, offset, length), cancelled).await;
            let result = result.map_err(|_| anyhow!("watch_read_cancelled"))??;
            Ok(serde_json::json!({"mimeType":result.mime_type,"totalSize":result.total_size,"bytesBase64":Base64::encode_string(&result.bytes),"eof":result.eof}))
        }.boxed())
    }
    fn begin_read(
        self: &Arc<Self>,
        page_id: Uuid,
        read_id: Uuid,
    ) -> Result<(ResourceRead, AbortRegistration)> {
        let permit = self
            .media_reads
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow!("watch_read_busy"))?;
        let (cancel, cancelled) = AbortHandle::new_pair();
        {
            let mut reads = self.resource_reads.lock().unwrap();
            anyhow::ensure!(!reads.contains_key(&read_id), "watch_read_busy");
            reads.insert(read_id, (page_id, cancel));
        }
        let lease = ResourceRead {
            page_id,
            connection: self.clone(),
            id: read_id,
            _permit: permit,
        };
        Ok((lease, cancelled))
    }
    pub fn cancel_resource(&self, page_id: Uuid, read_id: Uuid) {
        if let Some((page, cancel)) = self.resource_reads.lock().unwrap().get(&read_id) {
            if *page == page_id {
                cancel.abort();
            }
        }
    }
    pub async fn overflowed(&self) {
        let mut failed = self.overflow.clone();
        let _ = failed.wait_for(|value| *value).await;
    }
    pub fn read_metadata(
        self: &Arc<Self>,
        page_id: Uuid,
        choice_id: Uuid,
        read_id: Uuid,
        offset: u64,
        length: u32,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        anyhow::ensure!(
            length > 0
                && length as usize <= WATCH_WINDOW_BYTES
                && offset
                    .checked_add(length as u64)
                    .is_some_and(|end| end <= MAX_METADATA_BYTES),
            "invalid_watch_range"
        );
        let (lease, cancelled) = self.begin_read(page_id, read_id)?;
        Ok(async move {
            use base64ct::{Base64, Encoding};
            let connection = &lease.connection;
            let result = Abortable::new(async {
                let dispatch = connection.dispatch.as_ref().ok_or_else(|| anyhow!("page_player_unavailable"))?;
                let (reply, result) = oneshot::channel();
                ensure_dispatch(dispatch(Command::Media {
                    owner: connection.owner, page_id, choice_id, indexed: true, reply,
                }))?;
                let (context, file) = tokio::time::timeout(Duration::from_secs(5), result).await
                    .map_err(|_| anyhow!("page_player_timeout"))??.map_err(anyhow::Error::msg)?;
                file.open(context)?.read_metadata(offset, length).await
            }, cancelled).await.map_err(|_| anyhow!("watch_read_cancelled"))??;
            Ok(serde_json::json!({"mimeType":result.mime_type,"totalSize":result.total_size,"bytesBase64":Base64::encode_string(&result.bytes)}))
        }.boxed())
    }
    pub async fn request(&self, operation: Operation) -> Result<Value> {
        if let Operation::PageClose { page_id } = &operation {
            self.stop_media(*page_id);
            for (page, cancel) in self.resource_reads.lock().unwrap().values() {
                if page == page_id {
                    cancel.abort();
                }
            }
        }
        let Some(dispatch) = &self.dispatch else {
            bail!("page_player_unavailable")
        };
        if let Operation::PagePrepare { url, .. } = &operation {
            if !valid_url(url) {
                bail!("invalid_watch_url");
            }
        }
        if let Operation::PagePatch { patch, .. } = &operation {
            patch.validate()?;
        }
        let (reply, mut result) = oneshot::channel();
        if !dispatch(Command::Request {
            owner: self.owner,
            operation,
            events: self.events.clone(),
            reply,
        }) {
            bail!("page_player_unavailable");
        }
        let response = match tokio::time::timeout(Duration::from_secs(5), &mut result).await {
            Ok(reply) => reply.map_err(|_| anyhow!("page_player_closed"))?,
            Err(_) => {
                // A UI reply can win the send while the timer wins the poll.
                result.close();
                result.try_recv().map_err(|_| anyhow!("page_player_timeout"))?
            }
        };
        response.map_err(anyhow::Error::msg)
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.media.lock().unwrap().clear();
        if let Some(dispatch) = &self.dispatch {
            dispatch(Command::Retire { owner: self.owner });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelling_after_native_registration_reply_was_queued_still_revokes_reader() {
        use piik_channel_native::{peer::NativePeers, session::WatchReaderRegistration};
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/owned", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, axum::Router::new().route("/owned", axum::routing::get(|headers: axum::http::HeaderMap| async move {
                let range = headers.get("range").unwrap().to_str().unwrap();
                let offset: usize = range.strip_prefix("bytes=").unwrap().split('-').next().unwrap().parse().unwrap();
                axum::http::Response::builder().status(206).header("content-type", "video/mp4")
                    .header("content-range", format!("bytes {offset}-{offset}/4"))
                    .body(axum::body::Body::from(vec![42])).unwrap()
            }))).await.unwrap();
        });
        let (_page_alive, retired) = watch::channel(false);
        let dispatch = Arc::new(move |command| {
            if let Command::Media { reply, .. } = command {
                let _ = reply.send(Ok((MediaContext { request: None, url: url.clone(), format: Format::File,
                    size: Some(4), retired: retired.clone(), cookies: Arc::new(|_| Box::pin(async { Ok(None) })) }, Default::default())));
            }
            true
        });
        let (events, _queue) = mpsc::channel(8);
        let connection = Arc::new(Connection::new(Some(dispatch), events));
        let (host, mut commands) = mpsc::channel(8);
        let (events, _queue) = mpsc::channel(8);
        let session = Uuid::new_v4();
        let mut peers = NativePeers::new(session, vec![], events);
        let page = Uuid::new_v4();
        let mut preparing = connection.prepare_media(page, Uuid::new_v4(), host).unwrap();
        let command = tokio::select! {
            command = commands.recv() => command.unwrap(),
            result = preparing.as_mut() => panic!("prepare completed before registration: {result:?}"),
        };
        let HostCommand::RegisterWatchReader { resource_id, reader, result } = command else { panic!("register expected") };
        let retired = peers.register_watch_reader(resource_id, reader.clone()).await.unwrap();
        result.send(Ok(WatchReaderRegistration { session_id: session, retired })).unwrap();
        // No poll of the App future occurs between accepted reply and cancellation.
        connection.stop_media(page);
        assert_eq!(preparing.await.unwrap_err().to_string(), "watch_source_retired");
        let revoked = tokio::time::timeout(Duration::from_millis(300), commands.recv()).await;
        peers.close().await.unwrap();
        server.abort(); let _ = server.await;
        let Some(HostCommand::RevokeWatchReader { resource_id: root }) = revoked.expect("accepted queued reply leaked its reader") else { panic!("accepted queued reply leaked its reader: no revocation") };
        assert_eq!(root, resource_id);
        assert!(connection.media_source(page).is_none());
        assert_eq!(reader.read(resource_id, 0, 1).await.unwrap_err().to_string(), "watch_source_retired");
    }

    #[tokio::test]
    async fn native_generation_retirement_releases_page_source_reads_and_allows_explicit_prepare() {
        use piik_channel_native::{peer::NativePeers, session::WatchReaderRegistration};
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/owned", listener.local_addr().unwrap());
        let (entered, mut requests) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, axum::Router::new().route("/owned", axum::routing::get(move |headers: axum::http::HeaderMap| {
                let entered = entered.clone();
                async move {
                    let range = headers.get("range").unwrap().to_str().unwrap();
                    if range == "bytes=2-2" {
                        entered.send(()).unwrap();
                        std::future::pending::<()>().await;
                    }
                    let offset: usize = range.strip_prefix("bytes=").unwrap().split('-').next().unwrap().parse().unwrap();
                    axum::http::Response::builder().status(206)
                        .header("content-type", "video/mp4")
                        .header("content-range", format!("bytes {offset}-{offset}/4"))
                        .body(axum::body::Body::from(vec![42])).unwrap()
                }
            }))).await.unwrap();
        });
        let (_page_retire, page_retired) = watch::channel(false);
        let dispatch = Arc::new(move |command| {
            if let Command::Media { reply, .. } = command {
                let _ = reply.send(Ok((MediaContext { request: None, url: url.clone(), format: Format::File,
                    size: Some(4), retired: page_retired.clone(), cookies: Arc::new(|_| Box::pin(async { Ok(None) })) }, Default::default())));
            }
            true
        });
        let (events, mut changed) = mpsc::channel(8);
        let connection = Arc::new(Connection::new(Some(dispatch), events));
        let page = Uuid::new_v4();
        let (host, mut commands) = mpsc::channel(8);
        let (peer_events, _peer_queue) = mpsc::channel(8);
        let old_session = Uuid::new_v4();
        let mut peers = NativePeers::new(old_session, vec![], peer_events);
        let prepare = connection.prepare_media(page, Uuid::new_v4(), host.clone()).unwrap();
        let register = async {
            let Some(HostCommand::RegisterWatchReader { resource_id, reader, result }) = commands.recv().await else { panic!("register expected") };
            let retired = peers.register_watch_reader(resource_id, reader).await.unwrap();
            result.send(Ok(WatchReaderRegistration { session_id: old_session, retired })).unwrap();
        };
        let (prepared, ()) = tokio::join!(prepare, register);
        let old: piik_channel_core::wire::WatchByteSource = serde_json::from_value(prepared.unwrap()).unwrap();
        assert_eq!(connection.media_source(page).unwrap().session_id, old_session);

        // Resynchronizing the same NativePeers is the short-resume path, not retirement.
        peers.resync().await.unwrap();
        assert_eq!(connection.media_source(page).unwrap().resource_id, old.resource_id);
        let result = connection.read_resource(page, old.resource_id, old.resource_id, Uuid::new_v4(), 0, 1).unwrap().await.unwrap();
        assert_eq!(result["bytesBase64"], "Kg==");
        assert!(changed.try_recv().is_err());

        let read = connection.read_resource(page, old.resource_id, old.resource_id, Uuid::new_v4(), 2, 1).unwrap();
        let waiting = tokio::spawn(read);
        tokio::time::timeout(Duration::from_secs(2), requests.recv()).await.unwrap().unwrap();
        peers.close().await.unwrap();
        assert!(connection.media_source(page).is_none());
        let event = tokio::time::timeout(Duration::from_secs(2), changed.recv()).await.unwrap().unwrap();
        assert_eq!(event["type"], "page_media_changed");
        assert_eq!(event["pageId"], page.to_string());
        assert_eq!(waiting.await.unwrap().unwrap_err().to_string(), "watch_source_retired");
        assert!(connection.media.lock().unwrap().get(&page).is_none());
        assert!(connection.read_resource(page, old.resource_id, old.resource_id, Uuid::new_v4(), 0, 1).is_err());
        let Some(HostCommand::RevokeWatchReader { resource_id }) = commands.recv().await else { panic!("revoke expected") };
        assert_eq!(resource_id, old.resource_id);

        // Only a subsequent explicit prepare registers a fresh reader in the next bank.
        let new_session = Uuid::new_v4();
        let (events, _queue) = mpsc::channel(8);
        let mut next = NativePeers::new(new_session, vec![], events);
        let prepare = connection.prepare_media(page, Uuid::new_v4(), host.clone()).unwrap();
        let register = async {
            let Some(HostCommand::RegisterWatchReader { resource_id, reader, result }) = commands.recv().await else { panic!("new register expected") };
            let retired = next.register_watch_reader(resource_id, reader).await.unwrap();
            result.send(Ok(WatchReaderRegistration { session_id: new_session, retired })).unwrap();
        };
        let (prepared, ()) = tokio::join!(prepare, register);
        let fresh: piik_channel_core::wire::WatchByteSource = serde_json::from_value(prepared.unwrap()).unwrap();
        assert_eq!(fresh.session_id, new_session);
        assert_ne!(fresh.resource_id, old.resource_id);
        connection.retire_media(page, old.resource_id);
        assert_eq!(connection.media_source(page).unwrap().resource_id, fresh.resource_id);
        assert!(changed.try_recv().is_err());
        connection.stop_media(page);
        next.close().await.unwrap();
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn active_resource_reads_share_the_registered_reader_and_cancel_only_their_read() {
        use piik_channel_native::watch::{ReadResult, Reader};
        struct OwnedReader {
            stopped: watch::Receiver<bool>,
            root: Uuid,
            calls: std::sync::atomic::AtomicUsize,
        }
        impl Reader for OwnedReader {
            fn read(
                &self,
                id: Uuid,
                offset: u64,
                _: u32,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ReadResult>> + Send + '_>>
            {
                Box::pin(async move {
                    self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    anyhow::ensure!(id == self.root, "watch_resource_unavailable");
                    if offset == 1 {
                        let mut stopped = self.stopped.clone();
                        let _ = stopped.wait_for(|v| *v).await;
                        bail!("watch_source_retired");
                    }
                    Ok(ReadResult {
                        mime_type: "video/mp4".into(),
                        total_size: Some(1),
                        bytes: vec![42],
                        eof: true,
                    })
                })
            }
        }
        let (events, _) = mpsc::channel(8);
        let connection = Arc::new(Connection::new(None, events));
        let page = Uuid::new_v4();
        let root = Uuid::new_v4();
        let (cancel, stopped) = watch::channel(false);
        let reader = Arc::new(OwnedReader {
            stopped,
            root,
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let (_retire, retired) = watch::channel(false);
        connection.media.lock().unwrap().insert(
            page,
            MediaSlot {
                inspection: None,
                mpd: None,
                pending: None,
                active: Some(Registration {
                    reader: reader.clone(),
                    source: piik_channel_core::wire::WatchByteSource {
                        session_id: Uuid::new_v4(),
                        resource_id: root,
                        format: Format::File,
                    },
                    retired,
                    cancel,
                    provider_retired: watch::channel(false).1,
                }),
            },
        );
        assert!(Arc::ptr_eq(
            &connection.media.lock().unwrap()[&page]
                .active
                .as_ref()
                .unwrap()
                .reader,
            &(reader.clone() as Arc<dyn Reader>)
        ));
        let result = connection
            .read_resource(page, root, root, Uuid::new_v4(), 0, 1)
            .unwrap()
            .await
            .unwrap();
        assert_eq!(result["bytesBase64"], "Kg==");
        assert_eq!(result["eof"], true);
        assert!(connection
            .read_resource(Uuid::new_v4(), root, root, Uuid::new_v4(), 0, 1)
            .is_err());
        assert!(connection
            .read_resource(page, Uuid::new_v4(), root, Uuid::new_v4(), 0, 1)
            .is_err());
        assert!(connection
            .read_resource(page, root, Uuid::new_v4(), Uuid::new_v4(), 0, 1)
            .unwrap()
            .await
            .is_err());
        let first = Uuid::new_v4();
        let mut pending = vec![];
        for id in [first, Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()] {
            pending.push(
                connection
                    .read_resource(page, root, root, id, 1, 1)
                    .unwrap(),
            );
        }
        assert!(connection
            .read_resource(page, root, root, Uuid::new_v4(), 0, 1)
            .is_err());
        assert!(connection.media_reads.try_acquire().is_err());
        connection.cancel_resource(Uuid::new_v4(), first);
        assert!(!connection.resource_reads.lock().unwrap()[&first]
            .1
            .is_aborted());
        assert!(futures_util::poll!(pending[0].as_mut()).is_pending());
        connection.cancel_resource(page, first);
        assert_eq!(
            pending.remove(0).await.unwrap_err().to_string(),
            "watch_read_cancelled"
        );
        assert_eq!(connection.resource_reads.lock().unwrap().len(), 3);
        drop(pending);
        assert_eq!(connection.media_reads.available_permits(), 4);
        assert!(connection.resource_reads.lock().unwrap().is_empty());
        let mut stopping = connection
            .read_resource(page, root, root, Uuid::new_v4(), 1, 1)
            .unwrap();
        assert!(futures_util::poll!(stopping.as_mut()).is_pending());
        connection.stop_media(page);
        assert_eq!(
            stopping.await.unwrap_err().to_string(),
            "watch_source_retired"
        );
        assert_eq!(connection.media_reads.available_permits(), 4);
        assert!(connection
            .read_resource(page, root, root, Uuid::new_v4(), 0, 1)
            .is_err());
    }
    #[test]
    fn active_resource_operation_rejects_urls_and_accepts_cancel() {
        for action in ["read", "read_metadata", "cancel"] {
            let mut value = serde_json::json!({"type":"page_media_resource","action":action,"pageId":Uuid::new_v4(),"readId":Uuid::new_v4()});
            if action == "read" {
                value["sourceId"] = serde_json::json!(Uuid::new_v4());
                value["resourceId"] = serde_json::json!(Uuid::new_v4());
                value["offset"] = serde_json::json!(0);
                value["length"] = serde_json::json!(1);
            }
            if action == "read_metadata" {
                value["choiceId"] = serde_json::json!(Uuid::new_v4());
                value["offset"] = serde_json::json!(0);
                value["length"] = serde_json::json!(1);
            }
            assert!(serde_json::from_value::<Operation>(value.clone()).is_ok());
            value["url"] = serde_json::json!("https://not-admitted.test");
            assert!(serde_json::from_value::<Operation>(value).is_err());
        }
    }
    #[tokio::test]
    async fn metadata_allows_four_reads_and_page_retirement_releases_their_slots() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/media?grant=private",
            listener.local_addr().unwrap()
        );
        let (received, mut requests) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route(
                    "/media",
                    axum::routing::get(move || {
                        let received = received.clone();
                        async move {
                            received.send(()).unwrap();
                            std::future::pending::<String>().await
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let (retire, retired) = watch::channel(false);
        let (events, _) = mpsc::channel(8);
        let connection = Arc::new(Connection::new(
            Some(Arc::new(move |command| {
                if let Command::Media {
                    indexed: true,
                    reply,
                    ..
                } = command
                {
                    let _ = reply.send(Ok((MediaContext {
                        url: url.clone(),
                        request: None,
                        format: Format::File,
                        size: Some(1000),
                        retired: retired.clone(),
                        cookies: Arc::new(|_| Box::pin(async { Ok(None) })),
                    }, Default::default())));
                }
                true
            })),
            events,
        ));
        let mut reads = vec![];
        for _ in 0..4 {
            let connection = connection.clone();
            reads.push(tokio::spawn(async move {
                connection
                    .read_metadata(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), 0, 16)
                    .unwrap()
                    .await
            }));
        }
        for _ in 0..4 {
            tokio::time::timeout(Duration::from_secs(2), requests.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            connection
                .read_metadata(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), 0, 16)
                .err()
                .unwrap()
                .to_string(),
            "watch_read_busy"
        );
        retire.send_replace(true);
        for read in reads {
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), read)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap_err()
                    .to_string(),
                "watch_source_retired"
            );
        }
        assert_eq!(connection.media_reads.available_permits(), 4);
        assert_eq!(
            connection
                .read_metadata(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), 0, 16)
                .unwrap()
                .await
                .unwrap_err()
                .to_string(),
            "watch_source_retired"
        );
        assert_eq!(connection.media_reads.available_permits(), 4);
        server.abort();
    }

    #[tokio::test]
    async fn metadata_cancel_drops_http_body_and_releases_its_slot_for_the_next_read() {
        use axum::{
            body::{Body, Bytes},
            extract::Request,
            http::Response,
            routing::get,
            Router,
        };
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/media?grant=private",
            listener.local_addr().unwrap()
        );
        let (entered, mut requests) = mpsc::unbounded_channel();
        let (dropped, mut drops) = mpsc::unbounded_channel();
        struct PendingBody(mpsc::UnboundedSender<()>);
        impl Drop for PendingBody {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/media",
                    get(move |request: Request| {
                        let entered = entered.clone();
                        let dropped = dropped.clone();
                        async move {
                            let range = request.headers()["range"].to_str().unwrap();
                            let start: u64 = range
                                .strip_prefix("bytes=")
                                .unwrap()
                                .split_once('-')
                                .unwrap()
                                .0
                                .parse()
                                .unwrap();
                            let body = if start == 0 {
                                let pending = PendingBody(dropped);
                                Body::from_stream(futures_util::stream::poll_fn(move |_| {
                                    let _ = &pending;
                                    std::task::Poll::Pending::<Option<std::io::Result<Bytes>>>
                                }))
                            } else if start == 32 {
                                Body::from_stream(futures_util::stream::once(async {
                                    Err::<Bytes, _>(std::io::Error::other("fixture body failed"))
                                }))
                            } else {
                                Body::from(vec![42; 16])
                            };
                            entered.send(start).unwrap();
                            Response::builder()
                                .status(206)
                                .header("content-range", format!("bytes {start}-{}/64", start + 15))
                                .header("content-length", 16)
                                .body(body)
                                .unwrap()
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let (_page, retired) = watch::channel(false);
        let (events, _) = mpsc::channel(8);
        let connection = Arc::new(Connection::new(
            Some(Arc::new(move |command| {
                if let Command::Media { reply, .. } = command {
                    let _ = reply.send(Ok((MediaContext {
                        url: url.clone(),
                        request: None,
                        format: Format::File,
                        size: Some(64),
                        retired: retired.clone(),
                        cookies: Arc::new(|_| Box::pin(async { Ok(None) })),
                    }, Default::default())));
                }
                true
            })),
            events,
        ));
        let page = Uuid::new_v4();
        let choice = Uuid::new_v4();
        let id = Uuid::new_v4();
        let reading = tokio::spawn(connection.read_metadata(page, choice, id, 0, 16).unwrap());
        assert_eq!(requests.recv().await, Some(0));
        connection.cancel_resource(page, id);
        assert_eq!(
            reading.await.unwrap().unwrap_err().to_string(),
            "watch_read_cancelled"
        );
        tokio::time::timeout(Duration::from_secs(1), drops.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(connection.media_reads.available_permits(), MAX_MEDIA_READS);
        assert!(connection.resource_reads.lock().unwrap().is_empty());
        let result = connection
            .read_metadata(page, choice, Uuid::new_v4(), 16, 16)
            .unwrap()
            .await
            .unwrap();
        use base64ct::{Base64, Encoding};
        assert_eq!(
            Base64::decode_vec(result["bytesBase64"].as_str().unwrap()).unwrap(),
            vec![42; 16]
        );
        let error = connection
            .read_metadata(page, choice, Uuid::new_v4(), 32, 16)
            .unwrap()
            .await
            .unwrap_err();
        assert!(!format!("{error:?}").contains("grant=private"));
        assert_eq!(connection.media_reads.available_permits(), MAX_MEDIA_READS);
        assert!(connection.resource_reads.lock().unwrap().is_empty());
        connection
            .read_metadata(page, choice, Uuid::new_v4(), 16, 16)
            .unwrap()
            .await
            .unwrap();
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn page_close_cancels_metadata_before_its_context_arrives() {
        let replies = Arc::new(Mutex::new(vec![]));
        let pending = replies.clone();
        let (events, _) = mpsc::channel(8);
        let connection = Arc::new(Connection::new(
            Some(Arc::new(move |command| {
                match command {
                    Command::Media { reply, .. } => pending.lock().unwrap().push(reply),
                    Command::Request { reply, .. } => {
                        let _ = reply.send(Ok(Value::Null));
                    }
                    _ => {}
                }
                true
            })),
            events,
        ));
        let page = Uuid::new_v4();
        let mut reading = connection
            .read_metadata(page, Uuid::new_v4(), Uuid::new_v4(), 0, 16)
            .unwrap();
        assert!(futures_util::poll!(reading.as_mut()).is_pending());
        connection
            .request(Operation::PageClose { page_id: page })
            .await
            .unwrap();
        assert_eq!(
            reading.await.unwrap_err().to_string(),
            "watch_read_cancelled"
        );
        assert!(replies
            .lock()
            .unwrap()
            .pop()
            .unwrap()
            .send(Err("late context".into()))
            .is_err());
        assert_eq!(connection.media_reads.available_permits(), MAX_MEDIA_READS);
        assert!(connection.resource_reads.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn metadata_bounds_reject_before_resolving_a_page_context() {
        let (sent, mut commands) = mpsc::unbounded_channel();
        let (events, _) = mpsc::channel(8);
        let connection = Arc::new(Connection::new(
            Some(Arc::new(move |command| sent.send(command).is_ok())),
            events,
        ));
        for (offset, length) in [(0, 0), (0, 65537), (1024 * 1024, 1), (u64::MAX, 1)] {
            assert_eq!(
                connection
                    .read_metadata(
                        Uuid::new_v4(),
                        Uuid::new_v4(),
                        Uuid::new_v4(),
                        offset,
                        length
                    )
                    .err()
                    .unwrap()
                    .to_string(),
                "invalid_watch_range"
            );
        }
        assert!(commands.try_recv().is_err());
        assert!(serde_json::from_value::<Operation>(serde_json::json!({"type":"page_media_read_metadata","pageId":Uuid::new_v4(),"choiceId":Uuid::new_v4(),"offset":0,"length":1,"url":"https://other.test"})).is_err());
    }

    #[tokio::test]
    async fn connection_owns_requests_and_retires_on_drop() {
        let (sent, mut commands) = mpsc::unbounded_channel();
        let (events, _) = mpsc::channel(8);
        let connection = Connection::new(
            Some(Arc::new(move |command| sent.send(command).is_ok())),
            events,
        );
        let request = connection.request(Operation::PageRead {
            page_id: Uuid::new_v4(),
        });
        let answer = async {
            let Command::Request { owner, reply, .. } = commands.recv().await.unwrap() else {
                panic!()
            };
            reply.send(Ok(Value::Null)).unwrap();
            owner
        };
        let (result, owner) = tokio::join!(request, answer);
        assert_eq!(result.unwrap(), Value::Null);
        drop(connection);
        assert!(
            matches!(commands.recv().await,Some(Command::Retire{owner:actual}) if actual==owner)
        );
    }
    #[tokio::test]
    async fn hide_is_a_page_owned_command_and_does_not_retire_the_connection() {
        let (sent, mut commands) = mpsc::unbounded_channel();
        let (events, _queue) = mpsc::channel(8);
        let connection = Connection::new(
            Some(Arc::new(move |command| sent.send(command).is_ok())),
            events,
        );
        let id = Uuid::new_v4();
        let operation: Operation =
            serde_json::from_value(serde_json::json!({"type":"page_hide","pageId":id})).unwrap();
        let request = connection.request(operation);
        let respond = async {
            let Command::Request {
                owner,
                operation: Operation::PageHide { page_id },
                reply,
                ..
            } = commands.recv().await.unwrap()
            else {
                panic!("wrong page operation");
            };
            assert_eq!(page_id, id);
            reply.send(Ok(Value::Null)).unwrap();
            owner
        };
        let (result, owner) = tokio::join!(request, respond);
        assert_eq!(result.unwrap(), Value::Null);
        assert!(commands.try_recv().is_err());
        drop(connection);
        assert!(
            matches!(commands.recv().await,Some(Command::Retire {owner: actual}) if owner==actual)
        );
        assert!(serde_json::from_value::<Operation>(
            serde_json::json!({"type":"page_hide","pageId":id,"viewId":Uuid::new_v4()})
        )
        .is_err());
    }

    #[tokio::test]
    async fn event_overflow_does_not_silently_lose_retirement() {
        let (events, _queue) = mpsc::channel(1);
        let connection = Connection::new(None, events);
        connection
            .events
            .send(serde_json::json!({"type":"page_sample"}));
        connection
            .events
            .send(serde_json::json!({"type":"page_closed"}));
        tokio::time::timeout(Duration::from_millis(100), connection.overflowed())
            .await
            .unwrap();
    }
    #[test]
    fn page_input_is_media_only() {
        assert!(valid_url("https://example.com/watch"));
        assert!(!valid_url("file:///secret"));
        assert!(!valid_url("https://name:password@example.com/"));
        assert!(
            serde_json::from_value::<Patch>(serde_json::json!({"position":1,"headers":{}}))
                .is_err()
        );
        assert!(Patch {
            position: None,
            paused: None,
            rate: Some(17.)
        }
        .validate()
        .is_err());
    }
}

fn ensure_dispatch(ok: bool) -> Result<()> {
    if !ok {
        bail!("page_player_unavailable");
    }
    Ok(())
}
fn ensure_not_cancelled(cancel: &watch::Sender<bool>) -> Result<()> {
    if *cancel.borrow() {
        bail!("watch_source_retired");
    }
    Ok(())
}

#[cfg(test)]
#[path = "app_page/mpd_selection_tests.rs"]
mod mpd_selection_tests;

#[cfg(test)]
#[path = "app_page/indexed_file_tests.rs"]
mod indexed_file_tests;
