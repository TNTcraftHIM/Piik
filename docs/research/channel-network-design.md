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
The App is an interactive client. Unattended hosting belongs to Server; a
standby App must not keep an abandoned owner session running.

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
| Channel | 频道 | The top-level container for users, roles and rooms. |
| Domain owner | 域主 | The user operating the channel's directory, membership and role authority. |
| Room | 房间 | A conversation, history and media scope within a channel. |
| Room owner | 房主 | The user operating that room's state, management and base distribution network. |
| Role | 身份组 | A channel-scoped permission group; a user may have several roles. |
| Sharer | 分享者 | The user originating a particular screen, voice publication or file offer. |

Management identities and activities overlap. A room owner can share, watch or
forward, and an ordinary user can publish without becoming the room owner.
A file sender supplies that file; sending never transfers room management to them.
On P2P room paths, a relay is a participating endpoint doing forwarding work,
not a separately deployed relay server. Sending, receiving and forwarding can
coexist on the same user endpoint.

Changing the selected room or closing an in-page panel does not end a hosting
session. Closing the page that owns that session is a different event. Keep
ordinary App-linked operation tied to that explicit session: reconcile a
reload/reconnect within the existing recovery window, then pause the room if its
owner session expires. A running standby App does not silently take over ownership.
Server-owned domain/room runtimes instead follow the deliberately started service;
closing an administration page does not stop that service. Both wrappers use the
same core and routing rules. A Server does not automatically inherit an App-owned
room. Explicit ownership transfer would also transfer its operation and state;
automatic takeover is not selected.

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

A user, a live endpoint and a linked App are different concepts. The Browser and
its linked App implement one participation; separate devices remain separate
endpoints of the authenticated user. Reconnect preserves identity rather than
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

Current 2.x [projectVoiceFlows](../../internal/server/signal/voice_plan.go) already
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

Prepare a replacement, prove it usable, commit, then release old work. A base
edge requires an open DataChannel and an installed control path, not merely a
connected PeerConnection. Silent voice readiness uses transport and forwarding
readiness rather than waiting for audible speech. Picture availability requires
a decoded frame. Shared link failure reconciles all affected flows through the
same transport owner. Use these existing events; add no periodic probe protocol.

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

| Event | Outcome |
| --- | --- |
| Room owner changes views, minimizes the window or closes an in-page panel | Keep the hosting session and its room running. Visibility is not authority. |
| The page owning an App-linked room session closes or loses connection | Allow the existing session recovery window; expiry pauses the live room. An idle App does not replace the missing owner session. |
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

App and Browser can operate the same logical room runtime through different
execution/storage adapters, while obeying the same explicit hosting-session
lifetime. Persistent data can outlive that session; background App execution
alone does not extend it. A Browser-only room host
is not implemented merely because the current UI can ask the central service to
create a room. It requires the shared authority core running locally, potentially
through WASM, and actual local persistence/recovery verification.

## Implementation Boundary

The normal prototype interface creates rooms in their actual owner's
[Browser runtime](../../prototype/channel-browser/README.md). The shared Rust
core owns policy, activities, publication plans and confirmed history; IndexedDB
stores that room's data. The domain supplies credential-free identity facts,
binds the current runtime and projects authorized directory views. Its own
default rooms use the same core with SQLite. A failed directory save cannot
undo a policy already committed by its room owner.

A shared transport book combines logical flows into physical pairs. Changing
one room's activity cannot retire a pair still used by another room. Domain
rendezvous carries admission, activity changes and repair. Browser- and Native-hosted
rooms carry authenticated chat and history on a base DataChannel tree, rooted
at the actual host session. Both endpoints must confirm an installed open channel
before an edge carries bidirectional voice. A non-listening participant may
forward that voice; changing views retains necessary transit. DataChannel failure
repairs base paths while preserving the pair's healthy media leases.

