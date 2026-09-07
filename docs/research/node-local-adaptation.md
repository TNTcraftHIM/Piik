# Node-Local Adaptive Encoded Reuse

Reviewed: 2026-09-07. [ADR-0013](../adr/0013-embedded-node-local-media.md) now owns
the accepted model and highest-demand envelope. Codec backends and timing
values still need implementation evidence. ADR-0007 remains the runtime contract.
The [design proposal](./node-local-media-design.md) narrows implementation from
the measurements below; it does not reopen the agreed topology/reuse model.

## Agreed Model

ADR-0013 is the sole owner of the accepted direct-child model and policy. This
file retains evidence and alternative comparisons, not a second design contract.
The implementation design is owned by [node-local media design](./node-local-media-design.md).
`base/native` names the selected source quality; it is not a second output
alongside an identical `high` encoding.

## Two Workstreams

- Self-contained Screener Server: library-level STUN/media components inside the
  executable, not bundled external service processes or an automatic installer.
- Adaptive reuse: local derivation, shared lower outputs, independent child
  delivery and quality recovery, usable by Native Client and the server.

These share media-source and lifetime concepts but need separate acceptance.
A forwarding-only SFU library does not provide the second workstream by itself;
server-side derivation needs real decoding/encoding capacity. Pure Browser
peers can consume normal WebRTC outputs and benefit from capable upstreams,
but have no generic cross-PeerConnection encoded-forwarding API.

## Existing Building Blocks And Gaps

- `mediaedge.Source` already forwards encoded RTP to multiple Pion edges.
- Native GCC observations currently drive route evidence, not the shared
  encoder. A sustained weak edge may use a measured Browser-sender exception.
  That exception is not yet a reusable derived-encoding pool.
- Existing capture encoders, generation fences, keyframe requests and bounded
  route operations are reusable. A new standalone quality controller, global
  node score or periodic rebalancer is not assumed.
- Current routing reacts primarily to persistently degraded senders. A healthy
  edge forwarding already-low input may not trigger a move. Transport health
  and available source quality must be distinguished before claiming recovery.
- Simulcast, encoder allocation, active encoding, layer forwarding and bandwidth
  probing are different operations. Pausing a representation must not be
  mistaken for destroying its codec object or reopening capture.

## Open Choices

- Always encode all configured lower outputs, enable all after the first weak
  child, or activate only the representations currently demanded.
- Keep unused encoder resources warm or release them; decide from cold-start,
  first-keyframe, GPU-session, memory and idle-CPU measurements.
- Use a bounded representation set and one parameter owner per shared output.
  Determine which mature component owns demand grouping and adaptation; do not
  assume that independent child GCC loops can all mutate one shared encoder.
- Coordinate a usable-frame handoff before switching, preserve unaffected
  branches, and avoid repeated downgrade/recovery churn.
- Check server software-transcode cost and platform-native hardware availability
  independently. A network-capable parent is not necessarily a capable encoder.

## Simulcast And Dynacast Findings

These observations were checked against LiveKit Server 1.13.6 and JS SDK 2.22.1,
not inferred from the words "automatic" or "simulcast":

- Simulcast advertises several encoded representations of one source. The SDK
  constructs a finite encoding set before publishing; it does not create an
  arbitrary new representation for every bandwidth sample or subscriber.
- The pinned screen-share defaults create the original plus one lower spatial
  representation for ordinary screen sizes, not invariably three encoders.
- The server's Dynacast video manager aggregates the highest subscribed quality
  across subscribers/downstream SFU nodes. Its update enables existing qualities
  at or below that maximum. Thus a high requirement can retain lower fallback
  representations; this is not exact per-current-layer consumer reference
  counting. Do not claim every unused individual lower layer is always stopped.
- A higher quality request is not subject to downgrade-only debounce. Reduced
  maximum demand is debounced; the pinned server default is five seconds. This
  is an upstream implementation fact, not a proposed Screener timing constant.
  Publisher deactivation debounce is not a five-second delay before reducing
  traffic to a congested subscriber.
- The SDK applies the selected active flags through `RTCRtpSender.setParameters`
  on the existing sender. WebRTC's `active=false` preserves SSRC identity. It is
  not a guarantee that every Browser releases, or retains, hardware encoder
  resources in the same way.
- Subscriber forwarding choice is separate from publishing activity and from
  destroying an encoder. A decoder-safe layer switch needs an appropriate
  random-access point and consistent RTP/timestamps, not just another byte array.
- LiveKit's prober documents padding-based capacity probes independently of
  video-layer production. Higher-video-layer probing is another possible
  strategy, but cannot be substituted for a calibrated congestion controller.

