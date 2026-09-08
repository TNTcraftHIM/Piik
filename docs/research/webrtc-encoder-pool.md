# WebRTC Adaptation And Encoder Reuse

Reviewed: 2026-09-08. Source-backed review and synthetic VP8 feasibility probe,
not an accepted engine replacement. [ADR-0013](../adr/0013-embedded-node-local-media.md)
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
pool preserving every independent control decision is not established by the
factory API alone. The experiment below distinguishes that from a pool owning
the physical encoder's correction state.
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
This review copies no upstream implementation and adds no product dependency.
The opt-in probe links the pinned SDK only under the ignored build directory.

## Executed Feasibility Probe

The [opt-in source and build recipe](../../native/probes/encoder-pool/README.md)
use Shiguredo `m152.7977.0.2`, whose WebRTC revision exactly matches the pin
above. Its relevant vendor differences are disabled built-in H264 and disabled
pacer keyframe flushing; this VP8 encoder-only probe uses neither path.
Matching SDK headers/static library and official MSVC libraries/linker were
used. No desktop capture, ports, game, production service or CI job was involved.

Two actual VSEs receive one synthetic 640x360@30 source through separate stock
VideoAdapters. Both receive identical 2 Mbps budgets/feedback cadence; B alone
gets 100 kbps for 15 seconds and then returns to 2 Mbps for 25 seconds.
Degradation preference is maintain-framerate to expose spatial adaptation.
This supplies encoder budgets, not a simulated full GoogCC/packet network.
The driver drains queues between inputs, so it is not a throughput benchmark.

The factory starts with exact codec/rate compatibility and one cached access
unit per physical encoder. Different requests split, compatible streams rejoin
on a keyframe, and each VSE gets its own metadata/callback with shared payload.
Attempted input and successful reference identity are separate so a codec drop
is not submitted twice. RTT/loss are excluded only because the guarded realtime
VP8 L1T1 implementation's [DefaultTemporalLayers][vp8-default-temporal] ignores them.

Three forms were exercised, plus an explicit disabled-adjuster ablation:

| Form | Healthy 6-second physical Encode calls | Delivered frames per consumer | Result |
| --- | ---: | ---: | --- |
| Independent encoders, stock VSE correction | 360 | 180 / 180 | Control |
| Shared factory, separate unchanged VSE correction | 337 | 180 / 180 | Only 23 reuses; independent adjusted targets soon differ |
| Shared factory and one upstream corrector per physical encoder | 187 | 180 / 180 | 173 reuses, about 48% fewer calls in this phase |

Both VSEs can have the same 2 Mbps logical target but ask their encoder for
different corrected rates, such as about 1.67 versus 1.59 Mbps. The upstream
[EncoderBitrateAdjuster][bitrate-adjuster] observes encoded size/timing to
correct overshoot; it is not a resolution selector or a receiver-supplied QP.
Disabling it only for diagnosis restored healthy reuse, locating the conflict.
The viable probe form instead instantiates that same library class per physical
encoder and feeds each physical output once. It does not delete correction or
choose one peer as quality authority.

In the final paired full runs, both forms first reduced B at about 4.04 seconds,
reached 320x180, and first returned to 640x360 about 24.05 seconds after release.
A remained full-size at about 30 fps. The pooled form resumed shared output after
recovery and reused 87 frames in the following 3-second, single-skipped-input
phase. Both groups fully retired, with at most two live physical encoders.
Repeated earlier runs showed the same broad transitions. This does not promise
fast or seamless recovery: the measured upward delay was substantial in both.

Weak-phase delivery was not identical: the final control decoded 154 frames
(10.27 fps, 85.3 kbps), versus 142 (9.47 fps, 95.1 kbps) for the pooled form.
Splitting/rejoining also produces extra keyframes. Do not infer perceptual or
congested-network parity from matching dimensions and transition times.

WebRTC decoding checked usability; raw libvpx with postprocessing disabled
checked matching-payload reference correctness. The [stock VP8 decoder][vp8-decoder]
enables history-dependent MFQE on x64, so comparing its postprocessed pixels
after different histories produced one misleading mismatch during development.
The corrected final full pooled run compared 288 shared payloads with zero raw
pixel mismatches. Removing reference-continuity protection in a negative
control produced 29 mismatches despite successful decoder calls. The guard is
necessary, not decorative defensive code. [Structured results](./data/webrtc-encoder-pool.json)
contain no frame payloads or private identifiers.

### Verdict And Remaining Scope

- **An unchanged factory cache alone does not meet the goal.** Independent
  encoder-side correction fragments otherwise equal nominal demands.
- **The shared-encoder abstraction passes a narrow executable feasibility
  check when physical correction state shares that owner.** It reuses real
  encoding, retains stock spatial adaptation and can split/rejoin safely in
  this VP8 case. No engine replacement has been selected or integrated.
- The group invokes correction on actual frames, with rate-write deduplication;
  stock VSE does so on rate/configuration/FPS updates. The algorithm is reused,
  but this cadence change must not be described as an otherwise identical move.
- Default VP8 trusts its rate controller, so pre-encoder media-optimization
  dropping is inactive here. Other encoders need the corresponding drop feedback:
  it is outside VideoEncoder's callbacks. Codec drops must not impersonate it.
- Per-VSE encode timing still differs for a physical encode and a cache hit.
  H264 hardware/asynchronous execution, actual resource overload, transport
  overhead, received-source bypass and perceptual parity remain unverified.
  These are integration gates, not reasons to disable mature adaptation.

The reusable boundary is an encoding instance plus its encoder-side state, not
just `Encode(frame)`. Before product replacement, resolve those remaining
feedback owners through upstream interfaces; do not accumulate quality formulas
or silently reintroduce per-child encoders as the ordinary product model.

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

## Integration Gates

1. Reuse the now-executed native VSE/VP8 boundary; do not repeat a mock-only
   factory probe or fetch a second full engine to show buffer reuse. Validate
   hardware H264 and physical-resource feedback with the existing capture adapter.
2. Measure source replacement, overload, real scheduling, perceptual quality,
   transport overhead and actual CPU/GPU cost. Preserve correction/drop/resource
   feedback with explicit owners before accepting the product integration.
3. Prove the received-encoding bypass and fresh lower derivation can use the
   same representation owner before planning integration. If preserving stock
   control requires substantial VSE/source patches or a custom rate/quality
   policy, report that cost instead of calling it a small factory adapter.
4. The narrow pass permits an isolated implementation candidate, not release
   approval. Select the integration through an ADR refinement after resolving
   the remaining owners. Preserve the current candidate; never merge it solely
   to manufacture a new branch base. Follow
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
[bitrate-adjuster]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/encoder_bitrate_adjuster.cc
[vp8-default-temporal]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/video_coding/codecs/vp8/default_temporal_layers.cc
[vp8-decoder]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/video_coding/codecs/vp8/libvpx_vp8_decoder.cc
[epic-migration]: https://github.com/EpicGames/PixelStreamingInfrastructure/blob/f826b19279ef5a8401341bc046129f1726999db2/Docs/pixel-streaming-2-migration-guide.md#L319
[epic-settings]: https://github.com/EpicGames/PixelStreamingInfrastructure/blob/f826b19279ef5a8401341bc046129f1726999db2/Frontend/Docs/Settings%20Panel.md
[webrtc-build]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/docs/native-code/development/README.md
