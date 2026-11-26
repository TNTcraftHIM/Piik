# Piik 3.0 Sites, Rooms And Networking

This document describes the 3.0 runtime and its routing evidence.
[ADR-0016](../adr/0016-shared-rust-core.md) records the framework. The
[forwarding model](./channel-forwarding-plan.md) owns forwarding behaviour and
the [hosting plan](./server-hosting-plan.md) owns channel modes and directory authority. The [prototype README](../../prototype/channel-server/README.md)
describes running behavior; [TODO](../todo.md) owns implementation and decisions.
The [2.x routing contract](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/routing-transport.md) remains unchanged.

## Current Prototype Design

In a lightweight channel the creator's Browser or App hosts the room. In a
hosted channel the Server keeps the room available after its creator leaves.
Participants return through the channel URL or a saved bookmark.

Conversation uses the existing domain WebSocket to reach its current room host.
Room voice, file transfers, forwarded webpage bytes and screen publications select independent
source-rooted paths on confirmed room connections. Pictures can improve through bounded
background transitions. All authorized,
capable room peers can be relay candidates; only viewers and necessary transit
nodes receive the picture. Each publication retains its route state through a transition.
The [room-data model](./channel-storage-and-identity.md) owns durable room records,
attachment copies and shared file delivery on those paths.

## Terminology And Responsibilities

