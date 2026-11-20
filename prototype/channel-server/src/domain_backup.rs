use super::{Domain, Hub};
use crate::backup::{self, ApiError, ApiResult};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use piik_channel_core::{
    backup::{DomainMetadata, OwnCredential},
    wire::HostingMode,
    Authority,
};
use piik_channel_native::{
    backup::StagedBackup,
    session::{ExistingRoomRestore, HostCommand},
};
use std::sync::MutexGuard;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

pub(crate) struct RestoreDomain {
    pub metadata: DomainMetadata,
    pub credential: String,
    pub result: oneshot::Sender<Result<Uuid, String>>,
}

fn authorized<'a>(
    domain: &'a Domain,
    headers: &HeaderMap,
    permits: impl FnOnce(&Authority, Uuid) -> bool,
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
    let user_id = hub
        .authority
        .user_for_credential(credential)
        .ok_or_else(forbidden)?
        .id;
    if !permits(&hub.authority, user_id) {
        return Err(forbidden());
    }
    Ok((
        OwnCredential {
            user_id,
            credential: credential.into(),
        },
        hub,
    ))
}

fn owner<'a>(
    domain: &'a Domain,
    headers: &HeaderMap,
) -> Result<(OwnCredential, MutexGuard<'a, Hub>), ApiError> {
    authorized(domain, headers, |authority, user| {
        authority.identity().1 == user
    })
}

fn room_commands(hub: &Hub) -> Result<mpsc::Sender<HostCommand>, ApiError> {
    hub.room_commands
        .clone()
        .ok_or_else(|| backup::error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))
}

fn room_creator(
    domain: &Domain,
    headers: &HeaderMap,
    room: &str,
) -> Result<(mpsc::Sender<HostCommand>, OwnCredential), ApiError> {
    let (credential, hub) = authorized(domain, headers, |authority, user| {
        authority.is_room_creator(room, user)
            && (authority.hosting_mode() == HostingMode::Hosted || authority.identity().1 == user)
    })?;
    Ok((room_commands(&hub)?, credential))
}

pub(super) async fn export(
    State(domain): State<Domain>,
    Path(room): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let (commands, credential) = room_creator(&domain, &headers, &room)?;
    backup::export(commands, room, Some(credential.user_id), credential).await
}

pub(super) async fn describe(State(domain): State<Domain>, headers: HeaderMap) -> ApiResult {
    let commands = room_commands(&owner(&domain, &headers)?.1)?;
    backup::describe(commands).await
}

pub(super) async fn restore(
    State(domain): State<Domain>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult {
    let commands = room_commands(&owner(&domain, &headers)?.1)?;
    backup::restore(commands, None, &headers, body).await
}

pub(super) async fn restore_existing(
    State(domain): State<Domain>,
    Path(room): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult {
    let (commands, credential) = room_creator(&domain, &headers, &room)?;
    let scratch = domain
        .room_restore
        .try_acquire_owned()
        .map_err(|_| backup::error(StatusCode::CONFLICT, "room_busy"))?;
    let target = ExistingRoomRestore {
        room_id: room,
        creator: credential.user_id,
        scratch,
    };
    backup::restore(commands, Some(target), &headers, body).await
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
