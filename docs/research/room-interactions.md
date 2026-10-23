# Room Interaction Design

The owner accepted the text/reaction UI and model with bounded local acceptance.
[Status](../status.md#accepted-interaction-phase) owns release readiness and
[TODO](../todo.md#now) owns remaining work.
This document records the implementation design and its tradeoffs;
[rooms and access](../standards/rooms-access.md#room-interactions) owns authority
and retention, while [presentation and lifecycle](../standards/presentation-lifecycle.md#product-surface)
owns room/publication lifetime.

## Model And Owners

| Concern | Owner | Lifetime |
| --- | --- | --- |
| Identity, room membership and access | Existing room store and authenticated signaling session | Current admitted participant |
| Screen/camera and source sound | Existing capture and media owners | Current share and source |
| Room microphone and listening | `RoomVoiceSession`, Browser input and room-route adapters | Explicit voice membership, independent of picture sharing |
| Text and reactions | `signal/interactions.go`, shared protocol and `RoomInteractionSession` | Current authenticated room session; bounded page-local presentation |
| Chat panel, optional chat overlay and reaction placement | Shared `RoomInteractions` and `RoomChatOverlay`; `RoomInteractionSession` owns bounded events | Current room UI |

The existing room authority admits interactions through the same authenticated
WebSocket; there is no second admission or identity system.

Messages do not need a media route, decoded frame, or SFU. They do not mutate the
media graph, add a port, create an extra connection, or restart capture. Pause,
source replacement and media recovery keep the current conversation. A capable
Host explicitly opts into a persistent room session.
Restoring an existing room connects that session without requesting capture or
starting media. The capture-ready owner requests publication; merely entering a
capture picker or awaiting permission cannot publish. Stopping the publication
retires only its media generation, while the authenticated Host and its
interaction session remain available. A later `start-sharing` claims a
fresh generation on that same signaling connection. Room close, access loss,
session replacement and page teardown still retire the whole session. A Host
without the capability keeps the existing stop-and-leave behavior.

Room restoration and authority recovery share one awaited owner; connection reuse
checks the actual room/token binding. Publication acknowledgment precedes media
effects. A rejected start names its attempted generation, retires only that local
attempt and keeps room interactions available; it cannot stop another generation.
Opening the Host page alone still does not create an unused room.

The server treats the current Host session's non-empty generation, matched to the
room's reconnect fence, as the only publishing truth. Room membership and Host
presence are separate, so a late Viewer in an idle room receives no media route
even when the Host remains available for room interactions.
Connected Viewers can continue interacting when the Host disconnects, while the
room server and their admitted sessions remain available. A departed participant
cannot receive a targeted reaction. Closing an App that also runs the room server
ends that service; merely leaving the Host page does not.

## Delivery, Compatibility And Bounds

- `/api/capabilities` advertises optional `roomInteractions` and
  `hostRoomSession`; absence means the corresponding behavior is unavailable.
  The page explicitly subscribes after authentication. Only subscribed current
  sessions receive interaction events. The Host room-session behavior also
  requires the `roomSession: true` authentication opt-in; sessions without it
  retain the stop-and-leave contract. The [public compatibility boundary](../standards/versioning.md#public-compatibility-promise)
  still applies; publication start/result messages go only to an opted-in session.
- The viewer discovers this optional capability independently of first-picture
  startup. Late capability discovery enables data on the existing connection.
- A strict command payload union admits plain chat text or a registered reaction. Chat is
  at most 280 Unicode code points, normalized to NFC, without control/bidi
  characters. It renders as text, with no markup, links, attachments or commands.
- Received reaction names are bounded lowercase ASCII identifiers, not arbitrary
  HTML, assets or commands. The page ignores an unsupported effect after protocol
  validation; malformed events still fail validation. This follows the command/
  response distinction in [Azure's extensible-enum guidance](https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md#enums--sdks-client-libraries),
  checked on 2026-10-07. Existing strict pages still reject new names, so this
  reader change alone does not authorize sending new reactions to those pages.
- The server accepts at most one interaction per 800 ms per connection. It
  validates identity, subscription and target before fan-out. A slow recipient's
  data is skipped at 16 KiB queued output, reserving the existing bounded queue
  for signaling. The browser also declines sends under output backpressure.
- The sender waits for its server echo, not a guessed success or a read receipt.
  A rejection or a 5-second confirmation timeout preserves the draft. There is
  no offline outbox or automatic retry; manually retrying an unconfirmed send
  may duplicate a message that arrived before the confirmation was lost. Only
  the matching pending request may confirm a send or clear its draft/error;
  late echoes may enter history without confirming a newer attempt.
- The page retains the latest 1,000 received chat messages and at most eight
  simultaneous reaction effects. Effects expire after 2.4 seconds. Reconnection
  clears pending effects and re-subscribes, without replaying messages or actions.
  Same-room re-admission retains history, self attribution and the local draft,
  even when its wire peer ID changes. Refresh, leaving, authority loss or room
  session replacement clears the page conversation; late joiners receive only
  new messages. Nothing persists in Browser storage. An explicit TXT export saves
  the currently retained messages with timestamps and display names; it does not
  include pending sends, reactions, invite credentials or peer identifiers.
- There is no server history, database table or message body in diagnostic
  exports. Transport is the site's HTTPS/WSS connection; **chat is not end-to-end
  encrypted**, and the server operator can access live message contents.

## Interaction Design

Chat and reactions use an interaction window in the shared `FloatingPanel` shell. The shell
owns native visibility, placement, movement, resizing and focus return; the
conversation retains its session, draft, reading position and unread state.
It opens initially at the lower right, without
resizing the picture or moving the couch. Drag its title bar or use arrow keys on
the focused bar. Resize from either diagonal corner or use arrow keys on a resize
handle. These direct controls also work with touch; there is no separate placement menu.
Resizing holds the opposite corner steady. Size and position belong to this room
UI only; viewport and keyboard changes bound them without erasing preferences.
The native manual
popover keeps the conversation visible while operating the picture or reactions.
Close, the entry toggle, or Escape hides it; this preserves the room conversation. Inner
menus consume Escape first, then the most recently opened utility window, then
theater mode. Input-method
composition is not a dismissal request. Opening focuses the panel without opening
the keyboard; explicit close returns focus to the entry. Nested disclosures
cannot change panel visibility.
The visual viewport bounds it above an onscreen keyboard.
Hidden messages are not marked read. A bounded scrolling log keeps arrivals from
growing the panel. Consecutive messages from the same sender share visual identity;
each message retains its accessible author. Hiding and reopening preserves the
reader's position; a latest-message action resumes following. Sending waits for
confirmation without locking draft editing or introducing a message queue.
The conversation entry shares the couch footer with its participant count,
separate from the Host's sharing controls. Theater hides the seating and count,
retaining the same compact conversation entry and focus target.
Selecting a person on the couch opens the reaction palette in the shared floating
shell, initially beside the selected person (below when space permits). Each
opening anchors there before allowing free movement. Its portrait and name identify the
target even after moving the window. Selecting a different participant keeps its
placement and any manually chosen size; selecting the same person toggles it.
The default palette height follows its content, bounded by the visible viewport.
One's own palette expresses a reaction above oneself and holds the local effects switch; other
people's palettes offer targeted expressions and two throwing props. The props form
a compact pair of named action buttons beneath the expression grid, using the
shared button motion.
Connection details remain secondary when that participant has inspectable data.
Close or Escape dismisses the palette; it also closes if its participant leaves.
Sending keeps it open for repeated interaction, with the existing short cooldown.
Confirmation never changes menu visibility; failure stays visible in the card.
Opening or closing a reaction card preserves the chat draft and unread state.
The interaction window uses a compact attached palette beside the chosen chat
or voice avatar, without replacing or compressing the list and composer. Its
quick actions are thumbs up/down and the two throwing props; one's own entry
substitutes laugh and heart. More reactions exposes the full curated palette,
with a labelled back arrow in its heading. The native
popover and shared anchored placement own dismissal, focus and viewport fit.
Clicking the input dismisses it and continues typing; sending keeps it open.
Changing pages or moving the tool between documents dismisses this brief menu
without changing the session, draft or reading position. Avatars of departed
participants remain non-interactive. Both menus use the same target heading,
reaction buttons and send owner.
The newest live reaction briefly shows its sender and recipient
with the same animation renderer.
It adds neither a message history entry nor an independent expiry timer. Member
controls and reactions open on demand within the small companion window. Only
unobscured chat following the latest messages consumes
unread messages. The detached window uses the same room session, event expiry and
sending controls as the couch shortcut.
Self expressions follow the sender's head, including idle and interaction motion.
Only that sender's newest self expression replaces their earlier one. A targeted
emoji is a delivery: it travels from sender to recipient, retains a compact
source label above the centered glyph, and settles separately above the
recipient's own expression. Late mounts and reduced motion retain that attribution without
replaying elapsed motion. A gift never replaces the recipient's self expression;
all delivered events remain in the accessible log.
Tomato/poop throws require choosing a current participant, land with a small
character response and settle above the head, keeping the face visible. A tomato
squashes with a few droplets; poop wobbles with a small puff. Other expressions
use short gestures and sparse accents. All decorative descendants share the
event's remaining phase and expiry; event ID and sender identity seed their
variation. No particles, stains or animation timers outlive the event.
A departed participant is never silently replaced as target.
Everyone sees the same server-issued event; placement follows the people in each
visible surface. Each roster owns its local coordinates and uses the same renderer.
Effects never become a video overlay or a media status. Impact transforms leave the
UUID-owned idle animation, names and status indicators alone. Hiding effects or
retiring the event cancels its own animation; showing a still-live event uses its
remaining lifetime. Animation scheduling and visibility follow the document
displaying the surface, so a hidden main page does not freeze its detached window.
Users can hide effects; reduced motion uses a static stamp.
Theater mode hides the couch and retains a chat entry, using the same floating
panel and draft without changing the picture's size. HTML player fullscreen
keeps the existing danmaku control; it does not include the conversation panel.
Unread messages advance only while the log is onscreen, the document is visible
and the reader is following its latest messages. A hidden or scrolled-back log
does not consume arrivals. These are local unread indicators, not read receipts.

The optional chat overlay (danmaku) projects newly received chat over the picture;
it adds no message kind, transport or delivery promise. It defaults off, with the
same local switch beside the chat composer and Viewer playback bar, including HTML
fullscreen. At most three single-line comments appear for up to six seconds each.
Font size follows the picture width. Chat settings can scale it to 80–130% and
set opacity to 40–100%; defaults are 100%. These local preferences belong to the
room interaction session, survive its signaling reconnection and reset when that
session is replaced or the page reloads. Both Host and Viewer use the same owner.
Adjustments preserve active flights and their shared timing; duration stays fixed.
The settings view occupies the chat window's existing space and preserves its
draft and scroll position. Hidden chat is not marked read while adjusting settings.
Each event's sender and ID choose its lane, and a newer event replaces that lane's
previous flight. All received text remains in the full chat log, without a playback queue. Text is clipped
to the picture space above playback controls; smaller spaces show fewer complete
lanes without restarting their timelines. It does not intercept playback gestures. Showing the overlay
does not mark the chat log as read. Hidden documents, unavailable pictures,
source changes and disconnection clear flights; showing or reconnecting never
replays earlier comments. Reduced motion uses temporary stationary text. Native
video-only fullscreen and picture in picture cannot include HTML overlays.

Server confirmation means acceptance, not an acknowledgment from every recipient.
Delivered chat follows server order; congestion can leave gaps without reordering
the received subset. The same event retains its lane and time basis even when
preceding events are missed. Visibility, local switches and missing messages may
change which effects are shown; geometry and font size follow the local viewport.

Reaction animations are decorative. The same bounded events also provide
localized sender/action/target descriptions in a polite accessible log, including
when visual effects are hidden. Reduced motion removes decorative movement from
both the flight and the picker controls.

Chinese, English and visual modes share the component and behavior. Visual mode
retains user-entered text and participant names, with icon controls and localized
accessible names. Host identity reuses the existing crown; neither chat colour nor
reaction motion claims media connectivity, capture permission or delivery status.

## Presentation Synchronization

The server stamps acceptance time once and broadcasts the same event in its
existing serialized order. A subscription response provides server time; the
room session estimates its offset from the local round-trip midpoint and keeps
that estimate until reconnection. Effect expiry and both renderers share that
session's clock. Late effects start at their remaining phase; expired chat still
enters the log and confirms a matching send, without replaying an effect.
Returning from reduced motion also respects the original expiry.

This is approximate alignment, limited by subscription round-trip asymmetry,
queueing and clock drift; it does not promise frame-exact synchronization. There
is no continuous clock exchange, sorting by timestamp, or animation-frame stream.
Changing a device's clock mid-connection can disturb effect timing until the
next subscription; message order and delivery do not depend on that clock.
Participant motion and event lanes reuse the same identity hash, with an event's
ID and actor identity determining its lane independently of prior arrivals.
A shared mutable random-number stream would drift whenever a client misses or
hides an event. Responsive layout remains local.
This follows the same-input principle described in
[Deterministic Lockstep](https://gafferongames.com/post/deterministic_lockstep/),
without introducing lockstep waiting or frame-by-frame simulation.

## History Direction (Not Yet Implemented)

History ownership remains undecided. A Host cache can also miss live messages and
is unavailable while the Host is absent; treating its copy as server-confirmed
history would change message authority. Compare that cost with a bounded room-server
memory buffer before adding replay. Either design needs explicit access and
retention boundaries. Recovered text would enter the log, never replay old
danmaku or reaction effects. Current behavior remains the no-history contract above.

## Audio Boundary

The published Host microphone remains commentary mixed into the shared source.
Text, reactions and danmaku introduce no microphone capture or additional media
peers. Room voice is an isolated prototype, not a published capability.

### Room Voice Transport Assessment

Integration update, 2026-10-20: the normal App/Server/Web candidate now uses one
room controller for voice and picture, with companion Browser audio connections
on its selected edges and an embedded Opus SFU adapter on the existing UDP mux.
The earlier experiments below remain design evidence, not the distributable
implementation. Room voice now opens when the Host joins and closes when the
Host leaves. Room admission replaces per-person voice permissions. All current
microphone controls use room voice; pausing local listening leaves the microphone
on. Source sound stays with the picture. This follows the independent media
source model in [LiveKit](https://docs.livekit.io/intro/basics/rooms-participants-tracks/)
and the [RTP synchronization boundary](https://www.rfc-editor.org/rfc/rfc8834.html#section-12.2.3):
sharing a route does not guarantee synchronized playback across independent
voice and picture connections. Conversation prioritizes timely delivery.
Normal UI checks exercise pre-share room creation, channel activation,
duplex capture, a three-participant Peer relay, local mute without interrupting
forwarding, picture start/stop/restart, detach and authority retirement on P2P
and forced-SFU arms. The existing network laboratory also exercises voice across
Browser/App endpoint combinations, blocked direct paths and UDP interruption.
These synthetic-device checks do not establish microphone echo behavior, public
NAT success rates or 21-person all-speaking audio capacity.
`PIIK_ROOM_VOICE_LEGACY_WEB` optionally points the same normal-page gate at an
older checkout and records its revision, checking that an older Viewer retains
picture playback without subscribing to voice events.
Product owners are [room voice](../standards/rooms-access.md#room-voice) and
[room media](../standards/routing-transport.md#room-media); the public release
does not yet include this candidate.

Reviewed 2026-10-19. The owner requested optional self-hosted voice and assessment
of App-hosted voice. The local prototype forwards independent Opus publications,
uses existing room identities, and enforces Host admission and speaking grants.
It demonstrates decoded voice before, during and after synthetic screen sharing;
production integration and external-network reachability remain unverified.

The proposed ownership is one room and membership authority, independent screen
and voice publications. Starting or stopping a share must not create or destroy
voice membership. The separate-forwarder prototype retires a disconnected voice
session while approved Viewers can continue talking; explicitly ending the room
retires all voice sessions. The room-tree experiment below retains healthy media
during a signaling interruption and separates that from confirmed departure.
Host-only video and participant-owned voice can
coexist without turning every speaker into a screen publisher.

| Transport | Benefit | Boundary |
| --- | --- | --- |
| Self-hosted SFU | Each participant connects to one configured service; independent tracks allow local mute | The service's media endpoint must be reachable; an HTTP connection alone is insufficient |
| Host App as voice forwarder | The same forwarding module could run locally without a mandatory public media server | Every participant must reach the Host App; existing relayed video does not prove this |
| Participant mesh | No forwarding process | Pairwise reachability and upload fan-out grow with the room; partial audibility is possible |
| Room-owned bidirectional tree (candidate) | Reuses reachable neighbors and distributes forwarding upload | Requires room-owned connections, independent voice publications and explicit relay/listening permission; it is not an input-channel extension |

For example, `Host <-> A <-> B` may carry video and remote input while `Host <-> B`
cannot connect. A Host-App voice star would leave B without voice. Before sharing,
there may be no video tree at all. The current `HostPeer` sends one video and one
source-audio track; `ViewerRelay` uses that same sender. The reverse input channel
carries bounded encrypted commands, not audio playout, jitter buffering or media
feedback. Sending audio bytes there would introduce another audio transport stack.

[RTP topology guidance](https://www.rfc-editor.org/rfc/rfc7667.html#section-3.7)
describes forwarding independent streams without mixing them. This preserves
per-person mute and avoids returning a speaker's own track. A single mixed
broadcast would lose that control unless each listener received a separate mix.
For scale, a four-person App hub forwarding three 32 kbps voice tracks to each
of three guests sends 288 kbps; 21 participants require 12.8 Mbps in the same
all-speaking case. These are payload calculations, not measured performance;
packet overhead and shared-screen upload are additional.

The owner proposed lifting the existing route and connection lifetime to the
room on 2026-10-19. This is a candidate design, not a published contract: keep
one graph and one serial operation owner, with video and voice as separate
consumers. WebRTC already supports bidirectional tracks over shared transports
([WebRTC transceivers](https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver),
[BUNDLE](https://www.rfc-editor.org/rfc/rfc8843.html)). The graph can retain its
rooted, acyclic orientation for placement while voice travels both ways over an
edge. Host authority and the single screen source remain unchanged.

Under that design, admitted voice or screen-sharing demand can acquire room
connections. Stopping video retires its tracks and quality work, not connections
still serving voice or another participant. Microphone mute does not leave the
voice session. Once no media consumer or transit demand remains, physical
connections retire while room chat can continue. Connection epochs are distinct
from individual publication generations. Route changes retain one prepare/commit
operation; video still needs decoded-frame proof, while silent voice cannot
depend on a video frame or audible microphone samples. Current share-wide pause,
first-frame admission and `HostPeer`/`ViewerRelay` stream ownership are the
concrete extraction points, rather than reasons to reject transport reuse.

Independent voice tracks retain speaker identity and local mute. Forwarding on
the committed tree excludes the ingress branch; it need not send every packet
to the Host and back. Candidate overlap must not create duplicate forwarding or
let a retired publication survive. A video relay without listening permission
must not receive decodable voice: relay eligibility or end-to-end encryption
still needs a deliberate choice. Multi-track congestion and mixed-capability
production paths remain to be exercised. No generic transport framework, second route
planner or automatic root migration is implied by this candidate.

The isolated `prototypes/room-media` experiment on `spike/room-voice` reuses the
production route controller without modifying it. Actual room admission and
loopback Pion connections carry two independent Opus publications in both
directions, followed by VP8 video on the same PeerConnections. Video pause,
stop and replacement preserve voice; an actual edge interruption lets the same
controller select an available alternate relay. Publication identity survives
that change, while a replacement source gets a fresh identity. Stopping video
during candidate preparation also re-evaluates readiness for remaining voice
demand, rather than waiting for another connection event. Room retirement closes
the actual connections as well as clearing their plan.
After signaling loss and physical connection failure coincide, reauthentication
reconciles the transport's existing failure fact with the controller's current
session guard. This repairs an experiment caller omission; production Viewer
reconciliation already has the corresponding behavior. No second retry owner
or timer is needed.

This experiment excludes nodes without listening permission from voice paths,
including an unjoined Host. It reports the affected listeners unavailable,
preserves video, and restores voice on the same connections after approval.
The Browser follow-up uses independently decoded 330/660 Hz voice, VP8 video and
separate 880 Hz source audio on the same connections, with either a Browser or
an independent Pion process as the intermediate participant. Local mute,
listening revocation/reapproval and relay departure during video preserve the
publication boundaries; the existing controller commits replacement routes only
after that candidate's decoded-frame evidence. Stopping sharing retires video
and source audio while voice continues. Receive bindings include connection and
publication identity so a candidate cannot replace committed transit media.
The Pion worker receives only authorized plans and SDP through private inherited
pipes; it holds neither room credentials nor another route controller.

The existing downstream-copy cap remains a connection bound, not a guarantee
of balanced multi-track bandwidth. These synthetic loopback results establish
Browser/Pion decoding and forwarding, not production App control integration,
public-network reachability, physical echo cancellation or 21-person capacity.
Production decoded-frame admission remains unchanged.

The current separate-forwarder experiment remains a useful control. It
uses the same Opus forwarder in a separate local process. Private inherited pipes
carry already-authenticated commands; the room service remains the identity
authority. This establishes a replaceable media owner, not an implemented public
App-to-Site control path or a new accepted product route. The controlled trial
keeps `Host -> A -> B` video decoding while B's direct voice ICE is denied;
lifting that denial and explicitly rejoining restores voice. A connected video
route therefore cannot be displayed as proof of an available voice endpoint.

Voice integration also needs one Host microphone publication, rather than both
commentary and room voice carrying the same capture. System-audio capture can
recapture received voices even with headphones; reuse supported audio exclusion
and validate simultaneous capture/playback before making an echo-free claim.
In the synthetic sharing trial, moving the Host microphone out of commentary
removed its frequency from source audio. Deliberately feeding received voice
into loopback put it back into that source; excluding that input removed it.
These are routing observations, not physical-device echo-cancellation acceptance.

## Detached Interaction Window

[Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)
places the current interaction panel in an always-on-top window without installing a
PWA or implementing an App window. Piik uses one stable React portal:
the same session, DOM, draft, reading position and controls remain in use.
Visibility, focus, tooltip placement and dismissal follow the displaying document.
Theme and language follow the opener. The browser owns window movement and sizing;
closing the window returns the panel to the page. Room retirement disposes it,
including a window request that completes after retirement.

The [specification](https://wicg.github.io/document-picture-in-picture/) requires
a secure context and user activation; closing or navigating the opener closes
the PiP window. It supports chat and reactions beside a windowed or borderless game;
placement above exclusive fullscreen is not guaranteed. Transparent desktop
backgrounds and mouse passthrough remain an
[upstream request](https://github.com/WICG/document-picture-in-picture/issues/99),
so CSS opacity is not offered as a misleading game-transparency control.
[Browser support](https://developer.mozilla.org/en-US/docs/Web/API/DocumentPictureInPicture#browser_compatibility)
is incomplete, so unsupported pages retain the in-page panel. Video PiP and chat
PiP may replace each other under the browser's single-window policy; no media
or room owner changes. This needs no new room protocol or major version.

## Multiple Sharers Assessment (Not Implemented)

The requested party mode lets several participants share their own screens while
each Viewer chooses one picture to watch. Publishing and watching would be
independent, with room administration separate from publication ownership.
The existing one-Host workflow would remain the default.

This is a model change: the current route controller owns one Host and one
publication. Each new publication would need its own source generation and
subscription lifecycle, while endpoint upload limits remain shared across all
publications. Creating a controller per source must not multiply that endpoint's
outbound allowance. Switching pictures should replace the selected subscription,
preserving room membership and chat. One selected picture is the initial scope;
camera conferencing and room voice are separate features. No implementation or
protocol change is accepted by this assessment.

## Attended Remote-Control Prototype

Reviewed 2026-10-19. Remote control is included in the accepted release scope.
Desktop and mobile Browsers are controllers; Windows App
input has local physical evidence, while macOS/Linux backends remain under platform acceptance;
controlling Android/iOS themselves is a separate platform problem. The
[Captured Surface Control draft](https://w3c.github.io/mediacapture-surface-control/)
only provides limited wheel/zoom operations, not general OS keyboard/mouse input.
Desktop input needs platform-specific authority:
[Windows SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
is subject to process-integrity restrictions,
[macOS accessibility access](https://support.apple.com/guide/mac-help/mh43185/mac)
needs a separate grant, and Linux needs desktop-specific integration such as the
[RemoteDesktop Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html).
Mobile controllers also need touch and text-input behavior, not just mouse-event reuse.

The native input backend is included by the existing platform build constraints;
App checks and packaging use the same implementation without an experimental
feature tag. App discovery advertises the optional input capability;
a supporting page opts in when starting its native share. An older page emits
no opt-in, so it receives neither new input events nor input channels. The
prototype shares a display or window with one desktop or mobile Browser controller.
Ordered WebRTC data channels carry small input messages back along the existing
committed media route: direct, Browser relay, App relay or embedded SFU. The
same Go forwarding module serves App playback/relay and SFU; the Browser adapter
follows its active media input and child edges. No new listener, PeerConnection,
route planner or dependency is introduced. The control button appears only
after the Host enables remote control and the complete input path reports readiness. Updated forwarding peers are
required along that path; an older peer can still carry the picture.
Independent virtual gamepads are deferred by the owner; this phase adds no
input driver.

The logical owners are App coordination/authority, native capture/encoding, and
native input. These are module boundaries, not three required executables.
`internal/app/remoteinput` owns permission, grants and release; its platform
adapter only resolves the target and executes input. Windows uses `SendInput`;
macOS uses public Quartz events and requests Accessibility permission only when
the Host enables control. macOS window input also verifies the process incarnation
and actual focused AX window, rather than treating stacking order as focus.

Linux uses the existing capture helper's RemoteDesktop Portal session for both
the selected monitor and input permission. Ordinary sharing still requests only
ScreenCast. Enabling control opens the system's combined screen/input selector;
cancelling leaves the previous share intact. Support requires keyboard/pointer
capabilities and libportal's restore-capable API; missing support leaves ordinary
capture available. The inherited capture pipe carries input, with no new listener
or privileged device access. Replacing that Portal session, including a quality
change, revokes its input grant and resets policy before binding the replacement.
This first Linux backend supports a monitor, not window-scoped input.
Linux compilation, synthetic Portal input/release checks and shared Go lifecycle
tests pass in an isolated VM. Apple SDK builds and package checks pass on both
Intel and Apple silicon CI. A real Linux desktop/compositor and physical macOS
permission/Retina/focus checks remain unverified.

Opted-in room signaling binds an ephemeral key and endpoint ID to each
authenticated Viewer, then sends that binding only to the owning Host. The
Host passes the snapshot through its existing authorized native session.
Viewer and native Host use platform AES-GCM to protect input and grant replies;
intermediate Viewers and the SFU forward ciphertext, not keyboard events or
authority. The Site remains trusted because it distributes those keys.
Keys are scoped to the authenticated connection, excluded from diagnostics and
never persisted. Direction, sequence and input-channel incarnation bind packets
to their current owner; a delayed closure from a replaced branch cannot revoke
a newly approved channel. The Browser requires Web Crypto in a secure context
(HTTPS or localhost); ordinary HTTP viewing remains available without remote input.
This uses [WebRTC data channels](https://www.rfc-editor.org/rfc/rfc8831.html)
and the platform [AES-GCM API](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams).

`internal/app/remoteinput` owns one process-wide source because the App's native
sessions share the same physical keyboard and pointer. The co-play candidate
adds concurrent capability-negotiated grants under that same owner and existing
Host authorization, retaining exclusivity for older published clients,
as defined by the [input contract](../standards/rooms-access.md#remote-control).
Remote control starts
off. The Browser remembers the last successfully applied authorization mode;
the Host must still enable it manually for each new shared source. Ask each time
is the default. Remembered Room Viewers mode opens the existing permission form
and needs an explicit allow action before becoming active for the new audience.
A remembered password mode asks for a new password before applying; the password
itself is never remembered. Automatic modes accept only
authenticated room Viewers and never displace an active controller. Permission
belongs to the current shared source; changing sources or stopping turns it off.
Turning it off also clears pending requests and releases held input, including
while sharing is paused or another capture operation is pending. One input-owner
intent covers dispatch, OS permission and capture preparation. Off, pause and
source retirement invalidate it before a late result can enable control. A
capture already accepted for installation remains owned by the share; cancelling
input permission cannot kill that picture. The password verifier is kept only in App memory, with one
attempt per second shared across that source's endpoints. The verifier is never saved in
configuration, diagnostic reports or links. Host approval, decline and end-control
actions stay on the same sharing page. The existing authorized native-control connection carries these commands;
only the session that owns the share can decide its requests. Request identity
comes from the authenticated room binding, never a relay-supplied participant
name. The grant is bound to that input channel and source, with a fresh nonce for each approval.
Each request has its own identity: a late Host decision cannot approve a newer
request, and a late approval cannot revive the Viewer's cancelled intent.
Source unavailability ends every pending intent, including one not yet received
by the Host; it is not a response scoped to an older request.
Site capture approval never grants input rights. Input may operate the whole
computer; a shared picture is not an OS input sandbox.

Revocation, pause, source replacement/retirement and connection loss release
held keys and buttons. The channel belongs to the sharing session; permission
and pointer coordinates belong to its current source. The Host can change
windows/displays through the existing source picker without starting another
share, with fresh permission for the replacement. Audio-only changes retain the
current grant. Brief ICE loss and media-route replacement revoke permission;
the recovered path carries a fresh request. App playback and relay descendants
follow the same rule; interruption releases the upstream grant.
A closed control channel needs a new media
connection; neither path silently restores a grant. Either side can end control
from its page. Windows also supplies a local Ctrl+Alt+F10 stop shortcut by default;
macOS uses Control+Option+F10. The Host can change the function key in the control
panel; the current Site's Browser storage owns this preference and reapplies it
before enabling control. App keeps only the running binding, with no shortcut
configuration file. Configuration probes availability;
registration lasts only while at least one native session enables control,
never merely because App is running. An occupied key fails that operation
without disabling capture or the input backend. Replacing
the shortcut retains the old binding until registration succeeds; only a
successful change is saved in the Browser. Each Site has its own preference.
Viewers independently choose their page-local exit shortcut in the remote
keyboard; it also works in a detached keyboard window and saves in that Browser.
Both selectors offer F1–F11 with fixed Ctrl+Alt/Option modifiers;
[Windows reserves F12](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey#remarks).
The optional App discovery capability gates the new commands, preserving the
published permission and input-state messages. Linux retains the desktop's sharing controls instead
of registering a second global key grab. A Host stop (including that local shortcut) also resets automatic
permission to Ask each time. A Viewer ending their own control leaves the Host's
policy in place. This adds no service, automatic sharing or control across App
restart. Escape releases game mouse capture without ending the grant.
Window blur releases held input. Control ends when no input surface is visible,
or when video is locally paused or enters native PiP/fullscreen. New requests
require the picture to be playing in the page; returning never restores a grant.
DOM fullscreen keeps the page's input surface and retains control. Pointer motion retains the
latest absolute sample or accumulated relative movement within a short timer,
flushing before button/key transitions so a drag ends at its final position.
Input batching does not wait for rendering. Motion batching stays independent
and bounded.
Normal pointer-capture release after mouse-up preserves held keyboard keys;
actual cancellation, blur and grant retirement release them.
Host settings reuse the shared floating panel beside their entry. An unapplied
enable request shows a cancel action without displaying permission as granted;
older completions cannot replace newer form feedback. Viewer request, failure and
focus feedback stays beside the remote-control action, separate from media health.
Desktop control uses the normal pointer, game mouse capture hides it, and touch
control retains its visible arrow.
Control actions use the existing playback bar. While controlling, a drawer handle
on the television frame reveals the bar, keeping picture pixels available for
input. Remote key input does not count as keyboard navigation of playback controls.
Host management and the Viewer's virtual keyboard can use the browser's
always-on-top document window, reusing the same portal and state as chat.
Closing that window returns its content to the page. Keyboard migration, blur
and retirement release held input; its visible detached document keeps the
existing grant while the main tab is hidden. Physical key capture and game
mouse lock stay with the picture, while the detached keyboard sends virtual
keys and committed text through the same input session. Grant retirement
closes the keyboard window. Browsers without this API retain the in-page UI.
A stalled send queue closes the input channel
without replacing the media connection. No input history is persisted.

Local acceptance exercised real Windows display capture, Browser and App-assisted viewing,
native mouse click, keyboard text, wheel, held-key release and the local stop
shortcut. The consent owner was also checked over real SCTP channels for
unapproved/stale input, controller replacement, pause, disconnect and source
retirement. Display → window → display switching retained the channel and
required fresh approval; the App-assisted path delivered actual mouse/keyboard
input and released a held key on revocation. Request snapshots and decisions
are scoped to the owning native share; another session cannot inspect, approve
or decline them. Real Browser-relay, App-relay and SFU chains also delivered
video and native key input, released held input on Host revocation, and retired
control on share stop. Both relay chains recovered viewing and accepted a fresh
request after their intermediate participant left. These checks do not
establish remote-network latency, game compatibility, mixed-DPI behavior or
antivirus classification. The experiment build and disposable UI/input probes
remain under ignored `build/remote-control-prototype/`.

Touch input uses a relative touchpad over the contained picture: one finger
moves the cursor, a tap clicks, holding starts a drag, and two fingers scroll
or tap for a right-click. Pinching magnifies the local picture up to 4×; while
magnified, a two-finger drag pans the view instead of scrolling the remote page.
A 1× button restores the whole picture. One gesture owner distinguishes pinch
from scrolling after both contacts update, and retains that choice until release.
The input geometry uses the transformed picture; local panning keeps its touch
cursor visible without sending input. Zoom is cleared with the grant and does
not change capture resolution or the media route. Pointer events select this
behavior without OS or browser-name checks. The gesture owner is scoped to the current grant;
cancellation, blur and grant retirement release held input. Temporary loss of
Host window focus retains the grant's touchpad position while suspending input.
The keyboard panel reserves space below the picture, or beside it in a short
landscape fullscreen/theater view. Letters, numbers/symbols and function/navigation
keys use separate compact sections; text input retains the local IME. Opening
the key panel does not summon the phone's software keyboard. Keys follow physical
press/release by default. Optional combination mode lets a tap select each
modifier; completing the next ordinary key releases the selected modifiers.
Tapping a selected modifier again cancels it; turning the mode off releases all keys.
Held contacts repeat and release independently, including
on cancellation, panel closure and window blur. No pressed state survives grant
retirement. Common text shortcuts remain beside the text field.
Its buttons follow the controlled App's platform, including Windows Win+Space
and macOS Command shortcuts, without depending
on the local OS delivering that combination to the page. Physical system-key
capture remains subject to the local OS and Browser; even the
[Keyboard Lock API](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock)
only receives keys the OS permits. Piik does not install a global keyboard hook
or simulate the protected Ctrl+Alt+Delete sequence. Closing the keyboard returns
focus to the control surface.
The multiline text field owns IME composition and preserves a pasted draft;
Enter edits that draft and the explicit button submits it. One submission is
bounded to 2 KiB of UTF-8 so it fits the existing input queue without a bulk
transfer channel; an oversized draft stays editable rather than being truncated.
The shared input owner releases held keys and maps line endings/tabs to their
physical keys before passing ordinary text through the platform adapter, including Windows
[Unicode input](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput),
Quartz Unicode events and Portal keysyms.
There is no clipboard synchronization. This follows the touchpad conventions in
[Moonlight's input guide](https://github.com/moonlight-stream/moonlight-docs/wiki/Setup-Guide#keyboardmousegamepad-input-options).
No game-specific touch layout is added.
Chromium touch emulation delivered native clicks, scrolling, drag/cancel,
Chinese/emoji text and shortcuts over the existing P2P route. Narrow layouts,
DOM fullscreen, zoom/pan coordinate alignment and Host revocation passed;
physical Android/iOS soft keyboards and Safari's native fullscreen remain device
checks, not established by emulation.

Remote control can target an additive 2.x release under the
[compatibility contract](../standards/versioning.md#extending-interfaces): advertise
an optional capability, and exchange new commands/events only between supported,
opted-in sessions. Existing sharing and old command/event shapes remain intact.
Site capability and App discovery readers already tolerate unknown descriptions;
this is an extension point, not proof of end-to-end compatibility. Local crossed
builds of the published 2.1.0 page/App and this prototype completed native window
sharing and Viewer decoding in both directions, without input opt-in, new input
events or a remote-control button when either side lacked support. This covers
those two combinations, not every published Site/App version. Multiple publishers
are not a prerequisite, and neither feature size nor an internal refactor alone
requires a major release.

### Distribution Risk

[Microsoft's software criteria](https://learn.microsoft.com/en-us/defender-xdr/criteria)
distinguish malicious behavior, unwanted software and user choice/control.
Attended remote control is a legitimate feature, but input injection and its
potential misuse can invite additional security review or enterprise blocking.
No source establishes a numerical false-positive increase for Piik.
[SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
and [Chrome download warnings](https://support.google.com/chrome/answer/6261569?hl=en)
are also distinct from a confirmed malware detection; signing does not guarantee
that a new binary avoids a warning. This prototype adds no unattended access,
startup persistence, elevation, driver, keyboard hook or security-product bypass.
Do not recommend antivirus exclusions as its deployment model.

### Remote Co-play

[Steam Remote Play Together](https://partner.steamgames.com/doc/features/remoteplay)
lets remote participants act as local players in the Host's game. For Piik, this
retains one shared picture. Games that support a shared keyboard can use separate
key bindings for the Host and remote player without an input driver. Independent
gamepads instead need per-player virtual controller slots. The co-play candidate
admits concurrent approved players when the Host enables Remote control,
without a separate multiplayer switch. Older published clients retain exclusive
keyboard/mouse control through capability negotiation. Held-key ownership is per
grant, so one player's key-up does not release another's key. Mouse buttons have the same per-grant
ownership. Approved keyboard/mouse players all contribute to one shared pointer;
there is no handoff, join-order arbitration or automatic local-Host priority.

Room-wide collaboration presence uses the existing signaling subscription model.
Sending the whole roster separately through every encrypted input endpoint would
multiply the snapshot across the intentionally small input queues. The Host App
remains the grant owner; signaling only presents its endpoint-bound snapshot,
with source-generation checks and an opt-in for older-reader compatibility.

Game player count is separate from input-device support. Team17 documents
[four local players but two sharing one keyboard in Overcooked! 2](https://www.team17.com/news/overcooked-2-faq).
[Pummel Party's developer](https://steamcommunity.com/app/880940/discussions/0/1742226629869609303/)
describes assigning a physical controller separately from keyboard/mouse; its
local-player count does not establish split-keyboard support. A Host using a
physical controller and one remote keyboard player can therefore be another
driver-free use case when the game supports that combination. The Host enables
**Remote control**; authorization and encrypted input reuse
the same route and source owner.

Simulating keys is different from creating independent devices. Windows
`SendInput` writes to the existing input stream; it does not create a second
keyboard or pointer. Microsoft's [Virtual HID Framework](https://learn.microsoft.com/en-us/windows-hardware/drivers/hid/virtual-hid-framework--vhf-)
still requires a HID source driver. Device identity also needs support in the
game. Windows also exposes [gamepad injection](https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector.injectgamepadinput),
but it requires the restricted `inputInjectionBrokered` package capability;
that API alone does not establish a portable-App backend or independent slots
accepted by desktop games. A local Windows native-API probe returned successful
HRESULTs for activation, initialization, input and cleanup, but exposed zero
virtual controllers. It did not establish a usable alternative to ViGEm.
Linux can create devices through its existing
[uinput module](https://docs.kernel.org/input/uinput.html), subject to device
permissions. Dependencies therefore follow the platform and supported games.
Per-player virtual keyboards and mice do not make an arbitrary game recognize
independent players. Steam's [direct-input interface](https://partner.steamgames.com/doc/api/isteamremoteplay#BEnableRemotePlayTogetherDirectInput)
can expose separate input events to an integrated game; it is not a general
desktop-game backend. Independent gamepads are the more useful next assessment.

[Moonlight's input implementation](https://github.com/moonlight-stream/moonlight-common-c/blob/aeba988e0a302145eff2e70fa3e11cd98ec01f5d/src/InputStream.c)
accumulates relative movement and sends the latest absolute pointer position;
input event semantics determine batching and delivery, rather than treating
every sample as chat. [Sunshine's input owner](https://github.com/LizardByte/Sunshine/blob/5b2a4cfdfa643b5307906c68eb122e5a34855263/src/input.cpp)
tracks pressed keys/buttons and resets input state. These are useful reference
patterns for bounded queues and grant retirement. Their GameStream transport
is not a Browser WebRTC input component; both implementations remain study-only
under the project's license policy.

The current candidate uses a Windows x64 adapter for the public ViGEmBus device
interface. The Host installs the optional driver; Piik packages no input SDK or
driver binary. [Parsec also uses a virtual USB driver](https://support.parsec.app/hc/en-us/articles/32381705301908-Setup-Gamepad).
[ViGEmBus is end-of-life](https://docs.nefarius.at/projects/ViGEm/End-of-Life/);
the [final 1.22.0 installer](https://github.com/nefarius/ViGEmBus/releases/tag/v1.22.0)
removes its updater.
The current [libvirtualhid platform matrix](https://github.com/LizardByte/libvirtualhid/blob/dfff3ea8c34022c915799740806c17c0ed5c2492/docs/platform-support.md)
offers a common API, but Windows/macOS require installed licensed components;
Linux uses kernel input facilities and device permissions. Its library is MIT,
while drivers/brokers have a [separate source-available license](https://github.com/LizardByte/libvirtualhid/blob/dfff3ea8c34022c915799740806c17c0ed5c2492/LICENSE.md).
These separate terms do not grant free driver distribution with Piik.
The adapter uses the [published bus requests](https://github.com/nefarius/ViGEmClient/blob/b66d02d57e32cc8595369c53418b843e958649b4/include/ViGEm/km/BusShared.h)
through Windows device APIs, without loading the client DLL. A bus file handle
owns a driver session; allocated serials identify this session's controllers,
not the game's player numbers. Native checks from a directory containing only
the test executable observed independent XInput reports, neutralization and
removal. A foreign session could not unplug another session's device; closing
one bus handle removed only its own devices. The driver's unsupported protocol
response was also checked.

The driver can temporarily have no queued USB input request. Ordinary reports
then yield to the next complete Browser state; they never sleep or queue stale
input. A one-off neutral reset retries for at most one input frame before
retiring the grant, so a dropped reset cannot leave a held controller. Device
closure removes the controller even if a final neutral report cannot be sent.

The Linux prototype uses the stock uinput userspace API, one device per grant,
without another driver or dependency. Linux amd64/arm64 test binaries
cross-compile and Linux vet passes. On 2026-10-23, the explicit uinput kernel
gate passed in an isolated QEMU TCG VM running Alpine 3.24.3 and Linux
6.18.58-0-virt x86_64: five independent devices exposed correct evdev state,
neutralized and retired without changing a surviving sibling. Backend shutdown
removed the remaining devices. The VM and helper were cleaned up without a
Host installation. Desktop-user device permissions and real-game recognition
remain acceptance work. The macOS prototype uses native `IOHIDUserDevice` and
a generic HID gamepad report, with
device ownership and cleanup in its platform adapter. It requires Apple's
[`com.apple.developer.hid.virtual.device` entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.hid.virtual.device), separate from
Accessibility permission. No macOS SDK is available in the current environment,
so compilation, entitlement admission and desktop-game recognition remain
unverified. Neither prototype is evidence of a supported shipped platform.

The candidate path is Browser Gamepad API ->
existing encrypted input route -> Host-approved player slot -> platform gamepad
backend. The Host assigns device identity; a guest cannot select another player's
slot. Reuse input-grant retirement to neutralize buttons/axes and dispose owned
devices. Keyboard/mouse and gamepad grants remain distinct. The current Browser
collector uses one standard-mapped controller per page and reports at up to 60 Hz.
No new media route, port or multiple screen publisher is required. Slot capacity
follows the backend and game, including physical controllers already in use;
it is not the room capacity. Real-game recognition and concurrent-player
acceptance remain in [TODO](../todo.md#now).

### Window Capture And Game Input

Reviewed 2026-10-17. The prototype now passes the existing native capture target
to the input owner for both windows and displays. Capture selection, input
capability and Host permission remain distinct facts; this adds no media path
or input driver. Virtual gamepad eligibility must follow its input backend and
grant, rather than desktop pointer coordinates.

For window keyboard/mouse control, the captured region must map to the current
native window geometry, including movement, resizing and DPI. The input owner
reads the current geometry and process identity. It suspends input and releases
held state when the target loses focus, and revokes control if the source
disappears. Both pages display that same suspension; the Host is asked to focus
the shared window to resume. This reduces
accidental input after switching away; it is not an OS window sandbox.
`SendInput` has no target-window parameter, and shortcuts can change focus.
Window selection must never imply that remote input is confined to that window.

The Windows sink uses physical-key mapping through
[scan codes](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput),
and supports relative mouse movement through browser
[Pointer Lock](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API),
with an exit interaction that leaves Escape available to games in ordinary
pointer mode. Mouse button transitions use `mousedown/up`: unlike
[`pointerdown/up`](https://developer.mozilla.org/en-US/docs/Web/API/Element/pointerdown_event),
they retain chords such as holding right while clicking left. Pointer capture
keeps drags attached to the picture; release is observed across the Viewer
window so leaving the picture cannot leave a button pressed. Scroll handling
retains magnitude and fractions across Browser wheel units; the default
conversion follows [Chromium's wheel mapping](https://github.com/chromium/chromium/blob/main/ui/events/blink/web_input_event_builders_win.cc)
and [Windows wheel/button semantics](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput).
The Browser input session owns request/grant lifetime separately
from the React controls and DOM capture. Real SCTP checks cover permission,
focus suspension, updated geometry and retirement; Browser checks cover window
capture, consent and pointer lock. Local window move/resize checks matched the
input owner's live bounds to the decoded WGC aspect ratio, including even-pixel
encoder rounding. A visible isolated Windows target received native clicks
before and after movement/resizing, physical-key and relative-mouse input;
focus suspension/resume and Host revocation also passed. These checks do not
establish commercial-game compatibility or mixed-DPI behavior.

A local Pion/SCTP probe with 40 ms RTT delivered ordered input in about 20 ms
without loss and about 94 ms at the 95th percentile when every twentieth
outgoing data packet was dropped. A lost final event, without subsequent input,
instead waited about 683 ms for retransmission. This synthetic transport probe
does not establish Browser or game latency. Reliable delivery prevents lost
key-up events from permanently holding a key, but does not promise immediate
release during loss. Keep the first prototype on the existing ordered channel;
desktop acceptance must not be presented as competitive-game readiness. These
are input semantics and acceptance work, not reasons to replace the media pipeline.

The reviewed implementation uses WGC capture and the documented Windows input
API, without game-memory access, injected game code or an input driver.
[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
remains subject to process-integrity restrictions, and a successful call only
proves insertion into the system input stream, not acceptance by a game.
[Windows marks injected keyboard events](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-kbdllhookstruct).
[BattlEye distinguishes blocking/kicks from bans](https://www.battleye.com/support/faq/);
its policy does not certify Piik or another game's anti-cheat. No current evidence
establishes Piik game compatibility or a ban probability. Virtual controller
drivers are likewise not an anti-cheat exemption. Keep integration on supported
platform APIs and maintained input backends; do not add process injection,
protection bypasses or forced background input to make a rejected game work.

## Primary References And Rationale

- [LiveKit media and data](https://docs.livekit.io/frontends/build/media-data/)
  separates publications from finite data. Piik already has an authenticated
  signaling channel; adding the LiveKit room service solely for chat is unnecessary.
- [LiveKit text streams](https://docs.livekit.io/transport/data/text-streams/)
  distinguishes current-participant delivery from persistent history. The
  implementation likewise promises transient room messages, with explicit local bounds.
- [WebSocket buffering](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount)
  and [WebSocket API limitations](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
  motivate bounded queues and explicit send failure rather than an accumulating outbox.
- [WebRTC data channels](https://www.w3.org/TR/webrtc/#rtcdatachannel)
  depend on peer connections. Using them here would couple chat readiness and
  fan-out to a screen-sharing route; the existing room WebSocket avoids that.
- [React state identity](https://react.dev/learn/preserving-and-resetting-state)
  supports resetting the panel with its room session rather than a reconnecting
  transport identity. [ARIA log semantics](https://www.w3.org/TR/wai-aria-1.2/#log)
  provide sequential, non-interrupting announcements alongside visual effects.
- [Meet reactions](https://support.google.com/meet/answer/13151720?hl=en)
  attach expressions to participants and let viewers reduce visual distraction.
  Piik likewise keeps reactions outside the shared picture, with explicit local
  display preference and a separate accessible event description.
- [Microsoft participant cards](https://support.microsoft.com/en-us/outlook/profile-cards-in-microsoft-365)
  place person-specific actions on the selected person. Piik uses that direct
  entry on its existing couch rather than requiring a second participant list.
- [Native popovers](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using)
  provide top-layer placement, light dismissal and focus return without adding
  a second overlay framework. Piik owns the bounded card's anchor and contents.
- [Animation time](https://developer.mozilla.org/en-US/docs/Web/API/Animation/currentTime)
  lets a newly mounted or resumed effect seek to its remaining phase. The
  [clock comparison](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now#ticking_during_sleep)
  explains why replacing wall time with a monotonic clock alone would not solve
  cross-platform sleep and resume.
- [niconico playback controls](https://help.nicochannel.jp/hc/ja/articles/4414625162777-%E5%8B%95%E7%94%BB%E3%81%AE%E8%A6%96%E8%81%B4%E6%96%B9%E6%B3%95)
  keep comment display optional alongside playback. Piik likewise separates
  each viewer's overlay preference from message delivery and the conversation.
