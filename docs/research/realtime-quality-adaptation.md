# Realtime Screen-Share Quality Adaptation

- Research date: 2026-08-19
- Scope: realtime game screen sharing in the browser
- Status: implementation input; real-device quality remains unverified

## Finding

Screener should not optimize one quality dimension at the expense of the
others. `maintain-framerate` may preserve motion by reducing resolution until
game UI, maps, subtitles, and text become unreadable; `maintain-resolution`
may instead lower frame rate. Neither preference overrides congestion control.

The current bounded implementation retains the game-oriented `motion` hint,
defaults to `maintain-resolution`, and offers explicit balanced and fluid
choices. This is a readability-first default, not a quality guarantee: the
WebRTC API describes a user-agent preference rather than its algorithm, so
Chromium, Firefox, and Safari behavior still needs measured comparison.

The inspected Chromium/libwebrtc source chain makes a screen-only shortcut
especially unsafe to assume for Screener. The JavaScript `motion` hint reaches
`VideoRtpSender` as `kFluid`, which explicitly clears `options.is_screencast`.
`WebRtcVideoSendStream` then configures the encoder as `kRealtimeVideo`, while
`VideoStreamEncoder` only reinterprets `BALANCED` as `MAINTAIN_RESOLUTION` when
its encoder is marked as screen share. The explicit `balanced` preference still
wins the earlier preference-selection branch, but the later screen-only remap
does not follow from this project path. Treat the effective tradeoff as an
implementation detail to verify, not a product guarantee.

An older libwebrtc experiment could detect animated screen content under
`balanced` and cap it to 1280x720. Commit `1d7d0e6e2c50` deleted that experiment
on 2024-05-22; the commit says it had already been disabled for several years
and was not maintained. Current Chromium behavior must therefore not be
described as automatically detecting game motion and forcing a 720p cap.

## Production Degradation Report

On 2026-08-19 the deployed build was reported to deliver very low resolution,
bitrate, and frame rate across all three profiles. This is a user observation,
not yet an instrumented result. Draft PR #28's minimum-of-two feedback loop was
never deployed and cannot have caused it. The production `getStats()` probes are
read-only and do not trigger a downgrade. Peer/SFU code ships in `769de201f7cc`,
but its production configuration is absent, so relay re-encoding and LiveKit
cannot explain the earlier observation either.

Plausible causes remain: capture settings below the request; one independent
encoder pipeline per peer exhausting CPU/GPU; GCC reacting to host uplink or a
TURN path; treating `maxBitrate` as a target when it is only a ceiling; browser
rewriting or scaling sender parameters; or receive loss, jitter, decode, and
display scaling. None is selected as the root cause before correlated evidence.

One controlled capture should classify the problem before changing constants:

1. Run the same high-motion scene for 60 to 90 seconds with one, two, then three
   viewers, plus one TURN/UDP case.
2. Compare capture settings/media-source, outbound and inbound resolution/FPS,
   actual and target bitrate, codec and encoder implementation, interval encode
   cost, selected path, and `qualityLimitationReason`.
3. Treat source-low as capture, outbound-low with `cpu` as encoder pressure,
   outbound-low with `bandwidth` as uplink/path pressure, and inbound-only loss
   or dropped/frozen frames as network or receiver pressure.
4. Export `chrome://webrtc-internals` only as sensitive local evidence; remove
   SDP, candidate addresses, and other identifiers before sharing or retaining.

Missing `scaleResolutionDownBy` is not itself a root cause for a single encoding
because its effective default is 1.0. Likewise, the current 3/5/8 Mbps values
are ceilings rather than targets. Raising them cannot repair CPU or bandwidth
limitation and should only follow evidence that the encoder is already pinned
to the ceiling while spare transport capacity remains.

## Evidence Before Adaptation

