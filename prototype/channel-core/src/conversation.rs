//! Signed live room conversation; domain admission supplies the trusted session keys.
use crate::{
    attachment::AttachmentDescriptor,
    file_delivery::FileControl,
    history::{HistoryRequest, HistoryResult, MessageReactionSnapshot, MessageReactions, StoredMessage},
    wire::ChatMessage,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::value::RawValue;
use uuid::Uuid;

/// One pair's bounded application queue accommodates either admitted response burst.
/// File and Watch share the bulk lane; this is not a sum of simultaneous peaks.
pub const fn data_queue_frames(bulk: bool) -> usize {
    use crate::file_delivery::{FILE_MAX_PENDING_RANGES, FILE_MAX_RANGE_FRAMES};
    use crate::watch_delivery::{WATCH_MAX_PENDING, WATCH_MAX_RANGE_FRAMES};
    if !bulk {
        return FILE_MAX_PENDING_RANGES * 4;
    }
    let file = FILE_MAX_PENDING_RANGES * FILE_MAX_RANGE_FRAMES;
    let watch = WATCH_MAX_PENDING * WATCH_MAX_RANGE_FRAMES;
    if file > watch {
        file
    } else {
        watch
    }
}

pub const CONTROL_FRAME_BYTES: usize = 32768;
pub const CONVERSATION_FRAME_BYTES: usize = 1024 * 1024;
pub const INTERACTION_INTERVAL_MS: u64 = 800;
pub const INTERACTION_REACTIONS: &[&str] = &[
    "thumbsup",
    "thumbsdown",
    "laugh",
    "clown",
    "eyeroll",
    "eyes",
    "wow",
    "wave",
    "heart",
    "clap",
    "party",
    "fire",
    "star",
    "sleep",
    "tomato",
    "poop",
];
const SIGNING_PREFIX: &[u8] = b"piik-room-conversation-v1\0";

pub struct SessionSigner(SigningKey);
impl SessionSigner {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self(SigningKey::from_bytes(&seed))
    }
    pub fn signing_key(&self) -> [u8; 32] {
        self.0.verifying_key().to_bytes()
    }
    pub fn sign(
        &self,
        sender: Uuid,
        payload: &impl Serialize,
    ) -> Result<SignedPacket, &'static str> {
        let payload = serde_json::to_string(payload).map_err(|_| "invalid_conversation")?;
        if payload.len() > CONVERSATION_FRAME_BYTES {
            return Err("control_frame_too_large");
        }
        let signature = self.0.sign(&signing_bytes(&payload)).to_bytes().to_vec();
        Ok(SignedPacket {
            sender,
            payload,
            signature,
        })
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedPacket {
    pub sender: Uuid,
    pub payload: String,
    pub signature: Vec<u8>,
}
fn signing_bytes(payload: &str) -> Vec<u8> {
    [SIGNING_PREFIX, payload.as_bytes()].concat()
}
pub fn verify<T: DeserializeOwned>(
    packet: &SignedPacket,
    key: [u8; 32],
) -> Result<T, &'static str> {
    if packet.payload.len() > CONVERSATION_FRAME_BYTES {
        return Err("control_frame_too_large");
    }
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "invalid_conversation_signature")?;
    let signature =
        Signature::from_slice(&packet.signature).map_err(|_| "invalid_conversation_signature")?;
    key.verify_strict(&signing_bytes(&packet.payload), &signature)
        .map_err(|_| "invalid_conversation_signature")?;
    serde_json::from_str(&packet.payload).map_err(|_| "invalid_conversation")
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlRole {
    Request,
    Reply,
    Notice,
}

