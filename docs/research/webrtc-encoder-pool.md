# WebRTC Adaptation And Encoder Reuse

Reviewed: 2026-09-08. Source-backed review and synthetic VP8/H264 feasibility probes,
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
The Piik comparison uses the `3c192ddd` candidate, not production.

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

## Cross-Level Reuse

The shared boundary already exists in `mediaedge.Source`. A Native Receiver
feeds received packets directly through `Source.WriteRTP` into LiveKit buffers
and DownTrack projection. It does not call a decoder or encoder to forward an
available representation. Local capture/derivation instead supplies complete
codec output through `Source.WriteVideo`. The pool fits behind that second
entry, not in front of every received packet:

```text
received original -> existing per-child RTP forwarding -> healthy descendants
                 -> missing direct-child output only
                    -> one real decode -> VSE / shared physical encoder
                                      -> Source.WriteVideo -> child transport
```

The factory's first 180 real VP8 output AUs were exported and replayed through
five actual loopback Pion connections: Host to R1 to R2, with one leaf attached
at each source. Both Native receivers had normal derivation capability and
profiles enabled. The final trace delivered 180, 167 and 167 contiguous AUs at
the three leaves, starting at indexes 0, 13 and 13 respectively. Every received
AU matched an original SHA-256 hash, beginning with independent recovery; no
derivation run was observed at either relay. Earlier runs began at the later
recovery index 19. The prerecorded source cannot answer live PLI requests, so
this startup interval is not a capture/join-latency measurement.

An extension to the existing Native derivation fixture separately verified
640x360 original forwarding alongside one 320x180 derived output, then two
compatible low consumers sharing the same live derivation process. Retiring
one low consumer left the other receiving new frames; retiring the last stopped
the process. The original input stayed encoded. Target layers/budgets in this
fixture are forced to test ownership, not prove automatic network selection.
Both checks passed together and cleaned up. The test awaits Pion's graceful
completion outside callbacks rather than equating concurrent `Close()` return
with completed transport teardown. [Recorded evidence](./data/webrtc-encoder-chain.json)
contains counters and hashes, not media or private connection identifiers.

These measurements establish zero additional encoding on the observed healthy
Native hops, and local sharing of a genuinely missing output. They do not yet
connect the new VSE pool to that native derivation process: the source-pool,
network replay and existing-codec derivation are separate verified boundaries.
The original AUs were already decoded in the C++ probe; byte-identical contiguous
forwarding is not another Browser playback, original-clock or loss-recovery gate.

"One encoding for the whole tree" requires one active source representation
and Native/SFU intermediate forwarding nodes. Pure Browser intermediate nodes
still encode through their normal senders; Browser leaves add decoding only.
If Host keeps pre-encoded lower standby outputs, those encodes must also be
counted. The current packaged producer still constructs original plus half-size;
neither this one-output replay nor a no-extra-hop result silently changes the
accepted envelope policy. The pool probe also has occasional split/rejoin work,
so its healthy case is close to one encode per frame, not an unconditional bound.

### Minimal Integration Direction

Keep the existing Pion/LiveKit transport, estimator, pacer and projection per
edge. Codec-only `VideoStreamEncoder::OnBitrateUpdated` accepts an external
budget without constructing a GoogCC controller, Call or PeerConnection.
`relayPlan` already recognizes missing output from observed positive bandwidth
and paused/lower forwarding demand. It does not need to choose pixel dimensions;
VSE and stock `VideoAdapter` can make that decision from the actual raw input.
A healthy original consumer needs neither VSE nor a fabricated raw frame.

The owning source can reuse `OnDemandChanged` to signal work, never reenter
transport synchronously under its locks. This callback is not currently wired
by Native `NewEdge`; current relay demand is reevaluated at input markers.
Budget-to-payload conversion, dynamic output association in bounded source slots,
physical resource feedback and decoder-safe switching remain concrete integration
work. Connecting those owners is narrower than replacing the transport engine,
but its total change/maintenance cost is not yet measured. A low-quality received
source still cannot manufacture missing detail; higher input or the existing
bounded topology operation must supply it. No subtree quality minimum or new
congestion algorithm is introduced by this direction.

