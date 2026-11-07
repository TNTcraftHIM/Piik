use piik_channel_core::{
    attachment::sha256_hex,
    file_delivery::{FileControl, FileDelivery, FileEffect, FILE_FRAME_BYTES, FILE_RANGE_BYTES},
    file_room::{FileKey, FilePlan},
    AttachmentDescriptor,
};
use std::collections::{BTreeMap, VecDeque};
use uuid::Uuid;

fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
fn room_peers() -> Vec<(Uuid, Vec<String>)> {
    (1..=5)
        .map(|peer| (id(peer), vec!["room".into()]))
        .collect()
}

#[test]
fn first_pull_survives_the_sources_later_plan_without_a_receiver_retry() {
    let mut network = Network::new();
    network.update(1, 1, None, &[], false);
    network.update(2, 1, Some(1), &[], true);
    network.start(2);
    network.run();
    assert!(network.reads.is_empty() && network.complete.is_empty());
    network.update(1, 1, None, &[2], false);
    network.run();
    assert_eq!(network.complete, vec![id(2)]);
    assert_eq!(network.sinks[&id(2)], network.bytes);
}

#[test]
fn pending_pull_uses_room_leases_exact_cancellation_and_its_first_deadline() {
    let bytes = content();
    let mut source = FileDelivery::new(id(1));
    let mut receiver = FileDelivery::new(id(2));
    receiver.update(vec![plan(1, Some(1), &[], true, &bytes)], room_peers(), 0);
    let pull = receiver
        .start(key())
        .into_iter()
        .find_map(|effect| match effect {
            FileEffect::SendControl { control, .. } => Some(control),
            _ => None,
        })
        .unwrap();
    assert!(source.control(id(2), pull.clone(), 0).is_empty());
    assert_eq!(
        source.next_deadline(),
        None,
        "an unleased peer cannot occupy waiting capacity"
    );
    source.update(vec![], room_peers(), 0);
    source.control(id(2), pull.clone(), 10);
    source.control(id(2), pull, 1000);
    assert_eq!(source.next_deadline(), Some(5010));
    let cancel = receiver
        .cancel(&key())
        .into_iter()
        .find_map(|effect| match effect {
            FileEffect::SendControl { control, .. } => Some(control),
            _ => None,
        })
        .unwrap();
    source.control(id(2), cancel.clone(), 1001);
    assert_eq!(source.next_deadline(), None);
    let retry = receiver
        .start(key())
        .into_iter()
        .find_map(|effect| match effect {
            FileEffect::SendControl { control, .. } => Some(control),
            _ => None,
        })
        .unwrap();
    source.control(id(2), retry, 1002);
    source.control(id(2), cancel, 1003);
    assert_eq!(
        source.next_deadline(),
        Some(6002),
        "old cancellation cannot retire the replacement request"
    );
    let expired = source.update(vec![plan(1, None, &[2], false, &bytes)], room_peers(), 6002);
    assert_eq!(
        expired.len(),
        1,
        "a late plan must not start reading expired work"
    );
    let FileEffect::SendControl { control, .. } = expired.into_iter().next().unwrap() else {
        panic!("missing timeout response")
    };
    assert!(receiver
        .control(id(1), control, 6002)
        .iter()
        .any(|effect| matches!(effect,
        FileEffect::Failed { code, .. } if code == "file_route_timeout")));
    assert_eq!(source.next_deadline(), None);
}

