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

## Reopen Boundary

A later native milestone must start from the then-current canonical contract and
stop at the first failed stage:

1. Prove current room creation, Host authorization, source/encoder identity,
   bounded queues, source RTP, and zero critical errors.
2. Prove one ordinary Browser Viewer through the current signaling and routing
   model, including exact offer/answer/ICE and decoded/rendered media.
3. Prove two independent transport legs while capture and encode remain shared
   and endpoint capacity remains authoritative.
4. Prove a third Viewer waits without creating a third edge, then is promoted
   when capacity releases.
5. Add application audio, PLI/FIR recovery, reconnect, source lifecycle,
   public-network/endurance, packaging, signature/update, and license gates.

The canary may not add a parallel room model, old wire, custom congestion
controller, room-wide minimum quality, another media transport, or claims of
hardware acceleration without process-and-adapter evidence. Direct/SFU behavior
must remain owned by ADR-0005.

## Consequences

- No native candidate constrains the current Browser product or route model.
- The obsolete sender runtime and private wire are deleted. Git owns that
  history; only the isolated capture fixture and measured evidence remain.
- Revalidation cost is explicit and cannot be hidden by preserving deprecated
  protocol or packaging surfaces.

## Evidence

- [Native sender and shared encode](../research/native-sender.md)
- [Browser screen audio](../research/browser-screen-audio-quality.md)
- [ADR-0005](./0005-automatic-hybrid-media-routing.md)
