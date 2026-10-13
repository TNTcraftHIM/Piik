# Native App Media Evidence

- Reviewed: 2026-10-11
- Scope: platform capture, shared encoded sources, Pion transport and Browser
  decode; current behavior belongs to [media quality](../standards/media-quality.md)
- Status: Windows physical native Host and Viewer gates passed; both macOS
  architectures compile and pass packaged startup; macOS/Linux physical media gates remain open

## Windows Audio Exclusion

A Windows 11 build 26200 check used two independent WinMM processes emitting
500 Hz and 1500 Hz tones, through the production capture helper and Go PCM
reader. Default-device loopback captured both at approximately 1799 amplitude;
process inclusion retained the first with under 0.3 amplitude of the other,
and exclusion retained the second with under 0.04 of the excluded tone. Target
exit retired capture in about 42 ms; attempting the stale identity failed.
No raw audio was saved. The extended capability probe completed in 300 ms.

A parent/child follow-up used a silent selected parent with a 1900 Hz child,
plus an independent 2900 Hz process. Process-scoped reference amplitudes were
about 1799; exclusion retained the independent tone at 1800 and reduced the
selected child's tone to 9.3 (under 0.6%). Parent exit retired capture in 64 ms;
its stale identity was rejected. The reference uses each signal's own process
capture: default-device loopback also includes unrelated playback and endpoint
processing, so its amplitude is not a process-capture gain reference.

The session fixture separately verifies failed exclusion replacement mutes
source audio while preserving video, microphone and encoded audio output; pause
and audio-profile changes retain the selected input. These checks establish a
local Windows implementation and one direct child, not coverage of every voice
application's process tree or simultaneous playback across several output devices. Those remain
device acceptance boundaries. [ADR-0008](../adr/0008-window-scoped-audio-capture.md)
owns the platform choice.

The capability check attempts inclusion and exclusion activation independently,
without an OS-version gate. Microsoft documents 20348 as the minimum, while OBS
documents application loopback on Windows 10 2004+; the activation result, not
an OS label, controls availability. Physical Windows 10
exclusion remains unverified. A session regression check changes exclusion and
source-audio off/on while video preparation is deliberately unavailable: the
capture stream, encoded source, audio output and connected edge remain the same.

