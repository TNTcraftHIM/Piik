# Peer-Assisted Media Research

- Research date: 2026-08-19
- Scope: one game-screen broadcaster, at most eight trusted viewers, host media fanout at most two
- Status: evidence for the bounded ADR-0004 experiment; the stacked ADR-0005
  Draft adds binary relay capability and automatic optional-SFU routing but is
  not a production topology decision

## Conclusion

Peer-assisted forwarding can cap the broadcaster at one or two outgoing media
edges without making an SFU carry every viewer's traffic. The smallest credible
experiment uses only standard WebRTC media:

1. the browser host sends its screen stream to at most two first-level viewers;
2. each viewer may add the received remote `MediaStreamTrack` values to one
   downstream `RTCPeerConnection`; and
3. the signaling server assigns two balanced chains deterministically.

This path reuses WebRTC capture, codec negotiation, RTP, NACK/PLI/RTX, congestion
control, jitter buffering, ICE, STUN, TURN, DTLS-SRTP, and browser rendering. Its
cost is unavoidable in ordinary browsers: every relay decodes and re-encodes
the screen stream. The first spike measures whether that cost is acceptable; it
does not hide it or claim shared encoding.

The accepted flagship preference is `direct/peer UDP -> SFU-root fallback ->
optional exceptional-edge TURN -> bounded failure`. Direct P2P remains the
simplest path for one or two viewers. The experiment assigns the third and later
viewers to peers automatically. ADR-0005 makes SFU capacity part of the flagship
target while retaining peer descendants; its current default-off controller is
still failure-only and unconfigured in production.

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
twice, while a viewer with one child encodes once.

Sources:

- [libwebrtc video RTP receiver](https://webrtc.googlesource.com/src/+/refs/heads/main/pc/video_rtp_receiver.cc)
- [libwebrtc raw-frame sender source](https://webrtc.googlesource.com/src/+/refs/heads/main/media/engine/webrtc_video_engine.cc)

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

The signaling server remains the topology authority. The experiment uses two
sticky, balanced chains selected by one breadth-first walk. Here, one media edge
means one downstream `RTCPeerConnection` carrying the shared stream; selecting
TURN for that connection does not change the edge count.

- the host has capacity for at most two children and every viewer for at most
  one;
- the host's child count is a hard invariant and never exceeds two, including
  joins, reconnects, and reparenting;
- candidate parents are ordered by depth and server join sequence, and the
  first connected node with a free slot is selected;
- joining a viewer never moves an existing assignment; on parent loss, only the
  orphaned subtree root is reassigned and its descendants remain attached; and
- if no assigned parent is available, media waits or admission fails explicitly.
  The host never opens a third edge.

There is no RTT, bandwidth, CPU, geography, candidate-type, or historical
quality score. There is no optimization loop or live topology rebalancing. With
two host slots and one slot per viewer, eight viewers require a maximum depth of
four; that latency and repeated-encode cost is part of the experiment rather
than something hidden by a scheduler. The controlled relay cohort uses
foreground desktop Chrome/Edge; mobile leaf checks join after their intended
parent so the spike does not pretend to solve background mobile relay policy.

Per-edge ICE remains independent. An edge may be direct or may use authenticated
TURN, so peer assistance reduces normal server media traffic but cannot promise
zero server traffic in restrictive networks.

## Implemented Bounded Quality Coordination

The current Draft coordinates one strict `QualitySettings` object across the
peer-assisted tree without adaptation logic. It accepts only 720p/1080p/1440p,
integer 15-60 fps, integer 2-12 Mbps, and the three standard degradation
preferences; missing, extra, or out-of-range fields fail schema validation.
The three visible presets are recommendations rather than wire IDs. The server
stores the latest complete object in a room-count-bounded in-memory map,
defaults to 1080p60 at 8 Mbps with clarity priority, includes it in
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

A controlled Chrome 151 loopback smoke used one host, three viewers, and a
synthetic 720p30 source. Balanced and clarity settings reached every
participant; every baseline active outbound video sender displayed the matching
requested/applied preference; peer-connection fingerprints stayed unchanged;
and every viewer's decoded-frame and `requestVideoFrameCallback` counters grew
after each change. The harness brought each viewer page to the foreground for
its render check because Chrome throttles background frame callbacks. Host
fanout stayed at two and relay fanout at one. This is control and continuity
evidence only, not visual-quality, full-resolution, load, TURN, public-network,
or endurance evidence.

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

For observed encoded bitrate `B`, `N` viewers, two host slots, and one viewer
slot:

- host upload is at most approximately `2 * B`, plus transport overhead;
- each relay upload is at most approximately `B`;
- aggregate viewer delivery still requires approximately `N * B` across hosts,
  relays, and any TURN paths; and
- signaling/STUN carry negligible media traffic, while a TURN path still incurs
  relay ingress and egress for that edge.

Peer assistance distributes traffic; it does not eliminate it. Relay
eligibility must therefore be visible and voluntary in any production design.
The standalone ADR-0004 spike has no runtime capability flag and relies on
controlled join order. The accepted ADR-0005 direction's current default-off controller starts every viewer as a leaf,
then accepts an explicit per-session capacity of zero or one; its Web client
reports detected mobile/iPad clients as leaves and desktop-class browsers as
one-child relays. That conservative heuristic is still unverified on the real
mobile matrix and is not a substitute for a future voluntary relay policy.

## Bounded Spike And Gates

The experiment is disabled by default through `PEER_ASSISTED_MEDIA=false` and
cannot be enabled above eight viewers. It uses the existing standard WebRTC
screen stream, current desktop Chrome/Edge as relay nodes, current Android
Chrome and iOS Safari as required
leaf checks, one child per viewer, and at most eight viewers. It may carry the
existing screen-audio track when the browser provides one. SVC/simulcast,
custom encoded transport, FEC changes, multi-tree striping, transcoding,
background mobile relay, and automatic SFU migration are excluded.

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

1. The host has no more than two outgoing media edges and every viewer has no
   more than one child at every sampled instant,
   including churn; no hidden direct-host fallback is allowed.
2. Assignment is reproducible from depth and server join order. Standard relay
   statistics are expected to show a new outbound RTP encoder at every hop; its
   encode time, CPU/GPU cost, and `qualityLimitationReason` are recorded rather
   than mislabeled as shared encoding.
3. Excluding explicitly selected TURN edges, application-server media ingress
   and egress remains zero. Host and relay upload stay within 20% of
   `childCount * B`.
4. First picture is at most 3 seconds, decoded 60 fps does not remain below 50
   for more than 5 seconds without an explicit failure, and depth-four p95
   glass-to-glass latency is at most 350 ms.
5. Closing either first-level relay so the server observes it immediately starts
   the default 5-second disconnect grace. If it does not reconnect during that
   grace, deterministic reassignment produces a new decodable picture within the
   following 3 seconds without violating host fanout, about 8 seconds total.
6. At each relay, delta encode time per encoded frame stays at or below one
   60 fps frame interval on the reference cohort and CPU limitation does not
   persist for more than 5 seconds.
7. The standard WebRTC stream works on current Chrome and Edge relay nodes and
   on current Android Chrome and iOS Safari leaves.

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

Passing these gates proves only that a second design phase is justified. It
does not accept peer-assisted media for production. Production adoption would
need a new ADR, voluntary relay policy, and broader audio/A-V verification. The
native host shared-encode sender is a separate planned phase regardless of this
experiment's result and is not implemented here.

The recovery gate above does not cover silent network partitions. With the
default 30-second heartbeat, server detection can take 30 to 60 seconds before
the same 5-second grace begins; that case remains unverified and must be reported
separately.

## License Boundary

This research uses W3C/IETF specifications, BSD-licensed libwebrtc source,
official TeamSpeak statements, browser-compatibility data, and a published
systems paper. No GPL/AGPL implementation code was copied. GPL/AGPL projects
remain study-only until the project license and distribution model are decided.
