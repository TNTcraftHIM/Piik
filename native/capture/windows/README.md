# Windows Capture Process

This isolated Windows process provides native capture for Piik App. It
enumerates local displays and visible top-level windows, binds each window to
its PID and process creation time, and has independent modes for:

- capability discovery (`--probe`);
- process-tree or default-device loopback PCM (`--capture-audio`); or
- WGC/D3D11 screen/window video with adapter-bound Media Foundation H.264 or
  libvpx VP8 output (`--capture-video --codec auto|h264|vp8`).
- bounded 320x180 BMP source previews (`--preview`), delivered once per target
  over the local control connection rather than the media route.

The video command receives the current product resolution, frame-rate, bitrate,
and quality preference. A replacement process applies live changes while the Go
session retains its Pion source and connections.

Video and audio run as separate bounded child processes. A source whose audio
loopback cannot be initialized keeps video available and reports audio
unavailable instead of failing the whole source. Process loopback is probed by
activation rather than inferred from a Windows build number; display sources
use the standard render-device loopback available on Windows 10 and later.

Auto compares target-profile encoding work within a four-second selection
budget; H.264 that meets the target needs no software comparison. The selected
codec remains fixed across profile and source changes. VP8 reads the existing
NV12 surface through one staging texture and uses the same encoded-frame
boundary. The process has no network fallback. The App
consumes the selected process or system-audio stream through its native media
edge when the capability probe reports support. Build to the stable project
`build/go-check` directory for a bounded capability run:

```powershell
npm run check:native
```

The checks include synthetic output-worker replacement and failure cases using
WARP and a test codec. They do not capture a screen or validate a physical encoder.

The implementation follows Microsoft's MIT-licensed reference samples and
official API contracts without copying their WIL framework. The retained MF
fixture compiles the same encoder source with `PIIK_H264_FIXTURE`; there is
not a second product MFT implementation.
Shared local outputs use stock WebRTC source/encoder adaptation. H264 keeps
native NV12 surfaces, while WebRTC VP8 reads back into I420. The existing capture
and output mailboxes retain source/generation ownership; adapted sizes and
timestamps cross the same media envelope. Hardware low-latency mode stays on;
the old fixed one-frame VBV override is removed so later bitrate increases are
not trapped by the original buffer limit.

The build caches the pinned WebRTC SDK and matching official MSVC linker/runtime
libraries under `build/encoder-pool`. The SDK supplies libvpx, replacing the
separate source build. Only statically linked code and required notices enter
the package, not the SDK/toolchain or another runtime service.

- <https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback>
- <https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/tree/master/cpp/ScreenCaptureforHWND>
- <https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params>
- <https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture>
- <https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow>
- <https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded>
