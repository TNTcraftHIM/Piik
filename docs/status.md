# Current Status

Last updated: 2026-08-20

## Phase

`https://share.bonfire.icu` runs `d6c8aa06dbd` as a shared-IP production smoke.
Ordinary ICE is STUN-only process-wide; persistent room `1` alone enables the
automatic peer/SFU-UDP controller with at most two SFU roots. The old
`769de201f7cc` release and coturn relay remain an isolated rollback path.
Coherent low-risk milestones may deploy after narrow tests, independent review,
one full gate, CI and rollback preflight; protocol/database changes stay atomic.

## Current Snapshot

- Capture precedes room creation; live source/quality changes preserve peers and picture pause keeps audio/connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Current runtime still uses optional `ACCESS_PASSWORD` and one stateless 12-hour HMAC HttpOnly Strict cookie for both roles; Host auth stays internal and signaling role-bound.
- Current SQLite still stores only room ID and Host-token digest. Amended ADR-0002 accepts a later atomic `HOST_ADMISSION_PASSWORD`/`screener-v2` migration with default room-scoped private Viewer grants, explicit public-watch, rotate/revoke, and one nullable digest column; no runtime is implemented.
- PR #44's exact-room STUN-only/SFU-UDP router is enabled only for production room `1`: host/SFU roots <=2, browser relay <=1, bounded failure. HTTPS/WSS stays TLS/TCP.
- Fallback prewarm is token-free and limited to room `1`; mobile/iPad viewers are leaves and healthy edges stay sticky.
- Room `1` can publish exactly `HIGH+LOW` with Dynacast/backup codec off and subscriber `HIGH` ceilings; it has no retained real media frame.
- A+B/P2P C remains read-only. Autonomous BWE is only `suspect`; confirmed fallback evacuates children and loses parent capacity. Root impact remains a default-on gate.

## Verified Evidence

- `d6c8aa0` passed typecheck, 330 tests and both builds, then an atomic production switch with SQLite integrity/room-1 preservation. Node, nginx, coturn and pinned LiveKit 1.13.5 are active with zero restarts; health is 200, retired `/rtc*` is 404, and public TCP 7880/7881 is blocked. Rollback is ready.
- On the 960 MiB host, idle LiveKit peaked near 16 MiB with no cgroup high/max/OOM event under `MemoryHigh=192M`, `MemoryMax=256M`, swap disabled and restart disabled. This is containment/idle evidence, not media capacity.
- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- A mobile-network room-1 run produced two root participants for about 4.6 seconds and two short Host participants (about 0.46/0.27 seconds), all client-requested leaves, with zero service restarts and no retained track. This is consistent with the code's one fresh-grant retry and Peer failback, but logs cannot prove those transitions. The next candidate shows only the local failure stage.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- SVC is `no-go-web-svc-cross-path-hardware-contract`: no direct/peer selection, cross-PC shared encode, or portable hardware proof; pinned screen share is `L1T3`. No browser run was warranted.
- HTTPS/WSS, access and room/WebSocket auth, renewal, public STUN, and authenticated TURN/UDP/TCP relay-only paths pass; TURN/TLS is off.
- Draft #16/#18/#22/#23/#25/#28 passed isolated experiments only. ADR-0006 reached host setup/one encoder output, then timed out before viewer 1 decoded/rendered.

## Unverified Boundaries

- Room 1 proved LiveKit participant entry but not a retained SFU Viewer frame, exact retry/failback transition, selected UDP pair, edge cap, quality or resource deltas. Former game-share load/blur remains unclassified.
- Android Chrome/iOS Safari Viewer leaves remain unverified and conservatively leaf-only. Mobile Web Host is unsupported; native senders are planned only.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio and heterogeneous clients remain unverified. Production reports poor film audio and voice-call self-echo under system capture; there is no app audio ceiling or Web process isolation. Diagnose A/B/C and sync, then gate Windows 11 game-process audio; Windows 10 stays unresolved without system fallback.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- Browser relays re-encode. ADR-0006 is no-go-unclassified: downstream checkpoints and two-edge/FIFO/TURN gates are absent. Spikes prove one WebCodecs object, not hardware; GCC+RTX is no-go and no-RTX weakens stats.
- Browser fanout is host two/viewer one; any accepted endpoint relay stays capped at two downstream edges.
- Room-1 BWE is unverified: test zero-child leaves, then root impact. Use Linux `tc` or public canary, never CDP; Web P2P/SVC shortcuts remain no-go.
- Scoped Viewer access runtime is under final review and is not deployed. Human passwords/accounts stay out.

## Next Milestone

Deploy the bounded SFU-stage diagnostic and repeat room 1 once. Fix only the
identified connect/source/video-publish/sender-config/audio/transport layer,
then retain selected UDP, a decoded/rendered frame, edge caps and resource deltas.
The recovery target uses one ICE restart, one same-parent rebuild, one alternate peer, then
SFU; it never runs three identical retries or abandons progressing P2P early.

Next gate exactly-two/Dynacast-off BWE on a zero-child SFU leaf, then root
evacuation. In parallel, finish the atomic ADR-0002 access PR and native staged
gate; username/roster stays separate. Audio A/B/C may run without displacing P0.
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
