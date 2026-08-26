# Realtime Screen-Share Quality Adaptation

- Research date: 2026-08-26
- Scope: Browser game-screen capture, encoding, P2P forwarding, and LiveKit SFU
- Status: strict-v13 evidence-only quality shadow deployed; production sampling
  and active policy remain open

## Current Conclusion

Current production and canonical source use a content-independent H.264 sender
gate with VP8 fallback. The local pre-share Host `VP8 | Auto | H264` selector is
implemented and Viewer relays remain automatic.
Display video uses `contentHint = "motion"`, and display audio uses
`contentHint = "music"`. The three recommended profiles and advanced settings
are ceilings, not delivery guarantees. WebRTC owns direct and peer congestion
control; LiveKit owns SFU representations, Dynacast, subscriber bandwidth
estimation, and layer forwarding.

On current Windows Chrome, Browser WebRTC VP8 is a software path. Chromium 151's
Windows hardware encoder backends do not enumerate VP8, and the measured Edge
151 binary likewise showed no VideoEncode activity. The Web page cannot select a
GPU encoder or vendor API. This is a platform boundary, not a missing Screener
setting. Real-game contention remains open because software encoding competes
with the game for CPU even when encode time is below the frame budget.

Screener does not define a resolution/FPS/bitrate ladder, custom SFU lower
representation, scene detector, quality score, parent probe, periodic
rebalancing loop, or manual layer selector. It supplies standard content intent,
the selected sender ceiling, and readback of what the browser accepted.

The active topology remains availability-driven. A hard connection failure,
non-paused 15-second decoded-frame stall, parent departure, or capacity
invalidation may trigger the ADR-0005 recovery operation. Loss, RTT, jitter,
bitrate, resolution, FPS, freeze counters, codec, and limitation reason are
diagnostic and cannot prove that another parent would be better.

## Browser VP8 Evidence

Chrome 151 exact-production tests with real `getDisplayMedia()` showed that
direct and Browser-relay VP8 can sustain about 60 fps after the stock bandwidth
estimator warms up. The observed ramp took roughly 25 to 30 seconds; a configured
60 fps or bitrate remains a ceiling rather than a startup promise.

One controlled no-hint/motion comparison showed that Chromium may preserve
motion by spatially downscaling when `motion` is set. That is the standard
content-hint tradeoff for games, not a minimum-resolution contract. Leaving the
hint unset can preserve screen-classified resolution while shifting pressure to
quantization or frame delivery, so the earlier no-hint improvement was not free
adaptation. Current policy follows the standard game-motion intent and leaves
the resulting tradeoff to the browser.

### Windows Browser Hardware Boundary

Chromium `151.0.7922.174` constructs a hardware WebRTC encoder only when the
platform Video Encode Accelerator advertises the negotiated profile. Its
Windows Media Foundation backend enumerates H.264, VP9, AV1, and optional HEVC,
but not VP8; the Windows D3D12 backend likewise has no VP8 encoder. Libwebrtc's
VP8 implementation is `libvpx` and reports `is_hardware_accelerated = false`.
`setCodecPreferences()` can select VP8 but cannot choose NVENC, AMF, QSV, a GPU,
or an MFT. Media Capabilities is only a capability query and cannot prove the
encoder actually used by an exact PeerConnection.

Headful, isolated Chromium loopbacks on the current Ryzen 7 9700X / RTX 4070
SUPER machine used the accepted VP8 profiles and one deterministic 1080p canvas
source. Each 30-second measurement followed only a five-second settle window,
so the 1080p60 results include the known bandwidth-estimator ramp and are
screening data rather than steady-state game-cost baselines. Browser CPU covers
the entire isolated instance; `100%` means one logical core and includes source
rendering, local decode, and Browser services.

All runs used repository commit `74c959aa629f66db20439c98d0ea37bdfe8e2d63`,
benchmark schema 3, `BENCHMARK_HEADLESS=false`, `BENCHMARK_DURATION_SECONDS=30`,
`BENCHMARK_SETTLE_SECONDS=5`, endpoint cap `2`, and no canary or recovery arm.
`BENCHMARK_PROFILE` selected the table's profile, `BENCHMARK_VIEWERS` selected
one or two Viewers, and the sender count is the observed Host result under cap
`2`; `CHROME_PATH` selected the exact Browser version shown. The reproducible
entry point is `npx tsx scripts/peer-assisted-benchmark.ts`.

