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
    pending_reads: Vec<(Uuid, FileKey, u64, usize)>,
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
        let effects = self.nodes.get_mut(&id(node)).unwrap().update(vec![plan]);
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
    fn read(&mut self, from: Uuid, key: FileKey, offset: u64, length: usize) {
        *self.reads.entry((from, offset)).or_default() += 1;
        let bytes = self.bytes[offset as usize..offset as usize + length].to_vec();
        let effects = self
            .nodes
            .get_mut(&from)
            .unwrap()
            .read_result(&key, offset, bytes);
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
                    let effects = self.nodes.get_mut(&peer).unwrap().control(from, control);
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
                } => {
                    assert!(length <= FILE_RANGE_BYTES);
                    if self.hold_read == Some(from) {
                        self.pending_reads.push((from, key, offset, length));
                    } else {
                        self.read(from, key, offset, length);
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
    let effects = network.nodes.get_mut(&id(2)).unwrap().update(vec![]);
    network.push(id(2), effects);
    network.update(1, 1, None, &[3], false);
    network.update(3, 1, Some(1), &[], true);
    for (node, key, offset, length) in std::mem::take(&mut network.pending_reads) {
        network.read(node, key, offset, length);
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