fn known_role(operation: &str) -> Option<ControlRole> {
    match operation {
        "pull" => Some(ControlRole::Request),
        "error" => Some(ControlRole::Reply),
        "cancel" => Some(ControlRole::Notice),
        _ => None,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownControl<K> {
    #[serde(rename = "type", deserialize_with = "unknown_operation")]
    operation: String,
    pub role: ControlRole,
    pub key: K,
    pub request_id: Uuid,
}

// The untagged fallback must never accept a malformed known operation.
fn unknown_operation<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let name = String::deserialize(input)?;
    if known_role(&name).is_some() {
        return Err(serde::de::Error::custom("malformed known control"));
    }
    Ok(name)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", content = "body", rename_all = "snake_case")]
pub enum ControlFrame {
    File(FileControl),
    Watch(crate::watch_delivery::WatchControl),
}
pub fn encode_control(frame: &ControlFrame) -> Result<Vec<u8>, &'static str> {
    let mut frame = serde_json::to_value(frame).map_err(|_| "invalid_control_frame")?;
    let body = &mut frame["body"];
    if let Some(role) = body["type"].as_str().and_then(known_role) {
        body["role"] = serde_json::json!(role);
    }
    let bytes = serde_json::to_vec(&frame).map_err(|_| "invalid_control_frame")?;
    if bytes.len() > CONTROL_FRAME_BYTES {
        return Err("control_frame_too_large");
    }
    Ok(bytes)
}
pub fn decode_control(bytes: &[u8]) -> Result<ControlFrame, &'static str> {
    if bytes.len() > CONTROL_FRAME_BYTES {
        return Err("control_frame_too_large");
    }
    #[derive(Deserialize)]
    struct Envelope {
        body: Header,
    }
    #[derive(Deserialize)]
    struct Header {
        #[serde(rename = "type")]
        operation: String,
        role: ControlRole,
    }
    let Envelope { body } = serde_json::from_slice(bytes).map_err(|_| "invalid_control_frame")?;
    if known_role(&body.operation).is_some_and(|expected| expected != body.role) {
        return Err("invalid_control_frame");
    }
    serde_json::from_slice(bytes).map_err(|_| "invalid_control_frame")
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAddress {
    pub room_id: String,
    pub binding_id: Uuid,
    pub sender: Uuid,
    pub recipient: Uuid,
    pub request_id: String,
}
pub fn verify_address(
    packet: &SignedPacket,
    key: [u8; 32],
) -> Result<ConversationAddress, &'static str> {
    let address: ConversationAddress = verify(packet, key)?;
    if address.sender != packet.sender {
        return Err("invalid_conversation_sender");
    }
    Ok(address)
}

/// Only the authenticated domain facts used to verify conversation delivery.
/// Extra activity descriptions are unrelated; required authority fields have no defaults.
#[derive(Deserialize)]
pub struct ConversationView {
    channel: ConversationChannel,
    sessions: Vec<ConversationSession>,
}
#[derive(Deserialize)]
struct ConversationChannel {
    rooms: Vec<ConversationRoom>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationSession {
    id: Uuid,
    signing_key: [u8; 32],
}
#[derive(Deserialize)]
struct ConversationRoom {
    id: String,
    #[serde(flatten)]
    scope: ConversationScope,
}
#[derive(Clone, Copy, Deserialize)]
struct ConversationScope {
    authorized: bool,
    available: bool,
    delivery: Option<ConversationHost>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationHost {
    host_session_id: Uuid,
    binding_id: Uuid,
}

/// The domain is a carrier, not a room-tree neighbor or conversation authority.
pub fn verify_delivery(
    packet: &SignedPacket,
    local: Uuid,
    snapshot: &crate::wire::Snapshot,
) -> Result<ConversationAddress, &'static str> {
    verify_delivery_with(
        packet,
        local,
        snapshot
            .sessions
            .iter()
            .find(|session| session.id == packet.sender)
            .map(|session| session.signing_key),
        |id| {
            snapshot
                .channel
                .rooms
                .iter()
                .find(|room| room.id == id)
                .map(|room| ConversationScope {
                    authorized: room.authorized,
                    available: room.available,
                    delivery: room.delivery.as_ref().map(|delivery| ConversationHost {
                        host_session_id: delivery.host_session_id,
                        binding_id: delivery.binding_id,
                    }),
                })
        },
    )
    .map(|(address, _)| address)
}

/// The caller has already verified the packet signature and address.
pub struct SignedBody<'a> {
    pub role: ConversationRole,
    pub raw: &'a RawValue,
    pub kind: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ConversationRole {
    Command,
    Record,
    Notice,
}

impl<'a> SignedBody<'a> {
    pub fn read(
        packet: &'a SignedPacket,
        address: &ConversationAddress,
        writer: Uuid,
    ) -> Result<Self, &'static str> {
        #[derive(Deserialize)]
        struct Fields<'a> {
            #[serde(default, borrow, deserialize_with = "present")]
            command: Option<&'a RawValue>,
            #[serde(default, borrow, deserialize_with = "present")]
            record: Option<&'a RawValue>,
            #[serde(default, borrow, deserialize_with = "present")]
            notice: Option<&'a RawValue>,
        }
        fn present<'de, D: serde::Deserializer<'de>>(
            d: D,
        ) -> Result<Option<&'de RawValue>, D::Error> {
            Deserialize::deserialize(d).map(Some)
        }
        let fields: Fields =
            serde_json::from_str(&packet.payload).map_err(|_| "invalid_conversation")?;
        let (role, raw) = match (fields.command, fields.record, fields.notice) {
            (Some(raw), None, None) => (ConversationRole::Command, raw),
            (None, Some(raw), None) => (ConversationRole::Record, raw),
            (None, None, Some(raw)) => (ConversationRole::Notice, raw),
            _ => return Err("invalid_conversation"),
        };
        let expected_writer = if role == ConversationRole::Command {
            address.recipient
        } else {
            address.sender
        };
        if expected_writer != writer {
            return Err("invalid_conversation_sender");
        }
        if !raw.get().trim_start().starts_with('{') {
            return Err("invalid_conversation");
        }
        #[derive(Deserialize)]
        struct Kind {
            #[serde(rename = "type")]
            kind: String,
        }
        let Kind { kind } = serde_json::from_str(raw.get()).map_err(|_| "invalid_conversation")?;
        Ok(Self { role, raw, kind })
    }
}

