# Peer-Assisted Media Research

- Research date: 2026-08-22
- Scope: one game-screen broadcaster and an accepted admission target of twenty
  trusted viewers; retained executable evidence currently reaches sixteen and
  the earlier resource/quality gate remains eight
- Status: historical evidence plus the deployed bounded controller;
  accepted ADR-0005 owns automatic peer/SFU routing. Production later removed
  the room-`1` rollout boundary; retained SFU media remains unverified.

This document owns dated measurements and implementation evidence. Current
capacity and routing authority live in [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md)
and [project memory](../project-memory.md).

## Conclusion

Peer-assisted forwarding can reduce broadcaster fanout without making an SFU
carry every viewer's traffic. The release measurements below are historical
evidence rather than current capacity policy. The accepted path uses standard
WebRTC media, one active upstream per Viewer, a bounded acyclic peer graph, and
one uniform non-server outbound capacity `C` configured as `1`, `2`, or `3`.
Host publication and peer children consume physical sender slots under
ADR-0005; SFU/TURN server resources use separate admission.

This path reuses WebRTC capture, codec negotiation, RTP, NACK/PLI/RTX, congestion
control, jitter buffering, ICE, STUN, DTLS-SRTP, and browser rendering. An
exact controller-authorized logical edge may also use selected TURN. Its
cost is unavoidable in ordinary browsers: every relay decodes and re-encodes
the screen stream. The first spike measures whether that cost is acceptable; it
does not hide it or claim shared encoding.

The accepted controller preserves healthy direct/peer UDP edges. Exact selected
TURN may replace an authorized logical edge transport; one Host publication and
per-Viewer SFU subscriptions provide server-fed ingress when selected by the
same bounded controller. Direct P2P remains the
simplest path while a healthy endpoint sender slot is available; later Viewers
may be assigned to peers automatically. ADR-0005 makes SFU capacity part of the flagship
target while retaining peer descendants. The first production rollout used a
room-`1` exact smoke; participant entry was observed, but retained SFU media
remained unverified. Production later removed that room boundary.

## What Browsers Can Share

The WebRTC specification permits the same `MediaStreamTrack` to be sent more
than once, but each send is represented by a separate `RTCRtpSender`. It does
not promise that these senders share an encoder. Current libwebrtc constructs a
separate `VideoSendStream` and `VideoStreamEncoder` with its own encoder queue
for each send stream. The product must therefore assume one encoder pipeline
per browser send stream even if a particular GPU driver happens to optimize it.

Cloning a track or using `VideoTrackGenerator` can share a capture source or
raw-frame preprocessing. The values entering each `RTCRtpSender` are still raw
`VideoFrame` objects, so this does not share the encoded result.

Sources:

