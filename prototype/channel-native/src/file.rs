//! Native performs byte forwarding only. FileDelivery owns range/branch state;
//! each adjacent pair owns its bounded writers and channel lifetime.
use piik_channel_prototype::{
    file_delivery::{
        FileControl, FileDelivery, FileEffect, FILE_FRAME_BYTES, FILE_MAX_PENDING_RANGES,
        FILE_MAX_RANGE_FRAMES,
    },
    file_room::{FileKey, FilePlan},
    wire::PairInfo,
};
use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;
use webrtc::data_channel::{DataChannel, RTCDataChannelState};

// One legal global range burst; no per-room queues multiply this budget.
const BULK_QUEUE: usize = FILE_MAX_PENDING_RANGES * FILE_MAX_RANGE_FRAMES;
const CONTROL_QUEUE: usize = FILE_MAX_PENDING_RANGES * 4;
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Lane {
    Control,
    Bulk,
}
#[derive(Clone, Default)]
// Projection of the supplied FilePlan + base leases, also used to stop queued
// writes on revocation. Range offsets/credit remain exclusively in FileDelivery.
struct Lease {
    rooms: BTreeSet<String>,
    keys: BTreeSet<FileKey>,
}
struct Message {
    key: FileKey,
    bytes: Vec<u8>,
    cancel: bool,
    error: bool,
}
impl Lease {
    fn allows(&self, m: &Message) -> bool {
        self.rooms.contains(&m.key.room_id) && (m.cancel || m.error || self.keys.contains(&m.key))
    }
}
#[derive(Clone)]
// Current SDK channel resource, fenced by the same token as the pair owner.
struct Binding {
    token: Uuid,
    channel: Arc<dyn DataChannel>,
    state: RTCDataChannelState,
}
#[derive(Clone)]
pub(crate) struct Ready {
    binding: watch::Sender<Option<Binding>>,
    token: Uuid,
}
impl Ready {
    pub fn set(&self, open: bool) -> bool {
        let mut current = false;
        self.binding.send_if_modified(|value| {
            if let Some(binding) = value {
                if binding.token == self.token {
                    current = true;
                    binding.state = if open {
                        RTCDataChannelState::Open
                    } else {
                        RTCDataChannelState::Closed
                    };
                    return true;
                }
            }
            false
        });
        current
    }
}
struct Writer {
    input: mpsc::Sender<Message>,
    binding: watch::Sender<Option<Binding>>,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}
#[derive(Clone)]
struct Link {
    control: mpsc::Sender<Message>,
    bulk: mpsc::Sender<Message>,
    lease: watch::Sender<Lease>,
    control_binding: watch::Sender<Option<Binding>>,
    bulk_binding: watch::Sender<Option<Binding>>,
}
impl Link {
    fn current(&self, lane: Lane, token: Uuid, open: bool) -> bool {
        let state = match lane {
            Lane::Control => &self.control_binding,
            Lane::Bulk => &self.bulk_binding,
        };
        state.borrow().as_ref().is_some_and(|binding| {
            binding.token == token && (!open || binding.state == RTCDataChannelState::Open)
        })
    }
}
pub(crate) struct FileLink {
    control: Writer,
    bulk: Writer,
}
impl FileLink {
    pub async fn new(peer: Uuid, state: Arc<AtomicU8>, files: &Files) -> Self {
        let (lease, _) = watch::channel(Lease::default());
        let control = writer(
            peer,
            Lane::Control,
            state.clone(),
            CONTROL_QUEUE,
            lease.subscribe(),
            files.input.clone(),
        );
        let bulk = writer(
            peer,
            Lane::Bulk,
            state,
            BULK_QUEUE,
            lease.subscribe(),
            files.input.clone(),
        );
        let handle = Link {
            control: control.input.clone(),
            bulk: bulk.input.clone(),
            lease: lease.clone(),
            control_binding: control.binding.clone(),
            bulk_binding: bulk.binding.clone(),
        };
        let _ = files.input.send(Input::Attach(peer, handle)).await;
        Self { control, bulk }
    }
    pub fn bind(&self, lane: Lane, token: Uuid, channel: Arc<dyn DataChannel>) -> Ready {
        let binding = match lane {
            Lane::Control => &self.control.binding,
            Lane::Bulk => &self.bulk.binding,
        };
        binding.send_replace(Some(Binding {
            token,
            channel,
            state: RTCDataChannelState::Connecting,
        }));
        Ready {
            binding: binding.clone(),
            token,
        }
    }
    pub fn unbind(&self, lane: Lane) {
        match lane {
            Lane::Control => &self.control.binding,
            Lane::Bulk => &self.bulk.binding,
        }
        .send_if_modified(|value| {
            if let Some(binding) = value {
                binding.state = RTCDataChannelState::Closed;
                true
            } else {
                false
            }
        });
    }
    pub async fn close(self) {
        for writer in [self.control, self.bulk] {
            let _ = writer.cancel.send(true);
            let _ = writer.task.await;
        }
    }
}
fn writer(
    peer: Uuid,
    lane: Lane,
    state: Arc<AtomicU8>,
    capacity: usize,
    mut lease: watch::Receiver<Lease>,
    events: mpsc::Sender<Input>,
) -> Writer {
    let (input, mut queue) = mpsc::channel::<Message>(capacity);
    let (binding, mut channel) = watch::channel::<Option<Binding>>(None);
    let (cancel, mut cancelled) = watch::channel(false);
    let task = tokio::spawn(async move {
        loop {
            let message = tokio::select! {
             _=cancelled.changed()=>break,
             _=channel.changed()=>{if channel.borrow().as_ref().is_some_and(|binding|binding.state==RTCDataChannelState::Closed){while queue.try_recv().is_ok(){}}continue;},
             message=queue.recv()=>match message{Some(message)=>message,None=>break}
            };
            if !lease.borrow().allows(&message) {
                continue;
            }
            let dc = loop {
                if !lease.borrow().allows(&message) {
                    break None;
                }
                if let Some(binding) = channel
                    .borrow()
                    .as_ref()
                    .filter(|binding| binding.state == RTCDataChannelState::Open)
                {
                    break Some(binding.clone());
                }
                tokio::select! {
                 _=cancelled.changed()=>return,
                 _=channel.changed()=>{if channel.borrow().as_ref().is_some_and(|binding|binding.state==RTCDataChannelState::Closed){while queue.try_recv().is_ok(){}break None;}},
                 _=lease.changed()=>{}
                }
            };
            let Some(dc) = dc else {
                continue;
            };
            let send = async {
                match lane {
                    Lane::Control => {
                        dc.channel
                            .send_text(
                                std::str::from_utf8(&message.bytes)
                                    .expect("serialized FileControl is UTF-8"),
                            )
                            .await
                    }
                    Lane::Bulk => dc.channel.send(message.bytes.as_slice().into()).await,
                }
            };
            tokio::pin!(send);
            let result = loop {
                tokio::select! {
                 _=cancelled.changed()=>return,
                 _=channel.changed()=>{if channel.borrow().as_ref().is_some_and(|binding|binding.token!=dc.token||binding.state==RTCDataChannelState::Closed){while queue.try_recv().is_ok(){}break None;}},
                 _=lease.changed()=>{if !lease.borrow().allows(&message){break None;}},
                 result=&mut send=>break Some(result),
                }
            };
            if result.is_some_and(|result| result.is_err())
                && !message.error
                && channel.borrow().as_ref().is_some_and(|binding| {
                    binding.token == dc.token && binding.state == RTCDataChannelState::Open
                })
            {
                while queue.try_recv().is_ok() {}
                let _ = events
                    .send(Input::Closed(
                        peer,
                        lane,
                        dc.token,
                        lane == Lane::Control || terminal(&state),
                    ))
                    .await;
            }
        }
    });
    Writer {
        input,
        binding,
        cancel,
        task,
    }
}