| Run | Browser | Profile | Senders | FPS mean (range) | Resolution(s) | Encode ms/frame | Limitation samples | Browser CPU (valid intervals) |
| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |
| C30 | Chrome 151.0.7922.174 | 1080p30 | 1 | 30.0 (29-31) | 1920x1080 | 4.06 | `none` 16/16 | 96.6% (13/15) |
| C60-A | Chrome 151.0.7922.174 | 1080p60 | 1 | 55.2 (45-58) | 1920x1080, 1280x720 | 4.86 | `bandwidth` 10/16, `none` 6/16 | 136.4% (13/15) |
| C60-B | Chrome 151.0.7922.174 | 1080p60 | 1 | 55.6 (54-57) | 1920x1080, 1280x720 | 3.91 | `bandwidth` 10/16, `none` 6/16 | 122.6% (13/15) |
| C60-2 | Chrome 151.0.7922.174 | 1080p60 | 2 | 56.8 (55-59) | 1920x1080, 1280x720 | 5.03 | `bandwidth` 20/32, `none` 12/32 | 233.4% (13/15) |
| E60-A | Edge 151.0.4129.101 | 1080p60 | 1 | 48.6 (45-53) | 1920x1080, 1280x720 | 4.53 | `bandwidth` 12/16, `none` 4/16 | 137.9% (7/15) |
| E60-B | Edge 151.0.4129.101 | 1080p60 | 1 | 43.9 (28-53) | 1920x1080, 1280x720, 960x540 | 3.15 | `bandwidth` 12/16, `none` 4/16 | 104.2% (6/15) |

The 60 fps arms stayed below the configured ceiling and changed spatial
resolution while encode work remained well below 16.7 ms/frame. In these short
runs the local symptom coincided with stock bandwidth adaptation, not an encode
time overrun. The Chrome 1080p30 control held full resolution and cadence without
a quality limitation. Process-set changes made uncovered CPU intervals unknown;
the table does not fill them with zero.

Dynamic Windows GPU Engine sampling followed the isolated Browser descendant
PID sets in runs C60-B and E60-B. Ten valid samples in each run showed zero
`VideoEncode` and `VideoDecode` activity across the enumerated counters. Chrome
showed about 35.5% 3D and 1.6% Copy; Edge showed about 8.0% 3D and negligible
Copy. That activity is consistent with source rendering and texture movement but
does not prove per-engine attribution. The collector did not retain adapter-LUID
mapping, and the synthetic source exposed neither `encoderImplementation` nor
`powerEfficientEncoder`; these GPU counters are supporting observations only.
An existing fake `getDisplayMedia` Chrome sample did expose VP8 `libvpx` and
`powerEfficientEncoder = false`. The exact Chromium backend inventory, rather
than the GPU counters alone, closes Chrome's Windows VP8 hardware encode as
unavailable; E60-B provides no contrary Edge evidence.

### Chrome 151 Startup Matrix

On 2026-08-25, Chrome `151.0.7922.174` on Windows reproduced the production
symptom in a controlled local loopback with no external network. Every run used
the same fake `getDisplayMedia` monitor at 1920x1080@30, one P2P sender and
receiver, VP8 `libvpx` with `powerEfficientEncoder = false`, and sender ceilings
of 5 Mbps and 30 fps. Only the named startup input changed.

| Startup input | About 1 second | About 4 seconds | About 8 seconds | Limitation |
| --- | --- | --- | --- | --- |
| `motion + balanced` | 480x270, 13 fps | 480x270, 15 fps | 480x270, 14 fps | `bandwidth` |
| `motion + balanced + x-google-start-bitrate=4500` | 480x270, 14 fps | 480x270, 15 fps | 480x270, 14 fps | `bandwidth` |
| no hint + balanced | 1920x1080, 18 fps | 1920x1080, 19 fps | 1920x1080, 20 fps | `none` |
| `detail + balanced` | 1920x1080, 18 fps | 1920x1080, 19 fps | 1920x1080, 20 fps | `none` |
| `motion + maintain-resolution` | 1920x1080, 17 fps | 1920x1080, 20 fps | 1920x1080, 20 fps | `none` |

The transition matrix then started with `motion + maintain-resolution` and
changed only the sender degradation preference to balanced:

| Balanced transition | Observed result |
| --- | --- |
| At connection, about 11 ms | Fell to 480x270 and remained bandwidth-limited |
| After the first encoded frame, about 80 ms | Retained 1280x720 but remained bandwidth-limited |
| After five encoded frames, about 442 ms | Retained 1920x1080 with no limitation through 8 seconds |
| After one or two seconds | Retained 1920x1080 with no limitation through 8 seconds |

