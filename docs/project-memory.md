# Project Memory

Last updated: 2026-11-11

This working tree develops the isolated 3.0 model: a shared Rust core across
Server, Native and Browser/WASM, with one shared Web UI for rooms, conversation,
screen sharing, selective watching, voice and App control. Go tooling builds the
separately pinned Cloudflared helper. [Status](./status.md#isolated-30-prototype)
owns the current implementation and delivery snapshot.
The product hierarchy is **Site → Room / 站点 → 房间**. Technical `Domain` and
existing `Channel` identifiers refer to the site's authority/runtime; the
[naming owner](./standards/naming.md) governs user-facing terminology.

Published 2.x has its own [compatibility index](./status.md#accepted-release-contract).
Its maintained behavior and deployment belong to the canonical
[2.x standards](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/README.md)
and [status](https://github.com/TNTcraftHIM/Piik/blob/main/docs/status.md).
The 3.0 owners below define this tree's domain, room and participant model.

## Authority And Lifetimes

- The domain owns persistent user identity, membership, room-host
  bindings and directory summaries. A room's detailed policy and history belong
  to its room runtime; the directory is a projection of those facts.
- Opening a site establishes or restores a user's identity without a separate
  site invitation or passphrase. Users create and manage their own rooms;
  private access belongs to each room. The site operator maintains site metadata
  and backups, without automatically reading or managing another user's room.
- Room admission permits conversation, voice, sharing and watching without
  role groups. Domain/room management follows ownership; remote input still
  requires the source owner's consent.
- Each room owner operates that room in a Browser or Native runtime. Participants
  can share, watch, speak and forward independently of room ownership. One user
  may have separate Browser and App endpoints; identity, live connection and
  personal activity remain distinct.
- Browser hosting ends with its page. App hosting follows its Native endpoint
  and process; Server explicitly supplies unattended hosting. Connecting an App
  does not transfer existing Browser rooms. Personal captures, voice, watches and
  input consent remain page-owned; changing views does not stop other activities.
- Browser room data uses IndexedDB through the shared WASM core; Native uses
  SQLite. Room confirmation follows the owner's storage commit. Saved identity,
  policy and history survive runtime retirement; live transports, captures and
  grants do not become saved activities. There is no automatic room takeover.
- Conversation uses the existing domain WebSocket to reach the actual room host,
  which alone authorizes, stores and signs confirmations. The domain forwards
  plaintext without retaining history. Reading and writing need no peer path.
- One room routing owner plans its base tree and source-specific screen delivery.
  Voice and file bytes/control reuse base paths; selected viewers and necessary
  relays receive pictures. Shared physical connections retain their own leases,
  so retiring one flow does not retire unrelated work. Browser WebRTC and the
  Native RTC SDK own congestion control and transport adaptation; Piik owns
  source clocks, output demand and resource lifetimes.
- Attachment descriptions and bounded image originals or previews belong to confirmed history;
  other complete file copies belong to participants. Ordinary URLs and manual bookmarks locate
  domains. App approval belongs to an exact site origin, independently of saved
  domain identity and room data.

The [network model](./research/channel-network-design.md) owns authority, routing
and activity lifetimes. The [room-data model](./research/channel-storage-and-identity.md)
owns persistence, history, file delivery and identity recovery. Their accepted
boundaries govern implementation; this memory is only a compact map.

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
