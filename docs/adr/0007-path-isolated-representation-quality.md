# ADR-0007: LiveKit-Owned SFU Representation Adaptation

- Status: Accepted design target; implementation and deployment held for the pinned physical gate
- Date: 2026-08-19
- Last reviewed: 2026-08-25

## Context

Direct and peer paths already have independent `RTCPeerConnection` congestion
controllers. The SFU path is different: one Host publication serves several
subscribers, so a weak subscriber needs a lower encoded representation without
lowering every healthy subscriber or creating one encoder per Viewer.

A single non-scalable `HIGH` representation cannot provide that spatial
downshift because an SFU forwards encoded packets and does not transcode them.
The earlier production A/B compared an always-active `LOW+HIGH` publication
against `LOW` disabled. It showed that the always-active lower representation
competed with `HIGH` on that constrained Host-to-SFU path; it did not test
LiveKit-owned demand-driven layer control and does not justify a permanent
single-`HIGH` contract.

## Decision

1. Direct and peer paths retain independent stock WebRTC congestion control.
   Viewer feedback is never aggregated into a room-wide target.
2. The Browser Host SFU publication provides bounded VP8 `HIGH` and `LOW`
   simulcast representations. The representation count is fixed and does not
   grow with Viewer count.
3. LiveKit Dynacast and its per-subscriber stream allocator/BWE own publication
   layer activation and the actual layer forwarded to each SFU subscriber.
   Screener does not implement a quality score, bandwidth estimator, periodic
   layer controller, or per-Viewer encoder.
4. `HIGH` is a subscriber ceiling, not a forced delivery layer. A weak downlink
   may receive `LOW` while another subscriber remains on `HIGH` when the pinned
   LiveKit stack can sustain that contract.
5. AdaptiveStream is a display-demand input, not a network detector. It may be
   used only when the LiveKit `RemoteVideoTrack` is attached to the actual leaf
   Viewer element. It must not derive an SFU-fed relay's subscription from that
   relay page's element size or visibility because LiveKit cannot see the
   relay's peer children.
6. ADR-0005 remains the only route owner. Layer choice does not change topology,
   endpoint capacity, SFU admission, or decoded-stall recovery authority.

Current source and production remain the deployed single-`HIGH` implementation
until the gate below passes and a separate implementation is integrated. That
is deployment state, not the accepted quality target.

## Pinned Physical Gate

Use LiveKit server `1.13.5`, client `2.22.0`, Chrome 151, one continuously
changing VP8 source, and one `HIGH+LOW` screen-share publication. Record adjacent
publisher outbound-RTP deltas by RID plus subscriber inbound resolution, frame,
and byte deltas for these states:

1. no subscriber, then one `HIGH` subscriber;
2. the same subscriber requesting `LOW`, then recovering to `HIGH`;
3. a leaf subscriber using AdaptiveStream while its attached element changes
   between large, small, hidden, and visible;
4. an SFU-fed relay without a LiveKit-attached display element.

The gate must establish which layers actually encode and send, not merely which
options were requested. It passes the product target only if LiveKit owns the
transitions, a low demand can receive a lower spatial representation, recovery
returns to `HIGH`, and an unrelated weak or hidden leaf does not lower a healthy
subscriber. CPU, bitrate, and FPS evidence must distinguish an inactive layer
from one that remains encoded but is not forwarded.

If the fixed stack cannot provide demand-driven activation, stop at the
dependency decision. Do not compensate with a Screener layer controller.

## Evidence Boundary

The retained exact-production A/B used Chrome 151 with an always-active ordered
`q,h` publication. The 1904x928 `h` stream was about 9.2 fps / 1.37 Mbps with
both encodings active and about 23.3 fps / 3.32 Mbps with `q` inactive. Capture
remained near 60 fps, encode cost was about 4.46 ms per frame, loss and
retransmission were zero, and available outgoing bitrate was about 4.81 Mbps.
This rejects always-on `LOW` for that path. It does not establish Dynacast,
AdaptiveStream, heterogeneous subscriber behavior, or real-game performance.

Quality evidence remains diagnostic. Track availability, bitrate, resolution,
FPS, RTT, jitter, loss, codec and current LiveKit layer cannot authorize route
mutation or predict another parent.

## Consequences

- A weak SFU Viewer can receive a real lower spatial representation when the
  framework selects it; the SFU does not transcode.
- The Host publishes at most two SFU representations regardless of Viewer
  count, and Dynacast is responsible for avoiding unused work where supported.
- An SFU-fed relay keeps a subscription ceiling sufficient for its subtree;
  local DOM visibility alone cannot pause that ingress.
- A configured 60 fps or bitrate remains a ceiling, not a delivery guarantee.

## Stop Lines

- Do not create one encoder or representation per Viewer.
- Do not add application quality scoring, periodic polling, manual layer
  switching, or quality-driven reparenting.
- Do not use AdaptiveStream without the LiveKit track attachment contract.
- Do not infer Dynacast success from configuration or source inspection alone.
- Do not apply SFU layer policy to ordinary direct or peer paths.

## References

Primary sources checked through 2026-08-25:

- [LiveKit video simulcast and Dynacast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
- [LiveKit client 2.22.0 room options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/options.ts)
- [LiveKit client 2.22.0 AdaptiveStream track attachment](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/RemoteVideoTrack.ts)
- [LiveKit client 2.22.0 subscriber quality ceiling](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/RemoteTrackPublication.ts)
- [LiveKit client 2.22.0 Dynacast handling](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/LocalParticipant.ts)
- [LiveKit server 1.13.5 per-subscriber layer application](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/subscribedtrack.go)
- [LiveKit server 1.13.5 Dynacast quality aggregation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastqualityvideo.go)
- [LiveKit server 1.13.5 enabled-quality generation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastmanagervideo.go)
