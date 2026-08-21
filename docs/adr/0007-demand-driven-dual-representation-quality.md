# ADR-0007: Path-Isolated Dual-Representation Quality

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

Use path-isolated dual representations:

1. Direct/peer paths keep their requested `HIGH` target and independent stock
   WebRTC congestion control. No viewer feedback changes another path's target.
2. Each SFU path starts with a `HIGH` ceiling. The preferred implementation
   publishes one shared `HIGH+LOW` pair and lets LiveKit BWE independently
   choose and recover the forwarded layer for each subscriber. If that gate
   passes, Screener does not add a media-layer selector.
3. Correlated sender/viewer evidence and asymmetric windows classify topology
   eligibility and diagnostics only. An observed downshift is `suspect`; a
   confirmed `FALLBACK` endpoint cannot remain a parent. These application
   states do not command ordinary built-in layer changes.
4. Explicit subscriber quality or sender layer activation is considered only
   if the built-in candidate fails its bounded gate. Deactivating an unused
   `LOW` is a resource optimization, not an acceptance requirement.
5. The active representation/layer count is a hard `HIGH + at most one LOW <=
   2`; it never grows with viewer count.

Making `LOW` available is conditional on positive hardware-encoder evidence and
measured spare game-performance and upload budget. A permanently active
two-representation path is acceptable when that gate passes; stopping unused
`LOW` remains a later optimization. If the hardware path is absent or the
additional representation causes unacceptable CPU/GPU/game/upload cost, fail
closed for that attempt: preserve `HIGH` and show the weak path an explicit
degraded/unavailable state. This is exceptional damage containment, not
permission to ignore a weak path indefinitely. A supported sender cohort that
cannot reliably provide the one shared `LOW`, either always-on or on demand,
fails quality acceptance; optimize its encode path or mark
that cohort unsupported. Never protect a weak path by reducing `HIGH`.

The durable topology states use explicit predicates and asymmetric
entry/recovery windows; `suspect` is the sampling interval before a transition,
not a third media mode. There is no weighted score, device ranking,
machine-learning controller, custom media selector, or continuous room-wide
optimizer. Exact thresholds remain implementation inputs until the controlled
quality matrix establishes them.

The topology and representation budgets are independent invariants. The host
still has at most two downstream media edges. A native relay forwards selected
encoded packets without decoding or re-encoding. Future dual-tree or striped
delivery may reduce host upload from about two full copies toward one copy plus
necessary redundancy, but it does not block this decision.

The application must not stably retain a confirmed `FALLBACK` endpoint as a
parent. A later planned or explicit `LOW` fallback is leaf-only: complete a
generation-guarded child evacuation before changing its quality, and preserve
the prior assignment and quality if evacuation fails or becomes stale. An SFU
may make an unannounced congestion-protection downshift before the application
can react. Treat that observation as `suspect`, not confirmed `FALLBACK`; if
correlated evidence confirms it across the bounded entry window, evacuate its
children and set downstream capacity to zero. This cannot promise packet-level
preemption, so the root-with-children gate must bound temporary descendant
impact before default enablement. Re-advertising relay capacity still needs the
longer recovery window and a cooldown. A viewer's
advisory request cannot trigger this sequence by itself.

## Evidence Contract

Before enabling quality-aware topology changes, correlate the same time
interval and stream generation across three stages:

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
The evidence sampler must use adjacent, non-overlapping deltas and rebase on a missing
field, stream/stat ID change, or counter reset. Missing values remain unknown;
they are not zeros.

Implementation is staged. First correlate A and B locally in one sampling tick,
with an explicit interval, media/stat identity, and valid deltas. Only after
that probe is trustworthy may the product add a minimal authenticated C report
for the few receive/decode signals required by the topology predicate. The B/C
correlation uses normalized fields derived from negotiated parameters/stats and
actual decode behavior; it must never upload raw SDP, raw stats, candidate
addresses, or raw device/network identifiers. Opaque server-issued path and
connection-generation IDs remain required for authorization and correlation.
Do not build a general telemetry schema.

