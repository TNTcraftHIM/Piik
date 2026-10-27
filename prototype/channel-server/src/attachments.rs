//! Bounded, room-authorized HTTP attachment transfer. These bytes never use the
//! signaling socket or media route; stored content outlives its uploader.
use crate::{
    now,
    storage::{media_type, Attachment},
    AppState,
};
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::stream;
use piik_channel_prototype::RoomPermission;
use serde::{Deserialize, Serialize};
use std::{io, sync::Arc};
use uuid::Uuid;

type Failure = (StatusCode, Json<ErrorBody>);
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    code: &'static str,
}
fn fail(status: StatusCode, code: &'static str) -> Failure {
    (status, Json(ErrorBody { code }))
}
fn storage_error(_: impl std::fmt::Display) -> Failure {
    fail(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed")
}

fn credential(headers: &HeaderMap) -> Result<String, Failure> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "authentication_required"))
}

fn origin(state: &AppState, headers: &HeaderMap) -> Result<(), Failure> {
    if headers
        .get(header::ORIGIN)
        .is_some_and(|value| value.to_str().ok() != Some(state.origin.as_str()))
    {
        return Err(fail(StatusCode::FORBIDDEN, "origin_not_allowed"));
    }
    Ok(())
}

fn authorize(
    state: &AppState,
    token: &str,
    room: &str,
    permission: RoomPermission,
) -> Result<Uuid, Failure> {
    state
        .hub
        .lock()
        .unwrap()
        .authority
        .authorize_user(token, room, permission)
        .map_err(|_| fail(StatusCode::FORBIDDEN, "forbidden"))
}

pub async fn limits(State(state): State<AppState>) -> Json<serde_json::Value> {
    let store = state.storage.lock().unwrap();
    Json(
        serde_json::json!({ "maxFileBytes": store.limits.max_file_bytes,
        "totalBytes": store.limits.total_bytes, "maxStoredFiles": store.limits.max_stored_files,
        "maxAttachmentsPerMessage": piik_channel_prototype::MAX_MESSAGE_ATTACHMENTS }),
    )
}

pub async fn upload(
    State(state): State<AppState>,
    Path(room): Path<String>,
    request: Request,
) -> Result<Json<Attachment>, Failure> {
    origin(&state, request.headers())?;
    let token = credential(request.headers())?;
    authorize(&state, &token, &room, RoomPermission::Write)?;
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(decode_name)
        .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "invalid_file_name"))?;
    let _permit = state
        .transfers
        .clone()
        .try_acquire_owned()
        .map_err(|_| fail(StatusCode::TOO_MANY_REQUESTS, "transfer_busy"))?;
    let limit = state.storage.lock().unwrap().limits.max_file_bytes;
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|size| size > limit as u64)
    {
        return Err(fail(StatusCode::PAYLOAD_TOO_LARGE, "file_too_large"));
    }
    let bytes = to_bytes(request.into_body(), limit)
        .await
        .map_err(|_| fail(StatusCode::PAYLOAD_TOO_LARGE, "file_too_large"))?;
    let hub = state.hub.lock().unwrap();
    let user_id = hub
        .authority
        .authorize_user(&token, &room, RoomPermission::Write)
        .map_err(|_| fail(StatusCode::FORBIDDEN, "forbidden"))?;
    let attachment = Attachment {
        id: Uuid::new_v4(),
        room_id: room,
        user_id,
        name,
        size: bytes.len() as u64,
        media_type: media_type(&bytes).into(),
        created_at: now(),
    };
    state
        .storage
        .lock()
        .unwrap()
        .put(&attachment, &bytes, now())
        .map_err(|error| {
            if error.to_string() == "attachment_store_full" {
                fail(StatusCode::INSUFFICIENT_STORAGE, "attachment_store_full")
            } else {
                storage_error(error)
            }
        })?;
    Ok(Json(attachment))
}