This isolates the failure from network, codec selection, hardware encoding,
capture constraints, sender readback, and the startup-bitrate SDP hint.
Chromium maps `motion` to non-screencast realtime video, where balanced permits
startup resolution restrictions; entering or leaving balanced clears those
restrictions. Five encoded frames is the first measured safe media fact and is
beyond libwebrtc's four-frame startup-drop bound, rather than an arbitrary wall
clock delay.

Screener keeps `motion` because its later multilevel resolution adaptation is
required. Each new peer sender and SFU publication therefore starts with the
selected ceilings but an effective `maintain-resolution` preference. After the
current sender has encoded at least five frames, the existing stats path applies
the user's desired preference once. Connected was too early, and one encoded
frame retained only 720p in the controlled matrix; five frames retained 1080p.
There is no added timer, periodic rewrite, or application quality controller.

## LiveKit SFU Evidence

Pinned LiveKit client `2.22.0`, server `1.13.5`, and Chrome 151 established that
the SDK's default VP8 screen-share simulcast can expose original and lower
representations, and that server send-side BWE can select a lower representation
for a constrained subscriber while an unconstrained subscriber receives the
highest available representation.

Pinned LiveKit retains its own codec and startup-bitrate behavior. Screener does
not add an SDP startup hint to raw peers; the controlled matrix showed that it
does not address this `motion + balanced` restriction.

An earlier exact-production A/B also showed that forcing an always-active lower
encoding can consume the same Host-to-SFU congestion budget and reduce the
highest encoding. That evidence rejects Screener mutation of active layers; it
does not justify single HIGH, which abandons constrained subscribers.

Current source therefore:

- creates one Host publication for all SFU subscribers;
- sets VP8, no backup codec, the selected HIGH ceiling, and degradation
  preference;
- leaves `screenShareSimulcastLayers` unset so pinned LiveKit owns construction
  and republish behavior;
- enables Dynacast and server send-side BWE;
- leaves AdaptiveStream disabled because a Viewer may relay the received track
  to children; and
- requests no application-selected subscriber layer.

LiveKit documents automatic bandwidth-based layer selection. It does not expose
an automatic policy that observes delivered FPS and spatially downshifts solely
to satisfy Screener's `maintain-framerate` preference. Adding such a controller
or fork remains outside the current product.

## Codec Decision

VP8 is the only Browser media codec because it has the broadest current Browser
interoperability and produced stable software-encoding behavior in the measured
Chrome path. Windows Chrome uses software VP8, and the measured Edge binary gave
no contrary hardware evidence; the page has no hardware encoder selection
surface. Other operating systems remain evidence-specific and must not be
inferred from the Windows backend.

Chromium's `has_trusted_rate_controller` is a libwebrtc coordination fact, not
Windows trust or security classification. Media Foundation video encoding
initially reports it false. When Chromium's H.264 software bitrate controller
owns frame dropping, MFVEA reports it true so libwebrtc disables its independent
media-optimization frame dropper and avoids double-dropping.

A controlled Chrome 151 loopback isolated this interaction on one AMD Media
Foundation encoder with the same dynamic 1904x928@30 source. The ordinary 8 Mbps
path emitted 14.18 fps at 14.24 ms encode time per frame. Forcing Chromium's
desktop H.264 software BRC on the same MFT emitted 29.93 fps at 8.17 ms per frame
and about 3.65 Mbps. Disabling hardware encode selected OpenH264 and emitted
10.47 fps. Raising the ordinary MFT ceiling or changing degradation preference
did not restore cadence. This proves that the observed AMD result was an outer
rate-control/frame-drop interaction, not a fixed MFT throughput limit; it is no
physical result for Intel or another AMD driver cohort.

Chrome 151 and 152 leave `MediaFoundationUseSWBRCForH264Desktop` disabled by
default. Chromium commit `24e0453977d38` enables it by default, caps desktop
quality at QP 35, caps HRD fullness, and uses predictive buffer headroom for
delta-frame dropping; exact Chrome 153 beta source contains that change, and
Chrome 153 stable is scheduled for 2026-09-08. AMD remains separately covered
by the vendor-wide `disable_h264_accelerator_sw_brc` workaround for Chromium
issue `417752242`, while `MediaFoundationSWBRCForH264ForceAMDGPU` remains
disabled in Chrome 153 and 154. Current source therefore implies that a selected
Intel MFT can receive the new default controller, but does not establish that
physical result. The accepted `motion` hint also maps the WebRTC encoder to the
realtime/camera content type whose H.264 SW BRC was already default-enabled; it
does not bypass the AMD workaround.

A Browser page cannot enable these process features, override the GPU workaround,
set `has_trusted_rate_controller`, or select a particular MFT. The two feature
names can reproduce the AMD bypass only in an explicitly launched diagnostic
browser. They are not a product workaround. OpenH264 was not a superior fallback,
so Browser H.264 remains closed until a future decision accepts exact Chrome 153+
Intel-default and AMD-default/forced real-game evidence. The separately proved
Native hardware-MFT path does not alter the Browser decision.