A viewer may request `LOW`, but the request is advisory. It must be carried on
an authenticated, current room/path session and be rate-limited and deduplicated.
The topology classifier accepts it only when viewer receive/decode behavior and
derived negotiated codec/profile/parameters (including applicable
`scalabilityMode`) agree with sender transport/GCC and encode evidence. A
request alone cannot lower quality or start a representation.

UA, platform, and device-model detection does not participate in quality or
relay-capacity selection. Browser capability queries can guide a bounded probe,
but runtime encode/decode behavior is authoritative.

## Standard Capability Short-Circuits

Inspect standard capabilities in order and stop at the first accepted path
before custom dual-representation media. Static API or pinned-protocol
incompatibilities can close a candidate without a browser run; runtime media
gates start only after the A+B/C evidence contract is trustworthy. These
results do not create an application media-layer selector; the asymmetric
evidence windows remain limited to topology eligibility and diagnostics:

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
2. **Pinned LiveKit two-layer simulcast: implemented; acceptance remains open.**
   Client 2.22.0 can publish a screen-share original plus one lower simulcast
   encoding. `RemoteTrackPublication.setVideoQuality(HIGH)` sets a per-subscriber
   spatial-quality ceiling. Server 1.13.5 maps quality, dimensions, and FPS to
   maximum spatial/temporal layers and can adapt each SFU downtrack to its own
   bandwidth and recover it independently. Server Dynacast
   takes the maximum requested quality and enables every quality at or below
   it, so any `HIGH` root keeps `LOW` active. That cumulative behavior prevents
   dynamic `LOW` stop while `HIGH` is subscribed, but dynamic stop is now an
   optimization rather than a hard requirement.

   The candidate therefore publishes exactly `HIGH+LOW` with standard
   simulcast/send encodings, leaves each LiveKit root's ceiling at `HIGH`, and
   first tests built-in per-subscriber SFU bandwidth adaptation on
   zero-descendant leaf viewers. Start with deterministic two-layer publication
   and Dynacast off; its pinned cumulative behavior can later be measured as the
   equivalent always-on case. Screener's
   subscriber does not attach a `RemoteTrack`, so LiveKit `adaptiveStream` is not
   directly usable without changing that ownership; it is not required for the
   SFU bandwidth-adaptation candidate. Before default enablement, a separate
   root-with-children gate must inject an autonomous downshift, observe it as
   suspect, evacuate on bounded confirmation, and limit temporary descendant
   impact; no confirmed `FALLBACK` root may retain children. If built-in selection
   fails the product gates, test explicit standard subscriber quality selection
   before sender activation/deactivation. The gate must prove that a healthy
   P2P/`HIGH` path is unchanged, no third layer appears, the expected layer is
   actually received, and hardware encoder, game FPS/p1 low, CPU/GPU, interval
   encode cost, host upload, and `HIGH+LOW` bytes fit budget. Every active SFU
   publication now configures exactly two ordered `q,h` encodings, leaves
   Dynacast at its default `false`, and sets each subscriber's ceiling to
   `HIGH`; the two-layer publication is not behind a separate quality flag.
   Per-subscriber BWE, hardware cost, and root-with-children behavior remain
   unverified, so no runtime performance claim follows. If the always-on cost
   fails, test manual standard sender activation/deactivation next;
   custom/native dual encoding follows only if built-in and manual standard
   primitives fail.
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
   two-active-layer ceiling. Its `RemoteTrackPublication.setVideoQuality()`
   controls per-subscriber spatial quality, while server 1.13.5 maps
   quality/dimensions/FPS to maximum spatial/temporal layers. That selection
   exists only on an SFU downtrack; it does not extend to
   Screener's direct/peer receivers. The current subscriber only requests the
   publication, and LiveKit documents that Dynacast can pause an entire SVC
   stream but not individual SVC layers. Chrome ships the outgoing-track API;
   current Firefox and WebKit WebIDL do not expose the standard
   `scalabilityMode` member, and Firefox's implementation remains behind a
   preference. A pinned-SDK Safari compatibility branch is not a portable
   standard contract. These static blockers cannot be changed by a Chrome
   media run, so no harness was written and no browser was run.

