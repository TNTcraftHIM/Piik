# Current Status

Last updated: 2026-08-19

## Phase

The WebRTC proof of concept is deployed at `https://share.bonfire.icu`. Commit
`5b2fb005f6f7` adds live 1080p60/1080p30/720p30 quality changes, video-only
pause, clearer connection states, protected SQLite persistence, sequential room
IDs, reusable links, and a waiting state after sharing stops. Production room ID
`1` survived the deployment restart.

Production still uses one host `RTCPeerConnection` per viewer. Draft PR #13 adds
a default-off, standard-WebRTC peer-assisted experiment for later viewers: two
sticky chains with host capacity two, viewer capacity one, and decode/re-encode
at every browser relay hop. `PEER_ASSISTED_MEDIA=false` remains the default, the
mode cannot be enabled above eight viewers, and it is neither merged, deployed,
nor production-validated. Draft SFU PR #12 is also unmerged and undeployed.

## Current Snapshot

- Product scope is private game sharing for one broadcaster and a small trusted friend group; public broadcasting remains out of scope.
- Runtime is Node.js 24, React, TypeScript, Vite, native browser WebRTC, `ws`, Zod, Vitest, and a separate coturn deployment.
- Capture precedes room creation. Live source and quality changes preserve healthy peers; picture pause keeps audio and connections active. `contentHint = "motion"` and explicit `balanced` degradation do not guarantee resolution-first behavior.
- Whole-site `ACCESS_PASSWORD` is optional. Protected sessions use a stateless 12-hour HMAC HttpOnly `SameSite=Strict` cookie; host authentication remains internal and signaling is role-bound.
- Without `ROOM_DATABASE_PATH`, rooms are random and temporary. With both the database path and site password, room IDs start at `1`, links persist, and stopping a share leaves viewers waiting. SQLite stores only room ID and host-token digest.
- Direct ICE is preferred independently per media edge. Authenticated TURN/UDP and TURN/TCP are required production fallbacks; TURN/TLS is optional.
- The media priority is direct P2P for one or two viewers, peer assistance only after every ADR-0004 gate passes, then user-operated or central single-node SFU as an explicit fallback. There is no automatic migration.

## Verified Evidence

- Production release `5b2fb005f6f7` passed type checking, 108 Vitest tests, both production builds, loopback smoke, public HTTPS/access-gate checks, and clean activation under `/opt/screener/current`. The new 1080p30 asset loaded, Screener had zero automatic restarts, and nginx, coturn, and the existing blog remained healthy.
- The protected production database and permissions survived restart, and room ID `1` remained present. Stop-and-republish and link reuse still require a browser cycle.
- The recorded peer-assisted full check passes type checking, 12 Vitest files with 135 tests, and both client and server production builds.
- Chromium 151 one-to-three evidence held exactly two connected host outbound peers. Viewer 1 held one inbound plus one outbound peer and forwarded to viewer 3; viewer 2 stayed direct; all three decoded frames.
- A Chromium 151 one-to-eight synthetic functional smoke formed two depth-four chains. The host held two outbound peers; viewers 1 through 6 each held one inbound plus one outbound; viewers 7 and 8 were leaves; all decoded frames. This proves topology only, not quality, resource cost, latency, or endurance.
- Closing the first-level relay caused its branch to reattach and decode again after about 5.3 seconds while host active connected outbound edges peaked at two.
- Production HTTPS/WSS, access cookie, room/WebSocket authorization, certificate renewal, public STUN, and authenticated TURN/UDP and TURN/TCP relay-only bidirectional paths are verified. TURN/TLS is intentionally disabled.
- Headless Chromium 151 synthetic checks cover direct UDP media, offer/answer/create-offer recovery, generation isolation, live video/audio replacement, quality parameter updates, and video-only pause. Layout checks used actual inner widths 500, 781, and 820 px; a true 390 px viewport remains unverified.

## Unverified Boundaries

- Relay senders still use a fixed `1080p60`/8 Mbps envelope instead of the host-selected room profile. Profile propagation blocks valid peer-assisted quality and resource comparisons.
- Peer assistance has not completed 1/3/5/8-viewer 30-minute runs, relay CPU/GPU and generational-quality measurements, controlled loss/RTT tests, or depth-four latency gates.
- Android Chrome and iOS Safari remain required leaves but are not verified for this topology. There is no runtime relay-capability bit; controlled join order is the only mobile-leaf enforcement, so arbitrary-user deployment is excluded.
- The observed recovery starts from a page close immediately seen by the server. A silent partition can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; it remains unverified.
- Real screen/game audio, heterogeneous machines and networks, mobile lifecycle behavior, the production live quality/pause cycle, room `1` stop-and-republish/link reuse, and sustained profile performance remain unverified.
- Browser relays do not provide shared encoding. Encoded Transform, DataChannel/WebCodecs media, custom congestion control, multiple trees, relay scoring, and automatic SFU switching remain outside the experiment.

## Next Milestone

Complete only the bounded ADR-0004 experiment, with distribution work ahead of
UI polish:

- propagate one room quality profile to host and relay senders before comparative media measurements;
- preserve host fanout at two and viewer fanout at one across joins, reconnects, grace expiry, and reparenting;
- run reproducible 1/3/5/8-viewer measurements using the deployed profiles, recording topology depth, selected ICE path, host/relay upload, encode/decode work, first picture, decoded FPS, quality limitation, and glass-to-glass latency;
- repeat first-level relay loss with a server-observed close and separately measure silent heartbeat-detected partition recovery; and
- verify current Chrome/Edge relays plus Android Chrome and iOS Safari leaves.

For a disconnect immediately observed by the server, the gate retains the
default 5-second grace followed by at most 3 seconds to restore a decodable
picture, about 8 seconds total. Silent partitions include their detection delay.

All gates fail closed. If success requires a custom browser media plane, changed
RTP recovery, multiple trees, scoring, transcoding, a codec ladder, or more than
two host edges, remove the experiment. Only an isolated re-encoding failure may
advance to a separate native shared-encode and volunteer encoded-RTP proposal.

## Blockers And Decisions

No infrastructure blocker remains. Production adoption of peer assistance is
blocked on profile propagation and the measurement matrix above.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
- Whether peer assistance passes every non-encoding gate; any other failure closes that route.
