# Node-Local Media Design Proposal

Date: 2026-09-07. [ADR-0013](../adr/0013-embedded-node-local-media.md) accepts the
model and highest-demand policy. This file proposes implementation details, not
a claim that the replacement has shipped. The work includes embedded STUN/SFU
and a shared Native/SFU media module, not just Native encoding improvements.

The 2026-09-08 [WebRTC encoder-pool review](./webrtc-encoder-pool.md) qualifies
this candidate: fixed output construction and forwarding allocation do not
include Browser encoder resource adaptation. The maximum-demand ownership model
remains accepted; the implementation below is not an accepted quality-parity
boundary. Review the proposed reuse point before adding compensating policies.

## Recommendation From The Experiments

Use one bounded output group with the maximum-demand envelope as the first
integration candidate. Existing framework capacity/layer selection chooses what
each child can receive; the group keeps outputs through the highest needed
level active. Avoid an exact-demand warm pool, per-child encoder, arbitrary
per-bandwidth representation or new optimization scheduler.

This is a pragmatic initial policy, not proof that exact demand is inferior:

- The [Native VP8 probe](./node-local-encoding-probe.md) measured about 26% more
  CPU cycles for envelope than exact-cold on the same demand trace. Extra low
  encodes are real work, not free efficiency from the word simulcast.
- The [VP8/H264 decode probe](./node-local-browser-probe.md) found very small
  finite-set management cost and some backend-sensitive H264 activation delays.
  Envelope keeps useful fallbacks ready but cannot eliminate all cold starts.
- Naive codec retention has timestamp/rate-control consequences. Mature codec
  rate-control/activation ownership is worth more than avoiding a few local
  initialization calls with another home-grown state machine.

Exact demand remains a comparison policy in the same experiment, not a second
product mode. If hardware measurements show the unused-layer cost materially
hurts game cadence, change the group activation rule rather than building a
parallel transport. Neither policy may degrade the healthy input to satisfy one
weak child. Real-time playback takes priority over encode-count reduction.

## Boundaries And Flow

```text
capture or received encoded source (existing generation owner)
  -> suitable encoded representation -> child transport
  -> missing lower output
       -> one shared decode if required
       -> platform scale/encode group
       -> shared encoded representations -> child transport

each child's framework estimator/selector -> direct-child demand
direct-child demand -> group activation
input-limited path -> existing bounded topology operation
```

- **Source owner:** capture settings, media clock, selected codec and generation.
  Turning off an unused output does not alter capture or discard best input.
- **Output group:** bounded representation slots from the selected media
  component and Host ceiling. One owner writes codec parameters; children do not
  independently overwrite the shared encoder. Reuse immutable encoded access
  units and reference-counted surfaces. Do not create a generic cache/service.
- **Child transport:** its own congestion estimator, packet identity, recovery
  feedback and chosen output. A source slot is not a PeerConnection. Changing
  layers must not require a new route or a new PC for ordinary adaptation.
- **Router:** connectivity and input-quality opportunity. It never adjusts
  codec settings. Healthy transport of already-poor input is not automatically
  a good route; better input/reparenting still needs real candidate proof.

An all-healthy relay retains zero new encoding: its received H is already
available. It does not create an encoder group just to keep unused fallbacks.
Only a missing demanded representation starts local derivation. Within that
group, compare/activate the agreed envelope without duplicating received outputs.
Leaf nodes create no outbound codec group.

A Host using envelope may encode fallback layers even when both direct children
currently take H. This trades the literal one-Host-encode ideal for readiness;
it must not be described as both policies having identical healthy-case cost.
It also must not force those fallback bytes through every child link. Standard
SFU simulcast ingest can carry several layers in one publication; its aggregate
uplink budget must be respected. Encoding standby output locally and uploading
all layers are distinct costs.

## Minimal Lifecycle

1. Source/share generation owns available encoded slots and at most one local
   derivation group. Existing lifecycle closure retires all owned resources.
