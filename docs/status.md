# Current Status

Last updated: 2026-08-19

## Phase

The P2P proof of concept is deployed at `https://share.bonfire.icu` with protected
SQLite rooms, reusable numeric links, and a waiting state after sharing stops.
Increasing the P2P viewer count caused severe user-observed degradation. The
current branch adds an explicit single-node LiveKit SFU experiment; P2P remains
the default, and SFU media has not been deployed or benchmarked.

## Established Baseline

- Runtime: Node.js 24, React, TypeScript, Vite, native browser WebRTC, `ws`, Zod, and a separate coturn deployment. The optional SFU branch adds Apache-2.0 LiveKit client/server SDKs and expects a separately operated LiveKit Server.
- Product scope: private game sharing for one broadcaster and a small friend group. Rooms default to eight viewers and accept a configured limit from 1 through 16; this is an admission limit, not a verified performance envelope.
- Client behavior: screen capture precedes room creation; live source changes preserve the active media session; `/r/{code}` invitations and `/join` use a numeric room code with no viewer token or URL fragment. P2P mode gives every viewer an independent `RTCPeerConnection`; SFU mode publishes one screen stream to LiveKit.
- Control plane: optional whole-site password, a 12-hour stateless HMAC HttpOnly cookie, internal host token, role-bound signaling, Origin checks, and short-lived room-bound TURN or LiveKit credentials. There are no accounts or server-side access-session maps.
- Room policies: no `ROOM_DATABASE_PATH` means random temporary rooms governed by `ROOM_TTL_SECONDS`; configuring it together with `ACCESS_PASSWORD` enables protected rooms whose numeric IDs increment from `1` and whose links do not expire. A database path without the whole-site password is invalid. Stopping sharing leaves the room available and viewers waiting. SQLite stores only room ID and host-token digest.
- Media topology: `MEDIA_MODE` is a process-level `p2p|sfu` choice that defaults to P2P and never switches or mixes within a deployment. P2P prefers direct ICE per viewer and requires authenticated TURN/UDP and TURN/TCP in production. SFU uses one LiveKit node and one published video layer; it moves fan-out to server egress and ordinary SFU media is not E2EE against that server.
- Diagnostics: per-peer path, candidate types, ICE protocol, local TURN protocol, RTT, bitrate, frame rate, dimensions, loss, jitter, codec, and quality-limitation fields are read locally from WebRTC stats.
- Large public broadcasts are out of scope and should use OBS/Twitch-class services.

## Verification

- On the current feature branch, `npm run check` passes type checking,
  120 Vitest tests, the client production build, and the server production build.

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
- Production verified the whole-site gate, secure cookie, persistent database permissions, room/WebSocket authentication, clean restart, and unaffected blog.
- Public STUN and authenticated TURN/UDP+TCP were verified with relay-only bidirectional DataChannels and matching guest conntrack traffic.
- The existing TeamSpeak files, services, timers, and ports were not changed.
- No LiveKit process, nginx `/rtc/` route, TCP 7881 listener, UDP 7882 listener,
  API credential, or provider firewall rule has been deployed or verified. The
  tracked SFU templates are examples, not evidence of reachability.

## Next Milestone

Preserve the first real room for the normal browser workflow, then verify room ID
`1`, stop-and-republish waiting behavior, link reuse, and recovery after a service
restart. Complete the optional SFU branch without adding automatic switching,
hybrid sending, Redis, or multi-node infrastructure, then deploy it only as an
explicit experiment after its key, nginx, listener, firewall, and privacy
boundaries have been reviewed.

Execute and record the manual browser/network matrix for both applicable modes:

- real screen/window capture and available game or system audio on Windows Chrome and Edge;
- one broadcaster with 1, 3, 5, and 8 heterogeneous viewers, recording publisher upload and encode load plus server ingress and egress to locate each sustainable envelope;
- same-LAN direct, cross-network direct, a forced-relay Screener media session, mixed direct/relay, and a UDP-blocked TURN/TCP path; test TURN/TLS separately only when deployed;
- Android Chrome and iOS Safari playback, orientation, backgrounding, and network handoff;
- actual codec implementation, encode load, publisher upload, bitrate, frame rate, first picture, and glass-to-glass latency. Custom dynamic-FPS logic remains intentionally unimplemented until these measurements show a gap in browser capture, encoding, and congestion behavior.

## Current Blocker

- No infrastructure blocker remains for the current P2P deployment. Persistent storage and systemd filesystem permissions are active. LiveKit installation, same-origin `/rtc/` routing, public 7881/TCP and 7882/UDP reachability, strict-network fallback, and the P2P/SFU media matrix remain deliberately unverified.

## Blocking Decisions

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network test cohort.
- Project license and intended distribution model.
