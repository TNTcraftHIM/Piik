# Current Status

Last updated: 2026-08-19

## Phase

The WebRTC proof of concept at `https://share.bonfire.icu` runs commit
`5b2fb005f6f7` with live quality/source changes, video pause, protected SQLite
rooms, sequential IDs, and reusable links.

Production still creates one host peer connection per viewer. `main` now
contains the default-off two-chain peer assistance, optional automatic SFU
fallback, simplified entry/diagnostics, and bounded quality settings from merged
PRs #13, #17, #19, and #21; none is deployed. Draft PR #20's token-free standby
prewarm passes the local sub-second recovery gate.

## Current Snapshot

- Capture precedes room creation. Live source and quality changes preserve healthy peers; picture pause keeps audio and connections active. `contentHint = "motion"` and explicit `balanced` degradation do not guarantee resolution-first behavior.
- Whole-site `ACCESS_PASSWORD` is optional. Protected sessions use a stateless 12-hour HMAC HttpOnly `SameSite=Strict` cookie; host authentication remains internal and signaling is role-bound.
- Without `ROOM_DATABASE_PATH`, rooms are random and temporary. With both the database path and site password, room IDs start at `1`, links persist, and stopping a share leaves viewers waiting. SQLite stores only room ID and host-token digest.
- Direct ICE is preferred independently per media edge. Authenticated TURN/UDP and TURN/TCP are required production fallbacks; TURN/TLS is optional.
- Hidden routing is `direct P2P -> peer-assisted -> optional SFU`. After bounded ICE recovery it tries peer reparenting before an allowlisted SFU root. Session-bound revisions prepare, commit break-before-make under two host edges, or abort. Active SFU gets one token refresh, then fails back for that share.
- Complete fallback configuration adds a non-secret standby URL to peer-assisted authentication. Host and viewers import the SDK and make one token-free DNS/TLS warmup; no configuration means no field, import, request, participant, or media edge.
- A viewer starts as a leaf each session and explicitly advertises relay capacity zero or one; the Web client reports detected mobile/iPad clients as zero and desktop-class browsers as one. Withdrawal stops future assignment without moving a healthy edge. Browser relays remain one-child; the host remains two-child.
- `main` uses one strict, memory-only quality setting for current/future relays and optional SFU; ordinary P2P wire stays unchanged. It defaults clarity-first, exposes bounded manual ceilings, and keeps SFU initial/update/replacement warnings visible.
- `main` also carries equal idle-stage share/join actions and default-closed technical details. These changes are not deployed.

## Verified Evidence

- Production passed 108 tests, both builds, public HTTPS/access/TURN checks, clean activation, and a database restart retaining room `1`.
- A short Chrome 151 synthetic `1/3/5/8` benchmark passed every topology check: host active edges peaked at two, relay edges at one, every viewer kept increasing decoded frames through the measurement window, and the slowest first decoded frame was about 1.05 seconds. Closing a first-level relay in the three-viewer run recovered in about 5.32 seconds without exceeding host fanout two.
- A localhost/headless Chrome 151 run with one host, three viewers, and synthetic 720p30 propagated balanced and clarity settings to every participant. Every active sender matched preference readback, peer fingerprints stayed stable, all viewers decoded/rendered new frames, and fanout stayed host two/relay one. This proves control continuity, not visual quality or performance.
- Corrected Chrome 151/LiveKit 1.13.5 localhost/headless/video-only same-leaf A/B measured the cold path at 1.481 seconds to active and 2.257 seconds to render. Standby prepare arrived in 5 ms, active in 200 ms, and the same leaf rendered in 319.7 ms with 31 new decoded/frame-callback frames; 25 ms sampling kept host edge peak two. The roughly 86% result combines early SDK download/parse with token-free DNS/TLS/HTTP prewarm, creates no participant/media edge, and does not predict public-network performance.
- The integrated PR #20 revision passes repository hygiene, type checking, 22 Vitest files/274 tests, both production builds, and the existing Chrome evidence above.
- Chrome 151 CDP checks at 320/375/390 CSS px keep the two idle-stage actions equal, on one row, 44 px high, and free of horizontal overflow. The Viewer waiting page also has no overflow; its details checkbox starts false, changes locally, and resets after navigation. These checks cover idle/waiting states, not live media.
- Local diagnostics use adjacent non-overlapping `getStats()` deltas; empty, changed-stream, and reset intervals rebase instead of publishing lifetime averages.
- Production HTTPS/WSS, access cookie, room/WebSocket authorization, certificate renewal, public STUN, and authenticated TURN/UDP and TURN/TCP relay-only bidirectional paths are verified. TURN/TLS is intentionally disabled.

## Unverified Boundaries

- Full-resolution 30-minute runs, relay CPU/GPU, generational quality, controlled loss/RTT, depth latency, and actual game capture remain unverified.
- Android Chrome and iOS Safari remain unverified leaves. Runtime capability conservatively marks detected mobile/iPad clients as leaves; real UA/lifecycle behavior remains open.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real screen/game audio, heterogeneous machines and networks, mobile lifecycle behavior, the production live quality/pause cycle, room `1` stop-and-republish/link reuse, and sustained profile performance remain unverified.
- Production users report severe resolution/bitrate/FPS degradation across all profiles. The Draft now permits bounded clarity/balanced comparison, but a controlled 1/2/3-viewer and TURN sample must still distinguish capture, per-edge CPU, path, and receiver limits before any quality claim or automatic controller.
- Browser relays do not share encoding. Encoded objects, custom congestion control, multiple trees, and network coding remain separate measured candidates.
- The endpoint budget is host/relay at most two downstream edges; a native engine must prove shared encoding. The browser path remains host two/viewer one and re-encodes per relay. Striping and multi-parent assembly are only recorded.
- The corrected standby smoke is localhost/headless/video-only; public DNS/TLS reuse, transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.

## Next Milestone

Before enabling `main`'s experimental routes, validate standby gains across
public transports, rollback, reconnect, controls, edge counts, egress, and load.
The quality and routing stacks remain undeployed until those gates pass.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix.

For a disconnect immediately observed by the server, the gate retains the
default 5-second grace followed by at most 3 seconds to restore a decodable
picture, about 8 seconds total. Silent partitions include their detection delay.

ADR-0004 fails closed. Native shared encode and packet/layer striping remain
separate experiments, not ways to relabel a failed browser route.

## Blockers And Decisions

Production enablement of peer assistance and automatic routing remains blocked
on ADR-0004/0005 gates.
Native shared encode and multi-tree striping remain separate experiments.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
- Whether peer assistance passes every non-encoding gate; any other failure closes that route.
