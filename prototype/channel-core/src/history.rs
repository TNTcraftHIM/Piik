use crate::attachment::{AttachmentDescriptor, ImageRendition, ATTACHMENT_LIMITS};
use crate::wire::{valid_id, ChatMessage};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub fn retry_key(user_id: Uuid, nonce: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::new()
        .chain_update(user_id.as_bytes())
        .chain_update(nonce.as_bytes())
        .finalize();
    format!("{digest:x}")
}

pub const HISTORY_WINDOW: usize = 1000;
// Each retained message has a body and a reaction snapshot on the peer wire.
pub const HISTORY_PAGE: usize = 50;
pub const HISTORY_PAGE_BYTES: usize = 256 * 1024;
pub const MESSAGE_MENTION_LIMIT: usize = 64;
pub(crate) const REPLY_TEXT_UTF16_LIMIT: usize = 160;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mention {
    pub user_id: Uuid,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplyTarget {
    pub seq: u64,
    pub message_id: Uuid,
    pub notify: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageReply {
    pub seq: u64,
    pub user_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_author_name: Option<String>,
    pub text: String,
    pub notify: bool,
}

impl MessageReply {
    pub fn from_original(
        seq: u64,
        user_id: Uuid,
        text: &str,
        archived_author_name: Option<String>,
        notify: bool,
    ) -> Self {
        let mut units = 0;
        let excerpt = text
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= REPLY_TEXT_UTF16_LIMIT
            })
            .collect();
        Self {
            seq,
            user_id,
            archived_author_name,
            text: excerpt,
            notify,
        }
    }
}

fn validate_mentions(text: &str, mentions: &[Mention]) -> Result<(), &'static str> {
    if mentions.len() > MESSAGE_MENTION_LIMIT {
        return Err("invalid_mentions");
    }
    let units: Vec<_> = text.encode_utf16().collect();
    let mut previous = 0;
    for mention in mentions {
        if mention.user_id.is_nil()
            || mention.start < previous
            || mention.end > units.len()
            || mention.end <= mention.start
            || mention.end - mention.start < 2
            || units.get(mention.start) != Some(&('@' as u16))
            || String::from_utf16(&units[mention.start..mention.end]).is_err()
        {
            return Err("invalid_mentions");
        }
        previous = mention.end;
    }
    Ok(())
}

#[derive(Clone, Default, Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageReactions {
    pub revision: u64,
    pub counts: BTreeMap<String, u64>,
}

impl MessageReactions {
    pub(crate) fn add(&mut self, reaction: &str) -> Result<(), &'static str> {
        let count = self
            .counts
            .get(reaction)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or("reaction_count_full")?;
        self.revision = self.revision.checked_add(1).ok_or("reaction_count_full")?;
        self.counts.insert(reaction.into(), count);
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    #[serde(flatten)]
    pub message: ChatMessage,
    pub reactions: MessageReactions,
}

