# Project Memory

Last updated: 2026-09-10

Piik is private, low-latency game screen sharing for one Host and up to 20
authenticated friends. The current product surface is Web Host, Web Viewer, and
Browser relay; desktop and mobile Browsers are Viewer targets. It is not a
public broadcast service. Hosted and Client run one shared Go core
([ADR-0012](./adr/0012-shared-go-backend-core.md)); Node and Vite build the
Browser UI and are not a runtime. Source includes a cross-platform Client that
runs that same core in a self-contained Local deployment or opens one configured
Site through the system Browser. Its single Go process presents Local, temporary
public-link, and saved-Site choices on every launch, starts one process-level
loopback capability service, owns the Local room authority in-process when
selected, and owns the explicit native media path chosen in the same Web UI.
Room source and media implementation are independent: a topology may mix
Browser and Native peers without changing participant, signaling, capacity, or
route identity. Local is LAN-first; explicit one-link mode exposes that same
authority through a temporary public control tunnel while media remains P2P.
Host authority belongs to a tab, with one separate persistent origin resume
hint. The Client admits two independent native control sessions under its one
loopback service.

The current source embeds Binding-only STUN and optional SFU forwarding in
the Hosted Go process. Native and SFU use one shared Pion/LiveKit media adapter;
Native parents reuse suitable encoded outputs and derive a missing lower output
only for direct-child demand. Source-owned groups retain the highest needed
output and lower fallbacks, while each child receives its selected output.
Native Host SFU publication reuses the encoded source directly; its loopback
Browser edge owns preview only. Eligible Browser capture and relay now share
independent local WebRTC producers for compatible direct children under ADR-0014;
unsupported APIs and failed pooling retain ordinary senders. Windows, macOS and
Linux producers share one encoded-frame
boundary and Host quality controls. Source replacement retains route and
connection identity; lower-output adaptation preserves the original and higher
sibling outputs. [Status](./status.md) owns the remaining physical and release
acceptance boundary; runtime release descriptors own deployed identity.
The Local launcher keeps an optional user-chosen site-access password; leaving it
blank keeps the self-contained site open.

## Product Map

- [Rooms and access](./product/rooms-access.md) owns room codes,
  invitations, code entry, credentials, and lightweight/SQLite persistence.
- [Routing and transport](./product/routing-transport.md) owns P2P-first
  distribution, endpoint capacity, SFU fallback, recovery, and privacy limits.
- [Capture and media quality](./product/media-quality.md) owns Browser capture,
  profiles, codec selection, audio, and framework adaptation.
- [Presentation and lifecycle](./product/presentation-lifecycle.md) owns Host and
  Viewer workflows, playback authority, roster, state, and Browser lifecycle.

Non-obvious decisions live in [ADRs](./adr/); reproducible evidence and platform
limits live in [research](./research/). Source code and tests own self-evident
implementation and routine UI detail.

## Core Invariants

- Rooms use random four-digit codes, exact Host ownership, room-scoped Viewer
  invitations and independent `open | private` code entry. Room authority ends
  through explicit replacement/deletion, with separate invitation rotation or
  revocation. Hosted defaults to SQLite, with explicit process-memory opt-out;
  Client Local remains process-only. Site access has a separate 24-hour idle
  cookie lifetime. Production persists SQLite room authority; live
  participants, routes, and media remain process-only.
- Media is automatic and distributed. Ordinary peers are STUN-only and prefer
  direct/peer UDP. A deployment may enable same-host auxiliary STUN for bounded,
  room-wide, connection-local NAT prediction; its Host switch defaults on when
  available, and anonymous provenance distinguishes ordinary from predicted
  selected paths. The configuration default remains stock ICE. The only
  application fallback is one bounded embedded SFU/UDP
  publication; Piik configures no TURN or TCP media route. A pre-share
  peer-only policy can exclude that SFU suffix for one share generation.
- Every endpoint shares one steady outbound-copy cap, default `2` and limited to
  `1..3`. One room controller owns one committed graph, one reconcile loop, and
  one serial child operation. First decoded frame commits availability work;
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
  audio uses 64/128/192 kbps ceilings with 128 default.
- Viewer playback uses one native video element. Presentation and recovery are
  fenced by current route/media identity and current-frame proof; hidden-page
  time alone is not media-failure evidence or a keepalive guarantee.

## Current Snapshot

The current contract uses strict `piik-v23` Browser/server signaling,
Native control v9 and capture v7 together. Embedded SFU SDP/ICE and demand travel over the
authenticated room WebSocket, without an external room service or media token.
Committed first-frame readiness, bounded candidate-relative progress, durable
room authority and the H.264/VP8 sender gate remain. [Status](./status.md)
indexes source and deployment evidence; protocol rollback requires
matching Browser and Client artifacts, not only an application symlink.

Current work is owned by the [TODO ledger](./todo.md). Open physical evidence is
owned by [verification status](./verification-status.md). Environment and initial
services are owned by [configuration](./reference/configuration.md) and
[self-hosting](./operations/self-hosting.md); application release is owned by
[deployment](./deployment.md), with exact deployed identity retained in the
release descriptor and deployment record.
Git history and pull requests own completed timelines.
