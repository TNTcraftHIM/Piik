# Piik 3.0 Room Data And Hosting

Reviewed 2026-10-27. This is the proposed storage and responsibility model,
requested before implementation. Automatic address discovery was declined:
keep ordinary URLs and manually updated bookmarks. The [network model](./channel-network-design.md)
owns room/media lifecycles; the [prototype README](../../prototype/channel-server/README.md)
describes running behavior. [TODO](../todo.md) owns implementation and decisions.

## Recommended Ownership

Start with one hosting service per channel, using the same Rust core in App and
Server. It confirms membership, permissions, room changes and messages. Rooms
isolate access and retained conversation; they do not require separate hosting
processes or authority implementations. Domain and room owners are users with
management permissions, independently of which device runs the service.

Keep the lightweight authoritative record at this service. Distribute media and
on-demand file delivery among participants, and keep local history copies for
reading and recovery. A replica does not become another writer. Independent
room hosting is a later deployment choice, not a prerequisite for this model.

| Owner | Responsibility |
| --- | --- |
| Domain owner | Manages channel membership, roles and the room directory. Personal logout does not stop a separately running service. |
| Room owner | Manages that room's access and presentation. Leaving a page, voice or sharing activity does not delete the room. |
| Hosting service | Checks permissions, confirms changes and saves channel/room data. Its availability governs new authorized operations. |
| Sharer | Owns a live publication and its capture. Each publication has its own distribution plan; stopping it leaves other activities intact. |
| History holder | Keeps already-confirmed conversation. A copy grants neither management nor write authority. |
| Attachment holder | Retains selected content and serves authorized recipients. It need not retain other files or be the room owner. |

The coordinator retains membership and credential databases; ordinary history
copies contain only authorized conversation data. The current prototype already
separates room ownership from domain ownership. Do not add another permission
evaluator for replicas, files or a future hosting adapter.

## Where Information Lives

| Information | Authoritative owner and copies |
| --- | --- |
| Channel identity, members, roles and room directory | Hosting service's durable database. Clients receive authorized projections. |
| Room name, icon, access and membership grants | Room-scoped records in that database. The room owner requests changes; the service authorizes and commits them. |
| Channel/room identity images | Small retained assets on the hosting service, independent of the uploading user's session or chat retention. |
| Messages and attachment descriptions | Confirmed room history on the service; participants can cache the history they may read. Author departure does not erase messages. |
| File bytes | Sender, recipients that retained a copy, and an optional configured host store. A message reference alone does not establish file availability. |
| Live voice, pictures, subscriptions and routes | Their current sessions and media runtimes. Reconnection/restart reestablishes live work; these are not saved room content. |
| Drafts, display preferences and URL bookmarks | The local client. They are neither channel configuration nor access grants. |

Bound retained history and stored file bytes at their storage owner. A client
loads the rooms and history pages it requests. File upload, relay and SFU work
are explicit additional workloads, not inevitable costs of owning a channel.

## Writing And Replicating History

Keep a single confirmed order per room. The current shared sequence already
orders each room's messages; it does not need a new per-room allocator. Authorize
a send, then commit its message, retry nonce and retention changes in one transaction before acknowledging or
broadcasting it. A retry uses the original nonce. An unconfirmed message stays
pending; disconnection does not turn it into a second message or a confirmed one.

Replace the prototype's whole-authority clone and whole-channel JSON rewrite on
each durable command with incremental SQLite transactions. Keep the existing
bounded attachment BLOB store initially: separating responsibilities does not
require a new object store or database service.

Participants cache retained history for rooms they can access. Use IndexedDB for
Browser records and file caches, with bounded retention; localStorage remains
for small preferences and the initial bookmark list. Reconnect requests missing
records instead of replacing every room's history. A cache is not a permanent
archive; explicitly retained copies belong to a hosting/storage configuration.

Initially synchronize history from the authenticated hosting service. It owns
author attribution, confirmed order, edits/deletions and the retention boundary;
clients reconcile their copies against those facts. A cache with a larger local
timestamp or sequence cannot override them. This keeps the existing trust model
and does not require a signed history protocol merely to persist local copies.