#[test]
fn pending_pull_capacity_is_bounded_and_room_lease_retirement_clears_it() {
    let bytes = content();
    let plans: Vec<_> = (0..=32)
        .map(|index| {
            let mut value = plan(1, Some(1), &[], true, &bytes);
            value.message_seq = index + 1;
            value
        })
        .collect();
    let mut source = FileDelivery::new(id(1));
    source.update(vec![], room_peers(), 0);
    let mut receivers = [FileDelivery::new(id(2)), FileDelivery::new(id(3))];
    for receiver in &mut receivers {
        receiver.update(plans.clone(), room_peers(), 0);
    }
    for (index, plan) in plans.iter().enumerate() {
        let key = FileKey {
            room_id: plan.room_id.clone(),
            message_seq: plan.message_seq,
            attachment_id: plan.attachment.id,
        };
        let receiver = if index < 32 { 0 } else { 1 };
        let pull = receivers[receiver]
            .start(key)
            .into_iter()
            .find_map(|effect| match effect {
                FileEffect::SendControl { control, .. } => Some(control),
                _ => None,
            })
            .unwrap();
        let effects = source.control(id(receiver as u128 + 2), pull, 0);
        if index < 32 {
            assert!(effects.is_empty());
        } else {
            assert!(
                matches!(&effects[..], [FileEffect::SendControl { control: FileControl::Error { code, .. }, .. }] if code == "file_transfer_busy")
            );
        }
    }
    assert_eq!(source.next_deadline(), Some(5000));
    assert!(source.update(vec![], vec![], 1).is_empty());
    assert_eq!(source.next_deadline(), None);
    assert!(source.expire(5000).is_empty());
}
fn content() -> Vec<u8> {
    (0..FILE_RANGE_BYTES * 2 + 17)
        .map(|i| (i % 251) as u8)
        .collect()
}
fn key() -> FileKey {
    FileKey {
        room_id: "room".into(),
        message_seq: 7,
        attachment_id: id(99),
    }
}
fn plan(
    source: u128,
    upstream: Option<u128>,
    downstream: &[u128],
    receiving: bool,
    bytes: &[u8],
) -> FilePlan {
    FilePlan {
        room_id: key().room_id,
        message_seq: key().message_seq,
        attachment: AttachmentDescriptor {
            id: key().attachment_id,
            name: "content.bin".into(),
            size: bytes.len() as u64,
            media_type: "application/octet-stream".into(),
            sha256: sha256_hex(bytes),
        },
        source_id: Some(id(source)),
        upstream: upstream.map(id),
        downstream: downstream.iter().copied().map(id).collect(),
        receiving,
    }
}
/// Runs the actual effects across peer identities; reads and sink acknowledgements
/// remain adapter operations, so a stalled sink does not masquerade as progress.
struct Network {
    nodes: BTreeMap<Uuid, FileDelivery>,
    queue: VecDeque<(Uuid, FileEffect)>,
    bytes: Vec<u8>,
    sinks: BTreeMap<Uuid, Vec<u8>>,
    reads: BTreeMap<(Uuid, u64), usize>,
    complete: Vec<Uuid>,
    failed: Vec<(Uuid, String)>,
    hold_write: Option<Uuid>,
    pending_writes: Vec<(Uuid, FileKey, u64, usize)>,
    corrupt: Option<Uuid>,
    pause_chunk: Option<Uuid>,
    hold_read: Option<Uuid>,
    pending_reads: Vec<(Uuid, FileKey, u64, Uuid, usize)>,
}
impl Network {
    fn new() -> Self {
        Self {
            nodes: (1..=5).map(|n| (id(n), FileDelivery::new(id(n)))).collect(),
            queue: VecDeque::new(),
            bytes: content(),
            sinks: BTreeMap::new(),
            reads: BTreeMap::new(),
            complete: vec![],
            failed: vec![],
            hold_write: None,
            pending_writes: vec![],
            corrupt: None,
            pause_chunk: None,
            hold_read: None,
            pending_reads: vec![],
        }
    }
    fn update(
        &mut self,
        node: u128,
        source: u128,
        upstream: Option<u128>,
        downstream: &[u128],
        receiving: bool,
    ) {
        let plan = plan(source, upstream, downstream, receiving, &self.bytes);
        let effects = self
            .nodes
            .get_mut(&id(node))
            .unwrap()
            .update(vec![plan], room_peers(), 0);
        self.push(id(node), effects);
    }
    fn push(&mut self, from: Uuid, effects: Vec<FileEffect>) {
        self.queue
            .extend(effects.into_iter().map(|effect| (from, effect)));
    }
    fn start(&mut self, node: u128) {
        let effects = self.nodes.get_mut(&id(node)).unwrap().start(key());
        self.push(id(node), effects);
    }
    fn read(&mut self, from: Uuid, key: FileKey, offset: u64, request_id: Uuid, length: usize) {
        *self.reads.entry((from, offset)).or_default() += 1;
        let bytes = self.bytes[offset as usize..offset as usize + length].to_vec();
        let effects = self
            .nodes
            .get_mut(&from)
            .unwrap()
            .read_result(&key, offset, request_id, bytes);
        self.push(from, effects);
    }
    fn run(&mut self) {
        let mut turns = 0;
        while let Some((from, effect)) = self.queue.pop_front() {
            if matches!(&effect, FileEffect::SendChunk { peer, .. } if Some(*peer) == self.pause_chunk)
            {
                self.queue.push_front((from, effect));
                return;
            }
            turns += 1;
            assert!(turns < 2000, "delivery did not quiesce");
            match effect {
                FileEffect::SendControl { peer, control } => {
                    // Exercise serialization on the control carrier too.
                    let control: FileControl =
                        serde_json::from_slice(&serde_json::to_vec(&control).unwrap()).unwrap();
                    let effects = self.nodes.get_mut(&peer).unwrap().control(from, control, 0);
                    self.push(peer, effects);
                }
                FileEffect::SendChunk {
                    peer, mut frame, ..
                } => {
                    assert!(frame.len() <= FILE_FRAME_BYTES);
                    if self.corrupt == Some(peer) {
                        *frame.last_mut().unwrap() ^= 1;
                        self.corrupt = None;
                    }
                    let effects = self
                        .nodes
                        .get_mut(&peer)
                        .unwrap()
                        .chunk(from, &frame)
                        .unwrap();
                    self.push(peer, effects);
                }
                FileEffect::Read {
                    key,
                    offset,
                    length,
                    request_id,
                } => {
                    assert!(length <= FILE_RANGE_BYTES);
                    if self.hold_read == Some(from) {
                        self.pending_reads
                            .push((from, key, offset, request_id, length));
                    } else {
                        self.read(from, key, offset, request_id, length);
                    }
                }
                FileEffect::Write { key, offset, bytes } => {
                    let sink = self.sinks.entry(from).or_default();
                    assert_eq!(sink.len() as u64, offset);
                    sink.extend_from_slice(&bytes);
                    if self.hold_write == Some(from) {
                        self.pending_writes.push((from, key, offset, bytes.len()));
                    } else {
                        let effects =
                            self.nodes
                                .get_mut(&from)
                                .unwrap()
                                .written(&key, offset, bytes.len());
                        self.push(from, effects);
                    }
                }
                FileEffect::Complete { .. } => self.complete.push(from),
                FileEffect::Failed { code, .. } => self.failed.push((from, code)),
            }
        }
    }
    fn fanout(&mut self) {
        self.update(1, 1, None, &[2], false);
        self.update(2, 1, Some(1), &[3, 4], false);
        self.update(3, 1, Some(2), &[], true);
        self.update(4, 1, Some(2), &[], true);
    }
}

