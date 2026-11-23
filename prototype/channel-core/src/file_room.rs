//! Live complete-copy offers and recipient demand on confirmed room paths.
use crate::{
    attachment::AttachmentDescriptor,
    identity::Endpoint,
    routes::{activity_parents, RelayLimits},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

// Maximum distinct live attachment registrations retained by one room.
// Holders and receivers of the same message attachment share one registration.
pub(crate) const FILE_REGISTRATION_LIMIT: usize = 1000;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileKey {
    pub room_id: String,
    pub message_seq: u64,
    pub attachment_id: Uuid,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub author_id: Uuid,
    pub room_id: String,
    pub message_seq: u64,
    pub attachment: AttachmentDescriptor,
    pub source_id: Option<Uuid>,
    pub upstream: Option<Uuid>,
    pub downstream: Vec<Uuid>,
    pub receiving: bool,
}
#[derive(Clone)]
struct File {
    author_id: Uuid,
    attachment: AttachmentDescriptor,
    holders: BTreeSet<Uuid>,
    receivers: BTreeSet<Uuid>,
    source: Option<Uuid>,
    parents: BTreeMap<Uuid, Uuid>,
    refused: BTreeSet<(Uuid, Uuid)>,
}
impl File {
    fn source_limit(&self, session: Uuid, endpoint: &Endpoint, limits: &RelayLimits) -> usize {
        if endpoint.member.user_id == self.author_id {
            limits.default
        } else {
            limits.overrides.get(&session).copied().unwrap_or(limits.default)
        }
    }
}
#[derive(Clone, Default)]
pub(crate) struct FileRoom {
    files: BTreeMap<(u64, Uuid), File>,
}
impl FileRoom {
    pub fn available(&self, key: &(u64, Uuid), endpoints: &BTreeMap<Uuid, Endpoint>, limits: &RelayLimits) -> bool {
        self.files.get(key).is_some_and(|file| file.holders.iter().any(|id| {
            endpoints.get(id).is_some_and(|endpoint| endpoint.connected && file.source_limit(*id, endpoint, limits) > 0)
        }))
    }

    pub fn install(
        &mut self,
        session: Uuid,
        seq: u64,
        author_id: Uuid,
        attachment: AttachmentDescriptor,
        offer: bool,
    ) -> Result<(), &'static str> {
        let key = (seq, attachment.id);
        if !offer
            && self
                .files
                .get(&key)
                .is_none_or(|file| file.holders.is_empty())
        {
            return Err("attachment_unavailable");
        }
        if !self.files.contains_key(&key) && self.files.len() >= FILE_REGISTRATION_LIMIT {
            return Err("file_sources_full");
        }
        let file = self.files.entry(key).or_insert_with(|| File {
            author_id,
            attachment,
            holders: BTreeSet::new(),
            receivers: BTreeSet::new(),
            source: None,
            parents: BTreeMap::new(),
            refused: BTreeSet::new(),
        });
        if offer {
            file.holders.insert(session);
        } else {
            file.receivers.insert(session);
        }
        Ok(())
    }
    pub fn remove(&mut self, session: Uuid, seq: u64, id: Uuid, offer: bool) {
        if let Some(file) = self.files.get_mut(&(seq, id)) {
            if offer {
                file.holders.remove(&session);
            } else {
                file.receivers.remove(&session);
            }
        }
        self.prune();
    }
    pub fn remove_messages(&mut self, from: u64, through: u64) -> BTreeSet<Uuid> {
        let mut participants = BTreeSet::new();
        for (_, file) in self
            .files
            .extract_if(.., |(seq, _), _| (from..=through).contains(seq))
        {
            participants.extend(file.holders);
            participants.extend(file.receivers);
        }
        participants
    }
    fn prune(&mut self) {
        self.files
            .retain(|_, file| !file.holders.is_empty() || !file.receivers.is_empty());
    }
    pub fn reconcile(&mut self, admitted: &BTreeSet<Uuid>, service: Option<Uuid>) {
        let routable = |id: &Uuid| admitted.contains(id) || service == Some(*id);
        for file in self.files.values_mut() {
            file.holders.retain(|id| admitted.contains(id));
            file.receivers.retain(|id| admitted.contains(id));
            file.refused.retain(|(sender, peer)| {
                !file.receivers.is_empty() && routable(sender) && routable(peer)
            });
            if file
                .source
                .is_none_or(|source| !file.holders.contains(&source))
            {
                file.source = file.holders.first().copied();
                file.parents.clear();
            }
        }
        self.prune();
    }
    pub fn refuse_branch(
        &mut self,
        seq: u64,
        id: Uuid,
        source: Uuid,
        sender: Uuid,
        downstream: Uuid,
    ) -> Result<(), &'static str> {
        let file = self
            .files
            .get_mut(&(seq, id))
            .ok_or("unassigned_file_branch")?;
        if file.source != Some(source) || file.parents.get(&downstream) != Some(&sender) {
            return Err("unassigned_file_branch");
        }
        file.refused.insert((sender, downstream));
        Ok(())
    }
    pub fn reset_routes(&mut self) {
        for file in self.files.values_mut() {
            file.parents.clear();
            file.refused.clear();
        }
    }
    pub fn failed_pair(&mut self, first: Uuid, second: Uuid) {
        for file in self.files.values_mut() {
            for (child, parent) in [(first, second), (second, first)] {
                if file.parents.get(&child) == Some(&parent) {
                    file.parents.remove(&child);
                }
            }
        }
    }
    pub fn forwarding_available(&mut self, sender: Uuid) {
        for file in self.files.values_mut() {
            file.refused.retain(|(from, _)| *from != sender);
        }
    }
    pub fn waiting(&self) -> bool {
        self.files.values().any(|file| {
            file.source.is_some_and(|source| {
                file.receivers
                    .iter()
                    .any(|peer| *peer != source && !file.parents.contains_key(peer))
            })
        })
    }
    pub fn demand(&self) -> BTreeSet<Uuid> {
        self.files
            .values()
            .filter(|file| !file.receivers.is_empty())
            .flat_map(|file| file.source.iter().chain(file.receivers.iter()))
            .copied()
            .collect()
    }
    pub fn route(
        &mut self,
        endpoints: &BTreeMap<Uuid, Endpoint>,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        relays: &BTreeSet<Uuid>,
        limits: &RelayLimits,
    ) {
        for file in self.files.values_mut() {
            let mut selected = None;
            let empty = BTreeMap::new();
            for source in file.source.into_iter().chain(
                file.holders
                    .iter()
                    .copied()
                    .filter(|id| Some(*id) != file.source),
            ) {
                let Some(endpoint) = endpoints.get(&source) else {
                    continue;
                };
                let limit = file.source_limit(source, endpoint, limits);
                if limit == 0 {
                    continue;
                }
                let mut grants = limits.clone();
                grants.source_direct_limit = Some(limit);
                let parents = activity_parents(
                    source,
                    &file.receivers,
                    if Some(source) == file.source {
                        &file.parents
                    } else {
                        &empty
                    },
                    neighbors,
                    relays,
                    &grants,
                    &file.refused,
                );
                let serving = !parents.is_empty();
                if !serving && !endpoint.connected {
                    continue;
                }
                if selected.is_none() || serving {
                    selected = Some((source, parents));
                }
                if serving || file.receivers.is_empty() {
                    break;
                }
            }
            if let Some((source, parents)) = selected {
                file.source = Some(source);
                file.parents = parents;
            } else {
                file.source = None;
                file.parents.clear();
            }
        }
    }
    pub(crate) fn collect_frontiers(
        &self,
        endpoints: &BTreeMap<Uuid, Endpoint>,
        neighbors: &BTreeMap<Uuid, BTreeSet<Uuid>>,
        relays: &BTreeSet<Uuid>,
        limits: &RelayLimits,
        unavailable: &BTreeSet<(Uuid, Uuid)>,
        frontiers: &mut Vec<crate::host::DeliveryFrontier>,
    ) {
        for file in self.files.values() {
            let Some((source, endpoint)) = file.source.and_then(|s| Some((s, endpoints.get(&s)?)))
            else {
                continue;
            };
            let mut limits = limits.clone();
            limits.source_direct_limit = Some(file.source_limit(source, endpoint, &limits));
            crate::routes::Plan::byte_frontiers(
                source,
                &file.receivers,
                &file.parents,
                &file.refused,
                unavailable,
                neighbors,
                relays,
                &limits,
                frontiers,
            );
        }
    }
    pub fn plans(&self, room_id: &str, session: Uuid) -> Vec<FilePlan> {
        self.files
            .iter()
            .filter_map(|((seq, _), file)| {
                if file.receivers.is_empty() {
                    return None;
                }
                let upstream = file.parents.get(&session).copied();
                let downstream: Vec<_> = file
                    .parents
                    .iter()
                    .filter_map(|(child, parent)| (*parent == session).then_some(*child))
                    .collect();
                let receiving = file.receivers.contains(&session);
                if !receiving
                    && file.source != Some(session)
                    && upstream.is_none()
                    && downstream.is_empty()
                {
                    return None;
                }
                Some(FilePlan {
                    author_id: file.author_id,
                    room_id: room_id.into(),
                    message_seq: *seq,
                    attachment: file.attachment.clone(),
                    source_id: file.source,
                    upstream,
                    downstream,
                    receiving,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(files: &mut FileRoom, edges: &[(Uuid, Uuid)], limits: &RelayLimits) {
        let mut neighbors = BTreeMap::<Uuid, BTreeSet<Uuid>>::new();
        for &(a, b) in edges {
            neighbors.entry(a).or_default().insert(b);
            neighbors.entry(b).or_default().insert(a);
        }
        let endpoints = neighbors
            .keys()
            .map(|&id| {
                (
                    id,
                    Endpoint {
                        connected: true,
                        signing_key: [0; 32],
                        member: crate::identity::Member { user_id: id },
                    },
                )
            })
            .collect();
        files.route(
            &endpoints,
            &neighbors,
            &neighbors.keys().copied().collect(),
            limits,
        );
    }
    #[test]
    fn ending_a_transfer_wakes_the_other_rooms_displaced_file_branch_once() {
        use super::*;
        use crate::{
            forwarding::ForwardingBudget,
            wire::{Command, PairInfo},
        };
        let id = Uuid::from_u128;
        let holder = id(1);
        let author = id(99);
        let attachment = AttachmentDescriptor {
            id: id(10),
            name: "file.bin".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        let room = |reader| {
            let mut files = FileRoom::default();
            files
                .install(holder, 1, author, attachment.clone(), true)
                .unwrap();
            files
                .install(reader, 1, author, attachment.clone(), false)
                .unwrap();
            let online = BTreeSet::from([holder, reader]);
            files.reconcile(&online, None);
            route(&mut files, &[(holder, reader)], &Default::default());
            files
        };
        let mut first = room(id(2));
        let mut waiting = room(id(3));
        let mut budget = ForwardingBudget::default();
        let mut raw = crate::channel::Channel::new("owner".into(), vec![]).snapshot(holder);
        raw.pairs.push(PairInfo {
            id: id(9),
            peer_id: id(3),
            rooms: vec!["waiting".into()],
            outgoing: vec![],
            incoming: vec![],
            udp_preparation: None,
            can_receive_video_layers: false,
        });
        raw.files = first.plans("first", holder);
        assert!(budget.apply(Some(1), holder, &mut raw).is_empty());
        raw.files.extend(waiting.plans("waiting", holder));
        let reports = budget.apply(Some(1), holder, &mut raw);
        let [Command::ByteBranchRefused {
            target: crate::wire::ByteBranchTarget::File { source_id, .. },
            downstream_id,
            ..
        }] = reports.as_slice()
        else {
            panic!("expected a targeted refusal")
        };
        waiting
            .refuse_branch(1, attachment.id, *source_id, holder, *downstream_id)
            .unwrap();
        route(&mut waiting, &[(holder, id(3))], &Default::default());
        raw.files = first.plans("first", holder);
        raw.files.extend(waiting.plans("waiting", holder));
        assert!(raw
            .files
            .iter()
            .filter(|p| p.room_id == "waiting")
            .all(|p| p.downstream.is_empty()));
        assert!(budget.apply(Some(1), holder, &mut raw).is_empty());
        let key = FileKey {
            room_id: "waiting".into(),
            message_seq: 1,
            attachment_id: attachment.id,
        };
        use crate::file_delivery::{FileDelivery, FileEffect};
        let mut receiver = FileDelivery::new(id(3));
        let peers = vec![(holder, vec!["waiting".to_string()])];
        receiver.update(waiting.plans("waiting", id(3)), peers.clone(), 0);
        assert!(receiver.start(key.clone()).is_empty());
        first.remove(id(2), 1, attachment.id, false);
        raw.files = first.plans("first", holder);
        raw.files.extend(waiting.plans("waiting", holder));
        assert!(
            matches!(budget.apply(Some(1),holder,&mut raw).as_slice(),[Command::ForwardingAvailable{room_id,kind:Some(crate::forwarding::ForwardingKind::File)}] if room_id=="waiting")
        );
        assert!(budget.apply(Some(1), holder, &mut raw).is_empty());
        waiting.forwarding_available(holder);
        route(&mut waiting, &[(holder, id(3))], &Default::default());
        raw.files = waiting.plans("waiting", holder);
        assert!(budget.apply(Some(1), holder, &mut raw).is_empty());
        assert_eq!(raw.files[0].downstream, vec![id(3)]);
        let mut sender = FileDelivery::new(holder);
        sender.update(raw.files, vec![(id(3), vec!["waiting".into()])], 1);
        let resumed = receiver.update(waiting.plans("waiting", id(3)), peers, 1);
        let [FileEffect::SendControl { control, .. }] = resumed.as_slice() else {
            panic!("pending receiver should request without another start")
        };
        let reads = sender.control(id(3), control.clone(), 1);
        let [FileEffect::Read { request_id, .. }] = reads.as_slice() else {
            panic!("resumed source read")
        };
        let sends = sender.read_result(&key, 0, *request_id, b"abc".to_vec());
        let [FileEffect::SendChunk { frame, .. }] = sends.as_slice() else {
            panic!("resumed sender chunk")
        };
        assert!(
            matches!(receiver.chunk(holder,frame).unwrap().as_slice(),[FileEffect::Write{bytes,..}] if bytes==b"abc")
        );
        assert!(matches!(
            receiver.written(&key, 0, 3).as_slice(),
            [FileEffect::Complete { .. }]
        ));
    }
    #[test]
    fn refused_transit_moves_to_a_live_copy_with_a_file_grant() {
        let [author, transit, copy, reader] = [1, 2, 3, 4].map(Uuid::from_u128);
        let edges = [(author, transit), (transit, reader), (copy, reader)];
        let members = [author, transit, copy, reader].into();
        let mut files = FileRoom::default();
        let attachment = AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "file.bin".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        assert_eq!(
            files.install(reader, 1, author, attachment.clone(), false),
            Err("attachment_unavailable")
        );
        for holder in [author, copy] {
            files
                .install(holder, 1, author, attachment.clone(), true)
                .unwrap();
        }
        files
            .install(reader, 1, author, attachment.clone(), false)
            .unwrap();
        files.reconcile(&members, None);
        let mut limits = RelayLimits::default();
        limits.overrides.extend([(author, 0), (copy, 0)]);
        route(&mut files, &edges, &limits);
        assert_eq!(files.plans("room", reader)[0].upstream, Some(transit));
        files
            .refuse_branch(1, attachment.id, author, transit, reader)
            .unwrap();
        route(&mut files, &edges, &limits);
        let waiting = &files.plans("room", reader)[0];
        assert!(waiting.receiving);
        assert_eq!(waiting.source_id, Some(author));
        assert_eq!(waiting.upstream, None);
        limits.overrides.insert(copy, 1);
        route(&mut files, &edges, &limits);
        assert_eq!(files.plans("room", reader)[0].upstream, Some(copy));
        files.forwarding_available(transit);
        route(&mut files, &edges, &limits);
        assert_eq!(files.plans("room", reader)[0].source_id, Some(copy));
        for holder in [author, copy] {
            files.remove(holder, 1, attachment.id, true);
        }
        files.reconcile(&members, None);
        route(&mut files, &edges, &limits);
        assert_eq!(files.plans("room", reader)[0].source_id, None);
    }
}
