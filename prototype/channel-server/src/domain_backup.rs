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
    backup::{DomainMetadata, OwnCredential, RoomMetadata},
    wire::{Command, HostingMode},
    Authority,
};
use piik_channel_native::{
    backup::{self as native_backup, RoomSnapshot, StagedBackup},
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
    let scratch = domain
        .room_restore
        .try_acquire_owned()
        .map_err(|_| backup::error(StatusCode::CONFLICT, "room_busy"))?;
    backup::restore(commands, None, Some(scratch), &headers, body).await
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
    };
    backup::restore(commands, Some(target), Some(scratch), &headers, body).await
}

fn creation_error(code: &str) -> ApiError {
    let status = match code {
        "forbidden" | "room_creation_restricted" => StatusCode::FORBIDDEN,
        "disconnected" | "room_limit" | "room_already_exists" | "room_busy" => StatusCode::CONFLICT,
        "hosting_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    };
    backup::error(status, code)
}

pub(super) async fn create_copy(
    State(domain): State<Domain>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult {
    let session: Uuid = headers
        .get("x-piik-session")
        .and_then(|value| value.to_str().ok()?.parse().ok())
        .ok_or_else(|| creation_error("forbidden"))?;
    let (connection, mut closing) = {
        let (creator, hub) = authorized(&domain, &headers, |auth, _| {
            auth.hosting_mode() == HostingMode::Hosted
        })?;
        let connection = hub
            .authority
            .creation_connection(session, creator.user_id)
            .map_err(creation_error)?;
        let client = hub
            .clients
            .get(&connection)
            .ok_or_else(|| creation_error("disconnected"))?;
        (connection, client.close.subscribe())
    };
    let scratch = domain
        .room_restore
        .clone()
        .try_acquire_owned()
        .map_err(|_| creation_error("room_busy"))?;
    let (archive, directory, scratch) = tokio::select! {
        biased;
        _ = closing.wait_for(|closed| *closed) => return Err(creation_error("disconnected")),
        upload = backup::receive_copy_upload(&headers, body, scratch) => upload?,
    };
    let authority = domain.hub.clone();
    let (creation, snapshot, scratch) = tokio::task::spawn_blocking(move || {
        let (command, submission) =
            native_backup::open_room_copy(archive).map_err(backup::upload_error)?;
        let Command::CreateRoom {
            mut room,
            picture,
            password,
            allow_service_relay,
        } = command
        else {
            return Err(creation_error("expected_create_room"));
        };
        room.has_password = password.is_some();
        let (domain_id, creation) = {
            let hub = authority.lock().unwrap();
            let creation = hub
                .authority
                .prepare_hosted_creation(session, connection, room)
                .map_err(creation_error)?;
            (hub.authority.identity().0, creation)
        };
        let policy = creation
            .summary()
            .new_policy(password, picture, allow_service_relay)
            .map_err(creation_error)?;
        let metadata = RoomMetadata {
            version: RoomMetadata::VERSION,
            domain_id,
            policy,
            own_credential: None,
            retained_files: vec![],
        };
        let room = submission
            .stage(directory.path(), metadata)
            .map_err(backup::upload_error)?;
        Ok((creation, RoomSnapshot { room, directory }, scratch))
    })
    .await
    .map_err(|cause| backup::error(StatusCode::INTERNAL_SERVER_ERROR, cause))??;

    let (result, response) = oneshot::channel();
    {
        let mut hub = domain.hub.lock().unwrap();
        let writer = room_commands(&hub)?
            .try_reserve_owned()
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => creation_error("room_busy"),
                mpsc::error::TrySendError::Closed(_) => creation_error("hosting_unavailable"),
            })?;
        hub.authority
            .reserve_hosted_creation(&creation)
            .map_err(creation_error)?;
        writer.send(HostCommand::CreateCopy {
            snapshot,
            scratch,
            result,
        });
    }
    // After handoff, the room writer's outcome owns the reservation even if the HTTP client leaves.
    tokio::spawn(async move {
        let room_id = &creation.summary().id;
        match response.await {
            Ok(Ok(room)) => Ok((
                StatusCode::CREATED,
                Json(serde_json::json!({ "room": room })),
            )
                .into_response()),
            Ok(Err(code)) if code == "room_created_connection_failed" => Err((
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": code, "roomId": room_id })),
            )),
            Ok(Err(code)) => {
                let mut hub = domain.hub.lock().unwrap();
                let effects = hub.authority.cancel_hosted_creation(&creation);
                hub.apply(effects);
                Err(creation_error(&code))
            }
            Err(_) => Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(
                    serde_json::json!({ "error": "room_creation_unconfirmed", "roomId": room_id }),
                ),
            )),
        }
    })
    .await
    .map_err(|cause| backup::error(StatusCode::INTERNAL_SERVER_ERROR, cause))?
}

pub(super) async fn export_domain(State(domain): State<Domain>, headers: HeaderMap) -> ApiResult {
    let metadata: DomainMetadata = {
        let (_, hub) = owner(&domain, &headers)?;
        hub
            .storage
            .load()
            .map_err(|error| backup::error(StatusCode::INTERNAL_SERVER_ERROR, error))?
            .expect("opened domain has a checkpoint")
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
