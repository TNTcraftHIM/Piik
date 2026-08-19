# Current Status

Last updated: 2026-08-19

## Phase

`https://share.bonfire.icu` runs commit `769de201f7cc` with simplified entry,
default-closed diagnostics, bounded clarity-first quality settings, persistent
rooms, and reusable links. Peer assistance and LiveKit are unconfigured, so the
deployed binary still uses one host peer connection per viewer and P2P/TURN.

## Current Snapshot

- Capture precedes room creation. Live source/quality changes preserve healthy peers; picture pause keeps audio and connections active. Quality defaults to `maintain-resolution`, with balanced and fluid options.
- Whole-site `ACCESS_PASSWORD` is optional. Protected sessions use a stateless 12-hour HMAC HttpOnly `SameSite=Strict` cookie; host authentication remains internal and signaling is role-bound.
- Without `ROOM_DATABASE_PATH`, rooms are random and temporary. With both the database path and site password, room IDs start at `1`, links persist, and stopping a share leaves viewers waiting. SQLite stores only room ID and host-token digest.
- Direct ICE is preferred independently per media edge. Authenticated TURN/UDP and TURN/TCP are required production fallbacks; TURN/TLS is optional.
- Hidden routing is `direct P2P -> peer-assisted -> optional SFU`. After bounded ICE recovery it tries peer reparenting before an allowlisted SFU root. Session-bound revisions prepare, commit break-before-make under two host edges, or abort. Active SFU gets one token refresh, then fails back for that share.
- Complete fallback configuration adds a non-secret standby URL to peer-assisted authentication. Host and viewers import the SDK and make one token-free DNS/TLS warmup; no configuration means no field, import, request, participant, or media edge.
- A viewer starts as a leaf each session and explicitly advertises relay capacity zero or one; the Web client reports detected mobile/iPad clients as zero and desktop-class browsers as one. Withdrawal stops future assignment without moving a healthy edge. Browser relays remain one-child; the host remains two-child.
- Production uses one strict, memory-only video quality setting with bounded manual ceilings and sender readback. It also carries equal idle-stage share/join actions and default-closed technical details. Browser audio remains request/presence-only.

## Verified Evidence

- Release `769de201f7cc` passed main CI, repository hygiene, type checking, 22 Vitest files/274 tests, both builds, and zero production dependency vulnerabilities.
- A short Chrome 151 synthetic `1/3/5/8` benchmark passed every topology check: host active edges peaked at two, relay edges at one, every viewer kept increasing decoded frames through the measurement window, and the slowest first decoded frame was about 1.05 seconds. Closing a first-level relay in the three-viewer run recovered in about 5.32 seconds without exceeding host fanout two.
- A localhost/headless Chrome 151 run with one host, three viewers, and synthetic 720p30 propagated balanced and clarity settings to every participant. Every active sender matched preference readback, peer fingerprints stayed stable, all viewers decoded/rendered new frames, and fanout stayed host two/relay one. This proves control continuity, not visual quality or performance.
- Corrected Chrome 151/LiveKit 1.13.5 localhost/headless/video-only same-leaf A/B measured the cold path at 1.481 seconds to active and 2.257 seconds to render. Standby prepare arrived in 5 ms, active in 200 ms, and the same leaf rendered in 319.7 ms with 31 new decoded/frame-callback frames; 25 ms sampling kept host edge peak two. The roughly 86% result combines early SDK download/parse with token-free DNS/TLS/HTTP prewarm, creates no participant/media edge, and does not predict public-network performance.
- Atomic production activation passed public/local health, exact served-bundle hash, unauthenticated 401, room `1` page, SQLite preservation, active Screener/nginx/coturn, and a clean warning log. The old release remains available for rollback.
- Chrome 151 CDP checks at 320/375/390 CSS px keep the two idle-stage actions equal, on one row, 44 px high, and free of horizontal overflow. The Viewer waiting page also has no overflow; its details checkbox starts false, changes locally, and resets after navigation. These checks cover idle/waiting states, not live media.
- Local diagnostics use adjacent non-overlapping `getStats()` deltas; empty, changed-stream, and reset intervals rebase instead of publishing lifetime averages.
- Production HTTPS/WSS, access cookie, room/WebSocket authorization, certificate renewal, public STUN, and authenticated TURN/UDP and TURN/TCP relay-only bidirectional paths are verified. TURN/TLS is intentionally disabled.
- Draft native ladder #16/#18/#22/#23/#25/#28 passed a bounded 720p30 two-leg loop: one WebCodecs object accepted the lower stock-GCC target, one isolated loss recovered, and leg 2 stayed clean. Research-only.

## Unverified Boundaries

- Full-resolution 30-minute runs, relay CPU/GPU, generational quality, controlled loss/RTT, depth latency, and actual game capture remain unverified.
- Android Chrome and iOS Safari remain unverified leaves. Runtime capability conservatively marks detected mobile/iPad clients as leaves; real UA/lifecycle behavior remains open.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Real screen/game audio, heterogeneous machines/networks, mobile lifecycle, the new production quality/pause cycle, room `1` stop/re-publish, and sustained profiles remain unverified.
- Earlier production showed severe degradation across all profiles. The new controls permit clarity/balanced comparison, but a controlled 1/2/3-viewer and TURN sample must still isolate capture, CPU, path, and receiver limits before any quality claim or automatic controller.
- Browser relays re-encode. The native ladder proves one WebCodecs object, not one physical/hardware encode. Stock GCC plus RTX is no-go; no-RTX passed one controlled loss but weakens statistics. Audio, heterogeneous estimates, broader loss, direct/TURN, reconnect, browser diversity, product wiring, striping, and multi-parent assembly remain unverified.
- The endpoint budget remains host/relay at most two downstream edges; the browser path is host two/viewer one.
- The corrected standby smoke is localhost/headless/video-only; public DNS/TLS reuse, transport, audio, shaping, load, mobile, endurance, and sub-25 ms overlap remain open.

## Next Milestone

First validate the deployed quality controls on real game capture. Before
enabling experimental routes, validate standby gains across public transports,
rollback, reconnect, edge counts, egress, and load.

ADR-0004 still requires a full-resolution 30-minute `1/3/5/8` network,
resource, quality, latency, recovery, and browser/mobile-leaf matrix.

For a disconnect immediately observed by the server, the gate retains the
default 5-second grace followed by at most 3 seconds to restore a decodable
picture, about 8 seconds total. Silent partitions include their detection delay.

ADR-0004 fails closed. Native shared encode and packet/layer striping remain
separate experiments, not ways to relabel a failed browser route.

The native ladder stops at #28. Do not bypass stock GCC/RTX with custom
transport/control; no-RTX remains research-only.

## Blockers And Decisions

Production enablement of peer assistance and automatic routing is No-Go until
ADR-0004/0005 gates pass. Without LiveKit, two mobile leaves can occupy both
host roots and leave later viewers without media; use only an isolated canary.
Native shared encode and multi-tree striping remain separate experiments.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
- Whether peer assistance passes every non-encoding gate; any other failure closes that route.
