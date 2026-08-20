# ADR-0008: Window-Scoped Audio Capture

Date: 2026-08-21

Status: Accepted for the browser hint; native Windows implementation is a
planned P1 input.

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

1. The Web sender requests Chromium's best-effort window-audio hints,
   `windowAudio: "window"` and `systemAudio: "exclude"`. The latter avoids
   offering the whole-system source in Chromium's picker. Older browsers may
   ignore these dictionary members. The UI labels a returned track as
   **window requested, scope unconfirmed** and warns that system audio may
   still be present. It never retries with a wider source after a capture
   failure and never claims isolation from a track's presence alone.
2. The default Web route remains unchanged in topology, codecs, and relay
   behavior. No Web Audio mixer, SDP rewrite, or app-owned audio bitrate knob
   is introduced by this ADR.
3. The native sender's next audio slice is an explicit opt-in
   `window-process-audio` mode on Windows 11. The local capture session owns
   one selected target PID/process tree, one WGC/DXGI video source, and one
   WASAPI loopback audio source. Process IDs, titles, paths, device identity,
   and PCM stay local; they do not enter signaling, URLs, logs, or storage.
4. If the target process exits, produces no render stream, or the loopback
   activation is denied, the sender reports `audio unavailable` or `audio
   silent` and stops/asks the user. It never widens to whole-system audio.
   Windows 10 remains explicitly unsupported until a separate API passes the
   same isolation gate.

## Minimal Native Boundary

This is an interface boundary, not a new framework or a current wire change:

```text
NativeCaptureTarget { pid: uint32, includeProcessTree: true }
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
locally and sends timestamped PCM through the authenticated loopback bridge.
The existing Chrome/Edge sender UI uses `AudioEncoder` with `codec: "opus"`,
48 kHz, two channels, and 20 ms frames, then returns the encoded Opus packets to
the existing Go sender. This reuses the current browser prerequisite and avoids
adding a native Opus library or a second package toolchain in this slice.

The bridge is one typed local media envelope (audio kind, flags, QPC-derived
timestamp, duration, bounded payload); it does not add a public signaling field.
The Go session owns one shared Opus `TrackLocalStaticRTP` and adds it before the
offer on every native PeerConnection. Audio packetization uses the 48 kHz RTP
clock and the source timestamp delta, so one encoded packet stream can feed the
existing two-edge cap. The WGC/DXGI video adapter remains the next small slice;
its `SystemRelativeTime` is retained in the fixture so it can share the same
QPC origin when native video replaces the Web source.

Expected implementation size is about **500--800 new LOC**, excluding the
browser/Windows SDK and existing video/MF fixture code: Windows loopback
capture and local IPC (250--400), Go audio envelope/timeline/track (150--250),
and UI lifecycle/status plus focused tests (100--150). This is a planned P1
input, not current product behavior or a deployment switch.

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
privacy settings. PID, title, path, device identity, and PCM remain local.

The first smoke is one direct Viewer: a test window emits a known tone and
visual marker, while an independent voice process and notification emit
different markers. Require an Opus inbound track and rendered video/audio,
monotonic QPC timestamps, and a bounded A/V offset; verify the unrelated
markers are absent and that target exit/silence stops or asks without widening
capture. SFU/TURN, second Viewer, endurance, and the native WGC video swap are
follow-up gates.

## Consequences

- Current Web users get a useful Chromium hint and an honest status without a
  privacy claim the platform cannot support.
- Strict per-window audio is a native Windows 11 feature, not a browser promise
  or a silent system-audio fallback.
- Android `AudioPlaybackCapture` and packaged cross-platform UI remain later
  candidates; they do not block this slice.

## Follow-Up TODO

- Add the Windows-only WGC + WASAPI process-loopback fixture beside the existing
  Media Foundation H.264 fixture, then land the bounded audio-only P1 slice.
- Feed its timestamped PCM/video pair into the existing native sender only
  after the isolation and sync checks pass; native WGC video replacement stays
  a separate follow-up.
- Retain a short matrix result in `docs/research/`; do not enable the mode by
  default or deploy it from this ADR alone.
