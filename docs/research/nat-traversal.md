# Browser And Native NAT Traversal

Last reviewed: 2026-09-13

This document owns evidence for improving direct ICE without adding a
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

An ordinary STUN endpoint remains the discovery service. A Site may enable
same-host STUN-only listeners on 3479 and 3480. Public-link App mode supplies
one ordinary public endpoint plus two public survey destinations; pure LAN mode
supplies none. Available authorities expose the same per-share Host switch,
which defaults on and remains locked while sharing.

The accepted adapter is deliberately connection-local and additive. It waits for a
clear three-point arithmetic `srflx` shape in one ICE generation, and appends a
small two-sided candidate window from the observed port-sequence endpoint.
Ordinary candidates trickle immediately, so unavailable auxiliary listeners
cannot hold back stock ICE. There is no NAT label, hard candidate skip,
route-controller input, or SFU preference. Browser candidates are filtered by
their reported STUN URL. Native Pion performs the same survey through its
`UniversalUDPMux`, so every observation and subsequent media packet uses one
socket. Only explicitly marked Native survey observations feed prediction;
the independently mapped-port candidate does not. The switch applies to Host,
Viewer upstream, and Viewer relay P2P connections. Its exact scope is recorded in
[ADR-0009](../adr/0009-optional-nat-prediction.md).

