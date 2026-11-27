use crate::wire::{identity_image, RoomAccess, RoomIcon};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum RoomPermission {
    Read,
    Manage,
}

/// The room host retains its picture alongside the public decorative key.
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct RoomAppearance {
    pub icon: RoomIcon,
    #[serde(
        default,
        deserialize_with = "crate::wire::avatar",
        skip_serializing_if = "Option::is_none"
    )]
    pub picture: Option<String>,
}

impl RoomAppearance {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self
            .picture
            .as_deref()
            .is_some_and(|picture| !identity_image(picture))
        {
            return Err("invalid_identity_image");
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomState {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub appearance: RoomAppearance,
    pub creator_id: Uuid,
    pub access: RoomAccess,
    pub hidden: bool,
    #[serde(default = "default_voice_bitrate")]
    pub voice_bitrate: u32,
    #[serde(default = "default_relay_capacity")]
    pub relay_capacity: u8,
    #[serde(default)]
    pub allow_service_relay: bool,
    password_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    invite_key: Option<String>,
    pub grants: BTreeSet<Uuid>,
}

pub(crate) fn default_voice_bitrate() -> u32 {
    64_000
}

pub const MAX_RELAY_CAPACITY: u8 = 20;

pub(crate) fn default_relay_capacity() -> u8 {
    2
}

/// Current Opus send range for room voice and screen source audio.
pub fn supports_audio_send_bitrate(bitrate: u32) -> bool {
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

// PHC verification uses the stored work factors. Accept the profile we generate.
fn valid_password_hash(encoded: &str) -> bool {
    let Ok(hash) = PasswordHash::new(encoded) else {
        return false;
    };
    hash.algorithm == Algorithm::default().ident()
        && hash.version == Some(Version::default().into())
        && hash.salt.is_some()
        && hash.hash.is_some()
        && Params::try_from(&hash).is_ok_and(|params| {
            params.m_cost() == Params::DEFAULT_M_COST
                && params.t_cost() == Params::DEFAULT_T_COST
                && params.p_cost() == Params::DEFAULT_P_COST
        })
}

impl RoomState {
    /// Validate retained policy without changing its password or invitation.
    pub fn validate(&self) -> Result<(), &'static str> {
        self.appearance.validate()?;
        if !crate::wire::valid_id(&self.id)
            || !(1..=MAX_RELAY_CAPACITY).contains(&self.relay_capacity)
            || !supports_audio_send_bitrate(self.voice_bitrate)
            || self.creator_id.is_nil()
            || crate::wire::title(&self.name).as_deref() != Some(self.name.as_str())
            || self.grants.iter().any(Uuid::is_nil)
            || (self.access == RoomAccess::Public && (self.hidden || self.password_hash.is_some()))
            || self
                .password_hash
                .as_ref()
                .is_some_and(|hash| !valid_password_hash(hash))
            || self
                .invite_key
                .as_ref()
                .is_some_and(|key| !crate::wire::valid_id(key))
        {
            return Err("invalid_room_policy");
        }
        Ok(())
    }

    pub fn new(
        id: String,
        name: String,
        icon: RoomIcon,
        creator_id: Uuid,
        access: RoomAccess,
        hidden: bool,
        password: Option<String>,
    ) -> Result<Self, &'static str> {
        let mut room = Self {
            id,
            name: String::new(),
            appearance: RoomAppearance::default(),
            creator_id,
            access,
            hidden,
            voice_bitrate: default_voice_bitrate(),
            relay_capacity: default_relay_capacity(),
            // A room uses the site's forwarding once offered; its manager may decline.
            allow_service_relay: true,
            password_hash: None,
            invite_key: None,
            grants: BTreeSet::new(),
        };
        room.update(
            name,
            RoomAppearance {
                icon,
                picture: None,
            },
            access,
            hidden,
            password.map(Some),
        )?;
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
        appearance: RoomAppearance,
        access: RoomAccess,
        hidden: bool,
        password: Option<Option<String>>,
    ) -> Result<(), &'static str> {
        appearance.validate()?;
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
        self.appearance = appearance;
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
        self.invite_key.as_deref().map(digest) == Some(digest(key))
    }

    pub fn enter(
        &mut self,
        user: Uuid,
        password: Option<&str>,
        invite: Option<&str>,
        now: u64,
        retry_at: &mut BTreeMap<Uuid, u64>,
    ) -> Result<bool, &'static str> {
        if self.reads(user) {
            return Ok(false);
        }
        if !invite.is_some_and(|key| self.accepts_invite(key)) {
            let (Some(password), Some(hash)) = (password, &self.password_hash) else {
                return Err("room_access_required");
            };
            retry_at.retain(|_, deadline| *deadline > now);
            if retry_at.contains_key(&user) {
                return Err("rate_limited");
            }
            if !accepts_password(hash, password) {
                const PASSWORD_RETRY_MS: u64 = 2_000;
                retry_at.insert(user, now.saturating_add(PASSWORD_RETRY_MS));
                return Err("room_access_required");
            }
        }
        Ok(self.grants.insert(user))
    }

    pub fn invite(&mut self) -> Result<String, &'static str> {
        let key = Uuid::new_v4().to_string();
        self.invite_key = Some(key.clone());
        Ok(key)
    }

    pub fn invitation(&self) -> Result<crate::wire::RoomInvitation, &'static str> {
        use crate::wire::RoomInvitation;
        Ok(match &self.invite_key {
            Some(key) => RoomInvitation::Available { key: key.clone() },
            None => RoomInvitation::Missing,
        })
    }

    pub(crate) fn has_password(&self) -> bool {
        self.password_hash.is_some()
    }
}
