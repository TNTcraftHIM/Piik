# Current Status

Last updated: 2026-11-22

## Isolated 3.0 Prototype

The internal Windows x64 App, Linux x64 Server and universal Android test APK
ship the same Web bundle. They use the shared Rust core and Web UI on
`feat/channel-prototype`. Package receipts own exact builds and individual
platform results. [Verification scope](./verification-status.md)

The channel owns identity and room discovery. The room writer runs on the creator's
device in a lightweight channel, or on the Server for a hosted channel. The public
Demo profile admits guest-created rooms by invitation.
[Hosting and moderation](./research/server-hosting-plan.md)

Conversation reaches the room writer through the site WebSocket. Each screen,
voice source, file holder and forwarded webpage source uses its own delivery
paths on authorized connections. Optional site forwarding uses the Server's
Native endpoint for the kinds its operator offers, in rooms that have not
declined it. A route is assigned to it only for a receiver no participant path
can serve then, and that receiver keeps it until it fails or demand ends.
[Network model](./research/channel-network-design.md) ·
[Data model](./research/channel-storage-and-identity.md)

The Windows App uses the shared interface in a system WebView and offers a
Browser entry. [Desktop runtime](./research/cross-platform-client-runtime.md#30-system-webview-client-evaluation)
The [Server/App reference](../prototype/channel-server/README.md),
[Native reference](../prototype/channel-native/README.md) and
[Android runtime](../mobile/README.md) cover platform setup and use.

## Accepted Release Contract

Published 2.x compatibility is owned by the
[maintenance contract](https://github.com/TNTcraftHIM/Piik/blob/main/docs/status.md#accepted-release-contract)
and its [versioning rules](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/versioning.md).
Internal 3.0 uses matching artifacts under this tree's
[versioning rules](./standards/versioning.md) and
[saved-data formats](../prototype/channel-server/README.md#saved-data-and-files).

## Accepted Interaction Phase

The 3.0 shared UI brings conversations, files, screen sharing, selective
watching, room voice and attended input into the same room. The full workspace
is the default, and the optional screen-centred view shares the room and
activity lifetimes. [Interaction design](./research/room-interactions.md#workspace-hierarchy)

## Current Work

First-beta feedback and confirmed blocking defects take priority. The first
public 3.0 contract and wider website, network and physical-device acceptance
remain open. Applicable defects also feed the separate 2.x maintenance line.
[TODO](./todo.md)

## Deployment

3.0 remains an internal candidate. The
[Server/App reference](../prototype/channel-server/README.md) owns Rust runtime
setup and [deployment](./deployment.md) owns packaging and rollout.

Published Demo/private services, website delivery and mirrors remain on the
maintenance line. [Published deployment index](https://github.com/TNTcraftHIM/Piik/blob/main/docs/status.md#deployment)
Immutable release descriptors, runtime `REVISION` and operator records own
exact delivered identity and postflight results.
