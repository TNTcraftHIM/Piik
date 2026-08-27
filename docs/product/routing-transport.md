# Routing And Transport

This file owns the user-visible routing and transport contract.
[ADR-0005](../adr/0005-automatic-hybrid-media-routing.md) owns the controller
algorithm and resource invariants; [configuration](../reference/configuration.md)
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

The flagship deployment enables the all-room controller. A lightweight
deployment may disable peer assistance and keep only bounded direct Host edges;
it does not gain another transport or compatibility protocol.

## Per-Share Route Policy

The Host chooses route policy before sharing and it remains fixed for that
share generation:

- default hybrid mode keeps P2P first and permits the bounded SFU suffix;
- peer-only mode excludes SFU publication, subscription, bootstrap, and quality
  candidates, while retaining the same bounded Peer graph and clear exhausted
  failure; and
- native-edge topology convergence is initially opt-in. When disabled, quality
  evidence stays diagnostic and availability routing is unchanged.

These are route-policy gates, not new routing algorithms. Changing either
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
branches.

Direct peers receive the first bounded opportunity, with SFU used for
availability when direct paths cannot provide media. Remaining direct paths may
converge behind a working SFU route. Relay-ingress failure reparents that relay
without discarding its subtree; departure and capacity changes move only affected
children. ADR-0005 owns filtering, ordering, cursor, revision, reservation, and
rollback mechanics.

Every unconnected Peer candidate gets the same five-second no-progress window.
Transport-connected progress retains it through the operation deadline. This
applies to join, recovery, direct convergence, quality convergence and structural
convergence; candidate order never resets the total deadline.

When a newly committed Host-root Viewer exposes unused downstream capacity while
another Host root has at least two direct children, the same background operation may
move one of those children to the new root. The candidate must prove a healthy
native sender edge before commit. This one-shot event-driven move reduces root
fanout skew; it is not periodic balancing and does not move a healthy branch
without admitted overlap.

Framework reconnect runs before route reassignment. Manual media reconnect also
rebuilds only the current P2P parent or current SFU subscription; it does not
perform quality selection or choose another route.

## SFU Fallback

The only application fallback is one dedicated LiveKit SFU publication from the
Host, with independently admitted Viewer subscriptions. The controller may
create it through the same bounded transition when Host capacity is occupied.
No Viewer creates a second publication.

Browser SFU PeerConnections use LiveKit-signaled UDP candidates and no external
ICE-server list. Ordinary peer connections use deployment STUN. Screener
configures no TURN, ICE/TCP, media TCP, or TLS-relayed media path. HTTPS/WSS is a
separate control transport and remains TLS/TCP.

SFU resources remain bounded throughout reservation, use, and cleanup; stale
credentials cannot recreate off-ledger media. ADR-0005 owns that lifecycle.

## Quality And Privacy Boundaries

WebRTC and LiveKit own ICE, consent, congestion control, bitrate, frame rate,
resolution, retransmission, reconnect, and SFU layer selection. When the
per-share convergence gate is enabled, Screener uses an exact persistent native
sender limitation only to trigger one measured experiment through the existing
serial operation. The same Viewer must then prove a P2P candidate strictly
improves delivered pixel area or rounded FPS without regressing either dimension
or producing a freeze/pause across three fresh paired windows. Ordinary quality
moves remain Peer-to-Peer. SFU may
join quality work only as Host fanout relief when every current Host-origin Peer
edge, with at least two such edges, is persistently degraded; one Viewer moves
before the controller observes the new topology again. During that overlap, the
same Viewer must prove the SFU candidate does not regress delivered resolution,
frame rate, or bitrate across persistent complete windows and produces no
freeze or pause; otherwise the old Peer route stays. The Host publication
ingress and every Viewer subscription are separate quality paths. One Viewer's
SFU proof never authorizes another Viewer. Disabling the gate leaves quality
state diagnostic. Screener has no weighted route score, general parent-wide
prediction, all-pairs probe, periodic rebalance, persistent parent blacklist,
NAT classification, or independent depth cap.

Direct P2P exposes endpoint network addresses to the trusted peer. SFU media is
encrypted hop-by-hop with DTLS-SRTP but terminates at the SFU; the product does
not claim operator-blind media without a separately accepted application E2EE
design. All-UDP-blocked networks currently end in bounded failure.
