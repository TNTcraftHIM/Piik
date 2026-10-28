//! Bounded range delivery on plans installed by the room owner. Adapters own
//! DataChannels and files; this owner shares requests and verifies received bytes.
use crate::file_room::{FileKey, FilePlan};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const FILE_FRAME_BYTES: usize = 8192;
pub const FILE_RANGE_BYTES: usize = 64 * 1024;
pub const FILE_MAX_PENDING_RANGES: usize = 32;
pub const FILE_MAX_RANGE_FRAMES: usize = FILE_RANGE_BYTES / (FILE_FRAME_BYTES / 2) + 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FileControl {
    Pull { key: FileKey, offset: u64 },
    Cancel { key: FileKey, offset: u64 },
    Error { key: FileKey, code: String },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FileEffect {
    SendControl {
        peer: Uuid,
        control: FileControl,
    },
    SendChunk {
        peer: Uuid,
        key: FileKey,
        frame: Vec<u8>,
    },
    Read {
        key: FileKey,
        offset: u64,
        length: usize,
    },
    Write {
        key: FileKey,
        offset: u64,
        bytes: Vec<u8>,
    },
    Complete {
        key: FileKey,
    },
    Failed {
        key: FileKey,
        code: String,
    },
}

#[derive(Deserialize, Serialize)]
struct Header {
    key: FileKey,
    offset: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Supplier {
    Waiting,
    Local,
    Peer(Uuid),
}
struct Range {
    consumers: BTreeSet<Option<Uuid>>,
    supplier: Supplier,
    bytes: Vec<u8>,
}
struct Receiver {
    offset: u64,
    writing: Option<usize>,
    hash: Sha256,
}
struct File {
    plan: FilePlan,
    ranges: BTreeMap<u64, Range>,
}

pub struct FileDelivery {
    session: Uuid,
    files: BTreeMap<FileKey, File>,
    receivers: BTreeMap<FileKey, Receiver>,
    cached: Option<(FileKey, u64, Vec<u8>)>,
}

impl FileDelivery {
    pub fn new(session: Uuid) -> Self {
        Self {
            session,
            files: BTreeMap::new(),
            receivers: BTreeMap::new(),
            cached: None,
        }
    }

    pub fn update(&mut self, plans: Vec<FilePlan>) -> Vec<FileEffect> {
        let mut effects = Vec::new();
        let next: BTreeMap<_, _> = plans
            .into_iter()
            .map(|plan| (plan_key(&plan), plan))
            .collect();
        for key in self
            .files
            .keys()
            .filter(|key| !next.contains_key(*key))
            .cloned()
            .collect::<Vec<_>>()
        {
            effects.extend(self.fail(&key, "attachment_unavailable"));
            self.files.remove(&key);
            if self
                .cached
                .as_ref()
                .is_some_and(|(cached, _, _)| *cached == key)
            {
                self.cached = None;
            }
        }
        for (key, plan) in next {
            let file = self.files.entry(key.clone()).or_insert_with(|| File {
                plan: plan.clone(),
                ranges: BTreeMap::new(),
            });
            let changed = file.plan.upstream != plan.upstream
                || (file.plan.source_id == Some(self.session))
                    != (plan.source_id == Some(self.session));
            let stopped_receiving = file.plan.receiving && !plan.receiving;
            file.plan = plan;
            for (offset, range) in &mut file.ranges {
                range.consumers.retain(|peer| {
                    peer.map_or(file.plan.receiving, |peer| {
                        file.plan.downstream.contains(&peer)
                    })
                });
                if changed || range.consumers.is_empty() {
                    if let Supplier::Peer(peer) = range.supplier {
                        effects.push(FileEffect::SendControl {
                            peer,
                            control: FileControl::Cancel {
                                key: key.clone(),
                                offset: *offset,
                            },
                        });
                    }
                    range.supplier = Supplier::Waiting;
                    range.bytes.clear();
                }
            }
            file.ranges.retain(|_, range| !range.consumers.is_empty());
            if file.plan.source_id.is_none() {
                effects.extend(self.fail(&key, "attachment_unavailable"));
                continue;
            }
            if stopped_receiving && self.receivers.contains_key(&key) {
                effects.extend(self.fail_local(&key, "attachment_unavailable"));
            }
            effects.extend(self.pump(&key));
        }
        effects
    }

    /// The sink exists before starting. Admission may arrive in the next snapshot.
    pub fn start(&mut self, key: FileKey) -> Vec<FileEffect> {
        self.receivers
            .entry(key.clone())
            .or_insert_with(|| Receiver {
                offset: 0,
                writing: None,
                hash: Sha256::new(),
            });
        self.pump(&key)
    }

    pub fn cancel(&mut self, key: &FileKey) -> Vec<FileEffect> {
        self.receivers.remove(key);
        self.remove_consumer(key, None, None)
    }

    pub fn control(&mut self, peer: Uuid, control: FileControl) -> Vec<FileEffect> {
        match control {
            FileControl::Pull { key, offset } => {
                if !self
                    .files
                    .get(&key)
                    .is_some_and(|file| file.plan.downstream.contains(&peer))
                {
                    return Vec::new();
                }
                self.request(&key, offset, Some(peer))
            }
            FileControl::Cancel { key, offset } => {
                self.remove_consumer(&key, Some(peer), Some(offset))
            }
            FileControl::Error { key, code } => {
                if self
                    .files
                    .get(&key)
                    .is_some_and(|file| file.plan.upstream == Some(peer))
                {
                    self.fail(&key, &code)
                } else {
                    Vec::new()
                }
            }
        }
    }

    pub fn chunk(&mut self, peer: Uuid, frame: &[u8]) -> Result<Vec<FileEffect>, &'static str> {
        let (header, bytes) = decode_frame(frame)?;
        let Some(file) = self.files.get_mut(&header.key) else {
            return Ok(Vec::new());
        };
        if file.plan.upstream != Some(peer) {
            return Ok(Vec::new());
        }
        let offset = header.offset / FILE_RANGE_BYTES as u64 * FILE_RANGE_BYTES as u64;
        let Some(range) = file.ranges.get_mut(&offset) else {
            return Ok(Vec::new());
        };
        if range.supplier != Supplier::Peer(peer) {
            return Ok(Vec::new());
        }
        let length = range_length(&file.plan, offset);
        if header.offset != offset + range.bytes.len() as u64
            || bytes.is_empty()
            || range.bytes.len() + bytes.len() > length
        {
            return Ok(self.fail(&header.key, "invalid_file_range"));
        }
        range.bytes.extend_from_slice(bytes);
        if range.bytes.len() == length {
            let bytes = std::mem::take(&mut range.bytes);
            Ok(self.deliver(&header.key, offset, bytes))
        } else {
            Ok(Vec::new())
        }
    }

    pub fn read_result(&mut self, key: &FileKey, offset: u64, bytes: Vec<u8>) -> Vec<FileEffect> {
        let Some(file) = self.files.get(key) else {
            return Vec::new();
        };
        if !file
            .ranges
            .get(&offset)
            .is_some_and(|range| range.supplier == Supplier::Local)
        {
            return Vec::new();
        }
        if bytes.len() != range_length(&file.plan, offset) {
            return self.fail(key, "invalid_file_range");
        }
        self.deliver(key, offset, bytes)
    }

    pub fn written(&mut self, key: &FileKey, offset: u64, length: usize) -> Vec<FileEffect> {
        let Some(receiver) = self.receivers.get_mut(key) else {
            return Vec::new();
        };
        if receiver.offset != offset || receiver.writing != Some(length) {
            return Vec::new();
        }
        receiver.offset += length as u64;
        receiver.writing = None;
        self.pump(key)
    }

    pub fn fail(&mut self, key: &FileKey, code: &str) -> Vec<FileEffect> {
        if self
            .cached
            .as_ref()
            .is_some_and(|(cached, _, _)| cached == key)
        {
            self.cached = None;
        }
        let mut effects = Vec::new();
        if let Some(file) = self.files.get_mut(key) {
            let mut consumers = BTreeSet::new();
            for (offset, range) in std::mem::take(&mut file.ranges) {
                consumers.extend(range.consumers.into_iter().flatten());
                if let Supplier::Peer(peer) = range.supplier {
                    effects.push(FileEffect::SendControl {
                        peer,
                        control: FileControl::Cancel {
                            key: key.clone(),
                            offset,
                        },
                    });
                }
            }
            effects.extend(consumers.into_iter().map(|peer| FileEffect::SendControl {
                peer,
                control: FileControl::Error {
                    key: key.clone(),
                    code: code.into(),
                },
            }));
        }
        effects.extend(self.fail_local(key, code));
        effects
    }

    /// A retired pair loses its partial range, not the local download or hash.
    /// The next authorized room plan supplies its replacement path.
    pub fn peer_unavailable(&mut self, peer: Uuid) -> Vec<FileEffect> {
        let keys: Vec<_> = self.files.keys().cloned().collect();
        let mut effects = Vec::new();
        for key in keys {
            effects.extend(self.remove_consumer(&key, Some(peer), None));
            let file = self.files.get_mut(&key).unwrap();
            if file.plan.upstream == Some(peer) {
                file.plan.upstream = None;
                for range in file.ranges.values_mut() {
                    range.supplier = Supplier::Waiting;
                    range.bytes.clear();
                }
            }
        }
        effects
    }

    pub fn peer_failed(&mut self, key: &FileKey, peer: Uuid, code: &str) -> Vec<FileEffect> {
        let Some(file) = self.files.get(key) else {
            return Vec::new();
        };
        if file.plan.upstream == Some(peer) {
            return self.fail(key, code);
        }
        let mut effects = self.remove_consumer(key, Some(peer), None);
        effects.push(FileEffect::SendControl {
            peer,
            control: FileControl::Error {
                key: key.clone(),
                code: code.into(),
            },
        });
        effects
    }

    fn fail_local(&mut self, key: &FileKey, code: &str) -> Vec<FileEffect> {
        let active = self.receivers.remove(key).is_some();
        let mut effects = self.remove_consumer(key, None, None);
        if active {
            effects.push(FileEffect::Failed {
                key: key.clone(),
                code: code.into(),
            });
        }
        effects
    }

    fn remove_consumer(
        &mut self,
        key: &FileKey,
        peer: Option<Uuid>,
        offset: Option<u64>,
    ) -> Vec<FileEffect> {
        let Some(file) = self.files.get_mut(key) else {
            return Vec::new();
        };
        let mut effects = Vec::new();
        file.ranges.retain(|range_offset, range| {
            if offset.is_none_or(|offset| offset == *range_offset) {
                range.consumers.remove(&peer);
            }
            if !range.consumers.is_empty() {
                return true;
            }
            if let Supplier::Peer(upstream) = range.supplier {
                effects.push(FileEffect::SendControl {
                    peer: upstream,
                    control: FileControl::Cancel {
                        key: key.clone(),
                        offset: *range_offset,
                    },
                });
            }
            false
        });
        effects
    }

    fn pump(&mut self, key: &FileKey) -> Vec<FileEffect> {
        let mut effects = Vec::new();
        if let (Some(file), Some(receiver)) = (self.files.get(key), self.receivers.get(key)) {
            if file.plan.receiving && receiver.writing.is_none() {
                if receiver.offset == file.plan.attachment.size {
                    let expected = file.plan.attachment.sha256.clone();
                    let actual =
                        format!("{:x}", self.receivers.remove(key).unwrap().hash.finalize());
                    if !actual.eq_ignore_ascii_case(&expected) {
                        self.cached = None;
                    }
                    effects.push(if actual.eq_ignore_ascii_case(&expected) {
                        FileEffect::Complete { key: key.clone() }
                    } else {
                        FileEffect::Failed {
                            key: key.clone(),
                            code: "attachment_hash_mismatch".into(),
                        }
                    });
                } else {
                    effects.extend(self.request(key, receiver.offset, None));
                }
            }
        }
        effects.extend(self.dispatch(key));
        effects
    }

    fn dispatch(&mut self, key: &FileKey) -> Vec<FileEffect> {
        let Some(file) = self.files.get_mut(key) else {
            return Vec::new();
        };
        let mut effects = Vec::new();
        for (offset, range) in &mut file.ranges {
            if range.supplier != Supplier::Waiting {
                continue;
            }
            if file.plan.source_id == Some(self.session) {
                range.supplier = Supplier::Local;
                effects.push(FileEffect::Read {
                    key: key.clone(),
                    offset: *offset,
                    length: range_length(&file.plan, *offset),
                });
            } else if let Some(peer) = file.plan.upstream {
                range.supplier = Supplier::Peer(peer);
                effects.push(FileEffect::SendControl {
                    peer,
                    control: FileControl::Pull {
                        key: key.clone(),
                        offset: *offset,
                    },
                });
            }
        }
        effects
    }

    fn request(&mut self, key: &FileKey, offset: u64, consumer: Option<Uuid>) -> Vec<FileEffect> {
        let count: usize = self.files.values().map(|file| file.ranges.len()).sum();
        let Some(file) = self.files.get_mut(key) else {
            return Vec::new();
        };
        let code = if offset >= file.plan.attachment.size || offset % FILE_RANGE_BYTES as u64 != 0 {
            Some("invalid_file_range")
        } else if file
            .ranges
            .iter()
            .any(|(other, range)| *other != offset && range.consumers.contains(&consumer))
        {
            Some("file_range_pending")
        } else if count >= FILE_MAX_PENDING_RANGES && !file.ranges.contains_key(&offset) {
            Some("file_transfer_busy")
        } else {
            None
        };
        if let Some(code) = code {
            return if let Some(peer) = consumer {
                vec![FileEffect::SendControl {
                    peer,
                    control: FileControl::Error {
                        key: key.clone(),
                        code: code.into(),
                    },
                }]
            } else {
                self.fail_local(key, code)
            };
        }
        file.ranges
            .entry(offset)
            .or_insert_with(|| Range {
                consumers: BTreeSet::new(),
                supplier: Supplier::Waiting,
                bytes: Vec::new(),
            })
            .consumers
            .insert(consumer);
        if let Some((cached_key, cached_offset, bytes)) = &self.cached {
            if cached_key == key && *cached_offset == offset {
                return self.deliver(key, offset, bytes.clone());
            }
        }
        self.dispatch(key)
    }

    fn deliver(&mut self, key: &FileKey, offset: u64, bytes: Vec<u8>) -> Vec<FileEffect> {
        let Some(range) = self
            .files
            .get_mut(key)
            .and_then(|file| file.ranges.remove(&offset))
        else {
            return Vec::new();
        };
        let mut effects = Vec::new();
        for consumer in range.consumers {
            if let Some(peer) = consumer {
                let mut position = 0;
                while position < bytes.len() {
                    let header = serde_json::to_vec(&Header {
                        key: key.clone(),
                        offset: offset + position as u64,
                    })
                    .unwrap();
                    let length = (FILE_FRAME_BYTES - 2 - header.len()).min(bytes.len() - position);
                    let mut frame = Vec::with_capacity(2 + header.len() + length);
                    frame.extend_from_slice(&(header.len() as u16).to_be_bytes());
                    frame.extend_from_slice(&header);
                    frame.extend_from_slice(&bytes[position..position + length]);
                    effects.push(FileEffect::SendChunk {
                        peer,
                        key: key.clone(),
                        frame,
                    });
                    position += length;
                }
            } else if let Some(receiver) = self.receivers.get_mut(key) {
                if receiver.offset == offset && receiver.writing.is_none() {
                    receiver.hash.update(&bytes);
                    receiver.writing = Some(bytes.len());
                    effects.push(FileEffect::Write {
                        key: key.clone(),
                        offset,
                        bytes: bytes.clone(),
                    });
                }
            }
        }
        self.cached = Some((key.clone(), offset, bytes));
        effects
    }
}

fn plan_key(plan: &FilePlan) -> FileKey {
    FileKey {
        room_id: plan.room_id.clone(),
        message_seq: plan.message_seq,
        attachment_id: plan.attachment.id,
    }
}
fn range_length(plan: &FilePlan, offset: u64) -> usize {
    (plan.attachment.size - offset).min(FILE_RANGE_BYTES as u64) as usize
}
fn decode_frame(frame: &[u8]) -> Result<(Header, &[u8]), &'static str> {
    if frame.len() < 3 || frame.len() > FILE_FRAME_BYTES {
        return Err("invalid_file_frame");
    }
    let header_length = u16::from_be_bytes([frame[0], frame[1]]) as usize;
    if header_length > FILE_FRAME_BYTES / 2 || 2 + header_length >= frame.len() {
        return Err("invalid_file_frame");
    }
    let header =
        serde_json::from_slice(&frame[2..2 + header_length]).map_err(|_| "invalid_file_frame")?;
    Ok((header, &frame[2 + header_length..]))
}
