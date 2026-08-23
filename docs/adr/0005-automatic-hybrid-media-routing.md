# ADR-0005: Automatic Hybrid Media Routing

- Status: Accepted; source runtime implemented and deployed
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
- a connected endpoint's server-authoritative effective downstream capacity is
  the deployment value clamped by its current `0..C` availability advertisement;
  `0` means it currently accepts no downstream child and does not create another
  release tier; and
- one named configuration value and one shared implementation boundary own the
  policy. Route code must not repeat literal policy numbers.

The server returns the final deployment value as
`authenticated.endpointMediaCopyCapacity` on every successful signaling
authentication. Browser Host and Viewer clients validate `1..3` and use the
same value for authoritative child assignments and physical sender slots. Room
`maxViewers` is a separate participant-admission limit and never supplies a
sender budget. A missing or invalid capacity, old wire, or executable sender
fails before route authority is accepted.

Without the peer-assisted controller, signaling still admits at most that many
active Host children per room. Excess admitted Viewers wait without an
authorized media edge and are promoted in stable join order when a slot is
released; offer, answer, candidate, and restart routing is limited to the active
set.

Capacity counts active outbound media copies produced by a non-server endpoint:
an ordinary peer child consumes one slot and the Host's single SFU publication
consumes one Host slot. An upstream receive edge is free. A parallel
media-producing candidate requires a separately reserved transition slot. SFU
subscriptions consume server egress, not endpoint capacity.

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
`RTCPeerConnection` instances receive STUN candidates only. The sole
application fallback is the dedicated LiveKit SFU over UDP; Screener configures
no TURN, ICE/TCP, media TCP, or TLS-relayed media. HTTPS and WSS continue to use
TLS/TCP independently of media transport.

Routing is event-driven. Join, capacity release or reduction, endpoint departure,
current-edge hard failure, and a non-paused decoded-frame stall wake the same
reconciliation loop. The controller otherwise leaves the room unchanged.

Parent selection is deterministic and local. The controller first filters on
current authority, source reachability, acyclicity, effective downstream
capacity, sender reservations, candidate tuples already tried by the current
operation, and server admission.
It then
orders eligible parents lexicographically by the shallowest resulting depth,
the greatest remaining steady sender capacity, stable join order, and peer
identity. It prepares one candidate at a time. The candidate's standard ICE
checklist proves transport connectivity; the exact candidate child's first new
decoded video frame is the application media-ready event. Raw addresses, a
claimed NAT class, geography, user agent, or a
weighted room-wide score never choose a parent. A failed candidate releases its
reservation before the next candidate is attempted. The first candidate that
reaches the media-usable floor commits; otherwise the loop reaches the next
candidate, an explicit wait, or bounded failure. A failed edge seeds its tuple
only into the operation opened by that fact version; a later external fact may
make the tuple eligible again. Exhaustion retires an edge that is hard-invalid,
attached to a confirmed-departed parent, or outside current effective capacity,
so blocked state never hides a physical copy or server resource. A healthy edge
used only for SFU bootstrap remains committed if bootstrap cannot start.

There is no independent maximum-depth policy. Acyclicity and room admission
bound the graph, while shallowest-first ordering minimizes depth. If a departed
Host root releases a Host slot, a new or orphaned child therefore prefers that
shallower Host result over another root's deeper slot. Healthy committed edges
remain sticky; the controller does not periodically rebalance the graph. Depth
remains an observed acceptance metric.

A candidate identity is one logical upstream path. An operation opened by a
failed edge seeds that exact current candidate as already tried, so the same
parent cannot immediately repeat. Other eligible direct/STUN parents use
deterministic order first, followed by SFU reuse or direct Host publication
ingress. A new external fact starts a new operation and may make the old
candidate eligible again. The operation records only exact candidates already
tried; failure does not globally exclude that parent from later room events.

If an SFU subscription is needed while the Host has no publication and all Host
slots are occupied, reconciliation uses the same child operation to convert one
deterministic current Host direct child into the first SFU subscriber. It uses
the affected child when that child is already a Host direct child; otherwise it
uses the newest connected Host direct child in stable join order. The candidate
creates the single Host publication, preserves that child's subtree, and commits
on its first newly decoded frame. The publication then replaces the released
Host peer slot, and the next reconciliation handles the original waiting or
failed child. This creates no bootstrap state or second graph.

### Authorization and transition

