use crate::wire::{Room, RoomAccess};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum RoomPermission {
    Read,
    Write,
    Manage,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomState {
    pub id: String,
    pub name: String,
    pub creator_id: Uuid,
    pub access: RoomAccess,
    pub hidden: bool,
    password_hash: Option<String>,
    invite_hash: Option<[u8; 32]>,
    pub grants: BTreeSet<Uuid>,
}

pub fn digest(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

impl RoomState {
    pub fn new(
        id: String,
        name: String,
        creator_id: Uuid,
        access: RoomAccess,
        hidden: bool,
        password: Option<String>,
    ) -> Result<Self, &'static str> {
        let mut room = Self {
            id,
            name: String::new(),
            creator_id,
            access,
            hidden,
            password_hash: None,
            invite_hash: None,
            grants: BTreeSet::new(),
        };
        room.update(name, access, hidden, password.map(Some))?;
        Ok(room)
    }

    pub fn manages(&self, user: Uuid, owner: Uuid) -> bool {
        user == owner || user == self.creator_id
    }
    pub fn reads(&self, user: Uuid, owner: Uuid) -> bool {
        self.access == RoomAccess::Public
            || self.manages(user, owner)
            || self.grants.contains(&user)
    }

    pub fn update(
        &mut self,
        name: String,
        access: RoomAccess,
        hidden: bool,
        password: Option<Option<String>>,
    ) -> Result<(), &'static str> {
        let name = name.trim();
        if name.is_empty() || name.encode_utf16().count() > 64 {
            return Err("invalid_room_name");
        }
        let hash = match password {
            Some(Some(value)) => {
                if access != RoomAccess::Private
                    || value.is_empty()
                    || value.encode_utf16().count() > 128
                {
                    return Err("invalid_room_password");
                }
                let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes())
                    .map_err(|_| "password_failed")?;
                Some(Some(
                    Argon2::default()
                        .hash_password(value.as_bytes(), &salt)
                        .map_err(|_| "password_failed")?
                        .to_string(),
                ))
            }
            Some(None) => Some(None),
            None => None,
        };
        self.name = name.to_owned();
        self.access = access;
        self.hidden = hidden && access == RoomAccess::Private;
        if let Some(hash) = hash {
            self.password_hash = hash;
        }
        if access == RoomAccess::Public {
            self.password_hash = None;
            self.invite_hash = None;
        }
        Ok(())
    }

    pub fn accepts_invite(&self, key: &str) -> bool {
        self.access == RoomAccess::Private && self.invite_hash == Some(digest(key))
    }

    pub fn enter(
        &mut self,
        user: Uuid,
        owner: Uuid,
        password: Option<&str>,
        invite: Option<&str>,
    ) -> Result<(), &'static str> {
        if self.reads(user, owner) {
            return Ok(());
        }
        let valid = invite.is_some_and(|key| self.accepts_invite(key))
            || password.is_some_and(|password| {
                password.encode_utf16().count() <= 128
                    && self.password_hash.as_ref().is_some_and(|hash| {
                        PasswordHash::new(hash).ok().is_some_and(|hash| {
                            Argon2::default()
                                .verify_password(password.as_bytes(), &hash)
                                .is_ok()
                        })
                    })
            });
        if !valid {
            return Err("room_access_required");
        }
        self.grants.insert(user);
        Ok(())
    }

    pub fn invite(&mut self) -> Result<String, &'static str> {
        if self.access != RoomAccess::Private {
            return Err("room_not_private");
        }
        let key = Uuid::new_v4().to_string();
        self.invite_hash = Some(digest(&key));
        Ok(key)
    }

    pub fn view(&self, user: Uuid, owner: Uuid) -> Option<Room> {
        let authorized = self.reads(user, owner);
        let can_manage = self.manages(user, owner);
        if self.hidden && !authorized {
            return None;
        }
        Some(Room {
            id: self.id.clone(),
            name: self.name.clone(),
            creator_id: self.creator_id,
            access: self.access,
            hidden: self.hidden,
            has_password: self.password_hash.is_some(),
            authorized,
            can_manage,
            members: can_manage.then(|| self.grants.iter().copied().collect()),
        })
    }
}
