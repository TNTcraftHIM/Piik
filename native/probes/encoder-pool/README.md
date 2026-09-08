# Encoder Pool Feasibility Probe

Explicit Windows CPU experiment, not a product dependency or CI job. Two real
libwebrtc VideoStreamEncoders consume one synthetic 640x360 source through
independent stock VideoAdapters. It does not capture the desktop or open ports.
[Research and evidence](../../../docs/research/webrtc-encoder-pool.md) own conclusions.

Use Shiguredo `m152.7977.0.2` Windows x64 SDK (WebRTC commit
`6f37672d358475cd17544121a12494da454d85fb`), matching its headers and static library:
[download](https://github.com/shiguredo-webrtc-build/webrtc-build/releases/download/m152.7977.0.2/webrtc.windows_x86_64.zip).
ZIP SHA-256: `3250ee091eb745b9885482d92db352e6bcd5426940021ff90a095747d84d2137`.
Keep the extracted SDK, official compiler dependencies and executable under
ignored `build/encoder-pool`; preserve the SDK's notices. Do not ship this SDK
as part of Screener based on this probe.

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
input. This is guarded single-source realtime VP8/L1T1 with synchronous codecs;
no H264, asynchronous encoder, physical overload or public-network claim follows.
