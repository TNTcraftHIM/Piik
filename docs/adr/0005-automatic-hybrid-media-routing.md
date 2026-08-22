# ADR-0005: Automatic Hybrid Media Routing

- Status: Accepted route model; runtime migration pending
- Date: 2026-08-20
- Last updated: 2026-08-23

## Context

Screener serves one broadcaster and a small group of trusted viewers. Direct
browser WebRTC gives the desired latency and avoids central media cost, but a
single Host cannot safely fan out to every Viewer and some networks cannot
establish a usable peer path.

The product therefore needs one automatic route controller. Users do not choose
or understand the topology. The controller may use peers and bounded
server-assisted resources, but it must keep the ordinary media graph
distributed, deterministic, authorized, and recoverable.

This ADR records the accepted invariants and the complete assisted-route model.

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

The server returns the final deployment value as
`authenticated.endpointMediaCopyCapacity` on every successful signaling
authentication. Web and Native clients validate `1..3`; a Native Host uses that
same value for ordinary Viewer admission, authoritative peer-assisted child
assignments, and physical sender slots. Room `maxViewers` is a separate
participant-admission limit and never supplies a sender budget. A missing or
invalid capacity fails before route authority is accepted.

Without the peer-assisted controller, signaling still admits at most that many
active Host children per room. Excess admitted Viewers wait without an
authorized media edge and are promoted in stable join order when a slot is
released; offer, answer, candidate, and restart routing is limited to the active
set.

Capacity counts active outbound media copies produced by a non-server endpoint:
an ordinary peer child consumes one slot and the Host's single SFU publication
consumes one Host slot. An upstream receive edge is free. A committed selected
TURN transport replaces the transport of its logical edge and consumes the same
single steady slot; a parallel media-producing candidate requires a separately
reserved transition slot. SFU subscriptions consume server egress, not endpoint
capacity.

### Active topology

The server owns one versioned route assignment per room. At every committed
revision:

- the Host has no upstream;
- each Viewer has exactly zero or one active upstream;
- the active media graph is acyclic;
- every non-server endpoint stays within its steady sender capacity or one
  explicitly reserved transition-overlap slot;
- every active Viewer is source-reachable through peer edges or the current
  authoritative Host publication;
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

Parent selection is deterministic and local. The controller first filters on
current authority, source reachability, acyclicity, depth, sender reservations,
relay eligibility, exact-edge exclusion/cooldown, and server admission. It then
orders eligible parents lexicographically by the shallowest resulting depth,
the greatest remaining steady sender capacity, stable join order, and peer
identity. It prepares one candidate at a time. The candidate's standard ICE
checklist proves connectivity and current-generation RTP plus decoded frames
prove media; raw addresses, a claimed NAT class, geography, user agent, or a
weighted room-wide score never choose a parent. A failed candidate releases its
reservation before the next candidate is attempted. Join and hard-failure repair
accept the first candidate that reaches the media-usable floor; a soft-quality
move also needs the quality owner to prove recovery and improvement over the
still-healthy old edge.

### Authorization and transition

Every prepare, signal, recovery, commit, and rollback is bound to the exact
room, share generation, endpoint sessions, route revision, assignment
generation, connection identity, media-binding generation, and publication
generation when one exists.
A stale or mismatched asynchronous result fails closed and cannot revive an old
edge.

A route replacement uses make-before-break only when the typed endpoint and
server-resource ledger atomically admits the required reservations. The old
route remains authoritative until the new route proves current-generation media
with a live track, positive RTP progress, and decoded-frame progress. ICE
`connected` alone is insufficient. Commit promotes that exact candidate
atomically; timeout, failure, stale identity, or revoked authority destroys it,
releases reservations idempotently, and keeps or restores the previous valid
route. When a full sender has no overlap slot, the controller may preconnect
signaling and transport and perform one explicit bounded-gap cutover instead of
silently exceeding capacity.

