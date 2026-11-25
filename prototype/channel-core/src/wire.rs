use base64ct::{Base64, Encoding};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

pub const CHANNEL_PROTOCOL: u8 = 47;
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
        can_use_peer_transport: bool,
        #[serde(default)]
        can_prepare_udp: bool,
        #[serde(default)]
        can_receive_video_layers: bool,
    },
    SetProfile {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(
            default,
            deserialize_with = "picture_patch",
            skip_serializing_if = "Option::is_none"
        )]
        avatar: Option<Option<String>>,
    },
    Profiles {
        ids: Option<Vec<Uuid>>,
        after: Option<Uuid>,
        query: Option<String>,
    },
    UpdateDomain {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        icon: Option<IdentityIcon>,
    },
    SetRoomCreationPolicy {
        policy: RoomCreationPolicy,
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
    ByteBranchRefused {
        room_id: String,
        target: ByteBranchTarget,
        downstream_id: Uuid,
    },
    ForwardingAvailable {
        room_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<crate::forwarding::ForwardingKind>,
    },
    FileReceive {
        room_id: String,
        message_seq: u64,
        attachment_id: Uuid,
        enabled: bool,
    },
    ObserveFiles {
        room_id: String,
        observation_id: Uuid,
        keys: Vec<(u64, Uuid)>,
    },
    HostRegister {
        room: crate::host::RoomSummary,
        resume_binding: Option<Uuid>,
    },
    CancelRoomCreation {
        room_id: String,
    },
    CreateRoom {
        room: crate::host::RoomSummary,
        #[serde(
            default,
            deserialize_with = "avatar",
            skip_serializing_if = "Option::is_none"
        )]
        picture: Option<String>,
        password: Option<String>,
        #[serde(default)]
        allow_service_relay: bool,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        icon: Option<RoomIcon>,
        #[serde(
            default,
            deserialize_with = "picture_patch",
            skip_serializing_if = "Option::is_none"
        )]
        picture: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        access: Option<RoomAccess>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hidden: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voice_bitrate: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        relay_capacity: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        allow_service_relay: Option<bool>,
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
    StartWatch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replace_id: Option<Uuid>,
        room_id: String,
        id: Uuid,
        source: WatchSource,
        playback: WatchPlayback,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        byte_source: Option<WatchByteSource>,
    },
    UpdateWatch {
        room_id: String,
        id: Uuid,
        playback: WatchPlayback,
    },
    SetWatchByteSource {
        room_id: String,
        id: Uuid,
        byte_source: Option<WatchByteSource>,
    },
    JoinWatch {
        room_id: String,
        id: Uuid,
        mode: Option<WatchMode>,
    },
    StopWatch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        successor_screen_id: Option<Uuid>,
        room_id: String,
        id: Uuid,
    },
    Publish {
        publication: PublicationInput,
    },
    Unpublish {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        successor_watch_id: Option<Uuid>,
        publication_id: Uuid,
    },
    SetScreenDirectLimit {
        publication_id: Uuid,
        limit: Option<u8>,
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
    RoomDataState {
        room_id: String,
        pair_id: Uuid,
        ready: bool,
    },
    Leave,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(flatten)]
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

fn picture_patch<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    avatar(d).map(Some)
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RoomCreationPolicy {
    #[default]
    Ordinary,
    InviteOnly,
    OwnerOnly,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostingMode {
    #[default]
    Lightweight,
    Hosted,
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}

pub(crate) fn title(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.encode_utf16().count() <= 64).then(|| value.to_owned())
}

pub const IDENTITY_IMAGE_URL_BYTES: usize = 24 * 1024;

