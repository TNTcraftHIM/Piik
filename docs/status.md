# Current Status

Last updated: 2026-08-18

## Phase

The WebRTC proof of concept is deployed at `https://share.bonfire.icu`. Commit
`2f66770f8e90` adds protected SQLite persistence, sequential room IDs, reusable
links, and a waiting state after sharing stops. The production database is
initialized and empty, so the first real persistent room can receive ID `1`.
Real capture, game audio, mobile lifecycle, and performance targets remain
unverified. Increasing the P2P viewer count has already caused severe user-
observed degradation, so an explicitly configured SFU mode is the next media
experiment; P2P remains the default topology.

## Established Baseline

- Runtime: Node.js 24, React, TypeScript, Vite, native browser WebRTC, `ws`, Zod, and a separate coturn deployment.
- Product scope: private game sharing for one broadcaster and a small friend group. Rooms default to eight viewers and accept a configured limit from 1 through 16; this is an admission limit, not a verified performance envelope.
- Client behavior: screen capture precedes room creation; live source changes preserve healthy peer connections; `/r/{code}` invitations and `/join` use a numeric room code with no viewer token or URL fragment; every viewer has an independent `RTCPeerConnection`.
- Control plane contract: optional whole-site `ACCESS_PASSWORD` with 1 through 128 visible ASCII characters, a 12-hour stateless HMAC HttpOnly `SameSite=Strict` cookie, an internal host token, role-bound signaling, stable reconnect identities, short-lived coturn credentials, and Origin/payload checks. There are no accounts, JWTs, server-side access-session maps, or logout flow.
- Room policies: no `ROOM_DATABASE_PATH` means random temporary rooms governed by `ROOM_TTL_SECONDS`; configuring it together with `ACCESS_PASSWORD` enables protected rooms whose numeric IDs increment from `1` and whose links do not expire. A database path without the whole-site password is invalid. Stopping sharing leaves the room available and viewers waiting. SQLite stores only room ID and host-token digest.
- Media topology: direct ICE is preferred per viewer, with authenticated TURN/UDP and TURN/TCP required in production. TURN/TLS is an optional deployment capability, using standard TCP 5349 by default; mixed direct and relay paths are supported by design.
- Diagnostics: per-peer path, candidate types, ICE protocol, local TURN protocol, RTT, bitrate, frame rate, dimensions, loss, jitter, codec, and quality-limitation fields are read locally from WebRTC stats.
- Large public broadcasts are out of scope and should use OBS/Twitch-class services.

## Verification

- On current `main`, `npm run check` passes type checking,
  102 Vitest tests, the client production build, and the server production build.

The remaining browser and network evidence predates the persistent-room rollout;
it does not verify a real browser stop-and-republish cycle with room ID `1`.

- Headless Chromium 151 created real local peer connections from animated canvas streams. The viewer reached `connected`, received a live video track, and reported a direct UDP path.
- Browser fault injection recovered after dropping the first offer, dropping the first answer, and failing the first `createOffer`. A viewer-only signaling reconnect preserved the existing healthy media peer; replacing that viewer tab rebuilt media, released the old peer, and did not enter a reconnect loop.
- Delayed ViewerPeer answer, candidate flush, ICE event, and stats results are discarded after a connection generation is replaced, so an old peer cannot signal through or overwrite the new peer snapshot.
- Injecting a live picker-cancellation result preserved the old stream. Replacing synthetic video, adding synthetic audio, and removing it all kept the same connected host/viewer peer objects and did not create another offer; retired capture tracks stopped after each successful change.
- Chrome 151 at 390 px completed the protected-site gate, login, host, and manual room-code join flow without horizontal overflow. The unauthenticated gate shows no application header or sharing controls.
- Production configuration fails closed when required HTTPS, STUN, TURN, or TURN-secret constraints are missing.
- Production startup rejects malformed ICE URLs and requires STUN plus explicit TURN/UDP and TURN/TCP entries. Optional TURN/TLS entries may use standard TCP 5349 or, when separately routed, TCP 443. Configuration validation remains distinct from the runtime relay checks below.
- The application defaults to `LISTEN_HOST=0.0.0.0` for LAN development and containers, while the bare-metal reverse-proxy deployment explicitly uses loopback. It exposes a process-only `GET /healthz` liveness response.
- Viewer session identities use `crypto.getRandomValues()` rather than the secure-context-only `crypto.randomUUID()`, so a phone can initialize the viewer over trusted LAN HTTP while the host keeps screen capture on `localhost`.
- The staging host runs Debian 12, nginx, Node.js 24.19.0, and source-built coturn 4.17.2. Screener binds loopback behind nginx; authenticated STUN and TURN/UDP+TCP bind `turn.bonfire.icu:3478`. TURN/TLS remains intentionally disabled.
- Commit `2f66770f8e90` is deployed. Production verification covered rejection of the previous password, login with the current password, the `Secure`/`HttpOnly`/`SameSite=Strict` cookie, the initialized empty SQLite schema, service state directory mode `0700`, database mode `0600`, and a clean service restart with zero automatic restarts. The prior room and WebSocket authentication checks remain applicable. The existing blog continued returning HTTP 200.
- Public STUN Binding succeeds over both UDP and TCP 3478. Chromium 151 obtained authenticated relay candidates through TURN/UDP and TURN/TCP, then two relay-only peer connections completed a bidirectional DataChannel ping/pong over each transport. Simultaneous guest conntrack samples observed both 3478 control traffic and relay-range UDP traffic, independently confirming the public TURN path through the cloud and host firewalls.
- The existing TeamSpeak files, services, timers, and ports were not changed.

## Next Milestone

Preserve the first real room for the normal browser workflow, then verify room ID
`1`, stop-and-republish waiting behavior, link reuse, and recovery after a service
restart. In a separate PR and ADR, add a deployment-level `p2p|sfu` media mode
using a single-node SFU; do not add automatic switching, hybrid sending, Redis,
or multi-node infrastructure before measurements justify them.

Execute and record the manual browser/network matrix for both applicable modes:

- real screen/window capture and available game or system audio on Windows Chrome and Edge;
- one broadcaster with 1, 3, 5, and 8 heterogeneous viewers, recording publisher upload and encode load plus server ingress and egress to locate each sustainable envelope;
- same-LAN direct, cross-network direct, a forced-relay Screener media session, mixed direct/relay, and a UDP-blocked TURN/TCP path; test TURN/TLS separately only when deployed;
- Android Chrome and iOS Safari playback, orientation, backgrounding, and network handoff;
- actual codec implementation, encode load, publisher upload, bitrate, frame rate, first picture, and glass-to-glass latency. Custom dynamic-FPS logic remains intentionally unimplemented until these measurements show a gap in browser capture, encoding, and congestion behavior.

## Current Blocker

- No infrastructure blocker remains for the current deployment. Persistent storage and systemd filesystem permissions are active; the first real browser room lifecycle and the separate P2P/SFU media matrix remain unverified.

## Blocking Decisions

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network test cohort.
- Project license and intended distribution model.
