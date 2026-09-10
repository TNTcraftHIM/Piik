# Documentation

[English Quick Start](../README.md) · [中文快速开始](../README.zh-CN.md)

## Use Piik

| What you need | Start here |
| --- | --- |
| Join a friend or share a screen | [Quick Start](../README.md) |
| Run App, choose a mode, or fix capture trouble | [App guide](../cmd/piik-app/README.md) |
| Collect a useful bug report | [Diagnostics and export](./reference/configuration.md#diagnostics) |
| Host your own site | [Self-hosting](./operations/self-hosting.md) |
| Configure ports, access or persistence | [Configuration reference](./reference/configuration.md) |
| Update an existing deployment | [Deployment and recovery](./deployment.md) |
| Check platform and release readiness | [Current status](./status.md) |

The public entry points have English and Chinese versions. Technical references
keep one owner rather than duplicate the full documentation tree.

Contributors should follow the [naming convention](./reference/naming.md) for
display names, commands, packages and App/Server/Browser code boundaries.

## Run from source

Use Node from [.node-version](../.node-version), npm from
[package.json](../package.json), and Go 1.26 as specified by [go.mod](../go.mod).
Node builds and serves the development UI; the application server runs in Go.

Start the UI:

```sh
npm ci
npm run dev
```

In a second terminal, start the server. For a POSIX shell:

```sh
PORT=8788 PUBLIC_BASE_URL=http://localhost:8787 go run ./cmd/piik-server
```

Or in PowerShell:

```powershell
$env:PORT = '8788'
$env:PUBLIC_BASE_URL = 'http://localhost:8787'
go build -o build/dev/piik-server.exe ./cmd/piik-server
./build/dev/piik-server.exe
```

The fixed Windows executable path avoids repeated firewall prompts from `go run`.

Open `http://localhost:8787`. The development UI also listens on the LAN;
screen capture requires `localhost` or HTTPS. For another invitation origin,
follow the [configuration reference](./reference/configuration.md).

The standard checks are:

```sh
npm run check
npm run check:client
```

The [contributing guide](../CONTRIBUTING.md#verification-entrypoints) explains
native build prerequisites, focused checks and separate physical gates.

## Product and design

Current behavior belongs to four product modules:

- [Rooms and access](./product/rooms-access.md)
- [Routing and transport](./product/routing-transport.md)
- [Capture, audio and media quality](./product/media-quality.md)
- [Presentation and lifecycle](./product/presentation-lifecycle.md)

Key decisions cover [automatic routing](./adr/0005-automatic-hybrid-media-routing.md),
the [shared Go core](./adr/0012-shared-go-backend-core.md),
[embedded media and Native output groups](./adr/0013-embedded-node-local-media.md),
and the [Browser encoding-pool candidate](./adr/0014-browser-node-local-encoding-pool.md).
Browse [all ADRs](./adr/) for their context and consequences.

## Evidence and current work

- [Project memory](./project-memory.md): compact product map and invariants.
- [Status](./status.md): current source, production and acceptance boundaries.
- [TODO](./todo.md): the only work ledger.
- [Verification status](./verification-status.md): remaining physical evidence.
- [Native encoding research](./research/webrtc-encoder-pool.md) and
  [Browser pooling research](./research/browser-local-encoding-pool.md): measured
  results, failed controls and limits; neither promises universal performance.
- [Research directory](./research/): transport, capture, platform and backend evidence.
- [Maintenance](./maintenance.md): document ownership and repository lifecycle.
- [Licensing](../licenses/README.md): Piik's MIT scope and third-party notices.

Research distinguishes observations from assumptions. Product modules own
accepted behavior, source and tests own implementation detail, and Git/PRs own
completed history.
