# Current Status

Last updated: 2026-08-19

## Phase

`https://share.bonfire.icu` runs `769de201f7cc` with simplified entry, bounded
clarity-first controls, persistent rooms, and reusable links. Peer/LiveKit is
unconfigured, so production remains one host connection per viewer and P2P/TURN.

## Current Snapshot

- Capture precedes room creation; live source/quality changes preserve peers and picture pause keeps audio/connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Current runtime still uses optional `ACCESS_PASSWORD` and one stateless 12-hour HMAC HttpOnly Strict cookie for both roles; Host auth stays internal and signaling role-bound.
- Current SQLite still stores only room ID and Host-token digest. Amended ADR-0002 accepts a later atomic `HOST_ADMISSION_PASSWORD`/`screener-v2` migration with default room-scoped private Viewer grants, explicit public-watch, rotate/revoke, and one nullable digest column; no runtime is implemented.
- PR #44 merged the default-off exact-room candidate code: ordinary ICE is process-wide STUN-only, LiveKit SFU/UDP feeds at most two roots, browser relays stay at one child, the host stays at two, and exhaustion fails boundedly. Old production/coturn remains rollback; HTTPS/WSS stays TLS/TCP.
- Fallback prewarm is token-free and dormant without configuration. Mobile/iPad viewers are leaves and healthy edges stay sticky.
- Manual readback and read-only A+B/C exist; dual publication/topology classification do not. Always-on `LOW` needs exactly-two, hardware, game, and upload gates. Browser audio is request/presence-only.
- A later explicit fallback evacuates first. Autonomous BWE enters `suspect`; confirmation evacuates children, and no confirmed `FALLBACK` parent remains. Root impact is a default-on gate; self-report alone cannot trigger it.

## Verified Evidence

- Release `769de201f7cc` passed CI/hygiene/typecheck, 274 tests, both builds, zero production dependency vulnerabilities, atomic health/access/bundle/SQLite/service/log checks, and responsive 320/375/390 px checks without live media; rollback is ready.
- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- Chrome 151/LiveKit localhost A/B measured cold active/render at 1.481/2.257 seconds versus standby 0.200/0.320 with host edges at two. It includes SDK/prewarm and is not public-network evidence.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- SVC is `no-go-web-svc-cross-path-hardware-contract`: no direct/peer selection, cross-PC shared encode, or portable hardware proof; pinned screen share is `L1T3`. No browser run was warranted.
- HTTPS/WSS, access and room/WebSocket auth, renewal, public STUN, and authenticated TURN/UDP/TCP relay-only paths pass; TURN/TLS is off.
- Draft #16/#18/#22/#23/#25/#28 passed isolated experiments only. ADR-0006 reached host setup/one encoder output, then timed out before viewer 1 decoded/rendered.

## Unverified Boundaries

- Full-resolution 30-minute runs, relay CPU/GPU, controlled loss/RTT, and depth latency are unverified. Production `769de201f7cc` game sharing is reported low-FPS/high-load; latest `main`, preview cost, codec, and hardware encoding are not yet compared.
- Android Chrome/iOS Safari leaves are unverified; runtime conservatively marks detected mobile/iPad clients as leaves.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio and heterogeneous clients remain unverified. Production reports poor film audio and voice-call self-echo under system capture; there is no app audio ceiling or Web process isolation. Diagnose A/B/C and sync, then gate Windows 11 game-process audio; Windows 10 stays unresolved without system fallback.
- Production `769de201f7cc` reportedly sustains bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not, and persistence across churn was also reported. This prioritizes, but does not prove, host sender/PC/GCC/capture generation.
- Browser relays re-encode. ADR-0006 is no-go-unclassified: downstream checkpoints and two-edge/FIFO/TURN gates are absent. Spikes prove one WebCodecs object, not hardware; GCC+RTX is no-go and no-RTX weakens stats.
- Browser fanout is host two/viewer one; any accepted endpoint relay stays capped at two downstream edges.
- ADR-0007/SFU C are incomplete. Next is LiveKit exactly-two BWE on SFU leaves, then root suspect/evacuation. Web P2P/current SVC shortcuts are no-go; publishing is non-simulcast/Dynacast-off.
- The corrected standby smoke is localhost/headless/video-only; public DNS/TLS reuse, transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.
- Scoped Viewer access is designed but unimplemented. Tests owe role bounds, fragment clearing/no-leak, expiry/cross-room/rotate/revoke, v1 tab termination, and SQLite locked migration/restore. Human passwords/accounts stay out.

## Next Milestone

Use correlated Host A+B/Viewer C to compare exact production and current `main` on one wired/direct
game fixture. Record actual codec/encoder, game FPS, CPU/GPU, preview on/off and
A+B while separately rebuilding one `HostPeer`, replacing capture, and fully
refreshing Host. Only a proven stuck generation justifies guarded recovery; never
reconnect periodically, force AV1, or raise ceilings blindly.

The bounded SVC capability gate is closed statically. After that reproduction,
gate LiveKit exactly-two/Dynacast-off BWE on zero-descendant SFU leaves, then
bound root-with-children downshift/evacuation. Prove healthy `HIGH`, hardware,
game, upload, and received layers. Explicit quality, manual activation, and
custom/native are later fallbacks.
Diagnose audio A/B/C,
sync, and voice-source leakage in parallel when it does not displace that P0;
`maxBitrate` is not a quality fix. WebRTC/LiveKit owns congestion/layers; the app
owns evidence and topology guardrails. An isolated exact room later gates peer/SFU UDP and
bounded failure before replacing the old release. Selected-edge TURN, if later
justified, is a separate complete change rather than part of this canary.
Candidate UI has volume, room-code copy and favicon; names/roster/diagnostics remain.
After the current media acceptance boundary, implement amended ADR-0002 as one
atomic access PR; do not combine it with username/roster runtime or preserve the
old config, cookie, protocol, or SQLite parser.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix. A separate
20-viewer gate must pass before the current default eight changes to target 20.

Observed disconnects retain 5-second grace plus at most 3 seconds to a decodable
picture; silent partitions add detection delay.

ADR-0004 fails closed. Native shared encode and packet/layer striping remain
separate experiments, not ways to relabel a failed browser route.

## Blockers And Decisions

ADR-0004/0005 remain No-Go. Public canary lacks candidate DNS/TLS,
host/security-group access, independent LiveKit secrets, verified UDP
7882/resources, and external devices. Shared IP is smoke-only and cannot
approve clean-port migration; the full gate needs an isolated VM/IP.
Deferred architecture audit: `docs/maintenance.md`.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
