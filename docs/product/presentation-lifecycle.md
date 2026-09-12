# Presentation And Lifecycle

This file owns user-visible workflow, presentation authority, presence, and
Browser lifecycle promises. Component structure, CSS, exact copy, and routine UI
tests belong in source code.

## Product Surface

The first screen is the working tool, not a marketing page. Once site access is
available, starting a share and joining a room are equally discoverable actions;
joining expands the four-digit room form in place, while `/join` remains a direct
entry route. Users never choose a media topology.

Host entry requires both site access and a validated capability description.
Initial entry, retry and password recovery load the same prerequisites; failed
authentication cannot leave a later successful entry using absent capability
state. A capability-load failure remains retryable and does not imply that a
service is available or disabled. Viewer/Join entry does not need this Host-only
description.

The Host workspace centers the capture preview, room code, invitation and common
share controls. The Viewer workspace centers one persistent 16:9 video stage,
room identity, current state, roster, and one manual media-reconnect action.
Controls and text must remain usable without overlap or horizontal overflow on
desktop and mobile viewports.

Piik App opens this same application in the system Browser. Its small
startup surface selects Local, temporary public invitation, or a configured
Site before entering the Host workspace. Viewer links opened at that activated
origin may use the same running App without changing the Viewer UI. Starting a share offers the
Browser picker and any exact App-owned native windows. It never chooses a
window automatically. A reproduced Browser-window, capture, or background
failure is required before introducing an embedded Web runtime.

Server and App share one control layout and vocabulary. Deployment capabilities
may fix a control on or off, but do not remove its place in the interface;
disabled controls explain their reason in text and pure-visual modes. Real
workflow differences remain explicit: site authorization, opt-in diagnostics
and the capture/audio capabilities of the connected device are not alternate
versions of the product UI.

A remembered App activation permits discovery when choosing a source or
receiving media; it does not make App a prerequisite for sharing. Idle Host
pages hold no App control session. Ordinary Web entry opens the Browser picker
directly. Activated origins offer the shared source selector, initially on its
Browser tab unless App is already connected. Discovery never blocks Browser
selection or changes the chosen tab. Native tabs and refresh remain reachable
after absence or disconnection; pending attempts are shared, completed failures
do not suppress later discovery. Cancelling the selector or ending a share
releases its unused control session; an obsolete operation cannot install or
retire another operation's media. Optional native ingress uses an already
available connection without another scan. If it is not ready at Browser
startup, that share keeps Browser senders.

A reachable Piik App with an incompatible control protocol is distinct from an
absent App. Discovery continues looking for a compatible process before reporting
the mismatch; the source selector retains Browser operation and offers update/
refresh guidance. Discovery metadata may grow, while known identity and capability
types remain validated. Missing optional capabilities are unavailable; control
commands and responses retain their strict protocol contract.

## Visual Language

Chinese, English, and pure-visual modes are three expressions of the same typed
state and command catalog. On first use, the App and Server UI follow the
Browser's primary system language: Chinese uses Chinese text, and other
languages use English. Pure-visual mode remains an explicit choice. An explicit
later choice is persisted and takes precedence over that default. Text modes
use concise copy.

The [visual language](../design/visual-language.md) is the single owner of
illustrative roles and objects, semantic colour, panel grammar, motion,
accessible input and responsive hierarchy.

## Playback Ownership

One `<video>` element owns Viewer playback and frame proof. The shared playback
bar reflects that element and provides local play/pause, mute, volume, theater,
picture-in-picture, fullscreen and the existing reconnect action. It stays reachable while waiting
or disconnected. Theater and fullscreen are separate modes; fullscreen includes
the playback bar. Identity, connection details and topology stay in the deck.

