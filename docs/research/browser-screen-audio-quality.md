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

### P1 Audio-Only Wiring Slice

The first native implementation is intentionally an audio-only input and is
estimated at 500--800 new lines. It keeps the current Web video capture and
codec path, while a Windows 11 helper supplies process-tree PCM through the
existing authenticated local bridge. Chrome/Edge's already-required WebCodecs
surface encodes that PCM with `AudioEncoder` (`opus`, 48 kHz, two channels,
20 ms), so the helper does not add a native Opus dependency or a second package
toolchain. The Go sender packetizes the returned Opus access units once into a
shared `audio/opus` RTP track before adding it to each native PeerConnection.

The local envelope carries only media kind, flags, QPC-derived timestamp,
duration, and bounded payload; no PID or source label crosses the bridge. WGC
video remains a fixture/next adapter in this slice. Its
`SystemRelativeTime`, like WASAPI `GetBuffer`'s `pu64QPCPosition`, is a 100-ns
QPC value and is retained as the future A/V synchronization origin. Audio
timestamps are converted to the 48 kHz RTP clock and remain monotonic; packet
duration comes from the captured frame count rather than arrival time.

This is an opt-in P1 candidate, not a default or production switch. Windows 10,
picker/activation denial, an exited or inaccessible target, no render stream,
protected-content silence, and WASAPI device/service errors report
`unavailable`/`silent` and stop or ask. The implementation never widens to
whole-system loopback. The first acceptance smoke is one direct Viewer with a
known target tone/visual marker and independent voice/notification markers;
SFU/TURN, a second Viewer, endurance, and native WGC video replacement remain
later gates.

### Retained P1 Result (2026-08-21)

The source-complete Windows helper emits process-tree-only 48 kHz stereo s16 in
20-ms chunks. Chrome 151 encodes the chunks once with `AudioEncoder`/Opus, and
Go packetizes the same encoded stream once into a shared Pion track. The UI
receives an opaque memory-only target ID. PID and the enumeration-time process
creation token are revalidated locally and never enter public signaling, a URL,
storage, or diagnostics.

One bounded run played 440 Hz in the selected target and 880 Hz in an
independent process. Across 100 chunks, amplitudes were 0.240225 and 0.0000598
(4017.8x); no system-mix fallback was used. One direct Viewer then received one
audio track and 495 inbound Opus packets while video decoded/rendered 296
frames. There was no fatal or encoder error. The sole failed assertion was the
existing generic Pion two-second outbound snapshot, which also missed fresh
deltas in earlier video loopbacks. This is functional evidence, not packaging,
real-game sync, second-Viewer, SFU/TURN, or endurance evidence.

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

## Android Application-Audio Source Slice (2026-08-21)

Android's official `AudioPlaybackCapture` contract requires `RECORD_AUDIO`, an
approved `MediaProjection`, the same user profile, a capturable source policy,
and player usage `USAGE_UNKNOWN`, `USAGE_MEDIA`, or `USAGE_GAME`. A builder may
combine `addMatchingUid()` and matching usages; Screener uses both so the source
cannot widen beyond the explicitly selected UID. The UI only lists launcher
targets whose UID maps to one package, because an Android UID may otherwise be
shared. Protected/opt-out apps and players without eligible active playback
usually produce silence rather than a read error. Silence is a valid bounded
result and never triggers microphone or whole-system fallback.

Android 14 QPR2's system picker can limit video to one selected app, but public
API 34 returns only the projection consent result. `MediaProjection` exposes
stop, resize and visibility callbacks, not the selected package or UID. Screener
therefore defaults audio to off and makes the audio target a separate explicit
choice before opening the system video picker. Its visible copy says the two
choices may differ. The app never calls usage-only capture and never labels this
as automatic same-app capture.

The fixed `io.github.webrtc-sdk:android:144.7559.12` AAR exposes the required
public extension points without a fork or JNI: `PeerConnectionFactory.Builder`
has `setAudioDeviceModule(AudioDeviceModule)`, `JavaAudioDeviceModule.Builder`
has `setAudioBufferCallback(AudioBufferCallback)`, and the module has
`setAudioRecordEnabled(false)`. The callback receives the ADM's 10 ms direct
buffer. Inspection of that exact artifact shows that a disabled platform input
is zero-filled and still passed through the callback before native delivery, so
one blocking playback `AudioRecord` can pace and replace the buffer. Screener
uses PCM16, 48 kHz mono, raw audio processing, one `AudioSource`/`AudioTrack`, and
attaches that track to no more than the two controller-authorized direct
children. It changes no server/Viewer wire and leaves SFU/selected-edge TURN as
the existing bounded failure. This proves one capture source/track, not one
physical Opus encoder across PeerConnections.

