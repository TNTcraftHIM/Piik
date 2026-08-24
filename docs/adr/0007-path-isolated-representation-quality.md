# ADR-0007: Path-Isolated Representation Quality

- Status: Accepted quality/representation decision; topology capacity follows ADR-0005
- Date: 2026-08-19
- Last reviewed: 2026-08-25

## Context

Screener needs to protect a healthy viewer from another viewer's weak network or
decoder without growing host encode work with viewer count. Draft PR #28 proved
that one `VideoEncoder` object can be reconfigured from feedback shared by two
Pion/WebRTC legs. Its minimum-of-two target was deliberately conservative for a
bounded experiment. It is not an acceptable product policy: a weak leg would
lower the shared stream for every healthy leg, and the experiment did not test
heterogeneous estimates.

A single ordinary, non-scalable encoded representation has one resolution,
frame cadence, and rate-control result. Forwarding those packets cannot create
a second quality. Per-viewer quality therefore requires another encoded
representation, a negotiated scalable representation, or transcoding at a
relay/SFU. Per-viewer encoders would violate the game's performance budget.

## Decision

Use path-isolated representations:

1. Direct/peer paths keep their requested `HIGH` target and independent stock
   WebRTC congestion control. No viewer feedback changes another path's target.
2. The Browser Host's single SFU publication sends one `HIGH` VP8
   representation. LiveKit/WebRTC independently controls each SFU downlink,
   but the application does not publish `LOW`, enable simulcast or Dynacast, or
   add a media-layer selector.
3. Sender/viewer evidence diagnoses capture, encode, transport, receive, and
   decode behavior. It does not change topology or command ordinary built-in
   layer changes. ADR-0005 reacts only to an exact child edge's hard connection
   failure or non-paused decoded-frame stall.
4. A future dual-representation Browser path requires a new accepted decision
   and physical evidence that the additional representation does not reduce
   `HIGH`, game performance, or the Host-to-SFU upload budget.
5. The accepted Browser representation count is exactly one and never grows
   with Viewer count.

The pinned two-layer LiveKit candidate failed this gate. On exact production,
an always-active `LOW` consumed the same Host-to-SFU congestion budget and
reduced the progressing 1904x928 `HIGH` stream from about 23 fps to about 9 fps
under the measured public path. `LOW` therefore cannot remain active, and the
current Browser contract preserves only `HIGH`. A constrained SFU ingress may
still emit fewer frames because sender ceilings are not guarantees; that is a
stock WebRTC result, not authority to restore `LOW`, change routes, or add a
custom controller.

There is no weighted score, device ranking, machine-learning controller, custom
media selector, or continuous room-wide optimizer. Representation evidence does
not create route states.

The topology and representation budgets are independent invariants. Each
non-server endpoint follows ADR-0005 steady outbound media-copy capacity `C`
(`1`, `2`, or `3`, default `2`); the two-edge host result below is a historical
experiment configuration, not a fixed policy. A native relay forwards selected
encoded packets without decoding or re-encoding. Future dual-tree or striped
delivery may reduce host upload from about two full copies toward one copy plus
necessary redundancy, but it does not block this decision.

With one encoded representation, LiveKit may adapt an SFU downlink but cannot
create a second spatial representation. That does not alter relay eligibility.
If the exact ingress later hard-fails or stops decoding while unpaused,
ADR-0005 reparents that Viewer as a child and retains its subtree. Viewer
quality evidence cannot trigger route mutation or publication changes.

## Evidence Contract

For diagnosis and representation acceptance, correlate the same time interval
and stream generation across three stages:

| Stage | Required evidence |
| --- | --- |
| A. Capture | `MediaStreamTrack.getSettings()` width, height, and frame rate |
| B. Host outbound | actual width/FPS/bitrate, target or available bitrate when present, interval encode time, `qualityLimitationReason`, RTT, loss/retransmission, selected direct/SFU route, and derived negotiated video codec/profile/parameters plus `scalabilityMode` when applicable |
| C. Viewer inbound | actual width/FPS/bitrate, loss, jitter, interval decode/drop/freeze evidence, the corresponding derived codec/profile/parameters and applicable `scalabilityMode`, and actual decode behavior |

Interpretation is deliberately ordered:

| Observation | Classification |
| --- | --- |
| Capture is already low | capture or constraint problem |
| Capture high, outbound low, reason `cpu` | sender encode/resource pressure |
| Capture high, outbound low, reason `bandwidth` | congestion, uplink, GCC, or current-path pressure |
| Outbound healthy, inbound degraded | transport or receiver-path problem |
| Inbound metrics healthy, image still blurry | insufficient bitrate/quantization, negotiated codec/profile/layer, or display scaling problem |

WebRTC stats are sampled dictionaries and many useful counters are cumulative.
The evidence sampler must use adjacent, non-overlapping deltas and rebase on a missing
field, stream/stat ID change, or counter reset. Missing values remain unknown;
they are not zeros.

