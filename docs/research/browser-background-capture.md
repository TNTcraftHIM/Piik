# Browser Background Capture Diagnostics

- Research date: 2026-08-24
- Scope: desktop Chrome/Edge Web Host capture while the Host page is
  unfocused, occluded, backgrounded, or minimized
- Status: diagnostic plan; the reported degradation has not been reproduced or
  attributed under controlled measurement, and no fix is accepted, implemented,
  or deployed

## Current Conclusion

There is no evidence that Screener is missing a page-liveness signal. A live
display-capture track and a live WebRTC connection already put the page in the
media cases that current Chrome excludes from intensive timer throttling and
Energy Saver freezing. Those exclusions do not guarantee a requested capture
rate, encoder throughput, or remote rendering rate, and no Web API lets an
application assert foreground scheduling priority.

The current report therefore remains diagnostic-only. It must distinguish five
different effects before any product change is considered:

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

The accepted and deployed default video preference is VP8. Every run records
the actual negotiated codec and encoder rather than inferring either from
the preference. H.264, VP8, and encoder implementation are diagnostic variables
only after a stable baseline exists; none is a page-keepalive mechanism.

## Current Source Boundary

The source review covers exact Browser v10 source
`fdd5a4a529ff297f41c05ea3388bf484d76afe8f`, integrated and deployed by exact
main `2726edde9b87f31fd76e749de47972ef817a9bd5`. The current path does not claim or
implement a page-keepalive mechanism, and deployment health supplies no
physical background-capture evidence.

- `src/client/media/quality.ts` obtains one `getDisplayMedia()` stream, applies
  ideal/max capture constraints, marks video as `motion`, and applies sender
  bitrate, frame-rate, and degradation ceilings. Explicit sharing pause and
  authoritative reconnect re-pause change capture tracks' `enabled` state;
  neither manufactures foreground activity.
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
- V9's short-lived pending-candidate decoded-frame observer reads cumulative RTP
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
- [W3C Page Visibility](https://www.w3.org/TR/page-visibility-2/) defines
  observable document visibility; it does not define capture or encoder
  priority.
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
  CPU core by lengthening the next capture period when capture work is slow.
  This is direct evidence for measuring capture cost rather than manufacturing
  renderer activity.
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

Open `chrome://webrtc-internals` on Host and Viewer before sharing and keep its
overhead constant across every run. Leave audio-debug recording, event-log
recording, packet capture, and media recording disabled. The current Screener
diagnostic download may be taken at state boundaries as a latest-sample
cross-check; it is not used as a time series.

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
actual initial negotiated codec and encoder for the chosen pre-share preference;
do not switch codec inside a run.

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
3. Run separate new Host/share/peer-connection sessions for `automatic`, H.264,
   and VP8 through the pre-share diagnostic selector, and verify the actual codec
   and encoder in each session.
4. When investigating the 2026-08-19 production report, compare exact release
   `769de201f7cc` with the then-current exact `main` commit on the same machine,
   browser, driver, game scene, and direct wired Viewer.

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
- visibility-triggered H.264/VP8 switching, forced H.264, extra sender
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
