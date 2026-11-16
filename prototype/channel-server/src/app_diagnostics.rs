//! Process diagnostics belong to the local launcher, not approved remote sites.
use super::{operation_failure, ApiResult, BUILD_REVISION, BUILD_VERSION, PACKAGE_TARGET};
use axum::{http::StatusCode, Json};
use piik_channel_native::diagnostics;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Empty {}

pub(super) async fn enable(Json(_): Json<Empty>) -> ApiResult {
    diagnostics::enable().map_err(operation_failure)?;
    Ok(Json(json!({"debug":true})))
}

pub(super) async fn export(Json(_): Json<Empty>) -> crate::backup::ApiResult {
    let snapshot = diagnostics::snapshot()
        .ok_or_else(|| crate::backup::error(StatusCode::CONFLICT, "diagnostics_disabled"))?;
    // The snapshot releases the recorder lock before ZIP serialization begins.
    Ok(crate::backup::archive(
        "piik-app-diagnostics.zip",
        move |writer| snapshot.write_archive(writer, BUILD_VERSION, BUILD_REVISION, PACKAGE_TARGET),
    ))
}

/// The terminal borrows the same opt-in recorder and ZIP writer as the local launcher.
pub(super) async fn export_to_directory(directory: std::path::PathBuf) -> anyhow::Result<std::path::PathBuf> {
    let snapshot = diagnostics::snapshot().ok_or_else(|| anyhow::anyhow!("diagnostics_disabled"))?;
    tokio::task::spawn_blocking(move || write_snapshot(snapshot, directory)).await?
}

fn write_snapshot(snapshot: diagnostics::Snapshot, directory: std::path::PathBuf) -> anyhow::Result<std::path::PathBuf> {
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!("piik-app-diagnostics-{}.zip", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    if let Err(error) = snapshot.write_archive(&mut file, BUILD_VERSION, BUILD_REVISION, PACKAGE_TARGET) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(path)
}

#[cfg(test)]
mod terminal_tests {
    use super::*;
    #[tokio::test]
    async fn terminal_export_uses_the_native_snapshot_zip_and_new_destination() -> anyhow::Result<()> {
        diagnostics::enable()?;
        let directory = tempfile::tempdir()?;
        let destination = directory.path().join("diagnostics");
        let first = export_to_directory(destination.clone()).await?;
        let second = export_to_directory(destination.clone()).await?;
        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(destination.as_path()));
        let mut archive = zip::ZipArchive::new(std::fs::File::open(first)?)?;
        let metadata: serde_json::Value = serde_json::from_reader(archive.by_name("metadata.json")?)?;
        assert_eq!(metadata["version"], BUILD_VERSION);
        assert_eq!(metadata["revision"], BUILD_REVISION);
        assert!(archive.by_name("events.ndjson").is_ok());
        assert!(diagnostics::enabled());
        Ok(())
    }
}
