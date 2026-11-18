//! HTTP only locates a live page permit; the page owns all producer generations.
#[cfg(all(test, feature = "capture"))]
#[path = "app_whip_cancel_tests.rs"]
mod cancel_tests;
#[cfg(test)]
#[path = "app_whip_http_tests.rs"]
mod http_tests;

use super::*;
use axum::extract::Path;
use futures_util::future::Shared;
use piik_channel_native::peer::ExternalControl;
use std::sync::{Mutex as SyncMutex, Weak};

pub(super) const ENDPOINT: &str = "/whip/{permit}";
pub(super) const SESSION: &str = "/whip/{permit}/{generation}";

pub(super) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route(ENDPOINT, get(describe).post(offer).options(describe))
        .route(
            SESSION,
            get(describe_session)
                .delete(delete)
                .options(describe_session),
        )
}

pub(super) fn methods(path: &str) -> Option<&'static str> {
    match path {
        ENDPOINT => Some("GET, HEAD, POST, OPTIONS"),
        SESSION => Some("GET, HEAD, DELETE, OPTIONS"),
        _ => None,
    }
}

pub(super) type Ended = Shared<BoxFuture<'static, Result<(), String>>>;
pub(super) struct Resource {
    pub permit: Uuid,
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
pub(super) struct Page {
    pub permits: BTreeMap<Uuid, Arc<Permit>>,
    pub resources: BTreeMap<Uuid, Resource>,
}
impl Page {
    pub fn remove(&mut self, publication: Uuid) -> bool {
        if let Some(permit) = self.permits.remove(&publication) {
            permit.revoke();
            for resource in self
                .resources
                .values()
                .filter(|resource| resource.permit == permit.id)
            {
                resource.control.stop();
            }
            true
        } else {
            false
        }
    }
}
impl Drop for Page {
    fn drop(&mut self) {
        for permit in self.permits.values() {
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
    Inspect {
        permit: Arc<Permit>,
        generation: Uuid,
        response: oneshot::Sender<Result<(), StatusCode>>,
    },
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

async fn describe(
    State(app): State<Arc<App>>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    if app.external_inputs.authorized(id, &headers).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    (StatusCode::OK, [("accept-post", "application/sdp")]).into_response()
}

async fn describe_session(
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
        .try_send(Request::Inspect {
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

/// The pending page operation and HTTP caller own this preparation wait.
pub(super) async fn prepare(
    permit: &Permit,
    commands: mpsc::Sender<HostCommand>,
    offer: String,
    replaces: Option<Uuid>,
    registration: futures_util::future::AbortRegistration,
    response: &mut oneshot::Sender<Result<(Uuid, String), StatusCode>>,
) -> Result<piik_channel_native::peer::PreparedExternal> {
    let mut revoked = permit.cancelled();
    let work = async {
        let (result, prepared) = oneshot::channel();
        commands
            .send(HostCommand::PrepareExternal(session::PrepareExternal {
                publication_id: permit.publication,
                room_id: permit.room.clone(),
                offer,
                replaces,
                result,
            }))
            .await
            .map_err(|_| anyhow!("hosting_unavailable"))?;
        prepared
            .await
            .map_err(|_| anyhow!("hosting_unavailable"))?
            .map_err(anyhow::Error::msg)
    };
    tokio::select! {
        biased;
        _ = response.closed() => Err(anyhow!("capture_cancelled")),
        _ = revoked.wait_for(|value| *value) => Err(anyhow!("capture_cancelled")),
        result = Abortable::new(work, registration) => result.unwrap_or_else(|_| Err(anyhow!("capture_cancelled"))),
    }
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

    #[tokio::test]
    async fn offer_preparation_retires_when_its_page_permit_or_http_caller_cancels() {
        for cause in ["page", "permit", "http"] {
            let (snapshot, observed) = watch::channel(None);
            let publication = Uuid::new_v4();
            let (requests, _queue) = mpsc::channel(1);
            let permit = Inputs::default().permit(
                publication,
                "owned-room".into(),
                requests,
                piik_channel_native::peer::InputAuthority {
                    scope: piik_channel_native::peer::CaptureScope {
                        publication_id: publication,
                        room_id: "owned-room".into(),
                        binding_id: Uuid::new_v4(),
                    },
                    snapshot: observed,
                },
            );
            let (commands, mut native) = mpsc::channel(1);
            let (response, http) = oneshot::channel();
            let mut http = Some(http);
            let mut capture = Capture::default();
            let mut page = Page {
                permits: BTreeMap::from([(publication, permit.clone())]),
                resources: BTreeMap::new(),
            };
            let (_cancel, registration) = capture
                .prepare(SourceKind::External, SourceAudioSettings::default())
                .unwrap();
            let source = permit.clone();
            let work = tokio::spawn(async move {
                let mut response = response;
                prepare(
                    &source,
                    commands,
                    "owned-offer".into(),
                    None,
                    registration,
                    &mut response,
                )
                .await
            });
            let HostCommand::PrepareExternal(pending) = native.recv().await.unwrap() else {
                panic!("expected Native external preparation")
            };
            assert!(!pending.result.is_closed());
            match cause {
                "page" => {
                    let event =
                        cancel_external_input(publication, Some(&mut capture), &mut page).unwrap();
                    assert_eq!(event["state"], "closed");
                    assert!(!page.permits.contains_key(&publication));
                }
                "permit" => permit.revoke(),
                "http" => {
                    drop(http.take());
                }
                _ => unreachable!(),
            }
            let result = timeout(Duration::from_secs(1), work)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                result.err().unwrap().to_string(),
                "capture_cancelled",
                "{cause}"
            );
            assert!(
                pending.result.is_closed(),
                "{cause} must cancel Native's pending preparation result"
            );
            assert_eq!(*permit.revoked.borrow(), cause != "http");
            drop(snapshot);
        }
    }

    #[test]
    fn cancelling_external_waiting_or_first_frame_retires_the_permit_not_the_next_candidate() {
        for first_frame in [false, true] {
            let publication = Uuid::new_v4();
            let binding = Uuid::new_v4();
            let state: piik_channel_core::wire::Snapshot = serde_json::from_value(json!({
                "channel":{"id":Uuid::new_v4(),"name":"Owned fixture","icon":"couch","ownerId":null,"userCount":1,"historyWindow":100,
                    "rooms":[{"id":"room","name":"Room","icon":"couch","creatorId":Uuid::new_v4(),"access":"private","hidden":false,
                        "hasPassword":false,"voiceBitrate":64000,"relayOverride":null,"authorized":true,"canManage":false,"available":true,"reading":false,
                        "lastMessageSeq":0,"participantSessionIds":[],"fileActivity":[],"capabilities":{"attachments":true},
                        "delivery":{"hostSessionId":Uuid::new_v4(),"bindingId":binding,"nextHops":{}}}]},
                "files":[],"users":[],"sessions":[],"publications":[],"voice":[],"subscriptions":[],"failedSubscriptions":[],"pairs":[],"iceServers":[],
                "watchActivities":[],"watchSubscriptions":[],"watchBytes":[]
            })).unwrap();
            let (_snapshot, observed) = watch::channel(Some(state));
            let inputs = Inputs::default();
            let (requests, _queue) = mpsc::channel(1);
            let permit = inputs.permit(
                publication,
                "room".into(),
                requests,
                piik_channel_native::peer::InputAuthority {
                    scope: piik_channel_native::peer::CaptureScope {
                        publication_id: publication,
                        room_id: "room".into(),
                        binding_id: binding,
                    },
                    snapshot: observed,
                },
            );
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                format!("Bearer {}", permit.token).parse().unwrap(),
            );
            assert!(inputs.authorized(permit.id, &headers).is_some());
            let mut page = Page {
                permits: BTreeMap::from([(publication, permit.clone())]),
                resources: BTreeMap::new(),
            };
            let mut capture = Capture::default();
            let previous = Uuid::new_v4();
            let cancelled = first_frame.then(|| {
                let (cancelled, _) = capture
                    .prepare(SourceKind::External, SourceAudioSettings::default())
                    .unwrap();
                capture.pending.as_mut().unwrap().producer = Some(previous);
                cancelled
            });
            let audio_settings = SourceAudioSettings {
                bitrate: 96_000,
                gain: 0.5,
            };
            capture.audio_settings = audio_settings;
            let event = cancel_external_input(publication, Some(&mut capture), &mut page).unwrap();
            assert_eq!(
                event,
                external_input_event(publication, None, None, true, None)
            );
            assert!(capture.pending.is_none());
            assert_eq!(capture.audio_settings, audio_settings);
            assert!(cancelled.is_none_or(|request| request.is_aborted()));
            assert!(
                inputs.authorized(permit.id, &headers).is_none(),
                "late offers must lose their original permit"
            );
            assert!(!page.permits.contains_key(&publication));

            let next = Uuid::new_v4();
            let (current, _) = capture
                .prepare(SourceKind::External, audio_settings)
                .unwrap();
            capture.pending.as_mut().unwrap().producer = Some(next);
            assert!(
                capture.pending_for(previous).is_none(),
                "late readiness cannot install the cancelled source"
            );
            assert!(
                !capture.retire_producer(previous),
                "late end cannot retire the successor"
            );
            assert!(!current.is_aborted());
            assert_eq!(capture.pending.as_ref().unwrap().producer, Some(next));
        }
    }

    #[tokio::test]
    async fn failed_offer_preparation_does_not_block_the_next_native_request() {
        let (_snapshot, observed) = watch::channel(None);
        let publication = Uuid::new_v4();
        let (requests, _queue) = mpsc::channel(1);
        let permit = Inputs::default().permit(
            publication,
            "owned-room".into(),
            requests,
            piik_channel_native::peer::InputAuthority {
                scope: piik_channel_native::peer::CaptureScope {
                    publication_id: publication,
                    room_id: "owned-room".into(),
                    binding_id: Uuid::new_v4(),
                },
                snapshot: observed,
            },
        );
        let (commands, mut native) = mpsc::channel(1);
        for reason in ["first_offer_rejected", "next_offer_reached_native"] {
            let (_, registration) = AbortHandle::new_pair();
            let (mut response, _http) = oneshot::channel();
            let preparing = prepare(
                &permit,
                commands.clone(),
                "owned-offer".into(),
                None,
                registration,
                &mut response,
            );
            let producer = async {
                let HostCommand::PrepareExternal(pending) = native.recv().await.unwrap() else {
                    panic!("external prepare")
                };
                assert!(!pending.result.is_closed());
                assert!(pending.result.send(Err(reason.into())).is_ok());
            };
            let (result, _) = tokio::join!(preparing, producer);
            assert_eq!(result.err().unwrap().to_string(), reason);
        }
        assert!(
            !*permit.revoked.borrow(),
            "a failed stream does not revoke the page's input permission"
        );
    }

    #[test]
    fn page_revocation_rejects_inflight_http_and_independent_tokens_do_not_cross_permits() {
        let inputs = Inputs::default();
        let (requests, _queue) = mpsc::channel(2);
        let binding = Uuid::new_v4();
        let state: piik_channel_core::wire::Snapshot = serde_json::from_value(json!({
            "channel":{"id":Uuid::new_v4(),"name":"Owned fixture","icon":"couch","ownerId":null,"userCount":1,"historyWindow":100,
                "rooms":[{"id":"room","name":"Room","icon":"couch","creatorId":Uuid::new_v4(),"access":"private","hidden":false,
                    "hasPassword":false,"voiceBitrate":64000,"relayOverride":null,"authorized":true,"canManage":false,"available":true,"reading":false,
                    "lastMessageSeq":0,"participantSessionIds":[],"fileActivity":[],"capabilities":{"attachments":true},
                    "delivery":{"hostSessionId":Uuid::new_v4(),"bindingId":binding,"nextHops":{}}}]},
            "files":[],"users":[],"sessions":[],"publications":[],"voice":[],"subscriptions":[],"failedSubscriptions":[],"pairs":[],"iceServers":[],
            "watchActivities":[],"watchSubscriptions":[],"watchBytes":[]
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
        let second = inputs.permit(
            publication,
            "room".into(),
            requests.clone(),
            authority(publication),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", first.token).parse().unwrap(),
        );
        assert!(inputs.authorized(first.id, &headers).is_some());
        assert!(inputs.authorized(second.id, &headers).is_none());
        let mut page = Page {
            permits: BTreeMap::from([(first.publication, first.clone())]),
            resources: BTreeMap::new(),
        };
        assert!(page.remove(first.publication));
        let successor = inputs.permit(
            first.publication,
            "room".into(),
            requests,
            authority(first.publication),
        );
        page.permits
            .insert(successor.publication, successor.clone());
        assert!(first.stopped());
        assert!(!successor.stopped());
        assert!(inputs.authorized(first.id, &headers).is_none());
        // The HTTP request can retain its Arc, but never extend page authority.
        drop(page);
        assert!(first.stopped());
        assert!(successor.stopped());
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
