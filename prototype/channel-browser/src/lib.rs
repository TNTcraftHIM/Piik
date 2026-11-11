use piik_channel_core::{
    conversation::{
        self, ConversationAddress, ConversationReply, SessionSigner as SharedSigner, SignedPacket,
    },
    history::{
        ConfirmationInput, HistoryRequest, HistoryResult, MessageDraft, StoredMessage, HISTORY_PAGE,
    },
    host::{HostInput, RoomHost as SharedRoomHost},
    wire::RoomAccess,
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
    icon: piik_channel_core::wire::IdentityIcon,
    creator_id: Uuid,
    access: RoomAccess,
    hidden: bool,
    password: Option<String>,
    voice_bitrate: Option<u32>,
    relay_capacity: Option<u8>,
}

#[wasm_bindgen]
pub fn create_room_policy(input: &str) -> Result<String, JsValue> {
    let input: NewRoom = parse(input)?;
    let mut policy = RoomState::new(
        input.id,
        input.name,
        input.icon,
        input.creator_id,
        input.access,
        input.hidden,
        input.password,
    )
    .map_err(error)?;
    if let Some(capacity) = input.relay_capacity {
        policy.relay_capacity = capacity;
    }
    if let Some(bitrate) = input.voice_bitrate {
        policy.voice_bitrate = bitrate;
    }
    policy.validate().map_err(error)?;
    encode(&policy)
}

#[wasm_bindgen]
pub fn backup_metadata(input: &str) -> Result<String, JsValue> {
    let metadata = parse_backup::<piik_channel_core::backup::Metadata>(input)?;
    metadata.validate().map_err(error)?;
    encode(&metadata)
}

#[wasm_bindgen]
pub struct BackupHistoryImport(piik_channel_core::backup::HistoryImport);

#[wasm_bindgen]
impl BackupHistoryImport {
    #[wasm_bindgen(constructor)]
    pub fn new(metadata: &str) -> Result<Self, JsValue> {
        use piik_channel_core::backup::{HistoryImport, Metadata};
        let history = match parse_backup(metadata)? {
            Metadata::Room(metadata) => HistoryImport::new(&metadata),
            Metadata::RoomCopy(metadata) => HistoryImport::copy(&metadata),
            Metadata::Domain(_) => return Err(error("invalid_backup_kind")),
        };
        Ok(Self(history.map_err(error)?))
    }

    pub fn accept(&mut self, input: &str) -> Result<String, JsValue> {
        let row = parse_backup::<piik_channel_core::backup::HistoryRow>(input)?;
        self.0.accept(&row).map_err(error)?;
        encode(&row)
    }

    pub fn finish(&self) -> Result<(), JsValue> {
        self.0.finish().map_err(error)
    }
}

#[wasm_bindgen]
pub struct CopyHistoryImport(piik_channel_core::backup::CopyHistoryImport);

#[wasm_bindgen]
impl CopyHistoryImport {
    #[wasm_bindgen(constructor)]
    pub fn new(metadata: &str) -> Result<Self, JsValue> {
        let piik_channel_core::backup::Metadata::RoomCopy(metadata) = parse_backup(metadata)?
        else {
            return Err(error("invalid_backup_kind"));
        };
        Ok(Self(
            piik_channel_core::backup::CopyHistoryImport::new(metadata).map_err(error)?,
        ))
    }

    pub fn accept(&mut self, input: &str) -> Result<String, JsValue> {
        let row = self.0.accept(parse_backup(input)?).map_err(error)?;
        encode(&row)
    }

    pub fn finish(&self) -> Result<(), JsValue> {
        self.0.finish().map_err(error)
    }
}

#[wasm_bindgen]
pub fn backup_record_bytes() -> usize {
    piik_channel_core::backup::RECORD_BYTES
}

fn parse_backup<T: serde::de::DeserializeOwned>(input: &str) -> Result<T, JsValue> {
    if input.len() > piik_channel_core::backup::RECORD_BYTES {
        return Err(error("backup_record_too_large"));
    }
    parse(input)
}

#[wasm_bindgen]
pub fn prepare_confirmation(draft: &str, input: &str) -> Result<String, JsValue> {
    let draft = parse::<MessageDraft>(draft)?;
    let confirmation = MessageDraft::new(
        draft.user_id,
        draft.nonce,
        draft.text,
        draft.attachments,
        draft.inline_images,
        draft.time,
    )
    .map_err(error)?
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
        parse::<Vec<StoredMessage>>(rows)?,
        oldest_seq,
        before,
    ))
}

#[wasm_bindgen]
pub fn attachment_result(request: &str, message: &str) -> Result<String, JsValue> {
    let result = parse::<HistoryRequest>(request)?
        .attachment_result(parse::<Option<StoredMessage>>(message)?)
        .map_err(error)?;
    encode(&result)
}