## Scheduling And Resource Follow-Up

The initial probe drained each VSE queue between consumers. A later
`--realtime` arm keeps the 30 fps source cadence without that drain and flushes
queues only at phase boundaries. Its healthy six seconds used exactly 180
physical encodes for two 180-frame receivers, with zero decoded-hash mismatch.
This improves the fixture's scheduling realism, not a one-encode guarantee for
all devices, rates or source histories.

The bounded `--latency-probe` inserts 45 ms before each physical VP8 encode at
640x360, proportional to pixel area at lower sizes. It is a synthetic service
delay, not CPU saturation, desktop capture or a hardware-driver test. The
prototype's registry mutex serializes physical groups, so this arm stresses
ownership and is not a performance comparison with independent parallel codecs.

Under that delay, the two-VSE shared-codec form developed repeated independent
input-drop divergence. During 30 seconds, A/B decoded 391/378 frames and produced
146/149 keyframes; the full trace created 115 codec groups and made 218 group
changes. Reference protection kept the decoded payloads correct, but this churn
is not acceptable product behavior. Both returned to about 30 fps after release.
This is a counterexample to accepting the factory-cache boundary from its
healthy result alone, not proof that all shared encoders must behave this way.

A `--shared-pipeline` control instead gives both consumers one complete stock
VSE/source-adaptation/encoder pipeline. It has no per-consumer encoder factory
cache and leaves upstream overshoot/resource handling enabled. In the same
delay trace, both decoded the same 484 frames with no new keyframe during the
delayed phase; the whole trace created three encoder instances, only for normal
configuration changes, and no split/rejoin cycle. Both consumers' resource
fields in this control refer to the same pipeline, not two independent sensors.

Neither delayed arm delivered a smaller picture until after latency was
released; both subsequently showed 480x270 and recovered full size. Do not claim
complete overload adaptation or perceptual parity from these runs. The useful
result is narrower: shared input admission and shared resource ownership avoid
one source of duplicate-controller churn. Different-child-budget grouping,
transport coupling and actual hardware still need evidence.
[Structured traces](./data/webrtc-encoder-latency.json) retain those limits.

The pinned library also has `EncodeUsageResource`, `OveruseFrameDetector` and
`BroadcastResourceListener` for one resource feeding multiple send streams.
VSE exposes `AddAdaptationResource` but no public removal counterpart; registering
a new resource after each group change would retain old restrictions until
Stop. A stable per-VSE forwarding resource can avoid that, but is additional
coordination, not a reason to add it before the simpler shared-pipeline boundary
has been evaluated. Do not disable local CPU detection unless an honest shared
measurement replaces it, or replay a cached frame's timing as physical work.

Windows H264 need not be rewritten: existing `LiveEncoder` already has bounded
Encode, SetBitrate and retirement around MFT. A shared extraction plus an adapter
can preserve that implementation. Truthful codec information, requested FPS,
actual QP availability, and dynamic output dimensions remain integration work;
the old fixed `OutputWorker` policy is not a requirement to restart WGC capture.
The following H264 step first verified that extraction and opt-in adapter;
the subsequent product attachment is recorded below.

### Hardware H264 Adapter Check

The existing Windows `LiveEncoder` and its MFT/device helpers now have one
shared implementation in `native/capture/windows/h264_encoder.{h,cpp}`. Both
the capture binary and the opt-in probe link it; WGC, source selection, audio,
profile application and capture retirement retain their existing owners.
The probe adapter converts synthetic I420 to NV12 and uploads it for MFT.
This validates the native encoder interface, not a zero-copy capture path.

