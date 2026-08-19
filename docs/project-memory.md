# Project Memory

Last updated: 2026-08-19

## Confirmed Intent

- Build Discord/KOOK/Oopz/TeamSpeak-like low-latency game screen sharing for one broadcaster and a small trusted friend group. Public or large broadcasts belong on OBS/Twitch-class services.
- Viewers should join from a normal desktop or mobile browser. A packaged/native sender is a planned later stage for shared encoding and may also improve capture and audio without changing the Web viewer requirement.
- Use a Photon-style central rendezvous service for access, rooms, signaling, deterministic topology, STUN, TURN fallback, and observability while clients carry media whenever practical.
- Server bandwidth cost is a primary constraint. The ordered media ladder is direct P2P, then measured peer assistance, then an enabled user-operated or central SFU fallback. Route selection and failure recovery must be automatic and viewer-transparent, while remaining deterministic, budget-driven, and small enough to reason about. This has always been the product intent; earlier text prohibiting silent migration was an incorrect interpretation and is superseded.
- Host and relay-capable endpoints each have a target budget of at most two downstream media edges. Every P2P edge independently uses direct ICE or authenticated TURN fallback. With two edges, the long-term native/encoded-object path should reuse one compatible encoded output; the current browser experiment is stricter at one viewer child and re-encodes.
- Packet or layer striping across two peer trees is a recorded candidate for reducing endpoint upload toward one full-stream bitrate. It requires a separate bounded experiment for multi-parent assembly, loss recovery, synchronization, churn, and sub-second latency; it is not part of the current full-stream two-chain implementation.
- Browser convenience does not override reachability or honest resource accounting. Shared encoding reduces compute, not each viewer's last-hop copy.
- Durable decisions, current snapshots, research, code, `AGENTS.md`, and `.codex/` belong in Git. Memory and status are rewritten in place rather than kept as transcripts.
- Research current official sources and established implementations before material work. Apply Occam's razor and reject speculative protocols, services, scoring, and scale.

## Current Recommendation

- Keep the deployed Windows Chrome/Edge broadcaster and responsive Web viewer as the measurement baseline. Validate current Android Chrome and iOS Safari as leaves.
- Use direct host P2P for one or two viewers. Draft ADR-0004 and Draft PR #13 own the default-off experiment for later viewers: two sticky deterministic chains, host capacity two, viewer capacity one, no proactive rebalance or composite score, and no more than eight viewers when `PEER_ASSISTED_MEDIA=true`.
- Standard browser relays resend remote `MediaStreamTrack` values and therefore decode and re-encode at every hop. Browser WebRTC does not guarantee one shared encoder across peer connections; measure this cost rather than hiding it.
- Keep the full-stream browser experiment bounded. If it needs a different media plane, mark that experiment failed and evaluate native RTP relay, encoded-object striping, SVC, or FEC in separate measured spikes rather than hiding the change inside ADR-0004.
- Plan a separate native-sender ADR for TeamSpeak-style shared encoding regardless of the browser relay result. One compatible encoded output may feed at most two standard WebRTC packetizers to reduce host encode work, but each edge still consumes upload bandwidth. This work is not part of the current Draft and cannot rescue another failed browser-relay gate.
- Keep user-operated mini-SFU deployment and central single-node SFU Draft PR #12 as optional infrastructure. When configured, the route controller may select them automatically as the last fallback; their fanout egress belongs to their operator and does not justify Redis or multi-node infrastructure.
- Keep automatic routing behind ADR-0005: discrete failures drive peer recovery and optional SFU fallback, host media uses break-before-make and never exceeds two active edges, and a binary per-session relay capability keeps detected mobile/iPad clients as leaves. Token-free authenticated standby prewarm now passes the local sub-second gate; public transport and load gates remain.
- Prefer direct UDP, then TURN/UDP, with TURN/TCP as the required non-UDP fallback. Optional TURN/TLS uses TCP 5349 by default; TCP 443 needs a dedicated address or validated L4/SNI routing.
- Treat 3/5/8 Mbps profiles as ceilings. Production users report severe degradation across all three; run one controlled 1/2/3-viewer capture before changing constants, then A/B clarity-first against `balanced`. Do not hide actual limits or add an automatic score/controller without evidence.
- Do not add custom scene detection or dynamic-FPS control until WebRTC statistics and host resource measurements prove a material gap. Keep browser codec order until target hardware proves a more efficient common codec.
- Keep room policy deployment-driven. Public and password-only deployments use random temporary rooms. A site password plus SQLite path enables sequential persistent rooms; stopping sharing leaves the room and viewer link available.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn. LAN/container listening defaults to all interfaces; bare-metal reverse-proxy deployment binds loopback and exposes `/healthz`.
- Production commit `5b2fb005f6f7` is deployed at `https://share.bonfire.icu`. It provides live source and quality changes without rebuilding healthy peers, video-only pause, clearer connection states, and the standard one-host-`RTCPeerConnection`-per-viewer path. Production therefore still exceeds the two-edge host target above two viewers.
- Production supports the three profiles with `contentHint = "motion"` and `degradationPreference = "balanced"`; its real live quality/pause cycle remains unverified.
- Access stays small: optional `ACCESS_PASSWORD`, a 12-hour stateless HMAC HttpOnly `SameSite=Strict` cookie, internal host token, role-bound signaling, Origin/payload checks, and no accounts, JWTs, or session map.
- With `ROOM_DATABASE_PATH` and the site password, built-in SQLite stores only auto-incremented room ID and host-token digest. Links persist and stopping sharing leaves viewers waiting. Production room ID `1` survived the `5b2fb005f6f7` deployment restart. Without the path, rooms remain random and temporary; public mode cannot use sequential rooms.
- Production runs behind nginx with Node.js 24.19.0. Authenticated coturn 4.17.2 at `turn.bonfire.icu:3478` has verified public STUN, TURN/UDP, TURN/TCP, and relay-only traffic. TURN/TLS is intentionally disabled.
- Draft PR #13 contains deterministic server/client peer-assisted assignment, standard remote-track relay, and synchronized 1080p60/1080p30/720p30 room profiles. It defaults off, is capped at eight viewers, re-encodes at every relay, and is neither merged nor deployed. Native shared encoding and custom encoded browser transport are not implemented.
- Draft PR #17 stacks on PR #13: peer recovery precedes an allowlisted SFU root; revisioned prepare/commit/abort is session-bound; active SFU failure gets one token refresh, then fails back and disables SFU for that share. Draft PR #20 advertises a non-secret standby URL only when configured and performs one token-free SDK import plus DNS/TLS/HTTP warmup per client; it creates no participant/media edge, and LiveKit remains dormant when unconfigured.
- Corrected Chrome 151/LiveKit 1.13.5 same-leaf/two-root cold/standby A/B reduced failure-to-active from 1.481 seconds to 200 ms and failure-to-render from 2.257 seconds to 319.7 ms. The leaf decoded/rendered 31 new frames and 25 ms sampling kept host edge peak two. It is localhost, headless, synthetic 720p30 video only; the roughly 86% result combines SDK download/parse and network prewarm and must not be extrapolated to public networks.
- Draft PR #16 (`5b09f0a`) proves one Pion RTP write fans equivalent data to two transports with independent SSRCs. It has no encoder and proves neither physical shared encode nor browser readiness.
- Chrome 151 short synthetic `1/3/5/8` runs kept host edges at two, relay edges at one, and all viewers decoding; a three-viewer relay close recovered in 5.32 seconds. This proves topology/control only, not quality, load, endurance, or silent partitions.
- The peer-assisted authenticated snapshot and host-only update synchronize one bounded, non-persistent room profile. Online viewers receive changes; `ViewerRelay` uses the latest desired profile for current and future children, while `HostPeer` serializes sender setup, stream replacement, and last-wins profile updates. The ordinary P2P wire is unchanged. Real 1/3/5/8 quality, resource, and latency measurements remain pending.
- Chromium 151 kept relay/sender/signaling generations through 8 Mbps/60, 5 Mbps/30, and 3 Mbps/30 ceilings while the leaf decoded. Synthetic 640x360/30 proves control propagation, not full-resolution load.
- Per-frame encode/decode diagnostics use adjacent non-overlapping `getStats()` deltas rather than connection-lifetime averages; first, empty, changed-stream, and reset intervals remain unknown and rebase.
- Draft PR #17 passes CI. Draft PR #20 passes CI, type checking, 20 Vitest files/259 tests, both builds, dependency audit, and repository hygiene. Production separately passed 108 tests and deployment checks.

