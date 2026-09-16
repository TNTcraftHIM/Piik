# Capture, Audio, And Media Quality

This file owns the current Browser and App media contract. Detailed measurements and
platform limits live in [realtime quality research](../research/realtime-quality-adaptation.md)
and [screen-audio research](../research/browser-screen-audio-quality.md).
[ADR-0007](../adr/0007-path-isolated-representation-quality.md) owns Browser
source intent and codec selection, [ADR-0008](../adr/0008-window-scoped-audio-capture.md)
owns screen-audio scope, and [ADR-0013](../adr/0013-embedded-node-local-media.md)
owns the current candidate's shared Native/SFU output model. This file describes
that source contract. [Status](../status.md) separates it from the last known
production behavior and remaining acceptance.

## Capture And Controls

- The Web Host may share a display, application window, or Browser tab and may
  stop, synchronously pause/resume audio and video, or switch source.
- An App-launched Host explicitly chooses either that Browser capture path or
  one native screen/window enumerated by the packaged platform capture boundary. The
  latter uses one supported native codec path and never infers a target from
  a title. An ordinary Web Host does not probe localhost.
- Windows native capture follows an explicitly stretched active display path
  for an entire display or a window covering that display, when the captured
  frame matches its desktop source dimensions. Other frames retain their own
  aspect ratio. This changes only the encoded presentation, never the game or
  display settings; vendor-private scaling is not inferred.
- Where Windows supports border control, the native source picker offers
  **Show capture border**, off by default. The choice stays in the Host page and
  follows native source and quality changes. Source previews request borderless
  capture independently. Windows owns consent and final border visibility;
  unsupported, pending, denied or failed access must leave ordinary capture and
  stop controls usable. Other capture sessions can keep the border visible.
  Browser indicators remain browser-owned.
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
- Native quality changes use the same room settings. The App prepares a new
  platform capture/encoder generation, then replaces the old generation behind
  the same encoded source and PeerConnections; audio-only changes update the
  current Opus encoder directly. A live profile update may remain pending while
  the selected source produces no frames. Setup and encoding failures remain
  bounded; quiet-source waiting must not block pause, stop or connection control.
  Applied settings change only after the replacement is ready and installed;
  failure preserves the previous capture and profile. Platform quality preference uses the hardware
  encoder's standard quality-versus-speed hint. Pion owns Native WebRTC
  transport; the shared media adapter uses LiveKit media components for bandwidth
  estimation, forwarding allocation, pacing and recovery.
  Windows VP8 uses libvpx's realtime mode; it does not claim the same hardware
  quality-versus-speed control or per-edge Browser adaptation.
- With App available, Browser H.264 capture can use one local sender and the
  existing Native encoded fanout while topology optimization is enabled. The
  Browser still owns preview, pause, capture settings, and source selection.
  Loss of that optional ingress retains capture and rebuilds the assigned
  Browser edges. [ADR-0011](../adr/0011-browser-assisted-native-fanout.md) owns
  this composition; pure Browser and VP8 sharing use the Browser-owned sender
  paths described below.

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

Each Browser direct, relay, or SFU video sender owns one clone of its capture or received
source track. The original track remains a source and local presentation track;
it is never attached directly to an outbound sender. Replacing or retiring a
sender also stops its clone, so native adaptation state cannot survive by being
inherited through the original track. Host pause and live capture constraints
are propagated to current Host-owned clones.

Eligible Browser P2P parents use the source-owned pool in
[ADR-0014](../adr/0014-browser-node-local-encoding-pool.md). Compatible direct
children share one independent local WebRTC producer; incompatible demands
remain separate. Each outgoing connection keeps native transport, allocation
and recovery, with a tiny carrier supplying its RTP clock. Producers use
the existing native video target under Host ceilings. Actual forwarded-frame
and producer observations remain distinct from the tiny carrier's statistics.
The first eligible consumer follows the same path; unsupported APIs or failed
pooling use ordinary senders. Prepared ordinary quality candidates, Native
ingress and Browser SFU remain independent compositions.

Each ordinary Browser PeerConnection owns stock WebRTC congestion control and
sender adaptation. Clones share one underlying media source and therefore do not provide
complete simultaneous isolation: framework source-wants aggregation may still
partially reduce frames available to sibling clones. Sibling outputs may differ;
Piik does not impose a room-wide minimum. The Host's one Browser SFU
publication uses the share-generation codec and selected ceilings. Its ordinary
simulcast outputs follow pinned LiveKit screen-share construction: original and
half size at the same frame rate, with a quarter-bitrate lower ceiling and its
150 kbps floor. Tiny sources use one output. There is no backup codec or third
product preset. Browser WebRTC budgets the aggregate publication.

The embedded SFU forwards an existing suitable encoding to each subscriber.
LiveKit media components own its per-subscriber bandwidth estimation, allocation,
RTP projection, pacing and loss recovery; the LiveKit room service and Browser
SDK are not used. Direct-subscriber demand controls the publisher's active
output prefix through the current room signal. Target, currently forwarded and
recovery-preparation demand stay distinct from actual delivery. Viewport size
does not choose a layer because a Viewer may relay its received media.

