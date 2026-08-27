# Advanced Peer Distribution

- Last reviewed: 2026-08-27
- Scope: advanced low-server distribution candidates for sub-second interactive media
- Status: research comparison and falsifiable gates, not an accepted product route

## Terms And Conservation

Let `B` be one complete stream bitrate, `N` the Viewer count, and `r` repair
overhead. Headers, audio and retransmission are additional. Every Viewer still
needs roughly `B` useful last-hop traffic, so a peer overlay redistributes about
`N*B`; it does not eliminate it.

- **Full-stream relay:** forwards a complete representation to each child.
- **Multiple trees:** split a representation into stripes carried by different
  interior-node-disjoint trees; every receiver reassembles the stripes.
- **SVC:** one encoder creates dependent temporal or spatial layers. It permits
  selective forwarding but does not create a topology or transport.
- **Network coding/FEC:** adds repair symbols so some loss can be recovered
  without retransmission; it neither compresses video nor repairs a failed path.

## Candidate Comparison

| Candidate | Host upload | Relay encode | Potential benefit | Decisive no-go |
| --- | ---: | ---: | --- | --- |
| Browser full-stream tree | up to `C*B` | one per child pipeline | deployable with standard WebRTC | relay CPU, generational loss or hop latency exceeds the small-room value |
| Native RTP relay | up to `C*B` | zero | removes relay re-encode | feedback, pacing or per-child congestion cannot remain isolated and bounded |
| Two encoded stripe trees | about `(1+r)B` | zero | lowers Host upload while retaining peer egress | endpoint upload remains near `2B`, two decoders/compositor are required, or churn breaks assembly |
| Browser encoded objects | about `C*B`, later stripeable | zero | pure-Web single encode and forwarding | application framing, jitter, A/V sync or queues recreate an unsafe media stack |
| FEC/network coding | unchanged plus repair | unchanged | faster repair for bounded loss | clean-path bytes/CPU exceed benefit or whole-path loss still dominates |
| Central SFU/MoQ | about `B` | central forwarding | mature low-latency availability | central egress remains `N*B` without a measured compensating gain |

`C` is an endpoint child bound, not a promise that the endpoint can encode or
upload `C` good streams. Native shared encode can reduce compute, while useful
network copies remain subject to conservation.

## Candidate Gates

### Native RTP Relay

A native relay may read encoded RTP from one receiver and write it to independent
downstream PeerConnections without decoding. Each child still needs its own
SSRC, pacing, RTCP feedback, DTLS-SRTP and ICE state.

Retain only if a 720p30, one-parent/two-child gate proves:

- zero relay video-encoder calls and at least 40% lower relay CPU than browser
  remote-track forwarding;
- no more than 25 ms added p95 relay latency and queue age below 100 ms;
- per-child bytes no more than 110% of input payload bitrate;
- isolated PLI, NACK/RTX and congestion behavior under clean and 1% loss; and
- a decodable first picture within one second after failure detection.

Reject if downstream feedback cannot be isolated, queue age is unbounded, or
ordinary browser leaves lose interoperability. This candidate lowers relay
compute, not total room upload.

### Two Stripe Trees

The Host sends complementary stripes through two deterministic,
interior-node-disjoint trees. An internal node forwards only its stripe; a Viewer
needs both parents and a bounded assembler. SVC alone cannot supply this shape:
its layers remain in one encoded RTP stream, and Encoded Transform does not move
encoded frames between transports.

Start with 50/50 single-layer frame/object striping. Retain only if:

- Host and relay upload stay at or below `1.1B` without repair;
- Host encodes once, relays encode zero times, and room useful bytes stay below
  `1.1*N*B`;
- per-hop overhead is at most 20 ms p95 and depth-four glass-to-glass p95 is at
  most 350 ms;
- path failure restores a decodable picture within one second; and
- repair still saves at least 30% Host upload relative to duplicating `2B`.

Reject if supported clients require unrelated decoders plus application-side
picture composition, or if bounded churn cannot preserve stripe identity.

### Browser Encoded Objects

WebCodecs exposes `EncodedVideoChunk`; DataChannel can carry framed objects over
peer ICE. This replaces the browser RTP receiver with application pacing,
framing, jitter buffering, keyframe requests, rendering and eventually A/V sync.

The first gate is only `Host -> relay -> leaf`, 720p30, chunks no larger than
16 KiB and a hard `bufferedAmount` ceiling. Retain only if:

- the Host encodes once and the relay does not encode;
- Host encode CPU falls at least 30% versus two browser send pipelines and relay
  CPU falls at least 40% versus remote-track forwarding;
- framing bytes are no more than 110% of the RTP baseline;
- two-hop glass-to-glass p95 is at most 250 ms, queues remain bounded, and first
  picture after reroute is below one second; and
- required mobile decoders pass and later A/V drift stays within 50 ms.

Reject rather than growing an application RTP replacement when those gates fail.

### FEC And Network Coding

