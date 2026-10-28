use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Join {
        name: String,
        credential: Option<String>,
        key: Option<String>,
        session_id: Option<String>,
        room_id: Option<String>,
        signing_key: [u8; 32],
    },
    SetName {
        name: String,
    },
    Browse {
        room_id: String,
        active: bool,
    },
    FileOffer {
        room_id: String,
        message_seq: u64,
        attachment_id: Uuid,
        available: bool,
    },
    FileReceive {
        room_id: String,
        message_seq: u64,
        attachment_id: Uuid,
        enabled: bool,
    },
    HostRegister {
        room: crate::host::RoomSummary,
        resume_binding: Option<Uuid>,
    },
    HostOutput {
        room_id: String,
        output: crate::host::HostOutput,
    },
    HostStop {
        room_id: String,
        binding_id: Uuid,
    },
    UpdateRoom {
        room_id: String,
        name: String,
        access: RoomAccess,
        hidden: bool,
        #[serde(
            default,
            deserialize_with = "nullable_password",
            skip_serializing_if = "Option::is_none"
        )]
        password: Option<Option<String>>,
    },
    EnterRoom {
        room_id: String,
        password: Option<String>,
        invite_key: Option<String>,
    },
    RoomInvite {
        room_id: String,
    },
    RevokeRoomAccess {
        room_id: String,
        user_id: Uuid,
    },
    SetRoles {
        user_id: Uuid,
        roles: Vec<String>,
    },
    Publish {
        publication: PublicationInput,
    },
    Unpublish {
        publication_id: Uuid,
    },
    Subscribe {
        publication_id: Uuid,
        enabled: bool,
    },
    Voice {
        room_id: String,
        joined: bool,
        muted: bool,
        deafened: bool,
    },
    Signal {
        pair_id: Uuid,
        payload: Signal,
    },
    LinkState {
        pair_id: Uuid,
        state: LinkState,
    },
    FlowState {
        flow_id: Uuid,
        pair_id: Uuid,
        state: FlowState,
    },
    BaseState {
        room_id: String,
        pair_id: Uuid,
        ready: bool,
    },
    Leave,
}

pub struct Request {
    pub request_id: Option<String>,
    pub command: Command,
}

impl Request {
    pub fn parse(text: &str) -> Result<Self, (Option<String>, &'static str)> {
        let mut input: Value = serde_json::from_str(text).map_err(|_| (None, "invalid_request"))?;
        let object = input.as_object_mut().ok_or((None, "invalid_request"))?;
        let request_id = match object.remove("requestId") {
            Some(Value::String(id)) if valid_id(&id) => Some(id),
            None => None,
            _ => return Err((None, "invalid_request_id")),
        };
        let command =
            serde_json::from_value(input).map_err(|_| (request_id.clone(), "invalid_request"))?;
        Ok(Self {
            request_id,
            command,
        })
    }
}

fn nullable_password<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RoomAccess {
    Public,
    Private,
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Screen,
    Voice,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationInput {
    pub id: Uuid,
    pub room_id: String,
    pub kind: Kind,
    pub muted: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    Connected,
    Failed,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Signal {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resync: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Description>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<Candidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<Track>>,
}

impl Signal {
    pub fn valid(&self) -> bool {
        self.description.is_some() == self.exchange_id.is_some()
            && self.description.as_ref().is_none_or(|description| {
                ["offer", "answer"].contains(&description.kind.as_str())
                    && description
                        .sdp
                        .as_ref()
                        .is_none_or(|sdp| sdp.len() <= 150_000)
            })
            && self.candidate.as_ref().is_none_or(|candidate| {
                candidate
                    .candidate
                    .as_ref()
                    .is_none_or(|value| value.len() <= 4096)
                    && candidate
                        .sdp_mid
                        .as_ref()
                        .is_none_or(|value| value.len() <= 128)
                    && candidate
                        .username_fragment
                        .as_ref()
                        .is_none_or(|value| value.len() <= 256)
            })
            && self
                .tracks
                .as_ref()
                .is_none_or(|tracks| tracks.iter().all(|track| valid_id(&track.stream_id)))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Description {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdp: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdp_mid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdp_m_line_index: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username_fragment: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Track {
    pub flow_id: Uuid,
    pub stream_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    pub name: String,
    pub creator_id: Uuid,
    pub access: RoomAccess,
    pub hidden: bool,
    pub has_password: bool,
    pub authorized: bool,
    pub can_manage: bool,
    pub available: bool,
    pub reading: bool,
    pub capabilities: RoomCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<RoomDelivery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<Uuid>>,
}

/// The domain derives these destinations from the accepted room base tree.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDelivery {
    pub host_session_id: Uuid,
    pub binding_id: Uuid,
    pub next_hops: BTreeMap<Uuid, Uuid>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomCapabilities {
    pub attachments: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationInfo {
    pub id: Uuid,
    pub room_id: String,
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub kind: Kind,
    pub muted: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub session_id: Uuid,
    pub room_id: String,
    pub muted: bool,
    pub deafened: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: Uuid,
    pub user_id: Uuid,
    pub online: bool,
    pub signing_key: [u8; 32],
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairInfo {
    pub id: Uuid,
    pub peer_id: Uuid,
    pub rooms: Vec<String>,
    pub outgoing: Vec<FlowBinding>,
    pub incoming: Vec<FlowBinding>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowBinding {
    pub id: Uuid,
    pub publication_id: Uuid,
    pub input_flow_id: Option<Uuid>,
    pub selected: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowState {
    Failed,
    Forwardable,
    Decoded,
    SwitchReady,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct RoleInfo {
    pub id: String,
    pub name: String,
    pub permissions: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct UserInfo {
    pub id: Uuid,
    pub name: String,
    pub roles: BTreeSet<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub history_window: usize,
    pub id: Uuid,
    pub name: String,
    pub owner_id: Option<Uuid>,
    pub rooms: Vec<Room>,
    pub roles: Vec<RoleInfo>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub files: Vec<crate::file_room::FilePlan>,
    pub channel: ChannelInfo,
    pub users: Vec<UserInfo>,
    pub sessions: Vec<SessionInfo>,
    pub publications: Vec<PublicationInfo>,
    pub voice: Vec<VoiceInfo>,
    pub subscriptions: Vec<Uuid>,
    pub pairs: Vec<PairInfo>,
    pub ice_servers: Vec<Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub seq: u64,
    pub attachments: Vec<crate::attachment::AttachmentDescriptor>,
    pub id: Uuid,
    pub user_id: Uuid,
    pub text: String,
    pub time: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    RoomReply {
        room_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        result: crate::host::RoomResult,
    },
    HostBound {
        room_id: String,
        binding_id: Uuid,
    },
    HostInput {
        room_id: String,
        input: crate::host::HostInput,
    },
    Welcome {
        credential: String,
        session_id: Uuid,
        state: Snapshot,
        #[serde(skip_serializing_if = "Option::is_none")]
        invite_key: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        invitation_origin: Option<String>,
    },
    State {
        state: Snapshot,
    },
    RoomInvite {
        room_id: String,
        key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    Signal {
        pair_id: Uuid,
        from_session_id: Uuid,
        payload: Signal,
    },
    Ack {
        request_id: String,
    },
    Error {
        code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
}
