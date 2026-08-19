# Project Memory

Last updated: 2026-08-19

## Confirmed Intent

- Build Discord/KOOK/Oopz/TeamSpeak-like low-latency game screen sharing for one broadcaster and a small trusted friend group. Public or large broadcasts belong on OBS/Twitch-class services.
- Viewers should join from a normal desktop or mobile browser. A packaged/native sender is a planned later stage for shared encoding and may also improve capture and audio without changing the Web viewer requirement.
- Use a small central service for access, rooms, signaling, deterministic topology, STUN/TURN, and observability while clients carry media whenever practical.
- Server bandwidth cost is a primary constraint. The ordered media ladder is direct P2P, then measured peer assistance, then an enabled user-operated or central SFU fallback. Route selection and failure recovery must be automatic and viewer-transparent, while remaining deterministic, budget-driven, and small enough to reason about. This has always been the product intent; earlier text prohibiting silent migration was an incorrect interpretation and is superseded.
- Host and relay-capable endpoints each have a target budget of at most two downstream media edges. Every P2P edge independently uses direct ICE or authenticated TURN fallback. With two edges, the long-term native/encoded-object path should reuse one compatible encoded output; the current browser experiment is stricter at one viewer child and re-encodes.
- Packet or layer striping across two peer trees is a recorded candidate for reducing endpoint upload toward one full-stream bitrate. It requires a separate bounded experiment for multi-parent assembly, loss recovery, synchronization, churn, and sub-second latency; it is not part of the current full-stream two-chain implementation.
- Shared encoding reduces compute, not each viewer's last-hop copy.
- Durable decisions, current snapshots, research, code, `AGENTS.md`, and `.codex/` belong in Git. Memory and status are rewritten in place rather than kept as transcripts.
- Research current official sources and established implementations before material work. Apply Occam's razor and reject speculative protocols, services, scoring, and scale.

## Current Recommendation