pub async fn metadata(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Attachment>, Failure> {
    origin(&state, &headers)?;
    let token = credential(&headers)?;
    let attachment = state
        .storage
        .lock()
        .unwrap()
        .metadata(id)
        .map_err(storage_error)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "attachment_unavailable"))?;
    let user = authorize(&state, &token, &attachment.room_id, RoomPermission::Read)?;
    if !state
        .storage
        .lock()
        .unwrap()
        .readable(id, user)
        .map_err(storage_error)?
    {
        return Err(fail(StatusCode::FORBIDDEN, "forbidden"));
    }
    Ok(Json(attachment))
}

pub async fn download(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, Failure> {
    origin(&state, &headers)?;
    let token = credential(&headers)?;
    let attachment = state
        .storage
        .lock()
        .unwrap()
        .metadata(id)
        .map_err(storage_error)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "attachment_unavailable"))?;
    let user = authorize(&state, &token, &attachment.room_id, RoomPermission::Read)?;
    if !state
        .storage
        .lock()
        .unwrap()
        .readable(id, user)
        .map_err(storage_error)?
    {
        return Err(fail(StatusCode::FORBIDDEN, "forbidden"));
    }
    let permit = state
        .transfers
        .clone()
        .try_acquire_owned()
        .map_err(|_| fail(StatusCode::TOO_MANY_REQUESTS, "transfer_busy"))?;
    let bytes = state
        .storage
        .lock()
        .unwrap()
        .content(id)
        .map_err(storage_error)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "attachment_unavailable"))?;
    let room = attachment.room_id.clone();
    let chunks = stream::unfold(
        (Arc::new(bytes), 0usize, state, token, room, permit),
        move |(bytes, offset, state, token, room, permit)| async move {
            if offset >= bytes.len() {
                return None;
            }
            let available = state
                .storage
                .lock()
                .unwrap()
                .readable(id, user)
                .unwrap_or(false);
            if !available || authorize(&state, &token, &room, RoomPermission::Read).is_err() {
                return Some((
                    Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "access_revoked",
                    )),
                    (bytes.clone(), bytes.len(), state, token, room, permit),
                ));
            }
            let end = (offset + 32 * 1024).min(bytes.len());
            let chunk = Bytes::copy_from_slice(&bytes[offset..end]);
            Some((Ok(chunk), (bytes, end, state, token, room, permit)))
        },
    );
    let mut response = Body::from_stream(chunks).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&attachment.media_type).map_err(storage_error)?,
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(attachment.size));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"download\"; filename*=UTF-8''{}",
            encode_name(&attachment.name)
        ))
        .map_err(storage_error)?,
    );
    Ok(response)
}

#[derive(Default, Deserialize)]
pub struct DeleteOptions {
    #[serde(default)]
    draft: bool,
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(options): Query<DeleteOptions>,
    headers: HeaderMap,
) -> Result<StatusCode, Failure> {
    origin(&state, &headers)?;
    let token = credential(&headers)?;
    let hub = state.hub.lock().unwrap();
    let mut store = state.storage.lock().unwrap();
    let attachment = store
        .metadata(id)
        .map_err(storage_error)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "attachment_unavailable"))?;
    let manager = hub
        .authority
        .authorize_user(&token, &attachment.room_id, RoomPermission::Manage)
        .ok();
    let user_id = hub
        .authority
        .authorize_user(&token, &attachment.room_id, RoomPermission::Write)
        .ok()
        .or(manager)
        .ok_or_else(|| fail(StatusCode::FORBIDDEN, "forbidden"))?;
    if attachment.user_id != user_id && manager.is_none() {
        return Err(fail(StatusCode::FORBIDDEN, "forbidden"));
    }
    if options.draft {
        if !store.discard_draft(id).map_err(storage_error)? {
            return Err(fail(StatusCode::CONFLICT, "attachment_already_sent"));
        }
    } else {
        store.delete(id).map_err(storage_error)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

fn decode_name(value: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut input = value.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = char::from(input.next()?).to_digit(16)?;
            let low = char::from(input.next()?).to_digit(16)?;
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(byte);
        }
    }
    let name = String::from_utf8(bytes).ok()?;
    if name.trim().is_empty() || name.chars().count() > 240 || name.chars().any(char::is_control) {
        None
    } else {
        Some(name)
    }
}

