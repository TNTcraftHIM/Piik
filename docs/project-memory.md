# Project Memory

Last updated: 2026-10-22

Piik is private, low-latency screen sharing for one Host and up to 20
authenticated friends. The current product surface is Web Host, Web Viewer, and
Browser relay; desktop and mobile Browsers are Viewer targets, and camera-capable
mobile Browsers can also host. It is not a
public broadcast service. Hosted and App run one shared Go core
([ADR-0012](./adr/0012-shared-go-backend-core.md)); Node and Vite build the
Browser UI and are not a runtime. Source includes a cross-platform App that
runs that same core in a self-contained Local deployment or supplies native
capability to one approved Site through the system Browser. Its single Go
process starts the loopback capability service before room selection. The
persistent launcher offers Local and temporary public-link choices and manages
the Site's explicit local approval. Site use can remain on standby without a
Local room service; native media still belongs to the participant's Web UI.
Room source and media implementation are independent: a topology may mix
Browser and Native peers without changing participant, signaling, capacity, or
route identity. Local is LAN-first; explicit one-link mode exposes that same
authority through a temporary public control tunnel while media remains P2P.
Host authority belongs to a tab, with one separate persistent origin resume
hint. The App admits two independent native control sessions under its one
loopback service.

The current source embeds Binding-only STUN and optional SFU forwarding in
the Hosted Go process. Native and SFU use one shared Pion/LiveKit media adapter;
Native parents reuse suitable encoded outputs and derive a missing lower output
only for direct-child demand. Source-owned groups retain the highest needed
output and lower fallbacks, while each child receives its selected output.
Native Host SFU publication reuses the encoded source directly; its loopback
Browser stream supplies local preview and Browser quality candidates. Eligible
Browser capture and relay now share
independent local WebRTC producers for compatible direct children under ADR-0014;
unsupported APIs and failed pooling retain ordinary senders. Windows, macOS and
Linux producers share one encoded-frame
boundary and Host quality controls. Source replacement retains route and
connection identity; lower-output adaptation preserves the original and higher
sibling outputs. [Status](./status.md) owns candidate and release readiness;
runtime release descriptors own deployed identity.
The Local launcher keeps an optional user-chosen site-access password; leaving it
blank keeps the self-contained site open.

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

Non-obvious decisions live in [ADRs](./adr/); reproducible evidence and platform
limits live in [research](./research/). Source code and tests own self-evident
implementation and routine UI detail.

## Core Invariants

- Rooms use random four-digit codes, exact Host ownership, room-scoped Viewer
  invitations and independent `open | private` code entry. Room authority ends
  through replacement/deletion, with separate invitation rotation or revocation.
  Hosted operators may opt into empty-room expiry and capacity reclamation;
  the default retains rooms indefinitely. Hosted defaults to SQLite, with explicit
  process-memory opt-out; App Local remains process-only. Site access has a separate 24-hour idle
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
  `1..3`; the candidate's explicit relay volunteer uses the
  [capacity owner](./standards/routing-transport.md#endpoint-and-server-capacity).
  One room controller owns one committed graph, one reconcile loop, and
  one serial child operation. First decoded frame commits picture availability work;
  accepted quality work adds native edge proof before commit in that operation.
- Browser WebRTC and the shared Pion/LiveKit media adapter own congestion control,
  media adaptation, pacing and layer selection. Parent demand is local to direct
  children and never a room-wide minimum or topology rebalance. Current source
  defaults persistent native-edge local P2P convergence
  on, with a pre-share Host opt-out. SFU quality work is limited to multi-root
  Host fanout relief and each Viewer must prove its own candidate non-regression
  before commit. A persistently limited edge with no different Peer parent may
  use one same-parent connection regeneration through that same operation; its
  exact post-commit sender identity damps only another same-edge regeneration.
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

Room voice integrates normal App/Server/Web rather than a
standalone demo. It keeps room authority and one route controller while picture
generations and explicitly joined voice publications have separate
lifetimes. [Status](./status.md#current-work)
indexes delivery and [room media](./standards/routing-transport.md#room-media)
owns the new behavior.

Optional attended input follows the committed media route back to the native
Host. Control defaults to one keyboard/mouse grantee; source-scoped co-play can
admit multiple keyboard contributors and optional independent virtual gamepads,
with one explicit mouse owner. Source change, stop and revocation retire the
affected grants. It adds no separate connection planner or listener.
Viewer playback preferences and the combined interaction window remain local
presentation owners under the existing 2.x compatibility boundary.

The current contract tuple is owned by [status](./status.md#accepted-release-contract).
Embedded SFU SDP/ICE and demand travel over the
authenticated room WebSocket, without an external room service or media token.
Committed first-frame readiness, bounded candidate-relative progress, durable
room authority and the H.264/VP8 sender gate remain. [Status](./status.md)
indexes source and deployment evidence; protocol rollback requires
matching Browser and App artifacts, not only an application symlink.

Unfinished work is owned by the [TODO ledger](./todo.md).
[Verification status](./verification-status.md) summarizes material evidence
boundaries. Environment and initial
services are owned by [configuration](./standards/configuration.md) and
[self-hosting](./operations/self-hosting.md); application release is owned by
[deployment](./deployment.md), with exact deployed identity retained in the
release descriptor and deployment record.
Git history and pull requests own completed timelines.
