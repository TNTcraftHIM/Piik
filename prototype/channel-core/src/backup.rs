//! Portable hosting data. Live bindings and activities never enter a backup.
pub use crate::identity::StoredUser;
use crate::{
    attachment::{AttachmentDescriptor, ATTACHMENT_LIMITS},
    history::{valid_message_reaction, MessageDraft, StoredMessage},
    wire::valid_id,
    Authority, DomainStateHeader, DurableState, RoomState,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Limit one manifest or NDJSON record, never the complete record stream.
pub const RECORD_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Metadata {
    Domain(DomainArchiveMetadata),
    Room(RoomMetadata),
    RoomCopy(RoomCopyMetadata),
}

impl Metadata {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Domain(metadata) => metadata.validate(),
            Self::Room(metadata) => metadata.validate(),
            Self::RoomCopy(metadata) => metadata.validate(),
        }
    }
}

/// Optional presentation/settings suggestions, never the source room's authority.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomCopyInfo {
    pub name: String,
    #[serde(flatten)]
    pub appearance: crate::RoomAppearance,
    pub voice_bitrate: u32,
    pub relay_capacity: u8,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomCopyMetadata {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_info: Option<RoomCopyInfo>,
    pub authors: BTreeMap<Uuid, String>,
    pub retained_files: Vec<RetainedFile>,
}

impl RoomCopyMetadata {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 2 {
            return Err("unsupported_backup_version");
        }
        if self.room_info.as_ref().is_some_and(|info| {
            crate::wire::title(&info.name).as_deref() != Some(info.name.as_str())
                || info.appearance.validate().is_err()
                || !crate::access::valid_audio_bitrate(info.voice_bitrate)
                || !(1..=crate::MAX_RELAY_CAPACITY).contains(&info.relay_capacity)
        }) || self
            .authors
            .iter()
            .any(|(id, name)| id.is_nil() || !valid_author_name(name))
        {
            return Err("invalid_room_copy");
        }
        validate_files(&self.retained_files)
    }
}

fn valid_author_name(name: &str) -> bool {
    !name.trim().is_empty() && name == name.trim() && name.encode_utf16().count() <= 40
}

/// Durable domain checkpoint, independent of the portable archive's version.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainMetadata {
    pub version: u32,
    pub state: DurableState,
    pub owner_key: String,
}

/// Portable site archive header. The live checkpoint keeps its own format.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainArchiveMetadata {
    pub version: u32,
    pub state: DomainStateHeader,
    pub owner_key: String,
}

impl DomainArchiveMetadata {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 3 {
            return Err("unsupported_backup_version");
        }
        if !valid_id(&self.owner_key) {
            return Err("invalid_owner_key");
        }
        self.state.validate()
    }

    pub fn into_metadata(self, users: Vec<StoredUser>) -> Result<DomainMetadata, &'static str> {
        let mut check = DomainArchiveCheck::new(&self)?;
        for user in &users {
            check.accept(user)?;
        }
        check.finish()?;
        let metadata = DomainMetadata {
            version: 2,
            state: DurableState {
                version: 6,
                header: self.state,
                users,
            },
            owner_key: self.owner_key,
        };
        Ok(metadata)
    }
}

impl DomainMetadata {
    pub fn archive_metadata(&self) -> Result<DomainArchiveMetadata, &'static str> {
        if self.version != 2 || self.state.version != 6 {
            return Err("unsupported_backup_version");
        }
        let metadata = DomainArchiveMetadata {
            version: 3,
            state: self.state.header.clone(),
            owner_key: self.owner_key.clone(),
        };
        let mut check = DomainArchiveCheck::new(&metadata)?;
        for user in self.users() {
            check.accept(user)?;
        }
        check.finish()?;
        Ok(metadata)
    }

    pub fn users(&self) -> &[StoredUser] {
        &self.state.users
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.clone().into_authority(vec![]).map(|_| ())
    }

    pub fn into_authority(
        self,
        ice_servers: Vec<serde_json::Value>,
    ) -> Result<Authority, &'static str> {
        if self.version != 2 {
            return Err("unsupported_backup_version");
        }
        let mut authority = Authority::new(self.owner_key, ice_servers)?;
        authority.import_state(self.state)?;
        Ok(authority)
    }
}

