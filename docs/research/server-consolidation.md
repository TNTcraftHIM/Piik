# Server Consolidation

- Reviewed: 2026-09-05
- Status: design candidate for the phase after Browser/Client acceptance
- Scope: one shared Go backend for Hosted and self-contained Client operation

## Current Ownership

Hosted [`index.ts`](../../src/server/index.ts) and Local
[`local-index.ts`](../../src/server/local-index.ts) already compose the same
[`createScreenerServer`](../../src/server/app.ts). The Go
[`clientapp`](../../native/client/internal/clientapp/app.go) supervises that Node
process and supplies native media; it does not duplicate room or route authority.
Consolidation replaces this sole backend rather than merging two implementations.

[`RoomStore`](../../src/server/room-store.ts) owns room authority and participants;
[`RoomDatabase`](../../src/server/room-database.ts) persists only access and lease
material. [`RoomRouteController`](../../src/server/room-route-controller.ts)
decides graph transitions without network I/O;
[`HybridMediaRouter`](../../src/server/hybrid-media-router.ts) executes signaling
and SFU effects. These are useful boundaries, not duplication to remove.

## Preparatory Simplification

1. Unify room termination cleanup. `SignalingServer.closeRoom` and `expireRooms`
   in [`signaling.ts`](../../src/server/signaling.ts) delete the same timers,
   connection evidence, share state and router resources before closing sockets.
   Use one cleanup owner with the existing termination reason as input.
2. Remove the Hybrid connection-ID mirror. `connectionIdsByViewer` is populated
   through router callbacks, then `handleViewerQualityEvidence` checks that map
   and `resolveActiveViewerMediaEdge` again. Derive the Hybrid identity from the
   committed edge; retain the evidence gate's own last-observation identity.
   Cover reauthentication and in-place connection adoption before removing the
   callbacks. The ordinary routing mode remains a separate consumer until its
   product decision is made.

These are structural simplifications, not reproduced functional failures.

## Product Choice

`PEER_ASSISTED_MEDIA=false` remains a documented, default configuration in
[`.env.example`](../../.env.example). It owns a separate Host-star path in
`SignalingServer`, including child admission and SDP-answer readiness; Local and
production use the graph controller. Decide whether this mode still belongs to
the product before translating it. If automatic Peer topology is universal,
remove the switch and ordinary path together; otherwise retain its explicit
contract; this reachable mode is not dead code.

## Target Composition

```text
one Go module
cmd/screener-server -> shared server application
cmd/screener-client -> shared server application + launcher + native media
internal/server    -> rooms, routing, HTTP/signaling, persistence, SFU adapters
internal/client    -> current native and platform boundaries
one React/Vite static artifact
```

Use packages for cohesive owners and files for local concerns. Do not introduce
a framework layer per file, a second product API, or a multi-module build.
Move the existing `native/client` Go module into the common scope during the
migration. Hosted and Local construct the same validated application options;
entry points own their defaults, reachability and lifecycle policy.

Each room keeps one serialized state owner. Go HTTP/WebSocket handlers must not
mutate room, share and route maps independently. Run password derivation and
LiveKit I/O outside that owner, then apply results only while the exact session,
share and operation identities still match. Preserve the existing distinction
between decisions and effects rather than replacing Node serialization with
unrelated locks around each map.

## Reusable Components

- Use standard [`net/http`](https://pkg.go.dev/net/http) and
  [`embed`](https://pkg.go.dev/embed) for HTTP and built assets.
- Reuse the Client's [`coder/websocket`](https://pkg.go.dev/github.com/coder/websocket)
  for signaling and the official [LiveKit Go SDK](https://github.com/livekit/server-sdk-go)
  for room control and tokens.
- Keep the current SQLite schema and transactions. Compare a small
  [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) build/runtime gate
  against package and locking needs before selecting a driver; no ORM is needed.
- Follow [Go's shared `internal` and multiple `cmd` guidance](https://go.dev/doc/modules/layout).
  Retain current Pion, capture sidecars and control-tunnel ownership.

## Minimum Acceptance

Preserve exact Host/session replacement, grant revocation, atomic room replacement,
SQLite restart continuity and Local shutdown semantics. Exercise one graph and
one operation through Peer, SFU, same-edge regeneration, bounded overlap and
rollback, including stale asynchronous completions. Preserve short-lived SFU
authority and release resources only after physical drain confirmation.

Use the same Browser contract scenarios against Hosted and Local, plus one
physical mixed Browser/Client media flow. Measure package size, startup and idle
memory before and after. Keep one strict wire contract and one schema owner;
avoid hand-maintained parallel TypeScript/Go validation rules. Retire the Node
server, bundled runtime, supervisor and old packaging paths in the same accepted
integration boundary, preserving [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md)
and [ADR-0010](../adr/0010-cross-platform-client-runtime.md).
