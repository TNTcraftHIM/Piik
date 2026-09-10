# Media Foundation H.264 Hardware Fixture

This is an offline Windows-only decision fixture. Its build compiles the same
Media Foundation encoder source used by Piik App's Windows capture
process, under a
fixture-only macro for synthetic input and telemetry. The generated fixture is
not linked into the sender and does not contact a room, signaling service,
Viewer, or production endpoint.

The fixture selects one DXGI adapter and one adapter-bound Media Foundation
transform. It never enumerates a software MFT and has no codec or software
fallback. Exit code zero requires all of these checks in one 360-frame run:

- adapter-LUID-bound hardware H.264 enumeration;
- asynchronous and D3D11-aware transform readback;
- exact low-latency, CBR, 3 Mbps, one-frame VBV, and 60-frame GOP property
  readback, plus Baseline media-type request/readback and output-order
  no-reordering checks;
- 360 GPU-surface NV12 inputs and 360 ordered outputs;
- one live `3 Mbps -> 1.5 Mbps -> 3 Mbps` rate change whose three equal phases
  lower and then restore actual encoded bytes without recreating the MFT;
- Annex-B SPS/PPS/IDR at frames 0, 60, 120, 180, 240, and 300;
- an SPS `profile-level-id` exactly present in the fixture's default Pion
  mode-1 fmtp set; and
- process-and-adapter-attributed Windows `VideoEncode` activity.

The generated executable must stay outside the repository. From PowerShell:

```powershell
$out = Join-Path ([IO.Path]::GetTempPath()) 'piik-mf-h264-fixture-build'
./native/fixtures/mf-h264-hardware/build.ps1 -OutputDirectory $out
& "$out/piik-mf-h264-fixture.exe" --list-adapters
& "$out/piik-mf-h264-fixture.exe" --adapter-index 0 --mft-index 0
```

Select the adapter index explicitly from the first command. The MFT index
defaults to zero but is printed and accepted explicitly so a retained run
cannot silently switch transforms.

The fixture prints bounded key/value evidence to stdout and never writes the
encoded bitstream. A nonzero exit is a measured no-go at the reported stage;
it must not be worked around by adding a software retry.

Pion transport and browser decode remain separate from this offline fixture;
the product path reuses its exact `42c01f`, Annex-B, adapter-bound hardware
contract without adding those network concerns to this executable.

Primary API references, accessed 2026-08-20:

- <https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mftenum2>
- <https://learn.microsoft.com/en-us/windows/win32/medfound/asynchronous-mfts>
- <https://learn.microsoft.com/en-us/windows/win32/medfound/mf-transform-async-unlock>
- <https://learn.microsoft.com/en-us/windows/win32/medfound/mf-sa-d3d11-aware>
- <https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mfcreatedxgidevicemanager>
- <https://learn.microsoft.com/en-us/windows/win32/api/mfapi/nf-mfapi-mfcreatedxgisurfacebuffer>
- <https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder>
- <https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avlowlatencymode>
- <https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avencvideoforcekeyframe>
- <https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html>
