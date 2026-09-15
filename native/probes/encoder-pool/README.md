# Encoder Pool Feasibility Probe

Explicit Windows experiment, not a product dependency or CI job. Two real
libwebrtc VideoStreamEncoders consume one synthetic 640x360 source through
independent stock VideoAdapters. It does not capture the desktop or open ports.
[Research and evidence](../../../docs/research/webrtc-encoder-pool.md) own conclusions.

Use Shiguredo `m152.7977.0.2` Windows x64 SDK (WebRTC commit
`6f37672d358475cd17544121a12494da454d85fb`), matching its headers and static library:
[download](https://github.com/shiguredo-webrtc-build/webrtc-build/releases/download/m152.7977.0.2/webrtc.windows_x86_64.zip).
ZIP SHA-256: `3250ee091eb745b9885482d92db352e6bcd5426940021ff90a095747d84d2137`.
Keep the extracted SDK, official compiler dependencies and executable under
ignored `build/encoder-pool`; preserve the SDK's notices. Do not ship this SDK
as part of Piik based on this probe.

With CMake and Visual Studio 2022 x64 tools available:

```powershell
cmake -S native/probes/encoder-pool -B build/encoder-pool/probe -A x64 `
  -DWEBRTC_SDK="$PWD/build/encoder-pool/webrtc"
cmake --build build/encoder-pool/probe --config Release -j 2
& ./build/encoder-pool/probe/Release/encoder-pool-probe.exe
& ./build/encoder-pool/probe/Release/encoder-pool-probe.exe --pooled
& ./build/encoder-pool/probe/Release/encoder-pool-probe.exe --pooled --group-adjuster
```

The tested older compiler was MSVC 14.42; linking requires the newer official
14.44 libraries/linker used by the SDK. On such a machine pass `MSVC_CRT_DIR`
to CMake and `/p:LinkToolPath=<official tools directory>` to MSBuild after `--`.
Do not supply substitute STL implementations or alter global tool settings.

The full trace takes about 51 seconds: healthy, 100 kbps weak B, release to
2 Mbps, one omitted B input, then independent B retirement. `--healthy-only`
omits the weak/release phases. JSONL reports real encoding calls, both WebRTC
decoders, raw libvpx hashes without history-dependent postprocessing, dimensions,
first transition times, group lifetime and resource observations. `integrity`
checks nonzero decoding, error counts, shared-payload comparisons and retirement;
it is not an automatic performance/parity verdict.

`--no-adjuster` is a diagnostic ablation only. `--group-adjuster` instead keeps
WebRTC's actual adjustment algorithm once per physical codec; it must not run
alongside per-VSE correction. `--unsafe-skip` removes dependency protection as a
negative control and should fail integrity with group adjustment and a skipped
input. This cache arm is guarded single-source realtime VP8/L1T1 with synchronous
codecs; no H264 cache, physical overload or public-network claim follows.

`--realtime` removes per-input encoder-queue drains. `--latency-probe` requires
that mode and inserts a bounded pixel-proportional 45 ms codec delay, then
releases it; it is not a CPU/GPU stress test. `--shared-pipeline --realtime
--latency-probe` is a separate control with one full stock VSE feeding both
decoders, not two VSEs borrowing its encoder. Do not combine it with pool or
adjuster flags. Source and codec work remain bounded; use a 95-second process
deadline for these approximately 70-second traces. The shared-pipeline B resource
metrics repeat the common pipeline, while its decoded counters are independent.

## Hardware H264 Pipeline

The separate `--h264` arm wraps the existing Windows MFT `LiveEncoder` in a
WebRTC encoder adapter. It requires `--shared-pipeline --healthy-only --export
PATH`; one complete stock VSE supplies two output callbacks. It does not test
two independent controllers borrowing an H264 encoder. Run it alone, with a
30-second process deadline and no concurrent capture/codec workload:

```powershell
& ./build/encoder-pool/probe/Release/encoder-pool-probe.exe `
  --h264 --shared-pipeline --healthy-only --realtime `
  --export build/encoder-pool/h264-input.jsonl
```

This is synthetic I420 upload to NV12/MFT, not WGC capture or zero-copy input.
The pinned SDK has no H264 decoder, so this arm records payload equality and
encoded dimensions with decoded counters at zero. Validate the exported AUs
separately in Chrome. The existing `scripts/encoded-group-decode.mjs` accepts
`PIIK_ENCODED_CODEC=avc1.42c033` and `PIIK_ENCODED_OUTPUT` pointing to two
arrays of `{Index, Width, Height, PTS, Recovery, Data}` frames (nanosecond PTS,
base64 Annex-B data). A repeated export in those two arrays proves decoding of
that bitstream, not two Pion transports or weak-budget/resource adaptation.

## Healthy Relay Chain

Export the first 180 real AUs from sender A for the opt-in Go forwarding check:

```powershell
& ./build/encoder-pool/probe/Release/encoder-pool-probe.exe `
  --pooled --group-adjuster --healthy-only --export build/encoder-pool/chain-input.jsonl
go test -c -o build/embedded-media/mediaedge.test.exe ./internal/app/mediaedge
$env:PIIK_POOL_CHAIN_FIXTURE = "$PWD/build/encoder-pool/chain-input.jsonl"
$env:PIIK_NATIVE_CAPTURE = "$PWD/build/go-check/piik-capture.exe"
$env:PIIK_POOL_CHAIN_OUTPUT = "$PWD/build/encoder-pool/chain-result.json"
& ./build/embedded-media/mediaedge.test.exe `
  '-test.run=^TestRelayChainEncodedFixture$' '-test.v' '-test.timeout=30s'
```

The real capture executable must already be built, so Native relay capability
remains enabled while checking that healthy forwarding does not start it. This
replays encoded video through two Native receivers and three leaves, checking
recovery-first, contiguous, hash-identical AUs and closure. No frame payload is
committed. Optional output contains only the synthetic trace's summary. It is
not a live encoder/BWE integration or an internet/NAT test.