The useful lessons are finite representations, distinct demand/transport
ownership, asymmetric activation/deactivation and independent network probing.
They do not imply importing the whole LiveKit service or extending its
subscriber-tree demand aggregation to override our direct-child derivation rule.

## Strategy Comparison

Shared encoding and per-child selective delivery are common to both compared
policies. The owner explicitly excludes Native-plus-Browser and repeated full
encoders as the next experiment's reference baseline. Compare exact demanded
outputs against the maximum-demand envelope, not shared versus unshared media.

| Strategy | Main benefit | Cost to verify |
| --- | --- | --- |
| Base plus all lower encodings always active | Lower outputs are already being produced when needed | Permanent encode/GPU cost even for an entirely healthy tree; still needs a switch point |
| Base only, then all lower outputs after any weak child | Small policy, some idle savings | First downgrade remains a cold start; one weak child starts outputs nobody requested |
| Finite outputs activated only as needed | Avoids unused representations and shares compatible demands | Cold start and churn if codecs are constantly destroyed/recreated |
| Demand activation with bounded warm retention or a minimal fallback output | Potential compromise between steady cost and transition delay | Requires measurements to justify retention or pre-encoding; not free memory/session capacity |

The owner's 2026-09-07 preference makes the LiveKit-style maximum-demand
envelope a first-class candidate: keep the highest requested representation and
its lower fallbacks active; stop unused higher outputs when all direct children
need less. Compare it with exact demand activation, not with an assumption that
exact demand is inherently better. Prefer the simpler envelope if its measured
cost is small and switching is better. Good network capacity alone does not
prove spare encoding capacity or cheap lower outputs.

Both policies retain the original source authority and the ability to recover;
stopping an unneeded high output does not lower capture or discard the best
received input. Exact demand can retain inactive codec resources for a bounded
comparison instead of repeatedly destroying them. No production timing value,
extra polling loop or prediction score has been selected.
Do not blindly create a fallback encoder set at every forwarding relay: that
would add decode/encode work to the entirely healthy tree. Reusing received
encodings and deciding how an already-needed encoder set stays active are
separate decisions; publisher measurements cannot stand in for relay costs.
Where the media framework supports it, negotiate the finite representation
capability up front and activate existing identities; a quality change should
not reopen capture or recreate a PeerConnection merely to add an encoder.

Preparing/retaining an encoder, actively encoding frames and forwarding packets
are separate costs. Share stop, source replacement and failed ownership still
retire their resources immediately; warm retention cannot revive a retired source.

## Reusable Components

| Component | Useful capability | Boundary |
| --- | --- | --- |
| Existing `mediaedge.Source` and Pion RTP/WebRTC/interceptors | Encoded fanout, per-edge transport and feedback | No decoder/transcoder or shared-variant policy is supplied automatically |
| Existing Native encoders and generation/keyframe ownership | Platform encode paths already integrated with Screener | Received-source decode/scale and shared derived outputs still need design |
| LiveKit Dynacast, layer selector and prober sources | Reference for demand aggregation, safe switching and recovery probes | Apache-2.0 code; inspect imports/ownership before any extraction, not whole-service embedding |
| libvpx multi-resolution VP8 API/example | Multiple spatial encodes through one coordinated API; libvpx is already used | VP8-specific; no promise that H264 hardware sessions have the same cost curve |
| OpenH264 AVC simulcast API | Library H264 encode/decode and per-spatial-layer configuration | Software codec; inspect realtime cost and actual source/binary distribution terms before selection |
| FFmpeg `libavcodec` and frame/filter APIs | Embedded decoding, scaling and hardware/software encoding | A library option, not launching `ffmpeg`; build/license/size cost remains to compare |
| Pion mediadevices | Go codec-controller and raw-frame broadcast interface reference | Cgo/native codecs still exist; not a reason to replace the working capture adapters |
| GStreamer `tee`/queues and codec elements | Shared decode/frame flow and isolated output branches | `webrtcsink` currently encodes per consumer, so it does not directly solve shared derived output |

No candidate has yet demonstrated the complete local derivation, reuse and
recovery contract. The current inLive probe proves forwarding only. A small SFU
library does not by itself replace a transcoder. Do not add FFmpeg/GStreamer or
change the current Native codec stack on documentation claims alone.

## Focused Comparison Plan

Use the same source, codec, frame rate and direct-child count for each arm:

1. Healthy children: verify no derived encode is added just for fanout.
2. One weak child, then two compatible weak children: verify one derived output
   is sufficient for both and the original branch stays unchanged.
