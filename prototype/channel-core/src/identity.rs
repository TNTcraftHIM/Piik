use crate::{
    access::{accepts_password, digest, hash_password},
    wire::RoomAccess,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::BTreeMap;
use uuid::Uuid;

pub const RECOVERY_MS: u64 = 20_000;
const MAX_USERS: usize = 64;
const MAX_SESSIONS: usize = 20;

pub fn domain_invite_hash(key: &str) -> String {
    crate::attachment::sha256_hex(key.as_bytes())
}

pub(crate) fn private_access() -> RoomAccess {
    RoomAccess::Private
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: Uuid,
    pub name: String,
    #[serde(skip)]
    pub owner: bool,
    #[serde(skip)]
    credential: [u8; 32],
}

#[derive(Clone)]
pub struct Session {
    pub id: Uuid,
    pub user_id: Uuid,
    pub connection: Option<Uuid>,
    pub disconnected_at: Option<u64>,
    pub signing_key: [u8; 32],
    pub can_prepare_udp: bool,
    pub can_receive_video_layers: bool,
}

#[derive(Clone)]
pub struct Identity {
    pub users: BTreeMap<Uuid, User>,
    pub sessions: BTreeMap<Uuid, Session>,
    pub owner_key: String,
    pub invite_key: String,
    pub owner_id: Uuid,
    pub access: RoomAccess,
    pub password_hash: Option<String>,
}

pub struct Admission<'a> {
    pub signing_key: [u8; 32],
    pub can_prepare_udp: bool,
    pub can_receive_video_layers: bool,
    pub credential: Option<&'a str>,
    pub key: Option<&'a str>,
    pub password: Option<&'a str>,
    pub resume: Option<&'a str>,
    pub name: &'a str,
}

#[derive(Clone)]
pub struct Admitted {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub credential: String,
    pub replaced_connection: Option<Uuid>,
}

/// The domain's current admission, without credentials or its user database.
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: Uuid,
    pub domain_owner: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub signing_key: [u8; 32],
    pub member: Member,
    pub connected: bool,
}

