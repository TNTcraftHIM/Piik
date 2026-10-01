# Media Fidelity

Reviewed 2026-10-01. [Media quality](../standards/media-quality.md) owns behavior;
[TODO](../todo.md) owns remaining work. These checks do not establish physical
device acceptance or full HDR support.

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

The bounded next implementation is native **HDR-to-SDR**, before the existing
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
