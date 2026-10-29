//! Input uses the committed picture lineage. Relays route opaque encrypted data;
//! only the source's device owner can authorize or execute it.
use crate::wire::{FlowBinding, Kind, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputRegistration {
    pub publication_id: Uuid,
    pub controller_session_id: Uuid,
    pub flow_id: Uuid,
    pub secret: [u8; 32],
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputFrame {
    pub publication_id: Uuid,
    pub controller_session_id: Uuid,
    pub route_id: Uuid,
    pub flow_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready: Option<bool>,
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputHop {
    pub pair_id: Uuid,
    pub peer_id: Uuid,
    pub flow_id: Uuid,
}

/// One reverse binding per (publication, controller), held by the existing
/// connection owner. No secret, graph or device grant belongs here.
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputBinding {
    pub publication_id: Uuid,
    pub controller_session_id: Uuid,
    pub route_id: Uuid,
    pub upstream: Option<InputHop>,
    pub downstream: Option<InputHop>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRoute {
    pub next_hop: Option<Uuid>,
    pub binding: InputBinding,
}

fn hop(
    state: &Snapshot,
    publication: Uuid,
    id: Uuid,
    incoming: bool,
) -> Option<(InputHop, FlowBinding)> {
    state.pairs.iter().find_map(|pair| {
        let flows = if incoming {
            &pair.incoming
        } else {
            &pair.outgoing
        };
        let flow = flows
            .iter()
            .find(|f| f.id == id && f.publication_id == publication && f.selected)?;
        Some((
            InputHop {
                pair_id: pair.id,
                peer_id: pair.peer_id,
                flow_id: id,
            },
            *flow,
        ))
    })
}

impl InputBinding {
    /// The same predicate fences receipt, queued sends and retirement.
    pub fn current(&self, local: Uuid, state: &Snapshot) -> bool {
        let Some(publication) = state
            .publications
            .iter()
            .find(|p| p.id == self.publication_id && p.kind == Kind::Screen)
        else {
            return false;
        };
        if !state
            .sessions
            .iter()
            .any(|s| s.id == self.controller_session_id)
        {
            return false;
        }
        if let Some(up) = &self.upstream {
            if hop(state, self.publication_id, up.flow_id, true)
                .is_none_or(|(current, _)| current != *up)
            {
                return false;
            }
        }
        if let Some(down) = &self.downstream {
            let Some((current, flow)) = hop(state, self.publication_id, down.flow_id, false) else {
                return false;
            };
            current == *down
                && match &self.upstream {
                    Some(up) => flow.input_flow_id == Some(up.flow_id),
                    None => flow.input_flow_id.is_none() && publication.session_id == local,
                }
        } else {
            local == self.controller_session_id
                && state.subscriptions.contains(&self.publication_id)
                && self
                    .upstream
                    .as_ref()
                    .is_some_and(|up| up.flow_id == self.route_id)
        }
    }
}

/// Requests follow outgoing.inputFlowId toward the source. Replies use only
/// the exact reverse binding installed by such a request, while still selected.
pub fn route(
    frame: &mut InputFrame,
    local: Uuid,
    state: &Snapshot,
    from: Option<Uuid>,
    binding: Option<&InputBinding>,
) -> Result<InputRoute, &'static str> {
    if usize::from(frame.data.is_some())
        + usize::from(frame.closed == Some(true))
        + usize::from(frame.ready == Some(true))
        != 1
        || frame.closed == Some(false)
        || frame.ready == Some(false)
        || serde_json::to_vec(frame)
            .map_err(|_| "invalid_input_frame")?
            .len()
            > crate::conversation::CONTROL_FRAME_BYTES
    {
        return Err("invalid_input_frame");
    }
    if let Some(binding) =
        binding.filter(|binding| binding.upstream.as_ref().map(|hop| hop.peer_id) == from)
    {
        if binding.publication_id != frame.publication_id
            || binding.controller_session_id != frame.controller_session_id
            || binding.route_id != frame.route_id
            || !binding.current(local, state)
            || binding
                .upstream
                .as_ref()
                .or(binding.downstream.as_ref())
                .is_none_or(|hop| hop.flow_id != frame.flow_id)
        {
            return Err("stale_input_route");
        }
        if let Some(down) = &binding.downstream {
            frame.flow_id = down.flow_id;
        }
        return Ok(InputRoute {
            next_hop: binding.downstream.as_ref().map(|hop| hop.peer_id),
            binding: binding.clone(),
        });
    }
    let downstream = if let Some(from) = from {
        let (hop, _) = hop(state, frame.publication_id, frame.flow_id, false)
            .ok_or("unassigned_input_route")?;
        if hop.peer_id != from {
            return Err("unassigned_input_route");
        }
        Some(hop)
    } else {
        if local != frame.controller_session_id || frame.route_id != frame.flow_id {
            return Err("unassigned_input_route");
        }
        None
    };
    let input = if downstream.is_some() {
        hop(state, frame.publication_id, frame.flow_id, false)
            .unwrap()
            .1
            .input_flow_id
    } else {
        Some(frame.flow_id)
    };
    let upstream = input
        .map(|id| {
            hop(state, frame.publication_id, id, true)
                .map(|(hop, _)| hop)
                .ok_or("unassigned_input_route")
        })
        .transpose()?;
    let binding = InputBinding {
        publication_id: frame.publication_id,
        controller_session_id: frame.controller_session_id,
        route_id: frame.route_id,
        upstream,
        downstream,
    };
    if !binding.current(local, state) {
        return Err("unassigned_input_route");
    }
    if let Some(up) = &binding.upstream {
        frame.flow_id = up.flow_id;
    }
    Ok(InputRoute {
        next_hop: binding.upstream.as_ref().map(|hop| hop.peer_id),
        binding,
    })
}
