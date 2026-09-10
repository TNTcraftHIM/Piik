# Browser Background Capture Diagnostics

- Research date: 2026-08-24
- Scope: desktop Chrome/Edge screen capture when the capturing document or the
  selected surface changes foreground state
- Status: bounded platform evidence; the reported background degradation has
  not been reproduced

## Conclusion And Physical Boundary

The capturing document and the selected display surface have independent
lifecycles. Page Visibility exposes only the document's visibility. It does not
define capture, encoding, transport, decoding, or rendering priority. Conversely,
the Screen Capture specification permits a browser and operating system to treat
a selected surface as temporarily inaccessible. A minimized captured window may
therefore mute or interrupt its track even when the capturing document is active.

Capture constraints are post-selection preferences. The browser may downscale or
decimate frames, so a requested maximum frame rate is not proof of capture-source
or encoded progress. A local preview and an `RTCPeerConnection` are independent
consumers of the same `MediaStreamTrack`; a paused or throttled preview does not
by itself prove that transmission stopped.

Current Chromium evidence narrows, but does not remove, the platform boundary:

- active capture contributes to renderer/process priority policy;
- a live or muted `MediaStreamTrack` opts its frame out of aggressive throttling
  and wake-up alignment;
- an active peer connection holds Chromium's internal application-suspension
  wake lock;
- Chrome's documented Energy Saver freezing excludes active display capture and
  a peer connection with a live media track; and
- desktop capture runs in the browser capture subsystem, applies a CPU budget,
  and may intentionally produce no duplicate frames for unchanged content.

These are browser implementation policies, not Web API guarantees of capture
FPS, encoder throughput, or remote presentation. The Screen Wake Lock API only
tries to keep a visible document's screen awake and is not a capture-priority
control. Browser energy and sleeping controls are user-side experimental
variables, not application keepalive mechanisms.

The open report must distinguish: document/UI sampling delay, selected-surface
inaccessibility, capture or encode pressure, WebRTC congestion adaptation,
receiver decode pressure, and presentation lifecycle. No workaround follows
until aligned evidence identifies one of those owners.

## Controlled Screening Result

On 2026-08-24, Chrome `151.0.7922.174` on Windows 25H2 build `26200.9168`
captured a continuously changing native WPF window through `getDisplayMedia()`.
The selected surface remained visible and changing. Capture settings were
1186x712 and 30 fps. One unchanged peer connection, sender, and track used
VP8/libvpx, no video content hint, a 5 Mbps ceiling, a 30 fps ceiling,
`scaleResolutionDownBy = 1`, and `balanced`. A same-machine loopback receiver
provided one 15-second RTCStats window per state. Automation selected the named
window only; it did not disable timer, occlusion, renderer-priority, Energy
Saver, or capture policy.

| Capturing-document state | Capture fps | Encoded fps | Sent bitrate | Encode ms/frame | Decoded fps | Limitation |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Focused | 29.58 | 29.58 | 1276 kbps | 1.50 | 29.51 | `none` |
| Hidden tab | 29.53 | 29.53 | 1206 kbps | 1.35 | 29.53 | `none` |
| Focused after hidden | 29.58 | 29.51 | 1231 kbps | 1.52 | 29.51 | `none` |
| Browser minimized | 29.39 | 29.39 | 1316 kbps | 1.45 | 29.39 | `none` |
| Focused after minimize | 29.39 | 29.39 | 1341 kbps | 1.46 | 29.39 | `none` |

At every boundary sample the track was enabled, unmuted, and live. Capture,
outbound, and inbound resolution remained 1186x712. The local preview played at
focused boundaries and was paused at hidden/minimized boundaries, while outbound
and decoded progress stayed near 30 fps. Every end sample reported
`qualityLimitationReason = "none"`.

Rates used monotonic counter deltas over the same outbound-RTP RTCStats timestamp
interval. Source and inbound timestamps and raw stats identities were not
retained independently, so this was not a complete interval-aligned proof.

