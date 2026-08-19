# Low-Server-Cost Media Routes

- Research date: 2026-08-19
- Scope: one broadcaster, at most eight trusted viewers, low latency, and host
  media fanout at most two
- Status: route screening for ADR-0004/ADR-0005; automatic hybrid routing has a
  Draft implementation, while every non-browser data-plane candidate remains a
  separate experiment

## Current Route Ladder

The smallest current plan is:

1. Use direct host P2P for one or two viewers.
2. For later viewers, test the fixed two-chain browser relay in ADR-0004. It is
   disabled by default with `PEER_ASSISTED_MEDIA=false`, is limited to at most
   eight viewers, and decodes and re-encodes at every relay.
3. Plan a separate native shared-encode sender regardless of the browser relay
   result. It reduces duplicate host encoding while retaining at most two
   standard WebRTC edges, so it does not remove their upload cost. The bounded
   risk spike is specified in
   [Native Shared-Encode Sender](./native-shared-encode-sender.md).
4. Only if browser relay re-encoding is the isolated failure should another
   experiment add opt-in native volunteer encoded-RTP relays.
5. Keep a user-operated mini-SFU and a centrally operated single-node SFU as
   optional capacity. The current ADR-0005 Draft controller uses that capacity
   automatically only after deterministic peer recovery is exhausted.
   They transfer fanout bandwidth to their operator; they do not make it
   disappear.

Any browser-spike failure other than isolated relay re-encoding closes that
browser-relay route. It does not cancel the separate native sender plan. Draft
SFU PR #12 remains unmerged and undeployed. ADR-0005 now owns a separate Draft
implementation of the automatic cross-mode controller; it is also undeployed
and has not passed real LiveKit/browser network validation.

## Traffic Conservation And The Impossible Triangle

This is an engineering accounting identity, not a named theorem. For `N`
viewers receiving bitrate `B`, useful last-hop delivery is approximately
`N * B`. Ignoring protocol overhead:

`host last-hop copies + peer last-hop copies + server last-hop copies = N * B`

TURN, RTP/QUIC headers, retransmission, FEC, and redundant paths only add traffic.
Encoding once can reduce compute and memory bandwidth, but it cannot remove the
network copy delivered to each viewer.

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
| User-operated mini-SFU | User's SFU emits viewer copies | Separate deployment and its egress bill; running it on the host does not reduce that host's uplink | Optional capacity; automatic final fallback when enabled |
| Central single-node SFU | Service SFU emits viewer copies | Lowest endpoint relay burden; service pays approximately `N * B` egress | Optional capacity; automatic final fallback when enabled; Draft PR #12 only |
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
- [WebRTC](https://www.w3.org/TR/webrtc/),
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
- [LiveKit](https://github.com/livekit/livekit) - Apache-2.0; the optional SFU
  reference, with no code copied into this research change.

No GPL/AGPL code was copied. Published papers and specifications support design
analysis only; their presence here is not an implementation license.
