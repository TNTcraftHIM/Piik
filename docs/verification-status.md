# Verification Status

Last updated: 2026-10-25

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
- Android embedded and system-browser APKs passed emulator screen/camera sharing
  with concurrent room voice. Browser consent returns to the same tab; source
  replacement, cancellation and background return preserve the share. Local/public
  startup and launcher reentry also have emulator evidence. Phone/tablet/TV
  hardware and physical audio remain in the [Android acceptance scope](./todo.md#next).
- The iOS source prototype has a local capture probe and generated Objective-C
  bindings for the shared mobile Go bridge. Swift integration and Apple SDK/device
  acceptance remain in the [iOS scope](../mobile/ios/README.md#integration-boundary).
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
