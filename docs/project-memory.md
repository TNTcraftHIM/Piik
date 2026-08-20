# Project Memory

Last updated: 2026-08-21

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
- Use direct host P2P for one or two viewers, then the bounded controller for every room when `PEER_ASSISTED_MEDIA=true`. Room `1` is historical smoke, not a runtime gate; resource, quality, recovery, SFU/UDP, bounded-failure, and browser/mobile evidence remain separate.
- Browser relays resend remote `MediaStreamTrack` values and re-encode at each hop; WebRTC does not guarantee a shared encoder across peer connections, so measure the cost.
- Keep experiments bounded: the standard representation sequence is below; native RTP relay, encoded-object striping, and FEC remain separate.
- ADR-0006 remains no-go. Native H.264 opt-in loopback (Chrome 151, 1280x720) rendered 298/299 with zero fatal/encoder errors; VP8 remains default. Pion timing, hardware attribution, multi-viewer/endurance/public/packaged proof remain open.
- Mobile Web Host is unsupported; feature-detect and fail clearly. Mobile Viewer stays leaf-only. After Windows native, gate Android 14+; iOS waits for stable iOS 27 ScreenCaptureKit.
- ADR-0005 accepts direct/peer UDP, bounded SFU roots, then optional selected-edge TURN. Production now enables the one-shot selected-edge tuple after SFU; participant-wide TURN remains rejected and ordinary peer ICE stays STUN-only. No real TURN/SFU media canary has yet been run.
- The controller is process-enabled, not room-allowlisted: `PEER_ASSISTED_MEDIA=true` gives every normal room the same direct/peer -> SFU -> selected-edge path with per-room state. Room `1` is historical smoke. Preserve sticky P2P, mobile leaves and break-before-make; recovery gets one attempt per layer (ICE restart, same-parent rebuild, alternate peer, then SFU), never three identical retries.
- C+B quality reparenting is edge-local and cooldown-bound; no score, timer, or global parent penalty.
- Flagship media is UDP; HTTPS/WSS stays TLS/TCP; the old release remains rollback-only.
- Treat settings as ceilings and degradation as unclassified. Use correlated Host A+B/Viewer C and one-variable evidence; never force AV1, infer by UA, or create a composite score.
- Web capture cannot isolate process audio. ADR-0008 Windows 11 native audio is opt-in/source-only: opaque local selection, no system-mix fallback or exposed PID, and one shared Opus track; one direct Viewer received 495 packets. Packaging, game A/V sync, other routes, and Windows 10 remain open.
- Viewer-local names and the opt-in Web participant roster remain control-plane-only. Web Host names are deployed in the current release and stay socket/localStorage-only; Native remains outside the capability boundary.
- Do not add scene detection, dynamic-FPS control, or forced AV1 without negotiation, encode, game, CPU/GPU, and sender evidence.
- ADR-0002 grant/public access, the v3 room-password migration, and Web Host display names are deployed. Names/presence remain session-only without account or roster tables.
- Deferred architecture audit: `docs/maintenance.md`.

## Current Execution Principle

- Flagship; parallel; min run/smoke/rollback; benchmark later. Active UI/config/logs/comments=current; history/migration=`historical`; ship reverse-scan visible copy->source; drop no-consumer layer; copy masks no wrong model.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production serves exact `c27df2235ecc0be17816f642ca49028e30380a34` at `https://share.bonfire.icu`. The immutable artifact is 912,999 bytes with SHA-256 `1c7f06e2608414f0a4facf8577c8b49a8fefb831e20826c0e23fa0d1e85240d6`; the 2026-08-20T19:03:10Z UTC cutover held the deployment lock for 662 ms and reached local health in 552 ms from stop (543 ms from symlink switch). Exact `cf149df2411798cd632cc92a562b0a35146e0c1b` is the immediate rollback release.
- The current Screener, LiveKit, coturn, and nginx services are active/running with `NRestarts=0`; local and public health are 200. SQLite v3 is intact with five rooms including room `1`, and the DB owner/mode remain `screener:screener`/0600.
- Production ICE remains ordinary STUN-only. `PEER_ASSISTED_MEDIA=true` enables the controller for every normal room, and selected-edge TURN is now configured for the single UDP tuple with TTL 120; the coturn daemon and nginx/LiveKit/firewall/listener baselines were unchanged. No real TURN/SFU media canary or quality claim is implied.
- Production requires an independent `HOST_ADMISSION_PASSWORD` only for creation/Host role. Default private fragment grants, room passwords, and explicit public-watch authorize Viewers; anonymous routes remain neutral until authorization. There are no accounts/JWT/session rows; SQLite v3 stores room identity only.
- Production uses nginx, Node.js 24.19.0, coturn 4.17.2, and LiveKit 1.13.5 on UDP 7882 (TCP fallback off). Ordinary peer ICE receives no TURN; the selected-edge tuple is configured only for the current controller edge, with no credential pre-advertised to ordinary peers. Coturn retains the old authenticated-relay ports. Services are healthy with zero restarts.
- ADR-0005 source rejects `PEER_ASSISTED_ROOM_IDS`; `PEER_ASSISTED_MEDIA=true` enables every room, while ordinary peer ICE stays STUN-only. A stale room-ID variable fails startup. `screener-v2` is the only deployed signaling literal; there is no v1 parser or translator.
- Chrome 151/LiveKit localhost A/B cut failure-to-active/render from 1.481/2.257 seconds to 0.200/0.320; 31 new frames and 25 ms sampling kept host edges at two. It is headless synthetic 720p30 and includes SDK/network prewarm, not public-network evidence.
- Chrome 151 synthetic topology/quality runs kept fanout 2/1 and decoding; one relay close recovered in 5.32 seconds. Control evidence only.
- Room `1` publishes `HIGH+LOW` with Dynacast off and subscriber `HIGH` ceilings, and now has bounded local quality reparenting. Both remain unverified on real media; test zero-child leaves and calibrated C+B loss before broad rollout.
- C+B uses three hard-bad pairs, one-use samples and guarded intent/cooldown. Deployed admission rescue moves the oldest childless zero-capacity Host leaf below an unassigned one-slot relay in one revision; no score/timer/global rebalance. Deployment passed, but no real room triggered it.
- Web Host name/presence and the best-effort window-scoped audio request hint are deployed; both remain control-plane/capture hints and do not change the Native wire. Native H.264 opt-in source is present but no packaged native sender is in the release; VP8 remains the Web/production default. See `docs/research/native-h264-opt-in-path.md`.

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
- Production calibration of local-reparent thresholds, physical H.264 hardware attribution, and the ADR-0007 native matrix; #28's minimum-of-two rule is not a candidate.

## Source Of Truth

- Documentation index and current phase: `docs/README.md` and `docs/status.md`
- Requirements and design: `docs/需求理解.md` and `docs/方案设计.md`
- Media research: `docs/research/`, indexed by `docs/README.md`
- Architecture: ADR-0001/0002, proposed ADR-0004, accepted-but-unverified ADR-0005, no-go proposed ADR-0006, accepted ADR-0007, and rejected/superseded ADR-0003
- Deployment and maintenance: `docs/deployment.md`, `docs/maintenance.md`, `AGENTS.md`, and `.codex/`
