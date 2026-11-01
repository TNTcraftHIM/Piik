# Piik Documentation

[About Piik](../README.md) · [中文介绍](../README.zh-CN.md) · [中文上手指南](./guide/getting-started.zh-CN.md)

For using Piik, troubleshooting or self-hosting, start with the
[reader documentation](./guide/README.md) · [中文文档中心](./guide/README.zh-CN.md).
This page indexes developer and maintainer references.

## Developer And Maintainer Entry Points

| Task | Guide |
| --- | --- |
| Try or change the source code | [Run from source](#run-from-source) |
| Find a module, interface, lifecycle or source entry point | [Engineering maps and source index](./standards/engineering.md#repository-layout) |
| Find the shared product, design and lifecycle rules | [Standards index](./standards/README.md) |
| Deploy or configure a service | [Self-hosting](./operations/self-hosting.md) · [Configuration](./standards/configuration.md) · [Service management](./operations/service-management.md) |
| Build App packages and native capture | [Rust App](../prototype/channel-server/README.md#local-app-link) · [Packaging](./deployment.md#build-host) |
| Build, publish or recover a maintained release | [Maintainer release tooling](./deployment.md) |
| Send a useful bug report | [Diagnostics and export](./standards/configuration.md#diagnostics) |
| Translate Piik or improve wording | [Translation guide](./guide/translating.md) · [中文翻译教程](./guide/translating.zh-CN.md) |
| Check release and platform readiness | [Current status](./status.md) |

The introduction, getting-started, App, self-hosting, service-management and translation guides are available in English and Chinese.
Technical references keep one shared version.

## Run from source

This branch uses the shared Rust 3.0 runtime and Browser/WASM frontend. Install
Node from [.node-version](../.node-version), npm from
[package.json](../package.json), Rust 1.91.0 with the `wasm32-unknown-unknown`
target, wasm-bindgen CLI 0.2.129 and cargo-about 0.9.3. The
[Browser build owner](../prototype/channel-browser/README.md) describes these tools
and their path overrides. From the repository root:

```sh
npm ci
npm run build:web
npm run dev
```

In a second terminal, follow [Rust Server startup](../prototype/channel-server/README.md#run)
with `PIIK_CHANNEL_WEB_ORIGIN=http://127.0.0.1:8787` for this development UI.
It describes the private startup keys and listener configuration;
[saved data and files](../prototype/channel-server/README.md#saved-data-and-files)
covers storage.
Open [127.0.0.1:8787](http://127.0.0.1:8787), using its owner-entry and **Invite**
instructions. Vite serves the UI and proxies signaling to the Rust domain.
Browser capture requires loopback or HTTPS.

On Windows, keep network executables at stable source-build paths, such as
`prototype/channel-server/target/debug/piik-channel-prototype.exe`, or under your
fixed `CARGO_TARGET_DIR`.
For the self-contained App and platform capture requirements, follow the
[Rust App owner](../prototype/channel-server/README.md#local-app-link) and
[packaging](./deployment.md#build-host).

## Work on Piik

[Contributing](../CONTRIBUTING.md) covers the workflow and choosing focused checks.
The main verification command is:

```sh
npm run check
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
| Camera and Host microphone | [Capture scope and limits](./research/camera-and-microphone.md) |
| Text, reactions and floating room tools | [Room-interaction design](./research/room-interactions.md) |
| Accepted 3.0 channel/room foundation, Rust direction and multi-source routing | [Channel and network design](./research/channel-network-design.md) |
| 3.0 room-data ownership, cached attachments and file-delivery design | [Room data and hosting](./research/channel-storage-and-identity.md) |
| Stereo verification and HDR-to-SDR assessment | [Media fidelity](./research/media-fidelity.md) |

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