The inspected AAR SHA-256 is
`D1564A43A85D0687DB51862A590263C6764F9AC8F87E7960B1E9C9F222B898AA`; its
`classes.jar` SHA-256 is
`D20DFD0C0BBEDCCB46354174829B0315E6922D05779291A60DACEA826098CDA4`, and tag
`v144.7559.12` resolves to `500cadca96fa4be0fb5951c046fd611be181490c`.
The Maven POM records BSD-3-Clause for the artifact; the packaging repository is
MIT and bundled upstream libwebrtc retains BSD/PATENTS terms. LiveKit's
Apache-2.0 `ScreenAudioCapturer` was studied as a mature use of the same callback
and playback-capture API; no implementation was copied.

Official playback-capture documentation requires `RECORD_AUDIO` plus an approved
`MediaProjection` token. Android 14's FGS documentation assigns
`mediaProjection` to content captured through `MediaProjection`, while the
`microphone` type is described as continuing microphone capture. Screener uses
only `FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION`; it does not request
`FOREGROUND_SERVICE_MICROPHONE` or declare a microphone service type. There is a
retained implementation-evidence conflict: LiveKit's pinned playback capturer
states that background screen audio needs a microphone-typed FGS or returns no
audio, while also showing that its ADM microphone may be disabled. Android's
official playback-capture and API 34 FGS pages do not state that playback capture
needs that additional type. This source slice follows the narrower official
capability boundary; switching to the selected app must therefore verify
background audio on-device before any support claim. A silent result does not
authorize enabling microphone capture or adding the extra FGS capability without
a separate permission-policy decision. The ADM microphone `AudioRecord` remains
disabled in every case.

The source slice passed `:protocol:test` and `:app:assembleDebug`; no device or
audible-media claim follows. Track creation/status means only “selected UID
playback requested.” A silence detector is P2 and does not expand this slice.
Device proof still covers eligible and opt-out apps, protected content, no
active render stream, voice/notification non-leakage, process restart, lock/stop,
one/two Web Viewers and A/V synchronization. UID/package labels stay local and
raw audio is never retained or uploaded outside the WebRTC media track.

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
- [W3C WebCodecs Opus registration](https://www.w3.org/TR/webcodecs-opus-codec-registration/)
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
- [Microsoft `ActivateAudioInterfaceAsync`](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-activateaudiointerfaceasync)
- [Windows process-loopback parameters](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)
- [Microsoft Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [Microsoft `IAudioCaptureClient::GetBuffer`](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer)
- [Windows 10 release information](https://learn.microsoft.com/en-us/windows/release-health/release-information)
- [Microsoft WASAPI loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- [Android capture video and audio playback](https://developer.android.com/media/platform/av-capture)
- [Android `AudioPlaybackCaptureConfiguration.Builder`](https://developer.android.com/reference/android/media/AudioPlaybackCaptureConfiguration.Builder)
- [Android `MediaProjectionManager`](https://developer.android.com/reference/android/media/projection/MediaProjectionManager)
- [Android media projection](https://developer.android.com/media/grow/media-projection)
- [Android foreground-service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Android 14 foreground-service type requirement](https://developer.android.com/about/versions/14/changes/fgs-types-required)
- [Android secure-window capture boundary](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_SECURE)
- [`webrtc-sdk/android` v144.7559.12](https://github.com/webrtc-sdk/android/tree/v144.7559.12)
- [Maven Central `io.github.webrtc-sdk:android:144.7559.12`](https://central.sonatype.com/artifact/io.github.webrtc-sdk/android/144.7559.12)
- [LiveKit Android `ScreenAudioCapturer` at inspected commit](https://github.com/livekit/client-sdk-android/blob/4fdea28d8bd4b7053d7e5f0df50527f2c51fd38f/livekit-android-sdk/src/main/java/io/livekit/android/audio/ScreenAudioCapturer.kt)
- [LiveKit Android screen-audio foreground-service example](https://github.com/livekit/client-sdk-android/blob/4fdea28d8bd4b7053d7e5f0df50527f2c51fd38f/examples/screenshare-audio/src/main/java/io/livekit/android/example/screenshareaudio/MainViewModel.kt)
- [LiveKit Android Apache-2.0 license](https://github.com/livekit/client-sdk-android/blob/4fdea28d8bd4b7053d7e5f0df50527f2c51fd38f/LICENSE)
