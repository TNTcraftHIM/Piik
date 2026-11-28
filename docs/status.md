# Current Status

Last updated: 2026-11-26

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
declined it. New assignments prefer participant paths without sacrificing
reachable viewers. Existing routes keep their normal recovery and proved
direct-path improvement rules.
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
The 3.0 candidate uses the product-version handshake. The first public baseline
and Browser/App mixed-version artifact acceptance remain open.
[3.0 versioning](./standards/versioning.md)

## Accepted Interaction Phase

The 3.0 shared UI brings conversations, files, screen sharing, selective
watching, room voice and attended input into the same room. Full and Minimal share one room layout and activity lifecycle. Full is the default. [Interaction design](./research/room-interactions.md#workspace-hierarchy)

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