enum Input {
    Update(Vec<FilePlan>, Vec<(Uuid, Vec<String>)>, oneshot::Sender<()>),
    Attach(Uuid, Link),
    Detach(Uuid),
    Message(Uuid, Lane, Uuid, Vec<u8>),
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
    pub async fn message(&self, peer: Uuid, lane: Lane, token: Uuid, bytes: &[u8]) {
        if bytes.len() > FILE_FRAME_BYTES {
            return;
        }
        let _ = self
            .input
            .send(Input::Message(peer, lane, token, bytes.to_vec()))
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
                    Input::Attach(peer, link) => {
                        link.lease
                            .send_replace(leases.get(&peer).cloned().unwrap_or_default());
                        links.insert(peer, link);
                        vec![]
                    }
                    Input::Detach(peer) => {
                        links.remove(&peer);
                        core.peer_unavailable(peer)
                    }
                    // A retired channel cannot feed a replacement lane.
                    Input::Message(peer, lane, token, bytes) => {
                        if !links
                            .get(&peer)
                            .is_some_and(|link| link.current(lane, token, true))
                        {
                            continue;
                        }
                        match lane {
                            Lane::Control => match serde_json::from_slice::<FileControl>(&bytes) {
                                Ok(control)
                                    if leases.get(&peer).is_some_and(|lease| {
                                        lease.rooms.contains(&key(&control).room_id)
                                    }) =>
                                {
                                    core.control(peer, control)
                                }
                                _ => vec![],
                            },
                            Lane::Bulk => core.chunk(peer, &bytes).unwrap_or_default(),
                        }
                    }
                    Input::Unavailable(peer) => core.peer_unavailable(peer),
                    Input::Closed(peer, lane, token, temporary) => {
                        if links
                            .get(&peer)
                            .is_some_and(|link| link.current(lane, token, false))
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
                            let bytes = match serde_json::to_vec(&control) {
                                Ok(bytes) if bytes.len() <= FILE_FRAME_BYTES => bytes,
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
                                    .control
                                    .try_send(Message {
                                        key: file.clone(),
                                        bytes,
                                        cancel,
                                        error,
                                    })
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
                                    .bulk
                                    .try_send(Message {
                                        key: key.clone(),
                                        bytes: frame,
                                        cancel: false,
                                        error: false,
                                    })
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

pub(crate) fn terminal(state: &AtomicU8) -> bool {
    let state = state.load(Ordering::Acquire);
    state == webrtc::peer_connection::RTCPeerConnectionState::Failed as u8
        || state == webrtc::peer_connection::RTCPeerConnectionState::Closed as u8
}
