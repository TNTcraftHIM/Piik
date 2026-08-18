# Current Status

Last updated: 2026-08-18

## Phase

The first measurable WebRTC Web proof of concept is implemented. Automated checks and same-machine Chromium tests with synthetic video and audio sources pass, including live source replacement. Real display capture, game audio, public-network TURN, mobile lifecycle behavior, and performance targets remain unverified.

## Established Baseline

- Runtime: Node.js 24, React, TypeScript, Vite, native browser WebRTC, `ws`, Zod, and a separate coturn deployment.
- Product scope: private game sharing for one broadcaster and a hard PoC limit of three viewers.
- Client behavior: screen capture precedes room creation; live source changes preserve healthy peer connections; expiring fragment-token invitations open in desktop or mobile browsers; every viewer has an independent `RTCPeerConnection`.
- Control plane: in-memory rooms, role-bound signaling, stable reconnect identities, short-lived coturn credentials, Origin and payload checks, and explicit room expiry/closure.
- Media topology: direct ICE is preferred per viewer, with authenticated TURN/UDP, TURN/TCP, and TURN/TLS candidates available in production. Mixed direct and relay paths are supported by design.
- Diagnostics: per-peer path, candidate types, ICE protocol, local TURN protocol, RTT, bitrate, frame rate, dimensions, loss, jitter, codec, and quality-limitation fields are read locally from WebRTC stats.
- Large public broadcasts are out of scope and should use OBS/Twitch-class services.

## Verified In This Revision

- `npm run check` passes type checking, 55 Vitest tests, the client production build, and the server production build.
- Headless Chromium 151 created real local peer connections from animated canvas streams. The viewer reached `connected`, received a live video track, and reported a direct UDP path.
- Browser fault injection recovered after dropping the first offer, dropping the first answer, and failing the first `createOffer`. A viewer-only signaling reconnect preserved the existing healthy media peer; replacing that viewer tab rebuilt media, released the old peer, and did not enter a reconnect loop.
- Cancelling a delayed room A and immediately starting room B left B live, stopped only A's capture, and invalidated A's invitation after bounded cleanup.
- Injecting a live picker-cancellation result preserved the old stream. Replacing synthetic video, adding synthetic audio, and removing it all kept the same connected host/viewer peer objects and did not create another offer; retired capture tracks stopped after each successful change.
- Desktop and 390 px responsive layouts were smoke-checked without horizontal overflow.
- Production configuration fails closed when HTTPS, TURN, or sufficiently strong secrets are missing.
- Production startup rejects malformed ICE URLs and requires explicit TURN/UDP, TURN/TCP, and TURN/TLS-on-TCP-443 entries. This checks configuration only; external relay reachability remains unverified.
- The application defaults to `LISTEN_HOST=0.0.0.0` for LAN development and containers, while the bare-metal reverse-proxy deployment explicitly uses loopback. It exposes a process-only `GET /healthz` liveness response.
- Viewer session identities use `crypto.getRandomValues()` rather than the secure-context-only `crypto.randomUUID()`, so a phone can initialize the viewer over trusted LAN HTTP while the host keeps screen capture on `localhost`.
- coturn is not installed on this workstation; its configuration has only been checked against upstream documentation and local application tests.

## Next Milestone

Deploy one staging application and coturn instance, then execute and record the manual browser/network matrix:

- real screen/window capture and available game or system audio on Windows Chrome and Edge;
- one broadcaster with three heterogeneous viewers for 30 minutes;
- same-LAN direct, cross-network direct, forced relay, mixed direct/relay, and UDP-blocked TURN/TLS paths;
- Android Chrome and iOS Safari playback, orientation, backgrounding, and network handoff;
- actual codec implementation, encode load, publisher upload, bitrate, frame rate, first picture, and glass-to-glass latency.

## Blocking Decisions

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network test cohort.
- Project license and intended distribution model.