#[derive(Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum ReceivedConversation {
    Command(ConversationAddress),
    Record {
        #[serde(flatten)]
        address: ConversationAddress,
        record: ConversationRecord,
    },
    Notice {
        #[serde(flatten)]
        address: ConversationAddress,
        notice: ConversationRecord,
    },
    UnknownRecord(ConversationAddress),
    Ignored,
}

impl ConversationView {
    pub fn verify(
        &self,
        packet: &SignedPacket,
        local: Uuid,
    ) -> Result<ReceivedConversation, &'static str> {
        let (address, host) = verify_delivery_with(
            packet,
            local,
            self.sessions
                .iter()
                .find(|session| session.id == packet.sender)
                .map(|session| session.signing_key),
            |id| {
                self.channel
                    .rooms
                    .iter()
                    .find(|room| room.id == id)
                    .map(|room| room.scope)
            },
        )?;
        let body = SignedBody::read(packet, &address, host)?;
        match body.role {
            ConversationRole::Command => Ok(ReceivedConversation::Command(address)),
            ConversationRole::Record | ConversationRole::Notice => {
                let record =
                    serde_json::from_str(body.raw.get()).map_err(|_| "invalid_conversation")?;
                Ok(match (body.role, record) {
                    (ConversationRole::Record, ConversationRecord::Unknown) => {
                        ReceivedConversation::UnknownRecord(address)
                    }
                    (ConversationRole::Notice, ConversationRecord::Unknown) => {
                        ReceivedConversation::Ignored
                    }
                    (ConversationRole::Record, record) => {
                        ReceivedConversation::Record { address, record }
                    }
                    (_, notice) => ReceivedConversation::Notice { address, notice },
                })
            }
        }
    }
}

