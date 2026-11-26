# Piik 3.0 Room Data And Hosting

This research records the prototype's storage, synchronization, delivery and recovery behavior alongside its original design rationale. The [hosting design](./server-hosting-plan.md) owns channel modes, the directory, room permissions, thumbnails and backup behavior. [TODO](../todo.md) tracks implementation.

## Ownership And Placement

The channel binds a room ID to its creator, who manages the room. The room writer confirms and stores its records. It runs on the creator's device in a lightweight channel and on the Server in a hosted channel.

The table describes current prototype placement.

| Information | Authoritative owner and copies |
| --- | --- |
| Domain identity, users and room-to-creator binding | Domain runtime's durable data. Clients and room runtimes receive authenticated identity facts. |
| Room name, icon, access and grants | Room runtime's durable data. The domain directory holds only its authorized summary. |
| Identity images | Small retained metadata at their domain or room owner; independent of the uploader's live session. The directory carries the authorized room summary. |
| Messages, attachment descriptions and bounded image renditions | Confirmed history at the room runtime; participants may keep readable local copies. |
| New attachment originals | The sender and recipients that retain complete copies. The site operator does not automatically receive or store them. |
| Presence, available file holders and active activities | Current authenticated sessions. Rebuild these facts when participants reconnect; a saved record does not prove present availability. |
| Live sessions, voice, pictures and route plans | Their active runtimes. Reconnection reconciles existing work; a runtime restart establishes new sessions and activities. Saved data does not restore a call. |
| Drafts and display preferences | The local client, separate from domain/room authority. |

Restoring local preferences never restores room admission, control grants,
held input, passwords or message drafts, and never starts capture or remote control.

A file sender owns its offered content, not the room's management or history.
A local history copy grants no write authority. File forwarding and permanent
storage are different work: an intermediate peer can relay bounded chunks
without retaining the whole file.

### Identity And Profile Reading

The site retains user identities independently of live endpoints. A past visitor
does not permanently consume an online slot, and admitting new friends does not
delete historical authors, room ownership or room grants. The retained identity
owner stays in the existing domain storage.

An edit sends the fields the user changed. The channel merges site and profile
edits, and the current room writer merges room edits. Concurrent edits to
different fields both take effect. Setting an image to `null` clears it.

Joining without a credential creates an ordinary identity. An explicitly supplied
credential must identify an existing user; rejection never silently creates a new
user or overwrites the client's saved credential. A valid operator bootstrap key
can explicitly select that operator identity. After a rejection, the Browser can
retry the saved identity or let the user choose a new one; only a successful
Welcome saves its replacement. This does not erase local room data or transfer
the original user's room access.

Live projections carry the lightweight identities they currently reference.
Full profiles and the offline directory are read in bounded batches through the
existing authenticated domain connection. The Browser session owns one display
cache, shared by the people list, mention search, conversation references and
history export. A profile update refreshes the corresponding displayed record;
cached names and pictures never grant room access or prove live participation.
The offline list and mention search continue to cover the site's retained users,
including records outside the current conversation page.
Search compares NFC-normalized, case-insensitive names; it does not rewrite the
name saved or displayed for that person.

The owner accepted durable room history and attachment metadata, participant-held
file copies and whole-file hash verification. Images and ordinary files share
one attachment model. Content becomes unavailable when its copies disappear;
its history record remains. The first delivery model is demand-driven sharing on
the authorized room graph, with complete verified copies reusable as sources. It
does not add a swarm, per-piece hashes, a second route planner or a storage service.
Detailed cache limits and transfer encoding remain implementation decisions.
These responsibilities add local data to existing runtimes, not a separately
configured storage role.

## Metadata And Local Copies

Persist stable identities, policy and confirmed content. Rebuild online presence,
route plans and file-source availability from live sessions. Domain directory
updates come from the room owner and contain only the summary a recipient may
see; changing a room name does not introduce a second writer at the domain.

Each user's name and optional avatar belong to that domain's retained identity.
An authenticated user updates only their own profile; the domain saves it before
publishing its current summary. Rejoining preserves the saved profile.
Messages retain the author's user ID and display their current profile, including
when the author is offline; they do not store separate copies of the avatar.
Imported room copies retain a historical author name with a new, archive-only
identity. That identity does not create a site account or receive room access.

