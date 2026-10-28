//! One pair owns its reliable channel writers. Consumers own queued-work validity.
use piik_channel_core::file_delivery::{FILE_MAX_PENDING_RANGES, FILE_MAX_RANGE_FRAMES};
use piik_channel_core::{
    conversation::{self, ControlFrame, SignedPacket},
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
use webrtc::data_channel::{DataChannel, RTCDataChannelState};

pub(crate) const BULK_QUEUE: usize = FILE_MAX_PENDING_RANGES * FILE_MAX_RANGE_FRAMES;
pub(crate) const CONTROL_QUEUE: usize = FILE_MAX_PENDING_RANGES * 4;
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Lane {
    Control,
    Bulk,
}

pub(crate) struct Message {
    pub bytes: Vec<u8>,
    pub scope: MessageScope,
    pub report_failure: bool,
}
pub(crate) fn queue_controls(
    sender: &mpsc::Sender<Message>,
    messages: Vec<Message>,
) -> Result<(), &'static str> {
    let permits = sender
        .try_reserve_many(messages.len())
        .map_err(|_| "room_control_busy")?;
    for (permit, message) in permits.zip(messages) {
        permit.send(message);
    }
    Ok(())
}
pub(crate) enum MessageScope {
    File(crate::file::FileScope),
    Conversation {
        snapshot: watch::Receiver<Option<Snapshot>>,
        local: Uuid,
        peer: Uuid,
        from: Option<Uuid>,
        packet: SignedPacket,
    },
}
impl MessageScope {
    fn allowed(&self) -> bool {
        match self {
            Self::File(scope) => scope.allowed(),
            Self::Conversation {
                snapshot,
                local,
                peer,
                from,
                packet,
            } => {
                let mut packet = packet.clone();
                snapshot.borrow().as_ref().is_some_and(|snapshot| {
                    conversation::route(&mut packet, *local, snapshot, *from)
                        .is_ok_and(|route| route.next_hop == Some(*peer))
                })
            }
        }
    }
    async fn changed(&mut self) -> bool {
        match self {
            Self::File(scope) => scope.changed().await,
            Self::Conversation { snapshot, .. } => snapshot.changed().await.is_ok(),
        }
    }
}
#[derive(Clone)]
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
    pub fn open(&self) -> bool {
        self.binding.borrow().as_ref().is_some_and(|binding| {
            binding.token == self.token && binding.state == RTCDataChannelState::Open
        })
    }
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
pub(crate) struct Senders {
    pub control: mpsc::Sender<Message>,
    pub bulk: mpsc::Sender<Message>,
    control_binding: watch::Sender<Option<Binding>>,
    bulk_binding: watch::Sender<Option<Binding>>,
}
impl Senders {
    pub fn current(&self, lane: Lane, token: Uuid, open: bool) -> bool {
        let state = match lane {
            Lane::Control => &self.control_binding,
            Lane::Bulk => &self.bulk_binding,
        };
        state.borrow().as_ref().is_some_and(|binding| {
            binding.token == token && (!open || binding.state == RTCDataChannelState::Open)
        })
    }
}
pub(crate) struct DataLink {
    control: Writer,
    bulk: Writer,
}
impl DataLink {
    pub fn new(pair: Uuid, state: Arc<AtomicU8>, events: mpsc::Sender<crate::peer::Event>) -> Self {
        Self {
            control: writer(
                pair,
                Lane::Control,
                state.clone(),
                CONTROL_QUEUE,
                events.clone(),
            ),
            bulk: writer(pair, Lane::Bulk, state, BULK_QUEUE, events),
        }
    }
    pub fn senders(&self) -> Senders {
        Senders {
            control: self.control.input.clone(),
            bulk: self.bulk.input.clone(),
            control_binding: self.control.binding.clone(),
            bulk_binding: self.bulk.binding.clone(),
        }
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

// Pair control has one decoder; file and conversation owners consume typed frames.
pub(crate) fn control(bytes: &[u8]) -> Option<ControlFrame> {
    conversation::decode_control(bytes).ok()
}
pub(crate) fn terminal(state: &AtomicU8) -> bool {
    let state = state.load(Ordering::Acquire);
    state == webrtc::peer_connection::RTCPeerConnectionState::Failed as u8
        || state == webrtc::peer_connection::RTCPeerConnectionState::Closed as u8
}
fn writer(
    pair: Uuid,
    lane: Lane,
    state: Arc<AtomicU8>,
    capacity: usize,
    events: mpsc::Sender<crate::peer::Event>,
) -> Writer {
    let (input, mut queue) = mpsc::channel::<Message>(capacity);
    let (binding, mut channel) = watch::channel::<Option<Binding>>(None);
    let (cancel, mut cancelled) = watch::channel(false);
    let task = tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                _ = cancelled.changed() => break,
                _ = channel.changed() => {
                    if channel.borrow().as_ref().is_some_and(|binding| binding.state == RTCDataChannelState::Closed) {
                        while queue.try_recv().is_ok() {}
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
                    .filter(|binding| binding.state == RTCDataChannelState::Open)
                {
                    break Some(binding.clone());
                }
                tokio::select! {
                    _ = cancelled.changed() => return,
                    _ = channel.changed() => {
                        if channel.borrow().as_ref().is_some_and(|binding| binding.state == RTCDataChannelState::Closed) {
                            while queue.try_recv().is_ok() {}
                            break None;
                        }
                    }
                    alive = scope.changed() => { if !alive { break None; } }
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
                                std::str::from_utf8(&bytes)
                                    .expect("control producer supplies UTF-8"),
                            )
                            .await
                    }
                    Lane::Bulk => dc.channel.send(bytes.as_slice().into()).await,
                }
            };
            tokio::pin!(send);
            let result = loop {
                tokio::select! {
                    _ = cancelled.changed() => return,
                    _ = channel.changed() => {
                        if channel.borrow().as_ref().is_some_and(|binding| binding.token != dc.token || binding.state == RTCDataChannelState::Closed) {
                            while queue.try_recv().is_ok() {}
                            break None;
                        }
                    }
                    alive = scope.changed() => { if !alive || !scope.allowed() { break None; } }
                    result = &mut send => break Some(result),
                }
            };
            if result.is_some_and(|result| result.is_err())
                && report_failure
                && channel.borrow().as_ref().is_some_and(|binding| {
                    binding.token == dc.token && binding.state == RTCDataChannelState::Open
                })
            {
                while queue.try_recv().is_ok() {}
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

    fn record(index: u8) -> Message {
        Message {
            bytes: vec![index],
            scope: MessageScope::Conversation {
                snapshot: watch::channel(None).1,
                local: Uuid::nil(),
                peer: Uuid::nil(),
                from: None,
                packet: conversation::SessionSigner::from_seed([1; 32])
                    .sign(Uuid::nil(), &index)
                    .unwrap(),
            },
            report_failure: true,
        }
    }

    #[tokio::test]
    async fn history_page_reserves_all_records_or_keeps_the_existing_queue_unchanged() {
        let (sender, mut receiver) = mpsc::channel(CONTROL_QUEUE);
        for index in 0..28 {
            sender
                .try_send(record(index))
                .unwrap_or_else(|_| panic!("queue should have capacity"));
        }
        let page = || (0..101).map(record).collect();
        assert_eq!(queue_controls(&sender, page()), Err("room_control_busy"));
        assert_eq!(sender.capacity(), 100);
        for index in 0..28 {
            assert_eq!(receiver.recv().await.unwrap().bytes, vec![index]);
        }
        assert!(
            receiver.try_recv().is_err(),
            "no partial history page was admitted"
        );

        queue_controls(&sender, page()).unwrap();
        assert_eq!(sender.capacity(), CONTROL_QUEUE - 101);
        for index in 0..101 {
            assert_eq!(receiver.recv().await.unwrap().bytes, vec![index]);
        }
        assert!(receiver.try_recv().is_err());
    }
}
