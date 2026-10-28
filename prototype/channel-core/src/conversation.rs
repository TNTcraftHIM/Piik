//! Signed live room conversation; domain admission supplies the trusted session keys.
use crate::{
    attachment::AttachmentDescriptor,
    file_delivery::FileControl,
    history::{HistoryRequest, HistoryResult},
    wire::ChatMessage,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use uuid::Uuid;

pub const CONTROL_FRAME_BYTES: usize = 32768;
pub const CONVERSATION_HOPS: u8 = 20;
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
        if payload.len() > CONTROL_FRAME_BYTES {
            return Err("control_frame_too_large");
        }
        let signature = self.0.sign(&signing_bytes(&payload)).to_bytes().to_vec();
        Ok(SignedPacket {
            sender,
            payload,
            signature,
            remaining_hops: CONVERSATION_HOPS,
        })
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedPacket {
    pub sender: Uuid,
    pub payload: String,
    pub signature: Vec<u8>,
    pub remaining_hops: u8,
}
fn signing_bytes(payload: &str) -> Vec<u8> {
    [SIGNING_PREFIX, payload.as_bytes()].concat()
}
pub fn verify<T: DeserializeOwned>(
    packet: &SignedPacket,
    key: [u8; 32],
) -> Result<T, &'static str> {
    if packet.payload.len() > CONTROL_FRAME_BYTES {
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
    Conversation(SignedPacket),
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRoute {
    pub address: ConversationAddress,
    pub next_hop: Option<Uuid>,
}
/// Uses only the current domain projection. The mutable hop allowance bounds
/// forwarding while adjacent participants are applying different snapshots.
pub fn route(
    packet: &mut SignedPacket,
    local: Uuid,
    snapshot: &crate::wire::Snapshot,
    from: Option<Uuid>,
) -> Result<ConversationRoute, &'static str> {
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
    let delivery = room.delivery.as_ref().ok_or("room_delivery_unavailable")?;
    if address.binding_id != delivery.binding_id
        || (address.sender != delivery.host_session_id
            && address.recipient != delivery.host_session_id)
        || packet.remaining_hops > CONVERSATION_HOPS
    {
        return Err("invalid_conversation_scope");
    }
    let neighbor = |peer| {
        snapshot
            .pairs
            .iter()
            .any(|pair| pair.peer_id == peer && pair.rooms.contains(&address.room_id))
    };
    if from.is_some_and(|peer| !neighbor(peer)) || (from.is_none() && address.sender != local) {
        return Err("unassigned_room_peer");
    }
    let next_hop = if address.recipient == local {
        None
    } else {
        let peer = *delivery
            .next_hops
            .get(&address.recipient)
            .ok_or("room_path_unavailable")?;
        if Some(peer) == from || peer == local || !neighbor(peer) {
            return Err("room_path_unavailable");
        }
        if packet.remaining_hops == 0 {
            return Err("conversation_hop_limit");
        }
        packet.remaining_hops -= 1;
        Some(peer)
    };
    Ok(ConversationRoute { address, next_hop })
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
    Chat {
        text: String,
        nonce: String,
        attachments: Vec<AttachmentDescriptor>,
    },
    History {
        before: Option<u64>,
    },
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
    pub history: Result<HistoryRequest, &'static str>,
}
#[derive(Serialize)]
pub struct ConversationOutcome {
    pub address: ConversationAddress,
    pub result: Result<HistoryResult, &'static str>,
}
impl ConversationOutcome {
    pub fn replies(self) -> Result<Vec<ConversationReply>, &'static str> {
        self.address.replies(self.result)
    }
}
impl ConversationAddress {
    pub fn replies(
        &self,
        result: Result<HistoryResult, &str>,
    ) -> Result<Vec<ConversationReply>, &'static str> {
        let records = match result {
            Err(code) => vec![ConversationRecord::Error { code: code.into() }],
            Ok(HistoryResult::Sent(confirmation)) => vec![ConversationRecord::Confirmed {
                message: confirmation.message,
                inserted: confirmation.inserted,
            }],
            Ok(HistoryResult::Page {
                messages,
                has_more,
                oldest_seq,
                before,
            }) => {
                let count = messages.len();
                if count > crate::history::HISTORY_PAGE {
                    return Err("invalid_conversation_result");
                }
                let mut records: Vec<_> = messages
                    .into_iter()
                    .map(|message| ConversationRecord::HistoryMessage { message })
                    .collect();
                records.push(ConversationRecord::HistoryEnd {
                    count,
                    has_more,
                    oldest_seq,
                    before,
                });
                records
            }
            Ok(HistoryResult::Attachment { .. }) => return Err("invalid_conversation_result"),
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
        let bytes = encode_control(&ControlFrame::Conversation(packet)).unwrap();
        assert!(matches!(
            decode_control(&bytes).unwrap(),
            ControlFrame::Conversation(_)
        ));
        assert!(decode_control(&vec![0; CONTROL_FRAME_BYTES + 1]).is_err());
    }
    #[test]
    fn worst_legal_message_and_hundred_record_history_fit_actual_signed_control_frames() {
        let signer = SessionSigner::from_seed([9; 32]);
        let mut request = request();
        request.address.room_id = "\0".repeat(128);
        request.address.request_id = "\0".repeat(128);
        let attachments = (0..8)
            .map(|_| AttachmentDescriptor {
                id: Uuid::new_v4(),
                name: "\u{10ffff}".repeat(240),
                size: crate::ATTACHMENT_LIMITS.max_file_bytes,
                media_type: "application/octet-stream".into(),
                sha256: "f".repeat(64),
            })
            .collect();
        let draft = crate::history::MessageDraft::new(
            Uuid::new_v4(),
            "\0".repeat(128),
            "\0".repeat(2000),
            attachments,
            1,
        )
        .unwrap();
        request.command = ConversationCommand::Chat {
            text: draft.text.clone(),
            nonce: draft.nonce.clone(),
            attachments: draft.attachments.clone(),
        };
        let packet = signer.sign(request.address.sender, &request).unwrap();
        let bytes = encode_control(&ControlFrame::Conversation(packet)).unwrap();
        assert!(bytes.len() <= CONTROL_FRAME_BYTES);
        let message = draft
            .prepare_confirmation(crate::history::ConfirmationInput::New { last_seq: 0 })
            .unwrap()
            .message;
        let messages = (0..100)
            .map(|index| {
                let mut message = message.clone();
                message.id = Uuid::new_v4();
                message.seq = index + 1;
                message
            })
            .collect();
        let replies = request
            .address
            .replies(Ok(HistoryResult::Page {
                messages,
                has_more: true,
                oldest_seq: Some(1),
                before: Some(101),
            }))
            .unwrap();
        assert_eq!(replies.len(), 101);
        assert!(matches!(
            replies.last().unwrap().record,
            ConversationRecord::HistoryEnd { count: 100, .. }
        ));
        assert!(serde_json::from_value::<ConversationRecord>(serde_json::json!({"type":"history_end","count":101,"hasMore":false,"oldestSeq":null,"before":null})).is_err());
        for reply in replies {
            let packet = signer.sign(reply.address.sender, &reply).unwrap();
            let bytes = encode_control(&ControlFrame::Conversation(packet)).unwrap();
            assert!(bytes.len() <= CONTROL_FRAME_BYTES);
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
            participates: true,
            domain_owner: false,
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
        let mut request = ConversationRequest {
            address: address.clone(),
            command: ConversationCommand::Chat {
                text: "Original".into(),
                nonce: "same-send".into(),
                attachments: vec![],
            },
        };
        let packet = sender_key.sign(sender, &request).unwrap();
        let first = host.dispatch_peer(&packet, 10).unwrap();
        let HistoryResult::Sent(confirmation) = first.result.as_ref().unwrap() else {
            panic!("send expected")
        };
        let original = serde_json::to_value(&confirmation.message).unwrap();
        assert_eq!(confirmation.message.user_id, actor.user_id);
        assert_eq!(confirmation.message.time, 10);
        let reply = first.replies().unwrap().pop().unwrap();
        let signed = host_key.sign(host_session, &reply).unwrap();
        assert_eq!(
            ConversationReply::verify(&signed, host_key.signing_key())
                .unwrap()
                .address,
            address.reply()
        );
        request.command = ConversationCommand::Chat {
            text: "Changed retransmission".into(),
            nonce: "same-send".into(),
            attachments: vec![],
        };
        let packet = sender_key.sign(sender, &request).unwrap();
        let retry = host.dispatch_peer(&packet, 20).unwrap();
        let HistoryResult::Sent(confirmation) = retry.result.unwrap() else {
            panic!("retry expected")
        };
        assert!(!confirmation.inserted);
        assert_eq!(
            serde_json::to_value(confirmation.message).unwrap(),
            original
        );
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
        assert!(matches!(
            denied.replies().unwrap()[0].record,
            ConversationRecord::Error { .. }
        ));
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
