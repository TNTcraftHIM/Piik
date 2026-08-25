# ADR-0007: Framework-Owned Media Quality Adaptation

- Status: Accepted, implemented, and deployed
- Date: 2026-08-19
- Last reviewed: 2026-08-25

## Context

Screener sends one realtime game-screen source through independent P2P
connections and, when needed, one shared LiveKit publication. WebRTC and
LiveKit already own congestion control, encoder adaptation, retransmission,
simulcast construction, subscriber bandwidth estimation, and layer selection.

Earlier experiments added a Screener-defined lower SFU encoding and treated
quality preference as an application policy. Production evidence showed that
an always-active lower encoding can compete with the highest encoding on a
constrained Host-to-SFU path. It did not justify replacing LiveKit's native
adaptation with a single HIGH representation or another application controller.

The product needs standard game-motion intent and user-selected ceilings, but
it does not need a second bitrate, resolution, FPS, or layer-control system.

## Decision

1. Browser video uses VP8 across direct, browser-relay, and SFU paths. Codec
   selection, backup codecs, runtime codec switching, and codec state in the
   room wire are not product features.
2. Display video uses the standard `contentHint = "motion"`; display audio uses
   `contentHint = "music"`. The hint expresses content intent and does not
   promise a resolution, frame rate, bitrate, encoder, or hardware path.
3. The three recommended profiles and advanced controls supply capture and
   sender ceilings plus `degradationPreference`. Every sender reads back the
   parameters that the browser actually accepted.
4. Direct and peer paths leave media adaptation to each `RTCPeerConnection`.
   After accepting an answer, the Host reapplies the current video profile to
   the negotiated sender because the browser may replace or rewrite encoding
   parameters during negotiation.
5. The SFU publisher sets VP8, the selected HIGH ceiling, and degradation
   preference, but does not set `screenShareSimulcastLayers`, mutate lower
   encodings, or select a subscriber layer. Pinned LiveKit defaults own the
   representation set and source-replacement/republish behavior.
6. LiveKit Dynacast and server send-side BWE remain enabled. AdaptiveStream
   remains disabled because a Viewer may relay its received track to peer
   children; local DOM size or visibility cannot represent that downstream
   demand.
7. Quality measurements are diagnostic. Bitrate, resolution, FPS, RTT, jitter,
   loss, freeze counters, codec, and limitation reason do not trigger parent
   selection, relay abdication, periodic rebalancing, or route changes. Only
   hard connection failure, the existing non-paused decoded-frame stall, parent
   departure, or capacity invalidation can make an active edge unusable.
8. A healthy decoded route remains sticky. Manual media reconnect rebuilds the
   current exact P2P parent or current SFU subscription; it does not search for
   a better parent. If current-route recovery genuinely exhausts, ADR-0005's
   existing controller tries other eligible P2P parents before SFU.

## Evidence Boundary

Chrome 151 production measurements established three durable facts:

- direct and browser-relay VP8 can sustain about 60 fps after stock bandwidth
  estimation warms up; sender ceilings are not startup guarantees;
- forcing an always-active lower SFU encoding can reduce the highest encoding
  on the same Host-to-SFU congestion budget; and
- pinned LiveKit `2.22.0` plus server `1.13.5` can select lower and higher VP8
  screen-share representations per subscriber when server send-side BWE is
  enabled.

Separate content-hint probes showed that `motion` changes Chromium's adaptation
tradeoff and may spatially downscale to preserve motion. That is the standard
behavior requested for games, not a quality floor. Real-game readability,
weaker Hosts, heterogeneous devices, and public-network SFU quality still
require physical evidence.

## Consequences

- Screener owns fewer media mechanisms and follows the pinned frameworks'
  supported control surfaces.
- A constrained Viewer may receive a lower LiveKit representation without
  lowering every subscriber, subject to the publisher and network actually
  sustaining the framework contract.
- A Host may need to lower its explicit share profile when encoder or uplink
  capacity is insufficient; Screener does not silently remove constrained
  Viewer support.
- Quality-based topology optimization remains unimplemented. Accepting it later
  requires evidence for alternative-path measurement and a separate route-model
  decision.

## Stop Lines

- No Screener resolution/FPS/bitrate ladder or representation formula.
- No manual SFU layer selector, forced single HIGH publication, or per-Viewer
  encoder.
- No quality score, all-pairs probing, periodic rebalancing, or speculative
  parent switching.
- No AdaptiveStream while a subscriber can relay the track.
- No quality or hardware claim from configured options alone.

## References

- [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [WebRTC](https://www.w3.org/TR/webrtc/)
- [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [LiveKit video simulcast and Dynacast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
- [LiveKit client 2.22.0 encoding construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit server 1.13.5 layer forwarding](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/forwarder.go)
