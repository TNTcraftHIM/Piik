# Current Status

Last updated: 2026-08-21

## Phase

`https://share.bonfire.icu` currently serves exact `c27df2235ecc0be17816f642ca49028e30380a34`.
The 912,999-byte artifact has SHA-256
`1c7f06e2608414f0a4facf8577c8b49a8fefb831e20826c0e23fa0d1e85240d6`.
The 2026-08-20T19:03:10.569Z cutover held the lock 662 ms; local health
returned 552 ms after stop and 543 ms after the symlink switch.
SQLite v3 passed integrity checks with five rooms including room `1`; the
application/database stayed healthy. Screener, LiveKit, coturn, and nginx are
active/running with `NRestarts=0`, and local/public health are 200.
Ordinary ICE remains STUN-only; `PEER_ASSISTED_MEDIA=true` enables the
bounded peer/SFU-UDP controller for every room (at most two roots), while the
selected-edge UDP tuple is configured with TTL 120. Room `1` is historical
smoke only. No real TURN/SFU media canary has run. Web Host names and the
best-effort window-scoped audio request hint are deployed; Native H.264 source is
available but no packaged native sender is deployed, and VP8 remains the Web
default.

## Execution Principle

Flagship; parallel; min run/smoke/rollback; benchmark later. Active UI/config/logs/comments=current; history/migration=`historical`; ship reverse-scan visible copy->source; drop no-consumer layer; copy masks no wrong model.

## Current Snapshot

- Capture precedes room creation; source/quality changes preserve peers and pause keeps audio/connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Production access is `screener-v2`: Host admission, private grants/passwords, and public codes authorize Viewers. SQLite v3 retains five rooms and checked material; raw credentials are never stored.
- Web Hosts can set their local/session display name, and the current release advertises it through the existing presence wire. The name is not an account identity.
- Native v2 remains source-only (memory rooms, 300s reclaim); production does not run it.
- PR #44's STUN-only/SFU-UDP router and token-free fallback prewarm are process-enabled for all normal rooms: roots <=2, browser relay <=1, bounded failure. Room `1` is historical smoke; mobile/iPad viewers are leaves, healthy edges sticky, and HTTPS/WSS stays TLS/TCP.
- After an answer, a generation-bound 15s initial-connect deadline enters ICE restart; success/replacement/disposal cancels it. It is deployed but not mobile-verified.
- Room `1` can publish exactly `HIGH+LOW` with Dynacast/backup codec off and subscriber `HIGH` ceilings; it has no retained real media frame.
- Room `1` C+B reparenting remains uncalibrated. Deployed admission rescue promotes an unassigned one-slot relay over the oldest childless zero-capacity Host leaf, with no scores or periodic optimization.
- Web roster includes Host self-name and requests window-scoped display audio where supported; both are hints, and Native wire/media is unchanged.

## Verified Evidence

- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- The `a11a73d` built-in TURN canary is rejected: local allocation passed, but direct Host/Pion Viewer failed before forced relay. Full rollback restored STUN-only client ICE and zero allocations.
- Chrome 151 loopbacks decoded VP8 299 and H.264 opt-in 299/298 rendered at 1280x720 without fatal/encoder errors. Hardware attribution, Pion timing, multi-viewer/endurance/public/native proof remain open; production stays VP8.
- Native Win11 audio is source-only/default-off. Smoke isolated target 4018x; one Viewer got 495 Opus packets. Packaging, game sync, Win10, and other routes remain open.
- Access protocol/config/HTTP/storage/SQLite/signaling focused tests pass, including commit-first teardown and v1 rollback.
- Source adds selected Host ingress and peer last-mile for every enabled room; focused routing/config tests pass with Peer ICE STUN-only.
- Host names, the window-audio hint, all-room routing, and all-room Host selected ingress are active; the stale restart assertion is historical only.
- The `c27df22` gate preserved env/DB hashes, SQLite v3/five rooms/room `1`, services, and local/public health plus route/asset 200s. No TURN/SFU session ran.

## Unverified Boundaries

- The final deployment proves process/config health, not a retained SFU frame, retry/failback, selected UDP pair, admission rescue, edge cap, quality, or resource deltas; game-share load/blur remains unclassified.
- Android Chrome/iOS Safari Viewer leaves remain unverified and conservatively leaf-only. Mobile Web Host is unsupported; native senders are planned only.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- ADR-0006 has one Viewer proof; two-edge/FIFO, physical hardware, endurance, public, packaged-native, and browser-diversity proof remain open.
- Browser fanout is host two/viewer one; any accepted endpoint relay stays capped at two downstream edges.
- PR #49/#50 BWE is unverified/default-off: test zero-child leaves, then root impact. No local per-leaf UDP shaper; resume with Linux `tc` or public canary, never CDP. Web P2P/SVC shortcuts remain no-go.
- The corrected standby smoke is localhost/headless/video-only; public DNS/TLS reuse, transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.
- Headful fragment-to-sessionStorage consumption, invitation rotation after migration, and request/log leak inspection remain production UX gates. Accounts stay out.
- Structure debt: split `HybridMediaRouter`, `HostPage`, `SignalingServer`, and `ViewerPage` only at proven consumer boundaries, never by file length.

## Next Milestone

Repeat room 1 and use the bounded SFU stage to fix only the
identified connect/source/video-publish/sender-config/audio/transport layer,
then retain selected UDP, a decoded/rendered frame, edge caps and resource deltas.
The recovery target uses one ICE restart, one same-parent rebuild, one alternate peer, then
SFU; it never runs three identical retries or abandons progressing P2P early.

Next gate exactly-two/Dynacast-off BWE on a zero-child SFU leaf, then root
evacuation. Native source accepts increasing capture timestamps shorter than
duration; VP8 and explicit H.264 Viewer decode/render are recorded. Hardware
preference is not physical proof. Next prove fresh Pion
outbound diagnostics before viewer 2/FIFO/hardware/endurance/deploy.
Package Native audio and test one real-game A/V pair later without displacing P0.
Ordinary Peer ICE stays STUN-only; participant-wide TURN is removed. The
selected-edge tuple is configured in production, but Host ingress still needs one
forced-relay canary before any media-success claim. Retained performance/resource
benchmarks follow functional landing.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix. A separate
20-viewer gate must pass before the current default eight changes to target 20.

## Blockers And Decisions

ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets,
host/provider UDP 7882 and bounded services are deployed, but real external
media/device evidence is absent. Shared IP remains smoke-only and cannot approve
clean-port migration; the full gate still needs an isolated VM/IP.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