impl Identity {
    pub fn member(&self, user_id: Uuid) -> Result<Member, &'static str> {
        let user = self.users.get(&user_id).ok_or("invalid_credential")?;
        Ok(Member {
            user_id,
            domain_owner: user.owner,
        })
    }

    pub fn endpoints(&self) -> BTreeMap<Uuid, Endpoint> {
        self.sessions
            .values()
            .map(|session| {
                (
                    session.id,
                    Endpoint {
                        member: self.member(session.user_id).expect("admitted session"),
                        signing_key: session.signing_key,
                        connected: session.connection.is_some(),
                    },
                )
            })
            .collect()
    }

    pub fn new(owner_key: String, invite_key: String) -> Self {
        Self {
            users: BTreeMap::new(),
            sessions: BTreeMap::new(),
            owner_key,
            invite_key,
            owner_id: Uuid::new_v4(),
            access: RoomAccess::Private,
            password_hash: None,
        }
    }

    pub fn update_admission(
        &mut self,
        access: Option<RoomAccess>,
        password: Option<Option<String>>,
    ) -> Result<(), &'static str> {
        let access = access.unwrap_or(self.access);
        if access == RoomAccess::Public {
            self.access = access;
            self.password_hash = None;
            return Ok(());
        }
        let hash = match password {
            Some(Some(value)) => {
                if value.is_empty() || value.encode_utf16().count() > 128 {
                    return Err("invalid_domain_password");
                }
                Some(Some(hash_password(&value)?))
            }
            Some(None) => Some(None),
            None => None,
        };
        self.access = access;
        if let Some(hash) = hash {
            self.password_hash = hash;
        }
        Ok(())
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
            .and_then(|value| self.user_for_credential(value));
        let owner = input.key == Some(self.owner_key.as_str());
        let user_id = if owner {
            self.owner_id
        } else if let Some(user) = existing {
            user
        } else {
            if self.access == RoomAccess::Private && input.key != Some(self.invite_key.as_str()) {
                let hash = self
                    .password_hash
                    .as_ref()
                    .ok_or("domain_invitation_required")?;
                let password = input
                    .password
                    .filter(|value| !value.is_empty())
                    .ok_or("domain_password_required")?;
                if !accepts_password(hash, password) {
                    return Err("domain_password_incorrect");
                }
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
        let credential = if owner {
            let mut mac = Hmac::<Sha256>::new_from_slice(self.owner_key.as_bytes())
                .expect("HMAC accepts any key length");
            mac.update(self.owner_id.as_bytes());
            mac.finalize()
                .into_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        } else if existing.is_some() {
            input.credential.unwrap().to_owned()
        } else {
            Uuid::new_v4().to_string()
        };
        let user = self.users.entry(user_id).or_insert_with(|| User {
            id: user_id,
            name: name.to_owned(),
            owner,
            credential: digest(&credential),
        });
        if owner {
            user.credential = digest(&credential);
        }
        let session_id = resumed.unwrap_or_else(Uuid::new_v4);
        let session = self.sessions.entry(session_id).or_insert_with(|| Session {
            id: session_id,
            user_id,
            connection: None,
            disconnected_at: None,
            signing_key: input.signing_key,
            can_prepare_udp: input.can_prepare_udp,
            can_receive_video_layers: input.can_receive_video_layers,
        });
        session.signing_key = input.signing_key;
        session.can_prepare_udp = input.can_prepare_udp;
        session.can_receive_video_layers = input.can_receive_video_layers;
        let replaced_connection = session.connection.replace(connection);
        session.disconnected_at = None;
        Ok(Admitted {
            user_id,
            session_id,
            credential,
            replaced_connection,
        })
    }

    pub fn user_for_credential(&self, credential: &str) -> Option<Uuid> {
        if credential.len() > 128 {
            return None;
        }
        let hash = digest(credential);
        self.users
            .values()
            .find(|user| user.credential == hash)
            .map(|user| user.id)
    }

    pub fn export_users(&self) -> Vec<StoredUser> {
        self.users
            .values()
            .map(|u| StoredUser {
                id: u.id,
                name: u.name.clone(),
                credential: u.credential,
            })
            .collect()
    }

    pub fn restore_users(
        &mut self,
        owner_id: Uuid,
        users: Vec<StoredUser>,
    ) -> Result<(), &'static str> {
        if users.len() > MAX_USERS {
            return Err("invalid_state");
        }
        self.owner_id = owner_id;
        self.users = users
            .into_iter()
            .map(|u| {
                (
                    u.id,
                    User {
                        id: u.id,
                        name: u.name,
                        owner: u.id == owner_id,
                        credential: u.credential,
                    },
                )
            })
            .collect();
        Ok(())
    }

    pub fn session_for_connection(&self, connection: Uuid) -> Option<Uuid> {
        self.sessions
            .values()
            .find(|session| session.connection == Some(connection))
            .map(|session| session.id)
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
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredUser {
    pub id: Uuid,
    pub name: String,
    pub credential: [u8; 32],
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
            signing_key: [1; 32],
            can_prepare_udp: false,
            can_receive_video_layers: false,
            key,
            password: None,
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
        assert_eq!(
            identity.session_for_connection(second_connection),
            Some(first.session_id)
        );
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
    fn legacy_user_records_normalize_without_losing_identity_or_credentials() {
        let mut identity = Identity::new("owner".into(), "invite".into());
        let owner = identity
            .admit(input(Some("owner"), None, None), Uuid::new_v4(), 0)
            .unwrap();
        let friend = identity
            .admit(input(Some("invite"), None, None), Uuid::new_v4(), 0)
            .unwrap();
        let before = serde_json::to_value(identity.export_users()).unwrap();
        let mut legacy = before.clone();
        for user in legacy.as_array_mut().unwrap() {
            user["roles"] = serde_json::json!([]);
        }
        let mut restored = Identity::new("owner".into(), "invite".into());
        restored
            .restore_users(owner.user_id, serde_json::from_value(legacy).unwrap())
            .unwrap();
        assert_eq!(
            serde_json::to_value(restored.export_users()).unwrap(),
            before
        );
        assert_eq!(
            restored.user_for_credential(&owner.credential),
            Some(owner.user_id)
        );
        assert_eq!(
            restored.user_for_credential(&friend.credential),
            Some(friend.user_id)
        );
        assert!(restored.member(owner.user_id).unwrap().domain_owner);
        assert!(!restored.member(friend.user_id).unwrap().domain_owner);
    }
}