The bar spans the screen's lower edge. Narrow screens separate audio controls
from window actions into two rows and retain 44px action targets. Playing video hides the bar
after two idle seconds, following [Media Chrome's default](https://github.com/muxinc/media-chrome/blob/main/docs/src/pages/docs/en/components/media-controller.md#autohide).
Pause or unavailable playback keeps it visible. Control hover, keyboard focus,
dragging and an open tooltip hold it open; mouse movement reveals it, and a
touch tap on the picture toggles only visibility. One presentation-only idle
timer owns visibility; it never changes playback or route state. Controls
follow the shared [motion grammar](../design/visual-language.md#motion-grammar).

A desktop primary click on the picture toggles local playback after a brief
double-click window; double-click toggles the available fullscreen action without
first toggling playback. Controls, overlays and keyboard actions keep their own
immediate behavior.

Volume starts on native audio output. An explicit setting away from 100% activates
a local Web Audio stream source and gain, from silence to 200% amplitude. This also
avoids iPhone's system-owned `video.volume`. This output
exclusively owns sound while running, follows video pause and user mute, and
rebinds when the audio track changes. It never modifies the received track or
the stream relayed downstream. Unmount closes the graph. Browsers without gain
support retain 0–100%; video-only system fullscreen also hands audio back to the
native controls at at most 100%, rather than running two outputs.

This uses the standard [Web Audio stream-source and gain nodes](https://www.w3.org/TR/webaudio/).
The gain is amplitude scaling, so loud source peaks can clip above 100%.

Picture-in-picture uses the browser's native video window, including Safari's
presentation-mode API. Native enter/leave events own its displayed state; closing
the window or replacing the received stream does not create another playback
owner. Successful entry exits this video's other fullscreen mode, and unmount
closes only this video's window. Unavailable capabilities remain disabled with
an explanation. The native window contains video and system controls, not page
overlays or the custom bar. See the [PiP specification](https://w3c.github.io/picture-in-picture/)
and [Safari integration](https://developer.apple.com/documentation/webkitjs/adding_picture_in_picture_to_your_safari_media_controls).

Local playback actions never change Host capture or another Viewer. Reconnect
retains the existing route-operation owner. The Host preview remains muted and
has no media controls; explicit Host actions own authoritative pause and stop.

Autoplay rejection exposes the play action. A connection, track object,
or `playing` event alone is not proof that the current route is visible. The
Viewer removes its blocking presentation only after a current-generation frame
is composited, using `requestVideoFrameCallback()` where available and a decoded-
progress fallback otherwise.

## State And Recovery

Access, Host presence and pause, route prepare/active, P2P/SFU connection, media
binding, frame proof, autoplay, and terminal failure are typed facts interpreted
by one presentation reducer. Older route or media generations cannot overwrite
the current result, and raw server errors are never rendered directly.

The room route revision orders control messages; it is not a Viewer media
identity. Reauthentication replaces the route snapshot authoritatively, even if
a replacement controller restarted revision numbering; ordinary updates remain
monotonic within that authority. A Viewer frame belongs to its local media generation and remains
current across unrelated graph revisions until that exact binding is replaced,
invalidated, or terminally failed. Pending candidates never own the primary
badge, status line, or overlay while committed media remains proved. A shared
visual projection maps those facts to title, media status, notices and
overlays. None of these views owns state for another. Connection availability,
actual playback and quality limitation remain separate; raw transport snapshots
do not prove playback or quality. The [status preview](../design/media-status.md)
records the visual vocabulary and the evidence needed for participant lamps.

Excluding time spent in the Browser's capture/play authorization UI, a Viewer
request targets a first visible frame within three seconds. Until then, the page
must continuously show a truthful accessible connection stage rather than a
black screen, ICE-connected state, or unproved `playing` event.

- A proved current frame remains visible behind non-terminal recovery state.
- The [status projection](../design/media-status.md#projection-rules) owns the
  television, Header, notices, participant lamps and title. These consumers
  cannot turn an unproved frame into playback or ordinary quality into failure.
- The Host's couch and Viewer overview share the
  [participant projection](../design/media-status.md#projection-rules). The
  Host's own pawn has no additional lamp. Committed `mediaReady` owns readiness;
  transport diagnostics and quality samples cannot override it in either direction.
- Viewers do not infer another Viewer's quality or diagnose missing readiness
  as terminal failure; roster readiness and quality evidence remain distinct.
- An overlay explains the absence of a usable picture, authoritative Host pause,
  or a required user action. Ordinary quality warnings never cover playback.
- Host pause retains the current frame and waits for resume.
- Host signaling loss alone does not invalidate media that is still healthy.
- Exact media failure or terminal route failure invalidates current-frame proof
  before showing a retained frozen background and recovery or failure state.
- Room not found is distinct from current-room access denial and does not
  prompt for a password.
- Manual reconnect recovers the same route. It does not select a new parent.
- An actionable overlay may appear while fullscreen remains active; application
  state never forces the user out of fullscreen.

Visibility, page freeze, and pagehide suppress application decoded-stall
authority and invalidate quality observations, not already-proved playback.
Returning to the page rebaselines time and re-arms frame observation; an existing
recovery state still requires a fresh current frame to clear. SFU media is
retained independently of transient room-signaling loss, but Browser or OS
suspension and page reclamation remain outside Web guarantees.

Failure of the local Native media bridge disables Native reception for the
current Viewer session before route recovery runs. Future peers in that session
use Browser reception; existing healthy peers are not torn down by this choice.
Parent-network failure alone is not evidence that the local Native capability
is unavailable.

## Presence And Diagnostics

Host and Viewer pages show the authoritative online Viewer count and roster,
independent of the media graph. A display name is Browser-local, NFC-normalized,
at most 24 Unicode code points, and rejects unsafe control or bidirectional
characters. It is a label, not an account, authorization identity, or routing
input. Duplicate names are allowed and receive a room-scoped peer suffix only
when disambiguation is needed.

Connection details are progressive and use one card shape for P2P, peer relay,
and SFU Viewers. Summary fields prioritize actual resolution, FPS, bitrate, and
loss; deeper fields appear only when meaningful. Topology is a separate view.
Native bandwidth or CPU limitation warnings describe the exact outbound sender
that reported adaptation; they do not by themselves locate the physical
bottleneck or describe the Viewer's receive path.
The Host's participant freeze warning requires fresh receive evidence matching
the current upstream and a positive freeze count or duration for that window.
Window `*Delta` fields never inherit older values; other fields may retain their
existing details-display cache. The existing evidence expiry removes stale
warnings. No additional participant state, broadcast, timer or quality score is
introduced. Detailed per-edge observations remain available without a global
warning selected from the first limited child.
Locally exposed selected-candidate addresses may be shown only on the Browser
that owns that PeerConnection and are never uploaded, persisted, or used for
identity or route selection. Explicit Debug mode can export a bounded diagnostic
report through the separate [diagnostic owner](../reference/configuration.md#diagnostics);
ordinary connection details do not collect or expose that report.

Current scope includes Web Host, Web Viewer, Browser relay, and optional Native
Host/Viewer media beneath those same pages. Desktop and mobile Browsers are
Viewer targets; mobile Web capture, reliable background relay, App-owned SFU,
and physical non-Windows native acceptance remain later platform work.

## Primary References

- [WHATWG Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html)
- [ECMAScript string normalization](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.normalize)
- [Unicode UAX #31](https://www.unicode.org/reports/tr31/)
