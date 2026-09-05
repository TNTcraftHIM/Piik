# Native Client Lifecycle

- Reviewed: 2026-09-05
- Scope: Windows capture idle semantics, native loopback input isolation, and
  Browser visibility of an unexpected Client disconnect.
- Status: static-source, preview-queue and Client-crash checks pass; Windows 10
  monitor startup and game-specific window replacement remain unresolved.

## Current Evidence

An idle WGC source is not a capture-end signal. Source/target closure, control
session loss and individual edge failures have separate owners. A Viewer may
need a keyframe from the retained image while a source remains unchanged.

Source previews use the same serial control connection as share startup. A
virtual-time reproduction with three three-second previews made the real
`NativeClient.startShare()` time out at eight seconds, before its handler ran
at nine seconds. The picker now sends one preview at a time, cancels unsent
work when its source view is retired, and waits for the remaining preview before
starting native media. Refresh and Client replacement fence old results.

## Scope Decisions

- Keep one strict loopback wire and one-share/one-session fence.
- Recovery does not choose a different capture target, codec or media route.
- Do not add a tunnel watchdog, local-process authentication scheme, custom
  quality score, or compatibility alias in this phase.

The loopback identifier boundary is now aligned at 8-256 bytes, and the link
gate is included in TypeScript checking. Evidence wording distinguishes scripted
package gates from physical-device gates. The possible cloudflared orphan and
the intentionally per-user local trust boundary remain separate decisions; no
runtime change for either is claimed here.

## Implemented Boundary

- Windows capture treats a quiet frame pool as idle. It retains one latest
  converted frame and emits it only when an explicit recovery keyframe request
  arrives; source-close and target-process signals remain the end conditions.
- Native Pion candidate input is syntax-checked with the existing ICE parser,
  bounded before queuing, and discarded when malformed, stale, or over capacity.
  Repeated answers for an edge are idempotent. Profile updates remain fenced to
  that same share session in the current loopback v8 wire.
- An unexpected Browser control-socket close now notifies the active Host owner;
  intentional user cleanup remains silent and uses the existing share fence.

## Physical Evidence

- On 2026-09-04, a blank Windows Notepad window was selected as a native source.
  The capture process stayed alive beyond seven seconds without a new source
  change, grew from 7,664 to 16,095 output bytes after a `K` request, and then
  exited cleanly. This validates the quiet-source and retained-frame path on the
  current Windows host; it does not claim a cross-version Windows matrix.
- The same day, the local Native Host gate started a real Host/Viewer share,
  terminated the Client process, and observed the Host return to its start-share
  control within the bounded gate. Browser, capture, server, ports, and profile
  cleanup all passed.
- On 2026-09-05, a Windows 11 build 26200 display-source check produced 91
  hardware-H.264 frames at the 720p30 profile and exited normally. A separate
  source-window check stayed alive through 7.02 seconds without frames while
  minimized, then produced 17 frames within 540 ms of restoration. All owned
  processes, ports and profiles were cleaned up. Neither check establishes the
  reported Windows 10 monitor-start failure or game HWND recreation as fixed.

## Open Capture Reports

The Windows 10 report concerns selecting one entire monitor; application/window
capture, including fullscreen games, works. `CreateForMonitor` supports Windows
10 1903 and later; the current single-HMONITOR call, identity checks and
`CreateFreeThreaded` setup match the documented API. No missing general permission
request has been established. Community reports of disabled capture services or
invalid display contexts are leads, not a diagnosis of this user's machine.
Projected WinRT exceptions now reach the existing capture-error boundary instead
of escaping `std::exception`; that correction alone does not prove startup fixed.

The original converter always fitted the captured pixel aspect into the output:
1280x960 into 1920x1080 yielded 1440x1080 content and 240-pixel side bars, even
when Windows explicitly stretched that desktop source onto a 1920x1080 target.
The Windows adapter now reads the active `QueryDisplayConfig` path and applies
its target aspect only for explicit `STRETCHED`, a unique display path, exact
source/frame dimensions, and display or physical full-client-area capture.
Rotation changes the target aspect, not the orientation of already-oriented WGC
pixels. Output profile dimensions and the one-encode media path are unchanged.

Display metadata refreshes on source geometry changes and existing periodic
keyframes, without another timer or display-setting writes. Unknown/custom
scaling, ambiguous cloned outputs and normal windows keep captured aspect.
This does not prove fidelity to monitor-side scaling or vendor-private game
panel-fit/MPO transforms: those may not appear in desktop display-path metadata.
The CPU geometry check covers stretch, ordinary aspect, rotation and already-
scaled input; the reported game's physical comparison remains acceptance work.

Windows explicitly permits a capture item to close when its application silently
replaces the underlying window. Reattaching to another window is not equivalent
to resuming the same selected target; this remains separate from the verified
quiet/minimized-source behavior.

Primary references: [CreateForMonitor](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createformonitor),
[CreateFreeThreaded](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded),
[capture item closure](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscaptureitem.closed),
and [WinRT exceptions](https://learn.microsoft.com/en-us/uwp/cpp-ref-for-winrt/error-handling/hresult-error).
Aspect references: [active display paths](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-querydisplayconfig),
[scaling modes](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ne-wingdi-displayconfig_scaling),
[active signal size](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-displayconfig_video_signal_info),
and [independent panel fitting/MPO](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/for-best-performance--use-dxgi-flip-model).

## Acceptance

- Static Windows source remains a live share for a bounded physical run, and a
  new Viewer can obtain a keyframe without a source change.
- A malformed/stale ICE candidate or repeated per-edge answer does not close the
  control session or terminate sibling edges; a real edge lifecycle failure
  remains observable.
- Killing the Client causes the active Host owner to leave the native share
  path promptly, while ordinary user-initiated cleanup does not recurse.
- `npm run check` and the relevant Client checks pass; no credentials or raw
  media identifiers enter logs or documentation.

Cross-version capture and browser matrices remain separate acceptance work. They
are not claimed by the current Windows gate.
