# Windows Window-Capture Helper

This Windows 11 helper is the local input for Native sender window capture. It
enumerates visible top-level windows locally, binds the selected HWND to its PID
and process creation time, and has two explicit modes:

- process-tree PCM for the existing browser video sources; or
- WGC/D3D11 window video plus process-tree PCM, with adapter-bound,
  hardware-only Media Foundation H.264 output.

It has no whole-system audio, software encoder, alternate codec, or network
fallback. Build it outside the repository, then place it beside the sender (or
set `SCREENER_WINDOW_CAPTURE_HELPER` for a development run):

```powershell
$out = Join-Path ([IO.Path]::GetTempPath()) 'screener-native-capture'
./native/window-capture-helper/build.ps1 -OutputDirectory $out
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
