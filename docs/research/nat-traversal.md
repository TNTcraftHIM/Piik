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

This preflight also leaves the proposed field mapper without an ordered port
delta. Candidate events expose response completion, while configured STUN order
does not specify the NAT allocation order. A Browser-only mapper may retain a
positive varies-by-destination observation and unordered port gaps, but cannot
label a signed `P + d` sequence without controlled external evidence. Trying
both signs consumes more checklist budget and still needs the same lab gate.

This preflight justified a controlled lab rather than product code. The lab was
subsequently executed as described below.

## Controlled Browser Lab

On 2026-09-01 a disposable Alpine VM ran two real Chromium 152 ICE agents in
separate Linux network namespaces. nftables provided four measured behaviors:
full-cone EIM, port-restricted EIM, sequential endpoint-dependent mapping, and
random endpoint-dependent mapping. Three STUN-only coturn listeners and the
HTTP signaling harness lived on an isolated documentation-address WAN. No
production listener, route, credential, user endpoint, or media path
participated.

Port-restricted filtering had to reject unopened remote UDP endpoints before
conntrack. A normal forward-chain drop was invalid: conntrack first created an
inbound tuple and could consume the port that EIM should preserve, manufacturing
a false endpoint-dependent mapping. The accepted lab records exact outbound
remote endpoints in a 30-second dynamic nftables set and drops other inbound UDP
at raw priority. This detail is part of the lab's validity, not a product design.

The 4 by 4 baseline ran each directed pair three times. Every pair involving
the full-cone side succeeded, port-restricted EIM to itself succeeded, and every
endpoint-dependent pair against port-restricted EIM or another endpoint-
dependent side failed. All 48 runs matched the RFC 4787 reachability model.
Sequential mappings exposed two adjacent srflx ports; random mappings exposed
large, unstable signed gaps.

Prediction calibration compared 1, 4, 16, 24, and 32 candidates:

- Sequential to port-restricted EIM improved from 0/3 at baseline to 14/15
  across the prediction sweep. A single correctly directed candidate was
  enough when no unrelated allocation intervened; larger idle-path windows
  showed no added benefit.
- Sequential to sequential remained 0/15 when normal candidates entered the
  checklist first. Adding the same predictions first while retaining every
  normal candidate produced 14/15. Candidate ordering, not window size, was the
  controlling variable.
- The one failure in each otherwise successful sweep coincided with Chromium
  delivering the two STUN responses in reverse completion order. The NAT still
  allocated upward, but an event-ordered signed delta reported `-1`. Candidate
  event order therefore cannot establish allocation direction.
- Random-to-restricted and sequential-to-random negative controls remained 0/6.
  Random mappings were never predicted. A known-reachable sequential-to-cone
  control remained 3/3 with the largest window.
- A 32-candidate window offered no observed gain and can create 105 pairs from
  three local candidates and 35 remote candidates, beyond the assumed 100-pair
  checklist budget. The data supports no large spray window.

An explicit jitter gate then inserted unrelated UDP mappings after both
Browsers completed gathering and before candidate release. For sequential to
port-restricted EIM, one intervening allocation required a two-candidate window,
four required five, and eight required nine. The immediately smaller window
failed in every boundary check; successful elapsed time grew from about 190 ms
to 430 ms and 630 ms. This establishes a mechanical `intervening allocations +
1` window for that pairing rather than a tunable quality threshold. By contrast,
sequential to sequential still failed with a 16-candidate prediction-first
window after only one intervening allocation on each side. Each new check moved
the actual source mapping and predicted destination together, preserving their
offset. A wider consecutive window is therefore not a general jitter solution
for two endpoint-dependent sides.

The same harness includes a local field-mapper prototype. It serially gathers
six fresh PeerConnections through two or three STUN destinations, keeps raw
endpoints only in Browser memory, and reports mapping-shape, delta-stability,
and direction enums. Across five controlled runs per profile, sequential was
5/5 `sequential-shape/stable/increasing`, random was 5/5
`unstable/unstable/unknown`, and both EIM variants remained `unknown` in 10/10
runs. Two-destination controls produced the same sequential/random distinction.

## Current Decision

Do not change the flagship STUN configuration in this phase. A second endpoint
does not itself traverse a hard NAT and does not justify a permanent external
metadata dependency. The self-hosted STUN endpoint remains the production
discovery service.

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
fact. They cannot safely remove a Peer candidate or save its five-second window.

Port prediction remains the only tested Browser experiment that added a direct
path beyond stock ICE, but the product gate is still closed. The controlled lab
proves a mechanism, not its field prevalence. Real-network measurement must show
that stable sequential EDM is common enough to matter, and a future design must
resolve allocation direction and candidate scheduling without removing normal
ICE candidates or turning a connection observation into participant state.
Until then no predicted candidate ships.

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
parsing would prove only candidate syntax; it would not prove that a predicted
mapping receives authenticated ICE checks. Port prediction and synthetic
candidate injection remain experiments until controlled Browser and target-
network measurements prove both benefit and bounded false rejection. They do
not enter the current protocol or controller.

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
- [nftables NAT and number-generator reference](https://netfilter.org/projects/nftables/manpage.html)
