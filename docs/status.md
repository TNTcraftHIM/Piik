# Current Status

Last updated: 2026-10-31

This is the compact execution/deployment index. Product modules own behavior,
[verification status](./verification-status.md) summarizes material evidence limits,
and Git/PRs own completed history.

## Isolated 3.0 Prototype

The [channel prototype](../prototype/channel-server/README.md) has a Rust
coordinator and real Browser chat, screen publications, selective watching and
room voice. Domain admission, room activities/plans and shared transport leases
have separate Rust owners. Rooms created through the interface run in their
owner's Browser or linked App, using the same Rust core through WASM/IndexedDB
or Native/SQLite. The domain keeps their directory summaries and
authenticated bindings; confirmed history and private policy stay with the room.
The [accepted routing foundation](./research/channel-network-design.md) assigns
each room to its actual operator and starts video on usable room paths before
bounded source-rooted convergence. The [data model](./research/channel-storage-and-identity.md)
owns history and file delivery. Browser-hosted rooms share base connections
for reading, bidirectional voice, files and screen startup. The
explicit [Native participant](../prototype/channel-native/README.md) operates
SQLite-backed rooms and forwards encoded Opus and file ranges on the same base paths.
Its media adapter also forwards VP8/H264 with source audio and preserves their
shared source clock.
Chat and history use authenticated requests and room-owner confirmations on
those base paths. File descriptions stay in confirmed history; selected and verified
copies stay with their participants. Screen plans can replace a leaf or relay
branch after its affected viewers prove delivery, while preserving playback.
Server now embeds that same Native participant for its persistent rooms. Domain,
Browser and Native consume one shared Rust core; conversation has one peer carrier.
The combined Native candidate adds a fixed Server UDP entry for self-hosted and
FRP deployments, retaining App peers' existing socket ownership.
App hosting has its own Native endpoint and process lifetime; the Browser's
personal voice, shares and watches remain page-owned. Existing Browser rooms
retain their page lifetime and storage when an App connects.
App discovery and site approval reuse the shared product controls, with one
local data namespace per approved site. The shared launcher starts an App-owned
domain through Local HTTPS or Cloudflare Quick Tunnel; its rooms retain their
identity and storage across local-port and invitation-address changes.
The shared source picker connects Windows hardware H264 capture to the same
Native endpoint and routing model, preserving its original presentation clock.
Optional source sound uses WASAPI and a Rust Opus encoder, retaining independent
stereo channels. The selecting page owns both captures independently of App room hosting.
The macOS ScreenCaptureKit/VideoToolbox adapter uses that same producer and
App path.
Linux uses that same App path through a Portal-owned PipeWire source, independent
GStreamer hardware encoders and optional system-output sound. Server forwarding
builds without the desktop capture dependencies. Linux RemoteDesktop/EIS input
uses that source's Portal permission and the shared input executor; enabling it
preserves the producer and media clock, while cancelling leaves the share running.
Windows keyboard, mouse and optional gamepad input use the selected screen route
and shared control UI, with one App desktop executor, page-owned consent and a
process-only stop hotkey.
The isolated Android shell starts the same Rust App through JNI and opens the
system Browser, using Android certificate trust for site connections. Its system
picker supplies screen capture and optional playback sound to the same Native
producer; permission and first-frame waits retain the page's capture lease.
The shared distribution entry points package the Rust App/Server and Browser
bundle. Android packages ARM64/x64 JNI and the system-browser shell.
[TODO](./todo.md) owns remaining Native media/input and platform work.
Both prototype surfaces share URL bookmarks; automatic address discovery is not planned.
The functional domain and room editors share preset and bounded raster icons
with their existing authority and storage owners; Browser reload and Native
restart preserve the edits.
Message reactions use room-owned history. The room mini window moves the existing
conversation, couch and voice controls between the page and floating/PiP surfaces;
personal drafts, attachment selections and voice participation remain page-owned.
Voice controls reuse one microphone capture across rooms, with device/processing
updates and individual local listening controls. Browser cameras use the same
visual publication and source picker as screen sharing.
Work stays on `feat/channel-prototype`, without changing the production 2.x contract.

## Accepted Release Contract

