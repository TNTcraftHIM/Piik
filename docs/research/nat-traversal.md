# Browser NAT Traversal

Last reviewed: 2026-09-01

This document owns evidence for improving direct Browser ICE without adding a
new relay or a custom transport. The current product contract remains standard
WebRTC ICE with STUN discovery and bounded SFU fallback.

## Confirmed Boundaries

- STUN discovers mapped addresses for ICE; it does not carry media.
- Chromium's shared UDP port sends to multiple configured STUN servers. Its
  tests retain two srflx candidates when the servers report different mapped
  addresses and deduplicate the result when they report the same address.
- A STUN operator observes the client's source address, source port, request
  time and protocol metadata. It never receives the DTLS-SRTP media path. An
  external STUN endpoint is therefore a metadata dependency, not a media relay.
- The current `STUN_URLS` wire already accepts a bounded list. Adding an
  auxiliary STUN destination needs no client compatibility surface, but it has
  no product value until a valid Browser observation or prediction consumer
  exists.

On 2026-08-31, Chrome 151 on Windows gathered a host plus IPv4 srflx candidate
through the self-hosted STUN endpoint and independently through Cloudflare's
official STUN endpoint while the machine used TUN and fake-IP DNS. With both
configured, Chromium emitted one deduplicated srflx candidate. No raw address or
port was retained. This proves endpoint reachability and candidate
deduplication; it does not classify the NAT or prove another direct path.

## Browser Prediction Preflight

A 2026-09-01 Chrome 151 preflight repeated the combined self-hosted plus
Cloudflare STUN gathering in six fresh PeerConnections. Each STUN destination
produced an srflx candidate when tested alone, while every combined run exposed
only one deduplicated srflx endpoint. The only valid mapping result remained
`unknown`; individual reachability does not make a single combined candidate
positive evidence of EIM.

One ICE restart exposed a different srflx endpoint in that environment, and a
synthetic standards-shaped remote srflx candidate using a documentation address
was accepted by `addIceCandidate()`. The first observation proves only that a
new mapping can occur: WebRTC specifies new ICE credentials and a new gathering
phase, not a new socket or mapping on every implementation and network. The
second proves candidate syntax only; it does not prove that a predicted NAT
mapping receives an authenticated connectivity check. The probe retained no raw
address or port.

This preflight also leaves the Browser-only mapper without an ordered port
delta. Candidate events expose response completion, while configured STUN order
does not specify the NAT allocation order. A disposable namespace matrix then
provided the controlled gate: its four-by-four baseline matched the expected
reachability classes, and bounded prediction improved sequential-to-restricted
connectivity in 14/15 runs. Sequential-to-sequential pairs still depended on
candidate ordering and remained sensitive to intervening mappings. The result
supports an opt-in mechanism, not a default or a participant-wide classifier.

## Current Decision

The flagship STUN configuration remains unchanged. The self-hosted endpoint is
still the ordinary discovery service; ports 3479 and 3480 are optional
STUN-only listeners for an explicitly enabled room experiment.

The accepted experiment is deliberately connection-local and additive. It
derives the two auxiliary ports from the existing STUN authority, waits for a
clear three-point arithmetic `srflx` shape in one ICE generation, and appends a
small two-sided candidate window from the observed port-sequence endpoint.
Ordinary candidates trickle immediately, so unavailable auxiliary listeners
cannot hold back stock ICE. There is no NAT label, hard candidate skip,
route-controller input, or SFU preference. The Host switch is default off,
locks while sharing, and applies to Host, Viewer upstream, and Viewer relay P2P
connections. Its exact scope is recorded in
[ADR-0009](../adr/0009-connection-local-nat-prediction-experiment.md).

### Independent Observation And Attribution Preflight

On 2026-09-01, Chrome 151 on the flagship Windows network gathered one `srflx`
candidate independently from the self-hosted endpoint, Xiaomi, Bilibili, and
Cloudflare within a five-second bound. `stun.qq.com:3478` produced none in the
same ordered run. Candidate events and local candidate stats preserved the exact
STUN `url`, so independent destinations can remain ordinary candidates while
only self-hosted 3478/3479/3480 observations feed prediction. These are measured
reachability results, not third-party availability commitments.

A second real-Chrome loopback rewrote only one remote candidate foundation to
`sp1`, established the data channel, and read `sp1` from the selected remote
candidate stats. The product can therefore report `predicted | ordinary |
unknown` selection without retaining or uploading addresses, ports, foundations,
or STUN URLs. Field acceptance still requires target-network outcomes; this
preflight proves the attribution mechanism, not prediction prevalence.

