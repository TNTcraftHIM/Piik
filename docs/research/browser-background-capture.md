# Browser Background Capture Diagnostics

- Research date: 2026-08-24
- Scope: desktop Chrome/Edge Web Host capture while the Host page is
  unfocused, occluded, backgrounded, or minimized
- Status: one bounded current-browser screening did not observe an immediate
  Host-page background drop; the reported real-game case remains unreproduced
  and unattributed, and no new fix is accepted, implemented, or deployed

## Current Conclusion

There is no evidence that Screener is missing a page-liveness signal. Chromium
already marks live `MediaStreamTrack` use as a scheduler opt-out from aggressive
throttling and wake-up alignment, feeds active capture into both renderer
priority policy paths, and holds an internal application-suspension wake lock
for active peer connections. Those mechanisms are intended to protect active
media from ordinary invisible-page background treatment; they do not guarantee
a requested capture rate, encoder throughput, or remote rendering rate, and no
Web API lets an application assert additional foreground scheduling priority.

A bounded Chrome 151 screening on the current Windows test machine also kept
real window capture, VP8 encoding, loopback receipt, and decode at about 29.4 to
29.6 fps while the Host document was focused, in a hidden tab, and in a
minimized browser window. No immediate Host-document background drop was
observed in those 15-second windows. The sample does not reproduce the reported
game workload, separate physical Viewer, production route, CPU/GPU contention,
or browser policies whose documented hidden-state threshold exceeds five
minutes.

The current report therefore remains open but diagnostic-only. It must
distinguish five different effects before any product change is considered:

1. Host preview or stats presentation is throttled while transmitted media is
   unchanged.
2. The selected display surface becomes inaccessible, muted, unchanged, or
   otherwise constrained by the browser, operating system, or capture backend.
3. Capture work or video encoding is CPU/GPU constrained.
4. WebRTC congestion control reduces outbound resolution, frame rate, or
   bitrate.
5. The Viewer receives the normal stream but decodes, renders, or displays it
   differently.

The Host page lifecycle and the captured source lifecycle are independent
variables. The Screen Capture specification permits a user agent to treat a
minimized captured surface as temporarily inaccessible and mute its track; it
does not say that minimizing the separate capturing page must reduce capture.
Capture constraints are post-selection preferences and allow frame decimation,
so requested `maxFramerate` is not proof of actual source or encoded frame rate.

The accepted Browser video codec is fixed VP8. Every run still records the
actual negotiated codec and encoder rather than inferring either from
configuration. Encoder implementation is a diagnostic variable only after a
stable baseline exists; neither codec nor encoder choice is a page-keepalive
mechanism.

The 2026-08-19 report came from exact release `769de201f7cc`, which still set
video `contentHint = "motion"`. Current source and production leave the video
hint unset; a separate controlled VP8 probe changed from 14.93 fps at 428x208
with `motion` to 29.73 fps at 1904x928 without it. That known old-source defect
is fixed in the current contract, but it does not prove that the state-dependent
background report had the same cause. The physical baseline must therefore
start from current production rather than carrying the old report forward as a
current regression.

## Current Source Boundary

The no-video-hint review baseline is
`a26eb39dc677003110787b0ed1581c208f894fd7`. Production runs exact deployed
application/runtime revision `679fe3e7af634309322bea83b316641f51ad3d09`, release
`679fe3e`; canonical `main` contains the same runtime code. Current source and
production use strict `screener-v11`, fixed VP8, no video hint, and no codec UI,
quality state, or wire field.
The current path does not claim or implement a page-keepalive mechanism, and
deployment health supplies no physical background-capture evidence.

- Current `src/client/media/quality.ts` obtains one `getDisplayMedia()` stream,
  applies ideal/max capture constraints, leaves the video hint unset, and
  applies sender bitrate, frame-rate, and degradation ceilings. Explicit
  sharing pause and authoritative reconnect re-pause change capture tracks'
  `enabled` state; neither manufactures foreground activity. Audio
  `contentHint = "music"` remains unchanged.
- `src/client/pages/HostPage.tsx` pauses the existing local preview video when
  the Host document is hidden or unfocused and resumes that preview when it is
  visible and focused. This does not stop, mute, disable, or replace the capture
  track or any sender.