Every prepare, signal, recovery, commit, and rollback is bound to the
authenticated room and endpoint sessions, current share generation, base route
revision, and unique pending revision. Connection identity fences the candidate
PeerConnection, and publication generation remains owned by the SFU resource
lifecycle.
A single pending child-operation object aggregates these bindings, the
deterministic candidate list and cursor, its current candidate and reservations,
and one total operation deadline. Candidate failure advances the cursor without
resetting that deadline. These fields do not become separate gates or state
machines, and this route wave adds no
assignment, media-binding, or proof generation to the wire.
The same one timer derives wake boundaries from the route classes actually
present in the deterministic list: direct peer and SFU. The total deadline is
divided equally between those semantic stages, without fixed per-candidate
milliseconds. Hard failures may advance through multiple candidates inside a
stage; a silent direct candidate at its boundary skips the remaining direct
candidates so it cannot consume the SFU suffix.
A `prepare` route update names that operation's exact child, route kind, and
server-issued candidate connection identity. Parent and child therefore
prepare the same connection; neither endpoint infers candidate authority from
an assignment-list difference.
The current Browser runtime uses one internal wire. On each WebSocket, the
server sends the exact prepare before its SFU configuration; the candidate child
is queued before a peer parent is allowed to start its offer. WebSocket ordering
is the companion-delivery contract, so clients keep no reordering inbox.
Duplicate current companions are idempotent and stale ones are ignored. Native
and executable senders are outside this release and fail the protocol boundary
rather than receiving a compatibility path.
A stale or mismatched asynchronous result fails closed and cannot revive an old
edge.
Successful candidate `P` is broadcast as active revision `P`. Failure, timeout,
or authoritative abort keeps the previous committed graph content but advances
and broadcasts one active rollback revision `R > P` before any later prepare;
clients never infer rollback from silence or from an older revision.
One room-wide monotonic allocator owns active, prepare, rollback, retirement,
and prune revisions. A direct peer transport may adopt a fresh WebRTC connection
identity during its framework-owned rebuild only for the exact current
parent/child sessions; that identity update does not change topology.

A route replacement uses make-before-break only when the typed endpoint and
server-resource ledger atomically admits the required reservations. The old
route remains authoritative until the exact candidate child decodes its first
new video frame. ICE `connected` alone is insufficient. Commit promotes that
exact candidate
atomically; timeout, failure, stale identity, or revoked authority destroys it,
releases reservations idempotently, and keeps or restores the previous valid
route. The exact media-ready call synchronously commits typed admission before
graph promotion; a failed admission commit follows the ordinary candidate
failure path. Commit releases the resource-set difference plus the overlap
slot, and room stop/delete returns every current and committed resource through
one dispose operation. When a full sender has no overlap slot, server resources
are preflighted before one explicit bounded-gap cutover. Retirement keeps the
same total deadline, replans the untried tuple suffix against the new graph, and
appends one ordinary restore candidate when it cut a healthy logical edge.
There is no fourth endpoint copy and no separate restore state machine.

Recovery attempts are finite, generation-bound, and stop after success. The
controller must not turn a rare failure into an unbounded retry loop, unaccounted
server fanout, or an untracked parallel route.

## Accepted Assisted-Route Model

One room controller owns the committed graph, one pending child operation, and one
event-driven reconciliation loop. Allocate/distribute, child reparent, and relay
abdicate/drain are inputs to that loop rather than separate state machines.
Topology helpers retain participant metadata and choose candidates without a
second mutable graph.

- The loop first removes disconnected childless participants, then selects one
  connected waiting Viewer or one child whose parent is disconnected,
  lacks effective capacity for that child, or owns the exact failed edge. It
  prepares one upstream change and wakes again after commit, abort, or another
  room event.
- A relay whose ingress fails is itself the child being reparented; its subtree
  remains attached. A disconnected endpoint, or one with effective downstream
  capacity `0`, accepts no new children. Direct or deterministic overflow children
  are reparented one at a time by the same loop, and disconnected leaves are
  removed naturally.
- The Host is the only source publisher. There is at most one authoritative Host
  publication per share generation, and every SFU-fed Viewer subscribes to it.
  Any source-reachable endpoint with effective capacity may be a parent
  candidate; SFU-fed and peer-fed endpoints use the same provisional-child
  transaction and each child edge commits independently. Viewer republishing
  into a second SFU publication is outside the current product.
- The only server-assisted route is an SFU subscription backed by the Host's
  one direct-ingress publication. Screener configures no TURN or media TCP
  transport. An all-UDP-blocked network reaches a clear bounded failure; any
  future strict-firewall transport requires its own evidence and belongs inside
  LiveKit rather than becoming another application candidate.
- Endpoint sender capacity is accounted independently from server ingress/egress, SFU
  subscriptions, and one bounded transition-overlap slot.
  Steady capacity is `1`, `2`, or `3` (default `2`); a transition may use
  `min(steadyCap + 1, 3)` only for one fenced, deadline-bound handoff and must
  return to steady bounds at commit. There is no fixed SFU-root count or
  room-wide selected-lease count.
- Candidate-list creation, reserve, prepare, the child's first decoded frame,
  atomic commit, abort, and idempotent release are one bounded child operation.
  Its one total deadline cleans abandoned reservations and never revokes a
  healthy committed edge.
- A child invalidates only its own exact edge after PeerConnection hard failure
  or a named non-paused interval without a newly decoded frame. Bitrate, FPS,
  resolution, blur, and sender statistics remain diagnostics or stock
  WebRTC/LiveKit adaptation inputs; they do not change
  parent eligibility. Multiple bad child edges recover independently through the
  same loop and naturally empty an unusable relay.
