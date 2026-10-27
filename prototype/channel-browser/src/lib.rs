use piik_channel_prototype::{
    history::{
        ConfirmationInput, HistoryRequest, HistoryResult, MessageConfirmation, HISTORY_PAGE,
    },
    wire::{ChatMessage, RoomAccess},
    Member, RoomPermission, RoomRuntime, RoomState,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use wasm_bindgen::prelude::*;

fn error(message: &str) -> JsValue {
    JsValue::from_str(message)
}
fn parse<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, JsValue> {
    serde_json::from_str(value).map_err(|_| error("invalid_request"))
}
fn encode(value: &impl Serialize) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|_| error("invalid_response"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewRoom {
    id: String,
    name: String,
    creator_id: Uuid,
    access: RoomAccess,
    hidden: bool,
    password: Option<String>,
}

#[wasm_bindgen]
pub fn create_room_policy(input: &str) -> Result<String, JsValue> {
    let input: NewRoom = parse(input)?;
    encode(
        &RoomState::new(
            input.id,
            input.name,
            input.creator_id,
            input.access,
            input.hidden,
            input.password,
        )
        .map_err(error)?,
    )
}

struct Pending {
    request: HistoryRequest,
    confirmation: Option<MessageConfirmation>,
}

/// One room's authority and one storage operation. It contains no domain credentials.
#[wasm_bindgen]
pub struct RoomHost {
    room: RoomRuntime,
    pending: Option<Pending>,
}

#[wasm_bindgen]
impl RoomHost {
    #[wasm_bindgen(constructor)]
    pub fn new(policy: &str) -> Result<RoomHost, JsValue> {
        Ok(Self {
            room: RoomRuntime::new(parse(policy)?),
            pending: None,
        })
    }
    pub fn room_id(&self) -> String {
        self.room.policy().id.clone()
    }
    pub fn policy(&self) -> Result<String, JsValue> {
        encode(self.room.policy())
    }
    pub fn snapshot(&self, principal: &str, session_id: &str) -> Result<String, JsValue> {
        let session = Uuid::parse_str(session_id).map_err(|_| error("invalid_session"))?;
        encode(&self.room.snapshot(parse::<Member>(principal)?, session))
    }
    pub fn page_size(&self) -> usize {
        HISTORY_PAGE
    }
    pub fn authorize_attachment(&self, principal: &str) -> Result<(), JsValue> {
        self.room
            .authorize(parse::<Member>(principal)?, RoomPermission::Write)
            .map_err(error)
    }
    pub fn begin_send(
        &mut self,
        principal: &str,
        text: String,
        nonce: String,
        attachments: &str,
        now: u64,
    ) -> Result<String, JsValue> {
        if self.pending.is_some() {
            return Err(error("operation_pending"));
        }
        let request = self
            .room
            .chat(
                parse::<Member>(principal)?,
                text,
                nonce,
                parse(attachments)?,
                now,
            )
            .map_err(error)?;
        let output = encode(&request)?;
        self.pending = Some(Pending {
            request,
            confirmation: None,
        });
        Ok(output)
    }
    pub fn begin_read(&mut self, principal: &str, before: Option<u64>) -> Result<String, JsValue> {
        if self.pending.is_some() {
            return Err(error("operation_pending"));
        }
        let request = self
            .room
            .history(parse::<Member>(principal)?, before)
            .map_err(error)?;
        let output = encode(&request)?;
        self.pending = Some(Pending {
            request,
            confirmation: None,
        });
        Ok(output)
    }
    pub fn prepare_confirmation(&mut self, input: &str) -> Result<String, JsValue> {
        let pending = self
            .pending
            .as_mut()
            .ok_or_else(|| error("no_pending_operation"))?;
        let HistoryRequest::Send { room_id, draft } = &pending.request else {
            return Err(error("not_a_send"));
        };
        let confirmation = draft
            .prepare_confirmation(room_id, parse::<ConfirmationInput>(input)?)
            .map_err(error)?;
        let output = encode(&confirmation)?;
        pending.confirmation = Some(confirmation);
        Ok(output)
    }
    /// Called only after the storage transaction completes, never request success.
    pub fn finish_send(&mut self) -> Result<String, JsValue> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| error("no_pending_operation"))?;
        let confirmation = pending.confirmation.ok_or_else(|| error("not_prepared"))?;
        encode(&HistoryResult::Sent(confirmation))
    }
    pub fn finish_read(&mut self, rows: &str, oldest_seq: Option<u64>) -> Result<String, JsValue> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| error("no_pending_operation"))?;
        let HistoryRequest::Read { before, .. } = pending.request else {
            return Err(error("not_a_read"));
        };
        encode(&HistoryResult::page(
            parse::<Vec<ChatMessage>>(rows)?,
            oldest_seq,
            before,
        ))
    }
    pub fn abort(&mut self) {
        self.pending = None;
    }
}
