# Verification Status

Last updated: 2026-10-30

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

## Device Evidence Boundary

- macOS/Linux builds and bounded native checks are distinct from physical
  capture and input. Physical platform coverage remains limited.
- The isolated 3.0 Linux adapter passes Native/App/Server compilation and real
  GStreamer encoding checks in a Linux VM. Synthetic frames cover independent
  encoders, backpressure, resizing, source timestamps, keyframes and teardown;
  synthetic PCM covers queue-loss gaps. Desktop Portal consent, hardware encoding
  and physical sound remain platform acceptance work.
- Android's system-browser App passed emulator screen/camera sharing
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

## Interpretation

Evidence applies to its tested revision, device and workload. Builds and local
controls establish their named behavior; they do not promise every remote network
or device or a population NAT success rate. Browser/OS suspension is not a
keepalive guarantee.
