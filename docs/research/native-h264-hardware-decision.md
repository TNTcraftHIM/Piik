# Native H.264 Hardware Decision Spike

Date: 2026-08-20

Status: `no-go-webcodecs-h264-hardware-unclassified`

This spike does not amend ADR-0006 or authorize another product, room, or
production run. It answers one narrow question: can the existing local-browser
Native candidate switch from VP8 to WebCodecs H.264 and satisfy the project's
physical hardware-encode contract with a small codec change?

The answer is no. The H.264 bitstream and Pion packetization path are
mechanically plausible, but the one bounded run did not observe a hardware
encoder and emitted SPS constraint bytes that differ from the requested
WebCodecs codec string. Their negotiated-fmtp compatibility remains
unclassified. A WebCodecs H.264 product switch is frozen. The next candidate is
a separate Windows hardware-only Media Foundation fixture, not a codec ladder
or fallback framework.

## Decision Summary

| Question | Result |
| --- | --- |
| Does Chrome 151 accept H.264 `avc1.42e01f`, Annex B, 720p30, realtime, 3 Mbps, `prefer-hardware`? | Yes. |
| Did the run prove an NVIDIA, AMD, or other hardware encoder? | No. Chrome-process Windows `VideoEncode` samples were all zero and no NVIDIA encode session was added. The sampling boundary cannot prove software because a later-created or non-child hardware process was not retained. |
| Did the requested codec string describe the emitted SPS exactly? | No. The requested `42e01f` produced SPS bytes `42 04 1f`. |
| Did forced key frames carry in-band recovery data? | Yes in this fixture: all six key chunks contained AUD, SPS, PPS, and IDR NAL units. |
| Can Pion v1.10.5 packetize the resulting Annex-B access units? | Yes statically: its `H264Payloader` splits 3/4-byte start codes, suppresses AUD/filler, emits SPS/PPS as STAP-A, and fragments slices as FU-A. |
| Is unmodified browser Viewer decode proven? | No. No PeerConnection, room, Viewer, or production service participated. |
| Should the small WebCodecs/Pion codec diff be implemented? | No. It would preserve the two unresolved product gates: physical encoder identity and exact negotiated H.264 fmtp/constraint compatibility. |

## Standards And Platform Constraints

- WebCodecs defines `hardwareAcceleration: "prefer-hardware"` as a preference.
  The user agent may ignore it, and `isConfigSupported()` is only a best-effort
  capability answer. The answer can also change with resource availability.
- The AVC WebCodecs registration defines `avc.format: "annexb"`. Annex-B output
  carries SPS/PPS in the bitstream instead of an AVC decoder configuration
  description, which is the appropriate shape for live RTP packetization.
- WebRTC browsers must implement VP8 and H.264 Constrained Baseline. H.264
  endpoints must support RFC 6184 and `packetization-mode=1`, include
  `profile-level-id`, and send parameter sets in-band.
- NVIDIA lists the local GeForce RTX 4070 SUPER as an Ada, eighth-generation
  NVENC device with H.264 4:2:0 support. That proves the machine has suitable
  hardware; it does not prove Chrome selected it.
- Media Foundation can enumerate hardware MFTs explicitly with
  `MFT_ENUM_FLAG_HARDWARE`. A D3D11-aware transform can receive an
  `IMFDXGIDeviceManager`, allowing capture and encode surfaces to remain on the
  selected device. Hardware enumeration and D3D awareness are read-back gates,
  not hints.

## Bounded Fixture

### Isolation

- Browser: Google Chrome `151.0.7922.138`.
- GPU cohort: NVIDIA GeForce RTX 4070 SUPER, NVIDIA driver `610.88`; an AMD
  Radeon integrated adapter and virtual display adapters were also present.
- Source: local `127.0.0.1` page with a synthetic 1280x720 Canvas. No Screener
  server, signaling endpoint, room, account, Viewer, Oopz process, or production
  endpoint was started or contacted.
- Chrome used a unique temporary profile, D3D11 ANGLE, background throttling
  disabled, and an off-screen window. The two temporary profiles contained no
  reparse points. After the run, both exact temporary trees were audited again
  without following links, deleted, and confirmed absent.
- Each codec was attempted at most once. H.264 performed one encode run. VP8
  failed the exact `prefer-hardware` capability check and was not silently
  retried with `no-preference`.

### Encoder Fixture