/// Streaming archive validation retains identity keys, never profile contents.
pub struct DomainArchiveCheck {
    seen: BTreeSet<Uuid>,
    required: BTreeSet<Uuid>,
}

impl DomainArchiveCheck {
    pub fn new(metadata: &DomainArchiveMetadata) -> Result<Self, &'static str> {
        metadata.validate()?;
        Ok(Self {
            seen: BTreeSet::new(),
            required: std::iter::once(metadata.state.owner_id)
                .chain(metadata.state.restorable_rooms.values().copied())
                .chain(metadata.state.pending_room_deletions.values().copied())
                .chain(
                    metadata
                        .state
                        .hosted_rooms
                        .values()
                        .map(|room| room.creator_id),
                )
                .collect(),
        })
    }
    pub fn accept(&mut self, user: &StoredUser) -> Result<(), &'static str> {
        user.validate()?;
        if !self.seen.insert(user.id) {
            return Err("invalid_state");
        }
        Ok(())
    }
    pub fn finish(&self) -> Result<(), &'static str> {
        if !self.required.is_subset(&self.seen) {
            return Err("invalid_state");
        }
        Ok(())
    }
}

/// Only the exporting room owner's own existing admission credential.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnCredential {
    pub user_id: Uuid,
    pub credential: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedFile {
    pub message_seq: u64,
    pub attachment: AttachmentDescriptor,
}

impl RetainedFile {
    pub fn matches(&self, row: &HistoryRow) -> bool {
        matches!(row, HistoryRow::Message(row) if row.message.message.seq == self.message_seq && row.message.message.attachments.contains(&self.attachment))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomMetadata {
    pub version: u32,
    pub domain_id: Uuid,
    pub policy: RoomState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_credential: Option<OwnCredential>,
    pub retained_files: Vec<RetainedFile>,
}

impl RoomMetadata {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 3 {
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
        validate_files(&self.retained_files)
    }
}

fn validate_files(files: &[RetainedFile]) -> Result<(), &'static str> {
    if files.len() > ATTACHMENT_LIMITS.max_retained_files {
        return Err("backup_content_limit");
    }
    let mut identities = BTreeSet::new();
    let mut sizes = BTreeMap::new();
    let mut bytes = 0;
    for file in files {
        file.attachment.validate()?;
        if file.message_seq == 0
            || file.message_seq > i64::MAX as u64
            || !identities.insert((file.message_seq, file.attachment.id))
            || sizes
                .insert(
                    file.attachment.sha256.to_ascii_lowercase(),
                    file.attachment.size,
                )
                .is_some_and(|size| size != file.attachment.size)
        {
            return Err("invalid_backup_content");
        }
        bytes += file.attachment.size;
    }
    if bytes > ATTACHMENT_LIMITS.max_retained_bytes {
        return Err("backup_content_limit");
    }
    Ok(())
}

/// One streaming import. Database unique indexes retain nonce/message identity;
/// only the bounded retained inventory and sequence floor belong here.
pub struct HistoryImport {
    previous: u64,
    pending: BTreeMap<(u64, Uuid), RetainedFile>,
}

impl HistoryImport {
    pub fn new(metadata: &RoomMetadata) -> Result<Self, &'static str> {
        metadata.validate()?;
        Ok(Self::from_files(&metadata.retained_files))
    }

    pub fn copy(metadata: &RoomCopyMetadata) -> Result<Self, &'static str> {
        metadata.validate()?;
        Ok(Self::from_files(&metadata.retained_files))
    }

    fn from_files(files: &[RetainedFile]) -> Self {
        Self {
            previous: 0,
            pending: files
                .iter()
                .cloned()
                .map(|file| ((file.message_seq, file.attachment.id), file))
                .collect(),
        }
    }

    pub fn accept(&mut self, row: &HistoryRow) -> Result<(), &'static str> {
        row.validate()?;
        let seq = row.seq();
        if seq <= self.previous {
            return Err("invalid_backup_history_order");
        }
        self.previous = seq;
        let HistoryRow::Message(live) = row else { return Ok(()); };
        let message = &live.message.message;
        for attachment in &message.attachments {
            if let Some(file) = self.pending.remove(&(message.seq, attachment.id)) {
                if !file.matches(row) {
                    return Err("backup_content_not_in_history");
                }
            }
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<(), &'static str> {
        if !self.pending.is_empty() {
            return Err("backup_content_not_in_history");
        }
        Ok(())
    }
}

