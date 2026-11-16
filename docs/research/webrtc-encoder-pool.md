# WebRTC Adaptation And Encoder Reuse

The [network model](./channel-network-design.md#implementation-boundary) owns
current 3.0 behavior. The first sections record Rust representation boundaries
and measured worker behavior. The [pinned libwebrtc review](#pinned-baseline) and Pion/LiveKit controls describe
2.x C++/Go work under [ADR-0013](../adr/0013-embedded-node-local-media.md).
[H264 burst and recovery](#h264-burst-and-recovery) also contains explicitly
labeled Rust controls; implementation generations must be read separately.

## 3.0 H264 Profile Compatibility

The [network model](./channel-network-design.md#implementation-boundary) owns routing,
source lifetime and automatic adaptation. This section owns the profile and
representation extension; it does not expand support to other codec families.

OBS initializes its selected encoder before connecting. Its WHIP adapter calls
`addH264Codec` without the encoder's profile, then applies the SDP answer to its
transport without reconfiguring that encoder. A Baseline answer therefore cannot
make an existing High encoder produce Baseline. The complete input SPS supplies
the actual encoded format. [OBS 33.0.1 source](https://github.com/obsproject/obs-studio/blob/33.0.1/plugins/obs-webrtc/whip-output.cpp)
owns that upstream behavior.

Current local input accepts 8-bit 4:2:0 H264 Baseline, Main and High, not
High 10. Windows uses the [Media Foundation H264 decoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-decoder)
with NV12 output; its supported profiles do not include High 10. OBS NVENC can
[force High 10 for P010 input](https://github.com/obsproject/obs-studio/blob/33.0.1/plugins/obs-nvenc/nvenc.c#L458),
even when another profile was selected. Stop streaming, select NV12 (8-bit 4:2:0)
in OBS Advanced video settings and H264 Baseline, Main or High in streaming output,
then restart. Automatic compatibility covers supported 8-bit profiles; the WHIP
answer cannot downgrade a running High 10 encoder.

Each complete-AU representation owns its actual codec/profile. The source exposes
its original representation; each output retains its negotiated formats and
payload mappings. Incoming SDP, expected encoding eligibility, actual SPS and
downstream capabilities remain separate facts. The expected encoder format admits
an encoding attempt; the produced H264 SPS establishes that feed's actual format.
Reuse str0m's `CodecConfig::match_params` for H264 profile and
packetization matching. A matching receiver gets the original bytes; a required
compatible representation uses the existing decoder and encoder pool. Every
output sends the payload type matching the representation it actually selected.
Profile changes never relabel queued frames. Existing keyframe adoption, source
clocks, failure isolation and joined resource retirement remain the boundary.

This follows [mediasoup's producer/consumer codec matching](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/)
and [LiveKit's separation of WHIP forwarding and transcoding](https://docs.livekit.io/transport/media/ingress-egress/ingress/transcode/).
Codec negotiation does not perform conversion. Piik retains its platform encoder
adapters and actual runtime capability/failure results within the existing
transport graph.

An ordinary Native peer connection without H264 derivation negotiates the common
Constrained Baseline representation. A capable upstream App therefore converts
before the source enters a forwarding-only Server or Native transit node. This
keeps conversion with a source owner that can provide the compatible output.
Isolated local OBS input retains the full supported input profiles.
The current SDK config applies in both directions, so those connections negotiate
Constrained Baseline for both reception and forwarding.

Forwarding cost, configured quality limits and the encoder's current allocation
have different owners. Observed input bitrate is the cost of those original
bytes, not a maximum for a compatible encoding. The publication's explicit
`VideoSettings` remains the quality authority; absent external settings remain
absent. Required conversion retains a finite transport allocation even when the
original's cost would fit. The existing SDK startup value seeds a required
encoder before feedback and is never reported as measured capacity.

Allocation retains relative weights and selected-before-optional admission. Capped
relative redistribution follows [libwebrtc's allocator](https://webrtc.googlesource.com/src/+/c8e422dde9fd36e50fd8ca3e4267cf05a2b49852/call/bitrate_allocator.cc):
ordinary forwarding retains its observed-cost cap; a required conversion uses
only an explicit configured ceiling, when present, and otherwise the available
connection allocation.

### Proposed Codec Interoperability Boundary

Design proposal; additional codecs and conversion dependencies are not selected.
Prefer compatible output at the sender and reuse encoded data before considering
conversion. Extend the existing owners rather than adding a general adaptation
manager.

| Existing owner | Responsibility |
| --- | --- |
| Source adapter | User intent, actual input format and whether the sender can select another format before encoding |
| RTC transport and Output | Negotiated receive formats, payload mapping and the SDK's network allocation |
| Video and Layers | The format of each actual encoded representation and its reusable access units |
| Frames and Encodings | Source-frame reuse and the outputs needed by existing consumer demands |
| Decoder and encoding worker | Supported concrete configurations, execution, failure and joined retirement |
| WatchMedia and its Browser player | Container playback and local decoding of an online source's original bytes |

Codec family, bit depth, profile, packetization and colour are distinct format
properties. A sender's declaration, a local encoder's availability and a
receiver's successful playback are different facts. Keep each capability at the
operation that consumes it; a global codec-support boolean cannot represent them.

Use the original compatible representation or an already available source layer.
For a configurable source, prefer selecting a compatible representation before
encoding. For an unsupported new codec family or bit depth, expose the format
and required action when neither is possible. New conversion paths require
separate acceptance and measured resource cost. They extend the existing
supported 8-bit H264 profile conversion's ownership: decode once, share
Frames, and retain each output's quality allocation and encoding lifetime.
Compatible outputs continue to reuse encoded data.

Stock OBS cannot be reconfigured by a WHIP answer today. Its public
[preferred video format API](https://docs.obsproject.com/reference-encoders#c.obs_encoder_set_preferred_video_format)
offers a possible sender-side path: convert raw input for the streaming encoder,
then encode once. It also needs a compatible encoder profile and must preserve
independent recording and explicit user format choices. Correct SDP advertisement
and automatic encoder selection are separate upstream changes. Respect WHIP's
[non-ICE renegotiation boundary](https://www.rfc-editor.org/rfc/rfc9725.html#section-4.3.3).

The current Native derivation path couples its input and output codec. A future
cross-codec feature should separate those parameters at the existing
`Decoding`/`Encodings` boundary, then validate one concrete input/output combination.
It does not require a new source registry or a second scheduler. Hardware/software
execution recovery stays with the encoding worker; congestion control stays with
the RTC SDK. Original-byte website playback does not imply Native RTP, decoding
or encoding support for that codec. P010-to-NV12 conversion alone is not HDR
tone mapping.

An isolated Windows AV1 control on 2026-11-16 used adapter-bound hardware
[MFTEnum2](https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mftenum2)
enumeration, activation and real NV12 GPU samples. One 1080p60, Main 8-bit 4:2:0
configuration produced 180 AUs over three seconds; an independent libaom software
decoder recovered all 180 pictures with unchanged timestamps. Output averaged
5.884 Mbps for a 6 Mbps request. Submission-to-readout p95 was 4.283 ms, including
the helper's polling and output handling. This proves that hardware configuration, not product codec admission,
mixed-capability forwarding, end-to-end latency or codec efficiency.

### Rust Worker Cadence Control

On 2026-11-14, the current Rust Windows worker path was exercised with owned
640 × 360 textures, H264 at 4 Mbps and a real 120 fps producer for five seconds
per mode. Auto and Software each delivered 120 frames in every second after
their initial worker startup; neither recorded budget drops. Hardware
input-to-output latency was 0.67/2.19 ms at p50/p95. Software encoding took
0.46/0.64 ms, separately from its GPU-dependent readback wait of 0.43/1.08 ms.
These are different stage measurements, not an encoder speed ranking.

A further current-source control used synthetic text and moving blocks at
1920 × 1080, 30 fps and 6 Mbps through the complete Rust texture/child-worker
path, for five seconds per mode. Auto/Software returned 136/143 encoded AUs from
150 input frames: startup reduced first-second delivery to 16/23; each remaining second
delivered 30, with no budget drops. Encoding p95 was 2.77/2.48 ms; Software's
GPU-dependent readback added a separately measured 0.90 ms p95. Child-process
CPU totals were 609/1859 ms including initialization and shutdown, not steady
CPU percentages. Conversion timings measure CPU submission, not GPU completion;
Software encoding includes its owned NV12 copy. These instrumented debug runs
measure encoded output, without decoding or network delivery, and establish
short-run cadence rather than endurance or a compression-quality ranking.

Both workers joined on exit. This establishes no fixed 60 fps limit in that
low-load encoding path; it does not measure WGC, high-resolution games, GPU
saturation or automatic hardware/software switching.

A later owned Windows control separately delayed the GPU-copy handoff,
encoder-adapter service and consumption of completed AUs. Raw-frame credit gaps
and low output cadence appeared in all three, so neither identifies encoding
pressure. Hardware input acceptance to observed HaveOutput delivery stayed near
2–3 ms: the delay was injected in the adapter, not reproduced GPU contention.
Stage timing must separate capture/copy, codec service and downstream waiting.
Software benefit requires comparing complete input-to-AU delivery under the same
contention, including its GPU readback and CPU work. These controls leave the
explicit Software choice and typed E_FAIL recovery unchanged.

## Pinned Baseline

The initial review used Chrome 152.0.7977.82. Its [DEPS][chromium-deps] pins libwebrtc
to `6f37672d358475cd17544121a12494da454d85fb`; WebRTC references below use that
revision, not a floating upstream branch. Source shows available mechanisms,
not which field trials or hardware encoder a particular runtime selected.
The initial Piik comparison used the `3c192ddd` candidate, not production.

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
not proposed Piik constants. The default [encoder minimum][encoder-api] is
320x180 pixels and can be overridden; no universal 108p floor is established.
VP8's [libvpx adapter][vp8] disables libvpx internal resizing because WebRTC owns
that work outside the codec. Turning on libvpx resizing alone does not restore
the omitted control chain.

### Motion And Simulcast Are Not Synonyms

Piik's `motion` hint becomes `kFluid` in the [Chromium sink][chromium-hint].
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

## Fixed-Output Native Gap (2026-09-08)

The initial 2.x candidate exposed original plus half-size outputs at the same
FPS (960x540 minimum at 1080p). Budgets changed bitrate but not dimensions/FPS.
Pion transport and LiveKit forwarding did not provide the missing raw-source
resource-adaptation chain or full RTP overhead calculation. This integration
gap motivated the complete-pipeline attachment below; bounded mailboxes alone
could not establish Browser adaptation parity.

## Where A Pool Can Fit

[VideoEncoderFactory][encoder-factory] is a native injection point: its
`Create(env, format)` returns a VideoEncoder without a source identifier. Browser
JS does not expose it, and Pion has no libwebrtc factory to override. Source
identity cannot be guessed from dimensions or timestamps; a full-chain native
integration remains a dependency decision, not a Go cache.

[EncodedImage][encoded-image] permits shared immutable payloads. Correct reuse
still requires five independently owned contracts:

1. **Demand compatibility:** source generation, codec/profile, dimensions,
   cadence, rate allocation and reference state must agree. SetRates persists;
   last-writer/minimum/maximum arbitration and resolution-only keys are wrong.
   Exact compatibility may yield little reuse; measure before adding heuristics.
2. **Reference continuity:** independent VSE drops can omit a reference from one
   consumer. A skipped whole input is not packet loss NACK can repair; split and
   rejoin need codec-safe recovery rather than callback suppression.
3. **Callback ownership:** each virtual encoder retains initialization,
   keyframe requests, release, RTP/input identity, codec descriptors and QP.
   Share payload bytes, not mutable metadata.
4. **Honest resource feedback:** [frame metadata][frame-metadata] matches each
   caller's timestamp and encode interval. Cheap cache hits do not describe a
   busy physical encoder; do not fabricate CPU/QP feedback.
5. **Original input availability:** [VideoBroadcaster][broadcaster] combines
   maximum-pixel/FPS restrictions separately from requested-resolution policy.
   Detail removed upstream cannot be recreated; preserve sibling isolation.

Per-node encode cost follows compatible active representations, not a fixed
three encodes. Usable received Native/SFU representations must bypass encoding;
an encoder factory alone cannot supply that bypass.

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

The libwebrtc [build guide][webrtc-build] requires a native GN/Ninja build;
its headers are not a stable Go plug-in ABI. Build/update/package costs and
BSD/PATENTS/dependency notices remain part of any integration decision.
Epic's infrastructure MIT license does not cover Unreal Engine/EpicRtc.

## Executed Feasibility Probe

The [archived 2.x recipe](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/native/probes/encoder-pool/README.md)
used Shiguredo m152.7977.0.2 and two VSEs/VideoAdapters at 640x360@30, 2 Mbps.
One consumer received 100 kbps for 15 seconds, then 2 Mbps for 25. Input queues
were drained between frames: this tested externally supplied budgets, not GoogCC
or throughput. VP8 L1T1 [DefaultTemporalLayers][vp8-default-temporal] ignores the
RTT/loss inputs omitted by this control.

| Form | Physical Encode calls in six healthy seconds | Frames per consumer |
| --- | ---: | ---: |
| Independent encoders, stock correction | 360 | 180 / 180 |
| Shared factory, independent VSE correction | 337 | 180 / 180 |
| Shared factory, one upstream corrector per physical encoder | 187 | 180 / 180 |

Independent [EncoderBitrateAdjuster][bitrate-adjuster] targets diverged despite
equal nominal rates (~1.67/1.59 Mbps), fragmenting reuse. One corrector per physical
output preserved the library policy and reused about 48% of healthy calls.
The bounded AU cache split incompatible demands and rejoined at keyframes.
Both paired runs reduced the weak child to 320x180 and restored 640x360 about
24 seconds after release; the healthy child retained full size/~30 fps. Weak
delivery differed (10.27 versus 9.47 fps), so matching dimensions did not prove parity.

WebRTC checked decode usability; raw libvpx without the [stock decoder][vp8-decoder]'s
history-dependent MFQE checked reference correctness. Of 288 shared payloads,
none mismatched; removing reference protection produced 29 mismatches despite
successful decoding. [Structured results](./data/webrtc-encoder-pool.json) retain
the counters without media.

### Verdict And Remaining Scope

A factory cache alone was insufficient. Sharing correction and reference state
passed the narrow VP8 controls, but the corrector's frame-driven cadence and
cache-hit resource timing still differed from VSE. Trusted VP8 disabled
pre-encoder media-optimization dropping here; other codecs cannot substitute
codec drops for that feedback. Hardware, overload, transport overhead,
received-source bypass and perceptual parity required separate controls.

## Cross-Level Reuse

The 2.x mediaedge.Source separates received encoded RTP forwarding from complete
locally encoded outputs. Reuse belongs behind the latter boundary:

```text
received original -> existing per-child RTP forwarding -> healthy descendants
                 -> missing direct-child output only
                    -> one real decode -> VSE / shared physical encoder
                                      -> Source.WriteVideo -> child transport
```

A five-Pion-connection replay delivered byte-identical VP8 AUs at the Host and
two relay levels, without relay derivation. Prerecorded input could not answer
live PLI, so it did not measure capture/join latency or loss recovery.
Separately, the Native fixture forwarded 640x360 original plus 320x180 derived
output, shared one process between two compatible consumers, retained it after
one left and stopped it after the last. Those were forced budgets, not automatic
network selection. [Evidence](./data/webrtc-encoder-chain.json) records both
boundaries; they were not a connected VSE derivation integration.

One encoding for a tree requires one active representation and Native/SFU
intermediates. Browser intermediates still encode; leaves only decode. Include
lower standby encodes and split/rejoin work in cost comparisons.

## Scheduling And Resource Follow-Up

A realtime control delivered 180 frames to each healthy receiver using 180
physical encodes, with zero decoded hash mismatch. A separate control added
45 ms service delay per 640x360 VP8 encode, scaled with pixel area; this was
adapter delay, not CPU/GPU saturation.

| Ownership under delay | Decoded frames A/B in 30s | Churn |
| --- | --- | --- |
| Shared codec, separate VSEs | 391 / 378 | 146 / 149 keyframes; 115 groups, 218 changes |
| Complete shared VSE/source-adaptation/codec pipeline | 484 / 484 | No delayed-phase split/rejoin; three configuration instances overall |

Both arms recovered ~30 fps after release; neither reduced picture size until
afterward. [Traces](./data/webrtc-encoder-latency.json) support complete-pipeline
ownership over cache churn, not overload parity. Pinned VSE has no public removal
counterpart to AddAdaptationResource: repeated registration can retain
restrictions until Stop. Sharing must preserve honest physical-work feedback.

### Hardware H264 Adapter Check

The 2.x capture executable and probe reused the same
[LiveEncoder/MFT implementation](https://github.com/TNTcraftHIM/Piik/blob/72ca6f2bc97df88e216a392721250309aa53bc39/native/capture/windows/h264_encoder.cpp).
One stock VSE owned rates, dropping and resources; its adapter retained timestamps
and immutable payloads, applied Chromium's [FPS compensation][chromium-mf], and
paused at zero budget. The [codec initializer][codec-initializer] supplied H264
single-temporal-layer defaults. The probe's CPU I420→NV12/upload was not zero-copy.

At 640x360@30, six seconds yielded 174 byte-identical AUs per consumer; removing
one consumer left the other receiving 60 more frames before final retirement.
Independent Chrome WebCodecs checks validated 180 exported AUs, including six
after that retirement, not 180 received by both consumers. [Results](./data/webrtc-h264-pipeline.json)
establish this adapter/lifetime boundary only. Product attachment retained the
existing D3D converter and owned decoded NV12, removing the probe CPU round-trip.

### Windows Product Attachment

The 2.x `OutputWorker` uses one complete stock VSE/VideoAdapter per shared local
output, for both WGC and encoded-input derivation. The original capture, bounded
mailbox, generation checks and cancellable pipe writer remain. H264 receives
same-device NV12 directly; stock VP8 uses I420 readback. The returned AU retains
its exact input timestamp rather than rounding it through WebRTC microseconds.
The source publishes adapted dimensions through an immutable metadata snapshot;
calling LiveKit's full track-info update for each size change would reset every
active layer's bitrate tracker and was rejected by a focused regression.

The 2.x build links the pinned SDK's libvpx rather than a second build;
the roughly 8 MB Windows helper imports system DLLs and retains SDK notices.
The packaged synthetic adapt/recover fixture kept ordered output for VP8 and
H264. H264 needed two concrete integration corrections:

- Allow VSE's H264 QP parser and upstream 24/37 thresholds instead of declaring
  all hardware QP untrusted and selecting the bandwidth-quality scaler.
- Remove the one-frame VBV override. Mean-bitrate updates alone left output at
  about 118 kbps after restoration; dynamic VBV updates failed driver readback.
  Removing the override restored about 1.9 Mbps while retaining CBR/low latency.

Parsed QP recovery did not imply immediate resolution recovery: a 76-second
control restored 640x360 about 29–34 seconds after budget release because the
upstream low-QP smoother remained above its upscale threshold. No reset or new
timer forced recovery. Intel-specific QP behavior and actual overload remain
hardware-evidence limits.

#### H264 Burst And Recovery

Windows H264 scene changes expose encoded-burst and recovery tradeoffs. These
controls retain their generation, workload and measurement boundaries:

| Control | Result and decision |
| --- | --- |
| 2026-11-03, 2.x normal Host approval/clicks/capture/presentation, 826×612 at 5 Mbps/30 fps | Six 170–181 KB AUs, Recovery=false; 154–168 ms admission→dequeue, no segmented synchronous write >5 ms; five-click input→compositor median 235.1 ms. |
| Same settings, Pion H264 reader/source/wire inspection with SEI included | Six 172–182 KB AUs each had one type-1 non-IDR VCL; AUD/prefix/start codes totaled 19 bytes, no SEI or trailing padding. All 139 markers matched source AUs; queue 155–170 ms. Coded picture data is not removable filler; NAL type and Recovery flag do not identify slice type. |
| One-frame [HRD buffer](https://learn.microsoft.com/en-us/windows/win32/directshow/avenccommonbuffersize-property), initialized/live-updated in bytes | Largest AU 38 KB, median 54.5 ms and matching sampled colours, but the existing 76-second 2 Mbps→100 kbps→2 Mbps fixture stayed 320×180/~120–124 kbps with no full-size recovery. Rejected/removed, not applied to Rust MF. |
| 2026-11-04 Rust normal App, same owned 826×612 window/ceiling, twelve changes each | Existing MF median 274 ms paint→presentation; optional LowLatencyMode 259 ms, maxima 333/360 ms. Combined path, not stage attribution or exact AU sizes from receive counters. |
| Same-SDK Rust WGC/encoder/transport, only LowLatencyMode changed, 8 Mbps→600 kbps→8 Mbps plus healthy connection | Without request, both weak feeds stayed Original from 3–4 s after restoration; with request one remained Limited at 20 s. Its allocation matched transport feedback, so this does not prove an MFT defect. No clear presentation benefit or restoration pass; request removed. |

Restored settings gave 260 ms paint→last-packet median and 4.9 ms receive→composition
over twelve changes. A separate metadata-only build uniquely matched twelve
presented RTP timestamps across capture/encoder/IPC/sender: MF input→output median
1.0 ms. Eight 215–225 KB AUs took 179–265 ms from SDK admission to successful primary
marker UDP submission at observed 5.57–7.35 Mbps. Three 9–11 KB AUs waited 223–244 ms
behind them, then entered the SDK within 0.1 ms of marker submission. This locates
the dominant outgoing serialization cost under unchanged workload/defaults, the
existing whole-AU owner and SDK
[bandwidth pacer](https://github.com/algesten/str0m/blob/3b5b7ed1ff25d9432a87336a20bc2de336896db3/src/pacer/control.rs).

The hardware accepted LowDelayVBR after format setup: in 65 s the largest AU fell
226→116 KB; twelve scene changes improved 259→121 ms median paint→composition.
BWE remained comparable with a somewhat higher median. Yet its first restoration
ended Limited because 1.24 Mbps estimate was below 2.69 Mbps original supply cost.

The existing SDK [minimum transmit demand](https://github.com/algesten/str0m/blob/3b5b7ed1ff25d9432a87336a20bc2de336896db3/src/bwe/api.rs)
now receives selected original cost separately from desired capacity. The SDK
fills the gap within its estimate and owns congestion suppression/probes. With
that adapter both Original feeds first adopted 6–7 s after restoration, stayed
from 9–10 s, and temporary encoders retired; the healthy connection stayed Original.
This adapter is independent of the hardware rate mode.

Low-start recovery rejected the VBR candidate despite its scene-change gain:

| Same 640×360 input, 100 kbps→2 Mbps live update | Observed result |
| --- | --- |
| LowDelayVBR initialized 2 Mbps | Returned ~2 Mbps, but low-budget QP 17 with frame dropping did not establish dynamic quality control. |
| LowDelayVBR initialized 100 kbps | Stayed ~207 kbps; both controls retained MFT and decoded all AUs. Pinned H264 parser restored-window QP medians 18/high-start versus 50/low-start. Separate 2.x VSE received restored allocation/valid QP yet retained ~51/320×180. |
| CBR, changing only rate mode in low-start control | ~2.07 Mbps/30 fps, QP median 17, all 341 AUs decoded. Mean readback alone was not proof; unchanged 1.728 Mbps Max did not explain VBR. Retain CBR and SDK demand adapter; remove LowDelayVBR. |
| PeakConstrainedVBR with Chromium [paired Mean/Max updates](https://chromium.googlesource.com/chromium/src/+/cf3aaf4828707a1c8cc3c6e8f6df91d37bea418b/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc#1106) | Rust setter reported success, Max stayed initial 100 kbps while Mean read 2 Mbps; ~208 kbps/QP 50, all 342 AUs decoded. Rejected. |

The 2026-11-05 API review found Microsoft's [coded AU size](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/codecapi/avencvideocodedvideoaccessunitsize-property.md)
is VBR-only; the pinned [pacing factor](https://github.com/algesten/str0m/blob/3b5b7ed1ff25d9432a87336a20bc2de336896db3/src/pacer/control.rs)
is internal SDK policy. Later MF FPS compensation changes only configured versus
observed cadence; it cannot shrink the original 30-FPS first scene AU. QP adapts
subsequent input, not encoded bytes. Reviewed Microsoft/Chromium/FFmpeg options
offer no additional small control meeting quality and recovery together. Keep
the improvement boundary open rather than repeat rejected HRD/VBR/latency modes.

### Budget Restoration

Transport allocation and encoder resolution recover separately. Replaying the
[publication budget repair](./node-local-media-design.md#send-queue-recovery)
through unchanged synthetic 1080p30 input restored full resolution where the old
trace retained 360p. The adapter also reports its clamped encoder target through
`OnSetEncoderTargetRate`, as
[VideoSendStream does](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/video_send_stream_impl.cc#1016);
that correction fixes zero-valued diagnostics, not adaptation policy.

The 2026-10-16 comparison isolates a second delay in the pinned WebRTC
[quality scaler](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/video_coding/utility/quality_scaler.cc).
Its default down/up QP smoothers cover roughly two/ten seconds, and subsequent
checks normally wait five seconds. Requiring 60 new frames further delays a
low-cadence stream after each adaptation. Windows now supplies existing field
trials for symmetric five-second smoothing, two-second base checks and 30
required frames. Codec QP thresholds, drop handling and CPU adaptation retain
their library defaults. There is no extra controller, quality floor or reset.

The controls use the same actual NV12/MFT H264 encoder and 1080p30 synthetic
motion at a 5 Mbps ceiling. A direct-budget run constrains the encoder to
400 kbps; the coupled run constrains a 12 Mbps Pion vnet link with 20 ms router
delay to 400 kbps and feeds real TWCC allocation back to the encoder.

| Control | Previous settings | Selected settings |
| --- | --- | --- |
| Direct budget: three one-second limits | 720p after each pulse; 1080p about six seconds after release | Retained 1080p through all three pulses |
| Direct budget: fifteen-second limit | 1080p 17 seconds after release | 1080p 11 seconds after release |
| Coupled P2P: three one-second limits | Stable 1080p 26.6 seconds after final release | Stable 1080p 1.9 seconds after final release |
| Coupled P2P: fifteen-second limit | Stable 1080p 22.3 seconds after release | Stable 1080p 22.2 seconds after release |
| Coupled P2P: healthy link | Retained 1080p | Retained 1080p, about 30 fps, no router drops |

Stable recovery requires five consecutive one-second samples at 1080p and at
least 20 fps. The sustained coupled run did not improve total recovery time:
its transport budget recovered after 7.0 seconds versus 2.8 seconds, while the
following encoder delay shortened from 19.5 to 15.2 seconds. The constrained
outputs reached 180p and 360p respectively; neither policy forces a minimum
resolution. These single synthetic controls establish the selected behavior,
not a network success rate, perceptual ranking or diagnosis of field reports.

Chrome WebCodecs decoded all 2,871 and 3,425 received picture AUs in the selected
sustained and periodic runs, preserving each reported dimension and timestamp.
Parameter-set-only H264 packets are configuration, not pictures. The actual
packaged capture helper also passed the existing VP8 and H264 640x360
adapt/recover fixture with continuous ordered output. Encoder, source and
PeerConnection identities remained intact. Browser WebRTC playout, physical
capture and unrelated GPU drivers are outside these synthetic checks; page
scripts cannot apply these native field trials to the user's Browser encoder.

### Compatible Output Groups

The 2.x source retains per-consumer demand instead of taking a minimum across
weak children. Effective connection budgets are bounded by the same output
ceiling; equal requests share one complete pipeline, while differing requests
are isolated. The group's rates change in place, so a changing estimate is not
a new encoder identity. Stable slot selection avoids changing groups due to
map iteration. Two logical representations remain visible to a connection:
original plus its assigned adaptive output. Additional physical codec slots
are bounded by source admission and do not become new product quality presets.

The existing forwarding source is reused per group. This duplicates bounded
RTP buffering/projection of the original, not original encoding or decoding.
LiveKit's `DownTrack.SetReceiver` retains the transport; the adapter preserves
its own callback wrapper and clears old input clock references before retarget.
Detached packet, sender-report and closure callbacks cannot mutate the new
attachment. A source handoff follows an accepted recovery AU and requests
recovery for the new attachment; pending members keep their current output.
Unneeded physical codec slots stop, and a Native relay still owns one decoder
process for all locally derived groups. Source-generation changes and rejected
timestamps are fenced before attachment changes.

The 2.x capture v7 contract supports 4 MiB AUs and independent per-slot
activation. Windows and Linux CPU-only retirement controls passed; macOS was
source-reviewed without SDK/physical acceptance.

VP8 relay controls shared a 300/300 kbps output, split at 80/300 and rejoined,
retaining one decoder until the final consumer left. A separate 720p moving
source gave healthy/weak children 1.25 Mbps/80 kbps: output stayed 640x360 versus
320x180, but delivery was 596 versus 45 frames over about 20 seconds. WebCodecs
validated exported frames and timestamps. This proves spatial isolation, not
weak-path cadence parity; budgets were explicit inputs, not BWE observations.

A [native encoder ablation](./realtime-quality-adaptation.md#native-encoder-policy-experiments)
replaced independent groups with one maximum or harmonic-mean output. At
80 kbps/1.25 Mbps requests, independent groups retained the healthy child's
640x360/~1.08 Mbps; harmonic sharing reduced it to ~138 kbps, while maximum
sharing sent ~1.20 Mbps even to the 80 kbps child. Both saved encoders but lost
independent budget ownership. Decode and final decoder retirement passed;
forced-demand comparison did not measure real link capacity or perceptual quality.

Windows H264 Host/Viewer controls covered profile changes, source replacement
and restart while retaining media identity. SFU loopback covered recovery,
late callbacks, decoded video/Opus and publication/capture/UDP retirement;
these do not establish public-network or cross-platform acceptance.

Automatic-BWE recovery was not repeatable in every control: a 120 kbps constraint
left one run near 49 kbps for twelve seconds after release, while an unchanged
repeat recovered original 640x360 in about 1.3 seconds. A 75-second follow-up
recovered in 1.535 seconds and then sustained ~30 fps on both children; its
pacer queue peaked at 57 packets and fell to at most two after recovery. The
original supply was ~157 kbps on a 6 Mbps-capacity link, so capacity must not be
confused with payload demand. Successful runs did not explain the missed recovery
or establish a new cooldown/deadlock mechanism.

Restricting the 720p capture subprocess to one core used only about 11.5% of
that core and retained ~30 fps, so that control did not establish overload behavior.

A subsequent 2.x VP8 control used actual AdaptiveEncoder/mailbox input at
2560x1440, 60 fps and 12 Mbps. Baseline delivery was already ~33 fps at
1920x1080. Eighteen seconds on one core used ~88% of that core, delivered
~0.24 fps and took 1.4–3.8 seconds per encode. Restoring affinity recovered
~60 fps at 1280x720. Stock statistics reported two quality adaptations and no
CPU adaptations. The helper reported normal completion/affinity restoration,
but its wrapper lost the exit-code handle; no OS exit-code pass is claimed.

The pinned [CPU detector][cpu-detector] uses software thresholds of 85/42%
and requires 120 frame samples, three initial
checks and two consecutive high checks, normally every five seconds. Pixel
changes or encode-input gaps above 1,500 ms reset sampling; insufficient samples
report the threshold midpoint (64%), matching observations after these stalls.
The [resource manager][resources] was connected and VP8 retained the
[default CPU opt-in][encoder-default]. VSE samples CPU work immediately before
encoding, not on raw arrival or discarded input.

The mailbox and [VSE][vse] both reduce work entering that observer under load;
replaying dropped input as encoded work would fabricate feedback. Pinned Call
also [caches core count][cpu-count], so post-initialization affinity restriction
is not a measured one-core-device or Chrome comparison. This severe helper
limit remains unresolved; no stock-threshold change or custom CPU controller
is justified by the control.

## Evidence Boundary

These controls retain their stated implementation and workload scope; they do
not establish current 3.0 or cross-platform parity. Current device, overload,
perceptual and public-network limits belong to
[verification status](../verification-status.md); [TODO](../todo.md) owns unfinished work.

[chromium-deps]: https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.82/DEPS
[chromium-hint]: https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.82/third_party/blink/renderer/modules/peerconnection/media_stream_video_webrtc_sink.cc
[transport]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/call/rtp_transport_controller_send.cc
[rtp-budget]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/call/rtp_video_sender.cc
[simulcast-rates]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/video_coding/utility/simulcast_rate_allocator.cc
[vse]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/video_stream_encoder.cc
[resources]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/adaptation/video_stream_encoder_resource_manager.cc
[cpu-detector]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/adaptation/overuse_frame_detector.cc
[encoder-default]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/api/video_codecs/video_encoder.cc
[cpu-count]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/rtc_base/cpu_info.cc
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
[codec-initializer]: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/video_coding/video_codec_initializer.cc
[chromium-mf]: https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.82/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc
