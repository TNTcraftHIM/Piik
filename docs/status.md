# Current Status

Last updated: 2026-08-19

## Phase

The WebRTC proof of concept at `https://share.bonfire.icu` runs commit
`5b2fb005f6f7` with live quality/source changes, video pause, protected SQLite
rooms, sequential IDs, and reusable links.

Production still creates one host `RTCPeerConnection` per viewer. Draft PR #13
adds default-off, maximum-eight-viewer peer assistance: two sticky chains,
host capacity two, viewer capacity one, per-hop decode/re-encode, and synchronized
quality profiles. Draft SFU PR #12 is also unmerged and undeployed.

## Current Snapshot

- Capture precedes room creation. Live source and quality changes preserve healthy peers; picture pause keeps audio and connections active. `contentHint = "motion"` and explicit `balanced` degradation do not guarantee resolution-first behavior.
- Whole-site `ACCESS_PASSWORD` is optional. Protected sessions use a stateless 12-hour HMAC HttpOnly `SameSite=Strict` cookie; host authentication remains internal and signaling is role-bound.
- Without `ROOM_DATABASE_PATH`, rooms are random and temporary. With both the database path and site password, room IDs start at `1`, links persist, and stopping a share leaves viewers waiting. SQLite stores only room ID and host-token digest.
- Direct ICE is preferred independently per media edge. Authenticated TURN/UDP and TURN/TCP are required production fallbacks; TURN/TLS is optional.
- The required media priority has always been direct P2P, then peer assistance, then an enabled user-operated or central SFU fallback, with route allocation and recovery hidden from host and viewers. The current peer-assisted Draft already assigns the first two viewers to the host and later viewers to peers automatically. Cross-mode failure fallback and live migration are not implemented yet; they must preserve the host two-edge budget, minimize server egress, and use a small deterministic state machine rather than composite health scoring.
- Peer-assisted profile state is bounded, server-memory-only, and absent from the ordinary P2P wire. The host reasserts its choice after authentication; online viewers receive changes, and each relay applies the latest desired profile to its current or future child through serialized sender mutations.

## Verified Evidence

- Production passed 108 tests, both builds, public HTTPS/access/TURN checks, clean activation, and a database restart with room `1` retained.
- Draft PR #13 now provides `npm run benchmark:peer-assisted`; the full check passes type checking, 13 Vitest files with 152 tests, and both production builds.
- A short Chrome 151 synthetic `1/3/5/8` benchmark passed every topology check: host active edges peaked at two, relay edges at one, every viewer kept increasing decoded frames through the measurement window, and the slowest first decoded frame was about 1.05 seconds. Closing a first-level relay in the three-viewer run recovered in about 5.32 seconds without exceeding host fanout two.
- A separate live-profile smoke kept the same relay peer, sender, and signaling generations through 8 Mbps/60, 5 Mbps/30, and 3 Mbps/30 ceilings while its leaf kept decoding.
- Local WebRTC diagnostics derive per-frame encode/decode cost from adjacent non-overlapping `getStats()` samples. First, empty, changed-stream, and reset intervals stay unknown and rebase instead of publishing a misleading lifetime average.
- Production HTTPS/WSS, access cookie, room/WebSocket authorization, certificate renewal, public STUN, and authenticated TURN/UDP and TURN/TCP relay-only bidirectional paths are verified. TURN/TLS is intentionally disabled.

## Unverified Boundaries

- The short harness uses synthetic headless capture and proves topology, controls, stats collection, and recovery only. Full-resolution 30-minute runs, relay CPU/GPU, generational quality, controlled loss/RTT, depth latency, and actual game-capture behavior remain unverified.
- Android Chrome and iOS Safari remain required leaves but are not verified for this topology. There is no runtime relay-capability bit; controlled join order is the only mobile-leaf enforcement, so arbitrary-user deployment is excluded.
- The observed recovery starts from a page close immediately seen by the server. A silent partition can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; it remains unverified.
- Real screen/game audio, heterogeneous machines and networks, mobile lifecycle behavior, the production live quality/pause cycle, room `1` stop-and-republish/link reuse, and sustained profile performance remain unverified.
- Browser relays do not provide shared encoding. Encoded Transform, DataChannel/WebCodecs media, custom congestion control, multiple trees, and network coding remain researched alternatives rather than current implementation. They may enter a separate bounded experiment only when measurements identify a specific bottleneck and show a plausible sub-second benefit.
- The long-term endpoint budget is at most two downstream edges for both the host and relay-capable viewers, with one compatible encoded output reused across both edges where a native media engine can prove it. The current browser spike remains host capacity two/viewer capacity one and performs a new encode at each relay. Packet/layer striping and multi-parent assembly are recorded, not implemented.

## Next Milestone

Complete ADR-0004 before UI polish: run full-resolution 30-minute `1/3/5/8`
matrices with network shaping and resource/quality/latency capture; exercise source,
profile, stop/restart, rebuild, reparent, signaling and silent-partition paths; and
verify Chrome/Edge relays with Android Chrome and iOS Safari leaves.

In parallel, Proposed ADR-0005 defines the smallest automatic route controller
for `direct P2P -> peer-assisted -> optional SFU`. It must use explicit
budgets and discrete failure events, avoid continuous composite scoring, and
specify make-before-break or a bounded visible interruption before any live
migration is implemented. The current Draft still performs no automatic
cross-mode migration.

For a disconnect immediately observed by the server, the gate retains the
default 5-second grace followed by at most 3 seconds to restore a decodable
picture, about 8 seconds total. Silent partitions include their detection delay.

ADR-0004 gates fail closed for the current full-stream browser path. Native
shared encode and packet/layer striping are separate measured experiments, not
ways to relabel a failed browser-relay result.

## Blockers And Decisions

Production peer assistance remains blocked on the matrix and ADR-0004 gates.
Automatic cross-mode routing, native shared encode, and multi-tree striping each
require their own bounded ADR/spike.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
- Whether peer assistance passes every non-encoding gate; any other failure closes that route.
