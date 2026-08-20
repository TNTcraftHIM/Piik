# Current Status

Last updated: 2026-08-21

## Phase

Production is exact `22119b907d3cf03ce8b06d6fb4596ce1a26fedd7` at `https://share.bonfire.icu`; its 660,626-byte artifact SHA-256 is `3cbd8f6be82fa615fa2861ff1be0eba6c98f3f7d9acb73a0ba5c21a2ff4c661c`.
Cutover: 1,696 ms lock/508 ms stop-health; SQLite v3/five rooms/four healthy zero-restart services. Android exact `b8b6994efe4da3a773e16cec370e2a5ce7cbbf93` and pending ingress are not deployed.
Ordinary ICE is STUN-only; all rooms use the bounded peer/SFU-UDP controller and selected-edge UDP TTL 120. Room `1` is historical smoke; production SFU/TURN media remains unverified.
Web names/audio hint are deployed. Native WGC/MF/package is source-only; Web defaults VP8.

## Execution Principle

Flagship; parallel; min run/smoke/rollback; benchmark later. Active UI/config/logs/comments=current; history/migration=`historical`; ship reverse-scan visible copy->source; drop no-consumer layer; copy masks no wrong model.

## Current Snapshot

- Capture precedes room creation; source/quality changes preserve peers, while pause disables audio/video tracks together and keeps connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Production access is `screener-v2`: a valid private fragment grant enters directly; every code-only Viewer must first hold site access, after which public-watch accepts the code and private rooms still require their room password. `SITE_ACCESS_PASSWORD`, `/api/site-access`, and the site-access cookie are deployed atomically; raw credentials are never stored.
- Web Hosts can set their local/session display name, and the current release advertises it through the existing presence wire. The name is not an account identity.
- Native v2 is source-only (memory rooms, 300s reclaim); it follows authenticated direct-child assignments up to two and fails unsupported SFU/selected ingress boundedly.
- PR #44's STUN-only/SFU-UDP router and token-free fallback prewarm are process-enabled for all normal rooms: roots <=2, browser relay <=1, bounded failure. Room `1` is historical smoke; mobile/iPad viewers are leaves, healthy edges sticky, and HTTPS/WSS stays TLS/TCP.
- After an answer, a generation-bound 15s initial-connect deadline enters ICE restart; success/replacement/disposal cancels it. It is deployed but not mobile-verified.
- Production includes LiveKit's two-layer `q,h` sender guard; its functional media proof remains local, not production.
- Room `1` C+B reparenting remains uncalibrated. Deployed admission rescue promotes an unassigned one-slot relay over the oldest childless zero-capacity Host leaf, with no scores or periodic optimization.
- Web roster includes Host self-name and requests window-scoped display audio where supported; both are hints, and Native wire/media is unchanged.

## Verified Evidence

- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- Chrome 151 + local LiveKit 1.13.5/client 2.22.0 SFU/UDP passed after `q,f` -> `q,h`: one root, decoded 3 -> 23, rendered 26, Host edge one, clean leaves, no TURN. Functional only.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- The `a11a73d` built-in TURN canary is rejected: local allocation passed, but direct Host/Pion Viewer failed before forced relay. Full rollback restored STUN-only client ICE and zero allocations.
- Chrome 151 browser loopbacks decoded VP8 299 and H.264 opt-in 299/298 rendered at 1280x720 without fatal/encoder errors. Browser hardware attribution, multi-viewer/endurance and public proof remain open; production stays VP8.
- Native WGC/MF used no browser capture/encoder. One Chrome Viewer rendered 203 1280x720 frames and received 500 Opus packets; process/LUID-correlated `VideoEncode` was nonzero, with no fatal/encoder errors.
- Native Win11 audio is source-only/default-off: target isolation was 4018x and one Viewer got 495 Opus packets. Download, game sync, Win10, and other routes remain open.
- Access protocol/config/HTTP/storage/SQLite/signaling focused tests pass, including commit-first teardown and v1 rollback.
- Native wire/session tests enforce at most two authoritative children, no presence-created edge, stale-revision ignore, and one bounded unsupported-route failure per revision.
- Source adds initial/active selected Host ingress and peer last-mile. Focused route/signaling tests pass exactly-once prepare retry, cleanup and rollback with ordinary peers STUN-only; no relay media ran.
- Host names, the window-audio hint, all-room routing, and all-room Host selected ingress are active; the stale restart assertion is historical only.
- Exact `22119b9` passed typecheck, both builds and 30 files/440 tests. Deploy preserved environment, ingress/media/firewall/listener/SQLite hashes, v3/five rooms/room `1`, route settings, services and local/public/route/asset 200s. Site access stayed required, the retired endpoint remained 404, and no TURN/SFU session ran. Rollback is exact `fd76277b05d491af8840b28f3132b7ff445d3cbe`.

## Unverified Boundaries

- The `22119b9` deployment proves process/config health, not a retained production SFU frame, retry/failback, selected UDP pair, admission rescue, edge cap, quality, or resource deltas; game-share load/blur remains unclassified.
- Mobile Web Host unsupported; Viewer leaf-only. Android 14+ direct source/default-off selected-UID audio passed six protocol tests/`assembleDebug`. No device/audible claim; mediaProjection-only background, opt-out/silence/A-V, SFU/rotation remain open. iOS deferred; TV output P2.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- ADR-0006 has one Viewer proof; two-edge/FIFO, hardware, endurance, public/downloaded-package, and browser-diversity proof remain open.
- Browser fanout is host two/viewer one; any accepted endpoint relay stays capped at two downstream edges.
- PR #49/#50 BWE is unverified/default-off: test zero-child leaves, then root impact. No local per-leaf UDP shaper; resume with Linux `tc` or public canary, never CDP. Web P2P/SVC shortcuts remain no-go.
- Headful fragment-to-sessionStorage consumption, invitation rotation after migration, and request/log leak inspection remain production UX gates. Accounts stay out.
- Structure debt: split `HybridMediaRouter`, `HostPage`, `SignalingServer`, and `ViewerPage` only at proven consumer boundaries, never by file length.

## Next Milestone

Run one bounded production room `1` canary that retains UDP, a rendered frame, edge caps, and clean stop. TURN/performance follow later.
Recovery uses one ICE restart, one same-parent rebuild, one alternate peer, then SFU. Next gate exactly-two/Dynacast-off BWE on a zero-child SFU leaf, then root evacuation.
Native WGC/MF passed one-Viewer hardware; package download, Viewer2/FIFO and game A/V remain. Benchmark later.
Ordinary peers stay STUN-only. Initial/active Host ingress needs forced-relay canaries before any media claim.
ADR-0004 still needs the 30-minute `1/3/5/8` matrix; a separate 20-viewer gate must pass before changing the default eight.

## Blockers And Decisions

ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets,
host/provider UDP 7882 and bounded services are deployed, but real external
media/device evidence is absent. Shared IP remains smoke-only and cannot approve
clean-port migration; the full gate still needs an isolated VM/IP.

- Initial deployment region and network cohort.
- Project license and distribution model.