Recovery attempts are finite, generation-bound, and stop after success. The
controller must not turn a rare failure into an unbounded retry loop, unaccounted
server fanout, or an untracked parallel route.

## Accepted Assisted-Route Model

One room controller owns three operations: allocate/distribute, child reparent,
and relay abdicate/drain. It is the only owner of the committed graph, pending
target, and transition lifecycle. Topology helpers retain participant metadata
and purely plan candidates; they do not retain a second mutable route graph.
The operations share one target snapshot, one pending transition, one resource
ledger, and monotonic room/session/revision fences.

- The Host is the only source publisher. There is at most one authoritative Host
  publication per share generation, and every SFU-fed Viewer subscribes to it.
  A Viewer that receives the publication may relay to ordinary children only
  after independent outbound RTP, decode, resource, and sender-slot proof;
  a strict SFU Viewer remains a leaf. Viewer republishing into a second SFU
  publication is outside the current product.
- TURN is a selected transport for an existing authorized logical edge or the
  Host-to-SFU ingress. It is not a topology node, a second source, or a global
  room lease. Existing direct/STUN edges remain preferred; a failed selected
  edge may use exact TURN, and an unavailable logical peer path may fall back to
  an SFU subscription. If the Host has no direct first-level path, one Host
  publication over direct or selected TURN is preferred to repeated Host-TURN
  peer edges.
- Endpoint sender capacity is accounted independently from server ingress/egress, SFU
  subscriptions, TURN allocations, and one bounded transition-overlap slot.
  Steady capacity is `1`, `2`, or `3` (default `2`); a transition may use
  `min(steadyCap + 1, 3)` only for one fenced, deadline-bound handoff and must
  return to steady bounds at commit. There is no fixed SFU-root count or
  room-wide selected-lease count.
- Every candidate carries exact room, share, endpoint sessions, route revision,
  assignment/connection generations, publication generation when applicable,
  and media-binding generation. Reserve, prepare, current-generation media
  proof, atomic commit, drain, and idempotent release are one transaction.
  TTL cleans abandoned reservations; it never revokes a healthy committed edge.
- A child that observes its own upstream as bad uses correlated C+B evidence
  for that edge and invokes child-scoped reparent. If an exact current ordinary
  peer edge stops current-generation RTP and decoded-frame progress while
  signaling and the PeerConnection remain present, expiry of the bounded parent-
  proof deadline authorizes hard reparent of that child if the stall remains,
  whether matching positive non-server-parent outbound-media proof arrived or
  not. Parent sending or non-response does not change parent eligibility.
  Downstream evidence drains a relay only when the trigger has at least one
  distinct current sibling edge and every current authoritative child edge has
  independently completed a current-generation unusable proof. Positive
  progress, unknown evidence, or unfinished proof on any current child blocks
  that drain; positive progress clears the exact edge's unusable evidence. A
  lone child is reparented without draining its parent. A relay parent enters
  `suspect` for its own ingress evidence, stops accepting new children, and
  repairs that ingress with reparent or branch-preserving `replaceIngress`.
  Parent/session hard failure or failed ingress repair independently authorizes
  drain. An endpoint-wide sender/resource failure independently authorizes drain
  only when a concrete server-verifiable producer establishes that scope; a
  generic per-edge failure remains edge-scoped. Host source failures instead use
  publication repair and child migration. Drain retains a healthy ingress and
  replaces or removes a failed ingress in the same target. If a new ingress
  restores downstream media, the subtree remains unchanged. Hard failure
  preempts confirmed parent drain, which preempts a single-edge soft reparent. A
  feasible child migration is never blocked by a sibling with no destination.
- Unexpired evidence follows its exact edge identity across unrelated route
  revisions and broadcasts; the controller advances its revision guard without
  resetting unaffected siblings. Identity change, positive progress, or
  successful migration clears only that edge's evidence. An authoritative pause
  stops and clears current-generation quality correlation. Resume starts a fresh
  baseline, so intentional pause silence cannot trigger reparent or drain.
