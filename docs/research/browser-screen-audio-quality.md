# Browser Screen-Audio Quality Controls

Accessed: 2026-08-19

Status: retained no-go for user-facing browser audio quality controls.

## Scope And Decision

This review covers audio returned with `getDisplayMedia()` and sent through a
browser `RTCPeerConnection`. It does not decide whether the product ultimately
needs Windows per-application capture; that remains a separate native-sender
requirement.

The Web sender keeps the current minimal behavior:

- request audio with `audio: true`;
- treat an audio track as optional and warn before publishing when none exists;
- preserve returned audio through source changes, picture pause, P2P, relay, and
  configured SFU routes; and
- expose no channel-count, sample-rate, Opus bitrate, stereo, DTX, or FEC
  quality control.

No codec-quality control is justified yet. In particular, Screener will not add
application-owned SDP munging or a control whose value cannot be separated into
requested, applied, negotiated, and observed states using standard APIs. The
deployed reports below do justify an explicit source-scope acceptance gate and
a later native process-audio candidate; neither is a bitrate knob.

## Deployed Reports And Echo Boundary

Users report poor movie/video audio and delayed self-echo when production
`769de201f7cc` captures whole-system audio while a voice application is active.
These reports apply to that deployed release and remain unclassified until the
same fixture compares it with current `main`. The release sets no application
audio bitrate, channel, sample-rate, or SDP option; its Host preview is muted,
and peer/SFU relay is disabled. Therefore the current evidence does not point
to an application ceiling, Host preview playback, or relay re-encoding.

The echo case is source-content leakage: a viewer's voice is rendered by a
separate voice application on the Host, enters the system mix, and is captured
and sent back. It is not ordinary microphone acoustic echo. AEC, noise
suppression, or post-mix Web Audio cannot recover the originating process and
must not be presented as a fix.

## Standard API Boundary

| Concern | Standard request or control | Honest readback | What it does not prove | Current product action |
| --- | --- | --- | --- | --- |
| Audio presence | `getDisplayMedia({ audio: true, video: ... })` expresses interest | `stream.getAudioTracks().length` proves only whether a track was returned | The browser may still return video only; a track does not identify system, window, tab, or selected-game audio | Keep the existing presence check and visible no-audio warning |
| Audio source choice | `systemAudio`, `windowAudio`, and `audioSelection` are picker hints that a user agent may ignore | There is no standard audio-source category readback corresponding to those hints | The selected audio scope, per-application isolation, or cross-browser availability | Do not present these hints as quality or source guarantees |
| Voice-app exclusion | `restrictOwnAudio` concerns audio produced by the document that invoked capture; `suppressLocalAudioPlayback` concerns local playback of a captured browser surface | The app may observe whether a returned track exists, not which OS processes it contains | Excluding Discord, KOOK, WeChat, notifications, or any other independent process from system audio | Web keeps video-only available and warns that system audio may include calls/notifications; it does not claim isolation |
| Capture channels | The Screen Capture specification does not list generic `channelCount` as applicable to display audio | `track.getSettings().channelCount` may describe the returned track when the browser supplies it | That the app controlled the value, or that the RTP encoder sends stereo | Observe only in a future diagnostic; absent means unknown |
| Capture sample rate | The Screen Capture specification does not list generic `sampleRate` as applicable to display audio | `track.getSettings().sampleRate` may be present in an implementation | The Opus mode, RTP clock semantics, receiver output rate, or end-to-end fidelity | Observe only in a future diagnostic; absent means unknown |
| RTP send bitrate | `RTCRtpSender.setParameters()` can set `encodings[].maxBitrate` for audio | A following `getParameters()` can show the applied ceiling; outbound byte deltas show actual traffic | A target, minimum, quality increase, or Opus `maxaveragebitrate`; other limits may keep traffic lower | Do not add a control without a measured need to reduce audio bandwidth |
| Codec | The user agent chooses among negotiated send codecs unless a separately negotiated codec selection is available | `RTCCodecStats.mimeType` and `sdpFmtpLine` identify the codec and negotiated format parameters in use | That Opus was selected before stats exist, or that negotiated preferences describe actual content | Label only observed negotiated data; do not force a codec |
| Stereo | No stable sender parameter controls Opus stereo | Capture settings and negotiated codec/fmtp data can be inspected separately | Capture channel count does not prove encoded stereo; `opus/48000/2` does not prove stereo content | No control and no inferred stereo badge |
| DTX | The current WebRTC `RTCRtpEncodingParameters` dictionary has no `dtx` member | No portable standard sender readback proves DTX operation | A deprecated, non-standard browser field or SDK option is not a cross-browser contract | No control |
| FEC | There is no direct, portable audio FEC on/off sender parameter | Negotiated codec/fmtp data and inbound `fecPacketsReceived`/`fecBytesReceived` may provide evidence after use | Negotiation does not prove recovery occurred; zero counters do not prove FEC was disabled | No control; retain stats only as future diagnostic evidence |

