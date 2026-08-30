# ADR-0005: Automatic Hybrid Media Routing

- Status: Accepted
- Date: 2026-08-20
- Last updated: 2026-08-28

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

That advertised capacity belongs to the connected endpoint, not one sharing
generation. Replacing the room graph retains it; Viewer departure or room
deletion clears it.

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

Each child operation owns one immutable purpose, one candidate list and cursor,
one current candidate and reservations, one route-demand owner, one fact version,
and one total deadline. Availability work preempts a background operation by
aborting it and creating the required operation; the old operation is never
relabelled. Candidate creation first rejects stale sessions, unreachable
sources, cycles, insufficient steady/overlap capacity, tuples already consumed
by that operation, and unavailable SFU resources.

Eligible Peer parents are ordered by:

1. shallowest resulting depth;
2. greatest remaining steady capacity;
3. a stable child-parent rank;
4. join order; and
5. peer identity.

There is no independent depth cap. Room admission and acyclicity bound the graph;
shallowest-first is a preference, not a periodic balancing mandate. IP address,
geography, NAT guess, UA, and scalar quality score do not select a parent.

One structural exception is event-driven Host-root capacity convergence. After a
new Host-root edge commits, if that root has zero direct children and another
Host root has at least two, one deterministic direct child may prepare against the new
root. A fresh healthy candidate sender proof is required before make-before-break
commit. Success moves one branch toward even fanout; failure consumes that one-shot intent. No timer,
continuous rebalance or general load score is introduced.

A failed Peer tuple is consumed for its exact parent and endpoint sessions plus
endpoint-transition strength. SFU create, reuse, and replace are resource
actions for one logical SFU opportunity keyed by the child and Host sessions;
the publication generation remains a physical fence, not retry authority.
Controller-owned publication creation, replacement, or teardown cannot make the
same failed opportunity new. Only a relevant session, an external SFU-resource
wake, or a strictly better transition reopens it. Candidate removal, worsening,
reordering, and unrelated facts do not retry it. An external SFU-resource wake
may reopen SFU opportunities but never Peer opportunities. There is no
persistent parent blacklist.

### Prepare, Commit, And Rollback

Every operation is fenced by room and endpoint sessions, share generation, base
and pending route revisions, and one candidate connection identity. SFU routes
also carry a publication generation. Duplicate current messages are idempotent;
stale asynchronous results fail closed.

The old committed route remains authoritative while the candidate prepares.
Parent and child prepare the same server-issued connection identity. Standard
ICE connected is progress only. For availability work, the exact candidate child
decoding its first new video frame is the application commit proof.

For availability work, the media-ready call commits typed endpoint/SFU
admission before graph promotion. A quality trial treats first decoded frame as
readiness and requires the native edge proof below. Success broadcasts
the candidate revision. Failure, timeout, pause, or stale authority destroys
the candidate, releases reservations idempotently, and broadcasts a strictly
newer rollback revision before another prepare. Clients never infer rollback
from silence or an older revision.

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

The five-second no-transport-progress window is candidate-relative across every
Peer operation. A new candidate receives its own window within the unchanged
total operation deadline; exact transport progress retains it until media proof
or that deadline.

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

Grant revocation, Viewer leave, and SFU-to-P2P replacement remove the exact
LiveKit Viewer participant and confirm its absence. This control-plane drain is
not token revocation or ledger release: an already issued self-hosted LiveKit
token remains usable until expiry, so that subscription's egress stays charged
until the whole publication generation is deleted and confirmed absent.

The application explicitly creates a managed LiveKit room before issuing media
tokens. Replacement, abort, timeout, confirmed media-participant loss, share
rollover, stop, and room deletion transfer the resources they own into the same typed drain path.
Only successful room deletion plus an absence readback releases that generation,
so a stale token cannot recreate off-ledger media. The deployment must dedicate
the LiveKit namespace to Screener and complete startup ownership/cleanup before
accepting traffic; [self-hosting operations](../operations/self-hosting.md) owns
that procedure.

Retiring a publication generation releases every physical SFU handle. An old
SFU root that still carries Peer descendants remains only as an inactive graph
anchor until those descendants are reassigned; a childless old root is removed
immediately. This preserves one source-reachable transition graph without
keeping old media active.

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

Native-edge convergence runs inside the same graph, reconcile loop, and
room-serial child operation when its per-share gate is enabled. Availability
first gets every Viewer usable media; quality work runs only while no join,
failure, pause, identity, departure, capacity, or SFU-resource work needs that
operation. With the gate disabled, quality evidence remains observation-only.

