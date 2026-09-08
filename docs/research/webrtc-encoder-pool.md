# WebRTC Adaptation And Encoder Reuse

Reviewed: 2026-09-08. Source-backed feasibility review, not an accepted engine
replacement or a measured encoder-pool implementation. [ADR-0013](../adr/0013-embedded-node-local-media.md)
still owns the direct-child/shared-output model; [TODO](../todo.md) owns work and
the dependent release hold. The question is whether retaining mature encoder
control while sharing compatible encoding work is smaller and more complete
than extending the current Native fixed-output candidate.

## Pinned Baseline

The installed Chrome is 152.0.7977.82. Its [DEPS][chromium-deps] pins libwebrtc
to `6f37672d358475cd17544121a12494da454d85fb`; WebRTC references below use that
revision, not a floating upstream branch. Source shows available mechanisms,
not which field trials or hardware encoder a particular runtime selected.
The Screener comparison uses the `3c192ddd` candidate, not production.

## Actual Control Ownership

```text
receiver transport feedback
  -> GoogCC: network target, pacing, probes, congestion-window updates
  -> Call / BitrateAllocator: per-media allocation
  -> RtpVideoSender: transport, RTP, packetization and NACK/FEC costs
  -> VideoStreamEncoder: layer rates and encoder feedback
  -> VideoEncoder: encode, SetRates, encoded callback
  -> RTP packetization / pacer -> network

encoded QP, bytes, drops and completion timing
  -> quality/bandwidth scaler and encode-usage resource
  -> ResourceAdaptationProcessor / VideoStreamAdapter
  -> source pixel/FPS restrictions -> adapted input / encoder reconfiguration
```

These are connected but different owners:

| Owner | What it actually decides |
| --- | --- |
| [Transport controller][transport] / GoogCC | Estimates network capacity and drives pacing/probing, not a pixel-size ladder. |
| [RtpVideoSender][rtp-budget] | Computes the video payload budget after transport and protection costs. Network BWE is not the encoder's payload target. |
| [SimulcastRateAllocator][simulcast-rates] | Allocates among configured layers with activation minima/hysteresis and temporal rates. It does not derive their dimensions from BWE. |
| [VideoStreamEncoder][vse] | Applies target/adjusted rates, optional overshoot correction, queue/frame dropping and encoded feedback. One instance has one resource-adaptation chain, not one complete controller per RID. |
| [Resource manager][resources] | Uses trusted QP and drops, or eligible bandwidth-quality scaling, plus encode-time pressure. These paths depend on actual encoder capabilities and configuration. |
| [VideoStreamAdapter][video-adapter] | Requests fewer pixels or FPS according to degradation preference and resource constraints; a pre-encoded fixed tier is not required. |

For example, the adapter can request at most 3/5 of the current pixel count or
reduce FPS to 2/3 under the corresponding preference. These are upstream rules,
not proposed Screener constants. The default [encoder minimum][encoder-api] is
320x180 pixels and can be overridden; no universal 108p floor is established.
VP8's [libvpx adapter][vp8] disables libvpx internal resizing because WebRTC owns
that work outside the codec. Turning on libvpx resizing alone does not restore
the omitted control chain.

### Motion And Simulcast Are Not Synonyms

Screener's `motion` hint becomes `kFluid` in the [Chromium sink][chromium-hint].
[VideoRtpSender][sender-hint] then sets `is_screencast=false`; this follows the
realtime-video path even for display capture. Explicit degradation preference
still has precedence over the hint's default. Do not assume all display capture
uses WebRTC's special screen-content policy.

At this pin, the [media engine][media-engine] permits its automatic quality
resizing path only when eligible and there is one configured SSRC or one active
stream. Multiple active simulcast outputs therefore do not each acquire an
independent version of that resizing path. The [simulcast encoder adapter][simulcast-encoder]
coordinates per-output codecs, rates, scaling and keyframes; it is not a pool
across independent PeerConnections. Adding a third preset cannot establish parity.

## The Current Native Gap

`nativecapture.ScreenShareOutputs` constructs original plus half-size outputs
at the same FPS. `mediaedge.Source.BeginFrame` chooses activation and lowers the
lowest encoder's bitrate from its consumers' budgets. Windows `OutputWorker`
keeps one fixed profile for its lifetime. At 1080p the lowest nominal output is
960x540, not a dynamically shrinking fallback. Bounded raw mailboxes isolate
overload but do not automatically reduce the requested encoding work.

