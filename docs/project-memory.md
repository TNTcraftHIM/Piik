# Project Memory

Last updated: 2026-10-26

Piik is private, low-latency screen sharing for one Host and up to 20
authenticated friends. The current product surface is Web Host, Web Viewer, and
Browser relay; desktop and mobile Browsers are Viewer targets, and camera-capable
mobile Browsers can also host. It is not a
public broadcast service. Hosted and App run one shared Go core
([ADR-0012](./adr/0012-shared-go-backend-core.md)); Node and Vite build the
Browser UI and are not a runtime. Desktop and Android Apps run
that same core in a self-contained Local deployment or supply native
capability to explicitly approved Sites through the system Browser and shared Web UI. Each App's Go
process starts the loopback capability service before room selection. The
persistent launcher offers Local and temporary public-link choices and manages
per-Site local approval and one starred startup Site. Site use can remain on
standby without a Local room service; native media still belongs to the participant's Web UI.
Room source and media implementation are independent: a topology may mix
Browser and Native peers without changing participant, signaling, capacity, or
route identity. Local is LAN-first; explicit one-link mode exposes that same
authority through a temporary public control tunnel while media remains P2P.
Host authority belongs to a tab, with one separate persistent origin resume
hint. The desktop App admits two independent native control sessions under its one
loopback service.

The Hosted Go process embeds Binding-only STUN and optional SFU forwarding.
Native and SFU use one shared Pion/LiveKit media adapter. Native parents reuse
encoded outputs and derive missing lower outputs from direct-child demand;
adaptation preserves the source and higher sibling outputs. Eligible Browser
capture and relay share local WebRTC producers under ADR-0014, with ordinary
senders as fallback. Platform producers share the encoded-frame boundary and
Host quality controls. Source replacement preserves route and connection identity.

## Product Map

- [Rooms and access](./standards/rooms-access.md) owns room codes,
  invitations, code entry, credentials, room interactions and lightweight/SQLite
  persistence.
- [Routing and transport](./standards/routing-transport.md) owns P2P-first
  distribution, endpoint capacity, SFU fallback, recovery, and privacy limits.
- [Capture and media quality](./standards/media-quality.md) owns Browser capture,
  profiles, codec selection, audio, and framework adaptation.
- [Presentation and lifecycle](./standards/presentation-lifecycle.md) owns Host and
  Viewer workflows, playback authority, roster, state, and Browser lifecycle.

[ADRs](./adr/) own architecture decisions; [research](./research/) owns measurements
and platform limits.
[Engineering maps and source index](./standards/engineering.md#source-index)
locate implementation owners and their module, interface and lifecycle boundaries.

## Core Invariants

- Rooms use random four-digit codes, exact Host ownership, room-scoped Viewer
  invitations and independent `open | private` code entry. Room authority ends
  through replacement/deletion, with separate invitation rotation or revocation.
  Hosted operators may opt into empty-room expiry and capacity reclamation;
  the default retains rooms indefinitely. Hosted defaults to SQLite, with explicit
  process-memory opt-out; App Local remains process-only, with an optional site-access
  password. Site access has a separate 24-hour idle
  cookie lifetime within one service run. Production persists SQLite room
  authority; live participants, routes, and media remain process-only.
- Media is automatic and distributed. Ordinary peers are STUN-only and prefer
  direct/peer UDP. A deployment may enable same-host auxiliary STUN for bounded,
  room-wide, connection-local NAT prediction; current pages use it automatically
  when available, and anonymous provenance distinguishes ordinary from predicted
  selected paths. The configuration default remains stock ICE. The only
  application fallback is one bounded embedded SFU/UDP
  publication; Piik configures no TURN or TCP media route. Hosted operators may
  require SFU-only media through the same controller. On P2P-first sites, a
  pre-share peer-only policy can exclude that SFU suffix for one share generation.
- Ordinary endpoints share one steady outbound-copy cap, default `2` and limited to
  `1..3`; the explicit relay volunteer uses the
  [capacity owner](./standards/routing-transport.md#endpoint-and-server-capacity).
  One room controller owns one committed graph, one reconcile loop, and
  one serial child operation. First decoded frame commits picture availability work;
  accepted quality work adds native edge proof before commit in that operation.
- Browser WebRTC and the shared Pion/LiveKit media adapter own congestion control,
  media adaptation, pacing and layer selection. Parent demand is local to direct
  children and never a room-wide minimum or topology rebalance. Current source
  defaults persistent native-edge local P2P convergence on, with a pre-share
  Host opt-out. SFU quality work is limited to multi-root Host fanout relief;
  each Viewer must prove candidate non-regression before commit. One bounded
  same-parent regeneration may repair a persistently limited edge through
  that same operation; the [routing owner](./standards/routing-transport.md)
  defines its eligibility and damping.
  No weighted score, all-pairs probe, general parent-wide prediction, or
  periodic rebalance is accepted.
- Browser video uses `motion`; each share chooses H.264 with VP8 fallback through
  an actual sender probe unless the Host explicitly selects VP8 or H264. Screen
  audio retains its compact presets and 128 kbps default. The 2.0 contract
  separates numeric bitrate requests from those UI shortcuts; implementation
  limits and admission remain in the media-quality owner.
- Viewer playback uses one native video element. Presentation and recovery are
  fenced by current route/media identity and current-frame proof; hidden-page
  time alone is not media-failure evidence or a keepalive guarantee.

## Current Snapshot

Room voice shares room authority and one route controller with picture sharing.
Picture generations and explicitly joined voice publications have separate
lifetimes. Optional source commentary belongs to the share and runs independently
of room voice. [Room media](./standards/routing-transport.md#room-media) owns
these lifecycles.

Optional attended input follows the committed media route back to the native
Host. One grant covers keyboard/mouse and an optional gamepad. Control starts
with one grantee; the Host may allow simultaneous approved Viewers for that source.
Older published clients retain exclusive keyboard/mouse control. Source change, stop
and revocation retire the affected grants. It adds no separate connection planner
or listener.
Viewer playback preferences and the combined interaction window remain local
presentation owners under the existing 2.x compatibility boundary.

The current contract tuple is owned by [status](./status.md#accepted-release-contract).
Embedded SFU SDP/ICE and demand use the authenticated room WebSocket.
[Deployment](./deployment.md) owns rollback with matching Browser and App artifacts.

Unfinished work is owned by the [TODO ledger](./todo.md).
[Status](./status.md) indexes delivery; [verification status](./verification-status.md)
summarizes evidence boundaries. [Configuration](./standards/configuration.md)
and [self-hosting](./operations/self-hosting.md) own environment and services.
Release descriptors and deployment records own exact deployed identity;
Git and pull requests own completed history.