#[test]
fn one_upstream_copy_serves_two_consumers_and_slow_cancel_does_not_stop_sibling() {
    let mut network = Network::new();
    network.fanout();
    network.hold_write = Some(id(3));
    network.start(3);
    network.start(4);
    network.run();
    assert_eq!(network.sinks[&id(3)].len(), FILE_RANGE_BYTES);
    assert_eq!(network.sinks[&id(4)], network.bytes);
    assert_eq!(network.complete, vec![id(4)]);
    assert!(network.failed.is_empty());
    assert_eq!(
        network.reads.values().sum::<usize>(),
        3,
        "shared range has one real source read"
    );
    assert!(network.reads.values().all(|count| *count == 1));
    let effects = network.nodes.get_mut(&id(3)).unwrap().cancel(&key());
    network.push(id(3), effects);
    for (node, key, offset, length) in std::mem::take(&mut network.pending_writes) {
        let effects = network
            .nodes
            .get_mut(&node)
            .unwrap()
            .written(&key, offset, length);
        network.push(node, effects);
    }
    network.run();
    assert_eq!(network.complete, vec![id(4)]);
}

#[test]
fn corrupted_content_never_completes_even_when_all_ranges_are_written() {
    let mut network = Network::new();
    network.fanout();
    network.corrupt = Some(id(3));
    network.start(3);
    network.start(4);
    network.run();
    assert_eq!(network.sinks[&id(3)].len(), network.bytes.len());
    assert_eq!(
        network.failed,
        vec![(id(3), "attachment_hash_mismatch".into())]
    );
    assert_eq!(network.complete, vec![id(4)]);
    assert_eq!(network.sinks[&id(4)], network.bytes);
}

