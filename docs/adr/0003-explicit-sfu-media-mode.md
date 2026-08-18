# ADR-0003: Explicit Optional SFU Media Mode

- Status: Accepted
- Date: 2026-08-18

## Context

ADR-0001 selected one peer connection per viewer because direct media minimizes
server bandwidth for the normal trusted-friends workload. Real use has since
shown severe degradation as viewers were added. That observation is consistent
with P2P fan-out multiplying publisher upload and potentially encoder work, but
it is not yet an instrumented performance result.

An SFU can reduce the broadcaster to one media upload while forwarding that
encoded stream to each viewer. It therefore moves, rather than removes, the
bandwidth cost: for source bitrate `B` and `N` viewers, a single-layer SFU
receives about `B` and sends about `N * B`, before protocol and retransmission
overhead. Making every room use an SFU would contradict the project's cost
constraint and erase the useful direct path for small rooms.

## Decision

Add one deployment-level media choice:

- `MEDIA_MODE=p2p|sfu`, defaulting to `p2p` when omitted.
- The mode is fixed when the Screener process starts and applies to every room
  served by that process.
- There is no automatic viewer-count threshold, in-room topology migration,
  hybrid P2P/SFU room, or simultaneous P2P and SFU publication.
- `p2p` keeps the existing native WebRTC path and its production requirement for
  STUN, authenticated TURN/UDP, and authenticated TURN/TCP.
- `sfu` uses a self-hosted, single-node LiveKit server. Screener remains the
  authority for the whole-site gate, room existence, host ownership, viewer
  admission, capacity, and stop/wait lifecycle. LiveKit handles only the media
  session and its ICE transports.
- Screener issues a short-lived, room-bound LiveKit join token only after its
  existing room authentication succeeds. A host may publish only screen video
  and screen audio and may not subscribe or publish data. A viewer may subscribe
  but may not publish media or data. The API secret never reaches browser
  storage, URLs, or logs.
- The join token stays out of invitations and persistent browser storage.
  Because the LiveKit client transmits it in the `/rtc/` WebSocket query,
  reverse-proxy request logging is disabled for that location.
- The first experiment publishes one encoded layer with simulcast disabled. It
  does not force a codec and does not ask LiveKit to transcode.
- Persistent Screener rooms remain independent of ephemeral LiveKit rooms. No
  LiveKit participant or room state is added to SQLite.
- A normal Screener signaling reconnect does not intentionally disconnect a
  healthy LiveKit media session. Explicit stop or capture ending unpublishes the
  tracks and leaves the Screener room and invitation available.

SFU configuration is dormant in P2P mode. `MEDIA_MODE=sfu` requires a public
`LIVEKIT_URL` plus `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`; the secret must
contain at least 32 bytes and production uses a trusted `wss:` endpoint. A
partially configured LiveKit credential tuple is a startup error. Real
credentials stay outside Git.

The initial deployment shape is deliberately one LiveKit process without
Redis, recording, egress, ingress, webhooks, or multi-node routing. LiveKit's
Apache-2.0 license is compatible with using it as a dependency and separately
deployed service; the repository must retain any notices required if upstream
code is later copied or redistributed.

## Privacy Boundary

WebRTC transport encryption is still used between each browser and LiveKit,
but a conventional SFU terminates those encrypted transports and can access the
media payload. The initial SFU mode is therefore not end-to-end encrypted in the
sense that excludes the media server.

LiveKit offers optional media E2EE, but its official documentation makes the
application responsible for generating and distributing encryption keys. The
whole-site password is not a media key, and a key generated and distributed by
the same trusted server would not make that server unable to decrypt. E2EE key
agreement, rotation, recovery, and browser compatibility require a separate ADR
and implementation; the initial SFU mode must not be described as E2EE.

## Consequences

Positive:

- An operator can test whether one publisher upload removes the observed
  multi-viewer bottleneck without replacing or destabilizing the P2P default.
- The topology is reversible by one explicit configuration change and process
  restart.
- A proven upstream SFU and SDK avoid implementing RTP forwarding, congestion
  control, retransmission, and browser interoperability from scratch.
- One node keeps the experiment operationally small and needs no Redis.

Negative:

- Every SFU viewer consumes server egress, including viewers who could have used
  a direct P2P path.
- The server becomes part of the media latency, availability, privacy, and
  capacity boundary.
- The deployment adds a trusted TLS hostname plus direct ICE/TCP and ICE/UDP
  listeners. Provider firewall and NAT configuration must be verified from an
  external network.
- Strict networks may still require TURN/TLS. The first single-node template
  does not silently reuse coturn or enable LiveKit's embedded TURN, because both
  choices have port, credential, and routing consequences that need their own
  external test.
- Client and server behavior now have two paths to test and maintain, even
  though only one runs in a deployment.

## Measured Recommendation Gate

SFU remains experimental until the same capture and network cohort is tested in
both modes with 1, 3, 5, and 8 viewers. Record at least:

- broadcaster outgoing bitrate, encode time, frame rate, and CPU/GPU load;
- LiveKit ingress, egress, CPU, packet loss, and selected ICE transport;
- viewer receive bitrate, decoded frame rate, loss, first picture, and
  glass-to-glass latency;
- desktop and mobile behavior over direct UDP, ICE/TCP, and any separately
  configured TURN fallback.

Only those measurements can establish a recommended mode or supported viewer
envelope. The presence of the option, a successful build, or a local connection
does not establish a performance claim.

## Rejected Alternatives

- Always-SFU: defeats the default server-bandwidth constraint.
- Automatic threshold switching: requires migration and failure policy before
  there is evidence that a threshold is stable or useful.
- Hybrid per-viewer routing: requires two simultaneous media control paths and
  leaves the publisher carrying some fan-out.
- Simultaneous P2P and SFU publication: duplicates encode/upload work and creates
  ambiguous source-of-truth behavior.
- Redis or multi-node LiveKit: no current room or availability requirement needs
  it.
- A custom SFU or low-level mediasoup integration: more control-plane and media
  work than the experiment requires.
- Calling transport-encrypted SFU media E2EE: inaccurate because LiveKit
  terminates the browser transports without the optional E2EE layer.

## References

Sources were checked on 2026-08-18:

- [LiveKit SFU architecture](https://docs.livekit.io/reference/internals/livekit-sfu/)
- [LiveKit self-hosted deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
- [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [LiveKit access tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/)
- [LiveKit encryption overview](https://docs.livekit.io/transport/encryption/)
- [LiveKit server license](https://github.com/livekit/livekit/blob/master/LICENSE)