- Web clients derive active decoded progress from their existing periodic
  WebRTC/LiveKit stats sampling. One route-keyed last-progress deadline reports
  the exact edge once; it resets on route/connection change or decoded progress
  and is suppressed while authoritatively paused. It adds no polling loop and
  does not treat bitrate, FPS, track availability, or SFU layer choice as route
  authority.
- Authoritative pause aborts the pending child operation, including its current
  candidate and reservations, keeps the active graph, suppresses decoded-frame-
  stall decisions, and leaves new participants waiting. Resume wakes a fresh
  reconciliation. Healthy unaffected edges remain sticky.

SFU remains a bounded fallback resource with independent deployment-wide
admission. Resource exhaustion produces an explicit wait or failure; it never
creates unbounded central fanout.
Rooms that actually lose a candidate to deployment-wide admission register in
one waiter set. An actual SFU usage decrease drains that set once, advances
each waiting controller's external fact, and schedules normal reconciliation;
there is no periodic capacity poll or resource-specific route controller.

For the single-process deployment, SFU admission is one injected authority with
deployment-wide ingress and egress counters. Enabling LiveKit requires explicit
positive safe-integer `SFU_INGRESS_CAPACITY` and `SFU_EGRESS_CAPACITY` values;
neither has a product default and neither is derived from endpoint capacity,
Viewer admission, or a fixed root count. One exact room/share/publication entry
owns the Host publication ingress, while an exact Viewer subscription handle
under that entry owns one egress unit. The current publication is reused as
Viewers enter or leave the SFU path; each child candidate reserves and commits
only its own subscription handle. Reserved, committed, and draining handles,
concurrent publication generations, and generations still draining from
LiveKit all remain charged. A subscription that leaves the route remains
charged as draining until its publication room is deleted and proven absent;
reactivating that same Viewer handle does not charge it twice.

The accepted self-hosted deployment contract dedicates one LiveKit instance to Screener,
sets `room.auto_create: false`, and gives the application an explicit private
`LIVEKIT_API_URL`. The controller reserves the exact publication and first
subscription, creates that managed LiveKit room through `RoomService`, and only
then issues tokens. Later SFU-fed children reserve an exact subscription under
the same generation without republishing the Host. Publication replacement
moves the old generation and all of its subscription handles to `draining`;
abort, timeout, participant loss, share rollover, room stop, and room deletion
apply the same typed lifecycle to the resources they own.
`RoomService.DeleteRoom` must complete and a follow-up lookup must prove the
room absent before that generation's ingress or egress units are released.
Because joining cannot recreate a deleted room, a stale self-hosted token
cannot produce an off-ledger participant.

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

## Current Deployment Boundary

Production release `a5b1fc6` runs the `screener-v8` Browser runtime and still
contains the superseded selected-TURN surface. Its exact configuration, rollback
artifacts, and postflight evidence are owned by the deployment document. The
direct-to-SFU contract is accepted but not deployed until the selected-TURN
source and production configuration are removed atomically; real
heterogeneous-network and SFU media validation remains open.

## Acceptance Boundary

Before a revised controller ships:

- property tests cover capacity `1`, `2`, and `3`, one active upstream,
  acyclic and source-reachable assignments, stale generations, duplicate
  signals, departure, rollback, and admission exhaustion;
- route changes preserve unaffected branches and never commit before the exact
  candidate child's first decoded-frame ready;
- SFU lifecycle tests keep reserved, committed, and draining generations charged
  until deletion plus absence proof, reject stale-token room recreation, prove a
  competing listener owner makes no LiveKit call, fence startup against stale or
  foreign rooms, reclaim an abandoned Host generation
  without cutting a live Host participant, and keep two rooms under one global
  capacity owner;
- candidate lists are deterministic under input permutation, preserve a healthy
  current edge, prefer the shallowest least-loaded parent with capacity, and
  advance one cursor after exact failure and idempotent cleanup without resetting
  the total operation deadline;
- focused controller tests cover first-frame commit, candidate failure and stale
  ready, relay-ingress reparent with its subtree intact, disconnected relay and
  nested-disconnect convergence, effective capacity `0..C` and overflow drain,
  SFU-fed first-child use and pause/resume;
- real-browser tests cover direct peer media, peer relay, SFU media, bounded
  failure, and recovery;
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
appear in application page URLs, browser persistence, or durable server storage. LiveKit places
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

- production intentionally diverges until the implemented source is released;
- make-before-break consumes explicit endpoint and server reservations and may
  require a bounded-gap cutover when no overlap slot exists; and
- real SFU and target-network evidence is still required.

## Relationship to other ADRs

- ADR-0001 owns the original browser P2P baseline.
- ADR-0004 is historical evidence about browser peer relay and re-encoding; it
  does not set current capacity or server-assisted policy.
- ADR-0007 owns diagnostic path-quality evidence and representation behavior;
  it does not create route eligibility.

## References

- [WebRTC](https://w3c.github.io/webrtc-pc/)
- [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC transports, RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html)
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
