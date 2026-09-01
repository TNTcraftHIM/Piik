# ADR-0009: Connection-Local NAT Candidate Experiment

- Status: accepted as an opt-in Browser experiment; default off
- Date: 2026-09-01

## Context

The self-hosted deployment has two auxiliary STUN-only listeners for controlled
NAT measurements. A disposable namespace lab showed that a sequential,
endpoint-dependent mapping can sometimes be reached when the remote peer
receives a small set of adjacent server-reflexive candidates. The result is
network- and generation-specific; it is not a reliable NAT type or participant
capability.

The existing route-policy and ICE candidate owners are sufficient. Making the
experiment room-wide requires one strict protocol revision for the added policy
field, but no new message type, route-controller state, or media path.

## Decision

1. Host Advanced settings exposes `NAT traversal experiment`, disabled by
   default and locked while sharing. It is part of the current share's room
   policy and is broadcast to every authenticated Viewer; it is not persisted
   beyond that share generation.
2. When enabled, every Browser P2P connection adds ports 3479 and 3480 for the
   same STUN authority already supplied by the server. This covers Host direct,
   Viewer upstream, and Viewer relay connections. SFU PeerConnections remain
   unchanged.
3. For one ICE gathering generation, the adapter observes only UDP `srflx`
   candidates. If three or more distinct candidates for one media section and
   public address form an arithmetic port sequence, it appends at most eight
   bounded candidates around the sequence's high endpoint (four in each
   direction). Every ordinary candidate keeps normal Trickle ICE timing; no
   ordinary candidate is delayed, rejected, or replaced. A failed or
   inconclusive experiment uses the existing ICE and SFU fallback unchanged.
4. Candidate observations remain in memory for that connection only. No NAT
   label, raw address, port, score, hard candidate skip, periodic probe, or
   route-controller branch is introduced.

## Consequences

Positive:

- operators can test the measured hole-punching mechanism without changing the
  default media path;
- normal ICE remains immediately available, so an unavailable auxiliary STUN
  listener or unsuccessful prediction cannot delay the existing direct or SFU
  fallback; and
- the experiment is bounded to one connection generation and one small
  candidate set.

Negative:

- the Browser may still reject synthetic candidates or the NAT may not have a
  matching mapping; and
- two endpoint-dependent NATs remain sensitive to candidate scheduling and
  intervening mappings, so room-wide coverage is not a success guarantee.

The controlled lab result (14/15 sequential-to-restricted runs with a bounded
prediction set) is mechanism evidence, not a production success guarantee.
Target-network prevalence, candidate direction, and long-run resource impact
remain acceptance work.

## Primary Sources

- [RFC 8445: Interactive Connectivity Establishment](https://www.rfc-editor.org/rfc/rfc8445)
- [RFC 4787: UDP NAT behavioral requirements](https://www.rfc-editor.org/rfc/rfc4787)
- [RFC 5780: NAT Behavior Discovery Using STUN](https://www.rfc-editor.org/rfc/rfc5780)
- [W3C WebRTC candidate model](https://www.w3.org/TR/webrtc/)
