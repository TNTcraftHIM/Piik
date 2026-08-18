# Project Memory

Last updated: 2026-08-18

## Confirmed Intent

- The product is a Discord/KOOK/Oopz/TeamSpeak-like screen-sharing tool for gaming with friends.
- One user broadcasts a game, application, or display; several friends watch with very low latency.
- The normal use case is a small, trusted friend group. Public or large-scale streaming is explicitly out of scope and can be handled by OBS/Twitch-class services.
- Viewers should be able to open an invite link in a desktop or mobile browser without installing a dedicated client.
- The system should resemble a Photon-style developer experience: a central room/rendezvous service establishes sessions while realtime traffic is carried by clients whenever possible.
- Server bandwidth cost is a primary constraint. The media path must be P2P-first, with servers used for signaling, STUN, TURN fallback, and observability. SFU is outside the normal small-room scope.
- Avoiding TeamSpeak-like partial reachability is a primary requirement: every broadcaster-viewer pair must independently have TURN/UDP, TURN/TCP, and TURN/TLS candidates available when direct ICE cannot connect.
- A web experience is preferred for convenience, but using a desktop sender is acceptable when it materially improves game capture, audio capture, or hardware encoding.
- All project documentation, memory, code, `AGENTS.md`, and `.codex/` configuration must live in this Git repository and remain tracked for cross-device development.
- Normal maintenance uses short-lived branches, focused commits, remote backup, pull requests, checks, merge, and branch deletion.
- Long conversations require explicit repository checkpoints. Current memory is curated and rewritten when facts change; it must not grow as a transcript or duplicate Git history.
- Material designs, fixes, and implementations begin with current online research of official docs and established projects, supplemented by community reports or papers where useful.
- Engineering follows Occam's razor: use the simplest complete solution for verified needs and reject speculative scale, abstractions, services, and compatibility work until evidence justifies them.

## Current Recommendation

- Start with a Windows Chrome/Edge sharing MVP and a responsive Web viewer using one `RTCPeerConnection` per viewer. Validate current Android Chrome and iOS Safari as viewing endpoints.
- The current PoC hard limit is one broadcaster and three viewers. Do not add a fourth viewer until publisher upload and encoder measurements justify changing the tested envelope.
- Use HTTPS/WSS signaling, trickle ICE, STUN, and authenticated coturn candidates. Prefer direct UDP, then relay UDP, while keeping TURN/TCP and TURN/TLS on port 443 available for restrictive networks.
- Allow mixed connectivity in one room: direct viewers stay direct while only incompatible network pairs consume TURN bandwidth.
- Treat 1080p60 as a best-effort quality profile, not a universal guarantee. Provide 720p60 and 720p30 fallbacks.
- Leave codec order at the browser default in the first PoC and record the negotiated codec, encoder implementation, and power efficiency. Prefer H.264 only after target-machine measurements show that it is the hardware-efficient path; retain VP8 compatibility.
- Add an Electron or native Windows sender only after browser measurements identify capture, application-audio, or encode bottlenecks.
- Do not plan an SFU for the normal small-room product path. Reconsider it only if the product scope or real telemetry later invalidates the P2P envelope; never implement peer forwarding trees in the MVP.

## Current Implementation

- The repository contains a single npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and a separate coturn deployment. The server defaults to an all-interface listener for LAN development and containers; the bare-metal reverse-proxy baseline explicitly binds loopback. It provides a process-only `/healthz` endpoint and requires the full TURN/UDP, TURN/TCP, and TURN/TLS-on-TCP-443 URL mix before production startup; these checks do not establish public-network reachability.
- The Web PoC implements capture-before-room creation, live source replacement without renegotiating healthy peers, expiring role tokens, one independent peer connection per viewer, stable signaling reconnect identities that also work for LAN viewers on HTTP, explicit ICE restart or peer rebuild, host generation isolation, short-lived TURN credentials, three manual quality profiles, and local WebRTC statistics.
- Automated checks and same-machine synthetic-media Chromium recovery tests pass, including lost offer/answer, one transient offer failure, signaling-only viewer reconnect, viewer-tab replacement with old-peer cleanup, cancelled-room cleanup, and video/audio source changes on an existing connection. Real screen/game audio, public TURN/NAT behavior, mobile lifecycle handling, and latency or quality targets remain unverified.
- The next milestone is a staging coturn deployment and the manual matrix in `docs/status.md`, not additional product surface or a native sender.

## Provisional Quality Targets

- Under a controlled direct path with RTT at or below 40 ms and packet loss at or below 1%: glass-to-glass latency p50 at or below 150 ms and p95 at or below 250 ms.
- Under a regional TURN/UDP path with the same endpoint conditions: glass-to-glass latency p95 at or below 350 ms.
- First picture within 3 seconds after a viewer requests to watch, excluding explicit user permission time.
- A stable 60 fps profile should not silently fall below 50 decoded fps for more than 5 consecutive seconds; it must visibly downgrade or report the limiting reason.
- These are engineering targets to validate with timestamp/high-speed-camera tests, not claims about untested networks.

## Open Decisions

- Minimum supported publisher upload speed and whether a later release should remain capped at three viewers.
- Exact mobile browser support matrix and the required behavior around autoplay, backgrounding, orientation changes, and network handoff.
- Whether the first release is open source, source-available, or proprietary; this affects whether GPL/AGPL projects can be reused rather than only studied.
- Account model versus expiring room links, and whether friends require an allowlist.
- Initial deployment regions and expected mainland China/Hong Kong/overseas network mix.
- Whether Windows per-application audio is P0 or whether whole-system loopback is acceptable initially.
- Whether voice chat is ever in scope or the product remains complementary to an existing voice application.

## Source Of Truth

- Requirements: `docs/需求理解.md`
- First PoC technical design: `docs/方案设计.md`
- Minimal production-shaped deployment: `docs/deployment.md`
- Research and feasibility: `docs/research/webrtc-p2p-screen-sharing.md`
- Topology decision: `docs/adr/0001-p2p-first-media-topology.md`
- Current phase and next step: `docs/status.md`
- Maintenance and context lifecycle: `docs/maintenance.md`
- Agent workflow: `AGENTS.md` and `.codex/`
