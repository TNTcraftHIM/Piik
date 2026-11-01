# Piik 3.0 Channels, Rooms And Networking

Accepted direction 2026-10-27. This document owns the isolated 3.0 responsibility
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

Use one room routing owner: a base tree carries conversation, voice and
files. Pictures start on usable existing paths, then converge locally towards
source-rooted delivery through bounded background transitions. All authorized,
capable room peers can be relay candidates; only viewers and necessary transit
nodes receive the picture. Both stages use the same route state and transports.
The owner accepted this routing foundation and durable room records with cached
attachments. The [room-data model](./channel-storage-and-identity.md) owns simple
shared file delivery on those same paths. Browser and Native room owners run the
shared Rust core with local confirmation/storage. Their base paths carry authenticated
chat/history, voice and verified file ranges; TODO owns remaining route and platform integration.

## Terminology And Roles

| English | Chinese | Meaning |
| --- | --- | --- |
| User | 用户 | Every participant, including domain owners, room owners and sharers. |
| Domain | 域 | The top-level container for users, roles and rooms; named `Channel` in the current code. |
| Domain owner | 域主 | The user operating the channel's directory, membership and role authority. |
| Room | 房间 | A conversation, history and media scope within a channel. |
| Room owner | 房主 | The user operating that room's state, management and base distribution network. |
| Role | 身份组 | A domain-scoped permission group; a user may have several roles. |
| Sharer | 分享者 | The user originating a particular screen, voice publication or file offer. |

Management identities and activities overlap. A room owner can share, watch or
forward, and an ordinary user can publish without becoming the room owner.
A file sender supplies that file; sending never transfers room management to them.
On P2P room paths, a relay is a participating endpoint doing forwarding work,
not a separately deployed relay server. Sending, receiving and forwarding can
coexist on the same user endpoint.

Changing the selected room or closing an in-page panel does not end hosting.
Closing a Browser page ends that page's personal voice, sharing and watching;
it also ends rooms whose runtime runs in that page. App-owned rooms remain with
the App and are not handed over when a page closes. Connecting an App does not
automatically move existing Browser-owned rooms. Server-owned runtimes follow
their deliberately started service, independently of administration pages.
All use the same core and routing rules. Moving a room requires explicit transfer
of its operation and saved state; automatic takeover is not selected.

## Authority And Information Boundaries

| Owner | Its authoritative state and work |
| --- | --- |
| Domain runtime | Domain identity, users, roles, room-to-owner bindings and authorized room-directory summaries; initial contact and signaling rendezvous. |
| Room runtime, operated by its room owner | Detailed room metadata, room admission and grants, confirmed conversation, file descriptions/available holders, base-tree planning and screen-route scheduling. |
| Participant runtime | Local captures, playback, file copies and the actual peer transports/forwarding work it has admitted. |

The domain directory is a projection of room details. It does not become a
second writer of the room name, private-room policy or history. Domain membership
and role policy place the upper bound on access; the room runtime applies its
room policy within that bound. Removing global membership cannot be overridden
by a local room grant. Use the same typed permission rules and authenticated
identity facts across both scopes, rather than unrelated permission engines.

Directory visibility and access remain separate. Public rooms admit channel
users; private rooms require their room admission. Hidden private rooms expose
neither directory details nor activity to unauthorized users. A nickname is not
identity, and an invitation establishes admission rather than proving that two
visitors are the same user.

The domain directory binds each room to its owner's current authenticated runtime
connection, separately from the owner's persistent user identity. With no runtime,
the room is unavailable. One room has one current runtime binding; reconnecting
replaces that binding without granting a stale session authority over its successor.
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
Chat and history requests use the base paths after room admission.
Use short-lived session signing keys, bound to admitted sessions and the current
room-host binding through authenticated domain rendezvous. Sign the original
payload bytes with a maintained Ed25519 implementation, verify before parsing,
and resolve the author and permissions from current trusted domain facts. A
relay cannot substitute its identity or supply its own permission snapshot.
Long-lived admission credentials never enter the peer carrier.

