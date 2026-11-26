//! One connection's outbound events: a bounded queue in which levels conflate.
//!
//! An edge is delivered once, in order. A level only states the latest value of
//! its subject, so a newer one replaces an unsent older one where it stands,
//! unless an edge of the same subject was queued after it. Nothing is ever
//! reordered against an edge of its own subject. The core says which events
//! are levels and what they are about; this queue only keeps the order.
//!
//! Without it one admission queues an input for every room a host serves and a
//! snapshot for every session, each a full copy of what the previous one said.
//! A burst of admissions then closed a healthy host for a full queue.

use piik_channel_core::wire::{Event, Subject};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

enum Item {
    Edge(Event),
    /// The slot of a level, whose latest value is taken when it is sent.
    Level(u64),
}

#[derive(Default)]
struct Levels {
    next: u64,
    unsent: HashMap<u64, Event>,
    /// The slot of a subject's newest queued event, while that event is a level.
    newest: HashMap<Subject, u64>,
}

impl Levels {
    /// Puts a level in the place of the unsent one it supersedes. Returns the
    /// event when it needs a place of its own.
    fn supersede(&mut self, event: Event) -> Option<Event> {
        if event.is_level() {
            let unsent = self
                .newest
                .get(&event.subject())
                .and_then(|slot| self.unsent.get_mut(slot));
            if let Some(unsent) = unsent {
                *unsent = event;
                return None;
            }
        }
        Some(event)
    }

    fn place(&mut self, event: Event) -> Item {
        let subject = event.subject();
        if !event.is_level() {
            self.newest.remove(&subject);
            return Item::Edge(event);
        }
        let slot = self.next;
        self.next += 1;
        self.unsent.insert(slot, event);
        self.newest.insert(subject, slot);
        Item::Level(slot)
    }

    fn take(&mut self, slot: u64) -> Event {
        let event = self
            .unsent
            .remove(&slot)
            .expect("a queued level is taken once");
        let subject = event.subject();
        if self.newest.get(&subject) == Some(&slot) {
            self.newest.remove(&subject);
        }
        event
    }
}

#[derive(Clone)]
pub(crate) struct Sender {
    queue: mpsc::Sender<Item>,
    levels: Arc<Mutex<Levels>>,
}

pub(crate) struct Receiver {
    queue: mpsc::Receiver<Item>,
    levels: Arc<Mutex<Levels>>,
}

#[derive(Debug)]
pub(crate) struct Full;

/// `capacity` bounds the edges and the distinct levels that are unsent.
pub(crate) fn channel(capacity: usize) -> (Sender, Receiver) {
    let (sender, receiver) = mpsc::channel(capacity);
    let levels = Arc::<Mutex<Levels>>::default();
    (
        Sender {
            queue: sender,
            levels: levels.clone(),
        },
        Receiver {
            queue: receiver,
            levels,
        },
    )
}

impl Sender {
    /// Fails when the queue is full or its connection has gone.
    pub(crate) fn try_send(&self, event: Event) -> Result<(), Full> {
        // The table and the queue change together, so their orders agree.
        let mut levels = self.levels.lock().unwrap();
        let Some(event) = levels.supersede(event) else {
            return Ok(());
        };
        let place = self.queue.try_reserve().map_err(|_| Full)?;
        place.send(levels.place(event));
        Ok(())
    }

    /// Waits for a place. Fails when the connection has gone.
    pub(crate) async fn send(&self, event: Event) -> Result<(), Full> {
        let place = self.queue.reserve().await.map_err(|_| Full)?;
        let mut levels = self.levels.lock().unwrap();
        if let Some(event) = levels.supersede(event) {
            place.send(levels.place(event));
        }
        Ok(())
    }
}

#[cfg(test)]
impl Sender {
    /// Measurement only: places taken, the bound, and whether the reader is gone.
    pub(crate) fn depth(&self) -> usize {
        self.queue.max_capacity() - self.queue.capacity()
    }
    pub(crate) fn bound(&self) -> usize {
        self.queue.max_capacity()
    }
    pub(crate) fn gone(&self) -> bool {
        self.queue.is_closed()
    }
}

impl Receiver {
    pub(crate) async fn recv(&mut self) -> Option<Event> {
        let item = self.queue.recv().await?;
        Some(self.event(item))
    }

    pub(crate) fn try_recv(&mut self) -> Option<Event> {
        let item = self.queue.try_recv().ok()?;
        Some(self.event(item))
    }

