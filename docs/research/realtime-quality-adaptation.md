# Realtime Screen-Share Quality Evidence

- Initial review: 2026-08-30; dated follow-ups record subsequent evidence
- Scope: Browser game capture, codecs, startup adaptation, relay, and LiveKit
- Status: historical Browser/LiveKit SDK measurements and subsequent implementation evidence; current product behavior is owned by
  [media quality](../standards/media-quality.md) and
  [ADR-0007](../adr/0007-path-isolated-representation-quality.md)

## Findings

The initial findings below describe the August Browser and external LiveKit
composition. [ADR-0013](../adr/0013-embedded-node-local-media.md) replaced that
service/SDK boundary with embedded media components. The later
[recovery ownership](#recovery-ownership) section distinguishes current paths;
SDK options below are retained measurement inputs.

- Browser settings are ceilings and content intent, not delivered floors.
  WebRTC owns each direct/relay edge's congestion adaptation; LiveKit owns SFU
  representations and subscriber forwarding.
- Windows Chromium WebRTC VP8 is a software `libvpx` path. Web content cannot
  select NVENC, AMF, QSV, a GPU, or a particular Media Foundation transform.
- H.264 can be substantially cheaper when Chromium selects a good hardware MFT,
  but capability or `powerEfficientEncoder` does not prove sender cadence. An
  actual bounded sender probe is required.
- `contentHint = "motion"` is the correct game-motion intent. Removing it may
  retain spatial resolution by changing another quality tradeoff; the observed
  improvement was not free.
- Chromium's `motion + balanced` startup can retain an early low-resolution
  restriction. Starting at `maintain-resolution` and applying the desired
  preference after five encoded frames clears that native restriction without a
  timer or periodic quality controller.
- LiveKit's default screen-share representations, Dynacast, and server send-side
  BWE support weak and strong subscribers. Forcing a permanent lower encoding or
  single HIGH both regress a valid cohort.
- Current route quality evidence is diagnostic. Receiver-only freeze/loss data
  cannot prove an unconnected parent is better or authorize parent-wide/SFU
  routing changes.

## Go GC Attribution

A stall or resolution drop alone does not identify garbage collection. The
relevant boundary is the selected media path:

| Path | Go's role |
| --- | --- |
| Browser capture and Browser P2P/relay | Chrome owns capture, encoding and RTP. Go owns room/signaling; its GC does not directly pause those Browser media workers. Control delays and shared-machine resource pressure remain possible indirect effects. |
| Native App | The capture helper owns encoding; Go reads its output and runs Pion/LiveKit transport. Go scheduling or allocation pressure can delay frame ingestion, packet delivery or feedback. |
| Embedded SFU or Native relay | Go participates in forwarding, so its runtime is on the media path. |

The [Browser adaptation comparisons](./browser-local-encoding-pool.md#sustained-h264-recovery)
include low-output recovery in an isolated Chrome/Node harness without a Go
process. Go GC is therefore not necessary for those reproductions; this does
not diagnose every field blur, drop or Native/SFU interruption.

Go's [GC guide](https://go.dev/doc/gc-guide#Latency) distinguishes brief global
pauses from concurrent CPU cost, allocation assists and scheduling delays. A
small pause total alone cannot rule out runtime pressure. Before tuning GC,
correlate the same attempt's source/encoder progress, RTP/loss/RTT, selected
route and receiver frames with the relevant Go process. Existing diagnostic
`memory.json` contains GC counts, recent pause durations/end times and cumulative
GC CPU fraction; `heap.pprof` identifies sampled allocations. These are snapshots,
not a continuous latency trace. Use a bounded local Go execution trace/CPU profile
or `GODEBUG=gctrace=1` reproduction when the snapshots justify it, following
[Go diagnostics](https://go.dev/doc/diagnostics); no public profiler is needed.
Current evidence does not justify disabling GC, imposing a memory limit or
replacing the Go transport. The unmatched field reports remain in [TODO](../todo.md).

## VP8 Cost And Hardware Boundary

Chromium 151's Windows Media Foundation and D3D12 WebRTC encoder factories did
not enumerate VP8. Libwebrtc reports its VP8 implementation as software. Ten
valid GPU Engine samples in isolated Chrome and Edge runs showed zero
`VideoEncode`/`VideoDecode`; 3D activity reflected rendering/texture work and is
not encoder attribution.

Headful isolated loopbacks used a deterministic 1080p source, accepted profiles,
five seconds of settling, and 30 seconds of measurement. Browser CPU includes
source rendering, local decode, and Browser services; 100% is one logical core.

| Browser/profile | Senders | Delivered result | Encode cost | Browser CPU |
| --- | ---: | --- | ---: | ---: |
| Chrome 151, 1080p30 | 1 | 30 fps, 1920x1080, no limitation | 4.06 ms/frame | 96.6% |
| Chrome 151, 1080p60 | 1 | 55-56 fps, 1080p/720p, bandwidth-limited | 3.9-4.9 ms/frame | 123-136% |
| Chrome 151, 1080p60 | 2 | 56.8 fps, 1080p/720p, bandwidth-limited | 5.03 ms/frame | 233.4% |
| Edge 151, 1080p60 | 1 | 44-49 fps, 1080p/720p/540p | 3.2-4.5 ms/frame | 104-138% |

The 60 fps arms remained below the ceiling while encode time stayed well below
the 16.7 ms frame budget. In these short runs, stock bandwidth adaptation and
startup ramp, not a slow per-frame encoder call, coincided with the reduced
cadence/resolution. Web VP8 still competes materially with a game for CPU.

Reproduction uses `npx tsx scripts/peer-assisted-benchmark.ts`; retained commit
and environment details remain in Git history rather than this current evidence
summary.

### Concurrent Sender Cost

A Chrome 151 Windows loopback compared one and three simultaneous high-motion
VP8 senders at 1080p30. One sender sustained 29.7 fps at 4.9 Mbps with median
encode time near 5.0 ms/frame. With three senders, one measured path fell to a
28.7 fps median and 18-22 fps short-window lows while median encode time rose to
14.9 ms/frame; renderer CPU rose from about 88% to 423%. Stopping the other two
senders restored 29.8 fps and closed every retired PeerConnection and sender.
RTT stayed below 4 ms, resolution stayed 1080p, loss/NACK/PLI stayed zero, and
`qualityLimitationReason` remained `none` throughout.

This proves independent Browser encode/render contention that native limitation
classification may not expose. It does not prove a stale sender leak or justify
deriving endpoint capacity from one RTCStats field. A low-motion control also
sustained 29.8 fps while using only about 0.24 Mbps, so payload bitrate alone is
not a quality measure.

An initial same-track versus `MediaStreamTrack.clone()` A/B left a sender on the
original track in both arms. A constrained sender fell near 320x180 at 9-10 fps
while the healthier sender stayed near 960x540 at 28-30 fps; both returned to
720p30 after the constrained sender closed. That experiment established partial
coupling and correctly rejected a bare clone added alongside an original-track
sender. It did not test sender-owned clone generations with a preview-only
original track.

A later Chrome 151 display-capture experiment tested that missing ownership
boundary. The original track fed only local preview; two PeerConnections each
owned a separate clone. Constraining one sender to 120 kbps still caused some
transient cross-clone frame-rate and resolution disturbance, so clones do not
provide complete simultaneous isolation. The constrained sender then remained
limited after its budget returned to 5 Mbps. Closing that sender and stopping
its clone, followed by a new sender with a fresh clone, restored both paths to
1768x938 at about 30 fps for the full 24-second observation. Reusing the original
track instead had repeatedly created a low-resolution replacement sender.

This establishes a Chrome 151 generation-ratchet and a standards-based escape:
an outbound video sender can own one independently constrained clone and retire
the adapted track with the sender. It does not establish complete source
isolation, cross-Browser behavior, or a new congestion controller. Any product
implementation must also preserve live capture-profile changes, `contentHint`,
Host pause/resume, source replacement rollback, and explicit clone disposal.

Production room evidence showed the same partial coupling and ratchet shape at
larger scale. One Host sender remained bandwidth-limited while both same-track
Host outputs fell
near 320x180 at 7-10 fps, even when its sibling reported no native limitation
and materially higher outgoing BWE. After the constrained edge departed, the
surviving path recovered through high-resolution, full-cadence windows. Together
with the controlled experiments, this supports partial shared-source coupling
and track-generation retention; it does not establish a universal all-senders
minimum or quantify its share relative to uplink contention.

### Same-edge generation recovery

On 2026-08-30, a production single-Viewer room provided a controlled comparison.
The Host capture stayed at about 30 fps while one live P2P sender remained at
480x270 and 14-16 fps after its available-outgoing estimate returned above
5 Mbps. The route controller observed three persistent native limited windows,
but had no different Peer candidate and therefore could not start a quality
operation. A Viewer page refresh created a new connection and sender-owned clone
on the same physical path; it climbed from the same source to 1920x1080 and
30 fps within the following windows. This confirms that a live sender generation
can remain adapted after network capacity recovers and that full connection
replacement is the observed escape. The degradation onset occurred while
application evidence was unavailable, so this record does not assign a trigger
to a specific preceding event.

The accepted route change reuses that existing connection lifecycle: a persistent
limited edge may try one same-parent candidate after ordinary Peer candidates,
retaining the old edge until first-frame and comparative proof. It adds no media
setting, score, periodic rebalance, or new transport. Physical public-network
success rates and long-run retry behavior remain open evidence.

## H.264 Root Cause And Gate

Chromium's `has_trusted_rate_controller` is encoder coordination, not a Windows
security classification. Some Media Foundation H.264 paths let both the MFT and
libwebrtc drop frames. A controlled Chrome 151 AMD loopback at roughly
1904x928@30 showed:

- ordinary hardware MFT: 14.18 fps at 14.24 ms encoded-frame cost;
- forced Chromium desktop software BRC on the same MFT: 29.93 fps at 8.17 ms;
- OpenH264 software fallback: 10.47 fps.

This isolates the observed AMD failure to outer bitrate-control/frame-drop
interaction, not a fixed MFT throughput ceiling. The page cannot enable the
process feature, override Chromium's AMD workaround, or select a different MFT.

Upstream status checked on 2026-10-14: Chromium main's
[driver bug list](https://raw.githubusercontent.com/chromium/chromium/main/gpu/config/gpu_driver_bug_list.json)
entry 449 still disables H.264 software bitrate control on AMD Windows without
a driver-version exception
([crbug 417752242](https://issues.chromium.org/issues/417752242)).
The [AMD override](https://raw.githubusercontent.com/chromium/chromium/main/media/gpu/windows/mf_video_encoder_switches.cc)
also remains disabled by default in main and Chrome 154.0.8037.98.
This source establishes the Browser workaround, not the state of every AMD
driver or native device. The earlier measured low-cadence output supports keeping
an actual-output gate rather than inferring compatibility from a device name.
Windows native Auto likewise measures through its live pipeline, including the
untrusted rate controller and frame dropper. Matching native AMD physical
evidence remains pending.

Chromium's separate [2026-10-06 MFVEA repair](https://chromium.googlesource.com/chromium/src/+/b12ee1f641ce7de36d6c5c97b1b3ee5d3f6090c9)
recreates software rate control when the encoded dimensions change; its stated
trigger is a VP9 rate controller failing when resolution increases. It neither
removes the AMD H264 workaround above nor establishes restored cadence on the
affected devices. Browser GPU preference can change the chosen hardware path,
but integrated versus discrete GPU is not a reliable encoder-quality rule.
Native selection already tries available adapter/encoder candidates; changing
Chrome's preference does not select the App's capture device.

Later exact Browser cohorts demonstrated why runtime evidence is useful:

| Path | Actual encoder | Source / encoded / decoded | Result |
| --- | --- | --- | --- |
| Chrome 151 direct H.264 | AMD Media Foundation | 30.0 / 12.5 / 12.4 fps | failed cadence despite efficient flag |
| Chrome 153 direct VP8 | `libvpx` software | 29.9 / 29.9 / 29.9 fps | full-cadence control |
| Chrome 153 direct H.264 | NVIDIA Media Foundation | 29.9 / 29.9 / 30.0 fps | full-cadence hardware path |
| Chrome 153 LiveKit H.264 | two NVIDIA MFT encoders | 29.5 / 29.1 / 29.1 fps | HIGH+LOW publication delivered HIGH |

Chrome 153 also sustained two direct H.264 senders and one Host-to-relay-to-child
chain near 30 fps with NVIDIA MFT encode and D3D11 decode at both stages. These
short runs prove cadence and negotiation, not steady game quality or whole-
Browser CPU cost.

The current Auto gate therefore uses a local H.264-only PeerConnection with a
deterministic moving Canvas track at the share target. It verifies negotiated
codec, source progress, and encoded progress rather than trusting capability,
GPU name, or `powerEfficientEncoder`. Unsupported, failed, slow, or inconclusive
evidence selects VP8. Manual VP8/H264 bypasses Auto and strictly applies the
choice.

The probe is share-generation scoped. Source switch, pause, profile changes, and
reparent do not rerun or change active edges. Viewer relays decide once before
their first child. The Host's one SFU publication uses the same resolved codec
and disables backup codec. A static real capture cannot make the decision
inconclusive because probe motion is independent.

Chrome 151.0.7922.175 synthetic 1080p30 startup screening used a fresh process
for each arm. Manual VP8 sent Host authentication 99-116 ms after the share
click. Auto took 3088-3127 ms and correctly fell back to VP8 in all three arms.
Replacing the probe's serial wait-for-complete ICE exchange with standard local
Trickle ICE retained the same codec outcome and cadence proof while repeated
Auto arms fell to 2764-2791 ms, roughly 0.33 seconds faster. The remaining
roughly 2.8 seconds is dominated by full-target warmup and measurement; it is
not grounds to shorten the proof window or silently weaken Auto.

The same machine also validates why the gate measures delivered cadence instead
of trusting codec support or `qualityLimitationReason`. With forced H.264 at
1080p30, one sender received a roughly 30 fps media source and 6.1-8.6 Mbps of
estimated outgoing bandwidth but encoded only 13-19 fps, averaging 15 fps, while
Chromium reported `none` for every limitation sample. In the three-Viewer arm,
the two Host H.264 senders averaged 14.71 fps; the otherwise equivalent VP8 arm
averaged 28.64 fps at the same 1920x1080 output. The stats exposed neither an
encoder implementation nor a power-efficiency flag, so the result proves only
that this current Browser/device/profile H.264 path is unsuitable. It does not
support a GPU-vendor rule or a hardware/software inference.

VP9, AV1, and H.265 remain unsupported product candidates: Browser codec support
does not prove the desired hardware profile, cross-Browser relay compatibility,
or better real-time cadence. Screego's VP9 default was reverted after a frame-
rate regression and supplies no hidden encoder-selection workaround.

## Startup Quality Restriction

Chrome 151 reproduced the poor initial `motion + balanced` picture in a local
loopback with no external network, VP8 `libvpx`, 1920x1080@30 capture, and 5 Mbps
sender ceiling:

| Startup input | About 1 s | About 8 s | Limitation |
| --- | --- | --- | --- |
| `motion + balanced` | 480x270, 13 fps | 480x270, 14 fps | bandwidth |
| same plus SDP start-bitrate hint | 480x270, 14 fps | 480x270, 14 fps | bandwidth |
| no hint + balanced | 1920x1080, 18 fps | 1920x1080, 20 fps | none |
| `detail + balanced` | 1920x1080, 18 fps | 1920x1080, 20 fps | none |
| `motion + maintain-resolution` | 1920x1080, 17 fps | 1920x1080, 20 fps | none |

Changing only degradation preference at connection or after one encoded frame
retained 270p or 720p. Changing after five encoded frames retained 1080p and
cleared the limitation through the measured window. Five frames is the first
measured safe media fact and follows libwebrtc's four-frame startup-drop bound;
one/two-second timers are unnecessary.

Current senders therefore start with the requested ceiling and temporary
`maintain-resolution`, then the existing stats path applies the user's desired
preference once the current source has proved five encoded frames. A fresh RTP
stream starts at zero; source replacement establishes a baseline from its first
valid current-track sample. Missing counters and unmatched old-source reports
remain unknown. Queued restoration reads the current committed user profile
when it executes. The application does
not add an SDP bitrate hint, periodic rewrite, or custom adaptation ladder.

### Source Replacement Evidence

On 2026-09-13, six isolated Chrome 152.0.7977.84 loopbacks used a 1920x1080@30
canvas, `motion`, VP8 software encoding and a 5 Mbps ceiling. Protected startup
initially delivered 1080p, dipped to 720p during ordinary bandwidth ramp-up,
then recovered to 1080p around 14 seconds. After an established connection's
`replaceTrack`, immediate `balanced`, a two-second delay and five-new-frame
protection all retained 1080p with limitation `none` in their 15-second windows.
Two 16x16-to-1080p replacements likewise reached 1080p with and without protection.

The RTP stream's `framesEncoded` counter survived replacement. These runs did
not reproduce a new startup restriction on an established connection; they do
not justify removing protection for H.264, other browsers or cold recovery.
The [WebRTC statistics model](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-framesencoded)
defines this counter per RTP stream, independently of a capture-track lifetime.

## Historical LiveKit SDK Representation Evidence

Pinned LiveKit client 2.22.0, server 1.13.5, and Chrome 151/153 showed that
default screen-share publication can expose original and lower representations,
and server BWE can forward a lower representation to a constrained subscriber
while another receives the highest available representation.

Calling the pinned client's own encoding calculator with Silip's exact
publish options produces two VP8 encodings for every accepted profile:

| Profile | Lower representation | Original representation |
| --- | --- | --- |
| 720p30 | 1/2 scale, 750 kbps, 30 fps | 3 Mbps, 30 fps |
| 1080p30 | 1/2 scale, 1.25 Mbps, 30 fps | 5 Mbps, 30 fps |
| 1080p60 | 1/2 scale, 2 Mbps, 60 fps | 8 Mbps, 60 fps |

Both encodings start without an explicit RTP `priority` because Silip's
custom `screenShareEncoding` replaces LiveKit's priority-bearing preset while
retaining its default `simulcast: true`. The audio encoding is `high` priority.
Priority can only redistribute bandwidth within that PeerConnection and request
packet marking; it cannot reserve encoder CPU or coordinate independent P2P
connections. This is an A/B input, not evidence to raise video priority.

Forcing a lower encoding permanently consumed the same Host-to-SFU congestion
budget and reduced HIGH performance. Publishing only HIGH abandoned constrained
subscribers. The measured SDK composition used:

- one Host publication for all SFU subscribers;
- no custom `screenShareSimulcastLayers` and no backup codec;
- pinned LiveKit representation construction and republish behavior;
- Dynacast plus server send-side BWE; and
- AdaptiveStream disabled because every Viewer may relay its received track.

A LiveKit H.264 publication may use more than one hardware encoder for its
representations. Reducing Host network copies to one publication does not by
itself prove lower Host encode cost.

An August SFU study separated an SFU delivery problem from route churn. SFU
roots showed synchronized freeze windows and frequent 1920-to-960 representation
changes before any quality-convergence operation existed, while a brief direct
Peer Viewer remained near 1080p and full cadence. Later, the Host publication
also reported sustained native bandwidth limitation. This excludes quality
probing as the initial trigger and does not support a Host-wide capture or encode
failure, but it does not isolate one SFU cause.

Pinned LiveKit server 1.13.5 delays Dynacast layer downgrades by five seconds,
reenables demanded layers immediately, and then relies on keyframe acquisition;
its forwarder grace and individual PLI retry intervals are shorter than that
delay. Those mechanics
can explain several-second stalls during representation churn, but the retained
warning-level logs contain no subscribed-quality or publisher-layer transition,
so Dynacast disablement is not established as the cause of each freeze. SFU
publisher diagnostics therefore keep aggregate bitrate and native limitation
across all active representations while reporting dimensions and cadence from
the highest active representation. They also report the total and currently
active sender-encoding counts read from the existing publisher parameters. The
counts contain no RID or participant identity and do not affect routing or layer
selection. A future event can therefore distinguish publisher layer disablement
from subscriber-only forwarding changes without altering the LiveKit adaptation
policy.

A 2026-09-01 production comparison separated server capacity from packet-loss
recovery. One two-Viewer SFU room kept its Host publication healthy with no
zero-frame publisher window, while a later room on the same node repeatedly
lost both Viewer outputs together. In the latter room the Host-to-SFU native
bandwidth estimate fell from about 12 Mbps to about 0.22 Mbps while capture
settings remained at 30 fps; the server process, kernel queues, and network
device reported no contemporaneous resource or drop pressure. The deployed
LiveKit Server 1.13.5 also predates the upstream simulcast RTX pairing repair:
under the affected Pion integration, repair streams were not paired and
retransmissions were silently dropped. LiveKit Server 1.13.6 established the
RTX-repair baseline; `go.mod` owns the current dependency pin. This repairs loss
recovery; it does not claim to prevent loss on the Host-to-SFU UDP path.

The same later room also contained a separate interval in which the native
bandwidth estimate stayed near 13 Mbps while the sender media-source cadence
fell to about 1 fps. That interval is a capture/source-production boundary, not
an RTX-recovery result, and the LiveKit patch does not address it.

Chrome 151 exposed `fractionLost`, `packetsLost`, jitter, and RTT on the linked
`remote-inbound-rtp` sender report, but not the newer inherited
`packetsReceived` field. The previous sender percentage therefore remained
structurally unknown even when RTT proved that the report was linked. Current
source consumes the normalized `fractionLost` value once for each newer exact
RTCP report; a first report, repeated report timestamp, identity change,
timestamp rollback, missing field, or out-of-range value stays unknown. Viewer
route diagnostics also retain the already-authorized receive/loss deltas, RTT,
and jitter in the sanitized event. These fields remain observability only and
do not enter native quality classification, candidate comparison, or routing.

## Host And Page Cost Boundaries

Each ordinary Browser child is an independent PeerConnection and normally an
independent encode/network copy. A Browser relay decodes its upstream track and
re-encodes each child. Hardware codec success can reduce per-copy CPU but does
not change endpoint capacity or prove shared encode.

Host page visibility, captured-surface visibility, capture production, encode,
transport, Viewer decode, and local presentation are separate variables. Current
code pauses only the hidden/unfocused local preview. Browser/OS capture muting,
mobile suspension, page reclamation, and relay survival remain platform evidence
in [background capture research](./browser-background-capture.md), not Web
keepalive features.

The Media Capture specification copies a track's constraints when it is cloned,
then lets each clone change constraints independently. At the initial review,
Host Peer senders trusted those copied constraints while the SDK SFU publisher
applied the same profile again. That observation did not establish a safe
constraint-removal change; the later embedded publisher owns its current path.

Web content has no supported API for raising capture, encoder, renderer-process,
GPU, or operating-system scheduling priority. WebRTC sender `priority` allocates
bandwidth relative to other RTP senders and `networkPriority` requests DSCP;
neither reserves encoder CPU. `scheduler.postTask()` orders JavaScript work,
Screen Wake Lock prevents display sleep while visible, and Picture-in-Picture
does not change page visibility. Silent audio, animation loops, or command-line
throttling flags are therefore not product keepalive mechanisms.

The mature resource choices remain bounded Browser P2P copies, one bounded SFU
publication when its accepted route condition applies, or native/shared
encoding. LiveKit Dynacast can stop unused SFU representations; it cannot combine
independent P2P encoders.

### Current Pipeline Screening

Chrome 151.0.7922.175 headless loopbacks on 2026-08-31 used one isolated
Browser process, deterministic high-motion canvas capture and three Viewer
pages on the same machine. They exercise real capture tracks, PeerConnections,
VP8 encode/decode and the deployed Peer topology, but deliberately amplify
shared Browser/GPU/CPU contention and are not a distributed-network claim.

| Profile and topology | Host encode | Host cadence | Browser CPU | Receive result |
| --- | ---: | ---: | ---: | --- |
| 720p30, 3 Viewers | 3.62 ms/frame | 29.93 fps | 163% average | 30.06 fps; no freeze |
| 1080p30, 3 Viewers, run 1 | 10.83 ms/frame | 29.25 fps | 353% average | 28.87 fps; no freeze |
| 1080p30, 3 Viewers, run 2 | 11.00 ms/frame | 28.92 fps | 374% average | 28.53 fps; no freeze |
| 1080p30, 3 Viewers, run 3 | 19.71 ms/frame | 25.25 fps | 450% average | 25.40 fps; 7 freezes / 3.38 s |

Each repeat launched a fresh Chrome process. The spread proves a resource cliff
and run-to-run system sensitivity, not a deterministic three-Viewer limit. A
prior 1-to-2-to-3 sequence in one Browser process produced a similarly poor
last arm even though every page was closed between cases; cross-arm Browser
state and a 250 ms cleanup gap make that sequence unsuitable for performance
comparison. Future arms must use independent processes, repeated/randomized
order, actual output resolution, and system-load context. Aggregate
`qualityLimitationReason` alone did not describe the worst arm.

The same harness then added per-page CDP `TaskDuration`, script, layout, style
and heap deltas using each page's own monotonic timestamp. In a 20-Viewer
720p30 burst, all route checks passed and every Viewer decoded, but the Host
page used 36.35% of one main thread on average and briefly approached a full
thread; almost all measured work was script, not layout or style. This validates
the existing Host-only diagnostic-rendering gate without attributing the
same-machine media CPU to production.

The accepted implementation keeps every quality-evidence ref update and
freshness timer immediate while coalescing only the React presentation commit
to at most one animation frame. Two independent after-runs retained all seven
route checks and every Viewer decode while Host main-thread task utilization was
20.89% and 25.09%, with a 31.41% maximum interval. The change adds no media
sampling interval, route delay or quality threshold.

A final 20-Viewer acceptance run sampled the Host plus one plain Viewer and one
relay while retaining full-page topology and decode checks. All seven checks
passed, every Viewer decoded, and Host task utilization was 22.22% average and
34.48% peak. The isolated same-machine Browser consumed 738% aggregate CPU and
Host media-source cadence averaged 14.93 fps, so this arm validates bounded
topology and diagnostic rendering rather than representative distributed media
headroom.

The benchmark now groups exact committed receive metrics by Peer depth and
keeps SFU as a separate cohort. Three fresh 1080p30 Auto runs after the Host GPU
selection changed all resolved to H.264. Host and relay senders sustained
29-30 fps at roughly 7 ms encode time per frame; depth-one and depth-two Viewers
kept the same 1280x720 delivered size with no freeze windows. Depth-two jitter
buffer delay was 9.6-36.6 ms average versus 3.5-5.4 ms at depth one. The clean
loopback therefore shows no generational cadence or resolution loss, while the
extra receive-buffer/decode/encode hop retains an inherent latency cost. It does
not justify changing endpoint capacity, degradation policy or jitter targets.

A 20-Viewer 720p30/VP8 stress arm retained all seven topology and media checks,
zero unresolved route samples and the fixed endpoint cap of two. With all 21
pages sharing one Chrome/GPU, delivered cadence declined from 23.5 fps at depth
one to 20.3 fps at depth four, cumulative freeze counts rose from 3 to 28, and
average jitter-buffer delay rose from 28.6 ms to 88.8 ms. This intentionally
amplified process is not a production quality estimate, but it confirms that
each Browser receive-buffer/decode/encode hop has cumulative cost. Removing that
cost requires encoded forwarding or fewer hops; it is not grounds to change the
accepted capacity, SFU, bitrate or degradation settings.

Static route loading was the remaining proven application-level duplication.
The old entry parsed Host, Viewer and Join pages for every route. Immediate
route-specific prefetch plus React lazy execution reduced the common JavaScript
asset from 717.36 KB / 193.03 KB gzip to 454.53 KB / 123.71 KB gzip. Host and
Viewer then load only their own page plus the shared codec chunk; Join adds a
1.97 KB chunk. A three-Viewer media gate retained all route, capacity, quality
and decoded-frame checks. This changes download, parse and retained module work,
not media behavior or settings.

### Recovery Ownership

The earlier Browser measurements above do not describe the current Native or
pooled implementation. A 2026-10-15 producer-to-consumer review distinguishes
these recovery owners; the [media-quality standard](../standards/media-quality.md)
owns their required behavior.

| Path | Demand and recovery boundary |
| --- | --- |
| Ordinary Browser P2P / relay | Host ceilings remain sender limits. WebRTC owns probing and encoder adaptation. A Browser relay cannot restore detail already removed upstream. |
| Browser shared encoding | The outgoing carrier retains Host ceilings; its native video allocation updates the existing local producer. Actual encoded byte rate is not the producer's requested ceiling. |
| Browser SFU publication | WebRTC budgets the aggregate simulcast upload. Fenced SFU demand controls the active prefix; profile changes retain that demand. This does not use the Native publication allocator. |
| Native P2P / derived relay | The shared forwarding adapter retains unmet local encoder demand within the current layer and declared demand for dormant higher outputs. Group budget changes keep the transport; accepted recovery frames own group changes. |
| Native SFU publication | Explicit unmet local encoder demand keeps the existing allocator probing even when the sole active RID fits at its reduced rate. Desired demand remains separate from measured output/capacity; see the [controlled comparison](./node-local-media-design.md#send-queue-recovery). |
| SFU subscriber | Raw forwarding selects existing media. Declared higher-output demand can trigger probing and wake the publisher through direct-subscriber demand; the SFU does not encode missing detail. |

Follow requested quality -> committed network allocation -> source frames ->
encoded output -> delivered/decoded output when locating persistent degradation.
Restored bandwidth with reduced source frames, restored full-size source with
reduced encoder output, and an allocator that stopped probing are different
failures. A quiet scene can legitimately use fewer bytes than its budget;
receiving packets or regaining one low layer does not prove full recovery.
Refresh replaces several of these owners at once and cannot identify the cause.

This separation also exists in upstream WebRTC: its
[probe controller](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/probe_controller.cc)
keeps maximum allocation separate from estimated bandwidth, while encoder
resource adaptation has its own conditions. The current-main inspection does
not identify a particular Browser's build. Silip's
[Browser controls](./browser-local-encoding-pool.md#sustained-h264-recovery)
include both successful recovery and content-dependent encoder hysteresis after
allocation recovered. Native controls separately cover budget restoration,
dormant outputs, source replacement and retirement. Neither set establishes a
single cause for unmatched field reports; no reset loop, minimum quality or
second congestion controller follows from the shared symptom.

The [Native encoder control](./webrtc-encoder-pool.md#budget-restoration) also
separates restored allocation from later resolution recovery; that delay is not
specific to Browser capture or proof that a network estimate is still low.

### Media Adaptation Boundaries

Capability checks must cover the actual codec, adapter/device, dimensions,
frame rate, implementation, chroma sampling and bit depth. Native capture and
codec work should retain clear process and resource owners. Encoder cadence,
network congestion response and recovery demand are separate responsibilities.

WebRTC's pinned [probe controller](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/congestion_controller/goog_cc/probe_controller.cc)
already distinguishes a large bandwidth drop, a bounded recovery-probe window,
ALR and maximum allocation. Its [quality scaler](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/video_coding/utility/quality_scaler.cc)
separately requires samples and smoothed QP evidence. Silip's Native encoder uses
that encoder owner but receives transport budgets from Pion/LiveKit; copying a
GCC field trial into the encoder would not repair publication allocation.
The [publication demand repair](./node-local-media-design.md#send-queue-recovery)
restores this input without changing congestion thresholds. Any later policy
experiment must compare brief/repeated pulses with sustained congestion and
low-cadence sources, measuring latency, loss, recovery and retained dimensions.
The [Native QP comparison](./webrtc-encoder-pool.md#budget-restoration) tunes
that existing encoder owner; Browser internals expose a different API boundary.

A P2P study isolated a separate network/source boundary. It used one
stable Host-to-Viewer P2P edge with no reparent or SFU activity, yet Chromium
reported `bandwidth` for 112 consecutive sender windows, estimated only
0.42-1.78 Mbps available outgoing bandwidth, and adapted through 960p, 640p and
480p. At the same time, media-source cadence periodically fell to 1-7 fps while
track settings remained 30 fps, and Viewer freeze intervals followed those
lows. The event therefore contained both native BWE degradation and source
cadence loss; topology churn and CSS presentation were not required causes.

### Native Encoder Policy Experiments

Silip evaluated the encoder controls below in its existing Native pipeline.
The congestion-window setting illustrates a separate transport boundary; it
cannot configure Silip's Pion/LiveKit transport through encoder configuration.
The dropper and bitrate-adjuster experiments below measure the current Silip
pipeline, not another application's complete implementation.

| Native setting | Meaning and transfer boundary |
| --- | --- |
| `WebRTC-CongestionWindow/QueueSize:350,MinBitrate:300000,DropFrame:false/` | Configure GCC congestion-window pushback. The 350 ms queue allowance and 300 kbps pushback floor are not a guaranteed media bitrate; disabling drop-frame-only pushback does not disable congestion control. Silip's Native transport is Pion/LiveKit, so this encoder-side field trial cannot configure that transport. |
| `WebRTC-VideoRateControl/bitrate_adjuster:false/` | Disable WebRTC's encoder overshoot bitrate adjuster. This does not disable the codec's own rate control. |
| `WebRTC-FrameDropper/Disabled/` | Disable the external encoder frame dropper; other codec, queue and transport drop paths remain. |

The [upstream parser](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/rtc_base/experiments/rate_control_settings.cc)
and [encoder contract](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/api/video_codecs/video_encoder.h)
explain these independent controls. Encoder backend options are not portable
merely because they have similar names. Media Foundation does not expose every
NVENC quality/cost control; Silip's limited
[profile comparison](./native-client-media.md#native-h264-motion-quality)
does not establish parity with another native pipeline.

Shared encoding needs independent per-receiver rate and dependency state.
Silip separates incompatible consumer budgets into
[output groups](./webrtc-encoder-pool.md#compatible-output-groups) and uses
LiveKit's per-output forwarding state. Replacing that partition with one rate
aggregate changes its semantics.

The useful boundary is
request versus actual output: [Chromium's Media Foundation adapter](https://chromium.googlesource.com/chromium/src/+/d5070a6099ade2fe3c953d3b3677843e1a43e87e/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc)
records whether a keyframe request was fulfilled and delivers the actual frame
type rather than failing solely because it was not fulfilled.

A Windows inconsistency in Silip required a repair: every forced live
request required immediate SPS/PPS/IDR output or failed that codec output.
Windows now retains recovery intent until actual independent output, matching
the existing macOS/Linux behavior. First-output admission, bitstream validation
and real driver failures retain their existing handling. No new timer or recovery
owner is added. A synthetic codec regression checks that a delayed response
neither loses the request nor mislabels a delta frame. A separate 720p30 physical
MFT encode/decode control suppressed one force command after one second:
the previous implementation failed at `bitstream-recovery-unit`; the repair
decoded all 75 incumbent frames, supplied a new viewer's recovery on the next
frame and decoded its remaining 45 frames. This establishes controlled behavior,
not a diagnosis of an untraced user's driver failure.

Color conversion already has an explicit matrix/range owner and fidelity checks;
Silip retains its tagged BT.601 WebRTC SDR contract. Individual talker loss also
belongs to a different audio-feedback model than Silip's shared screen-audio
output; it does not justify a per-viewer audio encoder.

The two encoder field trials were applied, together and separately, to the
existing Windows NV12/MFT H264 lab. The control retained Silip's selected
[QP settings](./webrtc-encoder-pool.md#budget-restoration). Input was the same
1080p30 synthetic motion, a 5 Mbps ceiling and a 12 Mbps Pion link with 20 ms
router delay. Impairments limited that link to 400 kbps. Recovery below requires
five consecutive samples at 1080p and at least 27 received complete AUs/s;
these counters include parameter-set-only units. Receive gaps measure complete
AU delivery, not decoded pictures or Browser-rendered freezes.

| Encoder experiment | Three one-second limits: recovery / longest receive gap | Fifteen-second limit: recovery / longest receive gap |
| --- | --- | --- |
| Current Silip settings | 1.9 s / 1.48 s | 22.2 s / 6.43 s |
| Both encoder trials | 17.3 s / 2.84 s | 16.2 s / 14.96 s |
| Only disable frame dropper | 8.1 s / 2.83 s | Not run |
| Only disable bitrate adjuster | 15.2 s / 1.97 s | Not run |

Direct-budget controls initially looked better: both trials retained 1080p
through brief pulses and shortened sustained-limit recovery from 11 to 9 seconds.
However, sustained 400 kbps output averaged about 746 kbps instead of 380 kbps
over the settled low-budget interval. Coupling actual transport feedback exposed
the delivery tradeoff above. These single runs reject a blanket transplant;
they do not estimate another application's performance or field failure rates.
Production retains the existing dropper and adjuster. No new controller,
FFmpeg dependency or periodic connection reset follows from this comparison.

A separate control applied bitrate-update thresholds at Silip's
existing Native encoder demand input, without changing the transport estimator.
At fixed 30 fps, updates passed only when their difference exceeded 10% or
200 kbps. Four 120-second runs used the same link impairments above. Recovery
here requires five consecutive one-second samples containing at least 27
1080p picture AUs; parameter-set-only units are excluded.

| Demand input | One-second pulses: recovery / longest picture-AU gap | Fifteen-second limit: recovery / longest picture-AU gap |
| --- | --- | --- |
| Current | 14.1 s / 2.39 s | 19.1 s / 6.99 s |
| Filter small changes | 16.2 s / 1.96 s | 23.3 s / 5.22 s |

Filtering reduced demand updates from 1,829 to 17 and from 1,706 to 6,
respectively, but delayed recovery and delivered fewer picture AUs overall.
The shorter worst gaps are a tradeoff, not an established overall improvement;
no filter is retained. The control also varies from the earlier runs, so their
1.9-second recovery is not a guaranteed recovery time. These remain Silip
experiments with the current Silip pipeline.

A follow-up tested whether tighter native rate control could make the two
trials useful together. NVIDIA recommends small VBV for low-latency encoding;
Silip's lab set the MFT
[H264 HRD buffer in bytes](https://learn.microsoft.com/en-us/windows/win32/codecapi/avenccommonbuffersize-property)
to one or four frames at each rate change. On the RTX 4070 SUPER / driver 617.42,
initial values read back correctly, but live writes returned success while
retaining the previous value until encoder recreation. At a direct 400 kbps
budget, four-frame buffering reduced settled output to 427 kbps, with 13 s
recovery; one-frame buffering produced 465 kbps but was still at 360p 69 s after
the budget returned. The four-frame variant was then exercised through the
same periodic Pion impairment: recovery was 13.3 s, with a longest picture-AU
delivery gap of 2.88 s, versus the existing control's 1.9 s and 1.50 s. These
gap counts exclude parameter-set-only units but are not rendered-frame timings.
The buffer variant therefore remains lab-only; no encoder recreation on bitrate
updates is added to force this property to work.

[ICE recovery boundaries](./nat-traversal.md#ice-recovery-boundaries) own
connection establishment separately.

## Quality Shadow

Strict v13 reports renderer-derived freeze/pause deltas only for exact current
foreground presentation with continuing decoded progress. Identity and
presentation changes establish a new baseline; missing fields remain unknown.
The controller retains one bounded fresh aggregate per child for the Host-only
acceptance snapshot. It does not change routes, capacity, SFU use, or media
settings.

A controlled production direct-P2P canvas run injected packet-loss pulses:

| Loss/pulse | Recovered freezes | Freeze duration | Outcome |
| --- | ---: | ---: | --- |
| 0% / 2 s | 0 | 0 ms | comparable |
| 10% / 2 s | 0 | 0 ms | comparable |
| 10% / 6 s | 1 | 282 ms | comparable |
| 30% / 2 s | 2 | 701 ms | comparable |
| 30% / 6 s | 11 | 3,585 ms | comparable |
| 100% / 2 s | 1 | 2,011 ms | comparable |
| 100% / 6 s | n/a | n/a | route identity changed |

All comparable arms had zero recovered pauses. The same loss rate produced
different presentation results, and the longest all-drop pulse crossed into
availability recovery. This proves the shadow path, not an active threshold or
counterfactual parent quality.

## Route-Selection Evidence Boundary

Current Viewer evidence cannot identify whether a poor result came from source
capture, an ancestor, the exact sender, the child decoder, or presentation. It
also cannot prove an unconnected path is better. A route decision therefore
needs exact sender evidence and real candidate media; combining current loss,
RTT, bitrate, FPS, resolution, and freezes into a score would not repair either
information gap. [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md) owns
the accepted local-convergence algorithm.

W3C `qualityLimitationReason` is only the most limiting factor at one instant.
Its cumulative `qualityLimitationDurations` can prove a same-identity interval
spent in `none`, `bandwidth`, or `cpu`; missing or reset values remain unknown.
This supplies a categorical native edge state rather than an application score.
One report is still not a future guarantee, so a candidate must carry real media
while the working route remains. A P2P candidate needs fresh healthy evidence
from its exact sender plus clean overlapping same-Viewer receive windows that do
not regress delivered dimensions or frame rate. Requiring an immediate strict
gain can deadlock while the retained and candidate senders still share source
adaptation. An expired one-shot relative proof rejects that candidate rather than
holding the operation until its deadline. Failure remains inconclusive without
cutting the old route.

Production observation on 2026-08-27 showed that one two-second degraded delta
could move an otherwise usable Host Peer edge to an already-active SFU whose
Viewer experience was worse. The SFU proof established healthy publication
ingress and decoded progress, not superiority over the old path. Active routing
therefore needs the existing persistent-limitation semantic, and SFU quality use
must be limited to multi-edge Host fanout relief rather than ordinary edge
replacement.

LiveKit exposes one participant-level `ConnectionQualityInfo` with no direction
field, while stream state only identifies an SFU-paused subscription. Neither
proves that a candidate SFU path is visually better than a retained P2P path.
The bounded canary therefore compares the same Viewer's simultaneous inbound
WebRTC windows by strict non-regression of delivered dimensions, frame rate, and
bitrate, with decoded progress and no freeze or pause. It does not combine them
into a scalar score or infer unconnected path quality. The single SFU
publication does not imply one quality node: Host ingress is generation-scoped,
and every Viewer subscription needs its own candidate proof.

The 2026-08-27 canary observed 21 successful Peer candidates, all
within two seconds, and 19 failed candidates with a 15-second median. Reusing the
existing five-second no-progress window for each background Peer candidate
therefore removes measured queue tail without adding a new threshold; candidates
with transport progress still retain the total deadline. The same run showed
that native sender health can recover while a Viewer still reports low delivered
FPS, so receiver-quality routing remains an evidence problem rather than grounds
for an uncalibrated FPS threshold.

Canary logs use stable room-scoped anonymous ordinals. They may record native
limitation reason and bounded sender/receiver FPS and bitrate already collected
by the application, but never display names, raw Peer IDs, SDP, ICE candidates,
tokens or media credentials.

SFU has asymmetric evidence. The Browser publication proves shared Host-to-SFU
ingress, while exact SFU-to-Viewer sending and layer selection live inside
LiveKit. The accepted model therefore keeps SFU as a bounded suffix: LiveKit
owns its stream state and adaptation, and the exact Viewer proves continuing
decoded progress. The application does not manufacture a per-Viewer SFU sender
score or layer choice.

This structure follows libwebrtc's native limitation classification instead of
reimplementing congestion control. QUIC path validation supports retaining a
working path until a new one is proved, but its timers and congestion state are
not copied. Overcast and End System Multicast demonstrate gradual measured
overlay parent changes; their periodic probes, scalar metrics, published
percentages, and tuning loops are not adopted for this Browser product.

## Evidence Limits

- Real games and sustained CPU/GPU contention across weaker Hosts and operating
  systems.
- Public-network and game-content resource behavior with two Host P2P copies,
  one LiveKit publication, and bounded candidate overlap. Current evidence does
  not calibrate a safe dynamic endpoint-capacity rule.
- Background SFU-to-P2P convergence currently proves availability before
  replacement; comparative non-regression remains a route decision to validate,
  not an accepted weighted quality policy.
- Exact Chrome 153+ Intel and AMD default H.264 behavior without diagnostic
  feature overrides.
- Codec cost and quality after stock BWE reaches steady state.
- Mixed P2P/SFU public-network quality, long-running thermals, A/V sync, mobile
  lifecycle, and 20-Viewer resource admission.
- Controlled and production correlation of Host SFU active representations,
  subscribed-quality changes, keyframe reacquisition, and Viewer freezes before
  changing Dynacast policy or its delay.

The earlier SDK clone-constraint and representation comparisons belong to that
retired composition. Current pending work is owned by [TODO](../todo.md), and
[verification status](../verification-status.md) owns acceptance limits.

## Primary Sources

- [WebRTC](https://www.w3.org/TR/webrtc/)
- [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC Priority](https://www.w3.org/TR/webrtc-priority/)
- [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [Screen Capture](https://www.w3.org/TR/screen-capture/)
- [libwebrtc adaptation](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/adaptation.md)
- [libwebrtc source-wants aggregation](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video/video_broadcaster.cc)
- [libwebrtc VP8 encoder](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/codecs/vp8/libvpx_vp8_encoder.cc)
- [libwebrtc startup frame dropper](https://webrtc.googlesource.com/src/+/f20ebb8adbf4fa781830e4384c61f732bd28a217/video/adaptation/video_stream_encoder_resource_manager.cc)
- [Chromium WebRTC encoder factory](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc)
- [Chromium Media Foundation encoder](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc)
- [Chromium H.264 software BRC](https://chromium.googlesource.com/chromium/src/media/+/24e0453977d38aada35c5e78fcec3d11d6cdea6e)
- [Chromium AMD H.264 workaround](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/gpu/config/gpu_driver_bug_list.json)
- [LiveKit publish options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [LiveKit screen-share encodings](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit Dynacast and simulcast](https://docs.livekit.io/transport/media/advanced/)
- [Scheduling APIs](https://wicg.github.io/scheduling-apis/)
- [Screen Wake Lock](https://www.w3.org/TR/screen-wake-lock/)
- [Picture-in-Picture](https://www.w3.org/TR/picture-in-picture/)
- [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
- [Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- [Agora degradation preferences](https://api-ref.agora.io/en/video-sdk/android/4.x/API/enum_degradationpreference.html)
- [TRTC encoding and QoS parameters](https://trtc.io/document/50775)
- [LiveKit server forwarder](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/forwarder.go)
- [LiveKit server defaults](https://github.com/livekit/livekit/blob/v1.13.5/pkg/config/config.go)
- [LiveKit Dynacast manager](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastmanagervideo.go)
- [LiveKit keyframe requests](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/downtrack.go)
- [LiveKit connection-quality protocol](https://github.com/livekit/protocol/blob/main/protobufs/livekit_rtc.proto)
- [Screego codec ordering](https://github.com/screego/server/blob/v1.12.4/ui/src/useRoom.ts)
- [Screego VP9 regression](https://github.com/screego/server/pull/132)
- [Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [Chrome DevTools Protocol Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- [QUIC path validation and migration](https://www.rfc-editor.org/rfc/rfc9000.html#name-path-validation)
- [Overcast overlay parent selection](https://cs.brown.edu/~jj/papers/overcast-osdi00.pdf)
- [End System Multicast adaptation](https://static.usenix.org/events/usenix04/tech/general/full_papers/chu/chu_html/index.html)

No implementation code was copied. LiveKit is Apache-2.0, libwebrtc uses its
BSD-style license, and Screego remains GPL research-only.
