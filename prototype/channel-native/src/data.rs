//! One pair owns its reliable channel writers. Consumers own queued-work validity.
use crate::peer::{transport::Channel, PeerState};
use piik_channel_core::{
    conversation::{self, ControlFrame},
    wire::Snapshot,
};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use uuid::Uuid;

pub(crate) const BULK_QUEUE: usize = piik_channel_core::conversation::data_queue_frames(true);
pub(crate) const CONTROL_QUEUE: usize = piik_channel_core::conversation::data_queue_frames(false);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Lane {
    Control,
    Bulk,
    Input,
}
impl Lane {
    pub(crate) fn from_label(label: &str) -> Option<Self> {
        match label {
            "piik-room" => Some(Self::Control),
            "piik-file" => Some(Self::Bulk),
            "piik-input" => Some(Self::Input),
            _ => None,
        }
    }
}

pub(crate) struct Message {
    pub bytes: Vec<u8>,
    pub scope: MessageScope,
    pub report_failure: bool,
}
#[derive(Clone)]
pub(crate) enum MessageScope {
    File(crate::file::FileScope),
    Watch(crate::watch::WatchScope),
    Input {
        snapshot: watch::Receiver<Option<Snapshot>>,
        local: Uuid,
        binding: piik_channel_core::input::InputBinding,
    },
}
impl MessageScope {
    pub(crate) fn allowed(&self) -> bool {
        match self {
            Self::File(scope) => scope.allowed(),
            Self::Watch(scope) => scope.allowed(),
            Self::Input {
                snapshot,
                local,
                binding,
            } => snapshot
                .borrow()
                .as_ref()
                .is_some_and(|state| binding.current(*local, state)),
        }
    }
    async fn changed(&mut self) -> bool {
        match self {
            Self::File(scope) => scope.changed().await,
            Self::Watch(scope) => scope.changed().await,
            Self::Input { snapshot, .. } => snapshot.changed().await.is_ok(),
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum BindingState {
    Connecting,
    Open,
    Closed,
}

#[derive(Clone)]
struct Binding {
    token: Uuid,
    channel: Arc<Channel>,
    state: BindingState,
}
#[derive(Clone)]
pub(crate) struct Ready {
    binding: watch::Sender<Option<Binding>>,
    token: Uuid,
}
impl Ready {
    pub fn open(&self) -> bool {
        self.binding.borrow().as_ref().is_some_and(|binding| {
            binding.token == self.token && binding.state == BindingState::Open
        })
    }
    pub fn set(&self, open: bool) -> bool {
        let mut current = false;
        self.binding.send_if_modified(|value| {
            if let Some(binding) = value {
                if binding.token == self.token {
                    current = true;
                    binding.state = if open {
                        BindingState::Open
                    } else {
                        BindingState::Closed
                    };
                    return true;
                }
            }
            false
        });
        current
    }
}
// Only the bulk lane needs selective removal. The active write carries its
// cancellation signal through the runtime command queue to the SDK call.
#[derive(Default)]
pub(crate) struct BulkState {
    closed: bool,
    pending: std::collections::VecDeque<Message>,
    active: Option<(piik_channel_core::file_room::FileKey, u64, Uuid)>,
}
#[derive(Clone)]
pub(crate) struct BulkSender {
    state: watch::Sender<BulkState>,
    retire_active: watch::Sender<()>,
    capacity: usize,
}
impl BulkSender {
    pub fn try_send(&self, message: Message) -> Result<(), ()> {
        let accepted = self.state.send_if_modified(|state| {
            if state.closed || state.pending.len() == self.capacity {
                return false;
            }
            state.pending.push_back(message);
            true
        });
        if accepted {
            Ok(())
        } else {
            Err(())
        }
    }
    pub fn cancel(
        &self,
        key: &piik_channel_core::file_room::FileKey,
        offset: u64,
        request_id: Uuid,
    ) {
        self.state.send_if_modified(|state| {
            state.pending.retain(|message| {
                !matches!(&message.scope,
                MessageScope::File(scope) if scope.request() == Some((key, offset, request_id)))
            });
            if state
                .active
                .as_ref()
                .is_some_and(|(file, start, id)| (file, *start, *id) == (key, offset, request_id))
            {
                state.active = None;
                self.retire_active.send_replace(());
            }
            false // Removing frames cannot make a waiting receiver readable.
        });
    }
}
pub(crate) enum Incoming {
    Fifo(mpsc::Receiver<Message>),
    Bulk(BulkSender, watch::Receiver<BulkState>),
}
fn fifo(capacity: usize) -> (mpsc::Sender<Message>, Incoming) {
    let (sender, receiver) = mpsc::channel(capacity);
    (sender, Incoming::Fifo(receiver))
}
pub(crate) fn bulk_queue(capacity: usize) -> (BulkSender, Incoming) {
    let (state, changed) = watch::channel(BulkState::default());
    let sender = BulkSender {
        state,
        capacity,
        retire_active: watch::channel(()).0,
    };
    (sender.clone(), Incoming::Bulk(sender, changed))
}
impl Incoming {
    pub(crate) async fn recv(&mut self) -> Option<Message> {
        match self {
            Self::Fifo(queue) => queue.recv().await,
            Self::Bulk(queue, changed) => loop {
                let mut next = None;
                queue.state.send_if_modified(|state| {
                    if state.active.take().is_some() {
                        queue.retire_active.send_replace(());
                    }
                    next = state.pending.pop_front();
                    if let Some(Message {
                        scope: MessageScope::File(scope),
                        ..
                    }) = &mut next
                    {
                        scope.retired = Some(queue.retire_active.subscribe());
                        state.active = scope
                            .request()
                            .map(|(key, offset, id)| (key.clone(), offset, id));
                    }
                    false
                });
                if next.is_some() {
                    return next;
                }
                changed.changed().await.ok()?;
            },
        }
    }
    fn clear(&mut self) {
        match self {
            Self::Fifo(queue) => while queue.try_recv().is_ok() {},
            Self::Bulk(queue, _) => queue.state.send_modify(|state| state.pending.clear()),
        }
    }
}
impl Drop for Incoming {
    fn drop(&mut self) {
        if let Self::Bulk(queue, _) = self {
            queue.state.send_modify(|state| {
                state.closed = true;
                state.pending.clear();
                state.active = None;
                queue.retire_active.send_replace(());
            });
        }
    }
}
struct Writer<S> {
    input: S,
    binding: watch::Sender<Option<Binding>>,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}
#[derive(Clone)]
pub(crate) struct Senders {
    pub control: mpsc::Sender<Message>,
    pub bulk: BulkSender,
    pub input: mpsc::Sender<Message>,
    control_binding: watch::Sender<Option<Binding>>,
    bulk_binding: watch::Sender<Option<Binding>>,
    input_binding: watch::Sender<Option<Binding>>,
}
impl Senders {
    pub fn current(&self, lane: Lane, token: Uuid, open: bool) -> bool {
        let state = match lane {
            Lane::Control => &self.control_binding,
            Lane::Bulk => &self.bulk_binding,
            Lane::Input => &self.input_binding,
        };
        state.borrow().as_ref().is_some_and(|binding| {
            binding.token == token && (!open || binding.state == BindingState::Open)
        })
    }
}
pub(crate) struct DataLink {
    control: Writer<mpsc::Sender<Message>>,
    bulk: Writer<BulkSender>,
    input: Writer<mpsc::Sender<Message>>,
}
impl DataLink {
    pub fn new(pair: Uuid, state: Arc<AtomicU8>, events: mpsc::Sender<crate::peer::Event>) -> Self {
        Self {
            control: writer(
                pair,
                Lane::Control,
                state.clone(),
                fifo(CONTROL_QUEUE),
                events.clone(),
            ),
            bulk: writer(
                pair,
                Lane::Bulk,
                state.clone(),
                bulk_queue(BULK_QUEUE),
                events.clone(),
            ),
            input: writer(pair, Lane::Input, state, fifo(8), events),
        }
    }
    pub fn senders(&self) -> Senders {
        Senders {
            control: self.control.input.clone(),
            bulk: self.bulk.input.clone(),
            input: self.input.input.clone(),
            control_binding: self.control.binding.clone(),
            bulk_binding: self.bulk.binding.clone(),
            input_binding: self.input.binding.clone(),
        }
    }
    pub fn bind(&self, lane: Lane, token: Uuid, channel: Arc<Channel>) -> Ready {
        let binding = match lane {
            Lane::Control => &self.control.binding,
            Lane::Bulk => &self.bulk.binding,
            Lane::Input => &self.input.binding,
        };
        binding.send_replace(Some(Binding {
            token,
            channel,
            state: BindingState::Connecting,
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
            Lane::Input => &self.input.binding,
        }
        .send_if_modified(|value| {
            if let Some(binding) = value {
                binding.state = BindingState::Closed;
                true
            } else {
                false
            }
        });
    }
    pub async fn close(self) {
        for (cancel, task) in [
            (self.control.cancel, self.control.task),
            (self.bulk.cancel, self.bulk.task),
            (self.input.cancel, self.input.task),
        ] {
            let _ = cancel.send(true);
            let _ = task.await;
        }
    }
}

// Pair control has one decoder; file and conversation owners consume typed frames.
pub(crate) fn control(bytes: &[u8]) -> Option<ControlFrame> {
    conversation::decode_control(bytes).ok()
}
pub(crate) fn terminal(state: &AtomicU8) -> bool {
    let state = state.load(Ordering::Acquire);
    state == PeerState::Failed as u8 || state == PeerState::Closed as u8
}
fn writer<S>(
    pair: Uuid,
    lane: Lane,
    state: Arc<AtomicU8>,
    (input, mut queue): (S, Incoming),
    events: mpsc::Sender<crate::peer::Event>,
) -> Writer<S> {
    let (binding, mut channel) = watch::channel::<Option<Binding>>(None);
    let (cancel, mut cancelled) = watch::channel(false);
    let task = tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                _ = cancelled.changed() => break,
                _ = channel.changed() => {
                    let binding = channel.borrow();
                    if binding.as_ref().is_some_and(|binding| binding.state == BindingState::Closed) {
                        queue.clear();
                    }
                    continue;
                }
                message = queue.recv() => match message { Some(message) => message, None => break }
            };
            let Message {
                bytes,
                mut scope,
                report_failure,
            } = message;
            if !scope.allowed() {
                continue;
            }
            let dc = loop {
                if !scope.allowed() {
                    break None;
                }
                if let Some(binding) = channel
                    .borrow()
                    .as_ref()
                    .filter(|binding| binding.state == BindingState::Open)
                {
                    break Some(binding.clone());
                }
                tokio::select! {
                    _ = cancelled.changed() => return,
                    _ = channel.changed() => {
                        let binding = channel.borrow();
                        if binding.as_ref().is_some_and(|binding| binding.state == BindingState::Closed) {
                            queue.clear();
                            break None;
                        }
                    }
                    alive = scope.changed() => { if !alive { break None; } }
                }
            };
            let Some(dc) = dc else {
                continue;
            };
            let write_scope = scope.clone();
            let send = async {
                loop {
                    let notified = dc.channel.low.notified();
                    if !write_scope.allowed() {
                        return Ok(());
                    }
                    if dc
                        .channel
                        .write(
                            lane == Lane::Bulk,
                            bytes.clone(),
                            write_scope.clone(),
                            lane == Lane::Input,
                        )
                        .await?
                    {
                        return Ok::<_, anyhow::Error>(());
                    }
                    notified.await;
                }
            };
            tokio::pin!(send);
            let result = loop {
                tokio::select! {
                    _ = cancelled.changed() => return,
                    _ = channel.changed() => {
                        if let Some(binding) = channel.borrow().as_ref() {
                            if binding.token != dc.token {
                                // The pair's queue may already contain work for the new channel.
                                break None;
                            }
                            if binding.state == BindingState::Closed {
                                queue.clear();
                                break None;
                            }
                        }
                    }
                    alive = scope.changed() => { if !alive || !scope.allowed() { break None; } }
                    result = &mut send => break Some(result),
                }
            };
            let should_report = result.is_some_and(|result| result.is_err()) && report_failure && {
                let binding = channel.borrow();
                let current = binding.as_ref().is_some_and(|binding| {
                    binding.token == dc.token && binding.state == BindingState::Open
                });
                if current {
                    queue.clear();
                }
                current
            };
            if should_report {
                let failed = crate::peer::Event::DataWriteFailed {
                    pair,
                    lane,
                    token: dc.token,
                    temporary: lane == Lane::Control || terminal(&state),
                };
                tokio::select! {
                    _ = cancelled.changed() => return,
                    _ = events.send(failed) => {}
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_reclaims_only_matching_bulk_slots_and_retires_the_active_write() {
        use piik_channel_core::file_room::FileKey;
        let key = FileKey {
            room_id: "room".into(),
            message_seq: 1,
            attachment_id: Uuid::new_v4(),
        };
        let old = Uuid::new_v4();
        let fresh = Uuid::new_v4();
        let (scope, _lease) = crate::file::scope_fixture(key.clone());
        let message = |offset, id, byte| {
            let mut scope = scope.clone();
            scope.request = Some((offset, id));
            Message {
                bytes: vec![byte],
                scope: MessageScope::File(scope),
                report_failure: true,
            }
        };
        let (bulk, mut queue) = bulk_queue(3);
        bulk.try_send(message(0, old, 0)).unwrap();
        let mut active = queue.recv().await.unwrap().scope;
        let sdk_scope = active.clone();
        bulk.try_send(message(0, old, 1)).unwrap();
        bulk.try_send(message(1, old, 2)).unwrap();
        bulk.try_send(message(0, old, 3)).unwrap();
        assert!(bulk.try_send(message(0, fresh, 4)).is_err());
        bulk.cancel(&key, 0, old);
        assert!(!active.changed().await);
        assert!(!sdk_scope.allowed());
        bulk.try_send(message(0, fresh, 4)).unwrap();
        bulk.cancel(&key, 0, old);
        for byte in [2, 4] {
            let frame = queue.recv().await.unwrap();
            assert!(frame.scope.allowed());
            assert_eq!(frame.bytes, [byte]);
        }
        drop(queue);
        assert!(bulk.try_send(message(0, fresh, 5)).is_err());
    }

    #[test]
    fn bulk_queue_holds_a_full_watch_window_from_an_aggregating_relay() {
        use piik_channel_core::{
            watch_delivery::{
                WatchBytePlan, WatchControl, WatchDelivery, WatchEffect, WatchKey, WatchReadResult,
                WATCH_MAX_PENDING, WATCH_MAX_RANGE_FRAMES, WATCH_WINDOW_BYTES,
            },
            wire::{WatchByteSource, WatchFormat},
        };
        let session = Uuid::new_v4();
        let peer = Uuid::new_v4();
        let key = WatchKey {
            room_id: "watch".into(),
            activity_id: Uuid::new_v4(),
            resource_id: Uuid::new_v4(),
        };
        let mut source = WatchDelivery::new(session);
        source.update(
            vec![WatchBytePlan {
                room_id: key.room_id.clone(),
                activity_id: key.activity_id,
                source: WatchByteSource {
                    session_id: session,
                    resource_id: key.resource_id,
                    format: WatchFormat::File,
                },
                upstream: None,
                downstream: vec![peer],
                receiving: false,
            }],
            vec![(peer, vec![key.room_id.clone()])],
        );
        let requests: Vec<_> = (0..WATCH_MAX_PENDING).map(|_| Uuid::new_v4()).collect();
        for request_id in &requests {
            assert!(matches!(
                source
                    .control(
                        peer,
                        WatchControl::Pull {
                            key: key.clone(),
                            request_id: *request_id,
                            offset: 0,
                            length: WATCH_WINDOW_BYTES,
                        }
                    )
                    .as_slice(),
                [WatchEffect::Read { .. }]
            ));
        }
        let (queue, mut incoming) = mpsc::channel(BULK_QUEUE);
        for request in requests {
            for effect in source.read_result(
                request,
                Ok(WatchReadResult {
                    mime_type: "\"".repeat(128),
                    total_size: Some(u64::MAX),
                    bytes: vec![7; WATCH_WINDOW_BYTES],
                    eof: false,
                }),
            ) {
                let WatchEffect::SendChunk { frame, .. } = effect else {
                    panic!("expected frame")
                };
                queue
                    .try_send(frame)
                    .expect("legal Watch burst fits without draining the writer");
            }
        }
        assert_eq!(incoming.len(), WATCH_MAX_PENDING * WATCH_MAX_RANGE_FRAMES);
        while incoming.try_recv().is_ok() {}
    }
}