- [WebRTC sender/receiver relationship](https://w3c.github.io/webrtc-pc/#rtp-media-api)
- [Media Capture shared sources](https://w3c.github.io/mediacapture-main/)
- [Media Capture Transform raw `VideoFrame` model](https://w3c.github.io/mediacapture-transform/)
- [libwebrtc creates a send stream per sender](https://webrtc.googlesource.com/src/+/refs/heads/main/media/engine/webrtc_video_engine.cc)
- [libwebrtc creates a `VideoStreamEncoder` per send stream](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_send_stream_impl.cc)

## Why Encoded Transform Is Not Shared Encoding

WebRTC Encoded Transform runs after a sender encoder and before its packetizer,
or after a receiver depacketizer and before its decoder. Its normative write
algorithm rejects a frame whose owner differs from the transform's frame
source, stating that a processor cannot create frames or move frames between
streams. It therefore cannot tee sender A's encoded frame into sender B's RTP
pipeline.

Replacing the bytes of dummy frames produced by sender B would still run sender
B's encoder and would couple unrelated keyframe, dependency, cadence, and codec
metadata. It is a browser-specific hack rather than a supported pre-encoded RTP
injection point and is outside this experiment.

Encoded Transform could expose the already depacketized frame before decode,
but using that data outside the receiver leads to the custom transport described
below. It is not part of the first spike.

Source: [WebRTC Encoded Transform stream processing](https://w3c.github.io/webrtc-encoded-transform/#stream-processing)

## Standard Browser Relay Versus Encoded Relay

### Standard WebRTC Track Relay

A browser can receive a remote `MediaStreamTrack` and add it to another
`RTCPeerConnection`. This is the compatibility-first route, but the public
track carries decoded frames. Current libwebrtc connects a receiver to a
`VideoSinkInterface<VideoFrame>` and a sender accepts a
`VideoSourceInterface<VideoFrame>` before creating its own encoder pipeline.

It follows from those source interfaces that a normal browser relay decodes and
re-encodes at every hop. It is functional but adds relay CPU/GPU load, encode
delay, and generational quality loss. Each outbound WebRTC send stream creates
an independent sender encoder: the experimental host can therefore encode
twice, while a viewer with two children has two independent outbound senders.

Sources:

- [libwebrtc video RTP receiver](https://webrtc.googlesource.com/src/+/refs/heads/main/pc/video_rtp_receiver.cc)
- [libwebrtc raw-frame sender source](https://webrtc.googlesource.com/src/+/refs/heads/main/media/engine/webrtc_video_engine.cc)
- [W3C WebRTC `addTrack` and sender model](https://www.w3.org/TR/webrtc/) (accessed 2026-08-21)
- [WebRTC remote-stream forwarding primitives](https://webrtc.org/getting-started/remote-streams) (accessed 2026-08-21)

### Server Authority And Ordinary Capacity

The WebRTC 1.0 sender model associates transmission with an individual
`RTCRtpSender`; it does not turn a client-declared fanout value into server
authority. Pion's maintained `TrackLocalStaticRTP` similarly maintains multiple
bindings and writes a packet per bound downstream context. These sources support
counting each physical downstream sender/edge, including an overlapping
provisional or selected replacement, rather than treating a logical route as one
upload. OWASP's server-side input-validation guidance treats client input as
untrusted and requires semantic validation in the trusted service.

The resulting Screener policy is an engineering inference: authenticate the
session first, then let the server apply one ordinary downstream capacity to
every non-server endpoint. The default is two and a deployment may choose one,
two, or three. Upstream receive is free; role, UA, visibility, and client
advertisement cannot raise or create another tier. A client-side clamp can limit
damage from a server regression, but does not replace authenticated server
authority. Assisted transport and temporary-overlap accounting are separate
routing questions and are not defined by this resource observation.

Sources, accessed 2026-08-22:

- [W3C WebRTC 1.0 Recommendation](https://www.w3.org/TR/webrtc/)
- [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [Pion `TrackLocalStaticRTP` bindings](https://github.com/pion/webrtc/blob/main/track_local_static.go)

### Encoded DataChannel Relay, Rejected For The First Spike

WebCodecs accepts and emits `EncodedVideoChunk` values but defines no network
transport and no bridge into `RTCRtpSender`. Sending those chunks through a
DataChannel avoids relay re-encoding, but the application must define:

- protocol and stream-generation versions;
- frame ID, timestamp, duration, key/delta type, and codec configuration;
- fragments and reassembly bounds;
- queue limits and late-frame dropping;
- keyframe requests after join, loss, or reparenting;
- decoder reset and generation changes; and
- explicit failure when the codec or feature set is unsupported.

DataChannel still provides ICE/TURN traversal, DTLS protection, SCTP
fragmentation, partial reliability, and association-level congestion control.
RFC 8831 warns that a large message can monopolize an SCTP association when
message interleaving is unavailable and recommends limiting messages to 16 KB
in that case. Even a minimal custom alternative would need a reliable ordered
control channel plus an unordered, zero-retransmission video channel, with
application messages no larger than 16 KB when interleaving is unavailable.

This is a custom media plane over a proven transport, not a custom UDP stack.
It remains materially more complex than standard WebRTC media and is rejected
for the first spike. It cannot rescue a failed browser-relay gate. The separate
native shared-encode sender described in `low-server-media-routes.md` is planned
independently and requires its own ADR and measurements.

Sources:

- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [WebRTC Data Channels, RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html)

## Native TeamSpeak-Style Shared Encoding

TeamSpeak describes its current single-encoding design as encoding once and
sending the result directly to viewers. This removes repeated encoding and
memory cost, but it does not remove one network copy per viewer. It therefore
does not satisfy a hard host fanout of two by itself.

A candidate native Screener sender could preserve standard browser receivers
without writing a new transport. libwebrtc accepts an application-supplied
`VideoEncoderFactory`, which creates a possible boundary for per-stream proxy
encoders backed by one shared hardware encoder. If the bounded spike proves the
callback and adaptation contract, libwebrtc could retain independent RTP
sequence numbers, packetization, SRTP, RTCP, NACK/RTX, ICE, and congestion state
for the two host edges.

This is an engineering inference from the native interfaces, not a ready-made
libwebrtc feature. The coordinator must deduplicate input frames, reconcile
independent rate requests, combine keyframe requests, preserve timestamps, and
require one common codec/profile/resolution/layer. The separate bounded risk
spike must prove whether this route can guarantee one host encode while keeping
normal browser first-hop receivers; requiring a libwebrtc internal fork rejects
the route. Browser JavaScript cannot provide that guarantee.

Sources:

- [TeamSpeak single-encoding explanation](https://community.teamspeak.com/t/ts6-beta-community-update-insights/58116/208)
- [libwebrtc `VideoEncoderFactory`](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder_factory.h)
- [libwebrtc `VideoEncoder` and encoded callback](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder.h)

## Deterministic Experimental Topology

The signaling server remains the topology authority. The source candidate uses
a sticky, bounded DAG selected by one breadth-first walk. Here, one media edge
means one downstream `RTCPeerConnection` carrying the shared stream; a later
controller-selected TURN rebuild does not change the edge count.

- the historical experiment gave the host and every ordinary Web viewer capacity
  for at most two children;
- that experiment's endpoint child count was a hard invariant and never exceeded two,
  including joins, reconnects, and reparenting;
- candidate parents are ordered by depth and server join sequence, and the
  first connected node with a free slot is selected;
- every viewer has exactly one active upstream even though several candidate
  parents may be eligible;
- join/capacity admission never moves a healthy edge; on disconnect or current
  edge failure, only each orphaned direct subtree root is reassigned while its
  descendants remain attached; and
- if no assigned parent is available, media waits or admission fails explicitly.
  The host never opens a third edge.

There is no RTT, bandwidth, CPU, geography, candidate-type, or historical
quality score. There is no optimization loop, multi-source media, or live
topology rebalancing. With two host and two viewer slots, eight viewers require
a maximum depth of three; that latency and repeated-encode cost is part of the
experiment rather than something hidden by a scheduler. Ordinary Web clients
use the same capacity without UA or visibility classification; mobile devices
remain non-blocking compatibility observations.

Per-edge ICE remains independent. Ordinary peer edges are STUN-only; the
controller may select authenticated TURN for an exact logical edge transport or
the single Host-SFU ingress under the accepted route model. Peer assistance therefore reduces normal server media
traffic but cannot promise zero server traffic in restrictive networks.

## Implemented Bounded Quality Coordination

The current implementation coordinates one strict `QualitySettings` object across the
peer-assisted tree without adaptation logic. It accepts only 720p/1080p/1440p,
integer 15-60 fps, integer 2-12 Mbps, and the three standard degradation
preferences; missing, extra, or out-of-range fields fail schema validation.
The three visible presets are recommendations rather than wire IDs. The server
stores the latest complete object in a room-count-bounded in-memory map,
defaults to 1080p60 at 8 Mbps with clarity-first priority, includes it in
peer-assisted authenticated snapshots, and broadcasts host changes to online
viewers. The value survives a stopped share, is removed with the room, and is
not written to SQLite. Ordinary P2P authentication remains unchanged and
setting-control messages are forbidden in that mode.

After peer-assisted authentication, the host reasserts its local selection
before reconciling assigned children. A viewer records the snapshot or update
before applying its assignment. `ViewerRelay` keeps a synchronously updated
desired setting and serializes setting changes with stream replacement, so both
an existing child and a later replacement start from the latest target. Inside
`HostPeer`, initial sender configuration, stream replacement, and setting
updates share one mutation queue; operations read the latest desired setting at
execution time, giving rapid changes last-wins behavior without versions or
acknowledgements.

If the host changes quality while signaling cannot accept the room update, its
current local senders still apply the setting but the UI reports that room sync
is waiting for reconnect. The next successful host authentication reasserts the
latest object; no acknowledgement state machine is added.

The configured SFU publisher follows the same boundary: first publication,
successful track replacement, and live setting changes all configure the real
`RTCRtpSender`, then retain requested/applied bitrate, frame rate, scale, and
preference. Configuration rejection uses the existing rollback/fail-closed
path rather than silently leaving the publication on unverified parameters.
After initial activation or source replacement settles, the host reads and
shows the route warning; a successful replacement rollback retains the original
failure instead of clearing it with the restored sender readback.

This only removes the previous fixed-1080p60 relay envelope. Browser constraints
and RTP sender parameters remain targets, so achieved bitrate, frame rate,
resolution, encode work, and cross-hop quality still require the measurement
matrix below. It does not add or imply shared encoding.

An earlier controlled Chrome 151 loopback smoke used one host, three viewers, and a
synthetic 720p30 source. Balanced and clarity settings reached every
participant; every baseline active outbound video sender displayed the matching
requested/applied preference; peer-connection fingerprints stayed unchanged;
and every viewer's decoded-frame and `requestVideoFrameCallback` counters grew
after each change. The harness brought each viewer page to the foreground for
its render check because Chrome throttles background frame callbacks. Host
fanout stayed at two and relay fanout at one. This is control and continuity
evidence only, not visual-quality, full-resolution, load, TURN, public-network,
or endurance evidence.

A 2026-08-22 release-checkpoint rerun at exact source `b77f4eb58944` used Chrome
151.0.7922.138, three Viewers, the Host2/ordinary Browser Viewer1 policy, an
eight-second sample window, and the existing hard-departure recovery gate. All
three Viewers decoded; Host media fanout peaked at two, Browser relay fanout at
one, and no SFU publication appeared. Closing the first-level relay page moved
its affected descendant and resumed advancing frames in 5,380 ms while the Host
remained within two media edges. The requested synthetic source was 1280x720 at
30 fps, but observed final samples remained 320x180 at roughly 9-11 fps. This is
real local `RTCPeerConnection` media and hard-participant-departure evidence. It
does not exercise decoded-frame-stall recovery or provisional MBB, a silent
socket partition, SFU, TURN, a public network, game capture, or resource quality.

A 2026-08-22 opt-in `BENCHMARK_CANARY=viewer-mbb` run on the same Chrome build
used one Host and three Viewers. It observed a real provisional
`RTCPeerConnection` retain the old edge, promote the candidate, preserve the
connection identity, and continue decoded-frame progress within the ordinary
edge cap. This is reusable make-before-break control evidence only; its
synthetic trigger is not route policy or heterogeneous-network evidence.

A 2026-08-21 local Chrome 151 capacity-two run used one Host and five Viewers
with a synthetic 720p30 stream. Host and relay fanout peaked at two; one Viewer
simultaneously served two children, whose inbound counters each advanced by 80
decoded frames and about 1.1 MB. All five Viewers decoded and cleanup reported
no fatal error. The run proves the two-child control path and bound on local
Chrome only. It does not prove shared encoding, CPU/GPU cost, visual quality,
games, mobile resources, public networking, or endurance.

The historical loopback runner used cap2 by default;
`BENCHMARK_EXPECTED_ENDPOINT_CAP=3` configured only its local server and gate.
That source checkpoint later rejected cap3 in its release-policy mode.
A 2026-08-22 Chrome 151 two-second
smoke passed with three Viewers at Host2/relay1 and six at Host3/relay3, with all
Viewers decoding. This was an experimental control-path result, not a
release-policy, production-default, SFU-capacity, or resource claim.

The following cap2/cap3 results are retained historical experiments and do not
select product policy. A 2026-08-22 Windows
Chrome 151.0.7922.138 headless loopback ran sixteen
Viewers for two seconds at 720p30 with cap2 and cap3. Both runs had all sixteen
Viewers decoding and no fatal/check failure. Cap2 peaked at Host2/relay2 with
depth four and a 1,167 ms maximum first-decode diagnostic; cap3 peaked at
Host3/relay3 with depth three and 977 ms. Final samples were only 320x180 at
9-10 fps. The 8-core/16-thread Ryzen 7 9700X runner had 47.1 GiB RAM and 13.7
GiB free after the runs, but no process CPU, GPU, NIC, or peak-memory totals were
captured. This proves the explicit admission, bounded topology, and decode paths
only; resource, visual quality, endurance, heterogeneous networks, and larger-room
acceptance remain open.

A same-machine 2026-08-22 Chrome 151 follow-up ran sixteen Viewers for ten seconds at 720p30 and introduced report schema v2; sender means are unweighted connected sender-sample means, while encode cost is weighted by guarded interval frame deltas.
Cap2 passed at Host2/relay2 with 2 Host and 14 relay senders: Host/relay bitrate was 1,716/1,748 kbps, FPS 11.17/11.20, available outgoing 5,393/5,704 kbps, and encode cost 2.086/2.048 ms per frame.
Cap3 passed at Host3/relay3 with 3 Host and 13 relay senders: the same fields were 1,589/1,638 kbps, 10.83/10.87 FPS, 5,474/5,956 kbps, and 2.071/2.126 ms per frame.
Both runs observed only 320x180 and 480x270; every Host limitation sample was `bandwidth`, every relay sample was `none`, and maximum first-decode diagnostics were 1,071/1,021 ms for cap2/cap3.
[CDP `SystemInfo.getProcessInfo`](https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/) exposes process type, PID, and cumulative CPU seconds, but no resident-set field; v2 therefore reports peak RSS as `null` and rejects intervals when the exact type/PID set changes or any counter retreats.
Cap2 measured 221.4% aggregate Chromium CPU (250.7% peak) over two valid and three rejected intervals; cap3 measured 209.8% (246.9% peak) over four valid and one rejected interval. Multicore totals may exceed 100%.
The different valid coverage and one short run per arm forbid a cap2/cap3 CPU ranking. CDP cannot attribute these all-process totals to an individual Host or relay page, and this ordinary-PC synthetic run does not close resource, game-quality, endurance, mobile, or larger-room acceptance.

Peer multicast research such as SplitStream demonstrates why load-balanced,
failure-tolerant overlays normally introduce multiple trees and content
striping. Those mechanisms are intentionally excluded: needing them is a reason
to abandon this small-product experiment, not to expand it.

Source: [SplitStream, SOSP 2003](https://www.microsoft.com/en-us/research/publication/splitstream-high-bandwidth-multicast-in-a-cooperative-environment/)

## Compatibility Boundary

The standard remote-track relay in the first spike uses broadly deployed WebRTC
media APIs and does not depend on Encoded Transform or WebCodecs. Current MDN
browser-compatibility data records `RTCRtpScriptTransform` in
Chrome 141, Firefox 117, and Safari 15.4. `VideoDecoder` is recorded in Chrome
94, Firefox desktop 130, and Safari/iOS 16.4, but not Firefox Android.
`MediaStreamTrackProcessor` remains less portable: Chrome's implementation is
partial, Firefox has no implementation, and Safari added it in version 18.

These compatibility figures explain why the custom encoded alternative is not
the first spike. Even when an API exists, an application must call
`VideoDecoder.isConfigSupported()` for the exact codec configuration. API
presence is not proof that a particular codec, profile, resolution, or hardware
path works.

Sources:

- [Encoded Transform compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/RTCRtpScriptTransform.json)
- [WebCodecs `VideoDecoder` compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/VideoDecoder.json)
- [`MediaStreamTrackProcessor` compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/MediaStreamTrackProcessor.json)

## Resource Model

For observed encoded bitrate `B`, `N` Viewers, and configured ordinary
downstream capacity `C`:

- each non-server parent has at most approximately `C * B` ordinary downstream
  upload, plus transport overhead;
- aggregate viewer delivery still requires approximately `N * B` across hosts,
  relays, and any TURN paths; and
- signaling/STUN carry negligible media traffic, while a TURN path still incurs
  relay ingress and egress for that edge.

Peer assistance distributes traffic; it does not eliminate it. The product
keeps topology automatic and invisible while the server enforces the configured
capacity. The standalone ADR-0004 spike relied on controlled join order; the
ADR-0005 controller starts each Viewer at zero and waits for an authenticated
capacity message. There is no mobile/iPad, UA, or visibility capacity branch.

## Selected-Pair Response Observation

The W3C Stats specification makes `RTCTransportStats.selectedCandidatePairId`
the exact reference to the current `RTCIceCandidatePairStats`. A stats object's
`id` identifies the monitored object, while `responsesReceived` is the
cumulative number of connectivity-check responses received by that candidate
pair. Stats snapshots carry timestamps and applications derive interval values
from two snapshots. Unsupported fields are omitted, and a current pair is
deleted when the transport switches to a newly generated pair. These semantics
support a local observation; they do not define an application failure signal.
The existing compatibility fallback is retained only when that exact reference
is absent and exactly one same-transport succeeded nominated/selected pair is
available; an ambiguous or broken relationship remains unknown.

RFC 7675 binds consent to one transport 5-tuple. An authenticated matching STUN
response refreshes consent, but the default consent-check interval is randomized
between four and six seconds and a response can match an earlier request.
Therefore zero `responsesReceived` growth over one two-second application sample
does not prove a silent partition. Conversely, growth proves only that a STUN
response was observed on that pair, not that media quality or future reachability
is healthy. Video-frame counters are independent, so a static shared frame must
not be classified as a transport failure.

The bounded implementation uses one accumulator per `RTCPeerConnection` and the
selected pair's own stats timestamp. It reports the cumulative counter plus a
delta and elapsed milliseconds only across adjacent samples of the same pair.
The first sample, PC replacement, pair change or disappearance, missing/invalid
counter or timestamp, non-increasing timestamp, counter retreat, or a sampling
gap above five seconds reports the interval fields as unknown and establishes a
new baseline. The five-second ceiling is a named observation-window bound for
the current two-second sampler; it is not a consent timeout or a route policy.

Acceptance for this slice is observation-only:

- expanded local connection details show the opaque selected-pair identity,
  cumulative `responsesReceived`, and the adjacent bounded delta/window;
- the click-only diagnostic allowlist may contain the cumulative counter,
  interval delta, and interval duration, but not the pair ID, candidate
  addresses/ports, raw stats, signaling, or credentials;
- a missing response counter or required timestamp remains unknown rather than
  zero; and
- no value starts ICE restart, emits `route-failed`, changes topology/quality,
  adds a wire or server ping, or uploads/persists telemetry.

Sources, accessed 2026-08-22:

- [W3C Identifiers for WebRTC's Statistics API](https://www.w3.org/TR/webrtc-stats/)
- [RFC 7675, Consent Freshness for WebRTC](https://www.rfc-editor.org/rfc/rfc7675.html)

## Bounded Spike And Gates

This historical gate assumed default-off configuration through
`PEER_ASSISTED_MEDIA=false`; current production enables the controller for all
rooms.
It uses the existing standard WebRTC screen stream, current Chrome/Edge as the
controlled relay cohort, Android Chrome and iOS Safari as compatibility
observations, and the configured downstream edge cap. The runner must accept the
shared room admission ceiling of twenty; the current retained run reaches
sixteen while the representative resource/quality gate remains at eight. It may carry the existing screen-audio
track when the browser provides one. SVC/simulcast,
custom encoded transport, FEC changes, multi-tree striping, transcoding,
background mobile relay, and the later ADR-0005 SFU controller are outside this
historical browser-relay gate.

Run 1, 3, 5, and 8 viewers for 30 minutes across the three recommended ceiling
combinations, plus any advanced combination proposed for production, under
controlled per-edge RTT at or below 40 ms and loss at or below 1%. Record
topology generation and depth, selected candidate type, host
and relay upload, packets lost, jitter, frames encoded/decoded/dropped, total
encode/decode time, decoded FPS, `qualityLimitationReason`, first picture,
reparent time, CPU, GPU, and glass-to-glass latency.

The in-app per-frame encode/decode fields use adjacent `getStats()` counter
deltas and skip a tick while the same connection already has a sample in
flight. A first sample, zero-frame interval, changed stats object, or counter
reset reports unknown and rebases; a connection-lifetime average is not
accepted as relay-load evidence. Long-run percentiles and event timing still
come from a tracked run manifest plus browser WebRTC diagnostics, not a new
telemetry service.

All hard gates must pass:

1. The host and every viewer have no more than two outgoing media edges at every
   sampled instant, and a third child is rejected,
   including churn; no hidden direct-host fallback is allowed.
2. Assignment is reproducible from depth and server join order. Standard relay
   statistics are expected to show a new outbound RTP encoder at every hop; its
   encode time, CPU/GPU cost, and `qualityLimitationReason` are recorded rather
   than mislabeled as shared encoding.
3. Excluding explicitly selected TURN edges, application-server media ingress
   and egress remains zero. Host and relay upload stay within 20% of
   `childCount * B`.
4. First picture is at most 3 seconds, decoded 60 fps does not remain below 50
   for more than 5 seconds without an explicit failure, and depth-three p95
   glass-to-glass latency is at most 350 ms.
5. Closing either first-level relay so the server observes it immediately starts
   the default 5-second disconnect grace. If it does not reconnect during that
   grace, deterministic reassignment produces a new decodable picture within the
   following 3 seconds without violating host fanout, about 8 seconds total.
6. At each relay, delta encode time per encoded frame stays at or below one
   60 fps frame interval on the reference cohort and CPU limitation does not
   persist for more than 5 seconds.
7. The standard WebRTC stream works on the controlled Chrome and Edge relay
   cohort. Android Chrome and iOS Safari remain non-blocking compatibility
   observations rather than a separate capacity policy.

An ordinary implementation defect may be corrected inside the spike. If a gate
requires an encoded DataChannel/WebCodecs media plane, custom congestion
control, FEC/RTX changes, multiple distribution trees, relay scoring,
transcoding, a codec ladder, or relaxed host fanout, abandon this browser
architecture. Mark ADR-0004 rejected, remove its experimental runtime code and
dependencies, and retain this research. The separate planned native
shared-encode sender still requires its own ADR, lowers encode work rather than
per-edge upload, and cannot rescue other failed browser-relay gates. A rejected
relay experiment keeps standard P2P plus explicit user-operated or central SFU
fallbacks.

Passing these historical gates proved only that a second design phase was
justified. ADR-0005 subsequently accepted the bounded controller; production
first ran a room-`1` smoke and later removed that rollout boundary. Retained SFU
media and broader audio/A-V verification remain open. The
native host shared-encode sender is a separate planned phase regardless of this
experiment's result and is not implemented here.

## Browser Signaling Silent-Partition Detection

The recovery gate above does not cover a browser WebSocket that remains open
locally after its network path has silently failed. The server's default
30-second protocol heartbeat can take 30 to 60 seconds to observe that failure,
and browser script cannot observe WebSocket Ping or Pong control frames. The
[WHATWG WebSockets Living Standard](https://websockets.spec.whatwg.org/)
(accessed 2026-08-22) exposes messages, generic error/close events, and
`readyState`; it also specifies that constructing a WebSocket immediately
starts a new connection while `close()` starts a closing handshake whose close
event arrives later. The application therefore needs a small text-message
challenge rather than waiting for either protocol Ping/Pong or the old socket's
close event.

Under the current `screener-v7` Browser wire, the Web client sends
`signaling-challenge { sequence }`, and the server sends the exact
`signaling-challenge-response { sequence }` only to that requesting socket.
Server and Browser assets deploy atomically; stale Browser and executable-sender
wires fail before room authority, with no compatibility parser or response seam.

The Web watchdog is eligible only while the current socket is authenticated,
the share is online, and the endpoint has an active authoritative route (the
Host itself, an ordinary Viewer with an online Host, or a peer-assisted Viewer
whose active upstream is not `none`). After five seconds it sends one
challenge. An exact two-second miss enters an internal suspect state and sends
one fresh confirm challenge; an exact second two-second miss logically retires
that socket generation and immediately constructs a replacement without
waiting for the old closing handshake. Responses from another sequence or
socket generation are ignored, and the server revalidates the current
authenticated session before replying. A hidden document, a visibility
restore, or an obviously late timer callback clears pending evidence and starts
a fresh five-second baseline instead of declaring failure.
This response-only watchdog is deployed in release `21d5cd9f7139`; real silent
partition timing remains a production/browser evidence boundary.

The response is socket-local, contains no room state, secret, candidate, or raw
statistics, is not logged, and is limited by the server to at most one response
per socket per second. The watchdog itself does not close or rebuild media,
emit `route-failed`, or change route authority. Ordinary P2P and a duplicate
same-revision SFU authority keep their healthy media while the new socket
reauthenticates. An existing `peer-selected` TURN lease remains deliberately
bound to both authenticated sessions: replacing either session invalidates that
exceptional transport and leaves recovery to the existing bounded route path.
Relaxing or carrying that security authority is a separate routing/protocol
change, not part of signaling liveness detection.

## License Boundary

This research uses W3C/IETF specifications, BSD-licensed libwebrtc source,
official TeamSpeak statements, browser-compatibility data, and a published
systems paper. No GPL/AGPL implementation code was copied. GPL/AGPL projects
remain study-only until the project license and distribution model are decided.
