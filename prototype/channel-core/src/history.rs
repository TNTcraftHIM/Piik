use crate::attachment::{AttachmentDescriptor, ATTACHMENT_LIMITS};
use crate::wire::{valid_id, ChatMessage};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const HISTORY_WINDOW: usize = 1000;
// Each retained message has a body and a reaction snapshot on the peer wire.
pub const HISTORY_PAGE: usize = 50;

#[derive(Clone, Default, Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageReactions {
    pub revision: u64,
    pub choices: BTreeMap<Uuid, BTreeSet<String>>,
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
    pub snapshot: MessageReactionSnapshot,
    pub changed: bool,
}

pub fn valid_message_reaction(reaction: &str) -> bool {
    crate::conversation::INTERACTION_REACTIONS.contains(&reaction)
        && !matches!(reaction, "tomato" | "poop")
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDraft {
    pub user_id: Uuid,
    pub nonce: String,
    pub text: String,
    pub attachments: Vec<AttachmentDescriptor>,
    pub time: u64,
}

impl MessageDraft {
    pub(crate) fn new(
        user_id: Uuid,
        nonce: String,
        text: String,
        attachments: Vec<AttachmentDescriptor>,
        time: u64,
    ) -> Result<Self, &'static str> {
        if attachments.len() > ATTACHMENT_LIMITS.max_attachments_per_message
            || attachments
                .iter()
                .map(|file| file.id)
                .collect::<BTreeSet<_>>()
                .len()
                != attachments.len()
        {
            return Err("invalid_attachments");
        }
        for attachment in &attachments {
            attachment.validate()?;
        }
        if (text.trim().is_empty() && attachments.is_empty())
            || text.chars().count() > 2000
            || !valid_id(&nonce)
        {
            return Err("invalid_message");
        }
        Ok(Self {
            user_id,
            nonce,
            text: text.trim().to_owned(),
            attachments,
            time,
        })
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
            ConfirmationInput::New { last_seq } => Ok(MessageConfirmation {
                message: StoredMessage {
                    message: ChatMessage {
                        seq: last_seq + 1,
                        id: Uuid::new_v4(),
                        user_id: self.user_id,
                        text: self.text.clone(),
                        time: self.time,
                        attachments: self.attachments.clone(),
                    },
                    reactions: MessageReactions::default(),
                },
                inserted: true,
            }),
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
    Existing { message: StoredMessage },
    New { last_seq: u64 },
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
    SetReaction {
        room_id: String,
        message_seq: u64,
        user_id: Uuid,
        reaction: String,
        active: bool,
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
    Send {
        room_id: String,
        draft: MessageDraft,
    },
}

impl HistoryRequest {
    /// Read the row, apply this explicit choice, and commit it in one transaction.
    pub fn reaction_result(
        &self,
        message: Option<StoredMessage>,
    ) -> Result<ReactionConfirmation, &'static str> {
        let Self::SetReaction {
            message_seq,
            user_id,
            reaction,
            active,
            ..
        } = self
        else {
            return Err("not_a_reaction_update");
        };
        if !valid_message_reaction(reaction) {
            return Err("invalid_reaction");
        }
        let mut message = message
            .filter(|message| message.message.seq == *message_seq)
            .ok_or("message_unavailable")?;
        let choices = &mut message.reactions.choices;
        let changed = if *active {
            choices
                .entry(*user_id)
                .or_default()
                .insert(reaction.clone())
        } else if let Some(selected) = choices.get_mut(user_id) {
            let removed = selected.remove(reaction);
            if selected.is_empty() {
                choices.remove(user_id);
            }
            removed
        } else {
            false
        };
        if changed {
            message.reactions.revision += 1;
        }
        Ok(ReactionConfirmation {
            snapshot: message.reaction_snapshot(),
            changed,
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
    Reacted(ReactionConfirmation),
    Attachment {
        message_seq: u64,
        attachment: AttachmentDescriptor,
    },
    Page {
        messages: Vec<StoredMessage>,
        has_more: bool,
        oldest_seq: Option<u64>,
        before: Option<u64>,
    },
    Sent(MessageConfirmation),
}

impl HistoryResult {
    pub fn page(
        mut newest_first: Vec<StoredMessage>,
        oldest_seq: Option<u64>,
        before: Option<u64>,
    ) -> Self {
        let has_more = newest_first.len() > HISTORY_PAGE;
        newest_first.truncate(HISTORY_PAGE);
        newest_first.reverse();
        Self::Page {
            messages: newest_first,
            has_more,
            oldest_seq,
            before,
        }
    }
}
