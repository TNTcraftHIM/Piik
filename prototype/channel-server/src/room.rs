use crate::{
    access::{RoomPermission, RoomState},
    history::{HistoryRequest, MessageDraft},
    identity::{Endpoint, Member},
    routes::Plan,
    transport::Flow,
    wire::{Kind, PublicationInfo, Room, RoomAccess, VoiceInfo},
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Default)]
struct Activity {
    watching: BTreeSet<Uuid>,
    voice: Option<VoiceInfo>,
}

#[derive(Clone)]
struct Publication {
    info: PublicationInfo,
    plan: Plan,
}

/// One room owns its policy, activities and logical flows. It neither owns
/// domain identities nor creates physical peer connections.
#[derive(Clone)]
pub struct RoomRuntime {
    policy: RoomState,
    activity: BTreeMap<Uuid, Activity>,
    publications: BTreeMap<Uuid, Publication>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub room: Room,
    pub publications: Vec<PublicationInfo>,
    pub voice: Vec<VoiceInfo>,
    pub subscriptions: Vec<Uuid>,
}

impl RoomRuntime {
    pub fn new(policy: RoomState) -> Self {
        Self {
            policy,
            activity: BTreeMap::new(),
            publications: BTreeMap::new(),
        }
    }

    pub fn policy(&self) -> &RoomState {
        &self.policy
    }

