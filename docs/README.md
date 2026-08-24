# Project Documentation

- [需求理解](./需求理解.md): current product scope, priorities, constraints, and acceptance criteria.
- [方案设计](./方案设计.md): accepted implementation design; unfinished release and validation work is tracked in the current TODO ledger.
- [Project memory](./project-memory.md): durable current product and source snapshot to read at the start of future work.
- [Current status](./status.md): bounded current/index snapshot of production, active milestones, decisions, blockers, and links to detail.
- [Verification status](./verification-status.md): exact integrated/deployed v11 gates, current production evidence, open physical proof boundaries, and expensive-test applicability.
- [Session handoff](./session-handoff.md): temporary bootstrap prompt that points a new session back to the canonical truth owners.
- [Current TODO](./todo.md): unresolved work, active truth holds, and decisions that still require user confirmation.
- [Deployment](./deployment.md): exact current v11 production, immutable release operations, scoped recovery rules, and transport evidence boundaries.
- [Maintenance guide](./maintenance.md): Git workflow, context hygiene, document lifecycle, research policy, and automation.
- [P2P WebRTC research](./research/webrtc-p2p-screen-sharing.md): evidence, bandwidth model, browser constraints, reference implementations, and feasibility assessment.
- [Peer-assisted media research](./research/peer-assisted-media.md): browser shared-encode limits, standard relay re-encoding, deterministic sticky topology, exact-route implementation evidence, and remaining physical gates.
- [Low-server-cost media routes](./research/low-server-media-routes.md): Host-publication/SFU distribution, route diagnostics, direct-to-SFU conclusion, hop-level accounting, privacy-safe ICE evidence, and bounded transport gates.
- [Built-in peer ICE TURN candidate](./research/built-in-peer-ice-turn.md): historical evidence for the rejected participant-wide and selected-edge TURN candidates.
- [Advanced peer distribution](./research/advanced-peer-distribution.md): generic local-reconcile evidence plus multi-tree/SVC, encoded-object relay, native RTP forwarding, FEC/network-coding, and MoQ gates.
- [Native shared-encode sender](./research/native-shared-encode-sender.md): consolidated Draft #16/#18/#22/#23/#25/#28 ladder, unclassified product-gate failure, staged revalidation, and stop line.
- [Native H.264 hardware decision](./research/native-h264-hardware-decision.md): bounded WebCodecs no-go, proved Media Foundation/NVIDIA hardware encode, the default-fmtp `42c01f` stop, and the retained interop boundary.
- [Native H.264 opt-in path](./research/native-h264-opt-in-path.md): explicit H.264 sender mode, exact Pion profile registration, and one bounded Host/Viewer loopback with hardware caveats.
- [Realtime quality adaptation](./research/realtime-quality-adaptation.md): fixed Browser VP8/no-video-hint evidence, manual quality ceilings, diagnostic-only capture/send/receive correlation, path-isolated dual representations, and bounded simulcast/Dynacast/SVC checks.
- [Browser background capture diagnostics](./research/browser-background-capture.md): browser lifecycle evidence, a privacy-bounded capture/send/receive experiment, interpretation gates, and non-goal keepalive mechanisms.
- [Browser screen-audio quality](./research/browser-screen-audio-quality.md): capture/source compatibility, live sender-ceiling readback, Opus negotiation boundaries, and remaining audible/device evidence.
- [Display name and presence boundaries](./research/display-name-presence.md): browser-local storage failure behavior, Unicode normalization, control-character policy, and the Web-only presence capability boundary.
- [Agent context governance research](./research/agent-context-governance.md): official Codex, Claude Code, Hermes Agent, and GitHub practices adopted by this repository.
- [ADR-0001](./adr/0001-p2p-first-media-topology.md): historical P2P-first baseline; later access and automatic-routing decisions supersede its stale current-state details.
- [ADR-0002](./adr/0002-memory-resident-protected-rooms.md): four-digit leased in-memory rooms, local Host defaults, scoped Viewer grants, and orthogonal code entry.
- [ADR-0004](./adr/0004-peer-assisted-media-experiment.md): historical standard-WebRTC peer-assisted experiment and reusable evidence.
- [ADR-0005](./adr/0005-automatic-hybrid-media-routing.md): accepted and deployed P2P-first single-reconcile route model; remaining real-network validation is tracked in verification status.
- [ADR-0006](./adr/0006-fixed-high-native-sender-canary.md): proposed fixed-`HIGH` native canary, current no-go result, and staged revalidation boundary.
- [ADR-0007](./adr/0007-demand-driven-dual-representation-quality.md): accepted path-isolated `HIGH + at most one LOW` policy, optional idle-layer stop, evidence contract, and SVC boundary.
- [ADR-0008](./adr/0008-window-scoped-audio-capture.md): browser window-audio hint and the Windows WASAPI process-loopback boundary.

Documentation and project memory are part of the product source of truth. Update them in the same change that alters the corresponding requirement or architecture.
