# ADR-0008: Window-Scoped Audio Capture

Date: 2026-08-21

Status: Accepted. The browser hint and opt-in Native Windows audio slice are
source-complete, including the bounded Windows x64 evaluation-package path.
The paired WGC/MF hardware-video source passed its one-Viewer acceptance smoke;
all Native sources remain default-off, formally unreleased, and undeployed.

## Context

The Web Host currently receives an optional audio track from
`getDisplayMedia({ audio: true })`. A browser may return no audio, and the Web
API does not expose a portable readback identifying whether that track is a
tab, window, monitor, or whole-system mix. Capturing a system mix while a voice
application is open can leak that conversation back to Viewers.

Windows has a stricter primitive: WASAPI application loopback through
`ActivateAudioInterfaceAsync` with
`AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS.INCLUDE_TARGET_PROCESS_TREE`. It can be
paired with a selected window's PID and a WGC/DXGI video capture. Microsoft's
process-loopback contract starts at build 20348; this product slice gates on
Windows 11 desktop (build 22000 or newer) and is not a Windows 10 fallback.

## Decision

1. The Web sender requests `windowAudio: "window"` for window surfaces and
   `systemAudio: "include"` for monitor surfaces. The browser picker and user
   consent decide whether audio is shared; older browsers may ignore either
   hint, and track presence alone does not identify its source.
2. The default Web route remains unchanged in topology, codecs, and relay
   behavior. Returned audio tracks use the standard `contentHint = "music"`;
   this does not force a codec, bitrate, channel count, or processing mode. No
   Web Audio mixer, SDP rewrite, or app-owned audio bitrate knob is introduced.
3. The native sender has an explicit Windows 11 local window target. Browser
   VP8 may use that target only for `window-process-audio`; the separate
   `native-window-h264` source uses the same bound HWND/PID/creation time for
   WGC/DXGI video and WASAPI process-tree audio. Process IDs, HWNDs, creation
   tokens, titles, paths, device identity, PCM, and local hardware status stay
   local; they do not enter signaling, URLs, logs, or storage.
4. If the target process exits, produces no render stream, or the loopback
   activation is denied, the sender reports `audio unavailable` or `audio
   silent` and stops/asks the user. It never widens to whole-system audio.
   Windows 10 remains explicitly unsupported until a separate API passes the
   same isolation gate.

## Minimal Native Boundary

This is an interface boundary, not a new framework or a current wire change:

```text
NativeCaptureTarget { hwnd: uint64, pid: uint32, creationTime: uint64, includeProcessTree: true }
NativeCaptureSession.start(target)
  -> VideoFrames(WGC/DXGI) + AudioPcm(WASAPI process loopback)
  -> existing native sender timeline/encoder/fanout
NativeCaptureSession.stop()
```

The first fixture should prove only parent-game plus child-game audio, an
independent voice process, a notification, process restart, no render stream,
and A/V sync on one Viewer. It should use Microsoft's Application Loopback
sample and process-loopback parameter contract rather than a custom mixer.

## P1 First Slice: Audio Only

The first product-wiring slice is deliberately smaller than the complete
native capture boundary. It adds an explicit Windows 11
`window-process-audio` input while leaving the current Web video capture and
codec path unchanged. A small Windows helper resolves the selected target PID
and creation time locally, revalidates both immediately before activation, and
sends timestamped PCM through the authenticated loopback bridge.
The existing Chrome/Edge sender UI uses `AudioEncoder` with `codec: "opus"`,
48 kHz, two channels, and 20 ms frames, then returns the encoded Opus packets to
the existing Go sender. This reuses the current browser prerequisite and avoids
adding a native Opus library or a second package toolchain in this slice.

The bridge is one typed local media envelope (audio kind, flags, QPC-derived
timestamp, duration, bounded payload); it does not add a public signaling field.
The Go session owns one shared Opus `TrackLocalStaticRTP` and adds it before the
offer on every native PeerConnection. Audio packetization uses the 48 kHz RTP
clock and the source timestamp delta, so one encoded packet stream can feed the
existing two-edge cap. In this historical audio-only phase, the WGC/DXGI video
adapter was the next small slice; its retained `SystemRelativeTime` let the
completed native-video path share the same QPC origin.

