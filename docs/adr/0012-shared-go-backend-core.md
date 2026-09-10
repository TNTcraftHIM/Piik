# ADR-0012: Shared Go Backend Core

- Status: accepted
- Date: 2026-09-06

## Context

One TypeScript/Node server owned HTTP, room authority, admission, signaling, and
routing. Hosted and Local composed the same application from it, and the packaged
App supervised it as a Node child beside a pinned runtime and an extracted
application tree. [ADR-0010](./0010-cross-platform-client-runtime.md) accepted
that shape because a second implementation of rooms, signaling, or routing would
make the two deployments diverge without improving the media path.

That boundary is paid for in every deployment. The App package carries a
language runtime and an installed dependency tree beside its Go entry, a
production host needs Node and npm to install and validate a release, and one
user entry runs two processes whose lifetime a supervisor owns. The App
already owns a Go process, Pion media, and its capture sidecars, so the second
runtime buys only the existing server code.

Replacing that server is acceptable only if the result stays one implementation:
the same wire contract, the same room semantics, the same persistent schema, and
the same Browser build.

## Decision

1. One Go module at the repository root owns the product core.
   `cmd/piik-server` (Hosted) and `cmd/piik-app` (App) are entry
   points over the same `internal/server` packages and own only their defaults,
   reachability, and lifecycle policy. Neither reimplements rooms, admission,
   signaling, or routing. The TypeScript server, its bundled runtime, the process
   supervisor, and the App's runtime/application selection flags are deleted in
   the same boundary.
2. The Browser UI stays React/TypeScript. Node, npm, Vite, vitest, and `tsx`
   remain build and gate tooling and stop being a runtime requirement on any
   deployment or end-user host. `src/shared/protocol.ts` remains the Browser
   schema owner; one checked-in wire fixture is replayed by both a TypeScript and
   a Go test instead of hand-maintained parallel validation rules.
3. Both binaries serve the same built Browser assets embedded through
   `internal/server/webassets`. A binary built without those assets serves the
   API only rather than reading a second asset path, so every packaging and
   acceptance entry point runs the Vite build before the Go build.
4. One mutex in the signaling server guards every room, session, share, route,
   and SFU-ledger mutation, reproducing Node's single thread instead of
   per-object locks. Room-touching HTTP handlers, WebSocket handlers, and timer
   callbacks all acquire it, and the route controller decides beneath it without
   locking or performing I/O. This is a recorded ceiling whose upgrade path is
   per-room locks, not a throughput claim.
5. Every place the TypeScript code awaited I/O - password derivation, LiveKit
   calls, token issue - releases that lock, performs the work, reacquires the
   lock, and revalidates exactly the session, share, connection, publication,
   operation, and revision identities the TypeScript code checked after that
   await. Insertion-ordered structures preserve the JavaScript `Map` iteration
   order that participant, candidate, and timer decisions depend on. Room writes
   stay synchronous inside the lock and keep the current fail-fast storage
   policy: an unrecoverable authority write ends the process instead of
   continuing on divergent state.
6. Superseded by [ADR-0013](./0013-embedded-node-local-media.md): the port initially
   used standard-library tokens and Twirp calls for external LiveKit. Current
   App/Server media adapters share embedded Pion/LiveKit forwarding and the
   authenticated room signaling path; that external service/token layer is gone.
7. Room persistence uses the pure-Go `modernc.org/sqlite` driver over the schema,
   pragmas, single exclusive connection, and recovery accepted in
   [ADR-0002](./0002-memory-resident-protected-rooms.md). Both storage modes,
   their validation, and their failure policy are unchanged, and no build
   requires a C toolchain.
8. The port changed no contract. At that boundary signaling was v21, App loopback
   v8 and the capture probe v4; the HTTP API, cookies, error codes and close codes
   retained their shapes. [Status](../status.md#accepted-release-contract) owns
   the current contract tuple. No compatibility alias, dual
   reader, or migration is added for a change of implementation language.

## Consequences

- The App is one process. Room authority, the loopback capability service, and
  native media share it, so a panic in the server ends the Local session exactly
  as a crashed Node child did, and the capability service no longer survives a
  failed room authority. Hosted exits non-zero and systemd restarts it; nothing
  restarts a vanished authority in place.
- Package and runtime cost falls in three places: the App package loses its
  bundled runtime and dependency tree, the application release becomes the server
  binary with its notices and revision, and a production host installs no
  packages during a release. One Windows 11 before/after run measured cold start
  to healthy 160 ms to 81 ms, idle resident memory 73.7 MiB to 10.4 MiB, and
  shipped Hosted bytes ~106.7 MB to ~14.0 MB; the
  [consolidation research](../research/server-consolidation.md) owns the method
  and the full table. Throughput and latency were not measured, and the port
  changes no media path.
- Release-time configuration validation and the operator update check are
  maintenance modes of the deployed binary, so the release wrapper and the
  production host need no Node; [deployment](../deployment.md) owns their exact
  commands.
- Development runs two processes: the Vite dev server for the Browser bundle and
  the Go application server behind it. The [development guide](../README.md#run-from-source) owns those
  commands.
- ADR-0010 items 1, 5, 7, 12 (its supervisor sentence), 13, 14, and its
  two-internal-process consequence are superseded and amended in place. The rest
  of ADR-0010 - loopback control contract, capability boundary, native media
  adapters, launcher, and Local composition - is unchanged.
- Go is the only server implementation. A second room, signaling, persistence, or
  route-controller implementation stays out of the repository.

## Primary Sources

- [Go module layout](https://go.dev/doc/modules/layout)
- [Go `embed`](https://pkg.go.dev/embed)
- [`coder/websocket`](https://pkg.go.dev/github.com/coder/websocket)
- [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite)
- [LiveKit tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/)
- [LiveKit RoomService API](https://docs.livekit.io/reference/other/roomservice-api/)
- [Server consolidation research](../research/server-consolidation.md)
