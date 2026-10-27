use crate::wire::{valid_id, ChatMessage, Event, MAX_MESSAGE_ATTACHMENTS};
use crate::Effects;
use std::collections::BTreeSet;
use uuid::Uuid;

pub const HISTORY_WINDOW: usize = 1000;
pub const HISTORY_PAGE: usize = 100;

pub struct MessageDraft {
    pub user_id: Uuid,
    pub nonce: String,
    pub text: String,
    pub attachments: Vec<Uuid>,
    pub time: u64,
}

impl MessageDraft {
    pub(crate) fn new(
        user_id: Uuid,
        nonce: String,
        text: String,
        attachments: Vec<Uuid>,
        time: u64,
    ) -> Result<Self, &'static str> {
        if attachments.len() > MAX_MESSAGE_ATTACHMENTS
            || attachments.iter().collect::<BTreeSet<_>>().len() != attachments.len()
        {
            return Err("invalid_attachments");
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
}

pub enum HistoryRequest {
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
    pub fn room_id(&self) -> &str {
        match self {
            Self::Read { room_id, .. } | Self::Send { room_id, .. } => room_id,
        }
    }
}

pub enum HistoryResult {
    Page {
        messages: Vec<ChatMessage>,
        has_more: bool,
        oldest_seq: Option<u64>,
        before: Option<u64>,
    },
    Sent {
        message: ChatMessage,
        inserted: bool,
    },
}

/// The runtime executes and finishes this effect before admitting another command.
/// Confirmation follows the room store's commit; no pending send enters core state.
pub struct HistoryEffect {
    pub request: HistoryRequest,
    pub(crate) connection: Uuid,
    pub(crate) request_id: Option<String>,
    pub(crate) audience: Vec<Uuid>,
}

impl HistoryEffect {
    pub fn finish(self, result: Result<HistoryResult, &'static str>) -> Effects {
        let mut effects = Effects::default();
        let room_id = self.request.room_id().to_owned();
        match result {
            Ok(HistoryResult::Page {
                messages,
                has_more,
                oldest_seq,
                before,
            }) => effects.events.push((
                self.connection,
                Event::History {
                    room_id,
                    messages,
                    has_more,
                    oldest_seq,
                    before,
                },
            )),
            Ok(HistoryResult::Sent { message, inserted }) => {
                if inserted {
                    effects
                        .events
                        .extend(self.audience.into_iter().map(|connection| {
                            (
                                connection,
                                Event::Message {
                                    room_id: room_id.clone(),
                                    message: message.clone(),
                                },
                            )
                        }));
                }
                effects.events.push((
                    self.connection,
                    Event::MessageConfirmed {
                        room_id,
                        message,
                        request_id: self.request_id.clone(),
                    },
                ));
            }
            Err(code) => {
                effects.events.push((
                    self.connection,
                    Event::Error {
                        code: code.into(),
                        request_id: self.request_id,
                    },
                ));
                return effects;
            }
        }
        if let Some(request_id) = self.request_id {
            effects
                .events
                .push((self.connection, Event::Ack { request_id }));
        }
        effects
    }
}
