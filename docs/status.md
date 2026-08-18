# Current Status

Last updated: 2026-08-18

## Phase

The first measurable WebRTC Web proof of concept is implemented at `https://share.bonfire.icu`, including an authenticated public TURN fallback. The current revision adds an optional whole-site password gate and simple numeric room joining. Automated checks and same-machine Chromium tests with synthetic video and audio sources pass, including live source replacement and relay-only data paths. Real display capture, game audio, a sustained 1:8 room, mobile lifecycle behavior, and performance targets remain unverified.

## Established Baseline

- Runtime: Node.js 24, React, TypeScript, Vite, native browser WebRTC, `ws`, Zod, and a separate coturn deployment.
- Product scope: private game sharing for one broadcaster and a small friend group. Rooms default to eight viewers and accept a configured limit from 1 through 16; this is an admission limit, not a verified performance envelope.
- Client behavior: screen capture precedes room creation; live source changes preserve healthy peer connections; `/r/{code}` invitations and `/join` use a 12-digit numeric room code with no viewer token or URL fragment; every viewer has an independent `RTCPeerConnection`.
- Control plane: optional whole-site `ACCESS_PASSWORD`, a 12-hour stateless HMAC HttpOnly `SameSite=Strict` cookie, in-memory rooms, an internal host token, role-bound signaling, stable reconnect identities, short-lived coturn credentials, Origin and payload checks, and explicit room expiry/closure. There are no accounts, database, JWTs, server-side access-session map, or logout flow. In public mode, the room code is the sole viewing capability and is not a strong privacy guarantee.
- Media topology: direct ICE is preferred per viewer, with authenticated TURN/UDP and TURN/TCP required in production. TURN/TLS is an optional deployment capability, using standard TCP 5349 by default; mixed direct and relay paths are supported by design.
- Diagnostics: per-peer path, candidate types, ICE protocol, local TURN protocol, RTT, bitrate, frame rate, dimensions, loss, jitter, codec, and quality-limitation fields are read locally from WebRTC stats.
- Large public broadcasts are out of scope and should use OBS/Twitch-class services.

## Verified In This Revision

- `npm run check` passes type checking, 87 Vitest tests, the client production build, and the server production build.
- Headless Chromium 151 created real local peer connections from animated canvas streams. The viewer reached `connected`, received a live video track, and reported a direct UDP path.
- Browser fault injection recovered after dropping the first offer, dropping the first answer, and failing the first `createOffer`. A viewer-only signaling reconnect preserved the existing healthy media peer; replacing that viewer tab rebuilt media, released the old peer, and did not enter a reconnect loop.
- Cancelling a delayed room A and immediately starting room B left B live, stopped only A's capture, and invalidated A's invitation after bounded cleanup.
- Injecting a live picker-cancellation result preserved the old stream. Replacing synthetic video, adding synthetic audio, and removing it all kept the same connected host/viewer peer objects and did not create another offer; retired capture tracks stopped after each successful change.
- Chrome 151 at 390 px completed the protected-site gate, login, host, and manual room-code join flow without horizontal overflow. The unauthenticated gate shows no application header or sharing controls.
- Production configuration fails closed when HTTPS, STUN, TURN, or sufficiently strong secrets are missing.
- Production startup rejects malformed ICE URLs and requires STUN plus explicit TURN/UDP and TURN/TCP entries. Optional TURN/TLS entries may use standard TCP 5349 or, when separately routed, TCP 443. Configuration validation remains distinct from the runtime relay checks below.
- The application defaults to `LISTEN_HOST=0.0.0.0` for LAN development and containers, while the bare-metal reverse-proxy deployment explicitly uses loopback. It exposes a process-only `GET /healthz` liveness response.
- Viewer session identities use `crypto.getRandomValues()` rather than the secure-context-only `crypto.randomUUID()`, so a phone can initialize the viewer over trusted LAN HTTP while the host keeps screen capture on `localhost`.
- The staging host runs Debian 12, nginx, Node.js 24.19.0, and source-built coturn 4.17.2. Screener binds loopback behind nginx; authenticated STUN and TURN/UDP+TCP bind `turn.bonfire.icu:3478`. TURN/TLS remains intentionally disabled.
- Public HTTPS, certificate validation, HTTP redirect, `/healthz`, unauthorized room rejection, authenticated room creation, WSS host authentication, and room closure were verified. Certbot's renewal dry run also passed for both the existing blog and Screener certificates; the existing blog continued returning HTTP 200.
- Public STUN Binding succeeds over both UDP and TCP 3478. Chromium 151 obtained authenticated relay candidates through TURN/UDP and TURN/TCP, then two relay-only peer connections completed a bidirectional DataChannel ping/pong over each transport. Simultaneous guest conntrack samples observed both 3478 control traffic and relay-range UDP traffic, independently confirming the public TURN path through the cloud and host firewalls.
- The existing TeamSpeak files, services, timers, and ports were not changed.

## Next Milestone

Execute and record the manual browser/network matrix:

- real screen/window capture and available game or system audio on Windows Chrome and Edge;
- one broadcaster with eight heterogeneous viewers for 30 minutes, while also recording lower viewer counts to locate the sustainable envelope;
- same-LAN direct, cross-network direct, a forced-relay Screener media session, mixed direct/relay, and a UDP-blocked TURN/TCP path; test TURN/TLS separately only when deployed;
- Android Chrome and iOS Safari playback, orientation, backgrounding, and network handoff;
- actual codec implementation, encode load, publisher upload, bitrate, frame rate, first picture, and glass-to-glass latency. Custom dynamic-FPS logic remains intentionally unimplemented until these measurements show a gap in browser capture, encoding, and congestion behavior.

## Current Blocker

- No infrastructure blocker remains for the current staging deployment. The remaining work is the real-device and real-media validation matrix above.

## Blocking Decisions

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network test cohort.
- Project license and intended distribution model.