/// A copy preserves historical content, but cannot impersonate a source account
/// or collide with an existing message/retry identity in the destination store.
pub struct CopyHistoryImport {
    history: HistoryImport,
    names: BTreeMap<Uuid, String>,
    authors: BTreeMap<Uuid, Uuid>,
}

impl CopyHistoryImport {
    pub fn new(metadata: RoomCopyMetadata) -> Result<Self, &'static str> {
        Ok(Self {
            history: HistoryImport::copy(&metadata)?,
            names: metadata.authors,
            authors: BTreeMap::new(),
        })
    }

    fn copied_author(&mut self, source: Uuid) -> Uuid {
        *self.authors.entry(source).or_insert_with(Uuid::new_v4)
    }

    pub fn accept(&mut self, mut row: HistoryRow) -> Result<HistoryRow, &'static str> {
        self.history.accept(&row)?;
        let HistoryRow::Message(live) = &mut row else {
            // Copies have new participant identities and cannot retry a source send.
            return Ok(HistoryRow::Deleted(DeletedHistoryRow {
                seq: row.seq(),
                retry_key: crate::history::retry_key(Uuid::new_v4(), ""),
            }));
        };
        let message = &mut live.message.message;
        for mention in &mut message.mentions {
            mention.user_id = self.copied_author(mention.user_id);
        }
        if let Some(reply) = &mut message.reply {
            reply.archived_author_name = reply
                .archived_author_name
                .take()
                .or_else(|| self.names.get(&reply.user_id).cloned());
            reply.user_id = self.copied_author(reply.user_id);
        }
        message.archived_author_name = message
            .archived_author_name
            .take()
            .or_else(|| self.names.get(&message.user_id).cloned());
        message.user_id = self.copied_author(message.user_id);
        message.id = Uuid::new_v4();
        live.nonce = Uuid::new_v4().to_string();
        Ok(row)
    }

    pub fn finish(&self) -> Result<(), &'static str> {
        self.history.finish()
    }
}

/// Deleted rows retain only the room sequence and opaque retry identity.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeletedHistoryRow {
    pub seq: u64,
    pub retry_key: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum HistoryRow {
    Deleted(DeletedHistoryRow),
    Message(LiveHistoryRow),
}

impl HistoryRow {
    pub fn seq(&self) -> u64 {
        match self {
            Self::Deleted(row) => row.seq,
            Self::Message(row) => row.message.message.seq,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Message(row) => row.validate(),
            Self::Deleted(row) if row.seq > 0 && row.seq <= i64::MAX as u64
                && row.retry_key.len() == 64
                && row.retry_key.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) => Ok(()),
            Self::Deleted(_) => Err("invalid_backup_history"),
        }
    }
}

/// A complete storage row, including the retry identity omitted from reading pages.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveHistoryRow {
    pub nonce: String,
    #[serde(flatten)]
    pub message: StoredMessage,
}

impl LiveHistoryRow {
    pub fn validate(&self) -> Result<(), &'static str> {
        let message = &self.message.message;
        if message.seq == 0
            || message.seq > i64::MAX as u64
            || message.id.is_nil()
            || message.user_id.is_nil()
            || message.reply.as_ref().is_some_and(|reply| {
                reply.seq == 0
                    || reply.seq >= message.seq
                    || reply.user_id.is_nil()
                    || reply.text.encode_utf16().count() > crate::history::REPLY_TEXT_UTF16_LIMIT
                    || reply
                        .archived_author_name
                        .as_deref()
                        .is_some_and(|name| !valid_author_name(name))
            })
            || message
                .archived_author_name
                .as_deref()
                .is_some_and(|name| !valid_author_name(name))
            || self
                .message
                .reactions
                .counts
                .iter()
                .any(|(reaction, count)| *count == 0 || !valid_message_reaction(reaction))
        {
            return Err("invalid_backup_history");
        }
        MessageDraft {
            user_id: message.user_id,
            nonce: self.nonce.clone(),
            text: message.text.clone(),
            attachments: message.attachments.clone(),
            inline_images: message.inline_images.clone(),
            mentions: message.mentions.clone(),
            reply: None, // Stored references are validated above.
            time: message.time,
        }
        .validate(true)?;
        Ok(())
    }
}
