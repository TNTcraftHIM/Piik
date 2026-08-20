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
paired with a selected window's PID and a WGC/DXGI video capture. The API is
available on Windows 11 build 20348 and later; this is not a Windows 10
fallback.

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

## Consequences

- Current Web users get a useful Chromium hint and an honest status without a
  privacy claim the platform cannot support.
- Strict per-window audio is a native Windows 11 feature, not a browser promise
  or a silent system-audio fallback.
- Android `AudioPlaybackCapture` and packaged cross-platform UI remain later
  candidates; they do not block this slice.

## Follow-Up TODO

- Add a Windows-only WGC + WASAPI process-loopback fixture beside the existing
  Media Foundation H.264 fixture.
- Feed its timestamped PCM/video pair into the existing native sender only
  after the isolation and sync checks pass.
- Retain a short matrix result in `docs/research/`; do not enable the mode by
  default or deploy it from this ADR alone.
