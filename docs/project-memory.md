# Project Memory

Last updated: 2026-08-20

## Confirmed Intent

- Build low-latency game sharing for one broadcaster and trusted friends; public or large broadcasts belong on OBS/Twitch-class services.
- Viewers join from normal desktop/mobile browsers. A later native sender may share encoding and improve capture/audio without changing the Web viewer requirement.
- Use a small central service for access, rooms, signaling, deterministic topology, STUN, observability, and bounded SFU-root capacity; TURN is optional extreme-network transport.
- Minimize server bandwidth. The accepted invisible ladder is direct/peer UDP, then SFU/UDP roots, then optional TURN for a selected exceptional edge, then bounded failure. TURN is transport, not topology.
- Non-server nodes have at most two downstream edges; browser relays stay at one until resource gates pass. SFU normally feeds one or two roots that retain peer descendants; separately capped server edges may serve exceptional viewers that cannot attach behind a healthy root.
- Two-tree packet/layer striping may reduce endpoint upload toward one stream bitrate, but needs a bounded multi-parent, loss, sync, churn, and latency experiment; it is not in the current full-stream chains.
- Direct/peer keeps per-PC stock GCC. SFU paths start at a `HIGH` ceiling and share at most one `LOW`; next test LiveKit exactly-two built-in BWE on zero-descendant leaves. If it passes, no app media selector is built. Explicit quality, manual activation, then custom/native are later fallbacks; always-on `LOW` needs resource gates.
- A later explicit quality fallback evacuates children under a generation guard first. Autonomous BWE enters `suspect`; confirmation evacuates children, and no confirmed `FALLBACK` parent remains. Root-with-children impact is a default-on gate; capacity returns after longer recovery plus cooldown. Self-report alone never triggers it.
- Separate abuse control from watching: production Host admission protects room creation/Host role, while a default private capability grants Viewer access to one room; public-watch is explicit. Keep raw grants out of localStorage/cookies/query/logs/SQLite; retain no account, ACL, user, or session table.
- Keep decisions, snapshots, research, code, `AGENTS.md`, and `.codex/` in Git; rewrite memory/status in place. Research current primary sources before material work and reject speculative machinery.
- Migrate client, server, and deployment atomically. After a canary, delete superseded config/wire/parsers/tests; do not retain compatibility layers, dual writes, or a second architecture without a current consumer. Git history owns the old implementation.
- Autonomously deploy each coherent low-risk milestone after narrow tests, independent review, one full gate, CI and rollback preflight. Keep protocol/database migrations atomic rather than folding them into routine UI/media updates.

## Current Recommendation

