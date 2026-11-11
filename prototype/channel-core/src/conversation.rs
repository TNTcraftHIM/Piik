//! Signed live room conversation; domain admission supplies the trusted session keys.
use crate::{
    attachment::AttachmentDescriptor,
    file_delivery::FileControl,
    history::{HistoryRequest, HistoryResult, MessageReactionSnapshot, MessageReactions},
    wire::ChatMessage,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use uuid::Uuid;

pub const CONTROL_FRAME_BYTES: usize = 32768;
pub const CONVERSATION_FRAME_BYTES: usize = 128 * 1024;
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ControlFrame {
    File(FileControl),
}
pub fn encode_control(frame: &ControlFrame) -> Result<Vec<u8>, &'static str> {
    let bytes = serde_json::to_vec(frame).map_err(|_| "invalid_control_frame")?;
    if bytes.len() > CONTROL_FRAME_BYTES {
        return Err("control_frame_too_large");
    }
    Ok(bytes)
}
pub fn decode_control(bytes: &[u8]) -> Result<ControlFrame, &'static str> {
    if bytes.len() > CONTROL_FRAME_BYTES {
        return Err("control_frame_too_large");
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

/// Verify a packet delivered by the authenticated domain connection. The domain
/// is a carrier, not a room-tree neighbor or the room's conversation authority.
pub fn verify_delivery(
    packet: &SignedPacket,
    local: Uuid,
    snapshot: &crate::wire::Snapshot,
) -> Result<ConversationAddress, &'static str> {
    let sender = snapshot
        .sessions
        .iter()
        .find(|session| session.id == packet.sender)
        .ok_or("session_expired")?;
    let address = verify_address(packet, sender.signing_key)?;
    let room = snapshot
        .channel
        .rooms
        .iter()
        .find(|room| room.id == address.room_id && room.authorized && room.available)
        .ok_or("room_unavailable")?;
    let delivery = room.delivery.as_ref().ok_or("room_host_offline")?;
    if address.recipient != local
        || address.binding_id != delivery.binding_id
        || !crate::wire::valid_id(&address.request_id)
        || (address.sender != delivery.host_session_id
            && address.recipient != delivery.host_session_id)
    {
        return Err("invalid_conversation_scope");
    }
    Ok(address)
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
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConversationCommand {
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
        inline_images: std::collections::BTreeMap<Uuid, String>,
        text: String,
        nonce: String,
        attachments: Vec<AttachmentDescriptor>,
    },
    History {
        before: Option<u64>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReactionTarget {
    Message { message_seq: u64 },
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
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConversationRecord {
    Reaction {
        nonce: u64,
        event: Option<ReactionEvent>,
        snapshot: Option<ReactionSnapshot>,
    },
    MessageReactions {
        snapshot: MessageReactionSnapshot,
    },
    InteractionReady {
        server_time: u64,
        reaction_ids: Vec<String>,
        publication_reactions: Vec<PublicationReactions>,
    },
    Confirmed {
        message: ChatMessage,
        inserted: bool,
    },
    HistoryMessage {
        message: ChatMessage,
    },
    HistoryEnd {
        #[serde(deserialize_with = "history_count")]
        count: usize,
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
}

impl ConversationRecord {
    /// Only new confirmed changes and live interactions fan out to other readers.
    pub fn broadcast(&self) -> Option<Self> {
        match self {
            Self::Confirmed {
                message,
                inserted: true,
            } => Some(Self::LiveMessage {
                message: message.clone(),
            }),
            Self::Reaction { event: Some(_), .. } => Some(self.clone()),
            _ => None,
        }
    }
}

fn history_count<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<usize, D::Error> {
    let count = usize::deserialize(deserializer)?;
    if count > crate::history::HISTORY_PAGE {
        return Err(serde::de::Error::custom("invalid history count"));
    }
    Ok(count)
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ConversationReply {
    #[serde(flatten)]
    pub address: ConversationAddress,
    pub record: ConversationRecord,
}
impl ConversationReply {
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
    pub address: ConversationAddress,
    pub result: Result<ConversationResult, &'static str>,
}
impl ConversationOutcome {
    pub fn replies(self) -> Result<Vec<ConversationReply>, &'static str> {
        self.address.replies(self.result)
    }
}
impl ConversationAddress {
    pub fn replies(
        &self,
        result: Result<ConversationResult, &str>,
    ) -> Result<Vec<ConversationReply>, &'static str> {
        let records = match result {
            Err(code) => vec![ConversationRecord::Error { code: code.into() }],
            Ok(ConversationResult::Immediate(record)) => vec![record],
            Ok(ConversationResult::History(HistoryResult::Sent(confirmation))) => {
                let snapshot = confirmation.message.reaction_snapshot();
                vec![
                    ConversationRecord::Confirmed {
                        message: confirmation.message.message,
                        inserted: confirmation.inserted,
                    },
                    ConversationRecord::MessageReactions { snapshot },
                ]
            }
            Ok(ConversationResult::History(HistoryResult::Reacted(confirmation))) => {
                vec![ConversationRecord::Reaction {
                    nonce: confirmation.nonce,
                    snapshot: Some(ReactionSnapshot::Message(confirmation.snapshot)),
                    event: confirmation.event,
                }]
            }
            Ok(ConversationResult::History(HistoryResult::Page {
                messages,
                has_more,
                oldest_seq,
                before,
            })) => {
                let count = messages.len();
                if count > crate::history::HISTORY_PAGE {
                    return Err("invalid_conversation_result");
                }
                let mut records: Vec<_> = messages
                    .into_iter()
                    .flat_map(|message| {
                        let snapshot = message.reaction_snapshot();
                        [
                            ConversationRecord::HistoryMessage {
                                message: message.message,
                            },
                            ConversationRecord::MessageReactions { snapshot },
                        ]
                    })
                    .collect();
                records.push(ConversationRecord::HistoryEnd {
                    count,
                    has_more,
                    oldest_seq,
                    before,
                });
                records
            }
            Ok(ConversationResult::History(HistoryResult::Attachment { .. })) => {
                return Err("invalid_conversation_result")
            }
        };
        Ok(records
            .into_iter()
            .map(|record| ConversationReply {
                address: self.reply(),
                record,
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
            command: ConversationCommand::History { before: None },
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
                sha256: crate::attachment::sha256_hex(&image),
            })
            .collect();
        let inline_images = attachments
            .iter()
            .map(|a| (a.id, Base64::encode_string(&image)))
            .collect();
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
                    id: Uuid::new_v4(),
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
        let messages = (0..crate::history::HISTORY_PAGE)
            .map(|index| {
                let mut message = message.clone();
                message.message.id = Uuid::new_v4();
                message.message.seq = index as u64 + 1;
                message
            })
            .collect();
        let replies = request
            .address
            .replies(Ok(ConversationResult::History(HistoryResult::Page {
                messages,
                has_more: true,
                oldest_seq: Some(1),
                before: Some(101),
            })))
            .unwrap();
        assert_eq!(replies.len(), 101);
        assert!(matches!(
            replies.last().unwrap().record,
            ConversationRecord::HistoryEnd {
                count: crate::history::HISTORY_PAGE,
                ..
            }
        ));
        assert!(serde_json::from_value::<ConversationRecord>(serde_json::json!({"type":"history_end","count":101,"hasMore":false,"oldestSeq":null,"before":null})).is_err());
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
                    connected: true,
                    signing_key: host_key.signing_key(),
                },
            ),
            (
                sender,
                Endpoint {
                    member: actor,
                    connected: true,
                    signing_key: sender_key.signing_key(),
                },
            ),
        ]);
        let input = |action, binding_id| HostInput {
            now: 0,
            binding_id,
            host_session_id: host_session,
            revision: 1,
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
                    relay_capacity: None,
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
        let Some(ConversationRecord::LiveMessage { message }) = reply.record.broadcast() else {
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
        assert!(!confirmation.inserted);
        assert_eq!(
            serde_json::to_value(&confirmation.message).unwrap(),
            original
        );
        assert!(retry
            .replies()
            .unwrap()
            .iter()
            .all(|reply| reply.record.broadcast().is_none()));
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
                    target: ReactionTarget::Message { message_seq: 1 },
                    reaction: "heart".into(),
                },
            };
            let packet = sender_key.sign(sender, &request).unwrap();
            let replies = host.dispatch_peer(&packet, now).unwrap().replies().unwrap();
            assert!(matches!(&replies[0].record,
                ConversationRecord::Reaction { event, .. } if event.is_some() == changed));
            assert_eq!(replies[0].record.broadcast().is_some(), changed);
            if let Some(ConversationRecord::Reaction {
                snapshot: Some(ReactionSnapshot::Message(snapshot)),
                ..
            }) = replies[0].record.broadcast()
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
            ConversationCommand::History { before: None },
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
                let broadcast = reply.record.broadcast();
                if matches!(reply.record, ConversationRecord::Reaction { .. }) {
                    assert_eq!(
                        serde_json::to_value(broadcast.unwrap()).unwrap(),
                        serde_json::to_value(reply.record).unwrap()
                    );
                } else {
                    assert!(broadcast.is_none());
                }
            }
        }
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
        let denied = host.dispatch_peer(&packet, 31).unwrap();
        assert!(
            denied.result.is_err(),
            "signature does not preserve revoked room permission"
        );
        let denied_reply = denied.replies().unwrap().remove(0);
        assert!(matches!(
            denied_reply.record,
            ConversationRecord::Error { .. }
        ));
        assert!(denied_reply.record.broadcast().is_none());
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
