# Current Status

Last updated: 2026-11-13

This is the compact execution/deployment index. Product modules own behavior,
[verification status](./verification-status.md) summarizes material evidence limits,
and Git/PRs own completed history.

## Isolated 3.0 Prototype

The [3.0 site-and-room prototype](../prototype/channel-server/README.md) uses one Rust core
across Server, Native and Browser/WASM, with the shared Web UI for chat, screen
sharing, selective watching, room voice and App control. Normal development and
distribution use these Rust/Web paths; Go tooling only builds the pinned
Cloudflared helper. Work stays on `feat/channel-prototype`, separately from 2.x.
Matched Windows App and Linux x64 Server candidates have been delivered for
internal testing with the current protocol and shared frontend. Windows includes
the integrated system-WebView window and custom device permission prompts; both
packages passed their scoped runtime acceptance. Matching-package acceptance on
Android remains open; the preceding Android package does not match this protocol.
Exact revisions and receipts stay with the immutable packages, and
[verification status](./verification-status.md) records their tested scope.

The site owns user identity and directory summaries. Room plans and shared transport
leases keep separate Rust owners. Rooms created in the UI run in their owner's
Browser or linked App; confirmed history and private policy stay there. Browser
hosting uses WASM/IndexedDB; Native uses Rust/SQLite. Server embeds a Native
participant for persistent rooms and retains its fixed UDP deployment entry.

App hosting follows its Native endpoint and process lifetime. Personal voice,
shares, watches and capture consent remain page-owned; connecting an App does not
transfer existing Browser rooms. The shared launcher supports Local HTTPS and
Cloudflare public invitations, with separate data per approved site. The App saves
its local site address for later starts. Changes to the public invitation address
do not replace Native room identity or storage.

The [network model](./research/channel-network-design.md) owns routing and activity
lifetimes; the [data model](./research/channel-storage-and-identity.md) owns identity,
history, reactions and participant-held files. The
[Server reference](../prototype/channel-server/README.md) covers shared UI/App flows;
the [Native reference](../prototype/channel-native/README.md) covers capture, encoding,
sound and input, with the [Android runtime](../mobile/README.md) owning its shell.
Sites open through ordinary URLs, Browser bookmarks or the App's local saved-site
list. Browser invitations can be opened in a running native-window App through
local confirmation. Navigation remains separate from device approval; automatic
address discovery is not planned.
[Verification status](./verification-status.md) owns evidence and platform limits;
[TODO](./todo.md) owns remaining implementation and acceptance work.

## Accepted Release Contract

Published 2.x wire, Native-control, capture and storage compatibility is owned by
the [maintenance contract](https://github.com/TNTcraftHIM/Piik/blob/main/docs/status.md#accepted-release-contract)
and [published versioning rules](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/versioning.md).
The internal 3.0 candidate uses matching Web/App/Server artifacts under this
tree's [versioning rules](./standards/versioning.md).

## Accepted Interaction Phase

The 3.0 shared UI implements conversation and retained reactions, unread markers,
mentions and replies, Markdown with copyable code blocks, inline image previews
and file delivery, room voice, multiple screen sources with selective watching,
personal sound choices and attended input.
The full workspace remains the default; an optional screen-centred interface
keeps the same rooms and activities. A first-use suggestion appears only in an
empty site without a saved view choice; invitations and existing rooms remain
direct, and the choice can be changed later from Interface settings.
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

Independent text automation and local OBS input reuse the conversation and source
owners described in the [integration boundaries](./research/room-interactions.md#extension-boundaries).
The matched candidate set now includes local OBS input on supported desktop Apps,
with Windows media and lifecycle evidence. The delivered Windows candidate integrates
the shared interface into a system WebView window, retaining an explicit Browser
entry. The [runtime assessment](./research/cross-platform-client-runtime.md#30-system-webview-client-evaluation)
separates earlier proof evidence from the integrated package's acceptance;
other desktop platforms retain their current entry.

## Deployment

3.0 remains an internal candidate. Its Rust runtime setup is owned by the
[Server/App reference](../prototype/channel-server/README.md) and its packaging
and rollout procedure by [deployment](./deployment.md).

Published Demo/private services, website delivery and mirrors remain on the
maintenance line; the [published deployment index](https://github.com/TNTcraftHIM/Piik/blob/main/docs/status.md#deployment)
owns their current arrangement. Immutable release descriptors, runtime `REVISION`
and operator records own exact delivered identity and postflight results.
