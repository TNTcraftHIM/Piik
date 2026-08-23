# Advanced Peer Distribution

- Research date: 2026-08-23
- Scope: current route admission up to twenty trusted viewers, sub-second
  interactive media, endpoint downstream cap `1..3`, and minimal central-server
  media egress; retained advanced-media measurements may cover smaller cohorts
- Status: deterministic peer distribution and provisional make-before-break are
  retained evidence; current routing converges through ADR-0005's single
  child-reparent reconciliation, while advanced encoded-media routes remain
  unimplemented candidates

This document is research evidence, not current architecture or a backlog. See
[ADR-0005](../adr/0005-automatic-hybrid-media-routing.md) for accepted routing
invariants and [the TODO ledger](../todo.md) for pending work.

## Terms

- **Multiple trees:** split one media representation into two stripes and send
  each stripe through a different peer tree. A viewer receives both trees; an
  internal relay forwards only its assigned stripe. This balances endpoint
  upload but requires two parents, assembly, loss recovery, and churn handling.
- **SVC:** one encoder produces a base layer plus dependent temporal or spatial
  enhancement layers. It lets a forwarder drop enhancement data, but it does
  not create a distribution topology or move layers between transports.
- **Network coding:** send repair symbols formed from several source symbols so
  a receiver can recover loss after collecting enough independent symbols. It
  adds bytes and CPU; it can reduce retransmission delay but cannot compress the
  video or replace route migration after a complete path failure.

Complexity alone is not a rejection reason. A route is retained only when a
bounded experiment shows lower endpoint compute or bandwidth, keeps the user
experience automatic, and meets the latency and queue limits below.

## Cost Accounting

Let `B` be one complete stream bitrate, `N` the viewer count, and `r` repair
overhead. Protocol headers and retransmission overhead are additional.

| Route | Host upload | Central media traffic | Encode work |
| --- | ---: | ---: | --- |
| Current full-stream browser chains | at most `2B` | zero on direct peer edges; SFU legs are accounted separately | host up to two encoders; every relay encodes again |
| Native full-stream RTP relay | at most `2B` | zero on direct peer edges | relay zero encode; native host can share one encode |
| Two encoded-object stripe trees | about `(1+r)B` | zero on direct peer edges | host one encode; relay zero encode |
| Host publication with bounded SFU subscriptions | measured `B_pub` | per-subscriber egress; see low-server model | one publication may carry at most two active representations; physical encoder count remains measured evidence |
| Full central SFU/MoQ fanout | about `B` | ingress `B`, egress `N*B` | a possible bounded fallback result, never the default topology or mode |

Useful last-hop traffic remains approximately `N*B`; these routes only decide
which nodes emit the copies. Exact SFU publication/subscription and billing
accounting is owned by [Low-Server-Cost Media Routes](./low-server-media-routes.md).

## Candidate 1: Native RTP Relay

This is a retained Native research direction, not a current milestone. A
native helper can read
encoded RTP from one WebRTC receiver and write the payload to at most two
independent downstream browser PeerConnections without decoding and encoding
the video again. Each downstream edge keeps its own SSRC, pacing, RTCP,
DTLS-SRTP, and ICE behavior.

