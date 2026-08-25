# ADR-0007: LiveKit-Owned SFU Representation Adaptation

- Status: Accepted, implemented, and deployed
- Date: 2026-08-19
- Last reviewed: 2026-08-25

## Context

Direct and peer paths already have independent `RTCPeerConnection` congestion
controllers. The SFU path is different: one Host publication serves several
subscribers, so a weak subscriber needs a lower encoded representation without
lowering every healthy subscriber or creating one encoder per Viewer.

A single non-scalable full-resolution representation cannot provide that spatial
downshift because an SFU forwards encoded packets and does not transcode them.
The earlier production A/B compared an always-active two-encoding publication
against its lower representation disabled. It showed that the always-active
lower representation competed with the full representation on that constrained
Host-to-SFU path; it did not test
LiveKit-owned demand-driven layer control and does not justify a permanent
single-encoding contract.

The earlier application-layer controller discussion started from the false
premise that LiveKit/WebRTC did not already own per-subscriber bandwidth
estimation and layer selection. Built-in media control is the default owner.
Screener supplies the bounded representations and product ceilings but does not
reimplement that controller. A resource-constrained Host can explicitly choose
a lower existing share profile; the product does not protect it by silently
removing the representation required by constrained Viewers.

## Decision

1. Direct and peer paths retain independent stock WebRTC congestion control.
   Viewer feedback is never aggregated into a room-wide target.
2. The Browser Host SFU publication provides two bounded VP8 screen-share
   representations: one half-resolution encoding and the original full-resolution
   encoding. The lower representation keeps at most 30 fps and derives its
   bitrate from the pinned SDK's pixel-and-frame-rate formula; the representation
   count is fixed and does not grow with Viewer count.
3. LiveKit Dynacast and its per-subscriber stream allocator/BWE own publication
   layer activation and the actual layer forwarded to each SFU subscriber.
   Screener does not implement a quality score, bandwidth estimator, periodic
   layer controller, or per-Viewer encoder.
4. A subscriber's `HIGH` request is a ceiling, not a forced delivery layer. A
   weak downlink may receive the lower representation while another subscriber
   receives the highest available representation when the pinned LiveKit stack
   can sustain that contract.
5. AdaptiveStream is a display-demand input, not a network detector. Current
   Screener subscribers keep it disabled because any Viewer may become a relay
   and LiveKit cannot see that Viewer's peer children. Network adaptation uses
   the server stream allocator/BWE instead.
6. ADR-0005 remains the only route owner. Layer choice does not change topology,
   endpoint capacity, SFU admission, or decoded-stall recovery authority.

Production release `e14eb0e` left the screen-share layer list unset, so pinned
client `2.22.0` supplies a same-FPS half-resolution representation beside the
original. A live mixed P2P/SFU observation confirmed that the 60 fps lower
representation can consume enough Host-to-SFU budget to starve the highest
representation. The accepted correction keeps LiveKit's two-layer ownership but
supplies one half-resolution lower preset with
`lowFps = min(30, highFps)` and the SDK's existing proportional bitrate formula.
The two encodings remain RIDs `q,h`; LiveKit's protocol labels them `LOW,MEDIUM`,
while a subscriber's default `HIGH` ceiling still selects the highest available
encoding. Dynacast, server send-side BWE, and disabled AdaptiveStream remain
unchanged. Production release `be53c4d` deploys that correction.

Current source derives the lower preset from the actual capture dimensions and
passes it through LiveKit's public publication options. Retained publication
options give LiveKit the same preset on its own source-replacement or republish
boundary; Screener does not mutate the active lower encoding behind LiveKit's
Dynacast sender lock.

## Pinned Physical Result

The 2026-08-25 gate used LiveKit server `1.13.5`, client `2.22.0`, Chrome 151,
a continuously changing VP8 source, and one full-resolution plus half-resolution
screen-share publication. Manual maximum/lower selection delivered `1280x720`
and `640x360` at about 30 fps, and the same connection recovered from the lower
to the full-resolution representation.

With the server default receiver-side BWE, an approximately 0.96 Mbps subscriber
remained on HIGH for about 21 seconds and ended at zero decoded fps. Enabling
LiveKit `congestion_control.use_send_side_bwe` made the native stream allocator
select LOW; by the third steady window it delivered `640x360` at about 29 fps and
88 KB/s. A fresh unshaped subscriber immediately received HIGH. The constrained
connection's automatic upgrade after removing shaping was not isolated because
Chrome bound that test condition when creating the PeerConnection; manual and
AdaptiveStream same-connection LOW-to-HIGH recovery were independently proven.

Dynacast paused layers with no subscribers after about five seconds. Lower-only
demand disabled the full-resolution encoding, while maximum demand kept both
encodings active; the second VP8 simulcast encode is therefore an accepted
bounded cost, not eliminated by Dynacast. AdaptiveStream selected the full
representation for a large attached element, the lower representation for a
small element, paused a hidden element, and recovered when visible. With no
attached element it received only the lower representation, confirming that it
cannot own relay ingress. This gate established the framework combination of
VP8 screen-share simulcast, Dynacast, server send-side BWE, and
`adaptiveStream: false`; the later production observation amends only the lower
representation's FPS and proportional bitrate.

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
  count. Dynacast pauses representations above aggregate demand and all
  representations when no subscriber remains; maximum demand keeps both VP8
  simulcast encodings active.
- Host encode capacity is handled through the existing explicit share profiles,
  not by falling back to one encoding and abandoning constrained subscribers.
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
