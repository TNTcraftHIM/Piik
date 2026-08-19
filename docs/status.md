# Current Status

Last updated: 2026-08-19

## Phase

The WebRTC proof of concept at `https://share.bonfire.icu` runs commit
`5b2fb005f6f7` with live quality/source changes, video pause, protected SQLite
rooms, sequential IDs, and reusable links.

Production still creates one host peer connection per viewer. `main` now
contains the default-off two-chain peer assistance, optional automatic SFU
fallback, and simplified entry/diagnostics from merged PRs #13, #17, and #19;
none is deployed. Corrected route recovery works but misses its sub-second gate.

## Current Snapshot

- Capture precedes room creation. Live source and quality changes preserve healthy peers; picture pause keeps audio and connections active. `contentHint = "motion"` and explicit `balanced` degradation do not guarantee resolution-first behavior.
- Whole-site `ACCESS_PASSWORD` is optional. Protected sessions use a stateless 12-hour HMAC HttpOnly `SameSite=Strict` cookie; host authentication remains internal and signaling is role-bound.
- Without `ROOM_DATABASE_PATH`, rooms are random and temporary. With both the database path and site password, room IDs start at `1`, links persist, and stopping a share leaves viewers waiting. SQLite stores only room ID and host-token digest.
- Direct ICE is preferred independently per media edge. Authenticated TURN/UDP and TURN/TCP are required production fallbacks; TURN/TLS is optional.
- Hidden routing is `direct P2P -> peer-assisted -> optional SFU`. After bounded ICE recovery it tries peer reparenting before an allowlisted SFU root. Session-bound revisions prepare, commit break-before-make under two host edges, or abort. Active SFU gets one token refresh, then fails back for that share.
- A viewer starts as a leaf each session and explicitly advertises relay capacity zero or one; the Web client reports detected mobile/iPad clients as zero and desktop-class browsers as one. Withdrawal stops future assignment without moving a healthy edge. Browser relays remain one-child; the host remains two-child.
- Draft PR #21 keeps one strict, memory-only video setting for current/future relays/SFU; ordinary P2P wire is unchanged. It exposes bounded clarity-first controls. Browser audio remains request/presence-only.
- It builds on `main`'s equal idle-stage share/join actions and default-closed technical details; actionable warnings remain visible. It is not deployed.

## Verified Evidence

- Production passed 108 tests, both builds, public HTTPS/access/TURN checks, clean activation, and a database restart retaining room `1`.
- PR #13 introduced `npm run benchmark:peer-assisted`; its 152-test baseline and both builds passed.
- A short Chrome 151 synthetic `1/3/5/8` benchmark passed every topology check: host active edges peaked at two, relay edges at one, every viewer kept increasing decoded frames through the measurement window, and the slowest first decoded frame was about 1.05 seconds. Closing a first-level relay in the three-viewer run recovered in about 5.32 seconds without exceeding host fanout two.
- Chrome 151 with one host, three viewers, and synthetic 720p30 passed balanced and clarity propagation to every participant. Every baseline active video sender showed matching preference readback, peer-connection fingerprints stayed stable, and every viewer decoded and rendered new frames after each change; host fanout was two and relay fanout one.
- That quality smoke was localhost, headless, and video-only. It proves control propagation and continuity, not visual quality, full-resolution performance, CPU/GPU load, TURN, public networks, or endurance.
- Corrected Chrome 151/LiveKit 1.13.5 synthetic 720p30 smoke physically failed the same leaf through peer recovery/reparent and a two-root SFU route. Its frames resumed; 472 hook-assisted 25 ms samples saw host edge peak two. Failure report to active took 1.481 seconds and to new render 2.257 seconds.
- The review revision passes repository hygiene, type checking, 20 Vitest files/264 tests, both production builds, and the Chrome control smoke above.
- Chrome 151 CDP checks at 320/375/390 CSS px keep the two idle-stage actions equal, on one row, 44 px high, and free of horizontal overflow. The Viewer waiting page also has no overflow; its details checkbox starts false, changes locally, and resets after navigation. These checks cover idle/waiting states, not live media.
- Draft PR [#16](https://github.com/TNTcraftHIM/Screener/pull/16) passes CI for one Pion RTP write fanned to two transports. It has no encoder and proves neither physical encode nor browser E2E.
- Local diagnostics use adjacent non-overlapping `getStats()` deltas; empty, changed-stream, and reset intervals rebase instead of publishing lifetime averages.
- Production HTTPS/WSS, access cookie, room/WebSocket authorization, certificate renewal, public STUN, and authenticated TURN/UDP and TURN/TCP relay-only bidirectional paths are verified. TURN/TLS is intentionally disabled.

## Unverified Boundaries

- The short harness uses synthetic headless capture and proves topology, controls, stats collection, and recovery only. Full-resolution 30-minute runs, relay CPU/GPU, generational quality, controlled loss/RTT, depth latency, and actual game-capture behavior remain unverified.
- Android Chrome and iOS Safari remain unverified leaves. Runtime capability conservatively marks detected mobile/iPad clients as leaves; real UA/lifecycle behavior remains open.
- The observed recovery starts from a page close immediately seen by the server. A silent partition can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; it remains unverified.
- Real screen/game audio, heterogeneous machines and networks, mobile lifecycle behavior, the production live quality/pause cycle, room `1` stop-and-republish/link reuse, and sustained profile performance remain unverified.
- Production users report severe resolution/bitrate/FPS degradation across all profiles. The Draft now permits bounded clarity/balanced comparison, but a controlled 1/2/3-viewer and TURN sample must still distinguish capture, per-edge CPU, path, and receiver limits before any quality claim or automatic controller.
- Browser relays do not share encoding. Encoded objects, custom congestion control, multiple trees, and network coding remain separate measured candidates.
- The long-term endpoint budget is at most two downstream edges for both the host and relay-capable viewers, with one compatible encoded output reused across both edges where a native media engine can prove it. The current browser spike remains host capacity two/viewer capacity one and performs a new encode at each relay. Packet/layer striping and multi-parent assembly are recorded, not implemented.

## Next Milestone

Before enabling `main`'s experimental routes, address the 2.257-second fallback
and validate public transports, rollback, reconnect, controls, edge counts,
egress, and load. The quality stack remains undeployed until those gates pass.

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
