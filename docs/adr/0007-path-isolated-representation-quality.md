# ADR-0007: Framework-Owned Media Quality Adaptation

- Status: Accepted
- Date: 2026-08-19
- Last reviewed: 2026-08-30

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

1. Browser video makes one internal, share-generation-scoped codec decision per
   sending endpoint. A bounded
   actual-`RTCPeerConnection` preflight measures H.264 encoded progress against
   a deterministic moving probe track at the current share's effective target
   dimensions and frame rate. The real capture supplies those target settings,
   but its current motion does not decide encoder capability. A proved sender
   prefers H.264 and retains VP8 as
   the native negotiation fallback; an unsupported, inconclusive, slow, or
   failed preflight uses VP8 only. The Host advanced settings expose one local
   `VP8 | Auto | H264` selector with Auto default: it is editable only before a
   share, strict H264/VP8 bypass the gate, and share start locks it. Viewer relay
   senders remain Auto. The selection is not persisted or inferred from UA, GPU,
   capability advertisement, or `powerEfficientEncoder` alone; it creates no
   room state, wire field, or active-edge codec switching.
2. Display video uses the standard `contentHint = "motion"`; display audio uses
   `contentHint = "music"`. The hint expresses content intent and does not
   promise a resolution, frame rate, bitrate, encoder, or hardware path.
3. The three recommended profiles and advanced controls supply capture and
   sender ceilings plus `degradationPreference`. Every sender reads back the
   parameters that the browser actually accepted.
4. Every direct, Browser-relay, and Host SFU video sender owns one
   `MediaStreamTrack` clone. The original capture or received track remains a
   source and local presentation track and is never attached directly to an
   outbound sender. The sender owner retains the game-motion content intent and
   current enabled state, applies live Host capture constraints to Host-owned
   clones, and stops the clone on replacement, rollback, failure, unpublish, or
   teardown. After accepting an answer, the Host still reapplies the current video profile to
   the negotiated sender because the browser may replace or rewrite encoding
   parameters during negotiation.
5. Auto direct and Browser-relay offers with a proved sender order H.264 before
   VP8 in one standard codec-preference list; endpoints select their first common
   codec without a parallel media connection. Failed Auto or manual VP8 offers
   VP8 only; manual H264 offers H.264 mode 1 only. Existing edges are not
   renegotiated when a later relay gate completes; its result applies to future
   children.
6. The SFU publisher uses the Host source decision and one sender-owned clone for
   its publication, disables backup codec, sets the selected HIGH ceiling and
   degradation preference, but does not set `screenShareSimulcastLayers`, mutate
   lower encodings, or select a subscriber layer. Pinned LiveKit defaults own the
   selected codec's representation set and source-replacement/republish behavior.
7. LiveKit Dynacast and server send-side BWE remain enabled. AdaptiveStream
   remains disabled because a Viewer may relay its received track to peer
   children; local DOM size or visibility cannot represent that downstream
   demand.
8. WebRTC and LiveKit remain the media-adaptation owners. ADR-0005's deployed
   native-edge convergence may consume only a persistent categorical limitation
   from the exact sender and comparative delivery proof from the same Viewer over
   a real prepared candidate. It does not set bitrate, resolution, FPS, or layer,
   infer a physical bottleneck, or combine quality measurements into a score.
9. A healthy decoded route remains sticky. Manual media reconnect rebuilds the
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

The exact Chrome 151/153 comparison in realtime-quality research established
why this decision is runtime-evidence driven: the cadence-failing AMD H.264 MFT
and the full-cadence NVIDIA H.264 MFT both reported hardware efficiency. Source
versus encoded-frame progress separated them. Chrome 153 then sustained the
same H.264 path with two senders, Browser relay re-encoding, and one pinned
LiveKit HIGH+LOW publication without backup codec.

A separate Chrome 151 display-capture experiment distinguished bare cloning
from sender-owned clone generations. With a preview-only original track, a
constrained sender could remain adapted after its bitrate budget recovered, but
retiring that sender and its clone let a new clone return immediately to about
30 fps at high resolution. Simultaneous clones still showed transient shared-
source interference, so this decision prevents adaptation inheritance rather
than claiming complete source isolation.

## Consequences

- Screener owns fewer media mechanisms and follows the pinned frameworks'
  supported control surfaces.
- A capable Browser Host or relay can use H.264 hardware encoding while another
  sender remains on VP8 without a room-protocol branch; the Host can explicitly
  override one future share for diagnosis or preference.
- A constrained Viewer may receive a lower LiveKit representation without
  lowering every subscriber, subject to the publisher and network actually
  sustaining the framework contract.
- A retired sender cannot leave its adapted video track attached to the source
  generation used by a replacement sender. Cloning adds one track adapter per
  outbound video sender but no additional capture or encoder beyond the sender
  that already exists.
- A Host may need to lower its explicit share profile when encoder or uplink
  capacity is insufficient; Screener does not silently remove constrained
  Viewer support.
- ADR-0005's native-edge local convergence is deployed and performs bounded
  real-candidate comparisons without owning media adaptation. Weighted or global
  topology optimization still requires another route-model decision.

## Stop Lines

- No Screener resolution/FPS/bitrate ladder or representation formula.
- No codec wire/state, GPU/MFT allowlist, persistent codec cache, parallel
  VP8/H.264 route, active-edge codec churn, or LiveKit backup publication. The
  local pre-share Host selector is the only manual codec surface.
- No manual SFU layer selector, forced single HIGH publication, or per-Viewer
  encoder.
- No quality score, all-pairs probing, periodic rebalancing, or parent switching
  outside ADR-0005's native-edge operation.
- No AdaptiveStream while a subscriber can relay the track.
- No claim that track clones isolate their shared underlying media source.
- No quality or hardware claim from configured options alone.

## References

- [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [WebRTC](https://www.w3.org/TR/webrtc/)
- [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [LiveKit video simulcast and Dynacast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
- [LiveKit client 2.22.0 encoding construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit server 1.13.5 layer forwarding](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/forwarder.go)
