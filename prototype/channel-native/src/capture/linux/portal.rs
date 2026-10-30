use anyhow::{ensure, Context as _, Result};
use ashpd::{
    desktop::Response,
    zbus::{
        zvariant::{OwnedObjectPath, Type, Value},
        Proxy,
    },
};
use futures_util::StreamExt;
use serde::{de::DeserializeOwned, Serialize};
use std::{collections::HashMap, future::Future};

// ashpd returns its Request only after Response, so dropping start() cannot
// cancel the dialog. Keep this one request handle until Response or Close.
pub(super) async fn start<T: DeserializeOwned + Type>(
    portal: &Proxy<'_>,
    session: &(impl Serialize + Type),
    cancelled: &mut (impl Future<Output = Result<()>> + Unpin),
) -> Result<Option<T>> {
    let connection = portal.connection();
    let sender = connection
        .unique_name()
        .context("Portal connection has no unique name")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let token = format!("piik_{}", uuid::Uuid::new_v4().simple());
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let request = Proxy::new(
        connection,
        portal.destination(),
        path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .await?;
    let mut responses = request.receive_signal("Response").await?;
    let options = HashMap::from([("handle_token", Value::from(token.as_str()))]);
    // Complete the method ACK before cancelling: the Request must exist first.
    let handle: OwnedObjectPath = portal.call("Start", &(session, "", options)).await?;
    ensure!(handle.as_str() == path, "unexpected Portal request handle");
    tokio::select! {
        biased;
        response = responses.next() => {
            match response.context("Portal response stream closed")?.body().deserialize::<Response<T>>()? {
                Response::Ok(value) => Ok(Some(value)),
                Response::Err(error) => Err(ashpd::Error::Response(error).into()),
            }
        }
        result = cancelled => {
            request.call::<_, _, ()>("Close", &()).await?;
            result.map(|_| None)
        }
    }
}
