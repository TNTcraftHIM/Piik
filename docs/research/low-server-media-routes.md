# Low-Server-Cost Media Routes

- Research date: 2026-08-19
- Scope: one broadcaster, at most eight trusted viewers, low latency, and host
  media fanout at most two
- Status: ADR-0005 accepts STUN-only direct/peer UDP, bounded SFU/UDP roots,
  then optional authenticated TURN/UDP for one controller-selected exceptional
  edge. Production enables the controller for all rooms and has a configured
  selected-edge TURN tuple; ordinary peer connections remain STUN-only, while
  real SFU/TURN media behavior remains unverified.

## Current Route Ladder

The smallest current plan is:

1. Use direct host P2P for one or two viewers.
2. For later viewers, use the fixed two-chain browser relay in ADR-0004. It is
   controlled by `PEER_ASSISTED_MEDIA`, is limited to at most
   eight viewers, and decodes and re-encodes at every relay.
3. Plan a separate native shared-encode sender regardless of the browser relay
   result. It reduces duplicate host encoding while retaining at most two
   standard WebRTC edges, so it does not remove their upload cost. The bounded
   risk spike is specified in
   [Native Shared-Encode Sender](./native-shared-encode-sender.md).
4. Only if browser relay re-encoding is the isolated failure should another
   experiment add opt-in native volunteer encoded-RTP relays.
5. Keep a user-operated mini-SFU and a centrally operated single-node SFU as
   optional capacity. The ADR-0005 controller uses that capacity
   automatically only after deterministic peer recovery is exhausted. The SFU
   is a virtual parent for only one or two necessary roots; those roots continue
   bounded peer descendants. A necessary viewer may be a zero-descendant root
   under that same total only when no reliable relay root exists. Server
   capacity transfers fanout bandwidth to its operator; it does not disappear.

Any browser-spike failure other than isolated relay re-encoding closes that
browser-relay route. It does not cancel the separate native sender plan. Closed
PR #12's explicit whole-room SFU mode is superseded. ADR-0005 and merged PR #17
own the automatic cross-mode controller. Production first enabled it only for
room `1` and later removed that rollout boundary. Participant entry was
observed, but retained media was not. Corrected localhost Chrome/LiveKit functional recovery passed, while public
transport, quality, load, and browser validation remain open.

## Token-Free SFU Standby Prewarm

The pinned Apache-2.0 `livekit-client` 2.22.0 source documents and implements
`Room.prepareConnection(url)` as DNS/TLS preparation. For a self-hosted URL and
no token, it converts `ws(s)` to `http(s)`, sends one `HEAD`, and catches errors.
It does not call `connect`; therefore it does not join a room, acquire a
participant identity, publish, subscribe, or create a media edge. A token is
only relevant to LiveKit Cloud region selection, which this self-hosted spike
does not use.

The smallest integration is to advertise the non-secret LiveKit origin only in
the authoritative peer-assisted authentication snapshot when the complete
fallback tuple exists. Each client dynamically imports the already-pinned SDK
once and attempts the URL once. Newer authentication invalidates a stale task
before the import completes; a failed HEAD is silent and is not retried. No JWT
is issued until the existing route controller actually selects SFU fallback.
With no fallback configuration, the field, import, HEAD, and behavior are all
absent.

A bounded Chrome 151/LiveKit 1.13.5 localhost/headless/video-only same-leaf A/B
reduced failure report to SFU active from 1.481 seconds to 200 ms and to a
rendered frame from 2.257 seconds to 319.7 ms. It retained the fixed direct ->
peer -> SFU order, two allowlisted roots, and host media-edge peak two. The
standby had already downloaded/parsed the SDK and made its token-free network
prewarm, without a participant or media edge, so the A/B does not isolate those
effects. Its roughly 86% result must not be extrapolated to a public network;
internet DNS/TLS reuse, RTT/loss, audio, transport fallback, and browser variance
still require measurement.

## Traffic Conservation And The Impossible Triangle

This is an engineering accounting identity, not a named theorem. Let `B` be
the measured useful media bitrate for one same-representation branch, `B_pub`
the actual SFU publication bitrate, `B_i` root `i`'s selected bitrate, `N` the
viewer count, `R` the one or two normal roots, `D` their peer descendants, `E`
the separately admitted exceptional server-fed viewers, `B_exc,j` exception
`j`'s selected bitrate, and `B_edge` a descendant edge's actual bitrate. Thus
`N = R + D + E`. For the equal-representation normal-root baseline `E=0`,
useful last-hop delivery is approximately `N*B`. Ignoring protocol overhead:

