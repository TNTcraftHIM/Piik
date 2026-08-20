# Current Status

Last updated: 2026-08-20

## Phase

`https://share.bonfire.icu` runs `d4bc421828c4b74f55195723aace290ffc0e5f9d`
since 2026-08-20 11:41:22 +08 with neutral anonymous entry, initial-connect
recovery, and local quality reparenting.
Ordinary ICE is STUN-only process-wide; persistent room `1` alone enables the
automatic peer/SFU-UDP controller with at most two SFU roots. The old
`05f98d10ecd1` is the immediate rollback with the current v2 DB/env. Crossing
the admission cutover requires `89e6d7649169` plus its recorded old environment;
only deeper pre-access `9610032` may restore v1 state. Source `main` at `f5d48ed`
also contains a no-go Native v2 candidate, but production does not run it.

## Current Snapshot

- Capture precedes room creation; source/quality changes preserve peers and pause keeps audio/connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Production requires `HOST_ADMISSION_PASSWORD` only for creation/Host role and uses `screener-v2`, default private fragment grants, explicit public-watch, and generation-bound rotate/revoke. Viewers never need the Host secret; there is no account/session table or old parser.
- SQLite v2 keeps Host and nullable Viewer-grant digests in one checked `STRICT` row. The stopped migration retained four rooms and locked each old room private without minting a raw grant.
- Source-only Native v2 uses memory-only rooms, 300s post-disconnect reclaim and `ROOM_TTL`; it has no production gate.
- PR #44's exact-room STUN-only/SFU-UDP router is enabled only for production room `1`: host/SFU roots <=2, browser relay <=1, bounded failure. HTTPS/WSS stays TLS/TCP.
- Fallback prewarm is token-free and limited to room `1`; mobile/iPad viewers are leaves and healthy edges stay sticky.
- After an answer, a generation-bound 15s initial-connect deadline enters ICE restart; success/replacement/disposal cancels it. It is deployed but not mobile-verified.
- Room `1` can publish exactly `HIGH+LOW` with Dynacast/backup codec off and subscriber `HIGH` ceilings; it has no retained real media frame.
- Room `1` quality reparenting needs three C+B hard-bad pairs, reuses peer/SFU/failure and has one room cooldown; single-side reports do nothing. Thresholds need calibration.
- Source-only roster; Native wire/media unchanged.

## Verified Evidence

- `d4bc421` passed 25 files/378 tests, typecheck and builds. The 760ms switch preserved 200 health/`index-YdNLg2E8.js`, SQLite v2/four rooms/room `1`, 0/0 service restarts, and unchanged environment/nginx/LiveKit hashes. Artifact SHA-256: `3F8CF25F8D989CBDF38DBBCAC4A261C349E44B72D274A944B877540056171A08`.
- The `05f98d1` access cutover passed 25 files/369 tests; four anonymous Chrome routes stayed neutral, the current key returned 200, and former/incorrect keys returned 401. Exact rollback and the contained assertion-output incident are in `docs/deployment.md`.
- At 11:44:15 Screener/LiveKit used 39,198,720/79,269,888 bytes; cgroup high/max/OOM and error journals were zero. No real room triggered reparenting, so this proves deployment only.
- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- A mobile-network room-1 run produced two root participants for about 4.6 seconds and two short Host participants (about 0.46/0.27 seconds), all client-requested leaves, with zero service restarts and no retained track. This is consistent with the code's one fresh-grant retry and Peer failback, but logs cannot prove those transitions. The deployed Host now shows only the local failure stage.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- SVC is `no-go-web-svc-cross-path-hardware-contract`: no direct/peer selection, cross-PC shared encode, or portable hardware proof; pinned screen share is `L1T3`. No browser run was warranted.
- HTTPS/WSS, room/WebSocket authorization, renewal, and public STUN pass. Current media has no TURN credential wire.
- Draft #16/#18/#22/#23/#25/#28 passed isolated experiments only. ADR-0006 reached host setup/one encoder output, then timed out before viewer 1 decoded/rendered.
- Access focused tests pass protocol/config/HTTP/storage/RoomStore/SQLite/signaling, including commit-first teardown, persistence-failure continuity, relay/SFU retirement, grant bounds, and v1 migration rollback.

## Unverified Boundaries

- Room 1 proved LiveKit participant entry but not a retained SFU Viewer frame, exact retry/failback transition, selected UDP pair, edge cap, quality or resource deltas. Former game-share load/blur remains unclassified.
- Android Chrome/iOS Safari Viewer leaves remain unverified and conservatively leaf-only. Mobile Web Host is unsupported; native senders are planned only.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio and heterogeneous clients remain unverified. Production reports poor film audio and voice-call self-echo under system capture; there is no app audio ceiling or Web process isolation. Diagnose A/B/C and sync, then gate Windows 11 game-process audio; Windows 10 stays unresolved without system fallback.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- ADR-0006 stays no-go: its v2 memory-only candidate passed static checks only; render, two-edge/FIFO and later TURN remain unverified.
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
evacuation. Native v2 remains no-go pending an authorized runtime gate; Audio
A/B/C may proceed without displacing P0.
TURN remains a future selected-edge change, not this canary.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix. A separate
20-viewer gate must pass before the current default eight changes to target 20.

ADR-0004 fails closed. Native shared encode and packet/layer striping remain
separate experiments, not ways to relabel a failed browser route.

## Blockers And Decisions

ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets,
host/provider UDP 7882 and bounded services are deployed, but real external
media/device evidence is absent. Shared IP remains smoke-only and cannot approve
clean-port migration; the full gate still needs an isolated VM/IP.
Deferred architecture audit: `docs/maintenance.md`.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
