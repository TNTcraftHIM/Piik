# Native Shared-Encode Sender

- Research date: 2026-08-19
- Scope: one Windows game-capture sender, one encoded video stream, and at most
  two independent standard WebRTC media edges
- Status: stacked Draft PRs #16/#18/#22/#23/#25/#28 pass one bounded live
  two-leg WebCodecs/Pion candidate. Both product-wiring attempts remain
  no-go-unclassified; product and physical shared encoding remain unproven.

## Decision Input

TeamSpeak-style shared encoding is a required later sender phase. It can remove
duplicate host encoding work, but it cannot remove the upload copy, RTP state,
or congestion control required by each outgoing edge. The first implementation
must prove one narrow property before adding capture, audio, UI, or packaging:

> Two unmodified browser viewers receive two independent WebRTC sessions while
> one physical encoder invocation produces the compatible encoded access unit
> consumed by both sessions.

The completed Pion/WebCodecs research ladder proves a narrower property: one
JavaScript `VideoEncoder` object emitted the encoded chunks consumed by two
browser sessions. WebCodecs does not expose physical encoder-instance counts,
and Chrome used `hardwareAcceleration: "no-preference"` after rejecting the
single allowed `prefer-hardware` attempt. The result therefore must not be
described as one hardware or physical encode.

The preferred first experiment is a standalone Windows C++ sender using a fixed
libwebrtc revision. It keeps libwebrtc's mature PeerConnection, RTP/RTCP, pacing,
NACK/RTX, DTLS-SRTP, ICE, and TURN behavior on each edge. Electron is not part of
the media experiment; it can only wrap a proven helper later.

## Minimal Risk Spike

```text
existing Node signaling
        |
Windows sender.exe
synthetic source -> shared encoder coordinator -> encoder proxy A -> PC A -> browser A
                                      `--------> encoder proxy B -> PC B -> browser B
