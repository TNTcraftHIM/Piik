# WebRTC Adaptation And Encoder Reuse

Initial review: 2026-09-08. The 3.0 sections below distinguish current H264
compatibility, a codec-extension proposal and measured Rust worker cadence.
The [network model](./channel-network-design.md#implementation-boundary) owns
current 3.0 behavior. The pinned libwebrtc review, [Windows product attachment](#windows-product-attachment)
and [compatible output groups](#compatible-output-groups) retain 2.x C++/Go evidence
under [ADR-0013](../adr/0013-embedded-node-local-media.md) and
[media quality](../standards/media-quality.md); their historical integration
statements do not describe the Rust implementation.

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

The initial candidate constructed original plus half-size outputs at the same
FPS; at 1080p its lowest output was 960x540. Its consumer budgets changed
bitrate, while the Windows worker kept fixed dimensions/FPS. Bounded raw
mailboxes isolated overload without reducing requested encoding work.

Pion transport and LiveKit BWE/forwarding/allocation/pacing did not supply the
missing libwebrtc raw-source resource-adaptation chain or full RTP overhead
calculation. This was an integration gap, not a library defect. Constrained-codec
recovery evidence did not establish Browser parity below the fixed lowest size.

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

The libwebrtc [build guide][webrtc-build] describes a native GN/Ninja dependency
build. Its headers are not a stable Go plug-in ABI. Evaluate reproducible build,
update and package cost before replacing the Native media engine. WebRTC code
retains its BSD-style license and PATENTS grant, dependencies their own notices.
Epic's infrastructure MIT license does not license Unreal Engine/EpicRtc code.
This review copies no upstream implementation and adds no product dependency.
The opt-in probe linked the pinned SDK only under the ignored build directory.

## Executed Feasibility Probe

The [archived 2.x probe recipe](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/native/probes/encoder-pool/README.md)
used matching Shiguredo m152.7977.0.2 headers/library and official MSVC tooling.
Its disabled built-in H264 and pacer keyframe flushing did not affect this VP8
encoder-only control. No desktop capture, ports, game, production service or CI
was involved. Two VSEs/stock VideoAdapters consumed 640x360@30 at 2 Mbps;
B alone received 100 kbps for 15 seconds, then 2 Mbps for 25. Maintain-framerate
exposed spatial adaptation. Queues drained between inputs: external encoder
budgets, not a full GoogCC network or throughput benchmark.

| Form | Healthy six-second physical Encode calls | Frames per consumer |
| --- | ---: | ---: |
| Independent encoders, stock correction | 360 | 180 / 180 |
| Shared factory, independent VSE correction | 337 | 180 / 180 |
| Shared factory, upstream corrector per physical encoder | 187 | 180 / 180 |

The two pooled forms reused 23 and 173 calls respectively, the latter about 48%.
Independent [EncoderBitrateAdjuster][bitrate-adjuster] targets diverged despite
equal logical rates (~1.67/1.59 Mbps). A disabled-adjuster diagnostic isolated
the conflict; the viable form reused the library corrector once per physical
output, preserving correction instead of choosing one peer as authority.
The cache held one AU per encoder, split on incompatible demands and rejoined
at keyframes; attempted input and successful reference identity were separate.
RTT/loss were omitted only because guarded VP8 L1T1
[DefaultTemporalLayers][vp8-default-temporal] ignores them.

Both paired runs reduced B at ~4.04 seconds to 320x180 and first restored
640x360 ~24.05 seconds after release; A retained ~30 fps/full size. The pool
reused 87 frames in the later three-second skipped-input phase and retired all
groups, with at most two live encoders. Weak delivery differed: control
154 frames/10.27 fps/85.3 kbps versus pool 142/9.47/95.1; extra transition
keyframes and matching dimensions do not establish perceptual/network parity.

WebRTC checked decode usability; raw libvpx without postprocessing checked
reference correctness. The [stock decoder][vp8-decoder]'s x64 history-dependent
MFQE caused an earlier misleading pixel comparison. The corrected pool compared
288 shared payloads with zero raw mismatches; removing reference protection
produced 29 despite successful decoding. [Structured results](./data/webrtc-encoder-pool.json)
retain counters without payloads/private identifiers.

### Verdict And Remaining Scope

An unchanged factory cache was insufficient: independent correction fragmented
equal nominal demands. Sharing a physical encoder with its correction state
passed narrow VP8 reuse/spatial-adaptation/reference-continuity controls; no
engine replacement was selected at this feasibility stage.

The moved library corrector runs on actual frames with deduplicated rate writes,
unlike VSE's rate/configuration/FPS updates; its cadence is not identical.
Trusted VP8 disables pre-encoder media-optimization dropping here. Other codecs
need that feedback outside VideoEncoder callbacks; codec drops cannot stand in.
Per-VSE cache-hit timing also differs from physical work. H264/asynchronous
hardware, real overload, transport overhead, received-source bypass and
perceptual parity were not established by this probe. The subsequent controls
test the complete shared-pipeline boundary rather than adding quality formulas.

## Cross-Level Reuse

The 2.x mediaedge.Source separates received encoded RTP forwarding from complete
locally encoded outputs. Reuse belongs behind the latter boundary:

```text
received original -> existing per-child RTP forwarding -> healthy descendants
                 -> missing direct-child output only
                    -> one real decode -> VSE / shared physical encoder
                                      -> Source.WriteVideo -> child transport
```

The first 180 pool VP8 AUs traversed five real loopback Pion connections,
Host→R1→R2 with a leaf at each source. Leaves received 180/167/167 contiguous
byte-identical AUs, starting at indexes 0/13/13 (earlier runs 19), with independent
recovery and no relay derivation. Prerecorded input could not answer live PLI;
this was not capture/join latency, Browser playback, original-clock or loss
recovery acceptance.

The Native derivation fixture separately forwarded 640x360 original alongside
320x180 derived output, shared one process between two compatible low consumers,
kept it after one left and stopped it after the last. Forced budgets test
ownership, not automatic network selection. Both controls cleaned up, awaiting
Pion graceful completion outside callbacks. [Evidence](./data/webrtc-encoder-chain.json)
contains hashes/counters without media/private identifiers. Pool, network replay
and existing-codec derivation were separate boundaries, not a connected VSE
derivation integration at this stage.

One encoding for a tree requires one active representation and Native/SFU
intermediates. Browser intermediates still encode; leaves only decode. Count
lower standby encodes and split/rejoin work too: the then-packaged producer's
original-plus-half envelope was not changed by this replay.

## Scheduling And Resource Follow-Up

A realtime arm kept 30 fps without per-input queue draining: two healthy
180-frame receivers used 180 physical encodes in six seconds with zero decoded
hash mismatch. This improved scheduling realism, not an unconditional bound.

The latency arm added 45 ms before each 640x360 VP8 encode, proportional to pixel
area at lower sizes. This was synthetic service delay, not CPU saturation or
driver/capture performance; a registry mutex serialized physical groups.

| Ownership under delay | Decoded frames A/B in 30s | Churn |
| --- | --- | --- |
| Shared codec, separate VSEs | 391 / 378 | 146 / 149 keyframes, 115 groups, 218 changes |
| Complete shared VSE/source-adaptation/codec pipeline | 484 / 484 | No delayed-phase keyframe or split/rejoin; three normal configuration instances overall |

Reference protection kept payloads correct, but factory-cache churn was not
acceptable. Both arms returned to ~30 fps after release; neither reduced picture
size until afterward, then showed 480x270 before full recovery. Shared resource
fields described one pipeline, not independent sensors. [Traces](./data/webrtc-encoder-latency.json)
establish that ownership result, not overload or perceptual parity.

Pinned VSE AddAdaptationResource has no public removal counterpart: repeated
registration can retain restrictions until Stop. A stable forwarding resource
would add coordination. CPU detection must not be disabled without honest
shared measurement, nor cache timing replayed as physical work. The following
H264 control tested reusing the existing bounded MFT implementation.

### Hardware H264 Adapter Check

The capture executable and opt-in probe linked the same 2.x Windows
[LiveEncoder/MFT implementation](https://github.com/TNTcraftHIM/Piik/blob/72ca6f2bc97df88e216a392721250309aa53bc39/native/capture/windows/h264_encoder.cpp).
WGC, selection, audio, profile application and retirement kept their owners.
Synthetic I420→NV12 CPU conversion/upload checked the interface, not zero-copy.

One stock VSE owned rates, dropping, correction and resources. The adapter
reported untrusted hardware rate control and unavailable QP, preserved callback
timestamps and shared immutable bytes. SetRates followed Chromium's
[configured/requested-FPS compensation][chromium-mf]; zero budget paused instead
of writing invalid MFT bitrate. The [codec initializer][codec-initializer]
supplied default H264/single-temporal-layer settings.

At 640x360@30, six seconds produced 174 physical encodes/byte-identical AUs per
consumer, first output ~275 ms. Removing B left A receiving 60 further frames
over two seconds; one physical encoder retired fully. SDK H264 decode counters
were zero (no decoder). Two Chrome WebCodecs decoders each validated the first
180 exported AUs; the last six followed B's retirement, so actual dual-consumer
180-frame reception is not claimed. [Results](./data/webrtc-h264-pipeline.json)
do not establish weak-child adaptation, overload, capture throughput, transport
overhead or App integration.

Product attachment retained mailbox/generation/stop/join and existing D3D
FrameConverter/owned decoded NV12, avoiding the probe CPU round-trip. Exact input
timestamps matter: 100 ns→microsecond rounding can place AU before Begin.
Adapted dimensions must update forwarding metadata without rebasing generation.
The later output groups replaced the initial collapsed-lowest-budget demand;
the bundled SDK/libvpx and notices replaced the separate capture dependency.

### Windows Product Attachment

The 2.x `OutputWorker` uses one complete stock VSE/VideoAdapter per shared local
output, for both WGC and encoded-input derivation. The original capture, bounded
mailbox, generation checks and cancellable pipe writer remain. H264 receives
same-device NV12 directly; stock VP8 uses I420 readback. The returned AU retains
its exact input timestamp rather than rounding it through WebRTC microseconds.
The source publishes adapted dimensions through an immutable metadata snapshot;
calling LiveKit's full track-info update for each size change would reset every
active layer's bitrate tracker and was rejected by a focused regression.

The 2.x product build links the same pinned SDK, including its libvpx, instead
of a second standalone libvpx build. The Windows capture executable is about
8.0 MB and imports only Windows system DLLs/API sets. Cached SDK and official
MSVC archives total about 816 MB, not package payload. SDK notices are retained
in the package; no new daemon or runtime service is added.

The opt-in `TestAdaptiveOutputFixture` sends synthetic encoded input through the
actual capture executable: six seconds at 2 Mbps, fifteen at 100 kbps, then
restoration to 2 Mbps. VP8 delivered 178 full-size healthy frames, 94 reduced
frames during the limited interval and 26 full-size restored frames within
the first 25 seconds after release. Source timestamps remained ordered.

H264 exposed two interface differences. Unconditionally marking QP untrusted
selected the bandwidth-quality scaler rather than Chromium's usual parsed-QP
path. The adapter now allows VSE's existing H264 parser and uses upstream
24/37 quality-scaler thresholds, without a custom controller. The existing MFT
implementation also forced a one-frame VBV at initialization. Updating only
mean bitrate left about 118 kbps output after restoration; attempting to change
VBV dynamically failed driver readback and was removed. Chromium does not set
that VBV override. Deleting the override and its exact-value assertion restored
about 1.9 Mbps while retaining CBR and low-latency mode.

The remaining delay was visible in upstream logs: parsed QP fell to 22-25 but
the low-QP smoother remained above the 24 upscale threshold. In a 76-second run,
resolution returned via 480x270 to 640x360 around 50-55 seconds from start,
about 29-34 seconds after budget restoration. Counts were 178 healthy full-size,
265 limited reduced-size and 686 restored full-size frames, 2,105 total. No
connection/pipeline reset or new timer forced recovery. Temporary internal
tracing was removed after this diagnosis. This is eventual recovery, not a
low-latency recovery guarantee; Intel-specific QP capability quirks and actual
overload still need hardware evidence.

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

The internal capture v7 contract supports encoded AUs up to 4 MiB and independent
per-slot activation in place
of the old prefix count, permitting equal-ceiling outputs with different
budgets. All three 2.x platform producers implement that contract. Windows build
and Linux compilation/CPU-only slot-retirement checks passed; macOS remained source-reviewed,
without SDK or physical acceptance.

Actual VP8 relay checks exercise two equal 300 kbps consumers sharing one
derived output, splitting to 80/300 kbps and rejoining at 300/300 kbps. Both
consumers keep receiving and the decoder process remains the same. Independent
consumer and final-process retirement pass. A separate 1280x720 moving-input
trace keeps one child at a 1.25 Mbps derived budget while the other receives
80 kbps: the latter reaches 320x180 and the former stays at 640x360. Over the
roughly 20-second weak phase they receive 45 and 596 frames respectively;
Chrome WebCodecs decodes every exported frame with its expected dimensions
and timestamp. This proves spatial isolation and valid delivery, not weak-path
cadence parity. Budgets in these grouping fixtures are explicit transport
inputs; the separate shaped-network gate owns automatic estimator evidence.

A subsequent [native encoder experiment](./realtime-quality-adaptation.md#native-encoder-policy-experiments)
tested replacing this partition with one common output: either the maximum or
the harmonic mean of the active requests. These are policy ablations, not a
replacement for independent receiver eligibility and dependency ownership.
The real Native VP8 fixture supplied 1280x720 motion, with requests of
80 kbps and 1.25 Mbps for twenty seconds, then equal requests and retirement.
The independent groups retained the healthy receiver's 640x360 output at
roughly 1.08 Mbps during the final ten constrained seconds. A common harmonic
output reduced its delivered payload to about 138 kbps; a common maximum sent
about 1.20 Mbps even to the 80 kbps consumer. Both alternatives reduced the
derived encoder count but lost independent budget ownership. All variants
kept the decoder process while demand changed, then retired it after the last
consumer left. Chrome WebCodecs decoded every exported picture. This bounded,
forced-demand comparison does not measure real link capacity, perceptual
quality or another application's runtime performance; it supports retaining the current
partition rather than replacing it with one aggregate rate.

The full H264 Windows Host/Viewer gate also passes live and paused profile
changes, background-profile recovery, source replacement and restart while
preserving media identity. SFU retarget has real loopback tests for clock,
per-RID counters, recovery and late old-source callbacks. Complete network,
hardware-overload, multi-room and platform acceptance remain distinct work.
The Native H264 embedded-SFU gate additionally decodes 300 720p frames, applies
a live 480p change, retains decoded Opus and closes publication/capture/UDP
resources. This is loopback evidence, not public-network or cross-platform acceptance.

The subsequent automatic-BWE relay checks are mixed: one 120 kbps constrained
run retained a roughly 49 kbps estimate throughout the twelve seconds after
release; an instrumented repeat, with no runtime correction, returned to the
original 640x360 output about 1.3 seconds after release. That successful trace
shows valid higher-output demand and the stock congestion guard clearing, not
proof of why the earlier run stayed low. The fixture's 6 Mbps value is link
capacity, not payload rate: its replayed original is roughly 157 kbps and its
bounded queue makes keyframe/retransmission bursts relevant. The differing
outcomes leave a repeatability boundary; neither establishes
a new recovery timer or a permanent deadlock.

A 75-second follow-up on the 4,096-packet candidate kept the same 5-to-18-second
120 kbps constraint and restored the original at 19.535 seconds, 1.535 seconds
after release. The stock congestion guard cleared, a 200 ms padding probe
requested 315,957 bps, and the estimate rose to 400,717 bps. Both children then
held about 30 fps through the remaining run; the healthy original delivered
2,241 frames with no assembly loss, while the constrained child delivered 1,941
frames with 25 assembly gaps during congestion. The sampled pacer queue peaked
at 57 packets and stayed at two or fewer after recovery. This demonstrates
sustained stock recovery in that run, without an algorithm change; it does not
identify the earlier missed recovery as either a long cooldown or a permanent
stall. All capture/test processes exited.

A bounded CPU-affinity check retained the original 1280x720 child and two
compatible 640x360 consumers through fifteen seconds with only the capture
subprocess restricted to one core, then restored its original affinity. All
three received about 30 fps with the same shared group and decoder process.
The subprocess used only about 11.5% of that core during the restriction, so
this did not induce overload and cannot establish resource-adaptation parity.
Process/affinity cleanup was verified.

A later 46-second VP8 check used the actual `AdaptiveEncoder` and mailbox at
2560x1440, 60 fps and 12 Mbps, with an independent raw-input producer. An
ignored source copy added only `GetStats()` observations. The eight-second
baseline already averaged about 33 encoded fps and reduced to 1920x1080 for
bandwidth/quality. Restricting the already initialized process to one core for
18 seconds used about 88% of that core but delivered only about 0.24 fps;
average encode time reached 1.4-3.8 seconds. Restoring affinity recovered about
60 fps at 1280x720 during the final 20 seconds. Stock statistics recorded two
quality adaptations and no CPU adaptations. This exposes a severe overload
limit, not CPU-adaptation parity. The helper reported affinity restoration and
normal completion; its PowerShell wrapper failed to retain an exit-code handle,
so an OS exit-code pass is not claimed. No product code was changed.

The pinned [CPU detector][cpu-detector] explains why large encode times do not
necessarily produce a CPU adaptation. Its default software thresholds are
85/42%, with 120 frame samples, three initial checks and two consecutive high
checks; checks run every five seconds after an initial 100 ms check. A change
in pixel count or a gap above 1,500 ms between frames entering encoding resets
the samples and initial-check count. Before enough samples exist, usage returns
the threshold midpoint rounded to 64%, matching the repeated 64% observations
after the multi-second stalls. The [resource manager][resources] is connected:
built-in VP8 retains the [encoder default][encoder-default] CPU opt-in and is a
software encoder. VSE invokes `OnEncodeStarted` on its encoder queue just
before the codec call; raw arrival and `OnDiscardedFrame` do not supply CPU
samples. Replaying dropped inputs as encoded work would misrepresent feedback.

Piik's synchronous drain and latest-input mailbox reduce arrivals into VSE
under this load, but the [same pinned VSE][vse] also skips queued frames before
calling the CPU observer. Therefore moving admission or reporting source drops
alone is not an established fix for multi-second encode gaps. Chromium's pinned
Call also [caches system core count][cpu-count]; changing process affinity after
encoder initialization is an extreme constraint, not a measured one-core-device
or Chrome comparison. The 0.24 fps result belongs only to this helper. Keep
overload acceptance open without changing stock thresholds or adding a custom
CPU controller.

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