User avatars travel in `selfProfile` and `profiles`. An explicit null clears the
picture. The first state on each WebSocket carries the channel icon and the room
pictures visible to that session. Later frames may elide unchanged images on
the same connection. The decoder drops a room picture when the session leaves
the room, loses access or the room goes offline. A new connection starts with a
complete Welcome.

Site identity is established independently of room entry. Public rooms use a
normal room URL; a private room's host confirms and saves its invitation or
password grant before entry succeeds. Other private or hidden rooms remain
outside that grant. Access-mode changes retain an existing private invitation
until its owner explicitly resets it; resetting retires old links without
removing existing room grants. Public entry alone creates no grant for a later
switch to private. A returning creator can reopen a saved room while its channel
binding exists. The channel owner can remove that binding. Reading messages or files requires room admission.

Scope local copies by domain, room and authenticated user, never nickname or
room title. Source URLs locate the runtime; they are not the room's identity.
Cached content remains a local copy when the room is offline. It cannot reopen
the room, confer management permission or become authoritative by being newer.

Recommend room admission also permits reading its retained conversation. Do not
add a separate history permission or per-user storage configuration in this
first model. Joining a room fetches its recent history, not every room in the
site or every attachment's bytes.

### Messages And Attachments

| Record | Durable information |
| --- | --- |
| Message | Stable identity, authenticated author, room-confirmed order and send time, text, attachment descriptions and message reactions. |
| Attachment within a message | Stable identity, filename, media type, byte size and expected whole-file digest. |
| Image presentation | Optional dimensions and preview reference on the same attachment; no separate image storage or delivery lifecycle. |

Mentions refer to stable user IDs and UTF-16 ranges in the confirmed text;
renaming a user does not retarget a mention. They grant no room access. A reply
addresses the original message by its room sequence and stable message ID.
The room writer verifies both while saving the reply, then confirms the
original author's identity and a short excerpt. The sender
may turn off the reply's author notification. Copies remap historical identities
while preserving room-local reference sequences.

The room host initializes the latest confirmed message sequence from its stored
history. The domain projects only current-host confirmations into authorized
room summaries, so a closed conversation can show an unread dot without joining
media routes or loading every room's history. A read marker belongs to the local
browser's site/user/room scope. Only a visible, focused conversation at its latest
messages advances it. A supporting room writer can locate the first surviving
message from another author after a reader-supplied sequence. It returns the
sequence privately, and the reader loads the surrounding page through ordinary
history. Older writers retain manual pagination. Background voice, watching
and transport reading are not read receipts, and sequence differences are not
exact unread counts. Inline
mentions and replies highlight the addressed user in received conversation;
there is no separate offline push or global mention-count service.

Send time and author belong to the message rather than a second copy on every
attachment. A text message can contain attachments, and an attachment message
can have a caption. Store descriptions inside the confirmed message, rather
than creating an upload/pending/commit lifecycle for metadata. The room writer
saves the message transactionally and restores it on ordinary restart.
Serving availability is derived from current
readable copies, not a permanent `available` flag on the saved message.

All sixteen reactions count accepted actions, including repeated actions by the
same person. The room writer confirms each action once and emits its live effect
after the owning turn commits. For a message reaction the writer checks the
selected message's room sequence and stable ID. Message totals are saved with the message;
history restores totals without replaying effects. Picture totals belong to the
publication and disappear when it retires. Reactions to people on the couch stay
ephemeral and have no totals. These targets share room authorization and the
existing conversation carrier; they do not introduce another permission owner.

The sender prepares readable local content and its digest before sending one
chat command. A retry returns the original message, including its original
attachment descriptions. Room identity, message sequence and attachment identity
locate a description for authorization; no separate metadata service is needed.

## Confirmed History

Keep one confirmed order at the actual room runtime:

1. A participant sends a signed command through the domain WebSocket to its
   actual room host with a stable send identity.
   The authenticated user is its author; the carrier's identity or a nickname cannot
   replace that author.
2. The room writer authorizes the command and commits the message, its order and
   retry identity in one transaction. Failed storage means the send is not confirmed.
