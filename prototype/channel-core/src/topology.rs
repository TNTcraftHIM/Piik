//! Request-scoped views of the room owner's accepted routing projection.
use crate::wire::FlowState;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomTopology {
    pub service_available: bool,
    pub service_enabled: bool,
    pub binding_id: Uuid,
    /// A current forwarding lease, not room Read permission or a separate participant role.
    #[serde(default)]
    pub transit_session: Option<Uuid>,
    pub session_ids: Vec<Uuid>,
    pub pairs: Vec<RoomPair>,
    pub screen: Option<ScreenTopology>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomPair {
    pub first: Uuid,
    pub second: Uuid,
    pub confirmed: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenTopology {
    pub publication_id: Uuid,
    pub source_session_id: Uuid,
    pub edges: Vec<ScreenEdge>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ScreenEdge {
    pub sender: Uuid,
    pub receiver: Uuid,
    pub selected: bool,
    pub proof: Option<FlowState>,
    // Committed plans retain delivery proof, not the former shadow's presentation sample.
    pub presented: Option<bool>,
    pub presentation: bool,
}