Peer requests use the same room authorization and storage operations as local
execution. They run in the room owner's existing serialized turn without
changing its routing state or becoming domain-issued turns. Their confirmations
return to the request; domain revisions retain their authority/reply-fencing purpose.
Projection order and request authority remain separate: an older room snapshot
cannot replace newer routes, but an earlier authorized action can still complete.
Successful room actions are acknowledged after the domain has installed a
projection covering that turn. Until then, the existing pending request retains
its result; explicit failures do not wait for a projection.
Confirmation follows the requester's current session and permission facts;
another participant leaving or changing roles cannot invalidate it. Invitation
verification follows the invited user's known permissions, not an online-session
requirement for someone who has not joined yet.
Chat reuses its persisted retry identity; history requests need response
correlation, not another durable replay ledger. The room host signs live results,
without creating a permanent signed history log. The shared transport owner
dispatches typed control messages and bounded history records. A reader accepts
only a complete page, and queued output checks current authority before sending.
File delivery remains one consumer rather than owning unrelated room commands.

The [room-data model](./channel-storage-and-identity.md) owns persistence,
history copies, file retention and manual address replacement. Domain and room
data may reside on different users' devices. When one App operates both, compose
the same runtimes locally rather than requiring another deployment.
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
Domain bookmarks connect independent domains; they do not introduce federation
or shared authority between those domains.

Peer media forwarding terminates hop encryption at admitted relays. Room access
must cover every relay; this model does not add end-to-end encryption against
those forwarding endpoints.

## Routing Foundation

### Choice And Cost

| Model | Benefit | Cost and choice |
| --- | --- | --- |
| One tree for every kind of traffic | One stable set of paths; any connected members can exchange data. | Some pictures incur extra hops. Use established paths as the baseline; a non-viewing relay can still be essential for connectivity. |
| A new distribution plan for every source or transfer | Paths can follow each source's recipients. | Repeats planning for room-wide voice and ordinary files. Keep source-specific demand only where it changes useful forwarding work. |
| Base paths for startup, then selective source-rooted convergence | Reuses room connectivity where media can be admitted; improves affected paths while preserving playback. | Needs distinct viewing/transit demand and temporary transition resources. Selected; both stages use the same admission and transition owner. |

This compares topology and work, not measured performance. A routing root owns
coordination; it need not forward every media byte. Only nodes on an admitted
path incur that path's forwarding work. A star still places that work on its root.

### One Base Tree Per Participating Room

The room owner maintains one committed, bounded tree among admitted room
participants. Its root identifies the coordination owner; data may travel in
both directions. A connected tree already provides a unique path between any
two members. Room entry can establish this base path before microphone or screen
sharing begins; browsing the channel directory does not connect every room.
The base tree also considers better edges after relevant connectivity or capacity
changes, using the same bounded admission and transition rules as screen plans.
Replacing a base edge preserves its admitted flows until their replacement paths
are ready; an open candidate DataChannel alone does not retire active media work.

