# Piik 3.0 Room Data And Hosting

Reviewed 2026-10-27. The [accepted network model](./channel-network-design.md)
owns responsibilities, routing and live lifecycles. This document records the
accepted data ownership and develops synchronization, delivery and recovery. The
[prototype README](../../prototype/channel-server/README.md) describes running
behavior; [TODO](../todo.md) owns pending decisions and implementation.
The first version keeps one room data owner and reuses established room paths.
The next implementation stage is recorded in TODO.

## Ownership And Placement

The room owner operates the room and keeps its authoritative data. The domain
owner operates the channel directory and membership. These runtimes may share
one App when that user owns both, or run on different users' devices. Neither
arrangement adds a storage server, a second application or a configuration task.

| Information | Authoritative owner and copies |
| --- | --- |
| Domain identity, users, roles and room-to-owner binding | Domain runtime's durable data. Clients and room runtimes receive authorized identity facts. |
| Room name, icon, access and grants | Room runtime's durable data. The domain directory holds only its authorized summary. |
| Identity images | Small retained assets at their domain or room owner; independent of the uploader's live session. |
| Messages and attachment descriptions | Confirmed history at the room runtime; participants may keep readable local copies. |
| File bytes | The sender and recipients that retain complete copies. The domain owner does not automatically receive or store them. |
| Presence, available file holders and active activities | Current authenticated sessions. Rebuild these facts when participants reconnect; a saved record does not prove present availability. |
| Live sessions, voice, pictures and route plans | Their active runtimes. Reconnection reconciles existing work; a runtime restart establishes new sessions and activities. Saved data does not restore a call. |
| Drafts, display preferences and URL bookmarks | The local client, separate from domain/room authority. |

A file sender owns its offered content, not the room's management or history.
A local history copy grants no write authority. File forwarding and permanent
storage are different work: an intermediate peer can relay bounded chunks
without retaining the whole file.

The owner accepted durable room history and attachment metadata, participant-held
file copies and whole-file hash verification. Images and ordinary files share
one attachment model. Content becomes unavailable when its copies disappear;
its history record remains. The first delivery model is demand-driven sharing on
the existing room tree, with complete verified copies reusable as sources. It
does not add a swarm, per-piece hashes, a second route planner or a storage service.
Detailed cache limits and transfer encoding remain implementation decisions.
These responsibilities add local data to existing runtimes, not a separately
configured storage role.

## Metadata And Local Copies

Persist stable identities, policy and confirmed content. Rebuild online presence,
route plans and file-source availability from live sessions. Domain directory
updates come from the room owner and contain only the summary a recipient may
see; changing a room name does not introduce a second writer at the domain.

Scope local copies by domain, room and authenticated user, never nickname or
room title. Source URLs locate the runtime; they are not the room's identity.
Cached content remains a local copy when the room is offline. It cannot reopen
the room, confer management permission or become authoritative by being newer.

Recommend room admission also permits reading its retained conversation. Do not
add a separate history permission or per-user storage configuration in this
first model. Joining a room fetches its recent history, not every room in the
channel or every attachment's bytes.

### Messages And Attachments

| Record | Durable information |
| --- | --- |
| Message | Stable identity, authenticated author, room-confirmed order and send time, text and attachment references. |
| Attachment | Stable identity, filename, media type, byte size and expected whole-file digest. |
| Image presentation | Optional dimensions and preview reference on the same attachment; no separate image storage or delivery lifecycle. |

Send time and author belong to the message rather than a second copy on every
attachment. A text message can contain attachments, and an attachment message
can have a caption. The room owner saves these records transactionally and
restores them on ordinary restart. Serving availability is derived from current
readable copies, not a permanent `available` flag on the saved message.

## Confirmed History

Keep one confirmed order at the actual room runtime:

1. A participant sends a command along its room path with a stable send identity.
   The authenticated user is its author; a relay's identity or a nickname cannot
   replace that author.
2. The room owner authorizes the command and commits the message, its order and
   retry identity in one transaction. Failed storage means the send is not confirmed.
3. Return the confirmed message identity and order, then distribute the result
   over the room tree. A retry resolves to the same retained result.
