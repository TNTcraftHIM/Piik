use crate::wire::{ByteBranchTarget, Command, FlowState, Kind, Request, Snapshot};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum ForwardingKind {
    File,
    Voice,
    Screen,
}

/// One owner per sending runtime. Callers supply every current or preparing
/// third-party assignment across rooms, coalesced by kind and downstream peer.
#[derive(Default)]
pub struct ForwardingBudget {
    admitted: BTreeSet<(ForwardingKind, Uuid)>,
    refused: BTreeSet<(Uuid, Uuid)>,
    refused_bytes: BTreeSet<(String, ByteBranchTarget, Uuid)>,
    limited_rooms: BTreeSet<(String, ForwardingKind)>,
    previous_limit: Option<u8>,
    pending_capacity: BTreeMap<Uuid, (Uuid, Option<u8>)>,
}

impl ForwardingBudget {
    pub fn reconnected(&mut self) {
        self.pending_capacity.clear();
    }

    pub fn capacity_reply(&mut self, request_id: &str) {
        if let Ok(id) = Uuid::parse_str(request_id) {
            self.pending_capacity.retain(|_, (pending, _)| *pending != id);
        }
    }

    pub fn capacity_updates(&mut self, session: Uuid, limit: Option<u8>, snapshot: &Snapshot) -> Vec<Request> {
        let mut updates = Vec::new();
        let mut pending = BTreeMap::new();
        for room in snapshot
            .channel
            .rooms
            .iter()
            .filter(|room| room.available && room.authorized)
        {
            let Some(binding) = &room.delivery else {
                continue;
            };
            if room.relay_override.is_none()
                && binding.host_session_id != session
                && !room.reading
                && !room.participant_session_ids.contains(&session)
                && !snapshot.files.iter().any(|file| file.room_id == room.id)
            {
                continue;
            }
            let binding_id = binding.binding_id;
            let in_flight = self.pending_capacity.get(&binding_id).copied();
            if let Some((id, target)) = in_flight {
                if target == limit {
                    pending.insert(binding_id, (id, target));
                    continue;
                }
            } else if room.relay_override == limit {
                continue;
            }
            let request_id = Uuid::new_v4();
            updates.push(Request {
                request_id: Some(request_id.to_string()),
                command: Command::RelayCapacity { room_id: room.id.clone(), capacity: limit },
            });
            pending.insert(binding_id, (request_id, limit));
        }
        self.pending_capacity = pending;
        updates
    }

