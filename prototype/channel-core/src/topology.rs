//! Request-scoped views of the room owner's accepted routing projection.
use crate::wire::FlowState;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomTopology {
    pub binding_id: Uuid,
    pub base: BaseTopology,
    pub screen: Option<ScreenTopology>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseTopology {
    pub root_session_id: Uuid,
    pub edges: Vec<BaseEdge>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct BaseEdge {
    pub sender: Uuid,
    pub receiver: Uuid,
    pub ready: bool,
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