2. Child join, departure or a framework-selected target change updates demand.
   No room-wide survey, periodic rebalance or subtree demand recursion.
3. A newly needed slot is activated through the codec's normal controls. Keep
   the previous usable output until a decoder-safe target frame exists, subject
   to the transport's real congestion budget; never enqueue unlimited old video.
4. Target switching uses mature keyframe, RTP sequence/timestamp and codec
   descriptor handling. Same output chunks can feed multiple child transports;
   each transport still owns its packet headers and recovery.
5. Reduced demand stops unused upper outputs through the framework's normal
   deactivation semantics. Any debounce belongs to that owner, not another
   Piik timer beside it. No application-selected timer values in this draft.
6. Source replacement/failure/stop invalidates the same generation. No dormant
   warm pool survives and no old callback can resurrect an encoder.

Shared decode/scale must not block a ready encoded sibling. Each output's work
and each child's transport use bounded queues; control never waits for all
children to consume a frame. Queue/drop behavior must preserve codec dependencies
through the media library, not drop arbitrary packets or overwrite media clocks.

### Complete-Frame Switch Boundary

The first Native boundary uses complete encoded access units and one persistent
Pion packetizer per selected output stream. Pion owns fragmentation, packet
sequence and VP8 PictureID; codec recovery includes H264 SPS/PPS and IDR, not
an arbitrary packet labelled as a keyframe.

The source owner arms a child-local cutover at an actual input frame, before
any representation of that frame is emitted. Older incumbent frames remain
eligible. At the fence, that child waits for the target recovery frame; siblings
continue independently. Target encoder preparation precedes the fence, and its
normal keyframe/recovery mechanism owns failed output. No guessed future PTS,
global all-output barrier, extra timeout or timestamp rebasing is introduced.
Canceling after incumbent reference frames were skipped also requires recovery.

This boundary does not handle arbitrary already-arriving RTP streams. In that
case a target keyframe can arrive after the incumbent with the same PTS; merely
dropping `PTS <= last` can starve upgrades. A mature RTP projection/munger or
an explicitly controlled input-frame boundary is required. In particular,
`BeginGeneration` is for capture/source replacement, never layer switching.

## Reuse Map

