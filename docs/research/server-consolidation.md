# Server Consolidation

- Reviewed: 2026-10-07
- Status: published; current physical limits are in
  [verification status](../verification-status.md). The before/after measurements
  below describe the original 2026-09-06 consolidation, not current package cost.
- Scope: one shared Go backend for Hosted and self-contained App operation

## Current Ownership

`cmd/piik-server` and `cmd/piik-app` compose one Go core with the same embedded
Browser assets. The App adds its launcher and native capabilities without a
supervised server process. [ADR-0012](../adr/0012-shared-go-backend-core.md)
records that decision; the [module map](../standards/engineering.md#module-map)
owns current package responsibilities.

## Structural Simplification

Consolidation removed the server supervisor and runtime dependency tree. Later
structural cleanup joined room-expiry/abandonment retirement and removed the
mirrored connection-ID state. Those changes reduced competing owners;
Git/PRs retain their implementation history.

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

Hosted and Local construct the same validated application options. One signaling
lock serializes room mutations, while password derivation and media-transport I/O
run outside it and revalidate their exact identities before applying results.

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

The port retained room authority, atomic replacement/revocation, SQLite restart
and Local shutdown behavior, and the single route operation's prepare/commit/
rollback semantics. [ADR-0012](../adr/0012-shared-go-backend-core.md) records the
unchanged wire and storage boundary. Package size, startup and idle memory are
measured below; ongoing verification follows CONTRIBUTING.

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
above is the steady state. That original comparison measured neither load
throughput/latency nor the Linux deployment host; the later signaling check is
reported separately above.
