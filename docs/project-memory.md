# Project Memory

Last updated: 2026-09-06

Screener is private, low-latency game screen sharing for one Host and up to 20
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
Room source and media
implementation are independent: a topology may mix Browser and Native peers
without changing participant, signaling, capacity, or route identity. Native
Host and H.264/VP8 Viewer receive/relay adapters share the same Pion media edge;
unsupported Viewer media falls back to Browser. A Client-assisted Browser Host
can feed that fanout through one local H.264 sender while quality convergence is
enabled; losing the Client preserves Browser capture. Local remains
a serverless-LAN mode by default; explicit one-link mode exposes that same
authority through a session-scoped public control tunnel while media remains
P2P. Minimal Windows, macOS, and Linux adapters terminate at one encoded-frame
boundary; only Windows has completed physical native-media acceptance, while
the other two compile and package. Native capture consumes the same room quality
settings and applies live quality or source changes behind its stable encoded
source and connections. Native P2P edges feed Pion GCC's categorical payload-
capacity result into the existing route evidence windows. Healthy Native sender
edges share one hardware encode; the existing quality operation may test one
stock Browser sender for a persistently degraded edge without lowering the
shared source. One reserved loopback edge gives the system Browser a preview and
lets native Host media reuse the existing LiveKit publisher when SFU fallback is
assigned; broader package acceptance remains a later gate.
The Local launcher keeps an optional user-chosen site-access password; leaving it
blank keeps the self-contained site open.

## Product Map

- [Rooms and access](./product/rooms-access.md) owns room codes, leases,
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
  invitations, independent `open | private` code entry, and a 24-hour dormant
  lease. Production enables optional SQLite stable room authority; live
  participants, routes, and media remain process-only.
- Media is automatic and distributed. Ordinary peers are STUN-only and prefer
  direct/peer UDP. A deployment may enable same-host auxiliary STUN for bounded,
  room-wide, connection-local NAT prediction; its Host switch defaults on when
  available, and anonymous provenance distinguishes ordinary from predicted
  selected paths. The configuration default remains stock ICE. The only
  application fallback is one bounded LiveKit SFU/UDP
  publication; Screener configures no TURN or TCP media route. A pre-share
  peer-only policy can exclude that SFU suffix for one share generation.
- Every endpoint shares one steady outbound-copy cap, default `2` and limited to
  `1..3`. One room controller owns one committed graph, one reconcile loop, and
  one serial child operation. First decoded frame commits availability work;
  accepted quality work adds native edge proof before commit in that operation.
- WebRTC and LiveKit own congestion control, media adaptation, reconnect, and SFU
  layers. Current source defaults persistent native-edge local P2P convergence
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

The audit candidate uses the strict `screener-v21` Browser/server contract with
committed media readiness, bounded candidate-relative progress and one-shot
Host-root convergence. It retains optional SQLite room authority and the
H.264/VP8 sender gate. [Status](./status.md) owns the compact current execution
snapshot rather than duplicating per-release identity.

Current work is owned by the [TODO ledger](./todo.md). Open physical evidence is
owned by [verification status](./verification-status.md). Environment and initial
services are owned by [configuration](./reference/configuration.md) and
[self-hosting](./operations/self-hosting.md); application release is owned by
[deployment](./deployment.md), with exact deployed identity retained in the
release descriptor and deployment record.
Git history and pull requests own completed timelines.