3. Bandwidth drop/recovery and short oscillation: compare cold versus retained
   encoder startup, first usable frame, freezes, CPU/GPU, memory and actual RTP
   traffic. Count extra decoders and CPU/GPU frame copies as well as encoders;
   Browser-decoded preview frames are not automatically zero-copy Native input.
   Measure extra IDR/probe traffic, not only the selected bitrate.
4. Low inherited input on an otherwise healthy edge: distinguish lack of better
   source from lack of link capacity; exercise higher-input recovery or the
   existing bounded route operation without a new global optimization loop.
5. Source replacement, child departure and stop: verify generations and release
   of decoder/encoder surfaces, tracks and queues.

The first [CPU-only encoder comparison](./node-local-encoding-probe.md) is complete.
It compares existing Native VP8 encodes and scripted direct-child demand, not
network adaptation or playback. It supports keeping the maximum-demand envelope
as a candidate, but also exposes timestamp-sensitive resume behavior in a naive
warm-encoder composition. Validate mature multi-resolution pause/resume semantics
before implementing retention. H264 hardware, relay decode/scale and actual
receiver switching remain open; no production policy changed.
The subsequent [software-preference decode comparison](./node-local-browser-probe.md)
now includes VP8/H264, scaling and two real VideoDecoders, plus received-source
relay derivation. It measures local component readiness only, not WebRTC delivery
or congestion. The design treats representation bookkeeping as small and puts
the remaining overhead work in codec lifecycle, shared decode/surfaces and the
transport library's switching/probing path.

## Primary References

- [LiveKit JS encoding construction, 2.22.1](https://github.com/livekit/client-sdk-js/blob/v2.22.1/src/room/participant/publishUtils.ts)
- [LiveKit JS publishing layer activation, 2.22.1](https://github.com/livekit/client-sdk-js/blob/v2.22.1/src/room/track/LocalVideoTrack.ts)
- [LiveKit Dynacast quality aggregation, 1.13.6](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/dynacast/dynacastqualityvideo.go)
- [LiveKit activation/debounce, 1.13.6](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/dynacast/dynacastmanagervideo.go)
- [LiveKit default pause delay, 1.13.6](https://github.com/livekit/livekit/blob/v1.13.6/pkg/config/config.go)
- [LiveKit capacity probing design, 1.13.6](https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/ccutils/prober.go)
- [WebRTC active encoding semantics](https://www.w3.org/TR/webrtc/#dom-rtcrtpencodingparameters-active)
- [libvpx multi-resolution example](https://github.com/webmproject/libvpx/blob/main/examples/vp8_multi_resolution_encoder.c)
- [libvpx multi-encoder API](https://chromium.googlesource.com/webm/libvpx/+/master/vpx/vpx_encoder.h)
- [OpenH264 encoder API](https://github.com/cisco/openh264/blob/master/codec/api/wels/codec_app_def.h)
- [OpenH264 AVC simulcast release history](https://github.com/cisco/openh264/blob/master/RELEASES)
- [FFmpeg codec send/receive API](https://ffmpeg.org/doxygen/trunk/group__lavc__encdec.html)
- [Pion mediadevices codec boundary](https://github.com/pion/mediadevices)
- [GStreamer branch isolation](https://gstreamer.freedesktop.org/documentation/coreelements/tee.html)
- [GStreamer WebRTC consumer encoding](https://gstreamer.freedesktop.org/documentation/rswebrtc/index.html)

## 中文确认

核心是“只负责直属下游”：有合适编码就转发，缺少低档才由直属上级按需派生，
相同需求复用派生输出。不是 Host 为全树预编码所有档位，也不是每条弱边独立
编码。Host 同样遵守此规则。基准档、常用档的名字不能造成重复编码。

拓扑优化负责修复上游输入质量受限，局部媒体模块负责可用表示的派生、复用和
选择。稳定传输低画质不等于路径已经最优；现有优化不能直接视为已覆盖这种
恢复。当前先研究按需/预编码策略及成熟实现，尚未改动生产媒体或路由。

优先把 LiveKit 式“最高需求档及以下保持编码”与精确按需启用作为平等候选，
不预设后者更优；若常备低档成本小、切换更好，就选择更简单的策略。所有直属
下游都不需要高档时可以停掉高档输出，但不修改捕获或丢弃最好的输入来源。
先用已有 VP8 编码器短时测量成本和关键帧启停，不把结果外推成 H264 硬件或
真实网络验收。具体库、档位与启停时间仍未作为生产决策。
