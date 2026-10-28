//! FileDelivery owns file ranges, branch failures and its supplied plan leases.
use crate::data::{Lane, Message, Senders, BULK_QUEUE, CONTROL_QUEUE};
use piik_channel_prototype::{
    file_delivery::{FileControl, FileDelivery, FileEffect, FILE_FRAME_BYTES},
    file_room::{FileKey, FilePlan},
    wire::PairInfo,
};
use std::collections::{BTreeSet, HashMap, VecDeque};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

#[derive(Clone, Default)]
struct Lease {
    rooms: BTreeSet<String>,
    keys: BTreeSet<FileKey>,
}
pub(crate) struct FileScope {
    lease: watch::Receiver<Lease>,
    key: FileKey,
    allow_unplanned: bool,
}
impl FileScope {
    pub fn allowed(&self) -> bool {
        let lease = self.lease.borrow();
        lease.rooms.contains(&self.key.room_id)
            && (self.allow_unplanned || lease.keys.contains(&self.key))
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
    fn message(&self, key: FileKey, bytes: Vec<u8>, cancel: bool, error: bool) -> Message {
        Message {
            bytes,
            scope: crate::data::MessageScope::File(FileScope {
                lease: self.lease.subscribe(),
                key,
                allow_unplanned: cancel || error,
            }),
            report_failure: !error,
        }
    }
}
enum Input {
    Update(Vec<FilePlan>, Vec<(Uuid, Vec<String>)>, oneshot::Sender<()>),
    Attach(Uuid, Senders),
    Detach(Uuid),
    Control(Uuid, Uuid, FileControl),
    Chunk(Uuid, Uuid, Vec<u8>),
    Closed(Uuid, Lane, Uuid, bool),
    Unavailable(Uuid),
}
pub(crate) struct Files {
    input: mpsc::Sender<Input>,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}
#[derive(Clone)]
pub(crate) struct Receiver {
    input: mpsc::Sender<Input>,
}
impl Receiver {
    pub async fn control(&self, peer: Uuid, token: Uuid, control: FileControl) {
        let _ = self.input.send(Input::Control(peer, token, control)).await;
    }
    pub async fn chunk(&self, peer: Uuid, token: Uuid, bytes: &[u8]) {
        if bytes.len() > FILE_FRAME_BYTES {
            return;
        }
        let _ = self
            .input
            .send(Input::Chunk(peer, token, bytes.to_vec()))
            .await;
    }
    pub async fn closed(&self, peer: Uuid, lane: Lane, token: Uuid, temporary: bool) {
        let _ = self
            .input
            .send(Input::Closed(peer, lane, token, temporary))
            .await;
    }
}
impl Files {
    pub fn new(session: Uuid) -> Self {
        let (input, mut messages) = mpsc::channel(BULK_QUEUE + CONTROL_QUEUE);
        let (cancel, mut cancelled) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut core = FileDelivery::new(session);
            let mut links: HashMap<Uuid, Link> = HashMap::new();
            let mut leases: HashMap<Uuid, Lease> = HashMap::new();
            loop {
                let message = tokio::select! {_=cancelled.changed()=>break,message=messages.recv()=>match message{Some(message)=>message,None=>break}};
                let effects = match message {
                    Input::Update(plans, peers, done) => {
                        leases = peers
                            .into_iter()
                            .map(|(peer, rooms)| {
                                (
                                    peer,
                                    Lease {
                                        rooms: rooms.into_iter().collect(),
                                        keys: BTreeSet::new(),
                                    },
                                )
                            })
                            .collect();
                        for plan in &plans {
                            let key = FileKey {
                                room_id: plan.room_id.clone(),
                                message_seq: plan.message_seq,
                                attachment_id: plan.attachment.id,
                            };
                            for peer in plan.upstream.iter().chain(&plan.downstream) {
                                if let Some(lease) = leases.get_mut(peer) {
                                    if lease.rooms.contains(&key.room_id) {
                                        lease.keys.insert(key.clone());
                                    }
                                }
                            }
                        }
                        for (peer, link) in &links {
                            link.lease
                                .send_replace(leases.get(peer).cloned().unwrap_or_default());
                        }
                        let effects = core.update(plans);
                        let _ = done.send(());
                        effects
                    }
                    Input::Attach(peer, senders) => {
                        let (lease, _) =
                            watch::channel(leases.get(&peer).cloned().unwrap_or_default());
                        links.insert(peer, Link { senders, lease });
                        vec![]
                    }
                    Input::Detach(peer) => {
                        links.remove(&peer);
                        core.peer_unavailable(peer)
                    }
                    // A retired channel cannot feed a replacement lane.
                    Input::Control(peer, token, control) => {
                        if links
                            .get(&peer)
                            .is_some_and(|link| link.senders.current(Lane::Control, token, true))
                            && leases
                                .get(&peer)
                                .is_some_and(|lease| lease.rooms.contains(&key(&control).room_id))
                        {
                            core.control(peer, control)
                        } else {
                            vec![]
                        }
                    }
                    Input::Chunk(peer, token, bytes) => {
                        if links
                            .get(&peer)
                            .is_some_and(|link| link.senders.current(Lane::Bulk, token, true))
                        {
                            core.chunk(peer, &bytes).unwrap_or_default()
                        } else {
                            vec![]
                        }
                    }
                    Input::Unavailable(peer) => core.peer_unavailable(peer),
                    Input::Closed(peer, lane, token, temporary) => {
                        if links
                            .get(&peer)
                            .is_some_and(|link| link.senders.current(lane, token, false))
                        {
                            if temporary {
                                core.peer_unavailable(peer)
                            } else {
                                fail_peer(&mut core, &leases, peer, "file_link_closed")
                            }
                        } else {
                            vec![]
                        }
                    }
                };
                let mut effects: VecDeque<_> = effects.into();
                while let Some(effect) = effects.pop_front() {
                    match effect {
                        FileEffect::SendControl { peer, control } => {
                            let file = key(&control).clone();
                            let error = matches!(control, FileControl::Error { .. });
                            let cancel = matches!(control, FileControl::Cancel { .. });
                            let bytes = match piik_channel_prototype::conversation::encode_control(
                                &piik_channel_prototype::conversation::ControlFrame::File(control),
                            ) {
                                Ok(bytes) => bytes,
                                _ => {
                                    effects.extend(core.peer_failed(
                                        &file,
                                        peer,
                                        "invalid_file_frame",
                                    ));
                                    continue;
                                }
                            };
                            if let Some(link) = links.get(&peer).filter(|_| {
                                leases
                                    .get(&peer)
                                    .is_some_and(|lease| lease.rooms.contains(&file.room_id))
                            }) {
                                if link
                                    .senders
                                    .control
                                    .try_send(link.message(file.clone(), bytes, cancel, error))
                                    .is_err()
                                    && !error
                                {
                                    effects.extend(core.peer_failed(
                                        &file,
                                        peer,
                                        "file_transfer_busy",
                                    ));
                                }
                            } else if !error {
                                effects.extend(core.peer_unavailable(peer));
                            }
                        }
                        FileEffect::SendChunk { peer, key, frame } => {
                            if let Some(link) = links.get(&peer).filter(|_| {
                                leases
                                    .get(&peer)
                                    .is_some_and(|lease| lease.keys.contains(&key))
                            }) {
                                if link
                                    .senders
                                    .bulk
                                    .try_send(link.message(key.clone(), frame, false, false))
                                    .is_err()
                                {
                                    effects.extend(core.peer_failed(
                                        &key,
                                        peer,
                                        "file_transfer_busy",
                                    ));
                                }
                            } else {
                                effects.extend(core.peer_unavailable(peer));
                            }
                        }
                        FileEffect::Read { key, .. } => {
                            effects.extend(core.fail(&key, "file_source_unavailable"))
                        }
                        FileEffect::Write { key, .. } => {
                            effects.extend(core.fail(&key, "file_sink_unavailable"))
                        }
                        FileEffect::Complete { .. } | FileEffect::Failed { .. } => {}
                    }
                }
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
    pub async fn attach(&self, peer: Uuid, senders: Senders) {
        let _ = self.input.send(Input::Attach(peer, senders)).await;
    }
    pub async fn update(&self, plans: Vec<FilePlan>, pairs: &[PairInfo]) {
        let (done, completed) = oneshot::channel();
        let peers = pairs
            .iter()
            .map(|pair| (pair.peer_id, pair.rooms.clone()))
            .collect();
        if self
            .input
            .send(Input::Update(plans, peers, done))
            .await
            .is_ok()
        {
            let _ = completed.await;
        }
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
fn key(control: &FileControl) -> &FileKey {
    match control {
        FileControl::Pull { key, .. }
        | FileControl::Cancel { key, .. }
        | FileControl::Error { key, .. } => key,
    }
}
fn fail_peer(
    core: &mut FileDelivery,
    leases: &HashMap<Uuid, Lease>,
    peer: Uuid,
    code: &str,
) -> Vec<FileEffect> {
    leases
        .get(&peer)
        .map(|lease| {
            lease
                .keys
                .iter()
                .flat_map(|key| core.peer_failed(key, peer, code))
                .collect()
        })
        .unwrap_or_default()
}
