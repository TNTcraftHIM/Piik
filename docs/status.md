# Current Status

Last updated: 2026-08-21

## Phase

`https://share.bonfire.icu` currently serves `fdd14ba0d9b5ea4c43aa0f6a3a29e0eacf182612`
with health 200 after the sole Host display-name cutover at `2026-08-20T16:09Z`.
Prepare/release and health passed; a stale `NRestarts=31` assertion triggered
automatic rollback. SQLite v3 has four rooms including room `1`; the
application/database stayed healthy, and current Screener, LiveKit, coturn, and
nginx services each report `NRestarts=0`. Host display names remain
source-only/not deployed.
Ordinary ICE is STUN-only; source flag `PEER_ASSISTED_MEDIA=true` enables the
bounded peer/SFU-UDP controller for every room (at most two roots). Room `1` is
historical smoke only. The old
`fdd14ba0d9b5` is the healthy v3 rollback target; older schema details are in
`docs/deployment.md`. Native is no-go and not in production.

## Execution Principle

Flagship first; parallelize design/research/code/tests/audit. Ship minimum runnable + smoke + rollback; avoid duplicate matrices. Room `1` is historical; benchmark later; no hardware overclaim.

## Current Snapshot

- Capture precedes room creation; source/quality changes preserve peers and pause keeps audio/connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Production access is `screener-v2`: Host admission, private grants/passwords, and public codes authorize Viewers. SQLite v3 retains four rooms and checked material; raw credentials are never stored.
- The Host display-name change is source-only after the failed `61a87ae` activation; it did not alter the deployed wire or UI.
- Source-only Native v2 uses memory-only rooms, 300s reclaim and `ROOM_TTL`; production does not run it.
- PR #44's STUN-only/SFU-UDP router and token-free fallback prewarm are process-enabled for all normal rooms: roots <=2, browser relay <=1, bounded failure. Room `1` is historical smoke; mobile/iPad viewers are leaves, healthy edges sticky, and HTTPS/WSS stays TLS/TCP.
- After an answer, a generation-bound 15s initial-connect deadline enters ICE restart; success/replacement/disposal cancels it. It is deployed but not mobile-verified.
- Room `1` can publish exactly `HIGH+LOW` with Dynacast/backup codec off and subscriber `HIGH` ceilings; it has no retained real media frame.
- Room `1` C+B reparenting remains uncalibrated. Deployed admission rescue promotes an unassigned one-slot relay over the oldest childless zero-capacity Host leaf, with no scores or periodic optimization.
- Web opt-in roster code includes Host self-name, but the Host display-name change is source-only/not deployed; Native wire/media remains unchanged.

## Verified Evidence

- Historical `31bee238` deployment passed 28 files/421 tests and both builds; no real admission rescue was triggered.
- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- SVC is `no-go-web-svc-cross-path-hardware-contract`: no direct/peer selection, cross-PC shared encode, or portable hardware proof; pinned screen share is `L1T3`. No browser run was warranted.
- The `a11a73d` built-in TURN canary is rejected: local allocation passed, but direct Host/Pion Viewer failed before forced relay. Full rollback restored STUN-only client ICE and zero allocations.
- Native loopbacks (Chrome 151): VP8 299 decoded; H.264 opt-in 299 decoded/298 rendered at 1280x720, with no fatal/encoder errors. H.264 Annex-B; hardware preference is not proof. Pion timing and multi-viewer/FIFO/endurance/public/native proof remain open; production stays VP8.
- Access protocol/config/HTTP/storage/SQLite/signaling focused tests pass, including commit-first teardown and v1 rollback.
- Source adds selected Host ingress + peer last-mile for every enabled room; Peer ICE STUN-only; focused routing/config tests pass.
- The `61a87ae` Host-name artifact was rolled back after a stale restart-count assertion; `fdd14ba` is healthy and Host display-name remains source-only. Selected-edge TURN is disabled.

## Unverified Boundaries

- Room 1 proved LiveKit participant entry but not a retained SFU frame, retry/failback, selected UDP pair, admission rescue, edge cap, quality, or resource deltas. Former game-share load/blur remains unclassified.
- Android Chrome/iOS Safari Viewer leaves remain unverified and conservatively leaf-only. Mobile Web Host is unsupported; native senders are planned only.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio and heterogeneous clients remain unverified. System capture can lose film audio or echo voice calls; Web has no process isolation. Diagnose A/B/C and sync; gate Windows 11 game audio; Windows 10 unresolved.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- ADR-0006 has one Viewer proof; two-edge/FIFO, physical hardware, endurance, public, packaged-native, and browser-diversity proof remain open.
- Browser fanout is host two/viewer one; any accepted endpoint relay stays capped at two downstream edges.
- PR #49/#50 BWE is unverified/default-off: test zero-child leaves, then root impact. No local per-leaf UDP shaper; resume with Linux `tc` or public canary, never CDP. Web P2P/SVC shortcuts remain no-go.
- The corrected standby smoke is localhost/headless/video-only; public DNS/TLS reuse, transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.
- Headful fragment-to-sessionStorage consumption, invitation rotation after migration, and request/log leak inspection remain production UX gates. Accounts stay out.

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
Audio A/B/C may proceed without displacing P0.
Ordinary Peer ICE stays STUN-only; participant-wide TURN is removed. Selected-edge
is source-complete/default-off/undeployed; Host ingress still needs one forced-relay
canary before activation. Retained performance/resource benchmarks follow landing.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix. A separate
20-viewer gate must pass before the current default eight changes to target 20.

ADR-0004 remains fail-closed; Native/striping experiments cannot relabel it.

## Blockers And Decisions

ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets,
host/provider UDP 7882 and bounded services are deployed, but real external
media/device evidence is absent. Shared IP remains smoke-only and cannot approve
clean-port migration; the full gate still needs an isolated VM/IP.
Deferred architecture audit: `docs/maintenance.md`.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