```text
width/height:          1280 x 720
framerate:             30
duration:              360 inputs / about 12 seconds
bitrate:               3,000,000 bits/s
latencyMode:           realtime
bitrateMode:           variable
hardwareAcceleration:  prefer-hardware
H.264 codec/format:     avc1.42e01f / annexb
key-frame request:      frames 0, 60, 120, 180, 240, 300
source:                 moving synthetic Canvas, one VideoFrame per 33.333 ms
```

The output callback recorded each chunk's timestamp, size, callback latency,
and Annex-B NAL types. It parsed the SPS profile, constraint, and level bytes.
It did not save encoded frames.

The temporary fixture and sampling scripts were not retained. This is a single
bounded observation, not a repository-reproducible benchmark. The 15.984-second
CPU sampling window also extends beyond the 11.978-second encode loop, so its
CPU value describes the whole sampled Chrome process tree rather than active
encode cost.

### Physical Evidence Method

The hardware decision did not use `isConfigSupported()` as proof.

1. The launched Chrome process tree was resolved after the target attached and
   before encoder configuration. It included the browser, GPU, utility, and
   renderer processes.
2. Windows sampled
   `\\GPU Engine(*)\\Utilization Percentage` once per second for 15 samples and
   retained only `engtype_videoencode` instances owned by that process tree.
3. The same samples retained cumulative CPU seconds for the process tree.
4. `nvidia-smi` sampled global encoder session count, FPS, latency, and encoder
   utilization. An unrelated `nvcontainer.exe` session already existed, so
   global utilization was discarded as attribution evidence; only a new
   session could have corroborated Chrome NVENC use.

This method has one explicit limitation: the process tree was not re-enumerated
after encoding began. A hardware service created later or outside Chrome's
parent/child tree would not have been attributed. The result is therefore
"hardware not proven", not a claim that a particular software encoder was
positively identified.

## Raw Bounded Evidence

### H.264

| Measure | Retained value |
| --- | --- |
| `isConfigSupported` | `true`; returned config retained `prefer-hardware`, `realtime`, `variable`, and `annexb` |
| Inputs / outputs | `360 / 360` |
| Encode-loop wall time | `11,977.6 ms` |
| Output bytes / observed VBR rate | `2,275,233 / 1,521,047 bit/s` |
| Encoder queue peak | `8` |
| Output callback latency | p50 `10.0 ms`; p95 `11.3 ms`; max `241.8 ms` |
| Scheduling delay | p50 `1.07 ms`; p95 `14.17 ms`; max `15.8 ms` |
| Pending outputs / fatal error | `0 / none` |
| Decoder config | codec `avc1.42e01f`, 1280x720, description `0` bytes |
| Chrome-tree `VideoEncode` | 15 samples: `[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]` |
| NVIDIA global sessions | 15 samples: `[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]` |
| Chrome-tree CPU | `3.21875 CPU-s / 15.984 wall-s`; `1.259%` of 16 logical processors, or about `20.1%` of one logical processor |

CPU includes Chrome, Canvas drawing, frame construction, and encode work; it is
not an isolated encoder CPU measurement.

All six requested key chunks had NAL types `[9, 7, 8, 5]`, meaning AUD, SPS,
PPS, and IDR. Their byte sizes were
`[6074, 8675, 6672, 9567, 8483, 10011]`. Each began with the same retained
prefix:

```text
000000010910000000016742041fe8a02802ddff
```

The parsed SPS bytes were `profile_idc=0x42`, constraints `0x04`, and
`level_idc=0x1f` (`42041f`). That is not the requested codec string's
`42e01f`. WebCodecs requires an encoder to produce a stream at least as
constrained as the requested string, but this spike does not attempt to prove
the H.264 semantic relationship between those two constraint bytes. The
product gate is simpler: do not advertise or request an fmtp value until the
emitted stream's constraint bytes are proven compatible, then prove an
unmodified Viewer negotiation and decode.

### VP8

The exact same 720p30 configuration with codec `vp8` and
`hardwareAcceleration: "prefer-hardware"` returned
`isConfigSupported().supported=false`. No VP8 frames were encoded and no
latency or CPU comparison is claimed. The current ADR-0006 candidate deletes
`hardwareAcceleration` and continues when that check fails; the existing
shared-encode research already classifies that behavior as an implementation
preference, not physical hardware evidence.

## Static Product-Path Evaluation

The small bitstream path is plausible:

```text
one VideoEncoder
  -> existing 17-byte Frame envelope
  -> one Go Fanout queue and RTP packetizer
  -> one TrackLocalStaticRTP
  -> at most two PeerConnections / transport-local bindings
```

- `native/sender/internal/app/ui/app.js` owns one `VideoEncoder` object and
  marks the next submitted frame as a key frame when any downstream request is
  pending.