| Existing module / primary source | Reuse or learn | Integration limit |
| --- | --- | --- |
| Piik `mediaedge.Source`, `Edge`, Native capture generations | Encoded-source ownership, Pion connections, existing share/route identity | Static RTP broadcast alone does not solve switching sequence spaces or codec descriptors |
| [Pion GCC](https://github.com/pion/interceptor/blob/main/pkg/gcc/send_side_bwe.go) and RTP/RTCP interceptors | Existing mature feedback and bandwidth estimate | Current Piik path only observes GCC and uses a no-queue pacer; selection/pacing is not already implemented |
| [LiveKit Dynacast manager](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/dynacast/dynacastmanagervideo.go) | Highest-needed activation and asymmetric demand handling | Apache-2.0; reference, not import the entire service or its downstream-node aggregation |
| [LiveKit Simulcast selector](https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/videolayerselector/simulcast.go), [RTPMunger](https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/rtpmunger.go), [prober](https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/ccutils/prober.go) | Keyframe switching, packet continuity, bounded recovery probes | Valuable source, but imports protocol/buffer/logger infrastructure; not a demonstrated tiny drop-in |
| [libwebrtc VP8 adapter](https://github.com/webrtc-mirror/webrtc/blob/main/modules/video_coding/codecs/vp8/libvpx_vp8_encoder.cc) | Coordinated libvpx encoding, SetRates, active-stream keyframes, prepared scale buffers, separate codec and media timestamps | BSD-style; references many WebRTC types. Reuse the underlying libvpx API before copying a large wrapper |
| [libwebrtc H264 adapter](https://github.com/webrtc-mirror/webrtc/blob/main/modules/video_coding/codecs/h264/h264_encoder_impl.cc) | Simulcast OpenH264 contexts, bitrate updates, scale-buffer reuse and keyframe/SPS discipline | Software reference, not proof that hardware multi-session cost is identical |
| Existing MFT/VideoToolbox/GStreamer/libvpx boundaries; [libyuv](https://chromium.googlesource.com/libyuv/libyuv/+/refs/heads/main/README.md) | Keep working capture adapters; native conversion/scaling and codec control | Received-source decoding and GPU surface sharing remain real work; don't replace working capture wholesale |
| [GStreamer tee](https://gstreamer.freedesktop.org/documentation/coreelements/tee.html) / [queue](https://gstreamer.freedesktop.org/documentation/coreelements/queue.html) | Shared frame ownership with branch isolation | Architecture reference; default queue sizes are not accepted latency budgets |

inLive remains an embedded forwarding candidate, not the answer to derivation
or a proved adaptation replacement. Its inspected layer sender is coupled to
App, track, bitrate-controller and packet-map owners; don't copy it as an
independent universal selector. No new dependency or upstream implementation
source was copied in this design pass. Preserve upstream licenses/notices when
an actual module is chosen; Piik's MIT does not replace them.

Parallel inLive API inspection found work to validate before selecting it:
publisher-demand change notification is not public; `AddRelayTrack` installs a
no-op PLI callback; the layer sender has its own packet mapping rather than a
standalone codec-neutral switch API. Its inspected timestamp expression subtracts
the layer origin twice. Manager room removal/locking, failed-PC closing and
logger injection also need focused reproductions. These are candidate-library
risks, not claims about deployed Piik bugs or reasons to expand the Native
module into an SFU fork.

## Required Before Production

- Select a bounded codec/representation and packet-switching adapter backed by
  actual RTP decode, loss/recovery and congestion tests, not this local probe.
  Native H264 hardware and 60 fps resource ceilings remain unmeasured here.
- Prove behavior below the lowest nominal layer's bitrate and under encoder
  overload. A fixed simulcast set alone is not complete adaptation. The selected
  media component must still own usable bitrate/frame-rate reduction, recovery
  and packet pacing; do not declare parity merely because three sizes decode.
  One child must not mutate the base or all shared slots to solve its deficit.
- Measure decode/scale/surface-copy cost on the real Native relay path and prove
  a stalled derived output cannot block original high output. Browser preview
  decoding is not automatically a reusable zero-copy Native frame source.
- Preserve capability-based mixed Browser/Native behavior; no Browser RTP
  passthrough promise, Browser WebCodecs transport replacement, AV1/VP9 or codec
  change during a share.
- Specify real low-input recovery through the single router, with fresh
  candidate evidence. Do not add a score or assume current topology is optimal.
- Implement ADR-0013 without claiming ADR-0007's runtime has already changed.
  The current runtime
  remains intact until its replacement is accepted and verified; no hidden
  experimental production branch or compatibility layer.

This is an implementation proposal with explicit unverified boundaries, not a
completed feature or a promise that every codec/device benefits equally.

## Implementation Sequence

1. Establish the shared Native/SFU encoded-output boundary from current Native
   packetization. Keep one per-child packetizer across representation changes;
   prove source-timestamp, payload-descriptor and generation continuity before
   adding codec control. Existing Native single-output delivery consumes the
   common component immediately.
2. Implement shared representation activation and safe frame-boundary switching
   against that boundary, preserving current source and connection fences. Audit
   an SFU library's public switching APIs in parallel, not as a prerequisite to
   the Native quality module or a reason to build a fork prematurely.
3. Connect Native decode/scale/encode groups and framework per-child estimation,
   rate selection and pacing. Verify Host and relay independently, including
   below-lowest-layer and constrained-encoder recovery.
4. Integrate STUN/SFU with the existing Go room/signaling/config owners and match
   Browser publication/subscription. Remove external-service integration in the
   coordinated acceptance boundary, not through permanent dual backends.

This is one phase with staged verification, not four independent production
releases. Current STUN-only and single-output fanout probes are completed
components, not acceptance of the complete phase.

## Current Implementation Boundary

`internal/media/forwarding` owns the shared input buffers, typed single-video
allocation and outgoing transport adapter. Native Source/Edge use it. Pion owns
ICE, crypto and reports; unmodified LiveKit media components own send-side BWE,
allocation primitives, RTP projection and video retransmission. A bounded pacing
adapter owns packet admission/retirement; a single-video event driver adapts the
upstream probe lifecycle without another congestion formula or application timer.
The replaced local Group/
Selection and receiving-PC sender-estimator registry are deleted, not retained
as alternate implementations. There is no mirrored counter summing unused layers.

The parent reads child state at actual capture InputBegin. A controlled layer
switch uses the existing DownTrack resync before outputs for that input, retaining
its target; this prevents an old-layer packet winning the same presentation time.
Raw RTP has no such honest input boundary and uses ordinary mature projection,
without decode or whole-frame repacketization. Inbound video padding is consumed
by projection while outbound sequence continuity remains intact. Incoming sender
reports retain their source-clock relation; local codec outputs correlate to one
input anchor, not independently to each encoder's completion time.

Local capture replacement keeps its RTP source and cumulative counters while
rebasing only the input packetizers. It must not also restart the RTP projector.
Unconnected edges reserve capacity without asking for output. Existing audio
settings or observed relay-audio bytes reserve that portion of the PC budget.

Capture producers now implement the coordinated v5 multi-output boundary below;
the packaged runtime has not been physically accepted. A bounded real libvpx
fixture supplies three outputs to the
same Native source API: 96 encoded AUs, two unchanged Pion connections, 40 selected
frames each, and 40/40 Chrome WebCodecs decodes at the expected dimensions and
timestamps. [Recorded result](./data/node-local-group.json) excludes payloads.
This is not a live Browser WebRTC jitter-buffer, hardware or network-loss gate.

Whole-source/engine teardown closes every snapshotted PC before awaiting shared
write retirement; a deterministic held-write-lock test covers that ordering.
Windows/Linux H264 producers mark independent recovery only with SPS/PPS/IDR;
macOS prepends its format's parameter sets and verifies an IDR. The Windows
sidecar compiles and links; Linux compiles in the retained 1 GB/2 vCPU VM.
Updated macOS code still needs an SDK build. No desktop capture was started.

The two-output packetization ablation measured 9.30-10.56 microseconds per 20 KiB
AU versus 4.90-5.29 for one packetizer on this machine, with about 53 KiB versus
26.5 KiB transient allocation. This is RTP work only, not extra encoding,
encryption or network cost. Keep independent output identities; no custom pool
or packet-header munger is justified by this measurement.

### Native Producer Boundary

The producer uses bounded per-output workers. Reuse one capture and
presentation decision; allow one processing and at most one pending raw input
per slot, not an unbounded encoded-frame queue. A slow MFT can currently wait
two seconds, so serially calling it for three slots is not an acceptable final
execution model. Derived-output validation is separate from user preset
validation, which intentionally rejects low representation dimensions/bitrates.

Real input-frame begin and layer identity travel through the coordinated capture
envelope without a legacy reader. Encoding does not synchronously await a Go
acknowledgement. Control wakeup and retained quiet input allow output activation
and keyframe requests without reopening capture; a request remains pending until
the codec produces independent recovery. Normal VP8 empty output is not a fatal
capture error or an encoded frame; its previous drop policy remains unchanged.

Each H264 slot needs its own activation object/MFT instance. Repeated
[`IMFActivate.ActivateObject`](https://learn.microsoft.com/en-us/windows/win32/api/mfobjects/nf-mfobjects-imfactivate-activateobject)
on the same activation returns the same instance, which would let independent
profiles overwrite one encoder. Share the D3D device/manager, not that instance.
Windows output workers now share one owned raw surface and isolate one processing
plus one pending input per encoder. A CPU-only check uses that production mailbox
with three real VP8 encoders; it verifies blocked-low isolation, bounded pending
work, sticky recovery, bitrate changes and activation retirement. A separate arm
of the same check verifies cancellation of a blocked production pipe writer.
macOS uses bounded VideoToolbox workers; Linux uses GStreamer raw tee/queues and
retains pipeline-level failure semantics. Compiler/CPU results are not driver
or desktop-media acceptance.

Received media reserves the original upper slot and creates only its missing
lower output on actual direct-child demand. Pion depacketizers and the pinned
LiveKit SDK SampleBuilder reconstruct complete AUs, including a single quiet
frame; the ordinary Pion SampleBuilder waits for a subsequent timestamp and is
not used for this real-time input. H264 configuration uses Pion's Annex-B reader.
The derived clock comes from the original sender report; decoder completion does
not establish a new timeline. Compression loss requests normal throttled PLI.
An overflowing bounded decoder input retires that output rather than blocking
raw forwarding or silently dropping reference frames.

The explicit `TestRelayDerivationFixture` uses the existing real 640x360 VP8
fixture and the actual Windows encoded-input sidecar. It proves zero decoder
startup for healthy raw forwarding, a shared 320x180 output for lower demand,
live preference replacement without closing the healthy edge, and process
retirement. This short synthetic codec run does not prove desktop capture,
hardware H264, Browser decode, game quality or public-network recovery.
Cold outputs use the framework's existing four-second screen-share bitrate
measurement window; the acceptance trace includes it rather than substituting
configured bitrate for a measurement.

Lowest-representation codec budgets now consume actual child video budgets;
they do not change the original or higher sibling outputs. Hardware overload,
extremely low bandwidth, real-game recovery and physical overhead still need
acceptance. A forwarding SFU does not invent a server-side transcoder.

The pinned full publication allocator has no public per-RID pause setting;
globally disabling pause would also force unaffordable upper encodings and is
not used. Native publication retains the framework's pause behavior when no
usable output fits, and below-lowest-layer parity remains unverified.

The real VP8 relay experiment at 6 Mbps -> 120 kbps -> 6 Mbps exposed a pause
while a live lowest encoder was being reduced below its nominal rate. Source-RTP
framing is now subtracted using actual access-unit/packet byte ratios and the
existing tracker window. The A/B changed only LiveKit's `allowPause` input
for an available lowest representation owned by a live local codec; raw forwarding
and zero-budget output retain pausing. Codec ownership is explicit and retired
with the encoder, not inferred from packets. The 30-second trace records actual
packet arrival and assembled-frame age separately; its receiver discards unresolved
older assembly on an independent VP8 keyframe. The original pause policy delivered
no low frames before release. Two unchanged local-codec-policy runs delivered
75 and 162 real 320x180 frames, with Chrome decoding all 573 and 620 weak-path
frames and all 891 healthy-path frames in each run. Each run used one derived
process. Low delivery began about 8-12 seconds after constraint; the second run
recovered high output 2.61 seconds after release. The healthy original remained
near 30 fps with about 26 ms packet age. Transition/retransmission age reached
seconds, so this verifies codec adaptation and eventual recovery, not smooth
low-bandwidth latency parity. The 500-packet assembly window also delayed frames
after an unrecoverable sequence hole: restored primary packets arrived in about
26 ms while assembly lagged over 20 seconds. Production relay input and the test
receiver now share recovery-boundary assembly: a newer codec-verified recovery
timestamp retires unresolved older data, retaining complete H264 configuration.
Focused RTP checks cover VP8/H264 loss, duplicate recovery packets and timestamp
wrap without another timer or packet queue.

### Native Feedback Probe

The explicit [GCC/TWCC probe](../../internal/app/mediaedge/testdata/gcc_feedback_probe.go)
and [recorded traces](./data/node-local-feedback.json)
use the pinned Pion interceptor v0.1.47, with its thresholds unchanged. Two
40-second memory-transport traces use a 6 Mbps -> 500 kbps -> 6 Mbps link,
20 ms propagation, a 120 ms queue limit and 100 ms feedback. Source bytes follow
the estimator; one arm caps released output at 1.25 Mbps. It is not encoded
video, a Browser receiver, a real network or a prediction of game quality.

| Cadence | Released low-capped output | Released budget-following output |
| --- | --- | --- |
| 30 fps frame bursts | Estimate 0.468 -> 4.334 Mbps; payload remains about 1.25 Mbps | Estimate 0.473 -> 4.397 Mbps; final receive about 4.195 Mbps |
| 5 ms packet budget | Final estimate 38.62 Mbps while payload remains about 1.25 Mbps | Final estimate about 1.87 Mbps |

No-prober does not prove permanent low-layer lock. The frame-burst run recovers
over almost 30 seconds; app-limited estimates may also grow beyond actual link
capacity. Therefore merely forwarding GetTargetBitrate to a codec is not evidence
of complete layer recovery or pacing. Keep the framework controller intact and
compare the selected complete media adapter against the same release trace.

Run the probe explicitly from the repository root, optionally with
`-frame-bursts`; it writes only ignored `build/embedded-media` diagnostics. It is
not a default unit/CI task. The observed cadence sensitivity is a reason to test
the real packet path, not to introduce a Piik congestion score.

### Embedded Service Composition

Hosted configuration supplies one concrete IPv4 STUN listener on UDP 3478,
or three on 3478/3479/3480 when prediction is enabled. `STUN_LISTEN_HOST`
defaults to `0.0.0.0` and is separate from HTTP binding. Existing `STUN_URLS`
remain advertised discovery addresses: their DNS may intentionally differ
from the Web origin, so they must not be resolved as local bind addresses.
The Local App constructor supplies no listeners; using public discovery
does not turn an App into a public STUN service.

The application binds HTTP and every required UDP listener before opening the
room database or accepting signaling. Failed startup returns all sockets;
the existing Close/End owner retires STUN too. No service supervisor or second
availability flag is needed. Deployment removes coturn in the final coordinated
cutover, not while the media implementation is still under acceptance.

The implementation candidate uses a thin Piik SFU with LiveKit **media-core
components**, without its RTC room or service. A stock-Pion compile and actual
ReceiverBase/DownTrack projection pass; two receiving PCs also demonstrate an
unaffected high-output sibling and high/low/high allocation under forced budgets.
That is not a measured-network congestion/retransmission pass. Compared with the
current mediaedge API executable, the stripped Windows API closure grows from
8,920,576 to 32,467,456 bytes. Narrow munger/selector imports still reach about
300 non-standard packages and omit the complete projection/allocator, so they do
not justify a separate partial extraction. inLive would require private-path
fixes and demand hooks beyond a thin adapter; do not maintain both candidates.

Keep the dependency behind a shared media package. For one video per connection,
use the public provisional allocation primitives, with exact typed child state
read by its parent; do not parse DebugInfo or run a second multi-track allocator.
The candidate now uses LiveKit SendSideBWE and Prober through their public APIs.
Pacing reuses the upstream queue with admission capped by the existing packet
cache bound; canceled probe tickets remain charged until actually dequeued.
The pinned Pion pacer's 1.5 headroom applies only to pacing, not codec or BWE
budgets. Adapted probe lifecycle code retains Apache-2.0 attribution. Probe
promotion requires the upstream validity criterion and non-congestion signal;
an empty or inconclusive attempt cannot promote the estimator's initial ceiling.

The explicit `TestTransportConstrainedDormantRecovery` virtual-network trace uses real
Pion RTP/TWCC through 6 Mbps -> 500 kbps -> 6 Mbps shaping. It measured a minimum
budget about 497 kbps, stopped the upper output, and restored sustained 1.20 Mbps
after release. Recovery occurred about 4.4 seconds after release in the recorded
run; this is a bounded local trace, not a success-rate or game-latency claim.
Ordinary focused checks cover NACK repair, no-RR probe admission, zero-write
termination and exact shutdown. Before runtime cutover, complete actual codec,
Browser and physical recovery checks rather than inferring them from this trace.
Desired maximum, available layers and current forwarding target remain distinct;
Dynacast is not proof that stopping every currently unselected high layer alone
provides recovery.

For dormant output admission, the parent can prepare a layer when a child's
fresh framework video budget covers that layer's existing configured ceiling.
The active prefix includes this preparation demand, the library target and the
still-forwarded incumbent. This is our small activation rule, not a new
congestion estimator or a fabricated measured bitrate. A prepared output becomes
selectable only through real codec output and the normal library allocation.
Configured ceilings are conservative and do not replace bandwidth probing;
no cache of historical layer rates or additional polling owner is introduced.

### Capture Contract For The Next Implementation

Use the existing LiveKit 2.22.1 screen-share construction as the initial output
set: original plus half-size at the same FPS, quarter bitrate with its 150 kbps
floor. Align derived NV12 dimensions down to even values. The group supports up
to three outputs, but this step does not invent a third product preset.

The private capture command/probe contract advances to v5. Video arguments retain
the source profile and append one `--output WIDTH HEIGHT FPS BITRATE` per output,
ordered low to high. All current producers/readers change together, without v4
fallback. Output profiles are codec bounds, not user preset choices.

SMED v2 has a 32-byte big-endian header: magic[0:4], version[4], kind[5], flags[6],
layer[7], timestamp100ns[8:16], duration100ns[16:24], width[24:26], height[26:28],
payload length[28:32]. Video carries its output dimensions. PCM/status dimensions
and layer are zero. Kind 5 is a zero-payload input-frame begin with dimensions/
layer/flags zero and a valid source timestamp/duration; it precedes all outputs
for that input even when the active prefix is zero. Kind 6 reports an unavailable
output layer with a bounded UTF-8 diagnostic, zero timing/dimensions/flags.

Both pipe directions use this envelope. Kind 7 carries one bounded ASCII control
command (at most 64 bytes), with all other header fields zero: `Q`, `K layer`
(`-1` means all outputs), `A activeCount`, `B layer bitrate`. Reuse the existing
command grammar instead of mixing a line reader with binary video on stdin. Keyframe
requests consumed at encode start are restored on failure; requests arriving
during encoding must not be erased when an older keyframe completes. Control
wakeup is I/O work, not another media-quality scheduler.

Every slot owns its encoder/converter. Windows must retain one safe copy of the
WGC input surface shared by slot workers, not reuse a returned frame-pool texture.
Output writing is serialized at the frame envelope, not by waiting for all
encoders. Source timestamps/presentation are computed once per captured input.

The same sidecar's encoded-input mode accepts complete H264/VP8 access units,
decodes once and feeds those same bounded raw-output workers. It is created only
for a missing demanded lower representation; healthy forwarding bypasses it.
Use system MFT/VideoToolbox/GStreamer decoding or the already bundled libvpx.
Compressed reference frames cannot use the raw mailbox's overwrite behavior:
loss or overflow requires normal decoder recovery and an upstream keyframe.
No additional local service, network port, selector UI or media clock is needed.

### Reproduce The Group Gate

Compile `native/capture/windows/encoded_group.fixture.cpp` with `vp8_encoder.cpp`
and the existing pinned libvpx build, using the same MSVC flags as the earlier
CPU probe. Generate its JSONL under `build/embedded-media`, then run:

```powershell
$env:PIIK_ENCODED_FIXTURE = 'build/embedded-media/encoded-group.fixture.jsonl'
$env:PIIK_ENCODED_OUTPUT = 'build/embedded-media/encoded-group.received.json'
& .\build\embedded-media\mediaedge.test.exe '-test.run=TestEncodedGroupVP8Fixture' '-test.v' '-test.timeout=30s'
node scripts/encoded-group-decode.mjs
```

Open the printed loopback URL in isolated Chrome; the decoder gate saves its
result and stops its own server. Neither codec generation nor this browser gate
is a new default CI job. The synthetic fixtures remain generated build output.
