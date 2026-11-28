# ADR-0017: Contracts Fixed Before The First 3.0 Release

- Status: proposed
- Date: 2026-11-25, compatibility rule rewritten 2026-11-27

## Context

3.0 is unpublished, so a private wire or storage shape is replaced without
aliases, dual readers or migrations. After the first release, installed Apps
and room stores hold the released shapes, and later versions have to work with
them. Some contracts are costly to change after that; others can wait for a
consumer. [Versioning](../standards/versioning.md) promises that an older App
keeps working with a newer site within a major version, and that forward
upgrades preserve durable authority.

The owner's direction for that promise: the first number of a version is the
protocol, the second counts features and the third repairs; any two second
numbers of one first number work together; and the way there is kept clean.
Refusing what is not known and announcing a capability for each addition are
not the way, because each leaves a check behind for every feature ever added.
A room's writer makes this sharper than it is for a hosted service: it runs
on a friend's App or Browser, so it is as often the oldest party in a room as
the newest. The published 2.x line shows the cost of the other way: its
server closes a connection over one field it does not know, its handshake
requires one exact identifier, and its capability object has grown to
fifteen entries, one per feature, which its promise to older peers keeps.
The private 3.0 implementation currently has these boundaries:

- Domain and signed room replies identify their waiting operation separately
  from observer notifications. Unknown outcomes end that operation without
  confirming success. Wire objects accept ordinary extensions; typed store
  readers reject content they cannot preserve.
- A room store opens only at one exact `user_version`
  (`prototype/channel-core/src/storage.rs`), and the Browser store aborts any
  upgrade (`prototype/channel-browser/src/room-host.ts`). This protects data;
  no format change has needed an upgrade yet.

## Decision

### Settled before the first public release

1. **Compatibility.** A single product major/minor serves both Domain joins
   and local App discovery. The room writer may run on an older participant's
   device, so compatible additions must work with older readers and writers
   in either role. [Versioning](../standards/versioning.md#extending-interfaces)
   owns the rules for extensions and their mixed-version acceptance.
   Extensions must be exercised to stay usable
   ([RFC 9170](https://www.rfc-editor.org/rfc/rfc9170.html)).
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
   is required. A store's layout number stays with its storage engine and
   says nothing about a peer.
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

Releases that share the first number keep what that baseline's parties rely
on. Older Apps with newer Sites, newer Apps with older Sites, and older room
writers with newer channels keep their established requests and replies with
their meaning, and a new form reaches only a party that asked for it.

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
- A feature added after release is a new kind, a new field or a new part to
  ask for, and raises the second number. No matrix of pairs is kept, because
  same-major peers use the shared extension rules.
- Refusing unknown fields goes from the wire. Stores and archives keep
  refusing what they do not know. One wire field per feature is not added
  again. The descriptions a join already carries of what a party's runtime
  can do stay: they describe a machine, not a version.
- A room is as new as its writer for whatever is stored. A person can act on
  that sentence: the host updates. Keeping fields a writer cannot read, so
  that newer clients could use them through an older host, was weighed and
  left out: no feature in sight needs it, and it can be added later as one
  more addition under these rules.
- Acceptance requires exercising the first public contract with mixed-version
  artifacts. [TODO](../todo.md) tracks that work.

## References

- [Design review against clean-room designs](../research/clean-room-design-review.md)
- [Semantic Versioning 2.0.0](https://semver.org/): the three numbers.
- [RFC 9110, sections 2.5 and 5.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-2.5):
  a minor version advertises what its sender can understand; a new field
  needs no new version when it is safe to ignore; a proxy forwards the fields
  it does not recognise and other recipients ignore them.
- [RFC 6120, section 8.4](https://www.rfc-editor.org/rfc/rfc6120.html#section-8.4):
  an unknown request is answered with an error, and unknown content of a
  message or a presence is ignored. It is the rule of a network whose
  servers and clients are run by different people and are of different ages.
- [PNG, chunk naming conventions](https://www.w3.org/TR/png-3/#5Chunk-naming-conventions):
  each addition says whether a decoder that does not know it may skip it.
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
