# Channel prototype

An isolated Piik 3.0 experiment: a shared Rust authority, the existing React
interface, and real Browser WebRTC. It does not replace the production 2.x
App or Server. The [network design](../../docs/research/channel-network-design.md)
owns the accepted routing foundation; this file describes what currently runs.

The current coordinator still runs every room and saves its history/files.
Moving those responsibilities to the actual room owner, and sharing a base
room network beneath media, remain unimplemented. Data ownership and synchronization
details are the current discussion before that integration.

## Run

Use Rust 1.86 or newer, the repository's Node/npm environment and installed npm
dependencies. From the repository root, start Rust in one terminal:

```powershell
$env:PIIK_CHANNEL_OWNER_KEY = "<private stable owner key>"
$env:PIIK_CHANNEL_INVITE_KEY = "<different private invitation key>"
cargo run --manifest-path prototype/channel-server/Cargo.toml
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
in memory; room-scoped file upload is already implemented in the functional
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

Messages are attributed and ordered by the authority. History keeps the latest
1,000 messages per room and loads in pages of up to 100. Each message supports
2,000 Unicode characters and up to eight attachments. The interface keeps read
pages and drafts in memory; refreshing retrieves history from the host. There is
no separate offline history database or peer history replication.

Browse rooms without moving an existing call, share or subscription. Join voice
with a microphone or listen-only. Microphone mute controls your outgoing room
voice; deafen controls local listening. Multiple users can share simultaneously.
Watch selected pictures in
a grid or focus one picture, with chat alongside or tucked away. These presentation
choices do not implement media layering or a new quality policy. Local previews
stay muted, and pausing a player does not stop forwarding its source.

Each publication has its own bounded distribution tree: the source first serves
two subscribers, then ready subscribers can relay. Compatible flows reuse physical
peer connections. Stopping one share keeps unrelated received and forwarded media
alive. Browser relays can decode and re-encode; Native encoded forwarding and SFU
fallback are not implemented here. Browser WebRTC owns ICE and congestion control.
Optional `PIIK_CHANNEL_ICE_SERVERS` supplies an ICE-server JSON array; local checks
do not establish public-NAT connectivity or reliable background Browser service.

A signaling interruption has one 20-second recovery window. A resumed endpoint
retains its committed media; expiry releases captures and transports. Offline
stop, unwatch and leave take effect locally and are reconciled on reconnect.

## Saved data and files

Authoritative saved data belongs to the hosting coordinator, on the local device
or configured server running it. This Server prototype defaults to
`build/channel-prototype-data/channel.sqlite`. `PIIK_CHANNEL_DATA_DIR` chooses a
different directory; `:memory:` selects an explicitly temporary instance.
Catalog, identities, room policy/grants, retained history and retry deduplication
are checkpointed together before successful operations are acknowledged. A write
failure rolls back the live change. User credentials/invitations are stored as
digests and room passwords as password hashes. Sessions, captures and routes are
not restored after a process restart.

UI preferences belong to the client; the Browser also keeps its user credential
locally. Read pages and drafts stay in memory, as do the design board's sample
data and edits. They are not a second authoritative store.

Native App hosting/persistence remains a design step under the
[room-data model](../../docs/research/channel-storage-and-identity.md).
The Server prototype's saved database does not implement that App lifecycle or
add distribution packages. A new service URL can use the same database, but a
new Browser origin cannot read the previous origin's saved login or bookmarks.

Files use authenticated HTTP to the authority, independently of media routes.
The uploader can preview an uploaded draft; other authorized room users can read
it only after its message commits. Removing a draft uses a conditional discard
that cannot delete an already-sent attachment. Committed files remain available
when the uploader leaves. Current room access is checked on metadata/content
requests and during download; revocation or deletion interrupts remaining transfer.
Already downloaded bytes cannot be revoked.

The resource owner exposes actual limits through
`GET /prototype/channel/limits`:

| Budget | Prototype default | Configuration |
| --- | --- | --- |
| One file | 16 MiB | `PIIK_CHANNEL_FILE_LIMIT` in bytes |
| Stored content | 128 MiB | `PIIK_CHANNEL_ATTACHMENT_BUDGET` in bytes |
| Stored attachments | 256 | Prototype bound |
| Concurrent byte transfers | 2 | Prototype bound |

The UI reads the limits rather than maintaining another size policy. Recognized
PNG/JPEG/GIF/WebP content can be previewed; other content is downloaded, with
attachment disposition and `nosniff`. Unsent uploads older than one hour are
cleaned on the next save/upload/startup. Content referenced only by messages
that leave retained history is removed with that checkpoint. Explicit deletion
also releases storage.

SQLite BLOBs and bounded checkpoint writes keep this prototype self-contained;
they are not an unlimited file service or an incremental storage engine.
Authority-hosted uploads/downloads consume the host's bandwidth. P2P file offers,
replicated history, federation and authority handoff are outside this slice.
Other current resource bounds are 20 live endpoints, 64 stored users, 32 rooms
and 80 publications; connection counts are not a bandwidth guarantee.

## Checks

Build the executable before running the finite integration checks:

```powershell
cargo test --manifest-path prototype/channel-server/Cargo.toml
cargo test --manifest-path prototype/channel-server/Cargo.toml --no-default-features --lib
cargo build --manifest-path prototype/channel-server/Cargo.toml
npm run typecheck
node prototype/channel-server/storage-check.mjs
node prototype/channel-server/run-browser-check.mjs
node prototype/channel-server/run-browser-check.mjs --rooms
node prototype/channel-server/run-browser-check.mjs --lifecycle
```

Browser checks require `agent-browser` and its installed Chromium. The runner
chooses free loopback ports and temporary test keys, starts its own Rust/Vite
services, runs acceptance, and stops them on exit. It does not leave a preview
service running or restart another instance. Default acceptance covers multiple
real Browser peers and relay recovery; `--rooms` exercises room access and files;
`--lifecycle` focuses on capture, offline intent and expiry. Generated captures
replace only the system picker, not business state, routing or peer connections.
The storage check owns an isolated temporary database and tests real HTTP,
WebSocket, process restart and failed-write rollback.

For a WebSocket-only check against an already running isolated instance, use
`node --test prototype/channel-server/check.mjs` with its local key/endpoint
environment variables. `browser-acceptance.mjs` is the corresponding Browser
driver; prefer `run-browser-check.mjs` for automatic service cleanup. The preview
route and observation hook are development-only. The shared Rust library builds
without the `server` feature, excluding Axum and SQLite from that core boundary.
