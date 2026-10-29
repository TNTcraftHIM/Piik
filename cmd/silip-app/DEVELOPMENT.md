# Silip App Development

Build, package and verify Silip App from the repository root. For installation,
mode selection and diagnostics, use the [App guide](./README.md).

## Run From Source

Use the Node/npm/Go versions in [Run from source](../../docs/README.md#run-from-source).
The binary embeds the Browser assets, so build them from the repository root first:

```sh
npm ci
npm run build:web
```

On Linux or macOS:

```sh
go run ./cmd/silip-app
```

On Windows, build and run from a stable executable path for the system firewall:

```powershell
go build -o build/dev/silip-app.exe ./cmd/silip-app
./build/dev/silip-app.exe
```

These commands build the App only. Choose **Local room** or open a Silip Site
for Browser capture. Native capture and **Public invite** need their helpers;
use `--capture-process` / `--tunnel-process` to select built helpers, or follow
[packaging](#packaging) for a complete bundle.

The repository-level entry used locally and by CI is:

```sh
npm run check:go
```

On Windows, its generated App, capture, and media-test executables are
written to the ignored repository `build/go-check` directory and reused on
the next run. This keeps the executable identity stable for the system firewall;
the files are local build output and are never packaged or committed.

It runs Go formatting, unit tests, vet, and Windows/Linux cgo-free cross-builds.
The Darwin App and peer gate build only on macOS with cgo enabled and an
installed SDK; other hosts report that skipped platform explicitly. The pinned
media dependency's Darwin CPU statistics use Mach APIs through cgo, so a Windows
or Linux core check does not establish Darwin build acceptance.
The check compiles the current platform's isolated capture process and validates
its bounded capability response. macOS additionally encodes one in-memory hardware H.264
IDR; Linux probes the Portal/PipeWire/GStreamer adapter. Real capture, GPU
attribution, Browser decode, and public-network paths remain explicit physical
gates rather than environment-dependent unit tests.

App and Hosted share the Go room service. The Browser UI coordinates native
capture and Viewer receive/relay through the App's local control service;
Viewer receive/relay remains available without a supported native capture encoder.
Use the [module map](../../docs/standards/engineering.md#module-map) and
[contract map](../../docs/standards/engineering.md#contract-map) to find the source owners.
The candidate packager checks that capture helpers match the App's contract.

Packaged builds report the product version and source SHA in the terminal and
diagnostics. [Versioning](../../docs/standards/versioning.md) explains build identity
and update notices; [GitHub operations](../../docs/operations/github.md)
describes automatic publication.

## Packaging

From a clean revision, build the application release and run the platform's
candidate wrapper on its native operating system. The wrapper builds capture,
verifies the pinned public-link helper, and assembles and checks the App:

```sh
node scripts/package-server-release.mjs /outside/repository/app-release
node scripts/package-app-candidate.mjs /outside/repository/app-release windows-amd64 /outside/repository/app-candidate
```

Supported targets are `windows-amd64`, `linux-amd64`, `linux-arm64`, `darwin-arm64` and `darwin-amd64`.
Use the matching target name in the command above. Darwin assembly requires a
native macOS runner with its SDK and enables cgo; Windows and Linux assembly keep
cgo disabled.
The result is a ZIP bundle and SHA-256 file. Manual sidecar assembly,
explicit CI packaging, Release publication and updates are documented in
[deployment](../../docs/deployment.md); creating a candidate does not publish it.

The App runtime contains the following files. On macOS they live inside
`Silip App.app/Contents/MacOS`; move the whole `.app` when installing it.

```text
silip-app[.exe]
REVISION
LICENSE
THIRD-PARTY-NOTICES.txt
runtime/native/silip-capture[.exe] # supported native-media packages
runtime/tunnel/cloudflared[.exe] # packages that support --link
```

The executable embeds the Browser assets of the consumed application release and
carries that same full Git revision as the package `REVISION`. App/Site
interoperability follows the
[public compatibility contract](../../docs/standards/versioning.md#public-compatibility-promise).

For a native Host smoke run, launch the App and select a window in the Host
page, then open its invitation on another device. Choose the mode for that
network as described in the [App guide](./README.md#modes).

### Optional Gamepad Drivers

App packaging does not download or include optional input SDKs or drivers.
The Windows adapter calls an externally installed ViGEmBus through its public
bus interface; Linux uses system uinput and macOS uses native virtual HID APIs.
Driver availability and permission are checked by the platform adapter.
See the [gamepad setup guide](../../docs/guide/remote-control.md#gamepads)
for Host requirements and platform support.

### Desktop Icons

The Windows App embeds the shared Silip mark through the
`cmd/silip-app/silip_windows_amd64.syso` resource; the platform
suffix keeps that Windows resource out of Linux and macOS builds.
Linux packages include the standard `share/applications` desktop entry and
hicolor icon. macOS packages include `Silip App.app` with an ICNS resource,
the App executable and its helpers. For terminal use, the executable is
`"Silip App.app/Contents/MacOS/silip-app"`.

The editable badge is [public/favicon.svg](../../public/favicon.svg).
Export it at 16/24/32/48/64/128/256 px as PNG entries in `cmd/silip-app/silip.ico`;
the package builder derives Linux and macOS icons from those entries. Keep the
website exports in sync: `public/favicon.png` at 96 px, and `public/favicon.ico`
with 16/32/48 px entries. Check actual small sizes on light and dark backgrounds.
Render the SVG at each target size so its small-icon styling applies.
Then regenerate the Windows resource from the repository root:

```sh
go run github.com/akavel/rsrc@v0.10.2 -ico cmd/silip-app/silip.ico -arch amd64 -o cmd/silip-app/silip_windows_amd64.syso
```

## Gates

The Local gate starts the packaged process, loads a real built page in Chromium,
proves bootstrap access and LAN invitation construction, and verifies complete
process/profile cleanup. The loopback gate separately proves Site access with
and without Chromium Local Network Access permission. Environment syntax below
is POSIX; use equivalent variables on Windows. For the loopback gate, provide a
reachable Silip Site and run once without `SILIP_CLIENT_GATE_GRANT_LOOPBACK`, then
again with `SILIP_CLIENT_GATE_GRANT_LOOPBACK=true` to cover both permission states.

```sh
SILIP_CLIENT_LOCAL_GATE=true \
CHROME_PATH=/path/to/chrome \
SILIP_CLIENT_EXE=/path/to/silip-app \
SILIP_CLIENT_GATE_LAN_ADDRESS=192.168.1.10 \
npm run gate:app-local

SILIP_CLIENT_LOOPBACK_GATE=true \
CHROME_PATH=/path/to/chrome \
SILIP_CLIENT_EXE=/path/to/silip-app \
SILIP_CLIENT_GATE_SITE_URL=https://<test-site> \
npm run probe:app-loopback

SILIP_CLIENT_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
SILIP_CLIENT_GATE_STUN_URLS=stun:<stun-host>:3478 \
npm run gate:app-media

SILIP_CLIENT_NATIVE_HOST_GATE=true \
CHROME_PATH=/path/to/chrome \
SILIP_GO=/path/to/go \
npm run gate:app-native-host

SILIP_CLIENT_NATIVE_HOST_GATE=true \
SILIP_CLIENT_LINK_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
SILIP_GO=/path/to/go \
SILIP_CLOUDFLARED=/path/to/cloudflared \
SILIP_REMOTE_HOST=<public-test-host> \
SILIP_REMOTE_USER=<ssh-user> \
SILIP_REMOTE_SSH_KEY=/path/to/key \
npm run gate:app-native-host

SILIP_CLIENT_LINK_GATE=true \
SILIP_GO=/path/to/go \
SILIP_CLOUDFLARED=/path/to/cloudflared \
SILIP_REMOTE_HOST=<public-test-host> \
SILIP_REMOTE_USER=<ssh-user> \
SILIP_REMOTE_SSH_KEY=/path/to/key \
npm run gate:app-link
```

The Windows media gate proves one hardware-H.264
capture generation, shared Pion source, Browser decode, PLI recovery, and STUN
candidate gathering. The native Host gate proves room creation and native video
delivery through the current route; native audio is included when the capability
probe and target OS support it. The one-link media variant carries signaling
through the App's temporary public origin and requires direct video RTP delivery
to an independent Linux peer, with a selected `srflx` or `prflx` candidate.
SSH only runs the remote probe; media never travels through it. Without a remote
host, this variant checks decoded media in a local Browser through the public
invitation; that does not establish cross-network connectivity. Native P2P
quality evidence and embedded SFU delivery have explicit gates. macOS and Linux capture still
require physical desktop/media gates; CI compilation and package smoke do not
substitute for them.
