//! Executes Core watch delivery effects using admitted page resource readers.
use crate::data::{Lane, Message, MessageScope, Senders};
use piik_channel_core::{
    conversation::{encode_control, ControlFrame},
    watch_delivery::{
        WatchBytePlan, WatchControl, WatchDelivery, WatchEffect, WatchKey, WATCH_FRAME_BYTES,
    },
    wire::WatchByteSource,
};
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::Arc,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

pub use piik_channel_core::watch_delivery::WatchReadResult as ReadResult;
/// One source lease resolves opaque resources. Dropping a read future cancels it.
pub trait Reader: Send + Sync {
    fn read(
        &self,
        resource_id: Uuid,
        offset: u64,
        length: u32,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<ReadResult>> + Send + '_>>;
}

#[derive(Clone)]
struct Lease {
    plans: Vec<WatchBytePlan>,
    rooms: Vec<String>,
}
#[derive(Clone)]
pub(crate) struct WatchScope {
    lease: watch::Receiver<Lease>,
    key: WatchKey,
    // Terminal Cancel/Error keeps room authority after its activity plan retires.
    source: Option<WatchByteSource>,
}
impl WatchScope {
    pub fn allowed(&self) -> bool {
        let lease = self.lease.borrow();
        lease.rooms.contains(&self.key.room_id)
            && self.source.as_ref().is_none_or(|source| {
                lease.plans.iter().any(|p| {
                    p.room_id == self.key.room_id
                        && p.activity_id == self.key.activity_id
                        && &p.source == source
                })
            })
    }
    pub async fn changed(&mut self) -> bool {
        self.lease.changed().await.is_ok()
    }
}
struct Link {
    senders: Senders,
    lease: watch::Sender<Lease>,
}
impl Link {
    fn message(&self, key: WatchKey, bytes: Vec<u8>, terminal: bool) -> Option<Message> {
        let lease = self.lease.borrow();
        if !lease.rooms.contains(&key.room_id) {
            return None;
        }
        let source = if terminal {
            None
        } else {
            Some(
                lease
                    .plans
                    .iter()
                    .find(|p| p.room_id == key.room_id && p.activity_id == key.activity_id)?
                    .source
                    .clone(),
            )
        };
        Some(Message {
            bytes,
            scope: MessageScope::Watch(WatchScope {
                lease: self.lease.subscribe(),
                key,
                source,
            }),
            report_failure: !terminal,
        })
    }
}
enum Input {
    Update(
        Vec<WatchBytePlan>,
        Vec<(Uuid, Vec<String>)>,
        oneshot::Sender<()>,
    ),
    Register(Uuid, Arc<dyn Reader>, oneshot::Sender<anyhow::Result<()>>),
    Revoke(Uuid),
    Attach(Uuid, Senders),
    Detach(Uuid),
    Unavailable(Uuid),
    Control(Uuid, Uuid, WatchControl),
    Chunk(Uuid, Uuid, Vec<u8>),
    Closed(Uuid, Lane, Uuid),
    Read(Uuid, Result<ReadResult, String>),
}
#[derive(Clone)]
pub(crate) struct Receiver {
    input: mpsc::Sender<Input>,
}
impl Receiver {
    pub async fn control(&self, peer: Uuid, token: Uuid, control: WatchControl) {
        let _ = self.input.send(Input::Control(peer, token, control)).await;
    }
    pub async fn chunk(&self, peer: Uuid, token: Uuid, bytes: &[u8]) {
        if bytes.len() <= WATCH_FRAME_BYTES {
            let _ = self
                .input
                .send(Input::Chunk(peer, token, bytes.to_vec()))
                .await;
        }
    }
    pub async fn closed(&self, peer: Uuid, lane: Lane, token: Uuid) {
        let _ = self.input.send(Input::Closed(peer, lane, token)).await;
    }
}
pub(crate) struct Watches {
    input: mpsc::Sender<Input>,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Watches {
    pub fn new(session: Uuid) -> Self {
        let (input, mut messages) = mpsc::channel(128);
        let completed = input.clone();
        let (cancel, mut cancelled) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut core = WatchDelivery::new(session);
            let mut plans: Vec<WatchBytePlan> = vec![];
            let mut room_peers: Vec<(Uuid, Vec<String>)> = vec![];
            let mut links: BTreeMap<Uuid, Link> = BTreeMap::new();
            let mut readers: BTreeMap<Uuid, Arc<dyn Reader>> = BTreeMap::new();
            let mut reads: BTreeMap<Uuid, JoinHandle<()>> = BTreeMap::new();
            loop {
                let message = tokio::select! { _ = cancelled.changed() => break, message = messages.recv() => match message { Some(m) => m, None => break } };
                let effects = match message {
                    Input::Update(next, peers, done) => {
                        plans = next;
                        room_peers = peers;
                        for (peer, link) in &links {
                            link.lease
                                .send_replace(peer_lease(&plans, &room_peers, *peer));
                        }
                        let effects = core.update(plans.clone(), room_peers.clone());
                        let _ = done.send(());
                        effects
                    }
                    Input::Register(resource, reader, done) => {
                        let result = if readers.len() >= 32 || readers.contains_key(&resource) {
                            Err(anyhow::anyhow!("watch_source_busy"))
                        } else {
                            readers.insert(resource, reader);
                            Ok(())
                        };
                        let _ = done.send(result);
                        vec![]
                    }
                    Input::Revoke(resource) => {
                        readers.remove(&resource);
                        plans.retain(|p| {
                            p.source.session_id != session || p.source.resource_id != resource
                        });
                        for (peer, link) in &links {
                            link.lease
                                .send_replace(peer_lease(&plans, &room_peers, *peer));
                        }
                        core.update(plans.clone(), room_peers.clone())
                    }
                    Input::Attach(peer, senders) => {
                        let (lease, _) = watch::channel(peer_lease(&plans, &room_peers, peer));
                        links.insert(peer, Link { senders, lease });
                        vec![]
                    }
                    Input::Unavailable(peer) => core.peer_closed(peer),
                    Input::Detach(peer) => {
                        if let Some(link) = links.remove(&peer) {
                            link.lease.send_replace(Lease {
                                plans: vec![],
                                rooms: vec![],
                            });
                        }
                        core.peer_closed(peer)
                    }
                    Input::Closed(peer, lane, token) => {
                        if links
                            .get(&peer)
                            .is_some_and(|l| l.senders.current(lane, token, false))
                        {
                            core.peer_closed(peer)
                        } else {
                            vec![]
                        }
                    }
                    Input::Control(peer, token, control) => {
                        if links
                            .get(&peer)
                            .is_some_and(|l| l.senders.current(Lane::Control, token, true))
                        {
                            core.control(peer, control)
                        } else {
                            vec![]
                        }
                    }
                    Input::Chunk(peer, token, bytes) => {
                        if links
                            .get(&peer)
                            .is_some_and(|l| l.senders.current(Lane::Bulk, token, true))
                        {
                            core.chunk(peer, &bytes).unwrap_or_default()
                        } else {
                            vec![]
                        }
                    }
                    Input::Read(id, result) => {
                        reads.remove(&id);
                        core.read_result(id, result)
                    }
                };
                let mut effects: VecDeque<_> = effects.into();
                while let Some(effect) = effects.pop_front() {
                    match effect {
                        WatchEffect::Read {
                            key,
                            request_id,
                            offset,
                            length,
                        } => {
                            let source = plans
                                .iter()
                                .find(|p| {
                                    p.room_id == key.room_id
                                        && p.activity_id == key.activity_id
                                        && p.source.session_id == session
                                })
                                .map(|p| p.source.resource_id);
                            if let Some(reader) =
                                source.and_then(|root| readers.get(&root).cloned())
                            {
                                let completed = completed.clone();
                                let task = tokio::spawn(async move {
                                    let result = reader
                                        .read(key.resource_id, offset, length as u32)
                                        .await
                                        .map_err(|_| "watch_source_unavailable".to_string());
                                    let _ = completed.send(Input::Read(request_id, result)).await;
                                });
                                reads.insert(request_id, task);
                            } else {
                                effects.extend(core.read_result(
                                    request_id,
                                    Err("watch_source_unavailable".into()),
                                ));
                            }
                        }
                        WatchEffect::CancelRead { request_id } => {
                            if let Some(task) = reads.remove(&request_id) {
                                task.abort();
                            }
                        }
                        WatchEffect::SendControl { peer, control } => {
                            let key = control.key().clone();
                            let request_id = control.request_id();
                            let terminal = matches!(
                                control,
                                WatchControl::Cancel { .. } | WatchControl::Error { .. }
                            );
                            let encoded = encode_control(&ControlFrame::Watch(control));
                            let sent = encoded
                                .ok()
                                .and_then(|bytes| {
                                    links.get(&peer).and_then(|l| {
                                        l.message(key, bytes, terminal)
                                            .map(|m| l.senders.control.try_send(m).is_ok())
                                    })
                                })
                                .unwrap_or(false);
                            if !sent && !terminal {
                                effects.extend(
                                    core.request_failed(request_id, "watch_path_unavailable"),
                                );
                            }
                        }
                        WatchEffect::SendChunk {
                            peer,
                            key,
                            frame,
                            request_id,
                        } => {
                            let sent = links
                                .get(&peer)
                                .and_then(|l| {
                                    l.message(key.clone(), frame, false)
                                        .map(|m| l.senders.bulk.try_send(m).is_ok())
                                })
                                .unwrap_or(false);
                            if !sent {
                                // Core has finished this read. Its remaining frames and
                                // terminal error still belong to the downstream request.
                                effects.retain(|effect| !matches!(effect,
                                    WatchEffect::SendChunk { request_id: id, .. } if *id == request_id));
                                effects.push_front(WatchEffect::SendControl {
                                    peer,
                                    control: WatchControl::Error {
                                        key,
                                        request_id,
                                        code: "watch_path_unavailable".into(),
                                    },
                                });
                            }
                        }
                        WatchEffect::Received { .. } | WatchEffect::Failed { .. } => {}
                    }
                }
            }
            for (_, task) in reads {
                task.abort();
                let _ = task.await;
            }
            for (_, link) in links {
                link.lease.send_replace(Lease {
                    plans: vec![],
                    rooms: vec![],
                });
            }
        });
        Self {
            input,
            cancel,
            task,
        }
    }
    pub fn receiver(&self) -> Receiver {
        Receiver {
            input: self.input.clone(),
        }
    }
    pub async fn register(&self, resource: Uuid, reader: Arc<dyn Reader>) -> anyhow::Result<()> {
        let (done, completed) = oneshot::channel();
        self.input
            .send(Input::Register(resource, reader, done))
            .await?;
        completed.await?
    }
    pub async fn revoke(&self, resource: Uuid) {
        let _ = self.input.send(Input::Revoke(resource)).await;
    }
    pub async fn update(&self, plans: Vec<WatchBytePlan>, room_peers: Vec<(Uuid, Vec<String>)>) {
        let (done, completed) = oneshot::channel();
        if self
            .input
            .send(Input::Update(plans, room_peers, done))
            .await
            .is_ok()
        {
            let _ = completed.await;
        }
    }
    pub async fn attach(&self, peer: Uuid, senders: Senders) {
        let _ = self.input.send(Input::Attach(peer, senders)).await;
    }
    pub async fn unavailable(&self, peer: Uuid) {
        let _ = self.input.send(Input::Unavailable(peer)).await;
    }
    pub async fn detach(&self, peer: Uuid) {
        let _ = self.input.send(Input::Detach(peer)).await;
    }
    pub async fn close(self) {
        let _ = self.cancel.send(true);
        let _ = self.task.await;
    }
}
fn peer_lease(plans: &[WatchBytePlan], room_peers: &[(Uuid, Vec<String>)], peer: Uuid) -> Lease {
    Lease {
        rooms: room_peers
            .iter()
            .find(|(id, _)| *id == peer)
            .map(|(_, rooms)| rooms.clone())
            .unwrap_or_default(),
        plans: plans
            .iter()
            .filter(|p| p.upstream == Some(peer) || p.downstream.contains(&peer))
            .cloned()
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Unused;
    impl Reader for Unused {
        fn read(
            &self,
            _: Uuid,
            _: u64,
            _: u32,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<ReadResult>> + Send + '_>> {
            Box::pin(async { anyhow::bail!("unexpected_read") })
        }
    }
    #[tokio::test]
    async fn source_registration_outlives_remote_demand_and_retires_only_on_revoke() {
        let session = Uuid::new_v4();
        let resource = Uuid::new_v4();
        let watches = Watches::new(session);
        let reader = Arc::new(Unused);
        let lifetime = Arc::downgrade(&reader);
        watches.register(resource, reader.clone()).await.unwrap();
        drop(reader);
        let plan = WatchBytePlan {
            room_id: "owned".into(),
            activity_id: Uuid::new_v4(),
            source: WatchByteSource {
                session_id: session,
                resource_id: resource,
                format: piik_channel_core::wire::WatchFormat::File,
            },
            upstream: None,
            downstream: vec![],
            receiving: false,
        };
        watches.update(vec![plan.clone()], vec![]).await;
        watches.update(vec![], vec![]).await;
        assert!(lifetime.upgrade().is_some());
        watches.update(vec![plan], vec![]).await;
        assert!(lifetime.upgrade().is_some());
        watches.revoke(resource).await;
        watches.update(vec![], vec![]).await;
        assert!(lifetime.upgrade().is_none());
        watches.close().await;
    }
}
