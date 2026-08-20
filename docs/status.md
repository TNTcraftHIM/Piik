# Current Status

Last updated: 2026-08-20

## Phase

`https://share.bonfire.icu` runs `31bee238bc1e901e823f34e50737e202dc4b04bf`
since 2026-08-20 15:33:21 +08 with Viewer presence, initial-connect recovery,
local quality reparenting, and deterministic relay-admission rescue.
Ordinary ICE is STUN-only process-wide; persistent room `1` alone enables the
automatic peer/SFU-UDP controller with at most two SFU roots. The old
`7fea60ef6f2a` is the immediate rollback with the current v2 DB/env; older
schema rollback boundaries are in `docs/deployment.md`. Native remains no-go
and is not part of production.

## Current Snapshot

- Capture precedes room creation; source/quality changes preserve peers and pause keeps audio/connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Production requires `HOST_ADMISSION_PASSWORD` only for creation/Host role and uses `screener-v2`, default private fragment grants, explicit public-watch, and generation-bound rotate/revoke. Viewers never need the Host secret; there is no account/session table or old parser.
- SQLite v2 keeps Host and nullable Viewer-grant digests in one checked `STRICT` row. The stopped migration retained four rooms and locked each old room private without minting a raw grant.
- Source-only Native v2 uses memory-only rooms, 300s reclaim and `ROOM_TTL`; production does not run it.
- PR #44's exact-room STUN-only/SFU-UDP router is enabled only for production room `1`: host/SFU roots <=2, browser relay <=1, bounded failure. HTTPS/WSS stays TLS/TCP.
- Fallback prewarm is token-free and limited to room `1`; mobile/iPad viewers are leaves and healthy edges stay sticky.
- After an answer, a generation-bound 15s initial-connect deadline enters ICE restart; success/replacement/disposal cancels it. It is deployed but not mobile-verified.
- Room `1` can publish exactly `HIGH+LOW` with Dynacast/backup codec off and subscriber `HIGH` ceilings; it has no retained real media frame.
- Room `1` C+B reparenting remains uncalibrated. Deployed admission rescue promotes an unassigned one-slot relay over the oldest childless zero-capacity Host leaf, with no scores or periodic optimization.
- Viewer names/true Host roster are deployed; Native wire/media remains unchanged.

## Verified Evidence

- `31bee238` passed 28 files/421 tests and both builds. Health returned in 560.607 ms; observed downtime was 437.137 ms. Health/assets/routes, SQLite v2/four rooms/room `1`, and unchanged config/network gates passed. No real room triggered admission rescue.
- At 15:39:07 Screener used 38,031,360 bytes with zero cgroup events. All four services were active with zero automatic restarts; only Screener had the planned restart.
- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- A mobile-network room-1 run produced two root participants for about 4.6 seconds and two short Host participants (about 0.46/0.27 seconds), all client-requested leaves, with zero service restarts and no retained track. This is consistent with the code's one fresh-grant retry and Peer failback, but logs cannot prove those transitions. The deployed Host now shows only the local failure stage.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- SVC is `no-go-web-svc-cross-path-hardware-contract`: no direct/peer selection, cross-PC shared encode, or portable hardware proof; pinned screen share is `L1T3`. No browser run was warranted.
- The `a11a73d` built-in TURN canary is rejected: local allocation passed, but direct Host/Pion Viewer failed before forced relay. Full rollback restored STUN-only client ICE and zero allocations.
- Native remains no-go after one post-fix gate: fixed VP8, one encoder and one generation-1 binary send returned, but Go frame/RTP stayed zero; no Viewer was created. Cleanup passed; no retry followed. The fixed bridge fatal was not retained, so the send-to-Go interval and MF H.264 Viewer interop remain unproven.
- Access protocol/config/HTTP/storage/SQLite/signaling focused tests pass, including commit-first teardown and v1 rollback.

## Unverified Boundaries

- Room 1 proved LiveKit participant entry but not a retained SFU Viewer frame, exact retry/failback transition, selected UDP pair, admission-rescue transition, edge cap, quality or resource deltas. Former game-share load/blur remains unclassified.
- Android Chrome/iOS Safari Viewer leaves remain unverified and conservatively leaf-only. Mobile Web Host is unsupported; native senders are planned only.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio and heterogeneous clients remain unverified. Production reports poor film audio and voice-call self-echo under system capture; there is no app audio ceiling or Web process isolation. Diagnose A/B/C and sync, then gate Windows 11 game-process audio; Windows 10 stays unresolved without system fallback.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- ADR-0006 still has no Viewer, two-edge, or FIFO proof.
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
evacuation. Native is stopped after browser send return but zero Go frame/RTP;
classify that interval in a separate fix slice before any new run.
Audio A/B/C may proceed without displacing P0.
Ordinary Peer ICE stays STUN-only. Participant-wide TURN source and wire are
removed; stale `PEER_ICE_TURN_*` keys fail startup even blank. Selected-edge TURN
is unimplemented and undeployed. After SFU/UDP, bind one selected parent/child
rebuild to current generations before one forced-relay canary; do not repeat the
built-in direct canary.

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
