//! One pair owns its reliable channel writers. Consumers own queued-work validity.
use piik_channel_prototype::file_delivery::{
    FileControl, FILE_FRAME_BYTES, FILE_MAX_PENDING_RANGES, FILE_MAX_RANGE_FRAMES,
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
    pub scope: crate::file::FileScope,
    pub report_failure: bool,
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

// Room control decoding belongs to the pair boundary. FileDelivery consumes
// typed controls rather than owning the shared channel's parser.
pub(crate) fn control(bytes: &[u8]) -> Option<FileControl> {
    if bytes.len() > FILE_FRAME_BYTES {
        return None;
    }
    serde_json::from_slice(bytes).ok()
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
