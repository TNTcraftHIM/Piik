use super::{request_origin, App, HostCommand};
use crate::backup::{self, ApiResult};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use piik_channel_core::backup::OwnCredential;
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

async fn owner(
    app: &App,
    headers: &HeaderMap,
    domain: Uuid,
    user: Uuid,
) -> Result<(mpsc::Sender<HostCommand>, OwnCredential), (StatusCode, axum::Json<serde_json::Value>)>
{
    let forbidden = || backup::error(StatusCode::FORBIDDEN, "forbidden");
    if backup::bearer(headers) != Some(app.token.as_str()) {
        return Err(forbidden());
    }
    let site = request_origin(headers).ok_or_else(forbidden)?;
    let credential = headers
        .get("x-piik-credential")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(forbidden)?;
    let registry = app.registry.lock().await;
    if registry.permission(&site).is_none() || *app.closing.borrow() {
        return Err(forbidden());
    }
    let host = registry
        .hosts
        .get(&(site, domain, user))
        .filter(|host| {
            host.credential == credential
                && !host.task.is_finished()
                && matches!(*host.ready.borrow(), Some(Ok(())))
        })
        .ok_or_else(forbidden)?;
    Ok((
        host.commands.clone(),
        OwnCredential {
            user_id: user,
            credential: credential.into(),
        },
    ))
}

pub(super) async fn export(
    State(app): State<Arc<App>>,
    Path((domain, user, room)): Path<(Uuid, Uuid, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let (commands, credential) = owner(&app, &headers, domain, user).await?;
    backup::export(commands, room, credential).await
}

pub(super) async fn describe(
    State(app): State<Arc<App>>,
    Path((domain, user)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> ApiResult {
    let (commands, _) = owner(&app, &headers, domain, user).await?;
    backup::describe(commands).await
}

pub(super) async fn restore(
    State(app): State<Arc<App>>,
    Path((domain, user)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult {
    let (commands, _) = owner(&app, &headers, domain, user).await?;
    backup::restore(commands, &headers, body).await
}
