# LiveKit SFU Media Mode Research

- Research date: 2026-08-18
- Scope: optional single-node SFU for Screener's one-broadcaster, small-room use
- Status: design input; deployment and performance are not yet verified

## Finding

LiveKit is a suitable first SFU experiment because it provides a maintained
WebRTC SFU, browser SDK, Node token SDK, congestion handling, and self-hosted
single-node operation under Apache-2.0. It can remove P2P's per-viewer publisher
upload, but it cannot remove bandwidth cost: the same media must leave the SFU
once per subscribing viewer.

This finding supports only an explicit deployment mode. P2P stays the default,
and no automatic or hybrid topology is justified before comparable measurements
exist.

## Current Upstream Baseline

The following versions were current when checked:

| Component | Version | License | Role |
| --- | --- | --- | --- |
| LiveKit Server | `v1.13.5` | Apache-2.0 | Single-node SFU and ICE endpoint |
| `livekit-client` | `2.22.0` | Apache-2.0 | Browser publish/subscribe SDK |
| `livekit-server-sdk` | `2.17.0` | Apache-2.0 | Backend join-token signing |

The server's official architecture describes an SFU that forwards encoded
tracks without manipulating the underlying media packets. A publisher uploads
one stream; the SFU forwards a copy to each interested subscriber. A single
node has no external dependency, while Redis is required for distributed
multi-node routing.

Primary sources:

- [LiveKit Server v1.13.5 release](https://github.com/livekit/livekit/releases/tag/v1.13.5)
- [LiveKit Server license](https://github.com/livekit/livekit/blob/master/LICENSE)
- [`livekit-client` package manifest](https://github.com/livekit/client-sdk-js/blob/main/package.json)
- [`livekit-server-sdk` package manifest](https://github.com/livekit/node-sdks/blob/main/packages/livekit-server-sdk/package.json)
- [LiveKit SFU architecture](https://docs.livekit.io/reference/internals/livekit-sfu/)

## Cost And Performance Model

For one published layer at bitrate `B` and `N` viewers, excluding audio,
headers, retransmission, and FEC:

| Mode | Broadcaster upload | Media-server traffic | Main pressure |
| --- | ---: | ---: | --- |
| P2P | about `N * B` | near zero for direct pairs | broadcaster upload and per-peer encoding |
| P2P through TURN | about `N * B` | about `B` in + `B` out per relayed pair | broadcaster and relay egress |
| SFU | about `B` | about `B` in + `N * B` out | SFU egress and availability |

At 8 Mbps and eight viewers, SFU output is about 64 Mbps or 28.8 GB per hour
before overhead. It avoids transcoding CPU, but still performs encryption,
packet routing, retransmission, and congestion work. No supported viewer count,
latency improvement, or server size can be inferred from this arithmetic.

The first experiment should disable simulcast and publish one layer so the
broadcaster has one encode target. That keeps the experiment comparable to the
current quality profile. Simulcast or SVC may later improve heterogeneous viewer
adaptation, but each adds encoding and policy choices that need measurements.

## Fit With Screener

Screener already has the control-plane concepts that LiveKit should not replace:

| Screener responsibility | SFU-mode treatment |
| --- | --- |
| Whole-site password and cookie | Remains the first admission gate |
| Room identity and persistence | Remains in RoomStore/SQLite |
| Host ownership | Remains protected by Screener's host token |
| Viewer limit | Remains enforced before issuing a LiveKit token |
| Stop and waiting state | Remains a Screener room lifecycle event |
| P2P SDP/candidate routing | Used only when `MEDIA_MODE=p2p` |
| Media forwarding | Delegated to LiveKit only when `MEDIA_MODE=sfu` |

The mode should be selected once at startup. A deterministic LiveKit room name
can be derived from the Screener room ID; a stable host participant identity
ensures that a replacement host session cannot coexist with a stale publisher.
LiveKit room lifetime is not persistence: an empty LiveKit room may disappear
and be recreated while the Screener invitation remains valid.

The Node server SDK signs JWTs asynchronously. Tokens must be short-lived,
room-bound, and role-bound. The minimum grants are:

- host: join, publish screen video/audio only, no subscribe, no data;
- viewer: join and subscribe only, no media or data publication;
- neither role receives room administration, listing, recording, ingress, or
  egress grants.

Tokens are bearer credentials. Send them only after Screener authentication,
keep them out of invitation URLs and persistent browser storage, and use an API
secret of at least 32 bytes. The current LiveKit client carries the token in the
`/rtc/` WebSocket handshake query, so the reverse proxy must not log request
targets for that location. Token expiry limits new use of a leaked token;
official docs state that expiry does not terminate an already connected
participant.

Sources:

- [Access tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/)
- [Node server SDK token example](https://github.com/livekit/node-sdks/blob/main/packages/livekit-server-sdk/README.md)
- [JavaScript client API](https://docs.livekit.io/reference/client-sdk-js/)
- [Local participant API](https://docs.livekit.io/reference/client-sdk-js/classes/LocalParticipant.html)
- [Local track replacement API](https://docs.livekit.io/reference/client-sdk-js/classes/LocalTrack.html)

## Single-Node Network Shape

Official self-hosting guidance uses a trusted WSS origin. The installed
`livekit-client` 2.22.0 source and tests show that connecting to a base origin
such as `wss://share.example.com` appends LiveKit's own `/rtc/v1` route and uses
`/rtc/v1/validate` for validation. This is not an arbitrary application path
prefix. The minimal template can therefore keep `LIVEKIT_URL` at the existing
Screener origin and route `location ^~ /rtc/` to LiveKit without rewriting the
URI. `/signal` and every other path continue to reach Screener. A dedicated SFU
hostname remains a valid deployment choice, but is not required by the
single-host baseline.

The minimal same-host listeners are:

| Listener | Exposure | Purpose |
| --- | --- | --- |
| host `7880/tcp` | nginx only; blocked publicly | LiveKit HTTP/API/WebSocket |
| `share.example.com:443/tcp` | public | Trusted TLS; `/rtc/*` reaches LiveKit |
| public `7881/tcp` | direct | WebRTC ICE/TCP fallback |
| public `7882/udp` | direct | WebRTC ICE/UDP mux |

The example omits `bind_addresses` so LiveKit can create its required listeners;
port 7880 is isolated with the host and provider firewalls rather than exposed.
`rtc.use_external_ip: true` lets LiveKit discover and advertise the mapped
public address. If discovery is wrong, the official sample documents using an
explicit `node_ip` with `use_external_ip: false`; that is a deployment-specific
choice, not a second default. `rtc.udp_port` replaces the default UDP port range.
The single-port mux is appropriate for a small experiment, but upstream advises
using a range at least comparable to CPU count for higher performance.

Omitting Redis is intentional for one node. The API key file and Screener's
matching environment values are untracked secrets. LiveKit's `generate-keys`
command can create a pair; operators must put the `key: secret` mapping in a
mode-`0600` service-owned file and put the same values in Screener's secret
environment.

The host firewall and any provider-level firewall/security group must both be
checked before external testing. A tracked template cannot prove that either
one permits 7881/TCP and 7882/UDP, nor that NAT preserves the advertised public
address.

Sources:

- [Self-hosted deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
- [Ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [Official configuration sample](https://github.com/livekit/livekit/blob/master/config-sample.yaml)
- [`livekit-client` URL construction](https://github.com/livekit/client-sdk-js/blob/main/src/api/utils.ts)

## Strict Networks And TURN

ICE/UDP 7882 and ICE/TCP 7881 cover the first experiment, but they do not prove
reachability through every enterprise proxy or policy-controlled network.
LiveKit supports embedded TURN and external TURN configuration. Screener already
operates coturn, but reusing it requires matching LiveKit's generated
credentials, coturn shared-secret policy, relay permissions, and public tests.

The first template deliberately does not enable either TURN option:

- embedded TURN would introduce additional 3478/443 listeners that can conflict
  with the existing coturn and HTTPS ingress on one public IP;
- external coturn wiring is plausible through `rtc.turn_servers`, but must not be
  declared working until UDP-blocked and forced-relay browser tests pass.

This is a known experimental connectivity gap, not a reason to add an untested
configuration. If SFU mode is later recommended for normal use, its tested TURN
fallback becomes a release requirement.

## Encryption Boundary

LiveKit encrypts each browser-to-SFU WebRTC transport. Without LiveKit's optional
E2EE layer, the SFU terminates DTLS-SRTP and can access media; ordinary SFU mode
must not be called E2EE. LiveKit supports Web E2EE with an external key provider
and worker, but explicitly leaves secure key generation, distribution, and
rotation to the application.

The whole-site access password is not an appropriate media key. Implementing
real server-excluding E2EE is a separate security design and is outside the
minimum SFU PR.

Sources:

- [Encryption overview and key-distribution responsibility](https://docs.livekit.io/transport/encryption/)
- [Web E2EE setup](https://docs.livekit.io/transport/encryption/start/)

## Verification Before Recommendation

Run P2P and SFU with the same source, quality profile, machines, and network
cohort at 1, 3, 5, and 8 viewers. Record broadcaster upload and encode load,
server ingress/egress and CPU, viewer receive/decoded frame rates, selected ICE
transport, loss, first picture, and glass-to-glass latency. Include Windows
Chrome/Edge, Android Chrome, iOS Safari, UDP, UDP-blocked ICE/TCP, stop and
republish, source replacement, and a short Screener signaling interruption.

Until that matrix exists, LiveKit is an available experiment, not the project's
recommended or proven media path.
