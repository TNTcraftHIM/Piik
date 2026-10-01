# Browser Node-Local Encoding Pool

Initial baseline: 2026-09-09 on Windows, Chrome 152.0.7977.82.
[ADR-0014](../adr/0014-browser-node-local-encoding-pool.md) owns the selected
design. Dated follow-ups identify their own Browser and workload boundaries;
[status](../status.md) owns current adoption and release state, and
[verification status](../verification-status.md) owns remaining physical limits.

## Result And Scope

An independent local WebRTC producer can supply compatible direct children
without making one real child the encoding authority. Each child's existing
connection retains RTP, ICE, congestion control and recovery. Different weak
demands can require separate local producers; healthy siblings keep their
original producer. There is no ancestor cache or application quality ladder.

The selected Chromium encoded-stream path copies the producer's payload, type
and exposed codec metadata, assigning the outgoing carrier's RTP timestamp.
Native scaling on a source clone bootstraps each carrier. After the first real
producer frame, its existing sender switches to a CPU-resident 16x16 Canvas
track driven by producer events. It does not first warm another full-size
encoder, and there is no independent carrier timer. Unsupported APIs and failed
pooling retain ordinary senders.
The original capture/received track is never replaced by a carrier.

This is one full encode plus small carrier encodes for compatible children,
not literally one encoder or one Encode call. Each producer also has a local
connection and receiver decoder. Browser relay reuses its local encoded output
across direct children; it still decodes/re-encodes its received source.

## Why The Earlier Implementations Were Removed

- Borrowing a real child's encoder couples siblings to that child's adaptation.
  It does not test an independent producer.
- Quiet placeholders omit native sender accounting and do not provide a usable
  clock. They are not a zero-cost product implementation.
- Standard own-frame payload replacement can transmit real pictures, but retains
  carrier metadata. At 1080p, VP8 intermittently stalled. Extra carrier key-type
  rendezvous and a canvas clock did not establish reliable parity.
- The selected complete-frame API removes that Worker and key-type rendezvous.
  It preserves exposed metadata, not every internal native capture timestamp;
  played-audio and source-age measurements remain necessary.
- Starting two full ordinary encoders before pooling caused a transient extra
  encoding load and, in one run, 500-700 ms early played-audio lag. Starting the
  tiny carrier immediately removed that unnecessary warmup; the next VP8
  1080p check measured offsets between about -64 and +42 ms.
- Hand-subtracting audio/repair from available BWE introduced another inaccurate
  allocator. The pool now uses the existing sender's native video payload
  target, bounded by Host settings. This is not the same unit conversion as
  Native's measured RTP-to-codec budget, which remains necessary.
- Scaling the full received H264 track for each tiny carrier retained substantial
  processing cost. Replacing that input with a CPU-resident Canvas, driven only
  by producer frames, reduced the six-second relay fixture from 7.27 to 5.36
  CPU-seconds; ordinary relay used 5.39. Summed relay encoding time fell from
  about 4,840 to 1,177 ms (ordinary: 2,268 ms). This removes the extra cost rather
  than claiming a total CPU win. Picture-age p95 was 124/161 ms versus 43/49 ms
  for ordinary relay; no additional timing controller was added to chase it.
- A waiting member must replan when a shared producer outgrows its allocation.
  An already-available better healthy output must not require its old encoder
  to recover first. Both conditions produced failed startup checks; the fixes
  reuse membership and the existing output comparison, without a new timer.

The replaced experiments and selected original measurements remain recoverable
at Git checkpoint `4e3de79`; runtime code and the runner keep only the selected
implementation. Failed cases are evidence, not acceptance passes.

## Current Executed Evidence

The [selected summaries](./data/browser-local-pool.json) retain exact fixture
hashes, raw artifact names, delivered frames, source ages and limitations.
The actual `HostPeer` and pool are bundled into the fixture; it does not copy
their implementation. All workloads ran serially.

| Actual product path | Observed result |
| --- | --- |
| VP8, 1080p30, 400 kbps constrained A | A reached 480x270 and returned to 1080p; B kept 1080p. A decoded 195 frames in 14 constrained seconds and 981 in 40 recovery seconds. |
| H264, same constraint | A reached 960x540 and returned to 1080p; B kept 1080p. A decoded 366 and 1,165 frames in the corresponding windows. |
| Both codecs, live settings | 720p60, quiet-source 480p30, pause, resume and new source delivered the requested ceilings without replacing the outgoing connections. |
| Producer failure | Both codecs returned to ordinary sending on the existing connections; VP8 delivered 181 frames per child in six seconds, with no retained groups. |
| VP8, late child | Both children shared the existing producer and decoded fresh 1080p, without backward source IDs. |
| VP8, received-track relay | One local producer supplied two children at 1080p; source-age p95 was about 71/122 ms, with played audio present. |
| Actual hidden page | Native fake source continued at its available 20 fps; both receivers decoded 200 frames in ten seconds. The first run had a temporary profile-cleanup failure, recorded separately from media behavior. |

The source generates moving bars and a frame-ID barcode. It is not a game
perceptual-quality benchmark. Played audio is recaptured from the receiving
video element; this is element-level synchronization, not physical speakers
or display scanout. Hidden-page checks use a native fake source because a
background canvas timer is itself throttled. They establish neither real-game
60 fps endurance nor background audio timing.

The constrained runs use a test-only forward UDP bridge with about 250 ms
maximum queued service; reverse feedback is unshaped. They are not a model of
public NAT, geographic RTT or every congestion/loss pattern. Reduced quality
and temporary stalls under real constraints remain possible.

