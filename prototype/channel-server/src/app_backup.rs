use super::{request_origin, App, HostCommand};
use crate::backup::{self, ApiResult};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use piik_channel_core::backup::OwnCredential;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

struct Owner {
    commands: mpsc::Sender<HostCommand>,
    credential: OwnCredential,
    ready: watch::Receiver<Option<Result<(), String>>>,
    stopped: watch::Receiver<bool>,
    revoked: watch::Receiver<bool>,
}

impl Owner {
    fn require_ready(&self) -> Result<(), backup::ApiError> {
        if matches!(*self.ready.borrow(), Some(Ok(()))) {
            Ok(())
        } else {
            Err(backup::error(StatusCode::FORBIDDEN, "forbidden"))
        }
    }
}

async fn owner(
    app: &App,
    headers: &HeaderMap,
    domain: Uuid,
    user: Uuid,
) -> Result<Owner, backup::ApiError> {
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
    let permission = registry.permission(&site).ok_or_else(forbidden)?;
    if *permission.revoked.borrow() || *app.closing.borrow() {
        return Err(forbidden());
    }
    let host = registry
        .hosts
        .get(&(site, domain, user))
        .filter(|host| {
            host.credential == credential && !host.finished() && !*host.stop.borrow()
        })
        .ok_or_else(forbidden)?;
    Ok(Owner {
        commands: host.commands.clone(),
        credential: OwnCredential {
            user_id: user,
            credential: credential.into(),
        },
        ready: host.ready.clone(),
        stopped: host.stop.subscribe(),
        revoked: permission.revoked.subscribe(),
    })
}

pub(super) async fn export(
    State(app): State<Arc<App>>,
    Path((domain, user, room)): Path<(Uuid, Uuid, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let owner = owner(&app, &headers, domain, user).await?;
    owner.require_ready()?;
    backup::export(owner.commands, room, None, owner.credential).await
}

pub(super) async fn describe(
    State(app): State<Arc<App>>,
    Path((domain, user)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> ApiResult {
    let Owner {
        commands,
        mut ready,
        mut stopped,
        mut revoked,
        ..
    } = owner(&app, &headers, domain, user).await?;
    let mut closing = app.closing.subscribe();
    let current = async {
        loop {
            let status = ready.borrow_and_update().clone();
            match status {
                Some(Ok(())) => {
                    let result = backup::describe(commands.clone()).await;
                    // A read consumed across admission retirement is not current.
                    if ready.has_changed().map_err(|_| {
                        backup::error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable")
                    })? {
                        continue;
                    }
                    if !matches!(&result, Err((_, body)) if body.0["error"] == "hosting_unavailable")
                    {
                        return result;
                    }
                }
                Some(Err(error)) => {
                    return Err(backup::error(StatusCode::SERVICE_UNAVAILABLE, error))
                }
                None => {}
            }
            // Wait for the existing owner's next admission, never poll the actor.
            ready.changed().await.map_err(|_| {
                backup::error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable")
            })?;
        }
    };
    tokio::select! {
        biased;
        _ = revoked.wait_for(|value| *value) => Err(backup::error(StatusCode::FORBIDDEN, "forbidden")),
        _ = stopped.wait_for(|value| *value) => Err(backup::error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable")),
        _ = closing.wait_for(|value| *value) => Err(backup::error(StatusCode::SERVICE_UNAVAILABLE, "hosting_unavailable")),
        result = current => result,
    }
}

#[cfg(test)]
#[path = "app_backup_description_tests.rs"]
mod tests;

pub(super) async fn restore(
    State(app): State<Arc<App>>,
    Path((domain, user)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult {
    let owner = owner(&app, &headers, domain, user).await?;
    owner.require_ready()?;
    backup::restore(owner.commands, None, None, &headers, body).await
}
