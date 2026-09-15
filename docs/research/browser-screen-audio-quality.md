# Browser Screen-Audio Evidence

- Reviewed: 2026-08-27
- Scope: Browser display audio over direct, relay, and LiveKit paths
- Status: evidence; current controls are owned by
  [media quality](../standards/media-quality.md)

## Findings

- `getDisplayMedia()` may return no audio track depending on Browser, operating
  system, selected surface, and user choice. Audio constraints are preferences,
  not a portable source or fidelity guarantee.
- Screen audio is distinct from microphone/voice processing. Echo cancellation,
  noise suppression, gain control, voice isolation, channel count, and content
  hint requests must be interpreted through actual capture and RTP evidence.
- One structured `sdp-transform` operation can request Opus stereo and a receive
  ceiling while preserving unrelated codecs, media sections, and attributes.
  Missing or ambiguous Opus targets should leave the Browser answer unchanged.
- Sender `maxBitrate` is a ceiling. Fresh parameter readback and interval RTP
  stats are required; content and congestion may produce lower traffic.
- Browser relay can keep screen audio in the same persistent `MediaStream` while
  source tracks are added, removed, or replaced. It does not need a Web Audio
  mix/resample graph or second clock.
- Viewer play, mute, volume, and autoplay recovery belong to the native media
  element and do not change sender or room state.

## RED Tradeoff

RTP RED carries redundant prior audio payload to improve short-loss recovery and
can materially increase traffic. Under an earlier 64/128/256 kbps experiment,
direct and Browser-relay payload tracked the selected sender ceiling, while the
then-enabled SFU RED path was approximately double its nominal audio payload.

That measurement justified treating RED and an audio ceiling as separate
decisions. Current values and LiveKit options are intentionally not mirrored
here; they are owned by the product module and code. Disabling RED does not prove
that Opus in-band FEC is enabled or disabled.

## Retained Functional Evidence

Chrome 151 controlled runs exercised a direct Host child, a Browser-relay child,
and one SFU subscriber with generated screen audio. Video, audio RTP, and decoded
audio energy advanced at all tested historical ceilings and after source
replacement. The active-audio display also stopped reporting the old constant
`1 kbps` placeholder.

These runs prove track/sender continuity and stats ownership. They do not prove
perceptual music quality, encoded stereo, all capture-source combinations,
weak-network behavior, real-game A/V synchronization, or mobile playback.

## Open Evidence

- Chrome/Edge tab, window, and system-audio combinations on supported Windows.
- Real game/music quality and A/V synchronization over direct, relay, and SFU.
- Lossy Wi-Fi/cellular concealment and Opus FEC behavior with current options.
- macOS, Android, and iOS capture/playback behavior.

## Primary Sources

- [Screen Capture](https://www.w3.org/TR/screen-capture/)
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [WebRTC](https://www.w3.org/TR/webrtc/)
- [Opus RTP, RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html)
- [RTP redundant audio, RFC 2198](https://www.rfc-editor.org/rfc/rfc2198.html)
- [LiveKit media options](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit client options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [sdp-transform](https://github.com/clux/sdp-transform)
