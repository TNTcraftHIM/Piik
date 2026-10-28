use piik_channel_core::{
    conversation::{
        self, ConversationAddress, ConversationReply, SessionSigner as SharedSigner, SignedPacket,
    },
    history::{ConfirmationInput, HistoryRequest, HistoryResult, MessageDraft, HISTORY_PAGE},
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

#[wasm_bindgen]
pub fn prepare_confirmation(draft: &str, input: &str) -> Result<String, JsValue> {
    let confirmation = parse::<MessageDraft>(draft)?
        .prepare_confirmation(parse::<ConfirmationInput>(input)?)
        .map_err(error)?;
    encode(&HistoryResult::Sent(confirmation))
}

#[wasm_bindgen]
pub fn history_page_size() -> usize {
    HISTORY_PAGE
}

#[wasm_bindgen]
pub fn history_page(
    rows: &str,
    oldest_seq: Option<u64>,
    before: Option<u64>,
) -> Result<String, JsValue> {
    encode(&HistoryResult::page(
        parse::<Vec<ChatMessage>>(rows)?,
        oldest_seq,
        before,
    ))
}

#[wasm_bindgen]
pub fn attachment_result(request: &str, message: &str) -> Result<String, JsValue> {
    let result = parse::<HistoryRequest>(request)?
        .attachment_result(parse::<Option<ChatMessage>>(message)?)
        .map_err(error)?;
    encode(&result)
}

#[wasm_bindgen]
pub struct SessionSigner(SharedSigner);

#[wasm_bindgen]
impl SessionSigner {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: &[u8]) -> Result<Self, JsValue> {
        Ok(Self(SharedSigner::from_seed(
            seed.try_into().map_err(|_| error("invalid_request"))?,
        )))
    }
    pub fn signing_key(&self) -> Vec<u8> {
        self.0.signing_key().to_vec()
    }
    pub fn sign(&self, sender: &str, payload: &str) -> Result<String, JsValue> {
        let sender = Uuid::parse_str(sender).map_err(|_| error("invalid_request"))?;
        encode(
            &self
                .0
                .sign(sender, &parse::<serde_json::Value>(payload)?)
                .map_err(error)?,
        )
    }
}

#[wasm_bindgen]
pub fn verify_reply(packet: &str, key: &[u8]) -> Result<String, JsValue> {
    encode(
        &ConversationReply::verify(
            &parse::<SignedPacket>(packet)?,
            key.try_into().map_err(|_| error("invalid_request"))?,
        )
        .map_err(error)?,
    )
}

#[wasm_bindgen]
pub fn route_conversation(
    packet: &str,
    local: &str,
    state: &str,
    from: Option<String>,
) -> Result<String, JsValue> {
    let mut packet = parse::<SignedPacket>(packet)?;
    let local = Uuid::parse_str(local).map_err(|_| error("invalid_request"))?;
    let from = from
        .map(|id| Uuid::parse_str(&id))
        .transpose()
        .map_err(|_| error("invalid_request"))?;
    let route = conversation::route(&mut packet, local, &parse(state)?, from).map_err(error)?;
    encode(&serde_json::json!({ "packet": packet, "route": route }))
}

#[wasm_bindgen]
pub fn encode_control(frame: &str) -> Result<Vec<u8>, JsValue> {
    conversation::encode_control(&parse(frame)?).map_err(error)
}

#[wasm_bindgen]
pub fn decode_control(bytes: &[u8]) -> Result<String, JsValue> {
    encode(&conversation::decode_control(bytes).map_err(error)?)
}

#[wasm_bindgen]
pub fn conversation_replies(address: &str, result: &str) -> Result<String, JsValue> {
    let address = parse::<ConversationAddress>(address)?;
    let result = match parse::<Result<HistoryResult, String>>(result)? {
        Ok(result) => address.replies(Ok(result)),
        Err(code) => address.replies(Err(&code)),
    };
    encode(&result.map_err(error)?)
}

/// Browser bindings for the shared room dispatch; the core owns its pending turn.
#[wasm_bindgen]
pub struct RoomHost {
    room: SharedRoomHost,
}

#[wasm_bindgen]
impl RoomHost {
    #[wasm_bindgen(constructor)]
    pub fn new(policy: &str) -> Result<RoomHost, JsValue> {
        Ok(Self {
            room: SharedRoomHost::new(parse(policy)?),
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
    pub fn prepare_peer(&self, packet: &str, now: u64) -> Result<String, JsValue> {
        encode(
            &self
                .room
                .prepare_peer(&parse::<SignedPacket>(packet)?, now)
                .map_err(error)?,
        )
    }
    pub fn current_readers(&self) -> Result<String, JsValue> {
        encode(&self.room.current_readers())
    }
    pub fn dispatch(&mut self, input: &str) -> Result<String, JsValue> {
        encode(
            &self
                .room
                .dispatch(parse::<HostInput>(input)?)
                .map_err(error)?,
        )
    }
    /// Called only after requested storage completes; this binding sends no network ack.
    pub fn finish(&mut self, history: Option<String>) -> Result<String, JsValue> {
        let result = history
            .map(|value| parse::<HistoryResult>(&value))
            .transpose()?;
        encode(&self.room.finish(result).map_err(error)?)
    }
    pub fn abort(&mut self, code: String) -> Result<String, JsValue> {
        encode(&self.room.abort(code).map_err(error)?)
    }
}

#[wasm_bindgen]
pub struct AttachmentHash(piik_channel_core::attachment::AttachmentHash);
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
    piik_channel_core::attachment::sniff_media_type(bytes).into()
}
#[wasm_bindgen]
pub fn attachment_limits() -> Result<String, JsValue> {
    encode(&piik_channel_core::ATTACHMENT_LIMITS)
}

#[wasm_bindgen]
pub struct FileDelivery(piik_channel_core::file_delivery::FileDelivery);
#[wasm_bindgen]
impl FileDelivery {
    #[wasm_bindgen(constructor)]
    pub fn new(session_id: &str) -> Result<Self, JsValue> {
        Ok(Self(
            piik_channel_core::file_delivery::FileDelivery::new(
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
