# Native Client Lifecycle

- Reviewed: 2026-09-09
- Scope: Windows capture idle semantics, native loopback input isolation, and
  Browser visibility of an unexpected Client disconnect.
- Status: quiet-source, preview-queue and Client-crash checks pass. The owner
  confirmed Windows 10 monitor sharing resolved; game-specific window replacement
  is not established by the quiet-source checks.

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
  that same share session in the current loopback v9 wire.
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
- On 2026-09-08, the current multi-output Windows VP8 Host gate captured only
  its own animated Chrome window. Live presets, paused changes, minimize/change
  resolution/restore/another change, and source replacement preserved the
  Viewer's media object. Closing the actual source ended the share; restarting
  delivered 30 new Viewer frames. Server-accepted Native quality evidence and
  process/port/profile cleanup passed. The gate's stale Node JSON-log assertion
  was corrected to the current Go text format, without changing evidence
  eligibility. This is not H264 overload, Win10, or game-window replacement
  evidence. The same owned-window sequence subsequently passed H264. Further
  physical runs use the serialized plan in [TODO](../todo.md).

The multi-output Windows worker initially reapplied the source's frame-rate
limit from each worker's first input timestamp. With jitter and a later worker
start, this second limiter could reject frames already admitted by capture.
Captured inputs now carry their existing cadence bound; a worker limits only
when it needs a lower rate. Received encoded input has no such bound and keeps
its output limiter. No capture ceiling, media clock or quality setting changed.
In the same owned-window H264 720p15 SFU gate, the reported Native output went
from 12 fps before this correction to 15 fps after it. Both runs decoded 300
720p frames, applied a live 480p change and cleaned up. This is a local cadence
comparison, not a claim about hardware overload or all games.

## Open Capture Reports

The Windows 10 report concerns selecting one entire monitor; application/window
capture, including fullscreen games, works. `CreateForMonitor` supports Windows
10 1903 and later; the current single-HMONITOR call, identity checks and
`CreateFreeThreaded` setup match the documented API. No missing general permission
request has been established. Community reports of disabled capture services or
invalid display contexts are leads, not a diagnosis of this user's machine.
Projected WinRT exceptions now reach the existing capture-error boundary instead
of escaping `std::exception`; that correction alone does not prove startup fixed.
On 2026-09-09, the owner confirmed whole-display sharing works and closed this
report. That field confirmation does not establish which earlier correction or
environment change resolved it; no further workaround is justified by this report.

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

The 2026-09-08 owner clarification names CS2, fullscreen 4:3 stretched: leave the
game, change advanced share settings, then return; the share ends on return.
The ordinary-window gate does not reproduce exclusive-fullscreen/display-mode
changes. Capture replacement overlap, target identity and device state remain
separate hypotheses until that exact transition is observed.

Later that day, the Windows 11 candidate ran the actual installed CS2 in
fullscreen 1920x1440. The desktop changed from 2560x1440 while the game was
minimized to 1920x1440 after return. Two real HostPage pending updates returned
to the game after 1,703 ms and 1,545 ms: H264 1080p30 to 720p30 and back.
The Viewer received both actual sizes, retained its media object, and the game
kept its HWND/process generation. The current candidate did not reproduce the
reported interruption in this menu-level sequence. Game settings were restored
byte-for-byte and all owned processes, ports and Browser profiles closed.
An additional prolonged-background case failed to keep CS2 minimized before
the settings action, so it is not a passed or failed capture check. Vendor-side
stretch fidelity, in-match execution and the affected machine remain unverified.

The end-to-end review did confirm a separate presentation defect: share
termination during a pending update cleared its token but retained the advanced
draft. A restart used the last applied settings while controls could show the
failed draft. Cleanup now restores the applied settings through the existing
commit helper; no new state or recovery mechanism was added. This alone is not
claimed as the cause of CS2 capture termination.

The later owner-supplied `cbdd751` CS2 diagnostic bundle records three 720p30
update requests, all rejected while the existing 1080p30 share remains live.
It contains no successful 720p commit or explicit rollback-to-1080 request.
The Browser's failed-request rollback explains its controls returning to the
committed profile, but the original generic error does not identify which
preparation step failed or explain the reported brief Viewer-size change.
Current diagnostics add fixed preparation rejection stages without changing
capture recovery policy. Do not label the affected-device report resolved.

