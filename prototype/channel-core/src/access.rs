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
    Manage,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomState {
    pub id: String,
    pub name: String,
    pub icon: crate::wire::IdentityIcon,
    pub creator_id: Uuid,
    pub access: RoomAccess,
    pub hidden: bool,
    #[serde(default = "default_voice_bitrate")]
    pub voice_bitrate: u32,
    #[serde(default = "default_relay_capacity")]
    pub relay_capacity: u8,
    password_hash: Option<String>,
    invite_hash: Option<[u8; 32]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    invite_key: Option<String>,
    pub grants: BTreeSet<Uuid>,
}

pub(crate) fn default_voice_bitrate() -> u32 {
    64_000
}

pub(crate) fn default_relay_capacity() -> u8 {
    2
}

pub(crate) fn valid_audio_bitrate(bitrate: u32) -> bool {
    (6_000..=320_000).contains(&bitrate)
}

pub fn digest(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

pub(crate) fn hash_password(value: &str) -> Result<String, &'static str> {
    let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|_| "password_failed")?;
    Argon2::default()
        .hash_password(value.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| "password_failed")
}

pub(crate) fn accepts_password(hash: &str, value: &str) -> bool {
    value.encode_utf16().count() <= 128
        && PasswordHash::new(hash).ok().is_some_and(|hash| {
            Argon2::default()
                .verify_password(value.as_bytes(), &hash)
                .is_ok()
        })
}

impl RoomState {
    /// Validate retained policy without changing its password or invitation.
    pub fn validate(&self) -> Result<(), &'static str> {
        if !crate::wire::valid_id(&self.id)
            || !(1..=20).contains(&self.relay_capacity)
            || !valid_audio_bitrate(self.voice_bitrate)
            || self.creator_id.is_nil()
            || crate::wire::title(&self.name).as_deref() != Some(self.name.as_str())
            || self.grants.iter().any(Uuid::is_nil)
            || (self.access == RoomAccess::Public && (self.hidden || self.password_hash.is_some()))
            || self
                .password_hash
                .as_ref()
                .is_some_and(|hash| PasswordHash::new(hash).is_err())
            || self.invite_key.as_ref().is_some_and(|key| {
                !crate::wire::valid_id(key) || self.invite_hash != Some(digest(key))
            })
        {
            return Err("invalid_room_policy");
        }
        Ok(())
    }

    pub fn new(
        id: String,
        name: String,
        icon: crate::wire::IdentityIcon,
        creator_id: Uuid,
        access: RoomAccess,
        hidden: bool,
        password: Option<String>,
    ) -> Result<Self, &'static str> {
        let mut room = Self {
            id,
            name: String::new(),
            icon: icon.clone(),
            creator_id,
            access,
            hidden,
            voice_bitrate: default_voice_bitrate(),
            relay_capacity: default_relay_capacity(),
            password_hash: None,
            invite_hash: None,
            invite_key: None,
            grants: BTreeSet::new(),
        };
        room.update(name, icon, access, hidden, password.map(Some))?;
        Ok(room)
    }

    pub fn manages(&self, user: Uuid) -> bool {
        user == self.creator_id
    }
    pub fn reads(&self, user: Uuid) -> bool {
        self.access == RoomAccess::Public || self.manages(user) || self.grants.contains(&user)
    }

    pub fn update(
        &mut self,
        name: String,
        icon: crate::wire::IdentityIcon,
        access: RoomAccess,
        hidden: bool,
        password: Option<Option<String>>,
    ) -> Result<(), &'static str> {
        let name = crate::wire::title(&name).ok_or("invalid_room_name")?;
        let hash = match password {
            Some(Some(value)) => {
                if access != RoomAccess::Private
                    || value.is_empty()
                    || value.encode_utf16().count() > 128
                {
                    return Err("invalid_room_password");
                }
                Some(Some(hash_password(&value)?))
            }
            Some(None) => Some(None),
            None => None,
        };
        self.name = name;
        self.icon = icon;
        self.access = access;
        self.hidden = hidden && access == RoomAccess::Private;
        if let Some(hash) = hash {
            self.password_hash = hash;
        }
        if access == RoomAccess::Public {
            self.password_hash = None;
        }
        Ok(())
    }

    pub fn accepts_invite(&self, key: &str) -> bool {
        self.invite_hash == Some(digest(key))
    }

    pub fn enter(
        &mut self,
        user: Uuid,
        password: Option<&str>,
        invite: Option<&str>,
    ) -> Result<(), &'static str> {
        if self.reads(user) {
            return Ok(());
        }
        let valid = invite.is_some_and(|key| self.accepts_invite(key))
            || password.is_some_and(|password| {
                self.password_hash
                    .as_ref()
                    .is_some_and(|hash| accepts_password(hash, password))
            });
        if !valid {
            return Err("room_access_required");
        }
        self.grants.insert(user);
        Ok(())
    }

    pub fn invite(&mut self) -> Result<String, &'static str> {
        let key = Uuid::new_v4().to_string();
        self.invite_hash = Some(digest(&key));
        self.invite_key = Some(key.clone());
        Ok(key)
    }

    pub fn invitation(&self) -> Result<crate::wire::RoomInvitation, &'static str> {
        use crate::wire::RoomInvitation;
        Ok(match &self.invite_key {
            Some(key) => RoomInvitation::Available { key: key.clone() },
            None if self.invite_hash.is_some() => RoomInvitation::Unrecoverable,
            None => RoomInvitation::Missing,
        })
    }

    pub fn view(&self, user: Uuid) -> Option<Room> {
        let authorized = self.reads(user);
        let can_manage = self.manages(user);
        if self.hidden && !authorized {
            return None;
        }
        Some(Room {
            delivery: None,
            id: self.id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            creator_id: self.creator_id,
            access: self.access,
            hidden: self.hidden,
            has_password: self.password_hash.is_some(),
            voice_bitrate: self.voice_bitrate,
            relay_capacity: self.relay_capacity,
            relay_override: None,
            authorized,
            can_manage,
            available: true,
            reading: false,
            participant_session_ids: Vec::new(),
            capabilities: crate::wire::RoomCapabilities { attachments: false },
            members: can_manage.then(|| self.grants.iter().copied().collect()),
        })
    }
}