impl StoredMessage {
    pub fn reaction_snapshot(&self) -> MessageReactionSnapshot {
        MessageReactionSnapshot {
            message_id: self.message.id,
            message_seq: self.message.seq,
            reactions: self.reactions.clone(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageReactionSnapshot {
    pub message_id: Uuid,
    pub message_seq: u64,
    #[serde(flatten)]
    pub reactions: MessageReactions,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionConfirmation {
    pub nonce: u64,
    pub snapshot: MessageReactionSnapshot,
    pub event: Option<crate::conversation::ReactionEvent>,
}

pub fn valid_message_reaction(reaction: &str) -> bool {
    crate::conversation::INTERACTION_REACTIONS.contains(&reaction)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDraft {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<Mention>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<ReplyTarget>,
    pub user_id: Uuid,
    pub nonce: String,
    pub text: String,
    pub attachments: Vec<AttachmentDescriptor>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub inline_images: BTreeMap<Uuid, ImageRendition>,
    pub time: u64,
}

impl MessageDraft {
    pub fn new(
        user_id: Uuid,
        nonce: String,
        text: String,
        attachments: Vec<AttachmentDescriptor>,
        inline_images: BTreeMap<Uuid, ImageRendition>,
        mentions: Vec<Mention>,
        reply: Option<ReplyTarget>,
        time: u64,
    ) -> Result<Self, &'static str> {
        let draft = Self {
            mentions,
            reply,
            user_id,
            nonce,
            text,
            attachments,
            inline_images,
            time,
        };
        draft.validate(false)?;
        Ok(draft)
    }

    pub(crate) fn validate(&self, allow_legacy_images: bool) -> Result<(), &'static str> {
        validate_mentions(&self.text, &self.mentions)?;
        if self
            .reply
            .as_ref()
            .is_some_and(|reply| reply.seq == 0 || reply.seq > i64::MAX as u64)
        {
            return Err("invalid_reply");
        }
        if self.attachments.len() > ATTACHMENT_LIMITS.max_attachments_per_message
            || self
                .attachments
                .iter()
                .map(|file| file.id)
                .collect::<BTreeSet<_>>()
                .len()
                != self.attachments.len()
        {
            return Err("invalid_attachments");
        }
        for attachment in &self.attachments {
            attachment.validate()?;
        }
        use base64ct::{Base64, Encoding};
        let mut total = 0;
        for (id, image) in &self.inline_images {
            let attachment = self
                .attachments
                .iter()
                .find(|file| file.id == *id)
                .ok_or("invalid_inline_images")?;
            if image.width == 0
                || image.height == 0
                || image.data.len() > (ATTACHMENT_LIMITS.max_inline_image_bytes + 2) / 3 * 4
            {
                return Err("invalid_inline_images");
            }
            let bytes = Base64::decode_vec(&image.data).map_err(|_| "invalid_inline_images")?;
            total += bytes.len();
            if total > ATTACHMENT_LIMITS.max_inline_image_bytes
                || attachment.media_type == "application/octet-stream"
                || image.media_type == "application/octet-stream"
                || crate::attachment::sniff_media_type(&bytes) != image.media_type
                || (!allow_legacy_images
                    && (image.original
                        || image.width.max(image.height) > ATTACHMENT_LIMITS.max_inline_image_edge))
            {
                return Err("invalid_inline_images");
            }
            let same_digest =
                crate::attachment::sha256_hex(&bytes).eq_ignore_ascii_case(&attachment.sha256);
            if (image.original
                && (!same_digest
                    || bytes.len() as u64 != attachment.size
                    || image.media_type != attachment.media_type))
                || (!allow_legacy_images && same_digest)
            {
                return Err("invalid_inline_images");
            }
        }
        if (self.text.trim().is_empty() && self.attachments.is_empty())
            || self.text.chars().count() > 2000
            || !valid_id(&self.nonce)
        {
            return Err("invalid_message");
        }
        Ok(())
    }

    /// Read these facts and commit the returned message in the same transaction.
    /// A confirmed retry preserves its original content, even after bytes expire.
    pub fn prepare_confirmation(
        &self,
        input: ConfirmationInput,
    ) -> Result<MessageConfirmation, &'static str> {
        match input {
            ConfirmationInput::Existing { message } => Ok(MessageConfirmation {
                message,
                inserted: false,
            }),
            ConfirmationInput::New { last_seq, reply } => {
                let reply = self
                    .reply
                    .as_ref()
                    .map(|target| {
                        let original = reply
                            .filter(|message| {
                                message.seq == target.seq
                                    && message.id == target.message_id
                                    && message.seq <= last_seq
                            })
                            .ok_or("message_unavailable")?;
                        Ok::<_, &'static str>(MessageReply::from_original(
                            original.seq,
                            original.user_id,
                            &original.text,
                            original.archived_author_name,
                            target.notify,
                        ))
                    })
                    .transpose()?;
                Ok(MessageConfirmation {
                    message: StoredMessage {
                        message: ChatMessage {
                            mentions: self.mentions.clone(),
                            reply,
                            seq: last_seq + 1,
                            id: Uuid::new_v4(),
                            user_id: self.user_id,
                            archived_author_name: None,
                            text: self.text.clone(),
                            time: self.time,
                            attachments: self.attachments.clone(),
                            inline_images: self.inline_images.clone(),
                        },
                        reactions: MessageReactions::default(),
                    },
                    inserted: true,
                })
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ConfirmationInput {
    Existing {
        message: StoredMessage,
    },
    New {
        last_seq: u64,
        #[serde(default)]
        reply: Option<ChatMessage>,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageConfirmation {
    pub message: StoredMessage,
    pub inserted: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HistoryRequest {
    DeleteMessage {
        room_id: String,
        message_seq: u64,
        message_id: Uuid,
        author_id: Option<Uuid>,
    },
    ClearHistory {
        room_id: String,
        through_seq: u64,
    },
    React {
        room_id: String,
        message_seq: u64,
        message_id: Uuid,
        nonce: u64,
        event: Option<crate::conversation::ReactionEvent>,
    },
    Attachment {
        room_id: String,
        message_seq: u64,
        attachment_id: Uuid,
    },
    Read {
        room_id: String,
        before: Option<u64>,
    },
    Seek {
        room_id: String,
        after: u64,
        exclude_author: Uuid,
    },
    Send {
        room_id: String,
        draft: MessageDraft,
    },
}

impl HistoryRequest {
    /// Read the aggregate and commit a newly accepted action in one transaction.
    pub fn reaction_result(
        &self,
        message: Option<StoredMessage>,
    ) -> Result<ReactionConfirmation, &'static str> {
        let Self::React {
            message_seq,
            message_id,
            nonce,
            event,
            ..
        } = self
        else {
            return Err("not_a_reaction_update");
        };
        let mut message = message
            .filter(|message| {
                message.message.seq == *message_seq && message.message.id == *message_id
            })
            .ok_or("message_unavailable")?;
        if let Some(event) = event {
            if event.target
                != (crate::conversation::ReactionTarget::Message {
                    message_seq: *message_seq,
                    message_id: *message_id,
                })
                || !valid_message_reaction(&event.reaction)
            {
                return Err("invalid_reaction");
            }
            message.reactions.add(&event.reaction)?;
        }
        Ok(ReactionConfirmation {
            nonce: *nonce,
            snapshot: message.reaction_snapshot(),
            event: event.clone(),
        })
    }

    pub fn attachment_result(
        &self,
        message: Option<StoredMessage>,
    ) -> Result<HistoryResult, &'static str> {
        let Self::Attachment {
            message_seq,
            attachment_id,
            ..
        } = self
        else {
            return Err("not_an_attachment_read");
        };
        let message = message
            .filter(|message| message.message.seq == *message_seq)
            .ok_or("attachment_unavailable")?;
        let attachment = message
            .message
            .attachments
            .into_iter()
            .find(|file| file.id == *attachment_id)
            .ok_or("attachment_unavailable")?;
        Ok(HistoryResult::Attachment {
            author_id: message.message.user_id,
            message_seq: *message_seq,
            attachment,
        })
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HistoryResult {
    MessageDeleted {
        message_seq: u64,
    },
    HistoryCleared {
        through_seq: u64,
    },
    Reacted(ReactionConfirmation),
    Attachment {
        author_id: Uuid,
        message_seq: u64,
        attachment: AttachmentDescriptor,
    },
    Seek {
        after: u64,
        seq: Option<u64>,
    },
    Page {
        messages: Vec<StoredMessage>,
        has_more: bool,
        oldest_seq: Option<u64>,
        before: Option<u64>,
    },
    Sent(MessageConfirmation),
}

/// The storage cursor visits newest first and stops when `push` returns false.
/// The first message always fits a page; pagination never strands a large row.
#[derive(Default)]
pub struct HistoryPage {
    messages: Vec<StoredMessage>,
    bytes: usize,
}

impl HistoryPage {
    pub fn push(&mut self, message: StoredMessage) -> Result<bool, &'static str> {
        let bytes = serde_json::to_vec(&message)
            .map_err(|_| "invalid_history_message")?
            .len();
        if !self.messages.is_empty()
            && (self.messages.len() >= HISTORY_PAGE || self.bytes + bytes > HISTORY_PAGE_BYTES)
        {
            return Ok(false);
        }
        self.bytes += bytes;
        self.messages.push(message);
        Ok(self.messages.len() < HISTORY_PAGE && self.bytes < HISTORY_PAGE_BYTES)
    }

    pub fn finish(mut self, oldest_seq: Option<u64>, before: Option<u64>) -> HistoryResult {
        let has_more = self
            .messages
            .last()
            .is_some_and(|message| oldest_seq.is_some_and(|oldest| oldest < message.message.seq));
        self.messages.reverse();
        HistoryResult::Page {
            messages: self.messages,
            has_more,
            oldest_seq,
            before,
        }
    }
}

#[cfg(test)]
mod inline_tests {
    use super::*;
    use base64ct::{Base64, Encoding};
    #[test]
    fn inline_images_require_matching_image_descriptions_and_a_message_budget() {
        let bytes = b"GIF89aoriginal-gif-bytes";
        let file = AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "image.gif".into(),
            size: bytes.len() as u64,
            media_type: "image/gif".into(),
            sha256: crate::attachment::sha256_hex(bytes),
        };
        let check = |files, images| {
            MessageDraft::new(
                Uuid::new_v4(),
                "send".into(),
                "".into(),
                files,
                images,
                vec![],
                None,
                1,
            )
        };
        let image = ImageRendition {
            data: Base64::encode_string(bytes),
            media_type: "image/gif".into(),
            original: true,
            width: 32,
            height: 32,
        };
        let images = BTreeMap::from([(file.id, image.clone())]);
        assert!(check(vec![file.clone()], images.clone()).is_err());
        let mut legacy = check(vec![file.clone()], BTreeMap::new()).unwrap();
        legacy.inline_images = images;
        assert!(legacy.validate(true).is_ok());
        legacy.attachments[0].size += 1;
        assert!(
            legacy.validate(true).is_err(),
            "archive originals require their complete size"
        );
        legacy.inline_images.get_mut(&file.id).unwrap().original = false;
        assert!(
            legacy.validate(false).is_err(),
            "relabelling the original must fail"
        );
        assert!(check(
            vec![file.clone()],
            BTreeMap::from([(Uuid::new_v4(), image.clone())])
        )
        .is_err());
        assert!(check(
            vec![file.clone()],
            BTreeMap::from([(
                file.id,
                ImageRendition {
                    data: "%%%".into(),
                    ..image.clone()
                }
            )])
        )
        .is_err());
        let mut large = vec![0; ATTACHMENT_LIMITS.max_inline_image_bytes / 2 + 1];
        large[..6].copy_from_slice(b"GIF89a");
        let files: Vec<_> = (0..2)
            .map(|_| AttachmentDescriptor {
                id: Uuid::new_v4(),
                size: large.len() as u64,
                sha256: file.sha256.clone(),
                ..file.clone()
            })
            .collect();
        let images = files
            .iter()
            .map(|a| {
                (
                    a.id,
                    ImageRendition {
                        data: Base64::encode_string(&large),
                        original: false,
                        ..image.clone()
                    },
                )
            })
            .collect();
        assert!(check(files, images).is_err());
        let preview = ImageRendition {
            data: Base64::encode_string(b"RIFFabcdWEBPpreview"),
            media_type: "image/webp".into(),
            original: false,
            width: ATTACHMENT_LIMITS.max_inline_image_edge,
            height: 640,
        };
        assert!(
            check(
                vec![file.clone()],
                BTreeMap::from([(file.id, preview.clone())])
            )
            .is_ok(),
            "an animated original can have a static thumbnail"
        );
        let original = AttachmentDescriptor {
            media_type: "image/png".into(),
            size: 4_000_000,
            sha256: "a".repeat(64),
            ..file.clone()
        };
        assert!(
            check(
                vec![original.clone()],
                BTreeMap::from([(file.id, preview.clone())])
            )
            .is_ok(),
            "a display rendition does not pretend to have the original's digest or size"
        );
        for invalid in [
            ImageRendition {
                original: true,
                ..preview.clone()
            },
            ImageRendition {
                width: ATTACHMENT_LIMITS.max_inline_image_edge + 1,
                ..preview.clone()
            },
            ImageRendition {
                height: 0,
                ..preview.clone()
            },
            ImageRendition {
                media_type: "image/png".into(),
                ..preview.clone()
            },
        ] {
            assert!(check(vec![original.clone()], BTreeMap::from([(file.id, invalid)])).is_err());
        }
        let mut encoded = serde_json::to_value(&preview).unwrap();
        encoded["width"] = serde_json::json!(u32::MAX as u64 + 1);
        assert!(serde_json::from_value::<ImageRendition>(encoded).is_err());
        assert!(
            serde_json::from_value::<ImageRendition>(serde_json::json!("old-base64-value"))
                .is_err()
        );
    }
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    #[test]
    fn message_whitespace_and_mentions_share_the_original_text() {
        let user = Uuid::new_v4();
        let text =
            "\n    const name = \"@Zo\";  \n    https://example.test/#room=abc&invite=fixture\n\n";
        let make = |text: &str, mentions| {
            MessageDraft::new(
                user,
                "spaces".into(),
                text.into(),
                vec![],
                BTreeMap::new(),
                mentions,
                None,
                1,
            )
        };
        let start = text[..text.find("@Zo").unwrap()].encode_utf16().count();
        let mention = Mention {
            user_id: user,
            start,
            end: start + 3,
        };
        let draft = make(text, vec![mention.clone()]).unwrap();
        assert_eq!(draft.text, text);
        assert_eq!(draft.mentions[0].start, start);
        assert_eq!(draft.mentions[0].end, start + 3);
        assert!(make(" \n\t ", vec![]).is_err());
        assert!(make(
            text,
            vec![Mention {
                start: start - 1,
                end: start + 2,
                ..mention
            }]
        )
        .is_err());
    }

    #[test]
    fn mentions_follow_final_utf16_text_and_replies_use_committed_rows() {
        let user = Uuid::new_v4();
        let mention = Mention {
            user_id: user,
            start: 2,
            end: 5,
        };
        let make = |mentions, reply| {
            MessageDraft::new(
                user,
                "reference".into(),
                "\u{1f600}@Zo".into(),
                vec![],
                BTreeMap::new(),
                mentions,
                reply,
                1,
            )
        };
        let draft = make(vec![mention.clone()], None).unwrap();
        for bad in [
            Mention {
                start: 1,
                ..mention.clone()
            },
            Mention {
                end: 99,
                ..mention.clone()
            },
            Mention {
                user_id: Uuid::nil(),
                ..mention.clone()
            },
        ] {
            assert!(make(vec![bad], None).is_err());
        }
        assert!(make(vec![mention.clone(), mention], None).is_err());
        assert!(validate_mentions(
            "@\u{1f600}",
            &[Mention {
                user_id: user,
                start: 0,
                end: 2
            }]
        )
        .is_err());
        assert!(validate_mentions(
            &"@x".repeat(65),
            &(0..65)
                .map(|i| Mention {
                    user_id: user,
                    start: i * 2,
                    end: i * 2 + 2
                })
                .collect::<Vec<_>>()
        )
        .is_err());
        let mut original = draft
            .prepare_confirmation(ConfirmationInput::New {
                last_seq: 0,
                reply: None,
            })
            .unwrap()
            .message
            .message;
        original.text = "\u{1f600}".repeat(100);
        original.archived_author_name = Some("Original".into());
        let reply = make(
            vec![],
            Some(ReplyTarget {
                seq: 1,
                message_id: original.id,
                notify: false,
            }),
        )
        .unwrap();
        assert!(reply
            .prepare_confirmation(ConfirmationInput::New {
                last_seq: 1,
                reply: None
            })
            .is_err());
        let confirmed = reply
            .prepare_confirmation(ConfirmationInput::New {
                last_seq: 1,
                reply: Some(original.clone()),
            })
            .unwrap();
        let reference = confirmed.message.message.reply.unwrap();
        assert_eq!(reference.user_id, user);
        assert_eq!(reference.text.encode_utf16().count(), 160);
        assert!(!reference.notify);
        assert_eq!(
            reference.archived_author_name,
            original.archived_author_name
        );
    }
}
