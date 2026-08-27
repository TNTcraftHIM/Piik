# ADR-0005: Automatic Hybrid Media Routing

- Status: accepted; base route and evidence-only quality shadow deployed
- Date: 2026-08-20
- Last updated: 2026-08-27

## Context

Direct Browser WebRTC gives Screener its desired latency and distributed cost,
but one Host cannot fan out to every Viewer and some endpoint pairs cannot
establish usable direct media. The product needs automatic peer distribution and
bounded server fallback without exposing topology choices to users or turning
every room into an SFU conference.

This decision owns the route controller and resource model. The observable
product contract is [routing and transport](../product/routing-transport.md);
physical evidence is in the routing research documents.

## Decision

### One Capacity Rule

Every non-server endpoint uses one server-authoritative steady outbound media-
copy cap `C`: default `2`, configurable only as `1`, `2`, or `3`.

- one ordinary peer child consumes one copy;
- the Host's single SFU publication consumes one copy;
- upstream receive consumes none;
- role, Browser, UA, device, visibility, codec, and room Viewer limit do not
  create another tier;
- a client may advertise only `0..C` currently available copies, producing the
  controller's effective capacity.

One transition-overlap reservation may temporarily raise a producer to
`min(C + 1, 3)`. Commit or abort releases it. A fourth endpoint copy is never
authorized. SFU ingress and subscription egress are independent server resources
and are not inferred from endpoint child counts.

### One Graph And Reconcile Loop

One room controller owns:

- one committed, versioned, acyclic, source-reachable graph;
- one event-driven reconcile loop;
- at most one room-serial child operation; and
- participant sessions, effective capacity, current failure facts, and the
  Host's optional SFU publication.

The Host has no upstream. Each Viewer has zero or one active upstream. Healthy
unaffected edges remain sticky. Join/waiting, failed-edge repair, relay-ingress
repair with subtree retention, confirmed departure, and capacity reduction are
inputs to the same loop rather than separate routing systems.

Disconnected childless participants are removed naturally. A disconnected
relay or a relay with reduced capacity accepts no new children; only its
deterministic overflow children are reassigned. A relay whose ingress fails is
itself reparented while its descendants remain attached.

### Deterministic Candidates

Each child operation owns one candidate list and cursor, one current candidate
and reservations, one route-demand owner, one fact version, and one total
deadline. Candidate creation first rejects stale sessions, unreachable sources,
cycles, insufficient steady/overlap capacity, tuples already consumed by that
operation, and unavailable SFU resources.

Eligible Peer parents are ordered by:

1. shallowest resulting depth;
2. greatest remaining steady capacity;
3. a stable child-parent rank;
4. join order; and
5. peer identity.

There is no independent depth cap. Room admission and acyclicity bound the graph;
shallowest-first is a preference, not a periodic balancing mandate. IP address,
geography, NAT guess, UA, and scalar quality score do not select a parent.

A failed exact tuple is consumed only for its current operation. A later external
fact may make it eligible again; there is no persistent parent blacklist.

### Prepare, Commit, And Rollback

Every operation is fenced by room and endpoint sessions, share generation, base
and pending route revisions, and one candidate connection identity. SFU routes
also carry a publication generation. Duplicate current messages are idempotent;
stale asynchronous results fail closed.

The old committed route remains authoritative while the candidate prepares.
Parent and child prepare the same server-issued connection identity. Standard
ICE connected is progress only. The exact candidate child decoding its first new
video frame is the sole application commit proof.

The media-ready call commits typed endpoint/SFU admission before graph promotion.
Success broadcasts the candidate revision. Failure, timeout, pause, or stale
authority destroys the candidate, releases reservations idempotently, and
broadcasts a strictly newer rollback revision before another prepare. Clients
never infer rollback from silence or an older revision.

Make-before-break is used only when all required reservations exist. Availability
repair may use one explicitly planned bounded-gap retirement after server
resources are preflighted; it keeps the same deadline, replans the untried suffix,
and retains one restore tuple. Background convergence never interrupts healthy
media for a bounded-gap candidate.

### Availability Order

Initial acquisition gives direct Peer candidates one bounded foreground window.
Hard failure may advance a different direct candidate inside that same window,
but the window and total operation deadline never reset. Exact transport-
connected progress may retain the current direct candidate until the deadline;
it still cannot commit without decoded media.

When the direct foreground window ends, a usable SFU candidate may provide media
before unresolved direct candidates. After an SFU route commits, finite remaining
Peer candidates converge behind working media, one at a time and round-robin
across SFU Viewers. New join or repair work preempts this background convergence.
Exhausting direct candidates simply keeps the working SFU route.