The Browser-only alternatives do not yet have an accepted implementation:

- WebRTC ICE already exchanges observed candidates and performs coordinated
  connectivity checks. libp2p's mature hole-punching specification explicitly
  keeps private Browser peers on WebRTC because Browser code cannot own or
  reuse the underlying UDP, QUIC or TCP socket.
- Tailscale compares mappings observed by different STUN destinations, but
  keeps `MappingVariesByDestIP` as a tri-state network report. It retains an
  additional mapped endpoint only after repeated observation; it does not turn
  one NAT label into hard connection rejection or a predicted port.
- A second STUN destination supplies an observation, not a new path through an
  endpoint-dependent NAT. Deploying it without a consumer adds metadata
  exposure and candidate traffic without proving more direct connections.

The Browser API is also weaker than the raw-socket netcheck model:

- Different srflx endpoints prove only that the current Browser socket's mapping
  varied by destination. An identical endpoint is deduplicated before the
  application sees it, so one emitted candidate cannot distinguish stable
  mapping from a second STUN destination that did not answer.
- Candidate events expose response completion order, not a specified STUN send
  or NAT allocation order. Sorting by configured URL or event time cannot turn
  observed ports into a standards-backed sequential delta.
- ICE restart creates a new generation and may use a new socket. Network
  interface, VPN/TUN route and CGNAT allocation traffic can all change between
  generations.

Consequently Browser observations can support a positive `varies` diagnostic,
but cannot produce the proposed `eim | edm-sequential | edm-random` participant
fact. They cannot safely remove a Peer candidate or alter route ordering and
deadlines.

Port prediction remains an experiment rather than a default path. The
controlled namespace matrix supports the bounded mechanism, but field
prevalence, direction, and resource impact are not established. The experiment
therefore stays opt-in and additive until target-network evidence justifies
enabling it by default.

## Rejected Product Inference

Multiple STUN destinations can expose whether one current socket received the
same or different mappings. They do not establish a stable participant-wide NAT
type:

- RFC 5780 behavior discovery requires carefully controlled alternate address
  tests, warns that adding destinations can change observed behavior, and says
  results can vary by source port or become more restrictive later.
- Mapping behavior does not reveal filtering behavior. A Browser cannot infer
  that a Peer pair is impossible from mapping samples alone.
- A global `eim | edm` fact would cross connection generations, interfaces,
  VPN/TUN routes and physical network changes that own different sockets.

Therefore NAT samples must not skip a P2P candidate, alter the committed graph,
or become a persistent participant capability. Successful `addIceCandidate()`
parsing proves only candidate syntax; it does not prove that a predicted mapping
receives authenticated ICE checks. The accepted experiment keeps this boundary:
it adds no protocol fields or controller state and falls back to ordinary ICE
when its shape test is inconclusive.

QUIC on UDP 443 does not change this Browser boundary. WebRTC's ICE agent owns
its UDP sockets and candidate checks; the Web application cannot replace that
transport with a custom QUIC hole-punching socket. LiveKit may use its own
supported WebRTC transport configuration, but that is the bounded SFU path, not
a new Peer route.

## Primary Sources

- [RFC 8445: Interactive Connectivity Establishment](https://datatracker.ietf.org/doc/html/rfc8445)
- [RFC 4787: UDP NAT behavioral requirements](https://datatracker.ietf.org/doc/html/rfc4787)
- [RFC 5780: NAT Behavior Discovery Using STUN](https://datatracker.ietf.org/doc/html/rfc5780)
- [IETF symmetric NAT prediction draft](https://datatracker.ietf.org/doc/html/draft-takeda-symmetric-nat-traversal-00)
- [W3C WebRTC candidate model](https://www.w3.org/TR/webrtc/)
- [Chromium shared-socket STUN tests](https://webrtc.googlesource.com/src/+/refs/heads/main/p2p/base/stun_port_unittest.cc)
- [Tailscale netcheck mapping observations](https://github.com/tailscale/tailscale/blob/main/net/netcheck/netcheck.go)
- [libp2p Browser and DCUtR hole-punching boundary](https://github.com/libp2p/specs/blob/master/connections/hole-punching.md)
- [coturn listener and auxiliary endpoint reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
- [Cloudflare Realtime STUN service](https://developers.cloudflare.com/realtime/turn/)
- [WebRTC selected candidate stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatestats-foundation)