`host last-hop copies + peer last-hop copies + server last-hop copies = N * B`

| Full-stream shape | Host upload | Viewer-relay upload | Central media traffic |
| --- | ---: | ---: | ---: |
| Peer roots, direct edges | `R*B` | `D*B` | none |
| Peer roots, all `R` seed edges through TURN | `R*B` | `D*B` | TURN ingress `R*B` + egress `R*B` |
| SFU virtual parent to the same roots | `B_pub` | `D*B` | SFU ingress `B_pub` + egress `sum(B_i)` |
| Same-representation full-room SFU | `B` | `0` | SFU ingress `B` + egress `N*B` |

The table's `R*B` and `D*B` rows are equal-representation screening cases with
`E=0`.
With mixed root representations, direct peer-root traffic is `sum(B_i)` and
descendant upload is `sum(B_edge)`. SFU host upload and ingress are `B_pub`, the
sum of all actively published representations; if simulcast `HIGH` and `LOW`
both remain active, that may be `B_HIGH+B_LOW`, not one root bitrate. The
SFU-root row, not full-room SFU, is the retained fallback shape. For equal
representations, `B_pub = B` and `sum(B_i) = R*B`. Publisher-to-SFU and every
SFU-to-root subscriber transport are independent ICE connections and may use a
separately deployed LiveKit transport. Ordinary descendants are STUN-only; only
one controller-selected exceptional edge may later use independent coturn. If a
publisher leg separately uses LiveKit TURN, retain host upload
`B_pub`, TURN ingress `B_pub`, TURN egress `B_pub`, and SFU ingress `B_pub` as
distinct interface/service traffic. A relayed root leg likewise adds TURN
ingress and egress `B_i`; a selected-edge relay adds both directions for that
edge's actual bitrate. They are one logical useful payload copy but real
physical hops, so NIC, service, and billing counters must never be folded.

If `E>0`, SFU root/exception egress is
`sum(B_i) + sum(B_exc,j)` and central SFU traffic is
`B_pub + sum(B_i) + sum(B_exc,j)`. Peer descendant upload remains
`sum(B_edge)`. Any separately TURN-relayed LiveKit root/exception leg or
controller-selected peer edge adds TURN ingress and egress equal to that leg's
measured bitrate. The separately capped
exceptions are therefore never hidden inside the normal `R<=2` root budget or
the equal-representation formulas.

RTP/RTCP/SRTP, DTLS, ICE/TURN and IP headers, retransmission, FEC, and redundant
paths only add traffic. W3C candidate-pair byte counters exclude some transport
overhead, and a provider may bill ingress and egress differently, so formulas
screen candidates but never replace host NIC, TURN/SFU, and billing counters
from the same run. Encoding once can reduce compute and memory bandwidth, but
it cannot remove the network copy delivered to each viewer.

## Transport And Topology Layers

TURN is a per-edge ICE transport, but ordinary host-root and peer-peer PCs gather
only STUN candidates. The controller may authorize one failed edge to rebuild
relay-only after SFU/UDP; LiveKit participant transport remains separate. An SFU is a topology node.
Screener uses it as a virtual
parent for one or two roots, not as an automatic all-viewer fanout service.
After media reaches a root, the deterministic sticky subtree, host/root fanout
at most two, browser fanout one, maximum depth, and bounded failure radius still
apply. Only the absence of any reliable relay root permits a necessary viewer
to consume one of the same one or two root slots with zero descendants.

This distinction follows TURN's allocation/relay role in RFC 8656 and the media
topology boundary in RFC 7667. A relay candidate proves transport for one edge;
it is not evidence that an SFU topology would be cheaper or faster.

## Privacy-Safe ICE Evidence Candidate

Start with locally retained, redacted `webrtc-internals` as manual ground truth.
Only then may one exact allowlisted room record, without changing its route:

- selected local/remote candidate type and protocol plus local
  `relayProtocol`;
- `iceGatheringState`, `iceConnectionState`, and `connectionState` transitions
  with monotonic event-derived establishment duration;