Peer-supplied history is a separate distribution step. It must verify records
against the room's authority before exposing them as confirmed history, and query
that authority for the current head and retention/deletion state. A signed copy
can prove its contents without proving it contains later messages. Use a mature
implementation if that step has a concrete benefit; do not build hash chains,
multi-writer merging or delegated signing into the first persistence change.
[Jami's signed history](https://docs.jami.net/en_US/developer/jami-concepts/swarm.html)
is a reference for that later step, not a dependency of ordinary chat storage.

## Files And Availability

A message contains the attachment's description, size and content digest; it does
not imply that another device has retained the bytes. The sender keeps the
original, recipients pull on demand, and a complete hash-verified copy can become
another source. A hosting service can retain files within an explicit quota.
Do not automatically copy every file to the domain owner or every participant.

The channel's hosting service admits each transfer under current room policy for
its file, sender and recipient sessions. Bytes can then travel directly between
those peers. Do not give a file
holder another user's long-lived credential. Transfers use the existing session
recovery deadline: access removal stops them, and lost authority does not create
a separate heartbeat or an indefinitely valid grant.

| Situation | Proposed behavior |
| --- | --- |
| Room owner leaves, hosting service stays online | Conversation continues; already admitted files remain available from their holders. |
| Original sender leaves, another holder stays online | Download from that holder after ordinary room authorization. |
| Hosting service is unavailable | New sends and remote downloads wait for recovery; already-loaded clients can read content they have actually cached. |
| No content holder is online | Show that the file is waiting for a source, without declaring it deleted. |
| Message is withdrawn or access removed | Stop further authorized delivery and apply retention; already downloaded copies cannot be recalled. |

[Jami's file transfer design](https://jami.net/swarm-file-transfers/) separates
history synchronization from content availability in this way. This first 3.0
storage phase keeps online authorization, avoiding offline permission replication.

This changes the present prototype's centralized file delivery: its current
attachments are uploaded to SQLite and downloaded over authenticated HTTP.
Peer delivery is not implemented. Message history and file availability keep the
same meaning whichever admitted storage/transport supplies the bytes.

## Hosting, Upgrades And Recovery

Recommend persistent App-hosted channels as well as persistent Server channels
for the 3.0 communication use case, with explicit deletion. This replaces the
earlier temporary-App recommendation for owner discussion; it has not been
implemented in Native App and does not change published 2.x behavior.

| Action | Proposed result |
| --- | --- |
| Browse another room, close a panel or stop one activity | Affect only that view or activity; keep room data and unrelated activities. |
| Room/domain owner closes their Browser | Retire that session; the separately running hosting service and room data remain. |
| Hosting process stops | Channel operations become unavailable. Persistent data stays on disk; existing media obeys the network model's recovery deadline. |
| Hosting process restarts using its data directory | Restore the channel, users, rooms and saved conversation. Establish new sessions and media activities. |
| Room owner permanently leaves membership | Keep the room under domain-owner management until explicit transfer or deletion. |
| Remove a bookmark or clear a local cache | Remove only that local entry/copy, without leaving membership or deleting a room. |
| Explicitly delete a room | Retire its activities and authoritative data; synchronize deletion to connected clients. Already downloaded copies cannot be recalled. |

Permanent membership departure and room/channel deletion need explicit commands;
the current prototype's `Leave` only retires a live session. Do not label that
existing action as deleting membership or durable data.

Keep the data directory outside program/update files. Normal upgrades reopen it;
export/import is for backup and moving devices. Use the standard
[SQLite snapshot API](https://www.sqlite.org/backup.html), including current BLOB
attachments. A hosting backup preserves channel/user identity, access state,
retained history and hosted content. Conversation exports contain no credential
database or secrets. State which external startup configuration must be supplied
separately. Captures, routes and live sessions do not restore.

Restore with the former writer stopped, validate the candidate and retain the
previous data until success. Once durable client copies exist, an explicit
rollback must identify a new history generation so clients reconcile rather than
merge later cached records into the restored history. Ordinary restart keeps the
existing history. Do not use the client with the largest sequence as a recovery
authority. Independent room hosts, automatic takeover and offline concurrent
writes remain separate decisions; no such framework is required here.

## Ordinary URLs And Identity

The owner declined pkarr, automatic address discovery and a mandatory fixed
public Web client on 2026-10-27. Ship the Web interface with the hosting service;
keep direct URLs, URL bookmarks and manual replacement when a public address
changes. The website is optional. Do not add an account, registry or hosting
dependency to make a bookmark work.

A saved channel ID belongs to the data, not its hostname. Reopening the same
database preserves channel, room and user identities even if the service URL
changes. That ID is not a credential or proof that a new endpoint is trustworthy.

Browser storage follows the
[origin boundary](https://html.spec.whatwg.org/multipage/webstorage.html#the-localstorage-attribute).
A new origin cannot read the old origin's bookmarks, login credential or history
cache. Current bookmarks therefore remain local to the page that saved them;
they are not a cross-site address book. Update them from an entry that is still
available, or use the new invitation and the Browser's own bookmarks. An expired
old tunnel may also prevent reopening its bookmark manager or cached conversation.

Joining through a new invitation creates a new user unless that client explicitly
presents the original credential. A matching nickname, invitation or returned
channel ID cannot recover old management permissions. Cross-origin identity
continuity would require an explicit credential-transfer design; it is not part
of simple URL replacement. A hosting backup preserves server-side identities,
not the Browser's ability to access another origin's storage.

## Delivery And Acceptance

Agree the responsibility and persistence model before changing runtime behavior.
Then complete incremental storage/backup, bounded client history and admitted
peer file delivery. Peer history synchronization and room-host delegation are
later options. The [prototype README](../../prototype/channel-server/README.md)
owns the implemented scope. Proposed acceptance:

- Concurrent room sends update only their durable records; failed writes receive
  no success acknowledgement. Reconnect retries do not duplicate messages.
- Closing the room owner's page preserves a separately hosted room; stopping its
  service preserves local history and gives pending operations an honest state.
- A holder supplies a file after its original sender leaves; modified content
  fails verification, and revoked access stops new/active delivery.
- Upgrade/restart preserves stored identity and conversation; backup rollback
  cannot silently merge stale client history into the restored authoritative state.
- Replacing the URL preserves the hosting database. A new Browser origin follows
  normal admission without inheriting another origin's credentials or permissions.
- An already-loaded client with a stored copy can read it during service loss;
  missing files, unconfirmed sends and unavailable entry pages remain distinct.