Screego `v1.12.4` does not supply another encoder path. Its settings list the
browser's RTP codec/profile capabilities, map `Best Quality` to VP9 profile 2,
and reorder all capabilities before each per-Viewer offer. Other codecs remain
negotiation fallback; no actual encoder, power-efficiency, frame-rate, or
runtime fallback evidence participates. Screego changed its default back to the
browser order after VP9 materially reduced frame rate, and its maintained P2P
fanout still creates one PeerConnection per Viewer.

The Browser candidates therefore have narrower potential than their names imply:

| Candidate | Potential advantage over VP8 | Current Browser stop line |
| --- | --- | --- |
| H.264 | Hardware encode can reduce Host CPU while retaining broad decode support. | Chrome cannot select a specific MFT; AMD remains outside SW-BRC by default, and the exact Intel/Chrome 153 result is unmeasured. |
| VP9 | Profile 0 may use a Windows Media Foundation encoder and can improve rate-distortion efficiency. | Screego's profile-2 preset is not the Windows hardware profile; software VP9 can cost more CPU and already caused a visible frame-rate regression. |
| AV1 | Modern hardware can provide the strongest compression candidate. | Chrome 151 and 153 keep Windows WebRTC AV1 hardware encode disabled by default, so codec support does not provide a usable hardware contract. |
| H.265 | Supported hardware can provide efficient H.264-class low-CPU encode at lower bitrate. | It is an advanced codec not supported by every Browser client; LiveKit compatibility requires regression or a backup publication, and the current cross-Browser relay matrix is absent. |

No candidate yet provides a product-wide Browser improvement with VP8's
coverage, so Browser media remains VP8. A bounded preflight nevertheless proved
that an actual sender can distinguish the previously bad and a newly good H.264
path without naming a GPU or trusting capability advertisement. All samples used
one real tab `getDisplayMedia()` source at 1904x928@30, `contentHint = "motion"`,
a 5 Mbps ceiling, five seconds of settling, and a ten-second measurement window.

| Browser and path | Actual implementation | Source / encoded / decoded cadence | Result |
| --- | --- | --- | --- |
| Chrome 151 direct H.264 | AMD Media Foundation hardware encoder; D3D11 decoder | 30.0 / 12.5 / 12.4 fps | Failed despite `powerEfficientEncoder = true`; encoded/source ratio 0.42. |
| Chrome 153 direct VP8 | `libvpx` software encoder and decoder | about 29.9 / 29.9 / 29.9 fps | Control sustained source cadence. |
| Chrome 153 direct H.264 | NVIDIA Media Foundation hardware encoder; D3D11 decoder | 29.9 / 29.9 / 30.0 fps | Full-cadence constrained baseline, ratio 1.00. |
| Chrome 153 LiveKit 1.13.5 H.264 | Simulcast adapter with two NVIDIA MFT encoders; D3D11 decoder | 29.5 / 29.1 / 29.1 fps | One `backupCodec: false` HIGH+LOW publication delivered the HIGH stream, ratio 0.99. |

Exact Chrome 153 also sustained about 30 fps on two simultaneous direct H.264
senders. A Host-to-Browser-relay-to-child chain sustained 29.6-29.7 fps at full
source resolution, and both encode stages remained NVIDIA MFT while both decode
stages remained D3D11. The dual-direct sample was still inside native bandwidth
ramp-up and therefore proves encoder cadence, not steady resolution quality.
Process identities changed during startup, so those whole-browser CPU deltas are
not retained as a codec cost claim.

`powerEfficientEncoder` alone cannot be the gate because the cadence-failing AMD
path also reported true. The portable evidence is the actual negotiated H.264
profile and implementation, plus identity-stable source-frame and encoded-frame
progress; the successful cohorts kept their encoded/source deficit bounded while
the bad path dropped frames continuously. The accepted gate uses a deterministic
moving Canvas track at the current share's effective target dimensions and frame
rate so static captured content cannot make encoder evidence inconclusive. It
warms the sender for 500 ms, measures for at least one second, and derives its
allowed frame lag from one 100 ms stats polling interval at the selected target
FPS; both source and encoded progress must reach that target. The four-second
deadline bounds local negotiation and evidence collection rather than defining
the performance threshold. With the real shared source held static through the
decision, exact Chrome 151 selected VP8 while exact Chrome 153 selected H.264;
the same moving-source runs selected VP8 and H.264 respectively. These two local
cohorts validate the mechanism but do not replace broader device and game-load
acceptance.

