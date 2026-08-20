# Project Memory

Last updated: 2026-08-21

## Confirmed Intent

- Build low-latency game sharing for one broadcaster and trusted friends; public or large broadcasts belong on OBS/Twitch-class services.
- Viewers join from normal desktop/mobile browsers. Native senders may improve capture/audio without changing the Web viewer requirement.
- Use a small central service for access, rooms, signaling, deterministic topology, STUN, observability, and bounded SFU-root capacity.
- Minimize server bandwidth. Ordinary peer ICE is STUN-only. Failure tries restart, rebuild, alternate peer and bounded SFU/UDP roots; only then may the controller authorize short-lived TURN for one selected exceptional edge before clear failure. TURN is transport, not topology.
- Non-server nodes have at most two downstream edges; browser relays stay at one until resource gates pass. SFU normally feeds one or two roots that retain peer descendants; separately capped server edges may serve exceptional viewers that cannot attach behind a healthy root.
- Two-tree packet/layer striping may reduce endpoint upload toward one stream bitrate, but needs a bounded multi-parent, loss, sync, churn, and latency experiment; it is not in the current full-stream chains.
- Direct/peer keeps per-PC stock GCC. SFU paths start at a `HIGH` ceiling and share at most one `LOW`; next test LiveKit exactly-two built-in BWE on zero-descendant leaves. If it passes, no app media selector is built. Explicit quality, manual activation, then custom/native are later fallbacks; always-on `LOW` needs resource gates.
- A later explicit quality fallback evacuates children under a generation guard first. Autonomous BWE enters `suspect`; confirmation evacuates children, and no confirmed `FALLBACK` parent remains. Root-with-children impact is a default-on gate; capacity returns after longer recovery plus cooldown. Self-report alone never triggers it.
- Site access protects room creation, Host publication, and every code-only Viewer entry. A valid room-scoped fragment grant bypasses that site gate; otherwise site access is checked before public-watch or a private room password. Persist neither raw credential; keep accounts, ACLs, users, and session tables out.
- Keep decisions, snapshots, research, code, `AGENTS.md`, and `.codex/` in Git; rewrite memory/status in place. Research current primary sources before material work and reject speculative machinery.
- Migrate client, server, and deployment atomically. After a canary, delete superseded config/wire/parsers/tests; do not retain compatibility layers, dual writes, or a second architecture without a current consumer. Git history owns the old implementation.
- Autonomously deploy each coherent low-risk milestone after narrow tests, independent review, one full gate, CI and rollback preflight. Keep protocol/database migrations atomic rather than folding them into routine UI/media updates.

## Current Recommendation

- Keep desktop Chrome/Edge and the responsive Web viewer as the baseline. Validate Android Chrome and iOS Safari as leaves.
- Use direct host P2P for one or two viewers, then the bounded controller for every room when `PEER_ASSISTED_MEDIA=true`. Room `1` is historical smoke, not a runtime gate; resource, quality, recovery, SFU/UDP, bounded-failure, and browser/mobile evidence remain separate.
- Browser relays resend remote `MediaStreamTrack` values and re-encode at each hop; WebRTC does not guarantee a shared encoder across peer connections, so measure the cost.
- Keep experiments bounded: the standard representation sequence is below; native RTP relay, encoded-object striping, and FEC remain separate.
- ADR-0006's historical browser-bridge canary remains no-go; VP8 stays default. Browser H.264 rendered 298/299; Native WGC/MF rendered 203 with PID/LUID-correlated `VideoEncode`. Downloaded use, multi-viewer/endurance/public proof remain open.
- Mobile Web Host unsupported. Android 14+ sender is direct-child video-only; device, audio, rotation, and SFU remain open. iOS deferred; TV output is local-only P2.
- ADR-0005 accepts direct/peer UDP, bounded SFU roots, then optional selected-edge TURN. Production enables the one-shot selected-edge tuple after SFU; participant-wide TURN remains rejected and ordinary peer ICE stays STUN-only. No production SFU/TURN media canary has run; latest source has one local SFU/UDP functional proof and TURN remains unverified.
- The controller is process-enabled, not room-allowlisted: `PEER_ASSISTED_MEDIA=true` gives every normal room the same direct/peer -> SFU -> selected-edge path with per-room state. Room `1` is historical smoke. Preserve sticky P2P, mobile leaves and break-before-make; recovery gets one attempt per layer (ICE restart, same-parent rebuild, alternate peer, then SFU), never three identical retries.
- C+B quality reparenting is edge-local and cooldown-bound; no score, timer, or global parent penalty.
- Flagship media is UDP; HTTPS/WSS stays TLS/TCP; the old release remains rollback-only.
- Treat settings as ceilings and degradation as unclassified. Use correlated Host A+B/Viewer C and one-variable evidence; never force AV1, infer by UA, or create a composite score.
- Web cannot isolate process audio. ADR-0008 Win11 audio is opt-in/source-only with no system-mix fallback or exposed PID; one Viewer got 495 Opus packets. Evaluation packaging includes the helper, hashes, and linked licenses; release, game sync, other routes, and Win10 remain open.
- Viewer-local names and the opt-in Web participant roster remain control-plane-only. Web Host names are deployed in the current release and stay socket/localStorage-only; Native remains outside the capability boundary.
- Do not add scene detection, dynamic-FPS control, or forced AV1 without negotiation, encode, game, CPU/GPU, and sender evidence.
- ADR-0002 grant/public access, the v3 room-password migration, and Web Host display names are deployed. Names/presence remain session-only without account or roster tables.