The one technically portable write, audio `maxBitrate`, is not a quality-up
knob. The WebRTC specification defines it as a maximum and allows other limits
to constrain the sender further. It also warns that an audio ceiling below the
chosen encoding's needs may require playback to stop. Leaving it unset already
avoids an application-imposed ceiling, so adding a higher value cannot promise
better game audio.

## Capture And Browser Compatibility

The Screen Capture Working Draft says constraints are applied only after the
user chooses a surface and that `getUserMedia()` constraints do not apply to
display tracks unless this specification lists them. The only audio
constrainable properties it currently lists are `restrictOwnAudio` and
`suppressLocalAudioPlayback`; neither controls fidelity. It explicitly permits
a browser to return no audio despite an audio request.

MDN browser-compatibility data on the access date reports:

- display-audio capture in Chromium from Chrome 74, with whole-system audio on
  Windows and ChromeOS but tab-only audio on Linux and macOS;
- no display-audio capture support in Firefox or Safari;
- `systemAudio` in desktop Chromium from Chrome 105, but not Firefox or Safari;
- `windowAudio` only partially implemented in Chrome 141: `"exclude"` and
  `"system"` are supported, while `"window"` is not; and
- `MediaTrackSettings.channelCount` as non-Baseline because it is missing in
  widely used browsers.

These are an implementation snapshot, not permanent product guarantees.
Chromium's own capture documentation also separates Windows/ChromeOS system
loopback capture from tab capture. It publishes no stable Web contract for a
fixed display-audio sample rate or channel count.

`encodings[].maxBitrate` has much broader compatibility: MDN data records
Chrome 69, Firefox 46, and Safari 11. The old `encodings[].dtx` field is absent
from Chrome and Firefox, present only as a deprecated non-standard Safari
feature, and absent from the current WebRTC IDL.

## Opus Signaling Is Not Source Truth

WebRTC endpoints must implement Opus, but negotiation may select another
mandatory audio codec. The application must wait for the in-use codec stats
before calling a stream Opus.

RFC 7587 requires an Opus SDP `a=rtpmap` clock rate of 48000 and channel count
of 2 for all Opus sessions. It separately explains that actual Opus media may
use another internal sampling rate. Therefore `audio/opus`, `clockRate=48000`,
and `channels=2` in codec stats do not establish a 48 kHz stereo capture or
stereo payload.

Opus `maxaveragebitrate`, `stereo`, `useinbandfec`, and `usedtx` are fmtp
offer/answer parameters. `stereo` is a receive preference, while
`sprop-stereo` is only a sender hint and explicitly not a guarantee. A browser
API that merely exposes the negotiated `sdpFmtpLine` can report those facts,
but does not provide a portable setter or prove the encoder's moment-to-moment
behavior.

## Reference Implementations

No code was copied. All repositories were inspected at pinned commits on
2026-08-19.