| Traffic | Route and lifecycle |
| --- | --- |
| Room commands and confirmed chat | Send to the room owner for authorization/confirmation, then distribute confirmed changes to authorized room participants. |
| Voice | Project each joined source to its listeners over the base tree's unique paths; send each source at most once over a required directed edge. |
| File bytes | Use the existing base paths; the [room-data model](./channel-storage-and-identity.md#shared-delivery-on-existing-room-paths) develops shared range delivery and cached-source selection without another topology planner. |
| Screen picture and source audio | One distribution plan per publication: start on usable existing paths, then improve affected branches while preserving selected viewers and necessary relays. |

Published 2.x [projectVoiceFlows](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/server/signal/voice_plan.go) already
builds bidirectional adjacency from the committed room tree, finds paths from
each speaker and avoids repeated copies on shared edges. Reuse that principle;
its current Host/listening constraints are not automatically the 3.0 contract.

Chat and files use reliable DataChannels; voice stays on WebRTC media tracks.
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

### Start On Existing Paths, Then Converge

The room tree's root owns coordination. Its edges are bidirectional, so projecting
a flow from its sharer already makes that sharer the logical media source; no new
PeerConnection or change of room owner is needed merely to reverse flow direction.
Renaming the root cannot shorten the tree's unique paths. A shorter path requires
different, actually usable edges.

1. A new viewer first attaches to a usable existing publication branch or an
   admitted source-to-viewer path on the base tree. Install media forwarding and
   prove picture readiness; an open control DataChannel is not a decoded frame.
2. While that path plays, the same controller may prepare a bounded alternative
   parent or branch using room-wide eligible peers. Existing 2.x availability,
   direct-convergence and quality principles supply candidate filtering and
   transition ownership; there is no separate fallback or shortest-path router.
3. Reserve the actual overlap resources, prepare the candidate, and require its
   media proof and the applicable non-regression evidence before committing.
   Replace one affected branch, then release only its old media work. The player
   renders one committed input; source sound switches with its picture.
4. Keep the base connections needed by conversation, voice, files or other
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
Viewing toggles and unrelated membership updates must not reset spent candidate
opportunities. Once useful attempts finish, keep the working route rather
than probing periodically for a mathematical global optimum.
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
The room owns the deadline and the domain's existing clock wakes a remote room
only when it is due; Browser and Native hosting do not add separate routing timers.

### One Owner For Actual Connections

A participant's transport runtime owns its PeerConnections, negotiation, ICE
recovery and final close. Base-tree and screen plans request admitted flows;
they cannot independently close or mutate a connection another flow still uses.
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

Browser media relays have different costs from Native encoded forwarding. The
current prototype receives MediaStream tracks and sends them again with addTrack;
do not budget that as a packet-only SFU. The
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

App Local discovers addresses through Binding-only STUN on its selected LAN
interface, without contacting public STUN services. That listener belongs to
the local domain's lifetime; Browser and Native participants receive the same
discovery configuration. Public invitations and approved external sites retain
their domain's configured ICE servers. An individual rejected ICE candidate
does not retire the connection or its other candidate paths.
Ordinary Native peers gather IPv4 and IPv6 through the same RTC transport owner;
an unavailable address family does not disable the other.

The coordinated UDP candidate keeps preparation inside one authorized physical
pair attempt. The domain's existing transport book issues its replacement UUID;
logical room/media leases and operation deadlines stay unchanged. Only currently
capable Native endpoints participate. The prepared socket transfers to the ordinary
PC after mutual completion, with no competing reader or separate route graph.

The isolated Server candidate shares fixed UDP listeners across its peer
connections using the library's [UDP mux](https://github.com/webrtc-rs/webrtc/pull/942).
The Server entry binds both address families on the actual HTTP port by default,
before opening domain data. Configured listeners must all bind successfully;
IPv6 sockets are v6-only so both families can use that port. Local binding and an
optional public IP/port mapping are separate facts. An FRP backend on loopback
requires an explicit loopback bind; wildcard enumeration advertises real interfaces.
Candidate availability is evaluated across the bound listeners: a family without
an advertisable address does not invalidate another family's usable candidates.
The service owns these sockets until its peer connections retire. App peers keep
their exclusive sockets, gateway mapping and coordinated preparation; a shared
Server listener does not advertise preparation capability. This library addition
remains in the [combined candidate](../../prototype/channel-native/README.md#rtc-dependency),
outside the formal pin. [TODO](../todo.md) owns its promotion.

Each Native pair may map its actual default-gateway IPv4 socket using the
released [portmapper](https://docs.rs/portmapper/0.20.0/portmapper/) client. Its
background probe, protocol selection and renewal stay with that library;
mapping does not delay ICE or replace IPv6 and STUN candidates. Mapped addresses
use the existing candidate signaling. Pair retirement joins the address watcher
and requests best-effort deactivation through the library's existing lifecycle.

Prepare a replacement, prove it usable, commit, then release old work. A base
edge requires an open DataChannel and an installed control path, not merely a
connected PeerConnection. Silent voice readiness uses transport and forwarding
readiness rather than waiting for audible speech. Picture availability requires
a decoded frame. Shared link failure reconciles all affected flows through the
same transport owner. Temporary ICE disconnection retains its Pair; confirmed
failure retires it and allows the room to establish a replacement. Signaling
resynchronization only replays unfinished negotiation. Use these existing events;
add no periodic probe protocol.

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
The source owner and controlled device authorize remote input for a publication,
source generation and controller session. Domain/room administration alone grants
no desktop control. Changing the focused picture never retargets an input grant.

Input follows the committed screen flow back to its source, using a separate
encrypted logical DataChannel on the same peer connection. Room conversation
and file readiness keep their base-path scope; input failure does not retire
those consumers. A failed route trial preserves current grants, while replacing
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
| Same owner restarts using saved room data | Restore room identity/history and establish new live sessions. Captures require explicit activation; reopening data does not resume a saved call. |
| Sharer stops or leaves | End that publication, preserving other sources and the room base tree. |
| A relay leaves | Repair affected paths through the same route owners; keep unrelated flows. |
| File's original sender leaves | Another online admitted holder may supply its copy. With no holder, the file is unavailable until a source returns. |
| Room access is removed | Stop that user's affected activities and new delivery; local downloaded bytes cannot be recalled. |
| Domain authority connection is lost | First phase retains the existing bounded authority-recovery rule; do not silently operate indefinitely with an old global permission snapshot. |

Start with the current 20-second signaling recovery policy. Failure to replace
a socket does not extend its deadline; successful authenticated reconciliation
ends it. Local stop takes effect immediately. One scope's retirement cannot
release another room's healthy source or transport lease.

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

App and Browser execute the same room rules through Native/SQLite and
Browser/WASM/IndexedDB adapters. Each room follows its actual hosting runtime's
lifetime, separately from personal activity. Persistent data outlives that runtime;
reopening it does not resume captures or calls.

## Implementation Boundary

Browser/WASM and Native/SQLite adapters execute the shared room core. The domain
binds their authenticated runtimes and projects authorized directory summaries;
a failed directory save cannot undo policy already committed by the room owner.
The [Server and App compositions](../../prototype/channel-server/README.md)
describe their runtime setup. Both compose a
[Native participant](../../prototype/channel-native/README.md), whose caller owns
hosting lifetime. An OS file lock excludes simultaneous writers of a saved room.
Capture remains a separate producer.

The shared transport book combines logical flows into physical pairs. Both
endpoints must confirm an installed open base DataChannel before an edge carries
bidirectional voice. DataChannel failure repairs base paths while preserving the
pair's healthy media leases. Changing one room's activity cannot retire a pair
still used by another room.

Picture startup installs only the missing source-to-viewer suffix on ready room
paths. Reverse flow may use all three neighbors of an internal base node; the
small fanout policy for new branches is a topology choice, not device capacity.
Convergence prepares one alternative branch per publication, including transit.
Every affected viewer must have decoded its current picture, and its candidate
must pass the shared quality comparison and supply a prewarmed player frame.
Pure transit proves forwarding. Selection retains those prepared inputs and
outputs before retiring the old leases. Source sound, volume, pause and container
fullscreen follow the player handover; native element fullscreen defers it.
Preparation and switching share one finite operation. The first viewer's approval
bounds the remaining wait to the quality-evidence lifetime. Failure or changed
viewing demand cancels the candidate while preserving required old paths. Each
admitted session gets one direct attempt per publication, independent of view toggles.

The App entry assigns room execution, storage, signing and peer connections to
its Native participant. A loopback control socket authenticates the Browser's
account against domain admission and opens rooms through that participant.
The Browser keeps its separate personal endpoint and controls its own activities;
closing the socket does not retire the App's host. Existing Browser rooms keep
their Browser runtime and storage.
The local approval page grants one exact Web origin access to its own data
namespace. Browser-supplied domain/user IDs select data only within that namespace,
after Native verifies the actual domain admission. Revocation stops that site's
hosting without deleting its data or affecting other sites. Changing a tunnel URL
requires approval of the replacement origin; it does not inherit an earlier
origin's data automatically. URLs carry discovery hints, never App permission.

Use safe Rust for owned business rules and Native resource lifecycles; TypeScript
owns the Web interface and Browser API bridge. Prefer maintained safe Rust APIs
and keep necessary platform FFI inside narrow adapters. Memory safety depends
on those adapters and dependencies upholding their contracts; a Rust wrapper
does not make foreign code memory-safe. Follow Rust's
[safe-abstraction guidance](https://doc.rust-lang.org/book/ch20-01-unsafe-rust.html),
rather than replacing proven components only to change their implementation language.

| Boundary | Responsibility |
| --- | --- |
| Shared Rust core | Domain and room rules, ordered state changes, publication/subscription demand and route planning. Drive these with typed events rather than sockets or timers inside the model. |
| Runtime adapters | Native App/Server I/O, timers and storage; Browser/WASM execution and IndexedDB. Validate external input at entry, with no second mutable authority in handlers. |
| Participant transport/media | Shared peer connections, native or Browser capture/playback, congestion feedback and encoded forwarding where supported. Route repair reuses capture. |
| Web interface | Existing Piik controls and presentation, projecting current room/activity state. UI selection does not own media lifetime. |

One participant runtime counts the work it actually owns; a Browser origin cannot
account for every unrelated tab or application on that computer. Reuse compatible
source encodings, and preserve unaffected outputs rather than capping all viewers
to the slowest request. WebRTC still adapts to real shared bottlenecks.

Actual sender allocation and the existing finite route operation determine
admission. On an established pair, a local offer failure that occurs before
signaling and leaves the connection stable withdraws only its unconfirmed additions;
existing picture, voice and room connections remain. Normal sender retirement
on any pair allows rejected companion audio to retry once. Failure rollback is
not a new opportunity, unchanged projections do not retry, and a retired failed
flow is not revived. This needs no parallel capacity ledger or polling loop.

The 3.0 experiment defines a new business contract without putting both models
inside every module. The [versioning standard](../standards/versioning.md) still
separates build identity, wire compatibility, stored schema and live generations.
A published cutover needs its own handshake and data-upgrade decision.

The selected Native replacement uses published
[str0m 0.24.1](https://github.com/algesten/str0m/tree/8c4c5284cb11b1e3c82962639cda5b3e95af73e8)
through public APIs. Its library owns ICE, DTLS/SRTP, SCTP, congestion control,
probing, pacing and retransmission. One Native pump supplies socket input and
deadlines; room and flow authority stay in the existing Driver and shared Core.
Mature STUN/TURN clients supply discovery and relay protocols through that same
socket owner. Fixed listeners remain service-owned; prepared and relay endpoints
retain their pair lifetimes. The [Native dependency owner](../../prototype/channel-native/README.md#rtc-dependency)
distinguishes this private replacement from the formal pin.

Piik owns encoder demand, complete-access-unit admission and source-time mapping.
An output's unsent payload and retransmission state end when its flow retires,
independently of a later SDP exchange. The replacement retains the existing media
assembly and H264 helpers; switching transport does not remove their patches.

The SDK's GCC target is one physical connection's budget, not an allocation for
each outbound track. Consume it once for that connection's active media. As in
[libwebrtc's allocator](https://webrtc.googlesource.com/src/+/refs/heads/main/call/bitrate_allocator.cc),
allocate before passing demand to encoders. Independently constrained branches
need actual independently rate-controlled outputs; copying the same encoded
packets or applying a minimum/maximum to one shared encoder cannot provide that.
The library's [built-in BWE](https://github.com/algesten/str0m/blob/8c4c5284cb11b1e3c82962639cda5b3e95af73e8/docs/BWE.md)
replaces the private GoogCc/controller and probe-executor integration. Piik
consumes its transport estimates through the existing Native allocator, without
another congestion controller. Each connection aggregates known local media
configuration ceilings independently of actual usage and current allocation.
Received sources without a known ceiling retain unbounded demand; their measured
source cost informs allocation, not a fabricated configuration limit.
The [Native candidate index](../../prototype/channel-native/README.md#rtc-dependency)
owns the exact source and controlled results. Publisher and relay recovery
require separate evidence; [verification status](../verification-status.md#adaptation-boundaries)
owns their current acceptance boundaries.

The runtime's shared physical-socket wrapper requests a bounded 1 MiB receive
buffer through its existing Quinn UDP adapter, preserving larger caller values.
This accommodates media startup bursts before SRTP processing. IPv4, IPv6 and
adopted sockets share this owner. Socket-option errors leave the connection usable;
no media policy or additional receive queue is added.

Native encoded forwarding separates control turns from real-time packet writers.
Audio and video retain separate source identities within one publication. Each
output uses its sender's negotiated codec mapping and preserves the source-time
correlation in RTP and Sender Reports. Replacing an incoming source creates a
new sender/SSRC. Switching a local encoding keeps the capture's logical identity
and that output's sender, SSRC and packetizer; it commits on a newer keyframe.
An active encoding handoff keeps its refresh demand until a suitable keyframe
arrives; sending an RTCP request does not complete it.
Each local output queues complete access units. Overflow discards unsent units
and resumes at a keyframe without blocking healthy outputs.

Local capture and received tracks feed that same encoded-output owner. A local
source has no incoming route lease; its admitted publication supplies the outgoing
flows. Capture presentation time owns both RTP and Sender Report clocks, so encoding
or delivery delay cannot shift one of them independently. The Windows producer
shares one capture's owned GPU textures and presentation clock across independent
encodings. Each encoding owns its conversion, bitrate, keyframe requests and
stop, replaces only unencoded work and applies backpressure to complete access
units. A blocked or stopped encoding does not stall its siblings; stopping the
capture ends them all.
The isolated macOS adapter keeps the same `Capture(Target, fps)` boundary through
ScreenCaptureKit and typed Rust bindings. Source dimensions follow actual backing
pixels and frame metadata, independently of encoder settings. Its original sample
time is converted from the [stream's synchronization clock](https://developer.apple.com/documentation/screencapturekit/scstream/synchronizationclock)
to the shared host-time domain. One completed image copy leaves ScreenCaptureKit's
finite pool; encoders share only that immutable copy. The source owner applies
configuration changes and stops the stream before draining its callback queue and
releasing conversion resources. Each VideoToolbox encoding owns its fitted size,
bitrate and bounded access-unit queue. Inputs come from the codec's native pixel
buffer pool: an output callback does not authorize overwriting retained input.
Source sound has a separate stream and stop lifetime. Both streams use the same
selected-source filter; Apple's [window filter](https://developer.apple.com/videos/play/wwdc2022/10155/)
already selects its owning application's audio, without requiring a second
display selection or video dimensions. It uses the same App capture lease,
producer, input registration and encoding allocation as Windows.
[Platform verification](../verification-status.md#device-evidence-boundary)
owns SDK and runtime evidence.

The Linux adapter uses the same producer boundary. A typed
[ScreenCast Portal session](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
owns selection, its authorized PipeWire connection and revocation. The source
copies each latest image out of PipeWire's pool once; independent GStreamer
encoders consume that immutable image with their own raw-input backpressure and
complete-access-unit queues. Each pipeline uses the same system-time domain;
segment running time removes codec offsets before projecting presentation time
into the shared media clock. Portal closure ends the source and its encodings;
one encoder failure ends only its outputs. System-output sound uses a separate
PulseAudio monitor pipeline. App enables
this capture feature; Server forwarding has no desktop capture dependency.
Platform acceptance is tracked in [verification status](../verification-status.md#device-evidence-boundary).

Android uses this same producer boundary. One user-approved
[MediaProjection](https://developer.android.com/media/grow/media-projection)
owns one VirtualDisplay and image source. Independent MediaCodec encodings consume
owned immutable snapshots, retaining the existing source clock and output owners;
one blocked encoder must not retain the projection's reusable image or block its
siblings. Optional [playback sound](https://developer.android.com/media/platform/av-capture)
is acquired through that capture's authorization, rather than a second projection
or a global lookup. Java supplies the necessary system consent, foreground
service and platform callbacks; Rust owns capture and encoding. The page owns
the capture lease from its initial request, including permission and first-frame
waits. Those waits must leave the App command processor available, and the same
stop operation retires pending and active capture. The shared picker, activation
flow and room/media routes remain the consumers of this platform adapter.

Enabling Linux input requests a
[RemoteDesktop Portal session](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
beside the current capture. It commits only after its selected monitor, EIS
devices and first raw image are ready; cancellation closes that candidate and
keeps the current share. Pending interaction explicitly closes its
[Portal Request](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html#methods)
before session cleanup. The existing source-consent owner cancels superseded
permission requests, including before the capture commit. One local presentation
at handoff requests a keyframe without replacing the producer, encoders or clock;
subsequent frames retain their source timestamps. The EIS region mapping pairs
input with the selected monitor. Paused/removed devices follow the
[EI neutral-state contract](https://libinput.pages.freedesktop.org/libei/interfaces/ei_device/index.html#ei_devicepaused),
so their completed releases do not block another source. Text input follows the
actual device capability.

Linux's optional global stop uses the standard
[GlobalShortcuts Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html),
with the package's installed desktop identity registered through the
[host Registry](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html).
Desktop owns one process binding; source consent owns pending registration and
closes its Request and candidate session on cancellation. A preferred Browser
chord does not establish the actual binding: the system's returned description,
changes and session closure feed the existing source snapshot. Activation revokes
input through the same desktop executor while capture keeps its lifetime.
Linux prefers Super + Alt + Fn; Ctrl + Alt + Fn selects a virtual terminal on
GNOME rather than activating the shortcut.

In the isolated Linux VM, GNOME Portal `50.0-r0` and control-center `50.3-r0`
open real shortcut consent after normal desktop integration. Cancelling the
source returns with input Off and releases Piik's Request/session, but leaves
the provider's dialog visible. The backend's
[`on_request_handle_close_cb`](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/50.0/src/globalshortcuts.c)
only marks the bind cancelled; the
[50.3 provider](https://github.com/GNOME/gnome-control-center/blob/50.3/global-shortcuts-provider/cc-global-shortcuts-provider.c)
has no corresponding external-dialog cancellation. Piik adds no provider
workaround. Approval through the real provider UI bound Super + Alt + F10;
actual EIS keyboard input activated global stop, retired the input grants and
left the original PipeWire capture producing a newer frame. The cancelled
shortcut dialog remains a provider UX limitation, separate from the Mutter
capture-cancellation defect below.

GNOME Portal 50.0 with Mutter 50.2 leaves an unstarted Mutter session after a
cancelled permission dialog, including cancellation through the system UI.
Piik's Portal requests, sessions and PipeWire streams are released. The backend
calls Mutter `Stop`, whose
[`!started` branch](https://gitlab.gnome.org/GNOME/mutter/-/blob/50.2/src/backends/meta-remote-desktop-session.c#L691)
returns without closing the object. This is an upstream cleanup defect; Piik
must not start an unapproved session to work around it.
Checked on 2026-10-31, the same early return remains in
[50.5](https://github.com/GNOME/mutter/blob/c28623c8d29c7b61ec744cdfdbec36f5e7faef1c/src/backends/meta-remote-desktop-session.c#L634)
and [upstream main](https://github.com/GNOME/mutter/blob/432c167ef2de37a708140b02e29881646fc9c13c/src/backends/meta-remote-desktop-session.c#L442).
Removing that eight-line early return passes an isolated Mutter build and
runtime comparison: the owner can close an unstarted session, another caller
is rejected, and cancelling the normal Portal dialog releases its object while
an existing share continues. The repair remains local; no system compositor
was replaced. Publication is tracked in [TODO](../todo.md#held-by-owner).

Requested dimensions are ceilings: each encoder fits the source's natural pixel
size without enlarging small sources. A Windows size change drains old access
units through the existing MFT event loop, reconfigures that same encoder and
resumes at a keyframe. The current bitrate, source clock and output identity
survive the change. This follows the
[asynchronous MFT drain contract](https://learn.microsoft.com/en-us/windows/win32/medfound/mft-message-command-drain)
and [Chromium's encoder reconfiguration](https://chromium.googlesource.com/chromium/src/media/+/cf1aa0045e1e041b5da6d932ae89e2374db4c4e8/gpu/windows/media_foundation_video_encode_accelerator_win.cc#1307).
WGC remains in the parent; each encoding owns one same-executable child. A single
raw-frame credit requests a newer capture only when the encoder needs it.
Same-adapter NT shared handles carry GPU textures through two copies; the child
releases the shared lock before encoding its private copy. Pull-based IPC returns
complete access units and original QPC timestamps. Cancelling a read preserves
its pending result; an unread encoding stops requesting GPU transfers when its
existing two-AU queue fills. Static keyframe requests reuse its private image.
Each Encoding joins its child on Stop/Drop; a Windows Job also closes it when
the App exits. Source stop ends input authority and signals every encoding;
the Capture owner joins WGC.

A controlled single-MFT shutdown reproduced an NVIDIA callback using an already
destroyed transform after `ShutdownObject` returned. The encoding process boundary
contains that failure to consumers of that encoder, including viewers sharing
one baseline. Other encodings, WGC and App-hosted rooms continue. The real App
Browser check retires and rebuilds one constrained output while its sibling
keeps decoding on the same track and SSRC; normal Stop reaps every child.
No idle-encoder retention or shutdown delay is used to hide the driver failure.
The Native driver allocates each connection's target to confirmed local video
after accounting for other RTP, prioritizing selected video over optional video.
One producer reconciles demand with the encodings actually used by its outputs.
It reuses a warm baseline at full demand and one independently controlled encoding
per constrained output. Zero allocation pauses that output; restoration retires
its encoder only after a newer baseline keyframe is adopted. An unused baseline
stops consuming access units and rests on the existing bounded queue.
A required lower-rate replacement releases that output's incumbent and queued
frames immediately, retaining its last emitted source time. A delayed replacement
IDR can then cross a fixed boundary instead of chasing the still-playing original.
Optional restoration keeps playing its incumbent until the new IDR arrives.
Small source-time skew between encodings is handled by the outgoing RTP timeline,
following [LiveKit's source-switch mapping](https://github.com/livekit/livekit/blob/master/pkg/sfu/forwarder.go).
Original capture timestamps and their NTP correlation remain unchanged.
Each physical encoder has its own feed identity. Failure is applied atomically
against an output's current or required pending feed; a failed optional upgrade
preserves the incumbent. The existing driver loop consumes latest targets
without queuing intermediate values.
The same connection budget admits optional flows only after selected demand.
Opaque RTP is measured once at its source before fanout, including sources with
no current outputs. Its ingress removes repeated primary sequence numbers after
RTX repair, preserving the first late repair and out-of-order packets; each
downstream transport owns its own retransmissions. A trial's picture and sound
are admitted together; unknown
cost waits through the existing driver tick without failing its lease. A trial
that no longer fits retires its outputs through the existing flow-failure owner,
preserving selected media and the connection. Pending selected video reserves
trial capacity before its sender is ready. An otherwise empty connection still
starts ordinary forwarding: the SDK's initial estimate is not measured capacity.
No new retry timer, route protocol or adjustable-opaque representation is added.
Default Server adaptation follows the source-supplied, forwarding-only model in
[ADR-0013](../adr/0013-embedded-node-local-media.md). Standard
[simulcast](https://www.rfc-editor.org/rfc/rfc8853) encodings remain representations
of one admitted source and flow, not separate publications or route operations.
Receiving capability belongs to the endpoint session and is projected only to
its assigned peers. Piik producers declare encodings from lower to higher quality;
observed bitrate determines whether a layer fits, not its quality order.
Each RID retains its own RTP/Sender Report mapping into one
source timeline. Outputs reuse complete-frame packetization and keyframe handoff;
the source supplies the encoding work, so the default Server needs no decoder or
encoder runtime. Layered Native forwarding must preserve downstream supply rather
than collapse it into a single low encoding.
The isolated incoming-H264 candidates share complete source access units between
original forwarding and one demand-driven decoder. Windows GPU, Linux GStreamer
and macOS VideoToolbox adapters feed the same derived-producer boundary.
Decoded frames reuse local capture's encoding and retirement owners. Stable outputs
adopt the replacement's keyframe before retiring their previous encoding; closing a weak
output releases its derivation without stopping healthy siblings. Source RTP/SR
mapping preserves the sender's clock through decoding and re-encoding.
The [Native candidate index](../../prototype/channel-native/README.md#rtc-dependency)
separates each platform's source and checks; integration still requires the held
SDK dependency decision and remaining platform acceptance.
Completeness belongs to the assembler across reception, expiry and delivery:
expired fragments must never become decoder inputs. Codec metadata may legitimately
produce no RTP; that leaves the existing sender and its last clock correlation alive.
A hardware encoder can exceed its target when quantization saturates: the
standard-motion 200 kbps trial produced 273 kbps at QP 50; random noise reached
QP 50/51 at 5.2 Mbps. Each encoding therefore reuses WebRTC's
[FrameDropper](../../native/third_party/webrtc-frame-dropper/README.md) before
submission, driven by actual encoded bytes and its incoming raw-frame rate.
Dropped raw frames retain the source clock; encoded reference frames stay intact.
The same standard-motion trial now produces 199 kbps at about 11.4 fps and
recovers to 16.2 fps when its budget rises. The healthy sibling remains near
2.16 Mbps, with its audio and output identity unchanged.
App sharing uses that existing Native endpoint. The selecting page owns a
non-cloneable capture lease whose drop stops the producer directly, even while
signaling is reconnecting; the Native driver owns worker completion. Room
admission precedes capture, and the first encoded access unit completes startup.
The Browser previews its Native share through the ordinary subscription route.
Optional source audio belongs to the same page lease. WASAPI supplies original
sample timestamps; the Rust Opus encoder uses the video's source-time mapping
and separate audio outputs. A silent source does not block picture startup, and
an audio failure retires only its audio outputs. Stereo receive negotiation belongs
to the shared transport, including retained connections that change SDP roles.

Registered capabilities, negotiated SDP and the source's actual SPS are distinct
facts. Match equivalent H.264 profiles and packetization using the SDK; inspect
the actual SPS at the encoded-input boundary. Do not turn the SDP level alone
into a forwarding ceiling: Chromium's
[decoder factory](https://chromium.googlesource.com/chromium/src/+/c423d38b941d7e282dcfdf1238d942845553b644/third_party/blink/renderer/platform/peerconnection/rtc_video_decoder_factory.cc)
advertises a fixed Level 3.1 baseline rather than its actual maximum. The
controlled Level 4.0 capture played in two Browsers without rewriting their SDP.
SDP negotiation and measured decoding retain their separate meanings. Keep the
existing decoded-frame route proof; metadata alone must not retire a working
connection or permanently reject its flow.
Removing the last incoming demand releases its reader even if the publication
remains in the room directory. Further Native media work is tracked in
[TODO](../todo.md). This isolated dependency does
not replace the current 2.x Native media core.

## Design References

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
