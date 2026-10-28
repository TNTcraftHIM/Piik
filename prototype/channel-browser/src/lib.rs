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
        let Some(HistoryRequest::Send { draft, .. }) = &pending.request else {
            return Err(error("not_a_send"));
        };
        let confirmation = draft
            .prepare_confirmation(parse::<ConfirmationInput>(input)?)
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
    pub fn finish_attachment(&mut self, rows: &str) -> Result<String, JsValue> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| error("no_pending_operation"))?;
        let request = pending
            .request
            .ok_or_else(|| error("not_an_attachment_read"))?;
        let result = request
            .attachment_result(parse::<Option<ChatMessage>>(rows)?)
            .map_err(error)?;
        encode(&self.room.finish(Some(result)).map_err(error)?)
    }
    pub fn abort(&mut self, code: String) -> Result<String, JsValue> {
        self.pending = None;
        encode(&self.room.abort(code).map_err(error)?)
    }
}

#[wasm_bindgen]
pub struct AttachmentHash(piik_channel_prototype::attachment::AttachmentHash);
#[wasm_bindgen]
impl AttachmentHash {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self(Default::default())
    }
    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }
    pub fn finish(self) -> String {
        self.0.finish()
    }
}
#[wasm_bindgen]
pub fn attachment_media_type(bytes: &[u8]) -> String {
    piik_channel_prototype::attachment::sniff_media_type(bytes).into()
}
#[wasm_bindgen]
pub fn attachment_limits() -> Result<String, JsValue> {
    encode(&piik_channel_prototype::ATTACHMENT_LIMITS)
}

#[wasm_bindgen]
pub struct FileDelivery(piik_channel_prototype::file_delivery::FileDelivery);
#[wasm_bindgen]
impl FileDelivery {
    #[wasm_bindgen(constructor)]
    pub fn new(session_id: &str) -> Result<Self, JsValue> {
        Ok(Self(
            piik_channel_prototype::file_delivery::FileDelivery::new(
                Uuid::parse_str(session_id).map_err(|_| error("invalid_session"))?,
            ),
        ))
    }
    pub fn update(&mut self, plans: &str) -> Result<String, JsValue> {
        encode(&self.0.update(parse(plans)?))
    }
    pub fn start(&mut self, key: &str) -> Result<String, JsValue> {
        encode(&self.0.start(parse(key)?))
    }
    pub fn cancel(&mut self, key: &str) -> Result<String, JsValue> {
        encode(&self.0.cancel(&parse(key)?))
    }
    pub fn control(&mut self, peer: &str, control: &str) -> Result<String, JsValue> {
        encode(&self.0.control(
            Uuid::parse_str(peer).map_err(|_| error("invalid_peer"))?,
            parse(control)?,
        ))
    }
    pub fn chunk(&mut self, peer: &str, bytes: &[u8]) -> Result<String, JsValue> {
        encode(
            &self
                .0
                .chunk(
                    Uuid::parse_str(peer).map_err(|_| error("invalid_peer"))?,
                    bytes,
                )
                .map_err(error)?,
        )
    }
    pub fn read_result(
        &mut self,
        key: &str,
        offset: u64,
        bytes: Vec<u8>,
    ) -> Result<String, JsValue> {
        encode(&self.0.read_result(&parse(key)?, offset, bytes))
    }
    pub fn written(&mut self, key: &str, offset: u64, length: usize) -> Result<String, JsValue> {
        encode(&self.0.written(&parse(key)?, offset, length))
    }
    pub fn fail(&mut self, key: &str, code: &str) -> Result<String, JsValue> {
        encode(&self.0.fail(&parse(key)?, code))
    }
    pub fn peer_failed(&mut self, key: &str, peer: &str, code: &str) -> Result<String, JsValue> {
        encode(&self.0.peer_failed(
            &parse(key)?,
            Uuid::parse_str(peer).map_err(|_| error("invalid_peer"))?,
            code,
        ))
    }
    pub fn peer_unavailable(&mut self, peer: &str) -> Result<String, JsValue> {
        encode(
            &self
                .0
                .peer_unavailable(Uuid::parse_str(peer).map_err(|_| error("invalid_peer"))?),
        )
    }
}
