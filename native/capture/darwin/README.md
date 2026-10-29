# macOS Capture Process

This process keeps the native App media boundary used on Windows while
replacing only the platform implementation. It lists current ScreenCaptureKit
displays and windows, captures one exact source with the current product profile,
requires a VideoToolbox hardware H.264 encoder, and writes Annex-B Baseline H.264
through the bounded `SMED` protocol. ScreenCaptureKit application or display
audio is converted to stereo PCM16 for the existing Go Opus boundary. The Go
session applies live profile changes by replacing that capture generation behind
the same Pion source.

Source-picker thumbnails use the same exact target filter and one complete
ScreenCaptureKit frame, then stop capture before returning a bounded BMP.
They do not start the video encoder or source audio.

Build on Apple silicon or Intel macOS 13 or newer; the helper uses the build
machine's architecture:

```sh
sh native/capture/darwin/build.sh /outside/repository/build
/outside/repository/build/piik-capture --geometry-self-test
/outside/repository/build/piik-capture --audio-self-test
/outside/repository/build/piik-capture --self-test
/outside/repository/build/piik-capture --probe
```

`--geometry-self-test` checks content cropping, Retina scaling, the system BMP
thumbnail conversion and rejection of invalid frame geometry, plus H.264
format/aperture admission, without requiring a hardware encoder. Go validates
every raw SPS's coded size and reference budget
before sending encoded input to the helper; CoreMedia can normalize SPS cropping
in its format description. `--self-test`
encodes successive landscape, portrait, ultrawide and small 420v buffers through
one output worker, requiring the fitted dimensions and a constrained-baseline
SPS/PPS/IDR after each size change. `--audio-self-test` checks silent startup,
ready-before-PCM ordering and stopped input without using an audio device.
These checks need no Screen Recording permission.
Real source selection, window resizing, display-scale changes and recovery still
require a physical macOS gate.

The first source-list or capture request is subject to the normal macOS Screen
Recording permission; audio capture has its corresponding usage declaration.
The implementation follows Apple's ScreenCaptureKit, AudioToolbox, and
VideoToolbox contracts and does not bundle another media runtime.

- <https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos>
- <https://developer.apple.com/documentation/screencapturekit/scstreamoutputtype/audio>
- <https://developer.apple.com/documentation/videotoolbox/vtcompressionsession-api-collection>
- <https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder>
