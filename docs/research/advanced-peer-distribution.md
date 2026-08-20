# Advanced Peer Distribution

- Research date: 2026-08-19
- Scope: at most eight trusted viewers, sub-second interactive media, endpoint
  downstream fanout at most two, and minimal central-server media egress
- Status: bounded C+B local reparenting is deployed for one exact room and the
  deterministic admission-rescue slice is implemented source-only; advanced
  encoded-media routes remain isolated candidates

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
overhead. Protocol headers, retransmission, and TURN overhead are additional.

| Route | Host upload | Central media traffic | Encode work |
| --- | ---: | ---: | --- |
| Current full-stream browser chains | at most `2B` | zero except TURN edges | host up to two encoders; every relay encodes again |
| Native full-stream RTP relay | at most `2B` | zero except TURN edges | relay zero encode; native host can share one encode |
| Two encoded-object stripe trees | about `(1+r)B` | zero except TURN edges | host one encode; relay zero encode |
| SFU virtual parent to bounded roots | measured `B_pub` | root-only; see low-server model | one publication may carry at most two active representations; physical encoder count remains measured evidence |
| Full central SFU/MoQ fanout | about `B` | ingress `B`, egress `N*B` | comparison class, not the accepted fallback shape |

Useful last-hop traffic remains approximately `N*B`; these routes only decide
which nodes emit the copies. Exact `B_pub`/`B_i`, root, TURN-hop, and billing
accounting is owned by [Low-Server-Cost Media Routes](./low-server-media-routes.md).
TURN is edge transport; it is not a peer/SFU topology.

## Candidate 1: Native RTP Relay

This is the nearest-term high-confidence optimization. A native helper can read
encoded RTP from one WebRTC receiver and write the payload to at most two
independent downstream browser PeerConnections without decoding and encoding
the video again. Each downstream edge keeps its own SSRC, pacing, RTCP,
DTLS-SRTP, ICE, and TURN behavior.

