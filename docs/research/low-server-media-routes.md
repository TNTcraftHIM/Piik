# Low-Server-Cost Media Routes

- Research date: 2026-08-19
- Scope: one broadcaster, at most eight trusted viewers, low latency, and host
  media fanout at most two
- Status: route screening for ADR-0004/ADR-0005; automatic failure-only hybrid
  routing has a Draft implementation, while dual-TURN optimization and every
  non-browser data-plane candidate remain separate, unimplemented experiments

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
   automatically only after deterministic peer recovery is exhausted. The SFU
   is a virtual parent for only one or two necessary roots; those roots continue
   bounded peer descendants. A necessary viewer may be a zero-descendant root
   under that same total only when no reliable relay root exists. Server
   capacity transfers fanout bandwidth to its operator; it does not disappear.

Any browser-spike failure other than isolated relay re-encoding closes that
browser-relay route. It does not cancel the separate native sender plan. Closed
PR #12's explicit whole-room SFU mode is superseded. ADR-0005 and merged PR #17
own the default-off automatic cross-mode controller. Its code is deployed but
inactive because production has no peer-assist flag or LiveKit tuple. Corrected
localhost Chrome/LiveKit functional recovery passed, while public
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
viewer count, `R` the one or two seed/root viewers, and `B_edge` a descendant
edge's actual bitrate.
Useful last-hop delivery is approximately `N*B`. Ignoring protocol overhead:

`host last-hop copies + peer last-hop copies + server last-hop copies = N * B`

| Full-stream shape | Host upload | Viewer-relay upload | Central media traffic |
| --- | ---: | ---: | ---: |
| Peer roots, direct edges | `R*B` | `(N-R)*B` | none |
| Peer roots, all `R` seed edges through TURN | `R*B` | `(N-R)*B` | TURN ingress `R*B` + egress `R*B` |
| SFU virtual parent to the same roots | `B_pub` | `(N-R)*B` | SFU ingress `B_pub` + egress `sum(B_i)` |
| Same-representation full-room SFU | `B` | `0` | SFU ingress `B` + egress `N*B` |

The table's `R*B` and `(N-R)*B` rows are equal-representation screening cases.
With mixed root representations, peer host/seed-TURN traffic is `sum(B_i)` and
descendant upload is `sum(B_edge)`. SFU host upload and ingress are `B_pub`, the
sum of all actively published representations; if simulcast `HIGH` and `LOW`
both remain active, that may be `B_HIGH+B_LOW`, not one root bitrate. The
SFU-root row, not full-room SFU, is the retained fallback shape. For equal
representations, `B_pub = B` and `sum(B_i) = R*B`. Publisher-to-SFU and every
SFU-to-root subscriber transport are independent ICE connections and may
select deployment-supported ICE/UDP, ICE/TCP, or TURN/TLS; peer descendants
may also select TURN. If the publisher leg uses TURN, retain host upload
`B_pub`, TURN ingress `B_pub`, TURN egress `B_pub`, and SFU ingress `B_pub` as
distinct interface/service traffic. A relayed root leg likewise adds TURN
ingress and egress `B_i`; a relayed descendant edge adds both directions for
that edge's actual bitrate. They are one logical useful payload copy but real
physical hops, so NIC, service, and billing counters must never be folded.

RTP/RTCP/SRTP, DTLS, ICE/TURN and IP headers, retransmission, FEC, and redundant
paths only add traffic. W3C candidate-pair byte counters exclude some transport
overhead, and a provider may bill ingress and egress differently, so formulas
screen candidates but never replace host NIC, TURN/SFU, and billing counters
from the same run. Encoding once can reduce compute and memory bandwidth, but
it cannot remove the network copy delivered to each viewer.

## Transport And Topology Layers

TURN is a per-edge ICE transport. Each host-root or peer-peer P2P edge and each
SFU publisher/subscriber connection can independently select direct or relay
candidates without changing the rest of the room. An SFU is a topology node.
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
Use opaque generations only. This is a shadow diagnostic manifest, not a
backend telemetry schema or controller input.

## Dual-TURN Shadow Candidate

Use four explicit network scenarios; no threshold or optimizer is selected:

1. **Direct/direct roots:** retain peer distribution.
2. **Direct/TURN roots:** retain the mixed peer distribution; one relayed edge
   does not justify an SFU.
3. **TURN/TURN roots:** after both host seed edges remain selected relay pairs
   across a future reviewed stability window, emit only a shadow candidate.
   The active route does not move under ADR-0005. A necessary useful-payload
   condition for any host-upload claim is measured `B_pub < sum(B_i)`; real
   hop counters must still prove the total benefit.
4. **No reliable relay root:** after deterministic recovery is exhausted, use
   the existing failure-only SFU route; necessary viewers may consume the same
   one-or-two root slots with zero descendants, never a second fanout budget.

The evidence sequence is deliberately narrow:

1. Use local `webrtc-internals` as manual ground truth for selected pairs and
   redact SDP, addresses, candidates, and identifiers before retention.
2. Enable privacy-safe diagnostics for one exact `PEER_ASSISTED_ROOM_IDS` room
   in shadow mode. It records a candidate but changes no media or protocol.
3. Run matched, non-simultaneous exact-room A/B sessions for two TURN roots and
   one SFU publisher feeding the same one or two roots. This avoids exceeding
   the live host-edge budget merely to benchmark both routes concurrently.
4. Compare real host upload, TURN/SFU ingress and egress, selected protocols,
   RTT/loss/bitrate, first picture, steady latency, recovery, host/root load,
   and the actual E2EE/operator boundary. The host-to-SFU publisher is an
   independent ICE connection that may use ICE/UDP, ICE/TCP, or deployed
   TURN/TLS. Retain every transport and service hop separately, including TURN
   on publisher, subscriber-root, or peer-descendant edges; distinguish only
   physical traffic totals from logical useful-payload copies. Thresholds
   remain unknown.
5. Only a measured win plus an amended ADR-0005 may authorize an automatic
   exact-room canary; broad rollout remains default-off.

Ordinary SFU transport encryption lets the SFU operator access media. LiveKit
offers application E2EE for media/data, but signaling and APIs remain visible
and Screener does not yet implement key distribution. Compare the configured
boundary instead of treating E2EE as a checkbox. This candidate adds no route
score, controller trigger, wire field, backend telemetry system, or code.

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
| SFU virtual parent | SFU emits only one or two root copies; roots keep peer descendants | Service pays measured root egress; host sends one publication | Default retained SFU shape; automatic only after peer failure under ADR-0005 |
| Zero-descendant SFU roots | SFU emits necessary viewer copies | Same root budget; service egress is at most `sum(B_i)` | Last resort only when no reliable relay root exists |
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
- [LiveKit](https://github.com/livekit/livekit) - Apache-2.0; the optional SFU
  reference, with no code copied into this research change.
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
  and [end-to-end encryption](https://docs.livekit.io/transport/encryption/) -
  official behavior and operator-boundary references.
- [LiveKit client 2.22.0 `Room.prepareConnection`](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/Room.ts)
  and [official usage](https://github.com/livekit/client-sdk-js#usage) -
  Apache-2.0; API behavior was inspected, with no source copied.

No GPL/AGPL code was copied. Published papers and specifications support design
analysis only; their presence here is not an implementation license.
