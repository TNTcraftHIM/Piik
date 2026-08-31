# Project Memory

Last updated: 2026-08-28

Screener is private, low-latency game screen sharing for one Host and up to 20
authenticated friends. The current product surface is Web Host, Web Viewer, and
Browser relay; desktop and mobile Browsers are Viewer targets. It is not a
public broadcast service. Native capture, shared encoding, distributable
packages, and broader platform output remain later work.

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
  direct/peer UDP. The only application fallback is one bounded LiveKit SFU/UDP
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

Canonical source uses the strict `screener-v17` Browser/server contract with
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
