# Current Status

Last updated: 2026-08-19

## Phase

The standard one-`RTCPeerConnection`-per-viewer WebRTC PoC is deployed at
`https://share.bonfire.icu`. Commit `2f66770f8e90` is the deployed baseline for
protected SQLite rooms, sequential reusable IDs, and waiting after sharing
stops. This path still exceeds the new host-fanout target above two viewers.

The spike branch contains a default-off, standard-WebRTC peer-assisted
experiment for later viewers. It assigns two sticky chains with host capacity
two and viewer capacity one, then relays remote tracks with a decode/re-encode
at every browser hop. `PEER_ASSISTED_MEDIA=false` remains the default and the
mode cannot be enabled above eight viewers. Limited Chromium evidence now proves
the intended three-viewer shape, a synthetic eight-viewer functional topology,
and one controlled page-close recovery, but the mode is not merged, deployed,
or production-validated. Draft SFU PR #12 is also unmerged and undeployed.

## Current Snapshot

- Product scope is private game sharing for one broadcaster and a small trusted friend group; public broadcasting remains out of scope.
- Runtime is Node.js 24, React, TypeScript, Vite, native browser WebRTC, `ws`, Zod, Vitest, and a separate coturn deployment.
- Capture precedes room creation. Healthy peers survive source replacement, and local stats report path, candidate, RTT, bitrate, frame, loss, jitter, codec, and quality-limitation data.
- Whole-site `ACCESS_PASSWORD` is optional. Protected sessions use a stateless 12-hour HMAC HttpOnly `SameSite=Strict` cookie; host authentication remains internal and signaling is role-bound.
- Without `ROOM_DATABASE_PATH`, rooms are random and temporary. With both the database path and site password, room IDs start at `1`, links persist, and stopping a share leaves viewers waiting. SQLite stores only room ID and host-token digest.
- Direct ICE is preferred independently per media edge. Authenticated TURN/UDP and TURN/TCP are required production fallbacks; TURN/TLS is optional.
- The experimental media priority remains direct P2P for one or two viewers, peer-assisted only after its gates pass, then user-operated or central single-node SFU as an explicit fallback. There is no automatic migration.

## Verified Evidence

- On the current spike branch, `npm run check` passes type checking, 11 Vitest files with 129 tests, and both client and server production builds.
- The production site runs behind nginx on Debian 12 with Node.js 24.19.0. Authenticated coturn 4.17.2 serves public STUN and TURN/UDP+TCP on `turn.bonfire.icu:3478`; TURN/TLS is intentionally disabled.
- HTTPS/WSS, the site gate and cookie, room/WebSocket authorization, certificate renewal, SQLite permissions and clean service restart are verified. Public Chromium relay-only connections passed bidirectional traffic over TURN/UDP and TURN/TCP.
- Earlier Chromium 151 synthetic-media checks covered direct UDP media, offer/answer/create-offer recovery, signaling reconnect generation isolation, live video/audio source replacement, and the protected 390 px viewer flow.
- In a real Chromium 151 one-to-three-viewer run, the host held exactly two connected outbound media peers. Viewer 1 held one inbound and one outbound peer and forwarded media to viewer 3; viewer 2 remained directly attached to the host. All three viewers decoded frames.
- A Chromium 151 one-to-eight synthetic functional smoke formed two depth-four chains. The host held two connected outbound peers; viewers 1 through 6 each held one inbound and one outbound peer; viewers 7 and 8 were inbound-only leaves; all viewers decoded frames. This short smoke proves functional topology only, not 720p60 quality, resource cost, latency, or endurance.
- Closing that first-level relay page caused its branch to reattach and decode again after about 5.3 seconds. The host's peak active connected outbound media-edge count remained two.
- That recovery proves only the path where the server observes a page close immediately. A silent network partition depends on the 30-second heartbeat, so detection can take 30 to 60 seconds before the 5-second viewer grace begins; that path is unverified.

## Unverified Boundaries

- The peer-assisted mode has not completed 1/3/5/8-viewer 30-minute runs, relay CPU/GPU and generational-quality measurements, controlled loss/RTT tests, or depth-four latency gates.
- Android Chrome and iOS Safari remain required leaves but are not verified for this topology. The protocol has no relay-capability bit; controlled join order is the only mobile-leaf enforcement, so arbitrary-user deployment is excluded.
- Real screen/game audio, heterogeneous machines and networks, browser lifecycle behavior, and sustained 1080p60 or 720p60 performance remain unverified.
- The first real protected room still needs room ID `1`, stop-and-republish, link reuse, and service-restart verification.
- Shared browser encoding is not available. Encoded Transform, DataChannel/WebCodecs media, custom congestion control, multiple trees, relay scoring, and automatic SFU switching remain outside the spike.
- Relay outbound diagnostics are visible, but relays still use a fixed `1080p60`/8 Mbps sender envelope instead of the host's selected profile. Profile propagation must be unified before quality or resource comparisons are valid.

## Next Milestone

Complete only the bounded ADR-0004 experiment:

- preserve host fanout at two and viewer fanout at one across joins, reconnects, grace expiry, and reparenting;
- propagate one room quality profile to host and relay senders before comparative media measurements;
- run reproducible 1/3/5/8-viewer 720p60 measurements for topology depth, selected ICE path, host/relay upload, encode/decode work, first picture, decoded FPS, quality limitation, and glass-to-glass latency;
- repeat first-level relay loss with server-observed close and separately measure silent heartbeat-detected partition recovery; and
- verify current Chrome/Edge relays plus Android Chrome and iOS Safari leaves.

For a disconnect immediately observed by the server, the recovery gate retains
the default 5-second grace followed by at most 3 seconds to restore a decodable
picture, about 8 seconds total. Silent partitions must be reported separately
with their heartbeat-detection delay.

All gates fail closed. If success requires a custom browser media plane, changed
RTP recovery, multiple trees, scoring, transcoding, a codec ladder, or more than
two host edges, remove this experiment. Only an isolated re-encoding failure may
advance to a separate native shared-encode and volunteer encoded-RTP proposal.

## Blockers And Decisions

No infrastructure blocker remains. Production adoption is blocked on the
measurement matrix above, not implementation claims.

- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network cohort.
- Project license and distribution model.
- Whether peer assistance passes every non-encoding gate; any other failure closes that route.
