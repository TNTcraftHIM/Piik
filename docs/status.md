# Current Status

Last updated: 2026-08-19

## Phase

`https://share.bonfire.icu` runs `769de201f7cc` with simplified entry, bounded
quality controls, and persistent links. Peer/LiveKit is off; production remains
one host connection per viewer with per-edge P2P/TURN.

## Current Snapshot

- Capture precedes room creation; source/quality changes preserve peers, and picture pause keeps audio/connections. Quality defaults to `maintain-resolution`.
- Optional access uses a stateless 12-hour HMAC HttpOnly Strict cookie; host auth is internal and signaling role-bound.
- Rooms are temporary without `ROOM_DATABASE_PATH`; password plus SQLite persists sequential links and only room ID/host-token digest.
- Direct ICE is preferred per edge; authenticated TURN/UDP and TURN/TCP are required fallbacks. TURN/TLS is optional.
- Hidden routing is `direct P2P -> peer-assisted -> optional SFU roots`; exact-room canaries use `PEER_ASSISTED_ROOM_IDS`, and production is off.
- Configured fallback exposes only a non-secret standby URL and token-free DNS/TLS warmup; absent configuration adds no runtime path.
- Relay capacity is host 2/browser 1; detected mobile/iPad clients are leaves, and withdrawal does not move a healthy edge.
- Video settings are memory-only/manual. Accepted per-path `HIGH`/`FALLBACK` plus one shared on-demand `LOW` is not deployed; host A+B exists, C/actions do not. Audio is request/presence-only.

## Verified Evidence

- Release `769de201f7cc` passed CI/hygiene/typecheck, 22 files/274 tests, both builds, and zero production dependency vulnerabilities.
- Chrome 151 synthetic `1/3/5/8` kept host/relay edges at 2/1 and all viewers decoding; slowest first frame was 1.05 seconds and one three-viewer relay close recovered in 5.32 seconds.
- Synthetic Chrome 151 720p30 propagated balanced/clarity to one host and three viewers without peer changes; decoding and 2/1 fanout continued. This proves control continuity only.
- Chrome 151/LiveKit localhost A/B measured cold active/render at 1.481/2.257 seconds versus standby 0.200/0.320 with host edges at two. It includes SDK/prewarm and is not public-network evidence.
- Activation passed health/access, exact bundle, SQLite preservation, services, and logs; rollback is ready. Static 320/375/390 px checks passed.
- Host A+B binds capture to one unique outbound RTP, interval/deltas, `remoteId`, path, and same-transport nullable codec/profile/fmtp/`scalabilityMode`. It stores no raw fmtp/SDP/stats and infers no quality/capability; stale, ambiguous, reset, and cross-transport evidence stays unknown. Review found P1/P2=0; 22 files/299 tests and both builds passed.
- HTTPS/WSS, access and room/WebSocket auth, renewal, public STUN, and authenticated TURN/UDP/TCP relay-only paths pass; TURN/TLS is off.
- Draft native ladder #16/#18/#22/#23/#25/#28 passed one bounded 720p30 two-leg loop with an experiment-only minimum GCC target and one recovered loss; it is not product behavior.

## Unverified Boundaries

- Full-resolution 30-minute runs, relay CPU/GPU, generational quality, controlled loss/RTT, depth latency, and game capture are unverified.
- Android Chrome/iOS Safari leaves are unverified; runtime conservatively marks detected mobile/iPad clients as leaves.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio, heterogeneous clients, mobile lifecycle, quality/pause, room `1` republish, and sustained profiles are unverified. Reported poor movie/video audio needs capture, codec/fmtp, bitrate, loss/jitter/concealment/buffer, and A/V-sync evidence.
- Production reportedly stays bandwidth-limited and blurred for one capable LAN/direct viewer until Host refresh. Viewer refresh retains its peer during grace; Host refresh rebuilds peers/capture. This prioritizes, but does not prove, a sender/PC/GCC/capture-generation cause.
- ADR-0007 lacks verified browser codec evidence for the reported case, authenticated C, controller, and `LOW`. Weak paths share one `LOW`; an unreliable supported cohort fails acceptance.
- Browser relays re-encode. The native ladder proves one WebCodecs object, not hardware encode. GCC+RTX is no-go; no-RTX weakens stats. Broader audio/loss/routes/reconnect/browser/product/striping gates remain.
- The endpoint budget remains host/relay at most two downstream edges; the browser path is host two/viewer one.
- ADR-0005 permits SFU only after peer failure. Stable dual-TURN roots are shadow-only; exact-room TURN-root/SFU-root cost, recovery, and trust evidence is absent.
- Pinned LiveKit 1.13.5 Dynacast likely keeps `LOW` enabled under a `HIGH` maximum; this is a rejection/verification spike, not stop-on-recovery evidence.
- The corrected standby smoke is localhost/headless/video-only; public DNS/TLS reuse, transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.
- ADR-0006's sole fixed-`HIGH` product gate reached host setup and one encoder output, then timed out before viewer 1 decoded/rendered. Downstream checkpoints were lost, so it is no-go-unclassified; no native product path is accepted.

## Next Milestone

Use host A+B to reproduce the same-LAN/direct case. Rebuild one affected
`HostPeer`/`connectionId` while retaining capture/healthy peers, then compare
capture-only and full Host rebuilds with A+B/C evidence. Recovery must preserve
healthy peers and the edge cap; only proven stuck generations justify guarded,
cooldown recovery.

Then run the separate audio A/B/C and sync diagnosis; `maxBitrate` is not a
quality fix. Next add authenticated video C, the two-state controller, and
on-demand shared `LOW`. Route work starts with manual ICE truth and shadow-only
TURN-root/SFU-root comparisons.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix.

Observed disconnects retain 5-second grace plus at most 3 seconds to a decodable
picture; silent partitions add detection delay.

ADR-0004 fails closed. Native shared encode and packet/layer striping remain
separate experiments, not ways to relabel a failed browser route.

The native ladder stops at #28; minimum-of-two is not a product candidate and
stock GCC/RTX must not be bypassed. ADR-0006 stays paused at no-go. Any new run
needs separate authorization and retained host, bridge/RTP, signaling/PC,
decode, and render checkpoints before adding viewers 2/3 or TURN.

## Blockers And Decisions

Peer assistance and automatic routing remain No-Go until ADR-0004/0005 pass.
Without LiveKit, two mobile leaves can fill both host roots; use an isolated
exact-room canary only.
Native shared encode is no-go-unclassified; striping remains separate research.
Deferred architecture audit: `docs/maintenance.md`.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
- Whether peer assistance passes every non-encoding gate; any failure closes it.
