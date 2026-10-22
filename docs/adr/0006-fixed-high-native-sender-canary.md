# ADR-0006: Fixed-HIGH Native Sender Canary

- Status: superseded; historical evidence retained
- Date: 2026-08-19
- Last updated: 2026-09-02

## Context

A native sender could capture and encode once while serving bounded independent
WebRTC legs, reducing Browser capture/encode cost. Early WebCodecs/Pion and
Windows hardware fixtures proved isolated pieces but not compatibility with the
current room, signaling, routing, audio, packaging, and Browser Viewer contract.

## Decision

The fixed-HIGH native sender candidate is not a product surface and its private
wire remains deleted. The current native App boundary is defined by
[ADR-0010](./0010-cross-platform-client-runtime.md).

The deleted one-Viewer loopback proved that a fixed 1280x720@30 source could
authenticate, negotiate one independent Pion leg, and deliver decoded/rendered
Browser frames. Later Windows WGC/Media Foundation work proved one attributed
hardware H.264 path. Those are bounded functional facts, not evidence for two
Viewers, shared congestion behavior, audio/A-V sync, public networks, recovery,
endurance, packaging, licensing, or production.

## Consequences

- No native candidate constrains the current Browser product or route model.
- The obsolete sender runtime and private wire are deleted. Git owns that
  history; only the isolated capture fixture and measured evidence remain.
- Later Native media decisions and evidence belong to
  [ADR-0013](./0013-embedded-node-local-media.md) and
  [Native media research](../research/native-client-media.md).

## Evidence

- [Native sender and shared encode](../research/native-sender.md)
- [Browser screen audio](../research/browser-screen-audio-quality.md)
- [ADR-0005](./0005-automatic-hybrid-media-routing.md)