This screening did not reproduce an immediate background drop. It also did not
exercise a real game/load, a separate physical receiver, audio, CPU/GPU
correlation, repeated randomized order, or a hold beyond five minutes. It is a
negative screening result, not product acceptance and not evidence that all
machines, browsers, capture surfaces, or sustained background states behave the
same way.

## Reproducible Diagnostic Evidence

Use a continuously changing native game, replay, or equivalent real display
surface. A JavaScript canvas is unsuitable because its own timer and animation
lifecycle confound capture. Use a stock supported browser, a clean profile, no
background-policy-disabling flags, and a separate physical foreground receiver
on a stable baseline path. Keep the selected surface changing, and vary the
capturing document separately from the selected surface.

Every compared window needs one stable capture generation, sender, receiver,
track, SSRC/stats object identity, and negotiated codec. Form adjacent,
non-overlapping deltas from each object's own RTCStats timestamps, then compare
only overlapping capture/send/receive windows. An absent optional field remains
unknown. An identity change, counter reset, missing interval, or non-overlapping
window makes the comparison inconclusive.

| Stage | Required facts |
| --- | --- |
| A. Capture | Track `enabled`, `muted`, and `readyState`; `displaySurface`; actual `getSettings()` width, height, and frame rate; `RTCVideoSourceStats` frames and fps; capturing-document visibility/focus; selected-surface state; preview `paused` state |
| B. Sender | Outbound frames encoded, fps, bytes, frame size, encode-time delta, `qualityLimitationReason` and duration deltas, target/available bitrate when present, codec/profile, encoder category, retransmission, loss, and RTT |
| C. Receiver | Inbound bytes/fps, frames received/decoded/dropped, freeze count/duration deltas, loss, jitter, codec, and foreground render progress |
| D. System | Coarse Host/receiver CPU and GPU load, power source, browser energy/sleep setting, OS/browser versions, and selected-surface state |

Host state, selected-surface state, and system counters must share the same
relative timeline as A/B/C. Record the actual codec and encoder category rather
than inferring them from configuration. `qualityLimitationReason` is supporting
evidence, not a sole root-cause oracle.

### Interpretation

1. Preview or diagnostic UI cadence changes while source, outbound, inbound,
   decode, and render progress stay stable: presentation or sampler behavior,
   not a media-path defect.
2. JavaScript callbacks arrive late while rates calculated from RTCStats
   timestamps stay stable: sampler cadence, not capture degradation.
3. Source frame progress falls or the track mutes, and outbound encoding follows:
   selected surface, OS, or capture backend.
4. Source progress stays stable while encoded progress falls, with encode work or
   `qualityLimitationReason = "cpu"` agreeing: encoder or system pressure.
5. Source progress stays stable while outbound quality/progress falls with
   bandwidth limitation, target/available bitrate, loss, RTT, or retransmission
   changes: congestion or transport path.
6. Host outbound progress stays stable while receiver inbound or decode falls:
   transport or receiver. Decode stays stable while only displayed progress
   changes: receiver presentation lifecycle.
7. Capture, outbound, inbound, and decoded progress stay stable while visual
   detail falls: codec/profile, bitrate, quantization, adaptation, or display
   scaling rather than background capture throttling.
8. The required identity or temporal alignment is absent: inconclusive. Do not
   convert missing evidence to zero or infer a fix.

The first reproducible comparison should change only one lifecycle variable at a
time and restore a verified baseline between states. Window lengths, repetitions,
and state order are experiment design choices based on the reported onset and
browser policy under test; they are not product timeouts or quality thresholds.

## Mobile Boundary

Desktop Host capture evidence does not establish mobile Viewer background
playback or the survival of browser-owned work after OS suspension. Mobile
acceptance must separately observe:

- visible versus background document state;
- screen lock and unlock;
- OS suspension, page freezing, discard, or process reclamation;
- Wi-Fi/cellular transition and foreground recovery; and
- whether the exact pre-suspension media identity survived or was re-created.