None may reuse PR #28's minimum-of-two target, bypass a per-edge stock WebRTC
congestion controller, or expand the representation limit beyond two.

## SVC Static Verdict

This static verdict rejects current Web/LiveKit SVC, not the separate LiveKit
two-layer simulcast candidate above. Requested and post-negotiation applied
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
- One shared `LOW` is available to all SFU paths and LiveKit selects it per
  subscriber; its idle deactivation is allowed but not required. Physical
  encoder instances and resource cost remain measured outcomes.
- Encode cost is bounded independently of viewer count.
- The topology classifier and its evidence remain inspectable.

Negative:

- An always-on `LOW` adds representation bandwidth and may require another
  physical encoder even without a weak path; the exact cost is an acceptance
  measurement, not an assumed negligible overhead.
- Any later explicit quality/layer fallback needs a keyframe-safe transition.
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
- Do not start or retain `LOW` when its measured hardware, game, or upload cost
  violates budget.
- Do not add a composite health score or media selector when built-in adaptation
  plus topology predicates suffice.

## Verification Gates

- Direct/peer paths retain independent stock WebRTC congestion control. Each SFU
  path starts with a `HIGH` ceiling; under shaping, built-in LiveKit BWE sends a
  weak leaf the shared `LOW` while a healthy leaf stays `HIGH`, then restores the
  weak leaf without an application media selector.
- An idle `LOW` may remain active only after hardware, game-performance, and
  upload cost passes. If idle stopping exists, verify bytes/frames stop;
  otherwise record and accept the bounded always-on cost.
- Representation count never exceeds two and host media edges never exceed two.
- A later planned/explicit `LOW` fallback evacuates children first and preserves the
  prior state on stale/failed evacuation. An autonomous BWE downshift enters
  `suspect`; bounded confirmation evacuates its children, and no confirmed
  `FALLBACK` endpoint retains downstream capacity. The root-with-children
  gate measures temporary descendant impact before default enablement.
- Relay capacity returns only after the longer stable recovery plus cooldown.
- An unavailable/over-budget `LOW` fails visibly for weak paths while healthy
  paths and `HIGH` remain unchanged.
- Every supported sender cohort can reliably provide the one shared `LOW`,
  always-on or on demand; otherwise the quality gate does not pass.
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
- [Chrome 111 WebRTC SVC extension](https://developer.chrome.com/blog/chrome-111-beta)
- [Chromium `RTCRtpEncodingParameters` WebIDL](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/peerconnection/rtc_rtp_encoding_parameters.idl)
- [Firefox `RTCRtpEncodingParameters` WebIDL](https://searchfox.org/firefox-main/source/dom/webidl/RTCRtpParameters.webidl)
- [Firefox WebRTC-SVC implementation status](https://bugzilla.mozilla.org/show_bug.cgi?id=1571470)
- [WebKit `RTCRtpEncodingParameters` WebIDL](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/RTCRtpEncodingParameters.idl)
- [LiveKit video simulcast and Dynacast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit client 2.22.0 SVC defaults](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [LiveKit client 2.22.0 screen-share SVC override](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/LocalParticipant.ts)
- [LiveKit client 2.22.0 SVC encoding construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit client 2.22.0 subscriber quality control](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/RemoteTrackPublication.ts)
- [LiveKit server 1.13.5 per-subscriber layer application](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/subscribedtrack.go)
- [LiveKit client 2.22.0 Dynacast layer control](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/LocalVideoTrack.ts)
- [LiveKit server 1.13.5 Dynacast quality aggregation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastqualityvideo.go)
- [LiveKit server 1.13.5 enabled-quality generation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastmanagervideo.go)