One complete stock VSE owns rates, pre-encoder dropping, correction and resource
feedback. The adapter reports untrusted hardware rate control and unavailable
QP, rather than claiming the VP8-specific cache feedback applies to H264.
It preserves callback timestamps and shares immutable encoded bytes. SetRates
uses the configured/requested-FPS bitrate compensation in Chromium's
[Media Foundation adapter][chromium-mf]; zero budget pauses instead of writing
an invalid MFT bitrate. WebRTC's [codec initializer][codec-initializer] owns
default H264 settings and the single temporal layer.

The bounded 640x360@30 run produced 174 physical encodes during six seconds,
delivering 174 byte-identical AUs to each consumer. First output took about
275 ms. Removing B left A receiving 60 further frames over two seconds.
One physical encoder was created and all resources retired; there was no
split/rejoin. The pinned SDK has no H264 decoder, so its C++ decoded counters
are explicitly zero. Two Chrome WebCodecs decoders subsequently each decoded
the exported first 180 AUs with the expected dimensions/timestamps and no
reported errors. The last six exported AUs followed B's retirement; this is
bitstream validation, not a claim that both actual consumers received 180.

[Structured results](./data/webrtc-h264-pipeline.json) retain that narrow scope.
These initial checks do not establish independent weak-child adaptation,
overload, actual capture throughput, transport overhead or App integration.

The concrete product attachment is `OutputWorker::Run`, shared by WGC and
encoded-input derivation. Its fixed-size/FPS/direct-rate block can become a
complete VSE while retaining the bounded mailbox, generation fence and
stop/join lifecycle. Bind the H264 adapter to the existing D3D device and reuse
`FrameConverter`/owned decoded NV12, rather than introducing the probe's CPU
round-trip into normal capture. Preserve one timestamp domain across Begin and
AUs: rounding a 100 ns capture timestamp down to WebRTC microseconds can put
the first AU before its Begin anchor. Dynamic output sizes must update the
forwarding format metadata as well as `Source.SetFormat`; ordinary adaptation
must not rebase the whole source generation.

The remaining grouping boundary is not transport-independent bookkeeping yet:
the initial `OutputPlan`/`relayPlan` collapsed demand into one lowest bitrate.
The grouped integration below replaces that owner. The SDK's bundled libvpx
and notices now replace the separate capture dependency. Those were concrete
implementation costs, not solved by the healthy two-callback check above.

### Windows Product Attachment

`OutputWorker` now uses one complete stock VSE/VideoAdapter per shared local
output, for both WGC and encoded-input derivation. The original capture, bounded
mailbox, generation checks and cancellable pipe writer remain. H264 receives
same-device NV12 directly; stock VP8 uses I420 readback. The returned AU retains
its exact input timestamp rather than rounding it through WebRTC microseconds.
The source publishes adapted dimensions through an immutable metadata snapshot;
calling LiveKit's full track-info update for each size change would reset every
active layer's bitrate tracker and was rejected by a focused regression.

The product build now links the same pinned SDK, including its libvpx, instead
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

Auto VP8 measurement now uses the actual VSE path rather than benchmarking an
encoder with different live settings. H264's existing successful-hardware probe
path remains. The four-second decision budget is unchanged. Current grouping
at that point still folded multiple weak consumers into one low budget; the
following integration addresses that independent requirement.

### Compatible Output Groups

The source now retains per-consumer demand instead of taking a minimum across
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
budgets. All three platform producers implement that contract. Windows builds
and normal tests pass; Linux production compilation and CPU-only GStreamer
slot retirement checks pass. The macOS change is source-reviewed, not SDK or
physical acceptance. No Browser/server signaling change is needed for private
encoder grouping; matched App and capture artifacts are required.

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

The full H264 Windows Host/Viewer gate also passes live and paused profile
changes, background-profile recovery, source replacement and restart while
preserving media identity. SFU retarget has real loopback tests for clock,
per-RID counters, recovery and late old-source callbacks. Complete network,
hardware-overload, multi-room and platform acceptance remain distinct work.
The Native H264 embedded-SFU gate additionally decodes 300 720p frames, applies
a live 480p change, retains decoded Opus and closes publication/capture/UDP
resources. Its Vite server disables file watching: scanning the growing ignored
build tree had blocked the test's in-process event loop and CDP navigation
before media started. No Browser media deadline was relaxed to obtain the pass.

