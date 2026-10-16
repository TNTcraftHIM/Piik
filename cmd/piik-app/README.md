# Piik App

English · [简体中文](./README.zh-CN.md) · [Getting started](../../docs/guide/getting-started.md)

Piik App provides local rooms and native screen capture through the Piik web
interface in your system Browser.

## Run A Package

Extract the matching platform bundle in full and keep `runtime` beside the
App executable. Run `piik-app.exe` on Windows, `./piik-app` on
Linux, or `Piik App.app` on macOS. The launcher opens in the system Browser.
Linux native capture uses the system dependencies described
in the [Linux capture guide](../../native/capture/linux/README.md).

If the page does not open automatically, open the address shown in the terminal
or press **O** there to retry. Keep the App running while using that page.

Windows App and browser sharing are the primary tested paths. Physical-device
coverage for the macOS and Linux apps is still limited; test results and
[feedback](https://github.com/TNTcraftHIM/Piik/issues) are welcome. macOS native
capture requires macOS 13 or newer on Apple silicon or Intel. Package construction and public Release
publication are separate steps in [deployment](../../docs/deployment.md).

## Modes

- With no mode argument, the App opens its launcher and waits for use by an
  approved Site. Choose **Local room** or **Public invite** to start a room
  service on this device and enter the normal Host page.
  Star an approved Site in the launcher to open it on startup instead;
  turn the star off to restore the launcher. Replacing or revoking the Site clears this choice.
- The launcher remembers the last mode confirmed with **Open Piik**. Without a
  saved Local/Public choice, it selects Public invite and waits for confirmation.
  The mode preference is stored beside the settings in `client.json.mode`;
  [App configuration](../../docs/standards/configuration.md#piik-app-configuration)
  covers saved preferences and custom paths.
- The `--site`, `--local`, and `--link` flags select a mode for CI and development.
- The default launcher checks official releases after it opens, using GitHub
  first and Gitee if GitHub is unavailable. Click the update button to download
  the matching platform ZIP, or open the release page when no package matches.
  **Release notes** opens separately; a new major version includes an upgrade
  warning. The App does not install or replace itself.

Local rooms last for this App run and work on a reachable LAN. **Public invite**
uses the packaged Cloudflare Tunnel helper to expose that same room service at a
temporary HTTPS address. Picture and sound travel between participants (P2P),
outside the tunnel. Both modes need a usable UDP media path and provide no
media-server forwarding (SFU) or TURN relay fallback. The
[routing reference](../../docs/standards/routing-transport.md) explains connection setup.

Public invite uses Cloudflare, MiWiFi (Xiaomi) and Bilibili STUN services to
discover reachable addresses. Each contacted operator can see your public IP,
port and request timing; these requests contain no shared media, chat or room
password. NAT enhancement uses the same destinations automatically.
To choose your own STUN services for public invitations, set `PIIK_STUN_URLS`
before starting App; see [App configuration](../../docs/standards/configuration.md#piik-app-configuration).
An approved Site supplies its own `STUN_URLS`; App Local rooms configure no public STUN.

For Local invitations, the App automatically selects a sole active address or
sole private IPv4. If several addresses remain possible, choose an interface
and IP in the launcher. Public invite and use through a Site need no LAN selection.
When bypassing the launcher with `--local`, use `--lan-address <address>` to
resolve an ambiguous choice. The selected address is checked again at startup;
it affects Local invitation links, while ICE selects media paths independently.

To use a Piik Site, keep the App running and click **App** at the top of the Site.
Confirm its address on the local approval page. The App remembers one approved
Site, which the launcher can open or revoke. Approving another replaces it and
ends the previous Site's App connections; Local rooms remain independent.
The browser remembers activation, so later visits reuse the running App with
that Site's rooms and any enabled SFU fallback. Browser capture remains available
without the App; see the
[entry workflow](../../docs/standards/presentation-lifecycle.md#product-surface).

The Host page offers Browser and Camera capture alongside available native
windows or screens; select the source explicitly. Windows native capture offers VP8/Auto/H264;
Auto chooses one codec for the share. macOS and Linux native capture require
hardware H264. Source and audio support vary by platform; their setup is covered
in the [Windows](../../native/capture/windows/README.md),
[macOS](../../native/capture/darwin/README.md) and
[Linux](../../native/capture/linux/README.md) capture guides.
Native capture uses the Host's current quality settings. The
[media-quality reference](../../docs/standards/media-quality.md) owns codec selection,
live changes and encoding reuse; [verification status](../../docs/verification-status.md)
keeps the measured limits.

On supported Windows versions, the **Apps / Windows** and **Screens** tabs offer
**Show capture border**, off by default. Change it when selecting or switching a
source; the Host page remembers your choice. Windows 10, system policy or another
active capture can keep the yellow border visible; sharing remains available.
See [capture-border troubleshooting](../../docs/guide/troubleshooting.md#yellow-capture-border-on-windows)
for an optional Windows 10 workaround.

The App configuration keeps an optional Local site passphrase. Leave it
blank for an open Local site, or enter a password in the launcher before
starting. Viewer invitations grant access to their room independently; see
[rooms and access](../../docs/standards/rooms-access.md).

The terminal shows the current mode, entry links and startup state; its language
follows the launcher and App-enabled pages.
Press `o` to reopen the Browser, or `q` / Ctrl+C to end Local
rooms and stop the local server and temporary public link. Plain-text output
uses Ctrl+C. The Linux desktop entry also opens this terminal. The App keeps
running after a Site tab closes.
When launched in its own Windows console, a startup or runtime error leaves the
error visible until Enter is pressed. Normal shutdown, existing terminals and
redirected or automated runs exit directly.

For one-link Internet sharing, open the App launcher, choose **Public invite**,
create a room in the opened Browser, and send its normal invitation link. The
random `trycloudflare.com` origin lasts only for that App run; a later launch
creates a new temporary link. Cloudflare Quick Tunnels provide no uptime guarantee;
use a configured Site when persistent control availability or SFU fallback matters.

## Troubleshooting

### Chromium WebRTC Connections

**Why can the page open, or screen capture succeed, while sharing or viewing fails?**

Browser settings, extensions or managed policies can block WebRTC UDP, including
the local Browser-to-App media connection. Follow the documentation center's
[browser WebRTC checks](../../docs/guide/troubleshooting.md#browser-webrtc-restrictions).
For codec-specific failures, see [Windows H264 troubleshooting](../../docs/guide/troubleshooting.md#h264-sharing-fails-on-windows).

### Diagnostics

Enable **Debug launch** in the launcher before starting a room or connecting a Site, reproduce the
problem, then press `D` in the interactive terminal to export a local ZIP.
Use `--debug` for failures before the selector opens. Exporting does not stop
the share or upload the archive. For Browser diagnostics, click the **Debug**
chip icon after the theme control, confirm the reload, then use **Web report** to download.
For cooperation failures, include both reports from the same reproduction. The
[diagnostic reference](../../docs/standards/configuration.md#diagnostics) owns
log locations, export commands, retention and privacy boundaries.

## Development

Use the Node/npm/Go versions in [Run from source](../../docs/README.md#run-from-source).
The binary embeds the Browser assets, so build them from the repository root first:

```sh
npm ci
npm run build:web
```

On Linux or macOS:

```sh
go run ./cmd/piik-app
```

On Windows, build and run from a stable executable path for the system firewall:

```powershell
go build -o build/dev/piik-app.exe ./cmd/piik-app
./build/dev/piik-app.exe
```

These commands build the App only. Choose **Local room** or open a Piik Site
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

The extracted bundle contains:

```text
piik-app[.exe]
REVISION
LICENSE
THIRD-PARTY-NOTICES.txt
runtime/native/piik-capture[.exe] # supported native-media packages
runtime/tunnel/cloudflared[.exe] # packages that support --link
```

The executable embeds the Browser assets of the consumed application release and
carries that same full Git revision as the package `REVISION`. App/Site
interoperability follows the
[public compatibility contract](../../docs/standards/versioning.md#public-compatibility-promise).

For a native Host smoke run, launch the App and select a window in the Host
page, then open its invitation on another device. Choose the mode for that
network as described [above](#modes).

### Desktop Icons

The Windows App embeds the shared Piik mark through the
`cmd/piik-app/piik_windows_amd64.syso` resource; the platform
suffix keeps that Windows resource out of Linux and macOS builds.
Linux packages include the standard `share/applications` desktop entry and
hicolor icon. macOS packages include a thin `Piik App.app` launcher
with an ICNS resource; the raw Go executable remains available beside it.

The editable badge is [public/favicon.svg](../../public/favicon.svg).
Export it at 16/24/32/48/64/128/256 px as PNG entries in `cmd/piik-app/piik.ico`;
the package builder derives Linux and macOS icons from those entries. Keep the
website exports in sync: `public/favicon.png` at 96 px, and `public/favicon.ico`
with 16/32/48 px entries. Check actual small sizes on light and dark backgrounds.
Then regenerate the Windows resource from the repository root:

```sh
go run github.com/akavel/rsrc@v0.10.2 -ico cmd/piik-app/piik.ico -arch amd64 -o cmd/piik-app/piik_windows_amd64.syso
```

## Gates

The Local gate starts the packaged process, loads a real built page in Chromium,
proves bootstrap access and LAN invitation construction, and verifies complete
process/profile cleanup. The loopback gate separately proves Site access with
and without Chromium Local Network Access permission. Environment syntax below
is POSIX; use equivalent variables on Windows.

```sh
PIIK_CLIENT_LOCAL_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_CLIENT_EXE=/path/to/piik-app \
PIIK_CLIENT_GATE_LAN_ADDRESS=192.168.1.10 \
npm run gate:app-local

PIIK_CLIENT_LOOPBACK_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_CLIENT_EXE=/path/to/piik-app \
npm run probe:app-loopback

PIIK_CLIENT_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_CLIENT_GATE_STUN_URLS=stun:<stun-host>:3478 \
npm run gate:app-media

PIIK_CLIENT_NATIVE_HOST_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_GO=/path/to/go \
npm run gate:app-native-host

PIIK_CLIENT_NATIVE_HOST_GATE=true \
PIIK_CLIENT_LINK_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_GO=/path/to/go \
PIIK_CLOUDFLARED=/path/to/cloudflared \
PIIK_REMOTE_HOST=<public-test-host> \
PIIK_REMOTE_USER=<ssh-user> \
PIIK_REMOTE_SSH_KEY=/path/to/key \
npm run gate:app-native-host

PIIK_CLIENT_LINK_GATE=true \
PIIK_GO=/path/to/go \
PIIK_CLOUDFLARED=/path/to/cloudflared \
PIIK_REMOTE_HOST=<public-test-host> \
PIIK_REMOTE_USER=<ssh-user> \
PIIK_REMOTE_SSH_KEY=/path/to/key \
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
