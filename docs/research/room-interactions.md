# Room Interaction Design

The owner accepted the text/reaction UI and model with bounded local acceptance.
[Status](../status.md#accepted-interaction-phase) owns release readiness and
[TODO](../todo.md#now) owns remaining work. Reviewed 2026-10-02.
This document records the implementation design and its tradeoffs;
[rooms and access](../standards/rooms-access.md#room-interactions) owns authority
and retention, while [presentation and lifecycle](../standards/presentation-lifecycle.md#product-surface)
owns room/publication lifetime.

## Model And Owners

| Concern | Owner | Lifetime |
| --- | --- | --- |
| Identity, room membership and access | Existing room store and authenticated signaling session | Current admitted participant |
| Screen/camera plus Host commentary | Existing capture and media owners | Current share and source |
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
  requires the `roomSession: true` authentication opt-in; older clients retain
  the original stop-and-leave contract. Existing v23 media messages remain
  valid, and publication start/result messages are sent only to an opted-in
  session.
- The viewer discovers this optional capability independently of first-picture
  startup. Late capability discovery enables data on the existing connection.
- A strict payload union admits plain chat text or a registered reaction. Chat is
  at most 280 Unicode code points, normalized to NFC, without control/bidi
  characters. It renders as text, with no markup, links, attachments or commands.
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

Chat uses the shared `FloatingPanel` shell for its nonmodal window. The shell
owns native visibility, placement, movement, resizing and focus return; the
conversation retains its session, draft, reading position and unread state.
It opens initially at the lower right, without
resizing the picture or moving the couch. Drag its title bar, use arrow keys on
the focused bar, or explicitly choose a corner under Position. Its summary also
allows dragging; a drag never activates the menu. Resize from either diagonal
corner, use arrow keys on a resize handle, or choose a preset under Position.
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
Selecting a person opens the compact reaction palette in the shared floating
shell, initially beside the selected person (below when space permits). Each
opening anchors there before allowing free movement. Its portrait and name identify the
target even after moving the window. Selecting a different participant keeps its
placement and any manually chosen size; selecting the same person toggles it.
The default palette height follows its content, bounded by the visible viewport.
One's own palette expresses a reaction above oneself and holds the local effects switch; other
people's palettes offer targeted expressions and two labelled throwing props.
Connection details remain secondary when that participant has inspectable data.
Close or Escape dismisses the palette; it also closes if its participant leaves.
Sending keeps it open for repeated interaction, with the existing short cooldown.
Confirmation never changes menu visibility; failure stays visible in the card.
Opening or closing a reaction card preserves the chat draft and unread state.
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
Everyone sees the same server-issued event; placement follows their own couch
layout. Effects have a couch-only coordinate owner, independent of panel layout,
and never become a video overlay or a media status. Impact transforms leave the
UUID-owned idle animation, names and status indicators alone. Hiding effects or
retiring the event cancels its own animation; showing a still-live event uses its
remaining lifetime. Users can hide effects; reduced motion uses a static stamp.
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

The Host microphone remains commentary mixed into the shared source.
Bidirectional room voice is not part of the product plan.
Text, reactions and danmaku introduce no microphone capture, voice
admission or additional media peers.

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