    /// Apply all room grants together, before handing plans to the transports.
    pub fn apply(
        &mut self,
        limit: Option<u8>,
        user_id: Uuid,
        snapshot: &mut Snapshot,
    ) -> Vec<Command> {
        self.limited_rooms.retain(|(room, _)| {
            snapshot.channel.rooms.iter().any(|r| &r.id == room)
                || snapshot.pairs.iter().any(|p| p.rooms.contains(room))
                || snapshot.publications.iter().any(|p| &p.room_id == room)
                || snapshot.files.iter().any(|f| &f.room_id == room)
        });
        let increased = self
            .previous_limit
            .is_some_and(|old| limit.is_none_or(|value| value > old));
        let lowering = limit.is_some_and(|new| self.previous_limit.is_none_or(|old| new < old));
        self.previous_limit = limit;
        let kinds: BTreeMap<_, _> = snapshot
            .publications
            .iter()
            .map(|p| {
                (
                    p.id,
                    match p.kind {
                        Kind::Voice => ForwardingKind::Voice,
                        Kind::Screen => ForwardingKind::Screen,
                    },
                )
            })
            .collect();
        let mut requested = BTreeSet::new();
        let mut selected = BTreeSet::new();
        for pair in &snapshot.pairs {
            for flow in &pair.outgoing {
                if flow.input_flow_id.is_some() && !flow.presentation {
                    if let Some(kind) = kinds.get(&flow.publication_id) {
                        let slot = (*kind, pair.peer_id);
                        requested.insert(slot);
                        if lowering && flow.selected {
                            selected.insert(slot);
                        }
                    }
                }
            }
        }
        for plan in &snapshot.files {
            if plan.author_id != user_id || plan.upstream.is_some() {
                requested.extend(
                    plan.downstream
                        .iter()
                        .map(|peer| (ForwardingKind::File, *peer)),
                );
            }
        }
        for plan in &snapshot.watch_bytes {
            if plan.upstream.is_some() {
                requested.extend(
                    plan.downstream
                        .iter()
                        .map(|peer| (ForwardingKind::File, *peer)),
                );
            }
        }
        let mut freed = BTreeSet::new();
        if let Some(limit) = limit {
            for kind in [
                ForwardingKind::File,
                ForwardingKind::Voice,
                ForwardingKind::Screen,
            ] {
                let used = self.admitted.iter().filter(|slot| slot.0 == kind).count();
                let needed = requested.iter().filter(|slot| slot.0 == kind).count();
                if needed < used && needed < usize::from(limit) {
                    freed.insert(kind);
                }
            }
        }
        let mut wake = BTreeSet::new();
        self.limited_rooms.retain(|(room, kind)| {
            if increased || freed.contains(kind) {
                wake.insert((room.clone(), if increased { None } else { Some(*kind) }));
                false
            } else {
                true
            }
        });
        self.reconcile(limit, requested, &selected);
        let admitted = &self.admitted;
        let mut refused = BTreeSet::new();
        for pair in &mut snapshot.pairs {
            pair.outgoing.retain(|flow| {
                let allowed = flow.input_flow_id.is_none() || flow.presentation
                    || kinds
                        .get(&flow.publication_id)
                        .is_some_and(|kind| admitted.contains(&(*kind, pair.peer_id)));
                if !allowed {
                    refused.insert((pair.id, flow.id));
                    if let Some(publication) = snapshot
                        .publications
                        .iter()
                        .find(|p| p.id == flow.publication_id)
                    {
                        self.limited_rooms
                            .insert((publication.room_id.clone(), kinds[&publication.id]));
                    }
                }
                allowed
            });
        }
        let mut refused_bytes = BTreeSet::new();
        let mut allow = |room: &str, target: &ByteBranchTarget, peer: Uuid| {
            if admitted.contains(&(ForwardingKind::File, peer)) {
                return true;
            }
            self.limited_rooms.insert((room.to_owned(), ForwardingKind::File));
            refused_bytes.insert((room.to_owned(), target.clone(), peer));
            false
        };
        for plan in &mut snapshot.watch_bytes {
            if plan.upstream.is_some() {
                let target = ByteBranchTarget::Watch { activity_id: plan.activity_id, source: plan.source.clone() };
                plan.downstream.retain(|peer| allow(&plan.room_id, &target, *peer));
            }
        }
        for plan in &mut snapshot.files {
            if plan.author_id != user_id || plan.upstream.is_some() {
                if let Some(source_id) = plan.source_id {
                    let target = ByteBranchTarget::File { message_seq: plan.message_seq, attachment_id: plan.attachment.id, source_id };
                    plan.downstream.retain(|peer| allow(&plan.room_id, &target, *peer));
                }
            }
        }
        let mut commands = Vec::new();
        commands.extend(
            refused
                .difference(&self.refused)
                .map(|&(pair_id, flow_id)| Command::FlowState {
                    pair_id,
                    flow_id,
                    state: FlowState::Failed,
                }),
        );
        self.refused = refused;
        commands.extend(refused_bytes.difference(&self.refused_bytes).map(
            |(room_id, target, peer)| Command::ByteBranchRefused {
                room_id: room_id.clone(), target: target.clone(), downstream_id: *peer,
            },
        ));
        self.refused_bytes = refused_bytes;
        commands.extend(
            wake.into_iter()
                .map(|(room_id, kind)| Command::ForwardingAvailable { room_id, kind }),
        );
        commands
    }

