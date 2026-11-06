# Current Status

Last updated: 2026-11-06

This is the compact execution/deployment index. Product modules own behavior,
[verification status](./verification-status.md) summarizes material evidence limits,
and Git/PRs own completed history.

## Isolated 3.0 Prototype

The [channel prototype](../prototype/channel-server/README.md) uses one Rust core
across Server, Native and Browser/WASM, with the shared Web UI for chat, screen
sharing, selective watching, room voice and App control. Normal development and
distribution use these Rust/Web paths; Go tooling only builds the pinned
Cloudflared helper. Work stays on `feat/channel-prototype`, separately from 2.x.
Windows and Android normal-package candidates are available for initial internal
testing. Exact delivered revisions remain in artifact metadata.

The domain owns admission and directory summaries. Room plans and shared transport
leases keep separate Rust owners. Rooms created in the UI run in their owner's
Browser or linked App; confirmed history and private policy stay there. Browser
hosting uses WASM/IndexedDB; Native uses Rust/SQLite. Server embeds a Native
participant for persistent rooms and retains its fixed UDP deployment entry.

App hosting follows its Native endpoint and process lifetime. Personal voice,
shares, watches and capture consent remain page-owned; connecting an App does not
transfer existing Browser rooms. The shared launcher supports Local HTTPS and
Cloudflare public invitations, with separate data per approved site. Room identity
and storage survive local-port and invitation-address changes.

The [network model](./research/channel-network-design.md) owns routing and activity
lifetimes; the [data model](./research/channel-storage-and-identity.md) owns identity,
history, reactions and participant-held files. The
[Server reference](../prototype/channel-server/README.md) covers shared UI/App flows;
the [Native reference](../prototype/channel-native/README.md) covers capture, encoding,
sound and input, with the [Android runtime](../mobile/README.md) owning its shell.
Both prototype surfaces share URL bookmarks; automatic address discovery is not planned.
[Verification status](./verification-status.md) owns evidence and platform limits;
[TODO](./todo.md) owns remaining implementation and acceptance work.

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
  and has separate activation. Device selection and sharing settings keep their
  owners; the [capture assessment](./research/camera-and-microphone.md) owns platform limits.

## Accepted Interaction Phase

Text chat, reactions, room voice and attended remote control are accepted product
features. They use existing room authority and the shared route controller;
picture, voice and input grants retain their separate lifetimes. The
[room-interaction design](./research/room-interactions.md) records the design;
[product standards](./standards/README.md) own current behavior.
Release artifacts and operator records own delivery completion.

## Current Work

The maintenance line preserves published protocols, compatibility and route ownership.

The published Android App shares the desktop Web UI and Go core through the system
Browser, including Local/public links, Site approval, native capture and voice.
Its APK covers ARM64/x64; iOS remains separate.

Room voice, keyboard/mouse and optional Windows virtual gamepads use normal App/Web
interfaces, without optional input SDKs or drivers in the package. The
[input assessment](./research/room-interactions.md#remote-co-play) owns platform boundaries.

App Local invitations use HTTPS on the selected LAN address, with a loopback
entry for the Host. Hosted Server supports direct HTTPS with temporary or
operator-supplied certificates. The [HTTPS runbook](./operations/self-hosting.md)
owns setup. Virtual LANs and frp use the existing room and UDP media paths.

Optional coordinated Native UDP preparation augments the existing retry owner.
The [network laboratory](./research/network-lab.md) owns Browser/App, recovery,
SFU and kernel-NAT evidence.
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
deployment retains the default of no expiry. `piik.tv` runs on GitHub Pages behind
Cloudflare; the [website runbook](./operations/website.md) owns delivery and its bilingual guide center.

GitHub owns original Server and App packages; AtomGit mirrors them without
rebuilding and verifies anonymous downloads against their checksums. Server
packages cover Linux x64/ARM64 and Windows x64; Docker images are Linux-only.
App packages cover Windows x64 and macOS/Linux x64/ARM64.
Accepted product changes publish through the release workflow; standalone
website/documentation changes deploy the site without creating App/Server
versions. [Versioning](./standards/versioning.md) owns release identity, notes,
compatibility and mirror publication.
