# Piik App Development

Build, package and verify the shared Rust App from the repository root. The
[App guide](./README.md) and its Chinese counterpart describe published releases.

## Run From Source

Install the tools in [Run from source](../../docs/README.md#run-from-source), then:

```sh
npm ci
npm run build:web
```

Follow the [Rust App startup owner](../../prototype/channel-server/README.md#local-app-link)
for capture-enabled builds, local approval, saved sites and the tunnel helper.
The App and Server consume the same Rust core and shared Web bundle; native
capture is integrated through the Rust Native adapter. The retained standalone
helpers under `native/` have their own fixture/build instructions.

On Windows, use the stable Cargo output or a fixed `CARGO_TARGET_DIR` for network
executables. See [verification entrypoints](../../CONTRIBUTING.md#verification-entrypoints)
for the normal `npm run check`, focused Rust checks and existing Browser/Native
acceptance owners. Physical capture/input acceptance remains separate from
compilation and package smoke checks.

## Packaging

The [distribution workflow](../../docs/deployment.md#build-host) owns platform
prerequisites, App assembly and candidate checks. Packaging uses the built Rust
App, sibling `web/` tree, `REVISION`, licenses and the optional pinned
`runtime/tunnel/cloudflared` helper. On macOS these live inside
`Piik App.app/Contents/MacOS`; move the whole bundle when installing it.
Creating a candidate does not publish it. Published App/Site interoperability
remains governed by the [compatibility contract](../../docs/standards/versioning.md#public-compatibility-promise).

### Optional Gamepad Drivers

App packaging does not download or include optional input SDKs or drivers.
Platform support, permissions and installation remain in the
[gamepad setup guide](../../docs/guide/remote-control.md#gamepads) and
[Native platform owner](../../prototype/channel-native/README.md).

### Desktop Icons

The Windows App embeds the shared Piik mark through the
`cmd/piik-app/piik_windows_amd64.syso` resource; the platform
suffix keeps that Windows resource out of Linux and macOS builds.
Linux packages include the standard `share/applications` desktop entry and
hicolor icon. macOS packages include `Piik App.app` with an ICNS resource,
the App executable and its helpers. For terminal use, the executable is
`"Piik App.app/Contents/MacOS/piik-app"`.

The editable badge is [public/favicon.svg](../../public/favicon.svg).
Export it at 16/24/32/48/64/128/256 px as PNG entries in `cmd/piik-app/piik.ico`;
the package builder derives Linux and macOS icons from those entries. Keep the
website exports in sync: `public/favicon.png` at 96 px, and `public/favicon.ico`
with 16/32/48 px entries. Check actual small sizes on light and dark backgrounds.
Render the SVG at each target size so its small-icon styling applies.
Resource regeneration additionally needs Go from [`.go-version`](../../.go-version).
Regenerate the Windows resource from the repository root:

```sh
go run github.com/akavel/rsrc@v0.10.2 -ico cmd/piik-app/piik.ico -arch amd64 -o cmd/piik-app/piik_windows_amd64.syso
```

## Checks

Use the [shared Rust/Browser checks](../../prototype/channel-server/README.md#checks)
and [Native checks](../../prototype/channel-native/README.md#checks) for current
source acceptance. Their finite runners own isolated profiles, test data,
processes and cleanup. The historical 2.x Go gates are retained in the
[public 2.x source](https://github.com/TNTcraftHIM/Piik/tree/eef70ffda0ffddce6aec109521ab70871e5b7c2f/scripts).
