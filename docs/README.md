# Project Documentation

- [需求理解](./需求理解.md): current product scope, priorities, constraints, and acceptance criteria.
- [方案设计](./方案设计.md): accepted, code-ready design for the first measurable WebRTC proof of concept.
- [Project memory](./project-memory.md): durable decisions and unresolved questions to read at the start of future work.
- [Current status](./status.md): bounded snapshot of the current phase, completed baseline, next step, and blockers.
- [Deployment](./deployment.md): minimal Node, HTTPS/WSS, coturn, firewall, secret, optional TURN/TLS, and network-verification procedure.
- [Maintenance guide](./maintenance.md): Git workflow, context hygiene, document lifecycle, research policy, and automation.
- [P2P WebRTC research](./research/webrtc-p2p-screen-sharing.md): evidence, bandwidth model, browser constraints, reference implementations, and feasibility assessment.
- [Realtime quality adaptation](./research/realtime-quality-adaptation.md): browser degradation policy, live profile changes, offline-encoding boundaries, and measurement gates.
- [Native RTP fanout oracle](./research/native-rtp-fanout-oracle.md): isolated Pion public-API proof for one RTP write across two independent transports, with explicit follow-up gates.
- [Native pre-encoded browser fanout](./research/native-shared-encode-sender.md): bounded offline and continuous Chrome-WebCodecs-to-Pion fanout evidence, queue/security limits, and product hard stops.
- [Native shared-encode feedback control](./research/native-shared-feedback-control.md): deterministic PLI/FIR and two-leg target policies, independent bounded NACK/RTX evidence, and the stock Pion GCC+RTX no-go.
- [Native primary-SSRC retransmission](./research/native-primary-ssrc-retransmission.md): bounded no-RTX NACK replay through stock GCC, one asymmetric Chrome loss-recovery measurement, and its statistics/compatibility hard stops.
- [Native live shared-encoder feedback loop](./research/native-live-feedback-loop.md): bounded two-leg stock-GCC target delivery to one WebCodecs encoder, deterministic post-target loss, and the isolated 720p Chrome gate.
- [Agent context governance research](./research/agent-context-governance.md): official Codex, Claude Code, Hermes Agent, and GitHub practices adopted by this repository.
- [ADR-0001](./adr/0001-p2p-first-media-topology.md): accepted P2P-first media topology and its consequences.
- [ADR-0002](./adr/0002-persistent-protected-rooms.md): optional SQLite persistence, protected sequential room IDs, and room lifecycle.

Documentation and project memory are part of the product source of truth. Update them in the same change that alters the corresponding requirement or architecture.