- `selectedCandidatePairChanges` when implemented, reported only as a delta
  from the current opaque connection/ICE-restart generation baseline;
- RTT, loss, and actual/available bitrate for the selected RTP-bound path; and
- `icecandidateerror.errorCode` bucketed as
  `3xx|4xx|5xx|6xx|701|other`.

Never retain raw `errorText`, address, port, URL, candidate strings, SDP, or
device/network identifiers. Stats members may be absent, and the pair-change
counter is transport-lifetime state, so events and generation baselines prevent
old connection or ICE-restart history from being attributed to a new route.
Use opaque generations only. This is a bounded diagnostic manifest, not a
backend telemetry schema or controller input.

## SFU/UDP And Selected-Edge TURN

Every ordinary bounded peer `RTCPeerConnection` uses STUN-only ICE. Failure
follows one restart, one same-parent rebuild, one alternate peer, and one or two
SFU/UDP roots whose bounded descendants remain distributed. Only an edge that
also cannot use SFU/UDP may receive one controller-selected authenticated
TURN/UDP rebuild before bounded failure. Endpoint and central egress caps remain
unchanged.

STUN/ICE discovers and checks paths. RFC 8656 TURN allocates a relayed address
and continuously carries media when selected; it is not a handshake helper or
topology. Ordinary PCs do not gather relay candidates, so healthy paths consume
no idle allocation. Exact-room, complete-tuple, current-generation and one-use
controller gates prevent participant-wide or process-wide rollout.

Coturn validates a REST bearer's HMAC and expiry, not the originating room,
peer edge, revision, parent, or connection generation. Application issuance and
both endpoint rebuilds therefore must revalidate the controller's current edge
identity and consume the attempt on success, failure, expiry, or generation
change. This is application selected-edge enforcement plus TTL, fanout, and
quota containment, not coturn-side cryptographic edge binding. The failed
built-in alternative and retained standards evidence are in
[Built-In Peer ICE TURN Candidate](./built-in-peer-ice-turn.md).

Pinned LiveKit 1.13.5 can advertise authenticated TURN to LiveKit participants,
but that separate ICE domain covers publisher/subscriber connections to the
SFU, not ordinary peer PCs. Selected-edge coturn uses independent configuration
and credentials. LiveKit TURN cannot rescue an unavailable SFU; the application
controller selects whether independent coturn may rebuild one failed peer edge.

Ordinary peer ICE remains STUN-only. The participant-wide TURN
config, capability and refresh wire are removed; any stale `PEER_ICE_TURN_*`
key, including an empty value, fails startup. Selected-edge TURN is deployed as
a configured, controller-issued exceptional transport; its real media path is
not yet canary-proven. Every ordinary Web peer and Native-shaped client remains
STUN-only. The tracked coturn example is UDP
`stun-only`; the LiveKit example exposes only ICE/UDP mux 7882, explicitly sets
`tcp_port: 0` and `allow_tcp_fallback: false`, supplies the self-hosted STUN
endpoint, and configures no external or embedded TURN. Candidate validation and rollback use isolated
instances rather than a process-wide old-release compatibility branch. HTTPS/WSS remains TLS/TCP.
Coturn 4.17.2 documents `stun-only` as ignoring TURN requests and provides
`no-tcp` and `no-tls`; it marks `no-dtls` deprecated, so the tracked temporary
template does not use that switch. The shared production host instead retains its old
authenticated-relay daemon and TCP/UDP 3478 plus UDP 49152-49251 rules. The
application advertises no TURN credential, and the post-canary audit found zero
allocations. This baseline is neither the accepted selected-edge rollout nor
proof that relay media works.

No public port is selected by this decision. LiveKit documents ICE/UDP mux as
optional and its pinned sample recommends a multi-port UDP mux range at least
as wide as the CPU count for performance. Embedded TURN/UDP defaults to 3478
and recommends 443 only when it does not conflict with HTTP/3/QUIC; TURN/TLS
has different certificate and 443 constraints. The current nginx template has
no HTTP/3 listener, but that fact alone does not prove one UDP port or UDP 443
is the best production layout.

For one equal representation of measured bitrate `B` and `R` roots:

- `R` TURN seed edges: host upload `R*B`, server ingress `R*B`, server egress
  `R*B`, total central traffic `2R*B`;
