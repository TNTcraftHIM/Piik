# Browser Screen-Audio Quality

- Research date: 2026-08-25
- Scope: Browser game/movie screen audio over P2P, relay, and LiveKit SFU
- Status: current Browser contract implemented and deployed; heterogeneous
  devices and real-game A/V synchronization remain open

## Current Conclusion

Screener requests display audio by default on initial capture and source switch.
If the browser, selected source, operating system, or user returns no audio
track, video sharing continues with an explicit warning.

One screen-audio track uses `contentHint = "music"`. Capture requests ideal
stereo and disables echo cancellation, noise suppression, automatic gain, and
voice isolation where the browser supports those constraints. These are
preferences and readback fields, not portable fidelity guarantees.

The only user-facing audio-quality choices are sender ceilings of 64, 128, and
256 kbps, with 128 kbps as the default. They update live on current P2P,
Browser-relay, and SFU senders and apply to future senders. Actual RTP traffic
can remain below a ceiling because of content and congestion, and includes
transport behavior not represented by the selected number.

## Peer Contract

Direct and Browser-relay Viewer answers use one structured `sdp-transform`
operation on the single active Opus audio section. It idempotently requests
`stereo=1` and `maxaveragebitrate=256000`, preserving every unrelated codec,
format parameter, media section, and session attribute. Missing, ambiguous, or
malformed targets return the browser-generated answer unchanged.

The 256 kbps receive maximum permits every sender ceiling; it is not a current
target or minimum. Screener does not set `sprop-stereo`, rewrite FEC, force a
sample rate, or add broad string/regular-expression SDP mutation.

Each audio sender reads fresh parameters, applies the selected `maxBitrate`, and
reads the result back. A rejected update leaves the previous sender state and
media alive. Without a remote applied acknowledgement, the Host does not claim
room-wide atomic convergence.

## LiveKit Contract

The SFU publisher maps the three ceilings to pinned LiveKit stereo music presets
or an explicit 256 kbps preset. Every SFU audio publication uses:

- `forceStereo: true`;
- `dtx: false`; and
- `red: false`.

RTP RED sends redundant copies of prior audio data to improve recovery from
short packet-loss bursts. It also materially increases payload traffic; the
earlier 128 kbps selection produced about 256 kbps on the measured SFU path.
Screener disables RED so the selected audio ceiling remains a useful publisher
budget. This trades away RED-specific loss resilience. Opus in-band FEC and
other WebRTC recovery remain separately negotiated; disabling RED neither proves
nor disables them.

LiveKit reconnect reacquires the exact current publication and sender before
reapplying audio parameters. Unchanged publication/sender identity does not
reset stats or parameter state. Missing current ownership fails the SFU route
closed instead of mutating a stale sender.

## Relay And Presentation

A Browser relay keeps one persistent `MediaStream` and reconciles screen-audio
track addition, removal, and replacement into each current child sender. A
source switch does not create an independent audio clock or Web Audio graph.

Viewer playback uses the browser's native media controls on the one persistent
video element. Local volume, mute, play/pause, and fullscreen do not enter
signaling, sender configuration, room state, or another participant. Autoplay
rejection remains a typed presentation state until the browser receives a user
gesture.

Connection metrics select the exact current audio sender/receiver. When audio is
active, the UI reports actual interval traffic rather than a constant or
placeholder `1 kbps`. Track and sender replacement reset only the affected stats
identity, so stale asynchronous samples cannot overwrite the new route.

## Evidence Boundary

Chrome 151 production gates exercised direct Host children, a Browser-relay
child, and an SFU subscriber with generated screen audio. Video and decoded
audio energy advanced at all three 64/128/256 kbps ceilings and after source
replacement. Direct and Browser-relay traffic tracked the selected ceiling;
the then-enabled SFU RED path explained the approximately doubled SFU audio
payload.

The same evidence verified that the active-audio display no longer reports the
old constant `1 kbps`. It did not establish perceptual music quality, all
capture-source combinations, weak-network loss recovery after RED is disabled,
or real-game SFU A/V synchronization.

## Boundaries

- No microphone/voice processing policy is inferred from screen audio. A future
  microphone is a separate source and track.
- No user control for codec, stereo, channel count, sample rate, DTX, RED, FEC,
  or arbitrary bitrate.
- No Web Audio mixing, resampling, second representation, or independent audio
  rate controller.
- `opus/48000/2`, capture channel count, and configured ceilings do not prove
  encoded stereo or end-to-end fidelity.
- Browser/system capture scope may include calls or notifications; the page
  cannot promise per-process isolation from generic system audio.

## Current Verification Gaps

- Chrome/Edge tab, window, and system-audio source combinations on supported
  Windows versions.
- Real game/music subjective quality and A/V synchronization over direct,
  relay, and SFU paths.
- Lossy Wi-Fi/cellular behavior with RED disabled, including concealment and
  Opus FEC counters where exposed.
- macOS, Android, and iOS capture/playback behavior.

## Primary Sources

- [Screen Capture](https://www.w3.org/TR/screen-capture/)
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [WebRTC](https://www.w3.org/TR/webrtc/)
- [RFC 7587: Opus RTP payload](https://www.rfc-editor.org/rfc/rfc7587.html)
- [RFC 2198: RTP redundant audio](https://www.rfc-editor.org/rfc/rfc2198.html)
- [LiveKit audio RED and media options](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit client 2.22.0 track options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [sdp-transform](https://github.com/clux/sdp-transform)