```

- Windows x64, C++, video-only, fixed 720p30, and exactly two outgoing edges.
- Inject a custom `VideoEncoderFactory` into libwebrtc. It returns two proxy
  encoders, one for each normal send pipeline.
- Each proxy keeps its own `EncodedImageCallback`; one coordinator owns the
  physical counting encoder.
- The coordinator deduplicates matching input-frame timestamps and publishes
  the same reference-counted encoded buffer to both callbacks.
- Reject the second edge when codec, profile, dimensions, or layer configuration
  differ. Never hide incompatibility by creating a second physical encoder.
- For this fixed single-layer spike only, aggregate the two `SetRates()`
  requests by taking the minimum total target bitrate and frame rate, bounded by
  the selected profile. This is an experiment safety policy, not a product
  design: one weak edge can lower a healthy edge, so productization is
  forbidden. Independent quality requires another representation, an accepted
  scalable design, or transcoding.
- Coalesce PLI/keyframe requests so one physical keyframe is delivered to both
  packetizers. RTP sequence numbers, SSRC, TWCC, pacing, retransmission caches,
  RTCP, DTLS-SRTP, and ICE remain independent per edge.

libwebrtc officially permits an application to inject a `VideoEncoderFactory`
and defines `VideoEncoder::Encode`, `SetRates`, loss/RTT notifications, and the
encoded callback. It does **not** promise cross-PeerConnection shared encoding.
The proxy/coordinator design is therefore an inference that this spike must
validate, not a supported feature claim.

Stop the libwebrtc route if two send pipelines produce incompatible cadence,
timestamps, adaptation, or callback behavior and correctness would require a
fork of `VideoStreamEncoder`, `RtpVideoSender`, or another libwebrtc internal.
Do not carry a permanent media-engine fork for this feature.

## Capture And Hardware Encoding Come Later

Only after the synthetic two-edge property passes:

1. Capture a window or display with Windows Graphics Capture into a D3D11
   surface.
2. Convert BGRA to NV12 once. Do not claim zero-copy until profiling proves the
   actual texture path.
3. Enumerate hardware Media Foundation H.264 encoders with `MFTEnumEx` and
   `MFT_ENUM_FLAG_HARDWARE`, then probe every required input/output type and
   `ICodecAPI` control. Enumeration alone is not a capability guarantee.
4. Require proven support for low-latency operation, runtime bitrate control,
   and explicit keyframe requests; reject that adapter instead of silently
   weakening the contract when a property is unavailable or read-only.
5. Request one H.264 Constrained Baseline, packetization-mode 1 stream, then
   inspect the emitted SPS and negotiated `profile-level-id` before accepting
   the path. Browser baseline interoperability does not guarantee a particular
   hardware MFT or 1080p60; test every target GPU/browser combination.

Audio, per-process WASAPI capture, WGC/DDA fallback, source selection, Electron,
installers, updating, and cross-platform abstractions stay outside the first
spike.

### 2026-08-20 Windows codec comparison

The target workstation exposes an NVIDIA GeForce RTX 4070 SUPER. NVIDIA's
published NVENC contract encodes H.264, HEVC, and AV1, but not VP8. The current
Native canary instead fixes VP8 and asks WebCodecs for `prefer-hardware`; its
code removes that preference when the capability check rejects it. The prior
bounded run did reject the preferred configuration and continued with
`no-preference`. One `VideoEncoder` and its first output callback therefore do
not establish hardware encoding, and VP8 cannot use this GPU's NVENC engine.

Discord and the read-only Oopz 0.87.425 package inspection both make H.264 the
smallest Windows hardware candidate. Discord publishes native OS/driver capture
and encoding with hardware preferred and WebRTC transport. Oopz's package
contains Agora screen-share integration, WGC/DXGI/D3D11 capture components, an
H.264 Web viewer configuration, NVENC/QSV/AMF plus software codec paths, and an
observable hardware-acceleration field. The inspection found one channel screen
publication and no evidence of an application-owned per-viewer PeerConnection
loop. That is consistent with a common publication, but static packaging cannot
prove one physical encoder, the codec/profile selected for a real host, or
actual GPU use.

The bounded WebCodecs H.264 run, its no-go result, and the hardware-only Media
Foundation successor are owned by
[Native H.264 hardware decision spike](./native-h264-hardware-decision.md).
Do not recreate a codec ladder here. AV1 waits for the same physical-encode
proof and the desktop/mobile Viewer decode matrix; compression efficiency alone
cannot advance it.

Reproducibility anchors for the proprietary-package inspection, without copied
code or user data:

- Oopz `data/app.so`: SHA-256
  `462E081D03E49008AD8D64A032BD6396F0B97CDADBDF715F7C6810D081A714F8`.
- Oopz screen-viewer bundle `screenShare/page/assets/index-C6S4n49C.js`:
  SHA-256
  `1EAECD2C0DC332E5D2628047EE1BECB874C8130C2C383355EE313961EFC6E1CA`.
- Oopz `agora_rtc_sdk.dll`: SHA-256
  `66B8B34A57BA0EE9DCC6C516E2CC20F5F1EB5D35ED7150FDF37201A46BC8D4A0`.

## Deferred Mobile Sender Boundary

This section records later capability work; it does not broaden ADR-0006's
Windows scope or authorize mobile runtime code. Priority remains the current
deployment and staged Windows fixed-`HIGH` gate. The first mobile candidate is a
separate P2 Android 14/API 34+ spike only after those P1 gates complete.

Android's official `MediaProjection` path captures the display into a `Surface`;
selected-app-window capture starts with Android 14 QPR2. API 34 requires fresh
consent for each session, one use of each projection token, and a foreground
service declared as `mediaProjection`. Rotation or selected-content resizing requires
`onCapturedContentResize()` handling; user stop, screen lock, another projection,
or process death invalidates the session and requires bounded cleanup through
`onStop()`. These OS consent and foreground indicators are part of the product
experience and cannot be made invisible.

The bounded Android data path is:

```text
MediaProjection Surface -> one hardware MediaCodec fixed-HIGH encoder
  -> existing Host admission / room / WSS / standard WebRTC
  -> one or two unmodified Web viewers
