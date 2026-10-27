use crate::identity::User;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Deserialize)]
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
    },
    SetName {
        name: String,
    },
    Browse {
        room_id: String,
    },
    Chat {
        room_id: String,
        text: String,
        nonce: String,
    },
    CreateRoom {
        name: String,
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
        publication_id: Uuid,
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

pub fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Screen,
    Voice,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationInput {
    pub id: Uuid,
    pub room_id: String,
    pub kind: Kind,
    pub muted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    Connected,
    Failed,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Signal {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Description>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<Candidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<Track>>,
}

impl Signal {
    pub fn valid(&self) -> bool {
        self.description.as_ref().is_none_or(|description| {
            ["offer", "answer", "rollback", "pranswer"].contains(&description.kind.as_str())
                && description
                    .sdp
                    .as_ref()
                    .is_none_or(|sdp| sdp.len() <= 150_000)
        }) && self.candidate.as_ref().is_none_or(|candidate| {
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
        }) && self.tracks.as_ref().is_none_or(|tracks| {
            tracks.len() <= 80 && tracks.iter().all(|track| valid_id(&track.stream_id))
        })
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
    pub publication_id: Uuid,
    pub stream_id: String,
}

#[derive(Clone, Serialize)]
pub struct Room {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationInfo {
    pub id: Uuid,
    pub room_id: String,
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub kind: Kind,
    pub muted: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub session_id: Uuid,
    pub room_id: String,
    pub muted: bool,
    pub deafened: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: Uuid,
    pub user_id: Uuid,
    pub online: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairInfo {
    pub id: Uuid,
    pub peer_id: Uuid,
    pub outgoing: Vec<Uuid>,
    pub incoming: Vec<Uuid>,
}

#[derive(Clone, Serialize)]
pub struct RoleInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub permissions: Vec<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub id: Uuid,
    pub name: String,
    pub owner_id: Option<Uuid>,
    pub rooms: Vec<Room>,
    pub roles: Vec<RoleInfo>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub channel: ChannelInfo,
    pub users: Vec<User>,
    pub sessions: Vec<SessionInfo>,
    pub publications: Vec<PublicationInfo>,
    pub voice: Vec<VoiceInfo>,
    pub subscriptions: Vec<Uuid>,
    pub pairs: Vec<PairInfo>,
    pub ice_servers: Vec<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: Uuid,
    pub user_id: Uuid,
    pub text: String,
    pub time: u64,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Welcome {
        credential: String,
        session_id: Uuid,
        state: Snapshot,
        #[serde(skip_serializing_if = "Option::is_none")]
        invite_key: Option<String>,
    },
    State {
        state: Snapshot,
    },
    History {
        room_id: String,
        messages: Vec<ChatMessage>,
    },
    Message {
        room_id: String,
        message: ChatMessage,
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