## Current Execution Principle

- Flagship; parallel; min run/smoke/rollback; benchmark later. Active UI/config/logs/comments=current; history/migration=`historical`; ship reverse-scan visible copy->source; drop no-consumer layer; copy masks no wrong model.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production serves exact `fd76277b05d491af8840b28f3132b7ff445d3cbe` at `https://share.bonfire.icu`. The immutable artifact is 915,377 bytes with SHA-256 `8da4b8b2b1ae4b82add615f4367ee447b5ade86c4e58a938e51085940b9867d3`; the 2026-08-20T20:53:59Z UTC cutover held the deployment lock for 8,389 ms and reached local health in 520 ms from stop (478 ms from symlink switch). Exact `5e4a3679076a9ea2fe7a41fadf4be65a439db450` is the immediate rollback release.
- The current Screener, LiveKit, coturn, and nginx services are active/running with `NRestarts=0`; local and public health are 200. SQLite v3 is intact with five rooms including room `1`, and the DB owner/mode remain `screener:screener`/0600.
- Production ICE remains ordinary STUN-only. `PEER_ASSISTED_MEDIA=true` enables the controller for every normal room, and selected-edge TURN is configured for the single UDP tuple with TTL 120; the coturn daemon and nginx/LiveKit/firewall/listener baselines were unchanged. No production SFU/TURN media canary or quality claim is implied.
- Production requires the independent site-access secret through `SITE_ACCESS_PASSWORD`. Its stateless cookie authorizes creation/Host and permits code-only Viewer attempts; valid private fragment grants remain direct. Public-watch accepts site access plus code, while private code-only entry additionally requires the room password. The env, endpoint, cookie, and nginx limiter naming migrated atomically; anonymous failures stay neutral, and there are no accounts/JWT/session rows.
- Production uses nginx, Node.js 24.19.0, coturn 4.17.2, and LiveKit 1.13.5 on UDP 7882 (TCP fallback off). Ordinary peer ICE receives no TURN; the selected-edge tuple is configured only for the current controller edge, with no credential pre-advertised to ordinary peers. Coturn retains the old authenticated-relay ports. Services are healthy with zero restarts.
- ADR-0005 source rejects `PEER_ASSISTED_ROOM_IDS`; `PEER_ASSISTED_MEDIA=true` enables every room, while ordinary peer ICE stays STUN-only. A stale room-ID variable fails startup. `screener-v2` is the only deployed signaling literal; there is no v1 parser or translator.
- Chrome 151/LiveKit localhost A/B cut failure-to-active/render from 1.481/2.257 seconds to 0.200/0.320; 31 new frames and 25 ms sampling kept host edges at two. It is headless synthetic 720p30 and includes SDK/network prewarm, not public-network evidence.
- Chrome 151 synthetic topology/quality runs kept fanout 2/1 and decoding; one relay close recovered in 5.32 seconds. Control evidence only.
- Latest source matches LiveKit 2.22.0's two-layer `q,h` sender layout. Chrome 151 against local LiveKit 1.13.5 retained one SFU/UDP root with increasing inbound/decoded/rendered counters and clean client leaves; TURN was absent and no performance claim follows. Production deployment, zero-child BWE, and calibrated C+B loss remain open.
- C+B uses three hard-bad pairs, one-use samples and guarded intent/cooldown. Deployed admission rescue moves the oldest childless zero-capacity Host leaf below an unassigned one-slot relay in one revision; no score/timer/global rebalance. Deployment passed, but no real room triggered it.
- Web Host name/presence and window-audio hint are deployed. Native accepts bounded peer-assisted direct children and fails unsupported SFU/selected ingress; it has no LiveKit/TURN media. Its WGC/MF H.264 direct-child smoke rendered 203 frames plus 500 Opus packets and matched helper PID/LUID `VideoEncode`; packaging is source-only, unreleased and undeployed. VP8 remains the Web/production default. See `docs/research/native-h264-opt-in-path.md`.

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
- Exact mobile lifecycle behavior.
- Project license and distribution model, which determines whether GPL/AGPL sources can move beyond study-only use.
- Initial deployment regions and expected mainland China, Hong Kong, and overseas network mix.
- Whether voice chat ever enters scope or Screener stays complementary to an existing voice application.
- Production calibration of local-reparent thresholds, physical H.264 hardware attribution, and the ADR-0007 native matrix; #28's minimum-of-two rule is not a candidate.

## Source Of Truth

- Current phase is in `docs/status.md`; requirements/design, ADRs, research, deployment and maintenance are indexed by `docs/README.md`.