For direct peers, native SDP negotiation can order H.264 before VP8 in one offer
and choose the first codec supported by both endpoints; it does not require a
VP8 connection and a parallel H.264 connection. The accepted Browser design is
one share-scoped Host sender preflight and one received-source-scoped
Browser-relay preflight: a proved sender prefers H.264 for future edges,
otherwise it retains VP8, and already active edges are not churned. A single SFU
publication still cannot provide per-subscriber H.264 and VP8 without a second
encoded publication.
LiveKit backup codec is therefore not accepted. The Host source decision owns
that single publication: resolved H.264 or VP8 with no backup codec. No VP9,
AV1, H.265, codec wire/cache, parallel publication, or active-edge codec switch
is accepted by this evidence.

HEVC, AV1, custom WebCodecs pipelines, and application packetization do not
replace the browser WebRTC sender without a new capture, RTP/RTCP, feedback,
hardware, interoperability, and licensing design. No such path is accepted.

## Host Cost Boundary

One Chrome 151 VP8 sample on a Ryzen 7 9700X used about 0.79 logical core for one
1904x928@30 sender and about 1.34 logical cores for two independent senders. The
process totals included capture, WebRTC, source rendering, and local decode, so
they are not a weak-device or real-game capacity claim. Browser peers retain one
independent sender and congestion controller per `RTCPeerConnection`; shared
encoding is not guaranteed.

The current 1080p60 synthetic samples measured roughly 1.23 to 1.36 logical
cores for the whole isolated Browser with one sender and about 2.33 with two.
The second arm also added another Viewer, decode, render, and connection, so the
difference cannot be attributed to encoder count. The architectural boundary of
one ordinary sender per PeerConnection comes from WebRTC behavior, not this CPU
comparison; the measurement does not justify a shared Browser encoder.

The accepted way to handle a constrained Host is the existing explicit share
profile. Screener does not silently remove a representation needed by a weak
Viewer or invent a hidden host-performance tier.

## Page Lifecycle Boundary

Host document visibility, captured-source visibility, capture production,
encoder throughput, transport, Viewer decode, and local presentation are
different variables. Current code pauses only the Host's muted local preview
when its page is hidden or unfocused; it does not stop capture or senders.

Browser timers and frame callbacks may be delayed while hidden. A resumed Viewer
must rebaseline the existing decoded-stall wall clock before another no-progress
sample can invalidate the route, and a new current-generation composited frame
is authoritative evidence that stale `connecting` or `reconnecting`
presentation has ended. These rules make recovery lifecycle-safe; they are not
a keepalive mechanism.

The Screen Capture specification permits a user agent to mute a captured surface
that becomes inaccessible, including a minimized captured window. A page cannot
override that platform boundary. Mobile background audio, video recovery, page
reclamation, and relay survival remain physical-device acceptance work.

## Route Quality Authority

Current parent selection hard-filters authorization, source reachability,
acyclicity, capacity, and resource admission, then orders eligible P2P parents
by resulting depth, remaining sender capacity, a stable child-parent hash, join
order, and peer identity. Initial acquisition gives one direct candidate a
bounded foreground window, then uses SFU for availability while finite direct
candidates converge behind working media. It has no network-quality score.

A manual media reconnect stays on the current exact route: P2P rebuilds the
same parent connection, and SFU reconstructs the same subscription. Browser
page refresh also rebinds the same stable participant and committed graph.
Only actual recovery exhaustion enters the normal route-failure operation and
tries other eligible P2P parents before SFU.

Quality-driven relay abdication or active parent switching requires evidence
that current diagnostics do not yet provide. No active policy is implemented.

The reopened quality-selection research retains that information boundary.
Current-route WebRTC stats can prove user-visible degradation but cannot prove
that an unconnected parent is better. Mature overlay systems such as ALMI and
Overcast measure alternatives and require a meaningful improvement before
moving; their periodic all-neighbor probes and published example thresholds do
not fit Screener's Browser, capacity, or latency contract.

The smallest compatible model is one `QualityEpisode` owned by the existing
room controller. It creates no parent score, second graph, all-pairs probe, or
periodic rebalancer. Phase one uses only visible, locally playing, non-paused,
identity-stable freeze duration with continuing decoded progress. Loss, RTT,
jitter, bitrate, resolution, FPS, and decode time remain attribution; treating a
quality ceiling as a delivered floor requires a separate product SLO. Relay
ingress degradation reparents that relay while retaining its subtree; one
child's degradation moves only that child.

