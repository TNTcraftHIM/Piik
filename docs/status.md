# Current Status

Last updated: 2026-10-29

This is the compact execution/deployment index. Product modules own behavior,
[verification status](./verification-status.md) summarizes material evidence limits,
and Git/PRs own completed history.

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

Silip is a personal fork of [Piik](https://github.com/TNTcraftHIM/Piik) at
`e169b48`. It has no public deployment, website or published release yet: the
owner builds from source and runs Silip App on their own computer, using Public
invite for friends. A future Hosted site uses one Go process for Web, room
authority/signaling, STUN and optional SFU, with nginx for HTTPS; the
[self-hosting runbook](./operations/self-hosting.md) owns listeners and network
configuration.

GitHub Releases on `P4-aaaul/Silip` is the only planned package source. Server
packages cover Linux x64/ARM64 and Windows x64; Docker images are Linux-only.
App packages cover Windows x64 and macOS/Linux x64/ARM64.
Accepted product changes publish through the release workflow; standalone
website/documentation changes deploy the site without creating App/Server
versions. [Versioning](./standards/versioning.md) owns release identity, notes,
compatibility and publication.