Screens retain independent plans and start on ready room paths, installing only
the missing source-to-viewer suffix. Existing picture branches stay in place;
base connectivity does not substitute for picture proof. Reverse flow may use
all three neighbors of an internal base node. The small fanout policy for new
branches is a topology choice, not a measurement of device media capacity.
Failed picture preparation uses the same availability candidates without
retiring the shared base connection. Necessary transit survives local unwatch.
Convergence prepares one alternative branch per publication, including its
downstream transit. Every affected viewer must have decoded its current picture;
its candidate must pass the shared quality comparison and supply a prewarmed
player frame. Pure transit proves forwarding instead of pretending to display.
Only then does the room select the prepared branch and retire its old leases.
Source sound, volume, pause and container fullscreen follow the same player
handover; native element fullscreen defers it. Preparation and switching share
one finite operation. The first viewer's approval bounds the remaining wait to
the existing quality-evidence lifetime. Failure or changed viewing demand cancels
that candidate while preserving the required old paths. Each admitted session
gets one direct attempt for that publication, independent of view toggles.
Server-owned default rooms have no Native endpoint and retain standalone screen
plans; an administrator's page cannot substitute for that endpoint. They do not
advertise peer file delivery. Participant resource admission and App/Server
hosting integration remain.

Before implementing the next slice, map its user-visible behavior, authority,
state transitions, resource lifetime and recovery. Existing code is evidence of
current behavior, not proof that its semantics or structure should survive.
Simplify that model first: remove obsolete behavior, duplicated responsibilities
and accidental constraints, while preserving the accepted product contract.
Implement the resulting concepts in Rust using suitable mature components;
module and function parity with Go is not an acceptance criterion. Verify the
same complete user flows and failure cases against the new ownership model.

The [Native participant](../../prototype/channel-native/README.md) now operates
the same room core with one SQLite database per room, an admitted session and
real base DataChannels. It forwards encoded media without local playback or
capture. Its caller owns hosting lifetime; a command-line development host does
not grant background hosting to an idle App. An OS file lock excludes another
runtime from simultaneously operating the same saved room.

The next slice completes participant resource admission before connecting
App/Server hosting to those owners.
Domain runtime keeps directory, membership and authenticated rendezvous;
room execution and storage remain with the explicit room host. Use one Rust
core with thin App/Server and Browser adapters. Evaluate
capture, encoding and input at their platform boundaries; retain native helpers
only where platform APIs or a proven component require them. Do not add a
separate storage service.

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

The 3.0 experiment defines a new business contract without putting both models
inside every module. The [versioning standard](../standards/versioning.md) still
separates build identity, wire compatibility, stored schema and live generations.
A published cutover needs its own handshake and data-upgrade decision.

After the data-model discussion, verify the smallest complete slice: A operates
a domain, B operates a room, and C/D join, chat, speak and transfer a file over connected
room links. Then add simultaneous screen publications and selective viewing.
Include a sender/receiver pair with no direct ICE path but a working intermediate
hop, relay departure, room-host restart and domain-authority loss. Compare shared
voice and independent screens under the same workload; measure startup, recovery,
frame/voice delay and bytes at the actual forwarding endpoints.

The isolated Native participant uses webrtc-rs/rtc 0.21.1.
Its [async adapter](https://github.com/webrtc-rs/webrtc/blob/d658b5a803dd8dc389547450e245877310c9cbed/src/peer_connection/mod.rs)
owns sockets, candidate gathering and protocol deadlines. Its
[interceptor registry](https://github.com/webrtc-rs/rtc/blob/2a732df55ca4bcf26b80914fa0f570cfaf74cfcb/src/peer_connection/configuration/interceptor_registry.rs)
provides RTCP, GCC/TWCC and pacing; congestion control needs explicit configuration.
The configured Native/Browser proof now receives real sender reports and TWCC
feedback that updates the GCC target; a deterministic library check verifies
the pacer's finite queue and rate-dependent release timing. Piik owns encoder
demand, bounded queued work and the source's RTP timeline, rather than
reimplementing those network algorithms.

Native encoded forwarding separates control turns from real-time packet writers.
Audio and video retain separate source identities within one publication. Each
output uses its sender's negotiated codec mapping and keeps the source RTP clock
and Sender Report correlation; replacing a source creates a new sender/SSRC.
Removing the last incoming demand releases its reader even if the publication
remains in the room directory. Native capture and SFU integration remain later
stages. This isolated dependency does
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