- `native/sender/internal/media/fanout.go` owns one queue, one timeline, and one
  packetizer. Switching `VP8Payloader` to `H264Payloader` would not create a
  per-Viewer encoder.
- `native/sender/internal/remote/peer.go` adds the same track to every bounded
  PeerConnection. PLI or FIR on any leg emits the existing shared key-frame
  request. A connected late Viewer also requests a key frame.
- Pion RTP v1.10.5 accepts Annex-B access units. Its H.264 payloader stores SPS
  and PPS, emits them as STAP-A before the following NALU, fragments large NALUs
  as FU-A, and discards AUD/filler. This requires negotiated
  `packetization-mode=1`.

The fixture's repeated `[SPS, PPS, IDR]` key chunks make the shared feedback
shape credible: one merged PLI/FIR can generate one access unit for every
bound Viewer. This is static evidence plus an encoder-only fixture, not a
Viewer proof.

The unresolved constraint-byte/fmtp compatibility boundary blocks the
mechanical switch. Pion v4.2.18's
default H.264 mode-1 capabilities include `42001f`, `42e01f`, `4d001f`, and
`64001f`; they do not include the observed `42041f`. Binding a track by MIME
type alone can fall back to a partial codec match and advertise a different
format. The gate must instead:

1. parse emitted SPS before publishing;
2. register and offer only an exactly compatible mode-1 capability;
3. retain the selected answer `profile-level-id` without raw SDP;
4. prove Chrome, Edge, Firefox, and Safari Viewer decode/render;
5. prove every join/PLI/FIR recovery unit carries usable in-band SPS/PPS and
   IDR; and
6. retain one encoder invocation while two independent RTP bindings advance.

The obvious WebCodecs/Pion edit is roughly 40-80 core lines plus focused tests,
but it cannot supply either a portable hardware identity or this interop proof.
It therefore does not satisfy this spike's 200-300-core-line implementation
exception despite being textually small.

## WebCodecs Versus Native Hardware APIs

| Route | Advantage | Blocking cost / risk | Decision |
| --- | --- | --- | --- |
| WebCodecs H.264 Annex B + Pion | Smallest diff; observed SPS/PPS/IDR cadence; existing shared fanout remains intact | Hardware request is a hint; no encoder identity/readback; emitted constraint bytes differ and fmtp compatibility is unclassified; no Viewer proof | Freeze |
| Media Foundation hardware H.264 MFT | Windows hardware-only enumeration, exact transform activation, D3D11 device manager, ICodecAPI support/readback, vendor-neutral across installed hardware MFTs | COM/asynchronous MFT lifecycle and GPU-surface ownership are materially larger than 300 core lines | Next bounded fixture |
| Direct NVENC | Explicit NVIDIA encoder session and detailed low-latency controls | NVIDIA-only, SDK/API lifecycle and redistribution review, separate AMD/Intel future decisions | Hold unless the Media Foundation hardware contract fails |

Media Foundation is the Occam candidate because it can fail closed on an
official hardware category while avoiding a vendor dispatch layer. It is one
Windows H.264 path, not an abstraction for VP8/VP9/AV1/HEVC and not a software
fallback.

## Next Native Slice

Build an offline Windows executable fixture before touching capture, rooms, or
the existing sender:

1. Create one D3D11 device on the explicitly selected adapter with
   `D3D11_CREATE_DEVICE_VIDEO_SUPPORT`; create and reset one DXGI device
   manager.
2. Enumerate only `MFT_CATEGORY_VIDEO_ENCODER` transforms matching H.264 output
   with `MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER`. Record bounded
   activation identity and fail when the count is zero.
3. Activate exactly one transform. Require `MF_SA_D3D11_AWARE=true`, send
   `MFT_MESSAGE_SET_D3D_MANAGER`, and never retry a synchronous/software MFT.
4. Use fixed NV12 1280x720@30 input and H.264 3 Mbps output. Require and read
   back Constrained Baseline or another profile that exactly matches a Pion
   mode-1 capability, level 3.1 or lower, realtime/low-latency mode, CBR mean
   bitrate, bounded VBV, no frame reordering, and a 60-frame maximum GOP.
   Unsupported, read-only, or weakened properties fail the fixture.
5. Feed 360 synthetic GPU-resident frames. Retain input-to-output latency,
   output cadence, queue depth, CPU, and adapter-specific Windows
   `VideoEncode`. Add a vendor session counter only where the selected adapter
   exposes one. Capability enumeration alone does not pass.
