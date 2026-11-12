# Media Fidelity

Reviewed 2026-11-09. [Media quality](../standards/media-quality.md) owns behavior;
[TODO](../todo.md) owns remaining work. These synthetic checks do not establish
all-device acceptance or full HDR support.

## Stereo

Browser display capture requests two channels without speech processing. The
Host mixer uses a stereo Web Audio destination; Native capture and mixing use
48 kHz, two-channel PCM16 on 2.x and Float32 on 3.0. Native Opus uses the audio application mode. Browser,
Native and SFU receivers request stereo. Audio settings are bitrate ceilings,
not a lossless-audio promise; the media-quality owner defines the current controls.

`opus/48000/2` alone does not prove stereo content: Opus permits mono packets
under that declaration. [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html#section-7)
distinguishes receive preferences from packet content. Test distinct signals
after decoding instead of inferring fidelity from SDP or a two-channel mixer.

The embedded SFU browser gate sends 500 Hz left and 1500 Hz right, and measures
decoded channel separation. On local Chrome 154, both the default fallback and
SFU-only arms retained more than 77 dB separation in both channels at the 64 kbps
ceiling, including normal video reception. Source changes and subscription
recovery retain the existing audio gate. The archived 2.x [SFU runner](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/scripts/embedded-sfu-gate.ts) records those inputs and cleanup. This is synthetic local evidence, not an acoustic or
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

### 3.0 Room Microphone

With voice processing disabled, the shared microphone requests two channels and
disables echo cancellation, noise suppression, automatic gain and voice isolation
where supported. A controlled two-channel input through the production
microphone graph, Browser transport and playback retained separate 500 Hz left
and 1500 Hz right signals at the default 64 kbps; received separation was over
53 dB on Chrome 152. The source was a synthetic WAV, not a physical microphone.
A later normal-room control retained those distinct channels through two peer
hops and the receiver's per-person volume graph. Setting that volume to 50%
reduced both channels by 6 dB without downmixing them.

The reported iOS/iPadOS mono input remains under investigation. WebKit's
[microphone configuration](https://github.com/WebKit/WebKit/blob/ff77ff95a2e470c383e2b87fb1c78ee6a8c97caf/Source/WebCore/platform/mediastream/cocoa/CoreAudioCaptureUnit.cpp#L458)
inherits its AudioUnit channel format; its capture capabilities do not expose
`channelCount`. The open [stereo-capture issue](https://bugs.webkit.org/show_bug.cgi?id=210231)
records this limitation. Determine the affected device's actual input channels
before attributing mono content to Piik's mixer or Opus transport. Turning off
voice processing does not turn a mono source into stereo.

### Stronger Microphone Suppression

Keep Browser voice processing as the default for the shared 3.0 microphone. For
[#518](https://github.com/TNTcraftHIM/Piik/issues/518), the first candidate is
[Jitsi's RNNoise AudioWorklet](https://github.com/jitsi/jitsi-meet/blob/cc7058813b00f33f322f587e1805528424bb5a48/react/features/stream-effects/noise-suppression/NoiseSuppressorWorklet.ts)
and its [synchronous WASM module](https://github.com/jitsi/rnnoise-wasm/tree/cb529a59a8478fe604e57986fc96afdaecfa6fb7).
It uses Xiph's 48 kHz, 480-sample mono processing. The selected script is 1.93 MB
before compression, 1.33 MB with gzip, and starts with a 16 MiB WASM heap.
[DeepFilterNet's WASM interface](https://github.com/Rikorose/DeepFilterNet/blob/7b14b895fe7fc42cab72b4a4c1e49c982bd6404b/libDF/src/wasm.rs)
requires its model and tract inference runtime; RNNoise is the smaller initial
integration.

A Chrome 156 software-capture comparison used the same licensed WebRTC speech
sample with synthetic fan-like noise, including normal speech, quiet speech and
noise-only intervals. Capture settings confirmed the requested processing.
RNNoise replaced Browser noise suppression while retaining Browser AEC and AGC;
the production microphone gain/output graph remained in use. Noise-only output
fell substantially, while voice-waveform comparison did not establish improved
speech fidelity. Simultaneous dry and processed branches measured about 31 ms
of added delay. This selects a candidate for matched-level listening and mobile
runtime checks; it does not select a new default or measure acoustic echo control.
The listening comparison time-aligns these captures, matches normal-speech RMS
with one gain per mode and preserves relative quiet speech and pause levels.
It reuses recorded test audio without requesting a microphone or running the
candidate in the product.

An Android API 35 emulator running Chrome 124 completed one 22-second dry control
and one RNNoise AudioWorklet run with the same licensed speech/noise input,
processing 1,056,000 samples per run without processor errors or non-finite output.
No microphone was opened and output gain was zero. RNNoise initialization took
315 ms with a 16 MiB WASM heap; its 2,200 processing frames averaged 0.669 ms,
with p99 6 ms and a maximum of 26 ms. Two exceeded the 10 ms frame budget.
The worklet's millisecond-resolution clock limits timing precision, and Chrome
exposed no hardware playback-underrun statistics. Module loading also included
cache effects between runs. This is emulator candidate evidence, not physical-phone
acceptance or a mode decision; matched-level listening, real-device cost, power
and sustained playback remain unverified.

Any accepted enhancement belongs before gain in the shared `MicrophoneInput`,
once per captured microphone; rooms continue to clone its stable output. Keep
the unprocessed stereo path and screen/system audio unchanged. Prepare processing
before replacing the live graph, preserve Browser AEC, and retire the worklet
with its existing AudioContext. No product dependency or processing mode has
been added by this assessment.

## Windows Output Routing

Windows display capture without exclusion reads the default render endpoint.
Process inclusion or exclusion uses the
[endpoint-independent process loopback API](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).
These scopes are distinct in both the maintained helper and Rust capture.

For [#534](https://github.com/TNTcraftHIM/Piik/issues/534), a controlled run sent
500 Hz left and 1500 Hz right at amplitude 0.02 only to an existing virtual
render endpoint, leaving the default headset unchanged. Default-endpoint
loopback returned no packets; excluding an unrelated silent test process
returned 399 packets with both tone amplitudes near 0.01984. Only tone statistics
were retained; no system PCM, device setting or default route was saved or changed.
This reproduces the reported contrast between capture modes. The report's
change after first using exclusion still needs its actual playback endpoint and
capture result. Clearing exclusion is already verified to select a fresh default
capture; do not retain an arbitrary exclusion as a supposed repair.

### 3.0 PCM Continuity

On 2026-11-12 UTC, source `5090abfb`, a three-second Razer endpoint control
read only WASAPI packet counts, flags and timestamps while rendering silence;
no PCM was read or saved and no default device changed. Its 150 assembled
20 ms frames included 17 timestamp steps early by more than half a sample,
including adjacent 20.1381/19.868 ms steps. Device sample positions remained
continuous. Process inclusion of a private tone on a virtual endpoint produced
exact 20 ms frame steps with both Float32 and PCM16; that API returned zero
device positions, so those positions cannot supply a common Windows clock.

WASAPI's [device-clock contract](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclock-getfrequency)
allows drift and jitter relative to QPC. Chromium's
[WASAPI input](https://github.com/chromium/chromium/blob/main/media/audio/win/audio_low_latency_input_win.cc)
keeps PCM in FIFO order and supplies capture time separately, rather than
using each QPC observation as an instruction to remove or insert samples.

Feeding the recorded hardware timestamps and a generated continuous tone through
the unmodified production `Mix` changed PCM in 134 of 150 frames and inserted
1,010 zero channel samples. The mixer aligned every frame independently to its
previous output deadline, converting timestamp variation into sample removal.
Using the production `encode_audio` and pinned `rusty-opus` encoder/decoder,
144 packets differed from a direct-PCM control; decoded RMS difference was
0.07747 for input peaks of 0.25/0.20. Exact 20 ms timestamps produced identical
packets and decoded samples. This demonstrates a Piik continuity defect before
encoding, not an Opus format or stereo failure.

The correction carries capture-segment sample positions through the existing
mixer. Continuous frames keep their PCM order; a new segment uses the current
capture-time correlation for alignment. Audio RTP follows output sample positions,
including exact known queue losses, while sender reports retain the original
capture timestamps. The frozen hardware sequence now matches the direct-PCM
control packet-for-packet and sample-for-sample after decoding, with 960 RTP ticks
per frame. Focused checks also retain partial frames across input retirement,
explicit gaps, source changes and the existing capture cleanup.

A separate five-minute control used two continuous inputs with a 100 ppm rate
difference. Fixed input anchors made the slower input permanently expire after
about 200 seconds; neither that rate nor the failure was measured on the
reporter's device. The mixer now renews an expired alignment only when the
frame's actual capture time is still current. Genuinely late PCM stays discarded,
and ordinary timestamp jitter still preserves sample order. Both input directions
recover in the control, with one 20 ms missing-input frame rather than permanent
silence. This bounded recovery does not provide smooth asynchronous resampling;
continued independent-clock drift can still require occasional realignment.

The sample-order correction was also checked in a Windows package, sharing an
owned program's 440/880 Hz stereo signal to an independent Browser through the
normal App UI. The source rendered
only to a named virtual output; the receiver stayed muted and analysed the signal
without speaker output. Both channels remained distinct over a five-second
sample, with no clipping or non-finite values, followed by normal sharing stop
and App shutdown. This checks the packaged process-capture path, not the
reporter's default output device or room playback.

The beta9/10 report that excluding Piik removes noise while excluding Notepad
does not remains unexplained by these controls: both exclusions use process
loopback. The observed mixer defect is not yet the demonstrated cause of that
report. Changing a capture API or adding a filter would not establish its cause.

Exclusion follows the selected window's process identity, not its title.
Windows excludes that [process and its children](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode).
Classic console windows can [report their attached client as their owner](https://github.com/microsoft/terminal/blob/main/src/interactivity/win32/windowio.cpp),
so neither Piik nor the terminal host can be inferred from the title alone.
Piik's pinned browser launcher starts the browser directly; a newly started
browser may belong to that tree. Confirm the actual selected process and that
the intended game/video sound survives exclusion before attributing the result
to Piik playback. With the capture mode unchanged, muting only Piik's Browser
playback is a useful discriminator if the updated candidate remains noisy.

Opt-in App diagnostics retain the configured Windows shared-sound scope, the
selected process ID and the Native process ID after identity validation and
audio-client initialization.
This allows a report to distinguish excluding the App itself from excluding another
process without inferring identity from its window title. It records configuration,
not proof that the stream started or that an audible feedback loop occurred.

An [OBS reporter](https://obsproject.com/forum/threads/application-audio-capture-beta-not-working-properly.162419/)
resolved application-capture interference by disabling Windows audio enhancements.
This makes endpoint effects a plausible alternative, but does not explain why
two excluded processes differ. Piik's current shared-mode Float32 reader and
Opus input agree on sample layout; the known WASAPI silent-buffer reader defect
is bypassed. These findings do not justify a dependency upgrade or driver change
without a matching reproduction.

## SDR Conversion

[#445](https://github.com/TNTcraftHIM/Piik/issues/445) reports washed-out Native
capture on an SDR Windows 10 system. The reporter
[confirmed the updated release resolved the overexposure](https://github.com/TNTcraftHIM/Piik/issues/445#issuecomment-5958654848)
on 2026-10-02. That field result does not establish the proposed explanation:
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

The implementation declares RGB capture as full range and reads decoded H.264
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

The 2.x opt-in `-CheckColor` probe in the [Windows capture guide](https://github.com/TNTcraftHIM/Piik/blob/72ca6f2bc97df88e216a392721250309aa53bc39/native/capture/windows/README.md)
checks full/limited-range BT.601/BT.709 input, scaling and input replacement
through the production converter. It passed on local RTX 4070 SUPER and AMD
Radeon adapters. RTX H.264/VP8 encoding followed by Chrome 154 WebRTC playback
also passed direct reception, decode/scale/re-encode and explicitly tagged
BT.709 H.264 input to both output codecs; sampled RGB errors were at most 5/255.
AMD hardware encoding was not accepted locally: MFT activation returned
`0x8007000e` before color configuration. These local checks do not establish
coverage of all hardware encoders, HDR content or missing upstream color declarations.

The isolated Rust Native pipeline uses the same raw-frame colour contract,
including GPU process handoff and actual decoder matrix/range. In Chrome 156
WebRTC controls, canonical conversion reduced direct VP8's maximum RGB channel
error from 22/255 to 2/255. Direct H264 and derived outputs from VP8, BT.601 H264
and explicitly tagged BT.709 H264 also stayed within 2/255. These controls use
the production converter and encoders, rather than WebCodecs colour defaults.

## HDR To SDR

[#420](https://github.com/TNTcraftHIM/Piik/issues/420) initially reported
overexposure with both App and Browser capture. On 2026-10-04 the reporter
confirmed that native App capture was corrected in v1.7, while Browser capture
remained overexposed. This is one machine's evidence, not all-device acceptance.

The previous native WGC frame pool and thumbnails requested BGRA8, discarding
HDR range before the existing 8-bit H.264/VP8 encoder. Microsoft's
[capture guidance](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
warns that HDR needs floating-point capture throughout the input pipeline to
avoid clipping. Reducing brightness after encoding cannot restore clipped
highlights. This is a confirmed implementation gap, not proof that every
reported Browser failure has the same cause.

Windows source adapters perform tone mapping before native output fanout and in
thumbnails. HDR displays use an scRGB FP16 pool, then Windows Direct2D's
[HDR tone-map effect](https://learn.microsoft.com/en-us/windows/win32/direct2d/hdr-tone-map-effect)
compresses luminance, the
[white-level effect](https://learn.microsoft.com/en-us/windows/win32/direct2d/white-level-adjustment-effect)
accounts for the source display's SDR white, and color management converts to
sRGB BGRA8. Ordinary SDR retains its texture-copy path. No custom shader,
CPU readback, new packaged dependency or per-output tone mapper is added.

Source-monitor movement and DXGI factory invalidation refresh color metadata,
following [GetDesc1's contract](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_6/nf-dxgi1_6-idxgioutput6-getdesc1).
A format change recreates WGC resources inside the source owner;
it does not restart routes or encoders. WGC supplies no per-frame MaxCLL, so
conversion uses the display peak (at least the configured SDR white), or the
HDR10 10,000-nit range when usable peak metadata is absent. This stable platform
policy avoids a second image-content adaptation loop; real-display appearance
remains an acceptance requirement.

The retained `-CheckColor` probe passed on RTX 4070 SUPER and AMD Radeon:
0–1000-nit neutral bars preserved distinguishable highlights, source white
80/240/80 nits and SDR/HDR size changes preserved ownership and ordinary SDR
colors. Production H.264/VP8 output decoded over Chrome 154 WebRTC reproduced the
converted SDR gray bars within 1/255. These are synthetic input checks, not
observations of an HDR game or the reporter's machine.

The isolated Rust source adapter also passes real-GPU synthetic controls for
highlight detail, white-level changes, resizing and retained texture ownership.
Its normal App sharing and source-preview paths pass SDR regression with H264,
VP8, live quality changes and source replacement.

Warmed GPU timestamp measurements for conversion, including the owned input
copy, had the following local medians. Dimensions are captured input sizes,
not newly supported sharing presets.

| Adapter | 1920x1080 | 3840x2160 |
| --- | --- | --- |
| RTX 4070 SUPER | 0.045 ms | 0.240 ms |
| AMD Radeon | 2.39 ms | 11.17 ms |

HDR conversion has a real GPU cost on weaker devices. These bounded measurements
exclude encoding and do not establish gaming/endurance performance. Current
monitors were SDR: physical HDR highlights, SDR content on HDR displays,
thumbnails, mixed displays and mode changes under load remain unaccepted.
Browser capture owns its own conversion; inspect the acquired frame before
assigning a downstream bug.

The reviewed [WebRTC WGC implementation](https://webrtc.googlesource.com/src/+/b5cf1fa607113788cf894d5b6895c72fba1d9254/modules/desktop_capture/win/wgc_capture_session.cc)
requests an 8-bit BGRA frame pool. The Web capture API exposes no portable
HDR-tone-mapping control; once highlights are clipped, lowering brightness in
Piik cannot recover them. Keep this Browser/platform limitation explicit and
offer native capture or disabling system HDR in troubleshooting. Do not add a
second Browser pixel pipeline without evidence that it receives intact HDR.

Full HDR requires a separate end-to-end decision for bit depth, codec support,
color metadata, decoding and mixed Viewer capabilities. It is not a quality
dropdown addition. Preserve ordinary SDR routing and existing compatibility
with HDR-to-SDR; no full-HDR or surround implementation is claimed.

## 2.0 Fidelity Reassessment

Reviewed 2026-10-13 after the owner reopened HDR and multichannel consideration.
Changing Piik's signaling contract does not by itself extend WebRTC codecs,
capture formats or decoded outputs. Numeric quality limits and media formats
have different compatibility boundaries.

| Capability | Current evidence and additional work |
| --- | --- |
| Mono/stereo | Already carried by the existing Opus track, including microphone mixing, relay and SFU. Retain decoded-channel verification; a channel selector is unnecessary for these inputs. |
| HDR source viewed as SDR | Windows native capture and thumbnails use the existing tone mapper. Physical HDR display acceptance remains open. Browser-owned capture may already have clipped highlights before Piik receives a frame. |
| End-to-end HDR | Needs intact high-bit-depth capture, a supported HDR codec, color metadata and compatible decoding through every relay/output. Current native output uses 8-bit H.264/VP8. Mixed SDR viewers need a defined conversion owner; signaling an HDR flag cannot provide this. |
| 5.1/7.1 surround | Needs channel-layout-preserving capture/mixing, multistream encoding, receiver admission and a stereo downmix boundary. Native PCM/Opus and the Browser microphone mix currently use two-channel output; adding a numeric channel count would silently overstate their capability. |

The [W3C HDR interoperability discussion](https://github.com/w3c/webrtc-extensions/issues/253)
documents Chrome decoding with VP9 profile 2 and color-space RTP metadata, while
capture controls, interoperability tests and metadata standardization remain
work areas. This supports a possible experiment, not universal Browser HDR.
A local Windows Chrome 152 capability query advertised VP9 profile 2; it did
not exercise HDR capture, encoding, display, Native reception or mixed viewers.

[RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html#section-7)
defines ordinary Opus RTP mono/stereo negotiation. Libwebrtc has a separate
[multiopus implementation](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/codecs/opus/audio_encoder_multi_channel_opus_impl.cc)
with stream counts and channel mapping. Chromium's
[SDP handling](https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/modules/peerconnection/rtc_peer_connection.cc)
notes that the Browser does not generate multiopus itself. The same local
capability query offered ordinary Opus with two channels and no multiopus.
These facts do not establish that manual negotiation is impossible; they rule
out assuming that an existing Opus connection automatically becomes surround.

Recommendation: retain stereo and HDR-to-SDR for the current candidate. Do not
reserve speculative wire fields or promise full HDR/surround. Reopen an isolated
prototype when a concrete source/receiver pair justifies it; first verify actual
decoded colors or channel separation and a mixed-capability relay path. Reuse
SDP/RTP format negotiation where it suffices rather than creating a second codec
negotiation protocol. This assessment adds no feature or new release requirement.
