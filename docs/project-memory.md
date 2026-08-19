# Project Memory

Last updated: 2026-08-19

## Confirmed Intent

- Build low-latency game screen sharing for one broadcaster and a small trusted group; public or large broadcasts belong on OBS/Twitch-class services.
- Viewers join from normal desktop/mobile browsers. A later native sender may share encoding and improve capture/audio without changing the Web viewer requirement.
- Use a small central service for access, rooms, signaling, deterministic topology, STUN, observability, and bounded SFU-root capacity; TURN is optional extreme-network transport.
- Minimize server bandwidth. The accepted invisible ladder is direct/peer UDP, then SFU/UDP roots, then optional TURN for a selected exceptional edge, then bounded failure. TURN is transport, not topology.
- Non-server nodes have at most two downstream edges; browser relays stay at one until resource gates pass. SFU normally feeds one or two roots that retain peer descendants; separately capped server edges may serve multiple exceptional viewers that cannot attach behind a healthy root. Native/object paths should reuse one encode while browsers re-encode.
- Two-tree packet/layer striping may reduce endpoint upload toward one stream bitrate, but needs a bounded multi-parent, loss, sync, churn, and latency experiment; it is not in the current full-stream chains.
- Shared encoding reduces compute, not each viewer's last-hop copy. Automatic quality uses one active `HIGH` representation plus at most one on-demand `LOW`; all verified weak paths share `LOW` and recovery stops its bytes/frames. This does not prove one/two physical encoders or GPU release. An over-budget media path fails closed for that attempt while protecting `HIGH`, but a supported cohort that cannot start `LOW` reliably fails acceptance. SVC has no software fallback.
- Keep decisions, snapshots, research, code, `AGENTS.md`, and `.codex/` in Git; rewrite memory/status in place. Research current primary sources before material work and reject speculative machinery.

## Current Recommendation