The matched `0675265` local reproduction then held CS2 minimized continuously
for 8.6 seconds during a 720p request. Preparation failed with `wait-timeout`
after 5,015 ms and controls reverted; the Viewer retained 1080p and its media
object. The identical request succeeded in 438 ms after restoring the game.
The affected machine's subsequent bundle independently records eleven update
timeouts, three successes and one cancellation caused by share termination.
This establishes a quiet-source/readiness error in the live-update path, not
an old setting request overwriting a successfully installed replacement.

On 2026-09-09, matched `cbb3d77` passed the corrected path through actual Windows
Graphics Capture and Browser playback. An owned source stopped repainting and
remained minimized for 8,378 ms: the 720p request stayed pending while the Viewer
retained 1080p. Restoring the source delivered 720p in 1,868 ms; the next 1080p
request delivered in 480 ms, retaining the media object. Both updates succeeded;
all processes, ports and Browser profiles closed. This closes the reproduced
quiet-source timeout defect. CS2 foreground automation did not complete that
same post-fix sequence, so this does not establish game-specific display-mode
or HWND replacement behavior.

That same bundle also contains two independent `adaptive-output` capture
failures at H264 1440p60, one without a settings update in progress. A controlled
1440p60/12 Mbps high-entropy input produced a valid 1,609,216-byte keyframe and
reproduced the one-MiB capture-envelope rejection. The MFT and RTP access-unit
owners already permit four MiB. Aligning capture readers/writers removes that
false fatal rejection, but does not by itself establish delivery: the separate
500-packet forwarding/pacing bound also loses that large recovery frame. Both
boundaries must be verified before describing the large-frame report as fixed.

The aligned 4,096-packet source/pacing/reassembly window subsequently delivered
two copies of that actual keyframe byte-for-byte with zero paced drops or
assembly loss. The 500-packet comparison dropped 1,182 packets and reconstructed
none. Active fixture heap usage increased by roughly ten to thirteen MiB;
LiveKit's packet cache still grows lazily and all queues remain bounded. Go
capture and transport now share the encoded-frame bounds owner. This fixes a
reproduced legal-input failure, not proof that every compound `adaptive-output`
error in the field had the same cause; distinct failure stages preserve that
remaining distinction.

The `cbdd751` Vivaldi bundle shows two successful Native H264 1080p30 capture
starts followed by a local outbound PeerConnection remaining connecting for
about 7.985 seconds. The Browser bridge's eight-second startup timeout then
stops the Native share cleanly. This is a local media-bridge failure boundary,
not evidence that Windows capture or the control WebSocket failed. That bundle
does not distinguish ICE from DTLS or a Browser policy. Current diagnostics
record those states and candidate-type counts separately; the UI reports a
connection error. The subsequent `0675265` bundle shows four successful capture
starts, each with two Native UDP host candidates, no usable remote candidates,
ICE stuck checking and no DTLS connection before the same deadline.

The owner then confirmed the affected Vivaldi report was resolved: a VPN
extension forcibly disabled **Broadcast IP for Best WebRTC Performance**;
correcting the setting/extension restored Native sharing. The confirmed cause
is that extension's WebRTC policy, not unsupported Windows capture. VPN
extensions may reapply the override; the
[Chromium WebRTC FAQ](../../cmd/piik-client/README.md#chromium-webrtc-connections)
owns the user steps. This does not authorize a Browser-specific transport fallback.

An isolated Chrome 152.0.7977.82 data-channel A/B verifies the policy
mechanism: default handling gathers one UDP host candidate per peer and connects
ICE/DTLS in 33 ms; `disable_non_proxied_udp` gathers no candidates and remains
unconnected at 8,009 ms. The check uses fresh profiles and the effective
`--webrtc-ip-handling-policy` switch, without capture, encoding or user-profile
changes. This establishes Chromium's policy mechanism; the affected Vivaldi case
was resolved by the owner's setting correction above. Extra STUN or a longer
timeout cannot restore candidates disabled by that policy.

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
