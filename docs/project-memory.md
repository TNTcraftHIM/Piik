# Project Memory

Last updated: 2026-08-19

## Confirmed Intent

- Build Discord/KOOK/Oopz/TeamSpeak-like low-latency game screen sharing for one broadcaster and a small trusted friend group. Public or large broadcasts belong on OBS/Twitch-class services.
- Viewers should join from a normal desktop or mobile browser. A packaged sender is acceptable later when measurements justify native capture, audio, or shared encoding.
- Use a Photon-style central rendezvous service for access, rooms, signaling, deterministic topology, STUN, TURN fallback, and observability while clients carry media whenever practical.
- Server bandwidth cost is a primary constraint. The media priority is direct P2P, then measured peer assistance, then an explicit user-operated or central SFU fallback. Never migrate topology silently.
- The broadcaster has a hard target of at most two downstream media edges. Every assigned edge independently uses ICE and authenticated TURN/UDP or TURN/TCP when direct connectivity fails; P2P-first never means direct-only.
- Browser-only convenience does not override reachability, measurable performance, or honest resource accounting. Shared encoding reduces compute, not the network copy required by each viewer.
- Durable decisions, current snapshots, research, code, `AGENTS.md`, and `.codex/` belong in Git. Memory and status are rewritten in place rather than kept as transcripts.
- Research current official sources and established implementations before material work. Apply Occam's razor and reject speculative protocols, services, scoring, and scale.

## Current Recommendation

- Keep the deployed Windows Chrome/Edge broadcaster and responsive Web viewer as the measurement baseline. Validate current Android Chrome and iOS Safari as leaves.
- Use direct host P2P for one or two viewers. ADR-0004 owns the default-off experiment for later viewers: two sticky deterministic chains, host capacity two, viewer capacity one, no proactive rebalance or composite score, and no more than eight viewers when `PEER_ASSISTED_MEDIA=true`.
- Standard browser relays resend remote `MediaStreamTrack` values and therefore decode and re-encode at every hop. Browser WebRTC does not guarantee one shared encoder across peer connections; measure this cost rather than hiding it.
- Every ADR-0004 gate is mandatory. Reject the browser experiment if it needs Encoded Transform/DataChannel/WebCodecs media, custom congestion or RTP recovery, multiple trees, relay scoring, transcoding, codec ladders, browser RTP injection, or more than two host edges.
- Only if topology, churn, connectivity, compatibility, and latency pass and re-encoding is the sole failure may a separate ADR propose a native shared-encode host plus opt-in native volunteer encoded-RTP relays. Any other failure closes peer assistance.
- Keep user-operated mini-SFU deployment and central single-node SFU Draft PR #12 as explicit fallbacks. They transfer fanout egress to their operator and do not justify automatic switching, Redis, or multi-node infrastructure.
- Prefer direct UDP, then TURN/UDP, with TURN/TCP as the required non-UDP fallback. Optional TURN/TLS uses TCP 5349 by default; TCP 443 needs a dedicated address or validated L4/SNI routing.
- Treat 1080p60 as best effort and retain 720p60 and 720p30 fallbacks. Keep browser codec order until target hardware proves a more efficient common codec; do not add custom dynamic-FPS logic without stats showing a real gap.
- Keep room policy deployment-driven. Public and password-only deployments use random temporary rooms. A site password plus SQLite path enables sequential persistent rooms; stopping sharing leaves the room and viewer link available.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn. LAN/container listening defaults to all interfaces; bare-metal reverse proxy deployment binds loopback and exposes `/healthz`.
- The deployed media path still creates one independent host `RTCPeerConnection` per viewer. It supports capture-before-room creation, live source replacement, stable signaling identities, reconnect/ICE recovery, generation guards, short-lived TURN credentials, three manual quality profiles, and local WebRTC stats. It violates the new fanout target above two viewers.
- The spike branch contains deterministic server/client peer-assisted assignment and standard remote-track relay. It defaults off, is capped at eight viewers, re-encodes at every relay, and is neither merged nor deployed. Native shared encoding and custom encoded browser transport are not implemented.
- Access remains deliberately small: optional site-wide `ACCESS_PASSWORD`, a 12-hour stateless HMAC HttpOnly `SameSite=Strict` cookie, internal host token, role-bound signaling, Origin/payload checks, and no accounts, JWTs, session map, or logout flow.
- With `ROOM_DATABASE_PATH` and the site password, built-in SQLite stores only auto-incremented room ID and host-token digest. Links persist and stopping sharing leaves viewers waiting. Without the path, rooms remain random and temporary; public mode cannot use sequential rooms.
- Commit `2f66770f8e90` is deployed at `https://share.bonfire.icu` behind nginx. Authenticated coturn at `turn.bonfire.icu:3478` has verified public STUN, TURN/UDP, TURN/TCP, and relay-only traffic. TURN/TLS is intentionally disabled.
- Chromium 151 has now demonstrated the intended three-viewer peer-assisted shape: exactly two connected host outbound peers; viewer 1 with one inbound plus one outbound forwarding to viewer 3; viewer 2 direct from the host; and decoded frames at all three viewers. Closing the first-level relay reattached its branch and resumed decoding in about 5.3 seconds while host active connected outbound edges peaked at two.
- A Chromium 151 one-to-eight synthetic functional smoke formed two depth-four chains: two connected host outbound peers, one inbound plus one outbound at viewers 1 through 6, inbound-only viewers 7 and 8, and decoded frames everywhere. This is short functional evidence, not proof of 720p60 quality, performance, latency, or endurance.
- That recovery covers only a page close immediately observed by the server. A silent partition waits for the 30-second heartbeat, so detection can take 30 to 60 seconds before the default 5-second viewer grace; it is unverified. The controlled server-observed recovery gate remains 5 seconds of grace plus at most 3 seconds to a decodable picture.
- Relay outbound stats are observable, but relay senders still use a fixed `1080p60`/8 Mbps envelope rather than the host-selected profile; profile propagation blocks valid comparative measurements. Real persistent-room reuse/restart, screen and game audio, heterogeneous networks, relay resource and generational-quality cost, depth-four latency, endurance, silent partition recovery, and mobile leaves remain unverified.
- On the current spike branch, `npm run check` passes type checking, 11 Vitest files with 129 tests, and both client and server production builds.
- Draft SFU PR #12 and ADR-0003 remain unmerged, undeployed, and independently reversible. There is no infrastructure blocker for the current Web deployment or bounded spike.

