# Native H.264 Hardware Decision Spike

Date: 2026-08-20

Status: Historical gate. Its `no-go-native-h264-hardware-pinned-fmtp`
stop resolved when the explicit opt-in Pion path registered exact `42c01f`;
the product WGC/MF path later passed its attributed one-Viewer smoke.

The later source-only functional slice in
[`native-h264-opt-in-path.md`](./native-h264-opt-in-path.md) registers the
fixture profile explicitly and proves one browser H.264 Host/Viewer loopback.
The native-window source now compiles this fixture's MF encoder source into the
product helper, retaining hardware-only enumeration and exact readback. That
path rendered 203 frames for one Chrome Viewer while the exact helper PID and
adapter LUID matched nonzero Windows `VideoEncode`; offline fixture telemetry
remains separate evidence.

This spike did not amend ADR-0006 or authorize another product, room, or
production run. It answered one narrow question: can a bounded Windows H.264
path satisfy the project's physical hardware-encode and existing default Pion
fmtp contracts before product integration?

The WebCodecs answer remains no: its bounded run did not prove hardware and its
emitted SPS differed from the requested codec string. A subsequent
hardware-only Media Foundation run did prove the selected NVIDIA encoder and
GPU engine, but emitted exact `profile-level-id=42c01f`, which is absent from
the default Pion mode-1 fmtp set. It therefore stopped before Pion, a Viewer,
rooms, or product wiring. The later opt-in source resolved that exact
registration mismatch without changing the browser VP8 default.

## Decision Summary

| Question | Result |
| --- | --- |
| Does Chrome 151 accept H.264 `avc1.42e01f`, Annex B, 720p30, realtime, 3 Mbps, `prefer-hardware`? | Yes. |
| Did the run prove an NVIDIA, AMD, or other hardware encoder? | No. Chrome-process Windows `VideoEncode` samples were all zero and no NVIDIA encode session was added. The sampling boundary cannot prove software because a later-created or non-child hardware process was not retained. |
| Did the requested codec string describe the emitted SPS exactly? | No. The requested `42e01f` produced SPS bytes `42 04 1f`. |
| Did forced key frames carry in-band recovery data? | Yes in this fixture: all six key chunks contained AUD, SPS, PPS, and IDR NAL units. |
| Can Pion v1.10.5 packetize the resulting Annex-B access units? | Yes statically: its `H264Payloader` splits 3/4-byte start codes, suppresses AUD/filler, emits SPS/PPS as STAP-A, and fragments slices as FU-A. |
| Did this isolated spike prove unmodified browser Viewer decode? | No. No PeerConnection, room, Viewer, or production service participated. A later opt-in loopback records that evidence separately. |
| Did this spike authorize the small WebCodecs/Pion codec diff? | No. The later exact-`42c01f` opt-in reopened and proved that boundary separately. |
| Did the Media Foundation fixture prove physical H.264 hardware encode? | Yes for one local RTX 4070 SUPER run: adapter-LUID-bound hardware enumeration, D3D11 awareness, the NVIDIA H.264 Encoder MFT, and process-plus-LUID `VideoEncode` activity agreed. |
| Did that hardware MFT emit an exact default Pion mode-1 fmtp string? | No. It emitted `42c01f`; the default set is `42001f`, `42e01f`, `4d001f`, and `64001f`. The fixture failed closed without changing the request or adding a fallback. This is not a standards-level profile incompatibility. |

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
- RFC 6184 Table 5 identifies Constrained Baseline as `profile_idc=0x42` with
  profile-iop matching `x1xx0000`. Both `42c01f` and `42e01f` match that same
  Constrained Baseline sub-profile at level 3.1 even though their exact fmtp
  strings differ.
- NVIDIA lists the local GeForce RTX 4070 SUPER as an Ada, eighth-generation
  NVENC device with H.264 4:2:0 support. That proves the machine has suitable
  hardware; it does not prove Chrome selected it.
- Media Foundation can enumerate hardware MFTs explicitly with
  `MFT_ENUM_FLAG_HARDWARE`. A D3D11-aware transform can receive an
  `IMFDXGIDeviceManager`, allowing capture and encode surfaces to remain on the
  selected device. Hardware enumeration and D3D awareness are read-back gates,
  not hints.

## WebCodecs Bounded Fixture

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

## Media Foundation Hardware Fixture

The follow-up fixture is retained at
`native/fixtures/mf-h264-hardware/`. Its build compiles the shared encoder
source from `native/window-capture-helper/` with fixture-only synthetic input
and telemetry. The generated fixture executable stays outside the repository
and has no room, capture, audio, signaling, Pion, or Viewer fallback.