Draft PR [#16](https://github.com/TNTcraftHIM/Screener/pull/16) passes an earlier
in-process transport oracle: one Pion v4.2.18 `TrackLocalStaticRTP.WriteRTP`
call reaches two independent PeerConnections with preserved semantic payload,
sequence number, and timestamp plus binding-specific SSRCs. It contains no
encoder or browsers, so it is not evidence for one physical encode, end-to-end
compatibility, feedback arbitration, congestion control, or latency.

If an owning decision reopens it, the retained Go/Pion gate is video-only VP8 at
720p30 with one browser upstream and two unchanged browser children. It must
prove:

- zero relay video-encoder calls and at least 40% lower relay CPU than browser
  remote-track forwarding;
- no more than 25 ms added p95 relay latency;
- per-child bytes no more than 110% of input payload bitrate;
- bounded queue age below 100 ms;
- PLI, NACK/RTX, and one direct edge under both clean and 1% loss conditions; and
- reparented first picture within one second after failure detection.

This lowers relay compute and generational quality loss. It does not lower host
or total upload until combined with a native shared sender or striped media.
Relay-capable participants need the helper; ordinary desktop/mobile browsers
remain valid leaves.

## Candidate 2: Two Stripe Trees With SVC

The target shape assigns every relay-capable endpoint at most two downstream
edges. The host sends stripe A to one seed and stripe B to another. An internal
node forwards its assigned roughly `B/2` stripe to at most two children, so its
total upload stays near `B`. Every viewer receives both stripes from two parents.
The host encodes once and sends about `B`, central egress stays near zero, and
relay nodes do not encode.

SVC may make one stripe a base temporal layer and the other enhancement data,
or duplicate selected base data for resilience. SVC alone cannot implement this
shape: the WebRTC SVC API keeps layers in one encoded RTP stream, and WebRTC
Encoded Transform does not permit moving encoded frames across streams. The
data plane therefore requires either native RTP/object nodes or WebCodecs plus
DataChannel.

Start with single-layer 50/50 frame/object striping, then test `L1T2` temporal
SVC only after transport works. Use two deterministic, interior-node-disjoint
trees; do not add a continuous optimizer.

Go gates:

- host and relay upload no more than `1.1B` without repair;
- unique host encode calls equal input frames and relay encode calls stay zero;
- whole-room useful bytes no more than `1.1*N*B` without repair;
- no more than 20 ms p95 overhead per hop and depth-four p95 no more than
  350 ms;
- a path failure returns a decodable picture within one second after detection;
- protection still saves at least 30% host upload relative to `2B`; and
- the controlled Web relay cohort passes runtime codec capability probes;
  mobile browsers remain compatibility observations, not a capacity class.

Reject that spike if endpoint upload remains near `2B`, relay encoding returns,
queues cannot be bounded, or supported clients require two unrelated decoders
and application-side picture composition.

## Candidate 3: Browser Encoded Objects

WebCodecs can encode once and expose `EncodedVideoChunk` values. WebRTC
DataChannel can carry framed chunks over peer ICE paths. This is the
credible pure-browser route to encoded forwarding and later two-tree striping,
but it replaces the browser's RTP media receiver with application framing,
pacing, a jitter buffer, keyframe requests, a WebCodecs renderer, and eventually
A/V synchronization.

The first spike is only `host -> relay -> leaf`, 720p30 video, reliable control,
and unordered media with bounded retransmission. Use chunks no larger than
16 KiB and a hard `bufferedAmount` ceiling.

Go gates:

- one host encode and zero relay encode;
- at least 30% lower host encode CPU than two browser send pipelines and at
  least 40% lower relay CPU than remote-track forwarding;
- framing bytes no more than 110% of the RTP baseline;
- two-hop glass-to-glass p95 no more than 250 ms;
- bounded queues and first picture below one second after reroute; and
- required mobile decoders pass, with later A/V drift no more than 50 ms.

## Candidate 4: FEC And Network Coding

FEC is useful only when repair bytes avoid slower RTX or visible freezes. It
does not reduce clean-path bandwidth or survive permanent loss of a full tree
unless redundancy approaches another complete stream.

Before media integration, replay captured RTP/object traces through a simulator:

- random loss at 0%, 1%, 3%, and 5%;
- 20, 50, and 100 ms bursts at 20, 40, and 80 ms RTT;
- baseline NACK/RTX versus XOR or Reed-Solomon `k=4/8` with one/two repair
  symbols, then sliding-window RLC only if those results justify it.

Go gates:

- at least 50% lower residual loss/freeze at 1-3% loss or 20-50 ms bursts;
- repair p95 below 100 ms and at least 25% faster than RTX;
- total media plus repair and residual RTX bytes no more than 110% of baseline
  media plus RTX bytes;
- no more than 16 ms generation buffering and 15% active repair overhead; and
- coding CPU below roughly 5% of one reference core.

Clean paths should keep repair disabled or below 3-5%. Whole-path failure still
belongs to the route controller.

## Candidate 5: MoQ

Browser WebTransport connects a browser to a server; it does not make a normal
browser an Internet-listening peer relay. A central MoQ deployment therefore
has the same server-egress class as an SFU. Benchmark it only as an optional
central fallback and keep it only if, at equal quality and egress, latency or
server CPU improves at least 20% over the SFU reference and draft-version churn
is isolated behind a small adapter.

## Current Bounded Local Reconciliation Conclusion

This is the research basis for ADR-0005's bounded local reconciliation. Narada and Overcast
demonstrate measurement-driven overlay improvement, but neither supplies a
maintained WebRTC RTP/RTCP routing library. BitTorrent/WebTorrent and P2P Media
Loader use chunk-pull swarms and
playout buffers, while SplitStream requires striped multi-tree media.
Their exploration and hysteresis ideas are useful, but none is a drop-in route
controller for sub-second screen sharing. A mature SFU is the directly reusable
low-latency alternative, with central egress rather than audience forwarding.

This product has too few children per relay to infer parent-wide quality from a
small set of sibling samples. Mature outlier detection requires materially more
independent hosts and request volume before statistical ejection; route policy
therefore does not use sender/viewer correlation, sibling voting, relative FPS,
or a room score. Those metrics remain diagnostic.

The application consumes only an exact child edge's hard connection failure or
a non-paused interval with no newly decoded frame. That child enters ADR-0005's
single reconciliation loop. If the child is itself a relay, changing its ingress
retains its subtree. If several downstream edges fail, each child reparents
independently and the old relay naturally empties. WebRTC and LiveKit retain
transport connectivity, consent, congestion control, reconnection, and SFU
stream-state ownership.

Every upstream change uses one bounded transaction. The candidate is bound to
the authenticated endpoint sessions, share generation, base and pending route
revisions, and candidate connection. A usable old edge stays authoritative until
the candidate child decodes its first new video frame. That single event already
proves the candidate's ICE/DTLS/RTP/decode path; failure or deadline expiry
releases the candidate and wakes the same loop for the next choice.

For `N` Viewers a peer tree still has `N` media edges and approximately `N*B`
useful upload in aggregate. Local reparenting redistributes that traffic; it does
not eliminate it. The controller therefore keeps a healthy tree sticky and only
handles waiting or invalid edges.

Candidate inputs remain discrete: an active authenticated session,
effective capacity with a free downstream slot, acyclicity, source reachability,
and server admission. Standard ICE owns candidate-pair
priority, pruning, connectivity checks, peer-reflexive discovery, and nomination
inside one `RTCPeerConnection`; the application does not build another ping mesh.

The controller orders eligible parents by shallowest resulting tree, remaining
steady sender slots, stable join order, and peer identity. It keeps healthy
assignments sticky and changes only one child upstream per room transaction. A
provisional child reserves the required endpoint and server resources until
commit or abort. If an old edge is usable, make-before-break retains it until the
candidate child decodes; a hard-invalid edge uses the same transaction without
pretending the old media still works. No weighted score, UA/device model, IP
geography, claimed NAT type, cooldown optimizer, or role-specific rescue path is
part of selection.

## Staged Connection Recovery Evidence

Recovery should spend attempts on different layers, not repeat one opaque action
three times. The current WebRTC Recommendation advises an ICE restart when
`iceConnectionState` reaches `failed`; for `disconnected`, it recommends first
checking whether sent/received bytes progress over the next couple of seconds.
Pinned LiveKit client 2.22.0 uses reconnect delays of 0, 300, 1,200, 2,700,
4,800 and then 7,000 ms (with later jitter), a 15-second peer/WebSocket timeout,
and a four-second state reconciliation that requires three consecutive
mismatches before a full reconnect. Jitsi Videobridge similarly defaults to a
15-second first-transfer timeout and an eight-second inactivity limit. These are
reference boundaries, not universal prescriptions. Screener's separately owned
15-second initial deadline is a deployed implementation value, not an accepted
experience target; mobile-network evidence may justify revisiting the one total
deadline only through ADR-0005.

WebRTC/LiveKit first owns transient reconnect. A hard failure or non-paused
decoded-frame stall wakes ADR-0005 once and seeds the exact failed
`parent + transport` tuple as already tried. The same room operation tries other
direct parents, then different admitted transports and Host-publication SFU
under current capacity and server admission. There is no separate same-edge
repair ladder or persistent parent blacklist.
Every completion is guarded by the current authenticated sessions, share
generation, pending route revision, and candidate connection. Sustained bitrate,
FPS, resolution, and blur remain diagnostic.

The first room-1 production trace on 2026-08-20 observed two short Host
participants while two roots remained for roughly 4.6 seconds; all ended with
client-requested leave, no track publication survived, and neither service
restarted. This proves LiveKit participant entry. The timing is consistent with
the then-current one-shot grant refresh and recovery state machine, but logs do
not prove those transitions and cannot distinguish
connect, source, video publish, sender configuration, optional audio publish, or
transport failure. The accepted v9 diagnostic, which is not part of deployed
v8, exposes only a closed local stage/outcome enum to an on-demand Host snapshot
and deliberately keeps raw errors, URLs, tokens, candidates, and addresses out
of wire and logs.

## Automatic Route Controller Boundary

The accepted controller preserves healthy peer edges and chooses one route per
logical edge: direct/STUN first, then the dedicated SFU/UDP path when needed. A
server-fed ingress uses the room's single Host publication plus exact SFU
subscriptions; it is not a fixed rung inserted between every peer edge.
Every attempt ends in bounded success, wait, or failure.

Native full-stream relay and striped-object routes remain the bounded candidates
above; passing their own gates may change capability, but does not insert them
into the current route model.

The SFU uses one authoritative Host publication and exact per-Viewer
subscriptions. SFU-fed and peer-fed endpoints use the same provisional-child
first-frame transaction. Server ingress/egress uses deployment-wide admission
rather than a fixed root count or room-wide lease. The SFU/UDP accounting lives
in [Low-Server-Cost Media Routes](./low-server-media-routes.md). ADR-0005 owns
the accepted behavior.

The controller is automatic and invisible. It uses participant metadata, route
revisions, endpoint capacity, server admission, and discrete exact-edge failure;
it exposes no topology choices. One reconcile loop handles join, waiting,
disconnect, effective-capacity overflow, and failed edges. W3C
`framesDecoded` counts successfully decoded video frames, so the first new
candidate frame is the only application readiness event. LiveKit owns SFU
reconnection and stream state; the application adds no network-type poll or
SFU-specific timer.

The overlap edge is physical: an active Host SFU publication consumes one steady
sender slot, and a media-producing provisional peer candidate consumes another.
Every non-server parent uses deployment capacity `C in {1,2,3}` without a
Browser tier. A free steady slot permits ordinary make-before-break; otherwise a
single fenced `TransitionOverlapSlot` may raise the physical count only to
`min(C + 1, 3)`. A full `C=3` endpoint must wait, use a bounded-gap transition,
or fail before creating a fourth copy. Failed or stale probes restore the prior
controller revision and release their reservation before reconciliation
continues.

## Sources And License Boundary

Sources checked on 2026-08-20 through 2026-08-23:

- [WebRTC SVC](https://www.w3.org/TR/webrtc-svc/),
  [Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/),
  [WebCodecs](https://www.w3.org/TR/webcodecs/), and
  [WebTransport](https://www.w3.org/TR/webtransport/) - W3C specifications.
- [WebRTC Data Channels, RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html)
  and [Sliding-window RLC, RFC 8681](https://www.rfc-editor.org/rfc/rfc8681.html).
- [Pion WebRTC](https://github.com/pion/webrtc) and
  [klauspost/reedsolomon](https://github.com/klauspost/reedsolomon) - MIT; no
  source copied.
- [WebRTC Recommendation](https://www.w3.org/TR/webrtc/) - `failed` ICE restart
  and `disconnected` bytes/stats guidance.
- [LiveKit client 2.22 reconnect policy](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/DefaultReconnectPolicy.ts),
  [room defaults](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/defaults.ts),
  and [state reconciliation](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/Room.ts)
  - pinned implementation behavior, not a universal timeout prescription.
- [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
  - event-driven desired/current reconciliation reference; no scheduler or
  disruption framework is copied.
- [Envoy outlier detection](https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/outlier_detection.proto)
  - statistical host ejection defaults require at least five hosts and material
  request volume, unlike Screener's one-to-three child sample.
- [LiveKit server 1.13.5 participant quality aggregation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/participant.go)
  and [connection scorer](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/connectionquality/scorer.go)
  - Apache-2.0; studied only, with no source copied.
- [Jitsi Videobridge endpoint status defaults](https://github.com/jitsi/jitsi-videobridge/blob/master/jvb/src/main/resources/reference.conf)
  - first-transfer and inactivity reference values.
- [SplitStream](https://www.microsoft.com/en-us/research/publication/splitstream-high-bandwidth-multicast-in-a-cooperative-environment/)
  and [Network Coding for Large Scale Content Distribution](https://www.microsoft.com/en-us/research/publication/network-coding-for-large-scale-content-distribution/)
  - research evidence, not reusable source licenses.
- [Narada](https://www.cs.cmu.edu/~srini/papers/papers/2002-Chu-jsac/2002-Chu-jsac.pdf),
  [Overcast](https://pdos.csail.mit.edu/~jj/jannotti.com/papers/overcast-osdi00/),
  [NICE](https://conferences.sigcomm.org/sigcomm/2002/papers/appmulti.pdf), and
  [CoolStreaming/DONet](https://www.cs.sfu.ca/~jcliu/Papers/47_01.pdf) -
  original application-layer multicast and live-streaming research.
- [BitTorrent BEP 3](https://www.bittorrent.org/beps/bep_0003.html),
  [WebTorrent](https://github.com/webtorrent/webtorrent), and
  [P2P Media Loader](https://github.com/Novage/p2p-media-loader) - mature
  chunk/segment swarms, not an RTP route implementation.
- [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/),
  [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html), and
  [LiveKit SFU](https://docs.livekit.io/reference/internals/livekit-sfu/) -
  observable path boundaries and the centralized low-latency alternative.
- [LiveKit client 2.22 room events](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/Room.ts)
  - pinned reconnect/reconnected behavior; no implementation source was copied.
- [MOQT draft](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) and
  [moq-dev/moq](https://github.com/moq-dev/moq) - core MIT/Apache-2.0; its OBS
  plugin is separately GPL-2.0-or-later and remains study-only.

No GPL/AGPL implementation code was copied.