## Provisional Quality Targets

- Controlled direct path at RTT no more than 40 ms and loss no more than 1%: glass-to-glass p50 no more than 150 ms and p95 no more than 250 ms.
- Regional TURN/UDP under the same endpoint conditions: glass-to-glass p95 no more than 350 ms.
- First picture within 3 seconds after a watch request, excluding explicit permission time.
- A 60 fps profile must not remain below 50 decoded fps for more than 5 seconds without a visible downgrade or limiting reason.

These are measurement gates, not performance claims.

## Open Decisions

- Sustainable viewer count by broadcaster hardware, quality profile, network class, and media route; use instrumented 1/3/5/8 comparisons rather than a 1:8 claim.
- Whether ADR-0004 passes fanout, re-encoding, depth-four latency, reparenting, silent-partition, and mobile-leaf gates.
- Exact mobile lifecycle behavior and whether Windows per-application audio is required for the first release.
- Project license and distribution model, which determines whether GPL/AGPL sources can move beyond study-only use.
- Initial deployment regions and expected mainland China, Hong Kong, and overseas network mix.
- Whether voice chat ever enters scope or Screener stays complementary to an existing voice application.

## Source Of Truth

- Documentation index: `docs/README.md`
- Current phase: `docs/status.md`
- Requirements and first PoC design: linked from the documentation index
- Media research: `docs/research/webrtc-p2p-screen-sharing.md`, `docs/research/peer-assisted-media.md`, and `docs/research/low-server-media-routes.md`
- Architecture: ADR-0001, ADR-0002, proposed experiment ADR-0004, and Draft PR #12's unaccepted ADR-0003
- Deployment and maintenance: `docs/deployment.md`, `docs/maintenance.md`, `AGENTS.md`, and `.codex/`
