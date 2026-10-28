use crate::attachment::{AttachmentDescriptor, ATTACHMENT_LIMITS};
use crate::wire::{valid_id, ChatMessage};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

pub const HISTORY_WINDOW: usize = 1000;
pub const HISTORY_PAGE: usize = 100;

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
                message: ChatMessage {
                    seq: last_seq + 1,
                    id: Uuid::new_v4(),
                    user_id: self.user_id,
                    text: self.text.clone(),
                    time: self.time,
                    attachments: self.attachments.clone(),
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
    Existing { message: ChatMessage },
    New { last_seq: u64 },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageConfirmation {
    pub message: ChatMessage,
    pub inserted: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HistoryRequest {
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
    pub fn attachment_result(
        &self,
        message: Option<ChatMessage>,
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
            .filter(|message| message.seq == *message_seq)
            .ok_or("attachment_unavailable")?;
        let attachment = message
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
    Attachment {
        message_seq: u64,
        attachment: AttachmentDescriptor,
    },
    Page {
        messages: Vec<ChatMessage>,
        has_more: bool,
        oldest_seq: Option<u64>,
        before: Option<u64>,
    },
    Sent(MessageConfirmation),
}

impl HistoryResult {
    pub fn page(
        mut newest_first: Vec<ChatMessage>,
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