The [Windows activation contract](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)
accepts one PID and its process tree, not a list of unrelated processes.
The [win-capture-audio implementation](https://github.com/bozbez/win-capture-audio/releases/tag/v2.2.0-beta)
supports broader exclusion by tracking audio sessions, capturing non-matching
processes and mixing them. Applying that design here would require session
discovery, process-tree deduplication and bounded multi-input mixing; Piik's
current source-plus-microphone mixer does not own that inventory. Multiple
exclusions therefore require a capture design change, not just a multi-select
control. Combining exclusion streams does not itself exclude their combined set.

## Initial Physical Evidence (2026-09-05)

These checks established the original native media paths. The Browser-mediated
SFU and loopback v8 observations below are historical. [ADR-0013](../adr/0013-embedded-node-local-media.md)
owns the SFU replacement; [versioning](../standards/versioning.md) owns the current
wire contract.

Piik App can own one process-isolated Windows capture and hardware H.264
encoder, feed its Annex-B access units into one Pion source, and deliver that
source through independent WebRTC transports to unmodified Chrome receivers.
The Browser remains the room, route, and signaling authority.

The same App can run the Local authority, open the normal Host page, and
attach that native source to the current route. A remote Pion Viewer then
received 30 packets over a selected `srflx`-to-`srflx` pair. The validation
session carried signaling through a temporary reverse SSH path only; media was
negotiated directly by ICE.

On 2026-09-05, a separate Windows Local gate used a Browser Host with synthetic
1280x720 motion and an App-activated Viewer. The Viewer exclusively claimed
the v8 loopback control session and real Chrome decoded 621 frames at 1280x720.
This proves the Browser-to-Native receive/local-bridge path rather than a silent
Browser fallback. A Pion integration gate separately forwards the same H.264
and Opus payload from one inbound receiver source to a bounded downstream edge,
while dropping upstream connection-local extensions so each outbound Pion
interceptor writes its own negotiated TWCC header.

The one-link form carried the current signaling protocol through its temporary
public WSS origin to an independent Linux Pion Viewer. Repeated runs delivered
30+ packets over selected direct paths using a reflexive candidate; the Quick
Tunnel carried no media.

An isolated LiveKit 1.13.6 gate carried the same native source through one
reserved local Pion edge into the existing Browser `SfuPublisher`; an ordinary
LiveKit Viewer received the default 1080p source, then 15 consecutive 854x480
frames after one live Native/SFU profile change. The direct native P2P path,
Browser, App, LiveKit process, ports, and profiles all cleaned up.

The opt-in `gate:app-media` run proved, in order:

- WGC capture and adapter-bound Media Foundation H.264 became active;
- 30+ encoded 1280x720 frames crossed the bounded process protocol;
- a PLI caused a later recovery unit;
- the packaged App exposed only separately probed video, process-audio,
  system-audio, and hardware-H.264 capability booleans before control connected;
- two Pion ICE/DTLS/SRTP edges each delivered 30+ decoded 1280x720 frames
  to Chrome from that one encoded source;
- the self-hosted STUN endpoint produced ordinary `host` and `srflx`
  candidates;
- process-loopback audio produced non-zero PCM, Opus RTP, and non-zero decoded
  audio energy on both native edges; the same checks pass for a display using
  system loopback;
- closing the captured source ended its share, released the old media path, and
  a second capture generation in the same room delivered a different media
  object plus 30 new frames to the existing Viewer;
- App, capture, Browser, ports, and the isolated profile all closed.

Unit coverage separately enforces the supplied edge capacity, forwards PLI/FIR
to the shared video source, validates the same PeerConnection's Opus section,
and bounds the pure-Go Opus encoder's steady-state allocations. The native Host
session starts the target-appropriate loopback audio only when the capture probe
advertises it; an audio start failure leaves the video session alive. The
cross-NAT result proves reachability and RTP delivery, not heterogeneous
congestion behavior or a paired no-Site Browser media session.

The audio adapter uses `github.com/thesyncim/gopus` behind the private
`nativeaudio` boundary. It accepts fixed 48 kHz stereo PCM16/20 ms frames,
encodes into a caller-owned Opus buffer, and can be replaced without changing
the media edge or control wire. The dependency is BSD-3-Clause licensed and
requires Go 1.25; App CI uses Go 1.26.6.

## Current Boundary

Windows supports hardware H264 and software VP8 behind the same capture,
source and Pion transport boundary. The pinned WebRTC encoder pipeline supplies
libvpx; VP8 reads NV12 through a reusable staging texture and converts to I420.
Separate real Browser gates proved manual VP8 and Auto-selected H264, including
live presets, pause/resume,
source replacement and exact RTP codec preservation. Auto uses a bounded
synthetic target-profile cadence check, not a score or a runtime codec switch.
GPU-heavy selection and cross-device startup remain open acceptance work.

A 2026-09-28 check on Ryzen 7 9700X / RTX 4070 SUPER / Windows 11 26200
used the animated Browser gate source at a 1080p, 8 Mbps ceiling. With asynchronous
MFT readiness and no `timeBeginPeriod(1)` request, Auto selected NVIDIA H264 at
30 and 60 fps, reaching active in 1.851 and 1.855 s respectively. Full Browser
gates passed Auto, manual H264 and VP8 with source/profile replacement and
retirement. The helper-cost measurement below uses asynchronous CPU sampling:
blocking the probe's encoded-output reader while querying process statistics
distorts sustained cadence and must not be used for performance comparison.

Native Auto now observes the live pipeline's output, including the frame dropper
implicated by the [Browser AMD evidence](./realtime-quality-adaptation.md#h264-root-cause-and-gate).
Cold-start work is excluded from steady cadence, while the selection deadline
reaches MFT input/output waits. Synchronous driver activation/configuration and
shutdown cannot be preempted by that deadline. Slow-output rejection has fixture
coverage; native AMD/Intel physical acceptance and game-load behavior remain
open. This evidence does not establish the cause of reported system-wide lag.

The `input-texture-create / 0x887a0005` report identifies a lost D3D device during
candidate preparation, not a failed room route or proof that every candidate
failed. Following Microsoft's [device-loss guidance](https://learn.microsoft.com/en-us/windows/uwp/gaming/handling-device-lost-scenarios),
capture preserves the original stage/HRESULT and queries `GetDeviceRemovedReason`
before releasing that candidate's device. Each later candidate and Auto's VP8
fallback owns a fresh device; a live encoder does not silently change codec.
A 2026-10-03 local check exercised all five enumerated adapter entries, including
15 successful NVIDIA activation/encode/shutdown cycles on reused devices.
AMD activation returned `0x8007000e` with a healthy D3D device. A standalone
`MFTEnum2 -> ActivateObject` probe reproduced that failure for both AMD entries
without Piik, a D3D device or codec configuration, while NVIDIA entries activated.
This isolates the local activation failure to the platform/MFT path; it does not
identify the reporter's AMD failure. Production Auto and manual H264 both moved
from that preferred AMD candidate to working NVIDIA
H264 (about 1.95 s and 0.32 s). This did not
reproduce the reporter's device removal. No driver reset was forced, and the
optional D3D debug layer was unavailable. The reporter's removal reason,
subsequent candidates and final outcome remain necessary to assign its cause.

A deeper check on the same machine passed 600 synthetic NV12 allocations
across those adapter entries and all five resolutions. Forty activation/retirement
cycles included cancellation and shutdown with an input still in flight; the
device remained healthy. Five selections, including AMD rejection, also
succeeded while another process continued H264 encoding.
The reported stage creates probe textures before actual WGC capture; Auto's
cadence textures are prepared before MFT activation. These results narrow the
tested mechanisms but do not cover the failing device, driver reset or exhaustion.

Repeated NVIDIA MFT activation retained about two process handles per cycle.
A standalone 40-cycle program reproduced this without Piik or a D3D device:
`MFTEnum2 -> ActivateObject -> ShutdownObject -> Release`, with both COM reference
counts reaching zero. Fresh activation objects, direct `MFShutdownObject`, and
waiting five seconds after `MFShutdown` did not remove the incremental growth.
This isolates a local platform/MFT resource behavior, not a proven cause of
device loss. Retain capture-process ownership of driver resources; do not add
unowned `Release` calls or infer a GPU-recovery policy from this observation.

The same investigation found a separate MFT input-contract defect: a populated
720p NV12 surface reported a maximum length of 1,382,400 bytes but current/sample
length zero. The shared surface wrapper now sets the valid length from the
platform's capacity; the hardware fixture uses that same wrapper. This follows
Microsoft's [media-buffer contract](https://learn.microsoft.com/en-us/windows/win32/medfound/working-with-media-buffers)
and [Chromium's MFT input handling](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc),
which explicitly accommodates encoders that honor this length. The regression
failed before the fix and passes with a WARP surface, without an installed
hardware encoder. This removes reliance on vendor tolerance; the reported
texture-creation error precedes this wrapper, so it is not that error's cause.

Native Host media is exposed only through an explicit App-launched Host
selection; an ordinary Web Host retains Browser capture.

Native Host publication now sends its encoded source directly to the embedded
SFU. The local Browser bridge supplies preview and Browser quality candidates;
it does not supply the ordinary Native SFU publication. Received tracks still
cannot own capture constraints. [Media quality](../standards/media-quality.md#framework-owned-adaptation)
owns the current output and adaptation contract.

A shared encode cannot independently adapt one bitstream for unequal paths.
Rather than lower every Native child, a quality operation originating from a
    persistently degraded Native sender edge may prepare one Browser WebRTC sender
from the stable local bridge. The existing overlapping candidate comparison
alone commits or rolls it back, and a later quality operation can return that
edge to Native. Healthy Native edges keep sharing the hardware encode. This is
implemented without a new route reason, timer, score, or representation ladder;
controlled weak-path physical acceptance remains open.

Native edges now use the shared Pion/LiveKit forwarding adapter for transport
feedback, allocation, pacing and recovery. The former no-op-pacer and
source-payload-versus-GCC comparison are no longer the product implementation.
[Observable truth](../standards/media-quality.md#observable-truth) owns current
quality evidence, including committed allocation deficiency and unknown feedback.

No-Site Internet control can use the one-link mode owned by ADR-0010. Its remote
Pion gate proves public signaling plus direct media, but not decoded Browser
media on a physical second device. Cloudflare carries HTTPS/WebSocket control
and provides public STUN, while DTLS-SRTP media remains direct. STUN alone
cannot replace SFU/TURN on a restricted pair.

Native physical connections own independent Pion UDP sockets. Site and one-link
P2P connections make a bounded, best-effort PCP, UPnP, or NAT-PMP mapping through
NetBird's standalone Go NAT package; pure LAN Local mode does not. A physical
router created and removed an ephemeral UPnP mapping; the Apache-2.0 dependency
added about 0.38 MiB to the stripped Windows App. Mapping and the supplemental
STUN survey now run alongside ordinary candidate gathering; neither delays the
offer or ordinary candidates. End-of-candidates waits for both owners. Mapping
refresh and retirement follow the connection; [NAT evidence](./nat-traversal.md)
records the current dependency and reachability limits.
The returned port is advertised once per observed public address as a
lower-priority candidate. Only the three explicit same-socket survey candidates
feed NAT prediction; the mapped candidate does not. This proves lifecycle and
signaling, not that the mapped candidate has yet rescued a pair that public STUN
alone could not connect.

The retained hardware fixture also changed one live NVIDIA MFT through
`3 Mbps -> 1.5 Mbps -> 3 Mbps` without recreating it. Equal 120-frame phases
produced about `1.00 MB -> 0.68 MB -> 0.97 MB`, while ordered 30 fps output and
the pinned profile remained intact. Both AMD MFT candidates failed activation
before this probe, so the evidence is not a cross-vendor dynamic-rate contract.
With the failing AMD candidate preferred, bounded product selection now reaches
the working NVIDIA H264 encoder without changing codec. A local native Host gate
also passes decoded Viewer output, quality changes and source replacement. This
establishes the selection defect and repair, not the unknown reporter's cause.
This earlier fixture proves dynamic hardware rate changes, not the current
multi-output allocation policy or cross-vendor performance.

The Windows source boundary now enumerates displays and windows and returns a
bounded best-effort preview. A display uses WGC plus default render-device
loopback audio; a window uses WGC plus process-tree loopback when that actual
capability probe succeeds. Preview failure is advisory and cannot tear down
the control session.

A controlled 144 fps window on Windows build 26200 exposed two capture-cadence
failures: WGC's zero `MinUpdateInterval` delivered 48 fps, and sampling from the
last emitted timestamp reduced 48 fps input to 24 fps for a 30 fps profile.
Using WGC's supported non-zero interval plus a phase-continuous output cadence
delivered 29.99 fps and 60.00 fps from the same source. Older Windows versions
without the optional session interface retain their existing WGC behavior.

A Browser-capture/Pion fanout gate exposed a separate RTP input defect:
payload-empty padding was rejected and ended the video or audio reader. Chrome
then fell to a 30 kbps video target even at zero media loss and about 1 ms RTT.
Discarding padding kept the reader alive but introduced downstream sequence
gaps, NACKs and reduced decoded cadence. Forwarding valid padding through Pion's
existing `WriteRTP`, while excluding it from media-frame counts, restored two
1080p Viewers to about 30 fps with zero packet loss. The same gate passed live
quality, pause/resume, audio-presence source changes and App-exit fallback.
Native payload-capacity evidence does not require decoded dimensions; encoded
receivers can supply real transport evidence without opening a decoder.

DevTools accepted weak-network emulation commands in this loopback run, but RTP
traffic exceeded the requested limit without the requested loss. That run does
not establish weak-network quality or automatic fallback performance.

Non-Windows capture keeps the existing process/frame boundary and replaces only
the platform sidecar. The macOS adapter enumerates `SCShareableContent`, fences
the selected process/window generation, receives change-driven
`CMSampleBuffer`s, and requires VideoToolbox constrained-baseline hardware H.264.
It retains one latest pixel buffer so an existing PLI/FIR can encode a fresh IDR
even while the screen is unchanged; capture timestamps drive the shared Pion RTP
clock. A GitHub `macos-15` arm64 runner compiled the sidecar, created the same
hardware-only encoder, and encoded an in-memory 420v frame into a validated
`42c01f` SPS/PPS/IDR. The current adapter also emits ScreenCaptureKit application
or display audio through the common PCM boundary. ScreenCaptureKit permissions,
real video/audio capture, static-frame recovery, and endurance still require a
physical Mac.

The Linux adapter lets the XDG ScreenCast Portal own source selection, consumes
its restricted PipeWire stream through one bounded GStreamer pipeline, and
requires an installed element classified as a hardware H.264 encoder. It emits
the same Annex-B protocol and can use the PulseAudio-compatible default monitor
for system audio; it does not claim per-process audio. GitHub Linux CI compiles,
probes, packages, starts, and stops the candidate. A real Portal desktop,
hardware encoder, audio source, Browser decode, and recovery still require a
physical Linux gate. GStreamer stays a system dependency: bundling another RTC
or an 80+ MB media runtime would defeat the thin-adapter boundary, while an
unavailable dependency cleanly leaves Browser capture available.

## Windows Helper Cost (2026-09-29)

At `89a03e64` on Ryzen 7 9700X / RTX 4070 SUPER / Windows 11 26200,
an instrumented Release helper captured a controlled animated Browser window
and an offline CS2 scene window. Each run used one 1920x1080 output with an
8 Mbps ceiling; CPU sampling did not block the encoded-output reader. CPU below
is a percentage of **one logical core**, not total-machine use. The scene runs
are sequential observations, not matched gameplay or a cross-device benchmark.

| Source / codec | Target fps | WGC interval | Sample | Admitted / encoded fps | Helper CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| Browser / H264 | 30 | 4 ms | 15.8 s | 30.0 / 30.1 | 4.6% |
| Browser / H264 | 60 | 4 ms | 15.8 s | 60.1 / 60.0 | 9.6% |
| Browser / VP8 | 60 | 4 ms | 15.7 s | 60.0 / 60.0 | 75.6% |
| CS2 / H264 | 60 | 4 ms | 45.8 s | 54.8 / 52.7 | 5.7% |
| CS2 / H264 | 60 | 8 ms | 45.8 s | 53.0 / 51.4 | 5.3% |
| CS2 / VP8 | 60 | 4 ms | 20.9 s | 54.9 / 53.3 | 82.9% |

Across these runs, NV12 conversion API work averaged 0.060–0.226 ms per frame,
including texture/view creation; owned-input allocation/copy submission averaged
0.044–0.048 ms. These are CPU-side call durations, not GPU completion timings.
They do not justify adding a texture pool. In particular, MFT input samples may
remain referenced after submission; one mutable reused surface would discard
the current ownership guarantee. The 8 ms trial establishes no worthwhile gain
and does not supersede the earlier 144 Hz cadence evidence or the existing 4 ms
setting, also used by Sunshine.

At 60 fps, explicitly requesting recovery every 250 ms retained 59.9 encoded
fps on the Browser source and 56.9 on the CS2 source, with normal capture exits.
A separate unchanged window stayed active for over 20 seconds in each codec;
recovery requests produced fresh H264 keyframes from its retained image. These
are one-output stress/idle checks, not proof of multi-output recovery cost or
endurance. Code tracing also confirms membership/demand changes use recovery to
wake a quiet source and apply its next output plan; SFU demand emits only on
change. Removing these requests solely as redundant keyframes is unsafe.

H264 frame-rate bitrate compensation matches Chromium's MFT approach: compensate
for the fixed configured frame rate without restarting the encoder. An adjusted
API value above the requested bitrate is not by itself wire-rate overshoot.
The measured aggregate H264 payload stayed below 8 Mbps, including recovery
stress; this does not establish every short-window burst or driver behavior.

No automatic capture termination was reproduced. Admitted capture input stayed
below 60 fps during the CS2 runs; these observations do not separate game render
cadence, WGC delivery and capture sampling. They also do not measure game FPS
impact, exclusive fullscreen/display changes, saturated GPU behavior, end-to-end
decoded media or other GPUs. Software encoding costs more CPU here, but neither
that result nor the allocation timings establish the reported system-wide lag's
cause. Retain the existing implementation; reopen optimization from a matched
bottleneck.

### Virtual-Display Acceptance Limit

On 2026-10-07, the local Native H.264 SFU gate initially passed its two-room
check, then missed its unchanged 300-frame/30-second requirement. The repeat
environment exposed only a GameViewer virtual display. Current main reproduced
the failure with its own App and capture binary: video/audio arrived, but video
was roughly 4–7 fps without receiver loss or decode drops. A source-window draw
counter advanced about 133 times per second; that counts drawing attempts, not
Windows capture delivery.

Temporary capture instrumentation observed about 3–4 WGC frame-arrival events
per second. Queue draining was bounded in the observation, conversion/submission
took less than a millisecond, and encoder diagnostics showed small encode times
without CPU/quality adaptation. Bringing the source window forward did not
restore cadence. A capture-only control, without the App or SFU, also delivered
about 3.9 fps from both Chrome and a separate animated Windows Forms window.
A separate minimal WGC program, using only Windows APIs and no Piik code,
reproduced about 3.8 fps while that Forms window painted about 32 fps.
Default, 4 ms and 1 ms capture intervals returned the same rate, including with
the source kept topmost; property readback confirmed each requested interval.
This localizes the limit to platform capture delivery in this environment but
does not establish the virtual driver's cause or diagnose a field report.
No capture scheduling, encoder policy or gate threshold was changed.

Later on the same day, Windows reported an active physical AOC display. The
unchanged Windows-API-only probe delivered about 32 fps, matching its GDI source,
at the default, 4 ms and 1 ms intervals. The candidate's Native H.264 two-room
SFU gate then passed the original 300-frame/30-second requirement, live profile
change, decoded audio, subscription recovery and retirement. Stopping the first
room preserved another 30 decoded frames and continuing audio in the second;
all owned processes, profiles and ports were released. This closes that local
throughput acceptance gap. It does not isolate the virtual driver's cause or
establish physical HDR, game-load or other-device performance.

## Native H.264 Motion Quality

Issue [#432](https://github.com/TNTcraftHIM/Piik/issues/432) reports more visible
blocking with native H.264 than VP8 on v1.6.7. Review of its attached Browser
report confirms 720p30 in both comparison windows, roughly 11 Mbps received,
and no reported packet loss; the 1080p60 H.264 window receives roughly 10 Mbps.
Those samples establish delivered format and transport observations, not equal
source content or objective picture quality. No encoded stream, reference
frames or QP measurements accompany that report.

The reporter retracted the initial CBR bitrate-ceiling diagnosis after finding
that the experimental fixture changed bitrate during the measured interval.
That switching belongs to `PIIK_H264_FIXTURE` in `windows/main.cpp`, not live
capture. The corrected experiment reports CBR reaching its requested bitrate.
Production `h264_encoder.cpp` explicitly requests and validates Baseline; the
Browser's negotiated `profile-level-id` alone is not an inspection of emitted
SPS. The later experimental CABAC result cannot establish the production
Baseline bitstream's behavior. Microsoft's [encoder reference](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder)
distinguishes profile, rate control and optional quality/speed settings.

The original 720p comparison remains unresolved. An equal-content comparison
must preserve actual bitrate, frame rate, latency and production codec settings,
inspect the resulting bitstream and retain reference/decoded pictures. Raising
the bitrate ceiling, lowering the default frame rate or changing profile is not
justified by these logs alone; those changes have bandwidth, motion and receiver
compatibility consequences.

### Profile And Parameter Comparison

Measured 2026-10-03 on Windows 11 26200, RTX 4070 SUPER, driver 32.0.16.1088,
using the production Media Foundation owner with profile-only research changes.
Each comparison reused identical FFmpeg `testsrc2` NV12 frames, unchanged CBR,
low-latency mode, two-second GOP and quality/speed 50. Runs covered six seconds
at 720p30 and four seconds at 1080p60. FFmpeg decoded the retained Annex-B output;
PSNR/SSIM comparisons aligned frames by index and checked all output frame types.
These are synthetic codec comparisons, not a reproduction of the reported game.

| Source / requested bitrate | Baseline: actual Mbps / PSNR dB | Main: actual Mbps / PSNR dB | High: actual Mbps / PSNR dB |
| --- | --- | --- | --- |
| 720p30 / 3 Mbps | 3.078 / 43.17 | 3.030 / 44.02 | 3.056 / 44.05 |
| 720p30 / 11 Mbps | 10.603 / 60.66 | 10.219 / 61.81 | 10.220 / 61.74 |
| 1080p60 / 10 Mbps | 10.104 / 42.53 | 10.046 / 43.28 | 10.167 / 43.20 |

All streams retained order and had zero B frames. Main/High PPS enabled CABAC;
explicitly requesting CABAC produced byte-identical output to the corresponding
profile's default. Baseline PPS correctly disabled CABAC even though the NVIDIA
property readback returned true: property readback alone is not bitstream proof.
Median encode time was about 2–3 ms in these paced runs. Quality/speed 100 did not
consistently improve PSNR, so it does not justify replacing the current preference
mapping. A one-frame CBR buffer reduced 720p30 actual output to 2.319 Mbps and
41.08 dB; four frames produced 3.003 Mbps and 43.08 dB. Neither improved on the
default. The experiment does not establish end-to-end latency.

The [Marpe/Wiegand/Sullivan paper](https://doi.org/10.1109/MCOM.2006.1678121)
establishes benefits of CABAC and High-profile tools, but its reference-encoder
comparison used B pictures and several references, not this low-latency MFT.
[NVIDIA's low-latency guidance](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html#low-latency-encoding)
supports CBR but requires evaluating buffer/quality tradeoffs; its native SDK
presets cannot be assumed to map directly to vendor Media Foundation properties.

### WebRTC Profile Compatibility

Checked 2026-10-03. File decoding support, WebRTC negotiation and Piik's forwarded
bitstream contract are separate capabilities. A higher profile must satisfy all
three, including downstream relays; hardware support alone is insufficient.

| Platform | Evidence and boundary |
| --- | --- |
| Windows Chrome / Edge 154 | Local sender/receiver capabilities advertise Main and High as well as Baseline. This does not establish other devices' hardware support. |
| Firefox 155 on Windows | An isolated profile with checksum-verified official OpenH264 2.6.0 advertised only Baseline variants. Real Chrome-to-Firefox negotiation decoded 65 Constrained Baseline frames in a 2.2-second observation; Main-only and High-only offers were rejected (`m=video 0`), before media transport. |
| Safari / iOS / macOS | Current [WebKit codec factories](https://github.com/WebKit/WebKit/blob/main/Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk/objc/components/video_codec/RTCDefaultVideoDecoderFactory.m) list Constrained High and Constrained Baseline. Constrained High (`640c`) is a distinct negotiated subset from ordinary High (`6400`). Source review does not replace physical Safari acceptance. |
| Android Chrome and other Chromium platforms | The [WebRTC decoder factory](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/peerconnection/rtc_video_decoder_factory.cc) consults platform decoder capabilities. Android additionally [checks profile, level and dimensions](https://github.com/chromium/chromium/blob/main/media/gpu/android/media_codec_video_decoder.cc). No universal device guarantee or phone acceptance is established here. |
| Piik App on Windows / macOS / Linux | Capture and encoded fanout retain Constrained Baseline. Changing only an encoder setting would leave admission and downstream declarations inconsistent. |

The earlier Firefox probe without GMP was inconclusive; the installed-plugin
check above supersedes it. [Firefox's current JSEP defaults](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/webrtc/jsep/JsepCodecDescription.h)
agree with the measured negotiation. Do not infer decoder limits from OpenH264's
short README: its [release history](https://github.com/cisco/openh264/blob/master/RELEASES)
records Main/High decoding, which does not change Firefox's advertised profiles.
The historical [Mozilla interoperability report](https://bugzilla.mozilla.org/show_bug.cgi?id=1411681)
also distinguishes a decodable bitstream from a profile incorrectly labeled as
Baseline; it is context, not proof of a current regression.

[RFC 7742](https://www.rfc-editor.org/rfc/rfc7742.html#section-6.2) requires
Constrained Baseline and recommends Constrained High. Native Main/High adoption
is declined: the measured synthetic gain does not justify coordinating profile
fallback across the shared encoded source. Retain the current Constrained
Baseline, CBR and GOP, without a profile selector or additional transcodes.
Browser-owned encoders keep ordinary negotiation among their supported profiles;
the Main-only/High-only rejection above does not rule out a preference list with
Baseline alternatives. The original field quality cause remains unproven.

One independent compatibility defect was confirmed: capture admission compared
against `42c0` literally, rejecting equivalent Constrained Baseline SPS such as
`42e0`. The three Native adapters and shared Go capture-state reader now follow
[RFC 6184 Table 5](https://www.rfc-editor.org/rfc/rfc6184.html#section-8.1), retaining
the shared level bounds and rejecting actual Main/High. Linux's former output
gate also omitted Level 5.2 and lower automatic levels; it now follows the same
admission as its requested profiles. Windows active status
reads the emitted SPS instead of synthesizing a vendor-specific value. This is
not a profile upgrade or an explanation for `DXGI_ERROR_DEVICE_REMOVED`.

The same review reproduced a separate Native receive/fanout defect. Pion 4.2.19
can fall back to MIME-only matching when profile bytes differ. A Safari-order
offer (`640c1f`, then `42e01f`) selected High, while the unchanged downstream source
still declared Constrained Baseline; `42e01f` plus VP8 selected VP8 unexpectedly.
Native SDP now uses the common `42e0` spelling, and the receive owner validates
the supported coding subset, level and packetization before accepting or reusing
a source. Capture and receive admission share the RFC profile predicate. This
repairs the encoded-source contract without changing routing or adding encoding
paths; it is not evidence for the reported D3D device loss.

Firefox-generated SDP also reproduced audio omission for a valid `bundle-only`
section with port zero. The receiver had treated every zero port as rejection;
it now follows [RFC 9143](https://www.rfc-editor.org/rfc/rfc9143.html#section-6),
retaining the existing inactive/receive-only checks. Piik's current balanced
Browser offer did not trigger this variant; the max-bundle control did. This is
a corrected SDP interpretation, not evidence that all Firefox sharing lost audio.

## Media Capability Extension Assessment

Planning direction reviewed 2026-10-09 for 2.0; the design below is a proposal,
not a replacement for the current contract or profile decision above. The owner
reopened numeric media requests and capability negotiation as one coherent
extension. The published resolution enums are enforced
by both signaling readers and Native control, while capture admission separately
bounds dimensions. Native capture, forwarding and SFU declarations also admit
specific encoded formats. Removing one validator would leave these consumers
inconsistent.

Source review also distinguishes output geometry from a quality limit. The
published Windows path fits content into the selected landscape raster with a
black background, so its padding is encoded. Browser display capture instead requests
landscape width/height ceilings; a portrait source can be reduced unnecessarily
by the height ceiling. The shared TV uses `object-fit: contain` in a 16:9 stage,
adding presentation space independently of encoded padding. For example, the
published Windows fit rule places 1080x1920 content at 608x1080 inside a 1920x1080 output.
This is a code-derived result, not a new physical capture measurement. Evaluate
orientation-independent limits and preservation of source aspect ratio together;
adding numeric fields alone would retain the current geometry limitation.

The candidate changes the existing Windows output worker: it passes the
source's fitted even dimensions to WebRTC, retaining the selected profile as a
ceiling. A 640x480 source stays 640x480; portrait and ultrawide sources no longer
require an encoded landscape canvas. The converter, adaptation owner, output
generation and frame envelope are reused. Axis-specific limits still apply;
portrait capture can use explicit width/height ceilings but does not transpose
the selected ceiling automatically. Browser evidence follows below.

Linux uses the existing [GStreamer scaler](https://gstreamer.freedesktop.org/documentation/videoconvertscale/videoscale.html)
with bounded even-dimension ranges instead of fixed output dimensions. Square
pixel negotiation retains presentation aspect without a padded canvas; encoded
samples provide the actual dimensions for the frame envelope. The headless
control changes portrait, ultrawide, small, odd-sized and square inputs within
one pipeline, checks the output ceiling and image corners, and exercises the
smallest derived output. Compilation and those regressions passed on Linux;
Portal capture and hardware encoder resizing still need a physical device.

The macOS candidate now interprets ScreenCaptureKit's per-frame content rectangle,
pixel scale and content scale, following Apple's
[frame-metadata guidance](https://developer.apple.com/videos/play/wwdc2022/10155/).
It retains the bounded capture surface, describes its content through CoreVideo's
clean aperture and uses VideoToolbox's
[source-aperture scaling](https://developer.apple.com/documentation/videotoolbox/kvtscalingmode_cropsourcetocleanaperture).
Each existing output worker fits the unscaled source within its ceiling and
replaces only its compression session when the fitted size changes. The frame
envelope carries actual dimensions; declared output limits and room/route
identity remain unchanged. Encoded-input derivation uses the same worker.

The candidate passes macOS SDK compilation and packaged startup on Apple silicon
and Intel in [CI run 38128668158](https://github.com/TNTcraftHIM/Piik/actions/runs/38128668158).
The native check includes content-geometry validation and successive-shape
hardware self-tests when an encoder is available. Runner checks do not replace
real window resizing, Retina transitions, cropped image fidelity or quiet-source
recovery on a physical Mac.

Local synthetic-input controls exercised that production worker through four
successive source sizes: 1080x1920, 3440x1440, 640x480 and 1920x1080. Under the
1080p ceiling, H.264 and VP8 each produced 40 frames at 606x1080, 1920x802,
640x480 and 1920x1080; Chrome decoded every frame at the declared dimensions.
Separately, a codec-only control bypassed product profile admission and encoded
1080x1920, 3440x1440 and 3840x2160 at 30 fps with the current Windows H.264
encoder. Chrome decoded all 30 frames per size; observed levels were 4.0, 5.0
and 5.1. This establishes local codec feasibility, not product 4K support,
4K60, sustained performance or cross-device acceptance.

The real Windows H.264 source also passed the existing App UI and two-Viewer
gates: live/paused settings, background/window recovery, source replacement and
retirement retained their expected owners. Native SFU passed 300 decoded frames
at its original source aspect, reduction from 658x720 to 438x480, numeric audio
changes, Viewer reload/recovery and cleanup. Gate expectations now derive from
the observed source and selected ceilings, instead of requiring encoded 16:9
padding. Physical game, macOS/Linux and orientation-change acceptance remain open.

The candidate's Native capture admission now shares the numeric dimension
bounds already used by encoded outputs instead of duplicating the four UI
presets. A source ceiling must also yield a valid half-size output. Bitrate and
output-count bounds remain unchanged. Candidate signaling and Native control now carry numeric
width/height ceilings, with custom input beside the existing UI shortcuts.
Descriptive wire bounds are independent of the current implementation maximum;
App discovery advertises size, pixel-count, macroblock-rate, frame-rate and bitrate limits, and Native rejects unsupported
size/rate combinations as operation failures without retiring the control
session. Removing an enum is not permission to allocate arbitrary media resources.

The Windows H.264 UI gate switches from 1080p60 to the 4K ceiling, then applies
a non-preset 960x600 ceiling during the live share. Its earlier 30 fps run
observed fitted output without replacing the Viewer media object. The gate now
expects the 60 fps control and needs rerunning. The captured window is smaller
than 4K, so this verifies settings/lifecycle, not physical 4K capture.
Preset changes, paused updates, source recovery/replacement and subsequent
sharing still pass. Value-based comparison prevents an identical deserialized
size from turning an audio-only edit into a video update. Numeric preference
round-trips and malformed/unsupported requests have separate boundary checks.

Native bounds admit 3840x2160 and 2160x3840 at 60 fps. The per-axis limit and
pixel total remain independent; an arbitrary 3840-square picture is rejected.
The output throughput ceiling uses H.264 Level 5.2's macroblock rate, including
alignment for non-preset sizes. Coded padding and decoded reference buffers have
their own pre-allocation bounds, following [H.264 Table A-1](https://www.itu.int/rec/T-REC-H.264)
(also implemented in [FFmpeg's level table](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_levels.c)).
Level 5.2 raises throughput without raising Level 5.1's coded-frame or
reference-picture storage bounds.

A 2026-10-11 control corrected the earlier 4K30 conclusion: explicitly forcing
Level 5.2 failed this hardware encoder's output-type setup, but leaving the
level unset encoded the same 4K60 inputs as Constrained Baseline Level 5.2.
[Microsoft recommends automatic level selection](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder).
The production configuration follows that advice and validates actual SPS tools
and level through 5.2, retaining stable SPS identity and recovery-unit checks.
Local Media Foundation hardware/software decode delivered all 60 frames in both
4K orientations, with a passing 1080p60 control. Chrome also decoded all 60
production-encoder frames per orientation; production H.264 and VP8 workers
passed a 4K-to-1080p-to-4K source sequence at the 60 fps setting. The normal
Go/native encoded-input path also derived lower outputs from these inputs.
This disproves a blanket 4K30
restriction; the combined encode/decode fixture does not establish sustained
60 fps on every device. Microsoft's older decoder documentation lists
[Level 5.1](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-decoder),
so local success is not a cross-device guarantee.

A separate Chrome 152 canvas/PeerConnection control decoded 3840x2160 near
60 fps with both H.264 and VP8. Its H.264 SDP advertised Level 3.1, consistent
with [WebRTC's built-in capability list](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/codecs/h264/h264.cc).
That static label alone does not establish a device's observed limit. Piik does
not add an independent quality ladder or infer universal decoder support from
codec matching; limited receivers and real routes still need acceptance.

Decoder format checks must distinguish storage from visible content. On
2026-10-11, the Windows decoder rejected a valid 3840x2160 picture stored in a
3840x2176 surface because its output check applied the visible-pixel bound to
codec padding. Media Foundation's [display aperture](https://learn.microsoft.com/en-us/windows/win32/medfound/picture-aspect-ratio)
and CoreMedia's [clean aperture](https://developer.apple.com/documentation/coremedia/cmvideoformatdescriptiongetcleanaperture(_:originisattopleft:))
own visible dimensions; both adapters now validate these separately from bounded
coded storage. Windows copies the aperture while retaining the decoder surface,
so downstream outputs receive the visible picture. The native regression checks
right/bottom H.264 padding with real software decoding, visible edge pixels, and
an offset NV12 aperture through the DXGI-buffer path. Oversized coded/reference
storage remains rejected; the physical macOS boundary above still applies.

An additional nonzero left/top SPS crop exposed a local Media Foundation software
decoder limit: its raw output omitted right/bottom picture pixels before Piik's
surface copy. FFmpeg decoded the same generated frame correctly. Removing the
input-size hint or changing output-aperture attributes did not restore them.
The passing ordinary alignment-padding controls do not establish arbitrary SPS
crop support on that decoder; no bitstream rewrite or replacement decoder is
introduced for this unreported platform edge case.

Current production Windows code encoded and decoded 30 synthetic frames in each
4K orientation, both with and without a D3D decoder manager. Retaining/uploading
the decoded surface also passed. The normal Go/native encoded-input path then
produced 1920x1080 and 1080x1920 derived outputs. Production H.264 and VP8 output
workers also handled a 4K-to-1080p-to-4K synthetic source sequence, and Native
VP8 derivation produced the lower output from the 4K input. The Browser H.264 SFU gate with
a synthetic 3840x2160/30 source passed first-picture delivery, an explicit lower
profile, audio-only edits with retained connections, subscription/page recovery
and retirement. Windows native checks and Linux headless build/checks pass;
macOS SDK and physical 4K capture are not verified here. Controls now use the
combined limits, reject oversized pixel totals and cap frame rate on size changes.

Chrome 154 real portrait/landscape tab capture retained the source aspect through
the pooled output. The landscape check also passed live/quiet/paused profile
changes, source replacement and ordinary recovery after producer failure.
A synthetic 2160x3840 Browser relay delivered fresh pictures to two children,
including a late connection. Separate 3840x2160 and 2160x3840 Browser-to-Native
fanout checks delivered about 30 fps to both Viewers and passed live reduction,
pause/resume, source-audio changes and App-exit recovery. Reproduce with
`PIIK_CLIENT_BROWSER_FANOUT_GATE=true`, `PIIK_CLIENT_GATE_VIDEO_SIZE=WIDTHxHEIGHT`
and `CHROME_PATH` set, then run `npm run gate:app-browser-fanout`.
These local checks do not establish 4K60, physical 4K/game
capture, sustained device performance, all Browser decoders or all route changes.

The existing SFU gate accepts `PIIK_EMBEDDED_SFU_VIDEO_SIZE=WIDTHxHEIGHT` for a
bounded 60 fps / 50 Mbps source; its default 720p15 control remains unchanged. Run
`npm run gate:embedded-sfu` with `PIIK_EMBEDDED_SFU_GATE=true`,
`PIIK_EMBEDDED_SFU_CODEC=h264` and `CHROME_PATH`; add
`PIIK_EMBEDDED_SFU_DISPLAY=true` for actual tab capture. Synthetic 2160x3840 and
real 3440x1440 tab sources passed decoded-picture delivery, aspect-preserving
reduction, numeric audio updates, subscription/page recovery and retirement.
The tab control also passed background capture, lower-layer demand, pause/resume
and source replacement. A separate full-UI 2160x3840 control passed SFU-to-P2P
commit and failed-P2P-to-SFU recovery through the room controller, keeping the
old SFU picture during peer preparation. The mixed Browser Host/Native Viewer
control also passed those transitions. With clarity priority, its live
2160x3840-to-360x640 edit retained the Native connection and playback track;
SFU recovery retained that size and then restored 2160x3840. Firefox 155 received
the same VP8 and H.264 sizes from Chrome 154, retaining its track through both
edits; H.264 also passed through embedded SFU. All controls retired their
receiving connections on stop. Balanced priority may deliver smaller adapted pictures.
These local checks do not establish physical
4K capture, every mixed handoff or cross-network performance.

The H.264 control supplies OpenH264 2.6.0 to an isolated Firefox profile, using
the artifact and SHA-512 from [Mozilla's codec manifest](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/content/gmp-sources/openh264.json).
This follows the [Web Platform Tests setup](https://github.com/web-platform-tests/wpt/blob/master/tools/wpt/browser.py).
A fresh-profile control did not advertise H.264 and could not receive the
H.264-only share, so codec availability must be established before attributing
that result to resolution or networking. Firefox owns its component installation;
the [upstream report](https://bugzilla.mozilla.org/show_bug.cgi?id=1766638) records
the separate first-use installation boundary.
With H.264 unavailable, the Browser accepts the offer but rejects its video
section in the answer. The shared receiving check uses this
[JSEP rejection](https://www.rfc-editor.org/rfc/rfc8829.html#section-5.3.1), rather
than inferring support from a codec list. P2P and SFU controls now retain that
cause through route exhaustion instead of reporting only a media-route failure;
the Native local bridge uses the same check and its existing failure path.
An answer rejection alone does not identify the decoder or platform cause.

Chrome 154 camera controls exposed a separate constraint bug: lowering a
540x960 input to the 1280x720 ceiling produced a cropped 540x720 picture when
both axes also carried `ideal` values. Maximum-only constraints produced
405x720, retained portrait shape through a subsequent 360x640 setting, and
restored 540x960. Camera startup and picker requests could likewise crop to their
ideal axes; they now share an uncropped device-format request (`resizeMode:
{ exact: "none" }`). Portrait thumbnails then measured 180x320 instead of 320x180.
A landscape control retained shape within rounding. Shared live constraints use
ceilings without a fixed aspect ratio or rotation listener, following the Media
Capture distinction below. Synthetic devices do not establish physical phone
orientation behavior.

The boundary follows the
[Media Capture specification](https://www.w3.org/TR/mediacapture-streams/#constrainable-interface):
requested constraints, supported capabilities and actual settings have different
owners. Capability ranges cannot describe every combination of resolution and
frame rate; [WebRTC codec discovery](https://www.w3.org/TR/webrtc/#rtcrtpsender-interface)
is optimistic and reserves no hardware resources. An advertised capability is
therefore not proof that a particular encoder configuration can start.

Wire representation follows the platform types for dimensions/bitrates and a
positive finite frame rate; current capture admission remains narrower. This
allows a reader to reject an unsupported operation without rejecting its room
or control session. Fractional rates must not be silently truncated by Native's
integer capture API. SFU metadata passes the same representation boundary and
then its existing bounded admission before allocation. Capability descriptions
may exceed local support, but cannot authorize larger local allocations.
This separation also appears in
[mediasoup RTP parameters and capabilities](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/).

The operating-range review found that the inherited 15 fps / 2 Mbps
source minimum and 12 Mbps maximum retained the earlier menu range; they were not
codec limits. [LiveKit's screen-share presets](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts)
include 720p5 at 800 kbps. [YouTube's H.264 live-ingest guidance](https://support.google.com/youtube/answer/2853702?hl=en)
recommends 50 Mbps for 4K60, but its ingest/re-encoding workload is not a Piik
WebRTC operating policy. These references motivate testing both ends of the
range, rather than inheriting the old controls or copying another service's cap.

The initial numeric candidate admitted 1..60 integer fps and 0.1..50 Mbps. Its
lower-output construction caps the usual 150 kbps floor by the source ceiling, in both Browser
SFU and Native. Browser and Native preflight require positive encoded progress;
the old one-frame tolerance could otherwise pass zero output at 1 fps.
An earlier raw H.264 encode/decode control established local feasibility beyond
the old range. Production Windows output-worker checks now cover H.264/VP8 at
720p1/100 kbps, 720p5/800 kbps and 4K60/50 Mbps, including source-size replacement.
Native encoded input also produced the expected half-size output at the low and
high bounds. Each derivation retained its existing input-format generation;
source changes still retire and replan that optional output through its owner.
Browser loopback with the real sender controls also delivered decoded progress
at all three settings and after replacing the 1 fps source. At 1 fps / 100 kbps,
the production Browser HostPeer also delivered to two local receivers through
ordinary senders and the shared encoding pool, for both H.264 and VP8. This
bounded check does not cover room routing or physical-network recovery. The 1 fps H.264
preflight passed; the 4K60 preflight selected VP8 on this machine even though
explicit H.264 delivered frames. Admission is not a sustained-cadence guarantee.

The Windows Native Host gate now exercises the actual numeric UI at 1 fps /
100 kbps and 60 fps / 50 Mbps with both codecs. Fresh decoded frames retain the
same Viewer stream through those changes, 4K/custom ceilings, pause, source
replacement and Viewer recovery. Its generated window is smaller than 4K;
this establishes ceiling application and continuity, not physical 4K capture.
The Browser H.264 and VP8 SFU controls request 60 fps from actual 3840x2160
synthetic input, decode high and lower outputs, retain the connection across
both rate bounds and audio updates, and recover subscriptions after reload.
Native WGC-to-SFU controls also pass both codecs and rate changes with the same
connection; their source is smaller than 4K. Positive output does not establish
sustained 60 fps on arbitrary devices or networks.

A 3840x2160/60 Browser-to-Native fanout control failed the existing 30 fps
performance threshold: its source produced about 32..33 fps and the two Viewers
about 27 fps. A separate functional continuation retained that negative result
and passed live quality changes, pause/resume, source-audio replacement and
App-exit recovery. That run measured about 41 and 37 fps at the Viewers, still
below the requested 60 fps. The controls establish continuity on this machine,
not sustained 4K60 cadence; they do not justify custom quality floors or resets.

The current Linux candidate also passes C11 compilation with warnings as errors
and the headless GStreamer regressions, including low/high rate admission,
source geometry, retirement and distinct Portal node-ID/serial targeting.
This uses GStreamer 1.28.3 and libportal 0.9.1 on an isolated Alpine runner;
its probe correctly reports no capture without a desktop session. Actual
Portal capture and platform packaging remain separate checks.

A uniform-noise 4K1/50 Mbps stress input reached the retained 4 MiB access-unit
guard in both Native codecs; VP8 produced a 6,199,837-byte frame. The output was
rejected rather than expanding allocation limits. Large bitrate/low-cadence
requests are not permission for unbounded frames. These local controls establish
useful operation and bounded failure, not sustained field quality or complete-route
performance. Ignored controls and results are under
`build/candidate-review/four-k60/` (`range-worker.cpp`, `range-browser.js`,
`low-rate-pool.js`).

The 2026-10-13 extension uses the existing H.264 Level 5.2 budget instead of
the earlier menu maximum: see [FFmpeg's level table](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_levels.c).
The Windows production worker delivered H.264 and VP8 output for 1080p120/
80 Mbps, 1440p144/100 Mbps and 1080p240/240 Mbps, including small-source changes
and restoration. VP8 also delivered 5120x1440/60 at a 100 Mbps ceiling; this
machine's hardware H.264 candidates rejected that width. These short synthetic
checks establish useful output and retirement, not sustained cadence or bitrate.
Browser WebRTC loopback also retained the requested sender limits and continued
decoding all four sizes/rates with H.264 and VP8. These controls used synthetic
canvas input; they do not establish screen-capture cadence or cross-device support.
Setting both Windows decoder axis ceilings to 8192 made an existing 4K fixture
fail at `BEGIN_STREAMING` with `E_OUTOFMEMORY`. Retaining platform provisioning
defaults passed the same padding/visible-crop regression; SPS and output buffer
guards remain in their existing owners. Raw H.264 1080p120/80 Mbps also decoded
30/30 pictures. The higher-range changes still need other-platform SDK and
physical-device acceptance. Local controls are in ignored `build/quality-polish/`.

[WebRTC statistics](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatepairstats-availableoutgoingbitrate)
describe estimated available capacity, not a configured send-rate ceiling;
[Pion exposes it as a floating-point observation](https://github.com/pion/ice/blob/main/stats.go).
Local in-memory Native control checks reproduced a 100 Mbps observation ceiling
closing the entire connection. The corrected readers preserve high valid
estimates, normalize invalid optional measurements and discard invalid quality
samples without granting them control authority. Shared Go/TypeScript fixtures
also cover sender, publication and receiver evidence. This establishes boundary
behavior, not the cause of an unmatched field report or an improvement to ICE.

| Meaning | Piik owner and representation |
| --- | --- |
| Quick presets | UI-local labels mapping to numeric picture/audio requests; adding a label does not extend the wire |
| Host intent | One validated numeric size, frame-rate and bitrate request, distinct from measured output |
| Available capability | Existing capture/receive/forward adapters report supported operations and bounded formats; unknown descriptive formats are unavailable |
| Applied configuration | The existing share owner commits an admitted result under its current generation; failed or stale changes do not become saved preferences |
| Live output | Existing capture and receiver evidence; WebRTC/LiveKit still own network adaptation |

Dimensions, pixel counts/rates, encoded-frame bytes, allocations and concurrent
outputs remain bounded before resource use. Remote capability claims cannot raise
local limits. Reject malformed values and unauthorized commands; unsupported
well-formed requests need a scoped failure, not an unrelated room disconnect.
Use the existing generation and route operation, not a capability polling loop,
general constraint solver or second recovery owner. Numeric limits describe
ceilings, not a promise of a constant rate or resolution. A receiver's limits
constrain its edge or existing local output group, not every Viewer in the room.

Receiver-limit acceptance cannot rely on SDP matching alone. Chrome 154
advertised H.264 Level 3.1 while decoding the 4K controls above. In isolated
ordinary-sender checks, lowering the answer to Level 1.2, or adding VP8
`max-fs=1200;max-fr=15`, did not reduce the received picture size. This is not
evidence for a physical low-capability decoder. [RFC 6184's receive-level
rules](https://www.rfc-editor.org/rfc/rfc6184.html#section-8.2.2) and actual
framework behavior therefore need separate validation before promising
automatic compatibility with smaller future capability sets.

Codec support must distinguish encoding, decoding and encoded forwarding,
including profile/packetization and SFU admission. Reuse SDP codec matching;
describe only Native control and forwarding limits that it cannot express,
instead of negotiating the same format twice. AV1 and VP9 are candidates to
evaluate, not promised product formats. A late Viewer or relay that cannot
receive the current encoded source needs an explicit policy; SDP negotiation
alone cannot convert that source. Per-Viewer transcodes or room-wide codec
switches are not implied by this proposal. This is also explicit in
[mediasoup's producer/consumer capabilities](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/).
[LiveKit's backup codec policy](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts)
uses another encoding or switches the publication; that compatibility has real
CPU/bandwidth or continuity costs. Piik's embedded LiveKit components do not
automatically provide its complete SDK policy. Keep H.264/VP8 as the initial
compatibility path; admit a new format only with its whole-route evidence.

Current discovery couples format to implementation (`hardwareH264` and
`softwareVP8`), and Browser preference uses a VP8-specific fallback flag.
Capture, forwarding and SFU each correctly reject formats they cannot process,
but adding another format therefore needs coordinated changes beyond SDP.
Assess a small format-specific capability description at these existing owners
only when selecting a concrete additional codec; no codec plugin system is
proposed. Browser-to-App fanout is currently H.264-gated and falls back to ordinary
Browser senders, so that optimization is not evidence that VP8 sharing is broken.

Under [versioning](../standards/versioning.md#extending-interfaces), unknown
descriptive capabilities may be ignored, but unsupported commands are not sent
or executed. Numeric limits and advertised optional formats could make future
resolution/codec additions compatible minor releases. 4K itself does not
inherently require a major; breaking an existing public contract does. Evaluate
the Browser/App/Server and mixed-peer flows before freezing a replacement
contract; avoid a general compatibility framework.

### Audio And UI Proposal

[#462](https://github.com/TNTcraftHIM/Piik/pull/462) requests 256/320 kbps Opus.
The values are permitted by [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html#section-6.1),
whose receive-rate parameter spans 6,000..510,000 bit/s. This is a codec boundary,
not a recommended default or proof of audible benefit. The current preset names
also travel in authentication and Native commands: adding its two enum values
causes the actual v1.9.2 readers to terminate those sessions. The PR's compatible
release claim is therefore incorrect even though its audio use case is valid.

The 2.0 candidate uses one numeric audio-bitrate ceiling through capture, sender,
receiver and SFU; derive existing preset labels locally. Align receive admission
with codec support instead of the largest UI shortcut. Keep the existing default
while comparing actual Opus output and listening results for higher ceilings.
The [numeric audio controls](./browser-screen-audio-quality.md#numeric-bitrate-assessment)
establish local 256/320 kbps encoding and Browser reception, with separate
receive-limit enforcement and a 320 kbps implementation ceiling. Full-range
Opus wire validation remains independent of that current packet-size choice.
[LiveKit's AudioPreset](https://docs.livekit.io/reference/client-sdk-js/interfaces/AudioPreset.html)
likewise contains a numeric maximum bitrate; its
[high-fidelity example](https://docs.livekit.io/transport/media/advanced/#hi-fi-audio)
also considers stereo, source processing and redundancy. Raising bitrate alone
does not establish studio quality, losslessness or multi-channel output.

Keep Piik's compact presets and existing picture/sound settings disclosure.
Expose custom numeric values with units and valid ranges there, without adding
a permanent row for each new preset. Use supported-format selection for codecs,
not an arbitrary text field. Preserve source aspect ratio without upscaling;
distinguish selected limits from actual capture/decoded dimensions in existing
details. Capability-related restrictions explain a real limitation briefly.
The [OBS settings guide](https://obsproject.com/kb/obs-studio-overview#settings)
supports a simple/default entry with further controls; Piik need not reproduce
OBS's full output configuration. Existing visual/tooltip owners still apply,
including narrow screens, both themes and visual mode.

Start with numeric audio through the existing pipeline, then portrait/ultrawide
geometry and 4K as a second concrete use case. A 4K path must review all platform
capture/decoder bounds, encoded-frame limits and SFU admission. Admission and output must be tested
at the actual profile, not inferred from a codec list. Check live changes,
late/limited Viewers and relays, failure cleanup and resource rejection before
freezing the 2.0 contract. Prefer a clear 1.x mismatch over a general legacy
adapter. Future presets inside supported numeric semantics need no new enum;
new formats still require actual implementation and an advertised capability.

## Implementation Boundary

- `nativecapture` owns the child process, source identity, and bounded frame protocol.
- `mediaedge` owns shared encoded sources and independent PeerConnections with
  their connection-scoped UDP discovery, mapping and socket lifetime.
- `nativehost` owns the current capture generation and its bounded stable edges.
- `nativeviewer` owns one native inbound media source and its encoded child
  edges; it does not own room or route state.
- `nativecontrol` maps local source/share/receive/edge commands and exact native
  sender quality windows, live profile updates, and source replacement to the
  current loopback wire.

The deleted sender application, UI, room client, and old wire are not
compatibility inputs. Historical measurements remain in the separately marked
[native sender evidence](./native-sender.md).

## Primary Sources

- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [WGC `MinUpdateInterval`](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval)
- [Sunshine WGC update interval](https://github.com/LizardByte/Sunshine/blob/master/src/platform/windows/display_wgc.cpp)
- [WGC `CreateForWindow`](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)
- [WASAPI process loopback](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [OBS application-audio capture guide](https://obsproject.com/kb/application-audio-capture-guide/)
- [Media Foundation hardware MFTs](https://learn.microsoft.com/en-us/windows/win32/medfound/hardware-mfts)
- [MFT input sample ownership](https://learn.microsoft.com/en-us/windows/win32/api/mftransform/nf-mftransform-imftransform-processinput)
- [Chromium MFT frame-rate compensation](https://chromium.googlesource.com/chromium/src/+/master/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc)
- [Pion v4.2.18 stats implementation](https://github.com/pion/webrtc/blob/v4.2.18/stats.go)
- [WebRTC Stats target bitrate and limitation semantics](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC remote-track constraints](https://www.w3.org/TR/webrtc/#mediastreamtrack-network-use)
- [Pion single-port ICE](https://github.com/pion/webrtc/tree/master/examples/ice-single-port)
- [Pion broadcast relay](https://github.com/pion/webrtc/tree/master/examples/broadcast)
- [gopus pure-Go Opus codec](https://github.com/thesyncim/gopus)
- [Tailscale port mapper](https://github.com/tailscale/tailscale/tree/main/net/portmapper)
- [libp2p NAT port mapping](https://github.com/libp2p/go-libp2p/blob/master/options.go)
- [NetBird standalone Go NAT](https://github.com/netbirdio/go-nat)
- [WebRTC signaling and ICE](https://webrtc.org/getting-started/peer-connections)
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [ScreenCaptureKit audio output](https://developer.apple.com/documentation/screencapturekit/scstreamoutputtype/audio)
- [ScreenCaptureKit idle frames](https://developer.apple.com/documentation/screencapturekit/scframestatus/idle)
- [Apple VideoToolbox hardware encoder requirement](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder)
- [XDG ScreenCast Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [libportal](https://libportal.org/libportal.html)
- [PipeWire DMA-BUF contract](https://docs.pipewire.org/devel/page_dma_buf.html)
- [GStreamer PipeWire source](https://gstreamer.freedesktop.org/documentation/pipewire/pipewiresrc.html)
