# macOS Capture Process

This process keeps the native Client media boundary used on Windows while
replacing only the platform implementation. It lists current ScreenCaptureKit
displays and windows, captures one exact source at 1280x720 and 30 fps, requires a
VideoToolbox hardware H.264 encoder, and writes Annex-B Baseline H.264 through
the bounded `SMED` protocol. It advertises no native process-audio capability.

Build on Apple Silicon macOS 13 or newer:

```sh
sh native/client/platform/darwin/capture/build.sh /outside/repository/build
/outside/repository/build/screener-client-capture --self-test
/outside/repository/build/screener-client-capture --probe
```

`--self-test` encodes one in-memory 420v frame through the same hardware-only
VideoToolbox path and requires a constrained-baseline SPS/PPS/IDR. It needs no
Screen Recording permission. Real source selection, capture, and recovery still
require a physical macOS gate.

The first source-list or capture request is subject to the normal macOS Screen
Recording permission. The implementation follows Apple's ScreenCaptureKit and
VideoToolbox contracts and does not bundle another media runtime.

- <https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos>
- <https://developer.apple.com/documentation/videotoolbox/vtcompressionsession-api-collection>
- <https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder>
