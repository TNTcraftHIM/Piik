# Channel prototype

An isolated Piik 3.0 experiment: a shared Rust authority, the existing React
interface, and real Browser WebRTC. It does not replace the production 2.x
App or Server. The [network design](../../docs/research/channel-network-design.md)
owns the accepted routing foundation; this file describes what currently runs.

The Server executable consumes [channel-core](../channel-core/README.md), the same
Rust library used by Native and Browser/WASM. Its package and binary remain
`piik-channel-prototype`; the shared library is `piik-channel-core`.
The [Domain service](./src/domain.rs) owns its HTTP, WebSocket and directory lifetime;
the [Server composition](./src/lib.rs) adds deliberate Native room hosting. Local App
composition can reuse the Domain without inheriting that unattended participant.

The Server starts one real [Native participant](../channel-native/README.md) in
its process to operate the three initial rooms. Its lifetime follows the explicit
Server service, independently of administration pages. Rooms created in the interface use
their owner's [Browser/WASM runtime](../channel-browser/README.md) or the
[linked Rust App](../channel-native/README.md#local-app-link). That runtime owns admission,
policy, activities, publication plans and confirmed history. The domain binds
authenticated runtimes to directory entries and combines their transport demand;
a physical pair remains while any room needs it. Domain WebSocket rendezvous
carries admission, activity changes and repair. Browser-hosted rooms and the
explicit [Native participant](../channel-native/README.md) establish a shared
base tree when an activity needs it. Chat/history use signed requests and room-owner
replies on that tree; files reuse its admitted paths, with the same Rust range-delivery
core running in Browser/WASM and Native participants.

## Run

Use Rust 1.91 or newer, the repository's Node/npm environment and installed npm
dependencies. Build the [Browser adapter](../channel-browser/README.md)
first, and rebuild it after changing the shared Rust core. From the repository
root, start Rust in one terminal:

```powershell
$env:PIIK_CHANNEL_OWNER_KEY = "<private stable owner key>"
$env:PIIK_CHANNEL_INVITE_KEY = "<different private invitation key>"
cargo +1.91.0 run --manifest-path prototype/channel-server/Cargo.toml
```

The values above are placeholders. Supply independently generated keys through
your local environment and keep them stable when reopening persistent data.
Keep them out of committed files and saved logs. Rust does not print key-bearing URLs or
store the raw startup keys in SQLite.

In another terminal, start the development interface:

```powershell
node node_modules/vite/bin/vite.js --config prototype/channel-server/vite.config.ts
```

Open `http://127.0.0.1:8790/__channel-preview#owner=<owner-key>` with your own key.
Use **Invite** in the interface to obtain a member link. Separate browser profiles
represent separate users; tabs in one profile share a saved user credential but
have independent live sessions. The default loopback ports are 8791 for Rust and
8790 for the interface. `PIIK_CHANNEL_PORT`, `PIIK_CHANNEL_UI_PORT` and
`PIIK_CHANNEL_WEB_ORIGIN` allow an isolated instance with matching ports/origin.

## Visual proposal

Open `/__channel-design` on the same Vite service for the interactive design
boards. This route needs no channel credential or running Rust service. Direct
links `#chat`, `#screens`, `#focus` and `#create` select the four studies; the
toolbar compares desktop/narrow layouts, the shared light/dark themes and rooms
with 4, 12 or 20 people. `?people=20#chat` opens the crowded-room study directly.

The proposal places room navigation on the left, conversation and selected
screens in the middle, and a persistent member list on the right. Narrow layouts
use a full member/room pane. Room creation and editing share one native dialog
with conditional private options. Pencils beside the user, channel and room names
open their corresponding editors. Colours, controls, icons and animated people come from Piik's
existing components. Conversations, pictures and interactions are local samples;
they do not create rooms or transmit media. The functional prototype keeps its
existing layout until the owner accepts the visual direction.

Both surfaces share the domain-bookmark rail. Its plus button opens saved addresses:
add a URL and optional local label, edit an address after a move, or remove a bookmark.
Addresses without a scheme use HTTPS; use explicit `http://` for a local HTTP
prototype. Pasted URLs save only their origin, without invitation secrets.
Opening a bookmark uses a new tab at `/__channel-preview`, preserving the current
activity. The list survives refresh in this Browser origin; it does not yet sync
between sites. A bookmark grants no access to a private channel.

The room's compact couch shares the heading with its title and actions; narrow
layouts place it beneath them. It stays visible above conversation and screens.
Seats keep a readable size in one horizontally scrollable row, with your own seat
fixed on the right. Arrow controls and touch scrolling reach the other people;
the full member list scrolls independently. Select a seated person to send
reactions or throw props along the sender-to-recipient path.
The design board uses the production interaction session and effect renderer;
only its transport is a local loopback. Cooldown, repeated throws, acknowledgements
and expiry therefore follow the same behavior as the room interface.
Chat avatars and the member list are informational; message reactions stay
below their message. **Room mini window** beside the share action opens a movable,
resizable view with the same couch, chat and voice shortcuts. Its detach action
uses the existing browser picture-in-picture window where available. Messages,
drafts, attachments, reactions and voice state share the room's owner; closing
the window does not leave the room. It follows the selected room and preserves
its reading position when detached or returned.

The composer supports the attachment button, file drop and image
paste, with a draft preview before sending. Channel appearance and room creation
share preset icons and custom image selection. These design-board changes stay
in memory; room-scoped file transfer is implemented in the functional
prototype, while persistent identity images and reactions remain integration work.

References for spatial hierarchy and viewing modes:
[Discord's server introduction](https://discord.com/blog/starting-your-first-discord-server)
and [Go Live / screen sharing](https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share).
The studies reinterpret those familiar patterns using Piik's visual language.

## Rooms, conversation and media

A channel contains rooms. Users can create and manage their own rooms as room owners (房主);
the domain owner (域主) manages the channel, all rooms and user roles. Both remain
users (用户), independently of sharing activity. Moderator status
does not grant access to another user's private room. Public rooms admit channel
users. Private rooms require a room invitation or password, and hidden rooms do
not appear in an unauthorized user's directory. Changing a password or invitation
controls new admission; existing grants require explicit revocation.

Messages have a confirmed order within their room. The room store retains
confirmed history and loads pages of up to 100; it does not automatically discard
old messages. The interface keeps a reading window of up to 1,000 messages and
lets readers move through earlier pages or return to the latest messages.
Each message supports 2,000 Unicode characters and up to eight attachments.
Read pages and drafts stay in memory; refreshing retrieves history from the host.
There is no separate offline history database or peer history replication.

Browse rooms without moving an existing call, share or subscription. Join voice
with a microphone or listen-only. Microphone mute controls your outgoing room
voice; deafen controls local listening. Multiple users can share simultaneously.
Watch selected pictures in
a grid or focus one picture, with chat alongside or tucked away. These presentation
choices do not implement media layering or a new quality policy. Local previews
stay muted, and pausing a player does not stop forwarding its source.

In Browser- and Native-hosted rooms, reading, voice, sharing and watching share a bounded
base tree rooted at the actual hosting session. Each edge requires an open reliable
DataChannel at both endpoints. Voice follows the needed paths of that tree in
either direction; a participant can forward without joining or hearing the call.
Leaving the room view ends reading, while active media and necessary transit remain.

Each media flow has a lifetime separate from its publication and shared connection.
Unwatching and watching again creates a new flow; late readiness or failure reports
from the retired flow cannot change the replacement or close the room's base path.
Each active picture-preparation attempt has 20 seconds to deliver its first frame,
even on an already connected path. If it expires, the same plan tries another
available path. A downstream hop waiting for its upstream does not spend that
window early. This media timeout keeps unrelated pictures, voice and the room's
base connections.

Each screen keeps its own distribution plan. Startup reuses ready base paths,
including required non-viewing transit. If those paths cannot carry the picture,
the same plan seeks an alternative through the source or ready media relays.
The plan may prepare a direct source path for a leaf or an internal relay while
retaining playback. Each affected viewer must decode, pass the shared quality
comparison and supply a prewarmed frame; pure transit proves forwarding. The
room commits that branch together, keeping its prepared inputs and outputs.
Players adopt their existing candidate elements and source sound, preserving
volume and pause. Candidate failure, changed viewing demand or expiry keeps the
required old paths; view toggles do not restart spent attempts.
Only newly constructed branches use the prototype's small fanout policy; reversing
an existing base path does not discard its third direction. Server-owned default
rooms use the same plans through their real Native endpoint.
Compatible base and media flows reuse physical peer connections. A relay can stop
watching while continuing to serve downstream viewers; its transit ends when that
demand ends. A failed DataChannel repairs its room paths without closing healthy
media on the same connection. Stopping one share keeps unrelated received and
forwarded media alive. Browser relays can decode and re-encode. The Native
participant forwards encoded Opus, VP8 and H264; Native capture and SFU fallback
remain later work. WebRTC owns ICE and congestion control.
Optional `PIIK_CHANNEL_ICE_SERVERS` supplies an ICE-server JSON array; local checks
do not establish public-NAT connectivity or reliable background Browser service.

A signaling interruption has one 20-second recovery window. A resumed endpoint
retains its committed media and resumes unfinished negotiation on the same
connections; expiry releases captures and transports. Offline
stop, unwatch and leave take effect locally and are reconciled on reconnect.

## Saved data and files

Saved data belongs to its domain or room runtime. This Server prototype defaults to
`build/channel-prototype-data/channel.sqlite`. `PIIK_CHANNEL_DATA_DIR` chooses a
different real directory. The domain checkpoint stores catalog summaries and
identities; `rooms/living.sqlite`, `rooms/studio.sqlite` and `rooms/quiet.sqlite`
each store that room's policy, grants and confirmed history. Existing room names
and policy are restored rather than overwritten by startup defaults. The Native
endpoint authenticates with the configured owner key and restored owner identity;
it does not create a new user on every service start.
Browser-owned room policy and history stay in that Browser's IndexedDB; the
domain retains only its directory summary. Messages
commit individually: their room order, send identity and attachment descriptions
are saved in one transaction before confirmation or distribution. A retry returns
the original confirmed message without rebroadcasting it, including after restart.
Storage failure leaves the send unconfirmed and preserves existing records.
User credentials/invitations are stored as digests and room passwords as password
hashes. Sessions, captures and routes are not restored after a process restart.

This unpublished prototype uses checkpoint version 3. Older experimental
checkpoints are rejected rather than silently discarding their history. Keep any
old experiment's database and choose a fresh `PIIK_CHANNEL_DATA_DIR` for this version.

UI preferences belong to the client; the Browser also keeps its user credential
locally. Participant reading windows and drafts stay in memory, as do the design
board's sample data and edits. Hosting a room is separate: its saved policy and
history survive reopening, while captures and voice do not restart automatically.
Changing rooms keeps hosted rooms running. Closing the owning page ends hosting;
unexpected connection loss uses the recovery window. Server does not take over.

Native App hosting follows the
[room-data model](../../docs/research/channel-storage-and-identity.md).
`StoredRoomHost` supplies the shared Rust room core's SQLite execution adapter:
one database per room, with confirmations emitted after commit. It owns no
network endpoint or hosting-session lifetime. The separate Native participant
owns those resources and operates one or more rooms through that adapter.
The Server embeds this participant; its separate executable remains an explicit
development host. App linkage remains separate work and does not give a standby
App an unattended hosting lifetime. Normal Server shutdown first ends Native
hosting and releases its room locks, then closes the HTTP service. A Native
hosting failure also stops that service.
A new service URL can use the same database, but a
new Browser origin cannot read the previous origin's saved login or bookmarks.

Messages contain complete file descriptions and their SHA256 digest. The selected
file stays with its sender; a confirmed message does not upload bytes to the domain
or room database. Browser- and Native-hosted rooms authorize requests from retained
messages and deliver bytes through the existing room base tree, including the
three default Server rooms. The domain database stores no file content.

Concurrent recipients share requested ranges through relays. Each recipient
advances after its local write; cancellation only removes that recipient's demand.
Network repair retains written progress. Completed copies may supply later
requests, and idle copies alone do not keep room connections alive. If all copies
disappear, the message remains but its file is unavailable.

The shared Rust limits owner supplies the composer with the prototype's 16 MiB
file bound and eight attachments per message. The byte engine owns a bounded range
window across rooms, separate from the media/control queues. The Browser writes
temporary files through OPFS, then verifies the full size and digest before
preview or download. Recognized PNG/JPEG/GIF/WebP images use the same file model.
A receiving Browser needs secure-context file storage; there is no in-memory
whole-file fallback. Selected and verified copies belong to the current session.
Current access controls offers and downloads; already downloaded bytes cannot be revoked.

Replicated history, federation and authority handoff remain outside this slice.
Other current resource bounds are 20 live endpoints, 64 stored users and 32
rooms. Each endpoint may publish one screen and one voice source per room.

## Checks

Build the executable before running the finite integration checks:

```powershell
cargo +1.91.0 test --manifest-path prototype/channel-server/Cargo.toml
cargo test --manifest-path prototype/channel-core/Cargo.toml
cargo test --manifest-path prototype/channel-core/Cargo.toml --features sqlite
cargo +1.91.0 build --manifest-path prototype/channel-server/Cargo.toml
node prototype/channel-browser/build.mjs
npm run typecheck
node prototype/channel-server/run-browser-check.mjs --protocol
node prototype/channel-server/run-browser-check.mjs
node prototype/channel-server/run-browser-check.mjs --rooms
node prototype/channel-server/run-browser-check.mjs --lifecycle
node prototype/channel-server/run-browser-check.mjs --hosts
node prototype/channel-server/run-browser-check.mjs --base
```

The [Native participant checks](../channel-native/README.md#checks) add
`--native` for concurrent Browser-to-Native picture, voice and file forwarding,
room storage and restart. `--app` exercises local room execution through the
Browser's existing participation, including App loss and saved-room restoration.

Browser checks require `agent-browser` and its installed Chromium. The runner
chooses free loopback ports and temporary test keys, starts its own Rust/Vite
services, runs acceptance, and stops them on exit. It does not leave a preview
service running or restart another instance. Default acceptance covers multiple
real Browser peers and relay recovery; `--rooms` exercises room access and files;
`--lifecycle` focuses on capture, offline intent and expiry; `--hosts` exercises
separate domain/Browser ownership, private admission, room recovery, cross-room
media and actual IndexedDB/SQLite placement. `--base` blocks one direct negotiation
and verifies bidirectional voice through a non-listening relay, DataChannel failure
recovery and independent cross-room media leases. Generated captures
replace only the system picker, not business state, routing or peer connections.
The Rust runtime checks cover room storage, restart, failed writes and orderly
shutdown. The Browser runner accepts `CHANNEL_EXECUTABLE` to test a separate build while an older
preview remains running; otherwise they use the normal debug executable.

`--protocol` runs the WebSocket check with its own temporary service. Against
an already running isolated instance, use
`node --import tsx --test prototype/channel-server/check.mjs` with its local key/endpoint
environment variables. `browser-acceptance.mjs` is the corresponding Browser
driver; prefer `run-browser-check.mjs` for automatic service cleanup. The preview
route and observation hook are development-only. The shared Rust library lives in
`channel-core`; its default build excludes SQLite, and HTTP stays in this Server crate.
