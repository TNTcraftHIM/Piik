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
