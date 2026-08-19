# Current Status

Last updated: 2026-08-19

## Phase

The WebRTC proof of concept at `https://share.bonfire.icu` runs commit
`5b2fb005f6f7` with live quality/source changes, video pause, protected SQLite
rooms, sequential IDs, and reusable links.

Production still creates one host peer connection per viewer. Draft PR #13 adds
default-off two-chain peer assistance with per-hop re-encoding; ADR-0005 adds
optional automatic SFU fallback. Corrected recovery passes functionally but
misses its sub-second gate; neither Draft is merged or deployed.

## Current Snapshot

- Capture precedes room creation. Live source and quality changes preserve healthy peers; picture pause keeps audio and connections active. `contentHint = "motion"` and explicit `balanced` degradation do not guarantee resolution-first behavior.
- Whole-site `ACCESS_PASSWORD` is optional. Protected sessions use a stateless 12-hour HMAC HttpOnly `SameSite=Strict` cookie; host authentication remains internal and signaling is role-bound.
- Without `ROOM_DATABASE_PATH`, rooms are random and temporary. With both the database path and site password, room IDs start at `1`, links persist, and stopping a share leaves viewers waiting. SQLite stores only room ID and host-token digest.
- Direct ICE is preferred independently per media edge. Authenticated TURN/UDP and TURN/TCP are required production fallbacks; TURN/TLS is optional.
- Hidden routing is `direct P2P -> peer-assisted -> optional SFU`. After bounded ICE recovery it tries peer reparenting before an allowlisted SFU root. Session-bound revisions prepare, commit break-before-make under two host edges, or abort. Active SFU gets one token refresh, then fails back for that share.
- A viewer starts as a leaf each session and explicitly advertises relay capacity zero or one; the Web client reports detected mobile/iPad clients as zero and desktop-class browsers as one. Withdrawal stops future assignment without moving a healthy edge. Browser relays remain one-child; the host remains two-child.
- Peer-assisted profile state is bounded, memory-only, absent from ordinary P2P wire, and applied to current and future relay children.

## Verified Evidence

- Production passed 108 tests, both builds, public HTTPS/access/TURN checks, clean activation, and a database restart retaining room `1`.
- Draft PR #13 now provides `npm run benchmark:peer-assisted`; the full check passes type checking, 13 Vitest files with 152 tests, and both production builds.
- A short Chrome 151 synthetic `1/3/5/8` benchmark passed every topology check: host active edges peaked at two, relay edges at one, every viewer kept increasing decoded frames through the measurement window, and the slowest first decoded frame was about 1.05 seconds. Closing a first-level relay in the three-viewer run recovered in about 5.32 seconds without exceeding host fanout two.
- A separate live-profile smoke kept the same relay peer, sender, and signaling generations through 8 Mbps/60, 5 Mbps/30, and 3 Mbps/30 ceilings while its leaf kept decoding.
- Corrected Chrome 151/LiveKit 1.13.5 synthetic 720p30 smoke physically failed the same leaf through peer recovery/reparent and a two-root SFU route. Its frames resumed; 472 hook-assisted 25 ms samples saw host edge peak two. Failure report to active took 1.481 seconds and to new render 2.257 seconds.
- The current Draft passes type checking, 19 Vitest files/253 tests, both production builds, dependency audit, and repository hygiene.
- Draft PR [#16](https://github.com/TNTcraftHIM/Screener/pull/16) passes CI for one Pion RTP write fanned to two transports. It has no encoder and proves neither physical encode nor browser E2E.
- Local diagnostics use adjacent non-overlapping `getStats()` deltas; empty, changed-stream, and reset intervals rebase instead of publishing lifetime averages.
- Production HTTPS/WSS, access cookie, room/WebSocket authorization, certificate renewal, public STUN, and authenticated TURN/UDP and TURN/TCP relay-only bidirectional paths are verified. TURN/TLS is intentionally disabled.

## Unverified Boundaries

- The short harness uses synthetic headless capture and proves topology, controls, stats collection, and recovery only. Full-resolution 30-minute runs, relay CPU/GPU, generational quality, controlled loss/RTT, depth latency, and actual game-capture behavior remain unverified.
- Android Chrome and iOS Safari remain unverified leaves. Runtime capability conservatively marks detected mobile/iPad clients as leaves; real UA/lifecycle behavior remains open.
- The observed recovery starts from a page close immediately seen by the server. A silent partition can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; it remains unverified.
- Real screen/game audio, heterogeneous machines and networks, mobile lifecycle behavior, the production live quality/pause cycle, room `1` stop-and-republish/link reuse, and sustained profile performance remain unverified.
- Production users report severe resolution/bitrate/FPS degradation across all profiles. A controlled 1/2/3-viewer and TURN sample must distinguish capture, per-edge CPU, bandwidth/path, and receiver limits before changing ceilings or codecs; clarity-first versus `balanced` is the first bounded A/B.
- Browser relays do not share encoding. Encoded objects, custom congestion control, multiple trees, and network coding remain separate measured candidates.
- The long-term endpoint budget is at most two downstream edges for both the host and relay-capable viewers, with one compatible encoded output reused across both edges where a native media engine can prove it. The current browser spike remains host capacity two/viewer capacity one and performs a new encode at each relay. Packet/layer striping and multi-parent assembly are recorded, not implemented.
- The corrected smoke is localhost/headless/video-only; public transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.

## Next Milestone

Finish ADR-0005 before UI polish: address the 2.257-second fallback, then
validate public transports, rollback, reconnect, controls, edge counts, egress,
and load.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix.

For a disconnect immediately observed by the server, the gate retains the
default 5-second grace followed by at most 3 seconds to restore a decodable
picture, about 8 seconds total. Silent partitions include their detection delay.

ADR-0004 fails closed. Native shared encode and packet/layer striping remain
separate experiments, not ways to relabel a failed browser route.

## Blockers And Decisions

Peer assistance and automatic routing remain blocked on ADR-0004/0005 gates.
Native shared encode and multi-tree striping remain separate experiments.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
- Whether peer assistance passes every non-encoding gate; any other failure closes that route.
