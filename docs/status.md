# Current Status

Last updated: 2026-08-21

## Phase

`https://share.bonfire.icu` serves exact `fd76277b05d491af8840b28f3132b7ff445d3cbe`; the 915,377-byte artifact SHA-256 is `8da4b8b2b1ae4b82add615f4367ee447b5ade86c4e58a938e51085940b9867d3`.
The cutover held the lock 8,389 ms and returned local health 520 ms after stop. SQLite v3 has five rooms; Screener, LiveKit, coturn and nginx are healthy with zero restarts.
Ordinary ICE is STUN-only; all rooms use the bounded peer/SFU-UDP controller and selected-edge UDP TTL 120. Room `1` is historical smoke and no real TURN/SFU media canary has run.
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
- Room `1` can publish exactly `HIGH+LOW` with Dynacast/backup codec off and subscriber `HIGH` ceilings; it has no retained real media frame.
- Room `1` C+B reparenting remains uncalibrated. Deployed admission rescue promotes an unassigned one-slot relay over the oldest childless zero-capacity Host leaf, with no scores or periodic optimization.
- Web roster includes Host self-name and requests window-scoped display audio where supported; both are hints, and Native wire/media is unchanged.

## Verified Evidence

- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- The `a11a73d` built-in TURN canary is rejected: local allocation passed, but direct Host/Pion Viewer failed before forced relay. Full rollback restored STUN-only client ICE and zero allocations.
- Chrome 151 browser loopbacks decoded VP8 299 and H.264 opt-in 299/298 rendered at 1280x720 without fatal/encoder errors. Browser hardware attribution, multi-viewer/endurance and public proof remain open; production stays VP8.
- Native WGC/MF used no browser capture/encoder. One Chrome Viewer rendered 203 1280x720 frames and received 500 Opus packets; process/LUID-correlated `VideoEncode` was nonzero, with no fatal/encoder errors.
- Native Win11 audio is source-only/default-off: target isolation was 4018x and one Viewer got 495 Opus packets. Download, game sync, Win10, and other routes remain open.
- Access protocol/config/HTTP/storage/SQLite/signaling focused tests pass, including commit-first teardown and v1 rollback.
- Native wire/session tests enforce at most two authoritative children, no presence-created edge, stale-revision ignore, and one bounded unsupported-route failure per revision.
- Source adds selected Host ingress and peer last-mile for every enabled room; focused routing/config tests pass with Peer ICE STUN-only.
- Host names, the window-audio hint, all-room routing, and all-room Host selected ingress are active; the stale restart assertion is historical only.
- The `fd76277` gate preserved the environment and SQLite hashes, v3/five rooms/room `1`, selected-edge/SFU/ordinary-ICE settings, services, and local/public health plus route/asset 200s. Site access returned the unauthenticated status and the retired endpoint returned 404; no TURN/SFU session ran. Exact `5e4a3679076a9ea2fe7a41fadf4be65a439db450` is the rollback release.

## Unverified Boundaries

- The final deployment proves process/config health, not a retained SFU frame, retry/failback, selected UDP pair, admission rescue, edge cap, quality, or resource deltas; game-share load/blur remains unclassified.
- Mobile Web Host unsupported; Viewer leaf-only. Android 14+ direct-child source passed six protocol tests and `assembleDebug`; GitHub compile is billing-blocked. Device media, SFU, audio, and rotation remain open. iOS deferred; TV output is local-only P2.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- ADR-0006 has one Viewer proof; two-edge/FIFO, hardware, endurance, public/downloaded-package, and browser-diversity proof remain open.
- Browser fanout is host two/viewer one; any accepted endpoint relay stays capped at two downstream edges.
- PR #49/#50 BWE is unverified/default-off: test zero-child leaves, then root impact. No local per-leaf UDP shaper; resume with Linux `tc` or public canary, never CDP. Web P2P/SVC shortcuts remain no-go.
- The corrected standby smoke is localhost/headless/video-only; public DNS/TLS reuse, transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.
- Headful fragment-to-sessionStorage consumption, invitation rotation after migration, and request/log leak inspection remain production UX gates. Accounts stay out.
- Structure debt: split `HybridMediaRouter`, `HostPage`, `SignalingServer`, and `ViewerPage` only at proven consumer boundaries, never by file length.

## Next Milestone

Repeat room `1` and fix only the identified SFU connect/source/publish/audio/transport layer; retain selected UDP, a rendered frame, edge caps and resource deltas.
Recovery uses one ICE restart, one same-parent rebuild, one alternate peer, then SFU. Next gate exactly-two/Dynacast-off BWE on a zero-child SFU leaf, then root evacuation.
Native WGC/MF passed one-Viewer hardware; package download, Viewer2/FIFO and game A/V remain. Benchmark later.
Ordinary Peer ICE stays STUN-only. Selected-edge Host ingress still needs one forced-relay canary before a media-success claim.
ADR-0004 still needs the 30-minute `1/3/5/8` matrix; a separate 20-viewer gate must pass before changing the default eight.

## Blockers And Decisions

ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets,
host/provider UDP 7882 and bounded services are deployed, but real external
media/device evidence is absent. Shared IP remains smoke-only and cannot approve
clean-port migration; the full gate still needs an isolated VM/IP.

- Initial deployment region and network cohort.
- Project license and distribution model.
