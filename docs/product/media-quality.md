# Capture, Audio, And Media Quality

This file owns the current Browser and Client media contract. Detailed measurements and
platform limits live in [realtime quality research](../research/realtime-quality-adaptation.md)
and [screen-audio research](../research/browser-screen-audio-quality.md).
[ADR-0007](../adr/0007-path-isolated-representation-quality.md) owns the SFU
adaptation decision.

## Capture And Controls

- The Web Host may share a display, application window, or Browser tab and may
  stop, synchronously pause/resume audio and video, or switch source.
- A Client-launched Host explicitly chooses either that Browser capture path or
  one native screen/window enumerated by the packaged platform capture boundary. The
  latter uses one supported native codec path and never infers a target from
  a title. An ordinary Web Host does not probe localhost.
- Windows native capture follows an explicitly stretched active display path
  for an entire display or a window covering that display, when the captured
  frame matches its desktop source dimensions. Other frames retain their own
  aspect ratio. This changes only the encoded presentation, never the game or
  display settings; vendor-private scaling is not inferred.
- Share and source-switch requests ask the Browser for available audio by
  default. Missing audio is reported clearly but does not block video-only
  sharing. Native screen capture can include system playback audio and native
  window capture can include selected-process audio when the platform exposes it.
- Authoritative Browser pause disables the current source and sender-owned tracks
  while retaining the room and established routes. Native pause keeps capture
  alive but stops session output through the same owner. Black frames, track
  mute, or network failure are not interpreted as a user pause.
- The Host preview displays the capture stream directly and creates no Viewer or
  media route. Hiding the page may pause only that local video element; it must
  not intentionally stop capture, encoding, or upload.
- Live quality changes update the current capture and Host sender-track
  constraints plus sender ceilings without reopening source selection or
  replacing a healthy route.
- Native quality changes use the same room settings. The Client prepares a new
  platform capture/encoder generation, then replaces the old generation behind
  the same encoded source and PeerConnections; audio-only changes update the
  current Opus encoder directly. Platform quality preference uses the hardware
  encoder's standard quality-versus-speed hint, while Pion/WebRTC still own
  transport estimation and route evidence.
  Windows VP8 uses libvpx's realtime mode; it does not claim the same hardware
  quality-versus-speed control or per-edge Browser adaptation.
- With Client available, Browser H.264 capture can use one local sender and the
  existing Native encoded fanout while topology optimization is enabled. The
  Browser still owns preview, pause, capture settings, and source selection.
  Loss of that optional ingress retains capture and rebuilds the assigned
  Browser edges. [ADR-0011](../adr/0011-browser-assisted-native-fanout.md) owns
  this composition; pure Browser and VP8 sharing retain their normal senders.

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

Windows native capture uses the same VP8/Auto/H264 controls. H264 selects the
hardware path and VP8 the bundled libvpx encoder. Auto measures encoding work
for synthetic NV12 frames at the selected dimensions and frame rate, with a
bounded warmup and sample. If H264 sustains the target it is selected; otherwise
VP8 is measured within the remaining four-second budget. This is a throughput
check, not a perceptual-quality score or a promise under future GPU load.
The returned actual codec owns the shared source, preview, and relay; live
quality/source changes retain it. Other native platform encoders remain H264.

## Framework-Owned Adaptation

Each direct, relay, or SFU video sender owns one clone of its capture or received
source track. The original track remains a source and local presentation track;
it is never attached directly to an outbound sender. Replacing or retiring a
sender also stops its clone, so native adaptation state cannot survive by being
inherited through the original track. Host pause and live capture constraints
are propagated to current Host-owned clones.

Each PeerConnection still owns stock WebRTC congestion control and sender
adaptation. Clones share one underlying media source and therefore do not provide
complete simultaneous isolation: framework source-wants aggregation may still
partially reduce frames available to sibling clones. Sibling outputs may differ;
Screener does not impose a room-wide minimum. The Host's one SFU publication uses
the share-generation codec and selected ceiling but no application-defined
simulcast ladder or backup codec. Pinned LiveKit defaults construct
representations; Dynacast aggregates demand and server send-side BWE selects
subscriber forwarding. AdaptiveStream stays disabled because any Viewer may
relay its received track.

Tracks received from a PeerConnection do not own capture constraints. Native
capture therefore retains source resolution and frame-rate ownership across its
loopback Browser bridge; the existing Browser SFU publisher applies only sender
parameters and LiveKit's representation policy to that remote source.

Native sender edges normally reuse one encoded source. A Native Viewer forwards
compatible H.264/VP8 and Opus payload without decoding or re-encoding it; each outbound
PeerConnection owns its RTP identity and transport feedback. When an edge is
persistently degraded, the existing quality operation may prepare a Browser
WebRTC sender from the stable local bridge as that edge's candidate. The old
edge stays live until the Viewer proves the candidate is better; a failed
candidate rolls back, and a later operation may return the edge to the shared
native source. This gives one difficult path stock per-sender adaptation without
lowering the shared representation for healthy paths. It adds no quality score,
timer, or room-wide media setting.

Screener does not maintain an application bitrate/resolution ladder, scene
detector, periodic quality controller, manual SFU layer selector, or
application-defined whole-room lowest-common-denominator target.

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

WebRTC and LiveKit remain the media-adaptation owners. ADR-0005's deployed
native-edge convergence consumes only a persistent categorical sender limitation
and proof from the same Viewer over a real prepared candidate; it does not turn
quality metrics into media settings or a weighted/global route score.

Web pages cannot guarantee Host background capture, mobile background playback,
or relay execution after Browser/OS suspension. Those remain physical lifecycle
boundaries, not keepalive features.