A mobile browser cannot promise background execution beyond its browser/OS
lifecycle. Recovery must be judged from newly decoded and presented media after
foregrounding, not from delayed JavaScript timers or a desktop result.

## Privacy And Evidence Handling

Raw `chrome://webrtc-internals` dumps stay on the controlled test machine. They
may contain URLs/origins, RTC configuration, candidate addresses, network data,
and fingerprinting material. Do not enable packet, audio-debug, event-log, or
media recording for this diagnostic.

Only a manually reviewed derived table may become durable evidence. Replace
room, user, session, connection, track, SSRC, and stats IDs with run-local
ordinals. Omit URLs, origins, hostnames, IP and candidate addresses, device
labels/IDs, hardware identifiers, and media content. Retain only versions and
configuration, coarse environment, lifecycle state, actual codec/encoder
category, bounded metrics, and relative timestamps.

## Primary Sources And License

Sources were checked on 2026-08-24.

- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/) defines captured-
  surface lifecycle, temporary inaccessibility, constraints, downscaling, and
  frame decimation. It is a Working Draft, not a performance guarantee.
- [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
  defines tracks and their independent consumers.
- [W3C WebRTC Statistics](https://w3c.github.io/webrtc-stats/) distinguishes
  media-source, outbound RTP, inbound RTP, codec, and optional limitation facts;
  cumulative deltas and stats timestamps are the measurement basis.
- [WHATWG Page Visibility](https://html.spec.whatwg.org/multipage/interaction.html#page-visibility)
  defines document visibility, not media scheduling priority.
- Chromium's [capture accounting](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/renderer_host/render_frame_host_impl.cc),
  [process-priority calculation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/child_process_launcher.cc),
  and [Performance Manager voter registration](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/performance_manager/performance_manager_lifetime.cc)
  show how active media capture influences current renderer priority policies.
- Chromium [`MediaStreamTrack` scheduling](https://chromium.googlesource.com/chromium/src/+/0b9090f669ed390bbc61eadcd59a05ca98c6a0bc/third_party/blink/renderer/modules/mediastream/media_stream_track_impl.cc)
  shows the live/muted-track scheduler opt-outs at a pinned revision.
- [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
  and [Chrome Energy Saver freezing](https://developer.chrome.com/blog/freezing-on-energy-saver)
  document hidden-timer behavior and active-media exclusions.
- Chromium [`DesktopCaptureDevice`](https://chromium.googlesource.com/chromium/src/+/master/content/browser/media/capture/desktop_capture_device.cc)
  shows browser-process capture scheduling, CPU budgeting, and supported
  damage-driven capture behavior.
- WebRTC's [Windows WGC minimized-window tests](https://webrtc.googlesource.com/src/+/master/modules/desktop_capture/win/wgc_capturer_win_unittest.cc)
  require temporary error on minimized selected windows and recovery on restore.
- Chromium's [WebRTC internals owner](https://chromium.googlesource.com/chromium/src/+/master/content/browser/webrtc/webrtc_internals.cc)
  shows the internal active-peer-connection application-suspension wake lock.
- [W3C Screen Wake Lock](https://www.w3.org/TR/screen-wake-lock/) bounds the Web
  API to visible-document screen wakefulness.
- [Chrome performance settings](https://support.google.com/chrome/answer/12929150)
  and [Edge performance features](https://support.microsoft.com/en-us/edge/learn-about-performance-features-in-microsoft-edge)
  document user-side energy and sleeping controls and media exclusions.

This document summarizes public specifications and implementation evidence; it
copies no source code and adds no dependency. W3C material uses the
[W3C Document License](https://www.w3.org/copyright/document-license-2023/).
Chromium and WebRTC source files carry BSD-style licenses. Chrome for Developers
prose is CC BY 4.0, with samples under Apache 2.0. These sources are evidence
only; their implementations are not incorporated into Piik.
