# Browser Screen-Audio Quality Controls

Accessed: 2026-08-21

Status: fixed 128 kbps send ceiling accepted; user-facing codec controls remain no-go.

## Scope And Decision

This review covers audio returned with `getDisplayMedia()` and sent through a
browser `RTCPeerConnection`. It does not decide whether the product ultimately
needs Windows per-application capture; that remains a separate native-sender
requirement.

The Web sender keeps the current minimal behavior:

- request audio with `audio: true`;
- request window audio for a selected window and offer system audio for a full
  display;
- retain `contentHint = "music"` only as source intent, with no quality claim;
- treat an audio track as optional and warn before publishing when none exists;
- preserve returned audio through source changes, picture pause, P2P, relay, and
  configured SFU routes;
- apply a fixed `128000` bit/s ceiling to each browser audio sender at initial
  binding and source replacement, and the same audio preset with DTX disabled
  when publishing through the pinned LiveKit SDK;
- expose no channel-count, sample-rate, Opus bitrate, stereo, DTX, or FEC user
  control; and
- expose local, read-only audio RTP diagnostics without treating negotiated
  codec fields as source-quality facts.

The music hint is metadata, not a codec or quality mode. Chromium accepts and
reads it back, but the inspected libwebrtc audio-track interface has no matching
content-hint input to the Opus encoder. Screener therefore does not credit the
hint with a quality change. The fixed ceiling is a measured product default,
not a user control or a reason to add application-owned SDP munging. Requested,
applied, negotiated, and observed states remain separate.

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

On 2026-08-21 the production picker was user-verified to keep tab and window
audio scoped as intended in that browser environment. Current source requests
the source-appropriate window and full-display audio choices. This is one
environment observation, not a cross-browser source guarantee.

## Voice-Processing Boundary

Current Chromium constraint-selection tests cover tab, system, and desktop as
content-capture sources. With no explicit processing constraint, all three
select disabled WebRTC echo cancellation and `false` for automatic gain
control, noise suppression, experimental noise suppression, high-pass filter,
and experimental automatic gain control. `disable_local_echo` is a separate
local-playback behavior and is not an audio-processing effect. Screener only
requests display audio and does not opt these content tracks into microphone
processing.

This rules out default mic-style voice processing as the source-supported
explanation for the current Chrome result. It remains Chromium implementation
evidence rather than a portable browser guarantee; a runtime regression would
need track settings or an isolated capture fixture, not speculative processing
constraints added to `getDisplayMedia()`.

## Standard API Boundary

| Concern | Standard request or control | Honest readback | What it does not prove | Current product action |
| --- | --- | --- | --- | --- |
| Audio presence | `getDisplayMedia({ audio: true, video: ... })` expresses interest | `stream.getAudioTracks().length` proves only whether a track was returned | The browser may still return video only; a track does not identify system, window, tab, or selected-game audio | Keep the existing presence check and visible no-audio warning |
| Audio source choice | `windowAudio: "window"` asks for window audio and `systemAudio: "include"` offers system audio for monitor surfaces; a user agent may ignore either hint | There is no standard audio-source category readback corresponding to those hints | The selected audio scope, per-application isolation, or cross-browser availability | Let the picker expose the source-appropriate option without adding an inferred source label |
| Content intent | `track.contentHint = "music"` records the source intent | The assigned hint can be read back | A codec, bitrate, stereo mode, or evidence that current Chromium changed Opus encoding | Keep it as metadata only; do not use it as a quality acceptance signal |
| Voice-app exclusion | `restrictOwnAudio` concerns audio produced by the document that invoked capture; `suppressLocalAudioPlayback` concerns local playback of a captured browser surface | The app may observe whether a returned track exists, not which OS processes it contains | Excluding Discord, KOOK, WeChat, notifications, or any other independent process from system audio | Web keeps video-only available and warns that system audio may include calls/notifications; it does not claim isolation |
| Capture channels | The Screen Capture specification does not list generic `channelCount` as applicable to display audio | `track.getSettings().channelCount` may describe the returned track when the browser supplies it | That the app controlled the value, or that the RTP encoder sends stereo | Observe only in a future diagnostic; absent means unknown |
| Capture sample rate | The Screen Capture specification does not list generic `sampleRate` as applicable to display audio | `track.getSettings().sampleRate` may be present in an implementation | The Opus mode, RTP clock semantics, receiver output rate, or end-to-end fidelity | Observe only in a future diagnostic; absent means unknown |
| RTP send bitrate | `RTCRtpSender.setParameters()` can set `encodings[].maxBitrate` for audio | A following `getParameters()` can show the applied ceiling; outbound byte deltas show actual traffic | A target, minimum, audible improvement, or Opus `maxaveragebitrate`; other limits may keep traffic lower | Request a fixed 128 kbps ceiling, read it back, and retain actual bitrate as the acceptance fact |
| Codec | The user agent chooses among negotiated send codecs unless a separately negotiated codec selection is available | `RTCCodecStats.mimeType` and `sdpFmtpLine` identify the codec and negotiated format parameters in use | That Opus was selected before stats exist, or that negotiated preferences describe actual content | Label only observed negotiated data; do not force a codec |
| Stereo | No stable sender parameter controls Opus stereo | Capture settings and negotiated codec/fmtp data can be inspected separately | Capture channel count does not prove encoded stereo; `opus/48000/2` does not prove stereo content | No control and no inferred stereo badge |
| DTX | The current WebRTC `RTCRtpEncodingParameters` dictionary has no `dtx` member | No portable standard sender readback proves DTX operation | A deprecated, non-standard browser field or SDK option is not a cross-browser contract | No control |
| FEC | There is no direct, portable audio FEC on/off sender parameter | Negotiated codec/fmtp data and inbound `fecPacketsReceived`/`fecBytesReceived` may provide evidence after use | Negotiation does not prove recovery occurred; zero counters do not prove FEC was disabled | No control; retain stats only as future diagnostic evidence |