fn encode_name(value: &str) -> String {
    let mut output = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"._-".contains(byte) {
            output.push(char::from(*byte));
        } else {
            use std::fmt::Write;
            write!(output, "%{byte:02X}").unwrap();
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        storage::{Limits, Storage},
        Hub,
    };
    use futures_util::StreamExt;
    use piik_channel_prototype::{
        wire::{Event, Request},
        Authority,
    };
    use serde_json::json;
    use std::{collections::BTreeMap, path::Path as FilePath, sync::Mutex};
    use tokio::sync::Semaphore;
    #[test]
    fn unicode_file_names_round_trip_without_becoming_header_control_bytes() {
        let name = "图片 \"test\".png";
        assert_eq!(decode_name(&encode_name(name)).unwrap(), name);
        assert!(decode_name("bad%0D%0Aheader").is_none());
        assert!(decode_name("bad%FF").is_none());
        assert!(decode_name("bad%xy").is_none());
    }

    #[tokio::test]
    async fn active_download_obeys_access_loss_or_deletion_and_releases_transfer_slot() {
        for revoke_access in [true, false] {
            let mut authority = Authority::new("owner".into(), "invite".into(), vec![]).unwrap();
            let owner = Uuid::new_v4();
            let member = Uuid::new_v4();
            authority.handle(
                owner,
                Request::parse(&json!({"type":"join","key":"owner","name":"Owner"}).to_string())
                    .unwrap(),
                0,
            );
            let welcome = authority.handle(
                member,
                Request::parse(&json!({"type":"join","key":"invite","name":"Member"}).to_string())
                    .unwrap(),
                0,
            );
            let token = welcome
                .events
                .into_iter()
                .find_map(|(_, event)| match event {
                    Event::Welcome { credential, .. } => Some(credential),
                    _ => None,
                })
                .unwrap();
            let user_id = authority
                .authorize_user(&token, "living", RoomPermission::Read)
                .unwrap();
            let file = Attachment {
                id: Uuid::new_v4(),
                room_id: "living".into(),
                user_id,
                name: "bytes.bin".into(),
                size: 70_000,
                media_type: "application/octet-stream".into(),
                created_at: 0,
            };
            let mut storage = Storage::open(FilePath::new(":memory:"), Limits::default()).unwrap();
            storage.put(&file, &vec![7; 70_000], 0).unwrap();
            let storage = Arc::new(Mutex::new(storage));
            let state = AppState {
                hub: Arc::new(Mutex::new(Hub {
                    authority,
                    clients: BTreeMap::new(),
                    storage: storage.clone(),
                })),
                sockets: Arc::new(Semaphore::new(40)),
                transfers: Arc::new(Semaphore::new(2)),
                storage,
                origin: "http://127.0.0.1:8790".into(),
            };
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
            );
            let response = download(State(state.clone()), Path(file.id), headers)
                .await
                .unwrap();
            let mut stream = response.into_body().into_data_stream();
            assert_eq!(stream.next().await.unwrap().unwrap().len(), 32 * 1024);
            assert_eq!(state.transfers.available_permits(), 1);
            if revoke_access {
                state.hub.lock().unwrap().authority.handle(
                    owner,
                    Request::parse(
                        &json!({"type":"update_room", "roomId":"living",
                    "name":"Private", "access":"private", "hidden":false})
                        .to_string(),
                    )
                    .unwrap(),
                    1,
                );
            } else {
                state.storage.lock().unwrap().delete(file.id).unwrap();
            }
            assert!(stream.next().await.unwrap().is_err());
            drop(stream);
            assert_eq!(state.transfers.available_permits(), 2);
        }
    }
}
