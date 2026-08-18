# Project Memory

Last updated: 2026-08-18

## Confirmed Intent

- The product is a Discord/KOOK/Oopz/TeamSpeak-like screen-sharing tool for gaming with friends.
- One user broadcasts a game, application, or display; several friends watch with very low latency.
- The normal use case is a small, trusted friend group. Public or large-scale streaming is explicitly out of scope and can be handled by OBS/Twitch-class services.
- Viewers should be able to open an invite link in a desktop or mobile browser without installing a dedicated client.
- The system should resemble a Photon-style developer experience: a central room/rendezvous service establishes sessions while realtime traffic is carried by clients whenever possible.
- Server bandwidth cost is a primary constraint. The media path must be P2P-first, with servers used for signaling, STUN, TURN fallback, and observability. SFU is outside the normal small-room scope.
- Avoiding TeamSpeak-like partial reachability is a primary requirement: every broadcaster-viewer pair must independently have TURN/UDP and TURN/TCP candidates available when direct ICE cannot connect. TURN/TLS is an optional compatibility enhancement, not a production prerequisite.
- A web experience is preferred for convenience, but using a desktop sender is acceptable when it materially improves game capture, audio capture, or hardware encoding.
- All project documentation, memory, code, `AGENTS.md`, and `.codex/` configuration must live in this Git repository and remain tracked for cross-device development.
- Normal maintenance uses short-lived branches, focused commits, remote backup, pull requests, checks, merge, and branch deletion.
- Long conversations require explicit repository checkpoints. Current memory is curated and rewritten when facts change; it must not grow as a transcript or duplicate Git history.
- Material designs, fixes, and implementations begin with current online research of official docs and established projects, supplemented by community reports or papers where useful.
- Engineering follows Occam's razor: use the simplest complete solution for verified needs and reject speculative scale, abstractions, services, and compatibility work until evidence justifies them.

## Current Recommendation

- Start with a Windows Chrome/Edge sharing MVP and a responsive Web viewer using one `RTCPeerConnection` per viewer. Validate current Android Chrome and iOS Safari as viewing endpoints.
- Rooms default to one broadcaster and at most eight viewers, with a deployment range of 1 through 16. Treat eight as an admission default rather than a validated performance claim; measure publisher upload, encoder load, latency, and stability before describing a supported 1:8 envelope.
- Use HTTPS/WSS signaling, trickle ICE, STUN, and authenticated coturn candidates. Prefer direct UDP, then relay UDP, with TURN/TCP as the required non-UDP fallback. Optional TURN/TLS uses standard TCP 5349 by default; TCP 443 is reserved for deployments with a dedicated public IP or validated L4/SNI routing.
- Allow mixed connectivity in one room: direct viewers stay direct while only incompatible network pairs consume TURN bandwidth.
- Treat 1080p60 as a best-effort quality profile, not a universal guarantee. Provide 720p60 and 720p30 fallbacks.
- Do not add custom scene detection or dynamic-FPS control until WebRTC statistics and host resource measurements show that browser capture, encoding, and congestion behavior leave a material problem.
- Leave codec order at the browser default in the first PoC and record the negotiated codec, encoder implementation, and power efficiency. Prefer H.264 only after target-machine measurements show that it is the hardware-efficient path; retain VP8 compatibility.
- Add an Electron or native Windows sender only after browser measurements identify capture, application-audio, or encode bottlenecks.
- Do not plan an SFU for the normal small-room product path. Reconsider it only if the product scope or real telemetry later invalidates the P2P envelope; never implement peer forwarding trees in the MVP.
- Keep room policy deployment-driven and small. Public and password-only deployments use random temporary rooms. A deployment that configures both the whole-site password and a SQLite path gets sequential, non-expiring protected rooms; stopping a share leaves viewers waiting and does not destroy the room.

## Current Implementation