- one SFU publisher to `R` roots: host upload `B`, server ingress `B`, server
  egress `R*B`, total central traffic `(R+1)*B`.

At `R=1` useful-payload traffic is equal, so the identity alone gives neither
route a preference; CPU and allocation cost require the same-host benchmark.
At `R=2`, the equal-representation SFU case halves host upload and
central ingress and reduces total central traffic from `4B` to `3B`, with the
same `2B` egress. Mixed representations replace `B` with measured `B_pub` and
`sum(B_i)`; a HIGH+LOW publication may erase that advantage. Public LiveKit
benchmarks and the Jitsi profiling breakdown establish capacity and component
categories only. Different machines and implementations cannot support a
universal coturn/SFU CPU ratio or a claimed fixed percentage saving.

One bounded exact-room gate owns rollout evidence:

1. On the same host and NIC, compare coturn UDP and LiveKit SFU UDP at measured
   8 and 12 Mbps with one and two roots. Record CPU seconds/GiB, RX/TX bytes,
   packets/s, RSS, host upload, p95/p99 forwarding latency, loss/recovery, and
   final decoded quality.
2. Cover representative consumer networks with STUN-only direct/peer first,
   then SFU/UDP. Only after both gates pass, force one controller-selected edge
   through TURN. All ordinary peer connections must remain STUN-only.
3. Measure allocation count/relay ports/RSS/CPU/latency for one and two selected
   attempts, plus relay RX/TX/loss/latency. There is no participant-count idle
   allocation target because ordinary peer PCs do not receive TURN candidates.
   Block all UDP and show a bounded explicit failure; TURN/UDP is not media TCP.
4. Exercise root departure, reconnect, SFU unavailable, and rollback. Endpoint
   downstream edges stay at most two, normal SFU roots at most two, separately
   capped exceptional server edges stay bounded, and unaffected peer subtrees
   do not migrate.
5. Correlate only selected candidate type/protocol/relayProtocol and opaque
   generations; never upload raw SDP, candidate/address/IP, credentials, or
   device identifiers.

Selected-edge TURN retains endpoint-to-endpoint DTLS-SRTP. Ordinary SFU transport
terminates DTLS-SRTP on both sides, so its operator can access media unless
Screener later implements application E2EE and key distribution. That accepted
tradeoff remains visible in deployment and UI claims.

A peer root simultaneously re-publishing its received stream to the SFU and
serving peer children is only a later bounded experiment. The current browser
relay would decode and re-encode, and publication ownership adds another
failure domain. Do not add it to the controller until measurements prove a
specific consumer. No global score, continuous optimizer, geography, IP, UA,
or self-reported capability chooses these routes.

On today's unicast Internet, a design cannot maximize all three of these for
more than one viewer:

1. near-zero central-server media egress;
2. near-zero host and viewer upload, compute, and installation burden; and
3. ultra-low-latency, robust recovery across churn, NAT, and restrictive networks.

If the server does not emit the copies, endpoints must. If endpoints do not,
the server must. Redundancy can improve recovery but costs traffic and
coordination; removing redundancy leaves a recovery interval after a relay is
lost.

## Route Screening

| Route | Where copies are emitted | Endpoint cost | Current disposition |
| --- | --- | --- | --- |
| Direct host P2P | Host emits one copy per viewer | Host upload and sender pipelines grow with viewers | Keep for one or two viewers |
| Fixed two-chain browser relay | Host emits at most two copies; each relay emits at most one | Ordinary browser, but every relay decodes and re-encodes and adds a hop | Current default-off, maximum-eight-viewer spike |
| Native shared-encode host | Host targets one encode for at most two standard WebRTC edges | libwebrtc public-API proxy risk spike, with Pion as fallback | Planned separate sender phase; still pays per-edge upload |
| Native volunteer encoded-RTP relay | Each volunteer forwards one encoded copy | Native install, RTP/RTCP forwarding, packaging, and opt-in relay policy | Conditional experiment only if relay re-encoding is the sole browser-spike failure |
| SFU virtual parent | SFU normally emits one or two root copies; roots keep peer descendants | Service pays measured root egress; host sends one publication | Accepted primary central fallback after direct/peer UDP; current code is failure-only |
| Exceptional server-fed viewers | SFU/TURN emits necessary copies that no healthy root can distribute | Additional capped central egress | Explicit compatibility exception only; never unbounded whole-room fanout |
| SVC plus multiple trees | Peers emit striped layer copies across several trees | Layer scheduling, reassembly, redundancy, and more churn state | Separate conditional spike; target endpoint upload near `B` |
| Network coding | Peers or servers emit coded blocks | Generations, buffering, decoding, integrity, and a custom media plane | Trace/FEC spike only; optimize loss recovery, not clean bandwidth |
| MoQ | Publishers and MoQ relays emit object copies | New transport, packaging, player, relay, and auth stack | Optional central-fallback benchmark; still pays server egress |
| Peer-assisted CDN | Peers cache or upload segments/objects | Discovery, locality, scheduling, incentives, abuse, and privacy systems | Reject for this trusted group |
| IP multicast | Multicast routers replicate packets | Requires multicast-enabled hosts and routed networks unavailable to ordinary Internet browsers | Reject outside managed networks |