    fn reconcile(
        &mut self,
        limit: Option<u8>,
        requested: BTreeSet<(ForwardingKind, Uuid)>,
        selected: &BTreeSet<(ForwardingKind, Uuid)>,
    ) {
        let Some(limit) = limit else {
            self.admitted = requested;
            return;
        };
        let mut next = BTreeSet::new();
        let mut counts = BTreeMap::new();
        // On shrink, keep admitted peers carrying a selected leg ahead of preparation-only peers.
        for slot in selected
            .intersection(&self.admitted)
            .chain(requested.intersection(&self.admitted))
            .chain(requested.difference(&self.admitted))
        {
            let count = counts.entry(slot.0).or_insert(0usize);
            if *count < usize::from(limit) && next.insert(*slot) {
                *count += 1;
            }
        }
        self.admitted = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn own_watch_source_and_local_receipt_survive_off() {
        use crate::{
            watch_delivery::WatchBytePlan,
            wire::{WatchByteSource, WatchFormat},
        };
        let id = Uuid::from_u128;
        let mut snapshot = crate::channel::Channel::new("owner".into(), vec![]).snapshot(id(1));
        let mut plan = WatchBytePlan {
            room_id: "r".into(),
            activity_id: id(3),
            source: WatchByteSource {
                session_id: id(1),
                resource_id: id(4),
                format: WatchFormat::File,
            },
            upstream: None,
            downstream: vec![id(5)],
            receiving: false,
        };
        snapshot.watch_bytes.push(plan.clone());
        plan.upstream = Some(id(6));
        plan.receiving = true;
        snapshot.watch_bytes.push(plan);
        ForwardingBudget::default().apply(Some(0), id(1), &mut snapshot);
        assert_eq!(snapshot.watch_bytes[0].downstream, vec![id(5)]);
        assert!(snapshot.watch_bytes[1].downstream.is_empty());
        assert!(snapshot.watch_bytes[1].receiving);
    }
    #[test]
    fn off_refuses_only_the_relayed_flow_and_keeps_its_shared_pair() {
        use crate::wire::{FlowBinding, PairInfo, PublicationInfo};
        let id = Uuid::from_u128;
        let mut raw = crate::channel::Channel::new("owner".into(), vec![]).snapshot(id(1));
        raw.publications.push(PublicationInfo {
            screen: None,
            id: id(3),
            room_id: "r".into(),
            session_id: id(2),
            user_id: id(2),
            kind: Kind::Voice,
            paused: false,
            audience: vec![],
            video_settings: None,
        });
        let own = FlowBinding {
            id: id(5),
            publication_id: id(4),
            input_flow_id: None,
            presentation: false,
            selected: true,
        };
        let relay = FlowBinding {
            id: id(6),
            publication_id: id(3),
            input_flow_id: Some(id(7)),
            presentation: false,
            selected: false,
        };
        raw.pairs.push(PairInfo {
            id: id(8),
            udp_preparation: None,
            peer_id: id(9),
            can_receive_video_layers: false,
            rooms: vec!["r".into()],
            outgoing: vec![own, relay],
            incoming: vec![],
        });
        let mut budget = ForwardingBudget::default();
        let mut filtered = raw.clone();
        let reports = budget.apply(Some(0), id(1), &mut filtered);
        assert!(
            matches!(reports.as_slice(), [Command::FlowState {pair_id, flow_id, state:FlowState::Failed}] if *pair_id == id(8) && *flow_id == relay.id)
        );
        assert_eq!(filtered.pairs[0].outgoing, vec![own]);
        assert!(budget
            .apply(Some(0), id(1), &mut raw.clone())
            .is_empty());
        let mut absent = raw.clone();
        absent.pairs[0].outgoing = vec![own];
        assert!(budget.apply(Some(0), id(1), &mut absent).is_empty());
        assert!(
            matches!(budget.apply(Some(1),id(1),&mut absent).as_slice(),[Command::ForwardingAvailable{room_id,kind:None}] if room_id=="r")
        );
        assert_eq!(absent.pairs[0].outgoing, vec![own]);
        assert!(budget.apply(Some(1), id(1), &mut raw).is_empty());
        assert_eq!(raw.pairs[0].outgoing, vec![own, relay]);
    }
    #[test]
    fn a_freed_voice_slot_only_wakes_visible_rooms_waiting_for_voice() {
        let id = Uuid::from_u128;
        let mut budget = ForwardingBudget::default();
        budget.previous_limit = Some(1);
        budget.admitted.insert((ForwardingKind::Voice, id(2)));
        budget.limited_rooms.extend([
            ("active".into(), ForwardingKind::File),
            ("active".into(), ForwardingKind::Voice),
            ("purged".into(), ForwardingKind::Voice),
        ]);
        let mut raw = crate::channel::Channel::new("owner".into(), vec![]).snapshot(id(1));
        raw.pairs.push(crate::wire::PairInfo {
            id: id(4),
            peer_id: id(2),
            rooms: vec!["active".into()],
            outgoing: vec![],
            incoming: vec![],
            udp_preparation: None,
            can_receive_video_layers: false,
        });
        let wakes = budget.apply(Some(1), id(1), &mut raw);
        assert!(
            matches!(wakes.as_slice(),[Command::ForwardingAvailable{room_id,kind:Some(ForwardingKind::Voice)}] if room_id=="active")
        );
        assert_eq!(
            budget.limited_rooms,
            BTreeSet::from([("active".into(), ForwardingKind::File)])
        );
        assert!(budget.apply(Some(1), id(1), &mut raw).is_empty());
    }
    #[test]
    fn lowering_limit_keeps_selected_screen_forwarding_on_a_shared_pair() {
        use crate::wire::{FlowBinding, PairInfo, PublicationInfo};
        let id = Uuid::from_u128;
        for (selected_peer, preparing_peer) in [(id(9), id(8)), (id(8), id(9))] {
            let mut snapshot = crate::channel::Channel::new("owner".into(), vec![]).snapshot(id(1));
            let publication = |n, kind| PublicationInfo {
                id: id(n), session_id: id(2), user_id: id(2), room_id: "r".into(),
                kind, screen: None, paused: false, audience: vec![], video_settings: None,
            };
            snapshot.publications = vec![
                publication(10, Kind::Screen), publication(11, Kind::Screen),
                publication(12, Kind::Voice),
            ];
            let flow = |n, publication, selected| FlowBinding {
                id: id(n), publication_id: id(publication), input_flow_id: Some(id(publication + 100)),
                selected, presentation: false,
            };
            let selected = flow(20, 10, true);
            let shared_preparation = flow(21, 11, false);
            let competing = flow(22, 10, false);
            let voice = flow(23, 12, true);
            let pair = |n, peer_id, outgoing| PairInfo {
                id: id(n), peer_id, outgoing, rooms: vec!["r".into()], incoming: vec![],
                udp_preparation: None, can_receive_video_layers: false,
            };
            snapshot.pairs = vec![
                pair(30, selected_peer, vec![selected, shared_preparation]),
                pair(31, preparing_peer, vec![competing, voice]),
            ];
            snapshot.files.push(crate::file_room::FilePlan {
                author_id: id(2), room_id: "r".into(), message_seq: 1, source_id: Some(id(2)),
                upstream: Some(id(2)), downstream: vec![preparing_peer], receiving: false,
                attachment: crate::attachment::AttachmentDescriptor {
                    id: id(40), name: "fixture".into(), size: 1,
                    media_type: "application/octet-stream".into(), sha256: "0".repeat(64),
                },
            });

            let mut budget = ForwardingBudget::default();
            assert!(budget.apply(Some(2), id(1), &mut snapshot).is_empty());
            let commands = budget.apply(Some(1), id(1), &mut snapshot);
            assert_eq!(snapshot.pairs[0].outgoing, [selected, shared_preparation]);
            assert_eq!(snapshot.pairs[1].outgoing, [voice]);
            assert_eq!(snapshot.files[0].downstream, [preparing_peer]);
            assert!(matches!(commands.as_slice(),
                [Command::FlowState {pair_id, flow_id, state: FlowState::Failed}]
                if *pair_id == id(31) && *flow_id == competing.id));
        }
    }
    #[test]
    fn competing_rooms_keep_one_slot_per_peer_and_kind() {
        use ForwardingKind::*;
        let x = Uuid::from_u128(2);
        let y = Uuid::from_u128(1);
        let mut budget = ForwardingBudget::default();
        let mut rooms = vec![(Screen, x), (Screen, x), (Voice, y), (File, y)];
        let initial = rooms.iter().copied().collect();
        let selected = BTreeSet::new();
        budget.reconcile(Some(1), initial, &selected);
        assert_eq!(budget.admitted, [(Screen, x), (Voice, y), (File, y)].into());
        rooms.push((Screen, y));
        rooms.remove(0);
        budget.reconcile(Some(1), rooms.iter().copied().collect(), &selected);
        assert!(!budget.admitted.contains(&(Screen, y)));
        rooms.remove(0);
        budget.reconcile(Some(1), rooms.iter().copied().collect(), &selected);
        assert!(budget.admitted.contains(&(Screen, y)));
        budget.reconcile(Some(0), rooms.iter().copied().collect(), &selected);
        assert!(budget.admitted.is_empty());
        budget.reconcile(None, rooms.iter().copied().collect(), &selected);
        assert_eq!(budget.admitted, rooms.into_iter().collect());
    }
}