fn verify_delivery_with(
    packet: &SignedPacket,
    local: Uuid,
    signing_key: Option<[u8; 32]>,
    room: impl FnOnce(&str) -> Option<ConversationScope>,
) -> Result<(ConversationAddress, Uuid), &'static str> {
    let address = verify_address(packet, signing_key.ok_or("session_expired")?)?;
    let scope = room(&address.room_id)
        .filter(|scope| scope.authorized && scope.available)
        .ok_or("room_unavailable")?;
    let delivery = scope.delivery.ok_or("room_host_offline")?;
    if address.recipient != local
        || address.binding_id != delivery.binding_id
        || !crate::wire::valid_id(&address.request_id)
        || (address.sender != delivery.host_session_id
            && address.recipient != delivery.host_session_id)
    {
        return Err("invalid_conversation_scope");
    }
    Ok((address, delivery.host_session_id))
}
impl ConversationAddress {
    pub fn reply(&self) -> Self {
        Self {
            sender: self.recipient,
            recipient: self.sender,
            ..self.clone()
        }
    }
}
pub const HISTORY_INLINE_IMAGES: &str = "inlineImages";

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ConversationCommand {
    DeleteMessage {
        message_seq: u64,
        message_id: Uuid,
    },
    ClearHistory {
        through_seq: u64,
    },
    InteractionReady,
    React {
        nonce: u64,
        target: ReactionTarget,
        reaction: String,
    },
    Chat {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mentions: Vec<crate::history::Mention>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply: Option<crate::history::ReplyTarget>,
        #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
        inline_images: std::collections::BTreeMap<Uuid, crate::attachment::ImageRendition>,
        text: String,
        nonce: String,
        attachments: Vec<AttachmentDescriptor>,
    },
    History {
        before: Option<u64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        parts: Vec<String>,
    },
    HistorySeek {
        after: u64,
    },
    #[serde(other, skip_serializing)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ReactionTarget {
    Message { message_seq: u64, message_id: Uuid },
    Publication { publication_id: Uuid },
    Person { user_id: Uuid },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionEvent {
    pub id: Uuid,
    pub occurred_at: u64,
    pub sender_user_id: Uuid,
    pub target: ReactionTarget,
    pub reaction: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationReactions {
    pub publication_id: Uuid,
    #[serde(flatten)]
    pub reactions: MessageReactions,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReactionSnapshot {
    Message(MessageReactionSnapshot),
    Publication(PublicationReactions),
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ConversationRequest {
    #[serde(flatten)]
    pub address: ConversationAddress,
    pub command: ConversationCommand,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ConversationRecord {
    RoomMediaCleared {
        through_seq: u64,
    },
    MessageDeleted {
        message_seq: u64,
    },
    HistoryCleared {
        through_seq: u64,
    },
    Reaction {
        nonce: u64,
        event: Option<ReactionEvent>,
        snapshot: Option<ReactionSnapshot>,
    },
    InteractionReady {
        server_time: u64,
        reaction_ids: Vec<String>,
        publication_reactions: Vec<PublicationReactions>,
    },
    Confirmed {
        message: StoredMessage,
        inserted: bool,
    },
    HistorySeekResult {
        after: u64,
        seq: Option<u64>,
    },
    HistoryPage {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        parts: Vec<String>,
        #[serde(deserialize_with = "history_messages")]
        messages: Vec<StoredMessage>,
        has_more: bool,
        oldest_seq: Option<u64>,
        before: Option<u64>,
    },
    LiveMessage {
        message: ChatMessage,
    },
    Error {
        code: String,
    },
    #[serde(other, skip_serializing)]
    Unknown,
}

impl ConversationRecord {
    /// Only new confirmed changes and live interactions fan out to other readers.
    pub fn broadcast(&self) -> Option<Self> {
        match self {
            Self::Confirmed {
                message,
                inserted: true,
            } => Some(Self::LiveMessage {
                message: message.message.clone(),
            }),
            Self::Reaction { event: Some(_), .. } => Some(self.clone()),
            _ => None,
        }
    }
}

fn history_messages<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<StoredMessage>, D::Error> {
    let messages = Vec::<StoredMessage>::deserialize(deserializer)?;
    if messages.len() > crate::history::HISTORY_PAGE
        || messages
            .iter()
            .map(|message| message.message.seq)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != messages.len()
    {
        return Err(serde::de::Error::custom("invalid history page"));
    }
    Ok(messages)
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ConversationReply {
    #[serde(flatten)]
    pub address: ConversationAddress,
    #[serde(flatten)]
    pub body: WriterBody,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WriterBody {
    Record(ConversationRecord),
    Notice(ConversationRecord),
}
impl ConversationReply {
    pub fn content(&self) -> &ConversationRecord {
        match &self.body {
            WriterBody::Record(record) | WriterBody::Notice(record) => record,
        }
    }

    pub fn verify(packet: &SignedPacket, key: [u8; 32]) -> Result<Self, &'static str> {
        let reply: Self = verify(packet, key)?;
        if reply.address.sender != packet.sender {
            return Err("invalid_conversation_sender");
        }
        Ok(reply)
    }
}
#[derive(Serialize)]
pub struct PreparedConversation {
    pub address: ConversationAddress,
    pub work: Result<ConversationWork, &'static str>,
}
#[derive(Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum ConversationWork {
    History(HistoryRequest),
    Immediate(ConversationRecord),
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum ConversationResult {
    History(HistoryResult),
    Immediate(ConversationRecord),
}
#[derive(Serialize)]
pub struct ConversationOutcome {
    /// Captured at commit while the retiring file registrations are still known.
    #[serde(skip)]
    pub(crate) removal_recipients: Vec<Uuid>,
    #[serde(rename = "projectionUpdate", skip_serializing_if = "Option::is_none")]
    pub projection_update: Option<crate::host::HostOutput>,
    pub address: ConversationAddress,
    pub result: Result<ConversationResult, &'static str>,
}
impl ConversationOutcome {
    pub fn delivery(
        self,
    ) -> Result<(Vec<ConversationReply>, Option<ConversationReply>), &'static str> {
        let replies = self.replies()?;
        let broadcast = replies.iter().find_map(|reply| {
            reply.content().broadcast().map(|record| ConversationReply {
                address: reply.address.clone(),
                body: WriterBody::Notice(record),
            })
        });
        Ok((replies, broadcast))
    }

    pub fn replies(self) -> Result<Vec<ConversationReply>, &'static str> {
        let mut replies = self.address.replies(self.result)?;
        if !self.removal_recipients.is_empty() {
            let confirmation = replies[0].clone();
            replies.extend(
                other_readers(confirmation.address.recipient, self.removal_recipients).map(
                    |recipient| ConversationReply {
                        address: ConversationAddress {
                            recipient,
                            ..confirmation.address.clone()
                        },
                        body: WriterBody::Notice(confirmation.content().clone()),
                    },
                ),
            );
        }
        Ok(replies)
    }
}
// The requester's direct reply already carries the outcome.
pub fn other_readers(requester: Uuid, readers: Vec<Uuid>) -> impl Iterator<Item = Uuid> {
    readers
        .into_iter()
        .filter(move |reader| *reader != requester)
}

impl ConversationAddress {
    pub fn replies(
        &self,
        result: Result<ConversationResult, &str>,
    ) -> Result<Vec<ConversationReply>, &'static str> {
        let records = match result {
            Err(code) => vec![ConversationRecord::Error { code: code.into() }],
            Ok(ConversationResult::Immediate(record)) => vec![record],
            Ok(ConversationResult::History(HistoryResult::MessageDeleted { message_seq })) => {
                vec![ConversationRecord::MessageDeleted { message_seq }]
            }
            Ok(ConversationResult::History(HistoryResult::HistoryCleared { through_seq })) => {
                vec![ConversationRecord::HistoryCleared { through_seq }]
            }
            Ok(ConversationResult::History(HistoryResult::Sent(confirmation))) => {
                vec![ConversationRecord::Confirmed {
                    message: confirmation.message,
                    inserted: confirmation.inserted,
                }]
            }
            Ok(ConversationResult::History(HistoryResult::Reacted(confirmation))) => {
                vec![ConversationRecord::Reaction {
                    nonce: confirmation.nonce,
                    snapshot: Some(ReactionSnapshot::Message(confirmation.snapshot)),
                    event: confirmation.event,
                }]
            }
            Ok(ConversationResult::History(HistoryResult::Seek { after, seq })) => {
                vec![ConversationRecord::HistorySeekResult { after, seq }]
            }
            Ok(ConversationResult::History(HistoryResult::Page {
                inline_images,
                messages,
                has_more,
                oldest_seq,
                before,
            })) => {
                if messages.len() > crate::history::HISTORY_PAGE {
                    return Err("invalid_conversation_result");
                }
                vec![ConversationRecord::HistoryPage {
                    parts: if inline_images {
                        vec![HISTORY_INLINE_IMAGES.into()]
                    } else {
                        Vec::new()
                    },
                    messages,
                    has_more,
                    oldest_seq,
                    before,
                }]
            }
            Ok(ConversationResult::History(HistoryResult::MediaCleared { through_seq })) => {
                vec![ConversationRecord::RoomMediaCleared { through_seq }]
            }
            Ok(ConversationResult::History(HistoryResult::Attachment { .. })) => {
                return Err("invalid_conversation_result")
            }
        };
        Ok(records
            .into_iter()
            .map(|record| ConversationReply {
                address: self.reply(),
                body: WriterBody::Record(record),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> ConversationRequest {
        ConversationRequest {
            address: ConversationAddress {
                room_id: "room".into(),
                binding_id: Uuid::new_v4(),
                sender: Uuid::new_v4(),
                recipient: Uuid::new_v4(),
                request_id: "request".into(),
            },
            command: ConversationCommand::History { before: None, parts: vec!["inlineImages".into()] },
        }
    }
    #[test]
    fn signatures_cover_original_payload_and_control_frames_remain_bounded() {
        let signer = SessionSigner::from_seed([7; 32]);
        let request = request();
        let packet = signer.sign(request.address.sender, &request).unwrap();
        let parsed: ConversationRequest = verify(&packet, signer.signing_key()).unwrap();
        assert_eq!(parsed.address, request.address);
        let mut changed = packet.clone();
        changed.payload.push(' ');
        assert!(verify::<ConversationRequest>(&changed, signer.signing_key()).is_err());
        assert!(verify::<ConversationRequest>(
            &packet,
            SessionSigner::from_seed([8; 32]).signing_key()
        )
        .is_err());
        let bytes = serde_json::to_vec(&crate::wire::Command::Conversation { packet }).unwrap();
        assert!(matches!(
            serde_json::from_slice::<crate::wire::Command>(&bytes).unwrap(),
            crate::wire::Command::Conversation { .. }
        ));
        assert!(decode_control(&vec![0; CONTROL_FRAME_BYTES + 1]).is_err());
    }
    #[test]
    fn worst_legal_message_reactions_and_history_fit_actual_signed_control_frames() {
        let signer = SessionSigner::from_seed([9; 32]);
        let mut request = request();
        request.address.room_id = "\0".repeat(128);
        request.address.request_id = "\0".repeat(128);
        use base64ct::{Base64, Encoding};
        let mut image = vec![0; crate::ATTACHMENT_LIMITS.max_inline_image_bytes / 8];
        image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let attachments: Vec<_> = (0..8)
            .map(|_| AttachmentDescriptor {
                id: Uuid::new_v4(),
                name: "\u{10ffff}".repeat(240),
                size: image.len() as u64,
                media_type: "image/png".into(),
                sha256: "a".repeat(64),
            })
            .collect();
        let inline_images = attachments
            .iter()
            .map(|a| {
                (
                    a.id,
                    crate::attachment::ImageRendition {
                        data: Base64::encode_string(&image),
                        media_type: a.media_type.clone(),
                        original: false,
                        width: 640,
                        height: 640,
                    },
                )
            })
            .collect();
        let original_id = Uuid::new_v4();
        let draft = crate::history::MessageDraft::new(
            Uuid::new_v4(),
            "\0".repeat(128),
            "@x".repeat(64) + &"\0".repeat(1872),
            attachments,
            inline_images,
            (0..64)
                .map(|i| crate::history::Mention {
                    user_id: Uuid::new_v4(),
                    start: i * 2,
                    end: i * 2 + 2,
                })
                .collect(),
            Some(crate::history::ReplyTarget {
                seq: 1,
                message_id: original_id,
                notify: true,
            }),
            1,
        )
        .unwrap();
        request.command = ConversationCommand::Chat {
            mentions: draft.mentions.clone(),
            reply: draft.reply.clone(),
            inline_images: draft.inline_images.clone(),
            text: draft.text.clone(),
            nonce: draft.nonce.clone(),
            attachments: draft.attachments.clone(),
        };
        let packet = signer.sign(request.address.sender, &request).unwrap();
        let bytes = serde_json::to_vec(&crate::wire::Command::Conversation { packet }).unwrap();
        assert!(bytes.len() <= CONVERSATION_FRAME_BYTES);
        let mut message = draft
            .prepare_confirmation(crate::history::ConfirmationInput::New {
                last_seq: 1,
                reply: Some(ChatMessage {
                    seq: 1,
                    id: original_id,
                    user_id: Uuid::new_v4(),
                    archived_author_name: Some("x".repeat(40)),
                    text: "\0".repeat(160),
                    time: 0,
                    attachments: vec![],
                    inline_images: Default::default(),
                    mentions: vec![],
                    reply: None,
                }),
            })
            .unwrap()
            .message;
        message.reactions.counts = INTERACTION_REACTIONS
            .iter()
            .map(|reaction| ((*reaction).to_owned(), u64::MAX))
            .collect();
        message.reactions.revision = u64::MAX;
        let confirmations = request
            .address
            .replies(Ok(ConversationResult::History(HistoryResult::Sent(
                crate::history::MessageConfirmation { message: message.clone(), inserted: false },
            ))))
            .unwrap();
        assert_eq!(confirmations.len(), 1);
        let receipt = &confirmations[0];
        let packet = signer.sign(receipt.address.sender, receipt).unwrap();
        let bytes = serde_json::to_vec(&crate::wire::Command::Conversation { packet: packet.clone() }).unwrap();
        assert!(bytes.len() <= CONVERSATION_FRAME_BYTES);
        let verified: ConversationReply = verify(&packet, signer.signing_key()).unwrap();
        assert!(
            matches!(verified.content(), ConversationRecord::Confirmed { message: stored, inserted: false }
            if stored.reactions == message.reactions)
        );

        // Read through the byte-bounded page owner, including an oversized
        // first row. It keeps the accepted large message reachable on its own page.
        let mut page = crate::history::HistoryPage::new(true);
        assert!(!page.push(message.clone()).unwrap());
        let replies = request.address.replies(Ok(ConversationResult::History(
            page.finish(Some(1), Some(101)),
        ))).unwrap();
        assert_eq!(replies.len(), 1);
        assert!(
            matches!(replies[0].content(), ConversationRecord::HistoryPage { messages, .. }
            if messages.len() == 1)
        );
        let invalid = serde_json::json!({"type":"history_page","messages":vec![message.clone(); 51],"hasMore":false,"oldestSeq":null,"before":null});
        assert!(serde_json::from_value::<ConversationRecord>(invalid).is_err());
        let duplicate = serde_json::json!({"type":"history_page","messages":[message.clone(), message],"hasMore":false,"oldestSeq":null,"before":null});
        assert!(serde_json::from_value::<ConversationRecord>(duplicate).is_err());
        for reply in replies {
            let packet = signer.sign(reply.address.sender, &reply).unwrap();
            let bytes = serde_json::to_vec(&crate::wire::Command::Conversation { packet }).unwrap();
            assert!(bytes.len() <= CONVERSATION_FRAME_BYTES);
        }
    }
}

#[cfg(all(test, feature = "sqlite"))]
mod room_tests {
    use super::*;
    use crate::{
        host::{HostAction, HostInput, RequestContext},
        wire::RoomAccess,
        Endpoint, Member, RoomState, StoredRoomHost,
    };
    use std::{collections::BTreeMap, path::Path};
    #[test]
    fn peer_history_uses_current_domain_authority_and_the_same_persistent_nonce() {
        let sender_key = SessionSigner::from_seed([1; 32]);
        let host_key = SessionSigner::from_seed([2; 32]);
        let owner = Member {
            user_id: Uuid::new_v4(),
        };
        let actor = Member {
            user_id: Uuid::new_v4(),
            ..owner
        };
        let host_session = Uuid::new_v4();
        let sender = Uuid::new_v4();
        let binding_id = Uuid::new_v4();
        let mut policy = RoomState::new(
            "room".into(),
            "Room".into(),
            Default::default(),
            owner.user_id,
            RoomAccess::Private,
            false,
            None,
        )
        .unwrap();
        policy.grants.insert(actor.user_id);
        let mut host = StoredRoomHost::create(Path::new(":memory:"), policy).unwrap();
        let endpoints = BTreeMap::from([
            (
                host_session,
                Endpoint {
                    member: owner,
                    can_use_peer_transport: true,
                    connected: true,
                    signing_key: host_key.signing_key(),
                },
            ),
            (
                sender,
                Endpoint {
                    member: actor,
                    can_use_peer_transport: true,
                    connected: true,
                    signing_key: sender_key.signing_key(),
                },
            ),
        ]);
        let input = |action, binding_id| HostInput {
            hosting_mode: Default::default(),
            channel_owner_id: Uuid::nil(),
            service_endpoint: None,
            now: 0,
            binding_id,
            host_session_id: host_session,
            revision: 1,
            confirmed_pairs: Default::default(),
            disconnected_pairs: Default::default(),
            failed_pairs: Vec::new(),
            endpoints: endpoints.clone(),
            action,
        };
        host.dispatch(input(HostAction::Sync, binding_id)).unwrap();
        host.dispatch(input(
            HostAction::Command {
                context: RequestContext {
                    connection: Uuid::new_v4(),
                    session_id: sender,
                    request_id: None,
                    now: 1,
                },
                command: crate::wire::Command::Browse {
                    room_id: "room".into(),
                    active: true,
                },
            },
            binding_id,
        ))
        .unwrap();
        assert_eq!(host.current_readers(), vec![sender]);
        let address = ConversationAddress {
            room_id: "room".into(),
            binding_id,
            sender,
            recipient: host_session,
            request_id: "request".into(),
        };
        let mut malformed = serde_json::to_value(&address).unwrap();
        malformed["command"] = serde_json::json!({
            "type": "delete_message", "messageSeq": 1, "messageId": ""
        });
        let malformed_packet = sender_key.sign(sender, &malformed).unwrap();
        let outcome = host.dispatch_peer(&malformed_packet, 1).unwrap();
        assert!(outcome.projection_update.is_none());
        let replies = outcome.replies().unwrap();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0].address, address.reply());
        assert!(matches!(
            replies[0].content(),
            ConversationRecord::Error { code } if code == "invalid_conversation"
        ));
        assert!(replies[0].content().broadcast().is_none());
        let mut forged = malformed_packet;
        forged.signature[0] ^= 1;
        assert!(matches!(
            host.dispatch_peer(&forged, 1),
            Err("invalid_conversation_signature")
        ));
        malformed["bindingId"] = serde_json::json!(Uuid::new_v4());
        assert!(matches!(
            host.dispatch_peer(&sender_key.sign(sender, &malformed).unwrap(), 1),
            Err("invalid_conversation_scope")
        ));
        let mut request = ConversationRequest {
            address: address.clone(),
            command: ConversationCommand::Chat {
                mentions: vec![],
                reply: None,
                inline_images: Default::default(),
                text: "Original".into(),
                nonce: "same-send".into(),
                attachments: vec![],
            },
        };
        let packet = sender_key.sign(sender, &request).unwrap();
        let first = host.dispatch_peer(&packet, 10).unwrap();
        let ConversationResult::History(HistoryResult::Sent(confirmation)) =
            first.result.as_ref().unwrap()
        else {
            panic!("send expected")
        };
        let original = serde_json::to_value(&confirmation.message).unwrap();
        assert_eq!(confirmation.message.message.user_id, actor.user_id);
        assert_eq!(confirmation.message.message.time, 10);
        let reply = first.replies().unwrap().remove(0);
        let Some(ConversationRecord::LiveMessage { message }) = reply.content().broadcast() else {
            panic!("new confirmed chat must broadcast");
        };
        assert_eq!(message.text, "Original");
        assert_eq!(message.user_id, actor.user_id);
        let signed = host_key.sign(host_session, &reply).unwrap();
        assert_eq!(
            ConversationReply::verify(&signed, host_key.signing_key())
                .unwrap()
                .address,
            address.reply()
        );
        request.command = ConversationCommand::Chat {
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
            text: "Changed retransmission".into(),
            nonce: "same-send".into(),
            attachments: vec![],
        };
        let packet = sender_key.sign(sender, &request).unwrap();
        let retry = host.dispatch_peer(&packet, 20).unwrap();
        let ConversationResult::History(HistoryResult::Sent(confirmation)) =
            retry.result.as_ref().unwrap()
        else {
            panic!("retry expected")
        };
        let message_id = confirmation.message.message.id;
        assert!(!confirmation.inserted);
        assert_eq!(
            serde_json::to_value(&confirmation.message).unwrap(),
            original
        );
        assert!(retry
            .replies()
            .unwrap()
            .iter()
            .all(|reply| reply.content().broadcast().is_none()));
        for (nonce, now, changed) in [
            (1, 1000, true),
            (1, 1001, false),
            (2, 1800, true),
            (1, 1801, false),
        ] {
            let request = ConversationRequest {
                address: address.clone(),
                command: ConversationCommand::React {
                    nonce,
                    target: ReactionTarget::Message {
                        message_seq: 1,
                        message_id,
                    },
                    reaction: "heart".into(),
                },
            };
            let packet = sender_key.sign(sender, &request).unwrap();
            let replies = host.dispatch_peer(&packet, now).unwrap().replies().unwrap();
            assert!(matches!(replies[0].content(),
                ConversationRecord::Reaction { event, .. } if event.is_some() == changed));
            assert_eq!(replies[0].content().broadcast().is_some(), changed);
            if let Some(ConversationRecord::Reaction {
                snapshot: Some(ReactionSnapshot::Message(snapshot)),
                ..
            }) = replies[0].content().broadcast()
            {
                assert_eq!(snapshot.message_seq, 1);
                assert_eq!(snapshot.reactions.counts["heart"], nonce);
            }
        }
        for command in [
            ConversationCommand::InteractionReady,
            ConversationCommand::React {
                nonce: 3,
                reaction: "wave".into(),
                target: ReactionTarget::Person {
                    user_id: actor.user_id,
                },
            },
            ConversationCommand::History { before: None, parts: vec!["inlineImages".into()] },
        ] {
            let request = ConversationRequest {
                address: address.clone(),
                command,
            };
            let packet = sender_key.sign(sender, &request).unwrap();
            let replies = host
                .dispatch_peer(&packet, 2600)
                .unwrap()
                .replies()
                .unwrap();
            for reply in replies {
                let broadcast = reply.content().broadcast();
                if matches!(reply.content(), ConversationRecord::Reaction { .. }) {
                    assert_eq!(
                        serde_json::to_value(broadcast.unwrap()).unwrap(),
                        serde_json::to_value(reply.content()).unwrap()
                    );
                } else {
                    assert!(broadcast.is_none());
                }
            }
        }
        let seek = |after| {
            sender_key
                .sign(
                    sender,
                    &ConversationRequest {
                        address: address.clone(),
                        command: ConversationCommand::HistorySeek { after },
                    },
                )
                .unwrap()
        };
        let seek_packet = seek(0);
        let outcome = host.dispatch_peer(&seek_packet, 29).unwrap();
        assert!(outcome.projection_update.is_none());
        let replies = outcome.replies().unwrap();
        assert_eq!(replies.len(), 1);
        let reply = &replies[0];
        assert_eq!(reply.address, address.reply());
        assert!(reply.content().broadcast().is_none());
        assert_eq!(
            serde_json::to_value(reply.content()).unwrap(),
            serde_json::json!({"type":"history_seek_result","after":0,"seq":null}),
            "seek excludes the authenticated reader's own message"
        );
        let invalid = host.dispatch_peer(&seek(1u64 << f64::MANTISSA_DIGITS), 29).unwrap();
        assert!(matches!(invalid.result, Err("invalid_history_cursor")));

        let context = RequestContext {
            connection: Uuid::new_v4(),
            session_id: host_session,
            request_id: None,
            now: 30,
        };
        host.dispatch(input(
            HostAction::Revoke {
                context,
                target: actor,
            },
            binding_id,
        ))
        .unwrap();
        assert!(host.current_readers().is_empty());
        let denied_seek = host.dispatch_peer(&seek_packet, 31).unwrap();
        assert!(matches!(denied_seek.result, Err("room_access_required")));
        let denied = host.dispatch_peer(&packet, 31).unwrap();
        assert!(
            denied.result.is_err(),
            "signature does not preserve revoked room permission"
        );
        let denied_reply = denied.replies().unwrap().remove(0);
        assert!(matches!(
            denied_reply.content(),
            ConversationRecord::Error { .. }
        ));
        assert!(denied_reply.content().broadcast().is_none());
        host.dispatch(input(HostAction::Sync, Uuid::new_v4()))
            .unwrap();
        assert!(matches!(
            host.dispatch_peer(&packet, 40),
            Err("invalid_conversation_scope")
        ));
        let mut forged = packet;
        forged.sender = host_session;
        assert!(matches!(
            host.dispatch_peer(&forged, 40),
            Err("invalid_conversation_signature")
        ));
    }
}