The implemented first stage is shadow evaluation only. Viewer evidence adds the
standard cumulative-renderer deltas `freezeCount`, `totalFreezesDuration`,
`pauseCount` and `totalPausesDuration` and requires continuing
`framesDecoded` progress. W3C already
defines a freeze relative to the last 30 rendered frames, so this phase invents
no FPS, bitrate, loss or latency threshold. A recovered freeze or pause updates
its duration only after a later frame is rendered, so a valid delta may exceed
the adjacent report window and must not be clipped. Current target Chromium
does not map W3C `framesRendered` into `RTCInboundRtpStreamStats`, so synthetic
fixtures must not make it a product dependency. A missing member is unknown;
only windows containing decoded progress and all four freeze/pause metrics enter
the aggregate.

Presentation eligibility binds visible/not-suspended page state, non-paused
Host authority, native video play state, current composited-frame proof and the
exact connected route. Every eligibility change advances a strictly monotonic
presentation epoch. The first completed stats sample in an epoch is only a
baseline; an async sample may be emitted only if the epoch is still current.
Rate limiting remains per Viewer connection across epoch changes.

After the signaling layer revalidates the authenticated Viewer, current upstream,
connection and room revision, the existing room controller independently checks
its exact committed edge. It retains no samples or event ring, only one safe-
integer aggregate for the latest accepted epoch of each current child:
eligible windows/duration, recovered-freeze windows/count/duration, pause
count/duration, and the last accepted time used by the existing five-second
freshness rule. The Host-only on-demand route snapshot exposes that closed
aggregate under the child's temporary ordinal; it exposes no epoch, session,
connection, raw metric or timeline. Observation does not touch controller facts
or trigger route work.

### Strict-v13 Production Shadow Control

On 2026-08-27, production release `73ed920` and Chrome
`151.0.7922.174` ran isolated one-Host/one-Viewer direct-P2P controls with a
deterministic 1280x720@30 canvas source. Runner commit `802781878701` is retained
on `dev/retained-candidates`; it creates and abandons its own room and exports
only the anonymous Host diagnostic snapshot. A global CDP network rule was
installed at zero before the Viewer PeerConnection was created, then changed
for one bounded pulse and restored to zero. The rule returned a non-empty ID;
the final snapshot was comparable only when route revision, connection
generation, presentation epoch, Viewer session generation, parent and route all
remained unchanged.

| Packet loss | Pulse | Eligible windows / duration | Recovered freezes | Freeze duration | Result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0% | 2 s | 2 / 4,001 ms | 0 | 0 ms | comparable |
| 10% | 2 s | 3 / 6,000 ms | 0 | 0 ms | comparable |
| 10% | 6 s | 3 / 6,000 ms | 1 | 282 ms | comparable |
| 30% | 2 s | 2 / 4,000 ms | 2 | 701 ms | comparable |
| 30% | 6 s | 5 / 10,002 ms | 11 | 3,585 ms | comparable |
| 100% | 2 s | 4 / 8,000 ms | 1 | 2,011 ms | comparable |
| 100% | 6 s | n/a | n/a | n/a | route identity changed |

All comparable cells reported zero recovered pauses. The controls establish
that the strict-v13 collection path accepts renderer-settled freeze duration
across report windows and leaves the route unchanged. They also reject a loss
percentage, one freeze, or one pulse duration as a product trigger: the same
loss level produced different presentation results, and the longest all-drop
cell crossed into availability recovery instead of remaining a quality sample.
This synthetic direct cohort does not calibrate an active threshold or predict
another parent; real games, natural public-network sessions, relay subtrees,
SFU cohorts and mobile lifecycle evidence remain required.

Active migration follows only after annotated production samples establish an
acceptable false-positive and disruption boundary. An active episode would keep
the existing first-frame commit rule, allow one low-priority trial and at most
one restore, and yield immediately to join, hard recovery, departure, capacity,
pause, or SFU drain work. Post-commit probation measures the actual presented
path without holding two long-running media routes whose competing bandwidth
and non-rendered candidate metrics would distort comparison. The trigger,
probation, cooldown, inconclusive result and permission to create or prioritize
SFU resources remain the next product decision.

The possible active state machine remains `observe -> qualified -> queued ->
trial prepare -> first-frame commit -> probation -> keep | restore once ->
cooldown`. It uses the existing reservation and room-serial child operation,
permits no bounded-gap quality trial, and yields to availability work. Relay
ingress evidence may reparent that relay while retaining its subtree, but one or
several child reports cannot infer that the relay is globally bad. Phase one has
no quality-driven relay-wide abdication. Freeze entry/exit, probation evidence,
improvement margin, cooldown, and room disruption budget must be calibrated from
real annotated sessions; paper and library defaults are not Screener thresholds.