- The repository contains a single npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and a separate coturn deployment. The server defaults to an all-interface listener for LAN development and containers; the bare-metal reverse-proxy baseline explicitly binds loopback. It provides a process-only `/healthz` endpoint and requires STUN plus explicit TURN/UDP and TURN/TCP URLs before production startup. TURN/TLS is accepted but optional; configuration checks do not establish public-network reachability.
- The Web PoC implements capture-before-room creation, live source replacement without renegotiating healthy peers, one independent peer connection per viewer, stable signaling reconnect identities that also work for LAN viewers on HTTP, explicit ICE restart or peer rebuild, host session generation isolation, viewer connection-generation guards for asynchronous signaling and stats, short-lived TURN credentials, three manual quality profiles, and local WebRTC statistics.
- Access is deliberately small: `ACCESS_PASSWORD` is optional, site-wide, and accepts 1 through 128 visible ASCII characters when non-empty. When configured, host and viewer routes first establish a 12-hour stateless HMAC HttpOnly `SameSite=Strict` cookie; room creation and WebSocket upgrade accept that cookie and no direct room-creation Bearer bypass. There are no accounts, JWTs, server-side access-session maps, or logout flow.
- ADR-0002 accepts an optional `ROOM_DATABASE_PATH` only alongside `ACCESS_PASSWORD`. In that mode, built-in `node:sqlite` stores only an auto-incremented room ID and host-token digest; links do not expire and stopping sharing leaves the room waiting. Without the path, rooms remain random and temporary. Public mode can never use sequential persistent rooms. The branch's 102 Vitest tests and builds pass locally; `/var/lib/screener/rooms.sqlite` has not yet been deployed or verified in production.
- `/r/{code}` carries no viewer token or fragment, `/join` accepts only the numeric code, and the 256-bit host token stays internal to host authentication. In public mode the random code is the sole viewing capability and is not a strong privacy guarantee, so private Internet deployments should configure `ACCESS_PASSWORD`.
- The Web control plane is deployed at `https://share.bonfire.icu` behind nginx with Node.js 24.19.0, and `turn.bonfire.icu` runs authenticated coturn 4.17.2 on standard UDP/TCP 3478. HTTPS, WSS, room authentication, certificate renewal, public STUN, authenticated TURN/UDP and TURN/TCP allocations, and relay-only bidirectional data paths are verified. TURN/TLS is intentionally not enabled.
- Automated checks pass on the persistent-room branch with 102 Vitest tests and both production builds. Same-machine synthetic-media Chromium recovery and public relay-only DataChannel evidence remains from the deployed baseline. Production room-persistence, real screen/game audio, full Screener media sessions across heterogeneous networks, mobile lifecycle handling, and latency or quality targets remain unverified.
- No infrastructure blocker remains for the current staging deployment. The immediate control-plane milestone and the separate real-device/media matrix are bounded in `docs/status.md`; neither justifies a native sender yet.

## Provisional Quality Targets

- Under a controlled direct path with RTT at or below 40 ms and packet loss at or below 1%: glass-to-glass latency p50 at or below 150 ms and p95 at or below 250 ms.
- Under a regional TURN/UDP path with the same endpoint conditions: glass-to-glass latency p95 at or below 350 ms.
- First picture within 3 seconds after a viewer requests to watch, excluding explicit user permission time.
- A stable 60 fps profile should not silently fall below 50 decoded fps for more than 5 consecutive seconds; it must visibly downgrade or report the limiting reason.
- These are engineering targets to validate with timestamp/high-speed-camera tests, not claims about untested networks.

## Open Decisions

- The sustainable viewer count for each publisher hardware, quality profile, and network class; real 1:8 behavior is still unverified.
- Exact mobile browser support matrix and the required behavior around autoplay, backgrounding, orientation changes, and network handoff.
- Whether the first release is open source, source-available, or proprietary; this affects whether GPL/AGPL projects can be reused rather than only studied.
- Initial deployment regions and expected mainland China/Hong Kong/overseas network mix.
- Whether Windows per-application audio is P0 or whether whole-system loopback is acceptable initially.
- Whether voice chat is ever in scope or the product remains complementary to an existing voice application.

## Source Of Truth

- Requirements: `docs/需求理解.md`
- First PoC technical design: `docs/方案设计.md`
- Minimal production-shaped deployment: `docs/deployment.md`
- Research and feasibility: `docs/research/webrtc-p2p-screen-sharing.md`
- Topology decision: `docs/adr/0001-p2p-first-media-topology.md`
- Persistent protected-room decision: `docs/adr/0002-persistent-protected-rooms.md`
- Current phase and next step: `docs/status.md`
- Maintenance and context lifecycle: `docs/maintenance.md`
- Agent workflow: `AGENTS.md` and `.codex/`
