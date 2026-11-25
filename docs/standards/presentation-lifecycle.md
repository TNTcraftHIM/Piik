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
available to its approved Sites before either mode starts. Browser pages share
one App entry across platforms; discovery and authorized health determine its
connection state. Android adds an explicit wake action. Browser and camera
actions retain their own capability checks.
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
An App-launched tab selects that process's control endpoint and retains the
selection through reloads in its Browser session. If that endpoint becomes
unavailable, discovery stays with it; a new explicit launch selects another App.
Endpoint selection does not grant Site access or capture permission.
Activating a page supplies
native capability without restarting its room or healthy media session.
The shared App entry stays in the header while selecting a source; a successful
connection refreshes the open selector's list. An already approved exact
origin needs no repeat confirmation, but the page still verifies authorized App
health. Closing the selector does not cancel the separate site approval. Existing
Browser shares stay unchanged when App connects; explicit source replacement
uses the current share's source transaction.
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
The Android App uses that same system-browser workflow. Recording consent and
foreground services remain platform-owned. Its startup page and site management
reuse the shared launcher. Waking App or navigating to a site
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
disabled controls explain their reason in localized guidance. Real
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
absent App. Without an explicitly selected endpoint, discovery continues looking
for a compatible process before reporting the mismatch. The source selector
retains Browser operation and offers update/refresh guidance. Discovery metadata
may grow, while known identity and capability
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

[Naming and copy](./naming.md#interface-languages) owns the 3.0 interface
languages and their selection.

## Playback Ownership

[Media status](./media-status.md#playback-ownership) owns 3.0 playback, and
[screen audio](./media-quality.md#screen-audio) owns local listening gain.

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
Viewer targets. Android screen capture is implemented in the system-browser App
candidate; public delivery awaits its platform acceptance. Reliable background
relay, App-owned SFU and physical non-Windows native acceptance remain later work.

## Primary References

- [WHATWG Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html)
- [ECMAScript string normalization](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.normalize)
- [Unicode UAX #31](https://www.unicode.org/reports/tr31/)