Draft PR [#16](https://github.com/TNTcraftHIM/Screener/pull/16) passes an earlier
in-process transport oracle: one Pion v4.2.18 `TrackLocalStaticRTP.WriteRTP`
call reaches two independent PeerConnections with preserved semantic payload,
sequence number, and timestamp plus binding-specific SSRCs. It contains no
encoder or browsers, so it is not evidence for one physical encode, end-to-end
compatibility, feedback arbitration, congestion control, or latency.

The next Go/Pion spike is video-only VP8 at 720p30 with one browser upstream
and two unchanged browser children. It must prove:

- zero relay video-encoder calls and at least 40% lower relay CPU than browser
  remote-track forwarding;
- no more than 25 ms added p95 relay latency;
- per-child bytes no more than 110% of input payload bitrate;
- bounded queue age below 100 ms;
- PLI, NACK/RTX, 1% loss, one direct edge, and one TURN edge; and
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
- target desktop relays and mobile leaves pass runtime codec capability probes.

Reject that spike if endpoint upload remains near `2B`, relay encoding returns,
queues cannot be bounded, or supported clients require two unrelated decoders
and application-side picture composition.

## Candidate 3: Browser Encoded Objects

WebCodecs can encode once and expose `EncodedVideoChunk` values. WebRTC
DataChannel can carry framed chunks over peer ICE/TURN paths. This is the
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

## Candidate 6: Bounded Capability-Aware Local Reparenting

This remains a bounded topology candidate outside ADR-0004. Narada and Overcast
demonstrate measurement-driven overlay improvement, but neither supplies a
maintained WebRTC RTP/RTCP routing library. BitTorrent/WebTorrent and P2P Media
Loader use chunk-pull swarms and
playout buffers, while SplitStream requires striped multi-tree media.
Their exploration and hysteresis ideas are useful, but none is a drop-in route
controller for sub-second screen sharing. A mature SFU is the directly reusable
low-latency alternative, with central egress rather than audience forwarding.

The first quality-driven slice reuses the authenticated Viewer C window and
existing route intent, plus one strict parent-to-server B message. Signaling
binds C to room, Viewer session, connection ID, active revision, parent
peer/session, sequence, two-second rate and 2 KiB size, then forwards the same
sanitized object. The current parent answers that exact sequence within five
seconds only when its current outbound sample has a positive `packetsSent`
delta. The existing discriminated proof is `sending` for diagnostic liveness,
`sender-limited` only for an exact `qualityLimitationReason` of `cpu` or
`bandwidth`, or `remote-loss` when that interval has at least 100 sent packets
and RTCP-reported remote loss divided by sent packets is at least 30%; it never
carries a null placeholder. One current connection cannot reuse the same
`sampleTimestampMs` for multiple C sequences; fractional stats windows are
rounded before applying the protocol bounds. The
server accepts one B from the bound parent session and generation. The router
may retain C while awaiting B, but advances only when the correlated pair has a
hard C receive predicate and a hard B sender predicate. `sending`, either
report alone, and healthy or ambiguous pairs reset or do not advance the
streak.
It holds at most one pending/streak state per connected Viewer and one room
cooldown, with no timer, weighted score or global parent-capacity decision.

The conservative Viewer C hard predicates are: freeze duration at least half
of the one-to-five-second window; positive received-packet delta with zero
decoded frames; or at least 100 received-plus-lost packets with loss at least
30%. Parent B must independently report the exact `cpu`/`bandwidth` sender
limitation or at least 100 sent packets with remote loss divided by sent packets
at least 30%. Three consecutive dual-hard-bad windows are required. A healthy
or incomplete correlated window, any Viewer/parent session, connection, route
revision or parent change, or a gap over five seconds clears the streak. A
successful peer move or started SFU prepare spends a 30-second room migration
budget, so a new public Viewer identity cannot bypass it. Per-edge state clears
on authentication/generation change, disconnect/removal and route replacement;
room stop/delete also clears the cooldown.

An SFU preparation created by quality retains the exact originating intent and
its full Viewer/parent session, connection and revision guard until grants and
commit finish. Missing, replaced or changed intent state aborts and releases
only its quality-owned parent exclusion. A real `route-failed` can take over
that same intent without losing its exclusion; a successful peer move releases
the quality-only exclusion so a later real failure after reattachment remains
actionable.

W3C defines outbound `packetsSent` as the local cumulative RTP packet count.
`remote-inbound-rtp.packetsLost` is remote receiver data delivered by RTCP and
the corresponding stats object does not exist until that RTCP first arrives;
absence is therefore not zero. W3C's video-only `qualityLimitationReason` stays
an exact local sender predicate rather than an encoder score. Parent B and
Viewer C are gathered by stock browsers at separate endpoints, but RTCP remote
loss is receiver-originated and neither report is cryptographically independent
or resistant to colluding authenticated participants. W3C also defines
Viewer-side
`packetsReceived`, `packetsLost`, `framesDecoded`, `freezeCount` and
`totalFreezesDuration`; its WebRTC 1.0 diagnostic example treats loss over 30%
as a likely culprit. It does not define route-migration thresholds. The 50%
freeze share, 100-packet floor, three windows, five-second gap and 30-second
cooldown are falsifiable candidate constants for production calibration, not
standards-derived or claimed optimum values.

The correlated pair can therefore attribute a problem only to the current
parent-to-child edge generation. It cannot prove that the parent is globally
bad: the remote-loss value is that child's RTCP report and
`qualityLimitationReason` belongs to one outbound video stream. LiveKit's pinned
server implementation deliberately reduces published-track and subscribed-
downtrack quality to a participant-wide minimum; that aggregate is useful for
conferencing UI but is not a directional P2P parent score. Screener consequently
excludes only the failed parent for the affected Viewer-rooted subtree and
releases the quality-owned exclusion after a successful move.

With host degree two and the current browser-relay degree one, two balanced
chains already minimize maximum depth at `ceil(N/2)`. A tree for `N` viewers
still has `N` media edges, approximately `N*B` useful upload in aggregate, and
approximately `2B` host upload once both roots are used. Local reparenting does
not reduce either bandwidth quantity. Reordering an already balanced healthy
tree also cannot reduce depth; a move needs a discrete admission, path, TURN,
relay-resource, recovery, or future native-capacity benefit.

The source admission-rescue slice is limited to its discrete capacity case. If
a relay-capable viewer is unassigned because two zero-capacity roots,
especially mobile leaves, occupy both host slots, it inserts that viewer above
one deterministic childless root:

```text
host -> new relay -> existing leaf
host -> other root
```

This admits the waiting viewer while keeping host fanout two and browser relay
fanout one. The router permits it only on an active peer-only route with no SFU
publication or pending prepare, when the connected candidate currently has no
upstream or children, newly offers one relay slot, and has no failed-parent
history. The host must have exactly two children and the chosen child must be a
connected, childless, zero-capacity leaf. Existing server join order chooses the
oldest eligible leaf. One synchronous topology snapshot changes the host,
candidate, and leaf; one route revision replaces both upstream generations and
clears their old connection IDs. The Host reconciler closes every stale child
edge before starting replacement children, so its physical fanout does not
temporarily exceed two.

Eligibility remains discrete: an active authenticated session, explicit relay
capacity, compatible representation, a free downstream slot, acyclicity, and
depth/edge budgets. The implemented rescue never moves a candidate that already
has an upstream, never handles a failed-path intent, and never selects a root by
quality. An authenticated viewer can still lie about its relay capacity, so the
exact-room canary and ordinary route-failure recovery remain required; the lie
can cause at most this one local move before the candidate is no longer
unassigned. Broader experiments
may react to a hard media failure, a reviewed threshold-crossing event from
correlated path evidence, or a proven native capacity change, but never a
continuous optimizer. Do not use a weighted score, UA/device model, IP
geography, or one party's unverified report. Keep healthy assignments sticky,
move only one affected subtree, use separate enter and recovery thresholds plus
a cooldown, and disable proactive moves for the share after repeated rollback.

Use make-before-break only when the new parent has a free downstream media slot
and every affected endpoint remains within its limit: host at most two, current
browser relay one, and any future native relay at most two. Admission rescue
starts with both host slots occupied, so it is break-before-make: retire the
chosen host-to-leaf media edge before activating host-to-new-relay media. A
control-only `RTCPeerConnection` may prewarm ICE but cannot prove media uplink:
WebRTC exposes `availableOutgoingBitrate` only after congestion-controlled RTP
has used that candidate pair. Zero interruption, active standby media, and a
hard endpoint edge limit cannot all be guaranteed at once.

Proceed only after the current evidence-alignment and peer canary gates pass.
Every sampled instant must retain host/relay fanout limits; unaffected branches
must not freeze; make-before-break must decode at every affected receiver on the
new path before retiring the old edge, while break-before-make must do so within
one second p95 after the break and before declaring the move successful. Stable
reference runs must not migrate; each move must record one discrete benefit,
avoid reversal during cooldown, and restore the prior deterministic route on
rollback. Reject this candidate if it needs all-pairs probing, a continuous
optimizer, temporary fanout above budget, self-reported geography or device
quality, or cannot beat the unchanged route. The earlier admission-rescue case
remains valid, while this quality slice moves only the affected Viewer-rooted
subtree and excludes only its current failed parent through the existing
peer-first, then SFU path. The default-off source candidate's selected-edge TURN attempt follows SFU
failure; healthy paths never enter relay optimization.

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
15-second initial deadline remains a candidate pending mobile-network evidence.

The accepted Screener order is therefore: soft visible wait while initial ICE
is still making progress; one ICE restart on hard failure; one same-parent PC
rebuild; one different eligible peer parent; then SFU only after peer exhaustion.
Each success cancels the remaining stages. Every completion is guarded by the
current session, route revision, assignment/connection generation, and cooldown.
Connected-but-bad media is a separate correlated-quality trigger and must not be
treated as a connection retry.

The first room-1 production trace on 2026-08-20 observed two short Host
participants while two roots remained for roughly 4.6 seconds; all ended with
client-requested leave, no track publication survived, and neither service
restarted. This proves LiveKit participant entry. The timing is consistent with
the current one-shot grant refresh and Peer-failback state machine, but logs do
not prove those transitions and cannot distinguish
connect, source, video publish, sender configuration, optional audio publish, or
transport failure. The next bounded diagnostic exposes only that local enum to
the Host and deliberately keeps raw errors, URLs, tokens, candidates, and
addresses out of wire and logs.

## Automatic Route Controller Boundary

The accepted product order is:

`direct/peer UDP -> SFU roots -> optional exceptional-edge TURN -> wait/fail`

Native full-stream relay and striped-object routes remain the bounded candidates
above; passing their own gates may change capability, but does not insert them
into the current product ladder.

The enabled SFU is normally a virtual parent for at most `R=2` roots, which
retain bounded peer descendants. A viewer that cannot attach behind any healthy
root may be separately admitted only under the explicit `E`/central-egress cap;
this is an exceptional compatibility budget, not unbounded whole-room fanout.
The SFU/UDP and optional selected-edge TURN transport accounting lives in
[Low-Server-Cost Media Routes](./low-server-media-routes.md). ADR-0005's current
controller remains failure-only, while its accepted target also handles
admission with no eligible peer path; neither changes the sticky local
reparenting candidate above.

The controller must be automatic and invisible. It uses explicit capability
bits, route revisions, media generations, edge budgets, and discrete failures;
it does not expose topology choices to host or viewers. Initial hard triggers
are capacity, maximum depth, ICE/media failure, unsupported codec, and bounded
send-queue overflow. Measurements may later justify additional triggers.

Use make-before-break when a downstream slot is free. With all two slots in
use, strict fanout means break-before-make; zero interruption, no standby, and a
hard two-edge limit cannot all be guaranteed simultaneously. Sub-second recovery
also requires a media/data heartbeat near 100-200 ms rather than the current
30-second control heartbeat.

## Sources And License Boundary

Sources checked on 2026-08-20:

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
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html) - per-edge relay
  transport rather than a room topology.
- [MOQT draft](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) and
  [moq-dev/moq](https://github.com/moq-dev/moq) - core MIT/Apache-2.0; its OBS
  plugin is separately GPL-2.0-or-later and remains study-only.

No GPL/AGPL implementation code was copied.