```

It adds no mobile-only topology, `LOW`, AV1, codec ladder, third downstream edge,
or software fallback. `MediaCodecInfo.isHardwareAccelerated()` is metadata
provided by the manufacturer that Android explicitly says cannot be tested for correctness,
so it is only an admission signal. The spike must also prove the selected named
encoder, supported fixed format, interval encode cost, CPU/GPU, temperature and
throttling, power, queue bounds, actual bitrate/quality, and game impact on real
devices. Missing or failed hardware evidence is no-go; the implementation must
not silently select a software codec. Network changes reuse the existing
per-edge WebRTC recovery contract rather than restarting capture or creating a
new transport.

iOS work remains later and separate. Apple's current ScreenCaptureKit
documentation says the framework replaces ReplayKit for screen streaming and
that a broadcast extension is no longer required, but the iOS sample requires
iOS 27 and the current APIs are still beta. Screener therefore does not build a
ReplayKit/Broadcast Upload Extension compatibility stack. After the final iOS
27 SDK and stable OS ship, one narrow ScreenCaptureKit system-picker spike may
feed a fixed-`HIGH` VideoToolbox encoder into the same one/two-Web-viewer
contract. It must set
`kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder` and verify
`kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder`; otherwise it
fails closed. Rotation, background execution, lock-screen behavior, network
switching, thermal throttling, audio scope, and A/V sync remain explicit gates
on real devices, not implied framework capabilities.

## Pion Validation Route

Pion is the released-public-API validation route while the larger libwebrtc
encoder-proxy experiment remains unbuilt. `TrackLocalStaticSample` owns one
packetizer and writes through a `TrackLocalStaticRTP` that can bind to multiple
PeerConnections, making encoded-payload fanout explicit.

This certainty moves more responsibility into the application. Pion's default
interceptors provide NACK, RTCP reports, statistics, and transport-wide feedback,
but an external encoder still needs explicit send-side bandwidth estimation,
aggregation of both edge targets, encoder bitrate control, PLI handling, and
bounded RTP/RTX queues. The already bounded #23/#28 ladder uses the same
minimum-edge safety rule and must not invent a custom SRTP, ICE, or congestion
protocol. A product route must follow ADR-0007 instead.

## Fixed-HIGH Product-Wiring Attempt

ADR-0006 retains one narrow candidate: fixed VP8 1280x720@30 with a 3 Mbps
ceiling, one WebCodecs encoder object, at most two independent Pion legs, the
strict ordinary signaling wire, unmodified viewers, read-only feedback, and no
audio or automatic `LOW`. This is a proposed test boundary, not current product
behavior or hardware-encoder evidence.

The 2026-08-20 local delivery checkpoint rebases that candidate onto the sole
current access contract: `screener-v2`, Host-admission Cookie authentication,
explicit `private-link` creation, fragment-only Viewer grants returned to the
local Host, and STUN-only ordinary ICE. Native creation alone requests a fixed
300-second provisional room. It remains random and memory-only even with SQLite
configured: the current Host session suppresses the reclaim deadline, its
generation-matched disconnect resets the five-minute window, the ordinary
transient room TTL still caps the room, and restart drops it. A pre-auth
connection or authentication failure gets one same-room/token/client-generation
retry without a second room POST. SQLite remains v2 and ordinary Web creation is
unchanged.
HTTP statuses, Cookie attributes, create-room responses, Host authentication,
and ignored Viewer evidence are strict and bounded; errors retain only fixed categories.
Focused Go and TypeScript checks pass. The overbroad unused gate/probe framework
stays deleted; the current command consumer is limited to the executable runner
and sanitized stage ledger required by the next authorized run.

The one authorized 2026-08-20 current-wire attempt used Chrome 151 on Windows
amd64, a temporary non-default Chrome profile, a real animated Chrome tab, and
an isolated local Node server with an in-memory RoomStore and peer assistance
disabled. It did not contact production or SQLite. Retained history booleans
show that the source and Sender pages loaded and no Viewer page was created. The
runner reported `failedStage=node-host` after its bounded 20-second Sender-start
interval because it did not observe the combined Sender-ready and Go source-RTP
condition.

This is `no-go-unclassified`, not evidence that the Node Host path itself
failed. The timeout branch did not retain a final Sender DOM/counter sample, so
it cannot locate the break among `getDisplayMedia` request/resolve, Host
admission/create, WSS authentication, local bridge connection, first encoded
chunk, or Go source RTP. There was no retry or timeout adjustment. Viewer auth,
offer/answer/ICE, Pion bound-edge output, Viewer inbound/decode/render, two-edge,
and FIFO evidence were never attempted. A later run needs separate authorization
and an unconditional stage-1 final-negative ledger before it may create one
Viewer.

That local-only runner is now the current `npm run gate:native-one-viewer`
consumer. It requires an explicit Chrome executable environment path and uses
the task-local Go executable or task-specific `PATH`; neither path is committed.
Each monotonic Sender-start transition appends and flushes one bounded JSON
record containing only booleans and capped counters. A pure timeout test proves
that capture, admission/create, Host WSS, bridge, fixed-`HIGH`, first encoded
chunk, Go-ingest, and source-RTP state cannot be erased by a later failed sample.
The one-Viewer signaling/media waits likewise preserve their latest sanitized
sample in the final report. They now accept evidence only from one frozen
signaling socket/auth/opaque-connection ordinal, one PeerConnection/video-track
ordinal, and the same Pion slot/edge generation across signal and media stages.
The raw connection ID remains page-local. Every CDP RPC/sample is capped by the
remaining stage deadline. Final status is written only after bounded process-tree
exit and closed-port polling, followed by an exact system-Temp path audit,
recursive reparse-point rejection, profile deletion, and absence verification;
any cleanup failure is fail-closed. Microsoft documents `/T` as terminating a
task's child processes and `ReparsePoint` as the filesystem attribute used for
these special entries. Pure tests cover hung sampling, cross-PC evidence,
cleanup-before-pass, profile path bounds, and deletion failure. Sources were
rechecked 2026-08-20.

One separately authorized second current-wire run used the frozen gate once and
did not retry or adjust a threshold. Its append-and-flush ledger reached sequence
7 and retained positive booleans for capture request/resolution, Host admission,
private room creation, Host WSS authentication, bridge readiness, fixed VP8
1280x720@30/3 Mbps config acceptance, one encoder object, and entry into the
first WebCodecs output callback. Go diagnostics remained at zero
`framesWritten`, source-RTP packets, and source-RTP bytes. The runner therefore
failed closed at `sender-start`; it never created the Viewer page and did not
exercise Viewer auth, SDP/ICE, Pion bound-edge output, decode/render, a second
Viewer, or FIFO. Cleanup was complete before the report was finalized: Chrome
and Native exited, the isolated Node listener and all three random loopback
ports closed, and the exact task profile passed a non-reparse audit and was
removed.

The result narrows but does not classify the break. The gate increments its
encoded-output observation before it calls the product output callback, and that
run did not retain whether the current local media WebSocket attempted, returned
from, or threw during the binary frame send. Static source comparison shows a
matching binary message type, 17-byte big-endian header, one-MiB payload limit,
and VP8 frame decode on both sides. A focused test now drives the real local
`/media` WebSocket through ready, fixed config acceptance, one same-contract
binary frame, decode, fanout, and positive `framesWritten` plus source-RTP packet
accounting. Pion's unbound static RTP track also returns no error. This proves
the current envelope is consumable by the current Go handler; it does not prove
that the retained browser called or returned from the product send.

The concrete P1 defect at this boundary was silent handling of every unexpected
post-config WebSocket read error. The handler now emits one `fatal` with fixed
message `local media bridge read failed` only while the app context is active
and the close status is neither normal nor going-away. It never includes the
underlying error or close reason. Focused real-WebSocket tests cover an abnormal
post-config close, normal close, and app shutdown. All Go tests, vet, Windows
amd64 no-CGO build, TypeScript typecheck, and the relevant bridge probe/ledger
tests pass.

One authorized post-fix run then used exact source
`86386b75d01919b213f5725467e495cdd0aa9a54` and the unchanged tracked gate
exactly once. Its fixed VP8 1280x720@30, 3 Mbps, one-Viewer boundary used Chrome
151, one in-memory loopback room, and no peer assistance. Preflight had passed
the 411-test Node suite, typecheck, both builds, all Go tests, vet, a Windows
gate build, and the 11 focused ledger/generation/cleanup tests.

The append-and-flush ledger reached sequence 6. It retained capture request and
resolution, Host admission, private room creation, Host WSS authentication,
bridge readiness, fixed-`HIGH` config acceptance, first WebCodecs output, one
encoder object, bridge generation 1, and the first observed binary `super.send()`
returning synchronously; it retained no observed synchronous throw. The ledger
does not count later sends. Go still reported
zero frames, source-RTP packets, and source-RTP bytes. The gate therefore failed
at `sender-start` and did not create a Viewer. It did not run Viewer signaling,
SDP/ICE, Pion bound-edge output, decode/render, H.264, a second Viewer, FIFO, or
production. No retry or threshold change followed.

Cleanup completed before final failure: Chrome and Native exited, Node and all
task ports closed, and the exact task profile was audited and removed. The
pre-existing historical task-profile count did not increase. The result remains
`no-go-unclassified`: it narrows the retained interval to after the first
product binary `send()` returned and before Go frame accounting, but does not
prove Go read or decode. The fixed bridge fatal is not retained by this failure
ledger, so no underlying close or raw cause may be inferred. A separate minimal
diagnostic or fix slice must classify this interval before another Chrome run.

The frozen probe continues to bind the first actual local media WebSocket as
gate-local generation 1. A second bridge generation saturates at 2, stops
accumulating the first generation's counters, and fails the Viewer signal,
Viewer media, and final-success checks. Pure tests cover success, throw, and
late replacement without retaining a URL, payload, token, SDP, candidate, IP
address, or raw error.

Chromium documents the tab-capture auto-selection switch as a test-only aid,
and Chrome requires a non-default user-data directory for remote debugging from
Chrome 136. Those constraints explain the isolated harness setup; they do not
prove that `getDisplayMedia` resolved in the first failed current-wire run.
Static inspection of the pinned Pion v4.2.18 `TrackLocalStaticRTP.WriteRTP` shows
that it iterates the
current bindings and returns no error for an empty binding set. This excludes a
pre-Viewer no-binding write as the likely fatal break; it is not runtime proof
of Go ingest or source RTP. Sources were rechecked 2026-08-20.

The earlier authorized 2026-08-19 local product gate is
`no-go-unclassified`:

| Checkpoint | Retained evidence |
| --- | --- |
| Ordinary Node server | The local listener started with peer assistance and TURN disabled. No raw signaling frames were retained. |
| Native room/host | `/api/start` returned an invite, which in the attempted branch followed room creation and host signaling authentication. |
| Local encoder | Config acknowledgement preceded construction; the probe observed one `VideoEncoder` object and encoded output. Helper ingress, frame decode, and source RTP were not proven. |
| Viewer page | The page and probe loaded, but the 30-second combined decoded-and-rendered condition timed out. |
| Downstream lifecycle | Viewer auth, `peer-joined`, SDP/candidates, PC states, source RTP/edge packets, inbound RTP, video readiness, and console state were not retained. |

The first missing evidence checkpoint is viewer authentication, not a proven
authentication failure. The harness discarded each false sample; its reused
`progress()` path can omit a connection after a swallowed `getStats()` error;
and render evidence had no readiness/current-time/video-dimension fallback.
The timeout therefore cannot locate the runtime break or rule out a probe-only
false negative. The static code review found no obvious protocol disconnect,
which is not runtime evidence.

No second viewer, two-edge proof, third-viewer waiting/FIFO promotion, or
direct/TURN pair ran. Do not treat the attempted branch as usable or mergeable
product code. ADR-0006 owns the separately authorized staged revalidation and
exact stop line; this research does not redefine it.

## Stacked Validation Ladder

These Draft PRs are deliberately stacked research, not six product features:

| PR / commit | Bounded gate | Result |
| --- | --- | --- |
| [#16](https://github.com/TNTcraftHIM/Screener/pull/16) / `5b09f0a` | One Pion RTP write across two independent transports | Equivalent payload reached two transport-local SSRCs. There was no encoder or browser. |
| [#18](https://github.com/TNTcraftHIM/Screener/pull/18) / `80f65d0` | Synthetic WebCodecs VP8 chunks through Pion to two Chrome receivers | One encoder object produced 120 inputs/outputs and both browsers decoded; this was an offline fixture, not physical-encode evidence. |
| [#22](https://github.com/TNTcraftHIM/Screener/pull/22) / `8121b69` | Continuous 320x180@30 live bridge for about 12 seconds | One encoder object sent 360 chunks; each viewer decoded and presented 331 frames, with encoder/native queue peaks of one. |
| [#23](https://github.com/TNTcraftHIM/Screener/pull/23) / `eb9aabe` | Merged PLI/FIR policy, min-of-two target policy, and independent 512-packet NACK/RTX state | Policy traces passed, but stock Pion GCC plus negotiated RTX failed with `unknown ssrc: 2001`. This composition is no-go. |
| [#25](https://github.com/TNTcraftHIM/Screener/pull/25) / `a6c3456` | No-RTX primary-SSRC replay under one controlled leg loss | Leg 1 emitted one NACK and one replay with fresh TWCC, then decoded another 278 frames; leg 2 stayed clean. This can distort RTCP loss accounting. |
| [#28](https://github.com/TNTcraftHIM/Screener/pull/28) / `aad560e` | Live two-leg stock-GCC target applied to the same encoder object, then one controlled loss | The bounded gate passed. Both estimates happened to be 600 kbps, so heterogeneous-estimate behavior remains unproven. |

### Final Live Gate Evidence

The sole authorized #28 browser run used Headless Chrome 151 and Pion WebRTC
v4.2.18 on Windows amd64. It ran 1280x720@30 for 12.972 seconds with 390
scheduled inputs and 390 outputs from one `VideoEncoder` object. The encoder
queue peaked at 1/4, the native queue at 1/8, and the WebSocket buffer at
12,467/524,288 bytes; no encoder or socket drop occurred.

Both legs returned real Transport-CC before target selection. Their final stock
GCC estimates were both 600 kbps. The coordinator took the minimum, published
one 600 kbps target, and the host serialized `flush()`, `configure()` on the
same encoder object, and a forced key frame to acknowledge the change from the
initial 1.2 Mbps ceiling.

After acknowledgment, the boundary dropped one leg-1 primary packet. Chrome
sent one NACK and Pion replayed the same primary RTP identity with a new TWCC
sequence; leg 2 recorded no drop, NACK, or replay. Both viewers decoded another
359 frames after the shared recovery marker. This is a go result only for the
bounded live target plus primary-SSRC recovery candidate.

## Product Quality Direction

PR #28 establishes only that one live `VideoEncoder` object accepted one
conservative feedback-derived reconfiguration while feeding two transports. It
does not establish heterogeneous feedback behavior and must not evolve into a
room-wide minimum controller.

ADR-0007 keeps stock WebRTC GCC per direct/peer path. Each SFU path starts with
a `HIGH` ceiling and built-in BWE selects from one shared `HIGH+LOW` pair. App
evidence affects topology eligibility and diagnostics, not ordinary layer
selection. `LOW` may already be active, and idle stop depends on the resource
gate. The active representation/layer limit is two, never one per viewer; the
host still has at most two downstream media edges.

If a qualified hardware/power-efficient `LOW` path is unavailable or its
measured encoder/CPU/GPU game or upload load is unacceptable, `LOW` fails closed
for weak paths while healthy paths keep `HIGH`. `LOW` may remain active when
that measured budget passes; stopping it while idle is an optimization.

The app's `HIGH`/`FALLBACK` states and asymmetric windows only classify topology
eligibility, not media layers, and do not form a composite score. Viewer
requests are authenticated, rate-limited, deduplicated advice and need sender
transport/encode plus viewer receive/decode corroboration. UA and device
identity do not participate.

A native relay forwards the selected encoded packets and must not decode or
re-encode them. An ordinary non-scalable representation cannot be forwarded
into a second quality; the bounded choices are a second encode, SVC, or
transcoding. ADR-0007 statically closes current Web P2P simulcast and
Web/LiveKit SVC as cross-path shortcuts, but keeps pinned LiveKit exactly-two
simulcast with built-in SFU bandwidth adaptation on zero-descendant leaves as
the priority runtime candidate. A root-with-children downshift/evacuation gate
must pass before default enablement. Explicit subscriber quality is next if
built-in selection fails; manual sender activation follows if always-on cost
fails; custom/native dual encode is last. A future native SVC decision may
reopen only with an explicit hardware encoder contract, at most two decodable
layers, one encoded
output reused across direct/peer/SFU, independent path selection, and the real
game/power matrix. Media Capabilities or RTCStats power-efficiency signals are
diagnostics, not hardware proof; an unestablished path stays disabled rather
than silently using software. Future dual-tree/striped distribution may reduce
two-copy host upload toward one copy plus redundancy, but does not block
dual-representation work.

Simulcast does not change this native proof boundary: one sender may negotiate
`HIGH`/`LOW`, but separate direct PeerConnections have no portable shared-encode
contract and inactive API state is not physical resource proof. ADR-0007 and
[Realtime Quality Adaptation](./realtime-quality-adaptation.md) own the
static standard-path results and any future native reopen gate. This path still
requires measured per-representation traffic/resources and cannot bypass #28's
stock-GCC/RTX stop line.

## Product Stop Line

The stock Pion GCC plus negotiated RFC 4588 RTX composition is
`no-go-stock-pion-gcc-rtx`; do not work around it with a custom pacer,
congestion controller, interceptor fork, or private transport. The no-RTX
primary-SSRC path stays research-only because it sacrifices retransmission-
specific receiver statistics and can distort RTP/RTCP loss accounting.

No stacked PR is connected to Screener's product path, capture path, or
audio path. Before product consideration, a target native sender must still
prove one physical encoder invocation on representative hardware, live
PLI/FIR-to-encoder control, heterogeneous downstream estimates, bounded burst
and sustained loss, audio/A-V synchronization, reconnect isolation, browser
diversity, lifecycle, and sustained CPU/GPU,
memory, latency, quality, and upload measurements. A third host edge, custom
RTP/SRTP, or a custom congestion-control framework remains out of scope. The
#28 minimum-of-two policy is also out of scope for product code; retaining its
evidence does not retain its policy. Ordinary Web and Native peer ICE stays
STUN-only; optional selected-edge TURN follows the shared controller only after
SFU/UDP fails and needs its own bounded transport gate.

## Primary Sources And License Boundary

- [libwebrtc PeerConnection factory injection](https://webrtc.googlesource.com/src/+/refs/heads/main/api/create_peerconnection_factory.h)
- [libwebrtc VideoEncoder API](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder.h)
- [libwebrtc license](https://webrtc.googlesource.com/src/+/refs/heads/main/LICENSE)
  and [PATENTS](https://webrtc.googlesource.com/src/+/refs/heads/main/PATENTS)
- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [Media Foundation `MFTEnumEx`](https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mftenumex)
- [Media Foundation `ICodecAPI::IsSupported`](https://learn.microsoft.com/en-us/windows/win32/api/icodecapi/nf-icodecapi-icodecapi-issupported)
  and [`IsModifiable`](https://learn.microsoft.com/en-us/windows/win32/api/icodecapi/nf-icodecapi-icodecapi-ismodifiable)
- [Media Foundation H.264 encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder)
- [Media Foundation low-latency codec property](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avlowlatencymode)
- [Media Foundation force-keyframe property](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avencvideoforcekeyframe)
- [WebRTC video codec requirements, RFC 7742](https://www.rfc-editor.org/rfc/rfc7742.html)
- [WebRTC congestion control requirements, RFC 8836](https://www.rfc-editor.org/rfc/rfc8836.html)
- [Pion track fanout implementation](https://github.com/pion/webrtc/blob/main/track_local_static.go)
- [Pion v4.2.18 pinned track implementation](https://github.com/pion/webrtc/blob/v4.2.18/track_local_static.go)
- [Pion send-side bandwidth estimator](https://github.com/pion/interceptor/blob/main/pkg/gcc/send_side_bwe.go)
- [Pion WebRTC license](https://github.com/pion/webrtc/blob/main/LICENSE)
- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [NVIDIA NVENC application note](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-application-note/index.html)
- [Agora Windows screen sharing](https://doc.shengwang.cn/doc/rtc/windows/basic-features/screen-share)
- [Agora Windows encoding preference](https://doc.shengwang.cn/api-ref/rtc/windows/API/enum_encodingpreference)
- [Oopz help center](https://help.oopz.cn/)
- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [W3C WebRTC SVC](https://www.w3.org/TR/webrtc-svc/)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C WebRTC simulcast](https://www.w3.org/TR/webrtc/#simulcast-functionality)
- [Pion WebRTC v4.2.18](https://github.com/pion/webrtc/tree/v4.2.18)
- [Pion Interceptor v0.1.47](https://github.com/pion/interceptor/tree/v0.1.47)
- [Chromium Chrome test switches](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/chrome_switches.cc)
- [Chrome remote-debugging profile requirement](https://developer.chrome.com/blog/remote-debugging-port)
- [Microsoft `taskkill`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
- [Microsoft `FileAttributes.ReparsePoint`](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileattributes?view=net-10.0)
- [RFC 4585 RTP/AVPF feedback](https://www.rfc-editor.org/rfc/rfc4585.html)
- [RFC 4588 RTP retransmission](https://www.rfc-editor.org/rfc/rfc4588.html)
- [RFC 8888 congestion-control feedback](https://www.rfc-editor.org/rfc/rfc8888.html)
- [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer/)
- [Android media projection](https://developer.android.com/media/grow/media-projection)
- [Android media-projection foreground service](https://developer.android.com/develop/background-work/services/fgs/service-types#media-projection)
- [Android `MediaCodecInfo`](https://developer.android.com/reference/android/media/MediaCodecInfo)
- [Android `MediaCodecList`](https://developer.android.com/reference/android/media/MediaCodecList)
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/ScreenCaptureKit)
- [Apple iOS ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)
- [Apple required hardware encoder key](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder)
- [Apple hardware encoder readback](https://developer.apple.com/documentation/videotoolbox/kvtcompressionpropertykey_usinghardwareacceleratedvideoencoder)

The current Go candidate directly uses Pion (MIT) and coder/websocket (ISC).
Before distributing any sender executable, choose the project license and
generate and verify notices for those direct and all transitive dependencies.
libwebrtc/H.264 remains a separate future route requiring its own third-party
notice and patent/licensing review. No source code from these projects was
copied into Screener.
