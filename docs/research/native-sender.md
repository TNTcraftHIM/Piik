# Native Sender And Shared-Encode Evidence

- Reviewed: 2026-08-27
- Scope: Windows capture, one hardware H.264 encoder, bounded WebRTC fanout
- Status: historical evidence; obsolete sender implementation deleted

Current product scope is owned by [media quality](../product/media-quality.md).
[ADR-0006](../adr/0006-fixed-high-native-sender-canary.md) owns the stop line.

## Conclusion

A native sender can plausibly capture and encode once while serving bounded
independent WebRTC transports. Shared encoding can reduce capture/encode work;
it cannot remove each child's RTP, congestion, retransmission, encryption, and
network copy.

The retained measurements prove:

- Pion can fan one encoded source into two independent transport bindings;
- one WebCodecs encoder object fed two Browser sessions in a bounded fixture;
- one Windows Graphics Capture/Media Foundation H.264 path used an adapter-
  bound hardware MFT with matching process/LUID `VideoEncode` activity; and
- the product helper delivered H.264 video and process-tree audio to one Chrome
  Viewer.

It does not prove two-Viewer product fanout, heterogeneous congestion feedback,
loss/retransmission correctness, audio synchronization, reconnect isolation,
public networks, endurance, packaging, update/signing, cross-platform behavior,
or distribution licensing. Native remains outside the current release.

## Candidate Shape

The smallest measured Windows pipeline was:

```text
opaque window target
  -> Windows Graphics Capture BGRA surface
  -> one D3D11 conversion to NV12
  -> one adapter-bound hardware Media Foundation H.264 encoder
  -> one generation-bound Go/Pion RTP source
  -> at most two independent PeerConnections
```

Each PeerConnection must keep independent ICE, DTLS-SRTP, SSRC/sequence/TWCC,
pacing, RTCP, congestion, and retransmission state. PLI/FIR from any child may be
coalesced into one shared SPS/PPS/IDR request, but a weak child's bitrate request
cannot silently become a room-wide minimum policy. A third Viewer must wait
under the same endpoint capacity as Web Hosts.

Local target identity, HWND/PID, process creation time, adapter/MFT identity,
PCM, and hardware diagnostics never enter signaling. The helper revalidates the
selected window/process before capture. There is no software, codec, monitor, or
audio fallback hidden behind a hardware-only source choice.

## Browser And Pion Fixtures

A stack of bounded fixtures established progressively narrower facts:

| Gate | Retained result | Missing proof |
| --- | --- | --- |
| One Pion RTP source, two bindings | Equivalent payload reached two transport-local SSRCs. | No encoder or Browser. |
| WebCodecs VP8, two Chrome receivers | One encoder object produced 120 outputs; both decoded. | Physical/hardware encoder identity. |
| 12-second live bridge | 360 inputs/outputs; both Viewers rendered 331 frames; queues remained bounded. | Product rooms/capture/audio. |
| Pion GCC plus negotiated RTX | Failed with unknown RTX SSRC. | Valid shared congestion/retransmission composition. |
| No-RTX replay | One leg recovered without disturbing the other. | Accurate retransmission-specific loss accounting. |
| Two-leg stock GCC | Both estimates happened to be 600 kbps; one shared reconfiguration and keyframe recovery succeeded. | Heterogeneous estimates and product policy. |

The stock-GCC/RTX composition remains no-go. Do not replace it with a custom
pacer, congestion controller, interceptor fork, SRTP, or private transport.
No-RTX replay remains research-only because it can distort RTP/RTCP loss
accounting.

## Hardware Encoder Evidence

### WebCodecs

Chrome accepted H.264 Annex-B 1280x720@30 with `prefer-hardware` and produced
360/360 frames, but Browser-process GPU samples showed no attributed
`VideoEncode` activity. The emitted SPS was `42041f`, not the requested codec
string. This proves usable chunks and in-band recovery units, not hardware
selection or exact WebRTC fmtp compatibility. VP8 `prefer-hardware` was rejected
on the same Windows system.

### Media Foundation Fixture

