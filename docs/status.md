# Current Status

Last updated: 2026-11-11

This is the compact execution/deployment index. Product modules own behavior,
[verification status](./verification-status.md) summarizes material evidence limits,
and Git/PRs own completed history.

## Isolated 3.0 Prototype

The [channel prototype](../prototype/channel-server/README.md) uses one Rust core
across Server, Native and Browser/WASM, with the shared Web UI for chat, screen
sharing, selective watching, room voice and App control. Normal development and
distribution use these Rust/Web paths; Go tooling only builds the pinned
Cloudflared helper. Work stays on `feat/channel-prototype`, separately from 2.x.
Matched Windows and Android candidates have been delivered for internal testing.
Windows package acceptance passed; installation and runtime acceptance of the
latest Android candidate remain pending. Exact revisions and receipts stay with
the packages.

The site owns user identity and directory summaries. Room plans and shared transport
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
Sites open through ordinary URLs or browser bookmarks; automatic address discovery is not planned.
[Verification status](./verification-status.md) owns evidence and platform limits;
[TODO](./todo.md) owns remaining implementation and acceptance work.

## Accepted Release Contract

Published 2.x wire, Native-control, capture and storage compatibility is owned by
the [maintenance contract](https://github.com/TNTcraftHIM/Piik/blob/main/docs/status.md#accepted-release-contract)
and [published versioning rules](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/versioning.md).
The internal 3.0 candidate uses matching Web/App/Server artifacts under this
tree's [versioning rules](./standards/versioning.md).

## Accepted Interaction Phase

The 3.0 shared UI implements conversation and retained reactions, images/files,
room voice, multiple screen sources with selective watching, and attended input.
Their ownership follows the network and data models above; current platform
coverage is in [verification status](./verification-status.md).
Published 2.x interaction behavior remains with the
[maintenance standards](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/README.md).

## Current Work

First-beta feedback and confirmed blocking defects take priority. Follow-up UI,
terminal and documentation work stays separate from the delivered test package.
Conversation now uses the domain WebSocket to reach its actual room host,
independently of peer reachability. Media and file bytes retain their peer paths.
The delivered candidates include this path, room-list management, responsive
grid/focus viewing and the shared Native picture-quality policy. Data retention
across updates depends on the supported storage formats; older private experiments
follow the [documented reset boundary](../prototype/channel-server/README.md#saved-data-and-files).
Package receipts retain each candidate's exact source and tested scope.
[TODO](./todo.md) owns remaining work and owner holds. Applicable defects continue
to feed the separate 2.x maintenance line, which preserves its published contracts.

## Deployment

3.0 remains an internal candidate. Its Rust runtime setup is owned by the
[Server/App reference](../prototype/channel-server/README.md) and its packaging
and rollout procedure by [deployment](./deployment.md).

Published Demo/private services, website delivery and mirrors remain on the
maintenance line; the [published deployment index](https://github.com/TNTcraftHIM/Piik/blob/main/docs/status.md#deployment)
owns their current arrangement. Immutable release descriptors, runtime `REVISION`
and operator records own exact delivered identity and postflight results.
