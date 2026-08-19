# ADR-0007: Demand-Driven Dual-Representation Quality

- Status: Accepted - Staged Implementation
- Date: 2026-08-19

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

Use demand-driven dual representations:

1. A healthy room runs one shared `HIGH` representation.
2. Every viewing path starts in `HIGH`. It moves to `FALLBACK` only after
   multiple consecutive sampling windows show that the path cannot sustain
   `HIGH`, using correlated sender and viewer evidence.
3. The first verified fallback path must start exactly one shared `LOW`
   representation. Every verified weak path moves to that same representation.
   Healthy paths remain on `HIGH`.
4. A fallback path returns to `HIGH` only after a longer, independently defined
   stable-recovery window. When no path needs `LOW`, deactivate the
   representation and verify its bytes, frames, and resource cost stop.
5. The representation count is a hard `HIGH + at most one on-demand LOW <= 2`;
   it never grows with viewer count.

Starting `LOW` is conditional on a qualified hardware/power-efficient media
path and measured spare game-performance budget. If that path is absent or the
additional representation causes unacceptable CPU/GPU/game load, fail closed for that
attempt: preserve `HIGH` and show the weak path an explicit degraded/unavailable
state. This is exceptional damage containment, not permission to ignore a weak
path indefinitely. A supported sender cohort that cannot reliably start `LOW`
on demand fails automatic-quality-control acceptance; optimize its encode path
or mark that cohort unsupported. Never protect a weak path by reducing `HIGH`.

The two path states use explicit predicates and asymmetric entry/exit windows.
There is no weighted score, device ranking, machine-learning controller, or
continuous room-wide optimizer. Exact thresholds remain implementation inputs
until the controlled quality matrix establishes them.

The topology and representation budgets are independent invariants. The host
still has at most two downstream media edges. A native relay forwards selected
encoded packets without decoding or re-encoding. Future dual-tree or striped
delivery may reduce host upload from about two full copies toward one copy plus
necessary redundancy, but it does not block this decision.

## Evidence Contract

Before implementing automatic switching, correlate the same time interval and
stream generation across three stages:

| Stage | Required evidence |
| --- | --- |
| A. Capture | `MediaStreamTrack.getSettings()` width, height, and frame rate |
| B. Host outbound | actual width/FPS/bitrate, target or available bitrate when present, interval encode time, `qualityLimitationReason`, RTT, loss/retransmission, selected direct/TURN route, and derived negotiated video codec/profile/parameters plus `scalabilityMode` when applicable |
| C. Viewer inbound | actual width/FPS/bitrate, loss, jitter, interval decode/drop/freeze evidence, the corresponding derived codec/profile/parameters and applicable `scalabilityMode`, and actual decode behavior |

Interpretation is deliberately ordered:

| Observation | Classification |
| --- | --- |
| Capture is already low | capture or constraint problem |
| Capture high, outbound low, reason `cpu` | sender encode/resource pressure |
| Capture high, outbound low, reason `bandwidth` | congestion, uplink, GCC, or TURN/path pressure |
| Outbound healthy, inbound degraded | transport or receiver-path problem |
| Inbound metrics healthy, image still blurry | insufficient bitrate/quantization, negotiated codec/profile/layer, or display scaling problem |

WebRTC stats are sampled dictionaries and many useful counters are cumulative.
The controller must use adjacent, non-overlapping deltas and rebase on a missing
field, stream/stat ID change, or counter reset. Missing values remain unknown;
they are not zeros.

Implementation is staged. First correlate A and B locally in one sampling tick,
with an explicit interval, media/stat identity, and valid deltas. Only after
that probe is trustworthy may the product add a minimal authenticated C report
for the few receive/decode signals required by the two-state predicate. The B/C
correlation uses normalized fields derived from negotiated parameters/stats and
actual decode behavior; it must never upload raw SDP, raw stats, candidate
addresses, or raw device/network identifiers. Opaque server-issued path and
connection-generation IDs remain required for authorization and correlation.
Do not build a general telemetry schema.

A viewer may request `LOW`, but the request is advisory. It must be carried on
an authenticated, current room/path session and be rate-limited and deduplicated.
The sender/controller accepts it only when viewer receive/decode behavior and
derived negotiated codec/profile/parameters (including applicable
`scalabilityMode`) agree with sender transport/GCC and encode evidence. A
request alone cannot lower quality or start a representation.

UA, platform, and device-model detection does not participate in quality
selection. The existing mobile/iPad heuristic remains limited to conservative
relay-capacity admission. Browser capability queries can guide a bounded probe,
but runtime encode/decode behavior is authoritative.

## Deferred Capability Spikes

These spikes start only after the A+B/C evidence contract is trustworthy. They
run in order and stop at the first accepted path, may proceed independently of
ADR-0006 native-sender revalidation, and precede any custom dual-representation
media implementation. They do not change the accepted two-state controller:

1. Negotiate exactly two `HIGH`/`LOW` simulcast encodings on one sender in its
   initial envelope, with `LOW` inactive. Verify requested/applied parameters,
   per-RID traffic, restart behavior, and actual encoder/CPU/GPU release when
   `LOW` is inactive. W3C `active=false` stops that encoding from being sent;
   it does not guarantee that a physical encoder or GPU resource is released.
   Separate direct PeerConnections have no portable shared-encode contract.
2. On the SFU path, publish at most two LiveKit simulcast
   representations and let each one or two roots select independently. Treat
   Dynacast as a bounded rejection/verification spike, not an assumed fit. The
   pinned server 1.13.5 aggregates the maximum quality requested across all
   subscribers/nodes and marks every quality `q <= maxQuality` enabled; client
   2.22.0 applies those flags to simulcast encoding `active`. Thus any `HIGH`
   root is expected to keep `LOW` enabled. Firefox disabling is only a roughly
   10 bps, 2 fps, 4x-scale compatibility reduction. Accept this path only if
   actual per-RID bytes/frames plus host CPU/GPU/encoder evidence prove that
   `LOW` stops while `HIGH` continues; otherwise reject it for the exact
   on-demand-`LOW` requirement.
3. Run a bounded SVC viability spike and compare the applied
   codec/`scalabilityMode` with Media Capabilities `powerEfficient` and the
   game-performance matrix. If simulcast and LiveKit/Dynacast fail while this
   path meets current on-demand selection and resource gates, adopt it and stop
   before custom media. Reject silent software fallback.

None may reuse PR #28's minimum-of-two target, bypass a per-edge stock WebRTC
congestion controller, or expand the representation limit beyond two.

## SVC Boundary

SVC is the third standard candidate after simulcast and LiveKit/Dynacast. A path
may receive only the base layer or the base plus enhancement layers. Adopt it
when the earlier candidates fail and the exact negotiated codec and
`scalabilityMode` are read back, a power-efficient/hardware path is positively
established on the supported sender cohort, and game-performance and latency
gates pass. Do not silently fall back to software SVC. It is not the preselected
default; a strict-one-output requirement would strengthen, not create, its case.

The WebRTC-SVC specification exposes `scalabilityMode` and permits the browser
to return a different configured mode after negotiation. Media Capabilities can
report support, expected smoothness, and power efficiency for a specific
configuration. WebCodecs `hardwareAcceleration` is only a hint that a user
agent may ignore. These APIs are useful evidence, not a portable guarantee of a
particular physical hardware encoder.

## Consequences

Positive:

- Healthy viewers are not reduced to the worst path.
- Normal operation sends one active representation; one additional
  representation is paid only while a verified weak path needs it. Physical
  encoder instances and resource release remain measured outcomes.
- Encode cost is bounded independently of viewer count.
- The state machine and its evidence remain inspectable.

Negative:

- A weak-path interval adds representation bandwidth and may require another
  physical encoder; the exact instance/resource cost is implementation-specific.
- Starting/stopping `LOW` and switching paths need a keyframe-safe transition.
- Browser capability reporting cannot by itself prove hardware or sustained
  decode performance, so the real-device matrix remains mandatory.

## Product Stop Lines

- Do not productize PR #28's minimum-of-two bitrate or frame-rate aggregation.
- Do not use simulcast, Dynacast, SVC, or an SFU as a semantic bypass around
  PR #28's stock-GCC/RTX stop line or per-edge congestion control.
- Do not lower `HIGH` because one viewer reports trouble.
- Do not create one representation or encoder per viewer.
- Do not use UA/device identity as a quality signal.
- Do not enable software SVC as an invisible fallback.
- Do not start `LOW` when its measured resource cost violates the game budget.
- Do not add a composite health score when the two-state predicates suffice.

## Verification Gates

- A healthy room emits only `HIGH`.
- One sustained weak path starts exactly one `LOW`; healthy viewers remain on
  `HIGH`, and additional weak viewers reuse `LOW`.
- After all weak paths sustain the longer recovery window, every path returns
  to `HIGH`; `LOW` bytes/frames stop and its physical resource behavior is
  recorded rather than assumed.
- Representation count never exceeds two and host media edges never exceed two.
- An unavailable/over-budget `LOW` fails visibly for weak paths while healthy
  paths and `HIGH` remain unchanged.
- Every supported sender cohort can reliably start the one shared `LOW` on
  demand; otherwise automatic quality control does not pass acceptance.
- Native relays show packet forwarding without an added decode/encode stage.
- Spoofed, stale, duplicated, or rate-excessive viewer requests have no effect.
- Controlled capture/CPU/bandwidth/TURN/receiver/display cases produce the
  classifications in the evidence table without a room-wide downgrade.

## References

Primary sources checked 2026-08-19:

- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [W3C WebRTC SVC](https://www.w3.org/TR/webrtc-svc/)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)
- [W3C WebRTC simulcast](https://www.w3.org/TR/webrtc/#simulcast-functionality)
- [LiveKit video simulcast and Dynacast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit client 2.22.0 Dynacast layer control](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/LocalVideoTrack.ts)
- [LiveKit server 1.13.5 Dynacast quality aggregation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastqualityvideo.go)
- [LiveKit server 1.13.5 enabled-quality generation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastmanagervideo.go)
