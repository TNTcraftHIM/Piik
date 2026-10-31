//! One process-owned Portal binding. Source consent owns pending dialogs.
use super::Executor;
use anyhow::{anyhow, ensure, Context as _, Result};
use ashpd::{
    desktop::{
        global_shortcuts::{BindShortcuts, GlobalShortcuts, NewShortcut},
        Response, Session,
    },
    zbus::{
        self,
        zvariant::{OwnedObjectPath, Value},
        Proxy,
    },
};
use futures_util::{
    future::{AbortHandle, AbortRegistration, Abortable, BoxFuture},
    stream::FuturesUnordered,
    StreamExt,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    thread,
};
use tokio::sync::{mpsc, oneshot};

const ACTION: &str = "stop-remote-control";

#[derive(Clone, Default)]
pub(super) struct View {
    pub available: bool,
    pub key: Option<u8>,
    pub label: Option<String>,
}

pub(super) struct Shortcut {
    view: Arc<Mutex<View>>,
    commands: mpsc::Sender<Bind>,
    worker: Mutex<Option<(oneshot::Sender<()>, thread::JoinHandle<()>)>>,
}
struct Bind {
    key: u8,
    cancel: AbortHandle,
    registration: AbortRegistration,
    reply: oneshot::Sender<Result<()>>,
}
struct Bound {
    session: Session<GlobalShortcuts>,
    path: OwnedObjectPath,
    key: u8,
    label: String,
}

impl Shortcut {
    pub fn new(owner: Weak<Mutex<Executor>>) -> Self {
        let view = Arc::new(Mutex::new(View::default()));
        let (commands, receiver) = mpsc::channel(1);
        let (stop, stopped) = oneshot::channel();
        let state = view.clone();
        let worker = tokio::runtime::Handle::try_current()
            .ok()
            .and_then(|runtime| {
                thread::Builder::new()
                    .name("piik-input-stop".into())
                    .spawn(move || {
                        if let Err(error) = runtime.block_on(run(receiver, stopped, &state, &owner))
                        {
                            let bound = state.lock().unwrap().key.is_some();
                            publish(&state, &owner, View::default(), bound);
                            eprintln!("Linux stop shortcut: {error:#}");
                        }
                    })
                    .ok()
            });
        Self {
            view,
            commands,
            worker: Mutex::new(worker.map(|worker| (stop, worker))),
        }
    }

    pub fn view(&self) -> View {
        self.view.lock().unwrap().clone()
    }

    pub fn bind(
        &self,
        key: u8,
        cancel: AbortHandle,
        registration: AbortRegistration,
    ) -> Result<oneshot::Receiver<Result<()>>> {
        ensure!(self.view().available, "input_shortcut_unavailable");
        let (reply, completed) = oneshot::channel();
        self.commands
            .try_send(Bind {
                key,
                cancel,
                registration,
                reply,
            })
            .map_err(|_| anyhow!("input_shortcut_busy"))?;
        Ok(completed)
    }

    pub fn close(&self) {
        if let Some((stop, worker)) = self.worker.lock().unwrap().take() {
            let _ = stop.send(());
            let _ = worker.join();
        }
    }
}
impl Drop for Shortcut {
    fn drop(&mut self) {
        self.close();
    }
}

fn publish(state: &Mutex<View>, owner: &Weak<Mutex<Executor>>, view: View, revoke: bool) {
    *state.lock().unwrap() = view.clone();
    if let Some(owner) = owner.upgrade() {
        let mut owner = owner.lock().unwrap();
        if revoke {
            owner.revoke();
        }
        for source in owner.sources.values() {
            source.view.send_modify(|source| {
                source.can_set_stop_shortcut = view.available;
                source.stop_shortcut = view.key;
                source.stop_shortcut_label = Some(view.label.clone());
            });
        }
    }
}

