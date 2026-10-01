# Media Fidelity

Reviewed 2026-10-01. [Media quality](../standards/media-quality.md) owns behavior;
[TODO](../todo.md) owns remaining work. These synthetic checks do not establish
all-device acceptance or full HDR support.

## Stereo

Browser display capture requests two channels without speech processing. The
Host mixer uses a stereo Web Audio destination; Native capture and mixing use
48 kHz, two-channel PCM16. Native Opus uses the audio application mode. Browser,
Native and SFU receivers request stereo. The existing 64/128/192 kbps choices
are ceilings, not a lossless-audio promise.

`opus/48000/2` alone does not prove stereo content: Opus permits mono packets
under that declaration. [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html#section-7)
distinguishes receive preferences from packet content. Test distinct signals
after decoding instead of inferring fidelity from SDP or a two-channel mixer.

The embedded SFU browser gate sends 500 Hz left and 1500 Hz right, and measures
decoded channel separation. On local Chrome 154, both the default fallback and
SFU-only arms retained more than 77 dB separation in both channels at the 64 kbps
ceiling, including normal video reception. Source changes and subscription
recovery retain the existing audio gate. Run `npm run gate:embedded-sfu` with `PIIK_EMBEDDED_SFU_GATE=true`,
`CHROME_PATH`, and optional `PIIK_EMBEDDED_SFU_ONLY=true`; it cleans up its own
processes and ports. This is synthetic local evidence, not an acoustic or
public-network measurement.

A local Chrome 154 check through the production Host/Viewer peers retained more
than 57 dB separation after direct reception and after one decoding/re-encoding
relay, with a third tone mixed as Host microphone input. The receiver used its
normal video playback sink; a receiver-only Web Audio probe without playback
returned silence and was not a fidelity result. The Native Opus regression test
independently requires more than 20 dB decoded separation at all three bitrates.
These checks support keeping the existing stereo path. They do not cover every
physical source device, browser or acoustic setup, and do not establish surround
sound support.

## SDR Conversion

[#445](https://github.com/TNTcraftHIM/Piik/issues/445) reports washed-out Native
capture on an SDR Windows 10 system. Its proposed explanation is not established:
Microsoft documents full-range RGB as the
[video processor's default input range](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ns-d3d11-d3d11_video_processor_color_space).
The confirmed gap was that `FrameConverter` left its input/output range and
matrix implicit. The same converter handles BGRA capture and decoded NV12
relay input; correcting only screen capture would leave the relay inconsistent.

A local D3D11 check through the previous converter produced full-range NV12 from
BGRA color bars (black Y=0, white Y=255). The production `AdaptiveEncoder` VP8
output then reproduced crushed shadows and clipped highlights in Chrome 154:

| Source gray RGB | Previous conversion, WebRTC playback | Explicit limited-range BT.601 |
| --- | --- | --- |
| 0 | 0 | 0 |
| 32 | 19 | 33 |
| 128 | 130 | 128 |
| 235 | 255 | 235 |
| 255 | 255 | 255 |

The fixture encoded 256x128 color bars with the production converter/encoder,
injected those keyframes into a local VP8 PeerConnection without the color-space
RTP extension, and sampled the playing video into a canvas. The experimental
conversion also restored red/green/blue bars to within one channel value of the
source. This establishes a bounded SDR defect, not the cause of every color
report.

WebCodecs and WebRTC are not interchangeable acceptance paths: explicit BT.709
looked correct through WebCodecs but shifted primary colors through this WebRTC
receiver. Chromium's
[remote-frame conversion](https://chromium.googlesource.com/chromium/src/+/master/third_party/blink/renderer/modules/peerconnection/media_stream_remote_video_source.cc)
can use BT.601 when color metadata is unspecified. White Y=235 is normal for
limited-range YUV; it must become display RGB=255, not be treated as a defect by
itself.

The candidate now declares RGB capture as full range and reads decoded H.264
color metadata from Media Foundation. Unspecified SDR and VP8 use the existing
WebRTC BT.601 convention. The converter produces limited-range BT.601 NV12;
the H.264 media types declare matching range, matrix, primaries and transfer.
Setting only matrix/range did not produce matching H.264 VUI on the tested
NVIDIA encoder. No wire field or user setting is added.

Use the Windows 10
[explicit video color-space API](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_1/nf-d3d11_1-id3d11videocontext1-videoprocessorsetstreamcolorspace1).
The legacy nominal-range API squeezed decoded NV12 a second time in local tests.
Even with the explicit API and a positive format-conversion capability result,
NV12 BT.709-to-BT.601 conversion changed levels on NVIDIA when scaling and left
the matrix unchanged on AMD. Noncanonical NV12 therefore passes through RGB on
the GPU before the shared output conversion. Ordinary RGB capture and already
canonical NV12 keep one pass; no CPU readback, vendor branch or custom shader
is added to the product path.

The opt-in `-CheckColor` probe in the [Windows capture guide](../../native/capture/windows/README.md)
checks full/limited-range BT.601/BT.709 input, scaling and input replacement
through the production converter. It passed on local RTX 4070 SUPER and AMD
Radeon adapters. RTX H.264/VP8 encoding followed by Chrome 154 WebRTC playback
also passed direct reception, decode/scale/re-encode and explicitly tagged
BT.709 H.264 input to both output codecs; sampled RGB errors were at most 5/255.
AMD hardware encoding was not accepted locally: MFT activation returned
`0x8007000e` before color configuration. These local checks do not settle the
reporter's Windows 10 environment, all hardware encoders, HDR content or missing
upstream color declarations.

## HDR To SDR

[#420](https://github.com/TNTcraftHIM/Piik/issues/420) reports overexposure with
both App and Browser capture on one Windows HDR machine. The report does not
locate the failing stage.

The Windows native screen path currently requests BGRA8 for the WGC frame pool
and thumbnails, then converts to NV12 for the existing 8-bit H.264/VP8 encoder.
It has no explicit HDR tone/gamut mapping stage. Microsoft's
[capture guidance](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
warns that HDR needs floating-point capture throughout the input pipeline to
avoid clipping. Reducing brightness after encoding cannot restore clipped
highlights. This is a confirmed implementation gap, not proof that every
reported Browser failure has the same cause.

Native **HDR-to-SDR** is deferred while ordinary SDR correctness and the current
candidate are accepted. Its smallest coherent implementation belongs before the existing
encoder: preserve scRGB FP16 input, use platform tone/gamut mapping and correct
SDR white level, then hand ordinary SDR frames to the current output workers.
Use the same conversion for capture previews. Microsoft's
[HDR tone-map effect](https://learn.microsoft.com/en-us/windows/win32/direct2d/hdr-tone-map-effect)
and [Advanced Color guidance](https://learn.microsoft.com/en-us/windows/win32/direct3darticles/high-dynamic-range)
describe the effect chain and luminance/white-level handling. Do not substitute
a fixed gamma/brightness multiplier or hand-written tone curve.

Before shipping, compare ordinary SDR, SDR content on an HDR display, HDR
highlights, mixed displays, window movement and display-mode changes. Measure
capture cost and check both encoders and thumbnails. Browser capture owns its
own conversion; inspect the acquired frame before assigning a downstream bug.

Full HDR requires a separate end-to-end decision for bit depth, codec support,
color metadata, decoding and mixed Viewer capabilities. It is not a quality
dropdown addition. Preserve ordinary SDR routing and existing compatibility
while assessing HDR-to-SDR; no full-HDR or surround implementation is claimed.