One MSVC/D3D11 fixture selected the NVIDIA H.264 Encoder MFT on an RTX 4070
SUPER by exact DXGI LUID, required hardware enumeration, D3D11 awareness,
low-latency mode, CBR readback, 3 Mbps, a 60-frame GOP, and forced keyframes.

| Measure | Retained result |
| --- | --- |
| Inputs / outputs | 360 / 360 |
| Recovery units | 6 / 6 with Annex-B SPS, PPS, and IDR |
| Maximum in flight | 1 |
| Wall time | 12.106 s |
| Input-to-output p95 | 11.575 ms |
| Process+adapter VideoEncode | 45 samples; mean 2.949%, max 4.863% |
| Emitted profile | `42c01f` |

The MFT was physically attributed by hardware-only activation, accepted device
manager, exact process/LUID GPU engine, and output progress. Its `42c01f`
Constrained Baseline profile was absent from Pion's default exact mode-1 list,
so the fixture correctly stopped before claiming transport interoperability.
The later opt-in fixture registered that exact profile and proved one Browser
loopback; it did not alter the wider stop line.

### Product Helper Smoke

The Windows helper reuses the same encoder source with WGC capture and
process-tree WASAPI loopback. One bounded run delivered 203 rendered 1280x720
frames and 500 Opus packets to a Chrome Viewer. The exact helper PID and adapter
LUID matched nonzero `VideoEncode`. This is a one-Viewer functional proof, not a
resource or product release claim.

## Remaining Gates

Before native product consideration, one current-wire candidate must prove:

1. current room/Host authorization and source-generation cleanup;
2. exact emitted H.264 profile negotiation and unmodified Chrome, Edge, Firefox,
   and Safari decode/render;
3. two independent transports with one physical encoder and compatible source,
   codec, cadence, and rate requests;
4. correct PLI/FIR, NACK/RTX, TWCC, burst/sustained loss, and reconnect isolation;
5. process audio, A/V synchronization, source switch, pause, and failure;
6. bounded CPU/GPU, memory, latency, quality, upload, queues, and thermals under
   real games and public networks;
7. evaluation packaging followed by installer, signing, update, and recovery;
   and
8. project, dependency, H.264 patent, and distribution license decisions.

No native experiment may preserve an obsolete Screener wire, create another
room/topology model, loosen endpoint capacity, or become production merely to
make a diagnostic gate pass.

## License Boundary

Pion is MIT and coder/websocket is ISC. The Windows APIs use installed hardware
MFTs; vendor codec binaries are not redistributed. Direct NVENC would require a
separate NVIDIA Video Codec SDK and redistribution review. H.264 patent and
project licensing remain unresolved before executable distribution. No
proprietary Oopz/Agora or GPL/AGPL code was copied.

## Primary Sources

- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [Microsoft hardware MFTs](https://learn.microsoft.com/en-us/windows/win32/medfound/hardware-mfts)
- [Microsoft H.264 encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder)
- [Microsoft `MFTEnum2`](https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mftenum2)
- [Microsoft low-latency mode](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avlowlatencymode)
- [Microsoft force keyframe](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avencvideoforcekeyframe)
- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [WebRTC codec requirements, RFC 7742](https://www.rfc-editor.org/rfc/rfc7742.html)
- [H.264 RTP payload, RFC 6184](https://www.rfc-editor.org/rfc/rfc6184.html)
- [WebRTC congestion control, RFC 8836](https://www.rfc-editor.org/rfc/rfc8836.html)
- [RTP feedback, RFC 4585](https://www.rfc-editor.org/rfc/rfc4585.html)
- [RTP retransmission, RFC 4588](https://www.rfc-editor.org/rfc/rfc4588.html)
- [Pion static track fanout](https://github.com/pion/webrtc/blob/v4.2.18/track_local_static.go)
- [Pion H.264 payloader](https://github.com/pion/rtp/blob/v1.10.5/codecs/h264_packet.go)
- [libwebrtc `VideoEncoderFactory`](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder_factory.h)
- [NVIDIA NVENC guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)