#[test]
fn authorized_source_and_route_change_preserve_written_prefix_and_ignore_old_source() {
    let mut network = Network::new();
    network.fanout();
    network.pause_chunk = Some(id(3));
    network.start(3);
    network.run();
    assert!(
        network.sinks.is_empty(),
        "old range is actually in flight to the receiver"
    );
    // Changing the holder behind the same relay must preserve valid in-flight bytes.
    network.update(5, 5, None, &[2], false);
    network.update(2, 5, Some(5), &[3], false);
    network.update(3, 5, Some(2), &[], true);
    network.pause_chunk = None;
    network.hold_write = Some(id(3));
    network.run();
    assert_eq!(network.sinks[&id(3)].len(), FILE_RANGE_BYTES);
    network.hold_read = Some(id(5));
    network.hold_write = None;
    for (node, key, offset, length) in std::mem::take(&mut network.pending_writes) {
        let effects = network
            .nodes
            .get_mut(&node)
            .unwrap()
            .written(&key, offset, length);
        network.push(node, effects);
    }
    network.run();
    assert_eq!(network.pending_reads.len(), 1);
    // A real connection loss pauses this prefix; an authorized replacement route resumes it.
    let effects = network
        .nodes
        .get_mut(&id(3))
        .unwrap()
        .peer_unavailable(id(2));
    network.push(id(3), effects);
    let effects = network
        .nodes
        .get_mut(&id(2))
        .unwrap()
        .peer_unavailable(id(5));
    network.push(id(2), effects);
    let effects = network
        .nodes
        .get_mut(&id(2))
        .unwrap()
        .update(vec![], room_peers(), 0);
    network.push(id(2), effects);
    network.update(1, 1, None, &[3], false);
    network.update(3, 1, Some(1), &[], true);
    for (node, key, offset, request_id, length) in std::mem::take(&mut network.pending_reads) {
        network.read(node, key, offset, request_id, length);
    }
    network.run();
    assert_eq!(network.sinks[&id(3)], network.bytes);
    assert_eq!(network.complete, vec![id(3)]);
    assert!(network.failed.is_empty());
    assert_eq!(network.reads[&(id(1), 0)], 1);
    assert!(
        !network.reads.contains_key(&(id(5), 0)),
        "resume never rereads the written prefix"
    );
}

#[test]
fn request_ownership_survives_retry_coalescing_and_late_adapter_results() {
    let bytes = content();
    let mut source = FileDelivery::new(id(1));
    source.update(vec![plan(1, None, &[2, 3], false, &bytes)], room_peers(), 0);
    let (a, b, sibling) = (id(100), id(101), id(102));
    let pull = |request_id| FileControl::Pull {
        key: key(),
        offset: 0,
        request_id,
    };
    let first = source.control(id(2), pull(a), 0);
    let first_read = first
        .iter()
        .find_map(|effect| match effect {
            FileEffect::Read { request_id, .. } => Some(*request_id),
            _ => None,
        })
        .unwrap();
    // Cancelling the only branch retires the exact source read; its late result
    // and failure must not apply to a new read for the same immutable file.
    source.control(
        id(2),
        FileControl::Cancel {
            key: key(),
            offset: 0,
            request_id: a,
        },
        0,
    );
    let retry = source.control(id(2), pull(b), 0);
    let retry_read = retry
        .iter()
        .find_map(|effect| match effect {
            FileEffect::Read { request_id, .. } => Some(*request_id),
            _ => None,
        })
        .unwrap();
    assert_ne!(first_read, retry_read);
    assert!(source
        .read_result(&key(), 0, first_read, bytes[..FILE_RANGE_BYTES].to_vec())
        .is_empty());
    assert!(source
        .request_failed(&key(), first_read, "retired_read")
        .is_empty());
    // A delayed Cancel from the old request cannot remove its replacement.
    assert!(source
        .control(
            id(2),
            FileControl::Cancel {
                key: key(),
                offset: 0,
                request_id: a
            },
            0
        )
        .is_empty());
    assert!(
        source.control(id(3), pull(sibling), 0).is_empty(),
        "shared range must not read a second copy"
    );
    let chunks = source.read_result(&key(), 0, retry_read, bytes[..FILE_RANGE_BYTES].to_vec());
    for (peer, request) in [(id(2), b), (id(3), sibling)] {
        // Inspect the supplier's actual serialized header, without constructing
        // a duplicate frame codec in this test.
        for effect in &chunks {
            if let FileEffect::SendChunk {
                peer: target,
                request_id,
                frame,
                ..
            } = effect
            {
                if *target == peer {
                    assert_eq!(*request_id, request);
                    let length = u16::from_be_bytes([frame[0], frame[1]]) as usize;
                    let header: serde_json::Value =
                        serde_json::from_slice(&frame[2..2 + length]).unwrap();
                    assert_eq!(header["requestId"], request.to_string());
                }
            }
        }
    }
    assert!(chunks.iter().any(|effect| matches!(effect, FileEffect::SendChunk { peer, request_id, .. } if *peer == id(2) && *request_id == b)));
    assert!(chunks.iter().any(|effect| matches!(effect, FileEffect::SendChunk { peer, request_id, .. } if *peer == id(3) && *request_id == sibling)));
}
