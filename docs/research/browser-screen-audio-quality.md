# Browser Screen-Audio Quality Controls

Accessed: 2026-08-21

Status: the current integration base has route-consistent peer/SFU stereo and a
128 kbps sender ceiling, but peer answers still omit `maxaveragebitrate`, leaving
full-band stereo at libwebrtc's 64 kbps initial codec target. This slice adds the
matching 128 kbps receiver maximum; audible production evidence remains open.

## Scope And Decision

This review covers audio returned with `getDisplayMedia()` and sent through a
browser `RTCPeerConnection`. It does not decide whether the product ultimately
needs Windows per-application capture; that remains a separate native-sender
requirement.

The product keeps one screen-media audio mode rather than exposing codec
plumbing as quality controls:

- request audio with `audio: true`;
- request window audio for a selected window and offer system audio for a full
  display;
- retain `contentHint = "music"` only as source intent, with no quality claim;
- treat an audio track as optional and warn before publishing when none exists;
- preserve returned audio through source changes, picture pause, P2P, relay, and
  configured SFU routes;
- keep a `128000` bit/s sender ceiling, matching Opus stereo/maximum-average-
  bitrate receive parameters, and DTX off across Web peer and SFU routes;
- let the browser's existing WebRTC congestion control reduce actual audio and
  video traffic; do not add an application audio adaptation loop;
- expose no channel-count, sample-rate, codec, bitrate, stereo, DTX, RED, or FEC
  user control; and
- expose local, read-only audio RTP diagnostics without treating negotiated
  codec fields as source-quality facts.

The music hint is metadata, not a codec or quality mode. Chromium accepts and
reads it back, but the inspected libwebrtc audio-track interface has no matching
content-hint input to the Opus encoder. Screener therefore does not credit the
hint with a quality change. RFC 7587 and the pinned LiveKit presets, rather than
an ordinary-PC benchmark, define the 128 kbps ceiling: the RFC places full-band
stereo music in a 64--128 kbps sweet spot, and LiveKit 2.22.0 names 128 kbps
`musicHighQualityStereo`. Requested, applied, negotiated, and observed states
remain separate.

There is no audio setting or panel rename in this slice. Screen capture has one
reasonable media default, while a future microphone/voice feature would be a
separate track and processing path with its own AEC/noise-suppression/DTX
contract. It must not turn movie or game audio into a voice-processed source.

## Deployed Reports And Echo Boundary

Users reported that production
`6ccb516a47261054f91dfa2fafa408d39ced59fc` sounded poor for movie/video screen
audio. That exact release had the 128 kbps ceiling described above but no
explicit stereo contract. The current integration base has since added peer/SFU
stereo, but its peer answers still omit `maxaveragebitrate`; inspected libwebrtc
therefore starts full-band stereo at 64 kbps. This is the strongest remaining
code-level candidate, not an audible-quality measurement: capture scope, actual
fmtp/bitrate, loss, jitter and concealment still need the existing read-only
diagnostics.

The earlier delayed self-echo report on `769de201f7cc` has a different boundary:
a viewer's voice is rendered by a separate voice application on the Host,
enters the system mix, and is captured and sent back. It is source-content
leakage, not ordinary microphone acoustic echo. AEC, noise suppression, or
post-mix Web Audio cannot recover the originating process and must not be
presented as a fix.

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
| RTP send bitrate | `RTCRtpSender.setParameters()` can set `encodings[].maxBitrate` for audio; Opus `maxaveragebitrate` advertises the receiver's maximum | A following `getParameters()` can show the applied sender ceiling; negotiated fmtp shows the receiver maximum; outbound byte deltas show actual traffic | A minimum, audible improvement, or moment-to-moment rate; congestion may keep traffic lower | Pair the 128 kbps sender ceiling with the same Opus receive maximum and retain actual bitrate as the acceptance fact |
| Codec | The user agent chooses among negotiated send codecs unless a separately negotiated codec selection is available | `RTCCodecStats.mimeType` and `sdpFmtpLine` identify the codec and negotiated format parameters in use | That Opus was selected before stats exist, or that negotiated preferences describe actual content | Label only observed negotiated data; do not force a codec |
| Stereo | No stable sender parameter controls Opus stereo; RFC 7587 defines `stereo` as the receiver's one-way preference | Capture settings and negotiated codec/fmtp data can be inspected separately | Capture channel count and `opus/48000/2` do not prove encoded stereo | Use one bounded Opus answer transform on the declared Chrome/Edge baseline; no user control or inferred badge |
| DTX | The current WebRTC `RTCRtpEncodingParameters` dictionary has no `dtx` member; RFC 7587 defaults absent `usedtx` to `0` | No portable standard sender readback proves DTX operation | A deprecated browser field or SDK option is not a cross-browser contract | Keep peer default-off and set LiveKit `dtx: false`; no user control |
| FEC | There is no direct, portable audio FEC on/off sender parameter | Negotiated codec/fmtp data and inbound `fecPacketsReceived`/`fecBytesReceived` may provide evidence after use | Negotiation does not prove recovery occurred; zero counters do not prove FEC was disabled | No control; retain stats only as future diagnostic evidence |

