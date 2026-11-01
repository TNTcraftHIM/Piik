# Verification Status

Last updated: 2026-11-01

This file summarizes evidence boundaries that materially affect product claims.
[Status](./status.md) owns candidate and deployment readiness; research owns
measurements and platform details.

## Current Evidence

Windows App and Browser are the primary acceptance targets. Room voice
passed the normal Host/Viewer flows on P2P and embedded SFU, including
channel activation, forwarding, source replacement and recovery. Controlled voice
checks cover Browser/App endpoint combinations, SFU fallback and UDP interruption;
they do not establish a population connection rate. Native H264/VP8,
constrained-network recovery, the media lifecycle, responsive UI and packaging
checks also passed. Exact results stay with their measured artifacts and revision.

The owner accepted the earlier scoped interaction, Native and Browser media
phases, including NAT and Auto codec behavior.

Isolated 3.0 Native processes pass calibrated Linux kernel-NAT controls for
ordinary and prepared UDP connections, short-interruption continuity and
replacement after a lost NAT mapping. These controls observe DataChannel
readiness and bidirectional transport traffic. The current Rust Browser/Native
decoded-media matrix remains in [TODO](./todo.md).

## Device Evidence Boundary

- The isolated 3.0 Windows desktop archive serves its bundled Web/WASM and build
  identity from an independent directory, then exits cleanly on native Ctrl+C.
  Current str0m App and Server archives pass their normal package checks,
  including served source identity, WASM/notices, SQLite room creation and
  listener release. The Linux static-musl Server's resource loading, SQLite
  creation and SIGTERM results predate str0m adoption; refreshed Linux package
  acceptance is tracked in [TODO](./todo.md#now).
- The combined Windows App and Server pass normal production-UI chat, voice and
  viewing flows. The App's native window capture decodes as H264 in the Browser;
  closing the captured window retires its share while room chat continues.
  Server's default dual-stack listeners retain usable IPv4 paths when IPv6 has
  no advertisable address. Both programs release their listeners on native Ctrl+C.
- macOS/Linux builds and bounded native checks are distinct from physical
  capture and input. Physical platform coverage remains limited.
- The isolated 3.0 macOS Native and App pass an
  [Apple SDK build](https://github.com/TNTcraftHIM/Piik/actions/runs/41282552930),
  including ScreenCaptureKit, VideoToolbox, source sound and Quartz input.
  Native test programs also compile and link. System permission, capture,
  sound and input acceptance on a Mac remain open.
- The isolated 3.0 Linux adapter passes Native/App/Server compilation and real
  GStreamer encoding checks in a Linux VM. Synthetic frames cover independent
  encoders, backpressure, resizing, source timestamps, keyframes and teardown;
  synthetic PCM covers queue-loss gaps. A real GNOME Portal session supplies
  PipeWire frames with the source clock. Cancelling pending control permission
  preserves that stream and the Portal service; accepting it delivers encrypted
  keyboard and pointer input to a desktop window. Stopping capture releases
  its Portal sessions and stream. The GNOME cancellation cleanup defect is
  recorded in the [network design](./research/channel-network-design.md#implementation-boundary).
  Real GlobalShortcuts approval binds the preferred Super + Alt + F10; actual
  EIS keyboard activation retires input grants while the original PipeWire
  capture produces a newer frame. Source cancellation retains input Off but
  the GNOME shortcut provider leaves its dialog visible, as recorded by the
  same evidence owner.
  Hardware encoding and physical sound remain platform acceptance work.
- The isolated 3.0 Android Rust App passes NDK/JNI builds and emulator use through
  Firefox: App linkage, system screen selection, decoded H.264 picture and captured
  source sound. Cancelling the system picker preserves the active share;
  pending-page cancellation and capture stop preserve the running room.
  Notification Stop joins the runtime and closes its listeners. Opening the App
  again restores its launcher without resuming capture.
  The selected str0m candidate also passes this full App flow on the emulator.
  Its Rust encoder components also pass independent bitrate updates, keyframe
  requests, source-clock preservation and sibling isolation on the emulator's
  software codec.
- The published 2.x Android system-browser App passed emulator screen/camera sharing
  with concurrent room voice. Browser consent returns to the same tab; source
  replacement, cancellation and background return preserve the share. Local/public
  startup and launcher reentry also have emulator evidence. Full-App checks now
  cover concurrent original/lower encoding, live-budget reduction and recovery,
  static-source late joins, lower-output retirement, capture stop and restart.
  The [capture assessment](./research/cross-platform-client-runtime.md#android-encoder-budget)
  owns measured bitrate bounds and the stock FrameDropper's saturation limit.
  Phone/tablet/TV hardware coverage and physical audio remain limited.
- The separate iOS system-browser implementation passes Apple SDK device and
  simulator builds and its session/encoder checks. Physical capture, background
  lifetime and hosted-site linkage remain in the [held iOS scope](./todo.md#held-by-owner).
- Windows HDR-to-SDR has synthetic GPU and decoded-video evidence; it does not
  establish Browser-capture HDR conversion or end-to-end HDR. The
  [fidelity assessment](./research/media-fidelity.md#hdr-to-sdr) owns that boundary.
- Audio-exclusion availability follows actual platform capability. The
  [audio assessment](./research/native-client-media.md#windows-audio-exclusion)
  owns supported interfaces and isolation evidence.
- Room-voice acceptance uses synthetic microphones. It establishes the route and
  membership lifecycle, not acoustic echo performance on every physical device.
- Remote-control UI and routed input have local evidence. OS permissions,
  protected/admin applications and game compatibility retain the limits in the
  [input assessment](./research/room-interactions.md#attended-remote-control-prototype).
- A two-device Windows virtual-LAN trial established direct packaged-App web
  access and remote video after scoped firewall permission. Other networks must
  likewise carry HTTP/WebSocket and media UDP. [Virtual LAN research](./research/nat-traversal.md#routed-virtual-lan-discovery)
  owns the measured setup.

## Adaptation Boundaries

WebRTC and LiveKit own adaptation. The
[encoder-pool research](./research/webrtc-encoder-pool.md) and
[network controls](./research/network-lab.md#sustained-quality-recovery) distinguish
Native recovery fixes from Browser-controlled recovery and sustained-loss limits.
Browser scripts cannot tune the encoder's internal QP thresholds.

The combined 3.0 Native candidate's capture-free embedded Server passes the
VP8 and H264 dual-downlink restoration and healthy-sibling isolation controls.
When the connection grant falls below every available source representation,
forwarding pauses rather than changing another connection's source.
The H264 startup reproduction traced sequence gaps to a 64 KiB UDP receive
buffer. The shared socket correction receives the complete burst, and the
same Browser/Server startup reports zero loss for both supplied layers.
The combined Server candidate also carries room data and Opus/H264 RTP through
one real FRP UDP entry alongside IPv6. Peers retire independently; closing them
and the shared transport releases both address families' ports.
Its funded H264 encoding handoff survives an ignored first refresh request;
the old encoding keeps playing until the new keyframe is adopted.
In the earlier RTC/GoogCc Browser-to-Native H264 control, the constrained encoding follows
GoogCc's budget and ordinary AIMD growth; the supplied Original encoding is not reused within
the observed 20 seconds. A bounded check of the same controller exercises its
existing ALR probe requests when actual sending becomes supply-limited.

The selected str0m replacement passes real Browser-to-Native-to-Browser VP8
constrain/restore with a separate healthy voice pair, shared A/V source-time
mapping, warm-output handover and fixed/prepared UDP ownership. Normal room
acceptance also carries stereo sound, confirmed history and file data through
the Native operator. Its STUN and authenticated coturn checks use the same public
socket adapter. The current WGC/H264 8 Mbps → 600 kbps → 8 Mbps observation
uses the SDK controller and corrected local deadline handling. During restoration,
the lower encoding continues decoding while the higher encoding waits for its
budget. Both supplied feeds resume between 5.1 and 6.1 seconds after restoration.
The final ten seconds deliver about 16.2 fps on all four receiver/encoding paths;
matched high-encoding snapshots are byte-identical between receivers. The observer
now follows the production per-SSRC AU path, removing its obsolete shared replay
filter. Earlier failed observations retain their original source and results.
Receipts retain their exact source identities in the
[Native candidate index](../prototype/channel-native/README.md#rtc-dependency).

## Interpretation

Evidence applies to its tested revision, device and workload. Builds and local
controls establish their named behavior; they do not promise every remote network
or device or a population NAT success rate. Browser/OS suspension is not a
keepalive guarantee.