A 2026-09-30 actual-tab fault check separated A at 400 kbps from healthy B,
then failed only A's producer. Both H264 and VP8 retained the outgoing
connections, returned to ordinary encoding and retired all pooled groups.
B retained 1904x1048 at about 30 fps; its largest observed frame-callback gap
around fallback was 271 ms for H264 and 80 ms for VP8. Source-wide fallback
therefore has a measurable handoff cost, even without a resolution drop or
connection failure. This does not establish low-end hardware capacity.

### Balanced Startup And Recovery

Serial Chrome 152 checks on 2026-09-25 reproduced two composition defects in
VP8, 1080p30, motion + balanced, with a 5 Mbps ceiling. A forward-only UDP
shaper limited A to 400 kbps; B remained unshaped. These synthetic-source runs
establish delivered dimensions and recovery, not game perceptual quality or the
cause of reports without diagnostics.

- A group's local warmup spent its five-frame startup protection before any
  child published its frames. Restoring balanced then allowed native initial
  downscaling against an untrained allocation. Protection now begins at the
  first committed outgoing frame; paused/empty frames cannot spend it and later
  children cannot reset it. The frame threshold and polling cadence are unchanged.
- The synthetic carrier used motion content intent. Chromium classifies that
  as realtime video, without the default screen-content ALR probing. After a
  producer adapted downward, low real output could leave the outgoing native
  bandwidth estimate slow to recover. The carrier now uses detail once at
  construction, selecting the framework's screen-content behavior. The real
  producer retains motion and the Host's degradation preference.