- Healthy edges are sticky. Join, departure, capacity release, hard failure,
  confirmed ineligibility, server-resource change, and explicit ingress restore
  are the route-changing events. Quality evidence changes topology eligibility,
  not built-in media layers and not a second route authority.

SFU and TURN remain bounded fallback resources with independent deployment-wide
admission. Resource exhaustion produces the next bounded candidate, an explicit
wait, or failure; it never creates unbounded central fanout.

For the single-process deployment, selected TURN uses one injected allocation
authority with an explicitly configured positive safe-integer capacity and no
product default. Each exact `peer-selected` transport and Host-SFU ingress
transport consumes one unit. The controller reserves that unit before issuing a
credential, commits only the matching current identity, and keeps reserved,
committed, and draining entries charged until their logical authorization is
released. Independent logical edges may coexist up to this deployment capacity;
the capacity is not derived from endpoint media-copy capacity, Viewer admission,
or a room-wide lease count.

For the single-process deployment, SFU admission is one injected authority with
deployment-wide ingress and egress counters. Enabling LiveKit requires explicit
positive safe-integer `SFU_INGRESS_CAPACITY` and `SFU_EGRESS_CAPACITY` values;
neither has a product default and neither is derived from endpoint capacity,
Viewer admission, or a fixed root count. One Host publication consumes one
ingress unit and every SFU subscription consumes one egress unit. A concurrent
candidate and every generation still draining from LiveKit remain charged in
addition to the committed generation.

The accepted self-hosted deployment contract dedicates one LiveKit instance to Screener,
sets `room.auto_create: false`, and gives the application an explicit private
`LIVEKIT_API_URL`. The controller reserves the exact room, share, and publication
generation, creates that managed LiveKit room through `RoomService`, and only
then issues tokens. Commit moves the old generation to `draining`; abort,
timeout, participant loss, share rollover, room stop, and room deletion move
their generation to the same state. `RoomService.DeleteRoom` must complete and a
follow-up lookup must prove the room absent before its ingress or egress units
are released. Because joining cannot recreate a deleted room, a stale
self-hosted token cannot produce an off-ledger participant.

The single owner first binds the configured application listener exclusively;
a competing process that cannot bind makes no LiveKit control-plane call. While
bound but not initialized, HTTP returns `503` and no signaling upgrade handler
is installed. The owner then lists its dedicated LiveKit instance, rejects
foreign room names, deletes every stale Screener room, confirms the owned
namespace empty, and only then accepts application traffic. Graceful shutdown
drains the same namespace before forgetting counters. A Host signaling
disconnect keeps a committed generation charged while its exact LiveKit Host participant exists;
an interval-bounded control-plane check retires it after that participant
disappears. A multi-process application deployment requires a shared atomic
admission and lifecycle owner before it may claim these values are
deployment-wide.

## Current Production Divergence

Production release `9461e20` predates this revision. Its exact behavior is owned
by the deployment document. Generation guards, scoped authorization,
media-proven transitions, and bounded recovery remain reusable only where they
satisfy this ADR.

That release remains a deployment fact and rollback reference. It must not be
merged wholesale into a new route implementation. After this model is merged,
retained code and tests are transplanted from current `main` by invariant;
obsolete policy is replaced at its owner.

## Acceptance Boundary

Before a revised controller ships:

- property tests cover capacity `1`, `2`, and `3`, one active upstream,
  acyclic and source-reachable assignments, stale generations, duplicate
  signals, departure, rollback, and admission exhaustion;
- route changes preserve unaffected branches and never commit before media
  proof;
- SFU lifecycle tests keep reserved, committed, and draining generations charged
  until deletion plus absence proof, reject stale-token room recreation, prove a
  competing listener owner makes no LiveKit call, fence startup against stale or
  foreign rooms, reclaim an abandoned Host generation
  without cutting a live Host participant, and keep two rooms under one global
  capacity owner;