### Fixed Contract

- Toolchain: MSVC 19.42 and Windows SDK 10.0.22621.0.
- Selected adapter: DXGI index 0, NVIDIA GeForce RTX 4070 SUPER, LUID
  `0x00000000:0x0001a496`, driver 610.88.
- Selected transform: the sole adapter-bound candidate, NVIDIA H.264 Encoder
  MFT, CLSID `{60F44560-5A20-4857-BFEF-D29773CB8040}`.
- Enumeration: `MFTEnum2` with the selected LUID, NV12 input, H.264 output, and
  only `MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER`.
- Device path: explicit D3D11 hardware device with video support, a reset DXGI
  device manager, `MF_TRANSFORM_ASYNC=true`,
  `MF_SA_D3D11_AWARE=true`, and accepted `MFT_MESSAGE_SET_D3D_MANAGER`.
- Media: NV12 GPU-surface inputs, 1280x720 at 30 fps, 3 Mbps H.264 Baseline
  level 3.1, 360 paced inputs, and a maximum eight in flight.
- Required `ICodecAPI` readback: CBR, 3 Mbps mean bitrate, 12,500-byte
  one-frame VBV, low-latency mode, and a 60-frame GOP. Every value required
  `IsSupported=S_OK`, `SetValue=S_OK`, and exact `GetValue` readback.
- Recovery requests: `CODECAPI_AVEncVideoForceKeyFrame` immediately before
  inputs 0, 60, 120, 180, 240, and 300.

The NVIDIA MFT returned `E_NOTIMPL` for at least the CBR `IsModifiable` query.
That advisory result was not treated as proof either way; an actual
`SetValue=S_OK` followed by exact `GetValue` was required. `S_FALSE`, a failed
set, missing readback, or a changed value still fails. Three redundant controls
were deliberately excluded:

- `AVEncCommonRealTime` was unsupported, while `AVLowLatencyMode` already
  requires no reordering delay and one output per input;
- `AVEncCommonMaxBitRate` applies to peak-constrained VBR, not the selected
  CBR mode; and
- the optional B-picture-count property was unsupported, while Baseline
  excludes B slices and the run independently required ordered timestamps.

This keeps the contract on observable behavior rather than on optional aliases.

### Retained Run

One final instrumented run used the exact adapter and transform above. No
encoded sample was written to disk and no network or Screener process was
started.

| Measure | Retained value |
| --- | --- |
| Inputs / outputs | `360 / 360` |
| Recovery access units | `6 / 6`, each with Annex-B SPS, PPS, and IDR |
| Maximum in flight | `1` |
| Encoded bytes | `2,956,354` |
| Wall time | `12.106 s` |
| Input-to-output latency p95 | `11.575 ms` |
| Fixture process CPU | `2.094 CPU-s` over the run; includes synthetic NV12 generation and event handling |
| Process-and-adapter `VideoEncode` | 45 samples; mean `2.949%`, max `4.863%` |
| Output SPS `profile-level-id` | `42c01f` |
| Final result | `no-go-native-h264-hardware-pinned-fmtp` |

The physical evidence is correlated rather than inferred from low CPU: the
hardware-only activation was bound to the selected DXGI LUID, accepted that
device's D3D manager, and Windows observed `engtype_videoencode` activity for
both the fixture PID and that same LUID. The existing unrelated NVIDIA encoder
session cannot satisfy this PID-and-LUID filter.

The run failed its local gate because `42c01f` is not exactly one of Pion
v4.2.18's default mode-1 values (`42001f`, `42e01f`, `4d001f`, or `64001f`).
RFC 6184 Table 5 nevertheless classifies both `42c01f` and `42e01f` as the same
Constrained Baseline sub-profile. The result is therefore a default-capability
miss with unmodified Viewer interoperability unproven, not an incompatible
H.264 profile. The fixture did not change its request, register a new fmtp, try
the AMD adapter, activate another MFT, or add an NVENC/software fallback. Pion
and Viewer work did not begin, so the result proves a usable hardware-encode
primitive but not a transportable Screener stream.

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

Two exact-string boundaries remain distinct. The earlier WebCodecs run emitted
`42041f`; the Media Foundation run emitted `42c01f`. Pion v4.2.18's default
H.264 mode-1 capabilities include `42001f`, `42e01f`, `4d001f`, and `64001f`,
so neither observed string is present by default. Unlike the earlier WebCodecs
value, the Media Foundation `42c01f` value matches RFC 6184's Constrained
Baseline pattern. Binding a track by MIME type alone can fall back to a partial
codec match and advertise a different format. The next gate must instead:

