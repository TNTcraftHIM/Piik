# Piik Documentation

[About Piik](../README.md) · [中文介绍](../README.zh-CN.md) · [中文上手指南](./guide/getting-started.zh-CN.md)

## Guides And References

| Task | Guide |
| --- | --- |
| Try the online demo | [Online demo](https://demo.piik.tv) · [Demo steps](./guide/getting-started.md#try-the-online-demo) |
| Watch a friend or share my first screen | [Getting started](./guide/getting-started.md) |
| Choose an App mode or fix sound and connection trouble | [First-use help](./guide/getting-started.md#choose-an-app-mode) |
| Run Piik App, check platform requirements, or build a package | [App guide](../cmd/piik-app/README.md) |
| Try or change the source code | [Run from source](#run-from-source) |
| Find a directory or the module responsible for a behavior | [Repository layout and module map](./reference/engineering.md#repository-layout) |
| Host a site for my group | [Self-hosting](./operations/self-hosting.md) · [中文部署](./operations/self-hosting.zh-CN.md) |
| Keep a server running with systemd or Docker | [Service management](./operations/service-management.md) |
| Set passwords, ports, or room storage | [Configuration](./reference/configuration.md) |
| Update my server | [Server updates](./operations/self-hosting.md#keep-it-running-and-update) |
| Build, publish or recover a maintained release | [Maintainer release tooling](./deployment.md) |
| Send a useful bug report | [Diagnostics and export](./reference/configuration.md#diagnostics) |
| Check release and platform readiness | [Current status](./status.md) |

The introduction, getting-started and self-hosting guides are available in English and Chinese.
Technical references keep one shared version.

## Run from source

You can try the Browser application locally with Node from
[.node-version](../.node-version), npm from
[package.json](../package.json), and Go 1.26 from [go.mod](../go.mod).
Run these commands from the repository root.

Start the web UI:

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
Open [localhost:8787](http://localhost:8787), start sharing, and open the invitation
in another browser tab to try watching. This localhost invitation stays on your
computer; remote invitations need a reachable origin as described in
[configuration](./reference/configuration.md).
Browser capture requires `localhost` or HTTPS.

For the self-contained App, follow [App development](../cmd/piik-app/README.md#development)
and [packaging](../cmd/piik-app/README.md#packaging), including the platform's
native capture requirements.

## Work on Piik

[Contributing](../CONTRIBUTING.md) covers the workflow and choosing focused checks.
The main verification commands are:

```sh
npm run check
npm run check:client
```

Use the [naming and copy guide](./reference/naming.md) for product names,
commands, role labels and Chinese/English voice.
Piik-owned code uses [MIT](../LICENSE); see the
[licensing guide](../licenses/README.md) for third-party components.

For the public website, see the [introduction design](./design/public-introduction.md)
and [website preview and publishing](./operations/website.md).

## Understand the product

| Topic | Its reference |
| --- | --- |
| Invitations, room codes and passwords | [Rooms and access](./product/rooms-access.md) |
| How viewers connect | [Routing and transport](./product/routing-transport.md) |
| Screen capture, quality controls and sound | [Media quality](./product/media-quality.md) |
| Host and viewer behavior | [Presentation and lifecycle](./product/presentation-lifecycle.md) |
| Why a design was chosen | [Architecture decisions](./adr/) |
| Measurements and platform limits | [Research](./research/) and [verification status](./verification-status.md) |

## Shared conventions

| When changing… | Follow this owner |
| --- | --- |
| Module responsibilities or interfaces | [Engineering and contract map](./reference/engineering.md) |
| Product/tool names, role labels or copy | [Naming and copy](./reference/naming.md) |
| UI colour, illustration, motion or layout | [Visual language](./design/visual-language.md) |
| Overlays, titles or state indicators | [Media status](./design/media-status.md) |
| Releases, protocols or stored formats | [Versions and compatibility](./reference/versioning.md) |
| Main protection or automatic publishing | [GitHub operations](./operations/github.md) |
| Documentation or a duplicated rule | [Documentation ownership](./maintenance.md) |
| Checks, PRs, integration or cleanup | [Contributing](../CONTRIBUTING.md) |

For ongoing work, use [TODO](./todo.md). [Project memory](./project-memory.md)
provides the compact product map; [status](./status.md) indexes current source
and deployment boundaries. Completed work lives in Git history and pull requests.
