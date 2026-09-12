# Piik App

Piik App provides local rooms and native screen capture through the Piik web
interface in your system Browser.

## Run A Package

Extract the matching platform bundle in full and keep `runtime` beside the
App executable. Run `piik-app.exe` on Windows, `./piik-app` on
Linux, or `Piik App.app` on macOS. The launcher opens in the system Browser.
Linux native capture uses the system dependencies described
in the [Linux capture guide](../../native/capture/linux/README.md).

Windows App and browser sharing are the primary tested paths. The macOS and
Linux apps have not yet been tested on physical devices; test results and
[feedback](https://github.com/TNTcraftHIM/Piik/issues) are welcome. macOS native
capture requires Apple silicon and macOS 13 or newer. Package construction and public Release
publication are separate steps in [deployment](../../docs/deployment.md).

## Modes

- With no mode argument, the App opens a small launcher in the system
  Browser. It selects Local, a temporary public HTTPS invitation, or a saved
  Site, then enters the normal Host page.
- The launcher remembers the Site address but keeps the per-run room source
  separate. The App RPC starts before this choice and accepts the saved Site
  alongside the Local Host origin. An App-opened Site remembers the opt-in in that Browser
  origin; later manually opened Host pages may reuse the running App.
- The `--site`, `--local`, and `--link` flags select a mode for CI and development.
- The default launcher checks official releases after it opens, using GitHub
  first and Gitee if GitHub is unavailable. It links to an available release
  without installing or replacing the App.

Local mode uses memory-only rooms, P2P relay, no SFU listener, and no public
discovery. Ordinary Local works on a reachable LAN. The **Public invite** mode
runs the packaged Cloudflare Tunnel sidecar for the existing HTTP/WebSocket
control surface and
uses one ordinary public STUN destination plus two bounded public survey
destinations. Browser and Native edges share the same prediction rule; Native
STUN, ICE checks, and media use one Pion UDP mux. Media does not
travel through the HTTP tunnel, and a difficult media path still has no SFU or
TURN fallback. The App chooses a sole private LAN IPv4 automatically. Use
`--lan-address <address>` only when multiple real LAN interfaces are active.

The system Browser remains the Host UI. An App-launched Host offers the
Browser's standard capture picker and a list of exact platform capture targets;
the user selects one explicitly. Windows offers the same VP8/Auto/H264 selector:
VP8 uses the pinned WebRTC/libvpx encoder and H264 uses hardware Media Foundation
inside WebRTC's output pipeline. Auto measures target-profile encoding work
before choosing one codec for the share. Windows uses
Graphics Capture and WASAPI; macOS
uses ScreenCaptureKit, VideoToolbox, and AudioToolbox; Linux delegates selection
to the ScreenCast Portal and uses the system PipeWire/GStreamer hardware path.
Video and audio share the same room route and PeerConnection. Native capture
starts with the Host's
current resolution, frame-rate, video/audio bitrate, and quality preference;
live changes replace only the capture/encoder generation behind those stable
connections. A Native edge with public STUN also attempts one bounded PCP,
UPnP, or NAT-PMP mapping for its Pion UDP socket; pure LAN does not. Routers
without a mapping service continue with ordinary ICE/STUN. The mapping does not
create a relay or carry media through the App control link. A configured Site
may receive a direct Native publication from the shared encoded source;
Local and one-link modes remain P2P-only. An ordinary Web Host keeps the
Browser capture path without probing the App.

Native P2P edges and embedded SFU use one shared Pion/LiveKit media adapter for
feedback, forwarding allocation, bounded pacing and recovery. Native parents
reuse suitable H.264/VP8 outputs and derive a missing lower output only for
direct-child demand. Compatible children share that output; each edge receives
only its selected representation. SFU publication combines its requested output
prefix with one aggregate upstream budget. A lower-output constraint does not
replace the original input or higher sibling outputs. The route controller owns
persistent quality evidence and route replacement. See
[media quality](../../docs/product/media-quality.md) for the implemented behavior
and [status](../../docs/status.md) for its acceptance limits.

The App configuration keeps an optional Local site-access password. Leave it
blank for an open Local site, or set a visible-ASCII password (8 to 128 bytes)
in the launcher before starting. When present, the App passes it to its own
Host page in a URL fragment; the page uses the existing SiteAccess endpoint and
removes the fragment before continuing. Viewer invitations keep using the
existing room-scoped grant.

The terminal shows the current mode, entry links and startup state; its language
follows the launcher and App-enabled pages.
Press `o` to reopen the Browser, or `q` / Ctrl+C to end Local
rooms and stop the local server and temporary public link. Plain-text output
uses Ctrl+C. The App keeps running after a Site tab closes.

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

Start the packaged executable with `--debug`, reproduce the problem, then press
`D` in the interactive terminal to export a local ZIP. This does not stop the
share or upload the archive. Browser diagnostics are separate: open the page with
`?debug=1` and use its header download button. For cooperation failures, include
both reports from the same reproduction. The
[diagnostic reference](../../docs/reference/configuration.md#diagnostics) owns
log locations, export commands, retention and privacy boundaries.

## Development

The binary embeds the Browser assets, so build them before running it:

```sh
npm run build:client
go test ./...
go vet ./...
go run ./cmd/piik-app
```

The repository-level entry used locally and by CI is:

```sh
npm run check:client
```

On Windows, its generated App, capture, and media-test executables are
written to the ignored repository `build/client-check` directory and reused on
the next run. This keeps the executable identity stable for the system firewall;
the files are local build output and are never packaged or committed.

It runs Go formatting, unit tests, vet, and Windows/Linux cgo-free cross-builds.
The Darwin App and peer gate build only on macOS with cgo enabled and an
installed SDK; other hosts report that skipped platform explicitly. The pinned
media dependency's Darwin CPU statistics use Mach APIs through cgo, so a Windows
or Linux core check does not establish Darwin build acceptance.
Each target compiles its isolated capture process and validates its bounded
capability response. macOS additionally encodes one in-memory hardware H.264
IDR; Linux probes the Portal/PipeWire/GStreamer adapter. Real capture, GPU
attribution, Browser decode, and public-network paths remain explicit physical
gates rather than environment-dependent unit tests.

The loopback service binds IPv4 loopback on the first available port from
`39721` through `39730`. `/health` discovers the current process; `/control`
admits at most two independent strict v9 control sessions. After `hello`, each
session may list local capture choices, own one generation-fenced Host share,
or receive one native Viewer source and its bounded encoded child edges. Closing
one session retires only its resources. Its public `instanceToken`
distinguishes the discovered process but is not authentication. The shared Go
service owns room authority; the Browser owns the room protocol client and
orchestrates native media through this control session. Viewer receive/relay remains
available even when this machine has no accepted native capture encoder.
Capture sidecars must match the App's current probe/encoded-output contract;
the package-candidate wrapper validates that version before accepting its artifact.

Packaged builds report the product version and source SHA in the terminal and
diagnostic context. The launcher uses that identity to distinguish a newer
version, a different build of the same version, and an official release offered
to a development build; the link never installs or interrupts a share.
[Versioning](../../docs/reference/versioning.md)
owns these meanings and [GitHub operations](../../docs/operations/github.md)
owns automatic publication.

## Packaging

From a clean revision, build the application release and run the platform's
candidate wrapper on its native operating system. The wrapper builds capture,
verifies the pinned public-link helper, and assembles and checks the App:

```sh
node scripts/package-app-release.mjs /outside/repository/app-release
node scripts/package-client-candidate.mjs \
  /outside/repository/app-release windows-amd64 \
  /outside/repository/client-candidate
```

Supported targets are `windows-amd64`, `linux-amd64`, and `darwin-arm64`.
Use the matching target name in the command above. Darwin assembly requires a
native macOS runner with its SDK and enables cgo; Windows and Linux assembly keep
cgo disabled.
The result is a `tar.gz` bundle and SHA-256 file. Manual sidecar assembly,
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
carries that same full Git revision as the package `REVISION`. No compatibility
reader accepts a mismatched private build.

The Windows App embeds the shared Piik mark through the
`cmd/piik-app/piik_windows_amd64.syso` resource; the platform
suffix keeps that Windows resource out of Linux and macOS builds.
Linux packages include the standard `share/applications` desktop entry and
hicolor icon. macOS packages include a thin `Piik App.app` launcher
with an ICNS resource; the raw Go executable remains available beside it.

For a native Host smoke run, launch the App and select a window in the Host
page. The App never guesses among multiple targets. The page still creates
the room and sends the current SDP/ICE through the selected authority. A
configured Site supplies its normal Internet routing and SFU fallback. Without
a Site, the **Public invite** choice exposes the Local control surface while
media remains P2P-only.

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
npm run gate:client-local

PIIK_CLIENT_LOOPBACK_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_CLIENT_EXE=/path/to/piik-app \
npm run probe:client-loopback

PIIK_CLIENT_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_CLIENT_GATE_STUN_URLS=stun:<stun-host>:3478 \
npm run gate:client-media

PIIK_CLIENT_NATIVE_HOST_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_GO=/path/to/go \
npm run gate:client-native-host

PIIK_CLIENT_NATIVE_HOST_GATE=true \
PIIK_CLIENT_CROSS_NAT_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_GO=/path/to/go \
PIIK_REMOTE_HOST=<public-test-host> \
PIIK_REMOTE_USER=<ssh-user> \
PIIK_REMOTE_SSH_KEY=/path/to/key \
PIIK_CLIENT_GATE_STUN_URLS=stun:<stun-host>:3478 \
npm run gate:client-native-host

PIIK_CLIENT_NATIVE_HOST_GATE=true \
PIIK_CLIENT_LINK_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_GO=/path/to/go \
PIIK_CLOUDFLARED=/path/to/cloudflared \
PIIK_REMOTE_HOST=<public-test-host> \
PIIK_REMOTE_USER=<ssh-user> \
PIIK_REMOTE_SSH_KEY=/path/to/key \
npm run gate:client-native-host

PIIK_CLIENT_LINK_GATE=true \
PIIK_GO=/path/to/go \
PIIK_CLOUDFLARED=/path/to/cloudflared \
PIIK_REMOTE_HOST=<public-test-host> \
PIIK_REMOTE_USER=<ssh-user> \
PIIK_REMOTE_SSH_KEY=/path/to/key \
npm run gate:client-link
```

The loopback health response reports video, process-audio, system-audio, and
hardware H.264 availability separately. The Windows media gate proves one hardware-H.264
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
