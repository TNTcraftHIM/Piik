# Verification Status

Last updated: 2026-10-20

This file summarizes evidence boundaries that materially affect product claims.
[Status](./status.md) owns candidate and deployment readiness; research owns
measurements and platform details.

## Current Evidence

Windows App and Browser are the primary acceptance targets. The local room-voice
candidate passed the normal Host/Viewer flows on P2P and embedded SFU, including
permissions, forwarding, source replacement and recovery. Native H264/VP8,
constrained-network recovery, the media lifecycle, responsive UI and packaging
checks also passed. Exact results stay with their measured artifacts and revision.

The owner accepted the earlier scoped interaction, Native and Browser media
phases, including NAT and Auto codec behavior.

## Device Evidence Boundary

- macOS/Linux builds and bounded native checks are distinct from physical
  capture and input. Physical platform coverage remains limited.
- Windows HDR-to-SDR has synthetic GPU and decoded-video evidence; it does not
  establish Browser-capture HDR conversion or end-to-end HDR. The
  [fidelity assessment](./research/media-fidelity.md#hdr-to-sdr) owns that boundary.
- Audio-exclusion availability follows actual platform capability. The
  [audio assessment](./research/native-client-media.md#windows-audio-exclusion)
  owns supported interfaces and isolation evidence.
- Room-voice acceptance uses synthetic microphones. It establishes the route and
  permission lifecycle, not acoustic echo performance on every physical device.
- Remote-control UI and routed input have local evidence. OS permissions,
  protected/admin applications and game compatibility retain the limits in the
  [input assessment](./research/room-interactions.md#attended-remote-control-prototype).
- A virtual LAN must carry both HTTP/WebSocket and media UDP. Host firewall
  permission remains necessary; a proxy-based trial does not establish direct
  App reachability. [Virtual LAN research](./research/nat-traversal.md#routed-virtual-lan-discovery)
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