    pub fn authorize(
        &self,
        member: Member,
        permission: RoomPermission,
    ) -> Result<(), &'static str> {
        if !self.policy.reads(member.user_id, member.domain_owner) {
            return Err(if self.policy.hidden {
                "room_unavailable"
            } else {
                "room_access_required"
            });
        }
        match permission {
            RoomPermission::Read => Ok(()),
            RoomPermission::Write if member.participates => Ok(()),
            RoomPermission::Manage if self.policy.manages(member.user_id, member.domain_owner) => {
                Ok(())
            }
            _ => Err("forbidden"),
        }
    }

    pub fn snapshot(&self, member: Member, session: Uuid) -> Option<RoomSnapshot> {
        let room = self.policy.view(member.user_id, member.domain_owner)?;
        let mut snapshot = RoomSnapshot {
            room,
            publications: Vec::new(),
            voice: Vec::new(),
            subscriptions: Vec::new(),
        };
        if snapshot.room.authorized {
            snapshot.publications = self.publications().cloned().collect();
            snapshot.voice = self.voice().cloned().collect();
            snapshot.subscriptions = self.subscriptions(session).into_iter().collect();
        }
        Some(snapshot)
    }

    pub fn accepts_invite(&self, key: &str) -> bool {
        self.policy.accepts_invite(key)
    }

    pub fn grant_invited(&mut self, user: Uuid) {
        self.policy.grants.insert(user);
    }

    pub fn enter(
        &mut self,
        member: Member,
        password: Option<&str>,
        invite: Option<&str>,
    ) -> Result<(), &'static str> {
        self.policy
            .enter(member.user_id, member.domain_owner, password, invite)
    }

    pub fn update(
        &mut self,
        member: Member,
        name: String,
        access: RoomAccess,
        hidden: bool,
        password: Option<Option<String>>,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        self.policy.update(name, access, hidden, password)
    }

    pub fn invite(&mut self, member: Member) -> Result<String, &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        self.policy.invite()
    }

    pub fn revoke(&mut self, member: Member, target: Member) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Manage)?;
        if self.policy.access != RoomAccess::Private
            || self.policy.manages(target.user_id, target.domain_owner)
        {
            return Err("forbidden");
        }
        self.policy.grants.remove(&target.user_id);
        Ok(())
    }

    pub fn history(
        &self,
        member: Member,
        before: Option<u64>,
    ) -> Result<HistoryRequest, &'static str> {
        self.authorize(member, RoomPermission::Read)?;
        Ok(HistoryRequest::Read {
            room_id: self.policy.id.clone(),
            before,
        })
    }

    pub fn chat(
        &self,
        member: Member,
        text: String,
        nonce: String,
        attachments: Vec<Uuid>,
        now: u64,
    ) -> Result<HistoryRequest, &'static str> {
        self.authorize(member, RoomPermission::Write)?;
        Ok(HistoryRequest::Send {
            room_id: self.policy.id.clone(),
            draft: MessageDraft::new(member.user_id, nonce, text, attachments, now)?,
        })
    }

    pub fn publications(&self) -> impl Iterator<Item = &PublicationInfo> {
        self.publications
            .values()
            .map(|publication| &publication.info)
    }

    pub fn publication(&self, id: Uuid) -> Option<&PublicationInfo> {
        self.publications
            .get(&id)
            .map(|publication| &publication.info)
    }

    pub fn publish(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        kind: Kind,
        muted: bool,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Write)?;
        let muted = if kind == Kind::Voice {
            self.activity
                .get(&session)
                .and_then(|activity| activity.voice.as_ref())
                .ok_or("voice_not_joined")?
                .muted
        } else {
            muted
        };
        if let Some(publication) = self.publications.get_mut(&id) {
            if publication.info.session_id != session || publication.info.kind != kind {
                return Err("publication_identity_conflict");
            }
            publication.info.muted = muted;
        } else {
            if self.publications.values().any(|publication| {
                publication.info.session_id == session && publication.info.kind == kind
            }) {
                return Err("source_already_published");
            }
            self.publications.insert(
                id,
                Publication {
                    info: PublicationInfo {
                        id,
                        room_id: self.policy.id.clone(),
                        session_id: session,
                        user_id: member.user_id,
                        kind,
                        muted,
                    },
                    plan: Plan::new(session),
                },
            );
        }
        Ok(())
    }

    pub fn unpublish(&mut self, session: Uuid, id: Uuid) -> Result<bool, &'static str> {
        let Some(publication) = self.publications.get(&id) else {
            return Ok(false);
        };
        if publication.info.session_id != session {
            return Err("not_publication_owner");
        }
        self.publications.remove(&id);
        Ok(true)
    }

    pub fn subscribe(
        &mut self,
        member: Member,
        session: Uuid,
        id: Uuid,
        enabled: bool,
    ) -> Result<bool, &'static str> {
        self.authorize(member, RoomPermission::Write)?;
        let publication = self
            .publications
            .get(&id)
            .ok_or("publication_unavailable")?;
        if publication.info.kind != Kind::Screen || publication.info.session_id == session {
            return Err("invalid_subscription");
        }
        let activity = self.activity.entry(session).or_default();
        Ok(if enabled {
            activity.watching.insert(id)
        } else {
            activity.watching.remove(&id)
        })
    }

    pub fn voice(&self) -> impl Iterator<Item = &VoiceInfo> {
        self.activity
            .values()
            .filter_map(|activity| activity.voice.as_ref())
    }

    pub fn voice_joined(&self, session: Uuid) -> bool {
        self.activity
            .get(&session)
            .is_some_and(|activity| activity.voice.is_some())
    }

    pub fn set_voice(
        &mut self,
        member: Member,
        session: Uuid,
        joined: bool,
        muted: bool,
        deafened: bool,
    ) -> Result<(), &'static str> {
        self.authorize(member, RoomPermission::Write)?;
        self.activity.entry(session).or_default().voice = joined.then(|| VoiceInfo {
            session_id: session,
            room_id: self.policy.id.clone(),
            muted,
            deafened,
        });
        self.publications.retain(|_, publication| {
            publication.info.session_id != session || publication.info.kind != Kind::Voice || joined
        });
        for publication in self.publications.values_mut().filter(|publication| {
            publication.info.session_id == session && publication.info.kind == Kind::Voice
        }) {
            publication.info.muted = muted;
        }
        Ok(())
    }

    pub fn subscriptions(&self, session: Uuid) -> BTreeSet<Uuid> {
        let Some(activity) = self.activity.get(&session) else {
            return BTreeSet::new();
        };
        let mut requested = activity.watching.clone();
        if activity.voice.is_some() {
            requested.extend(
                self.publications
                    .values()
                    .filter(|publication| {
                        publication.info.kind == Kind::Voice
                            && publication.info.session_id != session
                    })
                    .map(|publication| publication.info.id),
            );
        }
        requested
    }

    pub fn retire_session(&mut self, session: Uuid) {
        self.publications
            .retain(|_, publication| publication.info.session_id != session);
        self.activity.remove(&session);
    }

    pub fn reconcile(&mut self, endpoints: &BTreeMap<Uuid, Endpoint>) {
        let available: BTreeSet<_> = endpoints
            .iter()
            .filter_map(|(session, endpoint)| {
                self.authorize(endpoint.member, RoomPermission::Write)
                    .is_ok()
                    .then_some(*session)
            })
            .collect();
        self.publications
            .retain(|_, publication| available.contains(&publication.info.session_id));
        self.activity
            .retain(|session, _| available.contains(session));
        for activity in self.activity.values_mut() {
            activity
                .watching
                .retain(|id| self.publications.contains_key(id));
        }
        let requested: BTreeMap<_, _> = self
            .activity
            .keys()
            .map(|session| (*session, self.subscriptions(*session)))
            .collect();
        let connected = endpoints
            .iter()
            .filter_map(|(session, endpoint)| {
                (endpoint.connected && available.contains(session)).then_some(*session)
            })
            .collect();
        for (id, publication) in &mut self.publications {
            let subscribers = requested
                .iter()
                .filter_map(|(session, ids)| ids.contains(id).then_some(*session))
                .collect();
            publication
                .plan
                .reconcile(&subscribers, &available, &connected);
        }
    }

    pub fn flows(&self) -> impl Iterator<Item = Flow> + '_ {
        self.publications.iter().flat_map(|(id, publication)| {
            publication
                .plan
                .parents
                .iter()
                .map(move |(child, parent)| Flow {
                    publication_id: *id,
                    sender: *parent,
                    receiver: *child,
                })
        })
    }

    pub fn failed_pair(&mut self, first: Uuid, second: Uuid) {
        for publication in self.publications.values_mut() {
            publication.plan.failed(first, second);
        }
    }

    pub fn flow_state(
        &mut self,
        id: Uuid,
        receiver: Uuid,
        sender: Uuid,
        ready: bool,
    ) -> Result<bool, &'static str> {
        let publication = self
            .publications
            .get_mut(&id)
            .ok_or("publication_unavailable")?;
        if publication.plan.parents.get(&receiver) != Some(&sender) {
            return Err("not_assigned_receiver");
        }
        Ok(if ready {
            publication.plan.mark_ready(receiver, sender)
        } else {
            publication.plan.mark_unready(receiver, sender)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_projection_obeys_private_access_before_exposing_activity() {
        let owner = Member {
            user_id: Uuid::new_v4(),
            participates: true,
            domain_owner: false,
        };
        let viewer = Member {
            user_id: Uuid::new_v4(),
            ..owner
        };
        let owner_session = Uuid::new_v4();
        let viewer_session = Uuid::new_v4();
        let mut room = RoomRuntime::new(
            RoomState::new(
                "private".into(),
                "Friends".into(),
                owner.user_id,
                RoomAccess::Private,
                false,
                None,
            )
            .unwrap(),
        );
        room.grant_invited(viewer.user_id);
        let picture = Uuid::new_v4();
        let voice = Uuid::new_v4();
        room.publish(owner, owner_session, picture, Kind::Screen, false)
            .unwrap();
        room.set_voice(owner, owner_session, true, false, false)
            .unwrap();
        room.publish(owner, owner_session, voice, Kind::Voice, false)
            .unwrap();
        room.set_voice(viewer, viewer_session, true, false, false)
            .unwrap();
        room.subscribe(viewer, viewer_session, picture, true)
            .unwrap();

        let admitted = room.snapshot(viewer, viewer_session).unwrap();
        assert!(admitted.room.authorized);
        assert_eq!(admitted.publications.len(), 2);
        assert_eq!(admitted.voice.len(), 2);
        assert_eq!(
            admitted.subscriptions.into_iter().collect::<BTreeSet<_>>(),
            BTreeSet::from([picture, voice]),
        );

        room.revoke(owner, viewer).unwrap();
        let locked = room.snapshot(viewer, viewer_session).unwrap();
        assert!(!locked.room.authorized);
        assert!(!locked.room.can_manage);
        assert!(locked.publications.is_empty());
        assert!(locked.voice.is_empty());
        assert!(locked.subscriptions.is_empty());

        room.update(owner, "Friends".into(), RoomAccess::Private, true, None)
            .unwrap();
        assert!(room.snapshot(viewer, viewer_session).is_none());
        let own = room.snapshot(owner, owner_session).unwrap();
        assert!(own.room.authorized && own.room.can_manage);
        assert_eq!(own.publications.len(), 2);
    }
}
