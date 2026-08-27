# Project Memory

Last updated: 2026-08-27

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
  publication; Screener configures no TURN or TCP media route.
- Every endpoint shares one steady outbound-copy cap, default `2` and limited to
  `1..3`. One room controller owns one committed graph, one reconcile loop, and
  one serial child operation. First decoded frame is candidate commit proof.
- WebRTC and LiveKit own congestion control, media adaptation, reconnect, and SFU
  layers. Current route quality is diagnostic; no weighted score, all-pairs
  probe, parent-wide inference, or periodic rebalance is accepted.
- Browser video uses `motion`; each share chooses H.264 with VP8 fallback through
  an actual sender probe unless the Host explicitly selects VP8 or H264. Screen
  audio uses 64/128/192 kbps ceilings with 128 default.
- Viewer playback uses one native video element. Presentation and recovery are
  fenced by current route/media identity and current-frame proof; hidden-page
  time alone is not media-failure evidence or a keepalive guarantee.

## Current Snapshot

Canonical source and production use the strict `screener-v13` Browser/server
contract, optional SQLite room authority, the H.264/VP8 sender gate, and the
evidence-only quality shadow. [Status](./status.md) is the sole owner of exact
source, artifact, deployment, milestone, and blocker identity.

Current work is owned by the [TODO ledger](./todo.md). Open physical evidence is
owned by [verification status](./verification-status.md). Environment and initial
services are owned by [configuration](./reference/configuration.md) and
[self-hosting](./operations/self-hosting.md); application release is owned by
[deployment](./deployment.md).
Git history and pull requests own completed timelines.
