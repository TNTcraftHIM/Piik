//! Live complete-copy offers and recipient demand on the room's existing base tree.
use crate::{attachment::AttachmentDescriptor, routes::BaseTree};
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
    refused: BTreeSet<(Uuid, Uuid)>,
}
#[derive(Clone, Default)]
pub(crate) struct FileRoom {
    files: BTreeMap<(u64, Uuid), File>,
}
impl FileRoom {
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
    pub fn remove_messages(&mut self, from: u64, through: u64) -> bool {
        let before = self.files.len();
        self.files
            .retain(|(seq, _), _| !(from..=through).contains(seq));
        before != self.files.len()
    }
    fn prune(&mut self) {
        self.files
            .retain(|_, file| !file.holders.is_empty() || !file.receivers.is_empty());
    }
    pub fn reconcile(&mut self, admitted: &BTreeSet<Uuid>) {
        for file in self.files.values_mut() {
            file.holders.retain(|id| admitted.contains(id));
            file.receivers.retain(|id| admitted.contains(id));
            file.refused.retain(|(sender, peer)| {
                !file.receivers.is_empty() && admitted.contains(sender) && admitted.contains(peer)
            });
            if file
                .source
                .is_none_or(|source| !file.holders.contains(&source))
            {
                file.source = file.holders.first().copied();
            }
        }
        self.prune();
    }
    pub fn refuse_branch(
        &mut self,
        base: &BaseTree,
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
        if file.source != Some(source)
            || !base
                .project(source, &file.receivers)
                .contains(&(sender, downstream))
        {
            return Err("unassigned_file_branch");
        }
        file.refused.insert((sender, downstream));
        Ok(())
    }
    pub fn forwarding_available(&mut self, sender: Uuid) {
        for file in self.files.values_mut() {
            file.refused.retain(|(from, _)| *from != sender);
        }
    }
    pub fn requested_pairs(&self) -> impl Iterator<Item = (Uuid, Uuid)> + '_ {
        self.files.values().flat_map(|file| {
            file.source.into_iter().flat_map(move |source| {
                file.receivers.iter().filter_map(move |&receiver| {
                    (!file.refused.contains(&(source, receiver))).then_some((source, receiver))
                })
            })
        })
    }
    pub fn blocked_direct_source(
        &self,
        base: &BaseTree,
        confirmed: &BTreeSet<(Uuid, Uuid)>,
    ) -> Option<Uuid> {
        self.files.values().find_map(|file| {
            let source = file.source?;
            if source == base.root() || file.refused.is_empty() {
                return None;
            }
            file.receivers
                .iter()
                .any(|&receiver| {
                    confirmed.contains(&(source.min(receiver), source.max(receiver)))
                        && !file.refused.contains(&(source, receiver))
                        && !base
                            .project(source, &BTreeSet::from([receiver]))
                            .is_disjoint(&file.refused)
                })
                .then_some(source)
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
    pub fn select_ready_sources(&mut self, base: &BaseTree) -> bool {
        let mut changed = false;
        for file in self.files.values_mut() {
            let reaches_receivers = |source| {
                let paths = base.project(source, &file.receivers);
                !paths.is_empty() && paths.is_disjoint(&file.refused)
            };
            if file.source.is_some_and(reaches_receivers) {
                continue;
            }
            if let Some(source) = file
                .holders
                .iter()
                .copied()
                .find(|id| reaches_receivers(*id))
            {
                changed |= file.source != Some(source);
                file.source = Some(source);
            }
        }
        changed
    }
    pub fn plans(&self, room_id: &str, session: Uuid, base: &BaseTree) -> Vec<FilePlan> {
        self.files
            .iter()
            .filter_map(|((seq, _), file)| {
                if file.receivers.is_empty() {
                    return None;
                }
                let paths = file
                    .source
                    .map(|source| base.project_avoiding(source, &file.receivers, &file.refused))
                    .unwrap_or_default();
                let upstream = paths
                    .iter()
                    .find_map(|(parent, child)| (*child == session).then_some(*parent));
                let downstream: Vec<_> = paths
                    .iter()
                    .filter_map(|(parent, child)| (*parent == session).then_some(*child))
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
            let mut base = BaseTree::new(holder);
            files
                .install(holder, 1, author, attachment.clone(), true)
                .unwrap();
            files
                .install(reader, 1, author, attachment.clone(), false)
                .unwrap();
            let online = BTreeSet::from([holder, reader]);
            files.reconcile(&online);
            base.reconcile(&online, &online, &online, &Default::default(), 0);
            base.state(holder, reader, true);
            base.state(reader, holder, true);
            base.reconcile(&online, &online, &online, &Default::default(), 1);
            (files, base)
        };
        let (mut first, first_base) = room(id(2));
        let (mut waiting, waiting_base) = room(id(3));
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
        raw.files = first.plans("first", holder, &first_base);
        assert!(budget.apply(Some(1), holder, &mut raw).is_empty());
        raw.files
            .extend(waiting.plans("waiting", holder, &waiting_base));
        let reports = budget.apply(Some(1), holder, &mut raw);
        let [Command::FileBranchRefused {
            source_id,
            downstream_id,
            ..
        }] = reports.as_slice()
        else {
            panic!("expected a targeted refusal")
        };
        waiting
            .refuse_branch(
                &waiting_base,
                1,
                attachment.id,
                *source_id,
                holder,
                *downstream_id,
            )
            .unwrap();
        raw.files = first.plans("first", holder, &first_base);
        raw.files
            .extend(waiting.plans("waiting", holder, &waiting_base));
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
        receiver.update(
            waiting.plans("waiting", id(3), &waiting_base),
            peers.clone(),
            0,
        );
        assert!(receiver.start(key.clone()).is_empty());
        first.remove(id(2), 1, attachment.id, false);
        raw.files = first.plans("first", holder, &first_base);
        raw.files
            .extend(waiting.plans("waiting", holder, &waiting_base));
        assert!(
            matches!(budget.apply(Some(1),holder,&mut raw).as_slice(),[Command::ForwardingAvailable{room_id,kind:Some(crate::forwarding::ForwardingKind::File)}] if room_id=="waiting")
        );
        assert!(budget.apply(Some(1), holder, &mut raw).is_empty());
        waiting.forwarding_available(holder);
        raw.files = waiting.plans("waiting", holder, &waiting_base);
        assert!(budget.apply(Some(1), holder, &mut raw).is_empty());
        assert_eq!(raw.files[0].downstream, vec![id(3)]);
        let mut sender = FileDelivery::new(holder);
        sender.update(raw.files, vec![(id(3), vec!["waiting".into()])], 1);
        let resumed = receiver.update(waiting.plans("waiting", id(3), &waiting_base), peers, 1);
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
    use super::*;
    #[test]
    fn shared_tree_demand_keeps_transit_and_source_changes_follow_live_copies() {
        let ids: Vec<_> = (1..=5).map(Uuid::from_u128).collect();
        let online: BTreeSet<_> = ids.iter().copied().collect();
        let mut base = BaseTree::new(ids[0]);
        let mut files = FileRoom::default();
        let attachment = AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "file.bin".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
        };
        assert_eq!(
            files.install(ids[3], 1, ids[0], attachment.clone(), false),
            Err("attachment_unavailable")
        );
        files
            .install(ids[0], 1, ids[0], attachment.clone(), true)
            .unwrap();
        files
            .install(ids[3], 1, ids[0], attachment.clone(), false)
            .unwrap();
        files
            .install(ids[4], 1, ids[0], attachment.clone(), false)
            .unwrap();
        files.reconcile(&online);
        // Use the real base owner to establish the existing bounded tree first.
        base.reconcile(&online, &online, &online, &Default::default(), 0);
        for _ in 0..3 {
            let links: Vec<_> = base.links().collect();
            for (parent, child) in links {
                base.state(parent, child, true);
                base.state(child, parent, true);
            }
            base.reconcile(&online, &online, &online, &Default::default(), 0);
        }
        base.reconcile(&files.demand(), &online, &online, &Default::default(), 0);
        let relay = files.plans("room", ids[1], &base);
        assert_eq!(relay[0].upstream, Some(ids[0]));
        assert_eq!(relay[0].downstream.len(), 2);
        assert!(!relay[0].receiving);
        assert_eq!(files.plans("room", ids[3], &base)[0].upstream, Some(ids[1]));
        files.remove(ids[3], 1, attachment.id, false);
        base.reconcile(&files.demand(), &online, &online, &Default::default(), 0);
        assert_eq!(
            files.plans("room", ids[1], &base)[0].downstream,
            vec![ids[4]]
        );
        files
            .install(ids[2], 1, ids[0], attachment.clone(), true)
            .unwrap();
        files.reconcile(&online);
        {
            let mut repair = files.clone();
            // A holder on the far side of the refused branch can serve the existing demand.
            repair
                .install(ids[1], 1, ids[0], attachment.clone(), true)
                .unwrap();
            let mut raw = crate::channel::Channel::new("owner".into(), vec![]).snapshot(ids[0]);
            raw.files = repair.plans("room", ids[0], &base);
            let mut budget = crate::forwarding::ForwardingBudget::default();
            let reports = budget.apply(Some(0), ids[4], &mut raw.clone());
            assert!(budget.apply(Some(0), ids[4], &mut raw).is_empty());
            let [crate::wire::Command::FileBranchRefused {
                source_id,
                downstream_id,
                ..
            }] = reports.as_slice()
            else {
                panic!("expected one branch refusal")
            };
            repair
                .refuse_branch(&base, 1, attachment.id, *source_id, ids[0], *downstream_id)
                .unwrap();
            assert!(repair.select_ready_sources(&base));
            let next = repair.plans("room", ids[4], &base);
            assert_ne!(next[0].source_id, Some(ids[0]));
            assert!(next[0].receiving && next[0].upstream.is_some());
            assert!(!repair.select_ready_sources(&base));
            // While Off, the writer already moved the branch off the original holder.
            raw.files = repair.plans("room", ids[0], &base);
            assert!(raw.files.iter().all(|plan| plan.downstream.is_empty()));
            raw.pairs.push(crate::wire::PairInfo {
                id: Uuid::new_v4(),
                peer_id: ids[1],
                rooms: vec!["room".into()],
                outgoing: vec![],
                incoming: vec![],
                udp_preparation: None,
                can_receive_video_layers: false,
            });
            assert!(
                matches!(budget.apply(Some(1),ids[4],&mut raw).as_slice(),[crate::wire::Command::ForwardingAvailable{room_id,kind:None}] if room_id=="room")
            );
            repair.forwarding_available(ids[0]);
            // Keep current delivery until its source leaves; the original is eligible again.
            assert!(!repair.select_ready_sources(&base));
            repair.remove(ids[1], 1, attachment.id, true);
            repair.remove(ids[2], 1, attachment.id, true);
            repair.reconcile(&online);
            raw.files = repair.plans("room", ids[0], &base);
            assert!(budget.apply(Some(1), ids[4], &mut raw).is_empty());
            assert_eq!(raw.files[0].downstream, vec![ids[1]]);
        }
        assert_eq!(
            files.plans("room", ids[4], &base)[0].source_id,
            Some(ids[0])
        );
        let remaining = online.iter().copied().filter(|id| *id != ids[0]).collect();
        files.reconcile(&remaining);
        assert_eq!(
            files.plans("room", ids[4], &base)[0].source_id,
            Some(ids[2])
        );
        files.remove(ids[2], 1, attachment.id, true);
        files.reconcile(&remaining);
        let waiting = files.plans("room", ids[4], &base);
        assert_eq!(waiting[0].source_id, None);
        assert_eq!(waiting[0].upstream, None);
        files.remove(ids[4], 1, attachment.id, false);
        assert!(files.demand().is_empty());
    }
}
