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

Personal room-tool presentation and incoming-route preferences are remembered
within the same Browser origin across rooms and reloads. Their existing domain
owners still apply capability and room-policy constraints. Remote-control
shortcut choices follow this same boundary; App applies them only in memory.
Restoring preferences never restores room admission, control grants, actual held input, passwords or
message drafts, and never starts capture or remote control.

A capable, opted-in authenticated room session
outlives its current publication. Stopping capture retires media, not chat;
restoring an existing room joins it without starting capture. Entering the page
alone does not create a room. Room close, lost authority and page teardown still
retire the session, including its App control connection and pending discovery.
That retirement cannot wait for the denied page to unmount. Connected Viewers may keep interacting while the Host page
is absent, provided the room service and their admitted sessions remain available.
[Rooms and access](./rooms-access.md#room-interactions) owns interaction authority
and retention; [status](../status.md#accepted-interaction-phase) owns release readiness.

The Host can explicitly **Create room** before sharing.
Chat and voice use tabs in the existing interaction window, including its
detached presentation. Closing or changing that window does not leave voice or
stop capture. Microphone, admission and connection states stay literal; an
enabled microphone is not proof that someone is speaking. The
[room voice contract](./rooms-access.md#room-voice) owns channel activation and
membership, independently of the window and picture publication.
The visible voice roster follows connected room members immediately; the
server's reconnect grace does not keep a departed person on screen.

On capable desktop browsers, the interaction window can move to a Document
Picture-in-Picture window. It retains the admitted room session's messages,
reactions and draft. Read visibility and guidance follow its current document.
Closing the window returns it to the page; room retirement or opener teardown
closes it, including a late asynchronous open. Browser window support does not
promise game-overlay transparency, click-through or exclusive-fullscreen coverage.

Desktop Piik App opens this same application in the system Browser. Its startup surface
offers Local and temporary public invitation; the running App is already
available to its approved Sites before either mode starts. Android offers the
same App entry with an explicit wake action; unsupported mobile platforms omit
that entry. Browser and camera actions retain their own capability checks.
A Site's explicit App action discovers the local approval
page, where the user confirms its exact origin. The launcher lists approvals and
revokes each independently. Starring one approved Site makes an ordinary App launch open it;
without a star, the launcher opens. This preference grants no access and starts
no room. Revoking that Site clears its star; other approvals leave it intact. Explicit CLI entry keeps
precedence. The ready App button and terminal launcher address return to its
management page in every mode. A pending or healthy Local/public room keeps its
startup selection; reopening the launcher does not stop or replace that room.
After a failed attempt has fully retired, the launcher can retry or select the
other mode in the same App run. Changing a healthy room's mode requires restarting App.
Activating a page supplies
native capability without restarting its room or healthy media session.
The source selector exposes that same connection action before sharing; a
successful connection refreshes its current list. An already approved exact
origin needs no repeat confirmation, but the page still verifies authorized App
health. Closing the selector cancels its pending connection action. Existing
Browser shares retain their capture implementation until sharing ends.
App-created Local/public-invite Host pages open at their automatically approved
loopback origin. The shared App button reflects verified authorized health,
including activation through another entry and return to an activated page;
a remembered activation alone cannot show readiness. Idle verification holds
no media session or polling loop.
Viewer links opened at that activated origin may use the same running App
without changing the Viewer UI. Starting a share offers the
Browser picker and any exact App-owned native windows. It never chooses a
window automatically. A reproduced Browser-window, capture, or background
failure is required before introducing an embedded Web runtime on desktop.
The Android candidates use that same Web UI inside App or in the system browser,
with platform-owned recording consent and foreground services. Their startup page
and site management reuse the shared launcher. Waking App or navigating to a site
never grants native permission. A pending system permission stays with its
current native request while the user enters App and returns to the browser.
App returns after the requested capture preparation completes, including source
audio; video readiness alone does not complete that operation.

Opening the system Browser is an asynchronous convenience action. One pending
OS handoff is allowed; a slow or failed handler cannot block readiness or App
exit. The console retains the entry address and reports the underlying error.
The App does not terminate the user's browser to enforce a handoff deadline.

Server and App share one control layout and vocabulary. Deployment capabilities
may fix a control on or off, but do not remove its place in the interface;
disabled controls explain their reason in text and pure-visual modes. Real
workflow differences remain explicit: site authorization, opt-in diagnostics
and the capture/audio capabilities of the connected device are not alternate
versions of the product UI.

A remembered App activation permits discovery when choosing a source or
receiving media; it does not make App a prerequisite for sharing. Idle Host
pages hold no App control session. The shared source selector orders Browser,
Camera, Window and Screen, defaulting to Window after App detection. An App that
provides only a system picker gets one combined choice in place of Window and
Screen. Browser and Camera choices require their respective Browser APIs;
temporary restrictions keep a supported choice disabled. Without an App,
the selector defaults to the first supported Browser or Camera choice. Discovery
never blocks Browser selection or overrides an explicitly chosen tab. Refresh remains
reachable after failed App discovery; pending attempts are shared, completed failures
do not suppress later discovery. Cancelling the selector or ending a share
releases its unused control session; an obsolete operation cannot install or
retire another operation's media. Cancellation covers discovery and the opening
handshake, not just a connection returned later. Camera thumbnails own only
temporary preview inputs; leaving their tab or picker retires them. An active shared camera is
borrowed, never reopened or stopped by preview. Optional native ingress uses an already
available connection without another scan. If it is not ready at Browser
startup, that share keeps Browser senders.

Native Host startup acquires its required Browser media connection before
starting capture. Cancellation owns that connection immediately, while native
share ownership and required audio tracks come from the accepted App response.
Browser initialization failure remains distinct from capture permission failure.

A reachable Piik App with an incompatible control protocol is distinct from an
absent App. Discovery continues looking for a compatible process before reporting
the mismatch; the source selector retains Browser operation and offers update/
refresh guidance. Discovery metadata may grow, while known identity and capability
types remain validated. Missing optional capabilities are unavailable; control
commands and responses retain their strict protocol contract.
An empty source list means enumeration succeeded for the selected category.
Connection, capture-capability and enumeration failures keep their own feedback.
Discovery has one bounded deadline that allows time for browser local-network
consent; a failed fetch alone cannot establish that consent was denied.
Optional Viewer reception uses Browser media immediately when the browser
reports that local App access still needs consent or is denied. It rechecks
permission on a later connection attempt; a later grant does not replace healthy
Browser media. App Local needs no cross-address-space consent. Browsers without
a permission query retain bounded discovery.

## Visual Language

Chinese, English, and pure-visual modes are three expressions of the same typed
state and command catalog. On first use, the App and Server UI match the
Browser's primary system language against registered locales, using English
when none matches. Current catalogs cover Simplified Chinese and English.
Both Simplified and Traditional Chinese system locales select the current
Chinese catalog across App, Server UI and website; this includes region and
script tags such as `zh-CN`, `zh-TW`, `zh-HK`, `zh-Hans` and `zh-Hant`.
Pure-visual mode remains an explicit choice. An explicit later choice is
persisted and takes precedence over that default, including App launch handoff.
Explicit launcher choices apply only to the presentation domains the user chose.
Older launchers cannot distinguish defaults from explicit choices; updated Sites
preserve their saved preferences when receiving those unmarked hints.
The App console uses its own supported presentation languages and falls back
to English for additional UI languages. Text modes use concise copy.

The [visual language](./visual-language.md) is the single owner of
illustrative roles and objects, semantic colour, panel grammar, motion,
accessible input and responsive hierarchy.

## Playback Ownership

One `<video>` element owns Viewer playback and frame proof. The shared playback
bar reflects that element and provides local play/pause, mute, volume, theater,
picture-in-picture, fullscreen and the existing reconnect action. It stays reachable while waiting
or disconnected. Theater and fullscreen are separate modes. Page-element
fullscreen includes the playback bar; Safari's video-only fullscreen uses
system controls and native video events to reflect playback and exit.
Identity, connection details and topology stay in the deck.
Room tools outside the fullscreen player close when it enters fullscreen.
Returning a detached tool during fullscreen keeps it closed in the page; leaving
fullscreen allows reopening it with its session and draft intact. The fullscreen
bar retains the danmaku toggle, not an interaction-window entry.

Viewer playback settings reuse shared controls in an anchored popover;
placement follows the [visual language](./visual-language.md) without resizing video. Local picture
fit defaults to contain; cover preserves proportions and may crop edges, while
stretch fills the player by changing proportions. These choices do not change
capture or encoding. Manual quarter-turn rotation is another local picture
preference; it does not depend on device auto-rotation and applies to page
playback, including theater and DOM fullscreen. System video presentations
retain their browser-owned behavior. Remote input and magnification use the same rendered
picture geometry. Incoming-route choice follows the
[routing contract](./routing-transport.md#viewer-route-choice); its selected value
is server-acknowledged intent, not evidence of the currently playing route.

Replacement video bindings do not consult Viewer-local pause: when the Host is
playing, they attempt playback subject to browser autoplay permission. There is
no separate remembered playback intent for source changes or reconnects. A new
binding received while the Host is paused waits for the Host to resume; it does
not inherit the previous binding's Viewer-local pause.
Adding, replacing or removing audio on the same video binding updates only its
audio consumer; it preserves current-frame proof and Viewer-local playback.
A pending `play()` canceled by pause or rebinding is not a media failure;
cancellation alone must not invalidate frame proof or disable local playback.

The bar floats at the picture's lower edge. Separate playback and sound, remote
input, viewing options, and window actions; on-screen chat belongs with viewing
options. Keep PiP, theater and fullscreen together at the trailing edge.
Frequent viewing actions stay directly
reachable; on-screen chat appearance and connection preferences stay in playback
settings, while chat settings own records. Picture fit has one direct cycling control.
Narrow players keep volume, PiP, theater and fullscreen directly available.
Keep one capsule at the lower edge. Shorten the volume slider and hide its
percentage before wrapping: narrow players put playback/sound and remote input
on the first row, with viewing and window actions on the second. Both rows retain
one visibility owner and 44px control height; none becomes a distant toolbar.
Playing video hides the bar
after two idle seconds, following [Media Chrome's default](https://github.com/muxinc/media-chrome/blob/main/docs/src/pages/docs/en/components/media-controller.md#autohide).
Pause or unavailable playback keeps it visible. Control hover, keyboard focus,
dragging and an open tooltip hold it open. Mouse movement reveals it;
a touch tap on the picture toggles only visibility. Remote input owns picture
clicks and movement, so use the bezel pull during control; pointer-locked input
also never reveals the toolbar through mouse movement.
One presentation hook owns visibility for the current player, using one idle
timer; it never changes playback or route state. Controls
follow the shared [motion grammar](./visual-language.md#motion-grammar).

A picture click does not pause playback; the playback button and focused-video
keyboard shortcut own that action. Desktop double-click toggles the available
fullscreen action. Remote-control input consumes its own clicks and key presses;
controls and overlays keep their own immediate behavior.

Host source-audio feedback describes the selected source independently of room
voice. Viewer picture-sound controls require a received audio track and,
when the Host supplies input availability, an available source or microphone
input, including explicitly enabled source commentary. With no input, sound controls are disabled with the no-audio explanation;
the Viewer's volume and mute preferences remain intact for audio returning.
Older Hosts without this fact retain received-track feedback. These controls do
not infer input presence from silence or change capture, transport or relay audio.

Viewer volume starts on native audio output. An explicit setting away from 100% activates
a local Web Audio stream source and gain, from silence to 200% amplitude. This also
avoids iPhone's system-owned `video.volume`. This output
exclusively owns sound while running, follows video pause and user mute, and
rebinds when the audio track changes. It never modifies the received track or
the stream relayed downstream. Unmount closes the graph. Browsers without gain
support retain 0–100%; video-only system fullscreen also hands audio back to the
native controls at at most 100%, rather than running two outputs.

This uses the standard [Web Audio stream-source and gain nodes](https://www.w3.org/TR/webaudio/).
The gain is amplitude scaling, so loud source peaks can clip above 100%.

The Host reuses this bar, but its sound controls own outgoing source volume,
0–200%, initially 100%. Preview sound remains muted. Browser capture applies
gain before its outgoing track; Native capture applies it before the shared
Opus encoder. Source replacement retains volume, a new share resets it, and
room voice is independent. Older Apps without source-volume capability retain
sharing but disable this control with an update hint.

Picture-in-picture uses the browser's native video window, including Safari's
presentation-mode API. Native enter/leave events own its displayed state; closing
the window or replacing the received stream does not create another playback
owner. Successful entry exits this video's other fullscreen mode, and unmount
closes only this video's window. Unavailable capabilities remain disabled with
an explanation. The native window contains video and system controls, not page
overlays or the custom bar. See the [PiP specification](https://w3c.github.io/picture-in-picture/)
and [Safari integration](https://developer.apple.com/documentation/webkitjs/adding_picture_in_picture_to_your_safari_media_controls).

Viewer-local playback actions never change Host capture or another Viewer.
Reconnect retains the existing route-operation owner. The Host preview reuses
the picture controls and starts muted. Local pause, fit, rotation,
theater and fullscreen affect only that preview; the separately labelled sharing
controls own authoritative pause and stop. Its speaker control adjusts the shared
output for Viewers, as defined by [source audio](./media-quality.md#screen-audio);
it does not enable local monitoring. By default, a hidden or unfocused Host page
suspends local preview, except while its video is in Picture-in-Picture. The Host
can disable this in playback settings to keep watching on another monitor;
the choice is remembered at the same Browser origin. Returning to the page or
changing this preference preserves an explicit local pause.

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
do not prove playback or quality. The [status preview](./media-status.md)
records the visual vocabulary and the evidence needed for participant lamps.

Excluding time spent in the Browser's capture/play authorization UI, a Viewer
request targets a first visible frame within three seconds. Until then, the page
must continuously show a truthful accessible connection stage rather than a
black screen, ICE-connected state, or unproved `playing` event.

- A proved current frame remains visible behind non-terminal recovery state.
- The [status projection](./media-status.md#projection-rules) owns the
  television, Header, notices, participant lamps and title. These consumers
  cannot turn an unproved frame into playback or ordinary quality into failure.
- The Host's couch and Viewer overview share the
  [participant projection](./media-status.md#projection-rules). The
  Host's own pawn has no additional lamp. Committed `mediaReady` owns picture readiness;
  transport diagnostics and quality samples cannot override it in either direction.
  Room presence and a committed voice route remain valid without a picture.
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

Decoded-frame silence is not a route-failure signal. A live source can stop
repainting; media-framework failures, not an application silence timer, own
recovery. First-frame admission and candidate-relative proof still require
decoded progress. Visibility, page freeze, and pagehide invalidate quality
observations, not already-proved playback.
Returning to the page re-arms frame observation; an existing
recovery state still requires a fresh current frame to clear. SFU media is
retained independently of transient room-signaling loss, but Browser or OS
suspension and page reclamation remain outside Web guarantees.

The local Native media bridge owns bounded ICE recovery on its existing
connection and stream. Its offer identity fences each answer; retirement cancels
pending negotiation and cannot recreate a source or receiver. Connection recovery
does not assert fresh media, and an intentionally paused source is not a failure.
First-frame and playback owners retain their existing evidence requirements.

Terminal failure of the local Native media bridge disables Native reception for the
current Viewer session before route recovery runs. Future peers in that session
use Browser reception; existing healthy peers are not torn down by this choice.
Parent-network failure alone is not evidence that the local Native capability
is unavailable.

The Native Host's local bridge remains required by its Browser share owner:
the stream supplies preview and Browser quality candidates and participates in
source and quality changes. A terminal failure retires that share through the
existing Host lifecycle; it is not merely a missing preview. An individual
downstream network failure instead recovers that edge and does not retire the
bridge or capture. Browser capture's optional Native fanout can fall back to
Browser senders because the Browser still owns its source.

## Presence And Diagnostics

Host and Viewer pages show the authoritative online Viewer count and roster,
independent of the media graph. A display name is Browser-local, NFC-normalized,
at most 24 Unicode code points, and rejects unsafe control or bidirectional
characters. It is a label, not an account, authorization identity, or routing
input. Duplicate names are allowed and receive a room-scoped peer suffix only
when disambiguation is needed.
Chat applies the same labeling rule to recorded sender names; repeated messages
from one peer do not create another identity. Media readiness never owns identity.

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
report through the separate [diagnostic owner](./configuration.md#diagnostics);
ordinary connection details do not collect or expose that report.

Current scope includes Web Host, Web Viewer, Browser relay, and optional Native
Host/Viewer media beneath those same pages. Desktop and mobile Browsers are
Viewer targets; mobile screen capture, reliable background relay, App-owned SFU,
and physical non-Windows native acceptance remain later platform work.

## Primary References

- [WHATWG Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html)
- [ECMAScript string normalization](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.normalize)
- [Unicode UAX #31](https://www.unicode.org/reports/tr31/)
