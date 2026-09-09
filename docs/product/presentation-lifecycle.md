# Presentation And Lifecycle

This file owns user-visible workflow, presentation authority, presence, and
Browser lifecycle promises. Component structure, CSS, exact copy, and routine UI
tests belong in source code.

## Product Surface

The first screen is the working tool, not a marketing page. Once site access is
available, starting a share and joining a room are equally discoverable actions;
joining expands the four-digit room form in place, while `/join` remains a direct
entry route. Users never choose a media topology.

The Host workspace centers the capture preview, room code, invitation and common
share controls. The Viewer workspace centers one persistent 16:9 video stage,
room identity, current state, roster, and one manual media-reconnect action.
Controls and text must remain usable without overlap or horizontal overflow on
desktop and mobile viewports.

Screener Client opens this same application in the system Browser. Its small
startup surface selects Local, temporary public invitation, or a configured
Site before entering the Host workspace. Viewer links opened at that activated
origin may use the same running Client without changing the Viewer UI. Starting a share offers the
Browser picker and any exact Client-owned native windows. It never chooses a
window automatically. A reproduced Browser-window, capture, or background
failure is required before introducing an embedded Web runtime.

A remembered Client activation permits discovery when choosing a source or
receiving media; it does not make Client a prerequisite for sharing. Idle Host
pages hold no Client control session. Ordinary Web entry opens the Browser picker
directly. Activated origins offer the shared source selector, initially on its
Browser tab unless Client is already connected. Discovery never blocks Browser
selection or changes the chosen tab. Native tabs and refresh remain reachable
after absence or disconnection; pending attempts are shared, completed failures
do not suppress later discovery. Cancelling the selector or ending a share
releases its unused control session; an obsolete operation cannot install or
retire another operation's media. Optional native ingress uses an already
available connection without another scan. If it is not ready at Browser
startup, that share keeps Browser senders.

## Visual Language

The interface presents one small shared living room rather than an operations
dashboard. The television is the media stage, the couch and pawns make presence
spatial, the shelf separates watching from controls, and the room display keeps
the four-digit code prominent. This metaphor must clarify the same product
state on Host and Viewer pages; decoration never creates a second state model.

Chinese, English, and pure-visual modes are three expressions of the same typed
state and command catalog. A fresh Browser starts in visual mode and persists
an explicit later choice. Text modes use concise copy. Visual mode uses one
consistent stroke language for single concepts, small panel comics for causes
and sequences, and literal scene objects for people, rooms, and media. Glyphs do
not form sentences. Universal digits, transport symbols, URLs, and measured
values remain literal when users need the data.

Control hints and state comics use the same television for shared or watched
media. Browser chrome identifies the application UI; a window title bar or a
display stand identifies the capture target. A server in a media path means
actual SFU relay, not merely opening a configured Site.

Motion explains entry, transition, progress, and control feedback. Operational
status stays still; ambient motion is limited to the Client brand mark's
occasional idle wink.
All meaning remains available with reduced motion. Functional
controls remain native buttons or inputs with localized accessible names, and
hover, keyboard focus, and touch receive equivalent guidance.

The visual hierarchy, interaction ownership, and information order remain the
same across themes and viewport sizes. Responsive layout may reflow or scroll a
bounded visualization, but it must not hide a primary action, truncate an
essential value, overlap controls, or change product semantics.

## Playback Ownership

One native `<video>` element owns Viewer play/pause, volume, mute, and fullscreen.
Those actions are local and never change Host capture, room state, routing, or
other Viewers. The Host preview has no media controls; explicit Host actions own
authoritative share pause and stop.

Autoplay rejection exposes the native play action. A connection, track object,
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
badge, status line, or overlay while committed media remains proved. Those
surfaces share the presentation reducer; raw transport snapshots provide route
labels, reconnect authority, and diagnostics only.

Excluding time spent in the Browser's capture/play authorization UI, a Viewer
request targets a first visible frame within three seconds. Until then, the page
must continuously show a truthful accessible connection stage rather than a
black screen, ICE-connected state, or unproved `playing` event.

- A proved current frame remains visible behind non-terminal recovery state.
- Host roster connection state follows the server's committed physical media
  path. A pending candidate or temporarily stale quality sample may annotate
  optimization, but cannot downgrade an active Viewer to routing.
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
authority. Returning to the page rebaselines time and proves a current frame
again before clearing recovery. SFU media is retained independently of transient
room-signaling loss, but Browser or OS suspension and page reclamation remain
outside Web guarantees.

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
Locally exposed selected-candidate addresses may be shown only on the Browser
that owns that PeerConnection and are never uploaded, persisted, or used for
identity or route selection. Explicit Debug mode can export a bounded diagnostic
report through the separate [diagnostic owner](../reference/configuration.md#diagnostics);
ordinary connection details do not collect or expose that report.

Current scope includes Web Host, Web Viewer, Browser relay, and optional Native
Host/Viewer media beneath those same pages. Desktop and mobile Browsers are
Viewer targets; mobile Web capture, reliable background relay, Client-owned SFU,
and physical non-Windows native acceptance remain later platform work.

## Primary References

- [WHATWG Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html)
- [ECMAScript string normalization](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.normalize)
- [Unicode UAX #31](https://www.unicode.org/reports/tr31/)
