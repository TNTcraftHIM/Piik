# Documentation Map

Start with [project memory](./project-memory.md), [status](./status.md), and
[TODO](./todo.md). Read only the product, decision, evidence, or operations file
needed for the current task.

## Current Product

- [Rooms and access](./product/rooms-access.md)
- [Routing and transport](./product/routing-transport.md)
- [Capture, audio, and media quality](./product/media-quality.md)
- [Presentation and lifecycle](./product/presentation-lifecycle.md)

These four modules own current product behavior. Source code and tests own
ordinary implementation and UI detail.

## Current Indexes And Operations

- [Project memory](./project-memory.md): compact cross-domain map and invariants.
- [Status](./status.md): exact current source, production, milestone, and holds.
- [TODO](./todo.md): the only current work ledger.
- [Verification](./verification-status.md): open physical evidence and expensive
  gate applicability.
- [Deployment](./deployment.md): immutable application release and recovery.
- [Self-hosting](./operations/self-hosting.md): initial services, topology, and
  operational verification.
- [Configuration](./reference/configuration.md): environment, secrets, bounds,
  and ports.
- [Maintenance](./maintenance.md): truth ownership, context, and repository
  lifecycle.

## Decisions

- [ADR-0001](./adr/0001-p2p-first-media-topology.md): initial P2P-first
  baseline.
- [ADR-0002](./adr/0002-memory-resident-protected-rooms.md): room authority and
  optional SQLite stability.
- [ADR-0004](./adr/0004-peer-assisted-media-experiment.md): Browser relay
  experiment.
- [ADR-0005](./adr/0005-automatic-hybrid-media-routing.md): current automatic
  route and SFU resource model.
- [ADR-0006](./adr/0006-fixed-high-native-sender-canary.md): historical native
  sender canary evidence (superseded by ADR-0010).
- [ADR-0007](./adr/0007-path-isolated-representation-quality.md): framework-
  owned media adaptation.
- [ADR-0008](./adr/0008-window-scoped-audio-capture.md): Browser/native window
  audio boundary.
- [ADR-0009](./adr/0009-optional-nat-prediction.md): optional connection-local
  NAT prediction.
- [ADR-0011](./adr/0011-browser-assisted-native-fanout.md): Browser capture with
  Client encoded fanout.
- [ADR-0010](./adr/0010-cross-platform-client-runtime.md): cross-platform Client
  runtime and self-contained package boundary.
- [ADR-0012](./adr/0012-shared-go-backend-core.md): one shared Go backend core
  for Hosted and Client, amending part of ADR-0010.

## Evidence

Routing and transport:

- [WebRTC feasibility](./research/webrtc-p2p-screen-sharing.md)
- [Browser peer relay](./research/peer-assisted-media.md)
- [Low-server-cost routes](./research/low-server-media-routes.md)
- [Advanced distribution alternatives](./research/advanced-peer-distribution.md)

Media and platform:

- [Realtime quality and codecs](./research/realtime-quality-adaptation.md)
- [Browser background capture](./research/browser-background-capture.md)
- [Browser screen audio](./research/browser-screen-audio-quality.md)
- [Browser NAT traversal](./research/nat-traversal.md)
- [Browser platform output](./research/platform-output.md)
- [Historical native sender and shared encode evidence](./research/native-sender.md)
- [Native Client media](./research/native-client-media.md)
- [Cross-platform Client runtime](./research/cross-platform-client-runtime.md)

Rooms and repository practice:

- [Cross-restart room recovery](./research/cross-restart-room-recovery.md)
- [Agent context governance](./research/agent-context-governance.md)

Backend structure:

- [Server consolidation](./research/server-consolidation.md): Go core ownership
  and its acceptance checklist
- [Backend audit and refactor preparation](./research/backend-audit-1b01048.md)

Research records verified facts, measurements, assumptions, licenses, and
remaining evidence boundaries. It does not own current product behavior or work
priority.
