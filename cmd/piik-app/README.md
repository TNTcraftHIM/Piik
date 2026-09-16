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

Windows App and browser sharing are the primary tested paths. The macOS and
Linux apps have not yet been tested on physical devices; test results and
[feedback](https://github.com/TNTcraftHIM/Piik/issues) are welcome. macOS native
capture requires Apple silicon and macOS 13 or newer. Package construction and public Release
publication are separate steps in [deployment](../../docs/deployment.md).

## Modes

- With no mode argument, the App opens a small launcher in the system
  Browser. It selects Local, a temporary public HTTPS invitation, or a saved
  Site, then enters the normal Host page.
- The launcher remembers the last mode confirmed with **Open Piik** and the saved
  Site address. Without a saved mode, it selects Site when an address is saved,
  otherwise Public invite; it waits for confirmation before starting.
  The mode preference is stored beside the settings in `client.json.mode`;
  [App configuration](../../docs/standards/configuration.md#piik-app-configuration)
  covers saved preferences and custom paths.
- The `--site`, `--local`, and `--link` flags select a mode for CI and development.
- The default launcher checks official releases after it opens, using GitHub
  first and Gitee if GitHub is unavailable. It opens the matching platform ZIP
  when available, falling back to the release page. It does not install or replace the App.

Local rooms last for this App run and work on a reachable LAN. **Public invite**
uses the packaged Cloudflare Tunnel helper to expose that same room service at a
temporary HTTPS address. Picture and sound travel between participants (P2P),
outside the tunnel. Both modes need a usable UDP media path and provide no
media-server forwarding (SFU) or TURN relay fallback. The
[routing reference](../../docs/standards/routing-transport.md) explains connection setup.

For Local invitations, the App automatically selects a sole active address or
sole private IPv4. If several addresses remain possible, choose an interface
and IP in the launcher. Public invite and Site mode need no LAN selection.
When bypassing the launcher with `--local`, use `--lan-address <address>` to
resolve an ambiguous choice. The selected address is checked again at startup;
it affects Local invitation links, while ICE selects media paths independently.

Site mode uses the configured Site's rooms and any enabled SFU fallback.
An App-opened Site remembers native activation, so later pages there may reuse
the running App. Browser capture remains available without the App; see the
[entry workflow](../../docs/standards/presentation-lifecycle.md#product-surface).

The Host page offers Browser capture and available native windows or screens;
select the source explicitly. Windows native capture offers VP8/Auto/H264;
Auto chooses one codec for the share. macOS and Linux native capture require
hardware H264. Source and audio support vary by platform; their setup is covered
in the [Windows](../../native/capture/windows/README.md),
[macOS](../../native/capture/darwin/README.md) and
[Linux](../../native/capture/linux/README.md) capture guides.
Native capture uses the Host's current quality settings. The
[media-quality reference](../../docs/standards/media-quality.md) owns codec selection,
live changes and encoding reuse; [verification status](../../docs/verification-status.md)
keeps the measured limits.

The App configuration keeps an optional Local site passphrase. Leave it
blank for an open Local site, or enter a password in the launcher before
starting. Viewer invitations grant access to their room independently; see
[rooms and access](../../docs/standards/rooms-access.md).

The terminal shows the current mode, entry links and startup state; its language
follows the launcher and App-enabled pages.
Press `o` to reopen the Browser, or `q` / Ctrl+C to end Local
rooms and stop the local server and temporary public link. Plain-text output
uses Ctrl+C. The App keeps running after a Site tab closes.
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

**Why can screen capture succeed while the media connection fails?**

Chromium-based Browsers can restrict WebRTC UDP through Browser settings,
extensions or managed policies. Disabling non-proxied UDP can prevent even the
local Browser-to-App media connection; successful capture or page loading
does not prove that this separate connection is available.

Check the Browser's WebRTC/IP-handling policy and any extension's WebRTC or
IP-leak protection setting. Restore a policy that permits WebRTC UDP, reload
Piik, and verify that another extension or managed policy has not overridden
the choice. Setting names and availability differ between Browsers. For example,
Vivaldi exposes **Settings > Privacy and Security > WebRTC IP Handling >
Broadcast IP for Best WebRTC Performance**. Changing this policy can expose
network addresses to WebRTC peers; do not disable unrelated protections.

See [Chromium's extension policy API](https://developer.chrome.com/docs/extensions/reference/api/privacy#property-network),
[Vivaldi's setting example](https://help.vivaldi.com/desktop/privacy/privacy-settings/),
and the [verified policy mechanism and field case](../../docs/research/native-client-lifecycle.md).

### Diagnostics

Enable **Debug launch** in the mode selector before opening Piik, reproduce the
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

These commands build the App only. Choose **Local room** or a configured Site
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

Supported targets are `windows-amd64`, `linux-amd64`, and `darwin-arm64`.
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

The Windows App embeds the shared Piik mark through the
`cmd/piik-app/piik_windows_amd64.syso` resource; the platform
suffix keeps that Windows resource out of Linux and macOS builds.
Linux packages include the standard `share/applications` desktop entry and
hicolor icon. macOS packages include a thin `Piik App.app` launcher
with an ICNS resource; the raw Go executable remains available beside it.

For a native Host smoke run, launch the App and select a window in the Host
page, then open its invitation on another device. Choose the mode for that
network as described [above](#modes).

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
PIIK_CLIENT_CROSS_NAT_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_GO=/path/to/go \
PIIK_REMOTE_HOST=<public-test-host> \
PIIK_REMOTE_USER=<ssh-user> \
PIIK_REMOTE_SSH_KEY=/path/to/key \
PIIK_CLIENT_GATE_STUN_URLS=stun:<stun-host>:3478 \
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
probe and target OS support it. The cross-NAT variant uses a temporary reverse
SSH path for signaling only and requires a selected `srflx` or `prflx` media pair;
media never travels through SSH. The one-link media variant instead carries the
same signaling through the App's temporary public origin and requires direct
media delivery to an independent Linux peer. Native P2P quality evidence and
embedded SFU delivery have explicit gates. macOS and Linux capture still
require physical desktop/media gates; CI compilation and package smoke do not
substitute for them.
