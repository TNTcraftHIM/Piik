# Project Documentation

- [需求理解](./需求理解.md): current product scope, priorities, constraints, and acceptance criteria.
- [方案设计](./方案设计.md): accepted, code-ready design for the first measurable WebRTC proof of concept.
- [Project memory](./project-memory.md): durable decisions and unresolved questions to read at the start of future work.
- [Current status](./status.md): bounded snapshot of the current phase, completed baseline, next step, and blockers.
- [Deployment](./deployment.md): minimal Node, HTTPS/WSS, coturn, optional single-node LiveKit, firewall, secret, and network-verification procedures.
- [Maintenance guide](./maintenance.md): Git workflow, context hygiene, document lifecycle, research policy, and automation.
- [P2P WebRTC research](./research/webrtc-p2p-screen-sharing.md): evidence, bandwidth model, browser constraints, reference implementations, and feasibility assessment.
- [LiveKit SFU research](./research/livekit-sfu-media-mode.md): current upstream versions, license, single-node network shape, Screener integration boundary, privacy, and measurement gate.
- [Agent context governance research](./research/agent-context-governance.md): official Codex, Claude Code, Hermes Agent, and GitHub practices adopted by this repository.
- [ADR-0001](./adr/0001-p2p-first-media-topology.md): accepted P2P-first media topology and its consequences.
- [ADR-0002](./adr/0002-persistent-protected-rooms.md): optional SQLite persistence, protected sequential room IDs, and room lifecycle.
- [ADR-0003](./adr/0003-explicit-sfu-media-mode.md): explicit deployment-level `p2p|sfu` choice with P2P default and no automatic or hybrid switching.

Documentation and project memory are part of the product source of truth. Update them in the same change that alters the corresponding requirement or architecture.
