# Room Interaction Design

This document retains published 2.x interaction research and the separate
[3.0 assessment](#piik-30-channels-rooms-and-sharing). Sections before that
assessment describe 2.x unless explicitly marked otherwise. Its authority and
retention belong to [rooms and access](../standards/rooms-access.md#room-interactions),
with [presentation and lifecycle](../standards/presentation-lifecycle.md#product-surface)
owning room/publication lifetime. The 3.0 section links to its current owners.
[Status](../status.md#accepted-interaction-phase) owns delivery readiness;
[TODO](../todo.md#now) owns remaining work.

## Model And Owners

| Concern | Owner | Lifetime |
| --- | --- | --- |
| Identity, room membership and access | Existing room store and authenticated signaling session | Current admitted participant |
| Screen/camera and source sound | Existing capture and media owners | Current share and source |
| Room microphone and listening | `RoomVoiceSession`, Browser input and room-route adapters | Explicit voice membership, independent of picture sharing |
| Text and reactions | `signal/interactions.go`, shared protocol and `RoomInteractionSession` | Current authenticated room session; bounded page-local presentation |
| Chat panel, optional chat overlay and reaction placement | Shared `RoomInteractions` and `RoomChatOverlay`; `RoomInteractionSession` owns bounded events | Current room UI |

The existing authenticated room WebSocket admits interactions independently of
media routes, decoded frames and SFU readiness. Pause, source replacement and
media recovery preserve the conversation; messages neither restart capture nor
acquire another connection.

A capable Host explicitly opts into a persistent room session. Restoring it
requests no capture; capture readiness and publication acknowledgment precede
media effects. One awaited restoration/recovery owner checks the actual room
and token. A rejected start retires only its attempted generation. Stopping a
publication keeps the Host's authenticated interactions; room close, access
loss, session replacement and page teardown retire the whole session. Hosts
without the capability retain stop-and-leave behavior.
Opening the Host page alone still does not create an unused room.

The current non-empty publishing generation, fenced by room reconnect identity,
is the only publishing truth. Idle Host presence creates no late-Viewer media
route. Admitted Viewers can still interact after the Host disconnects while the
room service remains available. Closing an App that runs that service ends it;
leaving the Host page does not. Departed people cannot receive targeted reactions.

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

Chat uses the shared `FloatingPanel`: the shell owns native visibility,
movement, resizing and focus return; the conversation owns session, draft,
reading position and unread state. The initially lower-right panel does not
resize the picture or move the couch. Drag the title bar or use its arrow keys;
diagonal resize handles support pointer, touch and arrow keys while holding the
opposite corner steady. The visual viewport keeps it above an onscreen keyboard
without erasing this room UI's placement preferences.

The native manual popover remains usable beside picture controls. Close, the
entry toggle and Escape hide it without retiring conversation. Inner menus
consume Escape first, then the newest utility window, then theater; IME
composition is not dismissal. Opening focuses the panel without summoning the
keyboard, and explicit close returns focus. Nested disclosures do not own panel
visibility. A bounded scrolling log preserves reading position and consecutive
sender grouping; every message keeps its accessible author. Latest resumes
following, and confirmation does not lock draft editing or add an outbox.

The chat entry and participant count share the couch footer, separate from
sharing controls. Theater hides seating/count and retains that entry; HTML
player fullscreen keeps danmaku but not the conversation panel. Only an
unobscured, visible document following the latest log advances local unread
state. Hidden/scrolled-back chat, settings and danmaku do not mark messages read.
These indicators are not recipient read receipts.

Person actions share one target heading, reaction buttons and send owner:

- The couch palette opens beside the selected person (below when space permits)
  in the floating shell, then allows movement/resizing. Changing person retains
  its chosen size/placement; choosing the same person toggles it. Portrait/name
  keep the target explicit. Close/Escape or that person's departure dismisses it;
  sending and confirmation do not. Failure remains in the card and cooldown
  permits repeated interaction. Connection details appear only when inspectable.
  Self offers expressions and the local effects switch; other people also offer
  the two named throwing props beneath the expression grid.
- The attached chat/voice palette leaves its list and composer intact. Quick
  actions are thumbs up/down and throws; self substitutes laugh/heart. More
  reveals the curated palette with a labelled Back. Native anchored popover
  placement owns viewport fit and dismissal; clicking the composer continues
  typing. Page/document moves dismiss this brief menu without changing session,
  draft or reading position. Departed avatars are noninteractive.

Self expressions follow the sender's head and replace only that sender's prior
self expression. Targeted delivery retains sender/recipient attribution and
settles separately above the recipient, never replacing their self expression.
Throws require a current target, retain its identity and leave its face visible:
tomato squashes with droplets, poop wobbles with a puff. Other expressions use
brief gestures and sparse accents. Event ID and actor seed variation; every
accent shares the event's remaining phase/expiry. Hiding effects cancels its
animation, and remounting/reduced-motion return uses remaining time rather than
replay. Each visible roster supplies local coordinates to the same renderer;
effects do not claim media state or overwrite idle motion, names or status.
The displaying document owns scheduling, so a hidden opener cannot freeze its
detached tool. A live-reaction summary reuses that event/renderer without another
history entry or expiry timer. The polite accessible log retains localized
sender/action/target descriptions even with effects hidden; reduced motion uses
static stamps and removes picker movement.

Danmaku is an optional projection of newly received chat, not another transport
or message kind. It defaults off; composer and playback-bar switches share the
local owner, including HTML fullscreen. At most three single-line comments last
up to six seconds. Picture width sizes text; settings scale it to 80–130% and
opacity 40–100%, default 100%. These session-local preferences survive signaling
reconnection but reset with session replacement/reload. Editing them preserves
active flights, draft and scroll position.

Event sender/ID chooses a lane; a new event replaces that lane's flight without
queuing playback or removing full-log text. Text clips above playback controls,
showing fewer whole lanes when space shrinks without restarting time. It never
intercepts playback gestures. Hidden documents, unavailable pictures, source
change and disconnection clear flights; reopening never replays old comments.
Reduced motion uses temporary stationary text. Native video-only fullscreen and
video PiP cannot include HTML overlays.

Server confirmation means acceptance, not receipt by every participant. Received
chat follows server order; congestion may leave gaps, without changing an
event's lane/time basis. Chinese, English and visual modes share behavior;
visual mode keeps names/text and localized accessible labels. Host identity
reuses its crown; colour and reaction motion do not assert connectivity,
capture permission or delivery.

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

## 2.x History Assessment

Published 2.x keeps no server history. The earlier history proposal was not
adopted: a Host cache can miss live messages and is unavailable while the Host
is absent. Treating its copy as server-confirmed history would change message
authority. The assessment also considered a bounded room-server memory buffer;
either design required explicit access and retention boundaries.
Recovered text would enter the log, never replay old
danmaku or reaction effects. The separate 3.0 implementation follows the accepted
[confirmed-history owner](./channel-storage-and-identity.md#confirmed-history).

## Audio Boundary

Text, reactions and danmaku introduce no microphone capture or additional media
peers. Published room voice and optional Host source commentary follow the
[current microphone contract](../standards/media-quality.md#capture-and-controls).

### Room Voice Transport Assessment

Integration update, 2026-10-20: the normal App/Server/Web candidate now uses one
room controller for voice and picture, with companion Browser audio connections
on its selected edges and an embedded Opus SFU adapter on the existing UDP mux.
The earlier experiments below remain design evidence, not the distributable
implementation. Room voice now opens when the Host joins and closes when the
Host leaves. Room admission replaces per-person voice permissions. Pausing local
listening leaves the room-voice microphone on. Source sound stays with the picture.
This follows the independent media
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
[room media](../standards/routing-transport.md#room-media). This integration shipped
in v2.4.0; the dated experiments below describe its earlier design evidence.

#### Historical Prototype Assessment

The 2026-10-19 experiments compared a self-hosted Opus SFU, an App voice hub,
participant mesh and a room-owned bidirectional tree. A picture route did not
prove a usable voice star: with `Host <-> A <-> B` reachable but `Host <-> B`
blocked, a Host-App hub left B without voice. Before sharing there might be no
picture tree at all. The encrypted input channel was rejected as an audio path:
it provides neither RTP feedback nor jitter-buffer/playout ownership.

The tree candidate lifted existing graph/connection lifetime to the room while
keeping one serial prepare/commit operation and independent publications. Shared
transports support bidirectional tracks through
[WebRTC transceivers](https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver) and
[BUNDLE](https://www.rfc-editor.org/rfc/rfc8843.html). Video stop retires only its
consumer; mute does not leave voice, and the last consumer/transit demand retires
the connection. Silent voice cannot depend on an audible sample or decoded video
frame. Publication and connection generations remain separate.

[RTP forwarding topology](https://www.rfc-editor.org/rfc/rfc7667.html#section-3.7)
preserves independent speakers and per-person mute without returning ingress
audio. A single mix would need listener-specific outputs. Payload-only App-star
upload is 288 kbps for four people with 32 kbps tracks, versus 12.8 Mbps for 21 all
speaking; neither calculation includes overhead or proves capacity. A relay
without listening permission needs an explicit authorization/encryption choice.

The isolated Pion/Browser trials demonstrated independent Opus voice, source
audio and VP8 on the same connections: picture pause/stop/replacement, listener
revocation/reapproval and candidate preparation preserved publication scopes.
An edge interruption reused the existing controller's alternate-route and
decoded-frame commit; signaling reauthentication reconciled the current failure
instead of adding a retry owner. The separate-forwarder control preserved
picture while direct voice ICE was blocked and recovered voice after explicit
rejoin. Worker pipes carried authenticated plans, not room credentials or a
second planner.

These were synthetic local decoding/forwarding results, not production App
integration, public-NAT reachability, echo cancellation or 21-person acceptance.
The shipped integration above supersedes their proposed speaking/listening-grant
policy. Current dual-microphone behavior belongs to
[media quality](../standards/media-quality.md#capture-and-controls). Deliberately
recapturing received voice put it into source audio; supported exclusion removed
it. Headphones alone do not prevent system-loopback recapture, and that routing
control is not a physical echo-cancellation result.

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

## Piik 3.0 Channels, Rooms And Sharing

The [accepted channel and network design](./channel-network-design.md) owns the Rust
direction, responsibility boundaries, activity lifecycles and multi-source routing.
The [room-data model](./channel-storage-and-identity.md) owns persistence and
file availability. The [3.0 vocabulary](./channel-network-design.md#terminology-and-responsibilities)
defines sites containing rooms, with hosting, sharing, watching and forwarding
as independent responsibilities. The isolated 3.0 design does not change the
published 2.x contract.

The isolated [Rust channel prototype](../../prototype/channel-server/README.md)
uses the shared Rust core for rooms, conversation, files, voice and multi-source
sharing. Its README and [status](../status.md) own the runnable boundary.

### Workspace Hierarchy

The selected direction presents one site with rooms, without an additional domain
chooser or invitation gate. [Visual language](../standards/visual-language.md#30-room-workspace)
owns the current workspace composition, control placement and responsive rules;
its [quick-sharing section](../standards/visual-language.md#30-quick-sharing) owns
the optional screen-centred view. The network/data owners retain identity,
directory, private-room admission and activity lifetimes.

This grouping follows Discord's [channel navigation and contextual chat](https://support.discord.com/hc/en-us/articles/4412085582359-Text-Channels-Text-Chat-In-Voice-Channels),
[personal voice controls](https://support.discord.com/hc/en-us/articles/33030151293079-Discord-Voice-Video-Streaming-Guide)
and [focus/pop-out views](https://support.discord.com/hc/en-us/articles/360041721052-Video-Calls).
Piik keeps its independent sharing lifecycle and couch rather than making a voice
call a prerequisite for watching or sharing. View changes and detached tools
present the existing activities rather than creating another session or
participant model. [TODO](../todo.md) owns remaining integration work.

### Identity And Share Titles

The selected personal-avatar treatment places the image inside the Pawn's body,
keeping its head, identity colour, headset and motion. Use the same Pawn across
conversation, voice lists and the couch; the unconfigured person retains its
plain body. Image preparation, saving and synchronization reuse the existing
identity owners, as defined by the [room-data model](./channel-storage-and-identity.md).

A screen title belongs to its publication. Use available capture metadata as
the automatic name, with a readable Screen/Camera fallback. A user override
survives successful source replacement; clearing it restores automatic naming.
Cancelled source selection does not change the title. Keep the sharer and room
visible separately, and do not expose raw capture IDs or paths as a title.
The current source endpoint owns changes; Native edits use the selecting page's
active capture lease. Titles live with the publication, not saved room history.
Renaming changes presentation without replacing media paths or input grants.

### Sound Feedback

Personal feedback sounds are off by default. **More options → Feedback sounds**
enables them for this browser origin, with an independent volume and a local
preview. A fresh message from another user, including an attachment-only message,
plays a short cue while the page is hidden. Foreground tomato and poop throws
play for their sender and addressed user, whether directed at a person, message
or shared picture. Other reactions and routine connection changes stay silent.

The existing room interaction owner validates freshness and deduplicates events
before notifying the page's audio owner. History, retry confirmations and moving
a panel do not replay sounds. One page owns one AudioContext and at most one cue;
browser suspension drops pending sound and a later user gesture resumes output.
Disabling feedback or setting zero volume releases its audio resources. Original
Web Audio cues play to the local output, separately from voice and share mixers;
OS or tab audio capture can still include that playback.

The message and throw slots can each use a local audio file of at most 256 KiB
and three seconds. Native browser decoding validates the file before replacing
the saved choice. Its name and encoded bytes use the existing origin-local
preference store; no separate file database or pack registry is needed for two
short clips. Each slot has a preview and reset to the built-in cue. A failed
decode or save keeps the previous choice. Replacement, mute and page shutdown
stop current output; stale decode results cannot replace a newer slot.
These are personal playback assets, not room broadcasts or executable plugins.

### Extension Boundaries

Ordinary friends should not need to configure permissions to share or collaborate.
Text automation runs as an independent ordinary user under the accepted Domain
and Room owners. This
does not introduce a Bot role, separate credential issuer or permission system;
external media follows the Source integration described below.

| Decision | Recommended starting point | Additional cost to accept |
| --- | --- | --- |
| Permissions | Keep current ownership and room participation for people and automation alike. | Address a demonstrated user-management need at its shared owner; the first adapter needs no Bot-specific privileges or roles. |
| Bots and APIs | Use an independent ordinary identity in a separate process, with existing site admission, room invitations and confirmed conversation commands. | Keep its credential with the process. Its configured room is a business target, not a server-enforced permission scope. |
| External media | Local OBS-to-App WHIP input uses the shared Source, publication and P2P owners. | Remote input, additional streaming protocols and unattended publishing need their own concrete scope. |

The site already creates an identity and personal credential for an ordinary
participant. An automated participant uses its own credential, kept with its
process and local configuration rather than supplied by a person's Browser session
or exposed back to a web page. It has the same public-room access and ability to
create rooms as any other ordinary user. Private-room entry uses the existing
invitation or password and the room host's saved grant.

Room owners can remove a private-room grant through the existing room settings;
this preserves authored history. A still-valid shared invitation or password can
permit admission again, for people and automation alike. Strict account scopes,
site-wide credential revocation and identity deletion would be shared user
management features if a concrete need arises. They are not prerequisites for
this ordinary-user adapter, and the current runtime does not provide them.

APIs should call existing owners, not write room databases or fabricate confirmations.
A bot cannot replace an offline room host's authority or storage. Hosting follows the
actual Browser/App/Server runtime; personal device and remote-input grants never pass
to a bot through room administration. Defer in-process plugins: the
[TeamSpeak native SDK](https://github.com/teamspeak/ts3client-pluginsdk) illustrates
the exported API and callback boundary that Piik would then have to maintain.

Start the bot adapter with a useful notification and one conversational command
in an explicitly authorized room. Game-server/build notices, dice or team choices,
and short reminders fit ordinary confirmed messages. External event handling and
timers belong to that process; delivery still needs the actual room host online.
[Mattermost webhooks](https://docs.mattermost.com/developers/integrate/webhooks)
and [Zulip interactive bots](https://zulip.com/help/interactive-bots-api) provide
examples of this small integration boundary. Piik need not add a generic webhook
server or a second Markdown format to supply it. A ready-check bot can retain one
choice per authenticated user; existing cumulative reaction counts are not ballots.

The [independent text example](../../prototype/channel-browser/examples/README.md)
uses its own ordinary identity with the shared Core signer and reply verifier.
A Browser-hosted room exercised confirmed history/replies, reconnect and
host-offline rejection. A fresh host binding reissues Browse; history never
replays old commands. Existing private invitations/passwords and optional local
credential retention apply unchanged. A restarted process keeps its identity/
grants but uses a fresh session/signing key. Invalid saved credentials fail
without replacing the local file.

Shared pads, checklists and watch queues can begin as ordinary links or bot replies.
Embedding arbitrary web tools adds identity, capability and instance-lifetime work:
[Discord Activities](https://docs.discord.com/developers/activities/how-activities-work)
has an explicit iframe/SDK boundary. Keep that separate from personal sound/visual
preferences and external media adapters. Full/quick presentation must share the
same activity instance. General widget runtimes and native plugin ABIs remain
deferred; extra collaboration pointers remain under the owner's existing hold.

### Local OBS Input

[OBS WHIP output](https://obsproject.com/kb/whip-streaming-guide) accepts an endpoint
URL and bearer token. The current adapter creates one input permission for the
authenticated page's selected room, after Native room admission. The existing
room snapshot owns its validity; changing the room binding, losing its grant,
closing the page or stopping the input revokes it. Credentials remain in memory.
The [runtime reference](../../prototype/channel-server/README.md#local-obs-input)
owns the user flow and current platform scope. Remote or unattended ingestion
and a general plugin runtime remain outside this implementation.

[WHIP](https://www.rfc-editor.org/rfc/rfc9725.html) owns each input resource's
setup and deletion. SDP answers return before media is ready; the first complete
keyframe then enters the same local-producer prepare/commit path as capture.
The controlling Browser performs any Browser-to-Native source transfer before
commit. Producer generations share the existing Driver owner, while OS capture
retains its specific mixer and input controls. Stopping OBS withdraws the current
publication; its page permission can accept a new stream. Viewers follow ordinary
publication lifetimes and select Watch again. Old DELETE/ready/end callbacks can
retire only their own resource.

The App's loopback control listener is separate from the site's tunnel target,
so Local network and Public invite use the same input adapter. HTTP requires the
page-issued bearer; the existing RTC pump supplies loopback-only media sockets,
candidates and actual datagrams, without public discovery or a second room graph.
H264 complete access units and Opus RTP retain the existing source clocks and
Sender Reports. Derived outputs use the existing encoder policy; an externally
configured source carries no invented capture ceiling. No RTC fork was added.

The Windows same-machine control used OBS 33.0.1 generated picture/stereo tones
through the real App and independent Browser. H264 decoded; Opus retained stereo
without speaker output. OBS restart, old DELETE, Piik stop and page close checked
publication withdrawal, permission revocation and UDP release. Constrained and
restored demand exercised existing derived encoding on the same source/feed/
clock, retiring the limited encoder on return. This is neither a new congestion
policy nor cross-NAT/other-platform acceptance.

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
The [2.x input adapter](https://github.com/TNTcraftHIM/Piik/tree/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/app/remoteinput) owned permission, grants and release; its platform
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

The [2.x input adapter](https://github.com/TNTcraftHIM/Piik/tree/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/app/remoteinput) owned one process-wide source because the App's native
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

Windows local capture and real SCTP controls covered native clicks/text/wheel,
held-input release, stop shortcuts, stale/unapproved input, pause, source change
and owning-session request isolation. Browser/App relays and SFU delivered
picture/input, released grants on revocation/stop and required fresh approval
after relay departure. This does not establish remote-network latency, game or
mixed-DPI compatibility, or antivirus classification. Ignored disposable probes
remain evidence artifacts rather than product procedures.

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
Chromium touch emulation covered clicks, wheel, drag/cancel, Chinese/emoji text,
shortcuts, narrow/fullscreen geometry and revocation. Physical Android/iOS
keyboards and Safari native fullscreen remain device checks.

The additive 2.x compatibility boundary follows
[interface extension rules](../standards/versioning.md#extending-interfaces):
advertise an optional capability and exchange input only with supported opted-in
sessions, preserving existing sharing/message shapes. Published 2.1.0 crossed
page/App controls retained native sharing and decoding without unsupported input
events or controls. Those two combinations do not prove every released pairing.
Feature size or internal refactoring alone does not require a major version.

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
admits concurrent approved players when the Host enables **Allow simultaneous
control** inside Remote control. It starts off for each new source. Older published clients retain exclusive
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

The Linux prototype uses stock uinput with one device per grant. Its isolated
kernel control exposed five independent devices, correct evdev reports,
neutralization and sibling-safe retirement; backend shutdown removed the rest.
Cross-compilation and kernel checks do not establish desktop-user permissions
or game recognition. The macOS prototype uses `IOHIDUserDevice` and a generic
gamepad report, with adapter-owned cleanup. Apple's
[virtual HID entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.hid.virtual.device)
is separate from Accessibility. SDK compilation, entitlement admission and game
recognition remain unverified. Neither prototype establishes a shipped platform.

The candidate path is Browser Gamepad API ->
existing encrypted input route -> Host-approved player slot -> platform gamepad
backend. The Host assigns device identity; a guest cannot select another player's
slot. Reuse input-grant retirement to neutralize buttons/axes and dispose owned
devices. One Viewer grant covers keyboard/mouse and optional gamepad input;
switching or combining devices adds no permission step. Simultaneous-control
admission counts Viewers rather than device types. The current Browser
collector uses one standard-mapped controller per page and reports at up to 60 Hz.
No new media route, port or multiple screen publisher is required. Slot capacity
follows the backend and game, including physical controllers already in use;
it is not the room capacity. Remaining Linux/macOS desktop and game-recognition
checks are tracked in [TODO](../todo.md#parked-product-work).

### Window Capture And Game Input

Reviewed 2026-10-17. The prototype now passes the existing native capture target
to the input owner for both windows and displays. Capture selection, input
capability and Host permission remain distinct facts; this adds no media path
or input driver. Virtual gamepad eligibility must follow its input backend and
grant, rather than desktop pointer coordinates.

For window keyboard/mouse control, the captured region must map to the current
native window geometry, including movement, resizing and DPI. The input owner
reads the current geometry and process identity. It suspends input and releases
held state when the target loses focus or its current geometry cannot be read,
and revokes control when the source identity is confirmed invalid. Both pages
display the suspension; restoring the shared window resumes the existing grant. This reduces
accidental input after switching away; it is not an OS window sandbox.
`SendInput` has no target-window parameter, and shortcuts can change focus.
Window selection must never imply that remote input is confined to that window.

Input execution and authorization have separate lifetimes. A failed system input
call drops that operation, while the existing grant accepts subsequent input.
Failed releases remain with the input owner until cleanup succeeds; actions and
partially inserted text are never replayed. This follows the failure scope used by
[Sunshine's Windows input sink](https://github.com/LizardByte/Sunshine/blob/v2025.923.33222/src/platform/windows/input.cpp#L435),
where an unsuccessful system call does not revoke the user's control session.

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
The Browser input session owns request/grant lifetime separately from React and
DOM capture. Local SCTP and isolated Windows-target controls covered permission,
live window move/resize bounds, WGC even-pixel aspect rounding, physical/relative
input, focus suspension/resume and retirement. These are not commercial-game or
mixed-DPI acceptance.

| Timing control | Result and boundary |
| --- | --- |
| Pion/SCTP with 40 ms RTT | Ordered input about 20 ms without loss, 94 ms p95 when every twentieth outgoing packet dropped; a lost final event waited about 683 ms for retransmission. Reliable release is not immediate release under loss. |
| Windows/Chrome 155 local components, 2026-10-24 | For 200 samples, Browser dispatch and AES-GCM-to-send each 0.1 ms p95; SCTP loopback RTT 0.8 ms. 100 ten-point bursts reached send in 5.1 ms p95, consistent with the batching timer, not rendering. Encrypted Pion→authorized recorded sink was 0.13 ms p95. |
| Combined 3.0 Windows local P2P, 2026-10-31 | Normal approval→OS click→WGC/encode→Browser compositor: 20 clicks, 40.8 ms median / 53.9 ms p95 on one Viewer monotonic clock. Excludes physical scanout; exact samples/build belong to that candidate's evidence index. |

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
