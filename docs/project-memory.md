# Project Memory

Last updated: 2026-08-20

## Confirmed Intent

- Build low-latency game sharing for one broadcaster and trusted friends; public or large broadcasts belong on OBS/Twitch-class services.
- Viewers join from normal desktop/mobile browsers. A later native sender may share encoding and improve capture/audio without changing the Web viewer requirement.
- Use a small central service for access, rooms, signaling, deterministic topology, STUN, observability, and bounded SFU-root capacity.
- Minimize server bandwidth. Ordinary peer ICE is STUN-only. Failure tries restart, rebuild, alternate peer and bounded SFU/UDP roots; only then may the controller authorize short-lived TURN for one selected exceptional edge before clear failure. TURN is transport, not topology.
- Non-server nodes have at most two downstream edges; browser relays stay at one until resource gates pass. SFU normally feeds one or two roots that retain peer descendants; separately capped server edges may serve exceptional viewers that cannot attach behind a healthy root.
- Two-tree packet/layer striping may reduce endpoint upload toward one stream bitrate, but needs a bounded multi-parent, loss, sync, churn, and latency experiment; it is not in the current full-stream chains.
- Direct/peer keeps per-PC stock GCC. SFU paths start at a `HIGH` ceiling and share at most one `LOW`; next test LiveKit exactly-two built-in BWE on zero-descendant leaves. If it passes, no app media selector is built. Explicit quality, manual activation, then custom/native are later fallbacks; always-on `LOW` needs resource gates.
- A later explicit quality fallback evacuates children under a generation guard first. Autonomous BWE enters `suspect`; confirmation evacuates children, and no confirmed `FALLBACK` parent remains. Root-with-children impact is a default-on gate; capacity returns after longer recovery plus cooldown. Self-report alone never triggers it.
- Separate abuse control from watching: Host admission protects creation/Host; private Viewer entry uses a room grant or optional room password, while public-watch accepts the code. Persist neither raw credential; keep accounts, ACLs, users, and session tables out.
- Keep decisions, snapshots, research, code, `AGENTS.md`, and `.codex/` in Git; rewrite memory/status in place. Research current primary sources before material work and reject speculative machinery.
- Migrate client, server, and deployment atomically. After a canary, delete superseded config/wire/parsers/tests; do not retain compatibility layers, dual writes, or a second architecture without a current consumer. Git history owns the old implementation.
- Autonomously deploy each coherent low-risk milestone after narrow tests, independent review, one full gate, CI and rollback preflight. Keep protocol/database migrations atomic rather than folding them into routine UI/media updates.

## Current Recommendation

