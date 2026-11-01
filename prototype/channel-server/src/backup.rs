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
    session::{HostCommand, RestoreRoom, SnapshotRoom},
};
use serde_json::json;
use std::{
    fs::File,
    io::{self, Seek, SeekFrom},
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::io::{ReaderStream, StreamReader, SyncIoBridge};

pub(crate) type ApiResult = std::result::Result<Response, (StatusCode, Json<serde_json::Value>)>;

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
    credential: OwnCredential,
) -> ApiResult {
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::Snapshot(SnapshotRoom {
            room_id,
            own_credential: Some(credential),
            result,
        }))
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?;
    let snapshot = response
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?
        .map_err(|code| error(StatusCode::CONFLICT, code))?;
    let (writer, reader) = tokio::io::duplex(64 * 1024);
    let writer = SyncIoBridge::new(writer);
    let task = tokio::task::spawn_blocking(move || {
        // Receiver cancellation closes the bounded pipe, ending this writer.
        let result = backup::write_room(&snapshot.room, &[], writer, |_| -> Result<File> {
            bail!("file_source_unavailable")
        });
        drop(snapshot);
        result
    });
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
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"room.piik.zip\"",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(bytes),
    )
        .into_response())
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
    headers: &HeaderMap,
    body: Body,
) -> ApiResult {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/zip")
    {
        return Err(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected_room_backup",
        ));
    }
    let reader = StreamReader::new(body.into_data_stream().map_err(io::Error::other));
    let mut reader = SyncIoBridge::new(reader);
    let staged = tokio::task::spawn_blocking(move || -> Result<RoomSnapshot> {
        let directory = tempfile::Builder::new().prefix("piik-restore-").tempdir()?;
        let mut archive = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.path().join("upload.zip"))?;
        io::copy(&mut reader, &mut archive)?;
        archive.seek(SeekFrom::Start(0))?;
        let StagedBackup::Room { snapshot: room, .. } = backup::stage(archive, directory.path())?
        else {
            bail!("expected_room_backup");
        };
        Ok(RoomSnapshot { room, directory })
    })
    .await
    .map_err(|error| self::error(StatusCode::INTERNAL_SERVER_ERROR, error))?
    .map_err(|error| self::error(StatusCode::BAD_REQUEST, error))?;
    let (result, response) = oneshot::channel();
    commands
        .send(HostCommand::Restore(RestoreRoom {
            snapshot: staged,
            result,
        }))
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?;
    let room = response
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable"))?
        .map_err(|code| error(StatusCode::CONFLICT, code))?;
    Ok(Json(json!({"room":room})).into_response())
}
