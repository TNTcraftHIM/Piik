# Project Memory

Last updated: 2026-11-18

This working tree develops the isolated 3.0 model: a shared Rust core across
Server, Native and Browser/WASM, with one shared Web UI for rooms, conversation,
screen sharing, selective watching, voice and App control. Go tooling builds the
separately pinned Cloudflared helper. [Status](./status.md#isolated-30-prototype)
owns the current implementation and delivery snapshot.
The target hierarchy is **Channel → Room → Activity / 频道 → 房间 → 业务**.
The current Web UI uses Site / 站点 for a channel. Technical identifiers keep
their published spelling. [Naming](./standards/naming.md)

Published 2.x maintains its own [compatibility index](./status.md#accepted-release-contract)
and [product standards](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/README.md).

## Authority And Lifetimes

- The channel owns identities, room-to-host bindings, creation policy and
  the permitted directory. The channel owner may remove any room, including
  a private or offline room. Reading its contents requires ordinary room
  admission. The room owner manages the room. Senders can delete their own
  messages, and room moderation runs through the current room writer.
- Creation uses one action. A lightweight channel puts the room on its
  creator's device. An App starts this mode. A standalone Server can also
  operate a hosted channel, providing a room writer for every room even when
  the creators are away. The mode determines storage placement. Room access
  determines the audience. The public lobby publishes reachable rooms within
  the channel's discovery policy. [Hosting and moderation](./research/server-hosting-plan.md)
- The current room writer owns detailed policy and confirmed conversation.
  Chat can reach it through channel signaling. Thumbnails and file metadata
  are message history. Original files are supplied by eligible holders and
  explicit local saves. A permitted service can forward a live file transfer.
  Ordinary invitations address a particular origin. An App approval, a
  channel's saved identity and a browser's local room data have distinct lifetimes.
- A channel has one graph of confirmed endpoint pairs. A room uses its
  authorized subgraph. Each publication selects directed delivery paths on
  those pairs, including authorized peer or service relays. A business can
  request a missing pair. Once confirmed it becomes reusable by other eligible
  flows. The forwarding limit applies independently to files, voice and
  screens. [Forwarding model and planner](./research/channel-forwarding-plan.md)
- A person can have separate Browser and App endpoints and can share, watch,
  speak or forward independently of ownership. Personal captures, voice,
  watches and remote-input consent follow the activity. Changing the current
  view preserves those activities. App hosting follows the Native process.
  Browser hosting follows its page. Connecting an App does not transfer an
  existing Browser room.
- The prototype stores Browser rooms in IndexedDB through WASM and Native
  rooms in SQLite. Confirmation follows the writer's storage commit. Runtime
  activities retire separately from saved identity, policy and history.
  Live profile summaries and bounded historical profile reads use the same
  Browser display cache for names, avatars, offline people and mention search.

The [current network model](./research/channel-network-design.md) and
[current room-data model](./research/channel-storage-and-identity.md) describe
the running prototype and identify the differences from the target designs.

## Working References

- [Engineering maps and source index](./standards/engineering.md#source-index)
  locate module, interface and resource owners.
- [Server/App reference](../prototype/channel-server/README.md) owns runtime
  setup and shared UI flows; [Native reference](../prototype/channel-native/README.md)
  owns media/platform setup and dependency provenance;
  [Android runtime](../mobile/README.md) owns its shell.
- [Visual language](./standards/visual-language.md) and
  [naming and copy](./standards/naming.md) own shared presentation.
- [Versioning](./standards/versioning.md) owns compatibility and identifier roles;
  [delivery](../CONTRIBUTING.md) and [deployment](./deployment.md) own their workflows.
- [TODO](./todo.md) is the remaining-work ledger;
  [verification status](./verification-status.md) owns evidence and platform limits.
  Release metadata owns exact artifact identity; Git and PRs own completed history.
