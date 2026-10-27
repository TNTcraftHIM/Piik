# Piik 3.0 Room Data And Hosting

Reviewed 2026-10-27. This document owns the proposed data placement and recovery
model. The [network model](./channel-network-design.md) owns responsibilities,
routing and live lifecycles; the [prototype README](../../prototype/channel-server/README.md)
describes running behavior. [TODO](../todo.md) owns decisions and implementation.
Complete the foundation review before implementing storage or business features.

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
| Live sessions, voice, pictures and route plans | Their active runtimes. Reconnection reconciles existing work; a runtime restart establishes new sessions and activities. Saved data does not restore a call. |
| Drafts, display preferences and URL bookmarks | The local client, separate from domain/room authority. |

A file sender owns its offered content, not the room's management or history.
A local history copy grants no write authority. File forwarding and permanent
storage are different work: an intermediate peer can relay bounded chunks
without retaining the whole file.

Data ownership is fixed here. Message editing UX, cache quotas, attachment
previews and backup UI follow after the foundation is agreed.

## Confirmed History

Keep one confirmed order at the actual room runtime. It authorizes a send and
commits the message and retry identity before acknowledging or distributing it.
A retry preserves its identity; an unconfirmed send remains pending.

Use incremental transactions at the storage owner. Do not carry the prototype's
whole-channel JSON rewrite into distributed room storage. Share the Rust room
rules between native execution and any Browser/WASM adapter; use local SQLite
or IndexedDB through that adapter rather than an external database service.

Participants initially synchronize from the room owner over the established
room path. Intermediate peers forward that response; they do not confirm it.
Browser history copies belong in IndexedDB, with bounded retention; localStorage
remains for small preferences and bookmarks. Original author departure does not
erase confirmed messages.

The room owner supplies the current history boundary, including deletions.
A peer with a higher timestamp or more cached messages cannot take over.
Serving a cached history page from another participant is a later optimization:
it requires authority-verifiable contents and a current history boundary.
[Jami's history model](https://docs.jami.net/en_US/developer/jami-concepts/swarm.html)
is a reference, not a reason to add multi-writer merging or a consensus system.

## File Sources And Reachability

A confirmed attachment description identifies its content, size and digest.
Recipients fetch bytes on demand; they are not pushed to every member. A complete,
verified copy can be another source while its holder remains admitted and online.
The room runtime tracks available holders and authorizes the transfer.

A transfer uses the room base tree's existing path from holder to recipient.
It creates a bounded transfer task, not a new route planner or a mandatory direct
ICE connection between those two users. The [network model](./channel-network-design.md#one-base-tree-per-participating-room)
owns hop forwarding, backpressure and repair. The content digest detects altered
bytes; it does not by itself establish who may receive them.
The recipient also needs a bounded storage sink; a large download must not
become an unbounded in-memory Blob when streaming file output is unavailable.

No optional configured file-host store is proposed. A room owner may hold a file
as an ordinary sender or recipient; ownership does not require retaining every
file. The availability boundary is simple:

| Situation | Result |
| --- | --- |
| Original sender leaves; an admitted holder remains online | That holder can supply the file through the room network. |
| No holder is online | Keep its history entry; downloading waits for a source. |
| The room runtime stops | Pause remote room operations and delivery; existing local copies remain readable. |
| Access is removed or the attachment is withdrawn | Stop authorized delivery. Previously downloaded copies remain with their recipients. |

[Jami's file transfers](https://jami.net/swarm-file-transfers/) demonstrate the
separation between a file announcement, on-demand download and retained peer
copies. Piik's proposed tree path supplies the carrier; it does not adopt Jami's
discovery or replicated-history architecture.

## Persistence And Recovery

Recommend durable domain and room data for the 3.0 communication model, kept
outside program/update files. This does not change the published 2.x App's
process-only room behavior.

Room availability follows the room runtime, not its highlighted UI panel.
An App can keep operating after the panel closes; a Browser-owned runtime depends
on its page remaining active. If the runtime stops, the room pauses and retains
its data. Restarting with the same data restores that room's identity and history.
Recreating a same-named room without its data creates a new room.

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

The prototype currently keeps domain and all room authority/history in one Rust
coordinator, with SQLite checkpoints and authenticated HTTP attachments. Native
persistent room hosting, Browser-local room authority, peer file transfer and
local history copies are not implemented.

After agreement, validate one domain owner A and a different room owner B:
B alone confirms and retains its room history; C and D receive it along their
admitted room paths. A holds directory and membership facts without receiving
every message or file. Restart B with its data and restore the same room.
A file must reach D through an intermediate peer when C-D direct connectivity
is unavailable. These checks establish the ownership and carrier model before
expanding the business interface.