The subsequent automatic-BWE relay checks are mixed: one 120 kbps constrained
run retained a roughly 49 kbps estimate throughout the twelve seconds after
release; an instrumented repeat, with no runtime correction, returned to the
original 640x360 output about 1.3 seconds after release. That successful trace
shows valid higher-output demand and the stock congestion guard clearing, not
proof of why the earlier run stayed low. The fixture's 6 Mbps value is link
capacity, not payload rate: its replayed original is roughly 157 kbps and its
bounded queue makes keyframe/retransmission bursts relevant. Temporary probe
instrumentation was removed. Observation files now follow each received-output
path and counters follow the actually attached group, preserving failed runs
and avoiding stale-group attribution. This is an unresolved repeatability
boundary, not evidence for a new recovery timer or a permanent deadlock.

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
stall. Temporary tracing and the extended fixture duration were removed, and
all capture/test processes exited.

A bounded CPU-affinity check retained the original 1280x720 child and two
compatible 640x360 consumers through fifteen seconds with only the capture
subprocess restricted to one core, then restored its original affinity. All
three received about 30 fps with the same shared group and decoder process.
The subprocess used only about 11.5% of that core during the restriction, so
this did not induce overload and cannot establish resource-adaptation parity.
The temporary fixture was removed and process/affinity cleanup verified.

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

## Replacement And Preservation Map

| Current owner | Treatment if a pool-backed engine is proved |
| --- | --- |
| Go room/controller, embedded STUN, SFU service lifecycle | Preserve. A codec experiment does not alter authority, NAT policy or single-operation routing. |
| LiveKit forwarding/BWE/projection and Pion transport | Keep for existing encoded forwarding. Replace a Native endpoint owner only if the new library actually assumes that responsibility; never run two controllers on one edge. |
| Native output construction, `Source.BeginFrame`, codec workers | Review together against the replacement's capabilities. Remove superseded activation, rate and switching policy in the same integration, not through a permanent legacy path. |
| Native profile handoff, source clock, bounded queues and retirement | Preserve their verified behavior even if their implementation moves. Do not lose the profile-install acknowledgement or reintroduce double FPS limiting. |
| App sessions, Global Link, UI, diagnostics and packaging | Outside an encoder-policy replacement. Preserve the separately useful fixes/enhancements recorded in TODO and Git. |

An engine migration must also retain direct Native SFU publication, independent
Native room sessions, native ICE improvements and mixed Browser/App relay.
Changing transport libraries does not automatically preserve these APIs. No
unrelated page rewrite or platform-adapter deletion is justified by this review.

## Integration Gates

1. Reuse the now-executed native VSE/VP8 boundary; do not repeat a mock-only
   factory probe or fetch a second full engine to show buffer reuse. Validate
   hardware H264 and physical-resource feedback with the existing capture adapter.
2. Measure source replacement, overload, real scheduling, perceptual quality,
   transport overhead and actual CPU/GPU cost. Preserve correction/drop/resource
   feedback with explicit owners before accepting the product integration.
   The delayed-codec counterexample above means the per-sender factory cache
   cannot be selected as-is; evaluate shared complete encoding pipelines before
   adding another resource/membership coordination layer.
3. Connect the separately verified encoded bypass and shared lower derivation
   through that same representation owner. If preserving stock
   control requires substantial VSE/source patches or a custom rate/quality
   policy, report that cost instead of calling it a small factory adapter.
4. The narrow pass permits an isolated implementation candidate, not release
   approval. Select the integration through an ADR refinement after resolving
   the remaining owners. Preserve the current candidate; never merge it solely
   to manufacture a new branch base. Follow
   the stable executable paths and serialized physical workload rules in
   CONTRIBUTING. The quiet-source update defect has real WGC acceptance and the
   owner closed the Win10 display report; distinct game failures require fresh evidence.

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