Pion supplies transport; LiveKit media components supply BWE, forwarding,
allocation, recovery and pacing. They do not supply the omitted libwebrtc raw
source/encoder resource-adaptation chain. The current source-RTP cost adjustment
also is not the full `RtpVideoSender` overhead/protection calculation. These are
concrete missing integrations, not evidence that either library is defective.
The existing constrained-codec recovery evidence remains valid within its scope,
but cannot establish Browser-equivalent behavior below the fixed lowest size.

## Where A Pool Can Fit

[VideoEncoderFactory][encoder-factory] is a real native injection point. Its
`Create(env, format)` returns a `VideoEncoder`; it is not exposed by Browser JS
and does not receive a source/stream identifier. A source-scoped integration
must establish that identity without guessing from dimensions or timestamps.
Pion currently has no libwebrtc encoder factory to override: retaining the full
chain requires a native-library integration decision, not only a new Go cache.

Shared encoded payload buffers are supported by [EncodedImage][encoded-image].
That makes payload reuse possible, not automatically correct. The narrow
adapter would have to preserve all of the following:

1. **Compatible demands.** Codec/profile, source generation, dimensions,
   cadence, rate allocation and reference state must agree. `SetRates` applies
   until replaced; last-writer-wins, unconditional minimum, or unconditional
   maximum would violate another consumer's quality or budget. Resolution-only
   keys are insufficient. Exact compatibility may produce little reuse and
   needs measurement before introducing any grouping heuristic.
2. **Compatible frame dependencies.** Each VSE can drop different inputs before
   calling `Encode`. If A encoded frame F but B skipped it, a later shared
   interframe may reference F that B never received. Skipping a whole input is
   not equivalent to ordinary packet loss that NACK can repair. Splitting and
   rejoining must use codec-safe recovery, not arbitrary callback suppression.
3. **Separate callback ownership.** Each virtual encoder owns initialization,
   keyframe requests, release and its callback. Reuse immutable payload bytes,
   not one mutable metadata object. Preserve each caller's RTP/input identity,
   codec descriptors, QP and completion semantics.
4. **Honest resource feedback.** [Frame metadata][frame-metadata] matches the
   caller's timestamp and measures its encode-start/completion interval. A cache
   hit can appear cheap despite a busy shared physical encoder. Validate the
   resulting resource decisions; do not fabricate CPU/QP evidence to keep reuse.
5. **Unadapted source availability.** [VideoBroadcaster][broadcaster] aggregates
   minimum maximum-pixel/FPS restrictions across sinks; requested-resolution
   aggregation is a separate path. A pool cannot recreate input detail already
   removed upstream. Retain original capture and validate sibling isolation.

Therefore the owner's abstraction is useful, but a transparent cross-sender
pool preserving every independent control decision is not yet demonstrated.
Per-node encoding cost follows the number of compatible active representations,
not automatically a fixed three encodes regardless of downstream conditions.
Already-encoded Native relay/SFU forwarding must remain zero-encode when usable;
an encoder factory by itself does not implement that bypass.

## Mature Precedent And Reuse

Epic's [Pixel Streaming 2 migration guide][epic-migration] records removal of
its former one-stream/one-quality-controller sharing because of stalls and
freezes, recommending per-peer encoding or its SFU. The older
[settings guide][epic-settings] explicitly describes mismatched client quality
under that design. This is a warning against selecting one peer's conditions
for everyone, not proof that a compatible-output pool cannot work.

Reuse upstream encoder factories, codec adapters, simulcast allocation,
resource adaptation and projection where their contracts fit. No reviewed
source supplies a production-ready pool with all five obligations above.
The WebRTC [test proxy factory][test-proxy] simply delegates to one encoder;
it supplies no callback/rate arbitration or frame deduplication. An embedded
forwarding SFU should keep the current mature forwarding components; it normally does not
encode, so sharing representations/demand is the common boundary, not forcing
every SFU subscriber through a codec factory.

The libwebrtc [build guide][webrtc-build] describes a native GN/Ninja dependency
build. Its headers are not a stable Go plug-in ABI. Evaluate reproducible build,
update and package cost before replacing the Native media engine. WebRTC code
retains its BSD-style license and PATENTS grant, dependencies their own notices.
Epic's infrastructure MIT license does not license Unreal Engine/EpicRtc code.
This review copies no upstream implementation and adds no dependency.

## Replacement And Preservation Map

