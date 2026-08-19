# Project Memory

Last updated: 2026-08-19

## Confirmed Intent

- Build low-latency game sharing for one broadcaster and trusted friends; public or large broadcasts belong on OBS/Twitch-class services.
- Viewers join from normal desktop/mobile browsers. A later native sender may share encoding and improve capture/audio without changing the Web viewer requirement.
- Use a small central service for access, rooms, signaling, deterministic topology, STUN, observability, and bounded SFU-root capacity; TURN is optional extreme-network transport.
- Minimize server bandwidth. The accepted invisible ladder is direct/peer UDP, then SFU/UDP roots, then optional TURN for a selected exceptional edge, then bounded failure. TURN is transport, not topology.
- Non-server nodes have at most two downstream edges; browser relays stay at one until resource gates pass. SFU normally feeds one or two roots that retain peer descendants; separately capped server edges may serve exceptional viewers that cannot attach behind a healthy root.
- Two-tree packet/layer striping may reduce endpoint upload toward one stream bitrate, but needs a bounded multi-parent, loss, sync, churn, and latency experiment; it is not in the current full-stream chains.
- Flagship native media encodes each active representation once and reuses it across direct, peer, and SFU transports; per-connection packetization, pacing, encryption, feedback, and upload remain independent. Healthy rooms have one shared `HIGH`; verified weak paths may add one shared on-demand `LOW`, never per-viewer encoders. Standard Web P2P simulcast and pinned LiveKit 1.13.5/JS 2.22.0 Dynacast are static no-go paths for that exact selection policy; SVC is next and has no software fallback.
- Separate abuse control from watching: production Host admission protects room creation/Host role, while a default private capability grants Viewer access to one room; public-watch is explicit. Keep raw grants out of localStorage/cookies/query/logs/SQLite; retain no account, ACL, user, or session table.
- Keep decisions, snapshots, research, code, `AGENTS.md`, and `.codex/` in Git; rewrite memory/status in place. Research current primary sources before material work and reject speculative machinery.
- Migrate client, server, and deployment atomically. After a canary, delete superseded config/wire/parsers/tests; do not retain compatibility layers, dual writes, or a second architecture without a current consumer. Git history owns the old implementation.

## Current Recommendation

