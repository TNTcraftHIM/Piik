# Node-Local Media Design Evidence

The initial experiments date from 2026-09-07. This document records their
tradeoffs, the shared Native/SFU implementation boundaries and subsequent
recovery evidence. [ADR-0013](../adr/0013-embedded-node-local-media.md) owns the
accepted model; [media quality](../standards/media-quality.md) owns current
behavior. The architecture is published. [Verification status](../verification-status.md)
retains unresolved physical limits; controlled results do not establish a
diagnosis for unmatched field reports.

The 2026-09-08 [WebRTC encoder-pool review](./webrtc-encoder-pool.md) qualifies
the original fixed-output experiment: output construction and forwarding
allocation do not include Browser encoder resource adaptation. The maximum-demand ownership model
remains accepted; the implementation uses complete adaptive pipelines for
incompatible child budgets, as specified in ADR-0013. Sharing an encoder alone
does not establish quality parity.

## Recommendation From The Experiments

The first comparison favored a bounded maximum-demand envelope over an
exact-demand warm pool. Framework capacity/layer selection chooses what each
child can receive; a group retains outputs through its highest needed level.
The later adaptive-output boundary separates incompatible budgets while sharing
equal effective requests. The original one-group experiment is not a limit on
that implementation.

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

| Module / primary source | Responsibility | Boundary |
| --- | --- | --- |
| Piik `mediaedge.Source`, `Edge`, Native capture generations | Encoded-source ownership and existing share/route identity | The shared forwarding adapter owns transport integration; capture does not own routing |
| Pion PeerConnections and RTP/RTCP interceptors | ICE, encryption, packetization and feedback | Each connection retains its packet and feedback identity |
| [LiveKit media components](https://github.com/livekit/livekit/tree/v1.13.6/pkg/sfu) | Bandwidth estimation, allocation, layer selection, RTP projection and recovery probing | Narrow adapter; scoped upstream repairs and their removal gates live in [dependency provenance](../../internal/thirdparty/README.md) |
| [libwebrtc encoder pipeline](./webrtc-encoder-pool.md) | Rate/resource adaptation for each shared local output | A complete pipeline owns its codec lifetime; a codec cache alone cannot provide equivalent adaptation |
| MFT/VideoToolbox/GStreamer/libvpx capture adapters and [libyuv](https://chromium.googlesource.com/libyuv/libyuv/+/refs/heads/main/README.md) | Platform capture, conversion/scaling and encoding | Received-source decoding and GPU surface sharing remain real work; physical cost is platform-dependent |
| [GStreamer tee](https://gstreamer.freedesktop.org/documentation/coreelements/tee.html) / [queue](https://gstreamer.freedesktop.org/documentation/coreelements/queue.html) | Shared frame ownership with branch isolation on Linux | Default queue sizes are not accepted latency budgets |

Upstream licenses and notices remain part of the packaged artifacts; Piik's MIT
license does not replace them. [TODO](../todo.md) owns remaining work, and
[verification status](../verification-status.md) separates controlled evidence
from physical capture, game cadence and public-network acceptance.

## Current Implementation Boundary

`internal/media/forwarding` owns the shared input buffers, typed single-video
allocation and outgoing transport adapter. Native Source/Edge use it. Pion owns
ICE, crypto and reports; LiveKit media components own send-side BWE,
allocation primitives, RTP projection and video retransmission. A bounded pacing
adapter owns packet admission/retirement; a single-video event driver adapts the
upstream probe lifecycle without another congestion formula or application timer.
The [dependency repair notes](../../internal/thirdparty/README.md) identify the
scoped upstream corrections. There is no mirrored counter summing unused layers.

Source subscription must retain layer discovery that happens during registration.
LiveKit's `ReceiverBase.AddDownTrack` delivers initial layer metadata before
registering the subscriber, leaving a notification gap. The shared Source
refreshes that metadata after successful registration; DownTrack keeps its
highest observed layers, so a concurrent newer notification cannot be undone.
This boundary serves both Native outputs and SFU publication. A controlled
discovery in that gap reproduces the failure without retries or network loss;
it does not establish the cause of unmatched field reports.

The parent reads child state at actual capture InputBegin. A controlled layer
switch uses the existing DownTrack resync before outputs for that input, retaining
its target; this prevents an old-layer packet winning the same presentation time.
Raw RTP has no such honest input boundary and uses ordinary mature projection,
without decode or whole-frame repacketization. Inbound video padding is consumed
by projection while outbound sequence continuity remains intact. Incoming sender
reports retain their source-clock relation; local codec outputs correlate to one
input anchor, not independently to each encoder's completion time.

Outgoing video sender reports and RR/RTT accounting share the DownTrack owner.
Pion supplies the loop at LiveKit's three-second cadence; audio retains Pion
reports. RTX therefore cannot corrupt the primary clock, and feedback matches
the owner that sent the report. Real RTCP checks cover probing, pause/resume
and RTT; constrained checks also cover source replacement. Field logs confirmed
that a corrupted upstream RTP/NTP reference can block layer changes despite
restored capacity. A failed downgrade can stop forwarding while the input still
advances; resuming that input then exposes sequence gaps and RR rollover
adjustments. Sender-feed gaps and receiver-reported loss are distinct from
physical network loss. ICE reconnect retains the source reference; update App
and Server.

Local capture replacement keeps its RTP source and cumulative counters while
rebasing only the input packetizers. It must not also restart the RTP projector.
Unconnected edges reserve child slots without asking for output. Video capacity
comes from its tracked traffic; untracked audio must not be subtracted again.

The initial multi-output experiment supplied three real libvpx outputs to the
same Native source API: 96 encoded AUs, two unchanged Pion connections, 40 selected
frames each, and 40/40 Chrome WebCodecs decodes at the expected dimensions and
timestamps. [Recorded result](./data/node-local-group.json) excludes payloads.
This is not a live Browser WebRTC jitter-buffer, hardware or network-loss gate.

Whole-source/engine teardown closes every snapshotted PC before awaiting shared
write retirement; a deterministic held-write-lock test covers that ordering.
Windows/Linux H264 producers mark independent recovery only with SPS/PPS/IDR;
macOS prepends its format's parameter sets and verifies an IDR. Current capture
contract and acceptance boundaries are indexed by [status](../status.md);
the initial fixture did not exercise desktop capture.

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
live preference replacement, input-size round trips and process retirement
without replacing either edge. Four 640x360/320x180 input transitions delivered
five new pictures to both children within 0.47–0.53 seconds each; raw/derived
sizes stayed paired at 640/320 or 320/160. A bounded recording decoded all 59/20
complete received pictures in Chrome 152 WebCodecs. This synthetic codec check
does not prove desktop capture, hardware H264, Browser WebRTC playout, game
quality or public-network recovery.
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

The later coupled P2P controls on 2026-10-15 exposed the complementary gap:
an independent frame could bypass old assembly, but a lost frame could delay
the request for that recovery until the packet window filled. The current
4,096-packet capacity protects large access units; at a low packet rate it is
not a suitable playout deadline. The shared relay input now uses the existing
assembler's forced-pop operation after one second of advancing RTP media time
without assembly progress, notifying its existing recovery owner before any
dependent frame can be consumed. Complete quiet frames still emit immediately;
quiet intervals, reordering and clock wrap do not add a wall-clock timer.

The actual Windows VP8 encoder consumed live P2P budgets over a 12 Mbps,
20 ms vnet path, with three one-second 400 kbps limits. With 7.5 KB and 75 KB
network queues, the longest complete-frame gaps changed from 21.9 / 21.6 seconds
to 1.5 / 1.2 seconds; both repaired runs ended near 30 fps at 1080p.
Chrome WebCodecs decoded all 3,443 / 3,418 received pictures respectively;
this checks the assembled bitstreams, not Browser WebRTC playout.
These are separate serial runs, not a statistical latency guarantee. Regression
controls independently reproduce both missing-whole-frame and partial-frame
waiting for VP8/H264. This correction belongs to Native relay derivation;
ordinary Browser P2P has its own receiver/jitter buffer. It does not establish
the cause of an unmatched field report or fix encoder resolution hysteresis.

Received-size updates exposed another Native relay boundary: `WriteRTP` called
the full profile updater whenever an upstream keyframe changed dimensions.
LiveKit's [track-info update](https://github.com/livekit/livekit/blob/c4733475fd9c/pkg/sfu/streamtrackermanager.go#L375)
also reapplies mute state, resetting active trackers and their measured rates.
The RTP regression reproduced this for both the original and a separate derived
group. Received dimensions now use the same immutable metadata update as Native
capture; each derived output publishes its own actual dimensions. Host profile
changes retain their separate configuration path. The old implementation fails
the warmed-stream regression; the repair preserves both layers' active status
and bitrate history through down/up size changes. This removes a repeated loss
of allocation evidence, not the upstream encoder's adaptation delay.

Recovery-boundary cleanup must also retire its loss callback. Previously,
discarding an old incomplete frame requested another keyframe after its
replacement had arrived. LiveKit's [PLI handling](https://github.com/livekit/livekit/blob/c4733475fd9c/pkg/sfu/downtrack.go#L2074)
pauses retransmission until a subsequent keyframe, so this stale request could
interrupt current recovery. The callback now belongs to the current assembler
identity; completed H264 configuration is still retained. VP8/H264 regressions
fail before this change and verify that genuine loss in a later keyframe still
requests recovery. No retransmission policy, encoder threshold or timer changed.
Two serial 120-second Windows H264/Pion trials used the App's codec/RTX setup,
1080p30 at 5 Mbps and a 12 Mbps, 20 ms path with 1% forward RTP loss for 30 seconds.
Before repair, assembly loss notifications were 4 / 118 and longest complete-AU
gaps were 0.41 / 1.15 seconds; after repair they were 0 / 0 and 0.40 / 0.41 seconds.
All four retained 1080p. Chrome WebCodecs decoded all 3,562 pictures from the first
repaired run. This isolates stale recovery feedback, not loss-free delivery,
Browser WebRTC playout or an improvement percentage for public networks.

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
availability flag is needed.

The implementation uses a thin Piik SFU with LiveKit **media-core components**,
without its RTC room or service. The initial stock-Pion/LiveKit comparison passed
compilation and ReceiverBase/DownTrack projection; two receiving PCs demonstrated an
unaffected high-output sibling and high/low/high allocation under forced budgets.
That comparison did not measure network congestion/retransmission. Relative to
the then-current mediaedge API executable, the stripped Windows API closure grew from
8,920,576 to 32,467,456 bytes. Narrow munger/selector imports still reach about
300 non-standard packages and omit the complete projection/allocator, so they do
not justify a separate partial extraction. inLive would require private-path
fixes and demand hooks beyond a thin adapter; do not maintain both candidates.

Keep the dependency behind a shared media package. For one video per connection,
use the public provisional allocation primitives, with exact typed child state
read by its parent; do not parse DebugInfo or run a second multi-track allocator.
The adapter uses LiveKit SendSideBWE and Prober through their public APIs,
with the [scoped measurement repair](../../internal/thirdparty/README.md#livekit-send-side-bandwidth-estimation).
Packet timing uses the existing LiveKit SDK leaky-bucket pacer; the SFU writer
retains RTP extensions, TWCC identity, probe accounting and packet-pool ownership.
Native encoders emit whole access units, whereas the SFU's `NoQueue` path assumes
input already paced by its publisher. Admission stays capped by the existing
packet cache bound; canceled probe tickets remain charged until actually
dequeued. Congestion estimation, probes and codec/allocation budgets retain their
existing owners.
Adapted probe lifecycle code retains Apache-2.0 attribution. Probe
promotion requires the upstream validity criterion and non-congestion signal;
an empty or inconclusive attempt cannot promote the estimator's initial ceiling.

#### Send Queue Recovery

Delayed loss repair needs negotiated RTX on both single-child forwarding and
Native SFU publication. Reusing the primary sequence space causes sufficiently
late retransmissions to fail SRTP replay checks. A real Pion simulcast control
drops a packet, delivers 96 newer packets, then requests repair; it fails without
RTX and passes with the shared codec registration. Simulcast repair also carries
the matching MID and [repaired stream identifier](https://www.rfc-editor.org/rfc/rfc8852.html#section-3)
on its repair SSRC. Removing those headers independently fails the same control.
Pion and LiveKit continue to own replay protection and retransmission; no replay
window relaxation or second repair loop is needed.

A bounded writer-stall control exposes a limitation in the former SFU queue:
after the estimate falls from 500 to 8 kbps, only three of 32 already-encoded
packets drain in two seconds. The upstream unthrottled writer drains the same
input once the writer resumes. A separate real Windows VP8 codec and
Native forwarding control reproduces stale decoded pictures after roughly one
second of ordinary UDP loss; the packet-count cap alone does not prevent this.
The retained SDK queue also passes that stalled-writer control: its 200 ms
drain target increases pacing when an old low estimate would trap queued frames.
That target is not a hard latency bound.
The [ordinary media controls](./nat-traversal.md#recovery-ownership-and-forwarding)
retain the decoded-picture and address-change evidence boundary.

The complementary healthy-network control emits 5 Mbps as 30 whole frames per
second over a 12 Mbps link with a shallow 7.5 KB queue. `NoQueue` repeatedly loses
parts of those bursts and reduces allocation despite sufficient average capacity;
the paced control retains its high output and 5 Mbps committed budget. A 5 ms
service interval still batches too much for this fixture; 3 ms passes with
Pion's existing 1.5 pacing headroom. This follows the
[WebRTC distinction between average frame rate and packet bursts](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/pacing/g3doc/index.md).
Both queue controls must pass; correcting old-packet delay alone does not
establish healthy Native sending.

Allocation also distinguishes source measurements from changed capacity. A
stable 1 Mbps connection must not drop its output merely because that source's
measurement changes from 900 kbps to 1.05 Mbps, or because a lower output's
measurement window becomes available first. The adapter now follows LiveKit's
stable optimal/cooperative allocation paths; an actual lower committed capacity
still constrains the allocation. The focused control checks both retention and
real downgrades, while the frame-burst trace requires uninterrupted high output
after startup. Native categorical quality reads those allocation restrictions
and ordinary congestion, not the ratio of instantaneous traffic to capacity.

Congestion callbacks could also promote the estimator's unmeasured 100 Mbps
initial capacity while a probe was pending. Outside a recovery probe, congestion
can reduce the committed budget; a valid completed non-congesting probe owns
increases. Congestion during sending or settling ends exploration without cutting
the established media budget. Both single-child transport and the publication's
encoder-facing budget retain this rule; the upstream publication allocator's
guard alone does not protect a separate encoder consumer.
This follows the
[upstream distinction between congestion events and completed probes](https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/streamallocator/streamallocator.go),
without introducing another estimator.

Two upstream measurement defects also affect completed probes. The pinned
[finalizer](https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/bwe/sendsidebwe/congestion_detector.go)
returns retained capacity, initially 100 Mbps, rather than the current probe's
acknowledged rate; no feedback can also be classified as non-congesting. The
[probe packet group](https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/bwe/sendsidebwe/probe_packet_group.go)
includes the transport's preceding idle interval in the new measurement window.
An 800 kbps probe after five idle seconds therefore either promotes 100 Mbps or,
with only the return-value correction, fails to restore the existing budget.
The scoped repair returns only current probe evidence, marks invalid or
unacknowledged probes inconclusive, and starts timing at the first acknowledged
probe packet. Removing either correction fails the real-TWCC regression. These
changes preserve upstream estimation, loss handling and probe scheduling.

Probe padding has no media payload; its size belongs to `Header.PaddingSize`
and Pion serializes it once. The pinned LiveKit revision includes
[upstream #4993](https://github.com/livekit/livekit/pull/4993), so Piik's former
payload-stripping writer is removed. The SDK scheduling proxy still accounts
for those wire bytes because its size calculation omits RTP padding; only the
original packet reaches serialization and TWCC. Both publication and
single-child forwarding use this boundary. Regressions check the actual empty
RTP payload after SRTP delivery and equal scheduled/written byte counts.

Long pauses expose a separate publication recovery failure: the last forwarded
packets leave the source's bounded cache while new capture frames keep arriving.
RTX-based probing then writes nothing and cannot finish. The pin includes
[upstream #5013](https://github.com/livekit/livekit/pull/5013), which uses padding
when no cached RTX probe payload is available. A 2026-10-15 retained-connection
control held a raw 300 kbps source at a 120 kbps link for 22 seconds, then restored
6 Mbps. The previous dependency remained at zero video through the 18-second
recovery observation; the updated dependency and serialization adapter restored
about 294 kbps after eight seconds. The ordinary regression expires the actual
cache while allocation is paused and fails against the previous dependency.
This repairs probe delivery, not the separate encoder-demand boundary below.

The explicit `TestTransportConstrainedDormantRecovery` virtual-network trace uses
real Pion RTP/TWCC through 6 Mbps -> 500 kbps -> 6 Mbps shaping. The repaired
library restores sustained 1.20 Mbps video after release, with a budget assertion
that rejects the unmeasured initial capacity. Earlier passing recovery traces
could promote 100 Mbps and do not establish correct budgeting. Earlier
flaky comparisons also registered TWCC twice on the receiver, duplicating
feedback; those results do not rank the queues. Product receivers already use
the single default interceptor owner.

A 2026-10-15 periodic variant retained the same transport for 68 seconds, with
one-second 500 kbps limits starting at 12, 22 and 32 seconds and 6 Mbps otherwise.
The declared outputs were 300 kbps and 1.2 Mbps. Each pulse selected the lower
output; the higher output returned about 3--8 seconds after release, and final
delivery remained about 1.18 Mbps. Thus one-second congestion can affect delivery
for longer without losing recovery demand. This exercises actual RTP/TWCC,
allocation, probing and activation, but uses synthetic video payloads without a
codec or decoder; it cannot measure resolution-recovery delay or perceptual blur.
The [Browser comparisons](./browser-local-encoding-pool.md#sustained-h264-recovery)
separately demonstrate encoder lag after allocation recovers. Neither experiment
establishes that all short disturbances deserve a slower congestion response.

Partial recovery exposed a second adapter omission: a rate-controlled local
output can remain below its own ceiling without needing another spatial layer.
Probe demand now includes that unmet current-output demand, including when no
higher output exists. Raw forwarding cannot change its encoder and keeps the
existing layer-selection rule. In a matched retained-connection control,
6 Mbps -> 120 kbps -> 800 kbps -> 6 Mbps, the former adapter stays near 74 kbps
through the partial restoration; the corrected adapter restores its 300 kbps
output before the 1.2 Mbps output fits. Both eventually restore the higher output.
The retained network gate checks the intermediate phase as well as final recovery.
A separate two-child control uses real Windows VP8 encoding and Browser decoding:
the constrained child recovers after release while the healthy child retains its
original dimensions. These checks do not establish the cause of an unmatched
physical Host's low-resolution session.

Native publication exposed a separate boundary: the full allocator probes
spatial deficiency, so it can stop exploring once a sole active RID fits at its
reduced encoding. Single-output and two-declared-RID controls both reproduced it.
[LiveKit #5016](https://github.com/livekit/livekit/pull/5016) adds explicit unmet
encoder demand to that allocator's existing padding probe. Demand is
withdrawn for inactive/retired or sufficiently allocated output; desired output
never replaces measured bitrate or capacity. Piik now uses this input.
Encoder demand must not mark ordinary tracks deficient: a real DownTrack
allocation control reproduces a blocked layer upgrade despite spare capacity
when the two meanings are combined. Demand is checked by the existing periodic
event; track allocation retains its own state. Unmet encoder demand also uses
the allocator's existing idle/congested recovery when output stops. Withdrawing
the last demand stops its active padding probe; deficient tracks still retain
theirs. Regression controls reproduce both omissions while preserving the
pause, idle, probe-mode and capacity gates. Resetting BWE does not itself raise
the encoder budget; measured probe feedback remains necessary.
[Provenance and removal](../../internal/thirdparty/README.md#local-encoder-probe-demand)
own the temporary pin. Piik does not copy the complete allocator or add a probe
owner. `SetChannelCapacity` is not a substitute: it overrides capacity and
disables probing. A minimum-capacity setting would not prove measured recovery.

Publication's residual budget can legitimately reach zero when upper outputs
consume the available allocation. The native adapter must preserve that result,
using its existing encoder minimum, instead of restoring the configured ceiling.
Otherwise the low output can appear fully satisfied and suppress its recovery
probe. A real RTP/allocation regression also checks that retiring the upper output
returns budget to the same lower output without reconnecting.

Matched 60-second controls retained one rate-controlled output, 30 generated
frames/s and the same connection. Impairment lowered a 6 Mbps link to 120 kbps;
the 5 Mbps output control used a 12 Mbps link. Recovery required five consecutive
one-second windows above 90% of demand, at least 27 recent frame arrivals/s and
frame-age P95 below 100 ms; delayed bursts did not count.

| Impairment | Before: final payload | With demand input: final payload | Recovery observation |
| --- | --- | --- | --- |
| None | 294.1 kbps | 294.2 kbps | Both stable; no probes |
| One 1-second pulse | 294.2 kbps | 294.2 kbps | Both restored; about 2 seconds |
| Three 1-second pulses, 10 seconds apart | 294.2 kbps | 294.2 kbps | Both restored; about 2 seconds after the last pulse |
| 22 seconds of sustained congestion | 230.8 kbps | 294.7 kbps | Before remained limited for the 30-second observation; candidate recovered in about 11 seconds |
| Same sustained constraint, 5 Mbps output | 1.10 Mbps | 4.95 Mbps | Before remained limited; candidate recovered in about 12 seconds |

Final windows retained 30 frame arrivals/s, with per-window frame-age P95 below
37 ms for the candidates. These synthetic RTP measurements are not decoded
quality or a field diagnosis. The [real encoder replay](./webrtc-encoder-pool.md#budget-restoration)
separately measures the resulting resolution. The retained publication gate also
passes pause/resume and source replacement. Nil/disabled callbacks and media
probing retain their policy; removing demand fails the upstream regressions.
Short-pulse controls do not justify importing another product's cadence
thresholds into congestion response.

Live audio changes exposed a related scope mismatch: Piik's TWCC tracks only
video, but the adapter deducted audio from that measured capacity and included
audio in expected probe usage. After restoring 320 kbps Opus, this could remove
an already recovered video layer on a healthy 6 Mbps link. The adapter now uses
the measured video capacity directly, matching the upstream allocator's
video-only usage accounting. Native and SFU share this rule; diagnostics retain
video capacity and total traffic as separate facts. Opus rate and transport
behavior are unchanged. The retained
network gate exercises video-only and real Opus 320/96/320 kbps cases, requiring
sustained high video and decoded audio after recovery. The former subtraction
fails a matched trace but can be masked by later probe traffic; a passing
recovery alone does not establish correct accounting. This is not proof of
perceptual audio quality or behavior on every physical network.

No reset, retry owner or minimum quality is added. These are bounded local traces,
not a field diagnosis, success-rate or game-latency claim.
Ordinary focused checks cover NACK repair, no-RR probe admission, zero-write
termination and exact shutdown. These checks do not establish physical recovery
outside the [verified boundaries](../verification-status.md).
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

A 2026-10-15 raw-forwarding arm of the same network gate checks this boundary
without a local rate-controlled encoder. The 6 Mbps -> 500 kbps -> 6 Mbps link
stops the higher output and then restores about 1.18 Mbps on the retained
connection. Removing only dormant-output probe demand in an isolated control
leaves about 294 kbps, no active probe and no higher output after release.
The fixture uses the production `RequiredActiveCount` to activate outputs;
configured demand never substitutes for measured source bitrate. This verifies
the shared forwarding adapter used by SFU subscribers, not a complete hosted
Browser/SFU session or a field-report diagnosis.

### Capture Boundary

Output construction follows the [media-quality owner](../standards/media-quality.md):
original plus a half-size output at the same FPS, with lower bitrate bounded by
the source ceiling. Derived NV12 dimensions round down to even values. The
group's bounded output slots do not add product presets.

The current [capture reader](../../internal/app/nativecapture/protocol.go) owns
frame layout, kind-specific validation and allocation limits; [status](../status.md)
owns the matched bundle's protocol versions. Both pipe directions use that framed
boundary. Input-frame events precede per-output results, including when no output
is active; a lower-output failure remains distinct from loss of the source.
Keyframe requests consumed at encode start are restored on failure; requests
arriving during encoding must survive an older keyframe completing. Control wakeup
is I/O work, not another media-quality scheduler.

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
