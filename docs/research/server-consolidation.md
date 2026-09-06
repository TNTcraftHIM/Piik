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

1. Room expiry and abandonment now share `SignalingServer.terminateRoom` in
   [`signaling.ts`](../../src/server/signaling.ts). Preserve the distinct semantics
   of stopping a share, ending a room, and restarting a persistent server.
2. Remove the Hybrid connection-ID mirror. `connectionIdsByViewer` is populated
   through router callbacks, then `handleViewerQualityEvidence` checks that map
   and `resolveActiveViewerMediaEdge` again. Derive the Hybrid identity from the
   committed edge; retain the evidence gate's own last-observation identity.
   Cover reauthentication and in-place connection adoption before removing the
   callbacks. The ordinary Host-star path has been removed.

These are structural simplifications, not reproduced functional failures.
The [audit reconciliation](./backend-audit-1b01048.md) separates verified fixes
from disputed recommendations. Its external staged plan is not an instruction
to perform extractions for their own sake.

## Product Choice

The graph controller is now universal. The former rollout switch and ordinary
Host-star signaling path were removed together, so Hosted and Local
share one route authority and LiveKit remains an optional fallback of that graph.

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