Implementation is staged. First correlate A and B locally in one sampling tick,
with an explicit interval, media/stat identity, and valid deltas. A minimal
authenticated C report may add receive/decode diagnosis after that probe is
trustworthy. The B/C correlation uses normalized fields derived from negotiated
parameters/stats and actual decode behavior; it must never upload raw SDP, raw
stats, candidate addresses, or raw device/network identifiers. Opaque
server-issued path and connection IDs authorize diagnostic correlation only.
Do not build a general telemetry schema.

Authenticated Viewer quality evidence may diagnose only its current path. It
cannot lower Host quality, start another representation, or change topology.

UA, platform, and device-model detection does not participate in quality or
relay-capacity selection. Browser capability queries can guide a bounded probe,
but runtime encode/decode behavior is authoritative.

## Standard Capability Short-Circuits

Inspect standard capabilities in order and stop at the first accepted path
before custom dual-representation media. Static API or pinned-protocol
incompatibilities can close a candidate without a browser run; runtime media
gates start only after the A+B/C evidence contract is trustworthy. These
results do not create an application media-layer selector or route authority:

1. **Web P2P simulcast: rejected
   (`no-go-web-p2p-simulcast-layer-selection`).** WebRTC exposes
   `getParameters()` and `setParameters()` on `RTCRtpSender`, including the
   sender-side `active` flag, but `RTCRtpReceiver` exposes only
   `getParameters()` and no standard per-RID layer-selection setter. A sender
   toggle is scoped to that sender and PeerConnection; separate viewer
   PeerConnections have no portable shared-encoder contract. The standard API
   therefore cannot provide one shared `HIGH`/`LOW` encode whose direct P2P
   receivers independently select a layer. Chrome was not run because the
   required product semantic is absent. In particular, the normative rule that
   `active=false` stops sending an encoding is not evidence that its physical
   encoder, CPU work, or GPU allocation is released.
2. **Pinned LiveKit two-layer simulcast: rejected for the current Browser
   contract (`no-go-livekit-always-on-low`).** Client 2.22.0 can publish a
   screen-share original plus one lower simulcast encoding, but server 1.13.5
   Dynacast enables every quality at or below the highest requested quality.
   Any `HIGH` subscriber therefore keeps `LOW` active; turning Dynacast on does
   not isolate the Host-to-SFU congestion budget.

   The exact production gate used Chrome 151, runtime `bf32859`, a continuously
   changing 1904x928 capture, and the same public SFU path. With ordered `q,h`
   encodings active, the `h` stream stabilized near 9.2 fps and 1.37 Mbps. With
   `q` inactive from the first sender-parameter application, `h` stabilized near
   23.3 fps and 3.32 Mbps while encoding took about 4.46 ms per frame, packet
   loss and retransmission remained zero, and the selected pair reported about
   4.81 Mbps available outgoing bitrate. Source and capture remained near 60
   fps. The lower representation therefore consumed the shared ingress budget
   and materially reduced `HIGH`; the candidate fails the existing stop line.

   The current Browser decision is one `HIGH` representation without simulcast,
   Dynacast, or a manual layer controller. The measured public `q`-inactive A/B
   remained bandwidth-constrained, so this verdict does not claim SFU 60 fps or
   replace the pending exact single-representation production gate.
   Reopening a dual/native representation is a new decision with new physical
   game, encoder, and upload evidence.
3. **Current Web/LiveKit SVC: rejected
   (`no-go-web-svc-cross-path-hardware-contract`).** WebRTC-SVC adds
   `scalabilityMode` to sender encoding parameters, but it adds no receiver
   setter for choosing a base or enhancement layer. The setting is scoped to
   one `RTCRtpSender`; separate viewer PeerConnections still have no portable
   shared-encoder or cross-connection layer-selection contract. An applied
   `scalabilityMode` proves only the browser's configured mode. The SVC
   specification explicitly says successful mode probing cannot distinguish a
   hardware encoder from a software encoder, while Media Capabilities
   `powerEfficient` and RTCStats `powerEfficientEncoder` are user-agent-defined
   signals rather than hardware guarantees.

   Pinned LiveKit narrows the result further. Client 2.22.0 overwrites SVC
   screen-share publication to `L1T3`: one spatial resolution and three temporal
   layers, so it provides no low-resolution base and exceeds this product's
   current one-representation contract. Its `RemoteTrackPublication.setVideoQuality()`
   controls per-subscriber spatial quality, while server 1.13.5 maps
   quality/dimensions/FPS to requested spatial/temporal maxima. Actual selection
   remains codec-dependent: VP8 has a temporal selector, whereas H.264/H.265
   simulcast is spatial-only. That selection exists only on an SFU downtrack;
   it does not extend to Screener's direct/peer receivers. The current
   subscriber only requests the publication, and LiveKit documents that
   Dynacast can pause an entire SVC
   stream but not individual SVC layers. Chrome ships the outgoing-track API;
   current Firefox and WebKit WebIDL do not expose the standard
   `scalabilityMode` member, and Firefox's implementation remains behind a
   preference. A pinned-SDK Safari compatibility branch is not a portable
   standard contract. These static blockers cannot be changed by a Chrome
   media run, so no harness was written and no browser was run.

None may reuse PR #28's minimum-of-two target, bypass a per-edge stock WebRTC
congestion controller, or expand the current one-representation contract.