First replay captured RTP/object traces through a simulator: random loss at
0/1/3/5%, 20/50/100 ms bursts, and 20/40/80 ms RTT. Compare NACK/RTX with small
XOR or Reed-Solomon blocks; consider sliding-window RLC only if simpler repair
passes.

Retain only if 1-3% loss or 20-50 ms bursts show at least 50% lower residual
loss/freeze, repair p95 below 100 ms and at least 25% faster than RTX, total media
plus repair and residual RTX no more than 110% of baseline, generation buffering
at most 16 ms, active repair overhead at most 15%, and coding CPU below about 5%
of one reference core. Clean paths should keep repair absent or minimal.

### MoQ

Browser WebTransport connects to a server; it does not turn a normal browser into
an Internet-listening peer relay. A central MoQ service therefore retains the
same egress class as an SFU. Keep it only if equal-quality measurements improve
latency or server CPU by at least 20% at the same egress, and draft-version churn
is isolated behind a small adapter.

## Local Reconciliation Evidence

Narada, Overcast and NICE show that overlay measurements can improve tree shape;
SplitStream adds multi-tree striping. BitTorrent, WebTorrent, CoolStreaming and
P2P Media Loader can contact several suppliers because buffered chunks are
interchangeable. None is a maintained drop-in controller for a live
`MediaStream` with sub-second interaction.

ICE already races and paces address, interface and NAT candidate pairs inside
one exact `RTCPeerConnection`. Trying another parent requires another
offer/answer, ICE/DTLS/RTP state, reservation and potentially another encoder.
Application-level all-pairs probing therefore multiplies real media work rather
than extending ICE Happy Eyeballs.

For a small room, one to three child observations do not provide the independent
sample volume needed for statistical host ejection or a stable weighted score.
Current-edge stats can diagnose that edge; they cannot prove an unconnected
parent is better.

The smallest general reconciliation model supported by this evidence is:

1. one authoritative graph and one event-driven desired/current loop;
2. hard eligibility from authenticated presence, bounded capacity, acyclicity
   and source reachability;
3. at most one child transition at a time, fenced to exact sessions, source and
   connection identity;
4. make-before-break when the old path remains usable, with the first newly
   decoded frame as commit proof; and
5. release on failure or deadline, while transport libraries retain ICE,
   consent, congestion control and transient reconnect ownership.

Reparenting a relay can retain its subtree, and several bad child edges can move
independently. This changes traffic placement, not the `N*B` aggregate. Library
retry values are implementation references, not universal application timers;
any timeout must be measured against the target network and user-visible bound.

## Sources And License Boundary

- [WebRTC](https://www.w3.org/TR/webrtc/), [WebRTC Stats](https://www.w3.org/TR/webrtc-stats/),
  [WebRTC SVC](https://www.w3.org/TR/webrtc-svc/), [Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/),
  [WebCodecs](https://www.w3.org/TR/webcodecs/), and [WebTransport](https://www.w3.org/TR/webtransport/).
- [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html), [ICE Happy Eyeballs, RFC 8421](https://www.rfc-editor.org/rfc/rfc8421.html),
  [Trickle ICE, RFC 8838](https://www.rfc-editor.org/rfc/rfc8838.html), [Data Channels, RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html),
  and [Sliding-window RLC, RFC 8681](https://www.rfc-editor.org/rfc/rfc8681.html).
- [SplitStream](https://www.microsoft.com/en-us/research/publication/splitstream-high-bandwidth-multicast-in-a-cooperative-environment/),
  [Narada](https://www.cs.cmu.edu/~srini/papers/papers/2002-Chu-jsac/2002-Chu-jsac.pdf),
  [Overcast](https://pdos.csail.mit.edu/~jj/jannotti.com/papers/overcast-osdi00/),
  [NICE](https://conferences.sigcomm.org/sigcomm/2002/papers/appmulti.pdf), and
  [CoolStreaming/DONet](https://www.cs.sfu.ca/~jcliu/Papers/47_01.pdf).
- [BitTorrent BEP 3](https://www.bittorrent.org/beps/bep_0003.html),
  [WebTorrent](https://github.com/webtorrent/webtorrent), and
  [P2P Media Loader](https://github.com/Novage/p2p-media-loader).
- [Pion WebRTC](https://github.com/pion/webrtc) and
  [klauspost/reedsolomon](https://github.com/klauspost/reedsolomon) are MIT;
  [LiveKit](https://github.com/livekit/livekit) is Apache-2.0.
- [Jitsi P2P/JVB ownership](https://github.com/jitsi/lib-jitsi-meet/blob/master/JitsiConference.ts)
  is implementation evidence, not copied code.
- [MOQT](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) and
  [moq-dev/moq](https://github.com/moq-dev/moq) are study references; the core
  uses MIT/Apache-2.0 while its OBS plugin is GPL-2.0-or-later.

No GPL/AGPL implementation code is copied or required by these candidates.
