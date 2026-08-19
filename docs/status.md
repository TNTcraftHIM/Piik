# Current Status

Last updated: 2026-08-19

## Phase

`https://share.bonfire.icu` runs `769de201f7cc` with simplified entry, bounded
clarity-first controls, persistent rooms, and reusable links. Peer/LiveKit is
unconfigured, so production remains one host connection per viewer and P2P/TURN.

## Current Snapshot

- Capture precedes room creation; live source/quality changes preserve peers and picture pause keeps audio/connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Optional `ACCESS_PASSWORD` uses a stateless 12-hour HMAC HttpOnly Strict cookie; host auth stays internal and signaling role-bound.
- Without `ROOM_DATABASE_PATH`, rooms are temporary. With it and the password, sequential links persist after stop; SQLite stores only room ID and host-token digest.
- Production still requires coturn UDP/TCP. Target media is peer UDP -> SFU/UDP roots -> optional edge TURN -> failure; HTTPS/WSS stays TLS/TCP.
- SFU normally feeds one or two roots. Downstream cap is two, browser relay one; exceptional central edges need a separate cap. Production routing is off.
- Configured fallback adds a non-secret standby URL and token-free DNS/TLS warmup; absent configuration adds no field, import, request, participant, or edge.
- Each viewer advertises relay capacity 0/1; detected mobile/iPad clients are leaves. Withdrawal does not move a healthy edge. Browser relays stay one-child and host two-child.
- Production has memory-only video settings and manual readback. Automatic `HIGH`/`FALLBACK` plus one shared on-demand `LOW` is accepted but not deployed; host A+B exists, while C/actions do not. Browser audio is request/presence-only.

## Verified Evidence

- Release `769de201f7cc` passed CI/hygiene/typecheck, 22 files/274 tests, both builds, and zero production dependency vulnerabilities.
- Chrome 151 synthetic `1/3/5/8` kept host/relay edges at 2/1 and all viewers decoding; slowest first frame was 1.05 seconds and one three-viewer relay close recovered in 5.32 seconds.
- Synthetic Chrome 151 720p30 propagated balanced/clarity to one host and three viewers without peer changes; decoding and 2/1 fanout continued. This proves control continuity only.
- Chrome 151/LiveKit localhost A/B measured cold active/render at 1.481/2.257 seconds versus standby 0.200/0.320 with host edges at two. It includes SDK/prewarm and is not public-network evidence.
- Atomic activation passed health/access, exact bundle, SQLite preservation, services, and logs; the old release is rollback-ready. Responsive 320/375/390 px checks passed without live media.
- Host A+B aligns capture with one outbound RTP, interval/deltas, `remoteId`, path, and nullable transport-bound codec/profile/fmtp/`scalabilityMode`. It infers no quality/capability, retains no raw fmtp/SDP/stats, and treats stale, ambiguous, reset, or cross-transport data as unknown. Review found no P1/P2; 22 files/299 tests and both builds passed.
- HTTPS/WSS, access and room/WebSocket auth, renewal, public STUN, and authenticated TURN/UDP/TCP relay-only paths pass; TURN/TLS is off.
- Draft #16/#18/#22/#23/#25/#28 passed isolated experiments only. ADR-0006 reached host setup/one encoder output, then timed out before viewer 1 decoded/rendered.

## Unverified Boundaries

- Full-resolution 30-minute runs, relay CPU/GPU, generational quality, controlled loss/RTT, depth latency, and game capture are unverified.
- Android Chrome/iOS Safari leaves are unverified; runtime conservatively marks detected mobile/iPad clients as leaves.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio, heterogeneous clients, mobile lifecycle, quality/pause, room `1` republish, and sustained profiles are unverified. Poor movie/video audio is user-reported but unclassified; after video A+B, diagnose capture settings, codec/fmtp, actual bitrate, loss, jitter, concealment, jitter buffer, and A/V sync.
- Production `769de201f7cc` reportedly sustains native `qualityLimitationReason=bandwidth` and severe blur with one capable LAN/direct viewer; only Host refresh restores quality. Within the five-second grace, stable-clientId Viewer refresh retains its `peerId`/`HostPeer`, while Host refresh rebuilds peers/capture; churn persistence is also reported. This prioritizes but does not prove sender/PC/GCC/capture generation over network or lifecycle causes.
- ADR-0007 remains incomplete. Host A+B codec fields exist, but browser support and the reported case are unverified; authenticated C, the controller, and `LOW` are absent. Weak paths must share one `LOW`; fail closed protects `HIGH` only exceptionally, and an unreliable supported cohort fails acceptance.
- Browser relays re-encode. ADR-0006 is no-go-unclassified: downstream checkpoints and two-edge/FIFO/TURN gates are absent. Spikes prove one WebCodecs object, not hardware; GCC+RTX is no-go and no-RTX weakens stats.
- Browser fanout is host two/viewer one; any accepted endpoint relay stays capped at two downstream edges.
- ADR-0005 accepts SFU-root fallback, but code is failure-only/TURN-required; UDP-first config, edge grants, bounded failure, cost/trust, and public canary are absent.
- Pinned LiveKit 1.13.5 Dynacast enables all qualities at or below the room's maximum request, so a `HIGH` root is expected to keep `LOW` enabled. It remains a bounded rejection/verification spike, not evidence that on-demand `LOW` can stop.
- The corrected standby smoke is localhost/headless/video-only; public DNS/TLS reuse, transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.

## Next Milestone

Use the completed local host A+B diagnostics to reproduce the same-LAN/direct
case. First rebuild one affected `HostPeer`/`connectionId` while retaining
capture and healthy peers; separately compare capture-only and full Host rebuilds with
A+B/C evidence and opaque generations. The affected viewer must recover without
moving healthy peers or breaking the host-edge cap. Only proven stuck
generations justify guarded/cooldown recovery; never reconnect periodically or
raise ceilings blindly.

After video A+B, run the audio A/B/C and sync diagnosis; `maxBitrate` is not a
quality fix. Then add authenticated video C and test standard
simulcast/LiveKit/SVC before custom `LOW`, independently of ADR-0006. The app
owns only the two-state policy; WebRTC/LiveKit owns congestion/layers. Later one exact room must pass peer/SFU UDP, optional
compatibility, and bounded-failure gates before changing coturn/TCP.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix.

Observed disconnects retain 5-second grace plus at most 3 seconds to a decodable
picture; silent partitions add detection delay.

ADR-0004 fails closed. Native shared encode and packet/layer striping remain
separate experiments, not ways to relabel a failed browser route.

The ladder stops at #28; minimum-of-two/custom GCC stays out. ADR-0006 remains
no-go until an authorized staged gate retains host/RTP, signaling/PC,
decode/render, 2/3-viewer, and TURN evidence.

## Blockers And Decisions

Peer assistance and automatic routing remain No-Go until ADR-0004/0005 migration gates pass.
Without LiveKit, two mobile leaves can fill both host roots; use an isolated
exact-room canary only.
Native shared encode and striping remain separate experiments.
Deferred architecture audit: `docs/maintenance.md`.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
- Whether peer assistance passes every non-encoding gate; any failure closes it.
