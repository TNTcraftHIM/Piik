# Project Documentation

- [需求理解](./需求理解.md): current product scope, priorities, constraints, and acceptance criteria.
- [方案设计](./方案设计.md): accepted, code-ready design for the first measurable WebRTC proof of concept.
- [Project memory](./project-memory.md): durable decisions and unresolved questions to read at the start of future work.
- [Current status](./status.md): bounded snapshot of the current phase, completed baseline, next step, and blockers.
- [Deployment](./deployment.md): minimal Node, HTTPS/WSS, coturn, firewall, secret, optional TURN/TLS, and network-verification procedure.
- [Maintenance guide](./maintenance.md): Git workflow, context hygiene, document lifecycle, research policy, and automation.
- [P2P WebRTC research](./research/webrtc-p2p-screen-sharing.md): evidence, bandwidth model, browser constraints, reference implementations, and feasibility assessment.
- [Peer-assisted media research](./research/peer-assisted-media.md): browser shared-encode limits, standard relay re-encoding, deterministic sticky topology, runtime relay-capacity extension, and abandon gates.
- [Low-server-cost media routes](./research/low-server-media-routes.md): traffic accounting, route screening, token-free SFU standby prewarm, conditional native encoded-RTP relay, and automatic final fallback.
- [Advanced peer distribution](./research/advanced-peer-distribution.md): multi-tree/SVC, encoded-object relay, native RTP forwarding, FEC/network-coding, MoQ, and measurable go/no-go gates.
- [Native shared-encode sender](./research/native-shared-encode-sender.md): bounded libwebrtc encoder-proxy risk spike, Draft PR #16's transport-only Pion fanout oracle, and hard failure gates.
- [Realtime quality adaptation](./research/realtime-quality-adaptation.md): browser degradation policy, live profile changes, offline-encoding boundaries, and measurement gates.
- [Browser screen-audio quality](./research/browser-screen-audio-quality.md): capture/source compatibility, standard readback limits, Opus negotiation boundaries, and the retained no-control decision.
- [Agent context governance research](./research/agent-context-governance.md): official Codex, Claude Code, Hermes Agent, and GitHub practices adopted by this repository.
- [ADR-0001](./adr/0001-p2p-first-media-topology.md): accepted P2P-first media topology and its consequences.
- [ADR-0002](./adr/0002-persistent-protected-rooms.md): optional SQLite persistence, protected sequential room IDs, and room lifecycle.
- [ADR-0004](./adr/0004-peer-assisted-media-experiment.md): proposed, experiment-only standard-WebRTC peer-assisted spike with hard fanout and failure gates.
- [ADR-0005](./adr/0005-automatic-hybrid-media-routing.md): proposed, default-off automatic P2P/peer/SFU preparation, token-free standby prewarm, commit, failback, and rollback with a hard host-edge budget.

Documentation and project memory are part of the product source of truth. Update them in the same change that alters the corresponding requirement or architecture.
