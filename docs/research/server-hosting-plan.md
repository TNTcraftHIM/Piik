# Channel Hosting and Room History

This document owns the agreed 3.0 channel hosting, room access and moderation model.
The channel's operating mode assigns the room host. Members use one **Create room**
action. Public or private access is a separate room setting. See the [current
prototype](#current-prototype-and-acceptance) for implementation scope.

## Channel modes

| | Lightweight channel (轻量模式) | Hosted channel (托管模式) |
| --- | --- | --- |
| Started by | Piik App, or a standalone Server configured for lightweight operation | A standalone Server configured by its operator |
| Channel service | Channel identity and picture, member identities, room directory, signaling and peer coordination | The same channel service, plus the room host for every room |
| Room authority | The creator's hosting process handles admission, room settings, messages and attachment descriptions | The Server runs the same room authority. The creator remains the room's manager |
| Creator's device goes offline | The room goes offline when its hosting process stops. Its entry leaves the public lobby. Its own host can reopen its local data | The room stays available to permitted members while the Server runs |
| Attachment originals | Participants provide the bytes during a live share. Recipients can save a local copy | The same participant file path |

Starting a channel from App always uses lightweight mode. An App joining someone else's channel follows that channel's mode. At room creation the channel assigns one writer from its operating mode. The management identity and the machine doing the work are separate. Server media forwarding and peer routing retain their existing policies.

## Channel and room directory

The channel keeps its own identity, picture, member identities and the room bindings needed for discovery and moderation. The current room host supplies the permitted live summary (name, short description, built-in icon and visibility). The room host owns the uploaded room picture, admission and confirmed history. The same placement rule applies to every creator. When the channel creator hosts a room on the channel machine, the room data is local to that machine because it is the room host, just as it would be for another member.

The shared lobby lists reachable, discoverable rooms. Publish a room after its host is bound and can serve it. When that host goes offline, withdraw its public entry. A known room link or a member's own local room can show a scoped “room offline” status. The operator can manage bindings by identifier even when the room is offline. A hosted room is still online when its human creator leaves. A lightweight channel can carry room messages over signaling while the room host confirms and saves them.

An unreachable direct route can use a relay to the same room host. When that process stops, the channel has no copy of the guest's room history to take over. A lightweight room's host can retain its settings, history and thumbnails in its own App data or the originating browser profile. Server-hosted channels retain these records centrally for every room. In both modes the channel owner's authority to remove a room is independent of admission to that room.

### Guest creation and the public Demo

The channel owner sets one creation policy. It can allow members to create
ordinary rooms, limit members to invite-only unlisted rooms, or reserve
creation for the owner. Check the policy at the channel authority on
creation, renaming, visibility changes and host registration.

The public Demo preset lets visitors create invite-only unlisted
rooms. They can enter those rooms by invitation or existing admission.
Their room titles, descriptions and images are absent from strangers'
directory, search and invitation landing metadata. The operator can list
their own public rooms in the shared lobby. A locked room that appears in
a directory has different discovery behavior from an unlisted room.

An abandoned room-creation reservation and a retired guest runtime must give back their live-room slots. Keep offline recovery data private and bounded separately from active room capacity. Removal by the channel owner still invalidates the prior registration. The public Demo can use a stable address even though visitor room hosts come and go.
[Prosody MUC room creation](https://prosody.im/doc/modules/mod_muc)

### Reopening a room

A room's saved identity, the URL that reaches the channel, and the browser profile that owns the local copy have distinct lifetimes. The App host uses its local entry and saved data. A Quick Tunnel gives visitors a temporary address for that channel session. Stopping and starting a screen share within the running channel does not itself rotate the tunnel. After its hostname changes, share the current invitation. On the new origin a returning browser can join again, or explicitly restore a suitable identity backup. A valid invite can admit that new identity to a private room. Returning as its former owner or reader requires the original credential. Browser-hosted room data at the previous origin requires a separate move or restore.

On a stable origin, the same browser profile can reuse its saved credential if the backing channel still recognizes it. A stable URL and retained channel data are the deployment choice for repeat guest access. Editing an App bookmark changes the address used for the next visit. It does not discover a replacement address or prove that a new endpoint is the original channel.
[Piik identity and URL behavior](./channel-storage-and-identity.md#ordinary-urls-and-identity) · [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) · [Browser storage keys](https://storage.spec.whatwg.org/#storage-keys)

## Sending and storing an attachment

The room records text, replies, reactions and the attachment's name, type, size, digest and optional bounded thumbnail. The thumbnail is message metadata. It follows the message's access, retention, deletion and history export in both modes. Each room's existing writer persists it. The receiving device can display it with history even when the original is unavailable.

An original is obtained from an eligible live holder or an explicitly saved local copy. The sender announces the attachment to the room. A recipient can fetch it over peer edges or an authorized server relay's reliable file channel. Intermediates use bounded buffers until the selected ranges are delivered. The room creator's role alone assigns no relay traffic. Offering transit spends bandwidth, while durable originals remain with file holders or an external provider. The [routing proposal](./channel-forwarding-plan.md#server-transit-by-payload) owns which traffic the service admits.
[Jami group file transfers](https://jami.net/swarm-file-transfers/)

A person can share a cloud-drive link today. A future bot or integration can copy an accessible original to WebDAV or S3-compatible storage on the operator's behalf and publish the resulting reference after the copy succeeds. The external service owns that copy's access, retention and space. A pasted link works as an ordinary chat link. Native adapters and a plugin framework are separate product work.

## What an attachment card promises

| Evidence available to this reader | Action |
| --- | --- |
| A Windows App download completed on this device | Offer **Reveal in folder**. On confirmation, the App selects the saved file in Explorer. If the saved copy is missing, offer **Download** again |
| A Browser accepted a download request | Direct the recipient to browser downloads for its progress and save location |
| An authorized live holder can supply the original | Download or download again. A verified local copy may help other readers during the live share |
| The room currently has no readable source for a download | Show that the original is temporarily unavailable. Keep the filename and thumbnail visible and allow a retry when a holder returns |
| A member published a separate external link | Open the link under its provider's access rules |

The Windows App records the path reported by the completed platform download.
The attachment card stores an opaque reference scoped to the receiver's site,
identity, room and attachment. Clearing the cache or deleting the message
removes the card's reference. The recipient keeps their saved file.
A sender going offline removes its offer. Another admitted holder can still
serve the same original. A future **Expired** status would require the room
writer to record that the share ended.

## Room maintenance

| Action | Who can do it | Boundary |
| --- | --- | --- |
| Set channel creation and discovery policy | Channel owner | Applies to all rooms in the channel and to later registration or visibility changes |
| Manage room access and invitations | Room owner | The active room writer records grants and revocation. A public directory entry does not grant private entry |
| Enter, read history, download an available attachment, speak, watch or share | People admitted to that room | The channel owner follows ordinary admission to private content. Remote input also requires the source owner's consent |
| Forward a particular flow | A capable endpoint with an explicit relay assignment and available capacity | A service can forward the assigned traffic without acquiring a personal chat or viewing subscription. A lobby peer can assist rendezvous |
| Delete one message | Its authenticated author, the room owner or an admitted channel owner | The writer removes it in that room, including its reactions, thumbnail and attachment references. Other people's replies remain, with the removed quotation unavailable |
| Clear cache | The person controlling that device or an authorized manager of that room's managed storage | Release disposable copies there and unregister sources that disappear. Keep message history, its canonical thumbnails and users' saved downloads |
| Clear room history | The room owner or an admitted channel owner | The current writer confirms the purge. Preserve room identity, settings, grants and monotonic message sequence. Readers, reconnects and future exports reflect the deletion |
| Remove a room from the channel | Its room owner or the channel owner | The channel owner can remove any binding, including hidden, private or offline rooms, without entering them. Old invites, registrations and activity for that binding retire |

The room writer checks current admission for personal content actions,
including deletion by the recorded author or a moderator. A host operating
the room's storage processes the content entrusted to it. Previously saved
participant downloads remain under the recipient's control.

The channel owner's management view exposes only the directory information
needed to identify and remove a room. For a hosted room, removal deletes
the Server's authoritative room records. If cleanup of an offline hosted room
is interrupted, the channel withdraws it from discovery and keeps its ID in the
owner's management list until cleanup succeeds. The owner can retry after a
Server restart. For a lightweight room, an offline
creator's device can retain its local data. That data cannot re-register
the retired binding. A room action never erases files that members saved
independently on their devices.

## Storage, recovery and backup

Room backups and copies preserve message descriptors and thumbnails. **Include
file originals from this device** is enabled by default. The export packages
matching originals the exporting device can read from local sources or cache.
The archive's file inventory lists the originals it contains. Other attachments
are identified by their descriptors in message history. On restore, a readable
original can become a live source again. Channel backups contain channel data
and permitted room summaries.

The [3.0 public Demo deployment profile](../../deploy/systemd/piik-demo.conf.example) starts a lightweight channel with invite-only guest creation. Visitor room histories and thumbnails stay with their own room hosts. The deployment separately controls media relay and STUN.

## Current prototype and acceptance

The channel assigns the room ID and creator. In lightweight mode the client opens the writer in the linked App or Browser store. In hosted mode the embedded Native service binds the room and commits it before creation is confirmed. New messages retain a bounded thumbnail. Historical records containing inline originals can still be read in supported room formats.
[Current room creation](../../src/client/channel/session.ts) · [Current file and image behavior](./channel-storage-and-identity.md#file-sources-and-reachability)

The channel withdraws offline rooms from discovery. A creator can see its own registration, and a session that read a private room or participated in a public one can retain scoped status during hosting interruptions. An exact room entry request can report an offline host. A never-bound creation reservation expires with its creating session and is omitted from the checkpoint. Stopping a host releases its active slot while retaining its bounded recovery registration.
[Current room admission and capacity](../../prototype/channel-core/src/channel.rs) · [Current directory projection](../../prototype/channel-core/src/remote.rs)

Acceptance also covers one creation UI across both channel modes, registered private access after a hosted room's creator leaves, origin changes during guest return, thumbnail display after the original becomes unavailable, local file reopening and new message delivery after a purge. The [TODO ledger](../todo.md) tracks implementation.
