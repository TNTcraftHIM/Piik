# Routing And Transport

This file owns the user-visible routing and transport contract.
[ADR-0005](../adr/0005-automatic-hybrid-media-routing.md) owns the controller
algorithm and resource invariants; [configuration](./configuration.md)
owns ports and [self-hosting](../operations/self-hosting.md) owns service setup.

## Topology

- Media is automatic and P2P-first. Users do not select parents, route types, or
  network transports.
- The Host is the only source. Every Viewer has at most one active upstream, and
  the committed media graph is acyclic and source-reachable.
- A Viewer may relay its received Browser track to bounded peer children. This
  is standard WebRTC receive, decode, and per-child re-encode, not shared encode.
- SFU-fed and peer-fed Viewers may both serve as ordinary peer parents.
- A route ends in usable media, explicit bounded waiting, or clear failure.

Every deployment uses this controller. Leaving embedded SFU disabled keeps the
same bounded P2P graph without its SFU fallback and fixes Privacy mode on for all
rooms, including App Local and public-link rooms. The server enforces that policy
for waiting and active participants; there is no separate Host-star mode.

## Per-Share Route Policy

The Host chooses route policy before sharing and it remains fixed for that
share generation:

- when SFU is available, default hybrid mode keeps P2P first and permits the
  bounded SFU suffix;
- peer-only mode excludes SFU publication, subscription, bootstrap, and quality
  candidates, while retaining the same bounded Peer graph and clear exhausted
  failure; and
- native-edge topology convergence is enabled by default. The Host may disable
  it before sharing; when disabled, quality evidence stays diagnostic and
  availability routing is unchanged;
- NAT traversal requires an exact three-destination STUN survey: a Site may use
  self-hosted 3478/3479/3480, Public Link uses its bounded public survey, and
  pure LAN supplies none. Its default-on Host switch augments Browser and Native
  P2P edges. Native uses one media socket for IPv4 and, where available, IPv6
  direct connections; its STUN survey and best-effort gateway mapping use IPv4.
  Availability and background direct acquisition share a bounded budget of
  three actual connection attempts per eligible parent/session opportunity.
  Retries use the same serial controller and normal operation deadlines;
  waiting Viewers and untried parents receive their opportunities first.
  It is not a participant capability, route score, or SFU preference. Candidate
  generation and selected-pair diagnostics retain only
  `ordinary | predicted | unknown` provenance.
  [ADR-0009](../adr/0009-optional-nat-prediction.md) owns the bounded behavior
  and evidence boundary.

These are route-policy gates, not new routing algorithms. Changing any
policy requires stopping the current share and starting another generation.

## Endpoint And Server Capacity

Every non-server endpoint has one server-authoritative steady outbound media-
copy cap `C`, default `2` and configurable only as `1`, `2`, or `3`.

- one peer child consumes one copy;
- the Host's single SFU publication consumes one copy;
- upstream receive is free;
- role, Browser, UA, visibility, and codec do not create another tier.

A make-before-break transition may use the one admitted overlap slot and must
return to steady capacity at commit or abort. SFU publication ingress and
per-Viewer subscription egress use an independent server admission ledger;
ordinary endpoint child counts are not server capacity.

## Reconciliation

One room controller owns the committed graph and one bounded child transition.
Healthy current edges remain sticky. When admitted overlap exists, a usable old
route stays active until the exact candidate child decodes a first new frame;
ICE connected alone is not commit proof. Availability repair may instead use the
explicit bounded-gap plan defined by ADR-0005 when no overlap slot exists.
Failure or stale authority releases the candidate and preserves unaffected
branches. An operation's purpose is immutable; availability work preempts a
background operation by replacing it rather than changing its meaning. An
internally created or retired SFU publication does not by itself reopen an
exhausted media route.

Direct peers receive the first bounded opportunity, with SFU used for
availability when direct paths cannot provide media. Remaining direct paths may
converge behind a working SFU route. Relay-ingress failure reparents that relay
without discarding its subtree; departure and capacity changes move only affected
children. ADR-0005 owns filtering, ordering, cursor, revision, reservation, and
rollback mechanics.

Five seconds is a scheduling window only while another bounded candidate or SFU
fallback remains. It advances a silent Peer candidate instead of delaying the
next available route; it is not interpreted as terminal ICE failure. The final
or only Peer candidate remains until the unchanged total operation deadline.
Transport-connected progress also retains a candidate through that deadline.
Consequently a working SFU route can carry media while its one-candidate direct
convergence uses the full background operation, and peer-only acquisition does
not abandon its only possible route at the foreground boundary.
The pending Viewer transport reports an actual Browser failure but installs no
shorter initial or disconnected-state deadline. Viewer-owned reconnect timing
begins only after that exact candidate commits as the active route.
Either preparing endpoint reports local rejection or connection-start failure
to that same operation immediately; it does not wait out a silent candidate's
deadline or start an independent recovery loop.
When NAT traversal is enabled, another operation may use the remaining
connection-attempt budget after rollback. The waiting display uses the actual
server-issued attempt ordinal; it never counts time as an attempted connection.
Committed Browser P2P recovery first restarts ICE on the same connection, then
rebuilds that connection if necessary, within the existing two-request budget.
It does not require NAT prediction or reopen the route candidate. A prepared
candidate instead follows its current route operation's failure path, without
an independent restart loop.