- Keep desktop Chrome/Edge and the responsive Web viewer as the baseline. Validate Android Chrome and iOS Safari as leaves.
- Use direct host P2P for one or two viewers. Keep ADR-0004 off broadly; use an isolated exact-room candidate until resource, quality, recovery, SFU/UDP, bounded-failure, and browser/mobile gates pass.
- Browser relays resend remote `MediaStreamTrack` values and re-encode at each hop; WebRTC does not guarantee a shared encoder across peer connections, so measure the cost.
- Keep experiments bounded: the standard representation sequence is below; native RTP relay, encoded-object striping, and FEC remain separate.
- ADR-0006 stays no-go. Its v2 room is memory-only, capped by `ROOM_TTL` and rearmed 300s after Host disconnect; SQLite/Web unchanged. Pre-auth retries once in-room without another POST.
- Mobile Web Host is unsupported; feature-detect and fail clearly. Mobile Viewer stays leaf-only. After Windows native, gate Android 14+; iOS waits for stable iOS 27 ScreenCaptureKit.
- ADR-0005 accepts SFU roots as the primary central fallback after direct/peer UDP. The candidate has no TURN consumer or credential wire; any future exceptional-edge grant is a complete separate change. PR #12 is superseded.
- Keep the controller exact-room only: room `1` is the STUN/SFU smoke. Preserve sticky progressing P2P, mobile leaves and break-before-make. Recovery spends one attempt per layer (ICE restart, same-parent rebuild, alternate peer, then SFU), never three identical retries; active SFU gets one fresh grant before Peer failback.
- Quality reparenting needs three correlated C+B hard-bad windows and reuses the local-subtree peer/SFU/failure intent. Single-sided reports are diagnostic; one room cooldown blocks churn. No score, timer, or global parent penalty.
- Flagship media is UDP; HTTPS/WSS stays TLS/TCP; the old release remains rollback-only.
- Treat settings as ceilings and degradation as unclassified. Use correlated Host A+B/Viewer C and one-variable evidence; never force AV1, infer by UA, or create a composite score.
- Production reports poor film audio and self-echo when system capture includes voice software. Diagnose audio A/B/C and sync; Web cannot isolate arbitrary processes and `maxBitrate` is not quality-up. A Windows 11 native candidate defaults to game-process-tree audio and never widens silently; Windows 10 remains unresolved/unsupported. See `docs/research/browser-screen-audio-quality.md`.
- Candidate UI includes Viewer-local names and an opt-in Web Host online roster without changing media fanout. Host names, Viewer-side roster, endpoint details, and RTP loss remain pending.
- Do not add scene detection, dynamic-FPS control, or forced AV1 without negotiation, encode, game, CPU/GPU, and sender evidence.
- ADR-0002 access is deployed. Candidate names/presence are session-only and add no account, member, session, or roster table.
- Deferred architecture audit: `docs/maintenance.md`.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production `d4bc421828c4b74f55195723aace290ffc0e5f9d` deployed at 2026-08-20 11:41:22 +08 to `https://share.bonfire.icu`. Persistent room `1` alone enables peer/SFU routing and C+B-correlated local quality reparenting; unlisted rooms remain ordinary P2P. Immediate rollback is `05f98d10ecd1` with the current v2 DB/env.
- Ordinary ICE is process-wide STUN-only. Room `1` may use one LiveKit publication feeding at most two roots while retaining peer descendants; real 1/2-root media and game quality remain unverified.
- Production requires an independent `HOST_ADMISSION_PASSWORD` only for creation/Host role. Default private fragment grants and explicit public-watch authorize Viewers; four anonymous Chrome routes stayed neutral until authorization. There are no accounts/JWT/session rows; SQLite v2 still contains all four rooms, including room `1`.
- Production uses nginx, Node.js 24.19.0, coturn 4.17.2 for STUN/rollback, and pinned LiveKit 1.13.5 on UDP 7882 with TCP fallback disabled. Screener/LiveKit `NRestarts` remain 0/0; health and `index-YdNLg2E8.js` return 200. They used 39,198,720/79,269,888 bytes with zero cgroup high/max/OOM events at 11:44:15. No real room triggered quality reparenting. Public TCP 7880/7881 stays blocked; LiveKit keeps its 192/256 MiB cgroup boundary and restart disabled.
- Old TURN artifacts remain absent. Rolling back admission policy requires `89e6d7649169` plus the recorded environment backup; only pre-access `9610032` pairs with v1 SQLite.
- ADR-0005 is configured with exact `PEER_ASSISTED_ROOM_IDS=1`; unlisted rooms use ordinary P2P. `screener-v2` is the only deployed signaling literal; there is no v1 parser or translator.
- Production logs show two root participants and two short Host participants with no service restart or retained track. Their timing is consistent with, but does not directly prove, one fresh-grant retry and Peer failback. The Host exposes only the local current-revision failure stage (`connect|source|video-publish|sender-config|audio-publish|transport`) and uploads no raw error or endpoint data. Browser relays still re-encode; native capture/hardware remains outside validated production behavior.
- The retained v1 backup is the only schema rollback path. A failed artifact attempt exposed unsafe hard-linked dependency reuse; the successful immutable release has zero shared regular-file inodes with rollback, and future releases preserve that boundary.
- Chrome 151/LiveKit localhost A/B cut failure-to-active/render from 1.481/2.257 seconds to 0.200/0.320; 31 new frames and 25 ms sampling kept host edges at two. It is headless synthetic 720p30 and includes SDK/network prewarm, not public-network evidence.
- Source `main` at `f5d48ed` includes a memory-only Native v2 candidate, but production predates it and has no Native runtime gate. Render, hardware, two-edge/FIFO and TURN evidence remain absent.
- Chrome 151 synthetic topology/quality-control runs kept fanout 2/1 and all viewers decoding; one relay close recovered in 5.32 seconds. This is control evidence only.
- Room `1` publishes `HIGH+LOW` with Dynacast off and subscriber `HIGH` ceilings, and now has bounded local quality reparenting. Both remain unverified on real media; test zero-child leaves and calibrated C+B loss before broad rollout.
- Generation-bound C+B needs three hard-bad windows; parent samples are one-use per connection. Pending SFU binds intent/guard. Stale/successful peer work releases quality exclusion; real failure may take it over. It uploads no raw endpoint metadata and computes no score.
- The undeployed Web-only name/presence candidate leaves Native wire unchanged and keeps online Viewer sessions separate from Host media diagnostics; focused checks pass.

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
- Production calibration of local-reparent thresholds and the ADR-0007 native matrix; #28's minimum-of-two rule is not a candidate.

## Source Of Truth

- Documentation index and current phase: `docs/README.md` and `docs/status.md`
- Requirements and design: `docs/需求理解.md` and `docs/方案设计.md`
- Media research: `docs/research/`, indexed by `docs/README.md`
- Architecture: ADR-0001/0002, proposed ADR-0004, accepted-but-unverified ADR-0005, no-go proposed ADR-0006, accepted ADR-0007, and rejected/superseded ADR-0003
- Deployment and maintenance: `docs/deployment.md`, `docs/maintenance.md`, `AGENTS.md`, and `.codex/`