    fn event(&self, item: Item) -> Event {
        match item {
            Item::Edge(event) => event,
            Item::Level(slot) => self.levels.lock().unwrap().take(slot),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use piik_channel_core::{
        host::{HostAction, HostInput},
        wire::HostingMode,
    };
    use uuid::Uuid;

    fn input(room: &str, revision: u64, action: HostAction) -> Event {
        Event::HostInput {
            room_id: room.into(),
            input: HostInput {
                hosting_mode: HostingMode::Hosted,
                channel_owner_id: Uuid::nil(),
                now: 0,
                binding_id: Uuid::nil(),
                host_session_id: Uuid::nil(),
                revision,
                failed_pairs: Vec::new(),
                confirmed_pairs: Default::default(),
                disconnected_pairs: Default::default(),
                endpoints: Default::default(),
                service_endpoint: None,
                action,
            },
        }
    }
    fn sync(room: &str, revision: u64) -> Event {
        input(room, revision, HostAction::Sync)
    }
    fn ack(id: &str) -> Event {
        Event::Ack {
            request_id: id.into(),
        }
    }
    /// What the connection would be sent, as (room or request, revision).
    fn drain(receiver: &mut Receiver) -> Vec<(String, u64)> {
        std::iter::from_fn(|| receiver.try_recv())
            .map(|event| match event {
                Event::HostInput { room_id, input } => (room_id, input.revision),
                Event::Ack { request_id } => (request_id, 0),
                _ => unreachable!(),
            })
            .collect()
    }

    #[test]
    fn a_burst_of_levels_leaves_one_for_each_subject_where_the_first_stood() {
        let (sender, mut receiver) = channel(4);
        // Thirty admissions, each telling the hosts of two rooms everything again.
        for revision in 1..=30 {
            assert!(sender.try_send(sync("a", revision)).is_ok());
            assert!(sender.try_send(sync("b", revision)).is_ok());
        }
        assert_eq!(
            drain(&mut receiver),
            [("a".to_string(), 30), ("b".to_string(), 30)]
        );
    }

    #[test]
    fn an_edge_of_the_same_subject_keeps_the_level_before_it() {
        let (sender, mut receiver) = channel(8);
        for event in [
            sync("a", 2),
            input("a", 3, HostAction::RouteWake),
            sync("a", 4),
            sync("a", 5),
        ] {
            assert!(sender.try_send(event).is_ok());
        }
        // The input before the action was not replaced by the one after it.
        assert_eq!(
            drain(&mut receiver),
            [2, 3, 5].map(|revision| ("a".to_string(), revision))
        );
    }

    #[test]
    fn an_edge_of_another_subject_does_not_hold_a_level() {
        let (sender, mut receiver) = channel(8);
        for event in [sync("a", 1), ack("x"), sync("b", 1), sync("a", 2)] {
            assert!(sender.try_send(event).is_ok());
        }
        assert_eq!(
            drain(&mut receiver),
            [
                ("a".to_string(), 2),
                ("x".to_string(), 0),
                ("b".to_string(), 1)
            ]
        );
    }

    #[test]
    fn a_level_already_sent_is_followed_by_a_new_one() {
        let (sender, mut receiver) = channel(8);
        assert!(sender.try_send(sync("a", 1)).is_ok());
        assert_eq!(drain(&mut receiver), [("a".to_string(), 1)]);
        assert!(sender.try_send(sync("a", 2)).is_ok());
        assert_eq!(drain(&mut receiver), [("a".to_string(), 2)]);
    }

    #[test]
    fn a_full_queue_still_takes_a_level_it_already_holds() {
        let (sender, mut receiver) = channel(2);
        assert!(sender.try_send(sync("a", 1)).is_ok());
        assert!(sender.try_send(ack("x")).is_ok());
        assert!(sender.try_send(ack("y")).is_err());
        assert!(sender.try_send(sync("b", 1)).is_err());
        assert!(sender.try_send(sync("a", 2)).is_ok());
        assert_eq!(
            drain(&mut receiver),
            [("a".to_string(), 2), ("x".to_string(), 0)]
        );
    }

    #[tokio::test]
    async fn a_waiting_send_takes_the_place_a_receive_frees() {
        let (sender, mut receiver) = channel(1);
        assert!(sender.try_send(ack("x")).is_ok());
        let waiting = tokio::spawn({
            let sender = sender.clone();
            async move { sender.send(ack("y")).await.is_ok() }
        });
        assert!(matches!(receiver.recv().await, Some(Event::Ack { request_id }) if request_id == "x"));
        assert!(waiting.await.unwrap());
        assert!(matches!(receiver.recv().await, Some(Event::Ack { request_id }) if request_id == "y"));
    }
}
