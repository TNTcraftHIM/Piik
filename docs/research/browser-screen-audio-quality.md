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

## Numeric Bitrate Assessment

Checked 2026-10-09 for the 2.0 candidate. The published 1.x product retains its
preset contract. Candidate numeric requests and supported limits are owned by
[media quality](../standards/media-quality.md#screen-audio); these measurements
do not establish audible improvement or accept a public release.

For scope review on 2026-10-11, [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html#section-3.1.1)
recommends 64..128 kbps for fullband stereo music with 20 ms frames, and
[LiveKit's high-quality stereo preset](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts)
uses 128 kbps. These support retaining the current default; they are neither
codec maxima nor proof of quality for every source. Higher custom settings
remain subject to the measured packet and receiver bounds below.

The existing Go Opus encoder accepted live 128/192/256/320/96/128 kbps changes
without replacement. A 48 kHz stereo tone/noise input continued decoding into
960 samples per channel; the existing deterministic tests also verify stereo
separation at 256/320 kbps and rejection of invalid updates without replacing
the last setting. This establishes encoding continuity, not audible benefit.

A Chrome 152 loopback used the actual sender primitive, generated stereo audio,
and decoded PCM measurement. The same PeerConnections remained connected while
changing those ceilings. Received payload tracked approximately 96/128/192/256/320
kbps, with decoded samples advancing and nonzero waveform energy. This is a
local Browser check, not relay/SFU, mobile, impaired-network or listening acceptance.

Two controls constrain the replacement design:

- Chrome retained `maxaveragebitrate=192000` in the remote answer and sender
  codec parameters, yet later `setParameters()` calls produced approximately
  256/320 kbps. Repeating with a 510000 answer also passed. This scoped runtime
  counterexample does not change [RFC 7587's receive-limit semantics](https://www.rfc-editor.org/rfc/rfc7587.html#section-7.1).
  A numeric sender setting must respect the admitted receiver limit; do not
  assume SDP presence or successful parameter readback proves enforcement.
- With native 20 ms frames, the tone/noise check produced maximum Opus payloads
  of 641 bytes at 256 kbps and 801 at 320 kbps. At 510 kbps, all 150 frames
  produced RTP packets larger than a 1200-byte packetizer budget. Pinned
  [Pion's Opus payloader](https://github.com/pion/rtp/blob/v1.10.5/codecs/opus_packet.go)
  keeps each Opus payload intact. This is a packet-size result, not measured
  network loss; accepting the codec's maximum requires a transport/packet-duration
  decision. Do not equate the codec range with every route's safe operating range.
- Silence/tone/noise/impulse transitions expose a separate peak: the former
  gopus v0.1.1 encoder produces a 1234-byte payload at 320 kbps. Its single-stream
  CELT path also ignores the output budget and fails with a smaller buffer.
  [gopus v0.2.2](https://github.com/thesyncim/gopus/tree/v0.2.2) honors that budget;
  the adapter now reserves packet overhead at the encoding boundary using
  [Opus's instantaneous size limit](https://opus-codec.org/docs/opus_api-1.6/group__opus__encoder.html).
  The retained regression decodes complete 20 ms frames across transients and
  live bitrate changes. This does not diagnose any field interruption or change
  the average bitrate controls, stereo format or route model.

The [media extension proposal](./native-client-media.md#audio-and-ui-proposal)
owns the UI and contract rationale. The candidate enforces a Browser sender's
negotiated Opus limit, and admits unchanged Native/SFU forwarding only when the
receiver's declared limit accommodates the full shared format. A codec-valid
native setting beyond the current sender ceiling remains an operational failure.
Browser and App preference stores round-trip custom numeric values; those stores
were not part of published v1.9.2, so no legacy preset migration is required.

The retained SFU gate passed for both Browser and Windows native publication:
live 320/96 kbps changes retained the same subscription, with advancing decoded
audio energy and video frames. Video profile changes, reload, recovery and
retirement also passed; the Browser run measured stereo separation. An ordinary
Browser relay forwarded received tracks to two children at 320 kbps, with
advancing decoded audio and successful cleanup. Direct Browser controls keep
requested 256/320 kbps below an explicit 192 kbps receive limit, while a
510 kbps receiver permits both rates. The full Browser room also retains both
receiving tracks and advancing decoded audio/video through 320/96/320 kbps edits;
only the limited child's sender is capped at 192 kbps.
Native and SFU adapter controls reject an insufficient answer before binding it.
In a full-UI SFU-only room, that rejection exhausts only the limited Viewer's
route and retires its connection. The Host, healthy sibling and subsequent
capable Viewer continue; the service Debug event retains the receive-limit
cause. Stop retires the remaining media. These are controlled SDP-limit checks,
not physical low-capability decoder measurements.
A native real-Opus control through
6 Mbps -> 500 kbps -> 6 Mbps shaping retains decoded audio during live
320/96/320 kbps changes, with sustained high video after the shared
[probe measurement and video-budget repairs](./node-local-media-design.md#send-queue-recovery).
These are local runtime checks; physical networks, mobile playback and listening
remain open.

RFC 7587 gives an omitted receive bitrate a mode-dependent default, not an
unrestricted value, and asks receivers to ignore out-of-range preferences.
All candidate Piik receivers therefore declare the full Opus range explicitly,
including the App's local preview bridge through the same Browser answer helper.
Browser sender enforcement uses [libwebrtc's existing default calculation](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/codecs/opus/audio_encoder_opus.cc)
when a peer omits a valid limit. Unchanged forwarding requires an explicit
sufficient limit; it cannot turn down the shared source for one receiver.

## Primary Sources

- [Screen Capture](https://www.w3.org/TR/screen-capture/)
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [WebRTC](https://www.w3.org/TR/webrtc/)
- [Opus RTP, RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html)
- [RTP redundant audio, RFC 2198](https://www.rfc-editor.org/rfc/rfc2198.html)
- [LiveKit media options](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit client options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [sdp-transform](https://github.com/clux/sdp-transform)
