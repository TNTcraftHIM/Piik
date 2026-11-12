//! HTTP only locates a live page permit; the page owns all producer generations.
use super::*;
use axum::extract::Path;
use futures_util::future::Shared;
use piik_channel_native::peer::ExternalControl;
use std::sync::{Mutex as SyncMutex, Weak};

pub(super) type Ended = Shared<BoxFuture<'static, Result<(), String>>>;
pub(super) struct Resource {
    pub permit: Uuid,
    pub publication: Uuid,
    pub control: ExternalControl,
    pub ended: Ended,
    pub deleting: bool,
}
impl Drop for Resource {
    fn drop(&mut self) {
        self.control.stop();
    }
}
#[derive(Default)]
pub(super) struct Page(pub BTreeMap<Uuid, Arc<Permit>>);
impl Page {
    pub fn remove(&mut self, publication: Uuid) -> bool {
        if let Some(permit) = self.0.remove(&publication) {
            permit.revoke();
            true
        } else {
            false
        }
    }
}
impl Drop for Page {
    fn drop(&mut self) {
        for permit in self.0.values() {
            permit.revoke();
        }
    }
}

#[derive(Default)]
pub(super) struct Inputs(SyncMutex<BTreeMap<Uuid, Weak<Permit>>>);

pub(super) struct Permit {
    pub id: Uuid,
    pub publication: Uuid,
    pub room: String,
    token: String,
    pub authority: piik_channel_native::peer::InputAuthority,
    requests: mpsc::Sender<Request>,
    revoked: watch::Sender<bool>,
}
impl Permit {
    pub fn stopped(&self) -> bool {
        *self.revoked.borrow() || !self.authority.is_current()
    }
    pub fn revoke(&self) {
        self.revoked.send_replace(true);
    }
    pub fn cancelled(&self) -> watch::Receiver<bool> {
        self.revoked.subscribe()
    }
    pub fn descriptor(&self, port: u16) -> Value {
        json!({"endpoint":format!("http://127.0.0.1:{port}/whip/{}",self.id),"token":self.token})
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.revoke();
    }
}
impl Inputs {
    pub fn permit(
        &self,
        publication: Uuid,
        room: String,
        requests: mpsc::Sender<Request>,
        authority: piik_channel_native::peer::InputAuthority,
    ) -> Arc<Permit> {
        let permit = Arc::new(Permit {
            id: Uuid::new_v4(),
            publication,
            room,
            token: Uuid::new_v4().to_string(),
            authority,
            requests,
            revoked: watch::channel(false).0,
        });
        let mut entries = self.0.lock().unwrap();
        entries.retain(|_, entry| entry.strong_count() > 0);
        entries.insert(permit.id, Arc::downgrade(&permit));
        permit
    }
    fn authorized(&self, id: Uuid, headers: &HeaderMap) -> Option<Arc<Permit>> {
        let permit = self.0.lock().unwrap().get(&id)?.upgrade()?;
        (!permit.stopped()
            && headers.get(header::AUTHORIZATION)?.to_str().ok()?
                == format!("Bearer {}", permit.token))
        .then_some(permit)
    }
}

pub(super) enum Request {
    Offer {
        permit: Arc<Permit>,
        offer: String,
        response: oneshot::Sender<Result<(Uuid, String), StatusCode>>,
    },
    Delete {
        permit: Arc<Permit>,
        generation: Uuid,
        response: oneshot::Sender<Result<(), StatusCode>>,
    },
}

pub(super) async fn offer(
    State(app): State<Arc<App>>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let Some(permit) = app.external_inputs.authorized(id, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(str::trim)
        != Some("application/sdp")
    {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    if body.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let (response, result) = oneshot::channel();
    if permit
        .requests
        .try_send(Request::Offer {
            permit: permit.clone(),
            offer: body,
            response,
        })
        .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    match result.await {
        Ok(Ok((generation, answer))) => (
            StatusCode::CREATED,
            [
                (header::CONTENT_TYPE, "application/sdp".to_owned()),
                (header::LOCATION, format!("/whip/{id}/{generation}")),
            ],
            answer,
        )
            .into_response(),
        Ok(Err(status)) => status.into_response(),
        Err(_) => StatusCode::GONE.into_response(),
    }
}

pub(super) async fn delete(
    State(app): State<Arc<App>>,
    Path((id, generation)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let Some(permit) = app.external_inputs.authorized(id, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let (response, result) = oneshot::channel();
    if permit
        .requests
        .try_send(Request::Delete {
            permit: permit.clone(),
            generation,
            response,
        })
        .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    match result.await {
        Ok(Ok(())) => StatusCode::OK,
        Ok(Err(status)) => status,
        Err(_) => StatusCode::GONE,
    }
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_revocation_rejects_inflight_http_and_independent_tokens_do_not_cross_permits() {
        let inputs = Inputs::default();
        let (requests, _queue) = mpsc::channel(2);
        let binding = Uuid::new_v4();
        let state: piik_channel_core::wire::Snapshot = serde_json::from_value(json!({
            "channel":{"id":Uuid::new_v4(),"name":"Owned fixture","icon":"couch","ownerId":null,"userCount":1,"historyWindow":100,
                "rooms":[{"id":"room","name":"Room","icon":"couch","creatorId":Uuid::new_v4(),"access":"private","hidden":false,
                    "hasPassword":false,"voiceBitrate":64000,"relayOverride":null,"authorized":true,"canManage":false,"available":true,"reading":false,
                    "lastMessageSeq":0,"participantSessionIds":[],"realtimeSessionIds":[],"capabilities":{"attachments":true},
                    "delivery":{"hostSessionId":Uuid::new_v4(),"bindingId":binding,"nextHops":{}}}]},
            "files":[],"users":[],"sessions":[],"publications":[],"voice":[],"subscriptions":[],"failedSubscriptions":[],"pairs":[],"iceServers":[]
        })).unwrap();
        let (snapshot, observed) = watch::channel(Some(state.clone()));
        let authority = |publication_id| piik_channel_native::peer::InputAuthority {
            scope: piik_channel_native::peer::CaptureScope {
                publication_id,
                room_id: "room".into(),
                binding_id: binding,
            },
            snapshot: observed.clone(),
        };
        let publication = Uuid::new_v4();
        let first = inputs.permit(
            publication,
            "room".into(),
            requests.clone(),
            authority(publication),
        );
        let publication = Uuid::new_v4();
        let second = inputs.permit(publication, "room".into(), requests, authority(publication));
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", first.token).parse().unwrap(),
        );
        assert!(inputs.authorized(first.id, &headers).is_some());
        assert!(inputs.authorized(second.id, &headers).is_none());
        let page = Page(BTreeMap::from([(first.publication, first.clone())]));
        // The HTTP request can retain its Arc, but never extend page authority.
        drop(page);
        assert!(first.stopped());
        assert!(inputs.authorized(first.id, &headers).is_none());
        assert!(!second.stopped());
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", second.token).parse().unwrap(),
        );
        let mut state = state;
        state.channel.rooms[0].authorized = false;
        snapshot.send_replace(Some(state));
        assert!(inputs.authorized(second.id, &headers).is_none());
    }
}
