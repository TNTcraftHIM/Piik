# Piik 3.0 Channels, Rooms And Networking

Accepted direction updated 2026-11-10. This document owns the isolated 3.0 responsibility
and networking design. The [prototype README](../../prototype/channel-server/README.md)
describes running behavior; [TODO](../todo.md) owns implementation and decisions.
The [2.x routing contract](../standards/routing-transport.md) remains unchanged.

## Accepted Direction

The owner defines the room owner as the user who actually operates the room:
its detailed state, management and distribution belong together. A separate
configurable file-storage service is not wanted. Ordinary URLs and manual
bookmarks remain the entry model; automatic address discovery is not planned.
Both Browser pages and App processes may host rooms. Hosting follows the actual
runtime: closing its Browser page ends Browser hosting; an App-owned room runs
until hosting is stopped or the App process ends. Server remains the explicitly
started service for unattended operation.

Conversation uses the existing domain WebSocket to reach its actual room owner.
Use one room routing owner for media and files: a base tree carries voice,
file bytes and file-pull control. Pictures start on usable existing paths, then converge locally towards
source-rooted delivery through bounded background transitions. All authorized,
capable room peers can be relay candidates; only viewers and necessary transit
nodes receive the picture. Both stages use the same route state and transports.
The owner accepted this routing foundation and durable room records with cached
attachments. The [room-data model](./channel-storage-and-identity.md) owns simple
shared file delivery on those same paths. Browser and Native room owners run the
shared Rust core with local confirmation/storage. Text, history, reactions and
attachment descriptions use domain WebSocket carriage; reading alone needs no
peer connection. TODO owns remaining implementation and platform integration.

## Terminology And Responsibilities

| English | Chinese | Meaning |
| --- | --- | --- |
| User | 用户 | Every participant, including site operators, room owners and sharers. |
| Domain | 站点后台 | The site's identity, room directory and coordination runtime; named `Channel` in code, without a separate entry or invitation layer. |
| Site operator | 站点维护者 | The user operating the site's metadata and backup/restore, without room-wide authority over other users. |
| Room | 房间 | A conversation, history and media scope within a channel. |
| Room owner | 房主 | The user operating that room's state, management and base distribution network. |
| Sharer | 分享者 | The user originating a particular screen, voice publication or file offer. |

Management identities and activities overlap. A room owner can share, watch or
forward, and an ordinary user can publish without becoming the room owner.
A file sender supplies that file; sending never transfers room management to them.
On P2P room paths, a relay is a participating endpoint doing forwarding work,
not a separately deployed relay server. Sending, receiving and forwarding can
coexist on the same user endpoint.