The candidate active model has one `QualityEpisode` inside the existing room
controller, not a second optimizer. It keeps only the exact subject, prior
route or capacity, trigger-evidence revision, trial revision, probation
baseline, one restore flag, and a cooldown `notBefore`. Cooldown expiry does not
wake the room; the next real room or evidence event may reconsider it. Join,
hard recovery, departure, pause, capacity, and SFU drain work always preempt and
clear lower-priority quality work.

One episode asks the existing deterministic filters and ordering for only the
first eligible candidate. It prepares that single route through the existing
capacity and server-resource reservations, retains the old route until first-
frame commit, then measures the new presented path sequentially in probation.
Failure is inconclusive and enters cooldown; it does not enumerate more parents.
Probation may restore the old tuple once through the same child operation. A
quality-only trial is skipped when make-before-break overlap is unavailable;
bounded-gap cutover remains reserved for availability recovery.

The same episode model covers every transport without a P2P/SFU state matrix:

- one degraded child is the subject of an ordinary reparent operation;
- a relay with degraded ingress is itself the child, so its subtree remains;
- healthy ingress plus corroborated degradation across multiple exact child
  sender/receiver pairs may reduce that parent's effective capacity by one,
  letting existing overflow reconciliation move one child at a time;
- a Host-wide egress problem with a healthy source may trial the existing SFU
  publication as one candidate, but only with normal Host overlap, publication,
  subscription, and admission reservations; and
- an SFU-fed Viewer remains an ordinary peer parent candidate and never creates
  a second publication.

Capacity recovery is event-driven half-open: after cooldown, a later real demand
may use one provisional slot, and that child supplies probation evidence. No
demand means no probe or rebalance. At `C=3`, a full Host has no fourth-copy
overlap; it must first move one child make-before-break through an already
eligible peer or skip the Host-to-SFU quality trial. SFU admission rejection
keeps the healthy route and ends the episode without joining the availability
resource-wait queue.

Current-path evidence cannot prove an unconnected path is better. FPS,
resolution, and bitrate require a same-window source baseline; configured
ceilings are not delivered floors. Loss, RTT, jitter, NACK/PLI, encode/decode
time, and `qualityLimitationReason` remain attribution unless corroborated by
presented-path evidence. Parent-wide abdication additionally needs evidence from
multiple distinct current children plus their exact sender constraints while
the parent ingress remains healthy; `C=1` therefore cannot infer parent-wide
quality from one child.

Production shadow data must determine every policy number: entry/exit floor,
minimum eligible windows and duration, aligned-window tolerance, probation,
meaningful improvement margin, cooldown, per-room disruption budget, `C=3`
quorum, Host-to-SFU gate, inconclusive rate, and browser/mobile missing-field
rate. Overcast's percentage, End System Multicast's hold-down/probe cadence,
QUIC path timers, circuit-breaker defaults, and paper test payloads are evidence
about structure only and are not accepted thresholds.

Overcast and ALMI support measured gain versus disruption before switching.
RFC 8326 supports drain-before-removal; RFC 9000 supports validating a new path
while the old path remains usable and not inheriting old congestion state. RFC
7196's documented damping false positives support shadow-first observation, but
its penalty score is not adopted. A half-open concept is useful without adding
a circuit-breaker dependency or sliding failure-rate controller. SplitStream,
CoolStreaming/DONet, and SAAR require multi-tree striping, mesh/block pull, or a
second active control overlay and remain explicit no-go references for this
single-graph product.

This research adds no dependency and copies no implementation. LiveKit is
Apache-2.0, libwebrtc uses its BSD-style license, and Resilience4j is
Apache-2.0; papers, RFCs, and W3C documents are referenced only for design
evidence. GPL/AGPL reference implementations remain study-only under the
repository license boundary.

## Current Verification Gaps

- Real games under competing CPU/GPU load at 720p30, 1080p30, and 1080p60.
- Real-game CPU contention on Windows and actual encoder paths on
  macOS/Linux/weaker Hosts.
- Mixed P2P/SFU sessions on heterogeneous public networks, including recovery.
- Mobile foreground/background playback, page reclamation, and relay survival.
- Long-running encode/decode cost, thermals, A/V synchronization, and resource
  admission at the 20-Viewer bound.

Measurements must correlate capture, outbound, and inbound stats over the same
interval. Missing counters and identity changes remain unknown, not zero.

## Primary Sources

