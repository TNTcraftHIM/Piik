# Capture, Audio, And Media Quality

This file owns the current Browser media contract. Detailed measurements and
platform limits live in [realtime quality research](../research/realtime-quality-adaptation.md)
and [screen-audio research](../research/browser-screen-audio-quality.md).
[ADR-0007](../adr/0007-path-isolated-representation-quality.md) owns the SFU
adaptation decision.

## Capture And Controls

- The Web Host may share a display, application window, or Browser tab and may
  stop, synchronously pause/resume audio and video, or switch source.
- Share and source-switch requests ask the Browser for available audio by
  default. Missing audio is reported clearly but does not block video-only
  sharing.
- Authoritative pause disables all current capture tracks while retaining the
  room and established routes. Black frames, track mute, or network failure are
  not interpreted as a user pause.
- The Host preview displays the capture stream directly and creates no Viewer or
  media route. Hiding the page may pause only that local video element; it must
  not intentionally stop capture, encoding, or upload.
- Live quality changes update the current capture constraints and sender
  ceilings without reopening source selection or replacing a healthy route.

## Video Profiles

The three recommended profiles are ceilings, not delivery guarantees:

| Profile | Target | Video bitrate ceiling |
| --- | --- | ---: |
| `720p30` | 1280x720 at 30 fps | 3 Mbps |
| `1080p30` | 1920x1080 at 30 fps | 5 Mbps |
| `1080p60` | 1920x1080 at 60 fps | 8 Mbps |

`1080p30` is the default. Advanced resolution includes 480p, 720p, 1080p, and
1440p; frame rate, bitrate, and `maintain-resolution | balanced |
maintain-framerate` remain independent controls. Display video uses the standard
`contentHint = "motion"` for game motion.

Current acceptance targets are:

- on a controlled P2P path with RTT at most 40 ms and loss at most 1%, glass-
  to-glass latency p50 at most 150 ms and p95 at most 250 ms;
- through a regional SFU/UDP root, glass-to-glass p95 at most 350 ms; and
- when the 60 fps profile is selected, no silent run of five seconds below 50
  decoded fps without an explicit adaptation or user-visible limitation.

These are targets pending the physical matrices in verification status, not
claims that every Browser, game, or network already meets them.

## Codec Decision

The pre-share Browser selector is `VP8 | Auto | H264`, defaults to Auto, and is
locked while sharing. It is local UI state and is not persisted or carried as a
room quality setting.

Auto uses one bounded actual-sender probe rather than a capability or device
allowlist. A proved sender prefers H.264 with VP8 fallback; unsupported, failed,
or inconclusive probes use VP8. Manual VP8 or H264 strictly selects that codec.
The result stays fixed for the current share and is reconsidered for a new share.
ADR-0007 owns probe and negotiation mechanics.

The Browser chooses the concrete encoder implementation. A reported H.264 codec
does not by itself prove hardware acceleration, and Web content cannot select a
specific MFT, NVENC, AMF, or QSV implementation.

## Framework-Owned Adaptation

Each direct or relay PeerConnection keeps its own stock WebRTC congestion and
quality adaptation. The Host's one SFU publication uses the share-generation
codec and selected ceiling but no application-defined simulcast ladder or backup
codec. Pinned LiveKit defaults construct representations; Dynacast aggregates
demand and server send-side BWE selects subscriber forwarding. AdaptiveStream
stays disabled because any Viewer may relay its received track.

Screener does not maintain an application bitrate/resolution ladder, scene
detector, periodic quality controller, manual SFU layer selector, or whole-room
lowest-common-denominator target.

## Screen Audio

Display audio uses `contentHint = "music"`. The live sender ceilings are 64,
128, and 192 kbps with 128 kbps default. Peer answers request Opus stereo and a
192 kbps receive ceiling. The SFU publication uses stereo, DTX disabled, and RED
disabled; this accepts less burst-loss resilience in exchange for bounded
publisher traffic. The Browser and source still decide whether an audio track
exists and what is actually delivered.

## Observable Truth

Requested resolution, frame rate, bitrate, content intent, codec, and audio
quality are inputs or ceilings. Sender parameter readback and current RTCStats
are the observable result. Connection detail may show actual path, codec,
resolution, FPS, bitrate, loss, jitter, RTT, and encode/decode behavior when the
Browser exposes them; missing or reset counters remain unknown.

The current quality shadow accepts only current foreground presentation evidence
and never changes routes or media settings. ADR-0005 accepts native-edge local
topology convergence that is not implemented or deployed; weighted/global
optimization remains parked in [TODO](../todo.md).

Web pages cannot guarantee Host background capture, mobile background playback,
or relay execution after Browser/OS suspension. Those remain physical lifecycle
boundaries, not keepalive features.
