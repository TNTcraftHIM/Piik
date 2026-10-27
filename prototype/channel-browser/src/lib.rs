use piik_channel_prototype::{
    history::{
        ConfirmationInput, HistoryRequest, HistoryResult, MessageConfirmation, HISTORY_PAGE,
    },
    host::{HostInput, RoomHost as SharedRoomHost},
    wire::{ChatMessage, RoomAccess},
    RoomState,
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
    request: Option<HistoryRequest>,
    confirmation: Option<MessageConfirmation>,
}

/// Browser bindings for the shared room dispatch and its one pending storage turn.
#[wasm_bindgen]
pub struct RoomHost {
    room: SharedRoomHost,
    pending: Option<Pending>,
}

#[wasm_bindgen]
impl RoomHost {
    #[wasm_bindgen(constructor)]
    pub fn new(policy: &str) -> Result<RoomHost, JsValue> {
        Ok(Self {
            room: SharedRoomHost::new(parse(policy)?),
            pending: None,
        })
    }
    pub fn room_id(&self) -> String {
        self.room.policy().id.clone()
    }
    pub fn policy(&self) -> Result<String, JsValue> {
        encode(self.room.policy())
    }
    pub fn summary(&self) -> Result<String, JsValue> {
        encode(&self.room.summary())
    }
    pub fn page_size(&self) -> usize {
        HISTORY_PAGE
    }
    pub fn dispatch(&mut self, input: &str) -> Result<String, JsValue> {
        let mut work = self
            .room
            .dispatch(parse::<HostInput>(input)?)
            .map_err(error)?;
        let output = encode(&work)?;
        self.pending = Some(Pending {
            request: work.history.take(),
            confirmation: None,
        });
        Ok(output)
    }
    pub fn prepare_confirmation(&mut self, input: &str) -> Result<String, JsValue> {
        let pending = self
            .pending
            .as_mut()
            .ok_or_else(|| error("no_pending_operation"))?;
        let Some(HistoryRequest::Send { room_id, draft }) = &pending.request else {
            return Err(error("not_a_send"));
        };
        let confirmation = draft
            .prepare_confirmation(room_id, parse::<ConfirmationInput>(input)?)
            .map_err(error)?;
        let output = encode(&confirmation)?;
        pending.confirmation = Some(confirmation);
        Ok(output)
    }
    /// Called only after requested storage completes; this binding sends no network ack.
    pub fn finish(&mut self) -> Result<String, JsValue> {
        self.pending = None;
        encode(&self.room.finish(None).map_err(error)?)
    }
    pub fn finish_send(&mut self) -> Result<String, JsValue> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| error("no_pending_operation"))?;
        let confirmation = pending.confirmation.ok_or_else(|| error("not_prepared"))?;
        encode(
            &self
                .room
                .finish(Some(HistoryResult::Sent(confirmation)))
                .map_err(error)?,
        )
    }
    pub fn finish_read(&mut self, rows: &str, oldest_seq: Option<u64>) -> Result<String, JsValue> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| error("no_pending_operation"))?;
        let Some(HistoryRequest::Read { before, .. }) = pending.request else {
            return Err(error("not_a_read"));
        };
        let result = HistoryResult::page(parse::<Vec<ChatMessage>>(rows)?, oldest_seq, before);
        encode(&self.room.finish(Some(result)).map_err(error)?)
    }
    pub fn abort(&mut self, code: String) -> Result<String, JsValue> {
        self.pending = None;
        encode(&self.room.abort(code).map_err(error)?)
    }
}
