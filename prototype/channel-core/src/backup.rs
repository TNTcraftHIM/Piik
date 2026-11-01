//! Portable hosting data. Live bindings and activities never enter a backup.
use crate::{
    history::{valid_message_reaction, MessageDraft, StoredMessage},
    wire::valid_id,
    Authority, DurableState, RoomState,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Metadata {
    Domain(DomainMetadata),
    Room(RoomMetadata),
}

impl Metadata {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Domain(metadata) => metadata.validate(),
            Self::Room(metadata) => metadata.validate(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainMetadata {
    pub version: u32,
    pub state: DurableState,
    pub owner_key: String,
    pub invite_key: String,
}

impl DomainMetadata {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.clone().into_authority(vec![]).map(|_| ())
    }

    pub fn into_authority(
        self,
        ice_servers: Vec<serde_json::Value>,
    ) -> Result<Authority, &'static str> {
        if self.version != 1 {
            return Err("unsupported_backup_version");
        }
        let mut authority = Authority::new(self.owner_key, self.invite_key, ice_servers)?;
        authority.import_state(self.state)?;
        Ok(authority)
    }
}

/// Only the exporting room owner's own existing admission credential.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnCredential {
    pub user_id: Uuid,
    pub credential: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomMetadata {
    pub version: u32,
    pub domain_id: Uuid,
    pub policy: RoomState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_credential: Option<OwnCredential>,
}

impl RoomMetadata {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 {
            return Err("unsupported_backup_version");
        }
        self.policy.validate()?;
        if self.domain_id.is_nil()
            || self.own_credential.as_ref().is_some_and(|owner| {
                owner.user_id != self.policy.creator_id || !valid_id(&owner.credential)
            })
        {
            return Err("invalid_backup_identity");
        }
        Ok(())
    }
}

/// A complete storage row, including the retry identity omitted from reading pages.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub nonce: String,
    #[serde(flatten)]
    pub message: StoredMessage,
}

impl HistoryRow {
    pub fn validate(&self) -> Result<(), &'static str> {
        let message = &self.message.message;
        if message.seq == 0
            || message.seq > i64::MAX as u64
            || message.id.is_nil()
            || message.user_id.is_nil()
            || self
                .message
                .reactions
                .choices
                .iter()
                .any(|(user, choices)| {
                    user.is_nil() || choices.iter().any(|choice| !valid_message_reaction(choice))
                })
        {
            return Err("invalid_backup_history");
        }
        MessageDraft::new(
            message.user_id,
            self.nonce.clone(),
            message.text.clone(),
            message.attachments.clone(),
            message.time,
        )?;
        Ok(())
    }
}
