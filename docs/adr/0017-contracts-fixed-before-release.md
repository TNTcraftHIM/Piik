# ADR-0017: Contracts Fixed Before The First 3.0 Release

- Status: proposed
- Date: 2026-11-25

## Context

3.0 is unpublished, so a private wire or storage shape is replaced without
aliases, dual readers or migrations. After the first release, installed Apps
and room stores hold the released shapes, and later versions have to work with
them. Some contracts are costly to change after that; others can wait for a
consumer. [Versioning](../standards/versioning.md) promises that an older App
keeps working with a newer site within a major version, and that forward
upgrades preserve durable authority. The private implementation currently has
these boundaries:

- Channel joins and local App discovery each require their current wire
  identifier (`prototype/channel-core/src/lib.rs`,
  `src/client/channel/app-link.ts`). Capture descriptions accept additions;
  selected capture results remain strict.
- The Browser's pending request validates its terminal result
  (`src/client/channel/session.ts`). Unknown or mismatched outcomes reject that
  operation. The first published reader must retain this boundary when an
  extension is selected.
- A room store opens only at one exact `user_version`
  (`prototype/channel-core/src/storage.rs`), and the Browser store aborts any
  upgrade (`prototype/channel-browser/src/room-host.ts`). This protects data;
  no format change has needed an upgrade yet.

## Decision

### Settled before the first public release

1. **Compatibility.** A stable wire baseline, plus extensions the recipient
   selects. A written matrix covers an old client with a new domain, an old
   writer with a new domain, unsupported actions, and the direction of
   stored-data upgrades. Readers ignore additions defined as descriptive, not
   unknown authority or an unknown final outcome: an unknown reply type is an
   error, and an unknown host-input action needs a positive capability check.
   Extension points are explicit instead of a general tolerance
   ([RFC 9413](https://www.rfc-editor.org/rfc/rfc9413.html)). The first
   release's readers decide what later versions may add.
   An unselected result kind is a sender protocol error. A reader that cannot
   decode the event may end the session; one that can correlate the reply
   rejects its unknown terminal outcome. Only the expected outcome confirms
   the operation.
2. **Replies.** A request ends in an explicit terminal outcome that tells
   rejected from unknown, and a copy sent to an observer is separate from the
   requester's reply. Idempotency is scoped by operation: chat already has
   durable nonces, and an invitation rotation is recovered by reading current
   state. History uses one signed, bounded page containing messages and their
   reaction snapshots. A released client that reads an unknown outcome as success
   cannot be corrected from the domain.
3. **Storage.** The baseline covers Domain and room stores, portable archives,
   App settings, and Browser identity and read-position records. Retain inputs
   produced by the released writers. Compatible upgrades preserve authority,
   approved-origin scopes, data namespaces, identity credentials and valid
   configuration. Missing or malformed optional local preferences may use
   defaults; they never replace saved identity or restore authority. Add a
   concrete transactional upgrade only when a representation changes, and
   refuse a newer store before modification. No general migration framework
   is required.
4. **Restored history.** A restore gives the room's history a new lineage that
   invalidates old read positions, and a normal restart keeps them. A position
   a released reader saved without a lineage cannot later be told apart from
   one that a restore made stale.
5. **History rules and durability.** One owner holds the history rules that
   both writers execute. Authoritative IndexedDB writes use strict durability,
   because the architecture promises that history is committed before it is
   confirmed. Persistent storage guards against eviction and is requested at
   explicit hosting, not on every reconnect. A confirmed message that was lost
   cannot be recovered by a later version.

### First public baseline

At the first public release, the owner selects the matched App, Web and Server
revision. Its retained readers and writer-produced storage fixtures define the
baseline protected by [versioning](../standards/versioning.md).

Compatible releases keep the baseline protocol identifiers. Older Apps with
newer Sites, newer Apps with older Sites, and older room writers with newer
channels keep their established commands and results. A new command, result kind
or automatic-selection output is sent only after the receiving peer selects
support through the existing feature owner.

### Deferred until a consumer needs it

- **Schema source.** Defer a generation chain until a concrete consumer reduces
  overall ownership. Generated types must preserve required, omitted and null
  semantics and runtime validation, and replace their old owner.
- **State revision.** Reopens when a delta or resume consumer needs it.
  Readers already accept an added top-level field.
- **Activity envelope.** Dispatch over the owned kinds is exhaustive now. A
  generic envelope reopens when a concrete extension shows that it removes
  work without erasing the different authority and lifetime of each kind.
- **Bytes.** Effect outputs become binary first: a 64 KiB watch delivery
  measured 66,773 bytes as binary and 240,441 bytes in outgoing JSON effects.
  The encoding of small wire keys reopens only if a measurement supports it.

## Not Decided Here

- The serialization format. All three clean-room designs chose Protocol
  Buffers for its evolution rules and breaking-change tooling. The decisions
  above hold for the present JSON as well, so the format can be weighed
  separately.
- One SQLite schema in every runtime, using SQLite on the Browser's private
  file system in place of IndexedDB. It would make decision 5 structural. It
  needs a measurement of size and start-up cost first.
- Moving the client engine into the core. It is internal and can change after
  a release.

## Consequences

- Any concrete incompatible wire or storage correction lands before release
  under the present rule for private experiments.
- [Versioning](../standards/versioning.md) states the compatibility matrix the
  code implements, and a feature added after release is an extension the
  recipient selects, not a new major version.

## References

- [Design review against clean-room designs](../research/clean-room-design-review.md)
- [Protocol Buffers: updating a message type](https://protobuf.dev/programming-guides/proto3/):
  adding fields is safe, and unknown values are preserved.
- [RFC 9413, Maintaining Robust Protocols](https://www.rfc-editor.org/rfc/rfc9413.html):
  an extension mechanism needs clear rules for unknown elements, written
  before deployment.
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification): a notification is a
  request without an id.
- [gRPC status codes](https://grpc.io/docs/guides/status-codes/): a closed
  code set whose members say whether to retry.
- [SQLite `user_version`](https://www.sqlite.org/pragma.html#pragma_user_version)
  and the [IndexedDB upgrade transaction](https://w3c.github.io/IndexedDB/).
- [IndexedDB durability](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed):
  transactions are relaxed by default.