## SVC Static Verdict

This static verdict rejects current Web/LiveKit SVC; the two-layer LiveKit
simulcast candidate is independently rejected by its physical gate. Requested
and post-negotiation applied
`scalabilityMode` remain useful diagnostics, because the browser may apply a
different mode or omit the field when none was requested. They are not proof
of the actual hardware implementation, and neither a support query nor a
browser resource run can add SVC's missing direct/peer receiver-selection
contract.

This rejection is scoped to the current standard Web/LiveKit shortcut, not to
scalable codecs forever. A future native sender may reopen SVC only if its media
API positively selects a hardware encoder without silent software fallback,
publishes at most two decodable layers, reuses one encoded output across direct,
peer, and SFU transports, preserves independent path selection, and passes the
same game-performance and latency gates. That would be a new native capability
decision, not completion of this browser spike.

## Consequences

Positive:

- Healthy viewers are not reduced to the worst path.
- Browser SFU uses one outbound `HIGH` representation, so publication and
  ingress cost stay bounded independently of Viewer count.
- The diagnostic evidence remains inspectable.

Negative:

- A weak SFU downlink cannot select a separate low-resolution representation;
  stock congestion control may reduce bitrate, resolution, or encoded cadence.
- A configured 60 fps ceiling is not a delivery guarantee on a constrained
  Host-to-SFU path.
- Browser capability reporting cannot by itself prove hardware or sustained
  decode performance. The current SVC path is rejected before that matrix;
  custom/native candidates still require it.

## Product Stop Lines

- Do not productize PR #28's minimum-of-two bitrate or frame-rate aggregation.
- Do not use simulcast, Dynacast, SVC, or an SFU as a semantic bypass around
  PR #28's stock-GCC/RTX stop line or per-edge congestion control.
- Do not lower `HIGH` because one viewer reports trouble.
- Do not create one representation or encoder per viewer.
- Do not use UA/device identity as a quality signal.
- Do not enable software SVC as an invisible fallback.
- Do not publish `LOW` in the current Browser contract.
- Do not add a composite health score or media selector when built-in adaptation
  and ADR-0005 edge recovery suffice.

## Verification Gates

- Direct/peer paths retain independent stock WebRTC congestion control.
- An active Browser SFU publication exposes exactly one outbound video RTP
  encoding using VP8, with no `q,h` RID simulcast or second representation.
- Host and relay endpoint media copies follow ADR-0005 steady capacity `C`;
  SFU publication accounting is unchanged by the representation decision.
- Built-in BWE downshift and recovery remain local to each SFU subscription and
  do not change topology. Exact ingress failure is handled only by ADR-0005's
  generic child reparent operation.
- Controlled exact-production evidence records source, capture, encode, send,
  receive, decode, render, selected transport, bitrate, loss, and encoder cost;
  it does not require 60 fps where the measured path cannot carry it.
- No second representation sends frames or bytes, and a Viewer quality report
  cannot start one.
- Native relays show packet forwarding without an added decode/encode stage.
- Spoofed, stale, duplicated, or rate-excessive viewer requests have no effect.
- Controlled capture/CPU/bandwidth/direct/SFU/receiver/display cases produce the
  classifications in the evidence table without a room-wide downgrade.

## References

Primary sources checked through 2026-08-25:

- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [W3C WebRTC SVC](https://www.w3.org/TR/webrtc-svc/)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)
- [W3C WebRTC simulcast](https://www.w3.org/TR/webrtc/#simulcast-functionality)
- [Chrome 111 WebRTC SVC extension](https://developer.chrome.com/blog/chrome-111-beta)
- [Chromium `RTCRtpEncodingParameters` WebIDL](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/peerconnection/rtc_rtp_encoding_parameters.idl)
- [Firefox `RTCRtpEncodingParameters` WebIDL](https://searchfox.org/firefox-main/source/dom/webidl/RTCRtpParameters.webidl)
- [Firefox WebRTC-SVC implementation status](https://bugzilla.mozilla.org/show_bug.cgi?id=1571470)
- [WebKit `RTCRtpEncodingParameters` WebIDL](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/RTCRtpEncodingParameters.idl)
- [LiveKit video simulcast and Dynacast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
- [LiveKit client 2.22.0 room defaults](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/defaults.ts)
- [LiveKit client 2.22.0 room and Dynacast options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/options.ts)
- [LiveKit client 2.22.0 room option merge](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/Room.ts)
- [LiveKit client 2.22.0 SVC defaults](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [LiveKit client 2.22.0 screen-share SVC and publish-option handling](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/LocalParticipant.ts)
- [LiveKit client 2.22.0 SVC encoding construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit client 2.22.0 subscriber quality control](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/RemoteTrackPublication.ts)
- [LiveKit server 1.13.5 per-subscriber layer application](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/subscribedtrack.go)
- [LiveKit client 2.22.0 Dynacast layer control](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/LocalVideoTrack.ts)
- [LiveKit server 1.13.5 Dynacast quality aggregation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastqualityvideo.go)
- [LiveKit server 1.13.5 enabled-quality generation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastmanagervideo.go)