4. Participants replace their pending local echo with that result and cache only
   confirmed history. An unconfirmed send stays separate from readable history.

Confirmation means the room owner saved the message, not that every participant
received it or that its attachment was copied. Keep retry association with the
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
Storage adapters read retry identity, room order and attachment ownership inside
one transaction; the shared core prepares the confirmation. A Browser runtime
serializes room operations through the transaction's
[complete event](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event),
not an individual write's success. Failure ends that operation without advancing
the confirmed order or blocking the next command.

Participants synchronize from the room owner over the established room path.
Intermediate peers forward the authenticated response; they do not confirm it.
Load a bounded recent window at a fixed history boundary, then continue with
confirmed changes after that boundary. Older pages are requested when needed.
Snapshot and live delivery share the same room order so a message arriving during
loading is neither missed nor rendered twice. The
[Matrix sync model](https://spec.matrix.org/latest/client-server-api/#syncing)
illustrates separating recent history, older pagination and subsequent events.

Start with refreshing the retained local window on reconnect, replacing it with
the room owner's current result, including removals. This avoids introducing a
permanent change-replay service for the first local cache. Browser copies belong
in bounded IndexedDB storage; localStorage remains for small preferences and
bookmarks. Original author departure does not erase confirmed messages.

The room owner supplies the current history generation and retention boundary.
A higher timestamp or longer cached history is not proof of authority. Ordinary
restart preserves that generation; restoring an older backup changes it and
requires a fresh authoritative window. The shared room core owns synchronization
identities and cursors; storage adapters supply atomic reads and writes.

Do not silently evict the owner's confirmed history as if it were a participant
cache. If storage cannot accept a message, report that failed send and preserve
existing data. Participants may reclaim their reading cache independently.
Peer-supplied history pages remain a later optimization: they require verifiable
room confirmation and a current history boundary. The base model already keeps
history off the domain owner without adding consensus or per-user signed logs.

## File Sources And Reachability

Attachment records are distributed with chat; file bytes use the existing room
network. The sender prepares a readable source before submitting the description.
A complete, verified copy can become another source while its holder remains
admitted and able to read it. The room runtime keeps this source index in live
state; holders announce their actual copies again after reconnecting. The original
sender has no permanent priority over other usable copies.

### File Identity And Untrusted Copies

A holder announcement is a claim of availability, not evidence of correct bytes.
The original sender supplies the content identity through its authenticated send;
the room owner confirms it with the attachment record. The receiver authenticates
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

Use demand-driven distribution over the room base tree. Project an admitted
source's flow to the interested recipients, reusing the existing unique paths.
The [network model](./channel-network-design.md#one-base-tree-per-participating-room)
owns route admission and repair; file work adds range demand and progress, not
another topology planner or mandatory direct ICE connections.

1. Authorize message attachments against current room access and the retained
   message. Identity images follow their domain/room visibility rules through
   the same transfer mechanism. A digest identifies bytes, not permission.
2. Reuse an active distribution or a suitable complete cached source using known
   room connectivity and capacity. Keep a working flow. Source changes are
   explicit and admitted; an intermediate peer cannot silently substitute its
   copy or expected digest.
3. Aggregate concurrent requests for the same attachment, range and authorized
   distribution. A shared upstream path carries one response, copied only at
   branches with demand. Keep recipients' progress separate from this shared work.
4. Forward through bounded windows and buffers. A relay need not download or
   retain the whole file to forward it; an interested recipient may retain its
   completed copy and later become a source.
5. Repair a broken edge through the room controller and reconcile the affected
   range requests. Cancel removes that recipient's demand; it does not retire
   delivery still needed by others. Release a shared flow after its last demand.

For S-R with R-D1, R-D2 and R-D3, aligned concurrent downloads can share one copy
of each range over S-R; R forwards to the three branches. Independent downloads
from S would send three copies over S-R. This is a topology example, not a measured
speedup. When S itself has several required outgoing branches, its upload follows
that fan-out; a base tree does not guarantee one total upload for every shape.
If all usable paths pass through S, changing file sources alone cannot remove
that transit work. Any new edge belongs to the existing room router's admission
and optimization, not file-specific probing.

One-copy sharing applies to overlapping range demand while the data remains in
flight or cached. A late recipient may require another read. Keep per-branch
windows bounded: a slow recipient resumes from its retained offset or an available
complete cache instead of forcing every other branch to wait or retain unlimited
data. File traffic still consumes the real forwarding capacity of each endpoint.

Ordinary disconnection may resume a temporary download from its written offset,
but that prefix is not yet verified. Final digest failure discards the temporary
copy before retrying; whole-file verification cannot identify a good prefix or
the particular source/relay responsible for corruption. Try other available
candidates finitely, then report failure. Do not promote bad content or ban a
claimed holder solely from an end-to-end mismatch.

The [WebRTC DataChannel API](https://www.w3.org/TR/webrtc/#rtcdatachannel) supplies
per-hop queue signals; each recipient's bounded pull limits its in-flight demand.
`bufferedAmount` does not prove downstream storage consumption. Keep bulk data
out of the ordered control queue, while sharing transport ownership and admission.
Separate queues do not isolate physical bandwidth.
Closing a chat panel or stopping video does not cancel a file transfer's needed
connection; completion releases only that transfer's resources.

Use a writable local sink, not an unbounded in-memory Blob. Start with recovery
of an active task across connection loss; persistent downloads across process
restart are not required for the first transfer implementation.

No optional configured file-host store is proposed. A room owner may hold a file
as an ordinary sender or recipient; ownership does not require retaining every
file. The availability boundary is simple:

| Situation | Result |
| --- | --- |
| Original sender leaves; an admitted holder remains online | That holder can supply the file through the room network. |
| No holder is currently online | Keep its history entry and show that content is currently unavailable. A returning source can serve it again. |
| Every readable copy has been removed | The bytes are lost until someone supplies the same content again; keep the original message and attachment card. |
| The room runtime stops | Pause remote room operations and delivery; existing local copies remain readable. |
| Access is removed or the attachment is withdrawn | Stop authorized delivery. Previously downloaded copies remain with their recipients. |

[Jami's file transfers](https://jami.net/swarm-file-transfers/) demonstrate the
separation between a file announcement, on-demand download and retained peer
copies. Piik's proposed tree path supplies the carrier; it does not adopt Jami's
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
existing tree and complete-copy cache index. Concurrent request aggregation has
a separate published precedent in [CCNx section 2.4.2](https://www.rfc-editor.org/rfc/rfc8569.html#section-2.4.2);
this is an experimental protocol reference, not a proposed Piik dependency.
Implementing the bounded shared-flow behavior still needs acceptance evidence.

Publish attachment metadata to the room, but request large file bodies only for
interested consumers and necessary relays. Proactively filling every participant's
cache would spend bandwidth and storage even when nobody wants the file. Keep
whole-room push and a torrent-style multi-source piece scheduler out of the initial
recommendation; discuss them only if shared-tree delivery leaves a concrete gap.

### Retained Files And Images

Recommend one managed, bounded content store per participant runtime for sent
files and reusable downloaded copies. Native execution uses local files;
Browser execution can use its origin-private file system where available.
Successful retention, not the platform name or a past download event, determines
whether a copy can be offered after reopening. Cache reclamation withdraws the
source announcement and leaves the history description intact. Explicitly saved
user files are outside that cache's cleanup.

Saving a browser download into the system's Downloads directory does not give
the page automatic future read access. It can offer a source only through a
currently readable selection, retained copy or granted handle. Browser-managed
storage follows [origin, quota and persistence rules](https://storage.spec.whatwg.org/);
the [File System Standard](https://fs.spec.whatwg.org/) supplies origin-private
storage. A session-only source must not be presented as a retained copy.

Images use this same attachment/transfer model. Loading a visible image requests
its preview; it does not subscribe everyone to every original file. Small identity
images remain with their domain/room owner, as specified in the ownership table,
so an avatar does not disappear when its uploader leaves. Retention policy can
differ without creating another transport or external storage service.

## Persistence And Recovery

Keep durable domain and room data for the 3.0 communication model, stored
outside program/update files. This does not change the published 2.x App's
process-only room behavior.

Room availability follows its explicit hosting session, not the highlighted UI
panel. Changing views preserves that session; losing its owning page follows the
network model's recovery window and does not grant an idle App independent hosting.
When the session ends, the room pauses and retains its data. Restarting with the
same data restores that room's identity and history.
Recreating a same-named room without its data creates a new room.
Unattended operation belongs to Server and follows its service lifetime; this is
not an extra App background mode. Stored data and the shared core are independent
of that wrapper distinction. No service takes over another user's room implicitly.

The domain directory can retain the unavailable room's summary and owner binding.
It does not automatically become a substitute room host or recover data it never
stored. If the room owner permanently leaves, the domain owner can remove the
directory entry; continuing that room requires an explicit transfer of hosting
and state. Automatic election and offline concurrent writing are outside this
first model.

Backup follows ownership: a domain export contains the domain's data; a room
export contains that room's state and retained local content. A domain export
alone cannot include history held only by another room owner. Never give a room
owner the domain credential database merely to export their room.

Use the storage platform's consistent snapshot mechanism; native SQLite provides
the [online backup API](https://www.sqlite.org/backup.html). Restore with the
previous writer stopped and reopen the same stable identities. Restoring older
history must be distinguished from ordinary restart, so cached newer records
cannot silently overwrite the restored authority. Live captures, connections
and input grants are not backup data.

A conversation export for reading contains no authentication secrets. A hosting
backup needs private handling because it preserves authority. Exact export
format and controls follow the ownership decision, rather than becoming another
service or user setup requirement.

## Ordinary URLs And Identity

The owner declined pkarr, automatic address discovery and a mandatory fixed
public Web client. Ship the interface with the domain runtime and keep ordinary
URLs, editable bookmarks and manual replacement when an invitation address
changes. No project-operated registry is needed.

A persistent domain/room ID belongs to its saved data, not its hostname.
Changing the public URL does not create another domain when the same runtime
and data remain. A returned ID is identification, not proof of access or trust.

Browser storage follows the
[origin boundary](https://html.spec.whatwg.org/multipage/webstorage.html#the-localstorage-attribute).
A new origin cannot read the old origin's bookmarks, credentials or history.
Current bookmarks remain local to their originating page. Manual URL replacement
does not provide cross-origin identity recovery; a new invitation alone does not
restore an old user's management permission.

App-held room data can survive a domain URL change without moving its files.
A Browser-held room authority additionally needs access to its original local
data and credential. Explicit export/import can support that move; it is separate
from editing a bookmark. This is part of Browser hosting design, not a reason to
introduce a mandatory fixed website.

## Current Implementation And Next Check

The prototype's normal create-room action starts a Browser-owned Rust/WASM
runtime. Its policy and confirmed history stay in IndexedDB; the domain stores
only its directory summary. The initial Server-owned rooms use the same room
command core with SQLite. Both adapters commit before confirmation and share
retry and pagination rules. Participant reading windows remain separate from
the owner's retained history. Reopening a room restores its data without
restarting captures or voice.

Domain WebSocket rendezvous currently carries authenticated room commands and
replies. Server-owned rooms retain HTTP attachments; Browser-owned rooms wait for
peer file delivery rather than storing their content on the domain. The shared
base paths now carry Browser-room voice; room commands/history and file bytes
still need that carrier integration. App hosting and participant history caches
remain later work.

The next carrier check extends the separate A-domain/B-room-owner model:
C and D receive history along admitted room paths, so A no longer carries every
room message. Preserve B's existing confirmation, restart and retry semantics.
A file must reach D through an intermediate peer when C-D direct connectivity
is unavailable. Lost message confirmation must not duplicate a committed send;
refreshing a participant must recover confirmed history. File delivery must
share upstream ranges for simultaneous consumers, handle a slow or cancelled
branch independently, and resume after path/source loss. Corrupted downloads
must fail whole-file verification. Exercise file traffic alongside voice and
picture playback through the same resource owner.
These checks establish the ownership and carrier model before expanding the
business interface.
