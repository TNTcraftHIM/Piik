# ADR-0007: Demand-Driven Dual-Representation Quality

- Status: Accepted - Implementation Pending
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
3. The first verified fallback path starts one shared `LOW` representation.
   Every verified weak path uses that same representation. Healthy paths remain
   on `HIGH`.
4. A fallback path returns to `HIGH` only after a longer, independently defined
   stable-recovery window. When no path needs `LOW`, stop its encoder and free
   its resources.
5. The representation count is a hard `HIGH + optional LOW <= 2`. It never
   grows with viewer count.

Starting `LOW` is conditional on a qualified hardware/power-efficient encoder
path and measured spare game-performance budget. If that path is absent or the
second encoder causes unacceptable CPU/GPU/game load, fail closed: preserve
`HIGH` for healthy paths and show the weak path an explicit degraded/unavailable
state. Never protect a weak path by reducing healthy paths.

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

## SVC Boundary

Consider SVC only when a later accepted requirement demands one encoded output
at all times. A path may then receive only the base layer or the base plus
enhancement layers. Enable it only when the exact negotiated codec and
`scalabilityMode` are read back, a power-efficient/hardware path is positively
established on the supported sender cohort, and game-performance and latency
gates pass. Do not silently fall back to software SVC. Persistent SVC is not the
default design.

The WebRTC-SVC specification exposes `scalabilityMode` and permits the browser
to return a different configured mode after negotiation. Media Capabilities can
report support, expected smoothness, and power efficiency for a specific
configuration. WebCodecs `hardwareAcceleration` is only a hint that a user
agent may ignore. These APIs are useful evidence, not a portable guarantee of a
particular physical hardware encoder.

## Consequences

Positive:

- Healthy viewers are not reduced to the worst path.
- Normal operation pays for one encoder; a second is paid only while at least
  one verified weak path needs it.
- Encode cost is bounded independently of viewer count.
- The state machine and its evidence remain inspectable.

Negative:

- A weak-path interval can temporarily require two encoder instances and the
  bandwidth for both representations on the affected distribution edges.
- Starting/stopping `LOW` and switching paths need a keyframe-safe transition.
- Browser capability reporting cannot by itself prove hardware or sustained
  decode performance, so the real-device matrix remains mandatory.

## Product Stop Lines

- Do not productize PR #28's minimum-of-two bitrate or frame-rate aggregation.
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
  to `HIGH` and the `LOW` encoder stops.
- Representation count never exceeds two and host media edges never exceed two.
- An unavailable/over-budget `LOW` fails visibly for weak paths while healthy
  paths and `HIGH` remain unchanged.
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