3. Return the host-signed confirmed message identity and order through the domain
   WebSocket, and send confirmed changes to the room's current readers over that
   same carrier. A retry resolves to the same retained result.
4. Participants replace their pending local echo with that result and cache only
   confirmed history. An unconfirmed send stays separate from readable history.

Confirmation records a successful save by the room writer. Delivery to each
participant and attachment copying are independent of confirmation. The domain
forwards live packets without storing conversation or issuing a second
confirmation. Its operator can read the forwarded plaintext. Readers authenticate
the writer's signature using the session key and room-host binding supplied by
the domain.
Keep retry association with the
retained message rather than a permanent second ledger. Automatic retries stay
within the advertised retention/recovery boundary; an expired pending send is
not silently submitted again as a new message.

[Matrix transaction identifiers](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers)
provide a reference for identifying a retransmission. This does not require
Matrix federation, multi-writer merging or replicated confirmation.

Use incremental transactions at the storage owner. Do not carry the prototype's
whole-channel JSON rewrite into distributed room storage. Share the Rust room
rules between native execution and any Browser/WASM adapter; use local SQLite
or IndexedDB through that adapter rather than an external database service.
Storage adapters read retry identity and room order inside one transaction; the
shared core prepares the confirmation with its attachment descriptions. A Browser runtime
serializes room operations through the transaction's
[complete event](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event),
not an individual write's success. Failure ends that operation without advancing
the confirmed order or blocking the next command.