The WebRTC specification defines audio `maxBitrate` as a maximum and allows
other limits to constrain the sender further. A retained Chrome 151 loopback
showed only that the browser applied `maxBitrate` and changed its encoder budget
for that synthetic fixture; the ordinary PC, short interval and synthetic
source are not calibration evidence. RFC 7587's full-band stereo music range
and the pinned LiveKit preset justify the product value. Audible quality,
actual traffic and congestion behavior remain runtime observations.

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
only from `stereo=1`, so stereo without `maxaveragebitrate` starts from a
64 kbps codec bitrate. `RTCRtpSender.maxBitrate=128000` only caps the allocator;
it does not raise that codec configuration. When present, libwebrtc maps the
negotiated `maxaveragebitrate` value into the Opus encoder bitrate config before
normal congestion adaptation. This is implementation evidence for the current
Chrome/Edge baseline, while the RFC still defines the parameter as a receiver
maximum rather than a minimum or continuous bitrate guarantee.

The poor movie/music report against production `6ccb516` is consistent with its
historical state. That release and its pre-stereo source set a 128 kbps sender
ceiling, but Web peer negotiation did not request stereo; the SFU publisher set
`dtx: false` while inheriting `forceStereo: false` and `red: true`. That
mono-by-default contract is no longer current. The present integration base
already upserts peer `stereo=1` and publishes SFU audio with `forceStereo: true`,
`dtx: false`, and RED retained. Its remaining peer-specific gap is the absent
`maxaveragebitrate`: libwebrtc starts stereo at 64 kbps despite the 128 kbps
sender ceiling. This slice adds the matching receiver maximum. Capture/source
loss, packet loss, jitter and concealment can still degrade audio and remain
separate diagnostic facts.

## Reference Implementations

No code was copied. All repositories were inspected at pinned commits on
2026-08-19 and their cited source pages were rechecked on 2026-08-21.

