# Channel prototype

An isolated Piik 3.0 experiment: a shared Rust authority, the existing React
interface, and real Browser WebRTC. It does not replace the production 2.x
App or Server. The [network design](../../docs/research/channel-network-design.md)
owns the accepted routing foundation; this file describes what currently runs.

The Server executable consumes [channel-core](../channel-core/README.md), the same
Rust library used by Native and Browser/WASM. Its package and default binary remain
`piik-channel-prototype`; the same runtime crate also builds `piik-channel-app`.
The shared library is `piik-channel-core`.
The [Domain service](./src/domain.rs) owns its HTTP, WebSocket and directory lifetime;
the [Server composition](./src/lib.rs) adds deliberate Native room hosting. Local App
composition reuses the Domain without inheriting that unattended participant.

The Server starts one real [Native participant](../channel-native/README.md) in
its process to operate the three initial rooms. Its lifetime follows the explicit
Server service, independently of administration pages. Rooms created in the interface use
their owner's [Browser/WASM runtime](../channel-browser/README.md) or the
[linked Rust App](#local-app-link). That runtime owns admission,
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
dependencies. Build the [standalone frontend](../channel-browser/README.md)
first, and rebuild it after changing the shared Rust core. From the repository
root, start Rust in one terminal:

```powershell
$env:PIIK_CHANNEL_OWNER_KEY = "<private owner seed for a new domain>"
$env:PIIK_CHANNEL_INVITE_KEY = "<different invitation seed for a new domain>"
$env:PIIK_CHANNEL_WEB_DIR = (Resolve-Path build/channel-web).Path
$env:PIIK_CHANNEL_WEB_ORIGIN = "http://127.0.0.1:8790"
cargo +1.91.0 run --manifest-path prototype/channel-server/Cargo.toml
```

The values above are placeholders. Supply independently generated seeds through
your local environment when creating a domain. Thereafter the domain database
owns its admission keys; changing or removing these environment variables does
not rotate them. Keep both the keys and hosting backups private and out of
committed files and saved logs. Server does not print key-bearing URLs.

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
Optional `PIIK_CHANNEL_INVITATION_ORIGIN` selects a separate public HTTP(S)
origin for invitations and permits that exact WebSocket Origin alongside the
primary UI origin. Both values must be exact origins without paths, credentials,
queries or fragments. The public origin must serve or proxy this same frontend
and domain WebSocket; this setting does not create a listener or tunnel. The
runtime supplies `invitationOrigin` in Welcome only when configured and does not
save it in domain or room data. Keep owner-entry credentials on the local entry.

Server binds loopback by default. `PIIK_CHANNEL_BIND_ADDRESS` selects another
IP address; set `PIIK_CHANNEL_WEB_ORIGIN` to the exact public frontend origin.
Packaged Server resources default to `web/` beside the executable, independently
of its working directory.

Run `piik-server --check-release` to check for an update without starting the
service or supplying room keys. It prints one JSON result and exits with `0`
(up to date), `10` (an official update or different build is available), or `20`
(unavailable). `--api-url <endpoint>` checks that endpoint alone. Released builds
also check once after startup; network access never delays the listener.

For a standalone source deployment, build the
[same frontend as static assets](../channel-browser/README.md), then set
`PIIK_CHANNEL_WEB_DIR` to `build/channel-web/` and `PIIK_CHANNEL_WEB_ORIGIN` to
the service's own origin. Rust serves the frontend and existing WebSocket on
that listener. `/` and `/__channel-preview` open the frontend; missing assets
and unknown API paths return 404. Vite is only the development server; the
deployed frontend requires no Node runtime.

## Local App Link

The `piik-channel-app` entry uses the same App button, local approval page and
saved-site controls as the shared Web interface. Build the frontend and start it:

```powershell
node node_modules/vite/bin/vite.js build --config prototype/channel-browser/web.vite.config.ts
$env:PIIK_CHANNEL_APP_WEB_DIR = (Resolve-Path build/channel-web).Path
$env:PIIK_CHANNEL_CLOUDFLARED = "cloudflared"
cargo +1.91.0 run --manifest-path prototype/channel-server/Cargo.toml --features capture --bin piik-channel-app
```

The App opens its local page in the system Browser, or the saved starred site.
The shared launcher offers **Local network** and **Public invite**. Local uses a
temporary certificate on the selected IPv4 address, including a virtual-LAN
adapter; its fingerprint is printed locally. Follow the existing
[LAN HTTPS instructions](../../docs/guide/troubleshooting.md#local-https-certificate-warning) before
accepting that certificate on another device. Public invite uses Cloudflare Quick
Tunnel. The development command explicitly selects `cloudflared` from PATH;
`PIIK_CHANNEL_CLOUDFLARED` can instead name an installed executable.

Portable App resources have one root: the directory containing the executable,
independent of the working directory. Copy the built `build/channel-web/` contents
to `web/` beside it, and place the matching platform's `cloudflared` executable in
`runtime/tunnel/` (`cloudflared.exe` on Windows). These are the defaults when the
two overrides above are unset. On macOS, keep this same layout inside the bundle's
`Contents/MacOS/` directory. Platform bundles, notices and distribution packaging
use the shared [packaging entry points](../../docs/deployment.md#build-host).

Both modes start one domain with a local owner entry and a separate advertised
invitation entry. Only the loopback launcher receives the owner bootstrap; neither
the LAN nor public listener exposes App approval or control. Returning to the
launcher reopens the same running domain. Startup continues if that page closes;
a failed attempt releases its resources before the next retry.

On a running domain, click **App** and approve the site on that local page.
New rooms then use the App's SQLite storage. The create-room form names the
current hosting runtime. Existing Browser rooms remain in their pages and are
not migrated; a remembered App preference cannot prevent Browser hosting when
the App is absent.

**Share screen** reuses the product source picker for Browser capture and the
App's available sources, with small Native window/display thumbnails. Closing
the picker cancels its pending thumbnails. App capture publishes through that same Native participant;
the selecting page previews it as an ordinary subscriber. Stopping the share or
closing its page stops only its captures, not its hosted rooms. This prototype
uses 1080p/30 fps/4 Mbps H264 for native video, with optional source audio.
The [Native participant](../channel-native/README.md) owns platform capture, shared encoding and
adaptation; [TODO](../../docs/todo.md) tracks its remaining integration.
Browser capture retains its existing behavior.

Approval covers room hosting and local window/screen capture and belongs to an
exact site origin. Earlier room-only consent requires approval again, preserving
the site's room-data namespace. Discovery exposes only the local
approval address; the authorized health response supplies the process token.
The token never appears in launch or room invitation URLs. Native verifies the
Browser account through actual domain admission before opening its room data.
Each approved origin owns a separate local namespace; replacing a tunnel origin
does not silently grant access to an earlier site's data.

Closing the page ends its personal calls and shares, while App hosting continues.
Revoking a site's approval stops that site's hosting and control connections,
preserves its saved rooms and leaves other sites running. Reapproving the same
site reuses its data; returning with the same domain account restores its rooms
without restarting personal activities.

The App's own local entry is approved for its current runtime. Its domain identity,
private startup keys and storage namespace live in `app.sqlite`; the directory
uses `domain/channel.sqlite`, and room databases stay under `rooms/`. A new local
port or public tunnel address does not select another copy of those rooms.
External sites retain their separate exact-origin approval boundary.
App shutdown retires its Native hosts before the domain and tunnel. A local-domain
failure leaves unrelated approved sites' hosting alone.

The App uses the platform's local application-data directory under `Piik/channel-app`.
`PIIK_CHANNEL_APP_DATA_DIR` selects isolated development data. One process owns
that directory. `PIIK_CHANNEL_APP_PORT` may select a loopback port instead of the
normal discovery range; a launch URL can supply the non-secret `piik-client-port`
query parameter. `PIIK_CHANNEL_APP_WEB_DIR` selects the built frontend and
`PIIK_CHANNEL_APP_NO_BROWSER=1` suppresses browser opening for automated checks.

## Design studies

Open `/__channel-design` on the same Vite service for the interactive design
boards. This route needs no channel credential or running Rust service. Direct
links `#chat`, `#screens`, `#focus` and `#create` select the four studies; the
toolbar compares desktop/narrow layouts, the shared light/dark themes and rooms
with 4, 12 or 20 people. `?people=20#chat` opens the crowded-room study directly.

The functional frontend uses the accepted shell: room navigation on the left,
conversation and selected screens in the middle, and a persistent domain-wide
user list on the right. Narrow layouts navigate between room and user panes.
It retains real roles, self-name editing, room controls, files, history, voice
and multiple watched screens through the existing session and shared components.
The domain owner can edit its name and icon beside the domain title.
Room creation and settings share the same identity fields; the room owner or
domain owner saves them at that room's runtime. Both surfaces share preset icons
and custom images. The browser crops images to a small square; saving retains
them with the domain or room metadata, including after a restart.

In the design studies, room creation and editing share one native dialog
with conditional private options. Pencils beside the user, domain and room names
open their corresponding editors. Colours, controls, icons and animated people come from Piik's
existing components. Conversations, pictures and interactions are local samples;
they do not create rooms or transmit media.

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
below their message and are saved by that room's owner. The functional couch
uses the room's personal activity projection, independently of screen sharing.
Both surfaces' **Room mini window** in the room header opens a movable,
resizable view with the same couch, chat and voice controls. Its detach action
uses the existing browser picture-in-picture window where available. Personal
drafts, attachment selections and voice participation remain page-owned;
closing the window returns the controls without leaving voice. It follows the
selected room and preserves its reading position when detached or returned.

The composer supports the attachment button, file drop and image
paste, with a draft preview before sending. Channel appearance and room creation
share the functional prototype's preset icons and custom image picker. These
design-board changes stay in memory. The functional prototype persists its
identity images and uses the same reaction controls, couch and room mini window.

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
confirmed history and loads pages of up to 50; it does not automatically discard
old messages. The interface keeps a reading window of up to 1,000 messages and
lets readers move through earlier pages or return to the latest messages.
Each message supports 2,000 Unicode characters and up to eight attachments.
Read pages and drafts stay in memory; refreshing retrieves history from the host.
There is no separate offline history database or peer history replication.

Browse rooms without moving an existing call, share or subscription. Join voice
with a microphone or listen-only. Microphone mute controls your outgoing room
voice; deafen controls local listening. Their attached volume menus adjust
microphone and total listening gain from 0% to 200%, using the existing local
preferences. Joined rooms share one microphone capture. Multiple users can share simultaneously.
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
participant forwards encoded Opus, VP8 and H264, and publishes App capture through
those same plans. SFU fallback remains later work. WebRTC owns ICE and congestion control.
App and Server use the existing public STUN choices by default. Optional
`PIIK_CHANNEL_ICE_SERVERS` replaces them with an ICE-server JSON array; `[]` disables
STUN for isolated loopback checks. The local checks do not establish a public-NAT
success rate or reliable background Browser service.

A signaling interruption has one 20-second recovery window. A resumed endpoint
retains its committed media and resumes unfinished negotiation on the same
connections; expiry releases captures and transports. Offline
stop, unwatch and leave take effect locally and are reconciled on reconnect.

## Saved data and files

Saved data belongs to its domain or room runtime. Server defaults to
`data/channel.sqlite` beside its executable. `PIIK_CHANNEL_DATA_DIR` chooses a
different real directory; point it at an existing source-run directory to reuse
that data. The domain checkpoint stores catalog summaries, identities and its
owner/invitation admission keys; `rooms/living.sqlite`, `rooms/studio.sqlite` and `rooms/quiet.sqlite`
each store that room's policy, grants and confirmed history. Existing room names
and policy are restored rather than overwritten by startup defaults. The Native
endpoint authenticates with that domain's saved owner key and restored owner identity;
it does not create a new user on every service start.
Browser-owned room policy and history stay in that Browser's IndexedDB; the
domain retains only its directory summary. Messages
commit individually: their room order, send identity and attachment descriptions
are saved in one transaction before confirmation or distribution. A retry returns
the original confirmed message without rebroadcasting it, including after restart.
Storage failure leaves the send unconfirmed and preserves existing records.
User credentials and room invitations are stored as digests, and room passwords
as password hashes. The domain's bootstrap keys are private hosting data.
Sessions, captures and routes are not restored after a process restart.

This unpublished prototype uses hosting metadata version 1 around domain
authority version 4, and room SQLite schema version 3. Older experimental
checkpoints are rejected rather than silently discarding their history. Keep any
old experiment's database and choose a fresh `PIIK_CHANNEL_DATA_DIR` for this version.

UI preferences belong to the client; the Browser also keeps its user credential
locally. Participant reading windows and drafts stay in memory, as do the design
board's sample data and edits. Hosting a room is separate: its saved policy and
history survive reopening, while captures and voice do not restart automatically.
Changing rooms keeps hosted rooms running. Browser-hosted rooms end with their
page; App-hosted rooms end with their App. Personal voice and shares end with
their owning page. Unexpected connection loss uses the recovery window.
Server does not take over.

Native App hosting follows the
[room-data model](../../docs/research/channel-storage-and-identity.md).
`StoredRoomHost` supplies the shared Rust room core's SQLite execution adapter:
one database per room, with confirmations emitted after commit. It owns no
network endpoint or hosting-session lifetime. The separate Native participant
owns those resources and operates one or more rooms through that adapter.
The Server embeds this participant; its separate executable remains an explicit
development host. Explicit App linkage starts a separate Native hosting endpoint
for the same user. Normal Server shutdown first ends Native
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

Run the shared Rust and Browser-adapter checks from the repository root:

```powershell
npm run check:rust
```

This entry point uses Rust 1.91.0 and the Browser adapter's pinned `wasm-bindgen`
and `cargo-about` tools. It collects core tests with and without SQLite, Native
forwarding tests, Server tests including `native_session`, the shared Web/WASM
build, Browser-adapter TypeScript and the finite WebSocket protocol check. The
Web build uses development identity. It builds Native before
the process-lock tests and supplies that executable to them. `CARGO_TARGET_DIR`
selects the shared build directory; the working directory selects the source tree.
It leaves capture disabled, so shared checks need no desktop media SDK or Linux
GStreamer installation. Capture-enabled compilation belongs to platform packaging;
physical capture/input and Browser media acceptance remain separate checks.
The ordinary Web type-check and unit tests remain `npm run typecheck` and `npm test`.

For Browser acceptance, generate the adapter with the command above, build the
capture-enabled App and select the executables when using a custom target directory:

```powershell
cargo +1.91.0 build --manifest-path prototype/channel-server/Cargo.toml --features capture --bin piik-channel-app
node prototype/channel-server/run-browser-check.mjs
node prototype/channel-server/run-browser-check.mjs --rooms
node prototype/channel-server/run-browser-check.mjs --identity
node prototype/channel-server/run-browser-check.mjs --previews
node prototype/channel-server/run-browser-check.mjs --lifecycle
node prototype/channel-server/run-browser-check.mjs --hosts
node prototype/channel-server/run-browser-check.mjs --base
node prototype/channel-server/run-browser-check.mjs --app
```

The real Native session integration tests live in `tests/native_session.rs`
in this crate, including App approval, storage ownership and startup/retry. To run
them separately, build Native first and set `CHANNEL_NATIVE_EXECUTABLE` when using
a custom target directory. Use
`cargo +1.91.0 test --manifest-path prototype/channel-server/Cargo.toml --test native_session`
to run those tests alone. Build Server and App separately as above: App enables
the Native `capture` feature, while Server needs only forwarding. Building both
with `--features capture --bins` would also link desktop capture dependencies
into that Server artifact. `CHANNEL_APP_EXECUTABLE` can select a separately built
App for `--app`.

The [Native participant checks](../channel-native/README.md#checks) add
`--native` for concurrent Browser-to-Native picture, voice and file forwarding,
room storage and restart. `--app` exercises independent App hosting and Browser
participation, including page closure, App loss and saved-room restoration.

The existing CI workflow can compile Native and App against the macOS SDK:

```sh
gh workflow run repository-hygiene.yml --ref feat/channel-prototype -f channel_native=true
```

This opt-in job builds and links test programs without running them. It skips
the maintenance build and publication jobs; ordinary branch pushes stay quiet.

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
driver; prefer `run-browser-check.mjs` for automatic service cleanup. The design-study
route and observation hook are development-only; the static entry mounts the functional
frontend directly. The shared Rust library lives in
`channel-core`; its default build excludes SQLite, and HTTP stays in this Server crate.