Participants synchronize from the room writer through the existing domain
WebSocket. No peer connection is needed to read or send conversation. The domain
forwards the authenticated response; it does not confirm it.
Load a bounded recent window at a fixed history boundary, then continue with
confirmed changes after that boundary. Older pages are requested when needed.
Each page is limited to 50 records and 256 KiB of serialized message data,
accepting at least one record so pagination can always advance. SQLite and
IndexedDB read incrementally through the same Core accumulator. The Browser
keeps a contiguous reading window bounded by 4 MiB and the existing record
limit; dropped records remain available through ordinary history requests.
Snapshot and live delivery share the same room order so a message arriving during
loading is neither missed nor rendered twice. The
[Matrix sync model](https://spec.matrix.org/latest/client-server-api/#syncing)
illustrates separating recent history, older pagination and subsequent events.

Refresh the latest reading window when its domain connection or room-host binding recovers or changes,
including when the room-host binding stays the same. A reader browsing older
history keeps that selected window. Refresh from the room writer's current result,
including removals. Participants keep a bounded reading window in page memory;
reloading or re-entering retrieves it from the room writer. Browser room authority
and retained attachments use their existing IndexedDB stores. localStorage holds
origin-scoped admission credentials and personal reading/display preferences.
Original author departure does not erase confirmed messages.

The page retains a live conversation reader for its selected room and for rooms
whose pictures it is sharing or watching. Each picture's chat overlay uses that
room's reader; changing the sidebar selection does not replace another picture's
conversation. Only the selected conversation requests history pages. Overlay
effects use live confirmed text, with a bounded single-line summary for long
messages; loading history never replays effects or alters the stored message.

The current room-host binding scopes history requests and live replies. A fresh
binding replaces the previous reading window with the writer's current result,
even when its newest message is older or the history is empty. Only live arrivals
from that binding can extend the refreshed window. Restore stops the previous
writer and registers the same room identity with a fresh binding. The writer
creates a new persistent history lineage when it creates or installs a room.
Ordinary restart and rebinding preserve that lineage. An authorized reader
retains its personal read position within the same lineage and starts at zero
when a saved position belongs to a different one. Portable room archives
carry the policy and history rows. Their installation assigns the local lineage.

Do not silently evict the room's confirmed history as if it were a participant
cache. If storage cannot accept a message, report that failed send and preserve
existing data. Participants may reclaim their reading cache independently.
The bound room writer is the sole source of live history and confirmations.
After an explicit Browser room creation or installation, request persistent
storage for the origin without blocking the room. The writer's Records panel
reports the browser's actual protection state. This eviction policy is separate
from transaction durability and participant attachment retention.

## File Sources And Reachability

Attachment records and bounded thumbnails are distributed with chat through the domain WebSocket; other file
bytes and pull control use the existing room peer network. A readable description
does not prove that its bytes are currently reachable. The sender prepares a readable source before submitting the description.
A complete, verified copy can become another source while its holder remains
admitted and able to read it. The room runtime keeps this source index in live
state; holders announce their actual copies again after reconnecting. The original
sender has no permanent priority over other usable copies.

### File Identity And Untrusted Copies

A holder announcement is a claim of availability, not evidence of correct bytes.
The original sender supplies the content identity through its authenticated send;
the room writer confirms it with the attachment record. The receiver authenticates
that record through the shared room-control boundary, independently of the holder
or intermediate relays. A provider cannot replace the expected size, digest or
verification data. Changing file contents creates a new attachment, not an update
to copies of the existing one.

The same boundary must protect verification metadata across hops. Per-hop WebRTC
encryption alone does not stop a participating relay from substituting both the
bytes and a self-reported checksum. [RFC 9530 section 6](https://www.rfc-editor.org/rfc/rfc9530.html#section-6)
explains this distinction between content digests and authenticated metadata.
Use the common authority mechanism and maintained cryptographic primitives;
do not invent file-specific identity or a second trust system.

Use the confirmed whole-file digest for the initial model. Network chunks are
transport units, not independently verified pieces. Splitting a large transfer
into bounded messages does not require fetching different pieces from several
providers. A relay may forward the stream before receiving the whole file;
a receiving client keeps its copy temporary until its final size and digest match.
Only then may it open or preview that copy, publish it as a complete source, or
mark the download successful.
No per-piece verification metadata is required for this model.

### Shared Delivery On Existing Room Paths

For each active file, select paths from its authorized holder to the interested
recipients over confirmed connections. The [network model](./channel-network-design.md#room-bootstrap-and-activity-paths)
owns route admission and repair; file work adds range demand and progress, not
another topology planner or mandatory direct ICE connections.

1. Authorize message attachments against current room access and the retained
   message. A digest identifies bytes, not permission.
2. Reuse an active distribution or a suitable complete cached source using known
   room connectivity and capacity. Keep a working flow. Source changes are
   explicit and admitted; an intermediate peer cannot silently substitute its
   copy or expected digest. If the current source has no ready path to any remote
   recipient, select an admitted complete copy that does over confirmed room edges. With no ready alternative, retain the source while ordinary route repair
   continues; holder signaling alone does not establish file reachability.
3. Aggregate concurrent requests for the same attachment, range and authorized
   distribution. A shared upstream path carries one response, copied only at
   branches with demand. Keep recipients' progress separate from this shared work.
4. Forward through bounded windows and buffers. A relay need not download or
   retain the whole file to forward it; an interested recipient may retain its
   completed copy and later become a source.
5. Repair a broken edge through the room controller and reconcile the affected
   range requests. Cancel removes that recipient's demand; it does not retire
   delivery still needed by others. Release a shared flow after its last demand.

A Pull from a known current peer can arrive before its room grant or byte assignment.
File and forwarded webpage delivery retain bounded request metadata. Reading
or sending bytes requires both the matching grant and plan. Cancellation, peer
retirement or revocation retires the corresponding pending request.

Range responses and cancellation are accepted only for their matching active
request. Retrying establishes a new request.

For S-R with R-D1, R-D2 and R-D3, aligned concurrent downloads can share one copy
of each range over S-R; R forwards to the three branches. Independent downloads
from S would send three copies over S-R. This is a topology example, not a measured
speedup. When S itself has several required outgoing branches, its upload follows
that fan-out; the sender uploads one copy per required branch.
If all usable paths pass through S, changing file sources alone cannot remove
that transit work. Any new edge belongs to the existing room router's admission
and optimization, not file-specific probing.

One-copy sharing applies to overlapping range demand while the data remains in
flight or cached. A late recipient may require another read. Keep per-branch
windows bounded: a slow recipient resumes from its retained offset or an available
complete cache instead of forcing every other branch to wait or retain unlimited
data. File traffic still consumes the real forwarding capacity of each endpoint.

An admitted download keeps its written offset while its source or upstream
changes. When an authorized replacement becomes reachable, it resumes from
that offset. Cancelling or withdrawing the receiving plan releases the
temporary file. Final digest failure discards the temporary
copy and reports failure; whole-file verification cannot identify a good prefix or
the particular source/relay responsible for corruption. Retrying starts a new
download, without a second automatic source-recovery policy. Do not promote bad content or ban a
claimed holder solely from an end-to-end mismatch.

The [WebRTC DataChannel API](https://www.w3.org/TR/webrtc/#rtcdatachannel) supplies
per-hop queue signals; each recipient's bounded pull limits its in-flight demand.
`bufferedAmount` does not prove downstream storage consumption. Keep bulk data
out of the ordered control queue, while sharing transport ownership and admission.
Separate queues do not isolate physical bandwidth.
Downloads belong to the participant session. Closing a chat panel or stopping
video does not cancel a file transfer's needed connection; completion releases
only that transfer's resources. Image preview URLs belong to their view.

Use a writable local sink, not an unbounded in-memory Blob. Unsupported storage
is an explicit capability result. Start with recovery of an active task across
connection loss; persistent downloads across process restart are not required
for the first transfer implementation.

The current participant-held file path uses online holders. A room owner
may hold a copy as an ordinary sender or recipient. The [hosting design](./server-hosting-plan.md#sending-and-storing-an-attachment)
covers thumbnail persistence and original-file availability in both channel modes.

| Situation | Result |
| --- | --- |
| Original sender leaves; an admitted holder remains online | That holder can supply the file through the room network. |
| No holder is currently online | Keep its history entry and show that content is currently unavailable. A returning source can serve it again. |
| Every readable copy has been removed | The bytes are lost until someone supplies the same content again; keep the original message and attachment card. |
| The room runtime stops | Pause remote room operations and delivery; existing local copies remain readable. |
| Access is removed or the attachment is withdrawn | Stop authorized delivery. Previously downloaded copies remain with their recipients. |

An active reader can observe the original availability of the attachments in
view. The room writer answers from its connected holders, returning one
boolean per requested key. The advertised limit covers one history page at
the maximum attachment count per message. Changing the room binding or
leaving the read session retires its observation. A local original can be
opened immediately. Older writers leave availability unknown until download.

[Jami's file transfers](https://jami.net/swarm-file-transfers/) demonstrate the
separation between a file announcement, on-demand download and retained peer
copies. The selected distribution path supplies the carrier; it does not adopt Jami's
discovery or replicated-history architecture.

### Torrent Comparison And Scope

[BitTorrent BEP 3](https://www.bittorrent.org/beps/bep_0003.html) distributes load
by letting downloaders exchange pieces. It includes piece availability, request
selection and piece hashes; a [magnet link](https://www.bittorrent.org/beps/bep_0009.html)
identifies content and enables metadata retrieval, rather than supplying a route.
Adopting a full swarm would add scheduling and discovery alongside Piik's room
network. Exchanging incomplete copies would also benefit from verified piece
identities; a whole-file hash only identifies corruption after assembly.

This initial model borrows cooperative distribution, while using Piik's
authorized graph and complete-copy cache index. Concurrent request aggregation has
a separate published precedent in [CCNx section 2.4.2](https://www.rfc-editor.org/rfc/rfc8569.html#section-2.4.2);
this is an experimental protocol reference, not a proposed Piik dependency.

Publish attachment metadata to the room, but request large file bodies only for
interested consumers and necessary relays. Proactively filling every participant's
cache would spend bandwidth and storage even when nobody wants the file. Keep
whole-room push and a torrent-style multi-source piece scheduler out of the initial
recommendation; discuss them only if shared range delivery leaves a concrete gap.

### Retained Files And Images

A retained file survives a session. Offering it again requires an admitted holder that can still read it. Restoring a descriptor alone cannot establish availability.

The Browser participant retains confirmed sent files and verified completed
downloads in one IndexedDB store, scoped to its domain and user identity. File
bytes and their confirmed descriptions commit together. The cache retains at
most 256 files and 256 MiB, reclaiming oldest entries first. Reopening offers
readable copies only in rooms the participant can still access; reclamation
withdraws cache-only source announcements and leaves history intact. An active
sender adopts its committed readable copy, so moving the originally selected
file does not break that source. Cache eviction does not retire the copy already
held by that active page. Explicitly saved user files remain outside cache cleanup.

OPFS holds temporary streamed downloads. A retained IndexedDB copy must be
independently readable before its temporary source is removed. A linked App or
Server owns room policy and history and can forward file ranges; hosting a room
does not make it a permanent holder of every participant's files.

Saving a browser download into the system's Downloads directory does not give
the page automatic future read access. It can offer a source only through a
currently readable selection, retained copy or granted handle. Browser-managed
storage follows [origin, quota and persistence rules](https://storage.spec.whatwg.org/).
A session-only source must not be presented as a retained copy.

Conversation messages retain the original attachment descriptor and an optional
thumbnail. The sender encodes a still frame for PNG, JPEG, WebP and GIF input.
It fits the longer edge within 1280 pixels and the shared 512 KiB message budget,
trying smaller dimensions when necessary. Images that cannot produce a distinct
thumbnail keep their ordinary attachment card.

The room writer saves the thumbnail with the message. Reading history displays
it even after file holders disconnect. Opening or downloading the original uses
the local or live holder's verified file, including animation. Historical beta
messages that already embedded a verified original remain readable.

Conversation operations use a 30-second confirmation deadline, covering upload
and the room host's response within the bounded image format. Control operations
keep their shorter deadline. At a measured 1 Mbps in both directions, a full
512 KiB inline original committed in about 5.8 seconds and was confirmed in about
11.6 seconds through both Native and Browser hosts; the former 10-second wait
reported failure after a successful commit. The same nonce and confirmation
owners handle retries; there is no separate image retry protocol.

The writer checks the aggregate byte budget, declared dimensions, raster
signature and attachment binding. Live sends require the thumbnail role and
reject original bytes supplied as a thumbnail. The signed conversation frame
budget covers the complete message including encoding overhead. Reading a
thumbnail requires no file route. Original-image and avatar
enlargement reuse one local lightbox; closing it keeps the conversation and file
owners alive.
The Browser prepares small square images for profiles, channels and rooms.
The channel owns user profiles and its own picture. Each room owns its uploaded
picture and its choice of built-in icon. The directory and channel backup carry
the built-in icon. An admitted reader sees the picture while reading the live
room. Room backups retain both, as do copies that include room information.

### Image Quality Assessment

Reviewed 2026-11-11. The previous 64 KiB budget excluded ordinary screenshots.
The 512 KiB rendition budget combines useful dimensions and measured encoded
size; it is independent of Cloudflare's HTTP upload limit.

[Signal Desktop's reviewed scaling implementation](https://github.com/signalapp/Signal-Desktop/blob/5d1bbb7ee231b35cb9cc8cc449ffb819c528efc8/ts/util/scaleImageToLevel.preload.ts)
combines dimension and byte targets: its standard level uses 1600 px, JPEG
quality 0.7 and a 1 MiB target. Its high-quality candidates start at 3072 px with
quality 0.75 and a 3 MiB target. GIFs bypass this transcoding path. Element
[keeps the original and makes a separate preview](https://github.com/element-hq/element-web/blob/6e55b434cb8b2bc7c70802245727e42c3cf8ce9e/apps/web/src/ContentMessages.ts),
with [previews fitting 800 by 600](https://github.com/element-hq/element-web/blob/6e55b434cb8b2bc7c70802245727e42c3cf8ce9e/apps/web/src/utils/image-media.ts).
These are useful quality/transport boundaries, not Piik presets.

A controlled native-Canvas comparison of two 2048 px UI screenshots found their
original PNGs were 105 and 178 KiB. WebP at quality 0.9 produced 84 and 148 KiB
with slight text softening; JPEG at 0.85 produced larger files and visible text
edge noise. PNG/WebP preserved alpha; JPEG did not. The photo control was a
512 by 480 sample, so this does not establish a high-resolution photo target.
A later controlled 4096 by 3072 synthetic photo produced a 2048 by 1536 WebP
preview of 454 kB from an 8 MB JPEG. A 15 MB transparent PNG produced a 449 kB
preview with clear and partial alpha retained. These are local preparation
checks, not population estimates. The attachment model distinguishes the
rendition from its unchanged original before either is delivered.

## Persistence And Recovery

Keep durable domain and room data for the 3.0 communication model, stored
outside program/update files. This does not change the published 2.x App's
process-only room behavior.

The [network model](./channel-network-design.md#activity-and-lifecycle) owns
hosting availability, signaling recovery and participant lifetimes. When the
hosting runtime ends, the room pauses and retains its data. Restarting with the
same data restores that room's identity and history while its directory entry
remains admitted, without resuming captures or calls. Recreating a same-named
room without its data creates a new room.

The channel retains a bounded recovery registration while withdrawing an offline
room from public discovery. The creator can manage that registration, and a
known link can show the room's offline status.
It does not automatically become a substitute room host or recover data it never
stored. Continuing a room on another device requires an explicit transfer of
hosting and state. Automatic election and offline concurrent writing are outside
this first model.

### Room Creation And Removal

Explicit creation asks the domain for a fresh room ID and creator binding before
the hosting runtime saves its policy. Host registration only binds an existing
directory entry; automatic recovery cannot recreate a removed room. Explicit
backup import may restore an absent entry after authenticating as that room's
creator. An archive's identifiers alone do not grant that authority.

In a lightweight channel, removing only the directory entry retires room access
and activity. The creator keeps the local room data even if the host comes
online during confirmation. The creator can also delete an online room's policy
and history. Its writer commits that deletion before the channel confirms
directory removal. If directory removal fails after the commit, the old binding
retires and the offline entry remains available for explicit removal.
An authorized deletion can finish after the requester disconnects.

Removing a Server-hosted room also deletes its authoritative policy and
history. For an offline room, the channel withdraws the entry and saves the
pending deletion until the Server confirms cleanup. The owner can retry after
a restart. In both modes, participants keep the files they saved independently.

### Backups

The table describes current export formats and defaults. The [storage and backup contract](./server-hosting-plan.md#storage-recovery-and-backup) covers message thumbnails and attachment originals.

| Export | Who provides it | Contents |
| --- | --- | --- |
| Site backup | Site operator | Site identity and settings, users and room directory. Room records remain with their room owners. |
| Room backup | Room owner through its hosting runtime | Room identity, settings, grants and complete confirmed history; available local file originals are included by default and may be excluded explicitly. Restore preserves the original room and owner. |
| Room copy | Room owner through its hosting runtime | Complete confirmed history and reaction counts, with the same choice of local file originals. Room name, icon and connection/voice settings are optional. Import creates a new room owned by the importer under the site's room-creation policy. |
| Personal record export | Any participant | Records obtained by that client. The current text export includes the messages loaded on the page. |

The Domain uses SQLite schema 1 with a domain header and one row per retained identity. Native room storage uses SQLite schema 11. An older private Domain can be exported with its matching build and restored into a fresh domain directory. Browser room hosting uses IndexedDB schema 9. Opening an older private room store reports `unsupported_storage_version` and preserves its contents. Use the build that created it to access the existing history. Room backups use archive version 4 and room copies use version 2. Import checks the format before replacing a room. Deleted rows carry only their room sequence and hashed retry identity, so restore preserves message order and rejects a delayed send after deletion.

A new Native room is initialized and closed in a private staging directory before
its final database path is published without replacing an existing file. The
room's exclusive file lock covers installation. Room discovery reclaims an
interrupted installation only after acquiring that same lock. An unreadable
room retires its own writer; other rooms can complete restoration.

Excluding file originals preserves attachment descriptions and inline images already
stored in history. The archive's retained-file inventory keeps its existing count
and aggregate-byte budgets; exceeding either fails the export without dropping
individual originals. The user can explicitly export without those originals.

Native room exports copy committed SQLite state on a blocking worker with its
own read-only connection. Policy and history come from the completed snapshot.
One copy runs per Native session; another export can retry after `room_busy`.
Cancellation requests cooperative exit, and the worker retains its database
handles and temporary files until it finishes. SQLite write-lock contention
remains separate from moving the copy off the session's message loop.

Going offline does not delete an owner's saved room. The channel retains its
recovery registration, and the owner can resume hosting with the same data. Participants'
reading windows and files are local copies, not additional authoritative histories.
Site backup does not collect other owners' rooms, and exporting a room does not
give its owner the site's credential database.

The portable site archive contains a small `manifest.json` for site metadata and
`users.ndjson` with one retained identity per record. Each record keeps its
existing byte bound; the complete user stream can be larger. This archive
format is independent of the live SQLite checkpoint format. Room backups keep
their existing history and content entries.

Before a site restore retires its current session, the Browser streams the user
records through the shared Core validator. It keeps identity references, not a
second complete profile collection. Native staging repeats the same validation
at its own input boundary before sending a restore to the service owner.
Malformed records, duplicate identities and missing referenced owners reject
the archive without replacing the current authority. The validated original
ZIP is uploaded without reconstructing its user data in JavaScript.

A room copy carries no credentials, access grants, password or invitation from
the original room. Import uses the ordinary room form, with private access
selected initially, and creates fresh room, message and historical-author
identities. The importer chooses access settings for the new room. Available
file bytes are hash-verified; attachment descriptions remain when their bytes
are no longer retained. This reuses the existing archive and room storage paths,
without automatic replication, ownership transfer or a second storage role.

Both restore and copy rebuild reply excerpts and author labels from the earlier
message in the imported history. If that message was deleted or is missing,
the reply keeps its own body and loses its quotation.
The supported archive formats reject unrecognized fields in history rows
before installation, so restoring cannot silently discard saved content.

Use the storage platform's consistent snapshot mechanism; native SQLite provides
the [online backup API](https://www.sqlite.org/backup.html). For a room restore,
replace its data and retire the previous durable writer in one transaction.
A failed transaction leaves the existing host and personal activities intact.
After commit, the new binding's ordinary state projection retires the old
activities and reading context. Restoring older history must be distinguished
from ordinary restart, so cached newer records cannot silently overwrite the
restored authority. Live captures, connections and input grants are not backup data.

Domain restore belongs to the existing App or Server service owner. It stops and
joins its Native operators before replacing the domain's checkpoint and retiring
old clients, then uses the restored owner key for bootstrap. Room files stay
scoped to their domain and owner; importing another domain preserves the former
files without registering them under the new authority. A missing room database
remains unavailable rather than being recreated from its directory summary.

Storage commit and renewed connectivity have separate outcomes. If room or domain
data was restored but registration or reconnection fails, report that committed
result and retain the restored identity for reconnection. If the Native room
writer's reply is lost, report that the outcome is unknown. On reconnect the
creator can check the room list before deciding whether to apply the archive again.

A conversation export for reading contains no authentication secrets. A hosting
backup needs private handling because it preserves authority. Exact export
format and controls follow the ownership decision, rather than becoming another
service or user setup requirement.

## Ordinary URLs And Identity

The owner declined pkarr, automatic address discovery and a mandatory fixed
public Web client. Ship the interface with the domain runtime and keep ordinary
URLs, ordinary browser bookmarks and manual replacement when an invitation address
changes. No project-operated registry is needed.

A persistent domain/room ID belongs to its saved data, not its hostname.
Changing the public URL does not create another domain when the same runtime
and data remain. A returned ID is identification, not proof of access or trust.

Browser storage follows the
[origin boundary](https://html.spec.whatwg.org/multipage/webstorage.html#the-localstorage-attribute).
A new origin cannot read the old origin's credentials or history.
Opening a new address or updating a browser bookmark does not provide
cross-origin identity recovery; a new invitation alone does not
restore an old user's management permission.

App-held room data can survive a domain URL change without moving its files.
The App saves its local site's chosen loopback port and reuses it across starts,
keeping the owner's browser origin stable for file caches and preferences.
If that address is occupied, startup reports the address and allows retry after
it is released. A public invitation URL may still change independently.
A Browser-held room authority additionally needs access to its original local
data and credential. Explicit export/import can support that move; it is separate
from editing a bookmark. This is part of Browser hosting design, not a reason to
introduce a mandatory fixed website.

A room hosting backup may contain its exporting owner's own personal credential.
Explicit import verifies that credential with the target domain and completes
ordinary admission as the same domain/user before replacing hosting data. An
archive's IDs alone cannot establish that identity or grant domain administration.