- Keep desktop Chrome/Edge and the responsive Web viewer as the baseline. Validate Android Chrome and iOS Safari as leaves.
- Use direct host P2P for one or two viewers. Keep ADR-0004 off broadly; use an exact-room canary until resource, quality, recovery, SFU/UDP, optional-TURN, and browser/mobile gates pass.
- Browser relays resend remote `MediaStreamTrack` values and re-encode at each hop; WebRTC does not guarantee a shared encoder across peer connections, so measure the cost.
- Keep browser experiments bounded; spike native RTP relay, encoded-object striping, SVC, and FEC separately.
- ADR-0006 retains a fixed-`HIGH` native canary boundary, but its sole product-wiring run reached only host setup and one encoder output before the first-viewer decoded/rendered gate timed out. Downstream checkpoints were not retained, so the result is no-go-unclassified, not a diagnosed product bug. No native product code is accepted; revisit only through the staged evidence gate.
- ADR-0005 accepts SFU roots as the primary central fallback after direct/peer UDP, never default whole-room fanout. Optional TURN is issued only to an exceptional assigned edge; PR #12 is superseded.
- Keep the current failure-only controller default-off until config migration and exact-room gates pass. Preserve break-before-make, sticky healthy subtrees, mobile leaves, and PR #20 prewarm; public transport/load remains open.
- Local reparenting is a later candidate: start with unassigned relay admission rescue; do not block current work.
- Flagship media defaults to UDP; HTTPS/WSS remains TLS/TCP. Current production still requires coturn UDP/TCP. Future TURN absence is normal, partial config fails, and any media-TCP/port compatibility mode is chosen only by canary.
- Treat video settings as ceilings and degradation as unclassified. Local host A+B now covers same-tick capture/outbound identity, windows, deltas, remote linkage, path, and nullable negotiated codec/profile token/allowlisted parameters/current stream `scalabilityMode`. Use it first to reproduce the reported Host-only recovery, then add minimal authenticated C and test standard simulcast/LiveKit/SVC before custom `LOW`; this need not wait for ADR-0006. Never use UA or a composite score.
- Reported poor movie/video audio is unclassified. After video A+B, separately diagnose audio A/B/C and A/V sync across capture settings, codec/fmtp, actual bitrate, loss, jitter, concealment, and jitter buffer. `maxBitrate` is not quality-up; do not expand runtime before evidence. See `docs/research/browser-screen-audio-quality.md`.
- Do not add custom scene detection or dynamic-FPS control until WebRTC statistics and host resource measurements prove a material gap. Keep browser codec order until target hardware proves a more efficient common codec.
- Keep room policy deployment-driven: public/password-only rooms are random and temporary; password plus SQLite enables sequential persistent rooms and reusable stopped links.
- Deferred architecture audit: `docs/maintenance.md`.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production `769de201f7cc` at `https://share.bonfire.icu` has equal entry actions, default-closed details, bounded clarity-first quality, live source/quality changes, pause, and sender warnings.
- Production still uses one host `RTCPeerConnection` per viewer because peer assistance and LiveKit are unconfigured; above two viewers it still exceeds the target host-edge budget. Its real game-capture quality/pause cycle remains unverified.
- Access uses optional `ACCESS_PASSWORD`, a 12-hour stateless HMAC HttpOnly Strict cookie, internal host token, role-bound signaling, Origin/payload checks, and no accounts/JWT/session map.
- With `ROOM_DATABASE_PATH` and the password, SQLite stores room ID and host-token digest; links persist and room `1` survived deployment. Without it, rooms are temporary.
- Production uses nginx, Node.js 24.19.0, and authenticated coturn 4.17.2 at `turn.bonfire.icu:3478`; public STUN, TURN/UDP, TURN/TCP, and relay-only traffic pass. TURN/TLS is off.
- The default-off ADR-0005 controller has no production peer/SFU configuration. `PEER_ASSISTED_ROOM_IDS` restricts exact canary rooms; unlisted rooms stay P2P and empty/missing means all.
- When enabled, peer recovery precedes allowlisted SFU; session revisions prepare/commit/abort and active SFU gets one token refresh before failback. Browser relays re-encode; native sharing is outside product code.
- Chrome 151/LiveKit localhost A/B cut failure-to-active/render from 1.481/2.257 seconds to 0.200/0.320; 31 new frames and 25 ms sampling kept host edges at two. It is headless synthetic 720p30 and includes SDK/network prewarm, not public-network evidence.
- Draft native ladder #16/#18/#22/#23/#25/#28 has one bounded Chrome 720p30 loop: one WebCodecs object feeds two Pion/browser legs, applies an experiment-only minimum stock-GCC target, and recovers one isolated loss. It does not prove one hardware encode.
- Stock Pion GCC plus negotiated RTX is a no-go. The no-RTX candidate can distort loss statistics and stays outside product code until audio, heterogeneous estimates, broader loss, TURN/reconnect, and browser-diversity gates pass; do not add custom congestion control to bypass them.
- Chrome 151 short synthetic `1/3/5/8` runs kept host edges at two, relay edges at one, and all viewers decoding; a three-viewer relay close recovered in 5.32 seconds. This proves topology/control only, not quality, load, endurance, or silent partitions.
- The current quality stack uses one strict, non-persistent `QualitySettings` value with bounded ceilings and clarity/balanced/fluid preference. Sender readback and limitation warnings remain manual diagnostics. ADR-0007's automatic per-path `HIGH`/`FALLBACK` and unique on-demand shared `LOW` are accepted mainline behavior, but the C report, state controller, and `LOW` runtime are unimplemented.
- Chrome 151 synthetic 720p30 propagated balanced/clarity to one host and three viewers without changing peer identities; all viewers kept decoding and fanout stayed host two/relay one. This proves control continuity only.
- Local host A+B binds capture settings to one uniquely matched outbound RTP stream in the same tick, follows `remoteId` and the RTP-specific transport/candidate pair, and blocks stale generations across source replacement. Adjacent `getStats()` deltas rebase on first, empty, ambiguous, changed-identity, or reset intervals. The same RTP's transport-bound codec supplies only nullable MIME, self-describing profile token, allowlisted format parameters, and current stream `scalabilityMode`; this diagnostic adds no upload or persistence of raw fmtp/SDP/stats, defaults are not inferred, profile tokens imply no quality/hardware/support conclusion, and multiple RTP/encodings remain unknown. Authenticated C, automatic control, and `LOW` remain unimplemented.
- Release `769de201f7cc` passed CI/hygiene/typecheck, 22 files/274 tests, both builds, zero production dependency vulnerabilities, atomic activation, public health/access, exact bundle, and service/log checks.

## Provisional Quality Targets

- Controlled direct path at RTT no more than 40 ms and loss no more than 1%: glass-to-glass p50 no more than 150 ms and p95 no more than 250 ms.
- Regional SFU/UDP roots under the same endpoint conditions: glass-to-glass p95 no more than 350 ms; optional TURN is measured separately.
- First picture within 3 seconds after a watch request, excluding explicit permission time.
- A 60 fps profile must not remain below 50 decoded fps for more than 5 seconds without a visible downgrade or limiting reason.

These are measurement gates, not performance claims.

## Open Decisions

- Sustainable viewer count by broadcaster and relay hardware, quality profile, network class, and media route; use instrumented 1/3/5/8 comparisons rather than a 1:8 claim.
- Whether ADR-0004 passes fanout, re-encoding, depth-four latency, reparenting, silent-partition, and mobile-leaf gates.
- Which optional TURN/media-TCP transport and port, if any, survives ADR-0005's public UDP-first canary; current LiveKit ICE/TCP/coturn stays until migration passes.
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