| Current owner | Treatment if a pool-backed engine is proved |
| --- | --- |
| Go room/controller, embedded STUN, SFU service lifecycle | Preserve. A codec experiment does not alter authority, NAT policy or single-operation routing. |
| LiveKit forwarding/BWE/projection and Pion transport | Keep for existing encoded forwarding. Replace a Native endpoint owner only if the new library actually assumes that responsibility; never run two controllers on one edge. |
| Native output construction, `Source.BeginFrame`, codec workers | Review together against the replacement's capabilities. Remove superseded activation, rate and switching policy in the same integration, not through a permanent legacy path. |
| Native profile handoff, source clock, bounded queues and retirement | Preserve their verified behavior even if their implementation moves. Do not lose the profile-install acknowledgement or reintroduce double FPS limiting. |
| Client sessions, Global Link, UI, diagnostics and packaging | Outside an encoder-policy replacement. Preserve the separately useful fixes/enhancements recorded in TODO and Git. |

An engine migration must also retain direct Native SFU publication, independent
Native room sessions, native ICE improvements and mixed Browser/Client relay.
Changing transport libraries does not automatically preserve these APIs. No
unrelated page rewrite or platform-adapter deletion is justified by this review.

## Bounded Next Experiment

1. Establish a reproducible native libwebrtc dependency and the smallest
   source/encoder adapter without modifying product transport. First verify the
   actual injection surface and build cost. Do not download/build a whole engine
   merely to demonstrate shared immutable buffers.
2. Use one synthetic source and two real `VideoStreamEncoder` instances with
   stock resource adaptation active, first VP8 then the H264 hardware adapter.
   Compare independent encoding with a pool behind their encoder factory.
   Calling only `VideoEncoder::Encode/SetRates` cannot validate the surrounding
   adaptation. This is a correctness control, not reopening Browser-only product
   fanout or choosing per-child product encoders.
3. Exercise two healthy consumers, divergent rates, one pre-encoder skipped
   frame, keyframe/split/rejoin, source replacement, overload and stop. Require
   actual decoding, preserved healthy quality, lower-quality recovery and
   retirement. Record physical encode count, latency, bytes/copies and CPU/GPU
   cost; equal dimensions or successful callbacks are insufficient.
4. Prove the received-encoding bypass and fresh lower derivation can use the
   same representation owner before planning integration. If preserving stock
   control requires substantial VSE/source patches or a custom rate/quality
   policy, report that cost instead of calling it a small factory adapter.
5. Only a passing boundary justifies an isolated implementation worktree and
   an ADR refinement selecting the library/integration. Preserve the current
   candidate; never merge it solely to manufacture a new branch base. Follow
   the stable executable paths and serialized physical workload rules in
   CONTRIBUTING. CS2 and Win10 reports remain separate, unresolved acceptance.

[chromium-deps]: https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.82/DEPS
[chromium-hint]: https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.82/third_party/blink/renderer/modules/peerconnection/media_stream_video_webrtc_sink.cc
[transport]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/call/rtp_transport_controller_send.cc
[rtp-budget]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/call/rtp_video_sender.cc
[simulcast-rates]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/video_coding/utility/simulcast_rate_allocator.cc
[vse]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/video_stream_encoder.cc
[resources]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/adaptation/video_stream_encoder_resource_manager.cc
[video-adapter]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/call/adaptation/video_stream_adapter.cc
[vp8]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/video_coding/codecs/vp8/libvpx_vp8_encoder.cc
[sender-hint]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/pc/rtp_sender.cc
[media-engine]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/media/engine/webrtc_video_engine.cc
[simulcast-encoder]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/media/engine/simulcast_encoder_adapter.cc
[encoder-factory]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/api/video_codecs/video_encoder_factory.h
[encoder-api]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/api/video_codecs/video_encoder.h
[encoded-image]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/api/video/encoded_image.h
[frame-metadata]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/frame_encode_metadata_writer.cc
[broadcaster]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/api/video/video_broadcaster.cc
[test-proxy]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/test/video_encoder_proxy_factory.h
[epic-migration]: https://github.com/EpicGames/PixelStreamingInfrastructure/blob/f826b19279ef5a8401341bc046129f1726999db2/Docs/pixel-streaming-2-migration-guide.md#L319
[epic-settings]: https://github.com/EpicGames/PixelStreamingInfrastructure/blob/f826b19279ef5a8401341bc046129f1726999db2/Frontend/Docs/Settings%20Panel.md
[webrtc-build]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/docs/native-code/development/README.md