- Keep desktop Chrome/Edge and the responsive Web viewer as the baseline. Validate Android Chrome and iOS Safari as leaves.
- Use direct host P2P for one or two viewers. Keep ADR-0004's two-chain experiment off on production: without LiveKit, two mobile/iPad leaves can consume both host roots and leave later viewers admitted without media. Test it only on an isolated instance until the full resource, quality, recovery, TURN, and browser/mobile gates pass.
- Standard browser relays resend remote `MediaStreamTrack` values and therefore decode and re-encode at every hop. Browser WebRTC does not guarantee one shared encoder across peer connections; measure this cost rather than hiding it.
- Keep the browser experiment bounded. Evaluate native RTP relay, encoded-object striping, SVC, or FEC only in separate measured spikes.
- Plan a separate native-sender ADR for TeamSpeak-style shared encoding regardless of the browser relay result. One compatible encoded output may feed at most two standard WebRTC packetizers to reduce host encode work, but each edge still consumes upload bandwidth. This work is not part of the current Draft and cannot rescue another failed browser-relay gate.
- Keep user-operated or central single-node SFU capacity optional. When configured, `main`'s #17 route controller may select it only as the final fallback; its fanout egress belongs to its operator and does not justify Redis or multi-node infrastructure. Closed PR #12's explicit whole-room SFU mode is superseded, not a current option.
- Keep automatic routing default-off behind ADR-0005: discrete failures drive peer recovery and optional SFU fallback, host media uses break-before-make under two active edges, and a binary relay capability keeps mobile/iPad clients as leaves. Merged PR #20's token-free prewarm passes the local sub-second gate; public transport and load gates remain.
- Prefer direct UDP, then TURN/UDP, with TURN/TCP as the required non-UDP fallback. Optional TURN/TLS uses TCP 5349 by default; TCP 443 needs a dedicated address or validated L4/SNI routing.
- Treat video settings as ceilings. Production now defaults clarity-first with bounded manual controls and sender readback, but reported degradation remains unclassified. Keep browser audio request/presence-only: capture channels/rate are not portable controls, `maxBitrate` cannot raise quality, and Opus stereo/DTX/FEC lack portable setters. Run the 1/2/3-viewer plus TURN matrix before changing ceilings or adding an automatic controller.
- Do not add custom scene detection or dynamic-FPS control until WebRTC statistics and host resource measurements prove a material gap. Keep browser codec order until target hardware proves a more efficient common codec.
- Keep room policy deployment-driven. Public and password-only deployments use random temporary rooms. A site password plus SQLite path enables sequential persistent rooms; stopping sharing leaves the room and viewer link available.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production commit `769de201f7cc` runs at `https://share.bonfire.icu`. It adds equal share/join entry actions, default-closed details, clarity-first bounded quality settings, live source/quality changes, video pause, and visible sender warnings.
- Production still uses one host `RTCPeerConnection` per viewer because peer assistance and LiveKit are unconfigured; above two viewers it still exceeds the target host-edge budget. Its real game-capture quality/pause cycle remains unverified.
- Access stays small: optional `ACCESS_PASSWORD`, a 12-hour stateless HMAC HttpOnly `SameSite=Strict` cookie, internal host token, role-bound signaling, Origin/payload checks, and no accounts, JWTs, or session map.
- With `ROOM_DATABASE_PATH` and the site password, SQLite stores only room ID and host-token digest. Links persist and stopping leaves viewers waiting. Room `1` survived the `769de201f7cc` deployment; without the path, rooms are random and temporary.
- Production runs behind nginx with Node.js 24.19.0. Authenticated coturn 4.17.2 at `turn.bonfire.icu:3478` has verified public STUN, TURN/UDP, TURN/TCP, and relay-only traffic. TURN/TLS is intentionally disabled.
- The deployed binary contains the default-off peer relay and ADR-0005 controller, but production has neither `PEER_ASSISTED_MEDIA` nor a LiveKit tuple. It therefore exposes no standby URL, imports no SFU SDK at runtime, and uses only the existing P2P/TURN path.
- When enabled later, peer recovery precedes an allowlisted SFU root; session-bound revisions prepare/commit/abort, and an active SFU gets one token refresh before share-local failback. Browser relays re-encode; native shared encoding remains unimplemented.
- Corrected Chrome 151/LiveKit 1.13.5 same-leaf/two-root cold/standby A/B reduced failure-to-active from 1.481 seconds to 200 ms and failure-to-render from 2.257 seconds to 319.7 ms. The leaf decoded/rendered 31 new frames and 25 ms sampling kept host edge peak two. It is localhost, headless, synthetic 720p30 video only; the roughly 86% result combines SDK download/parse and network prewarm and must not be extrapolated to public networks.
- Draft PR #16 (`5b09f0a`) proves one Pion RTP write fans equivalent data to two transports with independent SSRCs. It has no encoder and proves neither physical shared encode nor browser readiness.
- Chrome 151 short synthetic `1/3/5/8` runs kept host edges at two, relay edges at one, and all viewers decoding; a three-viewer relay close recovered in 5.32 seconds. This proves topology/control only, not quality, load, endurance, or silent partitions.
- The current quality stack uses one strict, non-persistent `QualitySettings` value: 720p/1080p/1440p, integer 15-60 fps, 2-12 Mbps, and clarity/balanced/fluid preference. Host-only updates are last-wins for current/future relays and optional SFU; ordinary P2P wire stays unchanged. Initial, replaced, and updated senders share serialized configure/readback; rejection, rewriting, or three identical native limitation samples produce one visible warning without automatic action. Successful replacement rollback retains the original failure warning.
- Chrome 151 with one host, three viewers, and synthetic 720p30 passed balanced and clarity propagation to every participant. Every baseline active video sender showed matching preference readback, peer fingerprints stayed stable, and every viewer decoded and rendered new frames after each change; host fanout was two and relay fanout one. This is control evidence, not a quality, load, public-network, or endurance claim.
- Per-frame encode/decode diagnostics use adjacent non-overlapping `getStats()` deltas rather than connection-lifetime averages; first, empty, changed-stream, and reset intervals remain unknown and rebase.
- Release `769de201f7cc` passed main CI, repository hygiene, type checking, 22 Vitest files/274 tests, both builds, zero production dependency vulnerabilities, atomic activation, public health/access checks, exact bundle verification, and service/log checks.

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
- Media research: `docs/research/webrtc-p2p-screen-sharing.md`, `docs/research/realtime-quality-adaptation.md`, `docs/research/browser-screen-audio-quality.md`, `docs/research/peer-assisted-media.md`, `docs/research/low-server-media-routes.md`, `docs/research/advanced-peer-distribution.md`, and `docs/research/native-shared-encode-sender.md`
- Architecture: ADR-0001/0002, proposed ADR-0004/0005, and rejected/superseded ADR-0003
- Deployment and maintenance: `docs/deployment.md`, `docs/maintenance.md`, `AGENTS.md`, and `.codex/`
