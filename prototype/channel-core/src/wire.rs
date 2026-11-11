use base64ct::{Base64, Encoding};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

pub const CHANNEL_PROTOCOL: u8 = 10;
pub const CHANNEL_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Join {
        #[serde(default)]
        protocol: u8,
        name: String,
        credential: Option<String>,
        owner_key: Option<String>,
        session_id: Option<String>,
        signing_key: [u8; 32],
        #[serde(default)]
        can_prepare_udp: bool,
        #[serde(default)]
        can_receive_video_layers: bool,
    },
    SetProfile {
        name: String,
        #[serde(deserialize_with = "avatar")]
        avatar: Option<String>,
    },
    UpdateDomain {
        name: String,
        icon: IdentityIcon,
    },
    Conversation {
        packet: crate::conversation::SignedPacket,
    },
    Browse {
        room_id: String,
        active: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        relay_capacity: Option<u8>,
    },
    FileOffer {
        room_id: String,
        message_seq: u64,
        attachment_id: Uuid,
        sha256: String,
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
    CreateRoom {
        room: crate::host::RoomSummary,
    },
    AdmitRoom {
        room: crate::host::RoomSummary,
    },
    DeleteRoom {
        room_id: String,
        delete_data: bool,
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
        icon: IdentityIcon,
        access: RoomAccess,
        hidden: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voice_bitrate: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        relay_capacity: Option<u8>,
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
    RelayCapacity {
        room_id: String,
        capacity: Option<u8>,
    },
    RoomInvite {
        room_id: String,
    },
    GetRoomInvite {
        room_id: String,
    },
    RoomTopology {
        room_id: String,
        publication_id: Option<Uuid>,
    },
    RevokeRoomAccess {
        room_id: String,
        user_id: Uuid,
    },
    Publish {
        publication: PublicationInput,
    },
    Unpublish {
        publication_id: Uuid,
    },
    SetTitle {
        publication_id: Uuid,
        title: Option<String>,
    },
    SetPaused {
        publication_id: Uuid,
        paused: bool,
    },
    TransferSource {
        publication_id: Uuid,
        to_session_id: Uuid,
    },
    Subscribe {
        publication_id: Uuid,
        enabled: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        helper_session_id: Option<Uuid>,
    },
    InputRegister {
        publication_id: Uuid,
        flow_id: Uuid,
        secret: [u8; 32],
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

pub(crate) fn title(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.encode_utf16().count() <= 64).then(|| value.to_owned())
}

pub const IDENTITY_IMAGE_URL_BYTES: usize = 24 * 1024;

fn identity_image(value: &str) -> bool {
    if value.len() > IDENTITY_IMAGE_URL_BYTES {
        return false;
    }
    let Some((media_type, encoded)) = value
        .strip_prefix("data:")
        .and_then(|data| data.split_once(";base64,"))
        .filter(|(media_type, _)| matches!(*media_type, "image/png" | "image/webp"))
    else {
        return false;
    };
    Base64::decode_vec(encoded)
        .is_ok_and(|bytes| crate::attachment::sniff_media_type(&bytes) == media_type)
}

/// Nullable, but present: omission must not silently clear an existing profile.
pub(crate) fn avatar<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let avatar = Option::<String>::deserialize(deserializer)?;
    if avatar
        .as_deref()
        .is_some_and(|value| !identity_image(value))
    {
        return Err(serde::de::Error::custom("invalid_identity_image"));
    }
    Ok(avatar)
}

/// A decorative key or a small retained raster, carried by its identity owner.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(try_from = "String")]
pub struct IdentityIcon(String);

impl Default for IdentityIcon {
    fn default() -> Self {
        Self("couch".into())
    }
}

impl TryFrom<String> for IdentityIcon {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Ok(Self(value));
        }
        if !identity_image(&value) {
            return Err("invalid_identity_icon");
        }
        Ok(Self(value))
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ScreenSource>,
    pub id: Uuid,
    pub room_id: String,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_settings: Option<VideoSettings>,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoResolution {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoCeiling {
    pub resolution: VideoResolution,
    pub max_framerate: f64,
    pub max_bitrate: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DegradationPreference {
    MaintainResolution,
    Balanced,
    MaintainFramerate,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoSettings {
    pub ceiling: VideoCeiling,
    pub degradation_preference: DegradationPreference,
}

pub fn validate_video_settings(
    kind: Kind,
    settings: Option<VideoSettings>,
) -> Result<(), &'static str> {
    match (kind, settings.map(|settings| settings.ceiling)) {
        (Kind::Voice, None) => Ok(()),
        (Kind::Screen, Some(value))
            if value.resolution.width > 0
                && value.resolution.height > 0
                && value.max_bitrate > 0
                && value.max_framerate.is_finite()
                && value.max_framerate > 0.0
                && value.max_framerate <= 9_007_199_254_740_991.0 =>
        {
            Ok(())
        }
        _ => Err("invalid_video_settings"),
    }
}

#[cfg(test)]
#[test]
fn video_settings_preserves_fractional_fps_and_rejects_invalid_source_facts() {
    let valid = VideoCeiling {
        resolution: VideoResolution {
            width: 1280,
            height: 720,
        },
        max_framerate: 29.97,
        max_bitrate: 2_500_000,
    };
    let settings = |ceiling| VideoSettings {
        ceiling,
        degradation_preference: DegradationPreference::Balanced,
    };
    assert_eq!(
        validate_video_settings(Kind::Screen, Some(settings(valid))),
        Ok(())
    );
    assert_eq!(validate_video_settings(Kind::Voice, None), Ok(()));
    for fps in [0.0, -1.0, f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
        assert!(validate_video_settings(
            Kind::Screen,
            Some(settings(VideoCeiling {
                max_framerate: fps,
                ..valid
            }))
        )
        .is_err());
    }
    for invalid in [
        VideoCeiling {
            max_bitrate: 0,
            ..valid
        },
        VideoCeiling {
            resolution: VideoResolution {
                width: 0,
                height: 720,
            },
            ..valid
        },
        VideoCeiling {
            resolution: VideoResolution {
                width: 1280,
                height: 0,
            },
            ..valid
        },
    ] {
        assert!(validate_video_settings(Kind::Screen, Some(settings(invalid))).is_err());
    }
    assert!(validate_video_settings(Kind::Screen, None).is_err());
    assert!(validate_video_settings(Kind::Voice, Some(settings(valid))).is_err());
    let input = PublicationInput {
        source: None,
        id: Uuid::new_v4(),
        room_id: "room".into(),
        kind: Kind::Voice,
        video_settings: None,
    };
    assert!(serde_json::to_value(input)
        .unwrap()
        .get("videoSettings")
        .is_none());
    let serialized = serde_json::to_value(valid).unwrap();
    assert_eq!(serialized["maxFramerate"], 29.97);
    assert_eq!(
        serde_json::from_value::<VideoCeiling>(serialized).unwrap(),
        valid
    );
    let mut aggregate = serde_json::to_value(settings(valid)).unwrap();
    assert_eq!(aggregate["ceiling"]["maxFramerate"], 29.97);
    assert_eq!(aggregate["degradationPreference"], "balanced");
    assert_eq!(
        serde_json::from_value::<VideoSettings>(aggregate.clone()).unwrap(),
        settings(valid)
    );
    aggregate
        .as_object_mut()
        .unwrap()
        .remove("degradationPreference");
    assert!(serde_json::from_value::<VideoSettings>(aggregate).is_err());
    assert!(serde_json::from_value::<PublicationInput>(serde_json::json!({"id":Uuid::new_v4(),"roomId":"room","kind":"screen","videoCeiling":valid})).is_err());
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
    pub udp: Option<UdpSignal>,
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
        if let Some(udp) = &self.udp {
            return self.resync.is_none()
                && self.exchange_id.is_none()
                && self.description.is_none()
                && self.candidate.is_none()
                && self.tracks.is_none()
                && match udp {
                    UdpSignal::Offer { prediction, .. } | UdpSignal::Answer { prediction } => {
                        prediction.target().is_some()
                    }
                    UdpSignal::Complete => true,
                };
        }
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UdpPreparation {
    Available,
    Required,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum UdpSignal {
    Offer {
        secret: [u8; 32],
        prediction: UdpPrediction,
    },
    Answer {
        prediction: UdpPrediction,
    },
    Complete,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UdpPrediction {
    pub address: std::net::Ipv4Addr,
    pub port: u16,
    pub step: u16,
}
impl UdpPrediction {
    pub fn target(&self) -> Option<std::net::SocketAddrV4> {
        let address = self.address;
        if address.is_private()
            || address.is_loopback()
            || address.is_link_local()
            || address.is_unspecified()
            || address.is_multicast()
            || address.is_broadcast()
            || self.port < 1024
            || self.step > 16
        {
            return None;
        }
        Some(std::net::SocketAddrV4::new(
            address,
            self.port.checked_add(4 * self.step)?,
        ))
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
    pub icon: IdentityIcon,
    pub creator_id: Uuid,
    pub access: RoomAccess,
    pub hidden: bool,
    pub has_password: bool,
    pub voice_bitrate: u32,
    #[serde(default = "crate::access::default_relay_capacity")]
    pub relay_capacity: u8,
    pub relay_override: Option<u8>,
    pub authorized: bool,
    pub can_manage: bool,
    pub available: bool,
    pub reading: bool,
    pub participant_session_ids: Vec<Uuid>,
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

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RoomInvitation {
    Missing,
    Available { key: String },
    Unrecoverable,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationInfo {
    #[serde(flatten)]
    pub screen: Option<ScreenInfo>,
    pub id: Uuid,
    pub room_id: String,
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub kind: Kind,
    pub paused: bool,
    pub audience: Vec<PublicationAudience>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_settings: Option<VideoSettings>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationAudience {
    pub session_id: Uuid,
    pub state: AudienceState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudienceState {
    Preparing,
    Active,
    Failed,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udp_preparation: Option<UdpPreparation>,
    pub peer_id: Uuid,
    #[serde(default)]
    pub can_receive_video_layers: bool,
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
pub struct UserInfo {
    pub id: Uuid,
    pub name: String,
    #[serde(deserialize_with = "avatar")]
    pub avatar: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub history_window: usize,
    pub id: Uuid,
    pub name: String,
    pub icon: IdentityIcon,
    pub owner_id: Option<Uuid>,
    pub rooms: Vec<Room>,
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
    pub failed_subscriptions: Vec<Uuid>,
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
    InputState {
        registrations: Vec<crate::input::InputRegistration>,
    },
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
        protocol: u8,
        credential: String,
        session_id: Uuid,
        state: Snapshot,
        #[serde(skip_serializing_if = "Option::is_none")]
        invitation_origin: Option<String>,
    },
    State {
        state: Snapshot,
    },
    Conversation {
        packet: crate::conversation::SignedPacket,
    },
    RoomInvite {
        room_id: String,
        key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    RoomInviteState {
        room_id: String,
        invitation: RoomInvitation,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    RoomCreated {
        room: crate::host::RoomSummary,
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

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    pub source: ScreenSource,
    pub title: Option<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenSource {
    pub kind: ScreenSourceKind,
    pub name: Option<String>,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenSourceKind {
    #[default]
    Screen,
    Camera,
}