Each exact sender has one native observation: `unknown`, `clear`, or `limited`.
The wire retains `healthy` and `degraded` as the internal categorical names, but
they mean only one complete same-identity `qualityLimitationReason` delta in
`none`, or one in `bandwidth`/`cpu`. This observation can trigger one bounded
experiment; it does not locate the physical bottleneck or prove end-to-end
quality. `other`, missing, reset, hidden, or stale evidence is unknown. SFU
publication and subscription state remains owned by LiveKit plus the exact
Viewer's continuing decoded progress. Screener does not combine loss, RTT,
jitter, bitrate, FPS, resolution, or freezes into a weighted route score.

Routing degradation requires three consecutive complete degraded deltas for the
same exact sender identity. Unknown, stale, reset, source change, or identity
change clears that run. A newly committed availability or direct-convergence
edge may establish a new run without first reporting healthy. Quality- and
root-convergence commits remain disarmed until the new active identity reports
a fresh healthy delta; an explicit sender reset clears the old latch and starts a
new sequence. A single native limitation interval remains diagnostic.
When the current sender remains persistently limited, the controller
considers the shallowest affected child first and uses the existing
deterministic candidate filters, ordering, cursor, reservations, and total
deadline. Candidate Peer parents need a usable source path and available steady
capacity; clear native paths are tried before the remaining deterministic Peer
candidates but are not a hard eligibility tier. Only one candidate runs at a
time and the old route keeps playing. The same Viewer compares fresh,
overlapping old and candidate receive windows. A P2P candidate commits only
after first decoded frame, one fresh healthy delta from its exact candidate
sender, and three consecutive windows with no freeze/pause and no lower pixel
area or rounded FPS. Strict improvement during overlap is not required because
shared source adaptation can hide recovery until the old sender closes.
An otherwise complete current-route window with zero decoded frames is compared
as zero delivered pixels, FPS, and bitrate. It can approve only a temporally
overlapping candidate window that actually decoded video and satisfies the same
freeze, pause, and P2P/SFU partial-order checks. If both routes decode nothing,
the source may be stalled, so the window remains unknown and cannot justify a
move.
Bitrate does not rank P2P candidates because codec and content phase make it
non-monotonic. Three consecutive comparable regressing windows reject the
candidate and advance the existing cursor without resetting the deadline.
Unknown candidate-sender evidence waits within the existing deadline; a stale
relative proof rejects that candidate and advances the existing cursor, while a
degraded candidate sender cannot commit. None creates a score. Old-edge
recovery, authority change, or deadline aborts the experiment. A successful commit clears and rebaselines the affected subtree.
The same rule supplies both active parent change and relay abdication. A bad
relay ingress reparents that relay while retaining its subtree. A bad exact
parent-to-child sender moves only that child. If several senders on one parent
are degraded, one child moves and all remaining native states are observed
again; relief can cancel the remaining work without a parent score or explicit
capacity penalty.

The Host capture/source is a separate fact. A stalled source cannot be repaired
by topology. One limited Host-origin edge may try the same measured Peer move. SFU
becomes a quality suffix only when every current Host-origin Peer edge, with a
minimum of two, independently remains persistently degraded. This bounded
condition identifies possible Host fanout pressure without making SFU an
ordinary candidate. Healthy Peer candidates still run first; if none succeeds,
the same operation may create or reuse the single Host publication. The exact
Host-to-SFU publication generation must supply three consecutive healthy sender
windows before commit. The old Peer route and candidate SFU subscription overlap
while the same Viewer gathers three complete receiver windows. Each candidate
window must decode without a freeze or pause and must
not regress delivered pixel area, rounded frame rate, or bitrate against a fresh
old-route window. This strict partial order has no weights or tradeoff score; an
unknown, incomparable, or worse candidate never commits. One Viewer moves, then
all edge state is re-observed before another Host-relief move. SFU availability
fallback remains independent. An SFU-fed Viewer remains an ordinary Peer parent,
allowing `SFU -> Viewer -> Peer` distribution without turning every Viewer into
an SFU subscription. The shared publication is only resource topology: its
Host-to-SFU ingress proof and each exact SFU-to-Viewer subscription proof remain
separate. A successful Viewer canary cannot authorize any other Viewer, and a
new publication generation invalidates all prior ingress authority.

After a quality- or root-convergence commit, the new active identity starts from
unknown and must establish a fresh healthy delta before another degradation can
trigger a move. There is no periodic wake, weighted prediction, global
optimizer, persistent parent blacklist, custom congestion controller, or manual
SFU layer selection. The result converges gradually to a local stable topology:
no current degraded edge has a proved healthy candidate under the current graph
and resource facts. It
does not promise a static mathematical global optimum.

Two pre-share gates constrain this same controller. Peer-only policy removes
every SFU tuple and bootstrap path before reservation, so exhaustion keeps the
existing explicit failure. Topology convergence is enabled by default and may
be disabled before sharing; when disabled, native evidence never creates
quality work. Both gates are bound to share generation and cannot change while
sharing.

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
- active quality work is local and event-driven, so it does not promise a
  globally optimal tree or react when native evidence remains unknown; and
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
