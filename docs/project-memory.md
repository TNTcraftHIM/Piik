# Project Memory

Last updated: 2026-08-21

## Confirmed Intent

- Build low-latency game sharing for one broadcaster and trusted friends; public or large broadcasts belong on OBS/Twitch-class services.
- Browser first. Viewers use desktop/mobile Web; an optional sender requires a proven browser capability gap.
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
- Mobile endpoints are Web Viewer-only. Current Android/iOS browsers do not expose Web Host capture; AirPlay/system mirroring is Viewer-local output.
- ADR-0005: direct/peer UDP -> bounded SFU roots -> selected-edge TURN. Source caps pending/answered `peer-selected` at one per room; Host ingress is independent. An exact-source/production-media canary proves active Host ingress only. Ordinary peers stay STUN-only.
- The controller is process-enabled, not room-allowlisted: `PEER_ASSISTED_MEDIA=true` gives every normal room the same direct/peer -> SFU -> selected-edge path with per-room state. Room `1` is historical smoke. Preserve sticky P2P, mobile leaves and break-before-make; recovery gets one attempt per layer (ICE restart, same-parent rebuild, alternate peer, then SFU), never three identical retries.
- C+B quality reparenting is edge-local and cooldown-bound; no score, timer, or global parent penalty.
- Flagship media is UDP; HTTPS/WSS stays TLS/TCP; the old release remains rollback-only.
- Treat settings as ceilings and degradation as unclassified. Use correlated Host A+B/Viewer C and one-variable evidence; never force AV1, infer by UA, or create a composite score.
- Web requests window audio and offers system audio for full displays; both are browser hints. Returned tracks use the `music` hint. Native Win11 process audio stays source-only; one Viewer got 495 Opus packets.
- Viewer-local names and the opt-in Web participant roster remain control-plane-only. Web Host names are deployed in the current release and stay socket/localStorage-only; Native remains outside the capability boundary.
- Do not add scene detection, dynamic-FPS control, or forced AV1 without negotiation, encode, game, CPU/GPU, and sender evidence.
- ADR-0002 grant/public access, the v3 room-password migration, and Web Host display names are deployed. Names/presence remain session-only without account or roster tables.

## Current Execution Principle

- Flagship; parallel; min run/smoke/rollback; benchmark later. Active UI/config/logs/comments=current; history/migration=`historical`; ship reverse-scan visible copy->source; drop no-consumer layer; copy masks no wrong model.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production is exact `16f6eab27bdfb1c15cdbd814a35864f4f18be767` at `https://share.bonfire.icu`; its 1,027,423-byte artifact SHA-256 is `74e0274ab11a162cb9dd4be1c34bb6b639e2ea76005969c30ae3a1daa656742f`. The 2026-08-20T23:44:57Z cutover took 10,238 ms lock/641 ms stop-health/570 ms switch-health. Immediate rollback is exact `22119b907d3cf03ce8b06d6fb4596ce1a26fedd7`; exact `fd76277b05d491af8840b28f3132b7ff445d3cbe` remains secondary.
- `main` is ahead only in Native/test evidence; the Windows Native sender stays source-only. Host-ingress retry is deployed.
- The four services are active/running with observed `NRestarts=0`; local/public health are 200. SQLite v3 has five rooms including room `1`, with DB owner/mode `screener:screener`/0600.
- Production ICE is ordinary STUN-only. The all-room controller has one selected-edge UDP tuple at TTL 120. A local exact-source canary used production LiveKit/coturn without production app/DB writes and proved active Host-ingress function only.
- Production requires the independent site-access secret through `SITE_ACCESS_PASSWORD`. Its stateless cookie authorizes creation/Host and permits code-only Viewer attempts; valid private fragment grants remain direct. Public-watch accepts site access plus code, while private code-only entry additionally requires the room password. The env, endpoint, cookie, and nginx limiter naming migrated atomically; anonymous failures stay neutral, and there are no accounts/JWT/session rows.
- Production uses nginx, Node.js 24.19.0, coturn 4.17.2, and LiveKit 1.13.5 on UDP 7882 (TCP fallback off). Ordinary peer ICE receives no TURN; the selected-edge tuple is configured only for the current controller edge, with no credential pre-advertised to ordinary peers. Coturn retains the old authenticated-relay ports. Services are healthy with zero restarts.
- ADR-0005 rejects `PEER_ASSISTED_ROOM_IDS`; `PEER_ASSISTED_MEDIA=true` enables every room and ordinary peers stay STUN-only. Initial or active Host ingress may consume one bound relay-only grant; ready/abort clears it and failure restores peer baseline. Stale room-ID config fails startup; `screener-v2` is the only deployed wire.
- Chrome 151/LiveKit localhost A/B cut failure-to-active/render from 1.481/2.257 seconds to 0.200/0.320; 31 new frames and 25 ms sampling kept host edges at two. It is headless synthetic 720p30 and includes SDK/network prewarm, not public-network evidence.
- Chrome 151 synthetic topology/quality runs kept fanout 2/1 and decoding; one relay close recovered in 5.32 seconds. Control evidence only.
- Deployed Web uses LiveKit 2.22.0 `q,h`. Chrome 151 proves local SFU/UDP and, separately, active selected TURN/UDP Host ingress against production media services with Viewer frame progress and clean stop. Initial/peer-selected relay, BWE, and C+B remain open.
- C+B uses three hard-bad pairs, one-use samples and guarded intent/cooldown. Deployed admission rescue moves the oldest childless zero-capacity Host leaf below an unassigned one-slot relay in one revision; no score/timer/global rebalance. Deployment passed, but no real room triggered it.
- Web names/window audio are deployed; source adds full-display system audio, music hint, interval AV loss% and audio codec/bitrate/jitter details. Native WGC/MF remains source-only: 203 rendered frames, 500 Opus packets, matched PID/LUID `VideoEncode`. New Web audio work is undeployed; VP8 remains default.

## Provisional Quality Targets

- Controlled direct path at RTT no more than 40 ms and loss no more than 1%: glass-to-glass p50 no more than 150 ms and p95 no more than 250 ms.
- Regional SFU/UDP roots under the same endpoint conditions: glass-to-glass p95 no more than 350 ms; optional TURN is measured separately.
- First picture within 3 seconds after a watch request, excluding explicit permission time.
- A 60 fps profile must not remain below 50 decoded fps for more than 5 seconds without a visible downgrade or limiting reason.

These are measurement gates, not performance claims.

## Open Decisions

- Sustainable count by hardware, quality, network, and route: finish instrumented `1/3/5/8`, then pass a 20-viewer matrix before changing the accepted target default to 20.
- Whether ADR-0004 passes fanout, re-encoding, depth-four latency, reparenting, silent-partition, and mobile-leaf gates.
- Selected-edge: active Host-ingress function passes; initial ingress, `peer-selected`, expiry/failure, mobile, resource and bandwidth gates remain. The bearer is non-revocable until expiry; performance follows later and Media TCP is out.
- Exact mobile Viewer lifecycle behavior across autoplay, rotation, backgrounding and network changes.
- Project license and distribution model, which determines whether GPL/AGPL sources can move beyond study-only use.
- Initial deployment regions and expected mainland China, Hong Kong, and overseas network mix.
- Whether voice chat ever enters scope or Screener stays complementary to an existing voice application.
- Production calibration of local-reparent thresholds, physical H.264 hardware attribution, and the ADR-0007 native matrix; #28's minimum-of-two rule is not a candidate.

## Source Of Truth

- Current phase is in `docs/status.md`; requirements/design, ADRs, research, deployment and maintenance are indexed by `docs/README.md`.
