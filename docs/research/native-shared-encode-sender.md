# Native Shared-Encode Sender

- Research date: 2026-08-19
- Scope: one Windows game-capture sender, one encoded video stream, and at most
  two independent standard WebRTC media edges
- Status: stacked Draft PRs #16/#18/#22/#23/#25/#28 pass one bounded live
  two-leg WebCodecs/Pion candidate; product and physical shared encoding remain
  unproven

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
- In this fixed single-layer spike, aggregate the two `SetRates()` requests by
  taking the minimum total target bitrate and minimum requested frame rate,
  bounded by the selected profile. Do not attempt to merge per-edge loss, RTT,
  bandwidth-allocation, or multilayer state. A weak edge can therefore lower
  quality for the strong edge; independent quality requires another encode or
  a separately accepted layered design.
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

## Pion Validation Route

Pion is the released-public-API validation route while the larger libwebrtc
encoder-proxy experiment remains unbuilt. `TrackLocalStaticSample` owns one
packetizer and writes through a `TrackLocalStaticRTP` that can bind to multiple
PeerConnections, making encoded-payload fanout explicit.

This certainty moves more responsibility into the application. Pion's default
interceptors provide NACK, RTCP reports, statistics, and transport-wide feedback,
but an external encoder still needs explicit send-side bandwidth estimation,
aggregation of both edge targets, encoder bitrate control, PLI handling, and
bounded RTP/RTX queues. A Pion route must use the same minimum-edge rate rule and
must not invent a custom SRTP, ICE, or congestion protocol.

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

## Product Stop Line

The stock Pion GCC plus negotiated RFC 4588 RTX composition is
`no-go-stock-pion-gcc-rtx`; do not work around it with a custom pacer,
congestion controller, interceptor fork, or private transport. The no-RTX
primary-SSRC path stays research-only because it sacrifices retransmission-
specific receiver statistics and can distort RTP/RTCP loss accounting.

No stacked PR is connected to Screener's product controller, capture path, or
audio path. Before product consideration, a target native sender must still
prove one physical encoder invocation on representative hardware, live
PLI/FIR-to-encoder control, heterogeneous downstream estimates, bounded burst
and sustained loss, audio/A-V synchronization, mixed direct/TURN edges,
reconnect isolation, browser diversity, lifecycle, and sustained CPU/GPU,
memory, latency, quality, and upload measurements. A third host edge, custom
RTP/SRTP, or a custom congestion-control framework remains out of scope.

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
- [Pion send-side bandwidth estimator](https://github.com/pion/interceptor/blob/main/pkg/gcc/send_side_bwe.go)
- [Pion WebRTC license](https://github.com/pion/webrtc/blob/main/LICENSE)
- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [Pion WebRTC v4.2.18](https://github.com/pion/webrtc/tree/v4.2.18)
- [Pion Interceptor v0.1.47](https://github.com/pion/interceptor/tree/v0.1.47)
- [RFC 4585 RTP/AVPF feedback](https://www.rfc-editor.org/rfc/rfc4585.html)
- [RFC 4588 RTP retransmission](https://www.rfc-editor.org/rfc/rfc4588.html)
- [RFC 8888 congestion-control feedback](https://www.rfc-editor.org/rfc/rfc8888.html)
- [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer/)

libwebrtc uses a BSD-style license and Pion uses MIT, but distribution still
requires a full libwebrtc third-party notice review and an H.264 patent/licensing
review. No source code from these projects was copied into Screener.
