# Native Shared-Encode Sender

- Research date: 2026-08-19
- Scope: one Windows game-capture sender, one encoded video stream, and at most
  two independent standard WebRTC media edges
- Status: stacked Draft PRs #16/#18/#22/#23/#25/#28 pass one bounded live
  two-leg WebCodecs/Pion candidate, and the later Native path has one Viewer
  delivery proof. Two-leg product shared encoding and release remain unproven.

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

The 2026-08-20 local delivery checkpoint rebased that candidate onto the
then-current access contract, `screener-v2`, with site-access Cookie authentication,
explicit `private-link` creation, fragment-only Viewer grants returned to the
local Host, and STUN-only ordinary ICE. Native creation alone requests a fixed
300-second provisional room. It remains random and memory-only even with SQLite
configured: the current Host session suppresses the reclaim deadline, its
generation-matched disconnect resets the five-minute window, the ordinary
transient room TTL still caps the room, and restart drops it. A pre-auth
connection or authentication failure gets one same-room/token/client-generation
retry without a second room POST. SQLite remained v2 and ordinary Web creation
was unchanged. This paragraph records only the dated candidate boundary; current
source and production are owned by [status](../status.md), executable senders are
outside the current release, and no new work is authorized against v2.
Android stop/capture-failure cleanup keeps the established signaling socket until
its single-thread teardown sends `abandon-room` and then performs a normal close;
pending-work cancellation only blocks callbacks and cancels active HTTP. No ACK
is awaited. A provisional room whose WebSocket handshake never opened remains
bounded by the existing 300-second reclaim window.
HTTP statuses, Cookie attributes, create-room responses, Host authentication,
and ignored Viewer evidence are strict and bounded; errors retain only fixed categories.
Focused Go and TypeScript checks pass. The overbroad unused framework stays
deleted. `npm run probe:native-one-viewer` is the remaining local-only, optional
Native research runner; it is not part of Web acceptance, routine full checks,
or an automatic Actions workflow.

The probe requires an explicit Chrome executable and uses a task-local Go
executable or task-specific `PATH`; neither path is committed. It retains only
bounded booleans, capped counters, and ordinal/generation identities. One frozen
signaling socket, PeerConnection/video track, bridge generation, and Pion edge
must own all positive evidence. Cleanup is fail-closed and completes bounded
process-tree exit, closed-port checks, exact system-Temp profile validation,
reparse-point rejection, and deletion before a pass can be reported. Pure tests
cover deadline expiry, cross-connection evidence, bridge replacement,
cleanup-before-pass, profile bounds, and deletion failure.

The current correctness proof is one complete Chrome 151/Windows loopback with
an in-memory room, peer assistance off, and no production or SQLite access. The
Sender produced positive decoded/source-RTP evidence without a fatal or encoder
error; one Viewer authenticated, completed offer/answer/ICE, received media, and
advanced decoded and rendered frames at 1280x720. Sampled elapsed time and an
asynchronously refreshed Pion delta are diagnostics only and do not decide the
proof. This establishes one-Viewer functional delivery, not performance,
hardware use, public-network behavior, a second Viewer, FIFO promotion,
packaging, or release acceptance.

The retained implementation advances Pion time from positive adjacent source
timestamp deltas rather than assuming `EncodedVideoChunk.duration` is present or
authoritative. Equal or decreasing timestamps fail closed. Focused timeline and
real `/media` tests cover capture jitter, decode, fanout, positive source RTP,
and bounded fatal reporting for unexpected post-config bridge closure. The
probe treats candidates before the first offer and one development-only
pre-offer control-socket replacement as the same test generation; after an
active offer, connection or bridge replacement still fails closed. WebCodecs,
Chromium remote-debugging, Windows cleanup, and pinned Pion sources were
rechecked 2026-08-20.

ADR-0006 owns the remaining staged two-Viewer, third-Viewer waiting/FIFO,
network, package, and release stop lines; this research does not redefine them.

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
evidence is diagnostic and does not select routes or ordinary layers. `LOW` may
already be active, and idle stop depends on the resource
gate. The active representation/layer limit is two, never one per viewer; the
the host follows the configured non-server outbound media-copy capacity; the
two-edge result in this experiment is a historical configuration, not a fixed
policy.

If a qualified hardware/power-efficient `LOW` path is unavailable or its
measured encoder/CPU/GPU game or upload load is unacceptable, `LOW` fails closed
for weak paths while healthy paths keep `HIGH`. `LOW` may remain active when
that measured budget passes; stopping it while idle is an optimization.

The app does not derive topology eligibility from representation state. Viewer
quality requests are authenticated, rate-limited, deduplicated diagnostic advice
and do not form a composite score. UA and device identity do not participate.

A native relay forwards the selected encoded packets and must not decode or
re-encode them. An ordinary non-scalable representation cannot be forwarded
into a second quality; the bounded choices are a second encode, SVC, or
transcoding. ADR-0007 statically closes current Web P2P simulcast and
Web/LiveKit SVC as cross-path shortcuts, but keeps pinned LiveKit exactly-two
simulcast with built-in SFU bandwidth adaptation as the priority runtime
candidate. SFU BWE does not change topology. Explicit subscriber quality is next
if built-in selection fails; manual sender activation follows if always-on cost
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

## 2026-08-21 Evaluation Packaging Boundary

The current source now has one Windows x64 evaluation-package path. It reuses
the existing Go build and MSVC helper build, places the two executables beside
each other, embeds the exact Git revision, adds an internal `SHA256SUMS.txt`,
and publishes the ZIP with an adjacent SHA-256 file.
`screener-sender.exe --version` is the non-interactive package smoke. This does not add an installer,
Electron, auto-update, signing, a bundled server, codec matrix, or release.

The manual-only workflow uses the official `windows-latest` image, whose current
manifest includes VSWhere, the x64 Visual C++ tools, and Windows 11 SDK, and the
official immutable `actions/upload-artifact@v7` path with missing-file failure,
zero second-stage compression for the precompressed ZIP, and seven-day
retention. It has no push or pull-request trigger and is dispatched only at an
explicitly authorized Native release-package boundary; it is not a Web
acceptance gate. GitHub requires authentication to download the resulting
artifact. Sources were checked 2026-08-21.

The linked-binary audit covers 23 modules: coder/websocket is ISC; the 16 Pion
modules are MIT; google/uuid, wlynxg/anet, and the four `golang.org/x` modules
are BSD-style. Every linked module exposes a recognized root license file. The
packager derives the list from `go list -deps`, copies those exact files plus
the Go toolchain license, and fails if a linked module has no license file. No
GPL/AGPL reference or proprietary Oopz code enters the package.

The project distribution license remains undecided. The Actions artifact is
therefore labeled evaluation-only and grants no project redistribution right;
GitHub Release publication remains blocked on the license decision. This
bounded trial artifact does not change ADR-0006's product No-Go status.

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
- [libwebrtc license](https://webrtc.googlesource.com/src/+/refs/heads/main/LICENSE)
- [GitHub Actions artifact upload](https://github.com/actions/upload-artifact)
- [GitHub Windows 2025 runner image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
- [PowerShell `Compress-Archive`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.archive/compress-archive)
- [Go license](https://go.dev/LICENSE)

The current Go candidate directly uses Pion (MIT) and coder/websocket (ISC).
The evaluation package generates and verifies notices for the Go runtime and
all linked direct/transitive dependencies. Choose the project license before a
formal release or redistribution grant.
libwebrtc/H.264 remains a separate future route requiring its own third-party
notice and patent/licensing review. No source code from these projects was
copied into Screener.
