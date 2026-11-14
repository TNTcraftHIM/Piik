//! Page players belong to one approved App WebSocket, never to website messages.
use anyhow::{anyhow, bail, Result};
use futures_util::{future::BoxFuture, FutureExt};
use piik_channel_native::session::HostCommand;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Mutex};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;
#[path = "app_page/reader.rs"]
mod reader;
pub use piik_channel_core::wire::WatchFormat as Format;
pub type Cookies = Arc<dyn Fn(String) -> BoxFuture<'static, Result<Option<String>>> + Send + Sync>;
pub struct MediaContext {
    pub url: String,
    pub format: Format,
    pub size: Option<u64>,
    pub retired: watch::Receiver<bool>,
    pub cookies: Cookies,
}

pub type Dispatcher = Arc<dyn Fn(Command) -> bool + Send + Sync>;
pub enum Command {
    Media {
        owner: Uuid,
        page_id: Uuid,
        choice_id: Uuid,
        reply: oneshot::Sender<Result<MediaContext, String>>,
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
    PagePrepare { page_id: Uuid, url: String },
    PageSelect { page_id: Uuid, candidate_id: Uuid },
    PageRead { page_id: Uuid },
    PagePatch { page_id: Uuid, patch: Patch },
    PageFocus { page_id: Uuid },
    PageClose { page_id: Uuid },
    PageMediaSources { page_id: Uuid },
    PageMediaPrepare { page_id: Uuid, choice_id: Uuid },
    PageMediaStop { page_id: Uuid },
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
    source: Option<piik_channel_core::wire::WatchByteSource>,
    retired: watch::Receiver<bool>,
    cancel: watch::Sender<bool>,
    _task: tokio::task::JoinHandle<()>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}
#[derive(Default)]
struct MediaSlot {
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
pub struct Connection {
    owner: Uuid,
    dispatch: Option<Dispatcher>,
    events: Events,
    overflow: watch::Receiver<bool>,
    media: Mutex<BTreeMap<Uuid, MediaSlot>>,
}
impl Connection {
    pub fn new(dispatch: Option<Dispatcher>, events: mpsc::Sender<Value>) -> Self {
        let (overflow, failed) = watch::channel(false);
        Self {
            owner: Uuid::new_v4(),
            dispatch,
            events: Events {
                queue: events,
                overflow,
            },
            overflow: failed,
            media: Mutex::new(BTreeMap::new()),
        }
    }
    pub fn media_source(&self, page: Uuid) -> Option<piik_channel_core::wire::WatchByteSource> {
        self.media
            .lock()
            .unwrap()
            .get(&page)
            .and_then(|slot| slot.active.as_ref())
            .filter(|active| !*active.cancel.borrow() && !*active.retired.borrow())
            .and_then(|active| active.source.clone())
    }
    pub fn stop_media(&self, page: Uuid) {
        self.media.lock().unwrap().remove(&page);
    }
    pub fn prepare_media(
        self: &Arc<Self>,
        page: Uuid,
        choice: Uuid,
        host: mpsc::Sender<HostCommand>,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        let (cancel, mut cancelled) = watch::channel(false);
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
                let (reply, result) = oneshot::channel();
                ensure_dispatch(dispatch(Command::Media { owner: connection.owner, page_id: page, choice_id: choice, reply }))?;
                let context = result.await?.map_err(anyhow::Error::msg)?;
                let format = context.format;
                let retired = context.retired.clone();
                let mut watching = retired.clone();
                let reader = reader::OriginReader::prepare(context, cancel.subscribe()).await?;
                let root = reader.root;
                let (result, response) = oneshot::channel();
                let revoke = host.clone();
                let mut stop = cancel.subscribe();
                let task = tokio::spawn(async move {
                    tokio::select! {
                        _ = watching.wait_for(|value| *value) => {},
                        _ = stop.wait_for(|value| *value) => {},
                    }
                    let _ = revoke.send(HostCommand::RevokeWatchReader { resource_id: root }).await;
                });
                let mut registration = Registration { source: None, retired, cancel: cancel.clone(), _task: task };
                host.send(HostCommand::RegisterWatchReader { resource_id: root, reader, result }).await.map_err(|_| anyhow!("hosting_unavailable"))?;
                let session_id = response.await?.map_err(anyhow::Error::msg)?;
                registration.source = Some(piik_channel_core::wire::WatchByteSource { session_id, resource_id: root, format });
                ensure_not_cancelled(&cancel)?;
                anyhow::ensure!(!*registration.retired.borrow(), "watch_source_retired");
                let mut sources = connection.media.lock().unwrap();
                let slot = sources.get_mut(&page).ok_or_else(|| anyhow!("watch_source_retired"))?;
                anyhow::ensure!(slot.pending.as_ref().is_some_and(|(id, _)| *id == generation), "watch_source_retired");
                slot.active = Some(registration);
                slot.pending = None;
                Ok(serde_json::json!({"sessionId": session_id, "resourceId": root, "format": format}))
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
                sources.retain(|_, slot| slot.pending.is_some() || slot.active.is_some());
            }
            result
        }.boxed())
    }
    pub async fn overflowed(&self) {
        let mut failed = self.overflow.clone();
        let _ = failed.wait_for(|value| *value).await;
    }
    pub async fn request(&self, operation: Operation) -> Result<Value> {
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
        let (reply, result) = oneshot::channel();
        if !dispatch(Command::Request {
            owner: self.owner,
            operation,
            events: self.events.clone(),
            reply,
        }) {
            bail!("page_player_unavailable");
        }
        tokio::time::timeout(Duration::from_secs(5), result)
            .await
            .map_err(|_| anyhow!("page_player_timeout"))?
            .map_err(|_| anyhow!("page_player_closed"))?
            .map_err(anyhow::Error::msg)
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