## Planned Native Sender And Conditional Encoded-RTP Relay

Pion exposes the necessary native building blocks: `TrackRemote.ReadRTP()` reads
encoded RTP, `TrackLocalStaticRTP.WriteRTP()` writes pre-packetized RTP into
standard downstream WebRTC connections, and `RTPSender.ReadRTCP()` exposes
receiver feedback. A native volunteer could therefore terminate an upstream
WebRTC connection and forward encoded RTP to one downstream connection without
decoding or re-encoding. The downstream leaf can remain a normal browser.

This is feasibility evidence, not a ready relay. A real implementation still
has to prove codec/profile agreement, SSRC and sequence/timestamp handling,
RTCP feedback translation, NACK/RTX behavior, congestion control, keyframe
requests, generation changes, security, packaging, and voluntary use. The host
also needs a separate native shared encoder so its two WebRTC packetizers consume
one encoded result. Pion's broadcast example demonstrates server-side RTP
fanout, but it does not supply this end-user topology or product behavior.

Draft PR [#16](https://github.com/TNTcraftHIM/Screener/pull/16) has now passed
the narrower transport oracle: one Pion v4.2.18
`TrackLocalStaticRTP.WriteRTP` call fans a pre-packetized semantic payload to
two independent PeerConnections with binding-specific SSRCs. Because that
oracle contains no encoder, browsers, RTCP arbitration, or bandwidth-control
loop, it proves neither one physical encode nor a usable native relay. Its next
gate is browser-to-native-to-two-browser interoperability with bounded
RTCP/PLI, congestion, queues, throughput, and latency.

The native shared-encode sender is a planned independent phase. Native volunteer
relays remain conditional on measurements isolating relay re-encoding as the
sole browser-spike failure. They must not rescue failures in deterministic
assignment, host fanout, relay loss recovery, ICE/TURN connectivity, mobile
leaves, or end-to-end latency.

## Outside The Current Browser-Track Spike

- **SVC and multiple trees:** WebRTC SVC controls layered encoding; it does not
  distribute replicas. SplitStream shows how striping across multiple trees can
  spread peer load. A separate encoded-object/native spike now owns its tree
  maintenance, reassembly, scheduling, and redundancy gates; none belongs in
  the fixed full-stream two-chain experiment.
- **Network coding:** published work improves block distribution in large
  overlays. A trace-first FEC experiment must prove lower freeze/repair delay
  within strict byte and buffering budgets before any media integration.
- **MoQ:** Media over QUIC provides promising relay-oriented publish/subscribe,
  priorities, and partial reliability, but MOQT remains an active Internet-Draft.
  Benchmark it only as a central fallback because a browser cannot act as an
  inbound WebTransport peer and the relay still pays fanout egress.
- **Peer-assisted CDN:** PCDN research addresses large file or segmented VoD
  distribution and ISP/provider cost. Its discovery, caching, locality,
  scheduling, incentives, and abuse controls are disproportionate for at most
  eight trusted viewers and do not guarantee sub-second live latency.
- **IP multicast:** Internet Group Management and Source-Specific Multicast
  require participating hosts and multicast routers. ICE establishes unicast
  candidate-pair transports; normal browser WebRTC across NAT and mobile networks
  exposes no Internet multicast delivery path.

The measurable gates and exact staged experiments are in
[Advanced Peer Distribution](./advanced-peer-distribution.md).

## Sources And License Boundary

Primary sources checked on 2026-08-19:

- [Pion WebRTC](https://github.com/pion/webrtc) - MIT; no code copied.
- [Pion WebRTC v4 API](https://pkg.go.dev/github.com/pion/webrtc/v4) - API
  evidence for RTP and RTCP access.
- [Pion broadcast example](https://github.com/pion/webrtc/tree/main/examples/broadcast)
  and [examples index](https://github.com/pion/webrtc/blob/main/examples/README.md)
  - MIT; reference behavior only.
- [RTP Topologies, RFC 7667](https://www.rfc-editor.org/rfc/rfc7667.html) and
  [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html) - IETF standards
  under IETF Trust terms.
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html) - the relay is
  transport for client/peer traffic, not a room distribution topology.
- [coturn 4.17.2 release](https://github.com/coturn/coturn/releases/tag/4.17.2)
  and [pinned turnserver documentation](https://github.com/coturn/coturn/blob/4.17.2/README.turnserver)
  - `stun-only` and UDP-only listener configuration; BSD-3-Clause, no code copied.
- [WebRTC transports, RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html) -
  browser transport capability requirements do not require an application to
  advertise every supported fallback on every connection.
- [WebRTC](https://www.w3.org/TR/webrtc/),
  [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/),
  [WebRTC Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/#stream-processing),
  and [WebRTC SVC](https://www.w3.org/TR/webrtc-svc/) - W3C specifications; SVC
  is an encoding control, not a distribution topology.
- [MoQ Transport](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/),
  [MoQ Streaming Format](https://datatracker.ietf.org/doc/draft-ietf-moq-msf/),
  and the [MoQ working group](https://datatracker.ietf.org/wg/moq/) - active IETF
  work, not final RFCs.
- [moq-dev/moq](https://github.com/moq-dev/moq) - core crates are dual
  MIT/Apache-2.0; its separately distributed `cpp/obs` plugin is
  GPL-2.0-or-later. No code was copied.
- [SplitStream, SOSP 2003](https://www.microsoft.com/en-us/research/publication/splitstream-high-bandwidth-multicast-in-a-cooperative-environment/)
  - published research, no implementation license granted here.
- [Network Coding for Large Scale Content Distribution, INFOCOM 2005](https://www.microsoft.com/en-us/research/publication/network-coding-for-large-scale-content-distribution/)
  - published research, no implementation license granted here.
- [Should Internet Service Providers Fear Peer-Assisted Content Distribution?](https://www.usenix.org/conference/imc-05/should-internet-service-providers-fear-peer-assisted-content-distribution)
  - published research, no implementation license granted here.
- [IP multicast, RFC 1112](https://www.rfc-editor.org/rfc/rfc1112.html) and
  [Source-Specific Multicast, RFC 4607](https://www.rfc-editor.org/rfc/rfc4607.html)
  - IETF standards under IETF Trust terms.
- [LiveKit](https://github.com/livekit/livekit) - Apache-2.0; the SFU
  reference, with no code copied into this research change.
- [LiveKit 1.13.5 configuration sample](https://github.com/livekit/livekit/blob/v1.13.5/config-sample.yaml),
  [pinned configuration source](https://github.com/livekit/livekit/blob/v1.13.5/pkg/config/config.go),
  [ports/firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/),
  [deployment/embedded TURN](https://docs.livekit.io/transport/self-hosting/deployment/),
  and [benchmark guidance](https://docs.livekit.io/transport/self-hosting/benchmark/)
  - transport, port, authentication, and capacity boundaries; no source copied.
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
  and [end-to-end encryption](https://docs.livekit.io/transport/encryption/) -
  official behavior and operator-boundary references.
- [LiveKit client 2.22.0 `Room.prepareConnection`](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/Room.ts)
  and [official usage](https://github.com/livekit/client-sdk-js#usage) -
  Apache-2.0; API behavior was inspected, with no source copied.
- [Grozev, *Towards a Scalable Video Conferencing System*](https://publication-theses.unistra.fr/public/theses_doctorat/2019/Grozev_Boris_2019_ED269.pdf)
  - one Jitsi profiling breakdown, not a coturn/LiveKit cross-system CPU ratio.

No GPL/AGPL code was copied. Published papers and specifications support design
analysis only; their presence here is not an implementation license.
