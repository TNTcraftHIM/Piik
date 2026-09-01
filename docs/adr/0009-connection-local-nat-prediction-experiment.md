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

The current WebRTC signaling contract already carries ICE candidates. A safe
experiment therefore needs no new message shape, route state, or media path.

## Decision

1. Host Advanced settings exposes `NAT traversal experiment`, disabled by
   default and locked while sharing. The choice is local to that page and is
   read when each new connection is created; it is not persisted or broadcast
   as a room policy.
2. When enabled, Host-originated direct `HostPeer` connections add ports 3479
   and 3480 for the same STUN authority already supplied by the server. The
   server-provided STUN entries remain unchanged. SFU, ViewerPeer, and Viewer
   relay connections keep the stock ICE configuration.
3. For one ICE gathering generation, the adapter observes only UDP `srflx`
   candidates. If three or more distinct candidates for one media section and
   public address form an arithmetic port sequence, it appends at most eight
   bounded candidates around the latest observation (four in each direction).
   Every ordinary candidate is retained; no ordinary candidate is rejected or
   replaced. A failed or inconclusive experiment uses the existing ICE and SFU
   fallback unchanged.
4. Candidate observations remain in memory for that connection only. No NAT
   label, raw address, port, score, hard candidate skip, periodic probe, or
   route-controller branch is introduced.

## Consequences

Positive:

- operators can test the measured hole-punching mechanism without changing the
  default media path;
- normal ICE remains available, so an unsuccessful prediction cannot remove
  the existing direct or SFU fallback; and
- the experiment is bounded to one connection generation and one small
  candidate set.

Negative:

- the Browser may still reject synthetic candidates or the NAT may not have a
  matching mapping; and
- the current implementation covers Host-originated direct edges only. It does
  not claim to improve Viewer relay edges or two endpoint-dependent NATs.

The controlled lab result (14/15 sequential-to-restricted runs with a bounded
prediction set) is mechanism evidence, not a production success guarantee.
Target-network prevalence, candidate direction, and long-run resource impact
remain acceptance work.

## Primary Sources

- [RFC 8445: Interactive Connectivity Establishment](https://www.rfc-editor.org/rfc/rfc8445)
- [RFC 4787: UDP NAT behavioral requirements](https://www.rfc-editor.org/rfc/rfc4787)
- [RFC 5780: NAT Behavior Discovery Using STUN](https://www.rfc-editor.org/rfc/rfc5780)
- [W3C WebRTC candidate model](https://www.w3.org/TR/webrtc/)