The [activity model](#activity-and-lifecycle) separates personal page activities
from Browser, App and Server hosting lifetimes. Moving a room requires explicit
transfer of its operation and saved state; automatic takeover is not selected.

## Authority And Information Boundaries

| Owner | Its authoritative state and work |
| --- | --- |
| Domain runtime | Domain identity, users, room-to-owner bindings and authorized room-directory summaries; signaling rendezvous and live conversation carriage to the actual room owner. |
| Room runtime, operated by its room owner | Detailed room metadata, room admission and grants, confirmed conversation, file descriptions/available holders, base-tree planning and screen-route scheduling. |
| Participant runtime | Local captures, playback, file copies and the actual peer transports/forwarding work it has admitted. |

The domain directory is a projection of room details. It does not become a
second writer of the room name, private-room policy or history. Opening the site
establishes or restores a personal identity; users may create and manage their own rooms. Room admission permits conversation,
voice, sharing, watching and interactions without additional role groups or
participation switches. Site maintenance permits changing site metadata and
restoring its own data; it does not grant access to other users' private rooms.
Room owners manage their own rooms. Source owners separately consent to remote
input. These scopes use the shared authenticated identity and room-access rules.

Directory visibility and access remain separate. Public rooms admit channel
users; private rooms require their room admission. Hidden private rooms expose
neither directory details nor activity to unauthorized users. A nickname is not
identity, and an invitation establishes admission rather than proving that two
visitors are the same user.

The site has no separate access mode, password or invitation. Public rooms use
ordinary direct links. Private rooms accept their room invitation or password
through their actual host after the normal site connection is established.
An invalid invitation or unavailable room does not retire that site identity.
The local hosting owner retains its bootstrap key and saved credential for
maintenance; visiting the same site does not confer that authority.

The domain directory binds each room to its owner's current authenticated runtime
connection, separately from the owner's persistent user identity. With no runtime,
the room is unavailable. One room has one current runtime binding. Reconnecting
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
working. The domain forwards these envelopes; the room owner decides room actions.
WebRTC leaves the signaling carrier to the application
([W3C connection establishment](https://www.w3.org/TR/webrtc/#introduction-1)).

The room owner needs no separate public URL. The App creates these runtimes
through normal create/join actions; users do not configure a second daemon or
storage server. Peer delivery preserves this authority and recovery path without
adding another permission owner.

When B joins A's domain and creates a room, B's actual Browser or App runtime
operates that room. B needs no new domain, and A's domain service does not take
over its execution or history.

After room admission, the room owner confirms room changes and message order.
Chat, history, message reactions and live room interactions use the existing
domain WebSocket after room admission. This is their normal, single transport,
not a fallback after ICE failure. The domain verifies the sending connection,
current room-host binding and destination admission, then forwards the signed
packet. It neither stores conversation content nor acknowledges a room commit.
The domain operator can see the forwarded text: signatures authenticate content
but do not encrypt it from the carrier. File bytes and file-pull control remain
on the room's peer paths.
Use short-lived session signing keys, bound to admitted sessions and the current
room-host binding through authenticated domain rendezvous. Sign the original
payload bytes with a maintained Ed25519 implementation, verify before parsing,
and resolve the author and permissions from current trusted domain facts. A
carrier cannot substitute its identity or supply its own permission snapshot.
Long-lived admission credentials are not conversation payloads.

Forwarded requests use the same room authorization and storage operations as local
execution. They run in the room owner's existing serialized turn without
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
one explicit protocol version, rejecting incompatible endpoints before admission;
there is no legacy P2P conversation path. File delivery consumes its existing
peer control transport rather than owning conversation. Domain and
room data may reside on different devices; an App may compose both runtimes locally.
The domain's public listener serves its Web UI and signaling; local approval and
App control stay on a separate loopback listener. Local and public entries address
the same domain, but only the local launcher receives its owner bootstrap.
Invitations use the domain's advertised public entry, not the administrator's
loopback address. Stopping that domain leaves unrelated approved sites running.
The App's own domain keeps one local identity and storage namespace independent
of its listener port and temporary public URL. Only its currently bound local
entry receives automatic App access; this does not merge external site approvals.

A user and a live endpoint are different concepts. An App's Native participant
and a Browser page are distinct endpoints of the same authenticated user, with
their own signing identities, transports and activities. One App uses one Native
endpoint for its rooms in a domain; each room retains its own authority and data.
An online hosting endpoint proves availability, not that the person is reading,
watching or participating in voice. Reconnect preserves identity rather than
matching a nickname or treating a shared invitation as a shared user.
Browser bookmarks connect independent domains; they do not introduce federation
or shared authority between those domains.

Peer media forwarding terminates hop encryption at admitted relays. Room access
must cover every relay; this model does not add end-to-end encryption against
those forwarding endpoints.

## Routing Foundation

### Choice And Cost

| Model | Benefit | Cost and choice |
| --- | --- | --- |
| One tree for peer media and file traffic | One stable set of paths; connected members can exchange media and file bytes. | Some pictures incur extra hops. Use established paths as the baseline; a non-viewing relay can still be essential for connectivity. |
| A new distribution plan for every source or transfer | Paths can follow each source's recipients. | Repeats planning for room-wide voice and ordinary files. Keep source-specific demand only where it changes useful forwarding work. |
| Base paths for startup, then selective source-rooted convergence | Reuses room connectivity where media can be admitted; improves affected paths while preserving playback. | Needs distinct viewing/transit demand and temporary transition resources. Selected; both stages use the same admission and transition owner. |

This compares topology and work, not measured performance. A routing root owns
coordination; it need not forward every media byte. Only nodes on an admitted
path incur that path's forwarding work. A star still places that work on its root.

### One Base Tree Per Participating Room

The room owner maintains one committed, bounded tree among admitted room
participants. Its root identifies the coordination owner; data may travel in
both directions. A connected tree already provides a unique path between any
two members. Voice, sharing, watching and active file delivery establish the base
paths they need; reading or writing conversation does not establish peer paths.
The base tree also considers better edges after relevant connectivity or capacity
changes, using the same bounded admission and transition rules as screen plans.
Replacing a base edge preserves its admitted flows until their replacement paths
are ready; an open candidate DataChannel alone does not retire active media work.

| Traffic | Route and lifecycle |
| --- | --- |
| Room commands and conversation | The domain WebSocket carries commands to the actual room owner and signed conversation replies to authorized recipients; the room owns authorization and confirmation. |
| Voice | Project each joined source to its listeners over the base tree's unique paths; send each source at most once over a required directed edge. |
| File bytes and pull control | Use the existing base paths; the [room-data model](./channel-storage-and-identity.md#shared-delivery-on-existing-room-paths) develops shared range delivery and cached-source selection without another topology planner. |
| Screen picture and source audio | One distribution plan per publication: start on usable existing paths, then improve affected branches while preserving selected viewers and necessary relays. |

Files use reliable DataChannels; voice stays on WebRTC media tracks.
Using one tree does not mean putting voice into an ordered file stream.
The data stack is SCTP over DTLS over ICE/UDP. Configure ordered, fully reliable
DataChannels for file delivery; SCTP supplies retransmission without adding a
TCP file connection. Under BUNDLE, data and media can share the selected ICE
transport for a compatible peer
pair, as described in [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html#section-1).
An additional logical DataChannel does not require another exposed file port.
Different peer connections can still use different UDP sockets; this is transport
reuse within a connection, not a promise of one global socket for the room.
Web delivery and HTTPS/WSS signaling retain their existing control transport;
UDP-only refers to the selected peer media/data path, not every service in Piik.
Receivers do not get their own microphone back. Muting local listening does not
discard an admitted downstream flow; authorized forwarding need not activate
the local microphone or loudspeaker.

A file hop needs application-level forwarding, finite buffers, cancellation and
content verification. DataChannel itself joins two endpoints, not a whole tree.
A forwarding node need not save the complete file. Use negotiated message limits,
bufferedAmount and bufferedamountlow for bounded sending under the
[WebRTC DataChannel API](https://www.w3.org/TR/webrtc/#rtcdatachannel).
Participant cooperation distributes transfer load and permits path/source repair
where alternatives exist. Room confirmation and authority still belong to the
room owner; replicated file bytes do not introduce automatic room-owner takeover.

### Screen Demand Uses Reachable Paths

Viewers are a publication's destinations, not the complete set of eligible relays.
Start with usable established paths and project source-to-viewer demand onto them.
On the base tree this is the union of the unique paths to those viewers; retain
every required intermediate node. Prune only branches with no downstream demand.
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

The room runtime owns one routing controller. Its base topology, voice/file
flows and screen subscriptions share connection facts, edge admission and repair.
Each flow retains its own replacement and completion state; it does not get its
own probing, reconnection or optimization subsystem. The sharer owns capture
and declares publication demand, while this controller selects distribution.
An ICE timeout for one picture cannot block another picture or ordinary chat.

The relay candidate pool may include every authorized room participant with the
required capability and capacity. This does not deliver video to all of them.
Publication metadata can advertise a share without its bytes, as illustrated by
[LiveKit's publication/subscription model](https://docs.livekit.io/transport/media/subscribe/).
For a fixed A-B-C-D tree, if A sends 4 Mbps and only B watches, the needed edge
carries 4 Mbps; broadcasting to C and D as well adds two copies, making 12 Mbps
of summed hop traffic. This is an arithmetic example, not a measurement. When D
also watches, C is necessary transit even if C never displays the picture.

For example, a room's base tree may be:

```text
Room owner B ── C ── D
           └── E
```

C sends a file to E through C-B-E. C and E need not establish a new direct path
for that transfer. If E shares a picture only with D, E-D can be a shorter
screen candidate when reachable, rather than a requirement to bypass C or B.
If it fails, keep the working admitted path. Every admitted hop must have the source
and enough actual capacity; an existing control link alone does not prove this.

The source and viewers determine a screen plan, while the room owner manages
the plan's lifecycle. Different publications can reuse a physical pair. Stopping
one publication removes its work, not an unrelated call, file transfer or base link.

### App-Assisted Viewing

A Browser may attach its currently approved App's live endpoint to its own
screen subscription. The existing App hosting description supplies that endpoint;
do not infer it from a same-user participant list. The room validates that the
helper is an admitted endpoint of the same user with room access. The Browser
remains the real viewer and supplies decoded and presentation proof; the App
receives and forwards without adding a fictitious watch or reading activity.

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

### Start On Existing Paths, Then Converge

The room tree's root owns coordination. Its edges are bidirectional, so projecting
a flow from its sharer already makes that sharer the logical media source; no new
PeerConnection or change of room owner is needed merely to reverse flow direction.
Renaming the root cannot shorten the tree's unique paths. A shorter path requires
different, actually usable edges. Reverse flow may use all neighbors of an
internal base node. The room's default fanout starts at two and can be set from
one to twenty by its managers. Other endpoints follow that default or choose
their own relay limit from zero to twenty. The room host and each publication's
source use the room default for their root branches. Zero declines forwarding
for others; it does not stop originating voice, pictures or files through the
existing base paths. Necessary reverse-base neighbors and a helper's local display
link remain distinct from new forwarding branches. This is a room-local topology
policy, not a total upload-copy or device-capacity promise, and does not divide a
domain-wide resource budget among rooms.

Reducing a limit stops new excess branches and moves affected children through
one bounded transition at that tree's existing owner. Choose a feasible necessary
move across overloaded parents before binding a new operation to a child; an
unmovable first child must not block another legal migration. Once started, that
operation retains its target and original deadline. Keep the old branch until
the candidate base transport and affected voice flows are proved; picture changes
retain their existing forwarding, decoded and presentation proof. File
next hops use only the committed base, while candidate connections
hold ordinary transport leases. An explicit reduction is necessary capacity work:
if its bounded alternatives cannot succeed, retire the excess old branch and use
ordinary route failure/recovery. Optional optimization still preserves a healthy
path. Neither case periodically rebalances unrelated branches. When a receive-only
leaf occupies an upstream slot, that same bounded base operation may insert a
willing relay into the branch or rotate its immediate child into that slot.
Both new legs and affected voice paths must be proved before replacing the old
branch; a participant without a feasible candidate does not block another one.

1. A new viewer first attaches to a usable existing publication branch or an
   admitted source-to-viewer path on the base tree, installing only its missing
   suffix on ready room paths. Prove picture readiness; an open control
   DataChannel is not a decoded frame.
2. While that path plays, the same availability/direct-convergence/quality owner
   may prepare a bounded alternative parent or branch using room-wide eligible
   peers; there is no separate fallback or shortest-path router.
3. Reserve the actual overlap resources, prepare the candidate, and require its
   media proof and the applicable non-regression evidence before committing.
   Replace one affected branch, then release only its old media work. The player
   renders one committed input; source sound switches with its picture.
4. Keep the base connections needed by voice, files or other
   publications. They remain available to attempt media recovery, but do not
   continuously carry a second copy of an already-converged picture.

These are stages of one publication plan, not two complete live video networks.
Fallback after a later failure still needs media preparation on its selected path;
keeping the base connection is not a promise of instant hot-standby video.
If a base path lacks the capability or capacity for that picture, retain its
control traffic and let the same availability planner seek another admitted
media path. Successful base-path playback is not a prerequisite for trying an
alternative. A viewer remains connecting until a selected path proves ready.

Reconcile on relevant demand, connectivity or capacity changes. A new viewer adds
a branch; stopping viewing removes only demand that no downstream still needs;
a departed relay repairs only affected paths. Preserve healthy unrelated branches.
Each admitted session gets one direct attempt per publication. Viewing toggles
and unrelated membership updates must not reset spent candidate opportunities.
Once useful attempts finish, keep the working route rather than probing
periodically for a mathematical global optimum.
Repairing a base edge reconciles only flows using that edge. An independent,
healthy screen branch stays in place while room authority remains valid; a
change in the base plan does not reset every publication to its startup path.

Availability work takes priority over optional optimization. Without overlap
capacity, leave healthy playback in place and defer or finish the optional
attempt. A bounded-gap change belongs only to necessary availability repair,
under the [existing transition rules](../adr/0005-automatic-hybrid-media-routing.md).
Source generation, current route and operation identity fence late callbacks;
new work cannot inherit completion from a retired candidate.

Screen preparation also has a finite lifetime when its shared connection is already
connected. Each publication waits on one unproved frontier edge whose parent has
the source; downstream nodes waiting for that parent are not blamed for missing
frames. Reconciliation does not extend the current wait. Expiry retires that
media attempt through the same plan, preserving unrelated flows and base paths.
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
recovery and final close. Base-tree and screen plans request admitted flows;
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

A channel has no fixed media allowance divided among rooms. The participant
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

A user needs an admitted path into the room tree, not a direct connection to
every other user. Joining or repairing a tree uses mature ICE/STUN handling and
the existing bounded retry principles. Reuse reachable participants as relays;
do not add an all-pairs probe, full mesh or periodic topology rebalance.
With unchanged authority and demand, an exhausted required path becomes eligible
again after the room's five-second repair cooldown. The existing room wake-up
schedules missing paths while retaining healthy branches, their failed-shortcut
history and running screen-operation deadlines. Required leases on a retired
physical pair receive a new pair identity.
Each admitted physical pair acquires its connection resources once. Terminal
failure releases those resources; if signaling is interrupted, the still-current
lease reports that failure when signaling resumes instead of recreating the pair.
Base reconciliation retains proved edges and re-evaluates unproved reservations
against the ready tree, preferring shallower ready parents. Equally deep choices
retain the current eligible parent. Unchanged edges keep their physical leases
and endpoint acknowledgements. A complete ready base path
can replace an unproved screen fallback; proved media branches remain installed.
Confirmed physical-pair failure informs both directions in every affected plan,
including candidates first tried by another activity. A publication's media
failure remains local to that publication. Base failure history retires when
neither current demand nor an installed transit path needs it.
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
their domain's configured ICE servers. An individual rejected ICE candidate
does not retire the connection or its other candidate paths.
Ordinary Native peers gather IPv4 and IPv6 through the same RTC transport owner;
an unavailable address family does not disable the other. Wildcard listeners
exclude loopback interfaces from ICE/STUN discovery. Explicit loopback listeners
remain available for a configured local forwarding backend.

The coordinated UDP candidate keeps preparation inside one authorized physical
pair attempt. The domain's existing transport book issues its replacement UUID;
logical room/media leases and operation deadlines stay unchanged. Only currently
capable Native endpoints participate. The prepared socket transfers to the ordinary
PC after mutual completion, with no competing reader or separate route graph.

Server shares fixed UDP listeners across its peer connections. Piik's
[socket owner](../../prototype/channel-native/src/peer/transport.rs) dispatches
packets through str0m's public `Rtc::accepts` and `handle_input` interfaces;
the SDK owns ICE and media demultiplexing.
The Server entry binds both address families on the actual HTTP port by default,
before opening domain data. Configured listeners must all bind successfully;
IPv6 sockets are v6-only so both families can use that port. Local binding and an
optional public IP/port mapping are separate facts. An FRP backend on loopback
requires an explicit loopback bind; wildcard enumeration advertises real interfaces.
Candidate availability is evaluated across the bound listeners: a family without
an advertisable address does not invalidate another family's usable candidates.
The service owns these sockets until its peer connections retire. App peers keep
their exclusive sockets, gateway mapping and coordinated preparation; a shared
Server listener does not advertise preparation capability.

Each Native pair may map its actual default-gateway IPv4 socket using the
[portmapper client](../../prototype/channel-native/README.md#rtc-dependency). Its
background probe, protocol selection and renewal stay with that library;
mapping does not delay ICE or replace IPv6 and STUN candidates. Mapped addresses
use the existing candidate signaling. Pair retirement joins the address watcher
and requests best-effort deactivation through the library's existing lifecycle.

Prepare a replacement, prove it usable, commit, then release old work. A base
edge requires both endpoints to confirm an installed open control DataChannel
before bidirectional voice, not merely a connected PeerConnection. DataChannel
failure repairs base paths while preserving the pair's healthy media leases.
Channel negotiation can arrive before the local room projection. The physical
pair may retain its bounded incoming channel slots while inactive; a valid room
lease still gates data delivery, sending and base proof. Repeated empty
projections do not retire those slots. Removing the last actual lease cancels
its work; physical closure also clears channels received after a prior failure.
Silent voice uses transport/forwarding readiness rather than waiting for audible
speech. Picture availability requires
a decoded frame. Shared link failure reconciles all affected flows through the
same transport owner. Retiring room-data work ends its queued and waiting sends
while preserving the pair's picture and input work. A new room-data lease may
acquire fresh channels on that same pair. Temporary ICE disconnection retains its Pair; confirmed
failure retires it and allows the room to establish a replacement. Signaling
resynchronization replays current connection, base and media facts alongside
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

Room browsing, voice, screen sharing and watching remain independent activities.
Opening another view does not retarget a microphone or stop another room's media.
A participant retains the room connection while an admitted activity, transfer
or forwarding duty needs it; changing the highlighted sidebar item is not a
global media shutdown.
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
its base-path scope; input failure does not retire other consumers or affect
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
| Room owner changes views, minimizes the window or closes an in-page panel | Keep the hosting session and its room running. Visibility is not authority. |
| A Browser page closes | End its personal voice, shares and watches. Its Browser-hosted rooms stop; App-hosted rooms continue without handoff. |
| A hosting runtime loses domain signaling while it remains alive | Retain the existing session recovery window; expiry pauses its live rooms. |
| A Browser's local App control connection ends | End native activities owned by that control connection. Browser media and App hosting keep their own lifetimes. |
| App hosting stops or its process ends | Pause its hosted rooms and release that runtime's activities and connections; saved room data remains. |
| An administration page closes while Server owns the runtime | The deliberately running service continues; its lifetime is independent of that page. |
| Browser-owned room runtime closes or expires | The room pauses; Browser hosting must not silently move to the domain owner's device. |
| Room owner stops the hosting runtime | The room becomes unavailable; saved data remains. No automatic replacement is selected. |
| A manager deletes or removes a room | Retire its activities and bindings; data disposition follows the [room removal scope](./channel-storage-and-identity.md#room-creation-and-removal). Other rooms keep their leases. |
| Same owner restarts using saved room data | Restore room identity/history and establish new live sessions. Captures require explicit activation; reopening data does not resume a saved call. |
| Sharer stops or leaves | End that publication, preserving other sources and the room base tree. |
| A relay leaves | Repair affected paths through the same route owners; keep unrelated flows. |
| File's original sender leaves | Another online admitted holder may supply its copy. With no holder, the file is unavailable until a source returns. |
| Room access is removed | Stop that user's affected activities and new delivery; local downloaded bytes cannot be recalled. |
| Domain authority connection is lost | Retain the bounded authority-recovery rule; do not silently operate indefinitely with an old global permission snapshot. |

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
opening its Native room data. Approval grants one exact Web origin its own
namespace; revocation stops that site's hosting without deleting data or affecting
other sites. A replacement external origin needs approval and does not inherit
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
contributes none. Desired capacity remains separate. An unfittable trial retires
its outputs without retiring selected media or the connection. Stable local-offer
failure withdraws only unconfirmed additions; sender retirement permits one
companion-audio retry, not retries on rollback or unchanged projections.

A producer reconciles only its own actual output demand. It reuses a warm baseline
at full demand and independently encodes constrained outputs; zero allocation
pauses the output. Restoration adopts a newer baseline keyframe before retiring
the constrained encoder. An unused baseline rests on its bounded AU queue.
`Original`/`Limited` identify feed reuse, not delivered quality or a permanent
outgoing RID geometry cap. Each publication carries its sharer's requested
resolution/FPS/bitrate ceiling and picture preference together as `VideoSettings`.
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

Capture presentation time owns RTP and Sender Report correlation, independently
of encoding/delivery delay. Metadata without RTP retains the last correlation.
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
requested FPS ceiling. Both retain original timestamps and the shared capture
rate. Workers observe the admitted cadence before FrameDropper. Linux refreshes
encoder caps from that observation, using raw/requested startup hints until
available: x264's variable-rate
buffering would otherwise delay a static source's first picture. Windows MF keeps
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

Native Auto prefers available VP8 when the selecting Browser cannot receive H264.
Otherwise it tries hardware H264, then available software VP8 after failed or
timed-out first independent output. Stop the failed encoder before replacement
on the same capture/clock. Sender capability is not preview support. The admitted
codec stays fixed for source changes/derived outputs; manual unsupported selection fails
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

These references support individual boundaries. The accepted room-owner-operated
base tree and selective screen plans are Piik's design choice, to be checked
against its existing routing behavior and actual runtime costs.