pub(crate) fn identity_image(value: &str) -> bool {
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

fn icon_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// A decorative key that can be published in a channel's room directory.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(try_from = "String")]
pub struct RoomIcon(String);

impl Default for RoomIcon {
    fn default() -> Self {
        Self("couch".into())
    }
}

impl TryFrom<String> for RoomIcon {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if icon_key(&value) {
            Ok(Self(value))
        } else {
            Err("invalid_room_icon")
        }
    }
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
        if !icon_key(&value) && !identity_image(&value) {
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
        (Kind::Voice | Kind::Screen, None) => Ok(()),
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
    assert_eq!(validate_video_settings(Kind::Screen, None), Ok(()));
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
                    UdpSignal::Offer { observation, .. } | UdpSignal::Answer { observation } => {
                        observation.valid()
                    }
                    UdpSignal::Ready {} | UdpSignal::Unavailable {} | UdpSignal::Complete => true,
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
                    && (candidate.origin.is_none()
                        || (candidate
                            .candidate
                            .as_ref()
                            .is_some_and(|value| !value.trim().is_empty())
                            && candidate
                                .username_fragment
                                .as_ref()
                                .is_some_and(|value| !value.trim().is_empty())))
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
        observation: UdpObservation,
    },
    Answer {
        observation: UdpObservation,
    },
    Ready {},
    Unavailable {},
    Complete,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UdpObservation {
    Stable {
        address: std::net::Ipv4Addr,
        port: u16,
    },
    Sequential {
        address: std::net::Ipv4Addr,
        port: u16,
        step: i16,
    },
    Irregular {
        address: std::net::Ipv4Addr,
    },
}
impl UdpObservation {
    pub fn address(&self) -> std::net::Ipv4Addr {
        match *self {
            Self::Stable { address, .. }
            | Self::Sequential { address, .. }
            | Self::Irregular { address } => address,
        }
    }
    pub fn valid(&self) -> bool {
        let address = self.address();
        if address.is_private()
            || address.is_loopback()
            || address.is_link_local()
            || address.is_unspecified()
            || address.is_multicast()
            || address.is_broadcast()
        {
            return false;
        }
        match *self {
            Self::Stable { port, .. } => port >= 1024,
            Self::Sequential { port, step, .. } => {
                port >= 1024
                    && step != 0
                    && (-16..=16).contains(&step)
                    && (1024..=65535).contains(&(i32::from(port) + 4 * i32::from(step)))
            }
            Self::Irregular { .. } => true,
        }
    }
    pub fn target(&self) -> Option<std::net::SocketAddrV4> {
        if !self.valid() {
            return None;
        }
        let port = match *self {
            Self::Stable { port, .. } => port,
            Self::Sequential { port, step, .. } => (i32::from(port) + 4 * i32::from(step)) as u16,
            Self::Irregular { .. } => return None,
        };
        Some(std::net::SocketAddrV4::new(self.address(), port))
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
    pub origin: Option<CandidateOrigin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdp_mid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdp_m_line_index: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username_fragment: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateOrigin {
    Linear,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_lineage: Option<Uuid>,
    pub last_message_seq: u64,
    pub id: String,
    pub name: String,
    pub icon: RoomIcon,
    #[serde(
        default,
        deserialize_with = "avatar",
        skip_serializing_if = "Option::is_none"
    )]
    pub picture: Option<String>,
    pub creator_id: Uuid,
    pub access: RoomAccess,
    pub hidden: bool,
    pub has_password: bool,
    pub voice_bitrate: u32,
    #[serde(default = "crate::access::default_relay_capacity")]
    pub relay_capacity: u8,
    pub relay_override: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_relay: Option<ServiceRelay>,
    pub authorized: bool,
    pub can_manage: bool,
    pub available: bool,
    pub reading: bool,
    pub participant_session_ids: Vec<Uuid>,
    pub file_activity: Vec<FileActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_availability: Option<FileAvailability>,
    pub capabilities: RoomCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<RoomDelivery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<Uuid>>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct ServiceRelay {
    pub enabled: bool,
    pub available: bool,
}

/// Send and receive roles in current room file transfers, including forwarding.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActivity {
    pub session_id: Uuid,
    pub sending: bool,
    pub receiving: bool,
}

/// The current room writer binding for commands and confirmed conversation.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDelivery {
    pub host_session_id: Uuid,
    pub binding_id: Uuid,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomCapabilities {
    pub attachments: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub history_seek: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_availability_limit: Option<usize>,
}

pub const FILE_AVAILABILITY_LIMIT: usize =
    crate::history::HISTORY_PAGE * crate::attachment::ATTACHMENT_LIMITS.max_attachments_per_message;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAvailability {
    pub observation_id: Uuid,
    pub available: Vec<bool>,
}

#[cfg(test)]
#[test]
fn file_availability_wire_is_additive() {
    let observation_id = Uuid::from_u128(1);
    let attachment_id = Uuid::from_u128(2);
    let command = serde_json::json!({
        "type": "observe_files",
        "roomId": "room",
        "observationId": observation_id,
        "keys": [[7, attachment_id]]
    });
    let decoded: Command = serde_json::from_value(command.clone()).unwrap();
    assert!(
        matches!(&decoded, Command::ObserveFiles { keys, .. } if keys == &[(7, attachment_id)])
    );
    assert_eq!(serde_json::to_value(decoded).unwrap(), command);

    let policy = crate::RoomState::new(
        "room".into(),
        "Room".into(),
        Default::default(),
        observation_id,
        RoomAccess::Private,
        false,
        None,
    )
    .unwrap();
    let mut room = policy.view(observation_id).unwrap();
    let legacy = serde_json::to_value(&room).unwrap();
    assert!(legacy.get("fileAvailability").is_none());
    assert!(legacy["capabilities"]
        .get("fileAvailabilityLimit")
        .is_none());
    let decoded: Room = serde_json::from_value(legacy).unwrap();
    assert!(decoded.file_availability.is_none());
    assert!(decoded.capabilities.file_availability_limit.is_none());

    room.file_availability = Some(FileAvailability {
        observation_id,
        available: vec![true, false],
    });
    room.capabilities.file_availability_limit = Some(FILE_AVAILABILITY_LIMIT);
    let encoded = serde_json::to_value(room).unwrap();
    assert_eq!(
        encoded["fileAvailability"],
        serde_json::json!({ "observationId": observation_id, "available": [true, false] })
    );
    assert_eq!(encoded["capabilities"]["fileAvailabilityLimit"], 400);
}

#[cfg(test)]
#[test]
fn history_seek_capability_is_optional() {
    let old = serde_json::json!({ "attachments": true });
    let mut capabilities: RoomCapabilities = serde_json::from_value(old.clone()).unwrap();
    assert!(!capabilities.history_seek);
    assert_eq!(serde_json::to_value(&capabilities).unwrap(), old);

    capabilities.history_seek = true;
    let new = serde_json::to_value(&capabilities).unwrap();
    assert_eq!(
        new,
        serde_json::json!({ "attachments": true, "historySeek": true })
    );

    #[derive(Deserialize)]
    struct LegacyCapabilities {
        attachments: bool,
    }

    assert!(
        serde_json::from_value::<LegacyCapabilities>(new)
            .unwrap()
            .attachments
    );
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RoomInvitation {
    Missing,
    Available { key: String },
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
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub presentation: bool,
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
    pub version: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct UserSummary {
    pub id: Uuid,
    pub name: String,
    pub version: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub hosting_mode: HostingMode,
    pub room_creation_policy: RoomCreationPolicy,
    pub managed_room_ids: Vec<String>,
    pub user_count: usize,
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
    pub watch_activities: Vec<WatchActivity>,
    pub watch_subscriptions: Vec<WatchSubscription>,
    pub watch_bytes: Vec<crate::watch_delivery::WatchBytePlan>,
    pub files: Vec<crate::file_room::FilePlan>,
    pub channel: ChannelInfo,
    pub users: Vec<UserSummary>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<crate::history::Mention>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<crate::history::MessageReply>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub inline_images: BTreeMap<Uuid, crate::attachment::ImageRendition>,
    pub seq: u64,
    pub attachments: Vec<crate::attachment::AttachmentDescriptor>,
    pub id: Uuid,
    pub user_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_author_name: Option<String>,
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
        self_profile: UserInfo,
        session_id: Uuid,
        connection_id: Uuid,
        state: Snapshot,
        #[serde(skip_serializing_if = "Option::is_none")]
        invitation_origin: Option<String>,
    },
    State {
        state: Snapshot,
    },
    Profiles {
        request_id: String,
        profiles: Vec<UserInfo>,
        total: usize,
        next_cursor: Option<Uuid>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum ViewSource {
    Screen(Uuid),
    Watch(Uuid),
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predecessor: Option<ViewSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_limit: Option<u8>,
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

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchPlayback {
    pub timeline: WatchTimeline,
    pub position: f64,
    pub paused: bool,
    pub rate: f64,
    pub anchor_time: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchTimeline {
    Media,
    Program,
}
impl WatchPlayback {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if !self.position.is_finite()
            || self.position < 0.0
            || !self.rate.is_finite()
            || self.rate <= 0.0
            || self.rate > 16.0
        {
            return Err("invalid_watch_playback");
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchActivity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predecessor: Option<ViewSource>,
    pub id: Uuid,
    pub room_id: String,
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub source: WatchSource,
    pub playback: WatchPlayback,
    /// Joined viewing intent across delivery modes, not decoded/playback readiness.
    pub viewer_session_ids: Vec<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_source: Option<WatchByteSource>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchMode {
    Direct,
    Peer,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchSubscription {
    pub id: Uuid,
    pub mode: WatchMode,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ByteBranchTarget {
    File { message_seq: u64, attachment_id: Uuid, source_id: Uuid },
    Watch { activity_id: Uuid, source: WatchByteSource },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchFormat {
    File,
    Hls,
    Dash,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchByteSource {
    pub session_id: Uuid,
    pub resource_id: Uuid,
    pub format: WatchFormat,
}
#[cfg(test)]
#[test]
fn watch_formats_keep_the_opaque_source_contract() {
    let session_id = Uuid::from_u128(1);
    let resource_id = Uuid::from_u128(2);
    for (format, name) in [
        (WatchFormat::File, "file"),
        (WatchFormat::Hls, "hls"),
        (WatchFormat::Dash, "dash"),
    ] {
        let source = WatchByteSource {
            session_id,
            resource_id,
            format,
        };
        let wire = serde_json::to_value(&source).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({"sessionId":session_id,"resourceId":resource_id,"format":name})
        );
        assert_eq!(
            serde_json::from_value::<WatchByteSource>(wire.clone()).unwrap(),
            source
        );
        let mut expanded = wire;
        expanded["url"] = serde_json::json!("https://owned.test/private");
        assert!(serde_json::from_value::<WatchByteSource>(expanded).is_err());
    }
    assert!(serde_json::from_str::<WatchFormat>("\"future\"").is_err());
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WatchSource {
    Media {
        url: String,
    },
    Website {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_url: Option<String>,
    },
}
impl WatchSource {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Media { url } => validate_watch_url(url),
            Self::Website { url, media_url } => {
                validate_watch_url(url)?;
                if let Some(media_url) = media_url {
                    validate_watch_url(media_url)?;
                }
                Ok(())
            }
        }
    }
}
fn validate_watch_url(value: &str) -> Result<(), &'static str> {
    if value.len() > 4096 || value.trim() != value {
        return Err("invalid_watch_url");
    }
    let url = url::Url::parse(value).map_err(|_| "invalid_watch_url")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("invalid_watch_url");
    }
    Ok(())
}
