# Windows Capture Process

This isolated Windows process is the capture candidate for Screener Client. It
enumerates visible top-level windows locally, binds the selected HWND to its PID
and process creation time, and has independent modes for:

- capability discovery (`--probe`);
- process-tree PCM (`--capture-audio`); or
- WGC/D3D11 window video with adapter-bound, hardware-only Media Foundation
  H.264 output (`--capture-video`).

Video and audio run as separate bounded child processes. A Windows version that
supports window capture but not process-loopback audio therefore keeps video
available and reports audio unavailable instead of failing the whole source.

It has no whole-system audio, software encoder, alternate codec, or network
fallback. The Client consumes the process-audio stream through its native media
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
