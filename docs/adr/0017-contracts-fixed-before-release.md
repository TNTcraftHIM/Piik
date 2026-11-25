# ADR-0017: Contracts Fixed Before The First 3.0 Release

- Status: proposed
- Date: 2026-11-25

## Context

3.0 is unpublished. Until its first release a private wire or storage shape is
replaced without aliases, dual readers or migrations. After it, every
installed App and every room store in the field holds the old shape for good.
Some defects can therefore be fixed only now.

Two of them contradict what [versioning](../standards/versioning.md) promises.
It says an older installed App keeps working with a newer site within a major
version, and that forward upgrades preserve durable authority. The code cannot
keep either promise:

- `Join` requires the protocol number to equal one value
  (`prototype/channel-core/src/lib.rs`), and types sent to clients reject
  unknown fields. Any wire change breaks every older App. A shipped reader
  cannot be made tolerant afterwards.
- A room store opens only when `user_version` equals one value
  (`prototype/channel-core/src/storage.rs`), and the Browser store aborts any
  upgrade (`prototype/channel-browser/src/room-host.ts`). The first schema
  change after release would make every existing room unreadable.

The [design review](../research/clean-room-design-review.md) found the same
gaps from two directions: three designs written from the requirements alone
all chose the shapes below, and three audits of the tree found their absence.

## Decision

1. **Compatibility.** A connection states a major version and its
   capabilities. The major must match. Within a major every change is an
   addition. Readers of data sent to a client ignore unknown fields and
   unknown event types, and descriptive enumerations carry an unknown value.
   Commands sent to an authority stay strict, and a sender uses a new field or
   command only after the receiver has advertised it. Browser, Native and the
   text SDK behave the same. Peers learn each other's features through the
   domain, not by assuming the same build.
2. **One schema source.** The core's wire types are the schema. TypeScript
   declarations are generated from them and checked in, and a check fails when
   they drift. Incoming frames are validated in the core. No second schema is
   written by hand.
3. **One reply.** A request has exactly one final reply under its request id.
   A failure carries a code from a closed set, whether the operation was
   rejected or its outcome is unknown, and whether a retry can help. A
   mutation carries an idempotency key so that a retry is safe. An event
   without a request id is a notification and expects no reply; a copy sent to
   an observer is a notification.
4. **A state revision.** State sent to a client carries a revision. Sending
   only what changed can follow later behind a capability; the revision cannot
   be added later for readers that never expected it.
5. **Commands by scope.** A command is addressed to the domain, a room, a
   publication or a pair by its type, so routing is exhaustive. Room
   activities share one envelope with a body tagged by kind, which is the
   extension point for a new activity.
6. **Storage versions.** Each durable format has one integer version owned by
   the core. Ordered forward migrations run in one transaction on a copy of
   the store. A store newer than the code is refused. An added optional field
   needs no new version; anything else needs a migration. The numbers restart
   at one for the release.
7. **Lineage and position.** A room store carries an epoch that a restore or
   a copy replaces, and one room-wide change sequence that every committing
   transaction advances. A reader resumes from an epoch and a sequence, and a
   deletion reaches it as a change. Sequence numbers are not reused within an
   epoch.
8. **One set of history rules.** The core owns the history rules and the
   tombstone shape over a small storage port, and both adapters execute it.
   The Browser writer commits with strict durability and asks for persistent
   storage, because the architecture promises that history is committed before
   it is confirmed.
9. **Bytes.** Keys and signatures travel as base64url text. Bulk bytes cross
   the WebAssembly boundary as bytes, not as arrays of numbers.

## Not Decided Here

- The serialization format. All three clean-room designs chose Protocol
  Buffers for its evolution rules and breaking-change tooling. The decisions
  above hold for the present JSON as well, so the format can be weighed
  separately.
- One SQLite schema in every runtime, using SQLite on the Browser's private
  file system in place of IndexedDB. It would make decision 8 structural. It
  needs a measurement of size and start-up cost first.
- Moving the client engine into the core. It is internal and can change after
  a release.

## Consequences

- The wire and both stores change shape once more before release, under the
  present rule for private experiments.
- [Versioning](../standards/versioning.md) states the compatibility rule that
  the code then implements, and loses the sentences the code never honoured.
- A feature added after release becomes an addition behind a capability
  instead of a new major version.
- Each new activity kind stops costing a sweep across the domain, the writer
  and both clients.

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