- The 2.0 release boundary uses Browser/server v24, Native control v10 and
  capture v7. App and Site must upgrade together; 1.x cannot participate in a
  2.0 session. SQLite schema 2 is unchanged.
  [Versioning](./standards/versioning.md#public-compatibility-promise) owns
  compatibility between published Web/App/Server versions.
- Hosted Server defaults to SQLite schema 2. Room authority has no inactivity
  expiry by default; replacement/deletion or grant rotation/revocation ends the
  corresponding authority. Explicit memory mode and App Local end rooms at
  process exit. Site access retains its separate 24-hour idle lifetime within
  one service run; service restart requires site-password entry again.
- Camera sharing and room voice are accepted product features. Source audio
  follows the picture; room voice owns conversation microphones under the
  same route controller. Optional Host commentary belongs to the share's audio
  and has separate activation.
  Device selection and sharing settings keep their owners. The
  [capture assessment](./research/camera-and-microphone.md) owns platform behavior
  and platform limits.

## Accepted Interaction Phase

Text chat, reactions, room voice and attended remote control are accepted product
features. They use existing room authority and the shared route controller;
picture, voice and input grants retain their separate lifetimes. The
[room-interaction design](./research/room-interactions.md) records the design;
[product standards](./standards/README.md) own current behavior.
Release artifacts and operator records own delivery completion.

## Current Work

The maintenance line preserves published protocols, compatibility and route
ownership. [TODO](./todo.md) is the only unfinished-work ledger; Git and PRs own
completed fixes. [Verification status](./verification-status.md) owns material
acceptance and platform boundaries.

The Android system-browser App shares the desktop Web UI and Go core,
including Local/public-link rooms, Site approval, native screen capture and room
voice. Its universal APK covers ARM64 and x64 through the shared release pipeline;
[device evidence](./verification-status.md#device-evidence-boundary) and
[remaining work](./todo.md) retain their existing owners. iOS remains separate.

Room voice, shared keyboard/mouse and optional Windows virtual gamepads use the
normal App/Web interfaces. App packages contain no optional input SDK or driver.
Linux uinput has an isolated kernel check; desktop permission and game-recognition
coverage is pending. macOS virtual HID needs an Apple entitlement and physical
build/runtime checks. The [input assessment](./research/room-interactions.md#remote-co-play)
owns platform details.

App Local invitations use HTTPS on the selected LAN address, with a loopback
entry for the Host. Hosted Server supports direct HTTPS with temporary or
operator-supplied certificates. The [HTTPS runbook](./operations/self-hosting.md)
owns setup. Virtual LANs and frp use the existing room and UDP media paths.
The website uses the selected bilingual film A, loaded on demand with shared
product playback controls and a persistent final card.

Optional coordinated Native UDP preparation augments the existing retry owner.
The [network laboratory](./research/network-lab.md) covers all Browser/App
pairings, recovery, SFU policies and successful two-App preparation through
sequential kernel NAT. These results do not establish a public success rate.
Magicsock integration is not planned; its [controlled comparison](./research/nat-traversal.md#integration-cost-and-recovery-controls)
records the technical basis.

The [media assessment](./research/native-client-media.md#media-capability-extension-assessment)
owns bounded output and live-control evidence. Additional codecs, surround
delivery and end-to-end HDR remain outside the published phase.

## Deployment

The immutable release descriptor, runtime `REVISION` and operator deployment
record own exact identity and postflight results.

The private deployment uses one Go process for Web, room authority/signaling,
STUN and optional SFU, with nginx for HTTPS. The
[self-hosting runbook](./operations/self-hosting.md) owns listeners and network
configuration.

The separate US [public demo](https://demo.piik.tv) is deployed with open site
entry, persistent room authority and P2P-only media. Cloudflare fronts HTTP/WSS
and caches static bundles; STUN uses a separate DNS-only hostname. Caddy owns
origin HTTPS, and the standard systemd service runs the published Server package.
Demo expires rooms after one hour without authenticated participants; the private
deployment retains the default of no expiry. The operator record owns exact
identity and postflight evidence. `piik.tv` runs on GitHub Pages behind
Cloudflare; website delivery includes a bilingual documentation center built
from repository guides.

GitHub owns original Server and App packages; Gitee mirrors them without
rebuilding and verifies anonymous downloads against their checksums. Server
packages cover Linux x64/ARM64 and Windows x64; Docker images are Linux-only.
App packages cover Windows x64 and macOS/Linux x64/ARM64.
Accepted product changes publish through the release workflow; standalone
website/documentation changes deploy the site without creating App/Server
versions. [Versioning](./standards/versioning.md) owns release identity, notes,
compatibility and mirror publication.