6. Force an IDR at frames 0/60/120/180/240/300 and through the same
   key-frame-request entry point. Parse every recovery access unit for Annex-B
   SPS/PPS/IDR and exact profile/level bytes.
7. Pass the same encoded access unit through Pion `H264Payloader` to two local
   transport bindings, then prove an unmodified browser Viewer answer and
   decode/render. Do not enter a Screener room.

NVIDIA's low-latency guidance supports CBR, a very small (approximately one
frame) VBV, low/ultra-low-latency tuning, and explicit IDR recovery. The first
Media Foundation fixture should use only controls that its selected hardware
MFT reports as supported and modifiable and then returns unchanged. Do not add
an NVENC fallback when a Media Foundation control is absent.

### Rough Size

| Responsibility | Estimated core LOC |
| --- | ---: |
| D3D11 adapter/device, DXGI manager, synthetic NV12 surfaces | 180-260 |
| Hardware-only MFT enumeration, activation, identity/readback | 100-160 |
| Media types, ICodecAPI configuration, asynchronous input/output pump | 260-380 |
| Annex-B/profile/key-frame validation and bounded measurements | 120-180 |
| **Offline fixture total** | **660-980** |

Focused tests and harness glue are likely another 200-350 lines. Windows
Graphics Capture, BGRA-to-NV12 conversion, audio, packaging, and product bridge
integration are explicitly outside that estimate. This is not a 200-300-line
product change, so no implementation was started in this branch.

## Go / No-Go Gates

The Media Foundation slice is `go-native-h264-hardware-fixture` only when all
of these are retained in one run:

- exact hardware MFT identity and D3D11-aware readback;
- adapter-attributed `VideoEncode` activity and no software fallback;
- 360/360 bounded outputs with p95 input-to-output latency recorded;
- exact SPS profile/constraint/level matching the offered mode-1 fmtp;
- SPS/PPS/IDR after startup, late-join request, PLI, and FIR;
- the same encoded access unit packetized once and delivered over two transport
  bindings; and
- unmodified Viewer decode/render in the target browser matrix.

Any missing physical, profile, feedback, or Viewer evidence remains no-go. Do
not infer success from codec support, adapter model, transform enumeration,
low CPU, or a single browser decode.

## License Boundary

- Pion RTP/WebRTC is MIT and remains the packetization/transport candidate; no
  Pion source was copied into this repository.
- Media Foundation and D3D11 are Windows platform APIs. The fixture should use
  installed hardware MFTs and avoid redistributing vendor codec binaries.
- Direct NVENC would require a separate NVIDIA Video Codec SDK license and
  redistribution review before product work.
- H.264 patent/licensing obligations remain unresolved regardless of whether
  encoding is reached through WebCodecs, Media Foundation, or NVENC. The
  project license and distribution model must be decided before distributing a
  sender executable.

## Primary Sources

Accessed 2026-08-20:

- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)
- [W3C AVC WebCodecs registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/)
- [RFC 7742: WebRTC video codec requirements](https://www.rfc-editor.org/rfc/rfc7742.html)
- [RFC 6184: H.264 RTP payload format](https://www.rfc-editor.org/rfc/rfc6184.html)
- [NVIDIA video encode/decode support matrix](https://developer.nvidia.com/video-encode-decode-support-matrix)
- [NVIDIA NVENC application note](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-application-note/index.html)
- [NVIDIA NVENC programming guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)
- [NVIDIA System Management Interface](https://docs.nvidia.com/deploy/nvidia-smi/index.html)
- [Microsoft `typeperf`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/typeperf)
- [Microsoft `MFTEnumEx`](https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mftenumex)
- [Microsoft hardware MFTs](https://learn.microsoft.com/en-us/windows/win32/medfound/hardware-mfts)
- [Microsoft `MF_SA_D3D11_AWARE`](https://learn.microsoft.com/en-us/windows/win32/medfound/mf-sa-d3d11-aware)
- [Microsoft `MFCreateDXGIDeviceManager`](https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mfcreatedxgidevicemanager)
- [Microsoft H.264 video encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder)
- [Microsoft low-latency codec property](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avlowlatencymode)
- [Microsoft force-key-frame property](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avencvideoforcekeyframe)
- [Microsoft H.264 profile enumeration](https://learn.microsoft.com/en-us/windows/win32/api/codecapi/ne-codecapi-eavench264vprofile)
- [Pion RTP v1.10.5 H.264 payloader](https://github.com/pion/rtp/blob/v1.10.5/codecs/h264_packet.go)
- [Pion WebRTC v4.2.18 media engine](https://github.com/pion/webrtc/blob/v4.2.18/mediaengine.go)
