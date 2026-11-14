//! Page players belong to one approved App WebSocket, never to website messages.
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

pub type Dispatcher = Arc<dyn Fn(Command) -> bool + Send + Sync>;
pub enum Command {
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
pub struct Connection {
    owner: Uuid,
    dispatch: Option<Dispatcher>,
    events: Events,
    overflow: watch::Receiver<bool>,
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
        }
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
