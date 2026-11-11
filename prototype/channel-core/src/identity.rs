use crate::access::digest;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub const RECOVERY_MS: u64 = 20_000;
pub const MAX_SESSIONS: usize = 128;
pub const PROFILE_PAGE_SIZE: usize = 32;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: Uuid,
    pub name: String,
    pub avatar: Option<String>,
    pub version: String,
    #[serde(skip)]
    credential: [u8; 32],
}

impl User {
    pub fn summary(&self) -> crate::wire::UserSummary {
        crate::wire::UserSummary {
            id: self.id,
            name: self.name.clone(),
            version: self.version.clone(),
        }
    }
    pub fn profile(&self) -> crate::wire::UserInfo {
        crate::wire::UserInfo {
            id: self.id,
            name: self.name.clone(),
            avatar: self.avatar.clone(),
            version: self.version.clone(),
        }
    }
    pub fn set_profile(&mut self, name: String, avatar: Option<String>) {
        self.version = profile_version(&name, &avatar);
        self.name = name;
        self.avatar = avatar;
    }
}

fn profile_version(name: &str, avatar: &Option<String>) -> String {
    Sha256::digest(serde_json::to_vec(&(name, avatar)).expect("profile JSON"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
    pub owner_id: Uuid,
}

pub struct Admission<'a> {
    pub signing_key: [u8; 32],
    pub can_prepare_udp: bool,
    pub can_receive_video_layers: bool,
    pub credential: Option<&'a str>,
    pub owner_key: Option<&'a str>,
    pub resume: Option<&'a str>,
    pub name: &'a str,
}

#[derive(Clone)]
pub struct Admitted {
    pub session_id: Uuid,
    pub credential: String,
    pub replaced_connection: Option<Uuid>,
}

/// The authenticated user of an endpoint; room rights follow room ownership.
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: Uuid,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub signing_key: [u8; 32],
    pub member: Member,
    pub connected: bool,
}

impl Identity {
    pub fn profiles(
        &self,
        ids: Option<&[Uuid]>,
        after: Option<Uuid>,
        query: Option<&str>,
    ) -> Result<(Vec<crate::wire::UserInfo>, usize, Option<Uuid>), &'static str> {
        if let Some(ids) = ids {
            if ids.len() > PROFILE_PAGE_SIZE || after.is_some() || query.is_some() {
                return Err("invalid_profile_query");
            }
            let profiles: Vec<_> = ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .filter_map(|id| self.users.get(id))
                .map(User::profile)
                .collect();
            let total = profiles.len();
            return Ok((profiles, total, None));
        }
        let query: String = query.unwrap_or("").trim().nfc().collect();
        if query.encode_utf16().count() > 40 {
            return Err("invalid_profile_query");
        }
        let query = query.to_lowercase();
        let matching = || {
            self.users.values().filter(|user| {
                user.name
                    .nfc()
                    .collect::<String>()
                    .to_lowercase()
                    .contains(&query)
            })
        };
        let total = matching().count();
        let mut page = matching().filter(|user| after.is_none_or(|cursor| user.id > cursor));
        let profiles: Vec<_> = page
            .by_ref()
            .take(PROFILE_PAGE_SIZE)
            .map(User::profile)
            .collect();
        let next = page
            .next()
            .and_then(|_| profiles.last().map(|user| user.id));
        Ok((profiles, total, next))
    }

    pub fn member(&self, user_id: Uuid) -> Result<Member, &'static str> {
        self.users.get(&user_id).ok_or("invalid_credential")?;
        Ok(Member { user_id })
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

    pub fn new(owner_key: String) -> Self {
        Self {
            users: BTreeMap::new(),
            sessions: BTreeMap::new(),
            owner_key,
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
            .and_then(|value| self.user_for_credential(value));
        let owner = input.owner_key == Some(self.owner_key.as_str());
        if input.owner_key.is_some() && !owner {
            return Err("invalid_owner_key");
        }
        let user_id = if owner {
            self.owner_id
        } else if let Some(user) = existing {
            user
        } else {
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
            avatar: None,
            version: profile_version(name, &None),
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
                avatar: u.avatar.clone(),
                credential: u.credential,
            })
            .collect()
    }

    pub fn restore_users(
        &mut self,
        owner_id: Uuid,
        users: Vec<StoredUser>,
    ) -> Result<(), &'static str> {
        self.owner_id = owner_id;
        self.users = users
            .into_iter()
            .map(|u| {
                (
                    u.id,
                    User {
                        version: profile_version(&u.name, &u.avatar),
                        id: u.id,
                        name: u.name,
                        avatar: u.avatar,
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
    #[serde(deserialize_with = "crate::wire::avatar")]
    pub avatar: Option<String>,
    pub credential: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;
    fn user(identity: &Identity, admitted: &Admitted) -> Uuid {
        identity.sessions[&admitted.session_id].user_id
    }
    fn input<'a>(
        key: Option<&'a str>,
        credential: Option<&'a str>,
        resume: Option<&'a str>,
    ) -> Admission<'a> {
        Admission {
            signing_key: [1; 32],
            can_prepare_udp: false,
            can_receive_video_layers: false,
            owner_key: key,
            credential,
            resume,
            name: "Friend",
        }
    }

    #[test]
    fn open_site_creates_distinct_users_but_credentials_and_page_sessions_are_independent() {
        let mut identity = Identity::new("owner".into());
        let first = identity
            .admit(input(None, None, None), Uuid::new_v4(), 0)
            .unwrap();
        let second = identity
            .admit(input(None, None, None), Uuid::new_v4(), 0)
            .unwrap();
        let page = identity
            .admit(
                input(None, Some(&first.credential), None),
                Uuid::new_v4(),
                0,
            )
            .unwrap();
        assert_ne!(user(&identity, &first), user(&identity, &second));
        assert_eq!(user(&identity, &first), user(&identity, &page));
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
        assert_eq!(user(&identity, &owner), identity.owner_id);
        assert_ne!(user(&identity, &owner), user(&identity, &first));
        let fresh = identity
            .admit(input(None, Some("invalid"), None), Uuid::new_v4(), 0)
            .unwrap();
        assert_ne!(user(&identity, &fresh), user(&identity, &first));
    }

    #[test]
    fn session_replacement_fences_stale_close_and_recovery_cannot_extend_expiry() {
        let mut identity = Identity::new("owner".into());
        let first_connection = Uuid::new_v4();
        let second_connection = Uuid::new_v4();
        let first = identity
            .admit(input(None, None, None), first_connection, 0)
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
    fn saved_users_restore_identity_and_credentials_without_roles() {
        let mut identity = Identity::new("owner".into());
        let owner = identity
            .admit(input(Some("owner"), None, None), Uuid::new_v4(), 0)
            .unwrap();
        let friend = identity
            .admit(input(None, None, None), Uuid::new_v4(), 0)
            .unwrap();
        let before = serde_json::to_value(identity.export_users()).unwrap();
        let mut restored = Identity::new("owner".into());
        restored
            .restore_users(
                user(&identity, &owner),
                serde_json::from_value(before.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(restored.export_users()).unwrap(),
            before
        );
        assert_eq!(
            restored.user_for_credential(&owner.credential),
            Some(user(&identity, &owner))
        );
        assert_eq!(
            restored.user_for_credential(&friend.credential),
            Some(user(&identity, &friend))
        );
        assert_eq!(restored.owner_id, user(&identity, &owner));
        assert_ne!(restored.owner_id, user(&identity, &friend));
    }
}
