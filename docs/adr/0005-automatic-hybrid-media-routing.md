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
and relay abdicate/drain. They share one target snapshot, one pending transition,
one resource ledger, and monotonic room/session/revision fences.

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
  not. Parent sending or non-response does not change parent eligibility. A
  relay parent enters
  `suspect` only for its own ingress/parent-scope evidence, then stops accepting
  new children and repairs its own ingress with reparent or branch-preserving
  `replaceIngress`; Host source failures instead use publication repair and
  child migration. A relay parent is marked
  directional-ineligible only after that repair fails, an explicit sender or
  resource failure makes forwarding unusable, or independent downstream edges
  (not C+B from the same edge) confirm forwarding remains unusable. It then
  retains a healthy ingress while draining affected children, and replaces or
  removes a failed ingress in the same target. The quality policy accounts for
  currently observable edges and endpoint capacity; the route model does not
  hard-code a two-child quorum. The quality evidence owner defines finite
  windows and independent-edge corroboration without turning them into a global
  score. If the new ingress restores downstream media,
  the subtree remains unchanged. Hard failure preempts confirmed parent drain,
  which preempts a single-edge soft reparent. A feasible child migration is
  never blocked by a sibling with no destination.
- Healthy edges are sticky. Join, departure, capacity release, hard failure,
  confirmed ineligibility, server-resource change, and explicit ingress restore
  are the route-changing events. Quality evidence changes topology eligibility,
  not built-in media layers and not a second route authority.

SFU and TURN remain bounded fallback resources with independent deployment-wide
admission. Resource exhaustion produces the next bounded candidate, an explicit
wait, or failure; it never creates unbounded central fanout.

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
- candidate lists are deterministic under input permutation, preserve a healthy
  current edge, prefer the shallowest least-loaded eligible parent, and try only
  the next eligible candidate after exact failure and idempotent cleanup;
- quality tests distinguish child-scoped C+B reparent from parent-scoped
  corroborated drain, prove that same-edge C+B cannot drain a parent, require
  independent sibling edges for parent corroboration, include a Viewer that is
  both child and parent plus the Host-source publication-repair exception, bind
  evidence to media-binding generation, prove bounded child-only recovery when
  an ordinary peer edge stops RTP while signaling remains present, and exercise
  suspect/local-repair before drain while preserving unrelated sibling evidence;
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