Expected implementation size is about **500--800 new LOC**, excluding the
browser/Windows SDK and existing video/MF fixture code: Windows loopback
capture and local IPC (250--400), Go audio envelope/timeline/track (150--250),
and UI lifecycle/status plus focused tests (100--150). The landed slice keeps
that boundary and is not a deployment switch.

The two source clocks are both converted from 100-ns QPC: WGC
`SystemRelativeTime` and WASAPI `IAudioCaptureClient::GetBuffer`'s
`pu64QPCPosition`. Keep timestamps monotonic and derive audio duration from
the captured frame count (960 samples at 48 kHz for each 20 ms packet), not
from bridge arrival time. `TrackLocalStaticSample.Timestamp` is not the source
timeline control in the current Pion path; the audio fanout therefore uses the
same explicit RTP packetizer/timeline pattern as native video.

The slice fails closed. Windows 10, unsupported WGC, picker cancellation,
activation denial, an exited/inaccessible target, `AUDCLNT_E_DEVICE_INVALIDATED`
or `AUDCLNT_E_SERVICE_NOT_RUNNING`, protected-content silence, and a missing
render stream produce `audio unavailable` or `audio silent`. There is no retry
to whole-system loopback. No administrator privilege is required, but the
helper must run in the interactive user's session and honor Windows consent and
privacy settings. PID, creation token, title, path, device identity, and PCM
remain local.

The first smoke is one direct Viewer: a test window emits a known tone and
visual marker, while an independent voice process and notification emit
different markers. Require an Opus inbound track and rendered video/audio,
monotonic QPC timestamps, and a bounded A/V offset; verify the unrelated
markers are absent and that target exit/silence stops or asks without widening
capture. SFU/UDP, second Viewer, and endurance remain follow-up gates; paired
WGC video completion is recorded below. On 2026-08-21, 100 20-ms chunks isolated a 440 Hz target from
an independent 880 Hz process by 4017.8x. Chrome 151 then received one audio
track and 495 inbound Opus packets while video decoded/rendered 296 frames.

## P1 WGC/MF Completion

The paired native-video source reuses the proven hardware fixture rather than
adding a second encoder framework. WGC creates a capture item directly from the
bound HWND on the selected D3D11 device. The frame pool is free-threaded and is
recreated on content-size changes. D3D11 VideoProcessor performs aspect-fit
BGRA-to-NV12 conversion at fixed 1280x720/30, then the existing adapter-bound,
hardware-only asynchronous MF H.264 path emits Annex-B `42c01f` access units.
There is no software MFT, alternate codec, monitor, or browser-video fallback.

The helper multiplexes process-tree PCM, H.264 access units, and bounded local
status. Go writes H.264 directly to the existing shared fanout; the browser UI
receives only a one-way local copy for `VideoDecoder` preview. PCM retains the
existing WebCodecs Opus bridge. PLI/FIR recovery is generation-bound and
coalesced into a helper key-frame command. The normal browser source uses the
fixed VP8 contract; the native H.264 source remains an explicit mode and is not
an implicit runtime downgrade.

## Consequences

- Current Web users get a useful Chromium hint and an honest status without a
  privacy claim the platform cannot support.
- Strict per-window audio is a native Windows 11 feature, not a browser promise
  or a silent system-audio fallback.
- The helper is packaged beside the sender in a commit-bound evaluation ZIP.
  The ZIP carries internal and external SHA-256 manifests plus exact linked Go
  dependency license files; it is neither an installer nor a release.

## Remaining Evidence Boundary

- A second Viewer, SFU/UDP, endurance, and real-game A/V sync remain unproven;
  the one-Viewer H.264 and attributed `VideoEncode` gate passed.
- The short-lived Windows x64 evaluation artifact is retained evidence, not an
  instruction to download or run it. Native release work remains at the bottom
  of the single project TODO ledger and still requires license, signing, and its
  own acceptance boundary.
