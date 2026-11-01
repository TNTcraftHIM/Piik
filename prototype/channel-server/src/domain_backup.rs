use super::{Domain, Hub};
use crate::backup::{self, ApiError, ApiResult};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use piik_channel_core::backup::{DomainMetadata, OwnCredential};
use piik_channel_native::{backup::StagedBackup, session::HostCommand};
use std::sync::MutexGuard;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

pub(crate) struct RestoreDomain {
    pub metadata: DomainMetadata,
    pub credential: String,
    pub result: oneshot::Sender<Result<Uuid, String>>,
}

fn owner<'a>(
    domain: &'a Domain,
    headers: &HeaderMap,
) -> Result<(OwnCredential, MutexGuard<'a, Hub>), ApiError> {
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
    Ok((
        OwnCredential {
            user_id: hub.authority.identity().1,
            credential: credential.into(),
        },
        hub,
    ))
}

fn room_owner(
    domain: &Domain,
    headers: &HeaderMap,
) -> Result<(mpsc::Sender<HostCommand>, OwnCredential), ApiError> {
    let (credential, hub) = owner(domain, headers)?;
    let commands = hub
        .room_commands
        .clone()
        .ok_or_else(|| backup::error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?;
    Ok((commands, credential))
}

pub(super) async fn export(
    State(domain): State<Domain>,
    Path(room): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let (commands, credential) = room_owner(&domain, &headers)?;
    backup::export(commands, room, credential).await
}

pub(super) async fn describe(State(domain): State<Domain>, headers: HeaderMap) -> ApiResult {
    let (commands, _) = room_owner(&domain, &headers)?;
    backup::describe(commands).await
}

pub(super) async fn restore(
    State(domain): State<Domain>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult {
    let (commands, _) = room_owner(&domain, &headers)?;
    backup::restore(commands, &headers, body).await
}

pub(super) async fn export_domain(State(domain): State<Domain>, headers: HeaderMap) -> ApiResult {
    let metadata: DomainMetadata = {
        let (_, hub) = owner(&domain, &headers)?;
        let checkpoint = hub
            .storage
            .lock()
            .unwrap()
            .load()
            .map_err(|error| backup::error(StatusCode::INTERNAL_SERVER_ERROR, error))?
            .expect("opened domain has a checkpoint");
        serde_json::from_value(checkpoint)
            .map_err(|error| backup::error(StatusCode::INTERNAL_SERVER_ERROR, error))?
    };
    Ok(backup::archive("domain.piik.zip", move |writer| {
        piik_channel_native::backup::write_domain(&metadata, writer)
    }))
}

pub(super) async fn restore_domain(
    State(domain): State<Domain>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult {
    let credential = owner(&domain, &headers)?.0.credential;
    let commands = domain.restores.clone().ok_or_else(|| {
        backup::error(
            StatusCode::SERVICE_UNAVAILABLE,
            "domain_restore_unavailable",
        )
    })?;
    let (staged, directory) = backup::stage(&headers, body).await?;
    let metadata = match staged {
        StagedBackup::Domain(metadata) => metadata,
        other => {
            // Close a wrong-kind room's SQLite handle before its temp directory.
            drop(other);
            return Err(backup::error(
                StatusCode::BAD_REQUEST,
                "expected_domain_backup",
            ));
        }
    };
    drop(directory);
    let (result, response) = oneshot::channel();
    commands
        .send(RestoreDomain {
            metadata,
            credential,
            result,
        })
        .await
        .map_err(|_| {
            backup::error(
                StatusCode::SERVICE_UNAVAILABLE,
                "domain_restore_unavailable",
            )
        })?;
    let domain_id = response
        .await
        .map_err(|_| {
            backup::error(
                StatusCode::SERVICE_UNAVAILABLE,
                "domain_restore_unavailable",
            )
        })?
        .map_err(|error| backup::error(StatusCode::CONFLICT, error))?;
    Ok(Json(serde_json::json!({"domainId":domain_id})).into_response())
}