- LiveKit client-sdk-js, Apache-2.0, commit
  [`0a2110d`](https://github.com/livekit/client-sdk-js/tree/0a2110d39904a06722a0c4d1ddbb9390bb06ad4d):
  it treats
  [`getSettings().channelCount` or requested constraints](https://github.com/livekit/client-sdk-js/blob/0a2110d39904a06722a0c4d1ddbb9390bb06ad4d/src/room/participant/LocalParticipant.ts#L899-L920)
  as a stereo-input heuristic and populates standard
  `RTCRtpEncodingParameters.maxBitrate`, but stereo/DTX/RED also travel in
  LiveKit signaling. Its transport then
  [munges Opus bitrate fmtp](https://github.com/livekit/client-sdk-js/blob/0a2110d39904a06722a0c4d1ddbb9390bb06ad4d/src/room/PCTransport.ts#L269-L333)
  in SDP.
- lib-jitsi-meet, Apache-2.0, commit
  [`63a04ec`](https://github.com/jitsi/lib-jitsi-meet/tree/63a04ecabd972ea75e877f9ba12086c13cb68210):
  [`mungeOpus()`](https://github.com/jitsi/lib-jitsi-meet/blob/63a04ecabd972ea75e877f9ba12086c13cb68210/modules/RTC/TPCUtils.ts#L871-L929)
  writes `stereo`, `sprop-stereo`, `maxaveragebitrate`, and `usedtx` into SDP,
  including a Firefox-specific DTX exception.
- simple-peer, MIT, commit
  [`f1a492d`](https://github.com/feross/simple-peer/tree/f1a492d1999ce727fa87193ebdea20ac89c1fc6d):
  it has no higher-level audio quality contract and exposes only an advanced
  generic
  [`sdpTransform`](https://github.com/feross/simple-peer/blob/f1a492d1999ce727fa87193ebdea20ac89c1fc6d/index.js#L608-L664)
  hook for SDP changes.

The Apache and MIT implementations support the same conclusion: a library can
offer product-specific audio modes, but the stereo/DTX/FEC/Opus-fmtp portion is
not equivalent to a portable browser sender control.

## Honest Future Diagnostics

If audio diagnostics become necessary, keep four layers separate:

1. **Capture:** track absent/present, plus `channelCount` and `sampleRate` only
   when the browser returns numeric values.
2. **Requested/applied:** an RTP ceiling only if Screener actually calls
   `setParameters()`, followed by immediate `getParameters()` readback.
3. **Negotiated:** the in-use codec MIME type and bounded derived fmtp evidence
   from `RTCCodecStats`, labelled as negotiated parameters rather than actual
   stereo/DTX/FEC; raw SDP/fmtp is not uploaded or persisted.
4. **Observed:** interval audio bitrate from byte deltas and receiver FEC
   counters when implemented; missing values remain unknown.

Never substitute `48000`, `2`, `false`, or `0` for an unavailable field.

## Native Windows Process-Audio Candidate

The smallest honest native path is Windows WASAPI application loopback through
`ActivateAudioInterfaceAsync` and `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` with
`INCLUDE_TARGET_PROCESS_TREE`. After the user selects a game window, the sender
resolves its PID locally and captures that process plus children. The API's
minimum build 20348 is not available on ordinary Windows 10 22H2 (19045), so
the current product candidate covers Windows 11 only. Windows 10 game-only
audio remains unresolved or explicitly unsupported until another bounded path
passes.

Default native behavior is game-only. Whole-system audio requires an explicit
choice. No render stream, process exit, or capture failure produces a visible
silent/failed state and never widens capture to the whole system. Excluding one
known voice process is not a sufficient default because other calls,
notifications, or browser audio could still leak. Protected content may be
absent and an exclusive/no-render path may yield silence rather than a
classifiable error; the sender reports silence or unknown and never bypasses
protection. PID, path, window title, device identity, and raw audio remain local
and are not retained or uploaded.

Run one bounded matrix rather than a full route Cartesian product: exact
production and current `main` on Windows Chrome/Edge for tab/window/monitor,
audio selected/unselected, and a simultaneous voice call; then the native
candidate on current Windows 11 with game parent and child audio, an independent
voice process, notifications, no render stream, and process restart. Windows 10
records the explicit unsupported/unresolved result rather than a fake fallback.
Direct is the primary route; one browser-relay and one
SFU-root audio check cover route preservation, while selected-edge TURN needs
only one post-SFU connectivity smoke. Correlate capture settings, negotiated codec/derived fmtp,
actual outbound/inbound bitrate, loss, jitter, concealment, jitter buffer, and
A/V playout timing using a distinguishable stereo fixture plus game/film audio.

## Deferred Android Application-Audio Candidate

This is a P2 input for the later Android 14/API 34+ native sender, not a current
Web or Windows requirement. Android's `AudioPlaybackCapture` API can constrain
captured playback with `addMatchingUid()` when the target UID is already known,
or with `addMatchingUsage()` for eligible usages. The source player still must
use `USAGE_MEDIA`, `USAGE_GAME`, or `USAGE_UNKNOWN`, run in the same user
profile, and permit capture under its manifest/runtime/player policy. The capture
app also needs `RECORD_AUDIO` permission and an approved `MediaProjection`
session. The most restrictive source policy wins, so silence or refusal is a
valid result and must not trigger a whole-system fallback.

Android 14 QPR2's system `MediaProjection` picker can limit video to one selected
app window. However, the public API 34 result contract passes the consent result into
`getMediaProjection()` and documents only a projection grant; it does not
promise the capturing app the selected package or UID. It is therefore an
inference, not an API guarantee, that the video selection can be associated with
the UID required by `addMatchingUid()`. Screener must separately prove the
selected-app-video plus selected-app-audio pairing on target devices with an
independently established UID, or keep that mode unsupported. Usage-only
filtering is broader and cannot be relabeled as per-app isolation.

The bounded audio gate covers a known target UID, an unknown picker target,
`USAGE_GAME`/`USAGE_MEDIA`, source opt-out, no active render stream, process
restart, voice/notification leakage, secure/protected video, rotation, lock-stop,
thermal load, one/two Web viewers, and A/V sync. Missing audio remains a visible
silent/unsupported state. PID/UID/package, source labels, raw audio, and device
identity stay local and are not retained or uploaded.

## Revisit Gates

Add a user-facing audio setting only when all of these are true:

1. A real Windows game/system-audio matrix identifies a reproducible user
   problem and a desired outcome, such as a measured bandwidth reduction.
2. The setting uses a standards-track API without SDP munging or private
   signaling and is supported across the declared sender-browser matrix.
3. The app can read back the applied value and separately observe the
   negotiated codec and actual traffic or recovery behavior.
4. A controlled audible stereo/frequency fixture and packet-loss test shows
   the intended result without silence, channel collapse, or route-specific
   divergence.

## Primary Sources

- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
- [W3C WebRTC](https://www.w3.org/TR/webrtc/)
- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [W3C Web Audio](https://www.w3.org/TR/webaudio-1.1/)
- [RFC 7587: RTP Payload Format for Opus](https://www.rfc-editor.org/rfc/rfc7587.html)
- [RFC 7874: WebRTC Audio Codec and Processing Requirements](https://www.rfc-editor.org/rfc/rfc7874.html)
- [MDN `getDisplayMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [MDN `MediaTrackSettings.channelCount`](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/channelCount)
- [MDN Browser Compatibility Data: `MediaDevices`](https://github.com/mdn/browser-compat-data/blob/main/api/MediaDevices.json)
- [MDN Browser Compatibility Data: `RTCRtpSender`](https://github.com/mdn/browser-compat-data/blob/main/api/RTCRtpSender.json)
- [Chrome screen-sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls)
- [Chrome 141 window-audio release note](https://developer.chrome.com/release-notes/141)
- [Chromium media-capture architecture index](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/media/capture/)
- [Microsoft Application Loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [Windows process-loopback parameters](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)
- [Windows 10 release information](https://learn.microsoft.com/en-us/windows/release-health/release-information)
- [Microsoft WASAPI loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- [Android capture video and audio playback](https://developer.android.com/media/platform/av-capture)
- [Android `AudioPlaybackCaptureConfiguration.Builder`](https://developer.android.com/reference/android/media/AudioPlaybackCaptureConfiguration.Builder)
- [Android `MediaProjectionManager`](https://developer.android.com/reference/android/media/projection/MediaProjectionManager)
- [Android media projection](https://developer.android.com/media/grow/media-projection)
- [Android secure-window capture boundary](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_SECURE)
