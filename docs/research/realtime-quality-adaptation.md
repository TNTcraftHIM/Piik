# Realtime Screen-Share Quality Adaptation

- Research date: 2026-08-19
- Scope: realtime game screen sharing in the browser
- Status: implementation input; real-device quality remains unverified

## Finding

Screener should not optimize a single quality dimension at the expense of the
others. The previous combination of `contentHint = "motion"` and an explicit
`degradationPreference = "maintain-framerate"` told WebRTC to preserve frame
rate primarily by reducing resolution. That is appropriate for some fast
motion, but it can make game UI, maps, subtitles, and text unreadable.

The smallest correction is to retain the game-oriented `motion` hint while
explicitly selecting `balanced` degradation. The WebRTC API allows the user
agent to balance frame-rate and resolution degradation; it does not prescribe
the algorithm or guarantee a clarity-first result. Congestion control remains
authoritative, and Chromium, Firefox, and Safari behavior must be measured.

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
- The video track keeps `contentHint = "motion"`, while each sender explicitly
  uses `degradationPreference = "balanced"`. This is a user-agent preference,
  not a promise to preserve either resolution or frame rate.
- `maxBitrate` and `maxFramerate` are ceilings. They are neither minimums nor
  target guarantees, and the project does not use SDP bitrate hacks.
- Pausing the picture disables the existing video track, producing black video
  without closing the room or media connection. Audio remains enabled.

A Chromium 151 loopback smoke with one host, three viewers, and a synthetic
640x360/30 source kept the same relay peer, sender, and signaling generations
while applying 8 Mbps/60 fps, 5 Mbps/30 fps, and 3 Mbps/30 fps sender ceilings.
The leaf continued decoding after both live switches. This verifies control
propagation and connection preservation, not actual 1080p output, visual
quality, CPU/GPU cost, public-network behavior, or sustained performance.

## Deliberate Non-Goals

- No canvas pixel-difference detector, machine-learned rate controller, or
  periodic profile switching.
- No copied x264 CRF/preset recipe in the browser path.
- No forced codec order until target hardware measurements identify the actual
  power-efficient encoder.
- No promise that all browsers honor `applyConstraints` or degradation
  preference identically.

## Verification Gate

Use the same static UI scene and deterministic high-motion game scene at
720p30, 1080p30, and 1080p60. Record actual capture and outbound dimensions/fps,
bitrate, `qualityLimitationReason`, codec, encoder implementation, encode time,
dropped frames, RTT, packet loss, and host CPU/GPU utilization. A live profile
change must preserve peer connection IDs, avoid a second source prompt, and
visibly converge to the requested bounds.

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
profiles before adding an application-level adaptation controller.

## Primary Sources

- [W3C MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
- [W3C WebRTC](https://www.w3.org/TR/webrtc/)
- [Chromium `motion` to libwebrtc `kFluid` bridge](https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/modules/peerconnection/media_stream_video_webrtc_sink.cc)
- [libwebrtc `motion`/`kFluid` sender classification](https://webrtc.googlesource.com/src/+/3b1eab8a69cb5078befb021c5492d3f204a7d6a2/pc/rtp_sender.cc)
- [libwebrtc encoder content-type selection](https://webrtc.googlesource.com/src/+/9caef2a8b88f389af10cee841732c42a98d3d45d/media/engine/webrtc_video_engine.cc)
- [libwebrtc conditional screen-share degradation mapping](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_stream_encoder.cc)
- [libwebrtc removal of the automatic animation-detection experiment, 2024-05-22](https://webrtc.googlesource.com/src/+/1d7d0e6e2c5002815853be251ce43fe88779ac85)
- [LiveKit screen-share presets](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts)
- [LiveKit degradation defaults](https://github.com/livekit/client-sdk-js/blob/main/src/room/participant/publishUtils.ts)
- [Jitsi desktop degradation preference](https://github.com/jitsi/lib-jitsi-meet/blob/master/modules/RTC/TraceablePeerConnection.ts)
- [Discord Go Live architecture](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology)
- [Discord encoder-quality case study](https://discord.com/blog/from-blocky-to-brilliant-improving-video-quality-on-discord-go-live-on-amd-gpus)