- No `requestAnimationFrame()` loop drives source or production capture or sending.
  WebRTC capture, encoding, congestion control, and transport remain
  browser-owned.
- `src/client/webrtc/stats.ts` already distinguishes capture settings,
  `media-source` encoder-input rate, outbound RTP rate and counters, encode
  work, limitation reason, codec, encoder, and receiver metrics. Its interval
  calculations use RTCStats timestamps, so delayed UI timer delivery must not
  be inferred as an equal media-rate drop.
- `src/client/lib/diagnostic-export.ts` exports only the latest bounded sample.
  It is a useful cross-check, not a historical trace.
- The short-lived pending-candidate decoded-frame observer reads cumulative RTP
  progress only for the exact pending route. It neither drives capture nor proves
  document activity, and it stops when that operation settles.
- `scripts/peer-assisted-benchmark.ts` is not evidence for this issue: its
  synthetic canvas source is timer-driven and its browser launch explicitly
  disables background timer, occluded-window, and renderer backgrounding.

The first investigation uses these existing fields plus local browser
diagnostics. It does not authorize a server telemetry schema, persistent
history, background push, or another media lifecycle.

## Primary Evidence

All sources were checked on 2026-08-24.

- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/) defines the
  captured-surface mute/end lifecycle and permits post-selection downscaling
  and frame decimation. It leaves the definition of temporary surface
  inaccessibility to the user agent and operating system. This is a Working
  Draft, so it is a diagnostic boundary rather than a cross-browser performance
  guarantee.
