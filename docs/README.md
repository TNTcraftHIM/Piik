# Piik Documentation

[About Piik](../README.md) · [中文介绍](../README.zh-CN.md) · [中文上手指南](./guide/getting-started.zh-CN.md)

For using Piik, troubleshooting or self-hosting, start with the
[reader documentation](./guide/README.md) · [中文文档中心](./guide/README.zh-CN.md).
This page also indexes developer and maintainer references.

## Guides And References

| Task | Guide |
| --- | --- |
| Use Piik online | [Open the online site](https://demo.piik.tv) · [Online sharing guide](./guide/getting-started.md#use-piik-online) |
| Watch a friend or share my first screen | [Getting started](./guide/getting-started.md) |
| Choose an App mode or fix sound and connection trouble | [First-use help](./guide/getting-started.md#choose-an-app-mode) |
| Page opens but video will not connect / 网页能打开，画面连不上 | [Connection troubleshooting](./guide/getting-started.md#when-video-will-not-connect) · [中文排查](./guide/getting-started.zh-CN.md#画面连接不上) |
| Run Piik App, check platform requirements, or build a package | [App guide](../cmd/piik-app/README.md) · [中文 App 指南](../cmd/piik-app/README.zh-CN.md) |
| Try or change the source code | [Run from source](#run-from-source) |
| Find a directory or the module responsible for a behavior | [Repository layout and module map](./standards/engineering.md#repository-layout) |
| Find the shared product, design and lifecycle rules | [Standards index](./standards/README.md) |
| Host a site for my group | [Self-hosting](./operations/self-hosting.md) · [中文部署](./operations/self-hosting.zh-CN.md) |
| Keep a server running with systemd or Docker | [Service management](./operations/service-management.md) · [中文服务管理](./operations/service-management.zh-CN.md) |
| Set passwords, ports, or room storage | [Configuration](./standards/configuration.md) |
| Update my server | [Server updates](./operations/self-hosting.md#keep-it-running-and-update) |
| Build, publish or recover a maintained release | [Maintainer release tooling](./deployment.md) |
| Send a useful bug report | [Diagnostics and export](./standards/configuration.md#diagnostics) |
| Translate Piik or improve wording | [Translation guide](./guide/translating.md) · [中文翻译教程](./guide/translating.zh-CN.md) |
| Check release and platform readiness | [Current status](./status.md) |

The introduction, getting-started, App, self-hosting, service-management and translation guides are available in English and Chinese.
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
[configuration](./standards/configuration.md).
Browser capture requires `localhost` or HTTPS.

For the self-contained App, follow [App development](../cmd/piik-app/README.md#development)
and [packaging](../cmd/piik-app/README.md#packaging), including the platform's
native capture requirements.

## Work on Piik

[Contributing](../CONTRIBUTING.md) covers the workflow and choosing focused checks.
The main verification commands are:

```sh
npm run check
npm run check:go
```

Use the [naming and copy guide](./standards/naming.md) for product names,
commands, role labels and Chinese/English voice.
Piik-owned code uses [MIT](../LICENSE); see the
[licensing guide](../licenses/README.md) for third-party components.

For the public website, see the [introduction design](./standards/public-introduction.md)
and [website preview and publishing](./operations/website.md).

## Understand the product

| Topic | Its reference |
| --- | --- |
| Invitations, room codes and passwords | [Rooms and access](./standards/rooms-access.md) |
| How viewers connect | [Routing and transport](./standards/routing-transport.md) |
| Screen capture, quality controls and sound | [Media quality](./standards/media-quality.md) |
| Host and viewer behavior | [Presentation and lifecycle](./standards/presentation-lifecycle.md) |
| Why a design was chosen | [Architecture decisions](./adr/) |
| Measurements and platform limits | [Research](./research/) and [verification status](./verification-status.md) |
| Camera and Host microphone candidate | [Capture scope and limits](./research/camera-and-microphone.md) |

## Shared conventions

| When changing… | Follow this owner |
| --- | --- |
| Module responsibilities or interfaces | [Engineering and contract map](./standards/engineering.md) |
| Product/tool names, role labels or copy | [Naming and copy](./standards/naming.md) |
| UI colour, illustration, motion or layout | [Visual language](./standards/visual-language.md) |
| Overlays, titles or state indicators | [Media status](./standards/media-status.md) |
| Releases, protocols or stored formats | [Versions and compatibility](./standards/versioning.md) |
| Main protection or automatic publishing | [GitHub operations](./operations/github.md) |
| Documentation or a duplicated rule | [Documentation ownership](./standards/documentation.md) |
| Checks, PRs, integration or cleanup | [Contributing](../CONTRIBUTING.md) |

For ongoing work, use [TODO](./todo.md). [Project memory](./project-memory.md)
provides the compact product map; [status](./status.md) indexes current source
and deployment boundaries. Completed work lives in Git history and pull requests.