#[wasm_bindgen]
pub fn reaction_result(request: &str, message: &str) -> Result<String, JsValue> {
    let confirmation = parse::<HistoryRequest>(request)?
        .reaction_result(parse::<Option<StoredMessage>>(message)?)
        .map_err(error)?;
    encode(&HistoryResult::Reacted(confirmation))
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
pub fn verify_conversation(packet: &str, local: &str, state: &str) -> Result<String, JsValue> {
    let packet = parse::<SignedPacket>(packet)?;
    let local = Uuid::parse_str(local).map_err(|_| error("invalid_request"))?;
    encode(&conversation::verify_delivery(&packet, local, &parse(state)?).map_err(error)?)
}

#[wasm_bindgen]
pub fn route_input(
    frame: &str,
    local: &str,
    state: &str,
    from: Option<String>,
    binding: Option<String>,
) -> Result<String, JsValue> {
    let mut frame = parse::<piik_channel_core::input::InputFrame>(frame)?;
    let local = Uuid::parse_str(local).map_err(|_| error("invalid_request"))?;
    let from = from
        .map(|id| Uuid::parse_str(&id))
        .transpose()
        .map_err(|_| error("invalid_request"))?;
    let binding = binding
        .map(|value| parse::<piik_channel_core::input::InputBinding>(&value))
        .transpose()?;
    let route =
        piik_channel_core::input::route(&mut frame, local, &parse(state)?, from, binding.as_ref())
            .map_err(error)?;
    encode(&serde_json::json!({ "frame": frame, "route": route }))
}

#[wasm_bindgen]
pub fn input_binding_current(binding: &str, local: &str, state: &str) -> bool {
    let Ok(binding) = parse::<piik_channel_core::input::InputBinding>(binding) else {
        return false;
    };
    let Ok(local) = Uuid::parse_str(local) else {
        return false;
    };
    let Ok(state) = parse(state) else {
        return false;
    };
    binding.current(local, &state)
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
pub fn conversation_broadcast(record: &str) -> Result<String, JsValue> {
    encode(&parse::<conversation::ConversationRecord>(record)?.broadcast())
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
    pub fn prepare_peer(&mut self, packet: &str, now: u64) -> Result<String, JsValue> {
        encode(
            &self
                .room
                .prepare_peer(&parse::<SignedPacket>(packet)?, now)
                .map_err(error)?,
        )
    }
    pub fn finish_peer(&mut self, address: &str, result: &str) -> Result<String, JsValue> {
        let address: ConversationAddress = parse(address)?;
        let result: Result<piik_channel_core::conversation::ConversationResult, String> =
            parse(result)?;
        let replies = match result {
            Ok(result) => self
                .room
                .finish_peer(address, Ok(result))
                .map_err(error)?
                .replies(),
            Err(code) => address.replies(Err(&code)),
        }
        .map_err(error)?;
        encode(&replies)
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
        Ok(Self(piik_channel_core::file_delivery::FileDelivery::new(
            Uuid::parse_str(session_id).map_err(|_| error("invalid_session"))?,
        )))
    }
    pub fn update(&mut self, plans: &str, room_peers: &str, now: u64) -> Result<String, JsValue> {
        encode(&self.0.update(parse(plans)?, parse(room_peers)?, now))
    }
    pub fn start(&mut self, key: &str) -> Result<String, JsValue> {
        encode(&self.0.start(parse(key)?))
    }
    pub fn cancel(&mut self, key: &str) -> Result<String, JsValue> {
        encode(&self.0.cancel(&parse(key)?))
    }
    pub fn control(&mut self, peer: &str, control: &str, now: u64) -> Result<String, JsValue> {
        encode(&self.0.control(
            Uuid::parse_str(peer).map_err(|_| error("invalid_peer"))?,
            parse(control)?,
            now,
        ))
    }
    pub fn next_deadline(&self) -> Option<u64> {
        self.0.next_deadline()
    }
    pub fn expire(&mut self, now: u64) -> Result<String, JsValue> {
        encode(&self.0.expire(now))
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
        request_id: &str,
        bytes: Vec<u8>,
    ) -> Result<String, JsValue> {
        encode(&self.0.read_result(
            &parse(key)?,
            offset,
            Uuid::parse_str(request_id).map_err(|_| error("invalid_request"))?,
            bytes,
        ))
    }
    pub fn written(&mut self, key: &str, offset: u64, length: usize) -> Result<String, JsValue> {
        encode(&self.0.written(&parse(key)?, offset, length))
    }
    pub fn peer_failed(
        &mut self,
        key: &str,
        peer: &str,
        request_id: &str,
        code: &str,
    ) -> Result<String, JsValue> {
        encode(&self.0.peer_failed(
            &parse(key)?,
            Uuid::parse_str(peer).map_err(|_| error("invalid_peer"))?,
            Uuid::parse_str(request_id).map_err(|_| error("invalid_request"))?,
            code,
        ))
    }
    pub fn request_failed(
        &mut self,
        key: &str,
        request_id: &str,
        code: &str,
    ) -> Result<String, JsValue> {
        encode(&self.0.request_failed(
            &parse(key)?,
            Uuid::parse_str(request_id).map_err(|_| error("invalid_request"))?,
            code,
        ))
    }
    pub fn peer_closed(&mut self, key: &str, peer: &str, code: &str) -> Result<String, JsValue> {
        encode(&self.0.peer_closed(
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