- Keep desktop Chrome/Edge and the responsive Web viewer as the baseline. Validate Android Chrome and iOS Safari as leaves.
- Use direct host P2P for one or two viewers. Keep ADR-0004 off broadly; use an isolated exact-room candidate until resource, quality, recovery, SFU/UDP, bounded-failure, and browser/mobile gates pass.
- Browser relays resend remote `MediaStreamTrack` values and re-encode at each hop; WebRTC does not guarantee a shared encoder across peer connections, so measure the cost.
- Keep experiments bounded: the standard representation sequence is below; native RTP relay, encoded-object striping, and FEC remain separate.
- ADR-0006 remains no-go for expansion. A Chrome 151 loopback proves fixed VP8 WebCodecs -> Go RTP -> one 1280x720 Viewer: 30 sender frames/85 source RTP packets, 877 inbound packets, 299 decoded and rendered, no fatal. Pion outbound delta was not retained because its 2-second diagnostics snapshot did not refresh. Hardware, multi-viewer/FIFO, endurance, public-network, and packaged-native proof remain open. Source fixes timestamp overlap from nullable duration; the separate MF RTX fixture still misses Pion fmtp. Native v2 remains memory-only and leaves SQLite/Web unchanged.
- Mobile Web Host is unsupported; feature-detect and fail clearly. Mobile Viewer stays leaf-only. After Windows native, gate Android 14+; iOS waits for stable iOS 27 ScreenCaptureKit.
- ADR-0005 accepts direct/peer UDP, bounded SFU roots, then optional selected-edge TURN. Source has a default-off, undeployed one-shot rebuild after SFU; participant-wide TURN remains rejected and production stays STUN-only.
- Keep the controller exact-room only: room `1` is the STUN/SFU smoke. Preserve sticky progressing P2P, mobile leaves and break-before-make. Recovery spends one attempt per layer (ICE restart, same-parent rebuild, alternate peer, then SFU), never three identical retries; active SFU gets one fresh grant before Peer failback.
- C+B quality reparenting is edge-local and cooldown-bound; no score, timer, or global parent penalty.
- Flagship media is UDP; HTTPS/WSS stays TLS/TCP; the old release remains rollback-only.
- Treat settings as ceilings and degradation as unclassified. Use correlated Host A+B/Viewer C and one-variable evidence; never force AV1, infer by UA, or create a composite score.
- Production reports poor film audio and self-echo when system capture includes voice software. Diagnose audio A/B/C and sync; Web cannot isolate arbitrary processes and `maxBitrate` is not quality-up. A Windows 11 native candidate defaults to game-process-tree audio and never widens silently; Windows 10 remains unresolved/unsupported. See `docs/research/browser-screen-audio-quality.md`.
- Viewer-local names and the opt-in Web participant roster remain control-plane-only. The Web Host name change is source-only after its failed activation; names stay socket/localStorage-only, and Native remains outside the capability boundary.
- Do not add scene detection, dynamic-FPS control, or forced AV1 without negotiation, encode, game, CPU/GPU, and sender evidence.
- ADR-0002 grant/public access and the v3 room-password migration are deployed; Host display-name remains source-only. Names/presence remain session-only without account or roster tables.
- Deferred architecture audit: `docs/maintenance.md`.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production currently serves `fdd14ba0d9b5ea4c43aa0f6a3a29e0eacf182612` at `https://share.bonfire.icu` after automatic rollback from the attempted `61a87ae47e38abc943cef47b3d7318bb51bf86d6` Host display-name activation. Health is 200; SQLite v3 retains four rooms including room `1`. Room `1` alone enables peer/SFU routing, C+B local reparenting, and admission rescue; unlisted rooms remain ordinary P2P. The preceding `31bee238` release remains historical rollback evidence.
- The `61a87ae` artifact was prepared but the ephemeral wrapper omitted `mv` from `RELEASE_PREPARED` into `release`, producing systemd `status=200/CHDIR`; this was an activation-wrapper failure, not an application or database failure. Screener `NRestarts=31` reflects the attempt; LiveKit, coturn, and nginx were 0. Selected-edge TURN remains disabled.
- Production ICE is STUN-only; stale `PEER_ICE_TURN_*` keys fail startup even blank. Source has a default-off coturn REST rebuild for the original failed Host/ViewerRelay edge after Viewer-root SFU exhaustion; it is undeployed/unverified and production advertises no TURN credential.
- Production requires an independent `HOST_ADMISSION_PASSWORD` only for creation/Host role. Default private fragment grants, room passwords, and explicit public-watch authorize Viewers; four anonymous Chrome routes stayed neutral until authorization. There are no accounts/JWT/session rows; SQLite v3 still contains all four rooms, including room `1`.
- Production uses nginx, Node.js 24.19.0, coturn 4.17.2, and pinned LiveKit 1.13.5 on UDP 7882 with TCP fallback disabled. The application TURN tuple is absent; coturn retains the old authenticated-relay config and TCP/UDP 3478 plus UDP 49152-49251 rules but receives no advertised credential. Current service state is health 200 with Screener `NRestarts=31` from the failed activation sequence and LiveKit/coturn/nginx at 0.
- ADR-0005 is configured with exact `PEER_ASSISTED_ROOM_IDS=1`; unlisted rooms use ordinary P2P. `screener-v2` is the only deployed signaling literal; there is no v1 parser or translator.
- Chrome 151/LiveKit localhost A/B cut failure-to-active/render from 1.481/2.257 seconds to 0.200/0.320; 31 new frames and 25 ms sampling kept host edges at two. It is headless synthetic 720p30 and includes SDK/network prewarm, not public-network evidence.
- Chrome 151 synthetic topology/quality-control runs kept fanout 2/1 and all viewers decoding; one relay close recovered in 5.32 seconds. This is control evidence only.
- Room `1` publishes `HIGH+LOW` with Dynacast off and subscriber `HIGH` ceilings, and now has bounded local quality reparenting. Both remain unverified on real media; test zero-child leaves and calibrated C+B loss before broad rollout.
- C+B uses three hard-bad pairs, one-use samples and guarded intent/cooldown. Deployed admission rescue moves the oldest childless zero-capacity Host leaf below an unassigned one-slot relay in one revision; no score/timer/global rebalance. Deployment passed, but no real room triggered it.
- Source-only Web Host name/presence leaves Native wire/media unchanged and separates Viewer roster from Host diagnostics; the Host-name artifact was not activated.

## Provisional Quality Targets

- Controlled direct path at RTT no more than 40 ms and loss no more than 1%: glass-to-glass p50 no more than 150 ms and p95 no more than 250 ms.
- Regional SFU/UDP roots under the same endpoint conditions: glass-to-glass p95 no more than 350 ms; optional TURN is measured separately.
- First picture within 3 seconds after a watch request, excluding explicit permission time.
- A 60 fps profile must not remain below 50 decoded fps for more than 5 seconds without a visible downgrade or limiting reason.

These are measurement gates, not performance claims.

## Open Decisions

- Sustainable count by hardware, quality, network, and route: finish instrumented `1/3/5/8`, then pass a 20-viewer matrix before changing the accepted target default to 20.
- Whether ADR-0004 passes fanout, re-encoding, depth-four latency, reparenting, silent-partition, and mobile-leaf gates.
- Whether source-complete selected-edge passes forced relay, expiry/failure, mobile, 1-GiB resource and relay-bandwidth gates. Coturn's bearer is non-revocable until expiry; application guards and TTL only bound reuse. Performance comparison and the retained matrix follow functional landing; Media TCP is out of scope.
- Exact mobile lifecycle behavior and whether Windows per-application audio is required for the first release.
- Project license and distribution model, which determines whether GPL/AGPL sources can move beyond study-only use.
- Initial deployment regions and expected mainland China, Hong Kong, and overseas network mix.
- Whether voice chat ever enters scope or Screener stays complementary to an existing voice application.
- Production calibration of local-reparent thresholds and the ADR-0007 native matrix; #28's minimum-of-two rule is not a candidate.

## Source Of Truth

- Documentation index and current phase: `docs/README.md` and `docs/status.md`
- Requirements and design: `docs/需求理解.md` and `docs/方案设计.md`
- Media research: `docs/research/`, indexed by `docs/README.md`
- Architecture: ADR-0001/0002, proposed ADR-0004, accepted-but-unverified ADR-0005, no-go proposed ADR-0006, accepted ADR-0007, and rejected/superseded ADR-0003
- Deployment and maintenance: `docs/deployment.md`, `docs/maintenance.md`, `AGENTS.md`, and `.codex/`