- LiveKit client-sdk-js 2.22.0, Apache-2.0, commit
  [`0a2110d`](https://github.com/livekit/client-sdk-js/tree/0a2110d39904a06722a0c4d1ddbb9390bb06ad4d):
  it treats
  [`getSettings().channelCount` or requested constraints](https://github.com/livekit/client-sdk-js/blob/0a2110d39904a06722a0c4d1ddbb9390bb06ad4d/src/room/participant/LocalParticipant.ts#L899-L920)
  as a stereo-input heuristic and populates standard
  `RTCRtpEncodingParameters.maxBitrate`, but stereo/DTX/RED also travel in
  LiveKit signaling. Its transport then
  [munges Opus bitrate fmtp](https://github.com/livekit/client-sdk-js/blob/0a2110d39904a06722a0c4d1ddbb9390bb06ad4d/src/room/PCTransport.ts#L269-L333)
  in SDP. Its room defaults are music 48 kbps, DTX on, RED on and
  `forceStereo: false`; its named presets include stereo music at 64 kbps and
  high-quality stereo music at 128 kbps. Per-track options merge after those
  defaults. Its stereo-only `??=` fallback disables DTX/RED only if still
  undefined, which the pinned room defaults are not. Screener's historical
  pre-stereo source overrode DTX but not `forceStereo` or RED, yielding mono,
  DTX off and RED on.
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

The Apache and MIT implementations support the same conclusion: one narrow,
structured Opus fmtp transform is established practice, but it is still an
application-owned negotiation contract rather than a portable sender setter.
`sdp-transform` 2.15.0 is MIT-licensed and already arrives transitively through
LiveKit. Runtime code that imports it must declare it directly, together with
its TypeScript types, rather than depend on LiveKit's dependency graph.
As supplementary practice evidence, historical
[LiveKit server issue 970](https://github.com/livekit/livekit/issues/970) and
the 2026 [Rust SDK issue 1018](https://github.com/livekit/rust-sdks/issues/1018)
both report stereo sources arriving as mono when the product/SDK did not signal
stereo. Issue reports are not treated as normative behavior or as proof of
Screener's runtime state; pinned source and local stats remain authoritative.

Discord and Oopz have a narrower evidence boundary:

- Discord's official Go Live architecture says its native client captures the
  selected process and child-process audio with OS-specific APIs and sends
  audio and video in separate RTP packets. Discord's public Voice protocol
  requires Opus at the protocol boundary and distinguishes a `Soundshare`
  speaking bit, but neither source publishes the exact negotiated/runtime
  audio parameters for each consumer Go Live session. This is useful native
  product evidence, not a preset Screener can copy or an excuse to infer codec
  state without stats.
- Oopz's official help separates program-audio screen sharing from voice
  channels: it documents Windows program-audio capture, while separate voice
  articles expose channel quality/latency choices and microphone AI noise
  suppression. The retained read-only
  [Oopz 0.87.425 package inspection](./native-shared-encode-sender.md) found a
  native Agora RTC library, program/system screen-audio switches, and Agora
  profile symbols including high-quality stereo music and game-streaming
  scenarios. This proves only separate native capture/voice/profile surfaces.
  Neither the package nor public help proves the active screen-share codec,
  bitrate, stereo, DTX, FEC or Agora profile; those values remain unknown.

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

## Minimal Route-Consistent Runtime Slice

The source-complete runtime slice changes negotiation, not capture or congestion
control:

1. Keep `contentHint = "music"`, one audio track and the existing 128 kbps
   sender ceiling. Do not add Web Audio mixing, resampling, a second audio
   representation or a new rate controller.
2. On every Web Viewer answer, including ICE restart/rebuild answers, parse SDP
   with direct dependencies on MIT-licensed `sdp-transform` 2.15.0 and its
   TypeScript declarations. Select the single non-rejected audio media section,
   resolve its Opus payload from structured `rtp` entries, and idempotently
   upsert `stereo=1` plus `maxaveragebitrate=128000` in that payload's fmtp before both
   `setLocalDescription()` and signaling the same description. Preserve every
   other media section, codec, fmtp key and session attribute. Empty SDP, no
   unambiguous active audio/Opus payload, multiple active audio sections,
   malformed fmtp, or parser/write failure returns the original answer object
   and SDP unchanged. This keeps a browser-generated mono/video answer usable;
   no broad regex or malformed partial answer is allowed. RFC 7587 makes stereo
   an optional receive preference, while W3C guarantees the unmodified
   `createAnswer()` remains usable by `setLocalDescription()`.
3. Do not add `sprop-stereo`: RFC 7587 defines it as a sender-likelihood hint,
   not the receiver preference that permits the remote encoder to send stereo,
   and offer/answer parameters are orthogonal. Do not add `usedtx=0`; absent
   `usedtx` already means off. `maxaveragebitrate=128000` is the receiver maximum
   matching Screener's sender ceiling and pinned LiveKit preset, not a minimum;
   stock congestion control can still lower actual traffic. Keep the browser's
   existing `useinbandfec` negotiation untouched.
4. For SFU publication use LiveKit 2.22.0
   `AudioPresets.musicHighQualityStereo`, `forceStereo: true` and `dtx: false`.
   Do not override the pinned room default `red: true`. RED and Opus in-band FEC
   are distinct repair mechanisms; retaining one neither proves, replaces nor
   disables the other, and no FEC switch is exposed or reimplemented.

Applying the receive preference in every browser answer covers direct P2P,
browser-relay children and selected-edge TURN because TURN changes the ICE
transport, not the peer SDP contract. SFU uses the equivalent SDK contract.
An SFU-only change is not acceptable: moving between peer and SFU routes would
otherwise change channel behavior. Native/Pion sender routes retain their own
explicit encoded-track contract and need a focused compatibility check before
claiming the same result.

At the fixed ceiling, audio contributes at most 128 kbps RTP payload per active
outbound edge, or 256 kbps for the current two-child endpoint cap, excluding
RTP/SRTP/UDP/IP overhead. A Host SFU publication contributes one such ingress;
each root/peer forward still sends its own copy. This is small beside the
current 3--8 Mbps video presets, but stereo can use more encoder work and
bandwidth than mono. No second track or representation is added, and browser
relays still make no shared-encoder promise.

Preserve the existing persistent Viewer `MediaStream`/media element and add or
remove its audio/video tracks in place. Introducing a separate audio element or
Web Audio graph would create a new clock/buffering boundary and is outside this
fix; the stable stream already deployed is the A/V synchronization baseline.

The implementation budget is deliberately bounded to dependency
manifest/lockfile entries, one SDP helper, `ViewerPeer` answer wiring, SFU
publisher options, focused unit/integration tests and the owning docs. Parser
tests cover CRLF serialization, an existing/missing fmtp line, exact stereo and
bitrate replacement, unknown fmtp preservation, idempotence, payload-number
lookup, rejected/non-audio sections, and identity-preserving fallback for empty
SDP, no/ambiguous Opus, duplicate targets, and parser exceptions. Peer tests
prove the exact selected answer is both applied and
signaled on initial/restart/rebuild paths; SFU tests assert the three explicit
options and absence of a RED override. One Chrome/Edge left/right fixture checks
channel correctness and a P2P/SFU route switch checks the persistent stream;
neither is a performance benchmark or parameter-calibration gate.

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

## UI And Voice Revisit Gate

Do not rename “高级视频设置” or add an audio control in this slice. One screen
media default is simpler and the browser already adapts actual traffic below
the ceiling. Revisit a single bounded “省流/高保真” choice only if sanitized
production stats establish that 128 kbps audio materially blocks a real target
network while video adaptation cannot preserve the core path. Do not expose
sample rate, channel count, codec, DTX, RED, FEC or an arbitrary bitrate slider.

If microphone voice enters scope, treat it as a separate source/track with an
independent privacy, AEC, noise-suppression, gain and DTX design. Oopz's public
product surfaces support that separation but do not supply parameters that can
be copied into Screener's screen-media path.

## Primary Sources

- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
- [W3C WebRTC](https://www.w3.org/TR/webrtc/)
- [W3C WebRTC Priority Control](https://www.w3.org/TR/webrtc-priority/)
- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [W3C Web Audio](https://www.w3.org/TR/webaudio-1.1/)
- [W3C WebCodecs Opus registration](https://www.w3.org/TR/webcodecs-opus-codec-registration/)
- [libwebrtc Opus encoder](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/codecs/opus/audio_encoder_opus.cc)
- [libwebrtc media-track interface](https://webrtc.googlesource.com/src/+/refs/heads/main/api/media_stream_interface.h)
- [Chromium `MediaStreamTrack` content hint](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediastream/media_stream_track_impl.cc)
- [Chromium content-capture audio defaults](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/renderer/media/stream/media_stream_constraints_util_audio_unittest.cc)
- [LiveKit 2.22.0 track options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [LiveKit 2.22.0 publish defaults](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/defaults.ts)
- [LiveKit 2.22.0 local publication](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/LocalParticipant.ts)
- [LiveKit 2.22.0 package dependencies](https://github.com/livekit/client-sdk-js/blob/v2.22.0/package.json)
- [Jitsi Opus SDP transform, pinned commit](https://github.com/jitsi/lib-jitsi-meet/blob/63a04ecabd972ea75e877f9ba12086c13cb68210/modules/RTC/TPCUtils.ts)
- [`sdp-transform` 2.15.0](https://github.com/clux/sdp-transform/tree/v2.15.0)
- [RFC 7587: RTP Payload Format for Opus](https://www.rfc-editor.org/rfc/rfc7587.html)
- [RFC 7874: WebRTC Audio Codec and Processing Requirements](https://www.rfc-editor.org/rfc/rfc7874.html)
- [Discord Go Live architecture](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology)
- [Discord Voice protocol](https://docs.discord.com/developers/topics/voice-connections)
- [Oopz program/screen audio help](https://help.oopz.cn/42f9/54e2)
- [Oopz voice quality/latency help](https://help.oopz.cn/42f9/3020)
- [Oopz microphone-noise help](https://help.oopz.cn/42f9/f5ae)
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