- candidate lists are deterministic under input permutation, preserve a healthy
  current edge, prefer the shallowest least-loaded eligible parent, and try only
  the next eligible candidate after exact failure and idempotent cleanup;
- quality tests distinguish child-scoped C+B reparent from parent-scoped drain;
  require at least two current children and independently unusable proof on all
  current child edges; prove that same-edge C+B, a healthy/unknown/unresolved
  sibling, or a lone child cannot drain a parent; and cover independent
  parent/session hard failure and failed-ingress-repair drain;
- quality tests bind evidence to exact media identity, preserve unaffected-edge
  evidence across unrelated revisions, clear only changed or recovered edges,
  suspend and clear correlation during authoritative pause, and start a fresh
  baseline on resume. They include a Viewer that is both child and parent, the
  Host-source publication-repair exception, bounded child-only recovery while
  signaling remains present, and suspect/local-repair before drain;
- real-browser tests cover direct peer media, peer relay, server-assisted media,
  selected transport when configured, failure, and recovery;
- deployment preflight proves the LiveKit instance is dedicated, uses
  `room.auto_create: false`, exposes `RoomService` only on its accepted private
  control origin, and can drain its managed namespace before traffic or
  rollback;
- measured endpoint upload and server ingress/egress prove the accepted
  accounting under normal and migration overlap; and
- every exhausted path reaches a clear bounded wait or failure without leaking
  credentials, candidates, addresses, or raw errors.

Loopback timing and synthetic signaling tests may validate invariants, but they
do not prove target-network latency, quality, capacity, or interoperability.

## Security and privacy

Route and signaling authority is room-, role-, session-, share-, revision-, and
connection-bound. LiveKit media credentials are short-lived and bound to the
room, role, share, and publication generation so healthy media may survive a
signaling reconnect. Server-assisted credentials remain memory-only and never
appear in application page URLs, browser persistence, or SQLite. LiveKit places
its short-lived JWT in the WebSocket transport request target, which must not be
logged; no credential may enter application or proxy logs.
Ordinary SFU transport terminates DTLS-SRTP at the SFU; the product must not
claim application E2EE unless key distribution and real media evidence exist.
Authenticated Hosts and shipped clients are trusted media participants in the
current private-room threat model. Stale route-control sessions remain
unauthorized; a retired media generation remains charged during bounded drain
until deletion of its exact room prevents re-entry.

## Consequences

Positive:

- one capacity rule replaces role and browser policy forks;
- route safety is expressed through graph, identity, and media invariants;
- server-assisted paths remain bounded and explicit without turning the room
  into an always-SFU topology.

Negative:

- the deployed controller intentionally diverges until this model is migrated;
- make-before-break consumes explicit endpoint and server reservations and may
  require a bounded-gap cutover when no overlap slot exists; and
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
- [RTP topologies, RFC 7667](https://www.rfc-editor.org/rfc/rfc7667.html)
- [PIM-SM Join/Prune behavior, RFC 7761](https://www.rfc-editor.org/rfc/rfc7761.html)
- [ICE connectivity checks and candidate checklists, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html)
- [NICE degree-bounded application-layer multicast](https://conferences.sigcomm.org/sigcomm/2002/papers/appmulti.pdf)
- [Overcast adaptive single-source distribution trees](https://www.usenix.org/conference/osdi-2000/overcast-reliable-multicasting-overlay-network)
- [Kubernetes cordon and drain](https://kubernetes.io/docs/reference/generated/kubectl/kubectl-commands)
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/#selective-subscription)
- [LiveKit track subscription permissions](https://docs.livekit.io/transport/media/publish/#track-permissions)
- [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- [Consistent updates for software-defined networks](https://reitblatt.com/downloads/consistent-updates-hotnets11.pdf)