Tracks received from a PeerConnection do not own capture constraints. Native
capture therefore retains source resolution and frame-rate ownership across its
loopback Browser preview. Native Host SFU publication uses the encoded source
directly and does not re-encode that preview through a Browser publisher.

Native parents and the SFU share the media forwarding adapter. Each Native
parent considers only its direct children and its admitted SFU publication.
Compatible children reuse an available encoded output; a missing lower output
starts one shared decode/scale/encode group, while healthy forwarding retains
the original input without starting a decoder. The group produces the highest
needed output and its lower fallbacks and stops unused upper outputs. Each child
receives only its selected output. The forwarding SFU adds no server transcoder.

Native capture uses the same screen-share output construction within Host
ceilings. Its source, source clock and higher outputs remain independent of
lowest-output bitrate adaptation. The SFU upstream request is the maximum of
its direct-subscriber demands; Native Host combines it with direct Peer demand,
while the publication still has one aggregate upload budget. Multiple outputs
have real encode and upload costs; this is not a one-encode guarantee.

Packet identity and delivered counters belong to each outbound edge. Unused
outputs do not inflate that edge's FPS or bitrate. Bounded codec workers and
packet queues isolate slow children and retire with the source generation.
Windows shared local outputs use one complete stock WebRTC encoding/adaptation
pipeline each, including source restrictions, rate correction and resource
feedback. Resolution/FPS adaptation keeps the capture and transport identities;
actual output dimensions update forwarding metadata without resetting sibling
stream trackers. H264 uses native NV12/MFT and WebRTC's parsed-QP adaptation;
VP8 uses the library encoder. Other platform producers retain their current
fixed-output implementation pending equivalent physical acceptance.
Each source groups compatible effective direct-child requests and keeps
incompatible weak budgets independent. Per-group rates change in place; joining
another group's output waits for accepted recovery and keeps the existing
PeerConnection, pacer and bandwidth estimator. Original received media stays
encoded, while a relay uses one decoder process for its independently activated
missing outputs. Source-generation retirement rejects old frames before they
can change attachment. Private physical slots are bounded by admitted consumers,
not fixed spatial presets, and unused codec workers retire independently.
This does not establish full Browser parity, hardware-overload acceptance or
seamless adaptation at extremely low bandwidth.

Native sender edges normally reuse the shared encoded source. A Native Viewer
forwards suitable H.264/VP8 and Opus payload unchanged and derives only a missing
lower video output; each outbound PeerConnection owns its RTP identity and
transport feedback. When an edge is
persistently degraded, the existing quality operation may prepare a Browser
WebRTC sender from the stable local bridge as that edge's candidate. The old
edge stays live until the Viewer proves the candidate is better; a failed
candidate rolls back, and a later operation may return the edge to the shared
native source. This gives one difficult path stock per-sender adaptation without
lowering the shared representation for healthy paths. It adds no quality score,
timer, or room-wide media setting.

Piik does not maintain an application bitrate/resolution ladder, scene
detector, periodic quality controller, manual SFU layer selector, or
application-defined whole-room lowest-common-denominator target.

## Screen Audio

Display audio uses `contentHint = "music"`. The live sender ceilings are 64,
128, and 192 kbps with 128 kbps default. Peer answers request Opus stereo and a
192 kbps receive ceiling. The SFU publication uses stereo, DTX disabled, and RED
disabled; this accepts less burst-loss resilience in exchange for bounded
publisher traffic. The Browser and source still decide whether an audio track
exists and what is actually delivered.

A Native audio-process failure does not end healthy video. A later explicit
source replacement resumes audio through the existing track and encoder owner;
it does not trigger an automatic capture retry or change room audio topology.

## Observable Truth

Requested resolution, frame rate, bitrate, content intent, codec, and audio
quality are inputs or ceilings. Sender parameter readback and current RTCStats
are the observable result. Connection detail may show actual path, codec,
resolution, FPS, bitrate, loss, jitter, RTT, and encode/decode behavior when the
Browser exposes them; missing or reset counters remain unknown.

Browser WebRTC and the shared Pion/LiveKit media adapter own media adaptation.
ADR-0005's native-edge convergence consumes only a persistent categorical sender limitation
and proof from the same Viewer over a real prepared candidate; it does not turn
quality metrics into media settings or a weighted/global route score.

Native categorical evidence includes the media framework's committed allocation
deficiency: fitting a reduced output into the available budget does not clear a
continuing framework limitation. Publication evidence considers only requested
encodings, so an intentionally inactive encoding is not a bandwidth failure.
Missing feedback or frame progress remains unknown. This category neither
infers a physical bottleneck nor ranks routes by configured quality ceilings.

Web pages cannot guarantee Host background capture, mobile background playback,
or relay execution after Browser/OS suspension. Those remain physical lifecycle
boundaries, not keepalive features.
