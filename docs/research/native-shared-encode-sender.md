# Native Shared-Encode Sender

- Research date: 2026-08-19
- Scope: one Windows game-capture sender, one encoded video stream, and at most
  two independent standard WebRTC media edges
- Status: candidate risk spike; not implemented or accepted for production

## Decision Input

TeamSpeak-style shared encoding is a required later sender phase. It can remove
duplicate host encoding work, but it cannot remove the upload copy, RTP state,
or congestion control required by each outgoing edge. The first implementation
must prove one narrow property before adding capture, audio, UI, or packaging:

> Two unmodified browser viewers receive two independent WebRTC sessions while
> one physical encoder invocation produces the compatible encoded access unit
> consumed by both sessions.

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

## Pion Fallback

Pion is the fallback when public libwebrtc encoder APIs cannot satisfy the
shared property without internal changes. `TrackLocalStaticSample` owns one
packetizer and writes through a `TrackLocalStaticRTP` that can bind to multiple
PeerConnections, making encoded-payload fanout explicit.

This certainty moves more responsibility into the application. Pion's default
interceptors provide NACK, RTCP reports, statistics, and transport-wide feedback,
but an external encoder still needs explicit send-side bandwidth estimation,
aggregation of both edge targets, encoder bitrate control, PLI handling, and
bounded RTP/RTX queues. A Pion route must use the same minimum-edge rate rule and
must not invent a custom SRTP, ICE, or congestion protocol.

## Acceptance And Failure Gates

- Two current unmodified browsers decode continuously.
- Unique physical encode calls equal unique input frames, not twice that count.
- Direct and TURN edges can coexist; rebuilding one edge does not create a
  second physical encoder or interrupt the other edge.
- Limiting one edge lowers the common encoder target without an unbounded pacer
  queue; removing that weak edge lets the remaining target recover.
- One viewer's PLI produces one physical keyframe and both viewers recover.
- Measurements include encode count/time, target and actual bitrate, PLI/NACK,
  RTT/loss, queue growth, CPU, GPU, and host upload.

Reject a libwebrtc fork, deprecated internal-source encoder APIs, SVC/simulcast,
a second codec, FFmpeg/x264, a third host edge, custom RTP/SRTP or congestion
control, automatic topology switching, audio, UI, and packaging in the risk
spike. These are separate decisions after the shared property is proven.

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
- [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer/)

libwebrtc uses a BSD-style license and Pion uses MIT, but distribution still
requires a full libwebrtc third-party notice review and an H.264 patent/licensing
review. No source code from these projects was copied into Screener.