Pinned WebRTC explains both boundaries: starting the quality scaler
[restarts initial frame dropping](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/adaptation/video_stream_encoder_resource_manager.cc#230);
[content hints select the screencast option](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/pc/rtp_sender.cc#1423),
which selects [ALR probing configuration](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/video_send_stream_impl.cc#183).
The [screen probing default is enabled](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/rtc_base/experiments/alr_experiment.cc#51).
Detail also changes the tiny encoder's content type; it is not an independent
public probing switch or a request to change the real picture's quality.

| VP8, 14-second constraint / 40-second recovery | Initial A / B | Constrained A / B | Recovered A / B |
| --- | --- | --- | --- |
| Ordinary | 1080p / 1080p | 540p / 1080p | 1080p / 1080p |
| Previous pool | 270p / 270p | 270p / 540p | 720p / 1080p |
| Publication-start correction alone | 1080p / 1080p | 270p / 1080p | 540p / 1080p |
| Publication start + screen-content carrier | 1080p / 1080p | 270p / 1080p | 1080p / 1080p |

The combined VP8 run returned to 1080p about 17 seconds after shaping ended.
H264 with played audio also returned to 1080p; its unconstrained child retained
1080p throughout. A separate one-second pulse after 45 healthy seconds still
caused native downscaling: the repaired VP8/audio path briefly reached 180p,
then regained 1080p about 13 seconds after pulse start. The previous pool's
no-audio pulse ended the 40-second recovery at 360p. Audio changes the bandwidth
composition, so these pulse runs do not establish an exact speedup. Normal
WebRTC can also temporarily reduce resolution after a pulse; this repair does
not promise blur-free delivery under changing network or device load.

A single-consumer control, retaining its mature producer, recovered without
the deeper dual-consumer drop. Together with the publication-start control,
this distinguishes cold producer adaptation from repeated producer churn.
The rate-owner repair separately retains existing encoders through output-rate
spikes and shared budget changes; a genuinely weaker child can still need its
own producer. No delayed-budget policy, bitrate floor or manual recovery probe
was added. Probe padding remains framework-owned traffic under native limits.

Matched short-pulse checks on Windows Chrome 152 used the same synthetic
1080p30 source, two children, played audio and `balanced` preference in both
paths: 45 healthy seconds, A constrained to 400 kbps for one second, then 40
seconds of recovery. B was unconstrained. Each codec's ordinary/pool pair used
the same probe bundle; these are single-run observations, not averages.

| Codec / path | A's lowest decoded size | A regained 1080p after pulse start |
| --- | --- | --- |
| VP8 / ordinary | 1280x720 | 20.2 s |
| VP8 / pool | 480x270 | 12.7 s |
| H264 / ordinary | 1280x720 | 23.3 s |
| H264 / pool | 1280x720 | 7.7 s |

B retained 1080p throughout all four runs, with no reported connection failure.
The pooled traces created one separate producer for constrained A, then rejoined
the retained healthy producer; they did not show repeated producer churn.
The deeper VP8 dip is a measured adaptation tradeoff, not by itself a confirmed
defect or a requirement to impose a resolution floor. These results do not
establish the cause of an unknown reporter's blur or stream loss, nor test Native
capture's separate keyframe-request path. Any further change must preserve
healthy-child isolation and framework-owned adaptation.

A further control retained two separate producers from startup, disallowing
cross-member group compatibility only in an ignored copy of the same probe.
With the same VP8 source, audio and pulse schedule, A reached 720p at 4.7 seconds
and regained 1080p at 24.8 seconds; B stayed at 1080p and both producers retained
their identity. No connection error was recorded. This supports a cold-producer
cost alongside ordinary adaptation, without establishing a population average.
Keeping every producer separate sacrifices sharing; reversing the handoff would
instead move a healthy child onto a cold encoder. Neither is an accepted fix.

Further serial checks on 2026-09-27 found avoidable handoff latency: successful
preparation and budget updates waited for another 500 ms sample before
re-evaluating membership. A falling budget could repeatedly fail the comparison
against the previous applied limit while the old high-rate output kept sending.
Both completions now invoke the existing coordinator; a successfully written
recovery frame still commits selection. Sampling cadence, budget source and
healthy-child isolation are unchanged.

With duplicate carrier filtering removed in both runs, the VP8/audio pulse's
cold-producer preparation-to-selection interval was 1,712 ms before this repair
and 67 ms afterward. A regained 1080p at 12.7 s and 9.2 s after pulse start
respectively; B stayed at 1080p. The final run had no queue overflow, backward
source IDs or missed played-audio pulses. These are single-run observations,
not an average recovery guarantee. Both reached 270p during adaptation. A final H264
pulse reached 720p and regained 1080p at 6.7 s; B stayed at 1080p and neither
output overflowed its queue.

The remaining dip is consistent with a new encoder adapting at an already-low
allocation. Pinned WebRTC's [initial size check](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/video_stream_encoder.cc#2535)
uses the native startup allocation separately from encoder overshoot correction; restoring balanced
restarts that initial check as described above. Local traces also show the
producer's corrected encoder target below its configured budget while local BWE
remains higher. The upstream [encoder bitrate adjuster](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/encoder_bitrate_adjuster.h)
uses conservative startup
utilization until it has enough frames. These are distinct mechanisms; the
current evidence does not isolate each one's contribution to the lowest size.
There is no verified API for transferring a mature encoder's adaptation history
to the new producer. A bitrate multiplier, longer protection interval or delayed
demand would change adaptation policy, rather than repair these completion bugs.

Budget attribution remains unchanged: targetBitrate is the encoder's allocated
target, not raw link bandwidth ([upstream stats correction](https://webrtc.googlesource.com/src/+/fe25b0e928ea4e64aa134f5dc8012343320deec5%5E%21/)).
Replacing it with availableOutgoingBitrate would bypass native allocation and
protection. Keep producer, carrier, egress and decoded observations separate.

### Carrier Capture Constraints

Serial Chrome 152 pulse checks on 2026-09-27 found that `HostPeer` applied real
capture constraints to the producer-driven canvas. Filtering those clock frames
can leave encoded data queued; reaching the four-frame bound then discards the
dependency chain and requests recovery. A second FPS limit on its synthetic
sender also filtered unevenly delivered clock frames. Track identity excludes
only the canvas from capture constraints, and carrier configuration removes the
duplicate sender FPS limit. The real producer retains the Host's picture limits;
outgoing bitrate remains bounded and ordinary fallback restores sender FPS.

With the same two-child VP8/audio fixture and 5 Mbps ceiling, queue-overflow
recovery counts across each complete run were:

| Source ceiling | Before, A / B | Without canvas capture constraints, A / B |
| --- | --- | --- |
| 30 fps | 36 / 31 | 6 / 1 |
| 60 fps | 84 / 75 | 52 / 38 |

Removing only the sender FPS ceiling left 29 / 27 at 30 fps. Removing both
ceilings yielded 1 / 0. A separate 30-second healthy check at the 60 fps ceiling
isolated the second filter: with capture constraints already removed, retaining
the sender FPS limit produced 23 / 15 overflows; removing it produced 0 / 0.
Decoded cadence rose from about 41 / 42 to 45 / 45 fps in that fixture. A
three-second quiet interval followed by resumed production also had no overflow;
retained carrier age stayed below 49 ms. Supplemental clock draws were tested
but added no benefit over removing the duplicate limit, so no pump or timer was
added. The four-frame bound and dependency-chain recovery remain intact.

These checks establish a redundant filtering cost, not lossless delivery under
all load. A 60 fps short-pulse run still recorded four overflows on constrained A
and none on B; both recovered, and B retained 1080p. They do not establish
sustained 60 fps or game quality. Cold-producer adaptation remains separate from
carrier recovery. Raw traces and ablation fixtures remain ignored artifacts.

VP8 and H264 checks on the final implementation cover live 720p60 settings,
quiet-source 480p30 changes, pause/resume, source replacement and injected
producer failure. Both retained fresh output within the selected ceilings and
returned to ordinary sending on the existing connections. H264 source replacement
had an approximately 0.5 s picture transition: the matching audio pulse arrived,
but its brief picture marker did not. Ordinary frames resumed before the new
pool selected output, so that gap is not a producer-readiness wait. Earlier
fixtures also have source-transition gaps; these observations do not establish
gap-free replacement or a new regression. They cover bounded synthetic media
lifecycle, not real-game endurance or every physical device.

The [canvas capture draft](https://w3c.github.io/mediacapture-fromelement/#html-canvas-element-media-capture-extensions)
models `requestFrame()` as a pending request, not a counted queue of clock ticks.
Do not infer one delivered carrier frame per call or enlarge the encoded queue
to hide lost timing.

### Sustained H264 Recovery

A v1.6.8 field observation on 2026-09-29 confirmed minutes of 180p / low FPS
under 1080p30, balanced and a 5 Mbps ceiling. Server summaries and receiver
RTCStats agree. A new Viewer briefly restored the incumbent to 1080p without
changing its parent; reconnecting the observer did not restore quality. An SFU
candidate initially decoded well, then stalled; replay through the production
quality probe correctly withheld approval. These observations establish the
symptom, not its network or encoder cause. Host producer/carrier histories were
unavailable; server summaries cannot reconstruct those local owners.

Serial comparisons on 2026-09-29/30 used synthetic motion, played audio,
1080p30 / balanced / 5 Mbps and a test-only UDP bridge. They distinguish
Canvas input from real `getDisplayMedia` capture. Each case is bounded evidence,
not a public-network reproduction or a population result.

| Input / Browser | Constraint and recovery result |
| --- | --- |
| Canvas bars / Edge 154.0.4258.37 | Ordinary and pooled senders recovered from 360p to 1080p after 400 kbps, 4% forward loss and 200 ms RTT; about 21 / 17 seconds after rate/loss release |
| Textured Canvas / Chrome 153.0.8010.53 and 154.0.8037.58 | Ordinary and pooled sending could retain 540p after allocation recovered; the longer Chrome 154 pair remained there after 145 seconds |
| Browser tab / Chrome 154.0.8037.58 | Ordinary and bare WebRTC retained 148p / about 10 fps after 65 recovery seconds; the bare sender's outgoing estimate was 5.6 Mbps and video target 5 Mbps |
| Chrome's own window / Chrome 154.0.8037.58 | Bare and pooled sending retained 180p / about 10 fps after 65 recovery seconds, with roughly 4.5–4.7 Mbps video targets |
| Non-Browser Windows test window / Chrome 154.0.8037.58 | All 2,758 observed source frames remained 1866x1080; bare sending recovered from 180p through 270/360p to 540p during the 65-second window |

The display cases used a 45-second 400 kbps / 4% loss interval followed by
removing both constraints; 300 ms configured RTT remained. The non-Browser
fixture captured about 21 fps and does not establish 30 fps performance. Bare
WebRTC used one cloned track, codec selection and initial sender parameters,
without Piik's pool, startup guard, quality controller or repeated parameter
writes. It also reproduced the tab restriction with VP8. Keeping the original
preview playing and using `resizeMode:none` did not remove it.

**Short disturbances can enter the persistent state.** Two one-second rate/loss
pulses, each followed by 40 unconstrained seconds, took the bare tab sender from
778p to 418p and then 238p; the actual Piik pool comparison ended at 148p.
Targets recovered to about 5 Mbps and actual captured frames remained reduced.
These single runs establish reachability in both paths, not that the pool is
worse or that every brief blur has this cause. The fixture retained 300 ms RTT.

A standalone HTML reproduction removed Piik, audio and the network shaper
entirely. It connected two local PeerConnections, captured its own moving tab,
selected H264 / balanced, reduced only `maxBitrate` from 5 Mbps to 400 kbps for
45 seconds, then restored it for 65 seconds. Source frames stayed 270x148 and
encoded output stayed at 148p / 10 fps, despite a 5 Mbps target, an approximately
13 Mbps outgoing estimate and 0–1 ms measured RTT. A preceding latency-only comparison
retained 238p. Network loss is therefore not necessary for this local lock;
these are synthetic Chrome 154 results, not the field room's diagnosed cause.

**Capture lock and encoder hysteresis remain distinct.** Canvas recovery could follow content
complexity: changing to simple bars restored 1080p, retained after restoring
the textured scene. WebRTC's [quality scaler](https://webrtc.googlesource.com/src/+/3a8b0c76e6b7bf0e72141047f82eb2c3f4862c8d/modules/video_coding/utility/quality_scaler.cc)
uses QP thresholds and sampling history as well as bandwidth-related adaptation.
Its default two-second checks and longer sampling after down-adaptation can
outlast a short disturbance. A Chrome 154 ordinary-sender tab control on
2026-09-30 remained at 524p / about 30 fps after 120 recovery seconds following two
one-second rate/loss pulses. Actual capture stayed 1904x1048 / 30 fps; the native
log's slow QP filter settled around 27, above its upscale threshold of 24.
Changing only the scene to simple moving bars restored full size in about
12 seconds. Restoring the textured scene then retained full size for the
remaining 30 seconds. The sender made only its two startup parameter writes;
no pool, reconnect, preference reset or frame reset caused that recovery.
This confirms a content-dependent stable state, not merely stale samples or
a blocked recovery operation. Restored bandwidth alone does not require this
scaler to restore resolution. The scaler and default-threshold source matched
inspected upstream main on that date; this does not establish every device's
behavior or the field report's cause.

A matched three-arm comparison used fixed 5 Mbps, alternating 5.0/4.9 Mbps
every 500 ms, and repeated identical 5 Mbps writes. Native reconfiguration
counts were 2/122/2; actual encoded rates were 4.914/4.114/4.907 Mbps. Changed
budgets repeatedly returned the encoder target to the
[bitrate adjuster's conservative startup state](https://webrtc.googlesource.com/src/+/3a8b0c76e6b7bf0e72141047f82eb2c3f4862c8d/video/encoder_bitrate_adjuster.cc),
whereas identical writes did not. All three stayed at 786p and about 29 fps,
without new keyframes during the experiment. These single-device runs show a
framework reconfiguration cost, not additional resolution oscillation or a
perceptual blur measurement. They do not justify delaying real demand, bitrate
compensation or periodic resets; equal product updates are already deduplicated.
The field's repeated brief blur still lacks matching Host histories.

**Hardware encoder startup can block sibling encoding.** On 2026-10-01,
Windows Chrome 154.0.8037.58 tests added three independent Canvas H264 producers,
coinciding with 174/221/225 ms gaps in the existing producer; captured frames
continued within 47 ms. The new producers never joined the pool or replaced its
output, and the existing
producer's parameters did not change. Their NVIDIA initialization took
161/163/162 ms. Substituting software VP8, confirmed by RTCStats as libvpx, gave
60/48/109 ms existing-producer gaps in the same startup windows.
A subsequent trace recorded 148 ms of `CreateAndInitializeVEA` on the shared
Renderer Media thread, matching GPU-side initialization. Frames timestamped
during that interval entered encoding together on the same thread after it
returned. This establishes blocking in the local reproduction, consistent with
[Chromium's synchronous initialization IPC](https://github.com/chromium/chromium/blob/154.0.8037.58/media/mojo/clients/mojo_video_encode_accelerator.cc#L117).
The trace buffer lost events elsewhere; this conclusion uses complete task and
frame events, not missing events. It does not identify the driver's internal
cost, explain earlier downscaling or attribute unmatched field reports. No
codec-default change, spare prewarmed encoder or pool reset follows from it.
The Windows [VEA provider](https://github.com/chromium/chromium/blob/154.0.8037.58/media/mojo/services/mojo_video_encode_accelerator_provider.cc)
already assigns each service a dedicated COM STA runner; the trace likewise
places the old service's encoding and new initialization on different threads.
Asynchronous Renderer initialization is therefore a plausible upstream repair,
not merely moving the wait onto another shared queue. It still needs a patched
Browser comparison, including initialization failure and callback ordering;
shared GPU/driver cost remains unproved.

**Optional reuse must preserve the existing rate owner.** A two-Viewer,
textured-tab H264 comparison exposed a Piik handoff defect. During recovery
from a one-second rate/loss pulse, a healthy Viewer moved from a 5 Mbps group
to a lower-budget group because its sampled output was 29 rather than 27 fps
at the same 1048p. Both reported `qualityLimitationReason:none`, but the same
NVIDIA encoder implementation's interval-average QP was about 51 on the
candidate versus 37 on the current output; the candidate then fell to 786p. The
[stats definition](https://www.w3.org/TR/webrtc-stats/#dom-rtcqualitylimitationreason-none)
describes resolution/FPS limitation, not equal quantization quality.

Pending membership raised the candidate's budget before the existing
lower-budget rejection ran. The candidate repair checks this constraint before
membership and reuses one non-regression predicate before submitting a pending
selection. FPS comparisons also respect the Host ceiling; a sampled 32 fps
under a 30 fps ceiling is not an improvement over 30 fps. Initial output and
necessary downgrades retain their path, without a QP policy, timer or encoder reset.

Selection also needs proof at the actual write boundary: while waiting for a key,
a candidate can downscale after passing the sampled comparison. The output now
asks the pool to revalidate current authority, budget and actual key dimensions
before replacing its queue or writing bytes. Rejection clears both pending owners,
invalidates a contradicted sample and retains prior output and recovery requests.
H264/VP8 display-capture checks preserve live/paused settings, source replacement
and ordinary fallback; played audio remains present. Brief video stalls remain.

The bounded H264 and VP8 two-Viewer controls for this admission repair retained
the healthy sibling at 1048p and about 29 fps through both recovery intervals.
The constrained Viewer still adapted and recovered. This establishes one
avoidable sibling degradation path, not the field room's cause or elimination
of all brief blur. The affected admission rules predate the display-isolation
repair. Raw observations stay in ignored fixtures; comparisons read native stats
without calling the producer's startup-transition helper.

Current demand also matters at group admission. Two-Viewer traces showed a
newcomer raising an incumbent group's allocation because matching used the
previous applied budget. The incumbent then needed another encoder, while the
newcomer's former encoder retired. Matching current native demand prevents that
exchange; a pending newcomer cannot establish compatibility with its own vote.
Cancellation must stop at accepted output writing, including a pause that delays
its completion. These are ownership repairs, not suppression of real demand
changes or removal of the measured hardware initialization cost.

**Quiet content is not rate compatibility.** A separate fixed-allocation
comparison kept the two outgoing H264 ceilings at 3 and 5 Mbps, with no network
shaping, while alternating simple and textured moving content. Actual native
allocations stayed at those ceilings during the later scene cycles. Reuse based
on a quiet 500 ms byte-rate sample repeatedly moved the weaker child into the
5 Mbps producer; returning motion split it out again. Five producers were created
over the run. Requiring the candidate's rate budget to fit the child's allocation
at initial admission, optional reuse and pending revalidation retained two
producers with no scene-driven handoffs. The healthy H264 sibling retained full
1048p; the weaker output continued native adaptation. VP8 also retained two
producers through the same scene changes. Three controlled regressions fail
when these checks are removed, including a paused pending child whose candidate
budget rises. Unequal demands may retain an additional producer even during a
quiet scene; bounded membership and native recovery remain unchanged. These
checks remove unnecessary encoder churn, not all content-dependent adaptation.

**A known allocation should initialize the local encoder.** A replacement local
PeerConnection otherwise starts its own estimate at WebRTC's default 300 kbps,
even when the outgoing connection already allocates 4 Mbps. Chrome 154's native
logs confirm this second cold start. On the same isolated 1904x1048 textured tab,
seeding only the local answer with that 4 Mbps allocation increased VP8 output
in the first second from 6 to 27 frames; its first sampled target was 3.33 Mbps
rather than 2.70 Mbps. The 400 kbps control retained its native 333 kbps initial
encoder target and two first-second frames with either version. These bounded
results do not promise faster first frames or remove weak-network adaptation.

The hint uses the existing Host-bounded allocation, not a multiplier or floor.
WebRTC reads the send configuration from the
[remote description](https://webrtc.googlesource.com/src/+/3a8b0c76e6b7bf0e72141047f82eb2c3f4862c8d/pc/channel.cc)
and accepts a positive `x-google-start-bitrate` in its
[codec bitrate configuration](https://webrtc.googlesource.com/src/+/3a8b0c76e6b7bf0e72141047f82eb2c3f4862c8d/media/engine/webrtc_media_engine.cc).
An offer-only control lost the hint in Chrome's answer and did not improve
startup. Piik therefore changes only its owned local answer; external SDP,
codec identity and subsequent sender-budget updates stay unchanged. The
application writes this hint once per producer, not on each budget change.
The full two-Viewer VP8 follow-up retained the healthy child at 1048p through
two one-second 400 kbps / 4% loss pulses at 40 ms configured RTT. The constrained
child still down-adapted and froze during recovery, but regained 1048p within
each 40-second recovery window. This is not a freeze-free claim. A separate
audio/loss check delivered all 97 scheduled audio pulses to both played outputs;
H264 quiet-start, live/paused settings, source replacement and ordinary-fallback
checks passed. All owned test connections, processes and profiles retired.

**Residual VP8 stalls do not require an output wait.** The ordinary two-Viewer
control with the same source and rate/loss pulses also froze and downscaled,
ending the recovery windows at 786p and 524p. It entered the second pulse at a
lower resolution than pooling, so their recovery FPS is not a fair cost comparison.
Replaying the pooled child's budget sequence on a warmed local producer without
a shaper, carrier, queue or handoff produced nine frames in the same eight-second
low-budget interval; adding the two original keyframe requests yielded eight,
matching the original interval. Startup protection had already ended. Native
logs show frame dropping and the scaler's spaced downscales. This establishes
stalls under that budget sequence, not the cause of the sequence: keyframe bursts
can still affect downstream estimation, and parameter reconfiguration remains
in the replay. These results do not support removing dependency recovery or
startup protection, growing queues or repeatedly resetting encoders. Matched
field evidence and broader transport/allocation effects remain open.
The rate/loss run with audio retained all 65 pulses after startup at both
played outputs, despite video stalls; this does not establish gap-free video.
A separate six-second complete RTP-media drop on one child, preserving RTCP
and signaling, resumed its played video 157 ms after release for VP8 and 128 ms
for H264. Both healthy siblings retained full dimensions; H264 still recorded
brief sibling stalls. All post-release audio pulses arrived. This bounded local
check does not establish recovery for an interrupted relay or reporter's network.

A matched single-Viewer control separates pool handoffs from ordinary adaptation.
Pooled sending used one producer with no handoffs; ordinary sending used no pool
and made only two parameter writes. After the second one-second rate/loss pulse,
both reached 262p before ending their 40-second recovery window at 390p / 15 fps.
Actual source frames stayed 1904x1048 at about 30 fps. Native logs showed quality
scaler down-adaptation, Chromium's below-360p software fallback and subsequent
recovery to NVIDIA H264 at 390p; this was not a hardware failure. Pool reuse and
frequent application-level budget writes are therefore not necessary for this
bounded low-output state. Their effect on the intervening trajectory and the
unmatched field reports remains distinct.

The tab case exposed a more specific capture-feedback problem. A Chromium trace
kept the source geometry at 1904x1049 while capture supplied a 268x148 content
rectangle. Feedback rose to 66,600 pixels, but capture did not grow.
[Chrome 154's source adapter](https://raw.githubusercontent.com/chromium/chromium/154.0.8037.58/third_party/blink/renderer/platform/peerconnection/webrtc_video_track_source.cc)
puts the adapter's target pixels into a maximum-pixel feedback field. Its
[capture oracle](https://raw.githubusercontent.com/chromium/chromium/154.0.8037.58/media/capture/content/video_capture_oracle.cc)
then chooses a size below that limit using
[90-row capture steps](https://raw.githubusercontent.com/chromium/chromium/154.0.8037.58/media/capture/content/capture_resolution_chooser.cc).
For this geometry the next step above 270x149 (40,230 pixels) is 433x239
(103,487 pixels), so 66,600 cannot advance it.

This matches WebRTC's [up-adaptation distinction](https://webrtc.googlesource.com/src/+/3a8b0c76e6b7bf0e72141047f82eb2c3f4862c8d/call/adaptation/video_stream_adapter.cc)
between a soft target and a larger hard maximum intended to accommodate source
sizes. The inspected libwebrtc revision is the exact revision pinned by
[Chrome 154's DEPS](https://raw.githubusercontent.com/chromium/chromium/154.0.8037.58/DEPS),
retrieved through Gerrit revision content. At 270x148, the soft recovery target
is 66,600 pixels; its intended hard maximum is 159,840. Forwarding only the soft
target prevents the next capture step. Without larger input, the next recovery
request cannot exceed the already installed maximum and is rejected. This
strongly supports a feedback/size-quantization lock. Actual `VideoFrame`
dimensions confirm reduced capture independently of stale `getSettings()`.
Reapplying exact dimensions to the original track did not unblock it.

The Piik sender boundary now forwards bounded raw display frames using
[Chromium's track streams](https://developer.chrome.com/docs/capabilities/web-apis/mediastreamtrack-insertable-media-processing),
without resizing, re-encoding or generated cadence. Camera/received tracks and
unsupported Browsers keep ordinary clones. In the textured-tab comparison,
all but the initial source frame stayed 1904x1048; output escaped 192p through
262/390p to 524p. It still remained 524p after 125 recovery seconds. This removes
the reproduced capture lock, not content-dependent encoder hysteresis or every
reported blur. The separate non-Browser window case also retained full input and
recovered gradually; do not generalize the tab mechanism to all desktop capture.

Static-source testing caught a necessary lifecycle detail: unlike an RTC sink,
a Processor does not request idle refresh frames. A static tab delivered no first
encoded frame without them. The input retains the RTC sink's
[1 fps refresh requirement](https://raw.githubusercontent.com/chromium/chromium/154.0.8037.58/third_party/blink/renderer/modules/peerconnection/media_stream_video_webrtc_sink.h)
through the native
[capture constraint handler](https://raw.githubusercontent.com/chromium/chromium/154.0.8037.58/third_party/blink/renderer/modules/mediastream/media_stream_video_track.cc).
No frame is synthesized by Piik and no sender quality floor is added.
H264 pooling and ordinary VP8 passed static first-frame, live/quiet/paused profile
updates, resume, source replacement and retirement with actual tab capture.
Fault checks cover pending replacement and active-input failure without retiring
the shared source. A fake-device input exercising the same raw-frame path retained
20 fps during a verified hidden-page interval; self-tab capture could not enter
hidden state in that fixture. Physical background/device coverage remains open.
A matched full-resolution pair consumed 12.30 versus 12.46 whole-fixture CPU-seconds
over 15 seconds. This single-machine sample is not a low-end performance guarantee.

**Carrier cadence must not adapt the picture twice.** Two one-second rate/loss
pulses exposed a separate starvation loop: after the second pulse the producer
delivered about 15 fps, but its synthetic carrier fell to 1-3 fps. The four-frame
queue overflowed and repeatedly requested recovery keys. Keeping only the
carrier's native preference at `maintain-framerate` retained about 15 decoded fps;
the last 31 seconds had four queue-overflow recoveries instead of 69. The real
producer remained balanced and source frames remained full size in both runs.
This implements the existing producer/clock ownership boundary; it adds no
queue growth, quality floor or network estimator. It does not remove ordinary
WebRTC adaptation: output still ended at 390p in that textured two-pulse case.

The bounded two-Viewer tab probe passed with both H264 and VP8: after one Viewer
was limited to 400 kbps for 14 seconds, it returned to 1904x1048 at about 30 fps
within the 40-second recovery observation. The healthy sibling retained full size,
and source-frame observations confirmed no capture shrink. This simpler scene
does not supersede the textured-scene recovery boundary above.

Actual tab capture through embedded SFU exposed a separate forwarding defect:
VP8's two spatial encodings each sent 15 fps with `L1T3`, but the subscriber
decoded about 4 fps. Both shared forwarding owners forced temporal layer zero,
discarding enhancement frames even with ample budget. The ordinary-clone control
had the same failure. Removing those overrides retains
[LiveKit's supported temporal bound](https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/forwarder.go#L293-L295)
and allocation from real incoming layers. The repaired real-tab check decoded
15 fps with the Host hidden, including original/half-size switching, resumed
delivery, track replacement and retirement. RTP regression tests cover both
Transport and Publication; restoring either old cap makes its test fail.
This does not identify the field room's H264 degradation cause.

**Upstream repair boundary.** Chromium's
[feedback forwarding change](https://chromium-review.googlesource.com/c/chromium/src/+/2386743)
dates to 2020; the relevant logic remained in inspected upstream main on
2026-09-30. Reviewed historical fixes for
[scale-boundary equality](https://codereview.webrtc.org/2713683002),
[preference-switch waits](https://webrtc-review.googlesource.com/c/src/+/174805)
and [requested-resolution reconfiguration](https://webrtc-review.googlesource.com/c/src/+/360200)
do not supply a matching unshipped fix for this reproduction. Preserving the
hard maximum separately from the soft target lets a numerical reduction escape
the observed 148p, 180p and 238p fixed points. This is a narrow upstream repair
candidate, not a compiled or accepted Chromium patch; full capture/adapter
tests are still required. Updating a Piik package does not replace the user's
Browser implementation.

**The existing preference control can recover this reproduction.** After 65
seconds stuck at 148p / 10 fps despite restored allocation, changing from
balanced to `maintain-resolution` restored 1048p within the next two-second
sample and reached about 30 fps. Switching back to balanced after 30 seconds
retained that output for another 30 seconds. Bare WebRTC changed only the
sender's degradation preference; a separate Piik run used `HostPeer`'s existing
profile update through the pool. Both kept their connection and source; the
pool retained one producer. Actual source frames recovered too. This provides
a locally verified manual recovery through the existing clarity preference,
not a field guarantee or justification for automatic preference toggling.
The pinned `VideoStreamAdapter` clears adaptation restrictions when switching
to or from balanced, explaining why this control escapes the reproduced state.

**A new Viewer can help, but need not.** In a Canvas comparison, a degraded
incumbent adopted a newcomer's fresh healthy producer and returned to 1080p in
about 1.5 seconds on the same connection. In the tab comparison, the newcomer
reused the existing producer and both stayed at 148p. Neither result establishes
which local producer transition occurred in the field room.

**Regression and repair boundary.** v1.6.5 (`04cbb2c9`)'s pool, `HostPeer` and
quality owners showed the same Canvas recovery patterns in the current fixture.
This compares those owners, not the whole older release or Browser. The
[sender-owned clone and five-frame protections](./realtime-quality-adaptation.md)
remain implemented; they address connection generations and startup, not every
mid-share adaptation state. Field server evidence contains same-parent quality
attempts that failed proof. There is no confirmed removed protection or recent
Piik regression. The capture and carrier repairs above address their reproduced
defects, not every content-dependent adaptation state.
Do not weaken candidate proof, impose output floors or reset encoders periodically.

Use actual source frames, producer/carrier histories and receiver RTCStats
together; settings and configured ceilings are not frame evidence. Some headless
runs lost presentation callbacks while decoding continued. Raw traces and fixture
variants remain ignored. Matched field Host evidence is still needed to separate
capture feedback, encoder adaptation and a continuing transport limitation.

## Cost And Accounting

Before the CPU-carrier refinement, a matched actual-product VP8 1080p30 comparison's ordinary pair made
350 full-size encodes in six seconds, using about 1,201 ms summed encode time.
The pool made 170 full-size and 342 tiny encodes, using about 516 ms summed
encode time. Whole isolated Chrome CPU was 9.23 versus 8.95 CPU-seconds.
The fixture includes source drawing, barcode reads, all receiving pages and the
extra producer receiver; this is not Host-only CPU, GPU or thermal measurement.

Earlier independent-producer comparisons showed a larger whole-fixture VP8
saving, but H264 showed no total CPU win despite fewer full encodes. Do not
generalize one percentage or count dropped frames as an optimization.
The current H264 pair likewise reduced summed encode time from about 1,649 to
927 ms, while whole-fixture CPU increased from 4.17 to 4.56 CPU-seconds over six
seconds (about 0.065 of one CPU core). Less full-resolution encoding does not
guarantee lower overall CPU on hardware codecs.
The owner accepts a uniform path from the first eligible consumer, without
an audience-count threshold. Singleton and hardware costs remain explicit.

Receiver details stay real inbound observations. Sender transport bytes/loss
belong to each connection; dimensions/cadence describe the frames actually
written; native limitation evidence comes from the assigned real producer.
Shared encode counts/total encode time are not duplicated per child.
Retired producer samples keep their latest per-instance report rather than
reverting to an older polling snapshot.

## Reproduction

Use the existing isolated-browser harness and stable executable paths:

```sh
npx tsx scripts/browser-local-pool-probe.ts ordinary --1080 --av --preference=balanced
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --av --preference=balanced
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --av --network --auto --rate=400000 --preference=balanced
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --av --lifecycle
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --av --relay
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --background
npx tsx scripts/browser-local-pool-probe.ts carrier --display --quiet-start --1080 --h264 --av --lifecycle
npx tsx scripts/browser-local-pool-probe.ts ordinary --display --quiet-start --1080 --av --lifecycle
npx tsx scripts/browser-local-pool-probe.ts carrier --display --1080 --h264 --av --network --auto --rate=400000 --preference=balanced
```

Add `--h264`, `--single` or `--late` for the corresponding case. Set
`--network --auto --short-pulse` for a 45-second warmup, one-second constraint
and 40-second recovery instead of the ordinary 14-second constraint. Set
`CHROME_PATH` for another installed Chromium binary. `--auto` extends the
recovery observation; product code owns all adaptation. Results go to ignored
`build/browser-local-pool`; summarize with
`node scripts/browser-local-pool-summary.mjs <result.json>`.
A successful process exit does not establish visual/performance parity.
`--display` captures only the isolated probe tab. It records actual source-frame
sizes and checks that sender adaptation does not shrink capture; its receiver
observations establish frame progress, not barcode-based glass-to-glass latency
or audiovisual offset. The summary suppresses those unmeasured timing values.
`--quiet-start` requires a decoded frame before the source animation starts.

For real tab capture through the shared forwarding path, set `CHROME_PATH`,
`PIIK_EMBEDDED_SFU_GATE=true`, `PIIK_EMBEDDED_SFU_DISPLAY=true` and
`PIIK_EMBEDDED_SFU_CODEC=h264` or `vp8`, then run `npm run gate:embedded-sfu`.
This separate arm verifies a hidden Host, decoded original/half-size layers,
resumed delivery, video-track replacement, profile changes and retirement.
Track replacement uses a clone of the same visual source; it does not establish
different-device switching or audio/video synchronization.

## Primary References And Remaining Boundaries

- [W3C Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/#stream-processing)
  enforces standard frame owner/order. The selected legacy API is a different
  available API boundary, not a feature flag relaxing those checks.
- [Chromium M152 encoded frame](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.82/third_party/blink/renderer/modules/peerconnection/rtc_encoded_video_frame.cc)
  supports copy construction with validated RTP timestamp metadata.
- [Pinned WebRTC transform delegate](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/rtp_rtcp/source/rtp_sender_video_frame_transformer_delegate.cc)
  reconstructs copied native frames; internal capture/presentation timing is
  not wholly preserved. Current negotiated VP8/H264 connections lack generic
  dependency-descriptor extensions, so no frame-ID mapping was added.
- [LiveKit capability detection](https://github.com/livekit/client-sdk-js/blob/main/src/e2ee/utils.ts)
  recognizes `createEncodedStreams()`; it is not itself a reusable encoding pool.
- [WebRTC stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-targetbitrate)
  distinguishes the video encoder payload target from link bandwidth.
- [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/)
  explains why a JS canvas timer is not a reliable hidden-page media clock.

The future [RTCEncodedSource proposal](https://chromestatus.com/feature/5177374353260544)
is not exposed by the installed M152 Browser. No future API, feature flag, SFU
policy change, Browser cross-level encoded passthrough or public-network
performance guarantee is assumed. Matching Debug/artifact acceptance and
representative game/hardware feedback remain separate from these bounded runs.