The WebRTC specification defines audio `maxBitrate` as a maximum and allows
other limits to constrain the sender further. A narrow Chrome 151 local
loopback on 2026-08-21 used a complex synthetic 48 kHz, two-channel source and
`contentHint = "music"`. With no sender ceiling, the offer selected
`audio/opus` with `minptime=10;useinbandfec=1` and sent 32.21 kbps over the
four-second measurement window. The same fixture with only
`encodings[0].maxBitrate = 128000` read back `128000` and sent 127.91 kbps;
the offer and fmtp were unchanged. This establishes that the standard setter
materially changed Chrome's encoder budget for that fixture. It does not prove
an audible improvement, stereo, a target bitrate, or equivalent behavior in
another browser or under congestion.

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
- `windowAudio` is listed as partial in Chrome 141: `"exclude"` and `"system"`
  are documented while `"window"` is not yet represented as supported in BCD;
  current Chrome deployments may differ, so runtime/user evidence stays local;
  and
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

Current libwebrtc source calculates the default full-band Opus bitrate as
32 kbps times the negotiated channel count. It derives two encoded channels
only from `stereo=1`; otherwise it configures one. That matches the narrow
Chrome observation, whose ordinary offer had no stereo fmtp and sent about
32 kbps. It is an implementation-level explanation for the tested default,
not a portable stereo or bitrate contract.

## Reference Implementations

No code was copied. All repositories were inspected at pinned commits on
2026-08-19 and their cited source pages were rechecked on 2026-08-21.

- LiveKit client-sdk-js, Apache-2.0, commit
  [`0a2110d`](https://github.com/livekit/client-sdk-js/tree/0a2110d39904a06722a0c4d1ddbb9390bb06ad4d):
  it treats
  [`getSettings().channelCount` or requested constraints](https://github.com/livekit/client-sdk-js/blob/0a2110d39904a06722a0c4d1ddbb9390bb06ad4d/src/room/participant/LocalParticipant.ts#L899-L920)
  as a stereo-input heuristic and populates standard
  `RTCRtpEncodingParameters.maxBitrate`, but stereo/DTX/RED also travel in
  LiveKit signaling. Its transport then
  [munges Opus bitrate fmtp](https://github.com/livekit/client-sdk-js/blob/0a2110d39904a06722a0c4d1ddbb9390bb06ad4d/src/room/PCTransport.ts#L269-L333)
  in SDP. The pinned 2.22.0 SDK models `audioPreset` as a `maxBitrate`, defaults
  music to 48 kbps, and keeps `forceStereo` separate. Screener uses its
  supported preset surface at 128 kbps with DTX disabled and leaves stereo to
  actual negotiation.
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

Discord and Oopz have a narrower evidence boundary:

- Discord's official Go Live architecture says its native client captures the
  selected process and child-process audio with OS-specific APIs and sends
  audio and video in separate RTP packets. Discord's public Voice protocol
  requires Opus at the protocol boundary and distinguishes a `Soundshare`
  speaking bit, but neither source publishes the exact negotiated/runtime
  audio parameters for each consumer Go Live session. This is useful native
  product evidence, not a preset Screener can copy or an excuse to infer codec
  state without stats.
- The retained read-only
  [Oopz 0.87.425 package inspection](./native-shared-encode-sender.md) found a native Agora
  RTC library, while its public help center does not publish screen-share audio
  codec, bitrate, stereo, DTX, or FEC settings. Those artifacts do not prove
  the codec or parameters used by a live Oopz session.

## Honest Diagnostics Contract

Audio diagnostics keep four layers separate:

1. **Capture:** track absent/present, plus `channelCount` and `sampleRate` only
   when the browser returns numeric values.
2. **Requested/applied:** an RTP ceiling only if Screener actually calls
   `setParameters()`, followed by immediate `getParameters()` readback.
3. **Negotiated:** current local details follow the unique audio RTP object's
   `codecId` to a same-transport `RTCCodecStats` and display MIME type, clock
   rate, channels and bounded fmtp as negotiated fields. Raw SDP/stats/fmtp are
   not uploaded or persisted.
4. **Observed:** current local details derive interval audio bitrate from byte
   deltas and interval loss from `lostDelta / (receivedDelta + lostDelta)`, and
   display reported jitter. The first sample, changed identity, reset, negative
   delta, zero denominator or absent field is unknown. Concealment, jitter
   buffer and FEC counters remain an acceptance-matrix follow-up.

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
- [libwebrtc Opus encoder](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/codecs/opus/audio_encoder_opus.cc)
- [libwebrtc media-track interface](https://webrtc.googlesource.com/src/+/refs/heads/main/api/media_stream_interface.h)
- [Chromium `MediaStreamTrack` content hint](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediastream/media_stream_track_impl.cc)
- [Chromium content-capture audio defaults](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/renderer/media/stream/media_stream_constraints_util_audio_unittest.cc)
- [LiveKit 2.22.0 track options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [RFC 7587: RTP Payload Format for Opus](https://www.rfc-editor.org/rfc/rfc7587.html)
- [RFC 7874: WebRTC Audio Codec and Processing Requirements](https://www.rfc-editor.org/rfc/rfc7874.html)
- [Discord Go Live architecture](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology)
- [Discord Voice protocol](https://docs.discord.com/developers/topics/voice-connections)
- [Oopz help center](https://help.oopz.cn/)
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