- [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
  keeps a `MediaStreamTrack` and its consumers distinct. A local media element
  and an `RTCPeerConnection` consume the same track independently.
- [W3C WebRTC Statistics](https://w3c.github.io/webrtc-stats/) defines
  `media-source` as media after track constraints and before encoding, while
  outbound RTP describes encoded transmission. Cumulative counter deltas and
  stats timestamps are the comparison basis. Optional absent fields remain
  unknown. This is an Editor's Draft and does not require every browser to emit
  every optional member.
- [WHATWG HTML Page Visibility](https://html.spec.whatwg.org/multipage/interaction.html#page-visibility)
  defines observable document visibility; it does not define capture or encoder
  priority.
- [Chromium capture accounting](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/renderer_host/render_frame_host_impl.cc)
  forwards the first `kCapturingMediaStream` to the renderer process, and the
  [process-priority calculation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/child_process_launcher.cc)
  treats a media stream as non-background when no priority override exists.
  Chromium's
  [Performance Manager voter registration](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/performance_manager/performance_manager_lifetime.cc)
  separately installs `FrameCapturingMediaStreamVoter` to cast a
  `USER_BLOCKING` vote for a capturing frame when that priority path is active.
  These are implementation policies, not a priority measurement from the local
  screening.
- [Chromium `MediaStreamTrack` scheduling](https://chromium.googlesource.com/chromium/src/+/0b9090f669ed390bbc61eadcd59a05ca98c6a0bc/third_party/blink/renderer/modules/mediastream/media_stream_track_impl.cc)
  disables aggressive throttling and wake-up alignment while a live or muted
  track exists. Ordinary hidden-page JavaScript timer batching remains
  independent.
- [Chrome chained-timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
  says hidden-page timers may be batched and `requestAnimationFrame()` is not a
  background clock. A live WebRTC media track avoids the intensive once-per-
  minute timer tier, but ordinary background timer batching can still make a
  UI sampler appear stale.
- [Chrome Energy Saver freezing](https://developer.chrome.com/blog/freezing-on-energy-saver)
  excludes active screen/window/tab capture and a peer connection with a live
  media track from the documented Chrome 133 freezing policy. That exclusion
  is not an encoder or frame-rate guarantee.
- [Chromium `DesktopCaptureDevice`](https://chromium.googlesource.com/chromium/src/+/master/content/browser/media/capture/desktop_capture_device.cc)
  schedules capture in the browser capture subsystem, requests an internal
  display-sleep wake lock, and by default limits desktop capture to 50% of one
  CPU core by lengthening the next capture period when capture work is slow. On
  supported current Windows builds it also permits damage-driven WGC 0 Hz
  behavior for unchanged content. This is direct evidence for measuring capture
  work and actual content changes rather than manufacturing renderer activity
  or treating intentionally absent duplicate frames as degradation.
- [WebRTC Windows WGC minimized-window tests](https://webrtc.googlesource.com/src/+/master/modules/desktop_capture/win/wgc_capturer_win_unittest.cc)
  require temporary capture errors when the captured window itself is minimized
  and recovery after it is restored. This is distinct from minimizing the
  separate Host browser window and does not specify JavaScript event timing.
- [Chromium WebRTC internals owner](https://chromium.googlesource.com/chromium/src/+/master/content/browser/webrtc/webrtc_internals.cc)
  requests an internal application-suspension wake lock for active peer
  connections. This internal browser behavior is not equivalent to the Web
  Screen Wake Lock API and is not an application control surface.
- [Chromium WebRTC internals dump UI](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/webrtc/resources/webrtc_internals.html)
  provides local API-event and getStats evidence. Its full dump is private lab
  input, not a project artifact.
- [W3C Screen Wake Lock](https://www.w3.org/TR/screen-wake-lock/) only attempts
  to prevent a visible document's screen from turning off; hidden documents
  lose the lock. It does not promise capture, encoder, timer, or renderer
  priority.
- [Chrome performance settings](https://support.google.com/chrome/answer/12929150)
  and [Edge performance features](https://support.microsoft.com/en-us/edge/learn-about-performance-features-in-microsoft-edge)
  provide user-side energy and sleeping controls. Edge explicitly excludes
  active window/screen and user-media capture from Sleeping Tabs, while Energy
  Saver can still affect video or gaming smoothness. Browser exclusions are
  useful A/B controls, not Web application keepalive APIs.

## Bounded Current-Browser Screening

On 2026-08-24, Chrome `151.0.7922.174` on Windows 25H2 build `26200.9168`
captured a continuously changing native WPF window through real
`getDisplayMedia()`. The source remained visible and changing; capture returned
1186x712 at a 30 fps setting. One VP8/libvpx sender used no video hint, a 5 Mbps
ceiling, 30 fps ceiling, `scaleResolutionDownBy = 1`, and `balanced`, with one
same-machine loopback receiver. Each state had one 15-second RTCStats window.
The automation flag selected the named window in the picker only; no
background-timer, occlusion, renderer-priority, Energy Saver, or capture policy
was disabled.

| Host state | Capture fps | Encoded fps | Sent bitrate | Encode ms/frame | Decoded fps | Limitation |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Focused | 29.58 | 29.58 | 1276 kbps | 1.50 | 29.51 | `none` |
| Hidden tab | 29.53 | 29.53 | 1206 kbps | 1.35 | 29.53 | `none` |
| Focused after hidden | 29.58 | 29.51 | 1231 kbps | 1.52 | 29.51 | `none` |
| Browser window minimized | 29.39 | 29.39 | 1316 kbps | 1.45 | 29.39 | `none` |
| Focused after minimize | 29.39 | 29.39 | 1341 kbps | 1.46 | 29.39 | `none` |

At every boundary sample, the capture track was enabled, unmuted, and live at
1186x712; the local preview played at focused boundaries and was paused at
hidden and minimized boundaries. Outbound and inbound boundary samples were
also 1186x712, and every end sample reported `qualityLimitationReason=none`.
The probe kept one unchanged PC, sender, and track. Capture, encoded, and decoded
rates divided their monotonic counter deltas by the same outbound-RTP RTCStats
timestamp interval; bitrates used the corresponding byte deltas. Source and
inbound timestamps and raw stats identity were not independently retained, so
this is not an A/B/C interval-identity proof.

This is a screening result, not the product acceptance run. It has one short
same-machine loopback, no production Screener route, no separate physical
Viewer, no real game/render load, no audio, no CPU/GPU counter correlation, and
no repetition, randomized order, or hidden/minimized hold beyond five minutes.
It narrows the next test to the reported workload and environment; it does not
close the TODO or justify a Browser workaround.

## Minimal Reproduction

### Baseline

Use one desktop Host and one separate physical Viewer on a direct, wired path.
Do not include SFU, peer relay, multiple senders, Wi-Fi, or cellular behavior in
the first baseline. Use a supported stock Chrome/Edge build with a clean
profile and no background-throttling flags. Record browser and OS versions,
power source, Energy Saver state, display topology, and coarse CPU/GPU load.
Exact device, driver, and hardware identifiers remain local.

Use a deterministic, continuously changing game scene or built-in replay on a
real display surface. A JavaScript canvas animation is not suitable because
its own timer or animation-frame lifecycle would confound the capture result.
Keep the selected source foreground, visible, and changing throughout the
first matrix.

After Screener reproduces a stable baseline, the locally available NetEase UU
Remote client may be run against the same scene and network as a black-box
comparison for process CPU/GPU use, network traffic, latency, and visible
quality. User-observed low-latency behavior is a reason to measure it, not
evidence of its transport, codec, encoder, background policy, or applicability
to a browser Host; those properties remain unknown unless the comparison exposes
them directly.

Open `chrome://webrtc-internals` on Host and Viewer before sharing and keep its
overhead constant across every run. Leave audio-debug recording, event-log
recording, packet capture, and media recording disabled. The current Screener
diagnostic download may be taken at state boundaries as a latest-sample
cross-check; it is not used as a time series. If a stable reproduction suggests
freezing or discard, inspect the Host tab from a pre-opened separate control
window in `chrome://discards` or `edge://discards` outside the timed measurement
window. That page may expose URLs and therefore remains local evidence.

### Host-State Matrix

Run these Host-page states while the captured source, Viewer, route, scene, and
quality setting remain unchanged:

| State | Host document | Browser window | Captured source |
| --- | --- | --- | --- |
| Focused | visible and focused | visible | visible and changing |
| Unfocused | visible, not focused | visible or occluded | visible and changing |
| Background tab | hidden | visible | visible and changing |
| Minimized | hidden | minimized | visible and changing on another display |

Use equal 60-second measurement windows, restore the focused baseline between
states, randomize state order, and repeat three fresh controlled runs. These
window and repeat counts define a small comparable sample; they are not product
timeouts, quality thresholds, or proof of statistical significance. Record the
actual initial negotiated codec and encoder; do not switch codec inside a
run.

For each exact overlapping window, correlate:

| Stage | Required evidence |
| --- | --- |
| A. Capture | track `enabled`/`muted`/`readyState`; `displaySurface`; `getSettings()` width, height, and requested-result frame rate; `RTCVideoSourceStats` frames and frame rate; Host visibility/focus and local preview `paused` state |
| B. Sender | outbound `framesEncoded`, frame rate, bytes, frame size, `totalEncodeTime` delta, `qualityLimitationReason`, target/available bitrate when present, actual codec/profile, encoder implementation, retransmission, loss, and RTT |
| C. Viewer | inbound bytes and frame rate, frames received/decoded/dropped, freeze count/duration deltas, loss, jitter, actual codec, and foreground render behavior |

Use RTCStats object identity, media generation, and timestamps to form adjacent,
non-overlapping deltas. A missing optional member, changed stats object, counter
reset, or non-overlapping interval remains unknown rather than zero. Record OS,
browser, game, and GPU/CPU observations over the same timestamps; do not infer a
media result from the Host UI refresh cadence.

### Follow-Up Only After Stable Reproduction

Change one variable per fresh run:

1. Compare entire-monitor and application-window capture, then vary the
   captured source's own visible, occluded, and minimized state while the Host
   page state stays fixed.
2. Compare local preview playing and paused while capture and sender identities
   stay fixed.
3. When investigating the 2026-08-19 production report, compare exact release
   `769de201f7cc` with the then-current exact `main` commit on the same machine,
   browser, driver, game scene, and direct wired Viewer.
4. If the short state matrix does not reproduce a report that concerns sustained
   background operation, run one fresh hold longer than Chrome's documented
   five-minute hidden-policy window in only the reported hidden or minimized
   state. Keep the source changing and compare the first and last minute with
   focused baselines; do not multiply that hold across every state.

Do not run a full factorial matrix before the baseline reproduces. A follow-up
must have one stated hypothesis and one changed variable.

## Interpretation Gates

1. If Host preview or stats presentation slows while Viewer inbound and render
   remain stable, classify it as local presentation or timer behavior; there is
   no media defect to repair.
2. If JavaScript callback cadence slows while cumulative RTC counters divided by
   RTCStats timestamp deltas remain stable, classify the observation as sampler
   cadence, not capture or sender degradation.
3. If `RTCVideoSourceStats` frame progress falls, or the track becomes muted,
   and outbound encoding follows it, localize the issue to the selected source,
   operating system, or capture backend. A captured source that becomes
   inaccessible is a platform lifecycle boundary, not evidence for Host-page
   keepalive.
4. If source progress remains stable while outbound encoded progress falls and
   encode work or `qualityLimitationReason=cpu` agrees, investigate encoder and
   system load. `qualityLimitationReason` is corroborating evidence, not a sole
   root-cause oracle.
5. If source progress remains stable while outbound rate falls with
   `qualityLimitationReason=bandwidth`, target/available bitrate, loss, RTT, or
   retransmission changes, investigate congestion control and the actual path.
6. If Host outbound remains stable while Viewer inbound or decode falls,
   investigate transport or receiver behavior. If inbound/decode is stable but
   only rendering changes, investigate Viewer presentation lifecycle.
7. If capture, outbound, inbound, and decoded progress remain stable but the
   picture looks blurred, investigate actual codec/profile, bitrate,
   quantization, and display scaling; do not classify it as background capture
   throttling.
8. If required identities, overlapping windows, or optional metrics are
   missing, the result is inconclusive. It does not authorize a workaround.

## Privacy And Evidence Handling

Raw `chrome://webrtc-internals` dumps stay on the controlled test machine and
must not be committed, uploaded, attached to a room, or sent through Screener.
They can include page URLs/origins, RTC configuration, candidate addresses,
network details, and other fingerprinting material. Do not enable packet,
audio-debug, event-log, or media recording for this experiment.

Only a manually reviewed derived table may become repository evidence. It must
replace room, user, session, connection, track, SSRC, and stats IDs with
run-local ordinals and omit URLs, origins, hostnames, IP addresses, candidate
addresses, device labels/IDs, exact hardware serials, and media content. The
allowed durable fields are test version/configuration, coarse environment,
surface category, document/source lifecycle state, route category, actual
codec/encoder category, bounded metric values, and relative timestamps.

No new diagnostic server upload, push, sampling timer, ring buffer,
persistence, raw stats/SDP/candidate collection, or general telemetry mechanism
is approved by this research. If the local tools cannot establish an A/B/C
overlap, document the exact missing field first; any new diagnostic consumer
requires its own bounded design and privacy review.

## Mechanisms Outside The Accepted Boundary

The diagnostic does not adopt:

- `requestAnimationFrame()`, chained timer, Worker, or synthetic activity loops;
- silent audio, `AudioContext` oscillators, hidden/looping media, Picture-in-
  Picture tricks, focus stealing, or synthetic input;
- dummy `RTCDataChannel`, `RTCPeerConnection`, WebSocket, signaling ping, or
  service-worker activity as a liveness proof;
- the Web Screen Wake Lock API as a capture-priority control;
- product launch flags that disable browser background policies;
- visibility-triggered codec switching, another Browser media codec, extra sender
  generations, or automatic capture replacement;
- server-side media telemetry, raw diagnostic upload, periodic probes, routing
  changes, quality-driven reparenting, or magic quality thresholds; or
- a Native/executable sender fallback for this browser diagnostic milestone.

The accepted response to a demonstrated standards/browser capability boundary
is a clear documented limitation. A workaround is considered only after the
same-machine A/B/C evidence identifies a controllable owner and a minimal
standard mechanism changes the remote result without creating another media
lifecycle.

## License Boundary

This document summarizes public specifications and implementation evidence; it
copies no source code and adds no dependency. W3C material is covered by the
[W3C Document License](https://www.w3.org/copyright/document-license-2023/),
Chromium source files carry their BSD-style license, and Chrome for Developers
prose is CC BY 4.0 with samples under Apache 2.0. These sources are evidence
only; their implementation is not incorporated into Screener.
