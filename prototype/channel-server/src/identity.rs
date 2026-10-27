use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const RECOVERY_MS: u64 = 20_000;
const MAX_USERS: usize = 64;
const MAX_SESSIONS: usize = 20;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: Uuid,
    pub name: String,
    #[serde(skip)]
    pub owner: bool,
    pub roles: BTreeSet<String>,
    #[serde(skip)]
    credential: Uuid,
}

pub struct Session {
    pub id: Uuid,
    pub user_id: Uuid,
    pub connection: Option<Uuid>,
    pub disconnected_at: Option<u64>,
}

pub struct Identity {
    pub users: BTreeMap<Uuid, User>,
    pub sessions: BTreeMap<Uuid, Session>,
    pub owner_key: String,
    pub invite_key: String,
    pub owner_id: Uuid,
}

pub struct Admission<'a> {
    pub credential: Option<&'a str>,
    pub key: Option<&'a str>,
    pub resume: Option<&'a str>,
    pub name: &'a str,
}

pub struct Admitted {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub credential: String,
}

impl Identity {
    pub fn new(owner_key: String, invite_key: String) -> Self {
        Self {
            users: BTreeMap::new(),
            sessions: BTreeMap::new(),
            owner_key,
            invite_key,
            owner_id: Uuid::new_v4(),
        }
    }