## Provisional Quality Targets

- Controlled direct path at RTT no more than 40 ms and loss no more than 1%: glass-to-glass p50 no more than 150 ms and p95 no more than 250 ms.
- Regional TURN/UDP under the same endpoint conditions: glass-to-glass p95 no more than 350 ms.
- First picture within 3 seconds after a watch request, excluding explicit permission time.
- A 60 fps profile must not remain below 50 decoded fps for more than 5 seconds without a visible downgrade or limiting reason.

These are measurement gates, not performance claims.

## Open Decisions

- Sustainable viewer count by broadcaster and relay hardware, quality profile, network class, and media route; use instrumented 1/3/5/8 comparisons rather than a 1:8 claim.
- Whether ADR-0004 passes fanout, re-encoding, depth-four latency, reparenting, silent-partition, and mobile-leaf gates.
- Whether ADR-0005 standby gains persist across public LiveKit UDP/ICE-TCP/TURN, rollback, reconnect, restart, egress, load, and browser-matrix gates.
- Exact mobile lifecycle behavior and whether Windows per-application audio is required for the first release.
- Project license and distribution model, which determines whether GPL/AGPL sources can move beyond study-only use.
- Initial deployment regions and expected mainland China, Hong Kong, and overseas network mix.
- Whether voice chat ever enters scope or Screener stays complementary to an existing voice application.

## Source Of Truth

- Documentation index and current phase: `docs/README.md` and `docs/status.md`
- Requirements and design: `docs/需求理解.md` and `docs/方案设计.md`
- Media research: `docs/research/webrtc-p2p-screen-sharing.md`, `docs/research/realtime-quality-adaptation.md`, `docs/research/peer-assisted-media.md`, `docs/research/low-server-media-routes.md`, `docs/research/advanced-peer-distribution.md`, and `docs/research/native-shared-encode-sender.md`
- Architecture: ADR-0001, ADR-0002, proposed experiments ADR-0004/ADR-0005, and Draft PR #12's unaccepted ADR-0003
- Deployment and maintenance: `docs/deployment.md`, `docs/maintenance.md`, `AGENTS.md`, and `.codex/`