Verified specification facts: the W3C stats model supports the needed
separation but does not produce the product decision itself.
`MediaStreamTrack.getSettings()` supplies the actual
capture dimensions/frame rate. Outbound RTP exposes emitted dimensions/FPS,
byte and retransmission counters, encode time, target bitrate when available,
and the current `qualityLimitationReason`; the selected candidate pair can
expose RTT and available outgoing bitrate. Inbound RTP exposes received
dimensions/FPS, byte/loss/jitter counters, decoded/dropped frames, and freeze
counters when implemented. Stats members may be absent, and cumulative values
must be compared across two samples rather than treated as interval values.

Correlate one time interval and media generation across:

| Evidence | Fields |
| --- | --- |
| A. Host capture | actual width, height, FPS from `getSettings()` |
| B. Host outbound | width/FPS/bitrate, target/available bitrate, interval encode time, limitation reason, path, RTT, loss, retransmission |
| C. Viewer inbound | width/FPS/bitrate, loss, jitter, interval decode/drop, freeze |

Product inference from those facts: use the following ordered classification:

| Correlated observation | Likely boundary |
| --- | --- |
| Capture low | capture or constraints |
| Capture high; outbound low; `cpu` | encoder/resource pressure |
| Capture high; outbound low; `bandwidth` | GCC, uplink, or TURN/path pressure |
| Outbound healthy; inbound low | transport or receiver path |
| Inbound healthy; image visibly blurry | bitrate/quantization, codec, or display scaling |

This is a diagnostic classification, not a weighted health score. Missing or
reset evidence remains unknown and rebases the interval.

The smallest implementation sequence is local A+B correlation in one host
sampling tick, including the interval, media/stat identity, and valid deltas.
Only after that is trustworthy should a minimal authenticated C report carry
the receive/decode signals needed by the two-state predicate. A general remote
stats stream or telemetry pipeline is unnecessary.

## Accepted Adaptation Direction

ADR-0007 rejects room-wide worst-link adaptation. Healthy operation has one
shared `HIGH` representation. A viewing path enters `FALLBACK` only after
multiple consecutive windows show insufficient bandwidth, freezes, or decode
pressure in correlated sender/viewer evidence. The first verified weak path
starts one shared `LOW`; all weak paths reuse it while healthy paths remain on
`HIGH`. Recovery requires a longer stable window than entry. When the last weak
path recovers, stop `LOW`. The hard representation limit is two, never one per
viewer.

`LOW` itself is conditional: if no qualified hardware/power-efficient encoder
path exists or the second encoder exceeds the measured CPU/GPU/game budget, the
controller preserves `HIGH` and fails visibly for the weak path. It never buys
weak-path recovery by degrading healthy paths.

A viewer's `LOW` request is advisory and must be authenticated, session-bound,
rate-limited, deduplicated, and corroborated by sender transport/encode and
viewer receive/decode stats. UA or device-model detection is not quality
evidence; the current mobile/iPad heuristic remains restricted to relay
capacity.

An ordinary non-scalable stream cannot yield a second independent quality by
packet forwarding alone. The alternatives are a second representation,
scalable layers, or relay/SFU transcoding. Screener chooses the temporary second
representation first. SVC is conditional on a future strict-one-output need,
an exact negotiated mode, a positively established hardware or power-efficient
path, and measured game performance. WebRTC-SVC permits the browser to return a
different configured `scalabilityMode`; Media Capabilities reports support and
expected smoothness/power efficiency for a specified configuration; WebCodecs
defines `hardwareAcceleration` only as a hint the user agent may ignore.
Therefore none is, by itself, proof of a particular hardware encoder, and a
software SVC fallback must not be silent.

## Why Offline Encoding Presets Do Not Transfer

