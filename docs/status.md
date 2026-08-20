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
Ordinary ICE is STUN-only process-wide; persistent room `1` alone enables the
automatic peer/SFU-UDP controller with at most two SFU roots. The old
`fdd14ba0d9b5` is the healthy v3 rollback target; older schema details are in
`docs/deployment.md`. Native is no-go and not in production.

## Current Snapshot

- Capture precedes room creation; source/quality changes preserve peers and pause keeps audio/connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Production access is `screener-v2`: Host admission, private grants/passwords, and public codes authorize Viewers. SQLite v3 retains four rooms and checked material; raw credentials are never stored.
- The Host display-name change is source-only after the failed `61a87ae` activation; it did not alter the deployed wire or UI.
- Source-only Native v2 uses memory-only rooms, 300s reclaim and `ROOM_TTL`; production does not run it.
- PR #44's exact-room STUN-only/SFU-UDP router is enabled only for production room `1`: host/SFU roots <=2, browser relay <=1, bounded failure. HTTPS/WSS stays TLS/TCP.
- Fallback prewarm is token-free and limited to room `1`; mobile/iPad viewers are leaves and healthy edges stay sticky.
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
- Native VP8 loopback (Chrome 151) reached one Viewer: 30 sender frames, 85 source RTP packets, 877 inbound packets, 299 decoded/rendered at 1280x720, no fatal. Pion outbound delta missed a 2s refresh; hardware/multi-viewer/FIFO/endurance/public/native proof remains open.
- Access protocol/config/HTTP/storage/SQLite/signaling focused tests pass, including commit-first teardown and v1 rollback.
- Source adds room-1 Host ingress + peer last-mile; Peer ICE STUN-only; 160 tests pass.
- Prepared artifact `screener-61a87ae47e38abc943cef47b3d7318bb51bf86d6-20260820T143538Z.tar.gz` (883597 bytes, SHA-256 `d5b4d6cc567ba96ce37f8eb9934dd5822c64dc084796047d5f6d6217e2e74acb`) was the sole Host-name cutover candidate. Its prepare-to-release and health gates passed before the stale restart-count assertion caused automatic rollback; `fdd14ba` is healthy with all four service restart counts at 0, and Host display-name remains source-only. Selected-edge TURN is disabled.

## Unverified Boundaries

- Room 1 proved LiveKit participant entry but not a retained SFU Viewer frame, exact retry/failback transition, selected UDP pair, admission-rescue transition, edge cap, quality or resource deltas. Former game-share load/blur remains unclassified.
- Android Chrome/iOS Safari Viewer leaves remain unverified and conservatively leaf-only. Mobile Web Host is unsupported; native senders are planned only.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio and heterogeneous clients remain unverified. Production reports poor film audio and voice-call self-echo under system capture; there is no app audio ceiling or Web process isolation. Diagnose A/B/C and sync, then gate Windows 11 game-process audio; Windows 10 stays unresolved without system fallback.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- ADR-0006 has one Viewer decode/render proof; two-edge/FIFO/hardware/endurance/public remain open.
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
duration; one VP8 Viewer decode/render run is recorded. Next prove fresh Pion
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
