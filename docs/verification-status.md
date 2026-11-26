# Verification Status

Last updated: 2026-11-26

Internal 3.0 evidence spans several revisions. Each package receipt identifies the
build and workload it covers. Delivery readiness and published 2.x verification
have separate records. [3.0 status](./status.md#isolated-30-prototype) ·
[2.x verification](https://github.com/TNTcraftHIM/Piik/blob/main/docs/verification-status.md)

## Current Evidence

The Windows x64 review builds opened WebView2, created a room and
decoded a synthetic screen from an independent Browser on loopback. Main-window
closure released the observed WebView processes and listeners. The native room
tool retained simulated microphone voice between panel and compact overlay.
Settings accepted pointer input, Escape dismissed settings before pinning, and
the underlying desktop window received clicks and scrolling through the pinned
overlay. A native file save continued after the panel closed and reported the verified
saved file and receipt. Cancelling the native download reported cancellation.
The matching protocol-47 Windows review also exercised single-use owner entry
through WebView and an external Browser, storage-denied same-page reconnection,
and narrow-window controls. Its Android APK passed two-ABI compilation and
static package checks; device behavior was not inferred from that build.

- **Room access and data.** On Alpine x64 the packaged Server accepted signed
  chat after the creator left, restored the invitee's grant and history on restart
  and hid the room from a stranger. On loopback, Server `c5034bb0` applied the
  public Demo policy to a guest-created room. Fresh visitors saw only public
  rooms, while the invite recipient entered and sent chat. Deployed Demo
  acceptance remains open. Earlier Browser, App and Server controls covered
  offline identities, unread state, history paging, mentions, replies, thumbnail
  access with an offline holder, archive restoration and invalid-archive rejection.
  Protocol-47 packaged Linux restart retained history lineage; restoring a room
  archive replaced it atomically while serving the archived rows through signed
  history replies. The frozen beta.56 Windows App and matching text participant
  created a room and message, exited, and reopened the same data directory.
  The original credential restored the same identity, room and confirmed row.
  Actual Domain v1 and room v11 SQLite samples passed their integrity checks;
  this used synthetic local data and two orderly process exits.
  A separate two-Browser control reopened both pages on their original origin.
  The IndexedDB writer restored its history under a new live binding; the reader
  retained its identity and read position, then fetched the confirmed rows anew.
  [Room data](./research/channel-storage-and-identity.md) · [Field checks](./todo.md#now)
- **Concurrent activities.** Local Browser and App controls covered source
  replacement and cancellation with the viewer still receiving, voice and drafts
  across layout changes, and file transfer with decoded picture and voice on the
  same relay. Saved bytes matched the source. Cancellation released the temporary
  file and retry succeeded. The Browser transfer exceeded 16 MiB. The 256 MiB
  result used a WASM range-buffer control. Device storage determines writable
  capacity. [Relay workload](./research/network-lab.md#file-forwarding-during-a-room-call)
  Windows WebView retained picture-in-picture across a source replacement.
  Closing its system window kept the viewer joined, and the next source played
  inside the page without reopening picture-in-picture.
  Protocol-48 Server/Browser loopback controls exercised master-off, voice-only
  Hosted and files-only Browser-hosted forwarding with direct signaling blocked.
  Writer and chat operation survived every setting; allowed audio progressed and
  the allowed file completed with a matching digest.
- **Microphone modes.** Real Chrome AudioWorklet/WebRTC loopback with synthetic
  PCM verified push-to-talk release, changed bindings, detached room-tool focus
  and voice-activation threshold/hold. Open mode loaded no gate worklet.
  Physical microphone sensitivity and background native talk-key capture remain
  outside these checks.
- **Synchronized viewing.** Independent local Browsers exercised direct playback,
  late join, autoplay refusal and trusted-click recovery. Windows App fixtures
  covered source selection, direct HLS, forwarded MP4, HLS VOD and clear static
  DASH, including independent viewers without source credentials. Controlled
  runs covered range reads, pause/seek, source refusal/retry, short signaling
  loss, expiry and release on shutdown. On self-signed HTTPS the MP4/HLS adapters
  were checked in Chrome. Other native-playable containers require an origin that
  permits Service Workers. A Linux VM exercised live HLS with program-date-time
  through direct and forwarded delivery using synthetic page discovery/control.
  The live controls used real Native approval, reading and peer delivery.
  No-PDT and opaque native-only live sources were rejected. Cross-network clock
  accuracy, first-picture latency and commercial live/DRM coverage remain open.
  [Playback and authority](./research/channel-network-design.md#synchronized-video-sources)

Website checks used the following samples. Catalogue coverage and the reports
from users' networks remain open. [Website and field checks](./todo.md)

| Source | Observed scope |
| --- | --- |
| Bilibili ordinary video | A matched Windows App and unlinked Browser played 1080p AV1/AAC without login. Pause, unbuffered backward seek and forwarding off/on passed. The viewer could continue from cached bytes. |
| Bilibili original webpage | Two beta.39 Windows Apps followed pause and seek on a public sample and retired playback when the source closed. The reported unexpected exit and member-only original-page case remain open. |
| Bilibili authorized member video | The sharer and an unlinked Browser without site login played past the preview limit, paused and sought forward. Protected tracks were excluded. Member-specific backward seeking remains open. |
| YouTube | Independent Browsers exercised ordinary-video playback, pause, seek and resume through room signaling in the official player, plus source transfer and retirement. Shorts coverage includes pause, resume and retirement. Ads, account/region restrictions, live and physical mobile use remain open. |
| PeerTube | Independent desktop Browsers followed play, pause, seek and resume through room signaling in the official player. The public sample fetched media directly from its provider; private instances and physical mobile use remain open. |
| girigirilove | A region-unavailable redirect prevented access to the supplied player. |

## Device Evidence Boundary

### Windows And Android

The beta.50 Android APK opened its system-browser interface on an isolated API 35
x86_64 emulator. Local room chat, an independent matching text participant,
image preview and system Back from sharing settings and image preview passed.
That package's live MediaProjection/MediaCodec path remains unverified.

The matched beta.39 Windows WebView2 and Android Chrome endpoints exchanged
chat, video and synthetic audio on local P2P UDP. The Android endpoint ran on an
API 35 x86_64 emulator. Its real MediaProjection picker and Native MediaCodec
sent synthetic app content to Windows Chrome and resumed the same grant after
Home. Stop released projection and encoders. Two beta.39 Windows Apps also
decoded a Native-to-Native relay on one machine. Physical handset capture,
rotation, sound, suspension, media-path loss and ARM64 runtime acceptance remain
open. Candidates with a different private protocol require matching-package
acceptance. ARM64 package inspection was static. MuMu's legacy OMX service can abort
during encoder creation. Firefox on the tested emulator decoded incoming H264
but could fail to produce a relayed picture. [Android capture](./research/cross-platform-client-runtime.md#android-capture-bridge-assessment)

Windows package checks covered native window capture, attended pointer/keyboard
input to an owned window, WebView fallback, saved-site navigation, local HTTPS
entry, orderly shutdown and a signed update using a temporary identity and
local providers. WebView permission and speaking-indicator controls used fake
devices. Closing a detached room panel preserved an actual attachment save and
its room-owned progress; saved bytes matched the source. Native download
cancellation left no saved file. Pinned voice overlays passed native pointer
hit testing, focus return, title-bar dragging and dismissal while voice stayed
joined. Background opening preserved another owned window's foreground state.
Physical microphone/camera behavior, permission reset across process
restart or active capture, protected/admin windows, manual source selection on
the reporter's setup, window audio and production update distribution remain
outside those checks. An isolated shutdown stall remains unexplained.
[Desktop runtime](./research/cross-platform-client-runtime.md#30-system-webview-client-evaluation) ·
[Attended input](./research/room-interactions.md#attended-remote-control-prototype)

### macOS And Linux

macOS CI built Server/App, compiled the capture path and Native tests, and
verified synthetic VideoToolbox H264 encode/decode and quality feedback.
Earlier checks exercised LaunchServices startup and startup-error cleanup.
System Quit, Dock/Finder return, permissions, physical capture, sound and input
require device acceptance. [Build and codec run](https://github.com/TNTcraftHIM/Piik/actions/runs/45341981837) ·
[Feedback control](https://github.com/TNTcraftHIM/Piik/actions/runs/42697708222)

Linux VM evidence covers software encoding, decoded picture and Opus, picker
cancellation/retry, and sound-service loss with chat and picture continuing.
GNOME Portal/PipeWire checks exercised real consent, input and global stop.
GNOME can retain cancelled shortcut prompts and Mutter can leak an unstarted
session after Piik releases its resources. Stock Alpine and Flathub OBS passed
repeated local WHIP input with synthetic sources. Hardware encoding, physical
sound, other desktop configurations and cross-NAT OBS delivery remain open.
[Platform findings](./research/channel-network-design.md#implementation-boundary) ·
[Local OBS input](./research/room-interactions.md#local-obs-input)

## Adaptation Boundaries

Loopback and conditioned networks exercised UDP recovery, relay departure,
cold file/voice relay through an idle room peer and optional packaged Linux
Server forwarding with room-scoped leases. An Android App delivered signed
history, chat and decoded H264 across two independent public UDP egresses.
A same-egress run received STUN replies without peer datagrams. Its cause,
population NAT success rates, sustained load and typical recovery times remain
open. Random-port preparation was measured with two capable Native endpoints.
Single-App linear mapping, changing IPv6 during ICE setup and PCP-to-NAT-PMP
fallback have separate controlled workloads. [Network laboratory](./research/network-lab.md#rust-process-controls) ·
[NAT controls](./research/nat-traversal.md#random-mapping-collision-control)

Constrained encoder controls covered independent outputs, recovery and source
clocks. Injected Windows software encode delay triggered a resolution reduction.
Physical GPU contention, game performance and automatic hardware/software
switching remain unverified. Synthetic tests cover stereo, SDR conversion and
GPU tone mapping. Physical acoustics, HDR appearance and mixed-display changes
under load remain open. Full HDR and surround sound are outside this phase.
Native system-output capture can include Browser room voice. Automatic voice
exclusion is deferred. [Encoder measurements](./research/webrtc-encoder-pool.md) ·
[Fidelity](./research/media-fidelity.md) · [Audio boundaries](./research/channel-network-design.md#input-and-sound-boundaries)

## Interpretation

Acceptance applies to the identified artifact, platform, source and network.
The preceding package runs retain their original scope. Field reports and
physical-device checks are tracked in TODO. [Build identity](./standards/versioning.md) ·
[Earlier verification record](https://github.com/TNTcraftHIM/Piik/blob/f634a7e252f8344419c2ff6825272703252498e4/docs/verification-status.md) ·
[Open work](./todo.md)
