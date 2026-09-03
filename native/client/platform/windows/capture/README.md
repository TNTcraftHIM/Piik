# Windows Capture Process

This isolated Windows process is the capture candidate for Screener Client. It
enumerates local displays and visible top-level windows, binds each window to
its PID and process creation time, and has independent modes for:

- capability discovery (`--probe`);
- process-tree or default-device loopback PCM (`--capture-audio`); or
- WGC/D3D11 screen/window video with adapter-bound, hardware-only Media Foundation
  H.264 output (`--capture-video`).
- bounded 160x90 BMP source previews (`--preview`).

Video and audio run as separate bounded child processes. A source whose audio
loopback cannot be initialized keeps video available and reports audio
unavailable instead of failing the whole source. Process loopback is probed by
activation rather than inferred from a Windows build number; display sources
use the standard render-device loopback available on Windows 10 and later.

It has no software encoder, alternate codec, or network fallback. The Client
consumes the selected process or system-audio stream through its native media
edge when the capability probe reports support. Build it outside the repository
for a bounded capability run:

```powershell
$out = Join-Path ([IO.Path]::GetTempPath()) 'screener-native-capture'
./native/client/platform/windows/capture/build.ps1 -OutputDirectory $out
```

The implementation follows Microsoft's MIT-licensed reference samples and
official API contracts without copying their WIL framework. The retained MF
fixture compiles the same encoder source with `SCREENER_H264_FIXTURE`; there is
not a second product MFT implementation.

- <https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback>
- <https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/tree/master/cpp/ScreenCaptureforHWND>
- <https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params>
- <https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture>
- <https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow>
- <https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded>