If the Host is full and no publication exists, one bounded SFU-bootstrap intent
owns the original waiting demand and a finite cursor of eligible Host-direct
children. A carrier must create the publication through a normal overlap; it may
not cut a healthy branch first. Carrier failure keeps that branch and advances
the cursor. Success lets the original demand try the publication before its
remaining direct candidates. The intent owns no second graph, concurrent child
operation, or timer.

### SFU Resource Ownership

There is at most one Host publication per room/share generation. Every SFU
Viewer owns one subscription to it; Viewers never publish a second SFU stream.
The Host page owns capture tracks, so SFU teardown or recovery must not stop
capture.

The single-process server has one injected SFU admission owner. Its ingress
ceiling derives from the fixed room-code space, and egress derives from that
space times the per-room Viewer limit; neither has an independent tuning key.
Exact publication and subscription handles remain charged while reserved,
committed, or draining. Reactivating the same handle does not double-charge it.

The application explicitly creates a managed LiveKit room before issuing media
tokens. Replacement, abort, timeout, confirmed media-participant loss, share
rollover, stop, and room deletion transfer the resources they own into the same typed drain path.
Only successful room deletion plus an absence readback releases that generation,
so a stale token cannot recreate off-ledger media. The deployment must dedicate
the LiveKit namespace to Screener and complete startup ownership/cleanup before
accepting traffic; [self-hosting operations](../operations/self-hosting.md) owns
that procedure.

Only confirmed LiveKit media-participant absence retires an abandoned Host
publication. A Host signaling disconnect keeps the generation charged while the
exact LiveKit Host participant remains; one bounded control-plane check releases
it only after that participant disappears.

A room denied by deployment-wide SFU admission enters one bounded waiter set.
Actual SFU usage decrease drains that set once, advances each surviving room's
external fact, and schedules ordinary reconciliation. There is no periodic
capacity poll or second resource-specific controller.

Ordinary Peers use deployment STUN only. Browser SFU PeerConnections use an
empty external ICE-server list while retaining LiveKit-signaled UDP candidates.
Screener configures no TURN, ICE/TCP, media TCP, or TLS-relayed media. A future
strict-firewall transport must be accepted as a LiveKit-internal capability, not
as another application route candidate.

### Recovery, Pause, And Quality

WebRTC and LiveKit first own ICE/consent and transient reconnect on the current
route. Only framework recovery exhaustion, hard failure, a non-paused decoded-
frame stall, confirmed departure, or capacity invalidation enters route
reconciliation. Manual reconnect remains on the exact current route.

Authoritative Host pause aborts the pending operation and reservations, preserves
the committed graph, suppresses decoded-stall authority, and leaves new Viewers
waiting. Resume starts reconciliation from the current graph. Page-hidden wall
time is rebaselined before it can contribute to a stall decision.

Quality evidence is observation-only. Current low bitrate/FPS/resolution, loss,
RTT, jitter, freeze, or sender limitation does not change candidates, capacity,
SFU use, or graph authority. Screener has no weighted route score, parent-wide
quality inference, all-pairs probe, hysteresis controller, or periodic rebalance.
Open investigation remains in [TODO](../todo.md).

## Consequences

Positive:

- one capacity rule replaces role- and Browser-specific tiers;
- one graph and operation make route, identity, and resource ownership explicit;
- media stays distributed while SFU cost and stale-token behavior remain bounded;
- unrelated healthy branches survive local join, failure, and repair.

Negative:

- the serial operation can create queue-tail latency during bursts;
- Browser relay creates per-child decode/re-encode cost;
- make-before-break requires temporary reservations and some availability repair
  may require a bounded gap; and
- UDP-only media ends in explicit failure on fully blocked networks.

## Related Decisions And Evidence

- [ADR-0001](./0001-p2p-first-media-topology.md): initial P2P baseline.
- [ADR-0004](./0004-peer-assisted-media-experiment.md): Browser relay evidence.
- [ADR-0007](./0007-path-isolated-representation-quality.md): framework-owned
  representation adaptation.
- [Low-server-cost routes](../research/low-server-media-routes.md) and
  [peer-assisted media](../research/peer-assisted-media.md): measurements and
  rejected alternatives.
- [Verification status](../verification-status.md): current open physical gates.

## Primary References

- [WebRTC](https://w3c.github.io/webrtc-pc/)
- [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)
- [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html)
- [RTP topologies, RFC 7667](https://www.rfc-editor.org/rfc/rfc7667.html)
- [NICE degree-bounded multicast](https://conferences.sigcomm.org/sigcomm/2002/papers/appmulti.pdf)
- [Overcast](https://www.usenix.org/conference/osdi-2000/overcast-reliable-multicasting-overlay-network)
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
- [Consistent network updates](https://reitblatt.com/downloads/consistent-updates-hotnets11.pdf)
