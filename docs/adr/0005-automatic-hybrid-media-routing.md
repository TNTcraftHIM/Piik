# ADR-0005: Automatic Hybrid Media Routing

- Status: Accepted invariants; assisted-route resource model pending
- Date: 2026-08-20
- Last updated: 2026-08-22

## Context

Screener serves one broadcaster and a small group of trusted viewers. Direct
browser WebRTC gives the desired latency and avoids central media cost, but a
single Host cannot safely fan out to every Viewer and some networks cannot
establish a usable peer path.

The product therefore needs one automatic route controller. Users do not choose
or understand the topology. The controller may use peers and bounded
server-assisted resources, but it must keep the ordinary media graph
distributed, deterministic, authorized, and recoverable.

This ADR records the accepted invariants and the assisted-route boundary that
still needs one holistic decision.

## Decision

### Endpoint capacity

Every non-server endpoint uses the same server-authoritative downstream media
capacity:

- the deployment default is `2`;
- the only accepted static values are `1`, `2`, and `3`;
- an upstream receive edge does not consume this downstream budget;
- role, browser, user agent, device class, and page visibility do not create a
  different release tier;
- a client advertisement may reduce its usable capacity but cannot exceed the
  deployment value; and
- one named configuration value and one shared implementation boundary own the
  policy. Route code must not repeat literal policy numbers.

This capacity applies to ordinary downstream endpoint edges. It does not by
itself define how SFU publication, SFU subscription, TURN transport, server
egress, or temporary migration overlap are accounted.

### Active topology

The server owns one versioned route assignment per room. At every committed
revision:

- the Host has no upstream;
- each Viewer has exactly zero or one active upstream;
- the active media graph is acyclic;
- every ordinary parent stays within the authoritative endpoint capacity;
- healthy unaffected branches remain sticky; and
- admission or recovery ends in a valid assignment, an explicit wait, or a
  bounded failure.

Direct or peer UDP remains the first media choice. Ordinary peer
`RTCPeerConnection` instances receive STUN candidates only; TURN candidates are
not distributed to ordinary peer edges by default. HTTPS and WSS continue to
use TLS/TCP independently of media transport.

Routing is event-driven. Join, capacity release, endpoint departure, current-edge
failure, and accepted path-health evidence may open a bounded reassignment. The
controller does not continuously optimize the room, infer policy from a user
agent, or aggregate unrelated paths into a room-wide quality score.

### Authorization and transition

Every prepare, signal, recovery, commit, and rollback is bound to the exact
room, share generation, endpoint sessions, route revision, assignment
generation, connection identity, and publication generation when one exists.
A stale or mismatched asynchronous result fails closed and cannot revive an old
edge.

A route replacement uses make-before-break only when the still-to-be-defined
resource model admits the overlap. The old route remains authoritative until
the new route proves current-generation media with a live track, positive RTP
progress, and decoded-frame progress. ICE `connected` alone is insufficient.
Commit promotes that exact candidate atomically; timeout, failure, stale
identity, or revoked authority destroys it and keeps or restores the previous
valid route.

Recovery attempts are finite, generation-bound, and stop after success. The
controller must not turn a rare failure into an unbounded retry loop, an
unbounded server fanout, or a hidden third route.

## Pending Assisted-Route Decision

The following items must be designed together before dependent implementation
or deployment:

- who publishes to an SFU and from which topology level;
- which endpoints subscribe and whether one publication can serve roots or
  network-restricted leaves at different levels;
- where selected TURN is permitted and whether it transports a peer edge, an
  SFU ingress, or another explicitly authorized edge;
- how endpoint capacity, server ingress/egress admission, SFU resources, TURN
  resources, and provisional overlap are counted;
- the exact fallback and recovery sequence when the Host, a relay parent, or a
  leaf is network-restricted; and
- how relay downgrade, sibling migration, and make-before-break remain bounded
  for static capacities `1`, `2`, and `3`.

SFU and TURN are bounded fallback resources, not authorization for an always-SFU
room or unbounded central fanout. Conversely, ordinary endpoint child count
must not be copied onto a server as an implicit server cap. The accepted model
must state both endpoint and deployment resource bounds explicitly and justify
them with measurements.

## Current Production Divergence

Production release `9461e20` predates this revision. Its exact behavior is owned
by the deployment document. Generation guards, scoped authorization,
media-proven transitions, and bounded recovery remain reusable only where they
satisfy this ADR.

That release remains a deployment fact and rollback reference. It must not be
merged wholesale into a new route implementation. After the pending model is
accepted, retained code and tests are transplanted from current `main` by
invariant; obsolete policy is replaced at its owner.

## Acceptance Boundary

Before a revised controller ships:

- property tests cover capacity `1`, `2`, and `3`, one active upstream,
  acyclic assignments, stale generations, duplicate signals, departure,
  rollback, and admission exhaustion;
- route changes preserve unaffected branches and never commit before media
  proof;
- real-browser tests cover direct peer media, peer relay, server-assisted media,
  selected transport when configured, failure, and recovery;
- measured endpoint upload and server ingress/egress prove the accepted
  accounting under normal and migration overlap; and
- every exhausted path reaches a clear bounded wait or failure without leaking
  credentials, candidates, addresses, or raw errors.

Loopback timing and synthetic signaling tests may validate invariants, but they
do not prove target-network latency, quality, capacity, or interoperability.

## Security and privacy

Media authority is room-, role-, session-, share-, revision-, and
connection-bound. Server-assisted credentials are short-lived, scoped,
memory-only, and never placed in URLs, logs, browser persistence, or SQLite.
Ordinary SFU transport terminates DTLS-SRTP at the SFU; the product must not
claim application E2EE unless key distribution and real media evidence exist.

## Consequences

Positive:

- one capacity rule replaces role and browser policy forks;
- route safety is expressed through graph, identity, and media invariants;
- the unresolved server-assisted cases stay visible without being guessed into
  runtime behavior.

Negative:

- the deployed controller intentionally diverges until the assisted-route model
  is accepted and migrated;
- make-before-break cannot be finalized independently of resource accounting;
  and
- real SFU/TURN and target-network evidence is still required.

## Relationship to other ADRs

- ADR-0001 owns the original browser P2P baseline.
- ADR-0004 is historical evidence about browser peer relay and re-encoding; it
  does not set current capacity or server-assisted policy.
- ADR-0007 owns path-quality evidence and representation behavior. Quality may
  affect route eligibility but does not become a second route controller.

## References

- [WebRTC](https://w3c.github.io/webrtc-pc/)
- [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC transports, RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html)
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html)
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/#selective-subscription)
- [LiveKit track subscription permissions](https://docs.livekit.io/transport/media/publish/#track-permissions)
