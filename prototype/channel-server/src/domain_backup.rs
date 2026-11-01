use super::Domain;
use crate::backup::{self, ApiResult};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
};
use piik_channel_core::backup::OwnCredential;
use piik_channel_native::session::HostCommand;
use tokio::sync::mpsc;

fn owner(
    domain: &Domain,
    headers: &HeaderMap,
) -> Result<(mpsc::Sender<HostCommand>, OwnCredential), (StatusCode, axum::Json<serde_json::Value>)>
{
    let forbidden = || backup::error(StatusCode::FORBIDDEN, "forbidden");
    let credential = backup::bearer(headers).ok_or_else(forbidden)?;
    if headers.get(header::ORIGIN).is_some_and(|value| {
        value
            .to_str()
            .ok()
            .is_none_or(|origin| !domain.allows_origin(origin))
    }) {
        return Err(forbidden());
    }
    let hub = domain.hub.lock().unwrap();
    if !hub.authority.is_owner_credential(credential) {
        return Err(forbidden());
    }
    let commands = domain
        .room_commands
        .clone()
        .ok_or_else(|| backup::error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?;
    Ok((
        commands,
        OwnCredential {
            user_id: hub.authority.identity().1,
            credential: credential.into(),
        },
    ))
}

pub(super) async fn export(
    State(domain): State<Domain>,
    Path(room): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let (commands, credential) = owner(&domain, &headers)?;
    backup::export(commands, room, credential).await
}

pub(super) async fn describe(State(domain): State<Domain>, headers: HeaderMap) -> ApiResult {
    let (commands, _) = owner(&domain, &headers)?;
    backup::describe(commands).await
}

pub(super) async fn restore(
    State(domain): State<Domain>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult {
    let (commands, _) = owner(&domain, &headers)?;
    backup::restore(commands, &headers, body).await
}
