//! Transient media reads on the room's existing base tree. No attachment or cache semantics.
use crate::wire::WatchByteSource;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const WATCH_FRAME_BYTES: usize = crate::file_delivery::FILE_FRAME_BYTES;
// One read holds at most 64 KiB; 32 reads bound aggregate response storage to 2 MiB.
pub const WATCH_WINDOW_BYTES: usize = 64 * 1024;
pub const WATCH_MAX_PENDING: usize = 32;
// File frames start with their nonzero two-byte JSON header length. This reserved
// zero prefix distinguishes Watch frames before either payload decoder is called.
const PREFIX: [u8; 2] = [0, 0];

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchBytePlan {
    pub room_id: String,
    pub activity_id: Uuid,
    pub source: WatchByteSource,
    pub upstream: Option<Uuid>,
    pub downstream: Vec<Uuid>,
    pub receiving: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchKey {
    pub room_id: String,
    pub activity_id: Uuid,
    pub resource_id: Uuid,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WatchControl {
    Pull {
        key: WatchKey,
        request_id: Uuid,
        offset: u64,
        length: usize,
    },
    Cancel {
        key: WatchKey,
        request_id: Uuid,
    },
    Error {
        key: WatchKey,
        request_id: Uuid,
        code: String,
    },
}
impl WatchControl {
    pub fn key(&self) -> &WatchKey {
        match self {
            Self::Pull { key, .. } | Self::Cancel { key, .. } | Self::Error { key, .. } => key,
        }
    }
    pub fn request_id(&self) -> Uuid {
        match self {
            Self::Pull { request_id, .. }
            | Self::Cancel { request_id, .. }
            | Self::Error { request_id, .. } => *request_id,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchReadResult {
    pub mime_type: String,
    pub total_size: Option<u64>,
    pub bytes: Vec<u8>,
    pub eof: bool,
}
#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WatchEffect {
    Read {
        key: WatchKey,
        request_id: Uuid,
        offset: u64,
        length: usize,
    },
    CancelRead {
        request_id: Uuid,
    },
    SendControl {
        peer: Uuid,
        control: WatchControl,
    },
    SendChunk {
        peer: Uuid,
        key: WatchKey,
        request_id: Uuid,
        frame: Vec<u8>,
    },
    Received {
        request_id: Uuid,
        result: WatchReadResult,
    },
    Failed {
        request_id: Uuid,
        code: String,
    },
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    request_id: Uuid,
    offset: u64,
    mime_type: String,
    total_size: Option<u64>,
    length: usize,
    eof: bool,
}
struct Pending {
    key: WatchKey,
    source: WatchByteSource,
    offset: u64,
    length: usize,
    consumer: Option<Uuid>,
    supplier: Option<Uuid>,
    response: Option<(WatchReadResult, usize)>,
}
struct Deferred {
    peer: Uuid,
    key: WatchKey,
    offset: u64,
    length: usize,
    source: Option<WatchByteSource>,
}
pub struct WatchDelivery {
    session: Uuid,
    plans: BTreeMap<(String, Uuid), WatchBytePlan>,
    pending: BTreeMap<Uuid, Pending>,
    deferred: BTreeMap<Uuid, Deferred>,
    room_peers: BTreeMap<Uuid, BTreeSet<String>>,
}

pub fn is_watch_frame(bytes: &[u8]) -> bool {
    bytes.starts_with(&PREFIX)
}

impl WatchDelivery {
    pub fn new(session: Uuid) -> Self {
        Self {
            session,
            plans: BTreeMap::new(),
            pending: BTreeMap::new(),
            deferred: BTreeMap::new(),
            room_peers: BTreeMap::new(),
        }
    }
    pub fn update(
        &mut self,
        plans: Vec<WatchBytePlan>,
        room_peers: Vec<(Uuid, Vec<String>)>,
    ) -> Vec<WatchEffect> {
        self.room_peers = room_peers
            .into_iter()
            .map(|(peer, rooms)| (peer, rooms.into_iter().collect()))
            .collect();
        self.plans = plans
            .into_iter()
            .map(|p| ((p.room_id.clone(), p.activity_id), p))
            .collect();
        let retired: Vec<_> = self
            .pending
            .iter()
            .filter_map(|(id, p)| {
                if p.consumer.into_iter().chain(p.supplier).any(|peer| {
                    !self
                        .room_peers
                        .get(&peer)
                        .is_some_and(|rooms| rooms.contains(&p.key.room_id))
                }) {
                    return Some((*id, "watch_path_unavailable"));
                }
                let plan = self.plans.get(&(p.key.room_id.clone(), p.key.activity_id));
                let code = match plan {
                    None => Some("watch_source_changed"),
                    Some(plan) if plan.source != p.source => Some("watch_source_changed"),
                    Some(plan) if plan.upstream != p.supplier => Some("watch_path_unavailable"),
                    Some(plan)
                        if !p
                            .consumer
                            .map_or(plan.receiving, |peer| plan.downstream.contains(&peer)) =>
                    {
                        Some("watch_path_unavailable")
                    }
                    _ => None,
                };
                code.map(|code| (*id, code))
            })
            .collect();
        let mut effects: Vec<_> = retired
            .into_iter()
            .flat_map(|(id, code)| self.stop(id, code, true))
            .collect();
        let retired: Vec<_> = self
            .deferred
            .iter()
            .filter_map(|(id, p)| {
                if !self
                    .room_peers
                    .get(&p.peer)
                    .is_some_and(|rooms| rooms.contains(&p.key.room_id))
                {
                    return Some((*id, "watch_path_unavailable"));
                }
                p.source
                    .as_ref()
                    .filter(|source| {
                        !self
                            .plans
                            .get(&(p.key.room_id.clone(), p.key.activity_id))
                            .is_some_and(|plan| &plan.source == *source)
                    })
                    .map(|_| (*id, "watch_source_changed"))
            })
            .collect();
        for (id, code) in retired {
            effects.extend(self.stop(id, code, true));
        }
        let ready: Vec<_> = self
            .deferred
            .iter()
            .filter_map(|(id, p)| {
                self.plans
                    .get(&(p.key.room_id.clone(), p.key.activity_id))
                    .is_some_and(|plan| {
                        plan.downstream.contains(&p.peer)
                            && (plan.source.session_id == self.session || plan.upstream.is_some())
                    })
                    .then_some(*id)
            })
            .collect();
        for id in ready {
            let p = self.deferred.remove(&id).unwrap();
            effects.extend(self.pull(Some(p.peer), p.key, id, p.offset, p.length));
        }
        effects
    }
    pub fn read(
        &mut self,
        key: WatchKey,
        request_id: Uuid,
        offset: u64,
        length: usize,
    ) -> Vec<WatchEffect> {
        self.pull(None, key, request_id, offset, length)
    }
    pub fn cancel(&mut self, request_id: Uuid) -> Vec<WatchEffect> {
        self.stop(request_id, "watch_read_cancelled", false)
    }
    pub fn request_failed(&mut self, request_id: Uuid, code: &str) -> Vec<WatchEffect> {
        let code = match code {
            "watch_path_unavailable" => "watch_path_unavailable",
            "watch_read_busy" => "watch_read_busy",
            "watch_source_changed" => "watch_source_changed",
            _ => "watch_source_failed",
        };
        self.stop(request_id, code, true)
    }
    pub fn peer_closed(&mut self, peer: Uuid) -> Vec<WatchEffect> {
        let ids: Vec<_> = self
            .pending
            .iter()
            .filter_map(|(id, p)| {
                (p.consumer == Some(peer) || p.supplier == Some(peer)).then_some(*id)
            })
            .chain(
                self.deferred
                    .iter()
                    .filter_map(|(id, p)| (p.peer == peer).then_some(*id)),
            )
            .collect();
        ids.into_iter()
            .flat_map(|id| self.stop(id, "watch_path_unavailable", true))
            .collect()
    }
    fn pull(
        &mut self,
        consumer: Option<Uuid>,
        key: WatchKey,
        request_id: Uuid,
        offset: u64,
        length: usize,
    ) -> Vec<WatchEffect> {
        let reject = |code: &str| match consumer {
            Some(peer) => vec![WatchEffect::SendControl {
                peer,
                control: WatchControl::Error {
                    key: key.clone(),
                    request_id,
                    code: code.into(),
                },
            }],
            None => vec![WatchEffect::Failed {
                request_id,
                code: code.into(),
            }],
        };
        if consumer.is_some_and(|peer| {
            !self
                .room_peers
                .get(&peer)
                .is_some_and(|rooms| rooms.contains(&key.room_id))
        }) {
            return vec![];
        }
        if length == 0 || length > WATCH_WINDOW_BYTES || offset.checked_add(length as u64).is_none()
        {
            return reject("invalid_watch_range");
        }
        if self.pending.len() + self.deferred.len() >= WATCH_MAX_PENDING
            || self.pending.contains_key(&request_id)
            || self.deferred.contains_key(&request_id)
        {
            return reject("watch_read_busy");
        }
        let plan = self.plans.get(&(key.room_id.clone(), key.activity_id));
        if let Some(peer) = consumer {
            if !plan.is_some_and(|plan| {
                plan.downstream.contains(&peer)
                    && (plan.source.session_id == self.session || plan.upstream.is_some())
            }) {
                self.deferred.insert(
                    request_id,
                    Deferred {
                        peer,
                        key,
                        offset,
                        length,
                        source: plan.map(|plan| plan.source.clone()),
                    },
                );
                return vec![];
            }
        }
        let Some(plan) = plan else {
            return reject("watch_path_unavailable");
        };
        if !consumer.map_or(plan.receiving, |peer| plan.downstream.contains(&peer)) {
            return reject("watch_read_forbidden");
        }
        let supplier = if plan.source.session_id == self.session {
            None
        } else {
            let Some(upstream) = plan.upstream else {
                return reject("watch_path_unavailable");
            };
            Some(upstream)
        };
        self.pending.insert(
            request_id,
            Pending {
                key: key.clone(),
                source: plan.source.clone(),
                offset,
                length,
                consumer,
                supplier,
                response: None,
            },
        );
        match supplier {
            Some(peer) => vec![WatchEffect::SendControl {
                peer,
                control: WatchControl::Pull {
                    key,
                    request_id,
                    offset,
                    length,
                },
            }],
            None => vec![WatchEffect::Read {
                key,
                request_id,
                offset,
                length,
            }],
        }
    }
    pub fn control(&mut self, peer: Uuid, control: WatchControl) -> Vec<WatchEffect> {
        if let WatchControl::Pull {
            key,
            request_id,
            offset,
            length,
        } = control
        {
            return self.pull(Some(peer), key, request_id, offset, length);
        }
        let id = control.request_id();
        if matches!(&control, WatchControl::Cancel { key, .. } if self.deferred.get(&id).is_some_and(|p| p.peer == peer && &p.key == key))
        {
            return self.stop(id, "watch_read_cancelled", false);
        }
        let Some(pending) = self
            .pending
            .get_mut(&id)
            .filter(|p| &p.key == control.key())
        else {
            return vec![];
        };
        match control {
            WatchControl::Cancel { .. } if pending.consumer == Some(peer) => {
                self.stop(id, "watch_read_cancelled", false)
            }
            WatchControl::Error { code, .. } if pending.supplier == Some(peer) => {
                let code = match code.as_str() {
                    "watch_path_unavailable" => "watch_path_unavailable",
                    "watch_read_busy" => "watch_read_busy",
                    _ => "watch_source_failed",
                };
                self.stop(id, code, true)
            }
            _ => vec![],
        }
    }
    pub fn chunk(&mut self, peer: Uuid, frame: &[u8]) -> Result<Vec<WatchEffect>, &'static str> {
        if !is_watch_frame(frame) || frame.len() < 5 || frame.len() > WATCH_FRAME_BYTES {
            return Err("invalid_watch_frame");
        }
        let len = u16::from_be_bytes([frame[2], frame[3]]) as usize;
        if len > WATCH_FRAME_BYTES / 2 || 4 + len > frame.len() {
            return Err("invalid_watch_frame");
        }
        let header: Header =
            serde_json::from_slice(&frame[4..4 + len]).map_err(|_| "invalid_watch_frame")?;
        let Some(pending) = self
            .pending
            .get_mut(&header.request_id)
            .filter(|p| p.supplier == Some(peer))
        else {
            return Ok(vec![]);
        };
        if !valid_response(
            pending,
            &header.mime_type,
            header.total_size,
            header.length,
            header.eof,
        ) {
            return Ok(self.stop(header.request_id, "invalid_watch_response", true));
        }
        let (result, length) = pending.response.get_or_insert_with(|| {
            (
                WatchReadResult {
                    mime_type: header.mime_type.clone(),
                    total_size: header.total_size,
                    bytes: Vec::with_capacity(header.length),
                    eof: header.eof,
                },
                header.length,
            )
        });
        if result.mime_type != header.mime_type
            || result.total_size != header.total_size
            || *length != header.length
            || result.eof != header.eof
        {
            return Ok(self.stop(header.request_id, "invalid_watch_response", true));
        }
        let bytes = &frame[4 + len..];
        if header.offset != pending.offset + result.bytes.len() as u64
            || result.bytes.len() + bytes.len() > *length
        {
            return Ok(self.stop(header.request_id, "invalid_watch_response", true));
        }
        result.bytes.extend_from_slice(bytes);
        if result.bytes.len() == *length {
            let result = pending.response.take().unwrap().0;
            Ok(self.finish(header.request_id, result))
        } else {
            Ok(vec![])
        }
    }
    pub fn read_result(
        &mut self,
        request_id: Uuid,
        result: Result<WatchReadResult, String>,
    ) -> Vec<WatchEffect> {
        let Some(pending) = self
            .pending
            .get(&request_id)
            .filter(|p| p.supplier.is_none())
        else {
            return vec![];
        };
        let Ok(result) = result else {
            return self.stop(request_id, "watch_source_failed", true);
        };
        if !valid_response(
            pending,
            &result.mime_type,
            result.total_size,
            result.bytes.len(),
            result.eof,
        ) {
            return self.stop(request_id, "invalid_watch_response", true);
        }
        self.finish(request_id, result)
    }
    fn finish(&mut self, request_id: Uuid, result: WatchReadResult) -> Vec<WatchEffect> {
        let Some(pending) = self.pending.remove(&request_id) else {
            return vec![];
        };
        let Some(peer) = pending.consumer else {
            return vec![WatchEffect::Received { request_id, result }];
        };
        let mut effects = Vec::new();
        let mut position = 0;
        loop {
            let header = serde_json::to_vec(&Header {
                request_id,
                offset: pending.offset + position as u64,
                mime_type: result.mime_type.clone(),
                total_size: result.total_size,
                length: result.bytes.len(),
                eof: result.eof,
            })
            .unwrap();
            let length = (WATCH_FRAME_BYTES - 4 - header.len()).min(result.bytes.len() - position);
            let mut frame = Vec::with_capacity(4 + header.len() + length);
            frame.extend_from_slice(&PREFIX);
            frame.extend_from_slice(&(header.len() as u16).to_be_bytes());
            frame.extend_from_slice(&header);
            frame.extend_from_slice(&result.bytes[position..position + length]);
            effects.push(WatchEffect::SendChunk {
                peer,
                key: pending.key.clone(),
                request_id,
                frame,
            });
            position += length;
            if position == result.bytes.len() {
                break;
            }
        }
        effects
    }
    fn stop(&mut self, request_id: Uuid, code: &str, notify: bool) -> Vec<WatchEffect> {
        if let Some(pending) = self.deferred.remove(&request_id) {
            return if notify {
                vec![WatchEffect::SendControl {
                    peer: pending.peer,
                    control: WatchControl::Error {
                        key: pending.key,
                        request_id,
                        code: code.into(),
                    },
                }]
            } else {
                vec![]
            };
        }
        let Some(pending) = self.pending.remove(&request_id) else {
            return vec![];
        };
        let mut effects = match pending.supplier {
            Some(peer) => vec![WatchEffect::SendControl {
                peer,
                control: WatchControl::Cancel {
                    key: pending.key.clone(),
                    request_id,
                },
            }],
            None => vec![WatchEffect::CancelRead { request_id }],
        };
        if notify {
            effects.push(match pending.consumer {
                Some(peer) => WatchEffect::SendControl {
                    peer,
                    control: WatchControl::Error {
                        key: pending.key,
                        request_id,
                        code: code.into(),
                    },
                },
                None => WatchEffect::Failed {
                    request_id,
                    code: code.into(),
                },
            });
        }
        effects
    }
}
fn valid_response(
    pending: &Pending,
    mime: &str,
    total: Option<u64>,
    length: usize,
    eof: bool,
) -> bool {
    let Some(end) = pending.offset.checked_add(length as u64) else {
        return false;
    };
    !mime.is_empty()
        && mime.len() <= 128
        && mime.bytes().all(|b| b >= 32 && b < 127)
        && length <= pending.length
        && (length == pending.length || eof)
        && total.is_none_or(|size| end <= size && eof == (end == size))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::WatchFormat;
    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }
    fn plan(upstream: Option<Uuid>, downstream: Vec<Uuid>, receiving: bool) -> WatchBytePlan {
        WatchBytePlan {
            room_id: "room".into(),
            activity_id: id(10),
            source: WatchByteSource {
                session_id: id(1),
                resource_id: id(11),
                format: WatchFormat::File,
            },
            upstream,
            downstream,
            receiving,
        }
    }
    fn peers() -> Vec<(Uuid, Vec<String>)> {
        (1..=3)
            .map(|peer| (id(peer), vec!["room".into()]))
            .collect()
    }
    fn key() -> WatchKey {
        WatchKey {
            room_id: "room".into(),
            activity_id: id(10),
            resource_id: id(12),
        }
    }
    fn control(effects: Vec<WatchEffect>) -> WatchControl {
        effects
            .into_iter()
            .find_map(|effect| {
                if let WatchEffect::SendControl { control, .. } = effect {
                    Some(control)
                } else {
                    None
                }
            })
            .unwrap()
    }
    #[test]
    fn unaligned_window_crosses_transit_and_keeps_frames_bounded() {
        let mut source = WatchDelivery::new(id(1));
        let mut relay = WatchDelivery::new(id(2));
        let mut viewer = WatchDelivery::new(id(3));
        source.update(vec![], peers());
        relay.update(vec![plan(Some(id(1)), vec![id(3)], false)], peers());
        viewer.update(vec![plan(Some(id(2)), vec![], true)], peers());
        let request = id(20);
        let offset = 7;
        let pull = control(viewer.read(key(), request, offset, WATCH_WINDOW_BYTES));
        let pull = control(relay.control(id(3), pull));
        assert!(
            source.control(id(2), pull).is_empty(),
            "a room lease may wait but cannot read before its source plan"
        );
        assert!(matches!(
            &source.update(vec![plan(None, vec![id(2)], false)], peers())[0],
            WatchEffect::Read { offset: 7, .. }
        ));
        let bytes: Vec<_> = (0..WATCH_WINDOW_BYTES).map(|i| i as u8).collect();
        let response = source.read_result(
            request,
            Ok(WatchReadResult {
                mime_type: "video/mp4".into(),
                total_size: Some(offset + bytes.len() as u64),
                bytes: bytes.clone(),
                eof: true,
            }),
        );
        let mut forwarded = vec![];
        for effect in response {
            let WatchEffect::SendChunk { frame, .. } = effect else {
                panic!()
            };
            assert!(frame.len() <= WATCH_FRAME_BYTES && is_watch_frame(&frame));
            forwarded.extend(relay.chunk(id(1), &frame).unwrap());
        }
        let mut received = vec![];
        for effect in forwarded {
            let WatchEffect::SendChunk { frame, .. } = effect else {
                panic!()
            };
            received.extend(viewer.chunk(id(2), &frame).unwrap());
        }
        assert!(
            matches!(&received[..], [WatchEffect::Received { request_id, result }] if *request_id == request && result.bytes == bytes && result.eof)
        );
        assert!(source.pending.is_empty() && relay.pending.is_empty() && viewer.pending.is_empty());
    }
    #[test]
    fn recoverable_errors_cross_transit_without_exposing_source_errors() {
        for (failure, expected) in [
            ("watch_path_unavailable", "watch_path_unavailable"),
            ("watch_read_busy", "watch_read_busy"),
            (
                "https://source.invalid/private?grant=secret",
                "watch_source_failed",
            ),
        ] {
            let mut relay = WatchDelivery::new(id(2));
            let mut viewer = WatchDelivery::new(id(3));
            relay.update(vec![plan(Some(id(1)), vec![id(3)], false)], peers());
            viewer.update(vec![plan(Some(id(2)), vec![], true)], peers());
            let request = id(20);
            let pull = control(viewer.read(key(), request, 7, 10));
            relay.control(id(3), pull);
            let response = WatchControl::Error {
                key: key(),
                request_id: request,
                code: failure.into(),
            };
            let response = relay
                .control(id(1), response)
                .into_iter()
                .find_map(|effect| match effect {
                    WatchEffect::SendControl {
                        peer,
                        control: response @ WatchControl::Error { .. },
                    } if peer == id(3) => Some(response),
                    _ => None,
                })
                .unwrap();
            assert!(viewer.control(id(2), response).iter().any(|effect|
                matches!(effect, WatchEffect::Failed { request_id, code } if *request_id == request && code == expected)));
            assert!(relay.pending.is_empty() && viewer.pending.is_empty());
        }
    }
    #[test]
    fn source_replacement_and_cancellation_retire_only_their_reads() {
        let mut source = WatchDelivery::new(id(1));
        source.update(vec![plan(None, vec![id(2)], false)], peers());
        let pull = |request| WatchControl::Pull {
            key: key(),
            request_id: request,
            offset: 0,
            length: 10,
        };
        assert!(source.control(id(9), pull(id(20))).is_empty());
        source.control(id(2), pull(id(20)));
        source.control(id(2), pull(id(21)));
        let cancelled = source.control(
            id(2),
            WatchControl::Cancel {
                key: key(),
                request_id: id(20),
            },
        );
        assert!(
            matches!(&cancelled[..], [WatchEffect::CancelRead { request_id }] if *request_id == id(20))
        );
        assert!(source.pending.contains_key(&id(21)));
        let mut replacement = plan(None, vec![id(2)], false);
        replacement.source.resource_id = id(13);
        assert!(source
            .update(vec![replacement], peers())
            .iter()
            .any(|e| matches!(e, WatchEffect::CancelRead {request_id} if *request_id == id(21))));
        assert!(source.read_result(id(21), Err("late".into())).is_empty());
    }
    #[test]
    fn deferred_pulls_share_capacity_and_retire_without_reading() {
        let mut source = WatchDelivery::new(id(1));
        let pull = |request| WatchControl::Pull {
            key: key(),
            request_id: request,
            offset: 7,
            length: 10,
        };
        assert!(source.control(id(2), pull(id(20))).is_empty());
        assert!(
            source.deferred.is_empty(),
            "unknown peers cannot reserve a waiting slot"
        );
        source.update(vec![], peers());
        for request in 20..20 + WATCH_MAX_PENDING as u128 {
            assert!(source.control(id(2), pull(id(request))).is_empty());
        }
        assert!(
            matches!(&source.control(id(2), pull(id(100)))[0], WatchEffect::SendControl {
            control: WatchControl::Error { code, .. }, ..
        } if code == "watch_read_busy")
        );
        source.control(
            id(3),
            WatchControl::Cancel {
                key: key(),
                request_id: id(20),
            },
        );
        assert_eq!(source.deferred.len(), WATCH_MAX_PENDING);
        source.control(
            id(2),
            WatchControl::Cancel {
                key: key(),
                request_id: id(20),
            },
        );
        assert_eq!(source.deferred.len(), WATCH_MAX_PENDING - 1);
        let local = plan(None, vec![], true);
        source.update(vec![local], peers());
        assert!(matches!(
            &source.read(key(), id(100), 7, 10)[0],
            WatchEffect::Read { .. }
        ));
        assert!(
            matches!(&source.read(key(), id(101), 7, 10)[0], WatchEffect::Failed { code, .. } if code == "watch_read_busy")
        );
        source.peer_closed(id(2));
        assert!(source.deferred.is_empty());
        assert!(
            source.pending.contains_key(&id(100)),
            "another consumer's read remains live"
        );
        source.control(id(2), pull(id(20)));
        let retired = source.update(vec![plan(None, vec![], true)], vec![]);
        assert!(source.deferred.is_empty());
        assert!(!retired
            .iter()
            .any(|effect| matches!(effect, WatchEffect::Read { .. })));
    }
    #[test]
    fn single_request_failure_preserves_siblings_and_route_change_is_recoverable() {
        let mut viewer = WatchDelivery::new(id(3));
        viewer.update(vec![plan(Some(id(2)), vec![], true)], peers());
        viewer.read(key(), id(20), 7, 10);
        viewer.read(key(), id(21), 17, 10);
        let failed = viewer.request_failed(id(20), "watch_path_unavailable");
        assert!(failed
            .iter()
            .any(|e| matches!(e, WatchEffect::Failed { request_id, .. } if *request_id == id(20))));
        assert!(viewer.pending.contains_key(&id(21)));
        let changed = viewer.update(vec![plan(Some(id(1)), vec![], true)], peers());
        assert!(changed.iter().any(|e| matches!(e, WatchEffect::Failed { request_id, code } if *request_id == id(21) && code == "watch_path_unavailable")));
    }
    #[test]
    fn read_bounds_and_empty_eof_have_one_terminal_result() {
        let mut source = WatchDelivery::new(id(1));
        let mut viewer = WatchDelivery::new(id(2));
        source.update(vec![plan(None, vec![id(2)], false)], peers());
        viewer.update(vec![plan(Some(id(1)), vec![], true)], peers());
        assert!(matches!(
            &viewer.read(key(), id(19), u64::MAX, 1)[0],
            WatchEffect::Failed { .. }
        ));
        assert!(matches!(
            &viewer.read(key(), id(19), 0, WATCH_WINDOW_BYTES + 1)[0],
            WatchEffect::Failed { .. }
        ));
        let pull = control(viewer.read(key(), id(20), 10, 1));
        source.control(id(2), pull);
        let response = source.read_result(
            id(20),
            Ok(WatchReadResult {
                mime_type: "video/mp4".into(),
                total_size: Some(10),
                bytes: vec![],
                eof: true,
            }),
        );
        let WatchEffect::SendChunk { frame, .. } = &response[0] else {
            panic!()
        };
        assert!(
            matches!(&viewer.chunk(id(1), frame).unwrap()[..], [WatchEffect::Received { result, .. }] if result.bytes.is_empty() && result.eof)
        );
        for request in 30..30 + WATCH_MAX_PENDING as u128 {
            viewer.read(key(), id(request), 0, 1);
        }
        assert!(
            matches!(&viewer.read(key(), id(100), 0, 1)[0], WatchEffect::Failed { code, .. } if code == "watch_read_busy")
        );
        viewer.peer_closed(id(1));
        assert!(viewer.pending.is_empty());
    }
}