async fn run(
    mut commands: mpsc::Receiver<Bind>,
    mut stopped: oneshot::Receiver<()>,
    state: &Mutex<View>,
    owner: &Weak<Mutex<Executor>>,
) -> Result<()> {
    // A dedicated connection also releases every session if initialization or
    // teardown fails; it is never shared with the capture Portal connection.
    let connection = zbus::Connection::session().await?;
    if !ashpd::is_sandboxed() {
        // Match the desktop entry already shipped by the Linux App package.
        // The Registry accepts existing desktop basenames, including legacy IDs.
        let registry = Proxy::new(
            &connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.host.portal.Registry",
        )
        .await?;
        registry
            .call::<_, _, ()>("Register", &("piik-app", HashMap::<&str, Value<'_>>::new()))
            .await?;
    }
    let portal = Arc::new(GlobalShortcuts::with_connection(connection.clone()).await?);
    ensure!(
        portal.get_property::<u32>("version").await? > 0,
        "input_shortcut_unavailable"
    );
    let mut activated = portal.receive_activated().await?;
    let mut changed = portal.receive_shortcuts_changed().await?;
    let mut bound: Option<Bound> = None;
    let mut closed: Option<zbus::proxy::SignalStream<'static>> = None;
    let mut pending: FuturesUnordered<
        BoxFuture<'static, (AbortHandle, oneshot::Sender<Result<()>>, Result<Bound>)>,
    > = FuturesUnordered::new();
    let mut pending_cancel: Option<AbortHandle> = None;
    publish(
        state,
        owner,
        View {
            available: true,
            ..View::default()
        },
        false,
    );
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            command = commands.recv() => {
                let Some(command) = command else { break };
                if !pending.is_empty() {
                    let _ = command.reply.send(Err(anyhow!("input_shortcut_busy")));
                    continue;
                }
                if bound.as_ref().is_some_and(|bound| bound.key == command.key) {
                    let _ = command.reply.send(Ok(()));
                    continue;
                }
                pending_cancel = Some(command.cancel.clone());
                let portal = portal.clone();
                pending.push(Box::pin(async move {
                    let result = register(&portal, command.key, &command.cancel, command.registration).await;
                    (command.cancel, command.reply, result)
                }));
            }
            Some((cancel, reply, result)) = pending.next(), if !pending.is_empty() => {
                pending_cancel = None;
                let result = match result {
                    Ok(next) if !cancel.is_aborted() => {
                        let session = Proxy::new_owned(connection.clone(), "org.freedesktop.portal.Desktop", next.path.clone(), "org.freedesktop.portal.Session").await?;
                        closed = Some(session.receive_signal("Closed").await?);
                        if let Some(old) = bound.replace(next) { old.session.close().await?; }
                        let current = bound.as_ref().unwrap();
                        publish(state, owner, View { available: true, key: Some(current.key), label: Some(current.label.clone()) }, false);
                        Ok(())
                    }
                    Ok(next) => {
                        next.session.close().await?;
                        Err(anyhow!("input_authorization_cancelled"))
                    }
                    Err(error) => Err(error),
                };
                let _ = reply.send(result);
            }
            event = activated.next() => {
                let event = event.context("shortcut activation stream closed")?;
                if bound.as_ref().is_some_and(|b| b.path.as_ref() == event.session_handle()) && event.shortcut_id() == ACTION {
                    if let Some(owner) = owner.upgrade() { owner.lock().unwrap().revoke(); }
                }
            }
            event = changed.next() => {
                let event = event.context("shortcut change stream closed")?;
                if let Some(current) = bound.as_mut().filter(|b| b.path.as_ref() == event.session_handle()) {
                    if let Some(shortcut) = event.shortcuts().iter().find(|s| s.id() == ACTION && !s.trigger_description().is_empty()) {
                        current.label = shortcut.trigger_description().into();
                        publish(state, owner, View { available: true, key: Some(current.key), label: Some(current.label.clone()) }, false);
                    } else {
                        bound.take().unwrap().session.close().await?;
                        closed = None;
                        publish(state, owner, View { available: true, ..View::default() }, true);
                    }
                }
            }
            _ = async { closed.as_mut().unwrap().next().await }, if closed.is_some() => {
                bound = None;
                closed = None;
                publish(state, owner, View { available: true, ..View::default() }, true);
            }
        }
    }
    if let Some(cancel) = pending_cancel {
        cancel.abort();
    }
    while pending.next().await.is_some() {}
    if let Some(current) = bound {
        current.session.close().await?;
    }
    connection.close().await?;
    publish(state, owner, View::default(), false);
    Ok(())
}

async fn register(
    portal: &GlobalShortcuts,
    key: u8,
    cancel: &AbortHandle,
    registration: AbortRegistration,
) -> Result<Bound> {
    ensure!(!cancel.is_aborted(), "input_authorization_cancelled");
    let session = portal.create_session(Default::default()).await?;
    // Session exposes its standard object path through Serialize.
    let path = serde_json::from_value(serde_json::to_value(&session)?)?;
    let result = bind(portal, &session, key, registration).await;
    match result {
        Ok(label) if !cancel.is_aborted() => Ok(Bound {
            session,
            path,
            key,
            label,
        }),
        result => {
            session.close().await?;
            result?;
            Err(anyhow!("input_authorization_cancelled"))
        }
    }
}

async fn bind(
    portal: &GlobalShortcuts,
    session: &Session<GlobalShortcuts>,
    key: u8,
    registration: AbortRegistration,
) -> Result<String> {
    // ashpd waits for Response before exposing Request. Retain its standard
    // handle here so source retirement can explicitly close an open dialog.
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
    let trigger = format!("CTRL+ALT+F{key}");
    let shortcuts =
        [NewShortcut::new(ACTION, "Stop remote control").preferred_trigger(trigger.as_str())];
    let options = HashMap::from([("handle_token", Value::from(token.as_str()))]);
    let handle: OwnedObjectPath = portal
        .call(
            "BindShortcuts",
            &(session, shortcuts.as_slice(), "", options),
        )
        .await?;
    ensure!(handle.as_str() == path, "unexpected Portal request handle");
    tokio::select! {
        biased;
        response = responses.next() => {
            match response.context("Portal response stream closed")?.body().deserialize::<Response<BindShortcuts>>()? {
                Response::Ok(value) => {
                    let shortcut = value.shortcuts().iter().find(|s| s.id() == ACTION && !s.trigger_description().is_empty()).context("input_shortcut_unavailable")?;
                    Ok(shortcut.trigger_description().into())
                }
                Response::Err(error) => Err(ashpd::Error::Response(error).into()),
            }
        }
        _ = Abortable::new(std::future::pending::<()>(), registration) => {
            request.call::<_, _, ()>("Close", &()).await?;
            Err(anyhow!("input_authorization_cancelled"))
        }
    }
}
