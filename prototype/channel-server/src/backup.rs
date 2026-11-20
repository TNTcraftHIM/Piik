//! HTTP bytes bridge to the existing Native room owner. No file holder or
//! second authority is created: the Browser retains imported participant files.
use anyhow::{bail, Result};
use axum::{
    body::Body,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{stream, StreamExt, TryStreamExt};
use piik_channel_core::backup::OwnCredential;
use piik_channel_native::{
    backup::{self, RoomSnapshot, StagedBackup},
    session::{ExistingRoomRestore, HostCommand, RestoreRoom, SnapshotRoom},
};
use serde_json::json;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::io::{ReaderStream, StreamReader, SyncIoBridge};

pub(crate) type ApiError = (StatusCode, Json<serde_json::Value>);
pub(crate) type ApiResult = std::result::Result<Response, ApiError>;

pub(crate) fn error(
    status: StatusCode,
    error: impl std::fmt::Display,
) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(json!({"error":error.to_string()})))
}

pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

pub(crate) async fn export(
    commands: mpsc::Sender<HostCommand>,
    room_id: String,
    creator: Option<uuid::Uuid>,
    credential: OwnCredential,
) -> ApiResult {
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::Snapshot(SnapshotRoom {
            room_id,
            creator,
            own_credential: Some(credential),
            result,
        }))
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?;
    let snapshot = response
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?
        .map_err(|code| error(StatusCode::CONFLICT, code))?;
    Ok(archive("room.piik.zip", move |writer| {
        // Receiver cancellation closes the bounded pipe, ending this writer.
        let result = backup::write_room(&snapshot.room, &[], writer, |_| -> Result<File> {
            bail!("file_source_unavailable")
        });
        drop(snapshot);
        result
    }))
}

pub(crate) fn archive(
    filename: &'static str,
    write: impl FnOnce(SyncIoBridge<tokio::io::DuplexStream>) -> Result<()> + Send + 'static,
) -> Response {
    let (writer, reader) = tokio::io::duplex(64 * 1024);
    let writer = SyncIoBridge::new(writer);
    let task = tokio::task::spawn_blocking(move || write(writer));
    let bytes = stream::try_unfold(
        (ReaderStream::new(reader), task),
        |(mut reader, task)| async move {
            if let Some(bytes) = reader.next().await {
                return Ok::<_, anyhow::Error>(Some((bytes?, (reader, task))));
            }
            task.await??;
            Ok(None)
        },
    );
    (
        [
            (header::CONTENT_TYPE, "application/zip".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        Body::from_stream(bytes),
    )
        .into_response()
}

pub(crate) async fn describe(commands: mpsc::Sender<HostCommand>) -> ApiResult {
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::Describe(result))
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?;
    let description = response
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?
        .map_err(|code| error(StatusCode::CONFLICT, code))?;
    Ok(Json(description).into_response())
}

pub(crate) async fn restore(
    commands: mpsc::Sender<HostCommand>,
    existing: Option<ExistingRoomRestore>,
    headers: &HeaderMap,
    body: Body,
) -> ApiResult {
    let (staged, directory, existing) = stage_upload(headers, body, existing).await?;
    let StagedBackup::Room { snapshot: room, .. } = staged else {
        return Err(error(StatusCode::BAD_REQUEST, "expected_room_backup"));
    };
    let staged = RoomSnapshot { room, directory };
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::Restore(RestoreRoom {
            existing,
            snapshot: staged,
            result,
        }))
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?;
    let room = response
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "room_restore_unconfirmed"))?
        .map_err(|code| error(StatusCode::CONFLICT, code))?;
    Ok(Json(json!({"room":room})).into_response())
}

pub(crate) async fn stage(
    headers: &HeaderMap,
    body: Body,
) -> std::result::Result<(StagedBackup, tempfile::TempDir), ApiError> {
    let (staged, directory, _) = stage_upload(headers, body, None).await?;
    Ok((staged, directory))
}

type Upload = (StagedBackup, tempfile::TempDir, Option<ExistingRoomRestore>);

async fn stage_upload(
    headers: &HeaderMap,
    body: Body,
    existing: Option<ExistingRoomRestore>,
) -> std::result::Result<Upload, ApiError> {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/zip")
    {
        return Err(error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "expected_backup"));
    }
    let reader = StreamReader::new(body.into_data_stream().map_err(io::Error::other));
    let mut reader = SyncIoBridge::new(reader);
    tokio::task::spawn_blocking(move || -> Result<Upload> {
        let directory = tempfile::Builder::new().prefix("piik-restore-").tempdir()?;
        // The uploaded ZIP is needed only while building its SQLite snapshot.
        let mut archive = tempfile::tempfile_in(directory.path())?;
        if existing.is_some() {
            const SCRATCH_HEADROOM_FACTOR: u64 = 8;
            let budget = fs4::available_space(directory.path())? / SCRATCH_HEADROOM_FACTOR;
            copy_bounded(&mut reader, &mut archive, budget)?;
        } else {
            io::copy(&mut reader, &mut archive)?;
        }
        archive.seek(SeekFrom::Start(0))?;
        let staged = if existing.is_some() {
            backup::stage_hosted_room(archive, directory.path())?
        } else {
            backup::stage(archive, directory.path())?
        };
        Ok((staged, directory, existing))
    })
    .await
    .map_err(|error| self::error(StatusCode::INTERNAL_SERVER_ERROR, error))?
    .map_err(
        |cause| match cause.downcast_ref::<io::Error>().map(io::Error::kind) {
            Some(io::ErrorKind::StorageFull) => {
                error(StatusCode::INSUFFICIENT_STORAGE, "restore_scratch_limit")
            }
            Some(io::ErrorKind::FileTooLarge) => {
                error(StatusCode::PAYLOAD_TOO_LARGE, "restore_scratch_limit")
            }
            _ => error(StatusCode::BAD_REQUEST, cause),
        },
    )
}

fn copy_bounded(input: &mut impl Read, output: &mut impl io::Write, budget: u64) -> io::Result<()> {
    io::copy(&mut input.take(budget), output)?;
    if input.read(&mut [0])? != 0 {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "restore_scratch_limit",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod upload_tests {
    use super::*;

    #[tokio::test]
    async fn disconnected_request_keeps_its_slot_until_staging_exits() {
        let slot = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let (commands, _receive) = mpsc::channel(1);
        let (started, reading) = oneshot::channel();
        let (finish, finished) = oneshot::channel();
        let body = Body::from_stream(stream::once(async move {
            started.send(()).unwrap();
            finished.await.unwrap();
            Ok::<_, io::Error>(axum::body::Bytes::new())
        }));
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
        let target = ExistingRoomRestore {
            room_id: "room".into(),
            creator: uuid::Uuid::new_v4(),
            scratch: slot.clone().try_acquire_owned().unwrap(),
        };
        let request =
            tokio::spawn(async move { restore(commands, Some(target), &headers, body).await });
        reading.await.unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert!(slot.clone().try_acquire_owned().is_err());
        finish.send(()).unwrap();
        let _released = slot.acquire().await.unwrap();
    }

    #[test]
    fn scratch_budget_counts_actual_bytes_and_accepts_an_exact_fit() {
        for size in [0, 3, 4, 5] {
            let data = vec![0; size];
            let mut written = Vec::new();
            let result = copy_bounded(&mut data.as_slice(), &mut written, 4);
            assert_eq!(result.is_ok(), size <= 4);
            assert_eq!(written.len(), size.min(4));
        }
    }
}
