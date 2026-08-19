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
- Direct ICE is preferred independently per media edge. Authenticated TURN/UDP and TURN/TCP are required production fallbacks; TURN/TLS is optional.
- Hidden routing is `direct P2P -> peer-assisted -> optional SFU`; exact-room canaries use `PEER_ASSISTED_ROOM_IDS`. Production is off and 22 files/290 tests cover both paths.
- Configured fallback adds a non-secret standby URL and token-free DNS/TLS warmup; absent configuration adds no field, import, request, participant, or edge.
- Each viewer advertises relay capacity 0/1; detected mobile/iPad clients are leaves. Withdrawal does not move a healthy edge. Browser relays stay one-child and host two-child.
- Production has one memory-only video setting with manual ceilings/readback. Automatic per-path `HIGH`/`FALLBACK` and one on-demand shared `LOW` are accepted but not deployed; only the first local A+B foundation exists. Browser audio is request/presence-only.

## Verified Evidence

- Release `769de201f7cc` passed CI/hygiene/typecheck, 22 files/274 tests, both builds, and zero production dependency vulnerabilities.
- Chrome 151 synthetic `1/3/5/8` kept host/relay edges at 2/1 and all viewers decoding; slowest first frame was 1.05 seconds and one three-viewer relay close recovered in 5.32 seconds.
- Synthetic Chrome 151 720p30 propagated balanced/clarity to one host and three viewers without peer changes; decoding and 2/1 fanout continued. This proves control continuity only.
- Chrome 151/LiveKit localhost A/B measured cold active/render at 1.481/2.257 seconds versus standby 0.200/0.320 with host edges at two. It includes SDK/prewarm and is not public-network evidence.
- Atomic activation passed health/access, exact bundle, SQLite preservation, services, and logs; the old release is rollback-ready. Responsive 320/375/390 px checks passed without live media.
- The local A+B alignment foundation samples capture settings with one uniquely matched host outbound track, explicit window/media identity and valid adjacent deltas, `remoteId`, and the RTP-bound selected path. Source replacement blocks sampling and discards stale in-flight generations; ambiguous, changed, and reset evidence rebases to unknown.
- HTTPS/WSS, access and room/WebSocket auth, renewal, public STUN, and authenticated TURN/UDP/TCP relay-only paths pass; TURN/TLS is off.
- Draft native ladder #16/#18/#22/#23/#25/#28 passed one bounded 720p30 two-leg loop with an experiment-only minimum GCC target and one recovered loss; it is not product behavior.

## Unverified Boundaries

- Full-resolution 30-minute runs, relay CPU/GPU, generational quality, controlled loss/RTT, depth latency, and game capture are unverified.
- Android Chrome/iOS Safari leaves are unverified; runtime conservatively marks detected mobile/iPad clients as leaves.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real audio, heterogeneous clients, mobile lifecycle, quality/pause, room `1` republish, and sustained profiles are unverified. Poor movie/video audio is user-reported but unclassified; after video A+B, diagnose capture settings, codec/fmtp, actual bitrate, loss, jitter, concealment, jitter buffer, and A/V sync.
- Earlier production degraded across profiles. Controlled 1/2/3-viewer and TURN samples must isolate capture, CPU, path, and receiver limits before quality/controller claims.
- ADR-0007 remains incomplete. The first local A+B alignment foundation is implemented, but codec evidence is MIME-only and still lacks derived profile/parameters/`scalabilityMode`; the minimal authenticated C report, two-state controller, and `LOW` runtime do not exist. Verified weak paths must ultimately move to the one shared `LOW`, and supported sender cohorts that cannot start it reliably fail acceptance; fail closed protects `HIGH` only as exceptional damage containment.
- Browser relays re-encode. The native ladder proves one WebCodecs object, not hardware encode. GCC+RTX is no-go; no-RTX weakens stats. Broader audio/loss/routes/reconnect/browser/product/striping gates remain.
- The endpoint budget remains host/relay at most two downstream edges; the browser path is host two/viewer one.
- The corrected standby smoke is localhost/headless/video-only; public DNS/TLS reuse, transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.

## Next Milestone

Validate production controls on real game capture and finish video A+B codec
derivation. Then run the separate movie/video audio A/B/C and sync diagnosis in
`docs/research/browser-screen-audio-quality.md`; `maxBitrate` is a ceiling, not
a quality fix. Next add minimal authenticated video C, the two-state controller,
and on-demand shared `LOW`. Route enablement still needs one exact-room canary
across public transports, recovery, edge counts, egress, and load.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix.

Observed disconnects retain 5-second grace plus at most 3 seconds to a decodable
picture; silent partitions add detection delay.

ADR-0004 fails closed. Native shared encode and packet/layer striping remain
separate experiments, not ways to relabel a failed browser route.

The native ladder stops at #28; its minimum-of-two policy is not a product
candidate. Do not bypass stock GCC/RTX; no-RTX remains research-only.

## Blockers And Decisions

Peer assistance and automatic routing remain No-Go until ADR-0004/0005 pass.
Without LiveKit, two mobile leaves can fill both host roots; use an isolated
exact-room canary only.
Native shared encode and striping remain separate experiments.
Deferred architecture audit: `docs/maintenance.md`.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
- Whether peer assistance passes every non-encoding gate; any failure closes it.
