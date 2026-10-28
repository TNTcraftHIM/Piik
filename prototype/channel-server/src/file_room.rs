//! Live complete-copy offers and recipient demand on the room's existing base tree.
use crate::{attachment::AttachmentDescriptor, history::HISTORY_WINDOW, routes::BaseTree};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

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
    attachment: AttachmentDescriptor,
    holders: BTreeSet<Uuid>,
    receivers: BTreeSet<Uuid>,
    source: Option<Uuid>,
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
        if !self.files.contains_key(&key) && self.files.len() >= HISTORY_WINDOW {
            return Err("file_sources_full");
        }
        let file = self.files.entry(key).or_insert_with(|| File {
            attachment,
            holders: BTreeSet::new(),
            receivers: BTreeSet::new(),
            source: None,
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
    fn prune(&mut self) {
        self.files
            .retain(|_, file| !file.holders.is_empty() || !file.receivers.is_empty());
    }
    pub fn reconcile(&mut self, admitted: &BTreeSet<Uuid>) {
        for file in self.files.values_mut() {
            file.holders.retain(|id| admitted.contains(id));
            file.receivers.retain(|id| admitted.contains(id));
            if file
                .source
                .is_none_or(|source| !file.holders.contains(&source))
            {
                file.source = file.holders.first().copied();
            }
        }
        self.prune();
    }
    pub fn demand(&self) -> BTreeSet<Uuid> {
        self.files
            .values()
            .filter(|file| !file.receivers.is_empty())
            .flat_map(|file| file.source.iter().chain(file.receivers.iter()))
            .copied()
            .collect()
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
                    .map(|source| base.project(source, &file.receivers))
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
            files.install(ids[3], 1, attachment.clone(), false),
            Err("attachment_unavailable")
        );
        files.install(ids[0], 1, attachment.clone(), true).unwrap();
        files.install(ids[3], 1, attachment.clone(), false).unwrap();
        files.install(ids[4], 1, attachment.clone(), false).unwrap();
        files.reconcile(&online);
        // Use the real base owner to establish the existing bounded tree first.
        base.reconcile(&online, &online, &online);
        for _ in 0..3 {
            let links: Vec<_> = base.links().collect();
            for (parent, child) in links {
                base.state(parent, child, true);
                base.state(child, parent, true);
            }
            base.reconcile(&online, &online, &online);
        }
        base.reconcile(&files.demand(), &online, &online);
        let relay = files.plans("room", ids[1], &base);
        assert_eq!(relay[0].upstream, Some(ids[0]));
        assert_eq!(relay[0].downstream.len(), 2);
        assert!(!relay[0].receiving);
        assert_eq!(files.plans("room", ids[3], &base)[0].upstream, Some(ids[1]));
        files.remove(ids[3], 1, attachment.id, false);
        base.reconcile(&files.demand(), &online, &online);
        assert_eq!(
            files.plans("room", ids[1], &base)[0].downstream,
            vec![ids[4]]
        );
        files.install(ids[2], 1, attachment.clone(), true).unwrap();
        files.reconcile(&online);
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