Browser and Native candidate adapters use the same generation-scoped predictor;
Native observations do not need a second Go predictor. Predictions can trickle
as soon as the third qualifying survey observation arrives. Route scheduling
continues to use the operation deadline in ADR-0005, independently of whether
prediction produces candidates.
On an ICE restart, discard the old prediction batch rather than emitting an
unscoped end marker into the new generation. The real gathering owner supplies
completion, following [Trickle ICE generation rules](https://www.rfc-editor.org/rfc/rfc8838.html#section-13).
An earlier remote description is not readiness for a new generation's candidates.
Native event delivery can precede its offer/answer response; the existing
negotiation queue retains those candidates until the matching answer is applied.

### Native Shared-Socket Preflight

Native requests one dual-stack wildcard UDP socket through Go and Pion's existing
UDP mux. IPv4 remains usable on IPv4-only systems, and concrete IPv4 bindings
remain IPv4-only. Usable IPv6 interfaces can supply direct ICE candidates on the
same port; IPv4 discovery, prediction and gateway mapping retain their current
owners. IPv6 does not remove firewall restrictions or prove a reachable peer.

On 2026-09-05, the unmodified Pion srflx gatherer contacted three public STUN
destinations from three different temporary local ports, despite the media
engine's ordinary UDP mux. This invalidated the prior assumption that Native
STUN and media already shared one socket. Pion ICE's `UniversalUDPMux` was then
used as the media mux and direct STUN observation owner. Its emitted srflx
candidate reported the exact Engine listener as its related port.

The same build carried a public-link session to an independent Linux Pion
Viewer: 35 H.264 RTP packets arrived over a selected direct host-to-srflx pair,
while the Quick Tunnel carried signaling only. The active TUN network yielded
one distinct mapped endpoint across the public survey, so no port sequence or
prediction was claimed. The result proves shared-socket discovery and transport,
not public-survey availability or a predicted-path success rate.

Native Site and public-link shares also request one PCP, UPnP, or NAT-PMP
mapping for that same socket. The returned port is advertised as a
lower-priority candidate using a public address already observed by ordinary
STUN. This is additive and bounded; a VPN, double NAT, or absent mapping service
can make it unusable without delaying or replacing ordinary ICE.
Gateway preparation runs alongside ordinary gathering. Each survey destination
resolves and sends Binding independently within one shared deadline; an unhealthy
DNS target cannot withhold a healthy target's result. End-of-candidates follows
both the ordinary gatherer and the bounded supplemental work, and retirement
discards that gathering generation's late output.
A local UDP-forwarding gate then withheld every ordinary Host candidate and
connected Pion ICE/DTLS in 1.26 seconds through the advertised `mp1` endpoint.
That proves the same-socket ICE mechanism, not rescue through a physical NAT.

### Gateway And Survey Limits

The root module uses [scoped local repairs](../../internal/thirdparty/README.md)
for `go-nat` and its NAT-PMP client. The unmodified upstream revisions discard
gateway-assigned ports, send no deletion and ignore context cancellation.
The repaired adapter retains `MappedExternalPort` on creation and renewal,
sends lifetime-zero deletion under [RFC 6886](https://www.rfc-editor.org/rfc/rfc6886.html#section-3.4),
and propagates discovery, mapping and deletion cancellation to socket I/O.
Packet-level loopback regressions cover reassignment, renewal, deletion,
cancellation and the existing PCPv6 combination. They do not establish physical
router coverage or a higher field connection-success rate.

Piik still bounds a mapping caller's wait to three seconds. PCPv6 rollback can
finish after that wait, so cleanup must wait for the in-flight gateway call
before accessing its bookkeeping. Failed attempts are not relaunched by later
edges. Close attempts deletion even after a failed request, because losing a
reply does not prove the router rejected the mapping. Cleanup is best effort:
an unreachable gateway or unsettled rollback can leave a lease to expire.
Caller cancellation and router lease expiry remain distinct lifecycle boundaries.
The gateway selector and its NAT-PMP/PCPv6 combination retain one mapping owner;
ordinary ICE candidates remain independent.

Binding all three STUN listeners proves local startup, not public reachability.
A local self-probe also cannot prove traversal through an operator's firewall.
Missing prediction may reflect unreachable survey destinations or insufficient
distinct mappings. Library packet logs remain disabled because they expose
remote addresses; future health summaries must retain that privacy boundary.
Candidate provenance, selected paths and connection outcomes already have Debug
owners. Count emitted candidates separately from successful connections; zero
predicted selections alone does not establish a broken predictor or a success
rate. Further observation work belongs to [TODO](../todo.md).

### Independent Observation And Attribution Preflight

On 2026-09-01, Chrome 151 on the flagship Windows network gathered one `srflx`
candidate independently from the self-hosted endpoint, Xiaomi, Bilibili, and
Cloudflare within a five-second bound. `stun.qq.com:3478` produced none in the
same ordered run. Candidate events and local candidate stats preserved the exact
STUN `url`, but the destinations supplied no selected-path benefit. They remain
research evidence only; the product has no independent or third-party STUN
configuration.

A second real-Chrome loopback rewrote only one remote candidate foundation to
`sp1`, established the data channel, and read `sp1` from the selected remote
candidate stats. The product can therefore report `predicted | ordinary |
unknown` selection without retaining or uploading addresses, ports, foundations,
or STUN URLs. Field acceptance still requires target-network outcomes; this
preflight proves the attribution mechanism, not prediction prevalence.

The first flagship field runs emitted six predicted candidates in one 8545
generation and selected none. Later 8545 and 5643 generations did not form the
required arithmetic survey shape, so no prediction was emitted. This is
negative prevalence evidence, not a regression: ordinary ICE and SFU fallback
remained independent. The flagship deployment enables the bounded capability
to continue attributable field observation without claiming a demonstrated
reachability gain.

Background P2P acquisition behind SFU uses the same bounded opportunity budget
as foreground acquisition under [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md).
Fresh connection attempts do not guarantee a new socket, mapping or predictable
port sequence; field measurements must attribute the selected path to its actual
connection generation.

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

Port prediction remains additive rather than an assumed path. The controlled
namespace matrix supports the bounded mechanism, but field prevalence,
direction, and resource impact are not established. Configuration therefore
stays off by default even though the flagship deployment explicitly enables its
field rollout.

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
- [Pion Universal UDP mux](https://github.com/pion/ice/blob/main/udp_mux_universal.go)
- [Pion dual-stack candidate enumeration](https://github.com/pion/ice/blob/v4.4.0/udp_mux.go)
- [Go wildcard socket family selection](https://go.dev/src/net/ipsock_posix.go)
- [WebRTC selected candidate stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatestats-foundation)
- [Pinned go-nat NAT-PMP adapter](https://github.com/netbirdio/go-nat/blob/6b2c8c5c74e8331ed41811cfd2fdc4c3dd8c3ff0/natpmp.go)
- [NAT-PMP client timeout and mapping calls](https://github.com/jackpal/go-nat-pmp/blob/v1.0.2/natpmp.go)