- [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [Screen Capture](https://www.w3.org/TR/screen-capture/)
- [Media Capture from DOM Elements](https://www.w3.org/TR/mediacapture-fromelement/)
- [WebRTC](https://www.w3.org/TR/webrtc/)
- [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [libwebrtc adaptation overview](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/adaptation.md)
- [Chromium content-hint capture mapping](https://chromium.googlesource.com/chromium/src/+/3468eea378284a9cc42d05532cf3e1ee1f716fa9/content/renderer/media/webrtc/webrtc_video_capturer_adapter.cc)
- [libwebrtc content-hint sender mapping](https://webrtc.googlesource.com/src/+/98c256dadcab7c69e45de78091da9932d244f2e3/pc/rtp_sender.cc)
- [libwebrtc balanced restriction reset](https://webrtc.googlesource.com/src/+/f20ebb8adbf4fa781830e4384c61f732bd28a217/call/adaptation/video_stream_adapter.cc)
- [libwebrtc startup frame dropper](https://webrtc.googlesource.com/src/+/f20ebb8adbf4fa781830e4384c61f732bd28a217/video/adaptation/video_stream_encoder_resource_manager.cc)
- [LiveKit initial-quality fix](https://github.com/livekit/client-sdk-js/pull/1987)
- [LiveKit initial-quality implementation](https://github.com/livekit/client-sdk-js/commit/5db17af)
- [LiveKit screen-share encoding construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit video simulcast and Dynacast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
- [LiveKit server forwarding](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/forwarder.go)
- [Chromium WebRTC encoder factory](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc)
- [Chromium 151 WebRTC video codec factory](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.174/third_party/blink/renderer/platform/peerconnection/video_codec_factory.cc)
- [Chromium 151 Windows Media Foundation encoder profiles](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.174/media/gpu/windows/mf_video_encoder_shared_state.cc)
- [Chromium D3D12 video encoder profiles](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/gpu/windows/d3d12_video_encode_accelerator.cc)
- [libwebrtc VP8 encoder](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/codecs/vp8/libvpx_vp8_encoder.cc)
- [libwebrtc trusted-rate-controller contract](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder.h)
- [libwebrtc outer frame dropper](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_stream_encoder.cc)
- [Chromium Media Foundation encoder rate-control integration](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc)
- [Chromium desktop H.264 SW BRC change](https://chromium.googlesource.com/chromium/src/media/+/24e0453977d38aada35c5e78fcec3d11d6cdea6e)
- [Chrome 153 H.264 MF feature defaults](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.5/media/gpu/windows/mf_video_encoder_switches.cc)
- [Chromium AMD H.264 SW BRC workaround](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/gpu/config/gpu_driver_bug_list.json)
- [Chromium AMD SW BRC issue 417752242](https://issues.chromium.org/issues/417752242)
- [Chrome 153 release schedule](https://developer.chrome.com/blog/chrome-two-week-release)
- [Screego codec preference implementation](https://github.com/screego/server/blob/v1.12.4/ui/src/useRoom.ts)
- [Screego VP9 quality experiment](https://github.com/screego/server/pull/132)
- [Screego per-Viewer encode cost](https://github.com/screego/server/issues/160)
- [Chromium Windows WebRTC hardware codec mapping](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.5/third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc)
- [Chromium WebRTC AV1 and H.265 feature gates](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.5/media/webrtc/webrtc_features.cc)
- [LiveKit advanced and backup codec contract](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [Overcast parent measurement and hysteresis](https://pdos.csail.mit.edu/~jj/jannotti.com/papers/overcast-osdi00/)
- [ALMI application-level multicast](https://www.usenix.org/legacy/event/usits01/full_papers/shi/shi_html/)
- [End System Multicast](https://static.usenix.org/events/usenix04/tech/general/full_papers/chu/chu_html/index.html)
- [RFC 8326 graceful routing shutdown](https://www.rfc-editor.org/rfc/rfc8326.html)
- [RFC 9000 path validation and migration](https://www.rfc-editor.org/rfc/rfc9000.html)
- [RFC 7196 route-flap damping](https://www.rfc-editor.org/rfc/rfc7196.html)
- [RFC 8836 WebRTC congestion-control interactions](https://www.rfc-editor.org/rfc/rfc8836.html)
- [Resilience4j circuit-breaker states](https://resilience4j.readme.io/docs/circuitbreaker)
- [SplitStream](https://www.microsoft.com/en-us/research/wp-content/uploads/2003/02/castro03splitstream.pdf)
- [CoolStreaming/DONet](https://researchportal.hkust.edu.hk/en/publications/coolstreamingdonet-a-data-driven-overlay-network-for-peer-to-peer/)
- [SAAR](https://static.usenix.org/event/nsdi07/tech/full_papers/nandi/nandi_html/index.html)
- [Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [Chrome DevTools Protocol Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