- Keep desktop Chrome/Edge and the responsive Web viewer as the baseline. Validate Android Chrome and iOS Safari as leaves.
- Use direct host P2P for one or two viewers. Keep ADR-0004 off broadly; use an isolated exact-room candidate until resource, quality, recovery, SFU/UDP, bounded-failure, and browser/mobile gates pass.
- Browser relays resend remote `MediaStreamTrack` values and re-encode at each hop; WebRTC does not guarantee a shared encoder across peer connections, so measure the cost.
- Keep experiments bounded: the standard representation sequence is below; native RTP relay, encoded-object striping, and FEC remain separate.
- ADR-0006's fixed-`HIGH` canary reached host setup and one encoder output but retained no downstream checkpoint before the first-viewer timeout. It is no-go-unclassified; no native product code is accepted, and any revisit starts at its staged evidence gate.
- ADR-0005 accepts SFU roots as the primary central fallback after direct/peer UDP. The candidate has no TURN consumer or credential wire; any future exceptional-edge grant is a complete separate change. PR #12 is superseded.
- Keep the failure-only controller default-off until the isolated STUN/SFU exact-room gates pass. Preserve break-before-make, sticky healthy subtrees, mobile leaves, and PR #20 prewarm; public transport/load remains open.
- Local reparenting is a later candidate: start with unassigned relay admission rescue; do not block current work.
- Flagship media is UDP; HTTPS/WSS stays TLS/TCP. Old production retains coturn TURN for rollback. The candidate uses self-hosted STUN-only ordinary ICE and separate LiveKit SFU/UDP, with no TURN/media-TCP wire.
- Treat settings as ceilings and deployed degradation as unclassified. Use correlated Host A+B/Viewer C to compare exact `769de201f7cc` against current `main` for Host-only recovery, game FPS/load, preview cost, actual codec/encoder and one-variable rebuilds; then gate SVC before custom `LOW`. Never use UA or a composite score.
- Production reports poor film audio and self-echo when system capture includes voice software. Diagnose audio A/B/C and sync; Web cannot isolate arbitrary processes and `maxBitrate` is not quality-up. A Windows 11 native candidate defaults to game-process-tree audio and never widens silently; Windows 10 remains unresolved/unsupported. See `docs/research/browser-screen-audio-quality.md`.
- Candidate UI has local Viewer volume/mute, copyable room codes, and a favicon. Names/roster, endpoint details, and RTP loss remain pending; no wire, media, or routing effects.
- Do not add scene detection, dynamic-FPS control, or forced AV1 until stats and target hardware prove the need. Codec acceptance requires actual negotiation, power-efficient candidate evidence, interval encode cost, game FPS, CPU/GPU and sender count; Discord's native capture/hardware tuning is comparison evidence, not proof of server re-encoding or a reusable preset.
- After the current media acceptance boundary, migrate access atomically under amended ADR-0002: `HOST_ADMISSION_PASSWORD`, `screener-v2`, default private fragment grants, optional public-watch, rotate/revoke, and one nullable SQLite digest column. Do not mix username/roster runtime into that PR.
- Deferred architecture audit: `docs/maintenance.md`.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production `769de201f7cc` at `https://share.bonfire.icu` has equal entry actions, default-closed details, bounded clarity-first quality, live source/quality changes, pause, and sender warnings.
- Production still uses one host `RTCPeerConnection` per viewer because peer assistance and LiveKit are unconfigured; above two viewers it still exceeds the target host-edge budget. Its real game-capture quality/pause cycle remains unverified.
- Current production/repository runtime still uses optional `ACCESS_PASSWORD`, a 12-hour stateless HMAC HttpOnly Strict cookie for both roles, internal Host token, role-bound signaling, Origin/payload checks, and no accounts/JWT/session map.
- Current SQLite still stores only room ID and Host-token digest; room `1` survived deployment. The accepted Viewer-grant digest/schema v2 design is documentation-only and not deployed.
- Production uses nginx, Node.js 24.19.0, and authenticated coturn 4.17.2 at `turn.bonfire.icu:3478`; public STUN, TURN/UDP, TURN/TCP, and relay-only traffic pass. TURN/TLS is off.
- Candidate migration is process-wide: ordinary ICE is STUN-only; coturn uses `stun-only`/`no-tcp`/`no-tls` without deprecated `no-dtls`; LiveKit 1.13.5 explicitly disables TCP fallback, uses deployment STUN and separate UDP participant ICE. Old TURN parser/signer/refresh/UI/SNI artifacts are gone; old production is isolated rollback.
- The default-off ADR-0005 controller has no production peer/SFU configuration. Enabling it requires non-empty exact `PEER_ASSISTED_ROOM_IDS`; missing/blank fails startup and unlisted rooms use current ordinary P2P. `screener-v1` is the single signaling literal; mismatch terminates once with a refresh prompt.
- When enabled, peer recovery precedes allowlisted SFU; session revisions prepare/commit/abort and active SFU gets one token refresh before failback. Browser relays re-encode; native sharing is outside product code.
- Chrome 151/LiveKit localhost A/B cut failure-to-active/render from 1.481/2.257 seconds to 0.200/0.320; 31 new frames and 25 ms sampling kept host edges at two. It is headless synthetic 720p30 and includes SDK/network prewarm, not public-network evidence.
- Native drafts #16/#18/#22/#23/#25/#28 remain experiments: one WebCodecs object is not hardware proof; stock GCC+RTX is no-go, and no-RTX remains outside product code.
- Chrome 151 synthetic topology/quality-control runs kept fanout 2/1 and all viewers decoding; one relay close recovered in 5.32 seconds. This is control evidence only.
- Quality controls remain ceilings with diagnostics. ADR-0007's per-path `HIGH`/`FALLBACK`, one on-demand shared `LOW`, and controller are unimplemented. Web P2P simulcast lacks receiver RID selection and LiveKit Dynacast cumulatively enables `LOW`; both are static no-go results without Chrome or resource-release claims. SFU publishing remains non-simulcast with Dynacast off; SVC is next.
- Local Host A+B aligns capture with one unique outbound RTP/remote/transport pair and rejects ambiguous or stale generations. Authenticated Viewer C now adds a nullable, sanitized two-second receive window of at most 2 KiB for each current ordinary or peer-assisted P2P hop; the server derives identity and current connection/revision, and the parent correlates only matching local B. It retains no raw fmtp/SDP/stats, performs no media action, and fails closed for SFU-fed roots. Automatic control and `LOW` remain absent.

## Provisional Quality Targets

- Controlled direct path at RTT no more than 40 ms and loss no more than 1%: glass-to-glass p50 no more than 150 ms and p95 no more than 250 ms.
- Regional SFU/UDP roots under the same endpoint conditions: glass-to-glass p95 no more than 350 ms; optional TURN is measured separately.
- First picture within 3 seconds after a watch request, excluding explicit permission time.
- A 60 fps profile must not remain below 50 decoded fps for more than 5 seconds without a visible downgrade or limiting reason.

These are measurement gates, not performance claims.

## Open Decisions

- Sustainable count by hardware, quality, network, and route: finish instrumented `1/3/5/8`, then pass a 20-viewer matrix before changing the accepted target default to 20.
- Whether ADR-0004 passes fanout, re-encoding, depth-four latency, reparenting, silent-partition, and mobile-leaf gates.
- Whether measured restrictive-network demand justifies a future selected-edge TURN grant at all, and which UDP transport/port it would use. The current candidate does not retain dormant TURN or media-TCP configuration.
- Exact mobile lifecycle behavior and whether Windows per-application audio is required for the first release.
- Project license and distribution model, which determines whether GPL/AGPL sources can move beyond study-only use.
- Initial deployment regions and expected mainland China, Hong Kong, and overseas network mix.
- Whether voice chat ever enters scope or Screener stays complementary to an existing voice application.
- Exact evidence thresholds/windows and the native hardware matrix for ADR-0007; #28's minimum-of-two rule is not a candidate.

## Source Of Truth

- Documentation index and current phase: `docs/README.md` and `docs/status.md`
- Requirements and design: `docs/需求理解.md` and `docs/方案设计.md`
- Media research: `docs/research/`, indexed by `docs/README.md`
- Architecture: ADR-0001/0002, proposed ADR-0004, accepted-but-unverified ADR-0005, no-go proposed ADR-0006, accepted ADR-0007, and rejected/superseded ADR-0003
- Deployment and maintenance: `docs/deployment.md`, `docs/maintenance.md`, `AGENTS.md`, and `.codex/`