When a newly committed Host-root Viewer exposes unused downstream capacity while
another Host root has at least two direct children, the same background operation may
move one of those children to the new root. The candidate must prove a healthy
native sender edge before commit. This one-shot event-driven move reduces root
fanout skew; it is not periodic balancing and does not move a healthy branch
without admitted overlap.

Framework reconnect runs before route reassignment. Manual media reconnect also
recovers only the current P2P parent or current SFU subscription; it does not
perform quality selection or choose another route.
Current-edge P2P signaling remains valid during candidate overlap. Accepting a
replacement from that parent cancels conflicting optional preparation so the
replacement can complete; a retired candidate cannot take its place afterward.

## SFU Fallback

The only application fallback is one admitted embedded SFU publication from the
Host, with independently admitted Viewer subscriptions. The controller may
create it through the same bounded transition when Host capacity is occupied.
No Viewer creates a second publication.

SFU offer/answer, ICE and output demand use the existing authenticated room
WebSocket. The server binds each physical connection to the current participant,
share and publication; it issues no separate media token or room-service URL.
Browser SFU PeerConnections use the server's UDP candidates and no external
ICE-server list. Ordinary peer connections use deployment STUN. Hosted Piik
owns its configured Binding-only STUN listeners and optional SFU UDP listener in
the same Go process. Piik
configures no TURN, ICE/TCP, media TCP, or TLS-relayed media path. HTTPS/WSS is a
separate control transport and remains TLS/TCP.

SFU resources remain bounded throughout reservation, use, and cleanup; stale
signaling cannot recreate off-ledger media. Grant revocation, Viewer leave,
and SFU-to-P2P replacement close the exact physical subscription before releasing
its egress reservation. Publication teardown closes its ingress and descendants
before releasing their reservations. There is no outstanding external token to
retain after those resources close. ADR-0005's graph and operation rules remain;
[ADR-0013](../adr/0013-embedded-node-local-media.md) replaces the external-service lifecycle.

Transient room-signaling loss does not close healthy SFU media. The current
physical connection can restart ICE; actual terminal media failure returns to
the same bounded route recovery. Source capture remains Host-owned throughout.

## Quality And Privacy Boundaries

Browser WebRTC and the shared Pion/LiveKit media adapter own ICE, consent,
congestion control, bitrate, frame rate, resolution, retransmission, pacing and
layer selection. Direct-child media demand does not create a topology operation.
When the per-share convergence gate is enabled, Piik uses an exact persistent native
sender limitation only to trigger one measured experiment through the existing
serial operation. Three fresh complete limited deltas from one exact sender may
trigger that experiment on a newly committed availability or direct-convergence
edge without a preceding clear delta. A quality- or root-convergence result must
recover clear before it can rearm. The same Viewer must then prove three fresh
overlapping P2P candidate windows with no freeze or pause and no lower delivered
pixel area or rounded FPS, while the exact candidate sender has fresh clear
native evidence at commit. The candidate need not show a strict gain before the
retained sender closes. A complete
zero-frame current window counts as zero delivery only when an overlapping
candidate actually decodes clean video; two zero-frame paths remain unknown. A
missing or limited exact candidate sender cannot commit; an expired one-shot
relative proof rejects that candidate. An unknown current-sender window clears
the trigger run but does not cancel an already-started bounded Peer experiment;
healthy recovery, explicit reset, or identity change does. Failed candidates are
not retried for the same exact sender sequence merely because an unrelated route
fact changed, while a new parent or improved capacity transition remains a new
opportunity. When no different Peer parent is eligible, the same operation may
append one same-parent connection regeneration candidate; it uses the same
first-frame, overlap, and proof rules and is damped by its exact post-commit
sender identity. Ordinary quality moves remain Peer-to-Peer. SFU may
join quality work only as Host fanout relief when every current Host-origin Peer
edge, with at least two such edges, is persistently degraded; one Viewer moves
before the controller observes the new topology again. During that overlap, the
same Viewer must prove the SFU candidate does not regress delivered resolution,
frame rate, or bitrate across persistent complete windows and produces no
freeze or pause; otherwise the old Peer route stays. The Host publication
ingress and every Viewer subscription are separate quality paths. One Viewer's
SFU proof never authorizes another Viewer. Disabling the gate leaves quality
state diagnostic. Piik has no weighted route score, general parent-wide
prediction, all-pairs probe, periodic rebalance, persistent parent blacklist,
NAT classification, or independent depth cap.

Direct P2P exposes endpoint network addresses to the trusted peer. SFU media is
encrypted hop-by-hop with DTLS-SRTP but terminates at the SFU; the product does
not claim operator-blind media without a separately accepted application E2EE
design. All-UDP-blocked networks currently end in bounded failure.

App Local mode runs this graph without SFU, NAT prediction, or default STUN.
One-link mode tunnels only HTTP/WebSocket control and adds public STUN to the
same Browser/Native P2P edges. Reachable peers form one mixed relay tree; an
unreachable path adds no route type or score. Site mode uses Site transport.

A Native Host reserves one loopback edge for Browser preview; it consumes no
route-copy capacity or gateway mapping. Direct children and the admitted Native
SFU publisher reuse the encoded source through the shared media adapter. The SFU
publication still consumes one route copy and one aggregate upstream budget.

A native Viewer terminates only its P2P upstream, reserves one Browser playback
edge, and reuses compatible H.264/VP8/Opus for bounded children, deriving a missing
lower output only on direct-child demand. Browser keeps SFU subscription,
route revisions, frame proof, and fallback.
