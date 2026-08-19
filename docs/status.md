# Current Status

Last updated: 2026-08-19

## Phase

The WebRTC proof of concept is deployed at `https://share.bonfire.icu`. Commit
`5b2fb005f6f7` adds live quality changes, picture pause, clearer connection
states, protected SQLite persistence, sequential room IDs, reusable links, and
a waiting state after sharing stops. The production database contains room ID
`1`; the deployment restart preserved that row.

The Web PoC includes an explicit `balanced` sender degradation preference,
temporary picture pause with audio unaffected, and clearer stopped/waiting and
TURN-warning states. Real capture, game audio, mobile lifecycle, sustained
multi-viewer behavior, and performance targets remain unverified.

A separate Draft spike now proves one Chrome WebCodecs encoder can stream VP8
for 12 seconds over authenticated loopback IPC into a native Pion helper and two
independent Chrome WebRTC sessions with bounded application queues. It is not
connected to the Web product.

## Established Baseline

- Runtime: Node.js 24, React, TypeScript, Vite, native browser WebRTC, `ws`, Zod, and a separate coturn deployment.
- Product scope: private game sharing for one broadcaster and a small friend group. Rooms default to eight viewers and accept a configured limit from 1 through 16; this is an admission limit, not a verified performance envelope.
- Client behavior: capture precedes room creation; live source and quality changes preserve healthy peer connections; picture pause keeps audio and connections active; `/r/{code}` and `/join` use a numeric room code; every viewer has an independent `RTCPeerConnection`.
- Access control: an optional whole-site `ACCESS_PASSWORD` issues a 12-hour stateless HMAC HttpOnly `SameSite=Strict` cookie. Room creation and WebSocket upgrade accept that cookie with no Bearer bypass; there are no accounts, JWTs, server-side access sessions, or logout flow.
- Room policy: protected deployments may configure SQLite-backed sequential rooms whose links survive stopped sharing and process restarts. Other rooms remain random and temporary. SQLite stores only room ID and host-token digest.
- Media path: direct ICE is preferred per viewer, with authenticated TURN/UDP and TURN/TCP required in production. TURN/TLS remains optional, and direct and relay paths may coexist in one room.
- Diagnostics: peer path, candidates, ICE protocol, local TURN protocol, RTT, bitrate, frame rate, dimensions, loss, jitter, codec, encode time, and quality limitations are read from local WebRTC stats.
- Large public broadcasts remain out of scope and should use OBS/Twitch-class services.

## Verification

- `npm run check` passes type checking, 108 Vitest tests, and both production builds.
- Release `5b2fb005f6f7` passed a separate production-process smoke on loopback,
  then was atomically activated under `/opt/screener/current`. External HTTPS
  health, the protected access gate, authenticated Secure/HttpOnly cookie, and
  the new 1080p30 client asset passed after restart. Screener reported zero
  automatic restarts and no warning-level journal entries; nginx and coturn
  remained active, while `bonfire.icu` and `www.bonfire.icu` continued returning
  HTTP 200.
- Headless Chromium 151 established real local peer connections from animated canvas streams, delivered a live video track over direct UDP, and recovered from dropped offer/answer and initial `createOffer` failures.
- Host and viewer generation guards discard delayed signaling, candidate, and stats work after replacement. Synthetic source changes added and removed audio without another offer, preserved healthy peer objects, and stopped retired tracks.
- Unit coverage verifies live capture constraints, balanced sender parameters, video-only pause, sender-update failure and retry, source replacement rollback, and audio `null -> track -> null` changes.
- Headless Chrome layout checks at actual inner widths 500, 781, and 820 px keep all live controls inside the host area, including the forced-relay badge. Chrome clamped the requested 390 px window to 500 px, so a true 390 px browser viewport remains unverified.
- Production configuration fails closed without HTTPS, STUN, TURN credentials, explicit TURN/UDP, or explicit TURN/TCP. Public STUN and authenticated relay-only DataChannel tests passed over TURN/UDP and TURN/TCP.
- Staging runs Debian 12, nginx, Node.js 24.19.0, and coturn 4.17.2. Screener binds loopback behind nginx; the protected SQLite directory and database permissions survive a clean service restart. TURN/TLS is intentionally disabled.
- Native browser oracle on Windows/Chrome 151: one WebCodecs fixture instance produced 120 VP8 chunks; the native coordinator read 120 source samples and made 240 track writes. Each browser decoded and presented 30 changing 320x180 frames. Native legs used different SSRCs and first sequences (`1000`, `30000`), each received RTCP receiver reports, and their ICE ufrags and DTLS fingerprints differed. This does not prove a physical hardware encode.
- Native live bridge on Windows/Chrome 151: one encoder instance accepted and output 360 frames over 11.970 seconds; the loopback helper received all 360 VP8 chunks and 368314 source bytes, then made 720 independent track writes. Each viewer decoded 331 frames and fired 331 presentation callbacks with 27 changing hashes. The capacity-eight queue peaked at one with no drop; forced-overload unit tests verify drop-to-keyframe recovery. `hardwareAcceleration: "no-preference"` is only a hint and proves no physical hardware encode.
- Native feedback oracle on Windows/Go 1.26.6 merged two-leg PLI/FIR, clamped the minimum of two ready bitrate estimates, and proved independent 512-packet NACK/RTX caches, including oldest-packet eviction on write 513. Stock `gcc.NewNoOpPacer` then rejected RTX as `unknown ssrc: 2001`, matching open Interceptor issue #406; the verdict is no-go and no browser loss run followed.

## Next Milestone

Verify a real quality/pause cycle in room ID `1`, stop-and-republish behavior,
link reuse in the browser, and host recovery after a service restart. The
database row itself has already survived the live-controls deployment restart.

Execute and record the manual browser/network matrix:

- real screen/window capture and available game or system audio on Windows Chrome and Edge;
- one broadcaster with 1, 3, 5, and 8 heterogeneous viewers, recording publisher upload, encode load, and server traffic;
- same-LAN direct, cross-network direct, forced relay, mixed direct/relay, and UDP-blocked TURN/TCP paths;
- Android Chrome and iOS Safari playback, orientation, backgrounding, and network handoff;
- live 1080p60 at 8 Mbps, 1080p30 at 5 Mbps, and 720p30 at 3 Mbps changes without a second source prompt or peer rebuild, plus picture pause/resume while audio continues;
- codec implementation, encode load, bitrate, frame rate, first picture, and glass-to-glass latency.

Keep native fanout out of the product controller. Require a released fix or a
separately accepted bounded public-API adapter before another browser loss
gate. Then prove live two-edge BWE, PLI/FIR, asymmetric NACK/RTX and pacing,
audio, mixed direct/TURN, and reconnect isolation. The live bridge closes only
the continuous IPC, application-queue, and browser decode/render gate.

## Current Blocker

- No infrastructure blocker remains. The live-control browser cycle, room `1`
  browser lifecycle, and real-device media matrix remain unverified.
- Native product integration is deliberately blocked by the reproduced stock
  Pion GCC+RTX SSRC failure. The retained key-frame and bitrate policies are
  deterministic only; live loss recovery, pacing, audio, TURN, and lifecycle
  remain unverified.

## Blocking Decisions

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network test cohort.
- Project license and intended distribution model.
