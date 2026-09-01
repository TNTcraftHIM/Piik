# ADR-0009: Optional Connection-Local NAT Prediction

- Status: accepted as an optional deployment capability
- Date: 2026-09-02

## Context

The self-hosted deployment has two auxiliary STUN-only listeners for controlled
NAT measurements. A disposable namespace lab showed that a sequential,
endpoint-dependent mapping can sometimes be reached when the remote peer
receives a small set of adjacent server-reflexive candidates. The result is
network- and generation-specific; it is not a reliable NAT type or participant
capability.

The existing deployment configuration, route policy, and ICE candidate owners
are sufficient. The mechanism needs no NAT label, route-controller state, new
media path, or third-party STUN dependency.

## Decision

1. `NAT_PREDICTION_ENABLED` defaults to `false`. A disabled deployment does not
   expose the Host control and the server rejects NAT prediction in the room
   policy. An enabled deployment exposes `NAT traversal`; the pre-share switch
   defaults on, remains Host-controllable, locks while sharing, and is not
   persisted beyond that share generation.
2. An enabled deployment derives ports 3479 and 3480 from the first ordinary
   STUN authority on UDP 3478. When the share switch is on, every Browser P2P
   connection adds those same-host endpoints. This covers Host direct, Viewer
   upstream, and Viewer relay connections. SFU PeerConnections remain
   unchanged. No independent or third-party STUN endpoint is added.
3. For one ICE gathering generation, the adapter observes only UDP `srflx`
   candidates whose Browser-reported STUN URL belongs to the self-hosted
   3478/3479/3480 survey set. If three or more distinct survey candidates for
   one media section and public address form an arithmetic port sequence, the
   adapter appends at most eight bounded candidates outward from both sequence
   endpoints: four above the high endpoint and four below the low endpoint.
   Every ordinary candidate keeps normal Trickle ICE timing; no ordinary
   candidate is delayed, rejected, or replaced. A Browser that does not expose
   candidate source URLs keeps ordinary ICE without prediction. Rejection of a
   predicted remote candidate discards only that optional candidate; ordinary
   candidate errors retain their normal connection error semantics.
4. Candidate observations remain in memory for that connection only. No NAT
   label, raw address, port, score, hard candidate skip, periodic probe, or
   route-controller branch is introduced. Sanitized diagnostics record only
   whether a signaled candidate was ordinary, predicted, or end-of-candidates,
   and whether the selected remote foundation was ordinary, predicted, or
   unknown.

## Consequences

Positive:

- deployments that operate the required STUN listeners can offer the bounded
  mechanism while smaller deployments retain stock ICE;
- normal ICE remains immediately available, so an unavailable auxiliary STUN
  listener or unsuccessful prediction cannot delay direct or SFU fallback;
- prediction is bounded to one connection generation and one small candidate
  set; and
- selected-foundation attribution can validate actual field benefit without
  uploading candidate endpoints.

Negative:

- the Browser may still reject synthetic candidates or the NAT may not have a
  matching mapping;
- enabled P2P connections perform two extra self-hosted STUN transactions and
  may add connectivity checks for up to eight adjacent UDP ports; and
- two endpoint-dependent NATs remain sensitive to candidate scheduling and
  intervening mappings, so room-wide coverage is not a success guarantee.

Predicted connectivity checks originate from participant Browsers and target
the other participant's bounded candidate window. The Screener server only
receives Binding requests on its fixed 3478/3479/3480 listeners; enabling this
capability does not make the cloud host scan external ports.

The controlled lab result (14/15 sequential-to-restricted runs with a bounded
prediction set) is mechanism evidence, not a production success guarantee.
Target-network prevalence, candidate direction, and long-run resource impact
remain acceptance work.

## Primary Sources

- [RFC 8445: Interactive Connectivity Establishment](https://www.rfc-editor.org/rfc/rfc8445)
- [RFC 4787: UDP NAT behavioral requirements](https://www.rfc-editor.org/rfc/rfc4787)
- [RFC 5780: NAT Behavior Discovery Using STUN](https://www.rfc-editor.org/rfc/rfc5780)
- [W3C WebRTC candidate model](https://www.w3.org/TR/webrtc/)