1. parse emitted SPS before publishing;
2. register and offer the exact emitted, standards-valid mode-1 capability;
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
| Media Foundation hardware H.264 MFT | Proved one physical NVIDIA path with exact transform, D3D11 manager, codec readback, 360 outputs, and six recovery units | Emitted standards-valid Constrained Baseline `42c01f`, outside Pion's default exact fmtp set; no Pion or Viewer proof | Retain fixture; product no-go |
| Direct NVENC | Explicit NVIDIA encoder session and detailed low-latency controls | NVIDIA-only, SDK/API lifecycle and redistribution review, separate AMD/Intel future decisions | Hold unless the Media Foundation hardware contract fails |

Media Foundation remains the smallest proved physical-encode primitive because
it fails closed on an official hardware category without a vendor dispatch
layer. Its default-fmtp miss leaves product interoperability unproven. It is one
Windows H.264 fixture, not an abstraction for VP8/VP9/AV1/HEVC and not a
software fallback.

## Retained Stop Line

The hardware-only fixture is complete for this decision. Do not alter its
requested media type, local default-fmtp gate, or sender wiring merely to make
this fixture return zero. A separately bounded follow-up may register and offer
exact `42c01f`, then test Pion/two-binding and unmodified Viewer decode without
turning that experiment into product integration.

Direct NVENC is still a separately authorized candidate if tighter bitstream
control remains necessary after the bounded `42c01f` interop test. It is
NVIDIA-only and brings a Video Codec SDK license and distribution review, so it
is not an automatic fallback from this Media Foundation result. The existing
WebCodecs-to-Go bridge product gap also remains independent and should not be
hidden inside codec work.

## Go / No-Go Gates

The Media Foundation slice is `go-native-h264-hardware-fixture` only when all
of these are retained in one run. The current result is shown inline:

- pass: exact hardware MFT identity and D3D11-aware readback;
- pass: process-and-adapter-attributed `VideoEncode` activity and no software
  fallback;
- pass: 360/360 bounded outputs with p95 input-to-output latency recorded;
- fail: exact SPS string membership in the default Pion mode-1 fmtp set; this
  does not mean the emitted Constrained Baseline profile is incompatible;
- pass for encoder requests only: six SPS/PPS/IDR recovery access units;
- not run: the same encoded access unit packetized once and delivered over two
  transport bindings; and
- not run: unmodified Viewer decode/render in the target browser matrix.

Any missing physical, fmtp, feedback, or Viewer evidence remains no-go. Do
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
- [Microsoft `MFTEnum2`](https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mftenum2)
- [Microsoft hardware MFTs](https://learn.microsoft.com/en-us/windows/win32/medfound/hardware-mfts)
- [Microsoft asynchronous MFTs](https://learn.microsoft.com/en-us/windows/win32/medfound/asynchronous-mfts)
- [Microsoft async MFT unlock](https://learn.microsoft.com/en-us/windows/win32/medfound/mf-transform-async-unlock)
- [Microsoft `MF_SA_D3D11_AWARE`](https://learn.microsoft.com/en-us/windows/win32/medfound/mf-sa-d3d11-aware)
- [Microsoft `MFCreateDXGIDeviceManager`](https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mfcreatedxgidevicemanager)
- [Microsoft `MFCreateDXGISurfaceBuffer`](https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mfcreatedxgisurfacebuffer)
- [Microsoft H.264 video encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder)
- [Microsoft low-latency codec property](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avlowlatencymode)
- [Microsoft force-key-frame property](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avencvideoforcekeyframe)
- [Microsoft `ICodecAPI::IsModifiable`](https://learn.microsoft.com/en-us/windows/win32/api/strmif/nf-strmif-icodecapi-ismodifiable)
- [Microsoft `ICodecAPI::SetValue`](https://learn.microsoft.com/en-us/windows/win32/api/strmif/nf-strmif-icodecapi-setvalue)
- [Microsoft D3D multithread protection](https://learn.microsoft.com/en-us/windows/win32/api/d3d10/nf-d3d10-id3d10multithread-setmultithreadprotected)
- [Microsoft H.264 profile enumeration](https://learn.microsoft.com/en-us/windows/win32/api/codecapi/ne-codecapi-eavench264vprofile)
- [Pion RTP v1.10.5 H.264 payloader](https://github.com/pion/rtp/blob/v1.10.5/codecs/h264_packet.go)
- [Pion WebRTC v4.2.18 media engine](https://github.com/pion/webrtc/blob/v4.2.18/mediaengine.go)
