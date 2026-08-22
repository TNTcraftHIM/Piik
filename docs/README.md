# Project Documentation

- [需求理解](./需求理解.md): current product scope, priorities, constraints, and acceptance criteria.
- [方案设计](./方案设计.md): current implementation design; routing capacity and fallback accounting are temporarily frozen by the truth-audit hold.
- [Project memory](./project-memory.md): durable decisions and unresolved questions to read at the start of future work.
- [Current status](./status.md): bounded current/index snapshot of production, active milestones, decisions, blockers, and links to detail.
- [Verification status](./verification-status.md): demand-loaded ledger of current cross-cutting evidence, open proof boundaries, and expensive-test applicability.
- [TODO execution audit hold](./todo-audit-hold.md): temporary quarantine for disputed post-boundary work, experiments, and stale assumptions while the 2026-08-22 truth audit is open.
- [Workspace disposition](./workspace-disposition.md): demand-loaded worktree, branch, folder, junction, and archive schedule for restoring one canonical `main` root.
- [Deployment](./deployment.md): exact current/rollback production configuration, release operations, and transport evidence boundaries.
- [Maintenance guide](./maintenance.md): Git workflow, context hygiene, document lifecycle, research policy, and automation.
- [P2P WebRTC research](./research/webrtc-p2p-screen-sharing.md): evidence, bandwidth model, browser constraints, reference implementations, and feasibility assessment.
- [Peer-assisted media research](./research/peer-assisted-media.md): browser shared-encode limits, standard relay re-encoding, deterministic sticky topology, runtime relay-capacity extension, and abandon gates.
- [Low-server-cost media routes](./research/low-server-media-routes.md): SFU-root/peer distribution, selected-edge TURN, hop-level accounting, privacy-safe ICE evidence, and bounded transport gates.
- [Built-in peer ICE TURN candidate](./research/built-in-peer-ice-turn.md): rejected canary record, retained standards/resource findings, and the selected-edge replacement boundary.
- [Advanced peer distribution](./research/advanced-peer-distribution.md): multi-tree/SVC, encoded-object relay, native RTP forwarding, FEC/network-coding, MoQ, and measurable go/no-go gates.
- [Native shared-encode sender](./research/native-shared-encode-sender.md): consolidated Draft #16/#18/#22/#23/#25/#28 ladder, unclassified product-gate failure, staged revalidation, and stop line.
- [Native H.264 hardware decision](./research/native-h264-hardware-decision.md): bounded WebCodecs no-go, proved Media Foundation/NVIDIA hardware encode, the default-fmtp `42c01f` stop, and the retained interop boundary.
- [Native H.264 opt-in path](./research/native-h264-opt-in-path.md): explicit H.264 sender mode, exact Pion profile registration, and one bounded Host/Viewer loopback with hardware caveats.
- [Realtime quality adaptation](./research/realtime-quality-adaptation.md): correlated capture/send/receive diagnosis, production generation-rebuild gate, path-isolated dual representations, and bounded simulcast/Dynacast/SVC checks.
- [Browser screen-audio quality](./research/browser-screen-audio-quality.md): capture/source compatibility, standard readback limits, Opus negotiation boundaries, and the retained no-control decision.
- [Display name and presence boundaries](./research/display-name-presence.md): browser-local storage failure behavior, Unicode normalization, control-character policy, and the Web-only presence capability boundary.
- [Agent context governance research](./research/agent-context-governance.md): official Codex, Claude Code, Hermes Agent, and GitHub practices adopted by this repository.
- [ADR-0001](./adr/0001-p2p-first-media-topology.md): historical P2P-first baseline; later access and automatic-routing decisions supersede its stale current-state details.
- [ADR-0002](./adr/0002-persistent-protected-rooms.md): site access, room-scoped private Viewer grants, explicit public-watch, rotation, and minimal SQLite persistence.
- [ADR-0004](./adr/0004-peer-assisted-media-experiment.md): proposed, experiment-only standard-WebRTC peer-assisted spike with hard fanout and failure gates.
- [ADR-0005](./adr/0005-automatic-hybrid-media-routing.md): accepted automatic P2P-first direction and generation safety; capacity and fallback accounting are on truth-audit hold.
- [ADR-0006](./adr/0006-fixed-high-native-sender-canary.md): proposed fixed-`HIGH` native canary, current no-go result, and staged revalidation boundary.
- [ADR-0007](./adr/0007-demand-driven-dual-representation-quality.md): accepted path-isolated `HIGH + at most one LOW` policy, optional idle-layer stop, evidence contract, and SVC boundary.
- [ADR-0008](./adr/0008-window-scoped-audio-capture.md): browser window-audio hint and the Windows WASAPI process-loopback boundary.

Documentation and project memory are part of the product source of truth. Update them in the same change that alters the corresponding requirement or architecture.
