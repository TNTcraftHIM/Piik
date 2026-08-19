# Current Status

Last updated: 2026-08-20

## Phase

`https://share.bonfire.icu` runs `bbe4654a7a9b10b1bdcc839665932020b7f31e8b`
since 2026-08-20 03:06 +08 as a shared-IP production smoke. It includes
room-scoped Viewer access and the bounded SFU failure-stage diagnostic.
Ordinary ICE is STUN-only process-wide; persistent room `1` alone enables the
automatic peer/SFU-UDP controller with at most two SFU roots. The old
`9610032fc5f5` release, v1 backup, and coturn relay remain rollback-only.
Coherent low-risk milestones may deploy after narrow tests, independent review,
one full gate, CI and rollback preflight; protocol/database changes stay atomic.

## Current Snapshot

- Capture precedes room creation; live source/quality changes preserve peers and picture pause keeps audio/connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Production requires `HOST_ADMISSION_PASSWORD` only for creation/Host role and uses `screener-v2`, default private fragment grants, explicit public-watch, and generation-bound rotate/revoke. Viewers never need the Host secret; there is no account/session table or old parser.
- SQLite v2 keeps Host and nullable Viewer-grant digests in one checked `STRICT` row. The stopped migration retained four rooms and locked each old room private without minting a raw grant.
- PR #44's exact-room STUN-only/SFU-UDP router is enabled only for production room `1`: host/SFU roots <=2, browser relay <=1, bounded failure. HTTPS/WSS stays TLS/TCP.
- Fallback prewarm is token-free and limited to room `1`; mobile/iPad viewers are leaves and healthy edges stay sticky.
- Room `1` can publish exactly `HIGH+LOW` with Dynacast/backup codec off and subscriber `HIGH` ceilings; it has no retained real media frame.
- A+B/P2P C remains read-only. Autonomous BWE is only `suspect`; confirmed fallback evacuates children and loses parent capacity. Root impact remains a default-on gate.

## Verified Evidence

- `bbe4654` passed 365 tests/builds and an atomic v1-to-v2 production migration. Local/public health, `index-uCv4ooZJ.js`, nginx, Host admission, and cookie-free private Viewer denial pass; room `1` remains. LiveKit was not restarted; unversioned `/rtc` paths and unauthenticated `/rtc/v1` return 404 outside the SPA.
- A rejected artifact reused hard-linked dependencies; its permission change made rollback unreadable for 3m11s and restart attempts peaked at 52. Restoring ownership recovered `9610032`; the successful artifact has zero shared regular-file inodes. Immutable releases now forbid this reuse.
- On the 960 MiB host, idle LiveKit peaked near 16 MiB with no cgroup high/max/OOM event under `MemoryHigh=192M`, `MemoryMax=256M`, swap disabled and restart disabled. This is containment/idle evidence, not media capacity.
- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- A mobile-network room-1 run produced two root participants for about 4.6 seconds and two short Host participants (about 0.46/0.27 seconds), all client-requested leaves, with zero service restarts and no retained track. This is consistent with the code's one fresh-grant retry and Peer failback, but logs cannot prove those transitions. The deployed Host now shows only the local failure stage.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- SVC is `no-go-web-svc-cross-path-hardware-contract`: no direct/peer selection, cross-PC shared encode, or portable hardware proof; pinned screen share is `L1T3`. No browser run was warranted.
- HTTPS/WSS, Host admission, room/WebSocket authorization, renewal, and public STUN checks pass. Current media has no TURN credential wire; coturn relay evidence belongs only to rollback.
- Draft #16/#18/#22/#23/#25/#28 passed isolated experiments only. ADR-0006 reached host setup/one encoder output, then timed out before viewer 1 decoded/rendered.
- Access focused tests pass protocol/config/HTTP/storage/RoomStore/SQLite/signaling, including commit-first teardown, persistence-failure continuity, relay/SFU retirement, grant bounds, and v1 migration rollback.

## Unverified Boundaries

- Room 1 proved LiveKit participant entry but not a retained SFU Viewer frame, exact retry/failback transition, selected UDP pair, edge cap, quality or resource deltas. Former game-share load/blur remains unclassified.
- Android Chrome/iOS Safari Viewer leaves remain unverified and conservatively leaf-only. Mobile Web Host is unsupported; native senders are planned only.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio and heterogeneous clients remain unverified. Production reports poor film audio and voice-call self-echo under system capture; there is no app audio ceiling or Web process isolation. Diagnose A/B/C and sync, then gate Windows 11 game-process audio; Windows 10 stays unresolved without system fallback.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- Browser relays re-encode. ADR-0006 is no-go-unclassified: downstream checkpoints and two-edge/FIFO/TURN gates are absent. Spikes prove one WebCodecs object, not hardware; GCC+RTX is no-go and no-RTX weakens stats.
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
evacuation. In parallel, migrate the native staged gate to v2;
username/roster stays separate. Audio A/B/C may run without displacing P0.
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
