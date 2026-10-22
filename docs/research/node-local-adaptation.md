# Node-Local Adaptive Encoded Reuse

Reviewed: 2026-09-07. This records the initial policy comparison.
[ADR-0013](../adr/0013-embedded-node-local-media.md) owns the accepted
direct-child model and highest-demand envelope;
[implementation evidence](./node-local-media-design.md) records the integrated
Native/SFU adapter and later recovery work.

## Agreed Model

ADR-0013 is the sole owner of the accepted direct-child model and policy. This
file retains evidence and alternative comparisons, not a second design contract.
The implementation design is owned by [node-local media design](./node-local-media-design.md).
`base/native` names the selected source quality; it is not a second output
alongside an identical `high` encoding.

## Two Workstreams

- Self-contained Piik Server: library-level STUN/media components inside the
  executable, not bundled external service processes or an automatic installer.
- Adaptive reuse: local derivation, shared lower outputs, independent child
  delivery and quality recovery, usable by Native App and the server.

These share media-source and lifetime concepts. A forwarding-only SFU library
supplies no transcoder; derivation needs decoding/encoding capacity. Pure Browser
peers can consume normal WebRTC outputs and benefit from capable upstreams,
but have no generic cross-PeerConnection encoded-forwarding API.

## Existing Building Blocks And Gaps

The initial `mediaedge.Source` supplied encoded Pion fanout, capture generations
and keyframe ownership, but no reusable derived-output pool. The later adapter
connects direct-child budgets to shared local outputs while retaining per-edge
transport. [Encoder-pool research](./webrtc-encoder-pool.md) records why each
output needs a complete adaptation pipeline.

Simulcast construction, encoder allocation, active encoding, layer forwarding
and bandwidth probing remain separate operations. Pausing a representation
does not mean destroying its codec or reopening capture. Healthy transport of
already-low input likewise does not establish that a better source is available.

## Open Choices

The initial choices were exact demand versus a highest-demand envelope, cold
versus retained codecs, and which component should own shared adaptation and
safe handoff. ADR-0013 selects the envelope for an already-needed group; the
current implementation shares complete adaptive outputs only across compatible
direct-child budgets. The comparisons below explain that choice.

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
  is an upstream implementation fact, not a proposed Piik timing constant.
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

The owner's 2026-09-07 preference led to comparing the LiveKit-style
maximum-demand envelope with exact activation on equal terms. The envelope
keeps the highest requested representation and lower fallbacks active, stopping
unused upper outputs when all direct children need less. Good network capacity
alone does not prove spare encoding capacity or cheap lower outputs.

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
| Existing Native encoders and generation/keyframe ownership | Platform encode paths already integrated with Piik | Received-source decode/scale and shared derived outputs still need design |
| LiveKit Dynacast, layer selector and prober sources | Reference for demand aggregation, safe switching and recovery probes | Apache-2.0 code; inspect imports/ownership before any extraction, not whole-service embedding |
| libvpx multi-resolution VP8 API/example | Multiple spatial encodes through one coordinated API; libvpx is already used | VP8-specific; no promise that H264 hardware sessions have the same cost curve |
| OpenH264 AVC simulcast API | Library H264 encode/decode and per-spatial-layer configuration | Software codec; inspect realtime cost and actual source/binary distribution terms before selection |
| FFmpeg `libavcodec` and frame/filter APIs | Embedded decoding, scaling and hardware/software encoding | A library option, not launching `ffmpeg`; build/license/size cost remains to compare |
| Pion mediadevices | Go codec-controller and raw-frame broadcast interface reference | Cgo/native codecs still exist; not a reason to replace the working capture adapters |
| GStreamer `tee`/queues and codec elements | Shared decode/frame flow and isolated output branches | `webrtcsink` currently encodes per consumer, so it does not directly solve shared derived output |

At this review, the inLive probe established forwarding only. Later derivation,
reuse and recovery results are in [the implementation record](./node-local-media-design.md).

## Focused Comparison Plan

Both component comparisons hold source, codec, cadence and child demand fixed.
The [Native VP8 probe](./node-local-encoding-probe.md) measures CPU work and
timestamp-sensitive warm-codec resume. The
[VP8/H264 decode probe](./node-local-browser-probe.md) adds scaling, two decoders
and received-source relay derivation. They separate codec lifecycle and
decode/scale costs from small representation bookkeeping.

Actual RTP switching, compatible weak-child sharing, independent recovery,
source replacement and retirement are recorded in the later implementation and
encoder-pool evidence. Physical platform limits remain in
[verification status](../verification-status.md).

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

直属上级转发已有合适编码，按需派生缺少的低档，并复用相同需求的输出。
本页保留初始策略比较；ADR-0013 已接受最高需求包络，后续实现与实测由链接文档承接。