The current prototype uses **Site → Room / 站点 → 房间**. A site is the entry
people open and the container for their rooms. Technical domain authority and
the existing `Channel` identifiers implement that site, not another product level.
The [copy convention](../standards/naming.md#voice-and-terminology) applies this
vocabulary across the UI and guides.

| English | Chinese | Meaning |
| --- | --- | --- |
| User | 用户 | Every participant, including site operators, room owners and sharers. |
| Site | 站点 | The shared entry containing a room directory and the users' site identities. |
| Domain | 站点后台 | The site's identity, room directory and coordination runtime. See the [naming convention](../standards/naming.md#voice-and-terminology) for code and wire terminology. |
| Site operator | 站点维护者 | The user managing site metadata, backups and room bindings. |
| Room | 房间 | A conversation, history and media scope within a site. |
| Room owner | 房主 | The user who manages the room. |
| Sharer | 分享者 | The user originating a particular screen, voice publication or file offer. |

Management and activities overlap: owners and ordinary users can share, watch
and forward. A file sender supplies bytes, not room management. A P2P relay is a
participating endpoint, not a separately deployed server; sending, receiving and
forwarding can coexist. The [activity model](#activity-and-lifecycle) owns runtime
lifetimes. Moving a room requires explicit transfer of operation and saved state.

## Authority And Information Boundaries

| Owner | Its authoritative state and work |
| --- | --- |
| Domain runtime | Owns channel identity, users and directory bindings. Publishes permitted room summaries and carries room commands to the current host. |
| Room host runtime | Detailed room metadata, room admission and grants, confirmed conversation, file descriptions/available holders, connection bootstrap and per-activity route selection. |
| Participant runtime | Local captures, playback, file copies and the actual peer transports/forwarding work it has admitted. |

The domain directory projects room details; it is not a second writer of room
metadata, private policy or history. Opening a site establishes or restores a
personal identity. Channel policy determines who can create rooms. Creators
manage their rooms. Admission permits
conversation, voice, sharing, watching and interactions without role groups or
participation switches.
The site operator may remove any room binding from the
channel directory, including a hidden or offline room. Reading its content
requires ordinary room admission. Source owners separately consent to remote input.
[Room maintenance](./server-hosting-plan.md#room-maintenance)

Public rooms admit site users through ordinary links. Private rooms require their
host's invitation or password after the site connection; hidden rooms disclose
neither details nor activity to unauthorized users. The site has no separate
access mode, password or invitation. A nickname or shared invitation is not a
shared identity. Invalid invitations and unavailable rooms do not retire site
identity. Only the local hosting owner retains its maintenance bootstrap key and
saved credential; visiting the same site grants no maintenance authority.

Each room has one current authenticated hosting runtime. When that runtime
goes offline, the room becomes unavailable. Reconnecting
the same retained runtime replaces its socket; a fresh hosting runtime obtains
a new binding, without granting a stale session authority over its successor.
The room projection carries its summary and common live publications, voice and
participant facts once. Recipient entries retain their own access, management,
reading, forwarding preference, subscriptions and file plans. The domain assembles
the existing complete client view only for an admitted recipient; it does not infer
private-room grants from the common activity. Binding and revision checks still
fence the whole projection, including host retirement and recovery.
Room admission, initial offer/answer and broken-tree repair instructions travel
through this existing domain rendezvous to the room
runtime; establishing or repairing the tree cannot depend on that tree already
working. The domain forwards these envelopes; the room host authorizes room actions.
WebRTC leaves the signaling carrier to the application
([W3C connection establishment](https://www.w3.org/TR/webrtc/#introduction-1)).

The App creates room runtimes through normal create/join actions, without a
separate public URL, daemon, storage server or permission owner.

After room admission, the room host confirms room changes and message order.
Chat, history, message reactions and live room interactions use the existing
domain WebSocket after room admission. This is their normal, single transport,
not a fallback after ICE failure. The domain verifies the sending connection,
current room-host binding and destination admission, then forwards the signed
packet. It neither stores conversation content nor acknowledges a room commit.
The domain operator can see forwarded text and inline images: signatures authenticate content
but do not encrypt it from the carrier. Other file bytes and file-pull control remain
on the room's peer paths.
Use short-lived session signing keys, bound to admitted sessions and the current
room-host binding through authenticated domain rendezvous. Sign the original
payload bytes with a maintained Ed25519 implementation, verify before parsing,
and resolve the author and permissions from current domain facts. Participants
trust the domain to bind sessions to the correct keys and supply current grants.
A forwarding session gains no authority from carrying a packet.
Long-lived admission credentials are not conversation payloads.

Forwarded requests use the same room authorization and storage operations as local
execution. They run in the room host's existing serialized turn without
changing its routing state or becoming domain-issued turns. Their confirmations
return to the request; domain revisions retain their authority/reply-fencing purpose.
Projection order and request authority remain separate: an older room snapshot
cannot replace newer routes, but an earlier authorized action can still complete.
Successful domain-mediated policy/activity actions are acknowledged after the domain has installed a
projection covering that turn. Until then, the existing pending request retains
its result; explicit failures do not wait for a projection.
Confirmation follows the requester's current session and room permission facts;
another participant leaving cannot invalidate it. Room entry uses that same
authenticated session and confirmation boundary after the site handshake.
The [room-data model](./channel-storage-and-identity.md) owns persistence, chat
retry identity, history correlation/complete pages, file copies and manual address
replacement. Live results are room-host signed without a permanent signed history
log; bounded queued output rechecks current authority. Domain Join/Welcome use
one explicit protocol version, rejecting incompatible endpoints before admission.
Domain and room data may reside on different devices; an App may compose both
runtimes locally.
The domain's public listener serves its Web UI and signaling; local approval and
App control stay on a separate loopback listener. Local and public entries address
the same domain, but only the local launcher receives its owner bootstrap.
Invitations use the domain's advertised public entry, not the administrator's
loopback address. Stopping that domain leaves unrelated approved sites running.
The App's own domain keeps one local identity and storage namespace independent
of its listener port and temporary public URL. Only its currently bound local
entry receives automatic App access; this does not merge external site approvals.

A user may have distinct Browser and Native endpoints, each with its own signing
identity, transports and activities. One App uses one Native endpoint per domain
for its rooms; each room retains its own authority and data. Hosting availability
does not imply reading, watching or voice participation. Recovery uses identity,
not nicknames or shared invitations. Bookmarks do not federate independent sites.

Peer media forwarding terminates hop encryption at admitted relays. Room access
must cover every relay; this model does not add end-to-end encryption against
those forwarding endpoints.

### Capacity And Identity

The current support and acceptance scale is **20 distinct users participating
in realtime activity per room**, with multiple rooms on one site. Browser and
App endpoints belonging to the same user do not represent two people. This is
not a new hard person-count admission rule: routing candidates, automatic relay
selection and file-source recovery keep their existing owners. Pure conversation
does not require a peer route. Future scale increases extend the same model and
its resource acceptance rather than adding another room or participant type.

Physical endpoints retain a separate finite resource budget. It must accommodate
the accepted multi-room scale, including App endpoints and explicit Server
hosting. Relay fanout remains an independent forwarding preference, not a site
or room headcount. The [room-data model](./channel-storage-and-identity.md#identity-and-profile-reading)
owns retained identity and bounded profile reads; historical users do not consume
live connection capacity. The [runtime reference](../../prototype/channel-server/README.md)
owns current resource values and explicit capacity checks.

## Forwarding Architecture

The architecture is **Channel → Room → Activity / 频道 → 房间 → 业务**.
One channel graph holds peer connections. Each room uses its authorized subgraph,
and each source uses paths within that subgraph for its actual recipients.
The [forwarding plan](./channel-forwarding-plan.md) defines peer transport eligibility, grants, budgets and validation.

## Routing Foundation

The following sections describe the current planners within that architecture.
The room projects source and receiver demand before a path exists. The channel
admits the first pair on an empty graph and returns confirmed edges to the room.
TransportBook owns physical attempts
and confirmation. Each activity selects parents for its own receivers.

### Choice And Cost

Activities can share a physical edge while using different parents on a cyclic
graph. Upload follows the selected branches and their payloads.

### Room Bootstrap And Activity Paths

Screen helper intent identifies the upstream receiver for assisted viewing. Voice
subscriptions, attachment requests and byte-provider requests likewise identify
endpoints before delivery starts. Channel discovery reconciles requests with
current room grants and endpoint generations.
| Traffic | Route and lifecycle |
| --- | --- |
| Room commands and conversation | The domain WebSocket carries commands to the current room host and signed replies to authorized recipients. The room host authorizes and confirms the operation. |
| Voice | Each speaker selects parents for authorized listeners on confirmed edges. |
| File and forwarded webpage bytes | Each distribution selects its own parents from the holder or byte provider. [Room-data model](./channel-storage-and-identity.md#shared-delivery-on-existing-room-paths) |
| Screen picture and source audio | One distribution plan per publication: start on usable existing paths, then improve affected branches while preserving selected viewers and necessary relays. |

Files use ordered, fully reliable DataChannels; voice uses WebRTC media tracks.
SCTP over DTLS over ICE/UDP supplies file retransmission without a TCP file
connection. Under BUNDLE, media and data can share a compatible pair's selected
ICE transport ([RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html#section-1)).
An extra logical channel needs no exposed file port; this is per-connection
reuse, not one global UDP socket for the room.

Web delivery and HTTPS/WSS signaling retain their existing control transport;
UDP-only refers to the selected peer media/data path, not every service in Piik.
Receivers do not get their own microphone back. Muting local listening does not
discard an admitted downstream flow; authorized forwarding need not activate
the local microphone or loudspeaker.

File delivery requires content verification; each relay owns forwarding, finite
buffers and cancellation without saving a complete copy. Use negotiated message limits,
bufferedAmount and bufferedamountlow under the
[WebRTC DataChannel API](https://www.w3.org/TR/webrtc/#rtcdatachannel).
Alternative paths and holders permit repair, not automatic room-owner takeover.

### Synchronized Video Sources

The Browser source choice includes screen capture and synchronized video viewing.
Each viewer loads the media source independently. A temporary room activity owns
the source URL, sharer session, viewers and current playback anchor; it uses the
existing room-command and snapshot path. It creates no media flow or encoder.
Only the sharer changes common play, pause, position and speed. Viewers own their
local sound and viewing participation. Room access and session retirement govern
the activity, and room history does not persist live playback.
The room derives the audience from joined watch subscriptions across all delivery
modes. Participant lists and audience counts express that intent, independently
of peer paths or decoded-frame readiness; multiple endpoints display one person.

The sharer's anchor records position $p_0$ in seconds, domain time $t_0$ in
milliseconds, playback rate $v$ and whether playback is advancing ($b=1$)
or paused ($b=0$). At estimated domain time $t$, the target is

$$
p(t)=p_0+b\,v\,\max(0,t-t_0)/1000.
$$

A viewer estimates the offset of its local monotonic clock from a join reply.
If the request was sent at local time $a$, the reply arrived at $z$, and it
reported domain time $d$, the viewer uses $t=\mathrm{localNow}+d-(a+z)/2$.
A late or reconnected viewer applies the latest anchor when its player and
clock are ready. For ordinary video, a known duration bounds the target.
Autoplay refusal leaves the viewer a local play action.
[Playback clock](../../src/client/channel/watch-playback.ts)
When the sharer's player waits for data, the room clock pauses at its measured
position. Actual playback resumes the clock. A viewer's local buffering affects
only that viewer. Joining applies the initial position once for a given anchor.
Automatic drift correction waits until its target is locally buffered and the
player can continue playback. An explicit sharer seek may select a new range.

Standard live HLS uses the source's unambiguous Program Date Time as its shared
position coordinate. The activity retains that coordinate after the playlist
ends; ordinary media retains media seconds. Both use the same domain-time anchor.
The source window is separate from local buffers. A viewer unable to load an
expired shared position waits for the sharer to resume or choose Go live, rather
than inventing its own target. The Piik HLS player owns these controls; a generic
original webpage's local time cannot represent this program coordinate.
Native live forwarding returns a complete playlist in one existing 64 KiB read,
refreshes on player demand, and retires removed resources after their HLS grace.
Missing or ambiguous PDT, larger live playlists and low-latency HLS extensions
remain unsupported. Native-only HLS creation requires an inspected ended media
playlist; an opaque or failed inspection retains the original-player/App-forward
choice instead of assuming VOD. Explicit known files and declared ordinary
viewer timelines retain their existing paths.

Preparing another source preserves the current one. Cancellation during
preparation releases only the candidate; submitting the prepared source commits
the replacement. The sharer identifies the prior activity when switching sources.
The room validates the replacement and retains its subscribed viewers' pending
handoffs in their session activity. Ordinary snapshots carry the original source
and current successor across reconnection and consecutive replacements. Joining
the successor, explicitly leaving, losing room access or retiring the session
clears that intent. The Browser owns local playback and receiving-method choice;
the successor requires ordinary room authorization. Old byte grants, media and
input permission are not transferred.
Native capture retirement uses the App's current capture lease and releases it
after room confirmation; a refusal preserves that capture. Ordinary stop remains
immediate and prevents a pending confirmation from restoring the player.

A viewer's selected stage window can outlive its media. When a source stops,
the window retains its title and sharer while playback resources retire.
Explicitly closing the window or losing room access ends this local selection.
Browsing another room preserves it. A confirmed successor reuses that window;
an unrelated later share does not automatically acquire its audience.

With standard video picture-in-picture, Stage retains the window while the old
player releases its media. It follows an authorized successor after subscription
and video readiness, including in a separate same-origin window. A retained
waiting card keeps an empty picture-in-picture window; dismissing that card,
closing picture-in-picture or losing room access ends it. The page card supplies
the waiting message. Native video picture-in-picture itself remains blank until
the next video is ready.

When a confirmed successor has no Browser-playable source, its viewer retains
ordinary participation while choosing a player or awaiting an offered source.
A previously selected peer route, or the sole playable route on a Browser-only
endpoint, can resume when the sharer offers a new byte source. Failure of an
available direct URL still leaves the receiving-method choice to the viewer.
Leaving or losing room access retires the waiting intent.

For explicit MP4, WebM and Ogg video links the Browser's own player verifies
playability. HLS uses a supported playlist player and its timeline checks.
Explicit static, unencrypted DASH links use the existing DASH player and the
same media-time playback anchor.
Each viewer fetches the media from its origin. The Native client supplies
the webpage-player connector without a separate browser extension. Website
windows retain their own browsing context and do not inherit Piik device
authority or room credentials. The Windows App can place a selected original
page in its room window. The native page keeps its document, site login and
player. The room surface owns its visible bounds; moving that surface preserves
the document's playback and does not issue a visibility transition. Opening a room dialog or
leaving the stage releases the surface. An external browser uses the App's
separate page window. Browser-only website integration uses a documented
player-control API. A portable media URL can use the direct-media path; webpage
synchronization controls each participant's original player instead of requiring
that URL. Source access stays with each viewer's platform account, while the
existing room authority carries playback state. The
[implementation ledger](../todo.md) distinguishes direct-media delivery from
website-connector work.

The room offers direct playback first. For a source that needs the original
webpage, viewers with a capable App can open that page and select their player.
If the sharer also offers the media bytes, viewers can receive them over the
room route. Browser-only viewers can join that transfer directly. Viewers can
change an available receiving method in the player's settings. If direct
playback fails, Retry reopens the viewer's player for the same activity. Local
volume and mute follow the viewer across the retry. While a viewer chooses a
player on the original webpage, the current player retains its subscription.
The candidate replaces it after media readiness and room confirmation.

For an explicitly selected complete file or HLS source, the App may retain its byte source
and publish the matching media URL in the same activity. Authorized room members
receive that URL in their activity snapshot. The origin controls its expiry and
access; ending the Piik activity does not invalidate an already shared URL. Each viewer tries
that URL independently. A viewer that chooses the offered forwarding path
adds byte demand; other viewers keep loading from the origin. Clearing the
byte source retires those transfers without ending direct playback. A peer
viewer remains joined with an unavailable-source result and can choose another
receiving method or leave. The
media element can load an ordinary cross-origin file even when a script cannot
read its bytes. Manifest-based formats retain their own fetch and timeline rules.

When a discovered media URL loads in the sharer's Browser player, that player
owns playback in the Piik stage. Prepare it before replacing the current share;
retire the discovery page after the room confirms the new activity. Loading
failure keeps the original page available for an explicit original-page choice.
For selected media that needs the Native page's resources, retain that page only as
the resource provider and pause its original player. The Piik player owns common
playback through the same prepared reader; it does not subscribe to its own
room route. Stopping remote forwarding preserves local playback and its reader;
resuming forwarding reuses that resource. Ending the activity or closing its
provider page retires both. Original-page playback remains a separate explicit
choice when a source cannot be prepared in Piik.

An active Host webpage keeps its share action in the window caption. Reopening
the selector borrows that document and its current player; it does not reload
the URL. The page retains one active media selection and at most one candidate.
Candidate discovery, metadata and prepared readers remain separate until room
confirmation. Cancellation releases only that candidate. Committing the exact
candidate resource replaces the active selection and retires its previous reader.
Closing the page retires both selections and their pending reads.

When the sharer's original-page document or selected player disappears, its
window and the room's watching intent remain. Playback pauses using the last
sample and existing clock, and the previous media-byte grant is withdrawn.
Selecting the next video uses the ordinary source-replacement handoff with the
address of that video's containing Native webpage.
Stopping the share or closing its selected or last webpage window ends the
activity. Other windows in the group close independently.

The original webpage address and offered media bytes are independent. A webpage
without a navigable address can still forward its prepared video. The original-page
action is available only when that candidate has an address a viewer can open.

The shared Web UI can use the official embedded player for supported YouTube links
and single public on-demand videos on peertube.tv. Each participant checks PeerTube's
public video metadata before opening the player. The room carries its canonical embed
URL in the existing website source. Older Web clients can show the activity and offer
their existing App webpage workflow.
A visible candidate must play before the sharer confirms it. Its existing
player then moves into the stage. Room authority confirms the activity before
presentation completes, so a later display failure does not restore an earlier
activity. Personal volume and source access remain with each player's platform
controls. Unknown buffering stays unknown; explicit playback anchors and local
resumption use the shared clock owner. Hidden players pause locally, and Stage
focus selects the single eligible embedded player for scripted playback.

Prefer Native source discovery with ordinary Browser viewing. An independently
usable media URL or source-issued media grant permits each viewer to fetch from
the origin; observing a successful request in the sharer's account is not proof
of that capability. Account sessions remain with their original player context.
The sharer may explicitly enable forwarding of readable media bytes to Browser
viewers. This consumes upload capacity and uses the activity's authorized paths and
reliable DataChannels. Only the byte provider and its receivers add peer demand;
origin playback continues to need only signaling. The activity retains its
Browser control owner while the selected Native provider owns resource reads.
Reads of observed webpage resources retain the successful request's final URL,
Referer and User-Agent within that origin. A subsequent redirect to another
origin makes that resource unavailable.
Resource access and retirement follow that activity, and expose admitted
resources rather than an arbitrary URL proxy. This streaming consumer retains
its own resource semantics; it does not replace attachment hashes or persist
media in chat history. Encrypted media still requires the receiving player's
valid license.

For clear static DASH, the approved Native page owns an immutable manifest
catalog and opaque video/audio choices. The source selects complete logical
tracks; the parser resolves only those tracks into the existing reader's admitted
resources. Original URLs and request credentials remain Native-owned. The Browser's
DASH player reads the selected manifest and media through those resource IDs and
owns container/MSE playback. Selection does not promise decoder support or grant
access to another source. Dynamic, protected and externally expanded manifests
remain unsupported. The [pure parser module](../../prototype/channel-mpd/README.md)
owns its dependency, generation and resource-budget contract.

### Screen Demand Uses Reachable Paths

Viewers are a publication's destinations, not the complete set of eligible relays.
Start with usable established paths and project source-to-viewer demand onto them.
Retain the intermediate nodes needed by selected receivers and prune branches whose downstream demand has ended.
Stopping local playback removes local viewing demand, not an admitted forwarding
duty. A relay receives the needed stream without presenting it locally; Browser
relaying can still require decode/re-encode work.

Do not add a shortest-path optimizer above the existing router or derive an edge
from a pair of nicknames on a diagram. A reachable A-B and B-C do not prove A-C.
New candidates follow the same availability/direct-convergence rules, ICE checks,
source-path admission, capacity reservation and commit proof. A healthy route stays
until an admitted replacement is proved. Optional optimization without overlap
capacity waits or stops; it cannot interrupt working playback.
Viewing changes alone do not trigger a global rewire or remove a needed bridge.

The room's routing controller shares connection facts, admission and repair
across voice, file and screen plans. Flow-specific replacement/completion
does not create another probing or reconnection subsystem; one picture's ICE
timeout must not block another picture or chat. The sharer owns capture and
demand; the controller selects distribution.

Every authorized, capable participant with capacity may relay without receiving
every publication. [LiveKit's publication/subscription model](https://docs.livekit.io/transport/media/subscribe/)
illustrates metadata without bytes. On A-B-C-D, a picture watched only by B needs
only A-B; a viewer at D also needs non-viewing C. A file distribution chooses its own path to interested recipients. A shorter screen candidate must prove reachability,
source supply and actual capacity; a control link alone is insufficient.
Different publications can share a physical pair. Stopping one removes only its
work, preserving unrelated calls, transfers and connection leases.

Playback buffering is a page-local preference, remembered for the Browser origin.
Automatic leaves the receiver target unset; a custom 0..4000 ms target applies
to every received screen and its source audio, including candidate and relay
inputs. Room voice keeps the automatic target, including an audio receiver reused
after screen playback. Browser relays re-encode their received tracks, so their
buffer target can also delay descendants. This preference neither changes routing
nor creates a separate frame queue. Unsupported receivers retain automatic behavior;
the [fidelity assessment](./media-fidelity.md#playback-buffering) owns the measured
smoothness/delay tradeoff and its limits.

### Idle Room Peers for Delivery Recovery

After a direct connection fails, waiting screen, voice, file or forwarded webpage
byte deliveries can use an authorized peer browsing the same room, even when
that peer is only reading chat. Connection settings explain
the upload cost. Assistance is on by default and can be switched off. Peers
present only in the lobby or another room may assist discovery and connection
setup through the site's existing signaling permissions.

Each endpoint's room limit counts outgoing deliveries on behalf of others
across screen publications, including deliveries being prepared. Zero disables
that assistance. Each viewer has one selected input per publication. A
replacement may receive frames within the same forwarding budget to prove it
can take over before the old input is released.

Temporary disconnection is an endpoint's current-socket observation; it does not
erase the pair's earlier bilateral confirmation. The room can prepare an
already confirmed alternate through the existing branch-switch owner. Recovery
uses fresh decoded or forwarding proof and checks every candidate edge before
commit. If the original path recovers first, its usable branch stays selected.
An independent candidate can survive terminal loss of the old ancestor while
retaining its input identities and original deadline. Native distinguishes
recoverable disconnection from expired send consent using the SDK's own state
and wakeups; remote input stops on disconnection.

### App-Assisted Viewing

A Browser may attach its currently approved App's live endpoint to its own
screen subscription. The existing App hosting description supplies that endpoint;
do not infer it from a same-user participant list. The room validates that the
helper is an admitted endpoint of the same user with room access. The Browser
remains the real viewer and supplies decoded and presentation proof; the App
receives and forwards without adding a fictitious watch or reading activity.
Watching does not wait for App admission; assistance can attach when ready.
Before subscribing to a source that may be local, the approved App reports its
exact current or retained Native endpoint, or its absence, independently of
admission. That source-location fact suppresses local preview sound and does
not grant capture ownership or helper eligibility.

For that publication, the Browser becomes a presentation leaf. Replacing
`parent → Browser → children` with `parent → App → {Browser, children}` uses the
same prepared branch operation, retaining old playback until affected viewers
prove the replacement. The exact App-to-Browser presentation edge does not
consume WAN fanout; its PeerConnection, media output and overlap resources still
use normal admission. Same-user endpoints alone do not qualify for this exception.
Native capture preview follows this same presentation-edge rule.

The association belongs to the Browser's live watch. Unwatch, access removal or
session expiry removes it. Losing App control clears the helper while retaining
ordinary viewing when domain signaling is writable; otherwise the existing
authority-recovery window applies. Necessary transit for other viewers and App
room hosting retain their own lifetimes. Failed assistance keeps healthy playback
and uses the existing candidate-failure memory, rather than a second retry loop.

### Site Forwarding Assistance

A Server operator may offer its existing Native endpoint for forwarding; the
capability is disabled by default. One switch offers screen, voice and files
together, and the operator can turn each kind off. A room uses the offer unless
its owner declines it through the saved room setting `allowServiceRelay`, using
the ordinary policy update and commit boundary. New rooms, including copies,
start with it allowed; whole-room backups retain the saved choice.

The service ranks after every participant path when a route is assigned: the
routing owner assigns it a receiver only when no participant path can serve
that receiver then. A scarce output goes to the service only when that serves
more receivers in total. A receiver already served through the service keeps
that route until it fails or demand ends, even if a participant path appears
later; a screen viewer can still take the direct path from its source that any
relayed viewer can take. The service does not replace a healthy P2P path, and
the domain rejects a projection that gives the service a kind its operator has
not offered. The domain registers only its own Native's current authenticated
session and connection;
room plans bind service work to that exact live connection. Reconnection retires
old leases and derives fresh ones from the saved choice and current availability.
Disabling the service withdraws its work without clearing room preferences;
disabling a room's preference withdraws only that room's optional service work.

Forwarding grants only the assigned media and byte routes, not room management,
conversation subscriptions or history access. Public-room Read alone does not
make the service an ordinary relay candidate when assistance is disabled. An
actual room host or explicitly active participant retains its normal duties.
Pure service forwarding is shown as a site node in connection details, not as
another person in the room. Current availability, saved permission and assigned
leases remain distinct facts; none proves that a viewer can reach the UDP listener.

The same activity plans, connection leases and resource bounds govern service
forwarding. No additional route planner, media socket graph or room identity is
created. A reachable HTTP site or tunnel does not establish media connectivity;
the Server's configured UDP entry must also be reachable.

### Start On Existing Paths, Then Converge

A confirmed pair can carry either admitted direction. Each activity selects its own sending branches.
Managers set the room's default fanout from one to twenty, initially two.
Endpoints may set a positive override, including hosts and sources. Zero declines forwarding
for others but retains the room default for originating media and required hosting
branches. A helper's local display edge has its own role. Endpoint forwarding contributions apply across rooms.

Room settings control the default fanout. Sharing settings can override it for
the current screen's source. Raising the limit makes capacity available to waiting
viewers while preserving healthy branches. Each webpage or linked App sets
its contribution to other people's traffic in the channel's forwarding settings.
[Publication and contribution limits](./channel-forwarding-plan.md#contribution-budget)

A change to the room default or a screen publisher's direct limit uses one bounded
transition for each affected screen. Only branches the sender still authorizes
can carry media during that transition. Screen replacement retains forwarding,
decoded and presentation proof. Other activities select their own admitted
parents when demand, capacity or confirmed connectivity changes.

1. A new viewer first attaches to a usable existing publication branch or an
   admitted source-to-viewer path on confirmed room edges, installing only its missing
   suffix on ready room paths. Prove picture readiness; an open control
   DataChannel is not a decoded frame.
2. While that path plays, the same availability/direct-convergence/quality owner
   may prepare a bounded alternative parent or branch using room-wide eligible
   peers; there is no separate fallback or shortest-path router.
3. Reserve the actual overlap resources, prepare the candidate, and require its
   media proof and the applicable non-regression evidence before committing.
   Replace one affected branch, then release only its old media work. The player
   renders one committed input; source sound switches with its picture.
4. Keep the shared connections needed by voice, files or other
   publications. They remain available to attempt media recovery, but do not
   continuously carry a second copy of an already-converged picture.

Both stages belong to one publication. A viewer stays connecting until its selected path proves delivery.

Reconcile on relevant demand, connectivity or capacity changes. A new viewer adds
a branch; stopping viewing removes only demand that no downstream still needs;
a departed relay repairs only affected paths. Preserve healthy unrelated branches.
Each admitted session gets one direct attempt per publication. Viewing toggles
and unrelated membership updates must not reset spent candidate opportunities.
Once useful attempts finish, the present runtime keeps the working route: it
reconciles on events and does not probe periodically. This describes current
behaviour and not the intent. The [canon](../canon.md#media-and-network) asks
that the topology keep improving quietly, and how it does so is undecided in
[ADR-0018](../adr/0018-quiet-topology-improvement.md).
A physical failure wakes the affected plans. Healthy independent branches keep their flows while room authority remains valid.

Availability work takes priority over optional optimization. Without overlap
capacity, leave healthy playback in place and defer or finish the optional
attempt. A bounded-gap change belongs only to necessary availability repair,
under the forwarding model's rules for [changing a working path](./channel-forwarding-plan.md#improving-a-working-path).
Source generation, current route and operation identity fence late callbacks;
new work cannot inherit completion from a retired candidate.

Screen preparation also has a finite lifetime when its shared connection is already
connected. Each publication waits on one unproved frontier edge whose parent has
the source; downstream nodes waiting for that parent are not blamed for missing
frames. Reconciliation does not extend the current wait. Expiry retires that
media attempt through the same plan, preserving unrelated flows and shared pairs.
Lower candidate quality keeps the change uncommitted under that same deadline;
it is not evidence that the media path has failed. Transport, track and render
failure retain their existing immediate retirement paths.
The room owns the deadline and the domain's existing clock wakes a remote room
only when it is due; Browser and Native hosting do not add separate routing timers.

A publication prepares one alternative branch, including its transit nodes.
First-picture viewers need decoded proof; pure transit proves forwarding, not
decoding. Existing viewers keep their decoded input while the candidate passes
shared quality comparison and supplies a prewarmed player frame. Selection retains
prepared inputs/outputs before retiring old leases. Source sound, volume, pause
and container fullscreen follow player handover; native element fullscreen defers it.
Preparation/switching share one fixed finite operation. Each viewing leg keeps
its own current quality evidence; fresh samples can renew that evidence without
extending the operation. Commit requires all affected viewers' evidence to be
fresh. A new decoded-only report withdraws that leg's switching permission.
Failure or changed viewing demand cancels the candidate while preserving required
old paths.

### One Owner For Actual Connections

A participant's transport runtime owns its PeerConnections, negotiation, ICE
recovery and final close. Activity plans request admitted flows;
they cannot independently close or mutate a connection another flow still uses.
The transport publishes remote track changes after applying the complete remote
description. Temporary remove/add events inside that operation are not a failed
media input. Stream ownership includes the actual object as well as its signaled ID.
The combined physical graph may contain cycles while each forwarding plan
remains acyclic and each publication has one committed input at a receiver.

Reusable Browser media transceivers retain bidirectional intent, including outputs
with encoding declarations. Removing an outgoing source must leave the carrier
able to receive its replacement; the standard
[track-removal semantics](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-removetrack)
preserve reception from `sendrecv`, while `sendonly` becomes `inactive`.

Reuse is conditional on the same domain, compatible peer/session/authority
identity and capacity. Do not share transports across unrelated domains.
Reusing code is not one global operation queue: serialize changes to a physical
connection, but let independent room/publication operations progress independently.
Source replacement keeps its publication and changes its source generation;
callbacks, input grants and reservations retain their original ownership.

The room runtime gives each publication's directed media work its own live
identity and exact input. Both stay stable while the work remains needed,
including non-viewing transit. Replacing its input creates new downstream work
even on the same physical connection. A prepared branch keeps those identities
when selected, so its senders and players can adopt the already-proven media.
Transport aggregation, proof and cleanup retain the same ownership; a retired
callback cannot act on its successor.

A site has no fixed media allowance divided among rooms. The participant
runtime counts its actual connections, forwarded copies, encoders/decoders and
transition overlap. Watching more pictures creates real additional work; being
present alone does not allocate a fraction of an invented room-wide bitrate pool.
One edge can carry several voices or pictures, so an edge-count cap alone is not
a bound on bytes or encoding work. Admission accounts for the actual flows on it.

File transfer and realtime traffic compete for real resources even when assigned
different DataChannels or PeerConnections. Apply bounded file concurrency and
backpressure, and use existing WebRTC priority controls where supported. Leave
congestion control to the transport. [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html#section-5)
explains shared SCTP congestion, while [RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html#section-4)
describes media/data prioritization.

Browser media relays decode received tracks; eligible ordinary outputs reuse
node-local encoding groups under [ADR-0014](../adr/0014-browser-node-local-encoding-pool.md).
Forwarding owns input consumption until its last output retires, independently
of local watching. Do not budget Browser relays as packet-only SFUs. The
[WebRTC relay sample](https://webrtc.github.io/samples/src/content/peerconnection/multiple-relay/)
demonstrates forwarding, not unlimited inexpensive multi-hop video.
Keep paths short and validate simultaneous voice/video/file work on actual endpoints.

### Reachability And Repair

A user needs an authorized path for the activity, not a direct connection to
every other user. Joining or repairing a tree uses mature ICE/STUN handling and
the existing bounded retry principles. Reuse reachable participants as relays;
do not add an all-pairs probe, full mesh or periodic topology rebalance.
The room can propose a missing connection across an activity's directed paths
even when the physical graph is connected. The channel owns its admission and
retention under the [forwarding procedure](./channel-forwarding-plan.md#version-boundary).
With unchanged endpoint signaling generations, a failed required physical pair
becomes eligible again after the channel's five-second cooldown. The room's
five-second repair wake reconsiders publication-local media refusals while
retaining healthy branches and running screen-operation deadlines. A media
refusal belongs to the physical edge that produced it; replacement of that edge
permits a new media attempt. Required leases on a retired physical pair receive
a new pair identity.
Each admitted physical pair acquires its connection resources once. Terminal
failure releases those resources; if signaling is interrupted, the still-current
lease reports that failure when signaling resumes instead of recreating the pair.
A complete path on confirmed edges
can replace an unproved screen fallback; proved media branches remain installed.
Confirmed physical-pair failure informs both directions in every affected plan,
including candidates first tried by another activity. A publication's media
failure remains local to that publication. Optional
and idle failures do not schedule retries. A prepared replacement has its own
physical ID and twenty-second deadline.
An affected watch retains the selected path's delivery failure while replacement
paths prepare; only current decoded proof clears it. Unwatch, source replacement
or publication retirement ends that result. Optional trial failure preserves the
healthy incumbent, and only the authorized watching session receives the result.
Required-path retries reopen exhausted choices while preserving other active
connection attempts and their leases. Each attempt retains its transport-owned
deadline; another path's repair wake does not restart or cancel it.

App Local discovers addresses through Binding-only STUN on its selected LAN
interface, without contacting public STUN services. That listener belongs to
the local domain's lifetime; Browser and Native participants receive the same
discovery configuration. Public invitations and approved external sites retain
their domain's configured ICE servers. An individual rejected ICE candidate is
disposable input: it does not retire the connection or its other candidate paths,
and transport state and the operation's deadline own failure. A Browser
lifecycle error, such as a missing description, still fails that operation.
Ordinary Native peers gather IPv4 and IPv6 through the same RTC transport owner;
an unavailable address family does not disable the other. Wildcard listeners
exclude loopback interfaces from ICE/STUN discovery. Explicit loopback listeners
remain available for a configured local forwarding backend.
Selected-path send errors trigger a local source-address bind check on the
existing transport observation cycle. An address-unavailable result retires that
physical pair through the normal failure path. Successful sends and selected-path
changes clear obsolete errors.
Candidate probes and other pairs retain their own lifetimes.

An ordinary Native connection with exclusive sockets may send Browser peers one
batch of at most 16 typed linear candidate hypotheses from three existing STUN
observations on the same IPv4 base. Discovery stays concurrent; no socket or
probe is added. Native emission and Browser admission stop after their initial
five-second window or connection, and retain the current ICE generation. Ordinary
candidates and IPv6 continue through the SDK. Native receivers ignore these
hypotheses; fixed Server listeners and coordinated Native preparation do not
generate them. The limit bounds added targets, not the SDK's connectivity checks.

The coordinated UDP candidate keeps preparation inside one authorized physical
pair attempt. The domain's existing transport book issues its replacement UUID;
logical room/media leases and operation deadlines stay unchanged. Only currently
capable Native endpoints participate. The prepared socket transfers to the ordinary
PC after mutual completion, with no competing reader or separate route graph.
When the local survey is stable and the remote survey is sequential, the retained
socket alternates between two predicted targets. Authenticated traffic fixes one
target before replies; both peers complete within the preparation's shared limits.
One stable and one irregular observation can instead use random-port preparation:
the irregular side opens 256 sockets toward the stable side's retained tuple;
the stable side checks 1,024 distinct ports on the authorized peer address, each
once. Each endpoint permits at most 1,032 requests and 16 replies,
at a mean of one send per 2 ms, within the same five-second preparation lifetime.
At most two random preparations run per process across all sites and Drivers.
The [matched budget control](./nat-traversal.md#random-mapping-collision-control)
compares coverage and traffic under this unchanged lifetime.
Capacity refusal does not queue work or extend the deadline; a pair-scoped refusal
ends the other endpoint's preparation and both continue ordinary ICE. Other
irregular combinations retain ordinary ICE. Observations are sampling facts, not
guarantees about all destinations or a claimed NAT classification.

Server shares fixed UDP listeners across its peer connections. Piik's
[socket owner](../../prototype/channel-native/src/peer/transport.rs) dispatches
packets through str0m's public `Rtc::accepts` and `handle_input` interfaces;
the SDK owns ICE and media demultiplexing.
Desktop wildcard candidate discovery reads a runtime-owned netwatch monitor.
New pairs share its lazy initialization and current interface snapshot.
Concrete socket bindings need no interface scan. Android enumerates interfaces
when acquiring a wildcard-bound pair because its netwatch backend does not
provide interface-change notifications.
While desktop ICE is still finding its first path, a newly usable IPv6 address
can become a candidate on the same wildcard socket and transport instance.
The existing candidate bound applies. First-path selection stops this observer;
retirement cancels it and waits for its task, including queued updates.
The Server entry binds both address families on the actual HTTP port by default,
before opening domain data. Configured listeners must all bind successfully;
IPv6 sockets are v6-only so both families can use that port. Local binding and an
optional public IP/port mapping are separate facts. An FRP backend on loopback
requires an explicit loopback bind; wildcard enumeration advertises real interfaces.
Candidate availability is evaluated across the bound listeners: a family without
an advertisable address does not invalidate another family's usable candidates.
The service owns these sockets until its peer connections retire. Ordinary Native
pairs marked `Available` share an IPv4 socket within their current endpoint
runtime. Coordinated preparation and linear probes retain their exclusive
sockets. A shared Server listener does not advertise preparation capability.

Native maps its actual default-gateway IPv4 socket using the
[portmapper client](../../prototype/channel-native/README.md#rtc-dependency). Its
background probe, protocol selection and renewal stay with that library;
mapping does not delay ICE or replace IPv6 and STUN candidates. Mapped addresses
use the existing candidate signaling. Shared sockets have one mapping producer;
each connection accepts only mappings for its admitted local address. The last
socket user retires the reader and mapping. Exclusive pair retirement cancels its
address producer before waiting for unrelated delivery queues. Both paths join
the watcher and request best-effort deactivation through the library lifecycle.

Prepare a replacement, prove it usable, commit, then release old work. The Channel wire exposes room topology as sessionIds and pairs. Each activity
selects its parents, so RoomDelivery needs no shared nextHops. RoomDataState
reports whether the authorized room data lane is healthy. Voice retains its own media proof.
Channel negotiation can arrive before the local room projection. The physical
pair may retain its bounded incoming channel slots while inactive; a valid room
lease still gates data delivery, sending and room data readiness. Repeated empty
projections do not retire those slots. Removing the last actual lease cancels
its work; physical closure also clears channels received after a prior failure.
Silent voice uses transport/forwarding readiness rather than waiting for audible
speech. Picture availability requires
a decoded frame. Shared link failure reconciles all affected flows through the
same transport owner. Retiring room-data work ends its queued and waiting sends
while preserving the pair's picture and input work. A new room-data lease may
acquire fresh channels on that same pair. Temporary ICE disconnection retains its Pair; confirmed
failure retires it and allows the room to establish a replacement. Signaling
resynchronization replays current connection, room data and media facts alongside
unfinished negotiation. A local report does not confirm that the room received
it. Use these existing events; add no periodic probe protocol.

A tree cannot connect two groups when no permitted, reachable edge joins them.
An available participant relay or an accepted external fallback is needed in that
case; changing the graph algorithm cannot manufacture connectivity.
The App P2P mode therefore retains initial signaling/rendezvous and connectivity
helpers without requiring a separately rented media server.
[WebRTC transport requirements](https://www.rfc-editor.org/rfc/rfc8835.html#section-3.4)
distinguish direct connectivity from relay support. A successful public webpage
request does not prove a WebRTC media path.

## Activity And Lifecycle

Browsing, voice, shares and watches have independent lifetimes. The main picture
area follows the browsed room; other rooms' activities continue in the activity
strip with return and explicit stop actions. Navigation changes presentation,
not microphone targets, hosting or admitted activity/transfer/forwarding leases.

Joining voice can be listen-only; opening a room never grants microphone capture.
Each authorized screen view includes its room-owned audience: actual watch
intent with current delivery readiness. Pure relays are not viewers. Browser
and App endpoints resolve to the same user for presentation; the sharer's own
preview is omitted. A signaling interruption alone does not end a valid watch.
The same room projection supplies the sharer and other authorized viewers;
users without room access receive no audience information.
The source owner and controlled device authorize remote input for a publication,
source generation and controller session. Domain/room administration alone grants
no desktop control. Changing the focused picture never retargets an input grant.

Input follows the committed screen flow back to its source, using a separate
encrypted logical DataChannel on the same peer connection. File readiness keeps
its room data grant scope; input failure does not retire other consumers or affect
domain-carried conversation. A failed route trial preserves current grants, while replacing
the selected flow retires the affected grants and held input. Native input uses
the existing capture-source identity and page-owned capture lifetime. One App
process owns the physical desktop executor across its approved sites; hosting a
room does not extend a closed page's permission to control that desktop.
The domain admits controller registrations against the selected subscription and
delivers their keys only to the source endpoint. Room operators and relays do not
receive them. A lost input channel propagates retirement along the remaining
selected hops without closing media. Transport retirement releases held input;
removing or replacing an authenticated registration also retires its cipher.
The App's global stop returns active sources to explicit approval. Its key is a
Browser preference; the App holds only the current process registration.

| Event | Outcome |
| --- | --- |
| Room owner changes views, minimizes or closes an in-page panel | Keep hosting; visibility is not authority. |
| A Browser page closes | End its personal activities and Browser-hosted rooms; App hosting continues without handoff. |
| A hosting runtime loses domain signaling | Keep its bounded recovery window; expiry pauses its live rooms. |
| A Browser's local App control connection ends | End that connection's Native activities; Browser media and App hosting remain independent. |
| App hosting stops or its process ends | Pause its rooms and release runtime activities/connections; saved data remains. |
| An administration page closes while Server hosts | The explicitly running service continues. |
| A Browser hosting runtime closes or expires, or its owner stops hosting | The room becomes unavailable; saved data remains. No automatic takeover or replacement. |
| A manager removes a room | Retire its activities/bindings under the [room removal scope](./channel-storage-and-identity.md#room-creation-and-removal); other rooms keep leases. |
| The same owner restarts saved room data | Restore identity/history, establish new live sessions; captures and calls require explicit activation. |
| A sharer stops/leaves, or a relay leaves | Retire the stopped publication or repair the departed relay's paths; keep unrelated flows and their transport leases. |
| A file's original sender leaves | Use another admitted online holder; otherwise wait for a source to return. |
| Room access is removed | Stop affected activities/new delivery; downloaded bytes cannot be recalled. |
| Domain authority is lost | Apply bounded recovery, not indefinite use of stale permissions. |

Signaling recovery uses one 20-second deadline. Failure to replace
a socket does not extend its deadline; successful authenticated reconciliation
ends it. Local stop takes effect immediately. One scope's retirement cannot
release another room's healthy source or transport lease.
Within that window the retained room binding still owns existing captures;
temporary unavailability rejects new room operations without retiring that binding.
Physical-connection invalidations belong to this binding until the room host
confirms a covering state. Resume applies them before route reconciliation, so
a replacement connection cannot inherit the retired connection's readiness or
presentation proof. Repeated synchronization consumes each invalidation once;
healthy leases remain, and retiring the binding retires its invalidations.

App sharing uses a page-owned, non-cloneable capture lease from the initial
request; dropping it stops the producer even while signaling reconnects. Native
Driver owns worker completion. Room admission precedes capture, and the first AU
completes startup; Native preview uses an ordinary subscription. Source audio
shares that page lease with separate outputs. WASAPI timestamps and Rust Opus use
the video's source-time mapping; silence does not block picture startup, and audio
failure retires only audio outputs. Stereo receive negotiation stays with the
transport, including retained connections that change SDP roles.

An unfinished SDP exchange belongs to its physical connection. On resume,
retransmit its original offer or cached answer with the same exchange identity;
an answer from an older exchange cannot complete a newer one. Keep that protocol
exchange separate from current publication authority: retransmission may remove
revoked track bindings, but never insert a new binding into an old description.
Finish the pending exchange, then let normal WebRTC negotiation apply current
senders. A unilateral rollback is not a synchronization protocol: the other
endpoint may already have accepted the offer. The
[WebRTC negotiation model](https://www.w3.org/TR/webrtc/#session-negotiation-model)
owns sender updates; [RFC 3264](https://www.rfc-editor.org/rfc/rfc3264.html#section-6)
defines an answer's independent SDP origin/version.

## Implementation Boundary

Browser/WASM and Native/SQLite adapters execute the shared room core. The domain
projects their authorized summaries; a failed directory save cannot undo a room
policy commit. An OS file lock excludes simultaneous writers of a saved room.
The [Server/App composition](../../prototype/channel-server/README.md) and
[Native participant](../../prototype/channel-native/README.md) own runtime setup;
the [engineering map](../standards/engineering.md#module-map) owns module boundaries.
Platform FFI stays narrow: a Rust wrapper does not make foreign code memory-safe
([safe abstractions](https://doc.rust-lang.org/book/ch20-01-unsafe-rust.html)).
[Versioning](../standards/versioning.md) owns public major-version upgrades and
matched-protocol guidance, separately from replacing private test contracts.

App control authenticates the Browser account against domain admission before
opening its Native room data. Approval trusts that exact Site's code to use App
features, including controlling webpage players and reading or forwarding media
available to their signed-in accounts. Player choices are actions in the Site's
UI, not a separate per-page Native permission. The local approval and webpage
entry explain this scope; bookmarking or opening a Site does not grant it.
Approval grants one exact Web origin its own namespace; revocation stops that
site's hosting without deleting data or affecting other sites. A replacement
external origin needs approval and does not inherit
the previous origin's data. The App's own domain keeps its identity and namespace
across port or invitation-address changes. URLs provide discovery, never App
permission. Browser activities and existing hosted rooms retain their own endpoints
and storage, as defined by [activity and lifecycle](#activity-and-lifecycle).

### Transport And Encoded Supply

The Native [transport pump](../../prototype/channel-native/src/peer/transport.rs)
drives str0m socket input and deadlines through public APIs. The SDK owns ICE,
DTLS/SRTP, SCTP, congestion control, probing, pacing and retransmission; Driver/Core
retain room/flow authority. STUN/TURN use that same socket owner. Exact pins and
upstream-removal boundaries belong to the [Native dependency owner](../../prototype/channel-native/README.md#rtc-dependency).
Piik owns complete-access-unit assembly/admission, encoder demand and source-time
mapping; public depacketizers do not supply those application semantics.

One SDK GCC target budgets the physical connection. Allocate before encoders using
its [built-in BWE](https://github.com/algesten/str0m/blob/5f2183ce7c67117cd1960dfeb11bed11fc188b66/docs/BWE.md),
without a second congestion controller. Source configuration ceilings, measured
supply cost and current allocation are separate facts; unknown received ceilings
remain unbounded rather than becoming guessed rates. Selected demand precedes
optional flows after other RTP, and a trial's picture and sound are admitted
together; unknown cost waits on the existing Driver tick. Pending selected video
reserves capacity; an initial estimate does not prove measured capacity.
Selected original supply sets minimum transmit demand
within the SDK estimate, overuse suppresses padding, and idle/withdrawn supply
contributes none. Desired capacity uses local configuration or the publication's
video intent and preferred original supply, independently of the current grant.
Input bitrate does not establish the cost of a converted representation; any
unresolved source demand keeps the connection target unknown. These targets
do not become media ceilings. An unfittable trial retires
its outputs without retiring selected media or the connection. A rejected
companion-audio output retries when its source or flow changes; retiring an
unrelated connection does not change that rejection.

A producer reconciles only its own actual output demand. It reuses a warm baseline
at full demand and independently encodes constrained outputs; zero allocation
pauses the output. Restoration adopts a newer baseline keyframe before retiring
the constrained encoder. An unused baseline rests on its bounded AU queue.
`Original`/`Limited` identify feed reuse, not delivered quality or a permanent
outgoing RID geometry cap. Sources configured by Piik carry the sharer's requested
resolution/FPS/bitrate ceiling and picture preference together as `VideoSettings`.
An externally configured source can omit those settings: its ceiling is unknown,
and derived outputs use the default Balanced preference. Observed input format
and bitrate do not become a fabricated configuration limit.
Browser relay senders and Native derived encodings consume that intent; decoded
format and transport counters are not preference authorities. Quality changes
preserve publication/routes and acknowledge producer plus room acceptance;
rejection restores the still-live producer.

Real-time packet writers remain separate from control turns. Each output owns its
codec mapping, bounded complete-AU queue and sending half of the media section.
Overflow discards unsent AUs and resumes at a keyframe without blocking siblings;
expired fragments never reach a decoder. Retirement ends that flow's unsent and
retransmission state while preserving independent reception. Carrier reuse waits
for acknowledged sender withdrawal, starts fresh RTP state and still needs new
picture proof. Ingress measures opaque RTP once before fanout and deduplicates
primary sequence numbers after RTX repair, retaining first late repairs and
out-of-order packets. Downstream retransmissions belong to each sender.

Capture facts own RTP and Sender Report correlation, independently of
encoding/delivery delay. Video maps capture presentation time to RTP; audio
advances by its producer's sample positions, pairing those RTP timestamps with
actual capture time in Sender Reports. Capture-clock jitter cannot remove PCM
or change a continuous audio block's sample count. Known queue loss preserves
its missing samples; a discontinuity or input replacement establishes a new
input segment. This follows the [RTP sampling-clock contract](https://www.rfc-editor.org/rfc/rfc3550.html#section-5.1).
Metadata without RTP retains the last correlation.
Audio/video have separate source identities. A new incoming source gets a new
sender/SSRC; an encoding change retains capture identity, sender and packetizer,
committing on a newer keyframe. Required lower-rate replacement releases the
incumbent/queued frames immediately but retains last emitted source time;
optional restoration keeps it until the new IDR. Refresh demand lasts until that
keyframe. Small encoding skew uses [source-switch RTP mapping](https://github.com/livekit/livekit/blob/master/pkg/sfu/forwarder.go)
without changing capture/NTP time. Current or required-feed failure is atomic;
optional-upgrade failure preserves the incumbent. Driver consumes latest targets
without queuing intermediate values.

Native encoder workers own the pinned [WebRTC quality policy](../../native/third_party/webrtc-adaptation/README.md)
and apply restrictions locally. Motion changes resolution, balanced uses the
upstream pixel/FPS policy and counters, and detail disables this QP resource while
retaining spatial fitting and [FrameDropper](../../native/third_party/webrtc-frame-dropper/README.md).
Actual encoded bytes/input cadence drive raw-frame dropping; encoded reference
frames remain intact. Missing QP or parser failure supplies no sample, never a
stale value or terminal sharing error. The upstream sampling, smoothing and
recovery hysteresis remain; Piik adds no bitrate tiers or fast-recovery rule.
Returning bitrate alone does not promise immediate upscaling; recovery still
requires qualifying feedback.
Codec quality-versus-speed is not source adaptation, and this port is not the
complete WebRTC resource controller. The [encoder assessment](./webrtc-encoder-pool.md#h264-burst-and-recovery),
policy provenance and [verification status](../verification-status.md) own evidence
and limits.

Decoded FPS and codec rate metadata are startup hints, not source admission
limits. Decoded input uses only an explicit per-encoding max-FPS restriction;
the nominal format hint cannot add another cap. Local capture also applies the
requested FPS ceiling. Both use original input timestamps for admission, and
workers observe the admitted cadence before FrameDropper. The media standard
owns [output presentation time](../standards/media-quality.md#framework-owned-adaptation).
Linux refreshes encoder caps from that observation and uses raw or requested
startup hints until it has a cadence sample. This avoids the first-frame delay
that x264's variable-rate buffering can introduce on a static source. Windows MF keeps
configured media-type FPS and applies [Chromium's bitrate compensation](https://chromium.googlesource.com/chromium/src/+/6ffa76bb4156526eb14d582183f2bd725e3cd262/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc#119)
to the driver property; transport/FrameDropper retain the logical budget. FPS-only
changes use cadence admission rather than restarting the MFT. Neither a nonzero
H264 VUI rate nor its fixed-rate flag proves actual source cadence.

Default Server adaptation is forwarding-only under [ADR-0013](../adr/0013-embedded-node-local-media.md).
[Simulcast](https://www.rfc-editor.org/rfc/rfc8853) encodings are one source/flow,
not extra publications. Each RID maps RTP/SR to one source timeline. Producers
order encodings low to high; measured bitrate decides fit. Session receive
capabilities reach only assigned peers. Received tracks retain readers/clocks
across codec or feed changes. H264 shares complete
AUs between forwarding and a demand-driven platform decoder; derived outputs keep
source presentation/RTP/SR time and retire only their own derivation. Last incoming
demand releases its reader even while metadata remains. Registered capability,
SDP profile/packetization and actual SPS remain distinct. The SDK matches H264
profiles/packetization and the encoded-input boundary checks SPS; [decoder advertisement](https://chromium.googlesource.com/chromium/src/+/c423d38b941d7e282dcfdf1238d942845553b644/third_party/blink/renderer/platform/peerconnection/rtc_video_decoder_factory.cc)
is neither a forwarding ceiling nor decoded-frame proof. Metadata alone cannot
retire a working connection or permanently reject its flow.
H264 representation compatibility and forwarding-only reception follow the
[encoder contract](./webrtc-encoder-pool.md#30-h264-profile-compatibility).

### Capture And Platform Lifetimes

Local capture has no incoming route lease; publication authority supplies its
outputs. Each encoding fits natural source pixels within the request without
upscaling, and owns conversion, bitrate, keyframe requests and a bounded AU queue.
Only unencoded work may be replaced. Failure affects that encoding's outputs;
stopping capture ends its encodings and source sound. Ordinary resize retains
policy counters; replacing the worker starts fresh policy/parser state while
preserving logical feed, source clock, latest bitrate and the independent-AU gate.
A cadence change resets that encoding's rate sample, independently of siblings.

Windows shares owned GPU textures and source time across independent worker
processes. A child copies into private resources before releasing the shared lock
and encoding. Requested settings arrive through `Start`; bitrate retains its existing
command, while QP and automatic restrictions stay local. Cancelled reads retain
pending results. Geometry changes [drain the MFT](https://learn.microsoft.com/en-us/windows/win32/medfound/mft-message-command-drain)
before reconfiguration and resume at a keyframe. WGC/display replacement and
[D3D11 device removal](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_4/nf-d3d11_4-id3d11device4-registerdeviceremovedevent)
retain source time and unrelated audio/routes; affected child resources are joined
before replacement. Failure before usable output preserves the original device
error. The process boundary contains observed driver callbacks after MFT shutdown;
unrelated failures stay terminal without idle retention or shutdown delays.

For Windows H264 in automatic execution mode, an explicit hardware MFT encode
operation failure permits one replacement with the system software encoder after
the failed child has joined. The replacement retains source time and the latest
bitrate, and must supply a fresh SPS and independent frame before delivery.
Software replacement failure ends that encoding. Device removal keeps its
existing recovery owner; successful hardware under load keeps the existing
quality-adaptation policy.

Native Auto prefers available VP8 when the selecting Browser cannot receive H264.
Otherwise it tries hardware H264, then available software VP8 after failed or
timed-out first independent output. Stop the failed encoder before replacement
on the same capture/clock. Sender capability is not preview support. The admitted
codec family stays fixed for source changes/derived outputs; manual unsupported selection fails
before permission. [Fidelity](./media-fidelity.md) owns colour/tone mapping.

macOS maps original ScreenCaptureKit sample time to host time and copies each
image out of its finite pool once. Stop drains callbacks before releasing conversion
resources. VideoToolbox completes current work before geometry/session replacement;
its native input pool and output callbacks cannot authorize overwriting retained
images. Sound/video stops are independent and share the selected-window/application
filter. Linux Portal owns selection, PipeWire permission and revocation; one image
copy supplies independent GStreamer encodings. Segment running time removes codec
offsets, caps negotiate changes and completed-AU feedback precedes the output queue.
Portal closure stops capture and encodings; PulseAudio system sound stays separate.
Android MediaProjection similarly supplies owned immutable snapshots to independent
MediaCodecs; size changes replace only the codec, FPS uses cadence admission.
Playback sound shares projection authorization. Java owns consent/foreground
service/callbacks; Rust owns capture/encoding. Pending permission and first-frame
waits leave App control available, and the same page lease stops pending or active
work. Platform setup and license/dependency details belong to the
[Native reference](../../prototype/channel-native/README.md) and [Android shell](../../mobile/README.md).

### Input And Sound Boundaries

Playback output belongs to the current page. Piik-owned media elements and
audio contexts share one device selection; embedded website players and
independent webpage windows retain system output. Device changes use the
[Audio Output Devices API](https://www.w3.org/TR/audio-output/) and preserve
the previous choice if an active output refuses the change. Retired outputs
cannot change a later selection.

Windows whole-system capture can follow the default render endpoint or bind an
explicit endpoint under the existing capture lease. Explicit endpoint capture
and process exclusion are alternative scopes. An unavailable selected endpoint
ends only source sound; it does not capture another device or stop the picture
and microphone. Local playback-device selection does not change capture scope.

The [remote-control standard](../standards/remote-control.md) owns input grants,
targets and release; the platform input below implements that contract.
Linux input adds a [RemoteDesktop Portal session](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
beside capture. Commit requires the selected monitor, EIS devices and first image;
cancellation closes the candidate and preserves the share. Close a pending
[Portal Request](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html#methods)
before its session, including superseded consent. Presentation requests a handoff
keyframe without replacing the producer/clock. EIS regions map to the selected
monitor; paused/removed devices issue [neutral-state releases](https://libinput.pages.freedesktop.org/libei/interfaces/ei_device/index.html#ei_devicepaused)
without blocking another source. Text follows actual device capability.

The optional [GlobalShortcuts Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)
uses the installed desktop identity. Desktop owns one process binding and closes
pending Request/session on cancellation. Actual system description/changes/closure
report that binding, rather than the Browser's preferred chord. Activation revokes
input through the same executor without stopping capture. Linux prefers Super +
Alt + Fn because GNOME reserves Ctrl + Alt + Fn for virtual terminals.

GNOME's [shortcut backend](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/50.0/src/globalshortcuts.c)
marks cancellation, but its [provider lacks external-dialog cancellation](https://github.com/GNOME/gnome-control-center/blob/50.3/global-shortcuts-provider/cc-global-shortcuts-provider.c),
so cancelled consent can remain visible.
Separately, Mutter's [unstarted-session Stop branch](https://github.com/GNOME/mutter/blob/c28623c8d29c7b61ec744cdfdbec36f5e7faef1c/src/backends/meta-remote-desktop-session.c#L634)
can leave its object open. Piik closes its own Request/session/PipeWire resources
and never starts an unapproved session to evade these upstream limitations.
[Verification status](../verification-status.md#device-evidence-boundary) owns the
runtime boundary; [TODO](../todo.md) owns remaining upstream work.

Room voice plays in the Browser. Native system capture can recapture it even with
headphones; Browser [restrictOwnAudio](https://w3c.github.io/mediacapture-screen-share/#dfn-restrictownaudio)
cannot control Native capture. Windows [process exclusion](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)
excludes the whole Browser tree, including its other sound. App-sink playback
would remove voice from Chromium's [echo reference](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/mediastream/media_stream_audio_processor_options.cc),
while explicit [`all` echo cancellation](https://developer.chrome.com/release-notes/141#echocancellationmode_for_getusermedia)
needs actual device support and can add mic latency. Browser playback remains
the accepted owner; processing the whole Native
mix would change unprocessed source sound. [TODO](../todo.md) owns automatic-exclusion
work; the [Native reference](../../prototype/channel-native/README.md) and
[verification status](../verification-status.md) own platform setup and acceptance.

## Design References

- Published 2.x [projectVoiceFlows](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/server/signal/voice_plan.go)
  supplies the bidirectional, once-per-edge voice-path principle, without importing
  its Host/listening constraints into 3.0.
- [Discord voice-channel text](https://discord.com/blog/text-in-voice-chat-channel-announcement-tiv)
  informs independent conversation and voice participation.
- [Discord multistream](https://support.discord.com/hc/en-us/articles/360045784891-Video-Screenshare-Updates-Multistream-and-More)
  and [LiveKit selective subscriptions](https://docs.livekit.io/transport/media/subscribe/#selective-subscription)
  inform watching only chosen publications.
- [WebRTC DataChannels](https://www.rfc-editor.org/rfc/rfc8831.html) and the
  [WebRTC API](https://www.w3.org/TR/webrtc/) own transport capabilities.
- [Jami file transfer](https://jami.net/swarm-file-transfers/) informs separating
  a file announcement from on-demand bytes and available copies.

These references support the transport and routing boundaries described above.