    pub fn admit(
        &mut self,
        input: Admission<'_>,
        connection: Uuid,
        now: u64,
    ) -> Result<Admitted, &'static str> {
        let name = input.name.trim();
        if name.is_empty() || name.encode_utf16().count() > 40 {
            return Err("invalid_name");
        }
        let existing = input
            .credential
            .and_then(|value| Uuid::parse_str(value).ok())
            .and_then(|credential| {
                self.users
                    .values()
                    .find(|user| user.credential == credential)
                    .map(|user| user.id)
            });
        let owner = input.key == Some(self.owner_key.as_str());
        let user_id = if owner {
            self.owner_id
        } else if let Some(user) = existing {
            user
        } else {
            if input.key != Some(self.invite_key.as_str()) {
                return Err("invitation_required");
            }
            Uuid::new_v4()
        };
        let resumed = input
            .resume
            .and_then(|value| Uuid::parse_str(value).ok())
            .and_then(|token| {
                self.sessions
                    .values()
                    .find(|session| {
                        session.user_id == user_id
                            && session.id == token
                            && session
                                .disconnected_at
                                .is_none_or(|at| now.saturating_sub(at) < RECOVERY_MS)
                    })
                    .map(|session| session.id)
            });
        if resumed.is_none() && self.sessions.len() >= MAX_SESSIONS {
            return Err("channel_full");
        }
        if !self.users.contains_key(&user_id) && self.users.len() >= MAX_USERS {
            return Err("user_limit");
        }
        let user = self.users.entry(user_id).or_insert_with(|| User {
            id: user_id,
            name: name.to_owned(),
            owner,
            roles: BTreeSet::from(["member".to_owned()]),
            credential: Uuid::new_v4(),
        });
        user.name = name.to_owned();
        let credential = user.credential.to_string();
        let session_id = resumed.unwrap_or_else(Uuid::new_v4);
        let session = self.sessions.entry(session_id).or_insert_with(|| Session {
            id: session_id,
            user_id,
            connection: None,
            disconnected_at: None,
        });
        session.connection = Some(connection);
        session.disconnected_at = None;
        Ok(Admitted {
            user_id,
            session_id,
            credential,
        })
    }

    pub fn current(&self, session_id: Uuid, connection: Uuid) -> bool {
        self.sessions
            .get(&session_id)
            .is_some_and(|session| session.connection == Some(connection))
    }

    pub fn disconnect(&mut self, session_id: Uuid, connection: Uuid, now: u64) {
        if let Some(session) = self.sessions.get_mut(&session_id) {
            if session.connection == Some(connection) {
                session.connection = None;
                session.disconnected_at = Some(now);
            }
        }
    }

    pub fn expired(&self, now: u64) -> Vec<Uuid> {
        self.sessions
            .values()
            .filter(|session| {
                session
                    .disconnected_at
                    .is_some_and(|at| now.saturating_sub(at) >= RECOVERY_MS)
            })
            .map(|session| session.id)
            .collect()
    }

    pub fn assign_roles(
        &mut self,
        actor: Uuid,
        target: Uuid,
        roles: BTreeSet<String>,
    ) -> Result<(), &'static str> {
        if !self.users.get(&actor).is_some_and(|user| user.owner) {
            return Err("forbidden");
        }
        if roles
            .iter()
            .any(|role| role != "member" && role != "moderator")
        {
            return Err("unknown_role");
        }
        self.users.get_mut(&target).ok_or("unknown_user")?.roles = roles;
        Ok(())
    }

    pub fn may_manage(&self, user_id: Uuid) -> bool {
        self.users
            .get(&user_id)
            .is_some_and(|user| user.owner || user.roles.contains("moderator"))
    }

    pub fn may_participate(&self, user_id: Uuid) -> bool {
        self.users.get(&user_id).is_some_and(|user| {
            user.owner || user.roles.contains("member") || user.roles.contains("moderator")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input<'a>(
        key: Option<&'a str>,
        credential: Option<&'a str>,
        resume: Option<&'a str>,
    ) -> Admission<'a> {
        Admission {
            key,
            credential,
            resume,
            name: "Friend",
        }
    }

    #[test]
    fn invitation_admits_distinct_users_but_credentials_and_page_sessions_are_independent() {
        let mut identity = Identity::new("owner".into(), "invite".into());
        let first = identity
            .admit(input(Some("invite"), None, None), Uuid::new_v4(), 0)
            .unwrap();
        let second = identity
            .admit(input(Some("invite"), None, None), Uuid::new_v4(), 0)
            .unwrap();
        let page = identity
            .admit(
                input(None, Some(&first.credential), None),
                Uuid::new_v4(),
                0,
            )
            .unwrap();
        assert_ne!(first.user_id, second.user_id);
        assert_eq!(first.user_id, page.user_id);
        assert_ne!(first.session_id, page.session_id);
        let foreign_resume = identity
            .admit(
                input(
                    None,
                    Some(&first.credential),
                    Some(&second.session_id.to_string()),
                ),
                Uuid::new_v4(),
                0,
            )
            .unwrap();
        assert_ne!(foreign_resume.session_id, second.session_id);
        let owner = identity
            .admit(
                input(Some("owner"), Some(&first.credential), None),
                Uuid::new_v4(),
                0,
            )
            .unwrap();
        assert_eq!(owner.user_id, identity.owner_id);
        assert_ne!(owner.user_id, first.user_id);
        assert!(identity
            .admit(input(None, Some("invalid"), None), Uuid::new_v4(), 0)
            .is_err());
    }

    #[test]
    fn session_replacement_fences_stale_close_and_recovery_cannot_extend_expiry() {
        let mut identity = Identity::new("owner".into(), "invite".into());
        let first_connection = Uuid::new_v4();
        let second_connection = Uuid::new_v4();
        let first = identity
            .admit(input(Some("invite"), None, None), first_connection, 0)
            .unwrap();
        identity.disconnect(first.session_id, first_connection, 1_000);
        let next = identity
            .admit(
                input(
                    None,
                    Some(&first.credential),
                    Some(&first.session_id.to_string()),
                ),
                second_connection,
                2_000,
            )
            .unwrap();
        assert_eq!(first.session_id, next.session_id);
        identity.disconnect(first.session_id, first_connection, 3_000);
        assert!(identity.current(first.session_id, second_connection));
        identity.disconnect(first.session_id, second_connection, 4_000);
        identity.disconnect(first.session_id, second_connection, 15_000);
        assert_eq!(identity.expired(24_000), vec![first.session_id]);
        let fresh = identity
            .admit(
                input(
                    None,
                    Some(&first.credential),
                    Some(&first.session_id.to_string()),
                ),
                Uuid::new_v4(),
                25_000,
            )
            .unwrap();
        assert_ne!(first.session_id, fresh.session_id);
    }

    #[test]
    fn owner_is_not_an_exclusive_activity_role_and_only_owner_assigns_roles() {
        let mut identity = Identity::new("owner".into(), "invite".into());
        let owner = identity
            .admit(input(Some("owner"), None, None), Uuid::new_v4(), 0)
            .unwrap();
        let friend = identity
            .admit(input(Some("invite"), None, None), Uuid::new_v4(), 0)
            .unwrap();
        assert!(identity
            .assign_roles(friend.user_id, owner.user_id, BTreeSet::new())
            .is_err());
        identity
            .assign_roles(
                owner.user_id,
                friend.user_id,
                BTreeSet::from(["member".into(), "moderator".into()]),
            )
            .unwrap();
        assert!(identity.may_participate(owner.user_id));
        assert!(identity.may_manage(friend.user_id));
        identity
            .assign_roles(owner.user_id, friend.user_id, BTreeSet::new())
            .unwrap();
        assert!(!identity.may_participate(friend.user_id));
    }
}