[Maruko Toolbox](https://github.com/wzxjohn/marukotoolbox) is an Apache-2.0
GUI around offline video-processing tools. Its x264-style CRF, slow presets,
lookahead, and multi-pass workflows trade encoding time and buffering for file
size and quality. Interactive WebRTC cannot buffer or revisit future frames in
that way. The transferable principle is to treat bitrate, image detail, frame
rate, and encode cost as a joint tradeoff; its concrete offline presets are not
a WebRTC configuration baseline.
The GUI repository is Apache-2.0, while x264 itself uses GPL-2.0 or commercial
licensing; no implementation or preset is copied into Screener.

Discord's published Go Live design reaches the same broad conclusion for
realtime game streaming: bandwidth estimates, frame delivery, image quality,
latency, CPU, and memory conflict and must be balanced. Its native encoder
tuning and hardware integration are not available to a browser-only sender and
must not be presented as settings this project already has.

## Current Policy

The three user-visible profiles remain ceilings rather than promised rates:

| Profile | Capture ceiling | Sender bitrate ceiling |
| --- | --- | ---: |
| 1080p60 | 1920x1080 at 60 fps | 8 Mbps |
| 1080p30 | 1920x1080 at 30 fps | 5 Mbps |
| 720p30 | 1280x720 at 30 fps | 3 Mbps |

The middle profile is an explicit manual 1080p30 ceiling: choosing it trades a
60 fps ceiling for a 1080p capture bound. LiveKit currently uses the same
1080p30 at 5 Mbps screen-share preset, but neither preset guarantees the emitted
resolution, frame rate, or bitrate.

- Initial capture supplies `ideal` and `max` bounds for resolution and frame
  rate; the actual result is read back from `MediaStreamTrack.getSettings()`.
- A live profile change uses `track.applyConstraints()` and updates every
  current sender with `RTCRtpSender.setParameters()`. It does not reopen the
  source picker or renegotiate healthy peer connections.
- The video track keeps `contentHint = "motion"`; recommended profiles default
  to `maintain-resolution`, with explicit `balanced` and
  `maintain-framerate` choices. None promises an emitted resolution or rate.
- `maxBitrate` and `maxFramerate` are ceilings. They are neither minimums nor
  target guarantees, and the project does not use SDP bitrate hacks.
- The folded advanced panel accepts only 720p/1080p/1440p, integer 15-60 fps,
  2-12 Mbps, and the three preferences. It exposes no audio quality controls.
  Display capture does not standardize channel-count or sample-rate control;
  the portable audio `maxBitrate` field is only a ceiling and cannot raise
  quality; and stereo, DTX, and FEC require negotiated fmtp/codec behavior that
  has no portable sender setter. The full boundary is recorded in
  `docs/research/browser-screen-audio-quality.md`.
- Every sender update derives from `getParameters()`, calls `setParameters()`,
  then reads requested/applied bitrate, frame rate, scale, and preference.
  Rejection or browser rewriting is visible rather than console-only.
- One strict room setting is last-wins for current/future peer relays and the
  optional SFU publisher. Ordinary P2P keeps that state local and does not add
  it to the authenticated wire.
- Pausing the picture disables the existing video track, producing black video
  without closing the room or media connection. Audio remains enabled.

The deployed implementation deliberately stops at manual bounded controls. It
adds no composite score, periodic adjustment, codec forcing, SDP bitrate
manipulation, or scene detector. Three consecutive samples of one non-`none` native
`qualityLimitationReason` produce one explanatory warning; a reason change or
recovery resets it and never triggers a media action.

A Chrome 151 loopback smoke with one host, three viewers, and synthetic 720p30
video propagated balanced then clarity settings to every participant. Every
baseline active outbound video sender displayed the matching requested/applied
preference, peer-connection fingerprints stayed unchanged, and every viewer's
decoded-frame and foreground `requestVideoFrameCallback` counters grew after
each change. Host media edges peaked at two and relay edges at one. This verifies
controls and continuity, not visual quality, full-resolution performance,
CPU/GPU cost, public networks, or sustained behavior.

## Deliberate Non-Goals

- No canvas pixel-difference detector, machine-learned rate controller, or
  periodic profile switching.
- No copied x264 CRF/preset recipe in the browser path.
- No forced codec order until target hardware measurements identify the actual
  power-efficient encoder.
- No channel-count, sample-rate, Opus bitrate, stereo, DTX, or FEC control, and
  no inference of actual stereo or sample rate from `opus/48000/2`.
- No promise that all browsers honor `applyConstraints` or degradation
  preference identically.
- No automatic composite quality score or periodic profile controller before
  the controlled production capture identifies a reproducible bottleneck.
- No room-wide minimum-of-viewers target, per-viewer encoder, UA/device quality
  ranking, or silent software SVC fallback.

## Verification Gate

Use the same static UI scene and deterministic high-motion game scene at
720p30, 1080p30, and 1080p60. Correlate A capture, B outbound, and C inbound at
the same interval. Record actual dimensions/FPS/bitrate, limitation reason,
codec, encoder implementation, interval encode/decode cost, drops/freezes,
jitter, RTT, loss/retransmission, selected direct/TURN path, and host CPU/GPU.
A live profile change must preserve peer connection IDs, avoid a second source
prompt, and visibly converge to the requested bounds.

Compute per-frame encode and decode cost from adjacent samples of cumulative
`totalEncodeTime`/`totalDecodeTime` and frame counters. The first sample, a
zero-frame interval, changed stats object, or a counter reset is unknown and
establishes a new baseline. Skip overlapping sampling ticks on the same peer so
reports cannot complete out of order. Do not use a connection-lifetime average
to judge a later overload. Use browser WebRTC diagnostics plus a small run
manifest for time series and percentiles rather than adding a server telemetry
pipeline.

Compare image readability and motion continuity instead of declaring success
from FPS alone. If reproducible evidence later shows that `balanced` still
oscillates or makes the wrong tradeoff on supported machines, revise the fixed
profiles before enabling ADR-0007. Its acceptance matrix must prove one healthy
viewer remains `HIGH` while another enters/recover from `FALLBACK`, that all weak
viewers share at most one `LOW`, and that `LOW` stops after sustained recovery.

## Primary Sources

- [W3C MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
- [W3C WebRTC](https://www.w3.org/TR/webrtc/)
- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [W3C WebRTC SVC](https://www.w3.org/TR/webrtc-svc/)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)
- [MDN `RTCRtpSender.setParameters()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)
- [Chromium `motion` to libwebrtc `kFluid` bridge](https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/modules/peerconnection/media_stream_video_webrtc_sink.cc)
- [libwebrtc `motion`/`kFluid` sender classification](https://webrtc.googlesource.com/src/+/3b1eab8a69cb5078befb021c5492d3f204a7d6a2/pc/rtp_sender.cc)
- [libwebrtc encoder content-type selection](https://webrtc.googlesource.com/src/+/9caef2a8b88f389af10cee841732c42a98d3d45d/media/engine/webrtc_video_engine.cc)
- [libwebrtc conditional screen-share degradation mapping](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_stream_encoder.cc)
- [libwebrtc adaptation overview](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/adaptation.md)
- [libwebrtc per-send-stream encoder construction](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_send_stream_impl.cc)
- [libwebrtc removal of the automatic animation-detection experiment, 2024-05-22](https://webrtc.googlesource.com/src/+/1d7d0e6e2c5002815853be251ce43fe88779ac85)
- [LiveKit screen-share presets](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts)
- [LiveKit degradation defaults](https://github.com/livekit/client-sdk-js/blob/main/src/room/participant/publishUtils.ts)
- [Jitsi desktop degradation preference](https://github.com/jitsi/lib-jitsi-meet/blob/master/modules/RTC/TraceablePeerConnection.ts)
- [Discord Go Live architecture](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology)
- [Discord encoder-quality case study](https://discord.com/blog/from-blocky-to-brilliant-improving-video-quality-on-discord-go-live-on-amd-gpus)
