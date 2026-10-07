# Server Consolidation

- Reviewed: 2026-10-07
- Status: published; current physical limits are in
  [verification status](../verification-status.md). The before/after measurements
  below describe the original 2026-09-06 consolidation, not current package cost.
- Scope: one shared Go backend for Hosted and self-contained App operation

## Current Ownership

`cmd/piik-server` (Hosted) and `cmd/piik-app` (App) compose the
same application from `internal/server` and own only their defaults,
reachability, and lifecycle policy. Within that scope `protocol` owns wire types,
strict decoding, and shared scalars; `config` owns environment validation plus
the Hosted and Local compositions; `room` owns room authority, participants, and
the SQLite database; `route` decides graph transitions without I/O; `signal`
executes signaling and SFU effects under one lock; `sfu` owns admission and
embedded media through the shared Pion/LiveKit adapter; `app` owns HTTP
composition, site access, static assets, and lifecycle; and `webassets` carries
the embedded Browser bundle.
`internal/app` keeps the native, launcher, and platform boundaries and
supervises no server process. These are useful boundaries, not duplication to
remove.

## Structural Simplification

1. Room expiry and abandonment share one `terminateRoom` path in `signal`.
   Preserve the distinct semantics of stopping a share, ending a room, and
   restarting a persistent server.
2. The Hybrid connection-ID mirror is gone. The viewer-quality evidence path
   and the active media-edge lookup read the connection identity from the
   committed edge, and the evidence gate keeps its own last-observation
   identity; router tests cover in-place connection adoption during a rebuild
   and exact direct/peer-relayed evidence sources.

These are structural simplifications, not reproduced functional failures.
The [engineering reference](../standards/engineering.md#ablation-and-review)
requires a concrete ownership gain before further extraction.

## Product Choice

The graph controller is now universal. The former rollout switch and ordinary
Host-star signaling path were removed together, so Hosted and Local
share one route authority. Embedded SFU remains an optional fallback of that graph
under [ADR-0013](../adr/0013-embedded-node-local-media.md).

## Target Composition

```text
one Go module
cmd/piik-server -> shared server application
cmd/piik-app -> shared server application + launcher + native media
internal/server    -> rooms, routing, HTTP/signaling, persistence, SFU adapters
internal/app       -> current native and platform boundaries
one React/Vite static artifact -> embedded in both binaries
```

Use packages for cohesive owners and files for local concerns. Do not introduce
a framework layer per file, a second product API, or a multi-module build.
Hosted and Local construct the same validated application options; entry points
own their defaults, reachability and lifecycle policy.

Each room keeps one serialized state owner. Go HTTP/WebSocket handlers must not
mutate room, share and route maps independently. Run password derivation and
media-transport I/O outside that owner, then apply results only while the exact
session, share and operation identities still match. Preserve the existing distinction
between decisions and effects rather than replacing Node serialization with
unrelated locks around each map.

## Reusable Components

- Standard [`net/http`](https://pkg.go.dev/net/http) and
  [`embed`](https://pkg.go.dev/embed) serve HTTP and the built assets.
- Signaling reuses the App's
  [`coder/websocket`](https://pkg.go.dev/github.com/coder/websocket).
- Embedded SFU and Native media share `internal/media/forwarding`, which reuses
  Pion transport and LiveKit media components. SDP/ICE uses the authenticated room
  WebSocket; no external LiveKit room API or media-token service remains.
- Room persistence keeps the current schema and transactions on the pure-Go
  [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) driver, which
  builds without cgo and holds one exclusive connection; no ORM is needed.
- The layout follows [Go's shared `internal` and multiple `cmd` guidance](https://go.dev/doc/modules/layout).
  Pion, capture sidecars and control-tunnel ownership are unchanged.

## Minimum Acceptance

Preserve exact Host/session replacement, grant revocation, atomic room replacement,
SQLite restart continuity and Local shutdown semantics. Exercise one graph and
one operation through Peer, SFU, same-edge regeneration, bounded overlap and
rollback, including stale asynchronous completions. Preserve short-lived SFU
authority and release resources only after physical drain confirmation.

Use the same Browser contract scenarios against Hosted and Local, plus one
physical mixed Browser/App media flow. Package size, startup and idle memory
are measured below. Keep one strict wire contract and one schema owner;
avoid hand-maintained parallel TypeScript/Go validation rules. The Node server,
bundled runtime, supervisor and old packaging paths retire in this same accepted
integration boundary, preserving [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md)
and [ADR-0010](../adr/0010-cross-platform-client-runtime.md) as amended by
[ADR-0012](../adr/0012-shared-go-backend-core.md).

## Measured Before And After

### Signaling Execution Check

On 2026-10-07, an isolated Windows loopback check used 10 rooms with one Host and
20 Viewers each. Nine Hosts changed their display names 10 times/s, exercising
presence encoding and fan-out; another task changed room policy 10 times/s,
and four password tasks ran once/s outside the signaling lock. The diagnostic
variant additionally wrote 200 synthetic route records/s through the real file
sink under that lock. Each run measured 200 requests from a separate room.

| Storage / diagnostics | Signaling lock wait P95 | Request round-trip P95 | Retained connections |
| --- | ---: | ---: | ---: |
| Memory | Below clock resolution | 6.5 ms | 210/210 |
| SQLite | 1.0 ms | 5.9 ms | 210/210 |
| SQLite + diagnostic sink | 3.0 ms | 7.0 ms | 210/210 |

These short local checks do not establish WAN, slow-disk or maximum-capacity
performance. A separate overload run at 900 name changes/s and 40 password
tasks/s reached 205 ms request P95 and lost 12 connections while bounded queues
were exercised; it is not a passing workload. The ordinary workload provides
no reason to introduce room actors or another mutation owner. Preserve the
bounded queues and unlocked password/media work; measure synchronous storage
and diagnostic sinks before changing execution for a larger deployment.

### Original Package Consolidation

One machine, 2026-09-06: Windows 11, Node 24.15.0, Go 1.26.6. A script spawned
each server with the same production configuration (`PORT=18787`, HTTPS public
origin, site-access password, one STUN URL, loopback listen host), polled
`/healthz` every 10 ms until `{"status":"ok"}`, waited 5 s idle, sampled
resident memory through PowerShell `WorkingSet64`, then killed the process.
Five runs per side; the median is reported. Before is the Node baseline at tag
`baseline-b20fd88`; after is `piik-server` under the same script.

| metric | before | after |
| --- | ---: | ---: |
| cold start to healthy | 160 ms | 81 ms |
| idle resident memory | 77,242,368 B | 10,928,128 B |
| shipped Hosted bytes | ~106.7 MB | ~14.0 MB |

The before total is the Node runtime (91,694,408 B), the production
`node_modules` tree (12,640,469 B in 1,513 files), `dist/client` (1,492,721 B)
and `dist/server` (856,898 B). The after total is the linux/amd64
`piik-server` built with `-s -w` and embedded assets (13,983,906 B) plus its
notices and `REVISION`. For reference, the windows/amd64 binaries are
14,276,608 B (`piik-server`) and 22,703,104 B (`piik-app`, which also
carries Pion and the terminal UI); the App package additionally drops the
Node runtime and dependency tree it used to ship beside its Go executable.

The first two starts of a freshly built binary took 469 ms and 336 ms, which is
consistent with on-access antivirus scanning of a new executable; the median
above is the steady state. Not measured: throughput or latency under load, which
this port does not change, and the Linux deployment host.
